/**
 * 单 run 命令行（AGENT-SPEC §9、§11）：只做接线——解析 argv、装配真实依赖、跑一次 runner、打印并给退出码。
 *
 * 退出码：交付（submitted）=0；其余停止原因=1；参数 / 配置 / 确认错误=2。
 * `--live` 只在这里出现，且需要 PG_LIVE_CONFIRM=1；mock / replay 不读环境、不碰全局 fetch。
 * 参数解析在 cli-args.ts（纯函数、有单测），依赖组装在 cli-deps.ts。
 */

import { loadRegistry } from '@pg/blocks/load';
import { ConfigError } from '@pg/config';
import { createRenderer } from '@pg/render/render';
import { createPrechecker } from '@pg/sandbox/precheck';
import { runCode } from '@pg/sandbox/run';
import { createRunDir } from '@pg/store/run-dir';
import { fileURLToPath } from 'node:url';

import { CliArgError, parseCliArgs, USAGE } from './cli-args.ts';
import {
  buildModelSource,
  buildRunnerInput,
  CliConfirmError,
  computeVersions,
  estimateTokens,
  loadWorldDts,
  readGates,
  readSeedCode,
  readSeedDesign,
  readSeedImages,
  readTask,
  runIdFor,
} from './cli-deps.ts';
import type { ModelRuntime } from './cli-deps.ts';
import type { GateConfig } from './gates.ts';
import { runRun } from './runner.ts';
import type { RunOutcome } from './runner.ts';

/** 打印一次 run 的结果；返回退出码（AGENT-SPEC §9）。 */
function report(outcome: RunOutcome): number {
  const submitted = outcome.delivery !== null;
  console.log(`run 目录: ${outcome.dir}`);
  console.log(`停止原因: ${outcome.stopReason ?? 'submitted（已交付）'}`);
  console.log(outcome.costCny === null ? '特许测试：未计费' : `花费: ¥${outcome.costCny.toFixed(4)}`);
  console.log(`轮数: ${String(outcome.turns)}`);
  return submitted ? 0 : 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliArgError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  let model: ModelRuntime;
  try {
    model = buildModelSource(opts, opts.seed);
  } catch (error) {
    if (error instanceof CliArgError || error instanceof CliConfirmError || error instanceof ConfigError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  let task;
  try {
    task = readTask(opts.taskPath);
  } catch (error) {
    console.error(`读题面失败：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let initialDraftCode: string | undefined;
  if (opts.seedCode !== undefined) {
    try {
      initialDraftCode = readSeedCode(opts.seedCode);
    } catch (error) {
      console.error(`读种子稿失败：${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  let initialDesign: string | undefined;
  if (opts.seedDesign !== undefined) {
    try {
      initialDesign = readSeedDesign(opts.seedDesign);
    } catch (error) {
      console.error(`读种子设计文档失败：${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  let initialImages: { name: string; png: Uint8Array }[] | undefined;
  if (opts.seedImages !== undefined) {
    try {
      initialImages = readSeedImages(opts.seedImages);
    } catch (error) {
      console.error(`读骨架渲染图失败：${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  let gates: GateConfig | undefined;
  if (opts.gatesPath !== undefined) {
    try {
      gates = readGates(opts.gatesPath);
    } catch (error) {
      console.error(`读门槛配置失败：${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  const registry = loadRegistry();
  const worldDts = loadWorldDts();
  const prechecker = createPrechecker(worldDts);
  const renderer = createRenderer(registry);
  const store = createRunDir(opts.outDir, runIdFor(opts.taskPath, new Date()));
  try {
    const outcome = await runRun(buildRunnerInput(opts, task, model, initialDraftCode, initialDesign, initialImages), {
      client: model.client,
      check: { prechecker, runCode, registry, ...(gates === undefined ? {} : { gates }) },
      render: (archive, request) => renderer.render(archive, request),
      store,
      clock: model.clock,
      ...(model.sleep === undefined ? {} : { sleep: model.sleep }),
      versions: computeVersions(prechecker),
      worldDts,
      countTokens: estimateTokens,
    });
    return report(outcome);
  } catch (error) {
    // runner 已尽力收尾（internal-error）；这里给出可读错误，退出码 1。
    console.error(`运行失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.error(`run 目录: ${store.dir}`);
    return 1;
  } finally {
    await renderer.close();
    await prechecker.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
