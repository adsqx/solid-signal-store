/**
 * SolidStore.ts — single central orchestrator (CreateStore + SignalStore parity).
 * Wires createSolidProxy + narrow StoreMutator. Real in-memory root.
 * Jsnq bridge dispatch for mutate/pipe (future solid-pipeline-bridge).
 * Full public surface, headless/vanilla, batch(), zero logic dupe (proxy/bridge own theirs).
 * Minimal and contract-driven: proxy identity, cursor prefetch, root key-diff, devtools event shapes, GC cleanup.
 */

import { batch, createMemo, type Accessor } from 'solid-js';
import {
  createSolidProxy,
  type SolidWakeMode,
  type StoreMutator,
  type SolidProxyOptions,
} from '../proxy/solid-proxy';
import { createArrayChain, ARRAY_QUERY_METHODS, ARRAY_MUTATION_METHODS, applyArrayMutation } from '../array/solid-array'; // top-level import + shared method sets + pure dispatch (no switches)
import {
  cloneJsonData,
  createJsonPathPlan,
  deleteJsonPath,
  readJsonPath,
  writeJsonPath,
  writeJsonPathValue,
  type JsonMutationResult,
} from '@adsq/jsnq/data-engine';
import { createProjectionObservable, type ProjectionObservableOptions } from './rx-interop';
import { isBranch } from '../internal/guards';
import { deleteResult, setResult, touchResult } from '../internal/mutation-results';
import { WAKE_MODE_BRANCH, isWakeMode } from '../internal/wake-modes';
import {
  EMPTY_DEV_STREAM,
  type DevStream,
  type DevToolsEvent as SolidDevToolsEvent,
  type SolidDevtoolsAdapter,
  type StoreDevToolsAction,
} from './devtools-contract';
import type { SolidJsnqBridge } from '../jsnq/solid-pipeline-bridge';
import type { SolidStoreProxy, SolidStoreReactivity, StoreLiveQuery } from './proxy-types';

// --- Minimal local contracts (no reliance on incomplete synced types) ---

/**
 * opinia5: reactive jsnq query handle. Callable for the current result, `.subscribe()` for a
 * push subscription (reuses the rx-interop projection observable), `.dispose()` to release the
 * per-query branch interest. Same `where(...)` DSL as `mutate`.
 */
export type SolidLiveQuery<T> = StoreLiveQuery<T>;

export interface SolidStoreOptions {
  strict?: {
    invalidPath?: boolean;
    deleteUndefined?: boolean;
    rootRxjs?: boolean;
  };

  /**
   * Controls whether changing a deep value also dirties parent signals on the path.
   *
   * - false (default): Fine-grained mode (recommended). Only the exact changed path is dirtied.
   *   Gives maximum Solid-native granularity and performance.
   *
   * - true: Container/wake-parents mode. Parents on the path are also dirtied.
   *   Useful if you have legacy code that expects parent memos/effects to fire on any deep change.
   */
  wakeParentsOnChange?: boolean;

  // future: dependencyMode, cloneStrategy etc for parity
  jsnqBridge?: SolidJsnqBridge;

  /**
   * How the jsnq bridge reacts to a mutation execution error.
   *  - 'warn' (default): log + safe no-op clone (historical behaviour, unchanged).
   *  - 'silent': safe no-op clone without logging.
   *  - 'throw': surface the real error (recommended in development).
   */
  bridgeErrorMode?: 'throw' | 'warn' | 'silent';

  /**
   * Fine-grained wake for `mutate()` (opt-in; default false = historical behaviour).
   *
   * When false, `mutate(path, where(...), update(...))` commits the whole branch
   * (waking every observed descendant of `path`). When true, for the flat
   * array + value-action shape the store wakes only the leaves that actually
   * changed (e.g. `users.0.profile.name`) plus the branch signal itself and any
   * branch subscribers ($liveQuery) — honoring the same `grained` axis used
   * everywhere else. Falls back to the branch commit for structural/deep ops.
   */
  preciseMutationWake?: boolean;

  /** Optional development-only event stream adapter from `solidstore/devtools`. */
  devtools?: SolidDevtoolsAdapter;

  /**
   * Internal test hook: invoked with the path on every signal-update CALL. Lets contract
   * tests prove wake *work* granularity without prototype hacks. Forwarded to SolidProxyOptions.
   */
  _onSignalUpdate?: (path: string) => void;
}

