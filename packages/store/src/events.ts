/**
 * 事件 schema（MODEL-SPEC §7.2、§7.3，C1/C7/C8）。
 *
 * 负责：定义事件信封、全部事件体、`RunLimits` / `StopReason` / `RenderVersion` / `PrecheckSummary` /
 * `RunSummary` / `Versions` 等 store 自有 schema，并提供按 type 校验信封 + body 的解析入口。
 * 不负责：写文件与 sha256（run-dir.ts / blobs.ts）、编排事件（agent 的 runner）、派生 trace（derive.ts）。
 *
 * `StopReason`、`RenderVersion`、`RunLimits` 定义在这里，agent 反向 import（MODEL-SPEC §2、C1）；
 * `sandbox` / `render` 的结果只以摘要 schema 进入事件，store 不依赖它们（C1）。
 * 本文件是纯函数：不做 I/O，不读全局可变状态。
 */

import { FinishReason, LlmFailure, Usage } from '@pg/llm/schema';
import { z } from 'zod';

/** 内容寻址引用：大对象只存 blob，事件里放这个（MODEL-SPEC §7.2）。 */
export const Ref = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.int().min(0),
});
export type Ref = z.infer<typeof Ref>;

/** 事件信封版本；改动事件形状时 +1（MODEL-SPEC §7.2）。 */
export const EVENTS_SCHEMA_VERSION = 1 as const;

/**
 * 记录层文本上限（2026-10-04 修复宿主崩溃）：预检诊断、build-error、submit reason 等来自模型 /
 * 编译器 / 渲染输出的字符串可能超长，超过 schema 上限会让 `append` 抛错、中断整个 run。
 * `clampEventBody` 在写入前截断到该上限；模型可见反馈另行从原始结果渲染，不受影响。
 */
export const EVENT_TEXT_MAX = 2000;

/** 交付注记由证据自动生成，可能列出全部 300 个 must；比模型自由文本上限更宽。 */
export const DELIVERY_NOTE_MAX = 60_000;

/** 截断标记：值被截断要在记录里显式标出（STANDARDS §4）。 */
export const TRUNCATION_MARK = '…（已截断）';

/** 把文本截到 `max` 个 UTF-16 码元并在末尾加标记；不超长则原样返回。纯函数。 */
export function truncateEventText(text: string, max: number = EVENT_TEXT_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
}

/** 一次 run 的护栏上限；与 AGENT-SPEC `RunInput.limits` 同一个 schema（C8）。 */
export const RunLimits = z.strictObject({
  maxCostCny: z.number().min(0),
  /** null 表示不限轮数（决策 #87，对齐 v0.2）；旧运行记录里的数字仍可解析。 */
  maxTurns: z.int().min(4).max(200).nullable(),
  wallMs: z.int().min(60_000),
  submitWindow: z.int().min(1).max(10),
});
export type RunLimits = z.infer<typeof RunLimits>;

/** 停止原因；派生 trace 时按 AGENT-SPEC §6.3 归类。 */
export const StopReason = z.enum([
  'cost-budget',
  'max-turns',
  'wall',
  'context-limit',
  'image-budget',
  'degenerate-loop',
  'stuck',
  'no-tool',
  'llm-error',
  'sandbox-unsupported',
  'internal-error',
  'cancelled',
]);
export type StopReason = z.infer<typeof StopReason>;

/** 浏览器组件版本；本 run 第一次启动浏览器后写一次（MODEL-SPEC §7.3、§7.5，C8）。 */
export const RenderAssets = z.strictObject({
  source: z.enum(['official', 'fallback']),
  mcVersion: z.string().nullable(),
  models: z.int().nonnegative(),
  coveredBlocks: z.int().nonnegative(),
  states: z.int().nonnegative(),
  textures: z.int().nonnegative(),
  reason: z.string().optional(),
});
export type RenderAssets = z.infer<typeof RenderAssets>;

