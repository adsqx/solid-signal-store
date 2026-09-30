// Callable proxy, path-indexed reactivity and store dispatch for Solid: one Proxy per path, backed by
// that path's signal, plus the registry that keeps them unique and the helper that builds a mutator.

import type { JsonMutationResult } from '@adsq/jsnq/data-engine';
import { deleteResult, setResult } from '../internal/util';
import { isValidPath, normalizePath } from '../internal/path';
import { NodeHandler } from './proxy-handler';
import { WakeEngine } from './wake-engine';
import type { MutatorSurface, ProxyContext, SolidProxyOptions, StoreMutator } from './types';

export type { SolidProxyOptions, SolidWakeMode, StoreMutator } from './types';

/** Live proxies by path, held weakly so an unreferenced node can be collected. */
export class ProxyRegistry {
  private proxies = new Map<string, WeakRef<object>>();
  private finalization?: FinalizationRegistry<string>;

  constructor() {
    if (typeof FinalizationRegistry !== 'undefined') {
      this.finalization = new FinalizationRegistry((path: string) => {
        if (!this.proxies.get(path)?.deref()) this.proxies.delete(path);
      });
    }
  }

  get size(): number {
    return this.proxies.size;
  }

  get(path: string): object | undefined {
    const ref = this.proxies.get(path);
    const proxy = ref?.deref();
    if (ref && !proxy) this.proxies.delete(path);
    return proxy;
  }

  set(path: string, proxy: object): void {
    this.proxies.set(path, new WeakRef(proxy));
    this.finalization?.register(proxy, path);
  }

  clear(): void {
    this.proxies.clear();
    this.finalization = undefined;
  }
}

/** Builds a full StoreMutator from a minimal read/write pair; every other member has a no-op default. */
export function createStoreMutator(base: {
  read(p: string): unknown;
  write(p: string, v: unknown): void | JsonMutationResult;
} & Partial<StoreMutator>): StoreMutator {
  return {
    read: base.read,
    write: (p, v) => {
      const previous = base.read(p);
      return base.write(p, v) ?? setResult(p, previous, v);
    },
    batch: base.batch ?? (f => f()),
    delete: base.delete ?? ((p) => {
      const previous = base.read(p);
      return base.write(p, undefined) ?? deleteResult(p, previous);
    }),
    prefetch: base.prefetch ?? (() => {}),
    emitDevAction: base.emitDevAction ?? (() => {}),
    cleanupPath: base.cleanupPath ?? (() => {}),
  };
}

export function createSolidProxy<T>(mutator: StoreMutator, options: SolidProxyOptions = {}): T {
  if (options.wakeParentsOnChange !== undefined) mutator._wakeParentsOnChange = options.wakeParentsOnChange;
  const registry = new ProxyRegistry();
  const engine = new WakeEngine(mutator, options._onSignalUpdate, registry);
  const ctx: ProxyContext = { mutator, surface: mutator as unknown as MutatorSurface, opts: options, engine, registry, factory: make };

  function make(path: string): object {
    const cached = registry.get(path);
    if (cached) return cached;

    const [read] = engine.getSignal(path);
    const fn = (() => read()) as () => unknown;
    // Visible to `in` and descriptor lookups; reads themselves are answered by the get trap.
    Object.defineProperties(fn, {
      $val: { get: read, configurable: true },
      $signal: { get: () => read, configurable: true },
    });

    const proxy = new Proxy(fn, new NodeHandler(ctx, path, read));
    registry.set(path, proxy);
    mutator.prefetch(path);
    ensureParents(path);
    return proxy;
  }

  // Every ancestor proxy exists, root first. Paths that do not normalize to a valid path (a segment with
  // '-', a leading digit, a forbidden name) have no ancestors here, which also keeps container-mode
  // parent wake off for them.
  function ensureParents(path: string): void {
    if (!path.includes('.') || !isValidPath(path)) return;
    const normalized = path.includes('[') ? normalizePath(path) : path;
    for (let dot = normalized.indexOf('.'); dot !== -1; dot = normalized.indexOf('.', dot + 1)) {
      const parent = normalized.slice(0, dot);
      if (!registry.get(parent)) make(parent);
    }
  }

  mutator.bindReactivity?.(engine);
  return make('') as T;
}
