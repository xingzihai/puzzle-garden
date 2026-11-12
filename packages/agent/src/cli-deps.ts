/**
 * CLI 的真实依赖组装（AGENT-SPEC §9、§11）：读题目、算 runId 与组件版本、按模型来源造 client 与 deps。
 *
 * 负责：文件 I/O（题目 / 剧本 / 回放目录）、run.start 所需的 ExternalVersions、三种模型来源的 client
 *   （mock 剧本 fetch / strict 回放 fetch / live 真 fetch + loadConfig），以及 `--live` 的第二道确认。
 * 不负责：参数解析（cli-args.ts）、主循环（runner.ts）、打印与退出码（cli.ts）。
 * @pg/llm 的回放只接受最小结构类型 `ReplaySource`，openRunDir 的 RunReader 直接满足它。
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFromProcess } from '@pg/config';
import { API_VERSION } from '@pg/geometry';
import { createClient } from '@pg/llm/client';
import { createReplayFetch, createScriptedFetch, createVirtualTime, ScriptSchema } from '@pg/llm/mock';
import type { Script } from '@pg/llm/mock';
import type { ChatClient } from '@pg/llm/client';
import type { Prechecker } from '@pg/sandbox/precheck';
import { MAX_CODE_BYTES, sandboxVersion } from '@pg/sandbox/run';
import type { Versions } from '@pg/store/events';
import { openRunDir } from '@pg/store/run-dir';

import { tightenLimits } from './cli-args.ts';
import type { CliOptions } from './cli-args.ts';
import { gatesSchema } from './gates.ts';
import type { GateConfig } from './gates.ts';
import type { ExternalVersions, RunnerInput } from './runner.ts';
import { assertTaskPath, extractTaskBody } from './task-body.ts';
import { MAX_DESIGN_CHARS } from './tools/schemas.ts';

/** `--live` 但没设 `PG_LIVE_CONFIRM=1`：入口用退出码 2（AGENT-SPEC §11）。 */
export class CliConfirmError extends Error {
  constructor() {
    super('拒绝真实模型调用：请设置环境变量 PG_LIVE_CONFIRM=1 作为第二道确认（AGENT-SPEC §11）。');
    this.name = 'CliConfirmError';
  }
}

const encoder = new TextEncoder();
const MOCK_BASE_URL = 'https://mock.invalid';

/** 读题面：先拒绝 /sealed/，再截取喂入正文（AGENT-SPEC §2.1）。 */
export function readTask(taskPath: string): RunnerInput['task'] {
  assertTaskPath(taskPath);
  const raw = readFileSync(taskPath, 'utf8');
  return { raw, fed: extractTaskBody(raw).text, source: taskPath };
}

/** `@pg/geometry/world.d.ts` 全文。 */
export function loadWorldDts(): string {
  return readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');
}

/**
 * 读种子稿（`--seed-code`）：当前稿第 1 版的内容。空文件 / 全空白或超过代码字节上限都报错，
 * 错误信息写清路径、实际字节与合法范围（STANDARDS §4：不静默回退）。
 */
export function readSeedCode(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`${path} 读不到（${error instanceof Error ? error.message : String(error)}）。`, { cause: error });
  }
  if (bytes.length > MAX_CODE_BYTES) {
    throw new Error(`种子稿 ${path} 有 ${String(bytes.length)} 字节，超过代码上限 ${String(MAX_CODE_BYTES)} 字节。`);
  }
  const code = bytes.toString('utf8');
  if (code.trim() === '') {
    throw new Error(`种子稿 ${path} 是空文件或全空白：第 1 版必须有内容，不能作为当前稿。`);
  }
  return code;
}

/**
 * 读上一阶段的骨架设计文档（`--seed-design`，两层实验第 2 层）：
 * 去掉首尾空行后不能为空、字符数 ≤ {@link MAX_DESIGN_CHARS}，否则报错（STANDARDS §4：不静默回退）。
 */
export function readSeedDesign(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`种子设计文档 ${path} 读不到（${error instanceof Error ? error.message : String(error)}）。`, {
      cause: error,
    });
  }
  const design = text.trim();
  if (design === '') throw new Error(`种子设计文档 ${path} 是空文件或全空白：必须是一份设计文档。`);
  if (design.length > MAX_DESIGN_CHARS) {
    throw new Error(
      `种子设计文档 ${path} 有 ${String(design.length)} 字符，超过上限 ${String(MAX_DESIGN_CHARS)} 字符。`,
    );
  }
  return design;
}

/** 骨架渲染图固定读取顺序（两层实验第 2 层）；存在几个读几个。 */
const SEED_IMAGE_NAMES = ['iso-se.png', 'top.png', 'south.png', 'north.png'] as const;