export const RenderVersion = z.strictObject({
  protocol: z.int(),
  chrome: z.string(),
  puppeteer: z.string(),
  three: z.string(),
  flags: z.array(z.string()),
  webglRenderer: z.string(),
  cpuModel: z.string(),
  /** 官方资源状态；旧 run 没有这个字段（向后兼容）。 */
  assets: RenderAssets.optional(),
});
export type RenderVersion = z.infer<typeof RenderVersion>;

/** 预检摘要（C8）：sandbox 的 PrecheckResult 去掉逐条源码上下文，只留可读诊断。 */
export const PrecheckSummary = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ok') }),
  z.strictObject({
    kind: z.literal('failed'),
    total: z.int().min(1),
    diagnostics: z
      .array(
        z.strictObject({
          line: z.int(),
          column: z.int(),
          code: z.string(),
          message: z.string().max(EVENT_TEXT_MAX),
        }),
      )
      .max(20),
  }),
  z.strictObject({ kind: z.literal('too-large'), bytes: z.int(), limit: z.int() }),
  z.strictObject({ kind: z.literal('timeout'), limitMs: z.int() }),
  z.strictObject({ kind: z.literal('out-of-memory'), limitMiB: z.int() }),
]);
export type PrecheckSummary = z.infer<typeof PrecheckSummary>;

/** 执行摘要：sandbox 的 RunResult 去掉 grid 与存档字节（MODEL-SPEC §7.3）。 */
export const RunSummary = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ok'),
    hash: z.string(),
    cells: z.int(),
    bounds: z.tuple([z.int(), z.int(), z.int(), z.int(), z.int(), z.int()]),
    calls: z.int(),
    overlaps: z.strictObject({ sameLayer: z.int(), crossLayer: z.int() }),
    console: z.int(),
    wallMs: z.int(),
  }),
  z.strictObject({
    kind: z.literal('build-error'),
    error: z.strictObject({
      name: z.string().max(EVENT_TEXT_MAX),
      message: z.string().max(EVENT_TEXT_MAX),
      line: z.int(),
      column: z.int(),
    }),
    console: z.int(),
    wallMs: z.int(),
  }),
  z.strictObject({
    kind: z.enum(['timeout', 'out-of-memory', 'output-too-large', 'crashed']),
    stderrHead: z.string().max(2000),
    /**
     * 报告（调用记录）超过 1 MiB 上限、归 crashed 时的诊断数字（2026-10-04 新增可选字段）。
     * 旧记录没有该键，仍可解析；`calls` / `overlaps` 只在能读出报告时才有。
     */
    detail: z.optional(
      z.strictObject({
        reportBytes: z.int().min(0),
        limitBytes: z.int().min(0),
        calls: z.optional(z.int().min(0)),
        overlaps: z.optional(z.int().min(0)),
      }),
    ),
    wallMs: z.int(),
  }),
  z.strictObject({ kind: z.literal('too-large'), bytes: z.int(), limit: z.int() }),
  z.strictObject({
    kind: z.literal('assets-too-large'),
    reason: z.enum(['documents-count', 'document-bytes', 'total-bytes']),
    documents: z.int().min(0),
    bytes: z.int().min(0),
    limit: z.int().min(1),
  }),
]);
export type RunSummary = z.infer<typeof RunSummary>;

