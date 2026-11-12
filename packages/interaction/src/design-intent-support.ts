/** DesignIntent 的共享矩形 schema / 几何辅助、宿主上下文与展开错误；从 design-intent.ts 重新导出。 */
import { XZ_MAX, XZ_MIN } from '@pg/core/coord';
import { z } from 'zod';

import type { MustLedgerEntry } from './must-ledger.ts';
import type { SchemeSourceRequirements, SchemeStatus, Side } from './scheme.ts';

export const Coord = z.int().min(XZ_MIN).max(XZ_MAX);

/** 轴对齐平面矩形；半开区间，必须正面积。 */
export const Rect2 = z
  .strictObject({
    x: z.tuple([Coord, Coord]),
    z: z.tuple([Coord, Coord]),
  })
  .superRefine((rect, ctx) => {
    if (rect.x[1] <= rect.x[0]) {
      ctx.addIssue({
        code: 'custom',
        path: ['x'],
        message: `矩形 x 必须 x1 > x0，实际是 ${String(rect.x[0])}..${String(rect.x[1])}`,
      });
    }
    if (rect.z[1] <= rect.z[0]) {
      ctx.addIssue({
        code: 'custom',
        path: ['z'],
        message: `矩形 z 必须 z1 > z0，实际是 ${String(rect.z[0])}..${String(rect.z[1])}`,
      });
    }
  })
  .readonly();
export type Rect2 = z.infer<typeof Rect2>;

export function rectWidth(rect: Rect2): number {
  return rect.x[1] - rect.x[0];
}

export function rectDepth(rect: Rect2): number {
  return rect.z[1] - rect.z[0];
}

export function rectArea(rect: Rect2): number {
  return rectWidth(rect) * rectDepth(rect);
}

/** 半开矩形是否完整落在 outer 内；贴边允许。 */
export function rectWithin(inner: Rect2, outer: Rect2): boolean {
  return inner.x[0] >= outer.x[0] && inner.x[1] <= outer.x[1] && inner.z[0] >= outer.z[0] && inner.z[1] <= outer.z[1];
}

/** 同层两个房间是否面积重叠；只贴边不算。 */
export function rectsOverlap(a: Rect2, b: Rect2): boolean {
  return a.x[0] < b.x[1] && b.x[0] < a.x[1] && a.z[0] < b.z[1] && b.z[0] < a.z[1];
}

/** 两个矩形共边的正长度；没有共边（含仅角点相接）返回 0。 */
export function rectSharedEdgeLength(a: Rect2, b: Rect2): number {
  if (a.x[1] === b.x[0] || b.x[1] === a.x[0]) {
    return Math.max(0, Math.min(a.z[1], b.z[1]) - Math.max(a.z[0], b.z[0]));
  }
  if (a.z[1] === b.z[0] || b.z[1] === a.z[0]) {
    return Math.max(0, Math.min(a.x[1], b.x[1]) - Math.max(a.x[0], b.x[0]));
  }
  return 0;
}

/**
 * 把同层矩形并集贪心分解为最大矩形：坐标压缩后按行扫描，先向右、再向下合并。
 * L 形通常得到 2 段；不保证全局最优，只保证不重叠、覆盖原并集。
 */
