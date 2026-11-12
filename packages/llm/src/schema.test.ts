/**
 * schema.ts 的测试（MODEL-SPEC §9）。
 * 覆盖：合法 / 非法请求、serializeRequest 的字段顺序与跨对象顺序的确定性、官方非流式样例的 Usage 解析。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { ChatRequest, Message, Usage, serializeRequest } from './schema.ts';
import type { ChatRequest as ChatRequestType } from './schema.ts';

const VALID = {
  model: 'deepseek-flash',
  messages: [
    { role: 'system', content: '你是建造助手。' },
    { role: 'user', content: '造一个亭子。' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'write_code',
        description: '整份写入当前稿',
        parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      },
    },
  ],
  thinking: { type: 'disabled' },
  max_tokens: 40000,
  stream: true,
  stream_options: { include_usage: true },
} as const;

function parseObject(text: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}

describe('ChatRequest', () => {
  it('合法请求通过', () => {
    assert.equal(ChatRequest.safeParse(VALID).success, true);
  });

  it('拒绝多余字段（strictObject）', () => {
    assert.equal(ChatRequest.safeParse({ ...VALID, temperature: 0.2 }).success, false);
  });

  it('拒绝非 flash 的 model', () => {
    assert.equal(ChatRequest.safeParse({ ...VALID, model: 'deepseek-v4-pro' }).success, false);
  });

  it('拒绝超过 12 个工具；0 个工具只允许 JSON-only content 模式', () => {
    const many = Array.from({ length: 13 }, () => VALID.tools[0]);
    assert.equal(ChatRequest.safeParse({ ...VALID, tools: many }).success, false);
    assert.equal(ChatRequest.safeParse({ ...VALID, tools: [] }).success, false);
    assert.equal(
      ChatRequest.safeParse({ ...VALID, tools: [], response_format: { type: 'json_object' } }).success,
      true,
    );
    assert.equal(ChatRequest.safeParse({ ...VALID, tools: [], response_format: { type: 'text' } }).success, false);
  });

  it('拒绝带 $schema 键的工具参数（C19）', () => {
    const tool = {
      ...VALID.tools[0],
      function: { ...VALID.tools[0].function, parameters: { $schema: 'x', type: 'object' } },
    };
    assert.equal(ChatRequest.safeParse({ ...VALID, tools: [tool] }).success, false);
  });

  it('拒绝少于 2 条消息', () => {
    assert.equal(ChatRequest.safeParse({ ...VALID, messages: [VALID.messages[1]] }).success, false);
  });

  it('user 消息的图片块必须是 PNG data URL；文本块数组至少 1 个', () => {
    const image = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] };
    assert.equal(Message.safeParse(image).success, true);
    assert.equal(
      Message.safeParse({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }] })
        .success,
      false,
    );
    assert.equal(Message.safeParse({ role: 'user', content: [] }).success, false);
  });

  it('未知角色被拒绝', () => {
    assert.equal(Message.safeParse({ role: 'developer', content: 'x' }).success, false);
  });
});

describe('serializeRequest', () => {
  it('GPT 仅发 none，不发 DeepSeek 参数或输出上限；不允许配置互混', () => {
    const sol = ChatRequest.parse({
      ...VALID,
      model: 'gpt-6.1-sol',
      thinking: undefined,
      max_tokens: undefined,
      reasoning_effort: 'none',
    });
    const body = parseObject(serializeRequest(sol));
    assert.equal(body['reasoning_effort'], 'none');
    assert.equal(Object.hasOwn(body, 'max_tokens'), false);
    assert.equal(Object.hasOwn(body, 'thinking'), false);
    assert.throws(() => serializeRequest({ ...sol, max_tokens: 40000 }), /人为输出上限/);
    assert.equal(parseObject(serializeRequest({ ...sol, reasoning_effort: 'low' }))['reasoning_effort'], 'low');
    assert.equal(ChatRequest.safeParse({ ...sol, reasoning_effort: 'high' }).success, false);
    assert.throws(() => serializeRequest({ ...sol, reasoning_effort: undefined }), /已授权思考档/);
    assert.throws(() => serializeRequest({ ...ChatRequest.parse(VALID), max_tokens: undefined }), /必须指定/);
    assert.throws(() => serializeRequest({ ...ChatRequest.parse(VALID), reasoning_effort: 'none' }), /不能使用/);
  });
  it('JSON-only content 请求序列化 tools: [] 与 response_format', () => {
    const content = ChatRequest.parse({ ...VALID, tools: [], response_format: { type: 'json_object' } });
    const body = parseObject(serializeRequest(content));
    assert.deepEqual(body['tools'], []);
    assert.deepEqual(body['response_format'], { type: 'json_object' });
    assert.equal(Object.hasOwn(body, 'thinking'), true);
    assert.equal(body['stream'], true);
    const withoutFormat: ChatRequestType = { ...content };
    delete withoutFormat.response_format;
    assert.throws(() => serializeRequest(withoutFormat), /tools 为空只允许 JSON-only/);
  });

  it('顶层字段顺序 = schema 声明顺序', () => {
    const parsed = parseObject(serializeRequest(ChatRequest.parse(VALID)));
    assert.deepEqual(Object.keys(parsed), [
      'model',
      'messages',
      'tools',
      'thinking',
      'max_tokens',
      'stream',
      'stream_options',
    ]);
  });

  it('同一语义值、不同键顺序得到同一字节串', () => {
    const a: ChatRequestType = {
      model: 'deepseek-flash',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_code', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '已写入' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
          ],
        },
      ],
      tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { b: 1, a: { y: 2, x: 3 } } } }],
      thinking: { type: 'disabled' },
      max_tokens: 40000,
      stream: true,
      stream_options: { include_usage: true },
    };
    const b: ChatRequestType = {
      stream_options: { include_usage: true },
      stream: true,
      max_tokens: 40000,
      thinking: { type: 'disabled' },
      tools: [{ function: { parameters: { a: { x: 3, y: 2 }, b: 1 }, description: 'd', name: 't' }, type: 'function' }],
      messages: [
        {
          tool_calls: [{ function: { arguments: '{}', name: 'write_code' }, type: 'function', id: 'call_1' }],
          content: null,
          role: 'assistant',
        },
        { content: '已写入', tool_call_id: 'call_1', role: 'tool' },
        {
          content: [
            { text: '看图', type: 'text' },
            { image_url: { url: 'data:image/png;base64,AA==' }, type: 'image_url' },
          ],
          role: 'user',
        },
      ],
      model: 'deepseek-flash',
    };
    assert.equal(serializeRequest(a), serializeRequest(b));
    const parsed = parseObject(serializeRequest(a));
    const messages = z.array(z.unknown()).parse(parsed['messages']);
    assert.deepEqual(Object.keys(z.record(z.string(), z.unknown()).parse(messages[0])), [
      'role',
      'content',
      'tool_calls',
    ]);
    const tool = z.record(z.string(), z.unknown()).parse(z.array(z.unknown()).parse(parsed['tools'])[0]);
    const fn = z.record(z.string(), z.unknown()).parse(tool['function']);
    assert.deepEqual(Object.keys(z.record(z.string(), z.unknown()).parse(fn['parameters'])), ['a', 'b']);
  });
});

describe('Usage 与官方非流式样例', () => {
  it('特许 usage 原字段保留；缓存缺失是未知，不补零；基本 usage 仍必填', () => {
    const raw = {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 6 },
      gateway_extra: 'raw',
    };
    assert.deepEqual(Usage.parse(raw), raw);
    assert.equal(Usage.safeParse({ completion_tokens: 4, total_tokens: 14 }).success, false);
  });
  it('官方样例的 usage 能被 Usage 解析', () => {
    const raw = readFileSync(new URL('../fixtures/official/non-stream.txt', import.meta.url), 'utf8');
    const json = raw
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n');
    const sample = z.looseObject({ usage: Usage }).parse(JSON.parse(json));
    assert.partialDeepStrictEqual(sample.usage, {
      prompt_tokens: 16,
      completion_tokens: 10,
      total_tokens: 26,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 16,
    });
  });

  it('usage 的 token 数必须是非负整数', () => {
    const base = {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 1,
    };
    assert.equal(Usage.safeParse(base).success, true);
    assert.equal(Usage.safeParse({ ...base, prompt_tokens: -1 }).success, false);
    assert.equal(Usage.safeParse({ ...base, completion_tokens: 1.5 }).success, false);
  });
});
