/* eslint-disable max-lines -- 设计→构建入口的 artifacts、live 装配与影子接线同属一个交接点；拆分另立任务。 */
/**
 * `design:build`：把 `@pg/interaction` 确认后写出的设计 artifacts 交给现有构建 agent `runRun`。
 *
 * 负责：读 `design.md` / `build-task.md` / `build-spec.json` / `gates.json`，用 `extractTaskBody` 截取 fed，
 *   组装 `RunnerInput`（`initialDesign` + `designAuthority: 'fixed'` + 体素 variant），接真依赖
 *   （预检器 / bwrap 执行 / registry / 渲染 / run 目录 / git 快照）并跑一次构建；`--dry-run` 只装配与打印。
 * 不负责：重写 runner / 沙箱 / 渲染 / 分析，生成或修改设计报告（只读 artifacts），草模 host（首版不接）。
 *
 * `--dry-run` 不读环境、不创建 client、不发请求；`--live` 必须显式 `PG_LIVE_CONFIRM=1`。
 * 退出码：交付 0；未交付 / 运行失败 1；参数 / 配置 / 确认 / 读文件错误 2。
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gatesSchema } from '@pg/agent/gates';
import type { GateConfig } from '@pg/agent/gates';
import type { RunOutcome, RunnerDeps, RunnerInput } from '@pg/agent/runner';
import { FIRST_REQUEST_HARD_CAP_TOKENS, runRun } from '@pg/agent/runner';
import { extractTaskBody } from '@pg/agent/task-body';
import type { DiffReport } from '@pg/analysis/object-diff';
import { loadRegistry } from '@pg/blocks/load';
import { ConfigError, loadConfigFromProcess } from '@pg/config';
import type { Config, PromptVersion } from '@pg/config';
import { planVerifiedObjectMap } from '@pg/interaction/must-links';
import { BuildSpec, buildMustLedger, DesignScheme, RequirementGraph } from '@pg/interaction/schema';
import {
  assertSessionId,
  DEFAULT_SESSION_ROOT,
  SessionStoreError,
  sessionDir as resolveSessionDir,
} from '@pg/interaction/store';
import type { ChatClient } from '@pg/llm/client';
import { createClient } from '@pg/llm/client';
import { createRenderer } from '@pg/render/render';
import type { Renderer } from '@pg/render/render';
import { createPrechecker } from '@pg/sandbox/precheck';
import type { Prechecker } from '@pg/sandbox/precheck';
import { runCode } from '@pg/sandbox/run';
import type { RunLimits } from '@pg/store/events';
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
import type { BuildSheet } from './build-sheet.ts';
import {
  buildBuildSheet,
  buildVerifiedMustMapping,
  writeBuildSheetArtifacts,
  writeVerifiedMustMapArtifact,
} from './build-sheet.ts';
import { formatConformanceDeliveryNote } from './conformance-note.ts';
import { computeShadowForArchive, computeShadowForRun, shadowSummaryLine } from './conformance-shadow.ts';
import type { ShadowConformanceResult, ShadowDatumInput, VerifiedMustMapping } from './conformance-shadow.ts';
import { projectExpectedFurniture } from './coverage-evidence.ts';
import { buildDesignDigest } from './design-digest.ts';
import { gitSnapshot, realClock, realSleep } from './model-agent-deps.ts';
import { assertLiveModel, tightenCost } from './model-agent-live.ts';
import { buildRunReview, writeRunReview } from './run-review.ts';
import { adoptRunReviewIntoSession } from './session-review.ts';
import { loadTokenCounter } from './tokens.ts';

/** 设计 → 构建交接的 system 提示变体；小体量与室内做法段与设计报告的范围一致。 */
export const DESIGN_BUILD_VARIANT = 'craft-small' as const;

export interface DesignBuildIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** 影子自证的可序列化摘要；只用于日志 / 页面展示，不参与 outcome / exit。 */
export interface ShadowRunSummary {
  readonly summary: string;
  readonly diffPath: string | null;
  readonly evidencePath: string | null;
  readonly error: string | null;
}

