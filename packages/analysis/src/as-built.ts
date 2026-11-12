/* eslint-disable max-lines -- 单个提取器按 first-cut §4 的流水线实现；类型已拆到 as-built-types.ts，继续拆会共享大量内部遍历状态。 */
/**
 * 通用 as-built 对象图提取（CONF-NEXT-02C，`.work/conf-next-02-first-cut.md`）。
 *
 * 负责：从最终体素网格提取 wall / slab / roof / opening / site / furniture / unknown，给出半开 bounds、
 * coverage 硬不变量、确定性 ID/排序、最小 support 事实与 opening.host。
 * 不负责：diff、submit、CLI、lighting；通用家具只按几何识别为 other / light，不猜 table / counter / seat 语义。
 *
 * 纯函数：只依赖传入的 Grid + BlockRegistry；不读文件、不联网、不用 Date/random/Node 内置。
 */

import type { BlockInfo, BlockRegistry, Shape } from '@pg/blocks/registry';
import type { BlockState } from '@pg/core/block-state';
import type { Bounds, CallDef, Grid } from '@pg/core/grid';

import { compareCells, packer, samplesOf } from './sample.ts';
import type { Packer } from './sample.ts';
import type {
  AsBuiltBounds,
  AsBuiltDiagnostic,
  AsBuiltObject,
  AsBuiltObjectGraph,
  AsBuiltSupport,
  Confidence,
  FurnitureObject,
  MaterialCount,
  ObjectKind,
  OpeningObject,
  RoofObject,
  SiteObject,
  SlabObject,
  SourceRef,
  UnknownObject,
  WallObject,
} from './as-built-types.ts';

export type {
  AsBuiltBounds,
  AsBuiltDiagnostic,
  AsBuiltObject,
  AsBuiltObjectGraph,
  AsBuiltSupport,
  Confidence,
  FurnitureObject,
  FurnitureSubtype,
  MaterialCount,
  ObjectKind,
  OpeningObject,
  RoofObject,
  SiteObject,
  SlabObject,
  SourceRef,
  UnknownObject,
  WallObject,
} from './as-built-types.ts';

/** 对象图 schema 版本；第一刀固定为 1。 */
export const AS_BUILT_SCHEMA_VERSION = 1 as const;

const KINDS: readonly ObjectKind[] = ['wall', 'slab', 'roof', 'opening', 'site', 'furniture', 'unknown'];
const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low'];
const KIND_INDEX = new Map<ObjectKind, number>(KINDS.map((kind, index) => [kind, index]));

const SURFACE_SHAPES: ReadonlySet<Shape> = new Set(['cube', 'slab', 'stairs', 'glass', 'pane']);
const THIN_DECOR_SHAPES: ReadonlySet<Shape> = new Set(['button', 'pressure_plate', 'carpet', 'sheet', 'trapdoor']);

/**
 * 单层 slab/pressure_plate 台面的面积上限：1 格厚的 4×4 以内小面按家具/台面残留处理；
 * 更大或更厚的抬高面按平台处理。这个上限来自“桌面/柜台通常是单层小面”，不是某栋房子的尺寸。
 */
const MAX_SMALL_TOP_AREA = 16;

/**
 * 长条凳座位换算：0.8 格/座。用整数十分位计算，避免 `span / 0.8` 的浮点尾差。
 */
const SEAT_PITCH_TENTHS = 8;

/** 通用家具体量的上限：面积 <= 15、垂直高度 <= 3；超过即视为结构/平台。 */
const MAX_GENERIC_FURNITURE_AREA = 15;
const MAX_GENERIC_FURNITURE_HEIGHT = 3;

const STORAGE_NAMES: ReadonlySet<string> = new Set([
  'chest',
  'trapped_chest',
  'ender_chest',
  'barrel',
  'furnace',
  'blast_furnace',
  'smoker',
  'dispenser',
  'dropper',
  'hopper',
]);

const DIRS4: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const FACE6: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export type AsBuiltErrorCode = 'coverage-invariant';

export class AsBuiltError extends Error {
  readonly code: AsBuiltErrorCode;

  constructor(code: AsBuiltErrorCode, message: string) {
    super(message);
    this.name = 'AsBuiltError';
    this.code = code;
  }
}

interface IndexedCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly state: BlockState;
  readonly info: BlockInfo;
  readonly call: number;
}

interface Column {
  readonly x: number;
  readonly z: number;
  readonly cells: readonly IndexedCell[];
}

