/**
 * 本机 Minecraft 1.20.1 资源包的加载入口（只读 `.work/mc-assets/1.20.1/`）。
 *
 * 负责：读 catalog.json 与 model-pack.bin、做结构校验、给出官方 / fallback 状态；
 * 不负责下载或生成资源（tools/import-mc-assets.ts、tools/build-mc-catalog.ts）。
 * 官方资源不入库；目录不存在是正常路径，渲染器会回退到颜色 + 简化几何。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McAssetCatalog } from './mc-catalog.ts';

export const DEFAULT_MC_ASSET_DIR = fileURLToPath(new URL('../../../.work/mc-assets/1.20.1/', import.meta.url));
export const CATALOG_FILE = 'catalog.json';
export const MODEL_PACK_FILE = 'model-pack.bin';
export const MANIFEST_FILE = 'manifest.json';

export interface McAssetPack {
  readonly catalog: McAssetCatalog;
  /** 原始 model-pack.bin，交给 BrowserHost 原样服务。 */
  readonly bytes: Uint8Array;
  readonly path: string;
}

export interface AssetStatus {
  readonly source: 'official' | 'fallback';
  readonly mcVersion: string | null;
  readonly models: number;
  readonly coveredBlocks: number;
  readonly states: number;
  readonly textures: number;
  readonly reason?: string;
}

export type AssetLoad =
  | { readonly kind: 'ok'; readonly pack: McAssetPack }
  | { readonly kind: 'missing'; readonly path: string; readonly reason: string }
  | { readonly kind: 'invalid'; readonly path: string; readonly reason: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`);
  return value;
}

function modelId(value: unknown, label: string): number {
  const id = nonNegativeInt(value, label);
  if (id > 65535) throw new Error(`${label} 超过 65535`);
  return id;
}

function parseStates(value: unknown): Record<string, number> {
  if (!record(value)) throw new Error('states 必须是对象');
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) out[key] = modelId(raw, `states.${key}`);
  return out;
}

function parseConnections(value: unknown): Record<string, readonly number[]> {
  if (value === undefined) return {};
  if (!record(value)) throw new Error('connections 必须是对象');
  const out: Record<string, readonly number[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!Array.isArray(raw) || raw.length !== 16) throw new Error(`connections.${key} 必须是长度 16 的数组`);
    out[key] = raw.map((entry, index) => modelId(entry, `connections.${key}[${String(index)}]`));
  }
  return out;
}

/** 校验并返回目录；只做结构检查，不校验每个模型 id 是否真的存在于二进制包。 */
export function parseCatalog(value: unknown): McAssetCatalog {
  if (!record(value)) throw new Error('catalog 必须是对象');
  const mcVersion = value['mcVersion'];
  if (typeof mcVersion !== 'string' || !/^1\.\d+(?:\.\d+)?$/.test(mcVersion))
    throw new Error('mcVersion 缺失或格式不对');
  const coverage = value['coverage'];
  if (!record(coverage)) throw new Error('coverage 缺失');
  const states = parseStates(value['states']);
  return {
    mcVersion,
    states,
    connections: parseConnections(value['connections']),
    defaults: parseStates(value['defaults'] ?? {}),
    coverage: {
      blocks: nonNegativeInt(coverage['blocks'], 'coverage.blocks'),
      states: nonNegativeInt(coverage['states'], 'coverage.states'),
      models: nonNegativeInt(coverage['models'], 'coverage.models'),
      textures: nonNegativeInt(coverage['textures'], 'coverage.textures'),
    },
  };
}

function result(path: string, reason: string): AssetLoad {
  return { kind: 'missing', path, reason };
}

/** 读本机资源包；目录 / 文件不存在返回 missing，内容不合法返回 invalid。 */
export function loadMcAssetPack(dir: string = DEFAULT_MC_ASSET_DIR): AssetLoad {
  const catalogPath = join(dir, CATALOG_FILE);
  const packPath = join(dir, MODEL_PACK_FILE);
  if (!existsSync(catalogPath) || !existsSync(packPath)) {
    return result(
      dir,
      `未找到官方资源包：${catalogPath} / ${packPath}。先运行 tools/import-mc-assets.ts 与 tools/build-mc-catalog.ts；本次使用 fallback。`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as unknown;
  } catch (error) {
    return { kind: 'invalid', path: catalogPath, reason: `读不到或不是合法 JSON：${String(error)}` };
  }
  let catalog: McAssetCatalog;
  try {
    catalog = parseCatalog(raw);
  } catch (error) {
    return { kind: 'invalid', path: catalogPath, reason: String(error) };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(packPath));
  } catch (error) {
    return { kind: 'invalid', path: packPath, reason: `读不到模型包：${String(error)}` };
  }
  if (bytes.byteLength < 24) return { kind: 'invalid', path: packPath, reason: '模型包短于 24 字节' };
  return { kind: 'ok', pack: { catalog, bytes, path: dir } };
}

/** 资源状态写入 RenderResult / RenderVersion，调用方不需要再判断目录。 */
export function assetStatus(load: AssetLoad | undefined): AssetStatus {
  if (load?.kind === 'ok') {
    const { catalog } = load.pack;
    return {
      source: 'official',
      mcVersion: catalog.mcVersion,
      models: catalog.coverage.models,
      coveredBlocks: catalog.coverage.blocks,
      states: catalog.coverage.states,
      textures: catalog.coverage.textures,
    };
  }
  return {
    source: 'fallback',
    mcVersion: null,
    models: 0,
    coveredBlocks: 0,
    states: 0,
    textures: 0,
    reason: load?.reason ?? '未指定官方资源目录',
  };
}

/** 供工具与测试检查 manifest 是否存在（不解析内容）。 */
export function hasImportedManifest(dir: string = DEFAULT_MC_ASSET_DIR): boolean {
  try {
    return statSync(join(dir, MANIFEST_FILE)).isFile();
  } catch {
    return false;
  }
}
