/**
 * massing / read_massing 的纯逻辑（SUBAGENT-LOOP-SPEC §1–§5）：序号与命名、seed 派生、复用键、
 * 上限收紧、会话记录，以及成功 / 各失败分支的模型可见文本。
 *
 * 负责：`massing#N` 与 `sub/massing-N` 的命名、复用键、子运行默认上限、文本格式化、会话状态类型。
 * 不负责：子运行编排与事件写入（massing/host.ts）、工具注册（tools/schemas.ts）、读源码的格式化
 *   （tools/read-massing.ts）。
 * 本文件是纯函数：不做 I/O，不依赖时间与全局可变状态。
 */

import type { ModelDocument } from '@pg/modeling/schema';
import type { Ref, StopReason } from '@pg/store/events';

/** 子运行默认墙钟上限；与 tools/model-agent.ts 的默认一致（4 分钟，§3.2 的 host 缺省）。 */
export const MASSING_CHILD_WALL_MS = 240_000;
/** 子运行的提交窗口（与 tools/model-agent.ts:131 一致）。 */
export const MASSING_SUBMIT_WINDOW = 2;
/** 父剩余墙钟低于它就不再启动子运行（RunLimits.wallMs 的最小值 60 s，§2.1 第 4 步）。 */
export const MASSING_MIN_PARENT_WALL_MS = 60_000;
/** host 未另外收紧时的默认上限；与工具参数默认值一致（§1.1、§3.1）。 */
export const MASSING_DEFAULT_MAX_CNY = 0.5;
export const MASSING_DEFAULT_MAX_TURNS = 20;
/** 复用键字段分隔符：NUL 不可能出现在简报文本里，避免字段拼接歧义。 */
const KEY_SEP = '\u0000';

/** massing 工具的参数（schema 校验并填默认值之后）。 */
export interface MassingRequest {
  readonly brief: string;
  readonly maxTurns: number;
  readonly maxCny: number;
  readonly seed?: number;
}

/** 一次成功子运行的会话记录；复用与 read_massing 都从这里取，不重复读盘。 */
export interface MassingRunRecord {
  /** 稳定句柄 `massing#N`，也是 check_code 资产通道里的文档 id（§5.2）。 */
  readonly id: string;
  readonly ordinal: number;
  readonly runId: string;
  /** 相对父 run 目录的路径 `sub/massing-N`。 */
  readonly dir: string;
  /** 复用键（成功结果只有一份）。 */
  readonly key: string;
  /** 成功结果的工具文本原文；复用时逐字返回（图片另计）。 */
  readonly text: string;
  /** 子运行交付的 `source.ts` 全文。 */
  readonly source: string;
  /** contact 合成图 PNG；渲染失败或超预算跳过时为 null。 */
  readonly image: Uint8Array | null;
  readonly document: ModelDocument;
  readonly documentHash: string;
}

/** 会话里的 massing 状态：序号每启动一次 +1（失败也计数），runs 只存成功记录。 */
export interface MassingRunState {
  ordinal: number;
  runs: MassingRunRecord[];
}

export function initialMassingState(): MassingRunState {
  return { ordinal: 0, runs: [] };
}

export function massingId(ordinal: number): string {
  return `massing#${String(ordinal)}`;
}

export function massingRunId(ordinal: number): string {
  return `massing-${String(ordinal)}`;
}

/** 子目录相对父 run 目录的路径，用 `/` 分隔（与 run 目录内记录口径一致）。 */
export function massingDir(ordinal: number): string {
  return `sub/${massingRunId(ordinal)}`;
}

/** 子 seed = 参数 seed ?? (父 seed + ordinal) mod 2^32（§2.3 的推荐式 O3）。 */
export function massingChildSeed(parentSeed: number, ordinal: number): number {
  return (parentSeed + ordinal) % 2 ** 32;
}

/**
 * 复用键 = brief + maxTurns + maxCny + seed（§2.3）。`seed` 用**参数**：缺省时记 `default`，
 * 这样"默认 seed 的同一简报"也能命中复用（派生 seed 依赖 ordinal，不能进键，否则永远不命中）。
 */
export function massingReuseKey(request: MassingRequest): string {
  const seed = request.seed === undefined ? 'default' : String(request.seed);
  return [request.brief, String(request.maxTurns), String(request.maxCny), seed].join(KEY_SEP);
}

/** effMaxCny = min(参数, host.limits.maxCny ?? 0.5)（§3.1）。 */
export function effectiveMassingMaxCny(requested: number, hostMaxCny?: number): number {
  return Math.min(requested, hostMaxCny ?? MASSING_DEFAULT_MAX_CNY);
}

