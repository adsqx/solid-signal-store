// Proxy creation: one callable Proxy per path, backed by that path's signal.

import { isValidPath, normalizePath } from '../internal/path';
import { NodeHandler } from './proxy-handler';
import type { MutatorSurface, ProxyContext } from './proxy-context';
import { ProxyRegistry } from './proxy-registry';
import { WakeEngine } from './wake-engine';
import type { SolidProxyOptions, StoreMutator } from './types';

export class ProxyManager {
  private readonly ctx: ProxyContext;
  readonly engine: WakeEngine;

  constructor(mutator: StoreMutator, opts: SolidProxyOptions) {
    // Respect initial option for low-level usage
    if (opts.wakeParentsOnChange !== undefined) mutator._wakeParentsOnChange = opts.wakeParentsOnChange;

    const registry = new ProxyRegistry();
    this.engine = new WakeEngine(mutator, opts._onSignalUpdate, registry);
    this.ctx = {
      mutator,
      surface: mutator as unknown as MutatorSurface,
      opts,
      engine: this.engine,
      registry,
      factory: (path) => this.make(path),
    };
  }

  make(path: string): object {
    const { registry, mutator } = this.ctx;
    const cached = registry.get(path);
    if (cached) return cached;

    const [read] = this.engine.getSignal(path);
    const fn = (() => read()) as () => unknown;
    // Visible to `in` and descriptor lookups; reads themselves are answered by the get trap.
    Object.defineProperties(fn, {
      $val: { get: read, configurable: true },
      $signal: { get: () => read, configurable: true },
    });

    const proxy = new Proxy(fn, new NodeHandler(this.ctx, path, read));
    registry.set(path, proxy);
    mutator.prefetch(path);
    this.ensureParents(path);
    return proxy;
  }

  /**
   * Makes sure every ancestor proxy exists, root first. Paths that do not normalize to a valid path
   * (a segment with '-', a leading digit, a forbidden name) have no ancestors here, which is also what
   * keeps container-mode parent wake off for them.
   */
  private ensureParents(path: string): void {
    if (!path.includes('.') || !isValidPath(path)) return;
    const normalized = path.includes('[') ? normalizePath(path) : path;
    const { registry, factory } = this.ctx;
    for (let dot = normalized.indexOf('.'); dot !== -1; dot = normalized.indexOf('.', dot + 1)) {
      const parent = normalized.slice(0, dot);
      if (!registry.get(parent)) factory(parent);
    }
  }
}