type DevListener = (e: StoreDevToolsAction & { storeName?: string }) => void;

// Global dev bus (parity with original DevToolsActionSubject / emit patterns)
const devListeners = new Set<DevListener>();
function emitDev(ev: StoreDevToolsAction & { storeName?: string }) {
  for (const fn of devListeners) {
    try { fn(ev); } catch { /* isolated */ }
  }
}
export function onSolidDevAction(fn: DevListener): () => void {
  devListeners.add(fn);
  return () => devListeners.delete(fn);
}

// Named store registry (useSolidStore + createStore(name) parity with SignalStore)
const registry = new Map<string, SolidStore<any>>();
type StoreWaiter = {
  resolve(store: SolidStore<any>): void;
  reject(error: Error): void;
  cleanup(): void;
};
const registryWaiters = new Map<string, Set<StoreWaiter>>();

export interface WaitForStoreOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function resolveRegistryWaiters(name: string, store: SolidStore<any>): void {
  const waiters = registryWaiters.get(name);
  if (!waiters) return;
  registryWaiters.delete(name);
  for (const waiter of waiters) {
    waiter.cleanup();
    waiter.resolve(store);
  }
}

// --- Orchestrator ---

export class SolidStore<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly store: SolidStoreProxy<T>; // the callable proxied reactive root (full surface via traps)
  private readonly data: T;
  private name: string;
  private readonly registryName: string;
  private devActive = false;
  private readonly opts: SolidStoreOptions;
  // Typed reactivity surface installed by createSolidProxy (replaces `(this as any).__wakeX`).
  private reactivity?: SolidStoreReactivity;
  // Typed wake-parents flag (read by the proxy manager's shouldWakeParents getter).
  _wakeParentsOnChange = false;
  private devService?: SolidDevtoolsAdapter;
  private destroyed = false;
  /** Action stream (subscribe for SET_VALUE/MUTATE/DELETE/PROXY_METRICS events). */
  get devAction$(): DevStream { return this.devService?.action$ ?? EMPTY_DEV_STREAM; }
  /** Read/history stream (excludes PROXY_METRICS, parity with Angular readAction$). */
  get devReadAction$(): DevStream { return this.devService?.readAction$ ?? EMPTY_DEV_STREAM; }

  /** Typed binding called by createSolidProxy so the store can wake proxy-owned signals. */
  bindReactivity(api: SolidStoreReactivity): void { this.reactivity = api; }

  constructor(initial: T, name = 'default', opts: SolidStoreOptions = {}) {
    this.name = name;
    this.registryName = name;
    this.opts = opts;
    this.devService = opts.devtools;
    this.data = this.#clone(initial ?? ({} as T));

    const mutator = this as unknown as StoreMutator;
    this._wakeParentsOnChange = opts.wakeParentsOnChange ?? false;

    const pOpts: SolidProxyOptions = {
      strictInvalidPath: opts.strict?.invalidPath,
      strictDeleteUndefined: opts.strict?.deleteUndefined,
      ...(opts._onSignalUpdate ? { _onSignalUpdate: opts._onSignalUpdate } : {}),
    };
    this.store = createSolidProxy<SolidStoreProxy<T>>(mutator, pOpts);

    registry.set(name, this);
    resolveRegistryWaiters(name, this);
  }

  // --- Path orchestration (delegates to unified internal primitives) ---
  // Eliminates previous inline duplication. Root (empty path) semantics preserved.
  // All core files (bridge, SolidStore, PathUtils, proxy) delegate to src/internal/path.ts
  // as the single source of truth (SST) for simple path logic.

  #clone(v: any): any {
    return cloneJsonData(v);
  }

  #get(p: string): unknown {
    return readJsonPath(this.data, p);
  }

  #set(p: string, v: unknown): JsonMutationResult {
    return writeJsonPath(this.data, p, v);
  }

  #setValueOnly(p: string, v: unknown): void {
    writeJsonPathValue(this.data, p, v);
  }

  #delete(p: string): JsonMutationResult {
    if (!p) {
      return deleteResult('', this.data, true, true);
    }
    return deleteJsonPath(this.data, p);
  }

  // Direct raw-data write + explicit signal wake + devtools emit. Replaces the previous
  // proxy-walk (`#proxyParent` + `node[last] = v`) which read/created proxy nodes during
  // commits — wasteful and a side-effect hazard. Mirrors Angular's `mutateStoreNormalized`
  // (#set + #wakeMutation) and the existing #commitPrecise pattern. `writeJsonPath` returns
  // the JsonMutationResult so the wake is identical to what the proxy set trap would do.
  #assign(p: string, v: unknown): void {
    if (!p) return;
    const result = this.#set(p, v);
    this.#wakeMutation(result);
    this.emitDevAction({ type: 'SET_VALUE', payload: { path: p, value: v } });
  }

  #wakeMutation(result: JsonMutationResult): void {
    this.reactivity?.wakeMutation(result);
  }

  #wakeMutations(results: JsonMutationResult[]): void {
    if (this.reactivity) {
      this.reactivity.wakeMutations(results);
      return;
    }
    for (const result of results) this.#wakeMutation(result);
  }

  // Root mutation special-case (key-diff + per-key delete) — required subtle contract.
  #commitRoot(next: any): void {
    const curr: any = this.data ?? {};
    const n = next ?? {};
    const keys = new Set<string>([...Object.keys(curr), ...Object.keys(n)]);
    batch(() => {
      const mutations: JsonMutationResult[] = [];
      for (const k of keys) {
        const existed = Object.prototype.hasOwnProperty.call(curr, k);
        const previous = curr[k];
        if (!(k in n)) {
          if (existed) delete curr[k];
          mutations.push(deleteResult(k, previous, existed, false));
          this.emitDevAction({ type: 'DELETE', payload: { path: k } });
        } else {
          curr[k] = n[k];
          mutations.push(setResult(k, previous, n[k], existed));
          this.emitDevAction({ type: 'SET_VALUE', payload: { path: k, value: n[k] } });
        }
      }
      this.#wakeMutations(mutations);
    });
  }

  #commit(p: string, v: unknown): void {
    if (!p) { this.#commitRoot(v); return; }
    this.#assign(p, v);
  }

  // Fine-grained mutate commit (opt-in): write the new branch value into data, then
  // wake only the changed leaves + the branch signal itself — NOT the whole subtree.
  // Branch subscribers ($liveQuery) still wake via the ancestor walk in wakeFromMutation.
  #commitPrecise(p: string, v: unknown, relPaths: readonly string[]): void {
    this.#setValueOnly(p, v); // data write only; no proxy branch-wide wake
    const results: JsonMutationResult[] = [];
    for (const rel of relPaths) {
      const leaf = `${p}.${rel}`;
      results.push(touchResult(leaf));
    }
    // Wake the branch signal so whole-array consumers refresh, without syncDescendants.
    results.push(touchResult(p));
    this.#wakeMutations(results);
    this.emitDevAction({ type: 'SET_VALUE', payload: { path: p, value: v } });
  }

  // === StoreMutator (exact contract wired to proxy) ===

  read(path: string): unknown { return this.#get(path ?? ''); }
  write(path: string, value: unknown): JsonMutationResult { return this.#set(path ?? '', value); }
  batch<T>(fn: () => T): T { return batch(fn); }
  delete(path: string): JsonMutationResult { return this.#delete(path ?? ''); }
  prefetch(pathPrefix: string): void { this.#get(pathPrefix ?? ''); /* warms for cursor/prefetch contract */ }
  emitDevAction(action: StoreDevToolsAction): void {
    if (!this.devActive) return;
    const event = { ...action, storeName: this.name } as SolidDevToolsEvent;
    // Per-store typed stream (parity with Angular DevService.action$ / readAction$).
    this.devService?.emitAction(event);
    if (action.type !== 'PROXY_METRICS') this.devService?.emitRead(event);
    // Legacy global bus kept for back-compat (onSolidDevAction public API).
    queueMicrotask(() => emitDev(event));
  }
  cleanupPath(path: string): void {
    this.emitDevAction({ type: 'CLEANUP', payload: { path, cleanedPaths: [path], cleanedCount: 1 } });
  }

  // === Extra surface (called by proxy traps on sub/root + public API) ===

  readStore(path = ''): unknown { return this.read(path); }
  setValue(path: string, value: unknown): void { this.#assign(path ?? '', value); }
  deleteValue(path: string): void {
    if (!path) return;
    const result = this.#delete(path);
    this.#wakeMutation(result);
    this.emitDevAction({ type: 'DELETE', payload: { path } });
  }

  // Uses shared constants from array layer (single source of truth: array/array-ops.ts)
  private isArrayQueryMethod(m: string): boolean {
    return ARRAY_QUERY_METHODS.has(m);
  }
  private isArrayMutationMethod(m: string): boolean {
    return ARRAY_MUTATION_METHODS.has(m);
  }

  // Direct array method dispatch from proxy (store.users.push etc.)
  arrayOp(path: string, method: string, args: unknown[] = [], current?: unknown): unknown {
    const cur = Array.isArray(current) ? current : this.#get(path);
    if (!Array.isArray(cur)) return undefined;

    // Query-only fast path (no mutation, no COW)
    if (this.isArrayQueryMethod(method)) {
      if (method === 'length') return cur.length;
      return (cur as any)[method](...(args as any));
    }

    // opinia3 #2: precise tail-only mutation result for push/pop. These never reindex existing
    // elements, so we wake only the array signal + the inserted/removed tail index — NOT every
    // observed element signal (which the conservative branch-replace path below would). All other
    // methods (splice/shift/unshift/sort/reverse/…) reindex and keep the proven path unchanged.
    const precise = this.#tryPreciseTailArrayOp(path, cur, method, args);
    if (precise) return precise.result;

    // opinia6 (unify): precise splice. When preciseMutationWake is on, splice(start>0) wakes only
    // element signals at index >= start (skips the untouched [0,start) prefix), mirroring Angular's
    // computeSpliceInvalidationStart at the signal level. push/pop are already precise above;
    // shift/unshift/reverse/sort touch index 0 (no prefix to skip) and keep the proven branch path.
    if (this.opts.preciseMutationWake && method === 'splice') {
      const spliced = this.#tryPreciseSplice(path, cur, args);
      if (spliced) return spliced.result;
    }

    const arr = [...cur];
    const r = applyArrayMutation(arr, method, args);
    if (r !== undefined || this.isArrayMutationMethod(method)) {
      this.batch(() => this.#assign(path, arr));
    }
    return r;
  }

  // Returns a boxed result when handled (push/pop), or null to fall through to the generic path.
  #tryPreciseTailArrayOp(path: string, cur: unknown[], method: string, args: unknown[]): { result: unknown } | null {
    // Note: the proxy's array-method handler already emits the ARRAY_DISPATCH dev event before
    // calling arrayOp, so we must NOT emit it again here (would double-log push/pop). (self-review)
    if (method === 'push') {
      // Native push() with no args returns length and changes nothing.
      if (args.length === 0) return { result: cur.length };
      const startIndex = cur.length;
      const nextLength = args.length === 1 ? cur.push(args[0]) : cur.push(...args);
      this.batch(() => {
        for (let i = 0; i < args.length; i++) {
          this.reactivity?.wakeArrayTail(path, startIndex + i, isBranch(args[i]));
        }
      });
      return { result: nextLength };
    }
    if (method === 'pop') {
      if (cur.length === 0) return { result: undefined };
      const lastIndex = cur.length - 1;
      const popped = cur.pop();
      this.batch(() => {
        this.reactivity?.wakeArrayTail(path, lastIndex, isBranch(popped));
      });
      return { result: popped };
    }
    return null;
  }

  // Precise splice (opt-in): COW + data write, then wake only signals at index >= start.
  // Returns boxed removed[] when handled, or null to fall through to the proven branch path
  // (container mode, or start<=0 where the whole array shifts and there is no prefix to skip).
  #tryPreciseSplice(path: string, cur: unknown[], args: unknown[]): { result: unknown } | null {
    // Container mode wakes ancestors too — keep the proven full-branch path for byte parity.
    if (this._wakeParentsOnChange) return null;
    const len = cur.length;
    const rawStart = Number(args[0] ?? 0);
    const start = rawStart < 0 ? Math.max(len + rawStart, 0) : Math.min(rawStart, len);
    if (start <= 0) return null; // no untouched prefix to skip
    const next = [...cur];
    const removed = applyArrayMutation(next, 'splice', args);
    this.#setValueOnly(path, next);
    this.batch(() => {
      this.reactivity?.wakeArraySplice(path, start);
    });
    return { result: removed };
  }

  // query dispatch from proxy (array query surface parity)
  query(path: string, val: unknown, method: string, ...args: unknown[]): unknown {
    const cur = this.#get(path);
    if (!Array.isArray(cur)) return method === 'length' ? 0 : undefined;
    if (method === 'length') return cur.length;
    return (cur as any)[method]?.(val, ...args);
  }

  // === Bridge access (extracted — removes repeated globalThis lookup + warn-once logic)
  private getJsnqBridge(): any {
    return this.opts.jsnqBridge || (globalThis as any).__SOLID_PIPELINE_BRIDGE || (globalThis as any).solidJsnqBridge;
  }

  private requireJsnqBridge(operation: string): SolidJsnqBridge {
    const bridge = this.getJsnqBridge();
    if (bridge) return bridge;
    throw new Error(
      `[SolidStore] ${operation} requires the optional JSNQ bridge. ` +
      `Import '@adsq/solid-signal-store/jsnq' once or pass { jsnqBridge } to createSolidStore().`
    );
  }

  // Jsnq bridge dispatch (mutate/pipe) — exact future contract, no dupe of pipeline
  mutate(path: string, ...ops: any[]): unknown {
    const p = path ?? '';
    const current = this.readStore(p);
    if (current === undefined) return undefined;

    this.emitDevAction({ type: 'MUTATE', payload: { path: p, opCount: ops.length } });

    let result: unknown = current;
    const hasMutationOps = ops.some((op) => !!op?.__isMutation);
    this.batch(() => {
      // Contract: applyPipelineMutation(ops, currentValue, { isRoot, path })
      // Bridge owns COW + stats; we only do the commit here.
      const bridge = ops.length > 0 ? this.requireJsnqBridge('mutate()') : this.getJsnqBridge();
      let bridgeApplied = false;
      if (bridge?.applyPipelineMutation) {
        // Opt-in fine-grained wake for sub-path branches (flat value-action shape only).
        if (this.opts.preciseMutationWake && p && bridge.applyPipelineMutationDetailed) {
          const detailed = bridge.applyPipelineMutationDetailed(ops, current, {
            isRoot: false,
            path: p,
            bridgeErrorMode: this.opts.bridgeErrorMode,
            trackOperations: this.devActive,
          });
          result = detailed.value;
          if (detailed.mutations && detailed.mutations.length > 0) {
            this.#commitPrecise(p, result, detailed.mutations);
            return;
          }
          // Not precise-eligible (or zero matches): fall back to the standard branch commit.
          if (hasMutationOps || result !== current) this.#commit(p, result);
          return;
        }
        result = bridge.applyPipelineMutation(ops, current, {
          isRoot: !p,
          path: p,
          bridgeErrorMode: this.opts.bridgeErrorMode,
          trackOperations: this.devActive,
        });
        bridgeApplied = true;
      }
      if (bridgeApplied && (hasMutationOps || result !== current)) this.#commit(p, result);
    });
    return result;
  }

  pipe(path: string, ...ops: any[]): any {
    const p = path ?? '';
    const current = this.readStore(p);
    const bridge = this.getJsnqBridge();
    if (bridge?.createPipeline) {
      return bridge.createPipeline(current, ops, { path: p, trackOperations: this.devActive });
    }
    if (ops.length > 0) this.requireJsnqBridge('pipe()');
    // No-op builder is useful for reading an unfiltered branch without JSNQ.
    return {
      all: () => (Array.isArray(current) ? [...current] : current),
      first: () => (Array.isArray(current) ? current[0] : current),
      count: () => (Array.isArray(current) ? current.length : current != null ? 1 : 0),
    };
  }

  // === opinia5: jsnq-powered reads — same where(...) DSL as mutate, for read + subscribe ===

  /** One-shot snapshot query: runs the jsnq operators at `path`, returns matched values. */
  $query(path: string, ...ops: any[]): unknown[] {
    return this.#runJsnqQuery(path ?? '', ops, 'all') as unknown[];
  }

  /** One-shot snapshot query returning the first match (or null). */
  $queryOne(path: string, ...ops: any[]): unknown {
    return this.#runJsnqQuery(path ?? '', ops, 'first');
  }

  /** Reactive query: recomputes when the queried branch changes. Callable + subscribable. */
  $liveQuery(path: string, ...ops: any[]): SolidLiveQuery<unknown[]> {
    return this.#createLiveQuery(path ?? '', ops, 'all') as SolidLiveQuery<unknown[]>;
  }

  /** Reactive single-match query (first match, reactive). */
  $liveQueryOne(path: string, ...ops: any[]): SolidLiveQuery<unknown> {
    return this.#createLiveQuery(path ?? '', ops, 'first');
  }

  #runJsnqQuery(path: string, ops: any[], mode: 'all' | 'first'): unknown {
    const snapshot = this.readStore(path);
    const bridge = this.getJsnqBridge();
    if (bridge?.createPipeline && ops.length > 0) {
      const wrapper = bridge.createPipeline(snapshot, ops, { path, trackOperations: this.devActive });
      if (mode === 'first') {
        return wrapper.execute('first') ?? null;
      }
      const nodes = wrapper.execute('all');
      return Array.isArray(nodes)
        ? nodes.map((n: any) => (n && typeof n === 'object' && 'data' in n ? n.data : n))
        : [];
    }
    if (ops.length > 0) this.requireJsnqBridge(mode === 'first' ? '$queryOne()' : '$query()');
    // No operators (or no bridge): return the raw branch (array as-is / first element / value).
    if (mode === 'first') return Array.isArray(snapshot) ? (snapshot[0] ?? null) : (snapshot ?? null);
    if (Array.isArray(snapshot)) return [...snapshot];
    return snapshot == null ? [] : [snapshot];
  }

  // Read the Solid signal for `path` so the enclosing memo depends on it (live recompute source).
  #trackBranch(path: string): void {
    const node: any = this.#resolveProxyNode(path);
    if (typeof node === 'function') node();
  }

  #resolveProxyNode(path: string): unknown {
    if (!path) return this.store;
    const plan = createJsonPathPlan(path);
    let node: any = this.store;
    for (const seg of plan.segments) {
      if (node == null) return undefined;
      node = node[seg];
    }
    return node;
  }

  #createLiveQuery(path: string, ops: any[], mode: 'all' | 'first'): SolidLiveQuery<unknown> {
    const p = path ?? '';
    const addBranch = (p: string) => this.reactivity?.addBranchSub(p);
    const removeBranch = (p: string) => this.reactivity?.removeBranchSub(p);
    addBranch(p); // creation ref — keeps the accessor reactive until the query is disposed
    let creationReleased = false;
    const releaseCreation = () => {
      if (creationReleased) return;
      creationReleased = true;
      removeBranch(p);
    };
    const acc = createMemo(() => {
      this.#trackBranch(p);
      return this.#runJsnqQuery(p, ops, mode);
    });
    const live = (() => acc()) as SolidLiveQuery<unknown>;
    live.subscribe = (cb: (value: unknown) => void, options?: ProjectionObservableOptions<unknown>) => {
      addBranch?.(p); // subscription ref (ref-counted with the creation ref + other subs)
      const sub = createProjectionObservable(acc, options).subscribe(cb);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        sub.unsubscribe();
        removeBranch?.(p);  // release this subscription's ref
        releaseCreation();  // and the creation ref, so inline `$liveQuery(...).subscribe()` fully cleans up
      };
      return { unsubscribe: close, dispose: close };
    };
    live.dispose = releaseCreation;
    return live;
  }

  // Fluent array entry — top-level wiring to the dedicated array layer.
  array(path: string, ...args: any[]): any {
    const p = path || (args[0] ?? '');
    return createArrayChain(p, {
      read: (pp: string) => this.read(pp),
      commit: (pp: string, val: unknown) => this.#assign(pp, val),
      batch: (fn: () => void) => this.batch(fn),
    });
  }

  // select / computedOf — computedOf is deliberately 3 lines (PLAN rule)
  select<TOut>(project: (state: SolidStoreProxy<T>) => TOut, options?: ProjectionObservableOptions<TOut>) {
    const acc = this.computedOf(project);
    return createProjectionObservable(acc, options);
  }

  computedOf<TOut>(project: (state: SolidStoreProxy<T>) => TOut): Accessor<TOut> {
    // Automatic fine-grained tracking: project runs against callable proxy.
    return createMemo(() => project(this.store));
  }

  // Devtools + lifecycle (parity)
  enableDevTools(storeName?: string, _showVisualizer = true): void {
    this.devActive = true;
    if (storeName) this.name = storeName;
    this.emitDevAction({ type: 'DEVTOOLS_ENABLED', payload: { storeName: this.name } });
  }

  attachDevtools(devtools: SolidDevtoolsAdapter): void {
    if (this.devService === devtools) return;
    this.devService?.destroy();
    this.devService = devtools;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.batch(() => {
      Object.keys(this.data ?? {}).forEach((k) => this.cleanupPath(k));
    });
    if (registry.get(this.registryName) === this) registry.delete(this.registryName);
    this.emitDevAction({ type: 'STORE_DESTROYED', payload: { storeName: this.name } });
    this.devActive = false;
    this.reactivity?.destroy();
    this.reactivity = undefined;
    this.devService?.destroy();
    this.devService = undefined;
  }

  /**
   * Emit a PROXY_METRICS snapshot (signals / proxies / branchSubs sizes). Parity with
   * Angular's emitProxyMetrics. Only fires when devtools is active. Throttling is the
   * caller's responsibility (matching Angular's metricsThrottleMs).
   */
  emitProxyMetrics(): void {
    if (!this.devActive) return;
    const metrics = this.reactivity?.getProxyMetrics?.();
    if (!metrics) return;
    this.devService?.emitProxyMetrics(this.name, metrics);
  }

  returnStore(): SolidStoreProxy<T> { return this.store; }

  // Internal helpers exposed for bridge/advanced (parity with original createService surface)
  get _internalData() { return this.data; }

  /**
   * Runtime control of wake-up granularity.
   *
   * store.wakeUp('grained')     → only the exact changed path is dirtied (default, recommended)
   * store.wakeUp('container')   → also dirty parents on the path (more "container" behavior)
   * store.wakeUp('a.b.c', 'leaf') → Angular-compatible targeted branch wake for one path
   */
  setWakeMode(mode: SolidWakeMode): void {
    this.wakeUp(mode);
  }

  wakePath(path: string, mode: SolidWakeMode = 'grained'): void {
    this.wakeUp(path, mode);
  }

  wakeUp(mode: SolidWakeMode): void;
  wakeUp(path: string, mode?: SolidWakeMode): void;
  wakeUp(pathOrMode: string, mode?: SolidWakeMode): void {
    if (mode === undefined && isWakeMode(pathOrMode)) {
      this._wakeParentsOnChange = WAKE_MODE_BRANCH[pathOrMode];
      return;
    }
    this.reactivity?.wakeSignalPath(pathOrMode, mode ?? 'grained');
  }
}

