/**
 * 多房子矩阵 harness 测试：fixture 独立性、12 case 输出契约、good / wrong / unsupported 语义、
 * prototype-gap / false-negative / unexpected 分类、默认与 --strict 退出码、CLI 输出与临时目录清理。
 * 所有 fixture 在临时目录生成并清理，不依赖 .work。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Cell, Grid } from '@pg/core/grid';
import { BuildSpec } from '@pg/interaction/schema';
import type { Bounds } from '@pg/interaction/schema';

import {
  MATRIX_EXPECTATIONS,
  evaluateCase,
  exitCodeFor,
  main,
  parseMatrixArgs,
  runConformanceMatrix,
  summarizeCases,
} from './conformance-matrix.ts';
import type { MatrixReport } from './conformance-matrix.ts';
import { buildFixture, buildGrid, buildSpec, selfCheckInputFor } from './conformance-matrix-fixtures.ts';
import { FixtureError, assertFixtureGeometry, padBounds } from './conformance-matrix-selfcheck.ts';
import type { SelfCheckInput, SelfCheckOpening } from './conformance-matrix-selfcheck.ts';
import type { ConformanceCheck, ConformanceReport } from './design-conformance.ts';

function matrixReport(): MatrixReport {
  return runConformanceMatrix();
}

function capture(): {
  readonly out: string[];
  readonly err: string[];
  readonly io: { readonly stdout: (line: string) => void; readonly stderr: (line: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line) => {
        out.push(line);
      },
      stderr: (line) => {
        err.push(line);
      },
    },
  };
}

function fakeCheck(
  id: string,
  status: ConformanceCheck['status'],
  severity: ConformanceCheck['severity'],
): ConformanceCheck {
  return {
    id,
    status,
    severity,
    detail: 'fake check',
    expected: 'expected',
    actual: 'actual',
    evidence: [{ x: 0, y: 0, z: 0, block: 'air', call: 0, line: 0 }],
  };
}

function fakeReport(options: {
  readonly blocking: boolean;
  readonly fullyVerified: boolean;
  readonly checks: readonly ConformanceCheck[];
}): ConformanceReport {
  const { blocking, fullyVerified, checks } = options;
  const count = (status: ConformanceCheck['status']): number =>
    checks.filter((check) => check.status === status).length;
  return {
    schemaVersion: 1,
    ok: !blocking,
    blocking,
    fullyVerified,
    spec: {},
    actual: {},
    checks,
    provenance: {},
    summary: {
      pass: count('pass'),
      fail: count('fail'),
      unverified: count('unverified'),
      hardFailures: checks.filter((check) => check.status === 'fail' && check.severity === 'hard').length,
      hardUnverified: checks.filter((check) => check.status === 'unverified' && check.severity === 'hard').length,
      blockingFailures: checks.filter((check) => check.status === 'fail' && check.severity === 'hard').length,
      blockingUnverified: checks.filter((check) => check.status === 'unverified' && check.severity === 'hard').length,
    },
  };
}

function expectationOf(house: string, variant: string): (typeof MATRIX_EXPECTATIONS)[number] {
  const expectation = MATRIX_EXPECTATIONS.find((item) => item.house === house && item.variant === variant);
  assert.ok(expectation !== undefined, `${house}/${variant} 缺 expectation`);
  return expectation;
}

function materialBlock(spec: BuildSpec, role: string): string {
  const material = spec.materials.find((item) => item.role === role);
  assert.ok(material !== undefined, `缺 role=${role} 的材质`);
  return material.block.split('[')[0] ?? material.block;
}

function addCell(grid: Grid, x: number, y: number, z: number, block: string): void {
  const state = parseState(grid.table, block);
  const call = grid.defineCall('set', 1, { fixture: 'selfcheck-negative' });
  grid.set(x, y, z, state, 0, call);
}

function cloneGrid(source: Grid, keep?: (cell: Cell) => boolean): Grid {
  const grid = createGrid(source.table);
  const call = grid.defineCall('set', 1, { fixture: 'selfcheck-negative' });
  for (const cell of source.cells()) {
    if (keep === undefined || keep(cell)) grid.set(cell.x, cell.y, cell.z, cell.state, 0, call);
  }
  return grid;
}

function box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Bounds {
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function doorOf(input: SelfCheckInput): SelfCheckOpening {
  const door = input.openings.find((opening) => opening.kind === 'door');
  assert.ok(door !== undefined, 'fixture 缺门洞');
  return door;
}

test('12 个 fixture 从零构造：尺寸 / 屋面材质 / 洞口坐标互不相同', () => {
  const fixtures = MATRIX_EXPECTATIONS.map((expectation) => buildFixture(expectation.house, expectation.variant));
  assert.equal(fixtures.length, 12);
  assert.equal(new Set(fixtures.map((fixture) => fixture.spec.schemeId)).size, 4);
  assert.ok(fixtures.every((fixture) => fixture.spec.schemeId.startsWith('matrix-')));

  const good = (['H1', 'H2', 'H3', 'H4'] as const).map((house) => buildFixture(house, 'good'));
  const dimensions = good.map((fixture) => [
    fixture.spec.bounds.max[0] - fixture.spec.bounds.min[0],
    fixture.spec.bounds.max[2] - fixture.spec.bounds.min[2],
  ]);
  assert.deepEqual(dimensions, [
    [6, 5],
    [10, 8],
    [8, 6],
    [8, 10],
  ]);

  const roofBlocks = new Set(
    good.map((fixture) => fixture.spec.materials.find((material) => material.role === 'roof')?.block),
  );
  assert.equal(roofBlocks.size, 4);

  const openingKeys = new Set(
    good.map((fixture) =>
      JSON.stringify(fixture.spec.openings.map((opening) => [opening.side, opening.kind, opening.bounds])),
    ),
  );
  assert.equal(openingKeys.size, 4);
});

test('fixture 自检入口：12 个 variant 都能通过 buildFixture 自检', () => {
  for (const expectation of MATRIX_EXPECTATIONS) {
    const fixture = buildFixture(expectation.house, expectation.variant);
    assert.equal(fixture.spec.levels[0]?.elevation, 1);
    const bounds = fixture.grid.bounds();
    assert.ok(bounds !== undefined, `${expectation.house}/${expectation.variant} grid 为空`);
    assert.ok(bounds.min[1] >= fixture.spec.siteBounds.min[1]);
    assert.ok(bounds.max[1] <= fixture.spec.siteBounds.max[1] - 1);
  }
});

test('自检负例：门洞 hole 小于 bounds 抛 FixtureError', () => {
  const spec = buildSpec('H1', 'good');
  const grid = buildGrid('H1', 'good');
  const input = selfCheckInputFor('H1', 'good');
  const door = doorOf(input);
  const smaller = box(
    door.bounds.min[0],
    door.bounds.min[1],
    door.bounds.min[2],
    door.bounds.max[0],
    door.bounds.max[1] - 1,
    door.bounds.max[2],
  );
  const mutated: SelfCheckInput = {
    ...input,
    openings: input.openings.map((opening) => (opening.id === door.id ? { ...opening, hole: smaller } : opening)),
  };
  assert.throws(
    () => {
      assertFixtureGeometry(spec, grid, mutated);
    },
    (error: unknown) => error instanceof FixtureError && /实际挖空.*bounds/.test(error.message),
  );
});

test('自检负例：门洞 hole 与 grid 一起上移 1 格仍被抓', () => {
  const spec = buildSpec('H1', 'good');
  const grid = buildGrid('H1', 'good');
  const input = selfCheckInputFor('H1', 'good');
  const door = doorOf(input);
  const wall = materialBlock(spec, 'wall');
  const shiftedGrid = cloneGrid(
    grid,
    (cell) =>
      !(
        cell.state.name === wall &&
        cell.y === door.bounds.max[1] &&
        cell.x >= door.bounds.min[0] &&
        cell.x < door.bounds.max[0] &&
        cell.z >= door.bounds.min[2] &&
        cell.z < door.bounds.max[2]
      ),
  );
  for (let x = door.bounds.min[0]; x < door.bounds.max[0]; x += 1) {
    for (let z = door.bounds.min[2]; z < door.bounds.max[2]; z += 1) {
      addCell(shiftedGrid, x, door.bounds.min[1], z, wall);
    }
  }
  const shiftedHole = box(
    door.bounds.min[0],
    door.bounds.min[1] + 1,
    door.bounds.min[2],
    door.bounds.max[0],
    door.bounds.max[1] + 1,
    door.bounds.max[2],
  );
  const mutated: SelfCheckInput = {
    ...input,
    openings: input.openings.map((opening) => (opening.id === door.id ? { ...opening, hole: shiftedHole } : opening)),
  };
  assert.throws(
    () => {
      assertFixtureGeometry(spec, shiftedGrid, mutated);
    },
    (error: unknown) => error instanceof FixtureError && /实际挖空.*bounds/.test(error.message),
  );
});

test('自检负例：spec.bounds 外多一块 floor 抛 FixtureError', () => {
  const spec = buildSpec('H3', 'good');
  const grid = buildGrid('H3', 'good');
  addCell(grid, spec.bounds.max[0], 0, spec.bounds.min[2], materialBlock(spec, 'floor'));
  assert.throws(
    () => {
      assertFixtureGeometry(spec, grid, selfCheckInputFor('H3', 'good'));
    },
    (error: unknown) => error instanceof FixtureError && /超出 spec.bounds/.test(error.message),
  );
});

test('自检负例：屋面缺一列抛 FixtureError', () => {
  const spec = buildSpec('H3', 'good');
  const grid = buildGrid('H3', 'good');
  const roof = materialBlock(spec, 'roof');
  const missing = cloneGrid(grid, (cell) => !(cell.state.name === roof && cell.x === 1 && cell.z === 3));
  assert.throws(
    () => {
      assertFixtureGeometry(spec, missing, selfCheckInputFor('H3', 'good'));
    },
    (error: unknown) => error instanceof FixtureError && error.message.includes('缺屋面块'),
  );
});

test('自检负例：footprint 外多一列屋面抛 FixtureError', () => {
  const spec = buildSpec('H4', 'good');
  const grid = buildGrid('H4', 'good');
  addCell(grid, 8, 5, 9, materialBlock(spec, 'roof'));
  assert.throws(
    () => {
      assertFixtureGeometry(spec, grid, selfCheckInputFor('H4', 'good'));
    },
    (error: unknown) => error instanceof FixtureError && error.message.includes('footprint 外'),
  );
});

test('自检负例：室外 pad 低一格抛 FixtureError', () => {
  const spec = buildSpec('H1', 'good');
  const grid = buildGrid('H1', 'good');
  const input = selfCheckInputFor('H1', 'good');
  const door = doorOf(input);
  const ground = materialBlock(spec, 'landscape');
  const pad = padBounds(door, input.elevation);
  const lowGrid = cloneGrid(
    grid,
    (cell) =>
      !(
        cell.state.name === ground &&
        cell.y === input.elevation - 1 &&
        cell.x >= pad.min[0] &&
        cell.x < pad.max[0] &&
        cell.z >= pad.min[2] &&
        cell.z < pad.max[2]
      ),
  );
  for (let x = pad.min[0]; x < pad.max[0]; x += 1) {
    for (let z = pad.min[2]; z < pad.max[2]; z += 1) {
      addCell(lowGrid, x, input.elevation - 2, z, ground);
    }
  }
  const lowerSite = BuildSpec.parse({
    ...spec,
    siteBounds: box(
      spec.siteBounds.min[0],
      spec.siteBounds.min[1] - 1,
      spec.siteBounds.min[2],
      spec.siteBounds.max[0],
      spec.siteBounds.max[1],
      spec.siteBounds.max[2],
    ),
  });
  assert.throws(
    () => {
      assertFixtureGeometry(lowerSite, lowGrid, input);
    },
    (error: unknown) => error instanceof FixtureError && /室外 pad.*顶面/.test(error.message),
  );
});

test('fixture / harness 错误归类为 unexpected，不能算 prototype-gap', () => {
  const report = runConformanceMatrix({
    buildFixture: () => {
      throw new FixtureError('fixture self-check failed');
    },
  });
  assert.equal(report.summary.unexpected, 12);
  assert.equal(report.summary.prototypeGap, 0);
  assert.equal(report.summary.falsePositive, 0);
  assert.equal(report.summary.falseNegative, 0);
  assert.equal(exitCodeFor(report, false), 1);
  for (const item of report.cases) assert.equal(item.status, 'unexpected');
});

test('矩阵 12 met / 0 prototype-gap / 0 false-positive / 0 false-negative / 0 unexpected', () => {
  const report = matrixReport();
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.cases.length, 12);
  assert.deepEqual(report.summary, {
    total: 12,
    met: 12,
    prototypeGap: 0,
    falsePositive: 0,
    falseNegative: 0,
    unexpected: 0,
  });

  for (const item of report.cases) {
    assert.ok(item.house.length > 0);
    assert.ok(item.houseLabel.length > 0);
    assert.ok(item.expected.length > 0);
    assert.ok(item.actual.summary !== null);
    assert.ok(item.actual.blocking !== null);
    assert.ok(item.actual.fullyVerified !== null);
    assert.equal(item.status, 'met', `${item.house}/${item.variant}: ${item.gapReason ?? ''}`);
    assert.equal(item.gapReason, null);
  }

  const keys = new Set(report.cases.map((item) => `${item.house}/${item.variant}`));
  assert.equal(keys.size, 12);
});

test('语义检查：wrong 属于预期族，unsupported 只报 soft unverified', () => {
  const report = matrixReport();

  for (const item of report.cases.filter((candidate) => candidate.variant === 'wrong')) {
    assert.equal(item.status, 'met', `${item.house} wrong: ${item.gapReason ?? ''}`);
    assert.equal(item.actual.blocking, true, `${item.house} wrong 应 blocking`);
    const family = item.expectedFamily;
    const familyFailures = item.actual.failures.filter((failure) => failure.id.startsWith(`${family ?? ''}.`));
    assert.ok(familyFailures.length > 0, `${item.house} wrong 应命中 ${String(family)} 族`);
    assert.ok(
      familyFailures.every((failure) => failure.evidence.length > 0),
      `${item.house} wrong 的 hard fail 应带 evidence`,
    );
  }

  for (const item of report.cases.filter((candidate) => candidate.variant === 'unsupported')) {
    assert.equal(item.status, 'met', `${item.house} unsupported: ${item.gapReason ?? ''}`);
    assert.equal(item.actual.blocking, false, `${item.house} unsupported 不应 blocking`);
    assert.equal(item.actual.fullyVerified, false, `${item.house} unsupported 不应 fullyVerified`);
    assert.equal(item.actual.softUnverified.length, 4, `${item.house} unsupported 应有 4 条 soft unverified`);
    assert.ok(
      item.actual.softUnverified.every((check) => check.id.startsWith('roof.')),
      `${item.house} unsupported 的 soft unverified 必须全部是 roof.*`,
    );
  }

  for (const item of report.cases.filter((candidate) => candidate.variant === 'good')) {
    assert.equal(item.status, 'met');
    assert.equal(item.actual.blocking, false, `${item.house} good 不应 blocking`);
    if (item.house === 'H4') {
      assert.equal(item.actual.fullyVerified, false, 'H4 多段屋面只能 soft unverified');
      assert.equal(item.actual.softUnverified.length, 4, 'H4 必须有 4 条 roof soft unverified');
      assert.ok(item.actual.softUnverified.every((check) => check.id.startsWith('roof.')));
    } else assert.equal(item.actual.fullyVerified, true, `${item.house} good 应 fullyVerified`);
  }
});

test('退出码：默认惩罚 false-positive / false-negative / unexpected，--strict 再惩罚 prototype-gap', () => {
  const report = matrixReport();
  assert.equal(exitCodeFor(report, false), 0);
  assert.equal(exitCodeFor(report, true), 0);

  const withGap: MatrixReport = {
    schemaVersion: 1,
    cases: [],
    summary: { total: 12, met: 11, prototypeGap: 1, falsePositive: 0, falseNegative: 0, unexpected: 0 },
  };
  assert.equal(exitCodeFor(withGap, false), 0);
  assert.equal(exitCodeFor(withGap, true), 1);

  const withFalsePositive: MatrixReport = {
    schemaVersion: 1,
    cases: [],
    summary: { total: 12, met: 11, prototypeGap: 0, falsePositive: 1, falseNegative: 0, unexpected: 0 },
  };
  assert.equal(exitCodeFor(withFalsePositive, false), 1);
  assert.equal(exitCodeFor(withFalsePositive, true), 1);

  const withFalseNegative: MatrixReport = {
    schemaVersion: 1,
    cases: [],
    summary: { total: 12, met: 11, prototypeGap: 0, falsePositive: 0, falseNegative: 1, unexpected: 0 },
  };
  assert.equal(exitCodeFor(withFalseNegative, false), 1);
  assert.equal(exitCodeFor(withFalseNegative, true), 1);

  const withUnexpected: MatrixReport = {
    schemaVersion: 1,
    cases: [],
    summary: { total: 12, met: 11, prototypeGap: 0, falsePositive: 0, falseNegative: 0, unexpected: 1 },
  };
  assert.equal(exitCodeFor(withUnexpected, false), 1);

  const empty: MatrixReport = {
    schemaVersion: 1,
    cases: [],
    summary: { total: 0, met: 0, prototypeGap: 0, falsePositive: 0, falseNegative: 0, unexpected: 0 },
  };
  assert.equal(exitCodeFor(empty, false), 1);
});

test('prototype-gap：H4 good 出现非 roof soft unverified 时仍算误报', () => {
  const expectation = expectationOf('H4', 'good');
  const withSoftDoorFail = fakeReport({
    blocking: false,
    fullyVerified: false,
    checks: [fakeCheck('roof.form', 'unverified', 'soft'), fakeCheck('door.threshold.op-h4-door', 'fail', 'soft')],
  });
  const classified = evaluateCase(expectation, withSoftDoorFail, 0);
  assert.equal(classified.status, 'prototype-gap');
  assert.match(classified.gapReason ?? '', /非 roof 检查未全 pass/);

  const matrix: MatrixReport = {
    schemaVersion: 1,
    cases: [classified],
    summary: summarizeCases([classified]),
  };
  assert.equal(matrix.summary.prototypeGap, 1);
  assert.equal(exitCodeFor(matrix, false), 0);
  assert.equal(exitCodeFor(matrix, true), 1);
});

test('false-positive：unsupported 被 blocking 时默认 exit 1，不能算 prototype-gap', () => {
  const expectation = expectationOf('H2', 'unsupported');
  const blocked = fakeReport({
    blocking: true,
    fullyVerified: false,
    checks: [
      fakeCheck('roof.form', 'unverified', 'soft'),
      fakeCheck('roof.pitch', 'unverified', 'soft'),
      fakeCheck('roof.eave', 'unverified', 'soft'),
      fakeCheck('roof.ridge', 'unverified', 'soft'),
      fakeCheck('door.height.op-h2-door', 'fail', 'hard'),
    ],
  });
  const classified = evaluateCase(expectation, blocked, 1);
  assert.equal(classified.status, 'false-positive');
  assert.match(classified.gapReason ?? '', /blocking=true/);

  const matrix: MatrixReport = {
    schemaVersion: 1,
    cases: [classified],
    summary: summarizeCases([classified]),
  };
  assert.equal(matrix.summary.falsePositive, 1);
  assert.equal(exitCodeFor(matrix, false), 1);
  assert.equal(exitCodeFor(matrix, true), 1);
});

test('prototype-gap：unsupported 出现非 roof soft fail 时不能 met', () => {
  const expectation = expectationOf('H2', 'unsupported');
  const withSoftDoorFail = fakeReport({
    blocking: false,
    fullyVerified: false,
    checks: [
      fakeCheck('roof.form', 'unverified', 'soft'),
      fakeCheck('roof.pitch', 'unverified', 'soft'),
      fakeCheck('roof.eave', 'unverified', 'soft'),
      fakeCheck('roof.ridge', 'unverified', 'soft'),
      fakeCheck('door.threshold.op-h2-door', 'fail', 'soft'),
    ],
  });
  const classified = evaluateCase(expectation, withSoftDoorFail, 0);
  assert.equal(classified.status, 'prototype-gap');
  assert.match(classified.gapReason ?? '', /非 roof 检查未全 pass/);

  const matrix: MatrixReport = {
    schemaVersion: 1,
    cases: [classified],
    summary: summarizeCases([classified]),
  };
  assert.equal(matrix.summary.prototypeGap, 1);
  assert.equal(exitCodeFor(matrix, false), 0);
  assert.equal(exitCodeFor(matrix, true), 1);
});

test('prototype-gap：H4 good 必须 4 条 roof 检查全部 soft unverified', () => {
  const expectation = expectationOf('H4', 'good');
  const partialRoof = fakeReport({
    blocking: false,
    fullyVerified: false,
    checks: [
      fakeCheck('roof.form', 'unverified', 'soft'),
      fakeCheck('roof.pitch', 'unverified', 'soft'),
      fakeCheck('roof.eave', 'unverified', 'soft'),
      fakeCheck('roof.ridge', 'pass', 'hard'),
    ],
  });
  const classified = evaluateCase(expectation, partialRoof, 0);
  assert.equal(classified.status, 'prototype-gap');
  assert.match(classified.gapReason ?? '', /roof soft unverified 3\/4/);

  const matrix: MatrixReport = {
    schemaVersion: 1,
    cases: [classified],
    summary: summarizeCases([classified]),
  };
  assert.equal(matrix.summary.prototypeGap, 1);
  assert.equal(exitCodeFor(matrix, false), 0);
  assert.equal(exitCodeFor(matrix, true), 1);
});

test('false-negative：wrong 未捕获（blocking=false）分类为 false-negative，默认 exit 1', () => {
  const expectation = expectationOf('H1', 'wrong');
  const notCaught = fakeReport({
    blocking: false,
    fullyVerified: false,
    checks: [fakeCheck('roof.eave', 'pass', 'hard')],
  });
  const classified = evaluateCase(expectation, notCaught, 0);
  assert.equal(classified.status, 'false-negative');
  assert.match(classified.gapReason ?? '', /blocking=false/);

  const matrix: MatrixReport = {
    schemaVersion: 1,
    cases: [classified],
    summary: summarizeCases([classified]),
  };
  assert.equal(matrix.summary.falseNegative, 1);
  assert.equal(exitCodeFor(matrix, false), 1);
});

test('false-negative：wrong 有 hard fail 但不属于预期族，同样默认 exit 1', () => {
  const expectation = expectationOf('H1', 'wrong');
  const wrongFamily = fakeReport({
    blocking: true,
    fullyVerified: false,
    checks: [fakeCheck('door.height.op-x', 'fail', 'hard')],
  });
  const classified = evaluateCase(expectation, wrongFamily, 1);
  assert.equal(classified.status, 'false-negative');
  assert.match(classified.gapReason ?? '', /没有 hard roof fail/);
  assert.equal(exitCodeFor({ schemaVersion: 1, cases: [classified], summary: summarizeCases([classified]) }, false), 1);
});

test('false-negative：unsupported 被 fullyVerified 属于假通过', () => {
  const expectation = expectationOf('H2', 'unsupported');
  const falsePass = fakeReport({
    blocking: false,
    fullyVerified: true,
    checks: [fakeCheck('roof.form', 'pass', 'hard')],
  });
  const classified = evaluateCase(expectation, falsePass, 0);
  assert.equal(classified.status, 'false-negative');
  assert.match(classified.gapReason ?? '', /fullyVerified=true/);

  const matrix: MatrixReport = {
    schemaVersion: 1,
    cases: [classified],
    summary: summarizeCases([classified]),
  };
  assert.equal(matrix.summary.falseNegative, 1);
  assert.equal(exitCodeFor(matrix, false), 1);
});

test('参数解析与 CLI：--help / 未知参数 / --strict / --json / --out', () => {
  assert.deepEqual(parseMatrixArgs(['--strict', '--json', '--out', 'report.json']), {
    strict: true,
    json: true,
    outPath: 'report.json',
    help: false,
  });
  assert.throws(() => parseMatrixArgs(['--wat']), /未知参数/);
  assert.throws(() => parseMatrixArgs(['--out']), /缺少取值/);

  const help = capture();
  assert.equal(main(['--help'], { io: help.io }), 0);
  assert.match(help.out.join('\n'), /用法/);

  const bad = capture();
  assert.equal(main(['--wat'], { io: bad.io }), 2);
  assert.match(bad.err.join('\n'), /未知参数/);

  const strict = capture();
  assert.equal(main(['--strict'], { io: strict.io }), 0);
  assert.match(strict.out.join('\n'), /false-positive=0/);
  assert.match(strict.out.join('\n'), /false-negative=0/);

  const dir = mkdtempSync(join(tmpdir(), 'pg-conformance-matrix-test-'));
  try {
    const outPath = join(dir, 'report.json');
    const captured = capture();
    const code = main(['--json', '--out', outPath], { io: captured.io });
    const report = JSON.parse(readFileSync(outPath, 'utf8')) as MatrixReport;
    assert.equal(code, 0);
    assert.equal(report.cases.length, 12);
    assert.equal(report.summary.falsePositive, 0);
    assert.equal(report.summary.falseNegative, 0);
    assert.equal((JSON.parse(captured.out.join('\n')) as MatrixReport).cases.length, 12);
    assert.equal(captured.err.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('矩阵运行的临时目录在结束后清理', () => {
  const prefix = 'pg-conformance-matrix-';
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)));
  const report = runConformanceMatrix();
  assert.equal(report.summary.unexpected, 0);
  const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix) && !before.has(name));
  assert.deepEqual(leftovers, []);
});
