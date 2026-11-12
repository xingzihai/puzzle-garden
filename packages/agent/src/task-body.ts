/**
 * 题面截取（AGENT-SPEC §2.1）：从 v0.2 格式的题目 markdown 里取标题 + 一至四节。
 *
 * 负责：纯函数 `extractTaskBody` 截取喂给模型的正文，缺节报错；`assertTaskPath` 拒绝密封题路径。
 * 不负责：读文件、算 sha256、拼 RunInput（input.ts）。本文件是纯函数，不做 I/O。
 * 第五节写的是 v0.2 的工具与闸门，第六节是来源路径，喂进去会让模型调用不存在的工具，所以截掉。
 */

/** 题面结构：标题、一至四节、以及拼接好的喂入正文。 */
export interface TaskBody {
  /** 标题行原文（含 `# `）。 */
  readonly title: string;
  /** 一至四节，按原文顺序；每节含序号（一/二/三/四）、标题行原文与正文原文。 */
  readonly sections: readonly TaskSection[];
  /** 实际喂给模型的正文：标题 + 一至四节（保留原格式）。 */
  readonly text: string;
}

export interface TaskSection {
  /** 中文序号：一 / 二 / 三 / 四。 */
  readonly numeral: string;
  /** 标题行原文，如 `## 二、forbidden（禁止项）`。 */
  readonly heading: string;
  /** 该节正文原文（不含标题行，首尾已去空行）。 */
  readonly body: string;
}

/** 必须出现的四节，顺序固定。 */
const REQUIRED = ['一', '二', '三', '四'] as const;

/** `## 一、…` 这类节标题；只认中文序号。 */
const HEADING = /^##[ \t]+([一二三四五六七八九十]+)[、.]/;

/** 路径中含 `/sealed/` 一律拒绝（AGENT-SPEC §2.1）。 */
export function assertTaskPath(path: string): void {
  if (path.includes('/sealed/')) {
    throw new Error(`题目路径含 /sealed/，拒绝读取密封题：${path}`);
  }
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** 去掉首尾空行，保留内部空行（正文逐字保留）。 */
function trimBlankLines(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start] ?? '')) start += 1;
  while (end > start && isBlank(lines[end - 1] ?? '')) end -= 1;
  return lines.slice(start, end).join('\n');
}

/**
 * 截取标题 + 一至四节。缺标题或任一必需节时报错，不猜。
 * 元信息引用块（`>` 开头）与五、六节不喂给模型。
 */
export function extractTaskBody(md: string): TaskBody {
  const lines = md.split('\n');
  const titleIndex = lines.findIndex((line) => line.startsWith('# '));
  if (titleIndex === -1) throw new Error('题面没有一级标题（`# …`），无法截取');
  const title = lines[titleIndex] ?? '';

  const headings = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const match = HEADING.exec(lines[i] ?? '');
    const numeral = match?.[1];
    if (numeral !== undefined && !headings.has(numeral)) headings.set(numeral, i);
  }

  const missing = REQUIRED.filter((n) => !headings.has(n));
  if (missing.length > 0) {
    throw new Error(`题面缺少必需章节：${missing.map((n) => `## ${n}、…`).join('、')}；缺节不猜，拒绝截取`);
  }

  // 喂入范围：标题行起，到第五节（若有）为止；五、六节与引用块截掉。
  const fiveIndex = headings.get('五');
  const end = fiveIndex ?? lines.length;
  const fedLines = lines.slice(titleIndex, end).filter((line) => !line.startsWith('>'));
  let text = fedLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  if (!text.endsWith('\n')) text += '\n';

  const sections: TaskSection[] = REQUIRED.map((numeral) => {
    const start = headings.get(numeral) ?? 0;
    const next = sectionsNext(headings, numeral, end);
    const heading = lines[start] ?? '';
    return { numeral, heading, body: trimBlankLines(lines.slice(start + 1, next)) };
  });

  return { title, sections, text };
}

/** 该节的结束行：下一个中文序号节的起始行，或喂入范围末尾。 */
function sectionsNext(headings: ReadonlyMap<string, number>, numeral: string, end: number): number {
  const order = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const at = order.indexOf(numeral);
  for (const next of order.slice(at + 1)) {
    const index = headings.get(next);
    if (index !== undefined) return Math.min(index, end);
  }
  return end;
}
