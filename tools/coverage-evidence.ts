/* eslint-disable max-lines -- 通用覆盖检查按同一份 spec / as-built 事实派生；拆分会让共享阈值与 ID 漂移。 */
/**
 * 通用覆盖证据（Wave 5）：把几何 / 家具 / 材料 / 标高 / 层数这类可测量事项
 * 变成稳定的 check id + pass / fail / unverified 结论，供逐 must 证据聚合。
 *
 * 负责：从 BuildSpec + as-built 对象图派生可测量检查；不负责 diff 报告主表、I/O、模型或构建。
 * 所有检查都是纯函数，容差 0 格；无法可靠测量时返回 unverified，而不是假通过。
 */

import type {
  AsBuiltObjectGraph,
  FurnitureObject,
  OpeningObject,
  RoofObject,
  SiteObject,
  SlabObject,
  WallObject,
} from '@pg/analysis/as-built';
import { diffFurnitureObjects } from '@pg/analysis/object-diff';
import type { DiffItem, ExpectedFurniture } from '@pg/analysis/object-diff';
import type { BlockInfo, BlockRegistry } from '@pg/blocks/registry';
import type { Grid } from '@pg/core/grid';
import type { BuildSpec } from '@pg/interaction/schema';

type Spec = BuildSpec;
type Side = 'north' | 'east' | 'south' | 'west';

const SIDES: readonly Side[] = ['north', 'east', 'south', 'west'];

/** 0.8m / 座是长凳座位的通用换算；与具体房子无关。 */
export const SEAT_PITCH_M = 0.8;

const SERVICE_BLOCK = /(water|cauldron|furnace|smoker|brewing|sink|hopper)/u;

export type CoverageStatus = 'pass' | 'fail' | 'unverified';

export interface CoverageCheckResult {
  readonly id: string;
  readonly status: CoverageStatus;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly actual: Readonly<Record<string, unknown>> | null;
  readonly evidence: readonly string[];
  readonly reason: string | null;
}

export interface CoverageEvidence {
  readonly checks: readonly CoverageCheckResult[];
  readonly furnitureItems: readonly DiffItem[];
}

export interface CoverageProjectionObject {
  readonly id: string;
  readonly kind: 'check';
  readonly label: string;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pass(
  id: string,
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>> | null,
  evidence: readonly string[] = [],
): CoverageCheckResult {
  return { id, status: 'pass', expected, actual, evidence, reason: null };
}

function fail(
  id: string,
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>> | null,
  reason: string,
  evidence: readonly string[] = [],
): CoverageCheckResult {
  return { id, status: 'fail', expected, actual, evidence, reason };
}

function unverified(
  id: string,
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>> | null,
  reason: string,
  evidence: readonly string[] = [],
): CoverageCheckResult {
  return { id, status: 'unverified', expected, actual, evidence, reason };
}

function firstLevel(spec: Spec): Spec['levels'][number] {
  const level = [...spec.levels].sort((a, b) => a.elevation - b.elevation)[0];
  if (level === undefined) throw new Error('BuildSpec.levels is empty');
  return level;
}

function standingY(spec: Spec): number {
  return firstLevel(spec).elevation;
}

function materialBlock(spec: Spec, materialId: string): string | null {
  return spec.materials.find((material) => material.id === materialId)?.block ?? null;
}

function totalCells(materials: readonly { readonly block: string; readonly cells: number }[]): number {
  return materials.reduce((sum, material) => sum + material.cells, 0);
}

function largestSlab(slabs: readonly SlabObject[], standing: number): SlabObject | null {
  const ground = slabs.filter((slab) => slab.slab.topY <= standing);
  const ordered = [...ground].sort((a, b) => b.slab.areaCells - a.slab.areaCells || compareText(a.id, b.id));
  return ordered[0] ?? null;
}

function largestRoof(roofs: readonly RoofObject[]): RoofObject | null {
  const ordered = [...roofs].sort((a, b) => {
    const areaA = (a.bounds.max[0] - a.bounds.min[0]) * (a.bounds.max[2] - a.bounds.min[2]);
    const areaB = (b.bounds.max[0] - b.bounds.min[0]) * (b.bounds.max[2] - b.bounds.min[2]);
    return areaB - areaA || b.cells - a.cells || compareText(a.id, b.id);
  });
  return ordered[0] ?? null;
}

function exteriorWalls(spec: Spec, walls: readonly WallObject[]): readonly WallObject[] {
  const minX = spec.bounds.min[0];
  const maxX = spec.bounds.max[0] - 1;
  const minZ = spec.bounds.min[2];
  const maxZ = spec.bounds.max[2] - 1;
  return walls.filter(
    (wall) =>
      (wall.wall.axis === 'x' && (wall.wall.plane === minZ || wall.wall.plane === maxZ)) ||
      (wall.wall.axis === 'z' && (wall.wall.plane === minX || wall.wall.plane === maxX)),
  );
}

function sideWalls(spec: Spec, walls: readonly WallObject[], side: Side): readonly WallObject[] {
  const minX = spec.bounds.min[0];
  const maxX = spec.bounds.max[0] - 1;
  const minZ = spec.bounds.min[2];
  const maxZ = spec.bounds.max[2] - 1;
  return walls.filter((wall) => {
    if (side === 'north') return wall.wall.axis === 'x' && wall.wall.plane === minZ;
    if (side === 'south') return wall.wall.axis === 'x' && wall.wall.plane === maxZ;
    if (side === 'west') return wall.wall.axis === 'z' && wall.wall.plane === minX;
    return wall.wall.axis === 'z' && wall.wall.plane === maxX;
  });
}

function expectedThickness(spec: Spec, side: Side): number | null {
  const minX = spec.bounds.min[0];
  const maxX = spec.bounds.max[0];
  const minZ = spec.bounds.min[2];
  const maxZ = spec.bounds.max[2];
  const candidates = spec.elements.filter((element) => {
    if (element.kind !== 'wall') return false;
    const dx = element.bounds.max[0] - element.bounds.min[0];
    const dz = element.bounds.max[2] - element.bounds.min[2];
    // 只取法向为本侧的墙段：北 / 南墙沿 x 延伸，东 / 西墙沿 z 延伸。
    if (side === 'north') return element.bounds.min[2] === minZ && dx > dz;
    if (side === 'south') return element.bounds.max[2] === maxZ && dx > dz;
    if (side === 'west') return element.bounds.min[0] === minX && dz > dx;
    return element.bounds.max[0] === maxX && dz > dx;
  });
  if (candidates.length === 0) return null;
  const values = candidates.map((element) =>
    side === 'north' || side === 'south'
      ? element.bounds.max[2] - element.bounds.min[2]
      : element.bounds.max[0] - element.bounds.min[0],
  );
  return Math.max(...values);
}

function actualThickness(walls: readonly WallObject[], side: Side): number | null {
  if (walls.length === 0) return null;
  const values = walls.map((wall) =>
    side === 'north' || side === 'south'
      ? wall.bounds.max[2] - wall.bounds.min[2]
      : wall.bounds.max[0] - wall.bounds.min[0],
  );
  return Math.max(...values);
}

function expectedInterior(spec: Spec): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly thickness: Readonly<Record<Side, number | null>>;
} | null {
  const thickness: Record<Side, number | null> = {
    north: expectedThickness(spec, 'north'),
    east: expectedThickness(spec, 'east'),
    south: expectedThickness(spec, 'south'),
    west: expectedThickness(spec, 'west'),
  };
  if (SIDES.some((side) => thickness[side] === null)) return null;
  return {
    min: [
      spec.bounds.min[0] + (thickness.west ?? 0),
      firstLevel(spec).elevation,
      spec.bounds.min[2] + (thickness.north ?? 0),
    ],
    max: [spec.bounds.max[0] - (thickness.east ?? 0), spec.bounds.max[1], spec.bounds.max[2] - (thickness.south ?? 0)],
    thickness,
  };
}

