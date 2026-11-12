/**
 * derive 的测试（MODEL-SPEC §7.6、§9）：同一事件流派生两次相同；回放 run 列出版本差异；
 * 停止原因归类；无 run.end 时的兜底统计。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveTrace } from './derive.ts';
import { parseEvent, type Event, type EventType, type Versions } from './events.ts';

const SHA = 'a'.repeat(64);
const REF = { sha256: SHA, bytes: 4 };
const RUN_ID = '20261003-000000-adhoc-abc123';
const USAGE = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  prompt_cache_hit_tokens: 8,
  prompt_cache_miss_tokens: 2,
};
const TOTALS = {
  turns: 1,
  requests: 1,
  attempts: 1,
  promptTokens: 10,
  hitTokens: 8,
  missTokens: 2,
  completionTokens: 5,
  reasoningTokens: 0,
  costCny: 0.1,
  wallMs: 100,
  images: 0,
  imageBytes: 0,
};
const RENDER_VERSION = {
  protocol: 1,
  chrome: '120.0.0.0',
  puppeteer: '21.0.0',
  three: '0.160.0',
  flags: [],
  webglRenderer: 'SwiftShader',
  cpuModel: 'x86',
};

type VoxelVersions = Exclude<Versions, { target: 'modeling' }>;
function versions(overrides: Partial<VoxelVersions> = {}): Versions {
  return {
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
    ...overrides,
  };
}

function ev(seq: number, type: EventType, body: unknown, turn: number | null = 1): Event {
  return parseEvent({ v: 1, seq, ts: '2026-10-03T00:00:00.000Z', runId: RUN_ID, turn, type, body });
}

function runStartBody(mode: 'live' | 'script' | 'replay', versionOverrides: Partial<VoxelVersions> = {}): unknown {
  return {
    task: { sha256: SHA, source: null, fedSha256: SHA, fed: REF },
    seed: 7,
    mode,
    limits: { maxCostCny: 3.5, maxTurns: 60, wallMs: 2_400_000, submitWindow: 3 },
    guardConstants: { imageBytesSoft: 1, imageBytesHard: 2, contextTokens: 3, minMaxTokens: 4 },
    versions: versions(versionOverrides),
    config: null,
  };
}

it('GPT 未计费用null；缺失缓存不伪造零，保留原usage的独立缓存字段', () => {
  const start = ev(0, 'run.start', { ...zStart(), accounting: 'unmetered' });
  function zStart(): Record<string, unknown> {
    const value = runStartBody('live', { model: 'gpt-6.1-sol', eventsSchema: 4 });
    assert.ok(value !== null && typeof value === 'object');
    return { ...value };
  }
  const response = ev(1, 'llm.response', {
    outcome: 'ok',
    response: REF,
    finishReason: 'stop',
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 5 } },
    cny: null,
    model: 'gpt-6.1-sol',
    systemFingerprint: null,
    timing: { firstByteMs: 1, firstTokenMs: 1, totalMs: 2 },
    usageMismatch: false,
  });
  const attempt = ev(2, 'llm.attempt', {
    attempt: 1,
    outcome: 'ok',
    charge: 'unmetered',
    usage: null,
    failure: null,
    delayMs: null,
    settledCny: null,
    timing: { firstByteMs: 1, totalMs: 2 },
  });
  const trace = deriveTrace([start, response, attempt]);
  assert.equal(trace.accounting, 'unmetered');
  assert.equal(trace.totals.costCny, null);
  assert.equal(trace.totals.hitTokens, null);
  assert.equal(trace.totals.missTokens, null);
  assert.equal(trace.hitRate, null);
});

function baseEvents(mode: 'live' | 'script' | 'replay', versionOverrides: Partial<VoxelVersions> = {}): Event[] {
  return [
    ev(0, 'run.start', runStartBody(mode, versionOverrides), null),
    ev(1, 'versions.render', { render: RENDER_VERSION }),
    ev(2, 'turn.start', { elapsedMs: 100, spentCny: 0.1 }),
    ev(3, 'llm.request', {
      requestSha: SHA,
      manifest: REF,
      bodyBytes: 10,
      messages: 2,
      images: 0,
      imageBytes: 0,
      reserve: { cny: 0, maxTokens: 100, inputUpper: 10 },
    }),
    ev(4, 'llm.attempt', {
      attempt: 1,
      outcome: 'ok',
      failure: null,
      charge: 'usage',
      usage: USAGE,
      delayMs: null,
      timing: { firstByteMs: 1, totalMs: 2 },
      settledCny: 0.1,
    }),
    ev(5, 'llm.response', {
      outcome: 'ok',
      response: REF,
      finishReason: 'stop',
      usage: USAGE,
      cny: 0.1,
      model: 'deepseek-flash',
      systemFingerprint: null,
      timing: { firstByteMs: 1, firstTokenMs: 2, totalMs: 3 },
      usageMismatch: false,
    }),
  ];
}

describe('deriveTrace', () => {
  it('同一事件流派生两次深度相同', () => {
    const events = baseEvents('live');
    assert.deepEqual(deriveTrace(events), deriveTrace(events));
  });

  it('好样本：交付的 live run', () => {
    const events = [
      ...baseEvents('live'),
      ev(6, 'delivery', { code: REF, archive: REF, hash: 'h', codeVersion: 1, renders: [] }),
      ev(7, 'run.end', { stopReason: null, totals: TOTALS }),
    ];
    const trace = deriveTrace(events);
    assert.equal(trace.mode, 'live');
    assert.equal(trace.simulated, false);
    assert.equal(trace.delivered, true);
    assert.equal(trace.stopReason, null);
    assert.equal(trace.stopCategory, 'delivered');
    assert.equal(trace.hitRate, 0.8);
    assert.deepEqual(trace.totals, TOTALS);
    assert.deepEqual(trace.delivery, { codeVersion: 1, hash: 'h' });
    assert.equal(trace.render?.chrome, '120.0.0.0');
    assert.deepEqual(trace.versionDiff, []);
  });

  it('停止原因归类：budget / model-behavior / provider / host / cancelled', () => {
    const cases: readonly [string, string][] = [
      ['cost-budget', 'budget'],
      ['max-turns', 'budget'],
      ['wall', 'budget'],
      ['context-limit', 'budget'],
      ['image-budget', 'budget'],
      ['degenerate-loop', 'model-behavior'],
      ['stuck', 'model-behavior'],
      ['no-tool', 'model-behavior'],
      ['llm-error', 'provider'],
      ['sandbox-unsupported', 'host'],
      ['internal-error', 'host'],
      ['cancelled', 'cancelled'],
    ];
    for (const [reason, category] of cases) {
      const events = [
        ...baseEvents('script'),
        ev(6, 'run.end', {
          stopReason: reason,
          ...(reason === 'llm-error'
            ? { failure: { class: 'http', code: 'http_503', status: 503, retriable: true, message: 'busy' } }
            : {}),
          totals: TOTALS,
        }),
      ];
      const trace = deriveTrace(events);
      assert.equal(trace.stopCategory, category, reason);
      assert.equal(trace.simulated, true);
      if (reason === 'llm-error') assert.equal(trace.failure?.code, 'http_503');
    }
  });

  it('回放 run：列出与原 run 不同的版本项', () => {
    const original = baseEvents('live');
    const replay = baseEvents('replay', { pricing: 'ffffffffffff' });
    const trace = deriveTrace(replay, original);
    assert.equal(trace.mode, 'replay');
    assert.deepEqual(trace.versionDiff, ['pricing']);
    assert.equal(trace.simulated, true);
  });

  it('回放：旧 run 缺 promptVariant、新 run 为 base，不报差异', () => {
    const original = baseEvents('live');
    const replay = baseEvents('replay', { promptVariant: 'base' });
    assert.deepEqual(deriveTrace(replay, original).versionDiff, []);
  });

  it('回放：旧 run 缺 promptVariant、新 run 为 craft，报差异', () => {
    const original = baseEvents('live');
    const replay = baseEvents('replay', { promptVariant: 'craft' });
    assert.deepEqual(deriveTrace(replay, original).versionDiff, ['promptVariant']);
  });

  it('无 run.end 时用兜底统计', () => {
    const trace = deriveTrace(baseEvents('script'));
    assert.deepEqual(trace.totals, TOTALS);
    assert.equal(trace.stopReason, null);
  });

  it('无 run.end 时兜底统计加子运行花费；有 run.end 时以它为准，不双计', () => {
    const subrun = ev(6, 'subrun.result', {
      runId: 'massing-1',
      dir: 'sub/massing-1',
      callId: 'call_01_abc',
      ordinal: 1,
      status: 'success',
      reservedCny: 0.5,
      costCny: 0.25,
      turns: 2,
      text: REF,
    });
    const fallback = deriveTrace([...baseEvents('script'), subrun]);
    assert.equal(fallback.totals.costCny, TOTALS.costCny + 0.25);
    const withEnd = deriveTrace([
      ...baseEvents('script'),
      subrun,
      ev(7, 'run.end', { stopReason: null, totals: TOTALS }),
    ]);
    assert.deepEqual(withEnd.totals, TOTALS);
  });

  it('parent 与 subruns：子运行从 run.start.parent / subrun.result 派生；根运行两者都省略', () => {
    const parent = { runId: '20261013-000000-task-abc123', dir: '../..', callId: 'call_01_abc', turn: 3 };
    const events = [
      ev(0, 'run.start', { ...(runStartBody('script') as object), parent }, null),
      ev(1, 'subrun.result', {
        runId: 'massing-1',
        dir: 'sub/massing-1',
        callId: 'call_02_def',
        ordinal: 1,
        status: 'failed',
        stopReason: 'max-turns',
        reservedCny: 0.5,
        costCny: 0.01,
        turns: 20,
        text: REF,
      }),
      ev(2, 'run.end', { stopReason: 'cancelled', totals: TOTALS }),
    ];
    const trace = deriveTrace(events);
    assert.deepEqual(trace.parent, parent);
    assert.deepEqual(trace.subruns, [
      { runId: 'massing-1', dir: 'sub/massing-1', callId: 'call_02_def', status: 'failed', costCny: 0.01, turns: 20 },
    ]);
    const root = deriveTrace(baseEvents('script'));
    assert.equal(root.parent, undefined);
    assert.equal(root.subruns, undefined);
  });

  it('坏样本：缺 run.start，或 baseline 缺 run.start，都抛错', () => {
    assert.throws(() => deriveTrace([]), /需要一条 run\.start/);
    assert.throws(
      () => deriveTrace(baseEvents('replay'), [ev(0, 'turn.start', { elapsedMs: 0, spentCny: 0 })]),
      /baseline 缺 run\.start/,
    );
  });
});
