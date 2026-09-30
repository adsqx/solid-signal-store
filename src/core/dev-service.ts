/**
 * SolidDevService — per-store devtools stream layer, parity with Angular's DevService.
 *
 * Angular's DevService exposes `action$` / `readAction$` BehaviorSubject streams plus
 * proxy-cache metrics helpers. Solid does not use RxJS, so these streams are minimal
 * listener-set subjects (subscribe(cb) → unsubscribe, plus a last-value cache mirroring
 * BehaviorSubject's "current value" contract). The legacy global `onSolidDevAction` bus
 * (SolidStore.ts) is kept for back-compat; this service is the typed per-instance layer
 * that the Angular host already had and Solid was missing.
 */

import type { DevStream, DevToolsEvent, ProxyMetrics, SolidDevtoolsAdapter } from './devtools-contract';

export type { DevStream, DevToolsEvent, ProxyMetrics, SolidDevtoolsAdapter } from './devtools-contract';

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

  emitAction(event: DevToolsEvent): void {
    this.actions.emit(event);
  }

  emitRead(event: DevToolsEvent): void {
    this.reads.emit(event);
  }

  /** Emit a PROXY_METRICS action (parity with Angular DevService.logProxyMetrics). */
  emitProxyMetrics(storeName: string, metrics: ProxyMetrics): void {
    // Metrics go to the action stream only (not read history), matching Angular.
    this.emitAction({
      type: 'PROXY_METRICS',
      payload: {
        path: 'proxy-cache',
        signals: metrics.signals,
        proxies: metrics.proxies,
        branchSubs: metrics.branchSubs,
        cacheSize: metrics.proxies,
        cacheKeys: [],
      },
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
