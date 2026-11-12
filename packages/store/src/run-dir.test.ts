/**
 * run-dir 的测试（MODEL-SPEC §7.1、§7.2、§7.4、§9）：
 * 1000 条事件 seq 连续；截断末行报错并给行号；data:image / 密钥 / 超大行拒绝写入；
 * 请求从清单逐字节还原；交付文件落盘；runId 路径白名单。
 */

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ChatRequest, serializeRequest } from '@pg/llm/schema';

import { sha256Hex } from './blobs.ts';
import { canonicalJson } from './canonical-json.ts';
import { EVENT_TEXT_MAX, TRUNCATION_MARK } from './events.ts';
import { encodeRequest } from './request-codec.ts';
import { MAX_EVENT_BYTES, createRunDir, openRunDir } from './run-dir.ts';

const root = mkdtempSync(join(tmpdir(), 'pg-store-rundir-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeRequest(): ChatRequest {
  return ChatRequest.parse({
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ],
    tools: [{ type: 'function', function: { name: 'read_code', description: 'd', parameters: { type: 'object' } } }],
    thinking: { type: 'disabled' },
    max_tokens: 1000,
    stream: true,
    stream_options: { include_usage: true },
  });
}

describe('run-dir 事件读写', () => {
  it('好样本：1000 条事件 seq 连续，读回数量与内容一致', () => {
    const writer = createRunDir(root, 'run-1000');
    for (let i = 0; i < 1000; i += 1) {
      assert.equal(writer.append('turn.start', i + 1, { elapsedMs: i, spentCny: 0 }), i);
    }
    writer.close();
    const events = openRunDir(writer.dir).events();
    assert.equal(events.length, 1000);
    const fifth = events[5]!;
    assert.equal(fifth.seq, 5);
    if (fifth.type === 'turn.start') assert.equal(fifth.body.elapsedMs, 5);
  });

  it('坏样本：截断的末行报错并给出行号', () => {
    const writer = createRunDir(root, 'run-truncated');
    writer.append('turn.start', 1, { elapsedMs: 0, spentCny: 0 });
    writer.close();
    appendFileSync(join(writer.dir, 'events.jsonl'), '{"v":1,"seq":1,"ts":"x"');
    assert.throws(() => openRunDir(writer.dir).events(), /第 2 行不完整/);
  });

  it('坏样本：seq 不连续报错并给出行号', () => {
    const writer = createRunDir(root, 'run-gap');
    writer.append('turn.start', 1, { elapsedMs: 0, spentCny: 0 });
    writer.close();
    appendFileSync(
      join(writer.dir, 'events.jsonl'),
      '{"v":1,"seq":5,"ts":"2026-10-03T00:00:00.000Z","runId":"run-gap","turn":1,"type":"turn.start","body":{"elapsedMs":0,"spentCny":0}}\n',
    );
    assert.throws(() => openRunDir(writer.dir).events(), /第 2 行的 seq=5，应为 1/);
  });

  it('坏样本：非 JSON 行、空行报错', () => {
    const writer = createRunDir(root, 'run-badjson');
    writer.append('turn.start', 1, { elapsedMs: 0, spentCny: 0 });
    writer.close();
    appendFileSync(join(writer.dir, 'events.jsonl'), 'not json\n');
    assert.throws(() => openRunDir(writer.dir).events(), /第 2 行不是合法 JSON/);
  });

  it('坏样本：读到不存在的目录 / blob 抛错', () => {
    assert.throws(() => openRunDir(join(root, 'missing')).events(), /events\.jsonl 不存在/);
    const writer = createRunDir(root, 'run-noblob');
    writer.append('turn.start', 1, { elapsedMs: 0, spentCny: 0 });
    writer.close();
    assert.throws(() => openRunDir(writer.dir).blob('a'.repeat(64)), /blob 不存在/);
  });
});

describe('run-dir 写入前扫描', () => {
  it('坏样本：data:image 拒绝', () => {
    const writer = createRunDir(root, 'run-image');
    assert.throws(
      () => writer.append('guard', 1, { name: 'data:image/png;base64,AAA', action: 'warn', value: 1, limit: 2 }),
      /data:image/,
    );
    writer.close();
  });

  it('坏样本：疑似 sk- API key 拒绝', () => {
    const writer = createRunDir(root, 'run-key');
    assert.throws(
      () =>
        writer.append('submit', 1, {
          callId: 'c',
          codeVersion: 1,
          accepted: false,
          reason: 'sk-abcdefghijklmnopqrstuvwx',
        }),
      /API key/,
    );
    writer.close();
  });

  it('坏样本：单行超过 256 KiB 拒绝', () => {
    const writer = createRunDir(root, 'run-large');
    assert.throws(
      () => writer.append('guard', 1, { name: 'x'.repeat(MAX_EVENT_BYTES + 1), action: 'warn', value: 1, limit: 2 }),
      /超过/,
    );
    writer.close();
  });

  it('坏样本：runId 含路径穿越', () => {
    for (const bad of ['../evil', 'a/b', '..', '']) {
      assert.throws(() => createRunDir(root, bad), /非法路径片段/);
    }
  });
});

