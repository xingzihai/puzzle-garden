/**
 * JSON-only content 模式：正文解析、请求构造与失败诊断。
 *
 * 负责：严格解析正文 JSON（纯 JSON / 单个 fence）、tools: [] + response_format 请求、repair 请求转换、
 *   finishReason / usage / rawArguments / content / reasoning 诊断。
 * 不负责：网络、schema 校验与 patch 应用（generate.ts）；本文件是纯函数。
 */
import { ChatRequest } from '@pg/llm/schema';
import type { ChatResponse, ToolDef } from '@pg/llm/schema';

import { GenerationError } from './generate.ts';
import type { GenerateOptions, GenerationDiagnostics, SubmissionOutputMode } from './generate.ts';

/** 需求 / 通用输出上限；小型方案的完整 DesignScheme 通常明显低于此值。 */
export const DEFAULT_MAX_TOKENS = 16_384;

export type ContentJsonSource = 'pure' | 'fenced' | 'embedded';

/** 模型把 response_format 当成输出字段回显时的两个明确形态；其他未知字段仍交给 schema 拒绝。 */
export type ResponseFormatEchoField = 'type' | 'response_format';

export interface ResponseFormatEcho {
  readonly field: ResponseFormatEchoField;
  readonly value: unknown;
}

export interface ContentJsonCandidate {
  readonly value: Record<string, unknown>;
  readonly source: ContentJsonSource;
  /** 已从顶层剥离的 response_format 回显；由调用方记录 normalization warning。 */
  readonly echoes?: readonly ResponseFormatEcho[];
}

export interface ContentJsonOptions {
  /** 兼容旧 tool arguments 为空时的回退：允许正文前后有少量说明并提取唯一 JSON。content 模式保持 false。 */
  readonly allowEmbedded?: boolean;
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return jsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isResponseFormatEcho(value: unknown): boolean {
  if (value === 'json_object') return true;
  return jsonObject(value) && Object.keys(value).length === 1 && value['type'] === 'json_object';
}

/**
 * 只剥离模型对 response_format 的明确回显：顶层 `"type":"json_object"` 或
 * `"response_format":{"type":"json_object"}` / `"response_format":"json_object"`。
 * `type` 为其他值、或仍有其他未知字段时原样保留，让 strict schema 继续失败。
 */
export function stripResponseFormatEcho(value: Record<string, unknown>): {
  readonly value: Record<string, unknown>;
  readonly echoes: readonly ResponseFormatEcho[];
} {
  let result = value;
  const echoes: ResponseFormatEcho[] = [];
  if (Object.hasOwn(result, 'type') && result['type'] === 'json_object') {
    const { type, ...rest } = result;
    result = rest;
    echoes.push({ field: 'type', value: type });
  }
  if (Object.hasOwn(result, 'response_format') && isResponseFormatEcho(result['response_format'])) {
    const { response_format, ...rest } = result;
    result = rest;
    echoes.push({ field: 'response_format', value: response_format });
  }
  return { value: result, echoes };
}

function candidate(value: Record<string, unknown>, source: ContentJsonSource): ContentJsonCandidate {
  const stripped = stripResponseFormatEcho(value);
  return {
    value: stripped.value,
    source,
    ...(stripped.echoes.length === 0 ? {} : { echoes: stripped.echoes }),
  };
}

/** 在正文里找唯一的完整顶层 JSON 对象；多个、截断或散文不猜。仅用于旧回退路径。 */
function embeddedJsonObject(text: string): ContentJsonCandidate | null {
  const ranges: { readonly start: number; readonly end: number }[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        ranges.push({ start, end: index + 1 });
        start = -1;
      }
    }
  }
  if (ranges.length !== 1) return null;
  const range = ranges[0];
  if (range === undefined) return null;
  const outside = `${text.slice(0, range.start)}${text.slice(range.end)}`.trim();
  if (outside.length > 500 || /[{}]/.test(outside)) return null;
  const value = parseObject(text.slice(range.start, range.end));
  return value === null ? null : { value, source: 'embedded' };
}

/**
 * 严格解析 JSON-only 正文：只接受纯 JSON 或单个 ```json fence；默认拒绝 fence 外的任何散文、
 * 多个 JSON 与截断 JSON。`allowEmbedded` 只供旧的 tool arguments 为空回退使用。
 */
