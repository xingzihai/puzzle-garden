/**
 * `@pg/sandbox/run` 的公开入口（SANDBOX-SPEC §6）：检测 bwrap、按资源上限执行模型代码、
 * 校验 child 输出并给出结构化结果。
 *
 * 负责：宿主侧进程管理、分帧解析、结果分类、hash 复算、串行队列、SandboxError。
 * 不负责：预检（调用方先 check）、模型代码的隔离细节（child 与 bwrap）。
 *
 * `createRunner` 接受注入的 spawn / detect / table，供单元测试覆盖"不支持时不启动子进程"与
 * 串行性；产品默认实例只用真实实现，不在公开 API 暴露注入点。
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { readArchive } from '@pg/core/archive';
import { createBlockTable } from '@pg/core/block-state';
import type { BlockTable } from '@pg/core/block-state';
import type { Grid } from '@pg/core/grid';
import { hashGrid } from '@pg/core/hash';
import { API_VERSION } from '@pg/geometry';

import { sandboxLaunch } from './args.ts';
import type { Launch, SandboxLayout } from './args.ts';
import { classifyOutcome } from './classify.ts';
import { escapeControl } from './escape.ts';
import { SandboxError } from './errors.ts';
import { decodeFrame } from './frame.ts';
import {
  CHILD_PROTOCOL_VERSION,
  childReportSchema,
  DEFAULT_REPORT_BYTES,
  MAX_ASSET_DOCUMENT_BYTES,
  MAX_ASSET_DOCUMENTS,
  MAX_ASSETS_TOTAL_BYTES,
  MAX_CODE_BYTES,
  REPORT_FORMAT_VERSION,
  runInputSchema,
} from './protocol.ts';
import type { ChildInput, ChildReport, MassingAssets } from './protocol.ts';
import type { RunInput } from './protocol.ts';

export type { RunInput, MassingDocumentAsset } from './protocol.ts';

/** 代码字节上限；agent 的 `write_code` 也用它（AGENT-SPEC §4.1，C3）。 */
export { MAX_CODE_BYTES, REPORT_FORMAT_VERSION };
export type { OverlapReport, OverlapSampleDetail, OverlapSummary } from './protocol.ts';
export { MAX_ASSET_DOCUMENT_BYTES, MAX_ASSET_DOCUMENTS, MAX_ASSETS_TOTAL_BYTES };

/** bwrap 可用性检测结果（§6、§7.4）。 */
export type SandboxSupport =
  { readonly ok: true; readonly bwrap: string } | { readonly ok: false; readonly reason: string };

/** 资源上限默认值；依据见 §5.5 表，改这里必须同步改规格。 */
const DEFAULTS = {
  wallMs: 30_000,
  maxOldSpaceMiB: 3072,
  addressSpaceGiB: 8,
  archiveBytes: 256 * 1024 * 1024,
  reportBytes: DEFAULT_REPORT_BYTES,
  consoleBytes: 8192,
  stderrBytes: 64 * 1024,
} as const;

/** 与 §5.5 表一一对应的可调上限；cgroupMemoryMax 为可选 MiB，M1 默认不启用。 */
export interface RunOptions {
  readonly wallMs?: number;
  readonly maxOldSpaceMiB?: number;
  readonly addressSpaceGiB?: number;
  readonly archiveBytes?: number;
  readonly reportBytes?: number;
  readonly consoleBytes?: number;
  readonly stderrBytes?: number;
  readonly cgroupMemoryMax?: number;
}

interface ResolvedOptions {
  readonly wallMs: number;
  readonly maxOldSpaceMiB: number;
  readonly addressSpaceGiB: number;
  readonly archiveBytes: number;
  readonly reportBytes: number;
  readonly consoleBytes: number;
  readonly stderrBytes: number;
  readonly cgroupMemoryMax: number | undefined;
}

/**
 * report 超过 `reportBytes` 上限时附带的诊断数字（2026-10-04 新增可选字段）。
 * `calls` / `overlaps` 只在帧结构合法、报告能过 schema 时才有；旧记录没有 detail，仍可解析。
 */
