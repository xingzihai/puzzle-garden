/**
 * SSE 字节生成器（MODEL-SPEC §6.1）：把一个完整响应或部分响应编成真实形状的 SSE 字节块。
 *
 * 负责：首块带 role、第 2 块前插 `: keep-alive`、content / arguments 按 rng 切成增量、末块同时带 finish_reason 与 usage
 *   再 `data: [DONE]`；网络字节块再按 rng 切开，且至少一处切在 UTF-8 多字节字符中间（优先 arguments 里）。
 * 不负责：tool_call id 的合成（需要 sha256，由 mock.ts 做后写进 response）、HTTP 状态与断流（mock.ts）。
 * 本文件是纯函数：随机只来自传入的 rng；同一 rng 种子得到同一字节序列。
 *
 * 往返性质：对任意 ChatResponse r，用 sse.ts 拼装 encodeSse(r) 得到的 message / usage / finishReason / rawArguments
 * 与 r 相同（timing 除外）。所以 rawArguments 里的原文会替换回对应 tool_call 发出去，content 为 null 时首块也发 null。
 */

import { randomInt } from '@pg/core/rng';

import type { ChatResponse, PartialResponse } from './schema.ts';

export interface EncodeSseOptions {
  /** 行尾用 `\r\n\r\n`（测 CRLF 兼容）。缺省 `\n\n`。 */
  readonly crlf?: boolean;
  /** 多个 tool_call 的参数片段按 rng 交错发出（测按 index 归并）。缺省按顺序。 */
  readonly interleave?: boolean;
  /**
   * content / reasoning / 每个 tool_call 的参数各作为一个增量整段发出（不切成 1–40 字节）；网络字节块照常切。
   * 回放退化取消用：原 run 的检测器在最后一个增量处触发，整段发出时检测器看到的累计文本与触发时相同。
   */
  readonly wholeDeltas?: boolean;
  /** 部分响应没有 id / model，用这里的值；完整响应忽略。 */
  readonly id?: string;
  readonly model?: string;
  /** 部分响应的 tool_call id（部分响应不记录 id）。缺省 `call_<两位 index>_` + 24 个 0。 */
  readonly callId?: (index: number) => string;
}

/** content / arguments 每个增量的字节数范围（§6.1）。 */
const PIECE_MIN = 1;
const PIECE_MAX = 40;
/** 网络字节块大小范围。 */
const WIRE_MIN = 1;
const WIRE_MAX = 64;

interface Segment {
  readonly text: string;
  readonly kind: 'frame' | 'content' | 'arguments';
}

interface WireCall {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly args: string;
}

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** 按码点切成 1–40 字节的片段；单个码点超过目标长度时独占一片。 */
function splitText(text: string, rng: () => number, whole = false): string[] {
  if (whole) return text === '' ? [] : [text];
  const pieces: string[] = [];
  let current = '';
  let currentBytes = 0;
  let target = randomInt(rng, PIECE_MIN, PIECE_MAX);
  for (const ch of text) {
    const bytes = utf8Length(ch);
    if (current !== '' && currentBytes + bytes > target) {
      pieces.push(current);
      current = '';
      currentBytes = 0;
      target = randomInt(rng, PIECE_MIN, PIECE_MAX);
    }
    current += ch;
    currentBytes += bytes;
  }
  if (current !== '') pieces.push(current);
  return pieces;
}

function defaultCallId(index: number): string {
  return `call_${String(index).padStart(2, '0')}_${'0'.repeat(24)}`;
}

function isComplete(response: ChatResponse | PartialResponse): response is ChatResponse {
  return 'message' in response;
}

/** 完整响应的 tool_call：被替换成 "{}" 的参数用 rawArguments 里的原文发出，保证往返一致。 */
function callsOf(response: ChatResponse | PartialResponse, options: EncodeSseOptions): WireCall[] {
  if (!isComplete(response)) {
    const callId = options.callId ?? defaultCallId;
    return response.arguments.map((a) => ({ index: a.index, id: callId(a.index), name: a.name ?? '', args: a.text }));
  }
  const raw = new Map(response.rawArguments.map((r) => [r.index, r.text]));
  return (response.message.tool_calls ?? []).map((call, index) => ({
    index,
    id: call.id,
    name: call.function.name,
    args: raw.get(index) ?? call.function.arguments,
  }));
}

