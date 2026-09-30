// The Proxy traps of one node: reads resolve to special keys, dispatch methods or cached child proxies;
// writes and deletes go through the store mutator and wake the touched signals.

import { isValidPath } from '../internal/path';
import { ARRAY_METHODS } from '../array/solid-array';
import { isBranch } from '../internal/guards';
import type { ProjectionObservableOptions } from '../core/rx-interop';
import type { ProxyContext } from './proxy-context';
import {
  createArrayMethodHandler, createDispatchHandler, createRootDispatchHandler,
  isDispatchMethod, isRootDispatchMethod, subscribePath,
} from './proxy-dispatch';

const MAX_CHILD_CACHE_SIZE = 256;

const childPath = (parent: string, key: string): string => (parent ? `${parent}.${key}` : key);

function symbolProperty(k: symbol, get: () => unknown): unknown {
  if (k === Symbol.toPrimitive) {
    return (hint: string) => {
      const v = get();
      return typeof v === 'object' ? (hint === 'number' ? NaN : JSON.stringify(v)) : v;
    };
  }
  if (k === Symbol.toStringTag) {
    return () => {
      const v = get();
      try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { return String(v); }
    };
  }
  return undefined;
}

export function createProxyHandler(ctx: ProxyContext, path: string, get: () => unknown): ProxyHandler<object> {
  const childCache: Record<string, object> = Object.create(null);
  let childCacheSize = 0;

  return {
    get(_: object, k: PropertyKey) {
      if (typeof k === 'symbol') return symbolProperty(k, get);
      const ks = String(k);

      switch (ks) {
        case '$val':
          return get();
        case 'toString':
          return () => String(get());
        case 'valueOf':
        case 'toJSON':
        case '$signal':
          return get;
        case 'length': {
          const value = get();
          return Array.isArray(value) ? value.length : undefined;
        }
      }

      // opinia5: $subscribe(cb, options) on any node — observe this path's value. Registers
      // branch interest so a subscription on an object/array also fires on descendant changes,
      // without flipping the whole store into container mode. Returns { unsubscribe, dispose }.
      if (ks === '$subscribe') {
        return (cb: (value: unknown) => void, options?: ProjectionObservableOptions<unknown>) =>
          subscribePath(ctx, path, get, cb, options);
      }
      if (path === '' && isRootDispatchMethod(ks)) return createRootDispatchHandler(ctx, ks);

      // opinia5: $-prefixed aliases so a data key literally named `mutate`/`query`/`select`/… does
      // not shadow the store operations. Back-compat: bare names stay.
      if (isDispatchMethod(ks)) return createDispatchHandler(ctx, childPath(path, ks), ks);
      if (ARRAY_METHODS.has(ks)) return createArrayMethodHandler(ctx, path, ks, get);

      // Child proxy identity is stable for the store lifetime. A per-parent cache
      // avoids rebuilding the full path and consulting the global map on every read.
      const cached = childCache[ks];
      if (cached) return cached;
      const child = ctx.factory(childPath(path, ks));
      if (childCacheSize >= MAX_CHILD_CACHE_SIZE) {
        for (const key in childCache) delete childCache[key];
        childCacheSize = 0;
      }
      childCache[ks] = child;
      childCacheSize++;
      return child;
    },

    set(_: object, k: PropertyKey, v: unknown) {
      return typeof k === 'symbol' ? false : setProperty(ctx, childPath(path, String(k)), v);
    },

    deleteProperty(_: object, k: PropertyKey) {
      return typeof k === 'symbol' ? false : deleteProperty(ctx, childPath(path, String(k)));
    },
  };
}

function setProperty(ctx: ProxyContext, tp: string, v: unknown): boolean {
  const { mutator, engine, opts } = ctx;
  if (v === undefined && opts.strictDeleteUndefined) throw new Error(`strict: set undefined ${tp}`);
  if (opts.strictInvalidPath && !isValidPath(tp)) throw new Error(`strict: invalid path ${tp}`);

  const writeAndSync = () => engine.wakeMutation(v === undefined ? mutator.delete(tp) : mutator.write(tp, v));
  // A lone primitive leaf needs no batch: it dirties a single signal.
  if (v !== undefined && !isBranch(v) && !mutator._wakeParentsOnChange) writeAndSync();
  else mutator.batch(writeAndSync);

  ctx.emit({ type: 'SET_VALUE', payload: { path: tp, value: v } });
  return true;
}

function deleteProperty(ctx: ProxyContext, tp: string): boolean {
  const { mutator, engine, opts } = ctx;
  if (opts.strictDeleteUndefined) throw new Error(`strict: delete ${tp}`);
  if (opts.strictInvalidPath && !isValidPath(tp)) throw new Error(`strict: invalid path ${tp}`);

  mutator.batch(() => engine.wakeMutation(mutator.delete(tp)));
  ctx.emit({ type: 'DELETE', payload: { path: tp } });
  return true;
}
