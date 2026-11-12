/**
 * 上下文护栏（AGENT-SPEC §6.2）：上次请求 prompt_tokens > 900_000 时停止。
 *
 * 模型上限 1M（决策 #24）；留出下一轮的余量。纯函数。
 */

import type { Guard, GuardAction, GuardState } from '@pg/agent/guards/types';

/** 模型上限 1M，取 900k 作停止线（AGENT-SPEC §6.2）。 */
export const CONTEXT_TOKEN_LIMIT = 900_000;

function check(state: GuardState): GuardAction {
  if (state.lastPromptTokens !== null && state.lastPromptTokens > CONTEXT_TOKEN_LIMIT) {
    return { stop: 'context-limit' };
  }
  return 'continue';
}

export const contextGuard: Guard = {
  name: 'context',
  beforeRequest: check,
  afterTurn: () => 'continue',
};