describe('run-dir 超长文本截断', () => {
  const CHECK_BASE = { codeVersion: 1, codeSha: 'a'.repeat(64), seed: 1 };

  it('好样本：5000 字符的诊断 message 写入成功并截到上限', () => {
    const writer = createRunDir(root, 'run-long-diag');
    writer.append('check.result', 1, {
      ...CHECK_BASE,
      precheck: {
        kind: 'failed',
        total: 1,
        diagnostics: [{ line: 1, column: 1, code: 'TS1234', message: 'x'.repeat(5000) }],
      },
      run: null,
    });
    writer.close();
    const events = openRunDir(writer.dir).events();
    const event = events[0];
    if (event?.type !== 'check.result' || event.body.precheck.kind !== 'failed') throw new Error('类型不符');
    const message = event.body.precheck.diagnostics[0]?.message ?? '';
    assert.equal(message.length, EVENT_TEXT_MAX);
    assert.ok(message.endsWith(TRUNCATION_MARK));
  });

  it('好样本：600–2000 之间的 message 原样保留', () => {
    const text = 'y'.repeat(1500);
    const writer = createRunDir(root, 'run-mid-diag');
    writer.append('check.result', 1, {
      ...CHECK_BASE,
      precheck: { kind: 'failed', total: 1, diagnostics: [{ line: 1, column: 1, code: 'TS1234', message: text }] },
      run: null,
    });
    writer.close();
    const event = openRunDir(writer.dir).events()[0];
    if (event?.type !== 'check.result' || event.body.precheck.kind !== 'failed') throw new Error('类型不符');
    assert.equal(event.body.precheck.diagnostics[0]?.message, text);
  });

  it('好样本：build-error 的 name / message 超长也被截断', () => {
    const writer = createRunDir(root, 'run-long-build-error');
    writer.append('check.result', 1, {
      ...CHECK_BASE,
      precheck: { kind: 'ok' },
      run: {
        kind: 'build-error',
        error: { name: 'n'.repeat(5000), message: 'm'.repeat(5000), line: 1, column: 1 },
        console: 0,
        wallMs: 1,
      },
    });
    writer.close();
    const event = openRunDir(writer.dir).events()[0];
    if (event?.type !== 'check.result' || event.body.run?.kind !== 'build-error') throw new Error('类型不符');
    assert.equal(event.body.run.error.message.length, EVENT_TEXT_MAX);
    assert.equal(event.body.run.error.name.length, EVENT_TEXT_MAX);
  });

  it('旧记录：600 字符 message 与无 reason 的 submit 仍可解析', () => {
    const dir = join(root, 'run-legacy');
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    const legacy = [
      {
        v: 1,
        seq: 0,
        ts: '2026-10-04T00:00:00.000Z',
        runId: 'run-legacy',
        turn: 1,
        type: 'check.result',
        body: {
          ...CHECK_BASE,
          precheck: {
            kind: 'failed',
            total: 1,
            diagnostics: [{ line: 1, column: 1, code: 'TS1234', message: 'x'.repeat(600) }],
          },
          run: null,
        },
      },
      {
        v: 1,
        seq: 1,
        ts: '2026-10-04T00:00:01.000Z',
        runId: 'run-legacy',
        turn: 1,
        type: 'submit',
        body: { callId: 'c', codeVersion: 1, accepted: false },
      },
    ];
    writeFileSync(join(dir, 'events.jsonl'), `${legacy.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const events = openRunDir(dir).events();
    assert.equal(events.length, 2);
    const first = events[0];
    if (first?.type !== 'check.result' || first.body.precheck.kind !== 'failed') throw new Error('类型不符');
    assert.equal(first.body.precheck.diagnostics[0]?.message.length, 600);
  });
});

describe('run-dir 请求还原与交付', () => {
  it('好样本：llm.request 由清单逐字节还原', () => {
    const request = makeRequest();
    const encoded = encodeRequest(request, sha256Hex);
    const writer = createRunDir(root, 'run-request');
    for (const blob of encoded.blobs) writer.putBlob(blob.bytes);
    const manifestRef = writer.putBlob(encoder.encode(canonicalJson(encoded.manifest)));
    const body = serializeRequest(request);
    const bodyBytes = encoder.encode(body);
    const seq = writer.append('llm.request', 1, {
      requestSha: sha256Hex(bodyBytes),
      manifest: manifestRef,
      bodyBytes: bodyBytes.length,
      messages: request.messages.length,
      images: 0,
      imageBytes: 0,
      reserve: { cny: 0, maxTokens: 1000, inputUpper: 100 },
    });
    writer.close();

    const reader = openRunDir(writer.dir);
    const restored = reader.request(seq);
    assert.equal(decoder.decode(restored), body);
    assert.equal(sha256Hex(restored), sha256Hex(bodyBytes));
    assert.throws(() => reader.request(999), /不是 llm\.request 事件/);
  });

  it('好样本：交付文件落盘；坏样本：交付路径穿越拒绝', () => {
    const writer = createRunDir(root, 'run-delivery');
    writer.writeDelivery([
      { path: 'render/north.png', bytes: Uint8Array.from([1, 2, 3]) },
      { path: 'building.ts', bytes: encoder.encode('export default function build() {}') },
    ]);
    assert.deepEqual([...readFileSync(join(writer.dir, 'delivery', 'render', 'north.png'))], [1, 2, 3]);
    assert.throws(() => {
      writer.writeDelivery([{ path: '../escape', bytes: new Uint8Array() }]);
    }, /非法路径片段/);
    assert.throws(() => {
      writer.writeDelivery([{ path: 'a//b', bytes: new Uint8Array() }]);
    }, /非法路径片段/);
    writer.close();
  });
});
