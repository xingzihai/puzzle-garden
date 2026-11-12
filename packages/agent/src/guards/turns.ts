/**
 * 轮数与提交窗口护栏（AGENT-SPEC §6.2）：maxTurns 为数字时，将要进行第 maxTurns + 1 轮时停止；
 * 将要进行第 maxTurns − submitWindow + 1 轮时进入提交窗口。maxTurns 为 null（不限轮数，决策 #87）时
 * 永远继续，既不停止也不进窗口——此时由花费窗口与墙钟窗口负责收尾。
 *
 * 窗口一旦进入不退出（inWindow 由 runner 维护，本护栏只发窗口信号）。纯函数。
 */

import type { Guard, GuardAction, GuardState } from '@pg/agent/guards/types';

function check(state: GuardState): GuardAction {
  if (state.maxTurns === null) return 'continue';
  if (state.nextTurn > state.maxTurns) return { stop: 'max-turns' };
  if (!state.inWindow && state.nextTurn >= state.maxTurns - state.submitWindow + 1) return { window: true };
  return 'continue';
}

export const turnsGuard: Guard = {
  name: 'turns',
  beforeRequest: check,
  afterTurn: () => 'continue',
};
