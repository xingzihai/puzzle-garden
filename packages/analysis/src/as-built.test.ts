/* eslint-disable max-lines -- 提取器按结构 / 洞口 / 水平面 / 家具 / unknown 分组回归。 */
/**
 * CONF-NEXT-02C：通用 as-built 对象图提取器的小网格单测。
 *
 * 只用手工网格证明结构、洞口、家具、未知与确定性；四栋矩阵集成断言在 tools/conformance-objects.test.ts。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Grid } from '@pg/core/grid';

import { extractAsBuiltObjects } from './as-built.ts';
import type { FurnitureObject, OpeningObject, WallObject } from './as-built.ts';
import { box, gridOf, registry } from './fixtures.test.ts';
import { diffFurnitureObjects } from './object-diff.ts';
import type { ExpectedFurniture } from './object-diff.ts';

type CellTuple = [number, number, number, string];

interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

function inside(bounds: Bounds | undefined, x: number, y: number, z: number): boolean {
  if (bounds === undefined) return false;
  return (
    x >= bounds.min[0] &&
    x < bounds.max[0] &&
    y >= bounds.min[1] &&
    y < bounds.max[1] &&
    z >= bounds.min[2] &&
    z < bounds.max[2]
  );
}

/** 四面墙；hole 为半开挖空区。 */
function wallShell(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y0: number,
  y1: number,
  block: string,
  hole?: Bounds,
): CellTuple[] {
  const out: CellTuple[] = [];
  const push = (x: number, y: number, z: number): void => {
    if (!inside(hole, x, y, z)) out.push([x, y, z, block]);
  };
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      push(x, y, z0);
      push(x, y, z1);
    }
  }
  for (let z = z0; z <= z1; z += 1) {
    for (let y = y0; y <= y1; y += 1) {
      push(x0, y, z);
      push(x1, y, z);
    }
  }
  return out;
}

function house(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  wallTop: number,
  roofY: number,
  hole?: Bounds,
): CellTuple[] {
  return [
    ...box(x0, 0, z0, x1, 0, z1, 'polished_andesite'),
    ...wallShell(x0, x1, z0, z1, 1, wallTop, 'stone_bricks', hole),
    ...box(x0, roofY, z0, x1, roofY, z1, 'deepslate_tiles'),
  ];
}

/** 带调用记录的网格：用于区分“单层水平铺面调用”和墙体调用。 */
function gridWithCalls(groups: readonly { readonly api: string; readonly cells: readonly CellTuple[] }[]): Grid {
  const grid = createGrid(registry.table);
  for (const group of groups) {
    const call = grid.defineCall(group.api, 1, {});
    for (const [x, y, z, block] of group.cells) {
      grid.set(x, y, z, parseState(registry.table, block), 0, call);
    }
  }
  return grid;
}

function northWall(graph: ReturnType<typeof extractAsBuiltObjects>): WallObject {
  const wall = graph.objects.find(
    (object): object is WallObject =>
      object.kind === 'wall' && object.bounds.min[2] === 1 && object.bounds.max[2] === 2,
  );
  assert.ok(wall !== undefined, '缺少北墙');
  return wall;
}

function openingsOf(graph: ReturnType<typeof extractAsBuiltObjects>): OpeningObject[] {
  return graph.objects.filter((object): object is OpeningObject => object.kind === 'opening');
}

function assertCoverage(graph: ReturnType<typeof extractAsBuiltObjects>): void {
  const unknown = graph.objects.filter((object) => object.kind === 'unknown');
  const unknownCells = unknown.reduce((sum, object) => sum + object.cells, 0);
  const objectCells = graph.objects.reduce((sum, object) => sum + object.cells, 0);
  assert.equal(objectCells, graph.summary.totalCells);
  assert.equal(graph.coverage.assignedCells + graph.coverage.unknownCells, graph.coverage.totalCells);
  assert.equal(graph.coverage.unknownCells, unknownCells);
}

