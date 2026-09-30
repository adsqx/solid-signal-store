import type { StoreDevToolsAction } from '../core/devtools-contract';
import type { WakeEngine } from './wake-engine';
import type { ProxyRegistry, NodeMethod } from './proxy-registry';
import type { SolidProxyOptions, StoreMutator } from './types';

/** Store operations the proxy dispatches to by name; only what the store actually defines is present. */
export type MutatorSurface = Record<string, NodeMethod | undefined>;

/** Creates (or returns the cached) proxy for a path. */
export type NodeFactory = (path: string) => object;

/** Everything a proxy node needs from the layer that created it. */
export interface ProxyContext {
  readonly mutator: StoreMutator;
  /** The same object as `mutator`, viewed through the store methods dispatched by name. */
  readonly surface: MutatorSurface;
  readonly opts: SolidProxyOptions;
  readonly engine: WakeEngine;
  readonly registry: ProxyRegistry;
  readonly factory: NodeFactory;
  emit(action: StoreDevToolsAction): void;
}
