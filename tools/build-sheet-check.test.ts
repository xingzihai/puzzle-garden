/**
 * WS1 集成：BuildSheet 的 expectedObjects 经 CheckDeps 进入 check_code。
 *
 * 用入库 run-9 v2 证据与 H1–H4 good 样本重放真实 checkCode（假预检 / 假执行，真 registry 与真存档）：
 * run-9 v2 必须出现 4 个 hard fail（wall 误报已修），好样本 blocking=0。只报告，不改 submit。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { DiffReport, ExpectedFurniture } from '@pg/analysis/object-diff';
import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { parseState } from '@pg/core/block-state';
import type { Grid } from '@pg/core/grid';
import { hashGrid } from '@pg/core/hash';
import { API_VERSION } from '@pg/geometry';
import type { PrecheckResult } from '@pg/sandbox/precheck';
import type { RunResult } from '@pg/sandbox/run';

import { formatConformanceSummary } from '../packages/agent/src/conformance-summary.ts';
import { checkCode } from '@pg/agent/tools/check';
import { submit } from '@pg/agent/tools/submit';
import { buildBuildSheet } from './build-sheet.ts';
import { buildFixture } from './conformance-matrix-fixtures.ts';
import { buildConformanceDiffReport, loadArchive, loadSpec } from './conformance-diff.ts';
import { projectExpectedFurniture } from './coverage-evidence.ts';
import { buildRun7PerfectGrid } from './fixtures/run7-perfect-grid.ts';

const registry = loadRegistry();
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/conformance-run9-v2/', import.meta.url));
const RUN9_SPEC = join(FIXTURE_DIR, 'build-spec.json');
const RUN9_ARCHIVE = join(FIXTURE_DIR, 'building.pgar');
const LIVE_FIXTURE_DIR = fileURLToPath(new URL('./fixtures/live-run-20261022/', import.meta.url));
const TEA_HOUSE_SPEC = join(LIVE_FIXTURE_DIR, 'build-spec.json');
const TEA_HOUSE_ARCHIVE = join(LIVE_FIXTURE_DIR, 'building.pgar');

/**
 * ConformanceDiffReport 是生产 shadow 报告（含 spec / archive 元数据），与 check_code 的 DiffReport
 * 共享 items / summary / notCompared / context / notes，但没有 measurement 字段。check_code 只读取
 * 共享部分，因此这里仅做类型桥接，运行时保持同一份 canonical 对象。
 */
function asDiffReport(report: ReturnType<typeof buildConformanceDiffReport>): DiffReport {
  return report as unknown as DiffReport;
}

function okRun(grid: Grid, archive: Uint8Array): RunResult {
  const hash = hashGrid(grid);
  return {
    kind: 'ok',
    grid,
    archive,
    hash,
    report: {
      status: 'ok',
      hash,
      calls: grid.calls().length,
      overlaps: [],
      console: [],
      consoleTruncated: 0,
    },
    wallMs: 1,
  };
}

async function runCheck(
  grid: Grid,
  archive: Uint8Array,
  expectedObjects: ReturnType<typeof buildBuildSheet>['expectedObjects'],
  conformanceReport?: DiffReport,
  expectedFurniture?: readonly ExpectedFurniture[],
) {
  const precheck: PrecheckResult = { kind: 'ok' };
  let now = 0;
  const result = await checkCode(
    { code: 'export default function build() {}', version: 1, seed: 0 },
    {
      prechecker: { check: () => Promise.resolve(precheck) },
      runCode: () => Promise.resolve(okRun(grid, archive)),
      registry,
      expectedObjects,
      ...(conformanceReport === undefined ? {} : { conformanceReport }),
      ...(expectedFurniture === undefined ? {} : { expectedFurniture }),
      clock: () => {
        now += 1;
        return now;
      },
    },
  );
  assert.equal(result.status, 'ok');
  assert.ok(result.conformance !== undefined);
  return result;
}

