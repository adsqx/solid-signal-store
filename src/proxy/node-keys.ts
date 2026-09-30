// What a proxy node answers for its non-data keys, as null-prototype tables consulted only after a
// child-cache miss: value accessors, `$subscribe`, store dispatch (mutate/pipe/select/...), array
// methods and, on the root, the store-level operations.

import { ARRAY_METHODS } from '../array/array-ops';
import { createProjectionObservable, subscription, type ProjectionObservableOptions } from '../core/rx-interop';
import type { NodeMethod, ProxyContext } from './types';

/** The slice of a node handler the key tables read. */
export interface ProxyNode {
  readonly ctx: ProxyContext;
  readonly path: string;
  /** The node's signal accessor. */
  readonly read: () => unknown;
  /** Path handed to the store on dispatch: the normalized node path, or '' for the root and for invalid paths. */
  readonly dispatchPath: string;
  /** Per-node method cache: builds `key`'s method once, so `store.a.push === store.a.push`. */
  method(key: string, build: MethodBuilder): NodeMethod;
}

type MethodBuilder = (node: ProxyNode, key: string) => NodeMethod;
export type KeyResolver = (node: ProxyNode, key: string) => unknown;
export type KeyTable = Record<string, KeyResolver | undefined>;

const table = (...sources: KeyTable[]): KeyTable => Object.assign(Object.create(null), ...sources);
const cached = (build: MethodBuilder): KeyResolver => (node, key) => node.method(key, build);
const names = (list: Iterable<string>, resolve: KeyResolver): KeyTable =>
  Object.fromEntries(Array.from(list, (name) => [name, resolve]));

// `store.a.mutate(...)` calls `store.mutate('a', ...)`. The `$`-prefixed aliases keep a data key
// literally named `mutate`/`query`/... from shadowing the operations. The exact name wins when the
// store defines it ($query/$liveQuery/... are dedicated methods); otherwise the bare name is used.
const DISPATCH_ALIAS: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(
  ['mutate', 'pipe', 'array', 'select', 'query', 'computedOf',
    '$mutate', '$pipe', '$array', '$select', '$computedOf', '$query', '$queryOne', '$liveQuery', '$liveQueryOne']
    .map((name) => [name, name.startsWith('$') ? name.slice(1) : name])));

const buildDispatch: MethodBuilder = (node, method) => {
  const { mutator, surface } = node.ctx;
  const alias = DISPATCH_ALIAS[method]!;
  const path = node.dispatchPath;
  return (...args) => {
    const own = surface[method];
    mutator.emitDevAction({ type: 'PROXY_DISPATCH', payload: { path, method } });
    const target = typeof own === 'function' ? own : surface[alias];
    return typeof target === 'function' ? target.call(mutator, path, ...args) : undefined;
  };
};

/** Root-only store operations (setValue, readStore, ...): dispatched without a path. */
const buildRootDispatch: MethodBuilder = (node, method) => {
  const { mutator, surface } = node.ctx;
  return (...args) => {
    mutator.emitDevAction({ type: 'PROXY_DISPATCH', payload: { path: '', method } });
    const target = surface[method];
    return typeof target === 'function' ? target.call(mutator, ...args) : undefined;
  };
};

const buildArrayMethod: MethodBuilder = (node, method) => {
  const { path, read } = node;
  const { mutator, surface } = node.ctx;
  return (...args) => {
    mutator.emitDevAction({ type: 'ARRAY_DISPATCH', payload: { path, method, args } });
    return surface.arrayOp?.call(mutator, path, method, args, read());
  };
};

// Value subscription for a path (backs $subscribe): registers branch interest so a subscription on an
// object/array also fires on descendant mutations, and releases it on close.
const buildSubscribe: MethodBuilder = ({ ctx: { engine }, path, read }) =>
  (...args) => {
    const [cb, options] = args as [(value: unknown) => void, ProjectionObservableOptions<unknown> | undefined];
    engine.addBranchSub(path);
    return subscription(createProjectionObservable(read, options).subscribe(cb), () => engine.removeBranchSub(path));
  };

const accessor: KeyResolver = (node) => node.read;

// Built in precedence order: array methods first so the value accessors below win on 'length'.
export const NODE_KEYS = table(
  names(ARRAY_METHODS, cached(buildArrayMethod)),
  names(Object.keys(DISPATCH_ALIAS), cached(buildDispatch)),
  {
    $subscribe: cached(buildSubscribe),
    $val: (node) => node.read(),
    $signal: accessor,
    valueOf: accessor,
    toJSON: accessor,
    toString: (node: ProxyNode) => () => String(node.read()),
    length: (node) => {
      const value = node.read();
      return Array.isArray(value) ? value.length : undefined;
    },
  },
);

export const ROOT_KEYS = table(
  NODE_KEYS,
  names(['setValue', 'readStore', 'deleteValue', 'wakeUp', 'batch'], cached(buildRootDispatch)),
);
