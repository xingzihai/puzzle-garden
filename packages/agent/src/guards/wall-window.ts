/**
 * 墙钟窗口护栏（AGENT-SPEC §6.2，决策 #87）：`wallMs − elapsedMs < WALL_WINDOW_MS` 时进入提交窗口。
 *
 * 取消轮数上限后，只剩花费窗口能触发提交窗口，墙钟到点会直接停、没有交付；本护栏补上墙钟侧的窗口。
 * 已在窗口内不重复发窗口信号（inWindow 由 runner 维护）。纯函数：只读状态。
 */

import type { Guard, GuardAction, GuardState } from '@pg/agent/guards/types';

/** 距墙钟到点多少毫秒时进入提交窗口（规格 AGENT-SPEC §6.2：3 分钟）。 */
export const WALL_WINDOW_MS = 180_000;

function check(state: GuardState): GuardAction {
  if (state.inWindow) return 'continue';
  return state.wallMs - state.elapsedMs < WALL_WINDOW_MS ? { window: true } : 'continue';
}

export const wallWindowGuard: Guard = {
  name: 'wall-window',
  beforeRequest: check,
  afterTurn: () => 'continue',
};
