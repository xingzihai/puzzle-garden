/* eslint-disable max-lines -- clause 求值、度量绑定与 hard-fail 归因共享同一份度量口径；拆文件会让 fallback 漂移。 */
/**
 * Must Clause Evidence：把 compiler 产出的 clause 与实际几何 / 报告 / 覆盖证据逐条比较。
 *
 * 负责：只按 leaf.check 声明的检查取实际值，和 leaf.target.value 比较；hard fail 归因；
 * 输出稳定的 MustClauseEvaluation。
 * 不负责：waiver、评审文案、I/O；本文件不读文件、不写文件、不联网。
 */

import type { AsBuiltObjectGraph, OpeningObject, WallObject } from '@pg/analysis/as-built';
import type { DiffItem } from '@pg/analysis/object-diff';
import type { BlockRegistry } from '@pg/blocks/registry';
import type { Grid } from '@pg/core/grid';
import type { BuildSpec } from '@pg/interaction/schema';

import type {
  ClauseCheck,
  ClauseTarget,
  JsonValue,
  MustClauseEvaluation,
  MustClauseEvidence,
  MustClauseEvidenceRef,
  MustClauseGroupEvidence,
  MustClauseHardFailAttribution,
  MustClausePlan,
  MustClausePlanFile,
  MustClauseStatus,
} from '../packages/interaction/src/must-clause.ts';
import {
  MUST_CLAUSE_EVALUATION_SCHEMA_VERSION,
  MUST_CLAUSE_EVALUATION_TOOL,
  MustClauseEvaluation as MustClauseEvaluationSchema,
  aggregateMustClauseStatus,
} from '../packages/interaction/src/must-clause.ts';
import type { ConformanceDiffReport } from './conformance-diff.ts';
import type { CoverageCheckResult, CoverageEvidence } from './coverage-evidence.ts';
import { evaluateRoof } from './design-conformance.ts';
import { compileMustClauses, MUST_CLAUSE_COMPILER_VERSION } from './must-clause-compiler.ts';

type JsonRecord = Readonly<Record<string, unknown>>;
interface Bounds3 {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface MustClauseEvaluationInput {
  readonly spec: BuildSpec;
  readonly graph: AsBuiltObjectGraph;
  readonly grid: Grid;
  readonly registry: BlockRegistry;
  readonly report: ConformanceDiffReport;
  readonly coverage: CoverageEvidence;
  /** 默认 compileMustClauses(spec)。 */
  readonly plan?: MustClausePlanFile;
}

interface LeafResult {
  readonly plan: MustClausePlan;
  status: MustClauseStatus;
  readonly actual: JsonValue;
  readonly evidence: readonly MustClauseEvidenceRef[];
  readonly reason: string | null;
}

interface HardFail {
  readonly expectedId: string;
  readonly evidence: MustClauseEvidenceRef;
  readonly reason: string;
  /** 来源用于把“设计里有、must 没覆盖”的家具缺失升级为显式全局阻断，而不是未归因。 */
  readonly source: 'report' | 'furniture' | 'coverage';
}

const MAX_EVIDENCE = 50;
const MAX_REASON = 400;

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function tuple3(value: unknown): readonly [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const x = numberValue(value[0]);
  const y = numberValue(value[1]);
  const z = numberValue(value[2]);
  return x === null || y === null || z === null ? null : [x, y, z];
}

function boundsFrom(value: unknown): Bounds3 | null {
  const record = asRecord(value);
  if (record === null) return null;
  const min = tuple3(record['min']);
  const max = tuple3(record['max']);
  return min === null || max === null ? null : { min, max };
}

function unionBounds(bounds: readonly Bounds3[]): Bounds3 | null {
  if (bounds.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const item of bounds) {
    min[0] = Math.min(min[0], item.min[0]);
    min[1] = Math.min(min[1], item.min[1]);
    min[2] = Math.min(min[2], item.min[2]);
    max[0] = Math.max(max[0], item.max[0]);
    max[1] = Math.max(max[1], item.max[1]);
    max[2] = Math.max(max[2], item.max[2]);
  }
  return { min, max };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  const record = asRecord(value);
  if (record === null) return null;
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item !== undefined) out[key] = toJsonValue(item);
  }
  return out;
}

function evidenceRef(kind: MustClauseEvidenceRef['kind'], ref: string, summary: string): MustClauseEvidenceRef {
  return { kind, ref: clip(ref, 160), summary: clip(summary.length === 0 ? ref : summary, MAX_REASON) };
}

function checkRef(id: string, summary: string): MustClauseEvidenceRef {
  return evidenceRef('check', id.startsWith('check:') ? id : `check:${id}`, summary);
}

function diffRef(item: DiffItem, source: 'report' | 'coverage'): MustClauseEvidenceRef {
  return evidenceRef(
    'diff',
    `${source === 'report' ? 'conformance-diff.json' : 'coverage-evidence'}#${item.id}`,
    item.reason ?? `${item.status}/${item.severity}`,
  );
}

function paramsString(check: ClauseCheck, key: string): string | null {
  return stringValue(check.params[key]);
}

function paramsNumber(check: ClauseCheck, key: string): number | null {
  const value = check.params[key];
  if (typeof value === 'number') return numberValue(value);
  if (typeof value === 'string' && value.trim().length > 0) return numberValue(Number(value));
  return null;
}

function targetNumber(target: ClauseTarget | null): number | null {
  return target === null ? null : numberValue(target.value);
}

function targetString(target: ClauseTarget | null): string | null {
  return target === null ? null : stringValue(target.value);
}

function targetBoolean(target: ClauseTarget | null): boolean | null {
  return target === null ? null : booleanValue(target.value);
}

function targetNumberArray(target: ClauseTarget | null): readonly number[] | null {
  if (target === null || !Array.isArray(target.value)) return null;
  const values = target.value.map(numberValue);
  return values.some((value) => value === null) ? null : (values as number[]);
}

function matchesNumber(actual: number, target: number, tolerance: number): boolean {
  return Math.abs(actual - target) <= tolerance;
}

function firstLevel(spec: BuildSpec): BuildSpec['levels'][number] {
  const level = [...spec.levels].sort((a, b) => a.elevation - b.elevation)[0];
  if (level === undefined) throw new Error('BuildSpec.levels is empty');
  return level;
}

function numericMismatch(
  plan: MustClausePlan,
  metric: string,
  actual: number | null,
  target: number | null,
  tolerance = 0,
): LeafResult | null {
  if (target === null) {
    return unverified(plan, { metric, target: plan.target?.value ?? null }, [], 'target is not numeric');
  }
  if (actual === null) {
    return unverified(plan, { metric, target }, [], `${metric} cannot be measured`);
  }
  if (matchesNumber(actual, target, tolerance)) return null;
  return notMet(plan, { metric, actual, target }, [], `expected ${metric} ${String(target)}, actual ${String(actual)}`);
}

