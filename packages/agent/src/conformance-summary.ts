/**
 * `check_code` 的逐对象一致性摘要（WS1）：把 `@pg/analysis/object-diff` 的 `DiffReport` 压成
 * 模型可见的 compact 文本。只报告，不参与 submit 判定；本文件无 I/O、无工具依赖。
 */

import type { DiffItem, DiffReport, DiffStatus } from '@pg/analysis/object-diff';

type Snapshot = Readonly<Record<string, unknown>>;

const STATUS_LABEL: Readonly<Record<DiffStatus, string>> = {
  pass: 'PASS',
  fail: 'FAIL',
  missing: 'MISSING',
  unverified: 'UNVERIFIED',
  extra: 'EXTRA',
};

const TRUNCATED = '…（已截断）';

function isRecord(value: unknown): value is Snapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundsTuple(value: unknown): value is readonly [number, number, number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    value.every((entry: unknown) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function isVector3(value: unknown): value is readonly [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry: unknown) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '?';
  }
}

function formatNumber(value: number): string {
  return String(value);
}

function tupleText(value: readonly [number, number, number, number, number, number]): string {
  return `[${value.slice(0, 3).map(formatNumber).join(',')}]..[${value.slice(3, 6).map(formatNumber).join(',')}]`;
}

function flatTupleText(value: readonly [number, number, number, number, number, number]): string {
  return `[${value.map(formatNumber).join(',')}]`;
}

function boundsText(snapshot: Snapshot | null): string {
  if (snapshot === null) return '无';
  const bounds = snapshot['bounds'];
  if (isBoundsTuple(bounds)) return tupleText(bounds);
  if (isRecord(bounds)) {
    const min = bounds['min'];
    const max = bounds['max'];
    if (isVector3(min) && isVector3(max)) {
      return `[${min.map(formatNumber).join(',')}]..[${max.map(formatNumber).join(',')}]`;
    }
  }
  return '无法读取';
}

function displayId(item: DiffItem): string {
  const raw = item.expectedId ?? item.actualId ?? item.id;
  return raw === item.kind || raw.startsWith(`${item.kind}:`) ? raw : `${item.kind}:${raw}`;
}

function roofFacts(snapshot: Snapshot | null): string | null {
  if (snapshot === null) return null;
  const nested = snapshot['roof'];
  const source = isRecord(nested) ? nested : snapshot;
  const form = source['form'] ?? source['formHint'];
  const pitch = source['pitchDegrees'];
  const eave = source['eaveY'];
  const ridge = source['ridgeY'];
  if (form === undefined && pitch === undefined && eave === undefined && ridge === undefined) return null;
  return `form=${formatScalar(form)} pitch=${formatScalar(pitch)} eave=${formatScalar(eave)} ridge=${formatScalar(ridge)}`;
}

function openingFacts(snapshot: Snapshot | null): string | null {
  if (snapshot === null) return null;
  const nested = snapshot['opening'];
  const source = isRecord(nested) ? nested : snapshot;
  const width = source['width'];
  const height = source['height'];
  const sill = source['sillY'];
  const head = source['headY'];
  if (width === undefined && height === undefined && sill === undefined && head === undefined) return null;
  return `width=${formatScalar(width)} height=${formatScalar(height)} sillY=${formatScalar(sill)} headY=${formatScalar(head)}`;
}

function factsFor(item: DiffItem, snapshot: Snapshot | null): string | null {
  if (item.kind === 'roof') return roofFacts(snapshot);
  if (item.kind === 'opening') return openingFacts(snapshot);
  return null;
}

function deltaText(item: DiffItem): string {
  const keys = Object.keys(item.delta).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = item.delta[key];
    if (entry === undefined) continue;
    if (key === 'bounds' && isBoundsTuple(entry.delta)) {
      parts.push(`Δ ${flatTupleText(entry.delta)}（bounds）`);
    } else if (typeof entry.delta === 'number') {
      const sign = entry.delta > 0 ? '+' : '';
      parts.push(`Δ ${sign}${formatNumber(entry.delta)}（${key}）`);
    } else if (entry.delta === null || typeof entry.delta === 'string' || typeof entry.delta === 'boolean') {
      parts.push(`Δ ${formatScalar(entry.expected)}→${formatScalar(entry.actual)}（${key}）`);
    } else {
      parts.push(`Δ ${formatScalar(entry.delta)}（${key}）`);
    }
  }
  return parts.join(' ');
}

function itemLine(item: DiffItem): string {
  const parts = [`- ${STATUS_LABEL[item.status]} ${displayId(item)}`, `期望 ${boundsText(item.expected)}`];
  const expectedFacts = factsFor(item, item.expected);
  if (expectedFacts !== null) parts.push(expectedFacts);
  parts.push(`实际 ${boundsText(item.actual)}`);
  const actualFacts = factsFor(item, item.actual);
  if (actualFacts !== null) parts.push(actualFacts);
  const delta = deltaText(item);
  if (delta.length > 0) parts.push(delta);
  if (item.status === 'unverified' && item.severity === 'hard') {
    parts[parts.length - 1] = `${parts[parts.length - 1] ?? ''}（blocking）`;
  }
  return parts.join(' ');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';
  if (maxChars <= TRUNCATED.length) return TRUNCATED.slice(0, maxChars);
  const budget = maxChars - TRUNCATED.length;
  let head = text.slice(0, budget);
  const lastNewline = head.lastIndexOf('\n');
  if (lastNewline > 0) head = head.slice(0, lastNewline);
  const lastCode = head.charCodeAt(head.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) head = head.slice(0, -1);
  return lastNewline > 0 ? `${head}\n${TRUNCATED}` : `${head}${TRUNCATED}`;
}

/**
 * 生成 compact 的逐对象一致性文本。非 pass 项在前，pass 项在后；超过 `maxChars` 时安全截断。
 */
export function formatConformanceSummary(report: DiffReport, maxChars = 2500): string {
  const expectedCount = report.items.filter((item) => item.expectedId !== null).length;
  const header =
    `一致性（仅报告，不拦截）：blocking ${String(report.summary.blockingCount)} / expected ${String(expectedCount)}` +
    `｜pass ${String(report.summary.pass)}、fail ${String(report.summary.fail)}、` +
    `unverified ${String(report.summary.unverified)}、missing ${String(report.summary.missing)}、` +
    `extra ${String(report.summary.extra)}`;
  const ordered = report.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => Number(a.item.status === 'pass') - Number(b.item.status === 'pass') || a.index - b.index)
    .map(({ item }) => item);
  const lines = [header, ...ordered.map(itemLine)];
  return truncate(lines.join('\n'), maxChars);
}
