/**
 * design-agent 的离线 mock client：按工具名返回剧本 requirements / intent / scheme。
 * 不调用网络；解析、repair 与展开仍由 @pg/interaction 的真实生成路径完成。
 */
import type { ChatClient } from '@pg/llm/client';
import type { ChatRequest, ChatResponse, Usage } from '@pg/llm/schema';

import { exampleIntent } from '@pg/interaction/example';

export interface MockScript {
  readonly task: string;
  readonly requirements: unknown;
  readonly intent: unknown;
  readonly scheme: unknown;
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

function textOfPart(part: unknown): string {
  if (typeof part !== 'object' || part === null || !('text' in part)) return '';
  const text = (part as { readonly text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function userTextOf(request: ChatRequest): string {
  const last = [...request.messages].reverse().find((message) => message.role === 'user');
  if (last === undefined) return '';
  if (typeof last.content === 'string') return last.content;
  if (!Array.isArray(last.content)) return '';
  return last.content.map(textOfPart).join('\n');
}

/** 按生成提示里的 revision / 方案 id 克隆剧本，让 --feedback 的 revision 2 也能走真实校验。 */
function mockSchemeFor(scheme: unknown, request: ChatRequest): unknown {
  const value = structuredClone(scheme);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const meta = record['meta'];
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return value;
  const metaRecord = meta as Record<string, unknown>;
  const text = userTextOf(request);
  const revision = /- revision：(\d+)/.exec(text)?.[1];
  const id = /- 方案 id：([^\n]+)/.exec(text)?.[1]?.trim();
  const feedback = /用户反馈：([^\n]*)/.exec(text)?.[1]?.trim() ?? '';
  if (revision !== undefined) metaRecord['revision'] = Number(revision);
  if (id !== undefined && id !== '') metaRecord['id'] = id;
  if (feedback !== '' && feedback.includes('屋檐')) {
    const roof = record['roof'];
    if (typeof roof === 'object' && roof !== null && !Array.isArray(roof)) {
      const roofRecord = roof as Record<string, unknown>;
      const overhang = roofRecord['overhang'];
      if (typeof overhang === 'number' && overhang < 50) roofRecord['overhang'] = overhang + 1;
    }
    const concept = metaRecord['concept'];
    if (typeof concept === 'string' && !concept.includes('mock 修订')) {
      metaRecord['concept'] = `${concept}（mock 修订：${feedback}）`;
    }
  }
  return value;
}

/** intent mock 只演示一次概念说明与屋檐外挑修改；几何仍由宿主展开。 */
function mockIntentFor(base: unknown, request: ChatRequest): unknown {
  const value = structuredClone(base);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const meta = record['meta'];
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return value;
  const metaRecord = meta as Record<string, unknown>;
  const feedback = /用户反馈：([^\n]*)/.exec(userTextOf(request))?.[1]?.trim() ?? '';
  if (feedback !== '') {
    const concept = metaRecord['concept'];
    if (typeof concept === 'string' && !concept.includes('mock 修订')) {
      metaRecord['concept'] = `${concept}（网页 mock 修订：${feedback.slice(0, 300)}）`;
    }
    const roof = record['roof'];
    if (typeof roof === 'object' && roof !== null && !Array.isArray(roof)) {
      const roofRecord = roof as Record<string, unknown>;
      const overhang = roofRecord['overhang'];
      if (typeof overhang === 'number' && overhang < 50) roofRecord['overhang'] = overhang + 1;
    }
  }
  return value;
}

/** 假 client：按工具名返回剧本值；默认 submit_intent，保留 submit_scheme 供 legacy 回归。 */
export function createMockClient(script: MockScript): ChatClient {
  const intent = script.intent ?? exampleIntent();
  return {
    complete(request) {
      const name = request.tools[0]?.function.name;
      if (name === 'submit_requirements') {
        return Promise.resolve({ kind: 'ok', response: mockResponse(name, script.requirements) });
      }
      if (name === 'submit_intent') {
        return Promise.resolve({ kind: 'ok', response: mockResponse(name, mockIntentFor(intent, request)) });
      }
      if (name === 'submit_scheme') {
        if (script.scheme === undefined) throw new Error('mock client 没有 scheme，无法走 legacy 路径');
        return Promise.resolve({ kind: 'ok', response: mockResponse(name, mockSchemeFor(script.scheme, request)) });
      }
      throw new Error(`mock client 收到未知工具 ${String(name)}`);
    },
  };
}
