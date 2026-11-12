/* eslint-disable max-lines */
/**
 * 网页 demo 的会话域：内存会话、ConversationIO / ConversationStorage 适配、方案摘要与 SVG 预览落盘。
 *
 * 负责：后台运行 runDesignConversation、等待回答 / 确认、把最新方案渲染成 preview、确认后写 artifacts。
 * 不负责：HTTP 路由 / 静态资源 / 请求体解析（interaction-server-core.ts）、mock / live client 装配。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { compileBuildBrief } from '@pg/interaction/brief';
import type { ConversationIO, ConversationStorage } from '@pg/interaction/conversation';
import { runDesignConversation } from '@pg/interaction/conversation';
import type { ConversationInput } from '@pg/interaction/conversation';
import type { DesignIntent } from '@pg/interaction/design-intent';
import type { SubmissionOutputMode } from '@pg/interaction/generate';
import type { InteractionProgressCallback } from '@pg/interaction/generate-intent';
import { renderPreviewBundle } from '@pg/interaction/preview';
import { planVerifiedObjectMap } from '@pg/interaction/must-links';
import type { BuildBrief } from '@pg/interaction/schema';
import { BuildSpec, buildMustLedger } from '@pg/interaction/schema';
import { resolveReviewMusts, ReviewWaiver } from '@pg/interaction/review-evidence';
import type { ClarificationQuestion, SessionFailure, SessionState } from '@pg/interaction/session';
import { createSession, currentReview, reduceSession, SessionTransitionError } from '@pg/interaction/session';
import {
  assertSessionId,
  loadSession,
  loadSessionForReviewRevalidation,
  saveSession,
  sessionDir,
  SESSION_ID_PATTERN,
  SessionStoreError,
  writeArtifacts,
} from '@pg/interaction/store';
import type { ArtifactPaths } from '@pg/interaction/store';
import type { ChatClient } from '@pg/llm/client';

import { generateIntentDesign } from '@pg/interaction/conversation-intent';
import { evaluateSchemeWithProgress } from '@pg/interaction/conversation-progress';
import { DEFAULT_OUT_DIR, MAX_RUN_CNY } from './agent-massing-args.ts';
import type { DesignBuildRunResult } from './design-build-runner.ts';
import {
  BuildTracker,
  defaultBuildStarter,
  defaultWebReviewBuilder,
  readPersistedRunReview,
  readRunReviewEvidence,
} from './interaction-server-build.ts';
import type {
  BuildTrackerHooks,
  WebBuildState,
  WebBuildStarter,
  WebReviewBuilder,
} from './interaction-server-build.ts';
import {
  append,
  buildCommand,
  defaultId,
  describeError,
  HttpError,
  isRecord,
  messageOf,
  nonEmptyText,
} from './interaction-server-contract.ts';
import type {
  DecisionKind,
  WebBriefStats,
  WebMessage,
  WebMode,
  WebPreview,
  WebSnapshot,
  WebStatus,
  WebSummary,
} from './interaction-server-contract.ts';
import { generationFailureOf, writeFailureFile } from './interaction-server-diagnostics.ts';
import { writePreviewBundle } from './interaction-server-preview.ts';
import { SessionProgress } from './interaction-server-progress.ts';
import type { WebProgressEvent } from './interaction-server-progress.ts';
import { restoreConfirmedSession } from './interaction-server-restore.ts';
import type { RestoredSession } from './interaction-server-restore.ts';
import { briefStats, sectionSummary } from './interaction-server-summary.ts';

export { HttpError, isRecord, messageOf } from './interaction-server-contract.ts';
export type {
  DecisionKind,
  WebBriefStats,
  WebMessage,
  WebMode,
  WebPreview,
  WebQuestion,
  WebSnapshot,
  WebStatus,
  WebSummary,
} from './interaction-server-contract.ts';

export type {
  WebProgressEvent,
  WebProgressKind,
  WebProgressListener,
  WebProgressStatus,
} from './interaction-server-progress.ts';

export type {
  WebBuildEvent,
  WebBuildRender,
  WebBuildState,
  WebBuildStatus,
  WebBuildStarter,
  WebBuildStarterInput,
  WebReviewBuilder,
} from './interaction-server-build.ts';

export interface SessionManagerOptions {
  readonly mode: WebMode;
  readonly sessionRoot: string;
  /** 每个会话调用一次；mock 需要每个会话独立的抽取计数。 */
  readonly clientFactory: () => ChatClient;
  readonly idFactory?: () => string;
  readonly maxRevisions?: number;
  readonly maxClarificationRounds?: number;
  readonly maxBlocks?: number;
  readonly maxCostCny?: number | null;
  /** 网页构建默认上限；缺省跟随 maxCostCny，再缺省为 MAX_RUN_CNY。 */
  readonly buildMaxCny?: number;
  /** 默认 intent；legacy 仅用于旧路径回归。 */
  readonly designMode?: 'intent' | 'legacy';
  /** 生成协议；缺省 live=content-json，mock=tool（fake client 不必理解 JSON-only）。 */
  readonly outputMode?: SubmissionOutputMode;
  /** 测试 / 诊断用：SSE 订阅者数量变化时回调。 */
  readonly onSubscriberCountChange?: (id: string, count: number) => void;
  /** run 根目录；缺省 `.work/runs/`。 */
  readonly buildRunRoot?: string;
  /** 测试注入；缺省走 `startDesignBuild`。 */
  readonly buildStarter?: WebBuildStarter;
  /** 测试注入；缺省从 run events 读取事实并生成评审。 */
  readonly reviewBuilder?: WebReviewBuilder;
  /** 构建结果日志；缺省写 stderr，便于从服务输出文件排查。 */
  readonly buildLog?: (line: string) => void;
  /** 测试注入：会话落盘；缺省 saveSession。 */
  readonly sessionWriter?: typeof saveSession;
  /** 测试注入：artifacts 写入；缺省 writeArtifacts。 */
  readonly artifactWriter?: typeof writeArtifacts;
}

interface PendingAnswer {
  readonly questionId: string;
  readonly resolve: (answer: string) => void;
}

interface PendingDecision {
  readonly kind: DecisionKind;
  readonly resolve: (answer: string) => void;
  /** 冲突菜单 ask 时绑定 conflictId；普通确认 / lint 反馈为 null。 */
  readonly conflictId?: string | null;
}

interface SessionRecord {
  readonly id: string;
  readonly brief: string;
  status: WebStatus;
  state: SessionState | null;
  readonly messages: WebMessage[];
  readonly submittedAnswers: Map<string, string>;
  pendingAnswer: PendingAnswer | null;
  pendingDecision: PendingDecision | null;
  previews: WebPreview[];
  summary: WebSummary | null;
  briefStats: WebBriefStats | null;
  artifacts: ArtifactPaths | null;
  /** artifacts 绑定的设计 revision；null 或缺省表示磁盘上没有可信 artifacts。 */
  artifactsRevision: number | null;
  error: string | null;
  reviewError: string | null;
  /** 评审重试需要原始构建结果；只保存在当前进程内。 */
  lastBuildResult: DesignBuildRunResult | null;
  reviewInFlight: boolean;
  readonly build: BuildTracker;
  readonly progress: SessionProgress;
  previewsRevision: number | null;
}

const PREVIEW_NAME = /^[a-z0-9_-]+\.svg$/;

/** 失败原因给页面 / session.json 的统一文案：保留错误码并给出下一步。 */
function failureText(error: unknown): string {
  return `${describeError(error)}；下一步：新建会话后重试。`;
}

/** 从当前会话的 requirements + confirmed scheme 重跑确定性 linker；缺失时空映射（fail closed）。 */
function trustedVerifiedObjects(state: SessionState, spec: BuildSpec): Readonly<Record<string, readonly string[]>> {
  const requirements = state.requirements;
  const scheme = state.designs.find(
    (design) =>
      design.meta.revision === spec.schemeRevision &&
      design.meta.id === spec.schemeId &&
      design.meta.status === 'confirmed',
  );
  if (requirements === null || scheme === undefined) return {};
  try {
    return planVerifiedObjectMap(buildMustLedger(requirements).entries, scheme);
  } catch {
    return {};
  }
}

/**
 * accept 前重建信任：从 session.json 里的 confirmed design + requirements 重编译 spec，
 * 绑定磁盘 spec / archive 哈希 → 重新派生证据 → planner verified 集合 → 逐 must 对齐报告与状态 waiver。
 * 任何 planner 输入被篡改、文件替换、手写报告或旧证据都会失败。
 */
