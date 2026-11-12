/**
 * runner 的外圈接线（runner.ts 的一部分，拆出以控制文件长度）：
 * 工具上下文（store / turn / seed / 预算 / 合并信号 / 子运行宿主）与 run.end + trace.json 收尾。
 *
 * 不负责：主循环、护栏、请求与工具分发（runner.ts）；trace 派生规则（@pg/store/derive）。
 * 本文件不做决策，只把参数拼成 runner 需要的形状。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ChatClient } from '@pg/llm/client';
import type { LlmFailure } from '@pg/llm/schema';
import { deriveTrace } from '@pg/store/derive';
import type { EventBody, StopReason } from '@pg/store/events';
import { openRunDir } from '@pg/store/run-dir';
import type { RunWriter } from '@pg/store/run-dir';

import type { MassingHostDeps, MassingToolHost } from './massing/host.ts';
import type { RunnerInput } from './runner.ts';
import type { TargetBudget, TargetContext } from './target.ts';

/** 工具上下文所需的 runner 状态；可选键显式允许 undefined（exactOptionalPropertyTypes）。 */
export interface TargetContextInput {
  readonly store: RunWriter;
  readonly turn: number;
  readonly seed: number;
  readonly clock: () => number;
  readonly budget: TargetBudget;
  readonly remainingWallMs: () => number;
  readonly signal?: AbortSignal | undefined;
  readonly sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  readonly massing?: MassingHostDeps | undefined;
  /** 父 ChatClient（子运行缺省复用它）；mock / 回放由调用方给得进来。 */
  readonly massingClient: ChatClient;
  readonly countTokens: (text: string) => number;
  readonly mode: RunnerInput['mode'];
  readonly config: RunnerInput['config'];
}

/** 组装工具阶段的上下文；`massing` 未接线时字段缺席，massing 工具据此回 no-host。 */
export function targetContext(input: TargetContextInput): TargetContext {
  const massing: MassingToolHost | undefined =
    input.massing === undefined
      ? undefined
      : {
          deps: input.massing,
          client: input.massing.client ?? input.massingClient,
          clock: input.clock,
          countTokens: input.countTokens,
          mode: input.mode,
          config: input.config,
        };
  return {
    store: input.store,
    turn: input.turn,
    seed: input.seed,
    clock: input.clock,
    budget: input.budget,
    remainingWallMs: input.remainingWallMs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
    ...(massing === undefined ? {} : { massing }),
  };
}

/** run.end 与 trace.json 的输入；totals 是 runner 累计的 token / 尝试计数。 */
export interface RunEndState {
  readonly store: RunWriter;
  readonly stopReason: StopReason | null;
  readonly failure: LlmFailure | undefined;
  readonly totals: {
    readonly requests: number;
    readonly attempts: number;
    readonly prompt: number;
    readonly hit: number | null;
    readonly miss: number | null;
    readonly completion: number;
    readonly reasoning: number;
  };
  readonly turns: number;
  readonly costCny: number | null;
  readonly wallMs: number;
  readonly images: number;
  readonly imageBytes: number;
  /** 目标产物引用（`lastArchive` / `lastModel`），由 TargetSession.finish 给。 */
  readonly finish: () => Pick<EventBody<'run.end'>, 'lastArchive' | 'lastModel'>;
}

/** 写 run.end、关闭 store、派生并落盘 trace.json（runner 的收尾顺序）。 */
export function finishRun(state: RunEndState): void {
  state.store.append('run.end', null, {
    stopReason: state.stopReason,
    ...(state.failure === undefined ? {} : { failure: state.failure }),
    totals: {
      turns: state.turns,
      requests: state.totals.requests,
      attempts: state.totals.attempts,
      promptTokens: state.totals.prompt,
      hitTokens: state.totals.hit,
      missTokens: state.totals.miss,
      completionTokens: state.totals.completion,
      reasoningTokens: state.totals.reasoning,
      costCny: state.costCny,
      wallMs: state.wallMs,
      images: state.images,
      imageBytes: state.imageBytes,
    },
    ...state.finish(),
  });
  state.store.close();
  const trace = deriveTrace(openRunDir(state.store.dir).events());
  writeFileSync(join(state.store.dir, 'trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
}
