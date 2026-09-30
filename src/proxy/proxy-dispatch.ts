// Methods a proxy node hands out instead of child proxies: store dispatch, array ops, $subscribe.

import { getParentPath } from '../internal/path';
import { createProjectionObservable, type ProjectionObservableOptions } from '../core/rx-interop';
import type { NodeMethod } from './proxy-registry';
import type { ProxyContext } from './proxy-context';

/** Names dispatched to the store with the node's own path prepended. */
const DISPATCH_METHODS = new Set([
  'mutate', 'pipe', 'array', 'select', 'query', 'computedOf',
  '$mutate', '$pipe', '$array', '$select', '$computedOf', '$query', '$queryOne', '$liveQuery', '$liveQueryOne',
]);
/** Names only the root node dispatches, without a path. */
const ROOT_METHODS = new Set(['setValue', 'readStore', 'deleteValue', 'wakeUp', 'batch']);

export const isDispatchMethod = (method: string): boolean => DISPATCH_METHODS.has(method);
export const isRootDispatchMethod = (method: string): boolean => ROOT_METHODS.has(method);

/** Dispatches `store.<path>.<method>(...)` to the store method of that name (or of its `$`-less alias). */
export function createDispatchHandler(ctx: ProxyContext, childPath: string, method: string): NodeMethod {
  return (...args) => {
    // Use the exact method when the store defines it ($query/$liveQuery/... are dedicated), otherwise
    // strip the leading '$' ($mutate -> mutate, $select -> select, ...).
    const target = typeof ctx.surface[method] === 'function'
      ? ctx.surface[method]
      : ctx.surface[method.charCodeAt(0) === 36 /* '$' */ ? method.slice(1) : method];
    const parentPath = getParentPath(childPath) ?? '';
    ctx.emit({ type: 'PROXY_DISPATCH', payload: { path: parentPath, method } });
    return typeof target === 'function' ? target.call(ctx.mutator, parentPath, ...args) : undefined;
  };
}

export function createRootDispatchHandler(ctx: ProxyContext, method: string): NodeMethod {
  return (...args) => {
    ctx.emit({ type: 'PROXY_DISPATCH', payload: { path: '', method } });
    const target = ctx.surface[method];
    return typeof target === 'function' ? target.call(ctx.mutator, ...args) : undefined;
  };
}

export function createArrayMethodHandler(ctx: ProxyContext, path: string, method: string, get: () => unknown): NodeMethod {
  return ctx.registry.arrayHandler(path, method, () => (...args) => {
    ctx.emit({ type: 'ARRAY_DISPATCH', payload: { path, method, args } });
    return ctx.surface.arrayOp?.call(ctx.mutator, path, method, args, get());
  });
}

// opinia5: value subscription for a path (backs $subscribe). Registers branch interest so a
// subscription on an object/array also fires on descendant mutations, then cleans it up.
export function subscribePath(
  ctx: ProxyContext,
  path: string,
  get: () => unknown,
  cb: (value: unknown) => void,
  options?: ProjectionObservableOptions<unknown>,
): { unsubscribe(): void; dispose(): void } {
  ctx.engine.addBranchSub(path);
  const sub = createProjectionObservable(get, options).subscribe(cb);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sub.unsubscribe();
    ctx.engine.removeBranchSub(path);
  };
  return { unsubscribe: close, dispose: close };
}
