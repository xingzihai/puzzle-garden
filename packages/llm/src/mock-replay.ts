/**
 * 回放 fetch（MODEL-SPEC §6.4，strict）：按顺序重放原 run 的每次尝试，重试路径也被重放。
 *
 * 负责：从回放源取 llm.request / llm.attempt / llm.response；成功的用 encodeSse 重编原响应，HTTP 错误回同一状态码，
 *   断流同样断流，退化取消发完部分内容后挂起；每次请求体 sha256 必须等于原 requestSha。
 * 不负责：打开 run 目录。@pg/store 依赖 @pg/llm，llm 不能反向依赖 store，所以这里只声明最小的结构类型
 *   `ReplaySource`；`openRunDir(dir)` 返回的 RunReader 可直接传入（批 6 接上）。
 */

import { z } from 'zod';

import { encodeSse } from './mock-sse.ts';
import { encoder, MockExhausted, planFetch, placeholderChunks, rngFor, sha256Hex, takeBytes } from './mock-http.ts';
import type { Plan } from './mock-http.ts';
import { ChatRequest, FinishReason, LlmFailure, Message, Usage } from './schema.ts';
import type { ChatResponse, PartialResponse } from './schema.ts';

/** strict 回放：请求体与原记录不一致（§6.4）。 */
export class ReplayMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayMismatch';
  }
}

/** 回放需要的最小读取接口；@pg/store 的 RunReader 结构上满足它。 */
export interface ReplaySource {
  events(): readonly { readonly seq: number; readonly type: string; readonly body: unknown }[];
  blob(sha256: string): Uint8Array;
  /** 还原 seq 处 llm.request 的请求体字节（用于报告第一处差异）。 */
  request(seq: number): Uint8Array;
}

const Ref = z.looseObject({ sha256: z.string() });
const RequestBody = z.looseObject({ requestSha: z.string() });
const AttemptBody = z.looseObject({
  attempt: z.int(),
  outcome: z.enum(['ok', 'retry', 'final-failure', 'aborted-by-caller', 'stopped-by-guard']),
  failure: z.nullable(LlmFailure),
  charge: z.enum(['usage', 'reserve', 'none', 'unmetered']),
  usage: z.nullable(Usage),
});
const ResponseBody = z.discriminatedUnion('outcome', [
  z.looseObject({ outcome: z.literal('ok'), response: Ref }),
  z.looseObject({ outcome: z.literal('aborted-by-caller'), partial: Ref }),
]);
const StoredResponse = z.looseObject({
  id: z.string(),
  model: z.string(),
  systemFingerprint: z.nullable(z.string()),
  message: Message,
  rawArguments: z.array(z.strictObject({ index: z.int(), text: z.string() })),
  finishReason: FinishReason,
  usage: Usage,
});
const StoredPartial = z.looseObject({
  content: z.string(),
  reasoning: z.string(),
  arguments: z.array(z.strictObject({ index: z.int(), name: z.nullable(z.string()), text: z.string() })),
});

interface RecordedAttempt {
  readonly requestSeq: number;
  readonly requestSha: string;
  readonly attempt: z.infer<typeof AttemptBody>;
  /** 成功或取消时对应的 llm.response 引用。 */
  response: z.infer<typeof ResponseBody> | null;
}

/** 按事件顺序列出每次尝试；llm.response 归属于它之前最近的一次尝试。 */
function collectAttempts(source: ReplaySource): RecordedAttempt[] {
  const out: RecordedAttempt[] = [];
  let request: { seq: number; sha: string } | null = null;
  for (const event of source.events()) {
    if (event.type === 'llm.request') {
      request = { seq: event.seq, sha: RequestBody.parse(event.body).requestSha };
    } else if (event.type === 'llm.attempt') {
      if (request === null) throw new Error(`回放源第 ${String(event.seq)} 条 llm.attempt 之前没有 llm.request`);
      out.push({
        requestSeq: request.seq,
        requestSha: request.sha,
        attempt: AttemptBody.parse(event.body),
        response: null,
      });
    } else if (event.type === 'llm.response') {
      const last = out.at(-1);
      if (last === undefined) throw new Error(`回放源第 ${String(event.seq)} 条 llm.response 之前没有 llm.attempt`);
      last.response = ResponseBody.parse(event.body);
    }
  }
  return out;
}

function blobJson(source: ReplaySource, sha256: string): unknown {
  return JSON.parse(new TextDecoder().decode(source.blob(sha256)));
}

function preview(m: unknown): string {
  return JSON.stringify(m).slice(0, 200);
}

/** 报告第一处差异：消息下标、角色、前 200 字符；消息都相同时报参数差异。 */
function describeMismatch(original: string, actual: string): string {
  const a = ChatRequest.safeParse(JSON.parse(original));
  const b = ChatRequest.safeParse(JSON.parse(actual));
  if (!a.success || !b.success) return '请求体无法按 ChatRequest 解析';
  const n = Math.max(a.data.messages.length, b.data.messages.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.data.messages[i];
    const y = b.data.messages[i];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    return `第 ${String(i)} 条消息不同：原 ${x?.role ?? '（无）'} ${preview(x)}；现 ${y?.role ?? '（无）'} ${preview(y)}`;
  }
  return `消息相同，参数不同：原 ${preview({ ...a.data, messages: [] })}；现 ${preview({ ...b.data, messages: [] })}`;
}