describe('extractAsBuiltObjects', () => {
  it('四面墙 + 楼板 + 平屋面：wall/slab/roof 存在且 bounds 半开', () => {
    const graph = extractAsBuiltObjects(gridOf(house(1, 4, 1, 3, 3, 4)), registry);
    assert.deepEqual(graph.summary.objectCounts, {
      wall: 4,
      slab: 1,
      roof: 1,
      opening: 0,
      site: 0,
      furniture: 0,
      unknown: 0,
    });
    const north = northWall(graph);
    assert.deepEqual(north.bounds, { min: [1, 1, 1], max: [5, 4, 2] });
    assert.equal(north.wall.lengthCells, 4);
    assert.equal(north.wall.heightCells, 3);
    assert.equal(north.support?.state, 'grounded');

    const roof = graph.objects.find((object) => object.kind === 'roof');
    assert.ok(roof !== undefined);
    assert.deepEqual(roof.bounds, { min: [1, 4, 1], max: [5, 5, 4] });
    assert.equal(roof.support?.state, 'supported');
    assert.equal(roof.roof.topCells, 12);
    assert.equal(roof.roof.formHint, 'flat');
    assert.equal(roof.roof.pitchDegrees, 0);

    const slab = graph.objects.find((object) => object.kind === 'slab');
    assert.ok(slab !== undefined);
    assert.deepEqual(slab.bounds, { min: [1, 0, 1], max: [5, 1, 4] });
    assert.equal(slab.support?.state, 'grounded');
    assertCoverage(graph);
  });

  it('檐口压顶行不计入墙高，也不落成 slab', () => {
    const cells: CellTuple[] = [
      ...box(1, 0, 1, 5, 0, 5, 'polished_andesite'),
      ...wallShell(1, 5, 1, 5, 1, 3, 'stone_bricks'),
      ...wallShell(1, 5, 1, 5, 4, 4, 'oak_planks'),
      ...wallShell(0, 6, 0, 6, 4, 4, 'deepslate_tile_stairs'),
      ...box(0, 5, 0, 6, 5, 6, 'deepslate_tiles'),
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const north = northWall(graph);
    assert.deepEqual(north.bounds, { min: [1, 1, 1], max: [6, 4, 2] });
    assert.equal(north.wall.heightCells, 3);
    const slabs = graph.objects.filter((object) => object.kind === 'slab');
    assert.equal(slabs.length, 1);
    const slab = slabs[0];
    assert.ok(slab !== undefined);
    assert.deepEqual(slab.bounds, { min: [1, 0, 1], max: [6, 1, 6] });
    assertCoverage(graph);
  });

  it('墙脚两侧同层都有楼板时，墙高仍按完整面板计算', () => {
    const cells: CellTuple[] = [
      ...box(0, 0, 0, 4, 0, 4, 'grass_block'),
      ...box(0, 1, 0, 4, 1, 4, 'polished_andesite'),
      ...box(1, 1, 1, 3, 3, 1, 'stone_bricks'),
      ...box(1, 1, 3, 3, 3, 3, 'stone_bricks'),
      ...box(1, 1, 2, 1, 3, 2, 'stone_bricks'),
      ...box(3, 1, 2, 3, 3, 2, 'stone_bricks'),
      ...box(1, 4, 1, 3, 4, 3, 'deepslate_tiles'),
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const north = northWall(graph);
    assert.equal(north.wall.heightCells, 3);
    assert.deepEqual(north.bounds, { min: [1, 1, 1], max: [4, 4, 2] });
    assertCoverage(graph);
  });

  it('屋面挑檐下的室外草地不算楼板，室内外按墙 footprint 分开', () => {
    const cells: CellTuple[] = [
      ...box(0, 0, 0, 6, 0, 6, 'grass_block'),
      ...box(1, 0, 1, 5, 0, 5, 'polished_andesite'),
      ...wallShell(1, 5, 1, 5, 1, 3, 'stone_bricks'),
      ...box(0, 4, 0, 6, 4, 6, 'deepslate_tiles'),
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const slabs = graph.objects.filter((object) => object.kind === 'slab');
    assert.equal(slabs.length, 1);
    const slab = slabs[0];
    assert.ok(slab !== undefined);
    assert.deepEqual(slab.bounds, { min: [1, 0, 1], max: [6, 1, 6] });
    assert.equal(slab.cells, 25);
    const site = graph.objects.find((object) => object.kind === 'site');
    assert.ok(site !== undefined);
    assert.deepEqual(site.bounds, { min: [0, 0, 0], max: [7, 1, 7] });
    assert.equal(site.cells, 24);
    assertCoverage(graph);
  });

  it('2×2 玻璃窗：窗台/窗楣留在墙面板，opening 指向宿主墙', () => {
    const hole = { min: [2, 2, 1] as const, max: [4, 4, 2] as const };
    const cells: CellTuple[] = [...house(1, 5, 1, 4, 4, 5, hole), ...box(2, 2, 1, 3, 3, 1, 'glass')];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const north = northWall(graph);
    assert.equal(north.wall.heightCells, 4);
    assert.equal(north.wall.lengthCells, 5);

    const openings = openingsOf(graph);
    assert.equal(openings.length, 1);
    const opening = openings[0];
    assert.ok(opening !== undefined);
    assert.equal(opening.opening.subtype, 'window');
    assert.equal(opening.opening.fill, 'glass');
    assert.equal(opening.opening.widthCells, 2);
    assert.equal(opening.opening.heightCells, 2);
    assert.equal(opening.opening.fillCells, 4);
    assert.equal(opening.opening.voidCells, 0);
    assert.deepEqual(opening.bounds, { min: [2, 2, 1], max: [4, 4, 2] });
    assert.equal(opening.host, north.id);
    assert.equal(opening.cells, 4);
    assertCoverage(graph);
  });

  it('门板：door / door-panel', () => {
    const hole = { min: [2, 1, 1] as const, max: [3, 3, 2] as const };
    const cells = [...house(1, 5, 1, 4, 4, 5, hole), ...box(2, 1, 1, 2, 2, 1, 'oak_door')];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const openings = openingsOf(graph);
    assert.equal(openings.length, 1);
    const opening = openings[0];
    assert.ok(opening !== undefined);
    assert.equal(opening.opening.subtype, 'door');
    assert.equal(opening.opening.fill, 'door-panel');
    assert.equal(opening.opening.widthCells, 1);
    assert.equal(opening.opening.heightCells, 2);
    assert.equal(opening.opening.fillCells, 2);
    assert.equal(opening.opening.voidCells, 0);
    assert.equal(opening.cells, 2);
    assert.equal(opening.host, northWall(graph).id);
    assertCoverage(graph);
  });

  it('纯空气门洞：passage / air / cells=0 / voidCells>0', () => {
    const hole = { min: [2, 1, 1] as const, max: [4, 3, 2] as const };
    const graph = extractAsBuiltObjects(gridOf(house(1, 5, 1, 4, 4, 5, hole)), registry);
    const openings = openingsOf(graph);
    assert.equal(openings.length, 1);
    const opening = openings[0];
    assert.ok(opening !== undefined);
    assert.equal(opening.opening.subtype, 'passage');
    assert.equal(opening.opening.fill, 'air');
    assert.equal(opening.cells, 0);
    assert.equal(opening.opening.fillCells, 0);
    assert.equal(opening.opening.voidCells, 4);
    assert.deepEqual(opening.materials, []);
    assert.deepEqual(opening.source.calls, []);
    assert.ok(opening.samples.length > 0);
    assert.equal(opening.host, northWall(graph).id);
    assertCoverage(graph);
  });

  it('两格床：furniture bed，cells=2', () => {
    const cells: CellTuple[] = [...box(-2, 0, -2, 2, 0, 2, 'grass_block'), [0, 1, 0, 'red_bed'], [1, 1, 0, 'red_bed']];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const furniture = graph.objects.filter((object) => object.kind === 'furniture');
    assert.equal(furniture.length, 1);
    const bed = furniture[0];
    assert.ok(bed !== undefined);
    assert.equal(bed.furniture.subtype, 'bed');
    assert.equal(bed.cells, 2);
    assert.equal(bed.support?.state, 'grounded');
    assertCoverage(graph);
  });

  it('storage 行：箱子/桶合并为一个 storage', () => {
    const cells: CellTuple[] = [...box(-2, 0, -2, 2, 0, 2, 'grass_block'), [0, 1, 0, 'chest'], [1, 1, 0, 'barrel']];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const furniture = graph.objects.filter((object) => object.kind === 'furniture');
    assert.equal(furniture.length, 1);
    const storage = furniture[0];
    assert.ok(storage !== undefined);
    assert.equal(storage.furniture.subtype, 'storage');
    assert.equal(storage.cells, 2);
    assert.deepEqual(
      storage.materials.map((item) => item.block),
      ['barrel', 'chest'],
    );
    assertCoverage(graph);
  });

  it('贴墙书架：shelf 不被墙吞掉，墙面板保持完整', () => {
    const cells = [
      ...box(1, 0, 0, 5, 0, 1, 'oak_planks'),
      ...wallShell(1, 5, 0, 0, 1, 3, 'stone_bricks'),
      ...box(1, 4, 0, 5, 4, 1, 'deepslate_tiles'),
      ...box(2, 1, 1, 4, 1, 1, 'bookshelf'),
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const walls = graph.objects.filter((object) => object.kind === 'wall');
    assert.equal(walls.length, 1);
    const wall = walls[0];
    assert.ok(wall !== undefined);
    assert.equal(wall.cells, 15);
    const furniture = graph.objects.filter((object) => object.kind === 'furniture');
    assert.equal(furniture.length, 1);
    const shelf = furniture[0];
    assert.ok(shelf !== undefined);
    assert.equal(shelf.furniture.subtype, 'shelf');
    assert.equal(shelf.cells, 3);
    assert.equal(shelf.support?.state, 'grounded');
    assert.equal(graph.summary.unknownCells, 0);
    assertCoverage(graph);
  });

  it('实心体量不被误判成四面墙：3×3×4 实心块 wall=0', () => {
    const graph = extractAsBuiltObjects(gridOf(box(0, 0, 0, 2, 3, 2, 'stone_bricks')), registry);
    assert.equal(graph.summary.objectCounts.wall, 0);
    assert.equal(graph.summary.objectCounts.opening, 0);
    assertCoverage(graph);
  });

  it('未知单格：unknown 保留且 coverage 成立', () => {
    const graph = extractAsBuiltObjects(gridOf([[0, 0, 0, 'cobweb']]), registry);
    assert.equal(graph.summary.unknownCells, 1);
    assert.equal(graph.summary.objectCounts.unknown, 1);
    const unknown = graph.objects.find((object) => object.kind === 'unknown');
    assert.ok(unknown !== undefined);
    assert.equal(unknown.cells, 1);
    assert.equal(unknown.unknown.reason, 'no-rule-match');
    assert.equal(unknown.samples.length, 1);
    assert.deepEqual(unknown.bounds, { min: [0, 0, 0], max: [1, 1, 1] });
    assertCoverage(graph);
  });

  it('空网格：objects=[]、bounds=null、assignedRatio=null', () => {
    const graph = extractAsBuiltObjects(gridOf([]), registry);
    assert.deepEqual(graph.objects, []);
    assert.equal(graph.bounds, null);
    assert.equal(graph.coverage.assignedRatio, null);
    assert.equal(graph.coverage.totalCells, 0);
    assert.equal(graph.summary.totalCells, 0);
    assert.deepEqual(graph.diagnostics, []);
  });

  it('确定性：不同写入顺序重建，JSON.stringify 一致', () => {
    const hole = { min: [2, 2, 1] as const, max: [4, 4, 2] as const };
    const cells: CellTuple[] = [
      ...house(1, 5, 1, 4, 4, 5, hole),
      ...box(2, 2, 1, 3, 3, 1, 'glass'),
      ...box(-4, 0, -2, -1, 0, 2, 'grass_block'),
      [-3, 1, 0, 'red_bed'],
      [-2, 1, 0, 'red_bed'],
      [-4, 3, 0, 'cobweb'],
    ];
    const forward = extractAsBuiltObjects(gridOf(cells), registry);
    const backward = extractAsBuiltObjects(gridOf([...cells].reverse()), registry);
    assert.equal(JSON.stringify(forward), JSON.stringify(backward));
  });

  it('coverage：结构 + 家具 + 未知的组合网格双不变量成立', () => {
    const cells: CellTuple[] = [
      ...box(0, 0, 0, 5, 0, 5, 'grass_block'),
      ...box(1, 0, 1, 4, 0, 3, 'oak_planks'),
      ...wallShell(1, 4, 1, 3, 1, 3, 'stone_bricks'),
      ...box(1, 4, 1, 4, 4, 3, 'deepslate_tiles'),
      [3, 1, 1, 'glass'],
      [0, 1, 0, 'cobweb'],
      [5, 1, 5, 'glass'],
      [0, 1, 1, 'red_bed'],
      [1, 1, 1, 'red_bed'],
      [5, 1, 0, 'chest'],
      [5, 1, 1, 'barrel'],
      [0, 2, 0, 'oak_slab'],
      [0, 3, 0, 'oak_stairs'],
      [5, 2, 5, 'oak_door'],
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    assertCoverage(graph);
    assert.equal(graph.coverage.assignedRatio === null, false);
  });

  it('悬空墙 / 贴边界：不崩溃，support 与 clipped 合理', () => {
    const cells = [...box(0, 0, -1, 5, 0, 1, 'grass_block'), ...box(1, 3, 0, 4, 4, 0, 'stone_bricks')];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const walls = graph.objects.filter((object) => object.kind === 'wall');
    assert.equal(walls.length, 1);
    const wall = walls[0];
    assert.ok(wall !== undefined);
    assert.equal(wall.wall.heightCells, 2);
    assert.equal(wall.support?.state, 'unsupported');
    assert.equal(wall.clipped, true);
    assertCoverage(graph);
  });

  it('相邻两窗：中间 1 格墙，得到 2 个 opening 而不是 1 个大洞', () => {
    const withHoles = [
      ...house(1, 7, 1, 4, 4, 5),
      ...box(2, 2, 1, 2, 3, 1, 'glass'),
      ...box(4, 2, 1, 4, 3, 1, 'glass'),
    ];
    const graph = extractAsBuiltObjects(gridOf(withHoles), registry);
    const openings = openingsOf(graph);
    assert.equal(openings.length, 2);
    assert.deepEqual(
      openings
        .map((opening) => [opening.opening.widthCells, opening.opening.heightCells])
        .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)),
      [
        [1, 2],
        [1, 2],
      ],
    );
    assert.equal(
      openings.every((opening) => opening.opening.fill === 'glass'),
      true,
    );
    assertCoverage(graph);
  });

  it('超大缺口：拒绝为 opening，记 unrepresented-void', () => {
    const cells = [
      ...box(1, 0, 1, 8, 0, 4, 'polished_andesite'),
      ...wallShell(1, 8, 1, 4, 1, 4, 'stone_bricks', { min: [2, 1, 1], max: [8, 4, 2] }),
      ...box(1, 5, 1, 8, 5, 4, 'deepslate_tiles'),
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    assert.equal(openingsOf(graph).length, 0);
    assert.equal(graph.summary.objectCounts.wall, 4);
    assert.equal(graph.summary.unknownCells, 0);
    const diagnostic = graph.diagnostics.find((item) => item.code === 'unrepresented-void');
    assert.ok(diagnostic !== undefined);
    assert.equal(diagnostic.count, 1);
    assertCoverage(graph);
  });
});

describe('as-built 对象形状', () => {
  it('ID 为 kind@minX,minY,minZ，重复最小角按全序加 ~2', () => {
    const graph = extractAsBuiltObjects(gridOf(house(1, 4, 1, 3, 3, 4)), registry);
    const walls = graph.objects.filter((object): object is WallObject => object.kind === 'wall');
    const ids = walls.map((wall) => wall.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(
      ids.every((id) => /^wall@\d+,\d+,\d+(?:~\d+)?$/.test(id)),
      true,
    );
    const duplicatedMin = walls.filter((wall) => wall.id.startsWith('wall@1,1,1'));
    assert.equal(duplicatedMin.length, 2);
    assert.equal(
      duplicatedMin.some((wall) => wall.id === 'wall@1,1,1~2'),
      true,
    );
  });

  it('samples 按 (y,z,x) 升序且最多 20，materials 按 block 名升序', () => {
    const graph = extractAsBuiltObjects(gridOf(house(1, 4, 1, 3, 3, 4)), registry);
    for (const object of graph.objects) {
      const keys = object.samples.map((sample) => [sample.y, sample.z, sample.x] as const);
      const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      assert.deepEqual(keys, sorted);
      assert.ok(object.samples.length <= 20);
      const blocks = object.materials.map((item) => item.block);
      assert.deepEqual(blocks, [...blocks].sort());
    }
  });
});

describe('CONF-NEXT-02D 边界修补', () => {
  it('2×2 抬高小台面不并入 floor slab：floor 仍 25 格，台面进 unknown', () => {
    const cells = [...house(1, 5, 1, 5, 3, 4), ...box(2, 1, 2, 3, 1, 3, 'oak_slab')];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const slabs = graph.objects.filter((object) => object.kind === 'slab');
    assert.equal(slabs.length, 1);
    const slab = slabs[0];
    assert.ok(slab !== undefined);
    assert.equal(slab.cells, 25);
    assert.equal(slab.slab.areaCells, 25);
    assert.equal(slab.slab.topY, 0);
    assert.equal(slab.slab.bottomY, 0);
    assert.equal(slab.slab.thicknessCells, 1);
    assert.equal(graph.summary.unknownCells, 4);
    const unknown = graph.objects.find((object) => object.kind === 'unknown');
    assert.ok(unknown !== undefined);
    assert.equal(unknown.cells, 4);
    assert.equal(unknown.unknown.reason, 'no-rule-match');
    assert.equal(unknown.confidence, 'low');
    assert.deepEqual(
      unknown.materials.map((item) => item.block),
      ['oak_slab'],
    );
    assertCoverage(graph);
  });

  it('3×3 抬高台面不并入 floor slab：floor 25 格，台面 9 格进 unknown', () => {
    const cells = [...house(1, 5, 1, 5, 3, 4), ...box(2, 1, 2, 4, 1, 4, 'oak_slab')];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const slab = graph.objects.find((object) => object.kind === 'slab');
    assert.ok(slab !== undefined);
    assert.equal(slab.cells, 25);
    assert.equal(slab.slab.areaCells, 25);
    assert.equal(slab.slab.topY, 0);
    assert.equal(graph.summary.unknownCells, 9);
    const unknown = graph.objects.find((object) => object.kind === 'unknown');
    assert.ok(unknown !== undefined);
    assert.equal(unknown.unknown.reason, 'no-rule-match');
    assertCoverage(graph);
  });

  it('4×4 单层薄台面是面积上限边界：仍进 unknown，不并入 floor', () => {
    const cells = [...house(1, 6, 1, 6, 3, 4), ...box(2, 1, 2, 5, 1, 5, 'oak_slab')];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const slab = graph.objects.find((object) => object.kind === 'slab');
    assert.ok(slab !== undefined);
    assert.equal(slab.cells, 36);
    assert.equal(slab.slab.areaCells, 36);
    assert.equal(slab.slab.topY, 0);
    assert.equal(graph.summary.unknownCells, 16);
    const unknown = graph.objects.find((object) => object.kind === 'unknown');
    assert.ok(unknown !== undefined);
    assert.equal(unknown.unknown.reason, 'no-rule-match');
    assertCoverage(graph);
  });

  it('4×4 两层抬高平台仍按 slab 处理：不被薄台面规则误伤', () => {
    const cells = [
      ...house(1, 6, 1, 6, 3, 4),
      ...box(2, 1, 2, 5, 1, 5, 'oak_slab'),
      ...box(2, 2, 2, 5, 2, 5, 'oak_slab'),
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const slabs = graph.objects.filter((object) => object.kind === 'slab');
    assert.equal(slabs.length, 1);
    const slab = slabs[0];
    assert.ok(slab !== undefined);
    assert.equal(slab.slab.topY, 2);
    assert.equal(slab.slab.areaCells, 36);
    assert.equal(slab.slab.thicknessCells, 3);
    assert.equal(slab.cells, 68);
    assert.equal(graph.summary.unknownCells, 0);
    assertCoverage(graph);
  });

  it('拐角缺口 host：按边界墙格数选，平局取 wall id 字典序最小', () => {
    const cells = house(1, 4, 1, 4, 3, 4).filter(([x, y, z]) => !(x === 1 && z === 1 && (y === 1 || y === 2)));
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const walls = graph.objects.filter((object): object is WallObject => object.kind === 'wall');
    const west = walls.find((wall) => wall.bounds.min[0] === 1 && wall.bounds.max[0] === 2 && wall.bounds.max[2] === 5);
    const north = walls.find(
      (wall) => wall.bounds.min[2] === 1 && wall.bounds.max[2] === 2 && wall.bounds.max[0] === 5,
    );
    assert.ok(west !== undefined && north !== undefined);
    const openings = openingsOf(graph);
    assert.equal(openings.length, 1);
    const opening = openings[0];
    assert.ok(opening !== undefined);
    // 缺口在西北拐角；两侧面板边界格数打平，按 wall id 取 west（base id）。
    assert.equal(opening.host, west.id);
    assert.notEqual(opening.host, north.id);
    assert.deepEqual(opening.bounds, { min: [1, 1, 1], max: [2, 3, 2] });
    assert.equal(opening.opening.subtype, 'passage');
    assert.equal(opening.opening.widthCells, 1);
    assert.equal(opening.opening.heightCells, 2);
    assertCoverage(graph);
  });

  it('support schema：wall 为 {state,supportedBy}，opening 为 unknown，site/unknown 为 null', () => {
    const hole = { min: [2, 2, 1] as const, max: [4, 4, 2] as const };
    const cells: CellTuple[] = [
      ...house(1, 5, 1, 4, 3, 4, hole),
      ...box(2, 2, 1, 3, 3, 1, 'glass'),
      [0, 0, 1, 'gravel'],
      [0, 3, 0, 'cobweb'],
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const wall = northWall(graph);
    const wallSupport = wall.support;
    assert.ok(wallSupport !== null);
    assert.equal(wallSupport.state, 'grounded');
    assert.ok(wallSupport.supportedBy !== undefined);
    assert.ok(wallSupport.supportedBy.length > 0);
    assert.deepEqual(wallSupport.supportedBy, [...wallSupport.supportedBy].sort());

    const opening = openingsOf(graph)[0];
    assert.ok(opening !== undefined);
    const openingSupport = opening.support;
    assert.ok(openingSupport !== null);
    assert.equal(openingSupport.state, 'unknown');
    assert.equal(Object.hasOwn(openingSupport, 'supportedBy'), false);

    const site = graph.objects.find((object) => object.kind === 'site');
    assert.ok(site !== undefined);
    assert.equal(site.support, null);
    const unknown = graph.objects.find((object) => object.kind === 'unknown');
    assert.ok(unknown !== undefined);
    assert.equal(unknown.support, null);
    assertCoverage(graph);
  });

  it('3 格高书架贴墙：仍是 furniture.shelf，不产生墙，也不切碎墙面板', () => {
    const cells = [
      ...box(1, 0, 0, 6, 0, 1, 'oak_planks'),
      ...wallShell(1, 6, 0, 0, 1, 4, 'stone_bricks'),
      ...box(1, 5, 0, 6, 5, 1, 'deepslate_tiles'),
      ...box(3, 2, 1, 3, 4, 1, 'bookshelf'),
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const walls = graph.objects.filter((object): object is WallObject => object.kind === 'wall');
    assert.equal(walls.length, 1);
    const wall = walls[0];
    assert.ok(wall !== undefined);
    assert.equal(wall.cells, 24);
    const furniture = graph.objects.filter((object) => object.kind === 'furniture');
    assert.equal(furniture.length, 1);
    const shelf = furniture[0];
    assert.ok(shelf !== undefined);
    assert.equal(shelf.furniture.subtype, 'shelf');
    assert.equal(shelf.cells, 3);
    assert.deepEqual(shelf.bounds, { min: [3, 2, 1], max: [4, 5, 2] });
    // 书架底部悬空，靠侧向墙支撑。
    assert.equal(shelf.support?.state, 'supported');
    assert.equal(graph.summary.unknownCells, 0);
    assertCoverage(graph);
  });

  it('孤立玻璃无宿主墙：进入 unknown isolated-fill，不静默消失', () => {
    const graph = extractAsBuiltObjects(gridOf([[0, 0, 0, 'glass']]), registry);
    assert.equal(openingsOf(graph).length, 0);
    assert.equal(graph.summary.unknownCells, 1);
    const unknown = graph.objects.find((object) => object.kind === 'unknown');
    assert.ok(unknown !== undefined);
    assert.equal(unknown.unknown.reason, 'isolated-fill');
    assert.equal(unknown.confidence, 'low');
    assertCoverage(graph);
  });

  it('结构残片：进入 unknown ambiguous-geometry，不静默丢失', () => {
    const cells = [...box(-3, 0, -3, 3, 0, 3, 'grass_block'), ...box(1, 2, 0, 2, 3, 0, 'stone_bricks')];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    assert.equal(graph.summary.objectCounts.wall, 0);
    const unknown = graph.objects.find((object) => object.kind === 'unknown');
    assert.ok(unknown !== undefined);
    assert.equal(unknown.cells, 4);
    assert.equal(unknown.unknown.reason, 'ambiguous-geometry');
    assertCoverage(graph);
  });
});

describe('通用家具：table / bench / counter / light', () => {
  /** 11×11 房间：地板 y=0、墙 y=1..4、平屋面 y=5；家具都在站立面 y=1，彼此留 1 格通道。 */
  function furnitureRoom(): CellTuple[] {
    return [
      ...box(1, 0, 1, 11, 0, 11, 'polished_andesite'),
      ...wallShell(1, 11, 1, 11, 1, 4, 'stone_bricks'),
      ...box(1, 5, 1, 11, 5, 11, 'deepslate_tiles'),
      ...box(3, 1, 5, 6, 1, 6, 'oak_planks'), // 4×2×1 table
      ...box(3, 1, 3, 6, 1, 3, 'oak_planks'), // 4×1×1 bench (north)
      ...box(3, 1, 8, 6, 1, 8, 'oak_planks'), // 4×1×1 bench (south)
      ...box(8, 1, 3, 9, 1, 3, 'oak_planks'), // 2×1×1 counter
      [9, 1, 5, 'lantern'],
    ];
  }

  function furnitureOf(graph: ReturnType<typeof extractAsBuiltObjects>): FurnitureObject[] {
    return graph.objects.filter((object): object is FurnitureObject => object.kind === 'furniture');
  }

  it('4×2 桌 + 两条 4×1 凳 + 2×1 台 + 1×1 灯：subtype / seatCapacity / no unknown', () => {
    const graph = extractAsBuiltObjects(gridOf(furnitureRoom()), registry);
    const furniture = furnitureOf(graph);
    assert.equal(furniture.length, 5);
    assert.equal(graph.summary.objectCounts.furniture, 5);
    assert.equal(graph.summary.objectCounts.unknown, 0);
    assert.equal(graph.summary.unknownCells, 0);
    assert.equal(graph.coverage.assignedRatio, 1);

    const byBounds = (tuple: readonly [number, number, number, number, number, number]): FurnitureObject => {
      const found = furniture.find(
        (object) =>
          object.bounds.min[0] === tuple[0] &&
          object.bounds.min[1] === tuple[1] &&
          object.bounds.min[2] === tuple[2] &&
          object.bounds.max[0] === tuple[3] &&
          object.bounds.max[1] === tuple[4] &&
          object.bounds.max[2] === tuple[5],
      );
      assert.ok(found !== undefined, `缺少 furniture ${tuple.join(',')}`);
      return found;
    };

    const table = byBounds([3, 1, 5, 7, 2, 7]);
    const benchNorth = byBounds([3, 1, 3, 7, 2, 4]);
    const benchSouth = byBounds([3, 1, 8, 7, 2, 9]);
    const counter = byBounds([8, 1, 3, 10, 2, 4]);
    const lantern = byBounds([9, 1, 5, 10, 2, 6]);

    // 几何分类只区分 table / bench / counter / light。
    assert.equal(table.furniture.subtype, 'table');
    assert.equal(counter.furniture.subtype, 'counter');
    assert.equal(benchNorth.furniture.subtype, 'bench');
    assert.equal(benchSouth.furniture.subtype, 'bench');
    assert.equal(lantern.furniture.subtype, 'light');
    assert.deepEqual(furniture.map((object) => object.furniture.subtype).sort(), [
      'bench',
      'bench',
      'counter',
      'light',
      'table',
    ]);

    // 4 / 0.8 = 5；4×2 桌面与 2×1 台面不是长条凳。
    assert.equal(benchNorth.furniture.seatCapacity, 5);
    assert.equal(benchSouth.furniture.seatCapacity, 5);
    assert.equal(table.furniture.seatCapacity, null);
    assert.equal(counter.furniture.seatCapacity, null);
    assert.equal(lantern.furniture.seatCapacity, null);
    for (const object of furniture) {
      assert.equal(object.support?.state, 'grounded');
      assert.equal(object.furniture.heightCells, 1);
      assertCoverage(graph);
    }

    const repeated = extractAsBuiltObjects(gridOf([...furnitureRoom()].reverse()), registry);
    assert.equal(JSON.stringify(repeated), JSON.stringify(graph));

    const expected: ExpectedFurniture[] = [
      {
        id: 'furniture:table',
        kind: 'furniture',
        bounds: { min: [3, 1, 5], max: [7, 2, 7] },
        materialBlock: 'oak_planks',
        furnitureKind: 'table',
        seatCapacity: null,
        unverifiedReason: null,
      },
      {
        id: 'furniture:bench-north',
        kind: 'furniture',
        bounds: { min: [3, 1, 3], max: [7, 2, 4] },
        materialBlock: 'oak_planks',
        furnitureKind: 'bench',
        seatCapacity: 5,
        unverifiedReason: null,
      },
      {
        id: 'furniture:bench-south',
        kind: 'furniture',
        bounds: { min: [3, 1, 8], max: [7, 2, 9] },
        materialBlock: 'oak_planks',
        furnitureKind: 'bench',
        seatCapacity: 5,
        unverifiedReason: null,
      },
      {
        id: 'furniture:counter',
        kind: 'furniture',
        bounds: { min: [8, 1, 3], max: [10, 2, 4] },
        materialBlock: 'oak_planks',
        furnitureKind: 'counter',
        seatCapacity: null,
        unverifiedReason: null,
      },
      {
        id: 'furniture:lantern',
        kind: 'furniture',
        bounds: { min: [9, 1, 5], max: [10, 2, 6] },
        materialBlock: 'lantern',
        furnitureKind: 'light',
        seatCapacity: null,
        unverifiedReason: null,
      },
    ];
    const items = diffFurnitureObjects(expected, graph.objects);
    assert.equal(items.length, 5);
    assert.equal(
      items.every((item) => item.status === 'pass' && item.severity === 'hard'),
      true,
    );
    assert.equal(
      items.some((item) => item.status === 'missing' || item.status === 'extra' || item.status === 'unverified'),
      false,
    );
  });

  it('贴墙 4×1 长凳是家具，不吞墙也不并进楼板', () => {
    const cells = [
      ...box(1, 0, 1, 11, 0, 11, 'polished_andesite'),
      ...wallShell(1, 11, 1, 11, 1, 4, 'stone_bricks'),
      ...box(1, 5, 1, 11, 5, 11, 'deepslate_tiles'),
      ...box(3, 1, 2, 6, 1, 2, 'oak_planks'), // z=2 紧贴 z=1 的北墙
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    assert.equal(graph.summary.objectCounts.wall, 4);
    const furniture = graph.objects.filter((object) => object.kind === 'furniture');
    assert.equal(furniture.length, 1);
    const bench = furniture[0];
    assert.ok(bench !== undefined);
    assert.deepEqual(bench.bounds, { min: [3, 1, 2], max: [7, 2, 3] });
    assert.equal(bench.furniture.subtype, 'bench');
    assert.equal(bench.furniture.seatCapacity, 5);
    // 单层家具不再与楼板合并；楼板仍是 1 格厚的室内地面。
    assert.equal(graph.summary.objectCounts.slab, 1);
    assert.equal(graph.objects.find((object) => object.kind === 'slab')?.bounds.max[1], 1);
    assert.equal(graph.summary.unknownCells, 0);
    assertCoverage(graph);
  });

  it('2 格高桌 / 柜台不被当成墙；灯具单独成家具体量；5×5 平台仍留给 slab', () => {
    const cells = [
      ...box(1, 0, 1, 12, 0, 12, 'polished_andesite'),
      ...wallShell(1, 12, 1, 12, 1, 4, 'stone_bricks'),
      ...box(1, 5, 1, 12, 5, 12, 'deepslate_tiles'),
      ...box(2, 1, 2, 5, 2, 3, 'oak_planks'), // 4×2×2 桌
      ...box(7, 1, 2, 8, 2, 4, 'dark_oak_planks'), // 2×3×2 柜台
      ...box(9, 1, 8, 9, 1, 8, 'lantern'), // 落地灯具（悬空吊灯是已知限制）
      ...box(2, 1, 7, 6, 1, 11, 'stone_bricks'), // 5×5 单层平台
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    assert.equal(graph.summary.objectCounts.wall, 4, '桌 / 柜台不能变成假墙');
    const furniture = graph.objects.filter((object): object is FurnitureObject => object.kind === 'furniture');
    assert.equal(furniture.length, 3);
    assert.equal(furniture.filter((object) => object.furniture.subtype === 'light').length, 1);
    assert.equal(
      furniture.some((object) => object.bounds.max[0] === 6 && object.bounds.max[2] === 4),
      true,
    );
    assert.equal(
      furniture.some((object) => object.bounds.min[0] === 2 && object.bounds.max[0] === 7),
      false,
      '5×5 平台不能被当成家具',
    );
    assert.equal(graph.summary.objectCounts.slab, 1, '平台并入 base slab 包络');
    assertCoverage(graph);
  });

  it('场地低一格时 floorPlate 不被并进墙脚，slab/柱仍能正确分层', () => {
    const graph = extractAsBuiltObjects(
      gridWithCalls([
        { api: 'box', cells: box(0, -1, 0, 13, -1, 11, 'grass_block') },
        { api: 'floorPlate', cells: box(2, 0, 2, 11, 0, 9, 'polished_andesite') },
        { api: 'walls', cells: wallShell(2, 11, 2, 9, 1, 4, 'stone_bricks') },
        { api: 'roof', cells: box(1, 5, 1, 12, 5, 10, 'deepslate_tiles') },
        {
          api: 'set',
          cells: [
            [5, 2, 5, 'oak_planks'],
            [5, 3, 5, 'oak_planks'],
            [5, 4, 5, 'oak_planks'],
          ],
        },
      ]),
      registry,
    );
    const walls = graph.objects.filter((object): object is WallObject => object.kind === 'wall');
    assert.equal(walls.length, 4);
    assert.deepEqual(
      walls.reduce(
        (acc, wall) => ({
          minY: Math.min(acc.minY, wall.bounds.min[1]),
          maxZ: Math.max(acc.maxZ, wall.bounds.max[2]),
        }),
        { minY: Infinity, maxZ: -Infinity },
      ),
      { minY: 1, maxZ: 10 },
    );
    const slab = graph.objects.find((object) => object.kind === 'slab');
    assert.ok(slab !== undefined);
    assert.deepEqual(slab.bounds, { min: [2, 0, 2], max: [12, 1, 10] });
    assert.equal(slab.cells, 80);
    assertCoverage(graph);
  });

  it('外凸窗框不进入 wall 包络，墙体本身仍完整', () => {
    const shell = wallShell(2, 11, 2, 9, 1, 4, 'stone_bricks').filter(
      ([x, y, z]) => !(z === 9 && x >= 5 && x <= 8 && y >= 2 && y <= 3),
    );
    const frame = box(4, 1, 10, 9, 4, 10, 'stripped_spruce_log').filter(
      ([x, y]) => !(x >= 5 && x <= 8 && y >= 2 && y <= 3),
    );
    const cells: CellTuple[] = [
      ...box(2, 0, 2, 11, 0, 9, 'polished_andesite'),
      ...shell,
      ...frame,
      ...box(5, 2, 9, 8, 3, 9, 'glass'),
      ...box(1, 5, 1, 12, 5, 10, 'deepslate_tiles'),
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const walls = graph.objects.filter((object): object is WallObject => object.kind === 'wall');
    assert.equal(walls.length, 4);
    assert.equal(
      walls.some((wall) => wall.bounds.min[2] >= 10),
      false,
      '外凸 1 格的窗框不是独立墙',
    );
    assert.deepEqual(
      walls.reduce(
        (acc, wall) => ({
          minY: Math.min(acc.minY, wall.bounds.min[1]),
          maxZ: Math.max(acc.maxZ, wall.bounds.max[2]),
        }),
        { minY: Infinity, maxZ: -Infinity },
      ),
      { minY: 1, maxZ: 10 },
    );
    const opening = openingsOf(graph).find((item) => item.opening.subtype === 'window');
    assert.ok(opening !== undefined);
    assert.equal(opening.opening.widthCells, 4);
    assert.equal(opening.opening.heightCells, 2);
    assertCoverage(graph);
  });

  it('家具上方的 1×1 柱不把桌子并成高体量', () => {
    const cells: CellTuple[] = [
      ...house(1, 6, 1, 5, 4, 5),
      ...box(2, 1, 2, 4, 1, 3, 'oak_planks'),
      ...box(4, 2, 2, 4, 4, 2, 'oak_planks'),
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    const furniture = graph.objects.filter((object): object is FurnitureObject => object.kind === 'furniture');
    assert.equal(furniture.length, 1);
    const table = furniture[0];
    assert.ok(table !== undefined);
    assert.equal(table.furniture.subtype, 'table');
    assert.equal(table.cells, 6);
    assert.deepEqual(table.bounds, { min: [2, 1, 2], max: [5, 2, 4] });
    assertCoverage(graph);
  });

  it('2 格高薄隔墙仍是 wall，不被降级成家具', () => {
    const cells = [
      ...box(1, 0, 1, 11, 0, 11, 'polished_andesite'),
      ...wallShell(1, 11, 1, 11, 1, 4, 'stone_bricks'),
      ...box(1, 5, 1, 11, 5, 11, 'deepslate_tiles'),
      ...box(3, 1, 5, 8, 2, 5, 'stone_bricks'), // 1 格厚、6 长、2 高
    ];
    const graph = extractAsBuiltObjects(gridOf(cells), registry);
    assert.equal(graph.summary.objectCounts.wall, 5);
    assert.equal(graph.summary.objectCounts.furniture, 0);
    assert.equal(
      graph.objects.some((object) => object.kind === 'wall' && object.bounds.min[2] === 5),
      true,
    );
    assertCoverage(graph);
  });
});
