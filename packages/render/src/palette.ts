/**
 * 方块状态 + BlockInfo → 渲染调色板项（RENDER-SPEC §6.1、§6.3）。
 *
 * 负责：把方块形态映射到画法编号（PAINT 定义在 mesh.ts），给出朝向 / 半格 / 开启 / 轴向等参数与颜色。
 * 不负责：盒子几何（mesh.ts）、紧凑格表（scene-buffer.ts）。本文件是纯函数（不依赖注册表实例）。
 *
 * 参数约定（params[0..3]，均为 0–255）见 mesh.ts 的 boxesFor：
 *   door          facing, half, hinge, open
 *   trapdoor      facing, half, —, open
 *   fence_gate    facing, in_wall, —, open
 *   stairs        facing, half, shape, —
 *   button        face, facing, —, —
 *   plant         height(1/16), —, —, —
 *   sign          kind(0 standing / 1 wall), orientation/facing, rotation, —
 *   chest         facing, —, —, —
 *   axis_cube     axis(0 y / 1 x / 2 z), —, —, —
 * 均为视觉近似：不使用纹理，朝向取格边/轴向，不追求与原版模型逐像素一致。
 */

import { isAir } from '@pg/core/block-state';
import type { BlockState } from '@pg/core/block-state';
import type { BlockInfo } from '@pg/blocks/registry';

import { PAINT } from './mesh.ts';

/** 技术方块：不可见，计入 skipped（RENDER-SPEC §6.1）。 */
const SKIP_IDS: ReadonlySet<string> = new Set(['barrier', 'light', 'structure_void']);

/** 形态为 light 但按完整 cube 画的方块（RENDER-SPEC §6.1，写死）。 */
export const LIGHT_FULL_IDS: ReadonlySet<string> = new Set([
  'glowstone',
  'sea_lantern',
  'shroomlight',
  'redstone_lamp',
  'crying_obsidian',
  'jack_o_lantern',
  'beacon',
  'ochre_froglight',
  'verdant_froglight',
  'pearlescent_froglight',
]);

/** source 为 none 且要画的方块用兜底色（RENDER-SPEC §6.3）。 */
export const FALLBACK_RGB: readonly [number, number, number] = [0xb4, 0xb4, 0xb4];

/** 水平朝向：north/east/south/west → 0–3（RENDER-SPEC §6.2）。 */
const FACING: Readonly<Record<string, number>> = { north: 0, east: 1, south: 2, west: 3 };
/** 方块 axis 属性：y/x/z → 0–2（0 为默认）。 */
const AXIS: Readonly<Record<string, number>> = { y: 0, x: 1, z: 2 };
/** stairs 的 shape：straight 为 0，其余为四个转角。 */
const STAIRS_SHAPE: Readonly<Record<string, number>> = {
  straight: 0,
  outer_left: 1,
  outer_right: 2,
  inner_left: 3,
  inner_right: 4,
};
/** 按钮的附着面：floor / wall / ceiling。 */
const BUTTON_FACE: Readonly<Record<string, number>> = { floor: 0, wall: 1, ceiling: 2 };

/** 带 axis 属性、需要区分端面与侧面的原木 / 木柱 / 石材柱。 */
const AXIS_CUBE_IDS: ReadonlySet<string> = new Set([
  'basalt',
  'polished_basalt',
  'deepslate',
  'infested_deepslate',
  'hay_block',
  'bone_block',
  'bamboo_block',
  'stripped_bamboo_block',
  'muddy_mangrove_roots',
]);
const AXIS_CUBE_SUFFIXES = ['_log', '_wood', '_stem', '_hyphae', '_pillar'] as const;

/** 没有 axis 属性、但顶面 / 侧面明显不同的方块：按 y 轴做亮度近似。 */
const SIX_FACE_IDS: ReadonlySet<string> = new Set([
  'grass_block',
  'mycelium',
  'podzol',
  'crimson_nylium',
  'warped_nylium',
  'dirt_path',
  'farmland',
]);

