/**
 * draft-contract.test.ts — contract of the `$draft` / `SolidStore#draft` plain-JSON write view.
 * Writes route through the store (precise wakes), reads are untracked peeks, proxies always show the
 * current value. Run: bun --conditions browser test/draft-contract.test.ts
 */
import { createEffect, createMemo, createRoot } from 'solid-js';
import { createSolidStore, type Draft } from '../src';
import { createSolidDevtools } from '../src/devtools';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
const eq = (actual: unknown, expected: unknown, message: string): void =>
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Item = { id: number; done: boolean; label: string };
type State = {
  user: { name: string; address: { city: string }; tags: string[] };
  other: { n: number };
  items: Item[];
};
const initial = (): State => ({
  user: { name: 'Ann', address: { city: 'Oslo' }, tags: ['a', 'b'] },
  other: { n: 1 },
  items: [{ id: 1, done: false, label: 'one' }, { id: 2, done: false, label: 'two' }, { id: 3, done: false, label: 'three' }],
});

let seq = 0;
const make = (touched?: string[]) => {
  const api = createSolidStore<State>(initial(), `draft_contract_${seq++}`, touched ? { _onSignalUpdate: (p) => touched.push(p) } : {});
  return { api, store: api.store, draft: api.store.$draft };
};

/** Runs `fn` as an effect and counts its runs (`runs.n`). */
function watch(fn: () => void): { n: number } {
  const runs = { n: 0 };
  createEffect(() => { fn(); runs.n++; });
  return runs;
}

async function run(name: string, body: () => Promise<void> | void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    createRoot(async (dispose) => {
      try { await body(); dispose(); resolve(); } catch (e) { dispose(); reject(e); }
    });
  });
  console.log(`ok - ${name}`);
}

await run('root: store.$draft === api.draft, stable identity, typed as Draft<T>', () => {
  const { api, store } = make();
  assert(store.$draft === api.draft, 'same view');
  assert(store.$draft === store.$draft, 'stable');
  const typed: Draft<State> = api.draft;
  assert(typed.user === typed.user, 'child identity stable');
  assert(store.user.$draft === store.$draft.user, 'nested $draft is the same view rooted at that path');
  assert(store.user.name.$draft === 'Ann', 'primitive $draft is the plain value');
});

await run('reads: primitives plain, objects/arrays are draft proxies of the current value', () => {
  const { draft } = make();
  assert(draft.user.name === 'Ann', 'primitive read');
  assert(draft.user.address.city === 'Oslo', 'deep primitive');
  assert(typeof draft.user === 'object' && draft.user !== null, 'object read');
  assert(draft.items.length === 3 && draft.items[1]!.label === 'two', 'array length / index');
  assert((draft as any).missing === undefined, 'missing key');
  assert('user' in draft && !('nope' in draft), 'in');
});

await run('JSON.stringify / spread / Object.keys / Array.isArray / for-of / entries', () => {
  const { draft } = make();
  eq(draft.user, initial().user, 'stringify user');
  eq(draft, initial(), 'stringify root');
  eq(Object.keys(draft.user), ['name', 'address', 'tags'], 'keys');
  eq(Object.entries(draft.user.address), [['city', 'Oslo']], 'entries');
  const spread = { ...draft.user };
  eq(spread, initial().user, 'spread');
  assert(spread.address === draft.user.address, 'spread values are draft proxies');
  assert(Array.isArray(draft.items) && Array.isArray(draft.user.tags) && !Array.isArray(draft.user), 'isArray');
  const ids: number[] = [];
  for (const item of draft.items) ids.push(item.id);
  eq(ids, [1, 2, 3], 'for-of');
  eq([...draft.user.tags], ['a', 'b'], 'array spread');
  eq(Object.keys(draft.items), ['0', '1', '2'], 'array keys');
  assert(Object.prototype.toString.call(draft.items) === '[object Array]', 'toString tag');
});

await run('draft reads inside effect and memo do NOT subscribe', async () => {
  const { store, draft } = make();
  const effect = watch(() => { void draft.user.name; void draft.items.length; void draft.items[0]!.label; void JSON.stringify(draft.user); });
  const memo = createMemo(() => draft.user.name + draft.other.n);
  let memoRuns = 0;
  createEffect(() => { memo(); memoRuns++; });
  await flush();
  const base = effect.n, baseMemo = memoRuns;
  draft.user.name = 'Ada';
  draft.other.n = 5;
  draft.items.push({ id: 4, done: false, label: 'four' });
  await flush();
  assert(effect.n === base, `effect did not re-run (${effect.n} vs ${base})`);
  assert(memoRuns === baseMemo && memo() === 'Ann1', 'memo untouched (stale snapshot, as documented)');
  assert(store.user.name() === 'Ada', 'but the store has the write');
});

