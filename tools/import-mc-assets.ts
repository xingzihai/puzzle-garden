/**
 * 导入 Minecraft 1.20.1 官方客户端资源到本机 `.work/mc-assets/1.20.1/`。
 *
 * 用法：
 *   node tools/import-mc-assets.ts                 # 自动找 ~/.minecraft/versions/1.20.1/1.20.1.jar
 *   node tools/import-mc-assets.ts --source <jar|assets目录>
 *   node tools/import-mc-assets.ts --download --accept-minecraft-assets
 *
 * 合规：官方资源只落 `.work/`（已 gitignore），仓库只提交脚本、manifest、hash 与说明。
 * 下载只在显式 `--accept-minecraft-assets` 时发生，且只走 Mojang 官方版本清单。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readZipDirectory, readZipEntry } from './mc/zip.ts';

const VERSION = '1.20.1';
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const PREFIXES = [
  'assets/minecraft/blockstates/',
  'assets/minecraft/models/block/',
  'assets/minecraft/textures/block/',
  'assets/minecraft/textures/entity/chest/',
  'assets/minecraft/textures/entity/bed/',
  'data/minecraft/tags/blocks/',
] as const;

export interface ImportArgs {
  readonly source?: string;
  readonly out: string;
  readonly download: boolean;
  readonly accept: boolean;
  readonly force: boolean;
  readonly index?: string;
}

export interface ImportedFile {
  readonly sha256: string;
  readonly bytes: number;
}

export interface ImportManifest {
  readonly $comment: string;
  readonly mcVersion: string;
  readonly source: {
    readonly kind: 'client-jar' | 'assets-dir' | 'asset-objects';
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly versionManifest?: string;
    readonly sha1?: string;
    readonly assetIndex?: string;
  };
  readonly prefixes: readonly string[];
  readonly counts: Readonly<Record<'files' | 'blockstates' | 'models' | 'textures' | 'tags', number>>;
  readonly files: Readonly<Record<string, ImportedFile>>;
  readonly skipped: readonly string[];
}

function root(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

export function defaultOut(): string {
  return join(root(), '.work', 'mc-assets', VERSION);
}

export function parseArgs(argv: readonly string[]): ImportArgs {
  let source: string | undefined;
  let out = defaultOut();
  let download = false;
  let accept = false;
  let force = false;
  let index: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') {
      source = argv[++i];
      if (source === undefined || source.startsWith('--')) throw new Error('--source 需要一个路径');
    } else if (arg === '--out') {
      out = resolve(argv[++i] ?? '');
      if (out === '') throw new Error('--out 需要一个路径');
    } else if (arg === '--download') download = true;
    else if (arg === '--accept-minecraft-assets') accept = true;
    else if (arg === '--force') force = true;
    else if (arg === '--index') index = argv[++i];
    else if (arg === '--help' || arg === '-h') throw new Error(usage());
    else throw new Error(`未知参数 ${String(arg)}\n${usage()}`);
  }
  if (download && !accept) throw new Error('下载官方资源必须显式加 --accept-minecraft-assets');
  return {
    ...(source === undefined ? {} : { source: resolve(source) }),
    out,
    download,
    accept,
    force,
    ...(index === undefined ? {} : { index }),
  };
}

function usage(): string {
  return [
    '用法：node tools/import-mc-assets.ts [--source <client.jar|assets目录>] [--out <目录>]',
    '      [--download --accept-minecraft-assets] [--index <asset index id>] [--force]',
    '',
    '缺省自动检测 ~/.minecraft/versions/1.20.1/1.20.1.jar；官方资源只写 .work/，不入库。',
  ].join('\n');
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
function sha1(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

async function downloadBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${url}：HTTP ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** 只从 Mojang 官方清单下载 client jar；返回本地路径与校验信息。 */
async function downloadClientJar(out: string): Promise<{ path: string; sha1: string; versionManifestSha1: string }> {
  const manifestBytes = await downloadBytes(MANIFEST_URL);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    versions?: { id?: string; url?: string; sha1?: string }[];
  };
  const entry = manifest.versions?.find((version) => version.id === VERSION);
  if (entry?.url === undefined || entry.sha1 === undefined) throw new Error(`Mojang 版本清单里找不到 ${VERSION}`);
  const versionBytes = await downloadBytes(entry.url);
  if (sha1(versionBytes) !== entry.sha1) throw new Error('1.20.1.json 的 sha1 与版本清单不符');
  const version = JSON.parse(new TextDecoder().decode(versionBytes)) as {
    downloads?: { client?: { url?: string; sha1?: string; size?: number } };
  };
  const client = version.downloads?.client;
  if (client?.url === undefined || client.sha1 === undefined) throw new Error('1.20.1.json 缺少 client 下载地址');
  const jar = await downloadBytes(client.url);
  if (sha1(jar) !== client.sha1) throw new Error('client jar 的 sha1 与官方版本清单不符');
  const dir = join(out, '..', 'downloads');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `client-${VERSION}.jar`);
  writeFileSync(path, jar);
  return { path, sha1: client.sha1, versionManifestSha1: sha1(manifestBytes) };
}

