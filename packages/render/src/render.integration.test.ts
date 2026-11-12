/**
 * 端到端集成测试（RENDER-SPEC §12 第 1、7 条）。需要本机 Chrome；找不到时整组 skip，
 * 本机（有 Chrome）跑完末尾断言 skip 数为 0。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import { API_VERSION, createWorld, rect } from '@pg/geometry';
import type { World } from '@pg/geometry';

import { DEFAULT_REQUESTS, createRenderer } from './render.ts';
import type { Renderer, RenderResult } from './render.ts';
import { viewFrame } from './camera.ts';

const CHROME = '/usr/bin/google-chrome';
const support = { ok: existsSync(CHROME) };
const counter = { skipped: 0 };
const registry = loadRegistry();

function guarded(name: string, fn: () => Promise<void> | void): void {
  if (!support.ok) {
    counter.skipped += 1;
    test(name, { skip: `找不到 ${CHROME}` }, () => undefined);
    return;
  }
  test(name, fn);
}

function archiveOf(build: (w: World) => void): Uint8Array {
  const host = createWorld(registry.table);
  build(host.world);
  return writeArchive(host.compose().grid, API_VERSION);
}

/** 近似 F5-B：五层塔 + 尖顶，用来验证交付视角与确定性。 */
function buildF5B(w: World): void {
  const base = w.plinth({ footprint: rect(-7, -7, 7, 7), height: 1, project: 1, material: 'stone_bricks' });
  const tower = w.walls({
    on: base,
    height: 41,
    material: 'oak_planks',
    bands: [{ from: 0, to: 1, material: 'stone_bricks' }],
  });
  w.colonnade({ on: base, count: 4, height: 41, column: { material: 'stone_bricks', shape: 'cross' }, beam: false });
  const plates = [10, 18, 26, 34, 42].map((y) =>
    w.floorPlate({ footprint: tower.inner.footprint, y, material: 'oak_planks' }),
  );
  const top = plates[plates.length - 1];
  if (top === undefined) throw new Error('楼板缺失');
  const door = w.opening({
    in: tower.facade('south'),
    kind: 'door',
    shape: 'arch',
    width: 3,
    height: 4,
    sill: 0,
    frame: { material: 'chiseled_stone_bricks' },
  });
  w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
  w.stair({ from: base.top, to: top.top, kind: 'spiral', at: [0, 0], radius: 4, material: 'oak_stairs' });
  for (const side of ['north', 'south', 'east', 'west'] as const)
    for (const fy of [7, 15, 23, 31, 39])
      w.opening({ in: tower.facade(side), kind: 'window', width: 2, height: 3, sill: fy - 2 });
  w.rail({ along: tower.top, material: 'oak_fence' });
  w.roof({
    footprint: rect(-7, -7, 7, 7),
    y: 44,
    kind: 'pyramid',
    peakY: 56,
    overhang: 0,
    material: 'deepslate_tiles',
    finial: { height: 2, material: 'gold_block' },
  });
}

/** 近似 F4-A：中殿 + 两廊 + 双坡屋顶。 */
function buildF4A(w: World): void {
  const base = w.plinth({ footprint: rect(-7, -10, 7, 10), height: 1, material: 'stone_bricks' });
  const nave = w.walls({ on: base, height: 10, material: 'stone_bricks' });
  const entry = w.opening({
    in: nave.facade('south'),
    kind: 'door',
    shape: 'pointed',
    width: 5,
    height: 4,
    frame: { material: 'chiseled_stone_bricks' },
  });
  w.opening({
    in: nave.facade('south'),
    kind: 'window',
    shape: 'round',
    width: 5,
    height: 5,
    sill: 5,
    fill: 'blue_stained_glass',
  });
  w.roof({ on: nave, kind: 'gable', ridge: 'z', pitch: 0.65, material: 'deepslate_tiles' });
  w.mirror({ axis: 'x', at: 0 }, () => {
    const aisle = w.walls({ footprint: rect(7, -9, 10, 9), y: 1, height: 6, material: 'stone_bricks' });
    w.opening({
      in: aisle.facade('east'),
      kind: 'window',
      width: 3,
      height: 2,
      sill: 3,
      repeat: { every: 6 },
      fill: 'blue_stained_glass',
    });
    w.roof({ on: aisle, kind: 'shed', high: 'west', overhang: 0, pitch: 0.5, material: 'deepslate_tiles' });
  });
  w.steps({ to: entry, width: 3, material: 'stone_brick_stairs' });
}

/** 45 万格实心块，用于崩溃测试。 */
function bigArchive(cells = 448_000): Uint8Array {
  const grid = createGrid(registry.table);
  const state = parseState(registry.table, 'stone_bricks');
  const [sx, sy, sz] = [80, 70, 80];
  let count = 0;
  for (let x = 0; x < sx && count < cells; x += 1)
    for (let y = 1; y <= sy && count < cells; y += 1)
      for (let z = 0; z < sz && count < cells; z += 1) {
        grid.set(x, y, z, state, 0, 0);
        count += 1;
      }
  return writeArchive(grid, API_VERSION);
}

