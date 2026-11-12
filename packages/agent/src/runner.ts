/* eslint-disable max-lines -- runner 的主循环、请求预算与事实编排同属一个入口；拆分另立任务。 */
/**
 * 单一 runner（AGENT-SPEC §1、§3.2、§6；MODEL-SPEC §4.3、§7）：一次 run 的主循环。
 *
 * 负责：写 run.start / prompt.system → 每轮 turn.start{elapsedMs}（C7）→ 预留与请求前护栏 → client.complete
 *   （onDelta 接退化检测 C10、beforeRetry 接护栏 C4、墙钟经 signal 取消）→ llm.request / llm.attempt / llm.response
 *   → 工具分发（turn-tools.ts）→ 退化取消的替代消息（C11）→ 轮末护栏 → 事实行 + 本轮图片（C13）→ 交付或停止
 *   → run.end（停止原因、failure、合计）与 trace.json。
 * 不负责：读题目文件与 RunInput 解析（input.ts）、选择模型来源（cli.ts）、工具逻辑（tools/*）、护栏判断（guards/*）。
 * 依赖全部注入（§9）：client、check、render、store、clock、可选 sleep / signal、版本与 token 计数。
 * store 由调用方创建；runner 结束时写 run.end、关闭它并写 trace.json。
 */

import type { PromptVersion } from '@pg/config';
import type { ChatClient } from '@pg/llm/client';
import { LLM_CLIENT_VERSION } from '@pg/llm/client';
import { costOf, reserveFor } from '@pg/llm/cost';
import type { ReserveResult } from '@pg/llm/cost';
import { PRICING_VERSION } from '@pg/llm/pricing';
import { serializeRequest } from '@pg/llm/schema';
import type { ChatRequest, ImagePart, LlmFailure, Message, TextPart } from '@pg/llm/schema';
import type { RenderRequest, RenderResult } from '@pg/render/render';
import { canonicalJson } from '@pg/store/canonical-json';
import { RunLimits } from '@pg/store/events';
import type { Ref, StopReason, Versions } from '@pg/store/events';
import { encodeRequest } from '@pg/store/request-codec';
import type { RunWriter } from '@pg/store/run-dir';

import { createRunBudget, UNLIMITED_CNY } from './budget.ts';
import { degenerateContent } from './facts.ts';
import type { MassingHostDeps } from './massing/host.ts';
import { CONTEXT_TOKEN_LIMIT } from './guards/context.ts';
import { MIN_MAX_TOKENS } from './guards/cost.ts';
import { createDegenerateDetector } from './guards/degenerate.ts';
import { IMAGE_BYTES_HARD, IMAGE_BYTES_SOFT } from './guards/image.ts';
import { STUCK_STOP_AT } from './guards/stuck.ts';
import type { Guard, GuardAction, GuardState, ToolCallSummary, TurnSummary } from './guards/types.ts';
import { RUN_GUARDS as GUARDS, WINDOW_GUARDS, guardMetric } from './runner-guards.ts';
import type { DesignAuthority, PromptVariant } from './prompt/system.ts';
import { retainViewImages } from './tools/view-retention.ts';
import { initialContextMessage, newContent } from './request-content.ts';
import { finishRun, targetContext } from './runner-finish.ts';
import { lineCount } from './tools/code-edit.ts';
import type { CheckDeps } from './tools/check.ts';
import type { RunnerTarget, TargetContext, TargetTurn } from './target.ts';
import { runToolStage } from './tool-stage.ts';
import { sha256Hex } from './turn-tools.ts';
import { resolveTarget } from './voxel-target.ts';

/** 首请求硬上限的计数口径；由生产入口注入官方 tokenizer，避免不同入口的粗估口径漂移。 */
export interface FirstRequestBudget {
  readonly maxTokens: number;
  readonly countTokens: (text: string) => number;
}

