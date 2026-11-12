/**
 * 骨架门槛（AGENT-SPEC §5.1，决策 #94）：宿主按配置文件对每次成功的 check 做客观判定。
 *
 * 负责：解析门槛配置（zod schema），用已有的测量结果判定六类门槛（forbidApis / symmetry / structureSpans /
 *   reachAll / reachInsideWalls / floatingAllowApis），生成未过项的模型可见文本行。
 * 不负责：读配置文件（真实 I/O 在 cli-deps.ts）、计算测量（@pg/analysis）、决定 submit 是否拒绝（tools/submit.ts）。
 * 本文件是纯函数文件：只 import 纯入口（analysis / blocks/registry），grid 只 import type。
 */

import { measureFloating } from '@pg/analysis/floating';
import { measureReach, standableTester } from '@pg/analysis/reach';
import type { ReachReport } from '@pg/analysis/reach';
import type { ReachTargets } from '@pg/analysis/reach-targets';
import type { SymmetryReport } from '@pg/analysis/symmetry';
import type { BlockRegistry } from '@pg/blocks/registry';
import type { CallDef, Grid } from '@pg/core/grid';
import { z } from 'zod';

/** 只有坐标的格，形如 @pg/analysis 的 Cell；measureReach / standableTester 的输入输出都用它。 */
interface WallPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 配置里能读到的顶层厚度：只在 calls 的 args 是合法 JSON 且顶层 thickness 是 ≥1 整数时用。 */
const wallThicknessSchema = z.object({ thickness: z.number().int().min(1).optional() });

/**
 * 结构类 api（AGENT-SPEC §5.1）：structureSpans 统计 x / z 跨度时只看这些调用的格。写死在代码里，
 * 新增结构构件时同步这里与规格。
 */
const STRUCTURE_APIS: ReadonlySet<string> = new Set([
  'walls',
  'roof',
  'floorPlate',
  'colonnade',
  'stair',
  'steps',
  'enclosure',
]);

/**
 * 决定建筑占地（footprint）的语义 api：只要存档里出现过其中任意一个调用，structureSpans 就只量这些调用的格，
 * 不再把屋顶挑檐算进跨度。roof 的 overhang 是合法出檐，不能反过来把墙的跨度判大。
 * 没有任何 footprint 调用时退回 {@link STRUCTURE_APIS}，保留旧的 roof-only / stair-only 行为。
 */
const FOOTPRINT_APIS: ReadonlySet<string> = new Set(['walls', 'floorPlate', 'enclosure', 'colonnade']);

/** 包络来源 warning 的统一前缀；check_code 把它原样放进模型可见文本，不参与门槛与 submit。 */
const ENVELOPE_WARNING_PREFIX = '包络来源（warning，不拦截）：';

/** 门槛配置（`--gates <path>` 的 JSON）；六个字段都可选，都不设等同于不带 `--gates`（AGENT-SPEC §5.1）。 */
export const gatesSchema = z.strictObject({
  /** 存档实体格与挖空记录的来源 api 里出现即失败。 */
  forbidApis: z.array(z.string().min(1)).optional(),
  /** 用 measureSymmetry 按 axis（可选 at）找轴；轴不存在或 matched / cells < min 失败。 */
  symmetry: z
    .strictObject({
      axis: z.enum(['x', 'z']),
      /** 镜面位置，整数或 .5；与 world.mirror 的 at 同义。 */
      at: z
        .number()
        .refine((v) => Number.isInteger(v * 2), 'at 必须是整数或 .5')
        .optional(),
      min: z.number().gt(0).lte(1),
    })
    .optional(),
  /** 结构类构件的格在 x、z 轴上的跨度（max-min+1）必须落在给定闭区间内；两轴都必填。 */
  structureSpans: z
    .strictObject({ x: z.tuple([z.number(), z.number()]), z: z.tuple([z.number(), z.number()]) })
    .refine((s) => s.x[0] <= s.x[1] && s.z[0] <= s.z[1], '结构跨度下限必须 ≤ 上限')
    .optional(),
  /** 要求每个可达目标都能到，且没有 missing。 */
  reachAll: z.boolean().optional(),
  /** 每段有内部的 walls 调用，内部低层至少有一个能走到的站立点；能走进去的段数比例 ≥ minRatio 才过。 */
  reachInsideWalls: z.strictObject({ minRatio: z.number().gt(0).lte(1) }).optional(),
  /** 用 measureFloating 以"来源 api 在允许列表里"为 tag 重算；空数组 = 不允许任何悬空。 */
  floatingAllowApis: z.array(z.string().min(1)).optional(),
  /**
   * 实验指定区域的实际存活格来源。格数与来源比例只统计 bounds 内的实体格；"顶面匹配列"针对区域内
   * 每个出现过实体格的 (x,z) 列，取整张 grid 的真正最高格（含 bounds 上方 y > maxY 的遮挡），
   * 只有该最高格仍在 bounds 内且来源在 apis 里才算一列匹配。区域外 x,z 与区域内没有实体格的列
   * 既不算格也不算列；空区域必然失败。
   */
  sourceRegions: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        bounds: z
          .tuple([
            z.number().int(),
            z.number().int(),
            z.number().int(),
            z.number().int(),
            z.number().int(),
            z.number().int(),
          ])
          .refine((b) => b[0] <= b[3] && b[1] <= b[4] && b[2] <= b[5], '区域最小值必须 ≤ 最大值'),
        apis: z.array(z.string().min(1)).min(1),
        minCells: z.number().int().positive(),
        minColumns: z.number().int().positive(),
        minRatio: z.number().gt(0).lte(1),
      }),
    )
    .optional(),
});

