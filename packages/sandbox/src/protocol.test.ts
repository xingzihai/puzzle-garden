import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createModel } from '@pg/modeling/model';

import {
  CHILD_PROTOCOL_VERSION,
  childInputSchema,
  childReportSchema,
  diagnosticSchema,
  massingAssetsSchema,
  MAX_CODE_BYTES,
  overlapSchema,
  overlapSummarySchema,
  REPORT_FORMAT_VERSION,
  precheckResultSchema,
  runInputSchema,
  workerDataSchema,
  workerReadySchema,
  workerRequestSchema,
  workerResponseSchema,
} from './protocol.ts';

const diagnostic = { line: 2, column: 5, code: 'TS2339', message: 'Property x', source: 'w.x;' };

/** 一份最小的合法 ModelDocument，供资产 schema 用。 */
function sampleDocument(): unknown {
  const model = createModel();
  model.box({ id: 'room', name: '房间', role: 'volume', color: '#123456', size: [2, 2, 2] });
  return model.finish();
}

describe('protocol', () => {
  test('诊断 schema 接受合法结构、拒绝越界行列', () => {
    assert.deepEqual(diagnosticSchema.parse(diagnostic), diagnostic);
    assert.equal(diagnosticSchema.safeParse({ ...diagnostic, line: 0 }).success, false);
    assert.equal(diagnosticSchema.safeParse({ ...diagnostic, column: 0 }).success, false);
  });

  test('结果 schema 覆盖五种 kind', () => {
    assert.deepEqual(precheckResultSchema.parse({ kind: 'ok' }), { kind: 'ok' });
    assert.deepEqual(precheckResultSchema.parse({ kind: 'failed', diagnostics: [diagnostic], total: 1 }), {
      kind: 'failed',
      diagnostics: [diagnostic],
      total: 1,
    });
    assert.deepEqual(precheckResultSchema.parse({ kind: 'too-large', bytes: 10, limit: 5 }), {
      kind: 'too-large',
      bytes: 10,
      limit: 5,
    });
    assert.deepEqual(precheckResultSchema.parse({ kind: 'timeout', limitMs: 2000 }), {
      kind: 'timeout',
      limitMs: 2000,
    });
    assert.deepEqual(precheckResultSchema.parse({ kind: 'out-of-memory', limitMiB: 1024 }), {
      kind: 'out-of-memory',
      limitMiB: 1024,
    });
    assert.equal(precheckResultSchema.safeParse({ kind: 'unknown' }).success, false);
  });

  test('worker 请求 / 响应 schema', () => {
    assert.deepEqual(workerRequestSchema.parse({ id: 1, code: 'x' }), { id: 1, code: 'x' });
    assert.equal(workerRequestSchema.safeParse({ id: 0, code: 'x' }).success, false);
    assert.deepEqual(workerResponseSchema.parse({ ok: true, id: 1, result: { kind: 'ok' } }), {
      ok: true,
      id: 1,
      result: { kind: 'ok' },
    });
    assert.deepEqual(
      workerResponseSchema.parse({ ok: false, id: 2, error: { code: 'invalid-declaration', message: 'bad' } }),
      { ok: false, id: 2, error: { code: 'invalid-declaration', message: 'bad' } },
    );
    assert.equal(
      workerResponseSchema.safeParse({ ok: false, id: 2, error: { code: 'nope', message: 'bad' } }).success,
      false,
    );
  });

  test('workerData schema', () => {
    assert.deepEqual(workerDataSchema.parse({ declaration: 'd' }), { declaration: 'd' });
    assert.equal(workerDataSchema.safeParse({ declaration: 1 }).success, false);
  });

  test('F6：runCode 输入与 worker 请求的 code 共用 256 KiB 上限', () => {
    const limit = MAX_CODE_BYTES;
    assert.equal(limit, 256 * 1024);
    const max = 'x'.repeat(limit);
    assert.equal(runInputSchema.safeParse({ code: max, seed: 0 }).success, true);
    assert.equal(runInputSchema.safeParse({ code: `${max}x`, seed: 0 }).success, false);
    assert.equal(runInputSchema.safeParse({ code: 'x'.repeat(limit + 1), seed: 0 }).success, false);
    assert.equal(workerRequestSchema.safeParse({ id: 1, code: 'x'.repeat(limit + 1) }).success, false);
    // 多字节字符按 UTF-8 字节算：半数的 2 字节字符正好到限。
    const multibyte = 'é'.repeat(limit / 2);
    assert.equal(runInputSchema.safeParse({ code: multibyte, seed: 0 }).success, true);
    assert.equal(runInputSchema.safeParse({ code: `${multibyte}é`, seed: 0 }).success, false);
  });

  test('F7：就绪消息 schema', () => {
    assert.deepEqual(workerReadySchema.parse({ type: 'ready' }), { type: 'ready' });
    assert.equal(workerReadySchema.safeParse({ type: 'nope' }).success, false);
  });

  test('决策 #92：覆盖项可带 lostDecor / sample，非法值与多余字段拒绝', () => {
    const base = { kind: 'cross-layer', winner: 5, loser: 12, cells: 36 } as const;
    assert.deepEqual(overlapSchema.parse(base), base);
    const withLost = { ...base, lostDecor: 36, sample: [2, 25, 3] };
    assert.deepEqual(overlapSchema.parse(withLost), withLost);
    // same-layer 也可以原样不带这两个字段。
    assert.deepEqual(overlapSchema.parse({ kind: 'same-layer', winner: 3, loser: 2, cells: 1 }), {
      kind: 'same-layer',
      winner: 3,
      loser: 2,
      cells: 1,
    });
    // lostDecor 必须为正整数，sample 必须是三个整数，strictObject 仍拒绝多余字段。
    assert.equal(overlapSchema.safeParse({ ...base, lostDecor: 0 }).success, false);
    assert.equal(overlapSchema.safeParse({ ...base, lostDecor: -1 }).success, false);
    assert.equal(overlapSchema.safeParse({ ...base, lostDecor: 1.5 }).success, false);
    assert.equal(overlapSchema.safeParse({ ...base, sample: [1, 2] }).success, false);
    assert.equal(overlapSchema.safeParse({ ...base, sample: [1, 2, 3, 4] }).success, false);
    assert.equal(overlapSchema.safeParse({ ...base, sample: [1, 2, 3.5] }).success, false);
    assert.equal(overlapSchema.safeParse({ ...base, extra: 1 }).success, false);
  });

  test('child 报告接受带 lostDecor / sample 的覆盖项', () => {
    const report = {
      status: 'ok',
      hash: 'h',
      calls: 2,
      overlaps: [{ kind: 'cross-layer', winner: 2, loser: 1, cells: 36, lostDecor: 36, sample: [2, 25, 3] }],
      console: [],
      consoleTruncated: 0,
    };
    assert.deepEqual(childReportSchema.parse(report), report);
  });

  test('报告格式2的 detail 必须绑定跨层损失样例，旧报告仍可读，未知版本拒绝', () => {
    const sampleDetail = {
      expectedState: 'stone_slab[type=top]',
      actualState: 'glass',
      winnerSource: { api: 'opening', line: 8, writeLayer: 'opening' },
      loserSource: { api: 'set', line: 7, writeLayer: 'decoration' },
    };
    const overlap = {
      kind: 'cross-layer',
      winner: 2,
      loser: 1,
      cells: 1,
      lostDecor: 1,
      sample: [0, 1, 0],
      sampleDetail,
    };
    assert.deepEqual(overlapSchema.parse(overlap), overlap);
    for (const bad of [
      { ...overlap, kind: 'same-layer' },
      { ...overlap, lostDecor: undefined },
      { ...overlap, sample: undefined },
      { ...overlap, sampleDetail: { ...sampleDetail, expectedState: '' } },
      { ...overlap, sampleDetail: { ...sampleDetail, actualState: '' } },
      { ...overlap, sampleDetail: { ...sampleDetail, extra: true } },
      { ...overlap, sampleDetail: { ...sampleDetail, winnerSource: { ...sampleDetail.winnerSource, line: -1 } } },
      {
        ...overlap,
        sampleDetail: { ...sampleDetail, loserSource: { ...sampleDetail.loserSource, writeLayer: 'other' } },
      },
    ])
      assert.equal(overlapSchema.safeParse(bad).success, false);
    const legacy = { status: 'ok', hash: 'h', calls: 2, overlaps: [], console: [], consoleTruncated: 0 };
    assert.deepEqual(childReportSchema.parse(legacy), legacy);
    assert.equal(REPORT_FORMAT_VERSION, 2);
    assert.equal(childReportSchema.safeParse({ ...legacy, reportFormat: 1 }).success, true);
    assert.equal(childReportSchema.safeParse({ ...legacy, reportFormat: REPORT_FORMAT_VERSION }).success, true);
    assert.equal(childReportSchema.safeParse({ ...legacy, reportFormat: 3 }).success, false);
  });

  test('summary 有界、字段严格且数量非负；同状态与零损失报告不伪造材质变化', () => {
    const group = {
      winner: 2,
      loser: 1,
      cells: 1,
      sample: [0, 1, 0],
      sampleDetail: {
        expectedState: 'stone',
        actualState: 'stone',
        winnerSource: { api: 'set', line: 0, writeLayer: 'structure' },
        loserSource: { api: 'set', line: 0, writeLayer: 'decoration' },
      },
    };
    const summary = { sameLayer: 0, crossLayer: 1, lostDecor: 1, groups: [group], groupsOmitted: 0 };
    assert.deepEqual(overlapSummarySchema.parse(summary), summary);
    assert.equal(overlapSummarySchema.safeParse({ ...summary, lostDecor: 0, groups: [] }).success, true);
    for (const bad of [
      { ...summary, sameLayer: -1 },
      { ...summary, crossLayer: 1.5 },
      { ...summary, lostDecor: -1 },
      { ...summary, groupsOmitted: -1 },
      { ...summary, extra: 0 },
      { ...summary, groups: [group, group, group, group] },
      { ...summary, groups: [{ ...group, cells: 0 }] },
      { ...summary, groups: [{ ...group, sample: [1, 2] }] },
      { ...summary, groups: [{ ...group, sampleDetail: undefined }] },
    ])
      assert.equal(overlapSummarySchema.safeParse(bad).success, false);
    const report = {
      status: 'ok',
      hash: 'h',
      calls: 2,
      overlaps: [],
      console: [],
      consoleTruncated: 0,
      overlapSummary: summary,
    };
    assert.deepEqual(childReportSchema.parse(report), report);
  });

  test('报告截断：接受正整数 overlapsTruncated，拒绝 0 / 负 / 非整数 / 多余字段', () => {
    const base = { status: 'ok', hash: 'h', calls: 1, overlaps: [], console: [], consoleTruncated: 0 };
    assert.deepEqual(childReportSchema.parse({ ...base, overlapsTruncated: 5 }), { ...base, overlapsTruncated: 5 });
    assert.equal(childReportSchema.safeParse({ ...base, overlapsTruncated: 0 }).success, false);
    assert.equal(childReportSchema.safeParse({ ...base, overlapsTruncated: -1 }).success, false);
    assert.equal(childReportSchema.safeParse({ ...base, overlapsTruncated: 1.5 }).success, false);
    assert.equal(childReportSchema.safeParse({ ...base, extra: 1 }).success, false);
  });

  test('资产 schema（MASSING-CONVERSION-SPEC §5.2）：协议版本 2、id 规则、family / rgb 与严格字段', () => {
    assert.equal(CHILD_PROTOCOL_VERSION, 2);
    const candidate = { id: 'stone_bricks', rgb: 0x7a7a7a, family: 'stone' };
    const document = { id: 'hall', document: sampleDocument() };
    const assets = { documents: [document], colorCandidates: [candidate] };
    assert.equal(massingAssetsSchema.safeParse(assets).success, true);
    assert.equal(runInputSchema.safeParse({ code: 'x', seed: 0, assets }).success, true);
    assert.equal(
      childInputSchema.safeParse({
        protocol: CHILD_PROTOCOL_VERSION,
        code: 'x',
        seed: 0,
        apiVersion: 8,
        limits: { consoleBytes: 1 },
        assets,
      }).success,
      true,
    );
    // 缺省 assets 仍然合法（既有输入形状不变）。
    assert.equal(massingAssetsSchema.safeParse({ documents: [], colorCandidates: [] }).success, true);
    assert.equal(runInputSchema.safeParse({ code: 'x', seed: 0 }).success, true);
    // 文档 id：小写字母或数字开头，可含 _ / - / #（# 给 massing#N 句柄），最长 64。
    for (const id of ['Hall', '', '-x', 'a'.repeat(65), 'a b', 'a.b', '#x', '#massing']) {
      assert.equal(
        massingAssetsSchema.safeParse({ ...assets, documents: [{ id, document: document.document }] }).success,
        false,
        `id ${JSON.stringify(id)} 应被拒绝`,
      );
    }
    for (const id of ['a', 'a-1', 'a_b', '0', 'a'.repeat(64), 'massing#1', 'a#b']) {
      assert.equal(
        massingAssetsSchema.safeParse({ ...assets, documents: [{ id, document: document.document }] }).success,
        true,
        `id ${JSON.stringify(id)} 应被接受`,
      );
    }
    // family 收窄到 blocks 的材质族；rgb 必须是 0x000000–0xffffff 整数。
    assert.equal(
      massingAssetsSchema.safeParse({ ...assets, colorCandidates: [{ ...candidate, family: 'nope' }] }).success,
      false,
    );
    assert.equal(
      massingAssetsSchema.safeParse({ ...assets, colorCandidates: [{ ...candidate, rgb: 0x1000000 }] }).success,
      false,
    );
    assert.equal(
      massingAssetsSchema.safeParse({ ...assets, colorCandidates: [{ ...candidate, rgb: 1.5 }] }).success,
      false,
    );
    // strictObject：顶层、文档条目、候选条目都不接受多余字段。
    assert.equal(massingAssetsSchema.safeParse({ ...assets, extra: 1 }).success, false);
    assert.equal(massingAssetsSchema.safeParse({ ...assets, documents: [{ ...document, extra: 1 }] }).success, false);
    assert.equal(
      massingAssetsSchema.safeParse({ ...assets, colorCandidates: [{ ...candidate, extra: 1 }] }).success,
      false,
    );
  });
});
