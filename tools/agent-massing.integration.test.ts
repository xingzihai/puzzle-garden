/**
 * agent:massing 端到端集成测试（M5b，决策 #112）：用一份交错父 / 子步骤的 mock 剧本调用真实的
 * `runAgentMassing` 入口，走通「父调 massing（真 bwrap 建模 + 真 Chrome 三视图 / contact）→ write_code
 * 写 world.massingImport('massing#1') → check_code（真预检 + 真 bwrap + 资产通道）→ view_building（真 Chrome）
 * → submit」。父 / 子共用同一个剧本 fetch（入口只接一个 `--mock`），所以父与子的请求按发生顺序交错成一份剧本。
 *
 * 断言：退出码 0、报告四行、交付齐全、存档 32 格且调用表含 massingImport、trace.subruns 1 条、
 * contact 1536×384、无残留 Chrome。没有 bwrap 或 Chrome 时整组 skip；本机两样都有，末尾断言 skip 数为 0。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { readArchive } from '@pg/core/archive';
import { createModel } from '@pg/modeling/model';
import { detectSandbox } from '@pg/sandbox/run';
import { deriveTrace } from '@pg/store/derive';
import { canonicalJson } from '@pg/store/canonical-json';
import type { Event } from '@pg/store/events';
import { openRunDir } from '@pg/store/run-dir';
import { CONTACT_HEIGHT, CONTACT_WIDTH, DEFAULT_CHROME_PATH } from '@pg/web/model-render';

import { runAgentMassing } from './agent-massing.ts';

const sandbox = detectSandbox();
const support = {
  ok: sandbox.ok && existsSync(DEFAULT_CHROME_PATH),
  reason: sandbox.ok ? `找不到 ${DEFAULT_CHROME_PATH}` : sandbox.reason,
};
const counter = { skipped: 0 };

const ROOT = mkdtempSync(join(tmpdir(), 'pg-agent-massing-integration-'));
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const TASK_MD = [
  '# 用草模子运行做一个基座并落地',
  '',
  '## 一、需求',
  '调用 massing 工具生成一个粗基座，并用 massingImport 落地。',
  '',
  '## 二、禁止',
  '不要墙。',
  '',
  '## 三、尺寸',
  '一个 4×2×4 的实心基座。',
  '',
  '## 四、交付',
  '提交即可。',
  '',
].join('\n');

/** 子交付一个 4×2×4 的实心基座（solid 默认），落地后应为 32 格、单一 massingImport 调用。 */
const CHILD_CODE =
  'export default function build(model: Model): void {\n' +
  '  model.box({ id: "base", name: "基座", role: "volume", color: "#9a9a9a", material: "stone_bricks", size: [4, 2, 4] });\n' +
  '}\n';

const PARENT_CODE = [
  'export default function build(w: World): void {',
  "  w.massingImport('massing#1');",
  '}',
  '',
].join('\n');

/** 父 / 子请求按发生顺序交错：先父 massing，子 4 步，再父 write_code → check → view → submit。 */
function chainScript(): unknown {
  return {
    name: 'agent-massing-chain',
    task: '用草模子运行做一个基座并落地',
    steps: [
      {
        // ① 父：派草模子运行。
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [{ name: 'massing', arguments: { brief: '一个 4×2×4 的实心基座', maxTurns: 12, maxCny: 0.5 } }],
        },
      },
      // ②–⑤ 子：写码 → 执行 → 看图 → 提交。
      {
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'write_code', arguments: { code: CHILD_CODE } }] },
      },
      {
        expect: { toolIncludes: ['已写入第 v1 版'] },
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'run_model', arguments: {} }] },
      },
      {
        expect: { toolIncludes: ['执行成功'] },
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'view_model', arguments: {} }] },
      },
      {
        expect: { imageBlocks: 3 },
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [{ name: 'submit_model', arguments: { note: '集成测试基座' } }],
        },
      },
      // ⑥–⑨ 父：看到 massing#1 + 合成图后落地、检查、看图、提交。
      {
        expect: { toolIncludes: ['massing#1'], imageBlocks: 1 },
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [{ name: 'write_code', arguments: { code: PARENT_CODE } }],
        },
      },
      {
        expect: { toolIncludes: ['已写入第 v1 版'] },
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'check_code', arguments: {} }] },
      },
      {
        expect: { toolIncludes: ['执行成功'] },
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'view_building', arguments: {} }] },
      },
      {
        expect: { toolIncludes: ['已渲染'], imageBlocks: 2 },
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'submit', arguments: { note: 'A 组入口全链' } }] },
      },
    ],
  };
}

