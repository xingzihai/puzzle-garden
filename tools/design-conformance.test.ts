/* eslint-disable max-lines -- run-9 负例、合成正例与误报回归共用同一套离线 fixture。 */
/**
 * design-conformance 的离线回归：run-9 负例、合成 gable / flat 正例、run provenance fail-closed、参数 / 缺文件错误。
 * 只读本地 fixture 与临时文件；不联网、不启动 Chrome、不调用模型。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { readArchive, writeArchive } from '@pg/core/archive';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import { isFlushMustText } from '@pg/interaction/flush-text';
import { BuildSpec } from '@pg/interaction/schema';

import {
  DESIGN_CONFORMANCE_USAGE,
  evaluateOpenings,
  evaluateRoof,
  runDesignConformance,
} from './design-conformance.ts';

const FIXTURE_ROOT = resolve(import.meta.dirname, 'fixtures/design-conformance-run9');
const SESSION = join(FIXTURE_ROOT, 'session');
const RUN9 = join(FIXTURE_ROOT, '20261020-112925-build-task-c9736e');

interface CheckView {
  readonly id: string;
  readonly status: string;
  readonly severity: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly detail: string;
  readonly evidence: readonly {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly block: string;
    readonly line: number;
  }[];
}

interface ReportView {
  readonly ok: boolean;
  readonly blocking: boolean;
  readonly fullyVerified: boolean;
  readonly actual: {
    readonly codeVersion: number | null;
    readonly cells: number;
    readonly roof: {
      readonly form: string | null;
      readonly pitchDegrees: number | null;
      readonly eaveHeight: number | null;
      readonly ridgeHeight: number | null;
      readonly lowestRoofY: number | null;
    };
    readonly openings: readonly {
      readonly id: string;
      readonly kind: string;
      readonly actual: Record<string, unknown> | null;
    }[];
  };
  readonly checks: readonly CheckView[];
  readonly provenance: {
    readonly specPath: string;
    readonly runDir: string;
    readonly codeVersion: number | null;
    readonly deliveryHash: string | null;
    readonly deliveryArchiveSha256: string | null;
    readonly archive: { readonly path: string; readonly sha256: string; readonly bytes: number };
    readonly events: {
      readonly deliveryLine: number | null;
      readonly lastCheckResultLine: number | null;
      readonly archiveCheckResultLine: number | null;
    };
    readonly integrity: {
      readonly mode: 'run' | 'synthetic';
      readonly required: boolean;
      readonly taskMatches: boolean | null;
      readonly deliveryManifestPresent: boolean;
      readonly deliveryArchiveMatches: boolean | null;
      readonly deliveryEventArchiveMatches: boolean | null;
      readonly lastCheckArchiveMatches: boolean | null;
      readonly codeVersionMatchesCheck: boolean | null;
      readonly issues: readonly string[];
    };
  };
  readonly summary: {
    readonly pass: number;
    readonly fail: number;
    readonly unverified: number;
    readonly hardFailures: number;
    readonly hardUnverified: number;
    readonly blockingFailures: number;
    readonly blockingUnverified: number;
  };
}

interface Capture {
  readonly io: { readonly stdout: (line: string) => void; readonly stderr: (line: string) => void };
  readonly out: string[];
  readonly err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (line) => {
        out.push(line);
      },
      stderr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function reportFrom(captured: Capture): ReportView {
  return JSON.parse(captured.out.join('\n')) as ReportView;
}

function byId(report: ReportView, id: string): CheckView {
  const check = report.checks.find((candidate) => candidate.id === id);
  assert.ok(check, `缺少检查 ${id}`);
  return check;
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pg-conformance-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run9Spec(): BuildSpec {
  return BuildSpec.parse(readJson(join(SESSION, 'build-spec.json')));
}

function run9Grid(): ReturnType<typeof readArchive>['grid'] {
  const registry = loadRegistry();
  return readArchive(registry.table, readFileSync(join(RUN9, 'delivery/building.pgar'))).grid;
}

function syntheticSpec(roof: {
  form: 'flat' | 'gable';
  pitchDegrees: number;
  eaveHeight: number;
  ridgeHeight: number;
}): BuildSpec {
  const base = run9Spec();
  // 屋面合成 fixture 只铺屋面格；不放 openings 时会得到一条 soft unverified，而不是假 pass。
  return BuildSpec.parse({ ...base, openings: [], roof: { ...base.roof, ...roof } });
}

/** 同一 12×10 屋面 footprint；heights 给出每一列顶面 y。合成 run 只写 delivery.json，不带 events。 */
function writeSyntheticRun(
  dir: string,
  name: string,
  spec: BuildSpec,
  heights: readonly number[],
): { runDir: string; specPath: string } {
  const runDir = join(dir, name);
  mkdirSync(join(runDir, 'delivery'), { recursive: true });
  const registry = loadRegistry();
  const grid = createGrid(registry.table);
  const roofState = parseState(registry.table, 'deepslate_tiles');
  const call = grid.defineCall('set', 42, { block: 'deepslate_tiles' });
  const bottom = Math.min(...heights);
  for (let x = 1; x <= 12; x += 1) {
    for (let z = 1; z <= 10; z += 1) {
      const top = heights[z - 1] ?? bottom;
      for (let y = bottom; y <= top; y += 1) grid.set(x, y, z, roofState, 0, call);
    }
  }
  const bytes = Buffer.from(writeArchive(grid, 9));
  const archiveSha = sha256(bytes);
  writeFileSync(join(runDir, 'delivery', 'building.pgar'), bytes);
  writeFileSync(
    join(runDir, 'delivery', 'delivery.json'),
    `${JSON.stringify({ archive: { sha256: archiveSha, bytes: bytes.length }, hash: `synthetic-${name}`, codeVersion: 7 }, null, 2)}\n`,
    'utf8',
  );
  const specPath = join(dir, `${name}-spec.json`);
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  return { runDir, specPath };
}

