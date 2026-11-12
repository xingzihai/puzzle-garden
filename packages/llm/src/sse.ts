/**
 * @pg/llm 的 SSE 拼装（MODEL-SPEC §3.2、§3.3）。
 *
 * 负责：字节流 → UTF-8 文本 → 行 → 流块 → 拼装成可追加进对话的完整响应；把非法输入归一成 LlmError。
 * 不负责：读网络流、超时、重试、重试前的 beforeRetry（client.ts）。
 * 本文件是纯函数：`clock` 由调用方注入；不做 I/O、不用全局时钟。
 */

import { invalidResponse, isLlmError, LlmError, transportFailure } from './errors.ts';
import { StreamChunk } from './schema.ts';
import type {
  AssistantMessage,
  ChatResponse,
  Delta,
  FinishReason,
  LlmFailure,
  PartialResponse,
  Usage,
} from './schema.ts';

interface ToolCallAccumulator {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  arguments: string;
}

export type SseOutcome =
  { readonly kind: 'ok'; readonly response: ChatResponse } | { readonly kind: 'failed'; readonly failure: LlmFailure };

export interface SseAssembler {
  /** 喂入一个字节块，返回该块解出的增量（供退化检测）。解析错误抛 LlmError。 */
  push(chunk: Uint8Array): readonly Delta[];
  /** 上游连接关闭：已收到 [DONE] 则给出完整响应，否则以 transport/network 失败。 */
  finish(): SseOutcome;
  /** 当前已拼装的内容（取消请求时写 partial）。 */
  partial(): PartialResponse;
}

/**
 * 创建一个 SSE 拼装器。`clock` 是单调毫秒，用于 timing（MODEL-SPEC §3.2 的 ChatResponse.timing）。
 */
