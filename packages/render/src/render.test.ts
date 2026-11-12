/**
 * render.ts：参数校验、不启动浏览器的返回路径、closed 语义。
 * 真正调 Chrome 的 ok / timeout / crashed 在 render.integration.test.ts。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';

import { RenderError } from './errors.ts';
import { VIEW_NAMES } from './camera.ts';
import { DEFAULT_REQUESTS, createRenderer } from './render.ts';

const registry = loadRegistry();
const table = registry.table;

function archive(cells: readonly [number, number, number, string][]): Uint8Array {
  const grid = createGrid(table);
  for (const [x, y, z, block] of cells) grid.set(x, y, z, parseState(table, block), 0, 0);
  return writeArchive(grid, 1);
}

const REQUEST = { views: ['south'], width: 256, height: 256 } as const;

test('RendererOptions 不合法抛 RenderError(invalid-request)', () => {
  assert.throws(
    () => createRenderer(registry, { maxCells: 0 }),
    (e: unknown) => e instanceof RenderError,
  );
  assert.throws(
    () => createRenderer(registry, { launchTimeoutMs: -1 }),
    (e: unknown) => e instanceof RenderError,
  );
});

test('RenderRequest 不合法抛 RenderError；views 重复 / 尺寸越界', () => {
  const renderer = createRenderer(registry);
  assert.throws(
    () => renderer.render(archive([[0, 5, 0, 'stone']]), { views: [], width: 256, height: 256 }),
    (e: unknown) => e instanceof RenderError,
  );
  assert.throws(
    () => renderer.render(archive([[0, 5, 0, 'stone']]), { views: ['south', 'south'], width: 256, height: 256 }),
    (e: unknown) => e instanceof RenderError,
  );
  assert.throws(
    () => renderer.render(archive([[0, 5, 0, 'stone']]), { views: ['south'], width: 100, height: 256 }),
    (e: unknown) => e instanceof RenderError,
  );
  assert.equal(DEFAULT_REQUESTS.deliver.width, 2048);
  assert.deepEqual(DEFAULT_REQUESTS.iterate.views, ['iso-se', 'iso-nw']);
  assert.deepEqual(DEFAULT_REQUESTS.deliver.views, ['iso-se', 'south', 'east', 'north', 'west', 'top']);
});

test('9 个视角名都通过请求校验（达到启动 Chrome 的路径），旧 7 视角默认不变', async () => {
  const renderer = createRenderer(registry, { chromePath: '/nonexistent/chrome' });
  try {
    const result = await renderer.render(archive([[0, 5, 0, 'stone']]), {
      views: [...VIEW_NAMES],
      width: 256,
      height: 256,
    });
    // 校验通过后才会走到浏览器启动；找不到 Chrome 是 unsupported，不是 RenderError。
    assert.equal(result.kind, 'unsupported');
    assert.equal(VIEW_NAMES.length, 9);
  } finally {
    await renderer.close();
  }
});

test('empty 存档返回 empty；只有 y ≤ 0 时 belowGround 正确', async () => {
  const renderer = createRenderer(registry);
  const empty = await renderer.render(archive([]), REQUEST);
  assert.deepEqual(empty, { kind: 'empty', belowGround: 0 });
  const below = await renderer.render(
    archive([
      [0, 0, 0, 'stone'],
      [1, -1, 0, 'stone'],
    ]),
    REQUEST,
  );
  assert.deepEqual(below, { kind: 'empty', belowGround: 2 });
  await renderer.close();
});

test('framingBounds 拒绝非安全整数、倒序、越界与过大跨度，不启动 Chrome', async () => {
  const renderer = createRenderer(registry);
  try {
    for (const framingBounds of [
      { min: [0.5, 1, 0], max: [1, 2, 1] },
      { min: [NaN, 1, 0], max: [1, 2, 1] },
      { min: [0, 1, 0], max: [Number.MAX_SAFE_INTEGER + 1, 2, 1] },
      { min: [2, 1, 0], max: [1, 2, 1] },
      { min: [0, 3, 0], max: [1, 2, 1] },
      { min: [0, 1, 2], max: [1, 2, 1] },
      { min: [0, 1, 0], max: [65535, 2, 1] },
      { min: [0, 1, 0], max: [1, 2048, 1] },
    ] as const)
      assert.throws(
        () => renderer.render(archive([]), { ...REQUEST, framingBounds }),
        (e: unknown) => e instanceof RenderError && e.message.includes('framingBounds'),
      );
    assert.deepEqual(
      await renderer.render(archive([]), { ...REQUEST, framingBounds: { min: [0, 1, 0], max: [65534, 2, 1] } }),
      { kind: 'empty', belowGround: 0 },
    );
  } finally {
    await renderer.close();
  }
});

test('framingBounds 每轴两侧漏掉可画格均明确拒绝；不把地下/skip 当可见格', async () => {
  const renderer = createRenderer(registry, { chromePath: '/nonexistent/chrome' });
  try {
    for (const [x, y, z] of [
      [-1, 2, 0],
      [2, 2, 0],
      [0, 1, 0],
      [0, 4, 0],
      [0, 2, -1],
      [0, 2, 2],
    ]) {
      assert.ok(x !== undefined && y !== undefined && z !== undefined);
      await assert.rejects(
        renderer.render(archive([[x, y, z, 'stone']]), {
          ...REQUEST,
          framingBounds: { min: [0, 2, 0], max: [1, 3, 1] },
        }),
        (e: unknown) => e instanceof RenderError && /未包含.*拒绝裁剪/.test(e.message),
      );
    }
    const result = await renderer.render(
      archive([
        [0, 2, 0, 'stone'],
        [100, 0, 0, 'stone'],
        [100, 5, 0, 'barrier'],
      ]),
      {
        ...REQUEST,
        framingBounds: { min: [0, 2, 0], max: [0, 2, 0] },
      },
    );
    assert.equal(result.kind, 'unsupported');
  } finally {
    await renderer.close();
  }
});

test('坏存档字节返回 invalid-archive', async () => {
  const renderer = createRenderer(registry);
  const result = await renderer.render(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), REQUEST);
  assert.equal(result.kind, 'invalid-archive');
  assert.ok(result.message.includes('存档'));
  await renderer.close();
});

test('maxCells 超限返回 too-large(cells)，不启动浏览器', async () => {
  const cells: [number, number, number, string][] = [];
  for (let x = 0; x < 10; x += 1) cells.push([x, 5, 0, 'stone']);
  const renderer = createRenderer(registry, { maxCells: 5 });
  const result = await renderer.render(archive(cells), REQUEST);
  assert.deepEqual(result, { kind: 'too-large', what: 'cells', value: 10, limit: 5 });
  await renderer.close();
});

test('maxFaces 超限返回 too-large(faces)', async () => {
  const renderer = createRenderer(registry, { maxFaces: 5 });
  const result = await renderer.render(archive([[0, 5, 0, 'stone']]), REQUEST);
  assert.deepEqual(result, { kind: 'too-large', what: 'faces', value: 6, limit: 5 });
  await renderer.close();
});

test('close 幂等；close 后 render 返回 closed、version 拒绝', async () => {
  const renderer = createRenderer(registry);
  await renderer.close();
  await renderer.close();
  assert.deepEqual(await renderer.render(archive([[0, 5, 0, 'stone']]), REQUEST), { kind: 'closed' });
  await assert.rejects(
    () => renderer.version(),
    (e: unknown) => e instanceof RenderError,
  );
});
