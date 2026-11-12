/**
 * 事件 schema 的测试（MODEL-SPEC §7.2、§7.3、§9）。
 * 每种事件一个好样本（必须通过）、一个坏样本（必须报红）；另测信封、RunLimits、StopReason、
 * RenderVersion、PrecheckSummary、RunSummary、Ref 的边界。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVENT_SCHEMAS,
  EVENT_TEXT_MAX,
  EventParseError,
  PrecheckSummary,
  Ref,
  RenderVersion,
  RunLimits,
  RunSummary,
  StopReason,
  TRUNCATION_MARK,
  clampEventBody,
  parseEvent,
  truncateEventText,
  type EventType,
} from './events.ts';

const SHA = 'a'.repeat(64);
const REF = { sha256: SHA, bytes: 12 };

const LIMITS = { maxCostCny: 3.5, maxTurns: 60, wallMs: 2_400_000, submitWindow: 3 };
const USAGE = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  prompt_cache_hit_tokens: 8,
  prompt_cache_miss_tokens: 2,
};
const RENDER_VERSION = {
  protocol: 1,
  chrome: '120.0.0.0',
  puppeteer: '21.0.0',
  three: '0.160.0',
  flags: ['--use-gl=swiftshader'],
  webglRenderer: 'SwiftShader',
  cpuModel: 'x86',
};
const VERSIONS = {
  git: { commit: 'abc', dirty: false, diff: null },
  node: '24.0.0',
  eventsSchema: 2,
  worldApi: 3,
  worldDts: SHA,
  precheck: 'p1',
  sandbox: 's1',
  archiveFormat: 1,
  analysis: SHA,
  tools: SHA,
  prompt: SHA,
  factsFormat: 1,
  model: 'deepseek-flash',
  pricing: '0123456789ab',
  llmClient: 1,
};
const TOTALS = {
  turns: 60,
  requests: 60,
  attempts: 61,
  promptTokens: 100,
  hitTokens: 80,
  missTokens: 20,
  completionTokens: 50,
  reasoningTokens: 0,
  costCny: 3.4,
  wallMs: 2_400_000,
  images: 6,
  imageBytes: 100,
};

const GOOD_BODIES: Readonly<Record<EventType, unknown>> = {
  'model.check': { codeVersion: 1, codeSha: SHA, seed: 0, status: 'ok', result: REF, document: REF, documentHash: SHA },
  'model.delivery': { code: REF, document: REF, hash: SHA, codeVersion: 1 },
  'run.start': {
    task: { sha256: SHA, source: null, fedSha256: SHA, fed: REF },
    seed: 42,
    mode: 'live',
    limits: LIMITS,
    guardConstants: {
      imageBytesSoft: 32_000_000,
      imageBytesHard: 40_000_000,
      contextTokens: 900_000,
      minMaxTokens: 2000,
    },
    versions: VERSIONS,
    config: { baseUrl: 'https://api.deepseek.com', timeoutMs: 600_000 },
  },
  'prompt.system': { system: REF, tools: REF, tokensOffline: { system: 10, tools: 20 } },
  'versions.render': { render: RENDER_VERSION },
  'turn.start': { elapsedMs: 1000, spentCny: 0.5 },
  'llm.request': {
    requestSha: SHA,
    manifest: REF,
    bodyBytes: 100,
    messages: 2,
    images: 0,
    imageBytes: 0,
    reserve: { cny: 0.1, maxTokens: 1000, inputUpper: 500 },
  },
  'llm.attempt': {
    attempt: 1,
    outcome: 'ok',
    failure: null,
    charge: 'usage',
    usage: USAGE,
    delayMs: null,
    timing: { firstByteMs: 100, totalMs: 200 },
    settledCny: 0.1,
  },
  'llm.response': {
    outcome: 'ok',
    response: REF,
    finishReason: 'stop',
    usage: USAGE,
    cny: 0.1,
    model: 'deepseek-flash',
    systemFingerprint: null,
    timing: { firstByteMs: 100, firstTokenMs: 120, totalMs: 200 },
    usageMismatch: false,
  },
  'tool.call': { callId: 'call_00_abc', name: 'write_code', arguments: REF, parse: 'ok' },
  'tool.result': { callId: 'call_00_abc', name: 'write_code', text: REF, status: 'ok', wallMs: 5 },
  'code.version': { version: 1, code: REF, via: 'write_code', lines: 10 },
  'check.result': {
    codeVersion: 1,
    codeSha: SHA,
    seed: 1,
    precheck: {
      kind: 'failed',
      total: 1,
      diagnostics: [{ line: 1, column: 2, code: 'TS2820', message: 'x' }],
    },
    run: null,
  },
  facts: { text: REF, measures: REF },
  'render.result': {
    purpose: 'iterate',
    kind: 'ok',
    images: [{ view: 'north', png: REF, pixelsPerCell: 8, frameFill: 0.5 }],
    wallMs: 20,
  },
  guard: { name: 'cost', action: 'warn', value: 3.4, limit: 3.5 },
  submit: { callId: 'call_00_abc', codeVersion: 1, accepted: true },
  delivery: { code: REF, archive: REF, hash: 'h', codeVersion: 1, renders: [{ view: 'north', png: REF }] },
  'subrun.result': {
    runId: 'massing-1',
    dir: 'sub/massing-1',
    callId: 'call_00_abc',
    ordinal: 1,
    status: 'success',
    reservedCny: 0.5,
    costCny: 0.0123,
    turns: 4,
    code: REF,
    document: REF,
    documentHash: SHA,
    text: REF,
    image: REF,
  },
  'run.end': { stopReason: 'max-turns', totals: TOTALS },
};

function envelope(type: string, body: unknown): unknown {
  return { v: 1, seq: 0, ts: '2026-10-03T00:00:00.000Z', runId: '20261003-000000-adhoc-abc123', turn: 1, type, body };
}

describe('EVENT_SCHEMAS 好样本', () => {
  for (const type of Object.keys(GOOD_BODIES) as EventType[]) {
    it(`${type} 通过`, () => {
      const result = EVENT_SCHEMAS[type].safeParse(GOOD_BODIES[type]);
      assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
    });
  }
});

describe('EVENT_SCHEMAS 坏样本', () => {
  it('草模执行结果成功必须绑定文档和 hash，失败不能冒充成功文档', () => {
    const body = { codeVersion: 1, codeSha: SHA, seed: 0, status: 'ok', result: REF };
    const schema = EVENT_SCHEMAS['model.check'];
    assert.equal(schema.safeParse(body).success, false);
    assert.equal(schema.safeParse({ ...body, document: REF }).success, false);
    assert.equal(schema.safeParse({ ...body, document: REF, documentHash: SHA }).success, true);
    assert.equal(schema.safeParse({ ...body, status: 'build-error' }).success, true);
    assert.equal(schema.safeParse({ ...body, status: 'build-error', document: REF, documentHash: SHA }).success, false);
    assert.equal(schema.safeParse({ ...body, status: 'unknown' }).success, false);
  });
  for (const type of Object.keys(GOOD_BODIES) as EventType[]) {
    it(`${type} 多出未知字段时拒绝`, () => {
      const body = { ...(GOOD_BODIES[type] as Record<string, unknown>), unexpected: 1 };
      assert.equal(EVENT_SCHEMAS[type].safeParse(body).success, false);
    });
  }

  it('缺必填字段时拒绝', () => {
    const good = GOOD_BODIES['run.end'] as Record<string, unknown>;
    assert.equal(EVENT_SCHEMAS['run.end'].safeParse({ ...good, totals: undefined }).success, false);
  });

  it('llm.response 的 outcome 未知时拒绝', () => {
    assert.equal(
      EVENT_SCHEMAS['llm.response'].safeParse({ ...(GOOD_BODIES['llm.response'] as object), outcome: 'x' }).success,
      false,
    );
  });
});

describe('parseEvent', () => {
  it('好样本：信封与 body 一起校验', () => {
    const event = parseEvent(envelope('turn.start', { elapsedMs: 1, spentCny: 0 }));
    assert.equal(event.type, 'turn.start');
    assert.equal(event.seq, 0);
    assert.deepEqual(event.body, { elapsedMs: 1, spentCny: 0 });
  });

  it('坏样本：未知事件类型', () => {
    assert.throws(() => parseEvent(envelope('turn.start', { elapsedMs: 1, spentCny: 0, extra: 1 })), EventParseError);
    assert.throws(() => parseEvent({ ...(envelope('nope', {}) as object) }), /未知事件类型/);
  });

  it('坏样本：信封字段缺失 / seq 为负 / ts 非 ISO', () => {
    const good = envelope('turn.start', { elapsedMs: 1, spentCny: 0 }) as Record<string, unknown>;
    assert.throws(() => parseEvent({ ...good, seq: -1 }), EventParseError);
    assert.throws(() => parseEvent({ ...good, ts: '2026-10-03 00:00:00' }), EventParseError);
    assert.throws(() => parseEvent({ ...good, v: 2 }), EventParseError);
  });

  it('坏样本：body 不符 schema', () => {
    assert.throws(() => parseEvent(envelope('turn.start', { elapsedMs: -1, spentCny: 0 })), /turn\.start/);
  });
});

describe('辅助 schema 边界', () => {
  it('RunLimits：maxTurns < 4、wallMs < 60s、submitWindow 越界都拒绝', () => {
    assert.equal(RunLimits.safeParse(LIMITS).success, true);
    assert.equal(RunLimits.safeParse({ ...LIMITS, maxTurns: 3 }).success, false);
    assert.equal(RunLimits.safeParse({ ...LIMITS, wallMs: 59_999 }).success, false);
    assert.equal(RunLimits.safeParse({ ...LIMITS, submitWindow: 11 }).success, false);
    assert.equal(RunLimits.safeParse({ ...LIMITS, maxCostCny: -1 }).success, false);
  });

  it('RunLimits：maxTurns 为 null 表示不限轮数，通过；旧记录的数字仍通过', () => {
    assert.equal(RunLimits.safeParse({ ...LIMITS, maxTurns: null }).success, true);
    assert.equal(RunLimits.safeParse({ ...LIMITS, maxTurns: 200 }).success, true);
    assert.equal(RunLimits.safeParse({ ...LIMITS, maxTurns: 201 }).success, false);
  });

  it('StopReason：12 个值全通过，未知值拒绝', () => {
    const all = [
      'cost-budget',
      'max-turns',
      'wall',
      'context-limit',
      'image-budget',
      'degenerate-loop',
      'stuck',
      'no-tool',
      'llm-error',
      'sandbox-unsupported',
      'internal-error',
      'cancelled',
    ];
    for (const reason of all) assert.equal(StopReason.safeParse(reason).success, true);
    assert.equal(StopReason.safeParse('unknown').success, false);
  });

  it('RenderVersion：完整对象通过，flags 非字符串数组拒绝', () => {
    assert.equal(RenderVersion.safeParse(RENDER_VERSION).success, true);
    assert.equal(RenderVersion.safeParse({ ...RENDER_VERSION, flags: [1] }).success, false);
  });

  it('PrecheckSummary：5 个分支各一例，多余字段拒绝', () => {
    const samples = [
      { kind: 'ok' },
      { kind: 'failed', total: 1, diagnostics: [] },
      { kind: 'too-large', bytes: 1, limit: 2 },
      { kind: 'timeout', limitMs: 300 },
      { kind: 'out-of-memory', limitMiB: 512 },
    ];
    for (const sample of samples) assert.equal(PrecheckSummary.safeParse(sample).success, true);
    assert.equal(PrecheckSummary.safeParse({ kind: 'ok', extra: 1 }).success, false);
  });

  it('PrecheckSummary：diagnostics.message 上限 2000，2000 通过、2001 拒绝', () => {
    const withMessage = (length: number): unknown => ({
      kind: 'failed',
      total: 1,
      diagnostics: [{ line: 1, column: 1, code: 'TS1234', message: 'x'.repeat(length) }],
    });
    assert.equal(PrecheckSummary.safeParse(withMessage(EVENT_TEXT_MAX)).success, true);
    assert.equal(PrecheckSummary.safeParse(withMessage(EVENT_TEXT_MAX + 1)).success, false);
  });

  it('RunSummary：build-error 的 name / message 也受 2000 上限约束', () => {
    const error = (length: number): unknown => ({
      kind: 'build-error',
      error: { name: 'Error', message: 'x'.repeat(length), line: 1, column: 1 },
      console: 0,
      wallMs: 1,
    });
    assert.equal(RunSummary.safeParse(error(EVENT_TEXT_MAX)).success, true);
    assert.equal(RunSummary.safeParse(error(EVENT_TEXT_MAX + 1)).success, false);
  });

  it('truncateEventText：不超长原样，超长截到上限并以标记结尾', () => {
    assert.equal(truncateEventText('x'.repeat(EVENT_TEXT_MAX)), 'x'.repeat(EVENT_TEXT_MAX));
    const long = truncateEventText('x'.repeat(5000));
    assert.equal(long.length, EVENT_TEXT_MAX);
    assert.ok(long.endsWith(TRUNCATION_MARK));
    assert.equal(long, `${'x'.repeat(EVENT_TEXT_MAX - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`);
  });

  it('clampEventBody：截断 check.result 的诊断与 build-error，且不修改入参', () => {
    const body = {
      codeVersion: 1,
      codeSha: SHA,
      seed: 1,
      precheck: {
        kind: 'failed' as const,
        total: 1,
        diagnostics: [{ line: 1, column: 1, code: 'TS1234', message: 'x'.repeat(5000) }],
      },
      run: null,
    };
    const clamped = clampEventBody('check.result', body);
    assert.equal(clamped.precheck.kind === 'failed' && clamped.precheck.diagnostics[0]?.message.length, EVENT_TEXT_MAX);
    assert.equal(body.precheck.diagnostics[0]?.message.length, 5000);
    const buildError = clampEventBody('check.result', {
      codeVersion: 1,
      codeSha: SHA,
      seed: 1,
      precheck: { kind: 'ok' },
      run: {
        kind: 'build-error',
        error: { name: 'n'.repeat(5000), message: 'm'.repeat(5000), line: 1, column: 1 },
        console: 0,
        wallMs: 1,
      },
    });
    assert.equal(buildError.run?.kind === 'build-error' && buildError.run.error.message.length, EVENT_TEXT_MAX);
    assert.equal(buildError.run?.kind === 'build-error' && buildError.run.error.name.length, EVENT_TEXT_MAX);
  });

  it('clampEventBody：无截断路径的 body 原样返回', () => {
    const body = { elapsedMs: 1, spentCny: 0 };
    assert.equal(clampEventBody('turn.start', body), body);
  });

  it('RunSummary：各分支各一例；crashed 的 detail 可选，旧记录仍可解析', () => {
    const ok = {
      kind: 'ok',
      hash: 'h',
      cells: 1,
      bounds: [0, 0, 0, 1, 1, 1],
      calls: 2,
      overlaps: { sameLayer: 0, crossLayer: 0 },
      console: 0,
      wallMs: 10,
    };
    const samples = [
      ok,
      { kind: 'build-error', error: { name: 'e', message: 'm', line: 1, column: 2 }, console: 0, wallMs: 3 },
      { kind: 'timeout', stderrHead: '', wallMs: 300 },
      { kind: 'too-large', bytes: 1, limit: 2 },
      // M1c 资产通道（决策 #114）：宿主注入的草模资产超限，四个字段逐项校验。
      { kind: 'assets-too-large', reason: 'documents-count', documents: 9, bytes: 123, limit: 8 },
    ];
    for (const sample of samples) assert.equal(RunSummary.safeParse(sample).success, true);
    assert.equal(RunSummary.safeParse({ ...ok, bounds: [0, 0] }).success, false);
    // assets-too-large：reason 枚举、非负计数与正上限都拦。
    const assets = { kind: 'assets-too-large', reason: 'total-bytes', documents: 1, bytes: 1, limit: 1 };
    assert.equal(RunSummary.safeParse({ ...assets, reason: 'nope' }).success, false);
    assert.equal(RunSummary.safeParse({ ...assets, documents: -1 }).success, false);
    assert.equal(RunSummary.safeParse({ ...assets, limit: 0 }).success, false);
    assert.equal(RunSummary.safeParse({ ...assets, extra: 1 }).success, false);
    // 新字段：报告超限的诊断数字。
    assert.equal(
      RunSummary.safeParse({
        kind: 'crashed',
        stderrHead: '',
        wallMs: 3,
        detail: { reportBytes: 1_400_000, limitBytes: 1024 * 1024, calls: 5000, overlaps: 12 },
      }).success,
      true,
    );
    // 旧记录：crashed 无 detail 仍可解析。
    assert.equal(RunSummary.safeParse({ kind: 'crashed', stderrHead: 'boom', wallMs: 3 }).success, true);
    // detail 不允许未知键。
    assert.equal(
      RunSummary.safeParse({ kind: 'crashed', stderrHead: '', wallMs: 3, detail: { reportBytes: 1 } }).success,
      false,
    );
  });

  it('eventsSchema：旧记录 2/3 与特许记录4通过，1/5拒绝', () => {
    for (const schema of [2, 3, 4]) {
      assert.equal(
        EVENT_SCHEMAS['run.start'].safeParse({
          ...(GOOD_BODIES['run.start'] as object),
          versions: { ...VERSIONS, eventsSchema: schema },
        }).success,
        true,
        `eventsSchema ${String(schema)}`,
      );
    }
    for (const schema of [1, 5]) {
      assert.equal(
        EVENT_SCHEMAS['run.start'].safeParse({
          ...(GOOD_BODIES['run.start'] as object),
          versions: { ...VERSIONS, eventsSchema: schema },
        }).success,
        false,
      );
    }
  });

  it('run.start.parent：可选；合法时通过，turn < 1 或缺 runId 拒绝', () => {
    const base = GOOD_BODIES['run.start'] as Record<string, unknown>;
    assert.equal(EVENT_SCHEMAS['run.start'].safeParse(base).success, true);
    const parent = { runId: '20261013-000000-task-abc123', dir: '../..', callId: 'call_1', turn: 1 };
    assert.equal(EVENT_SCHEMAS['run.start'].safeParse({ ...base, parent }).success, true);
    assert.equal(EVENT_SCHEMAS['run.start'].safeParse({ ...base, parent: { ...parent, turn: 0 } }).success, false);
    assert.equal(EVENT_SCHEMAS['run.start'].safeParse({ ...base, parent: { ...parent, runId: '' } }).success, false);
  });

  it('render.result.purpose 接受 massing（决策 #115）', () => {
    const body = GOOD_BODIES['render.result'] as Record<string, unknown>;
    assert.equal(EVENT_SCHEMAS['render.result'].safeParse({ ...body, purpose: 'massing' }).success, true);
    assert.equal(EVENT_SCHEMAS['render.result'].safeParse({ ...body, purpose: 'other' }).success, false);
  });

  it('subrun.result：status 枚举、金额非负、ordinal ≥ 1；未知状态值拒绝', () => {
    const base = GOOD_BODIES['subrun.result'] as Record<string, unknown>;
    assert.equal(EVENT_SCHEMAS['subrun.result'].safeParse(base).success, true);
    assert.equal(EVENT_SCHEMAS['subrun.result'].safeParse({ ...base, status: 'rejected' }).success, true);
    assert.equal(EVENT_SCHEMAS['subrun.result'].safeParse({ ...base, status: 'ok' }).success, false);
    assert.equal(EVENT_SCHEMAS['subrun.result'].safeParse({ ...base, costCny: -0.1 }).success, false);
    assert.equal(EVENT_SCHEMAS['subrun.result'].safeParse({ ...base, ordinal: 0 }).success, false);
  });

  it('code.version：via 接受 seed 与旧枚举 write_code / edit_code，未知值拒绝', () => {
    const base = { version: 1, code: REF, lines: 3 };
    for (const via of ['seed', 'write_code', 'edit_code']) {
      assert.equal(EVENT_SCHEMAS['code.version'].safeParse({ ...base, via }).success, true, via);
    }
    assert.equal(EVENT_SCHEMAS['code.version'].safeParse({ ...base, via: 'other' }).success, false);
  });

  it('Ref：sha256 必须 64 位十六进制，bytes 非负', () => {
    assert.equal(Ref.safeParse(REF).success, true);
    assert.equal(Ref.safeParse({ sha256: 'XYZ', bytes: 0 }).success, false);
    assert.equal(Ref.safeParse({ sha256: SHA, bytes: -1 }).success, false);
  });
});