/** 把 tool_call 参数片段排成发送顺序；交错时每步按 rng 选一个还有剩余片段的调用。 */
function orderCallFragments(
  calls: readonly WireCall[],
  rng: () => number,
  interleave: boolean,
  whole: boolean,
): { call: WireCall; piece: string | null }[] {
  const queues = calls.map((call) => ({ call, pieces: splitText(call.args, rng, whole), started: false }));
  const out: { call: WireCall; piece: string | null }[] = [];
  const emit = (q: (typeof queues)[number]): void => {
    if (!q.started) {
      q.started = true;
      out.push({ call: q.call, piece: null }); // 首块：id、type、name、空 arguments
      return;
    }
    const piece = q.pieces.shift();
    if (piece !== undefined) out.push({ call: q.call, piece });
  };
  const remaining = (q: (typeof queues)[number]): boolean => !q.started || q.pieces.length > 0;
  if (!interleave) {
    for (const q of queues) while (remaining(q)) emit(q);
    return out;
  }
  for (;;) {
    const open = queues.filter(remaining);
    if (open.length === 0) return out;
    const pick = open[randomInt(rng, 0, open.length - 1)];
    if (pick !== undefined) emit(pick);
  }
}

function buildSegments(
  response: ChatResponse | PartialResponse,
  rng: () => number,
  options: EncodeSseOptions,
): Segment[] {
  const eol = options.crlf === true ? '\r\n' : '\n';
  const complete = isComplete(response);
  const whole = options.wholeDeltas === true;
  const base: Record<string, unknown> = {
    id: complete ? response.id : (options.id ?? 'mock-partial'),
    object: 'chat.completion.chunk',
    created: 0,
    model: complete ? response.model : (options.model ?? 'deepseek-flash'),
  };
  if (complete && response.systemFingerprint !== null) base['system_fingerprint'] = response.systemFingerprint;

  const frame = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}, finish: string | null = null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}${eol}${eol}`;

  const content = complete ? response.message.content : response.content;
  const reasoning = complete ? (response.message.reasoning_content ?? '') : response.reasoning;

  // 首块：content 为 null 时也发 null，否则拼装端会把 null 还原成 ""。
  const segments: Segment[] = [
    { text: frame({ role: 'assistant', content: content === null ? null : '' }), kind: 'frame' },
    { text: `: keep-alive${eol}${eol}`, kind: 'frame' },
  ];
  for (const piece of splitText(reasoning, rng, whole)) {
    segments.push({ text: frame({ reasoning_content: piece }), kind: 'frame' });
  }
  for (const piece of splitText(content ?? '', rng, whole)) {
    segments.push({ text: frame({ content: piece }), kind: 'content' });
  }
  for (const { call, piece } of orderCallFragments(
    callsOf(response, options),
    rng,
    options.interleave === true,
    whole,
  )) {
    const toolDelta =
      piece === null
        ? { index: call.index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }
        : { index: call.index, function: { arguments: piece } };
    segments.push({ text: frame({ tool_calls: [toolDelta] }), kind: piece === null ? 'frame' : 'arguments' });
  }
  if (complete) {
    segments.push({ text: frame({}, { usage: response.usage }, response.finishReason), kind: 'frame' });
    segments.push({ text: `data: [DONE]${eol}${eol}`, kind: 'frame' });
  }
  return segments;
}

/** 找一个必须切开的位置：优先 arguments 段里第一个多字节字符的首字节之后，其次 content 段。 */
function forcedCut(segments: readonly { kind: Segment['kind']; start: number; bytes: Uint8Array }[]): number | null {
  for (const kind of ['arguments', 'content'] as const) {
    for (const seg of segments) {
      if (seg.kind !== kind) continue;
      const lead = seg.bytes.findIndex((b) => b >= 0xc0);
      if (lead !== -1) return seg.start + lead + 1;
    }
  }
  return null;
}

/**
 * 把响应编成 SSE 字节块。完整响应以 finish_reason + usage 末块与 `data: [DONE]` 结束；
 * 部分响应（取消时记录的 PartialResponse）只发已有内容，不发末块与 [DONE]，由调用方决定断流或挂起。
 */
export function encodeSse(
  response: ChatResponse | PartialResponse,
  rng: () => number,
  options: EncodeSseOptions = {},
): Uint8Array[] {
  let offset = 0;
  const encoded = buildSegments(response, rng, options).map((seg) => {
    const bytes = encoder.encode(seg.text);
    const out = { kind: seg.kind, start: offset, bytes };
    offset += bytes.length;
    return out;
  });
  const all = new Uint8Array(offset);
  for (const seg of encoded) all.set(seg.bytes, seg.start);

  const cuts = new Set<number>();
  for (let pos = randomInt(rng, WIRE_MIN, WIRE_MAX); pos < all.length; pos += randomInt(rng, WIRE_MIN, WIRE_MAX)) {
    cuts.add(pos);
  }
  const forced = forcedCut(encoded);
  if (forced !== null) cuts.add(forced);

  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    chunks.push(all.slice(start, cut));
    start = cut;
  }
  if (start < all.length) chunks.push(all.slice(start));
  return chunks;
}
