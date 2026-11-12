/**
 * 历史压缩（W11-08）：保留最近 8 轮原文，把更早轮次压成按类型的确定性 digest。
 *
 * **当前请求路径不启用（W11-18）。** `compactHistory` 的 cutoff 随轮次滑动，digest 文本每轮
 *   都会变化，prompt cache 会在 digest 处断开（v2 smoke 中 LCP 从 25 条跌到 3 条、cache hit
 *   冻结在 18,944）。v2 现在保留完整历史；本模块保留给未来长 run 的显式 opt-in。
 *   若重新接线，必须先改成固定 checkpoint（压缩后的旧消息此后冻结、digest 不再滑动），
 *   并通过相邻请求 LCP ≥90% 的回归测试。
 *
 * 负责：从完整消息流中切出“稳定前缀 + 轮次”；旧轮只保留 check / probe / view / 写稿摘要，
 *   最近一次 check 与最近一次 view 所在轮次额外钉住原文，避免最近证据被压掉。
 * 不负责：请求发送、计费、图片裁剪（runner / tools/view-retention 负责）。
 * 不变量：system、首条 task / BuildSheet 等首条 assistant 之前的消息永不压缩；
 *   被保留的 assistant.tool_calls 与其 tool 结果保持同轮、同序；被删轮次的 tool 结果不会留下孤儿。
 */

import type { Message, ToolCall } from '@pg/llm/schema';

/** 设计 §4.3：最近 6–8 轮原文；取上限 8。 */
export const HISTORY_KEEP_TURNS = 8;

export interface CompactHistoryOptions {
  readonly keepTurns?: number;
}

function oneLine(text: string, max = 140): string {
  const clean = text.replace(/\s*\n\s*/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function firstLine(text: string, max = 140): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return oneLine(line, max);
}

function toolResultTexts(turn: readonly Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of turn) {
    if (message.role === 'tool') map.set(message.tool_call_id, message.content);
  }
  return map;
}

function toolCalls(turn: readonly Message[]): readonly ToolCall[] {
  const assistant = turn.find((message) => message.role === 'assistant');
  return assistant?.role === 'assistant' ? (assistant.tool_calls ?? []) : [];
}

function turnHasCheck(turn: readonly Message[]): boolean {
  const names = new Set(toolCalls(turn).map((call) => call.function.name));
  if (names.has('check_code')) return true;
  // edit_code 内置自动检查；结果里有该标记时也算一次 check 周期。
  return [...toolResultTexts(turn).values()].some((text) => text.includes('自动检查（edit_code 后）'));
}

function turnHasView(turn: readonly Message[]): boolean {
  return toolCalls(turn).some((call) => call.function.name === 'view_building');
}

/** check 结果压成 3 行：outcome / blocking / 关键差异；不贴完整报告。 */
function checkDigest(text: string): string[] {
  const marker = '自动检查（edit_code 后）：';
  const at = text.lastIndexOf(marker);
  const body = at < 0 ? text : text.slice(at + marker.length);
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const outcome =
    lines.find((line) => /(执行成功|预检未通过|执行出错|执行未完成|执行超时|执行崩溃|执行结果|没有代码)/.test(line)) ??
    lines[0] ??
    'unknown';
  const blocking = /blocking (\d+)/.exec(body)?.[1] ?? 'unknown';
  const key = lines
    .filter((line) =>
      /^(?:FAIL|MISSING|UNVERIFIED)|blocking \d+|执行出错|预检未通过|类型预检|未验证 \/ 未关闭/.test(line),
    )
    .slice(0, 2)
    .map((line) => oneLine(line, 100));
  return [
    `check: ${oneLine(outcome, 160)}`,
    `  blocking=${blocking}`,
    ...(key.length === 0 ? [] : [`  key=${key.join(' | ')}`]),
  ];
}

