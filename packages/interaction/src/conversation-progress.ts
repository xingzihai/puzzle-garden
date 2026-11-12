/**
 * 对话流程的进度适配：需求抽取、提问、确定性检查的 stage / question 事件。
 *
 * 负责：把同步 / 异步步骤包装成 InteractionProgressEvent，并让检查结果照常推进 SessionState。
 * 不负责：模型请求细节（generate.ts / generate-intent.ts）、持久化、终端或网页 I/O。
 */
import type { ChatClient } from '@pg/llm/client';

import type { BuildBrief } from './build.ts';
import type { DesignConflict } from './design-conflict.ts';
import {
  checkScheme,
  EXIT_PATTERN,
  openDesignConflicts,
  parseConflictChoice,
  showConflictMenu,
} from './conversation-support.ts';
import type { ConversationIO } from './conversation-types.ts';
import { extractRequirements } from './generate.ts';
import type { ExtractRequirementsInput, GenerationResult } from './generate.ts';
import type { InteractionProgressCallback } from './generate-intent.ts';
import type { BriefIssue } from './lint.ts';
import type { RequirementGraph } from './requirements.ts';
import { reduceSession } from './session.ts';
import type { ClarificationQuestion, SessionState } from './session.ts';
import type { DesignScheme } from './scheme.ts';

export interface CheckedScheme {
  readonly state: SessionState;
  readonly scheme: DesignScheme;
  readonly brief: BuildBrief;
  readonly issues: readonly BriefIssue[];
  readonly conflicts: readonly DesignConflict[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 需求抽取也接入进度：网页在等待模型时先显示“解析需求”，而不是只在生成方案时亮起。 */
export async function extractWithProgress(
  client: ChatClient,
  input: ExtractRequirementsInput,
  onProgress: InteractionProgressCallback | undefined,
): Promise<GenerationResult<RequirementGraph>> {
  onProgress?.({ kind: 'stage', stage: 'requirements', status: 'start' });
  try {
    const result = await extractRequirements(client, input);
    const warnings = result.warnings?.map((warning) => `[${warning.code}] ${warning.message}`).join('；');
    onProgress?.({
      kind: 'stage',
      stage: 'requirements',
      status: 'done',
      ...(warnings === undefined || warnings === '' ? {} : { detail: warnings }),
    });
    return result;
  } catch (error) {
    onProgress?.({ kind: 'stage', stage: 'requirements', status: 'error', detail: errorText(error) });
    throw error;
  }
}

export async function askQuestionWithProgress(
  io: ConversationIO,
  question: ClarificationQuestion,
  onProgress: InteractionProgressCallback | undefined,
): Promise<string> {
  onProgress?.({ kind: 'question', stage: 'requirements', id: question.id, text: question.text });
  if (io.askQuestion !== undefined) return io.askQuestion(question);
  return io.ask(question.text);
}

/** 一个或多个 open blocking 冲突的处理结果；resolved 只表示已无待选冲突。 */
export interface ConflictMenuOutcome {
  readonly kind: 'resolved' | 'revise' | 'exit';
  readonly state: SessionState;
  readonly feedback: string | null;
}

/**
 * 逐个让用户选择 open blocking 冲突的处置方式。选项来自 DesignConflict.options，
 * 不静默选默认值；accept / waive / accept-step 记录为已解决，repair / raise-site / redesign
 * 返回 revise，让调用方通过模型生成新 revision 落实，而不是在本函数里改几何。
 */
export async function resolveConflictsWithProgress(
  io: ConversationIO,
  state: SessionState,
): Promise<ConflictMenuOutcome> {
  let next = state;
  for (;;) {
    const conflict = openDesignConflicts(next)[0];
    if (conflict === undefined) return { kind: 'resolved', state: next, feedback: null };
    showConflictMenu(io, conflict);
    const raw = (await io.ask(`请选择冲突 ${conflict.id} 的处理方式（输入序号或选项 id，q 保存并退出）：`)).trim();
    if (raw === '' || EXIT_PATTERN.test(raw)) return { kind: 'exit', state: next, feedback: null };
    const choice = parseConflictChoice(conflict, raw);
    if (choice === undefined) {
      io.say(`未知选项：${raw}；请输入序号或选项 id。`);
      continue;
    }
    next = reduceSession(next, { kind: 'chooseConflictOption', conflictId: conflict.id, optionId: choice.id });
    const settled = choice.action === 'accept' || choice.action === 'waive' || choice.action === 'accept-step';
    io.say(
      settled
        ? `已记录「${choice.label}」；冲突 ${conflict.id} 已解决。`
        : `已记录「${choice.label}」；需要生成新 revision 落实，不会静默改动几何。`,
    );
    if (!settled) {
      return {
        kind: 'revise',
        state: next,
        feedback: `处理冲突 ${conflict.id}（${conflict.title}）：用户选择「${choice.label}」。请生成新 revision 落实该选择，不要静默改几何。`,
      };
    }
  }
}

/** 确定性检查包成 lint stage；失败也先发 error 再接原始异常。 */
export function evaluateSchemeWithProgress(
  requirements: RequirementGraph,
  state: SessionState,
  scheme: DesignScheme,
  onProgress: InteractionProgressCallback | undefined,
): CheckedScheme {
  onProgress?.({ kind: 'stage', stage: 'lint', status: 'start' });
  try {
    const checked = checkScheme(scheme, requirements);
    const next = reduceSession(state, {
      kind: 'recordCheck',
      designRevision: scheme.meta.revision,
      passed: checked.issues.length === 0,
      issues: checked.issues.slice(0, 100).map((issue) => `[${issue.code}] ${issue.message}`),
      conflicts: checked.conflicts,
    });
    onProgress?.({
      kind: 'stage',
      stage: 'lint',
      status: 'done',
      detail: checked.issues.length === 0 ? '检查通过' : `${String(checked.issues.length)} 项待处理`,
    });
    return { state: next, scheme, brief: checked.brief, issues: checked.issues, conflicts: checked.conflicts };
  } catch (error) {
    onProgress?.({ kind: 'stage', stage: 'lint', status: 'error', detail: errorText(error) });
    throw error;
  }
}