function captureIo(): {
  readonly io: { stdout: (l: string) => void; stderr: (l: string) => void };
  readonly out: string[];
  readonly err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, out, err };
}

function guarded(name: string, fn: () => Promise<void>): void {
  if (!support.ok) {
    counter.skipped += 1;
    test(name, { skip: support.reason }, () => undefined);
    return;
  }
  test(name, fn);
}

test('有 bwrap 与 Chrome 时 skip 数为 0', () => {
  if (!support.ok) return;
  assert.equal(counter.skipped, 0);
});

guarded('agent:massing 全链：massing 子运行 → massingImport 落地 → 真 check/看图 → 交付', async () => {
  const taskPath = join(ROOT, 'm1-09.md');
  const scriptPath = join(ROOT, 'chain.json');
  const outDir = join(ROOT, 'runs');
  writeFileSync(taskPath, TASK_MD);
  writeFileSync(scriptPath, JSON.stringify(chainScript()));

  const captured = captureIo();
  const code = await runAgentMassing([taskPath, '--mock', scriptPath, '--seed', '7', '--out', outDir], captured.io);
  assert.equal(code, 0, captured.err.join('\n'));

  // 报告四行：run 目录 / 停止原因 / 花费 / 轮数。
  const report = captured.out.join('\n');
  assert.match(report, /构建 agent \+ 草模 host/);
  assert.match(report, /run 目录: /);
  assert.match(report, /停止原因: submitted/);
  assert.match(report, /花费: ¥/);
  assert.match(report, /轮数: /);

  const entries = readdirSync(outDir);
  assert.equal(entries.length, 1, '应只有一个 run 目录');
  const runDir = join(outDir, entries[0] ?? '');
  const events = openRunDir(runDir).events();

  const end = events.find((event) => event.type === 'run.end');
  assert.ok(end?.type === 'run.end');
  assert.equal(end.body.stopReason, null, '应正常交付');

  // 交付物：代码、存档、交付说明与 6 张交付渲染图。
  const deliveryDir = join(runDir, 'delivery');
  for (const name of ['building.ts', 'building.pgar', 'delivery.json']) {
    assert.ok(readFileSync(join(deliveryDir, name)).length > 0, `交付缺 ${name}`);
  }
  assert.deepEqual(readdirSync(join(deliveryDir, 'render')).sort(), [
    'east.png',
    'iso-se.png',
    'north.png',
    'south.png',
    'top.png',
    'west.png',
  ]);

  // 存档：massingImport 落地子文档的 4×2×4 solid 盒 = 32 格，材质来自子部件自带 material。
  const registry = loadRegistry();
  const archive = new Uint8Array(readFileSync(join(deliveryDir, 'building.pgar')));
  const grid = readArchive(registry.table, archive).grid;
  assert.equal(grid.size, 32);
  assert.deepEqual(
    grid.calls().map((call) => call.api),
    ['massingImport'],
  );

  const checkEvent = events.find(
    (event): event is Extract<Event, { type: 'check.result' }> => event.type === 'check.result',
  );
  assert.ok(checkEvent !== undefined, '应有 check.result');
  assert.deepEqual(checkEvent.body.apiCalls, { massingImport: 1 });

  // 子运行：trace 1 条、成功、花费为正；子交付文件齐全。
  const trace = deriveTrace(events);
  assert.equal((trace.subruns ?? []).length, 1);
  const subrun = events.find(
    (event): event is Extract<Event, { type: 'subrun.result' }> => event.type === 'subrun.result',
  );
  assert.ok(subrun !== undefined, '应有 subrun.result');
  assert.equal(subrun.body.status, 'success');
  assert.ok(subrun.body.costCny > 0, '子运行真实花费应为正');
  const childDir = join(runDir, 'sub', 'massing-1');
  for (const name of ['source.ts', 'model.json', 'manifest.json']) {
    assert.ok(readFileSync(join(childDir, 'delivery', name)).length > 0, `子交付缺 ${name}`);
  }

  // contact 合成图：1536×384，purpose=massing。
  const contactEvent = events.find(
    (event): event is Extract<Event, { type: 'render.result' }> =>
      event.type === 'render.result' && event.body.purpose === 'massing',
  );
  assert.ok(contactEvent !== undefined, '应有 massing render.result');
  assert.equal(contactEvent.body.kind, 'ok');
  assert.equal(contactEvent.body.images[0]?.view, 'contact');
  const contactPng = openRunDir(runDir).blob(contactEvent.body.images[0].png.sha256);
  const view = new DataView(contactPng.buffer, contactPng.byteOffset, contactPng.byteLength);
  assert.equal(view.getUint32(0), 0x89504e47, 'PNG 魔数');
  assert.deepEqual(
    { width: view.getUint32(16), height: view.getUint32(20) },
    { width: CONTACT_WIDTH, height: CONTACT_HEIGHT },
  );

  // 体素交付渲染成功（6 张）。
  const deliverRender = events.find(
    (event): event is Extract<Event, { type: 'render.result' }> =>
      event.type === 'render.result' && event.body.purpose === 'deliver',
  );
  assert.ok(deliverRender !== undefined);
  assert.equal(deliverRender.body.kind, 'ok');
  assert.equal(deliverRender.body.images.length, 6);

  // 无残留 Chrome（入口已关闭体素与建模渲染器）。
  for (const pattern of [`pg-render-${String(process.pid)}-`, `pg-model-render-${String(process.pid)}-`]) {
    const residue = spawnSync('pgrep', ['-af', pattern], { encoding: 'utf8' });
    assert.equal(residue.stdout.trim(), '', `Chrome 应无残留（${pattern}）：${residue.stdout}`);
  }
});

