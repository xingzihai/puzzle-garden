import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ReviewReport } from './review.ts';

function base() {
  return {
    designVersion: { schemeId: 'scheme-tea', revision: 2 },
    buildRunId: 'run-001',
    objective: {
      measurements: [
        {
          name: '建筑范围',
          expected: '12 × 10',
          actual: '12 × 10',
          unit: '格',
          status: 'pass',
          evidence: null,
        },
      ],
      notes: ['按 build-spec.json 对比'],
    },
    visual: {
      verdict: 'partial',
      strengths: ['檐口比例成立'],
      weaknesses: ['入口门槛不够清楚'],
      notes: [],
    },
    defects: [
      {
        id: 'def-1',
        category: 'construction',
        severity: 'minor',
        description: '入口门槛少做一级',
        evidence: '南立面截图',
        requirementIds: ['req-use'],
        suggestedAction: '补一级石门槛并保持净高',
      },
    ],
    verdict: {
      status: 'partial',
      musts: [{ requirementId: 'req-view', status: 'met', note: null }],
    },
    nextAction: {
      kind: 'targeted-revision',
      instructions: '只修入口门槛，不改布局',
      affectedSpaceIds: ['sp-entry'],
      affectedElementIds: ['el-floor'],
    },
  };
}

function messages(value: unknown): string {
  const result = ReviewReport.safeParse(value);
  if (result.success) throw new Error('期望解析失败，但通过了');
  return result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('；');
}

test('合法评审报告解析通过并冻结', () => {
  const report = ReviewReport.parse(base());
  assert.equal(report.defects[0]?.category, 'construction');
  assert.equal(report.nextAction.kind, 'targeted-revision');
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.verdict.musts), true);
  // 旧报告没有逐条证据字段；默认值必须补齐而不是解析失败。
  assert.deepEqual(report.verdict.musts[0]!.objects, []);
  assert.deepEqual(report.verdict.musts[0]!.evidence, []);
  assert.equal(report.verdict.musts[0]!.waiver, null);
  assert.equal(report.verdict.musts[0]!.text, null);
  assert.equal(report.verdict.mustsTruncated, false);
});

test('waived 是合法必须项状态，并保留显式用户豁免', () => {
  const parsed = ReviewReport.parse({
    ...base(),
    verdict: {
      status: 'partial',
      musts: [
        {
          requirementId: 'req-view',
          status: 'waived',
          note: '用户已豁免：接受现状',
          text: '南向观景窗',
          source: 'requirement',
          confidence: 'high',
          objects: [],
          evidence: [],
          waiver: {
            mustId: 'req-view',
            designRevision: 2,
            by: 'user',
            choice: '接受现状',
            conflictId: null,
            note: '甲方确认',
          },
          reason: null,
        },
      ],
    },
  });
  assert.equal(parsed.verdict.musts[0]?.status, 'waived');
  assert.equal(parsed.verdict.musts[0].waiver?.choice, '接受现状');
});

test('枚举与必填字段严格校验', () => {
  assert.match(messages({ ...base(), visual: { ...base().visual, verdict: 'good' } }), /visual\.verdict/);
  const missing = { ...base() } as Record<string, unknown>;
  delete missing['nextAction'];
  assert.match(messages(missing), /nextAction/);
  assert.match(messages({ ...base(), surprise: 1 }), /unrecognized key|Unrecognized key/i);
});

test('缺陷与必须项数量有上限', () => {
  const report = base();
  const many = Array.from({ length: 201 }, (_, index) => ({
    ...report.defects[0]!,
    id: `def-${String(index)}`,
  }));
  assert.equal(ReviewReport.safeParse({ ...report, defects: many }).success, false);
});
