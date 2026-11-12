/**
 * 屋面查看器端到端集成测试，对应圆厅旋转壳样例（`@pg/design/roof-example`）。
 *
 * 真实启动 `startMassingServer({ port: 0 })`（默认 plaza），用 puppeteer-core 驱动本机
 * /usr/bin/google-chrome（headless、`pipe: true`、独立临时 profile），打开真实页面后经 `#example`
 * 切到 roof，验证：
 * - 新增页面模块全部 200、无控制台 / 页面错误与失败请求；
 * - 切 roof 后默认显示地表、楼层下拉动态含 surface / roof、版本下拉动态为 cone / reciprocal / curved；
 * - 三版屋面都真的渲染出来，画布截图两两有可观测差异（PNG 不同 + 像素差异占比），且与 `/api/blueprints`
 *   的 profile 参数（kind / curvature）一致；
 * - `#curvature` 滑杆范围 0–20，调 4 / 10 / 0 时 `#curve-info` 显示实际公式与 R=16、H=24、k；
 * - 本地预览时 `#changes-summary` 反映浏览器内实时差异并标明“本地参数预览未保存”，切版本恢复预置参数。
 * - 关闭空间后点击屋面，选中详情含 profile（母线）与采样分段。
 * - `level='roof'` 只留旋转壳屋面并渲染非空画面，屋面可选、曲率面板显示实际参数，同一层可做 y 剖面；
 * - 切回 plaza 恢复旧三版且曲率面板隐藏，画布仍可渲染。
 *
 * 与 `viewer.integration.test.ts` 互补：后者测 plaza 的空间 / 剖切 / 版本；本文件只测 roof 的曲率预览链路。
 * 本机以普通用户运行，Chrome 不需要 `--no-sandbox`；截图写 `.work/massing-roof/`，只创建自己的目录，
 * 不删除 `.work/` 下任何其它目录（可再生，不入库）。
 *
 * 本文件只操作页面公开的 DOM 控件与画布，不注入调试接口、不逐行镜像实现，也不把 API 结果当作浏览器的替代。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
/** 与 packages/render/src/browser.ts 的 FLAGS 同款；web 包未声明 @pg/render，故此处复制一份。 */
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
/** 截图目录：仓库根 .work/massing-roof/（.work/ 已在 .gitignore，可再生成，不提交）。 */
const SHOT_DIR = fileURLToPath(new URL('../../../.work/massing-roof/', import.meta.url));

/** 画布像素统计：证明“确实画了东西”而非空白画布。 */
interface PixelStats {
  readonly width: number;
  readonly height: number;
  readonly backgroundFraction: number;
  readonly distinctColors: number;
}

/** 从选中面板读出的字段；元素与空间字段不同，统一放进 fields。 */
interface Selection {
  readonly fields: Readonly<Record<string, string>>;
  readonly name: string;
  readonly id: string;
}

/** `/api/blueprints?example=roof` 里本测试用到的字段子集（服务端已用 schema 校验）。 */
interface ApiLatheProfile {
  readonly kind: string;
  readonly curvature: number;
  readonly heightSegments: number;
  readonly radialSegments: number;
}
interface ApiElement {
  readonly id: string;
  readonly shape: string;
  readonly profile?: ApiLatheProfile;
}
interface ApiRoofBlueprint {
  readonly id: string;
  readonly revision: number;
  readonly levels: readonly { readonly id: string }[];
  readonly elements: readonly ApiElement[];
}

/** `/api/report` 里本测试用到的字段子集。 */
interface ApiReportPayload {
  readonly review: { readonly kind: string; readonly message: string };
  readonly diff: { readonly added: readonly string[]; readonly changed: readonly string[] };
}

