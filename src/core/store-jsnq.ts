// store-jsnq.ts — JSNQ-backed store operations (mutate / pipe / $query / live query) and the multi-path
// commits they end in (root replace, precise leaf wake), written as functions over a small host
// interface so the SolidStore class only wires them up.
import { batch, createMemo } from 'solid-js';
import { createJsonPathPlan, writeJsonPathValue, type JsonMutationResult } from '@adsq/jsnq/data-engine';
import { deleteResult, isBranch, setResult, touchResult } from '../internal/util';
import type { SolidBridgeHost, SolidJsnqBridge } from '../jsnq/solid-pipeline-bridge';
import type { StoreDevToolsAction } from './dev-service';
import { createProjectionObservable, once, subscription, type ProjectionObservableOptions } from './rx-interop';
import type { SolidLiveQuery, SolidStoreOptions, SolidStoreReactivity } from './types';

export type QueryMode = 'all' | 'first';

/** What the JSNQ operations and commits need from the store that owns them. */
export interface JsnqHost {
  readonly data: object;
  emitDevAction(action: StoreDevToolsAction): void;
  wake(results: JsonMutationResult[]): void;
  readonly opts: Pick<SolidStoreOptions, 'jsnqBridge' | 'bridgeErrorMode' | 'preciseMutationWake'>;
  /** The callable proxy root (live queries read through it to subscribe). */
  readonly store: unknown;
  /** True while devtools are active (asks the bridge to collect per-match operation strings). */
  readonly tracking: boolean;
  readonly reactivity: SolidStoreReactivity | undefined;
  read(path: string): unknown;
  batch<T>(fn: () => T): T;
  /** Whole-branch commit (root aware). */
  commitBranch(path: string, value: unknown): void;
}

type BridgeMethod = 'applyPipelineMutation' | 'createPipeline';

function lookupBridge(opts: JsnqHost['opts']): SolidJsnqBridge | undefined {
  const globals = globalThis as unknown as SolidBridgeHost;
  return opts.jsnqBridge || globals.__SOLID_PIPELINE_BRIDGE || globals.solidJsnqBridge;
}

/**
 * Runs `run` with the bridge when it provides `method`; otherwise `fallback()`. Operators with no
 * bridge at all are an error (an empty operator list never needs one).
 */
function withBridge<R>(
  host: JsnqHost,
  operation: string,
  opCount: number,
  method: BridgeMethod,
  run: (bridge: SolidJsnqBridge) => R,
  fallback: () => R
): R {
  const bridge = lookupBridge(host.opts);
  if (bridge?.[method]) return run(bridge);
  if (opCount > 0 && !bridge) {
    throw new Error(
      `[SolidStore] ${operation} requires the optional JSNQ bridge. ` +
      `Import '@adsq/solid-signal-store/jsnq' once or pass { jsnqBridge } to createSolidStore().`
    );
  }
  return fallback();
}

const isMutationOp = (op: unknown): boolean => !!(op as { __isMutation?: unknown } | null | undefined)?.__isMutation;

/** Applies `ops` to the branch at `p` and commits when something changed. Returns the new value. */
export function mutate(host: JsnqHost, p: string, ops: readonly unknown[]): unknown {
  const current = host.read(p);
  if (current === undefined) return undefined;

  host.emitDevAction({ type: 'MUTATE', payload: { path: p, opCount: ops.length } });

  let result: unknown = current;
  const hasMutationOps = ops.some(isMutationOp);
  host.batch(() =>
    withBridge(host, 'mutate()', ops.length, 'applyPipelineMutation', (bridge) => {
      const options = { isRoot: !p, path: p, bridgeErrorMode: host.opts.bridgeErrorMode, trackOperations: host.tracking };
      if (host.opts.preciseMutationWake && p && bridge.applyPipelineMutationDetailed) {
        // Opt-in fine-grained wake for sub-path branches (flat value-action shape only); otherwise
        // (not precise-eligible, or zero matches) fall through to the standard branch commit.
        const detailed = bridge.applyPipelineMutationDetailed(ops, current, options);
        result = detailed.value;
        if (detailed.mutations?.length) return commitPrecise(host, p, result, detailed.mutations);
      } else {
        result = bridge.applyPipelineMutation(ops, current, options);
      }
      if (hasMutationOps || result !== current) host.commitBranch(p, result);
    }, () => undefined)
  );
  return result;
}

/** Fluent pipeline over the branch at `p`; without the bridge a no-op builder reads it unfiltered. */
export function pipe(host: JsnqHost, p: string, ops: readonly unknown[]): unknown {
  const current = host.read(p);
  return withBridge<unknown>(host, 'pipe()', ops.length, 'createPipeline',
    (bridge) => bridge.createPipeline(current, ops, { path: p, trackOperations: host.tracking }),
    () => ({
      all: () => (Array.isArray(current) ? [...current] : current),
      first: () => (Array.isArray(current) ? current[0] : current),
      count: () => (Array.isArray(current) ? current.length : current != null ? 1 : 0),
    }));
}

