/**
 * 共享工具阶段的墙钟与外部取消：执行前拒绝、执行中传递合并信号、返回后拦截迟到提交。
 * 不分发工具、不交付、不请求模型；始终等工具退出后清理，避免后台工具在 run.end 后继续写事件。
 */
import type { ToolCall } from '@pg/llm/schema';
import type { StopReason } from '@pg/store/events';

import type { TargetContext, TargetSession, TargetTurn } from './target.ts';

interface ToolStageOptions {
  readonly elapsed: () => number;
  readonly wallMs: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface ToolStageResult {
  readonly turn: TargetTurn | null;
  readonly stop: StopReason | null;
}

export async function runToolStage(
  session: TargetSession,
  calls: readonly ToolCall[],
  invalid: ReadonlySet<number>,
  context: TargetContext,
  options: ToolStageOptions,
): Promise<ToolStageResult> {
  const controller = new AbortController();
  const timer = new AbortController();
  let deadline = false;
  const timerFailure: { error?: { readonly cause: unknown } } = {};
  const reason = (): 'wall' | 'cancelled' | null => {
    if (deadline || options.elapsed() >= options.wallMs) return 'wall';
    return context.signal?.aborted === true ? 'cancelled' : null;
  };
  const result = (turn: TargetTurn | null): ToolStageResult => {
    const stop = reason() ?? turn?.stop ?? null;
    if (stop === 'wall') {
      context.store.append('guard', context.turn, {
        name: 'wall',
        action: 'stop',
        value: Math.max(0, Math.round(options.elapsed())),
        limit: options.wallMs,
      });
    }
    return { turn, stop };
  };
  const onExternal = (): void => {
    controller.abort();
  };
  try {
    if (reason() !== null) return result(null);
    context.signal?.addEventListener('abort', onExternal, { once: true });
    if (options.sleep !== undefined) {
      void options.sleep(Math.max(0, options.wallMs - options.elapsed()), timer.signal).then(
        () => {
          if (timer.signal.aborted) return;
          deadline = true;
          controller.abort();
        },
        (error: unknown) => {
          if (timer.signal.aborted) return; // finally 主动取消定时器属于预期退出
          timerFailure.error = { cause: error };
          controller.abort();
        },
      );
    }
    const turn = await session.runTools(calls, invalid, { ...context, signal: controller.signal });
    if (timerFailure.error !== undefined) throw timerFailure.error.cause;
    return result(turn);
  } catch (error) {
    // 取消导致的 AbortError 是预期停止；其他宿主缺陷仍交入口记录，不因碰巧到点被吞掉。
    if (error instanceof Error && error.name === 'AbortError' && reason() !== null) return result(null);
    throw error;
  } finally {
    timer.abort();
    context.signal?.removeEventListener('abort', onExternal);
  }
}
