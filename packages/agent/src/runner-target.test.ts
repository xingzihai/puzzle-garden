/** 草模适配的 mock 请求链：共享计费/护栏/存储，反馈追加、目标交付与体素产物分离。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { createClient } from '@pg/llm/client';
import { createScriptedFetch, createVirtualTime, ScriptSchema } from '@pg/llm/mock';
import { ChatRequest } from '@pg/llm/schema';
import { deriveTrace } from '@pg/store/derive';
import { Versions } from '@pg/store/events';
import type { Ref } from '@pg/store/events';
import { createRunDir, openRunDir } from '@pg/store/run-dir';

import { runRun } from './runner.ts';
import type { ExternalVersions, RunnerInput } from './runner.ts';
import type { RunnerTarget, TargetContext, TargetTurn } from './target.ts';

const VERSIONS: ExternalVersions = {
  git: { commit: 'test', dirty: false, diff: null },
  node: '24',
  precheck: 'mp',
  sandbox: 'ms',
  target: 'modeling',
  modelingApi: 2,
  modelingDts: 'd',
  modelFormat: 2,
};
const INPUT: RunnerInput = {
  task: { raw: '用函数画屋顶，再根据反馈修改', fed: '用函数画屋顶，再根据反馈修改', source: null },
  seed: 7,
  mode: 'script',
  variant: 'base',
  config: null,
  initialDraft: { code: 'seed' },
  limits: { maxTurns: 8, maxCostCny: 3.5, wallMs: 2400000, submitWindow: 1 },
};
const TOOL = {
  type: 'function' as const,
  function: { name: 'model_step', description: '测试用目标工具', parameters: { type: 'object', properties: {} } },
};

/** 仅测试适配协议：工具行为由注入步骤给出，不执行代码，也不充当产品草模工具实现。 */
function fakeTarget(
  options: { readonly submitAt?: number; readonly stop?: TargetTurn['stop']; readonly fail?: boolean } = {},
): RunnerTarget {
  return {
    kind: 'modeling',
    factsFormat: 101,
    tools: [TOOL],
    system: () => '草模独立 Model 声明',
    create: (input, budget) => {
      assert.equal(input.initialDraft?.code, 'seed');
      let count = 0;
      let document: Ref | undefined;
      const put = (ctx: TargetContext, text: string): Ref => ctx.store.putBlob(new TextEncoder().encode(text));
      return {
        runTools: (calls, invalid, ctx) => {
          assert.equal(ctx.budget, budget);
          assert.equal(ctx.seed, 7);
          assert.equal(invalid.size, 0);
          if (options.fail === true) throw new Error('模拟目标宿主缺陷');
          count += 1;
          document = put(ctx, JSON.stringify({ version: 1, parts: [] }));
          ctx.store.append('model.check', ctx.turn, {
            codeVersion: count,
            codeSha: put(ctx, `code${String(count)}`).sha256,
            seed: ctx.seed,
            status: count === 1 ? 'build-error' : 'ok',
            result: put(ctx, '{}'),
            ...(count === 1 ? {} : { document, documentHash: document.sha256 }),
          });
          const text = count === 1 ? '函数执行失败：请修改参数' : '修改后的函数已执行';
          const toolMessages = calls.map((c) => ({ role: 'tool' as const, tool_call_id: c.id, content: text }));
          return Promise.resolve({
            toolMessages,
            images: [],
            measures: { count },
            stop: options.stop ?? null,
            summaries: calls.map((c) => ({ name: c.function.name, arguments: c.function.arguments, result: text })),
            submitted: count === options.submitAt,
          });
        },
        formatFacts: (f) =>
          `草模轮末：第${String(f.nextTurn)}轮，已花${String(f.spentCny)}，窗口${String(f.window !== null)}`,
        deliver: (ctx) => {
          assert.ok(document);
          const body = { code: put(ctx, 'modified code'), document, hash: document.sha256, codeVersion: count };
          ctx.store.writeDelivery([
            { path: 'model.json', bytes: new TextEncoder().encode('{"version":1,"parts":[]}') },
          ]);
          ctx.store.append('model.delivery', ctx.turn, body);
          return Promise.resolve({ codeVersion: count, hash: body.hash });
        },
        finish: () => (document === undefined ? {} : { lastModel: document }),
      };
    },
  };
}

