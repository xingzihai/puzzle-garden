import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatClient } from '@pg/llm/client';
import type { ChatResponse, Usage } from '@pg/llm/schema';

import type { BuildBrief } from './build.ts';
import { runDesignConversation } from './conversation.ts';
import type { ConversationIO, ConversationStorage } from './conversation.ts';
import { exampleRequirements, exampleScheme } from './example.ts';
import { GenerationError } from './generate.ts';
import { RequirementGraph } from './requirements.ts';
import { DesignScheme } from './scheme.ts';
import { createSession, reduceSession } from './session.ts';
import type { SessionState } from './session.ts';
import type { ArtifactPaths } from './store.ts';

const USAGE: Usage = {
  prompt_tokens: 10,
  completion_tokens: 10,
  total_tokens: 20,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 10,
};

function toolResponse(toolName: string, value: unknown): ChatResponse {
  return {
    id: `fake-${toolName}`,
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
    usage: USAGE,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

function fakeClient(script: {
  readonly requirements: readonly RequirementGraph[];
  readonly schemes: readonly DesignScheme[];
}): ChatClient {
  const requirements = [...script.requirements];
  const schemes = [...script.schemes];
  return {
    complete(request) {
      const name = request.tools[0]?.function.name;
      if (name === 'submit_requirements') {
        const value = requirements.shift();
        if (value === undefined) return Promise.reject(new Error('fake client: 需求脚本已用完'));
        return Promise.resolve({ kind: 'ok', response: toolResponse(name, value) });
      }
      if (name === 'submit_scheme') {
        const value = schemes.shift();
        if (value === undefined) return Promise.reject(new Error('fake client: 方案脚本已用完'));
        return Promise.resolve({ kind: 'ok', response: toolResponse(name, value) });
      }
      return Promise.reject(new Error(`fake client: 未知工具 ${String(name)}`));
    },
  };
}

interface FakeIO extends ConversationIO {
  readonly said: string[];
  readonly asked: string[];
}

function fakeIO(input: { readonly answers?: readonly string[]; readonly confirms?: readonly boolean[] }): FakeIO {
  const answers = [...(input.answers ?? [])];
  const confirms = [...(input.confirms ?? [])];
  const said: string[] = [];
  const asked: string[] = [];
  return {
    said,
    asked,
    say(text) {
      said.push(text);
    },
    ask(question) {
      asked.push(question);
      const value = answers.shift();
      if (value === undefined) return Promise.reject(new Error(`fake IO: 没有回答 ${question}`));
      return Promise.resolve(value);
    },
    confirm(question) {
      asked.push(question);
      const value = confirms.shift();
      if (value === undefined) return Promise.reject(new Error(`fake IO: 没有确认回答 ${question}`));
      return Promise.resolve(value);
    },
  };
}

function askOnlyIO(answers: readonly string[]): FakeIO {
  const queue = [...answers];
  const said: string[] = [];
  const asked: string[] = [];
  return {
    said,
    asked,
    say(text) {
      said.push(text);
    },
    ask(question) {
      asked.push(question);
      const value = queue.shift();
      if (value === undefined) return Promise.reject(new Error(`fake IO: 没有回答 ${question}`));
      return Promise.resolve(value);
    },
  };
}

interface MemoryStorage extends ConversationStorage {
  readonly saves: SessionState[];
  readonly briefs: BuildBrief[];
  readonly artifacts: ArtifactPaths[];
}

function memoryStorage(): MemoryStorage {
  const saves: SessionState[] = [];
  const briefs: BuildBrief[] = [];
  const artifacts: ArtifactPaths[] = [];
  return {
    saves,
    briefs,
    artifacts,
    save(state) {
      saves.push(state);
      return Promise.resolve();
    },
    writeArtifacts(brief) {
      briefs.push(brief);
      const paths: ArtifactPaths = {
        sessionDir: '.work/sessions/fake',
        design: '.work/sessions/fake/design.md',
        task: '.work/sessions/fake/build-task.md',
        spec: '.work/sessions/fake/build-spec.json',
        gates: '.work/sessions/fake/gates.json',
        promptMeta: '.work/sessions/fake/prompt-meta.json',
      };
      artifacts.push(paths);
      return Promise.resolve(paths);
    },
  };
}

function graphWithQuestions(): RequirementGraph {
  return RequirementGraph.parse({
    ...exampleRequirements(),
    ambiguities: [
      {
        id: 'amb-entry',
        question: '入口放在哪一侧？',
        options: ['北侧村道', '南侧稻田'],
        impact: 'high',
        suggestedDefault: '北侧村道',
        status: 'open',
        requirementIds: [],
      },
      {
        id: 'amb-counter',
        question: '需要柜台吗？',
        options: ['需要', '不需要'],
        impact: 'medium',
        suggestedDefault: null,
        status: 'open',
        requirementIds: [],
      },
    ],
  });
}

function resolvedGraph(base: RequirementGraph, revision: number): RequirementGraph {
  return RequirementGraph.parse({
    ...base,
    revision,
    ambiguities: base.ambiguities.map((item) => ({ ...item, status: 'resolved' as const })),
  });
}

function schemeFor(graph: RequirementGraph, revision = 1, meta: Partial<DesignScheme['meta']> = {}): DesignScheme {
  const base = exampleScheme(revision);
  return DesignScheme.parse({
    ...base,
    meta: {
      ...base.meta,
      revision,
      sourceRequirements: { graphId: graph.id, revision: graph.revision },
      ...meta,
    },
  });
}

test('fake：无澄清问题 → 直接设计 → 确认 → artifacts 与 session 保存', async () => {
  const graph = exampleRequirements();
  const scheme = schemeFor(graph);
  const io = askOnlyIO(['yes']);
  const storage = memoryStorage();
  const result = await runDesignConversation(
    fakeClient({ requirements: [graph], schemes: [scheme] }),
    { sessionId: 'ses-conv-direct', task: '在村口做一间小茶室。' },
    io,
    { storage, designMode: 'legacy' },
  );

  assert.equal(result.brief === null, false);
  assert.equal(result.artifacts === null, false);
  assert.equal(result.state.stage, 'compile');
  assert.equal(result.state.confirmedDesignRevision, 1);
  assert.equal(result.questions.length, 0);
  assert.equal(result.answers.length, 0);
  assert.equal(result.revisions, 1);
  assert.equal(storage.artifacts.length, 1);
  assert.equal(
    storage.saves.some((state) => state.stage === 'confirm'),
    true,
  );
  assert.equal(
    storage.saves.some((state) => state.stage === 'compile'),
    true,
  );
  const eventTypes = result.state.events.map((event) => event.type);
  for (const type of [
    'requirements.version',
    'clarify.skipped',
    'design.version',
    'design.check',
    'design.confirmed',
    'brief.compiled',
  ]) {
    assert.ok(eventTypes.includes(type as (typeof eventTypes)[number]), type);
  }
  assert.equal(io.asked.length, 1);
  assert.match(io.asked[0] ?? '', /是否确认方案/);
});

test('fake：2 个问题 → 用户回答 → 需求 revision+1 → 设计', async () => {
  const first = graphWithQuestions();
  const second = resolvedGraph(first, 2);
  const io = fakeIO({ answers: ['北侧村道', '需要一个小柜台'], confirms: [true] });
  const storage = memoryStorage();
  const result = await runDesignConversation(
    fakeClient({ requirements: [first, second], schemes: [schemeFor(second)] }),
    { sessionId: 'ses-conv-questions', task: '做一间能坐十个人的茶室。' },
    io,
    { storage, designMode: 'legacy' },
  );

  assert.equal(result.questions.length, 2);
  assert.deepEqual(
    result.answers.map((answer) => answer.questionId),
    ['amb-entry', 'amb-counter'],
  );
  assert.equal(result.state.requirements?.revision, 2);
  assert.equal(result.state.answers.length, 2);
  assert.equal(result.scheme.meta.sourceRequirements.revision, 2);
  assert.equal(result.brief === null, false);
  assert.match(io.asked[0] ?? '', /入口放在哪一侧/);
  assert.match(io.asked[1] ?? '', /需要柜台吗/);
});

test('fake：用户反馈 → 方案 revision+1，旧方案保留且未点名字段不变', async () => {
  const graph = exampleRequirements();
  const first = schemeFor(graph, 1);
  const second = schemeFor(graph, 2, {
    title: '稻田茶亭（深檐）',
    concept: '保留原布局，只加深南侧屋檐并延续木石材质。',
  });
  const io = fakeIO({ answers: ['屋檐再深一点，南侧平台保留'], confirms: [false, true] });
  const storage = memoryStorage();
  const result = await runDesignConversation(
    fakeClient({ requirements: [graph], schemes: [first, second] }),
    { sessionId: 'ses-conv-revise', task: '在村口做一间小茶室。' },
    io,
    { storage, designMode: 'legacy' },
  );

  assert.equal(result.scheme.meta.revision, 2);
  assert.equal(result.revisions, 2);
  assert.equal(result.state.designs.length, 2);
  const [previous, current] = result.state.designs;
  assert.ok(previous !== undefined);
  assert.ok(current !== undefined);
  assert.equal(previous.meta.revision, 1);
  assert.equal(previous.meta.status, 'superseded');
  assert.equal(previous.meta.title, '稻田茶亭');
  assert.equal(current.meta.status, 'confirmed');
  assert.equal(current.meta.id, previous.meta.id);
  assert.deepEqual(
    current.spaces.map((space) => space.id),
    previous.spaces.map((space) => space.id),
  );
  assert.deepEqual(
    current.materials.map((material) => material.block),
    previous.materials.map((material) => material.block),
  );
  assert.ok(
    result.state.events.some(
      (event) => event.type === 'design.revision-requested' && event.reason.includes('屋檐再深一点'),
    ),
  );
  assert.equal(result.state.confirmedDesignRevision, 2);
  assert.equal(result.brief?.spec.schemeRevision, 2);
});

test('fake：lint 失败不确认，用户退出时保存但不写 artifacts', async () => {
  const graph = exampleRequirements();
  const broken = DesignScheme.parse({ ...schemeFor(graph), interiors: [] });
  const io = fakeIO({ answers: ['q'] });
  const storage = memoryStorage();
  const result = await runDesignConversation(
    fakeClient({ requirements: [graph], schemes: [broken] }),
    { sessionId: 'ses-conv-lint', task: '在村口做一间小茶室。' },
    io,
    { storage, designMode: 'legacy' },
  );

  assert.equal(result.brief, null);
  assert.equal(result.artifacts, null);
  assert.equal(result.state.stage, 'design');
  assert.equal(result.state.check?.passed, false);
  assert.equal(result.state.confirmedDesignRevision, null);
  assert.equal(storage.artifacts.length, 0);
  assert.ok(io.said.some((line) => line.includes('确定性检查未通过')));
  assert.equal(
    result.state.events.some((event) => event.type === 'design.confirmed'),
    false,
  );
});

test('fake：两轮澄清仍无答案时按 suggestedDefault 标 assumed 并打印', async () => {
  const first = RequirementGraph.parse({
    ...exampleRequirements(),
    ambiguities: [
      {
        id: 'amb-entry',
        question: '入口放在哪一侧？',
        options: ['北侧村道', '南侧稻田'],
        impact: 'high',
        suggestedDefault: '北侧村道',
        status: 'open',
        requirementIds: [],
      },
    ],
  });
  const second = RequirementGraph.parse({ ...first, revision: 2 });
  const third = RequirementGraph.parse({ ...first, revision: 3 });
  const io = fakeIO({ answers: ['不确定', '还是不确定'], confirms: [true] });
  const result = await runDesignConversation(
    fakeClient({ requirements: [first, second, third], schemes: [schemeFor(third)] }),
    { sessionId: 'ses-conv-defaults', task: '做一间茶室。' },
    io,
    { storage: memoryStorage(), designMode: 'legacy' },
  );

  assert.equal(result.questions.length, 2);
  assert.equal(result.state.requirements?.ambiguities[0]?.status, 'assumed');
  assert.ok(io.said.some((line) => line.includes('assumed')));
  assert.equal(result.scheme.meta.sourceRequirements.revision, 3);
});

test('fake：两轮 clarify 模型乱给 revision/id，宿主每轮只 +1', async () => {
  const first = graphWithQuestions();
  const second = RequirementGraph.parse({ ...graphWithQuestions(), id: 'req-round-two', revision: 4 });
  const third = RequirementGraph.parse({ ...graphWithQuestions(), id: 'req-round-three', revision: 9 });
  const finalGraph = RequirementGraph.parse({ ...first, revision: 3 });
  const io = fakeIO({ answers: ['北侧村道', '需要柜台', '北侧村道', '需要柜台'], confirms: [true] });
  const result = await runDesignConversation(
    fakeClient({ requirements: [first, second, third], schemes: [schemeFor(finalGraph)] }),
    { sessionId: 'ses-conv-clarify-normalize', task: '做一间茶室。' },
    io,
    { storage: memoryStorage(), designMode: 'legacy' },
  );

  assert.equal(result.questions.length, 4);
  const requirements = result.state.requirements;
  assert.ok(requirements !== null);
  assert.equal(requirements.id, 'req-tea');
  assert.equal(requirements.revision, 3);
  assert.deepEqual(
    result.state.events.filter((event) => event.type === 'requirements.version').map((event) => event.revision),
    [1, 2, 3],
  );
  assert.equal(result.scheme.meta.sourceRequirements.revision, 3);
});

test('fake：从 review 恢复，不调用模型即可确认并编译', async () => {
  const graph = exampleRequirements();
  const scheme = schemeFor(graph);
  let state = createSession('ses-conv-resume');
  state = reduceSession(state, { kind: 'recordRequirements', graph });
  state = reduceSession(state, { kind: 'skipClarify' });
  state = reduceSession(state, { kind: 'proposeDesign', scheme });
  state = reduceSession(state, { kind: 'recordCheck', designRevision: 1, passed: true, issues: [] });
  assert.equal(state.stage, 'review');

  const noModel: ChatClient = {
    complete() {
      return Promise.reject(new Error('恢复确认不应调用模型'));
    },
  };
  const storage = memoryStorage();
  const result = await runDesignConversation(
    noModel,
    { sessionId: 'ses-conv-resume', task: '', resume: state },
    fakeIO({ confirms: [true] }),
    { storage, designMode: 'legacy' },
  );

  assert.equal(result.state.stage, 'compile');
  assert.equal(result.brief === null, false);
  assert.equal(storage.artifacts.length, 1);
});

test('GenerationError 不吞：模型没有提交工具结果时原样抛出', async () => {
  const noTool: ChatClient = {
    complete() {
      return Promise.resolve({
        kind: 'ok',
        response: {
          id: 'fake-no-tool',
          model: 'deepseek-flash',
          systemFingerprint: null,
          message: { role: 'assistant', content: '我不想提交。' },
          rawArguments: [],
          finishReason: 'stop',
          usage: USAGE,
          usageMismatch: false,
          timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
        },
      });
    },
  };
  await assert.rejects(
    () =>
      runDesignConversation(noTool, { sessionId: 'ses-conv-error', task: '做一间茶室。' }, fakeIO({ confirms: [] }), {
        storage: memoryStorage(),
        designMode: 'legacy',
      }),
    (error: unknown) => error instanceof GenerationError && error.code === 'no-tool-call',
  );
});
