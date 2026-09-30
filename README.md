# @adsq/solid-signal-store

[![npm version](https://img.shields.io/npm/v/@adsq/solid-signal-store)](https://www.npmjs.com/package/@adsq/solid-signal-store)
[![license](https://img.shields.io/npm/l/@adsq/solid-signal-store)](./LICENSE)

Fine-grained state for SolidJS built on a **callable nested proxy**. Every path in your
state is both a value and a function: `store.user.name()` reads that path and subscribes the
running effect or JSX binding to exactly that path, and an ordinary assignment such as
`store.user.name = 'Ada'` wakes only the consumers of that path. There are no actions,
reducers, or setter functions to wire up, and arrays, dynamic keys, batching, and named
stores are handled by the same proxy. JSNQ queries and bulk mutations, and devtools, are
optional entries that stay out of your bundle until you import them.

```js
store.user.name();          // read + subscribe to "user.name" only
store.user.name = 'Ada';    // write + wake only the consumers of "user.name"
```

## Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [In Solid Components](#in-solid-components)
- [Arrays](#arrays)
- [Batch And Wake Modes](#batch-and-wake-modes)
- [JSNQ Operations](#jsnq-operations)
- [Named Stores And Async Creation](#named-stores-and-async-creation)
- [Optional Devtools](#optional-devtools)
- [TypeScript](#typescript)
- [Lazy Creation](#lazy-creation)
- [Performance](#performance)
- [Package Entries](#package-entries)
- [API Reference](#api-reference)
- [FAQ And Troubleshooting](#faq-and-troubleshooting)
- [Compatibility](#compatibility)
- [Use With AI Coding Agents](#use-with-ai-coding-agents)
- [Verify](#verify)
- [Bundle Size](#bundle-size)
- [License](#license)

## Install

```sh
npm install solid-js @adsq/solid-signal-store @adsq/jsnq
# or
bun add solid-js @adsq/solid-signal-store @adsq/jsnq
```

`solid-js` and `@adsq/jsnq` are peer dependencies. The core store uses the JSNQ data engine
for path reads and writes, so `@adsq/jsnq` must be installed even if you never run a query.
Declaring it in your own `package.json` also lets strict installers such as pnpm and Yarn
PnP resolve the operator imports (`@adsq/jsnq/operators/where`) that your code makes.

## Quick Start

```ts
import { createSolidStore } from '@adsq/solid-signal-store';

type State = { user: { name: string; tags: string[] }; dashboard: { tiles: number } };

const api = createSolidStore<State>({
  user: { name: 'Ann', tags: ['admin'] },
  dashboard: { tiles: 12 },
}, 'app');

const store = api.store;                 // read and subscribe: store.user.name()
const write = store as unknown as State; // typed assignment view, see "TypeScript"

store.user.name();                       // => 'Ann'
write.user.name = 'Ada';
write.user.tags.push('maintainer');
store.user.name();                       // => 'Ada'
store.user.tags();                       // => ['admin', 'maintainer']
```

In plain JavaScript, or when `store` is typed `any`, assign to `store` directly:
`store.user.name = 'Ada'`. TypeScript needs the `write` view or `api.setValue`; the reason
is explained in [TypeScript](#typescript).

Create stores at module scope (or once, in a context) and import them where they are used. A
store is not tied to a component, and creating one inside a component body would rebuild
it on every mount.

## Core Concepts

### Paths

A store is a tree of JSON-like data. Every node is addressed by a dot-separated **path**
(`user.name`, `users.0.name`), and the proxy builds the path as you navigate:

| Expression | Meaning |
| --- | --- |
| `store.user.name()` | Reactive read of the leaf at `user.name`. |
| `store.user.name = 'Ada'` | Write the leaf; wakes consumers of `user.name`. |
| `store.user()` | Reactive read of the whole `user` object. |
| `store.users[0].name()` | Array elements are addressed by index. |
| `store.users.length` | Reactive length, a property and not a call. |
| `delete store.user.nick` or `store.user.nick = undefined` | Remove the key. |

The same paths are accepted as strings by the instance methods:
`api.setValue('users.0.name', 'Ada')`, `api.readStore('users.0.name')`,
`api.wakeUp('user.name', 'leaf')`. Unsafe segments such as `__proto__` are rejected, and a
key that itself contains a dot cannot be addressed.

Keys can be created dynamically under an object typed with an index signature, and
assigning `undefined` deletes a key:

<!-- check: prelude -->
```ts
write.user.preferences.theme = 'dark';
store.user.preferences.theme();          // => 'dark'
write.user.preferences.theme = undefined;
store.user.preferences();                // => {}
```

The initial state is cloned when the store is created, so mutating the object you passed
in does not affect the store. Reads, in contrast, return the store's own objects: treat
the result of `store.user()` as read-only and write through the proxy instead.

### Fine-Grained Wake

Reading a path with `()` inside a Solid effect, memo, or JSX expression subscribes that
computation to that path's signal. A write updates the signal of the path that changed, so
only its consumers run:

<!-- check: prelude -->
```ts
import { createEffect, createRoot } from 'solid-js';

const log: string[] = [];
createRoot(() => {
  createEffect(() => log.push(`name=${store.user.name()}`));
  createEffect(() => log.push(`tiles=${store.dashboard.tiles()}`));
});

write.user.name = 'Ada';      // wakes only the name effect
write.user.name = 'Ada';      // same primitive value: nothing wakes
write.dashboard.tiles = 13;   // wakes only the tiles effect

log;                          // => ['name=Ann', 'tiles=12', 'name=Ada', 'tiles=13']
```

Replacing an object or array (`store.user = { ... }`) re-reads every already-observed path
below it. A leaf signal notifies only when its primitive value actually changed; a container
signal notifies on every replacement.

**Containers are not leaves.** In the default `grained` wake mode a write to
`user.name` wakes `user.name` and nothing above it. A computation that reads the container
(`store.user()`) is woken when `user` itself is replaced, not when a leaf inside it is
edited. Read the leaves you render, or pick a wake mode that walks the parent chain; see
[Batch And Wake Modes](#batch-and-wake-modes) and the
[FAQ](#the-ui-does-not-update-after-i-edit-a-field-of-an-object-or-array-i-read-as-a-whole).

### Reserved Names

Some property names on a node are API, not data: `$val`, `$signal`, `$subscribe`, the
`$`-prefixed operations (`$query`, `$mutate`, and so on), `mutate`, `pipe`, `array`,
`select`, `query`, `computedOf`, `toString`, `valueOf`, `toJSON`, `length`, and the array
methods listed under [Arrays](#arrays). At the store root, `setValue`, `readStore`,
`deleteValue`, `wakeUp`, and `batch` are reserved as well. A data key with one of those
names cannot be reached with property access, so do not use them as keys in state.

### Derived Values

Derive with ordinary Solid primitives that read store paths. `createMemo` works, and the
instance offers `computedOf` and `select` for the same job:

<!-- check: prelude -->
```ts
import { createMemo, createRoot } from 'solid-js';

createRoot((dispose) => {
  const greeting = createMemo(() => `Hello ${store.user.name()}`);
  const doubled = api.computedOf((s) => s.dashboard.tiles() * 2);

  write.user.name = 'Ada';
  write.dashboard.tiles = 20;

  greeting();          // => 'Hello Ada'
  doubled();           // => 40
  dispose();
});
```

`api.select(project, options?)` returns `{ subscribe, value }`: `subscribe(cb)` calls `cb`
immediately and again whenever the projected value changes (compared with `Object.is`
unless you pass `equals`), and returns `{ unsubscribe, dispose }`. Options are
`equals`, `immediate` (default `true`) and `onError`.

<!-- check: prelude -->
```ts
const titles: string[] = [];
const sub = api.select((s) => s.user.name().toUpperCase()).subscribe((v) => titles.push(v));

write.user.name = 'Ada';
sub.unsubscribe();
write.user.name = 'Grace';

titles;                // => ['ANN', 'ADA']
```

## In Solid Components

The proxy reads the same way inside a component. No signal wiring and no selector:

<!-- check: prelude, ssr=Dashboard contains=Ann|12|tiles|admin|api|120|samples -->
```tsx
import { For } from 'solid-js';

export function Dashboard() {
  return (
    <>
      <h1>{store.user.name()}</h1>
      <p>{store.dashboard.tiles()} tiles</p>

      <For each={store.user.tags()}>{(tag) =>
        <span class="tag">{tag}</span>
      }</For>

      <For each={store.services()}>{(service) =>
        <div class="row">
          <strong>{service.name}</strong>
          <span>{service.rps}</span>
        </div>
      }</For>

      <p>{store.history.length} samples</p>

      <button onClick={() => { write.dashboard.tiles = store.dashboard.tiles() + 1; }}>
        Add tile
      </button>
    </>
  );
}
```

Three rules cover every component:

- **A leaf is called**: `{store.user.name()}`. The call is the reactive read, so Solid
  tracks that exact path and updates only the text node bound to it.
- **An array is called to iterate it**, and each item is then a plain value read without
  parentheses: `<For each={store.services()}>` then `{service.name}`. Items are snapshots,
  not nested accessors. The `For` reruns when the array itself changes (push, pop, splice,
  sort, whole-array assignment), not when a field of an item is edited or an item is
  replaced by index; see the pattern below.
- **`length` is reactive without a call**: `{store.history.length}` tracks pushes and pops
  without materialising the array.

When a field inside a list item changes over time, bind the leaf through its index so that
exactly that text node updates:

<!-- check: prelude, ssr=Services contains=120 -->
```tsx
import { For } from 'solid-js';

export function Services() {
  return (
    <For each={store.services()}>{(service, i) =>
      <div class="row">
        <strong>{service.name}</strong>
        <span>{store.services[i()].rps()}</span>
      </div>
    }</For>
  );
}
```

Nested collections work the same way, for example
`store.board.rows[rowIndex()].cells[colIndex()].value()`; the
[browser demo](./examples/browser-demo) renders a 160-cell board exactly like this.

## Arrays

Arrays are proxied like any other node. These methods are available on an array node and
follow native semantics and return values:

| Kind | Methods |
| --- | --- |
| Mutating | `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse` |
| Reading (tracked) | `filter`, `map`, `find`, `findIndex`, `some`, `every`, `includes`, `indexOf`, `length` |

<!-- check: prelude -->
```ts
store.history.push(4, 5);               // => 5
store.history.pop();                    // => 5
store.history.splice(0, 1);             // => [1]
store.history.map((n) => n * 10);       // => [20, 30, 40]
store.history.includes(3);              // => true
store.history.length;                   // => 3
store.history[0]();                     // => 2
```

`push` and `pop` wake only the array, the new or removed index, and observed descendants of
that index. Other mutations copy the array, apply the method, and commit it as one
batched write. With `{ preciseMutationWake: true }` in `grained` mode, a `splice` that starts after index 0
skips the untouched prefix.

Only the methods above are proxied. For anything else (`reduce`, `forEach`, `slice`,
`flatMap`), call the array first and use the native method on the returned array:
`store.history().reduce(...)`.

Replacing one element or editing a field of one element wakes that element's own paths
(`services.0`, `services.0.rps`) but not the array node. To make an array consumer such as
`<For each={store.services()}>` see a replaced element in the default mode, splice it in
(`store.services.splice(i, 1, item)`) or use the fluent chain below; to update a
field, read it through its index leaf as shown in [In Solid Components](#in-solid-components).

### Fluent Array Chain

`store.users.array()` and `api.array('users')` return a chain that copies the array,
applies the operation, and commits once. Mutations are chainable, and the chain accepts a
value or a predicate wherever it looks up items:

<!-- check: prelude -->
```ts
type Row = { id: number; name: string; active: boolean; score: number };
const users = api.array('userList');

users
  .push({ id: 3, name: 'Cy', active: true, score: 5 })
  .updateByFind((u: Row) => u.id === 2, { id: 2, name: 'Bob', active: true, score: 21 })
  .delete((u: Row) => u.id === 1);

users.length();                          // => 2
users.find((u: Row) => u.id === 2);      // => { id: 2, name: 'Bob', active: true, score: 21 }
store.userList[0].name();                // => 'Bob'
```

| Operation | Purpose |
| --- | --- |
| `push`, `unshift`, `pop`, `shift`, `reverse`, `sort`, `splice` | Native mutations, chainable. |
| `update(i, value)` | Replace the item at an index; throws when out of bounds. |
| `updateByFind(valueOrPredicate, next)` | Replace the first match. |
| `delete(valueOrPredicate)`, `deleteByIndex(i)` | Remove matches or one index. |
| `filter(valueOrPredicate)` | A chain scoped to the matches: its `update(i, v)` and `delete()` act on matches only. |
| `find`, `findIndex`, `map`, `reduce`, `some`, `every`, `includes`, `indexOf`, `length()` | Immediate queries on the current snapshot. |

## Batch And Wake Modes

### Batching

<!-- check: prelude -->
```ts
import { createEffect, createRoot } from 'solid-js';

let runs = 0;
createRoot(() => createEffect(() => { store.user.name(); store.dashboard.tiles(); runs++; }));

api.batch(() => {
  write.user.name = 'Grace';
  write.dashboard.tiles = 16;
  store.dashboard.tiles();   // => 16
});
runs;                        // => 2

write.user.name = 'Hopper';
write.dashboard.tiles = 20;
runs;                        // => 4
```

State writes inside `batch()` are synchronous and immediately readable, while Solid holds
back effects and memos until the outermost batch returns, so several writes produce one
reactive update. Batches nest. A single write needs no batch, and array and JSNQ
operations already batch their own multi-step commits. `api.batch(fn)` returns the value
of `fn`.

### Wake Modes

The wake mode controls which signals a write dirties.

| Mode | Paths dirtied | Use case |
| --- | --- | --- |
| `grained` | Exact changed path only | Default and fastest. Consumers read the leaf they need. |
| `leaf` | Exact path plus its parent chain | Effects and memos that consume a container. |

`fine` and `exact` alias `grained`; `container`, `parents`, and `branch` alias `leaf`.

<!-- check: prelude -->
```ts
api.wakeUp('grained');               // default for subsequent writes: exact path only
api.wakeUp('container');             // default for subsequent writes: path plus parents
api.wakeUp('user.name', 'grained');  // wake exactly this path now
api.wakeUp('user.name', 'leaf');     // wake this path and its parent chain now
```

The one-argument form changes the default for later writes. The two-argument form performs
a targeted wake and leaves the default alone. The default can also be set at creation with
`createSolidStore(state, name, { wakeParentsOnChange: true })`.

<!-- check: prelude -->
```ts
import { createMemo, createRoot } from 'solid-js';

const summary = createRoot(() => createMemo(() => store.user().name));

// Grained: the memo read the container, so a leaf write does not wake it.
write.user.name = 'Grace';
summary();                  // => 'Ann'

api.wakeUp('container');
write.user.name = 'Hopper';
summary();                  // => 'Hopper'
```

## JSNQ Operations

JSNQ is a separate package: a framework-independent JSON pipeline engine for queries and
bulk mutations. The store integrates it through an optional entry. Import that entry once,
during application bootstrap, to enable `mutate`, `$query`, `$queryOne`, `$liveQuery`,
`$liveQueryOne`, and `pipe`:

```ts
import '@adsq/solid-signal-store/jsnq';
```

Registration is synchronous. Calling a JSNQ operation without it throws an actionable
error that names the missing entry, and applications that never import it never load the
bridge. Individual operators remain separate imports.

<!-- check: prelude -->
```ts
import '@adsq/solid-signal-store/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

store.userList.mutate(
  where('active', '===', true),
  update('score', (score: number) => score + 1),
);

store.userList.$query(where('active', '===', true));          // => [{ id: 1, name: 'Ann', active: true, score: 11 }]
store.userList.$queryOne(where('id', '===', 2));              // => { id: 2, name: 'Bob', active: false, score: 20 }
store.userList[0].score();                                    // => 11
```

- `mutate(...ops)` applies the operators to that branch, commits the result, and returns the
  new branch value. The same call exists on any path: `api.mutate('userList', ...ops)`.
- `$query` and `$queryOne` are one-shot snapshots (`$queryOne` returns the first match or
  `null`). `$query` is typed as `unknown[]`, so cast the result to your item type.
- `$liveQuery` and `$liveQueryOne` return callable Solid accessors that recompute when the
  queried branch changes (any descendant of it) and can also be subscribed to.
- `pipe(...ops)` returns the JSNQ pipeline wrapper for that branch, for advanced use.

<!-- check: prelude -->
```ts
import '@adsq/solid-signal-store/jsnq';
import where from '@adsq/jsnq/operators/where';

const active = store.userList.$liveQuery(where('active', '===', true));
const seen: number[] = [];
const subscription = active.subscribe((users) => seen.push(users.length));

active();                                                     // => [{ id: 1, name: 'Ann', active: true, score: 10 }]
write.userList[1].active = true;
active().length;                                              // => 2

subscription.unsubscribe();
active.dispose();
seen;                                                         // => [1, 2]
```

`subscribe(cb, options?)` calls `cb` immediately and after each change, and returns
`{ unsubscribe, dispose }`. A live query registers interest in its branch when it is
created, and only `dispose()` (or unsubscribing an inline `.subscribe()`) releases it. Inside a
component, pair it with `onCleanup`:

<!-- check: prelude, typecheck -->
```ts
import { onCleanup } from 'solid-js';
import where from '@adsq/jsnq/operators/where';

const active = store.userList.$liveQuery(where('active', '===', true));
onCleanup(() => active.dispose());
```

Store options that affect JSNQ:

| Option | Effect |
| --- | --- |
| `preciseMutationWake: true` | Eligible flat `mutate` calls (array of objects, `where` plus value actions) wake only the changed branch, items and leaves instead of every observed descendant. Structural or deep mutations fall back to a branch commit. |
| `bridgeErrorMode` | How `mutate` reacts to an operator execution error: `'warn'` (default) logs and leaves a safe copy, `'silent'` does the same without logging, `'throw'` surfaces the error (recommended in development). |
| `jsnqBridge` | Supply a bridge instance explicitly instead of relying on the one the `/jsnq` entry registers. |

See the [`@adsq/jsnq` README](https://github.com/adsqx/jsnq#readme) for the operator
reference (`where`, `update`, `replace`, `mergeUpdate`, `deleteKey`, `insert`, `moveTo`,
and more).

## Named Stores And Async Creation

Every store is registered under its name (default `'default'`). When a module or service
owns the `api` and `store` references returned by `createSolidStore`, use them directly.
`waitForStore` is only for a separately loaded consumer that may run before the owner
has created the named store.

```ts
import { createSolidStore, useSolidStore, waitForStore } from '@adsq/solid-signal-store';

const pending = waitForStore<{ tiles: number }>('dashboard', { timeoutMs: 5_000 });

queueMicrotask(() => {
  createSolidStore({ tiles: 12 }, 'dashboard');
});

const dashboardApi = await pending;
dashboardApi.store.tiles();          // => 12

useSolidStore('dashboard') === dashboardApi;   // => true
```

- `useSolidStore(name)` is synchronous and throws when the store does not exist.
- `waitForStore(name, { timeoutMs?, signal? })` resolves immediately if the store exists,
  rejects with a timeout error, or rejects with an `AbortError` when the signal aborts. It is
  event-driven, does not poll, and removes its timer and listener on every completion path.
- **Creating a store under a name that is already registered destroys the previous store.**
  Its signals and caches are cleared and the new one takes over the name.
- `api.destroy()` is idempotent, removes the registry entry only if it still owns it,
  and clears signals, proxies, caches, subscriptions, and the attached devtools adapter.

## Optional Devtools

The main entry contains only the adapter types; the devtools service lives in its own entry
so production bundles do not include it.

<!-- check: prelude, typecheck -->
```ts
if (import.meta.env.DEV) {
  const { createSolidDevtools } = await import('@adsq/solid-signal-store/devtools');
  api.attachDevtools(createSolidDevtools());
  api.enableDevTools('app');
}
```

Once devtools are enabled, the store emits events describing what it does. The adapter
exposes them as two streams (`action$` for everything, `readAction$` for everything except
`PROXY_METRICS`), each with `subscribe(cb)` and `get()`. A subscriber immediately receives
the most recent event, if there is one.

```ts
import { createSolidStore } from '@adsq/solid-signal-store';
import { createSolidDevtools } from '@adsq/solid-signal-store/devtools';

const api = createSolidStore({ n: 1 }, 'devtools-demo');
const devtools = createSolidDevtools();
api.attachDevtools(devtools);
api.enableDevTools('devtools-demo');

const seen: string[] = [];
devtools.action$.subscribe((event) => seen.push(`${event.type} ${event.payload?.path ?? ''}`.trim()));

api.setValue('n', 2);
api.emitProxyMetrics();

seen;   // => ['DEVTOOLS_ENABLED', 'SET_VALUE n', 'PROXY_METRICS proxy-cache']
api.devAction$.get()?.payload?.signals;   // => 1
```

Event types are `DEVTOOLS_ENABLED`, `SET_VALUE`, `DELETE`, `MUTATE`, `PROXY_DISPATCH`,
`ARRAY_DISPATCH`, `CLEANUP`, `STORE_DESTROYED`, and `PROXY_METRICS`. `PROXY_METRICS` reports
how many signals, proxies and branch subscriptions the store currently holds. For a
process-wide feed across every store, `onSolidDevAction(cb)` receives the same events
(asynchronously, with `storeName`) and returns an unsubscribe function.

## TypeScript

The package ships its own declarations. `createSolidStore<T>` maps your state type to a
proxy type, so reads are fully typed:

```ts
import { createSolidStore } from '@adsq/solid-signal-store';

type Post = { title: string; tags: string[] };
type State = { user: { name: string; nick?: string; posts: Post[] } };

const api = createSolidStore<State>({ user: { name: 'Ada', posts: [{ title: 'Hello', tags: ['solid'] }] } }, 'ts');
const store = api.store;

const name: string = store.user.name();
const firstTag: string = store.user.posts[0].tags[0]();
const titles: string[] = store.user.posts.map((post) => post.title);
const count: number = store.user.posts.length;
```

Things worth knowing:

- **Use a `type` alias for the state, not an `interface`.** `createSolidStore` requires
  `T extends Record<string, unknown>`, which an interface does not satisfy.
- **Direct assignment does not type-check on a typed store.** The type of
  `store.user.name` is the accessor (`StoreLeaf<string>`), so
  `store.user.name = 'Ada'` is rejected even though it works at runtime. Use one of:

<!-- check: prelude=min -->
```ts
// 1. Path-based setter: any value, path checked only at runtime.
api.setValue('user.name', 'Grace');

// 2. A typed write view: cast the proxy to your plain state type and only assign through it.
const write = store as unknown as State;
write.user.name = 'Ada';
write.user.tags.push('maintainer');

// 3. Untyped code: `const store: any = api.store` accepts assignment directly.

store.user.name();                       // => 'Ada'
store.user.tags();                       // => ['admin', 'maintainer']
```

  The write view is a type-level convenience, so never *read* through it (`write.user.name`
  is a proxy at runtime, not a `string`).
- **Optional fields** (`nick?: string`) are optional on the proxy type too. Use `?.()` or a
  non-null assertion when reading them, or declare the field as `string | undefined`
  and give it an initial value.
- **Dynamic keys** need an index signature (`Record<string, unknown>`) or optional fields
  in the state type.
- `$query` returns `unknown[]` and `$queryOne` returns `unknown`; cast to your item type.
- `SolidStoreProxy<T>`, `StoreLeaf<T>`, `StoreArray<T>`, and the option types are exported
  from the main entry.

## Lazy Creation

The initial state is cloned when `createSolidStore` is called. Everything reactive around it
is created on demand:

- a proxy node and its Solid signal are created the first time your code navigates to a
  path (`store.user.name`), together with the nodes above it. Paths you never touch have
  neither;
- proxy nodes are cached with weak references and are collected when unreferenced;
- computed projections (`computedOf`, `select`) and live queries exist only when requested;
- a subscription allocates an effect only on `subscribe()` and disposes it on unsubscribe;
- the JSNQ bridge enters the graph only through `@adsq/solid-signal-store/jsnq`, and
  devtools only through `@adsq/solid-signal-store/devtools`;
- named-store waiters exist only while code is waiting for a store.

## Performance

These figures come from the repository's own benchmark scripts. They were measured on
one machine, so treat them as an order of magnitude and re-run them on yours.

**Environment:** Intel Xeon @ 2.80GHz, 4 vCPUs (`nproc` = 4), `x86_64`, Linux 6.18 (a shared
VM, 1-minute load average 3.4 to 6.5 while measuring), Bun 1.3.11, `solid-js` 1.9.14,
`@adsq/jsnq` 0.1.4, version 0.1.5 of this package. Every number below is the **median of 7
runs** of the script. Ranges are min to max across those 7 runs.

**Store throughput.** Reproduce with `bun run bench:store`
(`bun --conditions browser test/store-throughput-bench.ts`). Each run reports the median of
5 rounds per case, with a warm-up. No effects or DOM are attached, so this measures the
proxy, path write, and wake bookkeeping.

| Case | Work per round | Median ms (range) | Throughput |
| --- | --- | ---: | ---: |
| Deep read, navigating from the root each time | 500,000 reads of `store.user.profile.name()` | 215 (203-265) | 2.3 M reads/s |
| Deep write, navigating from the root each time | 200,000 writes to `store.user.profile.name` | 336 (285-383) | 0.6 M writes/s |
| Deep write through a cached parent node | 200,000 writes to `profile.name` | 278 (223-436) | 0.72 M writes/s |
| `push` + `pop` on a 100-item array, from the root | 100,000 pairs | 491 (440-670) | 0.20 M pairs/s |
| `push` + `pop` through a cached array node | 100,000 pairs | 443 (419-612) | 0.23 M pairs/s |
| Three writes in one `api.batch()` | 100,000 batches | 432 (302-564) | 0.23 M batches/s |

The spread between runs (up to about 50 percent on this shared machine) is larger than the
difference between the "from the root" and "cached" rows, so do not read a ranking into
those pairs.

**Against a native Solid signal.** Reproduce with `bun run bench:native`
(`bun --conditions browser test/native-vs-store-bench.ts`). The baseline is a single
`createSignal` holding an immutable tree that is updated by a path-copy helper defined in
the script, with two memos reading it; the store side has no subscribers and is written with
`api.setValue` or array methods. Each case is a single timed pass, so the small ones are
close to the timer resolution.

| Scenario | Native signal, median ms (range) | SolidStore, median ms (range) |
| --- | ---: | ---: |
| 3,000 deep path sets | 33 (22-42) | 21 (13-31) |
| 5,000 sets across 100 distinct deep paths | 133 (72-190) | 26 (17-56) |
| 1,000 push + pop on a 100-item array | 32 (27-51) | 48 (38-74) |
| 300 middle-`splice` inserts on a 100-item array | 2 (1-6) | 15 (5-29) |
| 500 push + pop pairs on a 1,000-item array | 22 (17-30) | 12 (7-32) |

Copying an immutable tree gets more expensive as the tree grows, while a store write
touches only the path it changes; on small arrays the copy is cheap and the native
baseline is faster. Neither number includes rendering.

## Package Entries

- `@adsq/solid-signal-store`: store runtime, registry helpers, and public types.
- `@adsq/solid-signal-store/jsnq`: optional JSNQ bridge; importing it registers the bridge.
- `@adsq/solid-signal-store/devtools`: optional development adapter.
- `@adsq/jsnq/operators/<name>`: focused JSNQ operators (separate package).

All entries are ESM only.

## API Reference

### Main Entry: `@adsq/solid-signal-store`

| Export | Kind | Purpose | Signature |
| --- | --- | --- | --- |
| `createSolidStore` | function | Create and register a store. Replaces (destroys) a store already registered under the same name. | `(initial: T, name = 'default', options?: SolidStoreOptions) => SolidStore<T>` |
| `useSolidStore` | function | Look up a registered store synchronously; throws when missing. | `(name = 'default') => SolidStore<T>` |
| `waitForStore` | function | Resolve once a named store exists. Supports timeout and abort. | `(name = 'default', options?: WaitForStoreOptions) => Promise<SolidStore<T>>` |
| `onSolidDevAction` | function | Subscribe to the process-wide devtools event bus. Returns an unsubscribe function. | `(fn: (event: StoreDevToolsAction & { storeName?: string }) => void) => () => void` |
| `SolidStore` | class | The store instance returned by `createSolidStore`. See below. | `new SolidStore(initial, name?, options?)` |
| `createProjectionObservable` | function | Wrap an accessor as a subscribable with `equals`, `immediate`, and `onError` options; used by `select`, `$subscribe`, and live queries. | `(accessor: () => T, options?: ProjectionObservableOptions<T>) => { subscribe(cb): { unsubscribe, dispose }; readonly value: T }` |
| `createSolidProxy` | function | Advanced: build a callable proxy over a custom `StoreMutator`. | `(mutator: StoreMutator, options?: SolidProxyOptions) => T` |
| `InternalPath` | namespace | Advanced and low-level: the path helpers the store uses (`normalizePath`, `splitPath`, `getByPath`, `setByPath`, `pathExists`, `isValidPath`, `getParentPath`, `enumerateAncestors`, `resolveParentAndKey`, `clearPathCaches`, and others). | `import { InternalPath } from '@adsq/solid-signal-store'` |

Types exported from the main entry: `SolidStoreOptions`, `WaitForStoreOptions`,
`SolidStoreProxy<T>`, `StoreLeaf<T>`, `StoreArray<T>`, `SolidWakeMode`, `StoreMutator`,
`SolidProxyOptions`, `SolidStoreReactivity`, `SolidProxyMetrics`, `DevStream`,
`DevToolsEvent`, `StoreDevToolsAction`, `ProxyMetrics`, `SolidDevtoolsAdapter`.

### `SolidStoreOptions`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `wakeParentsOnChange` | `boolean` | `false` | Start in container (`leaf`) wake mode instead of `grained`. |
| `preciseMutationWake` | `boolean` | `false` | Fine-grained wake for eligible flat `mutate` calls and `splice`. |
| `bridgeErrorMode` | `'throw' \| 'warn' \| 'silent'` | `'warn'` | How `mutate` handles an operator execution error. |
| `jsnqBridge` | `SolidJsnqBridge` | auto | Explicit JSNQ bridge instance. |
| `strict.invalidPath` | `boolean` | `false` | Throw when a written path is not a valid path. |
| `strict.deleteUndefined` | `boolean` | `false` | Throw when a write assigns `undefined` or deletes a key. |
| `devtools` | `SolidDevtoolsAdapter` | none | Attach an adapter at creation (same as `attachDevtools`). |

### `SolidStore` Instance (`api`)

| Member | Purpose | Signature |
| --- | --- | --- |
| `store` | The callable proxy root. `returnStore()` returns the same object. | `SolidStoreProxy<T>` |
| `batch` | Group writes into one reactive update. | `<R>(fn: () => R) => R` |
| `wakeUp` | Set the default wake mode, or wake one path now. | `(mode: SolidWakeMode) => void` / `(path: string, mode?: SolidWakeMode) => void` |
| `setWakeMode`, `wakePath` | Aliases for the two `wakeUp` forms. | `(mode) => void`, `(path, mode = 'grained') => void` |
| `setValue` | Write by path string. | `(path: string, value: unknown) => void` |
| `readStore` | Read by path string (not reactive; no path returns the root). | `(path = '') => unknown` |
| `deleteValue` | Delete by path string. | `(path: string) => void` |
| `mutate` | Apply JSNQ mutation operators at a path; returns the new branch value. | `(path: string, ...ops) => unknown` |
| `$query`, `$queryOne` | One-shot JSNQ snapshot at a path. | `(path, ...ops) => unknown[]` / `unknown` |
| `$liveQuery`, `$liveQueryOne` | Reactive JSNQ query at a path. | `(path, ...ops) => StoreLiveQuery<unknown[]>` / `<unknown>` |
| `pipe` | JSNQ pipeline wrapper for a branch. | `(path, ...ops) => any` |
| `array` | Fluent array chain for a path. | `(path: string) => ArrayChain` |
| `select` | Subscribable projection of store reads. | `<R>(project: (state: SolidStoreProxy<T>) => R, options?) => { subscribe(cb), readonly value }` |
| `computedOf` | Memo over store reads. Create it inside a reactive owner. | `<R>(project: (state: SolidStoreProxy<T>) => R) => Accessor<R>` |
| `enableDevTools` | Start emitting devtools events. | `(storeName?: string) => void` |
| `attachDevtools` | Attach a devtools adapter (replaces and destroys the previous one). | `(adapter: SolidDevtoolsAdapter) => void` |
| `devAction$`, `devReadAction$` | Event streams of the attached adapter (empty when none). | `DevStream` |
| `emitProxyMetrics` | Emit a `PROXY_METRICS` event (devtools must be enabled). | `() => void` |
| `destroy` | Release everything the store holds. Idempotent. | `() => void` |

`read`, `write`, `delete`, `prefetch`, `arrayOp`, `query`, `emitDevAction`, `cleanupPath`,
and `bindReactivity` also exist on the instance; they are host wiring used by the proxy and
are not intended for application code.

### Proxy Node Members

Every node of `store` (root, object, array, or leaf) has:

| Member | Purpose |
| --- | --- |
| `node()` | Reactive read of the path. Same as `node.$val`. |
| `node.$val` | Reactive read as a property. |
| `node.$signal` | The underlying Solid accessor, `() => T`. |
| `node.$subscribe(cb, options?)` | Subscribe to the path's value. Returns `{ unsubscribe, dispose }`. See the FAQ about `equals` on containers. |
| `node.$query`, `$queryOne`, `$liveQuery`, `$liveQueryOne`, `$mutate`, `$pipe`, `$array` | The JSNQ and array operations, with a `$` prefix that can never collide with a data key. |
| `node.toJSON()`, `node.valueOf()` | Plain value, so `JSON.stringify(store.user)` works. |

Array nodes add `length`, `[index]`, the mutating and reading methods listed under
[Arrays](#arrays), and the bare aliases `mutate`, `pipe`, and `array`.

### `@adsq/solid-signal-store/jsnq`

Importing this entry registers the bridge as a side effect (declared in `sideEffects`).

| Export | Kind | Purpose | Signature |
| --- | --- | --- | --- |
| `solidJsnqBridge` | const | The bridge object used by stores. | `SolidJsnqBridge` |
| `registerSolidJsnqBridge` | function | Register the bridge on a host object (default `globalThis`). Runs once on import. | `(target?: unknown) => SolidJsnqBridge` |
| `applyPipelineMutation` | function | Apply operators to a value and return the new value. | `(ops, currentValue, options?: SolidPipelineOptions) => unknown` |
| `applyPipelineMutationDetailed` | function | Same, plus the affected leaf paths for precise wake. | `(ops, currentValue, options?) => DetailedMutationResult` |
| `createPipeline` | function | Build a JSNQ pipeline wrapper over a value. | `(currentValue, ops, options?) => PipelineWrapper` |

Types: `SolidJsnqBridge`, `SolidPipelineOptions` (`isRoot`, `path`, `bridgeErrorMode`,
`trackOperations`), `DetailedMutationResult` (`{ value, mutations: string[] | null }`).

### `@adsq/solid-signal-store/devtools`

| Export | Kind | Purpose | Signature |
| --- | --- | --- | --- |
| `createSolidDevtools` | function | Create a devtools adapter. | `() => SolidDevService` |
| `SolidDevService` | class | The adapter implementation: `action$`, `readAction$`, `emitAction`, `emitRead`, `emitProxyMetrics`, `destroy`. | `new SolidDevService()` |

Types: `SolidDevtoolsAdapter`, `DevStream<T>`, `DevToolsEvent`, `ProxyMetrics`.

### Wake Modes

`SolidWakeMode` is `'grained' | 'fine' | 'exact' | 'container' | 'parents' | 'leaf' | 'branch'`.
`grained`, `fine`, and `exact` dirty the exact path; the rest also dirty its parent chain.

## FAQ And Troubleshooting

### Nothing updates when I run under Node, SSR, or a test runner

Solid resolves to its server build unless the `browser` export condition is active, and
the server build does not re-run effects. Run reactive code with that condition, as this
repository's own tests do: `bun --conditions browser file.ts`, or add `browser` to
`resolve.conditions` in your bundler or test-runner configuration.

### `store.user.name === 'Ada'` is always false

A path without the call is a function (the proxy), not the value. `store.flag ? a : b` is
always `a`, and `store.user.name === 'Ada'` is always `false`. Call the leaf:
`store.user.name()`.

### The UI does not update after I edit a field of an object or array I read as a whole

In the default `grained` mode a write wakes the exact path that changed. A computation that
called `store.user()` or `store.services()` is woken when that container is replaced or
when an array method restructures it, not when a field inside it changes. Read the leaf
(`store.user.name()`, `store.services[i()].rps()`), or call `api.wakeUp('container')` so
that writes also wake their parents, or observe the container with `$subscribe` /
`$liveQuery`, which register interest in the whole branch.

### `<For each={store.list()}>` does not show a replaced item

`store.list[1] = item` writes `list.1`, which the array node does not observe in `grained`
mode. Use `store.list.splice(1, 1, item)`, the fluent chain (`store.list.array().update(1,
item)`), or bind through the index. `push`, `pop`, `shift`, `unshift`, `splice`, `sort`,
`reverse`, and assigning a whole array do wake the array node.

### `$subscribe` on an object or array fires once and then stays silent

The subscription compares values with `Object.is`, and an object or array edited in place is
the same reference. Pass `{ equals: () => false }` to be notified on every wake:
`store.list.$subscribe(cb, { equals: () => false })`. `$liveQuery` results are new arrays
and are not affected.

### `mutate` / `$query` throws "requires the optional JSNQ bridge"

Import the entry once during bootstrap: `import '@adsq/solid-signal-store/jsnq'`, or pass
`{ jsnqBridge }` to `createSolidStore`.

### `store.user.name = 'Ada'` is a TypeScript error

See [TypeScript](#typescript): use `api.setValue`, a typed write view, or an untyped store.
Also check that the state type is a `type` alias and not an `interface`.

### `store.list.reduce(...)` does not return the reduced value

Only the array methods listed under [Arrays](#arrays) are proxied. Any other name is treated
as a child path, so `store.list.reduce(fn)` ignores `fn` and returns the native
`Array.prototype.reduce` function, and the path it creates can make a later whole-array write
(`sort`, assignment) throw. Use the native method on the array value:
`store.list().reduce(...)`.

### A key called `filter`, `length`, `query`, or `mutate` cannot be read

Those names are reserved on every node (see [Reserved Names](#reserved-names)). Rename the
key, or read it with `api.readStore('filter')` when you do not need reactivity.

### I mutated `store.user()` and nothing updated

Reads return the store's own objects, not copies, and mutating one bypasses the wake. Write
through the proxy (`store.user.name = ...`) or `api.setValue`.

### My named store disappeared, or two stores share a name

Registering a second store under an existing name destroys the first. Give every store a
unique name, and keep the `api` reference you created instead of looking it up on every
call. `useSolidStore(name)` throws for an unknown name; use `waitForStore` across an async
boundary.

### Live queries and subscriptions keep running

`$liveQuery` registers interest in its branch until `dispose()` is called, and a
`$subscribe` or `select().subscribe()` runs until `unsubscribe()`. Release them with
`onCleanup` in components, and call `api.destroy()` when the store itself goes away.

## Compatibility

| Requirement | Supported |
| --- | --- |
| `solid-js` | `>=1.8.0 <2.0.0` (peer). Developed and tested against 1.9.14. Solid 2 is not supported. |
| `@adsq/jsnq` | `^0.1.0` (peer). |
| TypeScript | Declarations are bundled. Developed with TypeScript 5.4+. |
| Module format | ESM only (`"type": "module"`); there is no CommonJS build. |
| Language level | Built to ES2022. Needs `Proxy` and `WeakRef`; `FinalizationRegistry` is used when present. |
| Runtimes exercised | Bun 1.3 (contract tests and benchmarks) and Chromium via Playwright (browser demo). Node is not part of the automated suites. |

## Use With AI Coding Agents

The package ships a `SKILL.md` written in the [Agent Skills](https://agentskills.io)
format, covering the architecture rule, the JSX rules, batching, wake modes, and JSNQ.
Install it so an agent applies the store correctly instead of guessing at the proxy API:

```sh
# this project only
mkdir -p .claude/skills/solid-signal-store
cp node_modules/@adsq/solid-signal-store/SKILL.md .claude/skills/solid-signal-store/

# or for every project
mkdir -p ~/.claude/skills/solid-signal-store
cp node_modules/@adsq/solid-signal-store/SKILL.md ~/.claude/skills/solid-signal-store/
```

Claude Code picks the skill up without a restart and loads it when the task involves this
store. Agents that do not read `.claude/skills/` can be pointed at
`node_modules/@adsq/solid-signal-store/SKILL.md` directly. Contributors working in this
repository should also read [`AGENTS.md`](./AGENTS.md).

## Verify

```sh
bun install
bun run typecheck
bun run test          # contract suites
bun run build
bun run demo:install
bun run dev           # browser demo: Store, Design, and Dashboard views
bun run install:browsers && bun run test:browser   # Playwright against the demo
```

## Bundle Size

Measured from the built ESM (`bun run build`) with esbuild minification, as of version
0.1.5. `solid-js` and `@adsq/jsnq` remain external peers. 1 kB is 1,000 bytes.

| Entry | Minified | Gzip | Brotli |
| --- | ---: | ---: | ---: |
| Store core (`@adsq/solid-signal-store`) | 26.4 kB | 8.8 kB | 8.0 kB |
| Optional JSNQ bridge (`/jsnq`) | 1.9 kB | 0.9 kB | 0.8 kB |
| Optional devtools (`/devtools`) | 0.8 kB | 0.4 kB | 0.4 kB |

The production browser demo, including Solid and the JSNQ operators it uses, is 58.4 kB
minified and 19.1 kB gzip (`bun run browser-demo:build`). To reproduce an entry:

```sh
bun run build
npx esbuild dist/index.js --bundle --minify --format=esm \
  --external:solid-js --external:@adsq/jsnq --external:'@adsq/jsnq/*' | gzip -9 | wc -c
```

## License

MIT
