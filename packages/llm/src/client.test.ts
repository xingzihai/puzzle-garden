/**
 * client.ts 的测试（MODEL-SPEC §9 client.test.ts）：在 fetch 层跑真 client。
 * 时间全部用 createVirtualTime：退避、总超时、空闲超时都靠拨虚拟时钟，不真实等待。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { createClient, IDLE_TIMEOUT_MS, MAX_ATTEMPTS } from './client.ts';
import type { AttemptRecord, ChatClient, CompleteOptions, RetryInfo } from './client.ts';
import { isLlmError } from './errors.ts';
import { createScriptedFetch, createVirtualTime, MockExhausted } from './mock.ts';
import type { Script, ScriptStep, VirtualTime } from './mock.ts';
import type { ChatRequest, Delta } from './schema.ts';

const API_KEY = 'sk-test-0123456789abcdefSECRET';

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: '系统' },
      { role: 'user', content: '造一座塔' },
    ],
    tools: [
      { type: 'function', function: { name: 'write_code', description: '写代码', parameters: { type: 'object' } } },
    ],
    thinking: { type: 'disabled' },
    max_tokens: 40_000,
    stream: true,
    stream_options: { include_usage: true },
    ...overrides,
  };
}

interface Harness {
  readonly client: ChatClient;
  readonly vt: VirtualTime;
  readonly attempts: AttemptRecord[];
  readonly retries: RetryInfo[];
  readonly deltas: Delta[];
  readonly urls: string[];
  readonly headers: Headers[];
  opts(extra?: Partial<CompleteOptions>): CompleteOptions;
}

function harness(fetchImpl: (vt: VirtualTime) => typeof fetch, timeoutMs = 600_000): Harness {
  const vt = createVirtualTime();
  const inner = fetchImpl(vt);
  const urls: string[] = [];
  const headers: Headers[] = [];
  const recordingFetch: typeof fetch = (input, init) => {
    urls.push(input instanceof Request ? input.url : input.toString());
    headers.push(new Headers(init?.headers));
    return inner(input, init);
  };
  const client = createClient({
    config: { baseUrl: 'https://api.example.test/', apiKey: API_KEY, timeoutMs },
    fetch: recordingFetch,
    sleep: vt.sleep,
    clock: vt.clock,
  });
  const attempts: AttemptRecord[] = [];
  const retries: RetryInfo[] = [];
  const deltas: Delta[] = [];
  return {
    client,
    vt,
    attempts,
    retries,
    deltas,
    urls,
    headers,
    opts: (extra = {}) => ({
      signal: new AbortController().signal,
      onDelta: (d) => {
        deltas.push(d);
        return 'continue';
      },
      beforeRetry: (r) => {
        retries.push(r);
        return 'continue';
      },
      onAttempt: (a) => attempts.push(a),
      ...extra,
    }),
  };
}

function scripted(steps: ScriptStep[], seed = 7): (vt: VirtualTime) => typeof fetch {
  const script: Script = { name: 'client-test', task: 't', steps };
  return () => createScriptedFetch(script, seed);
}

const hello: ScriptStep = { reply: { kind: 'message', content: '好的，开始建塔。' } };

it('GPT 可读取无DeepSeek缓存字段的原始SSE；同流用于DeepSeek必须拒绝计费', async () => {
  const raw =
    'data: {"id":"sol","model":"gpt-6.1-sol","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
    'data: {"id":"sol","model":"gpt-6.1-sol","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n' +
    'data: [DONE]\n\n';
  const sol = request();
  const h = harness(() => rawFetch([raw]));
  const result = await h.client.complete(
    { ...sol, model: 'gpt-6.1-sol', thinking: undefined, max_tokens: undefined, reasoning_effort: 'none' },
    h.opts(),
  );
  assert.equal(result.kind, 'ok');
  assert.equal(result.response.usage.prompt_cache_hit_tokens, undefined);
  const ds = harness(() => rawFetch([raw]));
  const failed = await ds.client.complete(sol, ds.opts());
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.failure.code, 'no-cache-usage');
});

/** 把整段文本（或字节）作为 200 SSE 响应逐块交出的 fetch。 */
function rawFetch(chunks: readonly (string | Uint8Array)[]): typeof fetch {
  const enc = new TextEncoder();
  return () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
}

describe('createClient 构造', () => {
  it('apiKey 为空时抛错并提示变量名', () => {
    const vt = createVirtualTime();
    assert.throws(
      () =>
        createClient({
          config: { baseUrl: 'x', apiKey: '', timeoutMs: 1 },
          fetch: rawFetch([]),
          sleep: vt.sleep,
          clock: vt.clock,
        }),
      /PG_LLM_API_KEY 未设置/,
    );
  });
});

