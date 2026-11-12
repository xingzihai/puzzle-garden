/**
 * Grid → 紧凑格表（RENDER-SPEC §4.2）。
 *
 * 负责：挑选可画格、统计 belowGround / skipped / fallbackColor / simplified、上限检查、
 *   调色板去重与排序、写出宿主与页面之间的二进制协议。
 * 不负责：读存档（render.ts）、面数与面缓冲（mesh.ts）、相机（camera.ts）。纯函数。
 */

import type { BlockRegistry } from '@pg/blocks/registry';
import type { Grid } from '@pg/core/grid';

import type { BBox } from './camera.ts';
import { isConnectionAware, MASK_EAST, MASK_NORTH, MASK_SOUTH, MASK_WEST, resolveModelId } from './mc-catalog.ts';
import type { McAssetCatalog } from './mc-catalog.ts';
import {
  CELL_BYTES,
  HEADER_BYTES,
  MAGIC,
  MAX_TABLE_VOLUME,
  PAINT,
  PALETTE_ITEM_BYTES_V2,
  PROTOCOL_VERSION,
} from './mesh.ts';
import { paletteItem } from './palette.ts';
import type { PaletteItem } from './palette.ts';

export interface SceneStatsCore {
  readonly cells: number;
  readonly belowGround: number;
  readonly skipped: number;
  readonly fallbackColor: readonly string[];
  /** 按方块形态计：被画成 small 的格数。 */
  readonly simplified: Readonly<Record<string, number>>;
  /** 使用官方模型几何的格数（没有官方资源时为 0）。 */
  readonly officialCells: number;
}

export type SceneLimit = 'cells' | 'span' | 'volume' | 'palette';

export type SceneBuild =
  | {
      readonly kind: 'ok';
      readonly buffer: Uint8Array;
      readonly stats: SceneStatsCore;
      readonly bbox: BBox;
      readonly paletteCount: number;
    }
  | { readonly kind: 'empty'; readonly belowGround: number }
  | { readonly kind: 'too-large'; readonly what: SceneLimit; readonly value: number; readonly limit: number };

interface Accepted {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly item: PaletteItem;
}

const MAX_SPAN = 65535;
const MAX_PALETTE = 65534;

