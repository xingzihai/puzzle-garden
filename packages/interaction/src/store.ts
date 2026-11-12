/**
 * 会话持久化：`.work/sessions/<sessionId>/session.json` 与设计 / 构建产物。
 *
 * 负责：默认根目录、session id 路径安全、原子写（tmp + rename）、会话读回与 artifacts 落盘。
 * 不负责：调用模型、推进状态机、跨会话记忆；所有状态都由调用方显式传入。
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BuildBrief } from './build.ts';
import type { DesignIntent } from './design-intent.ts';
import { ReviewWaiver } from './review-evidence.ts';
import { ReviewReport } from './review.ts';
import { SESSION_STAGES } from './session.ts';
import type { SessionStage, SessionState, StaleReview } from './session.ts';

/** 默认会话根目录；相对路径以调用方进程的工作目录为准。 */
export const DEFAULT_SESSION_ROOT = '.work/sessions';

/** 会话 id 只允许小写字母、数字、下划线与连字符，最长 64；不允许任何路径分隔符。 */
export const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class SessionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStoreError';
  }
}

export interface SessionStoreOptions {
  readonly root?: string;
  /**
   * 兼容旧调用，不再有任何效果：单凭该标志不能保留 review。
   * 需要评审的恢复路径必须用 loadSessionForReviewRevalidation 显式重验。
   */
  readonly preserveReview?: boolean;
}

export interface ArtifactPaths {
  readonly sessionDir: string;
  readonly design: string;
  readonly task: string;
  readonly spec: string;
  readonly gates: string;
  readonly promptMeta: string;
  /** intent 模式确认后保留模型原始意图；旧路径没有该文件。 */
  readonly designIntent?: string;
}

export function assertSessionId(id: string): string {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new SessionStoreError(
      `非法 session id ${JSON.stringify(id)}：只允许 [a-z0-9][a-z0-9_-]{0,63}，且不得包含路径分隔符。`,
    );
  }
  return id;
}

/** 解析并创建会话目录路径；只做字符串拼接，不创建目录。 */
export function sessionDir(id: string, options: SessionStoreOptions = {}): string {
  return join(options.root ?? DEFAULT_SESSION_ROOT, assertSessionId(id));
}

function stateFile(dir: string): string {
  return join(dir, 'session.json');
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

function parseReviewWaivers(value: unknown): readonly ReviewWaiver[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const parsed = ReviewWaiver.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}

/** 旧评审历史只用于展示；坏条目丢弃，不能影响当前 review / accept。 */
function parseReviewHistory(value: unknown): readonly StaleReview[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
      const record = raw as Record<string, unknown>;
      if (record['stale'] !== true || typeof record['supersededByRunId'] !== 'string') return [];
      const review = ReviewReport.safeParse(record['review']);
      return review.success
        ? [{ review: review.data, stale: true as const, supersededByRunId: record['supersededByRunId'] }]
        : [];
    })
    .slice(-32);
}

/** review 声称 waived 的 must 必须有同 mustId / 同 revision 的状态 waiver；ReviewWaiver 已强制 by=user。 */
function hasStateWaiver(review: ReviewReport, waivers: readonly ReviewWaiver[]): boolean {
  const revision = review.designVersion.revision;
  return review.verdict.musts.every(
    (must) =>
      must.status !== 'waived' ||
      waivers.some((waiver) => waiver.mustId === must.requirementId && waiver.designRevision === revision),
  );
}

/** 清空不可信的评审结论，并把已经决定过的终态退回 post-review，避免无 review 的 accept。 */
function withoutReview(state: SessionState): SessionState {
  const stage = ['accept', 'targeted-revision', 'redesign'].includes(state.stage) ? 'post-review' : state.stage;
  return { ...state, stage, review: null, reviewWaivers: [] };
}

