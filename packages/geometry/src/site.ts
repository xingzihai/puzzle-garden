/** 柱廊、栏杆、院墙与铺装的几何计划；不登记调用，不做隐式碰撞修正。 */
import type { z } from 'zod';
import type { BlockTable } from '@pg/core/block-state';
import type { Bounds } from '@pg/core/grid';
import { rect, parse, openingSchema } from './schema.ts';
import type {
  colonnadeSchema,
  railSchema,
  enclosureSchema,
  pavingSchema,
  Facade,
  Surface,
  Point,
  Side,
} from './schema.ts';
import { bounds, boxWrites, wallWrites, openingWrites, expand } from './shapes.ts';
import { Writer } from './writer.ts';
import type { Write } from './writer.ts';

export interface SitePlan {
  readonly bounds: Bounds;
  readonly writes: readonly Write[];
}
export interface ColonnadePlan extends SitePlan {
  readonly top: Surface;
  readonly bays: readonly Surface[];
}
export interface EnclosurePlan extends SitePlan {
  readonly inner: Surface;
  readonly gate: { readonly bounds: Bounds; readonly side: Side };
  readonly gatehouse?: { readonly bounds: Bounds; readonly top: Surface };
}

/**
 * count 语义：含四角的总柱数，2a+2b−4 = count，a、b 分别为南北边（沿 x）与东西边（沿 z）每边柱数。
 * 在所有合法 (a,b) 中取两方向柱间距最接近的一组；平手时长边柱多，再平 a 大。
 * 返回区间数 (a−1, b−1)。
 */
function distributeCount(lenX: number, lenZ: number, count: number): { readonly nx: number; readonly nz: number } {
  const spanX = lenX - 1;
  const spanZ = lenZ - 1;
  const half = count / 2;
  let bestA = 2;
  let bestB = half;
  let bestNum = Math.abs(spanX * (bestB - 1) - spanZ * (bestA - 1));
  let bestDen = (bestA - 1) * (bestB - 1);
  const longer = lenX > lenZ ? 'x' : lenZ > lenX ? 'z' : 'none';
  for (let a = 3; a <= half; a += 1) {
    const b = half + 2 - a;
    const num = Math.abs(spanX * (b - 1) - spanZ * (a - 1));
    const den = (a - 1) * (b - 1);
    const cmp = num * bestDen - bestNum * den;
    const better = cmp < 0 || (cmp === 0 && (longer === 'z' ? b > bestB : a > bestA));
    if (better) {
      bestA = a;
      bestB = b;
      bestNum = num;
      bestDen = den;
    }
  }
  return { nx: bestA - 1, nz: bestB - 1 };
}

