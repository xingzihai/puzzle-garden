/**
 * check_code 的单元测试（AGENT-SPEC §4.2、§5）：用假 prechecker / 假 runCode 覆盖每条分支。
 * 执行成功的路径用真 registry 与真存档，跑全部测量。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { interfaceSpecSchema } from '@pg/analysis/block-interface';
import type { MassingColorCandidate } from '@pg/blocks/color';
import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import { hashGrid } from '@pg/core/hash';
import type { Grid } from '@pg/core/grid';
import { API_VERSION, createWorld, rect } from '@pg/geometry';
import type { MassingDocument } from '@pg/geometry';
import { createModel } from '@pg/modeling/model';
import type { PrecheckResult } from '@pg/sandbox/precheck';
import { SandboxError } from '@pg/sandbox/precheck';
import type { RunInput, RunResult } from '@pg/sandbox/run';

import { checkCode } from './check.ts';
import type { CheckDeps } from './check.ts';

const registry = loadRegistry();

interface Built {
  readonly archive: Uint8Array;
  readonly grid: Grid;
  readonly hash: string;
}

/** 平屋面 + 直跑梯上屋顶的小样本：执行成功后目标全部可达。 */
function built(): Built {
  const host = createWorld(registry.table);
  const w = host.world;
  const base = w.plinth({ footprint: rect(-6, -6, 6, 6), height: 1, material: 'stone_bricks' });
  const hall = w.walls({ on: base, height: 6, material: 'stone_bricks' });
  w.opening({ in: hall.facade('south'), kind: 'door', width: 1, height: 3 });
  const floor = w.floorPlate({ in: hall.inner, material: 'oak_planks' });
  const roof = w.roof({ on: hall, kind: 'flat', material: 'stone', parapet: { height: 1, material: 'stone' } });
  if (roof.top === undefined) throw new Error('平屋面应返回 top');
  w.stair({ from: floor.top, to: roof.top, kind: 'straight', at: [-3, 3], facing: 'north', material: 'oak_stairs' });
  const { grid } = host.compose();
  return { archive: writeArchive(grid, API_VERSION), grid, hash: hashGrid(grid) };
}

function okRun(build: Built, consoleTruncated = 0): RunResult {
  return {
    kind: 'ok',
    grid: build.grid,
    archive: build.archive,
    hash: build.hash,
    report: {
      status: 'ok',
      hash: build.hash,
      calls: build.grid.calls().length,
      overlaps: [{ kind: 'same-layer', winner: 1, loser: 2, cells: 1 }],
      console: [{ level: 'log', text: 'hi' }],
      consoleTruncated,
    },
    wallMs: 12,
  };
}

function depsOf(overrides: {
  readonly precheck?: PrecheckResult | (() => Promise<PrecheckResult>);
  readonly run?: (input: RunInput) => Promise<RunResult>;
  readonly onRun?: () => void;
  readonly gates?: CheckDeps['gates'];
  readonly candidates?: () => readonly MassingColorCandidate[];
  readonly interfaces?: CheckDeps['interfaces'];
}): { deps: CheckDeps; ran: () => boolean } {
  let ran = false;
  let now = 0;
  const precheck = overrides.precheck ?? { kind: 'ok' };
  const run = overrides.run ?? (() => Promise.resolve(okRun(built())));
  return {
    deps: {
      prechecker: {
        check: () => (typeof precheck === 'function' ? precheck() : Promise.resolve(precheck)),
      },
      runCode: (input) => {
        ran = true;
        overrides.onRun?.();
        return run(input);
      },
      registry,
      ...(overrides.gates === undefined ? {} : { gates: overrides.gates }),
      ...(overrides.candidates === undefined ? {} : { massingColorCandidates: overrides.candidates }),
      ...(overrides.interfaces === undefined ? {} : { interfaces: overrides.interfaces }),
      clock: () => {
        now += 3;
        return now;
      },
    },
    ran: () => ran,
  };
}

const buildError: RunResult = {
  kind: 'build-error',
  report: {
    status: 'build-error',
    error: { name: 'Error', message: 'steps 盖到了此前 walls#3 的格', line: 31, column: 3 },
    hash: '',
    calls: 0,
    overlaps: [],
    console: [{ level: 'warn', text: 'oops' }],
    consoleTruncated: 0,
  },
  wallMs: 7,
};

