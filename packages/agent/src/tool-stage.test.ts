/** 工具墙钟经真实 runRun + mock SSE 验证；手动推进 clock/sleep，无实际等待或模型请求。 */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { createClient } from '@pg/llm/client';
import { createScriptedFetch, ScriptSchema } from '@pg/llm/mock';
import { deriveTrace } from '@pg/store/derive';
import { createRunDir, openRunDir } from '@pg/store/run-dir';

import { runRun } from './runner.ts';
import type { RunnerTarget, TargetTurn } from './target.ts';

type Scenario =
  | 'deadline'
  | 'external'
  | 'both'
  | 'late'
  | 'before'
  | 'before-external'
  | 'ok'
  | 'throws'
  | 'abort-error'
  | 'timer-error'
  | 'late-timer';

async function exercise(scenario: Scenario): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pg-tool-deadline-'));
  const external = new AbortController();
  const state = { now: 0, calls: 0, delivered: false, nextTool: false };
  const active = new Map<AbortSignal, { ms: number; resolve: () => void; reject: (e: Error) => void }>();
  const saved: { signal: AbortSignal; resolve: () => void }[] = [];
  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const cleanup = (): void => {
        active.delete(signal);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new DOMException('定时器取消', 'AbortError'));
      };
      const done = (): void => {
        cleanup();
        resolve();
      };
      const fail = (e: Error): void => {
        cleanup();
        reject(e);
      };
      active.set(signal, { ms, resolve: done, reject: fail });
      saved.push({ signal, resolve: done });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  const complete: TargetTurn = {
    toolMessages: [],
    summaries: [],
    images: [],
    measures: null,
    stop: null,
    submitted: true,
  };
  let toolSignal: AbortSignal | undefined;
  const target: RunnerTarget = {
    kind: 'modeling',
    factsFormat: 1,
    tools: ['check', 'submit'].map((name) => ({
      type: 'function',
      function: { name, description: '测试工具', parameters: { type: 'object', properties: {} } },
    })),
    system: () => '测试工具截止',
    create: () => ({
      formatFacts: () => '测试事实',
      finish: () => ({}),
      runTools: async (_calls, _invalid, ctx) => {
        state.calls += 1;
        assert.ok(ctx.signal);
        toolSignal = ctx.signal;
        assert.notEqual(ctx.signal, external.signal);
        if (scenario === 'late') {
          state.now = 60000;
          return complete;
        }
        if (scenario === 'ok' || scenario === 'late-timer') return complete;
        if (scenario === 'throws') throw new Error('工具宿主缺陷');
        const pending = [...active.values()];
        assert.equal(pending.length, 1, '请求计时器已清理，仅剩工具计时器');
        const timer = pending[0];
        assert.ok(timer);
        assert.equal(timer.ms, 59000, '扣除模型请求已耗时，不重新给完整 wallMs');
        const aborted = new Promise<void>((resolve) => {
          ctx.signal?.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
        if (scenario === 'external') external.abort();
        else if (scenario === 'timer-error') timer.reject(new Error('计时器故障'));
        else {
          state.now = 60000;
          timer.resolve();
          if (scenario === 'both') external.abort();
        }
        await aborted;
        if (scenario === 'abort-error') throw new DOMException('工具取消', 'AbortError');
        if (!ctx.signal.aborted) state.nextTool = true;
        // 故意同时返回 cancelled 和迟来的 accepted，runner 必须以截止优先并拒绝交付。
        return { ...complete, stop: 'cancelled' };
      },
      deliver: () => {
        state.delivered = true;
        return Promise.resolve({ codeVersion: 1, hash: 'a'.repeat(64) });
      },
    }),
  };
  try {
    const store = createRunDir(root, `tools-${scenario}`);
    const mock = createClient({
      config: { baseUrl: 'https://mock.invalid', apiKey: 'test-key', timeoutMs: 600000 },
      clock: () => state.now,
      sleep,
      fetch: createScriptedFetch(
        ScriptSchema.parse({
          name: 'deadline',
          task: '工具截止',
          steps: [
            {
              reply: {
                kind: 'message',
                content: null,
                toolCalls: [
                  { name: 'check', arguments: {} },
                  { name: 'submit', arguments: {} },
                ],
              },
            },
          ],
        }),
        1,
      ),
    });
    const noTimer = scenario === 'late' || scenario === 'before';
    const work = runRun(
      {
        task: { raw: '工具截止', fed: '工具截止', source: null },
        seed: 0,
        mode: 'script',
        variant: 'base',
        config: null,
        limits: { wallMs: 60000, maxTurns: 4, maxCostCny: 3.5, submitWindow: 1 },
      },
      {
        target,
        store,
        clock: () => state.now,
        signal: external.signal,
        ...(noTimer ? {} : { sleep }),
        countTokens: (s) => s.length,
        versions: {
          target: 'modeling',
          modelingApi: 2,
          modelingDts: 'd',
          modelFormat: 2,
          git: { commit: 'test', dirty: false, diff: null },
          node: '24',
          precheck: 'p',
          sandbox: 's',
        },
        client: {
          complete: async (req, options) => {
            const response = await mock.complete(req, options);
            state.now = scenario === 'before' ? 60000 : 1000;
            if (scenario === 'before-external') external.abort();
            return response;
          },
        },
      },
    );
    if (scenario === 'throws' || scenario === 'timer-error') {
      await assert.rejects(work, scenario === 'throws' ? /工具宿主缺陷/ : /计时器故障/);
    } else {
      const out = await work;
      const successful = scenario === 'ok' || scenario === 'late-timer';
      const reason = successful
        ? null
        : scenario === 'external' || scenario === 'before-external'
          ? 'cancelled'
          : 'wall';
      assert.equal(out.stopReason, reason);
      assert.equal(state.delivered, successful);
      assert.equal(out.delivery !== null, successful);
      if (!successful) {
        assert.equal(existsSync(join(store.dir, 'delivery')), false);
        const trace = deriveTrace(openRunDir(store.dir).events());
        assert.equal(trace.stopReason, reason);
        assert.equal(trace.delivered, false);
      }
    }
    assert.equal(state.calls, scenario === 'before' || scenario === 'before-external' ? 0 : 1);
    assert.equal(state.nextTool, false);
    assert.equal(active.size, 0);
    assert.equal(getEventListeners(external.signal, 'abort').length, 0);
    for (const timer of saved) assert.equal(timer.signal.aborted, true);
    if (scenario === 'late-timer') {
      for (const timer of saved) timer.resolve();
      await Promise.resolve();
      external.abort();
      assert.equal(toolSignal?.aborted, false, '完成后的定时器回调和外部信号不能污染旧工具阶段');
    }
    const events = openRunDir(store.dir).events();
    assert.equal(events.filter((e) => e.type === 'llm.request').length, 1);
    assert.equal(events.filter((e) => e.type === 'llm.response').length, 1);
    assert.equal(events.at(-1)?.type, 'run.end');
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_, i) => i),
    );
    const wall = events.filter((e) => e.type === 'guard' && e.body.name === 'wall' && e.body.action === 'stop');
    assert.equal(wall.length, ['deadline', 'both', 'late', 'before', 'abort-error'].includes(scenario) ? 1 : 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('工具执行中墙钟取消：停止 wall，同轮后续不执行，迟来 submit 不交付', async () => {
  await exercise('deadline');
  await exercise('both');
  await exercise('abort-error');
});
it('外部取消独立记 cancelled；执行前已取消不进工具', async () => {
  await exercise('external');
  await exercise('before-external');
});
it('无 sleep 仍检查执行前/后 clock，截止等值也拒绝交付', async () => {
  await exercise('before');
  await exercise('late');
});
it('正常、异常退出均清理计时器和监听，迟到回调无副作用', async () => {
  await exercise('ok');
  await exercise('throws');
  await exercise('timer-error');
  await exercise('late-timer');
});
