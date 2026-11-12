/** 几何计划的格集合与边界，好坏样本均检查；不登记世界调用。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { bounds, boxWrites, wallWrites, openingWrites } from './shapes.ts';
import { parse, openingSchema, rect } from './schema.ts';

const table = loadRegistry().table;
const stone = parseState(table, 'stone');
const air = parseState(table, 'air');

test('矩形墙只写边缘，厚墙保留内部；非法范围拒绝', () => {
  const r = rect(-3, -3, 3, 3);
  assert.equal(wallWrites(r, 1, 2, 2, stone).length, (49 - 9) * 2);
  assert.equal(boxWrites([-1, 1, -1], [1, 2, 1], stone, 'structure').length, 18);
  assert.throws(() => boxWrites([2, 1, 0], [1, 1, 0], stone, 'structure'), /from/);
  assert.throws(() => wallWrites(r, 1, 2, 4, stone), /占地/);
  assert.throws(() => bounds(r, 2047, 2), /越界/);
});

test('四个朝向的开洞贯穿两格墙厚，门框不铺门槛，窗框四边围合', () => {
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    const p = parse(openingSchema, {
      in: { footprint: rect(-4, -4, 4, 4), y: 1, height: 7, thickness: 2, side },
      kind: 'door',
      width: 3,
      height: 3,
      frame: { material: 'stone' },
    });
    const plan = openingWrites(p, air, air, stone);
    assert.equal(plan.writes.filter((w) => w.writeLayer === 'opening').length, 27);
    assert.equal(plan.writes.filter((w) => w.writeLayer === 'decoration').length, 11);
    assert.equal(plan.bounds.min[1], 1);
    assert.equal(plan.bounds.max[1], 3);
    const noFrame = openingWrites({ ...p, frame: undefined }, air, air);
    assert.equal(noFrame.writes.length, 18);
    const window = openingWrites({ ...p, kind: 'window', sill: 2 }, air, air, stone);
    assert.equal(window.writes.filter((w) => w.writeLayer === 'decoration').length, 16);
    for (const change of [{ width: 20 }, { height: 20 }, { at: 10 }, { kind: 'window' as const }]) {
      assert.throws(() => openingWrites({ ...p, ...change }, air, air, stone), /放不下/);
    }
  }
});