/** effMaxTurns = min(参数, host.limits.maxTurns ?? 20)（§3.2）。 */
export function effectiveMassingMaxTurns(requested: number, hostMaxTurns?: number): number {
  return Math.min(requested, hostMaxTurns ?? MASSING_DEFAULT_MAX_TURNS);
}

// ───────────── 文本 ─────────────

export const MASSING_NO_HOST =
  '本运行没有接入草模子运行（缺建模执行或合成图渲染）；不伪造结果。只用手上的体素工具继续。';
export const MASSING_ABORTED = '草模子运行已中止并清理，随父 run 取消。';
export const MASSING_REJECTED_WALL = '未启动；剩余墙钟或窗口不允许。';
export const MASSING_REPLAY_MISSING = '回放模式下没有该 callId 的 subrun 记录，未执行。';
export const MASSING_IMAGE_SKIPPED = '累计图片已超过上限，未附合成图（引用仍有效）。';

export interface MassingSuccessFacts {
  readonly id: string;
  readonly dir: string;
  readonly source: Ref;
  readonly document: Ref;
  readonly documentHash: string;
  /** `geometrySummary(document)` 的原样输出。 */
  readonly geometry: string;
}

/** 成功文本（§5.2）：引用、子目录、Ref、documentHash 与几何摘要一次性给全。 */
export function formatMassingSuccess(facts: MassingSuccessFacts): string {
  return [
    `草模子运行成功：${facts.id}（子目录 ${facts.dir}）。`,
    `source.ts sha256 ${facts.source.sha256}（${String(facts.source.bytes)} 字节）；` +
      `model.json sha256 ${facts.document.sha256}（${String(facts.document.bytes)} 字节）；` +
      `文档 hash ${facts.documentHash}。`,
    facts.geometry,
    `文档已登记：建造代码用 world.massingImport('${facts.id}', …) 导入；read_massing 可带行号读草模代码。`,
  ].join('\n');
}

/** 复用文本：原文 + 一句"同键复用"（§2.3）。 */
export function formatMassingReuse(record: MassingRunRecord): string {
  return `${record.text}\n（与 ${record.id} 同键，复用，没有重新计费）`;
}

/** 未交付的停止原因描述（§3.2 的触顶回传）。 */
export function massingStopDescription(
  stopReason: StopReason,
  limits: { readonly maxTurns: number; readonly maxCny: number; readonly wallMs: number },
): string {
  if (stopReason === 'max-turns') return `达到轮数上限（${String(limits.maxTurns)} 轮）`;
  if (stopReason === 'cost-budget') return `达到花费上限（¥${limits.maxCny.toFixed(2)}）`;
  if (stopReason === 'wall') return `达到墙钟上限（${String(Math.round(limits.wallMs / 1000))} 秒）`;
  return `停止原因 ${stopReason}`;
}

export function massingAdvice(stopReason: StopReason): string {
  if (stopReason === 'max-turns') return '把简报写得更具体，或调大 maxTurns 后重试。';
  if (stopReason === 'cost-budget') return '把简报写得更聚焦，或调大 maxCny 后重试。';
  return '可以改简报后重试；失败的子运行不会中断本 run。';
}

/** 父工具失败文本：stopReason + 轮数 + 花费 + 一句可行动建议（§6）。 */
export function formatMassingFailure(input: {
  readonly description: string;
  readonly turns: number;
  readonly costCny: number;
  readonly advice: string;
}): string {
  return (
    `草模子运行未交付（${input.description}）：${String(input.turns)} 轮、花费 ¥${input.costCny.toFixed(4)}。` +
    input.advice
  );
}

/** 子宿主异常的单行文本；换行折成空格、按 UTF-16 码元截断（§6 的"脱敏一行"）。 */
export function formatMassingHostError(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  const shown = oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
  return `子运行宿主异常（internal-error）：${shown === '' ? '（无错误信息）' : shown}`;
}

export function formatMassingRejectedBudget(remainingCny: number, neededCny: number): string {
  return (
    `未启动：父剩余预算 ¥${remainingCny.toFixed(4)} < 需预留 ¥${neededCny.toFixed(4)}；` +
    '调小 maxCny 或先收敛再调用。'
  );
}

export function formatMassingRenderFailed(id: string, kind: string): string {
  return `子运行已交付（引用有效：${id}）；合成图渲染失败（${kind}）。可先用 read_massing 看代码，或稍后重试。`;
}

/** 子运行目录已存在（对齐 tools/model-agent.ts 的拒绝覆盖）。 */
export function formatMassingDirExists(dir: string): string {
  return `未启动：子运行目录已存在（${dir}），拒绝覆盖。`;
}
