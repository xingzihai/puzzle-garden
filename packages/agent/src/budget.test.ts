/** 父预算：剩余金额 / 子运行预留 → 结算的硬约束与不变量（SUBAGENT-LOOP-SPEC §3.1）。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunLimits } from '@pg/store/events';

import { createRunBudget, UNLIMITED_CNY, type BudgetCounters } from './budget.ts';

const LIMITS: RunLimits = { maxCostCny: 3.5, maxTurns: 20, wallMs: 240_000, submitWindow: 2 };

function counters(): BudgetCounters {
  return { spentOcta: 0, subrunReservedOcta: 0 };
}

describe('createRunBudget', () => {
  it('初始化：图片计数与窗口为空，remainingCny 用上限减已花与预留', () => {
    const state = counters();
    const budget = createRunBudget(LIMITS, state);
    assert.equal(budget.imageBytes, 0);
    assert.equal(budget.images, 0);
    assert.equal(budget.inWindow, false);
    assert.equal(budget.remainingCny(), 3.5);
    state.spentOcta = Math.round(1 * 1e8);
    state.subrunReservedOcta = Math.round(0.5 * 1e8);
    assert.equal(budget.remainingCny(), 2);
  });

  it('limit = 0（关闭护栏）：remainingCny 为 Infinity，预留永远成功', () => {
    const budget = createRunBudget({ ...LIMITS, maxCostCny: 0 }, counters());
    assert.equal(budget.remainingCny(), Number.POSITIVE_INFINITY);
    assert.equal(budget.reserveSubrun(UNLIMITED_CNY), true);
  });

  it('预留硬约束：spent + 预留 + cny > limit 时拒绝且不改状态', () => {
    const state = counters();
    const budget = createRunBudget(LIMITS, state);
    state.spentOcta = Math.round(3.0 * 1e8);
    assert.equal(budget.reserveSubrun(0.4), true);
    assert.equal(budget.reserveSubrun(0.2), false);
    assert.equal(state.subrunReservedOcta, Math.round(0.4 * 1e8));
    // 恰好到上限允许（≤）。
    assert.equal(budget.reserveSubrun(0.1), true);
    assert.equal(state.subrunReservedOcta, Math.round(0.5 * 1e8));
  });

  it('结算：释放预留、按实际入账；拿不到花费按预留全额', () => {
    const state = counters();
    const budget = createRunBudget(LIMITS, state);
    assert.equal(budget.reserveSubrun(0.5), true);
    budget.settleSubrun(0.5, 0.25);
    assert.equal(state.subrunReservedOcta, 0);
    assert.equal(state.spentOcta, Math.round(0.25 * 1e8));
    assert.equal(budget.remainingCny(), 3.25);
    // 没有预留也允许按记录补记（回放按 subrun.result 重建）。
    budget.settleSubrun(0.1, 0.1);
    assert.equal(state.subrunReservedOcta, 0);
    assert.equal(state.spentOcta, Math.round(0.35 * 1e8));
  });

  it('结算不变量：actual > reserved + 1e-6 抛错（父预算不变量破坏）', () => {
    const budget = createRunBudget(LIMITS, counters());
    assert.throws(() => {
      budget.settleSubrun(0.5, 0.500002);
    }, /不变量/);
    // 1e-6 容差内不抛。
    budget.settleSubrun(0.5, 0.500001);
  });
});
