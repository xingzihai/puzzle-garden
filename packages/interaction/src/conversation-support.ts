/**
 * 对话流程的纯辅助函数：问题挑选、默认值处理、方案检查与摘要 / 确认提示。
 *
 * 负责：把 RequirementGraph / DesignScheme 转成可打印的问题、检查结果与确认动作；
 * 不做文件 / 网络 I/O，也不推进会话状态机。
 * 不负责：调用模型、持久化、CLI 交互；这些由 conversation.ts 与 tools 层注入。
 */
import { compileBuildBrief, lintBrief } from './brief.ts';
import type { BuildBrief } from './build.ts';
import type { ConversationIO } from './conversation-types.ts';
import { designConflictFromDatum, designConflictFromGateIssue, isOpenBlockingConflict } from './design-conflict.ts';
import type { DesignConflict, DesignConflictOptionAction } from './design-conflict.ts';
import { deriveFloorDatum } from './floor-datum.ts';
import type { BriefIssue } from './lint.ts';
import type { ClarificationExchange } from './prompts.ts';
import { compileDesignReport } from './report.ts';
import { RequirementGraph } from './requirements.ts';
import { formatSchemeGateIssue, verifySchemeAgainstRequirements } from './scheme-gate.ts';
import type { RequirementGraph as RequirementGraphType } from './requirements.ts';
import type { ClarificationAnswer, ClarificationQuestion, SessionState } from './session.ts';
import type { DesignScheme as DesignSchemeType, SchemeScope } from './scheme.ts';

const MAX_QUESTIONS = 3;

export const EXIT_PATTERN = /^(q|quit|exit|退出|结束|取消)$/i;
export const YES_PATTERN = /^(y|yes|是|确认|好|ok|okay|同意|可以|行)$/i;
export const NO_PATTERN = /^(n|no|否|不要|不)$/i;

export const SCOPE_LABEL: Readonly<Record<SchemeScope, string>> = {
  exterior: '外观',
  'exterior+entry': '外观 + 入口',
  'exterior+interior': '外观 + 完整室内',
};

export type Decision =
  { readonly kind: 'confirm' } | { readonly kind: 'exit' } | { readonly kind: 'revise'; readonly feedback: string };

function clip(text: string): string {
  return text.length <= 3800 ? text : `${text.slice(0, 3800)}…`;
}

/**
 * 从需求图挑最多 3 个真正会改变方案的问题：open 冲突、高影响 / 中影响歧义、阻断性缺失。
 * 顺序固定，避免同一输入产生不同提问顺序。
 */
export function clarificationQuestions(graph: RequirementGraphType): ClarificationQuestion[] {
  const out: ClarificationQuestion[] = [];
  const seen = new Set<string>();
  const push = (id: string, text: string): void => {
    if (out.length >= MAX_QUESTIONS || seen.has(id)) return;
    seen.add(id);
    out.push({ id, text: clip(text) });
  };
  const optionsText = (options: readonly string[]): string =>
    options.length === 0 ? '' : `（可选：${options.join(' / ')}）`;

  for (const conflict of graph.conflicts) {
    if (conflict.status === 'open') push(conflict.id, `冲突：${conflict.summary}${optionsText(conflict.options)}`);
  }
  for (const ambiguity of graph.ambiguities) {
    if (ambiguity.status !== 'open' || ambiguity.impact !== 'high') continue;
    const fallback = ambiguity.suggestedDefault === null ? '' : `；建议默认：${ambiguity.suggestedDefault}`;
    push(ambiguity.id, `${ambiguity.question}${optionsText(ambiguity.options)}${fallback}`);
  }
  for (const missing of graph.missing) {
    if (missing.status !== 'open' || !missing.blocking) continue;
    const fallback = missing.suggestedDefault === null ? '' : `；建议默认：${missing.suggestedDefault}`;
    push(missing.id, `缺失：${missing.topic}。${missing.why}${fallback}`);
  }
  for (const ambiguity of graph.ambiguities) {
    if (ambiguity.status !== 'open' || ambiguity.impact !== 'medium') continue;
    const fallback = ambiguity.suggestedDefault === null ? '' : `；建议默认：${ambiguity.suggestedDefault}`;
    push(ambiguity.id, `${ambiguity.question}${optionsText(ambiguity.options)}${fallback}`);
  }
  return out;
}

/**
 * 第二轮之后仍有未解决问题时，只把有 suggestedDefault 的 open 项标成 assumed / waived，
 * 并把处理方式打印给用户；冲突没有默认值，保持 open，交给方案 open 条目。
 */