/** 合成干净门窗：10×8 单层、flat 屋面、北门 2×2、南窗 4×2，门槛与室内外地面同为 y=1。 */
interface GoodOpeningOptions {
  readonly glassBlock?: string;
  readonly glassOffsetX?: number;
  readonly omitGlass?: readonly { readonly x: number; readonly y: number }[];
  readonly doorOffsetX?: number;
  readonly doorLintelMissingAt?: number;
  readonly adjacentWindow?: boolean;
  readonly carpet?: boolean;
  readonly outdoorStep?: boolean;
  readonly clearanceBlocker?: boolean;
  readonly musts?: BuildSpec['musts'];
}

function writeGoodOpeningRun(dir: string, options: GoodOpeningOptions = {}): { runDir: string; specPath: string } {
  const base = run9Spec();
  const windowTemplate = base.openings.find((opening) => opening.id === 'op-south-window');
  if (windowTemplate === undefined) throw new Error('run-9 fixture 缺 op-south-window');
  // B 窗紧贴 A 窗（x9..10 vs x5..8），用于证明完整窗的 summary 不会被邻居撑宽。
  const adjacentWindows =
    options.adjacentWindow === true
      ? [
          {
            ...windowTemplate,
            id: 'op-south-window-b',
            name: '南墙相邻小窗',
            bounds: { min: [9, 2, 9], max: [11, 4, 10] },
            width: 2,
          },
        ]
      : [];
  const spec = BuildSpec.parse({
    ...base,
    musts: options.musts ?? base.musts,
    roof: { ...base.roof, form: 'flat', pitchDegrees: 0, eaveHeight: 5, ridgeHeight: 5 },
    openings: [
      ...base.openings.map((opening) => (opening.id === 'op-entry-north' ? { ...opening, kind: 'door' } : opening)),
      ...adjacentWindows,
    ],
  });
  const doorFirst = 3 + (options.doorOffsetX ?? 0);
  const doorLast = 4 + (options.doorOffsetX ?? 0);
  const glassBlock = options.glassBlock ?? 'glass';
  const runDir = join(dir, 'run-good-openings');
  mkdirSync(join(runDir, 'delivery'), { recursive: true });
  const registry = loadRegistry();
  const grid = createGrid(registry.table);
  const call = grid.defineCall('set', 1, { fixture: 'good-openings' });
  const put = (x: number, y: number, z: number, block: string): void => {
    grid.set(x, y, z, parseState(registry.table, block), 0, call);
  };

  for (let x = 2; x <= 11; x += 1) {
    for (let y = 1; y <= 4; y += 1) {
      const door = x >= doorFirst && x <= doorLast && (y === 2 || y === 3);
      const window = x >= 5 && x <= 8 && (y === 2 || y === 3);
      const adjacent = options.adjacentWindow === true && x >= 9 && x <= 10 && (y === 2 || y === 3);
      const missingLintel = options.doorLintelMissingAt === x && y === 4;
      if (!door && !missingLintel) put(x, y, 2, 'oak_planks');
      if (!window && !adjacent) put(x, y, 9, 'oak_planks');
    }
  }
  for (let z = 2; z <= 9; z += 1) {
    for (let y = 1; y <= 4; y += 1) {
      put(2, y, z, 'oak_planks');
      put(11, y, z, 'oak_planks');
    }
  }
  for (let x = 2; x <= 11; x += 1) {
    for (let z = 2; z <= 9; z += 1) put(x, 1, z, 'polished_andesite');
  }
  for (let x = doorFirst; x <= doorLast; x += 1) {
    put(x, 1, 2, 'stone_bricks');
    put(x, options.outdoorStep === true ? 0 : 1, 1, 'gravel');
  }
  const windowColumns = options.adjacentWindow === true ? [5, 6, 7, 8, 9, 10] : [5, 6, 7, 8];
  for (const x of windowColumns) {
    put(x, 1, 9, 'stone_bricks');
    for (let y = 2; y <= 3; y += 1) {
      const omitted = options.omitGlass?.some((point) => point.x === x && point.y === y) ?? false;
      if (!omitted) put(x + (options.glassOffsetX ?? 0), y, 9, glassBlock);
    }
  }
  if (options.carpet === true) {
    // 门槛顶面、门内 1m 净空带（北门内侧 z=3）、窗外 1 格壳都铺地毯：软装不改变通行 / 遮挡判定。
    for (let x = doorFirst; x <= doorLast; x += 1) {
      put(x, 2, 2, 'white_carpet');
      for (let y = 2; y <= 3; y += 1) {
        put(x, y, 1, 'white_carpet');
        put(x, y, 3, 'white_carpet');
        put(x, y, 10, 'white_carpet');
      }
    }
  }
  if (options.clearanceBlocker === true) {
    for (let x = doorFirst; x <= doorLast; x += 1) put(x, 3, 3, 'oak_planks');
  }
  for (let x = 1; x <= 12; x += 1) {
    for (let z = 1; z <= 10; z += 1) put(x, 5, z, 'deepslate_tiles');
  }

  const bytes = Buffer.from(writeArchive(grid, 9));
  const archiveSha = sha256(bytes);
  writeFileSync(join(runDir, 'delivery', 'building.pgar'), bytes);
  writeFileSync(
    join(runDir, 'delivery', 'delivery.json'),
    `${JSON.stringify({ archive: { sha256: archiveSha, bytes: bytes.length }, hash: 'synthetic-good-openings', codeVersion: 7 }, null, 2)}\n`,
    'utf8',
  );
  const specPath = join(dir, 'good-openings-spec.json');
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  return { runDir, specPath };
}

function copyRun9(dir: string, name: string): string {
  const runDir = join(dir, name);
  mkdirSync(join(runDir, 'delivery'), { recursive: true });
  for (const relative of ['delivery/building.pgar', 'delivery/delivery.json', 'events.jsonl']) {
    writeFileSync(join(runDir, relative), readFileSync(join(RUN9, relative)));
  }
  return runDir;
}

interface EventLine {
  type: string;
  body: Record<string, unknown>;
}

