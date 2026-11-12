/**
 * check_code 的逐对象一致性集成测试（WS1）：真 registry + 真存档，验证 check_code 追加
 * `expected / actual / delta` 摘要、只报告不拦截，以及未传期望对象时文本不变。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DiffReport, ExpectedObject } from '@pg/analysis/object-diff';
import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { hashGrid } from '@pg/core/hash';
import { API_VERSION, createWorld, rect } from '@pg/geometry';
import type { Grid } from '@pg/core/grid';
import type { RunResult } from '@pg/sandbox/run';

import { checkCode } from './check.ts';
import type { CheckDeps } from './check.ts';
import { submit } from './submit.ts';

const registry = loadRegistry();

interface Built {
  readonly archive: Uint8Array;
  readonly grid: Grid;
  readonly hash: string;
}

/** 实心四面墙 + 台基：没有洞口 / 屋面，as-built 聚合后 wall / slab 都是完整包络。 */
function builtSolid(): Built {
  const host = createWorld(registry.table);
  const w = host.world;
  const base = w.plinth({ footprint: rect(-4, -3, 4, 3), height: 1, material: 'stone_bricks' });
  w.walls({ on: base, height: 4, material: 'stone_bricks' });
  const { grid } = host.compose();
  return { archive: writeArchive(grid, API_VERSION), grid, hash: hashGrid(grid) };
}

function okRun(build: Built): RunResult {
  return {
    kind: 'ok',
    grid: build.grid,
    archive: build.archive,
    hash: build.hash,
    report: {
      status: 'ok',
      hash: build.hash,
      calls: build.grid.calls().length,
      overlaps: [],
      console: [],
      consoleTruncated: 0,
    },
    wallMs: 1,
  };
}

/** 期望对象手工取自该固定小样：wall [-4,2,-3]..[5,5,4]、slab [-4,1,-3]..[5,2,4]。 */
function expectedObjects(wallMaxY = 5): readonly ExpectedObject[] {
  return [
    {
      id: 'wall:f1',
      kind: 'wall',
      bounds: { min: [-4, 2, -3], max: [5, wallMaxY, 4] },
      unverifiedReason: null,
    },
    {
      id: 'slab:f1',
      kind: 'slab',
      bounds: { min: [-4, 1, -3], max: [5, 2, 4] },
      unverifiedReason: null,
    },
  ];
}

function canonicalReport(): DiffReport {
  return {
    schemaVersion: 1,
    measurement: {
      unit: 'voxel-cell',
      boundsConvention: 'half-open [min,max)',
      positionToleranceCells: 0,
      pitchToleranceDegrees: 2,
    },
    items: [],
    summary: {
      pass: 2,
      fail: 0,
      missing: 0,
      extra: 1,
      unverified: 0,
      blockingCount: 0,
      blocking: false,
      fullyVerified: true,
    },
    notCompared: { site: 0, furniture: 0, unknown: 0, total: 0, ids: { site: [], furniture: [], unknown: [] } },
    context: { openings: [] },
    notes: [],
  };
}

function depsOf(build: Built, expected?: readonly ExpectedObject[]): CheckDeps {
  let now = 0;
  return {
    prechecker: { check: () => Promise.resolve({ kind: 'ok' }) },
    runCode: () => Promise.resolve(okRun(build)),
    registry,
    ...(expected === undefined ? {} : { expectedObjects: expected }),
    clock: () => {
      now += 3;
      return now;
    },
  };
}

