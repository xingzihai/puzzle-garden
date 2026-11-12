/**
 * 网页 demo 的离线 mock ChatClient：用 exampleRequirements / exampleScheme 走真实生成、校验与对话流程。
 *
 * 负责：按 submit_requirements / submit_scheme 工具返回确定性样例；演示一轮澄清、一次定向修订。
 * 不负责：真实网络、读环境变量、HTTP 服务或页面；这些由 interaction-server-core.ts 装配。
 */
import type { ChatClient } from '@pg/llm/client';
import type { ChatRequest, ChatResponse, Usage } from '@pg/llm/schema';

import type { DesignIntent } from '@pg/interaction/design-intent';
import { exampleIntent, exampleRequirements, exampleScheme } from '@pg/interaction/example';
import { DesignScheme, RequirementGraph } from '@pg/interaction/schema';
import type {
  DesignScheme as DesignSchemeType,
  RequirementGraph as RequirementGraphType,
} from '@pg/interaction/schema';

export interface MockClientOptions {
  /** 初始需求图；默认在 exampleRequirements 上加一个入口朝向问题，方便演示提问。 */
  readonly requirements?: RequirementGraphType;
  /** intent 样例；默认 exampleIntent。 */
  readonly intent?: DesignIntent;
  /** legacy 方案样例；默认 exampleScheme。 */
  readonly scheme?: DesignSchemeType;
}

/**
 * 默认演示需求：比 exampleRequirements 多一个高影响歧义，让网页能展示“提问 → 回答”；
 * 回答后 mock 会返回 revision+1 且已处理该歧义的需求图。
 */
export function demoRequirements(): RequirementGraphType {
  const base = exampleRequirements();
  return RequirementGraph.parse({
    ...base,
    ambiguities: [
      {
        id: 'amb-entrance',
        question: '入口主要从北侧村道进入，还是从南侧稻田一侧进入？',
        options: ['北侧村道', '南侧稻田'],
        impact: 'high',
        suggestedDefault: '北侧村道进入，南侧保留看景开口',
        status: 'open',
        requirementIds: ['req-view'],
      },
    ],
  });
}

function mockUsage(): Usage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
  };
}

/** 只用于离线演示的思考流；不会进入 session / artifacts。 */
export const MOCK_REASONING = 'mock 思考：先核对需求与场地，再整理结构化设计意图。';

function mockResponse(toolName: string, value: unknown): ChatResponse {
  return {
    id: `mock-${toolName}`,
    model: 'deepseek-flash',
    systemFingerprint: null,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `call-${toolName}`,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(value) },
        },
      ],
    },
    rawArguments: [],
    finishReason: 'tool_calls',
    usage: mockUsage(),
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