guarded('旧稿资产与来源门槛：错误来源拒绝提交，改为导入后交付；直接组不暴露草模工具', async () => {
  const model = createModel();
  model.box({ id: 'base', name: '基座', role: 'volume', color: '#888888', material: 'stone', size: [4, 2, 4] });
  const taskPath = join(ROOT, 'seed-task.md');
  const seedPath = join(ROOT, 'seed.ts');
  const assetsPath = join(ROOT, 'seed-assets.json');
  const gatesPath = join(ROOT, 'source-gates.json');
  const scriptPath = join(ROOT, 'seed-script.json');
  const outDir = join(ROOT, 'seed-runs');
  writeFileSync(taskPath, TASK_MD);
  writeFileSync(seedPath, "export default function build(w: World): void { w.set(0,1,0,'stone'); }");
  writeFileSync(assetsPath, JSON.stringify([{ id: 'seed-roof', document: model.finish() }]));
  writeFileSync(
    gatesPath,
    JSON.stringify({
      sourceRegions: [
        {
          name: '试验区域',
          bounds: [0, 1, 0, 3, 2, 3],
          apis: ['massingImport'],
          minCells: 32,
          minColumns: 16,
          minRatio: 1,
        },
      ],
    }),
  );
  const reply = (name: string, args: object = {}): object => ({
    kind: 'message',
    content: null,
    toolCalls: [{ name, arguments: args }],
  });
  writeFileSync(
    scriptPath,
    JSON.stringify({
      name: 'seed-assets-and-source',
      task: '旧稿修改',
      steps: [
        { reply: reply('check_code') },
        { expect: { toolIncludes: ['来源区域'] }, reply: reply('submit', { note: '应被拒绝' }) },
        {
          expect: { toolIncludes: ['没过骨架门槛'] },
          reply: reply('write_code', {
            code: "export default function build(w: World): void { w.massingImport('seed-roof'); }",
          }),
        },
        { reply: reply('check_code') },
        { expect: { toolIncludes: ['全部通过'] }, reply: reply('submit', { note: '已使用旧草模资产' }) },
      ],
    }),
  );
  const captured = captureIo();
  const code = await runAgentMassing(
    [
      taskPath,
      '--mock',
      scriptPath,
      '--out',
      outDir,
      '--seed-code',
      seedPath,
      '--seed-assets',
      assetsPath,
      '--gates',
      gatesPath,
      '--feedback',
      '保持基座',
      '--without-massing',
    ],
    captured.io,
  );
  assert.equal(code, 0, captured.err.join('\n'));
  assert.doesNotMatch(captured.out.join('\n'), /\+ 草模 host/);
  const dir = join(outDir, readdirSync(outDir)[0] ?? '');
  const reader = openRunDir(dir);
  const events = reader.events();
  const prompt = events.find((e) => e.type === 'prompt.system');
  assert.ok(prompt?.type === 'prompt.system');
  assert.doesNotMatch(new TextDecoder().decode(reader.blob(prompt.body.tools.sha256)), /"name":"massing"/);
  assert.deepEqual(
    events.filter((e) => e.type === 'submit').map((e) => e.body.accepted),
    [false, true],
  );
  const start = events.find((e) => e.type === 'run.start');
  assert.ok(start?.type === 'run.start');
  const fed = new TextDecoder().decode(reader.blob(start.body.task.fed.sha256));
  assert.match(fed, /保持基座/);
  assert.match(fed, /剩余文档容量 7 份/);
  const experiment = readFileSync(join(dir, 'experiment-input.json'));
  const inputRef = { sha256: createHash('sha256').update(experiment).digest('hex'), bytes: experiment.length };
  const seed = readFileSync(seedPath);
  const seedRef = { sha256: createHash('sha256').update(seed).digest('hex'), bytes: seed.length };
  assert.equal(
    readFileSync(join(dir, 'experiment-input.manifest.json'), 'utf8'),
    canonicalJson({ input: inputRef, seedCode: seedRef }),
  );
  assert.deepEqual(Buffer.from(reader.blob(inputRef.sha256)), experiment);
  assert.deepEqual(Buffer.from(reader.blob(seedRef.sha256)), seed);
  assert.match(fed, new RegExp(`sha256 ${inputRef.sha256}，bytes ${String(inputRef.bytes)}`));
  assert.equal(start.body.task.sha256, createHash('sha256').update(TASK_MD).digest('hex'));
  const request = events.find((e) => e.type === 'llm.request');
  assert.ok(request);
  const requestText = new TextDecoder().decode(reader.request(request.seq));
  assert.ok(requestText.includes(inputRef.sha256));
  assert.doesNotMatch(requestText, /"sourceRegions"|"seedAssets"|"positions"/);
  // 旁文件被改不会改变事件绑定的输入；原始字节仍可按 Ref 从 blob 找回。
  writeFileSync(join(dir, 'experiment-input.json'), '{}');
  assert.notEqual(
    createHash('sha256')
      .update(readFileSync(join(dir, 'experiment-input.json')))
      .digest('hex'),
    inputRef.sha256,
  );
  assert.deepEqual(Buffer.from(reader.blob(inputRef.sha256)), experiment);
  assert.equal(readArchive(loadRegistry().table, readFileSync(join(dir, 'delivery/building.pgar'))).grid.size, 32);
});

