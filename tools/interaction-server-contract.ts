/**
 * 网页 demo 的 HTTP / 会话契约与小型纯辅助函数：类型、错误、消息追加、id / 构建命令。
 *
 * 负责：页面 API 形状、错误文案分类、请求字段校验。
 * 不负责：会话状态机 / 模型调用（interaction-server-session.ts）、路由（interaction-server-core.ts）。
 */
import { randomBytes } from 'node:crypto';

import { ConversationError } from '@pg/interaction/conversation';
import type { DesignConflict } from '@pg/interaction/schema';
import { GenerationError } from '@pg/interaction/generate';
import type { ReviewReport } from '@pg/interaction/review';
import type { SchemeScope } from '@pg/interaction/schema';
import type { SessionStage } from '@pg/interaction/session';
import { SessionTransitionError } from '@pg/interaction/session';
import { SessionStoreError } from '@pg/interaction/store';
import type { ArtifactPaths } from '@pg/interaction/store';

import type { WebBuildState } from './interaction-server-build.ts';

export type WebMode = 'mock' | 'live';
export type WebStatus = 'idle' | 'thinking' | 'waiting_answers' | 'waiting_decision' | 'done' | 'error';
export type DecisionKind = 'review' | 'feedback';
export type DecisionAction = 'confirm' | 'revise' | 'exit';

export interface WebMessage {
  readonly role: 'user' | 'assistant' | 'system';
  readonly text: string;
}

export interface WebQuestion {
  readonly id: string;
  readonly text: string;
}

export interface WebPreview {
  readonly name: string;
  readonly title: string;
  readonly url: string;
}

export interface WebSummary {
  readonly schemeId: string;
  readonly revision: number;
  readonly title: string;
  readonly concept: string;
  readonly scope: SchemeScope;
  readonly scopeLabel: string;
  readonly rooms: readonly string[];
  readonly musts: readonly string[];
  readonly open: readonly string[];
  readonly decisions: readonly string[];
}

export interface WebBriefStats {
  readonly designChars: number;
  readonly taskChars: number;
  readonly gates: readonly string[];
}

export interface WebSnapshot {
  readonly id: string;
  readonly mode: WebMode;
  readonly status: WebStatus;
  readonly stage: SessionStage;
  readonly brief: string;
  readonly messages: readonly WebMessage[];
  readonly questions: readonly WebQuestion[];
  readonly summary: WebSummary | null;
  readonly previews: readonly WebPreview[];
  readonly artifacts: ArtifactPaths | null;
  readonly error: string | null;
  /** 构建后评审；没有成功评审时为 null。 */
  readonly review: ReviewReport | null;
  /** true 表示 state 里有过评审，但它绑定的是旧 run，不能作为当前构建的结论。 */
  readonly reviewStale: boolean;
  /** 评审生成失败的可读原因；不影响构建状态。 */
  readonly reviewError: string | null;
  /** artifacts 是否与当前设计 revision 一致；旧构建不会把新 revision 伪装成已确认。 */
  readonly confirmed: boolean;
  readonly confirmedDesignRevision: number | null;
  /** 页面可据此隐藏构建按钮；服务端仍会在 startBuild 时重新校验。 */
  readonly canStartBuild: boolean;
  /** 页面可据此显示退出按钮；评审后的 revision 只能确认或继续修改。 */
  readonly canExit: boolean;
  readonly revisions: number;
  readonly checkIssues: readonly string[];
  /** gate / datum / 室外分区 / 家具降级的统一冲突；页面按 options 逐项选择。 */
  readonly conflicts: readonly DesignConflict[];
  readonly decisionKind: DecisionKind | null;
  readonly briefStats: WebBriefStats | null;
  readonly buildCommand: string;
  readonly build: WebBuildState;
  /** 当前内存进度序号；页面重连时用它判断服务是否重启、序号是否重置。 */
  readonly progressSeq: number;
}

export class HttpError extends Error {
  readonly status: number;
  readonly allow: string | null;

  constructor(status: number, message: string, allow: string | null = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.allow = allow;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function describeError(error: unknown): string {
  if (error instanceof GenerationError) {
    const diagnostics = error.diagnostics;
    const extra =
      diagnostics === null
        ? ''
        : `（finishReason=${diagnostics.finishReason}，prompt ${String(diagnostics.promptTokens)} / completion ${String(diagnostics.completionTokens)} tokens，arguments ${String(diagnostics.argumentChars)} 字符${diagnostics.argumentTruncated ? '，已截断' : ''}）`;
    return `生成失败（${error.code}）：${error.message}${extra}`;
  }
  if (error instanceof ConversationError) return `对话失败：${error.message}`;
  if (error instanceof SessionTransitionError) return `会话状态错误：${error.message}`;
  if (error instanceof SessionStoreError) return `会话存储错误：${error.message}`;
  return `运行失败：${messageOf(error)}`;
}

export function append(record: { readonly messages: WebMessage[] }, role: WebMessage['role'], text: string): void {
  if (text.trim() === '') return;
  record.messages.push({ role, text });
}

export function defaultId(): string {
  return `ses-web-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export function buildCommand(id: string, root: string): string {
  return `npm run design:build -- --session ${id} --out ${JSON.stringify(root)} --dry-run`;
}

export function nonEmptyText(body: Record<string, unknown>, key: string, label: string, max: number): string {
  const value = body[key];
  if (typeof value !== 'string') throw new HttpError(400, `${label} 必须是字符串。`);
  const text = value.trim();
  if (text === '') throw new HttpError(400, `${label} 不能为空。`);
  if (text.length > max) throw new HttpError(400, `${label} 过长（最多 ${String(max)} 字符）。`);
  return text;
}
