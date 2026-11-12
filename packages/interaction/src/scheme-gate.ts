/* eslint-disable max-lines -- 每类 must 一个独立确定性检查，拆文件会增加纯函数注册与测试配对成本。 */
/**
 * 语义方案门：把 MustLedger 中可机械核对的 must 与 DesignScheme 对照。
 *
 * 负责：外轮廓 / 室内净尺寸、外墙厚度、入口方位与净宽、南窗方位 / 宽 / 窗台、屋面形式 / 坡度、
 * 材料选择，以及长桌 / 长凳 / 座位 / 门内净空 / 柜台与长桌净距的确定性检查；每个失败都带
 * must id、expected / actual 与可行动选项。只报告 blocking，不修改方案、不调用模型。
 * 不负责：门窗 kind 语义、家具摆放求解、视觉质量或读文件；本文件是纯函数。
 *
 * 口径：只检查能从 must 原文与 scheme 字段直接对上的项；识别不了的 must 保持 unchecked，
 * 不把“没有检查”写成 pass。run-7 rev1 的四个真实问题：长桌 4×2、无独立椅子、门内 1m 净空、
 * 柜台与长桌 1m 净距。
 */
import { z } from 'zod';

import { buildMustLedger } from './must-ledger.ts';
import type { MustLedger, MustLedgerEntry } from './must-ledger.ts';
import { Identifier, Label, Text } from './primitives.ts';
import type { Bounds } from './primitives.ts';
import type { RequirementGraph } from './requirements.ts';
import type { DesignScheme, RoofForm, SchemeElement, SchemeFurniture, SchemeOpening, Side } from './scheme.ts';

export const SchemeGateOption = z
  .strictObject({
    id: Identifier,
    label: Label,
    action: z.enum(['repair', 'waive', 'redesign']),
  })
  .readonly();
export type SchemeGateOption = z.infer<typeof SchemeGateOption>;

export const SchemeGateIssue = z
  .strictObject({
    code: z.string().min(1).max(64),
    severity: z.enum(['blocking', 'warning', 'unverified']),
    message: Text,
    mustIds: z.array(Identifier).max(20).readonly(),
    expected: Text,
    actual: Text,
    location: Text.nullable(),
    options: z.array(SchemeGateOption).min(1).max(8).readonly(),
  })
  .readonly();
export type SchemeGateIssue = z.infer<typeof SchemeGateIssue>;

export const SchemeGateReport = z
  .strictObject({
    passed: z.boolean(),
    issues: z.array(SchemeGateIssue).max(100).readonly(),
    checkedMustIds: z.array(Identifier).max(300).readonly(),
    uncheckedMustIds: z.array(Identifier).max(300).readonly(),
    counts: z
      .strictObject({
        blocking: z.int().nonnegative(),
        warning: z.int().nonnegative(),
        unverified: z.int().nonnegative(),
        total: z.int().nonnegative(),
      })
      .readonly(),
  })
  .readonly();
export type SchemeGateReport = z.infer<typeof SchemeGateReport>;

interface Span {
  readonly x: number;
  readonly z: number;
}

interface CheckResult {
  readonly issues: readonly SchemeGateIssue[];
  readonly checked: readonly MustLedgerEntry[];
}

const NOTHING: CheckResult = { issues: [], checked: [] };
const SIDE_LABEL: Readonly<Record<Side, string>> = { north: '北', east: '东', south: '南', west: '西' };

function span(bounds: Bounds): Span {
  return { x: bounds.max[0] - bounds.min[0], z: bounds.max[2] - bounds.min[2] };
}

function allFurniture(scheme: DesignScheme): SchemeFurniture[] {
  return scheme.interiors.flatMap((interior) => interior.furnitureSpecs);
}