describe('WS1：check_code 逐对象 diff（report-only）', () => {
  it('run-9 v2：canonical 报告 4 个 hard fail，wall pass，北门洞口唯一，submit 仍不读取 diff', async () => {
    const { spec, sha256: specSha256 } = loadSpec(RUN9_SPEC);
    const { grid, sha256: archiveSha256, bytes } = loadArchive(RUN9_ARCHIVE, registry);
    const archive = readFileSync(RUN9_ARCHIVE);
    const sheet = buildBuildSheet(spec);
    // 与 conformance-shadow 相同：同一份 spec / archive / grid，走 grid-backed evaluateOpenings 口径。
    const canonicalReport = buildConformanceDiffReport({
      spec,
      grid,
      registry,
      specPath: RUN9_SPEC,
      specSha256,
      archivePath: RUN9_ARCHIVE,
      archiveSha256,
      archiveBytes: bytes,
    });
    const result = await runCheck(grid, archive, sheet.expectedObjects, asDiffReport(canonicalReport));

    const report = result.conformance;
    assert.ok(report !== undefined);
    assert.equal(report.summary.fail, 4);
    assert.equal(report.summary.blockingCount, 4);
    assert.equal(report.summary.missing, 0);
    assert.equal(report.summary.extra, 0);
    const hardFailIds = report.items
      .filter((item) => item.status === 'fail' && item.severity === 'hard')
      .map((item) => item.expectedId)
      .sort();
    assert.deepEqual(hardFailIds, ['opening:op-entry-north', 'opening:op-south-window', 'roof', 'slab:f1']);
    const wall = report.items.find((item) => item.expectedId === 'wall:f1');
    assert.equal(wall?.status, 'pass');
    const northDoor = report.items.filter((item) => item.expectedId === 'opening:op-entry-north');
    assert.equal(northDoor.length, 1);
    assert.equal(northDoor[0]?.actualId, 'evaluateOpenings:op-entry-north');

    const summary = formatConformanceSummary(report);
    assert.ok(summary.length <= 2500, `summary ${String(summary.length)} 字符超过 2500`);
    assert.match(summary, /blocking 4/);
    assert.match(summary, /missing 0、extra 0/);
    const northDoorLines = summary.split('\n').filter((line) => line.startsWith('- FAIL opening:op-entry-north'));
    assert.equal(northDoorLines.length, 1, '北门在摘要里应只有一行 FAIL');
    assert.equal(summary.split('\n').filter((line) => line.startsWith('- FAIL ')).length, 4, '摘要应恰有 4 行 FAIL');
    assert.match(result.text, /一致性（仅报告，不拦截）/);
    assert.match(result.text, /PASS wall:f1/);
    assert.match(result.text, /FAIL slab:f1/);
    assert.match(result.text, /FAIL opening:op-entry-north/);
    assert.match(result.text, /opening:op-south-window/);

    // 提交条件仍是版本 + 执行 + gates；diff 不进入 submit。
    const accepted = submit({ draftVersion: 1, lastCheck: { version: 1, outcome: 'ok' } });
    assert.equal(accepted.accepted, true);
  });

  it('live-run fixture 回放：check 文本含 canonical blocking 与整面墙墙材计数', async () => {
    const { spec, sha256: specSha256 } = loadSpec(TEA_HOUSE_SPEC);
    const { grid, sha256: archiveSha256, bytes } = loadArchive(TEA_HOUSE_ARCHIVE, registry);
    const archive = readFileSync(TEA_HOUSE_ARCHIVE);
    const sheet = buildBuildSheet(spec);
    const canonicalReport = buildConformanceDiffReport({
      spec,
      grid,
      registry,
      specPath: TEA_HOUSE_SPEC,
      specSha256,
      archivePath: TEA_HOUSE_ARCHIVE,
      archiveSha256,
      archiveBytes: bytes,
    });
    const result = await runCheck(grid, archive, sheet.expectedObjects, asDiffReport(canonicalReport));

    assert.ok(result.conformance !== undefined);
    assert.equal(result.conformance.summary.blockingCount, 1);
    assert.match(result.text, /未验证 \/ 未关闭对象（仅报告）：blocking 1；/u);
    assert.match(result.text, /UNVERIFIED opening:op-entry-north（blocking）/u);
    assert.match(result.text, /墙面材质（仅报告，不影响 submit）：/u);
    assert.match(result.text, /stripped_spruce_log 57\/116（49\.1%，占比最高）/u);
    assert.match(result.text, /oak_planks 31\/116/u);
    assert.match(result.text, /stone_bricks 28\/116/u);
    // 新增证据段保持紧凑：live-run 回放全文仍 < 2,500 字符。
    assert.ok(result.text.length < 2500, `check 文本 ${String(result.text.length)} 字符`);
    // submit 仍只受版本 + 执行 + gates 影响，不因 blocking 或墙材摘要被拒。
    assert.equal(submit({ draftVersion: 1, lastCheck: { version: 1, outcome: 'ok' } }).accepted, true);
  });

  it('H1–H4 good：blocking=0，pass=5，submit 行为不变', async () => {
    for (const house of ['H1', 'H2', 'H3', 'H4'] as const) {
      const fixture = buildFixture(house, 'good');
      const sheet = buildBuildSheet(fixture.spec);
      const archive = writeArchive(fixture.grid, API_VERSION);
      const result = await runCheck(fixture.grid, archive, sheet.expectedObjects);

      const report = result.conformance;
      assert.ok(report !== undefined);
      assert.equal(report.summary.blockingCount, 0, `${house} blocking`);
      assert.equal(report.summary.pass, 5, `${house} pass`);
      assert.equal(report.summary.fullyVerified, true, `${house} fullyVerified`);
      assert.match(result.text, /blocking 0/);
    }
  });

  it('茶室 spec：家具 6 项全 pass，check 文本追加仅报告摘要', async () => {
    const { spec } = loadSpec(TEA_HOUSE_SPEC);
    const grid = buildRun7PerfectGrid(spec);
    const archive = writeArchive(grid, API_VERSION);
    const sheet = buildBuildSheet(spec);
    const result = await runCheck(grid, archive, sheet.expectedObjects, undefined, projectExpectedFurniture(spec));

    assert.match(result.text, /家具核对（仅报告）：pass 6 \/ fail 0 \/ missing 0 \/ extra 0/u);
    const nonPass = result.text
      .split('\n')
      .filter((line) => /^- (FAIL|MISSING|EXTRA|UNVERIFIED) furniture /u.test(line));
    assert.deepEqual(nonPass, []);
    assert.equal(result.status, 'ok');
    // 家具摘要只报告：submit 仍只看版本 + 执行 + gates。
    assert.equal(submit({ draftVersion: 1, lastCheck: { version: 1, outcome: 'ok' } }).accepted, true);
  });

  it('茶室 spec：北凳上方多 1 格时该格被隔离为 unknown，家具本身不被动长高', async () => {
    // as-built 现在不会把家具上方的零散柱子并进家具体量（见 as-built.test.ts 的
    // "家具上方的 1×1 柱不把桌子并成高体量"）。因此北凳 bounds 保持 y1..2：
    // 家具核对不报 bounds 失配，多出来的那一格作为 unknown 只出现在"未验证对象"里，不拦 submit。
    const { spec } = loadSpec(TEA_HOUSE_SPEC);
    const grid = buildRun7PerfectGrid(spec);
    const oak = parseState(registry.table, 'oak_planks');
    grid.set(7, 2, 3, oak, 0, 0);
    const archive = writeArchive(grid, API_VERSION);
    const sheet = buildBuildSheet(spec);
    const result = await runCheck(grid, archive, sheet.expectedObjects, undefined, projectExpectedFurniture(spec));

    assert.match(result.text, /家具核对（仅报告）：pass 6 \/ fail 0 \/ missing 0 \/ extra 0/u);
    assert.match(result.text, /UNVERIFIED unknown@7,2,3/u);
    assert.equal(result.status, 'ok');
  });

  it('茶室 spec：拆掉北凳后家具块报 missing，check 仍 ok', async () => {
    const { spec } = loadSpec(TEA_HOUSE_SPEC);
    const grid = buildRun7PerfectGrid(spec);
    const air = parseState(registry.table, 'air');
    // f-bench-north bounds（半开区间）x7..11 / y1..2 / z3..4。
    for (let x = 7; x < 11; x += 1) {
      for (let y = 1; y < 2; y += 1) {
        for (let z = 3; z < 4; z += 1) grid.set(x, y, z, air, 0, 0);
      }
    }
    const archive = writeArchive(grid, API_VERSION);
    const sheet = buildBuildSheet(spec);
    const result = await runCheck(grid, archive, sheet.expectedObjects, undefined, projectExpectedFurniture(spec));

    assert.match(result.text, /家具核对（仅报告）：pass 5 \/ fail 0 \/ missing 1 \/ extra 0/u);
    assert.match(result.text, /- MISSING furniture f-bench-north/u);
    assert.equal(result.status, 'ok');
    assert.equal(submit({ draftVersion: 1, lastCheck: { version: 1, outcome: 'ok' } }).accepted, true);
  });
});
