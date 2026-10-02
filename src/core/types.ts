import type { JsonMutationResult } from '@adsq/jsnq/data-engine';
import type { SolidWakeMode } from '../proxy/types';
import type { ProxyMetrics, SolidDevtoolsAdapter } from './dev-service';
import type { SolidJsnqBridge } from '../jsnq/solid-pipeline-bridge';
import type { ProjectionObservableOptions } from './rx-interop';

export type StorePrimitive = string | number | boolean | bigint | symbol | null | undefined;

/** Proxy-graph sizes for devtools metrics (parity with Angular ProxyCacheManager.metricsSnapshot). */
export type SolidProxyMetrics = ProxyMetrics;

/**
 * Reactivity surface the proxy installs on the store (mirrors Angular's ReactivityWakeupService):
 * the store owns mutation commits, the proxy owns the signal graph, this interface is the bridge.
 */
export interface SolidStoreReactivity {
  wakeMutation(result: JsonMutationResult): void;
  wakeMutations(results: JsonMutationResult[]): void;
  wakeArrayTail(arrayPath: string, index: number, branchReplaced: boolean): void;
  wakeArraySplice(arrayPath: string, startIndex: number): void;
  addBranchSub(path: string): void;
  removeBranchSub(path: string): void;
  wakeSignalPath(path: string, mode?: SolidWakeMode): void;
  /** Snapshot of proxy-graph sizes for devtools PROXY_METRICS emission. */
  getProxyMetrics?(): SolidProxyMetrics;
  destroy(): void;
}

// Shapes of the $-namespace (subscriptions + reactive jsnq reads).
export type StoreSubscription = { unsubscribe(): void; dispose(): void };

export type StoreSubscribeOptions<T> = ProjectionObservableOptions<T>;

export type StoreLiveQuery<T> = (() => T) & {
  subscribe(cb: (value: T) => void, options?: StoreSubscribeOptions<T>): StoreSubscription;
  dispose(): void;
};

/** Deep-mutable plain data type: strips `readonly`, recurses into objects and arrays; functions and primitives as is. */
export type Draft<T> = T extends (...args: any[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? Draft<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Draft<T[K]> }
      : T;

export type StoreLeaf<T> = (() => T) & {
  readonly $val: T;
  /** Untracked plain-JSON read/write view of this path (see `Draft`); writes route through the store. */
  readonly $draft: Draft<T>;
  readonly $signal: () => T;
  toJSON(): T;
  valueOf(): T;
  // $-prefixed system surface: present on every node, never collides with data keys.
  $subscribe(cb: (value: T) => void, options?: StoreSubscribeOptions<T>): StoreSubscription;
  $query(...ops: unknown[]): unknown[];
  $queryOne(...ops: unknown[]): unknown;
  $liveQuery(...ops: unknown[]): StoreLiveQuery<unknown[]>;
  $liveQueryOne(...ops: unknown[]): StoreLiveQuery<unknown>;
  $mutate(...ops: unknown[]): unknown;
  $pipe(...ops: unknown[]): unknown;
  $array(): unknown;
};

export type StoreArray<T> = StoreLeaf<T[]> & {
  readonly length: number;
  [index: number]: SolidStoreProxy<T>;
  push(...items: T[]): number;
  pop(): T | undefined;
  shift(): T | undefined;
  unshift(...items: T[]): number;
  splice(start: number, deleteCount?: number, ...items: T[]): T[];
  sort(compareFn?: (a: T, b: T) => number): SolidStoreProxy<T[]>;
  reverse(): SolidStoreProxy<T[]>;
  find(predicate: (item: T, index: number, array: T[]) => boolean): T | undefined;
  findIndex(predicate: (item: T, index: number, array: T[]) => boolean): number;
  filter(predicate: (item: T, index: number, array: T[]) => boolean): T[];
  map<R>(callback: (item: T, index: number, array: T[]) => R): R[];
  some(predicate: (item: T, index: number, array: T[]) => boolean): boolean;
  every(predicate: (item: T, index: number, array: T[]) => boolean): boolean;
  includes(value: T): boolean;
  indexOf(value: T): number;
  mutate(...ops: unknown[]): unknown;
  pipe(...ops: unknown[]): unknown;
  array(): unknown;
};

export type SolidStoreProxy<T> =
  T extends StorePrimitive
    ? StoreLeaf<T>
    : T extends Array<infer U>
      ? StoreArray<U>
      : StoreLeaf<T> & {
          [K in keyof T]: SolidStoreProxy<T[K]>;
        };

/**
 * Reactive jsnq query handle: callable for the current result, `.subscribe()` for a push subscription,
 * `.dispose()` to release the per-query branch interest. Same `where(...)` DSL as `mutate`.
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
   * branch subscribers ($liveQuery). Falls back to the branch commit for structural/deep ops.
   */
  preciseMutationWake?: boolean;

  /** Optional development-only event stream adapter from `solidstore/devtools`. */
  devtools?: SolidDevtoolsAdapter;

  /** Internal test hook: called with the path on every signal-update CALL (forwarded to SolidProxyOptions). */
  _onSignalUpdate?: (path: string) => void;
}
