/**
 * 剧本 fetch（MODEL-SPEC §6.2）与 mock 的公开入口（`@pg/llm/mock`）。
 *
 * 负责：剧本格式；每次请求先按 ChatRequest 解析、核对 expect、按步骤回复（消息、HTTP 错误、断流、挂起）；
 *   usage 由请求算出并压到 max_tokens（A7）。转出回放 fetch、SSE 编码与虚拟时间，调用方只 import 这一个入口。
 * 不负责：HTTP 响应构造（mock-http.ts）、回放（mock-replay.ts）、SSE 字节切法（mock-sse.ts）。
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { encodeSse } from './mock-sse.ts';
import { encoder, MockExhausted, planFetch, placeholderChunks, rngFor, takeBytes } from './mock-http.ts';
import type { Plan } from './mock-http.ts';
import { ChatRequest, FinishReason, serializeRequest } from './schema.ts';
import type { AssistantMessage, ChatResponse, Message, Usage } from './schema.ts';

export { encodeSse } from './mock-sse.ts';
export type { EncodeSseOptions } from './mock-sse.ts';
export { createVirtualTime, MockExhausted, ReplayDiverged } from './mock-http.ts';
export type { VirtualTime } from './mock-http.ts';
export { createReplayFetch, ReplayMismatch } from './mock-replay.ts';
export type { ReplayFetchDeps, ReplaySource } from './mock-replay.ts';

// ───────────────────────── 剧本格式（§6.2） ─────────────────────────

export const ScriptStep = z.strictObject({
  expect: z.optional(
    z.strictObject({
      lastUserIncludes: z.optional(z.array(z.string())),
      toolIncludes: z.optional(z.array(z.string())),
      imageBlocks: z.optional(z.int().min(0)),
    }),
  ),
  reply: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('message'),
      content: z.nullable(z.string()),
      toolCalls: z.optional(z.array(z.strictObject({ name: z.string(), arguments: z.unknown() })).min(1)),
      finishReason: z.optional(FinishReason),
      rawArguments: z.optional(z.string()),
    }),
    z.strictObject({ kind: z.literal('http-error'), status: z.int(), times: z.int().min(1) }),
    z.strictObject({ kind: z.literal('drop'), afterBytes: z.int().min(0) }),
    z.strictObject({ kind: z.literal('stall'), afterBytes: z.int().min(0) }),
  ]),
  usage: z.optional(z.strictObject({ completion: z.int().min(0), hitRatio: z.number().min(0).max(1) })),
});
export type ScriptStep = z.infer<typeof ScriptStep>;

export const ScriptSchema = z.strictObject({ name: z.string(), task: z.string(), steps: z.array(ScriptStep).min(1) });
export type Script = z.infer<typeof ScriptSchema>;

/** 剧本 expect 不满足；message 里写出期望与实际。 */
export class MockExpectationFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockExpectationFailed';
  }
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** `call_<两位 index>_<24 位 base62>`，24 位取 sha256(剧本名 + 步号 + index) 的 base62 前 24 位（§6.1）。 */
export function scriptedCallId(scriptName: string, step: number, index: number): string {
  let n = BigInt(
    `0x${createHash('sha256')
      .update(`${scriptName}${String(step)}${String(index)}`)
      .digest('hex')}`,
  );
  let digits = '';
  while (n > 0n) {
    digits = (BASE62[Number(n % 62n)] ?? '0') + digits;
    n /= 62n;
  }
  return `call_${String(index).padStart(2, '0')}_${digits.padStart(24, '0').slice(0, 24)}`;
}

// ───────────────────────── 剧本 fetch（§6.2） ─────────────────────────

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content === null) return '';
  return message.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

function imageCount(message: Message | undefined): number {
  if (message?.role !== 'user' || typeof message.content === 'string') return 0;
  return message.content.filter((p) => p.type === 'image_url').length;
}

function checkExpect(step: ScriptStep, stepNo: number, req: ChatRequest): void {
  const expect = step.expect;
  if (expect === undefined) return;
  const messages = req.messages;
  const lastUser = messages.findLast((m) => m.role === 'user');
  const lastAssistant = messages.findLastIndex((m) => m.role === 'assistant');
  const problems: string[] = [];
  const userText = lastUser === undefined ? '' : textOf(lastUser);
  for (const s of expect.lastUserIncludes ?? []) {
    if (!userText.includes(s))
      problems.push(`末尾 user 消息应包含 ${JSON.stringify(s)}，实际开头：${JSON.stringify(userText.slice(0, 200))}`);
  }
  const tools = messages
    .slice(lastAssistant + 1)
    .filter((m) => m.role === 'tool')
    .map(textOf);
  for (const s of expect.toolIncludes ?? []) {
    if (!tools.some((t) => t.includes(s)))
      problems.push(`上一轮 tool 消息（${String(tools.length)} 条）都不包含 ${JSON.stringify(s)}`);
  }
  if (expect.imageBlocks !== undefined && imageCount(lastUser) !== expect.imageBlocks) {
    problems.push(`末尾 user 消息应有 ${String(expect.imageBlocks)} 个图片块，实际 ${String(imageCount(lastUser))}`);
  }
  if (problems.length > 0)
    throw new MockExpectationFailed(`剧本第 ${String(stepNo)} 步 expect 不满足：${problems.join('；')}`);
}

