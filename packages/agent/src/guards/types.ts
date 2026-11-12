/**
 * 护栏共用的状态与动作类型（AGENT-SPEC §6.2）。纯类型文件，无运行时代码。
 *
 * 状态由 runner 维护并传入；护栏自身不持有可变状态（退化流检测器除外，见 degenerate.ts）。
 * `GuardStopReason` 是 `@pg/store/events` 的 `StopReason` 的子集：批 4 不依赖 store（§15 依赖为 0），
 * 批 6 把这里返回的 stop 原样当 StopReason 用。
 */

/** 护栏能产生的停止原因，取值与 store 的 StopReason 一致。 */
export type GuardStopReason =
  'wall' | 'cost-budget' | 'max-turns' | 'context-limit' | 'image-budget' | 'degenerate-loop' | 'stuck' | 'no-tool';

/** 护栏动作：继续 / 警告 / 进入提交窗口 / 停止。 */
export type GuardAction =
  'continue' | { readonly warn: string } | { readonly window: true } | { readonly stop: GuardStopReason };

/** 一次工具调用的摘要，用于卡死检测（同名同参数同结果）。 */
export interface ToolCallSummary {
  readonly name: string;
  readonly arguments: string;
  readonly result: string;
}

/** 刚结束的一轮；calls 为空表示本轮没有调用工具。 */
export interface TurnSummary {
  readonly calls: readonly ToolCallSummary[];
  /** 本轮请求是否因退化重复被当场取消（§6.2 退化重复）。 */
  readonly abortedDegenerate: boolean;
}

/** 护栏决策所需的 runner 状态快照。 */
export interface GuardState {
  readonly elapsedMs: number;
  readonly wallMs: number;
  /** 花费上限；0 表示关闭花费护栏（MODEL-SPEC §4.3 第 3 条）。 */
  readonly limitCny: number;
  readonly spentCny: number;
  /** runner 本次请求算出的 max_tokens；尚未预留为 null。 */
  readonly plannedMaxTokens: number | null;
  /** 将要进行的轮次（从 1 起，C15）。 */
  readonly nextTurn: number;
  /** 轮数上限；null 表示不限轮数（决策 #87）。 */
  readonly maxTurns: number | null;
  readonly submitWindow: number;
  /** 是否已在提交窗口内；窗口一旦进入不退出。 */
  readonly inWindow: boolean;
  /** 最近请求的实际花费（元），新的在后。 */
  readonly recentCostsCny: readonly number[];
  /** 上次请求的 prompt_tokens；首次请求前为 null。 */
  readonly lastPromptTokens: number | null;
  /** 累计图片 base64 字节（不含 data URL 前缀）。 */
  readonly imageBytes: number;
  readonly imageBytesSoft: number;
  readonly imageBytesHard: number;
  /** 已连续被退化取消的次数（不含本轮）。 */
  readonly consecutiveAbortedDegenerate: number;
  /** 已连续没有工具调用的轮数（不含本轮）。 */
  readonly consecutiveNoTool: number;
  /** 本轮之前的工具调用摘要（只保留检测卡死需要的最近若干条，新的在后）。 */
  readonly callsBefore: readonly ToolCallSummary[];
}

/** 护栏中间件接口（§6.2）。 */
export interface Guard {
  readonly name: string;
  beforeRequest(state: GuardState): GuardAction;
  afterTurn(state: GuardState, turn: TurnSummary): GuardAction;
  beforeRetry?(state: GuardState): GuardAction;
}
