/**
 * CLI 参数解析（AGENT-SPEC §9、§11）：纯函数，输入 argv 输出 {@link CliOptions}，不读文件、不读环境变量、不 exit。
 *
 * 负责：识别题面路径与 --seed / --max-cny / --out / --prompt-variant / --mock / --replay / --live，
 *   校验三者恰好一个、单次上限 ≤ 3.5、题面路径不在 /sealed/，并给出中文报错（直接指导怎么改）。
 * 不负责：读题目 / 剧本 / 回放目录、组装依赖、loadConfig、prints 与退出码（cli.ts / cli-deps.ts）。
 */

import type { RunLimits } from '@pg/store/events';

import type { PromptVariant } from './prompt/system.ts';
import { assertTaskPath } from './task-body.ts';

/** 单次 run 花费的硬上限（人民币）；AGENT-SPEC §2 缺省值与 §8 批次上限都用它。 */
export const MAX_RUN_CNY = 3.5;
/** 单次 run 默认墙钟上限 40 分钟（AGENT-SPEC §2 缺省）。 */
export const DEFAULT_WALL_MS = 2_400_000;
/** 默认轮数：不限轮数（决策 #87，对齐 v0.2）。`null` 表示不设轮数上限。 */
export const DEFAULT_MAX_TURNS: number | null = null;
/** 默认提交窗口轮数（AGENT-SPEC §2 缺省）。 */
export const DEFAULT_SUBMIT_WINDOW = 3;
/** 默认 run 目录根（AGENT-SPEC §9；`.work/` 不入库）。 */
export const DEFAULT_OUT_DIR = '.work/runs/';
/** 模型来源三种写法（AGENT-SPEC §2 的 model 判别联合）。 */
export const MODEL_FLAGS = ['--mock', '--replay', '--live'] as const;
/** 提示变体写法（决策 #84 及对照实验与分段实验）：base 只放约定段，craft 另附做法提示与范例，craft2 换 §3 表面装饰段，craft-small 面向 1–3 层小体量与室内，v02hint 附 v0.2 删减稿；skeleton / detail 是分段实验的骨架段与细部段；blueprint / refine 是两层实验的骨架层与细化层。 */
export const PROMPT_VARIANTS = [
  'base',
  'craft',
  'v02hint',
  'craft2',
  'craft-small',
  'skeleton',
  'detail',
  'blueprint',
  'refine',
] as const;

export type ModelSource =
  | { readonly kind: 'script'; readonly path: string }
  | { readonly kind: 'replay'; readonly runDir: string }
  | { readonly kind: 'live' };

export interface CliOptions {
  /** 题面文件路径（原文件，喂入正文由 extractTaskBody 截取）。 */
  readonly taskPath: string;
  readonly seed: number;
  readonly maxCny: number;
  readonly outDir: string;
  /** system 提示变体（决策 #84），缺省 base。 */
  readonly promptVariant: PromptVariant;
  /** 种子稿路径：`--seed-code <path>` 给出时，当前稿第 1 版即为该文件内容（分段实验第 2 段）。 */
  readonly seedCode?: string | undefined;
  /** 骨架门槛配置 JSON（决策 #94，AGENT-SPEC §5.1）；缺省不做门槛判定。 */
  readonly gatesPath?: string | undefined;
  /** `--require-design`：要求先写设计文档才能 submit（两层实验，AGENT-SPEC §4.5）。 */
  readonly requireDesign: boolean;
  /** `--seed-design <path>`：上一阶段交付的骨架设计文档（两层实验第 2 层）。 */
  readonly seedDesign?: string | undefined;
  /** `--seed-images <dir>`：上一阶段交付的骨架渲染图目录（按固定顺序取存在的图）。 */
  readonly seedImages?: string | undefined;
  readonly model: ModelSource;
  readonly limits: RunLimits;
}