function actualInterior(
  spec: Spec,
  walls: readonly WallObject[],
): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly thickness: Readonly<Record<Side, number | null>>;
} | null {
  const west = sideWalls(spec, walls, 'west');
  const east = sideWalls(spec, walls, 'east');
  const north = sideWalls(spec, walls, 'north');
  const south = sideWalls(spec, walls, 'south');
  if (west.length === 0 || east.length === 0 || north.length === 0 || south.length === 0) return null;
  const minX = Math.max(...west.map((wall) => wall.bounds.max[0]));
  const maxX = Math.min(...east.map((wall) => wall.bounds.min[0]));
  const minZ = Math.max(...north.map((wall) => wall.bounds.max[2]));
  const maxZ = Math.min(...south.map((wall) => wall.bounds.min[2]));
  const thickness = {
    north: actualThickness(north, 'north'),
    east: actualThickness(east, 'east'),
    south: actualThickness(south, 'south'),
    west: actualThickness(west, 'west'),
  };
  return {
    min: [minX, firstLevel(spec).elevation, minZ],
    max: [maxX, spec.bounds.max[1], maxZ],
    thickness,
  };
}

function interiorWallIds(spec: Spec, walls: readonly WallObject[]): readonly string[] {
  const exterior = new Set(exteriorWalls(spec, walls).map((wall) => wall.id));
  const allowed = allowedInteriorRects(spec);
  return walls
    .filter((wall) => {
      if (exterior.has(wall.id)) return false;
      const area = (wall.bounds.max[0] - wall.bounds.min[0]) * (wall.bounds.max[2] - wall.bounds.min[2]);
      if (area <= 0) return true;
      const inside = allowed.reduce((sum, rect) => {
        const x0 = Math.max(wall.bounds.min[0], rect.minX);
        const x1 = Math.min(wall.bounds.max[0], rect.maxX);
        const z0 = Math.max(wall.bounds.min[2], rect.minZ);
        const z1 = Math.min(wall.bounds.max[2], rect.maxZ);
        return sum + Math.max(0, x1 - x0) * Math.max(0, z1 - z0);
      }, 0);
      // 贴墙 3m 柜子被误判成墙时，其包络大部分落在设计家具矩形内；不能算隔断。
      return inside / area < 0.5;
    })
    .map((wall) => wall.id)
    .sort(compareText);
}

function sideOfOpening(spec: Spec, opening: OpeningObject): Side | null {
  // 洞口可能只有 1 格宽，宽 / 深都为 1；先按所在外墙面判定，再由薄轴兜底。
  if (opening.bounds.max[2] === spec.bounds.max[2]) return 'south';
  if (opening.bounds.min[2] === spec.bounds.min[2]) return 'north';
  if (opening.bounds.max[0] === spec.bounds.max[0]) return 'east';
  if (opening.bounds.min[0] === spec.bounds.min[0]) return 'west';
  const thinX = opening.bounds.max[0] - opening.bounds.min[0] === 1;
  const thinZ = opening.bounds.max[2] - opening.bounds.min[2] === 1;
  if (thinZ && !thinX) {
    if (opening.bounds.min[2] === spec.bounds.min[2]) return 'north';
    if (opening.bounds.max[2] === spec.bounds.max[2]) return 'south';
  }
  if (thinX && !thinZ) {
    if (opening.bounds.min[0] === spec.bounds.min[0]) return 'west';
    if (opening.bounds.max[0] === spec.bounds.max[0]) return 'east';
  }
  return null;
}

function furnitureObjectOf(
  furniture: readonly FurnitureObject[],
  bounds: { readonly min: readonly number[]; readonly max: readonly number[] },
): readonly FurnitureObject[] {
  return furniture.filter(
    (object) =>
      object.bounds.min[0] === bounds.min[0] &&
      object.bounds.min[1] === bounds.min[1] &&
      object.bounds.min[2] === bounds.min[2] &&
      object.bounds.max[0] === bounds.max[0] &&
      object.bounds.max[1] === bounds.max[1] &&
      object.bounds.max[2] === bounds.max[2],
  );
}

function seatCapacityOf(span: number): number {
  return Math.max(0, Math.floor((span * 10) / 8));
}

function expectedFurniture(spec: Spec): readonly ExpectedFurniture[] {
  const out: ExpectedFurniture[] = [];
  for (const interior of spec.interiors) {
    for (const item of interior.furnitureSpecs) {
      const block = materialBlock(spec, item.materialId);
      const span = Math.max(item.bounds.max[0] - item.bounds.min[0], item.bounds.max[2] - item.bounds.min[2]);
      out.push({
        id: `furniture:${item.id}`,
        kind: 'furniture',
        bounds: {
          min: [item.bounds.min[0], item.bounds.min[1], item.bounds.min[2]],
          max: [item.bounds.max[0], item.bounds.max[1], item.bounds.max[2]],
        },
        materialBlock: block,
        furnitureKind: item.kind,
        seatCapacity: item.kind === 'bench' ? seatCapacityOf(span) : null,
        unverifiedReason: block === null ? `furniture material ${item.materialId} is not declared` : null,
      });
    }
  }
  return out.sort((a, b) => compareText(a.id, b.id));
}

function sideSchedule(spec: Spec, openings: readonly OpeningObject[], side: Side): readonly string[] {
  const actual = openings
    .filter((opening) => sideOfOpening(spec, opening) === side)
    .map((opening) =>
      opening.opening.subtype === 'window' ? 'window' : opening.opening.subtype === 'unknown' ? 'unknown' : 'door',
    )
    .sort(compareText);
  return actual;
}

