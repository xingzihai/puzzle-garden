/**
 * 当前稿与 write / edit / read 三个工具的纯逻辑（AGENT-SPEC §4.1，C14）。
 *
 * 负责：整份写入、按精确子串的原子局部编辑（重叠计数；精确 0 次时退到空白归一唯一匹配）、带行号读取。
 * 不负责：读文件与存版本（runner）、check_code / view_building / submit。
 * 本文件是纯函数：不读 I/O；代码字节上限由调用方传入（MAX_CODE_BYTES 在 @pg/sandbox/run，非纯入口）。
 */

/** 当前稿：模型代码与版本号（版本从 1 起，尚无代码时为 null）。 */
export interface Draft {
  readonly code: string;
  readonly version: number;
}

export type EditStatus = 'edit-not-found' | 'edit-ambiguous' | 'edit-invalid';

export interface Edit {
  readonly find: string;
  readonly replace: string;
}

export interface WriteOk {
  readonly kind: 'ok';
  readonly draft: Draft;
  readonly text: string;
}

export interface WriteTooLarge {
  readonly kind: 'too-large';
  readonly bytes: number;
  readonly limit: number;
  readonly text: string;
}

export type WriteResult = WriteOk | WriteTooLarge;

export interface EditOk {
  readonly kind: 'ok';
  readonly draft: Draft;
  readonly text: string;
}

export interface EditError {
  readonly kind: 'error';
  readonly status: EditStatus;
  readonly text: string;
}

export type EditResult = EditOk | EditError;

export interface ReadResult {
  readonly text: string;
}

/**
 * 提交窗口是否禁止整份写入：只有已有非空草稿时才禁止（窗口内仍可 edit_code）。
 * v0（以及被写空的 v1+）没有可编辑内容，write_code 是唯一出路，必须始终放行；否则窗口先于首稿
 * 进入时会同时挡住 write_code / edit_code / check_code / submit，run 永远无法产生有效版本。
 */
export function windowBlocksWrite(draft: Draft, inWindow: boolean): boolean {
  return inWindow && draft.version !== 0 && draft.code.trim() !== '';
}

const encoder = new TextEncoder();

/** UTF-8 字节数；纯函数文件不能用 Buffer（防间接 I/O），用 TextEncoder。 */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** 行数：末尾换行不额外算一行；空代码为 0 行。 */
export function lineCount(code: string): number {
  if (code === '') return 0;
  return code.endsWith('\n') ? code.slice(0, -1).split('\n').length : code.split('\n').length;
}

function linesOf(code: string): string[] {
  if (code === '') return [];
  return code.endsWith('\n') ? code.slice(0, -1).split('\n') : code.split('\n');
}

/** 整份写入（第一版或推倒重来）；超过字节上限拒绝，版本号不变。 */
export function writeCode(draft: Draft, code: string, maxBytes: number): WriteResult {
  const bytes = byteLength(code);
  if (bytes > maxBytes) {
    return {
      kind: 'too-large',
      bytes,
      limit: maxBytes,
      text: `代码 ${String(bytes)} 字节，超过上限 ${String(maxBytes)} 字节：没有写入，仍是第 v${String(draft.version)} 版。`,
    };
  }
  const next: Draft = { code, version: draft.version + 1 };
  return { kind: 'ok', draft: next, text: `已写入第 v${String(next.version)} 版，${String(lineCount(code))} 行。` };
}

/** 允许重叠地数子串出现次数：`aa` 在 `aaa` 里算 2 次（C14）。 */
export function countOccurrences(text: string, find: string): number {
  if (find === '') return 0;
  let count = 0;
  let at = text.indexOf(find);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(find, at + 1);
  }
  return count;
}

/** 各次匹配的起始码元下标（允许重叠）。 */
function occurrenceOffsets(text: string, find: string): number[] {
  const out: number[] = [];
  if (find === '') return out;
  let at = text.indexOf(find);
  while (at !== -1) {
    out.push(at);
    at = text.indexOf(find, at + 1);
  }
  return out;
}

/** 空白归一的"空白"：空格、tab、换行（含 CR，覆盖 CRLF 文件）。 */
function isNormalizedSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

interface NormalizedText {
  readonly text: string;
  /** 归一后每个字符对应的原稿起始下标；注入的空格代表一整段连续空白。 */
  readonly starts: readonly number[];
  /** 归一后每个字符对应的原稿结束下标（不含）。 */
  readonly ends: readonly number[];
}

/**
 * 空白归一：连续空白（空格 / tab / 换行）折叠为一个空格，去掉首尾空白（逐行有效）。同时记录
 * 每个归一字符到原稿的字符区间，供匹配后按**真实区间**替换——多字符空白长度不同也不会错位。
 */
