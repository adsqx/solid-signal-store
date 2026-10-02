// Named store registry (useSolidStore + createStore(name) parity with SignalStore) and waitForStore.
import type { SolidStore } from './SolidStore';

/** All the registry needs from a store; keeps it independent of the store's type parameter. */
interface RegisteredStore {
  destroy(): void;
}

export interface WaitForStoreOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const stores = new Map<string, RegisteredStore>();
// Pending waitForStore callers per name; each callback releases its own timer/abort listener.
const waiters = new Map<string, Set<(store: RegisteredStore) => void>>();

/** Registers `store` under `name` and resolves any `waitForStore(name)` calls already pending. */
export function registerStore(name: string, store: RegisteredStore): void {
  stores.set(name, store);
  const pending = waiters.get(name);
  waiters.delete(name);
  pending?.forEach((notify) => notify(store));
}

/** Removes `name` only if it still points at `store` (a newer store may have replaced it). */
export function unregisterStore(name: string, store: RegisteredStore): void {
  if (stores.get(name) === store) stores.delete(name);
}

/** Destroys and replaces a previously registered store of the same name, if any. */
export function destroyRegistered(name: string): void {
  stores.get(name)?.destroy();
}

export function useSolidStore<T extends object = any>(name = 'default'): SolidStore<T> {
  const store = stores.get(name);
  if (!store) throw new Error(`[SolidStore] useSolidStore('${name}'): store not found. Create first.`);
  return store as SolidStore<T>;
}

export function waitForStore<T extends object = any>(
  name = 'default',
  options: WaitForStoreOptions = {}
): Promise<SolidStore<T>> {
  const existing = stores.get(name);
  if (existing) return Promise.resolve(existing as SolidStore<T>);

  const { signal, timeoutMs } = options;
  const abortError = () => Object.assign(new Error(`[SolidStore] waitForStore('${name}') aborted.`), { name: 'AbortError' });
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise<SolidStore<T>>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = waiters.get(name) ?? new Set();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const notify = (store: RegisteredStore) => {
      cleanup();
      resolve(store as SolidStore<T>);
    };
    const fail = (error: Error) => {
      pending.delete(notify);
      if (pending.size === 0) waiters.delete(name);
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(abortError());

    pending.add(notify);
    waiters.set(name, pending);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      const ms = Math.max(0, timeoutMs);
      timer = setTimeout(() => fail(new Error(`[SolidStore] waitForStore('${name}') timed out after ${ms}ms.`)), ms);
    }
  });
}
