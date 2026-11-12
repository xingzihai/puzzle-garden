/**
 * @pg/llm 的请求、响应与失败 schema（MODEL-SPEC §3、§5.2）。
 *
 * 负责：定义请求、流块、usage、完整响应与 LlmFailure 的形状；提供逐字节确定的请求序列化。
 * 不负责：发请求与超时重试（client.ts）、字节流拼装（sse.ts）、计费（cost.ts）。
 * 本文件是纯函数：不做 I/O，不读全局可变状态。
 */

import { z } from 'zod';

export const TextPart = z.strictObject({ type: z.literal('text'), text: z.string() });
export type TextPart = z.infer<typeof TextPart>;

export const ImagePart = z.strictObject({
  type: z.literal('image_url'),
  image_url: z.strictObject({ url: z.string().startsWith('data:image/png;base64,') }),
});
export type ImagePart = z.infer<typeof ImagePart>;

export const ToolCall = z.strictObject({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.strictObject({ name: z.string().regex(/^[a-z_]{1,64}$/), arguments: z.string() }),
});
export type ToolCall = z.infer<typeof ToolCall>;

const AssistantMessageSchema = z.strictObject({
  role: z.literal('assistant'),
  content: z.nullable(z.string()),
  // 只在思考模式下出现；开启思考时 runner 必须把它原样回传（MODEL-SPEC §3.1）。
  reasoning_content: z.optional(z.string()),
  tool_calls: z.optional(z.array(ToolCall).min(1)),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const Message = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('system'), content: z.string() }),
  z.strictObject({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(z.union([TextPart, ImagePart])).min(1)]),
  }),
  AssistantMessageSchema,
  z.strictObject({ role: z.literal('tool'), tool_call_id: z.string().min(1), content: z.string() }),
]);
export type Message = z.infer<typeof Message>;

/**
 * 工具参数 JSON Schema 不允许带 `$schema` 键：agent 用 `z.toJSONSchema()` 生成后要删掉（C19）。
 * 放在 schema 层拒绝，避免带 `$schema` 的请求体真的发出去。
 */
const toolParameters = z.record(z.string(), z.unknown()).refine((parameters) => !Object.hasOwn(parameters, '$schema'), {
  message: '工具参数 JSON Schema 不应包含 $schema 键：agent 生成后要删掉（C19）。',
});

export const ToolDef = z.strictObject({
  type: z.literal('function'),
  function: z.strictObject({
    name: z.string(),
    description: z.string(),
    parameters: toolParameters,
  }),
});
export type ToolDef = z.infer<typeof ToolDef>;

/** JSON-only 输出模式：模型把单个 JSON 对象写进正文，不要求 tool_call。 */
export const ResponseFormat = z.strictObject({ type: z.literal('json_object') });
export type ResponseFormat = z.infer<typeof ResponseFormat>;

function checkToolOutputMode(
  request: { readonly tools: readonly unknown[]; readonly response_format?: ResponseFormat | undefined },
  ctx: z.RefinementCtx,
): void {
  if (request.tools.length === 0 && request.response_format?.type !== 'json_object') {
    ctx.addIssue({
      code: 'custom',
      path: ['tools'],
      message: 'tools 为空只允许用于 JSON-only content 模式：必须同时声明 response_format: { type: "json_object" }',
    });
  }
}

const ChatRequestFields = z.strictObject({
  model: z.enum(['deepseek-flash', 'gpt-6.1-sol']), // GPT 仅用于 owner 特许对照（决策 #126）
  messages: z.array(Message).min(2),
  // 普通模式至少一个工具；JSON-only content 模式允许 tools: []，但仍须声明 response_format。
  tools: z.array(ToolDef).max(12), // DESIGN §3.5
  thinking: z.strictObject({ type: z.enum(['enabled', 'disabled']) }).optional(),
  max_tokens: z.int().min(1).max(393_216).optional(),
  reasoning_effort: z.enum(['none', 'low']).optional(), // none仅保留历史记录重建（#127）
  response_format: ResponseFormat.optional(),
  stream: z.literal(true),
  stream_options: z.strictObject({ include_usage: z.literal(true) }),
});

/** 请求清单参数（不含 messages）；store 的 request-codec 用它做 omit，避免对 refinement schema 调 `.omit()`。 */
export const ChatRequestParams = ChatRequestFields.omit({ messages: true }).superRefine(checkToolOutputMode);
export type ChatRequestParams = z.infer<typeof ChatRequestParams>;

export const ChatRequest = ChatRequestFields.superRefine(checkToolOutputMode);
export type ChatRequest = z.infer<typeof ChatRequest>;

export const FinishReason = z.enum([
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'insufficient_system_resource',
  'aborted',
]);
export type FinishReason = z.infer<typeof FinishReason>;

export const Usage = z.looseObject({
  prompt_tokens: z.int().min(0),
  completion_tokens: z.int().min(0),
  total_tokens: z.int().min(0),
  // 特许模型不保证提供缓存字段；缺失保留未知，不补成零。DeepSeek 计费另行严格验证。
  prompt_cache_hit_tokens: z.int().min(0).optional(),
  prompt_cache_miss_tokens: z.int().min(0).optional(),
  completion_tokens_details: z.optional(z.looseObject({ reasoning_tokens: z.optional(z.int().min(0)) })),
});
export type Usage = z.infer<typeof Usage>;

