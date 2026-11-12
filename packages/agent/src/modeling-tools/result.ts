/**
 * 草模执行结果的呈现与摘要（MODELING-SPEC §4）。
 *
 * 负责：把 @pg/sandbox/modeling 的 ModelExecution 转成给模型看的中文反馈（预检诊断、build-error、超时 / OOM /
 *   输出超限 / 崩溃 / 中止 / 太大 / 无 bwrap）与 bounded console 日志；成功时附真实几何摘要；生成写进 model.check 的紧凑摘要。
 * 不负责：执行本身（注入的 execute）、事件写入与提交判定（modeling-tools/session.ts）。
 * 本文件只依赖类型，不读 I/O、不执行模型代码。
 */

import type { Bounds, ModelDocument, Part } from '@pg/modeling/schema';
import type { ModelExecution } from '@pg/sandbox/modeling';

/** 事实行用的执行结果分类；与 agent facts.ts 的 CheckOutcome 同集合。 */
export type ModelOutcome = 'ok' | 'precheck-failed' | 'build-error' | 'not-finished';

export interface MeshCounts {
  readonly parts: number;
  readonly vertices: number;
  readonly triangles: number;
}

export function countsOf(document: ModelDocument): MeshCounts {
  let vertices = 0;
  let triangles = 0;
  for (const part of document.parts) {
    vertices += part.positions.length / 3;
    triangles += part.indices.length / 3;
  }
  return { parts: document.parts.length, vertices, triangles };
}

