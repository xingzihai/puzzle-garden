/**
 * 事实文本（AGENT-SPEC §3.2、§5、§6.1）：check_code 的测量段、每轮末尾的事实行、退化取消后的替代消息。
 *
 * 负责：把测量结果与 run 状态格式化成给模型看的中文事实；按规格截断，截断处写明。纯函数、确定。
 * 不负责：计算测量（@pg/analysis）、check_code 首行与预检诊断（tools/check.ts）、护栏判断（guards/）。
 * 措辞只写数字与位置，不出现"通过 / 不合格 / 应当 / 必须修"（ANALYSIS-SPEC §1、DESIGN §6）。
 */

import type { FloatingReport } from '@pg/analysis/floating';
import type { Blocker, ReachReport } from '@pg/analysis/reach';
import type { MissingReason, ReachTargets } from '@pg/analysis/reach-targets';
import type { RoofProfile } from '@pg/analysis/roof-profile';
import type { SeamReport } from '@pg/analysis/seams';
import type { SymmetryReport } from '@pg/analysis/symmetry';
import type { CallDef } from '@pg/core/grid';
import type { OverlapReport, OverlapSampleDetail, OverlapSummary } from '@pg/sandbox/run';

import { planDigest, type PlanState } from './tools/plan.ts';

/**
 * 提交窗口内仍可用的工具（AGENT-SPEC §13 第 6 条）。窗口通知用它，runner 也把它传给 systemPrompt，两处同源。
 * 放在这里而不是 prompt/system.ts：窗口通知与提示词共用同一份常量，避免 prompt 反向依赖运行状态。
 */
export const WINDOW_TOOLS = ['read_code', 'edit_code', 'check_code', 'submit'] as const;

/** 事实文本格式版本（进 `versions.factsFormat`）；措辞、截断规则或事实行结构改动时加 1。 */
export const FACTS_FORMAT_VERSION = 10;

/** 测量段上限（§5）。 */
export const MEASURES_MAX_CHARS = 2500;
/** 覆盖段上限；超长时整组省略，避免拆散坐标、状态与双方来源。 */
export const OVERLAPS_MAX_CHARS = 2000;
/** 事实行上限（§6.1）。 */
export const FACTS_MAX_CHARS = 400;
/** 退化取消后保留的 content 长度（§3.2）。 */
export const DEGENERATE_KEEP_CHARS = 2000;

const LIMITS = {
  blockers: 5,
  floatingGroups: 3,
  seamGroups: 3,
  symmetryGroups: 2,
  targets: 12,
  roofs: 6,
  sources: 3,
  lostDecor: 3,
} as const;

export const NO_TOOL_NOTICE = '本轮没有调用工具；完成后请调用 submit';
export const DEGENERATE_NOTICE = '上一轮输出出现大段重复，已被中止。请直接调用工具，不要重复输出。';
export const DEGENERATE_SUFFIX = '…（输出重复，已中止）';

type Point = readonly [number, number, number];

const pt = (p: Point | { readonly x: number; readonly y: number; readonly z: number }): string =>
  'x' in p ? `(${String(p.x)},${String(p.y)},${String(p.z)})` : `(${String(p[0])},${String(p[1])},${String(p[2])})`;
const box = (b: { readonly min: Point; readonly max: Point }): string => `${pt(b.min)}–${pt(b.max)}`;

