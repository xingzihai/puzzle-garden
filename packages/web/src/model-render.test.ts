/**
 * model-render.ts 的单元测试：用注入的假服务与假浏览器验证编排（overall / top / side 视角顺序、
 * 截图字节、关闭服务与浏览器、无效文档不启动任何进程）。真实 Chrome 在 model-render.integration.test.ts。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Browser, Page } from 'puppeteer-core';

import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';

import {
  CONTACT_HEIGHT,
  CONTACT_WIDTH,
  DEFAULT_CHROME_PATH,
  MODEL_RENDER_FLAGS,
  contactHtml,
  renderModelContact,
  renderModelViews,
} from './model-render.ts';
import type { RunningServer, StartServerOptions } from './server.ts';

/** 与调用顺序无关；`$` 返回的画布截图按选择器给不同字节，便于断言 two views 不同。 */
class FakeElement {
  readonly selector: string;
  constructor(selector: string) {
    this.selector = selector;
  }
  screenshot(): Promise<Uint8Array> {
    return Promise.resolve(this.selector.includes('canvas') ? new Uint8Array([1, 2, 3]) : new Uint8Array([0]));
  }
}

class FakePage {
  readonly clicks: string[] = [];
  readonly viewports: { width: number; height: number }[] = [];
  /** contact 页 setContent 收到的 HTML（与模型页共用一个假页对象）。 */
  readonly contents: string[] = [];
  gotoUrl: string | undefined;
  /** 置 true 时 waitForFunction 永不落定，用来在“过程中”触发 abort。 */
  holdWaitForFunction = false;
  setViewport(size: { width: number; height: number }): Promise<void> {
    this.viewports.push(size);
    return Promise.resolve();
  }
  setContent(html: string): Promise<void> {
    this.contents.push(html);
    return Promise.resolve();
  }
  /** contact 页整页截图返回独立字节，与画布截图（FakeElement）区分开。 */
  screenshot(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array([9, 8, 7]));
  }
  goto(url: string): Promise<void> {
    this.gotoUrl = url;
    return Promise.resolve();
  }
  waitForSelector(): Promise<void> {
    return Promise.resolve();
  }
  waitForFunction(): Promise<void> {
    if (this.holdWaitForFunction)
      return new Promise<void>(() => {
        // 永不落定：用于在“过程中”触发 abort。
      });
    return Promise.resolve();
  }
  click(selector: string): Promise<void> {
    this.clicks.push(selector);
    return Promise.resolve();
  }
  $(): Promise<FakeElement> {
    return Promise.resolve(new FakeElement('#mesh-viewport canvas'));
  }
}

class FakeBrowser {
  readonly page = new FakePage();
  closed = false;
  readonly pid = 4242;
  /** resolve 正常；reject 抛错；hang 永不落定（验证 close 上限与杀进程）。 */
  closeMode: 'resolve' | 'reject' | 'hang' = 'resolve';
  newPage(): Promise<Page> {
    return Promise.resolve(this.page as unknown as Page);
  }
  process(): { pid: number } {
    return { pid: this.pid };
  }
  close(): Promise<void> {
    this.closed = true;
    if (this.closeMode === 'reject') return Promise.reject(new Error('close failed'));
    if (this.closeMode === 'hang')
      return new Promise<void>(() => {
        // 永不落定：验证 close 上限与杀进程。
      });
    return Promise.resolve();
  }
}

function testModel(): ModelDocument {
  const model = createModel();
  model.box({ id: 'part-box', name: '盒', role: 'volume', color: '#8899aa', size: [2, 3, 4] });
  return model.finish();
}

interface Harness {
  readonly browser: FakeBrowser;
  readonly started: StartServerOptions[];
  readonly closed: boolean[];
  readonly launched: { executablePath?: string; pipe?: boolean; args?: readonly string[] }[];
}

function harness(): { deps: Parameters<typeof renderModelViews>[1]; state: Harness } {
  const browser = new FakeBrowser();
  const started: Harness['started'] = [];
  const closed: boolean[] = [];
  const launched: Harness['launched'] = [];
  const state: Harness = { browser, started, closed, launched };
  return {
    state,
    deps: {
      settleMs: 0,
      startServer: (options) => {
        state.started.push(options);
        return Promise.resolve({
          url: 'http://127.0.0.1:9',
          close: () => {
            closed.push(true);
            return Promise.resolve();
          },
        });
      },
      launch: (options) => {
        launched.push({
          ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
          ...(options.pipe === undefined ? {} : { pipe: options.pipe }),
          ...(options.args === undefined ? {} : { args: options.args }),
        });
        return Promise.resolve(browser as unknown as Browser);
      },
    },
  };
}