export function applySuggestedDefaults(graph: RequirementGraphType): {
  readonly graph: RequirementGraphType;
  readonly notes: readonly string[];
} {
  const notes: string[] = [];
  const ambiguities = graph.ambiguities.map((item) => {
    if (item.status !== 'open' || item.suggestedDefault === null) return item;
    notes.push(`问题 ${item.id} 按建议默认处理并标记 assumed：${item.suggestedDefault}`);
    return { ...item, status: 'assumed' as const };
  });
  const missing = graph.missing.map((item) => {
    if (item.status !== 'open' || !item.blocking || item.suggestedDefault === null) return item;
    notes.push(`缺失 ${item.id} 按建议默认处理并标记 waived：${item.suggestedDefault}`);
    return { ...item, status: 'waived' as const };
  });
  for (const conflict of graph.conflicts) {
    if (conflict.status === 'open')
      notes.push(`冲突 ${conflict.id} 仍未解决，设计会把它写入 open：${conflict.summary}`);
  }
  return { graph: RequirementGraph.parse({ ...graph, ambiguities, missing }), notes };
}

export function exchangesOf(
  questions: readonly ClarificationQuestion[],
  answers: readonly ClarificationAnswer[],
): ClarificationExchange[] {
  return answers.map((answer) => {
    const question = questions.find((item) => item.id === answer.questionId);
    return { question: question?.text ?? answer.questionId, answer: answer.answer };
  });
}

function gateIssueCode(code: string): BriefIssue['code'] {
  switch (code) {
    case 'table-4x2':
    case 'no-chairs':
    case 'door-clearance-1m':
    case 'counter-table-1m':
      return code;
    default:
      return 'scheme-gate';
  }
}

export function checkScheme(
  scheme: DesignSchemeType,
  requirements: RequirementGraphType,
): { readonly brief: BuildBrief; readonly issues: BriefIssue[]; readonly conflicts: DesignConflict[] } {
  const brief = compileBuildBrief(scheme, requirements);
  const issues = [...lintBrief(brief, requirements)];
  const report = compileDesignReport(scheme, requirements);
  if (report !== brief.designMarkdown) {
    issues.push({
      code: 'section-format',
      message: '内部错误：compileDesignReport 与 compileBuildBrief 生成的 design.md 不一致。',
    });
  }
  const gate = verifySchemeAgainstRequirements(scheme, requirements);
  const gateConflicts = gate.issues.map((issue) => designConflictFromGateIssue(issue));
  for (const issue of gate.issues) {
    issues.push({ code: gateIssueCode(issue.code), message: formatSchemeGateIssue(issue) });
  }
  const datum = deriveFloorDatum(scheme, requirements);
  const datumConflict = datum.conflict === null ? null : designConflictFromDatum(datum.conflict);
  if (datum.conflict !== null) {
    issues.push({
      code: 'datum-conflict',
      message: `[${datum.conflict.id}] ${datum.conflict.actual}；must=${datum.conflict.mustIds.join(
        '、',
      )}；expected=${datum.conflict.expected}；处置：${datum.conflict.resolution}`,
    });
  }
  return {
    brief,
    issues,
    conflicts: [...gateConflicts, ...(datumConflict === null ? [] : [datumConflict])],
  };
}

/**
 * 当前仍未处理的 blocking 冲突：优先读 designConflicts（已含 datum），
 * 旧会话只有 datumConflict 时补一条派生冲突；datumChoice 已记录则视为已处理。
 */
export function openDesignConflicts(state: SessionState): DesignConflict[] {
  const open = new Map<string, DesignConflict>();
  for (const conflict of state.designConflicts ?? []) {
    if (isOpenBlockingConflict(conflict)) open.set(conflict.id, conflict);
  }
  const datum = state.datumConflict;
  if (datum !== null && datum !== undefined && (state.datumChoice === null || state.datumChoice === undefined)) {
    const derived = designConflictFromDatum(datum);
    if (!(state.designConflicts ?? []).some((conflict) => conflict.id === derived.id)) {
      open.set(derived.id, derived);
    }
  }
  return [...open.values()];
}

