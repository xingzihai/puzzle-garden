import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleRequirements } from './example.ts';
import { RequirementGraph } from './requirements.ts';

function messages(value: unknown): string {
  const result = RequirementGraph.safeParse(value);
  if (result.success) throw new Error('期望解析失败，但通过了');
  return result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('；');
}

test('合法需求图解析通过，且运行时冻结', () => {
  const graph = exampleRequirements();
  assert.equal(graph.requirements.length, 5);
  const first = graph.requirements[0];
  assert.ok(first);
  assert.equal(first.priority, 'must');
  assert.equal(Object.isFrozen(graph), true);
  assert.equal(Object.isFrozen(graph.requirements), true);
  assert.equal(Object.isFrozen(first.affects), true);
});

test('需求 id 重复被拒绝', () => {
  const base = exampleRequirements();
  const duplicate = { ...base, requirements: [...base.requirements, base.requirements[0]!] };
  assert.match(messages(duplicate), /需求 id 重复：req-use/);
});

test('冲突引用不存在的需求被拒绝', () => {
  const base = exampleRequirements();
  const bad = {
    ...base,
    conflicts: [
      {
        id: 'conf-1',
        summary: '看景与预算冲突',
        requirementIds: ['req-view', 'req-missing'],
        options: ['缩小体量', '减少装饰'],
        status: 'open',
      },
    ],
  };
  assert.match(messages(bad), /引用了不存在的需求 req-missing/);
});

test('决策可以引用需求 / 约束 / 能力项，真正不存在的 id 仍被拒绝', () => {
  const base = exampleRequirements();
  const firstDecision = base.decisions[0]!;
  const constraint = {
    id: 'con-site-envelope',
    text: '按约 20m×15m 的场地假设控制体量。',
    kind: 'dimension',
    source: 'agent',
    hard: false,
    value: null,
  } as const;
  const capability = {
    id: 'cap-freeform-shell',
    topic: '自由曲面壳体',
    status: 'partial',
    detail: '当前方块体系只能近似曲面。',
    workaround: '用阶梯式方块逼近。',
    requirementIds: ['req-view'],
  } as const;

  const graph = RequirementGraph.parse({
    ...base,
    constraints: [...base.constraints, constraint],
    capabilities: [capability],
    decisions: [
      {
        ...firstDecision,
        requirementIds: ['req-view', 'con-site-envelope', 'cap-freeform-shell'],
      },
    ],
  });
  assert.deepEqual(graph.decisions[0]?.requirementIds, ['req-view', 'con-site-envelope', 'cap-freeform-shell']);

  assert.match(
    messages({
      ...base,
      decisions: [{ ...firstDecision, requirementIds: ['req-view', 'con-missing'] }],
    }),
    /决策 reqd-orientation 引用了不存在的 id con-missing/,
  );
});

test('歧义 / 冲突 / 能力项的引用仍只允许需求，不放宽到约束 / 能力项', () => {
  const base = exampleRequirements();
  const constraint = {
    id: 'con-site-envelope',
    text: '按约 20m×15m 的场地假设控制体量。',
    kind: 'dimension',
    source: 'agent',
    hard: false,
    value: null,
  } as const;
  const graph = {
    ...base,
    constraints: [...base.constraints, constraint],
    ambiguities: [
      {
        id: 'amb-1',
        question: '入口朝北还是朝南？',
        options: ['北', '南'],
        impact: 'high',
        suggestedDefault: null,
        status: 'open',
        requirementIds: ['con-site-envelope'],
      },
    ],
  };
  assert.match(messages(graph), /歧义 amb-1 引用了不存在的需求 con-site-envelope/);
});

test('零面积 outdoorZone 仍被严格拒绝，不做静默截断', () => {
  const base = exampleRequirements();
  const zone = base.site!.outdoorZones[0]!;
  assert.match(
    messages({
      ...base,
      site: {
        ...base.site!,
        outdoorZones: [{ ...zone, bounds: { min: [0, 0, 0], max: [0, 1, 0] } }],
      },
    }),
    /site\.outdoorZones\.0\.bounds.*max 严格大于 min/,
  );
});

