/**
 * run-9 v1 冻结证据：历史基线，锁定 5 个 hard fail、6 个 soft unverified，以及 site 只进 notCompared。
 * v1 报告是 false-positive 修复前的字节；当前分类器不再逐字节重放它，v2 见 conformance-run9-v2.test.ts。
 *
 * 只读 tools/fixtures/conformance-run9/，不依赖 .work、不联网、不构建。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSpec } from './conformance-diff.ts';
import type { ConformanceDiffReport } from './conformance-diff.ts';
import { projectExpectedObjects } from './conformance-expect.ts';
import type { ExpectedProjection } from './conformance-expect.ts';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/conformance-run9/', import.meta.url));
const SPEC_PATH = join(FIXTURE_DIR, 'build-spec.json');
const ARCHIVE_PATH = join(FIXTURE_DIR, 'building.pgar');

const HARD_FAIL_IDS = ['wall:f1', 'slab:f1', 'roof', 'opening:op-entry-north', 'opening:op-south-window'] as const;

interface ExpectedObjectsFixture extends ExpectedProjection {
  readonly schemaVersion: number;
  readonly tool: string;
  readonly specSha256: string;
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as unknown;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const report = readJson('conformance-report.json') as ConformanceDiffReport;

describe('run-9 冻结证据：输入与期望对象', () => {
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

describe('run-9 v1 冻结证据：输入完整性', () => {
  it('building.pgar 的 sha256 / 字节数与报告一致', () => {
    assert.equal(sha256File(ARCHIVE_PATH), report.archive.sha256);
    assert.equal(readFileSync(ARCHIVE_PATH).byteLength, report.archive.bytes);
  });

  it('报告是 schemaVersion 1、tool=conformance-diff 的历史字节', () => {
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.tool, 'conformance-diff');
    assert.equal(report.spec.sha256, sha256File(SPEC_PATH));
  });
});

describe('run-9 冻结证据：失败面', () => {
  it('恰好 5 个 hard fail：墙、板、屋面、北门、南窗', () => {
    const hardFails = report.items.filter((item) => item.status === 'fail' && item.severity === 'hard');
    assert.deepEqual(hardFails.map((item) => item.expectedId).sort(), [...HARD_FAIL_IDS].sort());
    assert.equal(report.summary.fail, 5);
    assert.equal(report.summary.blockingCount, 5);
    assert.equal(report.summary.blocking, true);
  });

  it('恰好 6 个 soft unverified，全部是 unknown 实际对象', () => {
    const unverified = report.items.filter((item) => item.status === 'unverified');
    assert.equal(unverified.length, 6);
    assert.equal(report.summary.unverified, 6);
    assert.equal(
      unverified.every((item) => item.kind === 'unknown' && item.severity === 'soft' && item.expectedId === null),
      true,
    );
    assert.deepEqual(unverified.map((item) => item.actualId).sort(), [...report.notCompared.ids.unknown].sort());
  });

  it('site 14×12 只出现在 notCompared，不参与 hard 比较', () => {
    assert.equal(report.notCompared.site, 1);
    assert.deepEqual(report.notCompared.ids.site, ['site@0,0,0']);
    assert.equal(
      report.items.some(
        (item) => item.expectedId?.startsWith('site:') === true || item.actualId?.startsWith('site@') === true,
      ),
      false,
    );
  });
});