guarded('7 份种子 + 新草模：第 8 份正常透传，第 9 份拒绝，复用和旧稿检查交付仍成功', async () => {
  const taskPath = join(ROOT, 'capacity-task.md');
  const seedPath = join(ROOT, 'capacity-seed.ts');
  const assetsPath = join(ROOT, 'capacity-assets.json');
  const scriptPath = join(ROOT, 'capacity-script.json');
  const outDir = join(ROOT, 'capacity-runs');
  const model = createModel();
  model.box({ id: 'seed', name: '种子基座', role: 'volume', color: '#888888', size: [4, 2, 4] });
  writeFileSync(taskPath, TASK_MD);
  writeFileSync(seedPath, "export default function build(w: World): void { w.massingImport('seed-0'); }");
  writeFileSync(
    assetsPath,
    JSON.stringify(
      Array.from({ length: 7 }, (_, i) => ({
        id: `seed-${String(i)}`,
        document: model.finish(),
      })),
    ),
  );
  const reply = (name: string, args: object = {}): object => ({
    kind: 'message',
    content: null,
    toolCalls: [{ name, arguments: args }],
  });
  const args = { brief: '新增基座', maxTurns: 12, maxCny: 0.5 };
  writeFileSync(
    scriptPath,
    JSON.stringify({
      name: 'capacity-chain',
      task: '种子与新资产',
      steps: [
        { reply: reply('massing', args) },
        { reply: reply('write_code', { code: CHILD_CODE }) },
        { reply: reply('run_model') },
        { reply: reply('view_model') },
        { reply: reply('submit_model', { note: '容量测试基座' }) },
        { expect: { toolIncludes: ['massing#1'] }, reply: reply('massing', { ...args, brief: '不得启动' }) },
        { expect: { toolIncludes: ['未启动子运行', 'documents-count'] }, reply: reply('massing', args) },
        {
          expect: { toolIncludes: ['同键，复用'] },
          reply: reply('write_code', {
            code: "export default function build(w: World): void { w.massingImport('seed-0'); w.massingImport('massing#1', { at: [8, 1, 0] }); }",
          }),
        },
        { reply: reply('check_code') },
        { expect: { toolIncludes: ['执行成功'] }, reply: reply('submit', { note: '种子与新增均保留' }) },
      ],
    }),
  );
  const captured = captureIo();
  const exitCode = await runAgentMassing(
    [taskPath, '--mock', scriptPath, '--out', outDir, '--seed-code', seedPath, '--seed-assets', assetsPath],
    captured.io,
  );
  const dir = join(outDir, readdirSync(outDir)[0] ?? '');
  const reader = openRunDir(dir);
  const checkTexts = reader
    .events()
    .filter(
      (e): e is Extract<Event, { type: 'tool.result' }> => e.type === 'tool.result' && e.body.name === 'check_code',
    )
    .map((e) => new TextDecoder().decode(reader.blob(e.body.text.sha256)));
  assert.equal(exitCode, 0, [...captured.err, ...checkTexts].join('\n'));
  assert.deepEqual(readdirSync(join(dir, 'sub')), ['massing-1']);
  const events = openRunDir(dir).events();
  assert.ok(events.some((e) => e.type === 'tool.result' && e.body.status === 'rejected-assets'));
  assert.deepEqual(
    events.filter((e) => e.type === 'subrun.result').map((e) => e.body.reason),
    [undefined, 'reuse'],
  );
  assert.deepEqual(
    events.filter((e) => e.type === 'subrun.result').map((e) => e.body.status),
    ['success', 'success'],
  );
  assert.equal(readArchive(loadRegistry().table, readFileSync(join(dir, 'delivery/building.pgar'))).grid.size, 64);
});

