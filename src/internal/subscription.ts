/** Runs `fn` at most once; later calls are no-ops. */
export function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** A closable handle whose `unsubscribe` and `dispose` are the same idempotent close. */
export interface Subscription {
  unsubscribe(): void;
  dispose(): void;
}

/**
 * Wraps an underlying subscription so closing is idempotent: the first close unsubscribes `sub`
 * and then runs `onClose` (release ref-counts, ...); repeated closes do nothing.
 */
export function subscription(sub: { unsubscribe(): void }, onClose?: () => void): Subscription {
  const close = once(() => {
    sub.unsubscribe();
    onClose?.();
  });
  return { unsubscribe: close, dispose: close };
}
