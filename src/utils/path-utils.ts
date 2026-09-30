/** Frozen `PathUtils.x(...)` facade over internal/path.ts, the single source of truth for path parsing. */
import {
  enumerateAncestors,
  getByPath,
  getParentPath,
  isValidNormalizedPath,
  isValidPath,
  normalizePath,
  pathExists,
  resolveVersionPath,
  setByPath,
  splitPath,
} from '../internal/path';

export type StoreData = Record<string, unknown>;
export type { VersionDependencyMode } from '../internal/path';

export const PathUtils = Object.freeze({
  normalizePath,
  splitNormalizedPath: (normalized: string): readonly string[] => splitPath(normalized),
  // A falsy path yields undefined here (not the root object, unlike internal getByPath).
  getByPath: (obj: unknown, path: string): unknown => (obj && path ? getByPath(obj, path) : undefined),
  setByPath,
  isValidPath,
  isValidNormalizedPath,
  getParentPath,
  pathExists,
  resolveVersionPath,
  enumerateAncestors,
});

export type PathUtils = typeof PathUtils;
