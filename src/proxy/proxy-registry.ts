/** Live proxies by path (weakly held) plus the per-path array method handlers built for them. */
export type NodeMethod = (...args: unknown[]) => unknown;

export class ProxyRegistry {
  private proxies = new Map<string, WeakRef<object>>();
  private arrayHandlers = new Map<string, NodeMethod>();
  private finalization?: FinalizationRegistry<string>;

  constructor() {
    if (typeof FinalizationRegistry !== 'undefined') {
      this.finalization = new FinalizationRegistry((path: string) => {
        if (!this.proxies.get(path)?.deref()) {
          this.proxies.delete(path);
          this.deleteArrayHandlers(path);
        }
      });
    }
  }

  get size(): number {
    return this.proxies.size;
  }

  get(path: string): object | undefined {
    const proxy = this.proxies.get(path)?.deref();
    if (!proxy) this.proxies.delete(path);
    return proxy;
  }

  set(path: string, proxy: object): void {
    this.proxies.set(path, new WeakRef(proxy));
    this.finalization?.register(proxy, path);
  }

  arrayHandler(path: string, method: string, build: () => NodeMethod): NodeMethod {
    const key = `${path}\u0000${method}`;
    let handler = this.arrayHandlers.get(key);
    if (!handler) this.arrayHandlers.set(key, (handler = build()));
    return handler;
  }

  private deleteArrayHandlers(path: string): void {
    const prefix = `${path}\u0000`;
    for (const key of this.arrayHandlers.keys()) {
      if (key.startsWith(prefix)) this.arrayHandlers.delete(key);
    }
  }

  clear(): void {
    this.proxies.clear();
    this.arrayHandlers.clear();
    this.finalization = undefined;
  }
}