test('renderModelViews 依次截取 overall / top / side，注入模型并关闭服务与浏览器', async () => {
  const model = testModel();
  const { deps, state } = harness();
  const shots = await renderModelViews(model, deps);
  assert.deepEqual(
    shots.map((shot) => shot.name),
    ['overall', 'top', 'side'],
  );
  assert.deepEqual([...shots[0]!.png], [1, 2, 3]);
  assert.deepEqual(state.browser.page.clicks, ['#mesh-view-overall', '#mesh-view-top', '#mesh-view-side']);
  assert.equal(state.browser.page.gotoUrl, 'http://127.0.0.1:9/');
  assert.deepEqual(state.browser.page.viewports, [{ width: 1024, height: 768 }]);
  const firstStart = state.started[0];
  assert.ok(firstStart !== undefined);
  assert.equal(firstStart.port, 0);
  assert.deepEqual(
    firstStart.model?.parts.map((part) => part.id),
    ['part-box'],
  );
  const firstLaunch = state.launched[0];
  assert.ok(firstLaunch !== undefined);
  assert.equal(firstLaunch.executablePath, DEFAULT_CHROME_PATH);
  assert.equal(firstLaunch.pipe, true);
  assert.deepEqual(firstLaunch.args, [...MODEL_RENDER_FLAGS]);
  assert.equal(state.browser.closed, true);
  assert.deepEqual(state.closed, [true]);
});

test('renderModelViews 尊重 width / height / chromePath 选项', async () => {
  const { deps, state } = harness();
  await renderModelViews(testModel(), { ...deps, width: 320, height: 240, chromePath: '/opt/chrome' });
  assert.deepEqual(state.browser.page.viewports, [{ width: 320, height: 240 }]);
  assert.equal(state.launched[0]?.executablePath, '/opt/chrome');
});

test('renderModelViews 对非法 ModelDocument 直接拒绝，不启动服务与浏览器', async () => {
  const { deps, state } = harness();
  await assert.rejects(
    renderModelViews({ version: 3, parts: [] } as unknown as ModelDocument, deps),
    /ModelDocument 不合法/,
  );
  assert.equal(state.started.length, 0);
  assert.equal(state.launched.length, 0);
});

test('renderModelViews 在浏览器启动失败时仍关闭服务', async () => {
  const { deps, state } = harness();
  await assert.rejects(
    renderModelViews(testModel(), {
      ...deps,
      launch: () => Promise.reject(new Error('spawn failed')),
    }),
    /spawn failed/,
  );
  assert.equal(state.started.length, 1);
  assert.deepEqual(state.closed, [true]);
});

function isAbort(error: unknown): boolean {
  assert.equal(error instanceof Error ? error.name : '', 'AbortError');
  return true;
}

test('renderModelViews 调用前已中止：立即拒绝且不启动服务 / 浏览器', async () => {
  const { deps, state } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderModelViews(testModel(), { ...deps, signal: controller.signal }), isAbort);
  assert.equal(state.started.length, 0);
  assert.equal(state.launched.length, 0);
});

test('renderModelViews 过程中中止：拒绝 AbortError 并关闭浏览器与服务', async () => {
  const { deps, state } = harness();
  state.browser.page.holdWaitForFunction = true;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 5);
  try {
    await assert.rejects(renderModelViews(testModel(), { ...deps, signal: controller.signal }), isAbort);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(state.browser.closed, true, '中止后应关闭浏览器');
  assert.deepEqual(state.closed, [true], '中止后应关闭服务');
  assert.deepEqual(state.browser.page.clicks, [], '中止后不应继续截图');
});

test('renderModelViews 的 browser.close 拒绝：杀自有 pid 并抛清理错误，服务仍关闭', async () => {
  const { deps, state } = harness();
  state.browser.closeMode = 'reject';
  const killed: (number | undefined)[] = [];
  await assert.rejects(
    renderModelViews(testModel(), {
      ...deps,
      kill: (pid) => {
        killed.push(pid);
      },
    }),
    /关闭浏览器失败.*close failed/s,
  );
  assert.deepEqual(killed, [state.browser.pid], 'close 拒绝也要结束自有进程，不能静默');
  assert.deepEqual(state.closed, [true]);
});

test('renderModelViews 的 browser.close 成功：不调用 kill', async () => {
  const { deps } = harness();
  const killed: (number | undefined)[] = [];
  const shots = await renderModelViews(testModel(), {
    ...deps,
    kill: (pid) => {
      killed.push(pid);
    },
  });
  assert.equal(shots.length, 3);
  assert.deepEqual(killed, [], 'close 成功不应杀进程');
});

test('renderModelViews 的 browser.close 挂起：到上限后杀自有 pid 并抛清理错误', async () => {
  const { deps, state } = harness();
  state.browser.closeMode = 'hang';
  const killed: (number | undefined)[] = [];
  await assert.rejects(
    renderModelViews(testModel(), {
      ...deps,
      closeTimeoutMs: 10,
      kill: (pid) => {
        killed.push(pid);
      },
    }),
    /关闭浏览器失败.*超过 10ms/s,
  );
  assert.deepEqual(killed, [state.browser.pid]);
  assert.deepEqual(state.closed, [true]);
});

