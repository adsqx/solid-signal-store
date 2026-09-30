/**
 * High-performance fixed-capacity ring (circular) buffer.
 * O(1) push/overwrite, bounded memory, no unbounded allocations on hot path.
 * Useful for logs, event streams, temporary result windows, etc.
 *
 * Designed for the performance-sensitive parts of store-solid (demo logs, potential bridge collectors, etc.).
 * Snapshot via toArray() only when needed (avoids paying for iteration in every push).
 */

export class RingBuffer<T> {
  private readonly buffer: (T | undefined)[];
  private readonly capacity: number;
  private head = 0;   // index of oldest element
  private length = 0; // current number of elements

  constructor(capacity: number) {
    if (capacity <= 0 || !Number.isFinite(capacity)) {
      throw new Error(`RingBuffer capacity must be positive finite, got ${capacity}`);
    }
    this.capacity = Math.floor(capacity);
    this.buffer = new Array(this.capacity);
  }

  get size(): number {
    return this.length;
  }

  get isFull(): boolean {
    return this.length === this.capacity;
  }

  get isEmpty(): boolean {
    return this.length === 0;
  }

  /** Push item. Overwrites oldest when full (O(1)). */
  push(item: T): void {
    const idx = (this.head + this.length) % this.capacity;
    this.buffer[idx] = item;

    if (this.length < this.capacity) {
      this.length++;
    } else {
      // buffer was full → we overwrote the oldest
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Remove and return oldest item, or undefined if empty. */
  pop(): T | undefined {
    if (this.length === 0) return undefined;

    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined; // help GC
    this.head = (this.head + 1) % this.capacity;
    this.length--;
    return item;
  }

  /** Peek oldest without removing. */
  peek(): T | undefined {
    if (this.length === 0) return undefined;
    return this.buffer[this.head];
  }

  /** Clear all elements (O(1) logical, O(capacity) to help GC if desired). */
  clear(): void {
    // Best-effort GC help without extra allocation
    for (let i = 0; i < this.length; i++) {
      const idx = (this.head + i) % this.capacity;
      this.buffer[idx] = undefined;
    }
    this.head = 0;
    this.length = 0;
  }

  /**
   * Returns a snapshot array in insertion order (oldest first).
   * This allocates — call only when you actually need the array (e.g. for rendering logs).
   */
  toArray(): T[] {
    const result: T[] = new Array(this.length);
    for (let i = 0; i < this.length; i++) {
      result[i] = this.buffer[(this.head + i) % this.capacity] as T;
    }
    return result;
  }

  /** Iterate in insertion order without extra allocation (generator). */
  *[Symbol.iterator](): IterableIterator<T> {
    for (let i = 0; i < this.length; i++) {
      yield this.buffer[(this.head + i) % this.capacity] as T;
    }
  }

  /** Debug helper */
  toString(): string {
    return `RingBuffer(cap=${this.capacity}, len=${this.length})`;
  }
}

export type { RingBuffer as IRingBuffer }; // for interface consumers if needed