function replayPlan(source: ReplaySource, rec: RecordedAttempt, rng: () => number, divergeMs: number): Plan {
  const { attempt } = rec;
  if (attempt.outcome === 'ok') {
    if (rec.response?.outcome !== 'ok')
      throw new Error(`回放源：第 ${String(rec.requestSeq)} 条请求的成功尝试缺少 llm.response`);
    const stored = StoredResponse.parse(blobJson(source, rec.response.response.sha256));
    if (stored.message.role !== 'assistant') throw new Error('回放源：llm.response 的 message 不是 assistant');
    const response: ChatResponse = {
      ...stored,
      message: stored.message,
      usageMismatch: false,
      timing: { firstByteMs: 0, firstTokenMs: null, totalMs: 0 },
    };
    return { kind: 'stream', chunks: encodeSse(response, rng), end: { kind: 'close' } };
  }
  if (attempt.outcome === 'aborted-by-caller') {
    if (rec.response?.outcome !== 'aborted-by-caller') {
      throw new Error(`回放源：第 ${String(rec.requestSeq)} 条请求的取消尝试缺少 llm.response`);
    }
    const stored = StoredPartial.parse(blobJson(source, rec.response.partial.sha256));
    const partial: PartialResponse = { ...stored, timing: { firstByteMs: 0, totalMs: 0 } };
    return {
      kind: 'stream',
      chunks: encodeSse(partial, rng, { wholeDeltas: true }),
      end: {
        kind: 'hang-then-diverge',
        afterMs: divergeMs,
        message: `回放 diverged：第 ${String(rec.requestSeq)} 条请求原 run 在此被调用方取消，回放发完记录的部分内容后 ${String(divergeMs)} ms 内没有再次取消`,
      },
    };
  }
  const failure = attempt.failure;
  if (failure === null) throw new Error(`回放源：第 ${String(rec.requestSeq)} 条请求的失败尝试没有 failure`);
  switch (failure.class) {
    case 'http':
      return { kind: 'status', status: failure.status ?? 500 };
    case 'transport':
    case 'cancelled': {
      if (attempt.charge === 'none') {
        return failure.code === 'network' ? { kind: 'network-error' } : { kind: 'hang-before-headers' };
      }
      const head = takeBytes(placeholderChunks(rng), 1);
      return { kind: 'stream', chunks: head, end: failure.code === 'network' ? { kind: 'close' } : { kind: 'hang' } };
    }
    case 'truncated': {
      if (attempt.usage === null) throw new Error('回放源：truncated 尝试没有 usage');
      const finishReason = FinishReason.parse(failure.code);
      const response: ChatResponse = {
        id: 'replay-truncated',
        model: 'deepseek-flash',
        systemFingerprint: null,
        message: { role: 'assistant', content: '' },
        rawArguments: [],
        finishReason,
        usage: attempt.usage,
        usageMismatch: false,
        timing: { firstByteMs: 0, firstTokenMs: null, totalMs: 0 },
      };
      return { kind: 'stream', chunks: encodeSse(response, rng), end: { kind: 'close' } };
    }
    case 'invalid-response': {
      const line = failure.code === 'no-usage' ? 'data: [DONE]\n\n' : 'data: {不是 JSON\n\n';
      return { kind: 'stream', chunks: [...placeholderChunks(rng), encoder.encode(line)], end: { kind: 'close' } };
    }
  }
}

export interface ReplayFetchDeps {
  /** 退化取消回放的等待；与 client 共用同一个（虚拟）时间源。 */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 缺省 5000（§6.4）。 */
  readonly divergeMs?: number;
}

/**
 * 回放 fetch（strict）：按顺序重放原 run 的每次尝试；每次请求体 sha256 必须等于原 `requestSha`，
 * 否则抛 ReplayMismatch 并报告第一处差异。尝试用尽仍有请求抛 MockExhausted。
 */
export function createReplayFetch(source: ReplaySource, seed: number, deps: ReplayFetchDeps): typeof fetch {
  const attempts = collectAttempts(source);
  const divergeMs = deps.divergeMs ?? 5000;
  let index = 0;

  const plan = (body: string): Plan => {
    const rec = attempts[index];
    if (rec === undefined) throw new MockExhausted(`原 run 的 ${String(attempts.length)} 次尝试已回放完，仍收到请求`);
    if (sha256Hex(body) !== rec.requestSha) {
      const original = new TextDecoder().decode(source.request(rec.requestSeq));
      throw new ReplayMismatch(
        `strict 回放第 ${String(index + 1)} 次尝试的请求体与原 run 第 ${String(rec.requestSeq)} 条 llm.request 不一致：${describeMismatch(original, body)}`,
      );
    }
    const p = replayPlan(source, rec, rngFor(seed, index), divergeMs);
    index += 1;
    return p;
  };

  return planFetch(plan, { sleep: deps.sleep });
}