export type GateConfig = z.infer<typeof gatesSchema>;

/**
 * 判定结果：是否全过、未过项的中文说明
 * （顺序固定：forbidApis → symmetry → structureSpans → reachAll → reachInsideWalls → floatingAllowApis）。
 */
export interface GateOutcome {
  readonly passed: boolean;
  readonly failed: readonly string[];
}

/** evaluateGates 的输入：判定用到的测量结果都在这里，由 check_code 汇总（AGENT-SPEC §5.1）。 */
export interface GateInput {
  readonly grid: Grid;
  /** 存档调用表；来源 api 查表与 floating 的允许 call 集合都从这里来。 */
  readonly calls: readonly CallDef[];
  readonly symmetry: SymmetryReport;
  readonly reach: ReachReport;
  readonly reachTargets: ReachTargets;
  /** 方块注册表；reachInsideWalls 要自己调 measureReach / standableTester。 */
  readonly registry: BlockRegistry;
}

/** 按"设了且生效"的门槛项计数（reachAll: false 不生效，不计入）。 */
export function configuredGateCount(config: GateConfig): number {
  return (
    (config.forbidApis === undefined ? 0 : 1) +
    (config.symmetry === undefined ? 0 : 1) +
    (config.structureSpans === undefined ? 0 : 1) +
    (config.reachAll === true ? 1 : 0) +
    (config.reachInsideWalls === undefined ? 0 : 1) +
    (config.floatingAllowApis === undefined ? 0 : 1) +
    (config.sourceRegions?.length ?? 0)
  );
}

/** 百分数写法：去掉无意义的小数零，如 0.99 → 99、0.995 → 99.5。 */
function percent(n: number): string {
  return String(Number((n * 100).toFixed(1)));
}

/** forbidApis：实体格与挖空记录的来源 api 命中即分别计数，返回失败文案；没有命中返回 undefined。 */
function evaluateForbidApis(apis: readonly string[], input: GateInput): string | undefined {
  const forbidden = new Set(apis);
  const apiById = new Map(input.calls.map((c) => [c.id, c.api]));
  const counts = new Map<string, number>();
  const bump = (callId: number): void => {
    const api = apiById.get(callId);
    if (api !== undefined && forbidden.has(api)) counts.set(api, (counts.get(api) ?? 0) + 1);
  };
  for (const c of input.grid.cells()) bump(c.call);
  for (const c of input.grid.carved()) bump(c.call);
  if (counts.size === 0) return undefined;
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (sorted.length === 1) {
    const [api, n] = sorted[0] ?? ['?', 0];
    return `只用构件：${api} 共 ${String(n)} 格写入`;
  }
  const top = sorted
    .slice(0, 2)
    .map(([api, n]) => `${api} ${String(n)} 格`)
    .join('、');
  return `只用构件：${top}`;
}