function dimensionPair(text: string, secondUnit: '宽' | '深'): { length: number; width: number } | null {
  const pattern = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*m\\s*长[、,，]?\\s*(\\d+(?:\\.\\d+)?)\\s*m\\s*${secondUnit}`, 'u');
  const match = pattern.exec(text);
  if (match === null) return null;
  const length = Number(match[1]);
  const width = Number(match[2]);
  if (!Number.isFinite(length) || !Number.isFinite(width)) return null;
  return { length, width };
}

function firstMeter(text: string, fallback = 1): number {
  const match = /(\d+(?:\.\d+)?)\s*m/u.exec(text);
  if (match === null) return fallback;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function overlap1(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function gap1(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.max(b0 - a1, a0 - b1));
}

function byId<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 与 tools/build-sheet.ts 的 entranceOpening 同口径：按方案声明顺序取第一个非窗洞口，
 * 优先 site.entranceSide，其次北侧，最后退到第一个非窗洞口；窗口永远不能当入口。
 */
function entranceOpening(scheme: DesignScheme): SchemeOpening | undefined {
  const candidates = scheme.openings.filter((opening) => opening.kind !== 'window');
  return (
    candidates.find((opening) => opening.side === scheme.site.entranceSide) ??
    candidates.find((opening) => opening.side === 'north') ??
    candidates[0]
  );
}

function nonWindowOnSide(scheme: DesignScheme, side: Side): SchemeOpening | undefined {
  return scheme.openings.find((opening) => opening.side === side && opening.kind !== 'window');
}

function uniqueIds(entries: readonly MustLedgerEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry.id);
  }
  return out;
}

function mustEntries(ledger: MustLedger): MustLedgerEntry[] {
  return [...ledger.entries];
}

function tableMust(entries: readonly MustLedgerEntry[]): MustLedgerEntry | undefined {
  return entries.find((entry) => entry.text.includes('桌') && dimensionPair(entry.text, '宽') !== null);
}

function seatMust(entries: readonly MustLedgerEntry[]): MustLedgerEntry | undefined {
  return entries.find(
    (entry) =>
      /(\d+)\s*座/u.test(entry.text) &&
      (entry.text.includes('5+5') ||
        /各\s*\d+\s*座/u.test(entry.text) ||
        entry.text.includes('长凳') ||
        entry.text.includes('座位')),
  );
}

function doorClearMusts(entries: readonly MustLedgerEntry[]): MustLedgerEntry[] {
  return entries.filter(
    (entry) =>
      entry.text.includes('门内') &&
      (entry.text.includes('净空') || entry.text.includes('空地') || entry.text.includes('不摆放家具')),
  );
}

function counterMust(entries: readonly MustLedgerEntry[]): MustLedgerEntry | undefined {
  return entries.find((entry) => entry.text.includes('柜台') && dimensionPair(entry.text, '深') !== null);
}

function benchMusts(entries: readonly MustLedgerEntry[]): MustLedgerEntry[] {
  return entries.filter(
    (entry) =>
      (entry.text.includes('长凳') || entry.text.includes('bench')) && dimensionPair(entry.text, '宽') !== null,
  );
}

function furnitureSpanMatches(item: SchemeFurniture, expected: { length: number; width: number }): boolean {
  const actual = span(item.bounds);
  return actual.x === expected.length && actual.z === expected.width;
}

function counterSpanMatches(item: SchemeFurniture, expected: { length: number; width: number }): boolean {
  const actual = span(item.bounds);
  return (
    (actual.x === expected.length && actual.z === expected.width) ||
    (actual.x === expected.width && actual.z === expected.length)
  );
}

function issue(input: {
  readonly code: string;
  readonly message: string;
  readonly mustIds: readonly string[];
  readonly expected: string;
  readonly actual: string;
  readonly location: string | null;
  readonly options: readonly SchemeGateOption[];
}): SchemeGateIssue {
  return SchemeGateIssue.parse({
    ...input,
    severity: 'blocking',
    mustIds: [...new Set(input.mustIds)],
    options: input.options,
  });
}

function waiveOption(id: string, label: string): SchemeGateOption {
  return { id, label, action: 'waive' };
}

function missingFurnitureIssue(
  kind: 'table' | 'bench' | 'counter',
  must: MustLedgerEntry,
  expected: string,
): SchemeGateIssue {
  return issue({
    code: `${kind}-missing`,
    message: `must 要求${expected}，但 scheme 没有对应的 ${kind} 家具。`,
    mustIds: [must.id],
    expected,
    actual: `无 ${kind} 家具`,
    location: 'interiors.furnitureSpecs',
    options: [
      { id: `add-${kind}`, label: `补一件符合 must 的${expected}`, action: 'repair' },
      waiveOption(`waive-${kind}-must`, `明确豁免该 ${kind} must`),
    ],
  });
}

function benchDimensionIssue(
  must: MustLedgerEntry,
  expected: { length: number; width: number },
  actual: SchemeFurniture | undefined,
): SchemeGateIssue {
  const actualText =
    actual === undefined ? '未匹配到可用长凳' : `${String(span(actual.bounds).x)}m×${String(span(actual.bounds).z)}m`;
  return issue({
    code: `bench-${String(expected.length)}x${String(expected.width)}`,
    message: `长凳尺寸不满足 must 要求的 ${String(expected.length)}m×${String(expected.width)}m。`,
    mustIds: [must.id],
    expected: `长凳 ${String(expected.length)}m×${String(expected.width)}m`,
    actual: actualText,
    location: actual === undefined ? 'interiors.furnitureSpecs' : `interiors.furnitureSpecs.${actual.id}.bounds`,
    options: [
      {
        id: 'resize-bench-to-must',
        label: `把长凳改为 ${String(expected.length)}×${String(expected.width)}m`,
        action: 'repair',
      },
      waiveOption('waive-bench-must', '明确豁免长凳尺寸 must'),
    ],
  });
}

function tableIssue(
  table: SchemeFurniture,
  must: MustLedgerEntry,
  expected: { length: number; width: number },
): SchemeGateIssue | null {
  const actual = span(table.bounds);
  if (actual.x === expected.length && actual.z === expected.width) return null;
  return issue({
    code: `table-${String(expected.length)}x${String(expected.width)}`,
    message: `长桌占地 ${String(actual.x)}m×${String(actual.z)}m，不满足 must 要求的 ${String(expected.length)}m×${String(expected.width)}m。`,
    mustIds: [must.id],
    expected: `长桌 ${String(expected.length)}m×${String(expected.width)}m（东西向长边）`,
    actual: `${String(actual.x)}m×${String(actual.z)}m`,
    location: `interiors.furnitureSpecs.${table.id}.bounds`,
    options: [
      {
        id: 'resize-table-to-must',
        label: `把长桌改为 ${String(expected.length)}×${String(expected.width)}m`,
        action: 'repair',
      },
      waiveOption('waive-table-must', '明确豁免长桌尺寸 must'),
    ],
  });
}

function chairIssue(chairs: readonly SchemeFurniture[], must: MustLedgerEntry): SchemeGateIssue | null {
  if (chairs.length === 0) return null;
  return issue({
    code: 'no-chairs',
    message: `出现 ${String(chairs.length)} 把独立椅子；must 要求 5+5 座由南北两条长凳提供，不应再放椅子。`,
    mustIds: [must.id],
    expected: '0 把独立椅子；10 座由南北两条 4×1m 长凳提供',
    actual: `${String(chairs.length)} 把椅子：${chairs.map((chair) => chair.id).join('、')}`,
    location: chairs[0] === undefined ? null : `interiors.furnitureSpecs.${chairs[0].id}`,
    options: [
      { id: 'remove-chairs', label: '删除独立椅子，保留 5+5 长凳座位', action: 'repair' },
      waiveOption('waive-seat-must', '明确豁免 5+5 座位 must'),
    ],
  });
}

function clearanceBand(
  opening: SchemeOpening,
  clear: number,
): { readonly axis: 'x' | 'z'; readonly from: number; readonly to: number } {
  if (opening.side === 'north') return { axis: 'z', from: opening.bounds.max[2], to: opening.bounds.max[2] + clear };
  if (opening.side === 'south') return { axis: 'z', from: opening.bounds.min[2] - clear, to: opening.bounds.min[2] };
  if (opening.side === 'east') return { axis: 'x', from: opening.bounds.min[0] - clear, to: opening.bounds.min[0] };
  return { axis: 'x', from: opening.bounds.max[0], to: opening.bounds.max[0] + clear };
}

function blocker(
  furniture: SchemeFurniture,
  entrance: SchemeOpening,
  band: { readonly axis: 'x' | 'z'; readonly from: number; readonly to: number },
): boolean {
  if (furniture.kind === 'light' || furniture.kind === 'rug') return false;
  const xOverlap = overlap1(
    furniture.bounds.min[0],
    furniture.bounds.max[0],
    entrance.bounds.min[0],
    entrance.bounds.max[0],
  );
  const zOverlap = overlap1(
    furniture.bounds.min[2],
    furniture.bounds.max[2],
    entrance.bounds.min[2],
    entrance.bounds.max[2],
  );
  const bandOverlap =
    band.axis === 'z'
      ? overlap1(furniture.bounds.min[2], furniture.bounds.max[2], band.from, band.to)
      : overlap1(furniture.bounds.min[0], furniture.bounds.max[0], band.from, band.to);
  return (band.axis === 'z' ? xOverlap : zOverlap) > 0 && bandOverlap > 0;
}

function doorClearanceIssue(
  scheme: DesignScheme,
  musts: readonly MustLedgerEntry[],
  furniture: readonly SchemeFurniture[],
): SchemeGateIssue | null {
  const must = musts[0];
  const entrance = entranceOpening(scheme);
  if (must === undefined || entrance === undefined) return null;
  const clear = firstMeter(must.text, 1);
  const band = clearanceBand(entrance, clear);
  const blockers = furniture.filter((item) => blocker(item, entrance, band));
  if (blockers.length === 0) return null;
  return issue({
    code: `door-clearance-${String(clear)}m`,
    message: `门内 ${String(clear)}m 进深净空带被家具占用；入口 ${entrance.id} 内侧不能放硬质家具。`,
    mustIds: uniqueIds(musts),
    expected: `门内 ${String(clear)}m 进深、门洞全宽范围内保持净空`,
    actual: `${blockers.map((item) => `${item.id}（${item.kind}）`).join('、')} 侵入净空带`,
    location: `openings.${entrance.id}`,
    options: [
      { id: 'move-blocking-furniture', label: '把阻挡家具整体移出门内净空带', action: 'repair' },
      waiveOption('waive-door-clearance-must', '明确豁免门内净空 must'),
    ],
  });
}

function counterDimensionIssue(
  must: MustLedgerEntry,
  expected: { length: number; width: number },
  counter: SchemeFurniture,
): SchemeGateIssue {
  const actual = span(counter.bounds);
  return issue({
    code: `counter-${String(expected.length)}x${String(expected.width)}`,
    message: `柜台尺寸不满足 must 要求的 ${String(expected.length)}m×${String(expected.width)}m。`,
    mustIds: [must.id],
    expected: `柜台 ${String(expected.length)}m×${String(expected.width)}m（可旋转 90°）`,
    actual: `${String(actual.x)}m×${String(actual.z)}m`,
    location: `interiors.furnitureSpecs.${counter.id}.bounds`,
    options: [
      {
        id: 'resize-counter-to-must',
        label: `把柜台改为 ${String(expected.length)}×${String(expected.width)}m`,
        action: 'repair',
      },
      waiveOption('waive-counter-dimension-must', '明确豁免柜台尺寸 must'),
    ],
  });
}

function counterTableIssue(
  table: SchemeFurniture,
  counter: SchemeFurniture,
  musts: readonly MustLedgerEntry[],
): SchemeGateIssue | null {
  const xGap = gap1(counter.bounds.min[0], counter.bounds.max[0], table.bounds.min[0], table.bounds.max[0]);
  const zGap = gap1(counter.bounds.min[2], counter.bounds.max[2], table.bounds.min[2], table.bounds.max[2]);
  const xOverlap = overlap1(counter.bounds.min[0], counter.bounds.max[0], table.bounds.min[0], table.bounds.max[0]);
  const zOverlap = overlap1(counter.bounds.min[2], counter.bounds.max[2], table.bounds.min[2], table.bounds.max[2]);
  const pass = (zOverlap > 0 && xGap >= 1) || (xOverlap > 0 && zGap >= 1) || (xGap >= 1 && zGap >= 1);
  if (pass) return null;
  return issue({
    code: 'counter-table-1m',
    message: '柜台与长桌之间不足 1m 净距，主厅通道被堵。',
    mustIds: uniqueIds(musts),
    expected: '柜台与长桌之间至少 1m 净距',
    actual: `x 净距 ${String(xGap)}m，z 净距 ${String(zGap)}m（柜台 ${counter.id} / 长桌 ${table.id}）`,
    location: `interiors.furnitureSpecs.${counter.id}`,
    options: [
      { id: 'move-counter-west', label: '把柜台移到西墙中段，留出 ≥1m 通道', action: 'repair' },
      { id: 'move-table-west', label: '把长桌向西移动，留出 ≥1m 通道', action: 'repair' },
      waiveOption('waive-counter-must', '明确豁免柜台/通道 must'),
    ],
  });
}

function matchNumber(match: RegExpExecArray | null, index = 1): number | null {
  const raw = match?.[index];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function outlinePair(text: string): { readonly x: number; readonly z: number } | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:m|米)?\s*[×xX]\s*(\d+(?:\.\d+)?)\s*(?:m|米)/u.exec(text);
  const x = matchNumber(match, 1);
  const z = matchNumber(match, 2);
  return x === null || z === null ? null : { x, z };
}

function wallThickness(text: string): number | null {
  return matchNumber(/外墙(?:厚度|厚)\s*(?:为|约)?\s*(\d+(?:\.\d+)?)\s*(?:m|米)/u.exec(text));
}

function sideFromText(text: string): Side | null {
  if (/北(?:墙|侧|向)|朝北/u.test(text)) return 'north';
  if (/南(?:墙|侧|向)|朝南/u.test(text)) return 'south';
  if (/东(?:墙|侧|向)|朝东/u.test(text)) return 'east';
  if (/西(?:墙|侧|向)|朝西/u.test(text)) return 'west';
  return null;
}

interface EntranceSpec {
  readonly side: Side | null;
  readonly width: number | null;
}

function entranceSpec(text: string): EntranceSpec | null {
  if (/不做(?:落地)?门|不设(?:落地)?门|禁止(?:落地)?门/u.test(text)) return null;
  if (!/入口|门洞|门宽/u.test(text)) return null;
  const side = sideFromText(text);
  const width = matchNumber(/(?:门洞|门)(?:净宽|宽)\s*(?:为|约)?\s*(\d+(?:\.\d+)?)\s*(?:m|米)/u.exec(text));
  return side === null && width === null ? null : { side, width };
}

/** 只把入口 / 门本身的 must 归给 entrance 检查；引用门洞位置的家具 must 不算。 */
function isEntranceMust(entry: MustLedgerEntry): boolean {
  if (entry.check === 'furniture') return false;
  if (/(?:长桌|长凳|桌|凳|椅|柜台|家具|座位)/u.test(entry.text)) return false;
  if (/不做(?:落地)?门|不设(?:落地)?门|禁止(?:落地)?门/u.test(entry.text)) return false;
  return /入口|门洞|门宽|开门|门扇/u.test(entry.text);
}

interface WindowSpec {
  readonly side: Side | null;
  readonly width: number | null;
  readonly sill: number | null;
  readonly height: number | null;
  readonly head: number | null;
}

function windowSpec(text: string): WindowSpec | null {
  if (!text.includes('窗') || /不做.*窗|不设.*窗|禁止.*窗/u.test(text)) return null;
  const width =
    matchNumber(/(\d+(?:\.\d+)?)\s*(?:m|米)\s*宽/u.exec(text)) ??
    matchNumber(/(?:窗|洞口)?\s*宽\s*(?:为|约)?\s*(\d+(?:\.\d+)?)\s*(?:m|米)/u.exec(text));
  const sill = matchNumber(/窗台(?:高)?\s*(?:为|约)?\s*(\d+(?:\.\d+)?)\s*(?:m|米)/u.exec(text));
  const height = matchNumber(/窗高\s*(?:为|约)?\s*(\d+(?:\.\d+)?)\s*(?:m|米)/u.exec(text));
  const head = matchNumber(/洞(?:口)?顶(?:位于室内地面以上)?\s*(?:为|约)?\s*(\d+(?:\.\d+)?)\s*(?:m|米)/u.exec(text));
  if (width === null && sill === null && height === null && head === null) return null;
  return { side: sideFromText(text), width, sill, height, head };
}

interface RoofSpec {
  readonly form: RoofForm | null;
  readonly pitch: { readonly value: number; readonly approximate: boolean } | null;
}

function roofFormFromText(text: string): RoofForm | null {
  if (/平屋面|平屋顶/u.test(text)) return 'flat';
  if (text.includes('双坡')) return 'gable';
  if (text.includes('四坡')) return 'hip';
  if (text.includes('单坡')) return 'shed';
  if (text.includes('反坡')) return 'butterfly';
  if (text.includes('曲面')) return 'curved';
  return null;
}

function roofSpec(text: string): RoofSpec | null {
  if (!/(?:屋面|屋顶|瓦)/u.test(text)) return null;
  const match = /坡度\s*(约)?\s*(\d+(?:\.\d+)?)\s*(?:°|度)/u.exec(text);
  const pitch = matchNumber(match, 2);
  const form = roofFormFromText(text);
  if (form === null && pitch === null) return null;
  return { form, pitch: pitch === null ? null : { value: pitch, approximate: match?.[1] !== undefined } };
}

function onBuildingPerimeter(element: SchemeElement, scheme: DesignScheme): boolean {
  const building = scheme.site.buildingBounds;
  return (
    element.bounds.min[0] === building.min[0] ||
    element.bounds.max[0] === building.max[0] ||
    element.bounds.min[2] === building.min[2] ||
    element.bounds.max[2] === building.max[2]
  );
}

function perimeterWalls(scheme: DesignScheme): SchemeElement[] {
  return scheme.elements.filter((element) => element.kind === 'wall' && onBuildingPerimeter(element, scheme));
}

function actualWallThickness(wall: SchemeElement): number {
  return Math.min(wall.bounds.max[0] - wall.bounds.min[0], wall.bounds.max[2] - wall.bounds.min[2]);
}

function wallOnSide(wall: SchemeElement, scheme: DesignScheme, side: Side): boolean {
  const building = scheme.site.buildingBounds;
  const xSpan = wall.bounds.max[0] - wall.bounds.min[0];
  const zSpan = wall.bounds.max[2] - wall.bounds.min[2];
  const longAxisIsX = xSpan >= zSpan;
  if (side === 'north' || side === 'south') {
    return (
      longAxisIsX &&
      (side === 'north' ? wall.bounds.min[2] === building.min[2] : wall.bounds.max[2] === building.max[2])
    );
  }
  return (
    !longAxisIsX && (side === 'west' ? wall.bounds.min[0] === building.min[0] : wall.bounds.max[0] === building.max[0])
  );
}

function interiorClear(scheme: DesignScheme): Span | null {
  const walls = perimeterWalls(scheme);
  const sides = (['north', 'east', 'south', 'west'] as const).map((side) => ({
    side,
    walls: walls.filter((wall) => wallOnSide(wall, scheme, side)),
  }));
  if (sides.some((entry) => entry.walls.length === 0)) return null;
  const west = sides.find((entry) => entry.side === 'west')?.walls ?? [];
  const east = sides.find((entry) => entry.side === 'east')?.walls ?? [];
  const north = sides.find((entry) => entry.side === 'north')?.walls ?? [];
  const south = sides.find((entry) => entry.side === 'south')?.walls ?? [];
  const x0 = Math.max(...west.map((wall) => wall.bounds.max[0]));
  const x1 = Math.min(...east.map((wall) => wall.bounds.min[0]));
  const z0 = Math.max(...north.map((wall) => wall.bounds.max[2]));
  const z1 = Math.min(...south.map((wall) => wall.bounds.min[2]));
  if (x1 <= x0 || z1 <= z0) return null;
  return { x: x1 - x0, z: z1 - z0 };
}

function levelElevation(scheme: DesignScheme, levelId: string): number {
  return scheme.levels.find((level) => level.id === levelId)?.elevation ?? 0;
}

function openingWidth(opening: SchemeOpening): number {
  return opening.side === 'north' || opening.side === 'south'
    ? opening.bounds.max[0] - opening.bounds.min[0]
    : opening.bounds.max[2] - opening.bounds.min[2];
}

function sameRectangle(actual: Span, expected: { readonly x: number; readonly z: number }): boolean {
  return (actual.x === expected.x && actual.z === expected.z) || (actual.x === expected.z && actual.z === expected.x);
}

function checkOuter(scheme: DesignScheme, entries: readonly MustLedgerEntry[]): CheckResult {
  const group = entries.filter((entry) => entry.text.includes('外轮廓') && outlinePair(entry.text) !== null);
  const expected = group[0] === undefined ? null : outlinePair(group[0].text);
  if (expected === null) return NOTHING;
  const actual = span(scheme.site.buildingBounds);
  if (sameRectangle(actual, expected)) return { issues: [], checked: group };
  return {
    issues: [
      issue({
        code: `outer-${String(expected.x)}x${String(expected.z)}`,
        message: `建筑外轮廓 ${String(actual.x)}m×${String(actual.z)}m，不满足 must 的 ${String(expected.x)}m×${String(expected.z)}m。`,
        mustIds: group.map((entry) => entry.id),
        expected: `建筑外轮廓 ${String(expected.x)}m×${String(expected.z)}m（含外墙）`,
        actual: `${String(actual.x)}m×${String(actual.z)}m`,
        location: 'site.buildingBounds',
        options: [
          {
            id: 'resize-building-to-must',
            label: `把建筑外轮廓改为 ${String(expected.x)}×${String(expected.z)}m`,
            action: 'repair',
          },
          waiveOption('waive-outer-dimension-must', '明确豁免外轮廓尺寸 must'),
        ],
      }),
    ],
    checked: group,
  };
}

function checkInterior(scheme: DesignScheme, entries: readonly MustLedgerEntry[]): CheckResult {
  const group = entries.filter((entry) => /室内净(?:尺寸|面积)/u.test(entry.text) && outlinePair(entry.text) !== null);
  const expected = group[0] === undefined ? null : outlinePair(group[0].text);
  const room = scheme.spaces.find((space) => space.kind === 'room');
  const actual = interiorClear(scheme);
  if (expected === null || room === undefined || actual === null) return NOTHING;
  if (sameRectangle(actual, expected)) return { issues: [], checked: group };
  return {
    issues: [
      issue({
        code: `interior-${String(expected.x)}x${String(expected.z)}`,
        message: `室内 ${room.id} 净尺寸 ${String(actual.x)}m×${String(actual.z)}m，不满足 must 的 ${String(expected.x)}m×${String(expected.z)}m。`,
        mustIds: group.map((entry) => entry.id),
        expected: `室内净尺寸 ${String(expected.x)}m×${String(expected.z)}m`,
        actual: `${String(actual.x)}m×${String(actual.z)}m（${room.id}，按外墙内表面）`,
        location: `spaces.${room.id}`,
        options: [
          {
            id: 'resize-interior-to-must',
            label: `把主厅净尺寸改为 ${String(expected.x)}×${String(expected.z)}m`,
            action: 'repair',
          },
          waiveOption('waive-interior-dimension-must', '明确豁免室内净尺寸 must'),
        ],
      }),
    ],
    checked: group,
  };
}

function checkWallThickness(scheme: DesignScheme, entries: readonly MustLedgerEntry[]): CheckResult {
  const group = entries.filter((entry) => /外墙(?:厚度|厚)/u.test(entry.text) && wallThickness(entry.text) !== null);
  const expected = group[0] === undefined ? null : wallThickness(group[0].text);
  const walls = perimeterWalls(scheme);
  if (expected === null || walls.length === 0) return NOTHING;
  const bad = walls.filter(
    (wall) => actualWallThickness(wall) !== expected || (wall.thickness !== null && wall.thickness !== expected),
  );
  if (bad.length === 0) return { issues: [], checked: group };
  return {
    issues: [
      issue({
        code: `wall-thickness-${String(expected)}m`,
        message: `外墙厚度不满足 must 的 ${String(expected)}m。`,
        mustIds: group.map((entry) => entry.id),
        expected: `外墙厚 ${String(expected)}m`,
        actual: bad
          .map(
            (wall) =>
              `${wall.id} 声明 ${wall.thickness === null ? 'null' : `${String(wall.thickness)}m`} / 几何 ${String(actualWallThickness(wall))}m`,
          )
          .join('、'),
        location: `elements.${bad[0]?.id ?? 'wall'}.bounds`,
        options: [
          { id: 'set-wall-thickness-to-must', label: `把外墙改为 ${String(expected)}m 厚`, action: 'repair' },
          waiveOption('waive-wall-thickness-must', '明确豁免外墙厚度 must'),
        ],
      }),
    ],
    checked: group,
  };
}

function checkEntrance(scheme: DesignScheme, entries: readonly MustLedgerEntry[]): CheckResult {
  const specs = entries
    .filter(isEntranceMust)
    .map((entry) => ({ entry, spec: entranceSpec(entry.text) }))
    .filter((item): item is { readonly entry: MustLedgerEntry; readonly spec: EntranceSpec } => item.spec !== null);
  if (specs.length === 0) return NOTHING;
  const expectedSide = specs.find((item) => item.spec.side !== null)?.spec.side ?? null;
  const expectedWidth = specs.find((item) => item.spec.width !== null)?.spec.width ?? null;
  if (expectedSide === null) return NOTHING;
  const group = specs.map((item) => item.entry);
  const issues: SchemeGateIssue[] = [];
  if (scheme.site.entranceSide !== expectedSide) {
    issues.push(
      issue({
        code: `entrance-side-${expectedSide}`,
        message: `入口方位不满足 must：要求${SIDE_LABEL[expectedSide]}侧，方案 site.entranceSide 为${SIDE_LABEL[scheme.site.entranceSide]}侧。`,
        mustIds: group.map((entry) => entry.id),
        expected: `入口位于${SIDE_LABEL[expectedSide]}侧`,
        actual: `site.entranceSide=${scheme.site.entranceSide}`,
        location: 'site.entranceSide',
        options: [
          { id: 'move-entrance-to-must', label: `把入口改到${SIDE_LABEL[expectedSide]}侧`, action: 'repair' },
          waiveOption('waive-entrance-side-must', '明确豁免入口方位 must'),
        ],
      }),
    );
  }
  const opening = nonWindowOnSide(scheme, expectedSide);
  if (opening === undefined) {
    issues.push(
      issue({
        code: `entrance-missing-${expectedSide}`,
        message: `must 要求${SIDE_LABEL[expectedSide]}侧入口，但 scheme 在该侧没有非窗洞口。`,
        mustIds: group.map((entry) => entry.id),
        expected: `${SIDE_LABEL[expectedSide]}侧入口${expectedWidth === null ? '' : `净宽 ${String(expectedWidth)}m`}`,
        actual: `${SIDE_LABEL[expectedSide]}侧无非窗洞口`,
        location: 'openings',
        options: [
          { id: 'add-entrance-opening', label: `在${SIDE_LABEL[expectedSide]}侧补入口洞口`, action: 'repair' },
          waiveOption('waive-entrance-opening-must', '明确豁免入口洞口 must'),
        ],
      }),
    );
  } else if (expectedWidth !== null) {
    const actualWidth = openingWidth(opening);
    if (actualWidth !== expectedWidth) {
      issues.push(
        issue({
          code: `entrance-width-${String(expectedWidth)}m`,
          message: `入口 ${opening.id} 净宽 ${String(actualWidth)}m，不满足 must 的 ${String(expectedWidth)}m。`,
          mustIds: group.map((entry) => entry.id),
          expected: `入口净宽 ${String(expectedWidth)}m`,
          actual: `${String(actualWidth)}m（${opening.id}）`,
          location: `openings.${opening.id}.bounds`,
          options: [
            { id: 'resize-entrance-to-must', label: `把入口净宽改为 ${String(expectedWidth)}m`, action: 'repair' },
            waiveOption('waive-entrance-width-must', '明确豁免入口净宽 must'),
          ],
        }),
      );
    }
  }
  return { issues, checked: group };
}

function checkWindow(scheme: DesignScheme, entries: readonly MustLedgerEntry[]): CheckResult {
  const specs = entries
    .map((entry) => ({ entry, spec: windowSpec(entry.text) }))
    .filter((item): item is { readonly entry: MustLedgerEntry; readonly spec: WindowSpec } => item.spec !== null);
  if (specs.length === 0) return NOTHING;
  const expectedSide = specs.find((item) => item.spec.side !== null)?.spec.side ?? null;
  if (expectedSide === null) return NOTHING;
  const group = specs.map((item) => item.entry);
  const onSide = scheme.openings.filter((opening) => opening.side === expectedSide);
  const windows = byId(onSide.filter((opening) => opening.kind === 'window'));
  const otherOpenings = onSide.filter((opening) => opening.kind !== 'window');
  const issues: SchemeGateIssue[] = [];
  const sideLabel = SIDE_LABEL[expectedSide];
  if (windows.length === 0) {
    issues.push(
      issue({
        code: `window-${expectedSide}-missing`,
        message: `must 要求${sideLabel}侧窗，但 scheme 在${sideLabel}侧没有 window 洞口。`,
        mustIds: group.map((entry) => entry.id),
        expected: `${sideLabel}侧窗`,
        actual: `${sideLabel}侧无窗`,
        location: 'openings',
        options: [
          { id: 'add-window-to-must', label: `在${sideLabel}侧补窗`, action: 'repair' },
          waiveOption('waive-window-must', '明确豁免窗 must'),
        ],
      }),
    );
    return { issues, checked: group };
  }
  if (windows.length > 1) {
    issues.push(
      issue({
        code: `window-${expectedSide}-count`,
        message: `must 只允许一条${sideLabel}侧窗，scheme 有 ${String(windows.length)} 条。`,
        mustIds: group.map((entry) => entry.id),
        expected: `1 条${sideLabel}侧窗`,
        actual: `${String(windows.length)} 条：${windows.map((window) => window.id).join('、')}`,
        location: `openings.${windows[1]?.id ?? windows[0]?.id ?? 'window'}`,
        options: [
          { id: 'remove-extra-window', label: `删除多余的${sideLabel}侧窗`, action: 'repair' },
          waiveOption('waive-window-count-must', '明确豁免单窗 must'),
        ],
      }),
    );
  }
  if (otherOpenings.length > 0) {
    issues.push(
      issue({
        code: `window-${expectedSide}-extra-opening`,
        message: `${sideLabel}墙必须只有窗，不能有门或其它洞口。`,
        mustIds: group.map((entry) => entry.id),
        expected: `${sideLabel}墙唯一洞口是窗`,
        actual: otherOpenings.map((opening) => `${opening.id}（${opening.kind}）`).join('、'),
        location: `openings.${otherOpenings[0]?.id ?? 'opening'}`,
        options: [
          { id: 'remove-extra-opening', label: `删除${sideLabel}墙窗以外的洞口`, action: 'repair' },
          waiveOption('waive-window-only-must', '明确豁免“该侧只有窗” must'),
        ],
      }),
    );
  }
  const window = windows[0];
  if (window === undefined) return { issues, checked: group };
  const width = specs.find((item) => item.spec.width !== null)?.spec.width ?? null;
  const sill = specs.find((item) => item.spec.sill !== null)?.spec.sill ?? null;
  const height = specs.find((item) => item.spec.height !== null)?.spec.height ?? null;
  const head = specs.find((item) => item.spec.head !== null)?.spec.head ?? null;
  const actualWidth = openingWidth(window);
  const actualSill = window.bounds.min[1] - levelElevation(scheme, window.level);
  const actualHeight = window.bounds.max[1] - window.bounds.min[1];
  const actualHead = window.bounds.max[1] - levelElevation(scheme, window.level);
  if (width !== null && actualWidth !== width) {
    issues.push(
      issue({
        code: `window-${expectedSide}-${String(width)}m`,
        message: `${sideLabel}窗 ${window.id} 宽 ${String(actualWidth)}m，不满足 must 的 ${String(width)}m。`,
        mustIds: group.map((entry) => entry.id),
        expected: `${sideLabel}窗宽 ${String(width)}m`,
        actual: `${String(actualWidth)}m（${window.id}）`,
        location: `openings.${window.id}.bounds`,
        options: [
          { id: 'resize-window-to-must', label: `把${sideLabel}窗改为 ${String(width)}m 宽`, action: 'repair' },
          waiveOption('waive-window-width-must', '明确豁免窗宽 must'),
        ],
      }),
    );
  }
  if (sill !== null && actualSill !== sill) {
    issues.push(
      issue({
        code: `window-${expectedSide}-sill-${String(sill)}m`,
        message: `${sideLabel}窗 ${window.id} 窗台高 ${String(actualSill)}m，不满足 must 的 ${String(sill)}m。`,
        mustIds: group.map((entry) => entry.id),
        expected: `${sideLabel}窗台高 ${String(sill)}m（相对楼层标高）`,
        actual: `${String(actualSill)}m（${window.id}）`,
        location: `openings.${window.id}.bounds`,
        options: [
          { id: 'set-window-sill-to-must', label: `把窗台改为 ${String(sill)}m`, action: 'repair' },
          waiveOption('waive-window-sill-must', '明确豁免窗台高度 must'),
        ],
      }),
    );
  }
  if (height !== null && actualHeight !== height) {
    issues.push(
      issue({
        code: `window-${expectedSide}-height-${String(height)}m`,
        message: `${sideLabel}窗 ${window.id} 窗高 ${String(actualHeight)}m，不满足 must 的 ${String(height)}m。`,
        mustIds: group.map((entry) => entry.id),
        expected: `${sideLabel}窗高 ${String(height)}m`,
        actual: `${String(actualHeight)}m（${window.id}）`,
        location: `openings.${window.id}.bounds`,
        options: [
          { id: 'set-window-height-to-must', label: `把窗高改为 ${String(height)}m`, action: 'repair' },
          waiveOption('waive-window-height-must', '明确豁免窗高 must'),
        ],
      }),
    );
  }
  if (head !== null && actualHead !== head) {
    issues.push(
      issue({
        code: `window-${expectedSide}-head-${String(head)}m`,
        message: `${sideLabel}窗 ${window.id} 洞顶 ${String(actualHead)}m，不满足 must 的 ${String(head)}m。`,
        mustIds: group.map((entry) => entry.id),
        expected: `${sideLabel}窗洞顶 ${String(head)}m（相对楼层标高）`,
        actual: `${String(actualHead)}m（${window.id}）`,
        location: `openings.${window.id}.bounds`,
        options: [
          { id: 'set-window-head-to-must', label: `把洞顶改为 ${String(head)}m`, action: 'repair' },
          waiveOption('waive-window-head-must', '明确豁免洞顶高度 must'),
        ],
      }),
    );
  }
  return { issues, checked: group };
}

function checkRoof(scheme: DesignScheme, entries: readonly MustLedgerEntry[]): CheckResult {
  const specs = entries
    .map((entry) => ({ entry, spec: roofSpec(entry.text) }))
    .filter((item): item is { readonly entry: MustLedgerEntry; readonly spec: RoofSpec } => item.spec !== null);
  if (specs.length === 0) return NOTHING;
  const expectedForm = specs.find((item) => item.spec.form !== null)?.spec.form ?? null;
  const expectedPitch = specs.find((item) => item.spec.pitch !== null)?.spec.pitch ?? null;
  if (expectedForm === null && expectedPitch === null) return NOTHING;
  const group = specs.map((item) => item.entry);
  const forms = [scheme.roof.form, ...(scheme.roof.segments?.map((segment) => segment.form) ?? [])];
  const pitches = [scheme.roof.pitchDegrees, ...(scheme.roof.segments?.map((segment) => segment.pitchDegrees) ?? [])];
  const issues: SchemeGateIssue[] = [];
  if (expectedForm !== null && forms.some((form) => form !== expectedForm)) {
    issues.push(
      issue({
        code: `roof-form-${expectedForm}`,
        message: `屋面形式为 ${forms.join('、')}，不满足 must 的 ${expectedForm}。`,
        mustIds: group.map((entry) => entry.id),
        expected: `屋面形式 ${expectedForm}`,
        actual: forms.join('、'),
        location: 'roof.form',
        options: [
          { id: 'set-roof-form-to-must', label: `把屋面改为 ${expectedForm}`, action: 'repair' },
          waiveOption('waive-roof-form-must', '明确豁免屋面形式 must'),
        ],
      }),
    );
  }
  const pitchOk = (pitch: number): boolean =>
    expectedPitch === null
      ? expectedForm === 'flat' || pitch > 0
      : expectedPitch.approximate
        ? Math.abs(pitch - expectedPitch.value) <= 5
        : pitch === expectedPitch.value;
  if (pitches.some((pitch) => !pitchOk(pitch))) {
    const expectedText =
      expectedPitch === null
        ? `坡度 > 0°（${String(expectedForm)}）`
        : `坡度 ${expectedPitch.approximate ? '约 ' : ''}${String(expectedPitch.value)}°`;
    issues.push(
      issue({
        code: 'roof-pitch',
        message: `屋面坡度 ${pitches.map((pitch) => `${String(pitch)}°`).join('、')}，不满足 must 的 ${expectedText}。`,
        mustIds: group.map((entry) => entry.id),
        expected: expectedText,
        actual: pitches.map((pitch) => `${String(pitch)}°`).join('、'),
        location: 'roof.pitchDegrees',
        options: [
          { id: 'set-roof-pitch-to-must', label: '把屋面坡度改为 must 要求的范围', action: 'repair' },
          waiveOption('waive-roof-pitch-must', '明确豁免屋面坡度 must'),
        ],
      }),
    );
  }
  return { issues, checked: group };
}

function materialOf(scheme: DesignScheme, reference: string) {
  return (
    scheme.materials.find((material) => material.id === reference) ??
    scheme.materials.find((material) => material.name === reference)
  );
}

function isWood(block: string): boolean {
  return /(?:planks?|log|wood|stem|bamboo|hyphae)/iu.test(block);
}

function isStoneBase(block: string): boolean {
  return (
    /(?:stone|cobble|brick|andesite|granite|diorite|blackstone|tuff|basalt|calcite)/iu.test(block) &&
    !/tiles?/iu.test(block)
  );
}

function isDarkColor(color: string | null): boolean {
  const match = color === null ? null : /^#([0-9a-f]{6})$/iu.exec(color);
  const hex = match?.[1];
  if (hex === undefined) return false;
  const value = Number.parseInt(hex, 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return 0.299 * red + 0.587 * green + 0.114 * blue < 128;
}

function isDarkTile(material: {
  readonly block: string;
  readonly name: string;
  readonly color: string | null;
}): boolean {
  if (!/(?:tiles?|shingles?)/iu.test(material.block)) return false;
  if (isDarkColor(material.color)) return true;
  return /(?:deepslate|blackstone|basalt|dark|深|黑|暗)/iu.test(`${material.block} ${material.name}`);
}

function materialMusts(entries: readonly MustLedgerEntry[], pattern: RegExp, allowGeometry = false): MustLedgerEntry[] {
  return entries.filter(
    (entry) =>
      pattern.test(entry.text) && (entry.check === 'material' || (allowGeometry && entry.check === 'geometry')),
  );
}

function checkStoneBase(scheme: DesignScheme, group: readonly MustLedgerEntry[]): CheckResult {
  if (group.length === 0 || scheme.facades.length === 0) return NOTHING;
  const bases = scheme.facades.map((facade) => ({ facade, material: materialOf(scheme, facade.baseMaterialId) }));
  const bad = bases.filter(({ material }) => material === undefined || !isStoneBase(material.block));
  if (bad.length === 0) return { issues: [], checked: group };
  return {
    issues: [
      issue({
        code: 'material-stone-base',
        message: '石基座必须：立面基座材质必须是石质。',
        mustIds: group.map((entry) => entry.id),
        expected: '所有立面基座为石质',
        actual: bases.map(({ facade, material }) => `${facade.side}:${material?.block ?? '缺失'}`).join('、'),
        location: 'facades',
        options: [
          { id: 'set-stone-base-materials', label: '把立面基座材质改为石材', action: 'repair' },
          waiveOption('waive-stone-base-must', '明确豁免石基座 must'),
        ],
      }),
    ],
    checked: group,
  };
}

function checkWoodWallColumn(scheme: DesignScheme, group: readonly MustLedgerEntry[]): CheckResult {
  if (group.length === 0 || scheme.facades.length === 0) return NOTHING;
  const walls = perimeterWalls(scheme);
  if (walls.length === 0) return NOTHING;
  const bodies = scheme.facades.map((facade) => ({ facade, material: materialOf(scheme, facade.bodyMaterialId) }));
  const wallMaterials = walls.map((wall) => ({ wall, material: materialOf(scheme, wall.material) }));
  const columns = scheme.elements
    .filter((element) => element.kind === 'column')
    .map((column) => ({ column, material: materialOf(scheme, column.material) }));
  const structureMaterial = materialOf(scheme, scheme.structure.material);
  const problems: string[] = [];
  if (bodies.some(({ material }) => material === undefined || !isWood(material.block))) {
    problems.push(`墙身不是木质：${bodies.map(({ material }) => material?.block ?? '缺失').join('、')}`);
  }
  if (wallMaterials.some(({ material }) => material === undefined || !isWood(material.block))) {
    problems.push(`外墙不是木质：${wallMaterials.map(({ material }) => material?.block ?? '缺失').join('、')}`);
  }
  if (columns.some(({ material }) => material === undefined || !isWood(material.block))) {
    problems.push(`柱不是木质：${columns.map(({ material }) => material?.block ?? '缺失').join('、')}`);
  }
  if (structureMaterial !== undefined && !isWood(structureMaterial.block)) {
    problems.push(`结构材料不是木质：${structureMaterial.block}`);
  }
  if (problems.length === 0) return { issues: [], checked: group };
  return {
    issues: [
      issue({
        code: 'material-wood-wall-column',
        message: `木墙木柱必须：${problems.join('；')}。`,
        mustIds: group.map((entry) => entry.id),
        expected: '木墙（墙身与外墙）与木柱',
        actual: problems.join('；'),
        location: 'facades、elements.wall、elements.column',
        options: [
          { id: 'set-wood-wall-materials', label: '把墙身、外墙与柱改为木材', action: 'repair' },
          waiveOption('waive-wood-wall-column-must', '明确豁免木墙木柱 must'),
        ],
      }),
    ],
    checked: group,
  };
}

function checkDarkTileRoof(scheme: DesignScheme, group: readonly MustLedgerEntry[]): CheckResult {
  if (group.length === 0) return NOTHING;
  const roofMaterial = materialOf(scheme, scheme.roof.material);
  if (roofMaterial !== undefined && isDarkTile(roofMaterial)) return { issues: [], checked: group };
  return {
    issues: [
      issue({
        code: 'material-dark-tile-roof',
        message: '深色瓦屋面必须：屋面材质必须是深色瓦。',
        mustIds: group.map((entry) => entry.id),
        expected: '深色瓦屋面',
        actual: roofMaterial?.block ?? '缺失',
        location: 'roof.material',
        options: [
          { id: 'set-dark-tile-roof-material', label: '把屋面材质改为深色瓦', action: 'repair' },
          waiveOption('waive-dark-tile-roof-must', '明确豁免深色瓦屋面 must'),
        ],
      }),
    ],
    checked: group,
  };
}

function checkMaterials(scheme: DesignScheme, entries: readonly MustLedgerEntry[]): CheckResult[] {
  return [
    checkStoneBase(scheme, materialMusts(entries, /石基座|石材基座|石基/u)),
    checkWoodWallColumn(scheme, materialMusts(entries, /木墙|木柱|木结构|木质墙|木材/u)),
    checkDarkTileRoof(scheme, materialMusts(entries, /深色?瓦|深瓦|瓦屋面|瓦屋顶/u, true)),
  ];
}

/** 纯函数：scheme + requirements（或现成 ledger）→ 语义门报告。 */
export function verifySchemeAgainstRequirements(
  scheme: DesignScheme,
  requirements: RequirementGraph,
  ledger: MustLedger = buildMustLedger(requirements),
): SchemeGateReport {
  const entries = mustEntries(ledger);
  const furniture = allFurniture(scheme);
  const tables = furniture.filter((item) => item.kind === 'table');
  const chairs = furniture.filter((item) => item.kind === 'chair');
  const benches = furniture.filter((item) => item.kind === 'bench');
  const counters = furniture.filter((item) => item.kind === 'counter');

  const tableEntry = tableMust(entries);
  const seatEntry = seatMust(entries);
  const benchEntries = benchMusts(entries);
  const doorEntries = doorClearMusts(entries);
  const counterEntry = counterMust(entries);
  const issues: SchemeGateIssue[] = [];
  const checkedEntries: MustLedgerEntry[] = [];

  const table = tables[0];
  if (tableEntry !== undefined) {
    checkedEntries.push(tableEntry);
    const expected = dimensionPair(tableEntry.text, '宽');
    if (table === undefined) {
      issues.push(
        issue({
          code: 'table-missing',
          message: 'must 要求长桌，但 scheme 没有 table 家具。',
          mustIds: [tableEntry.id],
          expected: '一张长桌',
          actual: '无 table 家具',
          location: 'interiors.furnitureSpecs',
          options: [
            { id: 'add-table', label: '补一张符合 must 的长桌', action: 'repair' },
            waiveOption('waive-table-must', '明确豁免长桌 must'),
          ],
        }),
      );
    } else if (expected !== null) {
      const mismatch = tableIssue(table, tableEntry, expected);
      if (mismatch !== null) issues.push(mismatch);
    }
  }

  const benchPool = [...benches];
  for (const benchEntry of benchEntries) {
    checkedEntries.push(benchEntry);
    const expected = dimensionPair(benchEntry.text, '宽');
    if (expected === null) continue;
    const matchedIndex = benchPool.findIndex((bench) => furnitureSpanMatches(bench, expected));
    if (matchedIndex >= 0) {
      benchPool.splice(matchedIndex, 1);
    } else if (benchPool.length === 0) {
      issues.push(
        missingFurnitureIssue('bench', benchEntry, `长凳 ${String(expected.length)}m×${String(expected.width)}m`),
      );
    } else {
      issues.push(benchDimensionIssue(benchEntry, expected, benchPool[0]));
    }
  }

  if (seatEntry !== undefined) {
    checkedEntries.push(seatEntry);
    const chairMismatch = chairIssue(chairs, seatEntry);
    if (chairMismatch !== null) issues.push(chairMismatch);
    if (benches.length < 2) {
      issues.push(
        issue({
          code: 'seating-missing',
          message: `5+5 座位需要两条长凳，但 scheme 只有 ${String(benches.length)} 条。`,
          mustIds: [seatEntry.id],
          expected: '两条长凳（5+5 共 10 座）',
          actual: `${String(benches.length)} 条长凳`,
          location: 'interiors.furnitureSpecs',
          options: [
            { id: 'add-benches', label: '补齐两条 4×1m 长凳', action: 'repair' },
            waiveOption('waive-seat-must', '明确豁免 5+5 座位 must'),
          ],
        }),
      );
    }
  }

  const doorMismatch = doorClearanceIssue(scheme, doorEntries, furniture);
  if (doorMismatch !== null) issues.push(doorMismatch);
  checkedEntries.push(...doorEntries);

  const counter = counters[0];
  if (counterEntry !== undefined) {
    checkedEntries.push(counterEntry);
    const expected = dimensionPair(counterEntry.text, '深');
    if (counter === undefined) {
      issues.push(
        missingFurnitureIssue(
          'counter',
          counterEntry,
          expected === null ? '柜台' : `柜台 ${String(expected.length)}m×${String(expected.width)}m`,
        ),
      );
    } else if (expected !== null && !counterSpanMatches(counter, expected)) {
      issues.push(counterDimensionIssue(counterEntry, expected, counter));
    }
  }
  if (table !== undefined && counter !== undefined && counterEntry !== undefined) {
    const counterMismatch = counterTableIssue(table, counter, [
      counterEntry,
      ...(tableEntry === undefined ? [] : [tableEntry]),
    ]);
    if (counterMismatch !== null) issues.push(counterMismatch);
  }

  const structuralChecks = [
    checkOuter(scheme, entries),
    checkInterior(scheme, entries),
    checkWallThickness(scheme, entries),
    checkEntrance(scheme, entries),
    checkWindow(scheme, entries),
    checkRoof(scheme, entries),
    ...checkMaterials(scheme, entries),
  ];
  for (const check of structuralChecks) {
    issues.push(...check.issues);
    checkedEntries.push(...check.checked);
  }

  const checked = uniqueIds(checkedEntries);
  const checkedSet = new Set(checked);
  const unchecked = entries.filter((entry) => !checkedSet.has(entry.id)).map((entry) => entry.id);
  const counts = {
    blocking: issues.filter((entry) => entry.severity === 'blocking').length,
    warning: issues.filter((entry) => entry.severity === 'warning').length,
    unverified: issues.filter((entry) => entry.severity === 'unverified').length,
    total: issues.length,
  };
  return SchemeGateReport.parse({
    passed: counts.blocking === 0,
    issues,
    checkedMustIds: checked,
    uncheckedMustIds: unchecked,
    counts,
  });
}

/** 供 session issue 字符串使用：保留 code / must ids / expected / actual / options。 */
export function formatSchemeGateIssue(issueValue: SchemeGateIssue): string {
  const options = issueValue.options.map((option) => option.id).join('、');
  return `[${issueValue.code}] ${issueValue.message} must=${issueValue.mustIds.join('、')} expected=${issueValue.expected} actual=${issueValue.actual} options=${options}`;
}
