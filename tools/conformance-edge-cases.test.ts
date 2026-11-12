/**
 * Wave 3B / S3：conformance 边缘 fixture。
 *
 * 只冻结当前可辩护的行为：实心 3×3×4 体量不是四面墙，也没有洞口。
 * 庭院与局部檐口压顶探测后仍会出现误报（庭院被拆成外墙 / 假屋面，局部压顶产生假墙延伸与假窗），
 * 未收敛前不放入仓库，也不写失败测试。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Grid } from '@pg/core/grid';

type CellTuple = readonly [number, number, number, string];

interface BoxFixture {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly block: string;
}

interface EdgeFixture {
  readonly schemaVersion: number;
  readonly name: string;
  readonly boundsConvention: 'half-open [min,max)';
  readonly boxes: readonly BoxFixture[];
}

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/conformance-edge-cases/', import.meta.url));
const registry = loadRegistry();

function readFixture(name: string): EdgeFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as EdgeFixture;
}

function cellsOf(fixture: EdgeFixture): CellTuple[] {
  const cells: CellTuple[] = [];
  for (const box of fixture.boxes) {
    for (let x = box.min[0]; x < box.max[0]; x += 1) {
      for (let y = box.min[1]; y < box.max[1]; y += 1) {
        for (let z = box.min[2]; z < box.max[2]; z += 1) {
          cells.push([x, y, z, box.block]);
        }
      }
    }
  }
  return cells;
}

function gridOf(cells: readonly CellTuple[]): Grid {
  const grid = createGrid(registry.table);
  for (const [x, y, z, block] of cells) grid.set(x, y, z, parseState(registry.table, block), 0, 0);
  return grid;
}

describe('conformance edge fixtures', () => {
  it('solid mass 3×3×4：wall=0、opening=0，不会被拆成四面墙', () => {
    const fixture = readFixture('solid-mass-3x3x4.json');
    assert.equal(fixture.schemaVersion, 1);
    assert.equal(fixture.name, 'solid-mass-3x3x4');
    assert.equal(fixture.boundsConvention, 'half-open [min,max)');

    const cells = cellsOf(fixture);
    assert.equal(cells.length, 36);

    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    assert.equal(graph.summary.totalCells, 36);
    assert.equal(graph.summary.assignedCells, 0);
    assert.equal(graph.summary.unknownCells, 36);
    assert.equal(graph.summary.objectCounts.unknown, 1);
    assert.equal(graph.summary.objectCounts.wall, 0);
    assert.equal(graph.summary.objectCounts.opening, 0);
  });
});
