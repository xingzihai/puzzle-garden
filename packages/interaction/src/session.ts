/* eslint-disable max-lines */
/**
 * 交互会话状态机：纯 reducer，不做 I/O、不调用模型、不启动构建。
 *
 * 负责：intake → understand → clarify → design → check → review → revise / confirm → compile
 * → build → post-review → accept / targeted-revision / redesign 的合法迁移；
 * 方案版本、用户确认、构建绑定、评审绑定与可序列化事件。
 * 不负责：读写 .work/sessions（SessionStore 只给接口）、LLM 调用、构建 runner。
 *
 * 不变量：
 * - 同一 design id 的 revision 必须逐次 +1；旧版本保留在 designs。
 * - 确认后不能静默改方案；必须显式 requestRevision 进入 revise，再提出新 revision。
 * - compile / startBuild 只接受当前 revision 且等于 confirmedRevision。
 * - build 结果必须绑定启动时的 runId；评审必须同时匹配 design revision 与 runId。
 */
import {
  designConflictFromDatum,
  isOpenBlockingConflict,
  mergeDesignConflicts,
  resolveDesignConflict,
} from './design-conflict.ts';
import type { DesignConflict } from './design-conflict.ts';
import { DesignIntent } from './design-intent.ts';
import { deriveFloorDatum, FloorDatumAction, FloorDatumChoice } from './floor-datum.ts';
import type { FloorDatum, FloorDatumConflict } from './floor-datum.ts';
import { Identifier, Text } from './primitives.ts';
import { RequirementGraph } from './requirements.ts';
import { ReviewReport } from './review.ts';
import type { MustVerdict } from './review.ts';
import { ReviewWaiver } from './review-evidence.ts';
import { applyReviewWaivers } from './review-generate.ts';
import { DesignScheme } from './scheme.ts';
import type { BuildBrief } from './build.ts';

export const SESSION_STAGES = [
  'intake',
  'understand',
  'clarify',
  'design',
  'check',
  'review',
  'revise',
  'confirm',
  'compile',
  'build',
  'post-review',
  'accept',
  'targeted-revision',
  'redesign',
  /** 运行失败后的终态；失败原因与失败前阶段见 SessionState.failure。 */
  'error',
] as const;
export type SessionStage = (typeof SESSION_STAGES)[number];

/** 合法迁移表；命令 reducer 与外部 UI 都可以用它做禁用态。 */
export const STAGE_TRANSITIONS: Readonly<Record<SessionStage, readonly SessionStage[]>> = {
  intake: ['understand'],
  understand: ['clarify', 'design'],
  clarify: ['understand', 'design'],
  design: ['check', 'review'],
  check: ['review', 'design'],
  review: ['confirm', 'revise'],
  revise: ['check'],
  confirm: ['compile', 'revise'],
  compile: ['build', 'revise', 'post-review'],
  build: ['post-review', 'compile'],
  'post-review': ['accept', 'targeted-revision', 'redesign', 'revise'],
  accept: [],
  'targeted-revision': ['revise'],
  redesign: ['revise'],
  error: [],
};

export function canTransition(from: SessionStage, to: SessionStage): boolean {
  return from === to || STAGE_TRANSITIONS[from].includes(to);
}

export class SessionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTransitionError';
  }
}

export interface ClarificationQuestion {
  readonly id: string;
  readonly text: string;
}

export interface ClarificationAnswer {
  readonly questionId: string;
  readonly answer: string;
}

export interface SessionCheck {
  readonly designRevision: number;
  readonly passed: boolean;
  readonly issues: readonly string[];
}

export interface BuildBinding {
  readonly runId: string;
  readonly designId: string;
  readonly designRevision: number;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly failure: string | null;
}

/** 被后续构建评审取代的旧评审；只作历史展示，不能作为当前接受依据。 */
export interface StaleReview {
  readonly review: ReviewReport;
  readonly stale: true;
  readonly supersededByRunId: string;
}

