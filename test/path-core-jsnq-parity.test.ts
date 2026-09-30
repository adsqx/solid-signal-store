/**
 * Proves which path-core helpers may be delegated to @adsq/jsnq/data-engine here.
 *
 * Outcome recorded by this suite:
 *  - setByPathCore(obj, path, value)  ==  writeJsonPathValue(obj, path, value)   -> delegated
 *  - getBySegmentsCore(..., { guardForbidden: true })  ==  getJsonBySegments on forbidden
 *    segments with the installed @adsq/jsnq (>= 0.1.4 guards and returns undefined). It stays
 *    local anyway: the peer range is ^0.1.0 and older jsnq releases performed no guard,
 *    so delegating would need a peer-floor bump. This suite asserts core still guards and
 *    that the installed jsnq agrees.
 *
 * Run: bun --conditions browser test/path-core-jsnq-parity.test.ts
 */
import { setByPathCore, getBySegmentsCore } from '../src/internal/path-core';
import { writeJsonPathValue, getJsonBySegments } from '@adsq/jsnq/core/data-engine';
import { getBySegments, setByPath } from '../src/internal/path';

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
  ok(getBySegmentsCore(target, forbidden, { guardForbidden: true }) === undefined, 'core guards forbidden segments');
  ok(
    getJsonBySegments(target, forbidden) === undefined,
    'installed jsnq guards forbidden segments too, matching core',
  );
  ok(getBySegments(target, forbidden) === undefined, 'public getBySegments still refuses forbidden segments');
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
