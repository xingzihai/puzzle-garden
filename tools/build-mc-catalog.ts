/**
 * 从 `.work/mc-assets/1.20.1/` 生成渲染用官方模型包与状态索引。
 *
 * 输入：导入工具写出的 blockstates / models / textures，以及仓库里的 block-states.json。
 * 输出：`.work/mc-assets/1.20.1/catalog.json`（宿主查状态）与 `model-pack.bin`（页面几何 + 图集）。
 * 官方 JSON / PNG 不入库；本文件只写 `.work/`，并打印覆盖率与边界。
 *
 * 用法：node tools/build-mc-catalog.ts [--assets .work/mc-assets/1.20.1]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeModelPack } from '../packages/render/src/model-pack.ts';
import type { PackBox, PackFace, PackModel, RenderModelPack } from '../packages/render/src/model-pack.ts';
import { buildAtlas } from './mc/atlas.ts';
import { evaluateBlockstate, parseBlockstate } from './mc/blockstate.ts';
import type { FaceName, ModelBox } from './mc/model-json.ts';
import { FACE_ORDER, rotateModelBoxes } from './mc/model-json.ts';
import type { DecodedPng } from './mc/png.ts';
import { decodePng } from './mc/png.ts';

const MC_VERSION = '1.20.1';
const CONNECTION_PROPS = ['north', 'east', 'south', 'west'] as const;
const CONNECTION_AXES: readonly FaceName[] = ['north', 'east', 'south', 'west'];

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

interface CustomModel {
  readonly boxes: readonly ModelBox[];
  readonly textures: readonly string[];
}

interface RawModel {
  readonly boxes: readonly ModelBox[];
  readonly textures: readonly string[];
}

interface CatalogOutput {
  readonly version: number;
  readonly mcVersion: string;
  readonly generatedFrom: Readonly<Record<string, string>>;
  readonly states: Readonly<Record<string, number>>;
  readonly connections: Readonly<Record<string, readonly number[]>>;
  readonly defaults: Readonly<Record<string, number>>;
  readonly coverage: {
    readonly blocks: number;
    readonly states: number;
    readonly models: number;
    readonly textures: number;
  };
  readonly atlas: {
    readonly width: number;
    readonly height: number;
    readonly textures: readonly {
      readonly key: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }[];
  };
  readonly boundaries: readonly string[];
}

export interface BuildOptions {
  readonly assetsDir: string;
  readonly blockStatesPath: string;
  readonly outCatalog: string;
  readonly outPack: string;
}

function root(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

export function defaultOptions(): BuildOptions {
  const assetsDir = join(root(), '.work', 'mc-assets', MC_VERSION);
  return {
    assetsDir,
    blockStatesPath: join(root(), 'assets', 'mc-1.20.1', 'block-states.json'),
    outCatalog: join(assetsDir, 'catalog.json'),
    outPack: join(assetsDir, 'model-pack.bin'),
  };
}

function parseArgs(argv: readonly string[]): BuildOptions {
  const options = defaultOptions();
  let assetsDir = options.assetsDir;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--assets') {
      assetsDir = argv[++i] ?? '';
      if (assetsDir === '') throw new Error('--assets 需要一个目录');
    } else throw new Error(`未知参数 ${argv[i] ?? ''}`);
  }
  return {
    ...options,
    assetsDir,
    outCatalog: join(assetsDir, 'catalog.json'),
    outPack: join(assetsDir, 'model-pack.bin'),
  };
}

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** 递归展开 multipart 条件里用到的属性名，用于发现栅栏 / 玻璃板的运行时连接属性。 */
function conditionKeys(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    const match = /^([a-z0-9_]+)=/.exec(value);
    if (match?.[1] !== undefined) out.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) conditionKeys(entry, out);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'OR' || key === 'AND') conditionKeys(entry, out);
    else out.add(key);
  }
}

function connectionAware(blockstate: ReturnType<typeof parseBlockstate>): boolean {
  if (blockstate.multipart === undefined) return false;
  const keys = new Set<string>();
  for (const part of blockstate.multipart) conditionKeys(part.when, keys);
  return CONNECTION_PROPS.some((key) => keys.has(key));
}

