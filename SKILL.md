---
name: solid-signal-store
description: Use @adsq/solid-signal-store to build SolidJS state as a callable nested proxy — reads like store.user.name(), writes like store.user.name = 'Ada', with fine-grained per-path wake and JSNQ queries over arrays. Use when writing or reviewing Solid components, JSX, or stores in a project that depends on @adsq/solid-signal-store, and when building live-editing UIs such as slider-driven design tools.
---

# @adsq/solid-signal-store

A reactive store for SolidJS built on a callable nested proxy. Reading a path returns its
value and subscribes the caller to that exact path; assigning to it writes and wakes only
the consumers of that path. There are no actions, reducers, or setter functions.

Install: `npm install solid-js @adsq/solid-signal-store @adsq/jsnq`. `solid-js` and
`@adsq/jsnq` are peer dependencies (Solid `>=1.8 <2`). The package is ESM only.

## The architecture rule — read this first

**Build the entire application on the store, with no native signals of your own.** Do not
create `createSignal()` copies of data that already lives in the store, and do not keep a
parallel signal alongside a store path. A copy is a second source of truth: the store write
updates the proxy, the copy keeps the stale value, and the UI desyncs in a way that is hard
to trace.

State goes in the store. JSX reads the store. Handlers assign to the store. That is the
whole loop. If a component needs derived data, use `createMemo` that *reads store paths* —
never one that captures a snapshot once.

<!-- check: prelude -->
```ts
import { createMemo, createRoot, createSignal } from 'solid-js';

// WRONG — a second source of truth that will drift
const [name] = createSignal(store.user.name());

// RIGHT — derives from the store on every read
const greeting = createRoot(() => createMemo(() => `Hello ${store.user.name()}`));

write.user.name = 'Ada';
name();                    // => 'Ann'
greeting();                // => 'Hello Ada'
```

## Where this store is a particularly good fit

Live-editing interfaces where many small values change continuously and each one drives a
different piece of the DOM — **design tools whose sliders modify appearance and style in
real time**. A slider bound to `store.design.card.radius` wakes only the bindings that read
that path, so dragging it does not re-render the rest of the editor. The same applies to
theme editors, layout inspectors, and property panels: dozens of independent numeric
inputs, each with its own narrow set of consumers.

## Creating a store

Create each store once, at module scope, and import it where it is used. Never create a
store inside a component body.

<!-- check: typecheck -->
```ts
import { createSolidStore } from '@adsq/solid-signal-store';

type State = {
  user: { name: string; tags: string[] };
  dashboard: { tiles: number };
  services: { name: string; rps: number }[];
};

export const api = createSolidStore<State>({
  user: { name: 'Ann', tags: ['admin'] },
  dashboard: { tiles: 12 },
  services: [{ name: 'api', rps: 120 }],
}, 'app');

export const store = api.store;                  // reads: store.user.name()
export const write = store as unknown as State;  // typed writes: write.user.name = 'Ada'
```

Use a `type` alias for the state (an `interface` does not satisfy the
`Record<string, unknown>` constraint). Store names are global: creating a store under a name
that is already registered **destroys the previous store**, so keep names unique.

When a module owns the `api`/`store` reference, use it directly. `waitForStore` is only for
a separately loaded consumer that may run before the owner creates the named store:

<!-- check: typecheck -->
```ts
import { useSolidStore, waitForStore } from '@adsq/solid-signal-store';

const app = await waitForStore<{ tiles: number }>('app', { timeoutMs: 5_000 });
const same = useSolidStore('app'); // synchronous; throws when missing
```

`api` also carries `batch`, `wakeUp`, `setValue`, `readStore`, `mutate`, `select`,
`computedOf`, `array`, `destroy`, `attachDevtools`, and `enableDevTools`.

## Reading and writing

<!-- check: prelude -->
```ts
store.user.name();                                     // => 'Ann'
write.user.name = 'Ada';
write.dashboard.tiles = store.dashboard.tiles() + 1;
write.user.tags.push('maintainer');
store.user.tags.pop();                                 // => 'maintainer'
write.user.preferences.theme = 'dark';                 // dynamic key under an index signature
store.user.preferences.theme();                        // => 'dark'
write.user.preferences.theme = undefined;              // assigning undefined deletes the key
store.dashboard.tiles();                               // => 13
```

**TypeScript rejects `store.user.name = 'Ada'`** on a typed store (the property type is the
accessor). In JavaScript, or on an `any`-typed store, direct assignment works. In typed code
assign through the cast write view above, or use `api.setValue('user.name', 'Ada')`. Never
*read* through the write view. Declare optional fields or an index signature when a key is
not in the initial state.

Reads return the store's own objects, not copies: never mutate the result of `store.user()`.

## In JSX

<!-- check: prelude, ssr=Dashboard contains=Ann|12|admin|api|120|samples -->
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

      <For each={store.services()}>{(service, i) =>
        <div class="row">
          <strong>{service.name}</strong>
          <span>{store.services[i()].rps()}</span>
        </div>
      }</For>

      <span>{store.history.length} samples</span>

      <button onClick={() => { write.dashboard.tiles = store.dashboard.tiles() + 1; }}>
        Add tile
      </button>
    </>
  );
}
```

Four rules cover every component:

1. **A leaf is called.** `{store.user.name()}`. The call *is* the reactive read, so Solid
   updates only the text node bound to that path. A path without the call is a function
   object: `store.flag ? a : b` is always `a`, and `store.user.name === 'Ada'` is always false.
2. **An array is called to iterate it, and each item is a plain value.** Write
   `<For each={store.services()}>` and then `{service.name}` — **no parentheses on the
   item**. Items are snapshots, not nested accessors. This is the most common mistake.
3. **A field that changes over time is read through its index.** The array node wakes on
   push, pop, shift, unshift, splice, sort, reverse and whole-array assignment, not when a
   field of one item is edited or one item is replaced by index. Bind the leaf:
   `store.services[i()].rps()`, or
   `store.board.rows[rowIndex()].cells[colIndex()].value()` for nested collections.
4. **`length` is reactive without a call.** `{store.history.length}` tracks pushes and pops
   without materialising the array.

The same reasoning applies to any container: in the default `grained` mode a memo or effect
that reads `store.user()` is not woken by `store.user.name = ...`. Read the leaves you need.

## Batching and wake modes

<!-- check: prelude -->
```ts
api.batch(() => {
  write.user.name = 'Ada';
  write.dashboard.tiles = 16;
});

