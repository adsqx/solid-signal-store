// Regression suite for known correctness bugs. Run: bun --conditions browser test/regressions.test.ts
import { createEffect, createRoot } from 'solid-js';
import { createSolidStore } from '../src';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
let seq = 0;
const fresh = <T extends Record<string, unknown>>(initial: T) => createSolidStore(initial, `regressions_${seq++}`);

/** Runs `read` in an effect; returns the run counter and a disposer. */
function watch(read: () => unknown) {
  const seen: unknown[] = [];
  const dispose = createRoot((d) => {
    createEffect(() => { seen.push(read()); });
    return d;
  });
  return { seen, dispose };
}

// ---------------------------------------------------------------------------------------------
// 1. Assignment copies plain JSON values instead of aliasing them
// ---------------------------------------------------------------------------------------------
{
  const api = fresh({ key: { a: 1 }, ext: null as unknown, list: [{ v: 1 }] as unknown[], other: { n: { z: 1 } } });
  const s = api.store as any;

  // self-assignment must not create a cycle
  s.key.key2 = s.key();
  assert(same(api.readStore(), { key: { a: 1, key2: { a: 1 } }, ext: null, list: [{ v: 1 }], other: { n: { z: 1 } } }), 'self-assign result');
  assert(api.readStore('key.key2') !== api.readStore('key'), 'self-assign key2 is a copy');
  JSON.stringify(api.readStore());

  // a value already in the store is copied, nested values included
  s.ext = s.other();
  assert(api.readStore('ext') !== api.readStore('other'), 'store-to-store assign copies');
  assert(api.readStore('ext.n') !== api.readStore('other.n'), 'store-to-store assign copies nested');
  api.setValue('ext.n.z', 2);
  assert(api.readStore('other.n.z') === 1, 'edit of the copy leaves the source alone');

  // an outside object mutated later does not leak into the store
  const outside = { q: 1, deep: { r: 1 } };
  s.ext = outside;
  outside.q = 2; outside.deep.r = 2;
  assert(same(api.readStore('ext'), { q: 1, deep: { r: 1 } }), 'proxy set copies outside objects');
  const outside2 = { q: 1 };
  api.setValue('ext', outside2);
  outside2.q = 2;
  assert(api.readStore('ext.q') === 1, 'setValue copies outside objects');

  // array methods copy their item arguments
  const item = { v: 10, inner: { w: 1 } };
  s.list.push(item);
  s.list.unshift(item);
  s.list.splice(1, 0, item);
  item.v = 11; item.inner.w = 2;
  const list = api.readStore('list') as any[];
  assert(same(list.map((x) => x.v), [10, 10, 1, 10]) , 'push/unshift/splice copy items');
  assert(list[0] !== list[1] && list[1] !== list[3], 'each inserted item is its own copy');
  assert(list[0].inner.w === 1, 'nested item values copied');
  const chainItem = { v: 20 };
  s.list.array().push(chainItem);
  chainItem.v = 21;
  assert((api.readStore('list.4') as any).v === 20, 'array chain copies items');

  // cyclic input is copied without recursion errors
  const cyc: any = { a: 1 }; cyc.self = cyc;
  s.ext = cyc;
  const stored = api.readStore('ext') as any;
  assert(stored !== cyc && stored.self === stored, 'cycles in the input are preserved as a copy');

  // non-plain objects are stored by reference (nothing to deep-clone), plain wrappers around them are copied
  class Box { constructor(public n: number) {} }
  const date = new Date(0), box = new Box(1), map = new Map([[1, 2]]);
  s.ext = { date, box, map };
  const ext = api.readStore('ext') as any;
  assert(ext.date === date && ext.box === box && ext.map === map, 'non-plain objects are kept by reference');
  assert(ext.box instanceof Box, 'class instances keep their prototype');
  s.ext = date;
  assert(api.readStore('ext') === date, 'a bare Date is stored as is');

  // primitive writes still wake exactly their leaf
  const leaf = watch(() => s.key.a());
  s.key.a = 7;
  assert(same(leaf.seen, [1, 7]), 'primitive leaf write wakes the leaf');
  leaf.dispose();
  api.destroy();
}

console.log('All regression tests passed.');
