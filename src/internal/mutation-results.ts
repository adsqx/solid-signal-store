import { createMutationResult, type JsonMutationResult } from '@adsq/jsnq/data-engine';
import { isBranch } from './guards';

/** A `set` of one path. `existed` defaults to "previous is not undefined". */
export function setResult(
  path: string,
  previous: unknown,
  next: unknown,
  existed: boolean = previous !== undefined,
  branchReplaced: boolean = isBranch(previous) || isBranch(next),
): JsonMutationResult {
  return createMutationResult({
    path,
    kind: 'set',
    previous,
    next,
    existed,
    changed: [path],
    inserted: existed ? [] : [path],
    branchReplaced,
    affectedPaths: [path],
  });
}

/** A `delete` of one path. `existed` defaults to "previous is not undefined". */
export function deleteResult(
  path: string,
  previous: unknown,
  existed: boolean = previous !== undefined,
  branchReplaced: boolean = isBranch(previous),
): JsonMutationResult {
  return createMutationResult({
    path,
    kind: 'delete',
    previous,
    existed,
    deleted: existed ? [path] : [],
    branchReplaced,
    affectedPaths: [path],
  });
}

/** Wake-only marker for a path whose data was already written: changed, no value payload, no branch replace. */
export function touchResult(path: string): JsonMutationResult {
  return createMutationResult({ path, kind: 'set', changed: [path], affectedPaths: [path], branchReplaced: false });
}
