/* eslint-disable max-lines -- 三个只读数据源的解析、匹配与截断同属一个工具；拆分会让常量路径与预算分散。 */
/**
 * `reference`（W11-03）：按需查 API 局部声明或方块用法。
 *
 * 负责：`scope:'api'` 从 `generated/WORLD-API-GENERATED.md`（说明 / 状态）与
 *   `packages/geometry/world.d.ts`（局部声明）按符号名返回一段参考；`scope:'block'` 从
 *   `docs/MC-BLOCK-CAPABILITIES.md` 按方块 id / 中文名 / 类别返回局部条目与组合用法。
 * 不负责：执行代码、访问网络、写文件、读用户给的路径；查询只用于内存匹配，永不拼路径。
 *
 * 所有数据源都是仓库内常量路径；解析在模块加载时完成一次，输出只由入参与文件内容决定，
 * 因此同一次运行内逐字节稳定。结果按固定预算截断，并明确标注“已截断”。
 */

import { readFileSync } from 'node:fs';

import { MAX_REFERENCE_QUERY_CHARS } from './schemas.ts';

/** 单次 api 参考的字符上限（约 800 token）。 */
export const MAX_API_REFERENCE_CHARS = 2500;
/** 单次 block 参考的字符上限（约 500 token）。 */
export const MAX_BLOCK_REFERENCE_CHARS = 1500;
/** 固定提示：参考只教调用，不覆盖合同与设计。 */
export const REFERENCE_DISCLAIMER = '这只是参考；实际值以 BuildSheet 为准，形态/材质以题面/design 为准。';

/** prompt L3 方块索引承诺的类别；reference(block, category) 必须逐类可用。 */
export const BLOCK_REFERENCE_CATEGORIES = [
  '石',
  '木',
  '玻璃',
  '屋面',
  '照明',
  '家具',
  '景观',
  '透明',
  '植被',
  '对比色',
] as const;

/**
 * 类别到目录条目的显式映射。目录由生成器产出，不能在这里改；缺少颜色 / 植被字段时
 * 用人工维护的小集合补足，并在结果里说明目录边界。
 */
const BLOCK_CATEGORY_IDS: Readonly<Record<string, readonly string[]>> = {
  石: ['stone_bricks', 'stone_brick_slab', 'stone_brick_stairs', 'stone_brick_wall', 'andesite_wall'],
  木: ['oak_planks', 'oak_slab', 'oak_stairs', 'oak_fence', 'oak_door'],
  玻璃: ['glass', 'glass_pane'],
  屋面: ['deepslate_tiles', 'stone_bricks', 'oak_planks'],
  照明: ['lantern', 'torch', 'campfire'],
  家具: ['barrel', 'chest', 'bookshelf', 'lectern', 'red_bed'],
  景观: ['flower_pot', 'hay_block'],
  透明: ['glass', 'glass_pane', 'oak_trapdoor', 'ladder', 'lantern'],
  植被: ['flower_pot', 'hay_block'],
  对比色: ['white_wool', 'white_carpet', 'deepslate_tiles', 'stone_bricks'],
};

const BLOCK_CATEGORY_NOTES: Readonly<Record<string, string>> = {
  屋面: '目录没有独立屋面标签；这里列可作坡面 / 屋脊主材的整块方块，具体以 BuildSheet 材质为准。',
  景观: '目录只收录少量景观 / 陈设方块；室外铺装与植被仍按设计意图补。',
  植被: '当前目录没有树叶 / 草方块，只有盆栽载体与干草；不要把这里当完整植被库。',
  对比色: '目录没有颜色 / 明度字段；这里按深浅对比列代表方块，先看实际色再选。',
};

const TRUNCATED = '…（已截断；用更具体的 query 缩小范围）';
const API_MD_URL = new URL('../../../../generated/WORLD-API-GENERATED.md', import.meta.url);
const WORLD_DTS_URL = new URL('../../../geometry/world.d.ts', import.meta.url);
const BLOCKS_MD_URL = new URL('../../../../docs/MC-BLOCK-CAPABILITIES.md', import.meta.url);