function rewriteEvents(runDir: string, transform: (event: EventLine) => EventLine | null): void {
  const path = join(runDir, 'events.jsonl');
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const out: string[] = [];
  for (const line of lines) {
    const event = JSON.parse(line) as EventLine;
    const next = transform(event);
    if (next !== null) out.push(JSON.stringify(next));
  }
  writeFileSync(path, `${out.join('\n')}\n`, 'utf8');
}

test('run-9 纯函数：stepped / 45° / 脊线 10，四类屋面检查全部 hard fail', () => {
  const evaluation = evaluateRoof(run9Spec(), run9Grid());
  const checks = new Map(evaluation.checks.map((check) => [check.id, check]));
  assert.equal(checks.get('roof.form')?.status, 'fail');
  assert.equal(checks.get('roof.form')?.actual, 'stepped');
  assert.equal(checks.get('roof.pitch')?.actual, 45);
  assert.equal(checks.get('roof.eave')?.actual, 6);
  assert.equal(checks.get('roof.ridge')?.actual, 10);
  assert.equal(evaluation.actual.lowestRoofY, 5);
  assert.equal(evaluation.actual.ridgeWidth, 2);
  for (const check of evaluation.checks) {
    assert.equal(check.severity, 'hard');
    assert.ok(check.evidence.length > 0 && check.evidence.length <= 5);
    for (const evidence of check.evidence) assert.ok(evidence.line > 0, `${check.id} 缺少 call.line`);
  }
});

test('run-9 纯函数洞口：窗遮挡 / 窗位移 / 门高 / 门槛 hard fail，门宽 / 净空 pass', () => {
  const evaluation = evaluateOpenings(run9Spec(), run9Grid());
  const checks = new Map(evaluation.checks.map((check) => [check.id, check]));
  const occlusion = checks.get('opening.window.occlusion.op-south-window');
  assert.ok(occlusion);
  assert.equal(occlusion.status, 'fail');
  assert.match(occlusion.detail, /smooth_stone_slab/);
  assert.ok(
    occlusion.evidence.some(
      (cell) => cell.x === 5 && cell.y === 4 && cell.z === 10 && cell.block === 'smooth_stone_slab',
    ),
  );
  const geometry = checks.get('opening.window.geometry.op-south-window');
  assert.ok(geometry);
  assert.equal(geometry.status, 'fail');
  assert.equal((geometry.actual as { readonly offsetY: number }).offsetY, 1);
  assert.equal(checks.get('door.width.op-entry-north')?.status, 'pass');
  const height = checks.get('door.height.op-entry-north');
  assert.ok(height);
  assert.equal(height.status, 'fail');
  assert.equal((height.actual as { readonly height: number }).height, 3);
  const threshold = checks.get('door.threshold.op-entry-north');
  assert.ok(threshold);
  assert.equal(threshold.status, 'fail');
  const thresholdActual = threshold.actual as {
    readonly thresholdY: number;
    readonly indoorY: number;
    readonly outdoorY: number;
    readonly indoorStep: number;
    readonly outdoorStep: number;
  };
  assert.equal(thresholdActual.thresholdY, 1);
  assert.equal(thresholdActual.indoorY, 1);
  assert.equal(thresholdActual.outdoorY, 0);
  assert.equal(thresholdActual.indoorStep, 0);
  assert.equal(thresholdActual.outdoorStep, 1);
  assert.ok(threshold.evidence.some((cell) => cell.y === 0 && cell.block === 'gravel'));
  assert.equal(checks.get('door.clearance.op-entry-north')?.status, 'pass');
  for (const check of evaluation.checks) {
    assert.equal(check.severity, 'hard');
    assert.ok(check.evidence.length > 0, `${check.id} 应有 evidence`);
  }
});

test('run-9 CLI：exit 1，报告含 stepped / 45 / ridge10 与完整 provenance', () => {
  const captured = capture();
  const code = runDesignConformance(['--session-dir', SESSION, '--run', RUN9, '--json'], { io: captured.io });
  assert.equal(code, 1);
  assert.equal(captured.err.length, 0);
  const report = reportFrom(captured);
  assert.equal(report.ok, false);
  assert.equal(report.checks.length, 11);
  const roofChecks = report.checks.filter((check) => check.id.startsWith('roof.'));
  assert.equal(roofChecks.length, 4);
  assert.ok(roofChecks.every((check) => check.status === 'fail'));
  const provenance = byId(report, 'provenance.integrity');
  assert.equal(provenance.status, 'pass');
  assert.equal(provenance.severity, 'hard');
  assert.equal(byId(report, 'roof.form').actual, 'stepped');
  assert.equal(byId(report, 'roof.pitch').actual, 45);
  assert.equal(byId(report, 'roof.eave').actual, 6);
  assert.equal(byId(report, 'roof.ridge').actual, 10);
  assert.equal(report.actual.cells, 835);
  assert.equal(report.actual.codeVersion, 25);
  assert.equal(report.actual.openings.length, 2);
  assert.equal(report.provenance.codeVersion, 25);
  assert.equal(report.provenance.deliveryHash, '2dc98c594057881307ed6c82ecf423b4');
  assert.equal(
    report.provenance.deliveryArchiveSha256,
    '80d71115bf65ce5e991d2a65082798ba5f29039e0e74f1c66ed04c34df1954d3',
  );
  assert.equal(report.provenance.archive.sha256, '80d71115bf65ce5e991d2a65082798ba5f29039e0e74f1c66ed04c34df1954d3');
  assert.ok(report.provenance.specPath.endsWith('build-spec.json'));
  assert.ok(report.provenance.runDir.endsWith('20261020-112925-build-task-c9736e'));
  assert.equal(report.provenance.events.deliveryLine, 634);
  assert.equal(report.provenance.events.lastCheckResultLine, 608);
  assert.equal(report.provenance.events.archiveCheckResultLine, 608);
  assert.equal(report.provenance.integrity.mode, 'run');
  assert.equal(report.provenance.integrity.required, true);
  assert.equal(report.provenance.integrity.taskMatches, true);
  assert.equal(report.provenance.integrity.deliveryArchiveMatches, true);
  assert.equal(report.provenance.integrity.deliveryEventArchiveMatches, true);
  assert.equal(report.provenance.integrity.lastCheckArchiveMatches, true);
  assert.equal(report.provenance.integrity.codeVersionMatchesCheck, true);
  assert.deepEqual(report.provenance.integrity.issues, []);
  assert.equal(report.blocking, true);
  assert.equal(report.fullyVerified, false);
  assert.deepEqual(report.summary, {
    pass: 3,
    fail: 8,
    unverified: 0,
    hardFailures: 8,
    hardUnverified: 0,
    blockingFailures: 8,
    blockingUnverified: 0,
  });

  const occlusion = byId(report, 'opening.window.occlusion.op-south-window');
  assert.equal(occlusion.status, 'fail');
  assert.match(occlusion.detail, /smooth_stone_slab/);
  assert.ok(
    occlusion.evidence.some(
      (cell) => cell.x === 5 && cell.y === 4 && cell.z === 10 && cell.block === 'smooth_stone_slab',
    ),
    '窗遮挡 evidence 应包含 y=4 石腰线坐标',
  );
  const geometry = byId(report, 'opening.window.geometry.op-south-window');
  assert.equal(geometry.status, 'fail');
  assert.match(geometry.detail, /\+1y/);
  assert.equal((geometry.actual as { readonly offsetY: number }).offsetY, 1);
  const threshold = byId(report, 'door.threshold.op-entry-north');
  assert.equal(threshold.status, 'fail');
  const thresholdActual = threshold.actual as {
    readonly thresholdY: number;
    readonly indoorY: number;
    readonly outdoorY: number;
    readonly indoorStep: number;
    readonly outdoorStep: number;
  };
  assert.equal(thresholdActual.thresholdY, 1);
  assert.equal(thresholdActual.indoorY, 1);
  assert.equal(thresholdActual.outdoorY, 0);
  assert.equal(thresholdActual.indoorStep, 0);
  assert.equal(thresholdActual.outdoorStep, 1);
  assert.ok(
    threshold.evidence.some((cell) => cell.y === 0 && cell.block === 'gravel'),
    '门槛 evidence 应包含室外 y=0',
  );
  const height = byId(report, 'door.height.op-entry-north');
  assert.equal(height.status, 'fail');
  assert.equal((height.actual as { readonly height: number }).height, 3);
  assert.equal(byId(report, 'door.width.op-entry-north').status, 'pass');
  assert.equal(byId(report, 'door.clearance.op-entry-north').status, 'pass');
});

