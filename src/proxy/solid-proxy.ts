// Callable proxy, path-indexed reactivity, and store dispatch for Solid.

import { createSignal, batch, type Accessor, type Setter } from 'solid-js';
import { enumerateAncestors, getParentPath, isValidPath, normalizePath } from '../internal/path'; // delegates to SST (internal/path.ts) — all parent walks now reuse shared path core (max unification, zero naked path building)
import { ARRAY_METHODS } from '../array/solid-array';
import type { JsonMutationResult } from '@adsq/jsnq/data-engine';
import { BoundedCache } from '../internal/bounded-cache';
import { isBranch } from '../internal/guards';
import { deleteResult, setResult } from '../internal/mutation-results';
import { WAKE_MODE_BRANCH, type SolidWakeMode } from '../internal/wake-modes';
import { createProjectionObservable, type ProjectionObservableOptions } from '../core/rx-interop';
import type { SolidStoreReactivity } from '../core/proxy-types';

export interface StoreMutator {
  read(path: string): unknown;
  write(path: string, value: unknown): JsonMutationResult;
  batch<T>(fn: () => T): T;
  delete(path: string): JsonMutationResult;
  prefetch(pathPrefix: string): void;
  emitDevAction(action: any): void;
  cleanupPath(path: string): void;
  /** Typed reactivity binding (replaces `(this as any).__wakeX` casts). */
  bindReactivity?(api: SolidStoreReactivity): void;
  /** Typed wake-parents flag (read by the proxy manager's shouldWakeParents getter). */
  _wakeParentsOnChange?: boolean;
}

export type { SolidWakeMode };

export interface SolidProxyOptions {
  strictInvalidPath?: boolean;
  strictDeleteUndefined?: boolean;

  /**
   * Controls wake-up behavior after mutations.
   *
   * - false (default): Maximum granularity. Only the exact changed leaf signal is dirtied.
   *   Solid automatically notifies only the memos/effects that read that precise path.
   *   This is the "fine-grained Solid way".
   *
   * - true: Container-style (legacy behavior). On change we also walk and dirty parent signals
   *   on the path. Useful if you have code that relies on parent-level effects firing when
   *   anything inside changes.
   *
   * Recommendation: keep default (false) for best performance and granularity.
   */
  wakeParentsOnChange?: boolean;

  /**
   * @internal Test-only instrumentation hook.
   * Allows verify.ts (and future harnesses) to observe exactly which paths trigger signal updates.
   * Zero impact on production paths. Enables real measurement of grained vs container wakeUp behavior.
   */
  _onSignalUpdate?: (path: string) => void;
}

type P = any;

function isDispatchMethod(method: string): boolean {
  switch (method) {
    case 'mutate':
    case 'pipe':
    case 'array':
    case 'select':
    case 'query':
    case 'computedOf':
    case '$mutate':
    case '$pipe':
    case '$array':
    case '$select':
    case '$computedOf':
    case '$query':
    case '$queryOne':
    case '$liveQuery':
    case '$liveQueryOne':
      return true;
    default:
      return false;
  }
}

function isRootDispatchMethod(method: string): boolean {
  switch (method) {
    case 'setValue':
    case 'readStore':
    case 'deleteValue':
    case 'wakeUp':
    case 'batch':
      return true;
    default:
      return false;
  }
}

function signalEquals(prev: unknown, next: unknown): boolean {
  return !isBranch(prev) && !isBranch(next) && Object.is(prev, next);
}

/**
 * SignalPathTrie — opinia3 #1 perf: branch wake in O(observed descendants of the
 * branch) instead of O(all observed signals) Set scan (SignalPathIndex above).
 *
 * Observed signal paths are stored as a segment trie split on '.', exactly the
 * dot-joined form the proxy builds via makeChildPath. descendantsOf(prefix) jumps
 * straight to the branch node and collects only present descendants — matching the
 * previous `path.startsWith(prefix + '.')` semantics (the prefix itself excluded).
 *
 * The index is internal; callers only see precise wake behavior.
 */
class SignalPathTrieNode {
  children: Map<string, SignalPathTrieNode> | null = null;
  present = false;
}

