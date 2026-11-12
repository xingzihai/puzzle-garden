/**
 * `npm run agent:massing` / `agent:massing:live`：带草模子运行宿主的构建 agent 入口（M5b，决策 #112）。
 *
 * 负责：参数解析（agent-massing-args.ts）；mock 用 `--mock` 剧本、live 从 `--task` 读题并按 `@pg/config` 造真实
 *   client；装配**体素** target 的真依赖（真预检器 + 真 `runCode` + registry、真体素渲染）并接上 **massing host**
 *   （真 `@pg/sandbox/modeling` 执行 + 真 `@pg/web/model-render` 三视图 / contact，注入 Chrome 路径）；
 *   跑一次 `runRun`，打印结果与退出码。
 * 不负责：请求循环 / 护栏（@pg/agent/runner）、工具逻辑（@pg/agent/*）、草模子运行编排（@pg/agent/massing-host）、
 *   依赖小函数（agent-massing-deps.ts）、live 配置与确认（tools/model-agent-live.ts）。
 *
 * 与 `packages/agent/src/cli.ts` 的差异：那个入口在 agent 包内组装，不能 import 层 5 的 `@pg/web`，
 * 因此没有 massing host（工具会回 no-host）；本入口放 tools 层，把 `renderModelViews` / `renderModelContact`
 * 注入 massing host。退出码同口径：交付 0；未交付 / 运行失败 1；参数、配置、确认或读文件错误 2。
 *
 * `--mock` 不读环境、不联网；`--live` 才调 `@pg/config` 且需 PG_LIVE_CONFIRM=1、模型在价格表。
 */

import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { gatesSchema } from '@pg/agent/gates';
import type { GateConfig } from '@pg/agent/gates';
import { colorCandidates } from '@pg/blocks/color';
import { ModelDocument } from '@pg/modeling/schema';

import type { ExternalVersions, RunOutcome, RunnerDeps, RunnerInput } from '@pg/agent/runner';
import { runRun } from '@pg/agent/runner';
import { loadRegistry } from '@pg/blocks/load';
import type { ChatClient } from '@pg/llm/client';
import { MODEL_VERSION } from '@pg/modeling/schema';
import { createRenderer } from '@pg/render/render';
import { createModelPrechecker, createModelRunner } from '@pg/sandbox/modeling';
import type { ModelRunner } from '@pg/sandbox/modeling';
import { createPrechecker } from '@pg/sandbox/precheck';
import type { Prechecker } from '@pg/sandbox/precheck';
import {
  runCode,
  checkAssets,
  measureAssets,
  MAX_ASSET_DOCUMENTS,
  MAX_ASSET_DOCUMENT_BYTES,
  MAX_ASSETS_TOTAL_BYTES,
} from '@pg/sandbox/run';
import type { MassingDocumentAsset } from '@pg/sandbox/run';
import { canonicalJson } from '@pg/store/canonical-json';
import { createRunDir } from '@pg/store/run-dir';
import { renderModelContact, renderModelViews } from '@pg/web/model-render';

import { AGENT_MASSING_USAGE, MassingArgError, parseAgentMassingArgs } from './agent-massing-args.ts';
import type { AgentMassingOptions, MassingModelSource } from './agent-massing-args.ts';
import {
  effectiveRunLimits,
  estimateTokens,
  loadWorldDts,
  massingRunId,
  voxelExternalVersions,
} from './agent-massing-deps.ts';
import {
  createMockModelRuntime,
  gitSnapshot,
  MODELING_API,
  modelExternalVersions,
  readModelScript,
  realClock,
  realSleep,
} from './model-agent-deps.ts';
import type { GitSnapshot } from './model-agent-deps.ts';
import type { LiveConfigInjection } from './model-agent-live.ts';
import { readLiveTask, redactSecret, resolveLiveStartup } from './model-agent-live.ts';

const seedAssetsSchema = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      document: ModelDocument,
    }),
  )
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, '种子资产 id 必须唯一');

