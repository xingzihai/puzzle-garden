import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FloatingReport } from '@pg/analysis/floating';
import type { ReachReport } from '@pg/analysis/reach';
import type { ReachTargets } from '@pg/analysis/reach-targets';
import type { RoofProfile } from '@pg/analysis/roof-profile';
import { loadRegistry } from '@pg/blocks/load';
import type { CallDef } from '@pg/core/grid';
import { measureFloating } from '@pg/analysis/floating';
import { measureReach } from '@pg/analysis/reach';
import { reachTargetsByCall } from '@pg/analysis/reach-targets';
import { measureRoofProfile } from '@pg/analysis/roof-profile';
import { measureSeams } from '@pg/analysis/seams';
import { measureSymmetry } from '@pg/analysis/symmetry';
import { createWorld, rect } from '@pg/geometry';
import type { OverlapSummary } from '@pg/sandbox/run';

import {
  DEGENERATE_KEEP_CHARS,
  DEGENERATE_NOTICE,
  DEGENERATE_SUFFIX,
  FACTS_FORMAT_VERSION,
  FACTS_MAX_CHARS,
  MEASURES_MAX_CHARS,
  OVERLAPS_MAX_CHARS,
  NO_TOOL_NOTICE,
  degenerateContent,
  formatFacts,
  formatMeasures,
  formatOverlaps,
  usedLine,
  windowNotice,
} from './facts.ts';
import type { FactsInput, MeasureInput } from './facts.ts';
import { applyPlanAction, initialPlanState, planDigest } from './tools/plan.ts';

const call = (id: number, api: string): CallDef => ({ id, api, line: id, args: '{}' });
const b = (min: [number, number, number], max: [number, number, number]) => ({ min, max }) as const;
const sample = (x: number, y: number, z: number, block: string, c: number) => ({ x, y, z, block, call: c });

const noFloating: FloatingReport = { cells: 0, edgeOnly: 0, groups: [] };
const profile = (cells: number, t1: number, excess = 0): RoofProfile => ({
  cells,
  layers: [],
  thickness: { 1: t1, 2: 0, '3+': 0 },
  thickSamples: [],
  excess: { columns: excess, cells: excess },
  excessSamples: [],
});

/** §4.2 示例的形状：3 块楼板 + 平顶屋面，第 3 块到不了，差一步是楼板挡头。 */
function example(): MeasureInput {
  const calls = [
    call(1, 'walls'),
    call(12, 'floorPlate'),
    call(14, 'floorPlate'),
    call(15, 'stair'),
    call(16, 'floorPlate'),
    call(20, 'roof'),
  ];
  const reachTargets: ReachTargets = {
    targets: [
      { callId: 12, api: 'floorPlate', cell: { x: -6, y: 10, z: -6 } },
      { callId: 14, api: 'floorPlate', cell: { x: -6, y: 19, z: -6 } },
      { callId: 16, api: 'floorPlate', cell: { x: -6, y: 28, z: -6 } },
      { callId: 20, api: 'roof', cell: { x: -6, y: 41, z: -6 } },
    ],
    missing: [],
    skipped: [],
  };
  const reach: ReachReport = {
    standable: 412,
    reached: 388,
    maxReachedY: 41,
    maxStandableY: 41,
    targets: reachTargets.targets.map((t) => ({ cell: t.cell, reached: t.callId !== 16 })),
    blockers: [
      {
        from: { x: 2, y: 28, z: -1 },
        to: { x: 2, y: 29, z: -1 },
        reason: 'no-headroom',
        block: sample(2, 30, -1, 'spruce_planks', 16),
      },
      { from: { x: 0, y: 1, z: 0 }, to: { x: 1, y: 3, z: 0 }, reason: 'too-high' },
      { from: { x: 0, y: 5, z: 0 }, to: { x: 1, y: 1, z: 0 }, reason: 'too-far-down' },
    ],
  };
  return {
    calls,
    floating: noFloating,
    seams: { cells: 12, groups: [{ cells: 12, layers: 1, bounds: b([-3, 9, -3], [3, 9, 3]), samples: [] }] },
    seamFrameAir: { cells: 0, groups: 0 },
    reachTargets,
    reach,
    roofs: [{ callId: 20, profile: profile(214, 180) }],
    belowGround: { cells: 0, sources: [] },
    symmetry: { axes: [] },
    wallCoverage: [],
  };
}

