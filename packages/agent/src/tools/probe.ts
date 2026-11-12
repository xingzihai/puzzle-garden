/**
 * probe 的执行（OPTIMIZATION-ROADMAP Phase 3C；R4 §2.2 / Leak 3、AGENT-CAPABILITY-GAP §3.11.4）：
 * 读取最近一次执行成功的存档，回答“这一格最终是什么、是谁写的 / 这一块有多少实体格 / 这一刀剖面长什么样”。
 *
 * 负责：points（≤32 个点）、box（半开盒，≤4096 格）与 section（固定宽度 ASCII 剖面，≤1200 格）的确定性文本。
 * 不负责：当前稿 / 存档版本（调用方维护）、渲染图片（view_building）、写事件（turn-tools）。
 * 本文件是纯函数文件：只 import 纯入口（core），blocks 只 import type；不依赖 render。
 *
 * 确定性约定：
 * - points 按输入顺序输出。
 * - box 按 y 降序、z 升序、x 升序列出非空气格；明细最多列 40 格。默认另按方块 / 来源聚合，
 *   按格数降序列出前 12 项，并写明“共 N 格 / 已列出 M 格”。
 * - section 行按 y 降序，横向按 z（axis=x）或 x（axis=z）升序；符号按方块规范名码点升序分配，
 *   图例里的“首次来源”取同一扫描顺序下第一次出现该方块的格。
 */

import type { BlockRegistry } from '@pg/blocks/registry';
import { readArchive } from '@pg/core/archive';
import { formatState } from '@pg/core/block-state';
import { CoreError, XZ_MAX, XZ_MIN, Y_MAX, Y_MIN } from '@pg/core/coord';
import type { Grid } from '@pg/core/grid';

/** 一个格坐标；三个分量都是整数。 */
export type ProbePoint = readonly [number, number, number];

/** 半开盒：min 含、max 不含。counts 缺省 true；false 时只列明细，不做聚合计。 */
export interface ProbeBox {
  readonly min: ProbePoint;
  readonly max: ProbePoint;
  readonly counts?: boolean;
}

/** 剖面：axis=x 固定 x=at、横向扫 z；axis=z 固定 z=at、横向扫 x。y 为闭区间。 */
export interface ProbeSection {
  readonly axis: 'x' | 'z';
  readonly at: number;
  readonly y?: readonly [number, number];
}

export interface ProbeInput {
  /** 最近一次执行成功的存档字节。 */
  readonly archive: Uint8Array;
  /** 存档对应的当前稿版本。 */
  readonly archiveVersion: number;
  /** 当前稿版本；0 表示还没有代码。 */
  readonly draftVersion: number | null;
  /** points / box / section 恰好给一个（由 tools/schemas.ts 的 ProbeArgs 保证）。 */
  readonly points?: readonly ProbePoint[];
  readonly box?: ProbeBox;
  readonly section?: ProbeSection;
}

export interface ProbeDeps {
  readonly registry: BlockRegistry;
}

export type ProbeStatus = 'ok' | 'invalid-input' | 'invalid-archive' | 'box-too-large' | 'section-too-large';

export interface ProbeResult {
  readonly status: ProbeStatus;
  readonly text: string;
}

/** 一次 points 查询的点数上限。 */
export const PROBE_MAX_POINTS = 32;
/** box 的格子总数上限（半开盒体积）。 */
export const PROBE_MAX_BOX_CELLS = 4096;
/** box 最多列出的非空气格数。 */
export const PROBE_MAX_LISTED_CELLS = 40;
/** box 聚合最多列出的“方块 + 来源”组合数。 */
export const PROBE_MAX_AGGREGATES = 12;
/** section 的宽度 × 高度上限。 */
export const PROBE_MAX_SECTION_CELLS = 1200;
/** section 的前 10 个符号；第 11 种及以后的方块统一用 `?`。 */
export const SECTION_SYMBOLS = ['#', '=', '+', '*', 'o', 'x', '%', '@', '~', '^'] as const;

function header(input: ProbeInput): string {
  const draft = input.draftVersion === null ? '无' : `v${String(input.draftVersion)}`;
  return `存档 v${String(input.archiveVersion)} · 当前稿 ${draft}`;
}

function isSafePoint(p: ProbePoint): boolean {
  const [x, y, z] = p;
  return (
    Number.isSafeInteger(x) &&
    Number.isSafeInteger(y) &&
    Number.isSafeInteger(z) &&
    x >= XZ_MIN &&
    x <= XZ_MAX &&
    z >= XZ_MIN &&
    z <= XZ_MAX &&
    y >= Y_MIN &&
    y <= Y_MAX
  );
}