function pgrep(pid: number): string[] {
  const result = spawnSync('pgrep', ['-f', `pg-render-${String(pid)}-`], { encoding: 'utf8' });
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
}

function dirs(pid: number): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(`pg-render-${String(pid)}-`));
}

function pngSize(png: Uint8Array): { w: number; h: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { w: view.getUint32(16, false), h: view.getUint32(20, false) };
}

async function renderOrThrow(
  renderer: Renderer,
  archive: Uint8Array,
  request = DEFAULT_REQUESTS.deliver,
): Promise<Extract<RenderResult, { kind: 'ok' }>> {
  const result = await renderer.render(archive, request);
  if (result.kind !== 'ok') throw new Error(`不是 ok：${JSON.stringify(result).slice(0, 300)}`);
  return result;
}

test('有 Chrome 时 skip 数为 0', () => {
  if (!support.ok) return;
  assert.equal(counter.skipped, 0);
});

guarded('F5-B / F4-A 交付渲染：6 张尺寸正确、frameFill、blockedRequests、SwiftShader', async () => {
  const renderer = createRenderer(registry);
  for (const build of [buildF5B, buildF4A]) {
    const result = await renderOrThrow(renderer, archiveOf(build));
    assert.equal(result.images.length, 6);
    assert.equal(result.scene.blockedRequests, 0);
    assert.ok(result.version.webglRenderer.includes('SwiftShader'), result.version.webglRenderer);
    for (const image of result.images) {
      const size = pngSize(image.png);
      assert.equal(size.w, 2048, image.view);
      assert.equal(size.h, 1536, image.view);
      assert.ok(image.frameFill >= 0.05 && image.frameFill <= 0.95, image.view);
      assert.ok(image.sha256.length === 64);
    }
  }
  await renderer.close();
  assert.deepEqual(pgrep(process.pid), []);
});

guarded('确定性：同一 Renderer 两次、关闭后新建 Renderer 一次，sha256 逐张相同', async () => {
  const archive = archiveOf(buildF5B);
  const first = createRenderer(registry);
  const a = await renderOrThrow(first, archive);
  const b = await renderOrThrow(first, archive);
  await first.close();
  const second = createRenderer(registry);
  const c = await renderOrThrow(second, archive);
  await second.close();
  for (let i = 0; i < a.images.length; i += 1) {
    assert.equal(a.images[i]?.sha256, b.images[i]?.sha256, `同 Renderer 第 ${String(i)} 张`);
    assert.equal(a.images[i]?.sha256, c.images[i]?.sha256, `跨 Renderer 第 ${String(i)} 张`);
  }
  assert.deepEqual(pgrep(process.pid), []);
});

guarded('framingBounds 固定四视角相机/尺度；省略时保持原取景和元数据', async () => {
  const renderer = createRenderer(registry);
  const views = ['top', 'south', 'east', 'iso-se'] as const;
  const bounds = { min: [-3, 1, -2], max: [8, 9, 6] } as const;
  const small = archiveOf((w) => {
    w.set(0, 2, 0, 'smooth_sandstone_slab');
  });
  const large = archiveOf((w) => {
    w.set(-3, 1, -2, 'stone');
    w.set(8, 9, 6, 'oak_stairs[facing=east,half=top]');
  });
  try {
    const request = { views, width: 1024, height: 768, framingBounds: bounds };
    const a = await renderOrThrow(renderer, small, request);
    const b = await renderOrThrow(renderer, large, request);
    for (const [i, view] of views.entries()) {
      const expected = viewFrame(view, bounds, 1024, 768);
      for (const result of [a, b]) {
        const image = result.images[i];
        assert.ok(image);
        assert.deepEqual(image.camera, expected.camera);
        assert.equal(image.pixelsPerCell, expected.pixelsPerCell);
        assert.deepEqual(image.bbox, expected.bbox);
        assert.equal(image.frameFill, expected.frameFill);
        assert.deepEqual(image.framingBounds, bounds);
      }
      assert.notEqual(a.images[i]?.sha256, b.images[i]?.sha256);
    }
    const implicit = await renderOrThrow(renderer, small, { views, width: 1024, height: 768 });
    const explicit = await renderOrThrow(renderer, small, {
      views,
      width: 1024,
      height: 768,
      framingBounds: { min: [0, 2, 0], max: [0, 2, 0] },
    });
    for (const [i, view] of views.entries()) {
      assert.equal(implicit.images[i]?.sha256, explicit.images[i]?.sha256);
      assert.deepEqual(
        implicit.images[i]?.camera,
        viewFrame(view, { min: [0, 2, 0], max: [0, 2, 0] }, 1024, 768).camera,
      );
      assert.ok(!Object.hasOwn(implicit.images[i] ?? {}, 'framingBounds'));
    }
  } finally {
    await renderer.close();
  }
  assert.deepEqual(pgrep(process.pid), []);
});

