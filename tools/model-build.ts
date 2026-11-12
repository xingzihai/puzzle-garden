/**
 * `npm run model:build`：把一份建模代码经真实 bwrap 隔离执行，原子交付成目录。
 *
 * 负责：参数解析；真实 `@pg/sandbox/modeling` 预检 + 执行；把 source.ts / model.json / manifest.json
 *   先写进同父目录的临时目录，成功后 rename 成目标目录（原子）；已存在目标目录一律拒绝，绝不留半个交付。
 * 不负责：Agent 循环（tools/model-agent.ts）、查看器（packages/web）。
 *
 * 退出码：成功 0；执行失败或目标目录已存在 1；参数 / 读文件错误 2。
 * hash 直接取 sandbox 的 codeHash / documentHash，与 agent check 事件同口径，不另算一份。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_VERSION } from '@pg/modeling/schema';
import type { ModelDocument } from '@pg/modeling/schema';
import { runModelCode } from '@pg/sandbox/modeling';
import type { ModelExecution } from '@pg/sandbox/modeling';

import { MODELING_API, MODEL_MAX_CODE_BYTES } from './model-agent-deps.ts';

export interface BuildArgs {
  /** 建模代码文件路径（相对调用目录解析）。 */
  readonly code: string;
  /** 交付目录；已存在即拒绝。 */
  readonly outDir: string;
  readonly seed: number;
}

/** 参数错误的专用类型：入口据此用退出码 2。 */
export class BuildArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildArgError';
  }
}

export interface BuildIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export const BUILD_USAGE =
  '用法：node tools/model-build.ts --code <file.ts> --out <dir> [--seed <int>]\n' +
  '  在 <dir> 原子交付 source.ts / model.json / manifest.json；<dir> 已存在则拒绝。\n' +
  '  --code <file.ts>  建模代码文件（也接受一个位置参数写法）\n' +
  '  --seed <int>      沙箱 rng 种子，0–4294967295（默认 0）';

export function parseBuildArgs(argv: readonly string[]): BuildArgs {
  let code: string | undefined;
  let outDir: string | undefined;
  let seed = 0;
  const setCode = (value: string): void => {
    if (code !== undefined) throw new BuildArgError(`只接受一份代码，多给了 ${value}。\n${BUILD_USAGE}`);
    code = value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--code' || arg === '--out' || arg === '--seed') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new BuildArgError(`${arg} 缺少取值。\n${BUILD_USAGE}`);
      }
      if (arg === '--code') setCode(value);
      else if (arg === '--out') outDir = value;
      else {
        if (!/^\d+$/.test(value) || Number(value) > 2 ** 32 - 1) {
          throw new BuildArgError(`--seed 应为 0–4294967295 的整数，实际是 ${JSON.stringify(value)}`);
        }
        seed = Number(value);
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new BuildArgError(`不认识的参数 ${arg}。\n${BUILD_USAGE}`);
    setCode(arg);
  }
  if (code === undefined) throw new BuildArgError(`缺少代码文件（--code <file.ts>）。\n${BUILD_USAGE}`);
  if (outDir === undefined) throw new BuildArgError(`缺少 --out <dir>。\n${BUILD_USAGE}`);
  return { code, outDir, seed };
}

/** 交付清单（与 agent 的 delivery manifest 同字段，便于查看器 / 后续工具统一读）。 */
export interface BuildManifest {
  readonly format: 'pg-model';
  readonly version: 1;
  readonly status: 'ok';
  readonly codeVersion: 1;
  readonly codeHash: string;
  readonly documentHash: string;
  readonly seed: number;
  readonly modelingApi: number;
  readonly modelFormat: number;
}

export function buildManifest(input: {
  readonly seed: number;
  readonly codeHash: string;
  readonly documentHash: string;
}): BuildManifest {
  return {
    format: 'pg-model',
    version: 1,
    status: 'ok',
    codeVersion: 1,
    codeHash: input.codeHash,
    documentHash: input.documentHash,
    seed: input.seed,
    modelingApi: MODELING_API,
    modelFormat: MODEL_VERSION,
  };
}

/** 读建模代码：读不到 / 空 / 超上限都抛可读错误（由入口归为退出码 2）。 */
export function readBuildCode(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new BuildArgError(`${path} 读不到（${error instanceof Error ? error.message : String(error)}）。`);
  }
  if (bytes.length > MODEL_MAX_CODE_BYTES) {
    throw new BuildArgError(
      `${path} 有 ${String(bytes.length)} 字节，超过代码上限 ${String(MODEL_MAX_CODE_BYTES)} 字节。`,
    );
  }
  const code = bytes.toString('utf8');
  if (code.trim() === '') throw new BuildArgError(`${path} 是空文件或全空白，没有可执行的建模代码。`);
  return code;
}

