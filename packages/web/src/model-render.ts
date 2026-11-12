/**
 * `@pg/web/model-render`：把 ModelDocument 渲染成部件截图（供 agent / CLI 注入截图通道）。
 *
 * 负责：临时启动只读查看器服务（`startMassingServer({ model })`）、用 puppeteer-core 驱动本机 Chrome
 * （headless、`pipe: true`）、打开模型页并依次截取整体 / 俯视 / 侧视三张画布图、返回 `{name, png}`；
 * `renderModelContact` 复用同一套起服务 / 就绪 / 截图流程，在第二个页面把三张 data URL 拼成
 * 固定 1536×384（3×512×384）的 contact 合成图（SUBAGENT-LOOP-SPEC §5.1）。
 * 结束时关闭自己启动的浏览器与服务，并清掉临时用户数据目录（不常驻、不残留进程）。
 * 支持 `AbortSignal`：已中止立即拒绝，过程中中止尽快释放 page / browser / server。
 * 不负责：模型代码执行（`@pg/sandbox/modeling`）、页面 DOM 与几何（page/*.ts）、HTTP 路由（server.ts）。
 *
 * 为什么要独立入口：agent 层不能依赖 `@pg/web`（否则把浏览器 / puppeteer 拖进主循环），
 * 由 CLI 在 tools 入口层 import 本模块并注入。
 * 进程纪律：只关自己启动的浏览器；`close()` 报错或挂起都按 `browser.process().pid` 结束自有进程
 * （优先进程组），绝不按名字全局 pkill、不动用户自己的浏览器；不添加 `--no-sandbox`。
 * 清理失败不静默：若本来因中止而退出，保留 AbortError 并附上清理原因；否则抛出清理错误。
 * 安全边界：只把 schema 校验后的模型数据交给本地临时服务；页面不接受可执行脚本。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import puppeteer from 'puppeteer-core';
import type { Browser, LaunchOptions, Page } from 'puppeteer-core';

import { ModelDocument as ModelDocumentSchema } from '@pg/modeling/schema';
import type { ModelDocument } from '@pg/modeling/schema';

import { startMassingServer } from './server.ts';
import type { RunningServer, StartServerOptions } from './server.ts';

/** 与 `@pg/render` 的 FLAGS 同款（web 不声明 @pg/render，故复制一份，避免跨层依赖）。 */
export const MODEL_RENDER_FLAGS: readonly string[] = [
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

/** 本机默认 Chrome 路径（与 `@pg/render` 一致）。 */
export const DEFAULT_CHROME_PATH = '/usr/bin/google-chrome';

/** 一张截图：`name` 为视角名（overall / top / side），`png` 为 PNG 字节。 */
export interface ModelShot {
  readonly name: string;
  readonly png: Uint8Array;
}

/** 注入点：单测替换服务与浏览器；产品路径用默认值。 */
export interface ModelRenderOptions {
  readonly chromePath?: string;
  readonly width?: number;
  readonly height?: number;
  /** 每次切换视角后的等待毫秒数，让 OrbitControls 阻尼收敛。 */
  readonly settleMs?: number;
  readonly timeoutMs?: number;
  /** `browser.close()` 的上限；超过则杀自己启动的浏览器进程（默认 3000ms）。 */
  readonly closeTimeoutMs?: number;
  /** 渲染中止信号：已中止立即拒绝；过程中中止会尽快释放 page / browser / server。 */
  readonly signal?: AbortSignal;
  readonly launch?: (options: LaunchOptions) => Promise<Browser>;
  readonly startServer?: (options: StartServerOptions) => Promise<RunningServer>;
  /** 测试注入：close 报错 / 超时后杀自己启动的浏览器进程；默认杀 `browser.process().pid` 及其进程组。 */
  readonly kill?: (pid: number | undefined) => void;
}

const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 768;
const DEFAULT_SETTLE_MS = 150;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3000;

/**
 * contact 合成图的固定画幅：三张 512×384 横排，等于 1536×384（SUBAGENT-LOOP-SPEC §5.1）。
 * 导出供调用方与测试引用，避免在各处重复写死像素数。
 */
export const CONTACT_TILE_WIDTH = 512;
export const CONTACT_TILE_HEIGHT = 384;
export const CONTACT_VIEW_COUNT = 3;
export const CONTACT_WIDTH = CONTACT_TILE_WIDTH * CONTACT_VIEW_COUNT;
export const CONTACT_HEIGHT = CONTACT_TILE_HEIGHT;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function zodMessage(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；');
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(): Error {
  const error = new Error('模型渲染已中止（AbortSignal）');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError();
}

/** 等 promise，但 signal 中止时立刻拒绝（已中止也会立刻拒绝），并在落定时摘掉监听器。 */
function guard<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(toError(error));
      },
    );
  });
}