test('原中止优先：close 失败时保留 AbortError 并附清理原因', async () => {
  const { deps, state } = harness();
  state.browser.page.holdWaitForFunction = true;
  state.browser.closeMode = 'reject';
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 5);
  try {
    await assert.rejects(
      renderModelViews(testModel(), { ...deps, signal: controller.signal, closeTimeoutMs: 10 }),
      (error: unknown) => {
        assert.equal(error instanceof Error ? error.name : '', 'AbortError');
        assert.ok(error instanceof Error && error.message.includes('清理时另有错误：关闭浏览器失败'), '应附清理原因');
        return true;
      },
    );
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(state.closed, [true]);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('renderModelViews 在 launch 期间中止：晚到的浏览器仍被关闭，不泄漏', async () => {
  const { deps, state } = harness();
  const controller = new AbortController();
  let releaseLaunch: ((browser: Browser) => void) | undefined;
  const late = new Promise<Browser>((resolve) => {
    releaseLaunch = resolve;
  });
  const running = renderModelViews(testModel(), {
    ...deps,
    signal: controller.signal,
    launch: () => {
      // 模拟 launch 尚未返回时用户中止；句柄要到 releaseLaunch 之后才出现。
      controller.abort();
      return late;
    },
  });
  await delay(0);
  releaseLaunch?.(state.browser as unknown as Browser);
  await assert.rejects(running, isAbort);
  assert.equal(state.browser.closed, true, '晚到的浏览器必须关闭');
  assert.deepEqual(state.closed, [true]);
});

test('renderModelViews 在 startServer 期间中止：晚到的服务仍被关闭，不泄漏', async () => {
  const { deps, state } = harness();
  const controller = new AbortController();
  let releaseStart: ((server: RunningServer) => void) | undefined;
  const late = new Promise<RunningServer>((resolve) => {
    releaseStart = resolve;
  });
  const running = renderModelViews(testModel(), {
    ...deps,
    signal: controller.signal,
    startServer: () => {
      controller.abort();
      return late;
    },
  });
  await delay(0);
  releaseStart?.({
    url: 'http://127.0.0.1:9',
    close: () => {
      state.closed.push(true);
      return Promise.resolve();
    },
  });
  await assert.rejects(running, isAbort);
  assert.deepEqual(state.closed, [true]);
  assert.equal(state.launched.length, 0, '中止后不应再启动浏览器');
});

test('contactHtml 把三张 data URL 按 1×3 横排成固定 1536×384，并转义属性', () => {
  const html = contactHtml(['data:image/png;base64,AAA', 'data:image/png;base64,BBB"<>&', 'data:image/png;base64,CCC']);
  assert.equal(html.match(/<img /g)?.length, 3, '应恰好三张');
  assert.equal(html.match(/width="512" height="384"/g)?.length, 3, '每格 512×384');
  assert.ok(html.includes('data:image/png;base64,BBB&quot;&lt;&gt;&amp;'), '属性值应转义');
  assert.ok(!html.includes('BBB"<>&'), '原始未转义串不应出现');
  assert.ok(html.includes('display:flex'), '用 flex 排版避免基线空隙');
});

test('contactHtml 数量不是 3 时报错，不静默少图', () => {
  assert.throws(() => contactHtml([]), /需要 3 张图片，收到 0/);
  assert.throws(() => contactHtml(['a', 'b']), /需要 3 张图片，收到 2/);
});

test('renderModelContact 复用截图流程并在第二页合成 contact 图', async () => {
  const { deps, state } = harness();
  const shot = await renderModelContact(testModel(), deps);
  assert.equal(shot.name, 'contact');
  assert.deepEqual([...shot.png], [9, 8, 7]);
  assert.deepEqual(state.browser.page.clicks, ['#mesh-view-overall', '#mesh-view-top', '#mesh-view-side']);
  assert.deepEqual(state.browser.page.viewports, [
    { width: 1024, height: 768 },
    { width: CONTACT_WIDTH, height: CONTACT_HEIGHT },
  ]);
  const content = state.browser.page.contents[0];
  assert.ok(content !== undefined, 'contact 页应收到排版 HTML');
  assert.equal(content.match(/<img /g)?.length, 3);
  assert.equal(state.browser.closed, true);
  assert.deepEqual(state.closed, [true]);
});

test('renderModelContact 尊重 width / height 选项（模型页取景，不影响合成画幅）', async () => {
  const { deps, state } = harness();
  await renderModelContact(testModel(), { ...deps, width: 320, height: 240, chromePath: '/opt/chrome' });
  assert.deepEqual(state.browser.page.viewports, [
    { width: 320, height: 240 },
    { width: CONTACT_WIDTH, height: CONTACT_HEIGHT },
  ]);
  assert.equal(state.launched[0]?.executablePath, '/opt/chrome');
});

test('renderModelContact 对非法 ModelDocument 直接拒绝，不启动服务与浏览器', async () => {
  const { deps, state } = harness();
  await assert.rejects(
    renderModelContact({ version: 3, parts: [] } as unknown as ModelDocument, deps),
    /ModelDocument 不合法/,
  );
  assert.equal(state.started.length, 0);
  assert.equal(state.launched.length, 0);
});

test('renderModelContact 调用前已中止：立即拒绝且不启动服务 / 浏览器', async () => {
  const { deps, state } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderModelContact(testModel(), { ...deps, signal: controller.signal }), isAbort);
  assert.equal(state.started.length, 0);
  assert.equal(state.launched.length, 0);
});