async function reviewMatchesCurrentArtifacts(input: {
  readonly state: SessionState;
  readonly spec: BuildSpec;
  readonly specPath: string;
  readonly runDir: string;
}): Promise<boolean> {
  const { state, spec, specPath, runDir } = input;
  const report = state.review;
  if (report?.provenance === undefined) return false;

  const requirements = state.requirements;
  const build = state.build;
  const revision = state.confirmedDesignRevision;
  if (requirements === null || build === null || revision === null) return false;
  if (build.designRevision !== revision) return false;

  // 只信带 confirmed 标记、且与 build 绑定的方案；不能拿 designs 里的其他版本重编译。
  const design = state.designs.find(
    (candidate) =>
      candidate.meta.id === build.designId &&
      candidate.meta.revision === revision &&
      candidate.meta.status === 'confirmed',
  );
  if (design === undefined) return false;

  let recomputed: BuildBrief;
  try {
    recomputed = compileBuildBrief(design, requirements);
  } catch {
    return false;
  }
  const declaredSpec = BuildSpec.safeParse(spec);
  if (!declaredSpec.success) return false;
  // requirements / design / brief.spec 在 session.json 里被改过就与重编译结果不一致。
  if (!isDeepStrictEqual(recomputed.spec, declaredSpec.data)) return false;

  let storedSpec: BuildSpec;
  try {
    const parsed = BuildSpec.safeParse(JSON.parse(await readFile(specPath, 'utf8')) as unknown);
    if (!parsed.success) return false;
    storedSpec = parsed.data;
  } catch {
    return false;
  }
  if (!isDeepStrictEqual(storedSpec, recomputed.spec)) return false;

  // planner 输入必须同时绑定到重编译 spec、评审设计版本和构建记录。
  if (
    recomputed.spec.schemeId !== report.designVersion.schemeId ||
    recomputed.spec.schemeRevision !== report.designVersion.revision ||
    recomputed.spec.schemeId !== build.designId ||
    recomputed.spec.schemeRevision !== build.designRevision ||
    report.buildRunId !== build.runId
  ) {
    return false;
  }

  // 只认 schema 合法、当前 revision 的状态 waiver（ReviewWaiver 已强制 by=user）；伪造 waived must 直接失败。
  const revisionWaivers = new Set(
    (state.reviewWaivers ?? []).flatMap((raw) => {
      const parsed = ReviewWaiver.safeParse(raw);
      return parsed.success && parsed.data.designRevision === recomputed.spec.schemeRevision
        ? [parsed.data.mustId]
        : [];
    }),
  );
  for (const must of report.verdict.musts) {
    if (must.status === 'waived' && !revisionWaivers.has(must.requirementId)) return false;
  }

  let verifiedObjects: Readonly<Record<string, readonly string[]>>;
  try {
    verifiedObjects = planVerifiedObjectMap(buildMustLedger(requirements).entries, design);
  } catch {
    return false;
  }

  const specSha256 = createHash('sha256')
    .update(await readFile(specPath))
    .digest('hex');
  const archivePath = join(runDir, 'delivery', 'building.pgar');
  if (!existsSync(archivePath)) return false;
  const archiveSha256 = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');
  if (report.provenance.specSha256 !== specSha256 || report.provenance.archiveSha256 !== archiveSha256) {
    return false;
  }
  const evidence = await readRunReviewEvidence(runDir, { specSha256, archiveSha256 }, specPath, verifiedObjects);
  if (evidence === null) return false;
  if ((report.provenance.unattributedHardFails ?? []).length > 0) return false;
  if ((report.provenance.globalBlockers ?? []).length > 0) return false;
  if ((evidence.clauseSummary?.unattributedHardFails.length ?? 0) > 0) return false;
  if ((evidence.clauseSummary?.globalBlockers.length ?? 0) > 0) return false;
  const resolved = resolveReviewMusts({
    schemeId: recomputed.spec.schemeId,
    designRevision: recomputed.spec.schemeRevision,
    musts: recomputed.spec.musts,
    evidence,
    specSha256,
    archiveSha256,
    verifiedMustIds: Object.keys(verifiedObjects),
  });
  const stored = new Map(report.verdict.musts.map((must) => [must.requirementId, must]));
  for (const must of resolved) {
    const verdict = stored.get(must.requirementId);
    if (verdict === undefined) return false;
    if (must.status === 'met' && verdict.status !== 'met') return false;
    if (must.status === 'not-met' && verdict.status !== 'not-met') return false;
    if (must.status === 'unverified') {
      if (verdict.status === 'waived') {
        if (!revisionWaivers.has(must.requirementId)) return false;
      } else if (verdict.status !== 'unverified') {
        return false;
      }
    }
    if (must.status !== 'met' && must.status !== 'unverified') return false;
    if (must.status === 'unverified' && !revisionWaivers.has(must.requirementId)) {
      return false;
    }
  }
  return true;
}

/** 把会话标记为 error，并保留失败前阶段与可读原因；失败是终态，不追加状态机事件。 */
function markSessionFailed(
  state: SessionState,
  failure: { readonly code: string; readonly message: string },
): SessionState {
  return {
    ...state,
    stage: 'error',
    failure: { stage: state.stage, code: failure.code, message: failure.message },
  };
}

/** session.json 里已存的可读原因；旧写法没有把 code 写进 message 时补上。 */
function sessionFailureText(failure: SessionFailure): string {
  return failure.message.includes(failure.code) ? failure.message : `${failure.message}（${failure.code}）`;
}

function artifactPathsFor(dir: string): ArtifactPaths {
  const designIntent = join(dir, 'design-intent.json');
  return {
    sessionDir: dir,
    design: join(dir, 'design.md'),
    task: join(dir, 'build-task.md'),
    spec: join(dir, 'build-spec.json'),
    gates: join(dir, 'gates.json'),
    promptMeta: join(dir, 'prompt-meta.json'),
    ...(existsSync(designIntent) ? { designIntent } : {}),
  };
}

interface RestoredFailureSession {
  readonly state: SessionState;
  readonly brief: string;
  readonly messages: readonly WebMessage[];
  readonly error: string;
}

/** 恢复 stage=error 的会话：只还原失败原因，不让页面误以为还能继续对话。 */
async function restoreFailedSession(id: string, root: string): Promise<RestoredFailureSession | null> {
  try {
    const state = await loadSession(id, { root });
    if (state?.stage !== 'error' || state.failure === undefined || state.failure === null) return null;
    const briefEvent = state.events.find((event) => event.type === 'user.message');
    const brief =
      briefEvent?.type === 'user.message' ? briefEvent.text : (state.requirements?.summary ?? '（已恢复失败会话）');
    const error = sessionFailureText(state.failure);
    return {
      state,
      brief,
      messages: [
        { role: 'system', text: '服务重启：已从磁盘恢复失败会话。' },
        ...(briefEvent?.type === 'user.message' ? [{ role: 'user' as const, text: briefEvent.text }] : []),
        { role: 'system', text: `错误：${error}` },
      ],
      error,
    };
  } catch {
    return null;
  }
}

/**
 * 恢复停在 post-review 的会话：构建已成功且 session.json 里有评审。
 * `restoreConfirmedSession` 只接受 compile，所以这里单独重建摘要 / 预览 / artifacts。
 */
