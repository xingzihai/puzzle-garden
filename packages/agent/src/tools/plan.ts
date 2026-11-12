/**
 * 施工计划 / 清单 / 冲突（OPTIMIZATION-ROADMAP Phase 3E；R4 §6 Leak 5）：
 * 让 agent 有一份可读回的工作契约，而不是只写不读的设计文档。
 *
 * 负责：计划阶段、must 项（id / status / evidence）、冲突记录、给模型看的确定性文本与事实行摘要。
 * 不负责：工具分发（turn-tools）、run 生命周期（runner）、submit 门槛；冲突只记录，不中断 run，也不改提交条件。
 * 本文件是纯函数：不做 I/O，不依赖时间 / 随机数；同一状态与动作总是得到同一结果。
 */

/** 六阶段手册（OPTIMIZATION-ROADMAP Phase 3A）的机器可读版本；顺序即施工顺序。 */
export const PLAN_PHASES = ['plan', 'ground', 'roof', 'interior', 'detail', 'self-check'] as const;
export type PlanPhase = (typeof PLAN_PHASES)[number];

/** 清单项状态；verified / failed 是终态，不允许退回 todo / doing。 */
export const PLAN_STATUSES = ['todo', 'doing', 'verified', 'failed'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** 一次计划最多 64 项：足够覆盖 must 清单，又不让读回文本挤占上下文。 */
export const MAX_PLAN_ITEMS = 64;
/** 一次 run 最多记录 8 条冲突；再多的冲突应合并同类项。 */
export const MAX_PLAN_CONFLICTS = 8;

export interface PlanItem {
  readonly id: string;
  readonly status: PlanStatus;
  readonly evidence?: string;
}

export interface PlanConflict {
  /** 稳定 id：`conflict-1`、`conflict-2`…… */
  readonly id: string;
  readonly kind: string;
  readonly expected: string;
  readonly actual: string;
  readonly options: readonly string[];
  /** null 表示未解决；本工具没有解决动作，保留给宿主 / 后续版本。 */
  readonly choice: string | null;
}

export interface PlanState {
  readonly phase: PlanPhase;
  readonly items: readonly PlanItem[];
  readonly note: string | null;
  readonly conflicts: readonly PlanConflict[];
}

export type PlanAction =
  | { readonly action: 'read' }
  | {
      readonly action: 'update';
      readonly phase: PlanPhase;
      readonly items: readonly PlanItem[];
      readonly note?: string;
    }
  | {
      readonly action: 'conflict';
      readonly kind: string;
      readonly expected: string;
      readonly actual: string;
      readonly options: readonly string[];
    };

export interface PlanResult {
  readonly state: PlanState;
  readonly text: string;
}

/** 空计划：从计划的 plan 阶段开始，没有清单项与冲突。 */
export function initialPlanState(): PlanState {
  return { phase: 'plan', items: [], note: null, conflicts: [] };
}

/** verified / failed 同级：都算已结算，但两者之间不限制互相纠正。 */
const STATUS_RANK: Record<PlanStatus, number> = {
  todo: 0,
  doing: 1,
  verified: 2,
  failed: 2,
};

function countStatus(items: readonly PlanItem[], status: PlanStatus): number {
  return items.filter((item) => item.status === status).length;
}

function unresolvedCount(conflicts: readonly PlanConflict[]): number {
  return conflicts.filter((conflict) => conflict.choice === null).length;
}

/**
 * 一行事实摘要（放在每轮 facts 里）：阶段、已结算项 / 总项、verified / failed 数、未解决冲突数。
 * 例：`plan roof 3/6; musts 2 verified/1 failed; conflicts 1`。不含证据与说明，长度只随数字增长。
 */
export function planDigest(state: PlanState): string {
  const verified = countStatus(state.items, 'verified');
  const failed = countStatus(state.items, 'failed');
  const settled = verified + failed;
  return (
    `plan ${state.phase} ${String(settled)}/${String(state.items.length)}; ` +
    `musts ${String(verified)} verified/${String(failed)} failed; ` +
    `conflicts ${String(unresolvedCount(state.conflicts))}`
  );
}

function statusCounts(items: readonly PlanItem[]): string {
  return PLAN_STATUSES.map((status) => `${status} ${String(countStatus(items, status))}`).join('、');
}

/** 给模型读回的完整计划文本；顺序固定：阶段 → 说明 → 项 → 冲突。 */
function describePlan(state: PlanState): string {
  const lines = [
    `计划：阶段 ${state.phase}；项 ${String(state.items.length)}（${statusCounts(state.items)}）；` +
      `未解决冲突 ${String(unresolvedCount(state.conflicts))}/${String(state.conflicts.length)}。`,
  ];
  if (state.note !== null) lines.push(`  说明：${state.note}`);
  if (state.items.length === 0) lines.push('  还没有计划项。');
  for (const item of state.items) {
    const evidence = item.evidence === undefined ? '' : `：${item.evidence}`;
    lines.push(`  [${item.status}] ${item.id}${evidence}`);
  }
  if (state.conflicts.length === 0) lines.push('  没有冲突。');
  for (const conflict of state.conflicts) {
    const options = conflict.options.length === 0 ? '无' : conflict.options.join(' / ');
    lines.push(
      `  ${conflict.id}（${conflict.kind}）：期望 ${conflict.expected}；实际 ${conflict.actual}；` +
        `选项 ${options}；选择 ${conflict.choice ?? '未定'}`,
    );
  }
  return lines.join('\n');
}

/** 下一个稳定冲突 id：取已有 `conflict-<n>` 的最大编号 + 1。 */
function nextConflictId(conflicts: readonly PlanConflict[]): string {
  let max = 0;
  for (const conflict of conflicts) {
    const match = /^conflict-(\d+)$/.exec(conflict.id);
    const digits = match?.[1];
    if (digits !== undefined) max = Math.max(max, Number(digits));
  }
  return `conflict-${String(max + 1)}`;
}

/** update 的校验；返回 null 表示可以应用，否则返回给模型看的原因。 */
function updateProblem(state: PlanState, action: Extract<PlanAction, { action: 'update' }>): string | null {
  if (!(PLAN_PHASES as readonly string[]).includes(action.phase)) {
    return `未知阶段 ${action.phase}；可用：${PLAN_PHASES.join('、')}。`;
  }
  if (action.items.length > MAX_PLAN_ITEMS) {
    return `计划项最多 ${String(MAX_PLAN_ITEMS)} 条，实际 ${String(action.items.length)} 条。`;
  }
  const previous = new Map(state.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (const item of action.items) {
    if (item.id === '') return '计划项 id 不能为空。';
    if (seen.has(item.id)) return `计划项 id 重复：${item.id}。`;
    seen.add(item.id);
    if (!(PLAN_STATUSES as readonly string[]).includes(item.status)) {
      return `未知状态 ${item.status}；可用：${PLAN_STATUSES.join('、')}。`;
    }
    const old = previous.get(item.id);
    if (old !== undefined && STATUS_RANK[item.status] < STATUS_RANK[old.status]) {
      return `计划项 ${item.id} 不能从 ${old.status} 退回 ${item.status}（终态不可回退）。`;
    }
  }
  return null;
}

/**
 * 执行一次计划动作。`read` 原样返回状态；`update` 整体替换阶段 / 项（note 省略时保留）；
 * `conflict` 追加一条 `conflict-<n>` 且 choice 为 null。非法动作不修改状态，只返回原因文本，
 * 这样宿主不需要为模型参数错误中断 run。
 */
export function applyPlanAction(state: PlanState, action: PlanAction): PlanResult {
  switch (action.action) {
    case 'read':
      return { state, text: describePlan(state) };
    case 'update': {
      const problem = updateProblem(state, action);
      if (problem !== null) return { state, text: `计划未更新：${problem}` };
      const items = action.items.map((item) => ({
        id: item.id,
        status: item.status,
        ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
      }));
      const note = action.note === undefined ? state.note : action.note === '' ? null : action.note;
      const next: PlanState = { phase: action.phase, items, note, conflicts: state.conflicts };
      return { state: next, text: `已更新计划。\n${describePlan(next)}` };
    }
    case 'conflict': {
      if (state.conflicts.length >= MAX_PLAN_CONFLICTS) {
        return {
          state,
          text: `计划未更新：冲突最多 ${String(MAX_PLAN_CONFLICTS)} 条，请合并同类项。`,
        };
      }
      const conflict: PlanConflict = {
        id: nextConflictId(state.conflicts),
        kind: action.kind,
        expected: action.expected,
        actual: action.actual,
        options: [...action.options],
        choice: null,
      };
      const next: PlanState = { ...state, conflicts: [...state.conflicts, conflict] };
      return {
        state: next,
        text:
          `已记录冲突 ${conflict.id}（${conflict.kind}）：期望 ${conflict.expected}；实际 ${conflict.actual}；` +
          `选项 ${conflict.options.length === 0 ? '无' : conflict.options.join(' / ')}。` +
          `未解决冲突 ${String(unresolvedCount(next.conflicts))} 条；run 继续。`,
      };
    }
  }
}
