/**
 * CONF-NEXT-02C：H1–H4 good 变体的 as-built 对象图回归。
 *
 * 数字来自 `.work/conf-next-02-first-cut.md` §6；只从 fixture 的 Grid 提取，不改 fixture。
 * H3 wrong 门额外验证墙面板保留门楣（first-cut §6.6）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import type { AsBuiltBounds, AsBuiltObject, OpeningObject } from '@pg/analysis/as-built';
import { loadRegistry } from '@pg/blocks/load';

import { buildFixture, buildGrid } from './conformance-matrix-fixtures.ts';
import type { HouseKey } from './conformance-matrix-fixtures.ts';

const registry = loadRegistry();

type BoundsTuple = readonly [number, number, number, number, number, number];

interface HouseExpectation {
  readonly walls: readonly BoundsTuple[];
  readonly roof: {
    readonly topCells: number;
    readonly eaveY: number;
    readonly ridgeY: number;
    readonly formHint: 'flat' | 'pitched';
    readonly pitchDegrees: number;
    readonly ridgeAxis: 'x' | 'z' | null;
    readonly ridgeWidth: number | null;
    readonly xz: readonly [number, number, number, number];
    readonly footprintCells: number;
  };
  readonly windowWidth: number;
  readonly doorHostBounds: BoundsTuple;
  readonly windowHostBounds: BoundsTuple;
  readonly slabBounds: BoundsTuple;
  readonly slabArea: number;
  readonly siteBounds: BoundsTuple;
  readonly wallExtent: readonly [number, number];
}

const EXPECTED: Readonly<Record<HouseKey, HouseExpectation>> = {
  H1: {
    walls: [
      [1, 1, 1, 7, 5, 2],
      [1, 1, 5, 7, 5, 6],
      [1, 1, 1, 2, 5, 6],
      [6, 1, 1, 7, 5, 6],
    ],
    roof: {
      topCells: 30,
      eaveY: 5,
      ridgeY: 5,
      formHint: 'flat',
      pitchDegrees: 0,
      ridgeAxis: null,
      ridgeWidth: null,
      xz: [1, 1, 7, 6],
      footprintCells: 30,
    },
    windowWidth: 2,
    doorHostBounds: [1, 1, 1, 7, 5, 2],
    windowHostBounds: [6, 1, 1, 7, 5, 6],
    slabBounds: [1, 0, 1, 7, 1, 6],
    slabArea: 30,
    siteBounds: [3, 0, 0, 5, 1, 1],
    wallExtent: [6, 5],
  },
  H2: {
    walls: [
      [1, 1, 1, 11, 5, 2],
      [1, 1, 8, 11, 5, 9],
      [1, 1, 1, 2, 5, 9],
      [10, 1, 1, 11, 5, 9],
    ],
    roof: {
      topCells: 80,
      eaveY: 5,
      ridgeY: 7,
      formHint: 'pitched',
      pitchDegrees: 24.2,
      ridgeAxis: 'z',
      ridgeWidth: 1,
      xz: [1, 1, 11, 9],
      footprintCells: 80,
    },
    windowWidth: 4,
    doorHostBounds: [1, 1, 1, 11, 5, 2],
    windowHostBounds: [1, 1, 8, 11, 5, 9],
    slabBounds: [1, 0, 1, 11, 1, 9],
    slabArea: 80,
    siteBounds: [3, 0, 0, 5, 1, 1],
    wallExtent: [10, 8],
  },
  H3: {
    walls: [
      [1, 1, 1, 9, 5, 2],
      [1, 1, 6, 9, 5, 7],
      [1, 1, 1, 2, 5, 7],
      [8, 1, 1, 9, 5, 7],
    ],
    roof: {
      topCells: 48,
      eaveY: 5,
      ridgeY: 7,
      formHint: 'pitched',
      pitchDegrees: 21.8,
      ridgeAxis: 'x',
      ridgeWidth: 1,
      xz: [1, 1, 9, 7],
      footprintCells: 48,
    },
    windowWidth: 2,
    doorHostBounds: [8, 1, 1, 9, 5, 7],
    windowHostBounds: [1, 1, 6, 9, 5, 7],
    slabBounds: [1, 0, 1, 9, 1, 7],
    slabArea: 48,
    siteBounds: [9, 0, 3, 10, 1, 5],
    wallExtent: [8, 6],
  },
  H4: {
    walls: [
      [1, 1, 1, 9, 5, 2],
      [8, 1, 1, 9, 5, 7],
      [5, 1, 6, 9, 5, 7],
      [1, 1, 1, 2, 5, 11],
      [4, 1, 7, 5, 5, 11],
      [1, 1, 10, 5, 5, 11],
    ],
    roof: {
      topCells: 64,
      eaveY: 5,
      ridgeY: 5,
      formHint: 'flat',
      pitchDegrees: 0,
      ridgeAxis: null,
      ridgeWidth: null,
      xz: [1, 1, 9, 11],
      footprintCells: 64,
    },
    windowWidth: 3,
    doorHostBounds: [4, 1, 7, 5, 5, 11],
    windowHostBounds: [5, 1, 6, 9, 5, 7],
    slabBounds: [1, 0, 1, 9, 1, 11],
    slabArea: 64,
    siteBounds: [5, 0, 8, 6, 1, 10],
    wallExtent: [8, 10],
  },
};

function boundsTuple(bounds: AsBuiltBounds): BoundsTuple {
  return [bounds.min[0], bounds.min[1], bounds.min[2], bounds.max[0], bounds.max[1], bounds.max[2]];
}

function ofKind<T extends AsBuiltObject['kind']>(
  graph: ReturnType<typeof extractAsBuiltObjects>,
  kind: T,
): Extract<AsBuiltObject, { kind: T }>[] {
  return graph.objects.filter((object): object is Extract<AsBuiltObject, { kind: T }> => object.kind === kind);
}

function objectCells(graph: ReturnType<typeof extractAsBuiltObjects>): number {
  return graph.objects.reduce((sum, object) => sum + object.cells, 0);
}

function unknownObjectCells(graph: ReturnType<typeof extractAsBuiltObjects>): number {
  return ofKind(graph, 'unknown').reduce((sum, object) => sum + object.cells, 0);
}

describe('H1–H4 good：as-built 对象图', () => {
  for (const house of ['H1', 'H2', 'H3', 'H4'] as const) {
    it(`${house}：wall / roof / opening / slab / site / unknown 与 first-cut 表一致`, () => {
      const expected = EXPECTED[house];
      const fixture = buildFixture(house, 'good');
      const graph = extractAsBuiltObjects(fixture.grid, registry);

      // coverage 双不变量。
      assert.equal(objectCells(graph), graph.summary.totalCells);
      assert.equal(graph.summary.assignedCells + graph.summary.unknownCells, graph.summary.totalCells);
      assert.equal(graph.summary.unknownCells, unknownObjectCells(graph));
      assert.equal(graph.summary.unknownCells, 0);
      assert.equal(graph.coverage.assignedRatio, 1);

      // 数量。
      assert.equal(ofKind(graph, 'wall').length, expected.walls.length);
      assert.equal(ofKind(graph, 'slab').length, 1);
      assert.equal(ofKind(graph, 'roof').length, 1);
      assert.equal(ofKind(graph, 'opening').length, 2);
      assert.ok(ofKind(graph, 'site').length >= 1);

      // 墙：exact bounds（含共享拐角）与并集范围。
      const wallBounds = ofKind(graph, 'wall')
        .map((wall) => boundsTuple(wall.bounds))
        .sort((a, b) => a.join(',').localeCompare(b.join(',')));
      const expectedWallBounds = [...expected.walls].sort((a, b) => a.join(',').localeCompare(b.join(',')));
      assert.deepEqual(wallBounds, expectedWallBounds);
      const walls = ofKind(graph, 'wall');
      const minX = Math.min(...walls.map((wall) => wall.bounds.min[0]));
      const maxX = Math.max(...walls.map((wall) => wall.bounds.max[0]));
      const minZ = Math.min(...walls.map((wall) => wall.bounds.min[2]));
      const maxZ = Math.max(...walls.map((wall) => wall.bounds.max[2]));
      assert.deepEqual([maxX - minX, maxZ - minZ], expected.wallExtent);

      // 屋面：顶部包络 + pitch/ridge。
      const roofs = ofKind(graph, 'roof');
      const roof = roofs[0];
      assert.ok(roof !== undefined);
      assert.equal(roof.roof.topCells, expected.roof.topCells);
      assert.equal(roof.roof.eaveY, expected.roof.eaveY);
      assert.equal(roof.roof.ridgeY, expected.roof.ridgeY);
      assert.equal(roof.roof.formHint, expected.roof.formHint);
      assert.equal(roof.roof.ridgeAxis, expected.roof.ridgeAxis);
      assert.equal(roof.roof.ridgeWidth, expected.roof.ridgeWidth);
      assert.ok(roof.roof.pitchDegrees !== null);
      assert.ok(Math.abs(roof.roof.pitchDegrees - expected.roof.pitchDegrees) <= 1.0);
      assert.deepEqual(
        [roof.bounds.min[0], roof.bounds.min[2], roof.bounds.max[0], roof.bounds.max[2]],
        expected.roof.xz,
      );
      assert.equal(roof.footprintCells, expected.roof.footprintCells);
      assert.equal(roof.support?.state, 'supported');

      // 洞口：门 passage 2×2；窗玻璃宽度按栋。
      const openings = ofKind(graph, 'opening');
      const door = openings.find((opening) => opening.opening.subtype === 'passage');
      const window = openings.find((opening) => opening.opening.subtype === 'window');
      assert.ok(door !== undefined && window !== undefined);
      assert.equal(door.opening.fill, 'air');
      assert.equal(door.opening.widthCells, 2);
      assert.equal(door.opening.heightCells, 2);
      assert.equal(door.opening.voidCells, 4);
      assert.equal(door.cells, 0);
      assert.equal(window.opening.fill, 'glass');
      assert.equal(window.opening.widthCells, expected.windowWidth);
      assert.equal(window.opening.heightCells, 2);
      assert.equal(window.opening.fillCells, expected.windowWidth * 2);
      assert.equal(window.opening.voidCells, 0);
      assert.ok(window.host !== null && door.host !== null);
      for (const [opening, hostBounds] of [
        [door, expected.doorHostBounds],
        [window, expected.windowHostBounds],
      ] as const) {
        const host = walls.find((wall) => wall.id === opening.host);
        assert.ok(host !== undefined);
        assert.deepEqual(boundsTuple(host.bounds), hostBounds);
        const expectedHost = walls.find((wall) => boundsTuple(wall.bounds).join(',') === hostBounds.join(','));
        assert.ok(expectedHost !== undefined);
        assert.equal(opening.host, expectedHost.id);
      }

      // 洞口 bounds 与 fixture 的 BuildSpec.openings 一致（半开口径）。
      for (const spec of fixture.spec.openings) {
        const opening: OpeningObject = spec.kind === 'door' ? door : window;
        assert.deepEqual(opening.bounds, spec.bounds);
      }

      // 楼板。
      const slab = ofKind(graph, 'slab')[0];
      assert.ok(slab !== undefined);
      assert.deepEqual(boundsTuple(slab.bounds), expected.slabBounds);
      assert.equal(slab.slab.thicknessCells, 1);
      assert.equal(slab.slab.areaCells, expected.slabArea);
      assert.equal(slab.footprintCells, expected.slabArea);
      assert.equal(slab.support?.state, 'grounded');

      // 场地：每栋 1 个门前 pad。
      const sites = ofKind(graph, 'site');
      assert.equal(sites.length, 1);
      const site = sites[0];
      assert.ok(site !== undefined);
      assert.deepEqual(boundsTuple(site.bounds), expected.siteBounds);
      assert.equal(site.site.subtype, 'pad');
      assert.equal(site.site.areaCells, 2);

      // 确定性：同一 Grid 重复提取，JSON 完全一致。
      const repeated = extractAsBuiltObjects(fixture.grid, registry);
      assert.equal(JSON.stringify(graph), JSON.stringify(repeated));

      // 家具第一刀不认领矩阵 fixture 里不存在的家具；避免未来误加。
      assert.equal(ofKind(graph, 'furniture').length, 0);
    });
  }

  it('H3 wrong：门高 3、门楣保留，墙面板高度仍为 4', () => {
    const graph = extractAsBuiltObjects(buildGrid('H3', 'wrong'), registry);
    assert.equal(graph.summary.unknownCells, 0);
    const walls = ofKind(graph, 'wall');
    const openings = ofKind(graph, 'opening');
    assert.equal(walls.length, 4);
    assert.equal(openings.length, 2);
    const door = openings.find((opening) => opening.opening.subtype === 'passage');
    assert.ok(door !== undefined);
    assert.equal(door.opening.widthCells, 2);
    assert.equal(door.opening.heightCells, 3);
    assert.equal(door.opening.fill, 'air');
    assert.equal(door.opening.voidCells, 6);
    assert.deepEqual(boundsTuple(door.bounds), [8, 1, 3, 9, 4, 5]);
    const host = walls.find((wall) => wall.id === door.host);
    assert.ok(host !== undefined);
    assert.equal(host.wall.heightCells, 4);
    assert.deepEqual(boundsTuple(host.bounds), [8, 1, 1, 9, 5, 7]);
    const expectedHost = walls.find((wall) => boundsTuple(wall.bounds).join(',') === '8,1,1,9,5,7');
    assert.ok(expectedHost !== undefined);
    assert.equal(door.host, expectedHost.id);
  });
});
