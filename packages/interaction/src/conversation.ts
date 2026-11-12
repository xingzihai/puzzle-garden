/* eslint-disable max-lines -- 主循环串起澄清、冲突菜单、检查与确认；拆开会让恢复分支的上下文传递更绕。 */
/**
 * 用户交互 agent 的最小闭环：需求 → 澄清 → 方案 → 确认 / 定向修订 → 编译 → 落盘。
 *
 * 负责：把 generate / session / brief / lint 串成一条可恢复的对话流程；
 * 提问、确认与修改意见全部来自注入的 ConversationIO，测试可用 fake IO 逐字驱动。
 * 不负责：读写 stdin / 文件、真实网络、构建 runner；SessionState 与 artifacts 的持久化由
 * 调用方通过 ConversationStorage 注入（CLI 会接上 store.ts）。
 */
import type { ChatClient } from '@pg/llm/client';

import { compileBuildBrief, lintBrief } from './brief.ts';
import type { BuildBrief } from './build.ts';
import { generateIntentDesign } from './conversation-intent.ts';
import {
  askQuestionWithProgress,
  evaluateSchemeWithProgress,
  extractWithProgress,
  resolveConflictsWithProgress,
} from './conversation-progress.ts';
import type { CheckedScheme } from './conversation-progress.ts';
import type { ConversationArtifactPaths, ConversationIO } from './conversation-types.ts';
import type { DesignIntent } from './design-intent.ts';

export type { ConversationArtifactPaths, ConversationIO } from './conversation-types.ts';
import {
  applySuggestedDefaults,
  askDecision,
  askLintFeedback,
  checkScheme,
  clarificationQuestions,
  exchangesOf,
  showIssues,
  showScheme,
} from './conversation-support.ts';
import { proposeScheme } from './generate.ts';
import type { ProposeSchemeOptions, SubmissionOutputMode } from './generate.ts';
import type { InteractionProgressCallback } from './generate-intent.ts';
import type { BriefIssue } from './lint.ts';
import type { ClarificationExchange } from './prompts.ts';
import type { RequirementGraph as RequirementGraphType } from './requirements.ts';
import { createSession, reduceSession } from './session.ts';
import type { ClarificationAnswer, ClarificationQuestion, SessionState } from './session.ts';
import type { DesignScheme as DesignSchemeType, SchemeScope } from './scheme.ts';

/** 会话与产物的持久化接口；不注入时流程仍可运行，但不会写文件。 */
export interface ConversationStorage {
  save(state: SessionState): Promise<void>;
  writeArtifacts(brief: BuildBrief, intent?: DesignIntent): Promise<ConversationArtifactPaths>;
}

export interface ConversationInput {
  readonly sessionId: string;
  readonly task: string;
  /** 方案 id；缺省由模型决定，修订时始终沿用上一版 id。 */
  readonly schemeId?: string;
  readonly scope?: SchemeScope;
  readonly maxBlocks?: number;
  readonly maxCostCny?: number | null;
  /** 从 store 读回的会话；给出时跳过已完成阶段，继续确认 / 修改。 */
  readonly resume?: SessionState;
}

export interface DesignConversationOptions {
  readonly storage?: ConversationStorage;
  /** 与 input.resume 等价的恢复入口，便于调用方统一放在 options。 */
  readonly resumeState?: SessionState;
  /** intent 默认只生成设计意图并展开；legacy 保留旧 DesignScheme 生成路径。 */
  readonly designMode?: 'intent' | 'legacy';
  /** 用户主动要求修改的最多轮数；默认 3。 */
  readonly maxRevisions?: number;
  /** 澄清最多几轮；默认 2。 */
  readonly maxClarificationRounds?: number;
  /** 生成协议：网页 live 默认 content-json；mock 可保持 tool。 */
  readonly outputMode?: SubmissionOutputMode;
  /** 流式进度；只用于展示与诊断，不进入 SessionState / artifacts。 */
  readonly onProgress?: InteractionProgressCallback;
}

export interface DesignConversationResult {
  readonly state: SessionState;
  readonly scheme: DesignSchemeType;
  readonly brief: BuildBrief | null;
  readonly artifacts: ConversationArtifactPaths | null;
  readonly questions: readonly ClarificationQuestion[];
  readonly answers: readonly ClarificationAnswer[];
  /** 当前方案 revision；确认后等于 confirmedDesignRevision。 */
  readonly revisions: number;
}

