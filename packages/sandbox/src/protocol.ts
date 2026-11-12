/**
 * 预检的宿主 / worker 共享契约：诊断、结果与线程消息的 zod schema，类型由 schema 派生（STANDARDS §3）。
 * 只放协议，不放编译与规则逻辑。
 */
import { FAMILIES } from '@pg/blocks/registry';
import { ModelDocument } from '@pg/modeling/schema';
import { z } from 'zod';

/** 一条给模型看的诊断；行列都从 1 起，source 是该行源码。 */
export const diagnosticSchema = z
  .object({
    line: z.int().min(1),
    column: z.int().min(1),
    code: z.string().min(1),
    message: z.string(),
    source: z.string(),
  })
  .readonly();
export type Diagnostic = z.infer<typeof diagnosticSchema>;

/** `precheck` 的结果；执行阶段的结果在 SANDBOX-SPEC §5.6 另行定义。 */
export const precheckResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok') }).readonly(),
  z
    .object({
      kind: z.literal('failed'),
      diagnostics: z.array(diagnosticSchema).readonly(),
      total: z.int().min(0),
    })
    .readonly(),
  z.object({ kind: z.literal('too-large'), bytes: z.int().min(0), limit: z.int().positive() }).readonly(),
  z.object({ kind: z.literal('timeout'), limitMs: z.int().positive() }).readonly(),
  z.object({ kind: z.literal('out-of-memory'), limitMiB: z.int().positive() }).readonly(),
]);
export type PrecheckResult = z.infer<typeof precheckResultSchema>;

/** 代码 UTF-8 字节上限；预检与 `runCode` 输入共用（SANDBOX-SPEC §3.1、§6，F6）。 */
export const MAX_CODE_BYTES = 256 * 1024;

/**
 * 报告（UTF-8 JSON）字节上限默认值（SANDBOX-SPEC §5.5）。宿主按它判 `reportBytes` 超限，
 * child 在编码帧前按同一默认值截断 `overlaps`（见 `report-limit.ts`）。
 */
export const DEFAULT_REPORT_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// 草模资产通道（MASSING-CONVERSION-SPEC §5.2）：宿主把 massing 工具登记的文档与颜色候选
// 随输入注入 child，模型代码只引用 id。schema、id 规则与大小上限在这里单点定义。
// ---------------------------------------------------------------------------

/** 单份文档序列化 JSON 上限；与建模子进程输出上限对齐（modeling-protocol.ts）。 */
export const MAX_ASSET_DOCUMENT_BYTES = 16 * 1024 * 1024;
/** 一次注入的文档份数上限。 */
export const MAX_ASSET_DOCUMENTS = 8;
/** 一次注入的全部文档序列化 JSON 合计上限。 */
export const MAX_ASSETS_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * 草模文档 id 规则（§5.2）：小写字母或数字开头，可含 `_` / `-`，最长 64。
 * `#` 供 massing 工具的稳定句柄 `massing#N`（SUBAGENT-LOOP-SPEC §5.2）——建造代码要逐字引用它。
 */
const assetIdPattern = /^[a-z0-9][a-z0-9_#-]{0,63}$/;

/** 宿主注入的一份草模文档；document 由 geometry / voxelize 再按 ModelDocument 二次校验。 */
export const massingDocumentAssetSchema = z
  .strictObject({ id: z.string().regex(assetIdPattern), document: ModelDocument })
  .readonly();
export type MassingDocumentAsset = z.infer<typeof massingDocumentAssetSchema>;

/** 默认材质映射的颜色候选；family 收窄到 blocks 的材质族枚举（比规格的 string 更严格）。 */
export const massingColorCandidateSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9_]{1,64}$/),
    rgb: z.int().min(0).max(0xffffff),
    family: z.enum(FAMILIES),
  })
  .readonly();
export type MassingColorCandidateAsset = z.infer<typeof massingColorCandidateSchema>;

/** child 输入与 `runCode` 输入共用的可选资产包（§5.2）；空表与缺省等价。 */
export const massingAssetsSchema = z
  .strictObject({
    documents: z.array(massingDocumentAssetSchema).readonly(),
    colorCandidates: z.array(massingColorCandidateSchema).readonly(),
  })
  .readonly();
export type MassingAssets = z.infer<typeof massingAssetsSchema>;

/** 宿主 → worker 的请求。 */
export const workerRequestSchema = z
  .object({
    id: z.int().positive(),
    code: z.string().refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_CODE_BYTES, {
      message: `代码超过 ${String(MAX_CODE_BYTES)} 字节上限`,
    }),
  })
  .readonly();
export type WorkerRequest = z.infer<typeof workerRequestSchema>;

/** worker 建好运行时并预热完成后发出的就绪消息；宿主等它之后再开始超时计时（F7）。 */
export const workerReadySchema = z.object({ type: z.literal('ready') }).readonly();
export type WorkerReady = z.infer<typeof workerReadySchema>;

/** worker 侧无法产出结果时的错误码；invalid-declaration 是宿主缺陷。 */
export const workerErrorCodeSchema = z.enum(['invalid-declaration', 'internal']);
export type WorkerErrorCode = z.infer<typeof workerErrorCodeSchema>;

/** worker → 宿主的响应；成功带结果，失败带错误码与中文说明。 */
export const workerResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      id: z.int().positive(),
      result: precheckResultSchema,
    })
    .readonly(),
  z
    .object({
      ok: z.literal(false),
      id: z.int().positive(),
      error: z.object({ code: workerErrorCodeSchema, message: z.string() }).readonly(),
    })
    .readonly(),
]);
export type WorkerResponse = z.infer<typeof workerResponseSchema>;