describe('formatMeasures', () => {
  it('§4.2 示例形状：逐项一行，目标带来源与坐标，差一步带方块名与来源调用', () => {
    assert.equal(
      formatMeasures(example()),
      [
        '测量（事实，不判合格）：',
        '悬空 0 格。',
        '夹层 12 格，1 组：',
        '  12 格 (-3,9,-3)–(3,9,3)，一层空气',
        '可达：站立点 412，能到 388；能到的最高站立高度 41，最高站立点 41。',
        '  目标：floorPlate#12 (-6,10,-6) 能到；floorPlate#14 (-6,19,-6) 能到；floorPlate#16 (-6,28,-6) 到不了；roof#20（平顶） (-6,41,-6) 能到',
        '  差一步（前 3 处）：(2,28,-1)→(2,29,-1) 头顶被挡：spruce_planks (2,30,-1)（floorPlate#16）；(0,1,0)→(1,3,0) 高差 2 格以上；(0,5,0)→(1,1,0) 落差超过 3 格',
        '屋面：roof#20 共 214 格，列厚 1/2/3+ = 180/0/0，超出连接 0 列。',
        '用了：floorPlate 3、roof 1、stair 1、walls 1。',
      ].join('\n'),
    );
  });

  it('悬空组：只靠棱角、整组屋面格、来源去重；超过 3 组写"另 N 组"', () => {
    const groups = [5, 4, 3, 2].map((n, i) => ({
      cells: n,
      edgeOnly: i === 0,
      tagged: i === 1 ? n : 0,
      bounds: b([i, 2, 0], [i, 3, 0]),
      samples: [sample(i, 2, 0, 'stone', 1), sample(i, 3, 0, 'stone', 1), sample(i, 3, 1, 'stone', 99)],
    }));
    const text = formatMeasures({ ...example(), floating: { cells: 14, edgeOnly: 5, groups } });
    assert.ok(text.includes('悬空 14 格（其中只靠棱角相连 5 格），4 组：'));
    assert.ok(text.includes('  5 格 (0,2,0)–(0,3,0)，只靠棱角相连，来源 walls#1'));
    assert.ok(text.includes('  4 格 (1,2,0)–(1,3,0)，整组是屋面格，来源 walls#1'));
    assert.ok(text.includes('  …另 1 组'));
  });

  it('目标：推不出的调用按原因写出、与目标按调用编号交错；没有候选时写明', () => {
    const base = example();
    const missing: ReachTargets['missing'] = [
      { callId: 13, api: 'floorPlate', reason: 'no-standable' },
      { callId: 21, api: 'roof', reason: 'no-cells' },
      { callId: 22, api: 'roof', reason: 'args-truncated' },
      { callId: 23, api: 'roof', reason: 'args-invalid' },
    ];
    const text = formatMeasures({ ...base, reachTargets: { ...base.reachTargets, missing } });
    assert.ok(text.includes('floorPlate#12 (-6,10,-6) 能到；floorPlate#13上方没有站立点，没有目标；floorPlate#14'));
    assert.ok(text.includes('roof#21（平顶）的格已全部被覆盖或挖空，没有目标'));
    assert.ok(text.includes('roof#22参数过长被截断，未判断是否平顶'));
    assert.ok(text.includes('roof#23参数无法读取，未判断是否平顶'));

    const none = formatMeasures({
      ...base,
      reachTargets: { targets: [], missing: [], skipped: [] },
      reach: { ...base.reach, targets: [], blockers: [] },
    });
    assert.ok(none.includes('  目标：没有 floorPlate 或平顶 roof 调用'));
    assert.ok(!none.includes('差一步'));
  });

  it('平顶无女儿墙单列一行"不作目标"，不写成"到不了"；夹层行后注明被排除的洞框空气', () => {
    const base = example();
    const text = formatMeasures({
      ...base,
      reachTargets: {
        ...base.reachTargets,
        skipped: [{ callId: 24, api: 'roof', reason: 'flat-no-parapet' }],
      },
      seamFrameAir: { cells: 4, groups: 1 },
    });
    assert.ok(text.includes('  平顶，无女儿墙，不作目标：roof#24'));
    assert.ok(text.includes('另有 4 格是洞框围出的空气，未列出（1 组）。'));
    assert.ok(!/roof#24[^\n]*到不了/.test(text));

    // 只有无女儿墙平顶、没有其它目标时，不写"没有 floorPlate 或平顶 roof 调用"。
    const onlySkipped = formatMeasures({
      ...base,
      reachTargets: { targets: [], missing: [], skipped: [{ callId: 24, api: 'roof', reason: 'flat-no-parapet' }] },
      reach: { ...base.reach, targets: [], blockers: [] },
    });
    assert.ok(!onlySkipped.includes('没有 floorPlate 或平顶 roof 调用'));
    assert.ok(onlySkipped.includes('平顶，无女儿墙，不作目标：roof#24'));
  });

  it('目标超过 12 个写"另 N 个"；屋面超过 6 个写"另 N 个屋面"；没有可达站立点写"无"', () => {
    const targets = Array.from({ length: 14 }, (_, i) => ({
      callId: i + 1,
      api: 'floorPlate' as const,
      cell: { x: 0, y: i + 2, z: 0 },
    }));
    const text = formatMeasures({
      ...example(),
      reachTargets: { targets, missing: [], skipped: [] },
      reach: {
        standable: 0,
        reached: 0,
        maxReachedY: undefined,
        maxStandableY: undefined,
        targets: targets.map((t) => ({ cell: t.cell, reached: false })),
        blockers: [{ from: { x: 0, y: 1, z: 0 }, to: { x: 1, y: 2, z: 0 }, reason: 'no-headroom' }],
      },
      roofs: Array.from({ length: 8 }, (_, i) => ({ callId: 30 + i, profile: profile(10, 10, 1) })),
    });
    assert.ok(text.includes('；…另 2 个'));
    assert.ok(text.includes('  …另 2 个屋面'));
    assert.ok(text.includes('能到的最高站立高度 无，最高站立点 无。'));
    assert.ok(text.includes('(0,1,0)→(1,2,0) 头顶被挡；') || text.includes('(0,1,0)→(1,2,0) 头顶被挡\n'));
    assert.ok(!text.includes('roof#36'));
  });

  it('y ≤ 0 格与围合墙无屋面各写一行；覆盖 ≥ 50%、无地下格不写', () => {
    const base = example();
    const text = formatMeasures({
      ...base,
      belowGround: { cells: 3, sources: ['set#30', 'box#31'] },
      wallCoverage: [
        { callId: 1, line: 12, minX: -4, maxX: 4, minZ: -4, maxZ: 4, covered: 0, total: 81 },
        { callId: 2, line: 0, minX: 0, maxX: 4, minZ: 0, maxZ: 4, covered: 25, total: 25 },
      ],
    });
    assert.ok(text.includes('y ≤ 0 有 3 格（地表以下），来源 set#30、box#31。'));
    assert.ok(text.includes('walls#1（第 12 行）围合的 x∈[-4, 4]、z∈[-4, 4] 上方没有屋面，覆盖 0%。'));
    assert.ok(!text.includes('walls#2'));
    assert.ok(!formatMeasures(base).includes('y ≤ 0'));
    assert.ok(!formatMeasures(base).includes('上方没有屋面'));
  });

  it('reach 与 reachTargets 不同序（数目不同）时报错，不静默错配', () => {
    const base = example();
    assert.throws(() => formatMeasures({ ...base, reach: { ...base.reach, targets: [] } }), /同序/);
  });

  it('超长：依次减差一步、悬空组、夹层组，再按行截断并注明', () => {
    const long = 'x'.repeat(600);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        cells: 1,
        edgeOnly: false,
        tagged: 0,
        bounds: b([i, 5, 0], [i, 5, 0]),
        samples: [sample(i, 5, 0, long, 0)],
      }));
    const base = example();
    const blockers = Array.from({ length: 5 }, (_, i) => ({
      from: { x: i, y: 1, z: 0 },
      to: { x: i, y: 2, z: 0 },
      reason: 'no-headroom' as const,
      block: sample(i, 3, 0, long, 0),
    }));
    // 只靠差一步就超长：减到 1 条后放得下
    const one = formatMeasures({ ...base, reach: { ...base.reach, blockers } });
    assert.ok(one.length <= MEASURES_MAX_CHARS);
    assert.ok(one.includes('差一步（前 1 处）'));
    assert.ok(!one.includes('已截断'));

    // 无论如何放不下：按行截断
    const calls = Array.from({ length: 400 }, (_, i) => call(i + 100, `api_${String(i)}_${'y'.repeat(10)}`));
    const cut = formatMeasures({ ...base, calls, floating: { cells: 4, edgeOnly: 0, groups: many(4) } });
    assert.ok(cut.length <= MEASURES_MAX_CHARS, String(cut.length));
    assert.match(cut, /（已截断，共 \d+ 项）$/);
    assert.ok(cut.includes('悬空 4 格'));
    assert.ok(cut.includes('  …另 3 组'), '悬空组应已减到 1 组');
  });

  it('首行就放不下时截取首行头部，结果仍 ≤ 上限', () => {
    const calls = Array.from({ length: 2000 }, (_, i) => call(i + 1, `a${String(i)}`));
    const base = example();
    const text = formatMeasures({ ...base, calls });
    assert.ok(text.length <= MEASURES_MAX_CHARS);
    assert.match(text, /（已截断/);
  });

  it('真实构件（两层楼板 + 带女儿墙的平顶 + 直跑梯）：确定、≤ 上限、目标全部能到', () => {
    const registry = loadRegistry();
    const host = createWorld(registry.table);
    const w = host.world;
    const base = w.plinth({ footprint: rect(-6, -6, 6, 6), height: 1, material: 'stone_bricks' });
    const hall = w.walls({ on: base, height: 6, material: 'stone_bricks' });
    // 楼板铺在墙内底面，门内地面抬高一格，门洞要 3 格高才不挡头
    w.opening({ in: hall.facade('south'), kind: 'door', width: 1, height: 3 });
    const floor = w.floorPlate({ in: hall.inner, material: 'oak_planks' });
    const roof = w.roof({ on: hall, kind: 'flat', material: 'stone', parapet: { height: 1, material: 'stone' } });
    if (roof.top === undefined) throw new Error('平屋面应返回 top');
    w.stair({ from: floor.top, to: roof.top, kind: 'straight', at: [-3, 3], facing: 'north', material: 'oak_stairs' });
    const { grid } = host.compose();
    const calls = grid.calls();
    const roofIds = new Set(calls.filter((c) => c.api === 'roof').map((c) => c.id));
    const reachTargets = reachTargetsByCall(grid, registry);
    const input: MeasureInput = {
      calls,
      floating: measureFloating(grid, { tag: (c) => roofIds.has(c.call) }),
      seams: measureSeams(grid),
      seamFrameAir: { cells: 0, groups: 0 },
      reachTargets,
      reach: measureReach(grid, registry, { targets: reachTargets.targets.map((t) => t.cell) }),
      roofs: [...roofIds].map((id) => ({ callId: id, profile: measureRoofProfile(grid, (c) => c.call === id) })),
      belowGround: { cells: 0, sources: [] },
      symmetry: measureSymmetry(grid, { glass: (c) => c.state.name.includes('glass') }),
      wallCoverage: [],
    };
    const text = formatMeasures(input);
    assert.equal(formatMeasures(input), text);
    assert.ok(text.length <= MEASURES_MAX_CHARS);
    assert.equal(reachTargets.targets.length, 2);
    assert.match(text, /floorPlate#\d+ \([-\d,]+\) 能到；roof#\d+（平顶） \([-\d,]+\) 能到/);
    assert.ok(!/通过|不合格|应当|必须修/.test(text));
  });
});