/** symmetry：按 axis（可选 at）找轴；轴不存在或 matched / cells < min 失败。 */
function evaluateSymmetry(cfg: NonNullable<GateConfig['symmetry']>, report: SymmetryReport): string | undefined {
  const found = report.axes.find((a) => a.axis === cfg.axis && (cfg.at === undefined || a.at === cfg.at));
  if (found === undefined) {
    const at = cfg.at === undefined ? '' : `（镜面 ${String(cfg.at)}）`;
    return `左右对称：没有 ${cfg.axis} 轴${at}的测量`;
  }
  if (found.matched / found.cells < cfg.min) {
    return `左右对称：实体对上 ${((found.matched / found.cells) * 100).toFixed(1)}%，要求 ≥ ${percent(cfg.min)}%`;
  }
  return undefined;
}

/**
 * structureSpans：结构类调用的格在 x、z 轴上的跨度（max-min+1）超出给定闭区间即失败；没有结构格时通过。
 * 有 footprint 调用（walls / floorPlate / enclosure / colonnade）时只量 footprint，屋顶挑檐不算跨度；
 * 没有 footprint 调用时才退回 STRUCTURE_APIS，保证旧的 roof-only / stair-only 行为不变。
 */
function evaluateStructureSpans(cfg: NonNullable<GateConfig['structureSpans']>, input: GateInput): string | undefined {
  const hasFootprint = input.calls.some((c) => FOOTPRINT_APIS.has(c.api));
  const apis = hasFootprint ? FOOTPRINT_APIS : STRUCTURE_APIS;
  const structure = new Set(input.calls.filter((c) => apis.has(c.api)).map((c) => c.id));
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let seen = false;
  for (const c of input.grid.cells()) {
    if (!structure.has(c.call)) continue;
    seen = true;
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.z < minZ) minZ = c.z;
    if (c.z > maxZ) maxZ = c.z;
  }
  if (!seen) return undefined;
  const spanX = maxX - minX + 1;
  const spanZ = maxZ - minZ + 1;
  const parts: string[] = [];
  if (spanX < cfg.x[0] || spanX > cfg.x[1])
    parts.push(`x ${String(spanX)} 不在 ${String(cfg.x[0])}–${String(cfg.x[1])}`);
  if (spanZ < cfg.z[0] || spanZ > cfg.z[1])
    parts.push(`z ${String(spanZ)} 不在 ${String(cfg.z[0])}–${String(cfg.z[1])}`);
  if (parts.length === 0) return undefined;
  return `结构跨度：${parts.join('、')}`;
}

/**
 * 包络来源 lint（report-only）：检查楼板 / 围护 / 屋面是否来自语义构件，而不是 set / box 手写。
 * 只读调用表，顺序固定（walls → floorPlate → roof），最多三条；每条都带统一前缀，方便模型与宿主识别。
 * 不参与 evaluateGates / submit / CheckResult.status：它只是 warning，不能变成第二个暗门。
 */
export function envelopeProvenanceWarnings(calls: readonly CallDef[]): readonly string[] {
  const apis = new Set(calls.map((call) => call.api));
  const manual = apis.has('set') || apis.has('box');
  const warnings: string[] = [];
  if (!apis.has('walls') && manual)
    warnings.push(`${ENVELOPE_WARNING_PREFIX}未检测到 walls；围护由 set/box 手写，墙面无法与语义对象对齐。`);
  if (!apis.has('floorPlate'))
    warnings.push(`${ENVELOPE_WARNING_PREFIX}未检测到 floorPlate；楼板 / 站立面来源无法与语义对象对齐。`);
  if (!apis.has('roof') && (manual || apis.has('stair') || apis.has('stairs')))
    warnings.push(
      `${ENVELOPE_WARNING_PREFIX}未检测到 roof；屋面由 stairs/set/box 手写，形式与坡度无法与语义对象对齐。`,
    );
  return warnings.slice(0, 3);
}

/** reachAll：任何目标到不了或 missing 非空即失败；两段都没有就省略。 */
function evaluateReachAll(reach: ReachReport, reachTargets: ReachTargets): string | undefined {
  const unreached = reach.targets.filter((t) => !t.reached).length;
  const missing = reachTargets.missing.length;
  if (unreached === 0 && missing === 0) return undefined;
  const parts: string[] = [];
  if (unreached > 0) parts.push(`${String(unreached)} 个目标到不了`);
  if (missing > 0) parts.push(`${String(missing)} 个目标没有站立点`);
  return `可达：${parts.join('、')}`;
}

/** 站立点的稳定键，用于把 measureReach 的 targets 结果映射回墙段。 */
function cellKey(c: WallPoint): string {
  return `${String(c.x)},${String(c.y)},${String(c.z)}`;
}