class SignalPathTrie {
  private readonly root = new SignalPathTrieNode();

  add(path: string): void {
    if (!path) return;
    let node = this.root;
    let start = 0;
    const len = path.length;
    for (let i = 0; i <= len; i++) {
      if (i === len || path.charCodeAt(i) === 46 /* '.' */) {
        const seg = path.slice(start, i);
        start = i + 1;
        let children = node.children;
        if (!children) { children = new Map(); node.children = children; }
        let child = children.get(seg);
        if (!child) { child = new SignalPathTrieNode(); children.set(seg, child); }
        node = child;
      }
    }
    node.present = true;
  }

  descendantsOf(pathPrefix: string): string[] {
    if (!pathPrefix) return [];
    const node = this.nodeAt(pathPrefix);
    if (!node || !node.children) return [];
    const out: string[] = [];
    this.collect(node, pathPrefix, out, null);
    return out;
  }

  descendantsOfAny(pathPrefixes: readonly string[]): string[] {
    const valid = pathPrefixes.filter((path) => path.length > 0);
    if (valid.length === 0) return [];
    if (valid.length === 1) return this.descendantsOf(valid[0]!);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const prefix of valid) {
      const node = this.nodeAt(prefix);
      if (node && node.children) this.collect(node, prefix, out, seen);
    }
    return out;
  }

  /**
   * Splice-precise descendants: like descendantsOf(arrayPath) but collects only the subtrees
   * of array indices >= startIndex. After splice(startIndex, …) the prefix [0, startIndex) keeps
   * both value AND index, so its signals must NOT be woken. Non-numeric children (defensive —
   * should not occur on arrays) are always included so correctness never regresses.
   */
  descendantsFromArrayIndex(arrayPath: string, startIndex: number): string[] {
    if (!arrayPath) return [];
    const node = this.nodeAt(arrayPath);
    if (!node || !node.children) return [];
    const out: string[] = [];
    for (const [seg, child] of node.children) {
      const idx = Number(seg);
      if (Number.isInteger(idx) && idx < startIndex) continue; // untouched prefix — skip
      const childPath = `${arrayPath}.${seg}`;
      if (child.present) out.push(childPath);
      if (child.children) this.collect(child, childPath, out, null);
    }
    return out;
  }

  private nodeAt(path: string): SignalPathTrieNode | undefined {
    let node: SignalPathTrieNode | undefined = this.root;
    let start = 0;
    const len = path.length;
    for (let i = 0; i <= len && node; i++) {
      if (i === len || path.charCodeAt(i) === 46) {
        node = node.children?.get(path.slice(start, i));
        start = i + 1;
      }
    }
    return node;
  }

  /** Collect present descendant paths. When `seen` is provided, dedupes across overlapping prefixes. */
  private collect(node: SignalPathTrieNode, prefix: string, out: string[], seen: Set<string> | null): void {
    const children = node.children;
    if (!children) return;
    for (const [seg, child] of children) {
      const childPath = `${prefix}.${seg}`;
      if (child.present) {
        if (seen) {
          if (!seen.has(childPath)) { seen.add(childPath); out.push(childPath); }
        } else {
          out.push(childPath);
        }
      }
      if (child.children) this.collect(child, childPath, out, seen);
    }
  }
}

class SolidProxyManager {
  private signals = new Map<string, [Accessor<unknown>, Setter<unknown>]>();
  // Trie-backed index keeps branch wake proportional to observed descendants.
  private signalIndex = new SignalPathTrie();
  // opinia5: per-query branch subscriptions ($liveQuery / $subscribe). A path here means
  // "wake this branch signal whenever any descendant changes" — local branch tracking that
  // does NOT require flipping the whole store into container/wakeParents mode.
  private branchSubs = new Map<string, number>();
  private proxies = new Map<string, WeakRef<object>>();
  private arrayMethodHandlers = new Map<string, Function>();
  private ancestorPathCache = new BoundedCache<string, string[]>(1000);
  private finalization?: FinalizationRegistry<string>;
  private static readonly MAX_CHILD_CACHE_SIZE = 256;

