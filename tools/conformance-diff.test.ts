/**
 * CONF-NEXT-03：BuildSpec 投影 + as-built 对象图 → 通用 diff 的离线验收。
 *
 * 覆盖：
 * - H1–H4 good 不误报，site/furniture/unknown 记 notCompared；
 * - 内存注入错误（删墙 / 少玻璃 / 门高 / 屋面抬高 / 改坡）能抓住；
 * - 投影多 level 时标 unverified；
 * - CLI 读 build-spec.json + building.pgar 的输出 / 退出码。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { extractAsBuiltObjects } from '@pg/analysis/as-built';
import type { AsBuiltObject, AsBuiltObjectGraph } from '@pg/analysis/as-built';
import { diffObjects } from '@pg/analysis/object-diff';
import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { parseState } from '@pg/core/block-state';
import type { Cell, Grid } from '@pg/core/grid';
import { BuildSpec } from '@pg/interaction/schema';

import { buildConformanceDiffReport, runConformanceDiff } from './conformance-diff.ts';
import type { ConformanceDiffReport } from './conformance-diff.ts';
import { projectExpectedObjects } from './conformance-expect.ts';
import { buildFixture } from './conformance-matrix-fixtures.ts';
import type { HouseKey } from './conformance-matrix-fixtures.ts';

const registry = loadRegistry();
const air = parseState(registry.table, 'air');

type Box = readonly [number, number, number, number, number, number];

function clearCells(grid: Grid, bounds: Box): void {
  for (let x = bounds[0]; x < bounds[3]; x += 1) {
    for (let y = bounds[1]; y < bounds[4]; y += 1) {
      for (let z = bounds[2]; z < bounds[5]; z += 1) grid.set(x, y, z, air, 0, 0);
    }
  }
}

function fillCells(grid: Grid, bounds: Box, state: Cell['state']): void {
  for (let x = bounds[0]; x < bounds[3]; x += 1) {
    for (let y = bounds[1]; y < bounds[4]; y += 1) {
      for (let z = bounds[2]; z < bounds[5]; z += 1) grid.set(x, y, z, state, 0, 0);
    }
  }
}

function reportForSpec(spec: BuildSpec, grid: Grid): ConformanceDiffReport {
  return buildConformanceDiffReport({
    spec,
    grid,
    registry,
    specPath: 'memory/build-spec.json',
    specSha256: '0'.repeat(64),
    archivePath: 'memory/building.pgar',
    archiveSha256: '1'.repeat(64),
    archiveBytes: 0,
  });
}

function reportFor(house: HouseKey, mutate: (grid: Grid) => void = () => undefined): ConformanceDiffReport {
  const fixture = buildFixture(house, 'good');
  mutate(fixture.grid);
  return reportForSpec(fixture.spec, fixture.grid);
}

function itemsOfKind(report: ConformanceDiffReport, kind: string): ConformanceDiffReport['items'] {
  return report.items.filter((item) => item.kind === kind);
}

function assertBlocking(report: ConformanceDiffReport): void {
  assert.equal(report.summary.blocking, true);
  assert.ok(report.summary.blockingCount > 0);
  assert.equal(report.summary.fullyVerified, false);
}

function capture(): {
  io: { stdout: (line: string) => void; stderr: (line: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
    out,
    err,
  };
}

describe('CONF-NEXT-03：H1–H4 good 不误报', () => {
  for (const house of ['H1', 'H2', 'H3', 'H4'] as const) {
    it(`${house}：blocking=false，所有期望 wall/slab/roof/opening pass`, () => {
      const fixture = buildFixture(house, 'good');
      const projection = projectExpectedObjects(fixture.spec);
      assert.deepEqual(projection.counts, { wall: 1, slab: 1, roof: 1, opening: 2 });

      const report = reportFor(house);

      assert.equal(report.expected.count, 5);
      assert.deepEqual(report.expected.counts, { wall: 1, slab: 1, roof: 1, opening: 2 });
      assert.equal(report.summary.blocking, false);
      assert.equal(report.summary.blockingCount, 0);
      assert.equal(report.summary.fullyVerified, true);
      assert.equal(report.summary.fail, 0);
      assert.equal(report.summary.missing, 0);
      assert.equal(report.summary.extra, 0);
      assert.equal(report.summary.unverified, 0);
      assert.equal(report.summary.pass, 5);
      assert.equal(report.context.openings.length, 2);
      assert.equal(
        report.items.every((item) => item.status === 'pass' && item.severity === 'hard'),
        true,
      );

      for (const expected of projection.objects) {
        const item = report.items.find((entry) => entry.expectedId === expected.id);
        assert.ok(item !== undefined, `${house} 缺 ${expected.id} 的 diff item`);
        assert.equal(item.status, 'pass', `${house} ${expected.id} 未 pass`);
      }

      // 实际 wall 面板数量 / roof topCells 由 conformance-objects.test.ts 回归；这里只认 diff 结果。
      assert.equal(report.notCompared.site, 1);
      assert.equal(report.notCompared.furniture, 0);
      assert.equal(report.notCompared.unknown, 0);
    });
  }
});

describe('CONF-NEXT-03：内存注入错误能抓住', () => {
  it('删掉整面北墙：wall fail（覆盖检查），opening 不再 pass', () => {
    // H2 北墙实际范围：[1,1,1]–[11,5,2]（半开）。
    const report = reportFor('H2', (grid) => {
      clearCells(grid, [1, 1, 1, 11, 5, 2]);
    });
    assertBlocking(report);
    const wall = itemsOfKind(report, 'wall')[0];
    assert.ok(wall !== undefined);
    assert.equal(wall.status, 'fail');
    assert.ok(Object.keys(wall.delta).includes('coverage'));
    assert.equal(
      itemsOfKind(report, 'opening').some((item) => item.status !== 'pass'),
      true,
    );
  });

  it('窗少一格玻璃：opening fail（geometry）', () => {
    // H1 东窗实际范围：[6,2,2]–[7,4,4]；只挖掉一格玻璃。
    const report = reportFor('H1', (grid) => {
      clearCells(grid, [6, 2, 2, 7, 3, 3]);
    });
    assertBlocking(report);
    const window = itemsOfKind(report, 'opening').find((item) => item.expectedId === 'opening:op-h1-window');
    assert.ok(window !== undefined);
    assert.equal(window.status, 'fail');
    assert.deepEqual(Object.keys(window.delta), ['geometry']);
  });

  it('门高多一格：opening height fail', () => {
    // H1 北门 [3,1,1]–[5,3,2]；把门楣下方再挖掉一层，形成 y=1..4 的三格高门。
    const report = reportFor('H1', (grid) => {
      clearCells(grid, [3, 3, 1, 5, 4, 2]);
    });
    assertBlocking(report);
    const door = itemsOfKind(report, 'opening').find((item) => item.expectedId === 'opening:op-h1-door');
    assert.ok(door !== undefined);
    assert.equal(door.status, 'fail');
    assert.ok(Object.keys(door.delta).includes('height'));
    assert.deepEqual(door.delta['height'], { expected: 2, actual: 3, delta: 1 });
  });

  it('对象图 opening 低 confidence 只作 context，evaluateOpenings 仍判门高 fail', () => {
    const fixture = buildFixture('H1', 'good');
    clearCells(fixture.grid, [3, 3, 1, 5, 4, 2]);
    const baseGraph = extractAsBuiltObjects(fixture.grid, registry);
    const lowGraph: AsBuiltObjectGraph = {
      ...baseGraph,
      objects: baseGraph.objects.map((object): AsBuiltObject => {
        if (object.kind !== 'opening' || object.bounds.min[0] !== 3) return object;
        return {
          ...object,
          confidence: 'low',
          opening: { ...object.opening, subtype: 'unknown', fill: 'solid' },
        };
      }),
    };
    const report = buildConformanceDiffReport({
      spec: fixture.spec,
      grid: fixture.grid,
      registry,
      graph: lowGraph,
      specPath: 'memory/build-spec.json',
      specSha256: '0'.repeat(64),
      archivePath: 'memory/building.pgar',
      archiveSha256: '1'.repeat(64),
      archiveBytes: 0,
    });
    const door = itemsOfKind(report, 'opening').find((item) => item.expectedId === 'opening:op-h1-door');
    assert.ok(door !== undefined);
    assert.equal(door.status, 'fail');
    assert.equal(door.severity, 'hard');
    assert.deepEqual(door.delta['height'], { expected: 2, actual: 3, delta: 1 });
    assert.equal(
      report.context.openings.some((opening) => opening.confidence === 'low'),
      true,
    );
    assert.equal(report.items.filter((item) => item.kind === 'opening').length, 2);
    assert.equal(report.summary.blocking, true);
  });

  it('soft threshold check 不升级 hard：移除 musts + 抬高室外 pad', () => {
    const fixture = buildFixture('H1', 'good');
    fillCells(fixture.grid, [3, 1, 0, 5, 2, 1], parseState(registry.table, 'gravel'));
    const softSpec = BuildSpec.parse({
      ...fixture.spec,
      musts: fixture.spec.musts.filter((must) => must.id !== 'must-no-step' && must.id !== 'must-door-clear'),
    });
    const soft = reportForSpec(softSpec, fixture.grid);
    const softDoor = itemsOfKind(soft, 'opening').find((item) => item.expectedId === 'opening:op-h1-door');
    assert.ok(softDoor !== undefined);
    assert.equal(softDoor.status, 'fail');
    assert.equal(softDoor.severity, 'soft');
    assert.ok(Object.keys(softDoor.delta).includes('threshold'));
    assert.equal(soft.summary.blocking, false);
    assert.equal(soft.summary.blockingCount, 0);
    assert.equal(soft.summary.fullyVerified, false);

    const hard = reportForSpec(fixture.spec, fixture.grid);
    const hardDoor = itemsOfKind(hard, 'opening').find((item) => item.expectedId === 'opening:op-h1-door');
    assert.ok(hardDoor !== undefined);
    assert.equal(hardDoor.status, 'fail');
    assert.equal(hardDoor.severity, 'hard');
    assert.equal(hard.summary.blocking, true);
  });

  it('spec 外的高置信玻璃窗 → extra soft，不加时没有 extra', () => {
    const fixture = buildFixture('H1', 'good');
    assert.equal(reportForSpec(fixture.spec, fixture.grid).summary.extra, 0);

    // 西墙 x=1，z2..3、y2..3 开一扇 2×2 玻璃窗；不在 BuildSpec.openings 中。
    clearCells(fixture.grid, [1, 2, 2, 2, 4, 4]);
    fillCells(fixture.grid, [1, 2, 2, 2, 4, 4], parseState(registry.table, 'glass'));
    const report = reportForSpec(fixture.spec, fixture.grid);
    const extra = report.items.find((item) => item.status === 'extra' && item.kind === 'opening');
    assert.ok(extra !== undefined);
    assert.equal(extra.severity, 'soft');
    assert.equal(extra.expectedId, null);
    assert.match(extra.actualId ?? '', /^opening@/);
    assert.equal(report.summary.extra, 1);
    assert.equal(report.summary.blocking, false);
    assert.equal(report.summary.fullyVerified, false);
    assert.equal(report.items.filter((item) => item.kind === 'opening').length, 3);
  });

  it('屋面整体抬高 1 格：roof eave / ridge fail', () => {
    const fixture = buildFixture('H1', 'good');
    const baseGraph = extractAsBuiltObjects(fixture.grid, registry);
    const roof = baseGraph.objects.find((object) => object.kind === 'roof');
    assert.ok(roof !== undefined);
    const roofBlock = roof.materials[0]?.block;
    assert.ok(roofBlock !== undefined);
    const blockState = parseState(registry.table, roofBlock);

    const report = reportFor('H1', (grid) => {
      fillCells(grid, [1, 6, 1, 7, 7, 6], blockState);
    });
    assertBlocking(report);
    const item = itemsOfKind(report, 'roof')[0];
    assert.ok(item !== undefined);
    assert.equal(item.status, 'fail');
    assert.ok(Object.keys(item.delta).includes('eaveY'));
    assert.ok(Object.keys(item.delta).includes('ridgeY'));
  });

  it('双坡改坡：roof pitch / ridge 偏离超过容差', () => {
    // H2 屋脊在 x=5；削掉脊线一层，25° → 22.5°，超过 ±2° 容差。
    const report = reportFor('H2', (grid) => {
      clearCells(grid, [5, 7, 1, 6, 8, 9]);
    });
    assertBlocking(report);
    const roof = itemsOfKind(report, 'roof')[0];
    assert.ok(roof !== undefined);
    assert.equal(roof.status, 'fail');
    assert.ok(Object.keys(roof.delta).includes('pitchDegrees'));
    assert.ok(Object.keys(roof.delta).includes('ridgeY'));
  });
});

describe('CONF-NEXT-03：投影与确定性', () => {
  it('多 level 的 wall / slab 不硬猜，标 unverified', () => {
    const fixture = buildFixture('H1', 'good');
    const multi = BuildSpec.parse({
      ...fixture.spec,
      levels: [...fixture.spec.levels, { id: 'f2', name: '二层', elevation: 5, height: 3 }],
    });
    const projection = projectExpectedObjects(multi);
    const unverified = projection.objects.filter((object) => object.unverifiedReason !== null);
    assert.equal(unverified.length, 4);
    assert.equal(unverified.filter((object) => object.kind === 'wall').length, 2);
    assert.equal(unverified.filter((object) => object.kind === 'slab').length, 2);
    const graph = extractAsBuiltObjects(fixture.grid, registry);
    const report = diffObjects(projection.objects, graph);
    assert.equal(report.summary.unverified, 4);
    assert.equal(report.summary.blocking, true);
  });

  it('同一输入重复 diff，JSON 完全一致', () => {
    const fixture = buildFixture('H3', 'good');
    const projection = projectExpectedObjects(fixture.spec);
    const graph = extractAsBuiltObjects(fixture.grid, registry);
    assert.equal(
      JSON.stringify(diffObjects(projection.objects, graph)),
      JSON.stringify(diffObjects(projection.objects, graph)),
    );
  });
});

describe('CONF-NEXT-03：CLI', () => {
  it('H1 good：读写 build-spec.json + building.pgar，exit 0，报告 blocking=false', () => {
    const fixture = buildFixture('H1', 'good');
    const dir = mkdtempSync(join(tmpdir(), 'pg-conformance-diff-'));
    try {
      const specPath = join(dir, 'build-spec.json');
      const archivePath = join(dir, 'building.pgar');
      const outPath = join(dir, 'report.json');
      writeFileSync(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
      writeFileSync(archivePath, writeArchive(fixture.grid, 1));
      const captured = capture();
      const code = runConformanceDiff(['--spec', specPath, '--archive', archivePath, '--out', outPath], {
        io: captured.io,
      });
      assert.equal(code, 0);
      assert.equal(captured.err.length, 0);
      const report = JSON.parse(readFileSync(outPath, 'utf8')) as {
        tool: string;
        summary: { blocking: boolean; fullyVerified: boolean };
        expected: { count: number };
      };
      assert.equal(report.tool, 'conformance-diff');
      assert.equal(report.summary.blocking, false);
      assert.equal(report.summary.fullyVerified, true);
      assert.equal(report.expected.count, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('注入坏墙后 exit 1；--help exit 0；缺参数 exit 2', () => {
    const fixture = buildFixture('H2', 'good');
    clearCells(fixture.grid, [1, 1, 1, 11, 5, 2]);
    const dir = mkdtempSync(join(tmpdir(), 'pg-conformance-diff-'));
    try {
      const specPath = join(dir, 'build-spec.json');
      const archivePath = join(dir, 'building.pgar');
      writeFileSync(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
      writeFileSync(archivePath, writeArchive(fixture.grid, 1));
      const failed = capture();
      assert.equal(runConformanceDiff(['--spec', specPath, '--archive', archivePath], { io: failed.io }), 1);
      const report = JSON.parse(failed.out.join('\n')) as { summary: { blocking: boolean } };
      assert.equal(report.summary.blocking, true);

      const help = capture();
      assert.equal(runConformanceDiff(['--help'], { io: help.io }), 0);
      assert.match(help.out.join('\n'), /--spec/);

      const missing = capture();
      assert.equal(runConformanceDiff(['--archive', archivePath], { io: missing.io }), 2);
      assert.match(missing.err.join('\n'), /缺少 --spec/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildConformanceDiffReport 的 actual / notCompared / notes 与 graph 一致', () => {
    const fixture = buildFixture('H3', 'good');
    const report = buildConformanceDiffReport({
      spec: fixture.spec,
      grid: fixture.grid,
      registry,
      specPath: 'memory/build-spec.json',
      specSha256: '0'.repeat(64),
      archivePath: 'memory/building.pgar',
      archiveSha256: '1'.repeat(64),
      archiveBytes: 123,
    });
    assert.equal(report.actual.bounds !== null, true);
    assert.equal(report.notCompared.site, 1);
    assert.equal(report.summary.blocking, false);
    assert.equal(
      report.notes.some((note) => note.includes('site / furniture / unknown')),
      true,
    );
  });
});