export interface ReportOverLimitDetail {
  /** 报告（调用记录）实际字节数。 */
  readonly reportBytes: number;
  /** 报告字节上限。 */
  readonly limitBytes: number;
  /** 报告里的调用条数（拿得到时给）。 */
  readonly calls?: number;
  /** 报告里的重叠条数（拿得到时给）。 */
  readonly overlaps?: number;
}

/** 可辨识的执行结果（§8.2）。 */
export type RunResult =
  | {
      readonly kind: 'ok';
      readonly grid: Grid;
      readonly archive: Uint8Array;
      readonly hash: string;
      readonly report: ChildReport;
      readonly wallMs: number;
    }
  | { readonly kind: 'build-error'; readonly report: ChildReport; readonly wallMs: number }
  | {
      readonly kind: 'timeout' | 'out-of-memory' | 'output-too-large' | 'crashed';
      readonly stderrHead: string;
      /** 仅 `crashed` 且因报告超限时给出；其它失败没有该键。 */
      readonly detail?: ReportOverLimitDetail;
      readonly wallMs: number;
    }
  | { readonly kind: 'too-large'; readonly bytes: number; readonly limit: number }
  | {
      /** 宿主注入的草模资产超限（MASSING-CONVERSION-SPEC §5.2）；来自宿主数据，不是模型错误。 */
      readonly kind: 'assets-too-large';
      readonly reason: 'documents-count' | 'document-bytes' | 'total-bytes';
      readonly documents: number;
      /** 触发 reason 的度量：document-bytes 为最大单份，其余为合计。 */
      readonly bytes: number;
      readonly limit: number;
    }
  | { readonly kind: 'unsupported'; readonly reason: string };

/** 宿主子进程的最小结构；测试用假子进程也实现它。 */
export interface ChildProcessLike {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly stdio: 'pipe' },
) => ChildProcessLike;

export interface RunnerDeps {
  readonly spawn: SpawnFn;
  readonly detect: () => SandboxSupport;
  readonly table: () => BlockTable;
  readonly paths: SandboxLayout;
}

export interface Runner {
  readonly runCode: (input: RunInput, options?: RunOptions) => Promise<RunResult>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 检测 bwrap（§7.4）：平台、可执行、能建非特权命名空间；任一失败都不回退。 */
export function detectSandbox(): SandboxSupport {
  if (process.platform !== 'linux') {
    return { ok: false, reason: `平台是 ${process.platform}，@pg/sandbox 只在 Linux 上用 bwrap 执行` };
  }
  let version: string;
  try {
    version = execFileSync('bwrap', ['--version'], { encoding: 'utf8' }).trim();
  } catch (error) {
    return { ok: false, reason: `无法执行 bwrap：${messageOf(error)}` };
  }
  try {
    execFileSync('bwrap', ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', 'true'], { stdio: 'ignore' });
  } catch {
    return { ok: false, reason: 'bwrap 无法创建非特权命名空间（Ubuntu 系可能被 AppArmor 限制）' };
  }
  return { ok: true, bwrap: version };
}

/**
 * sandbox 组件版本：sha256(child 输入协议版本 + bwrap 版本 + node 版本 + 报告格式版本)，
 * 与 `prechecker.version` 同为十六进制摘要。child 源码 sha256 是否加入仍按 §8.3 暂缓。
 * 拆出纯计算函数便于测试逐项验证拼装，产品只经 `sandboxVersion()`。
 */
export function computeSandboxVersion(
  childProtocol: number,
  bwrap: string,
  node: string,
  reportFormat: number = REPORT_FORMAT_VERSION,
): string {
  return createHash('sha256')
    .update(String(childProtocol), 'utf8')
    .update('\u0000', 'utf8')
    .update(bwrap, 'utf8')
    .update('\u0000', 'utf8')
    .update(node, 'utf8')
    .update('\u0000', 'utf8')
    .update(String(reportFormat), 'utf8')
    .digest('hex');
}

/** 用真实环境算 sandbox 版本；bwrap 不可用时以原因代替版本，仍得到稳定的可记录字符串。 */
export function sandboxVersion(): string {
  const support = detectSandbox();
  const bwrap = support.ok ? support.bwrap : `unavailable:${support.reason}`;
  return computeSandboxVersion(CHILD_PROTOCOL_VERSION, bwrap, process.version);
}

function resolveOptions(options: RunOptions): ResolvedOptions {
  return {
    wallMs: options.wallMs ?? DEFAULTS.wallMs,
    maxOldSpaceMiB: options.maxOldSpaceMiB ?? DEFAULTS.maxOldSpaceMiB,
    addressSpaceGiB: options.addressSpaceGiB ?? DEFAULTS.addressSpaceGiB,
    archiveBytes: options.archiveBytes ?? DEFAULTS.archiveBytes,
    reportBytes: options.reportBytes ?? DEFAULTS.reportBytes,
    consoleBytes: options.consoleBytes ?? DEFAULTS.consoleBytes,
    stderrBytes: options.stderrBytes ?? DEFAULTS.stderrBytes,
    cgroupMemoryMax: options.cgroupMemoryMax,
  };
}

interface ExecuteResult {
  readonly exitCode: number | null;
  readonly stderrHead: string;
  readonly stdout: Uint8Array;
  readonly timedOut: boolean;
  readonly overLimit: boolean;
  readonly error: Error | undefined;
}

/** 资产大小度量（§5.2）：逐份文档的序列化 JSON 字节与合计。 */
export function measureAssets(assets: Pick<MassingAssets, 'documents'>): {
  readonly perDocument: readonly number[];
  readonly total: number;
} {
  const perDocument: number[] = [];
  let total = 0;
  for (const entry of assets.documents) {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(entry.document), 'utf8');
    } catch (error) {
      throw new SandboxError('protocol-error', `assets 文档 ${entry.id} 无法序列化：${messageOf(error)}`);
    }
    perDocument.push(bytes);
    total += bytes;
  }
  return { perDocument, total };
}

