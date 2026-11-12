import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatClient } from '@pg/llm/client';
import { serializeRequest } from '@pg/llm/schema';
import type { ChatRequest, ChatResponse, ToolCall, Usage } from '@pg/llm/schema';

import { exampleRequirements } from './example-requirements.ts';
import { exampleScheme } from './example.ts';
import {
  DEFAULT_SCHEME_MAX_TOKENS,
  extractRequirements,
  GenerationError,
  parseToolSubmission,
  proposeScheme,
  REPAIR_SCHEME_TOOL_NAME,
} from './generate.ts';
import { RequirementGraph } from './requirements.ts';
import { DesignScheme } from './scheme.ts';
import { createSession, reduceSession } from './session.ts';

const USAGE: Usage = {
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  prompt_cache_hit_tokens: 10,
  prompt_cache_miss_tokens: 90,
};

function call(name: string, argumentsText: string): ToolCall {
  return { id: 'call-1', type: 'function', function: { name, arguments: argumentsText } };
}

function response(
  toolCalls: readonly ToolCall[],
  finishReason: ChatResponse['finishReason'] = 'tool_calls',
  content: string | null = null,
): ChatResponse {
  return {
    id: 'resp-1',
    model: 'deepseek-flash',
    systemFingerprint: null,
    message: {
      role: 'assistant',
      content,
      ...(toolCalls.length === 0 ? {} : { tool_calls: [...toolCalls] }),
    },
    rawArguments: [],
    finishReason,
    usage: USAGE,
    usageMismatch: false,
    timing: { firstByteMs: 1, firstTokenMs: 2, totalMs: 3 },
  };
}

function okClient(value: unknown, name: string, requests: ChatRequest[] = []): ChatClient {
  return {
    complete(request) {
      requests.push(request);
      return Promise.resolve({ kind: 'ok', response: response([call(name, JSON.stringify(value))]) });
    },
  };
}

function responseClient(result: ChatResponse): ChatClient {
  return {
    complete() {
      return Promise.resolve({ kind: 'ok', response: result });
    },
  };
}

test('需求抽取：interaction 默认最高思考 enabled，提交工具只有一个；显式 disabled 保留旧路径', async () => {
  const requests: ChatRequest[] = [];
  const client = okClient(exampleRequirements(), 'submit_requirements', requests);
  const result = await extractRequirements(client, { userText: '想在村口做一间小茶室。' });
  assert.equal(result.value.id, 'req-tea');
  assert.equal(result.usage.total_tokens, 150);
  assert.equal(result.rawResponse.finishReason, 'tool_calls');
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.model, 'deepseek-flash');
  assert.deepEqual(request.thinking, { type: 'enabled' });
  assert.equal(request.max_tokens, 32_768);
  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0]?.function.name, 'submit_requirements');
  assert.equal(Object.hasOwn(request.tools[0].function.parameters, '$schema'), false);
  const body = serializeRequest(request);
  assert.match(body, /"thinking":\{"type":"enabled"\}/);
  assert.equal(body.includes('$schema'), false);
  assert.equal(request.messages[0]?.role, 'system');
  assert.equal(request.messages[1]?.role, 'user');

  const disabledRequests: ChatRequest[] = [];
  await extractRequirements(
    okClient(exampleRequirements(), 'submit_requirements', disabledRequests),
    { userText: '测试关闭思考的既有路径。' },
    { thinking: 'disabled' },
  );
  assert.deepEqual(disabledRequests[0]?.thinking, { type: 'disabled' });
});

