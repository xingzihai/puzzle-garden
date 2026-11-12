import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { ChatClient } from '@pg/llm/client';
import type { ChatRequest, ChatResponse, ToolCall, Usage } from '@pg/llm/schema';

import { compileBuildBrief, lintBrief } from './brief.ts';
import { renderPreviewBundle } from './preview.ts';
import { exampleIntent } from './example-intent.ts';
import { exampleRequirements } from './example-requirements.ts';
import {
  createIntentHost,
  DEFAULT_INTENT_MAX_TOKENS,
  extractIntentContentJson,
  proposeIntent,
  REPAIR_INTENT_TOOL_NAME,
} from './generate-intent.ts';
import type { InteractionProgressEvent } from './generate-intent.ts';
import { GenerationError } from './generate.ts';
import type { DesignHostContext } from './design-intent.ts';
import { INTENT_FIELDS, INTENT_TOOL_NAME } from './prompts-intent.ts';

const USAGE: Usage = {
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  prompt_cache_hit_tokens: 10,
  prompt_cache_miss_tokens: 90,
};

function atLeast(value: number, minimum: number): boolean {
  return value >= minimum;
}

function call(name: string, argumentsText: string): ToolCall {
  return { id: `call-${name}`, type: 'function', function: { name, arguments: argumentsText } };
}