function expectedSchedule(spec: Spec, side: Side): readonly string[] {
  return spec.openings
    .filter((opening) => opening.side === side)
    .map((opening) => (opening.kind === 'window' ? 'window' : 'door'))
    .sort(compareText);
}

function siteTop(site: SiteObject): number {
  return site.site.topY + 1;
}

function outsideFootprint(
  spec: Spec,
  object: { readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] } },
): boolean {
  const minX = object.bounds.min[0] ?? 0;
  const minZ = object.bounds.min[2] ?? 0;
  const maxX = object.bounds.max[0] ?? 0;
  const maxZ = object.bounds.max[2] ?? 0;
  return (
    minX < spec.bounds.min[0] || minZ < spec.bounds.min[2] || maxX > spec.bounds.max[0] || maxZ > spec.bounds.max[2]
  );
}

function entranceOpening(spec: Spec): Spec['openings'][number] | undefined {
  const candidates = spec.openings.filter((opening) => opening.kind !== 'window');
  return (
    candidates.find((opening) => opening.side === spec.entranceSide) ??
    candidates.find((opening) => opening.side === 'north') ??
    candidates[0]
  );
}

function checkStorey(spec: Spec, graph: AsBuiltObjectGraph): CoverageCheckResult {
  const level = firstLevel(spec);
  const standing = level.elevation;
  const expected = {
    levels: 1,
    levelId: level.id,
    standingY: standing,
    height: spec.roof.eaveHeight - standing,
  };
  if (spec.levels.length !== 1) {
    return unverified(
      'check:storey:' + level.id,
      expected,
      { levels: spec.levels.length },
      'multi-level storey check is not supported',
    );
  }
  const elevated = graph.objects.filter(
    (object): object is SlabObject => object.kind === 'slab' && object.slab.topY > standing,
  );
  const roof = largestRoof(graph.objects.filter((object): object is RoofObject => object.kind === 'roof'));
  const walls = graph.objects.filter((object): object is WallObject => object.kind === 'wall');
  const wallTop = walls.length === 0 ? null : Math.max(...walls.map((wall) => wall.bounds.max[1]));
  const actual = {
    levels: 1,
    elevatedSlabs: elevated.length,
    elevatedIds: elevated.map((slab) => slab.id).sort(compareText),
    wallTop,
    eaveY: roof?.roof.eaveY ?? null,
    height: wallTop === null ? null : wallTop - standing,
  };
  if (elevated.length > 0) {
    return fail(
      'check:storey:' + level.id,
      expected,
      actual,
      'elevated floor / mezzanine object exists',
      actual.elevatedIds,
    );
  }
  if (wallTop === null || roof === null) {
    return unverified('check:storey:' + level.id, expected, actual, 'wall top or roof eave cannot be measured');
  }
  if (wallTop !== spec.roof.eaveHeight || roof.roof.eaveY !== spec.roof.eaveHeight) {
    return fail('check:storey:' + level.id, expected, actual, 'storey height / eave does not match the design');
  }
  return pass('check:storey:' + level.id, expected, actual, [
    `standing y${String(standing)}`,
    `eave y${String(spec.roof.eaveHeight)}`,
  ]);
}

function checkClear(spec: Spec, graph: AsBuiltObjectGraph): CoverageCheckResult {
  const level = firstLevel(spec);
  const id = 'check:clear:' + level.id;
  const expected = expectedInterior(spec);
  if (expected === null) {
    return unverified(id, { thickness: null }, null, 'wall thickness projection is unavailable');
  }
  const actual = actualInterior(
    spec,
    graph.objects.filter((object): object is WallObject => object.kind === 'wall'),
  );
  if (actual === null) {
    return unverified(id, expected, null, 'envelope walls are incomplete; clear dimensions cannot be measured');
  }
  const expectedDims = {
    width: expected.max[0] - expected.min[0],
    depth: expected.max[2] - expected.min[2],
    area: (expected.max[0] - expected.min[0]) * (expected.max[2] - expected.min[2]),
  };
  const actualDims = {
    width: actual.max[0] - actual.min[0],
    depth: actual.max[2] - actual.min[2],
    area: (actual.max[0] - actual.min[0]) * (actual.max[2] - actual.min[2]),
  };
  const partitions = interiorWallIds(
    spec,
    graph.objects.filter((object): object is WallObject => object.kind === 'wall'),
  );
  const same =
    expected.min[0] === actual.min[0] &&
    expected.max[0] === actual.max[0] &&
    expected.min[2] === actual.min[2] &&
    expected.max[2] === actual.max[2];
  if (!same || partitions.length > 0) {
    return fail(
      id,
      { bounds: [expected.min, expected.max], dims: expectedDims },
      { bounds: [actual.min, actual.max], dims: actualDims, partitions },
      partitions.length > 0 ? 'interior wall partitions reduce the clear room' : 'interior clear dimensions differ',
      partitions,
    );
  }
  return pass(
    id,
    { bounds: [expected.min, expected.max], dims: expectedDims },
    { bounds: [actual.min, actual.max], dims: actualDims },
  );
}

function checkThickness(spec: Spec, graph: AsBuiltObjectGraph): CoverageCheckResult {
  const level = firstLevel(spec);
  const id = 'check:thickness:' + level.id;
  const expected = expectedInterior(spec);
  if (expected === null) return unverified(id, {}, null, 'wall thickness projection is unavailable');
  const walls = graph.objects.filter((object): object is WallObject => object.kind === 'wall');
  const actual = actualInterior(spec, walls);
  if (actual === null) return unverified(id, expected.thickness, null, 'envelope walls are incomplete');
  const delta: Record<string, unknown> = {};
  for (const side of SIDES) {
    if (expected.thickness[side] !== actual.thickness[side])
      delta[side] = { expected: expected.thickness[side], actual: actual.thickness[side] };
  }
  const actualRecord: Record<string, number | null> = { ...actual.thickness };
  return Object.keys(delta).length === 0
    ? pass(id, expected.thickness, actualRecord)
    : fail(id, expected.thickness, { ...actualRecord, delta }, 'wall thickness differs from the design');
}