/** 方块来源的模型文本；调用 id 为 0 或查不到时写“无”。 */
function sourceOf(call: number, byId: ReadonlyMap<number, string>): string {
  if (call === 0) return '无';
  const api = byId.get(call);
  return api === undefined ? '无' : `${api}#${String(call)}`;
}

function callsById(grid: Grid): ReadonlyMap<number, string> {
  return new Map(grid.calls().map((c) => [c.id, c.api]));
}

function pointsText(grid: Grid, points: readonly ProbePoint[], byId: ReadonlyMap<number, string>): string {
  const lines: string[] = ['points：'];
  for (const p of points) {
    const [x, y, z] = p;
    const cell = grid.get(x, y, z);
    if (cell === undefined) {
      lines.push(`(${String(x)},${String(y)},${String(z)}) air ← 无`);
    } else {
      lines.push(`(${String(x)},${String(y)},${String(z)}) ${formatState(cell.state)} ← ${sourceOf(cell.call, byId)}`);
    }
  }
  return lines.join('\n');
}

function boxVolume(box: ProbeBox): number {
  let volume = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const size = (box.max[axis] ?? 0) - (box.min[axis] ?? 0);
    if (size <= 0) return 0;
    volume *= size;
    if (!Number.isSafeInteger(volume)) return Number.MAX_SAFE_INTEGER;
  }
  return volume;
}

function boxRange(box: ProbeBox): string {
  return `x[${String(box.min[0])},${String(box.max[0])}) y[${String(box.min[1])},${String(box.max[1])}) z[${String(box.min[2])},${String(box.max[2])})`;
}