test('需求 id / revision 由宿主归一化，session 仍严格递增', async () => {
  const base = exampleRequirements();
  const zero = await extractRequirements(okClient({ ...base, revision: 0 }, 'submit_requirements'), {
    userText: '首次抽取 revision 0。',
  });
  assert.equal(zero.value.revision, 1);
  const zeroWarnings = zero.warnings ?? [];
  assert.equal(zeroWarnings.at(0)?.code, 'requirements-revision-normalized');
  assert.match(zeroWarnings.at(0)?.message ?? '', /首次抽取.*revision=0.*强制 revision=1/);

  const four = await extractRequirements(okClient({ ...base, revision: 4 }, 'submit_requirements'), {
    userText: '首次抽取 revision 4。',
  });
  assert.equal(four.value.revision, 1);
  assert.equal(four.warnings?.[0]?.code, 'requirements-revision-normalized');

  const existing = RequirementGraph.parse({ ...base, revision: 2 });
  const model = RequirementGraph.parse({ ...base, id: 'req-model-renamed', revision: 4 });
  const normalized = await extractRequirements(okClient(model, 'submit_requirements'), {
    userText: '旧图 revision 2，模型返回 revision 4。',
    existingRequirements: existing,
  });
  assert.equal(normalized.value.id, 'req-tea');
  assert.equal(normalized.value.revision, 3);
  const normalizedWarnings = normalized.warnings ?? [];
  assert.deepEqual(
    normalizedWarnings.map((warning) => warning.code),
    ['requirements-revision-normalized', 'requirements-id-normalized'],
  );
  assert.match(normalizedWarnings.at(0)?.message ?? '', /旧图 2 \+ 1 归一为 3/);
  assert.match(normalizedWarnings.at(1)?.message ?? '', /沿用旧 id=req-tea/);

  let state = createSession('ses-host-requirements-revision');
  state = reduceSession(state, { kind: 'recordRequirements', graph: exampleRequirements(1) });
  state = reduceSession(state, { kind: 'recordRequirements', graph: existing });
  assert.doesNotThrow(() => reduceSession(state, { kind: 'recordRequirements', graph: normalized.value }));
  assert.throws(
    () =>
      reduceSession(state, {
        kind: 'recordRequirements',
        graph: RequirementGraph.parse({ ...base, revision: 4 }),
      }),
    /递增 1/,
  );
  assert.throws(() => reduceSession(state, { kind: 'recordRequirements', graph: model }), /id 不能在同一会话内改变/);
});

test('方案生成：完整 scheme 通过 schema，并保留 rawResponse / usage', async () => {
  const client = okClient(exampleScheme(), 'submit_scheme');
  const result = await proposeScheme(client, exampleRequirements());
  assert.equal(result.value.meta.id, 'scheme-tea');
  assert.equal(result.value.interiors.length, 3);
  assert.equal(result.usage.prompt_cache_miss_tokens, 90);
  assert.equal(result.rawResponse.message.tool_calls?.[0]?.function.name, 'submit_scheme');
});

test('方案生成使用更大的输出上限，避免完整 DesignScheme 被截断', async () => {
  const requests: ChatRequest[] = [];
  const client = okClient(exampleScheme(), 'submit_scheme', requests);
  await proposeScheme(client, exampleRequirements());
  assert.equal(requests[0]?.max_tokens, DEFAULT_SCHEME_MAX_TOKENS);
});

test('schema-invalid 保留 finishReason / usage / arguments 长度诊断', async () => {
  await assert.rejects(
    () =>
      extractRequirements(responseClient(response([call('submit_requirements', '{"id":"req-x"}')])), {
        userText: '测试',
      }),
    (error: unknown) => {
      assert.ok(error instanceof GenerationError);
      assert.equal(error.code, 'schema-invalid');
      const diagnostics = error.diagnostics;
      assert.ok(diagnostics !== null);
      assert.equal(diagnostics.finishReason, 'tool_calls');
      assert.equal(diagnostics.promptTokens, 100);
      assert.equal(diagnostics.completionTokens, 50);
      assert.ok(diagnostics.argumentChars > 0);
      assert.equal(diagnostics.argumentTruncated, false);
      return true;
    },
  );
});

