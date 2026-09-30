import type { SolidDevtoolsAdapter } from './devtools-contract';
import type { SolidJsnqBridge } from '../jsnq/solid-pipeline-bridge';
import type { StoreLiveQuery } from './proxy-types';

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
