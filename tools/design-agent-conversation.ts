/**
 * `tools/design-agent.ts` 的对话装配：readline、预置回答与 session / artifacts 持久化。
 *
 * 负责：把真实终端或 `--answers` / `--feedback` 脚本适配成 ConversationIO，并把
 * `@pg/interaction/conversation` 的 storage 接到 `.work/sessions/<id>/`。
 * 不负责：参数解析、模式选择、模型调用；这些留在 design-agent.ts。
 */
import { createInterface } from 'node:readline/promises';

import type { ConversationIO, ConversationStorage, DesignConversationResult } from '@pg/interaction/conversation';
import { runDesignConversation } from '@pg/interaction/conversation';
import type { ConversationInput } from '@pg/interaction/conversation';
import type { SessionState } from '@pg/interaction/session';
import { loadSession, saveSession, sessionDir, writeArtifacts } from '@pg/interaction/store';
import type { ChatClient } from '@pg/llm/client';

export type PreloadedAnswer = string | { readonly questionId: string; readonly answer: string };

/** CLI 参数 / 预置回答 / 恢复文件不可用时的可读错误；design-agent 会映射为退出码 2。 */
export class ConversationCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationCliError';
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConversationCliError(`${label} 必须是非空字符串。`);
  }
  return value;
}

/**
 * 解析 `--answers`：字符串数组按提问顺序消费；对象数组按 questionId 匹配，
 * 另可用 `confirm` / `feedback` 两个保留 id 回答确认与 lint 反馈。
 */