  constructor(private mutator: StoreMutator, private opts: SolidProxyOptions = {}) {
    // Respect initial option for low-level usage
    if (opts.wakeParentsOnChange !== undefined) {
      this.mutator._wakeParentsOnChange = opts.wakeParentsOnChange;
    }

    if (typeof FinalizationRegistry !== 'undefined') {
      this.finalization = new FinalizationRegistry((path: string) => {
        if (!this.proxies.get(path)?.deref()) {
          this.proxies.delete(path);
          this.deleteArrayMethodHandlers(path);
        }
      });
    }
  }

  // Current wake mode is always read dynamically from the mutator.
  // This allows clean runtime switching via store.wakeUp(...)
  private get shouldWakeParents(): boolean {
    return !!this.mutator._wakeParentsOnChange;
  }

  private getSignal(path: string): [Accessor<unknown>, Setter<unknown>] {
    let s = this.signals.get(path);
    if (!s) {
      s = createSignal(this.mutator.read(path), { equals: signalEquals });
      this.signals.set(path, s);
      this.signalIndex.add(path);
    }
    return s;
  }

  // === Signal wake-up helpers (no naked logic) ===

  /** Central handler for updating a signal by path. Replaces repeated has/get/set blocks. */
  private updateSignal(path: string): void {
    this.setSignalValue(path, this.mutator.read(path));
  }

  private setSignalValue(path: string, value: unknown): void {
    if (this.signals.has(path)) {
      const [, set] = this.signals.get(path)!;
      set(value);
    }
    // Test hook (no-op in prod; enables precise granularity assertions without prototype hacks)
    (this.opts as any)._onSignalUpdate?.(path);
  }

  /** Wake only the exact signal for this path (fine-grained default). */
  private wakeExact(path: string): void {
    this.updateSignal(path);
  }

  wakePath(path: string, mode: SolidWakeMode = 'grained'): void {
    const normalized = normalizePath(path);
    if (!normalized) return;
    if (WAKE_MODE_BRANCH[mode]) {
      for (const target of this.getBranchWakeTargets(normalized)) this.updateSignal(target);
      return;
    }
    this.wakeExact(normalized);
  }

  /** Shared internal walker for any operation that needs to visit parent paths.
   *  Fully reuses SST getParentPath (no manual segment concat, no goła logika).
   *  Visitation order: root-first (outer parents before immediate) to match prior ensure/wake semantics.
   */
  private walkParentPaths(path: string, visitor: (currentPath: string) => void): void {
    for (const p of this.getParentWakeTargets(path)) visitor(p);
  }

  private getParentWakeTargets(path: string): string[] {
    const normalized = normalizePath(path);
    const branchTargets = this.getBranchWakeTargets(normalized);
    return branchTargets.length > 0 && branchTargets[branchTargets.length - 1] === normalized
      ? branchTargets.slice(0, -1)
      : branchTargets;
  }

  private getBranchWakeTargets(path: string): string[] {
    const normalized = normalizePath(path);
    const cached = this.ancestorPathCache.get(normalized);
    return cached ?? this.ancestorPathCache.set(normalized, [...enumerateAncestors(normalized)].reverse());
  }

  /** Creates the base callable + its getter for a path. */
  private createBaseCallable(path: string): { fn: P; get: () => unknown } {
    const [get] = this.getSignal(path);
    const fn = (() => get()) as P;
    Object.defineProperty(fn, '$val', { get: () => get(), enumerable: false, configurable: true });
    Object.defineProperty(fn, '$signal', { get: () => get, enumerable: false, configurable: true });
    return { fn, get };
  }

  private syncDescendants(pathPrefix: string): void {
    for (const path of this.signalIndex.descendantsOf(pathPrefix)) this.updateSignal(path);
  }

  private syncDescendantsOfAny(pathPrefixes: readonly string[]): void {
    for (const path of this.signalIndex.descendantsOfAny(pathPrefixes)) this.updateSignal(path);
  }