function parseStoredSession(text: string, expectedId: string): SessionState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SessionStoreError(
      `会话 ${expectedId} 的 session.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionStoreError(`会话 ${expectedId} 的 session.json 必须是对象。`);
  }
  const record = parsed as Record<string, unknown>;
  if (record['sessionId'] !== expectedId) {
    throw new SessionStoreError(`会话文件 id=${String(record['sessionId'])} 与请求的 ${expectedId} 不一致，拒绝读取。`);
  }
  const stage = record['stage'];
  if (typeof stage !== 'string' || !SESSION_STAGES.includes(stage as SessionStage)) {
    throw new SessionStoreError(`会话 ${expectedId} 的 stage 不是合法阶段：${String(stage)}`);
  }
  if (!Array.isArray(record['designs']) || !Array.isArray(record['events'])) {
    throw new SessionStoreError(`会话 ${expectedId} 的 designs / events 必须是数组。`);
  }
  if (typeof record['nextEventSeq'] !== 'number' || !Number.isInteger(record['nextEventSeq'])) {
    throw new SessionStoreError(`会话 ${expectedId} 的 nextEventSeq 必须是整数。`);
  }
  const state = parsed as SessionState;
  // 无效 waiver / history 一律丢弃；不能让手写条目混进接受门槛或展示。
  const reviewWaivers = parseReviewWaivers(state.reviewWaivers);
  const reviewHistory = parseReviewHistory(state.reviewHistory);
  if (state.review === null) return { ...state, reviewWaivers, reviewHistory };
  const review = ReviewReport.safeParse(state.review);
  // 旧 session.json 没有 provenance：satisfied / accept 评审不能跨进程信任。
  const legacyAccepted =
    review.success &&
    (review.data.verdict.status === 'satisfied' || review.data.nextAction.kind === 'accept') &&
    review.data.provenance === undefined;
  // 声称 waived 却没有用户显式状态 waiver：伪造评审，整份清空。
  const forgedWaiver = review.success && !hasStateWaiver(review.data, reviewWaivers);
  if (!review.success || legacyAccepted || forgedWaiver) {
    return withoutReview({ ...state, reviewWaivers, reviewHistory });
  }
  return { ...state, review: review.data, reviewWaivers, reviewHistory };
}

async function readStoredSession(id: string, options: SessionStoreOptions): Promise<SessionState | null> {
  const dir = sessionDir(id, options);
  const file = stateFile(dir);
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new SessionStoreError(`读取会话 ${id} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return parseStoredSession(text, id);
}

/** 保存会话；先写同目录临时文件再 rename，覆盖时不会留下半截 JSON。 */
export async function saveSession(state: SessionState, options: SessionStoreOptions = {}): Promise<string> {
  const id = assertSessionId(state.sessionId);
  const dir = sessionDir(id, options);
  await mkdir(dir, { recursive: true });
  const file = stateFile(dir);
  await atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

/** 读取会话；不存在返回 null，非法 id / 损坏文件抛 SessionStoreError。 */
export async function loadSession(id: string, options: SessionStoreOptions = {}): Promise<SessionState | null> {
  const state = await readStoredSession(id, options);
  if (state === null) return null;
  // 低层 loadSession 永远不把磁盘上的 review / waiver 当成可信结论；
  // preserveReview 仅为兼容旧调用，不能单独保留 review。
  return withoutReview(state);
}

/**
 * 恢复评审时显式重验：读取原始 state（含 review），只有回调返回 true 才返回 review。
 * 回调抛错 / 返回 false 时清空 review 与 waiver，并把 accept 等终态退回 post-review。
 */
export async function loadSessionForReviewRevalidation(
  id: string,
  revalidate: (state: SessionState) => boolean | Promise<boolean>,
  options: SessionStoreOptions = {},
): Promise<SessionState | null> {
  const state = await readStoredSession(id, options);
  if (state === null) return null;
  // 没有 review 时没有可重验的结论；保留 schema 校验后的 waiver 供往返 / 继续操作。
  if (state.review === null) return state;
  let valid: boolean;
  try {
    valid = await revalidate(state);
  } catch {
    valid = false;
  }
  return valid ? state : withoutReview(state);
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 写入完整构建产物。design.md 与 build-task.md 是设计报告 / 四节题面原文；
 * JSON 只做确定性序列化，不添加时间戳。
 */
export async function writeArtifacts(dir: string, brief: BuildBrief, intent?: DesignIntent): Promise<ArtifactPaths> {
  await mkdir(dir, { recursive: true });
  const paths: ArtifactPaths = {
    sessionDir: dir,
    design: join(dir, 'design.md'),
    task: join(dir, 'build-task.md'),
    spec: join(dir, 'build-spec.json'),
    gates: join(dir, 'gates.json'),
    promptMeta: join(dir, 'prompt-meta.json'),
    ...(intent === undefined ? {} : { designIntent: join(dir, 'design-intent.json') }),
  };
  await Promise.all([
    atomicWrite(paths.design, brief.designMarkdown),
    atomicWrite(paths.task, brief.taskMarkdown),
    atomicWrite(paths.spec, jsonText(brief.spec)),
    atomicWrite(paths.gates, jsonText(brief.gates)),
    atomicWrite(paths.promptMeta, jsonText(brief.promptMeta)),
    ...(intent === undefined || paths.designIntent === undefined
      ? []
      : [atomicWrite(paths.designIntent, jsonText(intent))]),
  ]);
  return paths;
}

/** 只给工具 / 测试用：确认目录存在时返回 true，不创建目录。 */
export function sessionExists(id: string, options: SessionStoreOptions = {}): boolean {
  return existsSync(stateFile(sessionDir(id, options)));
}