function seedAssetBytes(assets: z.infer<typeof seedAssetsSchema>): number {
  const failure = checkAssets({ documents: assets });
  if (failure !== null) {
    const label = failure.reason === 'document-bytes' ? '单文档' : '总计';
    throw new Error(
      failure.reason === 'documents-count'
        ? `种子资产数量不得超过 ${String(failure.limit)} 份`
        : `种子资产${label} ${String(failure.bytes)} 字节，超过上限 ${String(failure.limit)} 字节`,
    );
  }
  return measureAssets({ documents: assets }).total;
}

export interface AgentMassingIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** 单测注入点：缺省时走真实墙钟 / 定时器 / token 近似；live 注入给定时不读环境、不联网。 */
export interface AgentMassingOverrides {
  readonly live?: LiveConfigInjection;
  readonly countTokens?: (text: string) => number;
  readonly clock?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** 已解析好的一次 run 的题面与模型来源（mock / live 二者之一）。 */
interface MassingSource {
  readonly task: RunnerInput['task'];
  readonly client: ChatClient;
  readonly mode: RunnerInput['mode'];
  readonly config: RunnerInput['config'];
  /** mock 进 run.start.script；live 不存在该键。 */
  readonly script?: { readonly name: string; readonly sha256: string };
  readonly limits: RunnerInput['limits'];
}

/** 打印一次 run 的结果；返回退出码（0 交付 / 1 未交付）。 */
function report(outcome: RunOutcome, io: AgentMassingIo, model: MassingModelSource, withoutMassing: boolean): number {
  const label = withoutMassing ? '构建 agent' : '构建 agent + 草模 host';
  io.stdout(
    model.kind === 'live'
      ? `${label}（真实模型调用；单次 run，需 owner 明确授权；真实账单以供应商为准）`
      : `${label} 演练（离线 mock LLM；真实 bwrap 执行 + 真实 Chrome 渲染；不是真实模型调用）`,
  );
  io.stdout(`run 目录: ${outcome.dir}`);
  io.stdout(`停止原因: ${outcome.stopReason ?? 'submitted（已交付）'}`);
  io.stdout(outcome.costCny === null ? '特许测试：未计费' : `花费: ¥${outcome.costCny.toFixed(4)}`);
  io.stdout(`轮数: ${String(outcome.turns)}`);
  if (outcome.delivery !== null) {
    io.stdout(`交付: 第 v${String(outcome.delivery.codeVersion)} 版，存档 hash ${outcome.delivery.hash}`);
  }
  return outcome.delivery === null ? 1 : 0;
}

/**
 * 解析题面与模型来源。先失败在参数 / 配置 / 读文件，再进入建 run 目录与启浏览器。
 * mock 不读环境、不碰全局 fetch；live 走 `@pg/config` 的第二道确认与价格表白名单。
 */
function resolveSource(
  opts: AgentMassingOptions,
  overrides: AgentMassingOverrides,
): { source: MassingSource; secret: string } {
  if (opts.model.kind === 'live') {
    const startup = resolveLiveStartup(overrides.live);
    return {
      source: {
        task: readLiveTask(opts.taskPath, opts.feedback),
        client: startup.runtime.client,
        mode: 'live',
        config: startup.runtime.config,
        limits: effectiveRunLimits(opts.limits, startup.runtime.envMaxCny),
      },
      secret: startup.secret,
    };
  }
  const { script } = readModelScript(opts.model.path);
  const runtime = createMockModelRuntime(script, opts.seed);
  return {
    source: {
      task: readLiveTask(opts.taskPath, opts.feedback),
      client: runtime.client,
      mode: 'script',
      config: null,
      script: runtime.script,
      limits: opts.limits,
    },
    secret: '',
  };
}

/**
 * 装配 massing host 的依赖（关键）：真建模执行 + 真三视图 / contact 渲染，注入 Chrome 路径；
 * script 模式把剧本元数据带进子 `run.start.script`。缺任一必需项宿主会回 no-host，这里一次给全。
 */
function buildMassingDeps(
  opts: AgentMassingOptions,
  modelPrechecker: Prechecker,
  modelRunner: ModelRunner,
  git: GitSnapshot,
  script: MassingSource['script'],
  seedDocuments: readonly MassingDocumentAsset[],
): NonNullable<RunnerDeps['massing']> {
  return {
    seedDocuments,
    execute: (code, options) => modelRunner.runCode(code, options),
    render: (document, options) =>
      renderModelViews(document, {
        chromePath: opts.chromePath,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }),
    renderContact: (document, options) =>
      renderModelContact(document, {
        chromePath: opts.chromePath,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }),
    versions: (childStore) => modelExternalVersions(childStore, modelPrechecker.version, git),
    modeling: { modelingApi: MODELING_API, modelFormat: MODEL_VERSION },
    ...(script === undefined ? {} : { script }),
  };
}

/**
 * 跑一次 run。参数 / 配置 / 确认 / 读文件错误返回 2；运行失败返回 1；交付 0。
 * 真依赖在成功解析 source 之后才建；`finally` 里按创建顺序关闭渲染器、预检器与建模 runner。
 */
export async function runAgentMassing(
  argv: readonly string[],
  io: AgentMassingIo,
  overrides: AgentMassingOverrides = {},
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(AGENT_MASSING_USAGE);
    return 0;
  }