export function parsePreloadedAnswers(text: string): readonly PreloadedAnswer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConversationCliError(
      `--answers 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) throw new ConversationCliError('--answers 必须是 JSON 数组。');
  if (parsed.every((item) => typeof item === 'string')) {
    return parsed.map((item, index) => nonEmpty(item, `--answers 第 ${String(index + 1)} 项`));
  }
  if (
    !parsed.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>)['questionId'] === 'string' &&
        typeof (item as Record<string, unknown>)['answer'] === 'string',
    )
  ) {
    throw new ConversationCliError(
      '--answers 必须全部是字符串，或全部是 {"questionId":"...","answer":"..."} 对象，不能混用。',
    );
  }
  const seen = new Set<string>();
  return parsed.map((item, index) => {
    const record = item as Record<string, unknown>;
    const questionId = nonEmpty(record['questionId'], `--answers 第 ${String(index + 1)} 项的 questionId`);
    const answer = nonEmpty(record['answer'], `--answers 第 ${String(index + 1)} 项的 answer`);
    if (seen.has(questionId)) throw new ConversationCliError(`--answers 的 questionId 重复：${questionId}`);
    seen.add(questionId);
    return { questionId, answer };
  });
}

interface PreloadedIO {
  readonly io: ConversationIO;
  finish(): void;
}

function createPreloadedIO(
  say: (line: string) => void,
  answers: readonly PreloadedAnswer[] | undefined,
  feedback: string | undefined,
): PreloadedIO {
  const byIdMode = answers?.some((item) => typeof item === 'object') ?? false;
  const ordered: string[] =
    answers === undefined ? [] : answers.filter((item): item is string => typeof item === 'string');
  const byId = new Map<string, string>(
    answers === undefined
      ? []
      : answers
          .filter((item): item is { readonly questionId: string; readonly answer: string } => typeof item === 'object')
          .map((item) => [item.questionId, item.answer]),
  );
  let feedbackUsed = false;
  let orderedIndex = 0;

  const takeOrdered = (label: string): string => {
    const value = ordered[orderedIndex];
    if (value === undefined) {
      throw new ConversationCliError(
        `--answers 的数量不足：${label} 没有预置回答；请补齐后重试（已消费 ${String(orderedIndex)} 条）。`,
      );
    }
    orderedIndex += 1;
    return value;
  };

  const takeById = (questionId: string): string => {
    const value = byId.get(questionId);
    if (value === undefined) {
      throw new ConversationCliError(`--answers 缺少问题 ${questionId} 的回答；问题数量与预置回答不匹配。`);
    }
    byId.delete(questionId);
    return value;
  };

  const io: ConversationIO = {
    say,
    askQuestion(question) {
      return Promise.resolve(byIdMode ? takeById(question.id) : takeOrdered(`问题 ${question.id}`));
    },
    ask(prompt) {
      const confirmationPrompt = prompt.includes('确认');
      if (feedback !== undefined && !feedbackUsed && (confirmationPrompt || prompt.includes('修改意见'))) {
        feedbackUsed = true;
        return Promise.resolve(feedback);
      }
      const conflictId = /请选择冲突 (\S+) 的处理方式/.exec(prompt)?.[1];
      if (byIdMode && conflictId !== undefined) {
        const key = byId.has(`conflict:${conflictId}`) ? `conflict:${conflictId}` : 'conflict';
        const value = byId.get(key);
        if (value === undefined) {
          throw new ConversationCliError(
            `--answers 缺少冲突 ${conflictId} 的回答；请提供保留 id "conflict:${conflictId}"（或通用 "conflict"）。`,
          );
        }
        byId.delete(key);
        return Promise.resolve(value);
      }
      if (byIdMode) {
        const key = confirmationPrompt ? 'confirm' : 'feedback';
        const value = byId.get(key);
        if (value === undefined) {
          throw new ConversationCliError(
            `--answers 缺少保留 id "${key}" 的回答；对象形式需要提供问题 id、confirm 与（必要时）feedback。`,
          );
        }
        byId.delete(key);
        return Promise.resolve(value);
      }
      return Promise.resolve(takeOrdered('确认 / 修改反馈'));
    },
  };

  return {
    io,
    finish() {
      if (orderedIndex < ordered.length) {
        throw new ConversationCliError(
          `--answers 多出 ${String(ordered.length - orderedIndex)} 条未使用回答；问题数量与预置回答不匹配。`,
        );
      }
      if (byId.size > 0) {
        throw new ConversationCliError(
          `--answers 有未使用的 questionId：${[...byId.keys()].join('、')}；问题数量与预置回答不匹配。`,
        );
      }
    },
  };
}

/** 终端问答：say 走调用方 stdout，ask / confirm 走 readline。 */
export async function withTerminalConversationIO<T>(
  say: (line: string) => void,
  run: (io: ConversationIO) => Promise<T>,
): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await run({
      say,
      ask: (question) => rl.question(`${question}\n`),
    });
  } finally {
    rl.close();
  }
}

export function createConversationStorage(sessionId: string, outDir: string): ConversationStorage {
  return {
    async save(state: SessionState): Promise<void> {
      await saveSession(state, { root: outDir });
    },
    async writeArtifacts(brief, intent) {
      return writeArtifacts(sessionDir(sessionId, { root: outDir }), brief, intent);
    },
  };
}

export interface ConversationCliInput {
  readonly sessionId: string;
  readonly outDir: string;
  readonly task: string;
  readonly answers: readonly PreloadedAnswer[] | undefined;
  readonly feedback: string | undefined;
  readonly resume: boolean;
  readonly designMode?: 'intent' | 'legacy';
  /** 传给 @pg/interaction 的宿主预算提示；0 / 缺省表示不展示金额上限。 */
  readonly maxCostCny?: number;
  readonly say: (line: string) => void;
  /** 测试注入；给出时完全绕过 readline 与 --answers。 */
  readonly conversationIO?: ConversationIO;
}

/** 装配 IO / storage 并运行一次对话；恢复失败、预置回答不匹配都抛 ConversationCliError。 */
export async function runConversationMode(
  client: ChatClient,
  input: ConversationCliInput,
): Promise<DesignConversationResult> {
  const resumeState = input.resume ? await loadSession(input.sessionId, { root: input.outDir }) : null;
  if (input.resume && resumeState === null) {
    throw new ConversationCliError(`无法恢复：会话 ${input.sessionId} 在 ${input.outDir} 下不存在。`);
  }
  if (resumeState !== null) {
    const scheme = resumeState.designs[resumeState.designs.length - 1];
    const requirements =
      resumeState.requirements === null
        ? '无需求图'
        : `需求 ${resumeState.requirements.id} v${String(resumeState.requirements.revision)}`;
    const design = scheme === undefined ? '无方案' : `方案 ${scheme.meta.id} v${String(scheme.meta.revision)}`;
    input.say(`恢复会话 ${input.sessionId}：阶段 ${resumeState.stage}；${requirements}；${design}。`);
  }
  const conversationInput: ConversationInput = {
    sessionId: input.sessionId,
    task: input.task,
    ...(input.maxCostCny === undefined ? {} : { maxCostCny: input.maxCostCny }),
    ...(resumeState === null ? {} : { resume: resumeState }),
  };
  const storage = createConversationStorage(input.sessionId, input.outDir);

  const runOptions = {
    storage,
    ...(input.designMode === undefined ? {} : { designMode: input.designMode }),
  };
  if (input.conversationIO !== undefined) {
    return runDesignConversation(client, conversationInput, input.conversationIO, runOptions);
  }
  if (input.answers !== undefined || input.feedback !== undefined) {
    const preloaded = createPreloadedIO(input.say, input.answers, input.feedback);
    const result = await runDesignConversation(client, conversationInput, preloaded.io, runOptions);
    preloaded.finish();
    return result;
  }
  return withTerminalConversationIO(input.say, (io) =>
    runDesignConversation(client, conversationInput, io, runOptions),
  );
}
