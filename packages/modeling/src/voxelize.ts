/**
 * 体素化内核（M1a 转换层，docs/MASSING-CONVERSION-SPEC.md §2–§4）。
 *
 * 负责：对二次校验通过的 ModelDocument 逐部件逐三角求交（三角 AABB 候选格 + 13 轴 SAT + 整数平面对齐的
 * 共面特判），生成壳格集；shell 模式按 thickness 做 6 邻接膨胀，solid 模式用 6 邻接洪水填内部并给开放壳标
 * `leaky`；在文档格集并集上做单趟孤立格清理；输出每部件升序整数格（VoxelPart）与全文档汇总（VoxelResult）。
 * 不负责：网格生成（box/revolve/extrude/surface）、材质映射（@pg/geometry）、世界放置与旋转（§6）、I/O。
 *
 * 数值（§3.1、§9、决策 #104/#105）：只用 IEEE-754 f64 的 `+ − ×`、比较与 `Math.floor`，不做 float32 量化；
 * 格坐标按 schema.ABS_MAX 有界，用基 2·(ABS_MAX+16)+1 打包成安全整数键（留出膨胀 / 洪水外扩的余量，
 * 避免低位借位串到邻近轴），比字符串键省内存与时间。格是闭立方体，擦边算命中（闭区间 SAT）。
 */
import { z } from 'zod';

import { formatIssues } from './errors.ts';
import { ModelDocument } from './schema.ts';
import type { Part, Role } from './schema.ts';
import {
  MAX_IMPORT_CELLS,
  addCell,
  coordsOf,
  createCellStore,
  dilate,
  fillSolid,
  findIsolated,
  numberAt,
} from './voxelize-cells.ts';
import type { CellStore } from './voxelize-cells.ts';
import { VoxelizeError } from './voxelize-error.ts';

export { VoxelizeError };
export type { VoxelizeErrorCode } from './voxelize-error.ts';
export { MAX_IMPORT_CELLS };

/** 壳厚上限（§3.2）：1–4 圈。 */
export const MAX_THICKNESS = 4;

/** 生效模式；role=roof 默认 shell，其余默认 solid（§3.2）。 */
export type VoxelMode = 'shell' | 'solid';
/** 孤立格清理策略（§3.2）。 */
export type Cleanup = 'isolated' | 'none';

/** 逐部件覆盖项。 */
export interface VoxelPartOverride {
  readonly mode?: VoxelMode | undefined;
  readonly thickness?: number | undefined;
}

/** voxelize 选项；overrides 的键是文档部件 id。 */
export interface VoxelizeOptions {
  readonly mode?: VoxelMode;
  readonly thickness?: number;
  readonly overrides?: Readonly<Record<string, VoxelPartOverride>>;
  readonly cleanup?: Cleanup;
}

/** 格包围盒闭区间（§4）。 */
export interface VoxelBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** 单个部件的体素化结果（§4）。 */
export interface VoxelPart {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly color: string;
  /** 文档部件自带材质，原样透传；未设为 undefined。内核不解析方块。 */
  readonly material?: string;
  readonly mode: VoxelMode;
  /** 局部格，按 (x,y,z) 升序，可为负。 */
  readonly cells: readonly (readonly [number, number, number])[];
  readonly bounds: VoxelBounds | null;
  readonly cellCount: number;
  readonly isolatedCells: number;
  readonly isolatedRemoved: number;
  readonly leaky: boolean;
}

/** 全文档体素化结果（§4）。 */
export interface VoxelResult {
  readonly parts: readonly VoxelPart[];
  readonly bounds: VoxelBounds | null;
  readonly counts: {
    readonly parts: number;
    readonly cells: number;
    readonly triangles: number;
    readonly shellParts: number;
    readonly solidParts: number;
    readonly emptyParts: number;
    readonly leakyParts: number;
    readonly isolatedCells: number;
    readonly isolatedRemoved: number;
  };
}

const modeSchema = z.enum(['shell', 'solid']);
const thicknessSchema = z.number().refine((value) => Number.isInteger(value) && value >= 1 && value <= MAX_THICKNESS, {
  message: `thickness 必须是 1–${String(MAX_THICKNESS)} 的整数`,
});
const overrideSchema = z
  .strictObject({ mode: modeSchema.optional(), thickness: thicknessSchema.optional() })
  .readonly();