function response(name: string, value: unknown): ChatResponse {
  return {
    id: `resp-${name}`,
    model: 'deepseek-flash',
    systemFingerprint: null,
    message: { role: 'assistant', content: null, tool_calls: [call(name, JSON.stringify(value))] },
    rawArguments: [],
    finishReason: 'tool_calls',
    usage: USAGE,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

function contentResponse(name: string, argumentsText: string, content: string): ChatResponse {
  return {
    id: `resp-${name}`,
    model: 'deepseek-flash',
    systemFingerprint: null,
    message: { role: 'assistant', content, tool_calls: [call(name, argumentsText)] },
    rawArguments: [],
    finishReason: 'tool_calls',
    usage: USAGE,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

function responseClient(result: ChatResponse): ChatClient {
  return {
    complete() {
      return Promise.resolve({ kind: 'ok', response: result });
    },
  };
}

function contentClient(
  content: string,
  requests: ChatRequest[] = [],
  reasoning = '',
  finishReason: ChatResponse['finishReason'] = 'stop',
): ChatClient {
  return {
    complete(request) {
      requests.push(request);
      return Promise.resolve({
        kind: 'ok',
        response: {
          ...contentOnlyResponse('submit_intent', null),
          message: {
            role: 'assistant',
            content,
            ...(reasoning === '' ? {} : { reasoning_content: reasoning }),
          },
          finishReason,
        },
      });
    },
  };
}

function rawArgumentsResponse(toolName: string, argumentsText: string, raw: string, reasoning: string): ChatResponse {
  return {
    id: `resp-${toolName}`,
    model: 'deepseek-flash',
    systemFingerprint: null,
    message: {
      role: 'assistant',
      content: null,
      reasoning_content: reasoning,
      tool_calls: [call(toolName, argumentsText)],
    },
    rawArguments: [{ index: 0, text: raw }],
    finishReason: 'tool_calls',
    usage: USAGE,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

function requestLabel(request: ChatRequest): string {
  const system = request.messages[0];
  if (request.tools[0] !== undefined) return request.tools[0].function.name;
  return system?.role === 'system' && system.content.includes('【定点修复')
    ? REPAIR_INTENT_TOOL_NAME
    : INTENT_TOOL_NAME;
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

function scriptedClient(
  script: (request: ChatRequest, name: string) => unknown,
  requests: ChatRequest[] = [],
): ChatClient {
  return {
    complete(request) {
      requests.push(request);
      const system = request.messages[0];
      const repair = system?.role === 'system' && system.content.includes('【定点修复');
      const name = request.tools[0]?.function.name ?? (repair ? REPAIR_INTENT_TOOL_NAME : INTENT_TOOL_NAME);
      const value = script(request, name);
      return Promise.resolve({
        kind: 'ok',
        response: request.tools.length === 0 ? contentOnlyResponse(name, value) : response(name, value),
      });
    },
  };
}

function brokenIntent(mutate: (value: Record<string, unknown>) => void): unknown {
  const value = structuredClone(exampleIntent()) as unknown as Record<string, unknown>;
  mutate(value);
  return value;
}

function brokenFurnitureIntent(): unknown {
  return brokenIntent((value) => {
    const furniture = value['furniture'] as { id: string; height?: number }[];
    const table = furniture.find((item) => item.id === 'fu-table');
    if (table === undefined) throw new Error('缺少测试家具');
    table.height = 10;
  });
}

type Mutable = Record<string, unknown>;

function record(value: unknown): Mutable {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('期望对象');
  return value as Mutable;
}

/** 用真实 raw fixture 构造模型式 repair patch：只改 intent 字段，不改宿主展开规则。 */
function realFailureCorrection(raw: Mutable): readonly { readonly path: string; readonly value: unknown }[] {
  const program = structuredClone(raw['program']);
  const programRecord = record(program);
  const rooms = programRecord['rooms'] as Mutable[];
  const room = (id: string): Mutable => {
    const found = rooms.find((entry) => entry['id'] === id);
    if (found === undefined) throw new Error(`fixture 缺少房间 ${id}`);
    return found;
  };
  room('room-hall')['rect'] = { x: [2, 9], z: [1, 6] };
  room('room-hall')['adjacency'] = ['room-counter', 'room-storage'];
  room('room-counter')['rect'] = { x: [2, 9], z: [-2, 1] };
  room('room-counter')['adjacency'] = ['room-hall'];
  room('room-storage')['rect'] = { x: [2, 9], z: [6, 10] };
  room('room-storage')['adjacency'] = ['room-hall'];

  const site = structuredClone(raw['site']);
  const siteRecord = record(site);
  const zones = siteRecord['outdoorZones'] as Mutable[];
  const zone = (id: string): Mutable => {
    const found = zones.find((entry) => entry['id'] === id);
    if (found === undefined) throw new Error(`fixture 缺少分区 ${id}`);
    return found;
  };
  zone('zone-entry-paving')['rect'] = { x: [2, 10], z: [-5, -2] };
  zone('zone-south-terrace')['rect'] = { x: [2, 10], z: [10, 13] };
  zone('zone-rice-field-view')['rect'] = { x: [-6, 14], z: [10, 17] };

  const envelope = structuredClone(raw['envelope']);
  const envelopeRecord = record(envelope);
  envelopeRecord['walls'] = [];
  envelopeRecord['stairs'] = [];

  const furniture = structuredClone(raw['furniture']) as Mutable[];
  const item = (id: string): Mutable => {
    const found = furniture.find((entry) => entry['id'] === id);
    if (found === undefined) throw new Error(`fixture 缺少家具 ${id}`);
    return found;
  };
  item('fz-long-table')['footprint'] = { x: 4, z: 2 };
  item('fz-bench-south')['footprint'] = { x: 4, z: 1 };
  item('fz-bench-south')['anchor'] = { kind: 'wall', side: 'south', offset: 3 };
  item('fz-bench-north')['footprint'] = { x: 4, z: 1 };
  item('fz-bench-north')['anchor'] = { kind: 'wall', side: 'north', offset: 3 };
  item('fz-rug-hall')['footprint'] = { x: 3, z: 2 };
  item('fz-rug-hall')['height'] = 1;
  item('fz-counter-body')['anchor'] = { kind: 'wall', side: 'north', offset: 3 };
  item('fz-storage-cabinet')['anchor'] = { kind: 'wall', side: 'east', offset: 2 };
  item('fz-storage-shelf')['anchor'] = { kind: 'wall', side: 'north', offset: 2 };
  const removed = new Set(['fz-stool-west', 'fz-counter-top', 'fz-table-plant', 'fz-entry-sign']);
  const correctedFurniture = furniture.filter((entry) => !removed.has(String(entry['id'])));

  const roomPatches = ['room-hall', 'room-counter', 'room-storage'].flatMap((id) => {
    const index = rooms.findIndex((entry) => entry['id'] === id);
    if (index < 0) throw new Error(`fixture 缺少房间 ${id}`);
    const room = rooms[index];
    if (room === undefined) throw new Error(`fixture 缺少房间 ${id}`);
    return [
      { path: `/program/rooms/${String(index)}/rect`, value: room['rect'] },
      { path: `/program/rooms/${String(index)}/adjacency`, value: room['adjacency'] },
    ];
  });
  const zonePatches = ['zone-entry-paving', 'zone-south-terrace', 'zone-rice-field-view'].map((id) => {
    const index = zones.findIndex((entry) => entry['id'] === id);
    if (index < 0) throw new Error(`fixture 缺少分区 ${id}`);
    const zone = zones[index];
    if (zone === undefined) throw new Error(`fixture 缺少分区 ${id}`);
    return { path: `/site/outdoorZones/${String(index)}/rect`, value: zone['rect'] };
  });

  return [
    ...roomPatches,
    ...zonePatches,
    { path: '/envelope', value: envelope },
    { path: '/furniture', value: correctedFurniture },
  ];
}

test('tool 模式 → submit_intent → expand：只暴露 12 字段 intent schema，产物可编译 lint', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-tea', revision: 1 });
  const requests: ChatRequest[] = [];
  const client = scriptedClient(() => exampleIntent(), requests);
  const result = await proposeIntent(client, requirements, host, { outputMode: 'tool' });

  assert.equal(result.intent.meta.title, '稻田茶亭');
  assert.equal(result.scheme.meta.id, 'scheme-tea');
  assert.equal(result.scheme.meta.revision, 1);
  assert.equal(result.scheme.meta.sourceRequirements.graphId, requirements.id);
  assert.equal(result.facts.counts.rooms, 2);
  assert.equal(result.usage.total_tokens, 150);

  const request = requests[0];
  assert.ok(request !== undefined);
  assert.equal(request.max_tokens, DEFAULT_INTENT_MAX_TOKENS);
  assert.equal(atLeast(request.max_tokens ?? 0, 16_384), true);
  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0]?.function.name, INTENT_TOOL_NAME);
  const properties = request.tools[0].function.parameters['properties'];
  assert.ok(typeof properties === 'object' && properties !== null);
  assert.deepEqual(Object.keys(properties).sort(), [...INTENT_FIELDS].sort());
  assert.equal(Object.hasOwn(properties, 'elements'), false);
  assert.equal(Object.hasOwn(properties, 'spaces'), false);
  assert.equal(Object.hasOwn(properties, 'budget'), false);
  const promptText = request.messages
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
  assert.doesNotMatch(promptText, /DesignScheme|hostRoomId|17 个顶层字段/);

  const brief = compileBuildBrief(result.scheme, requirements);
  assert.deepEqual(lintBrief(brief, requirements), []);
});

test('tool arguments = {} 时从 content 纯 JSON / fenced JSON 回退，并记录 warning', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-content' });
  const json = JSON.stringify(exampleIntent());
  const pure = await proposeIntent(responseClient(contentResponse(INTENT_TOOL_NAME, '{}', json)), requirements, host, {
    scope: 'exterior+interior',
    outputMode: 'tool',
  });
  assert.equal(pure.contentFallbacks[0]?.source, 'pure');
  assert.ok(pure.warnings.some((warning) => warning.code === 'content-fallback'));
  assert.equal(pure.scheme.meta.id, 'scheme-content');

  const fenced = await proposeIntent(
    responseClient(contentResponse(INTENT_TOOL_NAME, '', `说明如下：\n\`\`\`json\n${json}\n\`\`\`\n请复核。`)),
    requirements,
    host,
    { scope: 'exterior+interior', outputMode: 'tool' },
  );
  assert.equal(fenced.contentFallbacks[0]?.source, 'fenced');
  assert.ok(fenced.warnings.some((warning) => warning.code === 'content-fallback'));
});

test('content 里的散文 / 多个 JSON / 截断 JSON 不被当作成功；非空非法 arguments 不回退', async () => {
  const json = JSON.stringify(exampleIntent());
  assert.equal(extractIntentContentJson('这是设计说明，没有 JSON。'), null);
  assert.equal(extractIntentContentJson(`${json}\n{"meta":{"title":"second"}}`), null);
  assert.equal(extractIntentContentJson('{"meta":{"title":"截断"'), null);
  assert.equal(extractIntentContentJson(`前文 ${json} 后文`), null);
  assert.equal(extractIntentContentJson(`前文 ${json} 后文`, { allowEmbedded: true })?.source, 'embedded');

  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-content-invalid' });
  await assert.rejects(
    () =>
      proposeIntent(responseClient(contentResponse(INTENT_TOOL_NAME, '{not-json', json)), requirements, host, {
        scope: 'exterior+interior',
        outputMode: 'tool',
      }),
    (error: unknown) => error instanceof GenerationError && error.code === 'invalid-json',
  );
});

test('content-json 模式：tools 为空 + response_format + thinking disabled；纯 JSON / fenced 都成功', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-content-json' });
  const json = JSON.stringify(exampleIntent());
  const pureRequests: ChatRequest[] = [];
  const pure = await proposeIntent(contentClient(json, pureRequests), requirements, host, {
    scope: 'exterior+interior',
    outputMode: 'content-json',
    narrative: false,
  });
  assert.equal(pure.intent.meta.title, '稻田茶亭');
  assert.equal(pure.contentFallbacks.length, 0);
  const pureRequest = pureRequests[0];
  assert.ok(pureRequest !== undefined);
  assert.equal(pureRequest.tools.length, 0);
  assert.deepEqual(pureRequest.response_format, { type: 'json_object' });
  assert.deepEqual(pureRequest.thinking, { type: 'disabled' });

  const fencedRequests: ChatRequest[] = [];
  const fenced = await proposeIntent(contentClient(`\`\`\`json\n${json}\n\`\`\``, fencedRequests), requirements, host, {
    scope: 'exterior+interior',
    outputMode: 'content-json',
    narrative: false,
  });
  assert.equal(fenced.scheme.meta.id, 'scheme-content-json');
  assert.equal(fencedRequests[0]?.tools.length, 0);
});

test('content-json 顶层 type 回显被剥离并记录 warning；其他未知字段 / 非法 type 仍失败', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-content-echo' });
  const echoed = JSON.stringify({ type: 'json_object', ...exampleIntent() });
  const requests: ChatRequest[] = [];
  const result = await proposeIntent(contentClient(echoed, requests), requirements, host, {
    outputMode: 'content-json',
    narrative: false,
  });
  assert.equal(result.intent.meta.title, '稻田茶亭');
  assert.equal(result.scheme.meta.id, 'scheme-content-echo');
  assert.ok(result.normalizationWarnings.some((warning) => warning.code === 'response-format-echo-dropped'));
  assert.equal(requests[0]?.max_tokens, DEFAULT_INTENT_MAX_TOKENS);

  const unknown = JSON.stringify({ ...exampleIntent(), surprise: true });
  await assert.rejects(
    () => proposeIntent(contentClient(unknown), requirements, host, { outputMode: 'content-json', narrative: false }),
    (error: unknown) =>
      error instanceof GenerationError && error.code === 'schema-invalid' && error.message.includes('surprise'),
  );

  const illegalType = JSON.stringify({ type: 'object', ...exampleIntent() });
  await assert.rejects(
    () =>
      proposeIntent(contentClient(illegalType), requirements, host, { outputMode: 'content-json', narrative: false }),
    (error: unknown) =>
      error instanceof GenerationError && error.code === 'schema-invalid' && error.message.includes('type'),
  );
});

test('content-json 严格拒绝散文 / 多 JSON / 截断，并把正文与 reasoning 留在诊断', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-content-invalid' });
  const json = JSON.stringify(exampleIntent());
  const reasoning = '先核对需求。';
  for (const content of [`说明如下：${json}`, `${json}\n${json}`, '{"meta":{"title":"截断"']) {
    await assert.rejects(
      () =>
        proposeIntent(contentClient(content, [], reasoning), requirements, host, {
          outputMode: 'content-json',
          narrative: false,
        }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.equal(error.code, 'invalid-json');
        const diagnostics = error.diagnostics;
        assert.ok(diagnostics !== null);
        assert.equal(diagnostics.outputMode, 'content-json');
        assert.equal(diagnostics.thinking, 'thinking:disabled');
        assert.equal(diagnostics.content, content);
        assert.equal(diagnostics.reasoningContent, reasoning);
        assert.equal(diagnostics.reasoningChars, reasoning.length);
        assert.equal(diagnostics.usage?.total_tokens, 150);
        return true;
      },
    );
  }

  await assert.rejects(
    () =>
      proposeIntent(contentClient('{"meta":', [], reasoning, 'length'), requirements, host, {
        outputMode: 'content-json',
        narrative: false,
      }),
    (error: unknown) =>
      error instanceof GenerationError &&
      error.code === 'truncated' &&
      error.diagnostics?.content === '{"meta":' &&
      error.diagnostics.contentTruncated === true,
  );
});