  let opts: AgentMassingOptions;
  try {
    opts = parseAgentMassingArgs(argv);
  } catch (error) {
    if (error instanceof MassingArgError) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }

  // 参数已解析完，才碰配置 / 剧本：无效参数不会触发 loadConfig 或网络。
  let source: MassingSource;
  let secret = '';
  let gates: GateConfig | undefined;
  let seedCode: string | undefined;
  let seedAssets: z.infer<typeof seedAssetsSchema> = [];
  let seedBytes: number;
  try {
    if (opts.seedAssetsPath !== undefined && opts.seedCodePath === undefined)
      throw new Error('种子草模资产需要同时给 --seed-code');
    if (opts.gatesPath !== undefined) gates = gatesSchema.parse(JSON.parse(readFileSync(opts.gatesPath, 'utf8')));
    if (opts.seedCodePath !== undefined) seedCode = readFileSync(opts.seedCodePath, 'utf8');
    if (opts.seedAssetsPath !== undefined)
      seedAssets = seedAssetsSchema.parse(JSON.parse(readFileSync(opts.seedAssetsPath, 'utf8')));
    if (seedCode !== undefined && (seedCode.trim() === '' || Buffer.byteLength(seedCode) > 256 * 1024))
      throw new Error('种子代码为空或超过 256 KiB');
    seedBytes = seedAssetBytes(seedAssets);
    if (opts.model.kind === 'live' && !opts.withoutMassing && seedAssets.length === MAX_ASSET_DOCUMENTS)
      throw new Error(
        `种子资产已占满 ${String(MAX_ASSET_DOCUMENTS)} 份，无新生成余量，拒绝启动带草模 host 的 live 运行；` +
          '请减少种子资产，或使用 --without-massing。',
      );
    const resolved = resolveSource(opts, overrides);
    source = resolved.source;
    secret = resolved.secret;
  } catch (error) {
    io.stderr(redactSecret(error instanceof Error ? error.message : String(error), secret));
    return 2;
  }

  // 真依赖：与 cli.ts 同款的体素 target（真预检 + 真 bwrap 执行 + registry），并接上草模 host。
  const registry = loadRegistry();
  const worldDts = loadWorldDts();
  const prechecker = createPrechecker(worldDts);
  const renderer = createRenderer(registry, { chromePath: opts.chromePath });
  const modelPrechecker = createModelPrechecker();
  const modelRunner = createModelRunner();
  const git = gitSnapshot();
  const store = createRunDir(opts.outDir, massingRunId(opts.taskPath, new Date()));

