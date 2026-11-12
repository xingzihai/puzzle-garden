/* eslint-disable max-lines -- 第一刀把中性类型、匹配与逐字段比较放在同一模块，避免拆出没有独立语义的半成品。 */
/**
 * 通用设计 vs 施工对象 diff（CONF-NEXT-03 第一刀）。
 *
 * 负责：把中性的期望对象（wall / slab / roof / opening）与 `@pg/analysis/as-built` 的实际对象图
 * 做匹配、逐字段比较、汇总；输出确定性的 `DiffReport`。
 * 不负责：BuildSpec 投影（tools/conformance-expect.ts）、读文件 / CLI（tools/conformance-diff.ts）、
 * 场地语义、遮挡 / 连接 / submit 硬门。家具由 `diffFurnitureObjects` 单独比较，不进入主表。
 *
 * 第一刀口径（见 docs/BUILD-SELF-VERIFICATION.md §3/§10 与任务卡）：
 * - wall / slab：actual 同 kind 聚合成 union 包络再比；单体量墙额外检查四侧覆盖。
 * - roof：取 footprint 最大的 actual roof，比 bounds / coarse form / pitch(±2°) / eave / ridge。
 * - opening：按 subtype family + 墙法向 + 空间重叠匹配；低 confidence 只报 unverified。
 * - site / furniture / unknown 不进主表硬比较；unknown 作为 soft unverified，其余记 notCompared。
 * - 家具专项由 `diffFurnitureObjects` 比较 bounds / 主材 / 座位数，独立返回 DiffItem。
 * - 位置 / 尺寸容差为 0 格；所有输出按固定全序排序。
 */

import type {
  AsBuiltBounds,
  AsBuiltObject,
  AsBuiltObjectGraph,
  Confidence,
  FurnitureObject,
  OpeningObject,
  RoofObject,
  SlabObject,
  WallObject,
} from './as-built-types.ts';

export type DiffObjectKind = 'wall' | 'slab' | 'roof' | 'opening';
/** 通用 diff 对象 + 家具专项 item + unknown 上下文。 */
export type DiffItemKind = DiffObjectKind | 'furniture' | 'unknown';
export type DiffStatus = 'pass' | 'fail' | 'missing' | 'extra' | 'unverified';
export type DiffSeverity = 'hard' | 'soft';
export type DiffSide = 'north' | 'east' | 'south' | 'west';
export type ExpectedRoofForm = 'flat' | 'gable' | 'hip' | 'shed' | 'butterfly' | 'curved' | 'other';
export type ExpectedOpeningSubtype = 'window' | 'door';

export interface DiffBounds {
  readonly min: readonly [number, number, number];
  /** 半开上界。 */
  readonly max: readonly [number, number, number];
}

export interface ExpectedObjectBase {
  readonly id: string;
  readonly kind: DiffObjectKind;
  readonly bounds: DiffBounds;
  /** 非 null 表示投影不可靠：只报 hard unverified，不做硬比较。 */
  readonly unverifiedReason: string | null;
}

export interface ExpectedWall extends ExpectedObjectBase {
  readonly kind: 'wall';
}

export interface ExpectedSlab extends ExpectedObjectBase {
  readonly kind: 'slab';
}

export interface ExpectedRoof extends ExpectedObjectBase {
  readonly kind: 'roof';
  readonly form: ExpectedRoofForm;
  readonly pitchDegrees: number;
  readonly eaveY: number;
  readonly ridgeY: number;
  readonly overhang: number;
}

export interface ExpectedOpening extends ExpectedObjectBase {
  readonly kind: 'opening';
  readonly subtype: ExpectedOpeningSubtype;
  readonly side: DiffSide;
  readonly width: number;
  readonly height: number;
  /** 绝对标高（level.elevation + sillHeight）。 */
  readonly sillY: number;
  /** 绝对标高上界（level.elevation + headHeight）。 */
  readonly headY: number;
  readonly hostId: string | null;
}

/**
 * 家具期望：不入 `projectExpectedObjects` / conformance-diff 主表，只由
 * `diffFurnitureObjects` 显式调用（覆盖证据 / 家具专项）。
 */
export interface ExpectedFurniture {
  readonly id: string;
  readonly kind: 'furniture';
  readonly bounds: DiffBounds;
  /** 必填材质方块；实际 `materials` 必须包含它且它是主材。null 表示不校验。 */
  readonly materialBlock: string | null;
  /** 设计分类（table / bench / counter / ...）；当前只作证据，不做几何硬猜。 */
  readonly furnitureKind: string;
  /** 非 null 时比较实际 `furniture.seatCapacity`。 */
  readonly seatCapacity: number | null;
  /** 非 null 表示投影不可靠：只报 hard unverified，不做硬比较。 */
  readonly unverifiedReason: string | null;
}

export type ExpectedObject = ExpectedWall | ExpectedSlab | ExpectedRoof | ExpectedOpening;

export interface DiffDeltaEntry {
  readonly expected: unknown;
  readonly actual: unknown;
  readonly delta: unknown;
}

export interface DiffItem {
  readonly id: string;
  readonly kind: DiffItemKind;
  readonly expectedId: string | null;
  readonly actualId: string | null;
  readonly status: DiffStatus;
  readonly severity: DiffSeverity;
  readonly expected: Readonly<Record<string, unknown>> | null;
  readonly actual: Readonly<Record<string, unknown>> | null;
  readonly delta: Readonly<Record<string, DiffDeltaEntry>>;
  readonly evidence: readonly string[];
  readonly reason: string | null;
}