test('reasoning_content 只流式转发，不进入 DesignIntent / scheme；进度含 stage / thinking / content', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-progress' });
  const json = JSON.stringify(exampleIntent());
  const reasoning = '先核对需求，再逐字段填写。';
  const events: InteractionProgressEvent[] = [];
  const client: ChatClient = {
    complete(_request, options) {
      const onDelta = options.onDelta;
      assert.ok(onDelta !== undefined);
      assert.equal(onDelta({ kind: 'reasoning', text: reasoning }), 'continue');
      assert.equal(onDelta({ kind: 'content', text: json }), 'continue');
      return Promise.resolve({
        kind: 'ok',
        response: {
          ...contentOnlyResponse('submit_intent', null),
          message: { role: 'assistant', content: json, reasoning_content: reasoning },
        },
      });
    },
  };
  const result = await proposeIntent(client, requirements, host, {
    scope: 'exterior+interior',
    outputMode: 'content-json',
    narrative: false,
    onProgress: (event) => events.push(event),
  });

  assert.ok(events.some((event) => event.kind === 'thinking' && event.text === reasoning));
  assert.ok(events.some((event) => event.kind === 'content' && event.text === json));
  assert.ok(events.some((event) => event.kind === 'stage' && event.stage === 'intent' && event.status === 'start'));
  assert.ok(events.some((event) => event.kind === 'stage' && event.stage === 'intent' && event.status === 'done'));
  assert.ok(events.some((event) => event.kind === 'stage' && event.stage === 'expand' && event.status === 'done'));
  assert.equal(JSON.stringify(result.intent).includes(reasoning), false);
  assert.equal(JSON.stringify(result.scheme).includes(reasoning), false);
  assert.equal(JSON.stringify(result.facts).includes(reasoning), false);
  assert.equal(result.rawResponse.message.reasoning_content, undefined);
});