/**
 * `createPrechecker` 的 worker 启动参数。`globalsText` 与 `entry` 只在建模预检时给出，
 * 缺省时 worker 用 world API 的全局 shim 与入口文案（行为与历史一致）。
 */
export const workerDataSchema = z
  .object({
    declaration: z.string(),
    globalsText: z.string().optional(),
    entry: z.object({ signature: z.string(), paramLabel: z.string() }).readonly().optional(),
    expectedEntryType: z.string().optional(),
  })
  .readonly();
export type WorkerData = z.infer<typeof workerDataSchema>;

// ---------------------------------------------------------------------------
// 执行协议（SANDBOX-SPEC §5）：child 输入、child 报告、console 条目与覆盖报告。
// 类型由 schema 派生，宿主与 child 共用同一份定义（STANDARDS §3）。
// ---------------------------------------------------------------------------

/** console 捕获到的一条；level 只可能是 log / warn / error（§5.4）。 */
export const consoleEntrySchema = z
  .strictObject({ level: z.enum(['log', 'warn', 'error']), text: z.string() })
  .readonly();
export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;

/** 报告格式独立于 child 输入协议；此前缺省字段的记录为格式1。 */
export const REPORT_FORMAT_VERSION = 2;

export const overlapSourceSchema = z
  .strictObject({
    api: z.string().min(1),
    line: z.int().min(0),
    writeLayer: z.enum(['opening', 'structure', 'decoration']),
  })
  .readonly();
export const overlapSampleDetailSchema = z
  .strictObject({
    expectedState: z.string().min(1),
    actualState: z.string().min(1),
    winnerSource: overlapSourceSchema,
    loserSource: overlapSourceSchema,
  })
  .readonly();
const overlapPointSchema = z.tuple([z.int(), z.int(), z.int()]).readonly();

export const overlapGroupSchema = z
  .strictObject({
    winner: z.int().positive(),
    loser: z.int().positive(),
    cells: z.int().positive(),
    sample: overlapPointSchema,
    sampleDetail: overlapSampleDetailSchema,
  })
  .readonly();
export const overlapSummarySchema = z
  .strictObject({
    sameLayer: z.int().min(0),
    crossLayer: z.int().min(0),
    lostDecor: z.int().min(0),
    groups: z.array(overlapGroupSchema).max(3).readonly(),
    groupsOmitted: z.int().min(0),
  })
  .readonly();
export type OverlapSampleDetail = z.infer<typeof overlapSampleDetailSchema>;
export type OverlapSummary = z.infer<typeof overlapSummarySchema>;

/** geometry Composition.overlaps 的原样条目（§5.3）。旧记录允许不带 detail。 */
export const overlapSchema = z
  .strictObject({
    kind: z.enum(['same-layer', 'cross-layer']),
    winner: z.int().positive(),
    loser: z.int().positive(),
    cells: z.int().positive(),
    lostDecor: z.int().positive().optional(),
    sample: overlapPointSchema.optional(),
    sampleDetail: overlapSampleDetailSchema.optional(),
  })
  .refine(
    (o) =>
      o.sampleDetail === undefined || (o.kind === 'cross-layer' && o.lostDecor !== undefined && o.sample !== undefined),
    { message: 'sampleDetail 必须绑定跨层 lostDecor 的 sample' },
  )
  .readonly();
export type OverlapReport = z.infer<typeof overlapSchema>;

/** build 抛错时给模型看的位置；line / column 都是 0 表示不在模型代码里（§4、§5.3）。 */
export const childErrorSchema = z
  .strictObject({
    name: z.string(),
    message: z.string(),
    line: z.int().min(0),
    column: z.int().min(0),
  })
  .readonly();
export type ChildError = z.infer<typeof childErrorSchema>;

/** child 写进帧的报告（§5.3）。hash 由宿主复算比对。 */
export const childReportSchema = z
  .strictObject({
    reportFormat: z.union([z.literal(1), z.literal(REPORT_FORMAT_VERSION)]).optional(),
    status: z.enum(['ok', 'build-error']),
    error: childErrorSchema.optional(),
    hash: z.string(),
    calls: z.int().min(0),
    overlaps: z.array(overlapSchema),
    /** 报告超限被截断时记 `overlaps` 丢弃的条数；未截断时省略（§5.3）。 */
    overlapsTruncated: z.int().positive().optional(),
    overlapSummary: overlapSummarySchema.optional(),
    console: z.array(consoleEntrySchema),
    consoleTruncated: z.int().min(0),
  })
  .readonly();
export type ChildReport = z.infer<typeof childReportSchema>;

/** child 输入协议版本（§5.2）；输入结构变化时加 1，并进入 `sandboxVersion()`（§8.3）。 */
export const CHILD_PROTOCOL_VERSION = 2;

/** 宿主通过 stdin 写给 child 的一份 JSON（§5.2）。 */
export const childInputSchema = z
  .strictObject({
    protocol: z.literal(CHILD_PROTOCOL_VERSION),
    code: z.string(),
    seed: z
      .int()
      .min(0)
      .max(2 ** 32 - 1),
    apiVersion: z.int().min(0).max(65535),
    limits: z.strictObject({ consoleBytes: z.int().positive() }),
    assets: massingAssetsSchema.optional(),
  })
  .readonly();
export type ChildInput = z.infer<typeof childInputSchema>;

/** `runCode` 的输入（§6）；不自己做预检，调用方先 check。code 与预检共用同一字节上限（F6）。 */
export const runInputSchema = z
  .strictObject({
    code: z.string().refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_CODE_BYTES, {
      message: `代码超过 ${String(MAX_CODE_BYTES)} 字节上限`,
    }),
    seed: z
      .int()
      .min(0)
      .max(2 ** 32 - 1),
    assets: massingAssetsSchema.optional(),
  })
  .readonly();
export type RunInput = z.infer<typeof runInputSchema>;
