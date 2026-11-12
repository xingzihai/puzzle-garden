/**
 * `@pg/sandbox/modeling` 的公开入口（MODELING-SPEC §4）：类型预检后经 bwrap 子进程执行建模代码，
 * 校验 child 输出并给出结构化结果。
 *
 * 负责：宿主侧进程管理、类型预检编排、JSON 报告解析、documentHash 复验、串行队列、超时 / abort 的
 * 进程组击毙、SandboxError 分类。
 * 不负责：预检本身（precheck.ts + MODEL_DECLARATION）、模型代码的隔离细节（modeling-child 与 bwrap）、
 * 网格生成（@pg/modeling）。
 *
 * 并发：`createModelRunner()` 的实例内部串行（同一 runner 同时只跑一个子进程）；`runModelCode` 是
 * 一次性便捷入口，每次新建并在结束时 close，多个 runModelCode 并发由调用方（agent）自行控制。
 * 不发起任何 LLM 调用。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MODEL_DECLARATION } from '@pg/modeling/declaration';
import type { ModelDocument } from '@pg/modeling/schema';

import { sandboxLaunch } from './args.ts';
import type { Launch, SandboxLayout, SandboxLimits } from './args.ts';
import { escapeControl } from './escape.ts';
import { SandboxError } from './errors.ts';
import {
  DEFAULT_MODEL_MAX_OUTPUT_BYTES,
  DEFAULT_MODEL_TIMEOUT_MS,
  MAX_MODEL_CODE_BYTES,
  MODEL_CHILD_PROTOCOL_VERSION,
  MODEL_CONSOLE_BYTES,
  MODEL_STDERR_BYTES,
  hashModelCode,
  hashModelDocument,
  modelChildReportSchema,
} from './modeling-protocol.ts';
import type { ModelChildInput, ModelChildReport } from './modeling-protocol.ts';
import { createPrechecker } from './precheck.ts';
import type { Prechecker, PrecheckOptions } from './precheck.ts';
import type { ConsoleEntry, Diagnostic } from './protocol.ts';
import { detectSandbox } from './run.ts';
import type { ChildProcessLike, SandboxSupport } from './run.ts';
import type { EntryText } from './rules.ts';

/**
 * 建模全局声明 shim：把 `@pg/modeling/schema` 导出的类型桥接成模型代码可见的全局名字。
 * 与 worker-core 的 world shim 同构（都 import 自虚拟的 './world.js'），只换名字。
 */
const MODEL_GLOBALS_TEXT = `import type * as M from './world.js';

declare global {
  type Model = M.Model;
  type Vec3 = M.Vec3;
  type Point2 = M.Point2;
  type PartRole = M.PartRole;
  const console: {
    log(...args: readonly unknown[]): void;
    warn(...args: readonly unknown[]): void;
    error(...args: readonly unknown[]): void;
  };
}
`;

/** 建模入口文案；错误信息里写成 `build(model: Model)` 而不是 World。 */
const MODEL_ENTRY: EntryText = {
  signature: 'export default function build(model: Model): void',
  paramLabel: 'Model',
};

/** 资源上限默认值；与体素 sandbox 一致（SANDBOX-SPEC §5.5）。 */
const DEFAULTS = { maxOldSpaceMiB: 3072, addressSpaceGiB: 8 } as const;

export interface ModelRunOptions {
  /** 确定性种子，传给 child 的 Math.random 替身；默认 1。 */
  readonly seed?: number;
  /** 墙钟上限（ms）；默认 5000（MODELING-SPEC §4）。 */
  readonly timeoutMs?: number;
  /** stdout JSON 字节上限；默认 16 MiB。 */
  readonly maxOutputBytes?: number;
  /** 中止信号：触发时击毙该子进程组并返回 aborted。 */
  readonly signal?: AbortSignal;
}

/** 可辨识的建模执行结果；失败一律带 `message`。 */
export type ModelExecution =
  | {
      readonly kind: 'ok';
      readonly document: ModelDocument;
      readonly codeHash: string;
      readonly documentHash: string;
      /** child 捕获的 console（已按字节上限截断），供 agent 展示。 */
      readonly console: readonly ConsoleEntry[];
      /** 被额度丢弃的 console 条数；0 表示没有截断。 */
      readonly consoleTruncated: number;
    }
  | {
      readonly kind: 'precheck-error';
      readonly message: string;
      readonly diagnostics: readonly Diagnostic[];
      readonly total: number;
    }
  | {
      readonly kind: 'build-error';
      readonly message: string;
      readonly name: string;
      readonly line: number;
      readonly column: number;
      readonly console: readonly ConsoleEntry[];
      readonly consoleTruncated: number;
    }
  | { readonly kind: 'timeout'; readonly message: string; readonly timeoutMs: number }
  | { readonly kind: 'out-of-memory'; readonly message: string }
  | { readonly kind: 'output-too-large'; readonly message: string; readonly bytes: number; readonly limit: number }
  | { readonly kind: 'crashed'; readonly message: string; readonly stderrHead: string }
  | { readonly kind: 'aborted'; readonly message: string }
  | { readonly kind: 'too-large'; readonly message: string; readonly bytes: number; readonly limit: number }
  | { readonly kind: 'unsupported'; readonly message: string };