function* combinations(
  properties: readonly PropertyDef[],
  index = 0,
  current: Record<string, string> = {},
): Generator<Record<string, string>> {
  if (index >= properties.length) {
    yield current;
    return;
  }
  const property = properties[index];
  if (property === undefined) return;
  for (const value of property.values) {
    yield* combinations(properties, index + 1, { ...current, [property.name]: value });
  }
}

function canonical(id: string, properties: readonly PropertyDef[], values: Readonly<Record<string, string>>): string {
  const kept = properties
    .filter((property) => values[property.name] !== property.default)
    .map((property) => [property.name, values[property.name] ?? property.default] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return kept.length === 0 ? id : `${id}[${kept.map(([key, value]) => `${key}=${value}`).join(',')}]`;
}

function modelKey(boxes: readonly ModelBox[]): string {
  return JSON.stringify(
    boxes.map((box) => ({
      from: box.from.map((value) => Math.round(value * 10000) / 10000),
      to: box.to.map((value) => Math.round(value * 10000) / 10000),
      faces: box.faces.map((face) =>
        face === null
          ? null
          : {
              texture: face.texture,
              uv: face.uv.map((value) => Math.round(value * 10000) / 10000),
              rotation: face.rotation,
              tint: face.tint,
            },
      ),
    })),
  );
}

function texturesOf(boxes: readonly ModelBox[]): string[] {
  const out = new Set<string>();
  for (const box of boxes) for (const face of box.faces) if (face !== null) out.add(face.texture);
  return [...out].sort();
}

function customChest(kind: string): CustomModel | undefined {
  const texture =
    kind === 'trapped_chest'
      ? 'entity/chest/trapped'
      : kind === 'ender_chest'
        ? 'entity/chest/ender'
        : 'entity/chest/normal';
  const uv = (rect: readonly [number, number, number, number]): [number, number, number, number] => [
    rect[0] / 4,
    rect[1] / 4,
    rect[2] / 4,
    rect[3] / 4,
  ];
  const body = {
    east: [42, 33, 56, 43],
    west: [0, 33, 14, 43],
    up: [14, 19, 28, 33],
    down: [28, 19, 42, 33],
    south: [28, 33, 42, 43],
    north: [14, 33, 28, 43],
  } as const;
  const lid = {
    east: [42, 14, 56, 19],
    west: [0, 14, 14, 19],
    up: [14, 0, 28, 14],
    down: [28, 0, 42, 14],
    south: [28, 14, 42, 19],
    north: [14, 14, 28, 19],
  } as const;
  const box = (
    from: [number, number, number],
    to: [number, number, number],
    faces: Record<FaceName, readonly [number, number, number, number]>,
  ): ModelBox => ({
    from,
    to,
    faces: FACE_ORDER.map((name) => ({ texture, uv: uv(faces[name]), rotation: 0 as const, tint: false })),
  });
  return {
    boxes: [box([1, 0, 1], [15, 10, 15], body), box([1, 9, 1], [15, 14, 15], lid)],
    textures: [texture],
  };
}

function customBed(kind: string, part: 'head' | 'foot'): CustomModel {
  const color = kind.replace(/_bed$/, '');
  const texture = `entity/bed/${color}`;
  const full: [number, number, number, number] = [0, 0, 16, 16];
  const box = (from: [number, number, number], to: [number, number, number]): ModelBox => ({
    from,
    to,
    faces: FACE_ORDER.map(() => ({ texture, uv: full, rotation: 0 as const, tint: false })),
  });
  return {
    boxes: [
      box([0, 3, 0], [16, 9, 16]),
      box([0, 0, 0], [3, 3, 3]),
      box([13, 0, 0], [16, 3, 3]),
      box([0, 0, 13], [3, 3, 16]),
      box([13, 0, 13], [16, 3, 16]),
      part === 'head' ? box([0, 9, 0], [16, 16, 3]) : box([0, 9, 13], [16, 16, 16]),
    ],
    textures: [texture],
  };
}

function rotateFacing(boxes: readonly ModelBox[], facing: string): ModelBox[] {
  const degrees = facing === 'east' ? 90 : facing === 'south' ? 180 : facing === 'west' ? 270 : 0;
  return rotateModelBoxes(boxes, 'y', degrees);
}

/** 读 PNG 并缓存；失败返回 undefined，由调用方记为 missing。 */
function textureReader(assetsDir: string): (key: string) => DecodedPng | undefined {
  const cache = new Map<string, DecodedPng | undefined>();
  return (key: string) => {
    if (cache.has(key)) return cache.get(key);
    const path = join(assetsDir, 'assets', 'minecraft', 'textures', `${key}.png`);
    let decoded: DecodedPng | undefined;
    try {
      decoded = decodePng(new Uint8Array(readFileSync(path)));
    } catch {
      decoded = undefined;
    }
    cache.set(key, decoded);
    return decoded;
  };
}

function missingTexture(): DecodedPng {
  const size = 16;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const on = x < 8 !== y < 8;
      const p = (y * size + x) * 4;
      rgba[p] = on ? 255 : 32;
      rgba[p + 1] = 0;
      rgba[p + 2] = on ? 255 : 32;
      rgba[p + 3] = 255;
    }
  }
  return { width: size, height: size, rgba };
}

