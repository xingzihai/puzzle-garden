/**
 * 多房子 conformance 矩阵：4 类房子 × good / wrong / unsupported，共 12 个离线 case。
 *
 * 每个 fixture 在临时目录生成 BuildSpec + building.pgar，再用现有 design-conformance CLI 检查。
 * 分类：met；prototype-gap（good 误报 / unsupported 未按 4 条 roof soft 表达）；false-positive
 * （unsupported 被阻断）；false-negative（wrong 漏报 / unsupported 假通过）；unexpected
 * （fixture / harness / CLI 错误）。默认把 false-positive / false-negative / unexpected 当失败，
 * --strict 再把 prototype-gap 当失败。运行时只写系统临时目录，不依赖 .work。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeArchive } from '@pg/core/archive';

import { runDesignConformance } from './design-conformance.ts';
import type { ConformanceCheck, ConformanceReport } from './design-conformance.ts';
import { buildFixture } from './conformance-matrix-fixtures.ts';
import type { Fixture, HouseKey, MatrixVariant } from './conformance-matrix-fixtures.ts';

export type FailureFamily = 'roof' | 'opening' | 'door';
export type MatrixStatus = 'met' | 'prototype-gap' | 'false-positive' | 'false-negative' | 'unexpected';
export type VerificationExpectation = 'required' | 'forbidden';

export interface MatrixExpectation {
  readonly house: HouseKey;
  readonly houseLabel: string;
  readonly variant: MatrixVariant;
  readonly expectedFamily: FailureFamily | null;
  readonly fullyVerified: VerificationExpectation;
  readonly expected: string;
}

const HOUSES = ['H1', 'H2', 'H3', 'H4'] as const;
const VARIANTS = ['good', 'wrong', 'unsupported'] as const;

const HOUSE_LABELS: Readonly<Record<HouseKey, string>> = {
  H1: 'H1 6x5 flat',
  H2: 'H2 10x8 gable 25°',
  H3: 'H3 8x6 shed',
  H4: 'H4 L 形多体量',
};

const WRONG_FAMILY: Readonly<Record<HouseKey, FailureFamily>> = {
  H1: 'roof',
  H2: 'roof',
  H3: 'door',
  H4: 'opening',
};

function expectationFor(house: HouseKey, variant: MatrixVariant): MatrixExpectation {
  const expectedFamily = variant === 'wrong' ? WRONG_FAMILY[house] : variant === 'unsupported' ? 'roof' : null;
  const fullyVerified = variant === 'good' && house !== 'H4' ? 'required' : 'forbidden';
  const expected =
    variant === 'good'
      ? house === 'H4'
        ? 'good: blocking=false，0 hard fail；L 形允许多段屋面 roof.* soft unverified'
        : 'good: blocking=false，0 hard fail，fullyVerified=true'
      : variant === 'wrong'
        ? `wrong: blocking=true，至少一个 hard ${expectedFamily ?? ''} fail，带 expected/actual/evidence`
        : 'unsupported: 4 条 roof 检查全部 soft unverified，非 roof 检查全 pass，blocking=false，fullyVerified=false';
  return { house, houseLabel: HOUSE_LABELS[house], variant, expectedFamily, fullyVerified, expected };
}

/** 12 个 case 的固定顺序：H1 good/wrong/unsupported，H2 ...，H4 ...。 */
export const MATRIX_EXPECTATIONS: readonly MatrixExpectation[] = HOUSES.flatMap((house) =>
  VARIANTS.map((variant) => expectationFor(house, variant)),
);

export interface MatrixCaseActual {
  readonly blocking: boolean | null;
  readonly fullyVerified: boolean | null;
  readonly exitCode: number | null;
  readonly summary: ConformanceReport['summary'] | null;
  readonly failures: readonly ConformanceCheck[];
  readonly softUnverified: readonly ConformanceCheck[];
}

