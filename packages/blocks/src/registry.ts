/**
 * 方块注册表（纯函数入口，docs/BLOCKS-SPEC.md）：校验注入的两份方块数据互相一致，
 * 生成 @pg/core 的方块表，并按方块给出中文名、形态、材质族、颜色、发光等信息。
 *
 * 负责：数据校验与查询。不负责：读文件（load.ts）、按颜色找方块、"实心"判断（@pg/analysis 用消费方口径）。
 * 本文件是纯函数：Node 与浏览器都能用，ESLint 的 pureFiles 规则强制。
 */

import { z } from 'zod';

import { createBlockTable } from '@pg/core/block-state';
import type { BlockState, BlockTable } from '@pg/core/block-state';
import { CoreError } from '@pg/core/coord';

export const SHAPES = [
  'cube',
  'plant',
  'light',
  'glass',
  'slab',
  'stairs',
  'fence',
  'fence_gate',
  'wall',
  'pane',
  'door',
  'trapdoor',
  'button',
  'pressure_plate',
  'carpet',
  'sheet',
  'fluid',
  'other',
] as const;

export const FAMILIES = [
  'wood',
  'leaves',
  'plant',
  'metal',
  'misc',
  'gem',
  'nether',
  'stone',
  'light',
  'wool',
  'concrete',
  'terracotta',
  'shulker',
  'glass',
  'blackstone',
  'ice',
  'coral',
  'mushroom',
  'liquid',
  'sculk',
  'deepslate',
  'quartz',
  'sand',
  'soil',
  'ore',
  'redstone',
  'prismarine',
  'end',
  'honey',
  'slime',
] as const;

export type Shape = (typeof SHAPES)[number];
export type Family = (typeof FAMILIES)[number];

export type BlockColor =
  /** 技术方块与拼装块（旗帜、床、蜡烛蛋糕）：没有单一颜色。 */
  | { readonly source: 'none' }
  | {
      readonly source: 'texture' | 'tint' | 'brightest' | 'opaque';
      /** 0xRRGGBB */
      readonly rgb: number;
      readonly confidence: 'high' | 'medium' | 'low';
    };

export interface BlockInfo {
  readonly id: string;
  /** 官方中文名。注意有重名（如 black_banner 与 black_wall_banner），不能反查 id。 */
  readonly zh: string;
  readonly shape: Shape;
  readonly family: Family;
  readonly color: BlockColor;
  /** 0–15，该方块任一状态下的最大值，不随状态变化（熄灭的营火也是 15）。 */
  readonly luminance: number;
  /** minecraft-data 的 transparent；不能用来判断相邻面要不要画（台阶、楼梯是 false）。 */
  readonly transparent: boolean;
}

export type BlocksErrorCode = 'invalid-registry' | 'unknown-block';

export class BlocksError extends Error {
  readonly code: BlocksErrorCode;

  constructor(code: BlocksErrorCode, message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'BlocksError';
    this.code = code;
  }
}

const recordSchema = z.object({
  id: z.string().min(1),
  zh: z.string().min(1),
  shape: z.enum(SHAPES),
  family: z.enum(FAMILIES),
  color: z.number().int().min(0).max(0xffffff).nullable(),
  colorSource: z.enum(['texture', 'tint', 'brightest', 'opaque', 'none']),
  colorConfidence: z.enum(['high', 'medium', 'low']),
  props: z.object({
    luminance: z.number().int().min(0).max(15),
    transparent: z.boolean(),
    waterloggable: z.boolean(),
  }),
});

const registrySchema = z.array(recordSchema).min(1);

type RawRecord = z.infer<typeof recordSchema>;

/** 只取一致性检查要用的部分；完整校验由 core 的 createBlockTable 做。 */
const statesShape = z.object({
  blocks: z.array(z.object({ name: z.string(), properties: z.array(z.object({ name: z.string() })) })),
});

const MAX_LISTED = 5;

function invalid(problems: readonly string[], cause?: unknown): BlocksError {
  const shown = problems.slice(0, MAX_LISTED).join('；');
  const more =
    problems.length > MAX_LISTED ? `（共 ${String(problems.length)} 条，只列前 ${String(MAX_LISTED)} 条）` : '';
  return new BlocksError(
    'invalid-registry',
    `方块数据不合法：${shown}${more}`,
    cause === undefined ? undefined : { cause },
  );
}