await run('writes wake only consumers of the written path', async () => {
  const touched: string[] = [];
  const { store, draft } = make(touched);
  const name = watch(() => { store.user.name(); });
  const city = watch(() => { store.user.address.city(); });
  const n = watch(() => { store.other.n(); });
  await flush();
  const base = [name.n, city.n, n.n];
  touched.length = 0;
  draft.user.name = 'Ada';
  await flush();
  eq([name.n - base[0]!, city.n - base[1]!, n.n - base[2]!], [1, 0, 0], 'only user.name consumers');
  assert(touched.length === 1 && touched[0] === 'user.name', `touched ${touched}`);
  draft.user.address.city = 'Rome';
  draft.other.n = 2;
  await flush();
  eq([name.n - base[0]!, city.n - base[1]!, n.n - base[2]!], [1, 1, 1], 'then city and n');
  assert(store.user.address.city() === 'Rome' && store.other.n() === 2, 'values written');
});

await run('write ≡ store assignment (same signal touches, same devtools events)', () => {
  const rec = () => {
    const touched: string[] = [], events: string[] = [];
    const devtools = createSolidDevtools();
    const api = createSolidStore<State>(initial(), `draft_contract_${seq++}`, { _onSignalUpdate: (p) => touched.push(p), devtools });
    api.enableDevTools();
    devtools.action$.subscribe((e) => events.push(JSON.stringify([e.type, e.payload])));
    return { api, touched, events };
  };
  const d = rec(), s = rec();
  d.events.length = s.events.length = 0;
  const draft = d.api.draft, plain = s.api.store as any;
  draft.user.name = 'X'; delete (draft.user.address as any).city; draft.items.push({ id: 9, done: false, label: 'n' });
  plain.user.name = 'X'; delete plain.user.address.city; plain.items.push({ id: 9, done: false, label: 'n' });
  eq(d.touched, s.touched, 'identical signal touches');
  eq(d.events, s.events, 'identical devtools events');
  assert(d.events.length >= 3, 'events were emitted');
  eq(d.api.readStore(), s.api.readStore(), 'same data');
});

await run('delete and assigning undefined', async () => {
  const { store, draft } = make();
  const tags = watch(() => { store.user.tags(); });
  const city = watch(() => { store.user.address.city(); });
  await flush();
  const base = [tags.n, city.n];
  delete (draft.user as any).tags;
  await flush();
  assert(!('tags' in draft.user) && store.user.tags() === undefined, 'deleted');
  assert(tags.n === base[0]! + 1 && city.n === base[1], 'only the deleted path woke');
  (draft.user as any).address = undefined;
  assert(!('address' in draft.user), 'undefined assignment deletes (store semantics)');
});

await run('array mutators route to the store with precise wake', async () => {
  const touched: string[] = [];
  const { store, draft } = make(touched);
  const first = watch(() => { store.items[0].label(); });
  const len = watch(() => { void store.items().length; });
  await flush();
  const base = [first.n, len.n];
  touched.length = 0;
  assert(draft.items.push({ id: 4, done: false, label: 'four' }, { id: 5, done: false, label: 'five' }) === 5, 'push returns length');
  await flush();
  assert(first.n === base[0], 'push did not wake item 0');
  assert(len.n === base[1]! + 1, 'push woke the array consumer');
  assert(!touched.includes('items.0') && !touched.includes('items.0.label'), `tail-only wake: ${touched}`);
  assert(draft.items.pop()!.id === 5, 'pop returns the removed plain value');
  eq(draft.items.splice(1, 1).map((i) => i.id), [2], 'splice returns removed');
  eq(draft.items.map((i) => i.id), [1, 3, 4], 'splice applied');
  assert(draft.items.shift()!.id === 1 && draft.items.unshift({ id: 0, done: true, label: 'zero' }) === 3, 'shift/unshift');
  const sorted = draft.items.sort((a, b) => b.id - a.id);
  assert(sorted === draft.items, 'sort returns the draft array');
  eq(store.items().map((i: Item) => i.id), [4, 3, 0], 'sort applied to the store');
  draft.items.reverse();
  eq(store.items().map((i: Item) => i.id), [0, 3, 4], 'reverse');
  draft.items.fill({ id: 9, done: false, label: 'f' });
  eq(store.items().map((i: Item) => i.id), [9, 9, 9], 'fill');
  draft.user.tags.length = 1;
  eq(store.user.tags(), ['a'], 'length assignment truncates');
  await flush();
});