function checkMaterial(
  id: string,
  spec: Spec,
  graph: AsBuiltObjectGraph,
  kind: 'wall' | 'structure' | 'roof' | 'base',
): CoverageCheckResult {
  if (kind === 'structure') {
    const walls = exteriorWalls(
      spec,
      graph.objects.filter((object): object is WallObject => object.kind === 'wall'),
    );
    if (walls.length === 0) return unverified(id, { blocks: [] }, null, 'no exterior wall object');
    const structural = spec.elements.filter((element) => element.kind === 'wall' || element.kind === 'column');
    const expectedBlocks = [
      ...new Set(
        structural
          .map((element) => materialBlock(spec, element.material))
          .filter((block): block is string => block !== null),
      ),
    ].sort(compareText);
    const columns = structural.filter((element) => element.kind === 'column');
    if (columns.length > 0) {
      // as-built 目前没有独立 column 对象；声明了柱子就不能声称“木柱”已验证。
      return unverified(
        id,
        { blocks: expectedBlocks, columns: columns.length },
        { unknownCells: graph.summary.unknownCells },
        'column geometry is not represented; cannot verify all wood structure',
      );
    }
    const materials = walls.flatMap((wall) => wall.materials);
    const total = totalCells(materials);
    if (total === 0) return unverified(id, { blocks: expectedBlocks }, { blocks: [] }, 'structure materials are empty');
    const expectedCells = materials
      .filter((material) => expectedBlocks.includes(material.block))
      .reduce((sum, material) => sum + material.cells, 0);
    if (expectedBlocks.length === 0) return unverified(id, { blocks: [] }, null, 'no structural material declared');
    return expectedCells / total >= 0.9
      ? pass(id, { blocks: expectedBlocks }, { blocks: materials })
      : fail(id, { blocks: expectedBlocks }, { blocks: materials }, 'structural material does not match the design');
  }
  if (kind === 'wall') {
    const walls = exteriorWalls(
      spec,
      graph.objects.filter((object): object is WallObject => object.kind === 'wall'),
    );
    if (walls.length === 0) return unverified(id, { blocks: [] }, null, 'no exterior wall object');
    const materials = walls.flatMap((wall) => wall.materials);
    const expectedBlocks = [
      ...new Set(
        spec.elements
          .filter((element) => element.kind === 'wall')
          .map((element) => materialBlock(spec, element.material))
          .filter((block): block is string => block !== null),
      ),
    ].sort(compareText);
    const counts = new Map<string, number>();
    for (const material of materials) counts.set(material.block, (counts.get(material.block) ?? 0) + material.cells);
    const actualBlocks = [...counts.entries()]
      .sort(([a], [b]) => compareText(a, b))
      .map(([block, cells]) => ({ block, cells }));
    const total = totalCells(actualBlocks);
    if (total === 0) return unverified(id, { blocks: expectedBlocks }, { blocks: [] }, 'wall materials are empty');
    const expectedCells = actualBlocks
      .filter((entry) => expectedBlocks.includes(entry.block))
      .reduce((sum, entry) => sum + entry.cells, 0);
    if (expectedBlocks.length === 0)
      return unverified(id, { blocks: [] }, { blocks: actualBlocks }, 'design does not declare wall material');
    if (expectedCells / total < 0.9) {
      return fail(
        id,
        { blocks: expectedBlocks },
        { blocks: actualBlocks },
        'exterior wall material does not match the design',
      );
    }
    return pass(id, { blocks: expectedBlocks }, { blocks: actualBlocks });
  }
  if (kind === 'roof') {
    const roof = largestRoof(graph.objects.filter((object): object is RoofObject => object.kind === 'roof'));
    if (roof === null) return unverified(id, {}, null, 'no roof object');
    const expectedBlock = materialBlock(spec, spec.roof.material);
    if (expectedBlock === null) return unverified(id, {}, { blocks: roof.materials }, 'roof material is not declared');
    const total = totalCells(roof.materials);
    if (total === 0) return unverified(id, { block: expectedBlock }, { blocks: [] }, 'roof materials are empty');
    const expectedCells = roof.materials
      .filter((material) => material.block === expectedBlock)
      .reduce((sum, material) => sum + material.cells, 0);
    if (expectedCells / total < 0.8) {
      return fail(id, { block: expectedBlock }, { blocks: roof.materials }, 'roof material does not match the design');
    }
    return pass(id, { block: expectedBlock }, { blocks: roof.materials });
  }
  const standing = standingY(spec);
  const slab = largestSlab(
    graph.objects.filter((object): object is SlabObject => object.kind === 'slab'),
    standing,
  );
  if (slab === null) return unverified(id, {}, null, 'no ground slab / base object');
  const expectedBlock = materialBlock(spec, spec.materials.find((material) => material.role === 'floor')?.id ?? '');
  if (expectedBlock === null) return unverified(id, {}, { blocks: slab.materials }, 'base material is not declared');
  const total = totalCells(slab.materials);
  if (total === 0) return unverified(id, { block: expectedBlock }, { blocks: [] }, 'base materials are empty');
  const expectedCells = slab.materials
    .filter((material) => material.block === expectedBlock)
    .reduce((sum, material) => sum + material.cells, 0);
  if (expectedCells / total < 0.5) {
    return fail(id, { block: expectedBlock }, { blocks: slab.materials }, 'base slab material differs from the design');
  }
  return pass(id, { block: expectedBlock }, { blocks: slab.materials });
}

interface AllowedRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function allowedInteriorRects(spec: Spec): readonly AllowedRect[] {
  const rects: AllowedRect[] = [];
  for (const interior of spec.interiors) {
    for (const item of interior.furnitureSpecs) {
      rects.push({
        minX: item.bounds.min[0],
        maxX: item.bounds.max[0],
        minZ: item.bounds.min[2],
        maxZ: item.bounds.max[2],
      });
    }
  }
  for (const element of spec.elements) {
    if (element.kind === 'column' || element.kind === 'furniture') {
      rects.push({
        minX: element.bounds.min[0],
        maxX: element.bounds.max[0],
        minZ: element.bounds.min[2],
        maxZ: element.bounds.max[2],
      });
    }
  }
  return rects;
}

interface DesignedCellRule {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly blocks: ReadonlySet<string>;
  readonly built: boolean;
  readonly wallShaped: boolean;
}

