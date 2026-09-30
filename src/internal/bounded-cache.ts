/**
 * Insertion-order (FIFO) bounded Map cache. Inserting past `limit` evicts the oldest entry;
 * reads never reorder. Callers cache only after a miss, so `set` always inserts a new key.
 */
export class BoundedCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.map.size;
  }

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