interface BoxAggregate {
  readonly state: string;
  readonly source: string;
  readonly cells: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 聚合占比：保留一位小数，去掉无意义的 .0（与 gates 的 percent 写法一致）。 */
function percentOf(part: number, total: number): string {
  return `${String(Number(((part / total) * 100).toFixed(1)))}%`;
}

/**
 * box 的方块 / 来源聚合：按格数降序，同数按 state、source 升序；只列前 PROBE_MAX_AGGREGATES 项。
 * 头部固定写“共 N 格 / 已列出 M 格”，让模型知道当前样本是否覆盖整盒。
 */
function boxAggregateLines(aggregates: Iterable<BoxAggregate>, nonAir: number): string[] {
  const sorted = [...aggregates].sort(
    (a, b) => b.cells - a.cells || compareText(a.state, b.state) || compareText(a.source, b.source),
  );
  const shown = sorted.slice(0, PROBE_MAX_AGGREGATES);
  const listed = shown.reduce((sum, entry) => sum + entry.cells, 0);
  const lines = [
    `聚合（按方块 / 来源，前 ${String(PROBE_MAX_AGGREGATES)} 项）：共 ${String(nonAir)} 格 / 已列出 ${String(listed)} 格（${String(shown.length)} 项）。`,
    ...shown.map(
      (entry) => `  ${entry.state} ← ${entry.source}：${String(entry.cells)} 格（${percentOf(entry.cells, nonAir)}）`,
    ),
  ];
  const omitted = sorted.slice(PROBE_MAX_AGGREGATES);
  if (omitted.length > 0) {
    const omittedCells = omitted.reduce((sum, entry) => sum + entry.cells, 0);
    lines.push(`  …另有 ${String(omitted.length)} 项 / ${String(omittedCells)} 格未列出`);
  }
  return lines;
}

function boxText(grid: Grid, box: ProbeBox, byId: ReadonlyMap<number, string>): ProbeResult {
  const total = boxVolume(box);
  if (total > PROBE_MAX_BOX_CELLS) {
    return {
      status: 'box-too-large',
      text:
        `box ${boxRange(box)} 共 ${String(total)} 格，超过上限 ${String(PROBE_MAX_BOX_CELLS)}，没有执行。` +
        '请缩小盒范围（把大盒拆成几个小盒），或改用 points 查关键格。',
    };
  }
  if (total === 0) {
    return { status: 'ok', text: `box ${boxRange(box)}：共 0 格，非空气 0 格。` };
  }

  const lines: string[] = [];
  const aggregates = new Map<string, BoxAggregate>();
  let nonAir = 0;
  // 固定顺序：y 降序，再 z 升序，再 x 升序。
  for (let y = box.max[1] - 1; y >= box.min[1]; y -= 1) {
    for (let z = box.min[2]; z < box.max[2]; z += 1) {
      for (let x = box.min[0]; x < box.max[0]; x += 1) {
        const cell = grid.get(x, y, z);
        if (cell === undefined) continue;
        nonAir += 1;
        const state = formatState(cell.state);
        const source = sourceOf(cell.call, byId);
        const key = `${state}\u0000${source}`;
        const aggregate = aggregates.get(key);
        if (aggregate === undefined) {
          aggregates.set(key, { state, source, cells: 1 });
        } else {
          aggregates.set(key, { ...aggregate, cells: aggregate.cells + 1 });
        }
        if (lines.length < PROBE_MAX_LISTED_CELLS) {
          lines.push(`(${String(x)},${String(y)},${String(z)}) ${state} ← ${source}`);
        }
      }
    }
  }

  const summary = `box ${boxRange(box)}：共 ${String(total)} 格，非空气 ${String(nonAir)} 格。`;
  if (lines.length === 0) return { status: 'ok', text: `${summary}\n（没有非空气格。）` };
  const parts = [summary];
  if (box.counts !== false) parts.push(...boxAggregateLines(aggregates.values(), nonAir));
  parts.push(`明细（y 降序，已列出 ${String(lines.length)} / 非空气 ${String(nonAir)} 格）：`, ...lines);
  const omitted = nonAir - lines.length;
  if (omitted > 0) parts.push(`…另有 ${String(omitted)} 格未列出`);
  return { status: 'ok', text: parts.join('\n') };
}

function sectionTooLarge(
  section: ProbeSection,
  width: number,
  height: number,
  yMin: number,
  yMax: number,
): ProbeResult {
  return {
    status: 'section-too-large',
    text:
      `剖面 ${section.axis}=${String(section.at)} 为 ${String(width)}×${String(height)} = ${String(width * height)} 格，` +
      `超过上限 ${String(PROBE_MAX_SECTION_CELLS)}，没有执行。` +
      `请缩小 y 范围（当前 ${String(yMin)}–${String(yMax)}）或改用 points / box。`,
  };
}

function sectionText(grid: Grid, section: ProbeSection, byId: ReadonlyMap<number, string>): ProbeResult {
  const bounds = grid.bounds();
  if (bounds === undefined) {
    return { status: 'ok', text: `剖面 ${section.axis}=${String(section.at)}：存档没有实体格，剖面为空。` };
  }

  const horizontalMin = section.axis === 'x' ? bounds.min[2] : bounds.min[0];
  const horizontalMax = section.axis === 'x' ? bounds.max[2] : bounds.max[0];
  const width = horizontalMax - horizontalMin + 1;
  const yMin = section.y?.[0] ?? bounds.min[1];
  const yMax = section.y?.[1] ?? bounds.max[1];
  const height = yMax - yMin + 1;
  if (height <= 0) {
    return {
      status: 'invalid-input',
      text: `剖面 y 范围 [${String(yMin)}, ${String(yMax)}] 为空；y 是闭区间，要求下限不大于上限。`,
    };
  }
  if (width * height > PROBE_MAX_SECTION_CELLS) return sectionTooLarge(section, width, height, yMin, yMax);

  // 先收集本剖面出现的方块规范名，按码点升序分配符号（保证跨调用稳定）。
  const names = new Set<string>();
  for (let y = yMax; y >= yMin; y -= 1) {
    for (let h = horizontalMin; h <= horizontalMax; h += 1) {
      const x = section.axis === 'x' ? section.at : h;
      const z = section.axis === 'x' ? h : section.at;
      const cell = grid.get(x, y, z);
      if (cell !== undefined) names.add(formatState(cell.state));
    }
  }
  const sorted = [...names].sort();
  const symbolOf = new Map<string, string>();
  for (const [index, name] of sorted.entries()) {
    if (index < SECTION_SYMBOLS.length) symbolOf.set(name, SECTION_SYMBOLS[index] ?? '?');
  }

  const firstSource = new Map<string, string>();
  const labelWidth = Math.max(String(yMin).length, String(yMax).length);
  const rows: string[] = [];
  for (let y = yMax; y >= yMin; y -= 1) {
    let row = '';
    for (let h = horizontalMin; h <= horizontalMax; h += 1) {
      const x = section.axis === 'x' ? section.at : h;
      const z = section.axis === 'x' ? h : section.at;
      const cell = grid.get(x, y, z);
      if (cell === undefined) {
        row += '.';
        continue;
      }
      const name = formatState(cell.state);
      row += symbolOf.get(name) ?? '?';
      if (!firstSource.has(name)) firstSource.set(name, sourceOf(cell.call, byId));
    }
    rows.push(`y=${String(y).padStart(labelWidth, ' ')} |${row}|`);
  }

  const horizontalAxis = section.axis === 'x' ? 'z' : 'x';
  const described =
    `剖面 ${section.axis}=${String(section.at)}：横向 ${horizontalAxis} ${String(horizontalMin)}–${String(horizontalMax)}（左→右），` +
    `y ${String(yMin)}–${String(yMax)}（行按 y 降序）。`;
  const legend: string[] = ['图例：', '. 空气'];
  for (const [index, name] of sorted.entries()) {
    if (index >= SECTION_SYMBOLS.length) break;
    const symbol = SECTION_SYMBOLS[index] ?? '?';
    legend.push(`${symbol} ${name} ← ${firstSource.get(name) ?? '无'}`);
  }
  const overflow = sorted.slice(SECTION_SYMBOLS.length);
  if (overflow.length > 0) {
    legend.push(`? 其余 ${String(overflow.length)} 种方块：${overflow.join('、')}`);
  }
  return { status: 'ok', text: [described, ...rows, ...legend].join('\n') };
}

function isCoordInRange(p: ProbePoint): boolean {
  return isSafePoint(p);
}

/** 半开盒的上界允许等于坐标上限 + 1（那一格本身不会被查询）。 */
function isBoxInRange(box: ProbeBox): boolean {
  const [minX, minY, minZ] = box.min;
  const [maxX, maxY, maxZ] = box.max;
  return (
    Number.isSafeInteger(minX) &&
    Number.isSafeInteger(minY) &&
    Number.isSafeInteger(minZ) &&
    Number.isSafeInteger(maxX) &&
    Number.isSafeInteger(maxY) &&
    Number.isSafeInteger(maxZ) &&
    minX >= XZ_MIN &&
    minZ >= XZ_MIN &&
    minY >= Y_MIN &&
    maxX >= minX &&
    maxY >= minY &&
    maxZ >= minZ &&
    maxX <= XZ_MAX + 1 &&
    maxZ <= XZ_MAX + 1 &&
    maxY <= Y_MAX + 1
  );
}

/**
 * 读取存档并执行一次 probe。points / box / section 恰好一个；参数已由 ProbeArgs 校验，
 * 这里仍做输入自检，避免纯函数在坏输入上抛异常。
 */
export function probeBuilding(input: ProbeInput, deps: ProbeDeps): ProbeResult {
  let grid: Grid;
  try {
    grid = readArchive(deps.registry.table, input.archive).grid;
  } catch (error) {
    if (error instanceof CoreError && error.code === 'invalid-archive') {
      return { status: 'invalid-archive', text: `${header(input)}\n存档读不回：${error.message}` };
    }
    throw error;
  }

  const provided = [input.points, input.box, input.section].filter((value) => value !== undefined).length;
  if (provided !== 1) {
    return {
      status: 'invalid-input',
      text: 'probe 需要且只需要 points / box / section 之一，没有执行。',
    };
  }

  const byId = callsById(grid);
  if (input.points !== undefined) {
    if (input.points.length < 1 || input.points.length > PROBE_MAX_POINTS) {
      return {
        status: 'invalid-input',
        text: `points 需要 1–${String(PROBE_MAX_POINTS)} 个点，实际 ${String(input.points.length)} 个，没有执行。`,
      };
    }
    if (!input.points.every(isCoordInRange)) {
      return { status: 'invalid-input', text: 'points 里有坐标不是合法整数或越界，没有执行。' };
    }
    return { status: 'ok', text: [header(input), pointsText(grid, input.points, byId)].join('\n') };
  }

  if (input.box !== undefined) {
    if (!isBoxInRange(input.box)) {
      return { status: 'invalid-input', text: 'box 的 min / max 不是合法整数或越界，没有执行。' };
    }
    const result = boxText(grid, input.box, byId);
    return { status: result.status, text: [header(input), result.text].join('\n') };
  }

  const section = input.section;
  if (section === undefined) {
    return { status: 'invalid-input', text: 'probe 缺少 points / box / section，没有执行。' };
  }
  if (!Number.isSafeInteger(section.at) || section.at < XZ_MIN || section.at > XZ_MAX) {
    return { status: 'invalid-input', text: 'section.at 不是合法整数或越界，没有执行。' };
  }
  if (section.y !== undefined) {
    const [min, max] = section.y;
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < Y_MIN || max > Y_MAX) {
      return { status: 'invalid-input', text: 'section.y 不是合法整数或越界，没有执行。' };
    }
  }
  const result = sectionText(grid, section, byId);
  return { status: result.status, text: [header(input), result.text].join('\n') };
}
