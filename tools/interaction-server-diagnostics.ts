/**
 * 会话失败诊断落盘：把 GenerationError 的模型正文、repair 诊断写成 session 目录下的 failure.json。
 *
 * 负责：沿 cause 链定位 GenerationError、按白名单序列化诊断、截断超长正文、原子写。
 * 不负责：运行模型、推进会话、读取环境变量或提示词；failure.json 只保存模型输出与错误诊断。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GenerationError } from '@pg/interaction/generate';
import type { GenerationDiagnostics } from '@pg/interaction/generate';
import { sessionDir } from '@pg/interaction/store';

/** 单个正文字段（content / reasoningContent / rawArguments[].text / message）的最大字符数。 */
export const FAILURE_TEXT_LIMIT = 65_536;

export interface FailureFileBody {
  readonly stage: string;
  readonly sessionId: string;
  readonly code: string;
  readonly message: string;
  readonly repairFailed: boolean;
  readonly diagnostics: Record<string, unknown> | null;
}

export interface WriteFailureOptions {
  readonly root: string;
  readonly sessionId: string;
  /** 失败时会话所处阶段；取最后一次已落盘的 SessionState.stage。 */
  readonly stage: string;
  readonly error: GenerationError;
}

function truncate(text: string): string {
  if (text.length <= FAILURE_TEXT_LIMIT) return text;
  const omitted = text.length - FAILURE_TEXT_LIMIT;
  return `${text.slice(0, FAILURE_TEXT_LIMIT)}\n…[truncated ${String(omitted)} chars]`;
}

function rawArgumentsJson(
  items: GenerationDiagnostics['rawArguments'],
): readonly Record<string, unknown>[] | undefined {
  if (items === undefined) return undefined;
  return items.map((item) => ({ index: item.index, text: truncate(item.text) }));
}

/**
 * 诊断字段白名单：即使调用方在 diagnostics 上挂了 apiKey / prompt，也只写已知字段。
 * previous 递归处理，保证 repair 失败时首轮 raw 响应同样保留。
 */
function diagnosticsJson(diagnostics: GenerationDiagnostics): Record<string, unknown> {
  const rawArguments = rawArgumentsJson(diagnostics.rawArguments);
  return {
    finishReason: diagnostics.finishReason,
    promptTokens: diagnostics.promptTokens,
    completionTokens: diagnostics.completionTokens,
    argumentChars: diagnostics.argumentChars,
    argumentTruncated: diagnostics.argumentTruncated,
    ...(diagnostics.totalTokens === undefined ? {} : { totalTokens: diagnostics.totalTokens }),
    ...(diagnostics.promptCacheHitTokens === undefined
      ? {}
      : { promptCacheHitTokens: diagnostics.promptCacheHitTokens }),
    ...(diagnostics.promptCacheMissTokens === undefined
      ? {}
      : { promptCacheMissTokens: diagnostics.promptCacheMissTokens }),
    ...(diagnostics.reasoningTokens === undefined ? {} : { reasoningTokens: diagnostics.reasoningTokens }),
    ...(diagnostics.usage === undefined ? {} : { usage: diagnostics.usage }),
    ...(diagnostics.outputMode === undefined ? {} : { outputMode: diagnostics.outputMode }),
    ...(diagnostics.thinking === undefined ? {} : { thinking: diagnostics.thinking }),
    ...(diagnostics.contentChars === undefined ? {} : { contentChars: diagnostics.contentChars }),
    ...(diagnostics.contentTruncated === undefined ? {} : { contentTruncated: diagnostics.contentTruncated }),
    ...(diagnostics.reasoningChars === undefined ? {} : { reasoningChars: diagnostics.reasoningChars }),
    ...(diagnostics.reasoningPresent === undefined ? {} : { reasoningPresent: diagnostics.reasoningPresent }),
    ...(rawArguments === undefined ? {} : { rawArguments }),
    ...(diagnostics.content === undefined ? {} : { content: truncate(diagnostics.content) }),
    ...(diagnostics.reasoningContent === undefined ? {} : { reasoningContent: truncate(diagnostics.reasoningContent) }),
    ...(diagnostics.previous === undefined ? {} : { previous: diagnosticsJson(diagnostics.previous) }),
  };
}

/** 沿 cause 链找 GenerationError；ConversationError 等包装层不会丢掉底层诊断。 */
export function generationFailureOf(error: unknown): GenerationError | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    if (current instanceof GenerationError) return current;
    seen.add(current);
    current = (current as { readonly cause?: unknown }).cause;
  }
  return null;
}

/** 生成 failure.json 的内容；导出便于单测截断 / 白名单规则。 */
export function failureFileBody(options: Omit<WriteFailureOptions, 'root'>): FailureFileBody {
  return {
    stage: options.stage,
    sessionId: options.sessionId,
    code: options.error.code,
    message: truncate(options.error.message),
    repairFailed: options.error.repairFailed,
    diagnostics: options.error.diagnostics === null ? null : diagnosticsJson(options.error.diagnostics),
  };
}

/** 原子写 sessionDir/failure.json；写入失败抛给调用方，由调用方记日志且不覆盖原错误。 */
export async function writeFailureFile(options: WriteFailureOptions): Promise<string> {
  const dir = sessionDir(options.sessionId, { root: options.root });
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'failure.json');
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(failureFileBody(options), null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return file;
}