test('完整方案截断时自动切到 core / envelope / interior 分阶段生成', async () => {
  const full = exampleScheme();
  // 真实模型常把完整方案塞进第一个阶段工具；阶段 schema 只保留本阶段字段，
  // 完整方案被安全裁掉，后续阶段也不会用旧的 meta 覆盖 core。
  const core = { ...full };
  const envelope = {
    meta: { ...full.meta, title: '不应覆盖 core 的标题' },
    elements: full.elements,
    openings: full.openings,
    circulation: full.circulation,
    structure: full.structure,
    roof: full.roof,
    facades: full.facades,
    materials: full.materials,
  };
  const interior = {
    details: full.details,
    interiors: full.interiors,
    decisions: full.decisions,
    open: full.open,
  };
  const requests: ChatRequest[] = [];
  const client: ChatClient = {
    complete(request) {
      requests.push(request);
      const name = request.tools[0]?.function.name;
      if (name === 'submit_scheme') {
        return Promise.resolve({
          kind: 'ok',
          response: response([call('submit_scheme', '')], 'length'),
        });
      }
      const value = name === 'submit_scheme_core' ? core : name === 'submit_scheme_envelope' ? envelope : interior;
      if (name === undefined) throw new Error('missing tool name');
      return Promise.resolve({ kind: 'ok', response: response([call(name, JSON.stringify(value))]) });
    },
  };

  const result = await proposeScheme(client, exampleRequirements());
  assert.equal(result.value.meta.id, full.meta.id);
  assert.equal(result.value.meta.title, full.meta.title);
  assert.deepEqual(
    requests.map((request) => request.tools[0]?.function.name),
    ['submit_scheme', 'submit_scheme_core', 'submit_scheme_envelope', 'submit_scheme_interior'],
  );
  const envelopeParameters = requests[2]?.tools[0]?.function.parameters;
  assert.ok(envelopeParameters !== undefined);
  assert.equal(envelopeParameters['additionalProperties'], false);
  assert.deepEqual(Object.keys(envelopeParameters['properties'] as Record<string, unknown>).sort(), [
    'circulation',
    'elements',
    'facades',
    'materials',
    'openings',
    'roof',
    'structure',
  ]);
});

test('envelope 零面积 element bounds 在本地确定性修复，不再整阶段重试', async () => {
  const full = exampleScheme();
  const core = {
    meta: full.meta,
    site: full.site,
    levels: full.levels,
    spaces: full.spaces,
    budget: full.budget,
    forbidden: full.forbidden,
  };
  const envelope = {
    elements: full.elements.map((element, index) =>
      index === 1
        ? {
            ...element,
            bounds: {
              min: element.bounds.min,
              max: [element.bounds.max[0], element.bounds.max[1], element.bounds.min[2]],
            },
          }
        : element,
    ),
    openings: full.openings,
    circulation: full.circulation,
    structure: full.structure,
    roof: full.roof,
    facades: full.facades,
    materials: full.materials,
  };
  const interior = {
    details: full.details,
    interiors: full.interiors,
    decisions: full.decisions,
    open: full.open,
  };
  let envelopeCalls = 0;
  const client: ChatClient = {
    complete(request) {
      const name = request.tools[0]?.function.name;
      if (name === 'submit_scheme') {
        return Promise.resolve({
          kind: 'ok',
          response: response([call('submit_scheme', '')], 'length'),
        });
      }
      if (name === REPAIR_SCHEME_TOOL_NAME) {
        return Promise.resolve({
          kind: 'ok',
          response: response([call(name, JSON.stringify({ patches: [] }))]),
        });
      }
      if (name === 'submit_scheme_core') {
        return Promise.resolve({ kind: 'ok', response: response([call(name, JSON.stringify(core))]) });
      }
      if (name === 'submit_scheme_envelope') {
        envelopeCalls += 1;
        return Promise.resolve({ kind: 'ok', response: response([call(name, JSON.stringify(envelope))]) });
      }
      if (name === 'submit_scheme_interior') {
        return Promise.resolve({ kind: 'ok', response: response([call(name, JSON.stringify(interior))]) });
      }
      throw new Error(`未知工具 ${String(name)}`);
    },
  };

  const result = await proposeScheme(client, exampleRequirements());
  assert.equal(envelopeCalls, 1);
  assert.equal(result.value.elements[1]?.bounds.max[2], 5);
  const repairs = result.repairs;
  assert.ok(repairs !== undefined);
  assert.deepEqual(
    repairs.map((item) => item.path),
    ['elements.1.bounds'],
  );
  const repair = repairs[0];
  assert.ok(repair !== undefined);
  assert.deepEqual(repair.axes, ['z']);
});

