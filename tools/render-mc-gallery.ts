/**
 * 视觉验证（不进门禁）：用官方 1.20.1 资源渲染小房间与方块画廊，同时渲染 fallback 对照。
 *
 * 用法：node tools/render-mc-gallery.ts [--out <目录>]
 * 输出：<out>/official/*.png、<out>/fallback/*.png（缺省 .work/mc-assets/1.20.1/visual/）。
 * 需要本机 Chrome 与已生成的 catalog.json / model-pack.bin。
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Grid } from '@pg/core/grid';
import { createRenderer } from '@pg/render/render';
import type { RenderResult } from '@pg/render/render';

const registry = loadRegistry();

function set(grid: Grid, x: number, y: number, z: number, state: string): void {
  grid.set(x, y, z, parseState(registry.table, state), 0, 0);
}

function fill(grid: Grid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, state: string): void {
  for (let x = x0; x <= x1; x += 1)
    for (let y = y0; y <= y1; y += 1) for (let z = z0; z <= z1; z += 1) set(grid, x, y, z, state);
}

/** 方块画廊：9×7 平台，按 3 行铺开关键模型，近 4:3 便于 one-shot 看细节。 */
function gallery(): Uint8Array {
  const grid = createGrid(registry.table);
  fill(grid, 0, 1, 0, 8, 1, 6, 'stone_bricks');
  const items: readonly [number, number, number, string][] = [
    [0, 2, 1, 'stone'],
    [1, 2, 1, 'oak_planks'],
    [2, 2, 1, 'oak_log[axis=y]'],
    [3, 2, 1, 'oak_stairs[facing=south]'],
    [4, 2, 1, 'oak_slab[type=bottom]'],
    [5, 2, 1, 'oak_fence'],
    [6, 2, 1, 'stone_brick_wall[up=true]'],
    [7, 2, 1, 'glass_pane'],
    [8, 2, 1, 'oak_door[facing=south,half=lower]'],
    [8, 3, 1, 'oak_door[facing=south,half=upper]'],
    [0, 2, 3, 'oak_trapdoor[facing=north,half=top]'],
    [1, 2, 3, 'oak_fence_gate[facing=north]'],
    [2, 2, 3, 'oak_button[face=wall,facing=south]'],
    [3, 2, 3, 'oak_pressure_plate'],
    [4, 2, 3, 'white_carpet'],
    [5, 2, 3, 'oak_sign[rotation=8]'],
    [6, 2, 3, 'ladder[facing=south]'],
    [7, 2, 3, 'chest[facing=south]'],
    [8, 2, 3, 'red_bed[facing=south,part=head]'],
    [8, 2, 4, 'red_bed[facing=south,part=foot]'],
    [0, 2, 5, 'flower_pot'],
    [1, 2, 5, 'lantern[hanging=false]'],
    [2, 3, 5, 'chain[axis=y]'],
    [2, 2, 5, 'lantern[hanging=true]'],
    [3, 2, 5, 'torch'],
    [4, 2, 5, 'rail[shape=north_south]'],
    [5, 2, 5, 'bookshelf'],
    [6, 2, 5, 'barrel[facing=up]'],
    [7, 2, 5, 'crafting_table'],
    [8, 2, 5, 'furnace[facing=south]'],
  ];
  for (const [x, y, z, state] of items) set(grid, x, y, z, state);
  // 给墙 / 栅栏 / 玻璃板一点邻居，展示连接臂。
  set(grid, 5, 2, 2, 'stone_bricks');
  set(grid, 6, 2, 2, 'stone_bricks');
  set(grid, 7, 2, 2, 'glass_pane');
  return writeArchive(grid, 1);
}

/** 小房间：外墙、门、窗、楼梯座、桌、柜台、床、箱、书架与吊灯。 */
function room(): Uint8Array {
  const grid = createGrid(registry.table);
  fill(grid, 0, 1, 0, 8, 1, 6, 'oak_planks');
  fill(grid, 0, 2, 0, 8, 6, 6, 'stone_bricks');
  fill(grid, 1, 2, 1, 7, 5, 5, 'air');
  fill(grid, 0, 6, 0, 8, 6, 6, 'air');
  // 角柱与腰线。
  for (const [x, z] of [
    [0, 0],
    [8, 0],
    [0, 6],
    [8, 6],
  ] as const)
    fill(grid, x, 2, z, x, 6, z, 'stripped_spruce_log[axis=y]');
  // 不封顶：iso / 剖切更容易看清室内家具；只做一圈压顶。
  fill(grid, 0, 6, 0, 8, 6, 0, 'spruce_slab[type=top]');
  fill(grid, 0, 6, 6, 8, 6, 6, 'spruce_slab[type=top]');
  fill(grid, 0, 6, 0, 0, 6, 6, 'spruce_slab[type=top]');
  fill(grid, 8, 6, 0, 8, 6, 6, 'spruce_slab[type=top]');
  // 剖切东墙，让 iso / 南立面同时看到室内家具。
  fill(grid, 8, 3, 0, 8, 6, 6, 'air');
  // 南立面：门 + 两扇窗。
  set(grid, 4, 2, 6, 'air');
  set(grid, 4, 3, 6, 'air');
  set(grid, 4, 2, 6, 'oak_door[facing=north,half=lower]');
  set(grid, 4, 3, 6, 'oak_door[facing=north,half=upper]');
  for (const x of [2, 6]) {
    set(grid, x, 3, 6, 'glass_pane');
    set(grid, x, 4, 6, 'glass_pane');
    set(grid, x, 2, 6, 'smooth_stone_slab[type=bottom]');
  }
  // 室内家具。
  set(grid, 1, 2, 5, 'red_bed[facing=south,part=head]');
  set(grid, 1, 2, 4, 'red_bed[facing=south,part=foot]');
  set(grid, 7, 2, 4, 'chest[facing=west]');
  fill(grid, 7, 2, 1, 7, 3, 1, 'bookshelf');
  set(grid, 3, 2, 3, 'oak_fence');
  set(grid, 3, 3, 3, 'oak_pressure_plate');
  set(grid, 3, 4, 3, 'flower_pot');
  set(grid, 2, 2, 3, 'oak_stairs[facing=east]');
  set(grid, 6, 2, 2, 'smooth_stone_slab[type=bottom]');
  set(grid, 5, 2, 2, 'barrel[facing=up]');
  set(grid, 4, 2, 3, 'white_carpet');
  set(grid, 4, 5, 3, 'chain[axis=y]');
  set(grid, 4, 4, 3, 'lantern[hanging=true]');
  set(grid, 2, 4, 1, 'lantern[hanging=false]');
  set(grid, 6, 4, 5, 'wall_torch[facing=north]');
  return writeArchive(grid, 1);
}

