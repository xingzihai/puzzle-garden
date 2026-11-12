/** 几何原语的好坏样本：门洞分段不重叠、板洞保留面积、楔体定向、梯级标高与非法参数。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  batchSteps,
  batchWalls,
  boxes,
  element,
  slabWithHoles,
  stepRun,
  vec,
  wallWithOpenings,
  wedges,
} from './example-geometry.ts';

/** 盒体体积（半开区间）。参数用三元组，索引访问不必非空断言。 */
function volume(bounds: {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}): number {
  return (bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1]) * (bounds.max[2] - bounds.min[2]);
}

test('element 缺省 shape=box、direction=1，可显式覆盖，spaceId 只在给出时带', () => {
  const plain = element('el-a', '盒', 'b1', 'wall', vec(0, 0, 0), vec(1, 2, 3), '#112233');
  assert.equal(plain.shape, 'box');
  assert.equal(plain.direction, 1);
  assert.equal('spaceId' in plain, false);
  assert.deepEqual(plain.bounds.min, [0, 0, 0]);
  assert.deepEqual(plain.bounds.max, [1, 2, 3]);

  const wedge = element('el-b', '楔', 'surface', 'glazing', vec(0, 0, 0), vec(4, 3, 2), '#445566', {
    shape: 'wedge-x',
    direction: -1,
    spaceId: 'sp-entry',
  });
  assert.equal(wedge.shape, 'wedge-x');
  assert.equal(wedge.direction, -1);
  assert.equal(wedge.spaceId, 'sp-entry');
});

test('wallWithOpenings 在门洞处断开，门洞两侧各成一段且不重叠', () => {
  const segments = wallWithOpenings({
    idPrefix: 'el-wall',
    name: '南墙',
    level: 'b1',
    color: '#999999',
    axis: 'x',
    from: 10,
    to: 20,
    crossStart: 30,
    thickness: 1,
    yMin: -8,
    yMax: -5,
    openings: [{ from: 13, to: 15 }],
  });
  assert.equal(segments.length, 2);
  const first = segments[0];
  const second = segments[1];
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(first.bounds.min, [10, -8, 30]);
  assert.deepEqual(first.bounds.max, [13, -5, 31]);
  assert.deepEqual(second.bounds.min, [15, -8, 30]);
  assert.deepEqual(second.bounds.max, [20, -5, 31]);
  // 门洞区间 [13,15) 内没有任何实体
  assert.equal(
    segments.some((segment) => segment.bounds.min[0] < 15 && 13 < segment.bounds.max[0]),
    false,
  );
});

test('wallWithOpenings 忽略范围外与紧贴端点的门洞，并支持多洞排序与 z 向', () => {
  const segments = wallWithOpenings({
    idPrefix: 'el-z',
    name: '西墙',
    level: 'b1',
    color: '#999999',
    axis: 'z',
    from: 0,
    to: 10,
    crossStart: 5,
    thickness: 1,
    yMin: 0,
    yMax: 3,
    openings: [
      { from: 6, to: 8 },
      { from: 2, to: 4 },
      { from: 20, to: 25 },
      { from: 0, to: 0 },
    ],
  });
  // [2,4) 与 [6,8) 两个洞 → 三段：[0,2)、[4,6)、[8,10)
  assert.deepEqual(
    segments.map((segment) => [segment.bounds.min[2], segment.bounds.max[2]]),
    [
      [0, 2],
      [4, 6],
      [8, 10],
    ],
  );
  // z 向墙的横向是 x
  const firstZ = segments[0];
  assert.ok(firstZ);
  assert.deepEqual(firstZ.bounds.min, [5, 0, 0]);
  assert.deepEqual(firstZ.bounds.max, [6, 3, 2]);
});

test('slabWithHoles 扣洞后保留面积正确，且没有实体落入洞内', () => {
  const slabs = slabWithHoles({
    idPrefix: 'el-slab',
    name: '候车厅板',
    level: 'b1',
    color: '#bbbbbb',
    xMin: 0,
    xMax: 10,
    zMin: 0,
    zMax: 10,
    yMin: -9,
    yMax: -8,
    holes: [{ xMin: 4, xMax: 6, zMin: 4, zMax: 7 }],
  });
  const area = slabs.reduce(
    (sum, slab) => sum + (slab.bounds.max[0] - slab.bounds.min[0]) * (slab.bounds.max[2] - slab.bounds.min[2]),
    0,
  );
  assert.equal(area, 100 - 2 * 3);
  assert.equal(
    slabs.some(
      (slab) => slab.bounds.min[0] < 6 && 4 < slab.bounds.max[0] && slab.bounds.min[2] < 7 && 4 < slab.bounds.max[2],
    ),
    false,
  );
  // 所有板厚一致
  assert.equal(
    slabs.every((slab) => slab.bounds.max[1] - slab.bounds.min[1] === 1),
    true,
  );
});