/** BuildSheet 的统一 FloorDatum 四字段；不携带旧 floorY 别名。 */
export function shadowDatumOf(session: Pick<DesignSession, 'buildSheet'>): ShadowDatumInput {
  const { slabTopY, standingY, gradeY, entryTransition } = session.buildSheet.datum;
  return { slabTopY, standingY, gradeY, entryTransition };
}

export function shadowSummaryOf(result: ShadowConformanceResult | null): ShadowRunSummary {
  if (result === null) {
    return {
      summary: '构建自证（影子，仅报告）：未执行（没有成功 check 或交付）',
      diffPath: null,
      evidencePath: null,
      error: null,
    };
  }
  return {
    summary: shadowSummaryLine(result),
    diffPath: result.diffPath,
    evidencePath: result.evidencePath,
    error: result.error,
  };
}

/** live check / 交付注记共享的影子入口；`current()` 返回最近一次成功 check 或交付的 canonical 报告。 */
export interface CheckShadowHooks {
  readonly conformanceReportOf: (archive: Uint8Array) => DiffReport | undefined;
  readonly onCheckArchive: (archive: Uint8Array) => void;
  readonly current: () => ShadowConformanceResult | null;
}

/**
 * 把生产 shadow 接到 `CheckDeps`：check_code 用本次存档拿到与 review 同源的 canonical 报告，
 * 而不是退回 expectedObjects 的对象图摘要。同一份存档字节只计算一次；任何失败都返回 / 保留 null，
 * 让 check_code 回退且不改变 submit / gates。
 */
export function checkShadowHooks(
  session: Pick<DesignSession, 'specPath' | 'verifiedMapping' | 'buildSheet'>,
  outDir: string,
): CheckShadowHooks {
  let last: ShadowConformanceResult | null = null;
  let lastArchive: Uint8Array | null = null;
  const resolve = (archive: Uint8Array): ShadowConformanceResult | null => {
    if (lastArchive === archive) return last;
    lastArchive = archive;
    try {
      last = computeShadowForArchive({
        specPath: session.specPath,
        archive,
        outDir,
        datum: shadowDatumOf(session),
        verifiedMapping: session.verifiedMapping,
      });
    } catch {
      last = null;
    }
    return last;
  };
  return {
    conformanceReportOf: (archive) => {
      const report = resolve(archive)?.report;
      // ConformanceDiffReport 是 DiffReport 的生产超集；check_code 只读共享字段。
      return report === null || report === undefined ? undefined : (report as unknown as DiffReport);
    },
    onCheckArchive: (archive) => {
      resolve(archive);
    },
    current: () => last,
  };
}

/** 测试注入点：live 配置 / client / runner 与运行时时钟；缺省全部走真实实现。 */
export interface DesignBuildDeps {
  readonly io?: DesignBuildIo;
  /** 缺省 `loadConfigFromProcess`；只有 `--live` 会调用。 */
  readonly loadConfig?: () => Config;
  /** 只有 `--live` 且确认 / 模型校验通过后才会调用。 */
  readonly createLiveClient?: (config: Config) => ChatClient;
  /** 已创建的 client（测试 / 复用调用方）；给了就不再调用 `createLiveClient`。 */
  readonly client?: ChatClient;
  readonly runRun?: (input: RunnerInput, deps: RunnerDeps) => Promise<RunOutcome>;
  readonly clock?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly countTokens?: (text: string) => number;
  readonly now?: () => Date;
  readonly chromePath?: string;
}

/** 参数 / 确认 / artifacts 读取错误的专用类型：入口统一映射为退出码 2。 */
export class DesignBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignBuildError';
  }
}