describe('checkCode 逐对象一致性（仅报告）', () => {
  it('匹配存档：blocking 0、wall/slab PASS，摘要位于首行与测量之间', async () => {
    const build = builtSolid();
    const result = await checkCode({ code: 'x', version: 4, seed: 0 }, depsOf(build, expectedObjects()));
    assert.equal(result.status, 'ok');
    assert.ok(result.conformance !== undefined);
    assert.equal(result.conformance.summary.blockingCount, 0);
    assert.equal(result.conformance.summary.pass, 2);
    assert.match(
      result.text,
      /一致性（仅报告，不拦截）：blocking 0 \/ expected 2｜pass 2、fail 0、unverified 0、missing 0、extra 1/,
    );
    assert.match(result.text, /- PASS wall:f1 期望 \[-4,2,-3\]\.\.\[5,5,4\] 实际 \[-4,2,-3\]\.\.\[5,5,4\]/);
    assert.match(result.text, /- PASS slab:f1 期望 \[-4,1,-3\]\.\.\[5,2,4\] 实际 \[-4,1,-3\]\.\.\[5,2,4\]/);
    assert.ok(result.text.indexOf('一致性（仅报告') > result.text.indexOf('执行成功'));
    assert.ok(result.text.indexOf('一致性（仅报告') < result.text.indexOf('测量（事实，不判合格）'));
    assert.doesNotMatch(result.text, /一致性检查不可用/);
  });

  it('期望上界被改高：报告 FAIL + bounds delta，blocking 计入但 submit 行为不变', async () => {
    const build = builtSolid();
    const result = await checkCode({ code: 'x', version: 5, seed: 0 }, depsOf(build, expectedObjects(6)));
    assert.equal(result.status, 'ok');
    assert.ok(result.conformance !== undefined);
    assert.equal(result.conformance.summary.blocking, true);
    assert.equal(result.conformance.summary.fail, 1);
    assert.match(
      result.text,
      /一致性（仅报告，不拦截）：blocking 1 \/ expected 2｜pass 1、fail 1、unverified 0、missing 0、extra 1/,
    );
    assert.match(
      result.text,
      /- FAIL wall:f1 期望 \[-4,2,-3\]\.\.\[5,6,4\] 实际 \[-4,2,-3\]\.\.\[5,5,4\] Δ \[0,0,0,0,-1,0\]（bounds）/,
    );
    assert.ok(result.text.indexOf('- FAIL wall:f1') < result.text.indexOf('- PASS slab:f1'));
  });

  it('一致性计算抛错：只追加"不可用"一行，check_code 仍成功且没有 conformance 字段', async () => {
    const build = builtSolid();
    const malformed = [
      { id: 'wall:bad', kind: 'wall', bounds: null, unverifiedReason: null },
    ] as unknown as readonly ExpectedObject[];
    const result = await checkCode({ code: 'x', version: 7, seed: 0 }, depsOf(build, malformed));
    assert.equal(result.status, 'ok');
    assert.equal('conformance' in result, false);
    assert.match(result.text, /一致性检查不可用：/);
    assert.match(result.text, /测量（事实，不判合格）：/);
  });

  it('conformanceReportOf：用本次存档取 canonical 报告，优先于对象图回退，且 submit 行为不变', async () => {
    const build = builtSolid();
    const canonical = canonicalReport();
    let seenArchive: Uint8Array | undefined;
    const deps: CheckDeps = {
      ...depsOf(build, expectedObjects(6)),
      conformanceReportOf: (archive) => {
        seenArchive = archive;
        return canonical;
      },
    };
    const result = await checkCode({ code: 'x', version: 8, seed: 0 }, deps);
    assert.equal(result.status, 'ok');
    assert.equal(seenArchive, build.archive, 'provider 必须收到本次执行的存档字节');
    assert.equal(result.conformance, canonical);
    // 对象图回退会报 wall bounds FAIL（expected 上界 6）；provider 报告 blocking 0 说明 canonical 优先。
    assert.match(result.text, /一致性（仅报告，不拦截）：blocking 0/u);
    assert.doesNotMatch(result.text, /FAIL wall:f1/u);
    assert.doesNotMatch(result.text, /\[fallback\]/u, 'canonical 可用时不应出现 fallback 标记');
    assert.equal(submit({ draftVersion: 8, lastCheck: { version: 8, outcome: 'ok' } }).accepted, true);
  });

  it('conformanceReportOf 抛错：回退对象图摘要并显式标记 [fallback]', async () => {
    const build = builtSolid();
    const result = await checkCode(
      { code: 'x', version: 9, seed: 0 },
      {
        ...depsOf(build, expectedObjects(6)),
        conformanceReportOf: () => {
          throw new Error('shadow failed');
        },
      },
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.conformance !== undefined);
    assert.equal(result.conformance.summary.blockingCount, 1);
    assert.match(result.text, /FAIL wall:f1/u);
    assert.match(result.text, /\[fallback\]/u);
    assert.match(result.text, /本次未拿到 canonical shadow 报告/u);
    assert.match(result.text, /blocking 可能被低估/u);
    assert.match(result.text, /不要据此判断完成度/u);
    assert.ok(
      result.text.indexOf('[fallback]') < result.text.indexOf('一致性（仅报告'),
      'fallback 标记必须出现在一致性摘要前',
    );
  });

  it('conformanceReportOf 返回空报告：同样标记 [fallback] 并回退', async () => {
    const build = builtSolid();
    const empty: DiffReport = {
      schemaVersion: 1,
      measurement: {
        unit: 'voxel-cell',
        boundsConvention: 'half-open [min,max)',
        positionToleranceCells: 0,
        pitchToleranceDegrees: 2,
      },
      items: [],
      summary: {
        pass: 0,
        fail: 0,
        missing: 0,
        extra: 0,
        unverified: 0,
        blockingCount: 0,
        blocking: false,
        fullyVerified: true,
      },
      notCompared: { site: 0, furniture: 0, unknown: 0, total: 0, ids: { site: [], furniture: [], unknown: [] } },
      context: { openings: [] },
      notes: [],
    };
    const result = await checkCode(
      { code: 'x', version: 10, seed: 0 },
      { ...depsOf(build, expectedObjects(6)), conformanceReportOf: () => empty },
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.conformance !== undefined);
    assert.equal(result.conformance.summary.blockingCount, 1);
    assert.match(result.text, /\[fallback\]/u);
    assert.match(result.text, /provider 返回了空报告/u);
    assert.match(result.text, /FAIL wall:f1/u);
  });

  it('canonical 与 fallback 文本不同：只有 fallback 带降级警告', async () => {
    const build = builtSolid();
    const canonical = await checkCode(
      { code: 'x', version: 11, seed: 0 },
      { ...depsOf(build, expectedObjects(6)), conformanceReportOf: () => canonicalReport() },
    );
    const fallback = await checkCode(
      { code: 'x', version: 11, seed: 0 },
      {
        ...depsOf(build, expectedObjects(6)),
        conformanceReportOf: () => {
          throw new Error('shadow unavailable');
        },
      },
    );
    assert.notEqual(canonical.text, fallback.text);
    assert.doesNotMatch(canonical.text, /\[fallback\]|canonical shadow/u);
    assert.match(fallback.text, /\[fallback\]/u);
    assert.match(fallback.text, /canonical shadow/u);
    assert.match(fallback.text, /blocking 可能被低估/u);
    // 两者仍都是 ok；fallback 只是可见性标记，不改变 submit 判定。
    assert.equal(canonical.status, 'ok');
    assert.equal(fallback.status, 'ok');
    assert.equal(submit({ draftVersion: 11, lastCheck: { version: 11, outcome: 'ok' } }).accepted, true);
  });

  it('未传或传空期望对象：不追加摘要，文本与现状逐字相同', async () => {
    const build = builtSolid();
    const plain = await checkCode({ code: 'x', version: 6, seed: 0 }, depsOf(build));
    const empty = await checkCode({ code: 'x', version: 6, seed: 0 }, depsOf(build, []));
    assert.equal(plain.text, empty.text);
    assert.equal('conformance' in plain, false);
    assert.equal('conformance' in empty, false);
    assert.doesNotMatch(plain.text, /一致性/);
  });
});
