/**
 * 草模几何原语（MASSING-SPEC §1–2）。
 *
 * 负责：构造轴对齐盒与沿 x/z 的斜顶楔体；把一面墙按门洞拆成多段；把一块楼板扣出若干矩形洞；
 * 把一段楼梯铺成逐级盒。所有产物都是 schema 的 Element（bounds 半开区间，id 由调用方保证唯一）。
 * 不负责：具体房间布局、楼层标高、净空定义（见 example.ts / example-interiors.ts）；
 * 也不做求交与校验（见 checks.ts / schema.ts）。
 *
 * 为什么集中成原语：门洞与板洞若各写一遍，很容易漏段、重叠或算错保留面积；集中后可单测。
 */
import type { Bounds, Direction, Element, ElementKind, ElementShape, Vec3 } from './schema.ts';

/** 元素的 shape / direction / spaceId 附加项；缺省由 element() 补齐。 */
export interface ElementOptions {
  readonly shape?: ElementShape;
  readonly direction?: Direction;
  readonly spaceId?: string;
}

/** 构造只读三元组，避免把 `number[]` 误当 Vec3。 */
export function vec(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

/** 生成一个元素；缺省 shape=box、direction=1。spaceId 只在给出时才带（exactOptionalPropertyTypes）。 */
export function element(
  id: string,
  name: string,
  level: string,
  kind: ElementKind,
  min: Vec3,
  max: Vec3,
  color: string,
  options: ElementOptions = {},
): Element {
  const bounds: Bounds = { min, max };
  const base = {
    id,
    name,
    level,
    kind,
    bounds,
    color,
    shape: options.shape ?? 'box',
    direction: options.direction ?? 1,
  };
  return options.spaceId === undefined ? base : { ...base, spaceId: options.spaceId };
}

/** 一个待生成的盒定义元组：[id, name, kind, min, max, color]。用元组写可保持一行，避免逐参换行。 */
export type BoxTuple = readonly [string, string, ElementKind, Vec3, Vec3, string];

/** 一个待生成的楔体定义元组，末尾多 shape 与 direction（高端方向）。 */
export type WedgeTuple = readonly [string, string, ElementKind, Vec3, Vec3, string, ElementShape, Direction];

/**
 * 一面待生成的墙元组：[idPrefix, name, level, color, axis, from, to, crossStart, thickness, yMin, yMax, 洞口]。
 * 洞口用扁平 [from,to,from,to,…] 表达，避免嵌套对象把调用拆成多行。
 */
export type WallTuple = readonly [
  string,
  string,
  string,
  string,
  'x' | 'z',
  number,
  number,
  number,
  number,
  number,
  number,
  readonly number[],
];

/** 一段待生成的楼梯元组：[idPrefix, name, level, color, axis, start, end, crossStart, crossSize, baseY, topAtStart, rise, stepCount]。 */
export type StepTuple = readonly [
  string,
  string,
  string,
  string,
  'x' | 'z',
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** 同一楼层的批量盒定义转成元素；缺省 shape=box、direction=1。 */
export function boxes(level: string, defs: readonly BoxTuple[]): Element[] {
  return defs.map(([id, name, kind, min, max, color]) => {
    const bounds: Bounds = { min, max };
    return { id, name, level, kind, bounds, color, shape: 'box' as const, direction: 1 as const };
  });
}

/** 同一楼层的批量楔体定义转成元素。 */
export function wedges(level: string, defs: readonly WedgeTuple[]): Element[] {
  return defs.map(([id, name, kind, min, max, color, shape, direction]) => {
    const bounds: Bounds = { min, max };
    return { id, name, level, kind, bounds, color, shape, direction };
  });
}

/** 墙上的一个门洞，沿墙轴线的半开区间 [from, to)。 */
export interface Opening {
  readonly from: number;
  readonly to: number;
}

export interface WallParams {
  readonly idPrefix: string;
  readonly name: string;
  readonly level: string;
  readonly color: string;
  /** 墙的延伸轴：x 表示东西向墙，z 表示南北向墙。 */
  readonly axis: 'x' | 'z';
  readonly from: number;
  readonly to: number;
  /** 横向方向的起点；x 向墙的横向是 z，z 向墙的横向是 x。 */
  readonly crossStart: number;
  readonly thickness: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly kind?: ElementKind;
  readonly openings?: readonly Opening[];
  readonly spaceId?: string;
}

/**
 * 沿一条直线铺墙，按门洞切成若干轴对齐段；门洞处不生成实体。
 * 段与段在门洞边界处面贴面，半开区间下不相交。门洞完全在墙范围外时被忽略。
 */
export function wallWithOpenings(params: WallParams): Element[] {
  const openings = [...(params.openings ?? [])]
    .map((opening) => ({ from: Math.max(params.from, opening.from), to: Math.min(params.to, opening.to) }))
    .filter((opening) => opening.from < opening.to)
    .sort((a, b) => a.from - b.from);

  const segments: { readonly start: number; readonly end: number }[] = [];
  let cursor = params.from;
  for (const opening of openings) {
    if (opening.from > cursor) segments.push({ start: cursor, end: opening.from });
    cursor = Math.max(cursor, opening.to);
  }
  if (cursor < params.to) segments.push({ start: cursor, end: params.to });

  const multiple = segments.length > 1;
  const options: ElementOptions = params.spaceId === undefined ? {} : { spaceId: params.spaceId };
  return segments.map((segment, index) => {
    const min =
      params.axis === 'x'
        ? vec(segment.start, params.yMin, params.crossStart)
        : vec(params.crossStart, params.yMin, segment.start);
    const max =
      params.axis === 'x'
        ? vec(segment.end, params.yMax, params.crossStart + params.thickness)
        : vec(params.crossStart + params.thickness, params.yMax, segment.end);
    const suffix = multiple ? `-${String(index + 1)}` : '';
    return element(
      `${params.idPrefix}${suffix}`,
      `${params.name}${multiple ? `段${String(index + 1)}` : ''}`,
      params.level,
      params.kind ?? 'wall',
      min,
      max,
      params.color,
      options,
    );
  });
}

/** 楼板上的一个矩形洞（沿水平面），半开区间。 */
export interface RectHole {
  readonly xMin: number;
  readonly xMax: number;
  readonly zMin: number;
  readonly zMax: number;
}

export interface SlabParams {
  readonly idPrefix: string;
  readonly name: string;
  readonly level: string;
  readonly color: string;
  readonly xMin: number;
  readonly xMax: number;
  readonly zMin: number;
  readonly zMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly holes?: readonly RectHole[];
  readonly kind?: ElementKind;
  readonly spaceId?: string;
}

/**
 * 一块水平楼板扣掉若干互不重叠的矩形洞。做法：把洞的边界并入网格线，
 * 逐格判断格心是否落在某个洞内；洞内不生成实体，其余格各自成一块盒。
 * 洞边界必须严格落在板内，否则该边界被忽略（洞的无效部分落在板外）。
 */
export function slabWithHoles(params: SlabParams): Element[] {
  const xs = [params.xMin, params.xMax];
  const zs = [params.zMin, params.zMax];
  for (const hole of params.holes ?? []) {
    for (const value of [hole.xMin, hole.xMax]) {
      if (value > params.xMin && value < params.xMax) xs.push(value);
    }
    for (const value of [hole.zMin, hole.zMax]) {
      if (value > params.zMin && value < params.zMax) zs.push(value);
    }
  }
  const ux = [...new Set(xs)].sort((a, b) => a - b);
  const uz = [...new Set(zs)].sort((a, b) => a - b);

  const options: ElementOptions = params.spaceId === undefined ? {} : { spaceId: params.spaceId };
  const out: Element[] = [];
  for (let i = 0; i < ux.length - 1; i += 1) {
    for (let j = 0; j < uz.length - 1; j += 1) {
      const x0 = ux[i] ?? params.xMin;
      const x1 = ux[i + 1] ?? params.xMax;
      const z0 = uz[j] ?? params.zMin;
      const z1 = uz[j + 1] ?? params.zMax;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const inHole = (params.holes ?? []).some(
        (hole) => cx > hole.xMin && cx < hole.xMax && cz > hole.zMin && cz < hole.zMax,
      );
      if (inHole) continue;
      const index = out.length + 1;
      out.push(
        element(
          `${params.idPrefix}-${String(index)}`,
          `${params.name}-${String(index)}`,
          params.level,
          params.kind ?? 'slab',
          vec(x0, params.yMin, z0),
          vec(x1, params.yMax, z1),
          params.color,
          options,
        ),
      );
    }
  }
  return out;
}

export interface StepRunParams {
  readonly idPrefix: string;
  readonly name: string;
  readonly level: string;
  readonly color: string;
  /** 梯跑延伸轴。 */
  readonly axis: 'x' | 'z';
  readonly start: number;
  readonly end: number;
  readonly crossStart: number;
  readonly crossSize: number;
  /** 踏步底面标高（下层楼面顶面）。 */
  readonly baseY: number;
  /** start 处第一级的踏面标高；后续每级累加 rise（可为负表示下行）。 */
  readonly topAtStart: number;
  readonly rise: number;
  readonly stepCount: number;
}

/**
 * 把一段楼梯铺成逐级盒：第 j 级占沿轴 [start+j·d, start+(j+1)·d)，顶面 topAtStart + j·rise。
 * 要求 (end-start) 能被 stepCount 整除，否则抛错（静默取整会做出对不上的标高）。
 * 各级在沿轴方向互不重叠（半开相邻），因此即使竖向范围重叠也不会互相穿插。
 */
export function stepRun(params: StepRunParams): Element[] {
  const span = params.end - params.start;
  if (params.stepCount <= 0 || span % params.stepCount !== 0) {
    throw new Error(`stepRun ${params.idPrefix}：跨度 ${String(span)} 无法均分为 ${String(params.stepCount)} 级`);
  }
  const depth = span / params.stepCount;
  const out: Element[] = [];
  for (let j = 0; j < params.stepCount; j += 1) {
    const alongMin = params.start + j * depth;
    const alongMax = alongMin + depth;
    const top = params.topAtStart + j * params.rise;
    const min =
      params.axis === 'x'
        ? vec(alongMin, params.baseY, params.crossStart)
        : vec(params.crossStart, params.baseY, alongMin);
    const max =
      params.axis === 'x'
        ? vec(alongMax, top, params.crossStart + params.crossSize)
        : vec(params.crossStart + params.crossSize, top, alongMax);
    out.push(
      element(
        `${params.idPrefix}-${String(j + 1)}`,
        `${params.name}第${String(j + 1)}级`,
        params.level,
        'stair',
        min,
        max,
        params.color,
      ),
    );
  }
  return out;
}

/** 批量墙：把扁平洞口 [from,to,…] 还原成 Opening[]，逐条调用 wallWithOpenings。 */
export function batchWalls(defs: readonly WallTuple[]): Element[] {
  return defs.flatMap(([idPrefix, name, level, color, axis, from, to, crossStart, thickness, yMin, yMax, flat]) => {
    const openings: Opening[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      openings.push({ from: flat[i] ?? 0, to: flat[i + 1] ?? 0 });
    }
    return wallWithOpenings({
      idPrefix,
      name,
      level,
      color,
      axis,
      from,
      to,
      crossStart,
      thickness,
      yMin,
      yMax,
      openings,
    });
  });
}

/** 批量楼梯：逐条调用 stepRun。 */
export function batchSteps(defs: readonly StepTuple[]): Element[] {
  return defs.flatMap(
    ([idPrefix, name, level, color, axis, start, end, crossStart, crossSize, baseY, topAtStart, rise, stepCount]) =>
      stepRun({
        idPrefix,
        name,
        level,
        color,
        axis,
        start,
        end,
        crossStart,
        crossSize,
        baseY,
        topAtStart,
        rise,
        stepCount,
      }),
  );
}