test('合成 25° 单脊 gable：--spec 无 run provenance 也全部 pass，exit 0', () => {
  withTempDir((dir) => {
    const spec = syntheticSpec({ form: 'gable', pitchDegrees: 25, eaveHeight: 5, ridgeHeight: 7 });
    const { runDir, specPath } = writeSyntheticRun(dir, 'run-gable', spec, [5, 5, 6, 6, 7, 6, 6, 5, 5, 5]);
    const outPath = join(dir, 'report.json');
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json', '--out', outPath], {
      io: captured.io,
    });
    assert.equal(code, 0);
    assert.equal(captured.err.length, 0);
    assert.ok(existsSync(outPath));
    const report = reportFrom(captured);
    assert.equal(report.ok, true);
    assert.equal(report.blocking, false);
    assert.equal(report.fullyVerified, false, 'soft openings.present 不代表全部已验证');
    assert.deepEqual(report.summary, {
      pass: 4,
      fail: 0,
      unverified: 1,
      hardFailures: 0,
      hardUnverified: 0,
      blockingFailures: 0,
      blockingUnverified: 0,
    });
    const present = byId(report, 'openings.present');
    assert.equal(present.status, 'unverified');
    assert.equal(present.severity, 'soft');
    assert.equal(byId(report, 'roof.form').actual, 'gable');
    assert.equal(byId(report, 'roof.pitch').actual, 24.2);
    assert.equal(byId(report, 'roof.eave').actual, 5);
    assert.equal(byId(report, 'roof.ridge').actual, 7);
    assert.equal(report.actual.roof.form, 'gable');
    assert.equal(report.actual.roof.ridgeHeight, 7);
    assert.equal(report.actual.roof.lowestRoofY, 5);
    assert.equal(report.provenance.codeVersion, 7);
    assert.equal(report.provenance.integrity.mode, 'synthetic');
    assert.equal(report.provenance.integrity.required, false);
    assert.ok(
      report.checks.filter((check) => check.id !== 'openings.present').every((check) => check.id.startsWith('roof.')),
    );
    assert.deepEqual(JSON.parse(readFileSync(outPath, 'utf8')) as unknown, report);
  });
});

test('合成 12×10 flat：pitch 记为 0，form/pitch/eave/ridge 全 pass，exit 0', () => {
  withTempDir((dir) => {
    const spec = syntheticSpec({ form: 'flat', pitchDegrees: 0, eaveHeight: 5, ridgeHeight: 5 });
    const heights = Array.from({ length: 10 }, () => 5);
    const { runDir, specPath } = writeSyntheticRun(dir, 'run-flat', spec, heights);
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 0);
    assert.equal(captured.err.length, 0);
    const report = reportFrom(captured);
    assert.equal(report.ok, true);
    assert.equal(report.blocking, false);
    assert.deepEqual(report.summary, {
      pass: 4,
      fail: 0,
      unverified: 1,
      hardFailures: 0,
      hardUnverified: 0,
      blockingFailures: 0,
      blockingUnverified: 0,
    });
    for (const id of ['roof.form', 'roof.pitch', 'roof.eave', 'roof.ridge']) {
      const check = byId(report, id);
      assert.equal(check.status, 'pass', `${id}: ${check.detail}`);
    }
    assert.equal(report.actual.roof.form, 'flat');
    assert.equal(report.actual.roof.pitchDegrees, 0);
    assert.equal(byId(report, 'roof.pitch').actual, 0);
    assert.equal(report.actual.roof.eaveHeight, 5);
    assert.equal(report.actual.roof.ridgeHeight, 5);
  });
});

