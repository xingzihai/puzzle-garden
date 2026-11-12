/**
 * Wave 3B S1：影子适配器的中性 check / archive-bytes 接口。
 *
 * 只验证 report-only 行为：canonical grid-backed diff、逐洞口单一 item、统一标高派生、
 * 两份 JSON 落盘；坏输入一律返回 error，不抛、不影响构建 outcome / exit / submit。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeArchive } from '@pg/core/archive';
import { API_VERSION } from '@pg/geometry';

import { buildBuildSheet } from './build-sheet.ts';
import { computeShadowConformance, computeShadowForArchive } from './conformance-shadow.ts';
import type { ShadowDatumInput } from './conformance-shadow.ts';
import type { ConformanceDiffReport } from './conformance-diff.ts';
import { buildFixture } from './conformance-matrix-fixtures.ts';

const RUN9_DIR = fileURLToPath(new URL('./fixtures/conformance-run9-v2/', import.meta.url));
const RUN9_SPEC = join(RUN9_DIR, 'build-spec.json');
const RUN9_ARCHIVE = join(RUN9_DIR, 'building.pgar');
const MATRIX_MAPPING = fileURLToPath(new URL('./fixtures/conformance-matrix-verified-mapping.json', import.meta.url));

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pg-shadow-archive-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 去掉内存路径占位后，两份 report 应逐字段一致。 */
function reportBody(report: ConformanceDiffReport | null): unknown {
  if (report === null) throw new Error('report 缺失');
  return {
    ...report,
    archive: { sha256: report.archive.sha256, bytes: report.archive.bytes },
  };
}

