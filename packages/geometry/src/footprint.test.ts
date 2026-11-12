/** 凹多边形台基不填缺角，外挑与反推关系保持锚点；退化和自交必须拒绝。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { createWorld, rect } from './index.ts';
import { polygonFootprint, contains } from './footprint.ts';
const table = loadRegistry().table;
test('凹形台基、楼板与外挑，缺角保留', () => {
  const h = createWorld(table);
  const w = h.world;
  const points = [
    [0, 0],
    [6, 0],
    [6, 2],
    [2, 2],
    [2, 6],
    [0, 6],
  ] as const;
  const base = w.plinth({ footprint: { points }, height: 2, material: 'stone' });
  assert.equal(w.get(1, 1, 5), 'stone');
  assert.equal(w.get(5, 1, 5), 'air');
  assert.throws(() => base.edge('south'), /多边形/);
  w.floorPlate({ in: base.top, material: 'oak_planks' });
  assert.equal(w.get(5, 3, 5), 'air');
  assert.throws(() => w.walls({ on: base, height: 3, material: 'stone' }), /多边形/);
  assert.throws(() => w.roof({ on: base, kind: 'flat', material: 'stone' }), /矩形/);
  assert.throws(() => w.colonnade({ on: base, count: 4, height: 3, column: { material: 'stone' } }), /矩形/);
  assert.throws(() => w.rail({ along: base, material: 'stone' }), /矩形/);
  w.plinth({ footprint: { points }, height: 1, project: 1, material: 'stone_bricks' });
  assert.equal(w.get(-1, 1, 0), 'stone_bricks');
  assert.equal(w.get(4, 1, 4), 'air');
  const shape = polygonFootprint(points);
  assert.equal(contains(shape, 6, 2), true);
  assert.equal(contains(shape, 7, 2), false);
});
test('从已建外墙的底面反推台基', () => {
  const h = createWorld(table);
  const w = h.world;
  const hall = w.walls({ footprint: rect(-3, -3, 3, 3), y: 3, height: 5, material: 'stone' });
  const base = w.plinth({ under: hall.inner, height: 2, project: 2, material: 'stone_bricks' });
  assert.equal(base.top.y, 3);
  assert.equal(base.bounds.min[1], 1);
  assert.throws(() => w.plinth({ under: hall.inner, y: 1, height: 2, material: 'stone' }), /不能混用/);
});
test('坏多边形退化、重边、自交拒绝且没有调用', () => {
  const h = createWorld(table);
  for (const points of [
    [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    [
      [0, 0],
      [3, 0],
      [3, 0],
      [0, 3],
    ],
    [
      [0, 0],
      [4, 4],
      [0, 4],
      [3, 0],
    ],
  ] as const) {
    assert.throws(() => h.world.plinth({ footprint: { points }, height: 1, material: 'stone' }));
    assert.equal(h.compose().grid.calls().length, 0);
  }
});
