/**
 * 任意 `.pgar` 存档出与 agent 交付相同的 6 向图（RENDER-SPEC §4.1 的 `DEFAULT_REQUESTS.deliver`）。
 *
 * 用法：node tools/render-archive.ts <a.pgar> [b.pgar ...] --out <dir>
 * 输出：<dir>/<存档文件名去扩展名>/<视角>.png（视角名以 @pg/render 实际导出为准）。
 *
 * 负责：参数解析、读存档校验、按交付视角串行渲染并落盘、结束关闭浏览器。
 * 不负责：存档生成（@pg/geometry）与图片拼接（tools/contact-sheet.ts）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '@pg/blocks/load';
import { readArchive } from '@pg/core/archive';
import { DEFAULT_REQUESTS, createRenderer } from '@pg/render/render';

export interface RenderArchiveArgs {
  readonly archives: readonly string[];
  readonly outDir: string;
}

export const USAGE = 'node tools/render-archive.ts <a.pgar> [b.pgar ...] --out <dir>';

/** 解析命令行；缺存档、缺 `--out`、未知选项都报错（STANDARDS §4，不静默回退）。 */
export function parseArgs(argv: readonly string[]): RenderArchiveArgs {
  const archives: string[] = [];
  let outDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error('--out 缺少目录参数');
      outDir = value;
      i += 1;
    } else if (arg?.startsWith('--')) {
      throw new Error(`未知参数 ${arg}；用法：${USAGE}`);
    } else if (arg !== undefined) {
      archives.push(arg);
    }
  }
  if (archives.length === 0) throw new Error(`至少需要一个 .pgar 存档；用法：${USAGE}`);
  if (outDir === undefined) throw new Error(`缺少 --out <dir>；用法：${USAGE}`);
  return { archives, outDir };
}

/**
 * 存档文件名去扩展名作为输出子目录名。
 * 仓库里每份交付都叫 `building.pgar`，多个存档同名时按父目录逐级加后缀（如
 * `building-delivery-<运行 id>`）区分，避免静默覆盖；拼完所有祖先仍重名才报错。
 */
export function outputNames(archives: readonly string[]): string[] {
  const entries = archives.map((path) => {
    const parents: string[] = [];
    let dir = dirname(resolve(path));
    for (;;) {
      const name = basename(dir);
      if (name === '' || name === dir) break;
      parents.push(name);
      const next = dirname(dir);
      if (next === dir) break;
      dir = next;
    }
    return { base: basename(path, extname(path)), parents };
  });

  const nameAt = (entry: (typeof entries)[number], depth: number): string =>
    depth === 0 ? entry.base : `${entry.base}-${entry.parents.slice(0, depth).join('-')}`;

  const names: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    let depth = 0;
    let chosen = nameAt(entry, depth);
    while (entries.some((other, j) => j !== i && nameAt(other, depth) === chosen)) {
      depth += 1;
      if (depth > entry.parents.length)
        throw new Error(`多个存档无法用路径区分，输出目录会互相覆盖：${archives[i] ?? ''}`);
      chosen = nameAt(entry, depth);
    }
    names.push(chosen);
  }
  return names;
}

/** 渲染一份存档的交付 6 向图到 outDir/name；坏存档在读阶段报错，不进渲染。 */
export async function renderArchiveFile(
  renderer: ReturnType<typeof createRenderer>,
  registry: ReturnType<typeof loadRegistry>,
  path: string,
  name: string,
  outDir: string,
): Promise<void> {
  const bytes = readFileSync(path);
  try {
    readArchive(registry.table, bytes);
  } catch (error) {
    throw new Error(`${path} 不是可读存档：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const result = await renderer.render(bytes, DEFAULT_REQUESTS.deliver);
  if (result.kind !== 'ok') throw new Error(`${path} 渲染失败：${result.kind}`);
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  for (const image of result.images) writeFileSync(join(dir, `${image.view}.png`), image.png);
  console.log(
    `${name}: ${String(result.images.length)} 张 · ${String(result.scene.cells)} 格 · ${String(result.scene.faces)} 面`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const names = outputNames(args.archives);
  const registry = loadRegistry();
  const outDir = resolve(args.outDir);
  const renderer = createRenderer(registry);
  try {
    for (let i = 0; i < args.archives.length; i += 1) {
      const path = args.archives[i];
      const name = names[i];
      if (path === undefined || name === undefined) continue;
      await renderArchiveFile(renderer, registry, path, name, outDir);
    }
  } finally {
    await renderer.close();
  }
  console.log(`渲染完成，输出目录：${outDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