function cmp(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const MAGIC_BYTES = new TextEncoder().encode(MAGIC);

/** 与 mesh.ts 的连接集合一致：这些形态会画连接臂。 */
const CONNECT_SHAPES: ReadonlySet<string> = new Set(['cube', 'glass', 'fence', 'wall', 'pane']);

function connectionMask(grid: Grid, registry: BlockRegistry, x: number, y: number, z: number): number {
  const isConnector = (dx: number, dz: number): boolean => {
    const cell = grid.get(x + dx, y, z + dz);
    if (cell === undefined) return false;
    return CONNECT_SHAPES.has(registry.info(cell.state).shape);
  };
  return (
    (isConnector(0, -1) ? MASK_NORTH : 0) |
    (isConnector(1, 0) ? MASK_EAST : 0) |
    (isConnector(0, 1) ? MASK_SOUTH : 0) |
    (isConnector(-1, 0) ? MASK_WEST : 0)
  );
}

/** 生成紧凑格表；不启动浏览器就能返回 empty / too-large。目录缺省时全部走简化几何。 */
export function buildScene(
  grid: Grid,
  registry: BlockRegistry,
  maxCells: number,
  catalog?: McAssetCatalog,
): SceneBuild {
  const accepted: Accepted[] = [];
  const fallback = new Set<string>();
  const simplified = new Map<string, number>();
  let belowGround = 0;
  let skipped = 0;
  let officialCells = 0;

  for (const cell of grid.cells()) {
    const info = registry.info(cell.state);
    const connected =
      catalog !== undefined && isConnectionAware(catalog, info.id)
        ? connectionMask(grid, registry, cell.x, cell.y, cell.z)
        : 0;
    const model = catalog === undefined ? 0 : resolveModelId(catalog, cell.state, connected);
    const item = paletteItem(cell.state, info, model);
    if (item.paint === PAINT.skip) {
      skipped += 1;
      continue;
    }
    if (item.fallback) fallback.add(info.id);
    if (item.paint === PAINT.small && item.model === 0)
      simplified.set(info.shape, (simplified.get(info.shape) ?? 0) + 1);
    if (item.model > 0) officialCells += 1;
    if (cell.y <= 0) {
      belowGround += 1;
      continue;
    }
    accepted.push({ x: cell.x, y: cell.y, z: cell.z, item });
  }

  if (accepted.length === 0) return { kind: 'empty', belowGround };
  if (accepted.length > maxCells) return { kind: 'too-large', what: 'cells', value: accepted.length, limit: maxCells };

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const a of accepted) {
    if (a.x < minX) minX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.z < minZ) minZ = a.z;
    if (a.x > maxX) maxX = a.x;
    if (a.y > maxY) maxY = a.y;
    if (a.z > maxZ) maxZ = a.z;
  }
  const sx = maxX - minX + 1;
  const sy = maxY - minY + 1;
  const sz = maxZ - minZ + 1;

  if (sx > MAX_SPAN || sy > MAX_SPAN || sz > MAX_SPAN) {
    const value = Math.max(sx, sy, sz);
    return { kind: 'too-large', what: 'span', value, limit: MAX_SPAN };
  }
  if (sx * sy * sz > MAX_TABLE_VOLUME) {
    return { kind: 'too-large', what: 'volume', value: sx * sy * sz, limit: MAX_TABLE_VOLUME };
  }

  // 按 (y, z, x) 升序；调色板按首次出现编号，因此确定（RENDER-SPEC §4.2）。
  accepted.sort((a, b) => cmp(a.y, b.y) || cmp(a.z, b.z) || cmp(a.x, b.x));
  const palette: PaletteItem[] = [];
  const paletteIndex = new Map<string, number>();
  for (const a of accepted) {
    const [r, g, b] = a.item.rgb;
    const key = `${String(a.item.paint)},${a.item.params.join(',')},${String(r)},${String(g)},${String(b)},${String(a.item.model)}`;
    if (!paletteIndex.has(key)) {
      paletteIndex.set(key, palette.length);
      palette.push(a.item);
    }
  }
  if (palette.length > MAX_PALETTE) {
    return { kind: 'too-large', what: 'palette', value: palette.length, limit: MAX_PALETTE };
  }

  const buffer = new Uint8Array(HEADER_BYTES + palette.length * PALETTE_ITEM_BYTES_V2 + accepted.length * CELL_BYTES);
  buffer.set(MAGIC_BYTES, 0);
  const view = new DataView(buffer.buffer);
  view.setUint16(4, PROTOCOL_VERSION, true);
  view.setUint16(6, 0, true);
  view.setInt32(8, minX, true);
  view.setInt32(12, minY, true);
  view.setInt32(16, minZ, true);
  view.setUint16(20, sx, true);
  view.setUint16(22, sy, true);
  view.setUint16(24, sz, true);
  view.setUint32(26, accepted.length, true);
  view.setUint32(30, palette.length, true);

  let offset = HEADER_BYTES;
  for (const p of palette) {
    buffer[offset] = p.paint;
    buffer[offset + 1] = p.params[0];
    buffer[offset + 2] = p.params[1];
    buffer[offset + 3] = p.params[2];
    buffer[offset + 4] = p.rgb[0];
    buffer[offset + 5] = p.rgb[1];
    buffer[offset + 6] = p.rgb[2];
    // 第 8 字节：params[3]（门 / 活板门 / 栅栏门的 open 等）；v2 再追加模型 id。
    buffer[offset + 7] = p.params[3];
    view.setUint16(offset + 8, p.model, true);
    buffer[offset + 10] = 0;
    buffer[offset + 11] = 0;
    offset += PALETTE_ITEM_BYTES_V2;
  }
  for (const a of accepted) {
    view.setUint16(offset, a.x - minX, true);
    view.setUint16(offset + 2, a.y - minY, true);
    view.setUint16(offset + 4, a.z - minZ, true);
    const [r, g, b] = a.item.rgb;
    const key = `${String(a.item.paint)},${a.item.params.join(',')},${String(r)},${String(g)},${String(b)},${String(a.item.model)}`;
    view.setUint16(offset + 6, paletteIndex.get(key) ?? 0, true);
    offset += CELL_BYTES;
  }

  const simplifiedRecord: Record<string, number> = {};
  for (const key of [...simplified.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    simplifiedRecord[key] = simplified.get(key) ?? 0;
  }

  return {
    kind: 'ok',
    buffer,
    stats: {
      cells: accepted.length,
      belowGround,
      skipped,
      fallbackColor: [...fallback].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      simplified: simplifiedRecord,
      officialCells,
    },
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    paletteCount: palette.length,
  };
}