export interface DiffSummary {
  readonly pass: number;
  readonly fail: number;
  readonly missing: number;
  readonly extra: number;
  readonly unverified: number;
  /** hard fail + hard missing + hard unverified 的数量。 */
  readonly blockingCount: number;
  readonly blocking: boolean;
  readonly fullyVerified: boolean;
}

export interface NotComparedSummary {
  readonly site: number;
  readonly furniture: number;
  readonly unknown: number;
  readonly total: number;
  readonly ids: {
    readonly site: readonly string[];
    readonly furniture: readonly string[];
    readonly unknown: readonly string[];
  };
}

export interface DiffReport {
  readonly schemaVersion: 1;
  readonly measurement: {
    readonly unit: 'voxel-cell';
    readonly boundsConvention: 'half-open [min,max)';
    readonly positionToleranceCells: 0;
    readonly pitchToleranceDegrees: 2;
  };
  readonly items: readonly DiffItem[];
  readonly summary: DiffSummary;
  readonly notCompared: NotComparedSummary;
  /** `compareOpenings:false` 时把对象图洞口留作上下文，不参与 item / 汇总。 */
  readonly context: {
    readonly openings: readonly ActualOpeningContext[];
  };
  readonly notes: readonly string[];
}

export interface ActualOpeningContext {
  readonly id: string;
  readonly bounds: DiffBounds;
  readonly confidence: Confidence;
  readonly subtype: OpeningObject['opening']['subtype'];
  readonly fill: OpeningObject['opening']['fill'];
}

export interface DiffOptions {
  /**
   * 默认 true：纯对象图匹配，供无 Grid 的路径 / 单测使用。
   * CLI 有 Grid 且以 evaluateOpenings 为准时传 false；对象图洞口只进 `context.openings`。
   */
  readonly compareOpenings?: boolean;
}

const KIND_ORDER: Readonly<Record<DiffItemKind, number>> = {
  wall: 0,
  slab: 1,
  roof: 2,
  opening: 3,
  furniture: 4,
  unknown: 5,
};

const CONFIDENCE_ORDER: Readonly<Record<Confidence, number>> = { high: 0, medium: 1, low: 2 };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function boundsOfTuple(bounds: AsBuiltBounds | DiffBounds): DiffBounds {
  return { min: [bounds.min[0], bounds.min[1], bounds.min[2]], max: [bounds.max[0], bounds.max[1], bounds.max[2]] };
}

function boundsTuple(bounds: DiffBounds): readonly [number, number, number, number, number, number] {
  return [bounds.min[0], bounds.min[1], bounds.min[2], bounds.max[0], bounds.max[1], bounds.max[2]];
}

function boundsEqual(a: DiffBounds, b: DiffBounds): boolean {
  return boundsTuple(a).every((value, index) => value === boundsTuple(b)[index]);
}

function boundsDelta(expected: DiffBounds, actual: DiffBounds): DiffDeltaEntry {
  const expectedTuple = boundsTuple(expected);
  const actualTuple = boundsTuple(actual);
  return {
    expected: expectedTuple,
    actual: actualTuple,
    delta: expectedTuple.map((value, index) => (actualTuple[index] ?? 0) - value),
  };
}

function numberDelta(expected: number, actual: number): DiffDeltaEntry {
  return { expected, actual, delta: actual - expected };
}

function unionBounds(objects: readonly AsBuiltObject[]): AsBuiltBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const object of objects) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis] ?? Infinity, object.bounds.min[axis] ?? 0);
      max[axis] = Math.max(max[axis] ?? -Infinity, object.bounds.max[axis] ?? 0);
    }
  }
  return { min, max };
}

function worstConfidence(objects: readonly AsBuiltObject[]): Confidence {
  let worst: Confidence = 'high';
  for (const object of objects) {
    if (CONFIDENCE_ORDER[object.confidence] > CONFIDENCE_ORDER[worst]) worst = object.confidence;
  }
  return worst;
}

function objectSnapshot(object: AsBuiltObject): Readonly<Record<string, unknown>> {
  const base = {
    id: object.id,
    kind: object.kind,
    bounds: boundsOfTuple(object.bounds),
    confidence: object.confidence,
    cells: object.cells,
    footprintCells: object.footprintCells,
    support: object.support,
  };
  switch (object.kind) {
    case 'wall':
      return { ...base, wall: object.wall };
    case 'slab':
      return { ...base, slab: object.slab };
    case 'roof':
      return { ...base, roof: object.roof };
    case 'opening':
      return {
        ...base,
        host: object.host,
        opening: {
          subtype: object.opening.subtype,
          fill: object.opening.fill,
          width: object.opening.widthCells,
          height: object.opening.heightCells,
          sillY: object.opening.sillY,
          headY: object.opening.headY,
          voidCells: object.opening.voidCells,
          fillCells: object.opening.fillCells,
        },
      };
    case 'site':
      return { ...base, site: object.site };
    case 'furniture':
      return { ...base, furniture: object.furniture };
    case 'unknown':
      return { ...base, unknown: object.unknown };
  }
}