interface FoundSource {
  readonly kind: 'client-jar' | 'assets-dir' | 'asset-objects';
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly index?: string;
  readonly versionManifest?: string;
  readonly sha1?: string;
}

function findExtractedAssets(dir: string): string | undefined {
  if (existsSync(join(dir, 'blockstates')) && existsSync(join(dir, 'models'))) return dir;
  if (existsSync(join(dir, 'minecraft', 'blockstates'))) return join(dir, 'minecraft');
  if (existsSync(join(dir, 'assets', 'minecraft', 'blockstates'))) return join(dir, 'assets', 'minecraft');
  return undefined;
}

function locateSource(args: ImportArgs): FoundSource | undefined {
  if (args.source !== undefined) {
    if (!existsSync(args.source)) throw new Error(`--source 不存在：${args.source}`);
    if (statSync(args.source).isDirectory()) {
      const extracted = findExtractedAssets(args.source);
      if (extracted !== undefined) return { kind: 'assets-dir', path: extracted };
      if (existsSync(join(args.source, 'objects')) && existsSync(join(args.source, 'indexes'))) {
        return { kind: 'asset-objects', path: args.source, ...(args.index === undefined ? {} : { index: args.index }) };
      }
      throw new Error(`目录里既没有 blockstates/models，也不是 assets/objects 结构：${args.source}`);
    }
    const bytes = new Uint8Array(readFileSync(args.source));
    return { kind: 'client-jar', path: args.source, bytes };
  }
  const home = homedir();
  const jar = join(home, '.minecraft', 'versions', VERSION, `${VERSION}.jar`);
  if (existsSync(jar)) return { kind: 'client-jar', path: jar, bytes: new Uint8Array(readFileSync(jar)) };
  const objects = join(home, '.minecraft', 'assets');
  const versionJson = join(home, '.minecraft', 'versions', VERSION, `${VERSION}.json`);
  if (existsSync(objects) && existsSync(versionJson)) {
    const parsed = JSON.parse(readFileSync(versionJson, 'utf8')) as { assetIndex?: { id?: string } };
    if (parsed.assetIndex?.id !== undefined)
      return { kind: 'asset-objects', path: objects, index: parsed.assetIndex.id };
  }
  return undefined;
}

function safeOutput(out: string, name: string): string {
  const target = resolve(out, name);
  const rel = relative(out, target);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) throw new Error(`拒绝写出目录：${name}`);
  return target;
}

