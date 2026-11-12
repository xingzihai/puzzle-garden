import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { exampleRequirements, exampleScheme } from '@pg/interaction/example';
import type { ConversationIO } from '@pg/interaction/conversation';
import {
  designConflictsFromWarnings,
  DesignScheme,
  FloorDatumConflict,
  RequirementGraph,
} from '@pg/interaction/schema';
import { createSession, reduceSession } from '@pg/interaction/session';
import { saveSession } from '@pg/interaction/store';
import type { ChatClient } from '@pg/llm/client';
import type { ChatResponse, Usage } from '@pg/llm/schema';

import { ConversationCliError, parsePreloadedAnswers, runConversationMode } from './design-agent-conversation.ts';

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

function fakeClient(requirements: readonly RequirementGraph[], schemes: readonly DesignScheme[]): ChatClient {
  const requirementQueue = [...requirements];
  const schemeQueue = [...schemes];
  return {
    complete(request) {
      const name = request.tools[0]?.function.name;
      if (name === 'submit_requirements') {
        const value = requirementQueue.shift();
        if (value === undefined) return Promise.reject(new Error('fake client: 需求脚本已用完'));
        return Promise.resolve({ kind: 'ok', response: toolResponse(name, value) });
      }
      if (name === 'submit_scheme') {
        const value = schemeQueue.shift();
        if (value === undefined) return Promise.reject(new Error('fake client: 方案脚本已用完'));
        return Promise.resolve({ kind: 'ok', response: toolResponse(name, value) });
      }
      return Promise.reject(new Error(`fake client: 未知工具 ${String(name)}`));
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

function resolved(graph: RequirementGraph, revision: number): RequirementGraph {
  return RequirementGraph.parse({
    ...graph,
    revision,
    ambiguities: graph.ambiguities.map((item) => ({ ...item, status: 'resolved' as const })),
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

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-design-conversation-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('parsePreloadedAnswers 支持字符串数组与 questionId 对象，拒绝混用和重复', () => {
  assert.deepEqual(parsePreloadedAnswers('["北侧","需要"]'), ['北侧', '需要']);
  assert.deepEqual(parsePreloadedAnswers('[{"questionId":"amb-entry","answer":"北侧"}]'), [
    { questionId: 'amb-entry', answer: '北侧' },
  ]);
  assert.throws(() => parsePreloadedAnswers('{"answer":"x"}'), /必须是 JSON 数组/);
  assert.throws(() => parsePreloadedAnswers('["a",{"questionId":"q","answer":"b"}]'), /不能混用/);
  assert.throws(
    () => parsePreloadedAnswers('[{"questionId":"q","answer":"a"},{"questionId":"q","answer":"b"}]'),
    /重复/,
  );
});

test('runConversationMode：fake 回答 + session.json / design.md 落盘', async () => {
  await withTempDir(async (dir) => {
    const lines: string[] = [];
    const result = await runConversationMode(fakeClient([exampleRequirements()], [exampleScheme()]), {
      sessionId: 'ses-cli-direct',
      outDir: dir,
      designMode: 'legacy',
      task: '在村口做一间小茶室。',
      answers: ['yes'],
      feedback: undefined,
      resume: false,
      say: (line) => {
        lines.push(line);
      },
    });
    assert.equal(result.brief === null, false);
    const session = JSON.parse(await readFile(join(dir, 'ses-cli-direct', 'session.json'), 'utf8')) as {
      stage: string;
      confirmedDesignRevision: number;
    };
    assert.equal(session.stage, 'compile');
    assert.equal(session.confirmedDesignRevision, 1);
    assert.match(await readFile(join(dir, 'ses-cli-direct', 'design.md'), 'utf8'), /稻田茶亭/);
    assert.ok(lines.some((line) => line.includes('方案摘要：稻田茶亭')));
  });
});

test('runConversationMode：2 个问题按顺序消耗回答，需求 revision+1', async () => {
  await withTempDir(async (dir) => {
    const first = graphWithQuestions();
    const second = resolved(first, 2);
    const result = await runConversationMode(fakeClient([first, second], [schemeFor(second)]), {
      sessionId: 'ses-cli-questions',
      outDir: dir,
      designMode: 'legacy',
      task: '做一间茶室。',
      answers: ['北侧村道', '需要一个小柜台', 'yes'],
      feedback: undefined,
      resume: false,
      say: () => undefined,
    });
    assert.equal(result.state.requirements?.revision, 2);
    assert.equal(result.answers.length, 2);
    const session = JSON.parse(await readFile(join(dir, 'ses-cli-questions', 'session.json'), 'utf8')) as {
      requirements: { revision: number };
      answers: readonly unknown[];
    };
    assert.equal(session.requirements.revision, 2);
    assert.equal(session.answers.length, 2);
  });
});

test('runConversationMode：questionId 对象形式可用保留 id confirm 回答确认', async () => {
  await withTempDir(async (dir) => {
    const first = graphWithQuestions();
    const second = resolved(first, 2);
    const result = await runConversationMode(fakeClient([first, second], [schemeFor(second)]), {
      sessionId: 'ses-cli-objects',
      outDir: dir,
      designMode: 'legacy',
      task: '做一间茶室。',
      answers: [
        { questionId: 'amb-entry', answer: '南侧稻田' },
        { questionId: 'amb-counter', answer: '需要' },
        { questionId: 'confirm', answer: 'yes' },
      ],
      feedback: undefined,
      resume: false,
      say: () => undefined,
    });
    assert.equal(result.brief === null, false);
    assert.equal(result.answers[0]?.answer, '南侧稻田');
  });
});

test('runConversationMode：--answers 数量不足 / 多出都报错', async () => {
  await withTempDir(async (dir) => {
    const first = graphWithQuestions();
    await assert.rejects(
      () =>
        runConversationMode(fakeClient([first], [exampleScheme()]), {
          sessionId: 'ses-cli-short',
          outDir: dir,
          designMode: 'legacy',
          task: '做一间茶室。',
          answers: ['北侧村道'],
          feedback: undefined,
          resume: false,
          say: () => undefined,
        }),
      (error: unknown) => error instanceof ConversationCliError && error.message.includes('数量不足'),
    );

    await assert.rejects(
      () =>
        runConversationMode(fakeClient([exampleRequirements()], [exampleScheme()]), {
          sessionId: 'ses-cli-extra',
          outDir: dir,
          designMode: 'legacy',
          task: '做一间茶室。',
          answers: ['yes', 'extra'],
          feedback: undefined,
          resume: false,
          say: () => undefined,
        }),
      (error: unknown) => error instanceof ConversationCliError && error.message.includes('多出 1 条'),
    );
  });
});

test('runConversationMode：--resume 读取 session.json、打印当前阶段并继续确认', async () => {
  await withTempDir(async (dir) => {
    const graph = exampleRequirements();
    const scheme = schemeFor(graph);
    let state = createSession('ses-cli-resume');
    state = reduceSession(state, { kind: 'recordRequirements', graph });
    state = reduceSession(state, { kind: 'skipClarify' });
    state = reduceSession(state, { kind: 'proposeDesign', scheme });
    state = reduceSession(state, { kind: 'recordCheck', designRevision: 1, passed: true, issues: [] });
    await saveSession(state, { root: dir });

    const noModel: ChatClient = {
      complete() {
        return Promise.reject(new Error('恢复确认不应调用模型'));
      },
    };
    const lines: string[] = [];
    const result = await runConversationMode(noModel, {
      sessionId: 'ses-cli-resume',
      outDir: dir,
      designMode: 'legacy',
      task: '',
      answers: ['yes'],
      feedback: undefined,
      resume: true,
      say: (line) => {
        lines.push(line);
      },
    });
    assert.equal(result.state.stage, 'compile');
    assert.ok(lines.some((line) => line.includes('恢复会话 ses-cli-resume：阶段 review')));
    assert.equal(result.brief === null, false);
  });
});

test('runConversationMode：--feedback 触发一次 revision，再确认 revision 2', async () => {
  await withTempDir(async (dir) => {
    const graph = exampleRequirements();
    const revised = schemeFor(graph, 2, { title: '稻田茶亭（深檐）' });
    const result = await runConversationMode(fakeClient([graph], [schemeFor(graph, 1), revised]), {
      sessionId: 'ses-cli-feedback',
      outDir: dir,
      designMode: 'legacy',
      task: '做一间茶室。',
      answers: ['yes'],
      feedback: '南侧屋檐再深一点，其他保持原样。',
      resume: false,
      say: () => undefined,
    });
    assert.equal(result.scheme.meta.revision, 2);
    assert.equal(result.state.designs.length, 2);
    assert.equal(result.state.confirmedDesignRevision, 2);
  });
});

function seededReview(
  id: string,
  scheme: DesignScheme,
  options: {
    readonly conflicts?: ReturnType<typeof designConflictsFromWarnings>;
    readonly datumConflict?: FloorDatumConflict | null;
  } = {},
): ReturnType<typeof createSession> {
  let state = createSession(id);
  state = reduceSession(state, { kind: 'recordRequirements', graph: exampleRequirements() });
  state = reduceSession(state, { kind: 'skipClarify' });
  state = reduceSession(state, {
    kind: 'proposeDesign',
    scheme,
    ...(options.conflicts === undefined ? {} : { conflicts: options.conflicts }),
    ...(options.datumConflict === undefined ? {} : { datumConflict: options.datumConflict }),
  });
  return reduceSession(state, { kind: 'recordCheck', designRevision: 1, passed: true, issues: [] });
}

test('runConversationMode：furniture 冲突经注入 IO 菜单选择，不静默确认', async () => {
  await withTempDir(async (dir) => {
    const conflict = designConflictsFromWarnings([
      { code: 'furniture-dropped', message: '柜台被丢弃', path: 'furniture.f-counter' },
    ])[0];
    assert.ok(conflict);
    await saveSession(seededReview('ses-cli-conflict', schemeFor(exampleRequirements()), { conflicts: [conflict] }), {
      root: dir,
    });
    const answers = ['accept-drop', 'yes'];
    const asked: string[] = [];
    const said: string[] = [];
    const io: ConversationIO = {
      say: (line) => {
        said.push(line);
      },
      ask: (question) => {
        asked.push(question);
        const answer = answers.shift();
        if (answer === undefined) return Promise.reject(new Error(`没有预置回答：${question}`));
        return Promise.resolve(answer);
      },
    };
    const noModel: ChatClient = {
      complete() {
        return Promise.reject(new Error('冲突菜单不应调用模型'));
      },
    };
    const result = await runConversationMode(noModel, {
      sessionId: 'ses-cli-conflict',
      outDir: dir,
      resume: true,
      task: '',
      answers: undefined,
      feedback: undefined,
      conversationIO: io,
      say: (line) => {
        said.push(line);
      },
    });

    assert.equal(result.state.stage, 'compile');
    const resolvedConflict = result.state.designConflicts?.[0];
    assert.ok(resolvedConflict);
    assert.equal(resolvedConflict.status, 'resolved');
    assert.equal(resolvedConflict.choice?.optionId, 'accept-drop');
    assert.ok(asked.some((question) => question.includes(conflict.id)));
    const menu = said.join('\n');
    assert.match(menu, /restore-furniture/);
    assert.match(menu, /accept-drop/);
    assert.match(menu, /redesign/);
  });
});

test('runConversationMode：冲突选择后退出仍写入 session.json', async () => {
  await withTempDir(async (dir) => {
    const conflict = designConflictsFromWarnings([
      { code: 'furniture-dropped', message: '柜台被丢弃', path: 'furniture.f-counter' },
    ])[0];
    assert.ok(conflict);
    await saveSession(
      seededReview('ses-cli-conflict-exit', schemeFor(exampleRequirements()), { conflicts: [conflict] }),
      { root: dir },
    );
    const answers = ['accept-drop', 'q'];
    const said: string[] = [];
    const io: ConversationIO = {
      say: (line) => {
        said.push(line);
      },
      ask: () => {
        const answer = answers.shift();
        if (answer === undefined) return Promise.reject(new Error('冲突退出测试回答不足'));
        return Promise.resolve(answer);
      },
    };
    const noModel: ChatClient = {
      complete() {
        return Promise.reject(new Error('冲突菜单不应调用模型'));
      },
    };
    const result = await runConversationMode(noModel, {
      sessionId: 'ses-cli-conflict-exit',
      outDir: dir,
      resume: true,
      task: '',
      answers: undefined,
      feedback: undefined,
      conversationIO: io,
      say: () => undefined,
    });

    assert.equal(result.state.stage, 'review');
    assert.equal(result.brief, null);
    assert.ok(said.some((line) => line.includes('会话已保存')));
    const stored = JSON.parse(await readFile(join(dir, 'ses-cli-conflict-exit', 'session.json'), 'utf8')) as {
      readonly stage: string;
      readonly designConflicts?: readonly {
        readonly status: string;
        readonly choice: { readonly optionId: string } | null;
      }[];
    };
    assert.equal(stored.stage, 'review');
    const storedConflict = stored.designConflicts?.[0];
    assert.ok(storedConflict);
    assert.equal(storedConflict.status, 'resolved');
    assert.ok(storedConflict.choice !== null);
    assert.equal(storedConflict.choice.optionId, 'accept-drop');
  });
});

test('runConversationMode：--answers 对象可用 conflict:<id> 预置菜单回答', async () => {
  await withTempDir(async (dir) => {
    const conflict = designConflictsFromWarnings([
      { code: 'furniture-shrunk', message: '长桌 4×2 → 4×1', path: 'furniture.f-table' },
    ])[0];
    assert.ok(conflict);
    await saveSession(
      seededReview('ses-cli-conflict-key', schemeFor(exampleRequirements()), { conflicts: [conflict] }),
      {
        root: dir,
      },
    );
    const noModel: ChatClient = {
      complete() {
        return Promise.reject(new Error('冲突菜单不应调用模型'));
      },
    };
    const result = await runConversationMode(noModel, {
      sessionId: 'ses-cli-conflict-key',
      outDir: dir,
      resume: true,
      task: '',
      answers: [
        { questionId: `conflict:${conflict.id}`, answer: 'accept-shrink' },
        { questionId: 'confirm', answer: 'yes' },
      ],
      feedback: undefined,
      say: () => undefined,
    });
    assert.equal(result.state.stage, 'compile');
    const resolvedConflict = result.state.designConflicts?.[0];
    assert.ok(resolvedConflict);
    assert.equal(resolvedConflict.status, 'resolved');
    assert.ok(resolvedConflict.choice !== null);
    assert.equal(resolvedConflict.choice.optionId, 'accept-shrink');
  });
});

test('runConversationMode：datum 冲突菜单提供四个选项，accept-step 后确认', async () => {
  await withTempDir(async (dir) => {
    const datum = FloorDatumConflict.parse({
      id: 'conflict-flush-entry-cli',
      kind: 'flush-entry',
      mustIds: ['req-no-steps'],
      expected: '室外地面与室内地面同高 y1',
      actual: '室外地面 y0，入口底 y1，室内地面 y1',
      recommendedSource: 'raise-site',
      targetGradeY: 1,
      resolution: '抬场地到 y1；否则由用户选择接受或豁免',
      options: [
        { id: 'raise-site', label: '抬高场地' },
        { id: 'accept-step', label: '接受高差' },
        { id: 'waive', label: '豁免 must' },
        { id: 'redesign', label: '重新设计' },
      ],
    });
    await saveSession(seededReview('ses-cli-datum', schemeFor(exampleRequirements()), { datumConflict: datum }), {
      root: dir,
    });
    const answers = ['accept-step', 'yes'];
    const said: string[] = [];
    const io: ConversationIO = {
      say: (line) => {
        said.push(line);
      },
      ask: () => {
        const answer = answers.shift();
        if (answer === undefined) return Promise.reject(new Error('datum 菜单回答不足'));
        return Promise.resolve(answer);
      },
    };
    const noModel: ChatClient = {
      complete() {
        return Promise.reject(new Error('datum 菜单不应调用模型'));
      },
    };
    const result = await runConversationMode(noModel, {
      sessionId: 'ses-cli-datum',
      outDir: dir,
      resume: true,
      task: '',
      answers: undefined,
      feedback: undefined,
      conversationIO: io,
      say: () => undefined,
    });

    assert.equal(result.state.stage, 'compile');
    assert.equal(result.state.datumChoice?.action, 'accept-step');
    assert.equal(result.state.designConflicts?.[0]?.status, 'resolved');
    const menu = said.join('\n');
    for (const option of ['raise-site', 'accept-step', 'waive', 'redesign']) {
      assert.match(menu, new RegExp(option));
    }
  });
});