export const StreamChunk = z.looseObject({
  id: z.string(),
  model: z.string(),
  system_fingerprint: z.optional(z.string()),
  choices: z
    .array(
      z.looseObject({
        index: z.literal(0),
        delta: z.looseObject({
          role: z.optional(z.nullable(z.literal('assistant'))),
          content: z.optional(z.nullable(z.string())),
          reasoning_content: z.optional(z.nullable(z.string())),
          tool_calls: z.optional(
            z.array(
              z.looseObject({
                index: z.int().min(0),
                id: z.optional(z.string()),
                type: z.optional(z.literal('function')),
                function: z.optional(
                  z.looseObject({ name: z.optional(z.string()), arguments: z.optional(z.string()) }),
                ),
              }),
            ),
          ),
        }),
        finish_reason: z.nullable(FinishReason),
      }),
    )
    .max(1),
  usage: z.optional(z.nullable(Usage)),
});
export type StreamChunk = z.infer<typeof StreamChunk>;

export const LlmFailure = z.strictObject({
  class: z.enum(['transport', 'http', 'invalid-response', 'truncated', 'cancelled']),
  code: z.string(), // 'network' | 'timeout' | 'http_429' | 'no-usage' | …（MODEL-SPEC §5.2）
  status: z.nullable(z.int()),
  retriable: z.boolean(),
  message: z.string().max(400), // 已脱敏
});
export type LlmFailure = z.infer<typeof LlmFailure>;

/** 客户端发给 onDelta 的增量；tool_call 参数按片段给出（C10）。 */
export type Delta =
  | { readonly kind: 'content'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'arguments'; readonly index: number; readonly text: string };

/** 取消时交给调用方的已拼装内容（MODEL-SPEC §3.5）。 */
export interface PartialResponse {
  readonly content: string;
  readonly reasoning: string;
  readonly arguments: readonly { readonly index: number; readonly name: string | null; readonly text: string }[];
  readonly timing: { readonly firstByteMs: number | null; readonly totalMs: number };
}

export interface ChatResponse {
  readonly id: string;
  readonly model: string;
  readonly systemFingerprint: string | null;
  readonly message: AssistantMessage; // 已做 §3.3 的替换，可直接追加进 messages
  readonly rawArguments: readonly { readonly index: number; readonly text: string }[]; // 被替换掉的非法参数原文
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  readonly usageMismatch: boolean; // hit + miss ≠ prompt
  readonly timing: { readonly firstByteMs: number; readonly firstTokenMs: number | null; readonly totalMs: number };
}

/**
 * 把 JSON 值规范化：对象键按 UTF-16 码元升序排列，数组保持原序。
 * 请求体要「发送与还原共用」并逐字节相同（MODEL-SPEC §3.1、§7.4），而消息 blob 以规范 JSON 存放，
 * 所以序列化时不能依赖调用方对象里的键顺序；已知字段按 schema 声明顺序重建，自由对象（工具 parameters）走这里。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => canonicalize(item));
  if (typeof value === 'object' && value !== null) {
    // 已判定为 object；JSON 值只可能是普通对象/数组，读键是安全的。
    const record = value as Readonly<Record<string, unknown>>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

function serializePart(part: TextPart | ImagePart): unknown {
  if (part.type === 'text') return { type: part.type, text: part.text };
  return { type: part.type, image_url: { url: part.image_url.url } };
}

function serializeToolCall(call: ToolCall): unknown {
  return { id: call.id, type: call.type, function: { name: call.function.name, arguments: call.function.arguments } };
}

function serializeMessage(message: Message): unknown {
  switch (message.role) {
    case 'system':
      return { role: message.role, content: message.content };
    case 'user':
      return {
        role: message.role,
        content: typeof message.content === 'string' ? message.content : message.content.map(serializePart),
      };
    case 'assistant': {
      const out: Record<string, unknown> = { role: message.role, content: message.content };
      if (message.reasoning_content !== undefined) out['reasoning_content'] = message.reasoning_content;
      if (message.tool_calls !== undefined) out['tool_calls'] = message.tool_calls.map(serializeToolCall);
      return out;
    }
    case 'tool':
      return { role: message.role, tool_call_id: message.tool_call_id, content: message.content };
  }
}

function serializeToolDef(tool: ToolDef): unknown {
  return {
    type: tool.type,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: canonicalize(tool.function.parameters),
    },
  };
}

/** 按 `ChatRequest` 的 schema 声明顺序序列化，同一语义值得到同一字节串（发送与还原共用）。 */
export function serializeRequest(request: ChatRequest): string {
  if (request.model === 'deepseek-flash') {
    if (request.thinking === undefined || request.max_tokens === undefined || request.reasoning_effort !== undefined)
      throw new Error('DeepSeek 请求必须指定 thinking/max_tokens，不能使用特许模型参数。');
  } else if (
    (request.reasoning_effort !== 'none' && request.reasoning_effort !== 'low') ||
    request.thinking !== undefined ||
    request.max_tokens !== undefined
  ) {
    throw new Error('GPT 特许请求必须指定已授权思考档（low；none仅历史兼容），不发 thinking 或人为输出上限。');
  }
  if (request.tools.length === 0 && request.response_format?.type !== 'json_object') {
    throw new Error('tools 为空只允许 JSON-only content 模式，必须声明 response_format: { type: "json_object" }。');
  }
  return JSON.stringify({
    model: request.model,
    messages: request.messages.map(serializeMessage),
    tools: request.tools.map(serializeToolDef),
    ...(request.thinking === undefined ? {} : { thinking: { type: request.thinking.type } }),
    ...(request.max_tokens === undefined ? {} : { max_tokens: request.max_tokens }),
    ...(request.reasoning_effort === undefined ? {} : { reasoning_effort: request.reasoning_effort }),
    ...(request.response_format === undefined ? {} : { response_format: { type: request.response_format.type } }),
    stream: request.stream,
    stream_options: { include_usage: request.stream_options.include_usage },
  });
}
