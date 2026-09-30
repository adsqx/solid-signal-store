/**
 * store-solid — SolidJS port of the reactive store engine, with full API parity and a much simpler
 * reactivity layer. See README.md for the public API, contracts and architecture overview.
 */

export { SolidStore, createSolidStore } from './core/SolidStore';
export { useSolidStore, waitForStore } from './core/registry';
export { onSolidDevAction } from './core/dev-service';
export type { WaitForStoreOptions } from './core/registry';

// Proxy (for advanced wiring / testing)
export { createSolidProxy } from './proxy/solid-proxy';
export type { StoreMutator, SolidProxyOptions, SolidWakeMode } from './proxy/solid-proxy';

// Rx interop (minimal for .select parity)
export { createProjectionObservable } from './core/rx-interop';

export type { SolidProxyMetrics, SolidStoreOptions, SolidStoreProxy, SolidStoreReactivity, StoreArray, StoreLeaf } from './core/types';
export type {
  DevStream,
  DevToolsEvent,
  ProxyMetrics,
  SolidDevtoolsAdapter,
  StoreDevToolsAction,
} from './core/dev-service';

// Internal utilities (for advanced use / future extensions)
export * as InternalPath from './internal/path';
