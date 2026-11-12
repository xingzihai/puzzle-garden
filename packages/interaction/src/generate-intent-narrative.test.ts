import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatClient } from '@pg/llm/client';
import type { ChatRequest, ChatResponse, ToolCall, Usage } from '@pg/llm/schema';

import { compileBuildBrief, lintBrief } from './brief.ts';
import { exampleIntent } from './example-intent.ts';
import { exampleRequirements } from './example-requirements.ts';
import {
  createIntentHost,
  DEFAULT_INTENT_MAX_TOKENS,
  proposeIntent,
  REPAIR_INTENT_TOOL_NAME,
} from './generate-intent.ts';
import { GenerationError } from './generate.ts';
import { renderPreviewBundle } from './preview.ts';
import { INTENT_DRAFT_SCHEMA_TEXT, INTENT_NARRATIVE_TOOL_NAME, INTENT_TOOL_NAME } from './prompts-intent.ts';

const USAGE: Usage = {
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  prompt_cache_hit_tokens: 10,
  prompt_cache_miss_tokens: 90,
};

function call(name: string, argumentsText: string): ToolCall {
  return { id: `call-${name}`, type: 'function', function: { name, arguments: argumentsText } };
}

function contentOnlyResponse(name: string, value: unknown): ChatResponse {
  return {
    id: `resp-${name}`,
    model: 'deepseek-flash',
    systemFingerprint: null,
    message: { role: 'assistant', content: JSON.stringify(value) },
    rawArguments: [],
    finishReason: 'stop',
    usage: USAGE,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

function narrativeResponse(
  narrative: string,
  reasoning = '',
  finishReason: ChatResponse['finishReason'] = 'tool_calls',
): ChatResponse {
  return {
    id: 'resp-narrative',
    model: 'deepseek-flash',
    systemFingerprint: null,
    message: {
      role: 'assistant',
      content: null,
      ...(reasoning === '' ? {} : { reasoning_content: reasoning }),
      tool_calls: [call(INTENT_NARRATIVE_TOOL_NAME, JSON.stringify({ narrative }))],
    },
    rawArguments: [],
    finishReason,
    usage: USAGE,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

function messageText(request: ChatRequest, index: number): string {
  const content = request.messages[index]?.content;
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function brokenIntent(mutate: (value: Record<string, unknown>) => void): unknown {
  const value = structuredClone(exampleIntent()) as unknown as Record<string, unknown>;
  mutate(value);
  return value;
}

test('content-json：叙事 thinking enabled，严格 JSON 注入 Draft schema 且 thinking disabled', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-narrative' });
  const requests: ChatRequest[] = [];
  const narrative = '场地从南侧进入，保留檐下平台。\n体量保持单层小亭。\n主茶室与柜台分离。';
  const client: ChatClient = {
    complete(request) {
      requests.push(request);
      if (request.tools[0]?.function.name === INTENT_NARRATIVE_TOOL_NAME) {
        return Promise.resolve({ kind: 'ok', response: narrativeResponse(narrative, '先判断入口和体量。') });
      }
      return Promise.resolve({ kind: 'ok', response: contentOnlyResponse(INTENT_TOOL_NAME, exampleIntent()) });
    },
  };
  const result = await proposeIntent(client, requirements, host, { outputMode: 'content-json' });

  assert.equal(requests.length, 2);
  const narrativeRequest = requests[0];
  const jsonRequest = requests[1];
  assert.ok(narrativeRequest !== undefined && jsonRequest !== undefined);
  assert.equal(narrativeRequest.tools[0]?.function.name, INTENT_NARRATIVE_TOOL_NAME);
  assert.deepEqual(narrativeRequest.thinking, { type: 'enabled' });
  assert.equal(narrativeRequest.max_tokens, 4_096);
  assert.equal(jsonRequest.tools.length, 0);
  assert.deepEqual(jsonRequest.thinking, { type: 'disabled' });
  assert.equal(jsonRequest.max_tokens, DEFAULT_INTENT_MAX_TOKENS);
  assert.deepEqual(jsonRequest.response_format, { type: 'json_object' });
  assert.ok(messageText(jsonRequest, 0).includes(INTENT_DRAFT_SCHEMA_TEXT));
  assert.ok(messageText(jsonRequest, 1).includes('设计叙事（只作上下文，不进入 JSON）'));
  assert.ok(messageText(jsonRequest, 1).includes(narrative));

  assert.equal(result.stageDiagnostics.length, 2);
  const [narrativeDiag, jsonDiag] = result.stageDiagnostics;
  assert.ok(narrativeDiag !== undefined && jsonDiag !== undefined);
  assert.equal(narrativeDiag.stage, 'narrative');
  assert.equal(narrativeDiag.thinking, 'thinking:enabled');
  assert.equal(narrativeDiag.contentChars, narrative.length);
  assert.equal(jsonDiag.stage, 'intent');
  assert.equal(jsonDiag.thinking, 'thinking:disabled');
  assert.equal(jsonDiag.schemaChars, INTENT_DRAFT_SCHEMA_TEXT.length);
  assert.equal(
    result.warnings.some((warning) => warning.code === 'narrative-skipped'),
    false,
  );
  assert.equal(result.scheme.meta.id, 'scheme-narrative');

  const brief = compileBuildBrief(result.scheme, requirements);
  assert.deepEqual(lintBrief(brief, requirements), []);
  assert.ok(renderPreviewBundle(result.scheme).files.length >= 5);
});

test('叙事失败降级：记录 narrative-skipped，仍完成严格 JSON 与展开', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-narrative-skip' });
  const requests: ChatRequest[] = [];
  const client: ChatClient = {
    complete(request) {
      requests.push(request);
      if (request.tools[0]?.function.name === INTENT_NARRATIVE_TOOL_NAME) {
        return Promise.resolve({
          kind: 'ok',
          response: narrativeResponse('截断的叙事', '思考中', 'length'),
        });
      }
      return Promise.resolve({ kind: 'ok', response: contentOnlyResponse(INTENT_TOOL_NAME, exampleIntent()) });
    },
  };
  const result = await proposeIntent(client, requirements, host, { outputMode: 'content-json' });
  assert.equal(requests.length, 2);
  assert.ok(result.warnings.some((warning) => warning.code === 'narrative-skipped'));
  assert.deepEqual(
    result.stageDiagnostics.map((item) => item.stage),
    ['intent'],
  );
  assert.equal(result.scheme.meta.id, 'scheme-narrative-skip');
});

test('content-json repair 继承完整 schema / thinking disabled，并拒绝整段 /site、/program', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-repair-schema' });
  const broken = brokenIntent((value) => {
    Reflect.deleteProperty(value, 'roof');
  });
  const requests: ChatRequest[] = [];
  const client: ChatClient = {
    complete(request) {
      requests.push(request);
      if (messageText(request, 0).includes('【定点修复')) {
        return Promise.resolve({
          kind: 'ok',
          response: contentOnlyResponse(REPAIR_INTENT_TOOL_NAME, {
            patches: [{ path: '/roof', value: exampleIntent().roof }],
          }),
        });
      }
      return Promise.resolve({ kind: 'ok', response: contentOnlyResponse(INTENT_TOOL_NAME, broken) });
    },
  };
  const result = await proposeIntent(client, requirements, host, {
    outputMode: 'content-json',
    narrative: false,
  });
  const repairRequest = requests[1];
  assert.ok(repairRequest !== undefined);
  assert.equal(repairRequest.tools.length, 0);
  assert.deepEqual(repairRequest.response_format, { type: 'json_object' });
  assert.deepEqual(repairRequest.thinking, { type: 'disabled' });
  assert.ok(messageText(repairRequest, 0).includes(INTENT_DRAFT_SCHEMA_TEXT));
  assert.equal(result.schemaPatchCount, 1);

  for (const path of ['/site', '/program']) {
    const rootClient: ChatClient = {
      complete(request) {
        if (messageText(request, 0).includes('【定点修复')) {
          return Promise.resolve({
            kind: 'ok',
            response: contentOnlyResponse(REPAIR_INTENT_TOOL_NAME, {
              patches: [{ path, value: path === '/site' ? exampleIntent().site : exampleIntent().program }],
            }),
          });
        }
        return Promise.resolve({ kind: 'ok', response: contentOnlyResponse(INTENT_TOOL_NAME, broken) });
      },
    };
    await assert.rejects(
      () => proposeIntent(rootClient, requirements, host, { outputMode: 'content-json', narrative: false }),
      (error: unknown) =>
        error instanceof GenerationError && error.code === 'schema-invalid' && error.message.includes('禁止整段替换'),
    );
  }
});
