/**
 * 退化重复护栏（AGENT-SPEC §6.2，C10）：
 * 流式 content 与 tool_call 参数片段拼接后，末 8 KiB 中长 20–400 字符的片段连续重复 ≥ 8 次时当场取消；
 * 连续第 2 次被取消则 stop degenerate-loop。
 *
 * 负责：纯检测函数 `detectDegenerate`、流式检测器 `createDegenerateDetector`（供 client 的 onDelta）、
 * 以及统计连续取消的中间件 `degenerateGuard`。
 * 不负责：真正取消请求（onDelta 返回 abort）、追加截断的 assistant 与事实行（runner / facts.ts）。
 */

import type { Guard, GuardAction, GuardState, TurnSummary } from '@pg/agent/guards/types';

/** 只看拼接后文本的末这么多字符。 */
export const DEGENERATE_WINDOW_CHARS = 8192;
/** 重复片段最短长度。 */
export const DEGENERATE_MIN_UNIT = 20;
/** 重复片段最长长度。 */
export const DEGENERATE_MAX_UNIT = 400;
/** 连续重复达到这个次数即判退化。 */
export const DEGENERATE_REPEATS = 8;

/**
 * 末窗口里是否存在长 20–400、连续重复 ≥ 8 次的片段。
 * 从短到长试每个周期；命中即真。
 */
export function detectDegenerate(text: string): boolean {
  const tail = text.length > DEGENERATE_WINDOW_CHARS ? text.slice(text.length - DEGENERATE_WINDOW_CHARS) : text;
  for (let unit = DEGENERATE_MIN_UNIT; unit <= DEGENERATE_MAX_UNIT; unit += 1) {
    const needed = unit * DEGENERATE_REPEATS;
    if (tail.length < needed) continue;
    const start = tail.length - needed;
    const block = tail.slice(start, start + unit);
    if (tail.slice(start) === block.repeat(DEGENERATE_REPEATS)) return true;
  }
  return false;
}

/** 流式检测器：把 content / reasoning / arguments 片段按到达顺序 push；返回 'abort' 时调用方取消请求。 */
export interface DegenerateDetector {
  push(text: string): 'continue' | 'abort';
  reset(): void;
  text(): string;
}

/** 每次请求（含重试）新建或用 reset 清空；buffer 只保留末窗口大小。 */
export function createDegenerateDetector(): DegenerateDetector {
  let buffer = '';
  return {
    push(text: string): 'continue' | 'abort' {
      buffer += text;
      if (buffer.length > DEGENERATE_WINDOW_CHARS) buffer = buffer.slice(buffer.length - DEGENERATE_WINDOW_CHARS);
      return detectDegenerate(buffer) ? 'abort' : 'continue';
    },
    reset(): void {
      buffer = '';
    },
    text(): string {
      return buffer;
    },
  };
}

function afterTurn(state: GuardState, turn: TurnSummary): GuardAction {
  if (!turn.abortedDegenerate) return 'continue';
  return state.consecutiveAbortedDegenerate + 1 >= 2 ? { stop: 'degenerate-loop' } : 'continue';
}

export const degenerateGuard: Guard = {
  name: 'degenerate',
  beforeRequest: () => 'continue',
  afterTurn,
};