function expectedSnapshot(object: ExpectedObject | ExpectedFurniture): Readonly<Record<string, unknown>> {
  const base = {
    id: object.id,
    kind: object.kind,
    bounds: boundsOfTuple(object.bounds),
    unverifiedReason: object.unverifiedReason,
  };
  switch (object.kind) {
    case 'wall':
    case 'slab':
      return base;
    case 'roof':
      return {
        ...base,
        form: object.form,
        pitchDegrees: object.pitchDegrees,
        eaveY: object.eaveY,
        ridgeY: object.ridgeY,
        overhang: object.overhang,
      };
    case 'opening':
      return {
        ...base,
        subtype: object.subtype,
        side: object.side,
        width: object.width,
        height: object.height,
        sillY: object.sillY,
        headY: object.headY,
        hostId: object.hostId,
      };
    case 'furniture':
      return {
        ...base,
        materialBlock: object.materialBlock,
        furnitureKind: object.furnitureKind,
        seatCapacity: object.seatCapacity,
      };
  }
}

function makeItem(input: {
  readonly id: string;
  readonly kind: DiffItemKind;
  readonly expectedId: string | null;
  readonly actualId: string | null;
  readonly status: DiffStatus;
  readonly severity: DiffSeverity;
  readonly expected: Readonly<Record<string, unknown>> | null;
  readonly actual: Readonly<Record<string, unknown>> | null;
  readonly delta: Readonly<Record<string, DiffDeltaEntry>>;
  readonly evidence: readonly string[];
  readonly reason: string | null;
}): DiffItem {
  return input;
}

function unverifiedExpected(object: ExpectedObject | ExpectedFurniture): DiffItem {
  return makeItem({
    id: `expected:${object.id}`,
    kind: object.kind,
    expectedId: object.id,
    actualId: null,
    status: 'unverified',
    severity: 'hard',
    expected: expectedSnapshot(object),
    actual: null,
    delta: {},
    evidence: [`projection:${object.id}`],
    reason: object.unverifiedReason ?? 'projection is not reliable enough for a hard comparison',
  });
}

function missingExpected(object: ExpectedObject | ExpectedFurniture): DiffItem {
  return makeItem({
    id: `expected:${object.id}`,
    kind: object.kind,
    expectedId: object.id,
    actualId: null,
    status: 'missing',
    severity: 'hard',
    expected: expectedSnapshot(object),
    actual: null,
    delta: {},
    evidence: [`projection:${object.id}`],
    reason: `no actual ${object.kind} object matched the expected envelope`,
  });
}

function itemKind(kind: AsBuiltObject['kind']): DiffItemKind {
  return kind === 'wall' || kind === 'slab' || kind === 'roof' || kind === 'opening' || kind === 'furniture'
    ? kind
    : 'unknown';
}

function actualExtra(object: AsBuiltObject, reason: string): DiffItem {
  return makeItem({
    id: `extra:${object.kind}:${object.id}`,
    kind: itemKind(object.kind),
    expectedId: null,
    actualId: object.id,
    status: 'extra',
    severity: 'soft',
    expected: null,
    actual: objectSnapshot(object),
    delta: {},
    evidence: [`actual:${object.id}`],
    reason,
  });
}

function actualUnverified(object: AsBuiltObject, reason: string): DiffItem {
  return makeItem({
    id: `unverified:${object.kind}:${object.id}`,
    kind: itemKind(object.kind),
    expectedId: null,
    actualId: object.id,
    status: 'unverified',
    severity: 'soft',
    expected: null,
    actual: objectSnapshot(object),
    delta: {},
    evidence: [`actual:${object.id}`],
    reason,
  });
}

function wallEnvelopeAligned(walls: readonly WallObject[], expected: DiffBounds): boolean {
  const minPlaneX = expected.min[0];
  const maxPlaneX = expected.max[0] - 1;
  const minPlaneZ = expected.min[2];
  const maxPlaneZ = expected.max[2] - 1;
  for (const wall of walls) {
    if (wall.wall.axis === 'x' && wall.wall.plane !== minPlaneZ && wall.wall.plane !== maxPlaneZ) return false;
    if (wall.wall.axis === 'z' && wall.wall.plane !== minPlaneX && wall.wall.plane !== maxPlaneX) return false;
  }
  return true;
}

function wallSideCoverage(
  walls: readonly WallObject[],
  expected: DiffBounds,
): { readonly applicable: boolean; readonly missing: readonly string[] } {
  if (!wallEnvelopeAligned(walls, expected)) return { applicable: false, missing: [] };
  const minPlaneX = expected.min[0];
  const maxPlaneX = expected.max[0] - 1;
  const minPlaneZ = expected.min[2];
  const maxPlaneZ = expected.max[2] - 1;
  const coversY = (wall: WallObject): boolean =>
    wall.bounds.min[1] <= expected.min[1] && wall.bounds.max[1] >= expected.max[1];
  const covers = (side: DiffSide): boolean =>
    walls.some((wall) => {
      if (!coversY(wall)) return false;
      const minX = wall.bounds.min[0];
      const maxX = wall.bounds.max[0];
      const minZ = wall.bounds.min[2];
      const maxZ = wall.bounds.max[2];
      switch (side) {
        case 'north':
          return (
            wall.wall.axis === 'x' &&
            wall.wall.plane === minPlaneZ &&
            minX <= expected.min[0] &&
            maxX >= expected.max[0]
          );
        case 'south':
          return (
            wall.wall.axis === 'x' &&
            wall.wall.plane === maxPlaneZ &&
            minX <= expected.min[0] &&
            maxX >= expected.max[0]
          );
        case 'west':
          return (
            wall.wall.axis === 'z' &&
            wall.wall.plane === minPlaneX &&
            minZ <= expected.min[2] &&
            maxZ >= expected.max[2]
          );
        case 'east':
          return (
            wall.wall.axis === 'z' &&
            wall.wall.plane === maxPlaneX &&
            minZ <= expected.min[2] &&
            maxZ >= expected.max[2]
          );
      }
    });
  const missing = (['north', 'east', 'south', 'west'] as const).filter((side) => !covers(side));
  return { applicable: true, missing };
}

