import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decomposeRectUnion,
  IntentValidationError,
  rectArea,
  rectSharedEdgeLength,
  rectWithin,
  Rect2,
  stairRect,
} from './design-intent-support.ts';
import type { Rect2 as Rect } from './design-intent-support.ts';

const RECT: Rect = { x: [0, 4], z: [0, 6] };

test('矩形辅助计算面积、贴边包含与共边长度', () => {
  assert.equal(Rect2.safeParse(RECT).success, true);
  assert.equal(rectArea(RECT), 24);
  assert.equal(rectWithin({ x: [0, 4], z: [0, 3] }, RECT), true);
  assert.equal(rectWithin({ x: [-1, 4], z: [0, 3] }, RECT), false);
  assert.equal(rectSharedEdgeLength(RECT, { x: [4, 8], z: [2, 4] }), 2);
  assert.equal(rectSharedEdgeLength(RECT, { x: [4, 8], z: [6, 8] }), 0);
});

test('矩形并集分解：L 形 2 段、三块 2 段、空集为空', () => {
  const l = decomposeRectUnion([
    { x: [0, 4], z: [0, 2] },
    { x: [0, 2], z: [2, 4] },
  ]);
  assert.deepEqual(l, [
    { x: [0, 4], z: [0, 2] },
    { x: [0, 2], z: [2, 4] },
  ]);
  const three = decomposeRectUnion([
    { x: [0, 2], z: [0, 2] },
    { x: [2, 5], z: [0, 2] },
    { x: [0, 2], z: [2, 5] },
  ]);
  assert.equal(three.length, 2);
  assert.equal(
    three.reduce((sum, rect) => sum + rectArea(rect), 0),
    6 + 4 + 6,
  );
  const u = decomposeRectUnion([
    { x: [0, 2], z: [0, 5] },
    { x: [2, 5], z: [0, 2] },
    { x: [5, 7], z: [0, 5] },
  ]);
  assert.equal(u.length, 3);
  assert.equal(
    u.reduce((sum, rect) => sum + rectArea(rect), 0),
    10 + 6 + 10,
  );
  assert.deepEqual(decomposeRectUnion([]), []);
});

test('直跑楼梯外包按方向和踏步数派生，错误类型保留 code / path', () => {
  assert.deepEqual(stairRect({ x: 3, z: 9 }, 'north', 2, 5), { x: [2, 4], z: [4, 9] });
  const error = new IntentValidationError('room-overlap', 'program.rooms', '重叠');
  assert.equal(error.code, 'room-overlap');
  assert.equal(error.path, 'program.rooms');
  assert.match(error.message, /program\.rooms: 重叠/);
});