api.wakeUp('grained');              // default mode for subsequent writes
api.wakeUp('container');            // parent-chain mode for subsequent writes
api.wakeUp('user.name', 'grained'); // wake exactly this path now
api.wakeUp('user.name', 'leaf');    // wake this path and its parent chain now
```

| Mode | Paths dirtied | Use |
| --- | --- | --- |
| `grained` | Exact changed path only | Default and fastest. |
| `leaf` | Exact path plus parent chain | For effects/memos consuming a container. |

`fine` and `exact` alias `grained`; `container`, `parents`, and `branch` alias `leaf`. The
one-argument form changes the default; the two-argument form is a one-off targeted wake. The
default can also be set at creation with `{ wakeParentsOnChange: true }`.

Writes inside `batch()` stay synchronous and immediately readable; Solid flushes effects
once after the outermost batch. A single write needs no batch. The store option
`preciseMutationWake: true` lets eligible flat JSNQ mutations wake only the changed branch,
item, and leaf; deep or structural mutations fall back to a branch commit.

## Arrays

Proxied array methods: `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`
(mutating) and `filter`, `map`, `find`, `findIndex`, `some`, `every`, `includes`,
`indexOf`, `length` (reading). Anything else (`reduce`, `forEach`, `slice`) is **not**
proxied and silently return the wrong value: call the array first,
`store.list().reduce(...)`. `store.list.array()` (or
`api.array('list')`) returns a chainable copy-and-commit helper with `update(i, v)`,
`updateByFind`, `delete`, `deleteByIndex`, and predicate-or-value lookups.

## Queries and bulk mutations (JSNQ)

The core proxy does not import the JSNQ bridge. Import it once, during bootstrap, in an
application that calls `mutate`, `$query`, or `$liveQuery` — otherwise those calls throw an
actionable error:

<!-- check: prelude -->
```ts
import '@adsq/solid-signal-store/jsnq';
import where from '@adsq/jsnq/operators/where';
import update from '@adsq/jsnq/operators/update';

store.userList.mutate(
  where('active', '===', true),
  update('score', (score: number) => score + 1),
);

const active = store.userList.$query(where('active', '===', true));      // snapshot (unknown[])
const one = store.userList.$queryOne(where('id', '===', 2));             // first match or null
const live = store.userList.$liveQuery(where('active', '===', true));    // callable accessor

live();                                    // read inside a Solid owner
const sub = live.subscribe((users) => users.length);   // optional subscription
sub.unsubscribe();
live.dispose();

active.length;                             // => 1
```

`$query` / `$queryOne` are snapshots. `$liveQuery` / `$liveQueryOne` recompute when any
descendant of the queried branch changes. A live query registers branch interest when it is
created and only `dispose()` releases it, so inside a component call
`onCleanup(() => live.dispose())`.

## Derived values and subscriptions

`createMemo(() => ...)` over store reads is the default. `api.computedOf((s) => ...)` is the
same memo scoped to the store, and `api.select((s) => ...)` returns `{ subscribe, value }`
for a push subscription. `node.$subscribe(cb)` observes a path: on an object or array it fires
for any change beneath it, and a primitive leaf fires only when its value changes. Pass
`{ equals }` to override the comparison.

## Devtools and cleanup

<!-- check: prelude, typecheck -->
```ts
if (import.meta.env.DEV) {
  const { createSolidDevtools } = await import('@adsq/solid-signal-store/devtools');
  api.attachDevtools(createSolidDevtools());
  api.enableDevTools('app');
}

api.destroy(); // idempotent; clears caches, subscriptions, and the devtools adapter
```

## Pitfalls that are easy to hit

- Do not use a state key named like the API: `length`, `filter`, `map`, `find`, `push`,
  `mutate`, `pipe`, `array`, `select`, `query`, `computedOf`, `toJSON`, `valueOf`, or one
  that starts with `$`. Property access on those names reaches the API, not your data.
- At the store root, `batch`, `wakeUp`, `setValue`, `readStore`, and `deleteValue` are also
  reserved names.
- Under Node, SSR, or a test runner Solid resolves its server build, which does not re-run
  effects. Enable the `browser` export condition (`bun --conditions browser`, or
  `resolve.conditions`) when testing reactive behaviour.
- Solid 2 is not supported (`solid-js >=1.8 <2`).

## Checklist when writing code against this store

- Never mirror store data into `createSignal`; read the store path instead.
- Create stores once at module scope with a unique name.
- Call leaves (`path()`), do not call loop items (`item.field`); bind changing item fields
  through the index (`store.list[i()].field()`).
- In TypeScript, assign through a typed write view or `api.setValue`, never read through it.
- Import `@adsq/solid-signal-store/jsnq` once before using `mutate` / `$query`.
- Reach for `api.batch()` only when several writes must land as one update.
- Dispose live queries and subscriptions you create; use `onCleanup` in components.
- Do not import from `dist/` or deep internal paths; use the documented entries only.
