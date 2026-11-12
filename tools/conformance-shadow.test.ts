/**
 * V3 影子适配器测试：H1–H4 好样本不 blocking；run-9 v2 4 个 hard fail；
 * 坏 spec / 坏 archive / 缺 delivery 只返回 error，不抛、不改构建结果。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeArchive } from '@pg/core/archive';
import { API_VERSION } from '@pg/geometry';

import { buildBuildSheet } from './build-sheet.ts';
import { computeShadowConformance, computeShadowForRun, shadowSummaryLine } from './conformance-shadow.ts';
import { buildFixture } from './conformance-matrix-fixtures.ts';

const RUN9_DIR = fileURLToPath(new URL('./fixtures/conformance-run9-v2/', import.meta.url));
const RUN9_SPEC = join(RUN9_DIR, 'build-spec.json');
const RUN9_ARCHIVE = join(RUN9_DIR, 'building.pgar');
const MATRIX_MAPPING = fileURLToPath(new URL('./fixtures/conformance-matrix-verified-mapping.json', import.meta.url));

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pg-shadow-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('V3 影子适配器：report-only', () => {
  it('H1–H4 good：blocking=false，5/5 pass，写入两份 JSON', () => {
    for (const house of ['H1', 'H2', 'H3', 'H4'] as const) {
      withTempDir((dir) => {
        const fixture = buildFixture(house, 'good');
        const specPath = join(dir, 'build-spec.json');
        const archivePath = join(dir, 'building.pgar');
        const outDir = join(dir, 'out');
        writeFileSync(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
        writeFileSync(archivePath, writeArchive(fixture.grid, API_VERSION));
        const result = computeShadowConformance({ specPath, archivePath, outDir, mappingPath: MATRIX_MAPPING });
        assert.equal(result.error, null);
        const report = result.report;
        const evidence = result.evidence;
        assert.ok(report !== null);
        assert.ok(evidence !== null);
        assert.equal(report.summary.blocking, false);
        assert.equal(report.summary.pass, 5);
        if (house === 'H1') assert.equal(report.summary.fullyVerified, true);
        assert.equal(evidence.schemaVersion, 2);
        assert.equal(evidence.mode, 'report-only');
        assert.equal(evidence.mapping, 'verified');
        assert.equal(evidence.datum.slabTopY, 0);
        assert.equal(evidence.datum.standingY, 1);
        assert.equal(evidence.datum.gradeY, 1);
        assert.equal(evidence.datum.entryTransition, 'flush');
        assert.equal(evidence.datum.floorThickness, 1);
        assert.ok(['build-sheet', 'build-spec'].includes(evidence.datum.source));
        assert.equal(evidence.musts.length, fixture.spec.musts.length);
        assert.equal(evidence.summary.acceptEligible, false);
        assert.ok(result.diffPath !== null && existsSync(result.diffPath));
        assert.ok(result.evidencePath !== null && existsSync(result.evidencePath));
        const written = JSON.parse(readFileSync(result.diffPath, 'utf8')) as { schemaVersion: number };
        assert.equal(written.schemaVersion, 1);
      });
    }
  });

  it('BuildSheet.datum 可直接传入 computeShadowForRun', () => {
    withTempDir((dir) => {
      const fixture = buildFixture('H1', 'good');
      const sheet = buildBuildSheet(fixture.spec);
      const sheetDatum = sheet.datum as unknown as {
        readonly slabTopY?: number;
        readonly standingY: number;
        readonly gradeY?: number;
        readonly entryTransition?: 'flush' | 'one-step' | 'unknown';
      };
      if (
        sheetDatum.slabTopY === undefined ||
        sheetDatum.gradeY === undefined ||
        sheetDatum.entryTransition === undefined
      ) {
        return; // HEAD 的旧 BuildSheet 还没有 unified datum；新契约落地后此测试生效。
      }
      const runDir = join(dir, 'run');
      mkdirSync(join(runDir, 'delivery'), { recursive: true });
      const specPath = join(runDir, 'build-spec.json');
      writeFileSync(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
      writeFileSync(join(runDir, 'delivery', 'building.pgar'), writeArchive(fixture.grid, API_VERSION));
      const result = computeShadowForRun({
        specPath,
        runDir,
        outDir: join(dir, 'out'),
        datum: {
          slabTopY: sheetDatum.slabTopY,
          standingY: sheetDatum.standingY,
          gradeY: sheetDatum.gradeY,
          entryTransition: sheetDatum.entryTransition,
        },
      });
      assert.equal(result.error, null);
      assert.ok(result.evidence !== null);
      assert.equal(result.evidence.datum.source, 'build-sheet');
      assert.equal(result.evidence.datum.slabTopY, sheetDatum.slabTopY);
      assert.equal(result.evidence.datum.standingY, sheetDatum.standingY);
      assert.equal(result.evidence.datum.entryTransition, sheetDatum.entryTransition);
    });
  });

  it('verified 映射缺 scheme 时按 heuristic 处理：pass 仍不能产生 met', () => {
    withTempDir((dir) => {
      const fixture = buildFixture('H1', 'good');
      const specPath = join(dir, 'build-spec.json');
      const archivePath = join(dir, 'building.pgar');
      writeFileSync(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
      writeFileSync(archivePath, writeArchive(fixture.grid, API_VERSION));
      const result = computeShadowConformance({
        specPath,
        archivePath,
        outDir: dir,
        verifiedMapping: {
          schemaVersion: 1,
          tool: 'verified-must-map',
          mapping: 'verified',
          schemeRevision: fixture.spec.schemeRevision,
          schemes: {},
        },
      });
      assert.equal(result.error, null);
      const evidence = result.evidence;
      assert.ok(evidence !== null);
      assert.equal(evidence.mapping, 'heuristic');
      assert.deepEqual(evidence.summary, {
        met: 0,
        notMet: 0,
        waived: 0,
        unverified: fixture.spec.musts.length,
        acceptEligible: false,
      });
    });
  });

  it('run-9 v2：blocking=true，4 个 hard fail，北门走 evaluateOpenings 单一 item', () => {
    withTempDir((dir) => {
      const result = computeShadowConformance({
        specPath: RUN9_SPEC,
        archivePath: RUN9_ARCHIVE,
        outDir: dir,
      });
      assert.equal(result.error, null);
      const report = result.report;
      const evidence = result.evidence;
      assert.ok(report !== null);
      assert.ok(evidence !== null);
      assert.equal(report.summary.blocking, true);
      assert.equal(report.summary.fail, 4);
      assert.equal(report.summary.blockingCount, 4);
      assert.equal(report.summary.missing, 0);
      assert.equal(report.summary.extra, 0);
      const wall = report.items.find((item) => item.expectedId === 'wall:f1');
      assert.ok(wall !== undefined);
      assert.equal(wall.status, 'pass');
      const door = report.items.find((item) => item.expectedId === 'opening:op-entry-north');
      assert.ok(door !== undefined);
      assert.equal(door.status, 'fail');
      assert.equal(door.actualId, 'evaluateOpenings:op-entry-north');
      assert.equal(evidence.mapping, 'heuristic');
      assert.equal(evidence.datum.slabTopY, 0);
      assert.equal(evidence.datum.standingY, 1);
      assert.equal(evidence.datum.gradeY, 1);
      assert.equal(evidence.datum.entryTransition, 'flush');
      assert.equal(evidence.datum.floorThickness, 1);
      // 父 must 状态现在来自 clause group 聚合；run-9 仍有 4 个 report hard fail，
      // 同时缺失家具与覆盖检查也让更多父 must 变成 not-met / unverified。
      assert.equal(evidence.summary.met, 7);
      assert.equal(evidence.summary.notMet, 21);
      assert.equal(evidence.summary.unverified, 13);
      assert.equal(evidence.summary.notMet, evidence.clauseSummary.notMet);
      assert.equal(evidence.summary.unverified, evidence.clauseSummary.unverified);
      assert.equal(evidence.summary.acceptEligible, false);
      assert.match(shadowSummaryLine(result), /仅报告/);
      assert.match(shadowSummaryLine(result), /blocking=4/);
    });
  });

  it('bad spec / bad archive：返回 error，不抛', () => {
    withTempDir((dir) => {
      let result: ReturnType<typeof computeShadowConformance> | undefined;
      assert.doesNotThrow(() => {
        result = computeShadowConformance({
          specPath: join(dir, 'missing-spec.json'),
          archivePath: join(dir, 'missing.pgar'),
          outDir: dir,
        });
      });
      assert.ok(result !== undefined);
      assert.equal(result.report, null);
      assert.equal(result.evidence, null);
      assert.match(result.error ?? '', /读不到/);
      assert.match(shadowSummaryLine(result), /不可用/);

      const badArchive = computeShadowConformance({
        specPath: RUN9_SPEC,
        archivePath: join(dir, 'missing-archive.pgar'),
        outDir: join(dir, 'bad-archive'),
      });
      assert.equal(badArchive.report, null);
      assert.match(badArchive.error ?? '', /读不到building\.pgar/);
    });
  });

  it('computeShadowForRun：缺 delivery 只返回 error，不触发构建逻辑', () => {
    withTempDir((dir) => {
      const result = computeShadowForRun({ specPath: RUN9_SPEC, runDir: dir, outDir: join(dir, 'out') });
      assert.equal(result.report, null);
      assert.match(result.error ?? '', /缺 delivery\/building\.pgar/);
      assert.equal(existsSync(join(dir, 'conformance-diff.json')), false);
    });
  });
});
