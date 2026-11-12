/**
 * 生成方块能力目录：官方 blockstates / models / tags + 人工组合用法。
 *
 * 输入：`.work/mc-assets/1.20.1/`（manifest、blockstates、tags、catalog.json）与仓库方块注册表。
 * 输出（入库，不含版权二进制）：
 *   - assets/mc-1.20.1/block-capabilities.json（机器可读）
 *   - packages/blocks/src/capability-catalog.ts（纯函数入口）
 *   - packages/blocks/src/block-usages.ts（提示词可直接引用的组合用法）
 *   - docs/MC-BLOCK-CAPABILITIES.md（人类可读）
 *
 * 用法：node tools/build-block-catalog.ts
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MC_VERSION = '1.20.1';
const CATALOG_VERSION = 'mc-1.20.1-1';

interface PropertyDef {
  readonly name: string;
  readonly values: readonly string[];
  readonly default: string;
}
interface BlockDef {
  readonly name: string;
  readonly properties: readonly PropertyDef[];
}
interface BlockStatesFile {
  readonly blocks: readonly BlockDef[];
}
interface RegistryBlock {
  readonly id: string;
  readonly zh: string;
  readonly shape: string;
  readonly color: number | null;
  readonly colorSource: string;
  readonly props: {
    readonly transparent: boolean;
    readonly luminance: number;
    readonly solid: boolean;
  };
}
interface ImportManifest {
  readonly mcVersion: string;
  readonly source: { readonly sha256: string; readonly bytes: number; readonly kind: string };
  readonly counts: Readonly<Record<string, number>>;
}
interface UsageSource {
  readonly id: string;
  readonly name: string;
  readonly blocks: readonly string[];
  readonly intent: string;
  readonly how: readonly string[];
  readonly states: readonly string[];
  readonly mistakes: readonly string[];
  readonly bestFor: readonly string[];
}
interface CuratedFile {
  readonly blocks: readonly string[];
  readonly usages: readonly UsageSource[];
}
interface CatalogFile {
  readonly states: Readonly<Record<string, number>>;
  readonly connections: Readonly<Record<string, readonly number[]>>;
  readonly defaults: Readonly<Record<string, number>>;
}
interface BlockCapability {
  readonly id: string;
  readonly zh: string;
  readonly shape: string;
  readonly transparent: boolean;
  readonly luminance: number;
  readonly solid: boolean;
  readonly states: readonly string[];
  readonly defaultState: string;
  readonly placeOn: string;
  readonly support: string;
  readonly collision: string;
  readonly tags: readonly string[];
  readonly officialModel: boolean;
}
interface BlockUsage {
  readonly id: string;
  readonly name: string;
  readonly blocks: readonly string[];
  readonly intent: string;
  readonly how: readonly string[];
  readonly states: readonly string[];
  readonly mistakes: readonly string[];
  readonly bestFor: readonly string[];
}

function root(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function placeOn(shape: string, id: string): string {
  if (shape === 'button') return '墙 / 地面 / 顶面（face=wall|floor|ceiling）';
  if (shape === 'torch' || id.endsWith('_torch')) return '地面 / 墙面';
  if (shape === 'ladder') return '墙面（facing 指离开墙的方向）';
  if (shape === 'sign') return id.includes('wall_') ? '墙面（facing）' : '地面（rotation 0–15）';
  if (shape === 'lantern') return '地面 / 顶面（hanging=true|false）';
  if (id === 'chain') return '顶面（axis=y 垂直悬挂）';
  if (shape === 'carpet' || shape === 'pressure_plate') return '地面 / 实体方块顶面';
  if (shape === 'door' || shape === 'trapdoor' || shape === 'fence_gate') return '地面 / 墙面 / 楼板边';
  if (shape === 'pane' || shape === 'fence' || shape === 'wall') return '地面 / 相邻方块连接';
  if (shape === 'plant') return '地面 / 花盆 / 水面';
  if (shape === 'rail') return '地面（shape 决定走向）';
  return '地面 / 顶面 / 墙面';
}

function support(shape: string): string {
  if (shape === 'button' || shape === 'torch' || shape === 'ladder' || shape === 'sign' || shape === 'rail')
    return '需要附着面；不能悬空';
  if (shape === 'lantern' || shape === 'chain') return '需要顶面或地面承托';
  if (shape === 'plant') return '需要土壤 / 花盆 / 水等附着面';
  if (shape === 'pane' || shape === 'fence' || shape === 'wall') return '需要下方支撑，并依赖相邻方块连接';
  return '需要下方实体支撑';
}

function collision(shape: string, solid: boolean): string {
  if (!solid) return '无完整碰撞（可穿过 / 仅装饰）';
  if (shape === 'slab' || shape === 'stairs' || shape === 'fence' || shape === 'wall' || shape === 'pane')
    return '有碰撞，随形状与连接变化';
  if (shape === 'door' || shape === 'trapdoor' || shape === 'fence_gate') return '有碰撞，随 open 状态变化';
  return '有完整碰撞';
}

function stateSummary(properties: readonly PropertyDef[]): string[] {
  return properties.map((p) => `${p.name}=${p.values.join('|')}（默认 ${p.default}）`);
}

function tagValues(tagDir: string): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  if (!existsSync(tagDir)) return out;
  for (const file of readdirSync(tagDir).sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = readJson(join(tagDir, file)) as { values?: unknown[] };
      out.set(
        file.replace(/\.json$/, ''),
        (parsed.values ?? []).filter((value): value is string => typeof value === 'string'),
      );
    } catch {
      // 标签文件坏了不影响主目录；导入工具已记录哈希。
    }
  }
  return out;
}

function tagContains(
  tags: ReadonlyMap<string, readonly string[]>,
  tag: string,
  id: string,
  seen: Set<string>,
): boolean {
  if (seen.has(tag)) return false;
  seen.add(tag);
  for (const value of tags.get(tag) ?? []) {
    if (value === id || value === `minecraft:${id}`) return true;
    if (value.startsWith('#')) {
      const nested = value.slice(1).replace(/^minecraft:/, '');
      if (tagContains(tags, nested, id, seen)) return true;
    }
  }
  return false;
}

function tagsForBlock(tags: ReadonlyMap<string, readonly string[]>, id: string): string[] {
  const out: string[] = [];
  for (const tag of [...tags.keys()].sort()) {
    if (tagContains(tags, tag, id, new Set())) out.push(tag);
  }
  return out;
}

function ts(value: unknown): string {
  return JSON.stringify(value);
}

function renderCapabilityModule(blocks: readonly BlockCapability[]): string {
  return `/**
 * 方块能力目录（由 tools/build-block-catalog.ts 生成，勿手改）。
 *
 * 数据来源：Minecraft ${MC_VERSION} 官方 blockstates / models / tags + tools/mc/curated-usages.json。
 * 官方资源只在 .work/ 本地使用；本文件只含 id、状态与人工整理事实，不含贴图 / 模型二进制。
 */