// No operators (or no bridge): the raw branch (array copy / first element / value).
const RAW_RESULT: Record<QueryMode, (snapshot: unknown) => unknown> = {
  first: (s) => (Array.isArray(s) ? (s[0] ?? null) : (s ?? null)),
  all: (s) => (Array.isArray(s) ? [...s] : s == null ? [] : [s]),
};
const QUERY_LABEL: Record<QueryMode, string> = { all: '$query()', first: '$queryOne()' };
const unwrapNode = (n: unknown): unknown => (isBranch(n) && 'data' in n ? n.data : n);

/** One-shot snapshot query: matched values (`all`) or the first match or null (`first`). */
export function runQuery(host: JsnqHost, path: string, ops: readonly unknown[], mode: QueryMode): unknown {
  const snapshot = host.read(path);
  if (ops.length === 0) return RAW_RESULT[mode](snapshot);
  return withBridge(host, QUERY_LABEL[mode], ops.length, 'createPipeline',
    (bridge) => {
      const wrapper = bridge.createPipeline(snapshot, ops, { path, trackOperations: host.tracking });
      if (mode === 'first') return wrapper.execute('first') ?? null;
      const nodes = wrapper.execute('all');
      return Array.isArray(nodes) ? nodes.map(unwrapNode) : [];
    },
    () => RAW_RESULT[mode](snapshot));
}

// Reads the signal for `path` through the proxy so the enclosing memo depends on it.
function trackBranch(root: unknown, path: string): void {
  let node = root;
  if (path) {
    for (const seg of createJsonPathPlan(path).segments) {
      if (node == null) return;
      node = (node as Record<string, unknown>)[seg];
    }
  }
  if (typeof node === 'function') node();
}

/** Reactive query: recomputes when the branch changes; callable, subscribable, disposable. */
export function createLiveQuery<R>(host: JsnqHost, p: string, ops: readonly unknown[], mode: QueryMode): SolidLiveQuery<R> {
  const addBranch = () => host.reactivity?.addBranchSub(p);
  const removeBranch = () => host.reactivity?.removeBranchSub(p);
  addBranch(); // creation ref: keeps the accessor reactive until the query is disposed
  const releaseCreation = once(removeBranch);
  const acc = createMemo(() => {
    trackBranch(host.store, p);
    return runQuery(host, p, ops, mode) as R;
  });
  const live = (() => acc()) as SolidLiveQuery<R>;
  live.subscribe = (cb: (value: R) => void, options?: ProjectionObservableOptions<R>) => {
    addBranch(); // subscription ref; closing releases it and the creation ref, so an inline `$liveQuery(...).subscribe()` cleans up fully
    return subscription(createProjectionObservable(acc, options).subscribe(cb), () => {
      removeBranch();
      releaseCreation();
    });
  };
  live.dispose = releaseCreation;
  return live;
}

// Root replace: key-diff with a per-key delete, so keys missing from `next` wake as deleted.
export function commitRoot(host: JsnqHost, next: unknown): void {
  const curr = (host.data ?? {}) as Record<string, unknown>;
  const n = (next ?? {}) as Record<string, unknown>;
  const keys = new Set<string>([...Object.keys(curr), ...Object.keys(n)]);
  batch(() => {
    const mutations: JsonMutationResult[] = [];
    for (const k of keys) {
      const existed = Object.prototype.hasOwnProperty.call(curr, k);
      const previous = curr[k];
      if (!(k in n)) {
        if (existed) delete curr[k];
        mutations.push(deleteResult(k, previous, existed, false));
        host.emitDevAction({ type: 'DELETE', payload: { path: k } });
      } else {
        curr[k] = n[k];
        mutations.push(setResult(k, previous, n[k], existed));
        host.emitDevAction({ type: 'SET_VALUE', payload: { path: k, value: n[k] } });
      }
    }
    host.wake(mutations);
  });
}

// Fine-grained mutate commit (opt-in): write the branch, then wake only the changed leaves and the branch
// signal itself, not the whole subtree. Branch subscribers ($liveQuery) still wake via the ancestor walk.
function commitPrecise(host: JsnqHost, p: string, v: unknown, relPaths: readonly string[]): void {
  writeJsonPathValue(host.data, p, v); // data only: no branch-wide wake
  const results = relPaths.map((rel) => touchResult(`${p}.${rel}`));
  results.push(touchResult(p)); // whole-array consumers, without a descendant sweep
  host.wake(results);
  host.emitDevAction({ type: 'SET_VALUE', payload: { path: p, value: v } });
}