interface Extent {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

interface Context {
  readonly grid: Grid;
  readonly registry: BlockRegistry;
  readonly bounds: Bounds;
  readonly cells: readonly IndexedCell[];
  readonly columns: ReadonlyMap<string, Column>;
  readonly columnsSorted: readonly Column[];
  readonly byKey: ReadonlyMap<number, IndexedCell>;
  readonly callsById: ReadonlyMap<number, CallDef>;
  /**
   * 按调用分组的格子；只用于识别“单层水平铺面”调用（楼板 / 平台），
   * 避免这类格子被并入墙面板的墙脚。没有调用信息的网格（call=0）不受影响。
   */
  readonly cellsByCall: ReadonlyMap<number, readonly IndexedCell[]>;
  readonly horizontalPlateCalls: ReadonlySet<number>;
  readonly pk: Packer;
  readonly minY: number;
  readonly groundBandTop: number;
}

interface Panel {
  readonly axis: 'x' | 'z';
  readonly plane: number;
  readonly key: string;
  readonly cells: readonly IndexedCell[];
  readonly uMin: number;
  readonly uMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly lengthCells: number;
  readonly heightCells: number;
  readonly area: number;
}

interface WallBundle {
  readonly panel: Panel;
  readonly draft: WallObject;
}

interface RoofResult {
  readonly drafts: readonly RoofObject[];
  readonly claimed: ReadonlySet<number>;
  readonly footprint: ReadonlySet<string>;
  readonly cellsByDraft: ReadonlyMap<RoofObject, readonly IndexedCell[]>;
}

interface WallResult {
  readonly drafts: readonly WallObject[];
  readonly claimed: ReadonlySet<number>;
  readonly footprint: ReadonlySet<string>;
  readonly bundles: readonly WallBundle[];
  readonly cellsByDraft: ReadonlyMap<WallObject, readonly IndexedCell[]>;
  /** 檐口/压顶行：从墙面板剔除，留给 unknown，避免落进 slab。 */
  readonly eaveTrim: ReadonlySet<number>;
  /** 实心体量（无室内空气）：不是房子，全部留给 unknown。 */
  readonly solidMass: boolean;
}

interface OpeningResult {
  readonly drafts: readonly OpeningObject[];
  readonly claimed: ReadonlySet<number>;
  readonly hostByDraft: ReadonlyMap<OpeningObject, WallObject>;
  readonly cellsByDraft: ReadonlyMap<OpeningObject, readonly IndexedCell[]>;
}

interface HorizontalResult {
  readonly drafts: readonly (SlabObject | SiteObject)[];
  readonly claimed: ReadonlySet<number>;
  readonly cellsByDraft: ReadonlyMap<SlabObject | SiteObject, readonly IndexedCell[]>;
}

interface FurnitureResult {
  readonly drafts: readonly FurnitureObject[];
  readonly claimed: ReadonlySet<number>;
  readonly cellsByDraft: ReadonlyMap<FurnitureObject, readonly IndexedCell[]>;
}

interface UnknownResult {
  readonly drafts: readonly UnknownObject[];
  readonly ambiguousComponents: number;
  readonly cellsByDraft: ReadonlyMap<UnknownObject, readonly IndexedCell[]>;
}

interface RoofFacts {
  readonly eaveY: number;
  readonly ridgeY: number;
  readonly topCells: number;
  readonly pitchDegrees: number | null;
  readonly ridgeAxis: 'x' | 'z' | null;
  readonly ridgeWidth: number | null;
  readonly formHint: 'flat' | 'pitched' | 'stepped' | 'complex' | 'unknown';
}

function columnKey(x: number, z: number): string {
  return `${String(x)},${String(z)}`;
}

function cellKeyOf(ctx: Context, x: number, y: number, z: number): number {
  return ctx.pk.key(x, y, z);
}

function at(ctx: Context, x: number, y: number, z: number): IndexedCell | undefined {
  if (!ctx.pk.inside(x, y, z)) return undefined;
  return ctx.byKey.get(ctx.pk.key(x, y, z));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function extentOfCells(cells: readonly IndexedCell[]): Extent {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.z < minZ) minZ = c.z;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
    if (c.z > maxZ) maxZ = c.z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function extentOfPoints(points: readonly (readonly [number, number, number])[]): Extent {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const [x, y, z] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function boundsOfExtent(extent: Extent): AsBuiltBounds {
  return {
    min: [extent.minX, extent.minY, extent.minZ],
    max: [extent.maxX + 1, extent.maxY + 1, extent.maxZ + 1],
  };
}

function boundsOfCells(cells: readonly IndexedCell[]): AsBuiltBounds {
  return boundsOfExtent(extentOfCells(cells));
}

function boundsOfPoints(points: readonly (readonly [number, number, number])[]): AsBuiltBounds {
  return boundsOfExtent(extentOfPoints(points));
}

function clippedBounds(bounds: AsBuiltBounds, gridBounds: Bounds): boolean {
  return (
    bounds.min[0] <= gridBounds.min[0] ||
    bounds.min[1] <= gridBounds.min[1] ||
    bounds.min[2] <= gridBounds.min[2] ||
    bounds.max[0] >= gridBounds.max[0] + 1 ||
    bounds.max[1] >= gridBounds.max[1] + 1 ||
    bounds.max[2] >= gridBounds.max[2] + 1
  );
}

function materialsOf(cells: readonly IndexedCell[]): readonly MaterialCount[] {
  const counts = new Map<string, number>();
  for (const c of cells) {
    const block = c.state.name;
    counts.set(block, (counts.get(block) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => compareText(a, b)).map(([block, cells]) => ({ block, cells }));
}

function footprintOf(cells: readonly IndexedCell[]): number {
  const columns = new Set<string>();
  for (const c of cells) columns.add(columnKey(c.x, c.z));
  return columns.size;
}

function footprintColumnsOf(cells: readonly IndexedCell[]): Set<string> {
  const columns = new Set<string>();
  for (const c of cells) columns.add(columnKey(c.x, c.z));
  return columns;
}

function sourceOf(cells: readonly IndexedCell[], callsById: ReadonlyMap<number, CallDef>): SourceRef {
  const ids = [...new Set(cells.filter((c) => c.call > 0).map((c) => c.call))].sort((a, b) => a - b).slice(0, 8);
  const calls = ids
    .map((id) => callsById.get(id))
    .filter((call): call is CallDef => call !== undefined)
    .map(({ id, api, line }) => ({ id, api, line }));
  return { calls };
}

function isGlass(info: BlockInfo): boolean {
  return info.shape === 'glass' || info.shape === 'pane' || info.id.includes('glass');
}

function isDoorPanel(info: BlockInfo): boolean {
  return (
    info.shape === 'door' || info.shape === 'fence_gate' || info.id.endsWith('_door') || info.id.endsWith('_fence_gate')
  );
}

function isLight(info: BlockInfo): boolean {
  return info.shape === 'light';
}

function isChain(info: BlockInfo): boolean {
  return info.shape === 'other' && info.id.endsWith('chain');
}

function isPlantLike(info: BlockInfo): boolean {
  // 可穿过的植物/液体才排除；moss_block 这类 shape=plant 但不透明的整块地面按实体处理。
  if (info.shape === 'plant') return info.transparent;
  if (info.shape === 'fluid') return true;
  if (info.family === 'leaves') return true;
  return info.family === 'plant' && !isWallShape(info);
}

function isThinDecor(info: BlockInfo): boolean {
  return THIN_DECOR_SHAPES.has(info.shape);
}

function isFence(info: BlockInfo): boolean {
  return info.shape === 'fence' || info.shape === 'fence_gate';
}

function isWallShape(info: BlockInfo): boolean {
  return info.shape === 'cube' || info.shape === 'wall';
}

function furnitureSubtype(name: string): 'bed' | 'storage' | 'shelf' | null {
  if (name === 'bookshelf' || name.endsWith('_shelf')) return 'shelf';
  if (name.endsWith('_bed')) return 'bed';
  if (STORAGE_NAMES.has(name) || name.endsWith('_shulker_box')) return 'storage';
  return null;
}

function isFurnitureToken(info: BlockInfo): boolean {
  return furnitureSubtype(info.id) !== null;
}

function isStructuralCell(info: BlockInfo): boolean {
  return (
    isWallShape(info) &&
    !isFurnitureToken(info) &&
    !isLight(info) &&
    !isChain(info) &&
    !isGlass(info) &&
    !isDoorPanel(info) &&
    !isPlantLike(info) &&
    !isThinDecor(info) &&
    !isFence(info)
  );
}

function isRoofSurface(info: BlockInfo): boolean {
  return (
    SURFACE_SHAPES.has(info.shape) &&
    !isLight(info) &&
    !isChain(info) &&
    !isPlantLike(info) &&
    !isThinDecor(info) &&
    !isDoorPanel(info) &&
    !isFence(info) &&
    !isFurnitureToken(info)
  );
}

function indexGrid(grid: Grid, registry: BlockRegistry): Context | undefined {
  const bounds = grid.bounds();
  if (bounds === undefined) return undefined;
  const cells: IndexedCell[] = [];
  for (const c of grid.cells()) {
    cells.push({ x: c.x, y: c.y, z: c.z, state: c.state, info: registry.info(c.state), call: c.call });
  }
  cells.sort(compareCells);
  const pk = packer(bounds, 3);
  const byKey = new Map<number, IndexedCell>();
  const columnMap = new Map<string, { x: number; y: number; z: number; cells: IndexedCell[] }>();
  for (const c of cells) {
    byKey.set(pk.key(c.x, c.y, c.z), c);
    const key = columnKey(c.x, c.z);
    let column = columnMap.get(key);
    if (column === undefined) {
      column = { x: c.x, y: 0, z: c.z, cells: [] };
      columnMap.set(key, column);
    }
    column.cells.push(c);
  }
  const columns = new Map<string, Column>();
  for (const [key, column] of columnMap) {
    columns.set(key, { x: column.x, z: column.z, cells: column.cells });
  }
  const columnsSorted = [...columns.values()].sort((a, b) => a.x - b.x || a.z - b.z);
  const callsById = new Map(grid.calls().map((call) => [call.id, call] as const));
  const cellsByCall = new Map<number, IndexedCell[]>();
  for (const cell of cells) {
    if (cell.call <= 0) continue;
    const list = cellsByCall.get(cell.call);
    if (list === undefined) cellsByCall.set(cell.call, [cell]);
    else list.push(cell);
  }
  const horizontalPlateCalls = new Set<number>();
  for (const [call, callCells] of cellsByCall) {
    if (callCells.length < 4) continue;
    const extent = extentOfCells(callCells);
    // 单层、且水平两个方向都成面：楼板 / 平台调用。单格的 set、沿一条线的矮墙、
    // 多层体量（walls / box）都不满足，因此不会被误当成水平铺面。
    if (extent.minY !== extent.maxY) continue;
    if (extent.maxX - extent.minX < 1 || extent.maxZ - extent.minZ < 1) continue;
    horizontalPlateCalls.add(call);
  }
  return {
    grid,
    registry,
    bounds,
    cells,
    columns,
    columnsSorted,
    byKey,
    callsById,
    cellsByCall,
    horizontalPlateCalls,
    pk,
    minY: bounds.min[1],
    groundBandTop: bounds.min[1] + 1,
  };
}

function componentsOf(
  ctx: Context,
  seeds: readonly IndexedCell[],
  allowed: ReadonlySet<number>,
): readonly (readonly IndexedCell[])[] {
  const visited = new Set<number>();
  const out: (readonly IndexedCell[])[] = [];
  const sorted = [...seeds].sort(compareCells);
  for (const seed of sorted) {
    const seedKey = cellKeyOf(ctx, seed.x, seed.y, seed.z);
    if (visited.has(seedKey) || !allowed.has(seedKey)) continue;
    visited.add(seedKey);
    const queue: IndexedCell[] = [seed];
    const component: IndexedCell[] = [];
    for (const current of queue) {
      component.push(current);
      for (const [dx, dy, dz] of FACE6) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        const nz = current.z + dz;
        if (!ctx.pk.inside(nx, ny, nz)) continue;
        const key = ctx.pk.key(nx, ny, nz);
        if (visited.has(key) || !allowed.has(key)) continue;
        const neighbor = ctx.byKey.get(key);
        if (neighbor === undefined) continue;
        visited.add(key);
        queue.push(neighbor);
      }
    }
    component.sort(compareCells);
    out.push(component);
  }
  return out;
}

function acceptedTopColumns(
  ctx: Context,
  component: readonly IndexedCell[],
  topByColumn: ReadonlyMap<string, IndexedCell>,
): boolean {
  const topCells = component.length;
  if (topCells < 4) return false;
  const extent = extentOfCells(component);
  const width = extent.maxX - extent.minX + 1;
  const depth = extent.maxZ - extent.minZ + 1;
  if (!(Math.min(width, depth) >= 2 || topCells >= 8)) return false;
  const eaveY = extent.minY;
  if (eaveY < ctx.minY + 2) return false;
  if (topCells >= 8) return true;

  const componentColumns = new Set(component.map((c) => columnKey(c.x, c.z)));
  for (const seed of component) {
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        if (dx === 0 && dz === 0) continue;
        const x = seed.x + dx;
        const z = seed.z + dz;
        if (componentColumns.has(columnKey(x, z))) continue;
        if (topByColumn.has(columnKey(x, z))) continue;
        if (
          at(ctx, x, eaveY - 1, z) !== undefined &&
          at(ctx, x, eaveY - 2, z) !== undefined &&
          at(ctx, x, eaveY - 3, z) !== undefined
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function roofFacts(component: readonly IndexedCell[]): RoofFacts {
  const extent = extentOfCells(component);
  const eaveY = extent.minY;
  const ridgeY = extent.maxY;
  const topCells = component.length;
  if (eaveY === ridgeY) {
    return { eaveY, ridgeY, topCells, pitchDegrees: 0, ridgeAxis: null, ridgeWidth: null, formHint: 'flat' };
  }

  const ridgeCells = component.filter((cell) => cell.y === ridgeY);
  const ridgeExtent = extentOfCells(ridgeCells);
  const ridgeXSpan = ridgeExtent.maxX - ridgeExtent.minX;
  const ridgeZSpan = ridgeExtent.maxZ - ridgeExtent.minZ;
  const ridgeAxis: 'x' | 'z' = ridgeXSpan > ridgeZSpan ? 'x' : 'z';
  const lines = new Map<number, IndexedCell[]>();
  for (const c of component) {
    const lineKey = ridgeAxis === 'z' ? c.z : c.x;
    const line = lines.get(lineKey);
    if (line === undefined) lines.set(lineKey, [c]);
    else line.push(c);
  }
  const lineKeys = [...lines.keys()].sort((a, b) => a - b);
  let ridgeWidth = 0;
  let pitchSum = 0;
  let pitchCount = 0;
  let allMonotonic = true;
  let allSinglePeak = true;

  for (const lineKey of lineKeys) {
    const line = lines.get(lineKey);
    if (line === undefined) continue;
    line.sort((a, b) => (ridgeAxis === 'z' ? a.x - b.x : a.z - b.z));
    const values = line.map((c) => c.y);

    let run = 0;
    let previousU: number | undefined;
    for (const c of line) {
      if (c.y !== ridgeY) {
        run = 0;
        previousU = undefined;
        continue;
      }
      const u = ridgeAxis === 'z' ? c.x : c.z;
      run = previousU !== undefined && u === previousU + 1 ? run + 1 : 1;
      if (run > ridgeWidth) ridgeWidth = run;
      previousU = u;
    }

    let firstRidge = 0;
    let lastRidge = 0;
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] === ridgeY) {
        firstRidge = index;
        break;
      }
    }
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (values[index] === ridgeY) {
        lastRidge = index;
        break;
      }
    }

    const leftDelta = ridgeY - (values[0] ?? ridgeY);
    if (firstRidge > 0 && leftDelta > 0) {
      pitchSum += Math.atan2(leftDelta, firstRidge);
      pitchCount += 1;
    }
    const rightDelta = ridgeY - (values[values.length - 1] ?? ridgeY);
    const rightRun = values.length - 1 - lastRidge;
    if (rightRun > 0 && rightDelta > 0) {
      pitchSum += Math.atan2(rightDelta, rightRun);
      pitchCount += 1;
    }

    for (let index = 1; index <= firstRidge; index += 1) {
      if ((values[index] ?? 0) < (values[index - 1] ?? 0)) allMonotonic = false;
    }
    for (let index = lastRidge + 1; index < values.length; index += 1) {
      if ((values[index] ?? 0) > (values[index - 1] ?? 0)) allMonotonic = false;
    }
    let sawDown = false;
    for (let index = 1; index < values.length; index += 1) {
      const delta = (values[index] ?? 0) - (values[index - 1] ?? 0);
      if (delta < 0) sawDown = true;
      else if (delta > 0 && sawDown) allSinglePeak = false;
    }
  }

  const pitchDegrees = pitchCount === 0 ? null : Math.round((pitchSum / pitchCount) * (180 / Math.PI) * 10) / 10;
  const formHint = allMonotonic ? 'pitched' : allSinglePeak ? 'stepped' : 'complex';
  return {
    eaveY,
    ridgeY,
    topCells,
    pitchDegrees,
    ridgeAxis,
    ridgeWidth: ridgeWidth === 0 ? null : ridgeWidth,
    formHint,
  };
}

function claimRoof(
  ctx: Context,
  component: readonly IndexedCell[],
  claimed: Set<number>,
  facts: RoofFacts,
): readonly IndexedCell[] {
  const roofCells = new Set<number>();
  const baseTop = facts.eaveY;
  for (const top of component) {
    roofCells.add(cellKeyOf(ctx, top.x, top.y, top.z));
    const column = ctx.columns.get(columnKey(top.x, top.z));
    if (column === undefined) continue;
    for (const c of column.cells) {
      if (c.y >= baseTop && c.y <= top.y) roofCells.add(cellKeyOf(ctx, c.x, c.y, c.z));
    }
  }

  const totalHeight = ctx.bounds.max[1] - ctx.bounds.min[1] + 1;
  const maxDepth = Math.min(6, Math.max(1, Math.ceil(totalHeight / 2)));
  const componentExtent = extentOfCells(component);
  const hasSurfaceArea = componentExtent.maxX > componentExtent.minX && componentExtent.maxZ > componentExtent.minZ;
  // 平屋面只认领暴露顶面：下面一层是墙圈/房间，不是屋面体量。只有坡面才需要向下层壳。
  const needsShell = facts.eaveY < facts.ridgeY;
  for (
    let y = baseTop - 1, depth = 0;
    hasSurfaceArea && needsShell && y >= ctx.groundBandTop + 1 && depth < maxDepth;
    y -= 1, depth += 1
  ) {
    const layer: IndexedCell[] = [];
    for (const top of component) {
      const cell = at(ctx, top.x, y, top.z);
      if (cell === undefined) continue;
      if (!roofCells.has(cellKeyOf(ctx, top.x, y + 1, top.z))) continue;
      layer.push(cell);
    }
    if (layer.length === 0) break;
    const extent = extentOfCells(layer);
    const width = extent.maxX - extent.minX + 1;
    const depthZ = extent.maxZ - extent.minZ + 1;
    const area = width * depthZ;
    const fillRatio = layer.length / area;
    const perimeter = width * depthZ - Math.max(0, width - 2) * Math.max(0, depthZ - 2);
    const interiorArea = area - perimeter;
    let interiorOccupied = 0;
    if (interiorArea > 0) {
      for (const c of layer) {
        if (c.x > extent.minX && c.x < extent.maxX && c.z > extent.minZ && c.z < extent.maxZ) interiorOccupied += 1;
      }
    }
    const shell = area >= 4 && interiorArea > 0 && interiorOccupied / interiorArea < 0.5;
    if (fillRatio < 0.55 || shell) break;
    for (const c of layer) roofCells.add(cellKeyOf(ctx, c.x, c.y, c.z));
  }

  const out: IndexedCell[] = [];
  for (const key of roofCells) {
    const cell = ctx.byKey.get(key);
    if (cell !== undefined) out.push(cell);
  }
  out.sort(compareCells);
  for (const c of out) claimed.add(cellKeyOf(ctx, c.x, c.y, c.z));
  return out;
}

function detectRoofs(ctx: Context): RoofResult {
  const topByColumn = new Map<string, IndexedCell>();
  for (const column of ctx.columnsSorted) {
    for (let index = column.cells.length - 1; index >= 0; index -= 1) {
      const cell = column.cells[index];
      if (cell === undefined) continue;
      if (isRoofSurface(cell.info)) {
        topByColumn.set(columnKey(cell.x, cell.z), cell);
        break;
      }
    }
  }

  const visited = new Set<string>();
  const drafts: RoofObject[] = [];
  const claimed = new Set<number>();
  const footprint = new Set<string>();
  const cellsByDraft = new Map<RoofObject, readonly IndexedCell[]>();
  const seeds = [...topByColumn.values()].sort(compareCells);
  for (const seed of seeds) {
    const seedKey = columnKey(seed.x, seed.z);
    if (visited.has(seedKey)) continue;
    visited.add(seedKey);
    const queue: IndexedCell[] = [seed];
    const component: IndexedCell[] = [];
    for (const current of queue) {
      component.push(current);
      for (const [dx, dz] of DIRS4) {
        const key = columnKey(current.x + dx, current.z + dz);
        if (visited.has(key)) continue;
        const neighbor = topByColumn.get(key);
        if (neighbor === undefined) continue;
        if (Math.abs(neighbor.y - current.y) > 1) continue;
        visited.add(key);
        queue.push(neighbor);
      }
    }
    component.sort(compareCells);
    if (!acceptedTopColumns(ctx, component, topByColumn)) continue;
    const facts = roofFacts(component);
    const cells = claimRoof(ctx, component, claimed, facts);
    for (const key of footprintColumnsOf(component)) footprint.add(key);
    const bounds = boundsOfCells(cells);
    const confidence: Confidence = facts.topCells >= 8 ? 'high' : 'medium';
    const draft: RoofObject = {
      id: '',
      kind: 'roof',
      bounds,
      cells: cells.length,
      footprintCells: footprintOf(cells),
      materials: materialsOf(cells),
      samples: samplesOf(ctx.grid, cells),
      confidence,
      source: sourceOf(cells, ctx.callsById),
      clipped: clippedBounds(bounds, ctx.bounds),
      support: null,
      roof: facts,
    };
    drafts.push(draft);
    cellsByDraft.set(draft, cells);
  }
  return { drafts, claimed, footprint, cellsByDraft };
}

function structuralNeighborCount(
  ctx: Context,
  cell: IndexedCell,
  roofClaimed: ReadonlySet<number>,
): { readonly pairs: number; readonly matchedPairs: number } {
  const usable = (dx: number, dz: number): IndexedCell | undefined => {
    const neighbor = at(ctx, cell.x + dx, cell.y, cell.z + dz);
    if (neighbor === undefined) return undefined;
    if (roofClaimed.has(cellKeyOf(ctx, neighbor.x, neighbor.y, neighbor.z))) return undefined;
    return isStructuralCell(neighbor.info) ? neighbor : undefined;
  };
  let pairs = 0;
  let matchedPairs = 0;
  for (const [first, second] of [
    [
      [1, 0],
      [-1, 0],
    ],
    [
      [0, 1],
      [0, -1],
    ],
  ] as const) {
    const a = usable(first[0], first[1]);
    const b = usable(second[0], second[1]);
    if (a === undefined || b === undefined) continue;
    pairs += 1;
    if (a.info.id === cell.info.id || b.info.id === cell.info.id) matchedPairs += 1;
  }
  return { pairs, matchedPairs };
}

function isWallCandidate(ctx: Context, cell: IndexedCell, roofClaimed: ReadonlySet<number>): boolean {
  if (!isStructuralCell(cell.info)) return false;
  if (cell.y < ctx.groundBandTop) return false;
  const { matchedPairs } = structuralNeighborCount(ctx, cell, roofClaimed);
  // 墙线通常只有一个方向与同材质相邻；实心体量/楼板在两个方向都成对且同材质。
  return matchedPairs < 2;
}

function panelEntryKey(axis: 'x' | 'z', cell: IndexedCell): string {
  const u = axis === 'x' ? cell.x : cell.z;
  return `${String(u)},${String(cell.y)}`;
}

function panelU(axis: 'x' | 'z', cell: IndexedCell): number {
  return axis === 'x' ? cell.x : cell.z;
}

function comparePanels(a: Panel, b: Panel): number {
  return (
    b.lengthCells - a.lengthCells ||
    b.heightCells - a.heightCells ||
    (a.axis === b.axis ? 0 : a.axis === 'x' ? -1 : 1) ||
    a.plane - b.plane ||
    compareText(a.key, b.key)
  );
}

/**
 * 墙顶的檐口梁 / 压顶：单独一行、位于墙外皮之外、且其外侧同类结构正上方有已认领屋面。
 * 这类格不是墙高的一部分；用“墙外皮 + 屋面上方”而不是材质名或固定坐标判断。
 */
function isEaveTrimCell(
  ctx: Context,
  cell: IndexedCell,
  wallFootprint: ReadonlySet<string>,
  roofClaimed: ReadonlySet<number>,
): boolean {
  for (const [dx, dz] of DIRS4) {
    const neighbor = at(ctx, cell.x + dx, cell.y, cell.z + dz);
    if (neighbor === undefined || !isRoofSurface(neighbor.info)) continue;
    if (wallFootprint.has(columnKey(neighbor.x, neighbor.z))) continue;
    const above = at(ctx, neighbor.x, neighbor.y + 1, neighbor.z);
    if (above !== undefined && roofClaimed.has(cellKeyOf(ctx, above.x, above.y, above.z))) return true;
  }
  return false;
}

function trimEaveCaps(
  ctx: Context,
  panels: readonly Panel[],
  roofClaimed: ReadonlySet<number>,
): { readonly panels: readonly Panel[]; readonly trimmed: ReadonlySet<number> } {
  const wallFootprint = new Set<string>();
  for (const panel of panels) {
    for (const cell of panel.cells) wallFootprint.add(columnKey(cell.x, cell.z));
  }

  const trimmed = new Set<number>();
  const kept: Panel[] = [];
  for (const panel of panels) {
    const top = panel.cells.filter((cell) => cell.y === panel.yMax);
    const isCap =
      panel.heightCells >= 2 &&
      top.length >= 3 &&
      top.every((cell) => isEaveTrimCell(ctx, cell, wallFootprint, roofClaimed));
    if (!isCap) {
      kept.push(panel);
      continue;
    }

    for (const cell of top) trimmed.add(cellKeyOf(ctx, cell.x, cell.y, cell.z));
    const cells = panel.cells.filter((cell) => cell.y < panel.yMax);
    if (cells.length === 0) continue;
    const yMax = Math.max(...cells.map((cell) => cell.y));
    const heightCells = yMax - panel.yMin + 1;
    kept.push({
      ...panel,
      cells,
      yMax,
      heightCells,
      area: panel.lengthCells * heightCells,
    });
  }
  return { panels: kept, trimmed };
}

/** 由墙面板围合出的建筑 footprint（含墙线与室内）；门洞按整段面板补齐，不向室内漏。 */
function enclosedFootprint(ctx: Context, panels: readonly Panel[]): Set<string> {
  const barrier = new Set<string>();
  for (const panel of panels) {
    if (panel.axis === 'x') {
      for (let u = panel.uMin; u <= panel.uMax; u += 1) barrier.add(columnKey(u, panel.plane));
    } else {
      for (let u = panel.uMin; u <= panel.uMax; u += 1) barrier.add(columnKey(panel.plane, u));
    }
  }

  const [minX, , minZ] = ctx.bounds.min;
  const [maxX, , maxZ] = ctx.bounds.max;
  const outside = new Set<string>();
  const queue: [number, number][] = [];
  const visit = (x: number, z: number): void => {
    if (x < minX || x > maxX || z < minZ || z > maxZ) return;
    const key = columnKey(x, z);
    if (barrier.has(key) || outside.has(key)) return;
    outside.add(key);
    queue.push([x, z]);
  };
  for (let x = minX; x <= maxX; x += 1) {
    visit(x, minZ);
    visit(x, maxZ);
  }
  for (let z = minZ; z <= maxZ; z += 1) {
    visit(minX, z);
    visit(maxX, z);
  }
  for (const current of queue) {
    visit(current[0] + 1, current[1]);
    visit(current[0] - 1, current[1]);
    visit(current[0], current[1] + 1);
    visit(current[0], current[1] - 1);
  }

  const footprint = new Set<string>();
  for (let x = minX; x <= maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      const key = columnKey(x, z);
      if (!outside.has(key)) footprint.add(key);
    }
  }
  return footprint;
}

function hasInteriorAir(
  ctx: Context,
  enclosed: ReadonlySet<string>,
  wallFootprint: ReadonlySet<string>,
  maxY: number,
): boolean {
  const interior = [...enclosed].filter((key) => !wallFootprint.has(key));
  if (interior.length === 0) return true;
  for (const key of interior) {
    const [x, z] = key.split(',').map(Number);
    if (x === undefined || z === undefined) continue;
    for (let y = ctx.groundBandTop + 1; y <= maxY; y += 1) {
      if (at(ctx, x, y, z) === undefined) return true;
    }
  }
  return false;
}

function detectWalls(ctx: Context, roofClaimed: ReadonlySet<number>): WallResult {
  const buckets = new Map<string, { axis: 'x' | 'z'; plane: number; entries: Map<string, IndexedCell> }>();
  const addBucket = (axis: 'x' | 'z', plane: number, cell: IndexedCell): void => {
    const key = `${axis}|${String(plane)}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { axis, plane, entries: new Map() };
      buckets.set(key, bucket);
    }
    bucket.entries.set(panelEntryKey(axis, cell), cell);
  };
  for (const cell of ctx.cells) {
    if (roofClaimed.has(cellKeyOf(ctx, cell.x, cell.y, cell.z))) continue;
    // 单层水平铺面（floorPlate / 平台）的边格在网格最低带会与墙脚同高；
    // 它们属于楼板 / 场地，不是墙。只有该调用整体是一层水平面时才排除，
    // 墙调用的墙脚仍按原规则参与墙板。
    if (ctx.horizontalPlateCalls.has(cell.call)) continue;
    if (!isWallCandidate(ctx, cell, roofClaimed)) continue;
    addBucket('x', cell.z, cell);
    addBucket('z', cell.x, cell);
  }

  const panels: Panel[] = [];
  for (const bucket of buckets.values()) {
    const entries = [...bucket.entries.values()].sort(compareCells);
    const entryKeys = new Set(entries.map((cell) => panelEntryKey(bucket.axis, cell)));
    for (const seed of entries) {
      const seedKey = panelEntryKey(bucket.axis, seed);
      if (!entryKeys.has(seedKey)) continue;
      const queue: IndexedCell[] = [seed];
      const component: IndexedCell[] = [];
      entryKeys.delete(seedKey);
      for (const current of queue) {
        component.push(current);
        const u = panelU(bucket.axis, current);
        for (const [du, dy] of DIRS4) {
          const key = `${String(u + du)},${String(current.y + dy)}`;
          if (!entryKeys.has(key)) continue;
          const neighbor = bucket.entries.get(key);
          if (neighbor === undefined) continue;
          entryKeys.delete(key);
          queue.push(neighbor);
        }
      }
      if (component.length === 0) continue;
      const componentMaxY = Math.max(...component.map((cell) => cell.y));
      // 垂直连续性：墙段每一列至少要达到面板顶部下一格。贴近墙面的单层家具
      // 会被并进同一 x/z 平面 bucket，但它们只有底部一格；不剪掉就会拼出假墙。
      const columnTop = new Map<number, number>();
      for (const cell of component) {
        const u = panelU(bucket.axis, cell);
        const top = columnTop.get(u);
        if (top === undefined || cell.y > top) columnTop.set(u, cell.y);
      }
      const core = component.filter(
        (cell) => (columnTop.get(panelU(bucket.axis, cell)) ?? -Infinity) >= componentMaxY - 1,
      );
      if (core.length === 0) continue;
      const uValues = core.map((cell) => panelU(bucket.axis, cell));
      const uMin = Math.min(...uValues);
      const uMax = Math.max(...uValues);
      const yValues = core.map((cell) => cell.y);
      const yMin = Math.min(...yValues);
      const yMax = Math.max(...yValues);
      const heightCells = yMax - yMin + 1;
      const lengthCells = uMax - uMin + 1;
      if (heightCells < 2 || lengthCells < 3) continue;
      core.sort(compareCells);
      panels.push({
        axis: bucket.axis,
        plane: bucket.plane,
        key: `${bucket.axis}:${String(bucket.plane)}:${String(uMin)}:${String(yMin)}`,
        cells: core,
        uMin,
        uMax,
        yMin,
        yMax,
        lengthCells,
        heightCells,
        area: lengthCells * heightCells,
      });
    }
  }
  panels.sort((a, b) => compareText(a.key, b.key));
  // 洞口套框是贴在墙外侧 1 格的单层环（窗框 / 门框），不是独立墙体。
  // 它必须紧邻一块更大的同向墙板，且自己的整圈洞口与该墙板的洞口对齐。
  const wallLikePanels = panels.filter((panel) => !isOpeningFramePanel(panel, panels));
  const trimmed = trimEaveCaps(ctx, wallLikePanels, roofClaimed);
  // 2–3 格高的实心室内体量（桌 / 柜台 / 矮柜）可能刚好形成“墙面板”，但它们不在外轮廓上。
  // 外轮廓墙保留；低矮的内部面板留给通用家具，避免把家具报成假墙。
  const xPlanes = trimmed.panels.filter((panel) => panel.axis === 'z').map((panel) => panel.plane);
  const zPlanes = trimmed.panels.filter((panel) => panel.axis === 'x').map((panel) => panel.plane);
  const minPlaneX = xPlanes.length === 0 ? Infinity : Math.min(...xPlanes);
  const maxPlaneX = xPlanes.length === 0 ? -Infinity : Math.max(...xPlanes);
  const minPlaneZ = zPlanes.length === 0 ? Infinity : Math.min(...zPlanes);
  const maxPlaneZ = zPlanes.length === 0 ? -Infinity : Math.max(...zPlanes);
  const keptPanels = trimmed.panels.filter((panel) => {
    const boundary =
      panel.axis === 'x'
        ? panel.plane === minPlaneZ || panel.plane === maxPlaneZ
        : panel.plane === minPlaneX || panel.plane === maxPlaneX;
    if (boundary || panel.heightCells > MAX_GENERIC_FURNITURE_HEIGHT) return true;
    // 2–3 格高的薄面板（真实矮隔墙）保留；有法向实体邻居的厚体量（桌 / 柜台）才让给家具。
    // 3 格高且贴墙的体量与 4 格高墙合并后仍是已知限制，不在本波验收范围。
    const panelKeys = new Set(panel.cells.map((cell) => cellKeyOf(ctx, cell.x, cell.y, cell.z)));
    const dx = panel.axis === 'x' ? 0 : 1;
    const dz = panel.axis === 'x' ? 1 : 0;
    const volumeLike = panel.cells.some((cell) => {
      const neighbor = at(ctx, cell.x + dx, cell.y, cell.z + dz);
      if (neighbor === undefined) return false;
      const key = cellKeyOf(ctx, neighbor.x, neighbor.y, neighbor.z);
      return !panelKeys.has(key) && isStructuralCell(neighbor.info);
    });
    return !volumeLike;
  });

  const guardFootprint = new Set<string>();
  for (const panel of keptPanels) {
    for (const cell of panel.cells) guardFootprint.add(columnKey(cell.x, cell.z));
  }
  const guardEnclosed = enclosedFootprint(ctx, keptPanels);
  const maxPanelY = keptPanels.reduce((max, panel) => Math.max(max, panel.yMax), ctx.groundBandTop);
  if (guardEnclosed.size > guardFootprint.size && !hasInteriorAir(ctx, guardEnclosed, guardFootprint, maxPanelY)) {
    // 实心体量（烟囱 / 柱 / 台座）没有室内空气，不是四面墙；整体留给 unknown。
    return {
      drafts: [],
      claimed: new Set<number>(),
      footprint: guardFootprint,
      bundles: [],
      cellsByDraft: new Map<WallObject, readonly IndexedCell[]>(),
      eaveTrim: trimmed.trimmed,
      solidMass: true,
    };
  }

  const cellKey = (cell: IndexedCell): number => cellKeyOf(ctx, cell.x, cell.y, cell.z);
  const panelsByCell = new Map<number, Panel[]>();
  for (const panel of keptPanels) {
    for (const cell of panel.cells) {
      const key = cellKey(cell);
      const list = panelsByCell.get(key);
      if (list === undefined) panelsByCell.set(key, [panel]);
      else list.push(panel);
    }
  }
  const priority = new Map<Panel, number>();
  [...keptPanels].sort(comparePanels).forEach((panel, index) => priority.set(panel, index));
  const owner = new Map<number, Panel>();
  for (const cell of ctx.cells) {
    const list = panelsByCell.get(cellKey(cell));
    if (list === undefined) continue;
    let best: Panel | undefined;
    let bestPriority = Infinity;
    for (const panel of list) {
      const current = priority.get(panel) ?? Infinity;
      if (current < bestPriority) {
        best = panel;
        bestPriority = current;
      }
    }
    if (best !== undefined) owner.set(cellKey(cell), best);
  }

  const drafts: WallObject[] = [];
  const bundles: WallBundle[] = [];
  const cellsByDraft = new Map<WallObject, readonly IndexedCell[]>();
  const claimed = new Set<number>();
  const footprint = new Set<string>();
  for (const panel of keptPanels) {
    for (const cell of panel.cells) footprint.add(columnKey(cell.x, cell.z));
    const owned = panel.cells.filter((cell) => owner.get(cellKey(cell)) === panel);
    if (owned.length === 0) continue;
    for (const cell of owned) claimed.add(cellKey(cell));
    const bounds = boundsOfCells(panel.cells);
    const cubeCells = owned.filter((cell) => cell.info.shape === 'cube').length;
    const confidence: Confidence =
      panel.heightCells >= 3 && panel.lengthCells >= 4 && cubeCells / owned.length >= 0.8 ? 'high' : 'medium';
    const draft: WallObject = {
      id: '',
      kind: 'wall',
      bounds,
      cells: owned.length,
      footprintCells: footprintOf(owned),
      materials: materialsOf(owned),
      samples: samplesOf(ctx.grid, owned),
      confidence,
      source: sourceOf(owned, ctx.callsById),
      clipped: clippedBounds(bounds, ctx.bounds),
      support: null,
      wall: {
        axis: panel.axis,
        plane: panel.plane,
        lengthCells: panel.lengthCells,
        heightCells: panel.heightCells,
      },
    };
    drafts.push(draft);
    bundles.push({ panel, draft });
    cellsByDraft.set(draft, owned);
  }
  return { drafts, claimed, footprint, bundles, cellsByDraft, eaveTrim: trimmed.trimmed, solidMass: false };
}

function panelCellSet(panel: Panel): Set<string> {
  const set = new Set<string>();
  for (const cell of panel.cells) set.add(panelEntryKey(panel.axis, cell));
  return set;
}

interface GapRect {
  readonly uMin: number;
  readonly uMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

function gapRect(gap: readonly (readonly [number, number])[]): GapRect {
  return {
    uMin: Math.min(...gap.map(([u]) => u)),
    uMax: Math.max(...gap.map(([u]) => u)),
    yMin: Math.min(...gap.map(([, y]) => y)),
    yMax: Math.max(...gap.map(([, y]) => y)),
  };
}

/**
 * 洞口套框：整块面板恰好是一圈 1 格厚的环（自己的缺口等于面板内缩一格），
 * 且外侧 1 格处有一块更大的同向墙板，其洞口包住这个环的缺口。
 * 只是“贴着墙的小面板”不够——真实 L 形 / 多段墙不会整块都是环。
 */
function isOpeningFramePanel(panel: Panel, panels: readonly Panel[]): boolean {
  // 至少 3×2；窗框通常是完整的环，门框允许底部敞开（没有门槛）。
  if (panel.lengthCells < 3 || panel.heightCells < 2) return false;
  const ownGaps = gapComponents(panel, panelCellSet(panel)).map(gapRect);
  for (const gap of ownGaps) {
    // 框宽 rim 可以大于 1；环必须左右对称、顶部同宽，窗框四面闭合，门框允许底部敞开。
    const rim = gap.uMin - panel.uMin;
    if (rim < 1 || gap.uMax !== panel.uMax - rim || gap.yMax !== panel.yMax - rim) continue;
    if (gap.yMin !== panel.yMin && gap.yMin !== panel.yMin + rim) continue;
    for (const host of panels) {
      if (host === panel || host.axis !== panel.axis) continue;
      if (Math.abs(host.plane - panel.plane) !== 1) continue;
      // 套框必须贴在一块向两侧都延伸的墙板上，而不是整面墙本身。
      if (!(host.uMin < panel.uMin && host.uMax > panel.uMax)) continue;
      if (!(host.yMin <= panel.yMin && host.yMax >= panel.yMax)) continue;
      const hostGaps = gapComponents(host, panelCellSet(host)).map(gapRect);
      if (
        hostGaps.some(
          (hostGap) =>
            hostGap.uMin <= gap.uMin &&
            hostGap.uMax >= gap.uMax &&
            hostGap.yMin <= gap.yMin &&
            hostGap.yMax >= gap.yMax,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function gapComponents(
  panel: Panel,
  panelCells: ReadonlySet<string>,
): readonly (readonly (readonly [number, number])[])[] {
  const missing = new Set<string>();
  for (let y = panel.yMin; y <= panel.yMax; y += 1) {
    for (let u = panel.uMin; u <= panel.uMax; u += 1) {
      const key = `${String(u)},${String(y)}`;
      if (!panelCells.has(key)) missing.add(key);
    }
  }
  const out: (readonly [number, number])[][] = [];
  for (let y = panel.yMin; y <= panel.yMax; y += 1) {
    for (let u = panel.uMin; u <= panel.uMax; u += 1) {
      const key = `${String(u)},${String(y)}`;
      if (!missing.has(key)) continue;
      missing.delete(key);
      const queue: [number, number][] = [[u, y]];
      const component: [number, number][] = [];
      for (const current of queue) {
        const [cu, cy] = current;
        component.push(current);
        for (const [du, dy] of DIRS4) {
          const nk = `${String(cu + du)},${String(cy + dy)}`;
          if (!missing.has(nk)) continue;
          missing.delete(nk);
          queue.push([cu + du, cy + dy]);
        }
      }
      component.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      out.push(component);
    }
  }
  return out;
}

function physicalOf(panel: Panel, u: number, y: number): readonly [number, number, number] {
  return panel.axis === 'x' ? [u, y, panel.plane] : [panel.plane, y, u];
}

function cellKeySetOfPanel(ctx: Context, panel: Panel): Set<number> {
  const keys = new Set<number>();
  for (const cell of panel.cells) keys.add(cellKeyOf(ctx, cell.x, cell.y, cell.z));
  return keys;
}

function boundaryWallCells(
  ctx: Context,
  volume: readonly (readonly [number, number, number])[],
): readonly IndexedCell[] {
  const boundary = new Map<number, IndexedCell>();
  for (const [x, y, z] of volume) {
    for (const [dx, dy, dz] of FACE6) {
      const neighbor = at(ctx, x + dx, y + dy, z + dz);
      if (neighbor === undefined) continue;
      boundary.set(cellKeyOf(ctx, neighbor.x, neighbor.y, neighbor.z), neighbor);
    }
  }
  return [...boundary.values()];
}

/**
 * first-cut §4.5.3：统计缺口边界上属于每个墙面板的墙格，取最多者；平局取最终 wall id 字典序最小。
 * 拐角缺口的一个拐角墙格会同时属于两侧面板，因此两侧都计一次。
 */
function chooseOpeningHost(
  ctx: Context,
  volume: readonly (readonly [number, number, number])[],
  bundles: readonly WallBundle[],
  panelKeys: ReadonlyMap<Panel, ReadonlySet<number>>,
  wallIds: ReadonlyMap<AsBuiltObject, string>,
): WallObject | undefined {
  const boundary = boundaryWallCells(ctx, volume);
  let best: WallObject | undefined;
  let bestScore = -1;
  let bestId = '';
  for (const bundle of bundles) {
    const keys = panelKeys.get(bundle.panel);
    if (keys === undefined) continue;
    let score = 0;
    for (const cell of boundary) {
      if (keys.has(cellKeyOf(ctx, cell.x, cell.y, cell.z))) score += 1;
    }
    if (score === 0) continue;
    const id = wallIds.get(bundle.draft) ?? '';
    if (best === undefined || score > bestScore || (score === bestScore && compareText(id, bestId) < 0)) {
      best = bundle.draft;
      bestScore = score;
      bestId = id;
    }
  }
  return best;
}

function detectOpenings(
  ctx: Context,
  bundles: readonly WallBundle[],
  wallIds: ReadonlyMap<AsBuiltObject, string>,
): OpeningResult & { readonly rejected: number } {
  const drafts: OpeningObject[] = [];
  const claimed = new Set<number>();
  const hostByDraft = new Map<OpeningObject, WallObject>();
  const cellsByDraft = new Map<OpeningObject, readonly IndexedCell[]>();
  const seenVolumes = new Set<string>();
  const panelKeys = new Map<Panel, ReadonlySet<number>>();
  for (const bundle of bundles) panelKeys.set(bundle.panel, cellKeySetOfPanel(ctx, bundle.panel));
  let rejected = 0;

  for (const { panel } of bundles) {
    const panelCells = panelCellSet(panel);
    const gaps = gapComponents(panel, panelCells);
    for (const gap of gaps) {
      const hasPanelAt = (u: number, y: number): boolean => panelCells.has(`${String(u)},${String(y)}`);
      const uMin = Math.min(...gap.map(([u]) => u));
      const uMax = Math.max(...gap.map(([u]) => u));
      const yMin = Math.min(...gap.map(([, y]) => y));
      const yMax = Math.max(...gap.map(([, y]) => y));
      const widthCells = uMax - uMin + 1;
      const heightCells = yMax - yMin + 1;

      let left = false;
      let right = false;
      let up = false;
      let down = false;
      for (const [u, y] of gap) {
        if (u === uMin && hasPanelAt(u - 1, y)) left = true;
        if (u === uMax && hasPanelAt(u + 1, y)) right = true;
        if (y === yMax && hasPanelAt(u, y + 1)) up = true;
        if (y === yMin && hasPanelAt(u, y - 1)) down = true;
      }
      const bottomUs = [...new Set(gap.filter(([, y]) => y === yMin).map(([u]) => u))];
      const topUs = [...new Set(gap.filter(([, y]) => y === yMax).map(([u]) => u))];
      const bottom = bottomUs.every((u) => {
        const [x, y, z] = physicalOf(panel, u, yMin - 1);
        return at(ctx, x, y, z) !== undefined;
      });
      const top = topUs.every((u) => {
        const [x, y, z] = physicalOf(panel, u, yMax + 1);
        return at(ctx, x, y, z) !== undefined;
      });
      const sides = (left ? 1 : 0) + (right ? 1 : 0) + (up ? 1 : 0) + (down ? 1 : 0);
      const lateral = left || right;
      const accepted =
        sides + (bottom ? 1 : 0) + (top ? 1 : 0) >= 3 &&
        lateral &&
        // 墙脚与室内同层楼板相接时，面板最低一行可能不是 wall candidate；
        // 允许与面板同高的缺口，只要左右/上下边界与面积比例仍成立。
        heightCells <= panel.heightCells &&
        widthCells < panel.lengthCells &&
        gap.length <= 0.5 * panel.area;
      if (!accepted) {
        rejected += 1;
        continue;
      }

      const volume = gap.map(([u, y]) => physicalOf(panel, u, y));
      const volumeKey = volume
        .map(([x, y, z]) => `${String(x)},${String(y)},${String(z)}`)
        .sort()
        .join(';');
      if (seenVolumes.has(volumeKey)) continue;
      seenVolumes.add(volumeKey);
      const fills: IndexedCell[] = [];
      for (const [x, y, z] of volume) {
        const cell = at(ctx, x, y, z);
        if (cell !== undefined) fills.push(cell);
      }
      fills.sort(compareCells);
      const hasDoor = fills.some((cell) => isDoorPanel(cell.info));
      const hasGlass = fills.some((cell) => isGlass(cell.info));
      let subtype: OpeningObject['opening']['subtype'];
      let fill: OpeningObject['opening']['fill'];
      let confidence: Confidence;
      if (hasDoor) {
        subtype = 'door';
        fill = 'door-panel';
        confidence = 'high';
      } else if (hasGlass) {
        subtype = 'window';
        fill = 'glass';
        confidence = 'high';
      } else if (fills.length === 0) {
        if (bottom && yMin <= ctx.groundBandTop) {
          subtype = 'passage';
          fill = 'air';
          confidence = 'high';
        } else {
          subtype = 'window';
          fill = 'air';
          confidence = 'medium';
        }
      } else {
        subtype = 'unknown';
        fill = 'solid';
        confidence = 'low';
      }

      const boundary: IndexedCell[] = [];
      const boundaryKeys = new Set<number>();
      for (const [u, y] of gap) {
        for (const [du, dy] of DIRS4) {
          const neighbor = panel.cells.find((cell) => panelU(panel.axis, cell) === u + du && cell.y === y + dy);
          if (neighbor === undefined) continue;
          const key = cellKeyOf(ctx, neighbor.x, neighbor.y, neighbor.z);
          if (boundaryKeys.has(key)) continue;
          boundaryKeys.add(key);
          boundary.push(neighbor);
        }
      }
      boundary.sort(compareCells);
      const samples = fills.length > 0 ? samplesOf(ctx.grid, fills) : samplesOf(ctx.grid, boundary.slice(0, 4));
      const openingBounds = boundsOfPoints(volume);
      const chosenHost = chooseOpeningHost(ctx, volume, bundles, panelKeys, wallIds);
      const draft: OpeningObject = {
        id: '',
        kind: 'opening',
        bounds: openingBounds,
        cells: fills.length,
        footprintCells: footprintOf(fills),
        materials: materialsOf(fills),
        samples,
        confidence,
        source: sourceOf(fills, ctx.callsById),
        clipped: clippedBounds(openingBounds, ctx.bounds),
        support: { state: 'unknown' },
        host: '',
        opening: {
          subtype,
          fill,
          widthCells,
          heightCells,
          depthCells: 1,
          voidCells: volume.length - fills.length,
          fillCells: fills.length,
          sillY: yMin,
          headY: yMax + 1,
        },
      };
      drafts.push(draft);
      if (chosenHost !== undefined) hostByDraft.set(draft, chosenHost);
      cellsByDraft.set(draft, fills);
      for (const cell of fills) claimed.add(cellKeyOf(ctx, cell.x, cell.y, cell.z));
    }
  }
  return { drafts, claimed, hostByDraft, cellsByDraft, rejected };
}

function horizontalCandidate(cell: IndexedCell): boolean {
  const info = cell.info;
  const groundLikePlant = info.shape === 'plant' && !info.transparent;
  return (
    (info.shape === 'cube' || info.shape === 'slab' || groundLikePlant) &&
    !isFurnitureToken(info) &&
    !isLight(info) &&
    !isChain(info) &&
    !isDoorPanel(info) &&
    !isGlass(info) &&
    !isPlantLike(info) &&
    !isThinDecor(info)
  );
}

function horizontalRatio(ctx: Context, group: readonly IndexedCell[]): number {
  const keys = new Set(group.map((cell) => cellKeyOf(ctx, cell.x, cell.y, cell.z)));
  let horizontal = 0;
  for (const cell of group) {
    let neighbors = 0;
    for (const [dx, dz] of DIRS4) {
      const key = cellKeyOf(ctx, cell.x + dx, cell.y, cell.z + dz);
      if (keys.has(key)) neighbors += 1;
    }
    if (neighbors >= 2) horizontal += 1;
  }
  return group.length === 0 ? 0 : horizontal / group.length;
}

function isSmallTopShape(cell: IndexedCell): boolean {
  return cell.info.shape === 'slab' || cell.info.shape === 'pressure_plate';
}

function hasWallSupportBelow(ctx: Context, cells: readonly IndexedCell[], wallCells: ReadonlySet<number>): boolean {
  return cells.some((cell) => wallCells.has(cellKeyOf(ctx, cell.x, cell.y - 1, cell.z)));
}

/**
 * 抬高的小而薄水平面（桌面/台面残留）不能与下方 floor 合并：
 * 只有当它位于更大下层水平面之上、面积 <= 16、且没有直接墙/柱支撑时，才拆出顶层。
 * 拆出的格不认领，后续按 unknown 保留；面积 > 16 的平台仍按 slab/site 规则处理。
 */
function detachRaisedSmallTop(
  ctx: Context,
  group: readonly IndexedCell[],
  wallCells: ReadonlySet<number>,
): { readonly base: readonly IndexedCell[]; readonly detached: readonly IndexedCell[] } {
  if (group.length === 0) return { base: group, detached: [] };
  const maxY = Math.max(...group.map((cell) => cell.y));
  const top = group.filter((cell) => cell.y === maxY);
  const base = group.filter((cell) => cell.y < maxY);
  if (base.length === 0 || top.length === 0) return { base: group, detached: [] };
  const topArea = footprintOf(top);
  if (topArea > MAX_SMALL_TOP_AREA) return { base: group, detached: [] };
  if (!top.every((cell) => isSmallTopShape(cell))) return { base: group, detached: [] };
  if (hasWallSupportBelow(ctx, top, wallCells)) return { base: group, detached: [] };
  if (footprintOf(base) <= topArea) return { base: group, detached: [] };

  // “薄”指抬高面本身只有 1 格厚：以顶层下方、顶层列之外的较大水平面为基准。
  // 2 层以上的抬高体（实体基座/厚平台）不拆，仍按 slab/site 处理。
  const topColumns = new Set(top.map((cell) => columnKey(cell.x, cell.z)));
  const surrounding = base.filter((cell) => !topColumns.has(columnKey(cell.x, cell.z)));
  if (surrounding.length === 0) return { base: group, detached: [] };
  const surroundingTop = Math.max(...surrounding.map((cell) => cell.y));
  if (maxY - surroundingTop !== 1) return { base: group, detached: [] };
  if (!top.every((cell) => at(ctx, cell.x, cell.y + 1, cell.z) === undefined)) return { base: group, detached: [] };
  return { base, detached: top };
}

function isRaisedSmallTop(ctx: Context, group: readonly IndexedCell[], wallCells: ReadonlySet<number>): boolean {
  if (group.length === 0) return false;
  const extent = extentOfCells(group);
  const area = footprintOf(group);
  if (area > MAX_SMALL_TOP_AREA || extent.minY <= ctx.minY) return false;
  if (extent.maxY > extent.minY) return false;
  if (!group.some((cell) => isSmallTopShape(cell))) return false;
  return !hasWallSupportBelow(ctx, group, wallCells);
}

/**
 * 只保留同一 y 层内面积 >=4 的 4-连通块。单格 / 细杆（柱、灯杆）会附着在楼板上，
 * 6-连通分组时把楼板撑成多层体量；按层先看水平连通块可把它们排除。
 * 水平面本身的最小面积门槛与 slab 的 `areaCells >= 4` 一致。
 */
function horizontalCoreCells(ctx: Context, cells: readonly IndexedCell[], minArea = 4): readonly IndexedCell[] {
  const byY = new Map<number, IndexedCell[]>();
  for (const cell of cells) {
    const list = byY.get(cell.y);
    if (list === undefined) byY.set(cell.y, [cell]);
    else list.push(cell);
  }
  const keep = new Set<number>();
  for (const layer of byY.values()) {
    const keys = new Set(layer.map((cell) => cellKeyOf(ctx, cell.x, cell.y, cell.z)));
    for (const component of componentsOf(ctx, layer, keys)) {
      if (component.length < minArea) continue;
      for (const cell of component) keep.add(cellKeyOf(ctx, cell.x, cell.y, cell.z));
    }
  }
  return cells.filter((cell) => keep.has(cellKeyOf(ctx, cell.x, cell.y, cell.z)));
}

function detectHorizontals(
  ctx: Context,
  claimedBefore: ReadonlySet<number>,
  excluded: ReadonlySet<number>,
  openings: readonly OpeningObject[],
  buildingFootprint: ReadonlySet<string>,
  wallCells: ReadonlySet<number>,
  floorTop: number | null,
): HorizontalResult {
  const eligible: IndexedCell[] = [];
  const allowed = new Set<number>();
  for (const cell of ctx.cells) {
    const key = cellKeyOf(ctx, cell.x, cell.y, cell.z);
    if (claimedBefore.has(key) || excluded.has(key) || !horizontalCandidate(cell)) continue;
    eligible.push(cell);
    allowed.add(key);
  }

  const openingColumns = new Set<string>();
  for (const opening of openings) {
    for (let x = opening.bounds.min[0]; x < opening.bounds.max[0]; x += 1) {
      for (let z = opening.bounds.min[2]; z < opening.bounds.max[2]; z += 1) {
        openingColumns.add(columnKey(x, z));
      }
    }
  }
  const nearOpening = (x: number, z: number): boolean => {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        if (openingColumns.has(columnKey(x + dx, z + dz))) return true;
      }
    }
    return false;
  };
  const hasBuildingColumn = (cell: IndexedCell): boolean => buildingFootprint.has(columnKey(cell.x, cell.z));

  const drafts: (SlabObject | SiteObject)[] = [];
  const claimed = new Set<number>();
  const cellsByDraft = new Map<SlabObject | SiteObject, readonly IndexedCell[]>();
  for (const component of componentsOf(ctx, eligible, allowed)) {
    const insideCells = component.filter((cell) => hasBuildingColumn(cell));
    const outsideCells = component.filter((cell) => !hasBuildingColumn(cell));
    // 室内的“站立面层”才是楼板：低于 floorTop 的是地形 / 垫层（v2 场地降到 y−1 时
    // 室内草地也会落在这里）；再剔掉同层面积 <4 的竖向构件（柱 / 灯杆），
    // 否则它们会把整块楼板连成 5–6 格厚的体量。室外仍按场地规则处理。
    const belowFloor = floorTop === null ? [] : insideCells.filter((cell) => cell.y < floorTop);
    const slabCells = floorTop === null ? insideCells : insideCells.filter((cell) => cell.y >= floorTop);
    // 楼面以下的室内地形仍是场地（只是被建筑盖住），和室外地面一起按 site 处理；
    // 这样不会在楼板下面留出一整层 unknown。
    const terrainCells = [...outsideCells, ...belowFloor];
    const groups: { readonly group: readonly IndexedCell[]; readonly isInsideGroup: boolean }[] = [
      ...subComponents(ctx, horizontalCoreCells(ctx, slabCells)).map((group) => ({ group, isInsideGroup: true })),
      ...subComponents(ctx, terrainCells).map((group) => ({ group, isInsideGroup: false })),
    ];
    for (const { group, isInsideGroup } of groups) {
      const split = detachRaisedSmallTop(ctx, group, wallCells);
      for (const part of subComponents(ctx, split.base)) {
        if (isInsideGroup) {
          const extent = extentOfCells(part);
          const thicknessCells = extent.maxY - extent.minY + 1;
          const areaCells = footprintOf(part);
          if (
            thicknessCells <= 3 &&
            horizontalRatio(ctx, part) >= 0.7 &&
            areaCells >= 4 &&
            !isRaisedSmallTop(ctx, part, wallCells)
          ) {
            const bounds = boundsOfCells(part);
            const confidence: Confidence = areaCells >= 6 && thicknessCells <= 2 ? 'high' : 'medium';
            const draft: SlabObject = {
              id: '',
              kind: 'slab',
              bounds,
              cells: part.length,
              footprintCells: areaCells,
              materials: materialsOf(part),
              samples: samplesOf(ctx.grid, part),
              confidence,
              source: sourceOf(part, ctx.callsById),
              clipped: clippedBounds(bounds, ctx.bounds),
              support: null,
              slab: {
                topY: extent.maxY,
                bottomY: extent.minY,
                thicknessCells,
                areaCells,
              },
            };
            drafts.push(draft);
            cellsByDraft.set(draft, part);
            for (const cell of part) claimed.add(cellKeyOf(ctx, cell.x, cell.y, cell.z));
          }
        } else {
          const extent = extentOfCells(part);
          const areaCells = footprintOf(part);
          if (extent.maxY <= ctx.groundBandTop + 1 && areaCells >= 1 && !isRaisedSmallTop(ctx, part, wallCells)) {
            let subtype: SiteObject['site']['subtype'] = 'other';
            if (part.some((cell) => nearOpening(cell.x, cell.z))) subtype = 'pad';
            else if (areaCells >= 8 && extent.maxY <= ctx.groundBandTop) subtype = 'ground';
            const bounds = boundsOfCells(part);
            const confidence: Confidence = areaCells >= 8 ? 'high' : 'medium';
            const draft: SiteObject = {
              id: '',
              kind: 'site',
              bounds,
              cells: part.length,
              footprintCells: areaCells,
              materials: materialsOf(part),
              samples: samplesOf(ctx.grid, part),
              confidence,
              source: sourceOf(part, ctx.callsById),
              clipped: clippedBounds(bounds, ctx.bounds),
              support: null,
              site: { subtype, topY: extent.maxY, areaCells },
            };
            drafts.push(draft);
            cellsByDraft.set(draft, part);
            for (const cell of part) claimed.add(cellKeyOf(ctx, cell.x, cell.y, cell.z));
          }
        }
      }
    }
  }
  return { drafts, claimed, cellsByDraft };
}

function subComponents(ctx: Context, cells: readonly IndexedCell[]): readonly (readonly IndexedCell[])[] {
  if (cells.length === 0) return [];
  const allowed = new Set(cells.map((cell) => cellKeyOf(ctx, cell.x, cell.y, cell.z)));
  return componentsOf(ctx, cells, allowed);
}

/**
 * 建筑内实际站立面的最高格 y：在墙脚以下、围合 footprint 内，统计未被墙/屋面/洞口认领的
 * 水平可站格；取覆盖列数最多的一层，平局取更高层（草地 + 室内地板同面积时，地板是站立面）。
 * 只用于区分“地面上的家具”和“地面本身 / 楼板 / 抬高平台”，不写入对象图。
 */
function standingFloorTop(
  ctx: Context,
  claimedBefore: ReadonlySet<number>,
  excluded: ReadonlySet<number>,
  enclosed: ReadonlySet<string>,
  wallFootprint: ReadonlySet<string>,
  wallBaseY: number,
): number | null {
  const counts = new Map<number, number>();
  // 同层是否只由薄台面形状（slab / pressure_plate）组成；平局时优先实体方块层，
  // 避免把盖满室内的小台面当成站立楼板。
  const smallTopOnly = new Map<number, boolean>();
  for (const cell of ctx.cells) {
    if (cell.y > wallBaseY) continue;
    const key = cellKeyOf(ctx, cell.x, cell.y, cell.z);
    if (claimedBefore.has(key) || excluded.has(key)) continue;
    const column = columnKey(cell.x, cell.z);
    if (!enclosed.has(column) || wallFootprint.has(column)) continue;
    if (!horizontalCandidate(cell)) continue;
    counts.set(cell.y, (counts.get(cell.y) ?? 0) + 1);
    if (!isSmallTopShape(cell)) smallTopOnly.set(cell.y, false);
    else if (!smallTopOnly.has(cell.y)) smallTopOnly.set(cell.y, true);
  }
  let bestY: number | null = null;
  let bestCount = 0;
  for (const [y, count] of counts) {
    if (count > bestCount) {
      bestY = y;
      bestCount = count;
      continue;
    }
    if (count !== bestCount || bestY === null) continue;
    const ySmall = smallTopOnly.get(y) ?? false;
    const bestSmall = smallTopOnly.get(bestY) ?? false;
    if (ySmall !== bestSmall) {
      if (bestSmall && !ySmall) bestY = y;
    } else if (y > bestY) {
      bestY = y;
    }
  }
  return bestY;
}

function touchesBlockedCells(ctx: Context, component: readonly IndexedCell[], blocked: ReadonlySet<number>): boolean {
  for (const cell of component) {
    for (const [dx, dy, dz] of FACE6) {
      if (blocked.has(cellKeyOf(ctx, cell.x + dx, cell.y + dy, cell.z + dz))) return true;
    }
  }
  return false;
}

/** 长条、单格进深、<=2 格高的体量按 0.8 格/座换算；其余为 null。 */
function seatCapacityOfComponent(extent: Extent, heightCells: number): number | null {
  if (heightCells > 2) return null;
  const spanX = extent.maxX - extent.minX + 1;
  const spanZ = extent.maxZ - extent.minZ + 1;
  const longest = Math.max(spanX, spanZ);
  const shortest = Math.min(spanX, spanZ);
  if (shortest !== 1 || longest < 3) return null;
  return Math.floor((longest * 10) / SEAT_PITCH_TENTHS);
}

/**
 * 通用家具：墙 / 屋面 / 洞口认领之后、水平面认领之前，收集室内站立面上方、尚未认领的
 * 结构实心格与光源，按 6-连通分组。只接受底面正好在地面顶上一层、面积 <= 15、高 <= 3、
 * 且不接触墙/屋面认领格的体量；否则留给 slab / unknown，避免吞掉墙脚、平台和屋面。
 *
 * 子类型只区分 light 与 other：几何上不猜 table / counter / bench，座位数只按长条体量换算。
 */
function genericFurnitureSubtype(extent: Extent, heightCells: number): FurnitureObject['furniture']['subtype'] {
  if (heightCells > 2) return 'other';
  const width = extent.maxX - extent.minX + 1;
  const depth = extent.maxZ - extent.minZ + 1;
  const long = Math.max(width, depth);
  const short = Math.min(width, depth);
  if (short >= 2 && long >= 3) return 'table';
  if (short === 1 && long >= 3) return 'bench';
  if (short === 1 && long === 2) return 'counter';
  return 'other';
}

function detectGenericFurniture(
  ctx: Context,
  claimedBefore: ReadonlySet<number>,
  excluded: ReadonlySet<number>,
  enclosed: ReadonlySet<string>,
  wallFootprint: ReadonlySet<string>,
  roofClaimed: ReadonlySet<number>,
  floorTop: number | null,
  mode: 'structural' | 'light',
): FurnitureResult {
  const empty: FurnitureResult = {
    drafts: [],
    claimed: new Set<number>(),
    cellsByDraft: new Map<FurnitureObject, readonly IndexedCell[]>(),
  };
  if (floorTop === null) return empty;

  const seeds: IndexedCell[] = [];
  for (const cell of ctx.cells) {
    if (cell.y <= floorTop) continue;
    const key = cellKeyOf(ctx, cell.x, cell.y, cell.z);
    if (claimedBefore.has(key) || excluded.has(key)) continue;
    const column = columnKey(cell.x, cell.z);
    if (!enclosed.has(column) || wallFootprint.has(column)) continue;
    if (isFurnitureToken(cell.info)) continue;
    const light = isLight(cell.info);
    // 光源与实体家具分开分组：贴墙吊灯不会和长凳合成一个体量。
    if (mode === 'light' ? !light : light || !isStructuralCell(cell.info)) continue;
    seeds.push(cell);
  }

  // 家具贴墙是正常摆放；实体家具只把屋面认领格当作禁区。吊灯可以贴顶，不设禁区。
  const blocked = mode === 'light' ? new Set<number>() : new Set<number>(roofClaimed);
  // 实体家具上方常有 1×1 立柱 / 灯杆穿过桌面；6-连通会把它们并进家具体量，
  // 让原本 1 格高的桌子变成 4 格高而漏检。先按层去掉 1×1 竖杆（保留 1×2 的柜台面）。
  const furnitureSeeds = mode === 'structural' ? horizontalCoreCells(ctx, seeds, 2) : seeds;
  const furnitureKeys = new Set(furnitureSeeds.map((cell) => cellKeyOf(ctx, cell.x, cell.y, cell.z)));
  const drafts: FurnitureObject[] = [];
  const claimed = new Set<number>();
  const cellsByDraft = new Map<FurnitureObject, readonly IndexedCell[]>();
  for (const component of componentsOf(ctx, furnitureSeeds, furnitureKeys)) {
    const extent = extentOfCells(component);
    // 家具必须落在站立面上；悬空吊灯仍留给 unknown（避免改变 run-9 冻结对象图）。
    if (extent.minY !== floorTop + 1) continue;
    const heightCells = extent.maxY - extent.minY + 1;
    if (heightCells > MAX_GENERIC_FURNITURE_HEIGHT) continue;
    if (footprintOf(component) > MAX_GENERIC_FURNITURE_AREA) continue;
    if (touchesBlockedCells(ctx, component, blocked)) continue;
    if (mode === 'structural') {
      const bottom = component.filter((cell) => cell.y === extent.minY);
      const supported = bottom.every((cell) => {
        const below = at(ctx, cell.x, cell.y - 1, cell.z);
        if (below === undefined) return false;
        return !blocked.has(cellKeyOf(ctx, below.x, below.y, below.z));
      });
      if (!supported) continue;
    }

    const subtype: FurnitureObject['furniture']['subtype'] = component.every((cell) => isLight(cell.info))
      ? 'light'
      : genericFurnitureSubtype(extent, heightCells);
    const bounds = boundsOfCells(component);
    const confidence: Confidence = component.length >= 2 ? 'high' : 'medium';
    const draft: FurnitureObject = {
      id: '',
      kind: 'furniture',
      bounds,
      cells: component.length,
      footprintCells: footprintOf(component),
      materials: materialsOf(component),
      samples: samplesOf(ctx.grid, component),
      confidence,
      source: sourceOf(component, ctx.callsById),
      clipped: clippedBounds(bounds, ctx.bounds),
      support: null,
      furniture: {
        subtype,
        seatCapacity: subtype === 'bench' ? seatCapacityOfComponent(extent, heightCells) : null,
        heightCells,
      },
    };
    drafts.push(draft);
    cellsByDraft.set(draft, component);
    for (const cell of component) claimed.add(cellKeyOf(ctx, cell.x, cell.y, cell.z));
  }
  return { drafts, claimed, cellsByDraft };
}

function detectFurniture(ctx: Context, claimedBefore: ReadonlySet<number>): FurnitureResult {
  const remaining = ctx.cells.filter((cell) => !claimedBefore.has(cellKeyOf(ctx, cell.x, cell.y, cell.z)));
  const drafts: FurnitureObject[] = [];
  const claimed = new Set<number>();
  const cellsByDraft = new Map<FurnitureObject, readonly IndexedCell[]>();
  for (const subtype of ['bed', 'storage', 'shelf'] as const) {
    const subset = remaining.filter((cell) => furnitureSubtype(cell.info.id) === subtype);
    const visited = new Set<number>();
    for (const seed of subset) {
      const seedKey = cellKeyOf(ctx, seed.x, seed.y, seed.z);
      if (visited.has(seedKey)) continue;
      visited.add(seedKey);
      const queue: IndexedCell[] = [seed];
      const component: IndexedCell[] = [];
      for (const current of queue) {
        component.push(current);
        for (const [dx, dy, dz] of FACE6) {
          const neighbor = at(ctx, current.x + dx, current.y + dy, current.z + dz);
          if (neighbor === undefined) continue;
          if (furnitureSubtype(neighbor.info.id) !== subtype) continue;
          if (subtype === 'bed' && (neighbor.y !== current.y || neighbor.state.name !== current.state.name)) continue;
          const key = cellKeyOf(ctx, neighbor.x, neighbor.y, neighbor.z);
          if (visited.has(key) || claimedBefore.has(key)) continue;
          visited.add(key);
          queue.push(neighbor);
        }
      }
      component.sort(compareCells);
      const bounds = boundsOfCells(component);
      const confidence: Confidence = component.length >= 2 ? 'high' : 'medium';
      const draft: FurnitureObject = {
        id: '',
        kind: 'furniture',
        bounds,
        cells: component.length,
        footprintCells: footprintOf(component),
        materials: materialsOf(component),
        samples: samplesOf(ctx.grid, component),
        confidence,
        source: sourceOf(component, ctx.callsById),
        clipped: clippedBounds(bounds, ctx.bounds),
        support: null,
        furniture: {
          subtype,
          seatCapacity: null,
          heightCells: bounds.max[1] - bounds.min[1],
        },
      };
      drafts.push(draft);
      cellsByDraft.set(draft, component);
      for (const cell of component) claimed.add(cellKeyOf(ctx, cell.x, cell.y, cell.z));
    }
  }
  return { drafts, claimed, cellsByDraft };
}

function detectUnknown(ctx: Context, claimedBefore: ReadonlySet<number>): UnknownResult {
  const remaining = ctx.cells.filter((cell) => !claimedBefore.has(cellKeyOf(ctx, cell.x, cell.y, cell.z)));
  const allowed = new Set(remaining.map((cell) => cellKeyOf(ctx, cell.x, cell.y, cell.z)));
  const drafts: UnknownObject[] = [];
  let ambiguousComponents = 0;
  const cellsByDraft = new Map<UnknownObject, readonly IndexedCell[]>();
  for (const component of componentsOf(ctx, remaining, allowed)) {
    const allFill = component.every((cell) => isGlass(cell.info) || isDoorPanel(cell.info));
    const structural = component.some((cell) => isStructuralCell(cell.info));
    const reason: UnknownObject['unknown']['reason'] = allFill
      ? 'isolated-fill'
      : structural
        ? 'ambiguous-geometry'
        : 'no-rule-match';
    if (reason === 'ambiguous-geometry') ambiguousComponents += 1;
    const bounds = boundsOfCells(component);
    const draft: UnknownObject = {
      id: '',
      kind: 'unknown',
      bounds,
      cells: component.length,
      footprintCells: footprintOf(component),
      materials: materialsOf(component),
      samples: samplesOf(ctx.grid, component),
      confidence: 'low',
      source: sourceOf(component, ctx.callsById),
      clipped: clippedBounds(bounds, ctx.bounds),
      support: null,
      unknown: { reason },
    };
    drafts.push(draft);
    cellsByDraft.set(draft, component);
  }
  return { drafts, ambiguousComponents, cellsByDraft };
}

function assignIds(objects: readonly AsBuiltObject[]): ReadonlyMap<AsBuiltObject, string> {
  const groups = new Map<string, AsBuiltObject[]>();
  for (const object of objects) {
    const base = `${object.kind}@${String(object.bounds.min[0])},${String(object.bounds.min[1])},${String(object.bounds.min[2])}`;
    const group = groups.get(base);
    if (group === undefined) groups.set(base, [object]);
    else group.push(object);
  }
  const ids = new Map<AsBuiltObject, string>();
  for (const [base, group] of groups) {
    const sorted = [...group].sort(
      (a, b) =>
        a.bounds.max[0] - b.bounds.max[0] ||
        a.bounds.max[1] - b.bounds.max[1] ||
        a.bounds.max[2] - b.bounds.max[2] ||
        a.cells - b.cells ||
        compareText(materialsKey(a), materialsKey(b)) ||
        compareText(JSON.stringify(a), JSON.stringify(b)),
    );
    sorted.forEach((object, index) => {
      ids.set(object, index === 0 ? base : `${base}~${String(index + 1)}`);
    });
  }
  return ids;
}

function materialsKey(object: AsBuiltObject): string {
  return object.materials.map((item) => `${item.block}:${String(item.cells)}`).join('|');
}

function supportFor(
  object: AsBuiltObject,
  ctx: Context,
  cellLists: ReadonlyMap<AsBuiltObject, readonly IndexedCell[]>,
  cellOwner: ReadonlyMap<number, AsBuiltObject>,
  ids: ReadonlyMap<AsBuiltObject, string>,
): AsBuiltSupport | null {
  if (object.kind === 'opening') return { state: 'unknown' };
  if (object.kind === 'site' || object.kind === 'unknown') return null;
  const cells = cellLists.get(object) ?? [];
  if (cells.length === 0) return { state: 'unknown' };
  const bottomY = object.bounds.min[1];
  const bottomCells = cells.filter((cell) => cell.y === bottomY);
  const belowIds = new Set<string>();
  const belowKinds = new Set<ObjectKind>();
  let hasSolidBelow = false;
  for (const cell of bottomCells) {
    const below = at(ctx, cell.x, cell.y - 1, cell.z);
    if (below !== undefined) hasSolidBelow = true;
    const owner = cellOwner.get(cellKeyOf(ctx, cell.x, cell.y - 1, cell.z));
    if (owner === undefined) continue;
    const id = ids.get(owner);
    if (id !== undefined) belowIds.add(id);
    belowKinds.add(owner.kind);
  }
  const supportedBy = [...belowIds].sort(compareText);

  let state: AsBuiltSupport['state'];
  if (object.kind === 'wall') {
    if (bottomY <= ctx.groundBandTop || belowKinds.has('slab') || belowKinds.has('site')) state = 'grounded';
    else if (hasSolidBelow) state = 'supported';
    else state = 'unsupported';
  } else if (object.kind === 'slab') {
    if (bottomY <= ctx.groundBandTop || belowKinds.has('site')) state = 'grounded';
    else if (hasSolidBelow) state = 'supported';
    else state = 'unsupported';
  } else if (object.kind === 'roof') {
    state = belowKinds.has('wall') ? 'supported' : 'unsupported';
  } else {
    if (bottomY <= ctx.groundBandTop || belowKinds.has('slab') || belowKinds.has('site')) state = 'grounded';
    else {
      let wallBeside = false;
      for (const cell of cells) {
        for (const [dx, dz] of DIRS4) {
          const owner = cellOwner.get(cellKeyOf(ctx, cell.x + dx, cell.y, cell.z + dz));
          if (owner?.kind === 'wall') {
            wallBeside = true;
            break;
          }
        }
        if (wallBeside) break;
      }
      state = wallBeside ? 'supported' : 'unsupported';
    }
  }
  return supportedBy.length === 0 ? { state } : { state, supportedBy };
}

function compareObjects(a: AsBuiltObject, b: AsBuiltObject): number {
  return (
    (KIND_INDEX.get(a.kind) ?? 0) - (KIND_INDEX.get(b.kind) ?? 0) ||
    a.bounds.min[1] - b.bounds.min[1] ||
    a.bounds.min[2] - b.bounds.min[2] ||
    a.bounds.min[0] - b.bounds.min[0] ||
    a.bounds.max[0] - b.bounds.max[0] ||
    a.bounds.max[1] - b.bounds.max[1] ||
    a.bounds.max[2] - b.bounds.max[2] ||
    compareText(a.id, b.id)
  );
}

function emptyGraph(): AsBuiltObjectGraph {
  const objectCounts = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<ObjectKind, number>;
  const confidenceCounts = Object.fromEntries(CONFIDENCES.map((confidence) => [confidence, 0])) as Record<
    Confidence,
    number
  >;
  return {
    schemaVersion: AS_BUILT_SCHEMA_VERSION,
    bounds: null,
    measurement: {
      unit: 'voxel-cell',
      boundsConvention: 'half-open [min,max)',
      coordinateSystem: 'x-east, y-up, z-south',
      toleranceCells: 0,
    },
    objects: [],
    summary: { totalCells: 0, assignedCells: 0, unknownCells: 0, objectCounts, confidenceCounts },
    coverage: { totalCells: 0, assignedCells: 0, unknownCells: 0, assignedRatio: null },
    diagnostics: [],
  };
}

function coverageFailure(message: string): never {
  throw new AsBuiltError('coverage-invariant', message);
}

/**
 * 从最终体素网格提取通用 as-built 对象图。
 *
 * - 纯函数：不读文件、不联网、不用 `process` / `fs` / Node 内置。
 * - `bounds` 为半开 `[min,max)`；空网格返回 `objects=[]`、`bounds=null`、`assignedRatio=null`。
 * - coverage 不成立时抛 {@link AsBuiltError}，不返回半张图。
 */
export function extractAsBuiltObjects(grid: Grid, registry: BlockRegistry): AsBuiltObjectGraph {
  const indexed = indexGrid(grid, registry);
  if (indexed === undefined) return emptyGraph();
  const ctx = indexed;

  const emptyRoofs: RoofResult = {
    drafts: [],
    claimed: new Set<number>(),
    footprint: new Set<string>(),
    cellsByDraft: new Map(),
  };
  const emptyOpenings: OpeningResult & { readonly rejected: number } = {
    drafts: [],
    claimed: new Set<number>(),
    hostByDraft: new Map(),
    cellsByDraft: new Map(),
    rejected: 0,
  };
  const emptyHorizontals: HorizontalResult = {
    drafts: [],
    claimed: new Set<number>(),
    cellsByDraft: new Map(),
  };
  const emptyFurniture: FurnitureResult = {
    drafts: [],
    claimed: new Set<number>(),
    cellsByDraft: new Map(),
  };

  const detectedRoofs = detectRoofs(ctx);
  const walls = detectWalls(ctx, detectedRoofs.claimed);
  const solidMass = walls.solidMass;
  const roofs = solidMass ? emptyRoofs : detectedRoofs;
  const wallIds = assignIds(walls.drafts);
  const openings = solidMass ? emptyOpenings : detectOpenings(ctx, walls.bundles, wallIds);
  // 室内外分界以墙体围合为准；屋面挑檐不是建筑室内边界，否则檐下草地/碎石会被并入楼板。
  const enclosed = solidMass
    ? new Set<string>()
    : enclosedFootprint(
        ctx,
        walls.bundles.map((bundle) => bundle.panel),
      );
  const hasInterior = enclosed.size > walls.footprint.size;
  const buildingFootprint = hasInterior ? enclosed : new Set<string>([...walls.footprint, ...roofs.footprint]);

  const claimed = new Set<number>([...roofs.claimed, ...walls.claimed, ...openings.claimed]);
  const wallBaseY = walls.drafts.reduce((min, wall) => Math.min(min, wall.bounds.min[1]), Infinity);
  // 站立面只算一次：家具与楼板共用同一层带。低于该层的是地形 / 垫层，不是室内楼板。
  const floorTop =
    solidMass || !hasInterior || !Number.isFinite(wallBaseY)
      ? null
      : standingFloorTop(ctx, claimed, walls.eaveTrim, enclosed, walls.footprint, wallBaseY);
  // 通用家具必须先于 horizontals：否则贴地桌面/长凳会被 floor slab 合并。
  const genericStructural =
    floorTop === null
      ? emptyFurniture
      : detectGenericFurniture(
          ctx,
          claimed,
          walls.eaveTrim,
          enclosed,
          walls.footprint,
          roofs.claimed,
          floorTop,
          'structural',
        );
  for (const key of genericStructural.claimed) claimed.add(key);
  const genericLights =
    floorTop === null
      ? emptyFurniture
      : detectGenericFurniture(
          ctx,
          claimed,
          walls.eaveTrim,
          enclosed,
          walls.footprint,
          roofs.claimed,
          floorTop,
          'light',
        );
  for (const key of genericLights.claimed) claimed.add(key);
  const genericFurniture: FurnitureResult = {
    drafts: [...genericStructural.drafts, ...genericLights.drafts],
    claimed: new Set<number>([...genericStructural.claimed, ...genericLights.claimed]),
    cellsByDraft: new Map([...genericStructural.cellsByDraft, ...genericLights.cellsByDraft]),
  };
  const horizontals = solidMass
    ? emptyHorizontals
    : detectHorizontals(ctx, claimed, walls.eaveTrim, openings.drafts, buildingFootprint, walls.claimed, floorTop);
  for (const key of horizontals.claimed) claimed.add(key);
  const tokenFurniture = solidMass ? emptyFurniture : detectFurniture(ctx, claimed);
  for (const key of tokenFurniture.claimed) claimed.add(key);
  const furniture: FurnitureResult = {
    drafts: [...genericFurniture.drafts, ...tokenFurniture.drafts],
    claimed: new Set<number>([...genericFurniture.claimed, ...tokenFurniture.claimed]),
    cellsByDraft: new Map([...genericFurniture.cellsByDraft, ...tokenFurniture.cellsByDraft]),
  };
  const unknowns = detectUnknown(ctx, claimed);

  const drafts: AsBuiltObject[] = [
    ...walls.drafts,
    ...horizontals.drafts.filter((object): object is SlabObject => object.kind === 'slab'),
    ...roofs.drafts,
    ...openings.drafts,
    ...horizontals.drafts.filter((object): object is SiteObject => object.kind === 'site'),
    ...furniture.drafts,
    ...unknowns.drafts,
  ];
  const idByObject = assignIds(drafts);

  const cellLists = new Map<AsBuiltObject, readonly IndexedCell[]>();
  for (const [object, cells] of roofs.cellsByDraft) cellLists.set(object, cells);
  for (const [object, cells] of walls.cellsByDraft) cellLists.set(object, cells);
  for (const [object, cells] of openings.cellsByDraft) cellLists.set(object, cells);
  for (const [object, cells] of horizontals.cellsByDraft) cellLists.set(object, cells);
  for (const [object, cells] of furniture.cellsByDraft) cellLists.set(object, cells);
  for (const [object, cells] of unknowns.cellsByDraft) cellLists.set(object, cells);

  const cellOwner = new Map<number, AsBuiltObject>();
  for (const object of drafts) {
    if (object.kind === 'opening' || object.kind === 'unknown') continue;
    for (const cell of cellLists.get(object) ?? []) {
      cellOwner.set(cellKeyOf(ctx, cell.x, cell.y, cell.z), object);
    }
  }

  const objects = drafts.map((draft) => {
    const id = idByObject.get(draft) ?? '';
    const support = supportFor(draft, ctx, cellLists, cellOwner, idByObject);
    if (draft.kind === 'opening') {
      const host = openings.hostByDraft.get(draft);
      const hostId = host === undefined ? null : (idByObject.get(host) ?? null);
      return { ...draft, id, host: hostId, support };
    }
    return { ...draft, id, support };
  });

  const unknownCells = unknowns.drafts.reduce((sum, object) => sum + object.cells, 0);
  const assignedCells = ctx.grid.size - unknownCells;
  const objectCells = objects.reduce((sum, object) => sum + object.cells, 0);
  const cellsById = new Map<string, readonly IndexedCell[]>();
  drafts.forEach((draft, index) => {
    const object = objects[index];
    if (object === undefined) return;
    cellsById.set(object.id, cellLists.get(draft) ?? []);
  });
  const assignedKeys = new Set<number>();
  for (const object of objects) {
    if (object.kind === 'unknown') continue;
    for (const cell of cellsById.get(object.id) ?? []) {
      assignedKeys.add(cellKeyOf(ctx, cell.x, cell.y, cell.z));
    }
  }
  const unknownKeys = new Set<number>();
  for (const object of objects) {
    if (object.kind !== 'unknown') continue;
    for (const cell of cellsById.get(object.id) ?? []) {
      unknownKeys.add(cellKeyOf(ctx, cell.x, cell.y, cell.z));
    }
  }
  for (const key of unknownKeys) {
    if (assignedKeys.has(key)) coverageFailure('同一格同时被认领为对象与 unknown');
  }
  if (objectCells !== ctx.grid.size) {
    coverageFailure(`对象格数 ${String(objectCells)} 与网格格数 ${String(ctx.grid.size)} 不一致`);
  }
  if (assignedCells + unknownCells !== ctx.grid.size) {
    coverageFailure(
      `assignedCells(${String(assignedCells)}) + unknownCells(${String(unknownCells)}) !== totalCells(${String(ctx.grid.size)})`,
    );
  }
  if (
    assignedKeys.size + unknownKeys.size !== ctx.grid.size ||
    assignedKeys.size !== assignedCells ||
    unknownKeys.size !== unknownCells
  ) {
    coverageFailure(
      `对象格集合不是网格格集合的划分：assignedKeys=${String(assignedKeys.size)} unknownKeys=${String(unknownKeys.size)} ` +
        `assignedCells=${String(assignedCells)} unknownCells=${String(unknownCells)} total=${String(ctx.grid.size)}`,
    );
  }

  objects.sort(compareObjects);
  const objectCounts = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<ObjectKind, number>;
  const confidenceCounts = Object.fromEntries(CONFIDENCES.map((confidence) => [confidence, 0])) as Record<
    Confidence,
    number
  >;
  for (const object of objects) {
    objectCounts[object.kind] += 1;
    confidenceCounts[object.confidence] += 1;
  }

  const diagnostics: AsBuiltDiagnostic[] = [];
  if (openings.rejected > 0) {
    diagnostics.push({ code: 'unrepresented-void', count: openings.rejected, note: null });
  }
  if (unknowns.ambiguousComponents > 0) {
    diagnostics.push({ code: 'ambiguous-component', count: unknowns.ambiguousComponents, note: null });
  }
  diagnostics.sort((a, b) => compareText(a.code, b.code));

  return {
    schemaVersion: AS_BUILT_SCHEMA_VERSION,
    bounds: {
      min: [ctx.bounds.min[0], ctx.bounds.min[1], ctx.bounds.min[2]],
      max: [ctx.bounds.max[0] + 1, ctx.bounds.max[1] + 1, ctx.bounds.max[2] + 1],
    },
    measurement: {
      unit: 'voxel-cell',
      boundsConvention: 'half-open [min,max)',
      coordinateSystem: 'x-east, y-up, z-south',
      toleranceCells: 0,
    },
    objects,
    summary: { totalCells: ctx.grid.size, assignedCells, unknownCells, objectCounts, confidenceCounts },
    coverage: {
      totalCells: ctx.grid.size,
      assignedCells,
      unknownCells,
      assignedRatio: ctx.grid.size === 0 ? null : assignedCells / ctx.grid.size,
    },
    diagnostics,
  };
}