export function createSseAssembler(clock: () => number): SseAssembler {
  const startedAt = clock();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let done = false;
  let flushed = false;

  let firstByteAt: number | null = null;
  let firstTokenAt: number | null = null;

  let id = '';
  let model = '';
  let systemFingerprint: string | null = null;
  let sawContent = false;
  let contentText = '';
  let sawReasoning = false;
  let reasoningText = '';
  let finishReason: FinishReason | null = null;
  let usage: Usage | null = null;
  const toolCalls = new Map<number, ToolCallAccumulator>();

  function markToken(): void {
    firstTokenAt ??= clock();
  }

  function absorbChunk(chunk: StreamChunk): Delta[] {
    const deltas: Delta[] = [];
    id = chunk.id;
    model = chunk.model;
    if (chunk.system_fingerprint !== undefined) systemFingerprint = chunk.system_fingerprint;
    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;

    for (const choice of chunk.choices) {
      if (choice.finish_reason !== null) finishReason = choice.finish_reason;
      const delta = choice.delta;

      const reasoning = delta.reasoning_content;
      if (typeof reasoning === 'string' && reasoning !== '') {
        sawReasoning = true;
        reasoningText += reasoning;
        markToken();
        deltas.push({ kind: 'reasoning', text: reasoning });
      }

      const content = delta.content;
      if (typeof content === 'string') {
        sawContent = true;
        if (content !== '') {
          contentText += content;
          markToken();
          deltas.push({ kind: 'content', text: content });
        }
      }

      for (const call of delta.tool_calls ?? []) {
        let acc = toolCalls.get(call.index);
        if (acc === undefined) {
          // 首块须带 id 与 function.name，否则后续无法拼出可回传的 tool_call（MODEL-SPEC §3.2 规则 4）。
          if (call.id === undefined || call.function?.name === undefined) {
            throw new LlmError(invalidResponse(`tool_call index ${String(call.index)} 的首块缺少 id 或 function.name`));
          }
          acc = { index: call.index, id: call.id, name: call.function.name, arguments: '' };
          toolCalls.set(call.index, acc);
        } else {
          if (call.id !== undefined && call.id !== acc.id) {
            throw new LlmError(invalidResponse(`tool_call index ${String(call.index)} 的 id 前后不一致`));
          }
          if (call.function?.name !== undefined && call.function.name !== acc.name) {
            throw new LlmError(invalidResponse(`tool_call index ${String(call.index)} 的 function.name 前后不一致`));
          }
        }
        const fragment = call.function?.arguments;
        if (fragment !== undefined && fragment !== '') {
          acc.arguments += fragment;
          markToken();
          deltas.push({ kind: 'arguments', index: call.index, text: fragment });
        }
      }
    }
    return deltas;
  }

  function handleLine(line: string): Delta[] {
    if (done) {
      if (line !== '' && !line.startsWith(':')) {
        throw new LlmError(invalidResponse('收到 data: [DONE] 之后仍有数据'));
      }
      return [];
    }
    if (line === '' || line.startsWith(':')) return []; // 空行与 keep-alive 注释算活动（§3.2 规则 3）
    if (!line.startsWith('data:')) {
      throw new LlmError(invalidResponse(`SSE 行既不是空行、注释也不是 data:：${line.slice(0, 80)}`));
    }
    let payload = line.slice('data:'.length);
    if (payload.startsWith(' ')) payload = payload.slice(1);
    if (payload === '[DONE]') {
      if (usage === null) {
        throw new LlmError(invalidResponse('[DONE] 之前没有 usage，不能静默记 0', 'no-usage'));
      }
      if (finishReason === null) {
        throw new LlmError(invalidResponse('[DONE] 之前没有 finish_reason'));
      }
      done = true;
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new LlmError(invalidResponse(`SSE data 不是合法 JSON：${payload.slice(0, 80)}`));
    }
    const result = StreamChunk.safeParse(parsed);
    if (!result.success) {
      throw new LlmError(
        invalidResponse(`SSE data 不符合 StreamChunk：${result.error.issues[0]?.message ?? '未知问题'}`),
      );
    }
    return absorbChunk(result.data);
  }

  function buildResponse(): ChatResponse {
    if (usage === null || finishReason === null) {
      throw new LlmError(invalidResponse('内部错误：未在 [DONE] 前拿到 usage 与 finish_reason'));
    }
    const calls = [...toolCalls.values()].sort((a, b) => a.index - b.index);
    const rawArguments: { index: number; text: string }[] = [];
    const serializedCalls = calls.map((call) => {
      let args = call.arguments;
      try {
        JSON.parse(args);
      } catch {
        // 参数不是合法 JSON（常见于 finish_reason: length 截断）：替换为 "{}" 并把原文留给调用方（§3.3）。
        rawArguments.push({ index: call.index, text: args });
        args = '{}';
      }
      return { id: call.id, type: 'function' as const, function: { name: call.name, arguments: args } };
    });
    const hasToolCalls = serializedCalls.length > 0;

    let content: string | null;
    if (sawContent) content = contentText;
    else if (hasToolCalls) content = null;
    else content = '';
    if (finishReason === 'content_filter') content = '';

    const message: AssistantMessage = {
      role: 'assistant',
      content,
      ...(sawReasoning ? { reasoning_content: reasoningText } : {}),
      ...(hasToolCalls ? { tool_calls: serializedCalls } : {}),
    };
    const usageMismatch =
      usage.prompt_cache_hit_tokens !== undefined && usage.prompt_cache_miss_tokens !== undefined
        ? usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens !== usage.prompt_tokens
        : false;
    return {
      id,
      model,
      systemFingerprint,
      message,
      rawArguments,
      finishReason,
      usage,
      usageMismatch,
      timing: {
        firstByteMs: (firstByteAt ?? startedAt) - startedAt,
        firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
        totalMs: clock() - startedAt,
      },
    };
  }

  function partial(): PartialResponse {
    const args = [...toolCalls.values()]
      .sort((a, b) => a.index - b.index)
      .map((call) => ({ index: call.index, name: call.name, text: call.arguments }));
    return {
      content: sawContent ? contentText : '',
      reasoning: sawReasoning ? reasoningText : '',
      arguments: args,
      timing: {
        firstByteMs: firstByteAt === null ? null : firstByteAt - startedAt,
        totalMs: clock() - startedAt,
      },
    };
  }

  return {
    push(chunk: Uint8Array): readonly Delta[] {
      firstByteAt ??= clock();
      let text: string;
      try {
        text = decoder.decode(chunk, { stream: true });
      } catch {
        throw new LlmError(invalidResponse('响应流含非法 UTF-8'));
      }
      buffer += text;
      const deltas: Delta[] = [];
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1); // 兼容 CRLF
        deltas.push(...handleLine(line));
      }
      return deltas;
    },

    finish(): SseOutcome {
      if (!flushed) {
        flushed = true;
        // 连接在 [DONE] 之前关闭时，末尾半个多字节字符或半行 JSON 是断流造成的，归 transport/network（可重试，§5.2）；
        // 只有 [DONE] 之后的残余才是 invalid-response。
        const cutShort = (what: string): SseOutcome => ({
          kind: 'failed',
          failure: done
            ? invalidResponse(`响应流末尾有${what}`)
            : transportFailure('network', `响应流在 data: [DONE] 之前结束，末尾是${what}`),
        });
        try {
          buffer += decoder.decode(); // 冲刷跨块的多字节字符
        } catch {
          return cutShort('不完整的 UTF-8 字符');
        }
        if (buffer !== '') {
          let line = buffer;
          buffer = '';
          if (line.endsWith('\r')) line = line.slice(0, -1);
          try {
            handleLine(line);
          } catch (error) {
            if (!isLlmError(error)) throw error;
            if (done) return { kind: 'failed', failure: error.failure };
            return cutShort('不完整的一行');
          }
        }
      }
      if (!done) return { kind: 'failed', failure: transportFailure('network', '响应流在 data: [DONE] 之前结束') };
      return { kind: 'ok', response: buildResponse() };
    },

    partial,
  };
}