/**
 * 资产上限检查（§5.2）：份数 → 单份字节 → 合计字节。超限返回 `assets-too-large`，在进队列与
 * 启动子进程之前由宿主直接给出；这是宿主输入的可预期失败，不归 `protocol-error`。
 * requireRoom 为生成前检查：必须还能增加一份文档且总字节未满；实际产出仍需按完整文档复检。
 */
export function checkAssets(
  assets: Pick<MassingAssets, 'documents'>,
  requireRoom = false,
): Extract<RunResult, { kind: 'assets-too-large' }> | null {
  const { perDocument, total } = measureAssets(assets);
  const documents = assets.documents.length;
  if (documents > MAX_ASSET_DOCUMENTS || (requireRoom && documents === MAX_ASSET_DOCUMENTS))
    return {
      kind: 'assets-too-large',
      reason: 'documents-count',
      documents,
      bytes: total,
      limit: MAX_ASSET_DOCUMENTS,
    };
  const largest = perDocument.length === 0 ? 0 : Math.max(...perDocument);
  if (largest > MAX_ASSET_DOCUMENT_BYTES)
    return {
      kind: 'assets-too-large',
      reason: 'document-bytes',
      documents,
      bytes: largest,
      limit: MAX_ASSET_DOCUMENT_BYTES,
    };
  if (total > MAX_ASSETS_TOTAL_BYTES || (requireRoom && total === MAX_ASSETS_TOTAL_BYTES))
    return { kind: 'assets-too-large', reason: 'total-bytes', documents, bytes: total, limit: MAX_ASSETS_TOTAL_BYTES };
  return null;
}

