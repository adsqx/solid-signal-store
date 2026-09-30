/**
 * Wake modes and whether each one walks the ancestor ("branch") signals.
 * Single source for the mode list, the `SolidWakeMode` type and the branch/exact split.
 */
export const WAKE_MODE_BRANCH = {
  grained: false,
  fine: false,
  exact: false,
  container: true,
  parents: true,
  leaf: true,
  branch: true,
} as const satisfies Record<string, boolean>;

export type SolidWakeMode = keyof typeof WAKE_MODE_BRANCH;

/** Own-key check, so inherited names such as `constructor` are never mistaken for a mode. */
export function isWakeMode(value: unknown): value is SolidWakeMode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WAKE_MODE_BRANCH, value);
}