/** 组件版本（决策 #27、MODEL-SPEC §7.5）。渲染版本单独在 `versions.render` 事件里。 */
const SharedVersions = z.strictObject({
  git: z.strictObject({ commit: z.string(), dirty: z.boolean(), diff: z.nullable(Ref) }),
  node: z.string(),
  /**
   * 事件 schema 版本：2 是 M2 之前的记录，3 起支持 `subrun.result` 与 `run.start.parent`（决策 #115）。
   * 用 union 而不是只留 literal(3)：旧 run 的 `run.start` 仍要能解析（先例：决策 #93 的 1→2）。
   */
  eventsSchema: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  precheck: z.string(),
  sandbox: z.string(),
  tools: z.string(),
  prompt: z.string(),
  /** system 提示变体（决策 #84）：base 只放约定段，craft 另附做法提示与范例，craft2 换 DECOR-PLAN §3 表面装饰段，craft-small 面向 1–3 层小体量与室内，v02hint 附 v0.2 删减稿；skeleton / detail 是分段实验的骨架段与细部段；blueprint / refine 是两层实验的骨架层与细化层。旧 run 没有该键。 */
  promptVariant: z.optional(
    z.enum(['base', 'craft', 'v02hint', 'craft2', 'craft-small', 'skeleton', 'detail', 'blueprint', 'refine']),
  ),
  factsFormat: z.int(),
  model: z.enum(['deepseek-flash', 'gpt-6.1-sol']),
  pricing: z.string(),
  llmClient: z.int(),
});
/** 旧体素记录可缺 target；草模必须明确记录建模 API、声明和文档格式版本。 */
export const Versions = z.union([
  SharedVersions.extend({
    target: z.literal('voxel').optional(),
    worldApi: z.int(),
    worldDts: z.string(),
    archiveFormat: z.int(),
    analysis: z.string(),
  }),
  SharedVersions.extend({
    target: z.literal('modeling'),
    modelingApi: z.int().min(1),
    modelingDts: z.string(),
    modelFormat: z.int().min(1),
  }),
]);
export type Versions = z.infer<typeof Versions>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * 父 run 关联（子运行写；SUBAGENT-LOOP-SPEC §2.2）：`dir` 是父目录相对子目录（`../..`）。
 * optional 保证旧记录可解析（RunStartBody 保持 strict）。
 */
const RunStartParent = z.strictObject({
  runId: z.string().min(1),
  dir: z.string().min(1),
  callId: z.string().min(1),
  turn: z.int().min(1),
});

const RunStartBody = z.strictObject({
  task: z.strictObject({
    sha256: Sha256,
    source: z.nullable(z.string()),
    fedSha256: Sha256,
    fed: Ref,
  }),
  seed: z
    .int()
    .min(0)
    .max(2 ** 32 - 1),
  mode: z.enum(['live', 'script', 'replay']),
  replayOf: z.optional(z.string()),
  script: z.optional(z.strictObject({ name: z.string(), sha256: Sha256 })),
  parent: z.optional(RunStartParent),
  accounting: z.enum(['metered', 'unmetered']).optional(),
  limits: RunLimits,
  guardConstants: z.strictObject({
    imageBytesSoft: z.int().min(0),
    imageBytesHard: z.int().min(0),
    contextTokens: z.int().min(0),
    minMaxTokens: z.int().min(0),
  }),
  versions: Versions,
  config: z.nullable(z.strictObject({ baseUrl: z.string(), timeoutMs: z.int().min(1) })),
});

const PromptSystemBody = z.strictObject({
  system: Ref,
  tools: Ref,
  tokensOffline: z.strictObject({ system: z.int().min(0), tools: z.int().min(0) }),
});

const VersionsRenderBody = z.strictObject({ render: RenderVersion });

/** 轮开始：`elapsedMs` 是本轮唯一允许随时间变化的模型可见数字（C7）。 */
const TurnStartBody = z.strictObject({
  elapsedMs: z.int().min(0),
  spentCny: z.number().min(0),
});

const LlmRequestBody = z.strictObject({
  requestSha: Sha256,
  manifest: Ref,
  bodyBytes: z.int().min(0),
  messages: z.int().min(0),
  images: z.int().min(0),
  imageBytes: z.int().min(0),
  reserve: z.strictObject({
    cny: z.number().min(0).nullable(),
    maxTokens: z.int().min(0).nullable(),
    inputUpper: z.int().min(0).nullable(),
  }),
});