await run('non-mutating array methods run over the draft view; find-then-write writes through', async () => {
  const { store, draft } = make();
  const two = watch(() => { store.items[1].done(); });
  const one = watch(() => { store.items[0].done(); });
  await flush();
  const base = [two.n, one.n];
  draft.items.find((x) => x.id === 2)!.done = true;
  await flush();
  assert(store.items[1].done() === true, 'wrote through');
  assert(two.n === base[0]! + 1 && one.n === base[1], 'precise wake');
  draft.items.filter((x) => x.id > 2)[0]!.label = 'THREE';
  assert(store.items[2].label() === 'THREE', 'filter hands out draft proxies');
  draft.items.map((x) => x)[0]!.label = 'ONE';
  assert(store.items[0].label() === 'ONE', 'map hands out draft proxies');
  for (const item of draft.items) if (item.id === 3) item.done = true;
  assert(store.items[2].done() === true, 'for-of element write');
  draft.items.forEach((x) => { x.label = x.label.toLowerCase(); });
  eq(store.items().map((i: Item) => i.label), ['one', 'two', 'three'], 'forEach writes');
  assert(draft.items.some((x) => x.done) && !draft.items.every((x) => x.done), 'some/every');
  assert(draft.items.indexOf(draft.items[1]!) === 1 && draft.items.includes(draft.items[2]!), 'indexOf/includes by draft identity');
  eq(draft.items.slice(1).map((x) => x.id), [2, 3], 'slice');
  eq(draft.user.tags.join('-'), 'a-b', 'join');
  eq(draft.items.reduce((s, x) => s + x.id, 0), 6, 'reduce');
  eq([...draft.items.entries()].map(([i, x]) => i + ':' + x.id), ['0:1', '1:2', '2:3'], 'entries');
});

await run('writing a draft proxy as a value stores the plain value (unwrap, detached)', () => {
  const { store, draft } = make();
  draft.other = draft.user as any;
  const stored = store.other() as any;
  assert(stored.name === 'Ann' && !('$draft' in stored), 'plain data stored');
  assert(stored !== store.user(), 'detached copy, not an aliased reference');
  draft.other.name = 'Zed';
  assert(store.user.name() === 'Ann' && store.other.name() === 'Zed', 'no aliasing between the two paths');
  draft.items.push(draft.items[0]!);
  assert(store.items().length === 4 && store.items()[3].label === 'one', 'push(draftProxy)');
  draft.user.tags = [draft.items[1]!.label as any, { nested: draft.other } as any];
  assert((store.user.tags() as any)[1].nested.name === 'Zed', 'nested proxies inside plain values are unwrapped');
  assert(JSON.stringify(store()).includes('"nested"'), 'serializable');
  const plain = { x: 1 };
  draft.other = plain as any;
  assert(store.other() !== plain && (store.other() as any).x === 1, 'plain values follow the store assignment semantics (a copy is stored)');
});

await run('proxies reflect the CURRENT value after parent replacement and reorder', () => {
  const { store, draft } = make();
  const user = draft.user, address = draft.user.address, second = draft.items[1]!;
  draft.user = { name: 'New', address: { city: 'Bergen' }, tags: [] };
  assert(user.name === 'New' && address.city === 'Bergen', 'held proxies see the replaced parent');
  address.city = 'Tromso';
  assert(store.user.address.city() === 'Tromso', 'held proxy writes to the current location');
  assert(second.id === 2, 'before reorder');
  draft.items.sort((a, b) => b.id - a.id); // [3,2,1]: index 1 is still id 2
  assert(second.id === 2, 'sorted: same index');
  draft.items.unshift({ id: 0, done: false, label: 'z' }); // [0,3,2,1]: index 1 is now id 3
  assert(second.id === 3, `held proxy follows its position, not the old element (${second.id})`);
  draft.items = [{ id: 7, done: false, label: 'seven' }, { id: 8, done: false, label: 'eight' }];
  assert(second.label === 'eight', 'array replaced wholesale');
  second.label = 'EIGHT';
  assert(store.items[1].label() === 'EIGHT', 'write lands at the path');
  delete (draft as any).other;
  assert((draft as any).other === undefined, 'deleted branch reads undefined');
});

await run('draft proxies of a non-existing / re-typed path are safe', () => {
  const { store, draft } = make();
  const tags = draft.user.tags;
  draft.user.tags = { x: 1 } as any;
  assert(Array.isArray(draft.user.tags) === false, 'fresh proxy follows the new kind');
  assert(tags.length === 0, 'stale-kind proxy views as empty, never throws');
  draft.user.tags = null as any;
  assert(store.user.tags() === null && tags.length === 0, 'null value');
});

console.log('draft-contract: all passed');
