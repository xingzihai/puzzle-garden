/**
 * 官方模型目录（宿主侧索引）：把方块状态映射到预计算模型 id。
 *
 * 负责：按规范状态、默认状态、栏杆 / 玻璃板连接掩码查模型 id；不负责读 JSON（asset-pack.ts）
 * 或生成几何（tools/build-mc-catalog.ts）。本文件纯函数，不依赖文件系统。
 *
 * 连接掩码按位：north=1、east=2、south=4、west=8，与 scene-buffer 计算邻居时一致。
 */

import type { BlockState } from '@pg/core/block-state';

export const MASK_NORTH = 1;
export const MASK_EAST = 2;
export const MASK_SOUTH = 4;
export const MASK_WEST = 8;

export interface McAssetCatalog {
  readonly mcVersion: string;
  /** 规范状态 → 模型 id；0 表示没有官方几何。 */
  readonly states: Readonly<Record<string, number>>;
  /** 只含需要运行时连接状态的方块（栅栏、玻璃板等）；数组下标是 0–15 的连接掩码。 */
  readonly connections: Readonly<Record<string, readonly number[]>>;
  /** 每个已覆盖方块的默认状态模型，用于缺状态时兜底。 */
  readonly defaults: Readonly<Record<string, number>>;
  readonly coverage: {
    readonly blocks: number;
    readonly states: number;
    readonly models: number;
    readonly textures: number;
  };
}

/** 该方块是否需要连接掩码（栅栏 / 玻璃板 / 墙等 multipart 依赖邻居的方块）。 */
export function isConnectionAware(catalog: McAssetCatalog, id: string): boolean {
  return catalog.connections[id] !== undefined;
}

/** 规范状态精确匹配 → 默认状态 → 没有官方模型。 */
export function resolveModelId(catalog: McAssetCatalog, state: BlockState, connected?: number): number {
  const mask = (connected ?? 0) & 15;
  const byConnection = catalog.connections[state.name];
  if (byConnection !== undefined) return byConnection[mask] ?? 0;
  return catalog.states[state.canonical] ?? catalog.defaults[state.name] ?? 0;
}
