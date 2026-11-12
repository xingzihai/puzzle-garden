/**
 * 报告截断的单元测试（SANDBOX-SPEC §5.3）：超限截断 overlaps、未超限/无法再缩时原样返回。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { createWorld } from '@pg/geometry';

import { childReportSchema } from './protocol.ts';
import type { ChildReport } from './protocol.ts';
import { limitReport, OVERLAPS_KEPT, reportByteLength } from './report-limit.ts';

function reportWith(overlaps: number, consoleText = ''): ChildReport {
  return {
    status: 'ok',
    hash: 'h',
    calls: 1,
    overlaps: Array.from({ length: overlaps }, (_, i) => ({
      kind: 'cross-layer' as const,
      winner: i + 1,
      loser: i + 2,
      cells: 1,
    })),
    console: consoleText === '' ? [] : [{ level: 'log' as const, text: consoleText }],
    consoleTruncated: 0,
  };
}

describe('limitReport', () => {
  test('未超限原样返回', () => {
    const report = reportWith(3);
    assert.equal(limitReport(report, reportByteLength(report) + 1), report);
  });

  test('超限：保留前 256 项、记被丢弃条数，仍过 schema', () => {
    const report = reportWith(300);
    const limited = limitReport(report, 100);
    assert.notEqual(limited, report);
    assert.equal(limited.overlaps.length, OVERLAPS_KEPT);
    assert.equal(limited.overlapsTruncated, 300 - OVERLAPS_KEPT);
    assert.deepEqual(limited.overlaps[0], report.overlaps[0]);
    assert.equal(childReportSchema.safeParse(limited).success, true);
  });

  test('超限但 overlaps ≤ 256（console 过大）无法再缩，原样返回', () => {
    const report = reportWith(2, 'x'.repeat(5000));
    assert.equal(limitReport(report, 100), report);
  });

  test('真实完整合成 >256 项：截断保留 summary 的分类、损失与有界样例，不从前256项重算', () => {
    let line = 7;
    const host = createWorld(loadRegistry().table, { callSite: () => line });
    for (let x = 0; x < 300; x++) host.world.set(x, 1, 0, 'smooth_sandstone_slab', 'decoration');
    line = 8;
    for (let x = 0; x < 300; x++) host.world.set(x, 1, 0, 'nether_brick_slab', 'structure');
    line = 9;
    host.world.set(299, 1, 0, 'stone', 'structure');
    const composition = host.compose();
    const report: ChildReport = {
      ...reportWith(0),
      overlaps: [...composition.overlaps],
      overlapSummary: composition.overlapSummary,
    };
    const limit = reportByteLength(report) - 1;
    const limited = limitReport(report, limit);
    assert.equal(limited.overlaps.length, 256);
    assert.equal(limited.overlapsTruncated, 45);
    assert.equal(limited.overlapSummary, report.overlapSummary);
    assert.equal(limited.overlapSummary?.sameLayer, 1);
    assert.equal(limited.overlapSummary.crossLayer, 300);
    assert.equal(limited.overlapSummary.lostDecor, 300);
    assert.deepEqual(
      limited.overlapSummary.groups.map((g) => g.cells),
      [299, 1],
    );
    assert.deepEqual(limited.overlapSummary.groups[0]?.sample, [0, 1, 0]);
    assert.equal(limited.overlapSummary.groups[0].sampleDetail.actualState, 'nether_brick_slab');
    assert.ok(reportByteLength(limited) < limit);
    assert.deepEqual(childReportSchema.parse(limited), limited);
    assert.equal(limitReport(limited, 1), limited);
    const alreadyDropped = limitReport({ ...report, overlapsTruncated: 5 }, limit);
    assert.equal(alreadyDropped.overlapsTruncated, 50);
    assert.equal(alreadyDropped.overlapSummary, report.overlapSummary);
  });
});
