/**
 * 函数草模查看器端到端集成测试（MODELING-SPEC §4）：真实 `startMassingServer({ model })` + puppeteer-core。
 *
 * 覆盖：`--model` 对应的模型模式加载（`/` 为 modelViewerHtml、`/api/model` 200）、mesh 页面模块 200、
 * 无页面 / 控制台错误；画布确实画出部件（像素统计）；整体 / 俯视 / 侧视切换改变画面；剖切轴与位置的 min/max/step
 * 全是有限浮点且能改变画面；点击部件显示名称 / 编号 / 操作 / source JSON（`<pre>` textContent，不注入 HTML）；
 * 关闭自己启动的 Chrome，无进程残留。截图写 `.work/massing-model/`（可再生，不入库）。
 *
 * 本机以普通用户运行，Chrome 不需要 `--no-sandbox`。覆盖 page/mesh-viewer.ts（登记在 tools/check-tests.ts）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';
import type { Browser, ElementHandle, Page } from 'puppeteer-core';

import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';

import { startMassingServer } from './server.ts';

const CHROME = '/usr/bin/google-chrome';
/** 与 @pg/render 的 FLAGS 同款；web 不声明 @pg/render，故复制一份。 */
const FLAGS: readonly string[] = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--mute-audio',
];
const SHOT_DIR = fileURLToPath(new URL('../../../.work/massing-model/', import.meta.url));

/** 基座部件名称故意含 HTML，用来验证前端用 textContent 而不是 innerHTML。 */
function buildModel(): ModelDocument {
  const model = createModel();
  model.box({ id: 'part-base', name: '<b>基座</b>', role: 'volume', color: '#8899aa', size: [40, 20, 40] });
  model.revolve({
    id: 'part-roof',
    name: '旋转屋顶',
    role: 'roof',
    color: '#b07a4a',
    profile: (t: number) => [14 * (1 - t), 10 + 16 * t],
    profileSegments: 24,
    radialSegments: 36,
  });
  return model.finish();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function settle(): Promise<void> {
  return delay(350);
}

function pgrepOwn(pid: number): string[] {
  const result = spawnSync('pgrep', ['-f', `pg-model-viewer-${String(pid)}-`], { encoding: 'utf8' });
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
}

async function shotOf(canvas: ElementHandle): Promise<string> {
  return canvas.screenshot({ encoding: 'base64' });
}

function saveShot(name: string, base64: string): void {
  writeFileSync(join(SHOT_DIR, name), Buffer.from(base64, 'base64'));
}

interface PixelStats {
  readonly width: number;
  readonly height: number;
  readonly backgroundFraction: number;
  readonly distinctColors: number;
}

async function canvasStats(page: Page, base64: string): Promise<PixelStats> {
  return page.evaluate(async (value: string): Promise<PixelStats> => {
    const image = new Image();
    image.src = `data:image/png;base64,${value}`;
    await image.decode();
    const surface = document.createElement('canvas');
    surface.width = image.naturalWidth;
    surface.height = image.naturalHeight;
    const context = surface.getContext('2d');
    if (context === null) throw new Error('无法取得 2d 上下文');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, surface.width, surface.height).data;
    const colors = new Set<number>();
    let background = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index] ?? 0;
      const g = pixels[index + 1] ?? 0;
      const b = pixels[index + 2] ?? 0;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      // scene.background = 0xdfe5ec
      if (Math.abs(r - 223) <= 10 && Math.abs(g - 229) <= 10 && Math.abs(b - 236) <= 10) background += 1;
    }
    const total = surface.width * surface.height;
    return {
      width: surface.width,
      height: surface.height,
      backgroundFraction: background / total,
      distinctColors: colors.size,
    };
  }, base64);
}