/** shape=other 中需要专用盒子的高频家具。 */
const CHEST_IDS: ReadonlySet<string> = new Set(['chest', 'trapped_chest', 'ender_chest']);

/** shape=plant 里实际上是整块的方块，仍按 cube 画（避免变成十字）。 */
const PLANT_FULL_IDS: ReadonlySet<string> = new Set([
  'carved_pumpkin',
  'chorus_plant',
  'moss_block',
  'muddy_mangrove_roots',
]);

/** shape=plant 里应贴地而不是立十字的方块。 */
const FLAT_PLANTS: ReadonlySet<string> = new Set(['lily_pad', 'moss_carpet', 'pink_petals']);

/** 较高的植物用满格高度；其余默认 12/16。 */
const TALL_PLANTS: ReadonlySet<string> = new Set([
  'bamboo',
  'big_dripleaf',
  'big_dripleaf_stem',
  'cave_vines',
  'cave_vines_plant',
  'hanging_roots',
  'kelp',
  'kelp_plant',
  'large_fern',
  'lilac',
  'peony',
  'rose_bush',
  'seagrass',
  'small_dripleaf',
  'sugar_cane',
  'sunflower',
  'tall_grass',
  'tall_seagrass',
  'twisting_vines',
  'twisting_vines_plant',
  'weeping_vines',
  'weeping_vines_plant',
]);

function isAxisCubeId(id: string): boolean {
  if (AXIS_CUBE_IDS.has(id)) return true;
  return AXIS_CUBE_SUFFIXES.some((suffix) => id.endsWith(suffix));
}

/** 返回轴向画法参数；未知方块返回 undefined。 */
function axisOf(state: BlockState, info: BlockInfo): number | undefined {
  if (SIX_FACE_IDS.has(info.id)) return 0;
  if (!isAxisCubeId(info.id)) return undefined;
  return AXIS[state.props['axis'] ?? 'y'] ?? 0;
}

/** 告示牌种类：0 站立、1 贴墙；不是告示牌返回 undefined。 */
function signKind(id: string): 0 | 1 | undefined {
  if (id.endsWith('_wall_sign') || id.endsWith('_wall_hanging_sign')) return 1;
  if (id.endsWith('_sign') || id.endsWith('_hanging_sign')) return 0;
  return undefined;
}

function plantHeight(id: string): number {
  if (id.endsWith('_sapling') || id === 'bamboo_sapling') return 8;
  if (id === 'grass' || id === 'fern') return 10;
  return TALL_PLANTS.has(id) ? 16 : 12;
}

export interface PaletteItem {
  readonly paint: number;
  readonly params: readonly [number, number, number, number];
  /** 0–255 的 sRGB 分量。 */
  readonly rgb: readonly [number, number, number];
  /** 颜色缺失、用了兜底色：方块名要记进 SceneStats.fallbackColor。 */
  readonly fallback: boolean;
  /** 官方模型 id；0 表示没有官方资源，走简化几何。 */
  readonly model: number;
}

