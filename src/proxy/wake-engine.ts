// The signal graph: one signal per observed path, plus every wake strategy that dirties them.

import { createSignal, type Accessor, type Setter } from 'solid-js';
import type { JsonMutationResult } from '@adsq/jsnq/data-engine';
import { enumerateAncestors, normalizePath } from '../internal/path';
import { GenerationalCache } from '@adsq/jsnq/data-engine';
import { isBranch } from '../internal/util';
import type { SolidProxyMetrics, SolidStoreReactivity } from '../core/types';
import { SignalTrie } from './signal-trie';
import { WAKE_MODE_BRANCH, type SolidWakeMode, type StoreMutator } from './types';

type SignalPair = [Accessor<unknown>, Setter<unknown>];

// Branch values are always considered changed: the same object may have been mutated in place.
const signalEquals = (prev: unknown, next: unknown): boolean =>
  !isBranch(prev) && !isBranch(next) && Object.is(prev, next);

/** Every path a result touched, each once. */
function touchedPaths(result: JsonMutationResult, into: Set<string>): Set<string> {
  for (const path of result.changed) into.add(path);
  for (const path of result.inserted) into.add(path);
  for (const path of result.deleted) into.add(path);
  return into;
}

export class WakeEngine implements SolidStoreReactivity {
  private signals = new Map<string, SignalPair>();
  private index = new SignalTrie();
  // Per-query branch subscriptions ($liveQuery / $subscribe): a path here means "wake this branch signal
  // whenever a descendant changes", without flipping the whole store into container mode.
  private branchSubs = new Map<string, number>();
  private ancestorCache = new GenerationalCache<string[]>(1000);

  constructor(
    private readonly mutator: StoreMutator,
    private readonly onSignalUpdate: ((path: string) => void) | undefined,
    private readonly registry: { readonly size: number; clear(): void },
  ) {}

  // Read dynamically so store.wakeUp(...) can switch modes at runtime.
  private get wakesParents(): boolean {
    return !!this.mutator._wakeParentsOnChange;
  }

  getSignal(path: string): SignalPair {
    let pair = this.signals.get(path);
    if (!pair) {
      pair = createSignal(this.mutator.read(path), { equals: signalEquals });
      this.signals.set(path, pair);
      this.index.add(path);
    }
    return pair;
  }

  /** Re-reads `path` into its signal (when observed) and reports it to the test hook. */
  private updateSignal(path: string): void {
    this.signals.get(path)?.[1](this.mutator.read(path));
    this.onSignalUpdate?.(path);
  }

  private updateAll(paths: Iterable<string>): void {
    for (const path of paths) this.updateSignal(path);
  }

  /** Root-first ancestor-or-self paths of a normalized path (cached). Empty for invalid paths. */
  private targetsOf(normalized: string): string[] {
    return this.ancestorCache.get(normalized) ?? this.ancestorCache.set(normalized, enumerateAncestors(normalized).reverse());
  }

  /** Root-first strict ancestors of `path`. */
  private parentTargets(path: string): string[] {
    const normalized = normalizePath(path);
    const targets = this.targetsOf(normalized);
    return targets.length > 0 && targets[targets.length - 1] === normalized ? targets.slice(0, -1) : targets;
  }

  wakeSignalPath(path: string, mode: SolidWakeMode = 'grained'): void {
    const normalized = normalizePath(path);
    if (!normalized) return;
    if (WAKE_MODE_BRANCH[mode]) this.updateAll(this.targetsOf(normalized));
    else this.updateSignal(normalized);
  }

  /**
   * Precise splice wake (preciseMutationWake): the array signal, the element signals at index >= start
   * (the untouched [0,start) prefix keeps value and index) and branch subscribers. Container mode keeps
   * the full descendant sync so the ancestor wake stays identical.
   */
  wakeArraySplice(arrayPath: string, startIndex: number): void {
    this.updateAll(this.wakesParents
      ? this.index.descendantsOf(arrayPath)
      : this.index.descendantsFromArrayIndex(arrayPath, startIndex));
    this.updateSignal(arrayPath);
    if (this.branchSubs.size > 0) this.wakeBranchSubscribers([arrayPath]);
  }