export interface ReferenceInput {
  /** 允许传 string：schema 已限定 api / block，实现仍对越界值给可行动错误。 */
  readonly scope: string;
  readonly query: string;
}

export interface ReferenceResult {
  readonly status: 'ok' | 'not-found' | 'invalid-args';
  readonly text: string;
}

interface ApiSection {
  readonly title: string;
  readonly description: string;
  readonly status: string;
}

interface ApiEntry {
  readonly name: string;
  readonly kind: 'method' | 'type' | 'interface' | 'function' | 'const';
  readonly description: string;
  readonly text: string;
}

interface ApiIndex {
  readonly entries: readonly ApiEntry[];
  readonly sections: ReadonlyMap<string, ApiSection>;
}

interface BlockEntry {
  readonly id: string;
  readonly chinese: string;
  readonly shape: string;
  readonly states: string;
  readonly transparent: string;
  readonly light: string;
  readonly collision: string;
  readonly tags: string;
}

interface BlockUsage {
  readonly title: string;
  readonly body: string;
  readonly blockIds: readonly string[];
}

interface BlockIndex {
  readonly blocks: readonly BlockEntry[];
  readonly usages: readonly BlockUsage[];
}

/** 常用符号的一行用法提示；未列出的符号给通用提示。 */
const API_USAGE = new Map<string, string>([
  ['rect', 'rect(minX, minZ, maxX, maxZ) 生成 Footprint；x1 / z1 是最后一格，BuildSheet 的半开 max 要减 1。'],
  [
    'floorPlate',
    'w.floorPlate({ footprint, y, thickness?, material } | { in, thickness?, material })；返回 bounds / top / region。',
  ],
  [
    'walls',
    'w.walls({ on, height, material, ... } | { footprint, y, height, material, ... })；墙厚向内，返回 facade(side) / storey(i)。',
  ],
  [
    'opening',
    'w.opening({ in: facade, kind, width, height, sill?, at?, fill?, frame?, mullion?, repeat? })；at 相对立面中点，sill 相对墙底。',
  ],
  [
    'roof',
    'w.roof({ on | footprint, kind, ridge / high?, peakY? | pitch?, overhang?, material })；peakY 与 pitch 二选一。',
  ],
  ['stair', 'w.stair({ from, to, at, facing?, kind, width?, material })；from / to 是站立面锚点。'],
  ['steps', 'w.steps({ to: 门洞或 plinth.edge(side), width, material })；自动接齐入口。'],
  ['plinth', 'w.plinth({ footprint, y?, height, project?, material })；顶部用 base.top。'],
  ['colonnade', 'w.colonnade({ on | footprint, height, column, spacing? / count?, ... })；返回 top / bays。'],
  ['rail', 'w.rail({ on, ... })；沿平台外缘围合，门洞 / 梯道自动留通路。'],
  ['enclosure', 'w.enclosure({ ... })；返回 inner / gate / gatehouse。'],
  ['paving', 'w.paving({ ... })；铺在 y=1。'],
  ['box', 'w.box(from, to, block, layer?)；from / to 是闭区间格坐标。'],
  ['set', 'w.set(x, y, z, block, layer?)；单格写入。'],
  ['get', 'w.get(x, y, z) 返回最终方块字符串。'],
  ['massingImport', "w.massingImport('massing#N', options?)；先由 massing 工具登记文档。"],
  ['surfaceShell', "w.surfaceShell({ kind: 'surface' | 'revolve', ... })；参数化壳，写结构层。"],
]);

/** 读取可选数据源；文件缺失时退化为空索引，不阻断 run。 */
function readOptional(url: URL): string {
  try {
    return readFileSync(url, 'utf8');
  } catch {
    return '';
  }
}

function hasControlChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

/** 从 JSDoc 里取第一行说明。 */
function docLine(statement: string): string {
  const match = /\/\*\*\s*([^*\n]+)/.exec(statement);
  return match?.[1]?.trim() ?? '';
}

/** 跳到 `{` 对应的 `}`；跳过字符串与注释。 */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
    } else if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 顶层声明结束的 `;`（跳过字符串、注释与嵌套括号）。 */
function statementEnd(text: string, start: number): number {
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
    } else if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      brace += 1;
    } else if (ch === '}') {
      brace -= 1;
    } else if (ch === '(') {
      paren += 1;
    } else if (ch === ')') {
      paren -= 1;
    } else if (ch === '[') {
      bracket += 1;
    } else if (ch === ']') {
      bracket -= 1;
    } else if (ch === ';' && brace === 0 && paren === 0 && bracket === 0) {
      return i;
    }
  }
  return -1;
}

/** 把 interface World 的成员拆成独立语句（成员里的嵌套对象 / 注释不会误切）。 */
function splitStatements(body: string): string[] {
  const out: string[] = [];
  let start = 0;
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? '';
    const next = body[i + 1] ?? '';
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
    } else if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      brace += 1;
    } else if (ch === '}') {
      brace -= 1;
    } else if (ch === '(') {
      paren += 1;
    } else if (ch === ')') {
      paren -= 1;
    } else if (ch === '[') {
      bracket += 1;
    } else if (ch === ']') {
      bracket -= 1;
    } else if (ch === ';' && brace === 0 && paren === 0 && bracket === 0) {
      const statement = body.slice(start, i + 1).trim();
      if (statement !== '') out.push(statement);
      start = i + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail !== '') out.push(tail);
  return out;
}

