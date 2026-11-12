/**
 * `read_massing`（SUBAGENT-LOOP-SPEC §5.3）：按引用 id 带行号读成功子运行的 `source.ts`。
 *
 * 负责：按 `massing#N` 查会话记录、未知 id 的明确报错、行号从 1 起 / 闭区间 / 一次最多 400 行。
 * 不负责：读子运行目录（记录里已有源码）、子运行生命周期（massing/host.ts）、工具分发（turn-tools.ts）。
 * 本文件是纯函数：只读传入的记录，不做 I/O；不提供读 `model.json` 的工具（文档大，几何摘要已覆盖用途）。
 * 输出里不写子运行代码版本号：回放按记录重建时也必须逐字一致（`subrun.result` 不记 codeVersion）。
 */

import type { MassingRunRecord } from '../massing/tool.ts';

/** 一次最多显示的行数（与 read_code 同口径）。 */
export const MAX_READ_MASSING_LINES = 400;

export interface ReadMassingResult {
  readonly status: 'ok' | 'unknown-id';
  readonly text: string;
}

function linesOf(code: string): string[] {
  if (code === '') return [];
  return code.endsWith('\n') ? code.slice(0, -1).split('\n') : code.split('\n');
}

/**
 * 读某个成功草模运行的源码；未知 id 时列出可用引用。
 * 行号从 1 起、闭区间；超出总量截到总量，单次超过 400 行截到 `from + 399` 并注明。
 */
export function readMassing(
  runs: readonly MassingRunRecord[],
  id: string,
  from?: number,
  to?: number,
): ReadMassingResult {
  const record = runs.find((run) => run.id === id);
  if (record === undefined) {
    const known = runs.length === 0 ? '本 run 还没有成功的草模子运行' : `可用引用：${runs.map((r) => r.id).join('、')}`;
    return { status: 'unknown-id', text: `没有草模引用 ${id}（${known}）；先调用 massing。` };
  }
  const lines = linesOf(record.source);
  const total = lines.length;
  if (total === 0) return { status: 'ok', text: `${record.id} 的源码为空，共 0 行。` };
  const start = from ?? 1;
  const end = to ?? total;
  if (!Number.isSafeInteger(start) || start < 1) {
    return { status: 'ok', text: `read_massing.from 应是 ≥ 1 的整数，实际是 ${JSON.stringify(from)}。` };
  }
  if (!Number.isSafeInteger(end) || end < 1) {
    return { status: 'ok', text: `read_massing.to 应是 ≥ 1 的整数，实际是 ${JSON.stringify(to)}。` };
  }
  if (start > total) {
    return { status: 'ok', text: `read_massing.from=${String(start)} 超出范围：${record.id} 共 ${String(total)} 行。` };
  }
  if (end < start) {
    return { status: 'ok', text: `read_massing.to=${String(end)} 小于 from=${String(start)}：需要闭区间 [from, to]。` };
  }
  const requested = Math.min(end, total);
  const capped = requested > start + (MAX_READ_MASSING_LINES - 1) ? start + (MAX_READ_MASSING_LINES - 1) : requested;
  const shown = lines.slice(start - 1, capped);
  const body = shown.map((line, i) => `${String(start + i)}| ${line}`).join('\n');
  const note =
    capped < requested ? `\n（已截断，显示 ${String(start)}–${String(capped)}，共 ${String(total)} 行）` : '';
  return {
    status: 'ok',
    text: `${record.id}，共 ${String(total)} 行，显示 ${String(start)}–${String(capped)}：\n${body}${note}`,
  };
}