const optionsSchema = z
  .strictObject({
    mode: modeSchema.optional(),
    thickness: thicknessSchema.optional(),
    overrides: z.record(z.string(), overrideSchema).optional(),
    cleanup: z.enum(['isolated', 'none']).optional(),
  })
  .readonly();

interface ResolvedOptions {
  readonly mode: VoxelMode | undefined;
  readonly thickness: number | undefined;
  readonly overrides: ReadonlyMap<string, VoxelPartOverride>;
  readonly cleanup: Cleanup;
}

/** role → 缺省模式（§3.2）。 */
function roleDefaultMode(role: Role): VoxelMode {
  return role === 'roof' ? 'shell' : 'solid';
}

/** 选项严格校验（§2）：schema 失败、overrides 指向不存在的部件都报 options-invalid。 */
function parseOptions(options: unknown, parts: readonly Part[]): ResolvedOptions {
  const ids = parts.map((part) => part.id);
  const idList = `[${ids.join(', ')}]`;
  const parsed = optionsSchema.safeParse(options ?? {});
  if (!parsed.success) {
    throw new VoxelizeError(
      'options-invalid',
      `massingImport 选项不合法：${formatIssues(parsed.error.issues)}；文档部件 id 有 ${idList}`,
    );
  }
  const overrides = new Map<string, VoxelPartOverride>();
  for (const [id, value] of Object.entries(parsed.data.overrides ?? {})) {
    if (!ids.includes(id)) {
      throw new VoxelizeError(
        'options-invalid',
        `massingImport 选项不合法：overrides 含不存在的部件 id ${id}；文档部件 id 有 ${idList}`,
      );
    }
    overrides.set(id, value);
  }
  return {
    mode: parsed.data.mode,
    thickness: parsed.data.thickness,
    overrides,
    cleanup: parsed.data.cleanup ?? 'isolated',
  };
}

