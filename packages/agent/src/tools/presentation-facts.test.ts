/**
 * presentation-facts 的单元测试：屋面材质判别与洞框夹层排除的取样边界。
 * 完整整链由 check.test.ts 的修正用例覆盖，这里补直接的好 / 坏样本。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SeamReport } from '@pg/analysis/seams';
import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';

import { frameAirSeams, roofSurfaceMaterials } from './presentation-facts.ts';

const registry = loadRegistry();
const table = registry.table;
const stateOf = (name: string): ReturnType<typeof parseState> => parseState(table, name);

describe('roofSurfaceMaterials', () => {
  it('参数里的 material 优先，即使它不是留存格里最多的状态', () => {
    const grid = createGrid(table);
    const id = grid.defineCall('roof', 1, { material: 'dark_oak_planks' });
    grid.set(0, 0, 0, stateOf('dark_oak_planks'), 0, id);
    grid.set(1, 0, 0, stateOf('spruce_planks'), 0, id);
    grid.set(2, 0, 0, stateOf('spruce_planks'), 0, id);
    const call = grid.calls()[0];
    assert.ok(call !== undefined);
    const materials = roofSurfaceMaterials(call, [...grid.cells()], table);
    assert.deepEqual([...materials], [stateOf('dark_oak_planks').canonical]);
  });

  it('参数读不到 material 时回退到留存格里最多的状态', () => {
    const grid = createGrid(table);
    const id = grid.defineCall('roof', 1, {});
    grid.set(0, 0, 0, stateOf('stone_bricks'), 0, id);
    grid.set(1, 0, 0, stateOf('stone_bricks'), 0, id);
    grid.set(2, 0, 0, stateOf('oak_planks'), 0, id);
    const call = grid.calls()[0];
    assert.ok(call !== undefined);
    assert.deepEqual([...roofSurfaceMaterials(call, [...grid.cells()], table)], [stateOf('stone_bricks').canonical]);
  });

  it('material 名不合法时也回退，不抛错', () => {
    const grid = createGrid(table);
    const id = grid.defineCall('roof', 1, { material: 'no_such_block' });
    grid.set(0, 0, 0, stateOf('oak_planks'), 0, id);
    const call = grid.calls()[0];
    assert.ok(call !== undefined);
    assert.deepEqual([...roofSurfaceMaterials(call, [...grid.cells()], table)], [stateOf('oak_planks').canonical]);
  });
});

describe('frameAirSeams', () => {
  const empty: SeamReport = { cells: 0, groups: [] };

  it('没有夹层组时返回空', () => {
    const grid = createGrid(table);
    const r = frameAirSeams(grid, empty, grid.calls(), table);
    assert.equal(r.cells, 0);
    assert.equal(r.removed.size, 0);
  });

  it('上下最近实体都是 opening 的 frame 材质：整组被排除', () => {
    const grid = createGrid(table);
    const opening = grid.defineCall('opening', 1, { frame: { material: 'spruce_log' } });
    grid.set(0, 5, 0, stateOf('spruce_log'), 0, opening);
    grid.set(0, 7, 0, stateOf('spruce_log'), 0, opening);
    const seams: SeamReport = {
      cells: 1,
      groups: [
        {
          cells: 1,
          layers: 1,
          bounds: { min: [0, 6, 0], max: [0, 6, 0] },
          samples: [{ x: 0, y: 6, z: 0, block: 'air', call: 0 }],
        },
      ],
    };
    const r = frameAirSeams(grid, seams, grid.calls(), table);
    assert.equal(r.cells, 1);
    assert.equal(r.removed.size, 1);
  });

  it('上下不是 opening frame（真夹层）时保留', () => {
    const grid = createGrid(table);
    const walls = grid.defineCall('walls', 1, {});
    grid.set(0, 5, 0, stateOf('stone_bricks'), 0, walls);
    grid.set(0, 7, 0, stateOf('stone_bricks'), 0, walls);
    const seams: SeamReport = {
      cells: 1,
      groups: [
        {
          cells: 1,
          layers: 1,
          bounds: { min: [0, 6, 0], max: [0, 6, 0] },
          samples: [{ x: 0, y: 6, z: 0, block: 'air', call: 0 }],
        },
      ],
    };
    const r = frameAirSeams(grid, seams, grid.calls(), table);
    assert.equal(r.cells, 0);
    assert.equal(r.removed.size, 0);
  });
});
