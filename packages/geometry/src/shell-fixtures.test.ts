/**
 * M3 壳构件离线夹具（SURFACE-SHELL-SPEC §9）：六角亭屋面（surface + revolve）与圆角美术馆穹顶（revolve）。
 * 金标指纹与测量常数来源：本规格首次实现（同一内核、同一夹具代码下逐位确定）；改内核或夹具必须同步更新。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { measureFloating } from '@pg/analysis/floating';
import { measureSeams } from '@pg/analysis/seams';
import { loadRegistry } from '@pg/blocks/load';
import { hashGrid } from '@pg/core/hash';

import { createWorld } from './index.ts';
import type { World, WorldHost } from './index.ts';
import dome from '../fixtures/s2-dome.ts';
import hex from '../fixtures/s1-hex.ts';

const table = loadRegistry().table;

function build(fixture: (w: World) => void): WorldHost {
  const host = createWorld(table);
  fixture(host.world);
  return host;
}

function materialCounts(host: WorldHost): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const cell of host.compose().grid.cells()) counts[cell.state.name] = (counts[cell.state.name] ?? 0) + 1;
  return counts;
}

function cellBounds(host: WorldHost): { min: readonly number[]; max: readonly number[] } {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const c of host.compose().grid.cells()) {
    min = [Math.min(min[0] ?? 0, c.x), Math.min(min[1] ?? 0, c.y), Math.min(min[2] ?? 0, c.z)];
    max = [Math.max(max[0] ?? 0, c.x), Math.max(max[1] ?? 0, c.y), Math.max(max[2] ?? 0, c.z)];
  }
  return { min, max };
}

/** 某一层里某材质的格按 60°/30° 扇区计数：核对俯视近似六边形 / 圆形。 */
function sectorCounts(host: WorldHost, material: string, y: number, sectors: number): number[] {
  const counts = new Array<number>(sectors).fill(0);
  for (const c of host.compose().grid.cells()) {
    if (c.state.name !== material || c.y !== y) continue;
    let angle = (Math.atan2(c.z, c.x) * 180) / Math.PI;
    if (angle < 0) angle += 360;
    const index = Math.min(sectors - 1, Math.floor((angle / 360) * sectors));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

describe('s1-hex 六角亭屋面夹具', () => {
  it('金标：格数 / 包围盒 / 悬空 / 夹层 / 来源', () => {
    const host = build(hex);
    assert.equal(hashGrid(host.compose().grid), '4567e96b852e3a5cfcee5850c08658df');
    assert.deepEqual(materialCounts(host), { stone_bricks: 147, deepslate_tiles: 200, gold_block: 12 });
    assert.deepEqual(cellBounds(host), { min: [-6, 1, -7], max: [6, 9, 7] });
    const grid = host.compose().grid;
    assert.deepEqual(
      grid.calls().map((c) => c.api),
      ['plinth', 'surfaceShell', 'surfaceShell'],
    );
    assert([...grid.cells()].every((c) => c.call > 0));
    const floating = measureFloating(grid);
    assert.equal(floating.cells, 0, '屋面与宝顶必须落在台基上');
    assert.equal(measureSeams(grid).cells, 48, '台基与屋面之间的开敞夹层照常报出');
    const parts = grid.parts().map((p) => p.name);
    assert(parts.includes('六坡凹曲屋面'));
    assert(parts.includes('宝顶'));
  });

  it('俯视近似六边形：檐口层六扇区都有格', () => {
    const sectors = sectorCounts(build(hex), 'deepslate_tiles', 2, 6);
    assert(
      sectors.every((n) => n >= 5),
      `檐口层各扇区应连续：${sectors.join(',')}`,
    );
  });

  it('确定性：两次构建 hash 相同', () => {
    assert.equal(hashGrid(build(hex).compose().grid), hashGrid(build(hex).compose().grid));
  });
});

describe('s2-dome 圆角美术馆穹顶夹具', () => {
  it('金标：格数 / 包围盒 / 悬空 / 夹层 / 来源', () => {
    const host = build(dome);
    assert.equal(hashGrid(host.compose().grid), '1437988276a4e957844a665b6379f83f');
    assert.deepEqual(materialCounts(host), { smooth_stone: 205, light_gray_concrete: 328 });
    assert.deepEqual(cellBounds(host), { min: [-8, 1, -8], max: [8, 7, 8] });
    const grid = host.compose().grid;
    assert.deepEqual(
      grid.calls().map((c) => c.api),
      ['plinth', 'surfaceShell'],
    );
    assert.equal(measureFloating(grid).cells, 0, '底圈必须落在台基上');
    assert.equal(measureSeams(grid).cells, 68, '穹顶壳与台基之间的开敞夹层照常报出');
    assert.deepEqual(
      grid.parts().map((p) => p.name),
      ['穹顶壳'],
    );
  });

  it('俯视近似圆形：底圈 12 扇区都有格', () => {
    const sectors = sectorCounts(build(dome), 'light_gray_concrete', 2, 12);
    assert(
      sectors.every((n) => n >= 3),
      `底圈各扇区应连续：${sectors.join(',')}`,
    );
  });

  it('确定性：两次构建 hash 相同', () => {
    assert.equal(hashGrid(build(dome).compose().grid), hashGrid(build(dome).compose().grid));
  });
});
