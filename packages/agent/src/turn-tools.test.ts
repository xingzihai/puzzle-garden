/**
 * turn-tools 的单元测试：剧本测试（runner.test.ts）没走到的分支——未知工具、参数不合 schema、
 * 同轮多次看图、没有存档时看图、没有代码时检查、宿主缺陷停止、交付图失败。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { hashGrid } from '@pg/core/hash';
import { API_VERSION, createWorld, rect } from '@pg/geometry';
import type { ToolCall } from '@pg/llm/schema';
import type { RenderResult } from '@pg/render/render';
import { SandboxError } from '@pg/sandbox/precheck';
import type { RunResult } from '@pg/sandbox/run';
import { createRunDir, openRunDir } from '@pg/store/run-dir';
import type { RunWriter } from '@pg/store/run-dir';

import { deliver, initialToolState, runToolCalls, VIEW_SUPERSEDED } from './turn-tools.ts';
import type { ToolContext, ToolState } from './turn-tools.ts';

const registry = loadRegistry();
const ROOT = mkdtempSync(join(tmpdir(), 'pg-turn-tools-'));
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const BUILT = (() => {
  const host = createWorld(registry.table);
  host.world.plinth({ footprint: rect(-2, -2, 2, 2), height: 1, material: 'stone_bricks' });
  const { grid } = host.compose();
  return { grid, archive: writeArchive(grid, API_VERSION), hash: hashGrid(grid) };
})();

const okRun: RunResult = {
  kind: 'ok',
  grid: BUILT.grid,
  archive: BUILT.archive,
  hash: BUILT.hash,
  report: { status: 'ok', hash: BUILT.hash, calls: 1, overlaps: [], console: [], consoleTruncated: 0 },
  wallMs: 1,
};

const renderOk = (views: readonly string[]): RenderResult => ({
  kind: 'ok',
  images: views.map((view) => ({
    view: view as 'iso-se',
    png: Uint8Array.from([1, 2, 3]),
    sha256: 'c'.repeat(64),
    camera: {
      position: [0, 0, 0],
      target: [0, 0, 0],
      up: [0, 1, 0],
      left: -1,
      right: 1,
      top: 1,
      bottom: -1,
      near: 0,
      far: 1,
    },
    pixelsPerCell: 10,
    bbox: [0, 0, 1, 1],
    frameFill: 0.4,
  })),
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
    flags: ['x'],
    webglRenderer: 'w',
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
  wallMs: 2,
});

const counter = { n: 0 };
function context(overrides: Partial<Pick<ToolContext, 'render' | 'check' | 'requireDesign' | 'deliveryNote'>> = {}): {
  ctx: ToolContext;
  store: RunWriter;
} {
  counter.n += 1;
  const store = createRunDir(ROOT, `t${String(counter.n)}`);
  return {
    store,
    ctx: {
      store,
      turn: 1,
      seed: 0,
      check: overrides.check ?? {
        prechecker: { check: () => Promise.resolve({ kind: 'ok' }) },
        runCode: () => Promise.resolve(okRun),
        registry,
        clock: () => 0,
      },
      render: overrides.render ?? ((_a, req) => Promise.resolve(renderOk(req.views))),
      clock: () => 0,
      cache: {
        get: () => undefined,
        set: () => {
          // 测试不复用缓存
        },
      },
      requireDesign: overrides.requireDesign ?? false,
      budget: {
        imageBytes: 0,
        images: 0,
        inWindow: false,
        remainingCny: () => Number.POSITIVE_INFINITY,
        reserveSubrun: () => true,
        settleSubrun: () => undefined,
      },
      ...(overrides.deliveryNote === undefined ? {} : { deliveryNote: overrides.deliveryNote }),
    },
  };
}

const call = (name: string, args: unknown, i = 0): ToolCall => ({
  id: `call_${String(i)}`,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

function texts(out: Awaited<ReturnType<typeof runToolCalls>>): string[] {
  return out.toolMessages.map((m) => m.content);
}

describe('initialToolState', () => {
  it('无种子稿：版本 0、空代码', () => {
    const state = initialToolState();
    assert.deepEqual(state.draft, { code: '', version: 0 });
    assert.equal(state.lastCheck, null);
    assert.equal(state.lastOk, null);
  });

  it('空串种子稿等同无种子稿', () => {
    assert.deepEqual(initialToolState('').draft, { code: '', version: 0 });
  });

  it('给种子稿：版本 1、代码即该内容（分段实验第 2 段）', () => {
    const state = initialToolState('export default function build(w: World): void {}\n');
    assert.equal(state.draft.version, 1);
    assert.equal(state.draft.code, 'export default function build(w: World): void {}\n');
  });
});

describe('runToolCalls 参数与分发', () => {
  it('未知工具、参数不合 schema、非 JSON 都不执行；tool.call 记 parse', async () => {
    const { ctx, store } = context();
    const state = initialToolState();
    const out = await runToolCalls(
      [call('make_coffee', {}, 0), call('write_code', { code: 1 }, 1), call('read_code', '{oops', 2)],
      new Set(),
      state,
      ctx,
    );
    store.close();
    const [unknown, invalid, broken] = texts(out);
    assert.match(unknown ?? '', /没有名为 make_coffee 的工具/);
    assert.match(invalid ?? '', /^参数不合法，没有执行：code：/);
    assert.match(broken ?? '', /参数不是合法 JSON/);
    const parses = openRunDir(store.dir)
      .events()
      .flatMap((e) => (e.type === 'tool.call' ? [e.body.parse] : []));
    assert.deepEqual(parses, ['invalid-args', 'invalid-args', 'invalid-json']);
    assert.equal(state.draft.version, 0);
  });

  it('reference 分发 api / block；未知 scope 在 schema 层拒绝', async () => {
    const { ctx, store } = context();
    const out = await runToolCalls(
      [
        call('reference', { scope: 'api', query: 'walls' }, 0),
        call('reference', { scope: 'block', query: '楼梯' }, 1),
        call('reference', { scope: 'example', query: 'walls' }, 2),
      ],
      new Set(),
      initialToolState(),
      ctx,
    );
    store.close();
    const [api, block, invalid] = texts(out);
    assert.match(api ?? '', /API · walls/);
    assert.match(api ?? '', /wallsOptions/);
    assert.match(block ?? '', /Block · 楼梯/);
    assert.match(block ?? '', /oak_stairs/);
    assert.match(invalid ?? '', /^参数不合法，没有执行：scope：/);
  });

  it('没有代码时 check_code、没有存档时 view_building 都给出提示', async () => {
    const { ctx, store } = context();
    const out = await runToolCalls(
      [call('check_code', {}), call('view_building', {}, 1)],
      new Set(),
      initialToolState(),
      ctx,
    );
    store.close();
    assert.deepEqual(texts(out), ['当前稿还没有代码，先 write_code。', '还没有执行成功的版本，先 check_code。']);
  });

  it('配了 gates：成功 check 后 lastCheck 带上门槛判定', async () => {
    const { ctx, store } = context({
      check: {
        prechecker: { check: () => Promise.resolve({ kind: 'ok' }) },
        runCode: () => Promise.resolve(okRun),
        registry,
        gates: { forbidApis: ['plinth'] },
        clock: () => 0,
      },
    });
    const state = initialToolState();
    await runToolCalls([call('write_code', { code: 'x' }), call('check_code', {}, 1)], new Set(), state, ctx);
    store.close();
    assert.ok(state.lastCheck !== null);
    assert.ok(state.lastCheck.gates !== undefined);
    assert.equal(state.lastCheck.gates.passed, false);
    assert.match(state.lastCheck.gates.failed[0] ?? '', /^只用构件：plinth /);
  });

  it('同一轮多次看图只渲染最后一次；图片块与累计字节入状态；versions.render 只写一次', async () => {
    const { ctx, store } = context();
    const state: ToolState = initialToolState();
    await runToolCalls([call('write_code', { code: 'x' }), call('check_code', {}, 1)], new Set(), state, ctx);
    const out = await runToolCalls(
      [call('view_building', {}, 0), call('view_building', { views: ['top'] }, 1)],
      new Set(),
      state,
      ctx,
    );
    await runToolCalls([call('view_building', { views: ['south'] }, 0)], new Set(), state, ctx);
    store.close();
    assert.equal(texts(out)[0], VIEW_SUPERSEDED);
    assert.match(texts(out)[1] ?? '', /已渲染第 v1 版 1 张/);
    assert.equal(out.images.filter((p) => p.type === 'image_url').length, 1);
    assert.equal(state.images, 2);
    assert.ok(state.imageBytes > 0);
    assert.equal(state.lastViewVersion, 1);
    const kinds = openRunDir(store.dir)
      .events()
      .map((e) => e.type);
    assert.equal(kinds.filter((k) => k === 'versions.render').length, 1);
  });

  it('提交窗口内 write_code / view_building / massing 被拒；read_massing 不受限', async () => {
    const { ctx, store } = context();
    // 已有草稿（v1）时才拦整份写入；v0 的窗口例外见下一条回归。
    const state = { ...initialToolState('const x = 1;\n'), inWindow: true };
    const out = await runToolCalls(
      [
        call('write_code', { code: 'x' }),
        call('view_building', {}, 1),
        call('massing', { brief: '窗口内' }, 2),
        call('read_massing', { id: 'massing#1' }, 3),
      ],
      new Set(),
      state,
      ctx,
    );
    store.close();
    assert.deepEqual(texts(out), [
      '提交窗口内不可用',
      '提交窗口内不可用',
      '提交窗口内不可用',
      '没有草模引用 massing#1（本 run 还没有成功的草模子运行）；先调用 massing。',
    ]);
  });

  it('窗口先于首稿进入：预稿序列全程不被 window-blocked（fc7468 回归）', async () => {
    const { ctx, store } = context();
    const state = { ...initialToolState(), inWindow: true };
    assert.equal(state.draft.version, 0);
    await runToolCalls(
      [
        call('read_design', {}, 0),
        call('plan', { action: 'read' }, 1),
        call('write_design', { content: '# 设计\n- 窗内先建立初稿' }, 2),
        call('write_code', { code: 'const N = 0;\n' }, 3),
      ],
      new Set(),
      state,
      ctx,
    );
    // 窗口内 v0 仍可整份写入，且立即得到 v1；否则后续 edit/check/submit 全被卡死。
    assert.equal(state.draft.version, 1);
    assert.equal(state.draft.code, 'const N = 0;\n');
    const out = await runToolCalls(
      [
        call('check_code', {}, 4),
        call('edit_code', { edits: [{ find: 'const N = 0;', replace: 'const N = 1;' }] }, 5),
        call('submit', { note: '' }, 6),
      ],
      new Set(),
      state,
      ctx,
    );
    store.close();
    assert.equal(state.draft.version, 2);
    assert.equal(state.draft.code, 'const N = 1;\n');
    assert.ok(out.submitted !== null);

    const events = openRunDir(store.dir).events();
    const results = events.flatMap((e) => (e.type === 'tool.result' ? [e.body] : []));
    assert.deepEqual(
      results.map((r) => `${r.name}:${r.status}`),
      [
        'read_design:ok',
        'plan:ok',
        'write_design:ok',
        'write_code:ok',
        'check_code:ok',
        'edit_code:ok',
        'submit:accepted',
      ],
    );
    assert.ok(results.every((r) => r.status !== 'window-blocked'));
    const versions = events.flatMap((e) =>
      e.type === 'code.version' ? [{ version: e.body.version, via: e.body.via }] : [],
    );
    assert.deepEqual(versions, [
      { version: 1, via: 'write_code' },
      { version: 2, via: 'edit_code' },
    ]);
  });

  it('没有代码时 submit 被拒、不写 submit 事件', async () => {
    const { ctx, store } = context();
    const out = await runToolCalls([call('submit', { note: '' })], new Set(), initialToolState(), ctx);
    store.close();
    assert.equal(out.submitted, null);
    assert.match(texts(out)[0] ?? '', /还没有代码/);
    assert.ok(
      !openRunDir(store.dir)
        .events()
        .some((e) => e.type === 'submit'),
    );
  });
});

describe('runToolCalls plan + edit auto-check', () => {
  it('plan update/read 同轮分发，edit_code 成功后自动 check 并更新 lastCheck', async () => {
    const { ctx, store } = context();
    const state = initialToolState('const value = 1;\n');
    const out = await runToolCalls(
      [
        call(
          'plan',
          {
            action: 'update',
            phase: 'roof',
            items: [
              { id: 'must-roof', status: 'doing' },
              { id: 'must-slab', status: 'verified', evidence: 'slab bounds' },
            ],
          },
          0,
        ),
        call('plan', { action: 'read' }, 1),
        call('edit_code', { edits: [{ find: '1', replace: '2' }] }, 2),
      ],
      new Set(),
      state,
      ctx,
    );
    store.close();
    assert.equal(state.plan.phase, 'roof');
    assert.equal(state.plan.items.length, 2);
    assert.match(texts(out)[0] ?? '', /已更新计划/);
    assert.match(texts(out)[1] ?? '', /阶段 roof/);
    assert.match(texts(out)[2] ?? '', /自动检查（edit_code 后）/);
    assert.equal(state.lastCheck?.outcome, 'ok');
    assert.equal(state.lastCheck.version, state.draft.version);
    const checks = openRunDir(store.dir)
      .events()
      .filter((event) => event.type === 'check.result');
    assert.equal(checks.length, 1);
    // plan 只是记录，不改变 submit 条件。
    assert.equal('conflicts' in state.plan, true);
  });
});

describe('runToolCalls 宿主缺陷', () => {
  it('沙箱内部错误 → stop internal-error，同轮其后调用不执行', async () => {
    const { ctx, store } = context({
      check: {
        prechecker: { check: () => Promise.resolve({ kind: 'ok' }) },
        runCode: () => Promise.reject(new SandboxError('protocol-error', '帧坏了')),
        registry,
        clock: () => 0,
      },
    });
    const out = await runToolCalls(
      [call('write_code', { code: 'x' }), call('check_code', {}, 1), call('read_code', {}, 2)],
      new Set(),
      initialToolState(),
      ctx,
    );
    store.close();
    assert.equal(out.stop, 'internal-error');
    assert.equal(out.toolMessages.length, 2);
  });

  it('没有 bwrap → stop sandbox-unsupported', async () => {
    const { ctx, store } = context({
      check: {
        prechecker: { check: () => Promise.resolve({ kind: 'ok' }) },
        runCode: () => Promise.resolve({ kind: 'unsupported', reason: '没有 bwrap' }),
        registry,
        clock: () => 0,
      },
    });
    const state = initialToolState();
    const out = await runToolCalls(
      [call('write_code', { code: 'x' }), call('check_code', {}, 1)],
      new Set(),
      state,
      ctx,
    );
    store.close();
    assert.equal(out.stop, 'sandbox-unsupported');
    assert.equal(state.lastCheck, null);
  });

  it('渲染页面出错 → stop internal-error', async () => {
    const { ctx, store } = context({
      render: () => Promise.resolve({ kind: 'page-error', detail: 'boom', wallMs: 1 }),
    });
    const state = initialToolState();
    await runToolCalls([call('write_code', { code: 'x' }), call('check_code', {}, 1)], new Set(), state, ctx);
    const out = await runToolCalls([call('view_building', {})], new Set(), state, ctx);
    store.close();
    assert.equal(out.stop, 'internal-error');
  });
});

describe('write_design / read_design（AGENT-SPEC §4.5）', () => {
  it('write_design 写入与整体替换，返回字符数', async () => {
    const { ctx, store } = context();
    const state = initialToolState();
    const first = await runToolCalls([call('write_design', { content: '目标' }, 0)], new Set(), state, ctx);
    assert.deepEqual(texts(first), ['已写入设计文档，2 字符。']);
    assert.equal(state.design, '目标');
    const second = await runToolCalls([call('write_design', { content: '替换后的文档' }, 0)], new Set(), state, ctx);
    assert.deepEqual(texts(second), ['已写入设计文档，6 字符。']);
    assert.equal(state.design, '替换后的文档');
    // 空内容不合 schema，不执行
    const bad = await runToolCalls([call('write_design', { content: '' }, 0)], new Set(), state, ctx);
    assert.match(texts(bad)[0] ?? '', /^参数不合法/);
    assert.equal(state.design, '替换后的文档');
    store.close();
  });

  it('read_design：空给提示；有则原样返回', async () => {
    const { ctx, store } = context();
    const state = initialToolState();
    const empty = await runToolCalls([call('read_design', {}, 0)], new Set(), state, ctx);
    assert.deepEqual(texts(empty), ['还没有设计文档；先 write_design。']);
    await runToolCalls([call('write_design', { content: '# 设计\n- 任务目标' }, 0)], new Set(), state, ctx);
    const read = await runToolCalls([call('read_design', {}, 0)], new Set(), state, ctx);
    assert.deepEqual(texts(read), ['# 设计\n- 任务目标']);
    store.close();
  });

  it('read_design：有已确认设计源时标注只读来源；write_design 只改自写注记', async () => {
    const { ctx, store } = context();
    const state = initialToolState(undefined, {
      content: '# 设计摘要\n- 概念：茶亭',
      kind: 'digest',
      confirmed: true,
    });
    const readSource = await runToolCalls([call('read_design', {}, 0)], new Set(), state, ctx);
    const sourceText = texts(readSource)[0] ?? '';
    assert.match(sourceText, /【已确认设计源（只读；确定性摘要，完整 design\.md 未随 run 传入）】/);
    assert.match(sourceText, /完整 design 未随 run 传入/);
    assert.match(sourceText, /本 run 尚未写设计注记/);
    await runToolCalls([call('write_design', { content: '# 施工注记' }, 0)], new Set(), state, ctx);
    assert.equal(state.sourceDesign?.content, '# 设计摘要\n- 概念：茶亭', 'write_design 不得覆盖设计源');
    assert.equal(state.design, '# 施工注记');
    const readBoth = await runToolCalls([call('read_design', {}, 0)], new Set(), state, ctx);
    const bothText = texts(readBoth)[0] ?? '';
    assert.ok(bothText.includes('# 设计摘要\n- 概念：茶亭'));
    assert.ok(bothText.includes('# 施工注记'));
    assert.ok(bothText.indexOf('【已确认设计源') < bothText.indexOf('【本 run 的 write_design 注记'));
    store.close();
  });

  it('requireDesign：没写文档时 submit 被拒；write_design 后再 submit 通过', async () => {
    const { ctx, store } = context({ requireDesign: true });
    const state = initialToolState();
    await runToolCalls([call('write_code', { code: 'x' }, 0), call('check_code', {}, 1)], new Set(), state, ctx);
    const rejected = await runToolCalls([call('submit', { note: 'n' }, 0)], new Set(), state, ctx);
    assert.equal(rejected.submitted, null);
    assert.deepEqual(texts(rejected), ['还没有设计文档，先 write_design 再 submit。']);
    await runToolCalls([call('write_design', { content: '设计' }, 0)], new Set(), state, ctx);
    const accepted = await runToolCalls([call('submit', { note: 'n' }, 0)], new Set(), state, ctx);
    assert.ok(accepted.submitted !== null);
    assert.equal(texts(accepted)[0], '已提交第 v1 版。');
    store.close();
  });
});

describe('deliver', () => {
  it('交付图失败不阻止交付，写 renderMissing', async () => {
    const { ctx, store } = context({ render: () => Promise.resolve({ kind: 'timeout', detail: 'slow', wallMs: 9 }) });
    const state = initialToolState();
    const out = await runToolCalls(
      [call('write_code', { code: 'x' }), call('check_code', {}, 1), call('submit', { note: '好' }, 2)],
      new Set(),
      state,
      ctx,
    );
    assert.ok(out.submitted !== null);
    const result = await deliver(out.submitted, state, ctx);
    store.close();
    assert.deepEqual(result, { codeVersion: 1, hash: BUILT.hash });
    const delivery = openRunDir(store.dir)
      .events()
      .find((e) => e.type === 'delivery');
    assert.ok(delivery?.type === 'delivery');
    assert.equal(delivery.body.renderMissing, '交付渲染失败：timeout');
    assert.deepEqual(delivery.body.renders, []);
    const json = JSON.parse(readFileSync(join(store.dir, 'delivery', 'delivery.json'), 'utf8')) as { hash: string };
    assert.equal(json.hash, BUILT.hash);
  });

  it('交付带设计文档与 note：写 delivery/design.md、note.md，delivery.json 与事件带字段', async () => {
    const { ctx, store } = context();
    const state = initialToolState();
    const out = await runToolCalls(
      [
        call('write_design', { content: '# 设计文档' }, 0),
        call('write_code', { code: 'x' }, 1),
        call('check_code', {}, 2),
        call('submit', { note: '交付说明' }, 3),
      ],
      new Set(),
      state,
      ctx,
    );
    assert.ok(out.submitted !== null);
    await deliver(out.submitted, state, ctx);
    store.close();
    assert.equal(readFileSync(join(store.dir, 'delivery', 'design.md'), 'utf8'), '# 设计文档');
    assert.equal(readFileSync(join(store.dir, 'delivery', 'note.md'), 'utf8'), '交付说明');
    const delivery = openRunDir(store.dir)
      .events()
      .find((e) => e.type === 'delivery');
    assert.ok(delivery?.type === 'delivery');
    assert.ok(delivery.body.design !== undefined);
    assert.equal(delivery.body.note, '交付说明');
    const json = JSON.parse(readFileSync(join(store.dir, 'delivery', 'delivery.json'), 'utf8')) as {
      design?: unknown;
      note?: string;
    };
    assert.ok(json.design !== undefined);
    assert.equal(json.note, '交付说明');
  });

  it('宿主提供 conformance 注记时覆盖自述，自述另存 designer-note.md，不进入 note', async () => {
    const { ctx, store } = context({
      deliveryNote: () => '# 证据注记\n- blockingCount=1\n- acceptEligible=false\n',
    });
    const state = initialToolState();
    const out = await runToolCalls(
      [
        call('write_code', { code: 'x' }, 0),
        call('check_code', {}, 1),
        call('submit', { note: 'check_code 一致性 5/5 PASS，blocking 0' }, 2),
      ],
      new Set(),
      state,
      ctx,
    );
    assert.ok(out.submitted !== null);
    await deliver(out.submitted, state, ctx);
    store.close();
    assert.equal(
      readFileSync(join(store.dir, 'delivery', 'note.md'), 'utf8'),
      '# 证据注记\n- blockingCount=1\n- acceptEligible=false\n',
    );
    assert.equal(
      readFileSync(join(store.dir, 'delivery', 'designer-note.md'), 'utf8'),
      'check_code 一致性 5/5 PASS，blocking 0',
    );
    const json = JSON.parse(readFileSync(join(store.dir, 'delivery', 'delivery.json'), 'utf8')) as {
      note?: string;
      selfNote?: string;
      noteSource?: string;
    };
    assert.match(json.note ?? '', /blockingCount=1/);
    assert.doesNotMatch(json.note ?? '', /5\/5 PASS|blocking 0/);
    assert.equal(json.selfNote, undefined);
    assert.equal(json.noteSource, 'conformance-evidence');
    const delivery = openRunDir(store.dir)
      .events()
      .find((e) => e.type === 'delivery');
    assert.ok(delivery?.type === 'delivery');
    assert.equal(delivery.body.noteSource, 'conformance-evidence');
    assert.doesNotMatch(delivery.body.note ?? '', /5\/5 PASS|blocking 0/);
  });

  it('生成的证据注记超过 2000 字符仍能写入 delivery 事件', async () => {
    const longNote = `${'x'.repeat(5000)}\n`;
    const { ctx, store } = context({ deliveryNote: () => longNote });
    const state = initialToolState();
    const out = await runToolCalls(
      [call('write_code', { code: 'x' }, 0), call('check_code', {}, 1), call('submit', { note: '自述' }, 2)],
      new Set(),
      state,
      ctx,
    );
    assert.ok(out.submitted !== null);
    await deliver(out.submitted, state, ctx);
    store.close();
    assert.equal(readFileSync(join(store.dir, 'delivery', 'note.md'), 'utf8').length, 5001);
    const delivery = openRunDir(store.dir)
      .events()
      .find((e) => e.type === 'delivery');
    assert.ok(delivery?.type === 'delivery');
    assert.equal(delivery.body.note, longNote);
  });

  it('生成器返回 null 时写不可用说明，绝不回退到自述', async () => {
    const { ctx, store } = context({ deliveryNote: () => null });
    const state = initialToolState();
    const out = await runToolCalls(
      [
        call('write_code', { code: 'x' }, 0),
        call('check_code', {}, 1),
        call('submit', { note: 'check_code 一致性 5/5 PASS，blocking 0' }, 2),
      ],
      new Set(),
      state,
      ctx,
    );
    assert.ok(out.submitted !== null);
    await deliver(out.submitted, state, ctx);
    store.close();
    const note = readFileSync(join(store.dir, 'delivery', 'note.md'), 'utf8');
    assert.match(note, /证据不可用/);
    assert.doesNotMatch(note, /5\/5 PASS|blocking 0/);
    assert.equal(
      readFileSync(join(store.dir, 'delivery', 'designer-note.md'), 'utf8'),
      'check_code 一致性 5/5 PASS，blocking 0',
    );
    const json = JSON.parse(readFileSync(join(store.dir, 'delivery', 'delivery.json'), 'utf8')) as {
      note?: string;
      noteSource?: string;
    };
    assert.doesNotMatch(json.note ?? '', /5\/5 PASS|blocking 0/);
    assert.equal(json.noteSource, undefined);
  });

  it('没有设计文档与 note 时不写这两个文件与字段', async () => {
    const { ctx, store } = context();
    const state = initialToolState();
    const out = await runToolCalls(
      [call('write_code', { code: 'x' }, 0), call('check_code', {}, 1), call('submit', { note: '' }, 2)],
      new Set(),
      state,
      ctx,
    );
    assert.ok(out.submitted !== null);
    await deliver(out.submitted, state, ctx);
    store.close();
    assert.ok(!existsSync(join(store.dir, 'delivery', 'design.md')));
    assert.ok(!existsSync(join(store.dir, 'delivery', 'note.md')));
    const delivery = openRunDir(store.dir)
      .events()
      .find((e) => e.type === 'delivery');
    assert.ok(delivery?.type === 'delivery');
    assert.equal(delivery.body.design, undefined);
    assert.equal(delivery.body.note, undefined);
  });
});