/** 把一次执行失败写成给终端看的一行（成功不调用）。 */
export function failureText(execution: Exclude<ModelExecution, { readonly kind: 'ok' }>): string {
  switch (execution.kind) {
    case 'precheck-error':
      return `类型预检未通过（${String(execution.total)} 处）：${execution.message}`;
    case 'build-error':
      return `执行出错（${execution.name}，第 ${String(execution.line)} 行第 ${String(execution.column)} 列）：${execution.message}`;
    case 'timeout':
      return `执行超时（${String(execution.timeoutMs)}ms）`;
    case 'out-of-memory':
      return `执行内存超限：${execution.message}`;
    case 'output-too-large':
      return `建模输出过大（${String(execution.bytes)} 字节 > ${String(execution.limit)}）`;
    case 'crashed':
      return `执行进程异常退出：${execution.message}`;
    case 'aborted':
      return '执行被中止。';
    case 'too-large':
      return `代码过大（${String(execution.bytes)} 字节 > ${String(execution.limit)}）`;
    case 'unsupported':
      return `本机没有可用的 bwrap，拒绝执行：${execution.message}`;
  }
}

/** 执行结果成功时的交付文件（写盘由 {@link deliverAtomically} 做）。 */
export interface BuildDelivery {
  readonly code: string;
  readonly document: ModelDocument;
  readonly codeHash: string;
  readonly documentHash: string;
}

/**
 * 原子交付：在目标目录同父目录建临时目录写三份文件，成功后 rename 成目标目录。
 * 目标已存在直接拒绝；任何失败都清掉临时目录，不留伪交付。
 */
export function deliverAtomically(outDir: string, manifestSeed: number, delivery: BuildDelivery): void {
  if (existsSync(outDir)) {
    throw new Error(`交付被拒：目标目录已存在，不覆盖已有交付：${outDir}`);
  }
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const temp = mkdtempSync(join(parent, '.model-build-'));
  try {
    writeFileSync(join(temp, 'source.ts'), delivery.code);
    writeFileSync(join(temp, 'model.json'), `${JSON.stringify(delivery.document, null, 2)}\n`);
    writeFileSync(
      join(temp, 'manifest.json'),
      `${JSON.stringify(
        buildManifest({ seed: manifestSeed, codeHash: delivery.codeHash, documentHash: delivery.documentHash }),
        null,
        2,
      )}\n`,
    );
    if (existsSync(outDir)) throw new Error(`交付被拒：目标目录在交付期间出现，不覆盖：${outDir}`);
    renameSync(temp, outDir);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

/** CLI 主体；`execute` 可注入假件，单测无需 bwrap。 */
export async function runBuild(
  argv: readonly string[],
  io: BuildIo,
  execute: (code: string, options: { readonly seed: number }) => Promise<ModelExecution> = runModelCode,
): Promise<number> {
  let args: BuildArgs;
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      io.stdout(BUILD_USAGE);
      return 0;
    }
    args = parseBuildArgs(argv);
  } catch (error) {
    if (error instanceof BuildArgError) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }

  let code: string;
  try {
    code = readBuildCode(args.code);
  } catch (error) {
    if (error instanceof BuildArgError) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }

  const outDir = resolve(args.outDir);
  if (existsSync(outDir)) {
    io.stderr(`交付被拒：目标目录已存在，不覆盖已有交付：${outDir}`);
    return 1;
  }

  const result = await execute(code, { seed: args.seed });
  if (result.kind !== 'ok') {
    io.stderr(`建模执行失败（${result.kind}）：${failureText(result)}`);
    return 1;
  }

  try {
    deliverAtomically(outDir, args.seed, {
      code,
      document: result.document,
      codeHash: result.codeHash,
      documentHash: result.documentHash,
    });
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  io.stdout(`已交付：${outDir}`);
  io.stdout(`codeHash: ${result.codeHash}`);
  io.stdout(`documentHash: ${result.documentHash}`);
  io.stdout(`部件数: ${String(result.document.parts.length)}`);
  return 0;
}

function createDefaultIo(): BuildIo {
  return {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBuild(process.argv.slice(2), createDefaultIo());
}