/** 输入、恢复或澄清状态不成立时的可读错误；生成 / 状态机错误保持原类型向上抛。 */
export class ConversationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationError';
  }
}

interface ConversationContext {
  readonly client: ChatClient;
  readonly input: ConversationInput;
  readonly io: ConversationIO;
  readonly storage: ConversationStorage | undefined;
  readonly exchanges: readonly ClarificationExchange[];
  readonly maxRevisions: number;
  readonly designMode: 'intent' | 'legacy';
  readonly outputMode: SubmissionOutputMode | undefined;
  readonly onProgress: InteractionProgressCallback | undefined;
}

function requireRequirements(state: SessionState): RequirementGraphType {
  if (state.requirements === null) throw new ConversationError('当前会话还没有需求图，不能继续设计。');
  return state.requirements;
}

function currentScheme(state: SessionState): DesignSchemeType | undefined {
  return state.designs[state.designs.length - 1];
}

async function persist(storage: ConversationStorage | undefined, state: SessionState): Promise<void> {
  if (storage !== undefined) await storage.save(state);
}

/**
 * 第一轮：问最多 3 个问题，拿回答重新抽取需求（revision+1）并记录。
 * 若回答后的需求图仍有高影响问题，最多再问一轮；第二轮后按 suggestedDefault 处理。
 */
async function clarify(
  client: ChatClient,
  state: SessionState,
  userText: string,
  io: ConversationIO,
  storage: ConversationStorage | undefined,
  maxRounds: number,
  onProgress: InteractionProgressCallback | undefined,
): Promise<{
  readonly state: SessionState;
  readonly questions: readonly ClarificationQuestion[];
  readonly answers: readonly ClarificationAnswer[];
  readonly exchanges: readonly ClarificationExchange[];
}> {
  let graph = requireRequirements(state);
  let pending = clarificationQuestions(graph);
  if (pending.length === 0) {
    const next = reduceSession(state, { kind: 'skipClarify' });
    await persist(storage, next);
    return { state: next, questions: [], answers: [], exchanges: [] };
  }

  let next = state;
  const allQuestions: ClarificationQuestion[] = [];
  const allAnswers: ClarificationAnswer[] = [];
  let round = 0;

  while (pending.length > 0 && round < maxRounds) {
    if (round > 0) {
      // 回到 understand 记录上一轮抽取的新需求，再进入第二轮提问。
      next = reduceSession(next, { kind: 'recordRequirements', graph });
      await persist(storage, next);
    }
    next = reduceSession(next, { kind: 'askQuestions', questions: pending });
    await persist(storage, next);

    const roundAnswers: ClarificationAnswer[] = [];
    for (const question of pending) {
      const answer = (await askQuestionWithProgress(io, question, onProgress)).trim();
      if (answer === '') throw new ConversationError(`问题 ${question.id} 的回答不能为空。`);
      roundAnswers.push({ questionId: question.id, answer });
    }
    allQuestions.push(...pending);
    allAnswers.push(...roundAnswers);

    const exchanges = exchangesOf(allQuestions, allAnswers);
    const extracted = await extractWithProgress(
      client,
      {
        userText,
        existingRequirements: graph,
        answers: exchanges,
      },
      onProgress,
    );
    graph = extracted.value;
    round += 1;

    const residual = clarificationQuestions(graph);
    if (residual.length > 0 && round < maxRounds) {
      pending = residual;
      continue;
    }

    let finalGraph = graph;
    if (residual.length > 0) {
      const applied = applySuggestedDefaults(graph);
      finalGraph = applied.graph;
      for (const note of applied.notes) io.say(`澄清达到 ${String(maxRounds)} 轮上限，${note}`);
    }
    next = reduceSession(next, { kind: 'answerQuestions', answers: roundAnswers, graph: finalGraph });
    await persist(storage, next);
    return { state: next, questions: allQuestions, answers: allAnswers, exchanges };
  }

  throw new ConversationError('澄清流程没有产生可继续的需求图。');
}