describe('成功路径', () => {
  it('官方流式样例逐字解析；URL、鉴权头与请求体正确', async () => {
    const raw = readFileSync(new URL('../fixtures/official/stream.txt', import.meta.url));
    const h = harness(() => rawFetch([raw]));
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'ok');
    assert.equal(out.response.message.content, 'Hello! How can I assist you today?');
    assert.partialDeepStrictEqual(out.response.usage, { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26 });
    assert.deepEqual(h.urls, ['https://api.example.test/chat/completions']);
    assert.equal(h.headers[0]?.get('authorization'), `Bearer ${API_KEY}`);
    assert.equal(h.attempts.length, 1);
    assert.partialDeepStrictEqual(h.attempts[0], { attempt: 1, outcome: 'ok', charge: 'usage', failure: null });
  });

  it('tool_calls 分片拼装，id 形如 call_00_…，onDelta 收到 arguments 片段', async () => {
    const args = { code: '塔身用石砖，屋顶用深色木板。'.repeat(8) };
    const h = harness(
      scripted([
        {
          reply: {
            kind: 'message',
            content: null,
            toolCalls: [
              { name: 'write_code', arguments: args },
              { name: 'check', arguments: {} },
            ],
          },
        },
      ]),
    );
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'ok');
    const calls = out.response.message.tool_calls ?? [];
    assert.equal(calls.length, 2);
    assert.match(calls[0]?.id ?? '', /^call_00_[0-9A-Za-z]{24}$/);
    assert.match(calls[1]?.id ?? '', /^call_01_[0-9A-Za-z]{24}$/);
    assert.deepEqual(JSON.parse(calls[0]?.function.arguments ?? ''), args);
    assert.equal(out.response.message.content, null);
    assert.equal(out.response.finishReason, 'tool_calls');
    const fragments = h.deltas.filter((d) => d.kind === 'arguments' && d.index === 0);
    assert.ok(fragments.length > 1, '参数应被切成多个片段');
    assert.equal(fragments.map((d) => d.text).join(''), JSON.stringify(args));
  });

  it('JSON-only content 请求：reasoning / content 增量都转发，正文与 reasoning 分开保存', async () => {
    const raw =
      'data: {"id":"json","model":"deepseek-flash","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"先核对字段。"},"finish_reason":null}]}\n\n' +
      'data: {"id":"json","model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"{\\"meta\\":{\\"title\\":\\"亭\\"}}"},"finish_reason":null}]}\n\n' +
      'data: {"id":"json","model":"deepseek-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":10}}\n\n' +
      'data: [DONE]\n\n';
    const h = harness(() => rawFetch([raw]));
    const out = await h.client.complete(
      { ...request(), tools: [], response_format: { type: 'json_object' } },
      h.opts(),
    );
    assert.equal(out.kind, 'ok');
    assert.equal(out.response.message.reasoning_content, '先核对字段。');
    assert.equal(out.response.message.content, '{"meta":{"title":"亭"}}');
    assert.equal(out.response.message.tool_calls, undefined);
    assert.deepEqual(
      h.deltas.map((delta) => delta.kind),
      ['reasoning', 'content'],
    );
  });

  it('UTF-8 多字节字符切在网络块中间也能正确拼装', async () => {
    const text = '中文内容：塔高十二格，窗户朝南。';
    const enc = new TextEncoder();
    const body = enc.encode(
      `data: {"id":"a","model":"deepseek-flash","choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"prompt_cache_hit_tokens":1,"prompt_cache_miss_tokens":2}}\n\ndata: [DONE]\n\n`,
    );
    const lead = body.findIndex((b) => b >= 0xc0);
    const h = harness(() =>
      rawFetch([body.subarray(0, lead + 1), body.subarray(lead + 1, lead + 2), body.subarray(lead + 2)]),
    );
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'ok');
    assert.equal(out.response.message.content, text);
  });

  it('length 截断：非法参数替换为 "{}"，原文进 rawArguments，仍返回 ok', async () => {
    const h = harness(
      scripted([
        {
          reply: {
            kind: 'message',
            content: null,
            toolCalls: [{ name: 'write_code', arguments: {} }],
            rawArguments: '{"code":"截断的',
            finishReason: 'length',
          },
        },
      ]),
    );
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'ok');
    assert.equal(out.response.finishReason, 'length');
    assert.equal(out.response.message.tool_calls?.[0]?.function.arguments, '{}');
    assert.deepEqual(out.response.rawArguments, [{ index: 0, text: '{"code":"截断的' }]);
  });
});

