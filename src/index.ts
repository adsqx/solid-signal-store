/**
 * store-solid — SolidJS port of the reactive store engine.
 * Full API parity with original, dramatically simpler reactivity layer thanks to Solid.
 * 
 * See README.md for the public API, contracts, and architecture overview.
 */

// Core
export { SolidStore, createSolidStore, useSolidStore, waitForStore, onSolidDevAction } from './core/SolidStore';
export type { SolidStoreOptions, WaitForStoreOptions } from './core/SolidStore';

// Proxy (for advanced wiring / testing)
export { createSolidProxy } from './proxy/solid-proxy';
export type { StoreMutator, SolidProxyOptions, SolidWakeMode } from './proxy/solid-proxy';

// Rx interop (minimal for .select parity)
export { createProjectionObservable } from './core/rx-interop';

// Re-export key types for convenience
export type { SolidStoreProxy, StoreArray, StoreLeaf, SolidStoreReactivity, SolidProxyMetrics } from './core/proxy-types';
export type {
  DevStream,
  DevToolsEvent,
  ProxyMetrics,
  SolidDevtoolsAdapter,
  StoreDevToolsAction,
} from './core/devtools-contract';

// Internal utilities (for advanced use / future extensions)
export * as InternalPath from './internal/path';