function designedCellRules(spec: Spec, grid: Grid): readonly DesignedCellRule[] {
  const present = new Map<string, string>();
  for (const cell of grid.cells()) {
    present.set(`${String(cell.x)},${String(cell.y)},${String(cell.z)}`, cell.state.name);
  }
  const furnitureBlocks = new Set(
    spec.materials.filter((material) => material.role === 'furniture').map((material) => material.block),
  );
  const rules: DesignedCellRule[] = [];
  const push = (
    bounds: { readonly min: readonly number[]; readonly max: readonly number[] },
    materialId: string,
    wallShaped: boolean,
  ): void => {
    const block = materialBlock(spec, materialId);
    if (block === null) return;
    const min: [number, number, number] = [bounds.min[0] ?? 0, bounds.min[1] ?? 0, bounds.min[2] ?? 0];
    const max: [number, number, number] = [bounds.max[0] ?? 0, bounds.max[1] ?? 0, bounds.max[2] ?? 0];
    const blocks = new Set([block, ...furnitureBlocks]);
    let built = true;
    for (let x = min[0]; x < max[0] && built; x += 1) {
      for (let y = min[1]; y < max[1] && built; y += 1) {
        for (let z = min[2]; z < max[2] && built; z += 1) {
          const state = present.get(`${String(x)},${String(y)},${String(z)}`);
          if (state === undefined || !blocks.has(state)) built = false;
        }
      }
    }
    rules.push({ min, max, blocks, built, wallShaped });
  };
  for (const interior of spec.interiors) {
    for (const item of interior.furnitureSpecs) {
      const width = item.bounds.max[0] - item.bounds.min[0];
      const depth = item.bounds.max[2] - item.bounds.min[2];
      const height = item.bounds.max[1] - item.bounds.min[1];
      push(item.bounds, item.materialId, height >= 3 && Math.min(width, depth) <= 1 && Math.max(width, depth) >= 3);
    }
  }
  for (const element of spec.elements) {
    if (element.kind === 'column' || element.kind === 'furniture') push(element.bounds, element.material, false);
  }
  return rules;
}

function isDesignedCell(rules: readonly DesignedCellRule[], x: number, y: number, z: number, block: string): boolean {
  return rules.some(
    (rule) =>
      x >= rule.min[0] &&
      x < rule.max[0] &&
      y >= rule.min[1] &&
      y < rule.max[1] &&
      z >= rule.min[2] &&
      z < rule.max[2] &&
      rule.built &&
      rule.blocks.has(block),
  );
}

function isBarrierShape(info: BlockInfo): boolean {
  if (info.shape === 'light' || info.shape === 'plant' || info.shape === 'fluid') return false;
  if (info.shape === 'carpet' || info.shape === 'button' || info.shape === 'pressure_plate') return false;
  if (info.shape === 'sheet' || info.shape === 'trapdoor') return false;
  return true;
}

/**
 * fail-closed 隔断证明：只有“除去设计家具实际占用的格子后，大厅内没有任何其它非空气格”
 * 才判 pass。任何未归属的实体 / 玻璃 / fence / chest / other，或 unknown 几何，都永不 met：
 * 成组（>=2 格，含对角 / 台阶 / 断口）的实体判 fail；单格或无法分类判 unverified。
 */
function checkPartitionCells(spec: Spec, grid: Grid, registry: BlockRegistry): CoverageCheckResult | null {
  const id = 'check:absence:partition';
  const interior = expectedInterior(spec);
  if (interior === null) return null;
  const standing = standingY(spec);
  const eave = spec.roof.eaveHeight;
  const rules = designedCellRules(spec, grid);
  const candidates = [...grid.cells()].filter((cell) => {
    if (cell.x < interior.min[0] || cell.x >= interior.max[0]) return false;
    if (cell.z < interior.min[2] || cell.z >= interior.max[2]) return false;
    if (cell.y < standing || cell.y >= eave) return false;
    const block = cell.state.name;
    if (isDesignedCell(rules, cell.x, cell.y, cell.z, block)) return false;
    return true;
  });

  if (rules.some((rule) => rule.built && rule.wallShaped)) {
    return unverified(
      id,
      { partitions: 0 },
      { wallShapedFurniture: rules.filter((rule) => rule.built && rule.wallShaped).length },
      'wall-shaped designed furniture cannot prove absence of a partition',
    );
  }
  if (candidates.length === 0) return pass(id, { partitions: 0 }, { partitions: 0 });
  // 设计家具用非声明材料建造时，其体块会进入 candidates；只要这些格子的 XZ 全落在
  // 设计家具足迹内，就不能把“材料替换的桌凳 / 吊灯”误判成隔断。
  const allowedRects = allowedInteriorRects(spec);
  const furnitureSubstitute = (name: string): boolean =>
    name.endsWith('_slab') || name === 'chain' || name === 'lantern' || name.includes('carpet');
  const outsideFurniture = candidates.filter((cell) => {
    if (!isBarrierShape(registry.info(cell.state))) return false;
    // 玻璃 / fence / chest / 石墙等真屏障即使落在家具 bbox 内也不能当作“家具材料替换”。
    if (!furnitureSubstitute(cell.state.name)) return true;
    return !allowedRects.some(
      (rect) => cell.x >= rect.minX && cell.x < rect.maxX && cell.z >= rect.minZ && cell.z < rect.maxZ,
    );
  });
  if (outsideFurniture.length === 0) {
    return unverified(
      id,
      { partitions: 0 },
      { furnitureFootprintCells: candidates.length },
      'all unrecognized barrier cells lie inside designed furniture footprints; cannot prove no partition',
    );
  }

  const byKey = new Map<string, (typeof candidates)[number]>();
  for (const cell of candidates) byKey.set(`${String(cell.x)},${String(cell.y)},${String(cell.z)}`, cell);
  const visited = new Set<string>();
  const barriers: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
    cells: number;
    blocks: readonly string[];
  }[] = [];
  for (const seed of candidates) {
    const seedKey = `${String(seed.x)},${String(seed.y)},${String(seed.z)}`;
    if (visited.has(seedKey)) continue;
    visited.add(seedKey);
    const queue = [seed];
    const component: typeof candidates = [];
    for (const current of queue) {
      component.push(current);
      // 26 邻域：对角相接、台阶、断口两侧的体量都归入同一可疑组。
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dz = -1; dz <= 1; dz += 1) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const key = `${String(current.x + dx)},${String(current.y + dy)},${String(current.z + dz)}`;
            if (visited.has(key)) continue;
            const neighbor = byKey.get(key);
            if (neighbor === undefined) continue;
            visited.add(key);
            queue.push(neighbor);
          }
        }
      }
    }
    const barrierCells = component.filter((cell) => isBarrierShape(registry.info(cell.state)));
    if (component.length >= 2 && barrierCells.length > 0) {
      const extent = component.reduce(
        (acc, cell) => ({
          minX: Math.min(acc.minX, cell.x),
          maxX: Math.max(acc.maxX, cell.x),
          minY: Math.min(acc.minY, cell.y),
          maxY: Math.max(acc.maxY, cell.y),
          minZ: Math.min(acc.minZ, cell.z),
          maxZ: Math.max(acc.maxZ, cell.z),
        }),
        { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity },
      );
      barriers.push({
        ...extent,
        cells: component.length,
        blocks: [...new Set(component.map((cell) => cell.state.name))].sort(compareText),
      });
    }
  }
  if (barriers.length > 0) {
    return fail(
      id,
      { partitions: 0 },
      { partitions: barriers },
      'undesigned interior partition / knee wall / glass / fence / chest barrier exists',
    );
  }
  return unverified(
    id,
    { partitions: 0 },
    {
      cells: candidates.map((cell) => `${String(cell.x)},${String(cell.y)},${String(cell.z)}=${cell.state.name}`),
    },
    'unrecognized interior solid / glass / fence / chest / unknown; cannot prove no partition',
  );
}