function met(
  plan: MustClausePlan,
  actual: JsonValue,
  evidence: readonly MustClauseEvidenceRef[],
  reason: string | null = null,
): LeafResult {
  return { plan, status: 'met', actual, evidence, reason };
}

function notMet(
  plan: MustClausePlan,
  actual: JsonValue,
  evidence: readonly MustClauseEvidenceRef[],
  reason: string,
): LeafResult {
  return { plan, status: 'not-met', actual, evidence, reason: clip(reason, MAX_REASON) };
}

function unverified(
  plan: MustClausePlan,
  actual: JsonValue,
  evidence: readonly MustClauseEvidenceRef[],
  reason: string,
): LeafResult {
  return { plan, status: 'unverified', actual, evidence, reason: clip(reason, MAX_REASON) };
}

function checkExpected(check: CoverageCheckResult, key: string): unknown {
  return asRecord(check.expected)?.[key];
}

function expectedDimension(check: CoverageCheckResult, field: string): number | null {
  const expected = asRecord(check.expected);
  if (expected === null) return null;
  const dims = asRecord(expected['dims']);
  const fromDims = dims === null ? null : numberValue(dims[field]);
  return fromDims ?? numberValue(expected[field]);
}

function bindCoveragePass(plan: MustClausePlan, check: CoverageCheckResult): LeafResult {
  const field = paramsString(plan.check, 'field');
  const target = targetNumber(plan.target);
  const tolerance = paramsNumber(plan.check, 'tolerance') ?? 0;
  const evidence = [checkRef(check.id, `coverage pass: ${check.id}`)];

  if (field === 'width' && check.id.startsWith('check:door-clear:')) {
    if (target === null) return unverified(plan, { check: check.id }, evidence, 'target is not numeric');
    // checkDoorClear 固定测量 1m 净空带；目标小于等于 1m 时 pass 足够，目标更大时不能假 met。
    if (target <= 1) {
      return met(plan, toJsonValue({ doorClear: target, coverage: check.actual }), evidence);
    }
    return notMet(
      plan,
      toJsonValue({ doorClear: target, coverage: check.actual }),
      evidence,
      `door-clear target ${String(target)}m exceeds the fixed 1m coverage band`,
    );
  }

  if (field === 'width' || field === 'depth' || field === 'area') {
    const actual = expectedDimension(check, field);
    const mismatch = numericMismatch(plan, field, actual, target, tolerance);
    if (mismatch !== null) {
      return mismatch.status === 'not-met'
        ? notMet(
            plan,
            { field, actual, target, source: 'coverage.expected' },
            evidence,
            `target/coverage drift: expected ${field} ${String(target)}, coverage expected ${String(actual)}`,
          )
        : mismatch;
    }
    return met(plan, toJsonValue({ field, actual, target }), evidence);
  }

  if (field === 'thickness') {
    const expected = asRecord(check.expected);
    const thickness = expected === null ? null : (asRecord(expected['thickness']) ?? expected);
    if (thickness === null || target === null) {
      return unverified(plan, { field, target: plan.target?.value ?? null }, evidence, 'thickness is unavailable');
    }
    const sides = ['north', 'east', 'south', 'west'] as const;
    const values = sides.map((side) => numberValue(thickness[side]));
    if (values.some((value) => value === null)) {
      return unverified(plan, { field, expected: toJsonValue(thickness) }, evidence, 'thickness is incomplete');
    }
    const valuesNumber = values as number[];
    if (valuesNumber.every((value) => matchesNumber(value, target, tolerance))) {
      return met(plan, toJsonValue({ field, actual: valuesNumber, target }), evidence);
    }
    return notMet(
      plan,
      toJsonValue({ field, actual: valuesNumber, target }),
      evidence,
      `expected thickness ${String(target)}, actual ${valuesNumber.join('/')}`,
    );
  }

  if (field === 'levels') {
    const actual = numberValue(checkExpected(check, 'levels'));
    const mismatch = numericMismatch(plan, 'levels', actual, target, tolerance);
    return mismatch ?? met(plan, toJsonValue({ field, actual, target }), evidence);
  }

  if (field === 'perBench') {
    const actualRecord = asRecord(check.actual);
    const perBench = actualRecord === null ? null : asRecord(actualRecord['perBench']);
    const targetValues = targetNumberArray(plan.target);
    if (perBench === null || targetValues === null) {
      return unverified(
        plan,
        { field, target: plan.target?.value ?? null },
        evidence,
        'per-bench seats are unavailable',
      );
    }
    const actualValues = Object.keys(perBench)
      .sort()
      .map((key) => numberValue(perBench[key]))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    const expectedValues = [...targetValues].sort((a, b) => a - b);
    if (actualValues.length !== expectedValues.length) {
      return notMet(
        plan,
        toJsonValue({ field, actual: actualValues, target: expectedValues }),
        evidence,
        `expected per-bench seats ${expectedValues.join('+')}, actual ${actualValues.join('+')}`,
      );
    }
    if (actualValues.every((value, index) => value === expectedValues[index])) {
      return met(plan, toJsonValue({ field, actual: actualValues, target: expectedValues }), evidence);
    }
    return notMet(
      plan,
      toJsonValue({ field, actual: actualValues, target: expectedValues }),
      evidence,
      `expected per-bench seats ${expectedValues.join('+')}, actual ${actualValues.join('+')}`,
    );
  }

  if (field === 'doorCount') {
    const actualRecord = asRecord(check.actual);
    const expectedRecord = asRecord(check.expected);
    const actualOpenings = actualRecord?.['openings'];
    const expectedOpenings = expectedRecord?.['openings'];
    const actualCount = Array.isArray(actualOpenings)
      ? actualOpenings.length
      : Array.isArray(expectedOpenings)
        ? expectedOpenings.length
        : null;
    const mismatch = numericMismatch(plan, 'doorCount', actualCount, target, tolerance);
    return mismatch ?? met(plan, toJsonValue({ field, actual: actualCount, target }), evidence);
  }

  if (field === 'flush') {
    const expectedFlush = checkExpected(check, 'flush');
    const actualFlush = asRecord(check.actual)?.['flush'];
    const observed = expectedFlush === true || actualFlush === true;
    const targetValue = targetBoolean(plan.target);
    if (targetValue === null) {
      return unverified(plan, { field, target: plan.target?.value ?? null }, evidence, 'target is not boolean');
    }
    return observed === targetValue
      ? met(plan, toJsonValue({ field, actual: observed, target: targetValue }), evidence)
      : notMet(
          plan,
          toJsonValue({ field, actual: observed, target: targetValue }),
          evidence,
          `expected flush ${String(targetValue)}, actual ${String(observed)}`,
        );
  }

  if (field === 'count') {
    const seats = numberValue(checkExpected(check, 'seats'));
    const expectedCount = numberValue(checkExpected(check, 'count'));
    const actual = seats ?? expectedCount;
    if (actual !== null && target !== null) {
      const mismatch = numericMismatch(plan, 'count', actual, target, tolerance);
      return mismatch ?? met(plan, toJsonValue({ field, actual, target }), evidence);
    }
    if (target === 0) return met(plan, { field, actual: 0, target: 0 }, evidence);
    return unverified(plan, { field, target: plan.target?.value ?? null }, evidence, 'count binding is unavailable');
  }

  if (target === 0) return met(plan, { field, actual: 0, target: 0 }, evidence);
  return unverified(
    plan,
    { field, target: plan.target?.value ?? null },
    evidence,
    'coverage pass binding is unavailable',
  );
}

