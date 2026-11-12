/** 基础矩形构件的离散几何；只生成写入计划，不登记调用、不改变世界。 */
import type { z } from 'zod';
import type { BlockState } from '@pg/core/block-state';
import { checkCoord } from '@pg/core/coord';
import type { Bounds } from '@pg/core/grid';
import { rect } from './schema.ts';
import type { Footprint, Point, Side, openingSchema } from './schema.ts';
import type { Write } from './writer.ts';
import { contains } from './footprint.ts';

export function bounds(r: Footprint, y: number, height: number): Bounds {
  checkCoord(r.minX, y, r.minZ);
  checkCoord(r.maxX, y + height - 1, r.maxZ);
  return Object.freeze({
    min: Object.freeze([r.minX, y, r.minZ] as const),
    max: Object.freeze([r.maxX, y + height - 1, r.maxZ] as const),
  });
}

export function expand(r: Footprint, distance: number): Footprint {
  return rect(r.minX - distance, r.minZ - distance, r.maxX + distance, r.maxZ + distance);
}

export function boxWrites(from: Point, to: Point, state: BlockState, writeLayer: Write['writeLayer']): Write[] {
  checkCoord(...from);
  checkCoord(...to);
  if (from.some((n, i) => n > (to[i] ?? n)))
    throw new Error(
      `box.from=[${from.join(', ')}] 必须逐轴不大于 to=[${to.join(', ')}]：` +
        `${['x', 'y', 'z'][from.findIndex((n, i) => n > (to[i] ?? n))] ?? '?'} 轴反了`,
    );
  const out: Write[] = [];
  for (let y = from[1]; y <= to[1]; y += 1) {
    for (let z = from[2]; z <= to[2]; z += 1) {
      for (let x = from[0]; x <= to[0]; x += 1) out.push({ x, y, z, state, writeLayer });
    }
  }
  return out;
}

export function wallWrites(r: Footprint, y: number, height: number, thickness: number, state: BlockState): Write[] {
  const b = bounds(r, y, height);
  // 内部至少一格；不能把非法墙厚静默变成实心房子。
  expand(r, -thickness);
  const out: Write[] = [];
  for (let cy = b.min[1]; cy <= b.max[1]; cy += 1) {
    for (let z = r.minZ; z <= r.maxZ; z += 1) {
      for (let x = r.minX; x <= r.maxX; x += 1) {
        if (z >= r.minZ + thickness && z <= r.maxZ - thickness && x === r.minX + thickness) {
          x = r.maxX - thickness + 1;
        }
        out.push({ x, y: cy, z, state, writeLayer: 'structure' });
      }
    }
  }
  return out;
}

function facadePoint(r: Footprint, side: Side, u: number, y: number, depth: number): Point {
  if (r.apse === true) {
    const horizontal = side === 'north' || side === 'south';
    const min = horizontal ? r.minZ : r.minX;
    const max = horizontal ? r.maxZ : r.maxX;
    const step = side === 'north' || side === 'west' ? 1 : -1;
    for (let v = step === 1 ? min : max; v >= min && v <= max; v += step) {
      if (contains(r, horizontal ? u : v, horizontal ? v : u))
        return horizontal ? [u, y, v + depth * step] : [v + depth * step, y, u];
    }
    throw new Error(`opening 在后殿此处没有墙面：立面 ${side} 的第 ${String(u)} 列找不到墙，请修改 at / width`);
  }
  switch (side) {
    case 'north':
      return [u, y, r.minZ + depth];
    case 'south':
      return [u, y, r.maxZ - depth];
    case 'east':
      return [r.maxX - depth, y, u];
    case 'west':
      return [r.minX + depth, y, u];
  }
}

export interface OpeningPlan {
  readonly bounds: Bounds;
  readonly writes: readonly Write[];
  /** 洞（不含框）沿立面方向的起止格；用于把本立面已有洞的范围回报给下一次开洞。 */
  readonly start: number;
  readonly end: number;
}