test('合成干净门窗：窗无遮挡 / 窗几何正确 / 门槛 0 / 门宽高符合，0 hard fail', () => {
  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir);
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 0);
    assert.equal(captured.err.length, 0);
    const report = reportFrom(captured);
    assert.equal(report.ok, true);
    assert.equal(report.blocking, false);
    assert.equal(report.fullyVerified, true);
    assert.deepEqual(report.summary, {
      pass: 10,
      fail: 0,
      unverified: 0,
      hardFailures: 0,
      hardUnverified: 0,
      blockingFailures: 0,
      blockingUnverified: 0,
    });
    for (const id of [
      'roof.form',
      'roof.pitch',
      'roof.eave',
      'roof.ridge',
      'opening.window.occlusion.op-south-window',
      'opening.window.geometry.op-south-window',
      'door.width.op-entry-north',
      'door.height.op-entry-north',
      'door.threshold.op-entry-north',
      'door.clearance.op-entry-north',
    ]) {
      assert.equal(byId(report, id).status, 'pass', `${id}: ${byId(report, id).detail}`);
    }
    const threshold = byId(report, 'door.threshold.op-entry-north');
    assert.equal((threshold.actual as { readonly thresholdY: number }).thresholdY, 1);
    assert.equal((threshold.actual as { readonly indoorY: number }).indoorY, 1);
    assert.equal((threshold.actual as { readonly outdoorY: number }).outdoorY, 1);
    const geometry = byId(report, 'opening.window.geometry.op-south-window');
    assert.equal((geometry.actual as { readonly offsetY: number }).offsetY, 0);
    assert.equal(report.actual.openings.length, 2);
  });
});

test('两扇直接相邻的完整窗：各自 summary 不被邻居撑宽，全部 pass，exit 0', () => {
  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir, { adjacentWindow: true });
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 0, captured.err.join('\n'));
    const report = reportFrom(captured);
    assert.equal(report.ok, true);
    assert.equal(report.blocking, false);
    assert.equal(report.fullyVerified, true);
    assert.deepEqual(report.summary, {
      pass: 12,
      fail: 0,
      unverified: 0,
      hardFailures: 0,
      hardUnverified: 0,
      blockingFailures: 0,
      blockingUnverified: 0,
    });
    const a = byId(report, 'opening.window.geometry.op-south-window');
    const b = byId(report, 'opening.window.geometry.op-south-window-b');
    assert.equal(a.status, 'pass', a.detail);
    assert.equal(b.status, 'pass', b.detail);
    assert.equal((a.actual as { readonly width: number }).width, 4);
    assert.equal((a.actual as { readonly height: number }).height, 2);
    assert.equal((a.actual as { readonly cells: number }).cells, 8);
    assert.equal((b.actual as { readonly width: number }).width, 2);
    assert.equal((b.actual as { readonly height: number }).height, 2);
    assert.equal((b.actual as { readonly cells: number }).cells, 4);
    for (const id of ['opening.window.occlusion.op-south-window', 'opening.window.occlusion.op-south-window-b']) {
      assert.equal(byId(report, id).status, 'pass', byId(report, id).detail);
    }
  });
});

test('门洞单侧门楣缺一格：door.height hard fail；两侧一致才 pass', () => {
  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir);
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 0, captured.err.join('\n'));
    const height = byId(reportFrom(captured), 'door.height.op-entry-north');
    assert.equal(height.status, 'pass');
    assert.equal((height.actual as { readonly headAligned: boolean }).headAligned, true);
  });

  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir, { doorLintelMissingAt: 3 });
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 1);
    const report = reportFrom(captured);
    assert.equal(report.ok, false);
    assert.equal(report.blocking, true);
    const height = byId(report, 'door.height.op-entry-north');
    assert.equal(height.status, 'fail');
    assert.equal(height.severity, 'hard');
    const actual = height.actual as {
      readonly height: number;
      readonly top: number;
      readonly headAligned: boolean;
      readonly columnTops: readonly { readonly h: number; readonly top: number }[];
    };
    assert.equal(actual.height, 3);
    assert.equal(actual.top, 4);
    assert.equal(actual.headAligned, false);
    assert.deepEqual(actual.columnTops, [
      { h: 3, top: 4 },
      { h: 4, top: 3 },
    ]);
    assert.match(height.detail, /各列洞顶不一致/);
    assert.equal(byId(report, 'door.width.op-entry-north').status, 'pass');
  });
});

test('玻璃板 glass_pane / 染色玻璃 / 玻璃板族：仍算玻璃，不判遮挡或几何 unverified', () => {
  for (const glassBlock of ['glass_pane', 'tinted_glass', 'white_stained_glass_pane']) {
    withTempDir((dir) => {
      const { runDir, specPath } = writeGoodOpeningRun(dir, { glassBlock });
      const captured = capture();
      const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
      assert.equal(code, 0, `${glassBlock}: ${captured.err.join('\n')}`);
      const report = reportFrom(captured);
      assert.equal(report.ok, true, glassBlock);
      assert.equal(report.summary.hardFailures, 0, glassBlock);
      assert.equal(report.summary.hardUnverified, 0, glassBlock);
      const occlusion = byId(report, 'opening.window.occlusion.op-south-window');
      assert.equal(occlusion.status, 'pass', `${glassBlock}: ${occlusion.detail}`);
      const geometry = byId(report, 'opening.window.geometry.op-south-window');
      assert.equal(geometry.status, 'pass', `${glassBlock}: ${geometry.detail}`);
      assert.equal((geometry.actual as { readonly cells: number }).cells, 8, glassBlock);
    });
  }
});

test('地毯铺门槛 / 门内净空 / 窗外壳：软装不算遮挡，0 hard fail', () => {
  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir, { carpet: true });
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 0, captured.err.join('\n'));
    const report = reportFrom(captured);
    assert.equal(report.ok, true);
    assert.equal(report.summary.hardFailures, 0);
    assert.equal(byId(report, 'door.threshold.op-entry-north').status, 'pass');
    assert.equal(byId(report, 'door.clearance.op-entry-north').status, 'pass');
    assert.equal(byId(report, 'opening.window.occlusion.op-south-window').status, 'pass');
    assert.equal(byId(report, 'opening.window.geometry.op-south-window').status, 'pass');
  });
});