test('严格对象拒绝未知字段，数组与字符串有上限', () => {
  const base = exampleRequirements();
  assert.match(messages({ ...base, surprise: 1 }), /unrecognized key|Unrecognized key/i);
  assert.equal(RequirementGraph.safeParse({ ...base, summary: '' }).success, false);
  assert.equal(
    RequirementGraph.safeParse({ ...base, requirements: Array.from({ length: 501 }, () => base.requirements[0]) })
      .success,
    false,
  );
});

test('其余集合的 id 唯一性与需求引用也被校验', () => {
  const base = exampleRequirements();
  const firstSpace = base.spaces[0]!;
  const firstConstraint = base.constraints[0]!;
  const firstPreference = base.preferences[0]!;
  const firstDecision = base.decisions[0]!;
  const ambiguity = {
    id: 'amb-1',
    question: '柜台是否需要面向入口？',
    options: ['面向入口', '侧向'],
    impact: 'medium',
    suggestedDefault: null,
    status: 'open',
    requirementIds: ['req-counter'],
  } as const;
  const capability = {
    id: 'cap-1',
    topic: '动态电梯',
    status: 'unsupported',
    detail: '当前 World API 没有动态电梯。',
    workaround: '用楼梯替代。',
    requirementIds: ['req-use'],
  } as const;
  const missing = {
    id: 'miss-1',
    topic: '场地边界',
    why: '尚未给出精确退界。',
    blocking: false,
    suggestedDefault: null,
    status: 'open',
  } as const;
  const siteZone = base.site!.outdoorZones[0]!;

  const cases: readonly (readonly [string, unknown, RegExp])[] = [
    ['需求空间 id 重复', { ...base, spaces: [...base.spaces, firstSpace] }, /需求空间 id 重复/],
    [
      '相邻空间不存在',
      {
        ...base,
        spaces: base.spaces.map((space, index) => (index === 0 ? { ...space, adjacency: ['sp-missing'] } : space)),
      },
      /引用了不存在的相邻空间 sp-missing/,
    ],
    ['约束 id 重复', { ...base, constraints: [...base.constraints, firstConstraint] }, /约束 id 重复/],
    ['偏好 id 重复', { ...base, preferences: [...base.preferences, firstPreference] }, /偏好 id 重复/],
    ['歧义 id 重复', { ...base, ambiguities: [ambiguity, ambiguity] }, /歧义 id 重复/],
    [
      '歧义引用不存在需求',
      { ...base, ambiguities: [{ ...ambiguity, requirementIds: ['req-missing'] }] },
      /歧义 amb-1 引用了不存在的需求 req-missing/,
    ],
    [
      '冲突 id 重复',
      {
        ...base,
        conflicts: [
          { id: 'conf-1', summary: 'A', requirementIds: ['req-use', 'req-view'], options: ['甲'], status: 'open' },
          { id: 'conf-1', summary: 'B', requirementIds: ['req-use', 'req-view'], options: ['乙'], status: 'open' },
        ],
      },
      /冲突 id 重复/,
    ],
    ['缺失项 id 重复', { ...base, missing: [missing, missing] }, /缺失项 id 重复/],
    ['能力项 id 重复', { ...base, capabilities: [capability, capability] }, /能力项 id 重复/],
    [
      '能力项引用不存在需求',
      { ...base, capabilities: [{ ...capability, requirementIds: ['req-missing'] }] },
      /能力项 cap-1 引用了不存在的需求 req-missing/,
    ],
    ['决策 id 重复', { ...base, decisions: [...base.decisions, firstDecision] }, /决策 id 重复/],
    [
      '决策引用不存在 id',
      { ...base, decisions: [{ ...firstDecision, requirementIds: ['req-missing'] }] },
      /决策 reqd-orientation 引用了不存在的 id req-missing/,
    ],
    ['场地区域 id 重复', { ...base, site: { ...base.site!, outdoorZones: [siteZone, siteZone] } }, /场地区域 id 重复/],
  ];

  for (const [name, value, pattern] of cases) {
    assert.match(messages(value), pattern, name);
  }
});
