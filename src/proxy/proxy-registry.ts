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
