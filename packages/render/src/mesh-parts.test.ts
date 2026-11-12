/** mesh-parts.ts：fallback 画法编号与旧版盒子表保持稳定。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONNECT_PAINTS, faceTint, legacyBoxes, PAINT } from './mesh-parts.ts';

test('画法编号 0–19 稳定（协议 v1/v2 共用）', () => {
  assert.equal(PAINT.skip, 0);
  assert.equal(PAINT.cube, 1);
  assert.equal(PAINT.door, 10);
  assert.equal(PAINT.axis_cube, 19);
  assert.equal(PAINT.small, 9);
});

test('cube / slab / stairs / fence / door 的 fallback 盒子', () => {
  assert.deepEqual(legacyBoxes(PAINT.cube, [0, 0, 0, 0], [false, false, false, false])[0], [0, 0, 0, 16, 16, 16]);
  assert.deepEqual(legacyBoxes(PAINT.slab, [1, 0, 0, 0], [false, false, false, false])[0], [0, 8, 0, 16, 16, 16]);
  assert.equal(legacyBoxes(PAINT.stairs, [0, 0, 0, 0], [false, false, false, false]).length, 2);
  const fence = legacyBoxes(PAINT.fence, [0, 0, 0, 0], [true, false, false, false]);
  assert.equal(fence.length, 3);
  assert.equal(CONNECT_PAINTS.has(PAINT.cube), true);
  assert.equal(CONNECT_PAINTS.has(PAINT.slab), false);
  assert.equal(legacyBoxes(PAINT.door, [0, 0, 0, 0], [false, false, false, false])[0]?.[2], 0);
  assert.equal(legacyBoxes(PAINT.door, [2, 0, 0, 0], [false, false, false, false])[0]?.[2], 13);
});

test('轴向端面亮度只作用于 axis_cube', () => {
  assert.equal(faceTint(PAINT.cube, [0, 0, 0, 0], 2), 1);
  assert.equal(faceTint(PAINT.axis_cube, [0, 0, 0, 0], 2), 1.18);
  assert.equal(faceTint(PAINT.axis_cube, [0, 0, 0, 0], 3), 0.82);
});
