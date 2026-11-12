/**
 * 花费护栏（AGENT-SPEC §6.2、MODEL-SPEC §4.3）：预留算出的 max_tokens < 2000 时不发请求。
 *
 * 预留本身在 runner 里用 `@pg/llm/cost` 的 `reserveFor` 算；本护栏只做判断。
 * `limitCny === 0` 表示关闭花费护栏（MODEL-SPEC §4.3 第 3 条）。纯函数。
 */

import type { Guard, GuardAction, GuardState } from '@pg/agent/guards/types';
import { LAST_GASP_MAX_OUTPUT_TOKENS, LAST_GASP_MIN_OUTPUT_TOKENS, MIN_REQUEST_MAX_TOKENS } from '@pg/llm/cost';

/** 低于它一次有效的局部编辑也写不完（MODEL-SPEC §4.3）。 */
export const MIN_MAX_TOKENS = MIN_REQUEST_MAX_TOKENS;

function check(state: GuardState): GuardAction {
  if (state.limitCny === 0) return 'continue';
  if (state.plannedMaxTokens !== null && state.plannedMaxTokens < MIN_MAX_TOKENS) {
    // reserveFor 只在提交窗口传入 submitLastGasp 时才会返回 256–1024；这里再要求仍在窗口内，
    // 避免普通 write/edit 因低预留被放行。
    if (
      state.inWindow &&
      state.plannedMaxTokens >= LAST_GASP_MIN_OUTPUT_TOKENS &&
      state.plannedMaxTokens <= LAST_GASP_MAX_OUTPUT_TOKENS
    )
      return 'continue';
    return { stop: 'cost-budget' };
  }
  return 'continue';
}

export const costGuard: Guard = {
  name: 'cost',
  beforeRequest: check,
  afterTurn: () => 'continue',
  beforeRetry: check,
};