/** 升序比较：x、y、z 依次。 */
function compareCell(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** 13 轴 SAT 的单轴分离测试：轴 `axis`，盒半边长 `half`；用严格不等号，擦边算相交。 */
function axisSeparates(
  axis: readonly [number, number, number],
  vx: readonly number[],
  vy: readonly number[],
  vz: readonly number[],
  half: number,
): boolean {
  const [px, py, pz] = axis;
  const radius = half * (Math.abs(px) + Math.abs(py) + Math.abs(pz));
  let min = Infinity;
  let max = -Infinity;
  for (let t = 0; t < 3; t += 1) {
    const projection = px * (vx[t] ?? 0) + py * (vy[t] ?? 0) + pz * (vz[t] ?? 0);
    if (projection < min) min = projection;
    if (projection > max) max = projection;
  }
  return min > radius || max < -radius;
}

/**
 * 三角与格 (i,j,k) 相交的 SAT：3 格轴 + 三角法线 + 9 条边叉积，共 13 轴；无分离轴即命中。
 * 只碰边 / 角也命中（闭区间），非整数平面对齐的三角由此得到保守的至少一格。
 */
function triangleIntersectsCell(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  i: number,
  j: number,
  k: number,
): boolean {
  const half = 0.5;
  const vx = [ax - i - half, bx - i - half, cx - i - half];
  const vy = [ay - j - half, by - j - half, cy - j - half];
  const vz = [az - k - half, bz - k - half, cz - k - half];
  const e0x = bx - ax;
  const e0y = by - ay;
  const e0z = bz - az;
  const e1x = cx - bx;
  const e1y = cy - by;
  const e1z = cz - bz;
  const e2x = ax - cx;
  const e2y = ay - cy;
  const e2z = az - cz;
  const nx = e0y * e1z - e0z * e1y;
  const ny = e0z * e1x - e0x * e1z;
  const nz = e0x * e1y - e0y * e1x;
  // 3 格轴 + 三角法线 + 9 条边叉积（格轴 X/Y/Z 与边 e0/e1/e2 的叉积），共 13 轴。
  const axes: readonly (readonly [number, number, number])[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [nx, ny, nz],
    [0, -e0z, e0y],
    [0, -e1z, e1y],
    [0, -e2z, e2y],
    [e0z, 0, -e0x],
    [e1z, 0, -e1x],
    [e2z, 0, -e2x],
    [-e0y, e0x, 0],
    [-e1y, e1x, 0],
    [-e2y, e2x, 0],
  ];
  for (const axis of axes) {
    if (axisSeparates(axis, vx, vy, vz, half)) return false;
  }
  return true;
}

/** 二维投影区间是否有正长度重叠；重叠面积 > 0 的必要条件之一。 */
function positiveProjectionOverlap(
  axisU: number,
  axisV: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
  squareU: number,
  squareV: number,
): boolean {
  const a0 = u0 * axisU + v0 * axisV;
  const a1 = u1 * axisU + v1 * axisV;
  const a2 = u2 * axisU + v2 * axisV;
  const triangleMin = Math.min(a0, a1, a2);
  const triangleMax = Math.max(a0, a1, a2);
  const s0 = squareU * axisU + squareV * axisV;
  const s1 = (squareU + 1) * axisU + squareV * axisV;
  const s2 = (squareU + 1) * axisU + (squareV + 1) * axisV;
  const s3 = squareU * axisU + (squareV + 1) * axisV;
  const squareMin = Math.min(s0, s1, s2, s3);
  const squareMax = Math.max(s0, s1, s2, s3);
  return Math.min(triangleMax, squareMax) - Math.max(triangleMin, squareMin) > 0;
}

/**
 * 共面三角与格面 (squareU..+1, squareV..+1) 的重叠面积是否 > 0（§3.1 共面特判）：
 * 2 格轴 + 3 条三角边法线共 5 轴，每轴投影都须有正长度重叠；只碰边 / 角的重叠为 0，拒绝。
 */
function faceOverlaps(
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
  squareU: number,
  squareV: number,
): boolean {
  if (!positiveProjectionOverlap(1, 0, u0, v0, u1, v1, u2, v2, squareU, squareV)) return false;
  if (!positiveProjectionOverlap(0, 1, u0, v0, u1, v1, u2, v2, squareU, squareV)) return false;
  if (!positiveProjectionOverlap(v1 - v0, -(u1 - u0), u0, v0, u1, v1, u2, v2, squareU, squareV)) return false;
  if (!positiveProjectionOverlap(v2 - v1, -(u2 - u1), u0, v0, u1, v1, u2, v2, squareU, squareV)) return false;
  if (!positiveProjectionOverlap(v0 - v2, -(u0 - u2), u0, v0, u1, v1, u2, v2, squareU, squareV)) return false;
  return true;
}

interface CoplanarFace {
  readonly axis: 0 | 1 | 2;
  readonly cell: number;
  readonly otherA: 0 | 1 | 2;
  readonly otherB: 0 | 1 | 2;
}

/**
 * 三角是否落在整数平面 c 上且法线只沿该轴（§3.1 共面特判）：归一到法线指向的一格
 * （n>0 → c−1，n<0 → c），避免整数对齐的盒面在平面两侧各铺一层。
 */
function detectCoplanarFace(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): CoplanarFace | null {
  const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (ax === bx && bx === cx && Number.isInteger(ax) && ny === 0 && nz === 0) {
    return { axis: 0, cell: nx > 0 ? ax - 1 : ax, otherA: 1, otherB: 2 };
  }
  if (ay === by && by === cy && Number.isInteger(ay) && nx === 0 && nz === 0) {
    return { axis: 1, cell: ny > 0 ? ay - 1 : ay, otherA: 0, otherB: 2 };
  }
  if (az === bz && bz === cz && Number.isInteger(az) && nx === 0 && ny === 0) {
    return { axis: 2, cell: nz > 0 ? az - 1 : az, otherA: 0, otherB: 1 };
  }
  return null;
}

/** 某个顶点在给定轴上的分量。 */
function component(x: number, y: number, z: number, axis: 0 | 1 | 2): number {
  if (axis === 0) return x;
  if (axis === 1) return y;
  return z;
}

/** 求一个部件的表壳格集：逐三角（按索引序）取候选格，共面走 2D 面积判据，否则走 13 轴 SAT。 */
function voxelizeShell(part: Part): CellStore {
  const store = createCellStore();
  const positions = part.positions;
  const indices = part.indices;
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = numberAt(indices, t, '三角索引');
    const i1 = numberAt(indices, t + 1, '三角索引');
    const i2 = numberAt(indices, t + 2, '三角索引');
    const ax = numberAt(positions, i0 * 3, '顶点');
    const ay = numberAt(positions, i0 * 3 + 1, '顶点');
    const az = numberAt(positions, i0 * 3 + 2, '顶点');
    const bx = numberAt(positions, i1 * 3, '顶点');
    const by = numberAt(positions, i1 * 3 + 1, '顶点');
    const bz = numberAt(positions, i1 * 3 + 2, '顶点');
    const cx = numberAt(positions, i2 * 3, '顶点');
    const cy = numberAt(positions, i2 * 3 + 1, '顶点');
    const cz = numberAt(positions, i2 * 3 + 2, '顶点');
    const coplanar = detectCoplanarFace(ax, ay, az, bx, by, bz, cx, cy, cz);
    if (coplanar !== null) {
      const u0 = component(ax, ay, az, coplanar.otherA);
      const v0 = component(ax, ay, az, coplanar.otherB);
      const u1 = component(bx, by, bz, coplanar.otherA);
      const v1 = component(bx, by, bz, coplanar.otherB);
      const u2 = component(cx, cy, cz, coplanar.otherA);
      const v2 = component(cx, cy, cz, coplanar.otherB);
      const minU = Math.floor(Math.min(u0, u1, u2));
      const maxU = Math.floor(Math.max(u0, u1, u2));
      const minV = Math.floor(Math.min(v0, v1, v2));
      const maxV = Math.floor(Math.max(v0, v1, v2));
      for (let u = minU; u <= maxU; u += 1) {
        for (let v = minV; v <= maxV; v += 1) {
          if (!faceOverlaps(u0, v0, u1, v1, u2, v2, u, v)) continue;
          if (coplanar.axis === 0) addCell(store, coplanar.cell, u, v);
          else if (coplanar.axis === 1) addCell(store, u, coplanar.cell, v);
          else addCell(store, u, v, coplanar.cell);
        }
      }
      continue;
    }
    const minX = Math.floor(Math.min(ax, bx, cx));
    const maxX = Math.floor(Math.max(ax, bx, cx));
    const minY = Math.floor(Math.min(ay, by, cy));
    const maxY = Math.floor(Math.max(ay, by, cy));
    const minZ = Math.floor(Math.min(az, bz, cz));
    const maxZ = Math.floor(Math.max(az, bz, cz));
    for (let i = minX; i <= maxX; i += 1) {
      for (let j = minY; j <= maxY; j += 1) {
        for (let k = minZ; k <= maxZ; k += 1) {
          if (triangleIntersectsCell(ax, ay, az, bx, by, bz, cx, cy, cz, i, j, k)) addCell(store, i, j, k);
        }
      }
    }
  }
  return store;
}