/** 杀自己启动的浏览器：优先进程组，失败再杀主进程；绝不按名字全局 pkill。 */
function killOwnBrowser(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    // 不是独立进程组，退回到只杀主进程。
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 已退出。
  }
}

/**
 * 关闭浏览器，调用方的 finally 必须等它落定：
 * - `close()` 成功 → 正常返回，不杀进程。
 * - `close()` 拒绝或超过上限仍未落定 → **一样**按自有 pid / 进程组结束自己启动的浏览器，
 *   然后抛出清理错误，绝不把“Chrome 可能还活着”当成功。
 * 只处理 `browser.process()` 给出的 pid，不碰其它浏览器，也不按名字 pkill。
 */
async function closeBrowser(
  browser: Browser | undefined,
  timeoutMs: number,
  kill: (pid: number | undefined) => void,
): Promise<void> {
  if (browser === undefined) return;
  const pid = browser.process()?.pid;
  let timer: NodeJS.Timeout | undefined;
  let rejection: unknown;
  const closed = await Promise.race([
    browser.close().then(
      () => true,
      (error: unknown) => {
        rejection = error;
        return false;
      },
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (closed) return;
  kill(pid);
  const reason =
    rejection === undefined ? `超过 ${String(timeoutMs)}ms 仍未结束` : `close() 拒绝：${toError(rejection).message}`;
  throw new Error(
    `关闭浏览器失败（${reason}）；已结束自有浏览器进程（pid=${pid === undefined ? '未知' : String(pid)}）`,
  );
}

/** 依次清理浏览器 / 服务 / 临时目录；返回第一个清理错误（不掩盖后续步骤）。 */
async function cleanup(
  browser: Browser | undefined,
  server: RunningServer | undefined,
  userDataDir: string,
  closeTimeoutMs: number,
  kill: (pid: number | undefined) => void,
): Promise<Error | undefined> {
  let error: Error | undefined;
  try {
    await closeBrowser(browser, closeTimeoutMs, kill);
  } catch (caught) {
    error = toError(caught);
  }
  if (server !== undefined) {
    try {
      await server.close();
    } catch (caught) {
      error ??= toError(caught);
    }
  }
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch (caught) {
    error ??= toError(caught);
  }
  return error;
}

/** 合并原始失败与清理失败：原 AbortError 优先保留名字并附清理原因，否则抛出合并后的错误。 */
function combineCleanup(failure: unknown, cleanupError: Error): Error {
  if (failure === undefined) return cleanupError;
  const base = toError(failure);
  const combined = new Error(`${base.message}；清理时另有错误：${cleanupError.message}`, { cause: base });
  combined.name = base.name;
  return combined;
}

/** 渲染会话上下文：服务与浏览器已就绪，清理由 `runRenderSession` 统一负责。 */
interface RenderSession {
  readonly server: RunningServer;
  readonly browser: Browser;
  readonly signal: AbortSignal | undefined;
  readonly width: number;
  readonly height: number;
  readonly settleMs: number;
  readonly timeoutMs: number;
}

/** 成功 / 失败二选一，让 `runRenderSession` 在不用类型断言的前提下把结果带过 try/catch。 */
type RenderOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * 打开查看器页并等到模型就绪：设定视口、导航、等画布与首帧标记 `pgModelReady`、再等阻尼稳定。
 * 三视角与 contact 图共用同一套就绪判据，避免合成图拿到未渲染完的画布。
 */
async function prepareViewerPage(
  page: Page,
  url: string,
  width: number,
  height: number,
  signal: AbortSignal | undefined,
  settleMs: number,
  timeoutMs: number,
): Promise<void> {
  await guard(page.setViewport({ width, height }), signal);
  await guard(page.goto(`${url}/`, { waitUntil: 'load', timeout: timeoutMs }), signal);
  await guard(page.waitForSelector('#mesh-viewport canvas', { timeout: timeoutMs }), signal);
  await guard(
    page.waitForFunction(() => (globalThis as unknown as { pgModelReady?: boolean }).pgModelReady === true, {
      timeout: timeoutMs,
    }),
    signal,
  );
  await guard(delay(settleMs), signal);
}

/** 依次点击整体 / 俯视 / 侧视并截取 `#mesh-viewport canvas`；视角顺序是调用方与金标测试的契约。 */
async function captureViewShots(
  page: Page,
  signal: AbortSignal | undefined,
  settleMs: number,
): Promise<readonly ModelShot[]> {
  const captured: ModelShot[] = [];
  const cases = [
    ['overall', '#mesh-view-overall'],
    ['top', '#mesh-view-top'],
    ['side', '#mesh-view-side'],
  ] as const;
  for (const [name, selector] of cases) {
    throwIfAborted(signal);
    await guard(page.click(selector), signal);
    await guard(delay(settleMs), signal);
    const canvas = await guard(page.$('#mesh-viewport canvas'), signal);
    if (canvas === null) throw new Error('页面缺少 #mesh-viewport canvas');
    captured.push({ name, png: await guard(canvas.screenshot(), signal) });
  }
  throwIfAborted(signal);
  return captured;
}

/**
 * 起服务 + Chrome 并保证清理的公共骨架：解析并二次校验文档、建临时 userDataDir、执行 `render`，
 * 无论成功、失败还是中止，返回前都会关闭自有 page / browser / server 并删掉临时目录。
 * 已中止立即拒绝（不建目录、不启动进程）；中止 + 清理失败时保留 AbortError 并附清理原因。
 * 之所以抽成骨架而不是让两个入口各写一份：中止与清理是安全边界，必须逐字一致。
 */
async function runRenderSession<T>(
  document: ModelDocument,
  options: ModelRenderOptions,
  render: (session: RenderSession) => Promise<T>,
): Promise<T> {
  const parsed = ModelDocumentSchema.safeParse(document);
  if (!parsed.success) throw new Error(`ModelDocument 不合法：${zodMessage(parsed.error.issues)}`);
  const signal = options.signal;
  throwIfAborted(signal);

  const start = options.startServer ?? startMassingServer;
  const launch = options.launch ?? ((launchOptions: LaunchOptions) => puppeteer.launch(launchOptions));
  const kill = options.kill ?? killOwnBrowser;
  const chromePath = options.chromePath ?? DEFAULT_CHROME_PATH;
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;

  const userDataDir = mkdtempSync(join(tmpdir(), `pg-model-render-${String(process.pid)}-`));
  let server: RunningServer | undefined;
  let browser: Browser | undefined;
  let outcome: RenderOutcome<T>;

  try {
    // start / launch 用 await 而不是 race：即使中止发生在启动期间，晚到的 server / browser
    // 也会被赋给下面这两个句柄，由统一清理关闭，不会留下无人认领的进程。
    server = await start({ port: 0, model: parsed.data });
    throwIfAborted(signal);
    browser = await launch({
      executablePath: chromePath,
      headless: true,
      pipe: true,
      userDataDir,
      args: [...MODEL_RENDER_FLAGS],
      handleSIGINT: true,
      handleSIGTERM: true,
      handleSIGHUP: true,
      timeout: timeoutMs,
    });
    throwIfAborted(signal);
    outcome = { ok: true, value: await render({ server, browser, signal, width, height, settleMs, timeoutMs }) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const cleanupError = await cleanup(browser, server, userDataDir, closeTimeoutMs, kill);
  if (cleanupError !== undefined) throw combineCleanup(outcome.ok ? undefined : outcome.error, cleanupError);
  if (!outcome.ok) throw toError(outcome.error);
  return outcome.value;
}

/**
 * 渲染整体 / 俯视 / 侧视三张部件截图。文档先二次校验（外部输入不信任），
 * 只截取 `#mesh-viewport canvas`，不把整页 UI 混进交付图。
 * `signal` 覆盖整个生命周期：已中止立即拒绝；过程中中止会关闭自己启动的 page / browser / server。
 */
export async function renderModelViews(
  document: ModelDocument,
  options: ModelRenderOptions = {},
): Promise<readonly ModelShot[]> {
  return runRenderSession(
    document,
    options,
    async ({ server, browser, signal, width, height, settleMs, timeoutMs }) => {
      const page = await guard(browser.newPage(), signal);
      await prepareViewerPage(page, server.url, width, height, signal, settleMs, timeoutMs);
      return captureViewShots(page, signal, settleMs);
    },
  );
}

/** PNG 字节转 data URL：contact 页不读服务，图片直接内联进 `setContent` 的 HTML。 */
function pngDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

/** 属性值最小转义：data URL 正常只有 base64 字符，但布局函数是纯函数，仍按不可信输入处理。 */
function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * contact 合成图的 HTML 布局（纯函数，同输入同输出）：把三张 data URL 按 1×3 横排，
 * 每格 512×384，拼成固定 1536×384 的画幅，不留边距与空隙；数量不是 3 直接报错，
 * 避免悄悄少图或错位。用 flex 排版是为了绕开行内元素的基线空隙。
 */
export function contactHtml(dataUrls: readonly string[]): string {
  if (dataUrls.length !== CONTACT_VIEW_COUNT) {
    throw new Error(`合成图需要 ${String(CONTACT_VIEW_COUNT)} 张图片，收到 ${String(dataUrls.length)}`);
  }
  const tiles = dataUrls
    .map(
      (url) =>
        `<img src="${escapeAttribute(url)}" width="${String(CONTACT_TILE_WIDTH)}" height="${String(CONTACT_TILE_HEIGHT)}" alt="">`,
    )
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:#dfe5ec}body{display:flex}img{display:block;flex:none;width:${String(CONTACT_TILE_WIDTH)}px;height:${String(CONTACT_TILE_HEIGHT)}px}</style></head><body>${tiles}</body></html>`;
}

/**
 * 渲染 contact 合成图：先按 `renderModelViews` 同款流程取 overall / top / side 三张画布截图，
 * 再把它们转成 data URL 交给第二个页面排版并整页截图，返回 `{ name: 'contact', png }`。
 * 与三视角共用一次服务 / 浏览器会话，结束时按 `runRenderSession` 统一清理；中止语义同 `renderModelViews`。
 */
export async function renderModelContact(
  document: ModelDocument,
  options: ModelRenderOptions = {},
): Promise<ModelShot> {
  return runRenderSession(
    document,
    options,
    async ({ server, browser, signal, width, height, settleMs, timeoutMs }) => {
      const page = await guard(browser.newPage(), signal);
      await prepareViewerPage(page, server.url, width, height, signal, settleMs, timeoutMs);
      const views = await captureViewShots(page, signal, settleMs);
      const dataUrls = views.map((shot) => pngDataUrl(shot.png));
      // 第二个页面只做排版：setContent 的内联 <img> 不走服务，也不接受任何脚本。
      const contactPage = await guard(browser.newPage(), signal);
      await guard(contactPage.setViewport({ width: CONTACT_WIDTH, height: CONTACT_HEIGHT }), signal);
      await guard(contactPage.setContent(contactHtml(dataUrls), { waitUntil: 'load', timeout: timeoutMs }), signal);
      const png = await guard(contactPage.screenshot(), signal);
      return { name: 'contact', png };
    },
  );
}
