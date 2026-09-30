/** True for non-null objects (arrays included, functions excluded) — the "branch" test used across the store. */
export function isBranch(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}
