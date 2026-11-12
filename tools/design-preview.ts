/**
 * `design:preview`：读取会话里的最新 DesignScheme（或直接读一份 scheme.json），
 * 生成 site / 每层 plan / axon / section / materials + index.html 到 preview 目录。
 *
 * 负责：参数解析、会话 / JSON 读取、文件落盘与路径打印。
 * 不负责：SVG 构图（@pg/interaction/preview）、启动浏览器、调用模型或网络。
 *
 * 退出码：成功 0；参数 / 会话缺失 / 无方案 / 解析失败 2；写文件失败 1。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderPreviewBundle, previewSummary } from '@pg/interaction/preview';
import type { PreviewBundle } from '@pg/interaction/preview';
import { DesignScheme } from '@pg/interaction/schema';
import type { DesignScheme as Scheme } from '@pg/interaction/schema';
import {
  assertSessionId,
  DEFAULT_SESSION_ROOT,
  SessionStoreError,
  sessionDir as resolveSessionDir,
} from '@pg/interaction/store';

export interface DesignPreviewIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface DesignPreviewDeps {
  readonly io?: DesignPreviewIo;
}

export interface DesignPreviewOptions {
  readonly sessionDir: string | null;
  readonly designPath: string | null;
  readonly previewOut: string;
}

export class DesignPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignPreviewError';
  }
}

export const DESIGN_PREVIEW_USAGE = `用法：node tools/design-preview.ts (--session <id> [--out <dir>] | --session-dir <path> | --design <scheme.json>) [--preview-out <dir>]
  读取会话 session.json 的最新方案，生成纯 SVG 方案预览；也可以在测试中直接读一份 DesignScheme JSON。
  --session <id>        会话 id，只允许 [a-z0-9][a-z0-9_-]{0,63}
  --out <dir>           会话根目录（默认 ${DEFAULT_SESSION_ROOT}；仅与 --session 一起用）
  --session-dir <path>  直接指定会话目录（与 --session / --out 互斥）
  --design <path>       直接读取一份 DesignScheme JSON（与 session 选项互斥）
  --preview-out <dir>   预览输出目录；默认 <会话目录>/preview（--design 时为 <scheme 所在目录>/preview）
  --help, -h            打印本说明

  输出：site.svg、plan-<level>.svg（每层一张）、axon.svg、section.svg、materials.svg、index.html。
  完全离线、确定性；不启动浏览器、不调用模型、不访问网络。`;

function value(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next === '' || next.startsWith('--')) {
    throw new DesignPreviewError(`${flag} 缺少取值。\n${DESIGN_PREVIEW_USAGE}`);
  }
  return next;
}

/** 解析 argv；session / session-dir / design 三选一。 */
export function parseDesignPreviewArgs(argv: readonly string[]): DesignPreviewOptions {
  let session: string | null = null;
  let sessionDir: string | null = null;
  let design: string | null = null;
  let outDir = DEFAULT_SESSION_ROOT;
  let outProvided = false;
  let previewOut: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    switch (arg) {
      case '--session':
        session = value(argv, index, '--session');
        index += 1;
        break;
      case '--out':
        outDir = value(argv, index, '--out');
        outProvided = true;
        index += 1;
        break;
      case '--session-dir':
        sessionDir = value(argv, index, '--session-dir');
        index += 1;
        break;
      case '--design':
        design = value(argv, index, '--design');
        index += 1;
        break;
      case '--preview-out':
        previewOut = value(argv, index, '--preview-out');
        index += 1;
        break;
      default:
        throw new DesignPreviewError(`不认识的参数 ${JSON.stringify(arg)}。\n${DESIGN_PREVIEW_USAGE}`);
    }
  }

  const chosen = [session !== null, sessionDir !== null, design !== null].filter(Boolean).length;
  if (chosen !== 1) {
    throw new DesignPreviewError(`必须且只能指定 --session、--session-dir、--design 之一。\n${DESIGN_PREVIEW_USAGE}`);
  }
  if (outProvided && session === null) {
    throw new DesignPreviewError('--out 只与 --session 一起用。');
  }

  let resolvedSessionDir: string | null = null;
  if (session !== null) {
    try {
      resolvedSessionDir = resolveSessionDir(assertSessionId(session), { root: outDir });
    } catch (error) {
      if (error instanceof SessionStoreError) throw new DesignPreviewError(error.message);
      throw error;
    }
  } else if (sessionDir !== null) {
    resolvedSessionDir = sessionDir;
  }
  const resolvedDesign = design;
  const output =
    previewOut ??
    (resolvedSessionDir !== null
      ? join(resolvedSessionDir, 'preview')
      : join(dirname(resolvedDesign ?? '.'), 'preview'));
  return { sessionDir: resolvedSessionDir, designPath: resolvedDesign, previewOut: output };
}

