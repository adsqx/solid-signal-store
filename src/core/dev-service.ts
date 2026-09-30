/**
 * Devtools event layer: the event/adapter contracts, the per-store streams (SolidDevService, parity with
 * Angular's DevService) and the legacy global bus behind `onSolidDevAction`. The streams are minimal
 * listener-set subjects that replay the last value on subscribe (BehaviorSubject's "current value").
 */

export type StoreDevToolsAction = {
  type: string;
  payload?: Record<string, unknown>;
  storeName?: string;
};

export type DevToolsEvent = StoreDevToolsAction;

export interface ProxyMetrics {
  signals: number;
  proxies: number;
  branchSubs: number;
}

export interface DevStream<T = DevToolsEvent> {
  subscribe(cb: (value: T) => void): { unsubscribe(): void };
  get(): T | null;
}

export interface SolidDevtoolsAdapter {
  readonly action$: DevStream;
  readonly readAction$: DevStream;
  emitAction(event: DevToolsEvent): void;
  emitRead(event: DevToolsEvent): void;
  emitProxyMetrics(storeName: string, metrics: ProxyMetrics): void;
  destroy(): void;
}

export const EMPTY_DEV_STREAM: DevStream = Object.freeze({
  subscribe: () => ({ unsubscribe() {} }),
  get: () => null,
});

class ListenerStream<T = DevToolsEvent> implements DevStream<T> {
  private listeners = new Set<(value: T) => void>();
  private lastValue: T | null = null;
  private hasValue = false;

  subscribe(cb: (value: T) => void): { unsubscribe(): void } {
    this.listeners.add(cb);
    if (this.hasValue) cb(this.lastValue as T);
    return { unsubscribe: () => this.listeners.delete(cb) };
  }

  emit(value: T): void {
    this.lastValue = value;
    this.hasValue = true;
    for (const fn of this.listeners) {
      try { fn(value); } catch { /* isolated listener */ }
    }
  }

  get(): T | null { return this.lastValue; }

  clear(): void {
    this.listeners.clear();
    this.lastValue = null;
    this.hasValue = false;
  }
}

export class SolidDevService implements SolidDevtoolsAdapter {
  private readonly actions = new ListenerStream();
  private readonly reads = new ListenerStream();
  readonly action$: DevStream = this.actions;
  readonly readAction$: DevStream = this.reads;

  emitAction(event: DevToolsEvent): void { this.actions.emit(event); }

  emitRead(event: DevToolsEvent): void { this.reads.emit(event); }

  /** Emit a PROXY_METRICS action (parity with Angular DevService.logProxyMetrics) on the action stream only. */
  emitProxyMetrics(storeName: string, metrics: ProxyMetrics): void {
    const { signals, proxies, branchSubs } = metrics;
    this.emitAction({
      type: 'PROXY_METRICS',
      payload: { path: 'proxy-cache', signals, proxies, branchSubs, cacheSize: proxies, cacheKeys: [] },
      storeName,
    });
  }

  destroy(): void {
    this.actions.clear();
    this.reads.clear();
  }
}

export function createSolidDevtools(): SolidDevService {
  return new SolidDevService();
}

/** Event delivered on the legacy global dev bus (`storeName` is added by the emitting store). */
export type DevBusEvent = StoreDevToolsAction & { storeName?: string };
export type DevListener = (e: DevBusEvent) => void;

const listeners = new Set<DevListener>();

export function onSolidDevAction(fn: DevListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fans one store event out to its per-store streams (if any) and, asynchronously, the global bus. */
export function publishDev(service: SolidDevtoolsAdapter | undefined, storeName: string, action: StoreDevToolsAction): void {
  const event = { ...action, storeName };
  service?.emitAction(event);
  if (action.type !== 'PROXY_METRICS') service?.emitRead(event);
  queueMicrotask(() => {
    // A throwing listener never affects the others or the store.
    for (const fn of listeners) {
      try { fn(event); } catch { /* isolated */ }
    }
  });
}
