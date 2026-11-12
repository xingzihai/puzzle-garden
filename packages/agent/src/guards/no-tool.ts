/**
 * 无工具护栏（AGENT-SPEC §6.2、§3.2）：连续 3 轮没有工具调用 → stop no-tool。
 *
 * 有工具调用的轮次把连续计数清零。纯函数，计数由 runner 维护。
 */

import type { Guard, GuardAction, GuardState, TurnSummary } from '@pg/agent/guards/types';

/** 连续无工具轮数达到它就停止。 */
export const NO_TOOL_STOP_AT = 3;

function afterTurn(state: GuardState, turn: TurnSummary): GuardAction {
  const streak = turn.calls.length === 0 ? state.consecutiveNoTool + 1 : 0;
  return streak >= NO_TOOL_STOP_AT ? { stop: 'no-tool' } : 'continue';
}

export const noToolGuard: Guard = {
  name: 'no-tool',
  beforeRequest: () => 'continue',
  afterTurn,
};
