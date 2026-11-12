/**
 * browser.ts：用注入的 launch 假件测非 Chrome 逻辑（启动失败映射、页面协议、请求白名单、关闭）。
 * 真 Chrome 的端到端在 render.integration.test.ts；本文件不启动浏览器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Browser, Page } from 'puppeteer-core';

import { BrowserFailure, BrowserHost, FLAGS } from './browser.ts';
import type { LaunchFn } from './browser.ts';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  status?: number;
  aborted?: string;
}

class FakePage {
  readonly requests: RecordedRequest[] = [];
  closed = false;
  readonly #handlers: ((request: unknown) => void)[] = [];
  readonly #init: { webglRenderer: string; three: string };
  readonly #faces: number;
  readonly #dataUrl: string;
  readonly #urls: readonly string[];

  constructor(options: {
    init?: { webglRenderer: string; three: string };
    faces?: number;
    dataUrl?: string;
    urls?: readonly string[];
  }) {
    this.#init = options.init ?? { webglRenderer: 'ANGLE (SwiftShader)', three: '186' };
    this.#faces = options.faces ?? 12;
    this.#dataUrl = options.dataUrl ?? 'data:image/png;base64,AAAA';
    this.#urls = options.urls ?? ['http://render.invalid/'];
  }

  setDefaultTimeout(_ms: number): void {}
  setDefaultNavigationTimeout(_ms: number): void {}
  async setRequestInterception(_value: boolean): Promise<void> {}
  on(_event: string, handler: (request: unknown) => void): void {
    this.#handlers.push(handler);
  }
  async goto(_url: string): Promise<void> {
    for (const url of this.#urls) {
      const record: RecordedRequest = { url, method: 'GET' };
      const request = {
        url: () => url,
        method: () => 'GET',
        respond: async (options: { status?: number }) => {
          record.status = options.status ?? 200;
        },
        abort: async (reason: string) => {
          record.aborted = reason;
        },
      };
      this.requests.push(record);
      for (const handler of this.#handlers) handler(request);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  async waitForFunction(): Promise<void> {}
  async evaluate(fn: (...args: never[]) => unknown, ...args: never[]): Promise<unknown> {
    const source = fn.toString();
    if (source.includes('pgInit')) return this.#init;
    if (source.includes('pgLoad')) return this.#faces;
    if (source.includes('pgView')) return this.#dataUrl;
    return args[0] ?? true;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeBrowser {
  readonly page: FakePage;
  readonly #version: string;
  readonly #pid: number | null;
  closed = false;
  constructor(options: { version?: string; pid?: number | null; page: FakePage }) {
    this.#version = options.version ?? 'Chrome/154.0.8037.97';
    this.#pid = options.pid === undefined ? 4242 : options.pid;
    this.page = options.page;
  }
  async newPage(): Promise<Page> {
    return this.page as unknown as Page;
  }
  async version(): Promise<string> {
    return this.#version;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  process(): { pid: number } | null {
    return this.#pid === null ? null : { pid: this.#pid };
  }
  on(_event: string, _handler: unknown): void {}
}

function hostWith(launch: LaunchFn): BrowserHost {
  return new BrowserHost({ chromePath: '/nonexistent/chrome', launchTimeoutMs: 100, launch });
}

const FRAME = {
  view: 'iso-se',
  camera: {
    position: [0, 0, 0] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
    up: [0, 1, 0] as [number, number, number],
    left: -1,
    right: 1,
    top: 1,
    bottom: -1,
    near: 0.1,
    far: 10,
  },
};

test('renderViews：pgInit / pgLoad / 逐视角 / 关页面，请求白名单与 favicon', async () => {
  const page = new FakePage({
    urls: [
      'http://render.invalid/favicon.ico',
      'http://render.invalid/',
      'http://render.invalid/src/mesh.ts',
      'http://render.invalid/scene.bin',
      'http://render.invalid/model-pack.bin',
      'https://evil.example/',
    ],
  });
  const browser = new FakeBrowser({ page });
  const host = hostWith(async () => browser as unknown as Browser);
  host.setModelPack(Uint8Array.from([1, 2, 3, 4]));
  const result = await host.renderViews(new Uint8Array([1, 2, 3]), [FRAME], 256, 256, Date.now() + 5000);
  assert.equal(result.faceCount, 12);
  assert.equal(result.init.three, '186');
  assert.equal(result.chrome, 'Chrome/154.0.8037.97');
  assert.deepEqual(result.dataUrls, ['data:image/png;base64,AAAA']);
  // 只有非白名单的外域请求计入 blockedRequests。
  assert.equal(result.blockedRequests, 1);
  const byUrl = new Map(page.requests.map((r) => [r.url, r]));
  assert.equal(byUrl.get('http://render.invalid/favicon.ico')?.status, 204);
  assert.equal(byUrl.get('http://render.invalid/')?.status, 200);
  assert.equal(byUrl.get('http://render.invalid/src/mesh.ts')?.status, 200);
  assert.equal(byUrl.get('http://render.invalid/scene.bin')?.status, 200);
  assert.equal(byUrl.get('http://render.invalid/model-pack.bin')?.status, 200);
  assert.equal(byUrl.get('https://evil.example/')?.aborted, 'blockedbyclient');
  assert.equal(page.closed, true);
  await host.close();
});

test('version()：返回 chrome / WebGL / CPU 模型', async () => {
  const page = new FakePage({});
  const browser = new FakeBrowser({ page });
  const host = hostWith(async () => browser as unknown as Browser);
  const version = await host.version(Date.now() + 5000);
  assert.equal(version.chrome, 'Chrome/154.0.8037.97');
  assert.equal(version.init.webglRenderer, 'ANGLE (SwiftShader)');
  assert.ok(version.cpuModel.length > 0);
  await host.close();
});

test('启动失败 → unsupported；连续两次后不再调用 launch', async () => {
  let calls = 0;
  const host = hostWith(async () => {
    calls += 1;
    throw new Error('spawn /nonexistent/chrome ENOENT');
  });
  await assert.rejects(
    () => host.renderViews(new Uint8Array(0), [], 256, 256, Date.now() + 5000),
    (e: unknown) => e instanceof BrowserFailure && e.kind === 'unsupported',
  );
  await assert.rejects(() => host.renderViews(new Uint8Array(0), [], 256, 256, Date.now() + 5000), BrowserFailure);
  await assert.rejects(() => host.renderViews(new Uint8Array(0), [], 256, 256, Date.now() + 5000), BrowserFailure);
  assert.equal(calls, 2);
});

test('Chrome 版本低于下限 → unsupported', async () => {
  const page = new FakePage({});
  const browser = new FakeBrowser({ page, version: 'Chrome/100.0.0.0' });
  const host = hostWith(async () => browser as unknown as Browser);
  await assert.rejects(
    () => host.version(Date.now() + 5000),
    (e: unknown) => e instanceof BrowserFailure && e.kind === 'unsupported',
  );
});

test('拿不到主进程 pid → crashed', async () => {
  const page = new FakePage({});
  const browser = new FakeBrowser({ page, pid: null });
  const host = hostWith(async () => browser as unknown as Browser);
  await assert.rejects(
    () => host.version(Date.now() + 5000),
    (e: unknown) => e instanceof BrowserFailure && e.kind === 'crashed',
  );
});

test('WebGL 渲染器不含 SwiftShader → unsupported', async () => {
  const page = new FakePage({ init: { webglRenderer: 'ANGLE (NVIDIA GeForce)', three: '186' } });
  const browser = new FakeBrowser({ page });
  const host = hostWith(async () => browser as unknown as Browser);
  await assert.rejects(
    () => host.version(Date.now() + 5000),
    (e: unknown) => e instanceof BrowserFailure && e.kind === 'unsupported',
  );
});

test('flags 原样返回；未启动时 close / discard 幂等', async () => {
  const host = hostWith(async () => {
    throw new Error('不该启动');
  });
  assert.deepEqual(host.flags, FLAGS);
  await host.close();
  await host.close();
  await host.discard();
});
