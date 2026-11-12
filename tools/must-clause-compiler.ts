/* eslint-disable max-lines -- 41 条 run-7 must 的显式拆分规则集中在同一张表；拆文件会让 clause id 与 check id 漂移。 */
/**
 * Must Clause Compiler：把 BuildSpec.musts 拆成可独立测量 / 可独立报告的 clause。
 *
 * 负责：按 must id 的显式规则拆分复合 must；从原文只提取明确写出的数字 / 形式 / 方位；
 * 把 must 目标与 BuildSpec 派生值并排记录，冲突时写 conflict，而不是静默通过。
 * 不负责：读文件、跑几何检查、调用模型或决定最终 met；本文件是确定性纯函数。
 */
import { boundsSize, selectEntranceOpening } from '@pg/interaction/schema';
import type { BuildSpec, BuildOpening } from '@pg/interaction/schema';

import type {
  ClauseCheck,
  ClauseConflict,
  ClauseTarget,
  JsonValue,
  MustClauseGroup,
  MustClauseKind,
  MustClausePlan,
  MustClausePlanFile,
} from '../packages/interaction/src/must-clause.ts';
import {
  MustClausePlanFile as MustClausePlanFileSchema,
  MUST_CLAUSE_PLAN_SCHEMA_VERSION,
  summarizeClausePlan,
} from '../packages/interaction/src/must-clause.ts';

export const MUST_CLAUSE_COMPILER_VERSION = 'must-clause-v1';

type Side = 'north' | 'east' | 'south' | 'west';
type Must = BuildSpec['musts'][number];
type WallElement = BuildSpec['elements'][number];
type FurnitureSpec = BuildSpec['interiors'][number]['furnitureSpecs'][number];

const SIDES: readonly Side[] = ['north', 'east', 'south', 'west'];

interface LeafOptions {
  readonly kind: MustClauseKind;
  readonly suffix: string;
  readonly target?: ClauseTarget | null;
  readonly check: ClauseCheck;
  readonly specTarget?: JsonValue;
  readonly conflict?: ClauseConflict | null;
  readonly waiverable?: boolean;
  readonly reason?: string;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function target(
  metric: string,
  value: JsonValue,
  unit: string | null = null,
  relation: string | null = null,
): ClauseTarget {
  return { metric, value, unit, relation };
}

function check(
  kind: ClauseCheck['kind'],
  id: string,
  objectRefs: readonly string[] = [],
  params: Readonly<Record<string, string | number | boolean | null>> = {},
): ClauseCheck {
  return { kind, id: clip(id, 160), objectRefs: objectRefs.map((ref) => clip(ref, 160)), params: { ...params } };
}

function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function reconcile(
  mustValue: JsonValue,
  specValue: JsonValue | undefined,
  message: string,
): Pick<LeafOptions, 'specTarget' | 'conflict'> {
  if (specValue === undefined) return { specTarget: null, conflict: null };
  if (jsonEqual(mustValue, specValue)) return { specTarget: specValue, conflict: null };
  return {
    specTarget: specValue,
    conflict: {
      mustTarget: mustValue,
      specTarget: specValue,
      message: clip(message, 400),
    },
  };
}

function leaf(must: Must, options: LeafOptions): MustClausePlan {
  const resolved = options.target ?? null;
  const conflict = options.conflict ?? null;
  return {
    schemaVersion: MUST_CLAUSE_PLAN_SCHEMA_VERSION,
    clauseId: clip(`${must.id}#${options.suffix}`, 160),
    mustId: must.id,
    parentMustId: must.id,
    text: must.text,
    kind: options.kind,
    target: resolved,
    check: options.check,
    specTarget: options.specTarget ?? null,
    conflict,
    waiverable:
      options.waiverable ?? (conflict === null && (resolved === null || options.check.kind === 'qualitative')),
    reason: options.reason ?? null,
  };
}

function qualitativeLeaf(must: Must, suffix: string, kind: MustClauseKind, reason: string): MustClausePlan {
  return leaf(must, {
    kind,
    suffix,
    target: null,
    check: check('qualitative', `check:qualitative:${must.id}:${suffix}`, [], { metric: 'qualitative' }),
    reason,
  });
}

function reportLeaf(must: Must, suffix: string, objectRefs: readonly string[]): MustClausePlan {
  const expectedId = objectRefs.length === 1 ? (objectRefs[0] ?? 'missing') : clip(`report:${must.id}#${suffix}`, 160);
  const checkId = objectRefs.length === 1 ? `report:${objectRefs[0] ?? 'missing'}` : `report:${must.id}#${suffix}`;
  return leaf(must, {
    kind: 'kind',
    suffix,
    target: target('hardFail', false),
    check: check('report', checkId, objectRefs, { metric: 'hardFail', expectedId }),
  });
}

function absenceLeaf(must: Must, suffix: string, rule: string): MustClausePlan {
  const checkId = `check:absence:${rule}`;
  return leaf(must, {
    kind: 'absence',
    suffix,
    target: target('count', 0, 'count'),
    check: check('coverage', checkId, [], { checkId, field: 'count', expectedId: rule }),
  });
}

function group(must: Must, leaves: readonly MustClausePlan[]): MustClauseGroup {
  if (leaves.length === 0) throw new Error(`must ${must.id} 没有生成任何 clause`);
  if (leaves.length > 100) throw new Error(`must ${must.id} 的 clause 超过 100 条`);
  return { mustId: must.id, text: must.text, leaves: [...leaves] };
}

function dimensionPair(text: string): { readonly width: number; readonly depth: number } | null {
  const match = /(\d+(?:\.\d+)?)\s*m\s*[×xX]\s*(\d+(?:\.\d+)?)\s*m/u.exec(text);
  if (match === null) return null;
  return { width: Number(match[1]), depth: Number(match[2]) };
}

function areaOfText(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:㎡|m²|平方米)/u.exec(text);
  return match === null ? null : Number(match[1]);
}

function wallThicknessOfText(text: string): number | null {
  const match = /(?:外墙厚(?:度)?|墙厚)\s*(\d+(?:\.\d+)?)\s*m/u.exec(text);
  return match === null ? null : Number(match[1]);
}