function rgbOf(rgb: number): readonly [number, number, number] {
  return [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
}

/** 映射一个方块状态到画法编号、参数与颜色。官方模型 id 由调用方查目录后传入。 */
export function paletteItem(state: BlockState, info: BlockInfo, model = 0): PaletteItem {
  const color = info.color;
  const rgb: readonly [number, number, number] = color.source === 'none' ? FALLBACK_RGB : rgbOf(color.rgb);
  const fallback = color.source === 'none' && model === 0;

  if (isAir(state) || SKIP_IDS.has(info.id)) {
    return { paint: PAINT.skip, params: [0, 0, 0, 0], rgb, fallback: false, model: 0 };
  }

  const shape = info.shape;
  const id = info.id;
  let paint: number;
  const params: [number, number, number, number] = [0, 0, 0, 0];
  if (shape === 'cube') {
    const axis = axisOf(state, info);
    if (axis === undefined) {
      paint = PAINT.cube;
    } else {
      paint = PAINT.axis_cube;
      params[0] = axis;
    }
  } else if (shape === 'light') {
    paint = LIGHT_FULL_IDS.has(id) ? PAINT.cube : PAINT.small;
  } else if (shape === 'glass') {
    paint = PAINT.glass;
  } else if (shape === 'slab') {
    if (state.props['type'] === 'double') {
      paint = PAINT.cube;
    } else {
      paint = PAINT.slab;
      params[0] = state.props['type'] === 'top' ? 1 : 0;
    }
  } else if (shape === 'stairs') {
    paint = PAINT.stairs;
    params[0] = FACING[state.props['facing'] ?? 'north'] ?? 0;
    params[1] = state.props['half'] === 'top' ? 1 : 0;
    params[2] = STAIRS_SHAPE[state.props['shape'] ?? 'straight'] ?? 0;
  } else if (shape === 'fence') {
    paint = PAINT.fence;
  } else if (shape === 'wall') {
    paint = PAINT.wall;
  } else if (shape === 'pane') {
    paint = PAINT.pane;
  } else if (shape === 'fluid') {
    paint = PAINT.fluid;
  } else if (shape === 'door') {
    paint = PAINT.door;
    params[0] = FACING[state.props['facing'] ?? 'north'] ?? 0;
    params[1] = state.props['half'] === 'upper' ? 1 : 0;
    params[2] = state.props['hinge'] === 'right' ? 1 : 0;
    params[3] = state.props['open'] === 'true' ? 1 : 0;
  } else if (shape === 'trapdoor') {
    paint = PAINT.trapdoor;
    params[0] = FACING[state.props['facing'] ?? 'north'] ?? 0;
    params[1] = state.props['half'] === 'top' ? 1 : 0;
    params[3] = state.props['open'] === 'true' ? 1 : 0;
  } else if (shape === 'fence_gate') {
    paint = PAINT.fence_gate;
    params[0] = FACING[state.props['facing'] ?? 'north'] ?? 0;
    params[1] = state.props['in_wall'] === 'true' ? 1 : 0;
    params[3] = state.props['open'] === 'true' ? 1 : 0;
  } else if (shape === 'carpet') {
    paint = PAINT.carpet;
  } else if (shape === 'pressure_plate') {
    paint = PAINT.pressure_plate;
  } else if (shape === 'button') {
    paint = PAINT.button;
    params[0] = BUTTON_FACE[state.props['face'] ?? 'wall'] ?? 1;
    params[1] = FACING[state.props['facing'] ?? 'north'] ?? 0;
  } else if (shape === 'plant') {
    if (FLAT_PLANTS.has(id)) {
      paint = PAINT.carpet;
    } else if (PLANT_FULL_IDS.has(id)) {
      const axis = axisOf(state, info);
      if (axis === undefined) {
        paint = PAINT.cube;
      } else {
        paint = PAINT.axis_cube;
        params[0] = axis;
      }
    } else {
      paint = PAINT.plant;
      params[0] = plantHeight(id);
    }
  } else if (shape === 'other') {
    const axis = axisOf(state, info);
    const kind = signKind(id);
    if (axis !== undefined) {
      paint = PAINT.axis_cube;
      params[0] = axis;
    } else if (CHEST_IDS.has(id)) {
      paint = PAINT.chest;
      params[0] = FACING[state.props['facing'] ?? 'north'] ?? 0;
    } else if (kind !== undefined) {
      paint = PAINT.sign;
      params[0] = kind;
      if (kind === 1) {
        params[1] = FACING[state.props['facing'] ?? 'north'] ?? 0;
      } else {
        const rotation = Number.parseInt(state.props['rotation'] ?? '0', 10);
        params[1] = Number.isFinite(rotation) ? Math.floor(rotation / 4) % 4 : 0;
        params[2] = Number.isFinite(rotation) ? rotation : 0;
      }
    } else {
      paint = PAINT.small;
    }
  } else {
    // sheet / 其余低频形态仍用 8×8×8 小方块。
    paint = PAINT.small;
  }
  return { paint, params, rgb, fallback, model };
}