/** 已解析好的一次 run 的输入（读文件与 extractTaskBody 由 input.ts 做）。 */
export interface RunnerInput {
  /** 本次特许候选；省略保持旧 DeepSeek 行为。GPT 无计费且不接草模子运行。 */
  readonly model?: 'deepseek-flash' | 'gpt-6.1-sol';
  /** 原题目全文（算 task.sha256）与实际喂给模型的正文。 */
  readonly task: { readonly raw: string; readonly fed: string; readonly source: string | null };
  readonly seed: number;
  readonly limits: RunLimits;
  readonly mode: 'live' | 'script' | 'replay';
  /** system 提示变体（决策 #84），进 `versions.promptVariant`，回放时须与原 run 一致。 */
  readonly variant: PromptVariant;
  /**
   * 提示版本（W11-06a）：v2 才启用 L2 状态卡；v1 请求形状保持不变。
   * W11-18 起 v2 也保留完整历史（不做 8 轮压缩），避免滑动 digest 破坏 prompt cache。
   * 生产入口挂在 `RunnerInput` 扩展字段上，不写进 `run.start.config`。
   */
  readonly promptVersion?: PromptVersion;
  readonly initialDraft?: { readonly code: string }; // 种子稿：第 1 版从此代码开始（分段实验第 2 段）
  /** 要求先写设计文档才能 submit（两层实验，AGENT-SPEC §4.5）。 */
  readonly requireDesign?: boolean;
  /** 上一阶段交付的骨架设计文档：有值时作为第三条 user 消息的一部分（两层实验第 2 层）。 */
  readonly initialDesign?: string;
  /**
   * initialDesign 的形态：`full` = design.md 原文；`digest` = v2 生产的确定性摘要。
   * 只影响 read_design 的来源标注，不改变消息内容。缺省按 `full`，避免把完整文档误标成摘要。
   */
  readonly initialDesignKind?: 'full' | 'digest';
  /** 设计阶段派生的机器可校验施工合同（BuildSheet markdown）；与 designAuthority: fixed 一起使用。 */
  readonly initialBuildSheet?: string;
  /**
   * 生产首请求硬上限：入口用官方 tokenizer 计数，runner 在写 run.start 前检查并抛可行动错误。
   * 只有生产装配（design-build）设置；缺省不改变测试 / 回放 / 旧调用方行为。
   */
  readonly firstRequestBudget?: FirstRequestBudget;
  /**
   * 设计权威：缺省 `free`（旧行为）；`fixed` 表示 initialDesign 是用户确认的唯一方案，
   * system 提示追加"已确认方案"约定，构建 agent 不得自行改设计。
   */
  readonly designAuthority?: DesignAuthority;
  /** 上一阶段交付的骨架渲染图：有值时附在第三条 user 消息里（两层实验第 2 层）。 */
  readonly initialImages?: readonly { readonly name: string; readonly png: Uint8Array }[];
  readonly script?: { readonly name: string; readonly sha256: string };
  readonly replayOf?: string;
  /** 非 live 为 null（C16）。 */
  readonly config: { readonly baseUrl: string; readonly timeoutMs: number } | null;
  /** 子运行（massing 工具）写进 `run.start.parent` 的父关联（SUBAGENT-LOOP-SPEC §2.2）。 */
  readonly parent?: { readonly runId: string; readonly dir: string; readonly callId: string; readonly turn: number };
}

/** runner 自己能算的版本项之外的组件版本（git、node、沙箱、分析等由调用方给）。 */
type ExternalOf<T> = T extends Versions
  ? Omit<T, 'tools' | 'prompt' | 'promptVariant' | 'factsFormat' | 'model' | 'pricing' | 'llmClient' | 'eventsSchema'>
  : never;
export type ExternalVersions = ExternalOf<Versions>;

export interface SharedRunnerDeps {
  readonly client: ChatClient;
  readonly store: RunWriter;
  /** 单调毫秒；回放时由调用方按原事件流的 elapsedMs 给值（C7）。 */
  readonly clock: () => number;
  /** 给出时在墙钟到点时取消进行中的请求和工具（§6.2 墙钟）。 */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Ctrl-C 等外部取消。 */
  readonly signal?: AbortSignal;
  readonly versions: ExternalVersions;
  /** 离线 token 计数（prompt.system.tokensOffline）。 */
  readonly countTokens: (text: string) => number;
  /** massing 工具的草模子运行宿主；未接线时工具回 no-host（SUBAGENT-LOOP-SPEC §6）。 */
  readonly massing?: MassingHostDeps;
}

