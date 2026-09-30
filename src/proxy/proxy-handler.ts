// The Proxy traps of one node. Reads try the child cache first, then the key tables, then build the
// child proxy; writes and deletes go through the store mutator and wake the touched signals.

import { getParentPath, isValidPath } from '../internal/path';
import { isBranch } from '../internal/util';
import type { NodeMethod, ProxyContext } from './proxy-context';
import { NODE_KEYS, ROOT_KEYS, type KeyTable, type ProxyNode } from './node-keys';

const MAX_CHILD_CACHE_SIZE = 256;

const childPath = (parent: string, key: string): string => (parent ? `${parent}.${key}` : key);

function symbolProperty(k: symbol, read: () => unknown): unknown {
  if (k === Symbol.toPrimitive) {
    return (hint: string) => {
      const v = read();
      return typeof v === 'object' ? (hint === 'number' ? NaN : JSON.stringify(v)) : v;
    };
  }
  if (k === Symbol.toStringTag) {
    return () => {
      const v = read();
      try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { return String(v); }
    };
  }
  return undefined;
}

export class NodeHandler implements ProxyHandler<object>, ProxyNode {
  private readonly keys: KeyTable;
  // Child proxy identity is stable for the store lifetime; this per-node cache avoids rebuilding the
  // child path and consulting the global registry on every read. Special keys are never cached.
  private children: Record<string, object> | null = null;
  private childCount = 0;
  private methods: Record<string, NodeMethod> | null = null;
  private target: string | undefined;

  constructor(readonly ctx: ProxyContext, readonly path: string, readonly read: () => unknown) {
    this.keys = path === '' ? ROOT_KEYS : NODE_KEYS;
  }

  get dispatchPath(): string {
    // Dispatch is keyed off the parent of `<path>.mutate`: null (root or invalid path) means the root.
    return (this.target ??= getParentPath(childPath(this.path, 'mutate')) ?? '');
  }

  method(key: string, build: (node: ProxyNode, key: string) => NodeMethod): NodeMethod {
    const methods = (this.methods ??= Object.create(null) as Record<string, NodeMethod>);
    return (methods[key] ??= build(this, key));
  }

  get(_: object, k: string | symbol): unknown {
    if (typeof k === 'symbol') return symbolProperty(k, this.read);
    const hit = this.children?.[k];
    if (hit) return hit;
    const resolve = this.keys[k];
    return resolve ? resolve(this, k) : this.child(k);
  }

  private child(key: string): object {
    const child = this.ctx.factory(childPath(this.path, key));
    if (this.children === null || this.childCount >= MAX_CHILD_CACHE_SIZE) {
      this.children = Object.create(null) as Record<string, object>;
      this.childCount = 0;
    }
    this.children[key] = child;
    this.childCount++;
    return child;
  }

  set(_: object, k: string | symbol, v: unknown): boolean {
    if (typeof k === 'symbol') return false;
    const { mutator, engine, opts } = this.ctx;
    const tp = childPath(this.path, k);
    if (v === undefined && opts.strictDeleteUndefined) throw new Error(`strict: set undefined ${tp}`);
    if (opts.strictInvalidPath && !isValidPath(tp)) throw new Error(`strict: invalid path ${tp}`);

    if (v === undefined) mutator.batch(() => engine.wakeMutation(mutator.delete(tp)));
    // A lone primitive leaf dirties a single signal, so it needs no batch.
    else if (!isBranch(v) && !mutator._wakeParentsOnChange) engine.wakeMutation(mutator.write(tp, v));
    else mutator.batch(() => engine.wakeMutation(mutator.write(tp, v)));

    mutator.emitDevAction({ type: 'SET_VALUE', payload: { path: tp, value: v } });
    return true;
  }

  deleteProperty(_: object, k: string | symbol): boolean {
    if (typeof k === 'symbol') return false;
    const { mutator, engine, opts } = this.ctx;
    const tp = childPath(this.path, k);
    if (opts.strictDeleteUndefined) throw new Error(`strict: delete ${tp}`);
    if (opts.strictInvalidPath && !isValidPath(tp)) throw new Error(`strict: invalid path ${tp}`);

    mutator.batch(() => engine.wakeMutation(mutator.delete(tp)));
    mutator.emitDevAction({ type: 'DELETE', payload: { path: tp } });
    return true;
  }
}