test('tool 模式空 arguments：repair 失败时诊断保留首轮 rawArguments / reasoning / usage', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-raw-args' });
  const client: ChatClient = {
    complete(request) {
      const tool = request.tools[0]?.function.name;
      if (tool === REPAIR_INTENT_TOOL_NAME) {
        return Promise.resolve({
          kind: 'ok',
          response: rawArgumentsResponse(REPAIR_INTENT_TOOL_NAME, '{"patches":[]}', 'patches-empty', '修复思考'),
        });
      }
      return Promise.resolve({
        kind: 'ok',
        response: rawArgumentsResponse(INTENT_TOOL_NAME, '{}', '', '首轮思考'),
      });
    },
  };

  await assert.rejects(
    () => proposeIntent(client, requirements, host, { outputMode: 'tool' }),
    (error: unknown) => {
      assert.ok(error instanceof GenerationError);
      const diagnostics = error.diagnostics;
      assert.ok(diagnostics !== null);
      assert.equal(diagnostics.outputMode, 'tool');
      assert.equal(diagnostics.thinking, 'thinking:enabled');
      assert.equal(diagnostics.usage?.total_tokens, 150);
      assert.equal(diagnostics.rawArguments?.[0]?.text, 'patches-empty');
      const previous = diagnostics.previous;
      assert.ok(previous !== undefined);
      assert.ok(previous.rawArguments !== undefined);
      assert.equal(previous.rawArguments[0]?.text, '');
      assert.equal(previous.reasoningContent, '首轮思考');
      assert.equal(previous.argumentChars, 2);
      assert.equal(previous.usage?.total_tokens, 150);
      return true;
    },
  );
});