export interface ModelRunner {
  readonly runCode: (code: string, options?: ModelRunOptions) => Promise<ModelExecution>;
  readonly close: () => Promise<void>;
}

/** 需要 `detached: true`（自有进程组）；与体素 run 的 SpawnFn 不同，单独定义。 */
export type ModelSpawnFn = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly stdio: 'pipe'; readonly detached: true },
) => ChildProcessLike;

export interface ModelRunnerDeps {
  readonly spawn: ModelSpawnFn;
  readonly detect: () => SandboxSupport;
  readonly precheck: () => Prechecker;
  readonly paths: SandboxLayout;
  readonly limits: SandboxLimits;
}

interface ResolvedOptions {
  readonly seed: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal | undefined;
}

interface RunnerState {
  support: SandboxSupport | undefined;
  prechecker: Prechecker | undefined;
}

const DECODER = new TextDecoder('utf-8', { fatal: true });

/** raceWithSignal 的中止哨兵；与任何 PrecheckResult 都不同。 */
const ABORTED: unique symbol = Symbol('modeling-aborted');

/**
 * 让一个 promise 可被 AbortSignal 中止。预检在独立线程里跑，signal 触发时这里立刻返回哨兵，
 * 调用方负责停掉线程（prechecker.close()），避免"中止后预检还在后台跑"。
 */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => {
      resolve(ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function resolveOptions(options: ModelRunOptions): ResolvedOptions {
  return {
    seed: options.seed ?? 1,
    timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MODEL_MAX_OUTPUT_BYTES,
    signal: options.signal,
  };
}

/** bwrap 自带 --die-with-parent；这里再击毙整个自有进程组，兜住 SIGKILL 传播不到的场景。 */
function killChild(child: ChildProcessLike): void {
  const pid = child.pid;
  if (typeof pid === 'number' && pid > 1) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 进程组不存在 / 没权限：下面退回杀直接子进程。
    }
  }
  // 直接子进程再杀一次：组击毙成功时这是幂等的，失败时兜底（bwrap --die-with-parent 带走命名空间）。
  child.kill('SIGKILL');
}

interface ExecuteResult {
  readonly exitCode: number | null;
  readonly stderrHead: string;
  readonly stdout: Uint8Array;
  readonly stdoutBytes: number;
  readonly timedOut: boolean;
  readonly overLimit: boolean;
  readonly aborted: boolean;
  readonly error: Error | undefined;
}

/** 启动一次子进程、写入 stdin 并读流；超时 / abort 用进程组 SIGKILL，输出超限立即 kill。 */
function execute(
  deps: ModelRunnerDeps,
  launch: Launch,
  options: ResolvedOptions,
  stdin: Uint8Array,
): Promise<ExecuteResult> {
  return new Promise<ExecuteResult>((resolve) => {
    let child: ChildProcessLike;
    try {
      child = deps.spawn(launch.command, launch.args, { cwd: deps.paths.repoRoot, stdio: 'pipe', detached: true });
    } catch (error) {
      resolve({
        exitCode: null,
        stderrHead: '',
        stdout: new Uint8Array(0),
        stdoutBytes: 0,
        timedOut: false,
        overLimit: false,
        aborted: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    // 子进程可能在读完 stdin 前退出（EPIPE）；写失败不单独成结果，由 close / 退出码分类。
    child.stdin?.on('error', (): void => {
      // 同体素 run：吞掉写失败，结果由 close 事件与退出码分类。
    });
    child.stdin?.end(Buffer.from(stdin));
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrHead = '';
    let timedOut = false;
    let overLimit = false;
    let aborted = options.signal?.aborted ?? false;
    let settled = false;
    const onAbort = (): void => {
      aborted = true;
      killChild(child);
    };
    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, options.timeoutMs);
    child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: null,
        stderrHead,
        stdout: Buffer.concat(chunks),
        stdoutBytes: size,
        timedOut,
        overLimit,
        aborted,
        error,
      });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (overLimit) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > options.maxOutputBytes) {
        overLimit = true;
        killChild(child);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrHead.length >= MODEL_STDERR_BYTES) return;
      stderrHead = (stderrHead + chunk.toString('utf8')).slice(0, MODEL_STDERR_BYTES);
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: code,
        stderrHead,
        stdout: Buffer.concat(chunks),
        stdoutBytes: size,
        timedOut,
        overLimit,
        aborted,
        error: undefined,
      });
    });
  });
}