guarded('坏样本：empty / belowGround / cells / faces / invalid-archive / timeout / unsupported / closed', async () => {
  const request = { views: ['south'], width: 256, height: 256 } as const;
  const empty = createRenderer(registry);
  assert.deepEqual(await empty.render(writeArchive(createGrid(registry.table), API_VERSION), request), {
    kind: 'empty',
    belowGround: 0,
  });
  const below = createGrid(registry.table);
  below.set(0, 0, 0, parseState(registry.table, 'stone'), 0, 0);
  assert.deepEqual(await empty.render(writeArchive(below, API_VERSION), request), { kind: 'empty', belowGround: 1 });
  assert.equal((await empty.render(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), request)).kind, 'invalid-archive');
  await empty.close();

  const many = archiveOf((w) => {
    for (let x = 0; x < 120; x += 1) w.set(x, 5, 0, 'stone');
  });
  const small = archiveOf((w) => {
    for (let x = 0; x < 10; x += 1) w.set(x, 5, 0, 'stone');
  });
  const cellLimited = createRenderer(registry, { maxCells: 100 });
  const cellResult = await cellLimited.render(many, request);
  assert.equal(cellResult.kind, 'too-large');
  assert.equal(cellResult.what, 'cells');
  await cellLimited.close();

  const faceLimited = createRenderer(registry, { maxFaces: 10 });
  const faceResult = await faceLimited.render(small, request);
  assert.equal(faceResult.kind, 'too-large');
  assert.equal(faceResult.what, 'faces');
  assert.deepEqual(pgrep(process.pid), [], 'maxFaces 超限不应启动浏览器');
  await faceLimited.close();

  const timeout = createRenderer(registry, { renderTimeoutMs: 1 });
  assert.equal((await timeout.render(archiveOf(buildF4A), request)).kind, 'timeout');
  await timeout.close();
  assert.deepEqual(pgrep(process.pid), []);

  const noChrome = createRenderer(registry, { chromePath: '/nonexistent/chrome' });
  assert.equal((await noChrome.render(archiveOf(buildF4A), request)).kind, 'unsupported');
  await noChrome.close();

  const closed = createRenderer(registry);
  await closed.close();
  assert.deepEqual(await closed.render(archiveOf(buildF4A), request), { kind: 'closed' });
});

guarded('崩溃：渲染 45 万格时按进程组 SIGKILL Chrome → crashed，随后同一 Renderer 再渲染 F4-A → ok', async () => {
  const renderer = createRenderer(registry);
  const big = bigArchive();
  const request = { views: ['iso-se'], width: 1024, height: 768 } as const;
  const rendering = renderer.render(big, request);
  let chromePid: number | undefined;
  for (let i = 0; i < 200 && chromePid === undefined; i += 1) {
    const found = pgrep(process.pid);
    if (found[0] !== undefined) chromePid = Number(found[0]);
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(chromePid !== undefined, '渲染期间应能找到 Chrome 进程');
  // 等 puppeteer 完成握手、真正进入渲染，避免杀在启动阶段（那是 crashed 的另一种触发，但不是本用例）。
  await new Promise((resolve) => setTimeout(resolve, 1000));
  process.kill(-chromePid, 'SIGKILL');
  const crashed = await rendering;
  assert.equal(crashed.kind, 'crashed', JSON.stringify(crashed).slice(0, 200));
  const recovered = await renderer.render(archiveOf(buildF4A), { views: ['south'], width: 256, height: 256 });
  assert.equal(recovered.kind, 'ok', JSON.stringify(recovered).slice(0, 200));
  await renderer.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(pgrep(process.pid), []);
  assert.deepEqual(dirs(process.pid), []);
});

guarded('用户数据目录在正常关闭后删除', async () => {
  const renderer = createRenderer(registry);
  await renderer.render(archiveOf(buildF4A), { views: ['south'], width: 256, height: 256 });
  await renderer.close();
  assert.deepEqual(dirs(process.pid), []);
});

guarded('pipe:true：子进程宿主被 SIGKILL 后 10 s 内无 Chrome 残留', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const code = [
    "import { loadRegistry } from '@pg/blocks/load';",
    "import { createRenderer } from '@pg/render/render';",
    'const renderer = createRenderer(loadRegistry(), {});',
    'await renderer.version();',
    "console.log('READY');",
    'setTimeout(() => {}, 60000);',
  ].join('\n');
  // 放在仓库 .work/ 下，裸包名才能经仓库 node_modules 解析（ESM 按文件位置找 node_modules）。
  mkdirSync(join(root, '.work'), { recursive: true });
  const script = join(root, '.work', `pg-render-child-${String(process.pid)}.mjs`);
  writeFileSync(script, code);
  const child = spawn('node', [script], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  const childPid = child.pid;
  assert.ok(childPid !== undefined);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('子进程未在 30 s 内就绪'));
    }, 30000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error('子进程提前退出'));
    });
  });
  assert.ok(pgrep(childPid).length > 0, '子进程应已启动 Chrome');
  process.kill(childPid, 'SIGKILL');
  let clean = false;
  for (let i = 0; i < 40 && !clean; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    clean = pgrep(childPid).length === 0;
  }
  assert.equal(clean, true, `10 s 内仍有 Chrome 残留：${pgrep(childPid).join(',')}`);
});