function evaluateWall(expected: ExpectedWall, actualWalls: readonly WallObject[]): DiffItem {
  if (expected.unverifiedReason !== null) return unverifiedExpected(expected);
  if (actualWalls.length === 0) return missingExpected(expected);
  const union = unionBounds(actualWalls);
  const delta: Record<string, DiffDeltaEntry> = {};
  if (!boundsEqual(expected.bounds, union)) delta['bounds'] = boundsDelta(expected.bounds, union);
  const coverage = wallSideCoverage(actualWalls, expected.bounds);
  if (coverage.applicable && coverage.missing.length > 0) {
    delta['coverage'] = {
      expected: 'all four envelope sides',
      actual: `missing ${coverage.missing.join(',')}`,
      delta: null,
    };
  }
  const confidence = worstConfidence(actualWalls);
  const evidence = [
    `${String(actualWalls.length)} actual wall panel(s) aggregated as one envelope`,
    coverage.applicable ? 'four-side coverage checked' : 'four-side coverage skipped: non-envelope wall layout',
  ];
  const actual = {
    id: 'wall-union',
    kind: 'wall',
    bounds: boundsOfTuple(union),
    confidence,
    panelCount: actualWalls.length,
    panelIds: actualWalls.map((wall) => wall.id).sort(compareText),
  };
  if (confidence === 'low') {
    return makeItem({
      id: `expected:${expected.id}`,
      kind: 'wall',
      expectedId: expected.id,
      actualId: 'wall-union',
      status: 'unverified',
      severity: 'hard',
      expected: expectedSnapshot(expected),
      actual,
      delta,
      evidence,
      reason: 'actual wall envelope contains low-confidence panels',
    });
  }
  const mismatch = Object.keys(delta).sort(compareText);
  return makeItem({
    id: `expected:${expected.id}`,
    kind: 'wall',
    expectedId: expected.id,
    actualId: 'wall-union',
    status: mismatch.length === 0 ? 'pass' : 'fail',
    severity: 'hard',
    expected: expectedSnapshot(expected),
    actual,
    delta,
    evidence,
    reason: mismatch.length === 0 ? null : `wall mismatch: ${mismatch.join(', ')}`,
  });
}

function evaluateSlab(expected: ExpectedSlab, actualSlabs: readonly SlabObject[]): DiffItem {
  if (expected.unverifiedReason !== null) return unverifiedExpected(expected);
  if (actualSlabs.length === 0) return missingExpected(expected);
  const union = unionBounds(actualSlabs);
  const delta: Record<string, DiffDeltaEntry> = {};
  if (!boundsEqual(expected.bounds, union)) delta['bounds'] = boundsDelta(expected.bounds, union);
  const confidence = worstConfidence(actualSlabs);
  const evidence = [`${String(actualSlabs.length)} actual slab object(s) aggregated as one envelope`];
  const actual = {
    id: 'slab-union',
    kind: 'slab',
    bounds: boundsOfTuple(union),
    confidence,
    objectCount: actualSlabs.length,
    objectIds: actualSlabs.map((slab) => slab.id).sort(compareText),
  };
  if (confidence === 'low') {
    return makeItem({
      id: `expected:${expected.id}`,
      kind: 'slab',
      expectedId: expected.id,
      actualId: 'slab-union',
      status: 'unverified',
      severity: 'hard',
      expected: expectedSnapshot(expected),
      actual,
      delta,
      evidence,
      reason: 'actual slab envelope contains low-confidence objects',
    });
  }
  const mismatch = Object.keys(delta).sort(compareText);
  return makeItem({
    id: `expected:${expected.id}`,
    kind: 'slab',
    expectedId: expected.id,
    actualId: 'slab-union',
    status: mismatch.length === 0 ? 'pass' : 'fail',
    severity: 'hard',
    expected: expectedSnapshot(expected),
    actual,
    delta,
    evidence,
    reason: mismatch.length === 0 ? null : `slab mismatch: ${mismatch.join(', ')}`,
  });
}

function roofFormPass(expected: ExpectedRoofForm, actual: RoofObject['roof']['formHint']): boolean | null {
  if (actual === 'stepped') return false;
  if (actual === 'complex' || actual === 'unknown') return null;
  if (expected === 'flat') return actual === 'flat';
  if (actual === 'flat') return false;
  return true;
}

