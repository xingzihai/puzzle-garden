/**
 * 旋转壳屋面草模：createRoofExample(variant) 返回“同一粗建筑”三种屋面 profile 的 Blueprint。
 *
 * 负责：只放一块基底平板、一个圆厅空间盒和一片独立的 lathe 屋面薄壳；
 * 三版 id 相同、revision 不同，仅屋面 profile 的 kind / curvature 变化（k = 0 / 2 / 6）。
 * 不负责：把 lathe 采样成三角面（浏览器渲染层按整数参数生成浮点几何）、净空与路线检查（clearances 为空）。
 *
 * 为什么不在数据里存函数：Element 只记白名单参数（kind / curvature / 分段数）与包围盒，
 * 不存、也不 eval 任何源码字符串；半径由消费方按 kind 求值：
 *   linear     r(t) = R·(1−t)
 *   reciprocal r(t) = R·(1−t)/(1+k·t) = R·(1+k)/(k·(1+k·t))−R/k，t∈[0,1]
 * 约定：lathe 绕 y 轴（direction=1），底半径 R（t=0）、顶半径 0（t=1）、总高 H；坐标全为整数。
 */
import type { Element, Space } from './schema.ts';
import { Blueprint, LatheProfile } from './schema.ts';
import { PALETTE } from './example-interiors.ts';
import { vec } from './example-geometry.ts';

export type RoofVariant = 'cone' | 'reciprocal' | 'curved';

/** 圆厅半径 R 与壳高 H；基底平板与空间盒都按 2R 取 x/z 跨度（偶数，轴在整数中心）。 */
const RADIUS = 16;
const HEIGHT = 24;
/** 楼面标高与屋面壳基标高（= 圆厅天花）：净高 BASE_Y − FLOOR_Y = 12。 */
const FLOOR_Y = 0;
const BASE_Y = 12;
/** 采样分段：只记整数，浏览器负责生成浮点顶点。 */
const HEIGHT_SEGMENTS = 24;
const RADIAL_SEGMENTS = 48;

/** 三版 profile 只差 kind / curvature；分段数三版一致，便于只对照曲面形状。 */
const PROFILES: Record<RoofVariant, { readonly kind: 'linear' | 'reciprocal'; readonly curvature: number }> = {
  cone: { kind: 'linear', curvature: 0 },
  reciprocal: { kind: 'reciprocal', curvature: 2 },
  curved: { kind: 'reciprocal', curvature: 6 },
};

/** 同 id 不同 revision：cone=1、reciprocal=2、curved=3。 */
const REVISIONS: Record<RoofVariant, number> = { cone: 1, reciprocal: 2, curved: 3 };

/** 圆厅空间盒：楼面到天花净高 12；只是显示范围，不是实体，也没有墙与家具。 */
function roomSpace(): Space {
  return {
    id: 'sp-room',
    name: '圆厅',
    level: 'surface',
    bounds: { min: vec(-RADIUS, FLOOR_Y, -RADIUS), max: vec(RADIUS, BASE_Y, RADIUS) },
    role: 'room',
    color: PALETTE.glazing,
  };
}

/** 基底平板：占 [y−1, y)，顶面即楼面 y=0。 */
function baseSlab(): Element {
  return {
    id: 'base-slab',
    name: '基底平板',
    level: 'surface',
    kind: 'slab',
    bounds: { min: vec(-RADIUS, FLOOR_Y - 1, -RADIUS), max: vec(RADIUS, FLOOR_Y, RADIUS) },
    color: PALETTE.slab,
    shape: 'box',
    direction: 1,
  };
}

/**
 * 独立屋面薄壳：shape=lathe，bounds 只给包围盒（x/z 跨度 2R 偶数、高 H），
 * 不含实心内部；三角面顶点由渲染层按 profile 采样生成。本 schema 无专用“屋面”kind，按 slab 记结构面。
 */
function roofElement(profile: LatheProfile): Element {
  return {
    id: 'roof-profile',
    name: '旋转壳屋面',
    level: 'roof',
    kind: 'slab',
    bounds: { min: vec(-RADIUS, BASE_Y, -RADIUS), max: vec(RADIUS, BASE_Y + HEIGHT, RADIUS) },
    color: PALETTE.exteriorWall,
    shape: 'lathe',
    direction: 1,
    profile,
  };
}

/** 楼层标高表：街面 y=0、屋面壳基 y=12（元素 level 'roof' 指向它）。 */
function levels(): Blueprint['levels'] {
  return [
    { id: 'surface', name: '街面', elevation: FLOOR_Y },
    { id: 'roof', name: '屋面壳基', elevation: BASE_Y },
  ];
}

/** 说明：粗建筑尺寸、半径公式与三版差异；不把参数写成可执行源码。 */
function notes(variant: RoofVariant): string[] {
  const profile = PROFILES[variant];
  return [
    `粗建筑：半径 R=${String(RADIUS)} 的圆厅，楼面 y=${String(FLOOR_Y)}、天花（壳基）y=${String(BASE_Y)}，净高 ${String(BASE_Y - FLOOR_Y)}。`,
    '只含基底平板（占 [y−1, y)）、圆厅空间盒与一片独立屋面薄壳；无墙、无家具。',
    `屋面 lathe：底半径 R=${String(RADIUS)}（t=0）、顶半径 0（t=1）、高 H=${String(HEIGHT)}，壳基 y=${String(BASE_Y)}、顶端 y=${String(BASE_Y + HEIGHT)}；画三角面薄壳，不填充实心内部。`,
    '半径公式：linear r(t)=R·(1−t)；reciprocal r(t)=R·(1−t)/(1+k·t)=R·(1+k)/(k·(1+k·t))−R/k，t∈[0,1]。',
    `本版 ${variant}：kind=${profile.kind}、curvature=${String(profile.curvature)}、heightSegments=${String(HEIGHT_SEGMENTS)}、radialSegments=${String(RADIAL_SEGMENTS)}。`,
    '三版同 id 不同 revision，只有屋面 profile 变化，基底平板与圆厅空间不动；clearances 为空，不做净空与路线检查。',
  ];
}

/** 生成一版旋转壳屋面草模；variant 缺省为 cone。 */
export function createRoofExample(variant: RoofVariant = 'cone'): Blueprint {
  const def = PROFILES[variant];
  const profile = LatheProfile.parse({
    kind: def.kind,
    curvature: def.curvature,
    heightSegments: HEIGHT_SEGMENTS,
    radialSegments: RADIAL_SEGMENTS,
  });
  return Blueprint.parse({
    id: 'bp-roof-lathe',
    revision: REVISIONS[variant],
    title: '圆厅旋转壳屋面（概念草模）',
    description: '同一粗建筑的三种旋转壳屋面：线性锥面与两种反比例曲面，只对照屋面 profile。',
    levels: levels(),
    spaces: [roomSpace()],
    elements: [baseSlab(), roofElement(profile)],
    clearances: [],
    notes: notes(variant),
  });
}