  /**
   * Precise splice wake (opt-in via SolidStore preciseMutationWake). Bounded analog of the
   * generic branch-replace path for splice(start>0): wakes the array signal + only the element
   * signals at index >= start (skipping the untouched [0,start) prefix) + branch subscribers on
   * the array path. The caller (SolidStore.#tryPreciseSplice) only routes here in grained mode;
   * container mode keeps the proven full syncDescendants path so ancestor/parents wake is
   * byte-for-byte identical to before. Defensive shouldWakeParents guard mirrors that contract.
   */
  wakeArraySplice(arrayPath: string, startIndex: number): void {
    if (this.shouldWakeParents) {
      // Defensive: should never be reached (caller guards), but keep full parity if it is.
      this.syncDescendants(arrayPath);
    } else {
      for (const path of this.signalIndex.descendantsFromArrayIndex(arrayPath, startIndex)) {
        this.updateSignal(path);
      }
    }
    this.wakeExact(arrayPath);
    if (this.branchSubs.size > 0) this.wakeBranchSubscribers([arrayPath]);
  }

  /** Allocation-free wake path for O(1) push/pop tail mutations. */
  wakeArrayTail(arrayPath: string, index: number, branchReplaced: boolean): void {
    const indexPath = `${arrayPath}.${index}`;
    if (branchReplaced) this.syncDescendants(indexPath);
    this.wakeExact(arrayPath);
    this.wakeExact(indexPath);
    if (this.shouldWakeParents) {
      for (const path of this.getParentWakeTargets(indexPath)) {
        if (path !== arrayPath) this.updateSignal(path);
      }
    }
    if (this.branchSubs.size > 0) this.wakeBranchSubscribers([arrayPath, indexPath]);
  }


  private isBranchMutation(value: unknown): boolean {
    return isBranch(value);
  }

  private wakeFromMutation(result: JsonMutationResult): void {
    if (result.branchReplaced) this.syncDescendants(result.path);
    if (result.changed.length === 1 && result.inserted.length === 0 && result.deleted.length === 0) {
      this.wakeExact(result.changed[0]!);
    } else {
      const exactPaths = new Set([...result.changed, ...result.inserted, ...result.deleted]);
      for (const path of exactPaths) this.wakeExact(path);
    }
    if (this.shouldWakeParents) {
      for (const path of result.parents) this.updateSignal(path);
    }
    if (this.branchSubs.size > 0) {
      this.wakeBranchSubscribers([...result.changed, ...result.inserted, ...result.deleted, result.path]);
    }
  }

  private wakeFromMutations(results: readonly JsonMutationResult[]): void {
    if (results.length === 1) {
      this.wakeFromMutation(results[0]!);
      return;
    }

    const branchPaths: string[] = [];
    const exactPaths = new Set<string>();
    const parentPaths = new Set<string>();

    for (const result of results) {
      if (result.branchReplaced) branchPaths.push(result.path);
      for (const path of result.changed) exactPaths.add(path);
      for (const path of result.inserted) exactPaths.add(path);
      for (const path of result.deleted) exactPaths.add(path);
      if (this.shouldWakeParents) {
        for (const path of result.parents) parentPaths.add(path);
      }
    }

    this.syncDescendantsOfAny(branchPaths);
    for (const path of exactPaths) this.wakeExact(path);
    for (const path of parentPaths) this.updateSignal(path);
    if (this.branchSubs.size > 0) this.wakeBranchSubscribers(exactPaths);
  }

  // opinia5: register/unregister a branch as "interested in all descendants" (per-query, ref-counted).
  addBranchSub(path: string): void {
    const key = normalizePath(path);
    this.branchSubs.set(key, (this.branchSubs.get(key) ?? 0) + 1);
  }

  removeBranchSub(path: string): void {
    const key = normalizePath(path);
    const next = (this.branchSubs.get(key) ?? 0) - 1;
    if (next <= 0) this.branchSubs.delete(key);
    else this.branchSubs.set(key, next);
  }