function toolDigest(call: ToolCall, result: string): string[] {
  const name = call.function.name;
  if (name === 'check_code') return checkDigest(result);
  if (name === 'edit_code') {
    const marker = '自动检查（edit_code 后）：';
    const at = result.lastIndexOf(marker);
    const editPart = at < 0 ? result : result.slice(0, at);
    return [`edit: ${firstLine(editPart, 120)}`, ...(at < 0 ? [] : checkDigest(result))];
  }
  if (name === 'probe') return [`probe: ${firstLine(result, 140)}`];
  if (name === 'view_building') return ['view: 旧图已省略'];
  if (name === 'write_code') return [`write: ${firstLine(result, 120)}`];
  return [`${name}: ${firstLine(result, 120)}`];
}

function turnDigest(turnNo: number, turn: readonly Message[]): string[] {
  const lines = [`第 ${String(turnNo)} 轮`];
  for (const message of turn) {
    if (message.role !== 'assistant') continue;
    const content = message.content?.trim() ?? '';
    if (content !== '') lines.push(`  assistant: ${firstLine(content, 100)}`);
  }
  const results = toolResultTexts(turn);
  for (const call of toolCalls(turn)) {
    const result = results.get(call.id);
    if (result === undefined) continue;
    lines.push(...toolDigest(call, result).map((line) => `  ${line}`));
  }
  return lines.length === 1 ? [] : lines;
}

interface Split {
  readonly prefix: readonly Message[];
  readonly turns: readonly (readonly Message[])[];
}

/** 以 assistant 为轮次边界切分；前缀（system / task / BuildSheet）不含 assistant。 */
function splitHistory(messages: readonly Message[]): Split {
  const first = messages.findIndex((message) => message.role === 'assistant');
  if (first < 0) return { prefix: messages, turns: [] };
  const prefix = messages.slice(0, first);
  const turns: Message[][] = [];
  let at = first;
  while (at < messages.length) {
    const next = messages.findIndex((message, index) => index > at && message.role === 'assistant');
    const end = next < 0 ? messages.length : next;
    turns.push(messages.slice(at, end));
    at = end;
  }
  return { prefix, turns };
}

/**
 * 压缩历史；轮次数 ≤ keepTurns 时原样返回（不改变请求形状）。
 * 旧轮按“摘要 user 消息 + 被钉住的最近 check / view 原文 + 最近 8 轮原文”重排；
 * 所有 tool 结果只随其 assistant 轮次一起保留或删除。
 */
export function compactHistory(messages: readonly Message[], options: CompactHistoryOptions = {}): readonly Message[] {
  const keep = options.keepTurns ?? HISTORY_KEEP_TURNS;
  const { prefix, turns } = splitHistory(messages);
  if (turns.length <= keep) return messages;
  const cutoff = turns.length - keep;
  const pinned = new Set<number>();
  for (let i = cutoff - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn !== undefined && turnHasCheck(turn)) {
      pinned.add(i);
      break;
    }
  }
  for (let i = cutoff - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn !== undefined && turnHasView(turn)) {
      pinned.add(i);
      break;
    }
  }

  const digest: string[] = [];
  for (let i = 0; i < cutoff; i += 1) {
    const turn = turns[i];
    if (turn === undefined || pinned.has(i)) continue;
    digest.push(...turnDigest(i + 1, turn));
  }
  const label =
    cutoff === 1
      ? `[历史摘要 · 第 1 轮；旧轮已压缩，最近 ${String(keep)} 轮及最近 check/view 保留原文]`
      : `[历史摘要 · 第 1–${String(cutoff)} 轮；旧轮已压缩，最近 ${String(keep)} 轮及最近 check/view 保留原文]`;
  const out: Message[] = [...prefix];
  if (digest.length > 0) out.push({ role: 'user', content: `${label}\n${digest.join('\n')}` });
  for (let i = 0; i < cutoff; i += 1) {
    const turn = turns[i];
    if (turn !== undefined && pinned.has(i)) out.push(...turn);
  }
  for (const turn of turns.slice(cutoff)) out.push(...turn);
  return out;
}
