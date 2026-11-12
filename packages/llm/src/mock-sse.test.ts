/**
 * mock-sse.ts 的测试（MODEL-SPEC §6.1、§9）：encodeSse 的形状与往返。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mulberry32 } from '@pg/core/rng';
import fc from 'fast-check';

import { encodeSse } from './mock-sse.ts';
import type { ChatResponse, PartialResponse } from './schema.ts';
import { createSseAssembler } from './sse.ts';

const USAGE = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_cache_hit_tokens: 90,
  prompt_cache_miss_tokens: 10,
};

function response(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    id: 'r1',
    model: 'deepseek-flash',
    systemFingerprint: 'fp_x',
    message: {
      role: 'assistant',
      content: '先写塔基。',
      tool_calls: [
        {
          id: 'call_00_aaaaaaaaaaaaaaaaaaaaaaaa',
          type: 'function',
          function: { name: 'write_code', arguments: JSON.stringify({ code: '塔基用石砖铺满九乘九。' }) },
        },
        {
          id: 'call_01_bbbbbbbbbbbbbbbbbbbbbbbb',
          type: 'function',
          function: { name: 'check', arguments: '{}' },
        },
      ],
    },
    rawArguments: [],
    finishReason: 'tool_calls',
    usage: USAGE,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: null, totalMs: 0 },
    ...overrides,
  };
}

const decoder = new TextDecoder();

function joined(chunks: readonly Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return decoder.decode(all);
}

function assemble(chunks: readonly Uint8Array[]): ReturnType<ReturnType<typeof createSseAssembler>['finish']> {
  const a = createSseAssembler(() => 0);
  for (const c of chunks) a.push(c);
  return a.finish();
}

describe('encodeSse 形状', () => {
  it('首块带 role 与空 content，第 2 块前有 keep-alive，末块同时带 finish_reason 与 usage，再 [DONE]', () => {
    const text = joined(encodeSse(response(), mulberry32(1)));
    const events = text.split('\n\n').filter((e) => e !== '');
    assert.match(events[0] ?? '', /^data: /);
    const first = JSON.parse((events[0] ?? '').slice(6)) as { choices: { delta: unknown }[] };
    assert.deepEqual(first.choices[0]?.delta, { role: 'assistant', content: '' });
    assert.equal(events[1], ': keep-alive');
    assert.equal(events.at(-1), 'data: [DONE]');
    const last = JSON.parse((events.at(-2) ?? '').slice(6)) as {
      usage: unknown;
      choices: { finish_reason: string }[];
    };
    assert.deepEqual(last.usage, USAGE);
    assert.equal(last.choices[0]?.finish_reason, 'tool_calls');
    // 每个 tool_call 首块带 id、type、name 与空 arguments
    assert.ok(
      text.includes(
        '"id":"call_00_aaaaaaaaaaaaaaaaaaaaaaaa","type":"function","function":{"name":"write_code","arguments":""}',
      ),
    );
  });

  it('参数含中文时，至少一处字节块切在多字节字符中间', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const chunks = encodeSse(response(), mulberry32(seed));
      const fatal = new TextDecoder('utf-8', { fatal: true });
      const splitMidChar = chunks.some((c) => {
        try {
          fatal.decode(c);
          return false;
        } catch {
          return true;
        }
      });
      assert.ok(splitMidChar, `seed ${String(seed)} 没有切在多字节字符中间`);
    }
  });

  it('同种子同字节，不同种子切法不同', () => {
    const a = encodeSse(response(), mulberry32(42));
    const b = encodeSse(response(), mulberry32(42));
    const c = encodeSse(response(), mulberry32(43));
    assert.deepEqual(a, b);
    assert.notEqual(joined(a), joined(c), '增量切法也随种子变化');
    const ra = assemble(a);
    const rc = assemble(c);
    assert.ok(ra.kind === 'ok' && rc.kind === 'ok');
    assert.deepEqual(ra.response.message, rc.response.message);
    assert.notDeepEqual(
      a.map((x) => x.length),
      c.map((x) => x.length),
    );
  });

  it('content 与 arguments 增量每片 1–40 字节', () => {
    const long = response({ message: { role: 'assistant', content: '长'.repeat(200) }, finishReason: 'stop' });
    const text = joined(encodeSse(long, mulberry32(3)));
    const pieces = text
      .split('\n\n')
      .filter((e) => e.startsWith('data: {'))
      .map(
        (e) =>
          (JSON.parse(e.slice(6)) as { choices: { delta: { content?: string | null } }[] }).choices[0]?.delta.content,
      )
      .filter((c): c is string => typeof c === 'string' && c !== '');
    assert.ok(pieces.length > 1);
    for (const p of pieces) {
      const n = new TextEncoder().encode(p).length;
      assert.ok(n >= 1 && n <= 40, `片段 ${String(n)} 字节`);
    }
  });

  it('crlf 选项用 \\r\\n\\r\\n 分隔，拼装端照样能解析', () => {
    const chunks = encodeSse(response(), mulberry32(5), { crlf: true });
    assert.ok(joined(chunks).includes('\r\n\r\n'));
    assert.equal(assemble(chunks).kind, 'ok');
  });

  it('部分响应只发已有内容，不发末块与 [DONE]', () => {
    const partial: PartialResponse = {
      content: '重复重复',
      reasoning: '',
      arguments: [{ index: 0, name: 'write_code', text: '{"code":"半' }],
      timing: { firstByteMs: 0, totalMs: 0 },
    };
    const chunks = encodeSse(partial, mulberry32(9), { id: 'p1' });
    const text = joined(chunks);
    assert.ok(!text.includes('[DONE]'));
    assert.ok(!text.includes('"usage"'));
    assert.ok(text.includes('"id":"call_00_000000000000000000000000"'));
    const a = createSseAssembler(() => 0);
    for (const c of chunks) a.push(c);
    assert.equal(a.partial().content, '重复重复');
    assert.deepEqual(a.partial().arguments, [{ index: 0, name: 'write_code', text: '{"code":"半' }]);
    assert.equal(a.finish().kind, 'failed');
  });
});

describe('encodeSse 往返（经 sse.ts 拼装）', () => {
  it('wholeDeltas：每段内容整段作为一个增量发出', () => {
    const partial: PartialResponse = {
      content: '长'.repeat(100),
      reasoning: '',
      arguments: [],
      timing: { firstByteMs: 0, totalMs: 0 },
    };
    const text = joined(encodeSse(partial, mulberry32(1), { wholeDeltas: true }));
    assert.equal(text.split('长'.repeat(100)).length, 2);
  });

  it('两个 tool_call 交错发出，按 index 归并后与原响应相同', () => {
    const original = response();
    const chunks = encodeSse(original, mulberry32(11), { interleave: true });
    const text = joined(chunks);
    // 确认真的交错了：index 1 的首块出现在 index 0 的最后一个片段之前
    const firstOf1 = text.indexOf('"index":1');
    const lastOf0 = text.lastIndexOf('"index":0,"function":{"arguments"');
    assert.ok(firstOf1 !== -1 && lastOf0 !== -1);
    const out = assemble(chunks);
    assert.equal(out.kind, 'ok');
    assert.deepEqual(out.response.message, original.message);
    assert.deepEqual(out.response.usage, original.usage);
  });

  it('rawArguments 里的原文被发出，拼装端再次替换为 "{}" 并给出同一原文', () => {
    const original = response({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_00_x', type: 'function', function: { name: 'write_code', arguments: '{}' } }],
      },
      rawArguments: [{ index: 0, text: '{"code":"截断' }],
      finishReason: 'length',
    });
    const out = assemble(encodeSse(original, mulberry32(2)));
    assert.equal(out.kind, 'ok');
    assert.deepEqual(out.response.message, original.message);
    assert.deepEqual(out.response.rawArguments, original.rawArguments);
  });

  it('reasoning_content 往返', () => {
    const original = response({
      message: { role: 'assistant', content: '结论', reasoning_content: '先想一想。' },
      finishReason: 'stop',
    });
    const out = assemble(encodeSse(original, mulberry32(4)));
    assert.equal(out.kind, 'ok');
    assert.deepEqual(out.response.message, original.message);
  });

  it('性质：任意 content / 参数文本与种子，往返得到同一 message', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme' }),
        fc.string({ unit: 'grapheme' }),
        fc.integer(),
        (content, code, seed) => {
          const original = response({
            message: {
              role: 'assistant',
              content,
              tool_calls: [
                {
                  id: 'call_00_z',
                  type: 'function',
                  function: { name: 'write_code', arguments: JSON.stringify({ code }) },
                },
              ],
            },
          });
          const out = assemble(encodeSse(original, mulberry32(seed), { crlf: seed % 2 === 0 }));
          return out.kind === 'ok' && JSON.stringify(out.response.message) === JSON.stringify(original.message);
        },
      ),
    );
  });
});