test('窗少一块玻璃：逐格覆盖报 hard fail，不能靠横向不同坐标数蒙混', () => {
  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir, { omitGlass: [{ x: 6, y: 2 }] });
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 1);
    const report = reportFrom(captured);
    assert.equal(report.ok, false);
    assert.equal(report.blocking, true);
    assert.equal(report.fullyVerified, false);
    assert.equal(report.summary.hardFailures, 1);
    assert.equal(report.summary.blockingFailures, 1);
    const geometry = byId(report, 'opening.window.geometry.op-south-window');
    assert.equal(geometry.status, 'fail');
    assert.equal(geometry.severity, 'hard');
    assert.match(geometry.detail, /缺 1 格玻璃/);
    assert.equal((geometry.actual as { readonly missingCells: number }).missingCells, 1);
    assert.equal(byId(report, 'opening.window.occlusion.op-south-window').status, 'pass');
  });
});

test('窗玻璃整体水平偏移 1 格：几何 hard fail', () => {
  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir, { glassOffsetX: 1 });
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 1);
    const report = reportFrom(captured);
    assert.equal(report.ok, false);
    const geometry = byId(report, 'opening.window.geometry.op-south-window');
    assert.equal(geometry.status, 'fail');
    const actual = geometry.actual as {
      readonly horizontalMin: number;
      readonly horizontalMax: number;
      readonly horizontalOffset: number;
      readonly missingCells: number;
    };
    assert.equal(actual.horizontalMin, 6);
    assert.equal(actual.horizontalMax, 9);
    assert.equal(actual.horizontalOffset, 1);
    assert.equal(actual.missingCells, 2);
    assert.match(geometry.detail, /水平位移 \+1x/);
  });
});

test('门洞整体水平偏移 1 格：door.width hard fail', () => {
  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir, { doorOffsetX: 1 });
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 1);
    const report = reportFrom(captured);
    assert.equal(report.ok, false);
    const width = byId(report, 'door.width.op-entry-north');
    assert.equal(width.status, 'fail');
    assert.deepEqual((width.expected as { readonly horizontal: unknown }).horizontal, { first: 3, last: 4 });
    assert.deepEqual((width.actual as { readonly horizontal: unknown }).horizontal, { first: 4, last: 5 });
    assert.match(width.detail, /水平位移 \+1x/);
    assert.equal(byId(report, 'door.height.op-entry-north').status, 'pass');
    assert.equal(byId(report, 'door.threshold.op-entry-north').status, 'pass');
    assert.equal(byId(report, 'door.clearance.op-entry-north').status, 'pass');
  });
});

test('门槛 hard 只在 musts 明确要求无台阶时生效，否则 soft advisory 不阻断', () => {
  const musts = run9Spec().musts.filter((must) => !isFlushMustText(must.text));

  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir, { outdoorStep: true });
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 1);
    const threshold = byId(reportFrom(captured), 'door.threshold.op-entry-north');
    assert.equal(threshold.status, 'fail');
    assert.equal(threshold.severity, 'hard');
  });

  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir, { outdoorStep: true, musts });
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 0, captured.err.join('\n'));
    const report = reportFrom(captured);
    assert.equal(report.ok, true);
    assert.equal(report.blocking, false);
    assert.equal(report.fullyVerified, false, 'soft fail 不阻断但也不等于全部通过');
    const threshold = byId(report, 'door.threshold.op-entry-north');
    assert.equal(threshold.status, 'fail');
    assert.equal(threshold.severity, 'soft');
    assert.match(threshold.detail, /advisory/);
    assert.equal(report.summary.hardFailures, 0);
    assert.equal(report.summary.blockingFailures, 0);
  });
});

test('共享 flush matcher：bare 齐平 / 无高差 / 长句 都触发 hard threshold', () => {
  for (const text of ['齐平', '无高差', '入口与村道齐平']) {
    withTempDir((dir) => {
      const musts: BuildSpec['musts'] = [{ id: 'must-custom-flush', text, source: 'detail' }];
      const { runDir, specPath } = writeGoodOpeningRun(dir, { outdoorStep: true, musts });
      const captured = capture();
      const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
      assert.equal(code, 1, `${text}: expected blocking`);
      const threshold = byId(reportFrom(captured), 'door.threshold.op-entry-north');
      assert.equal(threshold.status, 'fail', text);
      assert.equal(threshold.severity, 'hard', text);
    });
  }
});

test('门内净空 hard 只在 musts 明确要求 door-clear / 净空时生效，否则 soft advisory 不阻断', () => {
  const clear = /door[-_ ]?clear|clearance|门内.{0,16}(?:1\s*(?:m|米)|一米)|(?:1\s*(?:m|米)|一米).{0,16}净空|净空/i;
  const musts = run9Spec().musts.filter((must) => !clear.test(`${must.id} ${must.text}`));

  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir, { clearanceBlocker: true });
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 1);
    const clearance = byId(reportFrom(captured), 'door.clearance.op-entry-north');
    assert.equal(clearance.status, 'fail');
    assert.equal(clearance.severity, 'hard');
  });

  withTempDir((dir) => {
    const { runDir, specPath } = writeGoodOpeningRun(dir, { clearanceBlocker: true, musts });
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 0, captured.err.join('\n'));
    const report = reportFrom(captured);
    assert.equal(report.ok, true);
    const clearance = byId(report, 'door.clearance.op-entry-north');
    assert.equal(clearance.status, 'fail');
    assert.equal(clearance.severity, 'soft');
    assert.match(clearance.detail, /advisory/);
    assert.equal(report.summary.hardFailures, 0);
  });
});

test('hip 显式 unsupported：四项均 soft unverified，不产生 blocking', () => {
  const base = run9Spec();
  const spec = BuildSpec.parse({ ...base, roof: { ...base.roof, form: 'hip' } });
  const evaluation = evaluateRoof(spec, run9Grid());
  assert.equal(evaluation.checks.length, 4);
  assert.equal(evaluation.actual.form, null);
  for (const check of evaluation.checks) {
    assert.equal(check.status, 'unverified', check.detail);
    assert.equal(check.severity, 'soft');
    assert.match(check.detail, /hip.*不支持/);
  }
});

