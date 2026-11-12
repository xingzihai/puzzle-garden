/**
 * W11-08 生产状态卡测试：字段、unknown 诚实性、plan / must 分栏、BuildSheet 证据投影与稳定截断。
 * 只测纯函数；runner 接线由 runner.test.ts 的真实请求体覆盖。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countsFromReport,
  failureFingerprint,
  formatStateCard,
  mustEvidenceFrom,
  nextActions,
  parseBuildSheetFacts,
  parseFurnitureCounts,
  STATE_CARD_MAX_CHARS,
  STATE_CARD_VERSION,
  type DiffReportLike,
  type StateCardInput,
  type StateCounts,
} from './state-card.ts';

const OBJECTS: StateCounts = {
  pass: 4,
  fail: 1,
  missing: 1,
  unverified: 1,
  extra: 0,
  nonPassIds: ['wall-3'],
};
const FURNITURE: StateCounts = { pass: 3, fail: 1, missing: 2, nonPassIds: ['table-1'] };

const BASE: StateCardInput = {
  phase: 'roof',
  draftVersion: 7,
  lastCheck: { version: 7, outcome: 'ok' },
  lastView: { version: 7 },
  objects: OBJECTS,
  furniture: FURNITURE,
  musts: { total: 9, evidence: 3, unverified: 4, notLinked: 2 },
  conflicts: { count: 1, ids: ['conflict-flush-entry'] },
  plan: { verified: 2, total: 6 },
  budget: { turn: 12, maxTurns: 50, spentCny: 0.42, maxCny: 1.6, wallMinutes: 6, wallMaxMinutes: 18 },
  next: ['roof bounds', 'south window probe'],
};

const BUILD_SHEET = `# BuildSheet — test

- objects: 2；furniture: 1；coverage: 0；musts: 3

## 期望对象

| id | kind | bounds | 材质 | 形式 / 洞口 | mustIds |
| --- | --- | --- | --- | --- | --- |
| \`wall-1\` | wall | — | — | — | must-wall |
| \`roof-1\` | roof | — | — | — | must-roof |

## Musts（3）

- \`must-wall\` [task] (verified) → wall-1；text: 外墙由墙对象证明。
- \`must-roof\` [task] (declared: 关键词) → roof-1；declared: furniture:table-1；text: 屋面由屋顶对象证明。
- \`must-free\` [task] (none) → 未链接（unverified）；text: 没有对象链接。

## 冲突

- **conflict-datum**（contract-number）
  - mustIds: must-wall
  - expected: y0
  - actual: y1
  - resolution: record
`;

function report(): DiffReportLike {
  return {
    summary: { pass: 1, fail: 1, missing: 0, extra: 0, unverified: 0 },
    items: [
      { id: 'expected:wall-1', expectedId: 'wall-1', actualId: 'wall-a', status: 'pass' },
      { id: 'expected:roof-1', expectedId: 'roof-1', actualId: 'roof-a', status: 'fail' },
    ] as unknown as DiffReportLike['items'],
  };
}

describe('生产状态卡', () => {
  it('包含 phase / 版本 / 对象 / 家具 / must / plan / 冲突 / 预算 / next', () => {
    const card = formatStateCard(BASE);
    for (const text of [
      `[状态卡 ${STATE_CARD_VERSION}]`,
      'phase=roof',
      'draft=v7',
      'check=v7:ok',
      'view=v7',
      'objects pass=4 fail=1 missing=1 unverified=1 extra=0',
      'furniture pass=3 fail=1 missing=2',
      'must evidence=3 unverified=4 not_linked=2 total=9 conflicts=1',
      'conflict-flush-entry',
      'plan self-report=2/6 verified（不是证据）',
      'budget turn=12/50',
      'next=1) roof bounds  2) south window probe',
    ]) {
      assert.ok(card.includes(text), `缺少：${text}`);
    }
    assert.ok(card.indexOf('must evidence=') < card.indexOf('plan self-report='), 'must 与 plan 是两栏');
  });

  it('没有证据时 objects / furniture / must 都写 unknown，不伪造成 0', () => {
    const card = formatStateCard({
      ...BASE,
      objects: null,
      furniture: null,
      musts: { total: null, evidence: null, unverified: null, notLinked: null },
    });
    assert.ok(card.includes('objects unknown'));
    assert.ok(card.includes('furniture unknown'));
    assert.ok(card.includes('must evidence=unknown total=unknown'));
    assert.ok(!card.includes('objects pass=0'));
    assert.ok(!card.includes('furniture pass=0'));
    assert.ok(card.includes('plan self-report=2/6'), '无宿主证据时 plan 自报仍单独保留');
  });

  it('没有 plan 时自报 unknown；没有 BuildSheet 时 total 也 unknown', () => {
    const card = formatStateCard({
      draftVersion: BASE.draftVersion,
      lastCheck: BASE.lastCheck,
      lastView: BASE.lastView,
      objects: BASE.objects,
      furniture: BASE.furniture,
      musts: null,
      conflicts: BASE.conflicts,
      plan: null,
      budget: BASE.budget,
    });
    assert.ok(card.includes('plan self-report=unknown（不是证据）'));
    assert.ok(card.includes('must evidence=unknown total=unknown'));
    assert.ok(card.includes('phase=unknown'));
    assert.ok(!card.includes('next='));
  });

  it('长输入截断稳定：先删 next 再删 non-pass id，冲突与预算不丢', () => {
    const long: StateCardInput = {
      ...BASE,
      objects: {
        ...OBJECTS,
        nonPassIds: ['object-with-a-very-long-identifier#1', 'object#2', 'object#3'],
      },
      furniture: {
        ...FURNITURE,
        nonPassIds: ['furniture-with-a-very-long-identifier#1', 'furniture#2', 'furniture#3'],
      },
      conflicts: { count: 2, ids: ['conflict-flush-entry', 'conflict-roof-pitch'] },
      next: Array.from({ length: 12 }, (_, i) => `very long next action number ${String(i + 1)} with detail`),
    };
    const card = formatStateCard(long);
    assert.equal(card, formatStateCard(long));
    assert.ok(card.length <= STATE_CARD_MAX_CHARS);
    assert.ok(new TextEncoder().encode(card).length / 3 <= 550, '字节估算 token 应 ≤550');
    assert.ok(card.includes('conflict-flush-entry'));
    assert.ok(card.includes('budget turn=12/50'));
    assert.ok(card.includes('must evidence=3'));
    assert.ok((card.match(/\d\)/g) ?? []).length <= 3);
  });

  it('plan 与 must 的百分比不互相冒充：plan 6/6 不能写成 must 6', () => {
    const card = formatStateCard({
      ...BASE,
      musts: { total: 6, evidence: 0, unverified: 6, notLinked: 0 },
      plan: { verified: 6, total: 6 },
    });
    const must = card.split('\n').find((line) => line.startsWith('must '));
    const plan = card.split('\n').find((line) => line.startsWith('plan '));
    assert.ok(must?.includes('must evidence=0'));
    assert.ok(plan?.includes('6/6 verified'));
    assert.ok(!must?.includes('6/6'));
  });
});

describe('BuildSheet 投影', () => {
  it('解析 must 链接与冲突，只把 verified + 对象 PASS 计为证据', () => {
    const facts = parseBuildSheetFacts(BUILD_SHEET);
    assert.ok(facts !== null);
    assert.equal(facts.totalMusts, 3);
    assert.deepEqual(facts.conflictIds, ['conflict-datum']);
    assert.deepEqual(
      facts.musts.map((must) => [must.id, must.scope, must.objectIds]),
      [
        ['must-wall', 'verified', ['wall-1']],
        ['must-roof', 'declared', ['roof-1']],
        ['must-free', 'none', []],
      ],
    );
    const evidence = mustEvidenceFrom(facts, report());
    assert.deepEqual(evidence, { total: 3, evidence: 1, unverified: 1, notLinked: 1 });
    const objects = countsFromReport(report());
    assert.equal(objects.pass, 1);
    assert.equal(objects.fail, 1);
    assert.deepEqual(objects.nonPassIds, ['roof-1']);
  });

  it('没有 shadow 报告时 evidence=unknown，但 total 来自 BuildSheet', () => {
    const facts = parseBuildSheetFacts(BUILD_SHEET);
    assert.ok(facts !== null);
    assert.deepEqual(mustEvidenceFrom(facts, null), {
      total: 3,
      evidence: null,
      unverified: null,
      notLinked: null,
    });
    const card = formatStateCard({
      ...BASE,
      musts: mustEvidenceFrom(facts, null),
    });
    assert.ok(card.includes('must evidence=unknown total=3'));
  });

  it('解析家具核对计数；没有该段返回 null', () => {
    assert.deepEqual(parseFurnitureCounts('家具核对（仅报告）：pass 3 / fail 1 / missing 2 / extra 0'), {
      pass: 3,
      fail: 1,
      missing: 2,
      extra: 0,
    });
    assert.deepEqual(parseFurnitureCounts('家具核对（仅报告）：pass 1 / fail 0 / missing 0 / extra 0 / unverified 2'), {
      pass: 1,
      fail: 0,
      missing: 0,
      extra: 0,
      unverified: 2,
    });
    assert.equal(parseFurnitureCounts('家具核对不可用：boom'), null);
    assert.equal(parseFurnitureCounts('执行成功'), null);
  });

  it('家具明细行解析出非 PASS id，供 next 指向具体家具', () => {
    const text = [
      '家具核对（仅报告）：pass 1 / fail 1 / missing 1 / extra 0',
      '- FAIL furniture table-1：bounds 不符',
      '- MISSING furniture chair-2',
    ].join('\n');
    assert.deepEqual(parseFurnitureCounts(text), {
      pass: 1,
      fail: 1,
      missing: 1,
      extra: 0,
      nonPassIds: ['table-1', 'chair-2'],
    });
  });
});

describe('状态卡 next 行动化', () => {
  it('优先级：家具 > must > view，超过 3 条时 check 与 plan 让位', () => {
    const items = nextActions({
      draftVersion: 29,
      lastCheck: { version: 29, outcome: 'ok' },
      lastView: { version: 14 },
      furniture: { pass: 0, fail: 0, missing: 6, nonPassIds: ['cushion', 'table-leg'] },
      musts: { total: 10, evidence: 0, unverified: 10, notLinked: 0 },
      objects: { pass: 10, fail: 1, missing: 0, nonPassIds: ['wall:f1'] },
      plan: ['plan-item'],
    });
    assert.deepEqual(items, [
      'furniture 6 missing：先补 cushion/table-leg',
      'must evidence 0/10：看 BuildSheet Musts',
      'view 过期 v14：提交前看一次',
    ]);
    const card = formatStateCard({ ...BASE, next: items });
    assert.ok(card.includes('next=1) furniture 6 missing：先补 cushion/table-leg'));
    assert.ok(!card.includes('check wall:f1'), '3 条已满时第 4 优先级不显示');
  });

  it('没有家具 / must / view 时给当前 check 失败对象，plan 最后', () => {
    assert.deepEqual(
      nextActions({
        draftVersion: 5,
        lastCheck: { version: 5, outcome: 'ok' },
        lastView: { version: 5 },
        furniture: { pass: 2, fail: 0, missing: 0 },
        musts: { total: 4, evidence: 3, unverified: 1, notLinked: 0 },
        objects: { pass: 8, fail: 1, missing: 0, nonPassIds: ['wall:f1'] },
        plan: ['plan-item'],
      }),
      ['check wall:f1：先 probe/read 再 edit', 'plan-item'],
    );
  });

  it('check 失败且没有对象证据时提示先 read / reference；没有 plan 也能给出行动', () => {
    assert.deepEqual(
      nextActions({
        draftVersion: 2,
        lastCheck: { version: 2, outcome: 'build-error' },
        lastView: { version: 2 },
        furniture: null,
        musts: { total: 5, evidence: null, unverified: null, notLinked: null },
        objects: null,
      }),
      ['check v2 build-error：先 read 错误行/reference'],
      'check 未成功时 must unknown 不应抢在错误前面',
    );
  });

  it('家具 fail 与 missing 同时存在时分别列出；接近完成的 must 不打扰', () => {
    assert.deepEqual(
      nextActions({
        draftVersion: 3,
        lastCheck: { version: 3, outcome: 'ok' },
        lastView: { version: 3 },
        furniture: { pass: 4, fail: 1, missing: 2, nonPassIds: ['chair-1'] },
        musts: { total: 9, evidence: 8, unverified: 1, notLinked: 0 },
        objects: { pass: 9, fail: 0, missing: 0 },
      }),
      ['furniture 1 fail/2 missing：先补 chair-1'],
    );
  });
});

describe('连续错误提示（report-only）', () => {
  const failReport = (id: string): DiffReportLike => ({
    summary: { pass: 1, fail: 1, missing: 0, extra: 0, unverified: 0 },
    items: [
      { id: 'expected:roof-1', expectedId: 'roof-1', status: 'pass' },
      { id: `expected:${id}`, expectedId: id, status: 'fail' },
    ] as unknown as DiffReportLike['items'],
  });

  it('连续两次相同 diff：指纹相同，状态卡出现“先 probe/read/reference”提示', () => {
    const first = failureFingerprint(failReport('wall:f1'), null);
    const second = failureFingerprint(failReport('wall:f1'), null);
    assert.ok(first !== null && second !== null);
    assert.equal(first.key, second.key);
    const card = formatStateCard({
      ...BASE,
      repeatedFailure: { count: 2, ...(second.target === null ? {} : { target: second.target }) },
    });
    assert.ok(card.includes('同一错误已连续 2 次：先 probe/read/reference，不要继续 edit 同一处'));
    assert.ok(card.includes('（wall:f1）'));
  });

  it('不同 diff：指纹不同，不应出现提示', () => {
    const first = failureFingerprint(failReport('wall:f1'), null);
    const second = failureFingerprint(failReport('slab:f1'), null);
    assert.ok(first !== null && second !== null);
    assert.notEqual(first.key, second.key);
    const card = formatStateCard({ ...BASE, repeatedFailure: { count: 1 } });
    assert.ok(!card.includes('同一错误已连续'));
  });

  it('全 PASS 清空指纹；预检错误的版本 / 行列号变化不算新错误', () => {
    assert.equal(
      failureFingerprint(
        {
          summary: { pass: 2, fail: 0, missing: 0, extra: 0, unverified: 0 },
          items: [
            { id: 'expected:wall-1', expectedId: 'wall-1', status: 'pass' },
          ] as unknown as DiffReportLike['items'],
        },
        null,
      ),
      null,
    );
    const a = failureFingerprint(null, '第 v2 版：类型预检未通过（1 处，显示前 1 处）：\nbuilding.ts:3:3 TS2820 oops');
    const b = failureFingerprint(null, '第 v9 版：类型预检未通过（1 处，显示前 1 处）：\nbuilding.ts:8:9 TS2820 oops');
    assert.ok(a !== null && b !== null);
    assert.equal(a.key, b.key);
  });
});
