/**
 * 卡死护栏（AGENT-SPEC §6.2）：连续 5 次同名同参数工具调用且结果文本相同 → 第 3 次提醒、第 5 次停止。
 *
 * 比较的键是（工具名、参数原文、结果文本）；runner 把本轮之前的调用放进 state.callsBefore
 * （至少保留最近 STOP_AT − 1 条），本护栏只读不改。纯函数。
 */

import type { Guard, GuardAction, GuardState, ToolCallSummary, TurnSummary } from '@pg/agent/guards/types';

/** 第 3 次在事实行提醒。 */
export const STUCK_WARN_AT = 3;
/** 第 5 次停止。 */
export const STUCK_STOP_AT = 5;

function same(a: ToolCallSummary, b: ToolCallSummary): boolean {
  return a.name === b.name && a.arguments === b.arguments && a.result === b.result;
}

/** 末尾连续同名同参数同结果的条数。 */
export function stuckStreak(calls: readonly ToolCallSummary[]): number {
  const last = calls[calls.length - 1];
  if (last === undefined) return 0;
  let streak = 0;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i];
    if (call === undefined || !same(call, last)) break;
    streak += 1;
  }
  return streak;
}

function afterTurn(state: GuardState, turn: TurnSummary): GuardAction {
  const streak = stuckStreak([...state.callsBefore, ...turn.calls]);
  if (streak >= STUCK_STOP_AT) return { stop: 'stuck' };
  if (streak >= STUCK_WARN_AT) {
    return { warn: `同一工具已连续 ${String(streak)} 次同名同参数且结果相同：换一种做法，或先 read_code。` };
  }
  return 'continue';
}

export const stuckGuard: Guard = {
  name: 'stuck',
  beforeRequest: () => 'continue',
  afterTurn,
};