export interface MatrixCaseReport {
  readonly house: HouseKey;
  readonly houseLabel: string;
  readonly variant: MatrixVariant;
  readonly expected: string;
  readonly expectedFamily: FailureFamily | null;
  readonly actual: MatrixCaseActual;
  readonly status: MatrixStatus;
  readonly gapReason: string | null;
}

export interface MatrixReport {
  readonly schemaVersion: 1;
  readonly cases: readonly MatrixCaseReport[];
  readonly summary: {
    readonly total: number;
    readonly met: number;
    readonly prototypeGap: number;
    readonly falsePositive: number;
    readonly falseNegative: number;
    readonly unexpected: number;
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeFixtureRun(root: string, fixture: Fixture): { readonly runDir: string; readonly specPath: string } {
  const name = `${fixture.house}-${fixture.variant}`;
  const runDir = join(root, `run-${name}`);
  mkdirSync(join(runDir, 'delivery'), { recursive: true });
  const bytes = Buffer.from(writeArchive(fixture.grid, 9));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(runDir, 'delivery', 'building.pgar'), bytes);
  writeFileSync(
    join(runDir, 'delivery', 'delivery.json'),
    `${JSON.stringify(
      {
        archive: { sha256, bytes: bytes.length },
        hash: `matrix-${name}`,
        codeVersion: 7,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const specPath = join(root, `${name}-spec.json`);
  writeFileSync(specPath, `${JSON.stringify(fixture.spec, null, 2)}\n`, 'utf8');
  return { runDir, specPath };
}

function runFixture(paths: { readonly runDir: string; readonly specPath: string }): {
  readonly exitCode: number;
  readonly report: ConformanceReport;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = runDesignConformance(['--spec', paths.specPath, '--run', paths.runDir, '--json'], {
    io: {
      stdout: (line) => {
        stdout.push(line);
      },
      stderr: (line) => {
        stderr.push(line);
      },
    },
  });
  if (exitCode === 2) throw new Error(`design-conformance 读取 / 参数错误：${stderr.join('\n')}`);
  const text = stdout.join('\n').trim();
  if (text === '') throw new Error('design-conformance 没有输出报告');
  return { exitCode, report: JSON.parse(text) as ConformanceReport };
}

function actualOf(report: ConformanceReport, exitCode: number): MatrixCaseActual {
  return {
    blocking: report.blocking,
    fullyVerified: report.fullyVerified,
    exitCode,
    summary: report.summary,
    failures: report.checks.filter((check) => check.status === 'fail' && check.severity === 'hard'),
    softUnverified: report.checks.filter((check) => check.status === 'unverified' && check.severity === 'soft'),
  };
}

function checkFamily(id: string): FailureFamily | null {
  if (id.startsWith('roof.')) return 'roof';
  if (id.startsWith('opening.')) return 'opening';
  if (id.startsWith('door.')) return 'door';
  return null;
}

function metCase(expectation: MatrixExpectation, actual: MatrixCaseActual): MatrixCaseReport {
  return {
    house: expectation.house,
    houseLabel: expectation.houseLabel,
    variant: expectation.variant,
    expected: expectation.expected,
    expectedFamily: expectation.expectedFamily,
    actual,
    status: 'met',
    gapReason: null,
  };
}

function gapCase(expectation: MatrixExpectation, actual: MatrixCaseActual, reason: string): MatrixCaseReport {
  return {
    house: expectation.house,
    houseLabel: expectation.houseLabel,
    variant: expectation.variant,
    expected: expectation.expected,
    expectedFamily: expectation.expectedFamily,
    actual,
    status: 'prototype-gap',
    gapReason: reason,
  };
}

function falseNegativeCase(expectation: MatrixExpectation, actual: MatrixCaseActual, reason: string): MatrixCaseReport {
  return {
    house: expectation.house,
    houseLabel: expectation.houseLabel,
    variant: expectation.variant,
    expected: expectation.expected,
    expectedFamily: expectation.expectedFamily,
    actual,
    status: 'false-negative',
    gapReason: reason,
  };
}

function falsePositiveCase(expectation: MatrixExpectation, actual: MatrixCaseActual, reason: string): MatrixCaseReport {
  return {
    house: expectation.house,
    houseLabel: expectation.houseLabel,
    variant: expectation.variant,
    expected: expectation.expected,
    expectedFamily: expectation.expectedFamily,
    actual,
    status: 'false-positive',
    gapReason: reason,
  };
}

function unexpectedCase(expectation: MatrixExpectation, error: unknown): MatrixCaseReport {
  return {
    house: expectation.house,
    houseLabel: expectation.houseLabel,
    variant: expectation.variant,
    expected: expectation.expected,
    expectedFamily: expectation.expectedFamily,
    actual: {
      blocking: null,
      fullyVerified: null,
      exitCode: null,
      summary: null,
      failures: [],
      softUnverified: [],
    },
    status: 'unexpected',
    gapReason: errorText(error),
  };
}

function classifyGood(
  expectation: MatrixExpectation,
  report: ConformanceReport,
  actual: MatrixCaseActual,
): MatrixCaseReport {
  const problems: string[] = [];
  const hardUnverified = report.checks.filter((check) => check.status === 'unverified' && check.severity === 'hard');
  if (report.blocking) {
    const ids = [...actual.failures, ...hardUnverified].map((check) => check.id);
    problems.push(`blocking=true（${ids.join(', ') || '原因未知'}）`);
  }
  if (hardUnverified.length > 0)
    problems.push(`hard unverified：${hardUnverified.map((check) => check.id).join(', ')}`);
  if (expectation.fullyVerified === 'required' && !report.fullyVerified) {
    const ids = report.checks.filter((check) => check.status !== 'pass').map((check) => check.id);
    problems.push(`fullyVerified=false（非 pass：${ids.join(', ') || '未知'}）`);
  }
  if (expectation.fullyVerified === 'forbidden') {
    if (report.fullyVerified) problems.push('fullyVerified=true，但该形状应以 soft unverified 表示不支持');
    const roofChecks = report.checks.filter((check) => check.id.startsWith('roof.'));
    const softRoof = roofChecks.filter((check) => check.status === 'unverified' && check.severity === 'soft');
    const nonRoofProblems = report.checks.filter((check) => !check.id.startsWith('roof.') && check.status !== 'pass');
    if (roofChecks.length !== 4) problems.push(`roof 检查数量 ${String(roofChecks.length)} ≠ 4`);
    if (softRoof.length !== 4) {
      problems.push(`roof soft unverified ${String(softRoof.length)}/4，必须 4 条全部 soft unverified`);
    }
    if (nonRoofProblems.length > 0) {
      problems.push(`非 roof 检查未全 pass：${nonRoofProblems.map((check) => check.id).join(', ')}`);
    }
  }
  if (problems.length === 0) return metCase(expectation, actual);
  return gapCase(expectation, actual, `good 样本未满足语义：${problems.join('；')}`);
}

function classifyWrong(
  expectation: MatrixExpectation,
  report: ConformanceReport,
  actual: MatrixCaseActual,
): MatrixCaseReport {
  const family = expectation.expectedFamily;
  const familyFailures = actual.failures.filter((check) => family !== null && checkFamily(check.id) === family);
  if (!report.blocking) {
    return falseNegativeCase(
      expectation,
      actual,
      `wrong 样本没有被阻断（blocking=false），预期 hard ${family ?? '未知'} fail`,
    );
  }
  if (familyFailures.length === 0) {
    return falseNegativeCase(
      expectation,
      actual,
      `blocking=true，但没有 hard ${family ?? '未知'} fail；实际 hard fail：${
        actual.failures.map((check) => check.id).join(', ') || '无'
      }`,
    );
  }
  const evidenced = familyFailures.some(
    (check) => check.evidence.length > 0 && check.expected !== null && check.actual !== null,
  );
  if (!evidenced) {
    return falseNegativeCase(expectation, actual, 'hard fail 缺 expected / actual / evidence，无法确认捕获');
  }
  return metCase(expectation, actual);
}

function classifyUnsupported(
  expectation: MatrixExpectation,
  report: ConformanceReport,
  actual: MatrixCaseActual,
): MatrixCaseReport {
  const roofChecks = report.checks.filter((check) => check.id.startsWith('roof.'));
  const softRoof = roofChecks.filter((check) => check.status === 'unverified' && check.severity === 'soft');
  const nonRoofProblems = report.checks.filter((check) => !check.id.startsWith('roof.') && check.status !== 'pass');
  if (report.blocking) {
    const blockingProblems = report.checks.filter((check) => check.severity === 'hard' && check.status !== 'pass');
    return falsePositiveCase(
      expectation,
      actual,
      `unsupported 样本被判 blocking=true（false positive）：${blockingProblems.map((check) => check.id).join(', ') || '原因未知'}`,
    );
  }
  if (report.fullyVerified) {
    return falseNegativeCase(expectation, actual, 'unsupported 样本 fullyVerified=true，属于假通过');
  }
  if (nonRoofProblems.length > 0) {
    return gapCase(
      expectation,
      actual,
      `unsupported 样本出现非 roof 检查未全 pass：${nonRoofProblems.map((check) => `${check.id}=${check.status}`).join(', ')}`,
    );
  }
  if (roofChecks.length !== 4 || softRoof.length !== 4) {
    return gapCase(
      expectation,
      actual,
      `unsupported 样本必须 4 条 roof 检查全部 soft unverified（soft ${String(softRoof.length)}/${String(
        roofChecks.length,
      )}）`,
    );
  }
  return metCase(expectation, actual);
}

export function evaluateCase(
  expectation: MatrixExpectation,
  report: ConformanceReport,
  exitCode: number,
): MatrixCaseReport {
  const actual = actualOf(report, exitCode);
  if (expectation.variant === 'good') return classifyGood(expectation, report, actual);
  if (expectation.variant === 'wrong') return classifyWrong(expectation, report, actual);
  return classifyUnsupported(expectation, report, actual);
}

export function summarizeCases(cases: readonly MatrixCaseReport[]): MatrixReport['summary'] {
  return {
    total: cases.length,
    met: cases.filter((item) => item.status === 'met').length,
    prototypeGap: cases.filter((item) => item.status === 'prototype-gap').length,
    falsePositive: cases.filter((item) => item.status === 'false-positive').length,
    falseNegative: cases.filter((item) => item.status === 'false-negative').length,
    unexpected: cases.filter((item) => item.status === 'unexpected').length,
  };
}

export interface MatrixRunDeps {
  /** 测试注入点：默认使用真实 fixture builder；抛错会按 unexpected 计，而不是 prototype-gap。 */
  readonly buildFixture?: typeof buildFixture;
}

export function runConformanceMatrix(deps: MatrixRunDeps = {}): MatrixReport {
  const build = deps.buildFixture ?? buildFixture;
  const root = mkdtempSync(join(tmpdir(), 'pg-conformance-matrix-'));
  try {
    const cases = MATRIX_EXPECTATIONS.map((expectation) => {
      try {
        const fixture = build(expectation.house, expectation.variant);
        const paths = writeFixtureRun(root, fixture);
        const { exitCode, report } = runFixture(paths);
        return evaluateCase(expectation, report, exitCode);
      } catch (error) {
        return unexpectedCase(expectation, error);
      }
    });
    return { schemaVersion: 1, cases, summary: summarizeCases(cases) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function shortExpected(item: MatrixCaseReport): string {
  if (item.variant === 'good') return 'clean';
  if (item.variant === 'wrong') return `hard ${item.expectedFamily ?? '?'}`;
  return 'soft unverified';
}

function formatTable(report: MatrixReport): string {
  const headers = ['house', 'variant', 'expected', 'status', 'blocking', 'fullyVerified', 'fail/unverified'];
  const rows = report.cases.map((item) => [
    item.house,
    item.variant,
    shortExpected(item),
    item.status,
    item.actual.blocking === null ? '?' : String(item.actual.blocking),
    item.actual.fullyVerified === null ? '?' : String(item.actual.fullyVerified),
    `${String(item.actual.failures.length)}/${String(item.actual.softUnverified.length)}`,
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const line = (values: readonly string[]): string =>
    values.map((value, index) => value.padEnd(widths[index] ?? value.length)).join('  ');
  const lines = [line(headers), line(widths.map((width) => '-'.repeat(width)))];
  for (const row of rows) lines.push(line(row));
  lines.push(
    '',
    `summary: total=${String(report.summary.total)} met=${String(report.summary.met)} prototype-gap=${String(
      report.summary.prototypeGap,
    )} false-positive=${String(report.summary.falsePositive)} false-negative=${String(
      report.summary.falseNegative,
    )} unexpected=${String(report.summary.unexpected)}`,
  );
  const gaps = report.cases.filter((item) => item.status !== 'met');
  if (gaps.length > 0) {
    lines.push('', 'gaps:');
    for (const item of gaps) lines.push(`- ${item.house} ${item.variant} [${item.status}] ${item.gapReason ?? ''}`);
  }
  return lines.join('\n');
}

export const MATRIX_USAGE = `用法：node tools/conformance-matrix.ts [选项]
  --strict    prototype-gap 也返回退出码 1（默认只把 false-positive / false-negative / unexpected 当失败）
  --json      输出机器可读 JSON（默认输出人可读表格）
  --out <path> 把同一份 JSON 写入文件
  --help, -h  打印本说明

  12 个 case = H1/H2/H3/H4 × good/wrong/unsupported。fixture 在系统临时目录生成并清理，
  不读取 .work，不联网、不构建、不调用模型。默认退出码：0（全部 met 或 prototype-gap）；
  1（存在 false-positive / false-negative / unexpected，或 --strict 下存在 prototype-gap）；
  2（参数 / 读写错误）。`;

interface MatrixOptions {
  readonly strict: boolean;
  readonly json: boolean;
  readonly outPath: string | null;
  readonly help: boolean;
}

export function parseMatrixArgs(argv: readonly string[]): MatrixOptions {
  let strict = false;
  let json = false;
  let outPath: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--strict':
        strict = true;
        break;
      case '--json':
        json = true;
        break;
      case '--out': {
        const value = argv[i + 1];
        if (value === undefined || value === '' || value.startsWith('--')) {
          throw new Error(`--out 缺少取值。\n${MATRIX_USAGE}`);
        }
        outPath = value;
        i += 1;
        break;
      }
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`未知参数 ${arg}。\n${MATRIX_USAGE}`);
    }
  }
  return { strict, json, outPath, help };
}

export interface MatrixIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface MatrixDeps {
  readonly io?: MatrixIo;
}

export function exitCodeFor(report: MatrixReport, strict = false): 0 | 1 {
  if (
    report.summary.total === 0 ||
    report.summary.unexpected > 0 ||
    report.summary.falsePositive > 0 ||
    report.summary.falseNegative > 0
  ) {
    return 1;
  }
  if (strict && report.summary.prototypeGap > 0) return 1;
  return 0;
}

export function main(argv: readonly string[], deps: MatrixDeps = {}): number {
  const io: MatrixIo = deps.io ?? {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
  try {
    const options = parseMatrixArgs(argv);
    if (options.help) {
      io.stdout(MATRIX_USAGE);
      return 0;
    }
    const report = runConformanceMatrix();
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outPath !== null) writeFileSync(resolve(options.outPath), json, 'utf8');
    if (options.json) io.stdout(json.trimEnd());
    else io.stdout(formatTable(report));
    return exitCodeFor(report, options.strict);
  } catch (error) {
    io.stderr(`conformance-matrix: ${errorText(error)}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
