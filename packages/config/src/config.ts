/**
 * 运行配置：v0.3beta 唯一读取环境变量的地方。
 *
 * 规则（见 docs/STANDARDS.md §6）：
 * - 只认 `PG_` 前缀；其他包一律通过参数拿到 {@link Config}，不直接读 `process.env`。
 * - 非法值响亮报错，并一次列出全部问题；不静默回退到默认值。
 * - 报错信息不回显密钥。
 */

import { z } from 'zod';

export const DEFAULTS = {
  model: 'deepseek-flash',
  // v0.2 默认 120s 时真实调用超时，改为 600s 起（v02:PITFALLS.md:184）。
  timeoutMs: 600_000,
  // v0.2 按全量台账复算：2.5 会拦掉真实交付的 ¥2.94 run，故取 3.5（v02:docs/LESSONS.md §11.13）。
  maxRunCostCny: 3.5,
  // W11-02：施工提示词默认仍是 v1；v2 先作为 opt-in，live 验证后再由 owner 切默认。
  promptVersion: 'v1',
} as const;

/** 可选的施工提示词版本；`v1` 是冻结基线，`v2` 是 W11-02 五层重写。 */
export const PROMPT_VERSIONS = ['v1', 'v2'] as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

/** 空白字符串视为未设置。 */
const optionalText = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim();
    return t === undefined || t === '' ? undefined : t;
  });

function numberFrom(key: string, fallback: number, rule: { integer: boolean; min: number; max: number }) {
  const kind = rule.integer ? '整数' : '数';
  return optionalText.transform((raw, ctx) => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    const ok =
      Number.isFinite(value) && (!rule.integer || Number.isInteger(value)) && value >= rule.min && value <= rule.max;
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        message: `${key} 应为 ${String(rule.min)}–${String(rule.max)} 的${kind}，实际是 ${JSON.stringify(raw)}`,
      });
      return z.NEVER;
    }
    return value;
  });
}

/**
 * `--live` 的第二道确认（AGENT-SPEC §11）：必须显式设成 `1`。
 * 只有真正发起真实模型调用的路径才会读它；空字符串 / 未设置都视为未确认，其它值报错。
 */
const liveConfirm = optionalText.transform((raw, ctx) => {
  if (raw === undefined) return false;
  if (raw !== '1') {
    ctx.addIssue({ code: 'custom', message: `PG_LIVE_CONFIRM 只能是 "1"，实际是 ${JSON.stringify(raw)}` });
    return z.NEVER;
  }
  return true;
});

const promptVersion = optionalText.transform((raw, ctx): PromptVersion => {
  if (raw === undefined) return DEFAULTS.promptVersion;
  if (raw === 'v1' || raw === 'v2') return raw;
  ctx.addIssue({
    code: 'custom',
    message: `PG_PROMPT_VERSION 只能是 ${PROMPT_VERSIONS.join(' 或 ')}，实际是 ${JSON.stringify(raw)}`,
  });
  return z.NEVER;
});

const baseUrl = optionalText.transform((raw, ctx) => {
  if (raw === undefined) {
    ctx.addIssue({ code: 'custom', message: 'PG_LLM_BASE_URL 未设置' });
    return z.NEVER;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    ctx.addIssue({ code: 'custom', message: `PG_LLM_BASE_URL 不是合法 URL：${JSON.stringify(raw)}` });
    return z.NEVER;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    ctx.addIssue({ code: 'custom', message: `PG_LLM_BASE_URL 只支持 http/https，实际是 ${url.protocol}` });
    return z.NEVER;
  }
  return raw.replace(/\/+$/, '');
});

const EnvSchema = z
  .object({
    PG_LLM_BASE_URL: baseUrl,
    PG_LLM_API_KEY: optionalText,
    PG_LLM_MODEL: optionalText,
    // 上限是 setTimeout 能接受的最大值（2³¹−1 ms）；超过会被 Node 静默改成 1ms。
    PG_LLM_TIMEOUT_MS: numberFrom('PG_LLM_TIMEOUT_MS', DEFAULTS.timeoutMs, {
      integer: true,
      min: 1,
      max: 2_147_483_647,
    }),
    PG_MAX_RUN_COST_CNY: numberFrom('PG_MAX_RUN_COST_CNY', DEFAULTS.maxRunCostCny, {
      integer: false,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    PG_LIVE_CONFIRM: liveConfirm,
    PG_PROMPT_VERSION: promptVersion,
  })
  .transform((env) => ({
    llm: {
      baseUrl: env.PG_LLM_BASE_URL,
      apiKey: env.PG_LLM_API_KEY ?? '',
      model: env.PG_LLM_MODEL ?? DEFAULTS.model,
      timeoutMs: env.PG_LLM_TIMEOUT_MS,
    },
    maxRunCostCny: env.PG_MAX_RUN_COST_CNY,
    /** 施工提示词版本：`v1`（默认，冻结）/ `v2`（W11-02 opt-in）。 */
    promptVersion: env.PG_PROMPT_VERSION,
    /** `--live` 是否已由 owner 双重确认（AGENT-SPEC §11）。 */
    liveConfirm: env.PG_LIVE_CONFIRM,
  }));

/**
 * 运行配置。
 * - `llm.baseUrl`：OpenAI 兼容接口根地址，不含末尾斜杠。
 * - `llm.apiKey`：空字符串表示未配置；离线路径不需要它。
 * - `maxRunCostCny`：单次 run 花费上限（人民币）；0 表示关闭护栏。
 * - `promptVersion`：施工提示词版本，缺省 `v1`；`PG_PROMPT_VERSION=v2` 为 opt-in。
 * - `liveConfirm`：是否设置 `PG_LIVE_CONFIRM=1`；只有 `--live` 用得到。
 */
type ParsedConfig = z.output<typeof EnvSchema>;
/**
 * `promptVersion` 在运行时必定有值（默认 v1），但类型上保持可选：一批离线工具测试用手写
 * Config 对象构造依赖，不需要为了新增开关逐个补字段。需要读取时应按 `?? 'v1'` 处理。
 */
export type Config = Readonly<Omit<ParsedConfig, 'promptVersion'> & { readonly promptVersion?: PromptVersion }>;

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`配置无效：\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** 认识的全部 `PG_` 变量。 */
export const KNOWN_KEYS: readonly string[] = Object.keys(EnvSchema.in.shape);

/**
 * 从环境变量构造配置。传入 `process.env` 或测试用的普通对象。
 * 拼错的 `PG_` 变量（如 `PG_LLM_MODLE`）会报错，而不是被静默忽略、悄悄用默认值。
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const unknown = Object.keys(env)
    .filter((k) => k.startsWith('PG_') && !KNOWN_KEYS.includes(k))
    .sort()
    .map((k) => `不认识的环境变量 ${k}（可用：${KNOWN_KEYS.join('、')}）`);
  const result = EnvSchema.safeParse(env);
  const problems = [...unknown, ...(result.success ? [] : result.error.issues.map((issue) => issue.message))];
  if (problems.length > 0 || !result.success) throw new ConfigError(problems);
  return result.data;
}

/**
 * 从真实 `process.env` 构造配置。只有 `@pg/config` 能读环境变量，所以入口（CLI）走这个包装，
 * 而不是在别处写 `loadConfig(process.env)`。
 */
export function loadConfigFromProcess(): Config {
  return loadConfig(process.env);
}
