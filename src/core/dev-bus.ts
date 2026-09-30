import type { SolidDevtoolsAdapter, StoreDevToolsAction } from './devtools-contract';

/** Event delivered on the legacy global dev bus (`storeName` is added by the emitting store). */
export type DevBusEvent = StoreDevToolsAction & { storeName?: string };
export type DevListener = (e: DevBusEvent) => void;

// Global dev bus (parity with original DevToolsActionSubject / emit patterns).
const listeners = new Set<DevListener>();

/** Delivers to every listener; a throwing listener never affects the others or the store. */
export function emitDev(event: DevBusEvent): void {
  for (const fn of listeners) {
    try { fn(event); } catch { /* isolated */ }
  }
}

export function onSolidDevAction(fn: DevListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fans one store event out to its per-store streams (if any) and the legacy global bus (async). */
export function publishDev(service: SolidDevtoolsAdapter | undefined, storeName: string, action: StoreDevToolsAction): void {
  const event = { ...action, storeName };
  service?.emitAction(event);
  if (action.type !== 'PROXY_METRICS') service?.emitRead(event);
  queueMicrotask(() => emitDev(event));
}