describe('formatMeasures 左右对称', () => {
  const axis = (
    over: Partial<MeasureInput['symmetry']['axes'][number]> = {},
  ): MeasureInput['symmetry']['axes'][number] => ({
    axis: 'x',
    at: 0,
    cells: 10,
    matched: 9,
    glass: 4,
    glassMatched: 3,
    glassBelow: 1,
    glassAbove: 3,
    lonely: [
      {
        cells: 2,
        bounds: b([-3, 5, 0], [-3, 6, 0]),
        samples: [sample(-3, 5, 0, 'stone', 1), sample(-3, 6, 0, 'stone', 1)],
      },
    ],
    lonelyGlass: [{ cells: 1, bounds: b([-2, 7, 0], [-2, 7, 0]), samples: [sample(-2, 7, 0, 'glass', 1)] }],
    ...over,
  });

  it('有轴有孤组：一行比例，玻璃组在实体组前，来源去重', () => {
    const text = formatMeasures({ ...example(), symmetry: { axes: [axis()] } });
    assert.ok(
      text.includes('左右对称：镜面 x = 0，实体对上 90.0%，玻璃对上 75.0%（x < 0 一侧 1 格、x > 0 一侧 3 格）。'),
    );
    const glassAt = text.indexOf('  只在一侧的玻璃 1 组：');
    const solidAt = text.indexOf('  只在一侧的实体 1 组：');
    assert.ok(glassAt >= 0 && solidAt > glassAt);
    assert.ok(text.includes('    1 格 (-2,7,0)–(-2,7,0)，来源 walls#1'));
    assert.ok(text.includes('    2 格 (-3,5,0)–(-3,6,0)，来源 walls#1'));
  });

  it('轴名与 at 随轴；无玻璃时写"无玻璃"且不列玻璃组', () => {
    const text = formatMeasures({
      ...example(),
      symmetry: {
        axes: [axis({ axis: 'z', at: 1.5, glass: 0, glassMatched: 0, glassBelow: 0, glassAbove: 0, lonelyGlass: [] })],
      },
    });
    assert.ok(text.includes('左右对称：镜面 z = 1.5，实体对上 90.0%，无玻璃。'));
    assert.ok(!text.includes('只在一侧的玻璃'));
  });

  it('axes 为空时不写任何对称行', () => {
    assert.ok(!formatMeasures(example()).includes('左右对称'));
  });

  it('超长降级时对称组与悬空组一起降到 1 组', () => {
    // 两个长 API 名让对称组行变长：cap 2 放不下、cap 1 放得下；第一个放得下的步骤里 symmetryGroups = 1。
    const longA = `a${'名'.repeat(420)}`;
    const longB = `b${'名'.repeat(420)}`;
    const groups = [0, 1, 2].map((i) => ({
      cells: 1,
      bounds: b([i, 5, 0], [i, 5, 0]),
      samples: [sample(i, 5, 0, 'stone', 90), sample(i, 5, 0, 'stone', 91)],
    }));
    const text = formatMeasures({
      ...example(),
      calls: [...example().calls, call(90, longA), call(91, longB)],
      reach: { ...example().reach, blockers: [] },
      symmetry: { axes: [axis({ lonely: groups, lonelyGlass: [] })] },
    });
    assert.ok(text.length <= MEASURES_MAX_CHARS, String(text.length));
    assert.ok(!text.includes('已截断'));
    assert.ok(text.includes('    …另 2 组') && text.includes('只在一侧的实体 3 组：'));
    // 只列一组：第 0 组，不出现第 1、2 组。
    assert.ok(text.includes('  1 格 (0,5,0)–(0,5,0)'));
    assert.ok(!text.includes('  1 格 (1,5,0)–(1,5,0)'));
    assert.ok(!text.includes('  1 格 (2,5,0)–(2,5,0)'));
  });
});

