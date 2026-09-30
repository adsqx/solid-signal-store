/**
 * Local Solid path adapter.
 *
 * The pure algorithms live in this project's own path-core.ts. Angular keeps an
 * equivalent local path-core.ts file, but there is no shared package/folder at
 * runtime. This adapter owns Solid-specific root semantics and lightweight
 * bounded caches for hot proxy paths.
 */

import {
  getBySegmentsCore,
  normalizePathCore,
  pathExistsCore,
  resolveParentAndKeyCore,
  splitSegmentsCore,
  type PathSegments,
} from './path-core';
import { BoundedCache } from './bounded-cache';
import { writeJsonPathValue } from '@adsq/jsnq/core/data-engine';

export type { PathSegments, VersionDependencyMode } from './path-core';

// Signatures are identical to the core functions, so these are plain renames.
export {
  cloneJsonCore as cloneJson,
  ensurePathInCore as ensurePathIn,
  enumerateAncestorPathsCore as enumerateAncestors,
  getParentPathCore as getParentPath,
  getParentSegmentsCore as getParentSegments,
  isValidNormalizedPathCore as isValidNormalizedPath,
  isValidPathCore as isValidPath,
  resolveVersionPathCore as resolveVersionPath,
} from './path-core';

const CACHE_MAX = 5000;
const normalizedCache = new BoundedCache<string, string>(CACHE_MAX);
const segmentsCache = new BoundedCache<string, string[]>(CACHE_MAX);
const GUARDED = { guardForbidden: true } as const;

export function clearPathCaches(): void {
  normalizedCache.clear();
  segmentsCache.clear();
}

export function normalizePath(path: string): string {
  if (!path) return '';
  return normalizedCache.get(path) ?? normalizedCache.set(path, normalizePathCore(path));
}

export function splitPath(path: string): string[] {
  if (!path) return [];
  const normalized = normalizePath(path);
  return segmentsCache.get(normalized) ?? segmentsCache.set(normalized, splitSegmentsCore(normalized, false));
}

export function getBySegments(obj: unknown, segments: PathSegments): unknown {
  return getBySegmentsCore(obj, segments, GUARDED);
}

export function getByPath(obj: unknown, path: string): unknown {
  if (!obj) return undefined;
  if (!path) return obj;
  return getBySegments(obj, splitPath(path));
}

export function setByPath(obj: unknown, path: string, value: unknown): void {
  if (!obj || !path) return;
  // Delegated to jsnq: same resulting tree and the same rejection of forbidden segments
  // (proven in test/path-core-jsnq-parity.test.ts), and faster because it reuses the
  // cached path plan — 82.1ms -> 39.1ms on repeated paths, 102.7ms -> 88.3ms on a
  // 90%-repeat mix over 200k writes. getBySegments stays local: the installed jsnq (0.1.4)
  // does guard forbidden segments on reads too and matches core (parity test), but the
  // peer range is ^0.1.0 and older releases hand back Object.prototype, so core keeps
  // its own guard rather than raising the peer floor.
  writeJsonPathValue(obj, path, value);
}

// Not a plain rename: the core function takes an extra `options` argument that is not public here.
export function pathExists(obj: unknown, path: string): boolean {
  return pathExistsCore(obj, path);
}

// `parent` stays `any` on purpose: this is public API (InternalPath) and callers index into it.
export function resolveParentAndKey(obj: unknown, path: string): { parent: any; key: string | null; segments: string[] } {
  return resolveParentAndKeyCore(obj, path);
}
