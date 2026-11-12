/**
 * @pg/llm 的客户端状态机（MODEL-SPEC §3.5、§4.3 第 2 步、§5）。
 *
 * 负责：发送前校验请求与消息序；经注入的 fetch 发流式请求，交给 sse.ts 拼装；总超时与空闲超时；
 *   错误归一与结算类别（C4）；最多 4 次尝试的退避重试，每次重试前问 beforeRetry；调用方取消与 onDelta 取消。
 * 不负责：预留金额与"一次 run"的花费（agent 的护栏，§4.3）；SSE 文本解析（sse.ts）；读环境变量（@pg/config）。
 *
 * 一切时间都来自注入的 `clock` 与 `sleep`（计时器用 sleep + AbortController 实现，finally 里取消），
 * 所以测试用虚拟时间即可确定地覆盖超时与退避，不真实等待。
 */

import {
  cancelledFailure,
  httpFailure,
  invalidResponse,
  isLlmError,
  LlmError,
  transportFailure,
  truncatedFailure,
} from './errors.ts';
import { ChatRequest, serializeRequest } from './schema.ts';
import type { ChatResponse, Delta, LlmFailure, Message, PartialResponse, Usage } from './schema.ts';
import { createSseAssembler } from './sse.ts';

/** 拼装规则或重试表改动时加 1（MODEL-SPEC §7.5 的 `versions.llmClient`）。 */
export const LLM_CLIENT_VERSION = 3;
/** 最多尝试次数（`v02:v0.2beta/agent/llm.ts:194`）。 */
export const MAX_ATTEMPTS = 4;
/** 连续这么久没收到任何字节（keep-alive 注释算活动）判连接已死（§5.1）。 */
export const IDLE_TIMEOUT_MS = 180_000;
/** 第 n 次重试前的等待（§5.3）；不加抖动：单 run 串行，固定值便于测试与回放。 */
const BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const BACKOFF_429_MS = [5_000, 15_000, 45_000] as const;

export interface ClientDeps {
  readonly config: { readonly baseUrl: string; readonly apiKey: string; readonly timeoutMs: number };
  readonly fetch: typeof fetch;
  /** 等待 ms；signal 取消时应尽快结束（resolve 或 reject 均可）。 */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 单调毫秒，只用于超时与 timing。 */
  readonly clock: () => number;
}

export interface RetryInfo {
  readonly attempt: number;
  readonly failure: LlmFailure;
  readonly delayMs: number;
}

export interface CompleteOptions {
  readonly signal: AbortSignal;
  readonly onDelta?: (d: Delta) => 'continue' | 'abort';
  readonly beforeRetry: (next: RetryInfo) => 'continue' | 'stop';
  readonly onAttempt: (a: AttemptRecord) => void;
}

export type AttemptOutcome = 'ok' | 'retry' | 'final-failure' | 'aborted-by-caller' | 'stopped-by-guard';
export type Charge = 'usage' | 'reserve' | 'none';

export interface AttemptRecord {
  readonly attempt: number;
  readonly outcome: AttemptOutcome;
  readonly failure: LlmFailure | null;
  readonly charge: Charge;
  readonly usage: Usage | null;
  readonly delayMs: number | null;
  readonly timing: { readonly firstByteMs: number | null; readonly totalMs: number };
}

export type ChatOutcome =
  | { readonly kind: 'ok'; readonly response: ChatResponse }
  | { readonly kind: 'aborted-by-caller'; readonly partial: PartialResponse }
  | { readonly kind: 'failed'; readonly failure: LlmFailure };

export interface ChatClient {
  complete(req: ChatRequest, opts: CompleteOptions): Promise<ChatOutcome>;
}

/** 一次尝试的结果（内部）。 */
type AttemptResult =
  | { readonly kind: 'ok'; readonly response: ChatResponse; readonly timing: AttemptRecord['timing'] }
  | { readonly kind: 'aborted'; readonly partial: PartialResponse; readonly timing: AttemptRecord['timing'] }
  | {
      readonly kind: 'failed';
      readonly failure: LlmFailure;
      readonly charge: Charge;
      readonly usage: Usage | null;
      readonly timing: AttemptRecord['timing'];
    };

/** 本次尝试为什么被自己中止；fetch / read 抛出的 AbortError 据此归类。 */
type AbortCause = 'timeout' | 'idle' | 'cancel' | 'caller-delta';

function messageOrderError(message: string): LlmError {
  return new LlmError(invalidResponse(`消息序不合法（发送前拒绝，未发请求）：${message}`, 'internal-message-order'));
}

/**
 * §3.1 消息序：带 tool_calls 的 assistant 之后必须紧跟且只跟与各 id 一一对应的 tool 消息。
 * v0.2 同轮 user 插在 tool 结果之间导致 400、伪装成网络故障（`v02:docs/LESSONS.md` §8.2、§8.12）。
 */