describe('checkCode 执行成功', () => {
  it('首行、测量、console 与宿主侧摘要', async () => {
    const build = built();
    const { deps } = depsOf({ run: () => Promise.resolve(okRun(build)) });
    const result = await checkCode({ code: 'x', version: 8, seed: 5 }, deps);
    assert.equal(result.status, 'ok');
    assert.match(
      result.text,
      /^第 v8 版：执行成功，\d+ 格，包围盒 \([-\d,]+\)–\([-\d,]+\)，调用 \d+ 次。覆盖：同层替代 1 处 \/ 跨层覆盖 0 处。\n/,
    );
    assert.match(result.text, /测量（事实，不判合格）：\n/);
    assert.match(result.text, /用了：/);
    assert.match(result.text, /console（1 条）：\n {2}\[log\] hi$/);
    assert.ok(!result.text.includes('到不了'));
    assert.deepEqual(result.precheck, { kind: 'ok' });
    assert.ok(result.run !== null && result.run.kind === 'ok');
    assert.equal(result.run.cells, build.grid.size);
    assert.equal(result.run.hash, build.hash);
    assert.equal(result.run.overlaps.sameLayer, 1);
    assert.equal(result.run.overlaps.crossLayer, 0);
    assert.equal(result.run.console, 1);
    assert.equal(result.run.wallMs, 12);
    assert.ok(result.archive instanceof Uint8Array);
    assert.ok(result.measures !== undefined);
    assert.ok(Array.isArray(result.measures.symmetry.axes));
    assert.ok(result.apiCalls !== undefined);
    assert.equal(result.apiCalls['plinth'], 1);
    assert.equal(result.apiCalls['roof'], 1);
    assert.equal(result.wallMs > 0, true);
  });

  it('console 被截断时计总数并注明明细，空网格用"无"与零包围盒', async () => {
    const empty = createWorld(registry.table).compose().grid;
    const run: RunResult = {
      kind: 'ok',
      grid: empty,
      archive: writeArchive(empty, API_VERSION),
      hash: hashGrid(empty),
      report: { status: 'ok', hash: '', calls: 0, overlaps: [], console: [], consoleTruncated: 2 },
      wallMs: 1,
    };
    const { deps } = depsOf({ run: () => Promise.resolve(run) });
    const result = await checkCode({ code: 'x', version: 2, seed: 0 }, deps);
    assert.equal(result.status, 'ok');
    assert.match(result.text, /包围盒 无，调用 0 次/);
    assert.match(result.text, /console（2 条）：\n {2}…另有 2 条被丢弃/);
    assert.ok(result.run !== null && result.run.kind === 'ok');
    assert.deepEqual(result.run.bounds, [0, 0, 0, 0, 0, 0]);
  });
  it('旧报告截断时 run.overlaps 仅记保留项的已知分类，工具明确省略数与分类未知', async () => {
    const base = okRun(built());
    if (base.kind !== 'ok') throw new Error('okRun 应是 ok');
    const run: RunResult = { ...base, report: { ...base.report, overlapsTruncated: 4 } };
    const { deps } = depsOf({ run: () => Promise.resolve(run) });
    const result = await checkCode({ code: 'x', version: 2, seed: 0 }, deps);
    assert.ok(result.run !== null && result.run.kind === 'ok');
    assert.deepEqual(result.run.overlaps, { sameLayer: 1, crossLayer: 0 });
    assert.match(result.text, /覆盖：保留项同层替代 1 处 \/ 跨层覆盖 0 处/);
    assert.match(result.text, /覆盖明细省略 4 项，同层\/跨层分类未知/);
  });
  it('新报告从完整概览分类和展示损失，裁掉的样例不靠存档调用表重建', async () => {
    const base = okRun(built());
    assert.equal(base.kind, 'ok');
    const run: RunResult = {
      ...base,
      report: {
        ...base.report,
        reportFormat: 2,
        overlapsTruncated: 700,
        overlapSummary: {
          sameLayer: 10,
          crossLayer: 691,
          lostDecor: 800,
          groupsOmitted: 2,
          groups: [
            {
              winner: 500,
              loser: 600,
              cells: 400,
              sample: [8, 20, 8],
              sampleDetail: {
                expectedState: 'quartz_slab[type=top]',
                actualState: 'deepslate_tile_slab',
                winnerSource: { api: 'box', line: 51, writeLayer: 'structure' },
                loserSource: { api: 'set', line: 72, writeLayer: 'decoration' },
              },
            },
          ],
        },
      },
    };
    const { deps } = depsOf({ run: () => Promise.resolve(run) });
    const result = await checkCode({ code: 'x', version: 2, seed: 0 }, deps);
    assert.ok(result.run?.kind === 'ok');
    assert.deepEqual(result.run.overlaps, { sameLayer: 10, crossLayer: 691 });
    assert.match(
      result.text,
      /同层替代 10 处 \/ 跨层覆盖 691 处。\n覆盖明细省略 700 项；上述计数来自完整概览。\n手写装饰被盖掉 800 格[^\n]*\n {2}400 格，例 \(8,20,8\)：代码请求状态 quartz_slab\[type=top\] → 最终状态 deepslate_tile_slab（覆盖）；败方 set#600（第 72 行，装饰层）；胜方 box#500（第 51 行，结构层）/,
    );
  });
});