function checkAbsence(
  id: string,
  spec: Spec,
  graph: AsBuiltObjectGraph,
  rule:
    | 'mezzanine'
    | 'partition'
    | 'glass-door'
    | 'counter-service'
    | 'eave-platform'
    | 'base-platform'
    | 'stairs-basement',
  grid?: Grid,
  registry?: BlockRegistry,
): CoverageCheckResult {
  const standing = standingY(spec);
  if (rule === 'stairs-basement') {
    const stairs = spec.elements.filter((element) => element.kind === 'stair');
    const basement = spec.levels.some((level) => level.elevation < 0);
    // 屋面常用 *_stairs 方块做坡度，不能把它们误判成室内楼梯：
    // 只统计檐口以下的楼梯方块；没有 grid 时退回对象图（排除 roof 对象）。
    const stairBlocks =
      grid === undefined
        ? graph.objects
            .filter((object) => object.kind !== 'roof')
            .flatMap((object) =>
              object.materials.filter((material) => /stairs?/u.test(material.block)).map((material) => material.block),
            )
        : [...grid.cells()]
            .filter((cell) => cell.y < spec.roof.eaveHeight && /stairs?/u.test(cell.state.name))
            .map((cell) => cell.state.name);
    if (stairs.length > 0 || basement || stairBlocks.length > 0) {
      return fail(
        id,
        { stairs: 0, basement: 0 },
        { stairs: stairs.map((element) => element.id), stairBlocks, basement },
        'stair or basement level exists',
      );
    }
    if (graph.summary.unknownCells > 0) {
      return unverified(
        id,
        { stairs: 0, basement: 0 },
        { unknownCells: graph.summary.unknownCells },
        'unknown geometry may hide a stair',
      );
    }
    return pass(id, { stairs: 0, basement: 0 }, { stairs: 0, basement: 0 });
  }
  if (rule === 'mezzanine') {
    const elevated = graph.objects.filter(
      (object): object is SlabObject => object.kind === 'slab' && object.slab.topY > standing,
    );
    return elevated.length === 0
      ? pass(id, { mezzanine: 0 }, { mezzanine: 0 })
      : fail(
          id,
          { mezzanine: 0 },
          { ids: elevated.map((slab) => slab.id).sort(compareText) },
          'elevated floor / mezzanine object exists',
        );
  }
  if (rule === 'partition') {
    const gridCheck = grid === undefined || registry === undefined ? null : checkPartitionCells(spec, grid, registry);
    if (gridCheck !== null) return gridCheck;
    const walls = graph.objects.filter((object): object is WallObject => object.kind === 'wall');
    const partitions = interiorWallIds(spec, walls);
    return partitions.length === 0
      ? pass(id, { partitions: 0 }, { partitions: 0 })
      : fail(id, { partitions: 0 }, { partitions }, 'interior partition wall exists');
  }
  if (rule === 'glass-door') {
    const openings = graph.objects.filter((object): object is OpeningObject => object.kind === 'opening');
    if (openings.length === 0) return unverified(id, { nonNorthDoors: 0, floorGlass: 0 }, null, 'no opening measured');
    const bad = openings.filter((opening) => {
      const side = sideOfOpening(spec, opening);
      if (side === null) return false;
      if (opening.opening.subtype === 'window') return opening.opening.sillY <= standing;
      // 允许北侧入口门；东 / 南 / 西出现门或通道即违反“只通过北门”。
      return side !== 'north';
    });
    return bad.length === 0
      ? pass(id, { nonNorthDoors: 0, floorGlass: 0 }, { openings: openings.length })
      : fail(
          id,
          { nonNorthDoors: 0, floorGlass: 0 },
          { ids: bad.map((opening) => opening.id).sort(compareText) },
          'a non-north door or floor-level glazing exists',
        );
  }
  if (rule === 'counter-service') {
    const counters = spec.interiors.flatMap((interior) =>
      interior.furnitureSpecs.filter((item) => item.kind === 'counter'),
    );
    if (counters.length === 0) return unverified(id, { counters: 0 }, null, 'design has no counter');
    const furniture = graph.objects.filter((object): object is FurnitureObject => object.kind === 'furniture');
    const missing: string[] = [];
    const service: string[] = [];
    for (const counter of counters) {
      const actual = furnitureObjectOf(furniture, counter.bounds);
      if (actual.length === 0) {
        missing.push(counter.id);
        continue;
      }
      for (const object of actual) {
        for (const material of object.materials) {
          if (SERVICE_BLOCK.test(material.block)) service.push(`${object.id}:${material.block}`);
        }
      }
    }
    if (missing.length > 0) {
      return fail(id, { counters: counters.length, service: 0 }, { missing, service }, 'counter furniture is missing');
    }
    return service.length === 0
      ? pass(id, { counters: counters.length, service: 0 }, { counters: counters.length, service: 0 })
      : fail(id, { counters: counters.length, service: 0 }, { service }, 'counter contains a service block');
  }
  if (rule === 'eave-platform') {
    const door = entranceOpening(spec);
    const allowed = door === undefined ? 0 : door.width;
    const pads = graph.objects.filter(
      (object): object is SiteObject =>
        object.kind === 'site' &&
        object.site.subtype !== 'ground' &&
        outsideFootprint(spec, object) &&
        siteTop(object) >= standing,
    );
    const excess = pads.filter((site) => siteTop(site) > standing || site.site.areaCells > allowed);
    return excess.length === 0
      ? pass(
          id,
          { raisedOutdoorArea: 0, allowed },
          { pads: pads.map((site) => ({ id: site.id, area: site.site.areaCells })) },
        )
      : fail(
          id,
          { raisedOutdoorArea: 0, allowed },
          { ids: excess.map((site) => site.id).sort(compareText) },
          'raised outdoor pad / eave platform exists',
        );
  }
  const door = entranceOpening(spec);
  const entryApron = (site: SiteObject): boolean => {
    if (door === undefined || siteTop(site) !== standing || site.site.areaCells > door.width) return false;
    const adjacent =
      door.side === 'north'
        ? site.bounds.max[2] === door.bounds.min[2]
        : door.side === 'south'
          ? site.bounds.min[2] === door.bounds.max[2]
          : door.side === 'west'
            ? site.bounds.max[0] === door.bounds.min[0]
            : site.bounds.min[0] === door.bounds.max[0];
    return adjacent;
  };
  const slabs = graph.objects.filter(
    (object): object is SlabObject =>
      object.kind === 'slab' && object.slab.topY >= standing - 1 && outsideFootprint(spec, object),
  );
  // 与室内同高的入口小 pad 是齐平过渡，不是抬高的石基座平台；这里看实体格顶。
  const pads = graph.objects.filter(
    (object): object is SiteObject =>
      object.kind === 'site' &&
      object.site.subtype !== 'ground' &&
      outsideFootprint(spec, object) &&
      object.site.topY >= standing - 1 &&
      !entryApron(object),
  );
  return slabs.length === 0 && pads.length === 0
    ? pass(id, { raisedBase: 0 }, { raisedBase: 0 })
    : fail(
        id,
        { raisedBase: 0 },
        { slabs: slabs.map((slab) => slab.id), pads: pads.map((site) => site.id) },
        'base extends outside the building as a platform',
      );
}