/** 读 walls 调用 args 的顶层 thickness；不是合法 JSON、没有这个键或不是 ≥1 整数时按默认墙厚 1。 */
function wallInset(args: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    // core 截断后的 args 以 `…` 结尾，不是合法 JSON；按默认墙厚处理。
    return 1;
  }
  const result = wallThicknessSchema.safeParse(parsed);
  return result.success ? (result.data.thickness ?? 1) : 1;
}

/**
 * reachInsideWalls：每段有内部的 walls 调用，内部低层至少有一个能走到的站立点。
 * 内部 = 该调用格包围盒的 x / z 向内缩墙厚（读不出时缩 1）；y = 最小 y 到 min(最小 y + 4, 最大 y)。
 * 按 (y, x, z) 升序每段最多取 5 个站立点；找不到站立点的墙跳过，不计入分母。所有点合成一次 measureReach。
 */
function evaluateReachInsideWalls(
  cfg: NonNullable<GateConfig['reachInsideWalls']>,
  input: GateInput,
): string | undefined {
  const wallCalls = input.calls.filter((c) => c.api === 'walls');
  if (wallCalls.length === 0) return undefined;
  const wallIds = new Set(wallCalls.map((c) => c.id));
  const cellsByCall = new Map<number, WallPoint[]>();
  for (const c of input.grid.cells()) {
    if (!wallIds.has(c.call)) continue;
    const list = cellsByCall.get(c.call);
    if (list === undefined) cellsByCall.set(c.call, [c]);
    else list.push(c);
  }
  const standable = standableTester(input.grid, input.registry);
  const segments: { readonly call: CallDef; readonly points: readonly WallPoint[] }[] = [];
  const allPoints: WallPoint[] = [];
  for (const call of wallCalls) {
    const cells = cellsByCall.get(call.id);
    if (cells === undefined || cells.length === 0) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const c of cells) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
      if (c.z < minZ) minZ = c.z;
      if (c.z > maxZ) maxZ = c.z;
    }
    const inset = wallInset(call.args);
    const x0 = minX + inset;
    const x1 = maxX - inset;
    const z0 = minZ + inset;
    const z1 = maxZ - inset;
    if (x0 > x1 || z0 > z1) continue;
    const yHi = Math.min(minY + 4, maxY);
    const points: WallPoint[] = [];
    for (let y = minY; y <= yHi && points.length < 5; y += 1)
      for (let x = x0; x <= x1 && points.length < 5; x += 1)
        for (let z = z0; z <= z1 && points.length < 5; z += 1) {
          const cell = { x, y, z };
          if (standable(cell)) points.push(cell);
        }
    if (points.length === 0) continue;
    segments.push({ call, points });
    allPoints.push(...points);
  }
  if (segments.length === 0) return undefined;
  const report = measureReach(input.grid, input.registry, { targets: allPoints });
  const reachedByKey = new Map(report.targets.map((t) => [cellKey(t.cell), t.reached]));
  let reachedSegments = 0;
  const unreached: CallDef[] = [];
  for (const seg of segments) {
    if (seg.points.some((p) => reachedByKey.get(cellKey(p)) === true)) reachedSegments += 1;
    else unreached.push(seg.call);
  }
  if (reachedSegments / segments.length >= cfg.minRatio) return undefined;
  const listed = unreached
    .slice(0, 3)
    .map((c) => `walls#${String(c.id)} 第 ${String(c.line)} 行`)
    .join('、');
  const more = unreached.length > 3 ? `…另 ${String(unreached.length - 3)} 段` : '';
  return `可进入：${String(segments.length)} 段围合墙里 ${String(unreached.length)} 段走不进去（${listed}${more}）`;
}

/** floatingAllowApis：以"来源 api 在允许列表里"为 tag 重算，统计不属于允许来源的悬空格数。 */
function evaluateFloatingAllowApis(allow: readonly string[], input: GateInput): string | undefined {
  const allowedApis = new Set(allow);
  const allowed = new Set(input.calls.filter((c) => allowedApis.has(c.api)).map((c) => c.id));
  const report = measureFloating(input.grid, { tag: (c) => allowed.has(c.call) });
  let bad = 0;
  for (const g of report.groups) if (g.tagged < g.cells) bad += g.cells - g.tagged;
  if (bad === 0) return undefined;
  if (allow.length === 0) return `悬空：${String(bad)} 格不属于任何允许来源`;
  return `悬空：${String(bad)} 格不属于 [${allow.join('、')}]`;
}