/** 参数错误的专用类型：入口据此用退出码 2（AGENT-SPEC §9）。 */
export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgError';
  }
}

export const USAGE = `用法：node packages/agent/src/cli.ts <题面.md> [选项]
  --seed <int>        沙箱 rng 种子，0–4294967295（默认 0）
  --max-cny <num>     单次 run 花费上限，0 < x ≤ ${String(MAX_RUN_CNY)}（默认 ${String(MAX_RUN_CNY)}）
  --out <dir>         run 目录根（默认 ${DEFAULT_OUT_DIR}）
  --prompt-variant <${PROMPT_VARIANTS.join('|')}>
                      system 提示变体（默认 base；craft 另附形态方块做法提示与范例，决策 #84；craft2 在 craft 基础上换 §3 表面装饰段；craft-small 面向 1–3 层小体量，附尺度、室内家具与状态写法；v02hint 附 v0.2 删减稿；skeleton 只搭体量骨架、detail 在 craft 上叠加"骨架冻结只加细部"，两者用于分段实验；blueprint 先写设计文档再搭骨架、refine 先写自己的细化设计文档再细化，两者用于两层实验）
  --seed-code <path>  从已有代码文件开始当前稿（分段实验第 2 段用；第 1 版即为该文件内容）
  --gates <path>      骨架门槛配置 JSON（决策 #94；见 AGENT-SPEC §5.1）
  --require-design    要求先 write_design 才能 submit（两层实验骨架层用）
  --seed-design <path> 上一阶段交付的骨架设计文档（两层实验细化层用）
  --seed-images <dir> 上一阶段交付的骨架渲染图目录（按 iso-se、top、south、north 找存在的图）
  --mock <剧本.json>  用剧本 fetch 跑（离线，生成真实 SSE 字节流）
  --replay <run 目录> strict 回放已有 run
  --live              真实模型调用（需 PG_LLM_* 配置与 PG_LIVE_CONFIRM=1）
  --mock / --replay / --live 三者恰好一个。`;

interface Pending {
  taskPath: string | null;
  seed: number;
  maxCny: number;
  outDir: string;
  promptVariant: PromptVariant;
  seedCode: string | null;
  gatesPath: string | null;
  requireDesign: boolean;
  seedDesign: string | null;
  seedImages: string | null;
  mock: string | null;
  replay: string | null;
  live: boolean;
}

/** 取下一个参数，缺少时报参数错误。 */
function value(args: readonly string[], index: number, flag: string): string {
  const v = args[index + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new CliArgError(`${flag} 缺少取值。\n${USAGE}`);
  }
  return v;
}

