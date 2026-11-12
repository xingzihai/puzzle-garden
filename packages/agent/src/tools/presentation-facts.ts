/**
 * check_code 的呈现层事实辅助（AGENT-SPEC §5 的屋面剖面与洞框夹层两条修正）。
 *
 * 负责：从 roof 调用参数判定"哪些状态算屋面板"（排除山墙 / 正脊饰），以及排除 opening 洞框外凸围出的空气。
 * 不负责：measureSeams / measureRoofProfile 的定义（@pg/analysis）、模型可见文本（facts.ts）。
 * 本文件是纯函数文件：只 import 纯入口（core 的 block-state / grid 类型、analysis 的 seams），不做 I/O。
 */

import { MAX_SEAM_LAYERS } from '@pg/analysis/seams';
import type { SeamGroup, SeamReport } from '@pg/analysis/seams';
import { parseState } from '@pg/core/block-state';
import type { BlockTable } from '@pg/core/block-state';
import type { CallDef, Cell, Grid } from '@pg/core/grid';

/** 从 roof 调用参数里读顶层 `material`。参数被截断或不是合法 JSON 时返回 undefined。 */
function argsMaterial(args: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed === 'object' && parsed !== null && 'material' in parsed && typeof parsed.material === 'string')
      return parsed.material;
  } catch {
    // 截断后的参数不是合法 JSON；调用方走回退。
  }
  return undefined;
}

/**
 * 一个 roof 调用里哪些规范方块状态算屋面（用于排除山墙与正脊饰）。
 * 优先读 args.material；读不到（参数截断）时回退到该调用留存格里出现最多的状态（屋面板通常占多数）。
 * 山墙默认用承托外墙材质或 gableMaterial，与屋面板的 `material` 不同，因此会被排除。
 * 已知边界：若模型把 gableMaterial 设成与屋面 material 相同，归档里两者无法区分，山墙格不会被排除。
 */
export function roofSurfaceMaterials(call: CallDef, cells: readonly Cell[], table: BlockTable): ReadonlySet<string> {
  const material = argsMaterial(call.args);
  if (material !== undefined) {
    try {
      return new Set([parseState(table, material).canonical]);
    } catch {
      // 参数里的材质不合法（正常执行已通过，不会发生）时回退到多数状态。
    }
  }
  const counts = new Map<string, number>();
  for (const c of cells) counts.set(c.state.canonical, (counts.get(c.state.canonical) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = -1;
  for (const [state, n] of counts) {
    if (n > bestCount || (n === bestCount && best !== undefined && state < best)) {
      best = state;
      bestCount = n;
    }
  }
  return best === undefined ? new Set() : new Set([best]);
}

/** opening 参数里的 frame 材质；frame 在规范 JSON 里靠前，截断前缀里通常仍在，用正则兜住截断（不是合法 JSON）的情况。 */
const FRAME_MATERIAL_IN_ARGS = /[{,]"frame":\{"material":"([^"]+)"/;

/**
 * 洞框（opening 的 frame）外凸围出的空气会被 measureSeams 当成夹层（2026-10-03 首批误报）。
 * 呈现层在这里排除：一个夹层组的每个取样格，其上下最近的实体格都必须是某个 opening 调用里 frame 材质的格。
 * 不修改 analysis 的夹层定义（只报事实）；排除了多少格写进 measurement 文本。
 * 取样格最多 20 个，超过 20 格的组只按取样判断——洞框空气都是矩形小口袋，够用。
 */
export function frameAirSeams(
  grid: Grid,
  seams: SeamReport,
  calls: readonly CallDef[],
  table: BlockTable,
): { readonly removed: ReadonlySet<SeamGroup>; readonly cells: number } {
  const apiById = new Map(calls.map((c) => [c.id, c.api]));
  const frameMaterial = new Map<number, string>();
  for (const call of calls) {
    if (call.api !== 'opening') continue;
    const material = FRAME_MATERIAL_IN_ARGS.exec(call.args)?.[1];
    if (material !== undefined) {
      try {
        frameMaterial.set(call.id, parseState(table, material).canonical);
      } catch {
        // 材质不合法时该调用不计入 frame 判别。
      }
    }
  }
  const boundsSolid = (x: number, y: number, z: number, dy: 1 | -1): Cell | undefined => {
    for (let d = 1; d <= MAX_SEAM_LAYERS + 1; d += 1) {
      const c = grid.get(x, y + dy * d, z);
      if (c !== undefined) return c;
    }
    return undefined;
  };
  const isFrameCell = (c: Cell | undefined): boolean => {
    if (c === undefined || apiById.get(c.call) !== 'opening') return false;
    const material = frameMaterial.get(c.call);
    return material !== undefined && c.state.canonical === material;
  };
  const removed = new Set<SeamGroup>();
  let cells = 0;
  for (const group of seams.groups) {
    if (group.samples.length === 0) continue;
    const framed = group.samples.every(
      (s) => isFrameCell(boundsSolid(s.x, s.y, s.z, -1)) && isFrameCell(boundsSolid(s.x, s.y, s.z, 1)),
    );
    if (framed) {
      removed.add(group);
      cells += group.cells;
    }
  }
  return { removed, cells };
}