/** generated/WORLD-API-GENERATED.md 的 `## 名称` 段：拿说明与状态。 */
function parseApiSections(markdown: string): Map<string, ApiSection> {
  const sections = new Map<string, ApiSection>();
  let title: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (title === null) return;
    const lines = body.map((line) => line.trim()).filter((line) => line !== '');
    const at = lines.findIndex((line) => line.startsWith('状态：'));
    const description = (lines.find((line) => !line.startsWith('状态：')) ?? '').replace(/。$/, '');
    const status = (at === -1 ? '' : (lines[at] ?? '')).replace(/^状态：/, '');
    sections.set(title.toLowerCase(), { title, description, status });
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      flush();
      title = line.slice(3).trim();
      body = [];
    } else if (title !== null) {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/** 从 world.d.ts 抽顶层声明与 World 方法；BlockName 大联合不进索引。 */
function parseApiEntries(source: string): { entries: ApiEntry[]; methods: string[] } {
  const entries: ApiEntry[] = [];
  const methods: string[] = [];
  const skip = new Set(['BlockName', 'StairBlockName', 'brand']);
  let i = 0;
  while (i < source.length) {
    const lineEnd = source.indexOf('\n', i);
    const line = source.slice(i, lineEnd === -1 ? source.length : lineEnd);
    const match = /^(interface|type|declare function|declare const)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match === null) {
      i = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    const keyword = match[1] ?? '';
    const name = match[2] ?? '';
    let end: number;
    if (keyword === 'interface') {
      const open = source.indexOf('{', i);
      const close = open === -1 ? -1 : matchingBrace(source, open);
      end = close === -1 ? source.length : close + 1;
    } else {
      const semi = statementEnd(source, i);
      end = semi === -1 ? source.length : semi + 1;
    }
    if (!skip.has(name) && name !== 'World') {
      const raw = source.slice(i, end).trim();
      entries.push({
        name,
        kind:
          keyword === 'interface'
            ? 'interface'
            : keyword === 'type'
              ? 'type'
              : keyword === 'declare function'
                ? 'function'
                : 'const',
        description: docLine(raw),
        text: raw,
      });
    }
    if (keyword === 'interface' && name === 'World') {
      const open = source.indexOf('{', i);
      const close = matchingBrace(source, open);
      const body = source.slice(open + 1, close);
      for (const statement of splitStatements(body)) {
        const method = /^(?:\/\*\*[\s\S]*?\*\/\s*)?([A-Za-z_$][\w$]*)\s*\(/.exec(statement);
        const methodName = method?.[1];
        if (methodName === undefined) continue;
        methods.push(methodName);
        entries.push({
          name: methodName,
          kind: 'method',
          description: docLine(statement),
          text: `interface World {\n${indent(statement.trimStart(), 2)}\n}`,
        });
      }
      entries.push({
        name: 'World',
        kind: 'interface',
        description: '世界入口：在 build(w: World) 中调用下列构件。',
        text: `interface World {\n  // 方法：${methods.join(', ')}\n}`,
      });
    }
    i = end;
  }
  return { entries, methods };
}

function loadApiIndex(): ApiIndex {
  const sections = parseApiSections(readOptional(API_MD_URL));
  const { entries } = parseApiEntries(readOptional(WORLD_DTS_URL));
  return { entries, sections };
}

function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? '';
    if (ch === '\\' && line[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (ch === '`') {
      inCode = !inCode;
      current += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells;
}

function cleanCell(cell: string): string {
  return cell.replaceAll('`', '').replaceAll('<br>', '；').replace(/\s+/g, ' ').trim();
}

function parseBlocks(markdown: string): BlockEntry[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## 方块表');
  if (start === -1) return [];
  const blocks: BlockEntry[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('## ')) break;
    if (!line.startsWith('|')) continue;
    const cells = splitTableRow(line);
    const id = cleanCell(cells[0] ?? '');
    if (!/^[a-z0-9_]+$/.test(id)) continue;
    blocks.push({
      id,
      chinese: cleanCell(cells[1] ?? ''),
      shape: cleanCell(cells[2] ?? ''),
      states: cleanCell(cells[3] ?? ''),
      transparent: cleanCell(cells[4] ?? ''),
      light: cleanCell(cells[5] ?? ''),
      collision: cleanCell(cells[7] ?? ''),
      tags: cleanCell(cells[8] ?? ''),
    });
  }
  return blocks;
}

function parseBlockUsages(markdown: string): BlockUsage[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## 常见组合用法');
  if (start === -1) return [];
  const usages: BlockUsage[] = [];
  let title: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (title === null) return;
    const text = body.join('\n').trim();
    const ids = [...text.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1] ?? '');
    usages.push({ title, body: text, blockIds: [...new Set(ids)].sort(compareText) });
  };
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('## ')) break;
    if (line.startsWith('### ')) {
      flush();
      title = line.slice(4).trim();
      body = [];
    } else if (title !== null) {
      body.push(line);
    }
  }
  flush();
  return usages;
}

function loadBlockIndex(): BlockIndex {
  const markdown = readOptional(BLOCKS_MD_URL);
  return { blocks: parseBlocks(markdown), usages: parseBlockUsages(markdown) };
}

const API_INDEX = loadApiIndex();
const BLOCK_INDEX = loadBlockIndex();

const API_SECTION_BY_NAME = new Map<string, ApiSection>();
for (const [key, section] of API_INDEX.sections) API_SECTION_BY_NAME.set(key, section);

function editDistance(a: string, b: string): number {
  const left = a.slice(0, 80);
  const right = b.slice(0, 80);
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function similarity(query: string, candidate: string): number {
  const a = query.toLowerCase();
  const b = candidate.toLowerCase();
  if (a === b) return 1;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length, 1);
}

function textScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const value = text.toLowerCase();
  if (value === q) return 1000;
  if (value.startsWith(q)) return 700 - Math.min(200, Math.max(0, value.length - q.length));
  if (value.includes(q)) return 500 - Math.min(200, Math.max(0, value.length - q.length));
  if (q.length < 2 || value.length > 60) return 0;
  const score = similarity(q, value);
  return score >= 0.7 ? Math.round(score * 300) : 0;
}

/** 符号匹配不做模糊：拼错时走候选列表，避免把“walss”当成 walls 返回一整页声明。 */
function directScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const value = text.toLowerCase();
  if (value === q) return 1000;
  if (value.startsWith(q)) return 700 - Math.min(200, Math.max(0, value.length - q.length));
  if (value.includes(q)) return 500 - Math.min(200, Math.max(0, value.length - q.length));
  return 0;
}

function sectionFor(name: string): ApiSection | undefined {
  return API_SECTION_BY_NAME.get(name.toLowerCase());
}

function usageFor(entry: ApiEntry): string {
  if (entry.name === 'World') return '在 build(w: World) 中调用 w.<method>(...)；方法列表见声明。';
  const specific = API_USAGE.get(entry.name);
  if (specific !== undefined) return specific;
  if (entry.kind === 'method') return `w.${entry.name}(...)；参数名、可选值与返回句柄见下方声明。`;
  if (entry.kind === 'type' || entry.kind === 'interface')
    return '作为 World 构件调用的参数类型；必填与互斥字段见声明。';
  return '直接调用；参数与返回类型见声明。';
}

function apiCandidates(query: string): string[] {
  const names = [
    ...new Set([
      ...API_INDEX.entries.map((entry) => entry.name),
      ...[...API_INDEX.sections.values()].map((section) => section.title),
    ]),
  ];
  return names
    .map((name) => ({ name, score: similarity(query, name) }))
    .sort((a, b) => b.score - a.score || compareText(a.name, b.name))
    .slice(0, 3)
    .map((item) => item.name);
}

function findApi(query: string): { entry: ApiEntry; related?: ApiEntry } | null {
  const scored: { entry: ApiEntry; score: number }[] = [];
  for (const entry of API_INDEX.entries) {
    const section = sectionFor(entry.name);
    let score = directScore(query, entry.name);
    if (entry.name === query) score += 5;
    if (section !== undefined) score = Math.max(score, directScore(query, section.description));
    if (entry.description !== '') score = Math.max(score, directScore(query, entry.description));
    if (score > 0) scored.push({ entry, score });
  }
  const kindRank = (entry: ApiEntry): number =>
    entry.kind === 'method' ? 0 : entry.kind === 'function' ? 1 : entry.kind === 'type' ? 2 : 3;
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      kindRank(a.entry) - kindRank(b.entry) ||
      a.entry.name.length - b.entry.name.length ||
      compareText(a.entry.name, b.entry.name),
  );
  const best = scored[0]?.entry;
  if (best === undefined) return null;
  const relatedName = `${best.name}Options`;
  const related = API_INDEX.entries.find((entry) => entry.name === relatedName);
  return related === undefined ? { entry: best } : { entry: best, related };
}

function renderApi(query: string): ReferenceResult {
  const found = findApi(query);
  if (found === null) {
    const candidates = apiCandidates(query);
    const lines = [
      `## API · 未找到「${clip(query, 40)}」`,
      '',
      '没有找到匹配的符号或构件标题。',
      `候选：${candidates.join('、')}`,
      "提示：用构件名 / 类型名查询，如 reference({scope:'api', query:'walls'})。",
      '',
      REFERENCE_DISCLAIMER,
    ];
    return { status: 'not-found', text: lines.join('\n') };
  }
  const { entry, related } = found;
  const section = sectionFor(entry.name);
  const parts: string[] = [];
  const description = section?.description === '' ? entry.description : (section?.description ?? entry.description);
  if (description !== '') parts.push(`说明：${clip(description, 240)}`);
  if (section !== undefined && section.status !== '') parts.push(`状态：${section.status}`);
  parts.push(`用法：${usageFor(entry)}`);
  parts.push(`\`\`\`ts\n${entry.text}\n\`\`\``);
  if (related !== undefined) parts.push(`相关参数类型：\n\`\`\`ts\n${related.text}\n\`\`\``);
  const title =
    entry.name.toLowerCase() === query.toLowerCase()
      ? `API · ${entry.name}`
      : `API · ${entry.name}（查询：${clip(query, 40)}）`;
  return { status: 'ok', text: render(title, parts.join('\n\n'), MAX_API_REFERENCE_CHARS) };
}