function largestRoof(roofs: readonly RoofObject[]): RoofObject | null {
  const ordered = [...roofs].sort((a, b) => {
    const areaA = (a.bounds.max[0] - a.bounds.min[0]) * (a.bounds.max[2] - a.bounds.min[2]);
    const areaB = (b.bounds.max[0] - b.bounds.min[0]) * (b.bounds.max[2] - b.bounds.min[2]);
    if (areaA !== areaB) return areaB - areaA;
    if (a.cells !== b.cells) return b.cells - a.cells;
    return compareText(a.id, b.id);
  });
  return ordered[0] ?? null;
}

function evaluateRoof(expected: ExpectedRoof, roofs: readonly RoofObject[]): DiffItem {
  if (expected.unverifiedReason !== null) return unverifiedExpected(expected);
  if (roofs.length === 0) return missingExpected(expected);
  const roof = largestRoof(roofs);
  if (roof === null) return missingExpected(expected);
  const delta: Record<string, DiffDeltaEntry> = {};
  if (!boundsEqual(expected.bounds, roof.bounds)) delta['bounds'] = boundsDelta(expected.bounds, roof.bounds);
  const formPass = roofFormPass(expected.form, roof.roof.formHint);
  if (formPass !== true) {
    delta['form'] = { expected: expected.form, actual: roof.roof.formHint, delta: null };
  }
  if (roof.roof.pitchDegrees === null) {
    delta['pitchDegrees'] = { expected: expected.pitchDegrees, actual: null, delta: null };
  } else if (Math.abs(roof.roof.pitchDegrees - expected.pitchDegrees) > 2) {
    delta['pitchDegrees'] = numberDelta(expected.pitchDegrees, roof.roof.pitchDegrees);
  }
  if (roof.roof.eaveY !== expected.eaveY) {
    delta['eaveY'] = numberDelta(expected.eaveY, roof.roof.eaveY);
  }
  if (roof.roof.ridgeY !== expected.ridgeY) {
    delta['ridgeY'] = numberDelta(expected.ridgeY, roof.roof.ridgeY);
  }
  const evidence = [`actual roof ${roof.id} selected as largest of ${String(roofs.length)}`];
  const actual = objectSnapshot(roof);
  if (roof.confidence === 'low') {
    return makeItem({
      id: `expected:${expected.id}`,
      kind: 'roof',
      expectedId: expected.id,
      actualId: roof.id,
      status: 'unverified',
      severity: 'hard',
      expected: expectedSnapshot(expected),
      actual,
      delta,
      evidence,
      reason: 'actual roof is low confidence',
    });
  }
  if (formPass === null || roof.roof.pitchDegrees === null) {
    return makeItem({
      id: `expected:${expected.id}`,
      kind: 'roof',
      expectedId: expected.id,
      actualId: roof.id,
      status: 'unverified',
      severity: 'hard',
      expected: expectedSnapshot(expected),
      actual,
      delta,
      evidence,
      reason: 'actual roof form or pitch cannot be measured reliably',
    });
  }
  const mismatch = Object.keys(delta).sort(compareText);
  return makeItem({
    id: `expected:${expected.id}`,
    kind: 'roof',
    expectedId: expected.id,
    actualId: roof.id,
    status: mismatch.length === 0 ? 'pass' : 'fail',
    severity: 'hard',
    expected: expectedSnapshot(expected),
    actual,
    delta,
    evidence,
    reason: mismatch.length === 0 ? null : `roof mismatch: ${mismatch.join(', ')}`,
  });
}

function openingFamily(subtype: OpeningObject['opening']['subtype']): ExpectedOpeningSubtype | null {
  if (subtype === 'window') return 'window';
  if (subtype === 'door' || subtype === 'passage') return 'door';
  return null;
}

function thinAxis(bounds: DiffBounds): 'x' | 'z' | null {
  const dx = bounds.max[0] - bounds.min[0];
  const dz = bounds.max[2] - bounds.min[2];
  if (dx === 1 && dz > 1) return 'x';
  if (dz === 1 && dx > 1) return 'z';
  return null;
}

function expectedOpeningAxis(expected: ExpectedOpening): 'x' | 'z' | null {
  if (expected.side === 'east' || expected.side === 'west') return 'x';
  return 'z';
}

function overlapVolume(a: DiffBounds, b: DiffBounds): number {
  const dx = Math.max(0, Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]));
  const dy = Math.max(0, Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]));
  const dz = Math.max(0, Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]));
  return dx * dy * dz;
}

function orientationMatches(expected: ExpectedOpening, actual: OpeningObject): boolean {
  const axis = expectedOpeningAxis(expected);
  const actualAxis = thinAxis(actual.bounds);
  return axis === null || actualAxis === null || axis === actualAxis;
}

function chooseOpeningCandidate(
  expected: ExpectedOpening,
  actuals: readonly OpeningObject[],
  claimed: ReadonlySet<string>,
): OpeningObject | null {
  const family = expected.subtype;
  const primary = actuals
    .filter((actual) => !claimed.has(actual.id))
    .filter((actual) => openingFamily(actual.opening.subtype) === family && orientationMatches(expected, actual))
    .sort(
      (a, b) =>
        overlapVolume(expected.bounds, b.bounds) - overlapVolume(expected.bounds, a.bounds) || compareText(a.id, b.id),
    );
  if (primary.length > 0) return primary[0] ?? null;
  const fallback = actuals
    .filter((actual) => !claimed.has(actual.id))
    .filter((actual) => actual.confidence === 'low' || actual.opening.subtype === 'unknown')
    .filter((actual) => orientationMatches(expected, actual))
    .filter((actual) => overlapVolume(expected.bounds, actual.bounds) > 0)
    .sort(
      (a, b) =>
        overlapVolume(expected.bounds, b.bounds) - overlapVolume(expected.bounds, a.bounds) || compareText(a.id, b.id),
    );
  return fallback[0] ?? null;
}

