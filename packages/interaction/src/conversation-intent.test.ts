import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatClient } from '@pg/llm/client';
import type { ChatRequest, ChatResponse, Usage } from '@pg/llm/schema';

import type { BuildBrief } from './build.ts';
import { runDesignConversation } from './conversation.ts';
import type { ConversationArtifactPaths, ConversationIO, ConversationStorage } from './conversation.ts';
import { exampleIntent } from './example-intent.ts';
import { exampleRequirements } from './example-requirements.ts';
import { compileDesignReport } from './report.ts';
import { renderPreviewBundle } from './preview.ts';
import type { SessionState } from './session.ts';
import type { DesignIntent } from './design-intent.ts';
import type { RequirementGraph } from './requirements.ts';

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
        { id: `call-${toolName}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(value) } },
      ],
    },
    rawArguments: [],
    finishReason: 'tool_calls',
    usage: USAGE,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

function contentResponse(name: string, value: unknown): ChatResponse {
  return {
    id: `fake-${name}`,
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

function fakeIntentClient(
  requirements: readonly RequirementGraph[],
  intents: readonly DesignIntent[],
  requests: ChatRequest[] = [],
): ChatClient {
  const graphQueue = [...requirements];
  const intentQueue = [...intents];
  return {
    complete(request) {
      requests.push(request);
      const name = request.tools[0]?.function.name;
      if (name === 'submit_requirements') {
        const value = graphQueue.shift();
        if (value === undefined) return Promise.reject(new Error('fake client: 需求脚本已用完'));
        return Promise.resolve({ kind: 'ok', response: toolResponse(name, value) });
      }
      if (name === 'submit_intent') {
        const value = intentQueue.shift();
        if (value === undefined) return Promise.reject(new Error('fake client: intent 脚本已用完'));
        return Promise.resolve({ kind: 'ok', response: toolResponse(name, value) });
      }
      if (request.tools.length === 0 && request.response_format?.type === 'json_object') {
        const value = intentQueue.shift();
        if (value === undefined) return Promise.reject(new Error('fake client: intent 脚本已用完'));
        return Promise.resolve({ kind: 'ok', response: contentResponse('submit_intent', value) });
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

interface MemoryStorage extends ConversationStorage {
  readonly saves: SessionState[];
  readonly briefs: BuildBrief[];
  readonly artifactIntents: (DesignIntent | undefined)[];
  readonly paths: ConversationArtifactPaths[];
}

function memoryStorage(): MemoryStorage {
  const saves: SessionState[] = [];
  const briefs: BuildBrief[] = [];
  const artifactIntents: (DesignIntent | undefined)[] = [];
  const paths: ConversationArtifactPaths[] = [];
  return {
    saves,
    briefs,
    artifactIntents,
    paths,
    save(state) {
      saves.push(state);
      return Promise.resolve();
    },
    writeArtifacts(brief, intent) {
      briefs.push(brief);
      artifactIntents.push(intent);
      const value: ConversationArtifactPaths = {
        sessionDir: '.work/sessions/fake-intent',
        design: '.work/sessions/fake-intent/design.md',
        task: '.work/sessions/fake-intent/build-task.md',
        spec: '.work/sessions/fake-intent/build-spec.json',
        gates: '.work/sessions/fake-intent/gates.json',
        promptMeta: '.work/sessions/fake-intent/prompt-meta.json',
        ...(intent === undefined ? {} : { designIntent: '.work/sessions/fake-intent/design-intent.json' }),
      };
      paths.push(value);
      return Promise.resolve(value);
    },
  };
}

test('默认 intent：需求 → submit_intent → expand → lint → 确认 → design-intent.json', async () => {
  const requirements = exampleRequirements();
  const intent = exampleIntent();
  const requested: ChatRequest[] = [];
  const io = fakeIO({ confirms: [true] });
  const storage = memoryStorage();
  const result = await runDesignConversation(
    fakeIntentClient([requirements], [intent], requested),
    { sessionId: 'ses-intent-direct', task: '在村口做一间小茶室。', schemeId: 'scheme-tea' },
    io,
    { storage },
  );

  assert.equal(result.brief === null, false);
  assert.equal(result.scheme.meta.id, 'scheme-tea');
  assert.equal(result.scheme.meta.revision, 1);
  const intents = result.state.intents ?? [];
  assert.equal(intents.length, 1);
  assert.deepEqual(intents[0], intent);
  assert.equal(storage.artifactIntents[0]?.meta.title, '稻田茶亭');
  assert.ok(storage.paths[0]?.designIntent?.endsWith('design-intent.json'));
  assert.match(result.brief?.designMarkdown ?? '', /中央长桌/);
  assert.match(compileDesignReport(result.scheme, requirements), /室内/);
  assert.ok(renderPreviewBundle(result.scheme).files.length >= 5);

  const submit = requested.find((request) => request.tools[0]?.function.name === 'submit_intent');
  assert.ok(submit !== undefined);
  assert.ok((submit.max_tokens ?? 0) >= 16_384);
  const properties = (submit.tools[0]?.function.parameters as { readonly properties: Record<string, unknown> })
    .properties;
  assert.deepEqual(Object.keys(properties).sort(), [
    'decisions',
    'envelope',
    'facades',
    'furniture',
    'materials',
    'meta',
    'open',
    'openings',
    'program',
    'roof',
    'site',
    'structure',
  ]);
  assert.equal(Object.hasOwn(properties, 'elements'), false);
});

test('intent 修订：revision+1、旧版本保留、未点名区域不变', async () => {
  const requirements = exampleRequirements();
  const first = exampleIntent();
  const revised = {
    ...structuredClone(first),
    meta: { ...first.meta, concept: `${first.meta.concept}（南侧屋檐再加深一点）` },
    roof: { ...first.roof, overhang: first.roof.overhang + 1 },
  } satisfies DesignIntent;
  const requested: ChatRequest[] = [];
  const io = fakeIO({ answers: ['南侧屋檐再深一点，其他保持原样。'], confirms: [false, true] });
  const storage = memoryStorage();
  const result = await runDesignConversation(
    fakeIntentClient([requirements], [first, revised], requested),
    { sessionId: 'ses-intent-revise', task: '在村口做一间小茶室。', schemeId: 'scheme-tea' },
    io,
    { storage },
  );

  assert.equal(result.scheme.meta.revision, 2);
  assert.equal(result.state.designs.length, 2);
  assert.equal(result.state.intents?.length, 2);
  const [previousDesign, currentDesign] = result.state.designs;
  assert.equal(previousDesign!.meta.revision, 1);
  assert.equal(previousDesign!.meta.status, 'superseded');
  assert.equal(currentDesign!.meta.revision, 2);
  assert.equal(currentDesign!.meta.status, 'confirmed');
  assert.deepEqual(
    currentDesign!.spaces.map((space) => space.id),
    previousDesign!.spaces.map((space) => space.id),
  );

  const [firstIntent, secondIntent] = result.state.intents ?? [];
  assert.deepEqual(firstIntent, first);
  assert.equal(secondIntent!.roof.overhang, first.roof.overhang + 1);
  assert.match(secondIntent!.meta.concept, /屋檐再加深/);
  assert.equal(secondIntent!.program.rooms[0]!.rect.z[1], first.program.rooms[0]!.rect.z[1]);
  assert.equal(storage.artifactIntents[0], secondIntent);
  assert.equal(result.brief?.spec.schemeRevision, 2);

  const submitRequests = requested.filter((request) => request.tools[0]?.function.name === 'submit_intent');
  assert.equal(submitRequests.length, 2);
  const revisionUser = submitRequests[1]?.messages.find((message) => message.role === 'user')?.content;
  assert.equal(typeof revisionUser, 'string');
  const revisionText = typeof revisionUser === 'string' ? revisionUser : JSON.stringify(revisionUser);
  assert.match(revisionText, /上一版 DesignIntent/);
  assert.match(revisionText, /南侧屋檐再深一点/);
  assert.match(revisionText, /未点名区域/);
});