/** 本立面已成功开过的洞；`start` / `end` 为洞本身（不含框）的沿立面范围。 */
export interface OpeningSpan {
  readonly at: number;
  readonly start: number;
  readonly end: number;
  readonly rim: number;
}

/** `world.opening` 把本立面已登记的洞传进来；直接调用 `openingWrites` 时可省略。 */
export interface OpeningFacadeInfo {
  readonly openings: readonly OpeningSpan[];
}

/**
 * 立面越界报错里列出本立面已有的洞（按 at 排序，每个洞写出连框占的范围）。
 * 上下文缺省时返回空串，不写"本立面还没有洞"，避免台基边等无关场景误导。
 */
function existingOpeningsText(facade: OpeningFacadeInfo | undefined, axis: string): string {
  if (facade === undefined) return '';
  const sorted = [...facade.openings].sort((a, b) => a.at - b.at);
  if (sorted.length === 0) return '本立面还没有洞。';
  const list = sorted
    .map((o) => `at=${String(o.at)} 连框占 ${axis}∈[${String(o.start - o.rim)}, ${String(o.end + o.rim)}]`)
    .join('；');
  return `本立面已有 ${String(sorted.length)} 个洞：${list}。`;
}

export function openingWrites(
  p: z.output<typeof openingSchema>,
  air: BlockState,
  fill: BlockState,
  frame?: BlockState,
  canopy?: BlockState,
  mullion?: BlockState,
  facade?: OpeningFacadeInfo,
): OpeningPlan {
  const f = p.in;
  const r = f.footprint;
  const horizontal = f.side === 'north' || f.side === 'south';
  const outerMin = horizontal ? r.minX : r.minZ;
  const outerMax = horizontal ? r.maxX : r.maxZ;
  // 两端各 thickness 格是转角，属于相邻立面的墙体，洞开在这里背后是另一面墙，是死洞。
  // 居中仍按整条外轮廓算（对称立面上居中的洞位置不变）；合法范围收进到墙身。
  // 台基边（edge，thickness 1）没有转角墙，范围取整条边。
  const corner = f.corner === false ? 0 : f.thickness;
  const min = outerMin + corner;
  const max = outerMax - corner;
  const start = outerMin + Math.floor((outerMax - outerMin + 1 - p.width) / 2) + p.at;
  const end = start + p.width - 1;
  const bottom = f.y + p.sill;
  const top = bottom + p.height - 1;
  const rim = p.frame?.width ?? 0;
  const frameBottom = bottom - (p.kind === 'window' ? rim : 0);
  const ceiling = top + Math.max(rim, canopy === undefined ? 0 : 1);
  if (start - rim < min || end + rim > max) {
    const axis = horizontal ? 'x' : 'z';
    const lo = min + rim - (start - p.at);
    const hi = max - rim - (end - p.at);
    throw new Error(
      `opening 放不下：当前 at=${String(p.at)}，洞${rim > 0 ? '连框' : ''}占 ${axis} ∈ [${String(start - rim)}, ${String(end + rim)}]。` +
        `本立面墙身可用 ${axis} ∈ [${String(min)}, ${String(max)}]（共 ${String(max - min + 1)} 格，两端各 ${String(corner)} 格是转角）。` +
        `${existingOpeningsText(facade, axis)}frame 默认宽 1，两侧各占 1 格。` +
        `请把 width${rim > 0 ? ' / frame.width' : ''} 减小，或把 at 改到 [${String(lo)}, ${String(hi)}]`,
    );
  }
  if (frameBottom < f.y || ceiling >= f.y + f.height) {
    throw new Error(
      `opening 放不下：洞${rim > 0 ? '连框' : ''}${canopy === undefined ? '' : '与雨棚'}占 y ∈ [${String(frameBottom)}, ${String(ceiling)}]，` +
        `立面只有 y ∈ [${String(f.y)}, ${String(f.y + f.height - 1)}]。请减小 height 或 sill，或加高外墙`,
    );
  }
  const writes: Write[] = [];
  const mask = (u: number, y: number): boolean => {
    if (u < start || u > end || y < bottom || y > top) return false;
    const nx = (2 * (u - start) + 1 - p.width) / p.width;
    if (p.shape === 'round') {
      const ny = (2 * (y - bottom) + 1 - p.height) / p.height;
      return nx * nx + ny * ny <= 1;
    }
    if (p.shape === 'pointed')
      return y - bottom < p.height - Math.floor(Math.abs(nx) * Math.min(p.height - 1, p.width / 2));
    if (p.shape === 'arch') {
      const rise = Math.min(p.height, Math.ceil(p.width / 2));
      const ny = (y - (top - rise + 1) + 0.5) / rise;
      return ny <= 0 || nx * nx + ny * ny <= 1;
    }
    return true;
  };
  // 外侧净空：有框或雨棚时，墙外同样开出空气，防止框与雨棚（装饰层）把通道堵住。
  // 这里只写空气：fill（玻璃、门）只在墙厚之内，否则窗会外凸到墙外。
  const outside = frame === undefined && canopy === undefined ? 0 : (p.canopy?.depth ?? 1);
  // 窗带竖框：从 start 起每 every 格一整列（含起端）在墙厚内换竖框材质，其余为 fill（§8.5）。
  const isMullion = (u: number): boolean => mullion !== undefined && (u - start) % (p.mullion?.every ?? 2) === 0;
  for (let y = bottom; y <= top; y += 1) {
    for (let u = start; u <= end; u += 1) {
      if (!mask(u, y)) continue;
      const inside = isMullion(u) && mullion !== undefined ? mullion : fill;
      for (let d = -outside; d < f.thickness; d += 1) {
        const [x, , z] = facadePoint(r, f.side, u, y, d);
        writes.push({ x, y, z, state: d < 0 ? air : inside, writeLayer: 'opening', role: d < 0 ? 'outside' : 'hole' });
      }
    }
  }
  if (frame !== undefined) {
    for (let y = frameBottom; y <= top + rim; y += 1) {
      for (let u = start - rim; u <= end + rim; u += 1) {
        if (mask(u, y)) continue;
        let touches = false;
        for (let du = -rim; du <= rim && !touches; du += 1) {
          for (let dy = -rim; dy <= rim; dy += 1) if (mask(u + du, y + dy)) touches = true;
        }
        if (!touches) continue;
        const [x, , z] = facadePoint(r, f.side, u, y, -1);
        writes.push({ x, y, z, state: frame, writeLayer: 'decoration', role: 'frame' });
      }
    }
  }
  if (canopy !== undefined && p.canopy !== undefined) {
    for (let d = -p.canopy.depth; d < 0; d += 1) {
      for (let u = start - rim; u <= end + rim; u += 1) {
        const [x, , z] = facadePoint(r, f.side, u, top + 1, d);
        writes.push({ x, y: top + 1, z, state: canopy, writeLayer: 'decoration', role: 'canopy' });
      }
    }
  }
  const a = facadePoint(r, f.side, start, bottom, 0);
  const b = facadePoint(r, f.side, end, top, f.thickness - 1);
  // 曲面洞的中间格可能比两端更向外，包围盒必须遍历实际开洞格。
  let minX = Math.min(a[0], b[0]);
  let maxX = Math.max(a[0], b[0]);
  let minZ = Math.min(a[2], b[2]);
  let maxZ = Math.max(a[2], b[2]);
  for (const w of writes)
    if (r.apse === true && w.writeLayer === 'opening' && contains(r, w.x, w.z)) {
      minX = Math.min(minX, w.x);
      maxX = Math.max(maxX, w.x);
      minZ = Math.min(minZ, w.z);
      maxZ = Math.max(maxZ, w.z);
    }
  return {
    bounds: bounds(rect(minX, minZ, maxX, maxZ), bottom, p.height),
    writes,
    start,
    end,
  };
}
