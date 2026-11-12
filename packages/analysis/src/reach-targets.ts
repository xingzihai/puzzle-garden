/**
 * 可达目标（docs/ANALYSIS-SPEC.md §5.3，AGENT-SPEC §5 C17）：从存档调用表推出"应当能走到"的站立点。
 *
 * 负责：每个 `floorPlate` 调用、每个带 `parapet` 的 `kind: 'flat'` 的 `roof` 调用各推出一个站立点；
 *       推不出的调用逐个列出原因；无女儿墙的平顶记进 `skipped`（有意不作目标）。
 * 不负责：判断能不能走到（交给 measureReach）、判定合格。
 */

import type { BlockRegistry } from '@pg/blocks/registry';
import type { CallDef, Grid } from '@pg/core/grid';

import { standableTester } from './reach.ts';
import type { Cell } from './sample.ts';

export type TargetApi = 'floorPlate' | 'roof';

export interface ReachTarget {
  readonly callId: number;
  readonly api: TargetApi;
  /** 站立点：脚所在的格（脚下是该调用写入的格）。 */
  readonly cell: Cell;
}

/**
 * 推不出目标的原因：
 * - `no-cells`：该调用的格全部被后写的调用覆盖或被挖空，网格里没有它的格；
 * - `no-standable`：它的承托层上方一格没有一个站立点（全被挡住或头顶不足两格）；
 * - `args-truncated`：roof 的参数在调用表里被截断（core 只存前 200 码元），截断前缀里读不到 `kind`；
 * - `args-invalid`：参数不是能读出 `kind` 的 JSON（宿主缺陷，正常不会出现）。
 */
export type MissingReason = 'no-cells' | 'no-standable' | 'args-truncated' | 'args-invalid';

export interface MissingTarget {
  readonly callId: number;
  readonly api: TargetApi;
  readonly reason: MissingReason;
}

/**
 * 有意不作目标的调用（AGENT-SPEC §5 C17）：平顶但没设女儿墙。它不属于 `missing`（不是推不出），
 * 也不是可达目标；由调用方在事实文本里单独说明，不写成"到不了"。
 */
export type SkippedReason = 'flat-no-parapet';

export interface SkippedTarget {
  readonly callId: number;
  readonly api: 'roof';
  readonly reason: SkippedReason;
}

export interface ReachTargets {
  /** 按调用编号升序。 */
  readonly targets: readonly ReachTarget[];
  /** 本该出目标却推不出的调用，按调用编号升序；不静默跳过。 */
  readonly missing: readonly MissingTarget[];
  /** 有意不作目标的平顶（无女儿墙），按调用编号升序；不静默跳过。 */
  readonly skipped: readonly SkippedTarget[];
}

/** 截断前缀里的顶层 `kind` / `parapet`。roof 的嵌套对象（footprint、on、finial）都没有这两个键；字符串里的引号已转义，不会误配。 */
const KIND_IN_PREFIX = /[{,]"kind":"([a-z]+)"/;
const PARAPET_IN_PREFIX = /[{,]"parapet":/;

type RoofArgs =
  { readonly kind: string; readonly hasParapet: boolean } | { readonly reason: 'args-truncated' | 'args-invalid' };

/** 从调用表的 args 读 roof 的 kind 与有没有女儿墙；读不出时给出原因。坡屋面不看女儿墙。 */
function roofArgs(args: string): RoofArgs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    // core 截断后的文本以 `…` 结尾，不是合法 JSON；在前缀里找 kind 与 parapet。
    if (!args.endsWith('…')) return { reason: 'args-invalid' };
    const m = KIND_IN_PREFIX.exec(args);
    if (m?.[1] === undefined) return { reason: 'args-truncated' };
    const kind = m[1];
    if (kind !== 'flat') return { kind, hasParapet: false };
    // 平顶必须能判断有没有女儿墙；截断前缀里看不到 parapet 键就只能报 args-truncated（沿用原截断规则）。
    return PARAPET_IN_PREFIX.test(args) ? { kind, hasParapet: true } : { reason: 'args-truncated' };
  }
  if (typeof parsed === 'object' && parsed !== null && 'kind' in parsed && typeof parsed.kind === 'string') {
    return { kind: parsed.kind, hasParapet: 'parapet' in parsed };
  }
  return { reason: 'args-invalid' };
}

