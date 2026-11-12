/**
 * `agent:massing` 的参数解析（M5b，决策 #112）：纯函数，输入 argv 输出 {@link AgentMassingOptions}，
 * 不读文件、不读环境变量、不 exit。
 *
 * 负责：识别题面路径与 `--mock` / `--live` / `--seed` / `--max-cny` / `--out` / `--prompt-variant` / `--chrome`，
 *   校验模型来源恰好一个、单次上限 ≤ 3.5、题面路径不在 `/sealed/`、`--live` 显式给预算与输出目录，并给中文报错。
 * 不负责：读题目 / 剧本、组装依赖、loadConfig、prints 与退出码（agent-massing.ts / agent-massing-deps.ts）。
 *
 * 与 `packages/agent/src/cli-args.ts` 同口径：该模块未在 `@pg/agent` 的 exports 里，
 * 故此处分层保留一份（改一处要同步另一处），只保留本入口用得到的选项。
 */

import type { PromptVariant } from '@pg/agent/prompt/system';
import { assertTaskPath } from '@pg/agent/task-body';
import type { RunLimits } from '@pg/store/events';
import { DEFAULT_CHROME_PATH } from '@pg/web/model-render';

/** 单次 run 花费的硬上限（人民币）；与 `@pg/agent/cli-args` 的 `MAX_RUN_CNY` 同值（AGENT-SPEC §11）。 */
export const MAX_RUN_CNY = 3.5;
/** 单次 run 默认墙钟上限 40 分钟（AGENT-SPEC §2 缺省）。 */
export const DEFAULT_WALL_MS = 2_400_000;
/** 默认轮数：不限轮数（决策 #87）。`null` 表示不设轮数上限。 */
export const DEFAULT_MAX_TURNS: number | null = null;
/** 默认提交窗口轮数（AGENT-SPEC §2 缺省）。 */
export const DEFAULT_SUBMIT_WINDOW = 3;
/** 默认 run 目录根（AGENT-SPEC §9；`.work/` 不入库）。 */
export const DEFAULT_OUT_DIR = '.work/runs/';
/** 与 `@pg/agent/cli-args` 的 `PROMPT_VARIANTS` 同口径（决策 #84、分段实验、两层实验）。 */
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

/** 模型来源两种写法：`--mock`（离线剧本）或 `--live`（真实模型，需 owner 授权）。 */
export type MassingModelSource = { readonly kind: 'script'; readonly path: string } | { readonly kind: 'live' };

export interface AgentMassingOptions {
  /** 题面文件路径（原文件；喂入正文由 readLiveTask / extractTaskBody 截取）。 */
  readonly taskPath: string;
  readonly seed: number;
  /** 单次 run 花费上限；`--live` 必须显式给，`--mock` 缺省 3.5。 */
  readonly maxCny: number;
  /** run 目录根；`--live` 必须显式给，`--mock` 缺省 `.work/runs/`。 */
  readonly outDir: string;
  /** system 提示变体（决策 #84），缺省 base。 */
  readonly promptVariant: PromptVariant;
  /** 本机 Chrome 路径（体素渲染与草模三视图 / contact 图共用）。 */
  readonly chromePath: string;
  readonly model: MassingModelSource;
  readonly limits: RunLimits;
  readonly gatesPath?: string;
  readonly feedback?: string;
  readonly seedCodePath?: string;
  readonly seedAssetsPath?: string;
  readonly withoutMassing: boolean;
}

/** 参数错误的专用类型：入口据此用退出码 2（AGENT-SPEC §9）。 */
export class MassingArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MassingArgError';
  }
}

export const AGENT_MASSING_USAGE = `用法：node tools/agent-massing.ts <题面.md> --mock <剧本.json> [选项]
      node tools/agent-massing.ts <题面.md> --live --max-cny <num> --out <dir> [选项]
  离线演练：--mock 剧本驱动父 / 子两次请求，真实 bwrap 执行与真实 Chrome 渲染，不发真实模型请求、不读环境。
  真实模型：--live 只跑一次 run，需 PG_LIVE_CONFIRM=1 且模型在价格表；只由 owner 逐批授权。
  --mock / --live 二者恰好一个（本项目入口不做 replay）。
  --seed <int>        沙箱 rng 种子，0–4294967295（默认 0）
  --max-cny <num>     单次 run 花费上限，0 < x ≤ ${String(MAX_RUN_CNY)}（--mock 默认 ${String(MAX_RUN_CNY)}；--live 必填）
  --out <dir>         run 目录根（--mock 默认 ${DEFAULT_OUT_DIR}；--live 必填）
  --prompt-variant <${PROMPT_VARIANTS.join('|')}>
                      system 提示变体（默认 base；craft-small 面向 1–3 层小体量与室内）
  --chrome <path>     Chrome 路径（默认 ${DEFAULT_CHROME_PATH}）
  --gates <path>      检查与提交条件 JSON
  --feedback <text>   追加本次实验指令或修改反馈
  --seed-code <path>  以已有体素代码开启新的运行
  --seed-assets <path> 旧稿所用草模资产 JSON（id 不得使用 massing# 前缀）
  --without-massing  不接草模宿主，使用直接构件组
  --mock <剧本.json>  用剧本 fetch 跑（离线，生成真实 SSE 字节流）
  --live              真实模型调用（需 PG_LLM_* 配置与 PG_LIVE_CONFIRM=1）`;