describe('checkCode 指定接口（离线事实，不作门槛）', () => {
  const one = interfaceSpecSchema.parse({
    name: '<柱梁> & "接口"',
    from: { x: 0, y: 2, z: 0 },
    to: { x: 0, y: 3, z: 0 },
    axis: 'y',
  });

  /** 真存档与故意相反的 run.grid，确保诊断从最终存档读取，不信缓存网格或调用参数。 */
  function interfaceRun(to: string | null): RunResult {
    const grid = createGrid(registry.table);
    const first = grid.defineCall('box', 17, { material: 'oak_slab' });
    const last = grid.defineCall('set', 23, {});
    grid.set(0, 2, 0, parseState(registry.table, 'stone'), 0, first);
    if (to !== null) grid.set(0, 3, 0, parseState(registry.table, to), 0, last);
    const base = okRun({ grid, archive: writeArchive(grid, API_VERSION), hash: hashGrid(grid) });
    assert.equal(base.kind, 'ok');
    return { ...base, grid: createGrid(registry.table) };
  }

  it('好/坏/unsupported/missing 双向，来源与实际状态进入工具文本，状态始终 ok', async () => {
    const cases = [
      { state: 'oak_slab', status: 'contact', gap: 0, area: 1 },
      { state: 'oak_slab[type=top]', status: 'gap', gap: 0.5, area: 1 },
      { state: 'oak_fence', status: 'unsupported', gap: null, area: null },
      { state: null, status: 'missing', gap: null, area: null },
    ] as const;
    for (const c of cases) {
      const { deps } = depsOf({ run: () => Promise.resolve(interfaceRun(c.state)), interfaces: [one] });
      const result = await checkCode({ code: 'x', version: 3, seed: 0 }, deps);
      assert.equal(result.status, 'ok');
      assert.equal(result.gates, undefined);
      assert.deepEqual(result.interfaces, [
        {
          ...one,
          status: c.status,
          gap: c.gap,
          area: c.area,
          fromState: 'stone',
          toState: c.state,
          fromSource: { id: 1, api: 'box', line: 17 },
          toSource: c.state === null ? null : { id: 2, api: 'set', line: 23 },
        },
      ]);
      assert.match(result.text, /指定接口（事实，不判合格）：共 1 项/);
      assert.match(result.text, /unsupported 未判定接触/);
      assert.match(result.text, /未列节点未检查/);
      assert.ok(result.text.indexOf('指定接口') < result.text.indexOf('测量（事实，不判合格）'));
      if (c.status === 'contact') assert.match(result.text, /指定的 1 项全部 contact/);
      else {
        assert.match(result.text, /\(0,2,0\) stone（box#1 building.ts:17） → \(0,3,0\)/);
        assert.ok(result.text.includes(c.status));
        if (c.state !== null) assert.ok(result.text.includes(`${c.state}（set#2 building.ts:23）`));
      }
      if (c.status === 'gap') assert.match(result.text, /gap=0.5 格，投影 area=1 格²/);
    }
  });

  it('32 项可执行，计全部但最多展开 4 个问题；显式空清单报零项', async () => {
    const { deps } = depsOf({
      run: () => Promise.resolve(interfaceRun('oak_slab[type=top]')),
      interfaces: Array.from({ length: 32 }, () => one),
    });
    const result = await checkCode({ code: 'x', version: 1, seed: 0 }, deps);
    assert.equal(result.status, 'ok');
    assert.equal(result.interfaces?.length, 32);
    assert.match(result.text, /共 32 项，contact 0 \/ gap 32/);
    assert.equal(result.text.split('\n').filter((line) => line.includes('gap=0.5 格')).length, 4);
    assert.match(result.text, /另有 28 项问题未展开/);
    const empty = await checkCode({ code: 'x', version: 1, seed: 0 }, { ...deps, interfaces: [] });
    assert.deepEqual(empty.interfaces, []);
    assert.match(empty.text, /共 0 项/);
    assert.doesNotMatch(empty.text, /全部 contact/);
    const good = await checkCode(
      { code: 'x', version: 1, seed: 0 },
      {
        ...deps,
        runCode: () => Promise.resolve(interfaceRun('oak_slab')),
      },
    );
    assert.match(good.text, /共 32 项，contact 32/);
    assert.match(good.text, /指定的 32 项全部 contact/);
    assert.equal(
      good.interfaces?.every((item) => item.status === 'contact'),
      true,
    );
  });

  it('侧向异半砖仅棱接，工具报告 edge-only，不误称全部 contact', async () => {
    const grid = createGrid(registry.table);
    grid.set(0, 2, 0, parseState(registry.table, 'oak_slab'), 0, 0);
    grid.set(1, 2, 0, parseState(registry.table, 'oak_slab[type=top]'), 0, 0);
    const side = interfaceSpecSchema.parse({ ...one, axis: 'x', to: { x: 1, y: 2, z: 0 } });
    const { deps } = depsOf({
      interfaces: [side],
      run: () =>
        Promise.resolve(
          okRun({
            grid,
            archive: writeArchive(grid, API_VERSION),
            hash: hashGrid(grid),
          }),
        ),
    });
    const result = await checkCode({ code: 'x', version: 1, seed: 0 }, deps);
    assert.equal(result.status, 'ok');
    assert.equal(result.interfaces?.[0]?.status, 'edge-only');
    assert.match(result.text, /edge-only 1/);
    assert.match(result.text, /gap=0 格，投影 area=0 格²/);
    assert.doesNotMatch(result.text, /全部 contact/);
  });

  it('超 32、未知键、非整数、非相邻均在预检/执行前拒绝，宿主错误不伪装建筑缺陷', async () => {
    for (const interfaces of [
      Array.from({ length: 33 }, () => one),
      [{ ...one, extra: true }],
      [{ ...one, from: { ...one.from, extra: true } }],
      [{ ...one, from: { ...one.from, y: 2.5 } }],
      [{ ...one, from: { ...one.from, y: 2048 }, to: { ...one.to, y: 2049 } }],
      [{ ...one, to: one.from }],
    ]) {
      let prechecked = false;
      const { deps, ran } = depsOf({
        precheck: () => {
          prechecked = true;
          return Promise.resolve({ kind: 'ok' });
        },
      });
      const result = await checkCode({ code: 'x', version: 1, seed: 0 }, { ...deps, interfaces });
      assert.equal(result.status, 'internal-error');
      assert.match(result.text, /指定接口配置无效，没有执行/);
      assert.equal(result.precheck, null);
      assert.equal(result.run, null);
      assert.equal('interfaces' in result, false);
      assert.equal(prechecked, false);
      assert.equal(ran(), false);
    }
  });

  it('缺省不新增字段或接触结论，执行失败不产生接口报告', async () => {
    const { deps } = depsOf({ run: () => Promise.resolve(interfaceRun('oak_slab')) });
    const result = await checkCode({ code: 'x', version: 1, seed: 0 }, deps);
    assert.equal('interfaces' in result, false);
    assert.doesNotMatch(result.text, /指定接口|contact|接触/);
    const failed = depsOf({ interfaces: [one], run: () => Promise.resolve(buildError) });
    const failure = await checkCode({ code: 'x', version: 1, seed: 0 }, failed.deps);
    assert.equal('interfaces' in failure, false);
    assert.doesNotMatch(failure.text, /指定接口|contact/);
  });
});

describe('checkCode 门槛（AGENT-SPEC §5.1）', () => {
  it('配了 gates：门槛行插在首行之后、测量段之前，CheckResult.gates 正确', async () => {
    const build = built();
    const { deps } = depsOf({ run: () => Promise.resolve(okRun(build)), gates: { forbidApis: ['plinth'] } });
    const result = await checkCode({ code: 'x', version: 8, seed: 5 }, deps);
    assert.equal(result.status, 'ok');
    assert.ok(result.gates !== undefined);
    assert.equal(result.gates.passed, false);
    assert.match(result.gates.failed[0] ?? '', /^只用构件：plinth 共 \d+ 格写入$/);
    const lines = result.text.split('\n');
    assert.match(lines[0] ?? '', /^第 v8 版：执行成功/);
    assert.equal(lines[1], '门槛（骨架阶段）：未过 1/1 项，过门槛前 submit 会被拒绝：');
    assert.match(lines[2] ?? '', /^ {2}✗ 只用构件：plinth 共 /);
    assert.match(result.text, /测量（事实，不判合格）：/);
  });

  it('门槛全过：首行后两行——"全部通过"与 submit 语义收尾提示', async () => {
    const build = built();
    const { deps } = depsOf({ run: () => Promise.resolve(okRun(build)), gates: { forbidApis: ['set'] } });
    const result = await checkCode({ code: 'x', version: 8, seed: 5 }, deps);
    assert.deepEqual(result.gates, { passed: true, failed: [] });
    assert.match(
      result.text,
      /^第 v8 版：执行成功[^\n]*\n门槛（骨架阶段）：全部通过。\n骨架门槛已过：submit 会被接受（仅表示提交不会被拒）；完成度看对象差异与 must 证据；check 通过 ≠ review 满意。\n/,
    );
  });

  it('六个字段的配置经 checkCode 生效（reachInsideWalls / structureSpans 走 registry）', async () => {
    const build = built();
    const { deps } = depsOf({
      run: () => Promise.resolve(okRun(build)),
      gates: {
        forbidApis: ['set', 'box'],
        symmetry: { axis: 'x', at: 0, min: 0.99 },
        structureSpans: { x: [108, 133], z: [162, 198] },
        reachAll: true,
        reachInsideWalls: { minRatio: 0.5 },
        floatingAllowApis: ['roof'],
      },
    });
    const result = await checkCode({ code: 'x', version: 8, seed: 5 }, deps);
    assert.equal(result.status, 'ok');
    assert.ok(result.gates !== undefined);
    assert.equal(result.gates.passed, false);
    // 小体量的结构跨度远小于 108–133，结构门槛必须报红。
    assert.match(result.gates.failed.join('\n'), /^结构跨度：/m);
  });

  it('不配 gates：文本与 gates 字段与现在逐字相同', async () => {
    const build = built();
    const { deps } = depsOf({ run: () => Promise.resolve(okRun(build)) });
    const result = await checkCode({ code: 'x', version: 8, seed: 5 }, deps);
    assert.equal(result.gates, undefined);
    assert.ok(!result.text.includes('门槛'));
    assert.match(result.text, /^第 v8 版：执行成功[^\n]*\n测量（事实，不判合格）：/);
  });
});

describe('checkCode 预检未过', () => {
  const failed: PrecheckResult = {
    kind: 'failed',
    total: 2,
    diagnostics: [
      {
        line: 9,
        column: 81,
        code: 'TS2820',
        message: 'Type \'"stone_brikcs"\' is not assignable.',
        source: "w.plinth({ material: 'stone_brikcs' })",
      },
      { line: 10, column: 1, code: 'PG001', message: 'x', source: 'y' },
    ],
  };

  it('输出 TypeScript 英文诊断并附源码，runCode 不执行', async () => {
    const { deps, ran } = depsOf({ precheck: failed });
    const result = await checkCode({ code: 'x', version: 8, seed: 0 }, deps);
    assert.equal(result.status, 'precheck-failed');
    assert.match(result.text, /^第 v8 版：类型预检未通过（2 处，显示前 2 处）：\n/);
    assert.match(result.text, /building\.ts:9:81 TS2820 Type '"stone_brikcs"' is not assignable\.\n {4}w\.plinth/);
    assert.equal(result.run, null);
    assert.equal(result.measures, undefined);
    assert.deepEqual(result.precheck, {
      kind: 'failed',
      total: 2,
      diagnostics: [
        { line: 9, column: 81, code: 'TS2820', message: 'Type \'"stone_brikcs"\' is not assignable.' },
        { line: 10, column: 1, code: 'PG001', message: 'x' },
      ],
    });
    assert.equal(ran(), false);
  });

  it('too-large / timeout / out-of-memory 各一行，runCode 不执行', async () => {
    const cases: readonly { readonly precheck: PrecheckResult; readonly status: string; readonly re: RegExp }[] = [
      {
        precheck: { kind: 'too-large', bytes: 300_000, limit: 262_144 },
        status: 'precheck-too-large',
        re: /代码 300000 字节，超过上限 262144 字节/,
      },
      { precheck: { kind: 'timeout', limitMs: 10_000 }, status: 'precheck-timeout', re: /超过 10000 ms 未完成/ },
      {
        precheck: { kind: 'out-of-memory', limitMiB: 1024 },
        status: 'precheck-out-of-memory',
        re: /用尽 1024 MiB 内存/,
      },
    ];
    for (const c of cases) {
      const { deps, ran } = depsOf({ precheck: c.precheck });
      const result = await checkCode({ code: 'x', version: 1, seed: 0 }, deps);
      assert.equal(result.status, c.status);
      assert.match(result.text, c.re);
      assert.equal(ran(), false);
    }
  });

  it('预检抛出 SandboxError → internal-error，precheck 为 null', async () => {
    const { deps } = depsOf({
      precheck: () => Promise.reject(new SandboxError('internal', '预检线程异常')),
    });
    const result = await checkCode({ code: 'x', version: 3, seed: 0 }, deps);
    assert.equal(result.status, 'internal-error');
    assert.equal(result.precheck, null);
    assert.equal(result.run, null);
    assert.match(result.text, /第 v3 版：类型预检内部错误：预检线程异常/);
  });
});

describe('checkCode 执行未过', () => {
  it('build-error：带行号的英文冒号写法与"没有测量"', async () => {
    const { deps } = depsOf({ run: () => Promise.resolve(buildError) });
    const result = await checkCode({ code: 'x', version: 8, seed: 0 }, deps);
    assert.equal(result.status, 'build-error');
    assert.equal(
      result.text,
      '第 v8 版：执行出错 building.ts:31:3 Error：steps 盖到了此前 walls#3 的格\n（出错时不合成，没有测量。）',
    );
    assert.equal(result.measures, undefined);
    assert.deepEqual(result.run, {
      kind: 'build-error',
      error: { name: 'Error', message: 'steps 盖到了此前 walls#3 的格', line: 31, column: 3 },
      console: 1,
      wallMs: 7,
    });
  });

  it('build-error 无位置信息时不写文件行', async () => {
    const run: RunResult = {
      kind: 'build-error',
      report: {
        status: 'build-error',
        error: { name: 'Error', message: 'boom', line: 0, column: 0 },
        hash: '',
        calls: 0,
        overlaps: [],
        console: [],
        consoleTruncated: 0,
      },
      wallMs: 2,
    };
    const { deps } = depsOf({ run: () => Promise.resolve(run) });
    const result = await checkCode({ code: 'x', version: 4, seed: 0 }, deps);
    assert.match(result.text, /^第 v4 版：执行出错 Error：boom\n/);
  });

  it('timeout / out-of-memory / output-too-large / crashed / too-large 各一行并给 RunSummary', async () => {
    const cases: readonly RunResult[] = [
      { kind: 'timeout', stderrHead: 'timed out', wallMs: 30_000 },
      { kind: 'out-of-memory', stderrHead: 'heap out of memory', wallMs: 1 },
      { kind: 'output-too-large', stderrHead: 'archive', wallMs: 2 },
      { kind: 'crashed', stderrHead: 'boom', wallMs: 3 },
      { kind: 'too-large', bytes: 300_000, limit: 262_144 },
    ];
    const expected = ['run-timeout', 'run-out-of-memory', 'run-output-too-large', 'run-crashed', 'run-too-large'];
    for (let i = 0; i < cases.length; i += 1) {
      const run = cases[i];
      if (run === undefined) continue;
      const { deps } = depsOf({ run: () => Promise.resolve(run) });
      const result = await checkCode({ code: 'x', version: 6, seed: 0 }, deps);
      assert.equal(result.status, expected[i]);
      assert.match(result.text, /^第 v6 版：/);
      assert.equal(result.run?.kind, run.kind);
    }
  });

  it('crashed 带报告超限 detail：写明无法返回、字节数/条数与可操作建议', async () => {
    const run: RunResult = {
      kind: 'crashed',
      stderrHead: '',
      wallMs: 4,
      detail: { reportBytes: 1_400_000, limitBytes: 1024 * 1024, calls: 5000, overlaps: 12 },
    };
    const { deps } = depsOf({ run: () => Promise.resolve(run) });
    const result = await checkCode({ code: 'x', version: 6, seed: 0 }, deps);
    assert.equal(result.status, 'run-crashed');
    assert.match(result.text, /本次执行结果无法返回：调用记录数据 1400000 字节，超过 1 MiB 上限/);
    assert.match(result.text, /报告里有 5000 次调用、12 处重叠/);
    assert.match(result.text, /减少逐格 set\/box 手写、改用构件/);
    assert.deepEqual(result.run, {
      kind: 'crashed',
      stderrHead: '',
      wallMs: 4,
      detail: { reportBytes: 1_400_000, limitBytes: 1024 * 1024, calls: 5000, overlaps: 12 },
    });
  });

  it('crashed 无 detail 时保留原"执行进程异常退出"文案', async () => {
    const run: RunResult = { kind: 'crashed', stderrHead: 'boom', wallMs: 3 };
    const { deps } = depsOf({ run: () => Promise.resolve(run) });
    const result = await checkCode({ code: 'x', version: 6, seed: 0 }, deps);
    assert.match(result.text, /^第 v6 版：执行进程异常退出/);
  });

  it('没有 bwrap（unsupported）→ sandbox-unsupported，run 摘要为 null', async () => {
    const run: RunResult = { kind: 'unsupported', reason: '无法执行 bwrap' };
    const { deps } = depsOf({ run: () => Promise.resolve(run) });
    const result = await checkCode({ code: 'x', version: 1, seed: 0 }, deps);
    assert.equal(result.status, 'sandbox-unsupported');
    assert.match(result.text, /本机没有可用的 bwrap，无法执行：无法执行 bwrap/);
    assert.equal(result.run, null);
  });

  it('执行抛出 SandboxError → internal-error，precheck 保留', async () => {
    const { deps } = depsOf({ run: () => Promise.reject(new SandboxError('protocol-error', 'child 报告不合 schema')) });
    const result = await checkCode({ code: 'x', version: 2, seed: 0 }, deps);
    assert.equal(result.status, 'internal-error');
    assert.deepEqual(result.precheck, { kind: 'ok' });
    assert.equal(result.run, null);
    assert.match(result.text, /第 v2 版：沙箱内部错误：child 报告不合 schema/);
  });

  it('非 SandboxError 的异常直接抛出（不可预期）', async () => {
    const { deps } = depsOf({ run: () => Promise.reject(new Error('bug')) });
    await assert.rejects(() => checkCode({ code: 'x', version: 1, seed: 0 }, deps), /bug/);
  });
});

/** 双坡屋面 + 自动山墙（山墙默认用外墙 spruce_planks，屋面板 dark_oak_planks）。 */
function builtGableRoof(): Built {
  const host = createWorld(registry.table);
  const w = host.world;
  const base = w.plinth({ footprint: rect(0, 0, 14, 8), height: 1, material: 'cobblestone' });
  const walls = w.walls({ on: base.top, height: 6, thickness: 1, material: 'spruce_planks' });
  w.roof({ on: walls.top, kind: 'gable', ridge: 'x', pitch: 1, overhang: 1, material: 'dark_oak_planks' });
  const { grid } = host.compose();
  return { archive: writeArchive(grid, API_VERSION), grid, hash: hashGrid(grid) };
}

/** 真叠两层屋面：显式平屋面 thickness 2，每列上下两层屋面板。 */
function builtThickRoof(): Built {
  const host = createWorld(registry.table);
  const w = host.world;
  w.roof({ footprint: rect(-3, -3, 3, 3), y: 5, kind: 'flat', thickness: 2, material: 'stone_bricks' });
  const { grid } = host.compose();
  return { archive: writeArchive(grid, API_VERSION), grid, hash: hashGrid(grid) };
}

/** 带框窗的墙 + 一处真夹层（两组 3×3 石板之间空一层）。 */
function builtFramedWindowWithSeam(): Built {
  const host = createWorld(registry.table);
  const w = host.world;
  const base = w.plinth({ footprint: rect(-6, -6, 6, 6), height: 1, material: 'stone_bricks' });
  const hall = w.walls({ on: base, height: 6, material: 'stone_bricks' });
  w.opening({
    in: hall.facade('south'),
    kind: 'window',
    width: 2,
    height: 2,
    sill: 2,
    fill: 'glass',
    frame: { width: 1, material: 'spruce_log' },
  });
  w.box([-5, 8, -5], [-3, 8, -3], 'stone_bricks');
  w.box([-5, 10, -5], [-3, 10, -3], 'stone_bricks');
  const { grid } = host.compose();
  return { archive: writeArchive(grid, API_VERSION), grid, hash: hashGrid(grid) };
}

describe('checkCode 测量误报修正（首批真实运行 2026-10-03）', () => {
  it('双坡屋面 + 自动山墙：山墙格不算屋面，超出连接 0', async () => {
    const build = builtGableRoof();
    const { deps } = depsOf({ run: () => Promise.resolve(okRun(build)) });
    const result = await checkCode({ code: 'x', version: 1, seed: 0 }, deps);
    assert.equal(result.status, 'ok');
    const measures = result.measures;
    assert.ok(measures !== undefined);
    const roofId = build.grid.calls().find((c) => c.api === 'roof')?.id;
    const roof = measures.roofs.find((r) => r.callId === roofId);
    assert.ok(roof !== undefined);
    // 山墙格排除后只剩屋面板：每列厚 1，没有超出连接。
    assert.equal(roof.profile.excess.columns, 0);
    assert.equal(roof.profile.excess.cells, 0);
    assert.deepEqual(roof.profile.thickness, { 1: roof.profile.cells, 2: 0, '3+': 0 });
    assert.match(result.text, /超出连接 0 列/);
  });

  it('真叠两层屋面：超出连接 > 0（排除规则没把叠层也去掉）', async () => {
    const build = builtThickRoof();
    const { deps } = depsOf({ run: () => Promise.resolve(okRun(build)) });
    const result = await checkCode({ code: 'x', version: 1, seed: 0 }, deps);
    assert.equal(result.status, 'ok');
    const measures = result.measures;
    assert.ok(measures !== undefined);
    const roofId = build.grid.calls().find((c) => c.api === 'roof')?.id;
    const roof = measures.roofs.find((r) => r.callId === roofId);
    assert.ok(roof !== undefined);
    assert.ok(roof.profile.excess.columns > 0);
    assert.ok(roof.profile.excess.cells > 0);
    assert.match(result.text, /超出连接 [1-9]\d* 列/);
  });

  it('带框窗的墙：洞框围出的空气不算夹层并在文本注明；真夹层仍报', async () => {
    const build = builtFramedWindowWithSeam();
    const { deps } = depsOf({ run: () => Promise.resolve(okRun(build)) });
    const result = await checkCode({ code: 'x', version: 1, seed: 0 }, deps);
    assert.equal(result.status, 'ok');
    const measures = result.measures;
    assert.ok(measures !== undefined);
    // 只有那处真夹层（3×3 石板之间一层空气，9 格）留下；窗框的 4 格被排除。
    assert.equal(measures.seams.cells, 9);
    assert.equal(measures.seamFrameAir.cells, 4);
    assert.equal(measures.seamFrameAir.groups, 1);
    assert.match(result.text, /夹层 9 格，1 组：/);
    assert.match(result.text, /另有 4 格是洞框围出的空气，未列出（1 组）。/);
  });
});

/** 地表留一格 y=0、无屋面：用来验证"y ≤ 0 格数"与"围合墙无屋面"两条事实。 */
function builtBareWalls(): Built {
  const host = createWorld(registry.table);
  const w = host.world;
  w.set(0, 0, 0, 'stone');
  w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 4, material: 'stone' });
  const { grid } = host.compose();
  return { archive: writeArchive(grid, API_VERSION), grid, hash: hashGrid(grid) };
}