function hasThicknessTail(text: string): boolean {
  const match = /(?:外墙厚(?:度)?|墙厚)\s*(\d+(?:\.\d+)?)\s*m/u.exec(text);
  if (match === null) return false;
  const rest = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`;
  return rest.replace(/[\s。．.,，、;；:：!！?？"'“”‘’()（）[\]【】-]/gu, '').length > 0;
}

function doorWidthOfText(text: string): number | null {
  const first = /(?:门洞|门)?净宽\s*(\d+(?:\.\d+)?)\s*m/u.exec(text)?.[1];
  if (first !== undefined) return Number(first);
  const second = /(?:门宽|门洞宽)\s*(\d+(?:\.\d+)?)\s*m/u.exec(text)?.[1];
  return second === undefined ? null : Number(second);
}

function doorClearOfText(text: string): number | null {
  const first = /(?:门内侧保留|门内留出|门内进深)\s*(\d+(?:\.\d+)?)\s*m/u.exec(text)?.[1];
  if (first !== undefined) return Number(first);
  const second = /(\d+(?:\.\d+)?)\s*m\s*宽(?:的)?净空/u.exec(text)?.[1];
  return second === undefined ? null : Number(second);
}

function windowWidthOfText(text: string): number | null {
  const first = /(\d+(?:\.\d+)?)\s*m\s*(?:宽|大窗)/u.exec(text)?.[1];
  if (first !== undefined) return Number(first);
  const second = /(?:宽|宽度)\s*(\d+(?:\.\d+)?)\s*m/u.exec(text)?.[1];
  return second === undefined ? null : Number(second);
}

function sillOfText(text: string): number | null {
  const match = /(?:窗台高?|台高)\s*(\d+(?:\.\d+)?)\s*m/u.exec(text);
  return match === null ? null : Number(match[1]);
}

function windowHeightOfText(text: string): number | null {
  const match = /(?:窗高|洞口高)\s*(\d+(?:\.\d+)?)\s*m/u.exec(text);
  return match === null ? null : Number(match[1]);
}

function headOfText(text: string): number | null {
  const match = /(?:洞口顶|洞顶)[^\d]{0,24}(\d+(?:\.\d+)?)\s*m/u.exec(text);
  return match === null ? null : Number(match[1]);
}

function furnitureDimsOfText(text: string): { readonly length: number; readonly depth: number } | null {
  const match = /(\d+(?:\.\d+)?)\s*m\s*长[、,，]\s*(\d+(?:\.\d+)?)\s*m\s*(?:宽|深)/u.exec(text);
  if (match === null) return null;
  return { length: Number(match[1]), depth: Number(match[2]) };
}

function furnitureAxisOfText(text: string): 'x' | 'z' | null {
  if (/(?:长边|长度方向)?[^。；;]{0,8}东西向/u.test(text)) return 'x';
  if (/(?:长边|长度方向)?[^。；;]{0,8}南北向/u.test(text)) return 'z';
  return null;
}

function seatPairOfText(text: string): readonly [number, number] | null {
  const match = /(\d+)\s*\+\s*(\d+)/u.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

function seatCountOfText(text: string): number | null {
  const pair = seatPairOfText(text);
  if (pair !== null) return pair[0] + pair[1];
  const match = /(\d+)\s*座/u.exec(text);
  return match === null ? null : Number(match[1]);
}

function budgetOfText(text: string): number | null {
  for (const pattern of [/整体预算\s*(\d+)\s*方块/u, /(?:总量|用量)?不超过\s*(\d+)\s*方块/u]) {
    const match = pattern.exec(text);
    if (match !== null) return Number(match[1]);
  }
  return null;
}

function roofFormOfText(text: string): string | null {
  if (text.includes('双坡')) return 'gable';
  if (text.includes('单坡')) return 'shed';
  if (text.includes('四坡')) return 'hip';
  if (text.includes('平屋面')) return 'flat';
  if (text.includes('反坡')) return 'butterfly';
  if (text.includes('曲面')) return 'curved';
  return null;
}

function isSeatMust(id: string, text: string): boolean {
  if (!/(^|[-_])seats?(?:[-_]|$)/i.test(id)) return false;
  // “10 座饮茶空间”是 program，不是座位条款；必须有就座 / 座位 / 长凳语义。
  return /(就座|座位|长凳|坐凳|凳)/u.test(text) && /\d+\s*座/u.test(text);
}

function isNegativeId(id: string): boolean {
  return /(^|[-_])no(?:[-_]|$)/i.test(id) || /(^|[-_])forbid(?:[-_]|$)/i.test(id);
}

function negatesTarget(text: string, terms: readonly string[]): boolean {
  for (const match of text.matchAll(/(?:不设|不做|不要|不放|不得|禁止|不摆|不提供|无|没有)/gu)) {
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 12);
    if (terms.some((term) => after.includes(term))) return true;
  }
  return false;
}

const NEGATIVE_TARGET_TERMS = ['窗', '门', '桌', '凳', '柜台', '座', '屋面', '灯', '柱'] as const;

function level(spec: BuildSpec): BuildSpec['levels'][number] {
  const found = [...spec.levels].sort((a, b) => a.elevation - b.elevation)[0];
  if (found === undefined) throw new Error('BuildSpec.levels is empty');
  return found;
}

interface BoundaryWalls {
  readonly north: WallElement | null;
  readonly south: WallElement | null;
  readonly east: WallElement | null;
  readonly west: WallElement | null;
  readonly thickness: Readonly<Record<Side, number | null>>;
}

function thicknessOnSide(wall: WallElement, side: Side): number {
  return side === 'north' || side === 'south'
    ? wall.bounds.max[2] - wall.bounds.min[2]
    : wall.bounds.max[0] - wall.bounds.min[0];
}

function boundaryWalls(spec: BuildSpec): BoundaryWalls {
  const b = spec.bounds;
  const candidates: Record<Side, WallElement[]> = { north: [], south: [], east: [], west: [] };
  for (const element of spec.elements) {
    if (element.kind !== 'wall') continue;
    const dx = element.bounds.max[0] - element.bounds.min[0];
    const dz = element.bounds.max[2] - element.bounds.min[2];
    if (dx > dz && element.bounds.min[2] === b.min[2]) candidates.north.push(element);
    if (dx > dz && element.bounds.max[2] === b.max[2]) candidates.south.push(element);
    if (dz > dx && element.bounds.min[0] === b.min[0]) candidates.west.push(element);
    if (dz > dx && element.bounds.max[0] === b.max[0]) candidates.east.push(element);
  }
  const pick = (side: Side): WallElement | null => {
    const ordered = [...candidates[side]].sort(
      (a, b2) => thicknessOnSide(b2, side) - thicknessOnSide(a, side) || (a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0),
    );
    return ordered[0] ?? null;
  };
  const north = pick('north');
  const south = pick('south');
  const east = pick('east');
  const west = pick('west');
  return {
    north,
    south,
    east,
    west,
    thickness: {
      north: north === null ? null : thicknessOnSide(north, 'north'),
      south: south === null ? null : thicknessOnSide(south, 'south'),
      east: east === null ? null : thicknessOnSide(east, 'east'),
      west: west === null ? null : thicknessOnSide(west, 'west'),
    },
  };
}

function wallThicknessValue(spec: BuildSpec): number | undefined {
  const walls = boundaryWalls(spec);
  const values = SIDES.map((side) => walls.thickness[side]).filter((value): value is number => value !== null);
  return values.length === 0 ? undefined : Math.max(...values);
}

function interiorClear(
  spec: BuildSpec,
): { readonly width: number; readonly depth: number; readonly area: number } | null {
  const walls = boundaryWalls(spec);
  const values = SIDES.map((side) => walls.thickness[side]);
  if (values.some((value) => value === null)) return null;
  const [width, , depth] = boundsSize(spec.bounds);
  const clearWidth = width - (walls.thickness.west ?? 0) - (walls.thickness.east ?? 0);
  const clearDepth = depth - (walls.thickness.north ?? 0) - (walls.thickness.south ?? 0);
  return { width: clearWidth, depth: clearDepth, area: clearWidth * clearDepth };
}

function furniture(spec: BuildSpec): readonly FurnitureSpec[] {
  return spec.interiors.flatMap((interior) => interior.furnitureSpecs);
}

function furnitureOfKind(spec: BuildSpec, kind: string): FurnitureSpec | undefined {
  return furniture(spec).find((item) => item.kind === kind);
}

function furnitureDims(item: FurnitureSpec): { readonly length: number; readonly depth: number } {
  const dx = item.bounds.max[0] - item.bounds.min[0];
  const dz = item.bounds.max[2] - item.bounds.min[2];
  return { length: Math.max(dx, dz), depth: Math.min(dx, dz) };
}

function furnitureCenter(item: FurnitureSpec): { readonly x: number; readonly z: number } {
  return {
    x: (item.bounds.min[0] + item.bounds.max[0]) / 2,
    z: (item.bounds.min[2] + item.bounds.max[2]) / 2,
  };
}

function seatCapacity(item: FurnitureSpec): number {
  const span = Math.max(item.bounds.max[0] - item.bounds.min[0], item.bounds.max[2] - item.bounds.min[2]);
  return Math.max(0, Math.floor((span * 10) / 8));
}

function entranceDoor(spec: BuildSpec): BuildOpening | undefined {
  return selectEntranceOpening(spec);
}

function southWindow(spec: BuildSpec, requireSouth = false): BuildOpening | undefined {
  return (
    spec.openings.find((opening) => opening.kind === 'window' && opening.side === 'south') ??
    (requireSouth ? undefined : spec.openings.find((opening) => opening.kind === 'window'))
  );
}

function targetFromSpec(
  must: Must,
  suffix: string,
  kind: MustClauseKind,
  metric: string,
  mustValue: number | string,
  specValue: number | string | undefined,
  unit: string | null,
  message: string,
  checkValue: ClauseCheck,
): MustClausePlan {
  return leaf(must, {
    kind,
    suffix,
    target: target(metric, mustValue, unit),
    check: checkValue,
    ...reconcile(mustValue, specValue, message),
  });
}

function envelopeLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const [width, , depth] = boundsSize(spec.bounds);
  const parsed = dimensionPair(must.text);
  const targetWidth = parsed?.width ?? width;
  const targetDepth = parsed?.depth ?? depth;
  const firstLevel = level(spec);
  const checkId = `check:envelope:${firstLevel.id}`;
  // ClauseCheck.objectRefs 上限 50；超出的多 level 不能静默截断后声称覆盖全部。
  const wallRefs = spec.levels.slice(0, 50).map((item) => `wall:${item.id}`);
  const leaves: MustClausePlan[] = [
    targetFromSpec(
      must,
      'envelope-width',
      'dimension',
      'width',
      targetWidth,
      width,
      'm',
      `外轮廓宽度 must=${String(targetWidth)}m，spec=${String(width)}m`,
      check('envelope', checkId, wallRefs, {
        checkId,
        field: 'width',
        expectedId: `wall:${firstLevel.id}`,
      }),
    ),
    targetFromSpec(
      must,
      'envelope-depth',
      'dimension',
      'depth',
      targetDepth,
      depth,
      'm',
      `外轮廓深度 must=${String(targetDepth)}m，spec=${String(depth)}m`,
      check('envelope', checkId, wallRefs, {
        checkId,
        field: 'depth',
        expectedId: `wall:${firstLevel.id}`,
      }),
    ),
    reportLeaf(must, 'report-wall', wallRefs),
  ];
  if (spec.levels.length > 50) {
    leaves.push(
      qualitativeLeaf(
        must,
        'levels-over-50',
        'qualitative',
        '超过 50 个 level 的 wall refs 无法进入 clause，保持 unverified',
      ),
    );
  }
  return leaves;
}

function storeyLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const firstLevel = level(spec);
  const checkId = `check:storey:${firstLevel.id}`;
  return [
    targetFromSpec(
      must,
      'storey-levels',
      'count',
      'count',
      1,
      spec.levels.length,
      'count',
      `单层 must=1，spec.levels=${String(spec.levels.length)}`,
      check('coverage', checkId, [`slab:${firstLevel.id}`], {
        checkId,
        field: 'levels',
        expectedId: `slab:${firstLevel.id}`,
      }),
    ),
    // 专用检查已排除檐口以上的屋面 *_stairs 方块，只把室内楼梯 / 负标高地下室判 fail。
    absenceLeaf(must, 'absence-stairs-basement', 'stairs-basement'),
  ];
}

function clearLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const firstLevel = level(spec);
  const derived = interiorClear(spec);
  const parsed = dimensionPair(must.text);
  const targetWidth = parsed?.width ?? derived?.width;
  const targetDepth = parsed?.depth ?? derived?.depth;
  const targetArea =
    areaOfText(must.text) ??
    (targetWidth === undefined || targetDepth === undefined ? undefined : targetWidth * targetDepth);
  const checkId = `check:clear:${firstLevel.id}`;
  const expectedId = `slab:${firstLevel.id}`;
  const leaves: MustClausePlan[] = [];
  if (targetWidth !== undefined) {
    leaves.push(
      targetFromSpec(
        must,
        'clear-width',
        'dimension',
        'width',
        targetWidth,
        derived?.width,
        'm',
        `室内净宽 must=${String(targetWidth)}m，spec=${String(derived?.width)}m`,
        check('coverage', checkId, [expectedId], { checkId, field: 'width', expectedId }),
      ),
    );
  }
  if (targetDepth !== undefined) {
    leaves.push(
      targetFromSpec(
        must,
        'clear-depth',
        'dimension',
        'depth',
        targetDepth,
        derived?.depth,
        'm',
        `室内净深 must=${String(targetDepth)}m，spec=${String(derived?.depth)}m`,
        check('coverage', checkId, [expectedId], { checkId, field: 'depth', expectedId }),
      ),
    );
  }
  if (targetArea !== undefined) {
    leaves.push(
      targetFromSpec(
        must,
        'clear-area',
        'dimension',
        'area',
        targetArea,
        derived?.area,
        'm²',
        `室内净面积 must=${String(targetArea)}m²，spec=${String(derived?.area)}m²`,
        check('coverage', checkId, [expectedId], { checkId, field: 'area', expectedId }),
      ),
    );
  }
  return leaves;
}

function wallThicknessTailSuffix(text: string): string {
  return /门厅|隔间|玄关/u.test(text) ? 'no-foyer-tail' : 'qualitative-tail';
}

function wallThicknessLeaves(
  spec: BuildSpec,
  must: Must,
  includeTail: boolean,
  tailSuffix = wallThicknessTailSuffix(must.text),
): readonly MustClausePlan[] {
  const firstLevel = level(spec);
  const checkId = `check:thickness:${firstLevel.id}`;
  const parsed = wallThicknessOfText(must.text);
  const specValue = wallThicknessValue(spec);
  const targetThickness = parsed ?? specValue;
  const leaves: MustClausePlan[] = [];
  if (targetThickness !== undefined) {
    leaves.push(
      targetFromSpec(
        must,
        'thickness',
        'dimension',
        'thickness',
        targetThickness,
        specValue,
        'm',
        `外墙厚度 must=${String(targetThickness)}m，spec=${String(specValue)}m`,
        check('coverage', checkId, [`wall:${firstLevel.id}`], {
          checkId,
          field: 'thickness',
          expectedId: `wall:${firstLevel.id}`,
        }),
      ),
    );
  } else {
    leaves.push(qualitativeLeaf(must, 'thickness-unknown', 'dimension', 'must / spec 都没有可提取的外墙厚度'));
  }
  if (includeTail) {
    leaves.push(
      qualitativeLeaf(
        must,
        tailSuffix,
        'qualitative',
        tailSuffix === 'no-foyer-tail'
          ? '深墙洞口不得产生门厅或隔间；tail 无法由几何检查直接证明'
          : 'must 的定性尾句无法由几何检查证明',
      ),
    );
  }
  return leaves;
}

function doorWidthLeaf(spec: BuildSpec, must: Must): MustClausePlan {
  const door = entranceDoor(spec);
  const parsed = doorWidthOfText(must.text);
  const targetWidth = parsed ?? door?.width;
  const checkId = door === undefined ? 'check:opening:missing' : `check:opening:${door.id}`;
  return targetFromSpec(
    must,
    'door-width',
    'dimension',
    'width',
    targetWidth ?? 0,
    door?.width,
    'm',
    `门洞净宽 must=${String(targetWidth)}m，spec=${String(door?.width)}m`,
    check('opening', checkId, door === undefined ? [] : [`opening:${door.id}`], {
      expectedId: door?.id ?? 'missing',
      metric: 'width',
    }),
  );
}

function doorReportLeaf(must: Must, door: BuildOpening | undefined): MustClausePlan {
  return reportLeaf(must, 'report-opening', door === undefined ? ['opening:missing'] : [`opening:${door.id}`]);
}

function doorLocationLeaves(spec: BuildSpec, must: Must, includeFoyerTail: boolean): readonly MustClausePlan[] {
  const door = entranceDoor(spec);
  const width = doorWidthLeaf(spec, must);
  const checkId = door === undefined ? 'check:door-position:missing' : `check:door-position:${door.id}`;
  const midX = (spec.bounds.min[0] + spec.bounds.max[0]) / 2;
  const centerX = door === undefined ? undefined : (door.bounds.min[0] + door.bounds.max[0]) / 2;
  const actualPosition = centerX === undefined ? undefined : centerX < midX ? 'west-of-center' : 'east-of-center';
  const sideLeaf = leaf(must, {
    kind: 'relation',
    suffix: 'door-side',
    target: target('side', 'north'),
    check: check('opening', checkId, door === undefined ? [] : [`opening:${door.id}`], {
      expectedId: door?.id ?? 'missing',
      metric: 'side',
      side: 'north',
    }),
    ...reconcile('north', door?.side, `门洞方位 must=north，spec=${String(door?.side)}`),
  });
  const positionLeaf = leaf(must, {
    kind: 'relation',
    suffix: 'door-west-of-center',
    target: target('centerX', 'west-of-center'),
    check: check('opening', checkId, door === undefined ? [] : [`opening:${door.id}`], {
      expectedId: door?.id ?? 'missing',
      metric: 'centerX',
      centerX: centerX ?? 0,
      midX,
      expected: 'west-of-center',
    }),
    ...reconcile('west-of-center', actualPosition, `门洞位置 must=west-of-center，spec=${String(actualPosition)}`),
  });
  const leaves = [width, sideLeaf, positionLeaf, doorReportLeaf(must, door)];
  if (includeFoyerTail) {
    leaves.push(qualitativeLeaf(must, 'no-foyer-tail', 'program', '门内不设玄关或门厅；该尾句没有专用几何检查'));
  }
  return leaves;
}

function doorNorthWestLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  return doorLocationLeaves(spec, must, true);
}

function doorClearLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const door = entranceDoor(spec);
  const parsed = doorClearOfText(must.text);
  const checkId = door === undefined ? 'check:door-clear:missing' : `check:door-clear:${door.id}`;
  return [
    leaf(must, {
      kind: 'dimension',
      suffix: 'door-clear',
      target: target('door-clear', parsed ?? 1, 'm'),
      check: check('coverage', checkId, door === undefined ? [] : [`opening:${door.id}`], {
        checkId,
        field: 'width',
        expectedId: door?.id ?? 'missing',
      }),
      specTarget: null,
    }),
  ];
}

function windowWidthLeaf(must: Must, window: BuildOpening | undefined): MustClausePlan {
  const parsed = windowWidthOfText(must.text);
  const targetWidth = parsed ?? window?.width;
  const checkId = window === undefined ? 'check:opening:missing-window' : `check:opening:${window.id}`;
  return targetFromSpec(
    must,
    'window-width',
    'dimension',
    'width',
    targetWidth ?? 0,
    window?.width,
    'm',
    `窗宽 must=${String(targetWidth)}m，spec=${String(window?.width)}m`,
    check('opening', checkId, window === undefined ? [] : [`opening:${window.id}`], {
      expectedId: window?.id ?? 'missing',
      metric: 'width',
    }),
  );
}

function windowReportLeaf(must: Must, window: BuildOpening | undefined): MustClausePlan {
  return reportLeaf(must, 'report-opening', window === undefined ? ['opening:missing'] : [`opening:${window.id}`]);
}

function windowDimLeaves(
  spec: BuildSpec,
  must: Must,
  includeWidth: boolean,
  includeOnlySouth = false,
  requireSouth = false,
  includeSide = false,
): readonly MustClausePlan[] {
  const window = southWindow(spec, requireSouth);
  const parsedSill = sillOfText(must.text);
  const parsedHeight = windowHeightOfText(must.text);
  const parsedHead = headOfText(must.text);
  const sill = parsedSill ?? window?.sillHeight;
  const height = parsedHeight ?? window?.height;
  const head = parsedHead ?? (sill !== undefined && height !== undefined ? sill + height : window?.headHeight);
  const checkId = window === undefined ? 'check:opening:missing-window' : `check:opening:${window.id}`;
  const leaves: MustClausePlan[] = [];
  if (includeSide) {
    const targetSide = must.text.includes('北')
      ? 'north'
      : must.text.includes('南')
        ? 'south'
        : (window?.side ?? 'south');
    leaves.push(
      leaf(must, {
        kind: 'relation',
        suffix: 'window-side',
        target: target('side', targetSide),
        check: check('opening', checkId, window === undefined ? [] : [`opening:${window.id}`], {
          expectedId: window?.id ?? 'missing',
          metric: 'side',
          side: targetSide,
        }),
        ...reconcile(targetSide, window?.side, `窗洞方位 must=${targetSide}，spec=${String(window?.side)}`),
      }),
    );
  }
  if (includeWidth) leaves.push(windowWidthLeaf(must, window));
  if (sill !== undefined) {
    leaves.push(
      targetFromSpec(
        must,
        'window-sill',
        'dimension',
        'sill',
        sill,
        window?.sillHeight,
        'm',
        `窗台高 must=${String(sill)}m，spec=${String(window?.sillHeight)}m`,
        check('opening', checkId, window === undefined ? [] : [`opening:${window.id}`], {
          expectedId: window?.id ?? 'missing',
          metric: 'sill',
        }),
      ),
    );
  }
  if (height !== undefined) {
    leaves.push(
      targetFromSpec(
        must,
        'window-height',
        'dimension',
        'height',
        height,
        window?.height,
        'm',
        `窗高 must=${String(height)}m，spec=${String(window?.height)}m`,
        check('opening', checkId, window === undefined ? [] : [`opening:${window.id}`], {
          expectedId: window?.id ?? 'missing',
          metric: 'height',
        }),
      ),
    );
  }
  if (head !== undefined) {
    leaves.push(
      targetFromSpec(
        must,
        'window-head',
        'dimension',
        'head',
        head,
        window?.headHeight,
        'm',
        `洞口顶 must=${String(head)}m，spec=${String(window?.headHeight)}m`,
        check('opening', checkId, window === undefined ? [] : [`opening:${window.id}`], {
          expectedId: window?.id ?? 'missing',
          metric: 'head',
        }),
      ),
    );
  }
  if (includeOnlySouth) {
    const southCount = spec.openings.filter((opening) => opening.side === 'south').length;
    leaves.push(
      leaf(must, {
        kind: 'count',
        suffix: 'only-south-opening',
        target: target('onlyOnSide', 1, 'count'),
        check: check('opening', 'check:schedule:south', window === undefined ? [] : [`opening:${window.id}`], {
          checkId: 'check:schedule:south',
          expectedId: window?.id ?? 'missing',
          metric: 'onlyOnSide',
          side: 'south',
        }),
        ...reconcile(1, southCount, `南墙洞口数 must=1，spec=${String(southCount)}`),
      }),
    );
  }
  leaves.push(windowReportLeaf(must, window));
  return leaves;
}

function doorWidthAndReportLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const door = entranceDoor(spec);
  return [doorWidthLeaf(spec, must), doorReportLeaf(must, door)];
}

function windowSouthLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const window = southWindow(spec, true);
  const checkId = window === undefined ? 'check:opening:missing-window' : `check:opening:${window.id}`;
  const southCount = spec.openings.filter((opening) => opening.side === 'south').length;
  const scheduleId = 'check:schedule:south';
  return [
    windowWidthLeaf(must, window),
    leaf(must, {
      kind: 'relation',
      suffix: 'window-side',
      target: target('side', 'south'),
      check: check('opening', checkId, window === undefined ? [] : [`opening:${window.id}`], {
        expectedId: window?.id ?? 'missing',
        metric: 'side',
        side: 'south',
      }),
      ...reconcile('south', window?.side, `窗洞方位 must=south，spec=${String(window?.side)}`),
    }),
    leaf(must, {
      kind: 'count',
      suffix: 'only-south-opening',
      target: target('onlyOnSide', 1, 'count'),
      check: check('opening', scheduleId, window === undefined ? [] : [`opening:${window.id}`], {
        checkId: scheduleId,
        expectedId: window?.id ?? 'missing',
        metric: 'onlyOnSide',
        side: 'south',
      }),
      ...reconcile(1, southCount, `南墙洞口数 must=1，spec=${String(southCount)}`),
    }),
    windowReportLeaf(must, window),
    qualitativeLeaf(must, 'stream-view', 'visual', '观看南侧溪流是视觉 / 体验目标，需要渲染或人工复核'),
  ];
}

function noGlassDoorLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const door = entranceDoor(spec);
  const northDoors = spec.openings.filter((opening) => opening.kind !== 'window' && opening.side === 'north');
  const scheduleId = 'check:schedule:north';
  return [
    absenceLeaf(must, 'absence-glass-door', 'glass-door'),
    leaf(must, {
      kind: 'count',
      suffix: 'only-north-entry',
      target: target('entryCount', 1, 'count'),
      check: check('coverage', scheduleId, door === undefined ? [] : [`opening:${door.id}`], {
        checkId: scheduleId,
        field: 'doorCount',
        expectedId: door?.id ?? 'missing',
        side: 'north',
      }),
      ...reconcile(1, northDoors.length, `北侧入口数 must=1，spec=${String(northDoors.length)}`),
    }),
  ];
}

function noOutdoorZoneLeaves(must: Must): readonly MustClausePlan[] {
  return [
    absenceLeaf(must, 'absence-eave-platform', 'eave-platform'),
    absenceLeaf(must, 'absence-base-platform', 'base-platform'),
    qualitativeLeaf(
      must,
      'outdoor-zone-compound',
      'program',
      '任何室外分区 / 可停留地面是复合否定项，需要人工或场地证据复核',
    ),
  ];
}

function flushLeaf(spec: BuildSpec, must: Must, suffix: string): MustClausePlan {
  const door = entranceDoor(spec);
  const checkId = `check:flush:${door?.id ?? 'missing'}`;
  const hasStair = spec.elements.some((element) => element.kind === 'stair');
  return leaf(must, {
    kind: 'relation',
    suffix,
    target: target('flush', true),
    check: check('coverage', checkId, door === undefined ? [] : [`opening:${door.id}`], {
      checkId,
      field: 'flush',
      expectedId: door?.id ?? 'missing',
    }),
    ...reconcile(true, !hasStair, hasStair ? '入口 must=flush，spec 存在 stair 元素' : '入口 flush 与 spec 一致'),
  });
}

function noStepsLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  return [
    flushLeaf(spec, must, 'flush'),
    qualitativeLeaf(must, 'no-ramp-tail', 'qualitative', '不设坡道没有专用几何检查；当前只能证明入口齐平'),
  ];
}

function tableLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const table = furnitureOfKind(spec, 'table');
  const parsed = furnitureDimsOfText(must.text);
  const dims = parsed ?? (table === undefined ? undefined : furnitureDims(table));
  const eastWall = boundaryWalls(spec).east;
  const relation =
    table === undefined
      ? undefined
      : eastWall !== null && table.bounds.max[0] === eastWall.bounds.min[0]
        ? 'east-wall'
        : 'not-east-wall';
  const referenceId = eastWall?.id ?? 'wall:east';
  const checkId = `check:furniture:${table?.id ?? 'missing-table'}`;
  const ref = `furniture:${table?.id ?? 'missing-table'}`;
  const leaves: MustClausePlan[] = [];
  if (dims !== undefined) {
    leaves.push(
      targetFromSpec(
        must,
        'table-length',
        'dimension',
        'length',
        dims.length,
        table === undefined ? undefined : furnitureDims(table).length,
        'm',
        `长桌长度 must=${String(dims.length)}m，spec=${String(table === undefined ? undefined : furnitureDims(table).length)}m`,
        check('furniture', checkId, [ref], { expectedId: table?.id ?? 'missing', metric: 'length' }),
      ),
    );
    leaves.push(
      targetFromSpec(
        must,
        'table-depth',
        'dimension',
        'depth',
        dims.depth,
        table === undefined ? undefined : furnitureDims(table).depth,
        'm',
        `长桌深度 must=${String(dims.depth)}m，spec=${String(table === undefined ? undefined : furnitureDims(table).depth)}m`,
        check('furniture', checkId, [ref], { expectedId: table?.id ?? 'missing', metric: 'depth' }),
      ),
    );
  }
  leaves.push(
    leaf(must, {
      kind: 'kind',
      suffix: 'table-kind',
      target: target('kind', 'table'),
      check: check('furniture', checkId, [ref], { expectedId: table?.id ?? 'missing', metric: 'kind' }),
      ...reconcile('table', table?.kind, `长桌类型 must=table，spec=${String(table?.kind)}`),
    }),
  );
  leaves.push(
    leaf(must, {
      kind: 'relation',
      suffix: 'table-east-wall',
      target: target('relation', 'east-wall', null, 'east-wall'),
      check: check('furniture', checkId, [ref], {
        expectedId: table?.id ?? 'missing',
        metric: 'relation',
        relation: 'east-wall',
        referenceId,
        tolerance: '0',
      }),
      ...reconcile('east-wall', relation, `长桌关系 must=east-wall，spec=${String(relation)}`),
    }),
  );
  const axisTarget = furnitureAxisOfText(must.text);
  if (axisTarget !== null) {
    const specAxis =
      table === undefined
        ? undefined
        : table.bounds.max[0] - table.bounds.min[0] >= table.bounds.max[2] - table.bounds.min[2]
          ? 'x'
          : 'z';
    leaves.push(
      leaf(must, {
        kind: 'relation',
        suffix: 'table-long-axis',
        target: target('axis', axisTarget),
        check: check('furniture', checkId, [ref], {
          expectedId: table?.id ?? 'missing',
          metric: 'axis',
        }),
        ...reconcile(axisTarget, specAxis, `长桌长边 must=${axisTarget}，spec=${String(specAxis)}`),
      }),
    );
  }
  leaves.push(reportLeaf(must, 'report-furniture', [ref]));
  return leaves;
}

function benchLeaves(spec: BuildSpec, must: Must, side: 'north' | 'south'): readonly MustClausePlan[] {
  const table = furnitureOfKind(spec, 'table');
  const benches = furniture(spec).filter((item) => item.kind === 'bench');
  const ordered = [...benches].sort((a, b) => furnitureCenter(a).z - furnitureCenter(b).z);
  const named = benches.find((item) =>
    side === 'north'
      ? /north|北/iu.test(item.id) || /北/iu.test(item.name)
      : /south|南/iu.test(item.id) || /南/iu.test(item.name),
  );
  const bench = named ?? (side === 'north' ? ordered[0] : ordered[ordered.length - 1]);
  const parsed = furnitureDimsOfText(must.text);
  const dims = parsed ?? (bench === undefined ? undefined : furnitureDims(bench));
  const relation = side === 'north' ? 'north-of' : 'south-of';
  const derivedRelation =
    bench === undefined || table === undefined
      ? undefined
      : furnitureCenter(bench).z < furnitureCenter(table).z
        ? 'north-of'
        : furnitureCenter(bench).z > furnitureCenter(table).z
          ? 'south-of'
          : 'coincident';
  const door = entranceDoor(spec);
  const westClear = bench === undefined || door === undefined ? undefined : bench.bounds.min[0] >= door.bounds.max[0];
  const checkId = `check:furniture:${bench?.id ?? 'missing-bench'}`;
  const ref = `furniture:${bench?.id ?? 'missing-bench'}`;
  const leaves: MustClausePlan[] = [];
  if (dims !== undefined) {
    leaves.push(
      targetFromSpec(
        must,
        `${side}-bench-length`,
        'dimension',
        'length',
        dims.length,
        bench === undefined ? undefined : furnitureDims(bench).length,
        'm',
        `${side} 长凳长度 must=${String(dims.length)}m，spec=${String(bench === undefined ? undefined : furnitureDims(bench).length)}m`,
        check('furniture', checkId, [ref], { expectedId: bench?.id ?? 'missing', metric: 'length' }),
      ),
    );
    leaves.push(
      targetFromSpec(
        must,
        `${side}-bench-depth`,
        'dimension',
        'depth',
        dims.depth,
        bench === undefined ? undefined : furnitureDims(bench).depth,
        'm',
        `${side} 长凳深度 must=${String(dims.depth)}m，spec=${String(bench === undefined ? undefined : furnitureDims(bench).depth)}m`,
        check('furniture', checkId, [ref], { expectedId: bench?.id ?? 'missing', metric: 'depth' }),
      ),
    );
  }
  leaves.push(
    leaf(must, {
      kind: 'kind',
      suffix: `${side}-bench-kind`,
      target: target('kind', 'bench'),
      check: check('furniture', checkId, [ref], { expectedId: bench?.id ?? 'missing', metric: 'kind' }),
      ...reconcile('bench', bench?.kind, `${side} 长凳类型 must=bench，spec=${String(bench?.kind)}`),
    }),
  );
  leaves.push(
    leaf(must, {
      kind: 'relation',
      suffix: `${side}-bench-relation`,
      target: target('relation', relation, null, relation),
      check: check('furniture', checkId, [ref], {
        expectedId: bench?.id ?? 'missing',
        metric: 'relation',
        relation,
        referenceId: table?.id ?? 'f-long-table',
        tolerance: '0',
      }),
      ...reconcile(relation, derivedRelation, `${side} 长凳关系 must=${relation}，spec=${String(derivedRelation)}`),
    }),
  );
  if (side === 'north') {
    leaves.push(
      leaf(must, {
        kind: 'relation',
        suffix: 'north-bench-west-of-door-clear',
        target: target('west-of-door-clear', true),
        check: check('furniture', checkId, [ref], {
          expectedId: bench?.id ?? 'missing',
          metric: 'relation',
          relation: 'west-of-door-clear',
          referenceId: door?.id ?? 'missing-door',
          tolerance: '0',
          doorMaxX: door?.bounds.max[0] ?? 0,
        }),
        ...reconcile(true, westClear, `北凳西端必须从门洞东侧开始；spec west-of-door-clear=${String(westClear)}`),
      }),
    );
  }
  leaves.push(reportLeaf(must, 'report-furniture', [ref]));
  return leaves;
}

function seatLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const benches = furniture(spec).filter((item) => item.kind === 'bench');
  const pair = seatPairOfText(must.text);
  const total = seatCountOfText(must.text) ?? (pair === null ? undefined : pair[0] + pair[1]);
  const capacities = benches.map(seatCapacity);
  const specTotal = capacities.length === 0 ? undefined : capacities.reduce((sum, value) => sum + value, 0);
  const checkId = `check:seats:${String(total ?? 0)}`;
  const expectedId = benches.map((item) => item.id).join(',');
  const leaves: MustClausePlan[] = [];
  if (total !== undefined) {
    leaves.push(
      leaf(must, {
        kind: 'count',
        suffix: 'seat-count',
        target: target('count', total, 'seat'),
        check: check(
          'coverage',
          checkId,
          benches.map((item) => `furniture:${item.id}`),
          {
            checkId,
            field: 'count',
            expectedId,
          },
        ),
        ...reconcile(total, specTotal, `座位总数 must=${String(total)}，spec=${String(specTotal)}`),
      }),
    );
  }
  if (pair !== null) {
    leaves.push(
      leaf(must, {
        kind: 'count',
        suffix: 'seat-per-bench',
        target: target('seatsPerBench', [pair[0], pair[1]], 'seat'),
        check: check(
          'coverage',
          checkId,
          benches.map((item) => `furniture:${item.id}`),
          {
            checkId,
            field: 'perBench',
            expectedId,
          },
        ),
        ...reconcile(
          [pair[0], pair[1]],
          capacities.length === 2 ? capacities : undefined,
          `每凳座位 must=${pair.join('+')}，spec=${capacities.join('+')}`,
        ),
      }),
    );
  }
  return leaves;
}

function counterLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const counter = furnitureOfKind(spec, 'counter');
  const parsed = furnitureDimsOfText(must.text);
  const dims = parsed ?? (counter === undefined ? undefined : furnitureDims(counter));
  const westWall = boundaryWalls(spec).west;
  const relation =
    counter === undefined
      ? undefined
      : westWall !== null && counter.bounds.min[0] === westWall.bounds.max[0]
        ? 'west-wall'
        : 'not-west-wall';
  const checkId = `check:furniture:${counter?.id ?? 'missing-counter'}`;
  const ref = `furniture:${counter?.id ?? 'missing-counter'}`;
  const leaves: MustClausePlan[] = [];
  if (dims !== undefined) {
    leaves.push(
      targetFromSpec(
        must,
        'counter-length',
        'dimension',
        'length',
        dims.length,
        counter === undefined ? undefined : furnitureDims(counter).length,
        'm',
        `柜台长度 must=${String(dims.length)}m，spec=${String(counter === undefined ? undefined : furnitureDims(counter).length)}m`,
        check('furniture', checkId, [ref], { expectedId: counter?.id ?? 'missing', metric: 'length' }),
      ),
    );
    leaves.push(
      targetFromSpec(
        must,
        'counter-depth',
        'dimension',
        'depth',
        dims.depth,
        counter === undefined ? undefined : furnitureDims(counter).depth,
        'm',
        `柜台深度 must=${String(dims.depth)}m，spec=${String(counter === undefined ? undefined : furnitureDims(counter).depth)}m`,
        check('furniture', checkId, [ref], { expectedId: counter?.id ?? 'missing', metric: 'depth' }),
      ),
    );
  }
  leaves.push(
    leaf(must, {
      kind: 'kind',
      suffix: 'counter-kind',
      target: target('kind', 'counter'),
      check: check('furniture', checkId, [ref], { expectedId: counter?.id ?? 'missing', metric: 'kind' }),
      ...reconcile('counter', counter?.kind, `柜台类型 must=counter，spec=${String(counter?.kind)}`),
    }),
  );
  leaves.push(
    leaf(must, {
      kind: 'relation',
      suffix: 'counter-west-wall',
      target: target('relation', 'west-wall', null, 'west-wall'),
      check: check('furniture', checkId, [ref], {
        expectedId: counter?.id ?? 'missing',
        metric: 'relation',
        relation: 'west-wall',
        referenceId: westWall?.id ?? 'wall:west',
        tolerance: '0',
      }),
      ...reconcile('west-wall', relation, `柜台关系 must=west-wall，spec=${String(relation)}`),
    }),
  );
  leaves.push(reportLeaf(must, 'report-furniture', [ref]));
  leaves.push(
    qualitativeLeaf(must, 'counter-not-extended', 'program', '不延伸出备茶区 / 不做操作间是功能尾句，需要人工复核'),
  );
  return leaves;
}

function stoneBaseLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const slabRefs = spec.levels.slice(0, 50).map((item) => `slab:${item.id}`);
  const leaves = [
    qualitativeLeaf(must, 'stone-material', 'material', '材料 / 防潮层不在 allowlist；不能仅凭材料声明 met'),
    reportLeaf(must, 'report-slab', slabRefs),
    absenceLeaf(must, 'absence-base-platform', 'base-platform'),
    flushLeaf(spec, must, 'flush-no-raise'),
  ];
  if (spec.levels.length > 50) {
    leaves.push(
      qualitativeLeaf(
        must,
        'levels-over-50',
        'qualitative',
        '超过 50 个 level 的 slab refs 无法进入 clause，保持 unverified',
      ),
    );
  }
  return leaves;
}

function roofLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const parsed = roofFormOfText(must.text);
  const targetForm = parsed ?? spec.roof.form;
  const leaves: MustClausePlan[] = [
    leaf(must, {
      kind: 'form',
      suffix: 'roof-form',
      target: target('form', targetForm),
      check: check('roof', 'check:roof:form', ['roof'], { metric: 'form' }),
      ...reconcile(targetForm, spec.roof.form, `屋面形式 must=${targetForm}，spec=${spec.roof.form}`),
    }),
    reportLeaf(must, 'report-roof', ['roof']),
    qualitativeLeaf(must, 'roof-material', 'material', '深色瓦材料不在 allowlist；材料声明不能单独 met'),
  ];
  return leaves;
}

function budgetLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const parsed = budgetOfText(must.text);
  const specMax = spec.budget.maxBlocks;
  const maxBlocks = parsed ?? specMax;
  // “不超过”是上限关系：must 比 spec 宽松时不是冲突；must 比 spec 更严格时才是冲突。
  const conflict =
    parsed !== null && parsed < specMax
      ? {
          mustTarget: parsed,
          specTarget: specMax,
          message: clip(`方块上限 must=${String(parsed)} < spec.budget.maxBlocks=${String(specMax)}`, 400),
        }
      : null;
  const checkId = `check:budget:${String(specMax)}`;
  return [
    leaf(must, {
      kind: 'budget',
      suffix: 'budget-max',
      target: target('maxBlocks', maxBlocks, 'blocks'),
      check: check('budget', checkId, [], { metric: 'maxBlocks', specMax }),
      specTarget: specMax,
      conflict,
    }),
  ];
}

function entranceLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const door = entranceDoor(spec);
  const checkId = door === undefined ? 'check:door-position:missing' : `check:door-position:${door.id}`;
  return [
    leaf(must, {
      kind: 'relation',
      suffix: 'entrance-side',
      target: target('side', 'north'),
      check: check('opening', checkId, door === undefined ? [] : [`opening:${door.id}`], {
        expectedId: door?.id ?? 'missing',
        metric: 'side',
        side: 'north',
      }),
      ...reconcile('north', door?.side, `入口方位 must=north，spec=${String(door?.side)}`),
    }),
    flushLeaf(spec, must, 'flush'),
    qualitativeLeaf(must, 'village-road-context', 'site', '北侧村道衔接属于场地语境，需要人工复核'),
  ];
}

function viewFrameLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  const window = southWindow(spec, true);
  return [
    windowWidthLeaf(must, window),
    qualitativeLeaf(must, 'view-frame', 'visual', '溪景取景框是视觉目标，需要渲染或人工复核'),
    qualitativeLeaf(must, 'seating-orientation', 'visual', '主要座席朝窗是布置意图，当前没有朝向检查器'),
  ];
}

function entryFlushLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  return [
    flushLeaf(spec, must, 'flush'),
    qualitativeLeaf(
      must,
      'no-ramp-tail',
      'qualitative',
      '门洞不设坡道没有专用几何检查；基座不外挑由 absence 检查另行覆盖',
    ),
  ];
}

function genericBudget(spec: BuildSpec, must: Must): readonly MustClausePlan[] | null {
  return budgetOfText(must.text) === null ? null : budgetLeaves(spec, must);
}

function genericWallThickness(spec: BuildSpec, must: Must): readonly MustClausePlan[] | null {
  if (wallThicknessOfText(must.text) === null) return null;
  return wallThicknessLeaves(spec, must, hasThicknessTail(must.text));
}

function genericSeats(spec: BuildSpec, must: Must): readonly MustClausePlan[] | null {
  if (!isSeatMust(must.id, must.text) || seatCountOfText(must.text) === null) return null;
  return seatLeaves(spec, must);
}

function genericRoof(spec: BuildSpec, must: Must): readonly MustClausePlan[] | null {
  if (!/roof|屋面|屋顶/iu.test(must.id) || roofFormOfText(must.text) === null) return null;
  return roofLeaves(spec, must);
}

function genericWindow(spec: BuildSpec, must: Must): readonly MustClausePlan[] | null {
  if (!/window|窗/iu.test(must.id)) return null;
  if (
    windowWidthOfText(must.text) === null &&
    sillOfText(must.text) === null &&
    windowHeightOfText(must.text) === null &&
    headOfText(must.text) === null
  ) {
    return null;
  }
  return windowDimLeaves(spec, must, true, false, must.text.includes('南'));
}

function genericDoor(spec: BuildSpec, must: Must): readonly MustClausePlan[] | null {
  if (!/door|门/iu.test(must.id) || doorWidthOfText(must.text) === null) return null;
  return doorWidthAndReportLeaves(spec, must);
}

function genericFurniture(spec: BuildSpec, must: Must): readonly MustClausePlan[] | null {
  if (furnitureDimsOfText(must.text) === null) return null;
  if (/table|桌/iu.test(must.id)) return tableLeaves(spec, must);
  if (/bench|凳/iu.test(must.id)) {
    const side = must.text.includes('南') ? 'south' : 'north';
    return benchLeaves(spec, must, side);
  }
  if (/counter|柜台/iu.test(must.id)) return counterLeaves(spec, must);
  return null;
}

function genericLeaves(spec: BuildSpec, must: Must): readonly MustClausePlan[] {
  // 预算的“不超过”是上限关系，不是对象否定项；先走预算规则。
  const budget = genericBudget(spec, must);
  if (budget !== null) return budget;
  if (isNegativeId(must.id) || negatesTarget(must.text, NEGATIVE_TARGET_TERMS)) {
    return [
      qualitativeLeaf(
        must,
        'negative-fallback',
        'qualitative',
        '负向 / 禁止型 must 没有专用保守检查器；不能按关键词提升',
      ),
    ];
  }
  const rules = [genericWallThickness, genericSeats, genericRoof, genericWindow, genericDoor, genericFurniture];
  for (const rule of rules) {
    const leaves = rule(spec, must);
    if (leaves !== null) return leaves;
  }
  return [qualitativeLeaf(must, 'fallback', 'program', 'no-compiler-rule')];
}

function compileExplicit(spec: BuildSpec, must: Must): readonly MustClausePlan[] | null {
  switch (must.id) {
    case 'req-teahouse-program':
      return [qualitativeLeaf(must, 'program', 'program', '公共茶亭功能需要人工 / 使用场景复核')];
    case 'req-outer-10x8':
    case 'constraint-con-outer-10x8':
      return envelopeLeaves(spec, must);
    case 'req-single-storey':
    case 'constraint-con-single-storey':
      return storeyLeaves(spec, must);
    case 'req-no-mezzanine':
      // 三格厚楼板会被 check:absence:mezzanine 误报成夹层；该检查未证明保守，保持 unverified。
      return [
        qualitativeLeaf(
          must,
          'absence-mezzanine',
          'qualitative',
          '夹层 absence 检查器会把厚楼板误报成夹层；不能假 met',
        ),
      ];
    case 'req-single-hall':
      return [qualitativeLeaf(must, 'single-hall', 'program', '单一主厅是功能 / 空间组织目标，没有专用检查器')];
    case 'req-no-partitions':
      return [absenceLeaf(must, 'absence-partition', 'partition')];
    case 'req-interior-8x6':
    case 'constraint-con-interior-clear':
      return clearLeaves(spec, must);
    case 'req-wall-thick-1m':
      return wallThicknessLeaves(spec, must, true);
    case 'constraint-con-wall-1m':
      return wallThicknessLeaves(spec, must, hasThicknessTail(must.text));
    case 'req-door-north-west':
      return doorNorthWestLeaves(spec, must);
    case 'constraint-con-door-2m':
      return doorLocationLeaves(spec, must, false);
    case 'req-door-clear-1m':
    case 'constraint-con-door-clear-1m':
      return doorClearLeaves(spec, must);
    case 'req-window-south-4m':
      return windowSouthLeaves(spec, must);
    case 'req-window-dim':
      return windowDimLeaves(spec, must, false, false, true, true);
    case 'constraint-con-window-south':
      return windowDimLeaves(spec, must, true, true, true, true);
    case 'req-no-glass-door':
      return noGlassDoorLeaves(spec, must);
    case 'req-no-outdoor-zone':
      return noOutdoorZoneLeaves(must);
    case 'req-no-steps':
      return noStepsLeaves(spec, must);
    case 'req-long-table':
      return tableLeaves(spec, must);
    case 'req-bench-north':
      return benchLeaves(spec, must, 'north');
    case 'req-bench-south':
      return benchLeaves(spec, must, 'south');
    case 'req-seats-10':
      return seatLeaves(spec, must);
    case 'req-counter':
      return counterLeaves(spec, must);
    case 'req-counter-no-service':
      return [absenceLeaf(must, 'absence-counter-service', 'counter-service')];
    case 'req-stone-base':
      return stoneBaseLeaves(spec, must);
    case 'req-wood-wall-column':
      return [
        qualitativeLeaf(must, 'wood-material', 'material', '木墙 / 木柱材料不在 allowlist'),
        qualitativeLeaf(must, 'column-checker', 'qualitative', '没有专用柱检查器；柱数量与位置需要人工复核'),
      ];
    case 'req-gable-tile-roof':
      return roofLeaves(spec, must);
    case 'req-eave-only':
      return [
        absenceLeaf(must, 'absence-eave-platform', 'eave-platform'),
        qualitativeLeaf(must, 'eave-ground', 'qualitative', '出檐下方不设铺装 / 可停留地面需要人工或场地证据'),
      ];
    case 'req-block-budget':
    case 'constraint-con-block-budget':
      return budgetLeaves(spec, must);
    case 'req-no-sign-ticket-frame':
      return [qualitativeLeaf(must, 'no-sign', 'qualitative', '招牌 / 售票窗口 / 装饰构架没有专用 absence 检查器')];
    case 'req-site-stream-south':
      return [qualitativeLeaf(must, 'stream-south', 'site', '溪流方位属于场地语境，需要人工复核')];
    case 'req-site-road-north':
      return [qualitativeLeaf(must, 'road-north', 'site', '村道方位属于场地语境，需要人工复核')];
    case 'req-entrance-from-north':
      return entranceLeaves(spec, must);
    case 'req-view-frame':
      return viewFrameLeaves(spec, must);
    case 'constraint-con-material-selection':
      return [qualitativeLeaf(must, 'material-selection', 'material', '材料限定不在 allowlist；需要材料 / 渲染证据')];
    case 'constraint-con-entry-flush':
      return entryFlushLeaves(spec, must);
    default:
      return null;
  }
}

/** deterministic：输入同一 BuildSpec，输出逐字节相同的计划；不读文件、不加时间戳。 */
export function compileMustClauses(spec: BuildSpec): MustClausePlanFile {
  const groups = spec.musts.map((must) => {
    const explicit = compileExplicit(spec, must);
    return group(must, explicit ?? genericLeaves(spec, must));
  });
  const summary = summarizeClausePlan({ groups });
  return MustClausePlanFileSchema.parse({
    schemaVersion: MUST_CLAUSE_PLAN_SCHEMA_VERSION,
    tool: 'must-clause-compiler',
    compilerVersion: MUST_CLAUSE_COMPILER_VERSION,
    groups,
    summary,
  });
}
