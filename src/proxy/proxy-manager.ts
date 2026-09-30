// Proxy creation: one callable Proxy per path, backed by that path's signal.

import { createProxyHandler } from './proxy-handler';
import type { MutatorSurface, NodeFactory, ProxyContext } from './proxy-context';
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
    const factory: NodeFactory = (path) => this.make(path);
    this.ctx = {
      mutator,
      surface: mutator as unknown as MutatorSurface,
      opts,
      engine: this.engine,
      registry,
      factory,
      emit: (action) => mutator.emitDevAction(action),
    };
  }

  make(path: string): object {
    const { ctx } = this;
    const cached = ctx.registry.get(path);
    if (cached) return cached;

    const [get] = this.engine.getSignal(path);
    const fn = (() => get()) as () => unknown;
    Object.defineProperty(fn, '$val', { get: () => get(), enumerable: false, configurable: true });
    Object.defineProperty(fn, '$signal', { get: () => get, enumerable: false, configurable: true });

    const proxy = new Proxy(fn, createProxyHandler(ctx, path, get));
    ctx.registry.set(path, proxy);
    ctx.mutator.prefetch(path);
    this.ensureParents(path);
    return proxy;
  }

  /** Ensure all parent proxies exist for a deep path (root-first), and prefetch each. */
  private ensureParents(path: string): void {
    if (!path.includes('.')) return;
    for (const parent of this.engine.parentTargets(path)) {
      if (!this.ctx.registry.get(parent)) this.ctx.factory(parent);
      this.ctx.mutator.prefetch(parent);
    }
  }
}
