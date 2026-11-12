/**
 * mock.ts（剧本 fetch）的测试（MODEL-SPEC §6.2、§9 mock.test.ts）。
 * 直接调 fetch 看 HTTP 形状；需要拼装结果时在其上跑真 client。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createClient } from './client.ts';
import type { ChatOutcome } from './client.ts';
import {
  createScriptedFetch,
  createVirtualTime,
  MockExhausted,
  MockExpectationFailed,
  scriptedCallId,
} from './mock.ts';
import type { Script, ScriptStep } from './mock.ts';
import { serializeRequest } from './schema.ts';
import type { ChatRequest, Message } from './schema.ts';

const PNG = `data:image/png;base64,${'A'.repeat(300)}`;

function request(messages: Message[] = [], maxTokens = 40_000): ChatRequest {
  return {
    model: 'deepseek-flash',
    messages: [{ role: 'system', content: '系统' }, { role: 'user', content: '造一座塔' }, ...messages],
    tools: [{ type: 'function', function: { name: 'write_code', description: 'd', parameters: { type: 'object' } } }],
    thinking: { type: 'disabled' },
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
}

function script(steps: ScriptStep[]): Script {
  return { name: 'mock-test', task: 't', steps };
}

function post(f: typeof fetch, body: string): Promise<Response> {
  return f('https://mock/chat/completions', { method: 'POST', body });
}

async function complete(steps: ScriptStep[], req: ChatRequest, seed = 1): Promise<ChatOutcome> {
  const vt = createVirtualTime();
  const client = createClient({
    config: { baseUrl: 'https://mock', apiKey: 'k', timeoutMs: 600_000 },
    fetch: createScriptedFetch(script(steps), seed),
    sleep: vt.sleep,
    clock: vt.clock,
  });
  return client.complete(req, {
    signal: new AbortController().signal,
    beforeRetry: () => 'continue',
    onAttempt: () => undefined,
  });
}

const reply = (content: string): ScriptStep => ({ reply: { kind: 'message', content } });

describe('剧本 fetch：请求校验', () => {
  it('请求体不合 ChatRequest → 400（测试即红）', async () => {
    const f = createScriptedFetch(script([reply('x')]), 1);
    const res = await post(f, JSON.stringify({ model: 'gpt-4' }));
    assert.equal(res.status, 400);
  });

  it('请求体不是字符串时 reject', async () => {
    const f = createScriptedFetch(script([reply('x')]), 1);
    await assert.rejects(f('https://mock', { method: 'POST', body: new Uint8Array(1) }), TypeError);
  });

  it('剧本用尽 → MockExhausted', async () => {
    const f = createScriptedFetch(script([reply('x')]), 1);
    await post(f, serializeRequest(request()));
    await assert.rejects(post(f, serializeRequest(request())), MockExhausted);
  });

  it('剧本本身不合 schema 时构造即抛错', () => {
    assert.throws(() => createScriptedFetch({ name: 'x', task: 't', steps: [] }, 1));
  });
});

describe('剧本 fetch：expect', () => {
  const tooled: Message[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_00_a', type: 'function', function: { name: 'write_code', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_00_a', content: '预检通过，128 个方块' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '第 2 轮事实：高 12 格' },
        { type: 'image_url', image_url: { url: PNG } },
      ],
    },
  ];

  it('全部满足时正常回复', async () => {
    const f = createScriptedFetch(
      script([
        {
          expect: { lastUserIncludes: ['高 12 格'], toolIncludes: ['预检通过'], imageBlocks: 1 },
          reply: { kind: 'message', content: 'ok' },
        },
      ]),
      1,
    );
    const res = await post(f, serializeRequest(request(tooled)));
    assert.equal(res.status, 200);
  });

  const cases: [string, NonNullable<ScriptStep['expect']>, RegExp][] = [
    ['lastUserIncludes', { lastUserIncludes: ['高 99 格'] }, /末尾 user 消息应包含 "高 99 格"/],
    ['toolIncludes', { toolIncludes: ['预检失败'] }, /tool 消息（1 条）都不包含/],
    ['imageBlocks', { imageBlocks: 2 }, /应有 2 个图片块，实际 1/],
  ];
  for (const [name, expect, pattern] of cases) {
    it(`${name} 不满足 → MockExpectationFailed 带差异`, async () => {
      const f = createScriptedFetch(script([{ expect, reply: { kind: 'message', content: 'ok' } }]), 1);
      await assert.rejects(post(f, serializeRequest(request(tooled))), (e: unknown) => {
        return e instanceof MockExpectationFailed && pattern.test(e.message) && e.message.includes('第 1 步');
      });
    });
  }

  it('末尾 user 是纯字符串时也能核对；没有图片块时 imageBlocks 为 0', async () => {
    const f = createScriptedFetch(
      script([{ expect: { lastUserIncludes: ['塔'], imageBlocks: 0 }, reply: { kind: 'message', content: 'ok' } }]),
      1,
    );
    assert.equal((await post(f, serializeRequest(request()))).status, 200);
  });
});

describe('剧本 fetch：回复与 usage（A7）', () => {
  it('http-error times 次后进入下一步', async () => {
    const f = createScriptedFetch(script([{ reply: { kind: 'http-error', status: 503, times: 2 } }, reply('ok')]), 1);
    const body = serializeRequest(request());
    assert.equal((await post(f, body)).status, 503);
    assert.equal((await post(f, body)).status, 503);
    assert.equal((await post(f, body)).status, 200);
  });

  it('drop 发出 afterBytes 字节后关闭连接', async () => {
    const f = createScriptedFetch(script([{ reply: { kind: 'drop', afterBytes: 50 } }]), 1);
    const res = await post(f, serializeRequest(request()));
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(bytes.length, 50);
  });

  it('usage 由请求算出：prompt = ceil(文本字节 / 3) + 1024 × 图片，命中按 hitRatio', async () => {
    const req = request([{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }]);
    const out = await complete(
      [{ reply: { kind: 'message', content: 'ok' }, usage: { completion: 7, hitRatio: 0.5 } }],
      req,
    );
    assert.equal(out.kind, 'ok');
    const textBytes = new TextEncoder().encode(serializeRequest(req)).length - PNG.length;
    const prompt = Math.ceil(textBytes / 3) + 1024;
    assert.deepEqual(out.response.usage, {
      prompt_tokens: prompt,
      completion_tokens: 7,
      total_tokens: prompt + 7,
      prompt_cache_hit_tokens: Math.round(prompt * 0.5),
      prompt_cache_miss_tokens: prompt - Math.round(prompt * 0.5),
    });
  });

  it('缺省 hitRatio 0.95，completion = 回复 JSON 字节 ÷ 3', async () => {
    const out = await complete([reply('好')], request());
    assert.equal(out.kind, 'ok');
    const u = out.response.usage;
    assert.equal(u.prompt_cache_hit_tokens, Math.round(u.prompt_tokens * 0.95));
    const replyBytes = new TextEncoder().encode(JSON.stringify({ role: 'assistant', content: '好' })).length;
    assert.equal(u.completion_tokens, Math.ceil(replyBytes / 3));
    assert.equal(out.response.finishReason, 'stop');
  });

  it('completion 压到 max_tokens，finish_reason 变 length', async () => {
    const out = await complete(
      [{ reply: { kind: 'message', content: 'ok' }, usage: { completion: 5000, hitRatio: 1 } }],
      request([], 100),
    );
    assert.equal(out.kind, 'ok');
    assert.equal(out.response.usage.completion_tokens, 100);
    assert.equal(out.response.finishReason, 'length');
  });

  it('同一步多个工具调用一起返回，id 确定且按列出顺序（C15）', async () => {
    const steps: ScriptStep[] = [
      {
        reply: {
          kind: 'message',
          content: null,
          toolCalls: [
            { name: 'write_code', arguments: { code: 'a' } },
            { name: 'check', arguments: {} },
          ],
        },
      },
    ];
    const a = await complete(steps, request(), 1);
    const b = await complete(steps, request(), 2);
    assert.equal(a.kind, 'ok');
    assert.equal(b.kind, 'ok');
    const ids = a.response.message.tool_calls?.map((c) => c.id);
    assert.deepEqual(ids, [scriptedCallId('mock-test', 1, 0), scriptedCallId('mock-test', 1, 1)]);
    assert.deepEqual(
      b.response.message.tool_calls?.map((c) => c.id),
      ids,
      'id 与种子无关',
    );
    assert.deepEqual(
      a.response.message.tool_calls?.map((c) => c.function.name),
      ['write_code', 'check'],
    );
    assert.equal(a.response.finishReason, 'tool_calls');
  });

  it('scriptedCallId 格式 call_<两位>_<24 位 base62>，输入不同结果不同', () => {
    assert.match(scriptedCallId('s', 1, 0), /^call_00_[0-9A-Za-z]{24}$/);
    assert.match(scriptedCallId('s', 1, 12), /^call_12_/);
    assert.notEqual(scriptedCallId('s', 1, 0), scriptedCallId('s', 2, 0));
  });

  it('同剧本同种子字节相同', async () => {
    const body = serializeRequest(request());
    const bytes = async (seed: number): Promise<Uint8Array> =>
      new Uint8Array(
        await (await post(createScriptedFetch(script([reply('中文回复'.repeat(10))]), seed), body)).arrayBuffer(),
      );
    assert.deepEqual(await bytes(5), await bytes(5));
  });
});