/**
 * 读上一阶段的骨架渲染图（`--seed-images <dir>`）：按 {@link SEED_IMAGE_NAMES} 顺序读存在的图，
 * 一个都没有时报错（不会静默传空图给细化层）。
 */
export function readSeedImages(dir: string): { name: string; png: Uint8Array }[] {
  const images: { name: string; png: Uint8Array }[] = [];
  for (const name of SEED_IMAGE_NAMES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      images.push({ name, png: new Uint8Array(readFileSync(path)) });
    } catch (error) {
      throw new Error(`骨架渲染图 ${path} 读不到（${error instanceof Error ? error.message : String(error)}）。`, {
        cause: error,
      });
    }
  }
  if (images.length === 0) {
    throw new Error(
      `骨架渲染图目录 ${dir} 里没有 ${SEED_IMAGE_NAMES.join('、')} 中的任何一张，无法作为细化层的种子图。`,
    );
  }
  return images;
}

/**
 * 读骨架门槛配置（`--gates`，AGENT-SPEC §5.1）：UTF-8 → JSON.parse → gatesSchema.parse。
 * 读不到 / 非法 JSON / schema 不过都抛可读错误，写清文件路径与原因（STANDARDS §4：不静默回退）。
 */
export function readGates(path: string): GateConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`门槛配置 ${path} 读不到（${error instanceof Error ? error.message : String(error)}）。`, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`门槛配置 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const parsed = gatesSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`);
    throw new Error(`门槛配置 ${path} 不合 gatesSchema：${issues.join('；')}`);
  }
  return parsed.data;
}

