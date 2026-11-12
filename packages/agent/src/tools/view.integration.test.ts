/**
 * view_building 的集成测试（AGENT-SPEC §12 第 3 条）：真 Chrome 渲染 2 张斜视图，只跑一次。
 * 找不到 Chrome 时 skip；本机有 Chrome，跑完末尾断言 skip 数为 0。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { hashGrid } from '@pg/core/hash';
import { API_VERSION, createWorld, rect } from '@pg/geometry';
import type { World } from '@pg/geometry';
import { createRenderer } from '@pg/render/render';

import { viewBuilding } from './view.ts';

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

/** 近似 F5-B：五层塔 + 尖顶。与 render.integration.test.ts 同形，用来给 view 一张真存档。 */
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

function pgrep(pid: number): string[] {
  const result = spawnSync('pgrep', ['-f', `pg-render-${String(pid)}-`], { encoding: 'utf8' });
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
}

function pngSize(png: Uint8Array): { w: number; h: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { w: view.getUint32(16, false), h: view.getUint32(20, false) };
}

test('有 Chrome 时 skip 数为 0', () => {
  if (!support.ok) return;
  assert.equal(counter.skipped, 0);
});

guarded('view_building：2 张斜视图 1024×768，图片块在 user 内容里', async () => {
  const host = createWorld(registry.table);
  buildF5B(host.world);
  const { grid } = host.compose();
  const archive = writeArchive(grid, API_VERSION);
  const renderer = createRenderer(registry);
  try {
    const result = await viewBuilding(
      { archive, archiveVersion: 1, archiveHash: hashGrid(grid), draftVersion: 1, imageBytes: 0 },
      { render: (bytes, request) => renderer.render(bytes, request), clock: () => Date.now() },
    );
    assert.ok(result.kind === 'ok', JSON.stringify(result).slice(0, 300));
    assert.deepEqual(
      result.images.map((i) => i.view),
      ['iso-se', 'iso-nw'],
    );
    for (const image of result.images) {
      const size = pngSize(image.png);
      assert.equal(size.w, 1024, image.view);
      assert.equal(size.h, 768, image.view);
      assert.match(image.description, /正交，1 格 ≈ \d+ 像素/);
    }
    assert.equal(result.content.filter((p) => p.type === 'image_url').length, 2);
    assert.match(result.text, /已渲染第 v1 版 2 张，图附在本轮末尾。/);
  } finally {
    await renderer.close();
  }
  assert.deepEqual(pgrep(process.pid), []);
});