/** 三个屋面版本按服务端固定顺序对应的预期 profile。 */
const ROOF_CASES: readonly { readonly variant: string; readonly kind: string; readonly curvature: number }[] = [
  { variant: 'cone', kind: 'linear', curvature: 0 },
  { variant: 'reciprocal', kind: 'reciprocal', curvature: 2 },
  { variant: 'curved', kind: 'reciprocal', curvature: 6 },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 等渲染循环把控件改动落到下一帧。 */
function settle(): Promise<void> {
  return delay(350);
}

/** 只看自己启动的 Chrome：用户数据目录带 `pg-roof-<宿主 pid>-` 前缀。 */
function pgrepOwn(pid: number): string[] {
  const result = spawnSync('pgrep', ['-f', `pg-roof-${String(pid)}-`], { encoding: 'utf8' });
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
}

/** 画布截图（像素统计与差异比较用）。 */
async function shotOf(canvas: ElementHandle): Promise<string> {
  return canvas.screenshot({ encoding: 'base64' });
}

/** 整页截图：保留用户实际能看到的标题栏、控制栏与检查面板。 */
async function fullShot(page: Page): Promise<string> {
  return page.screenshot({ fullPage: true, encoding: 'base64' });
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
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index] ?? 0;
      const g = pixels[index + 1] ?? 0;
      const b = pixels[index + 2] ?? 0;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      // scene.background = 0xdfe5ec。
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

/** 两张截图的像素差异占比（各通道绝对差之和 > 24 记为不同）：用来证明轮廓“明显变化”。 */
async function pixelDiffFraction(page: Page, left: string, right: string): Promise<number> {
  return page.evaluate(
    async (a: string, b: string): Promise<number> => {
      const decode = async (value: string): Promise<ImageData> => {
        const image = new Image();
        image.src = `data:image/png;base64,${value}`;
        await image.decode();
        const surface = document.createElement('canvas');
        surface.width = image.naturalWidth;
        surface.height = image.naturalHeight;
        const context = surface.getContext('2d');
        if (context === null) throw new Error('无法取得 2d 上下文');
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, surface.width, surface.height);
      };
      const x = await decode(a);
      const y = await decode(b);
      const width = Math.min(x.width, y.width);
      const height = Math.min(x.height, y.height);
      let differing = 0;
      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          const i = (row * x.width + column) * 4;
          const j = (row * y.width + column) * 4;
          const delta =
            Math.abs((x.data[i] ?? 0) - (y.data[j] ?? 0)) +
            Math.abs((x.data[i + 1] ?? 0) - (y.data[j + 1] ?? 0)) +
            Math.abs((x.data[i + 2] ?? 0) - (y.data[j + 2] ?? 0));
          if (delta > 24) differing += 1;
        }
      }
      return differing / (width * height);
    },
    left,
    right,
  );
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

async function optionValues(page: Page, id: string): Promise<readonly string[]> {
  return page.$$eval(`#${id} option`, (options) => options.map((option) => option.getAttribute('value') ?? ''));
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
    return { disabled: element.disabled, min: Number(element.min), max: Number(element.max), value: element.value };
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
    return { fields, name: fields['名称'] ?? '', id: fields['编号'] ?? '' };
  });
}

/** 在画布上扫描多个点点击，直到选中屋面元素 roof-profile；找不到就报错并附最后一次选中。 */
async function pickRoof(page: Page, canvas: ElementHandle): Promise<Selection> {
  const box = await canvas.boundingBox();
  assert.ok(box !== null, '画布应有包围盒');
  const fractions = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7];
  let last: Selection | null = null;
  for (const fx of fractions) {
    for (const fy of fractions) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await delay(80);
      const selected = await selectionDetails(page);
      if (selected === null) continue;
      last = selected;
      if (selected.id === 'roof-profile') return selected;
    }
  }
  throw new Error(`未能点中屋面 roof-profile；最后选中：${JSON.stringify(last)}`);
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

/** 从方案里取 lathe 元素的 profile；没有就抛错。 */
function roofProfileOf(blueprint: ApiRoofBlueprint): ApiLatheProfile {
  const roof = blueprint.elements.find((element) => element.shape === 'lathe');
  if (roof?.profile === undefined) throw new Error(`方案 ${blueprint.id} 缺少 lathe profile`);
  return roof.profile;
}

const support = { ok: existsSync(CHROME) };

