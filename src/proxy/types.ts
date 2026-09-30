// Public contracts of the proxy layer: the mutator the store implements and the proxy options.

import type { JsonMutationResult } from '@adsq/jsnq/data-engine';
import type { SolidStoreReactivity } from '../core/proxy-types';
import type { SolidWakeMode } from '../internal/wake-modes';

export interface StoreMutator {
  read(path: string): unknown;
  write(path: string, value: unknown): JsonMutationResult;
  batch<T>(fn: () => T): T;
  delete(path: string): JsonMutationResult;
  prefetch(pathPrefix: string): void;
  // Kept `any` on purpose: this is the published signature. The proxy layer itself only ever
  // passes a StoreDevToolsAction (see ProxyContext.emit).
  emitDevAction(action: any): void;
  cleanupPath(path: string): void;
  /** Typed reactivity binding (replaces `(this as any).__wakeX` casts). */
  bindReactivity?(api: SolidStoreReactivity): void;
  /** Typed wake-parents flag (read by the proxy manager's shouldWakeParents getter). */
  _wakeParentsOnChange?: boolean;
}

export type { SolidWakeMode };

export interface SolidProxyOptions {
  strictInvalidPath?: boolean;
  strictDeleteUndefined?: boolean;

  /**
   * Controls wake-up behavior after mutations.
   *
   * - false (default): Maximum granularity. Only the exact changed leaf signal is dirtied.
   *   Solid automatically notifies only the memos/effects that read that precise path.
   *   This is the "fine-grained Solid way".
   *
   * - true: Container-style (legacy behavior). On change we also walk and dirty parent signals
   *   on the path. Useful if you have code that relies on parent-level effects firing when
   *   anything inside changes.
   *
   * Recommendation: keep default (false) for best performance and granularity.
   */
  wakeParentsOnChange?: boolean;

  /**
   * @internal Test-only instrumentation hook.
   * Allows verify.ts (and future harnesses) to observe exactly which paths trigger signal updates.
   * Zero impact on production paths. Enables real measurement of grained vs container wakeUp behavior.
   */
  _onSignalUpdate?: (path: string) => void;
}
