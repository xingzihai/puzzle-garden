import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatClient } from '@pg/llm/client';
import type { ChatResponse, Usage } from '@pg/llm/schema';

import { exampleRequirements } from './example-requirements.ts';
import { exampleScheme } from './example.ts';
import { askQuestionWithProgress, evaluateSchemeWithProgress, extractWithProgress } from './conversation-progress.ts';
import type { ConversationIO } from './conversation-types.ts';
import type { InteractionProgressEvent } from './generate-intent.ts';
import { createSession, reduceSession } from './session.ts';

const USAGE: Usage = {
  prompt_tokens: 1,
  completion_tokens: 1,
  total_tokens: 2,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 1,
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

function requirementsClient(requirements = exampleRequirements()): ChatClient {
  return {
    complete(request) {
      const name = request.tools[0]?.function.name ?? 'submit_requirements';
      return Promise.resolve({ kind: 'ok', response: toolResponse(name, requirements) });
    },
  };
}

function baseIO(answers: readonly string[]): ConversationIO {
  const queue = [...answers];
  return {
    say() {
      // no-op
    },
    ask() {
      const value = queue.shift();
      return value === undefined ? Promise.reject(new Error('没有回答')) : Promise.resolve(value);
    },
    askQuestion() {
      const value = queue.shift();
      return value === undefined ? Promise.reject(new Error('没有回答')) : Promise.resolve(value);
    },
  };
}

test('extractWithProgress：start / done，失败时发 error', async () => {
  const events: InteractionProgressEvent[] = [];
  const result = await extractWithProgress(requirementsClient(), { userText: '做一间茶室。' }, (event) =>
    events.push(event),
  );
  assert.equal(result.value.id, 'req-tea');
  assert.ok(
    events.some((event) => event.kind === 'stage' && event.stage === 'requirements' && event.status === 'start'),
  );
  assert.ok(
    events.some((event) => event.kind === 'stage' && event.stage === 'requirements' && event.status === 'done'),
  );

  const failed: InteractionProgressEvent[] = [];
  await assert.rejects(
    () =>
      extractWithProgress(
        {
          complete() {
            return Promise.reject(new Error('offline'));
          },
        },
        { userText: '做一间茶室。' },
        (event) => failed.push(event),
      ),
    /offline/,
  );
  assert.ok(failed.some((event) => event.kind === 'stage' && event.status === 'error'));
});

test('extractWithProgress：宿主归一化 warning 进入 requirements done detail', async () => {
  const events: InteractionProgressEvent[] = [];
  const result = await extractWithProgress(
    requirementsClient({ ...exampleRequirements(), revision: 4 }),
    { userText: '首次抽取 revision 4。' },
    (event) => events.push(event),
  );
  assert.equal(result.value.revision, 1);
  const done = events.find(
    (event) => event.kind === 'stage' && event.stage === 'requirements' && event.status === 'done',
  );
  assert.ok(done !== undefined);
  if (done.kind !== 'stage') throw new Error('requirements done 事件类型错误');
  assert.match(done.detail ?? '', /requirements-revision-normalized/);
});

test('askQuestionWithProgress：先发 question，再走 askQuestion / ask', async () => {
  const events: InteractionProgressEvent[] = [];
  const answer = await askQuestionWithProgress(baseIO(['北侧']), { id: 'amb-entry', text: '入口在哪侧？' }, (event) =>
    events.push(event),
  );
  assert.equal(answer, '北侧');
  const question = events.find((event) => event.kind === 'question');
  assert.ok(question !== undefined);
  assert.equal(question.id, 'amb-entry');
});

test('evaluateSchemeWithProgress：lint start / done 并推进 session', () => {
  const requirements = exampleRequirements();
  let state = createSession('ses-progress-unit');
  state = reduceSession(state, { kind: 'userMessage', text: '做一间茶室。' });
  state = reduceSession(state, { kind: 'recordRequirements', graph: requirements });
  state = reduceSession(state, { kind: 'skipClarify' });
  state = reduceSession(state, { kind: 'proposeDesign', scheme: exampleScheme() });
  const events: InteractionProgressEvent[] = [];
  const checked = evaluateSchemeWithProgress(requirements, state, exampleScheme(), (event) => events.push(event));
  assert.equal(checked.state.stage, 'review');
  assert.ok(events.some((event) => event.kind === 'stage' && event.stage === 'lint' && event.status === 'start'));
  assert.ok(events.some((event) => event.kind === 'stage' && event.stage === 'lint' && event.status === 'done'));
});