export function decomposeRectUnion(rects: readonly Rect2[]): readonly Rect2[] {
  if (rects.length === 0) return [];
  const xs = [...new Set(rects.flatMap((rect) => rect.x))].sort((a, b) => a - b);
  const zs = [...new Set(rects.flatMap((rect) => rect.z))].sort((a, b) => a - b);
  const covered = (x0: number, x1: number, z0: number, z1: number): boolean =>
    rects.some((rect) => x0 >= rect.x[0] && x1 <= rect.x[1] && z0 >= rect.z[0] && z1 <= rect.z[1]);
  const used = new Set<string>();
  const output: Rect2[] = [];
  for (let zi = 0; zi + 1 < zs.length; zi += 1) {
    for (let xi = 0; xi + 1 < xs.length; xi += 1) {
      const key = `${String(xi)}:${String(zi)}`;
      if (used.has(key)) continue;
      const x0 = xs[xi];
      const z0 = zs[zi];
      const x1 = xs[xi + 1];
      const z1 = zs[zi + 1];
      if (x0 === undefined || x1 === undefined || z0 === undefined || z1 === undefined) continue;
      if (!covered(x0, x1, z0, z1)) continue;

      let xEnd = xi + 1;
      while (xEnd + 1 < xs.length) {
        const nextX0 = xs[xEnd];
        const nextX1 = xs[xEnd + 1];
        if (
          nextX0 === undefined ||
          nextX1 === undefined ||
          used.has(`${String(xEnd)}:${String(zi)}`) ||
          !covered(nextX0, nextX1, z0, z1)
        ) {
          break;
        }
        xEnd += 1;
      }

      let zEnd = zi + 1;
      while (zEnd + 1 < zs.length) {
        const nextZ0 = zs[zEnd];
        const nextZ1 = zs[zEnd + 1];
        if (nextZ0 === undefined || nextZ1 === undefined) break;
        let rowCovered = true;
        for (let xi2 = xi; xi2 < xEnd; xi2 += 1) {
          const cellX0 = xs[xi2];
          const cellX1 = xs[xi2 + 1];
          if (
            cellX0 === undefined ||
            cellX1 === undefined ||
            used.has(`${String(xi2)}:${String(zEnd)}`) ||
            !covered(cellX0, cellX1, nextZ0, nextZ1)
          ) {
            rowCovered = false;
            break;
          }
        }
        if (!rowCovered) break;
        zEnd += 1;
      }

      const endX = xs[xEnd];
      const endZ = zs[zEnd];
      if (endX === undefined || endZ === undefined) continue;
      for (let zi2 = zi; zi2 < zEnd; zi2 += 1) {
        for (let xi2 = xi; xi2 < xEnd; xi2 += 1) used.add(`${String(xi2)}:${String(zi2)}`);
      }
      output.push({ x: [x0, endX], z: [z0, endZ] });
    }
  }
  return output;
}

/** 直跑楼梯的平面外包；start 为低端中心，direction 为上行方向。 */
export function stairRect(
  start: { readonly x: number; readonly z: number },
  direction: Side,
  width: number,
  treads: number,
): Rect2 {
  const half = Math.floor(width / 2);
  const x0 = direction === 'west' ? start.x - treads : direction === 'east' ? start.x : start.x - half;
  const x1 = direction === 'west' ? start.x : direction === 'east' ? start.x + treads : start.x - half + width;
  const z0 = direction === 'north' ? start.z - treads : direction === 'south' ? start.z : start.z - half;
  const z1 = direction === 'north' ? start.z : direction === 'south' ? start.z + treads : start.z - half + width;
  return { x: [x0, x1], z: [z0, z1] };
}

/** 宿主展开时注入的事实；模型不可编辑。 */
export interface DesignHostContext {
  readonly schemeId: string;
  readonly revision: number;
  readonly status?: SchemeStatus;
  readonly sourceRequirements: SchemeSourceRequirements;
  readonly maxBlocks: number;
  readonly targetBlocks?: number | null;
  readonly maxCostCny?: number | null;
  readonly forbidden?: readonly string[];
  readonly defaultMaterialId?: string;
  readonly floorThickness?: number;
  readonly roofThickness?: number;
  readonly requirementIds?: readonly string[];
  /** 需求图是否要求入口无台阶 / 齐平；由 createIntentHost 从 MustLedger 注入。 */
  readonly flushRequired?: boolean;
  /** 对应 must 的 BuildSpec id，供 DesignFacts.datum 记录冲突。 */
  readonly flushMustIds?: readonly string[];
  /** 完整 MustLedger（与 requirements 同源）；缺省时 details 保持空并告警。 */
  readonly mustEntries?: readonly MustLedgerEntry[];
}

export type IntentValidationCode =
  | 'schema-invalid'
  | 'host-invalid'
  | 'id-duplicate'
  | 'reference-missing'
  | 'site-overlap'
  | 'room-overlap'
  | 'wall-kind-conflict'
  | 'wall-intent-conflict'
  | 'wall-override-conflict'
  | 'material-ambiguous'
  | 'opening-out-of-wall'
  | 'opening-overlap'
  | 'entrance-invalid'
  | 'roof-plan-not-rectangular'
  | 'roof-plan-empty'
  | 'roof-plan-too-complex'
  | 'roof-segment-overlap'
  | 'roof-segment-outside'
  | 'roof-segment-incomplete'
  | 'roof-pitch-invalid'
  | 'missing-vertical-circulation'
  | 'stair-out-of-room'
  | 'furniture-out-of-room'
  | 'furniture-on-open-edge'
  | 'furniture-overlap'
  | 'facade-missing'
  | 'facade-without-wall'
  | 'requirement-reference';

/** 展开前的可定位失败；不进行部分展开。 */
export class IntentValidationError extends Error {
  readonly code: IntentValidationCode;
  readonly path: string;

  constructor(code: IntentValidationCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'IntentValidationError';
    this.code = code;
    this.path = path;
  }
}