test('slabWithHoles 多个洞：保留体积等于总体积分去各洞体积', () => {
  const holes = [
    { xMin: 1, xMax: 3, zMin: 1, zMax: 3 },
    { xMin: 6, xMax: 8, zMin: 5, zMax: 9 },
  ];
  const slabs = slabWithHoles({
    idPrefix: 'el-p',
    name: '平台板',
    level: 'b2',
    color: '#bbbbbb',
    xMin: 0,
    xMax: 10,
    zMin: 0,
    zMax: 10,
    yMin: -17,
    yMax: -16,
    holes,
  });
  const holeVolume = holes.reduce((sum, hole) => sum + (hole.xMax - hole.xMin) * (hole.zMax - hole.zMin), 0);
  assert.equal(
    slabs.reduce((sum, slab) => sum + volume(slab.bounds), 0),
    10 * 10 * 1 - holeVolume,
  );
});

test('stepRun 逐级标高与范围正确，下行用负 rise', () => {
  const steps = stepRun({
    idPrefix: 'el-n',
    name: '北入口梯',
    level: 'surface',
    color: '#888888',
    axis: 'x',
    start: 7,
    end: 16,
    crossStart: 4,
    crossSize: 3,
    baseY: -9,
    topAtStart: 0,
    rise: -1,
    stepCount: 9,
  });
  assert.equal(steps.length, 9);
  const firstStep = steps[0];
  const secondStep = steps[1];
  const lastStep = steps[8];
  assert.ok(firstStep);
  assert.ok(secondStep);
  assert.ok(lastStep);
  assert.deepEqual(firstStep.bounds.min, [7, -9, 4]);
  assert.deepEqual(firstStep.bounds.max, [8, 0, 7]);
  assert.deepEqual(lastStep.bounds.max, [16, -8, 7]);
  // 相邻级沿轴相邻不重叠
  assert.equal(secondStep.bounds.min[0], firstStep.bounds.max[0]);
});

test('stepRun 遇到不能整除的跨度抛错，不静默取整', () => {
  assert.throws(
    () =>
      stepRun({
        idPrefix: 'el-bad',
        name: '非法梯',
        level: 'b1',
        color: '#888888',
        axis: 'z',
        start: 0,
        end: 10,
        crossStart: 0,
        crossSize: 2,
        baseY: 0,
        topAtStart: 3,
        rise: 1,
        stepCount: 3,
      }),
    /无法均分为 3 级/,
  );
});

test('boxes / wedges 由元组批量生成，缺省与显式 shape、direction 正确', () => {
  const flat = boxes('b1', [
    ['el-a', '盒', 'wall', [0, 0, 0], [1, 2, 3], '#112233'],
    ['el-b', '板', 'slab', [4, 4, 4], [5, 6, 7], '#445566'],
  ]);
  assert.equal(flat.length, 2);
  const firstFlat = flat[0];
  assert.ok(firstFlat);
  assert.equal(
    flat.every((item) => item.level === 'b1' && item.shape === 'box' && item.direction === 1),
    true,
  );
  assert.deepEqual(firstFlat.bounds.max, [1, 2, 3]);

  const tilted = wedges('surface', [['el-w', '楔', 'glazing', [0, 0, 0], [4, 8, 2], '#778899', 'wedge-z', -1]]);
  const firstTilted = tilted[0];
  assert.ok(firstTilted);
  assert.equal(firstTilted.shape, 'wedge-z');
  assert.equal(firstTilted.direction, -1);
});

test('batchWalls 把扁平洞口还原成门洞，batchSteps 逐级成盒', () => {
  const walls = batchWalls([['el-wall', '墙', 'b1', '#999999', 'x', 10, 20, 30, 1, -8, -5, [13, 15, 17, 18]]]);
  // 两个洞 → 三段：[10,13)、[15,17)、[18,20)
  assert.deepEqual(
    walls.map((item) => [item.bounds.min[0], item.bounds.max[0]]),
    [
      [10, 13],
      [15, 17],
      [18, 20],
    ],
  );
  const steps = batchSteps([['el-st', '梯', 'b1', '#888888', 'z', 0, 4, 0, 2, -8, -7, 1, 4]]);
  assert.equal(steps.length, 4);
  assert.equal(steps[3]?.bounds.max[1], -4);
});