/** 继续一个已经停在 clarify 阶段的会话：只回答当前问题，不再开启第二轮。 */
async function answerPendingQuestions(
  client: ChatClient,
  state: SessionState,
  userText: string,
  io: ConversationIO,
  storage: ConversationStorage | undefined,
  onProgress: InteractionProgressCallback | undefined,
): Promise<{
  readonly state: SessionState;
  readonly questions: readonly ClarificationQuestion[];
  readonly answers: readonly ClarificationAnswer[];
  readonly exchanges: readonly ClarificationExchange[];
}> {
  const questions = state.questions;
  if (questions.length === 0) throw new ConversationError('会话停在 clarify 阶段，但没有待回答的问题。');
  const answers: ClarificationAnswer[] = [];
  for (const question of questions) {
    const answer = (await askQuestionWithProgress(io, question, onProgress)).trim();
    if (answer === '') throw new ConversationError(`问题 ${question.id} 的回答不能为空。`);
    answers.push({ questionId: question.id, answer });
  }
  const exchanges = exchangesOf(questions, answers);
  const extracted = await extractWithProgress(
    client,
    {
      userText,
      existingRequirements: requireRequirements(state),
      answers: exchanges,
    },
    onProgress,
  );
  const next = reduceSession(state, { kind: 'answerQuestions', answers, graph: extracted.value });
  await persist(storage, next);
  return { state: next, questions, answers, exchanges };
}

async function generateChecked(
  context: ConversationContext,
  state: SessionState,
  revision: number,
  previous: DesignSchemeType | undefined,
  feedback: string | undefined,
): Promise<CheckedScheme> {
  const requirements = requireRequirements(state);
  const scope = context.input.scope ?? previous?.meta.scope;
  if (context.designMode === 'intent') {
    const previousIntent = state.intents?.[state.intents.length - 1];
    const generated = await generateIntentDesign({
      client: context.client,
      requirements,
      revision,
      exchanges: context.exchanges,
      say: (text) => {
        context.io.say(text);
      },
      ...(context.input.schemeId === undefined ? {} : { schemeId: context.input.schemeId }),
      ...(scope === undefined ? {} : { scope }),
      ...(context.input.maxBlocks === undefined ? {} : { maxBlocks: context.input.maxBlocks }),
      ...(context.input.maxCostCny === undefined ? {} : { maxCostCny: context.input.maxCostCny }),
      ...(previous === undefined ? {} : { previousScheme: previous }),
      ...(previousIntent === undefined ? {} : { previousIntent }),
      ...(feedback === undefined ? {} : { feedback }),
      ...(context.outputMode === undefined ? {} : { outputMode: context.outputMode }),
      ...(context.onProgress === undefined ? {} : { onProgress: context.onProgress }),
    });
    const proposed = reduceSession(state, {
      kind: 'proposeDesign',
      scheme: generated.scheme,
      intent: generated.intent,
      datum: generated.facts.datum,
      datumConflict: generated.facts.datumConflict,
      conflicts: generated.conflicts,
    });
    await persist(context.storage, proposed);
    const checked = evaluateSchemeWithProgress(requirements, proposed, generated.scheme, context.onProgress);
    await persist(context.storage, checked.state);
    return checked;
  }
  const options: ProposeSchemeOptions = {
    revision,
    ...(context.input.schemeId === undefined ? {} : { schemeId: context.input.schemeId }),
    ...(scope === undefined ? {} : { scope }),
    ...(context.input.maxBlocks === undefined ? {} : { maxBlocks: context.input.maxBlocks }),
    ...(context.input.maxCostCny === undefined ? {} : { maxCostCny: context.input.maxCostCny }),
    ...(context.exchanges.length === 0 ? {} : { answers: context.exchanges }),
    ...(previous === undefined ? {} : { previousScheme: previous }),
    ...(feedback === undefined ? {} : { feedback }),
  };
  const result = await proposeScheme(context.client, requirements, options);
  const proposed = reduceSession(state, { kind: 'proposeDesign', scheme: result.value });
  await persist(context.storage, proposed);
  const checked = evaluateSchemeWithProgress(requirements, proposed, result.value, context.onProgress);
  await persist(context.storage, checked.state);
  return checked;
}