function checkBudget(spec: Spec, graph: AsBuiltObjectGraph): CoverageCheckResult {
  const id = `check:budget:${String(spec.budget.maxBlocks)}`;
  const expected = { maxBlocks: spec.budget.maxBlocks };
  const actual = { blocks: graph.summary.totalCells };
  return graph.summary.totalCells <= spec.budget.maxBlocks
    ? pass(id, expected, actual)
    : fail(id, expected, actual, 'total block count exceeds the design budget');
}

function checkSeats(spec: Spec, graph: AsBuiltObjectGraph, expectedSeats: number): CoverageCheckResult {
  const id = `check:seats:${String(expectedSeats)}`;
  const benches = spec.interiors.flatMap((interior) => interior.furnitureSpecs.filter((item) => item.kind === 'bench'));
  if (benches.length === 0) return unverified(id, { seats: expectedSeats }, null, 'design has no bench');
  const furniture = graph.objects.filter((object): object is FurnitureObject => object.kind === 'furniture');
  let actual = 0;
  const missing: string[] = [];
  const perBench: Record<string, number> = {};
  for (const bench of benches) {
    const matches = furnitureObjectOf(furniture, bench.bounds);
    if (matches.length === 0) {
      missing.push(bench.id);
      continue;
    }
    const capacity = Math.max(0, ...matches.map((object) => object.furniture.seatCapacity ?? 0));
    perBench[bench.id] = capacity;
    actual += capacity;
  }
  if (missing.length > 0) {
    return fail(id, { seats: expectedSeats }, { seats: actual, missing, perBench }, 'bench furniture is missing');
  }
  return actual === expectedSeats
    ? pass(id, { seats: expectedSeats }, { seats: actual, perBench })
    : fail(id, { seats: expectedSeats }, { seats: actual, perBench }, 'measured seat capacity differs from the design');
}

function checkFlush(spec: Spec, graph: AsBuiltObjectGraph): CoverageCheckResult {
  const door = entranceOpening(spec);
  const id = 'check:flush:' + (door?.id ?? 'missing');
  if (door === undefined) return unverified(id, {}, null, 'no entrance door');
  const standing = standingY(spec);
  const sites = graph.objects.filter((object): object is SiteObject => object.kind === 'site');
  const adjacent = sites.filter((site) => {
    const outward =
      door.side === 'north'
        ? site.bounds.max[2] === door.bounds.min[2]
        : door.side === 'south'
          ? site.bounds.min[2] === door.bounds.max[2]
          : door.side === 'west'
            ? site.bounds.max[0] === door.bounds.min[0]
            : site.bounds.min[0] === door.bounds.max[0];
    return outward;
  });
  const tops = adjacent.map((site) => siteTop(site));
  const actualTop = tops.length === 0 ? null : Math.max(...tops);
  const expected = { doorSillY: door.bounds.min[1], standingY: standing, flush: true };
  if (actualTop === null)
    return unverified(
      id,
      expected,
      null,
      'no adjacent outdoor ground surface measured at the entrance; threshold cannot be measured',
    );
  const actual = {
    doorSillY: door.bounds.min[1],
    outdoorTopY: actualTop,
    flush: door.bounds.min[1] === standing && actualTop === standing,
  };
  if (actual.flush) return pass(id, expected, actual);
  return fail(
    id,
    expected,
    actual,
    actualTop < standing ? 'entrance has a one-step rise' : 'entrance has a raised threshold or platform',
  );
}

function checkDoorClear(spec: Spec, graph: AsBuiltObjectGraph): CoverageCheckResult {
  const door = entranceOpening(spec);
  const id = 'check:door-clear:' + (door?.id ?? 'missing');
  if (door === undefined) return unverified(id, {}, null, 'no entrance door');
  const furniture = graph.objects.filter((object): object is FurnitureObject => object.kind === 'furniture');
  if (furniture.length === 0) return unverified(id, { clearBand: true }, null, 'no actual furniture measured');
  const standing = standingY(spec);
  const band = {
    minX: door.bounds.min[0],
    maxX: door.bounds.max[0],
    minZ: door.bounds.min[2],
    maxZ: door.bounds.max[2],
  };
  if (door.side === 'north') {
    band.minZ = door.bounds.max[2];
    band.maxZ = door.bounds.max[2] + 1;
  } else if (door.side === 'south') {
    band.minZ = door.bounds.min[2] - 1;
    band.maxZ = door.bounds.min[2];
  } else if (door.side === 'west') {
    band.minX = door.bounds.max[0];
    band.maxX = door.bounds.max[0] + 1;
  } else {
    band.minX = door.bounds.min[0] - 1;
    band.maxX = door.bounds.min[0];
  }
  const intruders = furniture.filter(
    (object) =>
      object.bounds.max[1] > standing &&
      object.bounds.max[0] > band.minX &&
      object.bounds.min[0] < band.maxX &&
      object.bounds.max[2] > band.minZ &&
      object.bounds.min[2] < band.maxZ,
  );
  return intruders.length === 0
    ? pass(id, { clearBand: true, band }, { furniture: furniture.length })
    : fail(
        id,
        { clearBand: true, band },
        { ids: intruders.map((object) => object.id).sort(compareText) },
        'furniture occupies the 1m clear band inside the entrance',
      );
}

function checkSchedule(spec: Spec, graph: AsBuiltObjectGraph, side: Side): CoverageCheckResult {
  const id = 'check:schedule:' + side;
  const openings = graph.objects.filter((object): object is OpeningObject => object.kind === 'opening');
  const expected = expectedSchedule(spec, side);
  const actual = sideSchedule(spec, openings, side);
  if (expected.length === 0 && actual.length === 0) return pass(id, { openings: [] }, { openings: [] });
  if (actual.length === 0)
    return unverified(id, { openings: expected }, null, 'no actual opening measured on this side');
  return JSON.stringify(expected) === JSON.stringify(actual)
    ? pass(id, { openings: expected }, { openings: actual })
    : fail(id, { openings: expected }, { openings: actual }, 'opening schedule on this side differs from the design');
}