export const BLOCK_CAPABILITY_VERSION = ${ts(CATALOG_VERSION)};
export const BLOCK_CAPABILITY_MC_VERSION = ${ts(MC_VERSION)};

export interface BlockCapability {
  readonly id: string;
  readonly zh: string;
  readonly shape: string;
  readonly transparent: boolean;
  readonly luminance: number;
  readonly solid: boolean;
  /** 属性摘要，如 facing=north|east|south|west（默认 north）。 */
  readonly states: readonly string[];
  readonly defaultState: string;
  readonly placeOn: string;
  readonly support: string;
  readonly collision: string;
  readonly tags: readonly string[];
  /** 本机官方资源包里有这个方块的可渲染模型。 */
  readonly officialModel: boolean;
}

export const BLOCK_CAPABILITIES: readonly BlockCapability[] = [
${blocks.map((block) => `  // prettier-ignore\n  ${JSON.stringify(block)},`).join('\n')}
];

const BY_ID = new Map(BLOCK_CAPABILITIES.map((block) => [block.id, block]));

/** 按方块 id 查找；未知 id 返回 undefined。 */
export function blockCapability(id: string): BlockCapability | undefined {
  return BY_ID.get(id);
}

/** 目录内全部方块 id，按码点升序。 */
export function blockCapabilityIds(): readonly string[] {
  return BLOCK_CAPABILITIES.map((block) => block.id);
}
`;
}

function renderUsageModule(usages: readonly BlockUsage[]): string {
  const prompt = [
    `## 官方方块组合目录（Minecraft ${MC_VERSION}）`,
    '',
    '以下做法来自官方 blockstates / models / tags + 人工整理；写家具与细部时优先直接引用，状态要写全。',
    '',
    ...usages.map(
      (usage) =>
        `- ${usage.name}（${usage.blocks.join('、')}）：${usage.intent} 放法：${usage.how.join('；')} 状态：${usage.states.join('；')} 避免：${usage.mistakes.join('；')}`,
    ),
  ].join('\n');
  return `/**
 * 方块组合用法（由 tools/build-block-catalog.ts 生成，勿手改）。
 *
 * 供交互层能力卡 / 设计提示与构建层 craft-small 提示直接引用；
 * 人工源在 tools/mc/curated-usages.json，改那里后重新生成。
 */

export const BLOCK_USAGE_VERSION = ${ts(CATALOG_VERSION)};

export interface BlockUsage {
  readonly id: string;
  readonly name: string;
  readonly blocks: readonly string[];
  readonly intent: string;
  readonly how: readonly string[];
  readonly states: readonly string[];
  readonly mistakes: readonly string[];
  readonly bestFor: readonly string[];
}

export const BLOCK_USAGES: readonly BlockUsage[] = [
${usages.map((usage) => `  ${JSON.stringify(usage)},`).join('\n')}
];

const BY_ID = new Map(BLOCK_USAGES.map((usage) => [usage.id, usage]));

/** 按用法 id 查找。 */
export function blockUsage(id: string): BlockUsage | undefined {
  return BY_ID.get(id);
}

/** 某个方块参与的用法。 */
export function usagesForBlock(blockId: string): readonly BlockUsage[] {
  return BLOCK_USAGES.filter((usage) => usage.blocks.includes(blockId));
}

/** 模型可见的紧凑提示段；交互层设计提示与 craft-small 共用。 */
export const BLOCK_USAGE_PROMPT = ${ts(prompt)};
`;
}

