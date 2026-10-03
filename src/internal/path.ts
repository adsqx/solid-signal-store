/**
 * Path parsing for the store: the single source of truth (`utils/path-utils.ts` is only a facade).
 * Normalization and splitting are cached because the proxy resolves the same paths repeatedly.
 */
import { getJsonBySegments, writeJsonPathValue } from '@adsq/jsnq/core/data-engine';
import { BoundedCache } from './util';

export type PathSegments = readonly string[];
export type VersionDependencyMode = 'exact' | 'container';

interface ResolveVersionPathOptions {
  dependencyMode: VersionDependencyMode;
  bumpNumericParent: boolean;
}

const VALID_PATH_RE = /^[a-zA-Z_$][\w$]*(\.[\w$]+)*$/;
const FORBIDDEN_PATH_RE = /(?:^|\.)(?:__proto__|prototype|constructor)(?:\.|$)/;
const NUMERIC_RE = /^\d+$/;
const BRACKET_RE = /\[(.*?)\]/g;

const isTraversable = (value: unknown): value is Record<string, unknown> =>
  value != null && (typeof value === 'object' || typeof value === 'function');
const isNumeric = (segment: string | undefined): boolean => !!segment && NUMERIC_RE.test(segment);
const parentOf = (normalized: string): string | null => {
  const dot = normalized.lastIndexOf('.');
  return dot === -1 ? null : normalized.slice(0, dot);
};

const normalizeRaw = (path: string): string => (path.indexOf('[') === -1 ? path : path.replace(BRACKET_RE, '.$1'));
const segmentsOf = (normalized: string): string[] => normalized.split('.').filter(Boolean);

const normalizedCache = new BoundedCache<string, string>(5000);
const segmentsCache = new BoundedCache<string, string[]>(5000);

export function clearPathCaches(): void {
  normalizedCache.clear();
  segmentsCache.clear();
}

export function normalizePath(path: string): string {
  if (!path) return '';
  return normalizedCache.get(path) ?? normalizedCache.set(path, normalizeRaw(path));
}

export function splitPath(path: string): string[] {
  if (!path) return [];
  const normalized = normalizePath(path);
  return segmentsCache.get(normalized) ?? segmentsCache.set(normalized, segmentsOf(normalized));
}

export const isValidNormalizedPath = (normalized: string): boolean =>
  typeof normalized === 'string' && VALID_PATH_RE.test(normalized) && !FORBIDDEN_PATH_RE.test(normalized);

export const isValidPath = (path: string): boolean =>
  typeof path === 'string' && isValidNormalizedPath(normalizeRaw(path));

/** `path` normalized, or null when it is empty or not a valid path (a truthy non-string throws, as it always did). */
const validNormalized = (path: string): string | null => {
  const normalized = path ? normalizeRaw(path) : '';
  return isValidNormalizedPath(normalized) ? normalized : null;
};

export function getParentPath(path: string): string | null {
  const normalized = typeof path === 'string' ? validNormalized(path) : null;
  return normalized && parentOf(normalized);
}

/** Path of the container above the first numeric segment (`tree.0.fields` -> `tree`). */
function nearestNumericContainer(path: string): string | null {
  const parts = validNormalized(path)?.split('.');
  const index = parts ? parts.findIndex(isNumeric) : -1;
  return index > 0 ? parts!.slice(0, index).join('.') : null;
}

export function resolveVersionPath(normalized: string, options: ResolveVersionPathOptions): string {
  const base = options.dependencyMode === 'container'
    ? (isValidNormalizedPath(normalized) ? parentOf(normalized) : null) ?? normalized
    : normalized;
  return options.bumpNumericParent ? nearestNumericContainer(base) ?? base : base;
}

/** Ancestor-or-self paths, deepest first. Empty for invalid paths. */
// `options.includeNumericParent` is accepted for compatibility: a numeric segment's parent is always already listed.
export function enumerateAncestors(path: string, options: { includeNumericParent?: boolean } = {}): string[] {
  const parts = (typeof path === 'string' ? validNormalized(path) : null)?.split('.') ?? [];
  const out: string[] = [];
  for (let i = parts.length; i >= 1; i--) out.push(parts.slice(0, i).join('.'));
  return out;
}

// Delegated to jsnq (>= 0.2.0 guards forbidden segments on raw-segment reads): same result, ~2.4x faster.
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
  const normalized = normalizeRaw(path);
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
  const segments = segmentsOf(path ? normalizeRaw(path) : '');
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
