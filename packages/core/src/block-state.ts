/**
 * 方块状态：注入方块表、解析 / 校验 / 规范化 / 格式化方块状态字符串（docs/CORE-SPEC.md §1、§3）。
 *
 * 负责：把 `oak_stairs[facing=east]` 这样的文本变成唯一的规范形式，非法输入给出能直接指导修改的报错。
 * 不负责：读方块数据文件（由调用方注入）、方块颜色与中文名（@pg/blocks）。
 */

import { z } from 'zod';

import { CoreError } from './coord.ts';

const ID = /^[a-z0-9_]+$/;
const idString = z.string().regex(ID, '只能含 a-z、0-9、_');

const propertySchema = z
  .object({
    name: idString,
    type: z.enum(['enum', 'bool', 'int']),
    values: z.array(idString).min(1),
    default: idString,
  })
  .refine((p) => p.values.includes(p.default), { message: 'default 不在 values 里' })
  .refine((p) => new Set(p.values).size === p.values.length, { message: 'values 有重复' });

const blockSchema = z
  .object({ name: idString, properties: z.array(propertySchema) })
  .refine((b) => new Set(b.properties.map((p) => p.name)).size === b.properties.length, {
    message: '属性名重复',
  });

const tableSchema = z.object({
  blocks: z
    .array(blockSchema)
    .min(1)
    .refine((bs) => new Set(bs.map((b) => b.name)).size === bs.length, { message: '方块名重复' })
    .refine((bs) => bs.some((b) => b.name === 'air' && b.properties.length === 0), {
      message: '缺少无属性的 air',
    }),
});

interface PropertyDef {
  readonly values: readonly string[];
  readonly default: string;
}

interface BlockDef {
  /** 属性名 → 定义；Map 的迭代顺序就是数据里的顺序，报错时按它列出。 */
  readonly props: ReadonlyMap<string, PropertyDef>;
}

declare const tableBrand: unique symbol;
declare const stateBrand: unique symbol;

/** 注入后的方块表。只能由 {@link createBlockTable} 创建。 */
export interface BlockTable {
  readonly [tableBrand]: true;
  readonly blocks: ReadonlyMap<string, BlockDef>;
}

/** 规范化后的方块状态，不可变。只能由 {@link parseState} 创建，所以拿到的一定合法。 */
export interface BlockState {
  readonly [stateBrand]: true;
  /** 规范方块名：不带 `minecraft:`，三种空气都是 `air`。 */
  readonly name: string;
  /** 只含与默认值不同的属性，键按码点顺序。 */
  readonly props: Readonly<Record<string, string>>;
  /** 规范字符串，等于 `formatState(this)`。 */
  readonly canonical: string;
}

const AIR_NAMES: ReadonlySet<string> = new Set(['air', 'cave_air', 'void_air']);

/** 多于这个数的候选只列前若干个并注明总数（CORE-SPEC §3.2）。 */
const MAX_LISTED = 12;

/** 码点顺序比较；只用于 [a-z0-9_] 这类 ASCII 字符串时与 UTF-16 顺序相同。 */
function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 校验并注入方块数据（`assets/mc-1.20.1/block-states.json` 的结构）。数据不合法时抛 `invalid-block-table`。 */
export function createBlockTable(data: unknown): BlockTable {
  const parsed = tableSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(根)'}：${i.message}`);
    throw new CoreError('invalid-block-table', `方块数据不合法：${issues.join('；')}`);
  }
  const blocks = new Map<string, BlockDef>();
  for (const b of parsed.data.blocks) {
    const props = new Map<string, PropertyDef>();
    for (const p of b.properties) props.set(p.name, { values: p.values, default: p.default });
    blocks.set(b.name, { props });
  }
  // 类型标记只在类型层存在，运行时对象就是这个结构；只有本函数能产生它。
  return { blocks } as unknown as BlockTable;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** 编辑距离最小且 ≤ 2 的唯一候选；没有或不唯一时返回空串。 */
function suggestion(input: string, candidates: Iterable<string>): string {
  let best = '';
  let bestDist = Infinity;
  let tie = false;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestDist) {
      best = c;
      bestDist = d;
      tie = false;
    } else if (d === bestDist) {
      tie = true;
    }
  }
  return bestDist <= 2 && !tie ? `是不是 ${best}？` : '';
}

