/**
 * 构建循环 → 影子自证的接线合同：computeShadowForRun 只往 run 目录写两份报告，
 * 不修改 outcome；H1–H4 好样本不 blocking，run-9 v2 仍 4 个 hard fail；
 * 缺 delivery / 坏 spec / 坏 archive 只返回 error；summary 行不参与退出码。
 */

import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RunOutcome } from '@pg/agent/runner';
import { writeArchive } from '@pg/core/archive';
import { API_VERSION } from '@pg/geometry';

import { computeShadowConformance, computeShadowForRun, shadowSummaryLine } from './conformance-shadow.ts';
import type { ShadowConformanceResult } from './conformance-shadow.ts';
import { buildFixture } from './conformance-matrix-fixtures.ts';
import type { HouseKey } from './conformance-matrix-fixtures.ts';

const RUN9_DIR = fileURLToPath(new URL('./fixtures/conformance-run9-v2/', import.meta.url));
const RUN9_SPEC = join(RUN9_DIR, 'build-spec.json');
const RUN9_ARCHIVE = join(RUN9_DIR, 'building.pgar');
const MATRIX_MAPPING = fileURLToPath(new URL('./fixtures/conformance-matrix-verified-mapping.json', import.meta.url));

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pg-design-build-shadow-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

function addedFiles(before: readonly string[], after: readonly string[]): string[] {
  const seen = new Set(before);
  return after.filter((path) => !seen.has(path));
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function outcomeLike(runDir: string): RunOutcome {
  return Object.freeze({
    runId: 'run-shadow-contract',
    dir: runDir,
    stopReason: null,
    delivery: { codeVersion: 2, hash: 'f'.repeat(64) },
    costCny: 0.42,
    turns: 6,
  } satisfies RunOutcome);
}

function seedMatrixRun(root: string, house: HouseKey): { readonly runDir: string; readonly specPath: string } {
  const fixture = buildFixture(house, 'good');
  const runDir = join(root, `${house.toLowerCase()}-run`);
  mkdirSync(join(runDir, 'delivery'), { recursive: true });
  const specPath = join(runDir, 'build-spec.json');
  writeFileSync(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
  writeFileSync(join(runDir, 'delivery', 'building.pgar'), writeArchive(fixture.grid, API_VERSION));
  return { runDir, specPath };
}

function seedRun9Run(root: string): { readonly runDir: string; readonly specPath: string } {
  const runDir = join(root, 'run9-run');
  mkdirSync(join(runDir, 'delivery'), { recursive: true });
  copyFileSync(RUN9_ARCHIVE, join(runDir, 'delivery', 'building.pgar'));
  return { runDir, specPath: RUN9_SPEC };
}

function assertNoShadowFiles(dir: string): void {
  assert.equal(existsSync(join(dir, 'conformance-diff.json')), false);
  assert.equal(existsSync(join(dir, 'conformance-evidence.json')), false);
}

function expectShadowError(input: {
  readonly specPath: string;
  readonly runDir: string;
  readonly outDir?: string;
}): ShadowConformanceResult {
  let result: ShadowConformanceResult | undefined;
  assert.doesNotThrow(() => {
    result = computeShadowForRun(input);
  });
  assert.ok(result !== undefined);
  assert.notEqual(result.error, null);
  assert.equal(result.report, null);
  assert.equal(result.evidence, null);
  assert.equal(result.diffPath, null);
  assert.equal(result.evidencePath, null);
  assertNoShadowFiles(input.runDir);
  if (input.outDir !== undefined) assertNoShadowFiles(input.outDir);
  return result;
}

describe('构建循环影子接线：H1–H4 good run', () => {
  for (const house of ['H1', 'H2', 'H3', 'H4'] as const) {
    it(`${house}：写两份 JSON，blocking=false、2/2 met、outcome 不被改写`, () => {
      withTempDir((root) => {
        const { runDir, specPath } = seedMatrixRun(root, house);
        const outcome = outcomeLike(runDir);
        const snapshot = structuredClone(outcome);
        const before = listFiles(runDir);

        const result = computeShadowForRun({ specPath, runDir, mappingPath: MATRIX_MAPPING });

        assert.equal(result.mode, 'report-only');
        assert.equal(result.error, null);
        assert.deepEqual(outcome, snapshot);
        assert.deepEqual(
          addedFiles(before, listFiles(runDir)),
          [join(runDir, 'conformance-diff.json'), join(runDir, 'conformance-evidence.json')].sort(),
        );

        const diffPath = result.diffPath;
        const evidencePath = result.evidencePath;
        assert.ok(diffPath !== null && evidencePath !== null);
        assert.equal(diffPath, join(runDir, 'conformance-diff.json'));
        assert.equal(evidencePath, join(runDir, 'conformance-evidence.json'));
        assert.ok(existsSync(diffPath) && existsSync(evidencePath));

        const report = result.report;
        const evidence = result.evidence;
        assert.ok(report !== null && evidence !== null);
        assert.equal(report.summary.blocking, false);
        assert.equal(report.summary.fail, 0);
        assert.equal(evidence.mapping, 'verified');
        assert.equal(evidence.musts.length, 2);
        assert.equal(evidence.summary.acceptEligible, false);

        const writtenEvidence = readJsonFile(evidencePath) as {
          readonly summary: {
            readonly met: number;
            readonly notMet: number;
            readonly waived: number;
            readonly unverified: number;
            readonly acceptEligible: boolean;
          };
        };
        assert.deepEqual(writtenEvidence.summary, evidence.summary);
        const writtenReport = readJsonFile(diffPath) as { readonly summary: { readonly blocking: boolean } };
        assert.equal(writtenReport.summary.blocking, false);
      });
    });
  }
});

describe('构建循环影子接线：run-9 v2', () => {
  it('blocking=true、4 个 hard fail、北门单一 evaluateOpenings item、0/21/20', () => {
    withTempDir((root) => {
      const { runDir, specPath } = seedRun9Run(root);
      const result = computeShadowForRun({ specPath, runDir });
      assert.equal(result.error, null);
      const report = result.report;
      const evidence = result.evidence;
      assert.ok(report !== null && evidence !== null);

      assert.equal(report.summary.blocking, true);
      assert.equal(report.summary.fail, 4);
      assert.equal(report.summary.blockingCount, 4);
      assert.equal(report.items.filter((item) => item.status === 'fail' && item.severity === 'hard').length, 4);
      assert.equal(report.summary.missing, 0);
      assert.equal(report.summary.extra, 0);

      const doorItems = report.items.filter((item) => item.expectedId === 'opening:op-entry-north');
      assert.equal(doorItems.length, 1);
      const door = doorItems[0];
      assert.ok(door !== undefined);
      assert.equal(door.actualId, 'evaluateOpenings:op-entry-north');
      assert.equal(door.status, 'fail');

      // 父 must 状态现在来自 clause group 聚合；run-9 的覆盖 / 家具缺失也计入 not-met。
      assert.equal(evidence.summary.met, 7);
      assert.equal(evidence.summary.notMet, 21);
      assert.equal(evidence.summary.unverified, 13);
      assert.equal(evidence.summary.acceptEligible, false);

      const diffPath = result.diffPath;
      const evidencePath = result.evidencePath;
      assert.ok(diffPath !== null && evidencePath !== null);
      assert.ok(existsSync(diffPath) && existsSync(evidencePath));
      const writtenEvidence = readJsonFile(evidencePath) as { readonly summary: typeof evidence.summary };
      assert.deepEqual(writtenEvidence.summary, evidence.summary);
    });
  });
});

describe('构建循环影子接线：错误收口', () => {
  it('缺 delivery：error，不抛，不写证据', () => {
    withTempDir((root) => {
      const { runDir, specPath } = seedMatrixRun(root, 'H1');
      rmSync(join(runDir, 'delivery'), { recursive: true, force: true });
      const outDir = join(root, 'shadow-out');
      const result = expectShadowError({ specPath, runDir, outDir });
      assert.match(result.error ?? '', /缺 delivery\/building\.pgar/);
      assert.equal(existsSync(outDir), false);
    });
  });

  it('坏 spec：error，不抛，不写证据', () => {
    withTempDir((root) => {
      const { runDir, specPath } = seedMatrixRun(root, 'H2');
      writeFileSync(specPath, '{ not-json', 'utf8');
      const outDir = join(root, 'shadow-out');
      const result = expectShadowError({ specPath, runDir, outDir });
      assert.match(result.error ?? '', /不是合法 JSON/);
      assert.equal(existsSync(outDir), false);
    });
  });

  it('坏 archive：error，不抛，不写证据', () => {
    withTempDir((root) => {
      const { runDir, specPath } = seedMatrixRun(root, 'H3');
      writeFileSync(join(runDir, 'delivery', 'building.pgar'), 'not-a-pgar', 'utf8');
      const result = expectShadowError({ specPath, runDir });
      assert.match(result.error ?? '', /无法解码/);
    });
  });
});

describe('构建循环影子接线：summary 仅报告', () => {
  it('shadowSummaryLine 是文本；result 无 exit/outcome 字段', () => {
    withTempDir((root) => {
      const { runDir, specPath } = seedMatrixRun(root, 'H1');
      const outDir = join(root, 'shadow-out');
      const result = computeShadowConformance({
        specPath,
        archivePath: join(runDir, 'delivery', 'building.pgar'),
        outDir,
      });
      assert.equal(result.error, null);

      const line = shadowSummaryLine(result);
      assert.equal(typeof line, 'string');
      assert.match(line, /仅报告/);
      assert.match(line, /blocking=0/);
      assert.ok(line.includes(outDir));
      assert.doesNotMatch(line, /退出码|exit\s*code|outcome/i);

      assert.deepEqual(Object.keys(result).sort(), ['diffPath', 'error', 'evidence', 'evidencePath', 'mode', 'report']);
      assert.equal('exit' in result, false);
      assert.equal('exitCode' in result, false);
      assert.equal('outcome' in result, false);

      assert.ok(existsSync(join(outDir, 'conformance-diff.json')));
      assert.ok(existsSync(join(outDir, 'conformance-evidence.json')));
      assertNoShadowFiles(runDir);

      const missing = computeShadowForRun({ specPath, runDir: join(root, 'empty-run') });
      assert.notEqual(missing.error, null);
      assert.match(shadowSummaryLine(missing), /不可用/);
    });
  });
});
