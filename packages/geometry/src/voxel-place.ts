/**
 * 体素化结果的放置与登记：`massingImport` 与 `surfaceShell` 共用（SURFACE-SHELL-SPEC §2）。
 *
 * 负责：90° 格旋转（转换层 §6 公式）、世界放置与 y<1 / core 越界整次拒绝、材质逐部件解析时机、
 * 整次恰好一次 commit（结构层 body、同一 callId、parts 上下文按文档序登记部件），返回世界包围盒、
 * 每部件句柄与汇总计数。失败不留下任何格或调用。
 * 不负责：体素化（@pg/modeling/voxelize）、材质优先级（各构件自己给 stateForPart）、
 * 选项校验与资产通道（massing-import.ts / shell.ts）、I/O。
 */
import type { BlockState } from '@pg/core/block-state';
import { XZ_MAX, XZ_MIN, Y_MAX } from '@pg/core/coord';
import type { Bounds } from '@pg/core/grid';
import type { VoxelPart, VoxelResult } from '@pg/modeling/voxelize';

import { MassingError } from './massing-error.ts';
import type { Write, Writer } from './writer.ts';
import type { MassingCounts, MassingPartHandle } from './world-types.ts';

export type VoxelCell = readonly [number, number, number];
export type VoxelRotate = 0 | 90 | 180 | 270;

/** 转换层 §6：局部格 (i,j,k) 绕 y 逆时针旋转 rotate 度后的偏移；j 不变，格索引精确。 */
export function rotateCell([i, j, k]: VoxelCell, rotate: VoxelRotate): VoxelCell {
  switch (rotate) {
    case 0:
      return [i, j, k];
    case 90:
      return [-k - 1, j, i];
    case 180:
      return [-i - 1, j, -k - 1];
    case 270:
      return [k, j, -i - 1];
  }
}

/** 取样排序：y、z、x 升序，与 collision.ts 的报错口径一致，保证报错格确定。 */
function before(a: VoxelCell, b: VoxelCell): boolean {
  return a[1] < b[1] || (a[1] === b[1] && (a[2] < b[2] || (a[2] === b[2] && a[0] < b[0])));
}

/** 世界坐标文本；只用于错误消息。 */
export function showCell(cell: VoxelCell): string {
  return `(${String(cell[0])}, ${String(cell[1])}, ${String(cell[2])})`;
}

/** 各构件自己的可行动文案；模板由调用方提供，保证导入与壳的措辞各自成立。 */
export interface VoxelPlaceMessages {
  readonly belowGround: (partId: string, cell: VoxelCell) => string;
  readonly outOfRange: (cell: VoxelCell) => string;
}

export interface VoxelPlacePlan {
  readonly api: 'massingImport' | 'surfaceShell';
  /** 原样记进调用记录的参数摘要；不得含函数（函数只在进程内采样，不进存档）。 */
  readonly args: unknown;
  readonly result: VoxelResult;
  readonly at: VoxelCell;
  readonly rotate: VoxelRotate;
  /** 逐部件材质；按文档序在放置校验前全部解析（材质错误先于越界报出，与 massingImport 原行为一致）。 */
  readonly stateForPart: (part: VoxelPart) => BlockState;
  readonly messages: VoxelPlaceMessages;
  /** 空结果时抛出的错误；由调用方给具体文案。null 表示不检查（调用方已确保非空）。 */
  readonly emptyError: MassingError | null;
}
export interface VoxelPlacement {
  readonly bounds: Bounds;
  readonly parts: readonly MassingPartHandle[];
  readonly counts: MassingCounts;
}

/** 放置并登记一次体素结果；任一格 y<1 / 越界即整次失败，失败不留下任何格或调用。 */
export function placeVoxelParts(writer: Writer, plan: VoxelPlacePlan): VoxelPlacement {
  const { result, at, rotate } = plan;
  if (plan.emptyError !== null && result.counts.cells === 0) throw plan.emptyError;
  const states = new Map<string, BlockState>();
  for (const part of result.parts) states.set(part.id, plan.stateForPart(part));

  const placed: { readonly part: VoxelPart; readonly cells: readonly VoxelCell[]; readonly bounds: Bounds | null }[] =
    [];
  let lowest: { readonly cell: VoxelCell; readonly partId: string } | undefined;
  let outside: VoxelCell | undefined;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const part of result.parts) {
    const cells: VoxelCell[] = [];
    let pMinX = Infinity;
    let pMinY = Infinity;
    let pMinZ = Infinity;
    let pMaxX = -Infinity;
    let pMaxY = -Infinity;
    let pMaxZ = -Infinity;
    for (const [i, j, k] of part.cells) {
      const [dx, dy, dz] = rotateCell([i, j, k], rotate);
      const cell: VoxelCell = [at[0] + dx, at[1] + dy, at[2] + dz];
      if (cell[1] < 1 && (lowest === undefined || before(cell, lowest.cell))) lowest = { cell, partId: part.id };
      if (
        (cell[0] < XZ_MIN || cell[0] > XZ_MAX || cell[1] > Y_MAX || cell[2] < XZ_MIN || cell[2] > XZ_MAX) &&
        (outside === undefined || before(cell, outside))
      )
        outside = cell;
      cells.push(cell);
      if (cell[0] < pMinX) pMinX = cell[0];
      if (cell[1] < pMinY) pMinY = cell[1];
      if (cell[2] < pMinZ) pMinZ = cell[2];
      if (cell[0] > pMaxX) pMaxX = cell[0];
      if (cell[1] > pMaxY) pMaxY = cell[1];
      if (cell[2] > pMaxZ) pMaxZ = cell[2];
    }
    if (pMinX < minX) minX = pMinX;
    if (pMinY < minY) minY = pMinY;
    if (pMinZ < minZ) minZ = pMinZ;
    if (pMaxX > maxX) maxX = pMaxX;
    if (pMaxY > maxY) maxY = pMaxY;
    if (pMaxZ > maxZ) maxZ = pMaxZ;
    placed.push({
      part,
      cells,
      bounds: part.cellCount === 0 ? null : { min: [pMinX, pMinY, pMinZ], max: [pMaxX, pMaxY, pMaxZ] },
    });
  }
  if (lowest !== undefined)
    throw new MassingError('below-ground', plan.messages.belowGround(lowest.partId, lowest.cell));
  if (outside !== undefined) throw new MassingError('out-of-range', plan.messages.outOfRange(outside));

  // 整次一次 commit：所有格同一 callId；部件在 commit 里按文档序挂在当前 world.part 作用域下。
  const writes: Write[] = [];
  const parts: MassingPartHandle[] = [];
  for (const [index, entry] of placed.entries()) {
    const state = states.get(entry.part.id);
    if (state === undefined) throw new Error(`内部错误：部件 ${entry.part.id} 没有解析出材质`);
    for (const [x, y, z] of entry.cells)
      writes.push({ x, y, z, state, writeLayer: 'structure', role: 'body', part: index });
    parts.push(
      Object.freeze({
        id: entry.part.id,
        name: entry.part.name,
        role: entry.part.role,
        bounds: entry.bounds,
        cellCount: entry.part.cellCount,
      }),
    );
  }
  writer.commit(plan.api, plan.args, writes, { parts: result.parts.map((part) => part.name) });
  const globalMin: VoxelCell = [minX, minY, minZ];
  const globalMax: VoxelCell = [maxX, maxY, maxZ];
  return {
    bounds: { min: globalMin, max: globalMax },
    parts: Object.freeze(parts),
    counts: Object.freeze({ ...result.counts }),
  };
}