/** 不切开代理对地取前 n 个 UTF-16 码元。 */
function headUnits(text: string, n: number): string {
  if (text.length <= n) return text;
  const last = text.charCodeAt(n - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

// ───────────── 测量段 ─────────────

export interface MeasureInput {
  /** 存档调用表：来源调用名与"用了"计数都从这里来（只信代码，`v02:docs/LESSONS.md` §2.5）。 */
  readonly calls: readonly CallDef[];
  /** `measureFloating(grid, { tag: 屋面格 })`。 */
  readonly floating: FloatingReport;
  readonly seams: SeamReport;
  /** 被呈现层排除、未列出的洞框空气（夹层）格数与组数；>0 时在夹层行后注明（AGENT-SPEC §5）。 */
  readonly seamFrameAir: { readonly cells: number; readonly groups: number };
  /** `reachTargetsByCall` 的结果；`reach` 必须以它的 targets（同序）作为 `options.targets` 计算。 */
  readonly reachTargets: ReachTargets;
  readonly reach: ReachReport;
  /** 每个 roof 调用单独算的剖面，按调用编号升序。 */
  readonly roofs: readonly { readonly callId: number; readonly profile: RoofProfile }[];
  /** 存档里 y ≤ 0 的实体格：格数与来源调用（按格数降序、同数按编号，前 3 个）。 */
  readonly belowGround: { readonly cells: number; readonly sources: readonly string[] };
  /** `measureSymmetry(grid, { glass: 名含 glass })`。 */
  readonly symmetry: SymmetryReport;
  /** 每个 walls 调用围合内部的屋面覆盖列统计（呈现层，不改 analysis 定义）。 */
  readonly wallCoverage: readonly {
    readonly callId: number;
    readonly line: number;
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
    readonly covered: number;
    readonly total: number;
  }[];
}

interface Caps {
  readonly blockers: number;
  readonly floatingGroups: number;
  readonly seamGroups: number;
  readonly symmetryGroups: number;
}

function sourceOf(apiById: ReadonlyMap<number, string>, call: number): string | undefined {
  const api = apiById.get(call);
  return api === undefined ? undefined : `${api}#${String(call)}`;
}

/** 样例里出现的来源调用，按首次出现顺序去重，最多 LIMITS.sources 个。 */
function sources(apiById: ReadonlyMap<number, string>, samples: readonly { readonly call: number }[]): string {
  const out: string[] = [];
  for (const s of samples) {
    const name = sourceOf(apiById, s.call);
    if (name !== undefined && !out.includes(name)) out.push(name);
    if (out.length === LIMITS.sources) break;
  }
  return out.length === 0 ? '' : `，来源 ${out.join('、')}`;
}

function floatingLines(f: FloatingReport, apiById: ReadonlyMap<number, string>, cap: number): string[] {
  if (f.cells === 0) return ['悬空 0 格。'];
  const head = `悬空 ${String(f.cells)} 格（其中只靠棱角相连 ${String(f.edgeOnly)} 格），${String(f.groups.length)} 组：`;
  const groups = f.groups.slice(0, cap).map((g) => {
    const roof = g.tagged === g.cells ? '，整组是屋面格' : '';
    const edge = g.edgeOnly ? '，只靠棱角相连' : '';
    return `  ${String(g.cells)} 格 ${box(g.bounds)}${edge}${roof}${sources(apiById, g.samples)}`;
  });
  return [head, ...groups, ...more(f.groups.length, cap, '组')];
}

function seamLines(s: SeamReport, seamFrameAir: MeasureInput['seamFrameAir'], cap: number): string[] {
  const lines: string[] = [];
  if (s.cells === 0) lines.push('夹层 0 格。');
  else {
    const head = `夹层 ${String(s.cells)} 格，${String(s.groups.length)} 组：`;
    const groups = s.groups
      .slice(0, cap)
      .map((g) => `  ${String(g.cells)} 格 ${box(g.bounds)}，${g.layers === 1 ? '一层' : '两层'}空气`);
    lines.push(head, ...groups, ...more(s.groups.length, cap, '组'));
  }
  // 洞框外凸围出的空气是事实之外的噪声：不在夹层组里列出，但要说清排除了多少（AGENT-SPEC §5）。
  if (seamFrameAir.cells > 0)
    lines.push(`另有 ${String(seamFrameAir.cells)} 格是洞框围出的空气，未列出（${String(seamFrameAir.groups)} 组）。`);
  return lines;
}

function more(total: number, shown: number, unit: string): string[] {
  return total > shown ? [`  …另 ${String(total - shown)} ${unit}`] : [];
}

const MISSING_TEXT: Record<MissingReason, string> = {
  'no-cells': '的格已全部被覆盖或挖空，没有目标',
  'no-standable': '上方没有站立点，没有目标',
  'args-truncated': '参数过长被截断，未判断是否平顶',
  'args-invalid': '参数无法读取，未判断是否平顶',
};

function blockerText(b: Blocker, apiById: ReadonlyMap<number, string>): string {
  const step = `${pt(b.from)}→${pt(b.to)}`;
  switch (b.reason) {
    case 'too-high':
      return `${step} 高差 2 格以上`;
    case 'too-far-down':
      return `${step} 落差超过 3 格`;
    case 'no-headroom': {
      if (b.block === undefined) return `${step} 头顶被挡`;
      const src = sourceOf(apiById, b.block.call);
      return `${step} 头顶被挡：${b.block.block} ${pt(b.block)}${src === undefined ? '' : `（${src}）`}`;
    }
  }
}

function reachLines(input: MeasureInput, apiById: ReadonlyMap<number, string>, cap: number): string[] {
  const { reach, reachTargets } = input;
  if (reach.targets.length !== reachTargets.targets.length) {
    throw new Error(
      `reach.targets 有 ${String(reach.targets.length)} 个，reachTargets.targets 有 ${String(reachTargets.targets.length)} 个：` +
        'measureReach 必须以 reachTargetsByCall 的目标（同序）计算',
    );
  }
  const y = (v: number | undefined): string => (v === undefined ? '无' : String(v));
  const lines = [
    `可达：站立点 ${String(reach.standable)}，能到 ${String(reach.reached)}；` +
      `能到的最高站立高度 ${y(reach.maxReachedY)}，最高站立点 ${y(reach.maxStandableY)}。`,
  ];
  const items = [
    ...reachTargets.targets.map((t, i) => ({
      callId: t.callId,
      text:
        `${t.api}#${String(t.callId)}${t.api === 'roof' ? '（平顶）' : ''} ${pt(t.cell)} ` +
        (reach.targets[i]?.reached === true ? '能到' : '到不了'),
    })),
    ...reachTargets.missing.map((m) => ({
      callId: m.callId,
      text: `${m.api}#${String(m.callId)}${m.api === 'roof' && m.reason !== 'args-truncated' && m.reason !== 'args-invalid' ? '（平顶）' : ''}${MISSING_TEXT[m.reason]}`,
    })),
  ].sort((a, b) => a.callId - b.callId);
  const skipped = reachTargets.skipped;
  if (items.length > 0) {
    const shown = items.slice(0, LIMITS.targets).map((t) => t.text);
    const rest = items.length > LIMITS.targets ? `；…另 ${String(items.length - LIMITS.targets)} 个` : '';
    lines.push(`  目标：${shown.join('；')}${rest}`);
  } else if (skipped.length === 0) {
    lines.push('  目标：没有 floorPlate 或平顶 roof 调用');
  }
  if (skipped.length > 0) {
    // 平顶无女儿墙：只说明不作目标，不写成"到不了"（AGENT-SPEC §5）。
    const shown = skipped.slice(0, LIMITS.targets).map((s) => `roof#${String(s.callId)}`);
    const rest = skipped.length > LIMITS.targets ? `；…另 ${String(skipped.length - LIMITS.targets)} 个` : '';
    lines.push(`  平顶，无女儿墙，不作目标：${shown.join('；')}${rest}`);
  }
  if (reach.blockers.length > 0) {
    const shown = reach.blockers.slice(0, cap).map((b) => blockerText(b, apiById));
    lines.push(`  差一步（前 ${String(shown.length)} 处）：${shown.join('；')}`);
  }
  return lines;
}

function roofLines(roofs: MeasureInput['roofs']): string[] {
  if (roofs.length === 0) return [];
  const one = ({ callId, profile: p }: MeasureInput['roofs'][number]): string =>
    `roof#${String(callId)} 共 ${String(p.cells)} 格，列厚 1/2/3+ = ` +
    `${String(p.thickness[1])}/${String(p.thickness[2])}/${String(p.thickness['3+'])}，超出连接 ${String(p.excess.columns)} 列`;
  const shown = roofs.slice(0, LIMITS.roofs).map(one);
  const rest = roofs.length > LIMITS.roofs ? [`  …另 ${String(roofs.length - LIMITS.roofs)} 个屋面`] : [];
  return [`屋面：${shown.join('；')}。`, ...rest];
}

/** 按 API 名计数，次数降序、同数按名字升序（§4.2）。 */
export function usedLine(calls: readonly CallDef[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.api, (counts.get(c.api) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sorted.length === 0 ? '用了：没有调用。' : `用了：${sorted.map(([n, k]) => `${n} ${String(k)}`).join('、')}。`;
}

/** 存档里 y ≤ 0 的实体格：地表以下的事实，不判合格。 */
function belowGroundLines(input: MeasureInput): string[] {
  const { cells, sources } = input.belowGround;
  if (cells === 0) return [];
  const from = sources.length === 0 ? '' : `，来源 ${sources.join('、')}`;
  return [`y ≤ 0 有 ${String(cells)} 格（地表以下）${from}。`];
}

/** 围合墙内部上方没有屋面的列占比：< 50% 才写一行，只报事实。 */
function wallCoverageLines(input: MeasureInput): string[] {
  const lines: string[] = [];
  for (const w of input.wallCoverage) {
    if (w.total === 0 || w.covered * 2 >= w.total) continue;
    const at = w.line > 0 ? `（第 ${String(w.line)} 行）` : '';
    const pct = Math.round((w.covered / w.total) * 100);
    lines.push(
      `walls#${String(w.callId)}${at}围合的 x∈[${String(w.minX)}, ${String(w.maxX)}]、` +
        `z∈[${String(w.minZ)}, ${String(w.maxZ)}] 上方没有屋面，覆盖 ${String(pct)}%。`,
    );
  }
  return lines;
}

/** 每个基本对称的轴一行；有只在一侧的玻璃 / 实体时列出前 cap 组（AGENT-SPEC §5）。 */
function symmetryLines(input: MeasureInput, apiById: ReadonlyMap<number, string>, cap: number): string[] {
  const lines: string[] = [];
  const groupLines = (groups: SymmetryReport['axes'][number]['lonely']): string[] => [
    ...groups.slice(0, cap).map((g) => `    ${String(g.cells)} 格 ${box(g.bounds)}${sources(apiById, g.samples)}`),
    ...(groups.length > cap ? [`    …另 ${String(groups.length - cap)} 组`] : []),
  ];
  for (const a of input.symmetry.axes) {
    const pct = (n: number, total: number): string => ((n / total) * 100).toFixed(1);
    const glass =
      a.glass === 0
        ? '，无玻璃'
        : `，玻璃对上 ${pct(a.glassMatched, a.glass)}%（${a.axis} < ${String(a.at)} 一侧 ${String(a.glassBelow)} 格、` +
          `${a.axis} > ${String(a.at)} 一侧 ${String(a.glassAbove)} 格）`;
    lines.push(`左右对称：镜面 ${a.axis} = ${String(a.at)}，实体对上 ${pct(a.matched, a.cells)}%${glass}。`);
    if (a.lonelyGlass.length > 0) {
      lines.push(`  只在一侧的玻璃 ${String(a.lonelyGlass.length)} 组：`, ...groupLines(a.lonelyGlass));
    }
    if (a.lonely.length > 0) {
      lines.push(`  只在一侧的实体 ${String(a.lonely.length)} 组：`, ...groupLines(a.lonely));
    }
  }
  return lines;
}

function measureLines(input: MeasureInput, caps: Caps): string[] {
  const apiById = new Map(input.calls.map((c) => [c.id, c.api]));
  return [
    '测量（事实，不判合格）：',
    ...floatingLines(input.floating, apiById, caps.floatingGroups),
    ...seamLines(input.seams, input.seamFrameAir, caps.seamGroups),
    ...reachLines(input, apiById, caps.blockers),
    ...roofLines(input.roofs),
    ...belowGroundLines(input),
    ...wallCoverageLines(input),
    ...symmetryLines(input, apiById, caps.symmetryGroups),
    usedLine(input.calls),
  ];
}

/**
 * 测量段文本，≤ MEASURES_MAX_CHARS。超出时依次把差一步、悬空组、夹层组减到 1 条；
 * 仍超出就按行截断，末行写"（已截断，共 N 项）"，N 是未截断时的行数。
 */
export function formatMeasures(input: MeasureInput): string {
  const steps: Caps[] = [
    {
      blockers: LIMITS.blockers,
      floatingGroups: LIMITS.floatingGroups,
      seamGroups: LIMITS.seamGroups,
      symmetryGroups: LIMITS.symmetryGroups,
    },
    {
      blockers: 1,
      floatingGroups: LIMITS.floatingGroups,
      seamGroups: LIMITS.seamGroups,
      symmetryGroups: LIMITS.symmetryGroups,
    },
    { blockers: 1, floatingGroups: 1, seamGroups: LIMITS.seamGroups, symmetryGroups: 1 },
    { blockers: 1, floatingGroups: 1, seamGroups: 1, symmetryGroups: 1 },
  ];
  let lines: string[] = [];
  for (const caps of steps) {
    lines = measureLines(input, caps);
    const text = lines.join('\n');
    if (text.length <= MEASURES_MAX_CHARS) return text;
  }
  const note = `（已截断，共 ${String(lines.length)} 项）`;
  const kept: string[] = [];
  let used = note.length;
  for (const line of lines) {
    if (used + line.length + 1 > MEASURES_MAX_CHARS) {
      // 一行本身就放不下时截这一行的头部，保证至少有内容。
      if (kept.length === 0) kept.push(headUnits(line, MEASURES_MAX_CHARS - note.length - 1));
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return [...kept, note].join('\n');
}

/** 直接复用报告类型；两参数旧调用不要求提供无关的 cells。 */
export type OverlapFact = Pick<OverlapReport, 'kind' | 'winner' | 'loser' | 'lostDecor' | 'sample' | 'sampleDetail'>;

export interface OverlapOptions {
  readonly summary?: OverlapSummary | undefined;
  readonly overlapsTruncated?: number | undefined;
}

const WRITE_LAYER_TEXT = { opening: '开洞层', structure: '结构层', decoration: '装饰层' } as const;

function overlapSource(id: number, source: OverlapSampleDetail['winnerSource']): string {
  const line = source.line > 0 ? `第 ${String(source.line)} 行` : '行号未知';
  return `${source.api}#${String(id)}（${line}，${WRITE_LAYER_TEXT[source.writeLayer]}）`;
}

function overlapSample(
  group: {
    readonly winner: number;
    readonly loser: number;
    readonly cells: number;
    readonly sample: Point;
    readonly sampleDetail?: OverlapSampleDetail | undefined;
  },
  calls: readonly CallDef[],
): string {
  const detail = group.sampleDetail;
  const prefix = `  ${String(group.cells)} 格，例 ${pt(group.sample)}：`;
  if (detail !== undefined) {
    const effect =
      detail.expectedState === detail.actualState ? '最终状态相同' : detail.actualState === 'air' ? '挖掉' : '覆盖';
    return (
      `${prefix}代码请求状态 ${detail.expectedState} → 最终状态 ${detail.actualState}（${effect}）；` +
      `败方 ${overlapSource(group.loser, detail.loserSource)}；胜方 ${overlapSource(group.winner, detail.winnerSource)}`
    );
  }
  const source = (id: number): string => {
    const c = calls.find((call) => call.id === id);
    return c === undefined
      ? `#${String(id)}（API/行号未知，写入层未知）`
      : `${c.api}#${String(id)}（${c.line > 0 ? `第 ${String(c.line)} 行` : '行号未知'}，写入层未知）`;
  };
  return `${prefix}败方 ${source(group.loser)}；胜方 ${source(group.winner)}；代码请求/最终状态未知`;
}

/**
 * 新报告使用截断前概览与绑定同格的真实样例；不从 args 或 API 名猜状态。
 * 旧报告只数保留项、逐调用对展示，不重新拼接样例与其它调用的来源。整组限长，最多三组。
 */
export function formatOverlaps(
  overlaps: readonly OverlapFact[],
  calls: readonly CallDef[],
  options: OverlapOptions = {},
): string {
  const { summary, overlapsTruncated = 0 } = options;
  const same = summary?.sameLayer ?? overlaps.filter((o) => o.kind === 'same-layer').length;
  const cross = summary?.crossLayer ?? overlaps.filter((o) => o.kind === 'cross-layer').length;
  const partial = summary === undefined && overlapsTruncated > 0;
  const lines = [`覆盖：${partial ? '保留项' : ''}同层替代 ${String(same)} 处 / 跨层覆盖 ${String(cross)} 处。`];
  if (overlapsTruncated > 0)
    lines.push(
      `覆盖明细省略 ${String(overlapsTruncated)} 项${partial ? '，同层/跨层分类未知，未计入上述分类' : '；上述计数来自完整概览'}。`,
    );
  const lost = overlaps.filter((o) => o.kind === 'cross-layer' && (o.lostDecor ?? 0) > 0);
  const total = summary?.lostDecor ?? lost.reduce((n, o) => n + (o.lostDecor ?? 0), 0);
  if (total === 0) return lines.join('\n');
  lines.push(
    `手写装饰被盖掉 ${String(total)} 格${partial ? '（仅保留项，完整总数未知）' : ''}（跨层写入损失，包含同状态重复写入）：`,
  );
  const groups =
    summary?.groups ??
    lost
      .flatMap((o) =>
        o.sample === undefined
          ? []
          : [
              {
                winner: o.winner,
                loser: o.loser,
                cells: o.lostDecor ?? 0,
                sample: o.sample,
                sampleDetail: o.sampleDetail,
              },
            ],
      )
      .sort((a, b) => b.cells - a.cells || a.winner - b.winner || a.loser - b.loser);
  const groupCount = summary === undefined ? lost.length : summary.groups.length + summary.groupsOmitted;
  const rows = groups.slice(0, LIMITS.lostDecor).map((g) => overlapSample(g, calls));
  const scope = '以上仅涉及跨层手写装饰，不代表画面可见性或同层全面诊断；请核对坐标、状态和写入层是否符合设计。';
  const text = (): string =>
    [
      ...lines,
      ...rows,
      `  样例最多 3 组，已列 ${String(rows.length)} 组；另 ${String(groupCount - rows.length)} 组未展开（文本上限 ${String(OVERLAPS_MAX_CHARS)} 字符）。`,
      scope,
    ].join('\n');
  while (text().length > OVERLAPS_MAX_CHARS && rows.length > 0) rows.pop();
  return text();
}

// ───────────── 事实行 ─────────────

export type CheckOutcome = 'ok' | 'precheck-failed' | 'build-error' | 'not-finished';

export interface FactsInput {
  readonly accounting?: 'unmetered';
  /** 下一轮的编号（从 1 起，C15）。 */
  readonly nextTurn: number;
  /** 轮数上限；null 表示不限轮数（决策 #87），状态行不写"共 M 轮"。 */
  readonly maxTurns: number | null;
  /** 已结算 + 未结算预留。 */
  readonly spentCny: number;
  readonly maxCostCny: number;
  /** 下一轮 `turn.start.elapsedMs`（C7）。 */
  readonly elapsedMs: number;
  readonly wallMs: number;
  /** 当前稿版本；还没有代码时为 null。 */
  readonly draftVersion: number | null;
  /**
   * 当前稿是否含可用代码；缺省按 `draftVersion !== null` 推断。
   * 空串 / 空白稿可能已有版本号（例如窗口内先写了空稿），此时仍应提示 write_code。
   */
  readonly hasDraftCode?: boolean;
  readonly lastCheck: { readonly version: number; readonly outcome: CheckOutcome; readonly hash?: string } | null;
  readonly lastViewVersion: number | null;
  /**
   * 提交窗口状态；不在窗口内为 null。`entering` 只在窗口内第一次请求之前为 true。
   * `remaining` 为 null 表示轮数不限（决策 #87），窗口只由费用或墙钟触发。
   */
  readonly window: { readonly remaining: number | null; readonly entering: boolean } | null;
  /** 本轮的特殊情况（§3.2），写在第一行。 */
  readonly event?: 'no-tool' | 'degenerate';
  /** 护栏警告，每条另起一行。 */
  readonly warnings?: readonly string[];
  /** 施工计划；存在时追加一行摘要（Phase 3E）。缺省时输出与 Phase 3E 之前逐字节相同。 */
  readonly plan?: PlanState;
}

const minutes = (ms: number): string => String(Math.floor(ms / 60_000));
const yuan = (cny: number): string => `¥${cny.toFixed(2)}`;

function checkText(c: NonNullable<FactsInput['lastCheck']>): string {
  switch (c.outcome) {
    case 'ok':
      return `执行成功${c.hash === undefined ? '' : `（hash ${c.hash.slice(0, 4)}…）`}`;
    case 'precheck-failed':
      return '类型预检未通过';
    case 'build-error':
      return '执行出错';
    case 'not-finished':
      return '执行未完成';
  }
}

/** 窗口通知（C15）：轮数不限时写"费用或墙钟即将用完"，否则写剩余轮数。 */
export function windowNotice(window: NonNullable<FactsInput['window']>, hasDraft = true): string {
  const tools = `只能使用 ${WINDOW_TOOLS.join('、')}`;
  if (!hasDraft) {
    // 窗口可能先于首稿进入（fc7468 的费用窗口）：此时只能靠 write_code 把 v0 推进到 v1，
    // 必须把这条唯一出路写进事实行，否则模型会按“只能用 read/edit/check/submit”停在空稿上。
    const lead =
      window.remaining === null
        ? window.entering
          ? '进入提交窗口：'
          : '提交窗口：费用或墙钟即将用完。'
        : window.entering
          ? `进入提交窗口：剩余 ${String(window.remaining)} 轮。`
          : `提交窗口：剩余 ${String(window.remaining)} 轮。`;
    return `${lead}当前还没有代码，先 write_code 建立初稿；之后${tools}。`;
  }
  if (window.remaining === null) {
    return window.entering ? `进入提交窗口：${tools}。` : '提交窗口：费用或墙钟即将用完。';
  }
  return window.entering
    ? `进入提交窗口：剩余 ${String(window.remaining)} 轮，${tools}。`
    : `提交窗口：剩余 ${String(window.remaining)} 轮。`;
}

/**
 * 每轮末尾的事实行（§6.1），≤ FACTS_MAX_CHARS。超出时从后往前去掉护栏警告，
 * 并写"（另有 N 条提醒未显示）"；状态行本身不截。
 */
export function formatFacts(f: FactsInput): string {
  const lines: string[] = [];
  if (f.event === 'no-tool') lines.push(NO_TOOL_NOTICE);
  if (f.event === 'degenerate') lines.push(DEGENERATE_NOTICE);
  const turnHead =
    f.maxTurns === null
      ? `[第 ${String(f.nextTurn)} 轮｜`
      : `[第 ${String(f.nextTurn)} 轮 / 共 ${String(f.maxTurns)} 轮｜`;
  lines.push(
    `${turnHead}${f.accounting === 'unmetered' ? '特许测试：未计费，无金额限制' : `已花 ${yuan(f.spentCny)} / 上限 ${yuan(f.maxCostCny)}`}｜` +
      `墙钟 ${minutes(f.elapsedMs)} 分 / ${minutes(f.wallMs)} 分]`,
  );
  const draft = f.draftVersion === null ? '当前稿：还没有代码' : `当前稿第 v${String(f.draftVersion)} 版`;
  const check =
    f.lastCheck === null ? '还没有检查' : `最近检查第 v${String(f.lastCheck.version)} 版：${checkText(f.lastCheck)}`;
  const view = f.lastViewVersion === null ? '还没有看图' : `最近看图：第 v${String(f.lastViewVersion)} 版`;
  lines.push(`${draft}；${check}。${view}。`);
  if (f.window !== null) lines.push(windowNotice(f.window, f.hasDraftCode ?? f.draftVersion !== null));
  const withoutPlan = lines.join('\n');
  // 计划摘要只占一行；极端情况下按剩余空间截断，保证事实行不超上限。缺省 plan 时不动任何字节。
  let base = withoutPlan;
  const plan = f.plan;
  if (plan !== undefined) {
    const line = planDigest(plan);
    const room = FACTS_MAX_CHARS - withoutPlan.length - 1;
    if (room > 0) {
      base = `${withoutPlan}\n${line.length <= room ? line : `${headUnits(line, room - 1)}…`}`;
    }
  }
  const warnings = f.warnings ?? [];
  const withWarnings = (k: number): string => {
    const dropped = warnings.length - k;
    const tail = dropped === 0 ? [] : [`（另有 ${String(dropped)} 条提醒未显示）`];
    return [base, ...warnings.slice(0, k), ...tail].join('\n');
  };
  for (let k = warnings.length; k > 0; k -= 1) {
    const text = withWarnings(k);
    if (text.length <= FACTS_MAX_CHARS) return text;
  }
  // 状态部分只有数字与固定措辞，最长约 250 字符（四行全出现时），加上"另有 N 条"仍在上限内。
  return withWarnings(0);
}

/** 退化取消后追加的 assistant content（§3.2）：已收到的 content 前 2000 字符 + 中止说明。 */
export function degenerateContent(received: string): string {
  return `${headUnits(received, DEGENERATE_KEEP_CHARS)}${DEGENERATE_SUFFIX}`;
}
