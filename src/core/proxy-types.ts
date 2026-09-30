import type { JsonMutationResult } from '@adsq/jsnq/data-engine';
import type { SolidWakeMode } from '../internal/wake-modes';
import type { ProxyMetrics } from './devtools-contract';
import type { ProjectionObservableOptions } from './rx-interop';

export type StorePrimitive = string | number | boolean | bigint | symbol | null | undefined;

/** Proxy-graph sizes for devtools metrics (parity with Angular ProxyCacheManager.metricsSnapshot). */
export type SolidProxyMetrics = ProxyMetrics;

/**
 * Typed reactivity surface that the proxy manager installs on the store so the store
 * can wake signals without `(this as any).__wakeX` casts. Mirrors Angular's
 * ReactivityWakeupService contract: the store owns mutation commits, the proxy owns
 * the signal graph, and this interface is the typed bridge between them.
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

// opinia5: shared shapes for the $-namespace (subscriptions + reactive jsnq reads).
export type StoreSubscription = { unsubscribe(): void; dispose(): void };

export type StoreSubscribeOptions<T> = ProjectionObservableOptions<T>;

export type StoreLiveQuery<T> = (() => T) & {
  subscribe(cb: (value: T) => void, options?: StoreSubscribeOptions<T>): StoreSubscription;
  dispose(): void;
};

export type StoreLeaf<T> = (() => T) & {
  readonly $val: T;
  readonly $signal: () => T;
  toJSON(): T;
  valueOf(): T;
  // opinia5: $-prefixed system surface — present on every node, never collides with data keys.
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