describe('usedLine / formatOverlaps', () => {
  it('按次数降序、同数按名字升序；空表写明', () => {
    assert.equal(
      usedLine([call(1, 'set'), call(2, 'box'), call(3, 'set'), call(4, 'opening'), call(5, 'box')]),
      '用了：box 2、set 2、opening 1。',
    );
    assert.equal(usedLine([]), '用了：没有调用。');
  });

  it('覆盖计数', () => {
    assert.equal(
      formatOverlaps(
        [
          { kind: 'same-layer', winner: 2, loser: 1 },
          { kind: 'cross-layer', winner: 3, loser: 1 },
          { kind: 'cross-layer', winner: 3, loser: 2 },
        ],
        [],
      ),
      '覆盖：同层替代 1 处 / 跨层覆盖 2 处。',
    );
  });
});

describe('formatOverlaps 手写装饰被盖（规格 §3）', () => {
  const group = (over: Partial<OverlapSummary['groups'][number]> = {}): OverlapSummary['groups'][number] => ({
    winner: 5,
    loser: 12,
    cells: 36,
    sample: [2, 25, 3],
    sampleDetail: {
      expectedState: 'quartz_slab[type=top]',
      actualState: 'deepslate_tile_slab',
      winnerSource: { api: 'roof', line: 50, writeLayer: 'structure' },
      loserSource: { api: 'set', line: 120, writeLayer: 'decoration' },
    },
    ...over,
  });
  const summary = (over: Partial<OverlapSummary> = {}): OverlapSummary => ({
    sameLayer: 2,
    crossLayer: 691,
    lostDecor: 750,
    groups: [group()],
    groupsOmitted: 4,
    ...over,
  });

  it('零概览不凭空报装饰损失，保留两参数旧调用', () => {
    assert.equal(formatOverlaps([], []), '覆盖：同层替代 0 处 / 跨层覆盖 0 处。');
    assert.equal(
      formatOverlaps([], [], {
        summary: summary({ sameLayer: 0, crossLayer: 0, lostDecor: 0, groups: [], groupsOmitted: 0 }),
      }),
      '覆盖：同层替代 0 处 / 跨层覆盖 0 处。',
    );
  });

  it('概览在明细截断后仍给完整总数与原样同格状态/来源，完全丢失的调用无需存档查询', () => {
    const text = formatOverlaps(
      [{ kind: 'same-layer', winner: 99, loser: 98 }],
      [call(5, '错误的API'), call(12, '错误的败方')],
      { summary: summary(), overlapsTruncated: 692 },
    );
    assert.equal(
      text,
      [
        '覆盖：同层替代 2 处 / 跨层覆盖 691 处。',
        '覆盖明细省略 692 项；上述计数来自完整概览。',
        '手写装饰被盖掉 750 格（跨层写入损失，包含同状态重复写入）：',
        '  36 格，例 (2,25,3)：代码请求状态 quartz_slab[type=top] → 最终状态 deepslate_tile_slab（覆盖）；败方 set#12（第 120 行，装饰层）；胜方 roof#5（第 50 行，结构层）',
        '  样例最多 3 组，已列 1 组；另 4 组未展开（文本上限 2000 字符）。',
        '以上仅涉及跨层手写装饰，不代表画面可见性或同层全面诊断；请核对坐标、状态和写入层是否符合设计。',
      ].join('\n'),
    );
    assert.doesNotMatch(text, /要露出来|先开洞|错误的API/);
  });

  it('air 才叫挖掉；opening 写 glass 叫覆盖；相同状态明确最终相同', () => {
    const g = group();
    for (const [actualState, effect] of [
      ['air', '挖掉'],
      ['glass', '覆盖'],
      ['quartz_slab[type=top]', '最终状态相同'],
    ] as const) {
      const s = summary({
        groups: [
          group({
            sampleDetail: {
              ...g.sampleDetail,
              actualState,
              winnerSource: { api: 'opening', line: 0, writeLayer: 'opening' },
            },
          }),
        ],
      });
      const text = formatOverlaps([], [], { summary: s });
      assert.ok(text.includes(`→ 最终状态 ${actualState}（${effect}）`));
      assert.ok(text.includes('opening#5（行号未知，开洞层）'));
      if (actualState !== 'air') assert.doesNotMatch(text, /挖掉/);
    }
  });

  it('前三来源组按概览顺序，样例与双方来源整体保持，省略组数不当成格数', () => {
    const groups = [
      group(),
      group({
        winner: 6,
        loser: 13,
        cells: 20,
        sample: [-8, 10, 2],
        sampleDetail: {
          expectedState: 'gold_block',
          actualState: 'glass',
          winnerSource: { api: 'box', line: 61, writeLayer: 'opening' },
          loserSource: { api: 'box', line: 130, writeLayer: 'decoration' },
        },
      }),
      group({ winner: 7, loser: 14, cells: 10, sample: [0, 2, 0] }),
    ];
    const text = formatOverlaps([], [], { summary: summary({ groups, groupsOmitted: 12 }) });
    const rows = text.split('\n').filter((line) => line.includes(' 格，例 '));
    assert.equal(rows.length, 3);
    assert.ok(
      rows[1]?.includes(
        '20 格，例 (-8,10,2)：代码请求状态 gold_block → 最终状态 glass（覆盖）；败方 box#13（第 130 行，装饰层）；胜方 box#6（第 61 行，开洞层）',
      ),
    );
    assert.match(text, /750 格/);
    assert.match(text, /另 12 组未展开/);
  });

  it('旧报告截断只报保留项分类和损失下界；未知不加到跨层，不由 API/args 猜状态', () => {
    const text = formatOverlaps(
      [
        { kind: 'same-layer', winner: 5, loser: 4 },
        { kind: 'cross-layer', winner: 5, loser: 12, lostDecor: 36, sample: [2, 25, 3] },
        { kind: 'cross-layer', winner: 5, loser: 13, lostDecor: 10, sample: [1, 4, 0] },
      ],
      [call(5, 'opening'), { ...call(12, 'set'), line: 0, args: '{"material":"air"}' }],
      { overlapsTruncated: 999 },
    );
    assert.match(text, /^覆盖：保留项同层替代 1 处 \/ 跨层覆盖 2 处。/);
    assert.match(text, /省略 999 项，同层\/跨层分类未知/);
    assert.match(text, /46 格（仅保留项，完整总数未知）/);
    assert.match(text, /例 \(2,25,3\)：败方 set#12（行号未知，写入层未知）；胜方 opening#5/);
    assert.match(text, /例 \(1,4,0\)：败方 #13（API\/行号未知，写入层未知）/);
    assert.match(text, /代码请求\/最终状态未知/);
    assert.doesNotMatch(text, /挖掉|最终状态 air/);
    const empty = formatOverlaps([], [], { overlapsTruncated: 2 });
    assert.match(empty, /省略 2 项，同层\/跨层分类未知/);
    assert.doesNotMatch(empty, /手写装饰被盖掉 0/);
  });

  it('旧条目的 detail 可选、丢失 sample 仍计格数；同层条目不混进装饰损失', () => {
    const g = group();
    const text = formatOverlaps(
      [
        { kind: 'cross-layer', winner: 5, loser: 12, lostDecor: 36, sample: g.sample, sampleDetail: g.sampleDetail },
        { kind: 'cross-layer', winner: 6, loser: 13, lostDecor: 10 },
        { kind: 'same-layer', winner: 7, loser: 14, lostDecor: 99, sample: [0, 0, 0] },
      ],
      [],
    );
    assert.match(text, /手写装饰被盖掉 46 格/);
    assert.match(text, /quartz_slab\[type=top\] → 最终状态 deepslate_tile_slab/);
    assert.match(text, /另 1 组未展开/);
  });

  it('旧报告最多三条、按损失降序/调用编号稳定排序；不把最小坐标和其它败方行号拼接', () => {
    const overlaps = [2, 30, 10, 30, 4].map((n, i) => ({
      kind: 'cross-layer' as const,
      winner: 20 + i,
      loser: 50 + i,
      lostDecor: n,
      sample: [i, 1, 0] as const,
    }));
    const text = formatOverlaps(
      overlaps,
      overlaps.map((o) => call(o.loser, 'set')),
    );
    const rows = text.split('\n').filter((line) => line.includes(' 格，例 '));
    assert.equal(rows.length, 3);
    assert.match(rows[0] ?? '', /30 格，例 \(1,1,0\)：败方 set#51（第 51 行/);
    assert.match(rows[1] ?? '', /30 格，例 \(3,1,0\)：败方 set#53（第 53 行/);
    assert.match(rows[2] ?? '', /10 格，例 \(2,1,0\)：败方 set#52（第 52 行/);
    assert.match(text, /另 2 组未展开/);
  });

  it('超长整组省略而不截断样例，保留总数、限制与未展开数', () => {
    const g = group();
    const huge = group({ sampleDetail: { ...g.sampleDetail, expectedState: '😀'.repeat(2000) } });
    const text = formatOverlaps([], [], { summary: summary({ groups: [huge], groupsOmitted: 4 }) });
    assert.ok(text.length <= OVERLAPS_MAX_CHARS);
    assert.match(text, /750 格/);
    assert.match(text, /已列 0 组；另 5 组未展开/);
    assert.doesNotMatch(text, /例 \(|😀/);
    assert.match(text, /不代表画面可见性或同层全面诊断/);
  });
});

const facts: FactsInput = {
  nextTurn: 12,
  maxTurns: 60,
  spentCny: 0.41,
  maxCostCny: 3.5,
  elapsedMs: 6 * 60_000 + 59_999,
  wallMs: 2_400_000,
  draftVersion: 9,
  lastCheck: { version: 9, outcome: 'ok', hash: '3f9a12ab' },
  lastViewVersion: 6,
  window: null,
};

describe('formatFacts', () => {
  it('§6.1 示例', () => {
    assert.equal(
      formatFacts(facts),
      '[第 12 轮 / 共 60 轮｜已花 ¥0.41 / 上限 ¥3.50｜墙钟 6 分 / 40 分]\n' +
        '当前稿第 v9 版；最近检查第 v9 版：执行成功（hash 3f9a…）。最近看图：第 v6 版。',
    );
  });

  it('还没有代码、检查、看图；各种检查结果', () => {
    const first = formatFacts({ ...facts, draftVersion: null, lastCheck: null, lastViewVersion: null });
    assert.ok(first.endsWith('当前稿：还没有代码；还没有检查。还没有看图。'));
    const outcome = (o: 'precheck-failed' | 'build-error' | 'not-finished' | 'ok') =>
      formatFacts({ ...facts, lastCheck: { version: 8, outcome: o } });
    assert.ok(outcome('precheck-failed').includes('最近检查第 v8 版：类型预检未通过'));
    assert.ok(outcome('build-error').includes('最近检查第 v8 版：执行出错'));
    assert.ok(outcome('not-finished').includes('最近检查第 v8 版：执行未完成'));
    assert.ok(outcome('ok').includes('最近检查第 v8 版：执行成功。'));
  });

  it('提交窗口（C15）：进入时列出可用工具，之后写剩余轮数', () => {
    const enter = formatFacts({ ...facts, window: { remaining: 3, entering: true } });
    assert.ok(enter.endsWith('\n进入提交窗口：剩余 3 轮，只能使用 read_code、edit_code、check_code、submit。'));
    const later = formatFacts({ ...facts, window: { remaining: 2, entering: false } });
    assert.ok(later.endsWith('\n提交窗口：剩余 2 轮。'));
    assert.equal(windowNotice({ remaining: 1, entering: false }), '提交窗口：剩余 1 轮。');
  });

  it('窗口先于首稿：v0 的事实行明示 write_code 是唯一出路', () => {
    const enter = formatFacts({
      ...facts,
      draftVersion: null,
      lastCheck: null,
      lastViewVersion: null,
      window: { remaining: null, entering: true },
    });
    assert.ok(
      enter.endsWith(
        '\n进入提交窗口：当前还没有代码，先 write_code 建立初稿；之后只能使用 read_code、edit_code、check_code、submit。',
      ),
    );
    const later = formatFacts({ ...facts, draftVersion: null, window: { remaining: 2, entering: false } });
    assert.ok(
      later.endsWith(
        '\n提交窗口：剩余 2 轮。当前还没有代码，先 write_code 建立初稿；之后只能使用 read_code、edit_code、check_code、submit。',
      ),
    );
    // 空串 / 空白稿即使已有版本号，也按“还没有可用代码”给窗口例外句。
    const emptyV1 = formatFacts({
      ...facts,
      draftVersion: 1,
      hasDraftCode: false,
      window: { remaining: 2, entering: false },
    });
    assert.match(emptyV1, /当前还没有代码，先 write_code 建立初稿/);
    // 已有非空草稿时保持原窗口文案，不出现例外句。
    assert.ok(!formatFacts({ ...facts, window: { remaining: 2, entering: false } }).includes('先 write_code 建立初稿'));
  });

  it('轮数不限（决策 #87）：状态行不写"共 M 轮"；窗口文案写费用或墙钟', () => {
    const free = formatFacts({ ...facts, maxTurns: null });
    assert.ok(free.startsWith('[第 12 轮｜已花 ¥0.41 / 上限 ¥3.50｜墙钟 6 分 / 40 分]'));
    assert.ok(!free.includes('共 60 轮'));

    const enter = formatFacts({ ...facts, maxTurns: null, window: { remaining: null, entering: true } });
    assert.ok(enter.endsWith('\n进入提交窗口：只能使用 read_code、edit_code、check_code、submit。'));
    const later = formatFacts({ ...facts, maxTurns: null, window: { remaining: null, entering: false } });
    assert.ok(later.endsWith('\n提交窗口：费用或墙钟即将用完。'));
    assert.equal(windowNotice({ remaining: null, entering: false }), '提交窗口：费用或墙钟即将用完。');
  });

  it('没有工具调用、退化取消（C11）：提醒写在第一行', () => {
    assert.ok(formatFacts({ ...facts, event: 'no-tool' }).startsWith(`${NO_TOOL_NOTICE}\n[第 12 轮`));
    assert.ok(formatFacts({ ...facts, event: 'degenerate' }).startsWith(`${DEGENERATE_NOTICE}\n[第 12 轮`));
    assert.equal(DEGENERATE_NOTICE, '上一轮输出出现大段重复，已被中止。请直接调用工具，不要重复输出。');
  });

  it('护栏警告另起一行；超过 400 字符时从后往前去掉并注明', () => {
    assert.ok(formatFacts({ ...facts, warnings: ['同一调用已连续 3 次'] }).endsWith('\n同一调用已连续 3 次'));
    const w = Array.from({ length: 6 }, (_, i) => `提醒${String(i)}：${'很'.repeat(60)}`);
    const text = formatFacts({ ...facts, window: { remaining: 3, entering: true }, event: 'no-tool', warnings: w });
    assert.ok(text.length <= FACTS_MAX_CHARS, String(text.length));
    assert.match(text, /（另有 \d 条提醒未显示）$/);
    assert.ok(text.includes('进入提交窗口'));
  });

  it('计划摘要（Phase 3E）：有 plan 时追加一行 digest；无 plan 时输出逐字节不变', () => {
    const noPlan = formatFacts(facts);
    assert.equal(
      noPlan,
      '[第 12 轮 / 共 60 轮｜已花 ¥0.41 / 上限 ¥3.50｜墙钟 6 分 / 40 分]\n' +
        '当前稿第 v9 版；最近检查第 v9 版：执行成功（hash 3f9a…）。最近看图：第 v6 版。',
    );
    const plan = applyPlanAction(initialPlanState(), {
      action: 'update',
      phase: 'roof',
      items: [
        { id: 'must-roof', status: 'verified', evidence: 'eave 5 / ridge 7' },
        { id: 'must-wall', status: 'doing' },
      ],
    }).state;
    const withPlan = formatFacts({ ...facts, plan });
    assert.equal(withPlan, `${noPlan}\n${planDigest(plan)}`);
    assert.match(withPlan, /plan roof 1\/2; musts 1 verified\/0 failed; conflicts 0/);
  });

  it('计划摘要与警告同时出现时仍 ≤ FACTS_MAX_CHARS，摘要优先保留', () => {
    const plan = applyPlanAction(initialPlanState(), {
      action: 'update',
      phase: 'self-check',
      items: Array.from({ length: 64 }, (_, i) => ({ id: `must-${String(i)}`, status: 'verified' as const })),
      note: '自检',
    }).state;
    const warnings = Array.from({ length: 10 }, (_, i) => `提醒${String(i)}：${'很'.repeat(80)}`);
    const text = formatFacts({ ...facts, plan, warnings });
    assert.ok(text.length <= FACTS_MAX_CHARS, String(text.length));
    assert.ok(text.includes(planDigest(plan)));
    assert.match(text, /（另有 \d+ 条提醒未显示）$/);
  });

  it('状态部分四行全出现、数字取大时仍远小于上限', () => {
    const text = formatFacts({
      ...facts,
      nextTurn: 999,
      maxTurns: 999,
      spentCny: 99.99,
      maxCostCny: 99.99,
      elapsedMs: 10 ** 9,
      wallMs: 10 ** 9,
      draftVersion: 9999,
      lastCheck: { version: 9999, outcome: 'precheck-failed' },
      lastViewVersion: 9999,
      window: { remaining: 3, entering: true },
      event: 'degenerate',
    });
    assert.ok(text.length < FACTS_MAX_CHARS - 50, String(text.length));
  });
});

describe('degenerateContent（§3.2 退化取消）', () => {
  it('截到前 2000 字符并加中止说明；短文本原样加说明', () => {
    assert.equal(degenerateContent('abc'), `abc${DEGENERATE_SUFFIX}`);
    const long = 'ab'.repeat(3000);
    assert.equal(degenerateContent(long), `${long.slice(0, DEGENERATE_KEEP_CHARS)}${DEGENERATE_SUFFIX}`);
  });

  it('不切开代理对', () => {
    const text = `${'a'.repeat(DEGENERATE_KEEP_CHARS - 1)}😀tail`;
    assert.equal(degenerateContent(text), `${'a'.repeat(DEGENERATE_KEEP_CHARS - 1)}${DEGENERATE_SUFFIX}`);
  });
});

it('FACTS_FORMAT_VERSION 当前为 10（窗口先于首稿时写 v0 例外）', () => {
  assert.equal(FACTS_FORMAT_VERSION, 10);
});
