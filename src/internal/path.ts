/**
 * Path parsing for the store. Syntax, validation, parsing caches and dependency paths are jsnq's dot
 * paths, shared with the Angular store; this module keeps the store's public names and the helpers
 * with store-specific semantics (pathExists, resolveParentAndKey, ensurePathIn, cloneJson).
 */
import {
  clearDotPathCaches, dotPathAncestors, dotPathParent, getJsonBySegments, isValidDotPath, isValidNormalizedDotPath,
  normalizeDotPath, resolveDependencyPath, splitDotPath, writeJsonPathValue,
} from '@adsq/jsnq/data-engine';

export type PathSegments = readonly string[];
export type VersionDependencyMode = 'exact' | 'container';

interface ResolveVersionPathOptions {
  dependencyMode: VersionDependencyMode;
  bumpNumericParent: boolean;
}

const NUMERIC_RE = /^\d+$/;
const FORBIDDEN_PATH_RE = /(?:^|\.)(?:__proto__|prototype|constructor)(?:\.|$)/;

const isTraversable = (value: unknown): value is Record<string, unknown> =>
  value != null && (typeof value === 'object' || typeof value === 'function');
const isNumeric = (segment: string | undefined): boolean => !!segment && NUMERIC_RE.test(segment);

export const clearPathCaches = clearDotPathCaches;
export const normalizePath = normalizeDotPath;
export const isValidNormalizedPath = isValidNormalizedDotPath;
export const isValidPath = isValidDotPath;

export function resolveVersionPath(normalized: string, options: ResolveVersionPathOptions): string {
  return resolveDependencyPath(normalized, options);
}

/** Segments of a path in any notation, without empty segments. Cached: never mutate the result. */
export function splitPath(path: string): string[] {
  const segments = splitDotPath(normalizeDotPath(path));
  return (segments.includes('') ? segments.filter(Boolean) : segments) as string[];
}

export function getParentPath(path: string): string | null {
  return typeof path === 'string' && isValidDotPath(path) ? dotPathParent(normalizeDotPath(path)) : null;
}

/** Ancestor-or-self paths, deepest first. Empty for invalid paths. */
// `options` is accepted for compatibility: a numeric segment's parent is always already listed.
export function enumerateAncestors(path: string, options: { includeNumericParent?: boolean } = {}): string[] {
  return dotPathAncestors(path);
}

export function getBySegments(obj: unknown, segments: PathSegments): unknown {
  return getJsonBySegments(obj, segments);
}

export function getByPath(obj: unknown, path: string): unknown {
  if (!obj) return undefined;
  return path ? getBySegments(obj, splitPath(path)) : obj;
}

export function setByPath(obj: unknown, path: string, value: unknown): void {
  if (!obj || !path) return;
  // Delegated to jsnq: same resulting tree and the same rejection of forbidden segments
  // (proven in test/path-core-jsnq-parity.test.ts), and faster because it reuses the cached
  // path plan (82.1ms -> 39.1ms on repeated paths, 200k writes).
  writeJsonPathValue(obj, path, value);
}

/** True when every segment exists as an own key (a present `undefined` counts); array indices are bounds-checked. */
export function pathExists(obj: unknown, path: string): boolean {
  if (!obj || typeof obj !== 'object' || !path) return false;
  const normalized = normalizeDotPath(path);
  if (FORBIDDEN_PATH_RE.test(normalized)) return false;
  let current: unknown = obj;
  for (const segment of normalized.split('.')) {
    if (current == null || typeof current !== 'object') return false;
    if (Array.isArray(current) && isNumeric(segment)) {
      if (Number(segment) >= current.length) return false;
      current = current[Number(segment)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return false;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return true;
}

// `parent` stays `any` on purpose: this is public API (InternalPath) and callers index into it.
export function resolveParentAndKey(obj: unknown, path: string): { parent: any; key: string | null; segments: string[] } {
  const segments = [...splitPath(path)]; // a fresh array: callers own it
  if (segments.length === 0) return { parent: obj, key: null, segments };
  const key = segments[segments.length - 1]!;
  let parent: unknown = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    if (!isTraversable(parent)) return { parent: undefined, key, segments };
    parent = parent[segments[i]!];
  }
  return { parent, key, segments };
}

export const getParentSegments = (segments: PathSegments): PathSegments => (segments?.length > 1 ? segments.slice(0, -1) : []);

/** Creates the missing containers along `segments` (arrays before numeric segments) and returns the innermost. */
export function ensurePathIn(target: unknown, segments: PathSegments): unknown {
  let current = target as Record<string, unknown>;
  for (let i = 0; i < segments.length; i++) {
    if (!isTraversable(current)) return target;
    const segment = segments[i]!;
    if (!isTraversable(current[segment])) current[segment] = isNumeric(segments[i + 1]) ? [] : {};
    current = current[segment] as Record<string, unknown>;
  }
  return current;
}

export function cloneJson<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  }
}
