import { createMutationResult, type JsonMutationResult } from '@adsq/jsnq/data-engine';

/** True for non-null objects (arrays included, functions excluded) — the "branch" test used across the store. */
export const isBranch = (value: unknown): value is object => value !== null && typeof value === 'object';

// Mutation-result builders. `existed` defaults to "previous is not undefined".

/** A `set` of one path. */
export function setResult(
  path: string,
  previous: unknown,
  next: unknown,
  existed: boolean = previous !== undefined,
  branchReplaced: boolean = isBranch(previous) || isBranch(next),
): JsonMutationResult {
  return createMutationResult({
    path, kind: 'set', previous, next, existed, changed: [path], inserted: existed ? [] : [path],
    branchReplaced, affectedPaths: [path],
  });
}

/** A `delete` of one path. */
export function deleteResult(
  path: string,
  previous: unknown,
  existed: boolean = previous !== undefined,
  branchReplaced: boolean = isBranch(previous),
): JsonMutationResult {
  return createMutationResult({
    path, kind: 'delete', previous, existed, deleted: existed ? [path] : [], branchReplaced, affectedPaths: [path],
  });
}

/** Wake-only marker for a path whose data was already written: changed, no value payload, no branch replace. */
export const touchResult = (path: string): JsonMutationResult =>
  createMutationResult({ path, kind: 'set', changed: [path], affectedPaths: [path], branchReplaced: false });

const isPlainContainer = (value: object): boolean => {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function copyPlain(value: object, seen: WeakMap<object, unknown>): unknown {
  const cached = seen.get(value);
  if (cached !== undefined) return cached;
  if (Array.isArray(value)) {
    const out = new Array<unknown>(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) continue;
      const item = value[i];
      out[i] = isBranch(item) && isPlainContainer(item) ? copyPlain(item, seen) : item;
    }
    return out;
  }
  const out = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(value, out);
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const item = source[key];
    const copy = isBranch(item) && isPlainContainer(item) ? copyPlain(item, seen) : item;
    if (key === '__proto__') Object.defineProperty(out, key, { value: copy, enumerable: true, configurable: true, writable: true });
    else out[key] = copy;
  }
  return out;
}

/**
 * The value to store for an assignment: plain objects and arrays (at any depth) are copied, so the
 * store never aliases the caller's data or its own; cycles and shared references survive as copies.
 * Primitives, functions and non-plain objects (Date, Map, class instances) are kept by reference.
 */
export const ownValue = <T>(value: T): T =>
  isBranch(value) && isPlainContainer(value) ? (copyPlain(value, new WeakMap()) as T) : value;