export const DESIGN_BUILD_USAGE = `用法：node tools/design-build.ts (--session <id> [--out <dir>] | --session-dir <path>) (--dry-run | --live) [选项]
  读取设计会话产物 design.md / build-task.md / build-spec.json / gates.json，交给构建 agent 施工。
  --dry-run           只装配并打印摘要；不读配置、不创建 client、不发请求
  --live              真实构建运行；需 PG_LIVE_CONFIRM=1，会调用真实模型
  --session <id>      会话 id，只允许 [a-z0-9][a-z0-9_-]{0,63}
  --out <dir>         会话根目录（默认 ${DEFAULT_SESSION_ROOT}；仅与 --session 一起用）
  --session-dir <path> 直接指定会话目录（与 --session / --out 互斥）
  --seed <int>        沙箱 rng 种子，0–4294967295（默认 0）
  --max-cny <num>     单次 run 花费上限，0 < x ≤ ${String(MAX_RUN_CNY)}（默认 ${String(MAX_RUN_CNY)}）
  --max-turns <int>   轮数上限 4–200（默认不限）
  --wall-ms <int>     墙钟上限，≥ 60000（默认 ${String(DEFAULT_WALL_MS)}）
  --help, -h          打印本说明

  交接约定：BuildSheet 是机器真相，design.md 是散文；build-task.md 是施工指令；designAuthority 固定为 fixed。
  退出码：交付 0；未交付 / 运行失败 1；参数 / 配置 / 确认 / 读文件错误 2。`;

export interface DesignBuildOptions {
  readonly sessionDir: string;
  readonly mode: 'dry-run' | 'live';
  readonly seed: number;
  readonly maxCny: number;
  readonly maxTurns: number | null;
  readonly wallMs: number;
  readonly submitWindow: number;
}

function value(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next === '' || next.startsWith('--')) {
    throw new DesignBuildError(`${flag} 缺少取值。\n${DESIGN_BUILD_USAGE}`);
  }
  return next;
}

