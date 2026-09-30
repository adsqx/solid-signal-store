// Contracts of the proxy layer: the mutator the store implements, the proxy options, the wake modes
// and the context every proxy node receives.

import type { JsonMutationResult } from '@adsq/jsnq/data-engine';
import type { SolidStoreReactivity } from '../core/types';
import type { ProxyRegistry } from './solid-proxy';
import type { WakeEngine } from './wake-engine';

/** Wake modes and whether each one walks the ancestor ("branch") signals. */
export const WAKE_MODE_BRANCH = {
  grained: false,
  fine: false,
  exact: false,
  container: true,
  parents: true,
  leaf: true,
  branch: true,
} as const satisfies Record<string, boolean>;

export type SolidWakeMode = keyof typeof WAKE_MODE_BRANCH;

/** Own-key check, so inherited names such as `constructor` are never mistaken for a mode. */
export const isWakeMode = (value: unknown): value is SolidWakeMode =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(WAKE_MODE_BRANCH, value);

export interface StoreMutator {
  read(path: string): unknown;
  write(path: string, value: unknown): JsonMutationResult;
  batch<T>(fn: () => T): T;
  delete(path: string): JsonMutationResult;
  prefetch(pathPrefix: string): void;
  // Kept `any` on purpose: this is the published signature (the proxy only passes StoreDevToolsAction).
  emitDevAction(action: any): void;
  cleanupPath(path: string): void;
  /** Typed reactivity binding (replaces `(this as any).__wakeX` casts). */
  bindReactivity?(api: SolidStoreReactivity): void;
  /** Typed wake-parents flag (read by the proxy manager's shouldWakeParents getter). */
  _wakeParentsOnChange?: boolean;
}

export interface SolidProxyOptions {
  strictInvalidPath?: boolean;
  strictDeleteUndefined?: boolean;

  /**
   * Controls wake-up behavior after mutations.
   *
   * - false (default): only the exact changed leaf signal is dirtied, so Solid notifies just the
   *   memos/effects that read that precise path. Best performance and granularity.
   * - true: container-style (legacy). Parent signals on the path are dirtied too, for code that relies
   *   on parent-level effects firing when anything inside changes.
   */
  wakeParentsOnChange?: boolean;

  /** @internal Test-only hook: observes exactly which paths trigger signal updates (no cost when unset). */
  _onSignalUpdate?: (path: string) => void;
}

export type NodeMethod = (...args: unknown[]) => unknown;

/** Store operations the proxy dispatches to by name; only what the store actually defines is present. */
export type MutatorSurface = Record<string, NodeMethod | undefined>;

/** Everything a proxy node needs from the layer that created it. */
export interface ProxyContext {
  readonly mutator: StoreMutator;
  /** The same object as `mutator`, viewed through the store methods dispatched by name. */
  readonly surface: MutatorSurface;
  readonly opts: SolidProxyOptions;
  readonly engine: WakeEngine;
  readonly registry: ProxyRegistry;
  /** Creates (or returns the cached) proxy for a path. */
  readonly factory: (path: string) => object;
}
