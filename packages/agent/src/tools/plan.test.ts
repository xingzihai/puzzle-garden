/** 施工计划：初始状态、read / update / conflict、终态不回退、上限与事实摘要（Phase 3E）。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PlanConflict, PlanItem, PlanState, PlanStatus } from './plan.ts';
import {
  MAX_PLAN_CONFLICTS,
  MAX_PLAN_ITEMS,
  PLAN_PHASES,
  PLAN_STATUSES,
  applyPlanAction,
  initialPlanState,
  planDigest,
} from './plan.ts';

function item(id: string, status: PlanStatus, evidence?: string): PlanItem {
  return evidence === undefined ? { id, status } : { id, status, evidence };
}

function conflict(id: string, choice: string | null = null): PlanConflict {
  return { id, kind: 'flush', expected: '入口齐平', actual: '一格高差', options: ['抬场地', '降楼面'], choice };
}

function state(overrides: Partial<PlanState> = {}): PlanState {
  return { ...initialPlanState(), ...overrides };
}

describe('initialPlanState', () => {
  it('从 plan 阶段开始，没有项、说明与冲突；每次返回新对象', () => {
    assert.deepEqual(initialPlanState(), { phase: 'plan', items: [], note: null, conflicts: [] });
    assert.notEqual(initialPlanState(), initialPlanState());
    assert.deepEqual([...PLAN_PHASES], ['plan', 'ground', 'roof', 'interior', 'detail', 'self-check']);
    assert.deepEqual([...PLAN_STATUSES], ['todo', 'doing', 'verified', 'failed']);
    assert.equal(MAX_PLAN_ITEMS, 64);
    assert.equal(MAX_PLAN_CONFLICTS, 8);
  });
});

describe('applyPlanAction：read', () => {
  it('原样返回状态，并列出阶段、状态计数、项、证据与冲突', () => {
    const before = state({
      phase: 'roof',
      items: [item('must-roof', 'verified', 'eave 5 / ridge 7'), item('must-wall', 'doing')],
      note: '先屋面再室内',
      conflicts: [conflict('conflict-1')],
    });
    const result = applyPlanAction(before, { action: 'read' });
    assert.equal(result.state, before);
    assert.match(result.text, /阶段 roof/);
    assert.match(result.text, /项 2（todo 0、doing 1、verified 1、failed 0）/);
    assert.match(result.text, /未解决冲突 1\/1/);
    assert.match(result.text, /说明：先屋面再室内/);
    assert.match(result.text, /\[verified\] must-roof：eave 5 \/ ridge 7/);
    assert.match(result.text, /\[doing\] must-wall/);
    assert.match(result.text, /conflict-1（flush）：期望 入口齐平；实际 一格高差/);
    assert.match(result.text, /选项 抬场地 \/ 降楼面；选择 未定/);
  });

  it('空计划给出明确提示', () => {
    const result = applyPlanAction(initialPlanState(), { action: 'read' });
    assert.match(result.text, /阶段 plan/);
    assert.match(result.text, /还没有计划项/);
    assert.match(result.text, /没有冲突/);
  });
});

describe('applyPlanAction：update', () => {
  it('整体替换阶段 / 项 / 说明，保留证据，不改动输入状态', () => {
    const before = state({ note: '旧说明', conflicts: [conflict('conflict-1')] });
    const snapshot = structuredClone(before);
    const result = applyPlanAction(before, {
      action: 'update',
      phase: 'ground',
      items: [item('must-floor', 'verified', 'floorPlate y0'), item('must-wall', 'todo')],
      note: '地面完成',
    });
    assert.deepEqual(before, snapshot);
    assert.deepEqual(result.state, {
      phase: 'ground',
      items: [item('must-floor', 'verified', 'floorPlate y0'), item('must-wall', 'todo')],
      note: '地面完成',
      conflicts: [conflict('conflict-1')],
    });
    assert.match(result.text, /已更新计划/);
    assert.match(result.text, /阶段 ground/);
    assert.match(result.text, /must-floor/);
  });

  it('note 省略时保留；空串清空', () => {
    const withNote = state({ note: '保留我' });
    const kept = applyPlanAction(withNote, { action: 'update', phase: 'roof', items: [] });
    assert.equal(kept.state.note, '保留我');
    const cleared = applyPlanAction(withNote, { action: 'update', phase: 'roof', items: [], note: '' });
    assert.equal(cleared.state.note, null);
  });

  it('终态不回退：verified / failed 不能退回 todo / doing；todo 可前进', () => {
    const before = state({ items: [item('a', 'verified'), item('b', 'failed'), item('c', 'todo')] });
    const back = applyPlanAction(before, {
      action: 'update',
      phase: 'roof',
      items: [item('a', 'doing'), item('b', 'todo'), item('c', 'doing')],
    });
    assert.equal(back.state, before);
    assert.match(back.text, /计划未更新/);
    assert.match(back.text, /不能从 verified 退回 doing/);

    const forward = applyPlanAction(before, {
      action: 'update',
      phase: 'roof',
      items: [item('a', 'verified'), item('b', 'failed'), item('c', 'doing')],
    });
    assert.notEqual(forward.state, before);
    assert.equal(forward.state.items[2]?.status, 'doing');
  });

  it('拒绝重复 id、空 id 与超过上限的项；状态不变', () => {
    const before = state({ items: [item('a', 'todo')] });
    const duplicate = applyPlanAction(before, {
      action: 'update',
      phase: 'roof',
      items: [item('b', 'todo'), item('b', 'doing')],
    });
    assert.equal(duplicate.state, before);
    assert.match(duplicate.text, /id 重复：b/);

    const empty = applyPlanAction(before, { action: 'update', phase: 'roof', items: [item('', 'todo')] });
    assert.equal(empty.state, before);
    assert.match(empty.text, /id 不能为空/);

    const tooMany = applyPlanAction(before, {
      action: 'update',
      phase: 'roof',
      items: Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_, i) => item(`m${String(i)}`, 'todo')),
    });
    assert.equal(tooMany.state, before);
    assert.match(tooMany.text, /最多 64 条/);

    const exact = applyPlanAction(before, {
      action: 'update',
      phase: 'roof',
      items: Array.from({ length: MAX_PLAN_ITEMS }, (_, i) => item(`m${String(i)}`, 'todo')),
    });
    assert.equal(exact.state.items.length, MAX_PLAN_ITEMS);
  });
});

describe('applyPlanAction：conflict', () => {
  it('追加 conflict-1 / conflict-2，choice 为 null，不中断也不改其它字段', () => {
    const before = state({ phase: 'roof', items: [item('must-roof', 'doing')], note: '继续' });
    const first = applyPlanAction(before, {
      action: 'conflict',
      kind: 'flush',
      expected: '入口齐平',
      actual: '一格高差',
      options: ['抬场地', '降楼面'],
    });
    assert.equal(first.state.phase, 'roof');
    assert.equal(first.state.note, '继续');
    assert.deepEqual(first.state.items, before.items);
    assert.deepEqual(first.state.conflicts, [
      {
        id: 'conflict-1',
        kind: 'flush',
        expected: '入口齐平',
        actual: '一格高差',
        options: ['抬场地', '降楼面'],
        choice: null,
      },
    ]);
    assert.match(first.text, /已记录冲突 conflict-1/);
    assert.match(first.text, /未解决冲突 1 条；run 继续/);

    const second = applyPlanAction(first.state, {
      action: 'conflict',
      kind: 'seat-count',
      expected: '10 座',
      actual: '8 座',
      options: ['加桌'],
    });
    assert.equal(second.state.conflicts[1]!.id, 'conflict-2');
    assert.equal(second.state.conflicts[1]!.choice, null);
  });

  it('已有非顺序 id 时取最大编号 + 1，不重复', () => {
    const before = state({ conflicts: [conflict('conflict-7')] });
    const result = applyPlanAction(before, {
      action: 'conflict',
      kind: 'x',
      expected: 'a',
      actual: 'b',
      options: [],
    });
    assert.equal(result.state.conflicts[1]?.id, 'conflict-8');
  });

  it('最多 8 条；第 9 条不写入状态', () => {
    let current = initialPlanState();
    for (let i = 0; i < MAX_PLAN_CONFLICTS; i += 1) {
      current = applyPlanAction(current, {
        action: 'conflict',
        kind: `k${String(i)}`,
        expected: 'e',
        actual: 'a',
        options: ['o'],
      }).state;
    }
    assert.equal(current.conflicts.length, MAX_PLAN_CONFLICTS);
    const rejected = applyPlanAction(current, {
      action: 'conflict',
      kind: 'x',
      expected: 'e',
      actual: 'a',
      options: [],
    });
    assert.equal(rejected.state, current);
    assert.match(rejected.text, /最多 8 条/);
  });

  it('read 能读回冲突与未定选择', () => {
    const withConflict = applyPlanAction(initialPlanState(), {
      action: 'conflict',
      kind: 'flush',
      expected: '齐平',
      actual: '一格',
      options: ['抬场地'],
    }).state;
    const text = applyPlanAction(withConflict, { action: 'read' }).text;
    assert.match(text, /conflict-1（flush）/);
    assert.match(text, /选项 抬场地；选择 未定/);
  });
});

describe('planDigest', () => {
  it('阶段、已结算 / 总项、verified / failed 与未解决冲突一行摘要', () => {
    const plan = state({
      phase: 'roof',
      items: [
        item('a', 'verified'),
        item('b', 'verified'),
        item('c', 'failed'),
        item('d', 'doing'),
        item('e', 'todo'),
        item('f', 'todo'),
      ],
      conflicts: [conflict('conflict-1')],
    });
    assert.equal(planDigest(plan), 'plan roof 3/6; musts 2 verified/1 failed; conflicts 1');
  });

  it('空计划也从 plan 阶段开始；已选择的冲突不计数', () => {
    assert.equal(planDigest(initialPlanState()), 'plan plan 0/0; musts 0 verified/0 failed; conflicts 0');
    const resolved = state({ conflicts: [conflict('conflict-1', '抬场地')] });
    assert.equal(planDigest(resolved), 'plan plan 0/0; musts 0 verified/0 failed; conflicts 0');
  });
});
