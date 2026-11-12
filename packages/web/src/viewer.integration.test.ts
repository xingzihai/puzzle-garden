/**
 * 查看器端到端集成测试（MASSING-SPEC §4 第 3 条），对应概念粗草模（@pg/design/massing）。
 *
 * 真实启动 `startMassingServer({ port: 0 })`，用 puppeteer-core 驱动本机 /usr/bin/google-chrome
 * （headless、`pipe: true`、与 `packages/render/src/browser.ts` 同款 FLAGS），打开真实页面并验证：
 * 资源全部 200 / favicon 204、无页面与控制台错误、画布确实画出体量与透明空间盒（截图取像素统计，
 * 而不是只检查 canvas 存在）、`#spaces` 默认打开并参与点击选取、概念评审报告不冒充“绿色通过”、
 * 各楼层切换、剖切轴与位置（选取不得命中被裁对象，含空间）、版本差异与页面摘要、整体 / 俯视视角，
 * 最后确认无自启进程残留。截图写 `.work/massing/`：整页 + 各层 + 整体 / 俯视，可再生不入库。
 *
 * 概念模型约定（massing.ts）：约 55 个元素、无 wall/furnishing/glazing、8 个楔体坡道、21 个空间、0 净空。
 * 版本差异不硬编码数量：从 `/api/report` 读实际 diff 与页面摘要比对，只要求修改非 0、spacesChanged 非 0。
 *
 * 本机以普通用户 xingzihai 运行，Chrome 不需要 `--no-sandbox`；若在容器 root 下运行才需显式加该参数。
 * 本文件只操作页面公开的 DOM 控件与画布，不注入 window 调试接口，也不逐行镜像实现。
 * 覆盖 STANDARDS §8 的例外文件 `packages/web/src/page/main.ts`（登记在 tools/check-tests.ts）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';
import type { Browser, ElementHandle, Page } from 'puppeteer-core';

import { startMassingServer } from './server.ts';
import type { RunningServer } from './server.ts';

const CHROME = '/usr/bin/google-chrome';
/** 与 packages/render/src/browser.ts 的 FLAGS 保持同款；web 包未声明 @pg/render，故此处复制一份。 */
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
/** 截图目录：仓库根的 .work/massing/（.work/ 已在 .gitignore，可再生成，不提交）。 */
const SHOT_DIR = fileURLToPath(new URL('../../../.work/massing/', import.meta.url));

/** 画布像素统计：背景占比、草地色占比与量化后的颜色数，用来证明“确实画了东西”而非空白画布。 */
interface PixelStats {
  readonly width: number;
  readonly height: number;
  readonly backgroundFraction: number;
  readonly grassFraction: number;
  readonly distinctColors: number;
}

/** 从选中面板读出的信息：元素与空间字段不同，统一放进 fields。 */
interface Selection {
  readonly fields: Readonly<Record<string, string>>;
  readonly name: string;
  readonly id: string;
  readonly size: string;
}

/** `/api/report` 里本测试用到的字段子集（服务端响应可信，按需窄化）。 */
interface ApiReportPayload {
  readonly review: { readonly kind: string; readonly message: string };
  readonly report: { readonly checkedClearances: number; readonly status: string; readonly issues: readonly unknown[] };
  readonly diff: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
    readonly spacesChanged: readonly string[];
  };
  readonly routeReports: readonly unknown[];
}

/** 体量元素或空间，用于按包围盒判定“被剖切整体裁掉”。 */
interface ApiNode {
  readonly id: string;
  readonly bounds: { readonly min: readonly [number, number, number] };
  readonly kind?: string;
  readonly shape?: string;
}

