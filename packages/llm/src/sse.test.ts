/**
 * sse.ts 的测试（MODEL-SPEC §9）。
 * 覆盖：官方流式样例逐字拼装、CRLF / keep-alive / 多字节跨块、[DONE] 语义、非法输入、§3.3 替换。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { LlmError } from './errors.ts';
import { createSseAssembler } from './sse.ts';
import type { ChatRequest } from './schema.ts';

const encoder = new TextEncoder();
const USAGE = {
  prompt_tokens: 10,
  completion_tokens: 3,
  total_tokens: 13,
  prompt_cache_hit_tokens: 1,
  prompt_cache_miss_tokens: 9,
};

function chunk(delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>): string {
  const body: Record<string, unknown> = { id: 'i', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] };
  if (usage !== undefined) body['usage'] = usage;
  return `data: ${JSON.stringify(body)}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

function feed(bytes: Uint8Array, size: number): ReturnType<typeof createSseAssembler> {
  const assembler = createSseAssembler(() => 0);
  for (let i = 0; i < bytes.length; i += size) assembler.push(bytes.subarray(i, i + size));
  return assembler;
}

function expectLlmError(fn: () => void, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof LlmError && error.failure.code === code);
}

describe('官方流式样例（MODEL-SPEC §6.3）', () => {
  it('逐字节喂入也能拼出 content 与 usage', () => {
    const raw = readFileSync(new URL('../fixtures/official/stream.txt', import.meta.url), 'utf8');
    const assembler = feed(encoder.encode(raw), 1);
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'ok');
    const response = outcome.response;
    assert.equal(response.id, '1f633d8bfc032625086f14113c411638');
    assert.equal(response.model, 'deepseek-flash');
    assert.equal(response.systemFingerprint, 'fp_a49d71b8a1');
    assert.equal(response.message.content, 'Hello! How can I assist you today?');
    assert.equal(response.message.tool_calls, undefined);
    assert.equal(response.finishReason, 'stop');
    assert.partialDeepStrictEqual(response.usage, {
      completion_tokens: 9,
      prompt_tokens: 17,
      total_tokens: 26,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 17,
    });
    assert.equal(response.usageMismatch, false);
    assert.deepEqual(response.rawArguments, []);
    assert.equal(response.timing.firstByteMs, 0);
    assert.equal(response.timing.firstTokenMs, 0);
    assert.equal(response.timing.totalMs, 0);
  });
});

describe('行解析', () => {
  it('GPT工具交错分片与独立末尾usage：缺省缓存不补零，原始usage不丢', () => {
    const raw =
      [
        {
          id: 'sol',
          model: 'gpt-6.1-sol',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'a', type: 'function', function: { name: 'check_code', arguments: '{' } },
                  { index: 1, id: 'b', type: 'function', function: { name: 'read_code', arguments: '{' } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'sol',
          model: 'gpt-6.1-sol',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 1, function: { arguments: '"from":1}' } },
                  { index: 0, function: { arguments: '}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        {
          id: 'sol',
          model: 'gpt-6.1-sol',
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
            total_tokens: 13,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        },
      ]
        .map((c) => `data: ${JSON.stringify(c)}\n\n`)
        .join('') + DONE;
    const outcome = feed(encoder.encode(raw), 1).finish();
    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(
      outcome.response.message.tool_calls?.map((c) => c.function.arguments),
      ['{}', '{"from":1}'],
    );
    assert.equal(outcome.response.usage.prompt_cache_hit_tokens, undefined);
    assert.deepEqual(outcome.response.usage['prompt_tokens_details'], { cached_tokens: 8 });
  });
  it('兼容 CRLF，keep-alive 注释跳过但算活动', () => {
    const bytes = encoder.encode(
      ': keep-alive\r\n\r\n' +
        chunk({ role: 'assistant', content: 'Hi' }, null).replace('\n\n', '\r\n\r\n') +
        chunk({ content: '' }, 'stop', USAGE).replace('\n\n', '\r\n\r\n') +
        'data: [DONE]\r\n\r\n',
    );
    const assembler = feed(bytes, 7);
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.response.message.content, 'Hi');
  });

  it('data: 后可以不跟空格', () => {
    const body = {
      id: 'i',
      model: 'm',
      choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }],
      usage: USAGE,
    };
    const assembler = feed(encoder.encode(`data:${JSON.stringify(body)}\n\n${DONE}`), 64);
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.response.message.content, 'x');
  });

  it('非 data 行报 invalid-response', () => {
    const assembler = createSseAssembler(() => 0);
    expectLlmError(() => assembler.push(encoder.encode('event: ping\n\n')), 'invalid-response');
  });

  it('data 不是合法 JSON 报 invalid-response', () => {
    const assembler = createSseAssembler(() => 0);
    expectLlmError(() => assembler.push(encoder.encode('data: {oops\n\n')), 'invalid-response');
  });

  it('流块不符合 StreamChunk 报 invalid-response', () => {
    const assembler = createSseAssembler(() => 0);
    expectLlmError(() => assembler.push(encoder.encode('data: {"no":"id"}\n\n')), 'invalid-response');
  });
});

describe('[DONE] 语义', () => {
  it('[DONE] 之前没有 usage → no-usage', () => {
    const assembler = createSseAssembler(() => 0);
    expectLlmError(() => assembler.push(encoder.encode(chunk({ content: '' }, 'stop') + DONE)), 'no-usage');
  });

  it('[DONE] 之前没有 finish_reason → invalid-response', () => {
    const assembler = createSseAssembler(() => 0);
    expectLlmError(
      () => assembler.push(encoder.encode(chunk({ content: '' }, null, USAGE) + DONE)),
      'invalid-response',
    );
  });

  it('[DONE] 之后还有数据 → invalid-response', () => {
    const assembler = createSseAssembler(() => 0);
    assembler.push(encoder.encode(chunk({ content: 'x' }, 'stop', USAGE) + DONE));
    expectLlmError(() => assembler.push(encoder.encode(chunk({ content: 'y' }, 'stop', USAGE))), 'invalid-response');
  });

  it('[DONE] 之前断流 → transport/network，可重试', () => {
    const assembler = feed(encoder.encode(chunk({ content: '半截' }, null)), 64);
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.failure.class, 'transport');
    assert.equal(outcome.failure.code, 'network');
    assert.equal(outcome.failure.retriable, true);
  });

  it('最后一整行没有换行符时，finish 也能解析出来', () => {
    const body = { id: 'i', model: 'm', choices: [{ index: 0, delta: { content: '尾行' }, finish_reason: null }] };
    const assembler = createSseAssembler(() => 0);
    assembler.push(encoder.encode(`data: ${JSON.stringify(body)}`)); // 故意不带 \n
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.failure.code, 'network');
    assert.equal(assembler.partial().content, '尾行');
  });

  it('[DONE] 之前断在半行 JSON 中间 → transport/network（断流，可重试）', () => {
    const assembler = createSseAssembler(() => 0);
    assembler.push(encoder.encode('data: {oops')); // 无换行，留给 finish
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.failure.code, 'network');
    assert.equal(outcome.failure.retriable, true);
  });

  it('[DONE] 之后的残余半行 → invalid-response', () => {
    const assembler = createSseAssembler(() => 0);
    assembler.push(encoder.encode(chunk({ content: 'x' }, 'stop', USAGE) + DONE + 'data: {oops'));
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.failure.code, 'invalid-response');
  });

  it('非法 UTF-8 报 invalid-response；断在多字节字符中间按断流处理', () => {
    const mid = createSseAssembler(() => 0);
    expectLlmError(() => mid.push(Uint8Array.of(0xff, 0xfe)), 'invalid-response');

    // [DONE] 之前连接关闭在半个多字节字符上：是断流，不是服务端发了坏字节
    const tail = createSseAssembler(() => 0);
    tail.push(encoder.encode(chunk({ content: 'x' }, null)));
    tail.push(new Uint8Array([...encoder.encode(chunk({ content: 'y' }, null)), 0xe4]));
    const cut = tail.finish();
    assert.equal(cut.kind, 'failed');
    assert.equal(cut.failure.code, 'network');

    const afterDone = createSseAssembler(() => 0);
    afterDone.push(new Uint8Array([...encoder.encode(chunk({ content: 'x' }, 'stop', USAGE) + DONE), 0xe4]));
    const outcome = afterDone.finish();
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.failure.code, 'invalid-response');
  });
});

describe('tool_call 拼装与 §3.3 替换', () => {
  it('多字节字符跨字节块也不出错，partial 能看到已拼内容', () => {
    const assembler = createSseAssembler(() => 0);
    assembler.push(encoder.encode(chunk({ role: 'assistant', content: '中' }, null)));
    const partial = assembler.partial();
    assert.equal(partial.content, '中');
    assert.equal(partial.timing.firstByteMs, 0);
    assert.equal(partial.timing.totalMs, 0);
    assembler.push(encoder.encode(chunk({ content: '' }, 'stop', USAGE) + DONE));
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.response.message.content, '中');
  });

  it('两个 tool_call 按 index 归并，参数片段按序拼接', () => {
    const first = chunk(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { index: 0, id: 'call_00_a', type: 'function', function: { name: 'write_code', arguments: '' } },
          { index: 1, id: 'call_01_b', type: 'function', function: { name: 'check_code', arguments: '' } },
        ],
      },
      null,
    );
    const frag1 = chunk({ tool_calls: [{ index: 1, function: { arguments: '{"a":' } }] }, null);
    const frag2 = chunk({ tool_calls: [{ index: 1, function: { arguments: '1}' } }] }, null);
    const frag0 = chunk({ tool_calls: [{ index: 0, function: { arguments: '{"code":"x"}' } }] }, null);
    const final = chunk({}, 'tool_calls', USAGE);
    const assembler = feed(encoder.encode(first + frag1 + frag2 + frag0 + final + DONE), 3);
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'ok');
    const calls = outcome.response.message.tool_calls ?? [];
    assert.equal(calls.length, 2);
    const call0 = calls[0];
    const call1 = calls[1];
    assert.ok(call0 !== undefined && call1 !== undefined);
    assert.equal(call0.id, 'call_00_a');
    assert.equal(call0.function.arguments, '{"code":"x"}');
    assert.equal(call1.function.arguments, '{"a":1}');
    assert.equal(outcome.response.message.content, null);
  });

  it('非法 arguments 替换为 "{}" 并把原文放进 rawArguments（截断场景）', () => {
    const first = chunk(
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ index: 0, id: 'call_00_a', type: 'function', function: { name: 'write_code', arguments: '' } }],
      },
      null,
    );
    const frag = chunk({ tool_calls: [{ index: 0, function: { arguments: '{oops' } }] }, null);
    const final = chunk({}, 'length', USAGE);
    const assembler = feed(encoder.encode(first + frag + final + DONE), 64);
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'ok');
    const calls = outcome.response.message.tool_calls ?? [];
    const call0 = calls[0];
    assert.ok(call0 !== undefined);
    assert.equal(call0.function.arguments, '{}');
    assert.deepEqual(outcome.response.rawArguments, [{ index: 0, text: '{oops' }]);
    assert.equal(outcome.response.finishReason, 'length');
  });

  it('首块缺 id 或 function.name 报 invalid-response', () => {
    const missingId = createSseAssembler(() => 0);
    expectLlmError(
      () =>
        missingId.push(
          encoder.encode(chunk({ tool_calls: [{ index: 0, function: { name: 'n', arguments: '' } }] }, null)),
        ),
      'invalid-response',
    );
    const missingName = createSseAssembler(() => 0);
    expectLlmError(
      () =>
        missingName.push(
          encoder.encode(chunk({ tool_calls: [{ index: 0, id: 'a', function: { arguments: '' } }] }, null)),
        ),
      'invalid-response',
    );
  });

  it('后续块 id / name 前后不一致报 invalid-response', () => {
    const first = chunk(
      { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'n', arguments: '' } }] },
      null,
    );
    const idMismatch = createSseAssembler(() => 0);
    idMismatch.push(encoder.encode(first));
    expectLlmError(
      () => idMismatch.push(encoder.encode(chunk({ tool_calls: [{ index: 0, id: 'b' }] }, null))),
      'invalid-response',
    );
    const nameMismatch = createSseAssembler(() => 0);
    nameMismatch.push(encoder.encode(first));
    expectLlmError(
      () => nameMismatch.push(encoder.encode(chunk({ tool_calls: [{ index: 0, function: { name: 'm' } }] }, null))),
      'invalid-response',
    );
  });

  it('content_filter 时 content 写 ""，tool_calls 保留', () => {
    const first = chunk(
      {
        role: 'assistant',
        content: '将被过滤',
        tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'n', arguments: '{}' } }],
      },
      null,
    );
    const final = chunk({}, 'content_filter', USAGE);
    const assembler = feed(encoder.encode(first + final + DONE), 64);
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.response.message.content, '');
    assert.equal(outcome.response.message.tool_calls?.length, 1);
  });

  it('只有 reasoning_content 时 content 写 ""，reasoning 保留', () => {
    const first = chunk({ role: 'assistant', reasoning_content: '想一想' }, null);
    const final = chunk({ content: '' }, 'stop', USAGE);
    const assembler = feed(encoder.encode(first + final + DONE), 64);
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.response.message.content, '');
    assert.equal(outcome.response.message.reasoning_content, '想一想');
  });

  it('既没有 content 也没有 tool_calls 时 content 写 ""', () => {
    const first = chunk({ role: 'assistant' }, null);
    const final = chunk({}, 'stop', USAGE);
    const assembler = feed(encoder.encode(first + final + DONE), 64);
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.response.message.content, '');
    assert.equal(outcome.response.message.reasoning_content, undefined);
  });

  it('hit + miss ≠ prompt 时 usageMismatch 为 true，且照常返回', () => {
    const usage = { ...USAGE, prompt_tokens: 100 };
    const assembler = feed(encoder.encode(chunk({ content: 'x' }, 'stop', usage) + DONE), 64);
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.response.usageMismatch, true);
  });

  it('拼装出的 assistant 消息能被下一步请求接受', () => {
    const first = chunk(
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'n', arguments: '{bad' } }],
      },
      null,
    );
    const final = chunk({}, 'tool_calls', USAGE);
    const assembler = feed(encoder.encode(first + final + DONE), 64);
    const outcome = assembler.finish();
    assert.equal(outcome.kind, 'ok');
    // ChatResponse.message 的类型就是 ChatRequest.messages 的元素类型，可直接追加。
    const message: ChatRequest['messages'][number] = outcome.response.message;
    assert.equal(message.role, 'assistant');
  });
});
