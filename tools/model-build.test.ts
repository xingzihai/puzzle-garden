/** model:build 的单元测试：参数解析、原子交付、拒绝覆盖；执行用注入假件，不需要 bwrap。 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { createModel } from '@pg/modeling/model';
import type { ModelDocument } from '@pg/modeling/schema';
import type { ModelExecution } from '@pg/sandbox/modeling';

import {
  BuildArgError,
  buildManifest,
  deliverAtomically,
  failureText,
  parseBuildArgs,
  readBuildCode,
  runBuild,
} from './model-build.ts';
import { MODELING_API, MODEL_MAX_CODE_BYTES } from './model-agent-deps.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pg-model-build-'));
}

function captureIo(): {
  io: { stdout: (l: string) => void; stderr: (l: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, out, err };
}

function makeDocument(): ModelDocument {
  const model = createModel();
  model.box({ id: 'b', name: '块', role: 'volume', color: '#112233', size: [2, 3, 4] });
  return model.finish();
}

function okExecution(code: string): ModelExecution {
  const document = makeDocument();
  return {
    kind: 'ok',
    document,
    codeHash: `code-${String(code.length)}`,
    documentHash: 'doc-hash',
    console: [],
    consoleTruncated: 0,
  };
}

it('parseBuildArgs：合法输入、缺项与非法种子都给出可读错误', () => {
  assert.deepEqual(parseBuildArgs(['a.ts', '--out', 'o', '--seed', '9']), { code: 'a.ts', outDir: 'o', seed: 9 });
  assert.deepEqual(parseBuildArgs(['--code', 'a.ts', '--out', 'o']), { code: 'a.ts', outDir: 'o', seed: 0 });
  assert.throws(() => parseBuildArgs(['--code', 'a.ts', 'b.ts', '--out', 'o']), /多给了 b.ts/);
  assert.throws(() => parseBuildArgs(['a.ts']), BuildArgError);
  assert.throws(() => parseBuildArgs(['--out', 'o']), /缺少代码文件/);
  assert.throws(() => parseBuildArgs(['a.ts', '--out', 'o', '--seed', 'x']), /--seed 应为/);
  assert.throws(() => parseBuildArgs(['a.ts', '--out', 'o', '--seed', '4294967296']), /--seed 应为/);
  assert.throws(() => parseBuildArgs(['a.ts', '--out', 'o', '--wat']), /不认识的参数/);
  assert.throws(() => parseBuildArgs(['a.ts', 'b.ts', '--out', 'o']), /只接受一份代码/);
});

it('readBuildCode：读不到 / 空 / 超上限都报错', () => {
  const dir = tempDir();
  try {
    assert.throws(() => readBuildCode(join(dir, 'nope.ts')), BuildArgError);
    const empty = join(dir, 'empty.ts');
    writeFileSync(empty, '   \n');
    assert.throws(() => readBuildCode(empty), /空文件或全空白/);
    const big = join(dir, 'big.ts');
    writeFileSync(big, 'x'.repeat(MODEL_MAX_CODE_BYTES + 1));
    assert.throws(() => readBuildCode(big), /超过代码上限/);
    const ok = join(dir, 'ok.ts');
    writeFileSync(ok, 'export default function build(): void {}\n');
    assert.equal(readBuildCode(ok), 'export default function build(): void {}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('buildManifest 与 sandbox hash 同口径，并写入建模版本', () => {
  const manifest = buildManifest({ seed: 7, codeHash: 'c', documentHash: 'd' });
  assert.equal(manifest.format, 'pg-model');
  assert.equal(manifest.status, 'ok');
  assert.equal(manifest.codeVersion, 1);
  assert.equal(manifest.seed, 7);
  assert.equal(manifest.modelingApi, MODELING_API);
  assert.equal(typeof manifest.modelFormat, 'number');
});

it('deliverAtomically：成功写三份文件，已存在目标目录一律拒绝', () => {
  const dir = tempDir();
  try {
    const outDir = join(dir, 'out');
    deliverAtomically(outDir, 7, { code: 'code', document: makeDocument(), codeHash: 'c', documentHash: 'd' });
    assert.deepEqual(readdirSync(outDir).sort(), ['manifest.json', 'model.json', 'source.ts']);
    assert.equal(readFileSync(join(outDir, 'source.ts'), 'utf8'), 'code');
    assert.ok(readFileSync(join(outDir, 'model.json'), 'utf8').endsWith('\n'));
    assert.equal(existsSync(join(dir, '.model-build-')), false);

    const before = readFileSync(join(outDir, 'source.ts'), 'utf8');
    assert.throws(() => {
      deliverAtomically(outDir, 7, { code: 'changed', document: makeDocument(), codeHash: 'c', documentHash: 'd' });
    }, /已存在/);
    assert.equal(readFileSync(join(outDir, 'source.ts'), 'utf8'), before, '拒绝覆盖后内容不变');
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.startsWith('.model-build-')),
      [],
      '失败后不留临时目录',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('runBuild：成功原子交付并打印两个 hash；失败不产出目录', async () => {
  const dir = tempDir();
  try {
    const code = join(dir, 'a.ts');
    writeFileSync(code, 'export default function build(): void {}\n');
    const okOut = join(dir, 'ok');
    const okIo = captureIo();
    assert.equal(
      await runBuild([code, '--out', okOut, '--seed', '5'], okIo.io, (c) => Promise.resolve(okExecution(c))),
      0,
    );
    assert.ok(okIo.out.some((l) => l.includes('codeHash')));
    assert.ok(okIo.out.some((l) => l.includes('documentHash')));
    const manifest = JSON.parse(readFileSync(join(okOut, 'manifest.json'), 'utf8')) as { seed: number; status: string };
    assert.equal(manifest.seed, 5);
    assert.equal(manifest.status, 'ok');

    const badIo = captureIo();
    const badOut = join(dir, 'bad');
    const bad: ModelExecution = {
      kind: 'build-error',
      message: '采样非有限',
      name: 'ModelError',
      line: 3,
      column: 1,
      console: [],
      consoleTruncated: 0,
    };
    assert.equal(await runBuild([code, '--out', badOut], badIo.io, () => Promise.resolve(bad)), 1);
    assert.equal(existsSync(badOut), false, '失败不得留交付目录');
    assert.ok(badIo.err.some((l) => l.includes('执行出错')));

    const clashIo = captureIo();
    assert.equal(await runBuild([code, '--out', okOut], clashIo.io, (c) => Promise.resolve(okExecution(c))), 1);
    assert.ok(clashIo.err.some((l) => l.includes('已存在')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('--help 打印用法并以 0 退出', async () => {
  const io = captureIo();
  assert.equal(await runBuild(['--help'], io.io), 0);
  assert.ok(io.out.some((l) => l.includes('--code')));
});

it('failureText 覆盖执行失败分类', () => {
  assert.match(failureText({ kind: 'unsupported', message: '缺 bwrap' }), /没有可用的 bwrap/);
  assert.match(failureText({ kind: 'timeout', message: '', timeoutMs: 1000 }), /超时/);
  assert.match(
    failureText({ kind: 'precheck-error', message: '3 处问题', diagnostics: [], total: 3 }),
    /类型预检未通过（3 处）/,
  );
});
