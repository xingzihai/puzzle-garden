/** model:agent 的单元测试：参数解析、演示剧本结构、种子/剧本读取，以及用假 execute/render 跑通 mock 循环。 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import type { ExternalVersions } from '@pg/agent/runner';
import { createScriptedFetch } from '@pg/llm/mock';
import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';
import type { ModelExecution } from '@pg/sandbox/modeling';
import { openRunDir } from '@pg/store/run-dir';

import { AgentArgError, agentTask, parseAgentArgs, runModelAgent } from './model-agent.ts';
import {
  DEMO_FIX,
  MODELING_API,
  MODEL_DEMO_NOTE,
  MODEL_DEMO_TASK,
  brokenDemoCode,
  buildDemoScript,
  loadDemoCode,
  modelRunId,
  readModelScript,
  readModelSeedCode,
  realSleep,
  sha256Hex,
} from './model-agent-deps.ts';
import { LIVE_MODEL } from './model-agent-live.ts';

/**
 * live 测试题面：含必需四节与 '函数建模'（演示剧本第一步的 expect），
 * 另加引用块与五、六节，用来验证 fed 不含来源路径（raw 仍含）。
 */
const LIVE_TASK_MD = [
  '# 函数建模 live 测试',
  '',
  '## 一、需求',
  '用函数建模做一个粗模。',
  '',
  '## 二、禁止',
  '不要墙。',
  '',
  '## 三、尺寸',
  '随意。',
  '',
  '## 四、交付',
  '提交即可。',
  '',
  '> 来源：/secret/do-not-feed.md',
  '',
  '## 五、旧工具',
  '不该喂给模型。',
  '',
  '## 六、来源',
  '/secret/path',
  '',
].join('\n');

const VERSIONS: ExternalVersions = {
  git: { commit: 'test', dirty: false, diff: null },
  node: '24',
  precheck: 'mp',
  sandbox: 'ms',
  target: 'modeling',
  modelingApi: MODELING_API,
  modelingDts: 'd',
  modelFormat: 2,
};

function captureIo(): {
  io: { stdout: (l: string) => void; stderr: (l: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, out, err };
}

function makeDocument(): ModelDocument {
  const model = createModel();
  model.box({ id: 'base', name: '块', role: 'floor', color: '#112233', size: [4, 2, 4] });
  return model.finish();
}

/** 假执行：坏码复刻真实 sandbox 的 build-error，好码返回合法文档；hash 与 session 口径一致。
 * 执行前真实等待一小段，用来验证真实等待会计入 runner 的真实墙钟（不是毫秒阈值断言，只要 > 0）。 */
async function fakeExecute(code: string): Promise<ModelExecution> {
  await realSleep(12, new AbortController().signal);
  if (code.includes(DEMO_FIX.broken)) {
    return {
      kind: 'build-error',
      message: '采样非有限数字',
      name: 'ModelError',
      line: 0,
      column: 0,
      console: [],
      consoleTruncated: 0,
    };
  }
  const document = makeDocument();
  return {
    kind: 'ok',
    document,
    codeHash: sha256Hex(code),
    documentHash: sha256Hex(JSON.stringify(document)),
    console: [],
    consoleTruncated: 0,
  };
}

function fakeRender(): Promise<readonly { readonly name: string; readonly png: Uint8Array }[]> {
  return Promise.resolve([
    { name: 'overall', png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
    { name: 'top', png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]) },
    { name: 'side', png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 7, 8, 9]) },
  ]);
}