  // Wake any registered branch signal that is an ancestor-or-self of a changed path. Only the
  // exact branch signal is dirtied (not its whole subtree) — that branch's $liveQuery memo then
  // recomputes once. Cost is O(changed paths × depth), and only when branchSubs is non-empty.
  private wakeBranchSubscribers(changedPaths: Iterable<string>): void {
    const woken = new Set<string>();
    const wakeIfRegistered = (candidate: string) => {
      if (candidate.length === 0) {
        if (this.branchSubs.has('') && !woken.has('')) { woken.add(''); this.updateSignal(''); }
        return;
      }
      if (this.branchSubs.has(candidate) && !woken.has(candidate)) {
        woken.add(candidate);
        this.updateSignal(candidate);
      }
    };
    if (this.branchSubs.has('')) wakeIfRegistered('');
    for (const path of changedPaths) {
      if (!path) continue;
      wakeIfRegistered(path);
      for (const ancestor of this.getBranchWakeTargets(path)) wakeIfRegistered(ancestor);
    }
  }

  wakeMutation(result: JsonMutationResult): void {
    this.wakeFromMutation(result);
  }

  wakeMutations(results: readonly JsonMutationResult[]): void {
    this.wakeFromMutations(results);
  }

  /** Snapshot of proxy-graph sizes for devtools PROXY_METRICS emission (Angular parity). */
  metrics(): { signals: number; proxies: number; branchSubs: number } {
    return { signals: this.signals.size, proxies: this.proxies.size, branchSubs: this.branchSubs.size };
  }

  destroy(): void {
    this.signals.clear();
    this.signalIndex = new SignalPathTrie();
    this.branchSubs.clear();
    this.proxies.clear();
    this.arrayMethodHandlers.clear();
    this.ancestorPathCache.clear();
    this.finalization = undefined;
  }

  /** Ensure all parent proxies exist for a deep path (part of navigation/wake-up). */
  private ensureIntermediates(path: string, factory: (p: string) => P): void {
    if (!path.includes('.')) return;

    this.walkParentPaths(path, (current) => {
      if (!this.getCachedProxy(current)) {
        factory(current);
      }
      this.mutator.prefetch(current);
    });
  }

  make(path: string, factory: (p: string) => P): P {
    const cached = this.getCachedProxy(path);
    if (cached) return cached as P;

    const { fn, get } = this.createBaseCallable(path);
    const h = this.createProxyHandler(path, get, factory);
    const px = new Proxy(fn, h);
    this.registerProxy(path, px);
    this.ensureIntermediates(path, factory);
    return px;
  }

  /**
   * Creates the full ProxyHandler for a path.
   * All special property logic is now handled via small maps + dedicated helper methods
   * instead of long if-chains (no more goła logika).
   */
  private createProxyHandler(
    path: string,
    get: () => unknown,
    factory: (p: string) => P
  ): ProxyHandler<object> {
    const self = this;
    const childCache: Record<string, P> = Object.create(null);
    let childCacheSize = 0;

    return {
      get(_: object, k: PropertyKey) {
        if (typeof k === 'symbol') {
          return self.handleSymbolProperty(k, get);
        }

        const ks = String(k);

        switch (ks) {
          case '$val':
            return get();
          case 'toString':
            return () => String(get());
          case 'valueOf':
          case 'toJSON':
            return get;
          case '$signal':
            return get;
          case 'length': {
            const value = get();
            return Array.isArray(value) ? value.length : undefined;
          }
        }

        // opinia5: $subscribe(cb, options) on any node — observe this path's value. Registers
        // branch interest so a subscription on an object/array also fires on descendant changes,
        // without flipping the whole store into container mode. Returns { unsubscribe, dispose }.
        if (ks === '$subscribe') {
          return (cb: (value: unknown) => void, options?: ProjectionObservableOptions<unknown>) =>
            self.subscribePath(path, get, cb, options);
        }

        if (path === '' && isRootDispatchMethod(ks)) {
          return self.createRootDispatchHandler(ks);
        }

        // Dispatch methods (mutate, array, computedOf, etc.)
        // opinia5: $-prefixed aliases so a data key literally named `mutate`/`query`/`select`/… does
        // not shadow the store operations. Back-compat: bare names stay.
        if (isDispatchMethod(ks)) {
          const cp = self.makeChildPath(path, ks);
          return self.createDispatchHandler(cp, ks);
        }

        // Array mutation / query methods
        if (ARRAY_METHODS.has(ks)) {
          return self.createArrayMethodHandler(path, ks, get);
        }

        // Child proxy identity is stable for the store lifetime. A per-parent cache
        // avoids rebuilding the full path and consulting the global map on every read.
        const cached = childCache[ks];
        if (cached) return cached;
        const child = factory(self.makeChildPath(path, ks));
        if (childCacheSize >= SolidProxyManager.MAX_CHILD_CACHE_SIZE) {
          for (const key in childCache) delete childCache[key];
          childCacheSize = 0;
        }
        childCache[ks] = child;
        childCacheSize++;
        return child;
      },

      set(_: object, k: PropertyKey, v: unknown) {
        return self.handleSet(path, k, v);
      },

      deleteProperty(_: object, k: PropertyKey) {
        return self.handleDelete(path, k);
      }
    };
  }