function checkDoorPosition(spec: Spec, graph: AsBuiltObjectGraph): CoverageCheckResult {
  const door = entranceOpening(spec);
  const id = 'check:door-position:' + (door?.id ?? 'missing');
  if (door === undefined) return unverified(id, {}, null, 'no entrance door');
  const openings = graph.objects.filter((object): object is OpeningObject => object.kind === 'opening');
  const actual = openings.find(
    (opening) =>
      opening.bounds.max[0] > door.bounds.min[0] &&
      opening.bounds.min[0] < door.bounds.max[0] &&
      opening.bounds.max[2] > door.bounds.min[2] &&
      opening.bounds.min[2] < door.bounds.max[2],
  );
  const midX = (spec.bounds.min[0] + spec.bounds.max[0]) / 2;
  const expectedCenter = (door.bounds.min[0] + door.bounds.max[0]) / 2;
  const expected = { side: door.side, westOfCenter: expectedCenter < midX, centerX: expectedCenter };
  if (actual === undefined) return fail(id, expected, null, 'entrance door object is missing');
  const actualCenter = (actual.bounds.min[0] + actual.bounds.max[0]) / 2;
  const actualSide = sideOfOpening(spec, actual);
  return actualSide === door.side && actualCenter < midX === expected.westOfCenter
    ? pass(id, expected, { side: actualSide, centerX: actualCenter })
    : fail(
        id,
        expected,
        { side: actualSide, centerX: actualCenter },
        'entrance is not on the designed west side of the north wall',
      );
}

/**
 * 派生全部覆盖检查。未知 / 缺失证据保持 unverified；只有全部可测且相等才 pass。
 * 不按具体房子写坐标；所有期望来自 spec，实际来自 as-built 对象图。
 */
export function evaluateCoverage(
  spec: Spec,
  graph: AsBuiltObjectGraph,
  grid?: Grid,
  registry?: BlockRegistry,
): CoverageEvidence {
  const furniture = graph.objects.filter((object): object is FurnitureObject => object.kind === 'furniture');
  const expectedFurnitureObjects = expectedFurniture(spec);
  const furnitureItems = diffFurnitureObjects(expectedFurnitureObjects, furniture);
  const checks: CoverageCheckResult[] = [
    checkStorey(spec, graph),
    checkClear(spec, graph),
    checkThickness(spec, graph),
    checkMaterial('check:material:wall', spec, graph, 'wall'),
    checkMaterial('check:material:structure', spec, graph, 'structure'),
    checkMaterial('check:material:roof', spec, graph, 'roof'),
    checkMaterial('check:material:base', spec, graph, 'base'),
    checkBudget(spec, graph),
    checkAbsence('check:absence:mezzanine', spec, graph, 'mezzanine'),
    checkAbsence('check:absence:stairs-basement', spec, graph, 'stairs-basement'),
    checkAbsence('check:absence:partition', spec, graph, 'partition', grid, registry),
    checkAbsence('check:absence:glass-door', spec, graph, 'glass-door'),
    checkAbsence('check:absence:counter-service', spec, graph, 'counter-service'),
    checkAbsence('check:absence:eave-platform', spec, graph, 'eave-platform'),
    checkAbsence('check:absence:base-platform', spec, graph, 'base-platform'),
    ...['north', 'east', 'south', 'west'].map((side) => checkSchedule(spec, graph, side as Side)),
    checkDoorPosition(spec, graph),
    checkDoorClear(spec, graph),
    checkFlush(spec, graph),
  ];
  const seats = seatTarget(spec);
  if (seats !== null) checks.push(checkSeats(spec, graph, seats));
  checks.sort((a, b) => compareText(a.id, b.id));
  furnitureItems.sort((a, b) => compareText(a.id, b.id));
  return { checks, furnitureItems };
}

function seatTarget(spec: Spec): number | null {
  for (const must of spec.musts) {
    if (!/座|seat/iu.test(must.text)) continue;
    const pair = /(\d+)\s*\+\s*(\d+)/u.exec(must.text);
    if (pair !== null) return Number(pair[1]) + Number(pair[2]);
    const single = /(\d+)\s*座/u.exec(must.text);
    if (single !== null) return Number(single[1]);
  }
  return null;
}

/** BuildSheet / 投影允许的 check id 列表；与 evaluateCoverage 的 id 保持同一套。 */
export function projectCoverageObjects(spec: Spec): readonly CoverageProjectionObject[] {
  const level = firstLevel(spec);
  const ids = [
    `check:storey:${level.id}`,
    `check:clear:${level.id}`,
    `check:thickness:${level.id}`,
    'check:material:wall',
    'check:material:structure',
    'check:material:roof',
    'check:material:base',
    `check:budget:${String(spec.budget.maxBlocks)}`,
    'check:absence:mezzanine',
    'check:absence:stairs-basement',
    'check:absence:partition',
    'check:absence:glass-door',
    'check:absence:counter-service',
    'check:absence:eave-platform',
    'check:absence:base-platform',
    'check:schedule:north',
    'check:schedule:east',
    'check:schedule:south',
    'check:schedule:west',
    `check:door-position:${entranceOpening(spec)?.id ?? 'missing'}`,
    `check:door-clear:${entranceOpening(spec)?.id ?? 'missing'}`,
    `check:flush:${entranceOpening(spec)?.id ?? 'missing'}`,
  ];
  const seats = seatTarget(spec);
  if (seats !== null) ids.push(`check:seats:${String(seats)}`);
  return ids.sort(compareText).map((id) => ({ id, kind: 'check' as const, label: id }));
}

/** BuildSheet 的家具投影（与 diffFurnitureObjects 的 expected 同一口径）。 */
export function projectExpectedFurniture(spec: Spec): readonly ExpectedFurniture[] {
  return expectedFurniture(spec);
}

export function coverageById(evidence: CoverageEvidence): ReadonlyMap<string, CoverageCheckResult> {
  return new Map(evidence.checks.map((check) => [check.id, check]));
}

export function furnitureItemsById(evidence: CoverageEvidence): ReadonlyMap<string, DiffItem> {
  const map = new Map<string, DiffItem>();
  for (const item of evidence.furnitureItems) {
    if (item.expectedId !== null) map.set(item.expectedId, item);
  }
  return map;
}

/** 供评审文案使用的一行摘要；不含坐标，避免把检查写死到一栋房子。 */
export function coverageSummary(evidence: CoverageEvidence): string {
  const counts = { pass: 0, fail: 0, unverified: 0 };
  for (const check of evidence.checks) counts[check.status] += 1;
  return `coverage pass ${String(counts.pass)} / fail ${String(counts.fail)} / unverified ${String(counts.unverified)}；家具 ${String(evidence.furnitureItems.length)} 项`;
}