it('parseAgentArgs：--demo / --live 互斥，各自必填项与默认值', () => {
  const demo = parseAgentArgs(['--demo']);
  assert.equal(demo.mode, 'demo');
  assert.equal(demo.taskPath, undefined);
  assert.equal(demo.outDir, '.work/modeling-demo');
  assert.equal(demo.seed, 7);
  assert.deepEqual(demo.limits, { maxCostCny: 1, maxTurns: 20, wallMs: 240_000, submitWindow: 2 });
  assert.equal(parseAgentArgs(['--demo', '--out', 'x', '--feedback', '收窄一点']).feedback, '收窄一点');
  assert.equal(parseAgentArgs(['--demo', '--max-cny', '0.5']).limits.maxCostCny, 0.5);

  // live 必须显式给 --task / --max-cny / --out，没有默认；且不接受 --script。
  const live = parseAgentArgs(['--live', '--task', 't.md', '--max-cny', '2', '--out', 'o']);
  assert.equal(live.mode, 'live');
  assert.equal(live.taskPath, 't.md');
  assert.equal(live.outDir, 'o');
  assert.equal(live.limits.maxCostCny, 2);
  assert.equal(live.scriptPath, undefined);

  assert.throws(() => parseAgentArgs([]), /必须且只能给一个 --demo 或 --live/);
  assert.throws(() => parseAgentArgs(['--demo', '--live']), /必须且只能给一个/);
  assert.throws(() => parseAgentArgs(['--live']), /必须给 --task/);
  assert.throws(() => parseAgentArgs(['--live', '--task', 't.md']), /必须给 --max-cny/);
  assert.throws(() => parseAgentArgs(['--live', '--task', 't.md', '--max-cny', '2']), /必须给 --out/);
  assert.throws(() => parseAgentArgs(['--live', '--max-cny', '2', '--out', 'o']), /必须给 --task/);
  assert.throws(() => parseAgentArgs(['--demo', '--task', 't.md']), /只用于 --live/);
  assert.throws(
    () => parseAgentArgs(['--live', '--task', 't.md', '--max-cny', '2', '--out', 'o', '--script', 's.json']),
    /不接受 --script/,
  );
  assert.throws(() => parseAgentArgs(['--live', '--task', 't.md', '--max-cny', '0', '--out', 'o']), /正数/);
  assert.throws(() => parseAgentArgs(['--demo', '--max-turns', '3']), AgentArgError);
  assert.throws(() => parseAgentArgs(['--demo', '--wall-ms', '1000']), AgentArgError);
  assert.throws(() => parseAgentArgs(['--demo', '--submit-window', '0']), AgentArgError);
  assert.throws(() => parseAgentArgs(['--demo', '--wat']), /不认识的参数/);
});

it('agentTask 把 --feedback 追加到固定题面', () => {
  assert.equal(agentTask(parseAgentArgs(['--demo'])), MODEL_DEMO_TASK);
  const withFeedback = agentTask(parseAgentArgs(['--demo', '--feedback', '屋顶再收一点']));
  assert.ok(withFeedback.startsWith(MODEL_DEMO_TASK));
  assert.match(withFeedback, /用户反馈：屋顶再收一点/);
});

it('演示剧本：4 步、坏码可修复、修复后等于示例稿', () => {
  const good = loadDemoCode();
  const bad = brokenDemoCode(good);
  assert.ok(bad.includes(DEMO_FIX.broken));
  assert.equal(good.includes(DEMO_FIX.broken), false);
  assert.equal(good.split(DEMO_FIX.fixed).length - 1, 1);

  const script = buildDemoScript({ task: MODEL_DEMO_TASK, goodCode: good, note: 'n' });
  assert.equal(script.name, 'model-demo');
  assert.equal(script.steps.length, 4);
  const names = script.steps.map((s) => (s.reply.kind === 'message' ? s.reply.toolCalls?.map((c) => c.name) : []));
  assert.deepEqual(names, [['write_code', 'run_model'], ['edit_code', 'run_model'], ['view_model'], ['submit_model']]);

  let editArgs: { edits: readonly { find: string; replace: string }[] } | undefined;
  for (const step of script.steps) {
    if (step.reply.kind !== 'message') continue;
    const call = step.reply.toolCalls?.find((c) => c.name === 'edit_code');
    if (call !== undefined) editArgs = call.arguments as { edits: readonly { find: string; replace: string }[] };
  }
  assert.ok(editArgs !== undefined, '剧本应含 edit_code 步');
  const firstEdit = editArgs.edits[0];
  assert.ok(firstEdit !== undefined, 'edit_code 应至少一条');
  assert.equal(firstEdit.find, DEMO_FIX.broken);
  assert.equal(firstEdit.replace, DEMO_FIX.fixed);
  assert.throws(() => brokenDemoCode('no marker here'), /恰好出现 1 次/);
});