  try {
    // 固定规范化输入与种子代码；fed 只追加引用，使 run.start 绑定输入而不向模型塞入 JSON 正文。
    const seedCodeRef = seedCode === undefined ? null : store.putBlob(Buffer.from(seedCode, 'utf8'));
    const experiment = canonicalJson({
      gates: gates ?? null,
      seedAssets,
      seedCode: seedCodeRef,
      withoutMassing: opts.withoutMassing,
    });
    const experimentRef = store.putBlob(Buffer.from(experiment, 'utf8'));
    writeFileSync(join(store.dir, 'experiment-input.json'), experiment);
    writeFileSync(
      join(store.dir, 'experiment-input.manifest.json'),
      canonicalJson({ input: experimentRef, seedCode: seedCodeRef }),
    );
    source = {
      ...source,
      task: {
        ...source.task,
        fed:
          `${source.task.fed.trimEnd()}\n\n` +
          `实验输入：experiment-input.json，sha256 ${experimentRef.sha256}，bytes ${String(experimentRef.bytes)}。\n` +
          `种子草模资产 ${String(seedAssets.length)} 份；剩余文档容量 ${String(MAX_ASSET_DOCUMENTS - seedAssets.length)} 份，` +
          `剩余文档总字节容量 ${String(MAX_ASSETS_TOTAL_BYTES - seedBytes)} 字节，单文档上限 ${String(MAX_ASSET_DOCUMENT_BYTES)} 字节。\n` +
          (opts.withoutMassing
            ? '本运行未接入草模 host。\n'
            : '新增草模文档会累计占用容量，不会自动替换旧文档；容量已满时拒绝新子运行，交付超额时拒绝登记并结算已花费用。\n'),
      },
    };
    const versions: ExternalVersions = voxelExternalVersions(store, prechecker.version, git, worldDts);
    const deps: RunnerDeps = {
      client: source.client,
      store,
      check: {
        prechecker,
        registry,
        ...(gates === undefined ? {} : { gates }),
        runCode: (request) =>
          runCode(
            seedAssets.length === 0
              ? request
              : {
                  ...request,
                  assets: {
                    documents: [...seedAssets, ...(request.assets?.documents ?? [])],
                    colorCandidates: request.assets?.colorCandidates ?? colorCandidates(registry),
                  },
                },
          ),
      },
      render: (archive, request) => renderer.render(archive, request),
      worldDts,
      clock: overrides.clock ?? realClock,
      sleep: overrides.sleep ?? realSleep,
      versions,
      countTokens: overrides.countTokens ?? estimateTokens,
      ...(opts.withoutMassing
        ? {}
        : { massing: buildMassingDeps(opts, modelPrechecker, modelRunner, git, source.script, seedAssets) }),
    };
    const input: RunnerInput = {
      task: source.task,
      seed: opts.seed,
      limits: source.limits,
      mode: source.mode,
      variant: opts.promptVariant,
      config: source.config,
      ...(seedCode === undefined ? {} : { initialDraft: { code: seedCode } }),
      ...(source.script === undefined ? {} : { script: source.script }),
    };
    const outcome = await runRun(input, deps);
    return report(outcome, io, opts.model, opts.withoutMassing);
  } catch (error) {
    // runner 已尽力收尾（internal-error）；这里给出可读错误与 run 目录，退出码 1。
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    io.stderr(redactSecret(`运行失败：${message}`, secret));
    io.stderr(`run 目录: ${store.dir}`);
    return 1;
  } finally {
    await renderer.close();
    await prechecker.close();
    await modelRunner.close();
    await modelPrechecker.close();
  }
}

function createDefaultIo(): AgentMassingIo {
  return {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

/** 直接执行入口：把不可预期异常收成退出码 1，不让栈信息成为唯一输出。 */
export async function main(
  argv: readonly string[],
  io: AgentMassingIo = createDefaultIo(),
  overrides: AgentMassingOverrides = {},
): Promise<number> {
  try {
    return await runAgentMassing(argv, io, overrides);
  } catch (error) {
    io.stderr(`运行失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