/** 启动一次子进程、写入 stdin 并读流；超时用 SIGKILL，输出超过安全阀也 kill（§5.5）。 */
function execute(
  deps: RunnerDeps,
  launch: Launch,
  options: ResolvedOptions,
  stdin: Uint8Array,
): Promise<ExecuteResult> {
  return new Promise<ExecuteResult>((resolve) => {
    let child: ChildProcessLike;
    try {
      child = deps.spawn(launch.command, launch.args, { cwd: deps.paths.repoRoot, stdio: 'pipe' });
    } catch (error) {
      resolve({
        exitCode: null,
        stderrHead: '',
        stdout: new Uint8Array(0),
        timedOut: false,
        overLimit: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    // 子进程可能在读完 stdin 前退出（EPIPE）。这里吞掉写失败，结果由 close 事件与退出码分类（F5）。
    child.stdin?.on('error', (): void => {
      // 写失败不单独成结果：子进程的 close / 退出码会给出分类。
    });
    child.stdin?.end(Buffer.from(stdin));
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrHead = '';
    let timedOut = false;
    let overLimit = false;
    let settled = false;
    // 安全阀：帧 = 头 + 报告 + 存档；报告与存档各自还有更精确的上限判断。
    const cap = options.archiveBytes + options.reportBytes + 4096;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.wallMs);
    child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stderrHead, stdout: Buffer.concat(chunks), timedOut, overLimit, error });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (overLimit) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > cap) {
        overLimit = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrHead.length >= options.stderrBytes) return;
      stderrHead = (stderrHead + chunk.toString('utf8')).slice(0, options.stderrBytes);
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stderrHead, stdout: Buffer.concat(chunks), timedOut, overLimit, error: undefined });
    });
  });
}

function readArchiveInSandbox(table: BlockTable, bytes: Uint8Array): { readonly grid: Grid } {
  try {
    return readArchive(table, bytes);
  } catch (error) {
    throw new SandboxError('protocol-error', `存档读不回：${messageOf(error)}`);
  }
}

