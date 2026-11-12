/**
 * model-render.ts 的真实 Chrome 集成测试：`renderModelViews` 端到端产出 overall / top / side 三张 PNG。
 *
 * 走真实 `startMassingServer({ model })` + 真实 puppeteer-core + /usr/bin/google-chrome，
 * 验证返回顺序、PNG 魔数、三视角两两不同，以及结束后没有自己启动的 Chrome 残留。
 * 单元编排（假服务 / 假浏览器）在 model-render.test.ts。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';

import { renderModelContact, renderModelViews } from './model-render.ts';

const CHROME = '/usr/bin/google-chrome';

function buildModel(): ModelDocument {
  const model = createModel();
  model.box({ id: 'part-base', name: '基座', role: 'volume', color: '#8899aa', size: [20, 10, 20] });
  model.revolve({
    id: 'part-roof',
    name: '旋转屋顶',
    role: 'roof',
    color: '#b07a4a',
    profile: (t: number) => [8 * (1 - t), 10 + 8 * t],
    profileSegments: 16,
    radialSegments: 24,
  });
  return model.finish();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 只看自己启动的 Chrome：临时用户数据目录带 `pg-model-render-<宿主 pid>-` 前缀。 */
function pgrepOwn(pid: number): string[] {
  const result = spawnSync('pgrep', ['-f', `pg-model-render-${String(pid)}-`], { encoding: 'utf8' });
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
}

const support = { ok: existsSync(CHROME) };

test(
  'renderModelViews：真实 Chrome 产出 overall / top / side PNG 且不残留进程',
  { timeout: 120_000, skip: support.ok ? false : `找不到 ${CHROME}` },
  async () => {
    // 页面三栏布局会占掉左右 264+336px；640×480 会把画布挤成 40px 宽，
    // 三张图都接近纯背景，无法可靠断言“有内容 / 两两不同”。用默认 1024×768 让画布足够大。
    const shots = await renderModelViews(buildModel(), {
      chromePath: CHROME,
      width: 1024,
      height: 768,
      settleMs: 300,
    });
    assert.deepEqual(
      shots.map((shot) => shot.name),
      ['overall', 'top', 'side'],
    );
    for (const shot of shots) {
      assert.ok(shot.png.length > 1000, `${shot.name} PNG 过小：${String(shot.png.length)} 字节`);
      // PNG 魔数 89 50 4E 47
      assert.equal(shot.png[0], 0x89, shot.name);
      assert.equal(shot.png[1], 0x50, shot.name);
      assert.equal(shot.png[2], 0x4e, shot.name);
      assert.equal(shot.png[3], 0x47, shot.name);
    }
    const [overall, top, side] = shots;
    assert.notDeepEqual([...overall!.png], [...top!.png], '整体与俯视截图应不同');
    assert.notDeepEqual([...overall!.png], [...side!.png], '整体与侧视截图应不同');
    assert.notDeepEqual([...top!.png], [...side!.png], '俯视与侧视截图应不同');

    await delay(400);
    assert.deepEqual(pgrepOwn(process.pid), [], '关闭后不应有自己启动的 Chrome 残留');
  },
);

function isAbort(error: unknown): boolean {
  assert.equal(error instanceof Error ? error.name : '', 'AbortError');
  return true;
}

test(
  'renderModelViews：调用前已中止立即拒绝且不启动 Chrome',
  { timeout: 30_000, skip: support.ok ? false : `找不到 ${CHROME}` },
  async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(renderModelViews(buildModel(), { chromePath: CHROME, signal: controller.signal }), isAbort);
    // 不启动 Chrome：没有进程、也没有用户数据目录残留。
    assert.deepEqual(pgrepOwn(process.pid), [], '已中止不应启动 Chrome');
  },
);

test(
  'renderModelViews：过程中中止会关闭真实 Chrome 且无残留',
  { timeout: 120_000, skip: support.ok ? false : `找不到 ${CHROME}` },
  async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 60);
    try {
      await assert.rejects(
        renderModelViews(buildModel(), {
          chromePath: CHROME,
          width: 640,
          height: 480,
          settleMs: 300,
          signal: controller.signal,
        }),
        isAbort,
      );
    } finally {
      clearTimeout(timer);
    }
    await delay(600);
    assert.deepEqual(pgrepOwn(process.pid), [], '中止后不应有自己启动的 Chrome 残留');
  },
);

/** 读 PNG 的 IHDR：签名 8 字节 + 块长 4 + 类型 4 后是宽 / 高各 4 字节（大端）。 */
function pngSize(png: Uint8Array): readonly [number, number] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

test(
  'renderModelContact：真实 Chrome 产出 1536×384 PNG 且不残留进程',
  { timeout: 120_000, skip: support.ok ? false : `找不到 ${CHROME}` },
  async () => {
    const shot = await renderModelContact(buildModel(), { chromePath: CHROME, settleMs: 300 });
    assert.equal(shot.name, 'contact');
    assert.ok(shot.png.length > 1000, `contact PNG 过小：${String(shot.png.length)} 字节`);
    // PNG 魔数
    assert.equal(shot.png[0], 0x89);
    assert.equal(shot.png[1], 0x50);
    assert.equal(shot.png[2], 0x4e);
    assert.equal(shot.png[3], 0x47);
    assert.deepEqual(pngSize(shot.png), [1536, 384], '合成图画幅应为 3×512×384');

    await delay(400);
    assert.deepEqual(pgrepOwn(process.pid), [], '关闭后不应有自己启动的 Chrome 残留');
  },
);

test(
  'renderModelContact：过程中中止会关闭真实 Chrome 且无残留',
  { timeout: 120_000, skip: support.ok ? false : `找不到 ${CHROME}` },
  async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 60);
    try {
      await assert.rejects(
        renderModelContact(buildModel(), { chromePath: CHROME, settleMs: 300, signal: controller.signal }),
        isAbort,
      );
    } finally {
      clearTimeout(timer);
    }
    await delay(600);
    assert.deepEqual(pgrepOwn(process.pid), [], '中止后不应有自己启动的 Chrome 残留');
  },
);