async function unconfirmed(
  state: SessionState,
  scheme: DesignSchemeType,
  questions: readonly ClarificationQuestion[],
  answers: readonly ClarificationAnswer[],
  io: ConversationIO,
  storage: ConversationStorage | undefined,
  reason: string,
): Promise<DesignConversationResult> {
  // 冲突菜单可能已经推进了状态；退出前必须落盘，不能把用户刚做的选择丢掉。
  await persist(storage, state);
  io.say(reason);
  return {
    state,
    scheme,
    brief: null,
    artifacts: null,
    questions,
    answers,
    revisions: scheme.meta.revision,
  };
}

async function finalize(
  state: SessionState,
  scheme: DesignSchemeType,
  io: ConversationIO,
  storage: ConversationStorage | undefined,
  questions: readonly ClarificationQuestion[],
  answers: readonly ClarificationAnswer[],
): Promise<DesignConversationResult> {
  let next = state;
  if (next.stage === 'review') {
    next = reduceSession(next, { kind: 'confirmDesign', designRevision: scheme.meta.revision });
    await persist(storage, next);
  }
  if (next.stage === 'confirm') {
    const requirements = requireRequirements(next);
    const brief = compileBuildBrief(scheme, requirements);
    const issues = lintBrief(brief, requirements);
    if (issues.length > 0) {
      throw new ConversationError(
        `已确认方案重新编译后 lint 未通过（${String(issues.length)} 项）：${issues.map((item) => `[${item.code}] ${item.message}`).join('；')}`,
      );
    }
    next = reduceSession(next, { kind: 'compileBrief', brief });
    await persist(storage, next);
  }
  const brief = next.brief;
  if (next.stage !== 'compile' || brief === null) {
    throw new ConversationError(`会话停在 ${next.stage}，没有可交付的 BuildBrief。`);
  }
  const intent = next.intents?.length === next.designs.length ? next.intents[next.intents.length - 1] : undefined;
  const artifacts = storage === undefined ? null : await storage.writeArtifacts(brief, intent);
  await persist(storage, next);
  io.say(
    artifacts === null
      ? '方案已确认；未注入存储，因此没有写 session.json / artifacts。'
      : `方案已确认，会话与 artifacts 已写入：${artifacts.sessionDir}`,
  );
  if (artifacts !== null) {
    const paths = [artifacts.design, artifacts.task, artifacts.spec, artifacts.gates, artifacts.promptMeta];
    if (artifacts.designIntent !== undefined) paths.push(artifacts.designIntent);
    for (const path of paths) io.say(`- ${path}`);
  }
  return {
    state: next,
    scheme,
    brief,
    artifacts,
    questions,
    answers,
    revisions: scheme.meta.revision,
  };
}

/** 从 SessionState.check 的 `[code] message` 重建展示用的 lint issues；冲突解决后用它刷新。 */
function issuesFromCheck(check: SessionState['check']): BriefIssue[] {
  if (check === null) return [];
  return check.issues.map((line) => {
    const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
    return match === null
      ? { code: 'scheme-gate', message: line }
      : { code: match[1] as BriefIssue['code'], message: match[2] ?? line };
  });
}