async function restorePostReviewSession(
  id: string,
  root: string,
  buildRunRoot?: string,
): Promise<RestoredSession | null> {
  try {
    let hadStoredReview = false;
    try {
      const stored = JSON.parse(await readFile(join(sessionDir(id, { root }), 'session.json'), 'utf8')) as {
        review?: unknown;
      };
      hadStoredReview = stored.review !== null && stored.review !== undefined;
    } catch {
      // 读不到原始 session 时按“无评审”处理，后面仍会 fail closed。
    }
    let state = await loadSessionForReviewRevalidation(
      id,
      async (raw) => {
        const requirements = raw.requirements;
        if (requirements === null || raw.stage !== 'post-review' || raw.review === null) return false;
        if (raw.build?.status !== 'succeeded' || raw.confirmedDesignRevision === null) return false;
        const scheme = raw.designs.find(
          (candidate) =>
            candidate.meta.id === raw.build?.designId &&
            candidate.meta.revision === raw.build.designRevision &&
            candidate.meta.status === 'confirmed',
        );
        if (scheme === undefined) return false;

        const dir = sessionDir(id, { root });
        const artifacts = artifactPathsFor(dir);
        if (![artifacts.design, artifacts.task, artifacts.spec, artifacts.gates].every((path) => existsSync(path))) {
          return false;
        }
        // satisfied / accept 评审必须有 provenance 且绑定磁盘 build-spec.json；partial 只可展示。
        const provenance = raw.review.provenance;
        const claimsAccept = raw.review.verdict.status === 'satisfied' || raw.review.nextAction.kind === 'accept';
        if (provenance === undefined) {
          if (claimsAccept) return false;
        } else if (provenance.evidence !== 'none') {
          const specHash = createHash('sha256')
            .update(await readFile(artifacts.spec))
            .digest('hex');
          if (provenance.specSha256 === null || provenance.specSha256 !== specHash) return false;
          if (claimsAccept) {
            const runDir = buildRunRoot === undefined ? null : join(buildRunRoot, raw.build.runId);
            const archivePath = runDir === null ? null : join(runDir, 'delivery', 'building.pgar');
            if (archivePath === null || !existsSync(archivePath)) return false;
            const archiveHash = createHash('sha256')
              .update(await readFile(archivePath))
              .digest('hex');
            if (provenance.archiveSha256 === null || provenance.archiveSha256 !== archiveHash) return false;
          }
        } else if (claimsAccept) {
          return false;
        }
        if (!claimsAccept) return true;

        const spec = raw.brief?.spec;
        const runId = raw.build.runId;
        if (spec === undefined || buildRunRoot === undefined) return false;
        // 规划输入、spec 文件、archive、evidence 与 waiver 全部由 accept 门槛重算。
        return reviewMatchesCurrentArtifacts({
          state: raw,
          spec,
          specPath: artifacts.spec,
          runDir: join(buildRunRoot, runId),
        });
      },
      { root },
    );
    // 评审生成 / 第二次 save 失败时，session.json 会停在 post-review + review=null；
    // 若 run 目录已有 review.json，按同一 run 恢复，避免重启后 404。
    if (
      !hadStoredReview &&
      state !== null &&
      state.stage === 'post-review' &&
      state.review === null &&
      state.build?.status === 'succeeded' &&
      buildRunRoot !== undefined
    ) {
      const persisted = await readPersistedRunReview(join(buildRunRoot, state.build.runId));
      if (persisted !== null && persisted.buildRunId === state.build.runId) {
        try {
          const recovered = reduceSession(state, {
            kind: 'adoptBuildReview',
            runId: state.build.runId,
            report: persisted,
            replacesRunId: state.build.runId,
          });
          await saveSession(recovered, { root });
          state = recovered;
        } catch {
          // 版本 / revision 不匹配时保持不可恢复，交给失败路径。
        }
      }
    }
    const requirements = state?.requirements ?? null;
    if (state === null || requirements === null || state.stage !== 'post-review' || state.review === null) return null;
    if (state.build?.status !== 'succeeded' || state.confirmedDesignRevision === null) return null;
    const scheme = state.designs.find(
      (candidate) =>
        candidate.meta.id === state.build?.designId &&
        candidate.meta.revision === state.build.designRevision &&
        candidate.meta.status === 'confirmed',
    );
    if (scheme === undefined) return null;

    const dir = sessionDir(id, { root });
    const artifacts = artifactPathsFor(dir);

    const bundle = renderPreviewBundle(scheme);
    const previewDir = join(dir, 'preview');
    await mkdir(previewDir, { recursive: true });
    await Promise.all(bundle.files.map((file) => writeFile(join(previewDir, file.name), file.svg, 'utf8')));
    await writeFile(join(previewDir, 'index.html'), bundle.indexHtml, 'utf8');
    const previews = bundle.files.map((file) => ({
      name: file.name,
      title: file.title,
      url: `/api/sessions/${id}/preview/${file.name}`,
    }));

    const briefEvent = state.events.find((event) => event.type === 'user.message');
    const messages: WebMessage[] = [{ role: 'system', text: '服务重启：已从磁盘恢复构建后评审会话。' }];
    if (briefEvent?.type === 'user.message') messages.push({ role: 'user', text: briefEvent.text });

    return {
      state,
      brief: briefEvent?.type === 'user.message' ? briefEvent.text : requirements.summary,
      messages,
      summary: sectionSummary(state, scheme),
      previews,
      briefStats: briefStats(compileBuildBrief(scheme, requirements)),
      artifacts,
    };
  } catch {
    return null;
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly root: string;
  private readonly mode: WebMode;
  private readonly clientFactory: () => ChatClient;
  private readonly idFactory: () => string;
  private readonly maxRevisions: number;
  private readonly maxClarificationRounds: number;
  private readonly maxBlocks: number | undefined;
  private readonly maxCostCny: number | null | undefined;
  private readonly buildMaxCny: number;
  private readonly designMode: 'intent' | 'legacy';
  private readonly outputMode: SubmissionOutputMode;
  private readonly onSubscriberCountChange: ((id: string, count: number) => void) | undefined;
  private readonly buildRunRoot: string;
  private readonly buildStarter: WebBuildStarter;
  private readonly reviewBuilder: WebReviewBuilder;
  private readonly buildLog: (line: string) => void;
  private readonly sessionWriter: typeof saveSession;
  private readonly artifactWriter: typeof writeArtifacts;
  /** 每个会话串行落盘；后入队的 save 一定在前一个完成后才开始写。 */
  private readonly saveQueues = new Map<string, Promise<void>>();

  constructor(options: SessionManagerOptions) {
    this.root = options.sessionRoot;
    this.mode = options.mode;
    this.clientFactory = options.clientFactory;
    this.idFactory = options.idFactory ?? defaultId;
    this.maxRevisions = options.maxRevisions ?? 3;
    this.maxClarificationRounds = options.maxClarificationRounds ?? 2;
    this.maxBlocks = options.maxBlocks;
    this.maxCostCny = options.maxCostCny;
    const configuredBuildCap =
      options.buildMaxCny ??
      (typeof options.maxCostCny === 'number' && options.maxCostCny > 0 ? options.maxCostCny : null);
    this.buildMaxCny =
      configuredBuildCap !== null && Number.isFinite(configuredBuildCap) && configuredBuildCap > 0
        ? Math.min(configuredBuildCap, MAX_RUN_CNY)
        : MAX_RUN_CNY;
    this.designMode = options.designMode ?? 'intent';
    // live 默认走 JSON-only content；mock 保持 tool，避免 fake client 被协议切换破坏。
    this.outputMode = options.outputMode ?? (options.mode === 'live' ? 'content-json' : 'tool');
    this.onSubscriberCountChange = options.onSubscriberCountChange;
    this.buildRunRoot = options.buildRunRoot ?? DEFAULT_OUT_DIR;
    this.buildStarter = options.buildStarter ?? defaultBuildStarter;
    this.reviewBuilder = options.reviewBuilder ?? defaultWebReviewBuilder;
    this.buildLog =
      options.buildLog ??
      ((line) => {
        process.stderr.write(`${line}\n`);
      });
    this.sessionWriter = options.sessionWriter ?? saveSession;
    this.artifactWriter = options.artifactWriter ?? writeArtifacts;
  }

  /** 启动时恢复磁盘上已确认的会话；未确认 / 会话损坏一律跳过，避免重启后假装能继续对话。 */
  async loadPersisted(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name) || this.sessions.has(entry.name)) continue;
      const restored =
        (await restoreConfirmedSession(entry.name, this.root)) ??
        (await restorePostReviewSession(entry.name, this.root, this.buildRunRoot));
      if (restored !== null) {
        this.sessions.set(entry.name, {
          id: entry.name,
          brief: restored.brief,
          status: 'done',
          state: restored.state,
          messages: [...restored.messages],
          submittedAnswers: new Map(),
          pendingAnswer: null,
          pendingDecision: null,
          previews: [...restored.previews],
          summary: restored.summary,
          briefStats: restored.briefStats,
          artifacts: restored.artifacts,
          artifactsRevision: restored.state.confirmedDesignRevision,
          error: null,
          reviewError: null,
          lastBuildResult: null,
          reviewInFlight: false,
          build: new BuildTracker(this.buildStarter, this.buildLog, this.buildHooks(entry.name)),
          progress: new SessionProgress((count) => this.onSubscriberCountChange?.(entry.name, count)),
          previewsRevision: restored.state.designs[restored.state.designs.length - 1]?.meta.revision ?? null,
        });
        continue;
      }
      // 失败会话也要能被 GET 看到：恢复 stage=error 与可读原因，而不是重启后 404。
      const failed = await restoreFailedSession(entry.name, this.root);
      if (failed === null) continue;
      this.sessions.set(entry.name, {
        id: entry.name,
        brief: failed.brief,
        status: 'error',
        state: failed.state,
        messages: [...failed.messages],
        submittedAnswers: new Map(),
        pendingAnswer: null,
        pendingDecision: null,
        previews: [],
        summary: null,
        briefStats: null,
        artifacts: null,
        artifactsRevision: null,
        error: failed.error,
        reviewError: null,
        lastBuildResult: null,
        reviewInFlight: false,
        build: new BuildTracker(this.buildStarter, this.buildLog, this.buildHooks(entry.name)),
        progress: new SessionProgress((count) => this.onSubscriberCountChange?.(entry.name, count)),
        previewsRevision: null,
      });
    }
  }

  create(brief: string): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.idFactory();
      if (!SESSION_ID_PATTERN.test(id)) throw new HttpError(500, '内部错误：生成的会话 id 不合法。');
      if (this.sessions.has(id)) continue;
      const record: SessionRecord = {
        id,
        brief,
        status: 'thinking',
        state: null,
        messages: [{ role: 'user', text: brief }],
        submittedAnswers: new Map(),
        pendingAnswer: null,
        pendingDecision: null,
        previews: [],
        summary: null,
        briefStats: null,
        artifacts: null,
        artifactsRevision: null,
        error: null,
        reviewError: null,
        lastBuildResult: null,
        reviewInFlight: false,
        build: new BuildTracker(this.buildStarter, this.buildLog, this.buildHooks(id)),
        progress: new SessionProgress((count) => this.onSubscriberCountChange?.(id, count)),
        previewsRevision: null,
      };
      append(record, 'system', '会话已创建，正在解析需求…');
      this.sessions.set(id, record);
      void this.run(record);
      return id;
    }
    throw new HttpError(500, '内部错误：无法分配唯一会话 id。');
  }

  get(id: string): WebSnapshot {
    return this.snapshot(this.require(id));
  }

  /** 最近事件（从旧到新）；给出 afterSeq 时只返回其后的增量，用于 SSE 重连。 */
  progressSince(id: string, afterSeq: number | null = null): readonly WebProgressEvent[] {
    return this.require(id).progress.since(afterSeq);
  }

  /** 订阅该会话的进度；返回幂等取消函数。未知会话抛 HttpError(404)。 */
  subscribe(id: string, listener: (event: WebProgressEvent) => void): () => void {
    return this.require(id).progress.subscribe(listener);
  }

  answer(id: string, body: Record<string, unknown>): WebSnapshot {
    const record = this.require(id);
    if (record.status !== 'waiting_answers') {
      throw new HttpError(409, '当前会话不在等待回答。');
    }
    const state = record.state;
    if (state === null || state.questions.length === 0) throw new HttpError(409, '当前会话没有待回答的问题。');
    const raw = body['answers'];
    if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, 'answers 必须是非空数组。');

    const answers = new Map<string, string>();
    for (const item of raw) {
      if (!isRecord(item)) throw new HttpError(400, 'answers 的每一项必须是对象。');
      const questionId = nonEmptyText(item, 'questionId', 'answers.questionId', 64);
      const answer = nonEmptyText(item, 'answer', 'answers.answer', 4000);
      if (answers.has(questionId)) throw new HttpError(400, `问题 ${questionId} 被回答多次。`);
      answers.set(questionId, answer);
    }
    for (const question of state.questions) {
      if (!answers.has(question.id)) throw new HttpError(400, `缺少问题 ${question.id} 的回答。`);
    }
    if (answers.size !== state.questions.length) throw new HttpError(400, 'answers 包含不属于当前轮次的问题。');

    const pending = record.pendingAnswer;
    for (const question of state.questions) {
      const text = answers.get(question.id);
      if (text === undefined) continue;
      record.submittedAnswers.set(question.id, text);
      append(record, 'user', `问题：${question.text}\n回答：${text}`);
    }
    record.status = 'thinking';
    record.pendingAnswer = null;
    if (pending !== null) {
      const answer = answers.get(pending.questionId);
      if (answer === undefined) throw new HttpError(409, '当前问题没有对应回答。');
      record.submittedAnswers.delete(pending.questionId);
      pending.resolve(answer);
    }
    return this.snapshot(record);
  }

  decide(id: string, body: Record<string, unknown>): WebSnapshot {
    const record = this.require(id);
    const pending = record.pendingDecision;
    // 评审后重新生成的 revision 没有 pendingDecision，但同样停在 review 等确认。
    const revisionState =
      pending === null &&
      record.state !== null &&
      record.state.stage === 'review' &&
      record.state.check?.passed === true
        ? record.state
        : null;
    if (pending === null && revisionState === null) {
      throw new HttpError(409, '当前会话不在等待确认。');
    }
    if (pending !== null && record.status !== 'waiting_decision') {
      throw new HttpError(409, '当前会话不在等待确认。');
    }
    const action = body['action'];
    if (action !== 'confirm' && action !== 'revise' && action !== 'exit') {
      throw new HttpError(400, 'action 只能是 confirm、revise 或 exit。');
    }
    const feedbackRaw = body['feedback'];
    if (feedbackRaw !== undefined && typeof feedbackRaw !== 'string') {
      throw new HttpError(400, 'feedback 必须是字符串。');
    }
    const feedback = typeof feedbackRaw === 'string' ? feedbackRaw.trim() : '';
    if (action === 'confirm' && pending !== null && pending.kind !== 'review') {
      throw new HttpError(409, '方案检查未通过，不能确认；请提交修改意见。');
    }
    if (action === 'revise' && feedback === '') throw new HttpError(400, '修改意见不能为空。');
    if (feedback.length > 4000) throw new HttpError(400, '修改意见过长（最多 4000 字符）。');

    if (revisionState !== null) {
      if (action === 'exit') throw new HttpError(409, '评审后的方案只能确认或继续修改。');
      record.status = 'thinking';
      record.error = null;
      if (action === 'confirm') {
        append(record, 'user', '确认方案');
        void this.confirmRevision(record, revisionState);
        return this.snapshot(record);
      }
      append(record, 'user', `修改意见：${feedback}`);
      void this.reviseAfterReview(record, feedback);
      return this.snapshot(record);
    }

    if (pending === null) throw new HttpError(409, '当前会话不在等待确认。');
    let answer: string;
    if (action === 'confirm') {
      answer = 'y';
      append(record, 'user', '确认方案');
    } else if (action === 'revise') {
      answer = feedback;
      append(record, 'user', `修改意见：${feedback}`);
    } else {
      answer = 'q';
      append(record, 'user', '退出（不确认方案）');
    }
    record.status = 'thinking';
    record.pendingDecision = null;
    pending.resolve(answer);
    return this.snapshot(record);
  }

  /** 统一冲突选择：datum / gate / 室外分区 / 家具降级都走这里。 */
  async chooseConflict(id: string, body: Record<string, unknown>): Promise<WebSnapshot> {
    const record = this.require(id);
    const state = record.state;
    if (state === null) throw new HttpError(409, '会话还没有方案，不能选择冲突。');
    if (state.stage !== 'design' && state.stage !== 'check' && state.stage !== 'review') {
      throw new HttpError(409, `当前阶段 ${state.stage} 不能选择设计冲突。`);
    }
    const conflictId = nonEmptyText(body, 'conflictId', 'conflictId', 64);
    const optionId = nonEmptyText(body, 'optionId', 'optionId', 64);
    const noteRaw = body['note'];
    if (noteRaw !== undefined && typeof noteRaw !== 'string') {
      throw new HttpError(400, 'note 必须是字符串。');
    }
    const conflict = (state.designConflicts ?? []).find((item) => item.id === conflictId);
    if (conflict === undefined) throw new HttpError(409, `当前会话没有冲突 ${conflictId}。`);
    const option = conflict.options.find((candidate) => candidate.id === optionId);
    if (option === undefined) {
      throw new HttpError(400, `冲突 ${conflictId} 没有选项 ${optionId}。`);
    }
    // 运行中的对话正停在同一个冲突菜单上：把选择交回 ask，由对话自己 reduce + 落盘，
    // 避免网页状态与运行中的 next 分叉，也避免 chooseConflict 永远解不开 30s 的 ask。
    const pending = record.pendingDecision;
    if (pending?.conflictId === conflictId) {
      record.status = 'thinking';
      record.pendingDecision = null;
      append(record, 'user', `冲突 ${conflictId} 选择：${option.label}`);
      pending.resolve(optionId);
      return this.snapshot(record);
    }
    const pendingConflictId = pending?.conflictId;
    if (pendingConflictId !== null && pendingConflictId !== undefined) {
      throw new HttpError(409, `当前正在等待冲突 ${pendingConflictId} 的选择；请先完成该冲突。`);
    }
    const next = reduceSession(state, {
      kind: 'chooseConflictOption',
      conflictId,
      optionId,
      ...(typeof noteRaw === 'string' ? { note: noteRaw.trim() } : {}),
    });
    await this.save(record, next);
    record.status =
      next.stage === 'review' || next.stage === 'check' || next.stage === 'design' ? 'waiting_decision' : record.status;
    return this.snapshot(record);
  }

  /** 构建后评审的接受 / 定向修改 / 重新设计；只允许 post-review 且有报告。 */
  async reviewDecision(id: string, body: Record<string, unknown>): Promise<WebSnapshot> {
    const record = this.require(id);
    const visible = record.state;
    if (visible?.stage !== 'post-review') {
      throw new HttpError(409, '当前会话不在构建后评审阶段。');
    }
    if (visible.review === null) {
      throw new HttpError(409, '评审尚未生成，不能决定下一步；请查看 reviewError。');
    }
    // review 已可见说明最终评审 save 已开始；等同一队列排空，accept 一定排在它后面。
    await this.flushSaves(record);
    const state = record.state;
    if (state?.stage !== 'post-review' || state.review === null) {
      throw new HttpError(409, '评审状态已变化，请刷新后重试。');
    }

    const action = body['action'];
    if (action !== 'accept' && action !== 'targeted-revision' && action !== 'redesign') {
      throw new HttpError(400, 'action 只能是 accept、targeted-revision 或 redesign。');
    }
    const instructionsRaw = body['instructions'];
    if (instructionsRaw !== undefined && typeof instructionsRaw !== 'string') {
      throw new HttpError(400, 'instructions 必须是字符串。');
    }
    const instructions = typeof instructionsRaw === 'string' ? instructionsRaw.trim() : '';
    if (action !== 'accept' && instructions === '') {
      throw new HttpError(400, 'targeted-revision / redesign 必须提供修改说明。');
    }
    if (instructions.length > 4000) {
      throw new HttpError(400, '修改说明过长（最多 4000 字符）。');
    }
    const reason = instructions === '' ? '接受构建结果' : instructions;

    if (action === 'accept') {
      const spec = state.brief?.spec;
      const specPath = record.artifacts?.spec;
      const runId = state.build?.runId;
      if (spec === undefined || specPath === undefined || runId === undefined) {
        throw new HttpError(409, '缺少当前 spec / run 工件，不能接受评审。');
      }
      // 自定义 reviewBuilder 也只能生成报告，不能绕过 accept 时的工件 / 证据重验。
      const valid = await reviewMatchesCurrentArtifacts({
        state,
        spec,
        specPath,
        runDir: join(this.buildRunRoot, runId),
      });
      if (!valid) {
        throw new HttpError(
          409,
          '评审后 spec / archive / evidence 已变化或与当前 planner 不一致，必须重新构建并评审。',
        );
      }
      let next: SessionState;
      try {
        next = reduceSession(state, { kind: 'resolveReview', action: 'accept', instructions: reason });
      } catch (error) {
        if (error instanceof SessionTransitionError) throw new HttpError(409, error.message);
        throw error;
      }
      record.status = 'thinking';
      record.error = null;
      record.reviewError = null;
      try {
        // 只有 accept 状态真正写盘后才返回 200；失败时页面轮询能看到 error。
        await this.save(record, next);
      } catch (error) {
        record.status = 'error';
        record.error = describeError(error);
        this.buildLog(`[review] ${record.id} 保存接受结果失败：${messageOf(error)}`);
        throw new HttpError(500, `保存接受结果失败：${messageOf(error)}`);
      }
      record.status = 'done';
      return this.snapshot(record);
    }

    let next = reduceSession(state, { kind: 'resolveReview', action, instructions: reason });
    next = reduceSession(next, { kind: 'requestRevision', reason });
    record.status = 'thinking';
    record.error = null;
    record.reviewError = null;
    // 先落盘 resolveReview / requestRevision，再异步生成 revision+1。
    try {
      await this.save(record, next);
    } catch (error) {
      record.status = 'error';
      record.error = describeError(error);
      this.buildLog(`[review] ${record.id} 保存评审决定失败：${messageOf(error)}`);
      throw new HttpError(500, `保存评审决定失败：${messageOf(error)}`);
    }
    void this.reviseAfterReview(record, reason);
    return this.snapshot(record);
  }

  /**
   * 用户显式豁免一条未满足的必须项；只允许 post-review 且有评审时调用。
   * 豁免按当前 design revision 持久化到 reviewWaivers，并立即重算评审的 verdict / nextAction。
   */
  async waiveReviewMust(id: string, body: Record<string, unknown>): Promise<WebSnapshot> {
    const record = this.require(id);
    const visible = record.state;
    if (visible?.stage !== 'post-review') {
      throw new HttpError(409, '当前会话不在构建后评审阶段。');
    }
    if (visible.review === null) {
      throw new HttpError(409, '评审尚未生成，不能豁免必须项。');
    }
    // 与 reviewDecision 一样：review 已可见说明最终评审 save 已开始，先等队列排空。
    await this.flushSaves(record);
    const state = record.state;
    if (state?.stage !== 'post-review' || state.review === null) {
      throw new HttpError(409, '评审状态已变化，请刷新后重试。');
    }

    const mustId = nonEmptyText(body, 'mustId', 'mustId', 64);
    const choiceRaw = body['choice'];
    if (choiceRaw !== undefined && typeof choiceRaw !== 'string') {
      throw new HttpError(400, 'choice 必须是字符串。');
    }
    const choiceText = typeof choiceRaw === 'string' ? choiceRaw.trim() : '';
    if (choiceText.length > 4000) {
      throw new HttpError(400, 'choice 过长（最多 4000 字符）。');
    }
    const choice = choiceText === '' ? '用户豁免' : choiceText;
    const noteRaw = body['note'];
    if (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== 'string') {
      throw new HttpError(400, 'note 必须是字符串或 null。');
    }
    const noteText = typeof noteRaw === 'string' ? noteRaw.trim() : '';
    if (noteText.length > 4000) {
      throw new HttpError(400, 'note 过长（最多 4000 字符）。');
    }
    const note = noteText === '' ? null : noteText;

    const must = state.review.verdict.musts.find((entry) => entry.requirementId === mustId);
    if (must === undefined) {
      throw new HttpError(409, `评审中没有必须项 ${mustId}，不能豁免。`);
    }
    if (must.status === 'met') {
      throw new HttpError(409, `必须项 ${mustId} 已 met，不需要豁免。`);
    }

    let next: SessionState;
    try {
      next = reduceSession(state, { kind: 'waiveReviewMust', mustId, choice, note });
    } catch (error) {
      if (error instanceof SessionTransitionError) throw new HttpError(409, error.message);
      throw error;
    }
    try {
      await this.save(record, next);
    } catch (error) {
      record.status = 'error';
      record.error = describeError(error);
      this.buildLog(`[review] ${record.id} 保存必须项豁免失败：${messageOf(error)}`);
      throw new HttpError(500, `保存必须项豁免失败：${messageOf(error)}`);
    }
    record.status = 'done';
    return this.snapshot(record);
  }

  /**
   * 评审失败后重试：复用当前进程记录的 run 结果与 brief.spec。
   * 服务重启后没有原始 result，拒绝重试而不是伪造评审。
   */
  async retryReview(id: string): Promise<WebSnapshot> {
    const record = this.require(id);
    const visible = record.state;
    if (visible?.stage !== 'post-review') throw new HttpError(409, '当前会话不在构建后评审阶段。');
    if (visible.review !== null) throw new HttpError(409, '当前会话已有评审，不需要重试。');
    if (record.reviewError === null) throw new HttpError(409, '当前会话没有可重试的评审错误。');
    if (record.reviewInFlight) throw new HttpError(409, '评审正在生成，请稍后再试。');
    await this.flushSaves(record);
    const state = record.state;
    if (state?.stage !== 'post-review' || state.review !== null) {
      throw new HttpError(409, '评审状态已变化，请刷新后重试。');
    }
    const spec = state.brief?.spec;
    if (spec === undefined) throw new HttpError(409, '会话缺少 BuildSpec，无法重试评审。');
    const result = record.lastBuildResult;
    if (result === null) {
      throw new HttpError(409, '服务重启后缺少原始构建结果，无法重试评审；请重新构建。');
    }

    record.reviewInFlight = true;
    record.status = 'thinking';
    record.error = null;
    let next: SessionState;
    try {
      const report = await this.reviewBuilder({
        spec,
        result,
        ...(record.artifacts === null ? {} : { specPath: record.artifacts.spec }),
        verifiedMustObjects: trustedVerifiedObjects(state, spec),
      });
      next = reduceSession(state, { kind: 'recordReview', report });
    } catch (error) {
      record.reviewError = `评审生成失败：${messageOf(error)}`;
      record.status = 'done';
      this.buildLog(`[review] ${id} 重试失败：${messageOf(error)}`);
      return this.snapshot(record);
    } finally {
      record.reviewInFlight = false;
    }

    record.reviewError = null;
    try {
      await this.save(record, next);
    } catch (error) {
      record.status = 'error';
      record.error = describeError(error);
      this.buildLog(`[review] ${id} 保存重试评审失败：${messageOf(error)}`);
      throw new HttpError(500, `保存重试评审失败：${messageOf(error)}`);
    }
    record.status = 'done';
    return this.snapshot(record);
  }

  async preview(id: string, name: string): Promise<string> {
    const record = this.require(id);
    if (!PREVIEW_NAME.test(name)) throw new HttpError(400, '预览文件名不合法。');
    if (!record.previews.some((item) => item.name === name)) throw new HttpError(404, '预览文件不存在。');
    try {
      return await readFile(join(sessionDir(record.id, { root: this.root }), 'preview', name), 'utf8');
    } catch (error) {
      if (isRecord(error) && error['code'] === 'ENOENT') throw new HttpError(404, '预览文件不存在。');
      throw error;
    }
  }

  /** 只在已确认（compile + confirmedDesignRevision + 当前 revision artifacts）的 live 会话启动后台构建。 */
  startBuild(id: string, body: Record<string, unknown>): WebBuildState {
    const record = this.require(id);
    const state = record.state;
    const revision = state?.confirmedDesignRevision ?? null;
    if (
      record.status !== 'done' ||
      record.artifacts === null ||
      record.artifactsRevision === null ||
      state?.stage !== 'compile' ||
      revision === null ||
      state.currentDesignRevision !== revision ||
      record.artifactsRevision !== revision ||
      state.brief?.spec.schemeRevision !== revision
    ) {
      throw new HttpError(409, '方案尚未确认（或 artifacts 与当前 revision 不一致），不能启动构建。');
    }
    if (record.build.running) throw new HttpError(409, '该会话已有进行中的构建。');
    if (this.mode === 'mock') throw new HttpError(409, 'mock 模式不执行构建；请用 --live 实测。');

    const seedRaw = body['seed'];
    if (
      seedRaw !== undefined &&
      (typeof seedRaw !== 'number' || !Number.isSafeInteger(seedRaw) || seedRaw < 0 || seedRaw > 2 ** 32 - 1)
    ) {
      throw new HttpError(400, 'seed 应为 0–4294967295 的整数。');
    }
    const maxCnyRaw = body['maxCny'];
    if (maxCnyRaw !== undefined && (typeof maxCnyRaw !== 'number' || !Number.isFinite(maxCnyRaw))) {
      throw new HttpError(400, 'maxCny 应为数字。');
    }
    const requestedMaxCny = maxCnyRaw ?? this.buildMaxCny;
    if (requestedMaxCny > MAX_RUN_CNY) {
      throw new HttpError(400, `maxCny 不得超过 ${String(MAX_RUN_CNY)}。`);
    }
    if (requestedMaxCny <= 0) {
      throw new HttpError(400, `maxCny 应大于 0 且不超过 ${String(MAX_RUN_CNY)}。`);
    }
    const maxCny = Math.min(requestedMaxCny, this.buildMaxCny);
    return record.build.start({
      sessionId: record.id,
      sessionDir: sessionDir(record.id, { root: this.root }),
      outDir: this.buildRunRoot,
      seed: seedRaw ?? 0,
      maxCny,
    });
  }

  getBuild(id: string): WebBuildState {
    return this.require(id).build.snapshot();
  }

  /** 只读 `delivery/render/<name>`；名字不在白名单或未列出时 404。 */
  async buildRender(id: string, name: string): Promise<Buffer> {
    const record = this.require(id);
    const path = record.build.renderPath(name);
    if (path === null) throw new HttpError(404, '渲染图不存在。');
    try {
      return await readFile(path);
    } catch (error) {
      if (isRecord(error) && error['code'] === 'ENOENT') throw new HttpError(404, '渲染图不存在。');
      throw error;
    }
  }

  private buildHooks(id: string): BuildTrackerHooks {
    return {
      onStart: (info) => {
        this.handleBuildStart(id, info);
      },
      onFinish: (result) => this.handleBuildFinish(id, result),
      onError: (error) => this.handleBuildError(id, error),
    };
  }

  /** 构建启动：SessionState compile → build；保存失败只记录，不把构建标记为失败。 */
  private handleBuildStart(id: string, info: { readonly runId: string }): void {
    const record = this.sessions.get(id);
    if (record === undefined) return;
    const state = record.state;
    try {
      if (state?.stage !== 'compile' || state.confirmedDesignRevision === null) {
        throw new Error(`构建启动时会话不在 compile 阶段（当前 ${state?.stage ?? 'unknown'}）。`);
      }
      const next = reduceSession(state, { kind: 'startBuild', runId: info.runId });
      record.reviewError = null;
      record.error = null;
      void this.save(record, next).catch((error: unknown) => {
        this.buildLog(`[build] ${id} 保存 startBuild 失败：${messageOf(error)}`);
      });
    } catch (error) {
      record.status = 'error';
      record.error = describeError(error);
      this.buildLog(`[build] ${id} start hook 失败：${messageOf(error)}`);
    }
  }

  /** 构建成功：finishBuild → 读取 run facts → recordReview；评审失败只写 reviewError。 */
  private async handleBuildFinish(id: string, result: DesignBuildRunResult): Promise<void> {
    const record = this.sessions.get(id);
    if (record === undefined) return;
    await this.flushSaves(record);
    const state = record.state;
    const runId = result.outcome.runId;
    if (state?.stage !== 'build' || state.build?.runId !== runId) {
      if (record.status !== 'error') {
        record.status = 'error';
        record.error = `构建结果 runId ${runId} 与当前会话构建不一致，未记录评审。`;
      }
      this.buildLog(`[build] ${id} finish hook 未匹配：stage=${state?.stage ?? 'null'} runId=${runId}`);
      return;
    }

    let next = state;
    try {
      next = reduceSession(state, { kind: 'finishBuild', runId, status: 'succeeded', failure: null });
      record.lastBuildResult = result;
      record.reviewError = null;
      // 先落盘 post-review，再生成评审：网页轮询看到 stage=post-review 后会继续等待 review，
      // 不会因为 status=done / stage 仍是 build 而停止轮询。
      await this.save(record, next);
      record.reviewInFlight = true;
      try {
        const spec = next.brief?.spec;
        if (spec === undefined) throw new Error('会话没有 BuildSpec，无法生成评审。');
        // 构建器已在 runDir 生成并落盘 review.json；优先复用它，保证 session 与 run 评审同一份。
        const report =
          result.review ??
          (await this.reviewBuilder({
            spec,
            result,
            ...(record.artifacts === null ? {} : { specPath: record.artifacts.spec }),
            verifiedMustObjects: trustedVerifiedObjects(state, spec),
          }));
        next = reduceSession(next, { kind: 'recordReview', report });
      } catch (error) {
        record.reviewError = `评审生成失败：${messageOf(error)}`;
        this.buildLog(`[review] ${id} 生成失败：${messageOf(error)}`);
      } finally {
        record.reviewInFlight = false;
      }
      record.status = 'done';
      await this.save(record, next);
    } catch (error) {
      record.status = 'error';
      record.error = describeError(error);
      this.buildLog(`[build] ${id} finish hook 失败：${messageOf(error)}`);
      try {
        await this.save(record, next);
      } catch (saveError) {
        this.buildLog(`[build] ${id} 保存 finishBuild 失败：${messageOf(saveError)}`);
      }
    }
  }

  /** 构建失败 / starter 抛错：仅在 build 且绑定 running 时写 finishBuild(failed)，不生成评审。 */
  private async handleBuildError(id: string, error: unknown): Promise<void> {
    const record = this.sessions.get(id);
    if (record === undefined) return;
    await this.flushSaves(record);
    const state = record.state;
    const message = messageOf(error).trim() === '' ? '构建失败（未提供错误信息）' : messageOf(error);
    if (state?.stage !== 'build' || state.build?.status !== 'running') {
      this.buildLog(`[build] ${id} 构建失败（未绑定 running build）：${message}`);
      return;
    }
    try {
      const next = reduceSession(state, {
        kind: 'finishBuild',
        runId: state.build.runId,
        status: 'failed',
        failure: message,
      });
      record.status = 'done';
      record.error = null;
      await this.save(record, next);
    } catch (reduceError) {
      record.status = 'error';
      record.error = describeError(reduceError);
      this.buildLog(`[build] ${id} 记录失败状态出错：${messageOf(reduceError)}`);
    }
  }

  /** 评审后的新 revision：确认 → compile → 写 artifacts → done。 */
  private async confirmRevision(record: SessionRecord, state: SessionState): Promise<void> {
    try {
      const scheme = state.designs[state.designs.length - 1];
      const requirements = state.requirements;
      if (scheme === undefined || requirements === null || state.stage !== 'review' || state.check?.passed !== true) {
        throw new Error('当前 revision 没有通过检查，不能确认。');
      }
      let next = reduceSession(state, { kind: 'confirmDesign', designRevision: scheme.meta.revision });
      const brief = compileBuildBrief(scheme, requirements);
      next = reduceSession(next, { kind: 'compileBrief', brief });
      const intent = next.intents?.length === next.designs.length ? next.intents[next.intents.length - 1] : undefined;
      // 先清掉旧 revision 的 artifacts / 构建结果，再写新 artifacts；期间 startBuild 会看到
      // artifacts=null 而拒绝，不会拿上一版 artifacts 启动构建。
      record.artifacts = null;
      record.artifactsRevision = null;
      record.briefStats = null;
      record.build.reset();
      record.reviewError = null;
      await this.writeArtifactsFor(record, brief, intent);
      // artifacts 写完后一次性落盘 compile 状态；startBuild 再按 revision 双重校验。
      await this.save(record, next);
      record.status = 'done';
      record.error = null;
      append(record, 'assistant', '方案已确认，artifacts 已写入。');
      record.progress.emit({
        kind: 'stage',
        stage: 'session',
        status: 'done',
        detail: '方案已确认并写入 artifacts',
      });
    } catch (error) {
      record.status = 'error';
      record.error = describeError(error);
      record.pendingDecision = null;
      append(record, 'system', `错误：${record.error}`);
      record.progress.emit({
        kind: 'error',
        stage: 'session',
        status: 'error',
        detail: record.error.length <= 500 ? record.error : `${record.error.slice(0, 500)}…`,
      });
      try {
        if (record.state !== null) await this.save(record, record.state);
      } catch (saveError) {
        this.buildLog(`[review] ${record.id} 保存确认失败：${messageOf(saveError)}`);
      }
    }
  }

  /**
   * 按评审意见生成 revision+1；检查失败最多重试 1 次。
   * 成功回到 review（等待确认），失败停在 error 并保留当前 state。
   */
  private async reviseAfterReview(record: SessionRecord, instructions: string): Promise<void> {
    try {
      const initialState = record.state;
      if (initialState === null) throw new Error('会话状态不存在，无法生成修订方案。');
      const requirements = initialState.requirements;
      if (requirements === null) throw new Error('会话缺少需求图，无法生成修订方案。');
      let state: SessionState = initialState;
      if (state.stage === 'review') {
        state = reduceSession(state, { kind: 'requestRevision', reason: instructions });
        await this.save(record, state);
      } else if (state.stage !== 'revise') {
        throw new Error(`当前阶段 ${state.stage} 不能生成评审后的修订方案。`);
      }

      const client = this.clientFactory();
      const onProgress: InteractionProgressCallback = (event) => {
        record.progress.emitInteraction(event);
      };
      let feedback = instructions;
      let attempt = 0;

      for (;;) {
        const previous = state.designs[state.designs.length - 1];
        if (previous === undefined) throw new Error('会话没有可修订的方案。');
        const previousIntent = state.intents?.[state.intents.length - 1];
        const generated = await generateIntentDesign({
          client,
          requirements,
          revision: previous.meta.revision + 1,
          schemeId: previous.meta.id,
          previousScheme: previous,
          ...(previousIntent === undefined ? {} : { previousIntent }),
          feedback,
          exchanges: [],
          outputMode: this.outputMode,
          onProgress,
          ...(this.maxBlocks === undefined ? {} : { maxBlocks: this.maxBlocks }),
          ...(this.maxCostCny === undefined ? {} : { maxCostCny: this.maxCostCny }),
        });
        const proposed = reduceSession(state, {
          kind: 'proposeDesign',
          scheme: generated.scheme,
          intent: generated.intent,
          conflicts: generated.conflicts,
        });
        const checked = evaluateSchemeWithProgress(requirements, proposed, generated.scheme, onProgress);
        state = checked.state;

        if (checked.issues.length === 0) {
          // 新 revision 取代旧方案：旧 artifacts / 构建结果 / 确认状态都不能继续冒充当前结果。
          record.artifacts = null;
          record.artifactsRevision = null;
          record.briefStats = null;
          record.build.reset();
          record.reviewError = null;
          record.status = 'waiting_decision';
          record.error = null;
          await this.save(record, state);
          // save 会按最新方案重算 briefStats；新 revision 尚未确认，快照里必须保持为空。
          record.briefStats = null;
          return;
        }

        const issueText = checked.issues
          .slice(0, 20)
          .map((issue) => `[${issue.code}] ${issue.message}`)
          .join('；');
        if (attempt >= 1) {
          const message = `修订方案检查未通过：${issueText}；下一步：新建会话后重试。`;
          record.error = message;
          this.buildLog(`[review] ${record.id} 修订后检查仍未通过：${issueText}`);
          await this.persistFailure(record, { code: 'check-failed', message }, state);
          record.status = 'error';
          return;
        }
        attempt += 1;
        feedback = `检查问题：${issueText}；只修这些问题，未点名区域保持不变。`;
      }
    } catch (error) {
      const message = failureText(error);
      record.error = message;
      append(record, 'system', `错误：${message}`);
      record.progress.emit({
        kind: 'error',
        stage: 'session',
        status: 'error',
        detail: message.length <= 500 ? message : `${message.slice(0, 500)}…`,
      });
      await this.persistFailure(record, {
        code: generationFailureOf(error)?.code ?? 'session-failed',
        message,
      });
      record.status = 'error';
    }
  }

  private async writeArtifactsFor(
    record: SessionRecord,
    brief: BuildBrief,
    intent?: DesignIntent,
  ): Promise<ArtifactPaths> {
    record.progress.emit({ kind: 'stage', stage: 'artifacts', status: 'start' });
    try {
      const paths = await this.artifactWriter(sessionDir(record.id, { root: this.root }), brief, intent);
      record.artifacts = paths;
      record.artifactsRevision = brief.spec.schemeRevision;
      record.briefStats = briefStats(brief);
      const files = [
        paths.design,
        paths.task,
        paths.spec,
        paths.gates,
        paths.promptMeta,
        ...(paths.designIntent === undefined ? [] : [paths.designIntent]),
      ];
      for (const path of files) {
        record.progress.emit({
          kind: 'file',
          stage: 'artifacts',
          status: 'done',
          path: basename(path),
        });
      }
      record.progress.emit({
        kind: 'stage',
        stage: 'artifacts',
        status: 'done',
        detail: `${String(files.length)} 个文件`,
      });
      return paths;
    } catch (error) {
      record.progress.emit({
        kind: 'stage',
        stage: 'artifacts',
        status: 'error',
        detail: messageOf(error),
      });
      throw error;
    }
  }

  private require(id: string): SessionRecord {
    let checked: string;
    try {
      checked = assertSessionId(id);
    } catch (error) {
      if (error instanceof SessionStoreError) throw new HttpError(400, error.message);
      throw error;
    }
    const record = this.sessions.get(checked);
    if (record === undefined) throw new HttpError(404, `会话 ${checked} 不存在。`);
    return record;
  }

  private async run(record: SessionRecord, resume?: SessionState): Promise<void> {
    const storage: ConversationStorage = {
      save: (state) => this.save(record, state),
      writeArtifacts: (brief, intent) => this.writeArtifactsFor(record, brief, intent),
    };
    const io: ConversationIO = {
      say: (text) => {
        append(record, 'assistant', text);
      },
      ask: (question) => this.waitDecision(record, question),
      askQuestion: (question) => this.waitAnswer(record, question),
    };
    const input: ConversationInput = {
      sessionId: record.id,
      task: record.brief,
      ...(resume === undefined ? {} : { resume }),
      ...(this.maxBlocks === undefined ? {} : { maxBlocks: this.maxBlocks }),
      ...(this.maxCostCny === undefined ? {} : { maxCostCny: this.maxCostCny }),
    };
    const onProgress: InteractionProgressCallback = (event) => {
      record.progress.emitInteraction(event);
    };

    try {
      const client = this.clientFactory();
      const result = await runDesignConversation(client, input, io, {
        storage,
        designMode: this.designMode,
        maxRevisions: this.maxRevisions,
        maxClarificationRounds: this.maxClarificationRounds,
        outputMode: this.outputMode,
        onProgress,
      });
      record.state = result.state;
      if (result.brief !== null) record.briefStats = briefStats(result.brief);
      record.status = 'done';
      record.error = null;
    } catch (error) {
      const generationFailure = generationFailureOf(error);
      const failureStage = record.state?.stage ?? 'intake';
      if (generationFailure !== null) {
        try {
          await writeFailureFile({
            root: this.root,
            sessionId: record.id,
            stage: failureStage,
            error: generationFailure,
          });
        } catch (writeError) {
          // 诊断写盘失败不能覆盖原始生成错误；只记日志，会话仍进入 error。
          this.buildLog(`[session] ${record.id} 写 failure.json 失败：${messageOf(writeError)}`);
        }
      }
      const message = failureText(error);
      record.error = message;
      record.pendingAnswer = null;
      record.pendingDecision = null;
      append(record, 'system', `错误：${message}`);
      record.progress.emit({
        kind: 'error',
        stage: 'session',
        status: 'error',
        detail: message.length <= 500 ? message : `${message.slice(0, 500)}…`,
      });
      // session.json 同步落到 stage=error；页面重启后仍能看到失败原因，而不是停在 design。
      // 落盘完成后再进入终态，避免 GET 先看到 status=error + stage=design 后停止轮询。
      await this.persistFailure(record, {
        code: generationFailure?.code ?? 'session-failed',
        message,
      });
      record.status = 'error';
    }
  }

  /**
   * 把失败状态写进 session.json：stage=error + failure{stage,code,message}。
   * 写盘失败只记日志，不覆盖已经上报给页面的原始错误。
   */
  private async persistFailure(
    record: SessionRecord,
    failure: { readonly code: string; readonly message: string },
    base?: SessionState,
  ): Promise<void> {
    const state = base ?? record.state ?? createSession(record.id);
    try {
      await this.save(record, markSessionFailed(state, failure));
    } catch (error) {
      this.buildLog(`[session] ${record.id} 保存失败状态失败：${messageOf(error)}`);
    }
  }

  /** 串行保存：按调用顺序写 session.json，后入队的 save 不会先 rename。 */
  private save(record: SessionRecord, state: SessionState): Promise<void> {
    const previous = this.saveQueues.get(record.id) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.persist(record, state));
    // 队列只跟踪“已收尾”，单个 save 的失败仍返回给调用方。
    const tail = task.catch(() => undefined);
    this.saveQueues.set(record.id, tail);
    void tail.then(() => {
      if (this.saveQueues.get(record.id) === tail) this.saveQueues.delete(record.id);
    });
    return task;
  }

  /** 等待当前队列排空；等待期间有新 save 入队会继续等。 */
  private async flushSaves(record: SessionRecord): Promise<void> {
    for (;;) {
      const pending = this.saveQueues.get(record.id);
      if (pending === undefined) return;
      await pending;
      if (this.saveQueues.get(record.id) === pending) return;
    }
  }

  private async persist(record: SessionRecord, state: SessionState): Promise<void> {
    // 先落盘再更新内存状态：页面看到的 review / stage 一定已经写进 session.json。
    await this.sessionWriter(state, { root: this.root });
    record.state = state;
    const scheme = state.designs[state.designs.length - 1];
    if (scheme !== undefined) {
      const revision = scheme.meta.revision;
      if (record.previewsRevision !== revision) {
        record.previews = [
          ...(await writePreviewBundle({
            id: record.id,
            root: this.root,
            scheme,
            onStage: (status, detail) => {
              record.progress.emit({
                kind: 'stage',
                stage: 'preview',
                status,
                ...(detail === undefined ? {} : { detail }),
              });
            },
            onFile: (path, bytes) => {
              record.progress.emit({ kind: 'file', stage: 'preview', status: 'done', path, bytes });
            },
          })),
        ];
        record.previewsRevision = revision;
      }
      record.summary = sectionSummary(state, scheme);
      if (state.requirements !== null) {
        record.briefStats = briefStats(compileBuildBrief(scheme, state.requirements));
      }
    }
    if (state.stage === 'clarify') {
      record.status = 'waiting_answers';
    } else if (record.status !== 'waiting_decision' && record.status !== 'done' && record.status !== 'error') {
      record.status = 'thinking';
    }
  }

  private waitAnswer(record: SessionRecord, question: ClarificationQuestion): Promise<string> {
    const ready = record.submittedAnswers.get(question.id);
    if (ready !== undefined) {
      record.submittedAnswers.delete(question.id);
      return Promise.resolve(ready);
    }
    record.status = 'waiting_answers';
    return new Promise((resolve) => {
      record.pendingAnswer = { questionId: question.id, resolve };
    });
  }

  private waitDecision(record: SessionRecord, prompt: string): Promise<string> {
    const kind: DecisionKind = prompt.includes('是否确认方案') ? 'review' : 'feedback';
    const conflictId = /请选择冲突 (\S+) 的处理方式/.exec(prompt)?.[1] ?? null;
    record.status = 'waiting_decision';
    return new Promise((resolve) => {
      record.pendingDecision = { kind, resolve, conflictId };
    });
  }

  private snapshot(record: SessionRecord): WebSnapshot {
    const state = record.state;
    // 只返回与当前 build.runId 绑定的评审；新 run 已开始但 review 尚未落盘时，旧评审必须视为 stale。
    const review = state === null ? null : currentReview(state);
    return {
      id: record.id,
      mode: this.mode,
      status: record.status,
      stage: state?.stage ?? 'intake',
      brief: record.brief,
      messages: record.messages.map((message) => ({ ...message })),
      questions:
        record.status === 'waiting_answers'
          ? (state?.questions ?? []).map((question) => ({ id: question.id, text: question.text }))
          : [],
      summary: record.summary,
      previews: record.previews.map((item) => ({ ...item })),
      artifacts: record.artifacts,
      error: record.error,
      review,
      reviewStale: review === null && state?.review !== null && state?.review !== undefined,
      reviewError: record.reviewError,
      confirmed:
        record.artifacts !== null &&
        record.artifactsRevision !== null &&
        state?.confirmedDesignRevision === record.artifactsRevision &&
        state.currentDesignRevision === record.artifactsRevision,
      confirmedDesignRevision: state?.confirmedDesignRevision ?? null,
      canStartBuild:
        this.mode === 'live' &&
        record.status === 'done' &&
        record.artifacts !== null &&
        record.artifactsRevision !== null &&
        state?.stage === 'compile' &&
        state.confirmedDesignRevision === record.artifactsRevision &&
        state.currentDesignRevision === record.artifactsRevision &&
        state.brief?.spec.schemeRevision === record.artifactsRevision &&
        !record.build.running,
      canExit: record.status === 'waiting_decision' && record.pendingDecision !== null,
      revisions: state?.designs[state.designs.length - 1]?.meta.revision ?? 0,
      checkIssues: state?.check?.issues ?? [],
      conflicts: state?.designConflicts ?? [],
      decisionKind:
        record.pendingDecision?.kind ?? (state?.stage === 'review' && state.check?.passed === true ? 'review' : null),
      briefStats: record.briefStats,
      buildCommand: buildCommand(record.id, this.root),
      build: record.build.snapshot(),
      progressSeq: record.progress.latestSeq,
    };
  }
}