function recordFile(files: Record<string, ImportedFile>, out: string, name: string, data: Uint8Array): void {
  const path = safeOutput(out, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  files[name.split(sep).join('/')] = { sha256: sha256(data), bytes: data.byteLength };
}

function importJar(
  source: FoundSource,
  out: string,
  files: Record<string, ImportedFile>,
  skipped: string[],
): ImportManifest['source'] {
  const bytes = source.bytes;
  if (bytes === undefined) throw new Error('jar 源缺少字节');
  const entries = readZipDirectory(bytes);
  for (const entry of entries) {
    if (!PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    try {
      const data = readZipEntry(bytes, entry);
      recordFile(files, out, entry.name, data);
    } catch (error) {
      skipped.push(`${entry.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { kind: 'client-jar', path: source.path, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function importObjects(
  source: FoundSource,
  out: string,
  files: Record<string, ImportedFile>,
  skipped: string[],
): ImportManifest['source'] {
  if (source.index === undefined)
    throw new Error('assets/objects 源需要 --index <asset index id>（1.20.1 的 assetIndex.id）');
  const indexPath = join(source.path, 'indexes', `${source.index}.json`);
  if (!existsSync(indexPath)) throw new Error(`找不到 asset index：${indexPath}`);
  const indexBytes = new Uint8Array(readFileSync(indexPath));
  const index = JSON.parse(new TextDecoder().decode(indexBytes)) as {
    objects?: Record<string, { hash?: string; size?: number }>;
  };
  const objects = index.objects ?? {};
  for (const entry of Object.keys(objects).sort()) {
    const object = objects[entry];
    if (object?.hash === undefined) continue;
    const name = `assets/${entry}`;
    if (!PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const file = join(source.path, 'objects', object.hash.slice(0, 2), object.hash);
    if (!existsSync(file)) {
      skipped.push(`${name}：缺少对象 ${object.hash}`);
      continue;
    }
    const data = new Uint8Array(readFileSync(file));
    if (sha1(data) !== object.hash) {
      skipped.push(`${name}：sha1 与 asset index 不符`);
      continue;
    }
    recordFile(files, out, name, data);
  }
  return {
    kind: 'asset-objects',
    path: source.path,
    sha256: sha256(indexBytes),
    bytes: indexBytes.byteLength,
    assetIndex: source.index,
  };
}

function importExtracted(
  source: FoundSource,
  out: string,
  files: Record<string, ImportedFile>,
): ImportManifest['source'] {
  const base = source.path;
  const sourceHash = createHash('sha256');
  let sourceBytes = 0;
  for (const prefix of [
    'blockstates',
    'models/block',
    'textures/block',
    'textures/entity/chest',
    'textures/entity/bed',
  ]) {
    const dir = join(base, prefix);
    if (!existsSync(dir)) continue;
    for (const name of listFiles(dir)) {
      const rel = relative(base, name).split(sep).join('/');
      const jarName = `assets/minecraft/${rel}`;
      if (!PREFIXES.some((p) => jarName.startsWith(p))) continue;
      const data = new Uint8Array(readFileSync(name));
      sourceHash.update(rel).update(data);
      sourceBytes += data.byteLength;
      recordFile(files, out, jarName, data);
    }
  }
  return { kind: 'assets-dir', path: base, sha256: sourceHash.digest('hex'), bytes: sourceBytes };
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

export function buildManifest(
  source: ImportManifest['source'],
  files: Record<string, ImportedFile>,
  skipped: readonly string[],
): ImportManifest {
  const names = Object.keys(files);
  const count = (prefix: string): number => names.filter((name) => name.startsWith(prefix)).length;
  return {
    $comment: '由 tools/import-mc-assets.ts 生成；官方资源只在本机 .work/ 使用，不入库。',
    mcVersion: VERSION,
    source,
    prefixes: PREFIXES,
    counts: {
      files: names.length,
      blockstates: count('assets/minecraft/blockstates/'),
      models: count('assets/minecraft/models/block/'),
      textures: count('assets/minecraft/textures/'),
      tags: count('data/minecraft/tags/blocks/'),
    },
    files,
    skipped,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let source = locateSource(args);
  let downloaded: { path: string; sha1: string; versionManifestSha1: string } | undefined;
  if (source === undefined && args.download) {
    downloaded = await downloadClientJar(args.out);
    source = { kind: 'client-jar', path: downloaded.path, bytes: new Uint8Array(readFileSync(downloaded.path)) };
  }
  if (source === undefined) {
    throw new Error(
      [
        `没有找到 Minecraft ${VERSION} 官方资源。`,
        `请安装 1.20.1，或提供 --source <1.20.1.jar|assets目录>；`,
        `如确认使用官方资源，可运行 --download --accept-minecraft-assets（只从 Mojang 官方清单下载到 .work/）。`,
      ].join('\n'),
    );
  }
  if (args.force) rmSync(args.out, { recursive: true, force: true });
  mkdirSync(args.out, { recursive: true });
  const files: Record<string, ImportedFile> = {};
  const skipped: string[] = [];
  let sourceInfo: ImportManifest['source'];
  if (source.kind === 'client-jar') sourceInfo = importJar(source, args.out, files, skipped);
  else if (source.kind === 'assets-dir') sourceInfo = importExtracted(source, args.out, files);
  else sourceInfo = importObjects(source, args.out, files, skipped);
  if (downloaded !== undefined) {
    sourceInfo = {
      ...sourceInfo,
      versionManifest: downloaded.versionManifestSha1,
      sha1: downloaded.sha1,
    };
  }
  const manifest = buildManifest(sourceInfo, files, skipped);
  writeFileSync(join(args.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `已导入 ${String(manifest.counts.files)} 个文件：blockstates ${String(manifest.counts.blockstates)}、models ${String(manifest.counts.models)}、textures ${String(manifest.counts.textures)}、tags ${String(manifest.counts.tags)}`,
  );
  if (skipped.length > 0) console.log(`跳过 ${String(skipped.length)} 项（见 manifest.skipped）`);
  console.log(`输出：${args.out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
