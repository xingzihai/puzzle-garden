import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { exampleScheme } from '@pg/interaction/example';
import { planFileNames } from '@pg/interaction/preview';
import { DEFAULT_SESSION_ROOT } from '@pg/interaction/store';

import {
  DESIGN_PREVIEW_USAGE,
  DesignPreviewError,
  parseDesignPreviewArgs,
  runDesignPreview,
} from './design-preview.ts';
import type { DesignPreviewIo } from './design-preview.ts';

interface Capture {
  readonly io: DesignPreviewIo;
  readonly out: string[];
  readonly err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (line) => {
        out.push(line);
      },
      stderr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

const silent: DesignPreviewIo = { stdout: () => undefined, stderr: () => undefined };
const BAD = /undefined|NaN/;
const RAW_AMP = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i;

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pg-design-preview-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeScheme(dir: string): Promise<string> {
  const path = join(dir, 'scheme.json');
  await writeFile(path, `${JSON.stringify(exampleScheme(), null, 2)}\n`, 'utf8');
  return path;
}

test('参数解析：session / session-dir / design 三选一，默认输出目录稳定', () => {
  const session = parseDesignPreviewArgs(['--session', 'ses-preview']);
  assert.equal(session.sessionDir, join(DEFAULT_SESSION_ROOT, 'ses-preview'));
  assert.equal(session.previewOut, join(DEFAULT_SESSION_ROOT, 'ses-preview', 'preview'));
  assert.equal(session.designPath, null);

  const direct = parseDesignPreviewArgs(['--session-dir', '/tmp/session', '--preview-out', '/tmp/out']);
  assert.equal(direct.sessionDir, '/tmp/session');
  assert.equal(direct.previewOut, '/tmp/out');

  const design = parseDesignPreviewArgs(['--design', '/tmp/pkg/scheme.json']);
  assert.equal(design.designPath, '/tmp/pkg/scheme.json');
  assert.equal(design.previewOut, join('/tmp/pkg', 'preview'));

  assert.throws(() => parseDesignPreviewArgs([]), DesignPreviewError);
  assert.throws(() => parseDesignPreviewArgs(['--session', 'ses-a', '--design', 'x.json']), DesignPreviewError);
  assert.throws(() => parseDesignPreviewArgs(['--session-dir', 'x', '--out', 'y']), DesignPreviewError);
  assert.throws(() => parseDesignPreviewArgs(['--session', '../escape']), DesignPreviewError);
  assert.throws(() => parseDesignPreviewArgs(['--session', 'ses-a', '--unknown']), DesignPreviewError);
});

test('--design 生成全部 SVG 与 index.html，两次输出逐字节相同', async () => {
  await withTempDir(async (dir) => {
    const schemePath = await writeScheme(dir);
    const outDir = join(dir, 'preview');
    const first = capture();
    assert.equal(runDesignPreview(['--design', schemePath, '--preview-out', outDir], { io: first.io }), 0);
    assert.equal(first.err.length, 0);
    assert.ok(first.out.some((line) => line.includes(`输出目录：${outDir}`)));
    const scheme = exampleScheme();
    const names = [
      'site.svg',
      ...planFileNames(scheme.levels),
      'axon.svg',
      'section.svg',
      'materials.svg',
      'index.html',
    ];
    for (const name of names) {
      const text = await readFile(join(outDir, name), 'utf8');
      assert.ok(text.length > 100, `${name} 不应为空`);
      if (name.endsWith('.svg')) {
        assert.doesNotMatch(text, BAD);
        assert.doesNotMatch(text, RAW_AMP);
      }
    }
    const before = await Promise.all(names.map((name) => readFile(join(outDir, name), 'utf8')));
    assert.equal(runDesignPreview(['--design', schemePath, '--preview-out', outDir], { io: silent }), 0);
    const after = await Promise.all(names.map((name) => readFile(join(outDir, name), 'utf8')));
    assert.deepEqual(after, before);
  });
});

test('从真实 session.json 的 designs[last] 生成 preview/', async () => {
  await withTempDir(async (root) => {
    const id = 'ses-preview-real';
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    const scheme = exampleScheme(2);
    await writeFile(
      join(dir, 'session.json'),
      `${JSON.stringify({ sessionId: id, stage: 'review', designs: [exampleScheme(), scheme], events: [], nextEventSeq: 0 }, null, 2)}\n`,
      'utf8',
    );
    const captured = capture();
    assert.equal(runDesignPreview(['--session', id, '--out', root], { io: captured.io }), 0);
    const outDir = join(dir, 'preview');
    assert.ok(captured.out.some((line) => line.includes(outDir)));
    const index = await readFile(join(outDir, 'index.html'), 'utf8');
    assert.match(index, /稻田茶亭/);
    assert.match(index, /v2/);
    await readFile(join(outDir, 'plan-lv-ground.svg'), 'utf8');
    await readFile(join(outDir, 'axon.svg'), 'utf8');
  });
});

test('缺会话 / 无方案 / 非法方案 / 缺 --design 文件都返回 2', async () => {
  await withTempDir(async (root) => {
    const missing = capture();
    assert.equal(runDesignPreview(['--session', 'ses-missing', '--out', root], { io: missing.io }), 2);
    assert.ok(missing.err.some((line) => line.includes('会话文件不存在')));

    const emptyDir = join(root, 'ses-empty');
    await mkdir(emptyDir, { recursive: true });
    await writeFile(join(emptyDir, 'session.json'), '{"designs":[]}\n', 'utf8');
    const empty = capture();
    assert.equal(runDesignPreview(['--session-dir', emptyDir], { io: empty.io }), 2);
    assert.ok(empty.err.some((line) => line.includes('还没有方案')));

    const brokenDir = join(root, 'ses-broken');
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, 'session.json'), '{"designs":[{}]}\n', 'utf8');
    const broken = capture();
    assert.equal(runDesignPreview(['--session-dir', brokenDir], { io: broken.io }), 2);
    assert.ok(broken.err.some((line) => line.includes('不符合 DesignScheme')));

    const badJson = join(root, 'bad.json');
    await writeFile(badJson, '{not json', 'utf8');
    const bad = capture();
    assert.equal(runDesignPreview(['--design', badJson], { io: bad.io }), 2);
    assert.ok(bad.err.some((line) => line.includes('不是合法 JSON')));

    const noFile = capture();
    assert.equal(runDesignPreview(['--design', join(root, 'nope.json')], { io: noFile.io }), 2);
    assert.ok(noFile.err.some((line) => line.includes('方案文件不存在')));
  });
});

test('--help 打印用法并返回 0', () => {
  const captured = capture();
  assert.equal(runDesignPreview(['--help'], { io: captured.io }), 0);
  assert.ok(captured.out.some((line) => line === DESIGN_PREVIEW_USAGE));
  assert.ok(DESIGN_PREVIEW_USAGE.includes('--preview-out'));
});