export type SessionEvent =
  | { readonly seq: number; readonly type: 'session.start'; readonly sessionId: string }
  | { readonly seq: number; readonly type: 'user.message'; readonly text: string }
  | { readonly seq: number; readonly type: 'assistant.message'; readonly text: string }
  | {
      readonly seq: number;
      readonly type: 'requirements.version';
      readonly graphId: string;
      readonly revision: number;
    }
  | {
      readonly seq: number;
      readonly type: 'clarify.questions';
      readonly questions: readonly ClarificationQuestion[];
    }
  | { readonly seq: number; readonly type: 'clarify.answers'; readonly answers: readonly ClarificationAnswer[] }
  | { readonly seq: number; readonly type: 'clarify.skipped' }
  | { readonly seq: number; readonly type: 'design.version'; readonly designId: string; readonly revision: number }
  | {
      readonly seq: number;
      readonly type: 'datum.choice';
      readonly conflictId: string;
      readonly action: 'raise-site' | 'accept-step' | 'waive' | 'redesign';
    }
  | {
      readonly seq: number;
      readonly type: 'conflict.choice';
      readonly conflictId: string;
      readonly optionId: string;
    }
  | {
      readonly seq: number;
      readonly type: 'design.check';
      readonly revision: number;
      readonly passed: boolean;
      readonly issueCount: number;
    }
  | {
      readonly seq: number;
      readonly type: 'design.revision-requested';
      readonly fromRevision: number | null;
      readonly reason: string;
    }
  | { readonly seq: number; readonly type: 'design.confirmed'; readonly revision: number }
  | {
      readonly seq: number;
      readonly type: 'brief.compiled';
      readonly designId: string;
      readonly revision: number;
      readonly taskChars: number;
    }
  | {
      readonly seq: number;
      readonly type: 'build.started';
      readonly runId: string;
      readonly designId: string;
      readonly revision: number;
    }
  | {
      readonly seq: number;
      readonly type: 'build.finished';
      readonly runId: string;
      readonly status: 'succeeded' | 'failed' | 'cancelled';
      readonly failure: string | null;
    }
  | { readonly seq: number; readonly type: 'review.completed'; readonly report: ReviewReport }
  | {
      readonly seq: number;
      readonly type: 'review.waived';
      readonly mustId: string;
      readonly revision: number;
      readonly choice: string;
    }
  | {
      readonly seq: number;
      readonly type: 'session.outcome';
      readonly outcome: 'accept' | 'targeted-revision' | 'redesign';
      readonly instructions: string;
    };

export interface SessionFailure {
  /** 失败前所处阶段；stage=error 后仍能说明失败发生在哪一步。 */
  readonly stage: SessionStage;
  /** 机器可读错误码（如 expand-invalid）；非生成错误为 session-failed。 */
  readonly code: string;
  /** 可读错误信息，包含下一步建议。 */
  readonly message: string;
}

export interface SessionState {
  readonly sessionId: string;
  readonly stage: SessionStage;
  /** 运行失败时写入；成功后保持 null，旧会话文件可能没有这个字段。 */
  readonly failure?: SessionFailure | null;
  readonly requirements: RequirementGraph | null;
  readonly designs: readonly DesignScheme[];
  /** 与 designs 对应的模型意图；旧会话文件可能没有这个字段。 */
  readonly intents?: readonly DesignIntent[];
  readonly currentDesignRevision: number | null;
  readonly confirmedDesignRevision: number | null;
  readonly questions: readonly ClarificationQuestion[];
  readonly answers: readonly ClarificationAnswer[];
  readonly check: SessionCheck | null;
  /** 当前方案的室内 / 室外 / 入口标高事实；旧会话可能没有。 */
  readonly datum?: FloorDatum | null;
  /** 要求无台阶但实际存在高差时的持久化冲突；旧会话可能没有。 */
  readonly datumConflict?: FloorDatumConflict | null;
  /** 用户对 datumConflict 的显式选择；null 表示尚未选择。 */
  readonly datumChoice?: FloorDatumChoice | null;
  /** gate / datum / 室外分区 / 家具降级的统一冲突列表。 */
  readonly designConflicts?: readonly DesignConflict[];
  readonly brief: BuildBrief | null;
  readonly build: BuildBinding | null;
  readonly review: ReviewReport | null;
  /** 被新构建评审取代的旧评审；旧会话文件可能没有这个字段。 */
  readonly reviewHistory?: readonly StaleReview[];
  /** 用户显式评审豁免；旧会话可能没有。只对 waiver.designRevision 对应版本生效。 */
  readonly reviewWaivers?: readonly ReviewWaiver[];
  readonly revisionReason: string | null;
  readonly events: readonly SessionEvent[];
  readonly nextEventSeq: number;
}

export type SessionCommand =
  | { readonly kind: 'userMessage'; readonly text: string }
  | { readonly kind: 'assistantMessage'; readonly text: string }
  | { readonly kind: 'recordRequirements'; readonly graph: RequirementGraph }
  | { readonly kind: 'askQuestions'; readonly questions: readonly ClarificationQuestion[] }
  | {
      readonly kind: 'answerQuestions';
      readonly answers: readonly ClarificationAnswer[];
      readonly graph: RequirementGraph | null;
    }
  | { readonly kind: 'skipClarify' }
  | {
      readonly kind: 'proposeDesign';
      readonly scheme: DesignScheme;
      readonly intent?: DesignIntent;
      readonly datum?: FloorDatum;
      readonly datumConflict?: FloorDatumConflict | null;
      readonly conflicts?: readonly DesignConflict[];
    }
  | {
      readonly kind: 'chooseDatumOption';
      readonly action: FloorDatumAction;
      readonly note?: string | null;
    }
  | {
      readonly kind: 'chooseConflictOption';
      readonly conflictId: string;
      readonly optionId: string;
      readonly note?: string | null;
    }
  | {
      readonly kind: 'recordCheck';
      readonly designRevision: number;
      readonly passed: boolean;
      readonly issues: readonly string[];
      readonly conflicts?: readonly DesignConflict[];
    }
  | { readonly kind: 'requestRevision'; readonly reason: string }
  | { readonly kind: 'confirmDesign'; readonly designRevision: number }
  | { readonly kind: 'compileBrief'; readonly brief: BuildBrief }
  | { readonly kind: 'startBuild'; readonly runId: string }
  | {
      readonly kind: 'finishBuild';
      readonly runId: string;
      readonly status: 'succeeded' | 'failed' | 'cancelled';
      readonly failure: string | null;
    }
  | { readonly kind: 'recordReview'; readonly report: ReviewReport }
  | {
      readonly kind: 'adoptBuildReview';
      readonly runId: string;
      readonly report: ReviewReport;
      /** 调用方看到的当前 build.runId；防止旧报告把新 run 回滚成旧 run。 */
      readonly replacesRunId?: string | null;
    }
  | {
      readonly kind: 'waiveReviewMust';
      readonly mustId: string;
      readonly choice: string;
      readonly note?: string | null;
    }
  | {
      readonly kind: 'resolveReview';
      readonly action: 'accept' | 'targeted-revision' | 'redesign';
      readonly instructions: string;
    };