/** 计算某部件最终格集（可含清理）与包围盒。 */
function finalizePart(
  part: Part,
  mode: VoxelMode,
  leaky: boolean,
  store: CellStore,
  isolated: ReadonlySet<number>,
  cleanup: Cleanup,
): { readonly voxelPart: VoxelPart; readonly isolatedCells: number; readonly isolatedRemoved: number } {
  let isolatedCells = 0;
  let isolatedRemoved = 0;
  const kept: [number, number, number][] = [];
  for (const key of store.index.keys()) {
    if (isolated.has(key)) {
      isolatedCells += 1;
      if (cleanup === 'isolated') {
        isolatedRemoved += 1;
        continue;
      }
    }
    const coord = coordsOf(store, key);
    kept.push([coord[0], coord[1], coord[2]]);
  }
  kept.sort(compareCell);
  let bounds: VoxelBounds | null = null;
  if (kept.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const cell of kept) {
      if (cell[0] < minX) minX = cell[0];
      if (cell[1] < minY) minY = cell[1];
      if (cell[2] < minZ) minZ = cell[2];
      if (cell[0] > maxX) maxX = cell[0];
      if (cell[1] > maxY) maxY = cell[1];
      if (cell[2] > maxZ) maxZ = cell[2];
    }
    bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  }
  const voxelPart: VoxelPart = {
    id: part.id,
    name: part.name,
    role: part.role,
    color: part.color,
    ...(part.material === undefined ? {} : { material: part.material }),
    mode,
    cells: kept,
    bounds,
    cellCount: kept.length,
    isolatedCells,
    isolatedRemoved,
    leaky,
  };
  return { voxelPart, isolatedCells, isolatedRemoved };
}

/**
 * 把 ModelDocument 体素化成每部件整数格集（§2–§4）。
 *
 * @param document 未校验的草模文档；用导出的 ModelDocument schema 二次校验。
 * @param options 严格校验的模式 / 厚度 / 逐部件覆盖 / 清理策略。
 */
