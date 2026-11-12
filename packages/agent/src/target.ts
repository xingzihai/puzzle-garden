/**
 * runner 的目标适配契约：目标持有代码/检查/交付状态，共享循环持有请求、计费、护栏和追加式历史。
 * 不定义草模工具或执行模型代码；每次 create 必须返回独立会话，不跨 run 复用可变状态。
 */
import type { Message, ToolCall, ToolDef } from '@pg/llm/schema';
import type { EventBody, RunLimits, StopReason } from '@pg/store/events';
import type { RunWriter } from '@pg/store/run-dir';

import type { MassingToolHost } from './massing/host.ts';
import type { FactsInput } from './facts.ts';
import type { ToolCallSummary } from './guards/types.ts';
import type { RunnerInput } from './runner.ts';
import type { ViewContentPart } from './tools/view.ts';

/**
 * 所有目标共用的图片计数、窗口状态与父预算（SUBAGENT-LOOP-SPEC §3.1）。
 * 工具增加图片计数，不重置累计值或退出窗口；子运行预留 → 结算由 runner 实现（`spentOcta` + `subrunReservedOcta`）。
 */
export interface TargetBudget {
  imageBytes: number;
  images: number;
  inWindow: boolean;
  /** 父 run 还能用于子运行预留的金额；`limit = 0`（关闭护栏）时为 Infinity。 */
  remainingCny(): number;
  /** 按 `spent + pendingSubrun + cny ≤ limit` 预留；拿不到额度返回 false（不改变 state）。 */
  reserveSubrun(cny: number): boolean;
  /** 释放预留、按实际入账；`actual > reserved + 1e-6` 视为父预算不变量破坏，抛错。 */
  settleSubrun(reservedCny: number, actualCny: number): void;
}

export interface TargetContext {
  readonly store: RunWriter;
  readonly turn: number;
  readonly seed: number;
  readonly clock: () => number;
  /** runTools 中合并外部取消与 run 墙钟截止；每个工具执行前检查，并传递给耗时操作。 */
  readonly signal?: AbortSignal;
  readonly budget: TargetBudget;
  /** 子运行墙钟与工具内部等待用的可中止定时器；缺省时子运行没有自己的墙钟护栏。 */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 父 run 剩余墙钟毫秒（子运行启动前检查与墙钟上限，§2.1 第 4 步、§3.2）。 */
  readonly remainingWallMs?: () => number;
  /** 草模子运行宿主；未接线时 massing 工具回 no-host（§6）。 */
  readonly massing?: MassingToolHost;
}

export type TargetFacts = Omit<FactsInput, 'draftVersion' | 'lastCheck' | 'lastViewVersion'>;
export interface TargetDelivery {
  readonly codeVersion: number;
  readonly hash: string;
}

export interface TargetTurn {
  /** 每个调用一个 tool 消息、同序；不得返回或改写 system/user/assistant 历史。 */
  readonly toolMessages: readonly Extract<Message, { role: 'tool' }>[];
  readonly images: readonly ViewContentPart[];
  readonly summaries: readonly ToolCallSummary[];
  readonly measures: unknown;
  readonly stop: StopReason | null;
  /** 接受提交后，本轮其余调用必须回“已提交，未执行”；交付固定到接受时的版本和两个 hash。 */
  readonly submitted: boolean;
}

export interface TargetSession {
  /** 顺序分发，校验 JSON/schema，执行窗口限制，记录 tool.call/result 及目标事件。 */
  readonly runTools: (
    calls: readonly ToolCall[],
    invalidIndices: ReadonlySet<number>,
    context: TargetContext,
  ) => Promise<TargetTurn>;
  readonly formatFacts: (facts: TargetFacts) => string;
  /** 只在 submitted=true 时调用；写 delivery 文件与合法目标 delivery 事件。 */
  readonly deliver: (context: TargetContext) => Promise<TargetDelivery>;
  /** run.end 的目标产物引用。草模只返回 lastModel，不得填 lastArchive。 */
  readonly finish: () => Pick<EventBody<'run.end'>, 'lastArchive' | 'lastModel'>;
}

export interface RunnerTarget {
  readonly kind: 'modeling';
  readonly factsFormat: number;
  readonly tools: readonly ToolDef[];
  readonly system: (input: RunnerInput, limits: RunLimits) => string;
  /** 初稿的 code.version(seed) 由 runner 写；目标只初始化状态，不重复写该事件。 */
  readonly create: (input: RunnerInput, budget: TargetBudget) => TargetSession;
}