test('schema-invalid 走一次 repair_intent 定点 patch，并汇总 usage', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-tea', revision: 1 });
  const broken = brokenIntent((value) => {
    Reflect.deleteProperty(value, 'roof');
  });
  const requests: ChatRequest[] = [];
  const client = scriptedClient((_request, name) => {
    if (name === INTENT_TOOL_NAME) return broken;
    if (name === REPAIR_INTENT_TOOL_NAME) return { patches: [{ path: '/roof', value: exampleIntent().roof }] };
    throw new Error(`未知工具 ${name}`);
  }, requests);
  const events: InteractionProgressEvent[] = [];

  const result = await proposeIntent(client, requirements, host, { onProgress: (event) => events.push(event) });
  assert.deepEqual(
    requests.map((request) => requestLabel(request)),
    [INTENT_TOOL_NAME, REPAIR_INTENT_TOOL_NAME],
  );
  assert.equal(result.intent.roof.form, 'gable');
  assert.equal(result.patchRepairs?.[0]?.path, '/roof');
  assert.equal(result.usage.total_tokens, 300);
  assert.ok(events.some((event) => event.kind === 'patch' && event.stage === 'repair' && event.path === '/roof'));
  assert.ok(events.some((event) => event.kind === 'stage' && event.stage === 'repair' && event.status === 'start'));
});

