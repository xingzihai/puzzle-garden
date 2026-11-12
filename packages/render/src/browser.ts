/**
 * Chrome 进程生命周期与页面协议（RENDER-SPEC §3.1、§4.3、§4.4、§9）。
 *
 * 负责：按需启动 / 复用 Chrome，读文件并擦除页面 TS 类型，请求拦截，逐视角渲染，超时与进程组清理。
 * 不负责：存档解析、网格化、相机（render.ts）、公开接口（render.ts）。
 *
 * 进程纪律：必须 `pipe: true`；关闭时先 browser.close() 最多 5 s，再对进程组 `SIGKILL`。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';
import type { Browser, HTTPRequest, LaunchOptions, Page } from 'puppeteer-core';

import type { CameraSpec } from './camera.ts';
import { PAGE_ORIGIN, routeRequest } from './routes.ts';
import type { ResourceKey } from './routes.ts';

/** RENDER-SPEC §9.1 的启动参数；`RenderVersion.flags` 原样回传。 */
export const FLAGS: readonly string[] = [
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

const MIN_CHROME_MAJOR = 154;
const PAGE_CLOSE_TIMEOUT_MS = 2000;
const BROWSER_CLOSE_TIMEOUT_MS = 5000;
const DEFAULT_PAGE_SIZE = 256;
const EMPTY_PACK = new Uint8Array(0);

type StaticKey = Exclude<ResourceKey, 'scene-bin' | 'model-pack-bin'>;

export type BrowserFailureKind = 'unsupported' | 'timeout' | 'crashed' | 'page-error';

export class BrowserFailure extends Error {
  readonly kind: BrowserFailureKind;
  readonly detail: string;

  constructor(kind: BrowserFailureKind, detail: string) {
    super(detail);
    this.name = 'BrowserFailure';
    this.kind = kind;
    this.detail = detail;
  }
}

/** 注入 puppeteer.launch 便于单元测试（不起真 Chrome）；产品路径用默认值。 */
export type LaunchFn = (options: LaunchOptions) => Promise<Browser>;

export interface BrowserHostOptions {
  readonly chromePath: string;
  readonly launchTimeoutMs: number;
  readonly launch?: LaunchFn;
}

export interface InitInfo {
  readonly webglRenderer: string;
  readonly three: string;
}

export interface ViewsResult {
  readonly dataUrls: readonly string[];
  readonly blockedRequests: number;
  readonly init: InitInfo;
  readonly faceCount: number;
  readonly chrome: string;
}

function strip(source: string): string {
  return stripTypeScriptTypes(source);
}

function headerError(detail: string): never {
  throw new BrowserFailure('crashed', detail);
}

export class BrowserHost {
  readonly #chromePath: string;
  readonly #launchTimeoutMs: number;
  readonly #launchFn: LaunchFn;
  readonly #assets: Readonly<Record<StaticKey, string>>;
  #browser: Browser | undefined;
  #pid: number | undefined;
  #userDataDir: string | undefined;
  #onExit: (() => void) | undefined;
  #launchFailures = 0;
  #unsupported = false;
  #modelPack: Uint8Array = EMPTY_PACK;

  constructor(options: BrowserHostOptions) {
    this.#chromePath = options.chromePath;
    this.#launchTimeoutMs = options.launchTimeoutMs;
    this.#launchFn = options.launch ?? ((launchOptions) => puppeteer.launch(launchOptions));
    this.#assets = this.#loadAssets();
  }

  get flags(): readonly string[] {
    return FLAGS;
  }

  /** 每次 render 前由 renderer 注入官方模型包；空字节表示 fallback。 */
  setModelPack(bytes: Uint8Array | undefined): void {
    this.#modelPack = bytes ?? EMPTY_PACK;
  }

  #loadAssets(): Readonly<Record<StaticKey, string>> {
    const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
    const threeMain = fileURLToPath(import.meta.resolve('three'));
    const index = [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<script type="importmap">{"imports":{"three":"/three/three.module.js"}}</script>',
      '</head><body><script type="module" src="/src/page/main.ts"></script></body></html>',
    ].join('');
    return {
      index,
      main: strip(readFileSync(here('./page/main.ts'), 'utf8')),
      scene: strip(readFileSync(here('./page/scene.ts'), 'utf8')),
      mesh: strip(readFileSync(here('./mesh.ts'), 'utf8')),
      'mesh-parts': strip(readFileSync(here('./mesh-parts.ts'), 'utf8')),
      'model-pack': strip(readFileSync(here('./model-pack.ts'), 'utf8')),
      three: readFileSync(threeMain, 'utf8'),
      'three-core': readFileSync(join(dirname(threeMain), 'three.core.js'), 'utf8'),
    };
  }

  /** 删除上次宿主被 SIGKILL 留下的 `pg-render-<已死 pid>-*` 用户数据目录。 */
  #cleanStaleDirs(): void {
    let names: string[];
    try {
      names = readdirSync(tmpdir());
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^pg-render-(\d+)-/.exec(name);
      if (match === null) continue;
      const pid = Number(match[1]);
      if (pid === process.pid) continue;
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        try {
          rmSync(join(tmpdir(), name), { recursive: true, force: true });
        } catch {
          // 清不掉就下次再清；不影响本次启动。
        }
      }
    }
  }

  async #launch(): Promise<Browser> {
    if (this.#unsupported) throw new BrowserFailure('unsupported', '连续启动失败，本 Renderer 不再重试');
    this.#cleanStaleDirs();
    const userDataDir = mkdtempSync(join(tmpdir(), `pg-render-${String(process.pid)}-`));
    let browser: Browser;
    try {
      browser = await this.#launchFn({
        executablePath: this.#chromePath,
        headless: true,
        pipe: true,
        userDataDir,
        args: [...FLAGS],
        handleSIGINT: true,
        handleSIGTERM: true,
        handleSIGHUP: true,
        timeout: this.#launchTimeoutMs,
      });
    } catch (error) {
      rmSync(userDataDir, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      // 找不到可执行文件 / 起不来才是 unsupported；启动过程中目标被关掉属于 crashed（例如宿主杀进程组）。
      if (/ENOENT|spawn|Executable|not found|Failed to launch/i.test(message)) {
        this.#launchFailures += 1;
        if (this.#launchFailures >= 2) this.#unsupported = true;
        throw new BrowserFailure('unsupported', `启动 Chrome 失败（${this.#chromePath}）：${message}`);
      }
      throw new BrowserFailure('crashed', `启动 Chrome 时崩溃：${message}`);
    }

    const pid = browser.process()?.pid;
    if (pid === undefined) {
      await browser.close().catch(() => undefined);
      rmSync(userDataDir, { recursive: true, force: true });
      this.#launchFailures += 1;
      if (this.#launchFailures >= 2) this.#unsupported = true;
      headerError('启动后拿不到 Chrome 主进程 pid');
    }
    const version = await browser.version();
    const major = Number(/Chrome\/(\d+)/.exec(version)?.[1] ?? '0');
    if (major < MIN_CHROME_MAJOR) {
      await this.#killGroup(browser, pid);
      rmSync(userDataDir, { recursive: true, force: true });
      this.#unsupported = true;
      throw new BrowserFailure('unsupported', `Chrome 版本 ${version} 低于下限 ${String(MIN_CHROME_MAJOR)}`);
    }

    const onExit = (): void => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // 进程组已不存在。
      }
    };
    process.once('exit', onExit);
    this.#browser = browser;
    this.#pid = pid;
    this.#userDataDir = userDataDir;
    this.#onExit = onExit;
    this.#launchFailures = 0;
    return browser;
  }

  async #killGroup(browser: Browser, pid: number): Promise<void> {
    try {
      await browser.close();
    } catch {
      // 已经断开。
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 组已不存在。
    }
  }

  /** 丢弃当前浏览器（崩溃 / 超时 / 页面卡死）：强制杀进程组并清目录。 */
  async discard(): Promise<void> {
    const browser = this.#browser;
    const pid = this.#pid;
    const dir = this.#userDataDir;
    const onExit = this.#onExit;
    this.#browser = undefined;
    this.#pid = undefined;
    this.#userDataDir = undefined;
    this.#onExit = undefined;
    if (onExit !== undefined) process.removeListener('exit', onExit);
    if (browser !== undefined) {
      await Promise.race([
        browser.close().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS)),
      ]);
    }
    if (pid !== undefined) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // 组已不存在。
      }
    }
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }

  /** 幂等关闭（renderer.close 用）：优雅关闭后杀组，不重试。 */
  async close(): Promise<void> {
    await this.discard();
  }

  #remaining(deadline: number): number {
    return Math.max(1, deadline - Date.now());
  }

  async #serve(request: HTTPRequest, sceneBuffer: Uint8Array, counter: { blocked: number }): Promise<void> {
    const url = request.url();
    if (url === `${PAGE_ORIGIN}/favicon.ico`) {
      // Chrome 154 无头会自发请求 favicon；返回 204，不计入 blockedRequests（RENDER-SPEC §4.3）。
      await request.respond({ status: 204 }).catch(() => undefined);
      return;
    }
    const route = routeRequest(url, request.method());
    if (route.kind === 'deny') {
      counter.blocked += 1;
      await request.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    const body: string | Buffer =
      route.key === 'scene-bin'
        ? Buffer.from(sceneBuffer)
        : route.key === 'model-pack-bin'
          ? Buffer.from(this.#modelPack)
          : this.#assets[route.key];
    await request.respond({ status: 200, contentType: route.contentType, body }).catch(() => undefined);
  }

  async #openPage(deadline: number, sceneBuffer: Uint8Array, counter: { blocked: number }): Promise<Page> {
    const browser = await this.#ensureBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(this.#remaining(deadline));
    page.setDefaultNavigationTimeout(this.#remaining(deadline));
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      void this.#serve(request, sceneBuffer, counter);
    });
    await page.goto(`${PAGE_ORIGIN}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { pgReady?: boolean }).pgReady === true, {
      timeout: this.#remaining(deadline),
    });
    return page;
  }

  async #ensureBrowser(): Promise<Browser> {
    if (this.#browser !== undefined) return this.#browser;
    return this.#launch();
  }

  async #initPage(page: Page, width: number, height: number): Promise<InitInfo> {
    const init = await page.evaluate(
      (w: number, h: number) => {
        const target = globalThis as unknown as {
          pgInit?: (width: number, height: number) => { webglRenderer: string; three: string };
        };
        if (typeof target.pgInit !== 'function') throw new Error('页面没有 pgInit');
        return target.pgInit(w, h);
      },
      width,
      height,
    );
    if (!init.webglRenderer.includes('SwiftShader')) {
      throw new BrowserFailure('unsupported', `WebGL 渲染器不是 SwiftShader：${init.webglRenderer}`);
    }
    return init;
  }

  /** 一次 render 的页面步骤：pgInit → pgLoad → 每个视角 pgView → 关页面。 */
  async renderViews(
    sceneBuffer: Uint8Array,
    frames: readonly { readonly view: string; readonly camera: CameraSpec }[],
    width: number,
    height: number,
    deadline: number,
  ): Promise<ViewsResult> {
    const counter = { blocked: 0 };
    let page: Page;
    try {
      page = await this.#openPage(deadline, sceneBuffer, counter);
    } catch (error) {
      await this.discard();
      throw mapFailure(error);
    }
    let failure: BrowserFailure | undefined;
    try {
      const init = await this.#initPage(page, width, height);
      const faceCount = await page.evaluate(async () => {
        const target = globalThis as unknown as { pgLoad?: () => Promise<number> };
        if (typeof target.pgLoad !== 'function') throw new Error('页面没有 pgLoad');
        return target.pgLoad();
      });
      const dataUrls: string[] = [];
      for (const frame of frames) {
        const dataUrl = await page.evaluate((camera) => {
          const target = globalThis as unknown as { pgView?: (spec: unknown) => string };
          if (typeof target.pgView !== 'function') throw new Error('页面没有 pgView');
          return target.pgView(camera);
        }, frame.camera);
        if (typeof dataUrl !== 'string') throw new Error('pgView 没有返回字符串');
        dataUrls.push(dataUrl);
      }
      const browser = this.#browser;
      if (browser === undefined) throw new BrowserFailure('crashed', '浏览器已断开');
      const chrome = await browser.version();
      const closed = await this.#closePage(page);
      if (!closed) {
        await this.discard();
      }
      return { dataUrls, blockedRequests: counter.blocked, init, faceCount, chrome };
    } catch (error) {
      failure = mapFailure(error);
    }
    await this.discard();
    throw failure;
  }

  /** 页面关闭 2 s 内没完成（卡死）返回 false，由调用方丢弃浏览器。 */
  async #closePage(page: Page): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        page.close().then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            resolve(false);
          }, PAGE_CLOSE_TIMEOUT_MS);
        }),
      ]);
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 只需要浏览器版本信息时用（决策 #27 第一条事件）。 */
  async version(deadline: number): Promise<{ chrome: string; init: InitInfo; cpuModel: string }> {
    const counter = { blocked: 0 };
    let page: Page;
    try {
      page = await this.#openPage(deadline, new Uint8Array(0), counter);
    } catch (error) {
      await this.discard();
      throw mapFailure(error);
    }
    try {
      const browser = this.#browser;
      if (browser === undefined) throw new BrowserFailure('crashed', '浏览器已断开');
      const chrome = await browser.version();
      const init = await this.#initPage(page, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
      const closed = await this.#closePage(page);
      if (!closed) await this.discard();
      return { chrome, init, cpuModel: cpus()[0]?.model ?? '' };
    } catch (error) {
      const failure = mapFailure(error);
      await this.discard();
      throw failure;
    }
  }
}

function mapFailure(error: unknown): BrowserFailure {
  if (error instanceof BrowserFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|Timeout/i.test(message)) return new BrowserFailure('timeout', message);
  if (/Target closed|Session closed|Protocol error|disconnected|Connection closed/i.test(message)) {
    return new BrowserFailure('crashed', message);
  }
  return new BrowserFailure('page-error', message);
}
