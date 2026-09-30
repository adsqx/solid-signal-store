// store-commit.ts — the two multi-path commits: root replace (key-diff) and precise leaf wake.
import { batch } from 'solid-js';
import { writeJsonPathValue, type JsonMutationResult } from '@adsq/jsnq/data-engine';
import { deleteResult, setResult, touchResult } from '../internal/util';
import type { StoreDevToolsAction } from './devtools-contract';

/** What a commit needs from its store: the raw data, a dev emitter and the signal wake. */
export interface CommitHost {
  readonly data: object;
  emitDevAction(action: StoreDevToolsAction): void;
  wake(results: JsonMutationResult[]): void;
}

// Root mutation special-case (key-diff + per-key delete) — required subtle contract.
export function commitRoot(host: CommitHost, next: unknown): void {
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

// Fine-grained mutate commit (opt-in): write the branch, then wake only the changed leaves and
// the branch signal itself — NOT the whole subtree. Branch subscribers ($liveQuery) still wake
// via the ancestor walk in wakeFromMutation.
export function commitPrecise(host: CommitHost, p: string, v: unknown, relPaths: readonly string[]): void {
  writeJsonPathValue(host.data, p, v); // data write only; no proxy branch-wide wake
  const results = relPaths.map((rel) => touchResult(`${p}.${rel}`));
  results.push(touchResult(p)); // wakes whole-array consumers, without syncDescendants
  host.wake(results);
  host.emitDevAction({ type: 'SET_VALUE', payload: { path: p, value: v } });
}