test('explicit kind=none 不再删除墙：保留派生外墙并记录 wall-kind-ignored，不走 repair', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-tea', revision: 1 });
  const broken = brokenIntent((value) => {
    value['envelope'] = {
      wallDefaults: { exteriorThickness: 1, interiorThickness: 1 },
      walls: [{ roomId: 'sp-tea', side: 'north', kind: 'none' }],
      stairs: [],
    };
  });
  const requests: ChatRequest[] = [];
  const client = scriptedClient((_request, name) => {
    if (name === INTENT_TOOL_NAME) return broken;
    throw new Error(`不应发起 repair，收到 ${name}`);
  }, requests);

  const result = await proposeIntent(client, requirements, host);
  assert.equal(result.scheme.openings.find((opening) => opening.id === 'op-entry')?.side, 'north');
  assert.equal(result.patchRepairs, undefined);
  assert.equal(
    result.warnings.some(
      (warning) => warning.code === 'wall-kind-ignored' && warning.path === 'envelope.walls.sp-tea:north',
    ),
    true,
  );
  assert.deepEqual(
    requests.map((request) => requestLabel(request)),
    [INTENT_TOOL_NAME],
  );
});

test('两轮 patch 后仍失败时抛可读 expand-invalid，不静默降级', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-tea', revision: 1 });
  const broken = brokenFurnitureIntent();
  let repairCalls = 0;
  const client = scriptedClient((_request, name) => {
    if (name === INTENT_TOOL_NAME) return broken;
    if (name === REPAIR_INTENT_TOOL_NAME) {
      repairCalls += 1;
      return { patches: [{ path: '/furniture/0/name', value: `仍然放不下-${String(repairCalls)}` }] };
    }
    throw new Error(`未知工具 ${name}`);
  });

  await assert.rejects(
    () => proposeIntent(client, requirements, host),
    (error: unknown) =>
      error instanceof GenerationError &&
      error.code === 'expand-invalid' &&
      error.repairFailed &&
      error.message.includes('furniture'),
  );
  assert.equal(repairCalls, 2);
});