/** 建一个 runner；真实实现与测试注入都走这里。 */
export function createRunner(deps: RunnerDeps): Runner {
  let support: SandboxSupport | undefined;
  let table: BlockTable | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const getTable = (): BlockTable => {
    table ??= deps.table();
    return table;
  };

  async function executeRun(input: RunInput, options: RunOptions): Promise<RunResult> {
    support ??= deps.detect();
    if (!support.ok) return { kind: 'unsupported', reason: support.reason };
    const resolved = resolveOptions(options);
    const started = performance.now();
    const launch = sandboxLaunch(deps.paths, resolved, undefined, [], resolved.cgroupMemoryMax);
    const childInput: ChildInput = {
      protocol: CHILD_PROTOCOL_VERSION,
      code: input.code,
      seed: input.seed,
      apiVersion: API_VERSION,
      limits: { consoleBytes: resolved.consoleBytes },
      ...(input.assets === undefined ? {} : { assets: input.assets }),
    };
    const result = await execute(deps, launch, resolved, Buffer.from(JSON.stringify(childInput), 'utf8'));
    const wallMs = performance.now() - started;
    if (result.error !== undefined) {
      throw new SandboxError('spawn-failed', `无法启动沙箱进程：${result.error.message}`);
    }
    // 只有"退出码 3 且 stderr 以 PG_PROTOCOL_ERROR: 开头"才是宿主/sandbox 缺陷；其它都归 crashed（F2）。
    if (result.exitCode === 3 && result.stderrHead.startsWith('PG_PROTOCOL_ERROR:')) {
      throw new SandboxError('protocol-error', escapeControl(result.stderrHead.slice(0, 200)));
    }
    const decoded = decodeFrame(result.stdout);
    let report: ChildReport | null = null;
    let archiveOverLimit = false;
    let reportOverLimit = false;
    let reportBytes = 0;
    if (decoded.ok) {
      reportOverLimit = decoded.reportLength > resolved.reportBytes;
      reportBytes = decoded.reportLength;
      const parsed = childReportSchema.safeParse(decoded.report);
      if (!parsed.success) {
        throw new SandboxError('protocol-error', `child 报告不合 schema：${parsed.error.issues[0]?.message ?? ''}`);
      }
      report = parsed.data;
      archiveOverLimit = decoded.archive.byteLength > resolved.archiveBytes;
    } else if (result.overLimit) {
      // 流式安全阀触发但帧不完整：能读到报告长度就区分报告超限，否则归存档超限。
      const length =
        result.stdout.length >= 12
          ? new DataView(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength).getUint32(8, true)
          : 0;
      reportBytes = length;
      if (length > resolved.reportBytes) reportOverLimit = true;
      else archiveOverLimit = true;
    }
    // 报告超限时把可得数字留给上层，让模型看到具体要改什么（调用条数只在报告能过 schema 时才有）。
    // overlaps 记截断前总数：child 截断后仍超限时报告带 overlapsTruncated，这里把丢弃条数补回。
    const kind = classifyOutcome({
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      stderrHead: result.stderrHead,
      report: reportOverLimit ? null : report,
      reportOverLimit,
      archiveOverLimit,
    });
    const detail: ReportOverLimitDetail | undefined =
      reportOverLimit && kind === 'crashed'
        ? {
            reportBytes,
            limitBytes: resolved.reportBytes,
            ...(report === null
              ? {}
              : { calls: report.calls, overlaps: report.overlaps.length + (report.overlapsTruncated ?? 0) }),
          }
        : undefined;
    if (kind === 'ok') {
      if (report === null || !decoded.ok) throw new SandboxError('protocol-error', '归类为 ok 却没有合法帧');
      const contents = readArchiveInSandbox(getTable(), decoded.archive);
      const hash = hashGrid(contents.grid);
      if (hash !== report.hash) {
        throw new SandboxError('protocol-error', `hash 不一致：宿主 ${hash}，child ${report.hash}`);
      }
      return { kind: 'ok', grid: contents.grid, archive: decoded.archive, hash, report, wallMs };
    }
    if (kind === 'build-error') {
      if (report === null) throw new SandboxError('protocol-error', '归类为 build-error 却没有报告');
      return { kind: 'build-error', report, wallMs };
    }
    return { kind, stderrHead: result.stderrHead, wallMs, ...(detail === undefined ? {} : { detail }) };
  }

  function runCode(input: RunInput, options: RunOptions = {}): Promise<RunResult> {
    // F6：代码与预检共用 256 KiB 上限。超大代码来自模型，返回结构化结果（复用预检 too-large 形状），
    // 不抛 ZodError、也不进队列启动子进程（§5.6、§6）。
    const bytes = Buffer.byteLength(input.code, 'utf8');
    if (bytes > MAX_CODE_BYTES) {
      return Promise.resolve({ kind: 'too-large', bytes, limit: MAX_CODE_BYTES });
    }
    // 资产超限在 schema 解析与入队之前返回（§5.2）：大文档不做 zod 解析，也不启动子进程。
    // 形状不对（documents 不是数组）时跳过，交给下面的 schema 校验抛 protocol-error。
    if (input.assets !== undefined && Array.isArray(input.assets.documents)) {
      const tooLarge = checkAssets(input.assets);
      if (tooLarge !== null) return Promise.resolve(tooLarge);
    }
    // 其余不合 schema 的输入是调用方（宿主）缺陷，按 §6 抛 SandboxError('protocol-error')，不外泄 ZodError。
    const parsed = runInputSchema.safeParse(input);
    if (!parsed.success) {
      return Promise.reject(
        new SandboxError('protocol-error', `runCode 输入不合 schema：${parsed.error.issues[0]?.message ?? ''}`),
      );
    }
    // 串行队列：同一 runner 同时只跑一个子进程（§5.5、§6）。
    const task = queue.then(
      () => executeRun(parsed.data, options),
      () => executeRun(parsed.data, options),
    );
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  return { runCode };
}

const defaultLayout: SandboxLayout = {
  repoRoot: fileURLToPath(new URL('../../../', import.meta.url)),
  nodePath: process.execPath,
  childPath: fileURLToPath(new URL('./child.ts', import.meta.url)),
  blockStatesPath: fileURLToPath(new URL('../../../assets/mc-1.20.1/block-states.json', import.meta.url)),
};

function loadDefaultTable(): BlockTable {
  const data: unknown = JSON.parse(readFileSync(defaultLayout.blockStatesPath, 'utf8')) as unknown;
  return createBlockTable(data);
}

const realSpawn: SpawnFn = (command, args, options) => spawn(command, args, { cwd: options.cwd, stdio: options.stdio });

const defaultRunner = createRunner({
  spawn: realSpawn,
  detect: detectSandbox,
  table: loadDefaultTable,
  paths: defaultLayout,
});

/** 执行模型代码；调用方已预检通过。不支持时返回 unsupported 且不启动子进程（§6）。 */
export function runCode(input: RunInput, options: RunOptions = {}): Promise<RunResult> {
  return defaultRunner.runCode(input, options);
}
