import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createClient } from '@pg/llm/client';
import { createScriptedFetch, createVirtualTime, ScriptSchema } from '@pg/llm/mock';
import { MAX_CODE_BYTES } from '@pg/sandbox/run';

import type { CliOptions } from './cli-args.ts';
import {
  buildRunnerInput,
  originalLimits,
  readGates,
  readSeedCode,
  readSeedDesign,
  readSeedImages,
} from './cli-deps.ts';
import type { ModelRuntime } from './cli-deps.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'pg-cli-deps-'));
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('readSeedCode（--seed-code 种子稿）', () => {
  it('正常：原样读回 UTF-8 内容', () => {
    const path = join(ROOT, 'ok.ts');
    const code = 'export default function build(w: World): void {}\n';
    writeFileSync(path, code);
    assert.equal(readSeedCode(path), code);
  });

  it('空文件或全空白：报错，信息写清路径', () => {
    const empty = join(ROOT, 'empty.ts');
    writeFileSync(empty, '');
    assert.throws(
      () => readSeedCode(empty),
      (e: unknown) => e instanceof Error && e.message.includes(empty),
    );
    const blank = join(ROOT, 'blank.ts');
    writeFileSync(blank, '  \n\t\n');
    assert.throws(() => readSeedCode(blank), /空文件或全空白/);
  });

  it('超过代码字节上限：报错，信息给出实际字节与上限', () => {
    const path = join(ROOT, 'huge.ts');
    writeFileSync(path, 'x'.repeat(MAX_CODE_BYTES + 1));
    assert.throws(
      () => readSeedCode(path),
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes(String(MAX_CODE_BYTES + 1)) &&
        e.message.includes(String(MAX_CODE_BYTES)),
    );
  });

  it('文件读不到：报错并带路径', () => {
    const path = join(ROOT, 'nope.ts');
    assert.throws(
      () => readSeedCode(path),
      (e: unknown) => e instanceof Error && e.message.includes(path),
    );
  });
});

describe('readSeedDesign（--seed-design 骨架设计文档）', () => {
  it('正常：去掉首尾空行后读回', () => {
    const path = join(ROOT, 'design.md');
    writeFileSync(path, '\n\n# 设计文档\n- 任务目标\n\n');
    assert.equal(readSeedDesign(path), '# 设计文档\n- 任务目标');
  });

  it('空文件或全空白：报错并带路径', () => {
    const path = join(ROOT, 'empty-design.md');
    writeFileSync(path, '  \n\t\n');
    assert.throws(
      () => readSeedDesign(path),
      (e: unknown) => e instanceof Error && e.message.includes(path) && e.message.includes('空文件或全空白'),
    );
  });

  it('超过 24000 字符：报错并给出实际与上限', () => {
    const path = join(ROOT, 'huge-design.md');
    writeFileSync(path, 'x'.repeat(24001));
    assert.throws(
      () => readSeedDesign(path),
      (e: unknown) => e instanceof Error && e.message.includes('24001') && e.message.includes('24000'),
    );
  });

  it('文件读不到：报错并带路径', () => {
    const path = join(ROOT, 'nope-design.md');
    assert.throws(
      () => readSeedDesign(path),
      (e: unknown) => e instanceof Error && e.message.includes(path),
    );
  });
});