function blockLine(block: BlockEntry): string {
  const states = block.states === '' || block.states === '—' ? '' : `；状态：${clip(block.states, 170)}`;
  const tags = block.tags === '' || block.tags === '—' ? '' : `；标签：${clip(block.tags, 60)}`;
  return `- \`${block.id}\`（${block.chinese}，${block.shape}）：${block.collision}${states}${tags}`;
}

function blockCandidates(query: string): string[] {
  return BLOCK_INDEX.blocks
    .map((block) => ({
      id: block.id,
      label: `${block.id}（${block.chinese}）`,
      score: Math.max(similarity(query, block.id), similarity(query, block.chinese)),
    }))
    .sort((a, b) => b.score - a.score || compareText(a.id, b.id))
    .slice(0, 3)
    .map((item) => item.label);
}

function renderBlockCategory(query: string): ReferenceResult | null {
  const ids = BLOCK_CATEGORY_IDS[query];
  if (ids === undefined) return null;
  const blocks = ids
    .map((id) => BLOCK_INDEX.blocks.find((block) => block.id === id))
    .filter((block): block is BlockEntry => block !== undefined);
  const matchedIds = new Set(blocks.map((block) => block.id));
  const usages = BLOCK_INDEX.usages.filter((usage) => usage.blockIds.some((id) => matchedIds.has(id))).slice(0, 2);
  const parts: string[] = [];
  const note = BLOCK_CATEGORY_NOTES[query];
  if (note !== undefined) parts.push(`说明：${note}`);
  if (blocks.length > 0) {
    parts.push('方块：');
    for (const block of blocks.slice(0, 6)) parts.push(blockLine(block));
  }
  if (usages.length > 0) {
    parts.push('组合用法：');
    for (const usage of usages) parts.push(`### ${usage.title}\n${clip(usage.body, 620)}`);
  }
  if (parts.length === 0) {
    parts.push(`该类别暂无条目；先用 reference({scope:'block', query:'<方块 id>'}) 查具体方块。`);
  }
  return { status: 'ok', text: render(`Block · 类别：${query}`, parts.join('\n\n'), MAX_BLOCK_REFERENCE_CHARS) };
}

