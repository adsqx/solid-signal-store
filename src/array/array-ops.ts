// array-ops.ts — shared array method classification + the pure mutation dispatch table.
// Single source for SolidStore.arrayOp, the proxy's array-method routing and the fluent chain.

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