async function reviewLoop(
  context: ConversationContext,
  state: SessionState,
  scheme: DesignSchemeType,
  issues: readonly BriefIssue[],
  questions: readonly ClarificationQuestion[],
  answers: readonly ClarificationAnswer[],
): Promise<DesignConversationResult> {
  let next = state;
  let current = scheme;
  let currentIssues = [...issues];
  let revisionsUsed = 0;

  for (;;) {
    const beforeConflicts = next;
    const conflictMenu = await resolveConflictsWithProgress(context.io, next);
    next = conflictMenu.state;
    if (conflictMenu.kind === 'exit') {
      return unconfirmed(
        next,
        current,
        questions,
        answers,
        context.io,
        context.storage,
        '用户选择退出；冲突尚未处理，会话已保存，方案未确认。',
      );
    }
    if (conflictMenu.kind === 'revise') {
      if (revisionsUsed >= context.maxRevisions) {
        return unconfirmed(
          next,
          current,
          questions,
          answers,
          context.io,
          context.storage,
          `已达到最多 ${String(context.maxRevisions)} 轮修改，冲突处置尚未落实，保存会话但不确认。`,
        );
      }
      revisionsUsed += 1;
      const feedback = conflictMenu.feedback ?? '按用户选择处理设计冲突。';
      if (next.stage !== 'design' && next.stage !== 'revise') {
        next = reduceSession(next, { kind: 'requestRevision', reason: feedback });
        await persist(context.storage, next);
      }
      const checked = await generateChecked(context, next, current.meta.revision + 1, current, feedback);
      next = checked.state;
      current = checked.scheme;
      currentIssues = [...checked.issues];
      continue;
    }
    if (next !== beforeConflicts) {
      // 冲突菜单可能一次处理多个选项；继续到确认前先落盘，网页轮询才能看到 resolved。
      await persist(context.storage, next);
      currentIssues = next.stage === 'review' ? [] : issuesFromCheck(next.check);
    }

    if (currentIssues.length > 0) {
      showIssues(context.io, currentIssues);
      if (revisionsUsed >= context.maxRevisions) {
        return unconfirmed(
          next,
          current,
          questions,
          answers,
          context.io,
          context.storage,
          `已达到最多 ${String(context.maxRevisions)} 轮修改，方案仍未通过检查，保存会话但不确认。`,
        );
      }
      const feedback = await askLintFeedback(context.io);
      if (feedback === null) {
        return unconfirmed(
          next,
          current,
          questions,
          answers,
          context.io,
          context.storage,
          '用户选择退出；会话已保存，方案未确认。',
        );
      }
      revisionsUsed += 1;
      const checked = await generateChecked(context, next, current.meta.revision + 1, current, feedback);
      next = checked.state;
      current = checked.scheme;
      currentIssues = [...checked.issues];
      continue;
    }

    if (next.stage !== 'review') {
      throw new ConversationError(`方案通过检查后应处于 review，实际是 ${next.stage}。`);
    }
    showScheme(context.io, current, requireRequirements(next));
    const decision = await askDecision(context.io, current);
    if (decision.kind === 'confirm') {
      return finalize(next, current, context.io, context.storage, questions, answers);
    }
    if (decision.kind === 'exit') {
      return unconfirmed(
        next,
        current,
        questions,
        answers,
        context.io,
        context.storage,
        '用户选择退出；会话已保存，方案未确认。',
      );
    }
    if (revisionsUsed >= context.maxRevisions) {
      return unconfirmed(
        next,
        current,
        questions,
        answers,
        context.io,
        context.storage,
        `已达到最多 ${String(context.maxRevisions)} 轮修改，保存会话但不确认。`,
      );
    }

    revisionsUsed += 1;
    next = reduceSession(next, { kind: 'requestRevision', reason: decision.feedback });
    await persist(context.storage, next);
    const checked = await generateChecked(context, next, current.meta.revision + 1, current, decision.feedback);
    next = checked.state;
    current = checked.scheme;
    currentIssues = [...checked.issues];
  }
}

/** 从 design / check / revise 进入 review：需要时生成或重新检查当前方案。 */
async function designAndReview(
  context: ConversationContext,
  state: SessionState,
  questions: readonly ClarificationQuestion[],
  answers: readonly ClarificationAnswer[],
): Promise<DesignConversationResult> {
  let next = state;
  let scheme = currentScheme(next);
  let issues: readonly BriefIssue[] = [];

  if (scheme === undefined) {
    if (next.stage !== 'design' && next.stage !== 'revise') {
      throw new ConversationError(`会话停在 ${next.stage}，但没有可继续的方案。`);
    }
    const checked = await generateChecked(context, next, 1, undefined, undefined);
    next = checked.state;
    scheme = checked.scheme;
    issues = checked.issues;
  } else if (next.stage === 'revise') {
    const checked = await generateChecked(
      context,
      next,
      scheme.meta.revision + 1,
      scheme,
      next.revisionReason ?? undefined,
    );
    next = checked.state;
    scheme = checked.scheme;
    issues = checked.issues;
  } else if (next.stage === 'check') {
    const checked = evaluateSchemeWithProgress(requireRequirements(next), next, scheme, context.onProgress);
    next = checked.state;
    await persist(context.storage, next);
    issues = checked.issues;
  } else if (next.stage === 'design') {
    issues = checkScheme(scheme, requireRequirements(next)).issues;
  } else if (next.stage !== 'review') {
    throw new ConversationError(`不支持从 ${next.stage} 阶段恢复设计；请使用 --resume 从 review 或 confirm 继续。`);
  }

  return reviewLoop(context, next, scheme, issues, questions, answers);
}

