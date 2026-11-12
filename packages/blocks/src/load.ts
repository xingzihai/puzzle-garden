/**
 * 从 assets/ 读方块数据并建注册表（docs/BLOCKS-SPEC.md §2、§3）。只在 Node 里用。
 *
 * 负责：找到并读取两份 JSON。不负责：校验与查询（registry.ts）、缓存（每次调用都重新读，由调用方持有结果）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BlocksError, createRegistry } from './registry.ts';
import type { BlockRegistry } from './registry.ts';

/** 仓库的 assets/，按本文件位置解析（packages/blocks/src → 仓库根）。 */
export const DEFAULT_ASSETS_DIR = join(import.meta.dirname, '../../../assets');

export const FILES = {
  states: 'mc-1.20.1/block-states.json',
  registry: 'v02/registry/blocks.json',
} as const;

function readJson(dir: string, file: string): unknown {
  const path = join(dir, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new BlocksError('invalid-registry', `读不到方块数据文件 ${path}`, { cause: e });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new BlocksError('invalid-registry', `方块数据文件 ${path} 不是合法的 JSON`, { cause: e });
  }
}

/** 读 `assetsDir` 下的两份数据并建注册表。测试可以传临时目录。 */
export function loadRegistry(assetsDir: string = DEFAULT_ASSETS_DIR): BlockRegistry {
  return createRegistry(readJson(assetsDir, FILES.states), readJson(assetsDir, FILES.registry));
}
