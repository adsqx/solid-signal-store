import { createMutationResult, type JsonMutationResult } from '@adsq/jsnq/data-engine';

/** True for non-null objects (arrays included, functions excluded) — the "branch" test used across the store. */
export const isBranch = (value: unknown): value is object => value !== null && typeof value === 'object';

/**
 * Insertion-order (FIFO) bounded Map cache. Inserting past `limit` evicts the oldest entry;
 * reads never reorder. Callers cache only after a miss, so `set` always inserts a new key.
 */
export class BoundedCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  /** Stores `value` and returns it, so call sites can `return cache.set(key, compute())`. */
  set(key: K, value: V): V {
    const map = this.map;
    map.set(key, value);
    if (map.size > this.limit) map.delete(map.keys().next().value as K);
    return value;
  }

  clear(): void {
    this.map.clear();
  }
}

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