test('分阶段缺字段时明确失败，不用空数组补齐', async () => {
  const full = exampleScheme();
  const core = {
    meta: full.meta,
    site: full.site,
    levels: full.levels,
    spaces: full.spaces,
    budget: full.budget,
    forbidden: full.forbidden,
  };
  // 故意漏掉 roof：结构 / 屋面不能被默认成空对象，也不能靠重试后“猜一个”通过。
  const envelope = {
    elements: full.elements,
    openings: full.openings,
    circulation: full.circulation,
    structure: full.structure,
    facades: full.facades,
    materials: full.materials,
  };
  const interior = {
    details: full.details,
    interiors: full.interiors,
    decisions: full.decisions,
    open: full.open,
  };
  let envelopeCalls = 0;
  const client: ChatClient = {
    complete(request) {
      const name = request.tools[0]?.function.name;
      if (name === 'submit_scheme') {
        return Promise.resolve({
          kind: 'ok',
          response: response([call('submit_scheme', '')], 'length'),
        });
      }
      if (name === REPAIR_SCHEME_TOOL_NAME) {
        return Promise.resolve({
          kind: 'ok',
          response: response([
            call(
              name,
              JSON.stringify({
                patches: [{ path: '/elements/0/notes', value: '补丁仍未补 roof' }],
              }),
            ),
          ]),
        });
      }
      if (name === 'submit_scheme_core') {
        return Promise.resolve({ kind: 'ok', response: response([call(name, JSON.stringify(core))]) });
      }
      if (name === 'submit_scheme_envelope') {
        envelopeCalls += 1;
        return Promise.resolve({ kind: 'ok', response: response([call(name, JSON.stringify(envelope))]) });
      }
      if (name === 'submit_scheme_interior') {
        return Promise.resolve({ kind: 'ok', response: response([call(name, JSON.stringify(interior))]) });
      }
      throw new Error(`未知工具 ${String(name)}`);
    },
  };

  await assert.rejects(
    () => proposeScheme(client, exampleRequirements()),
    (error: unknown) =>
      error instanceof GenerationError && error.code === 'schema-invalid' && error.message.includes('roof'),
  );
  assert.equal(envelopeCalls, 1);
});

test('方案 decision 的 requirementIds 可以引用 req / con / cap，未知 id 被拒绝', async () => {
  const requirements = RequirementGraph.parse({
    ...exampleRequirements(),
    capabilities: [
      {
        id: 'cap-freeform-shell',
        topic: '自由曲面壳体',
        status: 'partial',
        detail: '当前方块体系只能近似曲面。',
        workaround: '用阶梯式方块逼近。',
        requirementIds: ['req-view'],
      },
    ],
  });
  const decision = {
    id: 'dec-cap-shell',
    topic: '曲面近似',
    choice: '用阶梯方块逼近自由曲面。',
    rationale: '能力项只支持近似曲面。',
    source: 'agent',
    status: 'proposed',
    requirementIds: ['req-view', 'reqc-budget', 'cap-freeform-shell'],
  } as const;
  const valid = { ...exampleScheme(), decisions: [...exampleScheme().decisions, decision] };
  const generated = await proposeScheme(okClient(valid, 'submit_scheme'), requirements);
  assert.deepEqual(generated.value.decisions.at(-1)?.requirementIds, decision.requirementIds);

  await assert.rejects(
    () =>
      proposeScheme(
        okClient(
          { ...valid, decisions: [...exampleScheme().decisions, { ...decision, requirementIds: ['sp-tea'] }] },
          'submit_scheme',
        ),
        requirements,
      ),
    (error: unknown) =>
      error instanceof GenerationError &&
      error.code === 'schema-invalid' &&
      error.message.includes('决策 dec-cap-shell') &&
      error.message.includes('sp-tea'),
  );
});

test('方案 id / revision / sourceRequirements 与要求不一致时拒绝', async () => {
  const shifted = {
    ...exampleScheme(),
    meta: { ...exampleScheme().meta, revision: 2, sourceRequirements: { graphId: 'req-other', revision: 1 } },
  };
  await assert.rejects(
    () => proposeScheme(okClient(shifted, 'submit_scheme'), exampleRequirements()),
    (error: unknown) =>
      error instanceof GenerationError &&
      error.code === 'schema-invalid' &&
      error.message.includes('sourceRequirements'),
  );
  await assert.rejects(
    () =>
      proposeScheme(okClient(exampleScheme(), 'submit_scheme'), exampleRequirements(), { schemeId: 'scheme-other' }),
    (error: unknown) =>
      error instanceof GenerationError && error.code === 'schema-invalid' && error.message.includes('scheme-other'),
  );
});