describe('checkCode 新增事实（2026-10-04）', () => {
  it('存档有 y ≤ 0 格时写一行并按来源汇总；围合墙无屋面写一行', async () => {
    const build = builtBareWalls();
    const { deps } = depsOf({ run: () => Promise.resolve(okRun(build)) });
    const result = await checkCode({ code: 'x', version: 1, seed: 0 }, deps);
    assert.equal(result.status, 'ok');
    assert.match(result.text, /y ≤ 0 有 1 格（地表以下），来源 set#\d+。/);
    assert.match(result.text, /walls#\d+围合的 x∈\[-3, 3\]、z∈\[-3, 3\] 上方没有屋面，覆盖 0%。/);
    // 结构上仍可用：墙圈只算承托轮廓内缩一格，格子来自 walls 调用。
    assert.ok(result.measures?.wallCoverage.some((w) => w.covered === 0 && w.total === 49));
  });

  it('有完整屋面、没有 y ≤ 0 格时不写这两行', async () => {
    const build = built();
    const { deps } = depsOf({ run: () => Promise.resolve(okRun(build)) });
    const result = await checkCode({ code: 'x', version: 1, seed: 0 }, deps);
    assert.equal(result.status, 'ok');
    assert.ok(!result.text.includes('y ≤ 0'));
    assert.ok(!result.text.includes('上方没有屋面'), result.text);
  });
});

describe('checkCode 草模资产通道（M1c）', () => {
  function sampleDocument(): MassingDocument {
    const model = createModel();
    model.box({ id: 'room', name: '房间', role: 'volume', color: '#123456', size: [2, 2, 2] });
    return { id: 'hall', document: model.finish() };
  }

  it('登记了文档：runCode 收到 assets（文档 + 颜色候选），候选只取一次', async () => {
    const document = sampleDocument();
    const candidates = [{ id: 'stone_bricks', rgb: 0x7a7a7a, family: 'stone' }] as const;
    let calls = 0;
    const received: { value?: RunInput } = {};
    const { deps } = depsOf({
      run: (input) => {
        received.value = input;
        return Promise.resolve(okRun(built()));
      },
      candidates: () => {
        calls += 1;
        return candidates;
      },
    });
    const result = await checkCode({ code: 'x', version: 1, seed: 0, massingDocuments: [document] }, deps);
    assert.equal(result.status, 'ok');
    assert.equal(calls, 1);
    assert.deepEqual(received.value?.assets, { documents: [document], colorCandidates: candidates });
  });

  it('没有登记文档：runCode 输入不带 assets 字段（child 形状与协议 v1 一致）', async () => {
    const received: { value?: RunInput } = {};
    const { deps } = depsOf({
      run: (input) => {
        received.value = input;
        return Promise.resolve(okRun(built()));
      },
    });
    await checkCode({ code: 'x', version: 1, seed: 0, massingDocuments: [] }, deps);
    assert.ok(received.value !== undefined);
    assert.ok(!('assets' in received.value));
  });

  it('assets-too-large：中文一行、状态与 RunSummary 形状', async () => {
    const run: RunResult = { kind: 'assets-too-large', reason: 'documents-count', documents: 9, bytes: 123, limit: 8 };
    const { deps } = depsOf({ run: () => Promise.resolve(run) });
    const result = await checkCode({ code: 'x', version: 2, seed: 0 }, deps);
    assert.equal(result.status, 'run-assets-too-large');
    assert.equal(result.text, '第 v2 版：9 份草模文档，超过 8 份上限，没有执行。请减少登记或导入的草模文档后重试。');
    assert.deepEqual(result.run, {
      kind: 'assets-too-large',
      reason: 'documents-count',
      documents: 9,
      bytes: 123,
      limit: 8,
    });
  });

  it('assets-too-large（单份字节）走 MiB 单位文案', async () => {
    const run: RunResult = {
      kind: 'assets-too-large',
      reason: 'document-bytes',
      documents: 1,
      bytes: 17 * 1024 * 1024,
      limit: 16 * 1024 * 1024,
    };
    const { deps } = depsOf({ run: () => Promise.resolve(run) });
    const result = await checkCode({ code: 'x', version: 3, seed: 0 }, deps);
    assert.equal(result.status, 'run-assets-too-large');
    assert.equal(
      result.text,
      '第 v3 版：单份草模文档 17 MiB，超过 16 MiB 上限，没有执行。请减少登记或导入的草模文档后重试。',
    );
  });
});
