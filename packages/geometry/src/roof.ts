/** 屋面薄壳计划与锚点；不合成其他构件，不生成实心屋顶内部。 */
import type { z } from 'zod';
import type { BlockState, BlockTable } from '@pg/core/block-state';
import type { Bounds } from '@pg/core/grid';
import { bounds, expand, wallWrites } from './shapes.ts';
import { rect } from './schema.ts';
import type { roofSchema, Point, Side, Surface } from './schema.ts';
import { Writer } from './writer.ts';
import type { Write } from './writer.ts';
import { contains, projected } from './footprint.ts';
import type { Footprint } from './schema.ts';

/**
 * 后殿屋面的内缩距离：后殿承托轮廓（墙顶外轮廓）以内的格，到轮廓外最近一格的距离（轮廓边上为 0）；
 * 轮廓外的出檐格为 0，保持承托高度。距离按 8 邻接（棋盘距离）算：
 * 曲边是斜向阶梯，面邻接的步数在斜边上偏大，墙顶内侧那一格会比沿直边的同位置高一级，
 * 屋面在曲墙上方抬起、露出空气缝（审查 A1）。棋盘距离让斜边与直边一致。
 */
function apseDistances(apse: Footprint, overhang: number): Map<string, number> {
  const key = (x: number, z: number): string => `${String(x)},${String(z)}`;
  const dist = new Map<string, number>();
  const queue: (readonly [number, number])[] = [];
  for (let z = apse.minZ - overhang; z <= apse.maxZ + overhang; z += 1) {
    for (let x = apse.minX - overhang; x <= apse.maxX + overhang; x += 1) {
      if (!projected(apse, x, z, overhang)) continue;
      // 出檐格与承托轮廓的边缘格：距离 0
      const edge =
        !contains(apse, x, z) ||
        !contains(apse, x + 1, z) ||
        !contains(apse, x - 1, z) ||
        !contains(apse, x, z + 1) ||
        !contains(apse, x, z - 1);
      if (edge) {
        dist.set(key(x, z), 0);
        queue.push([x, z]);
      }
    }
  }
  for (const cell of queue) {
    const [x, z] = cell;
    const d = dist.get(key(x, z)) ?? 0;
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nk = key(x + dx, z + dz);
        if ((dx !== 0 || dz !== 0) && contains(apse, x + dx, z + dz) && !dist.has(nk)) {
          dist.set(nk, d + 1);
          queue.push([x + dx, z + dz]);
        }
      }
    }
  }
  return dist;
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export interface RoofPlan {
  readonly bounds: Bounds;
  readonly peak: Point;
  readonly eaveLine: Surface;
  readonly top: Surface | undefined;
  readonly writes: readonly Write[];
}

/** 山墙：材质与墙厚。roof 挂在外墙上时由世界从外墙推出；显式 footprint + y 时只能用 gableMaterial、厚 1。 */
export interface GableSpec {
  readonly state: BlockState;
  readonly thickness: number;
}

