/**
 * L2 状态卡格式与语义测试（W11-02 / T09）。
 * 只测纯函数；token 上限在 v2.test.ts 用官方 tokenizer 复核。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatStateCard,
  STATE_CARD_MAX_CHARS,
  STATE_CARD_MAX_TOKENS,
  STATE_CARD_SPEC,
  STATE_CARD_VERSION,
  type StateCardInput,
} from './state-card.ts';

const BASE: StateCardInput = {
  phase: 'roof',
  draftVersion: 7,
  lastCheck: { version: 7, outcome: 'ok' },
  lastView: { version: 7, view: 'iso-se' },
  objects: { pass: 4, fail: 0, missing: 1, unverified: 1, extra: 0, nonPassIds: ['wall#3'] },
  furniture: { pass: 3, fail: 1, missing: 2, nonPassIds: ['table#1'] },
  musts: {
    total: 9,
    hasEvidence: true,
    evidence: 3,
    unverified: 4,
    notLinked: 2,
    conflicts: 1,
    conflictIds: ['conflict-flush-entry'],
  },
  plan: { verified: 2, total: 6 },
  budget: { turn: 12, maxTurns: 50, spentCny: 0.42, maxCny: 1.6, wallMinutes: 6, wallMaxMinutes: 18 },
  next: ['roof bounds', 'south window probe'],
};

describe('formatStateCard', () => {
  it('固定格式包含版本、阶段、对象、家具、must、plan、预算与 next', () => {
    const card = formatStateCard(BASE);
    for (const s of [
      `[状态卡 ${STATE_CARD_VERSION}]`,
      'phase=roof',
      'draft=v7',
      'check=v7:ok',
      'view=v7:iso-se',
      'objects pass=4 fail=0 missing=1 unverified=1 extra=0',
      'furniture pass=3 fail=1 missing=2',
      'must evidence=3 unverified=4 not_linked=2 total=9 conflicts=1',
      'conflict-flush-entry',
      'plan self-report=2/6 verified（不是证据）',
      'budget turn=12/50',
      'next=1) roof bounds  2) south window probe',
    ]) {
      assert.ok(card.includes(s), `缺少：${s}`);
    }
    assert.ok(STATE_CARD_SPEC.includes('plan self-report='));
    assert.ok(STATE_CARD_SPEC.includes('must evidence='));
  });

  it('plan 自报与 must 证据分成两行；无 shadow 证据时 must=unknown', () => {
    const card = formatStateCard({
      ...BASE,
      musts: { ...BASE.musts, hasEvidence: false, evidence: 0, unverified: 0, notLinked: 0 },
    });
    const lines = card.split('\n');
    assert.ok(lines.some((l) => l.startsWith('must evidence=unknown')));
    assert.ok(lines.some((l) => l.startsWith('plan self-report=2/6 verified（不是证据）')));
    assert.ok(!lines.some((l) => l.startsWith('must evidence=0')));
    assert.ok(lines.some((l) => l.includes('conflict-flush-entry')));
  });

  it('没有 plan 时自报写 unknown，不伪造 0/0 证据', () => {
    const { plan: planBefore, ...withoutPlan } = BASE;
    assert.ok(planBefore !== undefined);
    const card = formatStateCard(withoutPlan);
    assert.ok(card.includes('plan self-report=unknown（不是证据）'));
  });

  it('确定性：同输入逐字节相同', () => {
    assert.equal(formatStateCard(BASE), formatStateCard(BASE));
    assert.equal(formatStateCard(BASE), formatStateCard({ ...BASE }));
  });

  it('截断先删 next / 非 PASS id，保留冲突与预算，且不超字符上限', () => {
    const long: StateCardInput = {
      ...BASE,
      objects: {
        ...BASE.objects,
        nonPassIds: ['object-with-a-very-long-identifier#1', 'object#2', 'object#3', 'object#4'],
      },
      furniture: {
        ...BASE.furniture,
        nonPassIds: ['furniture-with-a-very-long-identifier#1', 'furniture#2', 'furniture#3'],
      },
      musts: { ...BASE.musts, conflictIds: ['conflict-flush-entry', 'conflict-roof-pitch'] },
      next: Array.from({ length: 12 }, (_, i) => `very long next action number ${String(i + 1)} with detail`),
    };
    const card = formatStateCard(long);
    assert.ok(card.length <= STATE_CARD_MAX_CHARS, `状态卡 ${String(card.length)} 字符超上限`);
    assert.ok(card.includes('conflict-flush-entry'), '冲突 id 不能被截掉');
    assert.ok(card.includes('budget turn=12/50'), '预算不能被截掉');
    assert.ok(card.includes('must evidence=3'), 'must 证据不能被截掉');
    assert.ok((card.match(/\d\)/g) ?? []).length <= 3, 'next 最多 3 条');
  });

  it('maxTurns 为 null 时预算写不限轮数；参数上限常量符合设计', () => {
    const card = formatStateCard({
      ...BASE,
      budget: { ...BASE.budget, maxTurns: null },
    });
    assert.ok(card.includes('turn=12/∞'));
    assert.equal(STATE_CARD_MAX_TOKENS, 550);
    assert.equal(STATE_CARD_MAX_CHARS, 2200);
  });
});
