/**
 * request-codec 的测试（MODEL-SPEC §7.4、§9）。
 * 含图片的多条消息：清单 + blob 往返后请求体逐字节相同；同一消息 / 同一 PNG 只存一个 blob。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { ChatRequest, serializeRequest } from '@pg/llm/schema';
import type { Message } from '@pg/llm/schema';

import { RequestManifest, decodeRequest, encodeRequest, serializeDecoded, type Sha256 } from './request-codec.ts';

const hash: Sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const PNG_A = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff]);
const PNG_B = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);
const pngUrl = (bytes: Uint8Array): string => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

const TOOL = {
  type: 'function' as const,
  function: {
    name: 'write_code',
    description: '写代码',
    parameters: { type: 'object', properties: { code: { type: 'string' } } },
  },
};

function makeRequest(): ChatRequest {
  const messages: Message[] = [{ role: 'system', content: '你是建造代理。' }];
  for (let i = 0; i < 29; i += 1) {
    const n = i % 4;
    if (n === 0) messages.push({ role: 'user', content: `第 ${String(i)} 轮事实` });
    else if (n === 1)
      messages.push({
        role: 'assistant',
        content: `回复 ${String(i)}`,
        tool_calls: [{ id: `call_${String(i)}`, type: 'function', function: { name: 'read_code', arguments: '{}' } }],
      });
    else if (n === 2) messages.push({ role: 'tool', tool_call_id: `call_${String(i)}`, content: '结果' });
    else
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: pngUrl(PNG_A) } },
        ],
      });
  }
  // 复制一条消息，验证去重：内容相同 → 同一 blob sha。
  messages[5] = messages[4]!;
  // 另一张不同的图，验证 PNG 也内容寻址。
  messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: pngUrl(PNG_B) } }] });
  return ChatRequest.parse({
    model: 'deepseek-flash',
    messages,
    tools: [TOOL],
    thinking: { type: 'disabled' },
    max_tokens: 40_000,
    stream: true,
    stream_options: { include_usage: true },
  });
}

describe('encodeRequest / decodeRequest', () => {
  it('GPT 含图片请求重建，保留 none 和未指定输出上限', () => {
    const request = ChatRequest.parse({
      ...makeRequest(),
      model: 'gpt-6.1-sol',
      thinking: undefined,
      max_tokens: undefined,
      reasoning_effort: 'none',
    });
    const encoded = encodeRequest(request, hash);
    const stored = new Map(encoded.blobs.map((b) => [b.sha256, b.bytes]));
    const restored = decodeRequest(encoded.manifest, (s) => {
      const b = stored.get(s);
      assert.ok(b !== undefined);
      return b;
    });
    assert.equal(serializeRequest(restored), serializeRequest(request));
    assert.equal(restored.reasoning_effort, 'none');
    assert.equal(restored.max_tokens, undefined);
  });
  it('JSON-only content 请求往返：tools: [] 与 response_format 不丢失', () => {
    const request = ChatRequest.parse({
      ...makeRequest(),
      tools: [],
      response_format: { type: 'json_object' },
    });
    const encoded = encodeRequest(request, hash);
    const stored = new Map(encoded.blobs.map((b) => [b.sha256, b.bytes]));
    const restored = decodeRequest(encoded.manifest, (sha) => {
      const bytes = stored.get(sha);
      assert.ok(bytes !== undefined);
      return bytes;
    });
    assert.equal(serializeRequest(restored), serializeRequest(request));
    assert.deepEqual(restored.response_format, { type: 'json_object' });
    assert.deepEqual(restored.tools, []);
  });

  it('好样本：31 条消息（含图片）往返后请求体逐字节相同', () => {
    const request = makeRequest();
    const { manifest, blobs } = encodeRequest(request, hash);

    assert.equal(manifest.messages.length, request.messages.length);
    assert.ok(manifest.messages.length >= 30);

    // 复制的那条消息只产生一个 blob：不同 sha 数 < 消息数。
    assert.ok(new Set(manifest.messages).size < manifest.messages.length);

    // PNG 去重：A 被多条消息引用，B 一张，共 2 个 png blob。
    const pngShas = new Set([hash(PNG_A), hash(PNG_B)]);
    const pngBlobs = blobs.filter((b) => pngShas.has(b.sha256));
    assert.equal(pngBlobs.length, 2);
    assert.deepEqual(new Set(pngBlobs.map((b) => b.sha256)), pngShas);

    const stored = new Map(blobs.map((b) => [b.sha256, b.bytes]));
    const read = (sha: string): Uint8Array => {
      const bytes = stored.get(sha);
      if (bytes === undefined) throw new Error(`blob 不存在：${sha}`);
      return bytes;
    };

    assert.equal(serializeDecoded(manifest, read), serializeRequest(request));

    const decoded = decodeRequest(manifest, read);
    assert.deepEqual(decoded.messages[4], request.messages[4]);
    // 还原出的图片 data URL 与原始逐字节一致。
    assert.equal(serializeRequest(decoded), serializeRequest(request));
  });

  it('坏样本：请求不合 ChatRequest 时 encodeRequest 抛错', () => {
    const request = makeRequest();
    assert.throws(() => encodeRequest({ ...request, model: 'deepseek-v4-pro' } as unknown as ChatRequest, hash));
  });

  it('坏样本：清单里的消息 sha 非法时拒绝', () => {
    const { manifest } = encodeRequest(makeRequest(), hash);
    assert.throws(() => RequestManifest.parse({ ...manifest, messages: ['not-hex'] }));
  });

  it('坏样本：blob 缺失时读取函数抛错，不静默补空', () => {
    const { manifest } = encodeRequest(makeRequest(), hash);
    const read = (): Uint8Array => {
      throw new Error('blob 不存在');
    };
    assert.throws(() => decodeRequest(manifest, read), /blob 不存在/);
  });
});
