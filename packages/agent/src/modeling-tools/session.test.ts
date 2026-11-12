/** 草模工具会话：执行失败→局部修改→成功→提交、过期提交、无效参数、窗口、无渲染器与异常停止。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';

import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';
import type { ModelExecution } from '@pg/sandbox/modeling';
import type { Event } from '@pg/store/events';
import { createRunDir, openRunDir } from '@pg/store/run-dir';
import type { RunWriter } from '@pg/store/run-dir';
import type { ToolCall } from '@pg/llm/schema';

import { IMAGE_BYTES_SOFT } from '../guards/image.ts';
import { deliverModel } from './deliver.ts';
import { initialModelState, runModelToolCalls } from './session.ts';
import type { ModelExecute, ModelRender, ModelRenderImage, ModelToolContext, RenderedModelView } from './session.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeStore(): RunWriter {
  const root = mkdtempSync(join(tmpdir(), 'pg-model-session-'));
  roots.push(root);
  return createRunDir(root, 'run');
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeDocument(): ModelDocument {
  const model = createModel();
  model.box({ id: 'b', name: '块', role: 'volume', color: '#112233', size: [2, 3, 4] });
  return model.finish();
}

function docHash(document: ModelDocument): string {
  return sha(JSON.stringify(document));
}

function okExecution(
  code: string,
  document: ModelDocument = makeDocument(),
  console: readonly { readonly level: 'log' | 'warn' | 'error'; readonly text: string }[] = [],
  consoleTruncated = 0,
): ModelExecution {
  return { kind: 'ok', document, codeHash: sha(code), documentHash: docHash(document), console, consoleTruncated };
}

function buildError(
  console: readonly { readonly level: 'log' | 'warn' | 'error'; readonly text: string }[] = [],
): ModelExecution {
  return {
    kind: 'build-error',
    message: 'x 未定义',
    name: 'ReferenceError',
    line: 1,
    column: 1,
    console,
    consoleTruncated: 0,
  };
}

function call(name: string, args: unknown, id?: string): ToolCall {
  return { id: id ?? name, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function eventsOf<T extends Event['type']>(events: readonly Event[], type: T): Extract<Event, { type: T }>[] {
  return events.filter((e): e is Extract<Event, { type: T }> => e.type === type);
}

interface Harness {
  readonly store: RunWriter;
  readonly state: ReturnType<typeof initialModelState>;
  readonly budget: { imageBytes: number; images: number; inWindow: boolean };
  readonly cache: Map<string, readonly RenderedModelView[]>;
  readonly ctx: ModelToolContext;
}

function harness(
  options: {
    readonly code?: string;
    readonly execute?: ModelExecute;
    readonly render?: ModelRender;
    readonly signal?: AbortSignal;
  } = {},
): Harness {
  const store = makeStore();
  const state = initialModelState(options.code);
  const budget = { imageBytes: 0, images: 0, inWindow: false };
  const cache = new Map<string, readonly RenderedModelView[]>();
  const base: ModelToolContext = {
    store,
    turn: 1,
    seed: 5,
    clock: () => 0,
    budget,
    execute: options.execute ?? ((code) => Promise.resolve(okExecution(code))),
    cache,
    ...(options.render === undefined ? {} : { render: options.render }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return { store, state, budget, cache, ctx: base };
}

it('执行失败 → 局部修改 → 成功 → 提交，交付写全文件', async () => {
  const h = harness({
    execute: (code) => Promise.resolve(code.includes('BAD') ? buildError() : okExecution(code)),
    render: () => Promise.resolve<readonly ModelRenderImage[]>([{ name: 'iso', png: Uint8Array.from([1, 2, 3]) }]),
  });

  const first = await runModelToolCalls(
    [call('write_code', { code: 'const BAD = 1;' }), call('run_model', {})],
    new Set(),
    h.state,
    h.ctx,
  );
  assert.equal(first.stop, null);
  const checks1 = eventsOf(openRunDir(h.store.dir).events(), 'model.check');
  assert.equal(checks1.at(-1)?.body.status, 'build-error');
  assert.match(first.toolMessages.at(-1)?.content ?? '', /执行出错/);

  const second = await runModelToolCalls(
    [
      call('edit_code', { edits: [{ find: 'BAD', replace: 'ok' }] }),
      call('run_model', {}),
      call('view_model', {}),
      call('submit_model', { note: '完成' }),
    ],
    new Set(),
    h.state,
    h.ctx,
  );
  assert.equal(second.submitted, true);
  assert.equal(second.stop, null);
  assert.equal(h.state.lastViewVersion, 2);

  const delivered = await deliverModel(h.state, {
    store: h.store,
    turn: 1,
    seed: 5,
    versions: { modelingApi: 2, modelFormat: 2 },
  });
  assert.equal(delivered.codeVersion, 2);
  assert.equal(delivered.hash, h.state.lastOk?.documentHash);
  const dir = join(h.store.dir, 'delivery');
  for (const name of ['source.ts', 'model.json', 'manifest.json', 'note.md']) {
    assert.equal(existsSync(join(dir, name)), true, `${name} 应存在`);
  }
  assert.match(readFileSync(join(dir, 'source.ts'), 'utf8'), /const ok = 1/);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    readonly status: string;
    readonly documentHash: string;
    readonly seed: number;
    readonly modelingApi: number;
  };
  assert.equal(manifest.status, 'ok');
  assert.equal(manifest.documentHash, delivered.hash);
  assert.equal(manifest.seed, 5);
  assert.equal(manifest.modelingApi, 2);

  const events = openRunDir(h.store.dir).events();
  assert.equal(eventsOf(events, 'model.delivery').length, 1);
  assert.equal(eventsOf(events, 'submit').at(-1)?.body.accepted, true);
  assert.equal(eventsOf(events, 'code.version').length, 2);
});

it('提交后同轮其余调用回“已提交，未执行”，快照不被后续改动影响', async () => {
  const h = harness({
    code: 'const a = 1;',
    render: () => Promise.resolve<readonly ModelRenderImage[]>([{ name: 'iso', png: Uint8Array.from([1]) }]),
  });
  const turn = await runModelToolCalls(
    [
      call('run_model', {}),
      call('view_model', {}),
      call('submit_model', { note: 'n' }),
      call('edit_code', { edits: [{ find: 'a', replace: 'b' }] }),
    ],
    new Set(),
    h.state,
    h.ctx,
  );
  const statuses = eventsOf(openRunDir(h.store.dir).events(), 'tool.result').map((e) => e.body.status);
  assert.deepEqual(statuses, ['ok', 'ok', 'accepted', 'skipped-submitted']);
  assert.equal(turn.submitted, true);
  // 快照固定：交付的代码与提交时一致，未受后面 edit 影响。
  const delivered = await deliverModel(h.state, {
    store: h.store,
    turn: 1,
    seed: 5,
    versions: { modelingApi: 2, modelFormat: 2 },
  });
  assert.equal(delivered.codeVersion, 1);
  assert.match(readFileSync(join(h.store.dir, 'delivery', 'source.ts'), 'utf8'), /const a = 1/);
});

it('改动后旧成功结果过期，提交被拒', async () => {
  const h = harness({ code: 'const a = 1;' });
  const checked = await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  assert.equal(checked.stop, null);
  const edited = await runModelToolCalls(
    [call('edit_code', { edits: [{ find: 'a', replace: 'b' }] })],
    new Set(),
    h.state,
    h.ctx,
  );
  assert.equal(edited.stop, null);
  const submitted = await runModelToolCalls([call('submit_model', { note: 'n' })], new Set(), h.state, h.ctx);
  assert.equal(submitted.submitted, false);
  assert.match(submitted.toolMessages[0]?.content ?? '', /还没 run_model/);
  const submitEvents = eventsOf(openRunDir(h.store.dir).events(), 'submit');
  assert.equal(submitEvents.at(-1)?.body.accepted, false);
});

it('成功快照的文档 hash 被实际校验：不一致时 internal-error 停止', async () => {
  const h = harness({ code: 'const a = 1;' });
  await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  // 人为破坏快照 hash，模拟宿主缺陷。
  if (h.state.lastOk !== null) {
    h.state.lastOk = { ...h.state.lastOk, documentHash: 'f'.repeat(64) };
  }
  const turn = await runModelToolCalls([call('submit_model', { note: 'n' })], new Set(), h.state, h.ctx);
  assert.equal(turn.stop, 'internal-error');
  assert.equal(turn.submitted, false);
});

it('无效 JSON、未知工具、参数不合法都有可读结果，不执行', async () => {
  const h = harness({ code: 'const a = 1;' });
  const invalidJson: ToolCall = { id: 'c0', type: 'function', function: { name: 'write_code', arguments: '{oops' } };
  await runModelToolCalls(
    [invalidJson, call('not_a_tool', {}), call('read_code', { from: 0 })],
    new Set([0]),
    h.state,
    h.ctx,
  );
  assert.deepEqual(
    eventsOf(openRunDir(h.store.dir).events(), 'tool.result').map((e) => e.body.status),
    ['invalid-json', 'unknown-tool', 'invalid-args'],
  );
  assert.equal(h.state.draft.version, 1);
});

it('提交窗口内 v0 可 write_code 建立初稿，有稿后 write_code 被拦、edit_code 仍生效', async () => {
  const h = harness();
  h.budget.inWindow = true;
  assert.equal(h.state.draft.version, 0);

  const first = await runModelToolCalls([call('write_code', { code: 'const a = 1;' })], new Set(), h.state, h.ctx);
  assert.equal(first.stop, null);
  assert.equal(h.state.draft.version, 1, '窗口内 v0 的 write_code 应建立初稿');
  const firstStatus = eventsOf(openRunDir(h.store.dir).events(), 'tool.result').at(-1)?.body.status;
  assert.equal(firstStatus, 'ok');
  assert.notEqual(firstStatus, 'window-blocked');

  const second = await runModelToolCalls(
    [call('write_code', { code: 'const x = 2;' }), call('edit_code', { edits: [{ find: 'a', replace: 'b' }] })],
    new Set(),
    h.state,
    h.ctx,
  );
  assert.equal(second.stop, null);
  assert.equal(h.state.draft.version, 2, 'edit_code 应在 write_code 被拦后继续推进版本');
  assert.equal(h.state.draft.code, 'const b = 1;', '第二次整份写入不应生效');
  assert.deepEqual(
    eventsOf(openRunDir(h.store.dir).events(), 'tool.result').map((e) => e.body.status),
    ['ok', 'window-blocked', 'ok'],
  );
  assert.match(second.toolMessages[0]?.content ?? '', /不能再 write_code 整份写入/);
});

it('提交窗口内只禁 write_code，读 / 编辑 / 执行 / 看图 / 提交仍可用', async () => {
  const h = harness({
    code: 'const a = 1;',
    render: () => Promise.resolve<readonly ModelRenderImage[]>([{ name: 'iso', png: Uint8Array.from([1]) }]),
  });
  h.budget.inWindow = true;
  const turn = await runModelToolCalls(
    [
      call('write_code', { code: 'const x = 2;' }),
      call('read_code', {}),
      call('edit_code', { edits: [{ find: 'a', replace: 'b' }] }),
      call('run_model', {}),
      call('view_model', {}),
      call('submit_model', { note: 'n' }),
    ],
    new Set(),
    h.state,
    h.ctx,
  );
  assert.equal(h.state.draft.code, 'const b = 1;', 'write_code 被拦，edit_code 仍生效');
  assert.equal(turn.submitted, true);
  assert.equal(h.state.lastViewVersion, 2, '窗口内看图成功，当前版本满足提交门');
  assert.deepEqual(
    eventsOf(openRunDir(h.store.dir).events(), 'tool.result').map((e) => e.body.status),
    ['window-blocked', 'ok', 'ok', 'ok', 'ok', 'accepted'],
  );
  assert.match(turn.toolMessages[0]?.content ?? '', /不能再 write_code 整份写入/);
  assert.match(turn.toolMessages[4]?.content ?? '', /已渲染第 v2 版/);
});

it('submit 未看图被拒、看图后可交', async () => {
  const h = harness({
    code: 'const a = 1;',
    render: () => Promise.resolve<readonly ModelRenderImage[]>([{ name: 'iso', png: Uint8Array.from([1]) }]),
  });
  await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);

  const rejected = await runModelToolCalls([call('submit_model', { note: 'n' })], new Set(), h.state, h.ctx);
  assert.equal(rejected.submitted, false);
  assert.match(rejected.toolMessages[0]?.content ?? '', /还没有成功看过图/);
  assert.match(rejected.toolMessages[0]?.content ?? '', /view_model/);
  assert.equal(eventsOf(openRunDir(h.store.dir).events(), 'submit').at(-1)?.body.accepted, false);

  const view = await runModelToolCalls([call('view_model', {})], new Set(), h.state, h.ctx);
  assert.equal(view.images.length, 2);
  assert.equal(h.state.lastViewVersion, 1);
  const accepted = await runModelToolCalls([call('submit_model', { note: 'n' })], new Set(), h.state, h.ctx);
  assert.equal(accepted.submitted, true);
  assert.equal(eventsOf(openRunDir(h.store.dir).events(), 'submit').at(-1)?.body.accepted, true);
});

it('看图后 edit_code 产生新版本，旧看图不再算数，需重新看图', async () => {
  const h = harness({
    code: 'const a = 1;',
    render: () => Promise.resolve<readonly ModelRenderImage[]>([{ name: 'iso', png: Uint8Array.from([1]) }]),
  });
  await runModelToolCalls([call('run_model', {}), call('view_model', {})], new Set(), h.state, h.ctx);
  assert.equal(h.state.lastViewVersion, 1);

  const edited = await runModelToolCalls(
    [call('edit_code', { edits: [{ find: 'a', replace: 'b' }] }), call('run_model', {})],
    new Set(),
    h.state,
    h.ctx,
  );
  assert.equal(edited.stop, null);
  assert.equal(h.state.lastViewVersion, 1, '旧看图仍记在第 v1 版');
  const rejected = await runModelToolCalls([call('submit_model', { note: 'n' })], new Set(), h.state, h.ctx);
  assert.equal(rejected.submitted, false);
  assert.match(rejected.toolMessages[0]?.content ?? '', /还没有成功看过图/);

  const reViewed = await runModelToolCalls([call('view_model', {})], new Set(), h.state, h.ctx);
  assert.equal(reViewed.images.length, 2);
  assert.equal(h.state.lastViewVersion, 2);
  const accepted = await runModelToolCalls([call('submit_model', { note: 'n' })], new Set(), h.state, h.ctx);
  assert.equal(accepted.submitted, true);
});

it('看图后 write_code 产生新版本，旧看图同样不再算数', async () => {
  const h = harness({
    code: 'const a = 1;',
    render: () => Promise.resolve<readonly ModelRenderImage[]>([{ name: 'iso', png: Uint8Array.from([1]) }]),
  });
  await runModelToolCalls([call('run_model', {}), call('view_model', {})], new Set(), h.state, h.ctx);
  const rewritten = await runModelToolCalls(
    [call('write_code', { code: 'const c = 3;' }), call('run_model', {})],
    new Set(),
    h.state,
    h.ctx,
  );
  assert.equal(rewritten.stop, null);
  const rejected = await runModelToolCalls([call('submit_model', { note: 'n' })], new Set(), h.state, h.ctx);
  assert.equal(rejected.submitted, false);
  assert.match(rejected.toolMessages[0]?.content ?? '', /还没有成功看过图/);
});

it('看图失败（图片预算拒绝）不算成功看图，submit 仍被拒', async () => {
  const h = harness({
    code: 'const a = 1;',
    render: () => Promise.resolve<readonly ModelRenderImage[]>([{ name: 'iso', png: Uint8Array.from([1]) }]),
  });
  h.budget.imageBytes = IMAGE_BYTES_SOFT + 1;
  await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  const view = await runModelToolCalls([call('view_model', {})], new Set(), h.state, h.ctx);
  assert.match(view.toolMessages[0]?.content ?? '', /超过上限/);
  assert.equal(h.state.lastViewVersion, null, '预算拒绝的看图不算成功');
  const rejected = await runModelToolCalls([call('submit_model', { note: 'n' })], new Set(), h.state, h.ctx);
  assert.equal(rejected.submitted, false);
  assert.match(rejected.toolMessages[0]?.content ?? '', /还没有成功看过图/);
});

it('无渲染器：view_model 明说没有看图，不计数、不伪造成功', async () => {
  const h = harness({ code: 'const a = 1;' });
  await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  const turn = await runModelToolCalls([call('view_model', {})], new Set(), h.state, h.ctx);
  assert.match(turn.toolMessages[0]?.content ?? '', /没有配置模型渲染器/);
  assert.equal(turn.images.length, 0);
  assert.equal(h.budget.images, 0);
  assert.equal(h.state.lastViewVersion, null);
});

it('有渲染器：轮末追加图片、累计 base64 字节并按 hash 缓存', async () => {
  let renders = 0;
  const render: ModelRender = () => {
    renders += 1;
    return Promise.resolve<readonly ModelRenderImage[]>([{ name: 'iso', png: Uint8Array.from([1, 2, 3]) }]);
  };
  const h = harness({ code: 'const a = 1;', render });
  await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  const first = await runModelToolCalls([call('view_model', {})], new Set(), h.state, h.ctx);
  assert.equal(first.images.length, 2); // 说明文字 + 图片块
  assert.equal(h.budget.images, 1);
  assert.equal(h.budget.imageBytes, Buffer.from(Uint8Array.from([1, 2, 3])).toString('base64').length);
  assert.equal(h.state.lastViewVersion, 1);
  const second = await runModelToolCalls([call('view_model', {})], new Set(), h.state, h.ctx);
  assert.equal(second.images.length, 2);
  assert.equal(renders, 1, '同一文档 hash 第二次应命中缓存');
});

it('图片预算超软上限后 view_model 被拒', async () => {
  const h = harness({
    code: 'const a = 1;',
    render: () => Promise.resolve([{ name: 'iso', png: Uint8Array.from([1]) }]),
  });
  h.budget.imageBytes = IMAGE_BYTES_SOFT + 1;
  await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  const turn = await runModelToolCalls([call('view_model', {})], new Set(), h.state, h.ctx);
  assert.match(turn.toolMessages[0]?.content ?? '', /超过上限/);
  assert.equal(turn.images.length, 0);
  assert.equal(turn.stop, null);
});

it('无 bwrap（unsupported）映射 sandbox-unsupported 停止', async () => {
  const h = harness({
    code: 'const a = 1;',
    execute: () => Promise.resolve({ kind: 'unsupported', message: '没有 bwrap' }),
  });
  const turn = await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  assert.equal(turn.stop, 'sandbox-unsupported');
  assert.match(turn.toolMessages[0]?.content ?? '', /没有 bwrap/);
  assert.equal(eventsOf(openRunDir(h.store.dir).events(), 'model.check').at(-1)?.body.status, 'unsupported');
});

it('execute 抛异常 → internal-error 停止并记录，不吞', async () => {
  const h = harness({ code: 'const a = 1;', execute: () => Promise.reject(new Error('模拟宿主缺陷')) });
  const turn = await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  assert.equal(turn.stop, 'internal-error');
  assert.match(turn.toolMessages[0]?.content ?? '', /模拟宿主缺陷/);
  const checks = eventsOf(openRunDir(h.store.dir).events(), 'model.check');
  assert.equal(checks.at(-1)?.body.status, 'internal-error');
});

it('render 抛异常 → internal-error 停止，不吞', async () => {
  const h = harness({
    code: 'const a = 1;',
    render: () => Promise.reject(new Error('渲染崩了')),
  });
  await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  const turn = await runModelToolCalls([call('view_model', {})], new Set(), h.state, h.ctx);
  assert.equal(turn.stop, 'internal-error');
  assert.match(turn.toolMessages[0]?.content ?? '', /渲染崩了/);
  assert.equal(h.state.lastViewVersion, null, '渲染错误的看图不算成功');
});

it('precheck-error 诊断转成可读反馈，且不写成功文档', async () => {
  const h = harness({
    code: 'const a = 1;',
    execute: () =>
      Promise.resolve({
        kind: 'precheck-error',
        message: '代码未通过预检',
        diagnostics: [{ line: 2, column: 3, code: 'TS1005', message: '缺少分号', source: 'const a = 1' }],
        total: 1,
      }),
  });
  const turn = await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  assert.match(turn.toolMessages[0]?.content ?? '', /第 2 行第 3 列：缺少分号/);
  const check = eventsOf(openRunDir(h.store.dir).events(), 'model.check').at(-1);
  assert.equal(check?.body.status, 'precheck-error');
  assert.equal(check.body.document, undefined);
});

it('run_model 把 bounded console 展示在反馈里', async () => {
  const h = harness({
    code: 'const a = 1;',
    execute: (code) =>
      Promise.resolve(
        okExecution(code, makeDocument(), [
          { level: 'log', text: '半径 16' },
          { level: 'warn', text: '段数偏多' },
        ]),
      ),
  });
  const turn = await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  const text = turn.toolMessages[0]?.content ?? '';
  assert.match(text, /console 输出 2 条/);
  assert.match(text, /\[log\] 半径 16/);
  assert.match(text, /\[warn\] 段数偏多/);
  assert.equal(turn.stop, null);
});

it('run_model 成功反馈附几何摘要，失败路径不附', async () => {
  const h = harness({ code: 'const a = 1;' });
  const ok = await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  const okText = ok.toolMessages[0]?.content ?? '';
  assert.match(okText, /几何摘要：1 个部件，8 顶点，12 三角/);
  assert.match(okText, /总包围盒 x\[0,2\] y\[0,3\] z\[0,4\]/);
  assert.match(okText, /- b「块」box 尺寸 2×3×4，y 0~3/);
  assert.equal(ok.stop, null);

  const bad = harness({
    code: 'const a = 1;',
    execute: () => Promise.resolve(buildError([{ level: 'error', text: '坏' }])),
  });
  const failed = await runModelToolCalls([call('run_model', {})], new Set(), bad.state, bad.ctx);
  const badText = failed.toolMessages[0]?.content ?? '';
  assert.match(badText, /执行出错/);
  assert.doesNotMatch(badText, /几何摘要/);
});

it('console 超过行数上限时截断并写明另有几条，不塞大输出', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ level: 'log' as const, text: `第 ${String(i)} 行` }));
  const h = harness({
    code: 'const a = 1;',
    execute: (code) => Promise.resolve(okExecution(code, makeDocument(), many, 5)),
  });
  const turn = await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  const text = turn.toolMessages[0]?.content ?? '';
  assert.match(text, /console 输出 30 条/);
  assert.match(text, /额度超限丢弃 5 条/);
  assert.match(text, /另有 \d+ 条未显示/);
  assert.equal(text.length < 4000, true);
});

it('预检超时 / OOM 显示 message 而不是“0 处问题”', async () => {
  const h = harness({
    code: 'const a = 1;',
    execute: () =>
      Promise.resolve({ kind: 'precheck-error', message: '类型预检超时（5000ms）', diagnostics: [], total: 0 }),
  });
  const turn = await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  const text = turn.toolMessages[0]?.content ?? '';
  assert.match(text, /类型预检未通过：类型预检超时/);
  assert.doesNotMatch(text, /0 处/);
});

it('空文档 run_model 可以成功，但 submit 被拒', async () => {
  const h = harness({
    code: 'const a = 1;',
    execute: (code) => Promise.resolve(okExecution(code, createModel().finish())),
  });
  const run = await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  assert.equal(run.stop, null);
  assert.equal(h.state.lastCheck?.outcome, 'ok');
  const submit = await runModelToolCalls([call('submit_model', { note: 'n' })], new Set(), h.state, h.ctx);
  assert.equal(submit.submitted, false);
  assert.match(submit.toolMessages[0]?.content ?? '', /parts 为空/);
});

it('execute 返回 aborted → stop cancelled，不记 internal-error', async () => {
  const h = harness({ code: 'const a = 1;', execute: () => Promise.resolve({ kind: 'aborted', message: '中止' }) });
  const turn = await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  assert.equal(turn.stop, 'cancelled');
  assert.equal(turn.submitted, false);
  assert.equal(eventsOf(openRunDir(h.store.dir).events(), 'model.check').at(-1)?.body.status, 'aborted');
});

it('signal 在 execute 期间被中止且 execute 抛错 → cancelled，不记 internal-error', async () => {
  const controller = new AbortController();
  const h = harness({
    code: 'const a = 1;',
    signal: controller.signal,
    execute: () => {
      controller.abort();
      return Promise.reject(new Error('aborted'));
    },
  });
  const turn = await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  assert.equal(turn.stop, 'cancelled');
  const status = eventsOf(openRunDir(h.store.dir).events(), 'model.check').at(-1)?.body.status;
  assert.equal(status, 'aborted');
  assert.notEqual(status, 'internal-error');
});

it('render 收到 signal；中止时 stop cancelled', async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const h = harness({
    code: 'const a = 1;',
    signal: controller.signal,
    render: (_document, options) => {
      received = options?.signal;
      controller.abort();
      return Promise.reject(new Error('aborted'));
    },
  });
  await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  const turn = await runModelToolCalls([call('view_model', {})], new Set(), h.state, h.ctx);
  assert.equal(received, controller.signal);
  assert.equal(turn.stop, 'cancelled');
});

it('当前成功快照的 codeHash 被改动（非法）时 submit 拒绝', async () => {
  const h = harness({ code: 'const a = 1;' });
  await runModelToolCalls([call('run_model', {})], new Set(), h.state, h.ctx);
  if (h.state.lastOk !== null) h.state.lastOk = { ...h.state.lastOk, codeHash: 'f'.repeat(64) };
  const turn = await runModelToolCalls([call('submit_model', { note: 'n' })], new Set(), h.state, h.ctx);
  assert.equal(turn.submitted, false);
  assert.equal(turn.stop, null);
  assert.match(turn.toolMessages[0]?.content ?? '', /代码已改动/);
});

it('已中止时整轮调用都不执行：不写 tool.call/result，stop cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness({ code: 'const a = 1;', signal: controller.signal });
  const turn = await runModelToolCalls(
    [call('write_code', { code: 'x' }), call('run_model', {}), call('submit_model', { note: 'n' })],
    new Set(),
    h.state,
    h.ctx,
  );
  assert.equal(turn.stop, 'cancelled');
  assert.equal(turn.submitted, false);
  assert.equal(turn.toolMessages.length, 0);
  assert.equal(turn.summaries.length, 0);
  assert.equal(h.state.draft.version, 1, 'write_code 不应执行');
  // 整轮被拦：连 tool.call/result 都不写，事件文件都没建。
  assert.equal(existsSync(join(h.store.dir, 'events.jsonl')), false);
});

it('execute 返回成功前被中止：后续 submit 不执行、不 accepted、stop cancelled', async () => {
  const controller = new AbortController();
  const h = harness({
    code: 'const a = 1;',
    signal: controller.signal,
    execute: (code) => {
      controller.abort();
      return Promise.resolve(okExecution(code));
    },
  });
  const turn = await runModelToolCalls(
    [call('run_model', {}), call('submit_model', { note: 'n' })],
    new Set(),
    h.state,
    h.ctx,
  );
  assert.equal(turn.stop, 'cancelled');
  assert.equal(turn.submitted, false);
  // run_model 已执行并回消息，但 submit 在下一 tool 前被拦下。
  assert.equal(turn.toolMessages.length, 1);
  assert.equal(turn.toolMessages[0]?.tool_call_id, 'run_model');
  const events = openRunDir(h.store.dir).events();
  assert.equal(events.filter((e) => e.type === 'tool.result').length, 1);
  assert.equal(events.filter((e) => e.type === 'submit').length, 0);
  assert.equal(events.filter((e) => e.type === 'model.check').at(-1)?.body.status, 'ok');
});