function normalizeWithMap(code: string): NormalizedText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingStart = 0;
  let pending = false;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === undefined) break; // 不可达（i < length），仅为类型收窄
    if (isNormalizedSpace(ch)) {
      const runStart = i;
      while (i < code.length) {
        const c = code[i];
        if (c === undefined || !isNormalizedSpace(c)) break;
        i += 1;
      }
      // 只有前面已有字符才欠一个空格；否则是行首缩进，丢弃。末尾未 flush 即为行尾空白，丢弃。
      if (text !== '') {
        pendingStart = runStart;
        pending = true;
      }
      continue;
    }
    if (pending) {
      text += ' ';
      starts.push(pendingStart);
      ends.push(i);
      pending = false;
    }
    text += ch;
    starts.push(i);
    ends.push(i + 1);
    i += 1;
  }
  return { text, starts, ends };
}

/** 码元下标所在行（1 起）。 */
function lineAt(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) {
    if (code[i] === '\n') line += 1;
  }
  return line;
}

/** 最长公共子序列长度（纯函数，用于"最接近的一行"）。 */
export function lcsLength(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

interface Closest {
  readonly line: number;
  readonly text: string;
}

/** `find` 第一行（去首尾空白）与各行的 LCS 最长者；同长取行号小的。 */
function closestLine(code: string, find: string): Closest | null {
  const first = (find.split('\n')[0] ?? '').trim();
  if (first === '') return null;
  const lines = linesOf(code);
  let best: Closest | null = null;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const score = lcsLength(first, (lines[i] ?? '').trim());
    if (score > bestScore) {
      bestScore = score;
      best = { line: i + 1, text: lines[i] ?? '' };
    }
  }
  return bestScore > 0 ? best : null;
}

function snippet(code: string, index: number, replacementLength: number): string {
  const total = lineCount(code);
  const start = lineAt(code, index);
  const end = replacementLength === 0 ? start : lineAt(code, index + replacementLength - 1);
  const from = Math.max(1, start - 2);
  const to = Math.min(total, Math.max(end + 2, from));
  const shown = linesOf(code).slice(from - 1, to);
  return [
    `  第 ${String(from)}–${String(to)} 行：`,
    ...shown.map((line, i) => `    ${String(from + i)}| ${line}`),
  ].join('\n');
}

function invalidMessage(index: number, total: number, version: number, why: string): string {
  return `编辑未生效（第 ${String(index)} 条，共 ${String(total)} 条；全部未应用）：${why}。当前仍是第 v${String(version)} 版。`;
}

function notFoundMessage(working: string, edit: Edit, index: number, total: number, version: number): string {
  const lines: string[] = [`find 在第 v${String(version)} 版中出现 0 次（按空白归一后也没有唯一匹配）。`];
  const close = closestLine(working, edit.find);
  if (close !== null) lines.push(`最接近的一行（第 ${String(close.line)} 行）：${close.text}`);
  lines.push('先用 read_code 看准原文再改。');
  return `编辑未生效（第 ${String(index)} 条，共 ${String(total)} 条；全部未应用）：${lines[0] ?? ''}\n${lines
    .slice(1)
    .join('\n')}`;
}

function ambiguousMessage(working: string, edit: Edit, index: number, total: number, version: number): string {
  const offsets = occurrenceOffsets(working, edit.find);
  const shown = offsets.slice(0, 10).map((o) => String(lineAt(working, o)));
  const rest = offsets.length > 10 ? `，…另 ${String(offsets.length - 10)} 处` : '';
  return (
    `编辑未生效（第 ${String(index)} 条，共 ${String(total)} 条；全部未应用）：` +
    `find 在第 v${String(version)} 版中出现 ${String(offsets.length)} 次，必须恰好 1 次。\n` +
    `出现位置的行号：${shown.join('、')}${rest}。\n先用 read_code 看准原文再改。`
  );
}

/** 精确 0 次、按空白归一后 ≥2 处：报 edit-ambiguous，不猜用哪一处。 */
function normalizedAmbiguousMessage(working: string, edit: Edit, index: number, total: number): string {
  const norm = normalizeWithMap(working);
  const findNorm = normalizeWithMap(edit.find).text;
  const offsets = occurrenceOffsets(norm.text, findNorm);
  const lines = offsets.map((o) => String(lineAt(working, norm.starts[o] ?? 0)));
  const shown = lines.slice(0, 10);
  const rest = lines.length > 10 ? `，…另 ${String(lines.length - 10)} 处` : '';
  return (
    `编辑未生效（第 ${String(index)} 条，共 ${String(total)} 条；全部未应用）：` +
    `find 逐字出现 0 次，按空白归一后出现 ${String(lines.length)} 次，必须恰好 1 次。\n` +
    `出现位置的行号：${shown.join('、')}${rest}。\n先用 read_code 看准原文再改。`
  );
}