guarded('实验输入 hash：排版与键序不影响，门槛 / 文档 / 种子代码 / host 开关分别改变绑定', async () => {
  const taskPath = join(ROOT, 'hash-task.md');
  const seedPath = join(ROOT, 'hash-seed.ts');
  const assetsPath = join(ROOT, 'hash-assets.json');
  const gatesPath = join(ROOT, 'hash-gates.json');
  const scriptPath = join(ROOT, 'hash-script.json');
  writeFileSync(taskPath, TASK_MD);
  writeFileSync(
    scriptPath,
    JSON.stringify({
      name: 'hash-inputs',
      task: '固定输入',
      steps: Array.from({ length: 4 }, () => ({ reply: { kind: 'message', content: null } })),
    }),
  );
  const hashes: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const seedCode = `export default function build(w: World): void {}${i === 4 ? '\n// 修改代码' : ''}`;
    const gates = { reachAll: i === 2, forbidApis: ['box'] };
    const document = { version: i === 3 ? 1 : 2, parts: [] };
    const assets = [{ id: 'seed', document }];
    writeFileSync(seedPath, seedCode);
    writeFileSync(
      gatesPath,
      i === 1
        ? JSON.stringify({ forbidApis: gates.forbidApis, reachAll: gates.reachAll }, null, 2)
        : JSON.stringify(gates),
    );
    writeFileSync(
      assetsPath,
      i === 1 ? JSON.stringify([{ document: { parts: [], version: 2 }, id: 'seed' }], null, 2) : JSON.stringify(assets),
    );
    const outDir = join(ROOT, `hash-runs-${String(i)}`);
    const captured = captureIo();
    assert.equal(
      await runAgentMassing(
        [
          taskPath,
          '--mock',
          scriptPath,
          '--out',
          outDir,
          '--seed-code',
          seedPath,
          '--seed-assets',
          assetsPath,
          '--gates',
          gatesPath,
          ...(i === 5 ? [] : ['--without-massing']),
        ],
        captured.io,
      ),
      1,
      captured.err.join('\n'),
    );
    assert.deepEqual(captured.err, []);
    const dir = join(outDir, readdirSync(outDir)[0] ?? '');
    const reader = openRunDir(dir);
    const start = reader.events().find((e) => e.type === 'run.start');
    assert.ok(start?.type === 'run.start');
    const seedRef = { sha256: createHash('sha256').update(seedCode).digest('hex'), bytes: Buffer.byteLength(seedCode) };
    const expected = canonicalJson({ gates, seedAssets: assets, seedCode: seedRef, withoutMassing: i !== 5 });
    assert.equal(readFileSync(join(dir, 'experiment-input.json'), 'utf8'), expected);
    const sha = createHash('sha256').update(expected).digest('hex');
    hashes.push(sha);
    assert.equal(new TextDecoder().decode(reader.blob(sha)), expected);
    assert.ok(new TextDecoder().decode(reader.blob(start.body.task.fed.sha256)).includes(sha));
    assert.equal(start.body.task.sha256, createHash('sha256').update(TASK_MD).digest('hex'));
  }
  assert.equal(hashes[0], hashes[1]);
  assert.equal(new Set(hashes).size, 5);
});
