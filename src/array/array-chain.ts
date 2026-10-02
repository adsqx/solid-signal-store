// Fluent ArrayChain over a narrow ArrayMutator (read + commit + batch). Queries use native methods on the
// snapshot; mutations copy-on-write, batch and commit. Predicate-or-value sugar lives here only.

import { ownValue } from '../internal/util';

export interface ArrayMutator {
  read(path: string): unknown;
  commit(path: string, value: unknown): void;
  batch(fn: () => void): void;
}

type Predicate<T> = (item: T, index: number, arr: T[]) => boolean;
type Mapper<T, R> = (item: T, index: number, arr: T[]) => R;
type Reducer<T, R> = (acc: R, item: T, index: number, arr: T[]) => R;

function asPredicate<T>(v: Predicate<T> | T): Predicate<T> {
  return typeof v === 'function' ? (v as Predicate<T>) : (item: T) => item === v;
}

function readArr<T>(mut: ArrayMutator, p: string): T[] {
  const v = mut.read(p ?? '');
  return Array.isArray(v) ? v : [];
}

function mutate<T, R>(mut: ArrayMutator, p: string, op: (a: T[]) => R): R {
  const copy = [...readArr<T>(mut, p)];
  const r = op(copy);
  mut.batch(() => mut.commit(p, copy));
  return r;
}

export class ArrayChain<T = unknown> {
  constructor(protected readonly p: string, protected readonly m: ArrayMutator) {}

  private run(op: (a: T[]) => unknown): this {
    mutate(this.m, this.p, op);
    return this;
  }

  private arr(): T[] { return readArr<T>(this.m, this.p); }

  // Mutations (chainable; native return values are swallowed)
  push(...v: T[]): this { return v.length ? this.run(a => a.push(...v.map(ownValue))) : this; }
  unshift(...v: T[]): this { return v.length ? this.run(a => a.unshift(...v.map(ownValue))) : this; }
  pop(): this { return this.run(a => a.pop()); }
  shift(): this { return this.run(a => a.shift()); }
  reverse(): this { return this.run(a => a.reverse()); }
  sort(fn?: (x: T, y: T) => number): this { return this.run(a => a.sort(fn)); }
  splice(start: number, del = 0, ...items: T[]): this { return this.run(a => a.splice(start, del, ...items.map(ownValue))); }

  update(i: number, val: T): this {
    return this.run(a => {
      if (i < 0 || i >= a.length) throw new Error(`Index ${i} out of bounds for ${this.p}`);
      a[i] = ownValue(val);
    });
  }
  updateByFind(pred: T | Predicate<T>, val: T): this {
    const f = asPredicate(pred);
    return this.run(a => { const i = a.findIndex(f); if (i !== -1) a[i] = ownValue(val); });
  }
  delete(pred: T | Predicate<T>): this {
    const f = asPredicate(pred);
    return this.run(a => { for (let i = a.length - 1; i >= 0; i--) if (f(a[i]!, i, a)) a.splice(i, 1); });
  }
  deleteByIndex(i: number): this {
    return this.run(a => { if (i >= 0 && i < a.length) a.splice(i, 1); });
  }

  // Queries (immediate)
  find(pred: T | Predicate<T>): T | undefined { return this.arr().find(asPredicate(pred)); }
  findIndex(pred: T | Predicate<T>): number { return this.arr().findIndex(asPredicate(pred)); }
  /** Chain scoped to the matching items: its `update(i, v)` / `delete()` act on matches only. */
  filter(pred: T | Predicate<T>): ArrayChain<T> { return new FilteredArrayChain<T>(this.p, this.m, asPredicate(pred)); }
  map<R>(fn: Mapper<T, R>): R[] { return this.arr().map(fn); }
  reduce<R>(fn: Reducer<T, R>, init: R): R { return this.arr().reduce(fn, init); }
  some(pred: T | Predicate<T>): boolean { return this.arr().some(asPredicate(pred)); }
  every(pred: T | Predicate<T>): boolean { return this.arr().every(asPredicate(pred)); }
  includes(v: T): boolean { return this.arr().includes(v); }
  indexOf(v: T): number { return this.arr().indexOf(v); }
  length(): number { return this.arr().length; }
}

// Everything else on a filtered chain (push, find, updateByFind, ...) keeps acting on the whole array.
class FilteredArrayChain<T> extends ArrayChain<T> {
  constructor(p: string, m: ArrayMutator, private readonly matches: Predicate<T>) {
    super(p, m);
  }

  /** Replaces the i-th matching item. */
  override update(i: number, val: T): this {
    const matches = this.matches;
    mutate<T, void>(this.m, this.p, (a) => {
      let matchCount = 0;
      for (let idx = 0; idx < a.length; idx++) {
        if (!matches(a[idx]!, idx, a)) continue;
        if (matchCount++ === i) { a[idx] = ownValue(val); break; }
      }
    });
    return this;
  }

  /** Removes every matching item. */
  override delete(): this {
    return super.delete(this.matches as Predicate<T>);
  }
}

export function createArrayChain<T = unknown>(path: string, mutator: ArrayMutator): ArrayChain<T> {
  return new ArrayChain<T>(path, mutator);
}
