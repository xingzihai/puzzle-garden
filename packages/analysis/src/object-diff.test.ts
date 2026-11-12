/**
 * `@pg/analysis/object-diff` 单测：pass / fail / missing / extra / unverified、排序确定性、空输入。
 *
 * 全部对象在内存里构造，不读 .work，不依赖 run-9 或四栋 fixture。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  AsBuiltBounds,
  AsBuiltObject,
  FurnitureObject,
  OpeningObject,
  RoofObject,
  SiteObject,
  SlabObject,
  UnknownObject,
  WallObject,
} from './as-built-types.ts';
import { diffFurnitureObjects, diffObjects, summarizeDiffItems } from './object-diff.ts';
import type {
  ExpectedFurniture,
  ExpectedObject,
  ExpectedOpening,
  ExpectedRoof,
  ExpectedSlab,
  ExpectedWall,
} from './object-diff.ts';

function box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): AsBuiltBounds {
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function baseObject(
  id: string,
  bounds: AsBuiltBounds,
  confidence: 'high' | 'medium' | 'low' = 'high',
): Omit<AsBuiltObject, 'kind' | 'wall' | 'slab' | 'roof' | 'opening' | 'site' | 'furniture' | 'unknown'> {
  return {
    id,
    bounds,
    cells: 1,
    footprintCells: 1,
    materials: [],
    samples: [],
    confidence,
    source: { calls: [] },
    clipped: false,
    support: null,
  };
}

function wall(id: string, bounds: AsBuiltBounds, confidence: 'high' | 'medium' | 'low' = 'high'): WallObject {
  const alongX = bounds.max[0] - bounds.min[0] >= bounds.max[2] - bounds.min[2];
  return {
    ...baseObject(id, bounds, confidence),
    kind: 'wall',
    support: { state: 'grounded' },
    wall: {
      axis: alongX ? 'x' : 'z',
      plane: alongX ? bounds.min[2] : bounds.min[0],
      lengthCells: alongX ? bounds.max[0] - bounds.min[0] : bounds.max[2] - bounds.min[2],
      heightCells: bounds.max[1] - bounds.min[1],
    },
  };
}

function slab(id: string, bounds: AsBuiltBounds, confidence: 'high' | 'medium' | 'low' = 'high'): SlabObject {
  return {
    ...baseObject(id, bounds, confidence),
    kind: 'slab',
    support: { state: 'grounded' },
    slab: {
      topY: bounds.max[1] - 1,
      bottomY: bounds.min[1],
      thicknessCells: bounds.max[1] - bounds.min[1],
      areaCells: 1,
    },
  };
}

function roof(
  id: string,
  bounds: AsBuiltBounds,
  facts: {
    readonly formHint: RoofObject['roof']['formHint'];
    readonly eaveY: number;
    readonly ridgeY: number;
    readonly pitchDegrees: number | null;
  },
  confidence: 'high' | 'medium' | 'low' = 'high',
): RoofObject {
  return {
    ...baseObject(id, bounds, confidence),
    kind: 'roof',
    support: { state: 'supported' },
    roof: {
      ...facts,
      topCells: 1,
      ridgeAxis: facts.formHint === 'flat' ? null : 'x',
      ridgeWidth: facts.formHint === 'flat' ? null : 1,
    },
  };
}

function opening(
  id: string,
  bounds: AsBuiltBounds,
  subtype: OpeningObject['opening']['subtype'],
  options: {
    readonly confidence?: 'high' | 'medium' | 'low';
    readonly fill?: OpeningObject['opening']['fill'];
    readonly voidCells?: number;
  } = {},
): OpeningObject {
  const dx = bounds.max[0] - bounds.min[0];
  const dz = bounds.max[2] - bounds.min[2];
  const width = dx === 1 ? dz : dx;
  const height = bounds.max[1] - bounds.min[1];
  const fill = options.fill ?? (subtype === 'window' ? 'glass' : subtype === 'unknown' ? 'solid' : 'air');
  const voidCells = options.voidCells ?? (fill === 'air' ? width * height : 0);
  return {
    ...baseObject(id, bounds, options.confidence ?? 'high'),
    kind: 'opening',
    host: null,
    support: { state: 'unknown' },
    opening: {
      subtype,
      fill,
      widthCells: width,
      heightCells: height,
      depthCells: 1,
      voidCells,
      fillCells: width * height - voidCells,
      sillY: bounds.min[1],
      headY: bounds.max[1],
    },
  };
}

function site(id: string, bounds: AsBuiltBounds): SiteObject {
  return {
    ...baseObject(id, bounds),
    kind: 'site',
    site: { subtype: 'ground', topY: bounds.min[1], areaCells: 1 },
  };
}

function furniture(
  id: string,
  bounds: AsBuiltBounds,
  options: {
    readonly subtype?: FurnitureObject['furniture']['subtype'];
    readonly seatCapacity?: number | null;
    readonly materials?: readonly { readonly block: string; readonly cells: number }[];
    readonly confidence?: 'high' | 'medium' | 'low';
  } = {},
): FurnitureObject {
  return {
    ...baseObject(id, bounds, options.confidence ?? 'high'),
    kind: 'furniture',
    materials: options.materials ?? [],
    furniture: {
      subtype: options.subtype ?? 'other',
      seatCapacity: options.seatCapacity ?? null,
      heightCells: bounds.max[1] - bounds.min[1],
    },
  };
}

function unknownObject(id: string, bounds: AsBuiltBounds): UnknownObject {
  return {
    ...baseObject(id, bounds),
    kind: 'unknown',
    support: null,
    unknown: { reason: 'no-rule-match' },
  };
}

const WALL_ENVELOPE = { min: [0, 0, 0] as const, max: [4, 3, 3] as const };
const SLAB_BOUNDS = box(0, -1, 0, 4, 0, 3);
const ROOF_BOUNDS = box(0, 3, 0, 4, 4, 3);
const WINDOW_BOUNDS = box(1, 0, 0, 2, 2, 1);

function expectedWall(): ExpectedWall {
  return { id: 'wall:test', kind: 'wall', bounds: WALL_ENVELOPE, unverifiedReason: null };
}

function expectedSlab(): ExpectedSlab {
  return { id: 'slab:test', kind: 'slab', bounds: SLAB_BOUNDS, unverifiedReason: null };
}

function expectedRoof(): ExpectedRoof {
  return {
    id: 'roof:test',
    kind: 'roof',
    bounds: ROOF_BOUNDS,
    unverifiedReason: null,
    form: 'flat',
    pitchDegrees: 0,
    eaveY: 3,
    ridgeY: 3,
    overhang: 0,
  };
}

function expectedOpening(overrides: Partial<ExpectedOpening> = {}): ExpectedOpening {
  return {
    id: 'opening:test',
    kind: 'opening',
    bounds: WINDOW_BOUNDS,
    unverifiedReason: null,
    subtype: 'window',
    side: 'north',
    width: 1,
    height: 2,
    sillY: 0,
    headY: 2,
    hostId: null,
    ...overrides,
  };
}

function expectedFurniture(overrides: Partial<ExpectedFurniture> = {}): ExpectedFurniture {
  return {
    id: 'furniture:table',
    kind: 'furniture',
    bounds: box(3, 1, 5, 7, 2, 7),
    materialBlock: 'oak_planks',
    furnitureKind: 'table',
    seatCapacity: null,
    unverifiedReason: null,
    ...overrides,
  };
}

const TABLE_PLANKS = [{ block: 'oak_planks', cells: 8 }] as const;

function actualWalls(): readonly WallObject[] {
  return [
    wall('wall-n', box(0, 0, 0, 4, 3, 1)),
    wall('wall-s', box(0, 0, 2, 4, 3, 3)),
    wall('wall-w', box(0, 0, 0, 1, 3, 3)),
    wall('wall-e', box(3, 0, 0, 4, 3, 3)),
  ];
}

function goodActuals(): readonly AsBuiltObject[] {
  return [
    ...actualWalls(),
    slab('slab-a', SLAB_BOUNDS),
    roof('roof-a', ROOF_BOUNDS, { formHint: 'flat', eaveY: 3, ridgeY: 3, pitchDegrees: 0 }),
    opening('window-a', WINDOW_BOUNDS, 'window'),
  ];
}

function statusOf(report: ReturnType<typeof diffObjects>, kind: string): string[] {
  return report.items.filter((item) => item.kind === kind).map((item) => item.status);
}

describe('diffObjects：pass', () => {
  it('wall union / slab / roof / opening 全部对齐时 pass，blocking=false', () => {
    const report = diffObjects([expectedWall(), expectedSlab(), expectedRoof(), expectedOpening()], goodActuals());
    assert.equal(report.summary.pass, 4);
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.missing, 0);
    assert.equal(report.summary.extra, 0);
    assert.equal(report.summary.unverified, 0);
    assert.equal(report.summary.blocking, false);
    assert.equal(report.summary.blockingCount, 0);
    assert.equal(report.summary.fullyVerified, true);
    assert.deepEqual(statusOf(report, 'wall'), ['pass']);
    assert.deepEqual(statusOf(report, 'opening'), ['pass']);
    const wallItem = report.items.find((item) => item.kind === 'wall');
    assert.ok(wallItem !== undefined);
    assert.equal(wallItem.actualId, 'wall-union');
    assert.match(wallItem.evidence.join(' '), /four-side coverage checked/);
  });

  it('wall 聚合成一个包络，不要求 expected 1 对 1 对上 actual 面板', () => {
    const report = diffObjects([expectedWall()], actualWalls());
    assert.equal(report.summary.pass, 1);
  });
});

describe('diffObjects：fail', () => {
  it('删掉一面墙时 envelope 仍是原范围，但四侧覆盖检查报 fail', () => {
    const walls = actualWalls().filter((item) => item.id !== 'wall-n');
    const report = diffObjects([expectedWall()], walls);
    const item = report.items.find((entry) => entry.kind === 'wall');
    assert.ok(item !== undefined);
    assert.equal(item.status, 'fail');
    assert.equal(item.severity, 'hard');
    assert.deepEqual(Object.keys(item.delta).sort(), ['coverage']);
    assert.match(item.reason ?? '', /coverage/);
    assert.equal(report.summary.blocking, true);
  });

  it('墙整体抬高 1 格时 bounds fail', () => {
    const walls = actualWalls().map((item) =>
      wall(item.id, box(item.bounds.min[0], 1, item.bounds.min[2], item.bounds.max[0], 4, item.bounds.max[2])),
    );
    const report = diffObjects([expectedWall()], walls);
    const item = report.items.find((entry) => entry.kind === 'wall');
    assert.ok(item !== undefined);
    assert.equal(item.status, 'fail');
    assert.deepEqual(Object.keys(item.delta).sort(), ['bounds', 'coverage']);
  });

  it('窗整体位移时按同级 family / 法向匹配后 bounds fail', () => {
    const shifted = opening('window-shifted', box(2, 0, 0, 3, 2, 1), 'window');
    const report = diffObjects([expectedOpening()], [shifted]);
    const item = report.items.find((entry) => entry.kind === 'opening');
    assert.ok(item !== undefined);
    assert.equal(item.status, 'fail');
    assert.deepEqual(Object.keys(item.delta).sort(), ['bounds']);
  });

  it('少玻璃时 window fill 检查报 fail', () => {
    const missingGlass = opening('window-void', WINDOW_BOUNDS, 'window', { voidCells: 1 });
    const report = diffObjects([expectedOpening()], [missingGlass]);
    const item = report.items.find((entry) => entry.kind === 'opening');
    assert.ok(item !== undefined);
    assert.equal(item.status, 'fail');
    assert.deepEqual(Object.keys(item.delta), ['fill']);
  });

  it('门高多 1 格时 opening height / headY fail', () => {
    const tallDoor = opening('door-tall', box(1, 0, 0, 2, 3, 1), 'passage');
    const report = diffObjects([expectedOpening({ subtype: 'door', width: 1, height: 2, headY: 2 })], [tallDoor]);
    const item = report.items.find((entry) => entry.kind === 'opening');
    assert.ok(item !== undefined);
    assert.equal(item.status, 'fail');
    assert.deepEqual(Object.keys(item.delta).sort(), ['bounds', 'headY', 'height']);
  });

  it('屋面抬高 / 改坡时 bounds / pitch / eave / ridge fail', () => {
    const wrongRoof = roof('roof-wrong', box(0, 4, 0, 4, 7, 3), {
      formHint: 'pitched',
      eaveY: 4,
      ridgeY: 6,
      pitchDegrees: 45,
    });
    const report = diffObjects([expectedRoof()], [wrongRoof]);
    const item = report.items.find((entry) => entry.kind === 'roof');
    assert.ok(item !== undefined);
    assert.equal(item.status, 'fail');
    assert.deepEqual(Object.keys(item.delta).sort(), ['bounds', 'eaveY', 'form', 'pitchDegrees', 'ridgeY']);
  });

  it('期望 gable / actual flat 时 coarse form fail', () => {
    const flat = roof('roof-flat', ROOF_BOUNDS, {
      formHint: 'flat',
      eaveY: 3,
      ridgeY: 3,
      pitchDegrees: 0,
    });
    const report = diffObjects([{ ...expectedRoof(), form: 'gable', pitchDegrees: 25 }], [flat]);
    const item = report.items.find((entry) => entry.kind === 'roof');
    assert.ok(item !== undefined);
    assert.equal(item.status, 'fail');
    assert.ok(Object.keys(item.delta).includes('form'));
  });

  it('期望 gable / actual stepped 时 coarse form fail', () => {
    const stepped = roof('roof-stepped', ROOF_BOUNDS, {
      formHint: 'stepped',
      eaveY: 3,
      ridgeY: 3,
      pitchDegrees: 0,
    });
    const report = diffObjects([{ ...expectedRoof(), form: 'gable' }], [stepped]);
    const item = report.items.find((entry) => entry.kind === 'roof');
    assert.ok(item !== undefined);
    assert.equal(item.status, 'fail');
    assert.ok(Object.keys(item.delta).includes('form'));
  });
});

describe('diffObjects：missing / extra / unverified', () => {
  it('expected 存在但没有 actual → missing hard', () => {
    const report = diffObjects([expectedWall(), expectedOpening()], []);
    assert.deepEqual(statusOf(report, 'wall'), ['missing']);
    assert.deepEqual(statusOf(report, 'opening'), ['missing']);
    assert.equal(report.summary.missing, 2);
    assert.equal(report.summary.blocking, true);
  });

  it('actual 有 high confidence opening 但无 expected → extra soft', () => {
    const report = diffObjects([], [opening('window-extra', WINDOW_BOUNDS, 'window')]);
    assert.deepEqual(statusOf(report, 'opening'), ['extra']);
    const item = report.items[0];
    assert.ok(item !== undefined);
    assert.equal(item.severity, 'soft');
    assert.equal(report.summary.extra, 1);
    assert.equal(report.summary.blocking, false);
    assert.equal(report.summary.fullyVerified, false);
  });

  it('actual wall / slab 没有 expected 时逐对象 extra soft', () => {
    const report = diffObjects([], [wall('wall-extra', box(0, 0, 0, 4, 3, 1)), slab('slab-extra', SLAB_BOUNDS)]);
    assert.equal(report.summary.extra, 2);
    assert.equal(report.summary.blocking, false);
    assert.deepEqual(
      report.items.map((item) => item.kind),
      ['wall', 'slab'],
    );
  });

  it('low confidence actual opening 只能 unverified，不报 pass / fail', () => {
    const expected = expectedOpening({ subtype: 'door', side: 'north', width: 1, height: 2 });
    const low = opening('opening-low', box(0, 0, 0, 2, 2, 1), 'unknown', { confidence: 'low' });
    const report = diffObjects([expected], [low]);
    const item = report.items.find((entry) => entry.kind === 'opening');
    assert.ok(item !== undefined);
    assert.equal(item.status, 'unverified');
    assert.equal(item.severity, 'hard');
    assert.equal(report.summary.blocking, true);
  });

  it('low confidence wall 聚合成 unverified hard', () => {
    const walls = actualWalls().map((item, index) => (index === 0 ? wall(item.id, item.bounds, 'low') : item));
    const report = diffObjects([expectedWall()], walls);
    const item = report.items.find((entry) => entry.kind === 'wall');
    assert.ok(item !== undefined);
    assert.equal(item.status, 'unverified');
    assert.equal(item.severity, 'hard');
  });

  it('low confidence slab / roof 分别 unverified hard', () => {
    const slabReport = diffObjects([expectedSlab()], [slab('slab-low', SLAB_BOUNDS, 'low')]);
    const slabItem = slabReport.items[0];
    assert.ok(slabItem !== undefined);
    assert.equal(slabItem.status, 'unverified');
    assert.equal(slabItem.severity, 'hard');
    const roofReport = diffObjects(
      [expectedRoof()],
      [roof('roof-low', ROOF_BOUNDS, { formHint: 'flat', eaveY: 3, ridgeY: 3, pitchDegrees: 0 }, 'low')],
    );
    const roofItem = roofReport.items[0];
    assert.ok(roofItem !== undefined);
    assert.equal(roofItem.status, 'unverified');
    assert.equal(roofItem.severity, 'hard');
  });

  it('roof form / pitch 测不出时 unverified，而不是假通过', () => {
    const complex = roof('roof-complex', ROOF_BOUNDS, {
      formHint: 'complex',
      eaveY: 3,
      ridgeY: 3,
      pitchDegrees: null,
    });
    const report = diffObjects([expectedRoof()], [complex]);
    const item = report.items[0];
    assert.ok(item !== undefined);
    assert.equal(item.status, 'unverified');
    assert.equal(item.severity, 'hard');
    assert.ok(Object.keys(item.delta).includes('form'));
    assert.ok(Object.keys(item.delta).includes('pitchDegrees'));
  });

  it('projected unverified roof 只报 hard unverified', () => {
    const report = diffObjects([{ ...expectedRoof(), unverifiedReason: 'segments unsupported' }], []);
    const item = report.items[0];
    assert.ok(item !== undefined);
    assert.equal(item.status, 'unverified');
    assert.equal(item.severity, 'hard');
    assert.match(item.reason ?? '', /segments unsupported/);
  });

  it('actual unknown kind → unverified soft，并进入 notCompared.unknown', () => {
    const report = diffObjects([], [unknownObject('unknown-a', box(9, 9, 9, 10, 10, 10))]);
    assert.deepEqual(statusOf(report, 'unknown'), ['unverified']);
    assert.equal(report.items[0]?.severity, 'soft');
    assert.equal(report.notCompared.unknown, 1);
    assert.equal(report.notCompared.total, 1);
    assert.equal(report.summary.blocking, false);
  });

  it('site / furniture / unknown 记 notCompared，不参与硬比较', () => {
    const actual = [
      site('site-a', box(0, 0, 0, 10, 1, 10)),
      furniture('furniture-a', box(1, 0, 1, 2, 2, 2)),
      unknownObject('unknown-a', box(9, 9, 9, 10, 10, 10)),
    ];
    const report = diffObjects([], actual);
    assert.equal(report.notCompared.site, 1);
    assert.equal(report.notCompared.furniture, 1);
    assert.equal(report.notCompared.unknown, 1);
    assert.equal(report.notCompared.total, 3);
    assert.deepEqual(report.notCompared.ids.site, ['site-a']);
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.missing, 0);
    assert.equal(report.summary.extra, 0);
  });
  it('compareOpenings:false 时对象图 opening 只进 context，不生成 item', () => {
    const report = diffObjects([expectedOpening()], [opening('window-context', WINDOW_BOUNDS, 'window')], {
      compareOpenings: false,
    });
    assert.deepEqual(report.items, []);
    assert.equal(report.context.openings.length, 1);
    assert.equal(report.context.openings[0]?.id, 'window-context');
    assert.equal(report.summary.blocking, false);
    assert.equal(
      report.notes.some((note) => note.includes('context only')),
      true,
    );
  });
});

describe('diffObjects：确定性与空输入', () => {
  it('actual / expected 乱序不改变报告 JSON', () => {
    const expected: ExpectedObject[] = [expectedOpening(), expectedRoof(), expectedWall(), expectedSlab()];
    const actual = goodActuals();
    const a = diffObjects(expected, actual);
    const b = diffObjects([...expected].reverse(), [...actual].reverse());
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('空输入返回零计数、blocking=false、fullyVerified=true', () => {
    const report = diffObjects([], []);
    assert.deepEqual(
      {
        pass: report.summary.pass,
        fail: report.summary.fail,
        missing: report.summary.missing,
        extra: report.summary.extra,
        unverified: report.summary.unverified,
      },
      { pass: 0, fail: 0, missing: 0, extra: 0, unverified: 0 },
    );
    assert.equal(report.summary.blocking, false);
    assert.equal(report.summary.fullyVerified, true);
    assert.deepEqual(report.items, []);
    assert.equal(report.notCompared.total, 0);
  });

  it('多段 actual roof 只拿最大的一块，其余报 extra', () => {
    const small = roof('roof-small', box(0, 3, 0, 2, 4, 2), {
      formHint: 'flat',
      eaveY: 3,
      ridgeY: 3,
      pitchDegrees: 0,
    });
    const report = diffObjects(
      [expectedRoof()],
      [
        small,
        roof('roof-a', ROOF_BOUNDS, {
          formHint: 'flat',
          eaveY: 3,
          ridgeY: 3,
          pitchDegrees: 0,
        }),
      ],
    );
    assert.equal(report.summary.pass, 1);
    assert.equal(report.summary.extra, 1);
    assert.deepEqual(statusOf(report, 'roof'), ['pass', 'extra']);
  });
});

describe('diffFurnitureObjects', () => {
  it('table + bench 完全对齐：pass，blocking=false，且不进入 diffObjects 主表', () => {
    const table = furniture('furniture-table', box(3, 1, 5, 7, 2, 7), { subtype: 'table', materials: TABLE_PLANKS });
    const bench = furniture('furniture-bench', box(3, 1, 3, 7, 2, 4), {
      subtype: 'bench',
      materials: [{ block: 'oak_planks', cells: 4 }],
      seatCapacity: 5,
    });
    const items = diffFurnitureObjects(
      [
        expectedFurniture(),
        expectedFurniture({
          id: 'furniture:bench',
          bounds: box(3, 1, 3, 7, 2, 4),
          furnitureKind: 'bench',
          seatCapacity: 5,
        }),
      ],
      [bench, table],
    );
    assert.deepEqual(
      items.map((item) => [item.expectedId, item.status]),
      [
        ['furniture:bench', 'pass'],
        ['furniture:table', 'pass'],
      ],
    );
    assert.equal(summarizeDiffItems(items).blocking, false);

    // furniture 不参与通用 diff：仍只记 notCompared，不产生 furniture item。
    const report = diffObjects([], [table, bench]);
    assert.equal(
      report.items.some((item) => item.kind === 'furniture'),
      false,
    );
    assert.equal(report.notCompared.furniture, 2);
    assert.equal(report.summary.extra, 0);
  });

  it('声明 table / bench / counter 与实测 subtype 不符 -> furnitureKind fail', () => {
    const tableShape = furniture('furniture-shape', box(3, 1, 5, 7, 2, 7), {
      subtype: 'bench',
      materials: TABLE_PLANKS,
    });
    const items = diffFurnitureObjects([expectedFurniture()], [tableShape]);
    const item = items[0];
    assert.ok(item !== undefined);
    assert.equal(item.status, 'fail');
    assert.deepEqual(Object.keys(item.delta), ['furnitureKind']);
  });

  it('桌面深度多一格：>=90% 体积重叠仍能匹配，bounds fail 并给出 delta', () => {
    const deepTable = furniture('furniture-deep', box(3, 1, 5, 7, 2, 8), {
      subtype: 'table',
      materials: [{ block: 'oak_planks', cells: 12 }],
    });
    const items = diffFurnitureObjects([expectedFurniture()], [deepTable]);
    const item = items[0];
    assert.ok(item !== undefined);
    assert.equal(item.status, 'fail');
    assert.equal(item.severity, 'hard');
    assert.deepEqual(Object.keys(item.delta), ['bounds']);
    assert.deepEqual(item.delta['bounds'], {
      expected: [3, 1, 5, 7, 2, 7],
      actual: [3, 1, 5, 7, 2, 8],
      delta: [0, 0, 0, 0, 0, 1],
    });
    assert.equal(summarizeDiffItems(items).blocking, true);
  });

  it('缺一条长凳：missing hard，actualId=null', () => {
    const table = furniture('furniture-table', box(3, 1, 5, 7, 2, 7), { subtype: 'table', materials: TABLE_PLANKS });
    const items = diffFurnitureObjects(
      [
        expectedFurniture(),
        expectedFurniture({
          id: 'furniture:bench-missing',
          bounds: box(3, 1, 3, 7, 2, 4),
          furnitureKind: 'bench',
          seatCapacity: 5,
        }),
      ],
      [table],
    );
    const missing = items.find((item) => item.expectedId === 'furniture:bench-missing');
    assert.ok(missing !== undefined);
    assert.equal(missing.status, 'missing');
    assert.equal(missing.severity, 'hard');
    assert.equal(missing.actualId, null);
    assert.match(missing.reason ?? '', /no actual furniture/);
    assert.equal(summarizeDiffItems(items).blocking, true);
  });

  it('主材不符 / 要求的主材不是主材：materialBlock fail', () => {
    const wrongBlock = furniture('furniture-spruce', box(3, 1, 5, 7, 2, 7), {
      subtype: 'table',
      materials: [{ block: 'spruce_planks', cells: 8 }],
    });
    const wrong = diffFurnitureObjects([expectedFurniture()], [wrongBlock]);
    const wrongItem = wrong[0];
    assert.ok(wrongItem !== undefined);
    assert.equal(wrongItem.status, 'fail');
    assert.deepEqual(Object.keys(wrongItem.delta), ['materialBlock']);

    const mixed = furniture('furniture-mixed', box(3, 1, 5, 7, 2, 7), {
      subtype: 'table',
      materials: [
        { block: 'oak_planks', cells: 2 },
        { block: 'spruce_planks', cells: 6 },
      ],
    });
    const mixedItems = diffFurnitureObjects([expectedFurniture()], [mixed]);
    const mixedItem = mixedItems[0];
    assert.ok(mixedItem !== undefined);
    assert.equal(mixedItem.status, 'fail');
    assert.deepEqual(mixedItem.delta['materialBlock'], {
      expected: 'oak_planks',
      actual: ['oak_planks', 'spruce_planks'],
      delta: null,
    });
  });

  it('长凳太短：座位数不足 fail，delta 给出期望 / 实际', () => {
    const benchBounds = box(3, 1, 3, 7, 2, 4);
    const shortBench = furniture('furniture-short', box(3, 1, 3, 5, 2, 4), {
      subtype: 'bench',
      materials: [{ block: 'oak_planks', cells: 2 }],
      seatCapacity: 2,
    });
    const items = diffFurnitureObjects(
      [
        expectedFurniture({
          id: 'furniture:bench',
          bounds: benchBounds,
          furnitureKind: 'bench',
          seatCapacity: 5,
        }),
      ],
      [shortBench],
    );
    const item = items[0];
    // 2×1 实际只覆盖 4×1 期望的一半，匹配不上 -> missing；再做同 footprint 的短座位对照。
    assert.ok(item !== undefined);
    assert.equal(item.status, 'missing');

    const sameFootprintShort = furniture('furniture-same-shape', benchBounds, {
      subtype: 'bench',
      materials: [{ block: 'oak_planks', cells: 4 }],
      seatCapacity: 3,
    });
    const seatItems = diffFurnitureObjects(
      [
        expectedFurniture({
          id: 'furniture:bench',
          bounds: benchBounds,
          furnitureKind: 'bench',
          seatCapacity: 5,
        }),
      ],
      [sameFootprintShort],
    );
    const seatItem = seatItems[0];
    assert.ok(seatItem !== undefined);
    assert.equal(seatItem.status, 'fail');
    assert.deepEqual(seatItem.delta['seatCapacity'], { expected: 5, actual: 3, delta: -2 });
  });

  it('多出的家具是 soft extra；低 confidence 家具是 hard unverified', () => {
    const extra = furniture('furniture-extra', box(3, 1, 5, 7, 2, 7), { subtype: 'table', materials: TABLE_PLANKS });
    const extras = diffFurnitureObjects([], [extra]);
    const extraItem = extras[0];
    assert.ok(extraItem !== undefined);
    assert.equal(extraItem.status, 'extra');
    assert.equal(extraItem.severity, 'soft');
    assert.equal(summarizeDiffItems(extras).blocking, false);

    const low = furniture('furniture-low', box(3, 1, 5, 7, 2, 7), {
      subtype: 'table',
      materials: TABLE_PLANKS,
      confidence: 'low',
    });
    const lowItems = diffFurnitureObjects([expectedFurniture()], [low]);
    const lowItem = lowItems[0];
    assert.ok(lowItem !== undefined);
    assert.equal(lowItem.status, 'unverified');
    assert.equal(lowItem.severity, 'hard');
    assert.equal(summarizeDiffItems(lowItems).blocking, true);
  });

  it('projection unverifiedReason 只报 hard unverified；输入乱序结果一致', () => {
    const unverified = diffFurnitureObjects(
      [expectedFurniture({ unverifiedReason: 'furniture material is not declared' })],
      [],
    );
    const item = unverified[0];
    assert.ok(item !== undefined);
    assert.equal(item.status, 'unverified');
    assert.equal(item.severity, 'hard');
    assert.match(item.reason ?? '', /not declared/);

    const table = furniture('furniture-table', box(3, 1, 5, 7, 2, 7), { subtype: 'table', materials: TABLE_PLANKS });
    const extra = furniture('furniture-extra', box(9, 1, 9, 10, 2, 10), {
      subtype: 'table',
      materials: [{ block: 'lantern', cells: 1 }],
    });
    const expected = [expectedFurniture({ id: 'furniture:b' }), expectedFurniture({ id: 'furniture:a' })];
    const forward = diffFurnitureObjects(expected, [extra, table]);
    const backward = diffFurnitureObjects([...expected].reverse(), [table, extra]);
    assert.equal(JSON.stringify(forward), JSON.stringify(backward));
  });
});
