import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatClient } from '@pg/llm/client';
import type { ChatRequest, ChatResponse, ToolCall, Usage } from '@pg/llm/schema';

import { exampleRequirements } from './example-requirements.ts';
import { exampleScheme } from './example.ts';
import {
  extractRequirements,
  GenerationError,
  proposeScheme,
  proposeSchemeStaged,
  REPAIR_REQUIREMENTS_TOOL_NAME,
  REPAIR_SCHEME_TOOL_NAME,
} from './generate.ts';
import { applyRepairPatches } from './repair.ts';

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

function scriptedClient(responses: readonly ChatResponse[], requests: ChatRequest[] = []): ChatClient {
  let index = 0;
  return {
    complete(request) {
      requests.push(request);
      const result = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (result === undefined) throw new Error('missing scripted response');
      return Promise.resolve({ kind: 'ok', response: result });
    },
  };
}

test('submit_requirements 的 schema-invalid 用 repair_requirements patch 修复，con-* / cap-* 决策引用在修正图中通过', async () => {
  const base = exampleRequirements();
  const zeroZone = {
    id: 'reqz-zero',
    name: '零面积占位',
    kind: 'other',
    bounds: { min: [0, 0, 0], max: [0, 1, 0] },
    notes: null,
  } as const;
  const invalid = {
    ...base,
    site: { ...base.site!, outdoorZones: [zeroZone] },
    decisions: [
      ...base.decisions,
      {
        id: 'dec-site-assumption',
        topic: '场地假设',
        choice: '按约 20m×15m 的矩形地块控制体量。',
        rationale: '场地尺寸未给出，先按建议默认。',
        source: 'agent',
        status: 'proposed',
        requirementIds: ['con-site-envelope'],
      },
      {
        id: 'dec-roof-pitch-standard',
        topic: '屋面坡度',
        choice: '按常规坡度控制。',
        rationale: '能力项只支持近似曲面。',
        source: 'agent',
        status: 'proposed',
        requirementIds: ['cap-freeform-shell'],
      },
    ],
  };
  const requests: ChatRequest[] = [];
  const client = scriptedClient(
    [
      response([call('submit_requirements', JSON.stringify(invalid))]),
      response([
        call(
          REPAIR_REQUIREMENTS_TOOL_NAME,
          JSON.stringify({
            patches: [
              {
                path: '/site/outdoorZones/0/bounds',
                value: { min: [0, 0, 0], max: [4, 1, 4] },
              },
              {
                path: '/constraints/-',
                op: 'add',
                value: {
                  id: 'con-site-envelope',
                  text: '按约 20m×15m 的场地假设控制体量。',
                  kind: 'dimension',
                  source: 'agent',
                  hard: false,
                  value: null,
                },
              },
              {
                path: '/capabilities/-',
                op: 'add',
                value: {
                  id: 'cap-freeform-shell',
                  topic: '自由曲面壳体',
                  status: 'partial',
                  detail: '当前方块体系只能近似曲面。',
                  workaround: '用阶梯式方块逼近。',
                  requirementIds: ['req-view'],
                },
              },
            ],
          }),
        ),
      ]),
    ],
    requests,
  );

  const generated = await extractRequirements(client, { userText: '按真实失败样例修复' });
  assert.equal(generated.value.id, base.id);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    generated.value.decisions.find((decision) => decision.id === 'dec-site-assumption')?.requirementIds,
    ['con-site-envelope'],
  );
  assert.deepEqual(
    generated.value.decisions.find((decision) => decision.id === 'dec-roof-pitch-standard')?.requirementIds,
    ['cap-freeform-shell'],
  );
  assert.deepEqual(
    generated.patchRepairs?.map((patch) => patch.path),
    ['/site/outdoorZones/0/bounds', '/constraints/-', '/capabilities/-'],
  );

  const repairRequest = requests[1];
  assert.ok(repairRequest !== undefined);
  assert.equal(repairRequest.tools[0]?.function.name, REPAIR_REQUIREMENTS_TOOL_NAME);
  assert.ok((repairRequest.max_tokens ?? 0) >= 16_384);
  assert.deepEqual(repairRequest.thinking, { type: 'enabled' });
  const repairUser = repairRequest.messages.at(-1);
  assert.ok(repairUser !== undefined);
  assert.equal(repairUser.role, 'user');
  assert.ok(typeof repairUser.content === 'string');
  assert.match(repairUser.content, /site\/outdoorZones\/0\/bounds/);
  assert.match(repairUser.content, /con-site-envelope/);
  assert.match(repairUser.content, /cap-freeform-shell/);
  assert.match(repairUser.content, /只返回 patch/);
});