/** 细部近景：柜门、桌椅、床、书架、吊灯与门，验证模型厚度与贴图。 */
function detail(): Uint8Array {
  const grid = createGrid(registry.table);
  fill(grid, 0, 1, 0, 4, 1, 4, 'oak_planks');
  fill(grid, 0, 2, 0, 4, 4, 0, 'stone_bricks');
  set(grid, 2, 2, 0, 'oak_door[facing=south,half=lower]');
  set(grid, 2, 3, 0, 'oak_door[facing=south,half=upper]');
  fill(grid, 0, 2, 1, 0, 3, 1, 'bookshelf');
  set(grid, 1, 2, 1, 'barrel[facing=north]');
  set(grid, 1, 2, 2, 'oak_trapdoor[facing=south,half=top,open=false]');
  set(grid, 3, 2, 2, 'oak_fence');
  set(grid, 3, 3, 2, 'oak_pressure_plate');
  set(grid, 3, 2, 3, 'oak_stairs[facing=north]');
  set(grid, 3, 4, 2, 'flower_pot');
  set(grid, 4, 2, 1, 'red_bed[facing=south,part=head]');
  set(grid, 4, 2, 2, 'red_bed[facing=south,part=foot]');
  set(grid, 0, 2, 3, 'chest[facing=east]');
  set(grid, 2, 2, 2, 'white_carpet');
  set(grid, 2, 5, 2, 'chain[axis=y]');
  set(grid, 2, 4, 2, 'lantern[hanging=true]');
  set(grid, 4, 2, 3, 'glass_pane');
  return writeArchive(grid, 1);
}

async function renderOne(
  out: string,
  name: string,
  archive: Uint8Array,
  assets: 'official' | 'fallback',
): Promise<RenderResult> {
  const renderer = createRenderer(registry, assets === 'fallback' ? { assets: null } : {});
  try {
    const result = await renderer.render(archive, {
      views: ['iso-se', 'south', 'top'],
      width: 1200,
      height: 900,
    });
    if (result.kind !== 'ok') throw new Error(`${name} 渲染失败：${result.kind}`);
    const dir = join(out, assets);
    mkdirSync(dir, { recursive: true });
    for (const image of result.images) writeFileSync(join(dir, `${name}-${image.view}.png`), image.png);
    console.log(
      `${assets}/${name}: ${String(result.scene.cells)} 格 · ${String(result.scene.faces)} 面 · 官方 ${String(result.scene.officialCells)} 格 · ${result.scene.assets.source}`,
    );
    return result;
  } finally {
    await renderer.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let out = fileURLToPath(new URL('../.work/mc-assets/1.20.1/visual/', import.meta.url));
  const index = args.indexOf('--out');
  if (index >= 0) {
    const value = args[index + 1];
    if (value === undefined) throw new Error('--out 需要一个目录');
    out = value;
  }
  mkdirSync(out, { recursive: true });
  const galleryArchive = gallery();
  const roomArchive = room();
  const detailArchive = detail();
  const official = await renderOne(out, 'room', roomArchive, 'official');
  await renderOne(out, 'gallery', galleryArchive, 'official');
  await renderOne(out, 'detail', detailArchive, 'official');
  await renderOne(out, 'room', roomArchive, 'fallback');
  await renderOne(out, 'gallery', galleryArchive, 'fallback');
  await renderOne(out, 'detail', detailArchive, 'fallback');

  const docs = fileURLToPath(new URL('../docs/mc-visual/', import.meta.url));
  mkdirSync(docs, { recursive: true });
  // 官方纹理渲染图是 Mojang 资产的衍生图，只留在 .work/ 本机对照，绝不拷入仓库
  // （docs/MC-ASSETS.md §4 第 6 条）。入库的只有项目自产的 fallback 渲染图。
  for (const [from, to] of [
    [join(out, 'fallback', 'room-iso-se.png'), 'fallback-room-iso.png'],
    [join(out, 'fallback', 'gallery-top.png'), 'fallback-gallery-top.png'],
    [join(out, 'fallback', 'detail-iso-se.png'), 'fallback-detail-iso.png'],
  ] as const) {
    try {
      copyFileSync(from, join(docs, to));
    } catch {
      // 缺图不阻塞；脚本已经逐个打印过渲染结果。
    }
  }
  if (official.kind === 'ok') {
    console.log(
      `官方资源：${official.scene.assets.source} · ${official.scene.assets.mcVersion ?? '-'} · ${String(official.scene.assets.models)} 模型 / ${String(official.scene.assets.textures)} 纹理`,
    );
  }
  console.log(`输出：${out}`);
  console.log(`入库对照图：${docs}`);
}

await main();