it('readModelSeedCode / readModelScript / modelRunId 的边界', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-model-agent-'));
  try {
    assert.throws(() => readModelSeedCode(join(dir, 'missing.ts')), /读不到/);
    const empty = join(dir, 'empty.ts');
    writeFileSync(empty, '\n \n');
    assert.throws(() => readModelSeedCode(empty), /空文件或全空白/);

    const badScript = join(dir, 'bad.json');
    writeFileSync(badScript, '{ not json');
    assert.throws(() => readModelScript(badScript), /不是合法 JSON/);
    const schemaBad = join(dir, 'schema.json');
    writeFileSync(schemaBad, JSON.stringify({ name: 'x', task: 't', steps: [] }));
    assert.throws(() => readModelScript(schemaBad), /不合 ScriptSchema/);

    const good = buildDemoScript({ task: MODEL_DEMO_TASK, goodCode: loadDemoCode(), note: 'n' });
    const goodPath = join(dir, 'good.json');
    writeFileSync(goodPath, JSON.stringify(good));
    const loaded = readModelScript(goodPath);
    assert.equal(loaded.script.name, 'model-demo');
    assert.match(loaded.sha256, /^[0-9a-f]{64}$/);

    assert.match(modelRunId(new Date('2026-10-11T01:02:03Z')), /^20261011-010203-model-[0-9a-f]{6}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('runModelAgent --demo：坏码报错 → 修复 → 看图 → 提交，写完整交付', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-agent-run-'));
  try {
    const io = captureIo();
    const code = await runModelAgent(['--demo', '--out', root, '--seed', '7'], io.io, {
      execute: fakeExecute,
      render: fakeRender,
      versions: VERSIONS,
      countTokens: (text) => text.length,
    });
    assert.equal(code, 0, io.err.join('\n'));
    assert.ok(io.out.some((l) => l.includes('不是真实模型调用')));

    const entries = readdirSync(root);
    assert.equal(entries.length, 1);
    const runDir = join(root, entries[0] ?? '');
    for (const file of ['source.ts', 'model.json', 'manifest.json', 'note.md']) {
      assert.ok(readFileSync(join(runDir, 'delivery', file)).length > 0, `${file} 应存在且非空`);
    }
    assert.equal(readFileSync(join(runDir, 'delivery', 'source.ts'), 'utf8'), loadDemoCode());

    const events = openRunDir(runDir).events();
    const start = events.find((e) => e.type === 'run.start');
    assert.ok(start !== undefined, '应有 run.start');
    assert.equal(start.body.versions.target, 'modeling');
    const scriptMeta = start.body.script;
    assert.ok(scriptMeta !== undefined, '应有剧本元数据');
    assert.equal(scriptMeta.name, 'model-demo');
    assert.match(scriptMeta.sha256, /^[0-9a-f]{64}$/);
    assert.equal(events.filter((e) => e.type === 'model.check').length, 2);
    assert.equal(events.filter((e) => e.type === 'model.delivery').length, 1);
    assert.ok(events.find((e) => e.type === 'run.end' && e.body.lastModel !== undefined));
    assert.equal(events.at(-1)?.type, 'run.end');

    // 真实等待（假执行里的 realSleep，等价于 bwrap / Chrome 的真实耗时）必须计入 runner 的真实墙钟。
    assert.ok(
      events.some((e) => e.type === 'turn.start' && e.body.elapsedMs > 0),
      'turn.start.elapsedMs 应反映真实等待，而不是被 mock 虚拟时钟压成 0',
    );
    const end = events.find((e) => e.type === 'run.end');
    assert.ok(end !== undefined);
    assert.ok(end.body.totals.wallMs > 0, 'run.end 墙钟应计入真实耗时');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('runner 墙钟来自注入 clock：工具耗时计入 elapsed，不藏进 mock 虚拟时钟', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-agent-clock-'));
  try {
    let now = 0;
    const clock = (): number => now;
    // 只有 signal 中止才 reject 的定时器：墙钟远未到点，run 结束时被主动 abort。
    const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (ms <= 0) {
          resolve();
          return;
        }
        const fail = (): void => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        };
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener('abort', fail, { once: true });
      });
    const io = captureIo();
    const code = await runModelAgent(['--demo', '--out', root, '--seed', '7'], io.io, {
      execute: (draft) => {
        now += 300; // 模拟一次真实沙箱执行耗时，由注入的 clock 记入
        if (draft.includes(DEMO_FIX.broken)) {
          return Promise.resolve({
            kind: 'build-error',
            message: '坏',
            name: 'ModelError',
            line: 0,
            column: 0,
            console: [],
            consoleTruncated: 0,
          });
        }
        const document = makeDocument();
        return Promise.resolve({
          kind: 'ok',
          document,
          codeHash: sha256Hex(draft),
          documentHash: sha256Hex(JSON.stringify(document)),
          console: [],
          consoleTruncated: 0,
        });
      },
      render: fakeRender,
      versions: VERSIONS,
      countTokens: (text) => text.length,
      clock,
      sleep,
    });
    assert.equal(code, 0, io.err.join('\n'));
    const runDir = join(root, readdirSync(root)[0] ?? '');
    const events = openRunDir(runDir).events();
    assert.ok(
      events.some((e) => e.type === 'turn.start' && e.body.elapsedMs >= 300),
      '第二轮起 elapsedMs 应包含第一轮工具的真实 300ms',
    );
    const end = events.find((e) => e.type === 'run.end');
    assert.ok(end !== undefined);
    assert.ok(end.body.totals.wallMs >= 300);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('runModelAgent 的参数 / 读文件错误返回退出码 2，且不建 run 目录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-agent-err-'));
  try {
    const none = captureIo();
    assert.equal(await runModelAgent(['--out', root], none.io), 2);
    assert.match(none.err.join('\n'), /必须且只能给一个 --demo 或 --live/);

    const both = captureIo();
    assert.equal(await runModelAgent(['--demo', '--live', '--out', root], both.io), 2);
    assert.match(both.err.join('\n'), /必须且只能给一个/);

    const missingSeed = captureIo();
    assert.equal(
      await runModelAgent(['--demo', '--out', root, '--seed-code', join(root, 'nope.ts')], missingSeed.io),
      2,
    );
    assert.match(missingSeed.err.join('\n'), /读不到/);

    // live 读不到题面：给了注入配置（不读环境、不联网）仍返回 2，且不建 run 目录。
    const missingTask = captureIo();
    assert.equal(
      await runModelAgent(
        ['--live', '--task', join(root, 'nope.md'), '--max-cny', '1', '--out', join(root, 'runs')],
        missingTask.io,
        {
          live: {
            llm: { baseUrl: 'https://mock.invalid/v1', apiKey: 'k', model: LIVE_MODEL, timeoutMs: 600_000 },
            maxRunCostCny: 3.5,
            liveConfirm: true,
          },
        },
      ),
      2,
    );
    assert.match(missingTask.err.join('\n'), /读不到/);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('resolveLiveStartup 的注入：确认缺失 / 模型不在价表 / 缺 key 在联网前就失败', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-agent-live-err-'));
  try {
    const taskPath = join(root, 'task.md');
    writeFileSync(taskPath, LIVE_TASK_MD);
    const argv = ['--live', '--task', taskPath, '--max-cny', '2', '--out', join(root, 'runs')];
    const llm = { baseUrl: 'https://mock.invalid/v1', apiKey: 'k', model: LIVE_MODEL, timeoutMs: 600_000 };

    const noConfirm = captureIo();
    assert.equal(await runModelAgent(argv, noConfirm.io, { live: { llm, maxRunCostCny: 3.5, liveConfirm: false } }), 2);
    assert.match(noConfirm.err.join('\n'), /PG_LIVE_CONFIRM=1/);

    const wrongModel = captureIo();
    assert.equal(
      await runModelAgent(argv, wrongModel.io, {
        live: { llm: { ...llm, model: 'other-model' }, maxRunCostCny: 3.5, liveConfirm: true },
      }),
      2,
    );
    assert.match(wrongModel.err.join('\n'), /不在价格表/);

    const noKey = captureIo();
    assert.equal(
      await runModelAgent(argv, noKey.io, {
        live: { llm: { ...llm, apiKey: '' }, maxRunCostCny: 3.5, liveConfirm: true },
      }),
      2,
    );
    assert.match(noKey.err.join('\n'), /PG_LLM_API_KEY/);

    assert.equal(existsSync(join(root, 'runs')), false, '失败不得建 run 目录');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('runModelAgent --live：注入配置与剧本 fetch，走 live 主循环但不联网', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-agent-live-'));
  try {
    const taskPath = join(root, 'task.md');
    writeFileSync(taskPath, LIVE_TASK_MD);
    const raw = readFileSync(taskPath);
    const script = buildDemoScript({ task: '函数建模', goodCode: loadDemoCode(), note: MODEL_DEMO_NOTE });
    const outDir = join(root, 'runs');
    const io = captureIo();
    const code = await runModelAgent(
      ['--live', '--task', taskPath, '--max-cny', '2', '--out', outDir, '--seed', '7'],
      io.io,
      {
        execute: fakeExecute,
        render: fakeRender,
        versions: VERSIONS,
        countTokens: (text) => text.length,
        live: {
          llm: {
            baseUrl: 'https://mock.invalid/v1',
            apiKey: 'sk-test-do-not-log',
            model: LIVE_MODEL,
            timeoutMs: 600_000,
          },
          maxRunCostCny: 3.5,
          liveConfirm: true,
          fetch: createScriptedFetch(script, 7),
        },
      },
    );
    assert.equal(code, 0, io.err.join('\n'));
    assert.ok(io.out.some((l) => l.includes('真实模型调用')));
    assert.equal(io.err.join('\n').includes('sk-test-do-not-log'), false, '密钥不得进入日志');

    const runDir = join(outDir, readdirSync(outDir)[0] ?? '');
    const events = openRunDir(runDir).events();
    const start = events.find((e) => e.type === 'run.start');
    assert.ok(start !== undefined, '应有 run.start');
    assert.equal(start.body.mode, 'live', 'live 必须是 live 模式，不是 script');
    assert.equal(start.body.script, undefined, 'live 不应有 mock 剧本元数据');
    assert.deepEqual(start.body.config, { baseUrl: 'https://mock.invalid/v1', timeoutMs: 600_000 });
    assert.equal(start.body.limits.maxCostCny, 2);
    assert.equal(start.body.task.sha256, sha256Hex(raw), 'raw hash 必须对题面原文准确');
    assert.equal(events.filter((e) => e.type === 'model.check').length, 2);
    assert.equal(events.filter((e) => e.type === 'model.delivery').length, 1);
    assert.equal(readFileSync(join(runDir, 'delivery', 'source.ts'), 'utf8'), loadDemoCode());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('--help 打印用法并以 0 退出', async () => {
  const io = captureIo();
  assert.equal(await runModelAgent(['--help'], io.io), 0);
  assert.ok(io.out.some((l) => l.includes('--demo')));
});
