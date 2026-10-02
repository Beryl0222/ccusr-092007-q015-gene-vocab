import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidRange, overlaps, contains } from '../src/time.js';
import { canonicalize, contentHash } from '../src/canonical.js';
import { buildAdjacency, findCycle, cycleIfAdded } from '../src/graph.js';

test('半开区间：相接不重叠，相交才重叠', () => {
  const a = { effective_from: '2026-01-01', effective_to: '2026-02-01' };
  const b = { effective_from: '2026-02-01', effective_to: null };
  assert.equal(isValidRange(a), true);
  assert.equal(overlaps(a, b), false);
  assert.equal(contains(a, '2026-01-31'), true);
  assert.equal(contains(a, '2026-02-01'), false);
  assert.equal(contains(b, '2026-02-01'), true);
  assert.equal(isValidRange({ effective_from: '2026-03-01', effective_to: '2026-03-01' }), false);
});

test('规范化序列化：键排序、数组保序，与插入顺序无关', () => {
  assert.equal(canonicalize({ b: 1, a: [2, 1] }), canonicalize({ a: [2, 1], b: 1 }));
  assert.notEqual(canonicalize({ a: [1, 2] }), canonicalize({ a: [2, 1] }));
  assert.equal(contentHash({ x: 1 }), contentHash({ x: 1 }));
  assert.notEqual(contentHash({ x: 1 }), contentHash({ x: 2 }));
});

test('环检测：能定位 A->B->C->A，无环返回 null', () => {
  const cyclic = buildAdjacency([
    { from: 'A', to: 'B' },
    { from: 'B', to: 'C' },
    { from: 'C', to: 'A' },
  ]);
  const cycle = findCycle(cyclic);
  assert.ok(cycle);
  assert.equal(cycle[0], cycle[cycle.length - 1]);
  assert.equal(cycle.length, 4);

  const dag = buildAdjacency([{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }]);
  assert.equal(findCycle(dag), null);

  const path = cycleIfAdded(
    [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ],
    { from: 'C', to: 'A' },
  );
  assert.ok(path);
});