export interface BuiltCatalog {
  readonly catalog: CatalogOutput;
  readonly pack: RenderModelPack;
  readonly stats: {
    readonly blocks: number;
    readonly states: number;
    readonly models: number;
    readonly textures: number;
    readonly skipped: number;
  };
}

/** 生成目录与模型包；不写文件，便于测试。 */
export function buildCatalog(options: BuildOptions): BuiltCatalog {
  const statesJson = JSON.parse(readFileSync(options.blockStatesPath, 'utf8')) as BlockStatesFile;
  const readModel = (path: string): string | undefined => read(join(options.assetsDir, path));
  const readTexture = textureReader(options.assetsDir);

  const states: Record<string, number> = {};
  const connections: Record<string, readonly number[]> = {};
  const defaults: Record<string, number> = {};
  const modelIds = new Map<string, number>();
  const rawModels: RawModel[] = [];
  const textureKeys = new Set<string>();
  const skipped: string[] = [];
  const covered = new Set<string>();

  function addModel(boxes: readonly ModelBox[], textures: readonly string[]): number {
    if (boxes.length === 0) return 0;
    const key = modelKey(boxes);
    const found = modelIds.get(key);
    if (found !== undefined) return found;
    const id = rawModels.length + 1;
    if (id > 65535) throw new Error('模型数超过 65535，协议 u16 放不下');
    modelIds.set(key, id);
    rawModels.push({ boxes, textures });
    for (const texture of textures) textureKeys.add(texture);
    return id;
  }

  for (const block of statesJson.blocks) {
    const blockstatePath = join(options.assetsDir, 'assets', 'minecraft', 'blockstates', `${block.name}.json`);
    if (!existsSync(blockstatePath)) {
      skipped.push(`${block.name}：没有 blockstate`);
      continue;
    }
    let blockstate;
    try {
      blockstate = parseBlockstate(readFileSync(blockstatePath, 'utf8'));
    } catch (error) {
      skipped.push(`${block.name}：blockstate 解析失败 ${String(error)}`);
      continue;
    }
    const aware = connectionAware(blockstate);
    const isChest = block.name === 'chest' || block.name === 'trapped_chest' || block.name === 'ender_chest';
    const isBed = block.name.endsWith('_bed');
    const special = isChest ? customChest(block.name) : undefined;

    if (special !== undefined) {
      for (const values of combinations(block.properties)) {
        const facing = values['facing'] ?? 'north';
        const boxes = rotateFacing(special.boxes, facing);
        const id = addModel(boxes, special.textures);
        if (id === 0) continue;
        states[canonical(block.name, block.properties, values)] = id;
        covered.add(block.name);
      }
      const defaultValues = Object.fromEntries(block.properties.map((p) => [p.name, p.default]));
      const defaultId = addModel(rotateFacing(special.boxes, defaultValues['facing'] ?? 'north'), special.textures);
      if (defaultId > 0) defaults[block.name] = defaultId;
      continue;
    }

    if (isBed) {
      for (const values of combinations(block.properties)) {
        const facing = values['facing'] ?? 'north';
        const part = values['part'] === 'head' ? 'head' : 'foot';
        const bed = customBed(block.name, part);
        const id = addModel(rotateFacing(bed.boxes, facing), bed.textures);
        if (id === 0) continue;
        states[canonical(block.name, block.properties, values)] = id;
        covered.add(block.name);
      }
      const defaultValues = Object.fromEntries(block.properties.map((p) => [p.name, p.default]));
      const defaultBed = customBed(block.name, 'foot');
      const defaultId = addModel(
        rotateFacing(defaultBed.boxes, defaultValues['facing'] ?? 'north'),
        defaultBed.textures,
      );
      if (defaultId > 0) defaults[block.name] = defaultId;
      continue;
    }

    if (aware) {
      const base = Object.fromEntries(block.properties.map((p) => [p.name, p.default]));
      const propertyByName = new Map(block.properties.map((p) => [p.name, p]));
      const connectedValue = (name: string): string => {
        const property = propertyByName.get(name);
        if (property === undefined) return 'true';
        if (property.values.includes('true')) return 'true';
        if (property.values.includes('low')) return 'low';
        if (property.values.includes('tall')) return 'tall';
        return property.values[0] ?? 'true';
      };
      const disconnectedValue = (name: string): string => {
        const property = propertyByName.get(name);
        if (property === undefined) return 'false';
        if (property.values.includes('false')) return 'false';
        if (property.values.includes('none')) return 'none';
        return property.default;
      };
      const ids: number[] = [];
      for (let mask = 0; mask < 16; mask += 1) {
        const values = { ...base };
        for (const [bit, name] of CONNECTION_AXES.entries())
          values[name] = (mask & (1 << bit)) !== 0 ? connectedValue(name) : disconnectedValue(name);
        const evaluated = evaluateBlockstate(blockstate, values, readModel);
        ids.push(addModel(evaluated.boxes, texturesOf(evaluated.boxes)));
      }
      if (ids.some((id) => id > 0)) {
        connections[block.name] = ids;
        defaults[block.name] = ids[0] ?? 0;
        covered.add(block.name);
      }
      continue;
    }

    let defaultValues: Record<string, string> | undefined;
    for (const values of combinations(block.properties)) {
      const evaluated = evaluateBlockstate(blockstate, values, readModel);
      if (!evaluated.matched) continue;
      const id = addModel(evaluated.boxes, texturesOf(evaluated.boxes));
      if (id === 0) continue;
      states[canonical(block.name, block.properties, values)] = id;
      covered.add(block.name);
      if (block.properties.every((p) => values[p.name] === p.default)) defaultValues = values;
    }
    const fallbackValues = defaultValues ?? Object.fromEntries(block.properties.map((p) => [p.name, p.default]));
    const fallback = evaluateBlockstate(blockstate, fallbackValues, readModel);
    const defaultId = addModel(fallback.boxes, texturesOf(fallback.boxes));
    if (defaultId > 0) defaults[block.name] = defaultId;
  }

  const textures = new Map<string, DecodedPng>();
  for (const key of [...textureKeys].sort()) {
    const decoded = readTexture(key);
    if (decoded !== undefined) textures.set(key, decoded);
    else skipped.push(`纹理缺失：${key}`);
  }
  textures.set('__missing__', missingTexture());
  const atlas = buildAtlas(textures);
  for (const key of textureKeys) if (!atlas.placements[key]) skipped.push(`纹理未入图集：${key}`);

  const packModels: PackModel[] = rawModels.map((model) => ({
    boxes: model.boxes.map((box): PackBox => ({
      from: box.from,
      to: box.to,
      faces: box.faces.map((face): PackFace | null => {
        if (face === null) return null;
        const placement = atlas.placements[face.texture] ?? atlas.placements['__missing__'];
        if (placement === undefined) return null;
        const mapU = (u: number): number => placement.x + (u / 16) * placement.width;
        const mapV = (v: number): number => placement.y + (v / 16) * placement.height;
        return {
          uv: [mapU(face.uv[0]), mapV(face.uv[1]), mapU(face.uv[2]), mapV(face.uv[3])],
          tint: face.tint,
          rotation: face.rotation,
        };
      }),
    })),
  }));
  const pack: RenderModelPack = {
    models: packModels,
    atlas: { width: atlas.width, height: atlas.height, rgba: atlas.rgba },
  };
  const catalog: CatalogOutput = {
    version: 1,
    mcVersion: MC_VERSION,
    generatedFrom: {
      blockstates: 'assets/minecraft/blockstates (client jar)',
      models: 'assets/minecraft/models/block (client jar)',
      textures: 'assets/minecraft/textures (client jar)',
      states: 'assets/mc-1.20.1/block-states.json',
    },
    states,
    connections,
    defaults,
    coverage: {
      blocks: covered.size,
      states: Object.keys(states).length,
      models: packModels.length,
      textures: Object.keys(atlas.placements).length,
    },
    atlas: {
      width: atlas.width,
      height: atlas.height,
      textures: Object.entries(atlas.placements)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, p]) => ({ key, x: p.x, y: p.y, width: p.width, height: p.height })),
    },
    boundaries: [
      '栅栏 / 玻璃板连接使用本渲染器的邻居规则，不读取游戏运行时 block state。',
      '非 90° 元素旋转（如 45° 链条）使用旋转后 AABB 近似。',
      '箱子 / 床是 block entity，没有官方 block model；这里用官方 entity 贴图 + 重建盒体重建，UV 为近似值。',
      '动画贴图取第一帧；不支持隔行 PNG。',
    ],
  };
  return {
    catalog,
    pack,
    stats: {
      blocks: covered.size,
      states: Object.keys(states).length,
      models: packModels.length,
      textures: Object.keys(atlas.placements).length,
      skipped: skipped.length,
    },
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.assetsDir)) {
    throw new Error(`资源目录不存在：${options.assetsDir}\n先运行 node tools/import-mc-assets.ts`);
  }
  const built = buildCatalog(options);
  writeFileSync(options.outCatalog, `${JSON.stringify(built.catalog, null, 1)}\n`);
  writeFileSync(options.outPack, encodeModelPack(built.pack));
  writeFileSync(
    join(options.assetsDir, 'catalog-summary.json'),
    `${JSON.stringify({ stats: built.stats, boundaries: built.catalog.boundaries }, null, 2)}\n`,
  );
  const manifest = JSON.parse(readFileSync(join(options.assetsDir, 'manifest.json'), 'utf8')) as {
    source?: { kind?: string; sha256?: string; bytes?: number };
    counts?: Record<string, number>;
    skipped?: unknown[];
  };
  const metadata = {
    $comment:
      'Minecraft 1.20.1 官方资源导入元数据。官方 jar / 贴图 / 模型 JSON 只在本地 .work/mc-assets/1.20.1/ 使用，不入库；本文件只记录来源、哈希与覆盖率。由 tools/build-mc-catalog.ts 生成。',
    mcVersion: built.catalog.mcVersion,
    source: {
      kind: manifest.source?.kind ?? 'unknown',
      sha256: manifest.source?.sha256 ?? '',
      bytes: manifest.source?.bytes ?? 0,
    },
    imported: {
      ...(manifest.counts ?? {}),
      skipped: manifest.skipped?.length ?? 0,
    },
    catalog: {
      ...built.catalog.coverage,
      modelPackFormat: 'PGMP v1',
      sceneProtocol: 2,
    },
    compliance: {
      localOnly: true,
      committedBinaries: false,
      downloadRequiresFlag: '--accept-minecraft-assets',
    },
  };
  writeFileSync(join(root(), 'assets', 'mc-1.20.1', 'mc-assets.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(
    `官方模型：${String(built.stats.blocks)} 个方块、${String(built.stats.states)} 个状态、${String(built.stats.models)} 个模型、${String(built.stats.textures)} 张纹理；跳过 ${String(built.stats.skipped)} 项`,
  );
  console.log(`catalog：${options.outCatalog}`);
  console.log(
    `model-pack：${options.outPack}（${String(built.pack.models.length)} 模型，${String(built.pack.atlas.width)}×${String(built.pack.atlas.height)}）`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