const LlmAttemptBody = z.strictObject({
  attempt: z.int().min(1),
  outcome: z.enum(['ok', 'retry', 'final-failure', 'aborted-by-caller', 'stopped-by-guard']),
  failure: z.nullable(LlmFailure),
  charge: z.enum(['usage', 'reserve', 'none', 'unmetered']),
  usage: z.nullable(Usage),
  delayMs: z.nullable(z.int().min(0)),
  timing: z.strictObject({ firstByteMs: z.nullable(z.int().min(0)), totalMs: z.int().min(0) }),
  settledCny: z.number().min(0).nullable(),
});

/** 一次尝试的结果；成功与调用方取消两种都能被回放（MODEL-SPEC §6.4、C8）。 */
const LlmResponseBody = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('ok'),
    response: Ref,
    finishReason: FinishReason,
    usage: Usage,
    cny: z.number().min(0).nullable(),
    model: z.string(),
    systemFingerprint: z.nullable(z.string()),
    timing: z.strictObject({
      firstByteMs: z.int().min(0),
      firstTokenMs: z.nullable(z.int().min(0)),
      totalMs: z.int().min(0),
    }),
    usageMismatch: z.boolean(),
    rawArguments: z.optional(Ref),
  }),
  z.strictObject({
    outcome: z.literal('aborted-by-caller'),
    reason: z.enum(['degenerate', 'wall', 'cancel']),
    partial: Ref,
    settledCny: z.number().min(0).nullable(),
  }),
]);

const ToolCallBody = z.strictObject({
  callId: z.string().min(1),
  name: z.string().min(1),
  arguments: Ref,
  parse: z.enum(['ok', 'invalid-json', 'invalid-args']),
});

/** 工具自己的结果分类，不用布尔 `ok`（v0.2 `ok=true` 漏报 diff 失败，`v02:docs/LESSONS.md` §3.4）。 */
const ToolResultBody = z.strictObject({
  callId: z.string().min(1),
  name: z.string().min(1),
  text: Ref,
  status: z.string().min(1),
  wallMs: z.int().min(0),
});

const CodeVersionBody = z.strictObject({
  version: z.int().min(1),
  code: Ref,
  via: z.enum(['write_code', 'edit_code', 'seed']),
  lines: z.int().min(0),
});

const CheckResultBody = z.strictObject({
  codeVersion: z.int().min(1),
  codeSha: Sha256,
  seed: z
    .int()
    .min(0)
    .max(2 ** 32 - 1),
  precheck: PrecheckSummary,
  run: z.nullable(RunSummary),
  archive: z.optional(Ref),
  apiCalls: z.optional(z.record(z.string(), z.int().min(0))),
});

const FactsBody = z.strictObject({ text: Ref, measures: Ref });

const RenderResultBody = z.strictObject({
  /** `massing`：构建层工具派出的草模子运行合成图（SUBAGENT-LOOP-SPEC §7.1）。 */
  purpose: z.enum(['iterate', 'deliver', 'massing']),
  kind: z.string().min(1).max(EVENT_TEXT_MAX),
  images: z.array(
    z.strictObject({
      view: z.string().min(1),
      png: Ref,
      pixelsPerCell: z.number().min(0),
      frameFill: z.number().min(0).max(1),
    }),
  ),
  wallMs: z.int().min(0),
});

const GuardBody = z.strictObject({
  name: z.string().min(1),
  action: z.enum(['warn', 'window', 'stop']),
  value: z.number(),
  limit: z.number(),
});

const SubmitBody = z.strictObject({
  callId: z.string().min(1),
  codeVersion: z.int().min(1),
  accepted: z.boolean(),
  reason: z.optional(z.string().max(EVENT_TEXT_MAX)),
});

const DeliveryBody = z.strictObject({
  code: Ref,
  archive: Ref,
  hash: z.string(),
  codeVersion: z.int().min(1),
  renders: z.array(z.strictObject({ view: z.string().min(1), png: Ref })),
  /** 本阶段设计文档（AGENT-SPEC §4.5）：非空才写。 */
  design: z.optional(Ref),
  /** 交付说明（§4.4）：生产路径由 conformance 证据生成；非空才写。 */
  note: z.optional(z.string().max(DELIVERY_NOTE_MAX)),
  /** `conformance-evidence` 表示 note 不是模型自述。 */
  noteSource: z.optional(z.literal('conformance-evidence')),
  renderMissing: z.optional(z.string().max(EVENT_TEXT_MAX)),
});