function evaluateCoverage(plan: MustClausePlan, coverage: CoverageEvidence): LeafResult {
  const checkId = paramsString(plan.check, 'checkId') ?? plan.check.id;
  const check = coverage.checks.find((candidate) => candidate.id === checkId);
  if (check === undefined) {
    return unverified(plan, { checkId }, [], `coverage check missing: ${checkId}`);
  }
  const evidence = [checkRef(check.id, check.reason ?? `coverage ${check.status}: ${check.id}`)];
  if (check.status === 'fail') {
    return notMet(plan, toJsonValue(check.actual), evidence, check.reason ?? `coverage failed: ${check.id}`);
  }
  if (check.status === 'unverified') {
    return unverified(plan, toJsonValue(check.actual), evidence, check.reason ?? `coverage unverified: ${check.id}`);
  }
  return bindCoveragePass(plan, check);
}

function reportBounds(item: DiffItem | undefined): Bounds3 | null {
  const actual = item === undefined ? null : asRecord(item.actual);
  return actual === null ? null : boundsFrom(actual['bounds']);
}

function graphWallBounds(graph: AsBuiltObjectGraph): Bounds3 | null {
  return unionBounds(
    graph.objects
      .filter((object): object is WallObject => object.kind === 'wall')
      .map((object) => boundsFrom(object.bounds))
      .filter((bounds): bounds is Bounds3 => bounds !== null),
  );
}

function evaluateEnvelope(input: MustClauseEvaluationInput, plan: MustClausePlan): LeafResult {
  const field = paramsString(plan.check, 'field') ?? plan.target?.metric ?? 'width';
  const expectedId =
    paramsString(plan.check, 'expectedId') ?? plan.check.objectRefs.find((ref) => ref.startsWith('wall:')) ?? null;
  const item =
    expectedId === null ? undefined : input.report.items.find((candidate) => candidate.expectedId === expectedId);
  if (item?.severity === 'hard' && (item.status === 'fail' || item.status === 'missing')) {
    return notMet(
      plan,
      toJsonValue(item.actual),
      [diffRef(item, 'report')],
      `report-hard-fail: ${item.reason ?? `${item.status}/${item.severity}`}`,
    );
  }
  if (item?.severity === 'hard' && item.status === 'unverified') {
    return unverified(
      plan,
      toJsonValue(item.actual),
      [diffRef(item, 'report')],
      item.reason ?? 'report item unverified',
    );
  }
  const bounds = reportBounds(item) ?? graphWallBounds(input.graph);
  if (bounds === null) return unverified(plan, { field }, [], 'no actual wall envelope');
  const actual =
    field === 'depth' ? bounds.max[2] - bounds.min[2] : field === 'width' ? bounds.max[0] - bounds.min[0] : null;
  const target = targetNumber(plan.target);
  const tolerance = paramsNumber(plan.check, 'tolerance') ?? 0;
  const evidence = item === undefined ? [checkRef(plan.check.id, 'graph wall envelope')] : [diffRef(item, 'report')];
  const mismatch = numericMismatch(plan, field, actual, target, tolerance);
  return mismatch ?? met(plan, toJsonValue({ field, actual, target, bounds }), evidence);
}

function openingSide(spec: BuildSpec, opening: OpeningObject): string | null {
  if (opening.bounds.max[2] === spec.bounds.max[2]) return 'south';
  if (opening.bounds.min[2] === spec.bounds.min[2]) return 'north';
  if (opening.bounds.max[0] === spec.bounds.max[0]) return 'east';
  if (opening.bounds.min[0] === spec.bounds.min[0]) return 'west';
  return null;
}

