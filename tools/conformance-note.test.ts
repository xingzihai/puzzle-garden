/**
 * 交付注记回归：只信 conformance 报告 / must-clause 证据，不复制设计者自述里的假通过结论。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatConformanceDeliveryNote } from './conformance-note.ts';
import type { ConformanceNoteInput } from './conformance-note.ts';

type ReportItem = NonNullable<ConformanceNoteInput['report']>['items'][number];

function reportItem(
  id: string,
  status: 'pass' | 'fail' | 'missing' | 'extra' | 'unverified',
  severity: 'hard' | 'soft',
  reason: string | null = null,
): ReportItem {
  return {
    id,
    expectedId: status === 'pass' ? id.replace('diff:', 'expected:') : null,
    status,
    severity,
    reason,
  };
}

const NOT_MET_MUSTS = [
  { mustId: 'must:entry-clearance', status: 'not-met', reason: '净宽 0.72m < 0.90m' },
  { mustId: 'must:roof-pitch', status: 'not-met', reason: '坡度 18° < 25°' },
  ...Array.from({ length: 20 }, (_, index) => {
    const number = index + 3;
    return {
      mustId: `must:not-met-${String(number)}`,
      status: 'not-met',
      reason: `第 ${String(number)} 条必须项未满足`,
    };
  }),
] as const;

const LIVE_LIKE_INPUT: ConformanceNoteInput = {
  report: {
    summary: {
      pass: 14,
      fail: 22,
      missing: 5,
      extra: 0,
      unverified: 5,
      blockingCount: 1,
      blocking: true,
    },
    items: [
      ...Array.from({ length: 14 }, (_, index) => reportItem(`diff:pass-${String(index + 1)}`, 'pass', 'hard')),
      reportItem('diff:door-width', 'fail', 'hard', '门洞净宽 0.72m < 0.90m'),
      ...Array.from({ length: 21 }, (_, index) => reportItem(`diff:fail-${String(index + 2)}`, 'fail', 'soft')),
      ...Array.from({ length: 5 }, (_, index) => reportItem(`diff:missing-${String(index + 1)}`, 'missing', 'soft')),
      ...Array.from({ length: 5 }, (_, index) =>
        reportItem(`diff:unverified-${String(index + 1)}`, 'unverified', 'soft'),
      ),
    ],
  },
  evidence: {
    summary: { met: 14, notMet: 22, waived: 5, unverified: 5, acceptEligible: false },
    musts: [
      ...Array.from({ length: 14 }, (_, index) => ({
        mustId: `must:met-${String(index + 1)}`,
        status: 'met',
        reason: null,
      })),
      ...NOT_MET_MUSTS,
      ...Array.from({ length: 5 }, (_, index) => ({
        mustId: `must:waived-${String(index + 1)}`,
        status: 'waived',
        reason: '甲方确认接受现状',
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        mustId: `must:unverified-${String(index + 1)}`,
        status: 'unverified',
        reason: '缺少测量证据',
      })),
    ],
    clauseSummary: {
      unattributedHardFails: ['report:global-slab-fail'],
      attributedHardFails: [
        {
          checkId: 'check:door-width',
          mustIds: ['must:entry-clearance', 'must:roof-pitch'],
          summary: '门洞净宽 0.72m < 0.90m，关联必须项未满足',
        },
      ],
    },
    clauseGroups: [
      {
        mustId: 'must:entry-clearance',
        status: 'not-met',
        leaves: [{ clauseId: 'clause:door-width', status: 'not-met', reason: '实测 0.72m' }],
      },
    ],
  },
  codeVersion: 7,
  hash: 'a'.repeat(64),
  runId: 'run-2026-10-22-001',
  selfReportedNote: 'check_code 一致性 5/5 PASS，blocking 0。全部必须项已满足。',
};

test('live-like 证据：输出真实计数与全部 not-met id，不复制设计者自述的假通过结论', () => {
  const note = formatConformanceDeliveryNote(LIVE_LIKE_INPUT);

  assert.match(note, /pass=14/);
  assert.match(note, /fail=22/);
  assert.match(note, /missing=5/);
  assert.match(note, /extra=0/);
  assert.match(note, /unverified=5/);
  assert.match(note, /blockingCount=1/);
  assert.match(note, /blocking=true/);
  assert.match(note, /met=14/);
  assert.match(note, /notMet=22/);
  assert.match(note, /waived=5/);
  assert.match(note, /acceptEligible=false/);

  for (const must of NOT_MET_MUSTS) {
    assert.ok(note.includes(must.mustId), `note missing not-met must ${must.mustId}`);
    assert.ok(note.includes(must.reason), `note missing reason for ${must.mustId}`);
  }

  assert.ok(note.includes('report:global-slab-fail'));
  assert.ok(note.includes('`check:door-width` -> `must:entry-clearance`、`must:roof-pitch`：门洞净宽 0.72m < 0.90m'));
  assert.ok(note.includes('设计者自述不参与判定'));

  assert.ok(!note.includes('5/5 PASS'));
  assert.ok(!note.includes('blocking 0'));
  assert.ok(!note.includes('全部必须项已满足'));
  assert.ok(!note.includes('- 可接受：'));

  const withDifferentSelfReport = formatConformanceDeliveryNote({
    ...LIVE_LIKE_INPUT,
    selfReportedNote: '另一份自述：一切都好。',
  });
  assert.equal(withDifferentSelfReport, note, '设计者自述不得影响注记正文');
});

test('报告与证据都缺失：明确不可用，不能声明通过或接受', () => {
  const note = formatConformanceDeliveryNote({
    report: null,
    evidence: null,
    codeVersion: null,
    hash: null,
    runId: null,
  });

  assert.match(note, /证据不可用/);
  assert.match(note, /不能声明验收通过或接受/);
  assert.match(note, /blockingCount：未知/);
  assert.match(note, /acceptEligible：未知/);
  assert.ok(!note.includes('PASS'));
  assert.ok(!note.includes('blocking 0'));
  assert.ok(!note.includes('- 可接受：'));
});

test('证据缺失但报告可用：只陈述报告数值，不能声明接受', () => {
  const note = formatConformanceDeliveryNote({
    report: {
      summary: { pass: 5, fail: 0, missing: 0, extra: 0, unverified: 0, blockingCount: 0, blocking: false },
      items: Array.from({ length: 5 }, (_, index) => reportItem(`diff:pass-${String(index + 1)}`, 'pass', 'hard')),
    },
    evidence: null,
    codeVersion: 3,
    hash: 'd'.repeat(64),
    runId: 'run-2026-10-22-004',
  });

  assert.match(note, /pass=5/);
  assert.match(note, /blockingCount=0/);
  assert.match(note, /acceptEligible：未知/);
  assert.match(note, /证据不完整/);
  assert.ok(!note.includes('PASS'));
  assert.ok(!note.includes('blocking 0'));
  assert.ok(!note.includes('- 可接受：'));
});

test('干净证据：全部 met 且无阻断时才给出可接受结论', () => {
  const note = formatConformanceDeliveryNote({
    report: {
      summary: { pass: 5, fail: 0, missing: 0, extra: 0, unverified: 0, blockingCount: 0, blocking: false },
      items: Array.from({ length: 5 }, (_, index) => reportItem(`diff:pass-${String(index + 1)}`, 'pass', 'hard')),
    },
    evidence: {
      summary: { met: 5, notMet: 0, waived: 0, unverified: 0, acceptEligible: true },
      musts: Array.from({ length: 5 }, (_, index) => ({
        mustId: `must:met-${String(index + 1)}`,
        status: 'met',
        reason: null,
      })),
      clauseSummary: { unattributedHardFails: [], attributedHardFails: [] },
    },
    codeVersion: 9,
    hash: 'c'.repeat(64),
    runId: 'run-2026-10-22-003',
  });

  assert.ok(note.includes('- 可接受：'));
  assert.match(note, /blockingCount=0/);
  assert.match(note, /blocking=false/);
  assert.match(note, /acceptEligible=true/);
  assert.match(note, /### 未归因 hard fail\n- 无/);
});

test('已归因 hard fail 必须写出 checkId -> mustIds', () => {
  const note = formatConformanceDeliveryNote({
    report: {
      summary: { pass: 3, fail: 0, missing: 0, extra: 0, unverified: 0, blockingCount: 0, blocking: false },
      items: [
        reportItem('diff:pass-1', 'pass', 'hard'),
        reportItem('diff:pass-2', 'pass', 'hard'),
        reportItem('diff:pass-3', 'pass', 'hard'),
      ],
    },
    evidence: {
      summary: { met: 1, notMet: 1, waived: 0, unverified: 0, acceptEligible: false },
      musts: [{ mustId: 'must:door', status: 'not-met', reason: '门洞净宽不足' }],
      clauseSummary: {
        unattributedHardFails: [],
        attributedHardFails: [
          {
            checkId: 'check:door-width',
            mustIds: ['must:door-width', 'must:door-height'],
            summary: '净宽 0.72m < 0.90m',
          },
        ],
      },
    },
    codeVersion: 8,
    hash: 'b'.repeat(64),
    runId: 'run-2026-10-22-002',
  });

  assert.ok(note.includes('`check:door-width` -> `must:door-width`、`must:door-height`：净宽 0.72m < 0.90m'));
  assert.match(note, /### 未归因 hard fail\n- 无/);
  assert.ok(!note.includes('- 可接受：'));
});

test('无 must 覆盖的 globalBlocker：必须写出理由并阻断接受', () => {
  const note = formatConformanceDeliveryNote({
    report: {
      summary: { pass: 5, fail: 0, missing: 0, extra: 0, unverified: 0, blockingCount: 0, blocking: false },
      items: Array.from({ length: 5 }, (_, index) => reportItem(`diff:pass-${String(index + 1)}`, 'pass', 'hard')),
    },
    evidence: {
      summary: { met: 5, notMet: 0, waived: 0, unverified: 0, acceptEligible: false },
      musts: Array.from({ length: 5 }, (_, index) => ({
        mustId: `must:met-${String(index + 1)}`,
        status: 'met',
        reason: null,
      })),
      clauseSummary: {
        unattributedHardFails: [],
        globalBlockers: ['furniture:f-light-ridge-e: no must covers this expected furniture'],
        attributedHardFails: [],
      },
    },
    codeVersion: 13,
    hash: 'e'.repeat(64),
    runId: 'run-2026-10-22-006',
  });
  assert.ok(!note.includes('- 可接受：'));
  assert.match(note, /### 无必须项覆盖的全局阻断\n- `furniture:f-light-ridge-e:/);
  assert.match(note, /f-light-ridge-e/);
});

test('clauseSummary 缺 attributedHardFails 数组：不能声明接受', () => {
  const note = formatConformanceDeliveryNote({
    report: {
      summary: { pass: 5, fail: 0, missing: 0, extra: 0, unverified: 0, blockingCount: 0, blocking: false },
      items: Array.from({ length: 5 }, (_, index) => reportItem(`diff:pass-${String(index + 1)}`, 'pass', 'hard')),
    },
    evidence: {
      summary: { met: 5, notMet: 0, waived: 0, unverified: 0, acceptEligible: true },
      musts: Array.from({ length: 5 }, (_, index) => ({
        mustId: `must:met-${String(index + 1)}`,
        status: 'met',
        reason: null,
      })),
      clauseSummary: { unattributedHardFails: [] },
    },
    codeVersion: 9,
    hash: 'c'.repeat(64),
    runId: 'run-2026-10-22-004',
  });
  assert.ok(!note.includes('- 可接受：'));
  assert.match(note, /attributedHardFails 数组|证据不完整/);
});

test('summary 与 musts 明细计数不一致：不能声明接受', () => {
  const note = formatConformanceDeliveryNote({
    report: {
      summary: { pass: 1, fail: 0, missing: 0, extra: 0, unverified: 0, blockingCount: 0, blocking: false },
      items: [reportItem('diff:pass-1', 'pass', 'hard')],
    },
    evidence: {
      summary: { met: 1, notMet: 0, waived: 0, unverified: 0, acceptEligible: true },
      musts: [{ mustId: 'must:hidden', status: 'unverified', reason: 'missing evidence' }],
      clauseSummary: { unattributedHardFails: [], attributedHardFails: [] },
    },
    codeVersion: 9,
    hash: 'd'.repeat(64),
    runId: 'run-2026-10-22-005',
  });
  assert.ok(!note.includes('- 可接受：'));
  assert.match(note, /evidence.summary 与 musts 明细不一致/);
});