export function extractContentJson(content: string, options: ContentJsonOptions = {}): ContentJsonCandidate | null {
  const trimmed = content.trim();
  if (trimmed === '') return null;
  const pure = parseObject(trimmed);
  if (pure !== null) return candidate(pure, 'pure');

  const fenced = [...trimmed.matchAll(/```json[ \t]*\r?\n?([\s\S]*?)\r?\n?```/gi)];
  const plainFenced = [...trimmed.matchAll(/```[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
  const blocks = fenced.length > 0 ? fenced : plainFenced;
  if (blocks.length > 0) {
    if (blocks.length !== 1) return null;
    const block = blocks[0];
    if (block === undefined) return null;
    const inner = block[1]?.trim() ?? '';
    const value = parseObject(inner);
    if (value === null) return null;
    const outside = trimmed.replace(block[0], '').trim();
    if (outside.length > 500 || /[{}]/.test(outside)) return null;
    if (options.allowEmbedded !== true && outside !== '') return null;
    return candidate(value, 'fenced');
  }

  if (options.allowEmbedded !== true) return null;
  const embedded = embeddedJsonObject(trimmed);
  return embedded === null ? null : candidate(embedded.value, 'embedded');
}

/** 实际发出的思考配置；用于失败诊断，不参与请求构造。 */
export function thinkingDiagnostic(request: ChatRequest): string {
  if (request.thinking !== undefined) return `thinking:${request.thinking.type}`;
  if (request.reasoning_effort !== undefined) return `reasoning_effort:${request.reasoning_effort}`;
  return 'thinking:unspecified';
}

/**
 * 失败诊断：保留 finishReason / usage / rawArguments / content / reasoning_content。
 * 只挂在 GenerationError 上，不写入方案或会话 artifacts。
 */
export function responseDiagnostics(
  response: ChatResponse,
  request: ChatRequest,
  outputMode: SubmissionOutputMode,
): GenerationDiagnostics {
  const content = response.message.content ?? '';
  const reasoningContent = response.message.reasoning_content ?? '';
  return {
    finishReason: response.finishReason,
    promptTokens: response.usage.prompt_tokens,
    completionTokens: response.usage.completion_tokens,
    totalTokens: response.usage.total_tokens,
    ...(response.usage.prompt_cache_hit_tokens === undefined
      ? {}
      : { promptCacheHitTokens: response.usage.prompt_cache_hit_tokens }),
    ...(response.usage.prompt_cache_miss_tokens === undefined
      ? {}
      : { promptCacheMissTokens: response.usage.prompt_cache_miss_tokens }),
    ...(response.usage.completion_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: response.usage.completion_tokens_details.reasoning_tokens }),
    usage: response.usage,
    outputMode,
    thinking: thinkingDiagnostic(request),
    argumentChars: (response.message.tool_calls ?? []).reduce(
      (total, call) => total + call.function.arguments.length,
      0,
    ),
    argumentTruncated: response.finishReason === 'length',
    contentChars: content.length,
    contentTruncated: response.finishReason === 'length',
    reasoningChars: reasoningContent.length,
    reasoningPresent: reasoningContent !== '',
    rawArguments: response.rawArguments.map((item) => ({ index: item.index, text: item.text })),
    content,
    reasoningContent,
  };
}

function assertMaxTokens(maxTokens: number): number {
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 393_216) {
    throw new GenerationError('invalid-options', `maxTokens 应为 1–393216 的整数，实际是 ${String(maxTokens)}`);
  }
  return maxTokens;
}

function requestBase(
  system: string,
  user: string,
  options: GenerateOptions,
): Omit<ChatRequest, 'tools' | 'response_format'> {
  const maxTokens = assertMaxTokens(options.maxTokens ?? DEFAULT_MAX_TOKENS);
  return {
    model: options.model ?? 'deepseek-flash',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // interaction 默认开启 provider 当前允许的最高思考档；DeepSeek 只有 enabled/disabled。
    thinking: { type: options.thinking === 'disabled' ? 'disabled' : 'enabled' },
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
}

export function requestFor(system: string, user: string, tool: ToolDef, options: GenerateOptions): ChatRequest {
  return ChatRequest.parse({ ...requestBase(system, user, options), tools: [tool] });
}

/** JSON-only content 模式：不提供工具，要求模型把单个 JSON 对象写进正文。 */
export function requestForContentJson(system: string, user: string, options: GenerateOptions): ChatRequest {
  return ChatRequest.parse({
    ...requestBase(system, user, options),
    tools: [],
    response_format: { type: 'json_object' },
  });
}

/** 先按 finish_reason 分类；tool 与 content 两种提交路径共用。 */
export function assertUsableFinishReason(response: ChatResponse, toolName: string): void {
  switch (response.finishReason) {
    case 'length':
      throw new GenerationError('truncated', `模型输出被截断（finish_reason=length），不能提交 ${toolName}。`);
    case 'content_filter':
      throw new GenerationError(
        'model-refusal',
        `模型拒绝生成（finish_reason=content_filter），不能提交 ${toolName}。`,
      );
    case 'insufficient_system_resource':
    case 'aborted':
      throw new GenerationError(
        'truncated',
        `模型生成被中断（finish_reason=${response.finishReason}），不能提交 ${toolName}。`,
      );
    case 'stop':
    case 'tool_calls':
      break;
  }
}

export function contentSnippet(response: ChatResponse): string {
  const content = response.message.content?.trim() ?? '';
  if (content === '') return '正文为空';
  return content.length <= 300 ? content : `${content.slice(0, 300)}…`;
}

/** JSON-only content 模式：只接受正文中的单个完整 JSON 对象，不读 tool_calls。 */
export function contentJsonArguments(
  response: ChatResponse,
  label: string,
  onEcho?: (echo: ResponseFormatEcho) => void,
): unknown {
  assertUsableFinishReason(response, label);
  const content = response.message.content;
  if (content === null || content.trim() === '') {
    throw new GenerationError('no-content-json', `模型正文为空，没有可提交的 ${label} JSON 对象。`);
  }
  const candidate = extractContentJson(content);
  if (candidate === null) {
    throw new GenerationError(
      'invalid-json',
      `${label} 正文不是单个完整 JSON 对象（只允许纯 JSON 或 \`\`\`json fence；拒绝散文、多 JSON、截断）：${contentSnippet(response)}`,
    );
  }
  for (const echo of candidate.echoes ?? []) onEcho?.(echo);
  return candidate.value;
}