/** 会话存储接口：真实实现（fs / blob）后续在 tools 层注入，本包不做 I/O。 */
export interface SessionStore {
  load(sessionId: string): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  appendEvents(sessionId: string, events: readonly SessionEvent[]): Promise<void>;
  putBlob?(bytes: Uint8Array): Promise<{ readonly sha256: string; readonly bytes: number }>;
  getBlob?(sha256: string): Promise<Uint8Array | null>;
}

const MAX_DESIGNS = 64;
const MAX_EVENTS = 5000;
const MAX_QUESTIONS = 3;
const MAX_CHECK_ISSUES = 100;
const MAX_REVIEW_HISTORY = 32;

function isStage(value: SessionStage, allowed: readonly SessionStage[], command: string): void {
  if (!allowed.includes(value)) {
    throw new SessionTransitionError(
      `命令 ${command} 不能在阶段 ${value} 执行；允许阶段：${allowed.join('、') || '无'}`,
    );
  }
}

function textOf(value: string, label: string): string {
  if (value.trim() === '') throw new SessionTransitionError(`${label}不能为空`);
  return Text.parse(value);
}

function currentDesign(state: SessionState): DesignScheme | undefined {
  return state.designs[state.designs.length - 1];
}

/**
 * 接受门槛：ReviewReport 的每条 must 必须 met，或带有绑定当前 revision 的显式用户 waiver。
 * unverified / not-met 都返回给调用方用于拒绝 accept；空 musts 视为无需逐条证明。
 */
export function reviewAcceptBlockers(
  report: ReviewReport,
  waivers: readonly ReviewWaiver[] = [],
): readonly MustVerdict[] {
  const revision = report.designVersion.revision;
  const explicit = waivers.flatMap((raw) => {
    const parsed = ReviewWaiver.safeParse(raw);
    return parsed.success && parsed.data.designRevision === revision ? [parsed.data] : [];
  });
  return report.verdict.musts.filter((must) => {
    if (must.status === 'met') return false;
    if (
      must.status === 'waived' &&
      must.waiver !== null &&
      must.waiver.mustId === must.requirementId &&
      must.waiver.designRevision === revision &&
      explicit.some((waiver) => waiver.mustId === must.requirementId)
    ) {
      return false;
    }
    // 显式 waiver 只覆盖 unverified；not-met 是硬证据，任何 waiver 都不能放行。
    return must.status !== 'unverified' || !explicit.some((waiver) => waiver.mustId === must.requirementId);
  });
}

/** web/API 唯一可见的评审：必须与当前 build.runId 绑定；旧 run 的评审视为 stale。 */
export function currentReview(state: SessionState): ReviewReport | null {
  return state.review !== null && state.build !== null && state.review.buildRunId === state.build.runId
    ? state.review
    : null;
}

/** 只保留当前 revision 的豁免；新 revision 不继承旧 revision 的 waiver。 */
function mergeReviewWaivers(
  existing: readonly ReviewWaiver[],
  incoming: readonly ReviewWaiver[],
  revision: number,
): readonly ReviewWaiver[] {
  const byMust = new Map<string, ReviewWaiver>();
  for (const raw of [...existing, ...incoming]) {
    const parsed = ReviewWaiver.safeParse(raw);
    if (!parsed.success || parsed.data.designRevision !== revision) continue;
    byMust.set(parsed.data.mustId, parsed.data);
  }
  return [...byMust.values()];
}

function appendEvent(
  state: SessionState,
  make: (seq: number) => SessionEvent,
  patch: Partial<Omit<SessionState, 'events' | 'nextEventSeq'>>,
): SessionState {
  if (patch.stage !== undefined && patch.stage !== state.stage && !canTransition(state.stage, patch.stage)) {
    throw new SessionTransitionError(`非法阶段迁移：${state.stage} → ${patch.stage}`);
  }
  if (state.events.length >= MAX_EVENTS) {
    throw new SessionTransitionError(`会话事件超过上限 ${String(MAX_EVENTS)}；请拆分会话或归档旧事件`);
  }
  const event = make(state.nextEventSeq);
  return {
    ...state,
    ...patch,
    events: [...state.events, event],
    nextEventSeq: state.nextEventSeq + 1,
  };
}