test('hard unverified 计入 blocking：未知楼层 → exit 1，soft unverified 才不阻断', () => {
  withTempDir((dir) => {
    const base = run9Spec();
    const spec = BuildSpec.parse({
      ...base,
      roof: { ...base.roof, form: 'flat', pitchDegrees: 0, eaveHeight: 5, ridgeHeight: 5 },
      openings: base.openings.map((opening) => ({ ...opening, level: 'missing-level' })),
    });
    const { runDir, specPath } = writeSyntheticRun(
      dir,
      'run-hard-unverified',
      spec,
      Array.from({ length: 10 }, () => 5),
    );
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 1);
    const report = reportFrom(captured);
    assert.equal(report.ok, false);
    assert.equal(report.blocking, true);
    assert.equal(report.fullyVerified, false);
    assert.equal(report.summary.blockingFailures, 0);
    assert.equal(report.summary.blockingUnverified, 6);
    assert.equal(report.summary.hardFailures, 0);
    assert.equal(report.summary.hardUnverified, 6);
  });
});

test('hip / 多段 / butterfly / curved 只报 soft advisory，CLI 不阻断', () => {
  withTempDir((dir) => {
    const base = run9Spec();
    const spec = BuildSpec.parse({
      ...base,
      openings: [],
      roof: { ...base.roof, form: 'hip' },
    });
    const { runDir, specPath } = writeSyntheticRun(
      dir,
      'run-unsupported-roof',
      spec,
      Array.from({ length: 10 }, () => 5),
    );
    const captured = capture();
    const code = runDesignConformance(['--spec', specPath, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 0, captured.err.join('\n'));
    const report = reportFrom(captured);
    assert.equal(report.ok, true);
    assert.equal(report.blocking, false);
    assert.equal(report.fullyVerified, false, 'soft unverified 时 ok=true 不代表全部已验证');
    assert.equal(report.summary.hardFailures, 0);
    assert.equal(report.summary.hardUnverified, 0);
    assert.equal(report.summary.blockingFailures, 0);
    assert.equal(report.summary.blockingUnverified, 0);
    assert.ok(
      report.checks.filter((check) => check.id.startsWith('roof.')).every((check) => check.severity === 'soft'),
    );
  });

  const base = run9Spec();
  const variants = [
    { ...base.roof, form: 'butterfly' as const },
    { ...base.roof, form: 'curved' as const },
    {
      ...base.roof,
      segments: [
        {
          id: 'seg-a',
          form: 'gable' as const,
          material: base.roof.material,
          pitchDegrees: base.roof.pitchDegrees,
          eaveHeight: base.roof.eaveHeight,
          ridgeHeight: base.roof.ridgeHeight,
          overhang: base.roof.overhang,
          bounds: base.bounds,
        },
        {
          id: 'seg-b',
          form: 'shed' as const,
          material: base.roof.material,
          pitchDegrees: base.roof.pitchDegrees,
          eaveHeight: base.roof.eaveHeight,
          ridgeHeight: base.roof.ridgeHeight,
          overhang: base.roof.overhang,
          bounds: base.bounds,
        },
      ],
    },
  ];
  for (const roof of variants) {
    const evaluation = evaluateRoof(BuildSpec.parse({ ...base, roof }), run9Grid());
    assert.ok(evaluation.checks.every((check) => check.status === 'unverified' && check.severity === 'soft'));
  }
});

test('run provenance fail closed：缺 delivery.json → exit 1，provenance.integrity hard fail', () => {
  withTempDir((dir) => {
    const runDir = copyRun9(dir, 'missing-delivery');
    rmSync(join(runDir, 'delivery', 'delivery.json'));
    const captured = capture();
    const code = runDesignConformance(['--session-dir', SESSION, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 1);
    assert.equal(captured.err.length, 0);
    const report = reportFrom(captured);
    assert.equal(report.ok, false);
    const integrity = byId(report, 'provenance.integrity');
    assert.equal(integrity.status, 'fail');
    assert.equal(integrity.severity, 'hard');
    assert.match(integrity.detail, /缺 delivery\/delivery\.json/);
    assert.equal(report.provenance.integrity.deliveryManifestPresent, false);
  });
});

test('run provenance fail closed：delivery.json archive sha 不一致 → exit 1', () => {
  withTempDir((dir) => {
    const runDir = copyRun9(dir, 'bad-archive-sha');
    const deliveryPath = join(runDir, 'delivery', 'delivery.json');
    const delivery = JSON.parse(readFileSync(deliveryPath, 'utf8')) as {
      archive: { sha256: string; bytes: number };
    };
    delivery.archive.sha256 = 'f'.repeat(64);
    writeFileSync(deliveryPath, `${JSON.stringify(delivery, null, 2)}\n`, 'utf8');
    const captured = capture();
    const code = runDesignConformance(['--session-dir', SESSION, '--run', runDir, '--json'], { io: captured.io });
    assert.equal(code, 1);
    const report = reportFrom(captured);
    assert.equal(report.ok, false);
    assert.equal(byId(report, 'provenance.integrity').status, 'fail');
    assert.match(byId(report, 'provenance.integrity').detail, /archive sha 与存档不一致/);
    assert.equal(report.provenance.integrity.deliveryArchiveMatches, false);
    assert.equal(report.provenance.integrity.deliveryEventArchiveMatches, true);
  });
});

test('run provenance fail closed：build-task.md sha 与 run.start.task.sha256 不一致 → exit 1', () => {
  withTempDir((dir) => {
    const sessionDir = join(dir, 'session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'build-spec.json'), readFileSync(join(SESSION, 'build-spec.json')));
    const task = readFileSync(join(SESSION, 'build-task.md'), 'utf8');
    writeFileSync(join(sessionDir, 'build-task.md'), `${task}\n`, 'utf8');
    const runDir = copyRun9(dir, 'bad-task-sha');
    const captured = capture();
    const code = runDesignConformance(['--session-dir', sessionDir, '--run', runDir, '--json'], {
      io: captured.io,
    });
    assert.equal(code, 1);
    const report = reportFrom(captured);
    assert.equal(report.ok, false);
    assert.equal(byId(report, 'provenance.integrity').status, 'fail');
    assert.match(byId(report, 'provenance.integrity').detail, /build-task\.md sha/);
    assert.equal(report.provenance.integrity.taskMatches, false);
  });
});

test('run provenance fail closed：缺 delivery 事件 / 缺最后 check.result.archive / codeVersion 不一致 → exit 1', () => {
  withTempDir((dir) => {
    const missingDeliveryEvent = copyRun9(dir, 'missing-delivery-event');
    rewriteEvents(missingDeliveryEvent, (event) => (event.type === 'delivery' ? null : event));
    const captured = capture();
    const code = runDesignConformance(['--session-dir', SESSION, '--run', missingDeliveryEvent, '--json'], {
      io: captured.io,
    });
    assert.equal(code, 1);
    const report = reportFrom(captured);
    assert.equal(byId(report, 'provenance.integrity').status, 'fail');
    assert.match(byId(report, 'provenance.integrity').detail, /缺 delivery 事件/);
  });

  withTempDir((dir) => {
    const missingCheckArchive = copyRun9(dir, 'missing-check-archive');
    rewriteEvents(missingCheckArchive, (event) => {
      if (event.type === 'check.result') Reflect.deleteProperty(event.body, 'archive');
      return event;
    });
    const captured = capture();
    const code = runDesignConformance(['--session-dir', SESSION, '--run', missingCheckArchive, '--json'], {
      io: captured.io,
    });
    assert.equal(code, 1);
    const report = reportFrom(captured);
    assert.equal(byId(report, 'provenance.integrity').status, 'fail');
    assert.match(byId(report, 'provenance.integrity').detail, /check\.result 缺 archive/);
    assert.equal(report.provenance.integrity.lastCheckArchiveMatches, null);
  });

  withTempDir((dir) => {
    const badCodeVersion = copyRun9(dir, 'bad-code-version');
    rewriteEvents(badCodeVersion, (event) => {
      if (event.type === 'delivery') event.body['codeVersion'] = 24;
      return event;
    });
    const captured = capture();
    const code = runDesignConformance(['--session-dir', SESSION, '--run', badCodeVersion, '--json'], {
      io: captured.io,
    });
    assert.equal(code, 1);
    const report = reportFrom(captured);
    assert.equal(byId(report, 'provenance.integrity').status, 'fail');
    assert.match(byId(report, 'provenance.integrity').detail, /codeVersion 不一致/);
    assert.equal(report.provenance.integrity.codeVersionMatchesCheck, false);
  });
});

test('洞口无法判定：空网格 / 未知楼层均为 hard unverified，不崩溃也不假 pass', () => {
  const emptyGrid = createGrid(loadRegistry().table);
  const empty = evaluateOpenings(run9Spec(), emptyGrid);
  assert.equal(empty.checks.length, 6);
  for (const check of empty.checks) {
    assert.equal(check.status, 'unverified', check.id);
    assert.equal(check.severity, 'hard');
  }

  const base = run9Spec();
  const badSpec = BuildSpec.parse({
    ...base,
    openings: base.openings.map((opening) => ({ ...opening, level: 'missing-level' })),
  });
  const bad = evaluateOpenings(badSpec, run9Grid());
  assert.equal(bad.checks.length, 6);
  for (const check of bad.checks) {
    assert.equal(check.status, 'unverified', check.id);
    assert.match(check.detail, /楼层 missing-level 不存在/);
  }

  const none = evaluateOpenings(BuildSpec.parse({ ...base, openings: [] }), run9Grid());
  assert.equal(none.checks.length, 1);
  const present = none.checks[0];
  assert.ok(present);
  assert.equal(present.id, 'openings.present');
  assert.equal(present.status, 'unverified');
  assert.equal(present.severity, 'soft');
});

test('参数错 / 缺文件：exit 2，错误可读', () => {
  const missingArgs = capture();
  assert.equal(runDesignConformance(['--run', RUN9], { io: missingArgs.io }), 2);
  assert.match(missingArgs.err.join('\n'), /缺少 --session-dir/);
  assert.match(missingArgs.err.join('\n'), /用法/);

  const unknown = capture();
  assert.equal(runDesignConformance(['--session-dir', SESSION, '--run', RUN9, '--wat'], { io: unknown.io }), 2);
  assert.match(unknown.err.join('\n'), /未知参数 --wat/);

  withTempDir((dir) => {
    const missingSession = capture();
    const absentSession = join(dir, 'absent-session');
    assert.equal(runDesignConformance(['--session-dir', absentSession, '--run', RUN9], { io: missingSession.io }), 2);
    assert.match(missingSession.err.join('\n'), /读不到 build-spec\.json/);

    const missingRun = capture();
    assert.equal(
      runDesignConformance(['--session-dir', SESSION, '--run', join(dir, 'absent-run')], { io: missingRun.io }),
      2,
    );
    assert.match(missingRun.err.join('\n'), /读不到交付存档/);

    const badSpecDir = join(dir, 'bad-spec-session');
    mkdirSync(badSpecDir, { recursive: true });
    writeFileSync(join(badSpecDir, 'build-spec.json'), '{ not json', 'utf8');
    const badSpec = capture();
    assert.equal(runDesignConformance(['--session-dir', badSpecDir, '--run', RUN9], { io: badSpec.io }), 2);
    assert.match(badSpec.err.join('\n'), /不是合法 JSON/);
  });
});

test('帮助文本列出 CLI 与退出码', () => {
  const captured = capture();
  assert.equal(runDesignConformance(['--help'], { io: captured.io }), 0);
  assert.ok(captured.out.join('\n').includes(DESIGN_CONFORMANCE_USAGE));
  assert.match(captured.out.join('\n'), /退出码/);
});