/** 旧体素依赖保持必填；显式 target 完全替换体素依赖。 */
export interface RunnerDeps extends SharedRunnerDeps {
  readonly target?: undefined;
  readonly check: Omit<CheckDeps, 'clock'>;
  readonly render: (archive: Uint8Array, request: RenderRequest) => Promise<RenderResult>;
  readonly worldDts: string;
  /** 交付注记的权威生成器；给定后覆盖模型 submit 的自述。 */
  readonly deliveryNote?: (info: { readonly codeVersion: number; readonly hash: string }) => string | null;
}
export interface TargetRunnerDeps extends SharedRunnerDeps {
  readonly target: RunnerTarget;
}

export interface RunOutcome {
  readonly runId: string;
  readonly dir: string;
  /** 交付为 null。 */
  readonly stopReason: StopReason | null;
  readonly failure?: LlmFailure;
  readonly delivery: { readonly codeVersion: number; readonly hash: string } | null;
  readonly costCny: number | null;
  readonly turns: number;
}

/** 元 × 1e8 取整累计（MODEL-SPEC §4.2）。 */
const OCTA = 1e8;
const encoder = new TextEncoder();

/** v2 生产首请求的硬上限（官方 tokenizer；system + tools + task + 初始上下文 + 固定开销）。 */
export const FIRST_REQUEST_HARD_CAP_TOKENS = 20_000;
/** 与 `tools/prompt-budget.test.ts` 相同的请求包装开销口径。 */
export const FIRST_REQUEST_OVERHEAD_TOKENS = 300;

/** 首请求预算超限的专用错误：入口据此给出可行动信息，而不是发出去后才发现。 */
export class FirstRequestBudgetError extends Error {
  readonly tokens: number;
  readonly maxTokens: number;
  constructor(tokens: number, maxTokens: number) {
    super(
      `v2 首请求估算 ${String(tokens)} token，超过生产硬上限 ${String(maxTokens)}；` +
        '请缩短 design digest / BuildSheet，或设置 PG_PROMPT_VERSION=v1 回滚。',
    );
    this.name = 'FirstRequestBudgetError';
    this.tokens = tokens;
    this.maxTokens = maxTokens;
  }
}

/** 首请求 token 估算：与预算测试同口径，不把图片 base64 或工具 schema 的包装重复计入。 */
export function estimateFirstRequestTokens(args: {
  readonly system: string;
  readonly toolsJson: string;
  readonly task: string;
  readonly context: string;
  readonly countTokens: (text: string) => number;
}): number {
  return (
    args.countTokens(args.system) +
    args.countTokens(args.toolsJson) +
    args.countTokens(args.task) +
    args.countTokens(args.context) +
    FIRST_REQUEST_OVERHEAD_TOKENS
  );
}