function unsupportedResume(stage: SessionState['stage']): never {
  throw new ConversationError(
    `暂不支持从 ${stage} 阶段恢复；当前最小闭环支持 intake / understand / clarify / design / review / confirm / compile。`,
  );
}

/**
 * 运行一次完整的设计对话。所有用户输入都来自 io；所有持久化都来自 options.storage。
 * GenerationError / SessionTransitionError 不在这里吞掉，交给 CLI 或调用方分类。
 */
export async function runDesignConversation(
  client: ChatClient,
  input: ConversationInput,
  io: ConversationIO,
  options: DesignConversationOptions = {},
): Promise<DesignConversationResult> {
  const maxRevisions = options.maxRevisions ?? 3;
  const maxClarificationRounds = options.maxClarificationRounds ?? 2;
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0) {
    throw new ConversationError(`maxRevisions 必须是 >=0 的整数，实际是 ${String(maxRevisions)}。`);
  }
  if (!Number.isInteger(maxClarificationRounds) || maxClarificationRounds < 1 || maxClarificationRounds > 2) {
    throw new ConversationError(`maxClarificationRounds 必须是 1–2 的整数，实际是 ${String(maxClarificationRounds)}。`);
  }

  let state = options.resumeState ?? input.resume ?? createSession(input.sessionId);
  if (state.sessionId !== input.sessionId) {
    throw new ConversationError(`恢复的会话 id=${state.sessionId} 与请求的 ${input.sessionId} 不一致。`);
  }

  let questions: readonly ClarificationQuestion[] = state.questions;
  let answers: readonly ClarificationAnswer[] = state.answers;
  let exchanges: readonly ClarificationExchange[] = exchangesOf(questions, answers);

  if (state.requirements === null) {
    if (state.stage !== 'intake') throw new ConversationError(`会话停在 ${state.stage}，但没有需求图。`);
    if (input.task.trim() === '') throw new ConversationError('首次设计必须提供非空的用户需求。');
    await persist(options.storage, state);
    state = reduceSession(state, { kind: 'userMessage', text: input.task });
    await persist(options.storage, state);

    const extracted = await extractWithProgress(client, { userText: input.task }, options.onProgress);
    state = reduceSession(state, { kind: 'recordRequirements', graph: extracted.value });
    await persist(options.storage, state);

    const clarified = await clarify(
      client,
      state,
      input.task,
      io,
      options.storage,
      maxClarificationRounds,
      options.onProgress,
    );
    state = clarified.state;
    questions = clarified.questions;
    answers = clarified.answers;
    exchanges = clarified.exchanges;
  } else if (state.stage === 'understand') {
    const clarified = await clarify(
      client,
      state,
      input.task.trim() === '' ? requireRequirements(state).summary : input.task,
      io,
      options.storage,
      maxClarificationRounds,
      options.onProgress,
    );
    state = clarified.state;
    questions = clarified.questions;
    answers = clarified.answers;
    exchanges = clarified.exchanges;
  } else if (state.stage === 'clarify') {
    const continued = await answerPendingQuestions(
      client,
      state,
      input.task.trim() === '' ? requireRequirements(state).summary : input.task,
      io,
      options.storage,
      options.onProgress,
    );
    state = continued.state;
    questions = continued.questions;
    answers = continued.answers;
    exchanges = continued.exchanges;
  }

  const context: ConversationContext = {
    client,
    input,
    io,
    storage: options.storage,
    exchanges,
    maxRevisions,
    designMode: options.designMode ?? 'intent',
    outputMode: options.outputMode,
    onProgress: options.onProgress,
  };

  if (state.stage === 'confirm' || state.stage === 'compile') {
    const scheme = currentScheme(state);
    if (scheme === undefined) throw new ConversationError(`会话停在 ${state.stage}，但没有已确认方案。`);
    return finalize(state, scheme, io, options.storage, questions, answers);
  }
  if (state.stage === 'review' || state.stage === 'design' || state.stage === 'check' || state.stage === 'revise') {
    return designAndReview(context, state, questions, answers);
  }
  return unsupportedResume(state.stage);
}