describe('readSeedImages（--seed-images 骨架渲染图）', () => {
  it('按固定顺序读存在的图', () => {
    const dir = join(ROOT, 'render');
    mkdirSync(dir);
    writeFileSync(join(dir, 'top.png'), Uint8Array.from([2]));
    writeFileSync(join(dir, 'iso-se.png'), Uint8Array.from([1]));
    const images = readSeedImages(dir);
    assert.deepEqual(
      images.map((i) => i.name),
      ['iso-se.png', 'top.png'],
    );
    assert.deepEqual([...images[0]!.png], [1]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('目录里没有任何一张固定名字的图：报错并带目录', () => {
    const dir = join(ROOT, 'empty-render');
    mkdirSync(dir);
    assert.throws(
      () => readSeedImages(dir),
      (e: unknown) => e instanceof Error && e.message.includes(dir) && e.message.includes('iso-se.png'),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('目录不存在：报错', () => {
    assert.throws(() => readSeedImages(join(ROOT, 'no-such-dir')), /iso-se\.png/);
  });
});

describe('readGates（--gates 门槛配置）', () => {
  it('正常：JSON.parse + schema 通过，返回解析后的配置', () => {
    const path = join(ROOT, 'gates.json');
    writeFileSync(
      path,
      JSON.stringify({
        forbidApis: ['set', 'box'],
        symmetry: { axis: 'x', at: 0, min: 0.99 },
        reachAll: true,
        floatingAllowApis: ['roof'],
      }),
    );
    assert.deepEqual(readGates(path), {
      forbidApis: ['set', 'box'],
      symmetry: { axis: 'x', at: 0, min: 0.99 },
      reachAll: true,
      floatingAllowApis: ['roof'],
    });
  });

  it('文件不存在：报错并带路径', () => {
    const path = join(ROOT, 'nope.json');
    assert.throws(
      () => readGates(path),
      (e: unknown) => e instanceof Error && e.message.includes(path) && e.message.includes('读不到'),
    );
  });

  it('非法 JSON：报错并带路径与原因', () => {
    const path = join(ROOT, 'bad.json');
    writeFileSync(path, '{ not json');
    assert.throws(
      () => readGates(path),
      (e: unknown) => e instanceof Error && e.message.includes(path) && e.message.includes('不是合法 JSON'),
    );
  });

  it('schema 不过（未知字段 / min=0）：报错并列出问题', () => {
    const unknown = join(ROOT, 'unknown.json');
    writeFileSync(unknown, JSON.stringify({ bogus: 1 }));
    assert.throws(
      () => readGates(unknown),
      (e: unknown) => e instanceof Error && e.message.includes(unknown) && e.message.includes('不合 gatesSchema'),
    );
    const badMin = join(ROOT, 'bad-min.json');
    writeFileSync(badMin, JSON.stringify({ symmetry: { axis: 'x', min: 0 } }));
    assert.throws(() => readGates(badMin), /不合 gatesSchema/);
  });
});

describe('originalLimits（strict 回放取原 run 的上限）', () => {
  it('取 run.start.limits，旧 run 的 maxTurns 数字原样保留', () => {
    const limits = { maxCostCny: 3.5, maxTurns: 60, wallMs: 2_400_000, submitWindow: 3 };
    const events = [
      { type: 'run.start', body: { limits } },
      { type: 'turn.start', body: {} },
    ];
    assert.deepEqual(originalLimits(events), limits);
  });

  it('不限轮数的新 run：maxTurns 为 null', () => {
    const limits = { maxCostCny: 3.5, maxTurns: null, wallMs: 2_400_000, submitWindow: 3 };
    assert.deepEqual(originalLimits([{ type: 'run.start', body: { limits } }]), limits);
  });

  it('没有 run.start 时报错', () => {
    assert.throws(() => originalLimits([{ type: 'turn.start', body: {} }]), /run\.start/);
  });
});

describe('buildRunnerInput（种子稿组装）', () => {
  const vt = createVirtualTime();
  const client = createClient({
    config: { baseUrl: 'https://mock.invalid', apiKey: 'k', timeoutMs: 1000 },
    fetch: createScriptedFetch(
      ScriptSchema.parse({
        name: 'dummy',
        task: '# t\n',
        steps: [{ reply: { kind: 'message', content: '好' } }],
      }),
      1,
    ),
    sleep: vt.sleep,
    clock: vt.clock,
  });
  const model: ModelRuntime = {
    client,
    mode: 'script',
    script: { name: 'dummy', sha256: 'a'.repeat(64) },
    config: null,
    clock: vt.clock,
  };
  const opts: CliOptions = {
    taskPath: 't.md',
    seed: 0,
    maxCny: 3.5,
    outDir: '.work/runs/',
    promptVariant: 'detail',
    requireDesign: false,
    model: { kind: 'script', path: 's.json' },
    limits: { maxCostCny: 3.5, maxTurns: null, wallMs: 2_400_000, submitWindow: 3 },
  };
  const task = { raw: '# t\n', fed: '# t\n', source: null };

  it('给了初稿代码：RunInput 带 initialDraft', () => {
    const input = buildRunnerInput(opts, task, model, 'export default function build(w: World): void {}\n');
    assert.deepEqual(input.initialDraft, { code: 'export default function build(w: World): void {}\n' });
    assert.equal(input.variant, 'detail');
  });

  it('不给初稿代码：RunInput 无 initialDraft', () => {
    assert.equal(buildRunnerInput(opts, task, model).initialDraft, undefined);
  });

  it('requireDesign / initialDesign / initialImages 组装进 RunInput', () => {
    const images = [{ name: 'iso-se.png', png: Uint8Array.from([1, 2]) }];
    const input = buildRunnerInput(opts, task, model, undefined, '# 设计', images);
    assert.equal(input.requireDesign, undefined);
    assert.equal(input.initialDesign, '# 设计');
    assert.equal(input.initialImages, images);

    const required = buildRunnerInput({ ...opts, requireDesign: true }, task, model);
    assert.equal(required.requireDesign, true);
    assert.equal(required.initialDesign, undefined);
    assert.equal(required.initialImages, undefined);
  });
});