/** 取出唯一 submit tool_call 的原始参数；这里只做分类，不做 schema 校验。 */
export function toolCallArguments(response: ChatResponse, toolName: string): unknown {
  assertUsableFinishReason(response, toolName);

  const calls = response.message.tool_calls ?? [];
  if (calls.length === 0) {
    throw new GenerationError('no-tool-call', `模型没有调用 ${toolName}，而是返回正文：${contentSnippet(response)}`);
  }
  if (calls.length > 1) {
    throw new GenerationError(
      'multiple-tool-calls',
      `模型一次返回了 ${String(calls.length)} 个 tool_call；必须且只能提交一个 ${toolName}。`,
    );
  }
  const call = calls[0];
  if (call === undefined) throw new GenerationError('no-tool-call', `模型没有调用 ${toolName}。`);
  if (call.function.name !== toolName) {
    throw new GenerationError(
      'unexpected-tool',
      `模型调用了 ${call.function.name}，预期是 ${toolName}；不把其他工具的返回值当提交结果。`,
    );
  }

  try {
    return JSON.parse(call.function.arguments) as unknown;
  } catch (error) {
    const raw = call.function.arguments;
    const snippet = raw.length <= 500 ? raw : `${raw.slice(0, 500)}…`;
    throw new GenerationError(
      'invalid-json',
      `${toolName} 的 arguments 不是合法 JSON：${error instanceof Error ? error.message : String(error)}；原文：${snippet}`,
      error,
    );
  }
}

export function submissionArguments(
  response: ChatResponse,
  toolName: string,
  outputMode: SubmissionOutputMode,
  onEcho?: (echo: ResponseFormatEcho) => void,
): unknown {
  return outputMode === 'content-json'
    ? contentJsonArguments(response, toolName, onEcho)
    : toolCallArguments(response, toolName);
}

export function attachResponseDiagnostics(
  error: unknown,
  response: ChatResponse,
  request: ChatRequest,
  outputMode: SubmissionOutputMode,
): never {
  if (error instanceof GenerationError && error.diagnostics === null) {
    throw new GenerationError(
      error.code,
      error.message,
      error.cause,
      responseDiagnostics(response, request, outputMode),
      error.repairFailed,
    );
  }
  throw error;
}

/** JSON-only 模式的 repair 请求：沿用同一套 patch 提示，但去掉工具、要求只输出 JSON 正文。 */
export function contentJsonRepairRequest(request: ChatRequest): ChatRequest {
  if (request.tools.length === 0 && request.response_format?.type === 'json_object') return request;
  const messages = request.messages.map((message, index) => {
    if (index === 0 && message.role === 'system') {
      return {
        ...message,
        content: `${message.content}\n\n【JSON-only content 模式】本次不要调用工具；只在正文输出一个 JSON 对象，形如 {"patches":[...]}。只输出 patch JSON 本体，不要包含 type / response_format / 工具包装 / 说明文字；不要输出多个 JSON。`,
      };
    }
    if (index === request.messages.length - 1 && message.role === 'user' && typeof message.content === 'string') {
      return {
        ...message,
        content: `${message.content}\n\n【JSON-only 输出】不要调用工具；只输出一个 {"patches":[...]} JSON 对象本体，不要包含 type / response_format / 工具包装 / 说明文字。`,
      };
    }
    return message;
  });
  return ChatRequest.parse({
    ...request,
    messages,
    tools: [],
    response_format: { type: 'json_object' },
  });
}
