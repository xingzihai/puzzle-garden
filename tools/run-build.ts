/**
 * 本地执行一份 `export default function build(w: World): void` 代码，走与 agent check_code 完全相同的路径：
 * `@pg/sandbox/precheck` 类型预检 → `@pg/sandbox/run` bwrap 执行 → agent 的测量与模型可见文本。
 *
 * 用法：node tools/run-build.ts <code.ts> --out <dir> [--seed <int>]
 * 输出：<dir>/<代码文件名去扩展名>.pgar（执行成功时）、<dir>/<同名>.report.txt（与模型看到的 check_code 文本逐字相同，
 *       末尾附 API 调用计数）。预检或执行失败时退出码 1，报告照写。
 *
 * 负责：参数解析、组装真实依赖（prechecker / runCode / registry）、落盘、关闭预检线程。
 * 不负责：出图（tools/render-archive.ts）、评审。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCode } from '@pg/agent/tools/check';
import { loadRegistry } from '@pg/blocks/load';
import { createPrechecker } from '@pg/sandbox/precheck';
import { runCode } from '@pg/sandbox/run';

export interface RunBuildArgs {
  readonly code: string;
  readonly outDir: string;
  readonly seed: number;
}

export const USAGE = 'node tools/run-build.ts <code.ts> --out <dir> [--seed <int>]';

/** 解析命令行；缺代码、缺 `--out`、多余位置参数、未知选项、非法种子都报错（STANDARDS §4）。 */
export function parseArgs(argv: readonly string[]): RunBuildArgs {
  let code: string | undefined;
  let outDir: string | undefined;
  let seed = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' || arg === '--seed') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${arg} 缺少参数值`);
      if (arg === '--out') outDir = value;
      else {
        if (!/^\d+$/.test(value) || Number(value) > 2 ** 32 - 1)
          throw new Error(`--seed 应为 0–4294967295 的整数，实际是 ${JSON.stringify(value)}`);
        seed = Number(value);
      }
      i += 1;
    } else if (arg?.startsWith('--')) {
      throw new Error(`未知参数 ${arg}；用法：${USAGE}`);
    } else if (arg !== undefined) {
      if (code !== undefined) throw new Error(`只接受一份代码，多出了 ${arg}；用法：${USAGE}`);
      code = arg;
    }
  }
  if (code === undefined) throw new Error(`缺少代码文件；用法：${USAGE}`);
  if (outDir === undefined) throw new Error(`缺少 --out <dir>；用法：${USAGE}`);
  return { code, outDir, seed };
}

/** API 调用计数，按次数降序、同次数按名字排，一行一个。 */
export function formatApiCalls(calls: Readonly<Record<string, number>>): string {
  const entries = Object.entries(calls).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (entries.length === 0) return 'API 调用：无';
  return ['API 调用：', ...entries.map(([api, n]) => `  ${api} ×${String(n)}`)].join('\n');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const code = readFileSync(args.code, 'utf8');
  const name = basename(args.code, extname(args.code));
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });

  const registry = loadRegistry();
  const worldDts = readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');
  const prechecker = createPrechecker(worldDts);
  try {
    const result = await checkCode(
      { code, version: 1, seed: args.seed },
      { prechecker, runCode: (input) => runCode(input), registry, clock: () => performance.now() },
    );
    const parts = [result.text];
    if (result.apiCalls !== undefined) parts.push(formatApiCalls(result.apiCalls));
    parts.push(`状态：${result.status} · 墙钟 ${String(Math.round(result.wallMs))} ms`);
    const report = parts.join('\n\n');
    writeFileSync(join(outDir, `${name}.report.txt`), `${report}\n`);
    if (result.archive !== undefined) writeFileSync(join(outDir, `${name}.pgar`), result.archive);
    console.log(report);
    return result.status === 'ok' ? 0 : 1;
  } finally {
    await prechecker.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
