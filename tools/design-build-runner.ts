/**
 * 可复用的构建启动器：把已确认的 `design.md` / `build-task.md` / `gates.json` 交给 `runRun`。
 *
 * 负责：读 artifacts、解析 limits / seed、只在 live 模式读配置与创建 client、包装 `RunWriter` 转发事件、
 *   返回 outcome / runDir / delivery / 渲染图路径。网页后台构建与 `design:build --live` 共用同一条链路。
 * 不负责：HTTP 路由、页面状态、轮询（tools/interaction-server-*.ts）；不重写 runner / 沙箱 / 渲染。
 */

import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { RunOutcome, RunnerDeps } from '@pg/agent/runner';
import { runRun } from '@pg/agent/runner';
import { loadRegistry } from '@pg/blocks/load';
import { createRenderer } from '@pg/render/render';
import type { Renderer } from '@pg/render/render';
import type { ReviewReport } from '@pg/interaction/review';
import { createPrechecker } from '@pg/sandbox/precheck';
import type { Prechecker } from '@pg/sandbox/precheck';
import { runCode } from '@pg/sandbox/run';
import type { EventBody, EventType, RunLimits } from '@pg/store/events';
import { RunLimits as RunLimitsSchema } from '@pg/store/events';
import { createRunDir } from '@pg/store/run-dir';
import type { RunWriter } from '@pg/store/run-dir';
import { DEFAULT_CHROME_PATH } from '@pg/web/model-render';

import {
  DEFAULT_MAX_TURNS,
  DEFAULT_OUT_DIR,
  DEFAULT_SUBMIT_WINDOW,
  DEFAULT_WALL_MS,
  MAX_RUN_CNY,
} from './agent-massing-args.ts';
import { estimateTokens, loadWorldDts, massingRunId, voxelExternalVersions } from './agent-massing-deps.ts';
import { formatConformanceDeliveryNote } from './conformance-note.ts';
import { computeShadowForRun } from './conformance-shadow.ts';
import { projectExpectedFurniture } from './coverage-evidence.ts';
import {
  checkShadowHooks,
  DesignBuildError,
  designRunnerInput,
  readDesignSession,
  resolveLiveRuntime,
  shadowDatumOf,
  shadowSummaryOf,
  writeSessionBuildSheet,
} from './design-build.ts';
import type { DesignBuildDeps, DesignBuildOptions, DesignSession, ShadowRunSummary } from './design-build.ts';
import { gitSnapshot, realClock, realSleep } from './model-agent-deps.ts';
import { buildRunReview, writeRunReview } from './run-review.ts';

/** 交付渲染图文件名白名单；网页下载与列目录共用。 */
export const DELIVERY_RENDER_NAME = /^[a-z0-9_-]+\.png$/;

/** 转发给网页的事件：不带头部与 blob，只留映射需要的 type / seq / turn / body。 */
export type DesignBuildEvent = {
  readonly [K in EventType]: {
    readonly type: K;
    readonly seq: number;
    readonly turn: number | null;
    readonly body: EventBody<K>;
  };
}[EventType];

export interface DesignBuildStartInfo {
  readonly runId: string;
  readonly runDir: string;
}

export interface DesignBuildRunOptions {
  readonly sessionDir: string;
  /** run 根目录；缺省 `.work/runs/`。 */
  readonly outDir?: string;
  readonly seed?: number;
  /** 缺少的 limits 字段用默认值补齐；给了 maxCny 时后者覆盖 maxCostCny。 */
  readonly limits?: Partial<RunLimits>;
  readonly maxCny?: number;
  readonly onStart?: (info: DesignBuildStartInfo) => void;
  readonly onEvent?: (event: DesignBuildEvent) => void;
}

export interface DesignBuildRunResult {
  readonly outcome: RunOutcome;
  readonly runDir: string;
  readonly delivery: RunOutcome['delivery'];
  /** `delivery/render/*.png` 的绝对路径，按文件名排序。 */
  readonly renders: readonly string[];
  /** report-only 影子摘要；不参与 outcome / exit / submit。旧调用方可省略。 */
  readonly shadow?: ShadowRunSummary;
  /** 从当前 run 的 evidence 生成的评审；同时写入 `runDir/review.json`。 */
  readonly review?: ReviewReport | null;
}

function forwardingWriter(store: RunWriter, onEvent: DesignBuildRunOptions['onEvent']): RunWriter {
  if (onEvent === undefined) return store;
  return {
    ...store,
    append<T extends EventType>(type: T, turn: number | null, body: EventBody<T>): number {
      const seq = store.append(type, turn, body);
      try {
        onEvent({ type, seq, turn, body } as DesignBuildEvent);
      } catch {
        // 网页观察者不应影响构建；事件已落盘，继续跑。
      }
      return seq;
    },
  };
}