interface ApiBlueprint {
  readonly elements: readonly ApiNode[];
  readonly spaces: readonly ApiNode[];
  readonly clearances: readonly unknown[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 等渲染循环把控件改动落到下一帧。 */
function settle(): Promise<void> {
  return delay(350);
}

/** 只看自己启动的 Chrome：用户数据目录带 `pg-viewer-<宿主 pid>-` 前缀。 */
function pgrepOwn(pid: number): string[] {
  const result = spawnSync('pgrep', ['-f', `pg-viewer-${String(pid)}-`], { encoding: 'utf8' });
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
}

/** 画布区域截图（像素统计用）。 */
async function shotOf(canvas: ElementHandle): Promise<string> {
  return canvas.screenshot({ encoding: 'base64' });
}

/** 整页截图：保留用户实际能看到的标题栏、控制栏与检查面板，而不只是画布。 */
async function fullShot(page: Page): Promise<string> {
  return page.screenshot({ fullPage: true, encoding: 'base64' });
}

/** 单个元素的截图（如整个 `#app` 界面）。 */
async function elementShot(page: Page, selector: string): Promise<string> {
  const element = await page.$(selector);
  assert.ok(element !== null, `缺少元素 ${selector}`);
  return element.screenshot({ encoding: 'base64' });
}

function saveShot(name: string, base64: string): void {
  writeFileSync(join(SHOT_DIR, name), Buffer.from(base64, 'base64'));
}

/** 在浏览器里解码截图并统计像素：避免给 Node 侧引入 PNG 解码依赖。 */
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
    let grass = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index] ?? 0;
      const g = pixels[index + 1] ?? 0;
      const b = pixels[index + 2] ?? 0;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      // scene.background = 0xdfe5ec；PALETTE.grass = #6fae5a（地表草地 / sp-park 用它）。
      if (Math.abs(r - 223) <= 10 && Math.abs(g - 229) <= 10 && Math.abs(b - 236) <= 10) background += 1;
      if (Math.abs(r - 111) <= 30 && Math.abs(g - 174) <= 30 && Math.abs(b - 90) <= 30) grass += 1;
    }
    const total = surface.width * surface.height;
    return {
      width: surface.width,
      height: surface.height,
      backgroundFraction: background / total,
      grassFraction: grass / total,
      distinctColors: colors.size,
    };
  }, base64);
}

async function textOf(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (element) => element.textContent);
}

async function selectValue(page: Page, id: string): Promise<string> {
  return page.$eval(`#${id}`, (element) => {
    if (!(element instanceof HTMLSelectElement)) throw new Error(`#${id} 不是 select`);
    return element.value;
  });
}