test('requirements patch 成功：只替换失败字段，不重写整份图', async () => {
  const invalid = { ...exampleRequirements(), summary: '' };
  const requests: ChatRequest[] = [];
  const client = scriptedClient(
    [
      response([call('submit_requirements', JSON.stringify(invalid))]),
      response([
        call(
          REPAIR_REQUIREMENTS_TOOL_NAME,
          JSON.stringify({ patches: [{ path: '/summary', value: '补足后的需求摘要。' }] }),
        ),
      ]),
    ],
    requests,
  );

  const generated = await extractRequirements(client, { userText: '测试 patch 修复' });
  assert.equal(generated.value.id, 'req-tea');
  assert.equal(generated.value.summary, '补足后的需求摘要。');
  assert.equal(requests.length, 2);
  assert.deepEqual(generated.patchRepairs, [{ path: '/summary', op: 'replace' }]);
  const repairUser = requests[1]?.messages.at(-1);
  assert.ok(repairUser !== undefined);
  assert.equal(repairUser.role, 'user');
  assert.ok(typeof repairUser.content === 'string');
  assert.match(repairUser.content, /\/summary/);
  assert.match(repairUser.content, /只返回 patch/);
});

test('requirements repair 路径只归一 revision / id 一次，warning 不丢', async () => {
  const invalid = { ...exampleRequirements(), id: 'req-model-renamed', revision: 4, summary: '' };
  const requests: ChatRequest[] = [];
  const client = scriptedClient(
    [
      response([call('submit_requirements', JSON.stringify(invalid))]),
      response([
        call(
          REPAIR_REQUIREMENTS_TOOL_NAME,
          JSON.stringify({ patches: [{ path: '/summary', value: '补足后的需求摘要。' }] }),
        ),
      ]),
    ],
    requests,
  );

  const generated = await extractRequirements(client, {
    userText: '测试 repair 不重复递增 revision。',
    existingRequirements: exampleRequirements(2),
  });
  assert.equal(generated.value.id, 'req-tea');
  assert.equal(generated.value.revision, 3);
  assert.equal(generated.value.summary, '补足后的需求摘要。');
  assert.deepEqual(
    generated.warnings?.map((warning) => warning.code),
    ['requirements-revision-normalized', 'requirements-id-normalized'],
  );
  assert.deepEqual(generated.patchRepairs, [{ path: '/summary', op: 'replace' }]);
  assert.equal(requests.length, 2);
  const repairUser = requests[1]?.messages.at(-1);
  assert.ok(repairUser !== undefined);
  assert.equal(repairUser.role, 'user');
  assert.ok(typeof repairUser.content === 'string');
  assert.match(repairUser.content, /"revision":\s*3/);
  assert.match(repairUser.content, /"id":\s*"req-tea"/);
});

