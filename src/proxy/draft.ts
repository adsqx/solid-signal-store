// `$draft`: a plain-JSON write view over the store. Reads peek at the raw data (never subscribe) and
// hand out draft proxies for objects/arrays; writes, deletes and array mutators route through the
// store's own write path (the store proxy's set/delete traps, `arrayOp`), so wakes and devtools events
// are exactly those of `store.a.b = v`. Each proxy reads its path's CURRENT value on every access.

import { cloneJsonData } from '@adsq/jsnq/data-engine';
import { BoundedCache, isBranch } from '../internal/util';
import type { ProxyContext } from './types';

const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
const RETURNS_SELF = new Set(['sort', 'reverse', 'fill', 'copyWithin']);
const HAS_OWN = Object.prototype.hasOwnProperty;

interface View { readonly proxy: object; readonly array: boolean }
const VIEWS = new WeakMap<object, { ctx: ProxyContext; path: string }>(); // draft proxy -> its location
const CACHES = new WeakMap<ProxyContext, BoundedCache<string, View>>(); // per store: path -> proxy

const childPath = (parent: string, key: string): string => (parent ? `${parent}.${key}` : key);

/** Draft proxies (also nested inside plain values) become detached copies of their current value. */
function unwrap(value: unknown): unknown {
  if (!isBranch(value)) return value;
  const view = VIEWS.get(value);
  if (view) return cloneJsonData(view.ctx.mutator.read(view.path));
  let out = value as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const inner = (value as Record<string, unknown>)[key];
    const next = unwrap(inner);
    if (next === inner) continue;
    if (out === value) out = Array.isArray(value) ? (value.slice() as unknown as Record<string, unknown>) : { ...out };
    out[key] = next;
  }
  return out;
}

function viewOf(ctx: ProxyContext, path: string, value: unknown): unknown {
  if (!isBranch(value)) return value;
  const array = Array.isArray(value);
  const cache = CACHES.get(ctx) ?? (CACHES.set(ctx, new BoundedCache(1024)), CACHES.get(ctx)!);
  const hit = cache.get(path);
  if (hit && hit.array === array) return hit.proxy;
  const proxy = new Proxy(array ? [] : {}, new DraftHandler(ctx, path));
  VIEWS.set(proxy, { ctx, path });
  cache.set(path, { proxy, array });
  return proxy;
}

/** The draft view rooted at `path` (a primitive value is returned as is). */
export const draftView = (ctx: ProxyContext, path: string): unknown => viewOf(ctx, path, ctx.mutator.read(path));

class DraftHandler implements ProxyHandler<object> {
  constructor(private readonly ctx: ProxyContext, private readonly path: string) {}

  // The current value at this path; a proxy whose path changed kind (object <-> array) views as empty.
  private cur(target: object): object {
    const value = this.ctx.mutator.read(this.path);
    return isBranch(value) && Array.isArray(value) === Array.isArray(target) ? value : target;
  }

  private mutate(method: string) {
    return (...args: unknown[]): unknown => {
      const { mutator, surface } = this.ctx;
      const plain = args.map(unwrap);
      mutator.emitDevAction({ type: 'ARRAY_DISPATCH', payload: { path: this.path, method, args: plain } });
      const result = surface.arrayOp?.call(mutator, this.path, method, plain);
      return RETURNS_SELF.has(method) ? draftView(this.ctx, this.path) : result;
    };
  }

  get(target: object, key: string | symbol): unknown {
    const cur = this.cur(target);
    if (typeof key === 'symbol') return Reflect.get(cur, key);
    if (Array.isArray(cur) && MUTATORS.has(key)) return this.mutate(key);
    const value = (cur as Record<string, unknown>)[key];
    // Inherited members (Array.prototype.find, ...) are returned as is and run over this proxy.
    return HAS_OWN.call(cur, key) ? viewOf(this.ctx, childPath(this.path, key), value) : value;
  }

  set(target: object, key: string | symbol, value: unknown): boolean {
    if (typeof key === 'symbol') return false;
    const cur = this.cur(target);
    const plain = unwrap(value);
    if (Array.isArray(cur) && key === 'length') {
      if (plain !== cur.length) {
        const next = cur.slice();
        next.length = Number(plain);
        this.ctx.surface.setValue?.call(this.ctx.mutator, this.path, next);
      }
      return true;
    }
    (this.ctx.factory(this.path) as Record<string, unknown>)[key] = plain; // the store's own set trap
    return true;
  }

  deleteProperty(_: object, key: string | symbol): boolean {
    if (typeof key === 'symbol') return false;
    delete (this.ctx.factory(this.path) as Record<string, unknown>)[key];
    return true;
  }

  defineProperty(target: object, key: string | symbol, desc: PropertyDescriptor): boolean {
    return 'value' in desc ? this.set(target, key, desc.value) : false;
  }

  has(target: object, key: string | symbol): boolean { return Reflect.has(this.cur(target), key); }
  ownKeys(target: object): (string | symbol)[] { return Reflect.ownKeys(this.cur(target)); }
  preventExtensions(): boolean { return false; }

  getOwnPropertyDescriptor(target: object, key: string | symbol): PropertyDescriptor | undefined {
    const desc = Reflect.getOwnPropertyDescriptor(this.cur(target), key);
    // Non-configurable (array length) is reported as is; the rest as plain writable data properties.
    return !desc || desc.configurable === false ? desc : { ...desc, value: this.get(target, key), configurable: true };
  }
}