async function checkboxOf(page: Page, id: string): Promise<boolean> {
  return page.$eval(`#${id}`, (element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} 不是 input`);
    return element.checked;
  });
}

async function setCheckbox(page: Page, id: string, checked: boolean): Promise<void> {
  await page.$eval(
    `#${id}`,
    (element, value) => {
      if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} 不是 input`);
      element.checked = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    checked,
  );
}

interface RangeState {
  readonly disabled: boolean;
  readonly min: number;
  readonly max: number;
  readonly value: string;
}

async function rangeOf(page: Page, id: string): Promise<RangeState> {
  return page.$eval(`#${id}`, (element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} 不是 input`);
    return {
      disabled: element.disabled,
      min: Number(element.min),
      max: Number(element.max),
      value: element.value,
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

/** 差异计数文本：新增 / 修改 / 删除 / 空间变化。 */
interface DiffCounts {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly spaces: number;
  readonly text: string;
}

function parseCounts(text: string): DiffCounts {
  const match = /新增 (\d+)、修改 (\d+)、删除 (\d+)、空间变化 (\d+)/.exec(text);
  if (match === null) throw new Error(`无法解析差异计数：${text}`);
  return {
    added: Number(match[1]),
    changed: Number(match[2]),
    removed: Number(match[3]),
    spaces: Number(match[4]),
    text,
  };
}

async function diffCounts(page: Page): Promise<DiffCounts> {
  return parseCounts(await textOf(page, '#changes-summary'));
}

/** 读取选中面板的字段；没有 `dl.kv` 时返回 null（尚未选中或点空）。 */
async function selectionDetails(page: Page): Promise<Selection | null> {
  return page.evaluate((): Selection | null => {
    const dl = document.querySelector('#selection-details dl.kv');
    if (dl === null) return null;
    const fields: Record<string, string> = {};
    const terms = Array.from(dl.querySelectorAll('dt'));
    const values = Array.from(dl.querySelectorAll('dd'));
    terms.forEach((term, index) => {
      fields[term.textContent] = values[index]?.textContent ?? '';
    });
    return { fields, name: fields['名称'] ?? '', id: fields['编号'] ?? '', size: fields['尺寸'] ?? '' };
  });
}

/** 在画布上扫描多个点点击，直到选中对象并显示尺寸；找不到就报错。 */
async function pickElement(page: Page, canvas: ElementHandle): Promise<Selection> {
  const box = await canvas.boundingBox();
  assert.ok(box !== null, '画布应有包围盒');
  const xs = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65];
  const ys = [0.5, 0.45, 0.55, 0.4, 0.6, 0.3, 0.7];
  for (const fx of xs) {
    for (const fy of ys) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await delay(80);
      const selected = await selectionDetails(page);
      if (selected !== null && /\d+ × \d+ × \d+/.test(selected.size)) return selected;
    }
  }
  throw new Error('在画布上点击未能选中任何对象');
}

/** 从 Node 侧请求本机服务并解析 JSON（测试进程禁 fetch，这里只用 node:http 访问回环）。 */
function getJson<T>(server: RunningServer, path: string): Promise<T> {
  const target = new URL(server.url);
  return new Promise<T>((resolve, reject) => {
    const req = httpRequest({ hostname: target.hostname, port: target.port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        // JSON.parse 返回 any；服务端响应可信，按调用方给出的类型窄化。
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const support = { ok: existsSync(CHROME) };

test(
  '查看器集成：概念草模加载、空间、选取与剖切',
  { timeout: 120_000, skip: support.ok ? false : `找不到 ${CHROME}` },
  async (t) => {
    // 每次运行重建截图目录，避免旧结果混在新结果里。
    rmSync(SHOT_DIR, { recursive: true, force: true });
    mkdirSync(SHOT_DIR, { recursive: true });
    const userDataDir = mkdtempSync(join(tmpdir(), `pg-viewer-${String(process.pid)}-`));
    const server = await startMassingServer({ port: 0 });
    let browser: Browser | undefined;

    t.after(async () => {
      if (browser !== undefined) {
        await browser.close().catch(() => undefined);
      }
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

    // 采集页面网络与错误；favicon 服务器回 204，不应产生控制台错误。
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

    const isFavicon = (url: string): boolean => url.endsWith('/favicon.ico');
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
    await page.waitForSelector('#viewport canvas', { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('#notes li').length > 0, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('#report p').length > 0, { timeout: 30_000 });
    const canvas = await page.$('#viewport canvas');
    assert.ok(canvas !== null, '页面应创建画布');
    await settle();

    await t.test('资源全部 200 / favicon 204，无页面与控制台错误', () => {
      for (const path of [
        '/',
        '/page/main.ts',
        '/page/scene.ts',
        '/page/controls.ts',
        '/page/report-parser.ts',
        '/vendor/three.module.js',
        '/vendor/three.core.js',
        '/vendor/addons/controls/OrbitControls.js',
        '/api/blueprints',
      ]) {
        const found = [...statuses.entries()].find(([url]) => new URL(url).pathname === path);
        assert.ok(found !== undefined, `${path} 未被请求`);
        assert.equal(found[1], 200, `${path} 状态码`);
      }
      const report = [...statuses.entries()].find(([url]) => new URL(url).pathname === '/api/report');
      assert.ok(report !== undefined, '/api/report 未被请求');
      assert.equal(report[1], 200, '/api/report 状态码');
      const favicon = [...statuses.entries()].find(([url]) => isFavicon(url));
      if (favicon !== undefined) assert.equal(favicon[1], 204, 'favicon 应回 204');
      cleanErrors();
    });

    const baseCanvas = await shotOf(canvas);
    saveShot('01-default-canvas.png', baseCanvas);
    saveShot('01-default-full.png', await fullShot(page));
    saveShot('00-ui-app.png', await elementShot(page, '#app'));
    const baseStats = await canvasStats(page, baseCanvas);
    console.log(`[viewer] 默认像素统计：${JSON.stringify(baseStats)}`);

    await t.test('画布确实画出体量与空间盒（像素统计，而非只检查 canvas 存在）', () => {
      assert.ok(
        baseStats.width > 100 && baseStats.height > 100,
        `画布尺寸：${String(baseStats.width)}×${String(baseStats.height)}`,
      );
      assert.ok(
        baseStats.backgroundFraction < 0.95,
        `背景占比过高，画布近似空白：${String(baseStats.backgroundFraction)}`,
      );
      assert.ok(baseStats.distinctColors >= 8, `量化颜色过少：${String(baseStats.distinctColors)}`);
    });

    await t.test('概念评审报告：不显示绿色通过，未做施工与路线检查', async () => {
      const api = await getJson<ApiReportPayload>(server, '/api/report?variant=base');
      assert.equal(api.review.kind, 'concept');
      assert.ok(api.review.message.includes('概念草模'), api.review.message);
      assert.equal(api.report.checkedClearances, 0, '概念草模不应配置净空');
      assert.equal(api.report.issues.length, 0, '概念草模不应有净空问题');
      assert.equal(api.routeReports.length, 0, '概念草模不应做路线检查');

      const reportText = await textOf(page, '#report');
      assert.ok(reportText.includes(api.review.message), `页面应显示评审文案：${reportText}`);
      assert.ok(reportText.includes('未进行施工检查'), reportText);
      assert.ok(!reportText.includes('检查未发现问题'), `不应冒充通过：${reportText}`);
      assert.equal(
        await page.evaluate(() => document.querySelectorAll('.status-pass').length),
        0,
        '不应出现绿色通过样式',
      );
      assert.equal(await textOf(page, '#status'), '', '状态栏不应显示错误或通过');
    });

    await t.test('概念几何：无墙 / 座席 / 玻璃，8 个楔体坡道、21 空间、0 净空', async () => {
      const blueprints = await getJson<readonly ApiBlueprint[]>(server, '/api/blueprints');
      const base = blueprints[0];
      assert.ok(base !== undefined, '接口应返回方案');
      const kinds = new Set(base.elements.map((element) => element.kind));
      for (const forbidden of ['wall', 'furnishing', 'glazing']) {
        assert.ok(!kinds.has(forbidden), `概念草模不应含 ${forbidden}`);
      }
      const wedges = base.elements.filter((element) => element.shape?.startsWith('wedge') === true).length;
      assert.equal(wedges, 8, '应有 8 个楔体坡道');
      assert.equal(base.spaces.length, 21, '应有 21 个空间');
      assert.equal(base.clearances.length, 0, '概念草模不应配置净空');
      assert.ok(base.elements.length < 100, `概念草模元素应远少于细稿：${String(base.elements.length)}`);
    });

    await t.test('#spaces 默认打开，开关切换可逆', async () => {
      assert.equal(await checkboxOf(page, 'spaces'), true, '#spaces 默认应打开');
      const on = await shotOf(canvas);
      await setCheckbox(page, 'spaces', false);
      await settle();
      const off = await shotOf(canvas);
      saveShot('02-spaces-off-full.png', await fullShot(page));
      assert.ok(off !== on, '关闭空间范围应改变画面');
      await setCheckbox(page, 'spaces', true);
      await settle();
      const again = await shotOf(canvas);
      assert.equal(again, on, '重新打开空间范围应回到同一画面');
    });

    await t.test('默认隐藏地表，各楼层与地表开关按预期改变画面', async () => {
      assert.equal(await selectValue(page, 'level'), 'all');
      assert.equal(await checkboxOf(page, 'surface'), false, '地表开关默认应关闭');
      assert.ok(baseStats.grassFraction < 0.02, `默认不应出现草地色：${String(baseStats.grassFraction)}`);

      await page.select('#level', 'surface');
      await settle();
      const surfaceStats = await canvasStats(page, await shotOf(canvas));
      saveShot('03-level-surface-full.png', await fullShot(page));
      console.log(`[viewer] surface 像素统计：${JSON.stringify(surfaceStats)}`);
      assert.ok(
        surfaceStats.grassFraction > 0.05,
        `选中 surface 楼层应显示草地：${String(surfaceStats.grassFraction)}`,
      );

      for (const [level, shot] of [
        ['b1', '04-level-b1-full.png'],
        ['b2', '05-level-b2-full.png'],
        ['b3', '06-level-b3-full.png'],
      ] as const) {
        await page.select('#level', level);
        await settle();
        const current = await shotOf(canvas);
        saveShot(shot, await fullShot(page));
        assert.ok(current !== baseCanvas, `${level} 楼层截图应与默认不同`);
      }
      await page.select('#level', 'all');
      await settle();

      await setCheckbox(page, 'surface', true);
      await settle();
      const toggled = await canvasStats(page, await shotOf(canvas));
      assert.ok(toggled.grassFraction > 0.05, `打开地表开关应显示草地：${String(toggled.grassFraction)}`);
      await setCheckbox(page, 'surface', false);
      await settle();
    });

    await t.test('选取支持空间与体量：默认不命中隐藏公园', async () => {
      // 选中对象可能是空间（sp-*）或体量元素（ms-*），两种详情都要能正确渲染。
      const assertSelected = (selection: Selection, label: string): void => {
        assert.ok(selection.name.length > 0 && selection.id.length > 0, `${label} 应含名称与编号`);
        assert.match(selection.size, /\d+ × \d+ × \d+/, `${label} 应含尺寸`);
        assert.ok(!selection.name.includes('公园'), `${label} 不应命中隐藏的地表公园：${selection.name}`);
        assert.notEqual(selection.id, 'sp-park', `${label} 隐藏的 sp-park 不应可点`);
        if (selection.id.startsWith('sp-')) {
          assert.ok('用途' in selection.fields, `${label} 空间详情应含用途：${JSON.stringify(selection.fields)}`);
        } else {
          assert.ok('类别' in selection.fields, `${label} 元素详情应含类别：${JSON.stringify(selection.fields)}`);
        }
      };

      await setCheckbox(page, 'spaces', true);
      await page.select('#level', 'all');
      await settle();
      const withSpaces = await pickElement(page, canvas);
      assertSelected(withSpaces, '开空间');
      saveShot('08-selected-space-full.png', await fullShot(page));
      console.log(`[viewer] 开空间选中：${JSON.stringify(withSpaces)}`);

      await setCheckbox(page, 'spaces', false);
      await settle();
      const noSpaces = await pickElement(page, canvas);
      assertSelected(noSpaces, '关空间');
      assert.ok(!noSpaces.id.startsWith('sp-'), '关闭空间范围后不能选中隐藏空间盒');
      saveShot('09-selected-spaces-off-full.png', await fullShot(page));
      console.log(`[viewer] 关空间选中：${JSON.stringify(noSpaces)}`);

      await setCheckbox(page, 'spaces', true);
      await settle();
    });

    await t.test('剖切轴与剖切位置改变画面，且选取不命中被整体裁掉的对象（含空间）', async () => {
      const noClip = await shotOf(canvas);
      assert.equal((await rangeOf(page, 'clip-value')).disabled, true, '不剖切时滑杆应禁用');

      await page.select('#clip-axis', 'x');
      await settle();
      const range = await rangeOf(page, 'clip-value');
      assert.equal(range.disabled, false, '选轴后滑杆应可用');
      assert.equal(range.min, 0);
      assert.equal(range.max, 176);
      await setRange(page, 'clip-value', 100);
      await settle();
      const clipped = await shotOf(canvas);
      saveShot('07-clip-x-full.png', await fullShot(page));
      assert.ok(clipped !== noClip, '剖切后截图应与不剖切不同');

      const blueprints = await getJson<readonly ApiBlueprint[]>(server, '/api/blueprints');
      const base = blueprints[0];
      assert.ok(base !== undefined, '接口应返回方案');
      const outside = [...base.elements, ...base.spaces].filter((node) => node.bounds.min[0] > 100);
      const outsideIds = new Set(outside.map((node) => node.id));
      assert.ok(outsideIds.size > 0, '该剖切位置应存在被整体裁掉的对象');
      assert.ok(
        [...outsideIds].some((id) => id.startsWith('sp-')),
        '被裁对象集合应包含空间（sp-*），不只体量元素',
      );
      const picked = await pickElement(page, canvas);
      assert.ok(!outsideIds.has(picked.id), `剖切后不应选中已被裁掉的对象：${picked.id}`);
      saveShot('07-clip-selected-full.png', await fullShot(page));

      await page.select('#clip-axis', 'none');
      await settle();
    });

    await t.test('版本切换与差异计数与 /api/report 实际输出一致，且版本有空间变化', async () => {
      const baseApi = await getJson<ApiReportPayload>(server, '/api/report?variant=base');
      const baseCounts = await diffCounts(page);
      assert.deepEqual(
        {
          added: baseCounts.added,
          changed: baseCounts.changed,
          removed: baseCounts.removed,
          spaces: baseCounts.spaces,
        },
        {
          added: baseApi.diff.added.length,
          changed: baseApi.diff.changed.length,
          removed: baseApi.diff.removed.length,
          spaces: baseApi.diff.spacesChanged.length,
        },
        baseCounts.text,
      );
      assert.equal(baseCounts.changed, 0, 'base 相对自身不应有修改');
      assert.equal(baseCounts.spaces, 0, 'base 相对自身不应有空间变化');

      for (const [variant, shot] of [
        ['wider-shop', '10-wider-shop-full.png'],
        ['wider-cinema', '11-wider-cinema-full.png'],
      ] as const) {
        const api = await getJson<ApiReportPayload>(server, `/api/report?variant=${variant}`);
        await page.select('#variant', variant);
        await page.waitForFunction(
          (expected) => document.getElementById('changes-summary')?.textContent.includes(`修改 ${expected}、`) === true,
          { timeout: 30_000 },
          String(api.diff.changed.length),
        );
        const counts = await diffCounts(page);
        assert.ok(api.diff.changed.length > 0, `${variant} 相对 base 应有修改`);
        assert.ok(api.diff.spacesChanged.length > 0, `${variant} 相对 base 应有空间变化`);
        assert.deepEqual(
          { added: counts.added, changed: counts.changed, removed: counts.removed, spaces: counts.spaces },
          {
            added: api.diff.added.length,
            changed: api.diff.changed.length,
            removed: api.diff.removed.length,
            spaces: api.diff.spacesChanged.length,
          },
          counts.text,
        );
        saveShot(shot, await fullShot(page));
      }

      await page.select('#variant', 'base');
      await page.waitForFunction(
        () => document.getElementById('changes-summary')?.textContent.includes('修改 0、') === true,
        { timeout: 30_000 },
      );
      assert.equal((await diffCounts(page)).changed, 0, '切回 base 应无修改');
    });

    await t.test('整体 / 俯视视角按钮切换画面', async () => {
      await page.select('#clip-axis', 'none');
      await page.select('#level', 'all');
      await settle();
      const overall = await shotOf(canvas);
      saveShot('12-overall-full.png', await fullShot(page));
      await page.click('#view-top');
      await settle();
      const top = await shotOf(canvas);
      saveShot('13-top-full.png', await fullShot(page));
      assert.ok(top !== overall, '俯视截图应与整体视角不同');
      await page.click('#view-overall');
      await settle();
      assert.ok((await shotOf(canvas)) !== top, '切回整体视角后截图应再次不同');
    });

    await t.test('全程无页面错误与失败请求', () => {
      cleanErrors();
    });

    await launched.close();
    browser = undefined;
    // userDataDir 由本测试创建，puppeteer 不会代删，这里显式清理。
    rmSync(userDataDir, { recursive: true, force: true });
    await delay(400);
    assert.deepEqual(pgrepOwn(process.pid), [], '关闭后不应有自己启动的 Chrome 残留');
    assert.equal(existsSync(userDataDir), false, '用户数据目录应被清理');
  },
);