/** 创建会话：只产生 session.start 事件，仍处于 intake。 */
export function createSession(sessionId: string): SessionState {
  const id = Identifier.parse(sessionId);
  return {
    sessionId: id,
    stage: 'intake',
    failure: null,
    requirements: null,
    designs: [],
    intents: [],
    currentDesignRevision: null,
    confirmedDesignRevision: null,
    questions: [],
    answers: [],
    check: null,
    brief: null,
    build: null,
    review: null,
    reviewHistory: [],
    reviewWaivers: [],
    revisionReason: null,
    events: [{ seq: 0, type: 'session.start', sessionId: id }],
    nextEventSeq: 1,
  };
}

function updateRequirements(state: SessionState, graph: RequirementGraph, stage: SessionStage): SessionState {
  const parsed = RequirementGraph.parse(graph);
  if (state.requirements !== null) {
    if (parsed.id !== state.requirements.id) {
      throw new SessionTransitionError(`需求图 id 不能在同一会话内改变：${state.requirements.id} → ${parsed.id}`);
    }
    if (parsed.revision !== state.requirements.revision + 1) {
      throw new SessionTransitionError(
        `需求图 revision 必须递增 1：当前 ${String(state.requirements.revision)}，收到 ${String(parsed.revision)}`,
      );
    }
  }
  return appendEvent(
    state,
    (seq) => ({ seq, type: 'requirements.version', graphId: parsed.id, revision: parsed.revision }),
    { requirements: parsed, stage },
  );
}

function answeredQuestions(state: SessionState, answers: readonly ClarificationAnswer[]): void {
  if (answers.length !== state.questions.length) {
    throw new SessionTransitionError(
      `澄清回答数量 ${String(answers.length)} 与问题数量 ${String(state.questions.length)} 不一致`,
    );
  }
  const asked = new Set(state.questions.map((question) => question.id));
  const seen = new Set<string>();
  for (const answer of answers) {
    if (!asked.has(answer.questionId)) {
      throw new SessionTransitionError(`澄清回答引用了不存在的问题 ${answer.questionId}`);
    }
    if (seen.has(answer.questionId)) {
      throw new SessionTransitionError(`澄清问题 ${answer.questionId} 被回答多次`);
    }
    seen.add(answer.questionId);
    Text.parse(answer.answer);
  }
}

/**
 * 推进一次会话。非法命令抛 SessionTransitionError；成功时返回新状态（含新事件），不修改入参。
 */