function renderBlock(query: string): ReferenceResult {
  const category = renderBlockCategory(query);
  if (category !== null) return category;
  const q = query.toLowerCase();
  const scoredBlocks = BLOCK_INDEX.blocks
    .map((block) => ({
      block,
      score: Math.max(
        textScore(q, block.id),
        textScore(q, block.chinese),
        textScore(q, block.shape),
        textScore(q, block.tags),
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || compareText(a.block.id, b.block.id));
  const matchedIds = new Set(scoredBlocks.map((item) => item.block.id));

  const scoredUsages = BLOCK_INDEX.usages
    .map((usage) => {
      let score = textScore(q, usage.title);
      if (usage.blockIds.includes(q)) score = Math.max(score, 800);
      if (usage.body.toLowerCase().includes(q)) score = Math.max(score, 300);
      return { usage, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || compareText(a.usage.title, b.usage.title));

  const usages: BlockUsage[] = [];
  for (const item of scoredUsages) {
    usages.push(item.usage);
    if (usages.length >= 3) break;
  }
  for (const usage of BLOCK_INDEX.usages) {
    if (usages.length >= 3) break;
    if (usages.includes(usage)) continue;
    if (usage.blockIds.some((id) => matchedIds.has(id))) usages.push(usage);
  }
  if (usages.length === 0 && scoredBlocks.length > 0) {
    // 精确方块查询没有组合用法时，仍给出该方块自身条目。
  }

  if (scoredBlocks.length === 0 && usages.length === 0) {
    const candidates = blockCandidates(query);
    const lines = [
      `## Block · 未找到「${clip(query, 40)}」`,
      '',
      '没有找到匹配的方块 id、中文名、形状或组合用法。',
      `候选：${candidates.join('、')}`,
      "提示：用方块 id / 中文名 / 类别查询，如 reference({scope:'block', query:'楼梯'})。",
      '',
      REFERENCE_DISCLAIMER,
    ];
    return { status: 'not-found', text: lines.join('\n') };
  }

  const parts: string[] = [];
  if (scoredBlocks.length > 0) {
    parts.push('方块：');
    for (const item of scoredBlocks.slice(0, 4)) parts.push(blockLine(item.block));
  }
  if (usages.length > 0) {
    parts.push('组合用法：');
    for (const usage of usages) parts.push(`### ${usage.title}\n${clip(usage.body, 620)}`);
  }
  const exactId = BLOCK_INDEX.blocks.find((block) => block.id === q)?.id;
  const title = exactId === undefined ? `Block · ${clip(query, 40)}` : `Block · ${exactId}`;
  return { status: 'ok', text: render(title, parts.join('\n'), MAX_BLOCK_REFERENCE_CHARS) };
}

/** 统一加标题 / 固定提示，并在超限时截断且明确标注。 */
function render(title: string, body: string, limit: number): string {
  const head = `## ${title}\n\n`;
  const tail = `\n\n${REFERENCE_DISCLAIMER}`;
  const full = `${head}${body}${tail}`;
  if (full.length <= limit) return full;
  const marker = `\n${TRUNCATED}`;
  const room = Math.max(0, limit - head.length - tail.length - marker.length - 4);
  let cut = body.slice(0, room);
  if (cut.length > 0) {
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  }
  if ((cut.match(/```/g)?.length ?? 0) % 2 === 1) cut += '\n```';
  return `${head}${cut}${marker}${tail}`;
}

function invalid(text: string): ReferenceResult {
  return { status: 'invalid-args', text: `${text}\n\n${REFERENCE_DISCLAIMER}` };
}

function normalizeQuery(raw: unknown): { query: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'query 必须是字符串。' };
  const query = raw.trim();
  if (query === '') {
    return { error: "query 不能为空；示例：reference({scope:'api', query:'walls'})。" };
  }
  if (query.length > MAX_REFERENCE_QUERY_CHARS) {
    return {
      error: `query 过长（${String(query.length)} > ${String(MAX_REFERENCE_QUERY_CHARS)} 字符）；一次只查一个符号、方块或类别。`,
    };
  }
  if (query.includes('/') || query.includes('\\') || query.includes('..') || hasControlChars(query)) {
    return { error: 'query 只接受符号名 / 方块名 / 类别，不接受路径或控制字符；没有读取任何文件。' };
  }
  return { query };
}

/** 工具入口：只读、确定性、无网络、无任意路径。 */
export function reference(input: ReferenceInput): ReferenceResult {
  if (input.scope !== 'api' && input.scope !== 'block') {
    return invalid(
      `未知 scope ${JSON.stringify(input.scope)}；可用：api（API 符号 / 构件名）、block（方块 id / 中文名 / 类别）。示例：reference({scope:'api', query:'walls'})。`,
    );
  }
  const normalized = normalizeQuery(input.query);
  if ('error' in normalized) return invalid(normalized.error);
  return input.scope === 'api' ? renderApi(normalized.query) : renderBlock(normalized.query);
}