test('patch 无变化 / 空 patch 明确失败，不静默成功', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-tea', revision: 1 });
  const broken = brokenFurnitureIntent();
  const noChange = scriptedClient((_request, name) => {
    if (name === INTENT_TOOL_NAME) return broken;
    if (name === REPAIR_INTENT_TOOL_NAME) return { patches: [{ path: '/furniture/0/name', value: '仍然放不下' }] };
    throw new Error(`未知工具 ${name}`);
  });
  await assert.rejects(
    () => proposeIntent(noChange, requirements, host),
    (error: unknown) =>
      error instanceof GenerationError &&
      error.code === 'expand-invalid' &&
      error.repairFailed &&
      error.message.includes('没有改变'),
  );
  const empty = scriptedClient((_request, name) => {
    if (name === INTENT_TOOL_NAME) return broken;
    if (name === REPAIR_INTENT_TOOL_NAME) return { patches: [] };
    throw new Error(`未知工具 ${name}`);
  });
  await assert.rejects(
    () => proposeIntent(empty, requirements, host),
    (error: unknown) => error instanceof GenerationError && error.code === 'expand-invalid' && error.repairFailed,
  );
});

test('第二轮 patch 修复后成功，patch 次数记入结果', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-tea', revision: 1 });
  const broken = brokenFurnitureIntent();
  let repairCalls = 0;
  const client = scriptedClient((_request, name) => {
    if (name === INTENT_TOOL_NAME) return broken;
    if (name === REPAIR_INTENT_TOOL_NAME) {
      repairCalls += 1;
      return repairCalls === 1
        ? { patches: [{ path: '/furniture/0/name', value: '仍然放不下' }] }
        : { patches: [{ path: '/furniture/0/height', value: 1 }] };
    }
    throw new Error(`未知工具 ${name}`);
  });
  const result = await proposeIntent(client, requirements, host);
  assert.equal(repairCalls, 2);
  assert.equal(result.expandPatchCount, 2);
  assert.equal(result.intent.furniture[0]?.height, 1);
  assert.equal(result.scheme.meta.id, 'scheme-tea');
});

test('决策 requirementIds 引用不存在时丢弃标签并成功，不触发 repair', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-decision-ref', requirementIds: ['req-view'] });
  const broken = brokenIntent((value) => {
    const decisions = value['decisions'] as { id: string; requirementIds: string[] }[];
    const decision = decisions.find((item) => item.id === 'dec-roof');
    if (decision === undefined) throw new Error('缺少测试决策');
    decision.requirementIds = ['req-view', 'req-missing'];
  });
  const requests: ChatRequest[] = [];
  const client = scriptedClient((_request, name) => {
    if (name === INTENT_TOOL_NAME) return broken;
    throw new Error(`不应触发 repair：${name}`);
  }, requests);

  const result = await proposeIntent(client, requirements, host);
  assert.equal(requests.length, 1);
  assert.equal(result.repairRoundCount, 0);
  assert.equal(result.expandPatchCount, 0);
  const decision = result.scheme.decisions.find((item) => item.id === 'dec-roof');
  assert.deepEqual(decision?.requirementIds, ['req-view']);
  const dropped = result.warnings.find((warning) => warning.code === 'requirement-reference-dropped');
  assert.ok(dropped !== undefined);
  assert.equal(dropped.path, 'decisions.dec-roof.requirementIds');
  assert.match(dropped.message, /req-missing/);
  assert.match(dropped.message, /不影响几何展开/);
});

test('补丁数组下标越界时重试一次 repair，第二次合法 patch 会成功且只计一轮', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-invalid-patch-retry', revision: 1 });
  const broken = brokenFurnitureIntent();
  const requests: ChatRequest[] = [];
  let repairCalls = 0;
  const client = scriptedClient((_request, name) => {
    if (name === INTENT_TOOL_NAME) return broken;
    if (name === REPAIR_INTENT_TOOL_NAME) {
      repairCalls += 1;
      return repairCalls === 1
        ? { patches: [{ path: '/furniture/99/height', value: 1 }] }
        : { patches: [{ path: '/furniture/0/height', value: 1 }] };
    }
    throw new Error(`未知工具 ${name}`);
  }, requests);

  const result = await proposeIntent(client, requirements, host);
  assert.equal(repairCalls, 2);
  assert.equal(requests.length, 3);
  const retryPrompt = requests[2]?.messages.at(-1)?.content;
  assert.ok(typeof retryPrompt === 'string');
  assert.match(retryPrompt, /补丁无效：补丁路径 \/furniture\/99\/height 的数组下标 99 无效/);
  assert.match(retryPrompt, /请返回合法 JSON Pointer/);
  assert.match(retryPrompt, /数组越界时用现有下标或 op:add \/ '-' 追加/);
  assert.equal(result.intent.furniture[0]?.height, 1);
  assert.equal(result.repairRoundCount, 1);
  assert.equal(result.expandPatchCount, 1);
  assert.equal(result.usage.total_tokens, 450);
});