export function colonnadePlan(table: BlockTable, p: z.output<typeof colonnadeSchema>): ColonnadePlan {
  const l = p.on ?? (p.footprint !== undefined && p.y !== undefined ? { footprint: p.footprint, y: p.y } : undefined);
  if (l === undefined) throw new Error('colonnade 位置缺失');
  const r = l.footprint;
  if (r.polygon !== undefined) throw new Error('colonnade 需要矩形柱网轮廓');
  const w = p.column.width;
  const dx = r.maxX - r.minX - w + 1;
  const dz = r.maxZ - r.minZ - w + 1;
  if (dx < w + 1 || dz < w + 1)
    throw new Error(
      `column.width=${String(w)} 过大：柱廊两方向边长 x=${String(r.maxX - r.minX + 1)}、z=${String(r.maxZ - r.minZ + 1)}，` +
        `相邻角柱之间至少留一格，width 最大为 ${String(Math.min(Math.floor((r.maxX - r.minX) / 2), Math.floor((r.maxZ - r.minZ) / 2)))}`,
    );
  let nx: number;
  let nz: number;
  if (p.spacing !== undefined) {
    nx = Math.ceil(dx / p.spacing);
    nz = Math.ceil(dz / p.spacing);
  } else {
    const count = p.count ?? 4;
    if (count % 2 !== 0) throw new Error(`colonnade.count=${String(count)} 必须为偶数，才能在矩形相对边对称布柱`);
    // 可行柱数上限：柱间距要大于柱宽，nx ≤ dx/(w+1)。先拒绝放不下的 count，避免在超大 count 上枚举。
    const maxNx = Math.floor(dx / (w + 1));
    const maxNz = Math.floor(dz / (w + 1));
    if (count > 2 * (maxNx + maxNz))
      throw new Error(
        `colonnade.count=${String(count)} 使柱子相碰，柱廊两方向边长 x=${String(r.maxX - r.minX + 1)}、z=${String(r.maxZ - r.minZ + 1)}，柱间至少留一格`,
      );
    ({ nx, nz } = distributeCount(r.maxX - r.minX + 1, r.maxZ - r.minZ + 1, count));
  }
  if (nx < 1 || nz < 1 || Math.floor(dx / nx) <= w || Math.floor(dz / nz) <= w)
    throw new Error(
      `${p.count !== undefined ? `colonnade.count=${String(p.count)}` : `colonnade.spacing=${String(p.spacing)}`} 使柱子相碰，` +
        `柱廊两方向边长 x=${String(r.maxX - r.minX + 1)}、z=${String(r.maxZ - r.minZ + 1)}，柱间至少留一格`,
    );
  const writer = new Writer(table);
  const column = writer.material(p.column.material, true);
  const arm = p.column.shape === 'cross' ? 1 : 0;
  const beamHeight = p.beam === false ? 0 : (p.beam?.height ?? 1);
  const beam = p.beam === false ? undefined : writer.material(p.beam?.material ?? p.column.material, true);
  const writes: Write[] = [];
  const bays: Surface[] = [];
  const positions = new Map<string, readonly [number, number]>();
  const add = (x: number, z: number): void => {
    positions.set(`${String(x)},${String(z)}`, [x, z]);
  };
  for (let i = 0; i <= nx; i += 1) {
    const x = r.minX + Math.floor((dx * i) / nx);
    add(x, r.minZ);
    add(x, r.minZ + dz);
  }
  for (let i = 0; i <= nz; i += 1) {
    const z = r.minZ + Math.floor((dz * i) / nz);
    add(r.minX, z);
    add(r.minX + dx, z);
  }
  // 十字柱：方芯 `(w+2)² 去四角`，即芯加四面各一条长 w 的臂；臂可伸出柱网（§8.6）。
  if (arm > 0) {
    const xs = [...new Set([...positions.values()].map(([x]) => x))].sort((a, b) => a - b);
    const zs = [...new Set([...positions.values()].map(([, z]) => z))].sort((a, b) => a - b);
    for (const [axis, list] of [
      ['x', xs],
      ['z', zs],
    ] as const)
      for (let i = 1; i < list.length; i += 1) {
        const d = (list[i] ?? 0) - (list[i - 1] ?? 0);
        if (d < w + 3)
          throw new Error(`colonnade 十字柱相碰：${axis} 向柱芯间距 ${String(d)}，至少为 ${String(w + 3)}`);
      }
  }
  for (const [x, z] of positions.values()) {
    const b = bounds(rect(x, z, x + w - 1, z + w - 1), l.y, p.height);
    writes.push(...boxWrites(b.min, b.max, column, 'structure'));
    if (arm > 0)
      for (const strip of [
        rect(x - 1, z, x - 1, z + w - 1),
        rect(x + w, z, x + w, z + w - 1),
        rect(x, z - 1, x + w - 1, z - 1),
        rect(x, z + w, x + w - 1, z + w),
      ]) {
        const ab = bounds(strip, l.y, p.height);
        writes.push(...boxWrites(ab.min, ab.max, column, 'structure'));
      }
  }
  for (const [axis, n, distance] of [
    ['x', nx, dx],
    ['z', nz, dz],
  ] as const) {
    for (let i = 0; i < n; i += 1) {
      // 十字柱的臂向柱间各伸一格，bays 两端各缩 1 格（§8.6）；收成零宽就跳过。
      const a = Math.floor((distance * i) / n) + w + arm;
      const b = Math.floor((distance * (i + 1)) / n) - 1 - arm;
      if (a > b) continue;
      for (const side of [0, axis === 'x' ? dz : dx])
        bays.push({
          y: l.y,
          footprint:
            axis === 'x'
              ? rect(r.minX + a, r.minZ + side, r.minX + b, r.minZ + side + w - 1)
              : rect(r.minX + side, r.minZ + a, r.minX + side + w - 1, r.minZ + b),
        });
    }
  }
  if (beam !== undefined) writes.push(...wallWrites(r, l.y + p.height, beamHeight, w, beam));
  return {
    // 十字柱的臂伸出柱网一格；top 与额枋仍按芯线柱网（§8.6）。
    bounds: bounds(arm > 0 ? expand(r, arm) : r, l.y, p.height + beamHeight),
    top: { footprint: r, y: l.y + p.height + beamHeight },
    bays,
    writes,
  };
}

