/**
 * SolidStore.ts — the store orchestrator (CreateStore + SignalStore parity).
 * Owns the raw data, the root commit and the dev lifecycle, and wires createSolidProxy over the
 * narrow StoreMutator contract. jsnq operations live in store-jsnq.ts, array dispatch in
 * array/array-ops.ts, the named registry in registry.ts and the global dev bus in dev-bus.ts.
 */
import { batch, createMemo, type Accessor } from 'solid-js';
import {
  cloneJsonData,
  deleteJsonPath,
  readJsonPath,
  writeJsonPath,
  writeJsonPathValue,
  type JsonMutationResult,
} from '@adsq/jsnq/data-engine';
import { createSolidProxy, type SolidProxyOptions, type SolidWakeMode, type StoreMutator } from '../proxy/solid-proxy';
import { arrayOp, queryArray, createArrayChain, type ArrayOpHost } from '../array/solid-array';
import { deleteResult } from '../internal/util';
import { WAKE_MODE_BRANCH, isWakeMode } from '../internal/wake-modes';
import { publishDev } from './dev-bus';
import {
  EMPTY_DEV_STREAM,
  type DevStream,
  type SolidDevtoolsAdapter,
  type StoreDevToolsAction,
} from './devtools-contract';
import type { SolidStoreProxy, SolidStoreReactivity } from './proxy-types';
import { destroyRegistered, registerStore, unregisterStore } from './registry';
import { createProjectionObservable, type ProjectionObservableOptions } from './rx-interop';
import type { SolidLiveQuery, SolidStoreOptions } from './store-options';
import { commitRoot } from './store-commit';
import { createLiveQuery, mutate, pipe, runQuery, type JsnqHost } from './store-jsnq';

