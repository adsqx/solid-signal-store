// Callable proxy, path-indexed reactivity, and store dispatch for Solid.

import { ProxyManager } from './proxy-manager';
import type { SolidProxyOptions, StoreMutator } from './types';

export { createStoreMutator } from './mutator';
export type { SolidProxyOptions, SolidWakeMode, StoreMutator } from './types';

export function createSolidProxy<T>(mutator: StoreMutator, options: SolidProxyOptions = {}): T {
  const manager = new ProxyManager(mutator, options);
  // Typed reactivity binding: the store wakes proxy-owned signals through the engine.
  mutator.bindReactivity?.(manager.engine);
  return manager.make('') as T;
}
