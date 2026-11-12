/** palette.ts：形态 → 画法编号、light 名单、朝向参数、轴向方块与兜底色（RENDER-SPEC §6、§12 第 2 条）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';

import { PAINT } from './mesh.ts';
import { FALLBACK_RGB, LIGHT_FULL_IDS, paletteItem } from './palette.ts';

const registry = loadRegistry();
const table = registry.table;
const PAINT_VALUES = new Set<number>(Object.values(PAINT));

function item(id: string, stateText = id): ReturnType<typeof paletteItem> {
  const info = registry.get(id);
  if (info === undefined) throw new Error(`夹具缺少方块 ${id}`);
  return paletteItem(parseState(table, stateText), info);
}

test('18 种形态都映射到已定义的画法', () => {
  const shapes = new Set<string>();
  for (const id of registry.ids()) {
    const info = registry.get(id);
    if (info === undefined) continue;
    shapes.add(info.shape);
    const paint = item(id).paint;
    assert.ok(PAINT_VALUES.has(paint), `${id}(${info.shape}) paint=${String(paint)}`);
  }
  assert.equal(shapes.size, 18, [...shapes].sort().join(','));
});

test('skip 四类：air、barrier、light、structure_void', () => {
  assert.equal(item('air').paint, PAINT.skip);
  assert.equal(item('cave_air').paint, PAINT.skip);
  assert.equal(item('barrier').paint, PAINT.skip);
  assert.equal(item('light').paint, PAINT.skip);
  assert.equal(item('structure_void').paint, PAINT.skip);
});

test('light 名单每项存在且形态为 light；名单外归 small', () => {
  for (const id of LIGHT_FULL_IDS) {
    const info = registry.get(id);
    assert.ok(info !== undefined, `缺少 ${id}`);
    assert.equal(info.shape, 'light', id);
    assert.equal(item(id).paint, PAINT.cube, id);
    assert.equal(paletteItem(parseState(table, id), info).fallback, false, id);
  }
  const torch = registry.get('torch');
  assert.ok(torch !== undefined);
  assert.equal(torch.shape, 'light');
  assert.equal(item('torch').paint, PAINT.small);
});

test('slab[type=double] 归 cube，bottom/top 参数正确', () => {
  assert.equal(item('oak_slab').paint, PAINT.slab);
  assert.deepEqual(item('oak_slab').params, [0, 0, 0, 0]);
  assert.equal(item('oak_slab', 'oak_slab[type=top]').params[0], 1);
  assert.equal(item('oak_slab', 'oak_slab[type=double]').paint, PAINT.cube);
});

test('stairs：四个朝向 × 上下半 × 五类 shape', () => {
  const facing = ['north', 'east', 'south', 'west'] as const;
  const shape = ['straight', 'outer_left', 'outer_right', 'inner_left', 'inner_right'] as const;
  for (let i = 0; i < facing.length; i += 1) {
    const bottom = item('oak_stairs', `oak_stairs[facing=${facing[i] ?? 'north'}]`);
    assert.equal(bottom.paint, PAINT.stairs);
    assert.deepEqual(bottom.params, [i, 0, 0, 0]);
    const top = item('oak_stairs', `oak_stairs[facing=${facing[i] ?? 'north'},half=top]`);
    assert.equal(top.params[1], 1);
  }
  for (let i = 0; i < shape.length; i += 1) {
    assert.equal(item('oak_stairs', `oak_stairs[shape=${shape[i] ?? 'straight'}]`).params[2], i);
  }
});

test('door：facing / half / hinge / open 四参数', () => {
  const door = item('oak_door');
  assert.equal(door.paint, PAINT.door);
  assert.deepEqual(door.params, [0, 0, 0, 0]);
  assert.equal(door.fallback, false);
  assert.deepEqual(item('oak_door', 'oak_door[facing=south,half=upper,hinge=right,open=true]').params, [2, 1, 1, 1]);
  const facing = ['north', 'east', 'south', 'west'] as const;
  for (let i = 0; i < facing.length; i += 1) {
    assert.equal(item('oak_door', `oak_door[facing=${facing[i] ?? 'north'}]`).params[0], i);
  }
});

test('trapdoor：facing / half / open', () => {
  assert.equal(item('oak_trapdoor').paint, PAINT.trapdoor);
  assert.deepEqual(item('oak_trapdoor').params, [0, 0, 0, 0]);
  assert.deepEqual(item('oak_trapdoor', 'oak_trapdoor[facing=west,half=top,open=true]').params, [3, 1, 0, 1]);
});

test('fence_gate：facing / in_wall / open', () => {
  assert.equal(item('oak_fence_gate').paint, PAINT.fence_gate);
  assert.deepEqual(item('oak_fence_gate').params, [0, 0, 0, 0]);
  assert.deepEqual(item('oak_fence_gate', 'oak_fence_gate[facing=east,in_wall=true,open=true]').params, [1, 1, 0, 1]);
});

test('carpet / pressure_plate / 平铺植物用薄板画法', () => {
  assert.equal(item('white_carpet').paint, PAINT.carpet);
  assert.equal(item('stone_pressure_plate').paint, PAINT.pressure_plate);
  assert.equal(item('lily_pad').paint, PAINT.carpet);
  assert.equal(item('moss_carpet').paint, PAINT.carpet);
});

test('button：face / facing', () => {
  const wall = item('oak_button');
  assert.equal(wall.paint, PAINT.button);
  assert.deepEqual(wall.params, [1, 0, 0, 0]);
  assert.deepEqual(item('oak_button', 'oak_button[face=floor,facing=east]').params, [0, 1, 0, 0]);
  assert.equal(item('oak_button', 'oak_button[face=ceiling]').params[0], 2);
});

test('plant：交叉平面高度；整块 / 贴地植物特判', () => {
  assert.equal(item('grass').paint, PAINT.plant);
  assert.equal(item('grass').params[0], 10);
  assert.equal(item('oak_sapling').params[0], 8);
  assert.equal(item('poppy').params[0], 12);
  assert.equal(item('sunflower').params[0], 16);
  assert.equal(item('carved_pumpkin').paint, PAINT.cube);
  assert.equal(item('moss_block').paint, PAINT.cube);
});

test('sign / wall sign：种类、朝向或 rotation', () => {
  const standing = item('oak_sign');
  assert.equal(standing.paint, PAINT.sign);
  assert.deepEqual(standing.params, [0, 0, 0, 0]);
  assert.deepEqual(item('oak_sign', 'oak_sign[rotation=9]').params, [0, 2, 9, 0]);
  const wall = item('oak_wall_sign', 'oak_wall_sign[facing=east]');
  assert.equal(wall.paint, PAINT.sign);
  assert.deepEqual(wall.params, [1, 1, 0, 0]);
  assert.equal(item('oak_hanging_sign').params[0], 0);
  assert.equal(item('oak_wall_hanging_sign').params[0], 1);
});

test('chest / trapped_chest / ender_chest：14×14×14 近似盒 + facing', () => {
  assert.equal(item('chest').paint, PAINT.chest);
  assert.deepEqual(item('chest').params, [0, 0, 0, 0]);
  assert.equal(item('trapped_chest', 'trapped_chest[facing=west]').params[0], 3);
  assert.equal(item('ender_chest', 'ender_chest[facing=south]').params[0], 2);
});

test('轴向方块：原木 / 木柱 / 菌柄 / 六面不同的整块', () => {
  assert.equal(item('oak_log').paint, PAINT.axis_cube);
  assert.equal(item('oak_log').params[0], 0);
  assert.equal(item('oak_log', 'oak_log[axis=x]').params[0], 1);
  assert.equal(item('oak_log', 'oak_log[axis=z]').params[0], 2);
  for (const id of [
    'oak_wood',
    'stripped_oak_log',
    'stripped_oak_wood',
    'crimson_stem',
    'warped_hyphae',
    'quartz_pillar',
    'purpur_pillar',
    'basalt',
    'polished_basalt',
    'deepslate',
    'hay_block',
    'bone_block',
    'bamboo_block',
  ]) {
    assert.equal(item(id).paint, PAINT.axis_cube, id);
  }
  for (const id of ['grass_block', 'mycelium', 'podzol', 'crimson_nylium', 'warped_nylium', 'dirt_path', 'farmland']) {
    assert.equal(item(id).paint, PAINT.axis_cube, id);
    assert.equal(item(id).params[0], 0, id);
  }
  assert.equal(item('stone').paint, PAINT.cube);
  assert.equal(item('barrel').paint, PAINT.cube);
});

test('source: none 且非 skip 用兜底色并标记 fallback', () => {
  const banner = item('black_banner');
  assert.equal(banner.fallback, true);
  assert.deepEqual(banner.rgb, [...FALLBACK_RGB]);
  assert.equal(banner.paint, PAINT.small);
  // 有颜色的方块不标记 fallback。
  assert.equal(item('stone').fallback, false);
  // skip 的方块不算 fallback。
  assert.equal(item('barrier').fallback, false);
});

test('其余形态按 §6.1 归类', () => {
  assert.equal(item('stone').paint, PAINT.cube);
  assert.equal(item('glass').paint, PAINT.glass);
  assert.equal(item('oak_fence').paint, PAINT.fence);
  assert.equal(item('cobblestone_wall').paint, PAINT.wall);
  assert.equal(item('glass_pane').paint, PAINT.pane);
  assert.equal(item('water').paint, PAINT.fluid);
  assert.equal(item('oak_door').paint, PAINT.door);
  assert.equal(item('white_carpet').paint, PAINT.carpet);
  assert.equal(item('redstone_lamp').paint, PAINT.cube);
  // 尚未专用化的低频形态仍为 small。
  assert.equal(item('vine').paint, PAINT.small);
  assert.equal(item('black_banner').paint, PAINT.small);
});

test('传入官方模型 id 时不再把无颜色方块记成 fallback', () => {
  const banner = registry.get('black_banner');
  assert.ok(banner !== undefined);
  const withModel = paletteItem(parseState(table, 'black_banner'), banner, 12);
  assert.equal(withModel.model, 12);
  assert.equal(withModel.fallback, false);
});