/** 栏杆要让开的格：已登记的踏步落点、门洞（x, y, z）。由世界在调用栏杆时传入（决策 #60）。 */
export interface RailKeepOut {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function railPlan(
  table: BlockTable,
  p: z.output<typeof railSchema>,
  keepOut: readonly RailKeepOut[] = [],
): SitePlan {
  const material = new Writer(table).material(p.material, true);
  const r = p.along.footprint;
  if (r.polygon !== undefined) throw new Error('rail 暂不支持多边形台基；斜边请用 set/box 手写，或改用矩形台基。');
  // 栏杆写在装饰层：落在墙脚、柱脚上时让给结构，不把墙盖成栅栏（审查 A2，台基不外挑时外缘就是墙所在的那一圈）。
  const writes = wallWrites(r, p.along.y, p.height, 1, material).map((w) => ({
    ...w,
    writeLayer: 'decoration' as const,
  }));
  const gapCells = new Set<string>();
  for (const gap of p.gaps) {
    const horizontal = gap.side === 'north' || gap.side === 'south';
    const min = horizontal ? r.minX : r.minZ;
    const max = horizontal ? r.maxX : r.maxZ;
    const start = min + Math.floor((max - min + 1 - gap.width) / 2) + gap.at;
    if (start < min || start + gap.width - 1 > max) {
      const length = max - min + 1;
      const centre = Math.floor((length - gap.width) / 2);
      throw new Error(
        `rail.gaps[${gap.side}] 放不下：缺口占 [${String(start)}, ${String(start + gap.width - 1)}]，` +
          `这条边只有 [${String(min)}, ${String(max)}]，长 ${String(length)}。` +
          (gap.width > length
            ? `width 最大为 ${String(length)}`
            : `请把 at 改到 [${String(-centre)}, ${String(length - gap.width - centre)}]`),
      );
    }
    for (let u = start; u < start + gap.width; u += 1) {
      const x = horizontal ? u : gap.side === 'east' ? r.maxX : r.minX;
      const z = horizontal ? (gap.side === 'north' ? r.minZ : r.maxZ) : u;
      gapCells.add(`${String(x)},${String(z)}`);
    }
  }
  // 自动留口：栏杆高度范围内，凡是已登记的踏步落点或门洞所在的列都不写栏杆。
  const top = p.along.y + p.height - 1;
  for (const k of keepOut) if (k.y >= p.along.y && k.y <= top) gapCells.add(`${String(k.x)},${String(k.z)}`);
  return {
    bounds: bounds(r, p.along.y, p.height),
    writes: writes.filter((w) => !gapCells.has(`${String(w.x)},${String(w.z)}`)),
  };
}

export function enclosurePlan(table: BlockTable, p: z.output<typeof enclosureSchema>): EnclosurePlan {
  const writer = new Writer(table);
  const r = p.outline;
  const writes = wallWrites(r, p.y, p.height, p.thickness, writer.material(p.material, true));
  const gate = p.gate;
  let facade: Facade = { footprint: r, y: p.y, height: p.height, thickness: p.thickness, side: gate.side };
  let total = bounds(r, p.y, p.height);
  let gatehouseInfo: EnclosurePlan['gatehouse'];
  if (gate.gatehouse !== undefined) {
    const h = gate.gatehouse;
    const horizontal = gate.side === 'north' || gate.side === 'south';
    const mid = horizontal ? Math.floor((r.minX + r.maxX) / 2) : Math.floor((r.minZ + r.maxZ) / 2);
    const start = mid + gate.at - Math.floor((h.width - 1) / 2);
    const outer =
      gate.side === 'north' ? r.minZ : gate.side === 'south' ? r.maxZ : gate.side === 'east' ? r.maxX : r.minX;
    // outward：门楼沿法线向院墙外凸；east / south 取 [outer+outward−depth+1, outer+outward]，
    // north / west 取 [outer−outward, outer−outward+depth−1]（§8.4）。
    if (h.outward > h.depth - p.thickness)
      throw new Error(
        `gatehouse.outward=${String(h.outward)} 超过 depth − thickness=${String(h.depth - p.thickness)}：门楼必须覆盖墙厚`,
      );
    const near = gate.side === 'north' || gate.side === 'west' ? outer - h.outward : outer - h.depth + 1 + h.outward;
    const hr = horizontal
      ? rect(start, near, start + h.width - 1, near + h.depth - 1)
      : rect(near, start, near + h.depth - 1, start + h.width - 1);
    // 沿墙方向仍须在轮廓内；法线方向允许外凸，所以只查与走向垂直的那一轴。
    const outsideWall = horizontal ? hr.minX < r.minX || hr.maxX > r.maxX : hr.minZ < r.minZ || hr.maxZ > r.maxZ;
    if (outsideWall) {
      throw new Error(
        `gatehouse 越出院墙：门楼占 x ∈ [${String(hr.minX)}, ${String(hr.maxX)}]、z ∈ [${String(hr.minZ)}, ${String(hr.maxZ)}]，` +
          `院墙轮廓 x ∈ [${String(r.minX)}, ${String(r.maxX)}]、z ∈ [${String(r.minZ)}, ${String(r.maxZ)}]`,
      );
    }
    // P1：法线方向不查越界（允许外凸）时，门楼朝院内一端仍不能越过对面墙的内缘：
    // 门楼必须完整落在 outline 法线方向范围内，再加 outward 外凸的部分。
    const span = horizontal ? r.maxX - r.minX + 1 : r.maxZ - r.minZ + 1;
    const maxDepth = span + h.outward - p.thickness;
    if (h.depth > maxDepth) {
      throw new Error(
        `gatehouse.depth=${String(h.depth)} 超过上限 ${String(maxDepth)}：门楼朝院内一端越过对面墙内缘` +
          `（outline 法线向长 ${String(span)}、thickness=${String(p.thickness)}、outward=${String(h.outward)}）`,
      );
    }
    if (h.depth < p.thickness) {
      throw new Error(
        `gatehouse.depth=${String(h.depth)} 小于院墙 thickness=${String(p.thickness)}：门楼必须覆盖墙厚，depth 至少为 ${String(p.thickness)}`,
      );
    }
    if (h.width < gate.width + 2) {
      throw new Error(
        `gatehouse.width=${String(h.width)} 太小：门宽=${String(gate.width)}，门洞两侧各留一格墙，width 至少为 ${String(gate.width + 2)}`,
      );
    }
    if (h.height <= gate.height) {
      throw new Error(
        `gatehouse.height=${String(h.height)} 不大于门高=${String(gate.height)}：门楼顶部要留墙，height 至少为 ${String(gate.height + 1)}`,
      );
    }
    const b = bounds(hr, p.y, h.height);
    writes.push(...boxWrites(b.min, b.max, writer.material(h.material, true), 'structure'));
    // 门楼是实心块，两侧没有相邻立面的转角墙：门洞宽度只受门楼宽度限制（上面已要求两侧各留一格墙）。
    facade = { footprint: hr, y: p.y, height: h.height, thickness: h.depth, side: gate.side, corner: false as const };
    total = bounds(
      rect(Math.min(r.minX, hr.minX), Math.min(r.minZ, hr.minZ), Math.max(r.maxX, hr.maxX), Math.max(r.maxZ, hr.maxZ)),
      p.y,
      Math.max(p.height, h.height),
    );
    gatehouseInfo = { bounds: b, top: { footprint: hr, y: p.y + h.height } };
  }
  const opening = parse(openingSchema, {
    in: facade,
    kind: 'gate',
    width: gate.width,
    height: gate.height,
    at: gate.gatehouse === undefined ? gate.at : 0,
  });
  const air = writer.material('air');
  const plan = openingWrites(opening, air, air);
  writes.push(...plan.writes);
  return {
    bounds: total,
    inner: { footprint: expand(r, -p.thickness), y: p.y },
    gate: { bounds: plan.bounds, side: gate.side },
    ...(gatehouseInfo === undefined ? {} : { gatehouse: gatehouseInfo }),
    writes,
  };
}

const OUTWARD: Record<Side, readonly [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
};

/** 路径写法（非 region）的解析结果：union 里带 from 的那一支。 */
type PavingPath = Extract<z.output<typeof pavingSchema>, { readonly from: unknown }>;
type PavingEntrance = PavingPath['from'];

/** 入口门外（outside）或门内（inside）紧邻的那一格，在地表 y = 1，取入口宽度方向的中线。 */
function entrancePoint(e: PavingEntrance, outside: boolean): Point {
  const b = e.bounds;
  const [dx, dz] = OUTWARD[e.side];
  const s = outside ? 1 : -1;
  const midX = Math.floor((b.min[0] + b.max[0]) / 2);
  const midZ = Math.floor((b.min[2] + b.max[2]) / 2);
  return [
    dx === 0 ? midX : (dx * s > 0 ? b.max[0] : b.min[0]) + dx * s,
    1,
    dz === 0 ? midZ : (dz * s > 0 ? b.max[2] : b.min[2]) + dz * s,
  ];
}

/** 铺装寻路时问世界：这一格在地表上是否已被结构挡住（墙、台基）。由世界注入，规划函数不读世界状态。 */
export type SolidQuery = (x: number, y: number, z: number) => boolean;

/** 寻路上限：起止点包围盒四周各外扩这么多格。院落级场地足够，避免在开放地面上无界搜索。 */
const ROUTE_MARGIN = 16;

/**
 * 地表四邻接最短路（广度优先，确定性：邻格按东、西、南、北的固定顺序展开）。
 * 返回从 a 到 b 的中线格序列；不通时返回 undefined。
 */
function shortestRoute(
  a: readonly [number, number],
  b: readonly [number, number],
  free: (x: number, z: number, spreadZ: boolean) => boolean,
): (readonly [number, number])[] | undefined {
  const minX = Math.min(a[0], b[0]) - ROUTE_MARGIN;
  const maxX = Math.max(a[0], b[0]) + ROUTE_MARGIN;
  const minZ = Math.min(a[1], b[1]) - ROUTE_MARGIN;
  const maxZ = Math.max(a[1], b[1]) + ROUTE_MARGIN;
  const key = (x: number, z: number): string => `${String(x)},${String(z)}`;
  const from = new Map<string, string | null>([[key(a[0], a[1]), null]]);
  const queue: (readonly [number, number])[] = [a];
  const steps: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const cur of queue) {
    if (cur[0] === b[0] && cur[1] === b[1]) {
      const path: (readonly [number, number])[] = [];
      for (let k: string | null | undefined = key(cur[0], cur[1]); k !== null && k !== undefined; k = from.get(k)) {
        const [x, z] = k.split(',').map(Number) as [number, number];
        path.push([x, z]);
      }
      return path.reverse();
    }
    for (const [dx, dz] of steps) {
      const x = cur[0] + dx;
      const z = cur[1] + dz;
      if (x < minX || x > maxX || z < minZ || z > maxZ || from.has(key(x, z))) continue;
      // 沿这一步的方向检查整条路宽能否通过
      if (!free(x, z, dx !== 0)) continue;
      from.set(key(x, z), key(cur[0], cur[1]));
      queue.push([x, z]);
    }
  }
  return undefined;
}

