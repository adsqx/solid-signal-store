# Browser Demo

A runnable Vite + Solid app for `@adsq/solid-signal-store`. It imports the library source
through the same public entry names a consumer uses (`@adsq/solid-signal-store`,
`@adsq/solid-signal-store/jsnq`, `@adsq/solid-signal-store/devtools`); `vite.config.ts`
aliases that name to `../../src`, so edits to the library show up immediately.

The Playwright suite in [`test/browser`](../../test/browser) drives this app. Its selectors,
labels, and behaviours are part of the test contract, so change them together.

## Run

From the repository root:

```sh
bun run demo:install   # installs the demo's own dependencies
bun run dev            # http://localhost:5174
```

Or from this directory: `bun install && bun run dev`. The dev server is pinned to port
5174, which `playwright.config.ts` also expects.

## What Each View Demonstrates

Source: [`src/index.tsx`](./src/index.tsx). Two stores exist: `app` (Store and Design views)
and `dashboard` (Dashboard view).

| View | What it shows | Where to look |
| --- | --- | --- |
| **Store** | A 10 x 16 board (160 cells). Left click increments `value` and `clicks` on that one cell, right click cycles its `color`. Each cell binds its own leaves (`store.board.rows[r].cells[c].value()`), so one click updates one cell's text nodes. | `StoreView`, `leftClick`, `rightClick` |
| **Store toolbar** | **Batch** toggles `api.batch()` around the multi-write click handlers. **Wake** switches `api.wakeUp('grained' \| 'container')`. **Mutate active users** runs a JSNQ `mutate(where(...), update(...))` on `store.users`. **Add dynamic key** assigns `store.runtime.lastAction`, a key that was not in the initial state. **Reset board** replaces the whole `store.board.rows` array and zeroes the counters. | `runBoardMutation`, `setWakeMode`, `mutateActiveUsers`, `addDynamicKey`, `resetBoard` |
| **Runtime events** | The `app` store's devtools stream (`onSolidDevAction`), for example `SET_VALUE: board.rows.0.cells.0.value`, printed as writes happen. | `onSolidDevAction` in `StoreView` |
| **Design** | Sliders, a text field, and colour pickers write straight into `store.design.componentA.*`; the preview reads those leaves into CSS custom properties. Dragging one slider updates only the bindings that read that path. | `DesignView` |
| **Dashboard** | A separately named store (`dashboard`) updated on a timer inside `api.batch()`: metric leaves, a per-service field, and a history array with `push` and `shift`. List rows bind changing fields through the index (`dashboard.services[i()].rps()`). `waitForStore` resolves the named store before the timer starts. | `DashboardView`, `App` |

The `app` store is created with `preciseMutationWake: true`, so the JSNQ mutation wakes only
the changed users' leaves plus the `users` branch. In development the demo also attaches
the devtools adapter from the `/devtools` entry (`import.meta.env.DEV`).

The demo store is typed loosely (`as any`) so that event handlers can use plain assignment
(`cell.value = cell.value() + 1`). In a typed application, assign through `api.setValue`
or a cast write view; see the TypeScript section of the root README.

## Extra Page: JSNQ Browser Benchmark

`/jsnq-browser-bench.html` (source: [`src/jsnq-bench.ts`](./src/jsnq-bench.ts)) runs flat
and deeply nested JSNQ operations against a real store in the browser and logs timings to
the console. Playwright waits for `document.title === 'jsnq-bench-complete'` and reads
`window.__JSNQ_BENCH_RESULTS`. The timings depend on the machine and are not published
figures.

## Build And Test

```sh
bun run browser-demo:build   # production build of the demo
bun run install:browsers     # once: Playwright browsers
bun run test:browser         # Playwright against the running demo
```

| Spec | Covers |
| --- | --- |
| `store-reactivity.spec.ts` "store board updates exact leaves..." | Board clicks in both wake modes with batching on and off, the JSNQ mutation, and the dynamic key. |
| `store-reactivity.spec.ts` "design controls write through nested proxy leaves" | Slider and text writes reaching the preview. |
| `store-reactivity.spec.ts` "named dashboard store remains reactive" | The timer-driven named store updating its metrics. |
| `jsnq-bench.spec.ts` | The benchmark page completes and reports results. |
