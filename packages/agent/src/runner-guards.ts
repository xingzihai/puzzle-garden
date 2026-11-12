/** runner 使用的护栏顺序与事件数值；只组装现有护栏，不做请求、计费或 I/O。 */
import { contextGuard, CONTEXT_TOKEN_LIMIT } from './guards/context.ts';
import { costGuard, MIN_MAX_TOKENS } from './guards/cost.ts';
import { costWindowGuard } from './guards/cost-window.ts';
import { degenerateGuard } from './guards/degenerate.ts';
import { imageGuard } from './guards/image.ts';
import { noToolGuard, NO_TOOL_STOP_AT } from './guards/no-tool.ts';
import { stuckGuard, stuckStreak, STUCK_STOP_AT } from './guards/stuck.ts';
import { turnsGuard } from './guards/turns.ts';
import type { Guard, GuardState, ToolCallSummary } from './guards/types.ts';
import { wallGuard } from './guards/wall.ts';
import { wallWindowGuard, WALL_WINDOW_MS } from './guards/wall-window.ts';

export const RUN_GUARDS: readonly Guard[] = [
  wallGuard,
  costGuard,
  turnsGuard,
  costWindowGuard,
  wallWindowGuard,
  contextGuard,
  imageGuard,
  degenerateGuard,
  stuckGuard,
  noToolGuard,
];
export const WINDOW_GUARDS: readonly Guard[] = [turnsGuard, costWindowGuard, wallWindowGuard];

/** 写事件的人类可读数值，不代替护栏本身的判断。 */
export function guardMetric(name: string, s: GuardState, calls: readonly ToolCallSummary[]): readonly [number, number] {
  switch (name) {
    case 'wall':
      return [s.elapsedMs, s.wallMs];
    case 'cost':
      return [s.plannedMaxTokens ?? 0, MIN_MAX_TOKENS];
    case 'turns':
      return [s.nextTurn, s.maxTurns ?? 0];
    case 'cost-window':
      return [s.limitCny - s.spentCny, s.limitCny];
    case 'wall-window':
      return [s.wallMs - s.elapsedMs, WALL_WINDOW_MS];
    case 'context':
      return [s.lastPromptTokens ?? 0, CONTEXT_TOKEN_LIMIT];
    case 'image':
      return [s.imageBytes, s.imageBytesHard];
    case 'degenerate':
      return [s.consecutiveAbortedDegenerate + 1, 2];
    case 'stuck':
      return [stuckStreak([...s.callsBefore, ...calls]), STUCK_STOP_AT];
    default:
      return [s.consecutiveNoTool + 1, NO_TOOL_STOP_AT];
  }
}