/** 从 run 的交付目录列出 PNG；不存在或读失败时返回空数组。 */
export function listDeliveryRenders(runDir: string): string[] {
  const dir = join(runDir, 'delivery', 'render');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && DELIVERY_RENDER_NAME.test(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function resolveLimits(options: DesignBuildRunOptions): RunLimits {
  const base: RunLimits = {
    maxCostCny: options.maxCny ?? options.limits?.maxCostCny ?? MAX_RUN_CNY,
    maxTurns: options.limits?.maxTurns ?? DEFAULT_MAX_TURNS,
    wallMs: options.limits?.wallMs ?? DEFAULT_WALL_MS,
    submitWindow: options.limits?.submitWindow ?? DEFAULT_SUBMIT_WINDOW,
  };
  const requested = options.maxCny === undefined ? base : { ...base, maxCostCny: options.maxCny };
  const limits = RunLimitsSchema.parse(requested);
  if (limits.maxCostCny > MAX_RUN_CNY) {
    throw new DesignBuildError(
      `单次构建花费上限不能超过 ${String(MAX_RUN_CNY)}，实际是 ${String(limits.maxCostCny)}。`,
    );
  }
  return limits;
}

function resolveSeed(seed: number | undefined): number {
  const value = seed ?? 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > 2 ** 32 - 1) {
    throw new DesignBuildError(`seed 应为 0–4294967295 的整数，实际是 ${String(seed)}。`);
  }
  return value;
}

function cliOptions(session: DesignSession, options: DesignBuildRunOptions, limits: RunLimits): DesignBuildOptions {
  return {
    sessionDir: session.dir,
    mode: 'live',
    seed: resolveSeed(options.seed),
    maxCny: limits.maxCostCny,
    maxTurns: limits.maxTurns,
    wallMs: limits.wallMs,
    submitWindow: limits.submitWindow,
  };
}

/** 真预检 + 真 bwrap + registry / 渲染 / run 目录 / git 快照；失败时抛错，由调用方映射状态。 */
export async function startDesignBuild(
  options: DesignBuildRunOptions,
  deps: DesignBuildDeps = {},
): Promise<DesignBuildRunResult> {
  const session = readDesignSession(options.sessionDir);
  writeSessionBuildSheet(session);
  const limits = resolveLimits(options);
  const optionsForRuntime = cliOptions(session, options, limits);
  const runtime = resolveLiveRuntime(optionsForRuntime, deps);
  const runRoot = options.outDir ?? DEFAULT_OUT_DIR;
  const runId = massingRunId(session.taskPath, (deps.now ?? (() => new Date()))());

  const registry = loadRegistry();
  const worldDts = loadWorldDts();
  let prechecker: Prechecker | undefined;
  let renderer: Renderer | undefined;
  let store: RunWriter | undefined;
  try {
    const readyPrechecker = createPrechecker(worldDts);
    prechecker = readyPrechecker;
    const readyRenderer = createRenderer(registry, { chromePath: deps.chromePath ?? DEFAULT_CHROME_PATH });
    renderer = readyRenderer;
    const git = gitSnapshot();
    const runStore = createRunDir(runRoot, runId);
    store = forwardingWriter(runStore, options.onEvent);
    options.onStart?.({ runId, runDir: runStore.dir });
    const shadowHooks = checkShadowHooks(session, runStore.dir);
    const versions = voxelExternalVersions(runStore, readyPrechecker.version, git, worldDts);
    const runnerDeps: RunnerDeps = {
      client: runtime.client,
      store,
      check: {
        prechecker: readyPrechecker,
        registry,
        gates: session.gates,
        expectedObjects: session.buildSheet.expectedObjects,
        expectedFurniture: projectExpectedFurniture(session.spec),
        conformanceReportOf: shadowHooks.conformanceReportOf,
        onCheckArchive: shadowHooks.onCheckArchive,
        runCode,
      },
      render: (archive, request) => readyRenderer.render(archive, request),
      worldDts,
      clock: deps.clock ?? realClock,
      sleep: deps.sleep ?? realSleep,
      versions,
      countTokens: deps.countTokens ?? estimateTokens,
      deliveryNote: ({ codeVersion, hash }) =>
        formatConformanceDeliveryNote({
          report: shadowHooks.current()?.report ?? null,
          evidence: shadowHooks.current()?.evidence ?? null,
          codeVersion,
          hash,
          runId: basename(runStore.dir),
        }),
    };
    const input = designRunnerInput(session, {
      seed: optionsForRuntime.seed,
      limits: runtime.limits,
      config: runtime.config,
    });
    const outcome = await (deps.runRun ?? runRun)(input, runnerDeps);
    let finalShadow = shadowHooks.current();
    if (outcome.delivery !== null) {
      finalShadow = computeShadowForRun({
        specPath: session.specPath,
        runDir: runStore.dir,
        datum: shadowDatumOf(session),
        verifiedMapping: session.verifiedMapping,
      });
    }
    let review: ReviewReport | null = null;
    if (outcome.delivery !== null) {
      try {
        review = await buildRunReview({
          spec: session.spec,
          specPath: session.specPath,
          runDir: runStore.dir,
          verifiedMustObjects: session.verifiedMapping.schemes[session.spec.schemeId] ?? {},
          verifiedMustIds: Object.keys(session.verifiedMapping.schemes[session.spec.schemeId] ?? {}),
          verifiedMapping: session.verifiedMapping,
        });
        await writeRunReview(runStore.dir, review);
      } catch {
        // 评审失败不阻断交付；网页路径会记录 reviewError，CLI 保留 run 证据供重算。
        review = null;
      }
    }
    return {
      outcome,
      runDir: runStore.dir,
      delivery: outcome.delivery,
      renders: listDeliveryRenders(runStore.dir),
      shadow: shadowSummaryOf(finalShadow),
      review,
    };
  } finally {
    store?.close();
    await renderer?.close();
    await prechecker?.close();
  }
}