  /** Central place for registering a new proxy (cache + initial prefetch). */
  private registerProxy(path: string, px: P): void {
    this.proxies.set(path, new WeakRef(px as object));
    this.finalization?.register(px, path);
    this.mutator.prefetch(path);
  }

  private getCachedProxy(path: string): object | undefined {
    const proxy = this.proxies.get(path)?.deref();
    if (!proxy) this.proxies.delete(path);
    return proxy;
  }

  private deleteArrayMethodHandlers(path: string): void {
    const prefix = `${path}\u0000`;
    for (const key of this.arrayMethodHandlers.keys()) {
      if (key.startsWith(prefix)) this.arrayMethodHandlers.delete(key);
    }
  }

  // Small public-for-root helpers so root creation can stay clean without bracket hacks
  createRootCallable() {
    return this.createBaseCallable('');
  }

  createRootHandler(factory: (p: string) => P) {
    const { get } = this.createBaseCallable('');
    return this.createProxyHandler('', get, factory);
  }

  /** Central helper: constructs child path string. Eliminates repeated naked `${path}.${k}` templates. */
  private makeChildPath(parent: string, key: string): string {
    return parent ? `${parent}.${key}` : key;
  }

  // === Small focused handlers (no naked if cascades) ===

  private handleSymbolProperty(k: symbol, get: () => unknown): any {
    if (k === Symbol.toPrimitive) {
      return (hint: string) => {
        const v = get();
        return typeof v === 'object' ? (hint === 'number' ? NaN : JSON.stringify(v)) : v;
      };
    }
    if (k === Symbol.toStringTag) {
      return () => {
        const v = get();
        try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { return String(v); }
      };
    }
    return undefined;
  }

  private createDispatchHandler(cp: string, method: string): Function {
    const self = this;
    return (...args: unknown[]) => {
      // $-alias resolution: use the exact method when defined ($query/$queryOne/$liveQuery/
      // $liveQueryOne are dedicated SolidStore methods), otherwise strip the leading '$' and use
      // the bare method ($mutate -> mutate, $select -> select, …).
      const mutatorAny = self.mutator as any;
      const m = typeof mutatorAny[method] === 'function'
        ? mutatorAny[method]
        : mutatorAny[method.charCodeAt(0) === 36 /* '$' */ ? method.slice(1) : method];
      const parentPath = getParentPath(cp) ?? '';
      self.mutator.emitDevAction({ type: 'PROXY_DISPATCH', payload: { path: parentPath, method } });
      return typeof m === 'function' ? m.call(self.mutator, parentPath, ...args) : undefined;
    };
  }

