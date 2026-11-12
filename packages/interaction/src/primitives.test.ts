import assert from 'node:assert/strict';
import { test } from 'node:test';

import { areaOfBounds, Bounds, boundsOverlap, boundsSize, boundsWithin, Vec3 } from './primitives.ts';

test('Vec3 只接受安全整数三元组', () => {
  assert.deepEqual(Vec3.parse([1, -2, 3]), [1, -2, 3]);
  for (const bad of [
    [1, 2],
    [1.5, 2, 3],
    [1, Infinity, 3],
    [1, NaN, 3],
    [1, 2 ** 60, 3],
  ]) {
    assert.equal(Vec3.safeParse(bad).success, false, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('Bounds 为半开区间，每轴 max 必须严格大于 min', () => {
  assert.equal(Bounds.safeParse({ min: [0, 0, 0], max: [4, 2, 6] }).success, true);
  for (const bad of [
    { min: [0, 0, 0], max: [0, 2, 6] },
    { min: [0, 0, 0], max: [4, 0, 6] },
    { min: [0, 0, 0], max: [4, 2, 0] },
    { min: [4, 0, 0], max: [2, 2, 6] },
  ]) {
    assert.equal(Bounds.safeParse(bad).success, false, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('boundsSize / areaOfBounds / boundsWithin 使用半开区间口径', () => {
  const bounds = Bounds.parse({ min: [1, 2, 3], max: [5, 4, 9] });
  assert.deepEqual(boundsSize(bounds), [4, 2, 6]);
  assert.equal(areaOfBounds(bounds), 24);
  assert.equal(boundsWithin(bounds, Bounds.parse({ min: [0, 0, 0], max: [5, 4, 9] })), true);
  assert.equal(boundsWithin(bounds, Bounds.parse({ min: [2, 0, 0], max: [5, 4, 9] })), false);
  assert.equal(boundsWithin(bounds, Bounds.parse({ min: [0, 0, 0], max: [4, 4, 9] })), false);
});

test('boundsOverlap 只要求有体积重叠，接触边 / 面不算', () => {
  const bounds = Bounds.parse({ min: [1, 2, 3], max: [5, 4, 9] });
  assert.equal(boundsOverlap(bounds, Bounds.parse({ min: [4, 3, 8], max: [8, 6, 12] })), true);
  assert.equal(boundsOverlap(bounds, Bounds.parse({ min: [5, 2, 3], max: [8, 4, 9] })), false);
  assert.equal(boundsOverlap(bounds, Bounds.parse({ min: [0, 0, 0], max: [1, 2, 3] })), false);
  assert.equal(boundsOverlap(bounds, Bounds.parse({ min: [0, 0, 0], max: [2, 3, 4] })), true);
});