/**
 * 父侧记录一次 massing 调用的子运行结果（SUBAGENT-LOOP-SPEC §7.1）：
 * `text` / `image` 供回放按 callId 重建工具结果与图片块，不重跑子运行；
 * `code` / `document` 是父 run blobs 里的引用（回放读回源码与文档），失败状态一律不写。
 */
const SubrunResultBody = z.strictObject({
  runId: z.string().min(1),
  dir: z.string().min(1),
  callId: z.string().min(1),
  ordinal: z.int().min(1),
  status: z.enum(['success', 'failed', 'aborted', 'rejected']),
  reason: z.optional(z.string().max(EVENT_TEXT_MAX)),
  stopReason: z.optional(StopReason),
  reservedCny: z.number().min(0),
  costCny: z.number().min(0),
  turns: z.int().min(0),
  code: z.optional(Ref),
  document: z.optional(Ref),
  documentHash: z.optional(Sha256),
  text: Ref,
  image: z.optional(Ref),
});

const RunEndBody = z.strictObject({
  stopReason: z.nullable(StopReason),
  failure: z.optional(LlmFailure),
  totals: z.strictObject({
    turns: z.int().min(0),
    requests: z.int().min(0),
    attempts: z.int().min(0),
    promptTokens: z.int().min(0),
    hitTokens: z.int().min(0).nullable(),
    missTokens: z.int().min(0).nullable(),
    completionTokens: z.int().min(0),
    reasoningTokens: z.int().min(0),
    costCny: z.number().min(0).nullable(),
    wallMs: z.int().min(0),
    images: z.int().min(0),
    imageBytes: z.int().min(0),
  }),
  lastArchive: z.optional(Ref),
  lastModel: z.optional(Ref),
});

