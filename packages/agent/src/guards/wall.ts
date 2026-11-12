/**
 * 墙钟护栏（AGENT-SPEC §6.2）：`elapsedMs ≥ wallMs` 时在请求前或重试前停止。
 *
 * 不负责取消进行中的请求（经 signal，由 runner 与 client 处理）。纯函数：只读状态。
 */

import type { Guard, GuardAction, GuardState } from '@pg/agent/guards/types';

function check(state: GuardState): GuardAction {
  return state.elapsedMs >= state.wallMs ? { stop: 'wall' } : 'continue';
}

export const wallGuard: Guard = {
  name: 'wall',
  beforeRequest: check,
  afterTurn: () => 'continue',
  beforeRetry: check,
};