/**
 * 原子局部编辑（C14）：按顺序在上一条编辑后的文本上做精确子串替换，每个 find 必须恰好出现 1 次。
 * 任一条失败则整体不生效、版本号不变。成功返回带上下文片段的文本。
 */
export function editCode(draft: Draft, edits: readonly Edit[]): EditResult {
  const total = edits.length;
  let working = draft.code;
  const snippets: string[] = [];

  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    if (edit === undefined) continue;
    const index = i + 1;
    if (edit.find === '') {
      return { kind: 'error', status: 'edit-invalid', text: invalidMessage(index, total, draft.version, 'find 为空') };
    }
    if (edit.find === edit.replace) {
      return {
        kind: 'error',
        status: 'edit-invalid',
        text: invalidMessage(index, total, draft.version, 'find 与 replace 相同，没有变化'),
      };
    }
    const count = countOccurrences(working, edit.find);
    if (count > 1) {
      return {
        kind: 'error',
        status: 'edit-ambiguous',
        text: ambiguousMessage(working, edit, index, total, draft.version),
      };
    }
    if (count === 1) {
      // 精确唯一匹配优先，逐字不变。
      const at = working.indexOf(edit.find);
      const next = working.slice(0, at) + edit.replace + working.slice(at + edit.find.length);
      snippets.push(`第 ${String(index)} 处改动：\n${snippet(next, at, edit.replace.length)}`);
      working = next;
      continue;
    }
    // 精确 0 次：退到空白归一匹配；归一后唯一才应用，多处仍拒绝。
    const norm = normalizeWithMap(working);
    const findNorm = normalizeWithMap(edit.find).text;
    const normalizedCount = findNorm === '' ? 0 : countOccurrences(norm.text, findNorm);
    if (normalizedCount === 0) {
      return {
        kind: 'error',
        status: 'edit-not-found',
        text: notFoundMessage(working, edit, index, total, draft.version),
      };
    }
    if (normalizedCount > 1) {
      return {
        kind: 'error',
        status: 'edit-ambiguous',
        text: normalizedAmbiguousMessage(working, edit, index, total),
      };
    }
    const normAt = norm.text.indexOf(findNorm);
    const start = norm.starts[normAt] ?? 0;
    const end = norm.ends[normAt + findNorm.length - 1] ?? start;
    const next = working.slice(0, start) + edit.replace + working.slice(end);
    snippets.push(`第 ${String(index)} 处改动（按空白归一匹配应用）：\n${snippet(next, start, edit.replace.length)}`);
    working = next;
  }

  const next: Draft = { code: working, version: draft.version + 1 };
  return {
    kind: 'ok',
    draft: next,
    text: `已改为第 v${String(next.version)} 版（${String(total)} 处），${String(lineCount(working))} 行。\n${snippets.join('\n')}`,
  };
}

/** read_code：行号从 1 起、闭区间；一次最多 400 行，超出截到 `from + 399` 并注明。 */
export function readCode(draft: Draft, from?: number, to?: number): ReadResult {
  const lines = linesOf(draft.code);
  const total = lines.length;
  if (total === 0) return { text: `第 v${String(draft.version)} 版，共 0 行。` };
  const start = from ?? 1;
  const end = to ?? total;
  if (!Number.isSafeInteger(start) || start < 1) {
    return { text: `read_code.from 应是 ≥ 1 的整数，实际是 ${JSON.stringify(from)}。` };
  }
  if (!Number.isSafeInteger(end) || end < 1) {
    return { text: `read_code.to 应是 ≥ 1 的整数，实际是 ${JSON.stringify(to)}。` };
  }
  if (start > total) {
    return {
      text: `read_code.from=${String(start)} 超出范围：当前稿第 v${String(draft.version)} 版共 ${String(total)} 行。`,
    };
  }
  if (end < start) {
    return { text: `read_code.to=${String(end)} 小于 from=${String(start)}：需要闭区间 [from, to]。` };
  }
  const requested = Math.min(end, total);
  const capped = requested > start + 399 ? start + 399 : requested;
  const shown = lines.slice(start - 1, capped);
  const body = shown.map((line, i) => `${String(start + i)}| ${line}`).join('\n');
  const note =
    capped < requested ? `\n（已截断，显示 ${String(start)}–${String(capped)}，共 ${String(total)} 行）` : '';
  return {
    text: `第 v${String(draft.version)} 版，共 ${String(total)} 行，显示 ${String(start)}–${String(capped)}：\n${body}${note}`,
  };
}