/** 每个调用名下在网格里留存的格，按 (x, z) 列分组。 */
function columnsByCall(grid: Grid, wanted: ReadonlySet<number>): Map<number, Map<string, { cell: Cell; top: number }>> {
  const out = new Map<number, Map<string, { cell: Cell; top: number }>>();
  for (const c of grid.cells()) {
    if (!wanted.has(c.call)) continue;
    let cols = out.get(c.call);
    if (cols === undefined) {
      cols = new Map();
      out.set(c.call, cols);
    }
    const key = `${String(c.x)},${String(c.z)}`;
    const prev = cols.get(key);
    if (prev === undefined || c.y > prev.top) cols.set(key, { cell: { x: c.x, y: c.y, z: c.z }, top: c.y });
  }
  return out;
}

/**
 * 承托层：
 * - floorPlate：该调用留存格的最高一层；
 * - 平屋面：各列最高格里**最低**的那一层。女儿墙与屋面同属一个 roof 调用、立在外圈上，会把外圈列抬高；
 *   取最低的列顶就是屋面板本身，女儿墙格在承托层上方一格是实体，自然不会被选成站立点。
 * 两种都只在承托层上方一格、且该列承托层确有本调用的格处找站立点，按 (z, x) 升序取第一个。
 */
function deckLayer(api: TargetApi, cols: ReadonlyMap<string, { top: number }>): number {
  let best: number | undefined;
  for (const { top } of cols.values()) {
    if (best === undefined || (api === 'floorPlate' ? top > best : top < best)) best = top;
  }
  // cols 非空由调用方保证。
  return best ?? 0;
}

export function reachTargetsByCall(grid: Grid, registry: BlockRegistry): ReachTargets {
  const candidates: { call: CallDef; api: TargetApi }[] = [];
  const missing: MissingTarget[] = [];
  const skipped: SkippedTarget[] = [];
  for (const call of grid.calls()) {
    if (call.api === 'floorPlate') candidates.push({ call, api: 'floorPlate' });
    else if (call.api === 'roof') {
      const info = roofArgs(call.args);
      if ('reason' in info) missing.push({ callId: call.id, api: 'roof', reason: info.reason });
      else if (info.kind === 'flat') {
        // 只有立了女儿墙的平屋面才是可达目标：女儿墙圈住的屋面才有明确的站立点。
        if (info.hasParapet) candidates.push({ call, api: 'roof' });
        else skipped.push({ callId: call.id, api: 'roof', reason: 'flat-no-parapet' });
      }
    }
  }
  const cols = columnsByCall(grid, new Set(candidates.map((c) => c.call.id)));
  const standable = standableTester(grid, registry);
  const targets: ReachTarget[] = [];
  for (const { call, api } of candidates) {
    const mine = cols.get(call.id);
    if (mine === undefined) {
      missing.push({ callId: call.id, api, reason: 'no-cells' });
      continue;
    }
    const y = deckLayer(api, mine) + 1;
    const spots = [...mine.values()]
      // 承托层这一格必须仍是本调用的（梯孔被挖空、被别的调用覆盖的列不算）。
      .filter((c) => grid.get(c.cell.x, y - 1, c.cell.z)?.call === call.id)
      .map((c) => ({ x: c.cell.x, y, z: c.cell.z }))
      .sort((a, b) => a.z - b.z || a.x - b.x);
    const cell = spots.find((s) => standable(s));
    if (cell === undefined) missing.push({ callId: call.id, api, reason: 'no-standable' });
    else targets.push({ callId: call.id, api, cell });
  }
  const byId = (a: { callId: number }, b: { callId: number }): number => a.callId - b.callId;
  return { targets: targets.sort(byId), missing: missing.sort(byId), skipped: skipped.sort(byId) };
}
