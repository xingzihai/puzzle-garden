/**
 * run-9 v2 回归：同一份 spec / archive，在误报修复后重新生成。
 * 锁定 wall 变 pass、4 个真实缺陷仍 hard fail、site 不参与硬比较，并校验 defect ledger 与报告一致。
 *
 * 只读 tools/fixtures/conformance-run9-v2/，不依赖 .work、不联网、不构建。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import { loadRegistry } from '@pg/blocks/load';

import { buildConformanceDiffReport, loadArchive, loadSpec } from './conformance-diff.ts';
import type { ConformanceDiffReport } from './conformance-diff.ts';
import { projectExpectedObjects } from './conformance-expect.ts';
import type { ExpectedProjection } from './conformance-expect.ts';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/conformance-run9-v2/', import.meta.url));
const SPEC_PATH = join(FIXTURE_DIR, 'build-spec.json');
const ARCHIVE_PATH = join(FIXTURE_DIR, 'building.pgar');

const HARD_FAIL_IDS = ['slab:f1', 'roof', 'opening:op-entry-north', 'opening:op-south-window'] as const;

interface ExpectedObjectsFixture extends ExpectedProjection {
  readonly schemaVersion: number;
  readonly tool: string;
  readonly specSha256: string;
}

interface DefectLedger {
  readonly entries: readonly {
    readonly id: string;
    readonly v1Status: string;
    readonly v2Status: string;
    readonly classification: string;
  }[];
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as unknown;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const registry = loadRegistry();
const report = readJson('conformance-report.json') as ConformanceDiffReport;

describe('run-9 v2：输入与期望对象', () => {
  it('build-spec 的 sha256 与报告、投影一致', () => {
    const expected = readJson('expected-objects.json') as ExpectedObjectsFixture;
    assert.equal(expected.tool, 'conformance-expect');
    assert.equal(expected.schemaVersion, 1);
    assert.equal(sha256File(SPEC_PATH), expected.specSha256);
    assert.equal(expected.specSha256, report.spec.sha256);
  });

  it('projectExpectedObjects 重放结果与 expected-objects.json 完全一致', () => {
    const expected = readJson('expected-objects.json') as ExpectedObjectsFixture;
    const { spec } = loadSpec(SPEC_PATH);
    assert.deepEqual(projectExpectedObjects(spec), {
      objects: expected.objects,
      counts: expected.counts,
      notes: expected.notes,
    });
  });
});

describe('run-9 v2：报告可重放', () => {
  it('building.pgar 的 sha256 / 字节数与报告一致', () => {
    assert.equal(sha256File(ARCHIVE_PATH), report.archive.sha256);
    assert.equal(readFileSync(ARCHIVE_PATH).byteLength, report.archive.bytes);
  });

  it('从入库副本重建的报告与 conformance-report.json 逐字段一致', () => {
    const { spec } = loadSpec(SPEC_PATH);
    const { grid, sha256, bytes } = loadArchive(ARCHIVE_PATH, registry);
    const rebuilt = buildConformanceDiffReport({
      spec,
      grid,
      registry,
      specPath: report.spec.path,
      specSha256: report.spec.sha256,
      archivePath: report.archive.path,
      archiveSha256: report.archive.sha256,
      archiveBytes: bytes,
    });
    assert.equal(sha256, report.archive.sha256);
    assert.deepEqual(rebuilt, report);
  });
});

describe('run-9 v2：真实缺陷面', () => {
  it('wall 已 pass；恰好 4 个 hard fail：板、屋面、北门、南窗', () => {
    const wall = report.items.find((item) => item.expectedId === 'wall:f1');
    assert.equal(wall?.status, 'pass');
    const hardFails = report.items.filter((item) => item.status === 'fail' && item.severity === 'hard');
    assert.deepEqual(hardFails.map((item) => item.expectedId).sort(), [...HARD_FAIL_IDS].sort());
    assert.equal(report.summary.pass, 1);
    assert.equal(report.summary.fail, 4);
    assert.equal(report.summary.blockingCount, 4);
    assert.equal(report.summary.blocking, true);
  });

  it('恰好 6 个 soft unverified，全部是 unknown 实际对象', () => {
    const unverified = report.items.filter((item) => item.status === 'unverified');
    assert.equal(unverified.length, 6);
    assert.equal(
      unverified.every((item) => item.kind === 'unknown' && item.severity === 'soft' && item.expectedId === null),
      true,
    );
    assert.deepEqual(unverified.map((item) => item.actualId).sort(), [...report.notCompared.ids.unknown].sort());
  });

  it('site 14×12 只出现在 notCompared，actual site 仍是 14×12', () => {
    const { grid } = loadArchive(ARCHIVE_PATH, registry);
    const graph = extractAsBuiltObjects(grid, registry);
    const site = graph.objects.find((object) => object.kind === 'site');
    assert.ok(site !== undefined);
    assert.deepEqual(site.bounds, { min: [0, 0, 0], max: [14, 1, 12] });
    assert.equal(report.notCompared.site, 1);
    assert.deepEqual(report.notCompared.ids.site, ['site@0,0,0']);
    assert.equal(
      report.items.some(
        (item) => item.expectedId?.startsWith('site:') === true || item.actualId?.startsWith('site@') === true,
      ),
      false,
    );
  });

  it('defect ledger 覆盖全部 v1 hard fail，且 wall 明确标为 artifact', () => {
    const ledger = readJson('defect-ledger.json') as DefectLedger;
    const v1Ids = ['wall:f1', 'slab:f1', 'roof', 'opening:op-entry-north', 'opening:op-south-window'];
    assert.deepEqual(ledger.entries.map((entry) => entry.id).sort(), [...v1Ids].sort());
    const wall = ledger.entries.find((entry) => entry.id === 'wall:f1');
    assert.ok(wall !== undefined);
    assert.equal(wall.classification, 'artifact');
    assert.equal(wall.v2Status, 'pass');
    for (const id of HARD_FAIL_IDS) {
      const entry = ledger.entries.find((item) => item.id === id);
      assert.ok(entry !== undefined);
      assert.equal(entry.v2Status, 'fail');
      assert.equal(entry.classification, 'true-defect');
    }
  });
});