interface Pending {
  taskPath: string | null;
  seed: number;
  maxCny: number | null;
  outDir: string | null;
  promptVariant: PromptVariant;
  chromePath: string;
  mock: string | null;
  live: boolean;
  gatesPath?: string;
  feedback?: string;
  seedCodePath?: string;
  seedAssetsPath?: string;
  withoutMassing: boolean;
}

/** 取下一个参数，缺少时报参数错误。 */
function value(args: readonly string[], index: number, flag: string): string {
  const v = args[index + 1];
  if (v === undefined || v === '' || v.startsWith('--')) {
    throw new MassingArgError(`${flag} 缺少取值。\n${AGENT_MASSING_USAGE}`);
  }
  return v;
}

function parseSeed(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new MassingArgError(`--seed 应为 0–4294967295 的整数，实际是 ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n > 2 ** 32 - 1) throw new MassingArgError(`--seed 超出范围（最大 4294967295）：${raw}`);
  return n;
}

function parseMaxCny(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new MassingArgError(`--max-cny 应为 0 到 ${String(MAX_RUN_CNY)} 之间的数，实际是 ${JSON.stringify(raw)}`);
  }
  if (n > MAX_RUN_CNY) {
    throw new MassingArgError(`--max-cny 不得超过 ${String(MAX_RUN_CNY)}（AGENT-SPEC §11 的单次上限），实际是 ${raw}`);
  }
  return n;
}

function parsePromptVariant(raw: string): PromptVariant {
  if (!(PROMPT_VARIANTS as readonly string[]).includes(raw)) {
    throw new MassingArgError(`--prompt-variant 只能是 ${PROMPT_VARIANTS.join('、')}，实际是 ${JSON.stringify(raw)}`);
  }
  return raw as PromptVariant;
}

/** 解析 argv（不含 node 与脚本路径）。参数错误抛 {@link MassingArgError}。 */
export function parseAgentMassingArgs(argv: readonly string[]): AgentMassingOptions {
  const p: Pending = {
    taskPath: null,
    seed: 0,
    maxCny: null,
    outDir: null,
    promptVariant: 'base',
    chromePath: DEFAULT_CHROME_PATH,
    mock: null,
    live: false,
    withoutMassing: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--gates':
        p.gatesPath = value(argv, i++, '--gates');
        break;
      case '--feedback':
        p.feedback = value(argv, i++, '--feedback');
        break;
      case '--seed-code':
        p.seedCodePath = value(argv, i++, '--seed-code');
        break;
      case '--seed-assets':
        p.seedAssetsPath = value(argv, i++, '--seed-assets');
        break;
      case '--without-massing':
        p.withoutMassing = true;
        break;
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
      case '--chrome':
        p.chromePath = value(argv, i, '--chrome');
        i += 1;
        break;
      case '--mock':
        p.mock = value(argv, i, '--mock');
        i += 1;
        break;
      case '--live':
        p.live = true;
        break;
      default:
        if (arg.startsWith('-')) throw new MassingArgError(`不认识的参数 ${arg}。\n${AGENT_MASSING_USAGE}`);
        if (p.taskPath !== null)
          throw new MassingArgError(`只接受一个题面路径，多给了 ${arg}。\n${AGENT_MASSING_USAGE}`);
        p.taskPath = arg;
    }
  }

  if (p.taskPath === null) throw new MassingArgError(`缺少题面文件路径。\n${AGENT_MASSING_USAGE}`);
  try {
    assertTaskPath(p.taskPath);
  } catch (error) {
    throw new MassingArgError(error instanceof Error ? error.message : String(error));
  }

  const chosen = (p.mock === null ? 0 : 1) + (p.live ? 1 : 0);
  if (chosen !== 1) {
    throw new MassingArgError(
      `--mock、--live 必须恰好给一个（现在给了 ${String(chosen)} 个）。\n${AGENT_MASSING_USAGE}`,
    );
  }
  if (p.live) {
    if (p.maxCny === null)
      throw new MassingArgError(`--live 必须给 --max-cny（没有默认预算）。\n${AGENT_MASSING_USAGE}`);
    if (p.outDir === null)
      throw new MassingArgError(`--live 必须给 --out <dir>（没有默认输出目录）。\n${AGENT_MASSING_USAGE}`);
  }

  const maxCny = p.maxCny ?? MAX_RUN_CNY;
  const model: MassingModelSource = p.live ? { kind: 'live' } : { kind: 'script', path: p.mock ?? '' };
  return {
    taskPath: p.taskPath,
    seed: p.seed,
    maxCny,
    outDir: p.outDir ?? DEFAULT_OUT_DIR,
    promptVariant: p.promptVariant,
    chromePath: p.chromePath,
    model,
    withoutMassing: p.withoutMassing,
    ...(p.gatesPath === undefined ? {} : { gatesPath: p.gatesPath }),
    ...(p.feedback === undefined ? {} : { feedback: p.feedback }),
    ...(p.seedCodePath === undefined ? {} : { seedCodePath: p.seedCodePath }),
    ...(p.seedAssetsPath === undefined ? {} : { seedAssetsPath: p.seedAssetsPath }),
    limits: {
      maxCostCny: maxCny,
      maxTurns: DEFAULT_MAX_TURNS,
      wallMs: DEFAULT_WALL_MS,
      submitWindow: DEFAULT_SUBMIT_WINDOW,
    },
  };
}