test('补丁连续两次无效时明确失败并保留诊断', async () => {
  const requirements = exampleRequirements();
  const host = createIntentHost(requirements, { schemeId: 'scheme-invalid-patch-fail', revision: 1 });
  const broken = brokenFurnitureIntent();
  let repairCalls = 0;
  const client = scriptedClient((_request, name) => {
    if (name === INTENT_TOOL_NAME) return broken;
    if (name === REPAIR_INTENT_TOOL_NAME) {
      repairCalls += 1;
      return repairCalls === 1
        ? { patches: [{ path: '/furniture/99/height', value: 1 }] }
        : { patches: [{ path: '/furniture/98/height', value: 1 }] };
    }
    throw new Error(`未知工具 ${name}`);
  });

  await assert.rejects(
    () => proposeIntent(client, requirements, host),
    (error: unknown) => {
      assert.ok(error instanceof GenerationError);
      assert.equal(error.code, 'expand-invalid');
      assert.equal(error.repairFailed, true);
      assert.match(error.message, /补丁无效/);
      assert.match(error.message, /已重试 1 次/);
      assert.match(error.message, /数组下标 98 无效/);
      assert.ok(error.diagnostics !== null);
      assert.equal(error.diagnostics.outputMode, 'tool');
      assert.equal(error.diagnostics.usage?.total_tokens, 150);
      return true;
    },
  );
  assert.equal(repairCalls, 2);
});

test('真实 raw fixture：模型 patch 修房间 / adjacency / 家具后 strict + expand + lint + preview 通过', async () => {
  const raw = record(
    JSON.parse(readFileSync(new URL('../fixtures/design-intent-live-failure.json', import.meta.url), 'utf8')),
  );
  const patch = realFailureCorrection(raw);
  const requirements = exampleRequirements();
  const decisionIds = (raw['decisions'] as { readonly requirementIds: readonly string[] }[]).flatMap(
    (decision) => decision.requirementIds,
  );
  const host = createIntentHost(requirements, {
    schemeId: 'scheme-live-repaired',
    requirementIds: [...new Set(decisionIds)],
  });
  const client = scriptedClient((_request, name) => {
    if (name === INTENT_TOOL_NAME) return raw;
    if (name === REPAIR_INTENT_TOOL_NAME) return { patches: patch };
    throw new Error(`未知工具 ${name}`);
  });
  const result = await proposeIntent(client, requirements, host, {
    scope: 'exterior+interior',
    maxTokens: 32_768,
  });
  assert.equal(result.schemaPatchCount, 0);
  assert.equal(result.repairRoundCount, 1);
  assert.equal(result.expandPatchCount, 10);
  assert.equal(result.patchRepairs?.length, 10);
  assert.equal(result.intent.program.rooms.length, 3);
  assert.ok(result.normalizationWarnings.some((warning) => warning.code === 'structure-system-alias'));
  const brief = compileBuildBrief(result.scheme, requirements);
  assert.deepEqual(lintBrief(brief, requirements), []);
  assert.ok(renderPreviewBundle(result.scheme).files.length >= 5);
});

test('宿主 sourceRequirements 不一致时在调用模型前失败', async () => {
  let called = false;
  const client: ChatClient = {
    complete() {
      called = true;
      return Promise.reject(new Error('不应调用'));
    },
  };
  const requirements = exampleRequirements();
  const base = createIntentHost(requirements, { schemeId: 'scheme-tea' });
  const host: DesignHostContext = {
    ...base,
    sourceRequirements: { graphId: 'req-other', revision: 1 },
  };
  await assert.rejects(
    () => proposeIntent(client, requirements, host),
    (error: unknown) => error instanceof GenerationError && error.code === 'invalid-options',
  );
  assert.equal(called, false);
});