  /** Allocation-light wake path for O(1) push/pop tail mutations. */
  wakeArrayTail(arrayPath: string, index: number, branchReplaced: boolean): void {
    const indexPath = `${arrayPath}.${index}`;
    if (branchReplaced) this.updateAll(this.index.descendantsOf(indexPath));
    this.updateSignal(arrayPath);
    this.updateSignal(indexPath);
    if (this.wakesParents) {
      for (const path of this.parentTargets(indexPath)) if (path !== arrayPath) this.updateSignal(path);
    }
    if (this.branchSubs.size > 0) this.wakeBranchSubscribers([arrayPath, indexPath]);
  }

  /** Wake for one mutation result (the hot path: a plain set/delete). */
  wakeMutation(result: JsonMutationResult): void {
    if (result.branchReplaced) this.updateAll(this.index.descendantsOf(result.path));
    const { changed, inserted, deleted } = result;
    const count = changed.length + inserted.length + deleted.length;
    // One touched path (a set also lists a new key as inserted) needs no dedupe set.
    if (count === 1 || (count === 2 && changed.length === 1 && changed[0] === inserted[0])) {
      this.updateSignal((changed[0] ?? inserted[0] ?? deleted[0])!);
    } else if (count > 0) {
      this.updateAll(touchedPaths(result, new Set()));
    }
    if (this.wakesParents) this.updateAll(result.parents);
    if (this.branchSubs.size > 0) this.wakeBranchSubscribers([...changed, ...inserted, ...deleted, result.path]);
  }

  /** Wake for a batch of results: every touched signal once, in first-seen order. */
  wakeMutations(results: readonly JsonMutationResult[]): void {
    if (results.length === 1) return this.wakeMutation(results[0]!);
    const branchPaths: string[] = [];
    const exact = new Set<string>();
    const parents = new Set<string>();
    for (const result of results) {
      if (result.branchReplaced) branchPaths.push(result.path);
      touchedPaths(result, exact);
      if (this.wakesParents) for (const path of result.parents) parents.add(path);
    }
    this.updateAll(this.index.descendantsOfAny(branchPaths));
    this.updateAll(exact);
    this.updateAll(parents);
    if (this.branchSubs.size > 0) this.wakeBranchSubscribers(exact);
  }

  // Ref-counted "interested in all descendants" registration of a branch.
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

  // Wakes each registered branch signal that is an ancestor-or-self of a changed path (only the branch
  // signal itself, so its $liveQuery memo recomputes once). O(changed paths x depth).
  private wakeBranchSubscribers(changedPaths: Iterable<string>): void {
    const woken = new Set<string>();
    this.wakeIfSubscribed('', woken);
    for (const path of changedPaths) {
      if (!path) continue;
      this.wakeIfSubscribed(path, woken);
      for (const ancestor of this.targetsOf(normalizePath(path))) this.wakeIfSubscribed(ancestor, woken);
    }
  }

  private wakeIfSubscribed(candidate: string, woken: Set<string>): void {
    if (this.branchSubs.has(candidate) && !woken.has(candidate)) {
      woken.add(candidate);
      this.updateSignal(candidate);
    }
  }

  /** Proxy-graph sizes for devtools PROXY_METRICS. */
  getProxyMetrics(): SolidProxyMetrics {
    return { signals: this.signals.size, proxies: this.registry.size, branchSubs: this.branchSubs.size };
  }

  destroy(): void {
    this.signals.clear();
    this.index = new SignalTrie();
    this.branchSubs.clear();
    this.ancestorCache.clear();
    this.registry.clear();
  }
}