interface RangeState {
  readonly disabled: boolean;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

async function rangeOf(page: Page, id: string): Promise<RangeState> {
  return page.$eval(`#${id}`, (element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} 不是 input`);
    return {
      disabled: element.disabled,
      min: Number(element.min),
      max: Number(element.max),
      step: Number(element.step),
    };
  });
}

async function setRange(page: Page, id: string, value: number): Promise<void> {
  await page.$eval(
    `#${id}`,
    (element, next) => {
      if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} 不是 input`);
      element.value = String(next);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
}

interface SelectionDetails {
  readonly fields: Readonly<Record<string, string>>;
  readonly source: string | null;
  readonly hasBoldNode: boolean;
}

async function selectionDetails(page: Page): Promise<SelectionDetails> {
  return page.evaluate((): SelectionDetails => {
    const dl = document.querySelector('#mesh-selection-details dl.kv');
    const fields: Record<string, string> = {};
    if (dl !== null) {
      const terms = Array.from(dl.querySelectorAll('dt'));
      const values = Array.from(dl.querySelectorAll('dd'));
      terms.forEach((term, index) => {
        fields[term.textContent] = values[index]?.textContent ?? '';
      });
    }
    const pre = document.querySelector('#mesh-selection-details details.source pre');
    return {
      fields,
      source: pre?.textContent ?? null,
      hasBoldNode: document.querySelector('#mesh-selection-details b') !== null,
    };
  });
}

/** 扫描点击画布直到选中部件并显示 source JSON。 */
async function pickPart(page: Page, canvas: ElementHandle): Promise<SelectionDetails> {
  const box = await canvas.boundingBox();
  assert.ok(box !== null, '画布应有包围盒');
  const xs = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65];
  const ys = [0.5, 0.45, 0.55, 0.4, 0.6, 0.3, 0.7];
  for (const fx of xs) {
    for (const fy of ys) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await delay(80);
      const selected = await selectionDetails(page);
      if (selected.source !== null) return selected;
    }
  }
  throw new Error('在画布上点击未能选中任何部件');
}

const support = { ok: existsSync(CHROME) };

test(
  '函数草模查看器集成：加载、部件渲染、剖切与 source 文本',
  { timeout: 120_000, skip: support.ok ? false : `找不到 ${CHROME}` },
  async (t) => {
    rmSync(SHOT_DIR, { recursive: true, force: true });
    mkdirSync(SHOT_DIR, { recursive: true });
    const userDataDir = mkdtempSync(join(tmpdir(), `pg-model-viewer-${String(process.pid)}-`));
    const model = buildModel();
    const server = await startMassingServer({ port: 0, model });
    let browser: Browser | undefined;

    t.after(async () => {
      if (browser !== undefined) await browser.close().catch(() => undefined);
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    });

    const launched = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      pipe: true,
      userDataDir,
      args: [...FLAGS],
      handleSIGINT: true,
      handleSIGTERM: true,
      handleSIGHUP: true,
    });
    browser = launched;
    const page = await launched.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const statuses = new Map<string, number>();
    const requestFailed: string[] = [];
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('response', (response) => {
      statuses.set(response.url(), response.status());
    });
    page.on('requestfailed', (request) => {
      requestFailed.push(request.url());
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error instanceof Error ? error.message : String(error));
    });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    const cleanErrors = (): void => {
      assert.deepEqual(pageErrors, [], `页面错误：${pageErrors.join(' | ')}`);
      assert.deepEqual(consoleErrors, [], `控制台错误：${consoleErrors.join(' | ')}`);
      assert.deepEqual(
        [...statuses.entries()].filter(([, status]) => status >= 400),
        [],
        '有资源返回 4xx/5xx',
      );
      assert.deepEqual(requestFailed, [], `资源请求失败：${requestFailed.join(' | ')}`);
    };

    await page.goto(`${server.url}/`, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForSelector('#mesh-viewport canvas', { timeout: 30_000 });
    await page.waitForFunction(() => (globalThis as unknown as { pgModelReady?: boolean }).pgModelReady === true, {
      timeout: 30_000,
    });
    const canvas = await page.$('#mesh-viewport canvas');
    assert.ok(canvas !== null, '页面应创建画布');
    await settle();

    await t.test('资源全部 200：模型外壳、mesh 模块与 /api/model', () => {
      for (const path of [
        '/',
        '/page/mesh-viewer.ts',
        '/page/mesh-scene.ts',
        '/page/controls.ts',
        '/vendor/three.module.js',
        '/vendor/three.core.js',
        '/vendor/addons/controls/OrbitControls.js',
        '/api/model',
      ]) {
        const found = [...statuses.entries()].find(([url]) => new URL(url).pathname === path);
        assert.ok(found !== undefined, `${path} 未被请求`);
        assert.equal(found[1], 200, `${path} 状态码`);
      }
      const home = statuses.get(`${server.url}/`);
      assert.equal(home, 200);
      cleanErrors();
    });

    const baseCanvas = await shotOf(canvas);
    saveShot('01-default-full.png', await page.screenshot({ fullPage: true, encoding: 'base64' }));
    const stats = await canvasStats(page, baseCanvas);
    console.log(`[model] 默认像素统计：${JSON.stringify(stats)}`);

    await t.test('画布确实画出部件（像素统计）', () => {
      assert.ok(stats.width > 100 && stats.height > 100);
      assert.ok(stats.backgroundFraction < 0.95, `背景占比过高：${String(stats.backgroundFraction)}`);
      assert.ok(stats.distinctColors >= 8, `量化颜色过少：${String(stats.distinctColors)}`);
    });

    await t.test('剖切滑杆范围是有限浮点，剖切改变画面', async () => {
      const none = await rangeOf(page, 'mesh-clip-value');
      assert.equal(none.disabled, true, '不剖切时滑杆应禁用');

      await page.select('#mesh-clip-axis', 'y');
      await settle();
      const range = await rangeOf(page, 'mesh-clip-value');
      assert.equal(range.disabled, false);
      assert.ok(Number.isFinite(range.min) && Number.isFinite(range.max));
      assert.ok(range.max > range.min);
      assert.ok(Number.isFinite(range.step) && range.step > 0);
      const before = await shotOf(canvas);
      await setRange(page, 'mesh-clip-value', range.min + (range.max - range.min) * 0.5);
      await settle();
      const after = await shotOf(canvas);
      saveShot('02-clip-y-full.png', await page.screenshot({ fullPage: true, encoding: 'base64' }));
      assert.ok(after !== before, '剖切后截图应不同');
      await page.select('#mesh-clip-axis', 'none');
      await settle();
    });

    await t.test('点击部件显示字段与 source JSON 文本，名称含 HTML 也不注入', async () => {
      const selected = await pickPart(page, canvas);
      assert.ok(selected.fields['名称'] !== undefined, JSON.stringify(selected.fields));
      assert.ok(selected.fields['编号'] !== undefined);
      assert.ok(selected.fields['操作'] !== undefined);
      assert.ok(selected.source !== null);
      const parsed = JSON.parse(selected.source) as { operation?: unknown; parameters?: unknown };
      assert.ok(typeof parsed.operation === 'string');
      assert.ok(parsed.parameters !== null && typeof parsed.parameters === 'object');
      // 名称里的 <b> 只能作为文本出现，不能变成元素。
      assert.equal(selected.hasBoldNode, false, '名称中的 HTML 不应被解析成元素');
      saveShot('03-selected-full.png', await page.screenshot({ fullPage: true, encoding: 'base64' }));
    });

    await t.test('整体 / 俯视 / 侧视切换改变画面', async () => {
      await page.click('#mesh-view-overall');
      await settle();
      const overall = await shotOf(canvas);
      await page.click('#mesh-view-top');
      await settle();
      const top = await shotOf(canvas);
      assert.ok(top !== overall, '俯视应改变画面');
      await page.click('#mesh-view-side');
      await settle();
      const side = await shotOf(canvas);
      assert.ok(side !== overall, '侧视应区别于整体');
      assert.ok(side !== top, '侧视应区别于俯视');
      await page.click('#mesh-view-overall');
      await settle();
      assert.ok((await shotOf(canvas)) !== top, '切回整体应再次改变画面');
    });

    await t.test('全程无页面错误与失败请求', () => {
      cleanErrors();
    });

    await launched.close();
    browser = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
    await delay(400);
    assert.deepEqual(pgrepOwn(process.pid), [], '关闭后不应有自己启动的 Chrome 残留');
  },
);
