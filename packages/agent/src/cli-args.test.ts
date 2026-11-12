/**
 * cli-args 的单元测试（AGENT-SPEC §9、§11）：参数解析、三者恰好一个、上限与 sealed 拒绝。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CliArgError, parseCliArgs, tightenLimits, USAGE } from './cli-args.ts';

const TASK = 'packages/agent/fixtures/tasks/small-house.md';

describe('parseCliArgs', () => {
  it('mock：默认 seed / 上限 / out，三者恰好一个', () => {
    const opts = parseCliArgs([TASK, '--mock', 's.json']);
    assert.equal(opts.taskPath, TASK);
    assert.equal(opts.seed, 0);
    assert.equal(opts.maxCny, 3.5);
    assert.equal(opts.outDir, '.work/runs/');
    assert.equal(opts.promptVariant, 'base');
    assert.deepEqual(opts.model, { kind: 'script', path: 's.json' });
    assert.deepEqual(opts.limits, { maxCostCny: 3.5, maxTurns: null, wallMs: 2_400_000, submitWindow: 3 });
  });

  it('--prompt-variant 默认 base、可显式 base/craft/v02hint/craft2/craft-small/skeleton/detail/blueprint/refine，非法值报错含新列表', () => {
    assert.ok(USAGE.includes('--prompt-variant') && USAGE.includes('craft-small'), 'usage 应列出 craft-small');
    assert.equal(parseCliArgs([TASK, '--live', '--prompt-variant', 'base']).promptVariant, 'base');
    assert.equal(parseCliArgs([TASK, '--live', '--prompt-variant', 'craft']).promptVariant, 'craft');
    assert.equal(parseCliArgs([TASK, '--live', '--prompt-variant', 'v02hint']).promptVariant, 'v02hint');
    assert.equal(parseCliArgs([TASK, '--live', '--prompt-variant', 'craft2']).promptVariant, 'craft2');
    assert.equal(parseCliArgs([TASK, '--live', '--prompt-variant', 'craft-small']).promptVariant, 'craft-small');
    assert.equal(parseCliArgs([TASK, '--live', '--prompt-variant', 'skeleton']).promptVariant, 'skeleton');
    assert.equal(parseCliArgs([TASK, '--live', '--prompt-variant', 'detail']).promptVariant, 'detail');
    assert.equal(parseCliArgs([TASK, '--live', '--prompt-variant', 'blueprint']).promptVariant, 'blueprint');
    assert.equal(parseCliArgs([TASK, '--live', '--prompt-variant', 'refine']).promptVariant, 'refine');
    assert.throws(
      () => parseCliArgs([TASK, '--live', '--prompt-variant', 'fancy']),
      (e: unknown) =>
        e instanceof CliArgError &&
        e.message.includes('--prompt-variant') &&
        e.message.includes('skeleton') &&
        e.message.includes('craft-small'),
    );
    assert.throws(
      () => parseCliArgs([TASK, '--live', '--prompt-variant']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('缺少取值'),
    );
  });

  it('--seed-code：解析路径、可缺省；缺值报错', () => {
    assert.equal(parseCliArgs([TASK, '--live']).seedCode, undefined);
    assert.equal(parseCliArgs([TASK, '--live', '--seed-code', 'draft/building.ts']).seedCode, 'draft/building.ts');
    assert.throws(
      () => parseCliArgs([TASK, '--live', '--seed-code']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('--seed-code') && e.message.includes('缺少取值'),
    );
  });

  it('--gates：解析路径、可缺省；缺值报错', () => {
    assert.equal(parseCliArgs([TASK, '--live']).gatesPath, undefined);
    assert.equal(
      parseCliArgs([TASK, '--live', '--gates', 'benchmark/tasks/m1-07.gates.json']).gatesPath,
      'benchmark/tasks/m1-07.gates.json',
    );
    assert.throws(
      () => parseCliArgs([TASK, '--live', '--gates']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('--gates') && e.message.includes('缺少取值'),
    );
  });

  it('--require-design / --seed-design / --seed-images：解析、可缺省、缺值报错', () => {
    const base = parseCliArgs([TASK, '--live']);
    assert.equal(base.requireDesign, false);
    assert.equal(base.seedDesign, undefined);
    assert.equal(base.seedImages, undefined);

    const two = parseCliArgs([
      TASK,
      '--live',
      '--require-design',
      '--seed-design',
      'draft/design.md',
      '--seed-images',
      'draft/render',
    ]);
    assert.equal(two.requireDesign, true);
    assert.equal(two.seedDesign, 'draft/design.md');
    assert.equal(two.seedImages, 'draft/render');

    assert.throws(
      () => parseCliArgs([TASK, '--live', '--seed-design']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('--seed-design') && e.message.includes('缺少取值'),
    );
    assert.throws(
      () => parseCliArgs([TASK, '--live', '--seed-images']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('--seed-images') && e.message.includes('缺少取值'),
    );
  });

  it('replay / live 各自成立，且能覆盖 seed、上限与 out', () => {
    assert.deepEqual(parseCliArgs([TASK, '--replay', '.work/runs/x', '--seed', '7']).model, {
      kind: 'replay',
      runDir: '.work/runs/x',
    });
    const live = parseCliArgs([TASK, '--live', '--max-cny', '1.25', '--out', '/tmp/x']);
    assert.deepEqual(live.model, { kind: 'live' });
    assert.equal(live.limits.maxCostCny, 1.25);
    assert.equal(live.outDir, '/tmp/x');
  });

  it('坏样本：多个 / 零个模型来源都报错并给提示', () => {
    assert.throws(
      () => parseCliArgs([TASK]),
      (e: unknown) => e instanceof CliArgError && e.message.includes('恰好给一个'),
    );
    assert.throws(
      () => parseCliArgs([TASK, '--mock', 's.json', '--live']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('恰好给一个'),
    );
    assert.throws(
      () => parseCliArgs([TASK, '--replay', 'r', '--mock', 'm']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('恰好给一个'),
    );
  });

  it('坏样本：缺少题面、未知参数、缺取值、多个题面', () => {
    assert.throws(
      () => parseCliArgs(['--live']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('缺少题面'),
    );
    assert.throws(
      () => parseCliArgs([TASK, '--bogus']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('不认识的参数'),
    );
    assert.throws(
      () => parseCliArgs([TASK, '--mock']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('缺少取值'),
    );
    assert.throws(
      () => parseCliArgs([TASK, 'x.md', '--live']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('只接受一个题面'),
    );
  });

  it('坏样本：seed 非整数 / 越界，max-cny 非数 / 超 3.5', () => {
    assert.throws(() => parseCliArgs([TASK, '--live', '--seed', '1.5']), /--seed/);
    assert.throws(() => parseCliArgs([TASK, '--live', '--seed', '4294967296']), /--seed/);
    assert.throws(() => parseCliArgs([TASK, '--live', '--max-cny', '0']), /--max-cny/);
    assert.throws(() => parseCliArgs([TASK, '--live', '--max-cny', '3.6']), /--max-cny/);
    assert.equal(parseCliArgs([TASK, '--live', '--max-cny', '3.5']).maxCny, 3.5);
  });

  it('坏样本：/sealed/ 路径被 assertTaskPath 拒绝', () => {
    assert.throws(
      () => parseCliArgs(['/x/sealed/t.md', '--live']),
      (e: unknown) => e instanceof CliArgError && e.message.includes('sealed'),
    );
  });
});

describe('tightenLimits', () => {
  const limits = { maxCostCny: 3.5, maxTurns: 60 };
  it('环境变量更小时收紧', () => {
    assert.deepEqual(tightenLimits(limits, 1), { maxCostCny: 1, maxTurns: 60 });
  });
  it('未设、为 0 或更大时不放宽', () => {
    assert.equal(tightenLimits(limits, undefined), limits);
    assert.equal(tightenLimits(limits, 0), limits);
    assert.equal(tightenLimits(limits, 10), limits);
  });
});