test('requirements patch 为空 / 非法 path / 修复后仍失败都明确报错', async () => {
  const cases = [
    { patches: [], pattern: /patches/ },
    { patches: [{ path: '/requirements/0/../id', value: 'x' }], pattern: /JSON Pointer/ },
    {
      patches: [{ path: '/requirements/0/text', value: '改过文本，但 summary 仍为空' }],
      pattern: /summary/,
    },
  ] as const;

  for (const item of cases) {
    const requests: ChatRequest[] = [];
    const client = scriptedClient(
      [
        response([call('submit_requirements', JSON.stringify({ ...exampleRequirements(), summary: '' }))]),
        response([call(REPAIR_REQUIREMENTS_TOOL_NAME, JSON.stringify({ patches: item.patches }))]),
      ],
      requests,
    );
    await assert.rejects(
      () => extractRequirements(client, { userText: '测试无效 patch' }),
      (error: unknown) =>
        error instanceof GenerationError && error.code === 'schema-invalid' && item.pattern.test(error.message),
    );
    assert.equal(requests.length, 2);
  }
});

test('完整 submit_scheme 漏 roof 时用 repair_scheme patch 定点补齐', async () => {
  const full = exampleScheme();
  const missing: Record<string, unknown> = { ...full };
  delete missing['roof'];
  const requests: ChatRequest[] = [];
  const client = scriptedClient(
    [
      response([call('submit_scheme', JSON.stringify(missing))]),
      response([call(REPAIR_SCHEME_TOOL_NAME, JSON.stringify({ patches: [{ path: '/roof', value: full.roof }] }))]),
    ],
    requests,
  );

  const result = await proposeScheme(client, exampleRequirements());
  assert.equal(result.value.roof.form, full.roof.form);
  assert.deepEqual(result.patchRepairs, [{ path: '/roof', op: 'add' }]);
  assert.deepEqual(
    requests.map((request) => request.tools[0]?.function.name),
    ['submit_scheme', REPAIR_SCHEME_TOOL_NAME],
  );
  const repairUser = requests[1]?.messages.at(-1);
  assert.ok(repairUser !== undefined);
  assert.equal(repairUser.role, 'user');
  assert.ok(typeof repairUser.content === 'string');
  assert.match(repairUser.content, /\/roof/);
  assert.match(repairUser.content, /meta \/ site \/ levels/);
});

test('完整 submit_scheme patch 应用后仍失败时直接报错，不回退 staged', async () => {
  const full = exampleScheme();
  const missing: Record<string, unknown> = { ...full };
  delete missing['roof'];
  const requests: ChatRequest[] = [];
  const client = scriptedClient(
    [
      response([call('submit_scheme', JSON.stringify(missing))]),
      response([
        call(
          REPAIR_SCHEME_TOOL_NAME,
          JSON.stringify({ patches: [{ path: '/meta/title', value: '改了标题但 roof 仍缺' }] }),
        ),
      ]),
    ],
    requests,
  );

  await assert.rejects(
    () => proposeScheme(client, exampleRequirements()),
    (error: unknown) =>
      error instanceof GenerationError &&
      error.repairFailed &&
      error.code === 'schema-invalid' &&
      error.message.includes('roof'),
  );
  assert.deepEqual(
    requests.map((request) => request.tools[0]?.function.name),
    ['submit_scheme', REPAIR_SCHEME_TOOL_NAME],
  );
});

