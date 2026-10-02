# AGENTS.md

Guidance for AI coding agents working in this repository. Human contributors should start
from `README.md`.

## What this package is

`@adsq/solid-signal-store` — a SolidJS reactive store built on a callable nested proxy.
Reading a path (`store.user.name()`) subscribes the caller to that exact path; assigning to
it (`store.user.name = 'Ada'`) wakes only that path's consumers.

**The full API reference for agents lives in [`SKILL.md`](./SKILL.md)** — read it before
writing code that uses the store. It is written in the [Agent Skills](https://agentskills.io)
format and covers the architecture rule, the JSX rules, batching, wake modes, and JSNQ.
Consumers of the published package can install it as a skill; see the README section
"Use With AI Coding Agents".

## Repository layout

- `src/core/` — `SolidStore.ts` (the class, root commit, dev lifecycle), `registry.ts` (named
  stores, `waitForStore`, `useSolidStore`), `store-jsnq.ts` (mutate / pipe / queries / live
  queries), `dev-service.ts` (devtools contract, bus and adapter), `rx-interop.ts`, `types.ts`.
- `src/proxy/` — the callable nested proxy: `solid-proxy.ts` (`createSolidProxy`, node
  creation), `proxy-handler.ts` (get/set/delete traps), `node-keys.ts` (special-key and
  dispatch tables, consulted only after a child-cache miss), `wake-engine.ts` (signals and
  wake modes), `signal-trie.ts`, `types.ts`.
- `src/array/` — array method dispatch (`array-ops.ts`), the fluent chain (`array-chain.ts`)
  and the `solid-array.ts` barrel.
- `src/internal/` — `path.ts` (path parsing; also published as `InternalPath`) and `util.ts`
  (shared guards, bounded cache, mutation-result builders).
- `src/jsnq/solid-pipeline-bridge.ts` — the optional JSNQ integration. The engine itself
  is the separate `@adsq/jsnq` package; do not vendor or fork it here.
- `test/` — contract tests; `test/browser/` — Playwright specs.
- `examples/browser-demo/` — a real Vite + Solid app that the Playwright suite drives.

## Working rules

- **`dist/` is generated and git-ignored.** Never edit it and never commit it. `prepack`
  builds it for npm.
- **Do not reach into `@adsq/jsnq` internals.** Use its documented entries only.
- **Keep the demo in sync.** `examples/browser-demo` is not decoration — the browser tests
  assert against it, so an API change usually means updating it too.
- Match the surrounding code: no new dependencies, no framework fighting, no duplicated
  path logic (`src/internal/path.ts` is the single source of truth for path parsing;
  `src/utils/path-utils.ts` is only a frozen facade over it).

## Verify before proposing a change

```sh
bun run typecheck
bun run test          # all contract suites (see the `test` script)
bun run build
bun run test:browser  # Playwright against the real demo
```

All four must pass. Notes:

- The reactive contract suites run with `bun --conditions browser`. Without the `browser` export
  condition Solid resolves its server build, which does not re-run effects, so reactive
  assertions would silently never fire.
- `test:browser` needs Playwright's browsers once: `bun run install:browsers`. The demo
  dev server listens on port 5174.
- Benchmarks (`bun run bench:store`, `bun run bench:native`) are noisy on a shared machine;
  only publish numbers you measured yourself, with the machine and command.

## Documentation

`README.md`, `SKILL.md` and `examples/browser-demo/README.md` describe the public API as
exported from `src/index.ts`, `src/jsnq.ts` and `src/devtools.ts`. Keep their code samples
compiling: on a typed store, direct assignment (`store.user.name = 'Ada'`) is a type error,
so samples assign through `api.setValue` or a cast write view instead. When a public
signature changes, update the docs and the API reference table in the same change.
