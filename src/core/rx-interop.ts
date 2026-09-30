import { createEffect, createRoot } from 'solid-js';
import type { StoreSubscription } from './proxy-types';

const INITIAL = Symbol('initial');

export type ProjectionObservableOptions<T> = {
  equals?: (a: T, b: T) => boolean;
  immediate?: boolean;
  onError?: (error: unknown) => void;
};

export function createProjectionObservable<T>(
  accessor: () => T,
  options: ProjectionObservableOptions<T> = {}
) {
  const equals = options.equals ?? Object.is;
  const immediate = options.immediate ?? true;
  const reportError = (error: unknown) => {
    if (options.onError) options.onError(error);
    else queueMicrotask(() => { throw error; });
  };

  return {
    subscribe(cb: (v: T) => void) {
      let last: T | typeof INITIAL = INITIAL;
      let initialized = false;

      const emit = (value: T) => {
        if (last !== INITIAL && equals(last, value)) return;
        last = value;
        // Without `immediate`, the first value only primes `last`.
        const skip = !immediate && !initialized;
        initialized = true;
        if (skip) return;
        try { cb(value); } catch (error) { reportError(error); }
      };

      const dispose = createRoot((dispose) => {
        createEffect(() => emit(accessor()));
        return dispose;
      });

      return { unsubscribe: dispose, dispose };
    },
    get value() { return accessor(); },
  };
}

/** Runs `fn` at most once; later calls are no-ops. */
export function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/**
 * Wraps an underlying subscription so closing is idempotent: the first close unsubscribes `sub`
 * and then runs `onClose` (release ref-counts, ...); repeated closes do nothing.
 */
export function subscription(sub: { unsubscribe(): void }, onClose?: () => void): StoreSubscription {
  const close = once(() => {
    sub.unsubscribe();
    onClose?.();
  });
  return { unsubscribe: close, dispose: close };
}