function renderMarkdown(
  blocks: readonly BlockCapability[],
  usages: readonly BlockUsage[],
  manifest: ImportManifest,
): string {
  const cell = (value: string): string => value.replaceAll('|', '\\|');
  const rows = blocks.map(
    (block) =>
      `| \`${block.id}\` | ${cell(block.zh)} | ${cell(block.shape)} | ${cell(block.states.join('<br>') || '—')} | ${block.transparent ? '是' : '否'} | ${String(block.luminance)} | ${cell(block.placeOn)} | ${cell(block.collision)} | ${cell(block.tags.join('<br>') || '—')} | ${block.officialModel ? '官方模型' : 'fallback'} |`,
  );
  const usageSections = usages.map(
    (usage) => `### ${usage.name}

- **用途**：${usage.intent}
- **方块**：${usage.blocks.map((id) => `\`${id}\``).join('、')}
- **怎么放**：
${usage.how.map((line) => `  - ${line}`).join('\n')}
- **状态示例**：${usage.states.map((state) => `\`${state}\``).join('、')}
- **常见错误**：
${usage.mistakes.map((line) => `  - ${line}`).join('\n')}
- **适合**：${usage.bestFor.join('、')}`,
  );
  return `# Minecraft ${MC_VERSION} 方块能力目录

> 由 \`tools/build-block-catalog.ts\` 生成，勿手改。机器可读版本：\`assets/mc-1.20.1/block-capabilities.json\`；
> 交互 / 构建提示引用：\`@pg/blocks/capability-catalog\`、\`@pg/blocks/block-usages\`。
>
> 数据来源：Minecraft ${MC_VERSION} 官方 blockstates / models / block tags（本机 \`.work/mc-assets/${MC_VERSION}/\`）
> + \`tools/mc/curated-usages.json\` 的人工组合用法。官方贴图 / 模型二进制不入库。
> 导入源 sha256：\`${manifest.source.sha256}\`（${String(manifest.source.bytes)} 字节，${manifest.source.kind}）。

## 使用边界

- 状态字符串按 MC 1.20.1；只写与默认值不同的属性，例如 \`oak_stairs[facing=east]\` 等价于 half=bottom、shape=straight。
- “有碰撞”只描述方块自身，不替代结构计算；栏杆、悬挑、跨度仍需在方案里说明。
- 官方模型覆盖 882 个方块；箱子 / 床是 block entity，使用官方 entity 贴图 + 重建盒体，UV 为近似。
- 栅栏 / 玻璃板 / 墙的连接由渲染器按邻居计算；告示牌文字、容器内容、实体家具仍不支持。

## 方块表

| id | 中文 | 形状 | 状态 / 朝向 | 透明 | 发光 | 可放置面 | 碰撞 | 标签 | 渲染 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## 常见组合用法

${usageSections.join('\n\n')}
`;
}

