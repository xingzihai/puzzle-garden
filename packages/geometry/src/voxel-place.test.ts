/**
 * voxel-place：90° 格旋转、世界放置、越界 / 地下拒绝与一次 commit 的登记语义（massingImport 与 surfaceShell 共用）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import type { BlockState } from '@pg/core/block-state';
import type { VoxelPart, VoxelResult } from '@pg/modeling/voxelize';

import { MassingError } from './massing-error.ts';
import { placeVoxelParts, rotateCell, showCell } from './voxel-place.ts';
import type { VoxelCell, VoxelPlaceMessages } from './voxel-place.ts';
import { Writer } from './writer.ts';

const table = loadRegistry().table;

function part(id: string, cells: readonly VoxelCell[], name = id): VoxelPart {
  return {
    id,
    name,
    role: 'roof',
    color: '#8899aa',
    mode: 'shell',
    cells,
    bounds:
      cells.length === 0
        ? null
        : {
            min: [
              Math.min(...cells.map((c) => c[0])),
              Math.min(...cells.map((c) => c[1])),
              Math.min(...cells.map((c) => c[2])),
            ],
            max: [
              Math.max(...cells.map((c) => c[0])),
              Math.max(...cells.map((c) => c[1])),
              Math.max(...cells.map((c) => c[2])),
            ],
          },
    cellCount: cells.length,
    isolatedCells: 0,
    isolatedRemoved: 0,
    leaky: false,
  };
}

function result(parts: readonly VoxelPart[]): VoxelResult {
  const cells = parts.reduce((n, p) => n + p.cellCount, 0);
  return {
    parts,
    bounds: null,
    counts: {
      parts: parts.length,
      cells,
      triangles: cells * 2,
      shellParts: parts.length,
      solidParts: 0,
      emptyParts: parts.filter((p) => p.cellCount === 0).length,
      leakyParts: 0,
      isolatedCells: 0,
      isolatedRemoved: 0,
    },
  };
}

const messages: VoxelPlaceMessages = {
  belowGround: (partId, cell) => `below:${partId}:${showCell(cell)}`,
  outOfRange: (cell) => `outside:${showCell(cell)}`,
};

describe('rotateCell', () => {
  it('§6 公式：0→(i,k)、90→(−k−1,i)、180→(−i−1,−k−1)、270→(k,−i−1)，y 不变', () => {
    assert.deepEqual(rotateCell([2, 5, 3], 0), [2, 5, 3]);
    assert.deepEqual(rotateCell([2, 5, 3], 90), [-4, 5, 2]);
    assert.deepEqual(rotateCell([2, 5, 3], 180), [-3, 5, -4]);
    assert.deepEqual(rotateCell([2, 5, 3], 270), [3, 5, -3]);
  });

  it('连转四次 90° 回到原格', () => {
    let cell: VoxelCell = [7, -2, 3];
    for (let i = 0; i < 4; i += 1) cell = rotateCell(cell, 90);
    assert.deepEqual(cell, [7, -2, 3]);
  });
});

describe('placeVoxelParts', () => {
  it('单部件：整次一次 commit（同 callId、结构层 body、parts 上下文），返回世界包围盒与句柄', () => {
    const writer = new Writer(table);
    const state: BlockState = writer.material('stone');
    const placement = placeVoxelParts(writer, {
      api: 'surfaceShell',
      args: { kind: 'surface', at: [1, 2, 3], rotate: 0 },
      result: result([
        part('shell', [
          [0, 0, 0],
          [1, 0, 0],
        ]),
      ]),
      at: [1, 2, 3],
      rotate: 0,
      stateForPart: () => state,
      messages,
      emptyError: null,
    });
    assert.deepEqual(placement.bounds, { min: [1, 2, 3], max: [2, 2, 3] });
    assert.equal(placement.counts.cells, 2);
    assert.equal(placement.parts.length, 1);
    assert.deepEqual(placement.parts[0], {
      id: 'shell',
      name: 'shell',
      role: 'roof',
      bounds: { min: [1, 2, 3], max: [2, 2, 3] },
      cellCount: 2,
    });
    const grid = writer.compose().grid;
    const cells = [...grid.cells()];
    assert.equal(cells.length, 2);
    assert(cells.every((c) => c.call === cells[0]?.call));
    assert.equal(grid.calls().length, 1);
    assert.equal(grid.calls()[0]?.api, 'surfaceShell');
    assert.match(grid.calls()[0]?.args ?? '', /"kind":"surface"/);
    assert.equal(grid.get(1, 2, 3)?.state.name, 'stone');
  });

  it('多部件：逐部件句柄与 parts 上下文按文档序登记，格带各自部件归属', () => {
    const writer = new Writer(table);
    const a: BlockState = writer.material('stone');
    const b: BlockState = writer.material('deepslate_tiles');
    placeVoxelParts(writer, {
      api: 'massingImport',
      args: { id: 'doc' },
      result: result([part('wall', [[0, 0, 0]], '墙'), part('roof', [[1, 0, 0]], '屋面')]),
      at: [0, 1, 0],
      rotate: 0,
      stateForPart: (p) => (p.id === 'wall' ? a : b),
      messages,
      emptyError: null,
    });
    const grid = writer.compose().grid;
    const parts = grid.parts();
    assert.deepEqual(
      parts.map((p) => p.name),
      ['墙', '屋面'],
    );
    const byName = new Map([...grid.cells()].map((c) => [c.state.name, c.part]));
    assert.notEqual(byName.get('stone'), byName.get('deepslate_tiles'));
  });

  it('旋转与 at 组合后 bounds / 格位置一致', () => {
    const writer = new Writer(table);
    const state: BlockState = writer.material('stone');
    const placement = placeVoxelParts(writer, {
      api: 'surfaceShell',
      args: {},
      result: result([
        part('shell', [
          [0, 0, 0],
          [3, 0, 1],
        ]),
      ]),
      at: [10, 1, 20],
      rotate: 90,
      stateForPart: () => state,
      messages,
      emptyError: null,
    });
    // (0,0,0)→(−1,0,0)；(3,0,1)→(−2,0,3)，再各加 at。
    assert.deepEqual(placement.bounds, { min: [8, 1, 20], max: [9, 1, 23] });
    assert.equal(writer.compose().grid.get(9, 1, 20)?.state.name, 'stone');
    assert.equal(writer.compose().grid.get(8, 1, 23)?.state.name, 'stone');
  });

  it('空结果抛 emptyError 且不留下调用', () => {
    const writer = new Writer(table);
    assert.throws(
      () =>
        placeVoxelParts(writer, {
          api: 'surfaceShell',
          args: {},
          result: result([]),
          at: [0, 1, 0],
          rotate: 0,
          stateForPart: () => writer.material('stone'),
          messages,
          emptyError: new MassingError('empty-shell', '没有格'),
        }),
      /没有格/,
    );
    assert.equal(writer.compose().grid.calls().length, 0);
  });

  it('y<1 整次拒绝：报最低格与部件 id，失败不留调用', () => {
    const writer = new Writer(table);
    assert.throws(
      () =>
        placeVoxelParts(writer, {
          api: 'surfaceShell',
          args: {},
          result: result([
            part('shell', [
              [0, 0, 0],
              [2, -3, 0],
            ]),
          ]),
          at: [0, 1, 0],
          rotate: 0,
          stateForPart: () => writer.material('stone'),
          messages,
          emptyError: null,
        }),
      (error: unknown) => {
        assert.ok(error instanceof MassingError);
        assert.equal(error.code, 'below-ground');
        assert.match(error.message, /shell/);
        assert.match(error.message, /\(2, -2, 0\)/);
        return true;
      },
    );
    assert.equal(writer.compose().grid.calls().length, 0);
  });

  it('越界整次拒绝：报最小越界格', () => {
    const writer = new Writer(table);
    assert.throws(
      () =>
        placeVoxelParts(writer, {
          api: 'surfaceShell',
          args: {},
          result: result([part('shell', [[0, 0, 0]])]),
          at: [2 ** 25, 1, 0],
          rotate: 0,
          stateForPart: () => writer.material('stone'),
          messages,
          emptyError: null,
        }),
      (error: unknown) => {
        assert.ok(error instanceof MassingError);
        assert.equal(error.code, 'out-of-range');
        return true;
      },
    );
    assert.equal(writer.compose().grid.calls().length, 0);
  });

  it('材质按文档序在放置校验前解析（材质错误先于越界报出）', () => {
    const writer = new Writer(table);
    const seen: string[] = [];
    assert.throws(
      () =>
        placeVoxelParts(writer, {
          api: 'surfaceShell',
          args: {},
          result: result([part('a', [[0, -5, 0]]), part('b', [[0, 0, 0]])]),
          at: [0, 1, 0],
          rotate: 0,
          stateForPart: (p) => {
            seen.push(p.id);
            throw new MassingError('material-invalid', `bad:${p.id}`);
          },
          messages,
          emptyError: null,
        }),
      /bad:a/,
    );
    assert.deepEqual(seen, ['a']);
  });
});

describe('showCell', () => {
  it('固定格式 (x, y, z)', () => {
    assert.equal(showCell([-1, 0, 2]), '(-1, 0, 2)');
  });
});