async function exercise(name: string, target: RunnerTarget, input = INPUT): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pg-target-'));
  try {
    const vt = createVirtualTime();
    const script = ScriptSchema.parse({
      name,
      task: input.task.fed,
      steps: Array.from({ length: 10 }, () => ({
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'model_step', arguments: {} }] },
      })),
    });
    const client = createClient({
      config: { baseUrl: 'https://mock.invalid', apiKey: 'test-key', timeoutMs: 600000 },
      fetch: createScriptedFetch(script, 11),
      clock: vt.clock,
      sleep: vt.sleep,
    });
    const store = createRunDir(root, name);
    const work = runRun(input, {
      target,
      client,
      store,
      clock: vt.clock,
      countTokens: (s) => s.length,
      versions: VERSIONS,
    });
    if (name === 'throws') await assert.rejects(work, /模拟目标宿主缺陷/);
    else {
      const out = await work;
      const reader = openRunDir(out.dir);
      const events = reader.events();
      const trace = deriveTrace(events);
      assert.deepEqual(JSON.parse(readFileSync(join(out.dir, 'trace.json'), 'utf8')) as unknown, trace);
      const requests = events
        .filter((e) => e.type === 'llm.request')
        .map((e) => ChatRequest.parse(JSON.parse(new TextDecoder().decode(reader.request(e.seq))) as unknown));
      for (const [i, req] of requests.entries()) {
        assert.deepEqual(req.tools, [TOOL]);
        assert.deepEqual(req.messages[0], { role: 'system', content: '草模独立 Model 声明' });
        if (i > 0) {
          const previous = requests[i - 1];
          assert.ok(previous);
          assert.deepEqual(req.messages.slice(0, previous.messages.length), previous.messages);
        }
      }
      assert.equal(
        events.some((e) => e.type === 'check.result' || e.type === 'delivery'),
        false,
      );
      assert.equal(trace.lastArchive, undefined);
      const start = events.find((e) => e.type === 'run.start');
      assert.ok(start);
      assert.equal(start.body.versions.factsFormat, 101);
      assert.equal('worldApi' in start.body.versions, false);
      assert.equal(Versions.safeParse({ ...start.body.versions, worldApi: 7 }).success, false);
      assert.equal(Versions.safeParse({ ...start.body.versions, modelingApi: undefined }).success, false);
      if (name === 'delivers') {
        assert.equal(out.delivery?.codeVersion, 2);
        assert.equal(trace.delivered, true);
        assert.ok(trace.lastModel);
        assert.ok(out.costCny !== null && out.costCny > 0);
        assert.match(JSON.stringify(requests[1]?.messages), /函数执行失败/);
        assert.equal(events.filter((e) => e.type === 'code.version').length, 1);
      } else {
        const expected = name === 'budget' ? 'cost-budget' : name === 'host-stop' ? 'sandbox-unsupported' : 'max-turns';
        assert.equal(out.stopReason, expected);
        assert.equal(out.delivery, null);
        assert.equal(trace.delivered, false);
        if (name === 'budget') assert.equal(requests.length, 0);
        if (name === 'turns') {
          assert.equal(requests.length, 4);
          assert.match(JSON.stringify(requests[3]?.messages), /窗口true/);
        }
      }
    }
    assert.equal(openRunDir(store.dir).events().at(-1)?.type, 'run.end');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('草模 target 共用请求/结算；修正反馈只追加；交付 model 事件和 trace', async () => {
  await exercise('delivers', fakeTarget({ submitAt: 2 }));
});
it('目标仍受费用预留、轮数与提交窗口约束', async () => {
  await exercise('budget', fakeTarget(), { ...INPUT, limits: { ...INPUT.limits, maxCostCny: 0.000001 } });
  await exercise('turns', fakeTarget(), { ...INPUT, limits: { ...INPUT.limits, maxTurns: 4 } });
});
it('目标宿主停止与抛错均走共享 run.end', async () => {
  await exercise('host-stop', fakeTarget({ stop: 'sandbox-unsupported' }));
  await exercise('throws', fakeTarget({ fail: true }));
});
