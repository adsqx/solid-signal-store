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

  // array methods keep items by reference, as native arrays and the Angular store do
  const item = { v: 10, inner: { w: 1 } };
  s.list.push(item);
  s.list.unshift(item);
  s.list.splice(1, 0, item);
  const list = api.readStore('list') as any[];
  assert(list[3] === item && list[0] === item, 'push/unshift keep an outside item by reference');
  assert(same(list.map((x) => x.v), [10, 10, 1, 10]), 'push/unshift/splice values');
  s.list.splice(4, 1);
  const chainItem = { v: 20 };
  s.list.array().push(chainItem);
  assert((api.readStore('list') as any[])[4] === chainItem, 'array chain keeps items by reference too');

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

// ---------------------------------------------------------------------------------------------
// 2. $subscribe on an object/array fires for in-place changes with the default equality
// ---------------------------------------------------------------------------------------------
{
  const api = fresh({ user: { name: 'Ann', address: { city: 'Oslo' } }, list: [1, 2, 3], n: 1 });
  const s = api.store as any;
  const obj: unknown[] = [], arr: unknown[] = [], leaf: number[] = [], custom: unknown[] = [];
  const subs = [
    s.user.$subscribe((v: unknown) => obj.push(JSON.stringify(v))),
    s.list.$subscribe((v: unknown) => arr.push(JSON.stringify(v))),
    s.n.$subscribe((v: number) => leaf.push(v)),
    s.user.$subscribe((v: unknown) => custom.push(v), { equals: () => true }),
  ];
  assert(obj.length === 1 && arr.length === 1 && leaf.length === 1, 'subscriptions emit the initial value');

  s.user.name = 'Ada';
  assert(obj.length === 2 && obj[1] === JSON.stringify({ name: 'Ada', address: { city: 'Oslo' } }), 'object subscription fires on a leaf edit');
  s.user.address.city = 'Rome';
  assert(obj.length === 3, 'object subscription fires on a deep edit');
  s.list.push(4);
  assert(arr.length === 2, 'array subscription fires on push');
  s.list[0] = 9;
  assert(arr.length === 3 && arr[2] === '[9,2,3,4]', 'array subscription fires on an element write');
  s.list.sort((a: number, b: number) => a - b);
  assert(arr.length === 4, 'array subscription fires on sort');

  s.n = 1;
  assert(leaf.length === 1, 'primitive leaf subscription stays deduplicated');
  s.n = 2;
  assert(same(leaf, [1, 2]), 'primitive leaf subscription fires on change');
  assert(custom.length === 1, 'an explicit equals option is still honoured');

  subs.forEach((sub) => sub.unsubscribe());
  s.user.name = 'Zed';
  assert(obj.length === 3, 'unsubscribed object subscription stays silent');
  api.destroy();
}

// ---------------------------------------------------------------------------------------------
// 3. Every Array.prototype method works on a store array
// ---------------------------------------------------------------------------------------------
{
  const api = fresh({ list: [3, 1, 2], objs: [{ id: 1 }, { id: 2 }], cfg: { values: 1, keys: 2, at: 3, join: 4 } });
  const s = api.store as any;

  assert(s.list.reduce((a: number, b: number) => a + b, 0) === 6, 'reduce returns the reduced value');
  assert(s.list.reduce((a: number, b: number) => a + b) === 6, 'reduce without an initial value');
  assert(s.list.reduceRight((a: string, b: number) => a + b, '') === '213', 'reduceRight');
  assert(same(s.list.flatMap((x: number) => [x, x]), [3, 3, 1, 1, 2, 2]), 'flatMap');
  assert(same(s.objs.map((o: any) => [o.id]).concat([]), [[1], [2]]), 'map result is a real array');
  assert(same(s.list.flat(), [3, 1, 2]), 'flat');
  assert(s.list.join('-') === '3-1-2', 'join');
  assert(s.list.at(-1) === 2 && s.list.at(0) === 3, 'at');
  assert(s.list.findLast((x: number) => x < 3) === 2, 'findLast');
  assert(s.list.findLastIndex((x: number) => x < 3) === 2, 'findLastIndex');
  assert(s.list.lastIndexOf(1) === 1, 'lastIndexOf');
  assert(same(s.list.slice(1), [1, 2]) && same(s.list.concat([9]), [3, 1, 2, 9]), 'slice / concat');
  assert(same([...s.list.entries()], [[0, 3], [1, 1], [2, 2]]), 'entries');
  assert(same([...s.list.keys()], [0, 1, 2]) && same([...s.list.values()], [3, 1, 2]), 'keys / values');
  assert(same(s.list.toSorted(), [1, 2, 3]) && same(s.list.toReversed(), [2, 1, 3]), 'toSorted / toReversed');
  assert(same(s.list.with(0, 7), [7, 1, 2]) && same(s.list.toSpliced(0, 1), [1, 2]), 'with / toSpliced');
  assert(same(api.readStore('list'), [3, 1, 2]), 'non-mutating methods leave the array alone');
  const each: number[] = [];
  s.list.forEach((x: number) => each.push(x));
  assert(same(each, [3, 1, 2]), 'forEach');

  // they are tracked reads on the current array
  const sum = watch(() => s.list.reduce((a: number, b: number) => a + b, 0));
  s.list.push(4);
  s.list.splice(0, 1, 10); // an index assignment wakes only that index in the default 'grained' mode
  assert(sum.seen.length >= 2, 'reduce is tracked by push');
  assert(sum.seen[sum.seen.length - 1] === 17, 'reduce sees the latest array');
  s.list.splice(0, 1);
  assert(sum.seen[sum.seen.length - 1] === 7, 'reduce is tracked by splice');
  sum.dispose();

  // a later sort / whole-array assignment keeps working
  s.list.reduce((a: number, b: number) => a + b, 0);
  s.list.sort((a: number, b: number) => b - a);
  assert(same(api.readStore('list'), [4, 2, 1]), 'sort after reduce');
  s.list = [5, 6];
  assert(same(api.readStore('list'), [5, 6]), 'assignment after reduce');
  s.list.reverse();
  assert(same(api.readStore('list'), [6, 5]), 'reverse after reduce');

  // mutating methods route through the store: fill / copyWithin
  const wake = watch(() => JSON.stringify(s.list()));
  s.list.fill(0, 1);
  assert(same(api.readStore('list'), [6, 0]), 'fill writes the store');
  assert(wake.seen.length === 2, 'fill wakes the array');
  s.list.push(7, 8);
  s.list.copyWithin(0, 2);
  assert(same(api.readStore('list'), [7, 8, 7, 8]), 'copyWithin writes the store');
  wake.dispose();

  const filler = { f: 1, nested: { g: 1 } };
  s.objs.fill(filler);
  const filled = api.readStore('objs') as any[];
  assert(filled.every((x) => x.f === 1 && x.nested.g === 1), 'fill writes the value to every slot');
  assert(new Set(filled).size === filled.length && filled[0].nested !== filled[1].nested, 'fill does not share one object between slots');
  s.objs.copyWithin(1, 0);
  const copied = api.readStore('objs') as any[];
  assert(copied[0] !== copied[1], 'copyWithin does not alias elements');

  // data keys named like array methods stay data keys on objects
  assert(s.cfg.values() === 1 && s.cfg.keys() === 2 && s.cfg.at() === 3 && s.cfg.join() === 4, 'object keys named like array methods read as data');
  s.cfg.values = 5;
  assert(api.readStore('cfg.values') === 5, 'object key named like an array method is writable');
  api.destroy();
}

console.log('All regression tests passed.');
