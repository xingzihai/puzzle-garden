/**
 * `formatConformanceSummary` 单测：合成 DiffReport 覆盖 fail bounds / roof pitch /
 * unverified opening / pass 排序、中文标签与 maxChars 截断。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DiffItem, DiffReport, DiffStatus } from '@pg/analysis/object-diff';

import { formatConformanceSummary } from './conformance-summary.ts';

function item(input: {
  readonly id: string;
  readonly kind: DiffItem['kind'];
  readonly expectedId: string | null;
  readonly actualId: string | null;
  readonly status: DiffStatus;
  readonly severity?: DiffItem['severity'];
  readonly expected?: DiffItem['expected'];
  readonly actual?: DiffItem['actual'];
  readonly delta?: DiffItem['delta'];
}): DiffItem {
  return {
    id: input.id,
    kind: input.kind,
    expectedId: input.expectedId,
    actualId: input.actualId,
    status: input.status,
    severity: input.severity ?? 'hard',
    expected: input.expected ?? null,
    actual: input.actual ?? null,
    delta: input.delta ?? {},
    evidence: [],
    reason: null,
  };
}

function reportOf(items: readonly DiffItem[]): DiffReport {
  const counts: Record<DiffStatus, number> = { pass: 0, fail: 0, missing: 0, extra: 0, unverified: 0 };
  let blockingCount = 0;
  for (const item of items) {
    counts[item.status] += 1;
    if (
      item.severity === 'hard' &&
      (item.status === 'fail' || item.status === 'missing' || item.status === 'unverified')
    ) {
      blockingCount += 1;
    }
  }
  return {
    schemaVersion: 1,
    measurement: {
      unit: 'voxel-cell',
      boundsConvention: 'half-open [min,max)',
      positionToleranceCells: 0,
      pitchToleranceDegrees: 2,
    },
    items,
    summary: {
      ...counts,
      blockingCount,
      blocking: blockingCount > 0,
      fullyVerified: counts.fail === 0 && counts.missing === 0 && counts.extra === 0 && counts.unverified === 0,
    },
    notCompared: {
      site: 0,
      furniture: 0,
      unknown: 0,
      total: 0,
      ids: { site: [], furniture: [], unknown: [] },
    },
    context: { openings: [] },
    notes: [],
  };
}

const passSlab = item({
  id: 'expected:slab:f1',
  kind: 'slab',
  expectedId: 'slab:f1',
  actualId: 'slab-union',
  status: 'pass',
  expected: { bounds: { min: [2, 0, 2], max: [12, 1, 10] } },
  actual: { bounds: { min: [2, 0, 2], max: [12, 1, 10] } },
});

const failWall = item({
  id: 'expected:wall:f1',
  kind: 'wall',
  expectedId: 'wall:f1',
  actualId: 'wall-union',
  status: 'fail',
  expected: { bounds: { min: [2, 1, 2], max: [12, 5, 10] } },
  actual: { bounds: { min: [2, 1, 2], max: [12, 6, 10] } },
  delta: {
    bounds: {
      expected: [2, 1, 2, 12, 5, 10],
      actual: [2, 1, 2, 12, 6, 10],
      delta: [0, 0, 0, 0, 1, 0],
    },
  },
});

const failRoof = item({
  id: 'expected:roof',
  kind: 'roof',
  expectedId: 'roof',
  actualId: 'roof-a',
  status: 'fail',
  expected: {
    bounds: { min: [1, 5, 1], max: [13, 10, 11] },
    form: 'gable',
    pitchDegrees: 45,
    eaveY: 5,
    ridgeY: 9,
  },
  actual: {
    bounds: { min: [1, 5, 1], max: [13, 9, 11] },
    roof: { formHint: 'gable', pitchDegrees: 25, eaveY: 5, ridgeY: 7 },
  },
  delta: {
    bounds: {
      expected: [1, 5, 1, 13, 10, 11],
      actual: [1, 5, 1, 13, 9, 11],
      delta: [0, 0, 0, 0, -1, 0],
    },
    pitchDegrees: { expected: 45, actual: 25, delta: -20 },
    ridgeY: { expected: 9, actual: 7, delta: -2 },
  },
});

const unverifiedOpening = item({
  id: 'expected:opening:op-entry-north',
  kind: 'opening',
  expectedId: 'opening:op-entry-north',
  actualId: null,
  status: 'unverified',
  expected: {
    bounds: { min: [5, 1, 2], max: [7, 3, 3] },
    width: 2,
    height: 2,
    sillY: 1,
    headY: 3,
  },
  actual: null,
});

const extraRoof = item({
  id: 'extra:roof:roof-x',
  kind: 'roof',
  expectedId: null,
  actualId: 'roof-x',
  status: 'extra',
  severity: 'soft',
  actual: {
    bounds: { min: [0, 4, 0], max: [4, 5, 4] },
    roof: { formHint: 'flat', pitchDegrees: 0, eaveY: 4, ridgeY: 4 },
  },
});

describe('formatConformanceSummary', () => {
  it('header 计数、非 pass 在前、pass 在后，并保留中文期望/实际/Δ 标签', () => {
    const text = formatConformanceSummary(reportOf([passSlab, failWall, failRoof, unverifiedOpening, extraRoof]));
    const lines = text.split('\n');
    assert.equal(
      lines[0],
      '一致性（仅报告，不拦截）：blocking 3 / expected 4｜pass 1、fail 2、unverified 1、missing 0、extra 1',
    );
    assert.match(lines[1] ?? '', /^- FAIL wall:f1 /);
    assert.match(lines[2] ?? '', /^- FAIL roof /);
    assert.match(lines[3] ?? '', /^- UNVERIFIED opening:op-entry-north /);
    assert.match(lines[4] ?? '', /^- EXTRA roof:roof-x /);
    assert.match(lines[5] ?? '', /^- PASS slab:f1 /);
    assert.equal(lines.length, 6);

    const wallLine = lines[1] ?? '';
    assert.match(wallLine, /期望 \[2,1,2\]\.\.\[12,5,10\] 实际 \[2,1,2\]\.\.\[12,6,10\] Δ \[0,0,0,0,1,0\]（bounds）/);

    const roofLine = lines[2] ?? '';
    assert.match(roofLine, /期望 .*form=gable pitch=45 eave=5 ridge=9/);
    assert.match(roofLine, /实际 .*form=gable pitch=25 eave=5 ridge=7/);
    assert.match(roofLine, /Δ -20（pitchDegrees）/);
    assert.match(roofLine, /Δ -2（ridgeY）/);

    const openingLine = lines[3] ?? '';
    assert.match(openingLine, /实际 无/);
    assert.match(openingLine, /width=2 height=2 sillY=1 headY=3/);
    assert.match(openingLine, /（blocking）$/);

    assert.doesNotMatch(lines[5] ?? '', /Δ/);
  });

  it('超过 maxChars 时安全截断，长度不超限且保留截断标记', () => {
    const report = reportOf([passSlab, failWall, failRoof, unverifiedOpening, extraRoof]);
    const text = formatConformanceSummary(report, 260);
    assert.ok(text.length <= 260, `length ${String(text.length)} > 260`);
    assert.ok(text.endsWith('…（已截断）'));
    assert.match(text, /^一致性（仅报告，不拦截）：blocking 3/);
  });
});
