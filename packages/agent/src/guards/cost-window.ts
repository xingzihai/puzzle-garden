/**
 * 花费窗口护栏（AGENT-SPEC §6.2、MODEL-SPEC §4.3 C6）：
 * `limit − spent < 3 × max(最近 3 次请求实际花费)` 时进入提交窗口。
 *
 * 最近不足 3 次时用已有的；没有任何历史不触发。`limitCny === 0` 关闭护栏。纯函数。
 */

import type { Guard, GuardAction, GuardState } from '@pg/agent/guards/types';

/** 看最近几次实际花费。 */
export const COST_WINDOW_SAMPLES = 3;

function check(state: GuardState): GuardAction {
  if (state.limitCny === 0 || state.inWindow) return 'continue';
  const recent = state.recentCostsCny.slice(-COST_WINDOW_SAMPLES);
  if (recent.length === 0) return 'continue';
  const threshold = COST_WINDOW_SAMPLES * Math.max(...recent);
  return state.limitCny - state.spentCny < threshold ? { window: true } : 'continue';
}

export const costWindowGuard: Guard = {
  name: 'cost-window',
  beforeRequest: check,
  afterTurn: () => 'continue',
};