describe('Wave 3B S1 影子适配器：archive-bytes 中性接口', () => {
  it('H1–H4 good：blocking=false，5/5 pass，洞口逐项唯一，写两份 JSON', () => {
    for (const house of ['H1', 'H2', 'H3', 'H4'] as const) {
      withTempDir((dir) => {
        const fixture = buildFixture(house, 'good');
        const specPath = join(dir, 'build-spec.json');
        writeFileSync(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
        const archive = writeArchive(fixture.grid, API_VERSION);
        const buildSheetDatum = buildBuildSheet(fixture.spec).datum;
        // 旧字段 floorY 即使混入输入也不得参与派生。
        const datumWithLegacyFloorY = { ...buildSheetDatum, floorY: -99 };
        const result = computeShadowForArchive({
          specPath,
          archive,
          outDir: join(dir, 'out'),
          datum: datumWithLegacyFloorY,
          mappingPath: MATRIX_MAPPING,
        });

        assert.equal(result.error, null);
        const report = result.report;
        const evidence = result.evidence;
        assert.ok(report !== null);
        assert.ok(evidence !== null);
        assert.equal(report.summary.blocking, false);
        assert.equal(report.summary.pass, 5);
        assert.equal(report.summary.missing, 0);
        assert.equal(report.summary.extra, 0);

        const openingItems = report.items.filter((item) => item.kind === 'opening');
        assert.equal(openingItems.length, fixture.spec.openings.length);
        assert.equal(new Set(openingItems.map((item) => item.expectedId)).size, openingItems.length);
        assert.ok(openingItems.every((item) => item.expectedId !== null));
        assert.ok(openingItems.every((item) => item.status !== 'missing' && item.status !== 'extra'));

        assert.deepEqual(evidence.datum, {
          slabTopY: 0,
          standingY: 1,
          gradeY: 1,
          entryTransition: 'flush',
          floorThickness: 1,
          source: 'build-sheet',
        });
        assert.equal('floorY' in evidence.datum, false);
        assert.equal(evidence.mode, 'report-only');
        assert.equal(evidence.mapping, 'verified');
        assert.equal(evidence.summary.acceptEligible, false);

        assert.ok(result.diffPath !== null && existsSync(result.diffPath));
        assert.ok(result.evidencePath !== null && existsSync(result.evidencePath));
        const writtenDiff = JSON.parse(readFileSync(result.diffPath, 'utf8')) as { schemaVersion: number };
        const writtenEvidence = JSON.parse(readFileSync(result.evidencePath, 'utf8')) as { schemaVersion: number };
        assert.equal(writtenDiff.schemaVersion, 1);
        assert.equal(writtenEvidence.schemaVersion, 2);
      });
    }
  });

  it('datum：只收 BuildSheet 四字段，floorThickness 由 standingY - slabTopY 派生', () => {
    withTempDir((dir) => {
      const fixture = buildFixture('H2', 'good');
      const specPath = join(dir, 'build-spec.json');
      writeFileSync(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
      const archive = writeArchive(fixture.grid, API_VERSION);
      const datumWithLegacyFloorY: ShadowDatumInput & { readonly floorY: number } = {
        slabTopY: 2,
        standingY: 4,
        gradeY: 4,
        entryTransition: 'flush',
        floorY: 0,
      };
      const result = computeShadowForArchive({
        specPath,
        archive,
        outDir: dir,
        datum: datumWithLegacyFloorY,
      });

      assert.equal(result.error, null);
      const evidence = result.evidence;
      assert.ok(evidence !== null);
      assert.deepEqual(evidence.datum, {
        slabTopY: 2,
        standingY: 4,
        gradeY: 4,
        entryTransition: 'flush',
        floorThickness: 2,
        source: 'build-sheet',
      });
      assert.equal('floorY' in evidence.datum, false);
    });
  });

  it('run-9 v2：4 个 hard fail，wall pass，洞口 canonical，evidence report-only', () => {
    withTempDir((dir) => {
      const archive = readFileSync(RUN9_ARCHIVE);
      const result = computeShadowForArchive({ specPath: RUN9_SPEC, archive, outDir: dir });
      assert.equal(result.error, null);
      const report = result.report;
      const evidence = result.evidence;
      assert.ok(report !== null);
      assert.ok(evidence !== null);

      assert.equal(report.summary.blocking, true);
      assert.equal(report.summary.fail, 4);
      assert.equal(report.summary.blockingCount, 4);
      assert.equal(report.items.filter((item) => item.status === 'fail' && item.severity === 'hard').length, 4);
      assert.equal(report.summary.missing, 0);
      assert.equal(report.summary.extra, 0);

      const wall = report.items.find((item) => item.expectedId === 'wall:f1');
      assert.ok(wall !== undefined);
      assert.equal(wall.status, 'pass');

      // 一个 expected opening 只允许一个 item；不能出现 MISSING + EXTRA 双计。
      const openingItems = report.items.filter((item) => item.kind === 'opening');
      assert.equal(openingItems.length, 2);
      assert.equal(new Set(openingItems.map((item) => item.expectedId)).size, openingItems.length);
      assert.ok(openingItems.every((item) => item.expectedId !== null));
      assert.equal(
        report.items.filter((item) => item.kind === 'opening' && (item.status === 'missing' || item.status === 'extra'))
          .length,
        0,
      );
      const door = openingItems.find((item) => item.expectedId === 'opening:op-entry-north');
      assert.ok(door !== undefined);
      assert.equal(door.status, 'fail');
      assert.equal(door.actualId, 'evaluateOpenings:op-entry-north');

      assert.equal(evidence.mode, 'report-only');
      assert.equal(evidence.mapping, 'heuristic');
      // 父 must 状态改为来自 clause group 聚合；run-9 的缺失家具 / 覆盖失败也计入 not-met。
      assert.equal(evidence.summary.notMet, 21);
      assert.equal(evidence.summary.acceptEligible, false);
      assert.ok(result.diffPath !== null && existsSync(result.diffPath));
      assert.ok(result.evidencePath !== null && existsSync(result.evidencePath));
    });
  });

  it('bad spec / bad archive / bad mapping：只返回 error，不抛', () => {
    withTempDir((dir) => {
      const fixture = buildFixture('H1', 'good');
      const specPath = join(dir, 'build-spec.json');
      writeFileSync(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
      const archive = writeArchive(fixture.grid, API_VERSION);

      let missingSpec: ReturnType<typeof computeShadowForArchive> | undefined;
      assert.doesNotThrow(() => {
        missingSpec = computeShadowForArchive({ specPath: join(dir, 'missing-spec.json'), archive, outDir: dir });
      });
      assert.ok(missingSpec !== undefined);
      assert.equal(missingSpec.report, null);
      assert.equal(missingSpec.evidence, null);
      assert.match(missingSpec.error ?? '', /读不到/);

      const badSpecPath = join(dir, 'bad-spec.json');
      writeFileSync(badSpecPath, 'not json\n', 'utf8');
      const badSpec = computeShadowForArchive({ specPath: badSpecPath, archive, outDir: join(dir, 'bad-spec') });
      assert.equal(badSpec.report, null);
      assert.match(badSpec.error ?? '', /不是合法 JSON/);

      const badArchive = computeShadowForArchive({
        specPath,
        archive: new Uint8Array([1, 2, 3, 4]),
        outDir: join(dir, 'bad-archive'),
      });
      assert.equal(badArchive.report, null);
      assert.match(badArchive.error ?? '', /无法解码内存存档/);
      assert.equal(existsSync(join(dir, 'bad-archive', 'conformance-diff.json')), false);

      const badMappingPath = join(dir, 'bad-mapping.json');
      writeFileSync(badMappingPath, '{"schemaVersion":2}\n', 'utf8');
      const badMapping = computeShadowForArchive({
        specPath,
        archive,
        outDir: join(dir, 'bad-mapping'),
        mappingPath: badMappingPath,
      });
      assert.equal(badMapping.report, null);
      assert.match(badMapping.error ?? '', /不是合法 verified-must-map/);

      const conflictingMapping = computeShadowForArchive({
        specPath,
        archive,
        outDir: join(dir, 'conflicting-mapping'),
        mappingPath: MATRIX_MAPPING,
        verifiedMapping: {
          schemaVersion: 1,
          tool: 'verified-must-map',
          mapping: 'verified',
          schemeRevision: 1,
          schemes: {},
        },
      });
      assert.equal(conflictingMapping.report, null);
      assert.match(conflictingMapping.error ?? '', /只能提供一个/);
    });
  });

  it('archive-bytes 与 archive-path 的 diff 完全一致', () => {
    withTempDir((dir) => {
      const fixture = buildFixture('H3', 'good');
      const specPath = join(dir, 'build-spec.json');
      const archivePath = join(dir, 'building.pgar');
      const archive = writeArchive(fixture.grid, API_VERSION);
      writeFileSync(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
      writeFileSync(archivePath, archive);

      const fromPath = computeShadowConformance({
        specPath,
        archivePath,
        outDir: join(dir, 'path-out'),
        mappingPath: MATRIX_MAPPING,
      });
      const fromBytes = computeShadowForArchive({
        specPath,
        archive,
        outDir: join(dir, 'bytes-out'),
        mappingPath: MATRIX_MAPPING,
      });

      assert.equal(fromPath.error, null);
      assert.equal(fromBytes.error, null);
      assert.deepEqual(reportBody(fromBytes.report), reportBody(fromPath.report));
      assert.deepEqual(fromBytes.evidence, fromPath.evidence);
    });
  });
});