export function roofPlan(table: BlockTable, p: z.output<typeof roofSchema>, gable?: GableSpec): RoofPlan {
  const location =
    p.on ?? (p.footprint !== undefined && p.y !== undefined ? { footprint: p.footprint, y: p.y } : undefined);
  if (location === undefined) throw new Error('roof 位置缺失');
  if (location.footprint.polygon !== undefined) throw new Error('roof 需要矩形承托轮廓；多边形台基请先建矩形外墙');
  const writer = new Writer(table);
  const material = writer.material(p.material, true);
  const ridge = p.ridge ?? 'x';
  // 单坡高侧：显式 high 优先；否则沿用旧默认（ridge x 高侧 +z，ridge z 高侧 +x）。
  const shedHigh: Side | undefined = p.kind === 'shed' ? (p.high ?? (ridge === 'x' ? 'south' : 'east')) : undefined;
  // 高侧不出檐：承托轮廓边就是屋面边；低侧与两端照常外扩 overhang（§8.1）。
  const r =
    p.kind === 'shed' && p.high !== undefined
      ? Object.freeze({
          minX: location.footprint.minX - (p.high === 'west' ? 0 : p.overhang),
          maxX: location.footprint.maxX + (p.high === 'east' ? 0 : p.overhang),
          minZ: location.footprint.minZ - (p.high === 'north' ? 0 : p.overhang),
          maxZ: location.footprint.maxZ + (p.high === 'south' ? 0 : p.overhang),
        })
      : expand(location.footprint, p.overhang);
  const xspan = r.maxX - r.minX;
  const zspan = r.maxZ - r.minZ;
  // 后殿：曲边上的墙顶不在外接矩形的边上，按到矩形边的距离算内缩会让屋面在曲边处抬离墙顶（审查 A1）。
  // 改用到轮廓外的最近距离（面邻接步数），先在扩展后的轮廓上做一次广度优先。
  const apseInset = location.footprint.apse === true ? apseDistances(location.footprint, p.overhang) : undefined;
  const inset = (x: number, z: number): number => {
    if (apseInset !== undefined) {
      const d = apseInset.get(`${String(x)},${String(z)}`) ?? 0;
      if (p.kind === 'flat') return 0;
      if (p.kind !== 'hip' && p.kind !== 'pyramid') {
        throw new Error(`roof 放在后殿上只支持 hip、pyramid、flat：后殿没有直的山墙，kind=${p.kind} 无法确定屋脊`);
      }
      return d;
    }
    const dx = Math.min(x - r.minX, r.maxX - x);
    const dz = Math.min(z - r.minZ, r.maxZ - z);
    // 出檐部分保持承托高度（檐口），墙顶轮廓与屋面共面接触，而不是整片悬在墙顶上方。
    const edge = p.overhang;
    if (p.kind === 'flat') return 0;
    if (p.kind === 'gable') return Math.max(0, (ridge === 'x' ? dz : dx) - edge);
    // 单坡：内缩是到低侧出檐外缘的距离减 overhang，高侧为 0（§8.1）。
    if (shedHigh === 'north') return Math.max(0, r.maxZ - z - edge);
    if (shedHigh === 'south') return Math.max(0, z - r.minZ - edge);
    if (shedHigh === 'west') return Math.max(0, r.maxX - x - edge);
    if (shedHigh === 'east') return Math.max(0, x - r.minX - edge);
    if (p.kind === 'hip') return Math.max(0, Math.min(dx, dz) - edge);
    // 长方形攒尖按两轴归一化，到单格或双格中心尖端；整数栅格的顶点固定偏较小坐标。
    const cx = Math.floor(xspan / 2);
    const cz = Math.floor(zspan / 2);
    return Math.max(
      0,
      Math.min(
        (dx * Math.max(1, Math.min(cx, cz))) / Math.max(1, cx),
        (dz * Math.max(1, Math.min(cx, cz))) / Math.max(1, cz),
      ) - edge,
    );
  };
  const centerX = r.minX + Math.floor(xspan / 2);
  const centerZ = r.minZ + Math.floor(zspan / 2);
  // 单坡的尖端在高侧边中点（偶数偏较小坐标）；其余坡型的尖端在中心。
  const highPoint: readonly [number, number] =
    shedHigh === 'north'
      ? [centerX, r.minZ]
      : shedHigh === 'south'
        ? [centerX, r.maxZ]
        : shedHigh === 'east'
          ? [r.maxX, centerZ]
          : shedHigh === 'west'
            ? [r.minX, centerZ]
            : [centerX, centerZ];
  const maxInset = inset(highPoint[0], highPoint[1]);
  if (p.kind !== 'flat' && maxInset <= 0) {
    const span =
      Math.min(location.footprint.maxX - location.footprint.minX, location.footprint.maxZ - location.footprint.minZ) +
      1;
    throw new Error(
      `roof 放不下坡面：承托轮廓最窄处只有 ${String(span)} 格，坡面至少要 2 格才能升高一级。` +
        '请加大占地，或改用 kind: "flat"',
    );
  }
  const rise = p.peakY === undefined ? undefined : p.peakY - location.y;
  if (rise !== undefined && rise < 1) {
    throw new Error(`roof.peakY=${String(p.peakY)} 必须高于承托面 y=${String(location.y)}`);
  }
  // 与 pitch 的上限一致：peakY 换算出的坡度也不能超过 8。
  if (rise !== undefined && rise > 8 * maxInset) {
    throw new Error(
      `roof.peakY=${String(p.peakY)} 太陡：坡面水平进深 ${String(maxInset)} 格，最高只能到 y=${String(location.y + 8 * maxInset)}`,
    );
  }
  // 给 peakY 时按整数比例算高度，保证尖端恰好落在 peakY，不受浮点误差影响。
  const heightAt = (x: number, z: number): number =>
    location.y +
    (rise === undefined ? Math.floor(inset(x, z) * (p.pitch ?? 0.5)) : Math.floor((inset(x, z) * rise) / maxInset));
  const peakY = p.kind === 'flat' ? location.y : heightAt(highPoint[0], highPoint[1]);
  if (p.kind !== 'flat' && peakY === location.y)
    throw new Error(
      `roof 坡面高度不足一格：pitch=${String(p.pitch ?? 0.5)}（缺省 0.5），坡面水平进深=${String(maxInset)} 格；请增大 pitch 或占地`,
    );
  const finial = p.finial === undefined ? undefined : writer.material(p.finial.material, true);
  const parapet = p.parapet === undefined ? undefined : writer.material(p.parapet.material, true);
  const high = peakY + (p.finial?.height ?? p.parapet?.height ?? 0);
  const b = bounds(r, location.y - p.thickness + 1, high - location.y + p.thickness);
  const heights = new Map<string, number>();
  const key = (x: number, z: number): string => `${String(x)},${String(z)}`;
  for (let z = r.minZ; z <= r.maxZ; z += 1) {
    for (let x = r.minX; x <= r.maxX; x += 1) {
      if (location.footprint.apse === true && !projected(location.footprint, x, z, p.overhang)) continue;
      heights.set(key(x, z), heightAt(x, z));
    }
  }
  const writes: Write[] = [];
  for (let z = r.minZ; z <= r.maxZ; z += 1) {
    for (let x = r.minX; x <= r.maxX; x += 1) {
      const y = heights.get(key(x, z));
      if (y === undefined) continue;
      // 陡坡上相邻列高差 ≥ 2 时连棱都接不上，侧面露缝：向下补到比最低邻列高 1 格（y = low + 1）。
      // 补完后每一级与相邻级的关系和坡度 ≤ 1 时相同：靠棱相接，没有缝（决策 #59）。
      // 高差 ≤ 1 时补 0 格，几何与每列一格的薄壳完全相同。
      let low = y;
      for (const [dx, dz] of NEIGHBOURS) low = Math.min(low, heights.get(key(x + dx, z + dz)) ?? y);
      const connect = Math.max(0, y - low - 1);
      for (let d = 0; d < connect + p.thickness; d += 1)
        writes.push({ x, y: y - d, z, state: material, writeLayer: 'structure' });
    }
  }
  const peak: Point = Object.freeze([highPoint[0], peakY, highPoint[1]]);
  if (finial !== undefined && p.finial !== undefined) {
    for (let y = peakY + 1; y <= high; y += 1)
      writes.push({ x: peak[0], y, z: peak[2], state: finial, writeLayer: 'decoration' });
  }
  if (parapet !== undefined && p.parapet !== undefined)
    writes.push(...wallWrites(r, location.y + 1, p.parapet.height, 1, parapet));
  // 山墙：双坡两端、单坡三面，屋面在墙线上方抬起，墙顶与屋面之间是三角形开口（审查 B1）。
  // 在承托轮廓的墙线上（不含出檐），从承托面 y 往上补到屋面下一格，写结构层。决策 #63。
  if ((p.kind === 'gable' || p.kind === 'shed') && gable !== undefined) {
    const wall = location.footprint;
    const t = gable.thickness;
    const onGableLine = (x: number, z: number): boolean => {
      const nearX = x - wall.minX < t || wall.maxX - x < t;
      const nearZ = z - wall.minZ < t || wall.maxZ - z < t;
      // 双坡：屋脊沿 x 时，山墙是东西两端（x 方向两头）。
      if (p.kind === 'gable') return ridge === 'x' ? nearX : nearZ;
      // 单坡：山墙是两端加高侧。高侧在南北时坡沿 z，两端是 x 端；高侧在东西时坡沿 x，两端是 z 端。
      if (shedHigh === 'north') return nearX || z - wall.minZ < t;
      if (shedHigh === 'south') return nearX || wall.maxZ - z < t;
      if (shedHigh === 'west') return nearZ || x - wall.minX < t;
      return nearZ || wall.maxX - x < t;
    };
    for (let z = wall.minZ; z <= wall.maxZ; z += 1) {
      for (let x = wall.minX; x <= wall.maxX; x += 1) {
        if (!onGableLine(x, z)) continue;
        const roofY = heights.get(key(x, z));
        if (roofY === undefined) continue;
        for (let y = location.y; y < roofY; y += 1)
          writes.push({ x, y, z, state: gable.state, writeLayer: 'structure' });
      }
    }
  }
  return {
    bounds: b,
    peak,
    eaveLine: { footprint: r, y: location.y },
    top:
      p.kind === 'flat'
        ? {
            footprint: p.parapet === undefined ? r : rect(r.minX + 1, r.minZ + 1, r.maxX - 1, r.maxZ - 1),
            y: location.y + 1,
          }
        : undefined,
    writes,
  };
}