describe('重试与结算类别（C4）', () => {
  it('429 → 退避 5 s 后成功，失败那次记 ¥0（charge none）', async () => {
    const h = harness(scripted([{ reply: { kind: 'http-error', status: 429, times: 1 } }, hello]));
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'ok');
    assert.deepEqual(
      h.attempts.map((a) => [a.outcome, a.charge, a.delayMs, a.failure?.code ?? null]),
      [
        ['retry', 'none', 5_000, 'http_429'],
        ['ok', 'usage', null, null],
      ],
    );
    assert.equal(h.vt.clock(), 5_000);
  });

  it('429 连续三次：退避 5 / 15 / 45 s', async () => {
    const h = harness(scripted([{ reply: { kind: 'http-error', status: 429, times: 3 } }, hello]));
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'ok');
    assert.deepEqual(
      h.retries.map((r) => [r.attempt, r.delayMs]),
      [
        [2, 5_000],
        [3, 15_000],
        [4, 45_000],
      ],
    );
  });

  it('503 三次后第 4 次成功：退避 1 / 2 / 4 s，共 4 次尝试', async () => {
    const h = harness(scripted([{ reply: { kind: 'http-error', status: 503, times: 3 } }, hello]));
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'ok');
    assert.equal(h.attempts.length, MAX_ATTEMPTS);
    assert.deepEqual(
      h.attempts.map((a) => a.delayMs),
      [1_000, 2_000, 4_000, null],
    );
    assert.equal(h.vt.clock(), 7_000);
  });

  it('500 四次用尽：final-failure，http_5xx', async () => {
    const h = harness(scripted([{ reply: { kind: 'http-error', status: 500, times: 4 } }]));
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'failed');
    assert.equal(out.failure.code, 'http_5xx');
    assert.deepEqual(
      h.attempts.map((a) => a.outcome),
      ['retry', 'retry', 'retry', 'final-failure'],
    );
    assert.ok(h.attempts.every((a) => a.charge === 'none'));
  });

  for (const status of [400, 401, 402, 422]) {
    it(`${String(status)} 不重试，报错不含密钥`, async () => {
      const h = harness(scripted([{ reply: { kind: 'http-error', status, times: 1 } }]));
      const out = await h.client.complete(request(), h.opts());
      assert.equal(out.kind, 'failed');
      assert.equal(out.failure.status, status);
      assert.equal(out.failure.retriable, false);
      assert.equal(h.attempts.length, 1);
      assert.partialDeepStrictEqual(h.attempts[0], { outcome: 'final-failure', charge: 'none' });
      assert.ok(!JSON.stringify([out, h.attempts]).includes(API_KEY));
    });
  }

  it('200 后断流 → transport/network，重试，断流那次按预留全额记', async () => {
    const h = harness(scripted([{ reply: { kind: 'drop', afterBytes: 120 } }, hello]));
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'ok');
    assert.deepEqual(
      h.attempts.map((a) => [a.outcome, a.charge, a.failure?.class ?? null, a.failure?.code ?? null]),
      [
        ['retry', 'reserve', 'transport', 'network'],
        ['ok', 'usage', null, null],
      ],
    );
    assert.equal(h.attempts[0]?.delayMs, 1_000);
  });

  it('[DONE] 前没有 usage → invalid-response/no-usage，不重试，记预留全额', async () => {
    const h = harness(() =>
      rawFetch([
        'data: {"id":"a","model":"m","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'failed');
    assert.equal(out.failure.code, 'no-usage');
    assert.deepEqual(
      h.attempts.map((a) => [a.outcome, a.charge]),
      [['final-failure', 'reserve']],
    );
  });

  it('非法 UTF-8 → invalid-response，不重试', async () => {
    const h = harness(() => rawFetch([new Uint8Array([0x64, 0x61, 0xff, 0x0a])]));
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'failed');
    assert.equal(out.failure.class, 'invalid-response');
    assert.equal(h.attempts.length, 1);
  });

  it('finish_reason insufficient_system_resource → truncated，按 usage 结算并重试', async () => {
    const h = harness(
      scripted([{ reply: { kind: 'message', content: '半截', finishReason: 'insufficient_system_resource' } }, hello]),
    );
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'ok');
    const first = h.attempts[0];
    assert.ok(first !== undefined);
    assert.equal(first.failure?.class, 'truncated');
    assert.equal(first.charge, 'usage');
    assert.ok(first.usage !== null);
  });

  it('连接失败（fetch 抛 TypeError）→ transport/network，记 ¥0 并重试', async () => {
    let calls = 0;
    const inner = scripted([hello]);
    const h = harness((vt) => (input, init) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new TypeError(`connect ECONNREFUSED ${API_KEY}`));
      return inner(vt)(input, init);
    });
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'ok');
    assert.partialDeepStrictEqual(h.attempts[0], { outcome: 'retry', charge: 'none' });
    const first = h.attempts[0];
    assert.ok(first?.failure);
    assert.equal(first.failure.code, 'network');
    assert.ok(!first.failure.message.includes(API_KEY), '报错里不能出现密钥');
  });

  it('beforeRetry 返回 stop：不再重试，outcome stopped-by-guard，返回 failed', async () => {
    const h = harness(scripted([{ reply: { kind: 'http-error', status: 503, times: 1 } }, hello]));
    const out = await h.client.complete(request(), h.opts({ beforeRetry: () => 'stop' }));
    assert.equal(out.kind, 'failed');
    assert.equal(out.failure.code, 'http_5xx');
    assert.deepEqual(
      h.attempts.map((a) => [a.outcome, a.charge, a.delayMs]),
      [['stopped-by-guard', 'none', null]],
    );
    assert.equal(h.vt.clock(), 0, '没有退避等待');
  });
});