export function reduceSession(state: SessionState, command: SessionCommand): SessionState {
  switch (command.kind) {
    case 'userMessage': {
      const text = textOf(command.text, '用户消息');
      return appendEvent(state, (seq) => ({ seq, type: 'user.message', text }), {});
    }
    case 'assistantMessage': {
      const text = textOf(command.text, '代理消息');
      return appendEvent(state, (seq) => ({ seq, type: 'assistant.message', text }), {});
    }
    case 'recordRequirements': {
      isStage(state.stage, ['intake', 'understand', 'clarify'], command.kind);
      return updateRequirements(state, command.graph, 'understand');
    }
    case 'askQuestions': {
      isStage(state.stage, ['understand'], command.kind);
      if (command.questions.length < 1 || command.questions.length > MAX_QUESTIONS) {
        throw new SessionTransitionError(`一次最多问 ${String(MAX_QUESTIONS)} 个高影响问题`);
      }
      const ids = new Set<string>();
      for (const question of command.questions) {
        Identifier.parse(question.id);
        Text.parse(question.text);
        if (ids.has(question.id)) throw new SessionTransitionError(`澄清问题 id 重复：${question.id}`);
        ids.add(question.id);
      }
      return appendEvent(state, (seq) => ({ seq, type: 'clarify.questions', questions: command.questions }), {
        stage: 'clarify',
        questions: command.questions,
        answers: [],
      });
    }
    case 'answerQuestions': {
      isStage(state.stage, ['clarify'], command.kind);
      answeredQuestions(state, command.answers);
      let next = state;
      if (command.graph !== null) next = updateRequirements(next, command.graph, 'clarify');
      return appendEvent(next, (seq) => ({ seq, type: 'clarify.answers', answers: command.answers }), {
        stage: 'design',
        answers: command.answers,
        revisionReason: null,
      });
    }
    case 'skipClarify': {
      isStage(state.stage, ['understand'], command.kind);
      return appendEvent(state, (seq) => ({ seq, type: 'clarify.skipped' }), {
        stage: 'design',
        questions: [],
        answers: [],
      });
    }
    case 'proposeDesign': {
      isStage(state.stage, ['design', 'revise'], command.kind);
      const scheme = DesignScheme.parse(command.scheme);
      const intent = command.intent === undefined ? undefined : DesignIntent.parse(command.intent);
      if (intent !== undefined && (state.intents?.length ?? 0) >= MAX_DESIGNS) {
        throw new SessionTransitionError(`DesignIntent 版本超过上限 ${String(MAX_DESIGNS)}`);
      }
      const previous = currentDesign(state);
      const derivedDatum = state.requirements === null ? null : deriveFloorDatum(scheme, state.requirements);
      const datumConflict =
        command.datumConflict !== undefined ? command.datumConflict : (derivedDatum?.conflict ?? null);
      const conflicts = mergeDesignConflicts(
        command.conflicts ?? [],
        datumConflict === null ? [] : [designConflictFromDatum(datumConflict)],
      );
      if (previous === undefined) {
        if (scheme.meta.revision !== 1) {
          throw new SessionTransitionError(`首个方案 revision 必须是 1，收到 ${String(scheme.meta.revision)}`);
        }
        if (state.designs.length >= MAX_DESIGNS) {
          throw new SessionTransitionError(`方案版本超过上限 ${String(MAX_DESIGNS)}`);
        }
      } else {
        if (scheme.meta.id !== previous.meta.id) {
          throw new SessionTransitionError(`方案 id 不能在同一会话内改变：${previous.meta.id} → ${scheme.meta.id}`);
        }
        if (scheme.meta.revision !== previous.meta.revision + 1) {
          throw new SessionTransitionError(
            `方案 revision 必须递增 1：当前 ${String(previous.meta.revision)}，收到 ${String(scheme.meta.revision)}`,
          );
        }
        if (state.designs.length >= MAX_DESIGNS) {
          throw new SessionTransitionError(`方案版本超过上限 ${String(MAX_DESIGNS)}`);
        }
      }
      return appendEvent(
        state,
        (seq) => ({ seq, type: 'design.version', designId: scheme.meta.id, revision: scheme.meta.revision }),
        {
          stage: 'check',
          designs: [
            ...state.designs.map((design, index) =>
              index === state.designs.length - 1
                ? DesignScheme.parse({ ...design, meta: { ...design.meta, status: 'superseded' } })
                : design,
            ),
            scheme,
          ],
          ...(intent === undefined ? {} : { intents: [...(state.intents ?? []), intent] }),
          datum: command.datum ?? derivedDatum?.datum ?? null,
          datumConflict,
          datumChoice: null,
          designConflicts: conflicts,
          reviewWaivers: (state.reviewWaivers ?? []).filter((waiver) => waiver.designRevision === scheme.meta.revision),
          currentDesignRevision: scheme.meta.revision,
          confirmedDesignRevision: previous === undefined ? null : state.confirmedDesignRevision,
          check: null,
          brief: null,
          build: null,
          review: null,
          revisionReason: null,
        },
      );
    }
    case 'chooseDatumOption': {
      isStage(state.stage, ['design', 'check', 'review'], command.kind);
      if (state.datumConflict === null || state.datumConflict === undefined) {
        throw new SessionTransitionError('当前方案没有入口标高冲突，不能选择标高选项');
      }
      const action = FloorDatumAction.parse(command.action);
      const choice = FloorDatumChoice.parse({
        conflictId: state.datumConflict.id,
        action,
        note: command.note ?? null,
      });
      const canClearCheck = action === 'accept-step' || action === 'waive';
      let check = state.check;
      if (canClearCheck && check !== null) {
        const remaining = check.issues.filter((issue) => !issue.startsWith('[datum-conflict]'));
        check = { ...check, issues: remaining, passed: remaining.length === 0 };
      }
      const conflicts = resolveDesignConflict(
        state.designConflicts ?? [],
        choice.conflictId,
        choice.action,
        choice.note,
      );
      return appendEvent(
        state,
        (seq) => ({ seq, type: 'datum.choice', conflictId: choice.conflictId, action: choice.action }),
        {
          datumChoice: choice,
          designConflicts: conflicts,
          ...(check === null ? {} : { check }),
          ...(canClearCheck && check?.passed === true && (state.stage === 'check' || state.stage === 'design')
            ? { stage: 'review' as const }
            : {}),
        },
      );
    }
    case 'chooseConflictOption': {
      isStage(state.stage, ['design', 'check', 'review'], command.kind);
      const conflicts = state.designConflicts ?? [];
      const target = conflicts.find((conflict) => conflict.id === command.conflictId);
      if (target === undefined) {
        throw new SessionTransitionError(`没有找到冲突 ${command.conflictId}`);
      }
      const option = target.options.find((candidate) => candidate.id === command.optionId);
      if (option === undefined) {
        throw new SessionTransitionError(`冲突 ${target.id} 没有选项 ${command.optionId}`);
      }
      if (target.kind === 'datum') {
        const action = FloorDatumAction.safeParse(command.optionId);
        if (!action.success) {
          throw new SessionTransitionError(`datum 冲突选项不合法：${command.optionId}`);
        }
        return reduceSession(state, {
          kind: 'chooseDatumOption',
          action: action.data,
          ...(command.note === undefined ? {} : { note: command.note }),
        });
      }
      const resolved = option.action === 'accept' || option.action === 'waive' || option.action === 'accept-step';
      const nextConflicts = resolveDesignConflict(conflicts, target.id, option.id, command.note ?? null);
      let check = state.check;
      if (resolved && check !== null) {
        const remaining = check.issues.filter(
          (issue) =>
            !issue.startsWith(`[${target.code}]`) &&
            !(issue.startsWith('[scheme-gate]') && issue.includes(`[${target.code}]`)),
        );
        check = { ...check, issues: remaining, passed: remaining.length === 0 };
      }
      return appendEvent(
        state,
        (seq) => ({ seq, type: 'conflict.choice', conflictId: target.id, optionId: option.id }),
        {
          designConflicts: nextConflicts,
          ...(check === null ? {} : { check }),
          ...(resolved && check?.passed === true && (state.stage === 'check' || state.stage === 'design')
            ? { stage: 'review' as const }
            : {}),
        },
      );
    }
    case 'recordCheck': {
      isStage(state.stage, ['check'], command.kind);
      if (state.currentDesignRevision !== command.designRevision) {
        throw new SessionTransitionError(
          `检查绑定 revision ${String(command.designRevision)}，当前 revision 是 ${String(state.currentDesignRevision)}`,
        );
      }
      if (command.issues.length > MAX_CHECK_ISSUES) {
        throw new SessionTransitionError(`检查问题超过上限 ${String(MAX_CHECK_ISSUES)}`);
      }
      const check: SessionCheck = {
        designRevision: command.designRevision,
        passed: command.passed,
        issues: command.issues,
      };
      return appendEvent(
        state,
        (seq) => ({
          seq,
          type: 'design.check',
          revision: command.designRevision,
          passed: command.passed,
          issueCount: command.issues.length,
        }),
        {
          stage: command.passed ? 'review' : 'design',
          check,
          designConflicts: mergeDesignConflicts(state.designConflicts ?? [], command.conflicts ?? []),
        },
      );
    }
    case 'requestRevision': {
      isStage(
        state.stage,
        ['review', 'confirm', 'compile', 'post-review', 'targeted-revision', 'redesign'],
        command.kind,
      );
      const reason = textOf(command.reason, '修改原因');
      return appendEvent(
        state,
        (seq) => ({
          seq,
          type: 'design.revision-requested',
          fromRevision: state.currentDesignRevision,
          reason,
        }),
        { stage: 'revise', revisionReason: reason },
      );
    }
    case 'confirmDesign': {
      isStage(state.stage, ['review'], command.kind);
      if (state.currentDesignRevision !== command.designRevision) {
        throw new SessionTransitionError(
          `确认绑定 revision ${String(command.designRevision)}，当前 revision 是 ${String(state.currentDesignRevision)}`,
        );
      }
      if (state.check === null || !state.check.passed || state.check.designRevision !== command.designRevision) {
        throw new SessionTransitionError('当前 revision 没有通过的确定性检查，不能确认');
      }
      const openConflict = (state.designConflicts ?? []).find(isOpenBlockingConflict);
      if (openConflict !== undefined) {
        throw new SessionTransitionError(`冲突 ${openConflict.id} 尚未选择；不能静默确认`);
      }
      if (state.datumConflict !== null && state.datumConflict !== undefined) {
        const choice = state.datumChoice;
        if (choice === null || choice === undefined) {
          throw new SessionTransitionError('入口标高冲突尚未选择；不能使用静默默认值确认');
        }
        if (choice.action === 'redesign') {
          throw new SessionTransitionError('已选择回到设计修改入口；不能直接确认当前 revision');
        }
        if (choice.action === 'raise-site' && state.datum?.gradeY !== state.datum?.standingY) {
          throw new SessionTransitionError('已选择抬高场地/基座，但当前方案标高尚未落实；请先生成新 revision');
        }
      }
      return appendEvent(state, (seq) => ({ seq, type: 'design.confirmed', revision: command.designRevision }), {
        stage: 'confirm',
        confirmedDesignRevision: command.designRevision,
        designs: state.designs.map((design, index) =>
          index === state.designs.length - 1
            ? DesignScheme.parse({ ...design, meta: { ...design.meta, status: 'confirmed' } })
            : design,
        ),
      });
    }
    case 'compileBrief': {
      isStage(state.stage, ['confirm'], command.kind);
      if (
        state.currentDesignRevision === null ||
        state.confirmedDesignRevision !== state.currentDesignRevision ||
        state.brief !== null
      ) {
        throw new SessionTransitionError('只能编译当前已确认且尚未编译的 revision');
      }
      if (
        command.brief.spec.schemeId !== currentDesign(state)?.meta.id ||
        command.brief.spec.schemeRevision !== state.currentDesignRevision
      ) {
        throw new SessionTransitionError('BuildBrief 的方案 id / revision 与当前已确认 revision 不一致');
      }
      return appendEvent(
        state,
        (seq) => ({
          seq,
          type: 'brief.compiled',
          designId: command.brief.spec.schemeId,
          revision: command.brief.spec.schemeRevision,
          taskChars: command.brief.taskMarkdown.length,
        }),
        { stage: 'compile', brief: command.brief },
      );
    }
    case 'startBuild': {
      isStage(state.stage, ['compile'], command.kind);
      const runId = Identifier.parse(command.runId);
      const scheme = currentDesign(state);
      if (
        state.brief === null ||
        scheme === undefined ||
        state.currentDesignRevision === null ||
        state.confirmedDesignRevision !== state.currentDesignRevision ||
        state.brief.spec.schemeRevision !== state.currentDesignRevision ||
        state.brief.spec.schemeId !== scheme.meta.id
      ) {
        throw new SessionTransitionError('没有与当前已确认 revision 绑定的 BuildBrief，不能启动构建');
      }
      const build: BuildBinding = {
        runId,
        designId: scheme.meta.id,
        designRevision: scheme.meta.revision,
        status: 'running',
        failure: null,
      };
      return appendEvent(
        state,
        (seq) => ({
          seq,
          type: 'build.started',
          runId,
          designId: scheme.meta.id,
          revision: scheme.meta.revision,
        }),
        { stage: 'build', build },
      );
    }
    case 'finishBuild': {
      isStage(state.stage, ['build'], command.kind);
      if (state.build?.runId !== command.runId) {
        throw new SessionTransitionError(`构建结果 runId ${command.runId} 与当前构建不一致`);
      }
      if (command.status === 'failed' && (command.failure === null || command.failure.trim() === '')) {
        throw new SessionTransitionError('构建失败必须给出可读的失败原因');
      }
      const failure = command.failure === null ? null : Text.parse(command.failure);
      const build: BuildBinding = { ...state.build, status: command.status, failure };
      return appendEvent(
        state,
        (seq) => ({ seq, type: 'build.finished', runId: command.runId, status: command.status, failure }),
        { stage: command.status === 'succeeded' ? 'post-review' : 'compile', build },
      );
    }
    case 'recordReview': {
      isStage(state.stage, ['post-review'], command.kind);
      const report = ReviewReport.parse(command.report);
      const build = state.build;
      if (build?.status !== 'succeeded') {
        throw new SessionTransitionError('没有成功的构建结果，不能记录评审');
      }
      if (report.buildRunId !== build.runId) {
        throw new SessionTransitionError(`评审 runId ${report.buildRunId} 与构建 ${build.runId} 不一致`);
      }
      if (report.designVersion.schemeId !== build.designId || report.designVersion.revision !== build.designRevision) {
        throw new SessionTransitionError('评审的设计版本与构建绑定的方案版本不一致');
      }
      // 评审报告里的 waiver 只是展示；用户同意必须来自显式 waiveReviewMust 命令。
      // 不把 report.verdict.musts[].waiver 合并进状态，避免自定义 reviewBuilder 伪造用户豁免。
      const reviewWaivers = mergeReviewWaivers(state.reviewWaivers ?? [], [], report.designVersion.revision);
      // 新评审替换旧评审时，旧评审必须进入 stale 历史；同一 run 的重试不重复记 stale。
      const stale: readonly StaleReview[] =
        state.review !== null && state.review.buildRunId !== report.buildRunId
          ? [{ review: state.review, stale: true, supersededByRunId: report.buildRunId }]
          : [];
      const reviewHistory = [...(state.reviewHistory ?? []), ...stale].slice(-MAX_REVIEW_HISTORY);
      return appendEvent(state, (seq) => ({ seq, type: 'review.completed', report }), {
        review: report,
        reviewHistory,
        reviewWaivers,
      });
    }
    case 'adoptBuildReview': {
      // CLI 可能直接在 confirmed revision 上完成一次新 run；允许从 compile / build 跳转到 post-review。
      isStage(state.stage, ['post-review', 'compile', 'build'], command.kind);
      const runId = Identifier.parse(command.runId);
      const report = ReviewReport.parse(command.report);
      if (report.buildRunId !== runId) {
        throw new SessionTransitionError(`评审 runId ${report.buildRunId} 与构建 runId ${runId} 不一致`);
      }
      if (command.replacesRunId !== undefined && (state.build?.runId ?? null) !== command.replacesRunId) {
        throw new SessionTransitionError(
          `评审要替换的 run ${String(command.replacesRunId)} 与当前 build ${state.build?.runId ?? '无'} 不一致`,
        );
      }
      if ((state.reviewHistory ?? []).some((entry) => entry.review.buildRunId === runId)) {
        throw new SessionTransitionError(`run ${runId} 的评审已 stale，不能回滚成当前评审`);
      }
      const scheme = currentDesign(state);
      const revision = state.confirmedDesignRevision;
      if (
        scheme === undefined ||
        revision === null ||
        state.currentDesignRevision !== revision ||
        scheme.meta.revision !== revision ||
        report.designVersion.schemeId !== scheme.meta.id ||
        report.designVersion.revision !== revision
      ) {
        throw new SessionTransitionError(
          `评审的设计版本 ${report.designVersion.schemeId}@${String(report.designVersion.revision)} 与当前已确认方案 ${scheme?.meta.id ?? '无'}@${String(revision)} 不一致`,
        );
      }
      // 旧评审只进入历史；新 run 的评审成为唯一当前评审。
      const stale: readonly StaleReview[] =
        state.review !== null && state.review.buildRunId !== runId
          ? [{ review: state.review, stale: true, supersededByRunId: runId }]
          : [];
      const reviewHistory = [...(state.reviewHistory ?? []), ...stale].slice(-MAX_REVIEW_HISTORY);
      return appendEvent(state, (seq) => ({ seq, type: 'review.completed', report }), {
        stage: 'post-review',
        build: {
          runId,
          designId: scheme.meta.id,
          designRevision: revision,
          status: 'succeeded',
          failure: null,
        },
        review: report,
        reviewWaivers: mergeReviewWaivers(state.reviewWaivers ?? [], [], revision),
        reviewHistory,
      });
    }
    case 'waiveReviewMust': {
      isStage(state.stage, ['post-review'], command.kind);
      const report = state.review;
      if (report === null) {
        throw new SessionTransitionError('还没有评审报告，不能豁免必须项');
      }
      const mustId = Identifier.parse(command.mustId);
      const choice = textOf(command.choice, '豁免理由');
      const noteText = command.note === undefined || command.note === null ? null : command.note.trim();
      const note = noteText === null || noteText === '' ? null : Text.parse(noteText);
      const must = report.verdict.musts.find((entry) => entry.requirementId === mustId);
      if (must === undefined) {
        throw new SessionTransitionError(`评审中没有必须项 ${mustId}，不能豁免`);
      }
      if (must.status === 'met') {
        throw new SessionTransitionError(`必须项 ${mustId} 已 met，不需要豁免`);
      }
      const revision = report.designVersion.revision;
      const waiver = ReviewWaiver.parse({
        mustId,
        designRevision: revision,
        by: 'user',
        choice,
        conflictId: null,
        note,
      });
      const reviewWaivers = mergeReviewWaivers(state.reviewWaivers ?? [], [waiver], revision);
      const review = applyReviewWaivers(report, reviewWaivers);
      return appendEvent(state, (seq) => ({ seq, type: 'review.waived', mustId, revision, choice }), {
        review,
        reviewWaivers,
      });
    }
    case 'resolveReview': {
      isStage(state.stage, ['post-review'], command.kind);
      if (state.review === null) {
        throw new SessionTransitionError('还没有评审报告，不能决定下一步');
      }
      if (command.action === 'accept') {
        const report = state.review;
        const blockers = reviewAcceptBlockers(report, state.reviewWaivers ?? []);
        const reasons: string[] = [];
        // 库级 accept 也必须绑定当前 build；HTTP 重验只是第二道门，不能替代状态机不变量。
        if (report.buildRunId !== state.build?.runId) {
          reasons.push(
            `评审 runId=${report.buildRunId} 与当前 build=${state.build?.runId ?? '无'} 不一致（不能接受其他 run 的评审）`,
          );
        }
        if (report.verdict.status !== 'satisfied') reasons.push(`verdict=${report.verdict.status}（必须为 satisfied）`);
        if (report.verdict.mustsTruncated) {
          reasons.push('verdict.mustsTruncated=true（必须项列表被截断，不能接受）');
        }
        if (report.nextAction.kind !== 'accept') reasons.push(`nextAction=${report.nextAction.kind}（必须为 accept）`);
        if (
          report.provenance === undefined ||
          report.provenance.evidence === 'none' ||
          report.provenance.specSha256 === null ||
          report.provenance.archiveSha256 === null
        ) {
          reasons.push(
            '评审缺少可验证 evidence provenance（旧 session / 手写报告 / 无证据评审）；必须重新生成并绑定当前 spec / archive / BuildSheet',
          );
        }
        // 防御损坏 / 注入的 review：accept 不能只信 verdict 字符串，客观测量必须全部 pass。
        if (report.objective.measurements.some((entry) => entry.status !== 'pass')) {
          reasons.push('客观测量仍有 fail / not-checked（必须全部 pass）');
        }
        if (blockers.length > 0) {
          reasons.push(
            `必须项未达到接受门槛：${blockers
              .slice(0, 8)
              .map((must) => `${must.requirementId}=${must.status}`)
              .join('、')}`,
          );
        }
        if (reasons.length > 0) {
          throw new SessionTransitionError(
            `评审未达到接受门槛：${reasons.join('；')}；只有 verdict=satisfied、nextAction=accept 且全部 must met/用户显式 waived 才能 accept`,
          );
        }
      }
      const instructions = textOf(command.instructions, '下一步说明');
      return appendEvent(state, (seq) => ({ seq, type: 'session.outcome', outcome: command.action, instructions }), {
        stage: command.action,
      });
    }
  }
}