function readJson(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new DesignPreviewError(
      `读取${label}失败：${path}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new DesignPreviewError(
      `${label}不是合法 JSON：${path}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

function parseScheme(value: unknown, label: string): Scheme {
  const parsed = DesignScheme.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const detail = first === undefined ? '未知校验错误' : `${first.path.join('.') || '(root)'}：${first.message}`;
    throw new DesignPreviewError(`${label}不符合 DesignScheme：${detail}`);
  }
  return parsed.data;
}

/** 读取 session.json 的 designs[last]；缺文件 / 无方案 / 非法方案都抛 DesignPreviewError。 */
export function loadLatestSessionScheme(dir: string): Scheme {
  const file = join(dir, 'session.json');
  if (!existsSync(file)) {
    throw new DesignPreviewError(`会话文件不存在：${file}`);
  }
  const parsed = readJson(file, 'session.json');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DesignPreviewError(`session.json 必须是对象：${file}`);
  }
  const designs = (parsed as Record<string, unknown>)['designs'];
  if (!Array.isArray(designs) || designs.length === 0) {
    throw new DesignPreviewError(`会话还没有方案（designs 为空）：${file}`);
  }
  return parseScheme(designs[designs.length - 1], `会话 ${dir} 的最新方案`);
}

/** 读取 --design 指向的 DesignScheme JSON。 */
export function loadDesignFile(path: string): Scheme {
  if (!existsSync(path)) throw new DesignPreviewError(`方案文件不存在：${path}`);
  return parseScheme(readJson(path, 'DesignScheme'), `方案文件 ${path}`);
}

function writeBundle(dir: string, bundle: PreviewBundle): readonly string[] {
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const file of bundle.files) {
    const path = join(dir, file.name);
    writeFileSync(path, file.svg, 'utf8');
    paths.push(path);
  }
  const index = join(dir, 'index.html');
  writeFileSync(index, bundle.indexHtml, 'utf8');
  paths.push(index);
  return paths;
}

/** 真正执行一次入口。 */
export function runDesignPreview(argv: readonly string[], deps: DesignPreviewDeps = {}): number {
  const io = deps.io ?? {
    stdout: (line: string) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(DESIGN_PREVIEW_USAGE);
    return 0;
  }

  let options: DesignPreviewOptions;
  try {
    options = parseDesignPreviewArgs(argv);
  } catch (error) {
    if (error instanceof DesignPreviewError) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }

  let scheme: Scheme;
  try {
    scheme =
      options.designPath !== null
        ? loadDesignFile(options.designPath)
        : loadLatestSessionScheme(options.sessionDir ?? '');
  } catch (error) {
    if (error instanceof DesignPreviewError) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }

  let bundle: PreviewBundle;
  try {
    bundle = renderPreviewBundle(scheme);
  } catch (error) {
    io.stderr(`生成方案预览失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let paths: readonly string[];
  try {
    paths = writeBundle(options.previewOut, bundle);
  } catch (error) {
    io.stderr(`写入预览失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  io.stdout(`方案预览：${previewSummary(scheme, bundle)}`);
  io.stdout(`输出目录：${options.previewOut}`);
  for (const path of paths) io.stdout(`  - ${path}`);
  return 0;
}

/** 直接执行入口：未预期异常不输出裸栈。 */
export function main(argv: readonly string[], deps: DesignPreviewDeps = {}): number {
  try {
    return runDesignPreview(argv, deps);
  } catch (error) {
    const message = `运行失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    if (deps.io === undefined) process.stderr.write(`${message}\n`);
    else deps.io.stderr(message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