describe('超时', () => {
  it('挂起的流：180 s 空闲超时 → idle-timeout，记预留全额并重试', async () => {
    const h = harness(scripted([{ reply: { kind: 'stall', afterBytes: 60 } }, hello]));
    const out = await h.client.complete(request(), h.opts());
    assert.equal(out.kind, 'ok');
    assert.partialDeepStrictEqual(h.attempts[0], { outcome: 'retry', charge: 'reserve' });
    const first = h.attempts[0];
    assert.ok(first !== undefined);
    assert.equal(first.failure?.code, 'idle-timeout');
    assert.equal(first.timing.totalMs, IDLE_TIMEOUT_MS);
  });

  it('keep-alive 不算空闲：每 100 s 一行注释，直到总超时才中止', async () => {
    const enc = new TextEncoder();
    const h = harness(
      (vt) => (_input, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  await vt.sleep(100_000, init?.signal ?? new AbortController().signal);
                  controller.enqueue(enc.encode(': keep-alive\n\n'));
                } catch (error) {
                  controller.error(error);
                }
              },
            }),
            { status: 200 },
          ),
        ),
      450_000,
    );
    const out = await h.client.complete(request(), h.opts({ beforeRetry: () => 'stop' }));
    assert.equal(out.kind, 'failed');
    assert.equal(out.failure.code, 'timeout');
    assert.partialDeepStrictEqual(h.attempts[0], { outcome: 'stopped-by-guard', charge: 'reserve' });
    assert.equal(h.attempts[0]?.timing.totalMs, 450_000);
  });

  it('响应头之前总超时 → transport/timeout，记 ¥0', async () => {
    const h = harness(
      () => (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
      30_000,
    );
    const out = await h.client.complete(request(), h.opts({ beforeRetry: () => 'stop' }));
    assert.equal(out.kind, 'failed');
    assert.equal(out.failure.code, 'timeout');
    assert.partialDeepStrictEqual(h.attempts[0], { charge: 'none', timing: { firstByteMs: null, totalMs: 30_000 } });
  });

  it('成功返回后计时器全部清掉', async () => {
    const h = harness(scripted([hello]));
    await h.client.complete(request(), h.opts());
    await new Promise((r) => setImmediate(r));
    assert.equal(h.vt.pending(), 0);
  });
});

