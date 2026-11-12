/**
 * 父预算的 `TargetBudget` 实现（SUBAGENT-LOOP-SPEC §3.1、MODEL-SPEC §4.3 C6）。
 *
 * 负责：父剩余金额、子运行按 `spent + pendingSubrun + cny ≤ limit` 预留、结算时释放预留并按实际入账；
 *   图片计数与窗口状态三个数据字段由本对象持有，runner 与体素目标共享同一份。
 * 不负责：请求前预留（runner 的 `reserveFor`）与护栏判定（guards/*）。
 * 金额一律按元 × 1e8 的整数记账（MODEL-SPEC §4.2）；`limit = 0` 关闭花费护栏。
 */

import type { RunLimits } from '@pg/store/events';

import type { TargetBudget } from './target.ts';

/** 1 元 = 1e8 个记账单位（与 runner / cost.ts 同口径）。 */
const OCTA = 1e8;
/** `limit = 0`（关闭护栏）时给 `reserveFor` 的足够大上限。 */
export const UNLIMITED_CNY = 1e6;

/** 与 runner 共享的整数计数：父自己的已结算花费 + 进行中的子运行预留。 */
export interface BudgetCounters {
  spentOcta: number;
  subrunReservedOcta: number;
}

/**
 * 建一个父预算对象。`counters` 与 runner 的 `run` 是同一对象，预留与结算会直接改它，
 * 所以事实行、花费护栏与 `run.end.totals` 都自然包含子运行花费。
 */
export function createRunBudget(limits: RunLimits, counters: BudgetCounters): TargetBudget {
  return {
    imageBytes: 0,
    images: 0,
    inWindow: false,
    remainingCny: (): number => {
      if (limits.maxCostCny === 0) return Number.POSITIVE_INFINITY;
      return Math.max(
        0,
        (Math.round(limits.maxCostCny * OCTA) - counters.spentOcta - counters.subrunReservedOcta) / OCTA,
      );
    },
    reserveSubrun: (cny: number): boolean => {
      const octa = Math.round(cny * OCTA);
      const limitOcta = Math.round(limits.maxCostCny * OCTA);
      if (limits.maxCostCny > 0 && counters.spentOcta + counters.subrunReservedOcta + octa > limitOcta) {
        return false;
      }
      counters.subrunReservedOcta += octa;
      return true;
    },
    settleSubrun: (reservedCny: number, actualCny: number): void => {
      if (actualCny > reservedCny + 1e-6) {
        throw new Error(
          `子运行结算超过预留：actual ¥${String(actualCny)} > reserved ¥${String(reservedCny)}（父预算不变量破坏）`,
        );
      }
      counters.subrunReservedOcta = Math.max(0, counters.subrunReservedOcta - Math.round(reservedCny * OCTA));
      counters.spentOcta += Math.round(actualCny * OCTA);
    },
  };
}
