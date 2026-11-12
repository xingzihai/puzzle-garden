/**
 * 最小批量（AGENT-SPEC §8）：读 owner 批准文件、校验单次上限与 sealed 路径，按决策 #38 只跑第 1 个样本。
 *
 * 负责：批准文件 schema 与可读报错、`maxCostCnyPerRun ≤ 3.5` 与 `/sealed/` 拒绝、单样本执行编排。
 * 不负责：真实 run 本身（由调用方注入 runOne）、run 记录与花费统计（@pg/store）、--rest（推迟，AGENT-SPEC §14）。
 * 真正的批量脚本入口推迟到批次 7；本文件让"先跑 1 个样本"这条过程规则可单测。
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { MAX_RUN_CNY } from './cli-args.ts';
import { assertTaskPath } from './task-body.ts';

/** 批准文件（owner 本次下令的要点；决策 #39）。 */
export const ApprovalSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,64}$/),
  by: z.literal('owner'),
  date: z.iso.date(),
  text: z.string().min(1),
  tasks: z.array(z.string()).min(1),
  runsPerTask: z.int().min(1),
  /** 单次 run 花费上限（人民币）；不得超过 3.5。 */
  maxCostCnyPerRun: z.number().positive(),
  seed: z
    .int()
    .min(0)
    .max(2 ** 32 - 1)
    .optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

/** 批量校验失败：入口据此报错退出，不跑任何 run。 */
export class BatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchError';
  }
}

/** 解析批准文件内容（zod 失败时一次列出全部问题）。 */
export function parseApproval(value: unknown): Approval {
  const parsed = ApprovalSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`);
    throw new BatchError(`批准文件不合 schema：${issues.join('；')}`);
  }
  return parsed.data;
}

/** 读批准文件并解析。 */
export function readApproval(path: string): Approval {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new BatchError(`读批准文件 ${path} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new BatchError(`批准文件 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return parseApproval(value);
}

/** 机械校验：单次上限 ≤ 3.5，题目路径都不含 /sealed/。 */
export function validateApproval(approval: Approval): void {
  if (approval.maxCostCnyPerRun > MAX_RUN_CNY) {
    throw new BatchError(
      `单次上限 ${String(approval.maxCostCnyPerRun)} 超过 ${String(MAX_RUN_CNY)}：拒绝批量（AGENT-SPEC §8、§11）。`,
    );
  }
  try {
    for (const task of approval.tasks) assertTaskPath(task);
  } catch (error) {
    throw new BatchError(error instanceof Error ? error.message : String(error));
  }
}

export interface BatchItemResult {
  readonly runId: string;
  /** null 表示交付。 */
  readonly stopReason: string | null;
  readonly costCny: number;
  readonly turns: number;
}

export interface BatchReport {
  readonly approvedBy: string;
  readonly approvedText: string;
  readonly plannedTasks: number;
  readonly ran: number;
  readonly remaining: number;
  readonly first: { readonly task: string; readonly seed: number; readonly result: BatchItemResult };
  readonly nextStep: string;
}

/** #38：先跑 1 个样本；下一批题目与次数看这次结果再定。--rest 推迟（§14）。 */
export const NEXT_STEP_HINT =
  '已按 #38 只跑第 1 个样本：看交付图、trace 与测量后再决定是否继续；--rest 推迟到批次 7（AGENT-SPEC §14）。';

/**
 * 按批准文件跑第 1 个样本：校验后只调一次 `runOne(tasks[0], seed)`，其余 item 不跑。
 * 返回报告供入口打印；不写 state.jsonl（推迟到批次 7）。
 */
export async function runBatch(
  approval: Approval,
  runOne: (task: string, seed: number) => Promise<BatchItemResult>,
): Promise<BatchReport> {
  validateApproval(approval);
  const firstTask = approval.tasks[0];
  if (firstTask === undefined) throw new BatchError('批准文件没有题目');
  const seed = approval.seed ?? 0;
  const result = await runOne(firstTask, seed);
  return {
    approvedBy: approval.by,
    approvedText: approval.text,
    plannedTasks: approval.tasks.length,
    ran: 1,
    remaining: approval.tasks.length - 1,
    first: { task: firstTask, seed, result },
    nextStep: NEXT_STEP_HINT,
  };
}