/** content-json 模式的离线响应：正文即 DesignIntent JSON，不产生 tool_calls。 */
function mockContentResponse(value: unknown): ChatResponse {
  return {
    id: 'mock-content-json',
    model: 'deepseek-flash',
    systemFingerprint: null,
    message: { role: 'assistant', content: JSON.stringify(value) },
    rawArguments: [],
    finishReason: 'stop',
    usage: mockUsage(),
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null || !('text' in part)) return '';
      const text = (part as { readonly text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

function requestText(request: ChatRequest): string {
  return request.messages
    .filter((message) => message.role === 'user')
    .map((message) => contentText(message.content))
    .join('\n\n');
}

/** 从提示词里取第一段 json（需求图）；用于把方案的 sourceRequirements 对齐到当前 revision。 */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (match?.[1] === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolvedRequirements(base: RequirementGraphType, extraction: number): RequirementGraphType {
  return RequirementGraph.parse({
    ...structuredClone(base),
    revision: base.revision + Math.max(0, extraction - 1),
    ambiguities: base.ambiguities.map((item) => ({ ...item, status: 'assumed' as const })),
    conflicts: base.conflicts.map((item) => ({ ...item, status: 'deferred' as const })),
    missing: base.missing.map((item) => ({ ...item, status: 'waived' as const })),
  });
}

function revisionOf(text: string): number | undefined {
  const match = /- revision：(\d+)/.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function schemeIdOf(text: string): string | undefined {
  const match = /- 方案 id：([^\n]+)/.exec(text);
  return match?.[1]?.trim();
}

function feedbackOf(text: string): string {
  const match = /用户反馈：([^\n]*)/.exec(text);
  return match?.[1]?.trim() ?? '';
}

/** 方案可修订字段：只做演示性的屋檐外挑 +1 和概念说明，几何仍用 exampleScheme。 */
function mockSchemeFor(base: DesignSchemeType, request: ChatRequest): DesignSchemeType {
  const text = requestText(request);
  const requirements = firstJsonObject(text);
  const sourceId = typeof requirements?.['id'] === 'string' ? requirements['id'] : undefined;
  const sourceRevision = typeof requirements?.['revision'] === 'number' ? requirements['revision'] : undefined;
  const revision = revisionOf(text);
  const schemeId = schemeIdOf(text);
  const feedback = feedbackOf(text);
  const value = structuredClone(base);
  const meta = { ...value.meta };
  if (revision !== undefined) meta.revision = revision;
  if (schemeId !== undefined && schemeId !== '') meta.id = schemeId;
  if (sourceId !== undefined && sourceRevision !== undefined) {
    meta.sourceRequirements = { graphId: sourceId, revision: sourceRevision };
  }
  if (feedback !== '') {
    meta.concept = `${meta.concept}（网页 mock 修订：${feedback.slice(0, 300)}）`;
  }
  const roof = { ...value.roof };
  if (feedback !== '' && roof.overhang < 50) roof.overhang += 1;
  return DesignScheme.parse({
    ...value,
    meta,
    roof,
    // 修订后的样例保持 review；会话状态机负责把旧版本标成 superseded。
  });
}

/** intent mock 只演示一次概念与屋檐修改，几何由宿主展开。 */
function mockIntentFor(base: DesignIntent, request: ChatRequest): DesignIntent {
  const value = structuredClone(base);
  const feedback = feedbackOf(requestText(request));
  if (feedback === '') return value;
  return {
    ...value,
    meta: { ...value.meta, concept: `${value.meta.concept}（网页 mock 修订：${feedback.slice(0, 300)}）` },
    roof: { ...value.roof, overhang: Math.min(50, value.roof.overhang + 1) },
  };
}

/**
 * 创建只按工具名回应的假 client。每个会话应创建一份，extraction 计数随会话独立。
 * 第一次需求抽取返回带问题的样例；回答后的抽取返回 revision+1 且已处理问题的需求图。
 */
export function createMockClient(options: MockClientOptions = {}): ChatClient {
  const requirements = options.requirements ?? demoRequirements();
  const intent = options.intent ?? exampleIntent();
  const scheme = options.scheme ?? exampleScheme();
  let extractions = 0;

  return {
    complete(request, options) {
      const onDelta = options.onDelta;
      const toolName = request.tools[0]?.function.name;
      onDelta?.({ kind: 'reasoning', text: MOCK_REASONING });
      if (toolName === 'submit_requirements') {
        extractions += 1;
        const value = extractions <= 1 ? requirements : resolvedRequirements(requirements, extractions);
        return Promise.resolve({ kind: 'ok', response: mockResponse(toolName, value) });
      }
      if (toolName === 'submit_intent') {
        const value = mockIntentFor(intent, request);
        onDelta?.({ kind: 'arguments', index: 0, text: JSON.stringify(value) });
        return Promise.resolve({ kind: 'ok', response: mockResponse(toolName, value) });
      }
      if (request.tools.length === 0 && request.response_format?.type === 'json_object') {
        const value = mockIntentFor(intent, request);
        onDelta?.({ kind: 'content', text: JSON.stringify(value) });
        return Promise.resolve({ kind: 'ok', response: mockContentResponse(value) });
      }
      if (toolName === 'submit_scheme') {
        const value = mockSchemeFor(scheme, request);
        return Promise.resolve({ kind: 'ok', response: mockResponse(toolName, value) });
      }
      return Promise.reject(new Error(`mock client 收到未知工具 ${String(toolName)}`));
    },
  };
}