export function voxelize(document: unknown, options?: VoxelizeOptions): VoxelResult {
  const parsed = ModelDocument.safeParse(document);
  if (!parsed.success) {
    throw new VoxelizeError(
      'document-invalid',
      `草模文档不合 ModelDocument 校验：${formatIssues(parsed.error.issues)}。请回到草模子运行修正后重新导入。`,
    );
  }
  const doc = parsed.data;
  const resolved = parseOptions(options, doc.parts);

  interface Record {
    readonly part: Part;
    readonly mode: VoxelMode;
    readonly leaky: boolean;
    readonly store: CellStore;
  }
  const records: Record[] = [];
  const union = new Set<number>();
  let triangles = 0;
  for (const part of doc.parts) {
    triangles += part.indices.length / 3;
    const override = resolved.overrides.get(part.id);
    const mode = override?.mode ?? resolved.mode ?? roleDefaultMode(part.role);
    const thickness = override?.thickness ?? resolved.thickness ?? 1;
    if (mode === 'solid' && thickness !== 1) {
      const ids = doc.parts.map((candidate) => candidate.id);
      throw new VoxelizeError(
        'options-invalid',
        `massingImport 选项不合法：thickness=${String(thickness)} 只能用于 shell，部件 ${part.id} 的实际模式是 solid；文档部件 id 有 [${ids.join(', ')}]`,
      );
    }
    const shell = voxelizeShell(part);
    let store = shell;
    let leaky = false;
    if (mode === 'shell') {
      if (thickness > 1) store = dilate(shell, thickness - 1);
    } else {
      const filled = fillSolid(shell);
      store = filled.store;
      leaky = filled.leaky;
    }
    records.push({ part, mode, leaky, store });
    for (const key of store.index.keys()) union.add(key);
  }
  if (union.size > MAX_IMPORT_CELLS) {
    throw new VoxelizeError(
      'limit-exceeded',
      `导入 ${String(union.size)} 格超过单次上限 ${String(MAX_IMPORT_CELLS)}；请减少采样段数、拆分部件或分次导入`,
    );
  }
  const isolated = findIsolated(union);

  let cellsTotal = 0;
  let shellParts = 0;
  let solidParts = 0;
  let emptyParts = 0;
  let leakyParts = 0;
  let isolatedTotal = 0;
  let isolatedRemovedTotal = 0;
  let globalMinX = Infinity;
  let globalMinY = Infinity;
  let globalMinZ = Infinity;
  let globalMaxX = -Infinity;
  let globalMaxY = -Infinity;
  let globalMaxZ = -Infinity;
  const parts: VoxelPart[] = [];
  for (const record of records) {
    const finalized = finalizePart(record.part, record.mode, record.leaky, record.store, isolated, resolved.cleanup);
    parts.push(finalized.voxelPart);
    cellsTotal += finalized.voxelPart.cellCount;
    isolatedTotal += finalized.isolatedCells;
    isolatedRemovedTotal += finalized.isolatedRemoved;
    if (record.mode === 'shell') shellParts += 1;
    else solidParts += 1;
    if (finalized.voxelPart.cellCount === 0) emptyParts += 1;
    if (record.leaky) leakyParts += 1;
    const bounds = finalized.voxelPart.bounds;
    if (bounds !== null) {
      if (bounds.min[0] < globalMinX) globalMinX = bounds.min[0];
      if (bounds.min[1] < globalMinY) globalMinY = bounds.min[1];
      if (bounds.min[2] < globalMinZ) globalMinZ = bounds.min[2];
      if (bounds.max[0] > globalMaxX) globalMaxX = bounds.max[0];
      if (bounds.max[1] > globalMaxY) globalMaxY = bounds.max[1];
      if (bounds.max[2] > globalMaxZ) globalMaxZ = bounds.max[2];
    }
  }
  const globalBounds: VoxelBounds | null =
    cellsTotal === 0 ? null : { min: [globalMinX, globalMinY, globalMinZ], max: [globalMaxX, globalMaxY, globalMaxZ] };
  return {
    parts,
    bounds: globalBounds,
    counts: {
      parts: doc.parts.length,
      cells: cellsTotal,
      triangles,
      shellParts,
      solidParts,
      emptyParts,
      leakyParts,
      isolatedCells: isolatedTotal,
      isolatedRemoved: isolatedRemovedTotal,
    },
  };
}