/** 打印一个冲突的选项；选项完全来自 DesignConflict，不在 CLI 里写死默认值。 */
export function showConflictMenu(io: ConversationIO, conflict: DesignConflict): void {
  io.say('');
  io.say(`冲突 [${conflict.id}] ${conflict.title}（${conflict.severity === 'blocking' ? '必须处理' : '提示'}）`);
  io.say(`- ${conflict.message}`);
  if (conflict.location !== null) io.say(`- 位置：${conflict.location}`);
  if (conflict.expected !== null) io.say(`- 期望：${conflict.expected}`);
  if (conflict.actual !== null) io.say(`- 实际：${conflict.actual}`);
  conflict.options.forEach((option, index) => {
    io.say(`  ${String(index + 1)}. ${option.label}（${option.id}；${option.action}）`);
  });
}

export interface ConflictMenuChoice {
  readonly id: string;
  readonly label: string;
  readonly action: DesignConflictOptionAction;
}

/** 解析序号或 option id；不猜默认值，无法识别返回 undefined 让调用方重新提问。 */
export function parseConflictChoice(conflict: DesignConflict, raw: string): ConflictMenuChoice | undefined {
  const text = raw.trim();
  const byIndex = /^\d+$/.test(text) ? conflict.options[Number(text) - 1] : undefined;
  const option = byIndex ?? conflict.options.find((candidate) => candidate.id === text);
  return option === undefined ? undefined : { id: option.id, label: option.label, action: option.action };
}

export function showIssues(io: ConversationIO, issues: readonly BriefIssue[]): void {
  io.say(`确定性检查未通过（${String(issues.length)} 项），不能确认方案：`);
  for (const issue of issues) io.say(`- [${issue.code}] ${issue.message}`);
}

export function showScheme(io: ConversationIO, scheme: DesignSchemeType, requirements: RequirementGraphType): void {
  const rooms = scheme.spaces.filter((space) => space.kind === 'room').map((space) => space.name);
  const musts = requirements.requirements
    .filter((requirement) => requirement.priority === 'must' && requirement.status !== 'rejected')
    .map((requirement) => `[${requirement.id}] ${requirement.text}`);
  const decisions = scheme.decisions.slice(0, 5).map((decision) => `${decision.topic}：${decision.choice}`);
  io.say(`方案摘要：${scheme.meta.title}（${scheme.meta.id} v${String(scheme.meta.revision)}）`);
  io.say(`- 概念：${scheme.meta.concept}`);
  io.say(`- 范围：${SCOPE_LABEL[scheme.meta.scope]}`);
  io.say(`- 主要空间：${rooms.length === 0 ? '无' : rooms.join('、')}`);
  io.say(`- 关键取舍：${decisions.length === 0 ? '无额外决策' : decisions.join('；')}`);
  io.say(`- 必须项：${musts.length === 0 ? '无' : musts.join('；')}`);
  io.say(`- 未决：${scheme.open.length === 0 ? '无' : scheme.open.map((item) => item.question).join('；')}`);
  io.say(
    `- 完整设计报告：确认后写入会话目录的 design.md（当前 ${String(compileDesignReport(scheme, requirements).length)} 字符）。`,
  );
}

export async function askLintFeedback(io: ConversationIO): Promise<string | null> {
  const raw = (await io.ask('请输入修改意见，或输入 q 保存并退出：')).trim();
  if (raw === '' || EXIT_PATTERN.test(raw)) return null;
  return raw;
}

export async function askDecision(io: ConversationIO, scheme: DesignSchemeType): Promise<Decision> {
  const question = `是否确认方案 ${scheme.meta.id} v${String(scheme.meta.revision)}？输入 y 确认；直接输入修改意见则定向修订；输入 q 保存并退出。`;
  if (io.confirm !== undefined) {
    const confirmed = await io.confirm(question);
    if (confirmed) return { kind: 'confirm' };
    const feedback = (await io.ask('请说明需要修改的内容（q 退出）：')).trim();
    if (feedback === '' || EXIT_PATTERN.test(feedback) || NO_PATTERN.test(feedback)) return { kind: 'exit' };
    return { kind: 'revise', feedback };
  }
  const raw = (await io.ask(question)).trim();
  if (YES_PATTERN.test(raw)) return { kind: 'confirm' };
  if (raw === '' || EXIT_PATTERN.test(raw)) return { kind: 'exit' };
  if (NO_PATTERN.test(raw)) {
    const feedback = (await io.ask('请说明需要修改的内容（q 退出）：')).trim();
    if (feedback === '' || EXIT_PATTERN.test(feedback)) return { kind: 'exit' };
    return { kind: 'revise', feedback };
  }
  return { kind: 'revise', feedback: raw };
}
