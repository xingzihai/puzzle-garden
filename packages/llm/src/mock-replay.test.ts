/**
 * mock-replay.ts 的测试（MODEL-SPEC §6.4、§9 mock.test.ts 的回放部分）。
 * 先用剧本 fetch 跑真 client 录一份内存里的"原 run"（事件 + blob），再用回放 fetch 重放。
 * 回放源只用 ReplaySource 结构类型，不依赖 @pg/store（批 6 接 RunReader）。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { createClient } from './client.ts';
import type { ChatOutcome, CompleteOptions } from './client.ts';
import {
  createReplayFetch,
  createScriptedFetch,
  createVirtualTime,
  MockExhausted,
  ReplayDiverged,
  ReplayMismatch,
} from './mock.ts';
import type { ReplaySource, ScriptStep } from './mock.ts';
import { serializeRequest } from './schema.ts';
import type { ChatRequest } from './schema.ts';

const enc = new TextEncoder();

function request(user = '造一座塔'): ChatRequest {
  return {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: '系统' },
      { role: 'user', content: user },
    ],
    tools: [{ type: 'function', function: { name: 'write_code', description: 'd', parameters: { type: 'object' } } }],
    thinking: { type: 'disabled' },
    max_tokens: 40_000,
    stream: true,
    stream_options: { include_usage: true },
  };
}

interface Recorded {
  readonly source: ReplaySource & { events(): { seq: number; type: string; body: unknown }[] };
  readonly outcomes: ChatOutcome[];
}

/** 内存版 run 目录：与 store 的事件形状一致的最小子集。 */
function memorySource(): {
  source: Recorded['source'];
  append: (type: string, body: unknown) => number;
  put: (value: unknown) => { sha256: string; bytes: number };
} {
  const events: { seq: number; type: string; body: unknown }[] = [];
  const blobs = new Map<string, Uint8Array>();
  const requests = new Map<number, Uint8Array>();
  const put = (value: unknown): { sha256: string; bytes: number } => {
    const bytes = enc.encode(JSON.stringify(value));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    blobs.set(sha256, bytes);
    return { sha256, bytes: bytes.length };
  };
  return {
    source: {
      events: () => events,
      blob: (sha) => {
        const b = blobs.get(sha);
        if (b === undefined) throw new Error(`blob ${sha} 不存在`);
        return b;
      },
      request: (seq) => {
        const b = requests.get(seq);
        if (b === undefined) throw new Error(`seq ${String(seq)} 不是 llm.request`);
        return b;
      },
    },
    append: (type, body) => {
      const seq = events.length;
      events.push({ seq, type, body });
      if (type === 'llm.request') requests.set(seq, (body as { raw: Uint8Array }).raw);
      return seq;
    },
    put,
  };
}

function makeClient(f: typeof fetch, vt = createVirtualTime()) {
  return createClient({
    config: { baseUrl: 'https://mock', apiKey: 'k', timeoutMs: 600_000 },
    fetch: f,
    sleep: vt.sleep,
    clock: vt.clock,
  });
}

function abortAfter(chars: number): Pick<CompleteOptions, 'onDelta'> {
  let seen = 0;
  return {
    onDelta: (d) => {
      seen += d.text.length;
      return seen >= chars ? 'abort' : 'continue';
    },
  };
}

/** 跑一组请求并按 runner 的方式写 llm.request / llm.attempt / llm.response。 */
async function record(
  steps: ScriptStep[],
  requests: readonly ChatRequest[],
  extra: (i: number) => Partial<CompleteOptions> = () => ({}),
): Promise<Recorded> {
  const mem = memorySource();
  const client = makeClient(createScriptedFetch({ name: 'rec', task: 't', steps }, 3));
  const outcomes: ChatOutcome[] = [];
  for (const [i, req] of requests.entries()) {
    const raw = enc.encode(serializeRequest(req));
    mem.append('llm.request', { requestSha: createHash('sha256').update(raw).digest('hex'), raw });
    const out = await client.complete(req, {
      signal: new AbortController().signal,
      beforeRetry: () => 'continue',
      onAttempt: (a) => mem.append('llm.attempt', { ...a, settledCny: 0 }),
      ...extra(i),
    });
    if (out.kind === 'ok') mem.append('llm.response', { outcome: 'ok', response: mem.put(out.response) });
    if (out.kind === 'aborted-by-caller') {
      mem.append('llm.response', {
        outcome: 'aborted-by-caller',
        reason: 'degenerate',
        partial: mem.put(out.partial),
        settledCny: 0,
      });
    }
    outcomes.push(out);
  }
  return { source: mem.source, outcomes };
}

const msg = (content: string): ScriptStep => ({ reply: { kind: 'message', content } });