describe('取消', () => {
  it('调用方 signal 在读流中取消 → cancelled，不重试，记预留全额', async () => {
    const controller = new AbortController();
    const h = harness(scripted([{ reply: { kind: 'stall', afterBytes: 60 } }, hello]));
    const pending = h.client.complete(request(), h.opts({ signal: controller.signal }));
    await h.vt.sleep(10_000, new AbortController().signal);
    controller.abort();
    const out = await pending;
    assert.equal(out.kind, 'failed');
    assert.equal(out.failure.class, 'cancelled');
    assert.deepEqual(
      h.attempts.map((a) => [a.outcome, a.charge]),
      [['final-failure', 'reserve']],
    );
  });

  it('退避等待中取消 → failed cancelled，不发下一次请求', async () => {
    const controller = new AbortController();
    const h = harness(scripted([{ reply: { kind: 'http-error', status: 429, times: 1 } }, hello]));
    const out = await h.client.complete(
      request(),
      h.opts({
        signal: controller.signal,
        beforeRetry: () => {
          queueMicrotask(() => {
            controller.abort();
          });
          return 'continue';
        },
      }),
    );
    assert.equal(out.kind, 'failed');
    assert.equal(out.failure.code, 'cancelled');
    assert.equal(h.urls.length, 1);
  });

  it('signal 已取消：不发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness(scripted([hello]));
    const out = await h.client.complete(request(), h.opts({ signal: controller.signal }));
    assert.equal(out.kind, 'failed');
    assert.equal(out.failure.code, 'cancelled');
    assert.equal(h.urls.length, 0);
  });

  it("onDelta 返回 'abort' → aborted-by-caller，partial 含已拼内容，记预留全额", async () => {
    const h = harness(scripted([{ reply: { kind: 'message', content: '重复重复重复重复重复重复重复重复重复' } }]));
    let seen = '';
    const out = await h.client.complete(
      request(),
      h.opts({
        onDelta: (d) => {
          seen += d.text;
          return seen.length >= 6 ? 'abort' : 'continue';
        },
      }),
    );
    assert.equal(out.kind, 'aborted-by-caller');
    assert.equal(out.partial.content, seen);
    assert.ok(out.partial.timing.firstByteMs !== null);
    assert.deepEqual(
      h.attempts.map((a) => [a.outcome, a.charge]),
      [['aborted-by-caller', 'reserve']],
    );
  });
});

describe('发送前校验与并发', () => {
  it('请求不合 ChatRequest 抛 LlmError，不发请求', async () => {
    const h = harness(scripted([hello]));
    await assert.rejects(
      h.client.complete(request({ max_tokens: 0 }), h.opts()),
      (e: unknown) => isLlmError(e) && e.failure.code === 'internal-invalid-request',
    );
    assert.equal(h.urls.length, 0);
  });

  const call = { id: 'call_00_a', type: 'function' as const, function: { name: 'check', arguments: '{}' } };
  const bad: [string, ChatRequest['messages']][] = [
    [
      'tool 之间插 user',
      [
        { role: 'user', content: 'u' },
        { role: 'assistant', content: null, tool_calls: [call, { ...call, id: 'call_01_b' }] },
        { role: 'tool', tool_call_id: 'call_00_a', content: 'r' },
        { role: 'user', content: 'u2' },
      ],
    ],
    [
      'tool_call_id 不对应',
      [
        { role: 'user', content: 'u' },
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: 'call_xx', content: 'r' },
      ],
    ],
    [
      '末尾缺 tool 结果',
      [
        { role: 'user', content: 'u' },
        { role: 'assistant', content: null, tool_calls: [call] },
      ],
    ],
    [
      'tool_call id 重复',
      [
        { role: 'user', content: 'u' },
        { role: 'assistant', content: null, tool_calls: [call, call] },
        { role: 'tool', tool_call_id: 'call_00_a', content: 'r' },
      ],
    ],
  ];
  for (const [name, messages] of bad) {
    it(`消息序：${name} → internal-message-order，不发请求`, async () => {
      const h = harness(scripted([hello]));
      await assert.rejects(
        h.client.complete(request({ messages }), h.opts()),
        (e: unknown) => isLlmError(e) && e.failure.code === 'internal-message-order',
      );
      assert.equal(h.urls.length, 0);
    });
  }

  it('消息序合法（tool 齐全后接 user）可以发送', async () => {
    const h = harness(scripted([hello]));
    const out = await h.client.complete(
      request({
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'u' },
          { role: 'assistant', content: null, tool_calls: [call] },
          { role: 'tool', tool_call_id: 'call_00_a', content: 'r' },
          { role: 'user', content: '事实行' },
        ],
      }),
      h.opts(),
    );
    assert.equal(out.kind, 'ok');
  });

  it('并发调用直接拒绝；上一次结束后可以再调', async () => {
    const h = harness(scripted([hello, hello]));
    const first = h.client.complete(request(), h.opts());
    await assert.rejects(h.client.complete(request(), h.opts()), /不支持并发/);
    assert.equal((await first).kind, 'ok');
    assert.equal((await h.client.complete(request(), h.opts())).kind, 'ok');
  });

  it('mock 抛出的非网络错误（剧本用尽）原样抛出，不被当成可重试', async () => {
    const h = harness(scripted([hello]));
    await h.client.complete(request(), h.opts());
    await assert.rejects(h.client.complete(request(), h.opts()), MockExhausted);
  });
});