/** 生成并写四份产物；返回统计。 */
export function buildBlockCatalog(): { blocks: number; usages: number } {
  const repo = root();
  const assets = join(repo, '.work', 'mc-assets', MC_VERSION);
  const manifestPath = join(assets, 'manifest.json');
  const catalogPath = join(assets, 'catalog.json');
  if (!existsSync(manifestPath) || !existsSync(catalogPath)) {
    throw new Error(
      `缺少本机官方资源：${manifestPath} / ${catalogPath}\n先运行 node tools/import-mc-assets.ts 与 node tools/build-mc-catalog.ts`,
    );
  }
  const manifest = readJson(manifestPath) as ImportManifest;
  const modelCatalog = readJson(catalogPath) as CatalogFile;
  const states = readJson(join(repo, 'assets', 'mc-1.20.1', 'block-states.json')) as BlockStatesFile;
  const registry = readJson(join(repo, 'assets', 'v02', 'registry', 'blocks.json')) as RegistryBlock[];
  const curated = readJson(join(repo, 'tools', 'mc', 'curated-usages.json')) as CuratedFile;
  const byId = new Map(states.blocks.map((block) => [block.name, block]));
  const registryById = new Map(registry.map((block) => [block.id, block]));
  const tags = tagValues(join(assets, 'data', 'minecraft', 'tags', 'blocks'));

  for (const id of curated.blocks) {
    if (!registryById.has(id)) throw new Error(`curated-usages.blocks 里的 ${id} 不在方块注册表`);
  }
  for (const usage of curated.usages) {
    for (const id of usage.blocks) {
      if (!registryById.has(id)) throw new Error(`用法 ${usage.id} 引用了未知方块 ${id}`);
    }
  }

  const capabilities: BlockCapability[] = [];
  for (const id of [...new Set(curated.blocks)].sort()) {
    const block = byId.get(id);
    const info = registryById.get(id);
    if (block === undefined || info === undefined) continue;
    const officialModel =
      modelCatalog.defaults[id] !== undefined ||
      modelCatalog.states[id] !== undefined ||
      modelCatalog.connections[id] !== undefined;
    capabilities.push({
      id,
      zh: info.zh,
      shape: info.shape,
      transparent: info.props.transparent,
      luminance: info.props.luminance,
      solid: info.props.solid,
      states: stateSummary(block.properties),
      defaultState: id,
      placeOn: placeOn(info.shape, id),
      support: support(info.shape),
      collision: collision(info.shape, info.props.solid),
      tags: tagsForBlock(tags, id),
      officialModel,
    });
  }

  const usages: BlockUsage[] = curated.usages.map((usage) => ({
    id: usage.id,
    name: usage.name,
    blocks: usage.blocks,
    intent: usage.intent,
    how: usage.how,
    states: usage.states,
    mistakes: usage.mistakes,
    bestFor: usage.bestFor,
  }));

  const json = {
    version: CATALOG_VERSION,
    mcVersion: MC_VERSION,
    generatedFrom: {
      minecraftAssets: `.work/mc-assets/${MC_VERSION}`,
      sourceManifestSha256: manifest.source.sha256,
      blockstates: manifest.counts['blockstates'] ?? 0,
      models: manifest.counts['models'] ?? 0,
      textures: manifest.counts['textures'] ?? 0,
      tags: manifest.counts['tags'] ?? 0,
      curatedUsages: 'tools/mc/curated-usages.json',
    },
    blocks: capabilities,
    usages,
  };

  writeFileSync(join(repo, 'assets', 'mc-1.20.1', 'block-capabilities.json'), `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(join(repo, 'packages', 'blocks', 'src', 'capability-catalog.ts'), renderCapabilityModule(capabilities));
  writeFileSync(join(repo, 'packages', 'blocks', 'src', 'block-usages.ts'), renderUsageModule(usages));
  writeFileSync(join(repo, 'docs', 'MC-BLOCK-CAPABILITIES.md'), renderMarkdown(capabilities, usages, manifest));
  return { blocks: capabilities.length, usages: usages.length };
}

function main(): void {
  const result = buildBlockCatalog();
  console.log(`已生成 ${String(result.blocks)} 个方块能力条目、${String(result.usages)} 条组合用法`);
  console.log('assets/mc-1.20.1/block-capabilities.json');
  console.log('packages/blocks/src/capability-catalog.ts');
  console.log('packages/blocks/src/block-usages.ts');
  console.log('docs/MC-BLOCK-CAPABILITIES.md');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