test('stage envelope 零面积 opening 通过 repair_scheme patch 修复，不重写 core', async () => {
  const full = exampleScheme();
  const core = {
    meta: full.meta,
    site: full.site,
    levels: full.levels,
    spaces: full.spaces,
    budget: full.budget,
    forbidden: full.forbidden,
  };
  const opening = full.openings[0];
  assert.ok(opening !== undefined);
  const brokenOpening = {
    ...opening,
    bounds: {
      min: opening.bounds.min,
      max: [opening.bounds.max[0], opening.bounds.max[1], opening.bounds.min[2]],
    },
  };
  const envelope = {
    elements: full.elements,
    openings: [brokenOpening, ...full.openings.slice(1)],
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
  let envelopeCalls = 0;
  let repairCalls = 0;
  const client: ChatClient = {
    complete(request) {
      requests.push(request);
      const name = request.tools[0]?.function.name;
      if (name === 'submit_scheme_core') {
        return Promise.resolve({ kind: 'ok', response: response([call(name, JSON.stringify(core))]) });
      }
      if (name === 'submit_scheme_envelope') {
        envelopeCalls += 1;
        return Promise.resolve({ kind: 'ok', response: response([call(name, JSON.stringify(envelope))]) });
      }
      if (name === REPAIR_SCHEME_TOOL_NAME) {
        repairCalls += 1;
        return Promise.resolve({
          kind: 'ok',
          response: response([
            call(name, JSON.stringify({ patches: [{ path: '/openings/0/bounds', value: opening.bounds }] })),
          ]),
        });
      }
      if (name === 'submit_scheme_interior') {
        return Promise.resolve({ kind: 'ok', response: response([call(name, JSON.stringify(interior))]) });
      }
      throw new Error(`未知工具 ${String(name)}`);
    },
  };

  const result = await proposeSchemeStaged(client, exampleRequirements());
  assert.equal(envelopeCalls, 1);
  assert.equal(repairCalls, 1);
  assert.deepEqual(result.value.openings[0]?.bounds, opening.bounds);
  assert.deepEqual(result.patchRepairs, [{ path: '/openings/0/bounds', op: 'replace' }]);
  assert.deepEqual(
    requests.map((request) => request.tools[0]?.function.name),
    ['submit_scheme_core', 'submit_scheme_envelope', REPAIR_SCHEME_TOOL_NAME, 'submit_scheme_interior'],
  );
});

test('stage patch 修改非本阶段字段被拒绝，不影响已完成 core', async () => {
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
    elements: full.elements,
    openings: full.openings,
    circulation: full.circulation,
    structure: full.structure,
    facades: full.facades,
    materials: full.materials,
  };
  const requests: ChatRequest[] = [];
  const client = scriptedClient(
    [
      response([call('submit_scheme_core', JSON.stringify(core))]),
      response([call('submit_scheme_envelope', JSON.stringify(envelope))]),
      response([
        call(REPAIR_SCHEME_TOOL_NAME, JSON.stringify({ patches: [{ path: '/meta/title', value: '越界标题' }] })),
      ]),
    ],
    requests,
  );

  await assert.rejects(
    () => proposeSchemeStaged(client, exampleRequirements()),
    (error: unknown) =>
      error instanceof GenerationError &&
      error.code === 'schema-invalid' &&
      error.message.includes('不属于本次允许字段') &&
      error.message.includes('meta'),
  );
  assert.equal(requests.length, 3);
  assert.equal(requests[2]?.tools[0]?.function.name, REPAIR_SCHEME_TOOL_NAME);
});

test('applyRepairPatches 深拷贝并支持 replace / add / remove，拒绝越界与无变化', () => {
  const base = { a: { b: 1 }, list: [1, 2], keep: true };
  const result = applyRepairPatches(
    base,
    [
      { path: '/a/b', value: 2 },
      { path: '/list/-', op: 'add', value: 3 },
      { path: '/keep', op: 'remove' },
      { path: '/a/c', value: 'x' },
    ],
    ['a', 'list', 'keep'],
  );
  assert.deepEqual(result.value, { a: { b: 2, c: 'x' }, list: [1, 2, 3] });
  assert.deepEqual(result.applied, [
    { path: '/a/b', op: 'replace' },
    { path: '/list/-', op: 'add' },
    { path: '/keep', op: 'remove' },
    { path: '/a/c', op: 'add' },
  ]);
  assert.equal(base.a.b, 1);
  assert.throws(() => applyRepairPatches(base, [{ path: '/a/b', value: 1 }], ['a']), /没有改变任何字段/);
  assert.throws(() => applyRepairPatches(base, [{ path: '/meta/x', value: 1 }], ['a']), /不属于本次允许字段/);
  assert.throws(() => applyRepairPatches(base, [{ path: '/a/../x', value: 1 }], ['a']), /JSON Pointer/);
  assert.throws(() => applyRepairPatches(base, [{ path: '/a/__proto__/x', value: 1 }], ['a']), /JSON Pointer/);
});