/** 只按退出码判 OOM；bwrap 把结束方式透传为退出码（SANDBOX-SPEC §5.6）。 */
function isOutOfMemory(exitCode: number | null, stderrHead: string): boolean {
  if (exitCode === 134 && stderrHead.includes('heap out of memory')) return true;
  return exitCode === 133 && stderrHead.includes('Fatal process out of memory');
}

/**
 * 严格解析 stdout 为报告：致命 UTF-8 解码 + JSON.parse（尾部非空白垃圾即失败）。返回 null 表示
 * 结构上不可读（归 crashed）；JSON 合法但不合 schema 时抛 protocol-error（child 契约被破坏）。
 */
function parseReport(bytes: Uint8Array): ModelChildReport | null {
  if (bytes.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(DECODER.decode(bytes)) as unknown;
  } catch {
    return null;
  }
  const parsed = modelChildReportSchema.safeParse(json);
  if (!parsed.success) {
    throw new SandboxError(
      'protocol-error',
      `modeling-child 报告不合 schema：${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  return parsed.data;
}

async function executeRun(
  code: string,
  options: ModelRunOptions,
  deps: ModelRunnerDeps,
  state: RunnerState,
): Promise<ModelExecution> {
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > MAX_MODEL_CODE_BYTES) {
    return {
      kind: 'too-large',
      bytes,
      limit: MAX_MODEL_CODE_BYTES,
      message: `代码 ${String(bytes)} 字节，超过上限 ${String(MAX_MODEL_CODE_BYTES)} 字节`,
    };
  }
  const resolved = resolveOptions(options);
  const childInput: ModelChildInput = {
    protocol: MODEL_CHILD_PROTOCOL_VERSION,
    code,
    seed: resolved.seed,
    limits: { consoleBytes: MODEL_CONSOLE_BYTES },
  };
  // 种子等宿主输入不合 schema 是调用方缺陷（与体素 runCode 同口径），抛 SandboxError。
  if (!modelInputOk(childInput)) {
    throw new SandboxError('protocol-error', 'runModelCode 的 seed 必须是 0..2^32-1 的整数（宿主缺陷）');
  }
  state.support ??= deps.detect();
  if (!state.support.ok) return { kind: 'unsupported', message: `没有 bwrap：${state.support.reason}` };
  // 语法 / 类型问题在启动 bwrap 之前挡住（MODELING-SPEC §4）。
  const prechecker = (state.prechecker ??= deps.precheck());
  const checked = await raceWithSignal(prechecker.check(code), resolved.signal);
  if (checked === ABORTED) {
    // 中止要真的停掉预检线程（否则它会继续在后台跑）；丢掉引用让下次重建。
    state.prechecker = undefined;
    await prechecker.close();
    return { kind: 'aborted', message: '建模执行被中止' };
  }
  if (checked.kind === 'too-large') {
    return {
      kind: 'too-large',
      bytes: checked.bytes,
      limit: checked.limit,
      message: `代码 ${String(checked.bytes)} 字节，超过上限 ${String(checked.limit)} 字节`,
    };
  }
  if (checked.kind === 'timeout') {
    return {
      kind: 'precheck-error',
      message: `类型预检超时（${String(checked.limitMs)}ms）`,
      diagnostics: [],
      total: 0,
    };
  }
  if (checked.kind === 'out-of-memory') {
    return {
      kind: 'precheck-error',
      message: `类型预检内存超限（${String(checked.limitMiB)}MiB）`,
      diagnostics: [],
      total: 0,
    };
  }
  if (checked.kind === 'failed') {
    return {
      kind: 'precheck-error',
      message: `代码未通过预检：${String(checked.total)} 处问题`,
      diagnostics: checked.diagnostics,
      total: checked.total,
    };
  }
  const launch = sandboxLaunch(deps.paths, deps.limits, deps.paths.childPath, [], undefined);
  const result = await execute(deps, launch, resolved, Buffer.from(JSON.stringify(childInput), 'utf8'));
  if (result.error !== undefined) return { kind: 'unsupported', message: `无法启动沙箱进程：${result.error.message}` };
  if (result.aborted) return { kind: 'aborted', message: '建模执行被中止' };
  if (result.timedOut) {
    return { kind: 'timeout', message: `建模执行超过 ${String(resolved.timeoutMs)}ms`, timeoutMs: resolved.timeoutMs };
  }
  // 只有"退出码 3 且 stderr 以 PG_PROTOCOL_ERROR: 开头"才是宿主 / sandbox 缺陷。
  if (result.exitCode === 3 && result.stderrHead.startsWith('PG_PROTOCOL_ERROR:')) {
    throw new SandboxError('protocol-error', escapeControl(result.stderrHead.slice(0, 200)));
  }
  if (result.overLimit) {
    return {
      kind: 'output-too-large',
      message: `建模输出超过 ${String(resolved.maxOutputBytes)} 字节`,
      bytes: result.stdoutBytes,
      limit: resolved.maxOutputBytes,
    };
  }
  if (isOutOfMemory(result.exitCode, result.stderrHead))
    return { kind: 'out-of-memory', message: '沙箱子进程内存超限' };
  const report = parseReport(result.stdout);
  if (report === null) {
    return { kind: 'crashed', message: '沙箱子进程没有产出合法报告', stderrHead: result.stderrHead };
  }
  if (report.status === 'build-error') {
    return {
      kind: 'build-error',
      message: report.error.message,
      name: report.error.name,
      line: report.error.line,
      column: report.error.column,
      console: report.console,
      consoleTruncated: report.consoleTruncated,
    };
  }
  if (result.exitCode !== 0)
    return { kind: 'crashed', message: `沙箱退出码 ${String(result.exitCode)}`, stderrHead: result.stderrHead };
  const documentHash = hashModelDocument(report.document);
  if (documentHash !== report.documentHash) {
    throw new SandboxError('protocol-error', `documentHash 不一致：宿主 ${documentHash}，child ${report.documentHash}`);
  }
  return {
    kind: 'ok',
    document: report.document,
    codeHash: hashModelCode(code),
    documentHash,
    console: report.console,
    consoleTruncated: report.consoleTruncated,
  };
}

/** 只校验种子（其余字段由代码大小检查保证）；不合时由调用方抛 protocol-error。 */
function modelInputOk(input: ModelChildInput): boolean {
  return Number.isInteger(input.seed) && input.seed >= 0 && input.seed <= 2 ** 32 - 1;
}

/**
 * 建一个 runner；`deps` 缺省用真实实现，测试可注入 spawn / detect / precheck / paths / limits。
 * 实例内部串行：同一 runner 同时只跑一个子进程（用闭包变量而不是模块级 let）。
 */
export function createModelRunner(deps: Partial<ModelRunnerDeps> = {}): ModelRunner {
  const resolved: ModelRunnerDeps = { ...defaultDeps(), ...deps };
  const state: RunnerState = { support: undefined, prechecker: undefined };
  let queue: Promise<unknown> = Promise.resolve();

  function runCode(code: string, options: ModelRunOptions = {}): Promise<ModelExecution> {
    const task = queue.then(
      () => executeRun(code, options, resolved, state),
      () => executeRun(code, options, resolved, state),
    );
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function close(): Promise<void> {
    const target = state.prechecker;
    state.prechecker = undefined;
    if (target !== undefined) await target.close();
  }

  return { runCode, close };
}

/**
 * 建模预检器：用 MODEL_DECLARATION 桥接 `Model`，入口错误信息写成 `build(model: Model)`，
 * 并用 checker 核对入口确实能接收 `Model` 且返回 void（PG006 / PG007）。
 */
export function createModelPrechecker(options: PrecheckOptions = {}): Prechecker {
  return createPrechecker(MODEL_DECLARATION, {
    ...options,
    globalsText: MODEL_GLOBALS_TEXT,
    entry: MODEL_ENTRY,
    expectedEntryType: 'Model',
  });
}

function defaultDeps(): ModelRunnerDeps {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  return {
    spawn: (command, args, options) =>
      spawn(command, args, { cwd: options.cwd, stdio: options.stdio, detached: options.detached }),
    detect: detectSandbox,
    precheck: () => createModelPrechecker(),
    paths: {
      repoRoot,
      nodePath: process.execPath,
      childPath: fileURLToPath(new URL('./modeling-child.ts', import.meta.url)),
      blockStatesPath: fileURLToPath(new URL('../../../assets/mc-1.20.1/block-states.json', import.meta.url)),
    },
    limits: { maxOldSpaceMiB: DEFAULTS.maxOldSpaceMiB, addressSpaceGiB: DEFAULTS.addressSpaceGiB },
  };
}

/**
 * 执行一份建模代码；语法 / 类型错误先于 bwrap 返回 precheck-error，无 bwrap 返回 unsupported。
 * 一次性入口：每次新建 runner 并在结束时终止预检线程；并发调用由 agent 自行串行化。
 */
export async function runModelCode(code: string, options: ModelRunOptions = {}): Promise<ModelExecution> {
  const runner = createModelRunner();
  try {
    return await runner.runCode(code, options);
  } finally {
    await runner.close();
  }
}