test('定向修订：previousScheme 要求 id 不变、revision 递增 1', async () => {
  const result = await proposeScheme(okClient(exampleScheme(2), 'submit_scheme'), exampleRequirements(), {
    previousScheme: exampleScheme(),
    feedback: '南侧屋檐再深一点，其他保持原样。',
  });
  assert.equal(result.value.meta.id, 'scheme-tea');
  assert.equal(result.value.meta.revision, 2);

  await assert.rejects(
    () =>
      proposeScheme(okClient(exampleScheme(1), 'submit_scheme'), exampleRequirements(), {
        previousScheme: exampleScheme(),
        feedback: '只改屋檐。',
      }),
    (error: unknown) =>
      error instanceof GenerationError && error.code === 'schema-invalid' && error.message.includes('递增 1'),
  );

  const other = DesignScheme.parse({
    ...exampleScheme(2),
    meta: { ...exampleScheme(2).meta, id: 'scheme-other' },
  });
  await assert.rejects(
    () =>
      proposeScheme(okClient(other, 'submit_scheme'), exampleRequirements(), {
        previousScheme: exampleScheme(),
        feedback: '只改屋檐。',
      }),
    (error: unknown) =>
      error instanceof GenerationError && error.code === 'schema-invalid' && error.message.includes('scheme-other'),
  );
});

test('失败分类：无 tool_call、多个 tool_call、错误工具、非法 JSON、schema 不通过', async () => {
  const cases: readonly { readonly response: ChatResponse; readonly code: string }[] = [
    { response: response([], 'stop', '抱歉，我不能提交。'), code: 'no-tool-call' },
    {
      response: response([
        call('submit_requirements', JSON.stringify(exampleRequirements())),
        call('submit_requirements', JSON.stringify(exampleRequirements())),
      ]),
      code: 'multiple-tool-calls',
    },
    {
      response: response([call('submit_scheme', JSON.stringify(exampleRequirements()))]),
      code: 'unexpected-tool',
    },
    { response: response([call('submit_requirements', '{not-json')]), code: 'invalid-json' },
    { response: response([call('submit_requirements', JSON.stringify({ id: 'req-x' }))]), code: 'schema-invalid' },
  ];
  for (const item of cases) {
    await assert.rejects(
      () => extractRequirements(responseClient(item.response), { userText: '测试' }),
      (error: unknown) => error instanceof GenerationError && error.code === item.code,
      item.code,
    );
  }
});

test('模型拒绝 / 截断 / 调用方取消 / 请求失败都有可读错误', async () => {
  await assert.rejects(
    () => extractRequirements(responseClient(response([], 'content_filter')), { userText: '测试' }),
    (error: unknown) => error instanceof GenerationError && error.code === 'model-refusal',
  );
  await assert.rejects(
    () => extractRequirements(responseClient(response([], 'length')), { userText: '测试' }),
    (error: unknown) => error instanceof GenerationError && error.code === 'truncated',
  );
  const aborted: ChatClient = {
    complete() {
      return Promise.resolve({
        kind: 'aborted-by-caller',
        partial: { content: '', reasoning: '', arguments: [], timing: { firstByteMs: null, totalMs: 1 } },
      });
    },
  };
  await assert.rejects(
    () => extractRequirements(aborted, { userText: '测试' }),
    (error: unknown) => error instanceof GenerationError && error.code === 'aborted',
  );
  const failed: ChatClient = {
    complete() {
      return Promise.resolve({
        kind: 'failed',
        failure: {
          class: 'http',
          code: 'http_4xx',
          status: 400,
          retriable: false,
          message: 'HTTP 400：请求被拒绝',
        },
      });
    },
  };
  await assert.rejects(
    () => extractRequirements(failed, { userText: '测试' }),
    (error: unknown) =>
      error instanceof GenerationError && error.code === 'request-failed' && error.message.includes('HTTP 400'),
  );
});

test('parseToolSubmission 可供 mock / 记录路径复用，且不猜结果', () => {
  const requirements = parseToolSubmission(
    response([call('submit_requirements', JSON.stringify(exampleRequirements()))]),
    'submit_requirements',
    RequirementGraph,
  );
  assert.equal(requirements.id, 'req-tea');
  const scheme = parseToolSubmission(
    response([call('submit_scheme', JSON.stringify(exampleScheme()))]),
    'submit_scheme',
    DesignScheme,
  );
  assert.equal(scheme.meta.id, 'scheme-tea');
  assert.throws(
    () =>
      parseToolSubmission(
        response([call('submit_scheme', JSON.stringify({ meta: { id: 'scheme-x' } }))]),
        'submit_scheme',
        DesignScheme,
      ),
    (error: unknown) => error instanceof GenerationError && error.code === 'schema-invalid',
  );
});