/** A7：usage 由请求算出；completion 压到 max_tokens，压过时 finish_reason 改为 length。 */
function scriptedUsage(
  req: ChatRequest,
  replyJson: string,
  usage: ScriptStep['usage'],
): { usage: Usage; clamped: boolean } {
  let imageBytes = 0;
  let images = 0;
  for (const m of req.messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const p of m.content) {
      if (p.type !== 'image_url') continue;
      images += 1;
      imageBytes += encoder.encode(p.image_url.url).length;
    }
  }
  const textBytes = encoder.encode(serializeRequest(req)).length - imageBytes;
  const prompt = Math.ceil(textBytes / 3) + 1024 * images;
  const hit = Math.round(prompt * (usage?.hitRatio ?? 0.95));
  const wanted = usage?.completion ?? Math.ceil(encoder.encode(replyJson).length / 3);
  const completion = Math.min(wanted, req.max_tokens ?? Number.MAX_SAFE_INTEGER);
  return {
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: prompt - hit,
    },
    clamped: req.max_tokens !== undefined && wanted > req.max_tokens,
  };
}

function scriptedResponse(script: Script, stepNo: number, step: ScriptStep, req: ChatRequest): ChatResponse {
  const reply = step.reply;
  if (reply.kind !== 'message') throw new Error('内部错误：scriptedResponse 只处理 message 回复');
  const toolCalls = (reply.toolCalls ?? []).map((call, index) => ({
    id: scriptedCallId(script.name, stepNo, index),
    type: 'function' as const,
    function: {
      name: call.name,
      // rawArguments 只作用于第一个调用（测截断）；其余照常序列化
      arguments: index === 0 && reply.rawArguments !== undefined ? reply.rawArguments : JSON.stringify(call.arguments),
    },
  }));
  const message: AssistantMessage = {
    role: 'assistant',
    content: reply.content,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  const { usage, clamped } = scriptedUsage(req, JSON.stringify(message), step.usage);
  const finishReason = clamped ? 'length' : (reply.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'));
  // rawArguments 字段让 encodeSse 发出原文；拼装端会再判一次是否合法 JSON
  return {
    id: `mock-${script.name}-${String(stepNo)}`,
    model: req.model,
    systemFingerprint: 'fp_mock',
    message,
    rawArguments: [],
    finishReason,
    usage,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: null, totalMs: 0 },
  };
}

/**
 * 剧本 fetch：每次请求先用 ChatRequest 解析（失败回 400），再核对 expect，按步骤回复。
 * http-error 连续 times 次占用同一步；剧本走完仍有请求抛 MockExhausted。
 */
export function createScriptedFetch(script: Script, seed: number): typeof fetch {
  const parsedScript = ScriptSchema.parse(script);
  let stepIndex = 0;
  let httpErrorsUsed = 0;

  const plan = (body: string): Plan => {
    const parsed = ChatRequest.safeParse(JSON.parse(body));
    if (!parsed.success) return { kind: 'status', status: 400 };
    const step = parsedScript.steps[stepIndex];
    if (step === undefined) {
      throw new MockExhausted(`剧本 ${parsedScript.name} 的 ${String(parsedScript.steps.length)} 步已用完，仍收到请求`);
    }
    const stepNo = stepIndex + 1;
    checkExpect(step, stepNo, parsed.data);
    const rng = rngFor(seed, stepIndex);
    const reply = step.reply;
    if (reply.kind === 'http-error') {
      httpErrorsUsed += 1;
      if (httpErrorsUsed >= reply.times) {
        stepIndex += 1;
        httpErrorsUsed = 0;
      }
      return { kind: 'status', status: reply.status };
    }
    stepIndex += 1;
    switch (reply.kind) {
      case 'message':
        return {
          kind: 'stream',
          chunks: encodeSse(scriptedResponse(parsedScript, stepNo, step, parsed.data), rng),
          end: { kind: 'close' },
        };
      case 'drop':
        return { kind: 'stream', chunks: takeBytes(placeholderChunks(rng), reply.afterBytes), end: { kind: 'close' } };
      case 'stall':
        return { kind: 'stream', chunks: takeBytes(placeholderChunks(rng), reply.afterBytes), end: { kind: 'hang' } };
    }
  };

  return planFetch(plan);
}