function toInfo(r: RawRecord): BlockInfo {
  const color: BlockColor =
    r.colorSource === 'none' || r.color === null
      ? { source: 'none' }
      : { source: r.colorSource, rgb: r.color, confidence: r.colorConfidence };
  return Object.freeze({
    id: r.id,
    zh: r.zh,
    shape: r.shape,
    family: r.family,
    color: Object.freeze(color),
    luminance: r.props.luminance,
    transparent: r.props.transparent,
  });
}

/** 两份数据之间与 blocks.json 内部的一致性检查（BLOCKS-SPEC §5）。返回问题列表，空表示通过。 */
function consistencyProblems(states: z.infer<typeof statesShape>, records: readonly RawRecord[]): string[] {
  const problems: string[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const prev = records[i - 1]?.id ?? '';
    const cur = records[i]?.id ?? '';
    if (!(prev < cur)) problems.push(`blocks.json 第 ${String(i)} 项 ${cur} 未按 id 码点严格升序（或重复）`);
  }
  const waterlogged = new Map(
    states.blocks.map((b) => [b.name, b.properties.some((p) => p.name === 'waterlogged')] as const),
  );
  const ids = new Set(records.map((r) => r.id));
  for (const name of waterlogged.keys()) {
    if (!ids.has(name)) problems.push(`${name} 在 block-states 里有，在 blocks.json 里没有`);
  }
  for (const r of records) {
    const hasWaterlogged = waterlogged.get(r.id);
    if (hasWaterlogged === undefined) {
      problems.push(`${r.id} 在 blocks.json 里有，在 block-states 里没有`);
      continue;
    }
    if ((r.color === null) !== (r.colorSource === 'none')) {
      problems.push(
        `${r.id}：color 为 null 当且仅当 colorSource 为 none（实际 color=${String(r.color)}，colorSource=${r.colorSource}）`,
      );
    }
    if (r.props.waterloggable !== hasWaterlogged) {
      problems.push(
        `${r.id}：waterloggable=${String(r.props.waterloggable)}，但 block-states 里${hasWaterlogged ? '有' : '没有'} waterlogged 属性`,
      );
    }
  }
  return problems;
}

export class BlockRegistry {
  /** 交给 @pg/core 的方块表。 */
  readonly table: BlockTable;
  readonly #byId: ReadonlyMap<string, BlockInfo>;
  readonly #ids: readonly string[];

  constructor(table: BlockTable, infos: readonly BlockInfo[]) {
    this.table = table;
    this.#byId = new Map(infos.map((b) => [b.id, b]));
    this.#ids = Object.freeze(infos.map((b) => b.id));
  }

  /** 按规范 id 精确查找（无前缀、小写；不做容错，容错请先经 core 的 parseState）。 */
  get(id: string): BlockInfo | undefined {
    return this.#byId.get(id);
  }

  /** 按规范化后的 state.name 查找；三种空气都得到 air 的记录。state 不属于本注册表时报 unknown-block。 */
  info(state: BlockState): BlockInfo {
    const found = this.#byId.get(state.name);
    if (found === undefined) {
      throw new BlocksError('unknown-block', `方块 ${state.name} 不在本注册表里：这个方块状态可能出自另一张方块表`);
    }
    return found;
  }

  /** 全部方块 id，按码点升序。 */
  ids(): readonly string[] {
    return this.#ids;
  }
}

/** 校验并组合两份方块数据：`states` 是 block-states.json 的结构，`registry` 是 v0.2 blocks.json 的结构。 */
export function createRegistry(states: unknown, registry: unknown): BlockRegistry {
  let table: BlockTable;
  try {
    table = createBlockTable(states);
  } catch (e) {
    if (e instanceof CoreError) throw invalid([`block-states：${e.message}`], e);
    throw e;
  }
  // createBlockTable 已通过，这里的结构一定满足；再解析一次只为拿到有类型的数据。
  const shape = statesShape.parse(states);
  const parsed = registrySchema.safeParse(registry);
  if (!parsed.success) {
    throw invalid(parsed.error.issues.map((i) => `blocks.json ${i.path.join('.') || '(根)'}：${i.message}`));
  }
  const problems = consistencyProblems(shape, parsed.data);
  if (problems.length > 0) throw invalid(problems);
  return new BlockRegistry(table, parsed.data.map(toInfo));
}
