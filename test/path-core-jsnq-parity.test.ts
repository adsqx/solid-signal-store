/**
 * Proves which path helpers may be delegated to @adsq/jsnq/data-engine here.
 *
 * Outcome recorded by this suite:
 *  - the reference setter below (the former local implementation)  ==  writeJsonPathValue   -> delegated
 *  - getBySegments guards forbidden segments locally and the installed @adsq/jsnq (>= 0.1.4)
 *    agrees. It stays local anyway: the peer range is ^0.1.0 and older jsnq releases performed
 *    no guard, so delegating would need a peer-floor bump.
 *
 * Run: bun --conditions browser test/path-core-jsnq-parity.test.ts
 */
import { writeJsonPathValue, getJsonBySegments } from '@adsq/jsnq/core/data-engine';
import { getBySegments, setByPath } from '../src/internal/path';

/** Reference implementation of the former local setter (kept here as the oracle for the jsnq delegation). */
function setByPathCore(obj: unknown, path: string, value: unknown, _options?: unknown): void {
  const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
  const segments = path.split('.').filter(Boolean);
  if (segments.some((s) => FORBIDDEN.has(s))) throw new Error(`Unsafe path segment in '${path}'`);
  const traversable = (v: unknown) => v != null && (typeof v === 'object' || typeof v === 'function');
  let current = obj as Record<string, any>;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const wantsArray = /^\d+$/.test(segments[i + 1]!);
    if (!traversable(current[segment])) current[segment] = wantsArray ? [] : {};
    else if (wantsArray && !Array.isArray(current[segment])) current[segment] = [];
    current = current[segment];
  }
  const last = segments[segments.length - 1]!;
  if (Array.isArray(current) && /^\d+$/.test(last)) current[Number(last)] = value;
  else current[last] = value;
}

let failures = 0;
const ok = (condition: unknown, message: string): void => {
  if (condition) console.log(`PASS ${message}`);
  else { console.error(`FAIL ${message}`); failures++; }
};

const fixture = () => ({
  user: { name: 'Ann', age: 0, empty: '', nope: false, nothing: null },
  items: [{ tags: ['x', 'y', 'z'] }, { tags: [] }],
  deep: { 1: { 2: { 3: { value: 'found' } } } },
});

const shape = (value: unknown): string => JSON.stringify(value);

// --- setByPathCore <-> writeJsonPathValue: identical resulting tree -----------------
for (const path of ['user.name', 'user.fresh', 'brand.new.deep.path', 'items.0.tags.1', 'items.2.tags.0']) {
  const viaCore = fixture();
  const viaJsnq = fixture();
  setByPathCore(viaCore, path, 'WROTE', { createArrays: true, guardForbidden: true });
  writeJsonPathValue(viaJsnq, path, 'WROTE');
  ok(shape(viaCore) === shape(viaJsnq), `write parity for '${path}'`);
}

// Both reject a forbidden segment by throwing, so delegation preserves the guarantee.
for (const path of ['a.__proto__.x', 'constructor']) {
  let coreThrew = false;
  let jsnqThrew = false;
  try { setByPathCore(fixture(), path, 'WROTE', { createArrays: true, guardForbidden: true }); } catch { coreThrew = true; }
  try { writeJsonPathValue(fixture(), path, 'WROTE'); } catch { jsnqThrew = true; }
  ok(coreThrew && jsnqThrew, `both reject the forbidden path '${path}'`);
}

// --- getBySegments must keep its local guard ---------------------------------------
{
  const target = fixture();
  const forbidden = ['__proto__'];
  ok(
    getJsonBySegments(target, forbidden) === undefined,
    'installed jsnq guards forbidden segments too, matching the local guard',
  );
  ok(getBySegments(target, forbidden) === undefined, 'getBySegments refuses forbidden segments locally');
}

// --- public wrappers still behave ---------------------------------------------------
{
  const target = fixture();
  setByPath(target, 'user.name', 'Ada');
  ok((target.user as Record<string, unknown>)['name'] === 'Ada', 'setByPath writes through the delegated engine');
  setByPath(target, 'made.up.branch', 7);
  ok(shape(getBySegments(target, ['made', 'up', 'branch'])) === '7', 'setByPath creates missing branches');
  const arrays = fixture();
  setByPath(arrays, 'items.1.tags.0', 'first');
  ok(arrays.items[1]!.tags[0] === 'first', 'setByPath writes into arrays by numeric segment');
  setByPath(arrays, '', 'ignored');
  ok(shape(arrays.items[1]!.tags[0]) === '"first"', 'setByPath ignores an empty path');
}

if (failures > 0) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log('\nAll path-core / jsnq delegation parity tests passed.');
