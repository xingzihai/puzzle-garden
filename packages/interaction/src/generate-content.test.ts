import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serializeRequest } from '@pg/llm/schema';
import type { ChatResponse, ToolDef, Usage } from '@pg/llm/schema';

import {
  contentJsonRepairRequest,
  extractContentJson,
  requestFor,
  requestForContentJson,
  responseDiagnostics,
} from './generate.ts';

const USAGE: Usage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 10,
};

const TOOL: ToolDef = {
  type: 'function',
  function: { name: 'submit_intent', description: '提交', parameters: { type: 'object' } },
};

function response(content: string | null, reasoning: string): ChatResponse {
  return {
    id: 'resp',
    model: 'deepseek-flash',
    systemFingerprint: null,
    message: {
      role: 'assistant',
      content,
      ...(reasoning === '' ? {} : { reasoning_content: reasoning }),
      ...(content === null
        ? { tool_calls: [{ id: 'call', type: 'function', function: { name: 'submit_intent', arguments: '{}' } }] }
        : {}),
    },
    rawArguments: [{ index: 0, text: '' }],
    finishReason: 'stop',
    usage: USAGE,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

test('严格正文 JSON：纯 JSON / 单个 fence 成功，散文 / 多 JSON / 截断失败', () => {
  const json = '{"meta":{"title":"亭"}}';
  assert.equal(extractContentJson(json)?.source, 'pure');
  assert.equal(extractContentJson(`\`\`\`json\n${json}\n\`\`\``)?.source, 'fenced');
  assert.equal(extractContentJson(`说明：${json}`), null);
  assert.equal(extractContentJson(`${json}\n${json}`), null);
  assert.equal(extractContentJson('{"meta":'), null);
  assert.equal(extractContentJson(`说明：${json}`, { allowEmbedded: true })?.source, 'embedded');
});

test('response_format 回显只剥离顶层 type / response_format，其他未知字段保留', () => {
  const typeEcho = extractContentJson('{"type":"json_object","meta":{"title":"亭"}}');
  assert.ok(typeEcho !== null);
  assert.deepEqual(typeEcho.value, { meta: { title: '亭' } });
  assert.deepEqual(typeEcho.echoes, [{ field: 'type', value: 'json_object' }]);

  const formatEcho = extractContentJson('{"response_format":{"type":"json_object"},"meta":{"title":"亭"}}');
  assert.ok(formatEcho !== null);
  assert.deepEqual(formatEcho.value, { meta: { title: '亭' } });
  assert.deepEqual(formatEcho.echoes, [{ field: 'response_format', value: { type: 'json_object' } }]);

  const both = extractContentJson(
    '{"type":"json_object","response_format":"json_object","meta":{"title":"亭"},"surprise":true}',
  );
  assert.ok(both !== null);
  assert.deepEqual(both.value, { meta: { title: '亭' }, surprise: true });
  assert.deepEqual(
    both.echoes?.map((echo) => echo.field),
    ['type', 'response_format'],
  );

  const illegalType = extractContentJson('{"type":"object","meta":{"title":"亭"}}');
  assert.ok(illegalType !== null);
  assert.deepEqual(illegalType.value, { type: 'object', meta: { title: '亭' } });
  assert.equal(illegalType.echoes, undefined);
});

test('content-json 请求：tools 为空、response_format、最高可用 thinking', () => {
  const request = requestForContentJson('系统', '用户', { maxTokens: 1024 });
  assert.equal(request.tools.length, 0);
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.deepEqual(request.thinking, { type: 'enabled' });
  const body = JSON.parse(serializeRequest(request)) as Record<string, unknown>;
  assert.deepEqual(body['tools'], []);
  assert.deepEqual(body['response_format'], { type: 'json_object' });

  const disabled = requestForContentJson('系统', '用户', { maxTokens: 1024, thinking: 'disabled' });
  assert.deepEqual(disabled.thinking, { type: 'disabled' });
});

test('tool repair 请求转成 JSON-only：去掉工具并追加只输出 JSON 的约束', () => {
  const toolRequest = requestFor('系统', '用户', TOOL, { maxTokens: 1024 });
  const repair = contentJsonRepairRequest(toolRequest);
  assert.equal(repair.tools.length, 0);
  assert.deepEqual(repair.response_format, { type: 'json_object' });
  const system = repair.messages[0];
  assert.ok(system?.role === 'system');
  assert.match(system.content, /JSON-only content 模式/);
});

test('失败诊断保留 usage / rawArguments / content / reasoning', () => {
  const request = requestForContentJson('系统', '用户', { maxTokens: 1024 });
  const diagnostics = responseDiagnostics(response('散文', '先想'), request, 'content-json');
  assert.equal(diagnostics.finishReason, 'stop');
  assert.equal(diagnostics.totalTokens, 15);
  assert.equal(diagnostics.outputMode, 'content-json');
  assert.equal(diagnostics.thinking, 'thinking:enabled');
  assert.deepEqual(diagnostics.rawArguments, [{ index: 0, text: '' }]);
  assert.equal(diagnostics.content, '散文');
  assert.equal(diagnostics.reasoningContent, '先想');
  assert.equal(diagnostics.reasoningChars, 2);
  assert.equal(diagnostics.usage?.total_tokens, 15);
});
