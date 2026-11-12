/**
 * view_building 的单元测试（AGENT-SPEC §4.3）：用假 render 覆盖成功、缓存、预算与每种失败。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RenderRequest, RenderResult, RenderedView } from '@pg/render/render';

import { DEFAULT_VIEWS, VIEW_NAMES, viewBuilding } from './view.ts';
import type { ViewCache, ViewDeps, ViewImage, ViewInput } from './view.ts';

const camera: RenderedView['camera'] = {
  position: [0, 0, 0],
  target: [0, 0, 0],
  up: [0, 1, 0],
  left: -1,
  right: 1,
  top: 1,
  bottom: -1,
  near: 0.1,
  far: 10,
};

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function image(view: RenderedView['view'], png = PNG): RenderedView {
  return {
    view,
    png,
    sha256: 'a'.repeat(64),
    camera,
    pixelsPerCell: 11.4,
    bbox: [0, 0, 100, 100],
    frameFill: 0.5,
  };
}

function okResult(views: readonly RenderedView['view'][]): RenderResult {
  return {
    kind: 'ok',
    images: views.map((v) => image(v)),
    scene: {
      cells: 1,
      faces: 6,
      belowGround: 0,
      skipped: 0,
      fallbackColor: [],
      simplified: {},
      blockedRequests: 0,
      officialCells: 0,
      assets: {
        source: 'fallback',
        mcVersion: null,
        models: 0,
        coveredBlocks: 0,
        states: 0,
        textures: 0,
        reason: 'test',
      },
    },
    version: {
      protocol: 1,
      chrome: 'c',
      puppeteer: 'p',
      three: 't',
      flags: [],
      webglRenderer: 'SwiftShader',
      cpuModel: 'cpu',
      assets: {
        source: 'fallback',
        mcVersion: null,
        models: 0,
        coveredBlocks: 0,
        states: 0,
        textures: 0,
        reason: 'test',
      },
    },
    wallMs: 40,
  };
}

function input(overrides: Partial<ViewInput> = {}): ViewInput {
  return {
    archive: Uint8Array.from([1, 2, 3]),
    archiveVersion: 6,
    archiveHash: 'f'.repeat(64),
    draftVersion: 6,
    imageBytes: 0,
    ...overrides,
  };
}

function depsOf(
  result: RenderResult | (() => Promise<RenderResult>),
  cache?: ViewCache,
): {
  readonly deps: ViewDeps;
  readonly calls: () => readonly RenderRequest[];
} {
  const calls: RenderRequest[] = [];
  let now = 0;
  return {
    deps: {
      render: (_archive, request) => {
        calls.push(request);
        return typeof result === 'function' ? result() : Promise.resolve(result);
      },
      clock: () => {
        now += 5;
        return now;
      },
      ...(cache === undefined ? {} : { cache }),
    },
    calls: () => calls,
  };
}

function mapCache(initial: readonly ViewImage[] = []): { cache: ViewCache; stored: () => readonly ViewImage[] } {
  let stored = initial;
  return {
    cache: {
      get: () => stored,
      set: (_key, images) => {
        stored = images;
      },
    },
    stored: () => stored,
  };
}

describe('viewBuilding 成功', () => {
  it('默认两张斜视：请求画幅、图片块顺序、data URL 与文本', async () => {
    const { deps, calls } = depsOf(okResult(['iso-se', 'iso-nw']));
    const result = await viewBuilding(input(), deps);
    assert.ok(result.kind === 'ok');
    assert.deepEqual(calls()[0], { views: ['iso-se', 'iso-nw'], width: 1024, height: 768 });
    assert.equal(result.images.length, 2);
    assert.deepEqual(
      result.content.map((p) => p.type),
      ['text', 'image_url', 'text', 'image_url'],
    );
    const firstText = result.content[0];
    assert.ok(firstText?.type === 'text');
    assert.equal(firstText.text, 'iso-se（东南斜上 30°，正交，1 格 ≈ 11 像素）');
    const firstImage = result.content[1];
    assert.ok(firstImage?.type === 'image_url');
    assert.equal(firstImage.image_url.url, `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
    assert.equal(result.images[0]?.imageBytes, Buffer.from(PNG).toString('base64').length);
    assert.equal(result.text, '已渲染第 v6 版 2 张，图附在本轮末尾。');
    assert.equal(result.rendered, true);
    assert.equal(result.version?.chrome, 'c');
  });

  it('9 个视角：interior / cutaway 有独立说明，默认两张斜视不变', async () => {
    const { deps, calls } = depsOf(okResult(['interior', 'cutaway']));
    const result = await viewBuilding(input({ views: ['interior', 'cutaway'] }), deps);
    assert.ok(result.kind === 'ok');
    assert.deepEqual(calls()[0], { views: ['interior', 'cutaway'], width: 1024, height: 768 });
    assert.deepEqual(
      [...VIEW_NAMES],
      ['south', 'east', 'north', 'west', 'top', 'iso-se', 'iso-nw', 'interior', 'cutaway'],
    );
    const texts = result.content.filter((p) => p.type === 'text').map((p) => p.text);
    assert.deepEqual(texts, [
      'interior（室内站立高度，横看主空间，正交，1 格 ≈ 11 像素）',
      'cutaway（剖视，移除屋面上部与近侧外墙，正交，1 格 ≈ 11 像素）',
    ]);
    assert.deepEqual(DEFAULT_VIEWS, ['iso-se', 'iso-nw']);
  });

  it('当前稿比存档新时注明图是旧版', async () => {
    const { deps } = depsOf(okResult(['iso-se']));
    const result = await viewBuilding(input({ draftVersion: 8, views: ['iso-se'] }), deps);
    assert.ok(result.kind === 'ok');
    assert.equal(result.text, '已渲染第 v6 版 1 张，图附在本轮末尾。图是第 v6 版（当前稿第 v8 版尚未检查）。');
  });

  it('命中缓存时不调 render、不重复写版本，但仍生成新图片块', async () => {
    const { deps, calls } = depsOf(okResult(['iso-se', 'iso-nw']));
    const fresh = await viewBuilding(input(), deps);
    assert.ok(fresh.kind === 'ok');
    const cache = mapCache(fresh.images);
    const second = await viewBuilding(input(), { ...deps, cache: cache.cache });
    assert.equal(calls().length, 1);
    assert.ok(second.kind === 'ok');
    assert.equal(second.rendered, false);
    assert.equal(second.version, undefined);
    assert.equal(second.content.length, 4);
    assert.equal(second.images.length, 2);
  });

  it('图片累计超过软上限时拒绝，不调 render', async () => {
    const { deps, calls } = depsOf(okResult(['iso-se']));
    const result = await viewBuilding(input({ imageBytes: 32 * 1024 * 1024 + 1 }), deps);
    assert.ok(result.kind === 'failed');
    assert.equal(result.status, 'image-budget');
    assert.match(result.text, /view_building 不再可用/);
    assert.equal(result.internal, false);
    assert.equal(calls().length, 0);
  });

  it('views 数量非法直接抛 RangeError', async () => {
    const { deps } = depsOf(okResult(['iso-se']));
    await assert.rejects(() => viewBuilding(input({ views: [] }), deps), RangeError);
    await assert.rejects(
      () => viewBuilding(input({ views: ['iso-se', 'iso-nw', 'south', 'east', 'top'] }), deps),
      RangeError,
    );
    assert.deepEqual(DEFAULT_VIEWS, ['iso-se', 'iso-nw']);
  });
});

describe('viewBuilding 渲染失败', () => {
  const cases: readonly { readonly result: RenderResult; readonly status: string; readonly internal: boolean }[] = [
    { result: { kind: 'timeout', detail: 'x', wallMs: 30_000 }, status: 'timeout', internal: false },
    { result: { kind: 'crashed', detail: 'x', wallMs: 1 }, status: 'crashed', internal: false },
    { result: { kind: 'unsupported', reason: '没有 Chrome' }, status: 'unsupported', internal: false },
    { result: { kind: 'too-large', what: 'faces', value: 9, limit: 8 }, status: 'too-large', internal: false },
    { result: { kind: 'empty', belowGround: 0 }, status: 'empty', internal: false },
    { result: { kind: 'invalid-archive', message: 'bad' }, status: 'invalid-archive', internal: true },
    { result: { kind: 'page-error', detail: 'boom', wallMs: 2 }, status: 'page-error', internal: true },
    { result: { kind: 'closed' }, status: 'closed', internal: true },
  ];
  for (const c of cases) {
    it(`${c.status}：一行文字、internal=${String(c.internal)}`, async () => {
      const { deps } = depsOf(c.result);
      const result = await viewBuilding(input(), deps);
      assert.ok(result.kind === 'failed');
      assert.equal(result.status, c.status);
      assert.equal(result.internal, c.internal);
      assert.ok(result.text.length > 0);
    });
  }
});