test(
  'roof 查看器集成：曲率本地预览、三版轮廓与详情',
  { timeout: 180_000, skip: support.ok ? false : `找不到 ${CHROME}` },
  async (t) => {
    // 只创建自己的子目录；只清理本目录下的旧 PNG 以刷新截图，不触碰 .work/ 下其它目录。
    mkdirSync(SHOT_DIR, { recursive: true });
    for (const name of readdirSync(SHOT_DIR)) {
      const full = join(SHOT_DIR, name);
      if (name.endsWith('.png') && statSync(full).isFile()) rmSync(full, { force: true });
    }
    const userDataDir = mkdtempSync(join(tmpdir(), `pg-roof-${String(process.pid)}-`));
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

    const statusOf = (path: string): number | undefined => {
      const found = [...statuses.entries()].find(([url]) => new URL(url).pathname === path);
      return found?.[1];
    };
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
    const canvas = await page.$('#viewport canvas');
    assert.ok(canvas !== null, '页面应创建画布');
    await settle();

    await t.test('默认 plaza：新增页面模块全部 200，无错误', () => {
      for (const path of [
        '/page/main.ts',
        '/page/scene.ts',
        '/page/controls.ts',
        '/page/report-parser.ts',
        '/page/lathe.ts',
        '/page/profile-parser.ts',
        '/page/example-controls.ts',
        '/vendor/three.module.js',
        '/vendor/three.core.js',
        '/vendor/addons/controls/OrbitControls.js',
        '/api/blueprints',
      ]) {
        assert.equal(statusOf(path), 200, `${path} 状态码`);
      }
      assert.equal(statusOf('/api/report'), 200, '/api/report 状态码');
      const favicon = [...statuses.entries()].find(([url]) => url.endsWith('/favicon.ico'));
      if (favicon !== undefined) assert.equal(favicon[1], 204, 'favicon 应回 204');
      cleanErrors();
    });

    await t.test('经 #example 切 roof：默认显示地表、楼层与版本动态', async () => {
      assert.equal(await selectValue(page, 'example'), 'plaza', '初始默认样例应为 plaza');
      await page.select('#example', 'roof');
      await page.waitForFunction(
        () =>
          document.getElementById('curve-info')?.textContent.includes('k=0') === true &&
          document.getElementById('curve-panel')?.hidden === false,
        { timeout: 30_000 },
      );
      await settle();

      assert.equal(await checkboxOf(page, 'surface'), true, 'roof 默认应勾选显示地表');
      assert.equal(await selectValue(page, 'level'), 'all', 'roof 默认看全部');
      assert.deepEqual(await optionValues(page, 'variant'), ['cone', 'reciprocal', 'curved']);
      assert.deepEqual(
        await optionValues(page, 'level'),
        ['all', 'surface', 'roof'],
        '楼层下拉应动态含 surface / roof',
      );
      assert.equal(
        await page.$eval('#curve-panel', (element) => element.hasAttribute('hidden')),
        false,
        'roof 应显示曲率面板',
      );
      const info = await textOf(page, '#curve-info');
      assert.ok(info.includes('母线 linear'), info);
      assert.ok(info.includes('R=16'), info);
      assert.ok(info.includes('H=24'), info);
      assert.ok(info.includes('k=0'), info);
      saveShot('00-roof-default-cone-full.png', await fullShot(page));
      cleanErrors();
    });

    const apiBlueprints = await getJson<readonly ApiRoofBlueprint[]>(server, '/api/blueprints?example=roof');
    const shots = new Map<string, string>();

    await t.test('三版屋面都渲染，截图轮廓明显不同且与 API profile 一致', async () => {
      for (const entry of ROOF_CASES) {
        const index = ROOF_CASES.findIndex((item) => item.variant === entry.variant);
        const blueprint = apiBlueprints[index];
        assert.ok(blueprint !== undefined, `接口应返回第 ${String(index)} 版`);
        const profile = roofProfileOf(blueprint);
        assert.equal(profile.kind, entry.kind, `${entry.variant} kind`);
        assert.equal(profile.curvature, entry.curvature, `${entry.variant} curvature`);

        await page.select('#variant', entry.variant);
        await page.waitForFunction(
          (expected) => document.getElementById('curve-info')?.textContent.includes(`k=${expected}`) === true,
          { timeout: 30_000 },
          String(entry.curvature),
        );
        await settle();

        const info = await textOf(page, '#curve-info');
        assert.ok(info.includes(`k=${String(entry.curvature)}`), info);
        assert.ok(info.includes('R=16') && info.includes('H=24'), info);

        const canvasShot = await shotOf(canvas);
        shots.set(entry.variant, canvasShot);
        const stats = await canvasStats(page, canvasShot);
        assert.ok(
          stats.backgroundFraction < 0.95 && stats.distinctColors >= 8,
          `${entry.variant} 画布近似空白：${JSON.stringify(stats)}`,
        );
        saveShot(`0${String(index + 1)}-${entry.variant}-full.png`, await fullShot(page));
      }

      // 轮廓差异：三版两两比较，PNG 不同且像素差异占比可观测。
      const pairs: readonly (readonly [string, string])[] = [
        ['cone', 'reciprocal'],
        ['cone', 'curved'],
        ['reciprocal', 'curved'],
      ];
      for (const [a, b] of pairs) {
        const left = shots.get(a);
        const right = shots.get(b);
        assert.ok(left !== undefined && right !== undefined, `缺少 ${a} / ${b} 截图`);
        assert.notEqual(left, right, `${a} 与 ${b} 的 PNG 应不同`);
        const fraction = await pixelDiffFraction(page, left, right);
        assert.ok(fraction > 0.01, `${a} 与 ${b} 像素差异过小：${String(fraction)}`);
      }

      // API 预置差异：reciprocal / curved 相对 cone 只改了屋面 profile。
      const curvedReport = await getJson<ApiReportPayload>(server, '/api/report?example=roof&variant=curved');
      assert.equal(curvedReport.review.kind, 'concept');
      assert.deepEqual(curvedReport.diff.changed, ['roof-profile']);
      assert.deepEqual(curvedReport.diff.added, []);
    });

    await t.test('曲率滑杆 0–20：调 4 / 10 / 0 更新公式、本地差异与未保存标记', async () => {
      // 以 cone 为本地基准，保证 k=0 与预置 cone 一致。
      await page.select('#variant', 'cone');
      await page.waitForFunction(() => document.getElementById('curve-info')?.textContent.includes('k=0') === true, {
        timeout: 30_000,
      });
      await settle();

      const range = await rangeOf(page, 'curvature');
      assert.equal(range.min, 0, '#curvature min');
      assert.equal(range.max, 20, '#curvature max');

      await setRange(page, 'curvature', 4);
      await settle();
      const info4 = await textOf(page, '#curve-info');
      assert.ok(info4.includes('母线 reciprocal'), info4);
      assert.ok(info4.includes('r(t)=R·(1−t)/(1+k·t)'), info4);
      assert.ok(info4.includes('R=16') && info4.includes('H=24') && info4.includes('k=4'), info4);
      assert.ok(info4.includes('本地参数预览未保存'), info4);
      const counts4 = await diffCounts(page);
      assert.equal(counts4.changed, 1, counts4.text);
      assert.equal(counts4.added, 0, counts4.text);
      assert.ok(counts4.text.includes('本地参数预览未保存'), counts4.text);

      await setRange(page, 'curvature', 10);
      await settle();
      const info10 = await textOf(page, '#curve-info');
      assert.ok(info10.includes('k=10'), info10);
      assert.ok(info10.includes('本地参数预览未保存'), info10);
      assert.equal((await diffCounts(page)).changed, 1, 'k=10 也应只改屋面');
      saveShot('04-local-k10-full.png', await fullShot(page));
      saveShot('04-local-k10-canvas.png', await shotOf(canvas));

      await setRange(page, 'curvature', 0);
      await settle();
      const info0 = await textOf(page, '#curve-info');
      assert.ok(info0.includes('母线 linear'), info0);
      assert.ok(info0.includes('r(t)=R·(1−t)'), info0);
      assert.ok(info0.includes('k=0'), info0);
      assert.ok(info0.includes('本地参数预览未保存'), '本地预览应始终标明未保存');
      const counts0 = await diffCounts(page);
      assert.equal(counts0.changed, 0, 'k=0 与预置 cone 一致，本地差异应为 0');
      assert.ok(counts0.text.includes('本地参数预览未保存'), counts0.text);
      cleanErrors();
    });

    await t.test('切版本恢复预置参数（curved k=6）并退出本地预览', async () => {
      await page.select('#variant', 'curved');
      await page.waitForFunction(
        () =>
          document.getElementById('curve-info')?.textContent.includes('k=6') === true &&
          document.getElementById('changes-summary')?.textContent.includes('本地参数预览未保存') === false,
        { timeout: 30_000 },
      );
      await settle();
      const info = await textOf(page, '#curve-info');
      assert.ok(info.includes('母线 reciprocal') && info.includes('k=6'), info);
      const range = await rangeOf(page, 'curvature');
      assert.equal(range.value, '6', '切版本应把滑杆重置为该版曲率');
      const summary = await textOf(page, '#changes-summary');
      assert.ok(!summary.includes('本地参数预览未保存'), `切版本后不应再是本地差异：${summary}`);
      cleanErrors();
    });

    await t.test('关空间后点击屋面：详情含 profile（母线）与采样', async () => {
      await setCheckbox(page, 'spaces', false);
      await settle();
      const selection = await pickRoof(page, canvas);
      assert.equal(selection.id, 'roof-profile', selection.id);
      assert.equal(selection.fields['形体'], 'lathe', JSON.stringify(selection.fields));
      assert.equal(selection.fields['母线'], 'reciprocal', JSON.stringify(selection.fields));
      assert.equal(selection.fields['曲率 k'], '6', JSON.stringify(selection.fields));
      assert.match(selection.fields['采样'] ?? '', /^24×48$/, JSON.stringify(selection.fields));
      saveShot('05-roof-selected-full.png', await fullShot(page));
      await setCheckbox(page, 'spaces', true);
      await settle();
      cleanErrors();
    });

    await t.test('roof 楼层：薄壳真实渲染、可选且可 y 剖面', async () => {
      // 切到 roof 楼层：只保留旋转壳屋面，应真的渲染出非空画面，而不是空画布。
      await page.select('#level', 'roof');
      await settle();
      const levelShot = await shotOf(canvas);
      const levelStats = await canvasStats(page, levelShot);
      saveShot('06-roof-level-roof-full.png', await fullShot(page));
      assert.ok(
        levelStats.backgroundFraction < 0.95 && levelStats.distinctColors >= 8,
        `roof 楼层应渲染出屋面：${JSON.stringify(levelStats)}`,
      );

      // roof 层里屋面可选：关空间后点中 roof-profile，详情含 profile / 采样，曲率面板显示实际参数。
      await setCheckbox(page, 'spaces', false);
      await settle();
      const selection = await pickRoof(page, canvas);
      assert.equal(selection.id, 'roof-profile', selection.id);
      assert.equal(selection.fields['形体'], 'lathe', JSON.stringify(selection.fields));
      assert.match(selection.fields['采样'] ?? '', /^\d+×\d+$/, JSON.stringify(selection.fields));
      assert.equal(
        await page.$eval('#curve-panel', (element) => element.hasAttribute('hidden')),
        false,
        'roof 层应显示曲率面板',
      );
      const info = await textOf(page, '#curve-info');
      assert.ok(info.includes('k=6') && info.includes('R=16') && info.includes('H=24'), info);
      saveShot('07-roof-level-selected-full.png', await fullShot(page));
      await setCheckbox(page, 'spaces', true);
      await settle();

      // 同一 roof 层上做 y 剖面：切面应改变画面且仍非空。
      const beforeClip = await shotOf(canvas);
      await page.select('#clip-axis', 'y');
      await settle();
      const range = await rangeOf(page, 'clip-value');
      assert.equal(range.disabled, false, '选轴后滑杆应可用');
      assert.equal(range.min, -1, 'y 范围应含基底');
      assert.equal(range.max, 36, 'y 范围应含壳顶');
      await setRange(page, 'clip-value', 24);
      await settle();
      const section = await shotOf(canvas);
      const sectionStats = await canvasStats(page, section);
      saveShot('08-roof-level-clip-y-full.png', await fullShot(page));
      assert.notEqual(section, beforeClip, 'roof 层的 y 剖面应改变画面');
      assert.ok(sectionStats.distinctColors >= 8, JSON.stringify(sectionStats));

      await page.select('#clip-axis', 'none');
      await page.select('#level', 'all');
      await settle();
      cleanErrors();
    });

    await t.test('切回 plaza：恢复旧三版、曲率面板隐藏，画面仍可渲染', async () => {
      await page.select('#example', 'plaza');
      await page.waitForFunction(
        () =>
          document.getElementById('curve-panel')?.hidden === true &&
          Array.from(document.querySelectorAll('#variant option')).some(
            (option) => option.getAttribute('value') === 'wider-cinema',
          ),
        { timeout: 30_000 },
      );
      await settle();
      assert.deepEqual(await optionValues(page, 'variant'), ['base', 'wider-shop', 'wider-cinema']);
      assert.equal(
        await page.$eval('#curve-panel', (element) => element.hasAttribute('hidden')),
        true,
        'plaza 曲率面板应隐藏',
      );
      assert.equal((await textOf(page, '#curve-info')).trim(), '', 'plaza 曲率文案应为空');
      const stats = await canvasStats(page, await shotOf(canvas));
      assert.ok(stats.distinctColors >= 8 && stats.backgroundFraction < 0.95, JSON.stringify(stats));
      saveShot('09-plaza-restored-full.png', await fullShot(page));
      cleanErrors();
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
