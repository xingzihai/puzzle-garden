/**
 * 纹理图集打包：把 Minecraft 方块 PNG 排进一张 RGBA 图集。
 *
 * 负责：货架式排布、第一帧裁剪、白像素保留、像素坐标表；不负责读 PNG（png.ts）。
 * 图集 (0,0) 固定为白色，供 fallback 面 / 无贴图面取样。
 */

import type { DecodedPng } from './png.ts';

export interface AtlasPlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PackedAtlas {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly placements: Readonly<Record<string, AtlasPlacement>>;
}

const PADDING = 2;
const MARGIN = 2;

function firstFrame(png: DecodedPng): DecodedPng {
  if (png.height > png.width && png.height % png.width === 0) {
    const height = png.width;
    return { width: png.width, height, rgba: png.rgba.subarray(0, png.width * height * 4) };
  }
  return png;
}

/** 打包；纹理按高度降序、再按 key 排序，保证同一批输入的输出逐字节稳定。 */
export function buildAtlas(textures: ReadonlyMap<string, DecodedPng>, maxWidth = 2048): PackedAtlas {
  if (maxWidth < 64 || maxWidth > 4096) throw new Error(`图集宽度 ${String(maxWidth)} 不合法`);
  const entries = [...textures.entries()]
    .map(([key, png]) => ({ key, png: firstFrame(png) }))
    .sort((a, b) => b.png.height - a.png.height || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const placements: Record<string, AtlasPlacement> = {};
  let x = MARGIN;
  let y = MARGIN;
  let rowHeight = 0;
  let height = MARGIN;
  for (const entry of entries) {
    const { width, height: h } = entry.png;
    if (width + PADDING * 2 > maxWidth - MARGIN * 2)
      throw new Error(`纹理 ${entry.key} 宽 ${String(width)} 超过图集上限`);
    if (x + width + PADDING > maxWidth - MARGIN) {
      x = MARGIN;
      y += rowHeight + PADDING;
      rowHeight = 0;
    }
    placements[entry.key] = { x, y, width, height: h };
    x += width + PADDING;
    rowHeight = Math.max(rowHeight, h);
    height = Math.max(height, y + h + PADDING);
  }

  const atlasHeight = Math.max(4, Math.ceil((height + MARGIN) / 4) * 4);
  const rgba = new Uint8Array(maxWidth * atlasHeight * 4);
  // 白像素：供无贴图面与旧简化几何使用。
  rgba.set([255, 255, 255, 255], 0);
  for (const entry of entries) {
    const placement = placements[entry.key];
    if (placement === undefined) continue;
    for (let row = 0; row < placement.height; row += 1) {
      const src = row * placement.width * 4;
      const dst = ((placement.y + row) * maxWidth + placement.x) * 4;
      rgba.set(entry.png.rgba.subarray(src, src + placement.width * 4), dst);
    }
  }
  return { width: maxWidth, height: atlasHeight, rgba, placements };
}
