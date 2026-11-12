/**
 * 资产清单：为 assets/ 下每个文件记录 sha256 与字节数，并校验与清单一致。
 *
 * - `node tools/assets-manifest.ts --write`：重新生成 assets/MANIFEST.json（导入或更新资产后运行）
 * - `node tools/assets-manifest.ts`：校验，任何文件被改、被删、多出都报错（进 npm run check）
 *
 * 资产是从 v0.2 与外部数据源导入的只读数据，只能通过导入脚本更新，不手改。
 * 清单自身不纳入校验。
 * 行尾：.gitattributes 把 assets/ 标为二进制，检出时不做 CRLF 转换，sha256 跨平台一致。
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const Entry = z.object({ sha256: z.string().length(64), bytes: z.number().int().nonnegative() });
type Entry = z.infer<typeof Entry>;
const Manifest = z.object({ $comment: z.string(), files: z.record(z.string(), Entry) });

/** 对比清单与实际文件，返回问题列表（空表示一致）。 */
export function compareManifest(
  expected: Readonly<Record<string, Entry>>,
  actual: Readonly<Record<string, Entry>>,
): string[] {
  const problems: string[] = [];
  for (const [path, meta] of Object.entries(expected)) {
    const got = actual[path];
    if (got === undefined) problems.push(`缺失：${path}`);
    else if (got.sha256 !== meta.sha256 || got.bytes !== meta.bytes) problems.push(`内容被改：${path}`);
  }
  for (const path of Object.keys(actual)) {
    if (expected[path] === undefined) problems.push(`清单外的文件：${path}`);
  }
  return problems;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/** 不纳入校验的文件（相对 assets/）。 */
export const UNTRACKED: ReadonlySet<string> = new Set(['MANIFEST.json', 'README.md']);

function scan(assets: string): Record<string, Entry> {
  const files: Record<string, Entry> = {};
  for (const full of listFiles(assets)) {
    const data = readFileSync(full);
    const rel = relative(assets, full).split(sep).join('/');
    if (UNTRACKED.has(rel)) continue;
    files[rel] = { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
  }
  return files;
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const assets = join(root, 'assets');
  const manifest = join(assets, 'MANIFEST.json');
  const actual = scan(assets);

  if (process.argv.includes('--write')) {
    const doc = { $comment: '由 tools/assets-manifest.ts --write 生成。', files: actual };
    writeFileSync(manifest, `${JSON.stringify(doc, null, 1)}\n`);
    console.log(`已写入 ${String(Object.keys(actual).length)} 个文件的清单`);
    return;
  }

  const expected = Manifest.parse(JSON.parse(readFileSync(manifest, 'utf8'))).files;
  const problems = compareManifest(expected, actual);
  if (problems.length > 0) {
    for (const p of problems.slice(0, 50)) console.error(p);
    if (problems.length > 50) console.error(`……另有 ${String(problems.length - 50)} 处`);
    console.error(`\n资产校验未通过：${String(problems.length)} 处。资产只能经导入脚本更新，然后运行 --write。`);
    process.exitCode = 1;
    return;
  }
  console.log(`资产校验通过：${String(Object.keys(actual).length)} 个文件`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