export function pavingPlan(
  table: BlockTable,
  p: z.output<typeof pavingSchema>,
  solid: SolidQuery = () => false,
): SitePlan {
  const material = new Writer(table).material(p.material, true);
  // region 写法：整片矩形在 y=1 各写一格，不跳过已有结构格，胜负交给合成（§8.3）。
  if ('region' in p)
    return {
      bounds: bounds(p.region, 1, 1),
      writes: boxWrites([p.region.minX, 1, p.region.minZ], [p.region.maxX, 1, p.region.maxZ], material, 'decoration'),
    };
  const half = Math.floor((p.width - 1) / 2);
  const key = (x: number, z: number): string => `${String(x)},${String(z)}`;
  // 一条路宽 width：中线格向两侧各展开；中线格可走 = 展开后的整排都不挡人。
  const free = (x: number, z: number, spreadZ: boolean): boolean => {
    for (let i = -half; i < p.width - half; i += 1) {
      if (solid(x + (spreadZ ? 0 : i), 1, z + (spreadZ ? i : 0))) return false;
    }
    return true;
  };
  let route: (readonly [number, number])[];
  if (typeof p.to === 'number') {
    // 长度写法：沿入口外法线直铺 to 格。入口外面先是台基、踏步时，从它们外面第一格空地起铺
    // （铺装在地表上，踏步已经通到这里）；之后路上再遇到结构就报错，不铺一半。
    const first = entrancePoint(p.from, true);
    const [dx, dz] = OUTWARD[p.from.side];
    let start: readonly [number, number] = [first[0], first[2]];
    for (let i = 0; i < ROUTE_MARGIN && !free(start[0], start[1], dx !== 0); i += 1) {
      start = [start[0] + dx, start[1] + dz];
    }
    route = [];
    for (let i = 0; i < p.to; i += 1) route.push([start[0] + dx * i, start[1] + dz * i]);
    const blocked = route.find(([x, z]) => !free(x, z, dx !== 0));
    if (blocked !== undefined) {
      throw new Error(
        `paving 从入口向外铺 ${String(p.to)} 格，在 (${String(blocked[0])}, 1, ${String(blocked[1])}) 被已有结构挡住；` +
          '请缩短 to，或改用两入口写法让铺装自动绕开',
      );
    }
  } else {
    // 两入口写法：两端各有门外、门内两个候选起点，选两端相通的一对（同一片场地），在地表上做最短路。
    // 结果与此前已写的墙有关（决策 #62）：铺装要在墙之后写，路才会绕开墙。
    const to = p.to;
    // P2：门外端点在台基 / 踏步上时，沿外法线走到它们外面第一块空地（与长度写法一致）。
    const outsidePoint = (e: PavingEntrance): Point => {
      const first = entrancePoint(e, true);
      const [dx, dz] = OUTWARD[e.side];
      let x = first[0];
      let z = first[2];
      for (let i = 0; i < ROUTE_MARGIN && !free(x, z, dx !== 0); i += 1) {
        x += dx;
        z += dz;
      }
      return [x, 1, z];
    };
    const point = (e: PavingEntrance, out: boolean): Point => (out ? outsidePoint(e) : entrancePoint(e, false));
    const candidates: { readonly a: Point; readonly b: Point }[] = [];
    for (const fromOut of [true, false]) {
      for (const toOut of [true, false]) candidates.push({ a: point(p.from, fromOut), b: point(to, toOut) });
    }
    let best: (readonly [number, number])[] | undefined;
    for (const { a, b } of candidates) {
      if (!free(a[0], a[2], true) && !free(a[0], a[2], false)) continue;
      const found = shortestRoute([a[0], a[2]], [b[0], b[2]], free);
      if (found !== undefined && (best === undefined || found.length < best.length)) best = found;
    }
    if (best === undefined) {
      throw new Error(
        'paving 连不通两个入口：两入口之间的地面被结构隔开（或路宽放不下）。' +
          '请减小 width，或检查两个入口是否在同一片场地上',
      );
    }
    route = best;
  }
  const positions = new Map<string, Write>();
  route.forEach(([x, z], i) => {
    // 路宽垂直于走向展开：沿 x 走（相邻格同 z）就在 z 方向展开。拐角处两个方向都展开，补满转角。
    // 只有一格的路（长度 1）按入口的外法线定走向。
    const prev = route[i - 1];
    const next = route[i + 1];
    const axes = new Set<boolean>();
    for (const n of [prev, next]) if (n !== undefined) axes.add(n[1] === z);
    if (axes.size === 0) axes.add(OUTWARD[p.from.side][0] !== 0);
    for (const spreadZ of axes) {
      for (let k = -half; k < p.width - half; k += 1) {
        const px = x + (spreadZ ? 0 : k);
        const pz = z + (spreadZ ? k : 0);
        positions.set(key(px, pz), { x: px, y: 1, z: pz, state: material, writeLayer: 'decoration' });
      }
    }
  });
  const writes = [...positions.values()];
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const w of writes) {
    minX = Math.min(minX, w.x);
    minZ = Math.min(minZ, w.z);
    maxX = Math.max(maxX, w.x);
    maxZ = Math.max(maxZ, w.z);
  }
  const r = rect(minX, minZ, maxX, maxZ);
  return { bounds: bounds(r, 1, 1), writes };
}