function listing(items: readonly string[]): string {
  if (items.length <= MAX_LISTED) return items.join(', ');
  return `${items.slice(0, MAX_LISTED).join(', ')} 等（共 ${String(items.length)} 个）`;
}

function syntaxError(text: string, reason: string): CoreError {
  return new CoreError('invalid-state-syntax', `方块状态 ${JSON.stringify(text)} 语法错误：${reason}`);
}

/** 只做语法切分，返回方块 id（去掉前缀）与属性对。 */
function splitSyntax(text: string): { id: string; pairs: [string, string][] } {
  if (/\s/.test(text)) throw syntaxError(text, '不能含空白');
  if (/[A-Z]/.test(text)) throw syntaxError(text, '不能含大写字母');
  const m = /^(?:minecraft:)?([a-z0-9_]+)(?:\[([^[\]]*)\])?$/.exec(text);
  const id = m?.[1];
  if (m === null || id === undefined) {
    throw syntaxError(text, '应为 名字 或 名字[属性=值,…]，名字与属性只能含 a-z、0-9、_');
  }
  const body = m[2] ?? '';
  const pairs: [string, string][] = [];
  if (body === '') return { id, pairs };
  const seen = new Set<string>();
  for (const piece of body.split(',')) {
    if (piece === '') throw syntaxError(text, '属性列表里有空项（多余或末尾的逗号）');
    const pm = /^([a-z0-9_]+)=([a-z0-9_]+)$/.exec(piece);
    const key = pm?.[1];
    const value = pm?.[2];
    if (key === undefined || value === undefined) throw syntaxError(text, `属性 ${JSON.stringify(piece)} 应为 名=值`);
    if (seen.has(key)) throw syntaxError(text, `属性 ${key} 重复`);
    seen.add(key);
    pairs.push([key, value]);
  }
  return { id, pairs };
}

/** 解析、校验并规范化方块状态文本。任何不合法都抛 CoreError，信息里有原因与合法取值。 */
export function parseState(table: BlockTable, text: string): BlockState {
  const { id, pairs } = splitSyntax(text);
  const name = AIR_NAMES.has(id) ? 'air' : id;
  const def = table.blocks.get(name);
  if (def === undefined) {
    const hint = suggestion(id, table.blocks.keys());
    throw new CoreError(
      'unknown-block',
      `未知方块 ${id}（共 ${String(table.blocks.size)} 种方块可用）${hint === '' ? '' : `，${hint}`}`,
    );
  }
  const props: Record<string, string> = {};
  const kept: [string, string][] = [];
  for (const [key, value] of pairs) {
    const pdef = def.props.get(key);
    if (pdef === undefined) {
      const names = [...def.props.keys()];
      const hint = suggestion(key, names);
      throw new CoreError(
        'unknown-property',
        names.length === 0
          ? `方块 ${name} 没有任何属性，不能写 ${key}`
          : `方块 ${name} 没有属性 ${key}；可用属性：${listing(names)}${hint === '' ? '' : `。${hint}`}`,
      );
    }
    if (!pdef.values.includes(value)) {
      const hint = suggestion(value, pdef.values);
      throw new CoreError(
        'invalid-property-value',
        `方块 ${name} 的属性 ${key} 不能取 ${value}；合法取值：${listing(pdef.values)}${hint === '' ? '' : `。${hint}`}`,
      );
    }
    if (value !== pdef.default) kept.push([key, value]);
  }
  kept.sort((a, b) => compareCodePoint(a[0], b[0]));
  for (const [k, v] of kept) props[k] = v;
  const canonical = kept.length === 0 ? name : `${name}[${kept.map(([k, v]) => `${k}=${v}`).join(',')}]`;
  // 同 createBlockTable：类型标记只在类型层存在，本函数是唯一的构造点。
  return Object.freeze({ name, props: Object.freeze(props), canonical }) as unknown as BlockState;
}

/** 规范形式：无前缀、属性按码点排序、省略默认值、无属性时不写方括号。 */
export function formatState(state: BlockState): string {
  return state.canonical;
}

export function isAir(state: BlockState): boolean {
  return state.name === 'air';
}