function openingFields(expected: ExpectedOpening, actual: OpeningObject): Record<string, DiffDeltaEntry> {
  const delta: Record<string, DiffDeltaEntry> = {};
  if (!boundsEqual(expected.bounds, actual.bounds)) delta['bounds'] = boundsDelta(expected.bounds, actual.bounds);
  if (expected.width !== actual.opening.widthCells)
    delta['width'] = numberDelta(expected.width, actual.opening.widthCells);
  if (expected.height !== actual.opening.heightCells)
    delta['height'] = numberDelta(expected.height, actual.opening.heightCells);
  if (expected.sillY !== actual.opening.sillY) delta['sillY'] = numberDelta(expected.sillY, actual.opening.sillY);
  if (expected.headY !== actual.opening.headY) delta['headY'] = numberDelta(expected.headY, actual.opening.headY);
  if (expected.subtype === 'window' && (actual.opening.fill !== 'glass' || actual.opening.voidCells !== 0)) {
    delta['fill'] = {
      expected: 'glass with no void cells',
      actual: `${actual.opening.fill} with ${String(actual.opening.voidCells)} void cell(s)`,
      delta: null,
    };
  }
  return delta;
}

function evaluateOpening(expected: ExpectedOpening, actual: OpeningObject): DiffItem {
  if (expected.unverifiedReason !== null) return unverifiedExpected(expected);
  const delta = openingFields(expected, actual);
  const lowConfidence = actual.confidence === 'low' || actual.opening.subtype === 'unknown';
  const evidence = [`actual opening ${actual.id} host=${actual.host ?? 'unknown'}`];
  const mismatch = Object.keys(delta).sort(compareText);
  if (lowConfidence) {
    return makeItem({
      id: `expected:${expected.id}`,
      kind: 'opening',
      expectedId: expected.id,
      actualId: actual.id,
      status: 'unverified',
      severity: 'hard',
      expected: expectedSnapshot(expected),
      actual: objectSnapshot(actual),
      delta,
      evidence,
      reason: `actual opening is ${actual.confidence} confidence with subtype ${actual.opening.subtype}; geometry is not trustworthy; delta is recorded but not promoted to fail`,
    });
  }
  return makeItem({
    id: `expected:${expected.id}`,
    kind: 'opening',
    expectedId: expected.id,
    actualId: actual.id,
    status: mismatch.length === 0 ? 'pass' : 'fail',
    severity: 'hard',
    expected: expectedSnapshot(expected),
    actual: objectSnapshot(actual),
    delta,
    evidence,
    reason: mismatch.length === 0 ? null : `opening mismatch: ${mismatch.join(', ')}`,
  });
}

function sameFootprint(a: DiffBounds, b: DiffBounds): boolean {
  return a.min[0] === b.min[0] && a.max[0] === b.max[0] && a.min[2] === b.min[2] && a.max[2] === b.max[2];
}

function boundsVolume(bounds: DiffBounds): number {
  return (bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1]) * (bounds.max[2] - bounds.min[2]);
}

/**
 * 家具匹配优先级：完全同 bounds > 同 x/z footprint（允许垂直偏移后比 bounds）>
 * 实际体量覆盖期望体量 >= 90%（允许深度/厚度多出后比 bounds）。不按 subtype 硬配，
 * 因为 as-built 的通用家具只到 other / light，几何仍应能对上。
 */
function furnitureMatchScore(expected: DiffBounds, actual: DiffBounds): number | null {
  if (boundsEqual(expected, actual)) return 3;
  if (sameFootprint(expected, actual)) return 2;
  const expectedVolume = boundsVolume(expected);
  if (expectedVolume > 0 && overlapVolume(expected, actual) / expectedVolume >= 0.9) return 1;
  return null;
}

function chooseFurnitureCandidate(
  expected: ExpectedFurniture,
  actuals: readonly FurnitureObject[],
  claimed: ReadonlySet<string>,
): FurnitureObject | null {
  let best: FurnitureObject | null = null;
  let bestScore = -1;
  for (const actual of actuals) {
    if (claimed.has(actual.id)) continue;
    const score = furnitureMatchScore(expected.bounds, actual.bounds);
    if (score === null) continue;
    if (score > bestScore || (score === bestScore && (best === null || compareText(actual.id, best.id) < 0))) {
      best = actual;
      bestScore = score;
    }
  }
  return best;
}

function dominantMaterialCells(object: FurnitureObject): number {
  let max = 0;
  for (const material of object.materials) {
    if (material.cells > max) max = material.cells;
  }
  return max;
}

function furnitureActualSnapshot(object: FurnitureObject): Readonly<Record<string, unknown>> {
  return {
    id: object.id,
    kind: 'furniture',
    bounds: boundsOfTuple(object.bounds),
    confidence: object.confidence,
    cells: object.cells,
    footprintCells: object.footprintCells,
    materials: object.materials,
    furniture: object.furniture,
  };
}