/** 题目短名：取文件名、转小写 slug，跑不进 runId 就退回 adhoc（MODEL-SPEC §7.1）。 */
export function taskShortName(taskPath: string): string {
  const slug = basename(taskPath)
    .replace(/\.(md|markdown)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug === '' ? 'adhoc' : slug;
}

/** runId = `<UTC yyyyMMdd-HHmmss>-<题目短名>-<6 位十六进制>`（MODEL-SPEC §7.1）。 */
export function runIdFor(taskPath: string, date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
  return `${stamp}-${taskShortName(taskPath)}-${randomBytes(3).toString('hex')}`;
}

/**
 * 离线 token 计数的近似（AGENT-SPEC §3.1 的 `tokensOffline`）：UTF-8 字节数 ÷ 3 向上取整。
 * 只写进事件供人看，不参与预留与计费；精确计数（评分卡）在 tools/tokens.ts，agent 层不能 import tools。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / 3);
}

function gitInfo(): Versions['git'] {
  const run = (args: readonly string[]): string =>
    execFileSync('git', [...args], { encoding: 'utf8', cwd: repoRoot() }).trim();
  return { commit: run(['rev-parse', 'HEAD']), dirty: run(['status', '--porcelain']) !== '', diff: null };
}

/** 仓库根：本文件在 packages/agent/src/，上溯三层。 */
function repoRoot(): string {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

/** analysis 版本 = 非测试源文件按路径排序后（路径 + 内容）的 sha256（MODEL-SPEC §7.5）。 */
function analysisVersion(): string {
  const entry = fileURLToPath(import.meta.resolve('@pg/analysis/floating'));
  const dir = dirname(entry);
  const hash = createHash('sha256');
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()) {
    hash
      .update(name)
      .update('\u0000')
      .update(readFileSync(join(dir, name)));
  }
  return hash.digest('hex');
}

/** runner 需要、调用方提供的组件版本（AGENT-SPEC §9；tools / prompt / pricing 由 runner 自己算）。 */
export function computeVersions(prechecker: Prechecker): ExternalVersions {
  return {
    git: gitInfo(),
    node: process.version,
    worldApi: API_VERSION,
    worldDts: createHash('sha256').update(loadWorldDts()).digest('hex'),
    precheck: prechecker.version,
    sandbox: sandboxVersion(),
    // @pg/core/archive 的 FORMAT_VERSION（archive.ts:15），未导出，版本变化时同步这里。
    archiveFormat: 1,
    analysis: analysisVersion(),
  };
}

/** 三种模型来源造出的 client 与 RunInput 字段。 */
export interface ModelRuntime {
  readonly client: ChatClient;
  readonly mode: RunnerInput['mode'];
  readonly script?: { readonly name: string; readonly sha256: string };
  readonly replayOf?: string;
  /** 非 live 为 null（C16）。 */
  readonly config: { readonly baseUrl: string; readonly timeoutMs: number } | null;
  /** runner 的事实行与墙钟护栏用的时钟；与 client 共用一个时间源。 */
  readonly clock: () => number;
  /** live 时 `PG_MAX_RUN_COST_CNY`（> 0 才生效）；runner 的上限取它与 `--max-cny` 的较小值。 */
  readonly envMaxCny?: number;
  /** live 用真实 sleep（墙钟到点取消请求）；mock / replay 不需要。 */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * replay 时取原 run 的 `run.start.limits`：缺省值改过（如决策 #87 取消轮数上限）后，
   * 旧 run 仍用当时的上限拼 system 与事实行，请求体才能和原记录逐字节一致。
   */
  readonly limits?: RunnerInput['limits'];
}

/** 原 run 的 `run.start.limits`；找不到时报错（strict 回放无法进行）。 */
export function originalLimits(
  events: readonly { readonly type: string; readonly body: unknown }[],
): RunnerInput['limits'] {
  const start = events.find((e) => e.type === 'run.start');
  if (start === undefined) throw new Error('回放源没有 run.start 事件，无法取原 run 的 limits');
  return (start.body as { readonly limits: RunnerInput['limits'] }).limits;
}

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('This operation was aborted', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('This operation was aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function readScript(path: string): { script: Script; sha256: string } {
  const bytes = readFileSync(path);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`剧本 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const parsed = ScriptSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`);
    throw new Error(`剧本 ${path} 不合 ScriptSchema：${issues.join('；')}`);
  }
  return { script: parsed.data, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * 按 `opts.model` 造 client。`--live` 才调 loadConfig 并检查 PG_LIVE_CONFIRM（C16、AGENT-SPEC §11）；
 * mock / replay 用虚拟时间与注入 fetch，不读环境、不碰全局 fetch。
 */
export function buildModelSource(opts: CliOptions, seed: number): ModelRuntime {
  if (opts.model.kind === 'live') {
    const config = loadConfigFromProcess();
    if (!config.liveConfirm) throw new CliConfirmError();
    if (config.llm.model !== 'deepseek-flash') {
      throw new Error(`PG_LLM_MODEL=${config.llm.model} 不在价格表里，拒绝发起真实调用（MODEL-SPEC §3.5）。`);
    }
    const client = createClient({
      config: { baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey, timeoutMs: config.llm.timeoutMs },
      fetch: globalThis.fetch,
      sleep: realSleep,
      clock: () => Date.now(),
    });
    return {
      client,
      mode: 'live',
      config: { baseUrl: config.llm.baseUrl, timeoutMs: config.llm.timeoutMs },
      ...(config.maxRunCostCny > 0 ? { envMaxCny: config.maxRunCostCny } : {}),
      clock: () => Date.now(),
      sleep: realSleep,
    };
  }

  const vt = createVirtualTime();
  if (opts.model.kind === 'script') {
    const { script, sha256 } = readScript(opts.model.path);
    const client = createClient({
      config: { baseUrl: MOCK_BASE_URL, apiKey: 'mock', timeoutMs: 600_000 },
      fetch: createScriptedFetch(script, seed),
      sleep: vt.sleep,
      clock: vt.clock,
    });
    return { client, mode: 'script', script: { name: script.name, sha256 }, config: null, clock: vt.clock };
  }

  const source = openRunDir(opts.model.runDir);
  const client = createClient({
    config: { baseUrl: MOCK_BASE_URL, apiKey: 'mock', timeoutMs: 600_000 },
    fetch: createReplayFetch(source, seed, { sleep: vt.sleep }),
    sleep: vt.sleep,
    clock: vt.clock,
  });
  return {
    client,
    mode: 'replay',
    replayOf: opts.model.runDir,
    config: null,
    clock: vt.clock,
    limits: originalLimits(source.events()),
  };
}

/** 由 CliOptions 与模型来源组装 runner 的 RunInput（task 由 readTask 传入）。 */
export function buildRunnerInput(
  opts: CliOptions,
  task: RunnerInput['task'],
  model: ModelRuntime,
  initialDraftCode?: string,
  initialDesign?: string,
  initialImages?: RunnerInput['initialImages'],
): RunnerInput {
  return {
    task,
    seed: opts.seed,
    limits: model.limits ?? tightenLimits(opts.limits, model.envMaxCny),
    mode: model.mode,
    variant: opts.promptVariant,
    ...(opts.requireDesign ? { requireDesign: true } : {}),
    ...(initialDraftCode === undefined ? {} : { initialDraft: { code: initialDraftCode } }),
    ...(initialDesign === undefined ? {} : { initialDesign }),
    ...(initialImages === undefined ? {} : { initialImages }),
    ...(model.script === undefined ? {} : { script: model.script }),
    ...(model.replayOf === undefined ? {} : { replayOf: model.replayOf }),
    config: model.config,
  };
}