  // opinia5: value subscription for a path (backs $subscribe). Registers branch interest so a
  // subscription on an object/array also fires on descendant mutations, then cleans it up.
  private subscribePath(
    path: string,
    get: () => unknown,
    cb: (value: unknown) => void,
    options?: ProjectionObservableOptions<unknown>
  ): { unsubscribe(): void; dispose(): void } {
    this.addBranchSub(path);
    const sub = createProjectionObservable(get, options).subscribe(cb);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      sub.unsubscribe();
      this.removeBranchSub(path);
    };
    return { unsubscribe: close, dispose: close };
  }

  private createRootDispatchHandler(method: string): Function {
    const self = this;
    return (...args: unknown[]) => {
      self.mutator.emitDevAction({ type: 'PROXY_DISPATCH', payload: { path: '', method } });
      const m = (self.mutator as any)[method];
      return typeof m === 'function' ? m.call(self.mutator, ...args) : undefined;
    };
  }

  private createArrayMethodHandler(path: string, method: string, get: () => unknown): Function {
    const cacheKey = `${path}\u0000${method}`;
    const cached = this.arrayMethodHandlers.get(cacheKey);
    if (cached) return cached;

    const self = this;
    const handler = (...args: unknown[]) => {
      self.mutator.emitDevAction({ type: 'ARRAY_DISPATCH', payload: { path, method, args } });
      return (self.mutator as any).arrayOp?.(path, method, args, get());
    };
    this.arrayMethodHandlers.set(cacheKey, handler);
    return handler;
  }

  private handleSet(path: string, k: PropertyKey, v: unknown): boolean {
    if (typeof k === 'symbol') return false;

    const tp = this.makeChildPath(path, String(k));

    if (v === undefined && this.opts.strictDeleteUndefined) {
      throw new Error(`strict: set undefined ${tp}`);
    }
    if (this.opts.strictInvalidPath && !isValidPath(tp)) {
      throw new Error(`strict: invalid path ${tp}`);
    }

    const writeAndSync = () => {
      const result = v === undefined ? this.mutator.delete(tp) : this.mutator.write(tp, v);
      this.wakeFromMutation(result);
    };

    if (this.isSinglePrimitiveLeafSet(v)) {
      writeAndSync();
    } else {
      this.mutator.batch(writeAndSync);
    }

    this.mutator.emitDevAction({ type: 'SET_VALUE', payload: { path: tp, value: v } });
    return true;
  }

  private isSinglePrimitiveLeafSet(value: unknown): boolean {
    return value !== undefined && !this.isBranchMutation(value) && !this.shouldWakeParents;
  }

  private handleDelete(path: string, k: PropertyKey): boolean {
    if (typeof k === 'symbol') return false;

    const tp = this.makeChildPath(path, String(k));

    if (this.opts.strictDeleteUndefined) {
      throw new Error(`strict: delete ${tp}`);
    }
    if (this.opts.strictInvalidPath && !isValidPath(tp)) {
      throw new Error(`strict: invalid path ${tp}`);
    }

    this.mutator.batch(() => this.wakeFromMutation(this.mutator.delete(tp)));

    this.mutator.emitDevAction({ type: 'DELETE', payload: { path: tp } });
    return true;
  }
}

export function createSolidProxy<T>(mutator: StoreMutator, options: SolidProxyOptions = {}): T {
  const mgr = new SolidProxyManager(mutator, options);
  // Typed reactivity binding (replaces six `(mutator as any).__wakeX = ...` casts).
  mutator.bindReactivity?.({
    wakeMutation: (result) => mgr.wakeMutation(result),
    wakeMutations: (results) => mgr.wakeMutations(results),
    wakeArrayTail: (arrayPath, index, branchReplaced) => mgr.wakeArrayTail(arrayPath, index, branchReplaced),
    wakeArraySplice: (arrayPath, startIndex) => mgr.wakeArraySplice(arrayPath, startIndex),
    addBranchSub: (path) => mgr.addBranchSub(path),
    removeBranchSub: (path) => mgr.removeBranchSub(path),
    wakeSignalPath: (path, mode) => mgr.wakePath(path, mode),
    getProxyMetrics: () => mgr.metrics(),
    destroy: () => mgr.destroy(),
  });
  const fac = (p: string) => mgr.make(p, fac);
  return mgr.make('', fac) as T;
}

export function createStoreMutator(base: {
  read(p: string): unknown;
  write(p: string, v: unknown): void | JsonMutationResult;
} & Partial<StoreMutator>): StoreMutator {
  return {
    read: base.read,
    write: (p, v) => {
      const previous = base.read(p);
      const result = base.write(p, v);
      return result ?? setResult(p, previous, v);
    },
    batch: base.batch ?? (f => f()),
    delete: base.delete ?? ((p) => {
      const previous = base.read(p);
      const result = base.write(p, undefined);
      return result ?? deleteResult(p, previous);
    }),
    prefetch: base.prefetch ?? (() => {}),
    emitDevAction: base.emitDevAction ?? (() => {}),
    cleanupPath: base.cleanupPath ?? (() => {}),
  };
}
