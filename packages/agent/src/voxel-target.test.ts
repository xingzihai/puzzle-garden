/**
 * 适配选择错误必须在请求前显式拒绝；体素执行回归由 runner.test.ts 全套覆盖。
 * 决策 #112：massing / read_massing 只在草模 host 接线（`deps.massing` 存在）时暴露，
 * host 缺省时工具表 9 个、system 也不出现这两个工具名。
 */
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';

import type { MassingHostDeps } from './massing/host.ts';
import type { RunnerDeps, RunnerInput, TargetRunnerDeps } from './runner.ts';
import { TOOL_NAMES } from './tools/schemas.ts';
import { resolveTarget } from './voxel-target.ts';
import type { PromptVersionedRunnerInput } from './voxel-target.ts';

const INPUT: RunnerInput = {
  task: { raw: '', fed: '', source: null },
  seed: 0,
  mode: 'script',
  variant: 'base',
  config: null,
  limits: { maxTurns: 4, maxCostCny: 1, wallMs: 60000, submitWindow: 1 },
};

/** fixed 生产入口的形状：design-build 会把 config.promptVersion 挂到这个扩展字段。 */
const FIXED: PromptVersionedRunnerInput = { ...INPUT, variant: 'craft-small', designAuthority: 'fixed' };
const FIXED_V2: PromptVersionedRunnerInput = { ...FIXED, promptVersion: 'v2' };

const VERSIONS = {
  git: { commit: 'test', dirty: false, diff: null },
  node: '24',
  precheck: 'p',
  sandbox: 's',
  worldApi: 7,
  worldDts: 'd',
  archiveFormat: 1,
  analysis: 'a',
} as const;

/** 体素目标的 RunnerDeps；只用于 resolveTarget，check / render / store 都不会被读取。 */
function voxelDeps(massing?: MassingHostDeps): RunnerDeps {
  return {
    client: {
      complete: () => {
        throw new Error('不应请求');
      },
    },
    // 此测试只检查选择，check / render 不会被调用。
    check: {
      prechecker: {
        check: () => {
          throw new Error('不应预检');
        },
      },
      runCode: () => {
        throw new Error('不应执行');
      },
      registry: loadRegistry(),
    },
    render: () => {
      throw new Error('不应渲染');
    },
    store: {
      runId: 'unused',
      dir: 'unused',
      append: () => {
        throw new Error('不应写事件');
      },
      putBlob: () => {
        throw new Error('不应写 blob');
      },
      writeDelivery: () => {
        throw new Error('不应交付');
      },
      close: () => {
        throw new Error('不应关闭');
      },
    },
    clock: () => 0,
    countTokens: () => 0,
    versions: VERSIONS,
    worldDts: 'declare const x: 1;',
    ...(massing === undefined ? {} : { massing }),
  };
}

it('目标与版本不一致时拒绝，不执行 create', () => {
  const deps: TargetRunnerDeps = {
    client: {
      complete: () => {
        throw new Error('不应请求');
      },
    },
    // 此测试只检查选择，store 不会被读取。
    store: {
      runId: 'unused',
      dir: 'unused',
      append: () => {
        throw new Error('不应写事件');
      },
      putBlob: () => {
        throw new Error('不应写 blob');
      },
      writeDelivery: () => {
        throw new Error('不应交付');
      },
      close: () => {
        throw new Error('不应关闭');
      },
    },
    clock: () => 0,
    countTokens: () => 0,
    versions: VERSIONS,
    target: {
      kind: 'modeling',
      factsFormat: 1,
      tools: [],
      system: () => '',
      create: () => {
        throw new Error('不应创建');
      },
    },
  };
  assert.throws(() => resolveTarget(INPUT, deps), /target 与 versions.target 不一致/);
});

it('host 未接线：暴露 11 个工具（含 reference），system 不含 massing / read_massing（决策 #112）', () => {
  const target = resolveTarget(INPUT, voxelDeps());
  assert.equal(target.tools.length, 11);
  const names = target.tools.map((t) => t.function.name);
  assert.ok(names.includes('reference'));
  assert.ok(names.includes('probe'));
  assert.ok(names.includes('plan'));
  assert.ok(!names.includes('massing'));
  assert.ok(!names.includes('read_massing'));
  const system = target.system(INPUT, INPUT.limits);
  assert.ok(!system.includes('massing'));
  assert.ok(!system.includes('read_massing'));
});

it('host 接线：回到原 12 个工具、不含 reference，system 含 massing 与 read_massing（A 组行为不回退）', () => {
  const target = resolveTarget(INPUT, voxelDeps({}));
  assert.equal(target.tools.length, 12);
  assert.deepEqual(
    target.tools.map((t) => t.function.name),
    [...TOOL_NAMES],
  );
  assert.ok(!target.tools.some((t) => t.function.name === 'reference'));
  const system = target.system(INPUT, INPUT.limits);
  assert.ok(system.includes('massing'));
  assert.ok(system.includes('read_massing'));
});

it('生产 fixed 路径从 input.promptVersion 选择 v2；free / 缺省 / 旧 variant 仍是 v1', () => {
  const v2Target = resolveTarget(FIXED_V2, voxelDeps());
  const v2System = v2Target.system(FIXED_V2, FIXED_V2.limits);
  assert.ok(v2System.includes('## L0 角色与工作方法'), 'v2 应使用五层提示词');
  assert.ok(!v2System.includes('## World API 声明'), 'v2 不应常驻 world.d.ts');

  for (const input of [
    FIXED,
    { ...FIXED_V2, designAuthority: 'free' as const },
    { ...FIXED_V2, variant: 'craft' as const },
  ]) {
    const target = resolveTarget(input, voxelDeps());
    const system = target.system(input, input.limits);
    assert.ok(system.includes('## World API 声明'), '非 fixed/build 路径必须保持 v1');
    assert.ok(!system.includes('## L0 角色与工作方法'), '非 fixed/build 路径不应出现 v2');
  }
});