function parseInteger(raw: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw))
    throw new DesignBuildError(`${flag} 应为 ${String(min)}–${String(max)} 的整数，实际是 ${raw}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new DesignBuildError(`${flag} 应为 ${String(min)}–${String(max)} 的整数，实际是 ${raw}`);
  }
  return n;
}

function parseMaxCny(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_RUN_CNY) {
    throw new DesignBuildError(
      `--max-cny 应为 0 到 ${String(MAX_RUN_CNY)} 之间的数（AGENT-SPEC §11 的单次上限），实际是 ${raw}`,
    );
  }
  return n;
}

/** 解析 argv（不含 node 与脚本路径）。`--dry-run` / `--live` 必须二选一。 */
export function parseDesignBuildArgs(argv: readonly string[]): DesignBuildOptions {
  let session: string | null = null;
  let sessionDir: string | null = null;
  let outDir = DEFAULT_SESSION_ROOT;
  let outProvided = false;
  let mode: DesignBuildOptions['mode'] | null = null;
  let seed = 0;
  let maxCny = MAX_RUN_CNY;
  let maxTurns: number | null = DEFAULT_MAX_TURNS;
  let wallMs = DEFAULT_WALL_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    switch (arg) {
      case '--session':
        session = value(argv, index, '--session');
        index += 1;
        break;
      case '--out':
        outDir = value(argv, index, '--out');
        outProvided = true;
        index += 1;
        break;
      case '--session-dir':
        sessionDir = value(argv, index, '--session-dir');
        index += 1;
        break;
      case '--dry-run':
        if (mode !== null) throw new DesignBuildError('--dry-run 与 --live 只能选一个。');
        mode = 'dry-run';
        break;
      case '--live':
        if (mode !== null) throw new DesignBuildError('--dry-run 与 --live 只能选一个。');
        mode = 'live';
        break;
      case '--seed':
        seed = parseInteger(value(argv, index, '--seed'), '--seed', 0, 2 ** 32 - 1);
        index += 1;
        break;
      case '--max-cny':
        maxCny = parseMaxCny(value(argv, index, '--max-cny'));
        index += 1;
        break;
      case '--max-turns':
        maxTurns = parseInteger(value(argv, index, '--max-turns'), '--max-turns', 4, 200);
        index += 1;
        break;
      case '--wall-ms':
        wallMs = parseInteger(value(argv, index, '--wall-ms'), '--wall-ms', 60_000, 2 ** 31 - 1);
        index += 1;
        break;
      default:
        throw new DesignBuildError(`不认识的参数 ${JSON.stringify(arg)}。\n${DESIGN_BUILD_USAGE}`);
    }
  }

  if (mode === null) throw new DesignBuildError(`必须指定 --dry-run 或 --live。\n${DESIGN_BUILD_USAGE}`);
  if (sessionDir !== null && session !== null) {
    throw new DesignBuildError('--session 与 --session-dir 互斥，只能给一个。');
  }
  if (sessionDir !== null && outProvided)
    throw new DesignBuildError('--out 只与 --session 一起用，不能和 --session-dir 同时给。');
  if (sessionDir === null && session === null) {
    throw new DesignBuildError(`必须给 --session <id> 或 --session-dir <path>。\n${DESIGN_BUILD_USAGE}`);
  }

  let dir: string;
  if (sessionDir !== null) {
    dir = sessionDir;
  } else {
    try {
      dir = resolveSessionDir(assertSessionId(session ?? ''), { root: outDir });
    } catch (error) {
      if (error instanceof SessionStoreError) throw new DesignBuildError(error.message);
      throw error;
    }
  }
  return {
    sessionDir: dir,
    mode,
    seed,
    maxCny,
    maxTurns,
    wallMs,
    submitWindow: DEFAULT_SUBMIT_WINDOW,
  };
}

/** 一次会话目录里构建层需要的只读产物；BuildSheet 由已校验的 BuildSpec 纯派生。 */
export interface DesignSession {
  readonly dir: string;
  readonly designPath: string;
  readonly design: string;
  readonly taskPath: string;
  readonly taskRaw: string;
  readonly taskFed: string;
  readonly specPath: string;
  readonly spec: BuildSpec;
  readonly buildSheet: BuildSheet;
  /** 由当前 session state 的 requirements + confirmed scheme 重新运行 planner 得到的映射。 */
  readonly verifiedMapping: VerifiedMustMapping;
  /** 固定 artifact 路径，仅供 dry-run 展示；运行时直接用 verifiedMapping。 */
  readonly mappingPath: string;
  readonly gatesPath: string;
  readonly gates: GateConfig;
}

function readText(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new DesignBuildError(
      `读取 ${label} 失败：${path}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

function parseJson(path: string, label: string): unknown {
  const text = readText(path, label);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DesignBuildError(`${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path)) throw new DesignBuildError(`${label} 不存在：${path}`);
}

/**
 * 从会话状态重新运行确定性 linker；这是 verified mapping 的信任根。
 * 没有 session.json / requirements / confirmed scheme 时返回空映射（fail closed）。
 */
function trustedVerifiedObjects(dir: string, spec: BuildSpec): Readonly<Record<string, readonly string[]>> {
  try {
    const raw = JSON.parse(readText(join(dir, 'session.json'), 'session.json')) as Record<string, unknown>;
    const requirements = RequirementGraph.safeParse(raw['requirements']);
    const designsRaw = raw['designs'];
    if (!requirements.success || !Array.isArray(designsRaw)) return {};
    const designs: unknown[] = designsRaw;
    const confirmed = raw['confirmedDesignRevision'];
    const targetRevision = typeof confirmed === 'number' ? confirmed : spec.schemeRevision;
    const schemeRaw =
      designs.find(
        (design) =>
          typeof design === 'object' &&
          design !== null &&
          (design as { meta?: { revision?: unknown } }).meta?.revision === targetRevision,
      ) ?? designs.at(-1);
    const scheme = DesignScheme.safeParse(schemeRaw);
    if (
      !scheme.success ||
      scheme.data.meta.status !== 'confirmed' ||
      scheme.data.meta.id !== spec.schemeId ||
      scheme.data.meta.revision !== spec.schemeRevision
    ) {
      return {};
    }
    return planVerifiedObjectMap(buildMustLedger(requirements.data).entries, scheme.data);
  } catch {
    return {};
  }
}

/** 读取并校验四个必需 artifacts；缺文件、非法 gates、无法截取题面都抛 {@link DesignBuildError}。 */
export function readDesignSession(dir: string): DesignSession {
  const designPath = join(dir, 'design.md');
  const taskPath = join(dir, 'build-task.md');
  const specPath = join(dir, 'build-spec.json');
  const gatesPath = join(dir, 'gates.json');
  requireFile(designPath, 'design.md');
  requireFile(taskPath, 'build-task.md');
  requireFile(specPath, 'build-spec.json');
  requireFile(gatesPath, 'gates.json');

  const design = readText(designPath, 'design.md');
  const taskRaw = readText(taskPath, 'build-task.md');
  if (design.trim() === '') throw new DesignBuildError(`design.md 为空：${designPath}`);
  if (taskRaw.trim() === '') throw new DesignBuildError(`build-task.md 为空：${taskPath}`);

  const parsedSpec = BuildSpec.safeParse(parseJson(specPath, 'build-spec.json'));
  if (!parsedSpec.success) {
    const issues = parsedSpec.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(根)'}：${issue.message}`)
      .join('；');
    throw new DesignBuildError(`build-spec.json 不合 BuildSpec：${issues}`);
  }
  const spec = parsedSpec.data;
  const trusted = trustedVerifiedObjects(dir, spec);
  const buildSheet = buildBuildSheet(spec, trusted);
  // 不读旧 verified-must-map.json：verified 只能由当前 session state 的确定性 planner 重算。
  const verifiedMapping = buildVerifiedMustMapping(spec, trusted);
  const mappingPath = join(dir, 'verified-must-map.json');
  const parsedGates = gatesSchema.safeParse(parseJson(gatesPath, 'gates.json'));
  if (!parsedGates.success) {
    const issues = parsedGates.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(根)'}：${issue.message}`)
      .join('；');
    throw new DesignBuildError(`gates.json 不合 gatesSchema：${issues}`);
  }

  let taskFed: string;
  try {
    taskFed = extractTaskBody(taskRaw).text;
  } catch (error) {
    throw new DesignBuildError(
      `build-task.md 无法截取一至四节：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    dir,
    designPath,
    design,
    taskPath,
    taskRaw,
    taskFed,
    specPath,
    spec,
    buildSheet,
    verifiedMapping,
    mappingPath,
    gatesPath,
    gates: parsedGates.data,
  };
}

/** 入口写 BuildSheet + verified-must-map artifacts；失败映射为退出码 2 的 {@link DesignBuildError}。 */
export function writeSessionBuildSheet(session: Pick<DesignSession, 'dir' | 'buildSheet' | 'verifiedMapping'>): void {
  try {
    writeBuildSheetArtifacts(session.dir, session.buildSheet);
    writeVerifiedMustMapArtifact(session.dir, session.verifiedMapping);
  } catch (error) {
    throw new DesignBuildError(
      `写构建 artifacts 失败：${session.dir}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

/**
 * 构建入口的 live config：比 `RunnerInput.config` 多一个 `promptVersion`。
 * `run.start` 的 config 是 strict schema（只认 baseUrl / timeoutMs），所以版本只作为
 * `RunnerInput` 的扩展字段传给体素适配层，不写进事件里的 config。
 */
export interface DesignRunnerConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly promptVersion?: PromptVersion;
}

export interface DesignRunnerAssembly {
  readonly seed: number;
  readonly limits: RunLimits;
  readonly config: DesignRunnerConfig | null;
}

/** design:build 的 RunnerInput 扩展：W11-06a 把 `PG_PROMPT_VERSION` 接到体素 system。 */
export type DesignRunnerInput = RunnerInput & { readonly promptVersion?: PromptVersion };

/** 拆出 `run.start` 允许的 config 字段；promptVersion 单独挂到输入扩展上。 */
function runnerConfigOf(config: DesignRunnerConfig | null): Pick<DesignRunnerInput, 'config' | 'promptVersion'> {
  if (config === null) return { config: null };
  const { baseUrl, timeoutMs, promptVersion } = config;
  return {
    config: { baseUrl, timeoutMs },
    ...(promptVersion === undefined ? {} : { promptVersion }),
  };
}

/** 官方 tokenizer 惰性加载：dry-run 和 v1 不触发；首次真正检查 v2 首请求时才读本地资产。 */
const officialCounter: { value?: ReturnType<typeof loadTokenCounter> } = {};
function officialTokenCount(text: string): number {
  officialCounter.value ??= loadTokenCounter();
  return officialCounter.value.count(text);
}

/**
 * 组装构建层 RunnerInput：build-task 原文 + fed、设计权威固定。
 * v1 保留完整 design.md（回滚路径逐字不变）；v2 fixed 只传确定性 digest，完整意图仍可从 design.md 回读。
 * v2 同时注入 20k 首请求硬上限；计数走官方 tokenizer，runner 在写 run.start 前拒绝超限。
 */
export function designRunnerInput(session: DesignSession, assembly: DesignRunnerAssembly): DesignRunnerInput {
  const promptVersion = assembly.config?.promptVersion ?? 'v1';
  const digest = promptVersion === 'v2';
  // v2 首请求已带 BuildSheet 的 must 全文，digest 只引用，避免同一合同重复约 1.2k token。
  const initialDesign = digest
    ? buildDesignDigest(session.design, session.spec, { musts: 'reference' })
    : session.design;
  return {
    task: { raw: session.taskRaw, fed: session.taskFed, source: session.taskPath },
    seed: assembly.seed,
    limits: assembly.limits,
    mode: 'live',
    variant: DESIGN_BUILD_VARIANT,
    initialDesign,
    initialDesignKind: digest ? 'digest' : 'full',
    initialBuildSheet: session.buildSheet.markdown,
    designAuthority: 'fixed',
    ...(digest
      ? { firstRequestBudget: { maxTokens: FIRST_REQUEST_HARD_CAP_TOKENS, countTokens: officialTokenCount } }
      : {}),
    ...runnerConfigOf(assembly.config),
  };
}

/** CLI 参数 → RunLimits；环境变量只能通过 live runtime 再收紧。 */
export function designRunLimits(options: DesignBuildOptions): RunLimits {
  return {
    maxCostCny: options.maxCny,
    maxTurns: options.maxTurns,
    wallMs: options.wallMs,
    submitWindow: options.submitWindow,
  };
}

/** live 运行时：配置 / client / 最终 limits；供 `design-build-runner.ts` 复用。 */
export interface LiveRuntime {
  readonly client: ChatClient;
  readonly config: DesignRunnerConfig & { readonly promptVersion: PromptVersion };
  readonly limits: RunLimits;
}

function makeLiveClient(config: Config): ChatClient {
  return createClient({
    config: {
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      timeoutMs: config.llm.timeoutMs,
    },
    fetch: globalThis.fetch,
    sleep: realSleep,
    clock: realClock,
  });
}

/** 只在 `--live` 调用：先确认、再校验模型、最后才创建 client。 */
export function resolveLiveRuntime(options: DesignBuildOptions, deps: DesignBuildDeps): LiveRuntime {
  let config: Config;
  try {
    config = (deps.loadConfig ?? loadConfigFromProcess)();
  } catch (error) {
    throw new DesignBuildError(
      error instanceof ConfigError
        ? error.message
        : `读取配置失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!config.liveConfirm) {
    throw new DesignBuildError('拒绝真实构建运行：需要环境变量 PG_LIVE_CONFIRM=1 作为第二道确认。');
  }
  try {
    assertLiveModel(config.llm.model);
  } catch (error) {
    throw new DesignBuildError(error instanceof Error ? error.message : String(error));
  }

  let client: ChatClient;
  try {
    client = deps.client ?? (deps.createLiveClient ?? makeLiveClient)(config);
  } catch (error) {
    throw new DesignBuildError(`创建 live client 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const limits = tightenCost(designRunLimits(options), config.maxRunCostCny > 0 ? config.maxRunCostCny : undefined);
  return {
    client,
    config: {
      baseUrl: config.llm.baseUrl,
      timeoutMs: config.llm.timeoutMs,
      promptVersion: config.promptVersion ?? 'v1',
    },
    limits,
  };
}

function report(outcome: RunOutcome, io: DesignBuildIo, shadow: ShadowRunSummary): number {
  io.stdout('设计 → 构建交接（真实模型调用；单次 run，需 owner 明确授权；真实账单以供应商为准）');
  io.stdout(`run 目录: ${outcome.dir}`);
  io.stdout(`停止原因: ${outcome.stopReason ?? 'submitted（已交付）'}`);
  io.stdout(outcome.costCny === null ? '特许测试：未计费' : `花费: ¥${outcome.costCny.toFixed(4)}`);
  io.stdout(`轮数: ${String(outcome.turns)}`);
  if (outcome.delivery !== null) {
    io.stdout(`交付: 第 v${String(outcome.delivery.codeVersion)} 版，存档 hash ${outcome.delivery.hash}`);
  }
  io.stdout(shadow.summary);
  return outcome.delivery === null ? 1 : 0;
}

/** 真实构建：真预检 + 真 bwrap 执行 + registry / 渲染 / run 目录 / git 快照；不接草模 host。 */
async function runLive(
  options: DesignBuildOptions,
  session: DesignSession,
  runId: string,
  runtime: LiveRuntime,
  deps: DesignBuildDeps,
  io: DesignBuildIo,
): Promise<number> {
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
    const runStore = createRunDir(DEFAULT_OUT_DIR, runId);
    store = runStore;
    const shadowHooks = checkShadowHooks(session, runStore.dir);
    const versions = voxelExternalVersions(runStore, readyPrechecker.version, git, worldDts);
    const runnerDeps: RunnerDeps = {
      client: runtime.client,
      store: runStore,
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
      seed: options.seed,
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
      try {
        const review = await buildRunReview({
          spec: session.spec,
          specPath: session.specPath,
          runDir: runStore.dir,
          verifiedMustObjects: session.verifiedMapping.schemes[session.spec.schemeId] ?? {},
          verifiedMustIds: Object.keys(session.verifiedMapping.schemes[session.spec.schemeId] ?? {}),
          verifiedMapping: session.verifiedMapping,
        });
        await writeRunReview(runStore.dir, review);
        // CLI 绕过网页状态机；仍把新 run / 新评审落到同一 session，旧 review 进 stale 历史。
        const adopted = await adoptRunReviewIntoSession(session.dir, review);
        if (!adopted) {
          io.stderr(
            `会话评审未落盘（run review.json 已写）：${session.dir}；可能是 session.json 缺失 / 阶段或 revision 不兼容。`,
          );
        }
      } catch (error) {
        io.stderr(`评审落盘失败（run 证据仍保留）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return report(outcome, io, shadowSummaryOf(finalShadow));
  } catch (error) {
    io.stderr(`构建运行失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    if (store !== undefined) io.stderr(`run 目录: ${store.dir}`);
    return 1;
  } finally {
    // runner 正常结束时已 close；这里再 close 一次是幂等的，只兜住 runner 之前的失败。
    store?.close();
    await renderer?.close();
    await prechecker?.close();
  }
}

function printDryRun(io: DesignBuildIo, session: DesignSession, input: RunnerInput, runId: string): void {
  io.stdout('设计 → 构建交接（dry-run：只装配；不读配置、不创建 client、不发请求）');
  io.stdout(`session 目录: ${session.dir}`);
  io.stdout(`design.md: ${session.designPath}（${String(session.design.length)} 字符）`);
  io.stdout(
    `build-task.md: ${session.taskPath}（原文 ${String(session.taskRaw.length)} 字符；fed ${String(session.taskFed.length)} 字符）`,
  );
  io.stdout(`build-spec.json: ${session.specPath}`);
  io.stdout(`gates: ${JSON.stringify(session.gates)}`);
  io.stdout(`variant: ${DESIGN_BUILD_VARIANT}`);
  io.stdout(`designAuthority: ${input.designAuthority ?? 'free'}`);
  io.stdout(
    `buildSheet objects: ${String(session.buildSheet.objects.length)} [${session.buildSheet.objects.map((object) => object.id).join(', ')}]`,
  );
  io.stdout(
    `buildSheet callCards: ${String(session.buildSheet.callCards.length)} [${session.buildSheet.callCards.map((card) => card.id).join(', ')}]`,
  );
  io.stdout(
    `buildSheet musts: ${String(session.buildSheet.musts.length)} [${session.buildSheet.musts.map((must) => must.id).join(', ')}]`,
  );
  io.stdout(`buildSheet datum: ${session.buildSheet.datum.summary}`);
  io.stdout(
    `buildSheet conflicts: ${String(session.buildSheet.conflicts.length)} [${session.buildSheet.conflicts.map((conflict) => conflict.id).join(', ')}]`,
  );
  io.stdout(`build-sheet.json: ${join(session.dir, 'build-sheet.json')}`);
  io.stdout(`build-sheet.md: ${join(session.dir, 'build-sheet.md')}`);
  const verifiedSchemes = Object.keys(session.verifiedMapping.schemes);
  const verifiedMusts = verifiedSchemes.reduce(
    (total, schemeId) => total + Object.keys(session.verifiedMapping.schemes[schemeId] ?? {}).length,
    0,
  );
  const schemeSuffix = verifiedSchemes.length === 0 ? '' : ` [${verifiedSchemes.join(', ')}]`;
  io.stdout(
    `verified mapping: ${String(verifiedSchemes.length)} scheme(s), ${String(verifiedMusts)} must(s)${schemeSuffix}`,
  );
  io.stdout(`verified-must-map.json: ${session.mappingPath}`);
  io.stdout(`runId: ${runId}`);
  io.stdout(`limits: ${JSON.stringify(input.limits)}`);
  io.stdout(`seed: ${String(input.seed)}`);
}

/** 执行一次入口；参数 / 配置 / 确认 / 读文件错误返回 2，运行失败返回 1，交付 0。 */
export async function runDesignBuild(argv: readonly string[], deps: DesignBuildDeps = {}): Promise<number> {
  const io = deps.io ?? {
    stdout: (line: string) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(DESIGN_BUILD_USAGE);
    return 0;
  }

  let options: DesignBuildOptions;
  try {
    options = parseDesignBuildArgs(argv);
  } catch (error) {
    if (error instanceof DesignBuildError) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }

  let session: DesignSession;
  try {
    session = readDesignSession(options.sessionDir);
    writeSessionBuildSheet(session);
  } catch (error) {
    if (error instanceof DesignBuildError) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }

  const runId = massingRunId(session.taskPath, (deps.now ?? (() => new Date()))());
  if (options.mode === 'dry-run') {
    const input = designRunnerInput(session, {
      seed: options.seed,
      limits: designRunLimits(options),
      config: null,
    });
    printDryRun(io, session, input, runId);
    return 0;
  }

  let runtime: LiveRuntime;
  try {
    runtime = resolveLiveRuntime(options, deps);
  } catch (error) {
    if (error instanceof DesignBuildError) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }
  return await runLive(options, session, runId, runtime, deps, io);
}

/** 直接执行入口：不把未预期异常变成裸栈输出。 */
export async function main(argv: readonly string[], deps: DesignBuildDeps = {}): Promise<number> {
  try {
    return await runDesignBuild(argv, deps);
  } catch (error) {
    const io = deps.io;
    const message = `运行失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    if (io === undefined) process.stderr.write(`${message}\n`);
    else io.stderr(message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