describe('回放 fetch（strict）', () => {
  it('成功、HTTP 重试、断流重试、tool_calls 都按原样重放，结果与原 run 相同', async () => {
    const steps: ScriptStep[] = [
      { reply: { kind: 'http-error', status: 429, times: 1 } },
      { reply: { kind: 'drop', afterBytes: 80 } },
      {
        reply: { kind: 'message', content: null, toolCalls: [{ name: 'write_code', arguments: { code: '中文代码' } }] },
      },
      msg('第二个请求的回复'),
    ];
    const reqs = [request(), request('第 2 轮')];
    const rec = await record(steps, reqs);
    const attemptsOriginal = rec.source
      .events()
      .filter((e) => e.type === 'llm.attempt')
      .map((e) => e.body as { outcome: string; charge: string });

    const vt = createVirtualTime();
    const client = makeClient(createReplayFetch(rec.source, 99, { sleep: vt.sleep }), vt);
    const replayed: unknown[] = [];
    for (const [i, req] of reqs.entries()) {
      const out = await client.complete(req, {
        signal: new AbortController().signal,
        beforeRetry: () => 'continue',
        onAttempt: (a) => replayed.push({ outcome: a.outcome, charge: a.charge }),
      });
      const original = rec.outcomes[i];
      assert.equal(out.kind, 'ok');
      assert.equal(original?.kind, 'ok');
      assert.deepEqual(out.response.message, original.response.message);
      assert.deepEqual(out.response.usage, original.response.usage);
    }
    assert.deepEqual(
      replayed,
      attemptsOriginal.map((a) => ({ outcome: a.outcome, charge: a.charge })),
    );
  });

  it('请求体不一致 → ReplayMismatch，报告第一处差异的消息下标与角色', async () => {
    const rec = await record([msg('a')], [request()]);
    const vt = createVirtualTime();
    const client = makeClient(createReplayFetch(rec.source, 1, { sleep: vt.sleep }), vt);
    await assert.rejects(
      client.complete(request('改过的需求'), {
        signal: new AbortController().signal,
        beforeRetry: () => 'continue',
        onAttempt: () => undefined,
      }),
      (e: unknown) =>
        e instanceof ReplayMismatch && /第 1 条消息不同：原 user .*造一座塔.*现 user .*改过的需求/.test(e.message),
    );
  });

  it('只有参数不同（max_tokens）时报告参数差异', async () => {
    const rec = await record([msg('a')], [request()]);
    const vt = createVirtualTime();
    const client = makeClient(createReplayFetch(rec.source, 1, { sleep: vt.sleep }), vt);
    await assert.rejects(
      client.complete(
        { ...request(), max_tokens: 5000 },
        { signal: new AbortController().signal, beforeRetry: () => 'continue', onAttempt: () => undefined },
      ),
      (e: unknown) => e instanceof ReplayMismatch && e.message.includes('参数不同'),
    );
  });

  it('尝试用尽仍有请求 → MockExhausted', async () => {
    const rec = await record([msg('a')], [request()]);
    const vt = createVirtualTime();
    const client = makeClient(createReplayFetch(rec.source, 1, { sleep: vt.sleep }), vt);
    const opts = {
      signal: new AbortController().signal,
      beforeRetry: () => 'continue' as const,
      onAttempt: () => undefined,
    };
    assert.equal((await client.complete(request(), opts)).kind, 'ok');
    await assert.rejects(client.complete(request(), opts), MockExhausted);
  });

  it('退化取消：同一检测器在同一位置再次触发，partial 相同', async () => {
    const rec = await record([msg('重复的片段。'.repeat(20))], [request()], () => abortAfter(30));
    const original = rec.outcomes[0];
    assert.equal(original?.kind, 'aborted-by-caller');
    const vt = createVirtualTime();
    const client = makeClient(createReplayFetch(rec.source, 1, { sleep: vt.sleep }), vt);
    const out = await client.complete(request(), {
      signal: new AbortController().signal,
      beforeRetry: () => 'continue',
      onAttempt: () => undefined,
      ...abortAfter(30),
    });
    assert.equal(out.kind, 'aborted-by-caller');
    assert.equal(out.partial.content, original.partial.content);
  });

  it('退化取消：检测规则变了、5 s 内没有再次取消 → ReplayDiverged', async () => {
    const rec = await record([msg('重复的片段。'.repeat(20))], [request()], () => abortAfter(30));
    const vt = createVirtualTime();
    const client = makeClient(createReplayFetch(rec.source, 1, { sleep: vt.sleep }), vt);
    await assert.rejects(
      client.complete(request(), {
        signal: new AbortController().signal,
        beforeRetry: () => 'continue',
        onAttempt: () => undefined,
      }),
      ReplayDiverged,
    );
    assert.equal(vt.clock(), 5_000);
  });

  it('其他失败类别（空闲超时、no-usage、truncated、连接失败）也能重放', async () => {
    const mem = memorySource();
    const req = request();
    const raw = enc.encode(serializeRequest(req));
    mem.append('llm.request', { requestSha: createHash('sha256').update(raw).digest('hex'), raw });
    const usage = {
      prompt_tokens: 5,
      completion_tokens: 1,
      total_tokens: 6,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 5,
    };
    const attempt = (failure: unknown, charge: string, extra: object = {}) =>
      mem.append('llm.attempt', {
        attempt: 1,
        outcome: 'retry',
        failure,
        charge,
        usage: null,
        delayMs: 1,
        timing: { firstByteMs: null, totalMs: 0 },
        ...extra,
      });
    const f = (cls: string, code: string, retriable = true) => ({
      class: cls,
      code,
      status: null,
      retriable,
      message: 'm',
    });
    attempt(f('transport', 'network'), 'none');
    attempt(f('transport', 'timeout'), 'none');
    attempt(f('transport', 'idle-timeout'), 'reserve');
    attempt(f('truncated', 'aborted'), 'usage', { usage });
    // 第 4 次尝试：用尽次数
    attempt(f('truncated', 'aborted'), 'usage', { usage, outcome: 'final-failure' });

    const vt = createVirtualTime();
    const client = createClient({
      config: { baseUrl: 'https://mock', apiKey: 'k', timeoutMs: 600_000 },
      fetch: createReplayFetch(mem.source, 1, { sleep: vt.sleep }),
      sleep: vt.sleep,
      clock: vt.clock,
    });
    const codes: string[] = [];
    const out = await client.complete(req, {
      signal: new AbortController().signal,
      beforeRetry: () => 'continue',
      onAttempt: (a) => codes.push(`${a.failure?.code ?? 'ok'}/${a.charge}`),
    });
    assert.equal(out.kind, 'failed');
    assert.deepEqual(codes, ['network/none', 'timeout/none', 'idle-timeout/reserve', 'aborted/usage']);
    assert.equal(out.failure.code, 'aborted');
    assert.equal(
      vt.clock(),
      1_000 + 600_000 + 2_000 + 180_000 + 4_000,
      '响应头之前只受总超时约束，空闲计时从 200 开始',
    );
  });

  for (const code of ['no-usage', 'invalid-response'] as const) {
    it(`invalid-response/${code} 重放为同类失败，不重试`, async () => {
      const mem = memorySource();
      const req = request();
      const raw = enc.encode(serializeRequest(req));
      mem.append('llm.request', { requestSha: createHash('sha256').update(raw).digest('hex'), raw });
      mem.append('llm.attempt', {
        attempt: 1,
        outcome: 'final-failure',
        failure: { class: 'invalid-response', code, status: null, retriable: false, message: 'm' },
        charge: 'reserve',
        usage: null,
      });
      const vt = createVirtualTime();
      const client = makeClient(createReplayFetch(mem.source, 1, { sleep: vt.sleep }), vt);
      const out = await client.complete(req, {
        signal: new AbortController().signal,
        beforeRetry: () => 'continue',
        onAttempt: () => undefined,
      });
      assert.equal(out.kind, 'failed');
      assert.equal(out.failure.code, code);
    });
  }
});

