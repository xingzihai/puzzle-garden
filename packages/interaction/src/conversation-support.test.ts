import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleRequirements, exampleScheme } from './example.ts';
import {
  applySuggestedDefaults,
  checkScheme,
  clarificationQuestions,
  exchangesOf,
  showScheme,
} from './conversation-support.ts';
import type { ConversationIO } from './conversation.ts';
import { RequirementGraph } from './requirements.ts';
import { DesignScheme } from './scheme.ts';

function graphWithOpenItems(): RequirementGraph {
  return RequirementGraph.parse({
    ...exampleRequirements(),
    ambiguities: [
      {
        id: 'amb-high',
        question: '入口放在哪一侧？',
        options: ['北侧村道', '南侧稻田'],
        impact: 'high',
        suggestedDefault: '北侧村道',
        status: 'open',
        requirementIds: [],
      },
      {
        id: 'amb-medium',
        question: '柜台需要多大？',
        options: ['小', '中'],
        impact: 'medium',
        suggestedDefault: null,
        status: 'open',
        requirementIds: [],
      },
      {
        id: 'amb-low',
        question: '灯具用暖光还是冷光？',
        options: ['暖光', '冷光'],
        impact: 'low',
        suggestedDefault: '暖光',
        status: 'open',
        requirementIds: [],
      },
      {
        id: 'amb-resolved',
        question: '已解决的问题',
        options: ['是'],
        impact: 'high',
        suggestedDefault: null,
        status: 'resolved',
        requirementIds: [],
      },
    ],
    conflicts: [
      {
        id: 'conf-1',
        summary: '南向大窗与预算冲突',
        requirementIds: ['req-view', 'req-budget'],
        options: ['缩小窗', '提高预算'],
        status: 'open',
      },
    ],
    missing: [
      {
        id: 'miss-blocking',
        topic: '场地边界',
        why: '不知道可建范围',
        blocking: true,
        suggestedDefault: '按 24 × 20 m 场地',
        status: 'open',
      },
      {
        id: 'miss-optional',
        topic: '灯具品牌',
        why: '不影响方案',
        blocking: false,
        suggestedDefault: null,
        status: 'open',
      },
    ],
  });
}

test('clarificationQuestions 只问 open 高 / 中影响与阻断缺失，最多 3 个', () => {
  const questions = clarificationQuestions(graphWithOpenItems());
  assert.deepEqual(
    questions.map((item) => item.id),
    ['conf-1', 'amb-high', 'miss-blocking'],
  );
  assert.match(questions[0]?.text ?? '', /冲突/);
  assert.match(questions[1]?.text ?? '', /建议默认：北侧村道/);
});

test('applySuggestedDefaults 把有默认值的 open 歧义标 assumed、阻断缺失标 waived', () => {
  const { graph, notes } = applySuggestedDefaults(graphWithOpenItems());
  const ambiguity = graph.ambiguities.find((item) => item.id === 'amb-high');
  const missing = graph.missing.find((item) => item.id === 'miss-blocking');
  assert.equal(ambiguity?.status, 'assumed');
  assert.equal(missing?.status, 'waived');
  assert.equal(graph.conflicts[0]?.status, 'open');
  assert.ok(notes.some((note) => note.includes('assumed')));
  assert.ok(notes.some((note) => note.includes('conf-1')));
});

test('checkScheme 能报告缺失室内，exchangesOf 保留问题与回答', () => {
  const requirements = exampleRequirements();
  assert.deepEqual(checkScheme(exampleScheme(), requirements).issues, []);
  const broken = DesignScheme.parse({ ...exampleScheme(), interiors: [] });
  assert.ok(checkScheme(broken, requirements).issues.some((issue) => issue.code === 'interior-missing'));
  assert.deepEqual(
    exchangesOf([{ id: 'amb-high', text: '入口在哪？' }], [{ questionId: 'amb-high', answer: '北侧。' }]),
    [{ question: '入口在哪？', answer: '北侧。' }],
  );
});

test('showScheme 打印标题、空间、关键取舍与未决项', () => {
  const lines: string[] = [];
  const io: ConversationIO = {
    say: (text) => {
      lines.push(text);
    },
    ask: () => Promise.resolve(''),
  };
  showScheme(io, exampleScheme(), exampleRequirements());
  const text = lines.join('\n');
  assert.match(text, /方案摘要：稻田茶亭/);
  assert.match(text, /主要空间：喝茶区/);
  assert.match(text, /关键取舍：/);
  assert.match(text, /未决：/);
  assert.match(text, /design\.md/);
});