export function outcomeOf(kind: ModelExecution['kind']): ModelOutcome {
  if (kind === 'ok') return 'ok';
  if (kind === 'precheck-error') return 'precheck-failed';
  if (kind === 'build-error') return 'build-error';
  return 'not-finished';
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 成功结果的事件摘要：不重复存大网格（document 另存 blob），console 只留计数。 */
interface OkSummary {
  readonly kind: 'ok';
  readonly codeHash: string;
  readonly documentHash: string;
  readonly parts: number;
  readonly vertices: number;
  readonly triangles: number;
  readonly console: number;
  readonly consoleTruncated: number;
}

export type ModelResultSummary = OkSummary | Exclude<ModelExecution, { readonly kind: 'ok' }>;

export function summarize(execution: ModelExecution): ModelResultSummary {
  if (execution.kind !== 'ok') return execution;
  const counts = countsOf(execution.document);
  return {
    kind: 'ok',
    codeHash: execution.codeHash,
    documentHash: execution.documentHash,
    parts: counts.parts,
    vertices: counts.vertices,
    triangles: counts.triangles,
    console: execution.console.length,
    consoleTruncated: execution.consoleTruncated,
  };
}

type ModelConsole = Extract<ModelExecution, { readonly kind: 'ok' }>['console'];

/** 反馈里 console 的软上限：行数与字符数各限一次，超出写明“另有 N 条未显示”。 */
export const CONSOLE_MAX_ENTRIES = 20;
export const CONSOLE_MAX_CHARS = 2000;

/** 把 bounded console 渲染成可读文本；没有输出时返回空串。child 已按字节额度截断，这里再限行数 / 字符。 */
export function consoleText(entries: ModelConsole, truncated: number): string {
  if (entries.length === 0 && truncated === 0) return '';
  const shown: string[] = [];
  let used = 0;
  for (const entry of entries.slice(0, CONSOLE_MAX_ENTRIES)) {
    const line = `[${entry.level}] ${entry.text}`;
    if (used + line.length + 1 > CONSOLE_MAX_CHARS) {
      if (shown.length === 0) shown.push(line.slice(0, CONSOLE_MAX_CHARS));
      break;
    }
    shown.push(line);
    used += line.length + 1;
  }
  const dropped = entries.length - shown.length + truncated;
  const head = `console 输出 ${String(entries.length)} 条${truncated > 0 ? `（额度超限丢弃 ${String(truncated)} 条）` : ''}：`;
  const lines = [head, ...shown.map((line) => `  ${line}`)];
  if (dropped > 0) lines.push(`  …另有 ${String(dropped)} 条未显示`);
  return lines.join('\n');
}

/** 几何摘要整段字符硬上限；超出先少列部件再截断。 */
export const GEOMETRY_MAX_CHARS = 1200;
/** 几何摘要每部件一行，最多列这么多；其余折叠成一行。 */
export const GEOMETRY_MAX_PARTS = 12;

/** 数字保留 ≤3 位小数并去掉多余的 0（如 24.5、0、16）。 */
function formatGeometryNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

function boundsText(bounds: Bounds): string {
  const f = formatGeometryNumber;
  return `x[${f(bounds.min[0])},${f(bounds.max[0])}] y[${f(bounds.min[1])},${f(bounds.max[1])}] z[${f(bounds.min[2])},${f(bounds.max[2])}]`;
}

/** 总包围盒 = 各部件 bounds 的并集；bounds 已是世界坐标（模型 finish 时按实际顶点算出），不重算网格。 */
function totalBounds(parts: readonly Part[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const part of parts) {
    if (part.bounds.min[0] < minX) minX = part.bounds.min[0];
    if (part.bounds.min[1] < minY) minY = part.bounds.min[1];
    if (part.bounds.min[2] < minZ) minZ = part.bounds.min[2];
    if (part.bounds.max[0] > maxX) maxX = part.bounds.max[0];
    if (part.bounds.max[1] > maxY) maxY = part.bounds.max[1];
    if (part.bounds.max[2] > maxZ) maxZ = part.bounds.max[2];
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** 单部件一行：id、name、操作、三轴尺寸、世界坐标 y 范围。 */
function partGeometryLine(part: Part): string {
  const f = formatGeometryNumber;
  const { bounds } = part;
  const sx = f(bounds.max[0] - bounds.min[0]);
  const sy = f(bounds.max[1] - bounds.min[1]);
  const sz = f(bounds.max[2] - bounds.min[2]);
  return `- ${part.id}「${part.name}」${part.source.operation} 尺寸 ${sx}×${sy}×${sz}，y ${f(bounds.min[1])}~${f(bounds.max[1])}`;
}

/**
 * run_model 成功时的真实几何摘要：一行总览（部件 / 顶点 / 三角 / 总包围盒）+ 每部件一行。
 * 只读 document 已有数据（parts、positions 计数、bounds），不做网格计算；失败路径不调用。
 * 超过 GEOMETRY_MAX_PARTS 折叠、超过 GEOMETRY_MAX_CHARS 截断，均写明未列出 / 已截断。
 */
export function geometrySummary(document: ModelDocument): string {
  const counts = countsOf(document);
  const { parts } = document;
  if (parts.length === 0) return `几何摘要：0 个部件，0 顶点，0 三角`;
  const head =
    `几何摘要：${String(counts.parts)} 个部件，${String(counts.vertices)} 顶点，${String(counts.triangles)} 三角；` +
    `总包围盒 ${boundsText(totalBounds(parts))}`;
  const maxListed = Math.min(parts.length, GEOMETRY_MAX_PARTS);
  for (let listed = maxListed; listed >= 0; listed -= 1) {
    const lines = [head, ...parts.slice(0, listed).map(partGeometryLine)];
    const notes: string[] = [];
    const unlisted = parts.length - listed;
    if (unlisted > 0) notes.push(`另有 ${String(unlisted)} 个部件未列出`);
    if (listed < maxListed) notes.push('已截断');
    if (notes.length > 0) lines.push(`…（${notes.join('，')}）`);
    const text = lines.join('\n');
    if (text.length <= GEOMETRY_MAX_CHARS) return text;
  }
  return `${head}\n…（已截断）`.slice(0, GEOMETRY_MAX_CHARS);
}

function diagnosticsLines(execution: Extract<ModelExecution, { readonly kind: 'precheck-error' }>): string {
  // 预检超时 / 内存超限没有逐条诊断（diagnostics 为空、total=0），要显示 message 而不是“0 处问题”。
  if (execution.diagnostics.length === 0) return `类型预检未通过：${execution.message}`;
  const shown = execution.diagnostics
    .slice(0, 5)
    .map((d) => `第 ${String(d.line)} 行第 ${String(d.column)} 列：${d.message}`);
  const rest = execution.diagnostics.length > 5 ? `；…另 ${String(execution.total - 5)} 处` : '';
  return `类型预检未通过（${String(execution.total)} 处）：${shown.join('；')}${rest}`;
}

export function failureText(execution: Exclude<ModelExecution, { readonly kind: 'ok' }>): string {
  switch (execution.kind) {
    case 'precheck-error':
      return diagnosticsLines(execution);
    case 'build-error':
      return `执行出错（${execution.name}，第 ${String(execution.line)} 行第 ${String(execution.column)} 列）：${execution.message}`;
    case 'timeout':
      return `执行超时（${String(execution.timeoutMs)}ms）：模型代码必须同步、快速返回。`;
    case 'out-of-memory':
      return `执行内存超限：${execution.message}`;
    case 'output-too-large':
      return `建模输出过大（${String(execution.bytes)} 字节 > ${String(execution.limit)}）：减少部件或采样段数。`;
    case 'crashed':
      return `执行进程异常退出：${execution.message}`;
    case 'aborted':
      return '执行被中止。';
    case 'too-large':
      return `代码过大（${String(execution.bytes)} 字节 > ${String(execution.limit)}）：没有执行。`;
    case 'unsupported':
      return `本机没有 bwrap，无法在隔离进程里执行模型代码：${execution.message}`;
  }
}