function furnitureFields(expected: ExpectedFurniture, actual: FurnitureObject): Record<string, DiffDeltaEntry> {
  const delta: Record<string, DiffDeltaEntry> = {};
  if (!boundsEqual(expected.bounds, actual.bounds)) {
    delta['bounds'] = boundsDelta(expected.bounds, actual.bounds);
  }
  if (expected.materialBlock !== null) {
    const dominantCells = dominantMaterialCells(actual);
    const requiredIsDominant = actual.materials.some(
      (material) => material.block === expected.materialBlock && material.cells === dominantCells && dominantCells > 0,
    );
    if (!requiredIsDominant) {
      delta['materialBlock'] = {
        expected: expected.materialBlock,
        actual: actual.materials.map((material) => material.block),
        delta: null,
      };
    }
  }
  if (expected.furnitureKind !== 'other' && actual.furniture.subtype !== expected.furnitureKind) {
    delta['furnitureKind'] = {
      expected: expected.furnitureKind,
      actual: actual.furniture.subtype,
      delta: null,
    };
  }
  if (expected.seatCapacity !== null) {
    const expectedSeats = expected.seatCapacity;
    const actualSeats = actual.furniture.seatCapacity;
    if (actualSeats !== expectedSeats) {
      delta['seatCapacity'] = {
        expected: expectedSeats,
        actual: actualSeats,
        delta: actualSeats === null ? null : actualSeats - expectedSeats,
      };
    }
  }
  return delta;
}

function evaluateFurniture(expected: ExpectedFurniture, actual: FurnitureObject): DiffItem {
  if (expected.unverifiedReason !== null) return unverifiedExpected(expected);
  const delta = furnitureFields(expected, actual);
  const evidence = [`actual furniture ${actual.id} subtype=${actual.furniture.subtype}`];
  if (actual.confidence === 'low') {
    return makeItem({
      id: `expected:${expected.id}`,
      kind: 'furniture',
      expectedId: expected.id,
      actualId: actual.id,
      status: 'unverified',
      severity: 'hard',
      expected: expectedSnapshot(expected),
      actual: furnitureActualSnapshot(actual),
      delta,
      evidence,
      reason: 'actual furniture is low confidence; geometry and material are not trustworthy',
    });
  }
  const mismatch = Object.keys(delta).sort(compareText);
  return makeItem({
    id: `expected:${expected.id}`,
    kind: 'furniture',
    expectedId: expected.id,
    actualId: actual.id,
    status: mismatch.length === 0 ? 'pass' : 'fail',
    severity: 'hard',
    expected: expectedSnapshot(expected),
    actual: furnitureActualSnapshot(actual),
    delta,
    evidence,
    reason: mismatch.length === 0 ? null : `furniture mismatch: ${mismatch.join(', ')}`,
  });
}

/**
 * 家具专项 diff：独立于 `diffObjects`，不进入 conformance-diff 主表。
 * - expected 无匹配 -> hard missing；bounds / 主材 / 座位数不符 -> hard fail；
 * - 多出的 actual furniture -> soft extra；actual 低 confidence -> hard unverified；
 * - 输出按 kind → expectedId → id 的全序排序，结果确定。
 */
export function diffFurnitureObjects(
  expected: readonly ExpectedFurniture[],
  actualInput: AsBuiltObjectGraph | readonly AsBuiltObject[],
): DiffItem[] {
  const actual = 'objects' in actualInput ? actualInput.objects : actualInput;
  const actualFurniture = [...actualObjectsOfKind(actual, 'furniture')].sort((a, b) => compareText(a.id, b.id));
  const expectedSorted = [...expected].sort((a, b) => compareText(a.id, b.id));
  const claimed = new Set<string>();
  const items: DiffItem[] = [];
  for (const object of expectedSorted) {
    if (object.unverifiedReason !== null) {
      items.push(unverifiedExpected(object));
      continue;
    }
    const candidate = chooseFurnitureCandidate(object, actualFurniture, claimed);
    if (candidate === null) {
      items.push(missingExpected(object));
      continue;
    }
    claimed.add(candidate.id);
    items.push(evaluateFurniture(object, candidate));
  }
  for (const object of actualFurniture) {
    if (claimed.has(object.id)) continue;
    items.push(actualExtra(object, 'actual furniture has no expected counterpart'));
  }
  items.sort(compareDiffItems);
  return items;
}

export function compareDiffItems(a: DiffItem, b: DiffItem): number {
  const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kind !== 0) return kind;
  const expected = compareText(a.expectedId ?? '~', b.expectedId ?? '~');
  if (expected !== 0) return expected;
  return compareText(a.id, b.id);
}

export function summarizeDiffItems(items: readonly DiffItem[]): DiffSummary {
  const counts = { pass: 0, fail: 0, missing: 0, extra: 0, unverified: 0 };
  let blockingCount = 0;
  for (const item of items) {
    counts[item.status] += 1;
    if (
      item.severity === 'hard' &&
      (item.status === 'fail' || item.status === 'missing' || item.status === 'unverified')
    ) {
      blockingCount += 1;
    }
  }
  return {
    ...counts,
    blockingCount,
    blocking: blockingCount > 0,
    fullyVerified: counts.fail === 0 && counts.missing === 0 && counts.extra === 0 && counts.unverified === 0,
  };
}