export class SolidStore<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly store: SolidStoreProxy<T>; // the callable proxied reactive root (full surface via traps)
  private readonly data: T;
  private name: string;
  private readonly registryName: string;
  private devActive = false;
  private readonly opts: SolidStoreOptions;
  // Typed reactivity surface installed by createSolidProxy.
  private reactivity?: SolidStoreReactivity;
  // Typed wake-parents flag (read by the proxy manager's shouldWakeParents getter).
  _wakeParentsOnChange = false;
  private devService?: SolidDevtoolsAdapter;
  private destroyed = false;
  // One host object shared with the jsnq / array modules (built once, no per-call closures).
  readonly #host: JsnqHost & ArrayOpHost;

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
    this.data = cloneJsonData(initial ?? ({} as T));
    this._wakeParentsOnChange = opts.wakeParentsOnChange ?? false;

    const pOpts: SolidProxyOptions = {
      strictInvalidPath: opts.strict?.invalidPath,
      strictDeleteUndefined: opts.strict?.deleteUndefined,
      ...(opts._onSignalUpdate ? { _onSignalUpdate: opts._onSignalUpdate } : {}),
    };
    this.store = createSolidProxy<SolidStoreProxy<T>>(this as unknown as StoreMutator, pOpts);

    const self = this;
    this.#host = {
      opts,
      store: this.store,
      preciseSplice: !!opts.preciseMutationWake,
      get tracking() { return self.devActive; },
      get reactivity() { return self.reactivity; },
      get wakeParents() { return self._wakeParentsOnChange; },
      read: (path) => self.read(path),
      batch,
      emitDevAction: (action) => self.emitDevAction(action),
      data: this.data,
      wake: (results) => self.reactivity?.wakeMutations(results),
      commit: (path, value) => self.#assign(path, value),
      commitBranch: (path, value) => self.#commit(path, value),
      setValueOnly: (path, value) => writeJsonPathValue(self.data, path, value),
    };

    registerStore(name, this);
  }

  // Direct raw-data write + explicit signal wake + devtools emit (mirrors what the proxy set trap
  // does). Root (empty path) is handled by #commitRoot / ignored here.
  #assign(p: string, v: unknown): void {
    if (!p) return;
    this.reactivity?.wakeMutation(writeJsonPath(this.data, p, v));
    this.emitDevAction({ type: 'SET_VALUE', payload: { path: p, value: v } });
  }

  #commit(p: string, v: unknown): void {
    if (p) this.#assign(p, v);
    else commitRoot(this.#host, v);
  }

  // StoreMutator contract (wired to the proxy) + the public surface the proxy traps call
  read(path: string): unknown { return readJsonPath(this.data, path ?? ''); }
  write(path: string, value: unknown): JsonMutationResult { return writeJsonPath(this.data, path ?? '', value); }
  batch<T>(fn: () => T): T { return batch(fn); }
  delete(path: string): JsonMutationResult {
    return path ? deleteJsonPath(this.data, path) : deleteResult('', this.data, true, true);
  }
  prefetch(pathPrefix: string): void { this.read(pathPrefix); /* warms for cursor/prefetch contract */ }
  emitDevAction(action: StoreDevToolsAction): void {
    if (this.devActive) publishDev(this.devService, this.name, action);
  }
  cleanupPath(path: string): void {
    this.emitDevAction({ type: 'CLEANUP', payload: { path, cleanedPaths: [path], cleanedCount: 1 } });
  }
  readStore(path = ''): unknown { return this.read(path); }
  setValue(path: string, value: unknown): void { this.#assign(path ?? '', value); }
  deleteValue(path: string): void {
    if (!path) return;
    this.reactivity?.wakeMutation(this.delete(path));
    this.emitDevAction({ type: 'DELETE', payload: { path } });
  }

  // Array dispatch from the proxy (store.users.push etc.) and its query surface.
  arrayOp(path: string, method: string, args: unknown[] = [], current?: unknown): unknown {
    return arrayOp(this.#host, path, method, args, current);
  }
  query(path: string, val: unknown, method: string, ...args: unknown[]): unknown {
    return queryArray(this.read(path), val, method, args);
  }

  // jsnq: mutate / pipe / one-shot and reactive queries (same where(...) DSL)
  mutate(path: string, ...ops: any[]): unknown { return mutate(this.#host, path ?? '', ops); }
  pipe(path: string, ...ops: any[]): any { return pipe(this.#host, path ?? '', ops); }

  /** One-shot snapshot query: matched values. */
  $query(path: string, ...ops: any[]): unknown[] { return runQuery(this.#host, path ?? '', ops, 'all') as unknown[]; }
  /** One-shot snapshot query returning the first match (or null). */
  $queryOne(path: string, ...ops: any[]): unknown { return runQuery(this.#host, path ?? '', ops, 'first'); }
  /** Reactive query: recomputes when the queried branch changes. Callable + subscribable. */
  $liveQuery(path: string, ...ops: any[]): SolidLiveQuery<unknown[]> {
    return createLiveQuery<unknown[]>(this.#host, path ?? '', ops, 'all');
  }
  /** Reactive single-match query (first match, reactive). */
  $liveQueryOne(path: string, ...ops: any[]): SolidLiveQuery<unknown> {
    return createLiveQuery<unknown>(this.#host, path ?? '', ops, 'first');
  }

  // Fluent array entry — wiring to the dedicated array layer.
  array(path: string, ...args: any[]): any { return createArrayChain(path || (args[0] ?? ''), this.#host); }

  select<TOut>(project: (state: SolidStoreProxy<T>) => TOut, options?: ProjectionObservableOptions<TOut>) {
    return createProjectionObservable(this.computedOf(project), options);
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
    batch(() => Object.keys(this.data ?? {}).forEach((k) => this.cleanupPath(k)));
    unregisterStore(this.registryName, this);
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
    if (metrics) this.devService?.emitProxyMetrics(this.name, metrics);
  }

  returnStore(): SolidStoreProxy<T> { return this.store; }

  // Internal helpers exposed for bridge/advanced (parity with original createService surface)
  get _internalData() { return this.data; }

  /** Wake granularity: wakeUp('grained') dirties only the exact path (default), wakeUp('container') also its parents, wakeUp('a.b.c', 'leaf') wakes one branch. */
  setWakeMode(mode: SolidWakeMode): void { this.wakeUp(mode); }

  wakePath(path: string, mode: SolidWakeMode = 'grained'): void { this.wakeUp(path, mode); }

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

export function createSolidStore<T extends Record<string, unknown>>(
  initial: T,
  name = 'default',
  options?: SolidStoreOptions
): SolidStore<T> {
  destroyRegistered(name);
  return new SolidStore<T>(initial, name, options);
}

export default SolidStore;

// Re-exports for wiring / testing and for the public entry points
export { useSolidStore, waitForStore, type WaitForStoreOptions } from './registry';
export { onSolidDevAction } from './dev-bus';
export type { SolidLiveQuery, SolidStoreOptions } from './store-options';
export type { StoreMutator, SolidProxyOptions, SolidWakeMode } from '../proxy/solid-proxy';
export { createSolidProxy } from '../proxy/solid-proxy';
export type { SolidStoreProxy, StoreArray, StoreLeaf } from './proxy-types';
