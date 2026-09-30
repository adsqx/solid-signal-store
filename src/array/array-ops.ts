// array-ops.ts — shared array method classification + the pure mutation dispatch table.
// Single source for SolidStore.arrayOp, the proxy's array-method routing and the fluent chain.
import { isBranch } from '../internal/util';
import type { SolidStoreReactivity } from '../core/proxy-types';

export const ARRAY_QUERY_METHODS = new Set([
  'filter', 'map', 'find', 'findIndex', 'some', 'every', 'includes', 'indexOf', 'length'
]);
export const ARRAY_MUTATION_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse'
]);
export const ARRAY_METHODS = new Set([
  ...ARRAY_QUERY_METHODS,
  ...ARRAY_MUTATION_METHODS,
]);

type MutationHandler = (arr: unknown[], args: readonly unknown[]) => unknown;

// Each entry is a tiny named handler; the caller owns copy-on-write, batching and commit.
const ARRAY_MUTATION_HANDLERS: Record<string, MutationHandler> = {
  push:    (a, args) => args.length === 1 ? a.push(args[0]) : a.push(...args),
  pop:     (a) => a.pop(),
  shift:   (a) => a.shift(),
  unshift: (a, args) => args.length === 1 ? a.unshift(args[0]) : a.unshift(...args),
  splice:  (a, args) => {
    const start = Number(args[0] ?? 0);
    if (args.length === 1) return a.splice(start);
    return a.splice(start, Number(args[1] ?? 0), ...args.slice(2));
  },
  sort:    (a, args) => a.sort(args[0] as ((x: unknown, y: unknown) => number) | undefined),
  reverse: (a) => a.reverse(),
};

/** Applies `method` to `arr` in place with native return semantics (push→length, pop→removed, splice→removed[] ...). */
export function applyArrayMutation(arr: unknown[], method: string, args: readonly unknown[] = []): unknown {
  const handler = ARRAY_MUTATION_HANDLERS[method];
  if (handler) return handler(arr, args);
  const fn = (arr as unknown as Record<string, unknown>)[method];
  return typeof fn === 'function' ? fn.apply(arr, args) : undefined;
}

// --- Store-level array dispatch (SolidStore.arrayOp / SolidStore.query) ---

/** What the array dispatch needs from the store that owns it (`commit` + `batch` also feed the fluent chain). */
export interface ArrayOpHost {
  read(path: string): unknown;
  /** Writes the array (data + wake); a no-op for the root path. */
  commit(path: string, value: unknown): void;
  batch<T>(fn: () => T): T;
  /** Data-only write, no wake. */
  setValueOnly(path: string, value: unknown): void;
  readonly reactivity: Pick<SolidStoreReactivity, 'wakeArrayTail' | 'wakeArraySplice'> | undefined;
  /** `preciseMutationWake` option: splice wakes only indices >= start. */
  readonly preciseSplice: boolean;
  /** Container mode currently on (wakes ancestors too, so splice keeps the full-branch path). */
  readonly wakeParents: boolean;
}

/** Runs a query method against an array with native semantics (`length` is a property, not a call). */
export function runArrayQuery(arr: readonly unknown[], method: string, args: readonly unknown[]): unknown {
  if (method === 'length') return arr.length;
  return (arr as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[method]?.(...args);
}

const NOT_HANDLED: unique symbol = Symbol('array-op-not-handled');

// Precise tail-only mutations: push/pop never reindex existing elements, so only the array signal
// and the inserted/removed tail index wake — not every observed element (which the conservative
// branch-replace path would). The proxy already emitted ARRAY_DISPATCH; nothing is emitted here.
type FastOp = (host: ArrayOpHost, path: string, cur: unknown[], args: readonly unknown[]) => unknown;

const FAST_OPS = new Map<string, FastOp>([
  ['push', (host, path, cur, args) => {
    // Native push() with no args returns length and changes nothing.
    if (args.length === 0) return cur.length;
    const start = cur.length;
    const nextLength = args.length === 1 ? cur.push(args[0]) : cur.push(...args);
    host.batch(() => {
      for (let i = 0; i < args.length; i++) host.reactivity?.wakeArrayTail(path, start + i, isBranch(args[i]));
    });
    return nextLength;
  }],
  ['pop', (host, path, cur) => {
    if (cur.length === 0) return undefined;
    const last = cur.length - 1;
    const popped = cur.pop();
    host.batch(() => host.reactivity?.wakeArrayTail(path, last, isBranch(popped)));
    return popped;
  }],
  // Precise splice (opt-in): copy-on-write data write, then wake only signals at index >= start.
  // shift/unshift/reverse/sort touch index 0 (no prefix to skip) and keep the proven branch path.
  ['splice', (host, path, cur, args) => {
    if (!host.preciseSplice || host.wakeParents) return NOT_HANDLED;
    const rawStart = Number(args[0] ?? 0);
    const start = rawStart < 0 ? Math.max(cur.length + rawStart, 0) : Math.min(rawStart, cur.length);
    if (start <= 0) return NOT_HANDLED; // no untouched prefix to skip
    const next = [...cur];
    const removed = applyArrayMutation(next, 'splice', args);
    host.setValueOnly(path, next);
    host.batch(() => host.reactivity?.wakeArraySplice(path, start));
    return removed;
  }],
]);

/** store.<path>.<method>(...args): queries run on the snapshot, mutations copy-on-write and commit. */
export function arrayOp(host: ArrayOpHost, path: string, method: string, args: readonly unknown[], current?: unknown): unknown {
  const cur = Array.isArray(current) ? current : host.read(path);
  if (!Array.isArray(cur)) return undefined;
  if (ARRAY_QUERY_METHODS.has(method)) return runArrayQuery(cur, method, args);

  const fastOp = FAST_OPS.get(method);
  if (fastOp) {
    const fast = fastOp(host, path, cur, args);
    if (fast !== NOT_HANDLED) return fast;
  }

  const arr = [...cur];
  const result = applyArrayMutation(arr, method, args);
  if (result !== undefined || ARRAY_MUTATION_METHODS.has(method)) host.batch(() => host.commit(path, arr));
  return result;
}

/** store.query(path, val, method, ...args): array query with the leading value argument, safe on non-arrays. */
export function queryArray(cur: unknown, val: unknown, method: string, args: readonly unknown[]): unknown {
  if (!Array.isArray(cur)) return method === 'length' ? 0 : undefined;
  return runArrayQuery(cur, method, [val, ...args]);
}