function actualObjectsOfKind<T extends AsBuiltObject['kind']>(
  objects: readonly AsBuiltObject[],
  kind: T,
): Extract<AsBuiltObject, { kind: T }>[] {
  return objects.filter((object): object is Extract<AsBuiltObject, { kind: T }> => object.kind === kind);
}

export function diffObjects(
  expected: readonly ExpectedObject[],
  actualInput: AsBuiltObjectGraph | readonly AsBuiltObject[],
  options: DiffOptions = {},
): DiffReport {
  const compareOpenings = options.compareOpenings ?? true;
  const actual = 'objects' in actualInput ? actualInput.objects : actualInput;
  const expectedSorted = [...expected].sort((a, b) => {
    const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return kind !== 0 ? kind : compareText(a.id, b.id);
  });
  const expectedKinds = new Set(expectedSorted.map((object) => object.kind));
  const walls = actualObjectsOfKind(actual, 'wall');
  const slabs = actualObjectsOfKind(actual, 'slab');
  const roofs = actualObjectsOfKind(actual, 'roof');
  const openings = actualObjectsOfKind(actual, 'opening');
  const items: DiffItem[] = [];
  const notes: string[] = [];
  const claimedOpenings = new Set<string>();
  let selectedRoof: RoofObject | null = null;

  for (const object of expectedSorted) {
    switch (object.kind) {
      case 'wall':
        items.push(evaluateWall(object, walls));
        break;
      case 'slab':
        items.push(evaluateSlab(object, slabs));
        break;
      case 'roof':
        items.push(evaluateRoof(object, roofs));
        selectedRoof = largestRoof(roofs);
        break;
      case 'opening': {
        if (!compareOpenings) break;
        const candidate = chooseOpeningCandidate(object, openings, claimedOpenings);
        if (candidate === null) {
          items.push(missingExpected(object));
        } else {
          claimedOpenings.add(candidate.id);
          const item = evaluateOpening(object, candidate);
          items.push(item);
          if (item.status === 'unverified' && candidate.confidence === 'low') {
            notes.push(
              `opening ${object.id} has only a low-confidence actual counterpart; its delta is recorded as unverified`,
            );
          }
        }
        break;
      }
    }
  }

  if (!expectedKinds.has('wall')) {
    for (const wall of walls) items.push(actualExtra(wall, 'actual wall has no expected wall envelope'));
  }
  if (!expectedKinds.has('slab')) {
    for (const slab of slabs) items.push(actualExtra(slab, 'actual slab has no expected slab envelope'));
  }
  if (!expectedKinds.has('roof')) {
    for (const roof of roofs) items.push(actualExtra(roof, 'actual roof has no expected roof'));
  } else {
    for (const roof of roofs) {
      if (roof.id === selectedRoof?.id) continue;
      items.push(actualExtra(roof, 'additional actual roof outside the expected roof envelope'));
    }
  }
  if (compareOpenings) {
    for (const opening of openings) {
      if (claimedOpenings.has(opening.id)) continue;
      if (opening.confidence === 'low' || opening.opening.subtype === 'unknown') {
        items.push(actualUnverified(opening, 'actual opening is low confidence and has no expected counterpart'));
      } else {
        items.push(actualExtra(opening, 'actual opening has no expected counterpart'));
      }
    }
  }
  for (const object of actual) {
    if (object.kind === 'unknown') {
      items.push(actualUnverified(object, `unrecognized actual object (${object.unknown.reason})`));
    }
  }

  items.sort(compareDiffItems);
  const siteIds = actualObjectsOfKind(actual, 'site')
    .map((object) => object.id)
    .sort(compareText);
  const furnitureIds = actualObjectsOfKind(actual, 'furniture')
    .map((object) => object.id)
    .sort(compareText);
  const unknownIds = actualObjectsOfKind(actual, 'unknown')
    .map((object) => object.id)
    .sort(compareText);
  const notCompared: NotComparedSummary = {
    site: siteIds.length,
    furniture: furnitureIds.length,
    unknown: unknownIds.length,
    total: siteIds.length + furnitureIds.length + unknownIds.length,
    ids: { site: siteIds, furniture: furnitureIds, unknown: unknownIds },
  };
  if (notCompared.total > 0) {
    notes.push('site / furniture / unknown are context only and did not participate in hard comparison');
  }
  const contextOpenings = compareOpenings
    ? []
    : openings.map((opening) => ({
        id: opening.id,
        bounds: boundsOfTuple(opening.bounds),
        confidence: opening.confidence,
        subtype: opening.opening.subtype,
        fill: opening.opening.fill,
      }));
  if (!compareOpenings && contextOpenings.length > 0) {
    notes.push(
      `object-graph opening comparison disabled; ${String(contextOpenings.length)} actual opening object(s) recorded as context only`,
    );
  }
  return {
    schemaVersion: 1,
    measurement: {
      unit: 'voxel-cell',
      boundsConvention: 'half-open [min,max)',
      positionToleranceCells: 0,
      pitchToleranceDegrees: 2,
    },
    items,
    summary: summarizeDiffItems(items),
    notCompared,
    context: { openings: contextOpenings },
    notes,
  };
}