function findGraphOpening(input: MustClauseEvaluationInput, expectedId: string): OpeningObject | null {
  const objects = input.graph.objects.filter((object): object is OpeningObject => object.kind === 'opening');
  const exact = objects.find((object) => object.id === expectedId || object.id === `opening:${expectedId}`);
  if (exact !== undefined) return exact;
  const specOpening = input.spec.openings.find((opening) => opening.id === expectedId);
  const expectedBounds = specOpening === undefined ? null : boundsFrom(specOpening.bounds);
  if (expectedBounds === null) return null;
  const ordered = [...objects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let best: OpeningObject | null = null;
  let bestVolume = 0;
  for (const object of ordered) {
    const bounds = boundsFrom(object.bounds);
    if (bounds === null) continue;
    const dx = Math.max(
      0,
      Math.min(bounds.max[0], expectedBounds.max[0]) - Math.max(bounds.min[0], expectedBounds.min[0]),
    );
    const dy = Math.max(
      0,
      Math.min(bounds.max[1], expectedBounds.max[1]) - Math.max(bounds.min[1], expectedBounds.min[1]),
    );
    const dz = Math.max(
      0,
      Math.min(bounds.max[2], expectedBounds.max[2]) - Math.max(bounds.min[2], expectedBounds.min[2]),
    );
    const volume = dx * dy * dz;
    if (volume > bestVolume) {
      best = object;
      bestVolume = volume;
    }
  }
  return best;
}

function openingMeasurement(item: DiffItem | undefined): {
  readonly aperture: JsonRecord | null;
  readonly glass: JsonRecord | null;
  readonly side: string | null;
} {
  const measurement = item === undefined ? null : asRecord(item.actual)?.['measurement'];
  const measurementRecord = asRecord(measurement);
  const actual = measurementRecord === null ? null : asRecord(measurementRecord['actual']);
  return {
    aperture: actual === null ? null : asRecord(actual['aperture']),
    glass: actual === null ? null : asRecord(actual['glass']),
    side: stringValue(measurementRecord?.['side']),
  };
}

function apertureColumns(aperture: JsonRecord | null): readonly number[] | null {
  if (aperture === null || !Array.isArray(aperture['columns'])) return null;
  const values = aperture['columns'].map(numberValue);
  return values.some((value) => value === null) ? null : (values as number[]);
}

function countScheduleOpenings(input: MustClauseEvaluationInput, side: string): number | null {
  const schedule = input.coverage.checks.find((check) => check.id === `check:schedule:${side}`);
  const actualOpenings = schedule === undefined ? null : asRecord(schedule.actual)?.['openings'];
  if (Array.isArray(actualOpenings)) return actualOpenings.length;
  const reportOpenings = input.report.items.filter(
    (item) => item.kind === 'opening' && stringValue(asRecord(item.actual)?.['side']) === side,
  );
  if (reportOpenings.length > 0) return reportOpenings.length;
  return schedule === undefined ? null : 0;
}

function evaluateOpening(input: MustClauseEvaluationInput, plan: MustClausePlan): LeafResult {
  const explicitId = paramsString(plan.check, 'expectedId');
  const openedRef = plan.check.objectRefs.find((ref) => ref.startsWith('opening:'));
  const expectedId = explicitId ?? openedRef?.slice('opening:'.length) ?? null;
  if (expectedId === null) return unverified(plan, null, [], 'opening id is missing');
  const item = input.report.items.find(
    (candidate) => candidate.expectedId === `opening:${expectedId}` || candidate.expectedId === expectedId,
  );
  const graphOpening = findGraphOpening(input, expectedId);
  if (item === undefined && graphOpening === null) {
    return unverified(plan, { expectedId }, [checkRef(plan.check.id, 'opening item missing')], 'opening item missing');
  }
  const measurement = openingMeasurement(item);
  const aperture = measurement.aperture;
  const glass = measurement.glass;
  const metric = plan.target?.metric ?? paramsString(plan.check, 'metric') ?? '';
  const standing = firstLevel(input.spec).elevation;
  const graphBounds = graphOpening === null ? null : boundsFrom(graphOpening.bounds);
  const graphCenterX = graphBounds === null ? null : (graphBounds.min[0] + graphBounds.max[0]) / 2;
  const tolerance = paramsNumber(plan.check, 'tolerance') ?? 0;
  const evidence = item === undefined ? [checkRef(plan.check.id, 'graph opening fallback')] : [diffRef(item, 'report')];

  const numericActual = (): number | null => {
    if (metric === 'width') {
      return (
        (aperture === null ? null : numberValue(aperture['width'])) ??
        (glass === null ? null : numberValue(glass['width'])) ??
        (graphOpening === null ? null : graphOpening.opening.widthCells)
      );
    }
    if (metric === 'height') {
      return (
        (aperture === null ? null : numberValue(aperture['height'])) ??
        (glass === null ? null : numberValue(glass['height'])) ??
        (graphOpening === null ? null : graphOpening.opening.heightCells)
      );
    }
    if (metric === 'sill') {
      const bottom =
        (aperture === null ? null : numberValue(aperture['bottom'])) ??
        (glass === null ? null : numberValue(glass['sillY'])) ??
        (graphOpening === null ? null : graphOpening.opening.sillY);
      return bottom === null ? null : bottom - standing;
    }
    if (metric === 'head') {
      const top =
        (aperture === null ? null : numberValue(aperture['top'])) ??
        (glass === null ? null : numberValue(glass['headY'])) ??
        (graphOpening === null ? null : graphOpening.opening.headY);
      return top === null ? null : top - standing;
    }
    return null;
  };

  if (metric === 'width' || metric === 'height' || metric === 'sill' || metric === 'head') {
    const actual = numericActual();
    const target = targetNumber(plan.target);
    const mismatch = numericMismatch(plan, metric, actual, target, tolerance);
    return mismatch ?? met(plan, toJsonValue({ metric, actual, target, expectedId }), evidence);
  }

  if (metric === 'side') {
    const actual =
      stringValue(asRecord(item?.actual)?.['side']) ??
      measurement.side ??
      (graphOpening === null ? null : openingSide(input.spec, graphOpening));
    const target = targetString(plan.target);
    if (target === null) return unverified(plan, { metric, expectedId }, evidence, 'target side is not a string');
    if (actual === null)
      return unverified(plan, { metric, expectedId, target }, evidence, 'opening side is unavailable');
    return actual === target
      ? met(plan, toJsonValue({ metric, actual, target, expectedId }), evidence)
      : notMet(
          plan,
          toJsonValue({ metric, actual, target, expectedId }),
          evidence,
          `expected side ${target}, actual ${actual}`,
        );
  }

  if (metric === 'centerX') {
    const columns = apertureColumns(aperture);
    const actual = columns === null ? graphCenterX : columns.reduce((sum, value) => sum + value, 0) / columns.length;
    const target = targetString(plan.target);
    const midX = paramsNumber(plan.check, 'midX') ?? (input.spec.bounds.min[0] + input.spec.bounds.max[0]) / 2;
    if (actual === null || target === null) {
      return unverified(
        plan,
        { metric, expectedId, target: plan.target?.value ?? null },
        evidence,
        'centerX is unavailable',
      );
    }
    const west = actual < midX;
    const matches = target === 'west-of-center' ? west : target === 'east-of-center' ? !west : false;
    return matches
      ? met(plan, toJsonValue({ metric, actual, midX, target, expectedId }), evidence)
      : notMet(
          plan,
          toJsonValue({ metric, actual, midX, target, expectedId }),
          evidence,
          `expected ${target} (midX ${String(midX)}), actual centerX ${String(actual)}`,
        );
  }

  if (metric === 'onlyOnSide') {
    const side = paramsString(plan.check, 'side');
    if (side === null) return unverified(plan, { metric, expectedId }, evidence, 'side is missing');
    const actual = countScheduleOpenings(input, side);
    const target = targetNumber(plan.target);
    const schedule = input.coverage.checks.find((check) => check.id === `check:schedule:${side}`);
    const scheduleEvidence = schedule === undefined ? [] : [checkRef(schedule.id, `schedule ${side}`)];
    const combined = [...evidence, ...scheduleEvidence];
    const mismatch = numericMismatch(plan, 'onlyOnSide', actual, target, tolerance);
    return mismatch ?? met(plan, toJsonValue({ metric, side, actual, target }), combined);
  }

  return unverified(plan, { metric, expectedId }, evidence, `unsupported opening metric: ${metric}`);
}

function boundaryWallBounds(input: MustClauseEvaluationInput, side: 'east' | 'west'): Bounds3 | null {
  const walls = input.graph.objects.filter((object): object is WallObject => object.kind === 'wall');
  const axisWalls = walls.filter((wall) => wall.wall.axis === 'z');
  const touching = axisWalls.filter((wall) =>
    side === 'east' ? wall.bounds.max[0] === input.spec.bounds.max[0] : wall.bounds.min[0] === input.spec.bounds.min[0],
  );
  const candidates = touching.length > 0 ? touching : axisWalls;
  return unionBounds(
    candidates.map((wall) => boundsFrom(wall.bounds)).filter((bounds): bounds is Bounds3 => bounds !== null),
  );
}

function furnitureItemId(ref: string): string {
  return ref.startsWith('furniture:') ? ref : `furniture:${ref}`;
}

function findFurnitureItem(input: MustClauseEvaluationInput, plan: MustClausePlan): DiffItem | null {
  const explicitId = paramsString(plan.check, 'expectedId');
  const refs = new Set<string>([
    ...plan.check.objectRefs.map(furnitureItemId),
    ...(explicitId === null ? [] : [furnitureItemId(explicitId)]),
  ]);
  return input.coverage.furnitureItems.find((item) => item.expectedId !== null && refs.has(item.expectedId)) ?? null;
}

function furnitureBoundsAndDetails(item: DiffItem): {
  readonly bounds: Bounds3;
  readonly subtype: string | null;
  readonly seatCapacity: number | null;
} | null {
  const actual = asRecord(item.actual);
  if (actual === null) return null;
  const bounds = boundsFrom(actual['bounds']);
  if (bounds === null) return null;
  const furniture = asRecord(actual['furniture']);
  return {
    bounds,
    subtype: furniture === null ? null : stringValue(furniture['subtype']),
    seatCapacity: furniture === null ? null : numberValue(furniture['seatCapacity']),
  };
}

function furnitureRelation(
  input: MustClauseEvaluationInput,
  plan: MustClausePlan,
  actualBounds: Bounds3,
  item: DiffItem,
): LeafResult {
  const relation = paramsString(plan.check, 'relation') ?? targetString(plan.target);
  const tolerance = paramsNumber(plan.check, 'tolerance') ?? 0;
  const evidence = [diffRef(item, 'coverage')];
  if (relation === 'east-wall' || relation === 'west-wall') {
    const wall = boundaryWallBounds(input, relation === 'east-wall' ? 'east' : 'west');
    if (wall === null) return unverified(plan, { relation }, evidence, `${relation} boundary wall is unavailable`);
    const actual = relation === 'east-wall' ? actualBounds.max[0] : actualBounds.min[0];
    const reference = relation === 'east-wall' ? wall.min[0] : wall.max[0];
    return matchesNumber(actual, reference, tolerance)
      ? met(plan, toJsonValue({ relation, actual, reference }), evidence)
      : notMet(
          plan,
          toJsonValue({ relation, actual, reference }),
          evidence,
          `expected ${relation} at ${String(reference)}, actual ${String(actual)}`,
        );
  }
  if (relation === 'north-of' || relation === 'south-of') {
    const referenceId = paramsString(plan.check, 'referenceId');
    if (referenceId === null) return unverified(plan, { relation }, evidence, 'reference furniture is missing');
    const reference = input.coverage.furnitureItems.find(
      (candidate) => candidate.expectedId === furnitureItemId(referenceId),
    );
    const referenceBounds = reference === undefined ? null : (furnitureBoundsAndDetails(reference)?.bounds ?? null);
    if (referenceBounds === null) {
      return unverified(plan, { relation, referenceId }, evidence, `reference furniture missing: ${referenceId}`);
    }
    const actualZ = (actualBounds.min[2] + actualBounds.max[2]) / 2;
    const referenceZ = (referenceBounds.min[2] + referenceBounds.max[2]) / 2;
    const matches = relation === 'north-of' ? actualZ < referenceZ : actualZ > referenceZ;
    return matches
      ? met(plan, toJsonValue({ relation, actualZ, referenceZ, referenceId }), evidence)
      : notMet(
          plan,
          toJsonValue({ relation, actualZ, referenceZ, referenceId }),
          evidence,
          `expected ${relation} ${referenceId}, actual centerZ ${String(actualZ)} vs ${String(referenceZ)}`,
        );
  }
  if (relation === 'west-of-door-clear') {
    const doorMaxX = paramsNumber(plan.check, 'doorMaxX');
    if (doorMaxX === null) return unverified(plan, { relation }, evidence, 'doorMaxX is missing');
    const actual = actualBounds.min[0];
    return actual >= doorMaxX
      ? met(plan, toJsonValue({ relation, actual, doorMaxX }), evidence)
      : notMet(
          plan,
          toJsonValue({ relation, actual, doorMaxX }),
          evidence,
          `expected bench minX >= ${String(doorMaxX)}, actual ${String(actual)}`,
        );
  }
  return unverified(plan, { relation }, evidence, `unsupported furniture relation: ${String(relation)}`);
}

function evaluateFurniture(input: MustClauseEvaluationInput, plan: MustClausePlan): LeafResult {
  const item = findFurnitureItem(input, plan);
  if (item === null) {
    return notMet(
      plan,
      { expectedId: plan.check.objectRefs[0] ?? paramsString(plan.check, 'expectedId') ?? null, status: 'missing' },
      [checkRef(plan.check.id, 'furniture item missing')],
      `missing expected furniture: ${plan.check.objectRefs[0] ?? paramsString(plan.check, 'expectedId') ?? 'unknown'}`,
    );
  }
  const details = furnitureBoundsAndDetails(item);
  if (details === null) {
    return item.status === 'unverified'
      ? unverified(plan, toJsonValue(item.actual), [diffRef(item, 'coverage')], item.reason ?? 'furniture unverified')
      : notMet(
          plan,
          toJsonValue(item.actual),
          [diffRef(item, 'coverage')],
          item.reason ?? 'furniture actual is missing',
        );
  }
  const metric = plan.target?.metric ?? paramsString(plan.check, 'metric') ?? '';
  const evidence = [diffRef(item, 'coverage')];
  const tolerance = paramsNumber(plan.check, 'tolerance') ?? 0;
  if (metric === 'length' || metric === 'depth') {
    const dx = details.bounds.max[0] - details.bounds.min[0];
    const dz = details.bounds.max[2] - details.bounds.min[2];
    const actual = metric === 'length' ? Math.max(dx, dz) : Math.min(dx, dz);
    const target = targetNumber(plan.target);
    const mismatch = numericMismatch(plan, metric, actual, target, tolerance);
    return mismatch ?? met(plan, toJsonValue({ metric, actual, target }), evidence);
  }
  if (metric === 'axis') {
    const target = targetString(plan.target);
    const dx = details.bounds.max[0] - details.bounds.min[0];
    const dz = details.bounds.max[2] - details.bounds.min[2];
    const actual = dx === dz ? null : dx > dz ? 'x' : 'z';
    if (target === null || actual === null) {
      return unverified(plan, { metric, target: plan.target?.value ?? null }, evidence, 'furniture axis is ambiguous');
    }
    return actual === target
      ? met(plan, toJsonValue({ metric, actual, target }), evidence)
      : notMet(
          plan,
          toJsonValue({ metric, actual, target }),
          evidence,
          `expected long axis ${target}, actual ${actual}`,
        );
  }
  if (metric === 'kind') {
    const target = targetString(plan.target);
    if (target === null || details.subtype === null) {
      return unverified(
        plan,
        { metric, target: plan.target?.value ?? null },
        evidence,
        'furniture kind is unavailable',
      );
    }
    return details.subtype === target
      ? met(plan, toJsonValue({ metric, actual: details.subtype, target }), evidence)
      : notMet(
          plan,
          toJsonValue({ metric, actual: details.subtype, target }),
          evidence,
          `expected kind ${target}, actual ${details.subtype}`,
        );
  }
  if (metric === 'seat') {
    const target = targetNumber(plan.target);
    const mismatch = numericMismatch(plan, 'seatCapacity', details.seatCapacity, target, tolerance);
    return mismatch ?? met(plan, toJsonValue({ metric, actual: details.seatCapacity, target }), evidence);
  }
  if (metric === 'relation' || paramsString(plan.check, 'relation') !== null) {
    return furnitureRelation(input, plan, details.bounds, item);
  }
  return unverified(plan, { metric }, evidence, `unsupported furniture metric: ${metric}`);
}

function evaluateRoofForm(input: MustClauseEvaluationInput, plan: MustClausePlan): LeafResult {
  const target = targetString(plan.target);
  if (target === null)
    return unverified(plan, { target: plan.target?.value ?? null }, [], 'roof target form is not a string');
  // 屋面 clause 以对象 diff 的 roof 条目为唯一裁决，避免 form 分类器与 diff 各说各话。
  const item = input.report.items.find(
    (candidate) =>
      candidate.expectedId !== null &&
      (candidate.expectedId === 'roof' ||
        candidate.expectedId.startsWith('roof:') ||
        plan.check.objectRefs.includes(candidate.expectedId)),
  );
  let actualForm: string | null;
  try {
    actualForm = evaluateRoof(input.spec, input.grid).actual.form;
  } catch {
    actualForm = null;
  }
  if (item !== undefined) {
    const evidence = [
      diffRef(item, 'report'),
      ...(actualForm === null ? [] : [checkRef('check:roof:form', `roof form ${actualForm}`)]),
    ];
    const actual = toJsonValue({
      target,
      expectedId: item.expectedId,
      reportStatus: item.status,
      observedForm: actualForm,
      deltaKeys: Object.keys(item.delta).sort(),
    });
    if (item.status === 'pass') {
      // object diff 的 form 只区分 flat / pitched，不能单独证明 gable / shed。
      // 只有 form 分类器也给出同一目标时才 met；分类器说 stepped 时保持 unverified，不制造矛盾。
      if (actualForm === target) return met(plan, actual, evidence);
      return unverified(
        plan,
        actual,
        evidence,
        `roof object diff pass, but form classifier reports ${actualForm ?? 'unavailable'}; cannot prove ${target}`,
      );
    }
    if (item.status === 'unverified') {
      return unverified(plan, actual, evidence, `roof object diff unverified: ${item.reason ?? 'no reason'}`);
    }
    // 只有 form 维度失败才是 form clause 的硬失败；bounds / pitch / eave / ridge 失败不能连带 form。
    if (Object.hasOwn(item.delta, 'form')) {
      return notMet(
        plan,
        actual,
        evidence,
        `roof form mismatch: expected ${target}, actual ${actualForm ?? 'unknown'}`,
      );
    }
    return unverified(
      plan,
      actual,
      evidence,
      `roof object diff ${item.status} without a form delta: ${item.reason ?? 'no reason'}`,
    );
  }
  // 报告缺 roof item 时 fail closed；不再用另一套分类器单独判 met。
  return unverified(
    plan,
    { target, expectedId: 'roof', reportStatus: 'missing', observedForm: actualForm },
    [checkRef('check:roof:form', actualForm === null ? 'roof form unavailable' : `roof form ${actualForm}`)],
    'roof object diff item is missing; cannot prove roof form',
  );
}

function evaluateBudget(input: MustClauseEvaluationInput, plan: MustClausePlan): LeafResult {
  const target = targetNumber(plan.target);
  if (target === null)
    return unverified(plan, { target: plan.target?.value ?? null }, [], 'budget target is not numeric');
  const specMax = paramsNumber(plan.check, 'specMax');
  const effective = specMax === null ? target : Math.min(target, specMax);
  const actual = input.graph.summary.totalCells;
  const evidence = [checkRef(plan.check.id, `budget actual ${String(actual)}`)];
  return actual <= effective
    ? met(plan, { actual, target, specMax, effective }, evidence)
    : notMet(
        plan,
        { actual, target, specMax, effective },
        evidence,
        `budget exceeded: actual ${String(actual)} > ${String(effective)}`,
      );
}

function itemRefs(plan: MustClausePlan): readonly string[] {
  if (plan.check.objectRefs.length > 0) return plan.check.objectRefs;
  const expectedId = paramsString(plan.check, 'expectedId');
  return expectedId === null ? [] : [expectedId];
}

function evaluateReport(input: MustClauseEvaluationInput, plan: MustClausePlan): LeafResult {
  const refs = itemRefs(plan);
  if (refs.length === 0) return unverified(plan, null, [], 'report reference is missing');
  const reportItems = input.report.items.filter((item) => item.expectedId !== null && refs.includes(item.expectedId));
  const furnitureItems = input.coverage.furnitureItems.filter(
    (item) => item.expectedId !== null && refs.includes(item.expectedId),
  );
  const items = [...reportItems, ...furnitureItems];
  const evidence = [
    ...reportItems.map((item) => diffRef(item, 'report')),
    ...furnitureItems.map((item) => diffRef(item, 'coverage')),
  ];
  const hardFails = items.filter(
    (item) => item.severity === 'hard' && (item.status === 'fail' || item.status === 'missing'),
  );
  const actual = toJsonValue({
    hardFail: hardFails.length > 0,
    items: items.map((item) => ({
      id: item.id,
      expectedId: item.expectedId,
      status: item.status,
      severity: item.severity,
    })),
  });
  if (hardFails.length > 0) {
    const first = hardFails[0];
    return notMet(
      plan,
      actual,
      evidence,
      `report-hard-fail: ${first?.reason ?? `${first?.status ?? 'fail'}/${first?.severity ?? 'hard'}`}`,
    );
  }
  const missingRefs = refs.filter((ref) => !items.some((item) => item.expectedId === ref));
  const unverifiedItems = items.filter((item) => item.status === 'unverified' || item.status === 'fail');
  if (missingRefs.length > 0 || unverifiedItems.length > 0) {
    const reason =
      missingRefs.length > 0
        ? `report item missing: ${missingRefs.join(', ')}`
        : (unverifiedItems[0]?.reason ?? 'report item unverified');
    return unverified(plan, actual, evidence, reason);
  }
  if (items.length === 0) return unverified(plan, actual, evidence, 'report item missing');
  const allPass = refs.every((ref) => items.some((item) => item.expectedId === ref && item.status === 'pass'));
  return allPass ? met(plan, actual, evidence) : unverified(plan, actual, evidence, 'report item not pass');
}

function evaluateQualitative(plan: MustClausePlan): LeafResult {
  return unverified(plan, null, [], plan.reason ?? 'qualitative: no dedicated checker');
}

function evaluateCheck(input: MustClauseEvaluationInput, plan: MustClausePlan): LeafResult {
  switch (plan.check.kind) {
    case 'coverage':
      return evaluateCoverage(plan, input.coverage);
    case 'envelope':
      return evaluateEnvelope(input, plan);
    case 'opening':
      return evaluateOpening(input, plan);
    case 'furniture':
      return evaluateFurniture(input, plan);
    case 'roof':
      return evaluateRoofForm(input, plan);
    case 'budget':
      return evaluateBudget(input, plan);
    case 'report':
      return evaluateReport(input, plan);
    case 'qualitative':
      return evaluateQualitative(plan);
    default:
      return unverified(plan, null, [], `unsupported check kind: ${String(plan.check.kind)}`);
  }
}

function evaluateLeaf(input: MustClauseEvaluationInput, plan: MustClausePlan): LeafResult {
  const result = evaluateCheck(input, plan);
  if (plan.conflict === null) return result;
  return {
    plan,
    status: 'not-met',
    actual: toJsonValue({
      target: plan.target?.value ?? null,
      spec: plan.specTarget,
      observed: result.actual,
    }),
    evidence: result.evidence,
    reason: clip(`conflict: ${plan.conflict.message}`, MAX_REASON),
  };
}

function hardFails(input: MustClauseEvaluationInput): readonly HardFail[] {
  const out: HardFail[] = [];
  for (const item of input.report.items) {
    if (item.expectedId === null || item.severity !== 'hard') continue;
    if (item.status !== 'fail' && item.status !== 'missing') continue;
    out.push({
      expectedId: item.expectedId,
      evidence: diffRef(item, 'report'),
      reason: item.reason ?? `${item.status}/${item.severity}`,
      source: 'report',
    });
  }
  for (const item of input.coverage.furnitureItems) {
    if (item.expectedId === null || item.severity !== 'hard') continue;
    if (item.status !== 'fail' && item.status !== 'missing') continue;
    out.push({
      expectedId: item.expectedId,
      evidence: diffRef(item, 'coverage'),
      reason: item.reason ?? `${item.status}/${item.severity}`,
      source: 'furniture',
    });
  }
  // 覆盖检查的 hard fail 也是报告事实；没有 must leaf 时进入未归因列表。
  for (const check of input.coverage.checks) {
    if (check.status !== 'fail') continue;
    out.push({
      expectedId: check.id,
      evidence: checkRef(check.id, check.reason ?? `coverage failed: ${check.id}`),
      reason: check.reason ?? `coverage failed: ${check.id}`,
      source: 'coverage',
    });
  }
  return out;
}

function attributable(result: LeafResult, expectedId: string): boolean {
  // 只把 hard fail 归到该对象的 explicit report leaf / 对应覆盖检查 leaf；
  // 其他 metric leaf 继续按 actual-vs-target 独立判定，不被一处几何失败连带改写。
  if (result.plan.check.kind === 'report' && result.plan.check.objectRefs.includes(expectedId)) return true;
  // `roof` 是短词，不能让它误伤 id 里恰好含 "roof" 的定性 clause。
  if (expectedId === 'roof') {
    // form leaf 由 evaluateRoofForm 单独判定；这里只让 report-roof 承担对象级 hard fail。
    return result.plan.check.id === 'report:roof';
  }
  return result.plan.check.id === expectedId;
}

interface HardFailTarget {
  readonly mustId: string;
}

/**
 * 覆盖检查的 material hard fail 没有对应 clause，但语义上直接落在材料 must 上。
 * 映射按 must id 片段（不读 must 文本）：具体材料 must + 复合材料限定；未命中时仍进全局未归因列表。
 */
function hardFailTargets(expectedId: string, results: readonly LeafResult[]): readonly HardFailTarget[] {
  const byId = (fragment: string): HardFailTarget[] => {
    const found = results.find((result) => result.plan.mustId.includes(fragment));
    return found === undefined ? [] : [{ mustId: found.plan.mustId }];
  };
  if (expectedId === 'check:material:wall' || expectedId === 'check:material:structure') {
    return [...byId('wood-wall-column'), ...byId('material-selection')];
  }
  if (expectedId === 'check:material:roof') {
    return [...byId('gable-tile-roof'), ...byId('material-selection')];
  }
  if (expectedId === 'check:material:base') {
    return [...byId('stone-base'), ...byId('material-selection')];
  }
  return [];
}

function applyHardFailAttribution(
  results: readonly LeafResult[],
  input: MustClauseEvaluationInput,
): {
  readonly results: readonly LeafResult[];
  readonly unattributed: readonly string[];
  readonly globalBlockers: readonly string[];
  readonly attributed: readonly MustClauseHardFailAttribution[];
} {
  const unattributed: string[] = [];
  const globalBlockers: string[] = [];
  const attributed: MustClauseHardFailAttribution[] = [];
  const byClause = new Map<string, LeafResult>();
  for (const result of results) byClause.set(result.plan.clauseId, result);
  for (const failure of hardFails(input)) {
    const matched = results.filter((result) => attributable(result, failure.expectedId));
    const targets = matched.length === 0 ? hardFailTargets(failure.expectedId, results) : [];
    if (matched.length === 0 && targets.length === 0) {
      // 设计声明了家具但没有任何 must 覆盖时，缺失/尺寸错误是显式全局阻断，
      // 不是“未归因”：必须给出理由并进入 review.nextAction。
      if (failure.source === 'furniture') {
        globalBlockers.push(
          clip(
            `${failure.expectedId}: no must covers this expected furniture; build it exactly or waive it in design`,
            160,
          ),
        );
      } else {
        // 其他没有 must clause 的硬失败不能消失：进入全局未归因列表，由评审阻断 accept。
        unattributed.push(clip(`${failure.expectedId}: ${failure.reason}`, 160));
      }
      continue;
    }
    const hardEvidence = failure.evidence;
    for (const result of matched) {
      const existing = byClause.get(result.plan.clauseId);
      if (existing === undefined) continue;
      const evidence = existing.evidence.some((ref) => ref.ref === hardEvidence.ref)
        ? existing.evidence
        : [hardEvidence, ...existing.evidence];
      const hardReason = clip(`report-hard-fail: ${failure.reason}`, MAX_REASON);
      const reason =
        existing.reason?.startsWith('conflict:') === true
          ? clip(`${existing.reason}; ${hardReason}`, MAX_REASON)
          : hardReason;
      byClause.set(result.plan.clauseId, {
        plan: existing.plan,
        status: 'not-met',
        actual: existing.actual,
        evidence,
        reason,
      });
    }
    if (targets.length > 0) {
      attributed.push({
        checkId: failure.expectedId,
        mustIds: targets.map((target) => target.mustId),
        summary: clip(failure.reason, MAX_REASON),
      });
      for (const target of targets) {
        const groupLeaves = results.filter((result) => result.plan.mustId === target.mustId);
        // 优先落到 material clause；没有 material clause 时才落到首个 leaf。
        const leaf = groupLeaves.find((result) => result.plan.kind === 'material') ?? groupLeaves[0];
        if (leaf === undefined) continue;
        const existing = byClause.get(leaf.plan.clauseId);
        if (existing === undefined) continue;
        const evidence = existing.evidence.some((ref) => ref.ref === hardEvidence.ref)
          ? existing.evidence
          : [hardEvidence, ...existing.evidence];
        const hardReason = clip(`attributed-hard-fail: ${failure.reason}`, MAX_REASON);
        byClause.set(existing.plan.clauseId, {
          plan: existing.plan,
          status: 'not-met',
          actual: existing.actual,
          evidence,
          reason:
            existing.reason === null || existing.reason.startsWith('conflict:')
              ? hardReason
              : clip(`${existing.reason}; ${hardReason}`, MAX_REASON),
        });
      }
    }
  }
  // hard unverified 也是 blocking（object-diff 口径）；没有 leaf 的必须进入全局列表。
  const blockingUnverified = [
    ...input.report.items.map((item) => ({ item, source: 'report' as const })),
    ...input.coverage.furnitureItems.map((item) => ({ item, source: 'furniture' as const })),
  ].filter(
    ({ item }) =>
      item.expectedId !== null &&
      item.severity === 'hard' &&
      item.status === 'unverified' &&
      !results.some((result) => item.expectedId !== null && result.plan.check.objectRefs.includes(item.expectedId)),
  );
  for (const { item, source } of blockingUnverified) {
    if (item.expectedId === null) continue;
    if (source === 'furniture') {
      globalBlockers.push(
        clip(`${item.expectedId}: expected furniture unverified; build it exactly or waive it in design`, 160),
      );
    } else {
      unattributed.push(clip(`${item.expectedId}: hard-unverified ${item.reason ?? ''}`.trim(), 160));
    }
  }
  const unique = [...new Set(unattributed)].sort();
  // 不静默丢弃：超过 schema 上限时保留 99 条 + 一条计数哨兵。
  const capped =
    unique.length > 100
      ? [...unique.slice(0, 99), `+${String(unique.length - 99)} more unattributed hard failures`]
      : unique;
  const uniqueGlobal = [...new Set(globalBlockers)].sort();
  const cappedGlobal =
    uniqueGlobal.length > 100
      ? [...uniqueGlobal.slice(0, 99), `+${String(uniqueGlobal.length - 99)} more global blockers`]
      : uniqueGlobal;
  return {
    results: results.map((result) => byClause.get(result.plan.clauseId) ?? result),
    unattributed: capped,
    globalBlockers: cappedGlobal,
    attributed: attributed.sort((a, b) =>
      a.checkId === b.checkId ? (a.mustIds.join(',') < b.mustIds.join(',') ? -1 : 1) : a.checkId < b.checkId ? -1 : 1,
    ),
  };
}

function toEvidence(result: LeafResult): MustClauseEvidence {
  return {
    clauseId: result.plan.clauseId,
    mustId: result.plan.mustId,
    kind: result.plan.kind,
    target: result.plan.target,
    check: result.plan.check,
    status: result.status,
    actual: result.actual,
    evidence: result.evidence.slice(0, MAX_EVIDENCE),
    reason: result.reason === null ? null : clip(result.reason, MAX_REASON),
    conflict: result.plan.conflict,
  };
}

/** 逐 leaf 比较实际值；hard fail 归因后重算 group / summary。 */
export function evaluateMustClauses(input: MustClauseEvaluationInput): MustClauseEvaluation {
  const plan = input.plan ?? compileMustClauses(input.spec);
  const initial = plan.groups.flatMap((group) => group.leaves.map((leaf) => evaluateLeaf(input, leaf)));
  const attributed = applyHardFailAttribution(initial, input);
  const resultByClause = new Map(attributed.results.map((result) => [result.plan.clauseId, result]));
  const groups: MustClauseGroupEvidence[] = plan.groups.map((group) => {
    const leaves = group.leaves.map((leaf) => {
      const result = resultByClause.get(leaf.clauseId);
      if (result === undefined) throw new Error(`clause ${leaf.clauseId} was not evaluated`);
      return result;
    });
    return {
      mustId: group.mustId,
      text: group.text,
      status: aggregateMustClauseStatus(leaves.map((leaf) => leaf.status)),
      leaves: leaves.map(toEvidence),
    };
  });
  const count = (status: MustClauseStatus): number => groups.filter((group) => group.status === status).length;
  const leaves = groups.reduce((sum, group) => sum + group.leaves.length, 0);
  const conflicts = attributed.results.filter((result) => result.plan.conflict !== null).length;
  return MustClauseEvaluationSchema.parse({
    schemaVersion: MUST_CLAUSE_EVALUATION_SCHEMA_VERSION,
    tool: MUST_CLAUSE_EVALUATION_TOOL,
    compilerVersion: plan.compilerVersion === '' ? MUST_CLAUSE_COMPILER_VERSION : plan.compilerVersion,
    groups,
    summary: {
      musts: groups.length,
      met: count('met'),
      notMet: count('not-met'),
      waived: count('waived'),
      unverified: count('unverified'),
      leaves,
      conflicts,
      unattributedHardFails: attributed.unattributed,
      globalBlockers: attributed.globalBlockers,
      attributedHardFails: [...attributed.attributed],
    },
    unattributedHardFails: attributed.unattributed,
    globalBlockers: attributed.globalBlockers,
  });
}

/** 便于测试 / 诊断：从 evaluation 扁平取 leaves。 */
export function flattenClauseLeaves(evaluation: MustClauseEvaluation): readonly MustClauseEvidence[] {
  return evaluation.groups.flatMap((group) => group.leaves);
}