function parseSeed(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new CliArgError(`--seed 应为 0–4294967295 的整数，实际是 ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n > 2 ** 32 - 1) throw new CliArgError(`--seed 超出范围（最大 4294967295）：${raw}`);
  return n;
}

function parseMaxCny(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliArgError(`--max-cny 应为 0 到 ${String(MAX_RUN_CNY)} 之间的数，实际是 ${JSON.stringify(raw)}`);
  }
  if (n > MAX_RUN_CNY) {
    throw new CliArgError(`--max-cny 不得超过 ${String(MAX_RUN_CNY)}（AGENT-SPEC §11 的单次上限），实际是 ${raw}`);
  }
  return n;
}

function parsePromptVariant(raw: string): PromptVariant {
  if (!(PROMPT_VARIANTS as readonly string[]).includes(raw)) {
    throw new CliArgError(`--prompt-variant 只能是 ${PROMPT_VARIANTS.join('、')}，实际是 ${JSON.stringify(raw)}`);
  }
  return raw as PromptVariant;
}

/** 解析 argv（不含 node 与脚本路径）。参数错误抛 {@link CliArgError}。 */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const p: Pending = {
    taskPath: null,
    seed: 0,
    maxCny: MAX_RUN_CNY,
    outDir: DEFAULT_OUT_DIR,
    promptVariant: 'base',
    seedCode: null,
    gatesPath: null,
    requireDesign: false,
    seedDesign: null,
    seedImages: null,
    mock: null,
    replay: null,
    live: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--seed':
        p.seed = parseSeed(value(argv, i, '--seed'));
        i += 1;
        break;
      case '--max-cny':
        p.maxCny = parseMaxCny(value(argv, i, '--max-cny'));
        i += 1;
        break;
      case '--out':
        p.outDir = value(argv, i, '--out');
        i += 1;
        break;
      case '--prompt-variant':
        p.promptVariant = parsePromptVariant(value(argv, i, '--prompt-variant'));
        i += 1;
        break;
      case '--seed-code':
        p.seedCode = value(argv, i, '--seed-code');
        i += 1;
        break;
      case '--gates':
        p.gatesPath = value(argv, i, '--gates');
        i += 1;
        break;
      case '--require-design':
        p.requireDesign = true;
        break;
      case '--seed-design':
        p.seedDesign = value(argv, i, '--seed-design');
        i += 1;
        break;
      case '--seed-images':
        p.seedImages = value(argv, i, '--seed-images');
        i += 1;
        break;
      case '--mock':
        p.mock = value(argv, i, '--mock');
        i += 1;
        break;
      case '--replay':
        p.replay = value(argv, i, '--replay');
        i += 1;
        break;
      case '--live':
        p.live = true;
        break;
      default:
        if (arg.startsWith('-')) throw new CliArgError(`不认识的参数 ${arg}。\n${USAGE}`);
        if (p.taskPath !== null) throw new CliArgError(`只接受一个题面路径，多给了 ${arg}。\n${USAGE}`);
        p.taskPath = arg;
    }
  }

  if (p.taskPath === null) throw new CliArgError(`缺少题面文件路径。\n${USAGE}`);
  try {
    assertTaskPath(p.taskPath);
  } catch (error) {
    throw new CliArgError(error instanceof Error ? error.message : String(error));
  }

  const chosen = (p.mock === null ? 0 : 1) + (p.replay === null ? 0 : 1) + (p.live ? 1 : 0);
  if (chosen !== 1) {
    throw new CliArgError(`--mock、--replay、--live 必须恰好给一个（现在给了 ${String(chosen)} 个）。\n${USAGE}`);
  }
  const model: ModelSource = p.live
    ? { kind: 'live' }
    : p.mock !== null
      ? { kind: 'script', path: p.mock }
      : { kind: 'replay', runDir: p.replay ?? '' };

  return {
    taskPath: p.taskPath,
    seed: p.seed,
    maxCny: p.maxCny,
    outDir: p.outDir,
    promptVariant: p.promptVariant,
    ...(p.seedCode === null ? {} : { seedCode: p.seedCode }),
    ...(p.gatesPath === null ? {} : { gatesPath: p.gatesPath }),
    requireDesign: p.requireDesign,
    ...(p.seedDesign === null ? {} : { seedDesign: p.seedDesign }),
    ...(p.seedImages === null ? {} : { seedImages: p.seedImages }),
    model,
    limits: {
      maxCostCny: p.maxCny,
      maxTurns: DEFAULT_MAX_TURNS,
      wallMs: DEFAULT_WALL_MS,
      submitWindow: DEFAULT_SUBMIT_WINDOW,
    },
  };
}

/**
 * 环境变量 `PG_MAX_RUN_COST_CNY` 只能收紧 `--max-cny`，不能放宽：
 * 更小时取它；未设、为 0（关闭护栏）或更大时保持命令行值。
 */
export function tightenLimits<T extends { readonly maxCostCny: number }>(limits: T, envMaxCny: number | undefined): T {
  if (envMaxCny === undefined || envMaxCny <= 0 || envMaxCny >= limits.maxCostCny) return limits;
  return { ...limits, maxCostCny: envMaxCny };
}