/** 判定全部门槛；failed 顺序固定，配置里没设（或未生效）的项跳过。 */
export function evaluateGates(config: GateConfig, input: GateInput): GateOutcome {
  const failed: string[] = [];
  if (config.forbidApis !== undefined) {
    const msg = evaluateForbidApis(config.forbidApis, input);
    if (msg !== undefined) failed.push(msg);
  }
  if (config.symmetry !== undefined) {
    const msg = evaluateSymmetry(config.symmetry, input.symmetry);
    if (msg !== undefined) failed.push(msg);
  }
  if (config.structureSpans !== undefined) {
    const msg = evaluateStructureSpans(config.structureSpans, input);
    if (msg !== undefined) failed.push(msg);
  }
  if (config.reachAll === true) {
    const msg = evaluateReachAll(input.reach, input.reachTargets);
    if (msg !== undefined) failed.push(msg);
  }
  if (config.reachInsideWalls !== undefined) {
    const msg = evaluateReachInsideWalls(config.reachInsideWalls, input);
    if (msg !== undefined) failed.push(msg);
  }
  if (config.floatingAllowApis !== undefined) {
    const msg = evaluateFloatingAllowApis(config.floatingAllowApis, input);
    if (msg !== undefined) failed.push(msg);
  }
  // 先一遍全 grid：每个 (x,z) 列只留真正最高格的 y 与来源调用，bounds 上方的遮挡也在这张表里。
  const topCells = new Map<string, { readonly y: number; readonly call: number }>();
  for (const c of input.grid.cells()) {
    const key = `${String(c.x)},${String(c.z)}`;
    const top = topCells.get(key);
    if (top === undefined || c.y > top.y) topCells.set(key, { y: c.y, call: c.call });
  }
  for (const region of config.sourceRegions ?? []) {
    const allowed = new Set(input.calls.filter((c) => region.apis.includes(c.api)).map((c) => c.id));
    const [x0, y0, z0, x1, y1, z1] = region.bounds;
    // 格数与来源比例：只统计 bounds 内的实体格。
    let cells = 0;
    let matched = 0;
    // 列分母：bounds 内出现过实体格的 (x,z)；区域外 x,z 与区域内没有实体格的列都不计入。
    const columns = new Set<string>();
    for (const c of input.grid.cells()) {
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1 || c.z < z0 || c.z > z1) continue;
      cells += 1;
      if (allowed.has(c.call)) matched += 1;
      columns.add(`${String(c.x)},${String(c.z)}`);
    }
    // 匹配列：该列真正最高格仍在 bounds 内（列里已有一个区域内格，所以只需 y ≤ maxY）且来源在 apis 里。
    let matchedColumns = 0;
    for (const key of columns) {
      const top = topCells.get(key);
      if (top !== undefined && top.y <= y1 && allowed.has(top.call)) matchedColumns += 1;
    }
    const ratio = cells === 0 ? 0 : matched / cells;
    const topRatio = columns.size === 0 ? 0 : matchedColumns / columns.size;
    if (
      matched < region.minCells ||
      matchedColumns < region.minColumns ||
      ratio < region.minRatio ||
      topRatio < region.minRatio
    ) {
      failed.push(
        `来源区域 ${region.name}：${region.apis.join('/')} 存活 ${String(matched)}/${String(cells)} 格、顶面 ${String(matchedColumns)}/${String(columns.size)} 列；要求至少 ${String(region.minCells)} 格、${String(region.minColumns)} 列，格与顶面来源占比均 ≥ ${percent(region.minRatio)}%`,
      );
    }
  }
  return { passed: failed.length === 0, failed };
}

/**
 * 门槛文本（AGENT-SPEC §5.1）：全过时一行；未过时首行给 N/M 与拒绝提示，随后每个未过项一行 `  ✗ …`。
 * `total` 是配置里设了且生效的项数（`configuredGateCount`）。
 */
export function gatesLines(_config: GateConfig, outcome: GateOutcome, total: number): string[] {
  if (outcome.passed)
    return [
      '门槛（骨架阶段）：全部通过。',
      '骨架门槛已过：submit 会被接受（仅表示提交不会被拒）；完成度看对象差异与 must 证据；check 通过 ≠ review 满意。',
    ];
  return [
    `门槛（骨架阶段）：未过 ${String(outcome.failed.length)}/${String(total)} 项，过门槛前 submit 会被拒绝：`,
    ...outcome.failed.map((f) => `  ✗ ${f}`),
  ];
}