/** 初始上下文可能是纯文本或文本 + 图片块；只计文本，图片另走 imageBytes 预算。 */
function initialContextText(content: string | readonly (TextPart | ImagePart)[]): string {
  return typeof content === 'string'
    ? content
    : content
        .filter((part): part is TextPart => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
}

interface GuardResult {
  readonly stop: StopReason | null;
  readonly warnings: readonly string[];
  readonly entered: boolean;
}

/** 执行一次 run。store 由调用方创建，本函数结束时关闭并写 trace.json。 */
export async function runRun(input: RunnerInput, deps: RunnerDeps | TargetRunnerDeps): Promise<RunOutcome> {
  const limits = RunLimits.parse(input.limits);
  const model = input.model ?? 'deepseek-flash';
  const unmetered = model === 'gpt-6.1-sol';
  if (unmetered && (limits.maxCostCny !== 0 || deps.massing !== undefined))
    throw new Error('GPT 特许运行必须关闭金额限制且不接草模子运行。');
  const { store } = deps;
  const t0 = deps.clock();
  const elapsed = (): number => Math.max(0, Math.round(deps.clock() - t0));
  const blob = (data: string): Ref => store.putBlob(encoder.encode(data));

  // ── run.start 与 prompt.system ──
  const target = resolveTarget(input, deps);
  const system = target.system(input, limits);
  const tools = [...target.tools];
  const toolsJson = canonicalJson(tools);
  // 两层实验第 2 层：把上一阶段的骨架设计文档、机器合同与渲染图作为第三条 user 消息传入（不占工具轮）。
  const hasInitial =
    input.initialDesign !== undefined || input.initialBuildSheet !== undefined || input.initialImages !== undefined;
  const initialContext = hasInitial
    ? initialContextMessage(input.initialDesign, input.initialImages ?? [], {
        hasInitialDraft: Boolean(input.initialDraft?.code.trim()),
        ...(input.initialBuildSheet === undefined ? {} : { buildSheet: input.initialBuildSheet }),
        ...(input.designAuthority === undefined ? {} : { designAuthority: input.designAuthority }),
      })
    : null;
  // 生产硬上限在写 run.start 之前检查，超限不留下半截 run；旧调用方不设预算则行为不变。
  if (input.firstRequestBudget !== undefined) {
    const tokens = estimateFirstRequestTokens({
      system,
      toolsJson,
      task: input.task.fed,
      context: initialContext === null ? '' : initialContextText(initialContext.content),
      countTokens: input.firstRequestBudget.countTokens,
    });
    if (tokens > input.firstRequestBudget.maxTokens) {
      throw new FirstRequestBudgetError(tokens, input.firstRequestBudget.maxTokens);
    }
  }
  const fed = blob(input.task.fed);
  store.append('run.start', null, {
    task: { sha256: sha256Hex(encoder.encode(input.task.raw)), source: input.task.source, fedSha256: fed.sha256, fed },
    seed: input.seed,
    mode: input.mode,
    ...(unmetered ? { accounting: 'unmetered' as const } : {}),
    ...(input.replayOf === undefined ? {} : { replayOf: input.replayOf }),
    ...(input.script === undefined ? {} : { script: input.script }),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    limits,
    guardConstants: {
      imageBytesSoft: IMAGE_BYTES_SOFT,
      imageBytesHard: IMAGE_BYTES_HARD,
      contextTokens: CONTEXT_TOKEN_LIMIT,
      minMaxTokens: MIN_MAX_TOKENS,
    },
    versions: {
      ...deps.versions,
      // 3 起支持 subrun.result / run.start.parent（决策 #115）；2 的旧记录仍可解析（events.ts 用 union）。
      eventsSchema: unmetered ? 4 : 3,
      tools: sha256Hex(encoder.encode(toolsJson)),
      prompt: sha256Hex(encoder.encode(system)),
      promptVariant: input.variant,
      factsFormat: target.factsFormat,
      model,
      pricing: unmetered ? 'unmetered-owner-exemption' : PRICING_VERSION,
      llmClient: LLM_CLIENT_VERSION,
    },
    config: input.config,
  });
  store.append('prompt.system', null, {
    system: blob(system),
    tools: blob(toolsJson),
    tokensOffline: { system: deps.countTokens(system), tools: deps.countTokens(JSON.stringify(tools)) },
  });
  if (input.initialDraft !== undefined) {
    const { code } = input.initialDraft;
    store.append('code.version', null, { version: 1, code: blob(code), via: 'seed', lines: lineCount(code) });
  }
  // ── run 状态 ──
  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: input.task.fed },
  ];
  const run = {
    sent: 0,
    spentOcta: 0,
    /** 子运行预留（元 × 1e8）：与 `spentOcta` 一起满足 `spent + 预留 ≤ limit`（C6，SUBAGENT-LOOP-SPEC §3.1）。 */
    subrunReservedOcta: 0,
    recentCosts: [] as number[],
    lastPromptTokens: null as number | null,
    consecutiveDegenerate: 0,
    consecutiveNoTool: 0,
    callsBefore: [] as ToolCallSummary[],
    turn: 0,
    nextElapsed: null as number | null,
    stopReason: null as StopReason | null,
    failure: undefined as LlmFailure | undefined,
    delivery: null as RunOutcome['delivery'],
  };
  // 父预算：图片计数与子运行预留共用 `tool` / `run` 同一份状态（SUBAGENT-LOOP-SPEC §3.1）。
  const tool = createRunBudget(limits, run);
  const session = target.create(input, tool);
  if (initialContext !== null) {
    messages.push({ role: 'user', content: initialContext.content });
    tool.imageBytes += initialContext.imageBytes;
    tool.images += initialContext.images;
  }
  const totals = {
    requests: 0,
    attempts: 0,
    prompt: 0,
    hit: 0 as number | null,
    miss: 0 as number | null,
    completion: 0,
    reasoning: 0,
  };
  const spentCny = (): number => run.spentOcta / OCTA;
  const guardState = (nextTurn: number, elapsedMs: number, plannedMaxTokens: number | null): GuardState => ({
    elapsedMs,
    wallMs: limits.wallMs,
    limitCny: limits.maxCostCny,
    spentCny: spentCny(),
    plannedMaxTokens,
    nextTurn,
    maxTurns: limits.maxTurns,
    submitWindow: limits.submitWindow,
    inWindow: tool.inWindow,
    recentCostsCny: run.recentCosts.slice(-3),
    lastPromptTokens: run.lastPromptTokens,
    imageBytes: tool.imageBytes,
    imageBytesSoft: IMAGE_BYTES_SOFT,
    imageBytesHard: IMAGE_BYTES_HARD,
    consecutiveAbortedDegenerate: run.consecutiveDegenerate,
    consecutiveNoTool: run.consecutiveNoTool,
    callsBefore: run.callsBefore,
  });
  /** 跑一组护栏：第一个 stop 即返回；进入窗口在这里落状态（窗口一旦进入不退出）；每个动作写 guard 事件。 */
  const runGuards = (
    list: readonly Guard[],
    s: GuardState,
    act: (g: Guard) => GuardAction,
    calls: readonly ToolCallSummary[] = [],
  ): GuardResult => {
    const warnings: string[] = [];
    let entered = false;
    for (const g of list) {
      const action = act(g);
      if (action === 'continue') continue;
      const [value, limit] = guardMetric(g.name, s, calls);
      if ('stop' in action) {
        store.append('guard', run.turn, { name: g.name, action: 'stop', value, limit });
        return { stop: action.stop, warnings, entered };
      }
      if ('window' in action) {
        if (tool.inWindow) continue;
        tool.inWindow = true;
        entered = true;
        store.append('guard', run.turn, { name: g.name, action: 'window', value, limit });
        continue;
      }
      warnings.push(action.warn);
      store.append('guard', run.turn, { name: g.name, action: 'warn', value, limit });
    }
    return { stop: null, warnings, entered };
  };
  /** 一次请求：预留 → 护栏 → 发送 → 结算。返回 null 表示 run 停止（stopReason 已设）。 */
  const request = async (elapsedMs: number): Promise<Awaited<ReturnType<ChatClient['complete']>> | null> => {
    const fresh = messages.slice(run.sent);
    const content = newContent(fresh);
    const first = run.sent === 0;
    // W11-18：v2 默认不压缩历史，完整消息逐轮追加，保证相邻请求的公共前缀稳定。
    // 旧的 compactHistory 会随轮次滑动 cutoff 并重写 digest，把 prompt cache 在 digest 处打断
    // （v2 smoke：T10 起 LCP 25→3、cache hit 冻结在 18,944）。55 轮实测约 39k，1M 窗口足够；
    // 未来长 run 若需压缩，应先改成固定 checkpoint 且压缩后的旧消息冻结，再显式接线。
    const requestMessages = messages;
    const reserveNow = (pendingOcta = 0): ReserveResult =>
      unmetered
        ? { maxTokens: 0, reservedCny: 0, inputUpper: 0 }
        : reserveFor({
            prevPromptTokens: run.lastPromptTokens ?? 0,
            first,
            newBytes: content.bytes + (first ? encoder.encode(toolsJson).length : 0),
            newMessages: fresh.length,
            newImages: content.images,
            spentCny: (run.spentOcta + run.subrunReservedOcta + pendingOcta) / OCTA,
            limitCny: limits.maxCostCny === 0 ? spentCny() + UNLIMITED_CNY : limits.maxCostCny,
            // 提交窗口的最后一口气：只有窗口内且已有真实花费时，才允许把输出上限压到
            // 256–1024 再试一次；普通 write/edit / 窗口外仍沿用 2000 的原始预留门槛。
            ...(!first && tool.inWindow && run.recentCosts.length > 0
              ? { submitLastGasp: { recentCostsCny: run.recentCosts.slice(-3) } }
              : {}),
          });
    const reserve = reserveNow();
    const planned = 'stop' in reserve ? 0 : reserve.maxTokens;
    const s = guardState(run.turn, elapsedMs, planned);
    const pre = runGuards(GUARDS, s, (g) => g.beforeRequest(s));
    if (pre.stop !== null || 'stop' in reserve) {
      run.stopReason = pre.stop ?? 'cost-budget';
      return null;
    }

    // deepseek-flash 支持 reasoning；这里关闭 thinking 是当前刻意配置，不是模型能力限制。
    const req: ChatRequest = {
      model,
      messages: requestMessages,
      tools,
      ...(unmetered
        ? { reasoning_effort: 'low' as const }
        : { thinking: { type: 'disabled' as const }, max_tokens: reserve.maxTokens }),
      stream: true,
      stream_options: { include_usage: true },
    };
    const encoded = encodeRequest(req, sha256Hex);
    for (const b of encoded.blobs) store.putBlob(b.bytes);
    const body = encoder.encode(serializeRequest(req));
    store.append('llm.request', run.turn, {
      requestSha: sha256Hex(body),
      manifest: blob(canonicalJson(encoded.manifest)),
      bodyBytes: body.length,
      messages: requestMessages.length,
      images: tool.images,
      imageBytes: tool.imageBytes,
      reserve: {
        cny: unmetered ? null : reserve.reservedCny,
        maxTokens: unmetered ? null : reserve.maxTokens,
        inputUpper: unmetered ? null : reserve.inputUpper,
      },
    });
    run.sent = messages.length;
    totals.requests += 1;

    const detector = createDegenerateDetector();
    const controller = new AbortController();
    const timers = new AbortController();
    const flags: { wall: boolean; guardStop: StopReason | null } = { wall: false, guardStop: null };
    const onExternal = (): void => {
      controller.abort();
    };
    if (deps.signal?.aborted === true) controller.abort();
    deps.signal?.addEventListener('abort', onExternal);
    if (deps.sleep !== undefined) {
      // 墙钟：到点经 signal 取消进行中的请求（§6.2）
      void deps.sleep(Math.max(0, limits.wallMs - elapsedMs), timers.signal).then(
        () => {
          if (timers.signal.aborted) return;
          flags.wall = true;
          controller.abort();
        },
        () => undefined, // 请求结束时计时器被取消：预期内
      );
    }
    let requestOcta = 0;
    try {
      return await deps.client.complete(req, {
        signal: controller.signal,
        onDelta: (d) => (d.kind === 'reasoning' ? 'continue' : detector.push(d.text)),
        beforeRetry: (next) => {
          detector.reset();
          // client 先问护栏、后报告刚失败的那次尝试（onAttempt 'retry'），此时它还没结算。
          // 按上界计入：HTTP 错误码记 ¥0，其余（断流、超时、带 usage 的截断）按本次预留全额（MODEL-SPEC §4.3 第 2 步）。
          const reserveOcta = Math.round(reserve.reservedCny * OCTA);
          const pendingOcta = next.failure.class === 'http' ? 0 : reserveOcta;
          const r = reserveNow(pendingOcta);
          const rs = {
            ...guardState(run.turn, elapsed(), 'stop' in r ? 0 : r.maxTokens),
            spentCny: (run.spentOcta + pendingOcta) / OCTA,
          };
          const g = runGuards(
            GUARDS.filter((x) => x.beforeRetry !== undefined),
            rs,
            (x) => x.beforeRetry?.(rs) ?? 'continue',
          );
          // 重发同一请求体（max_tokens 不变），所以硬约束按本次预留核对（C6）
          const over =
            limits.maxCostCny > 0 && run.spentOcta + pendingOcta + reserveOcta > Math.round(limits.maxCostCny * OCTA);
          flags.guardStop = g.stop ?? ('stop' in r || over ? 'cost-budget' : null);
          return flags.guardStop === null ? 'continue' : 'stop';
        },
        onAttempt: (a) => {
          totals.attempts += 1;
          const cny = unmetered
            ? 0
            : a.charge === 'usage' && a.usage !== null
              ? costOf(a.usage)
              : a.charge === 'reserve'
                ? reserve.reservedCny
                : 0;
          const octa = Math.round(cny * OCTA);
          run.spentOcta += octa;
          requestOcta += octa;
          store.append('llm.attempt', run.turn, {
            ...a,
            ...(unmetered ? { charge: 'unmetered' as const } : {}),
            settledCny: unmetered ? null : octa / OCTA,
          });
        },
      });
    } finally {
      timers.abort();
      deps.signal?.removeEventListener('abort', onExternal);
      run.recentCosts.push(requestOcta / OCTA);
      if (flags.wall) run.stopReason = 'wall';
      else if (deps.signal?.aborted === true) run.stopReason = 'cancelled';
      else if (flags.guardStop !== null) run.stopReason = flags.guardStop;
    }
  };

  const toolContext = (): TargetContext =>
    targetContext({
      store,
      turn: run.turn,
      seed: input.seed,
      clock: deps.clock,
      budget: tool,
      remainingWallMs: () => Math.max(0, limits.wallMs - elapsed()),
      signal: deps.signal,
      sleep: deps.sleep,
      massing: deps.massing,
      massingClient: deps.client,
      countTokens: deps.countTokens,
      mode: input.mode,
      config: input.config,
    });

  /** 轮末：事实行（+ 本轮图片）。墙钟取下一轮 turn.start 的值（C7）。 */
  const appendFacts = (turnTools: TargetTurn | null, abortedDegenerate: boolean, warnings: readonly string[]): void => {
    const elapsedMs = elapsed();
    run.nextElapsed = elapsedMs;
    const nextTurn = run.turn + 1;
    const ws = guardState(nextTurn, elapsedMs, null);
    // 只取"进入窗口"；轮数等的 stop 留给下一轮请求前的护栏判断，避免重复记 guard 事件
    const win = runGuards(WINDOW_GUARDS, ws, (g) => {
      const action = g.beforeRequest(ws);
      return action !== 'continue' && 'window' in action ? action : 'continue';
    });
    const noTool = turnTools === null || turnTools.summaries.length === 0;
    const facts = session.formatFacts({
      ...(unmetered ? { accounting: 'unmetered' as const } : {}),
      nextTurn,
      maxTurns: limits.maxTurns,
      spentCny: spentCny(),
      maxCostCny: limits.maxCostCny,
      elapsedMs,
      wallMs: limits.wallMs,
      window: tool.inWindow
        ? {
            remaining: limits.maxTurns === null ? null : Math.max(0, limits.maxTurns - nextTurn + 1),
            entering: win.entered,
          }
        : null,
      ...(abortedDegenerate ? { event: 'degenerate' as const } : noTool ? { event: 'no-tool' as const } : {}),
      warnings,
    });
    const images = turnTools?.images ?? [];
    const parts: (TextPart | ImagePart)[] = [{ type: 'text', text: facts }];
    for (const p of images) {
      parts.push(
        p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.image_url.url } },
      );
    }
    messages.push({ role: 'user', content: images.length === 0 ? facts : parts });
    // 只保留每个立面最近 1–2 张迭代图；交付消息与非视角图不裁。数组长度不变，run.sent 仍有效。
    const retained = retainViewImages(messages, 2);
    if (retained !== messages) messages.splice(0, messages.length, ...retained);
    store.append('facts', run.turn, {
      text: blob(facts),
      measures: blob(JSON.stringify(turnTools?.measures ?? null)),
    });
  };

  /** 一轮；返回 false 表示 run 结束。 */
  const step = async (): Promise<boolean> => {
    run.turn += 1;
    const elapsedMs = run.nextElapsed ?? elapsed();
    run.nextElapsed = null;
    store.append('turn.start', run.turn, { elapsedMs, spentCny: spentCny() });

    const outcome = await request(elapsedMs);
    if (outcome === null) return false;
    if (outcome.kind === 'failed') {
      if (run.stopReason === null) {
        run.stopReason = 'llm-error';
        run.failure = outcome.failure;
      }
      return false;
    }

    let turnTools: TargetTurn | null = null;
    let abortedDegenerate = false;
    if (outcome.kind === 'aborted-by-caller') {
      // C11：截断的 assistant 文本，不带 tool_calls
      abortedDegenerate = true;
      store.append('llm.response', run.turn, {
        outcome: 'aborted-by-caller',
        reason: 'degenerate',
        partial: blob(JSON.stringify(outcome.partial)),
        settledCny: unmetered ? null : (run.recentCosts.at(-1) ?? 0),
      });
      messages.push({ role: 'assistant', content: degenerateContent(outcome.partial.content) });
    } else {
      const r = outcome.response;
      const u = r.usage;
      totals.prompt += u.prompt_tokens;
      totals.hit =
        totals.hit === null || u.prompt_cache_hit_tokens === undefined ? null : totals.hit + u.prompt_cache_hit_tokens;
      totals.miss =
        totals.miss === null || u.prompt_cache_miss_tokens === undefined
          ? null
          : totals.miss + u.prompt_cache_miss_tokens;
      totals.completion += u.completion_tokens;
      totals.reasoning += u.completion_tokens_details?.reasoning_tokens ?? 0;
      run.lastPromptTokens = u.prompt_tokens;
      store.append('llm.response', run.turn, {
        outcome: 'ok',
        response: blob(JSON.stringify(r)),
        finishReason: r.finishReason,
        usage: u,
        cny: unmetered ? null : costOf(u),
        model: r.model,
        systemFingerprint: r.systemFingerprint,
        timing: r.timing,
        usageMismatch: r.usageMismatch,
        ...(r.rawArguments.length === 0 ? {} : { rawArguments: blob(JSON.stringify(r.rawArguments)) }),
      });
      messages.push(r.message); // 已做 C12 替换：坏参数为 "{}"
      const invalid = new Set(r.rawArguments.map((x) => x.index));
      const stage = await runToolStage(session, r.message.tool_calls ?? [], invalid, toolContext(), {
        elapsed: () => deps.clock() - t0,
        wallMs: limits.wallMs,
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      });
      turnTools = stage.turn;
      messages.push(...(turnTools?.toolMessages ?? []));
      if (stage.stop !== null) {
        run.stopReason = stage.stop;
        return false;
      }
      if (turnTools?.submitted === true) {
        run.delivery = await session.deliver(toolContext());
        return false;
      }
    }

    const calls = turnTools?.summaries ?? [];
    const after = guardState(run.turn + 1, elapsedMs, null);
    const summary: TurnSummary = { calls, abortedDegenerate };
    const post = runGuards(GUARDS, after, (g) => g.afterTurn(after, summary), calls);
    if (post.stop !== null) {
      run.stopReason = post.stop;
      return false;
    }
    run.consecutiveDegenerate = abortedDegenerate ? run.consecutiveDegenerate + 1 : 0;
    run.consecutiveNoTool = calls.length === 0 ? run.consecutiveNoTool + 1 : 0;
    run.callsBefore = [...run.callsBefore, ...calls].slice(-(STUCK_STOP_AT - 1));
    appendFacts(turnTools, abortedDegenerate, post.warnings);
    return true;
  };

  const finish = (): void => {
    finishRun({
      store,
      stopReason: run.delivery === null ? (run.stopReason ?? 'internal-error') : null,
      failure: run.failure,
      totals,
      turns: run.turn,
      costCny: unmetered ? null : spentCny(),
      wallMs: elapsed(),
      images: tool.images,
      imageBytes: tool.imageBytes,
      finish: () => session.finish(),
    });
  };
  try {
    while (await step()) {
      // 每轮的工作都在 step 里；这里只判断是否继续
    }
  } catch (error) {
    // 不可预期的异常：照样收尾（run.end internal-error），再交给入口记录
    run.stopReason = 'internal-error';
    finish();
    throw error;
  }
  finish();
  return {
    runId: store.runId,
    dir: store.dir,
    stopReason: run.delivery === null ? (run.stopReason ?? 'internal-error') : null,
    ...(run.failure === undefined ? {} : { failure: run.failure }),
    delivery: run.delivery,
    costCny: unmetered ? null : spentCny(),
    turns: run.turn,
  };
}