describe('回放源校验', () => {
  it('llm.attempt 之前没有 llm.request、成功尝试缺 llm.response 时报错', async () => {
    const mem = memorySource();
    mem.append('llm.attempt', { attempt: 1, outcome: 'ok', failure: null, charge: 'usage', usage: null });
    assert.throws(() => createReplayFetch(mem.source, 1, { sleep: createVirtualTime().sleep }), /之前没有 llm.request/);

    const mem2 = memorySource();
    mem2.append('llm.response', { outcome: 'ok', response: { sha256: 'x' } });
    assert.throws(
      () => createReplayFetch(mem2.source, 1, { sleep: createVirtualTime().sleep }),
      /之前没有 llm.attempt/,
    );

    const mem3 = memorySource();
    const req = request();
    const raw = enc.encode(serializeRequest(req));
    mem3.append('llm.request', { requestSha: createHash('sha256').update(raw).digest('hex'), raw });
    mem3.append('llm.attempt', { attempt: 1, outcome: 'ok', failure: null, charge: 'usage', usage: null });
    const vt = createVirtualTime();
    const client = makeClient(createReplayFetch(mem3.source, 1, { sleep: vt.sleep }), vt);
    await assert.rejects(
      client.complete(req, {
        signal: new AbortController().signal,
        beforeRetry: () => 'continue',
        onAttempt: () => undefined,
      }),
      /缺少 llm.response/,
    );
  });
});