// --- Public factories (full parity surface) ---

export function createSolidStore<T extends Record<string, unknown>>(
  initial: T,
  name = 'default',
  options?: SolidStoreOptions
): SolidStore<T> {
  const prev = registry.get(name);
  if (prev) prev.destroy();
  return new SolidStore<T>(initial, name, options);
}

export function useSolidStore<T extends Record<string, unknown> = any>(name = 'default'): SolidStore<T> {
  const s = registry.get(name);
  if (!s) throw new Error(`[SolidStore] useSolidStore('${name}'): store not found. Create first.`);
  return s as SolidStore<T>;
}

export function waitForStore<T extends Record<string, unknown> = any>(
  name = 'default',
  options: WaitForStoreOptions = {}
): Promise<SolidStore<T>> {
  const existing = registry.get(name);
  if (existing) return Promise.resolve(existing as SolidStore<T>);

  const abortError = () => Object.assign(new Error(`[SolidStore] waitForStore('${name}') aborted.`), { name: 'AbortError' });
  if (options.signal?.aborted) return Promise.reject(abortError());

  return new Promise<SolidStore<T>>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finishReject(abortError());
    const waiters = registryWaiters.get(name) ?? new Set<StoreWaiter>();

    const waiter: StoreWaiter = {
      resolve: (store) => resolve(store as SolidStore<T>),
      reject,
      cleanup: () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      },
    };

    const finishReject = (error: Error) => {
      waiters.delete(waiter);
      if (waiters.size === 0) registryWaiters.delete(name);
      waiter.cleanup();
      waiter.reject(error);
    };

    waiters.add(waiter);
    registryWaiters.set(name, waiters);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      const timeoutMs = Math.max(0, options.timeoutMs);
      timer = setTimeout(
        () => finishReject(new Error(`[SolidStore] waitForStore('${name}') timed out after ${timeoutMs}ms.`)),
        timeoutMs
      );
    }
  });
}

// Headless / vanilla friendly (no owner required for creation + plain reads/writes/mutate).
// For createMemo/createEffect over .store use createRoot in non-component usage.

export default SolidStore;

// Re-exports for wiring / testing
export type { StoreMutator, SolidProxyOptions, SolidWakeMode } from '../proxy/solid-proxy';
export { createSolidProxy } from '../proxy/solid-proxy';
export type { SolidStoreProxy, StoreArray, StoreLeaf } from './proxy-types';
