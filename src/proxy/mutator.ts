import type { JsonMutationResult } from '@adsq/jsnq/data-engine';
import { deleteResult, setResult } from '../internal/mutation-results';
import type { StoreMutator } from './types';

/** Builds a full StoreMutator from a minimal read/write pair; every other member has a no-op default. */
export function createStoreMutator(base: {
  read(p: string): unknown;
  write(p: string, v: unknown): void | JsonMutationResult;
} & Partial<StoreMutator>): StoreMutator {
  return {
    read: base.read,
    write: (p, v) => {
      const previous = base.read(p);
      return base.write(p, v) ?? setResult(p, previous, v);
    },
    batch: base.batch ?? (f => f()),
    delete: base.delete ?? ((p) => {
      const previous = base.read(p);
      return base.write(p, undefined) ?? deleteResult(p, previous);
    }),
    prefetch: base.prefetch ?? (() => {}),
    emitDevAction: base.emitDevAction ?? (() => {}),
    cleanupPath: base.cleanupPath ?? (() => {}),
  };
}