/** type → body schema；run-dir 写入前按此校验，读取时按此解析（MODEL-SPEC §7.2）。 */
export const EVENT_SCHEMAS = {
  'run.start': RunStartBody,
  'prompt.system': PromptSystemBody,
  'versions.render': VersionsRenderBody,
  'turn.start': TurnStartBody,
  'llm.request': LlmRequestBody,
  'llm.attempt': LlmAttemptBody,
  'llm.response': LlmResponseBody,
  'tool.call': ToolCallBody,
  'tool.result': ToolResultBody,
  'code.version': CodeVersionBody,
  'check.result': CheckResultBody,
  'model.check': z
    .strictObject({
      codeVersion: z.int().min(1),
      codeSha: Sha256,
      seed: z
        .int()
        .min(0)
        .max(2 ** 32 - 1),
      status: z.enum([
        'ok',
        'precheck-error',
        'build-error',
        'timeout',
        'out-of-memory',
        'output-too-large',
        'crashed',
        'aborted',
        'too-large',
        'unsupported',
        'internal-error',
      ]),
      /** 完整诊断/执行摘要，避免把长错误或文档直接放入事件行。 */
      result: Ref,
      document: Ref.optional(),
      documentHash: Sha256.optional(),
    })
    .refine(
      (body) =>
        body.status === 'ok'
          ? body.document !== undefined && body.documentHash !== undefined
          : body.document === undefined && body.documentHash === undefined,
      '成功必须带 document/documentHash；失败不得附成功文档',
    ),
  facts: FactsBody,
  'render.result': RenderResultBody,
  guard: GuardBody,
  submit: SubmitBody,
  delivery: DeliveryBody,
  'model.delivery': z.strictObject({
    code: Ref,
    document: Ref,
    hash: Sha256,
    codeVersion: z.int().min(1),
    note: Ref.optional(),
  }),
  'subrun.result': SubrunResultBody,
  'run.end': RunEndBody,
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;
export type EventBody<T extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[T]>;

/**
 * 写入前要截断的文本字段路径；`null` 表示数组每个元素。只列模型 / 编译器 / 渲染输出可能超长的字段，
 * 避免误伤 sha256、任务原文、URL 等本就有界或必须原样的字符串。缺键 / null 时安全跳过。
 */
const TRUNCATED_TEXT_PATHS: Partial<Record<EventType, readonly (readonly (string | null)[])[]>> = {
  'check.result': [
    ['precheck', 'diagnostics', null, 'message'],
    ['run', 'error', 'name'],
    ['run', 'error', 'message'],
  ],
  'render.result': [['kind']],
  submit: [['reason']],
  delivery: [['renderMissing']],
  'subrun.result': [['reason']],
};

function truncateAtPath(node: unknown, path: readonly (string | null)[], index: number): void {
  const key = path[index];
  if (key === undefined || node === null || typeof node !== 'object') return;
  if (key === null) {
    if (!Array.isArray(node)) return;
    for (const item of node) truncateAtPath(item, path, index + 1);
    return;
  }
  // body 是 JSON 数据、无访问器与原型污染；按字符串键读写安全。
  const record = node as Record<string, unknown>;
  if (!Object.hasOwn(record, key)) return;
  if (index === path.length - 1) {
    const value = record[key];
    if (typeof value === 'string') record[key] = truncateEventText(value);
    return;
  }
  truncateAtPath(record[key], path, index + 1);
}

/** 返回 body 的深拷贝，超长文本字段按路径截断；不修改入参。写入事件前调用。 */
export function clampEventBody<T extends EventType>(type: T, body: EventBody<T>): EventBody<T> {
  const paths = TRUNCATED_TEXT_PATHS[type];
  if (paths === undefined) return body;
  const clone = structuredClone(body);
  for (const path of paths) truncateAtPath(clone, path, 0);
  return clone;
}

/** 事件信封（MODEL-SPEC §7.2）；`body` 按 `type` 另行校验。 */
export const Envelope = z.strictObject({
  v: z.literal(EVENTS_SCHEMA_VERSION),
  seq: z.int().min(0),
  ts: z.iso.datetime(),
  runId: z.string(),
  turn: z.nullable(z.int().min(1)),
  type: z.string(),
  body: z.unknown(),
});
export type Envelope = z.infer<typeof Envelope>;

export interface EventBase {
  readonly v: 1;
  readonly seq: number;
  readonly ts: string;
  readonly runId: string;
  readonly turn: number | null;
}

/** 已校验的事件：`type` 与 `body` 一一对应。 */
export type Event = {
  [K in EventType]: EventBase & { readonly type: K; readonly body: EventBody<K> };
}[EventType];

/** 事件解析失败（信封坏、未知 type、body 不合 schema）。 */
export class EventParseError extends Error {
  readonly code = 'event-schema';

  constructor(message: string) {
    super(message);
    this.name = 'EventParseError';
  }
}

function isEventType(type: string): type is EventType {
  return Object.hasOwn(EVENT_SCHEMAS, type);
}

/** 校验一条事件（信封 + 对应 body）；失败抛 `EventParseError`，信息里带 type 与字段路径。 */
export function parseEvent(value: unknown): Event {
  const envelope = Envelope.safeParse(value);
  if (!envelope.success) throw new EventParseError(`事件信封不合 schema：${z.prettifyError(envelope.error)}`);
  const { type } = envelope.data;
  if (!isEventType(type)) throw new EventParseError(`未知事件类型 ${JSON.stringify(type)}`);
  const body = EVENT_SCHEMAS[type].safeParse(envelope.data.body);
  if (!body.success) throw new EventParseError(`事件 ${type} 的 body 不合 schema：${z.prettifyError(body.error)}`);
  // 上面已按 type 校验 body；TS 无法把「type 收窄」映射到「body 类型」，此处断言安全。
  return { ...envelope.data, type, body: body.data } as Event;
}