function assertMessageOrder(messages: readonly Message[]): void {
  let pending = new Set<string>();
  for (const [i, m] of messages.entries()) {
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id)) {
        throw messageOrderError(
          `第 ${String(i)} 条 tool 消息的 tool_call_id 不对应紧邻的 assistant tool_calls，或重复`,
        );
      }
      continue;
    }
    if (pending.size > 0) {
      throw messageOrderError(
        `第 ${String(i)} 条 ${m.role} 消息出现前，还有 ${String(pending.size)} 个 tool_call 没有结果`,
      );
    }
    pending = new Set();
    if (m.role === 'assistant' && m.tool_calls !== undefined) {
      pending = new Set(m.tool_calls.map((c) => c.id));
      if (pending.size !== m.tool_calls.length) {
        throw messageOrderError(`第 ${String(i)} 条 assistant 的 tool_call id 重复`);
      }
    }
  }
  if (pending.size > 0) throw messageOrderError(`末尾 assistant 的 ${String(pending.size)} 个 tool_call 没有结果`);
}

/** 读 signal.aborted 而不让 TS 沿用之前的收窄（等待期间它会变）。 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function createClient(deps: ClientDeps): ChatClient {
  const { config, clock } = deps;
  if (config.apiKey === '') throw new Error('PG_LLM_API_KEY 未设置：live 模式需要 API key。');
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let inFlight = false;

  /** 报错里绝不出现 apiKey（`v02:v0.2beta/agent/llm.ts:217`）。 */
  function scrub(text: string): string {
    return text.replaceAll(config.apiKey, '***').slice(0, 300);
  }

  /** fetch 或读流抛出的错：自己中止的按原因归类；TypeError 是 fetch 的网络错误；其余是程序错误，直接抛出。 */
  function classify(error: unknown, cause: AbortCause | null, phase: string): LlmFailure {
    switch (cause) {
      case 'timeout':
        return transportFailure('timeout', `${phase}超过总超时 ${String(config.timeoutMs)} ms`);
      case 'idle':
        return transportFailure('idle-timeout', `${phase}连续 ${String(IDLE_TIMEOUT_MS)} ms 没有收到任何字节`);
      case 'cancel':
        return cancelledFailure();
      case 'caller-delta':
      case null:
        break;
    }
    if (error instanceof TypeError || isAbortError(error)) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : '未知错误';
      return transportFailure('network', scrub(`${phase}连接失败：${detail}`));
    }
    throw error;
  }

  async function attemptOnce(body: string, opts: CompleteOptions): Promise<AttemptResult> {
    const controller = new AbortController();
    const timers = new AbortController();
    // 用对象而不是 let：cause 在回调里被改，TS 对闭包赋值不做收窄重置。
    const state: { cause: AbortCause | null } = { cause: null };
    const abort = (why: AbortCause): void => {
      if (state.cause !== null) return;
      state.cause = why;
      controller.abort();
    };
    const onCallerAbort = (): void => {
      abort('cancel');
    };
    opts.signal.addEventListener('abort', onCallerAbort);

    const startedAt = clock();
    let lastActivity = startedAt;
    const assembler = createSseAssembler(clock);
    const timing = (): AttemptRecord['timing'] => {
      const firstByteMs = assembler.partial().timing.firstByteMs;
      return {
        firstByteMs: firstByteMs === null ? null : Math.round(firstByteMs),
        totalMs: Math.round(clock() - startedAt),
      };
    };
    const fail = (failure: LlmFailure, charge: Charge, usage: Usage | null = null): AttemptResult => ({
      kind: 'failed',
      failure,
      charge,
      usage,
      timing: timing(),
    });

    // 计时器：sleep 被 timers 取消时会 reject 或提前 resolve，两种都靠 timers.signal.aborted 判定为"已清掉"。
    void deps.sleep(config.timeoutMs, timers.signal).then(
      () => {
        if (!timers.signal.aborted) abort('timeout');
      },
      () => undefined, // 计时器被 finally 取消：预期内，不是错误
    );
    // 空闲计时只在收到 200 之后启动（§5.2：空闲超时属于"收到 200 后"）；响应头之前只受总超时约束。
    const startIdleTimer = (): void => {
      void (async () => {
        while (!timers.signal.aborted) {
          const wait = lastActivity + IDLE_TIMEOUT_MS - clock();
          if (wait <= 0) {
            abort('idle');
            return;
          }
          try {
            await deps.sleep(wait, timers.signal);
          } catch {
            return; // 计时器被 finally 取消：预期内
          }
        }
      })();
    };

    try {
      if (opts.signal.aborted) return fail(cancelledFailure(), 'none');
      // ── 阶段 1：等响应头。这里的失败服务端都没有开始生成，记 ¥0（§4.3 第 2 步）。
      let response: Response;
      try {
        response = await deps.fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        return fail(classify(error, state.cause, '响应头之前'), 'none');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined); // 错误体不读，释放连接即可；取消失败不影响结论
        return fail(httpFailure(response.status), 'none');
      }
      if (response.body === null) {
        return fail(transportFailure('network', 'HTTP 200 但没有响应体'), 'reserve');
      }

      // ── 阶段 2：读流。收到 200 之后的中断服务端可能已生成并计费，按预留全额记（C4）。
      lastActivity = clock();
      startIdleTimer();
      const reader = response.body.getReader();
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (error) {
            return fail(classify(error, state.cause, '读流时'), 'reserve');
          }
          if (state.cause !== null) return fail(classify(null, state.cause, '读流时'), 'reserve');
          if (chunk.done) break;
          lastActivity = clock();
          let deltas: readonly Delta[];
          try {
            deltas = assembler.push(chunk.value);
          } catch (error) {
            if (isLlmError(error)) return fail(error.failure, 'reserve');
            throw error;
          }
          for (const delta of deltas) {
            if (opts.onDelta?.(delta) === 'abort') {
              abort('caller-delta');
              return { kind: 'aborted', partial: assembler.partial(), timing: timing() };
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      const outcome = assembler.finish();
      if (outcome.kind === 'failed') return fail(outcome.failure, 'reserve');
      const r = outcome.response;
      if (r.finishReason === 'insufficient_system_resource' || r.finishReason === 'aborted') {
        return fail(truncatedFailure(r.finishReason), 'usage', r.usage);
      }
      const rounded: ChatResponse = {
        ...r,
        timing: {
          firstByteMs: Math.round(r.timing.firstByteMs),
          firstTokenMs: r.timing.firstTokenMs === null ? null : Math.round(r.timing.firstTokenMs),
          totalMs: Math.round(r.timing.totalMs),
        },
      };
      return { kind: 'ok', response: rounded, timing: timing() };
    } finally {
      timers.abort();
      if (state.cause === null) controller.abort(); // 释放连接；正常结束时也要收掉 fetch 的底层资源
      opts.signal.removeEventListener('abort', onCallerAbort);
    }
  }

  async function run(req: ChatRequest, opts: CompleteOptions): Promise<ChatOutcome> {
    const parsed = ChatRequest.safeParse(req);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new LlmError(
        invalidResponse(
          `请求不符合 ChatRequest（发送前拒绝）：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`,
          'internal-invalid-request',
        ),
      );
    }
    assertMessageOrder(parsed.data.messages);
    const body = serializeRequest(parsed.data);
    if (opts.signal.aborted) return { kind: 'failed', failure: cancelledFailure() };

    for (let attempt = 1; ; attempt += 1) {
      const result = await attemptOnce(body, opts);
      const record = (outcome: AttemptOutcome, extra: Partial<AttemptRecord> = {}): void => {
        opts.onAttempt({
          attempt,
          outcome,
          failure: null,
          charge: 'usage',
          usage: null,
          delayMs: null,
          timing: result.timing,
          ...extra,
        });
      };
      if (result.kind === 'ok') {
        if (
          req.model === 'deepseek-flash' &&
          (result.response.usage.prompt_cache_hit_tokens === undefined ||
            result.response.usage.prompt_cache_miss_tokens === undefined)
        ) {
          const failure = invalidResponse('DeepSeek 响应缺少缓存 usage，不能计费或静默记零', 'no-cache-usage');
          record('final-failure', { failure, charge: 'reserve' });
          return { kind: 'failed', failure };
        }
        record('ok', { usage: result.response.usage });
        return { kind: 'ok', response: result.response };
      }
      if (result.kind === 'aborted') {
        record('aborted-by-caller', { charge: 'reserve' });
        return { kind: 'aborted-by-caller', partial: result.partial };
      }
      const { failure, charge, usage } = result;
      if (!failure.retriable || attempt >= MAX_ATTEMPTS) {
        record('final-failure', { failure, charge, usage });
        return { kind: 'failed', failure };
      }
      const table = failure.code === 'http_429' ? BACKOFF_429_MS : BACKOFF_MS;
      const delayMs = table[attempt - 1] ?? table[2];
      if (opts.beforeRetry({ attempt: attempt + 1, failure, delayMs }) === 'stop') {
        record('stopped-by-guard', { failure, charge, usage });
        return { kind: 'failed', failure };
      }
      record('retry', { failure, charge, usage, delayMs });
      try {
        await deps.sleep(delayMs, opts.signal);
      } catch (error) {
        if (!isAborted(opts.signal)) throw error;
      }
      if (isAborted(opts.signal)) return { kind: 'failed', failure: cancelledFailure() };
    }
  }

  return {
    async complete(req: ChatRequest, opts: CompleteOptions): Promise<ChatOutcome> {
      // §5.4：M1 同一时刻只有一个请求；并发调用是 runner 的程序错误，直接拒绝而不是排队。
      if (inFlight) throw new Error('ChatClient.complete 不支持并发调用：上一次请求还没结束。');
      inFlight = true;
      try {
        return await run(req, opts);
      } finally {
        inFlight = false;
      }
    },
  };
}
