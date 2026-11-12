import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileBuildBrief, lintBrief } from './brief.ts';
import { expandDesignIntent } from './design-expand.ts';
import { DesignIntent } from './design-intent.ts';
import type { DesignHostContext } from './design-intent.ts';
import { boundsOverlap, boundsWithin } from './primitives.ts';
import { renderPreviewBundle } from './preview.ts';
import { compileDesignReport } from './report.ts';
import { DesignScheme } from './scheme.ts';

function host(schemeId: string): DesignHostContext {
  return {
    schemeId,
    revision: 1,
    status: 'draft',
    sourceRequirements: { graphId: 'req-graph', revision: 1 },
    maxBlocks: 20_000,
    targetBlocks: 12_000,
    maxCostCny: 100_000,
    forbidden: ['不得改变已确认方案的主要布局'],
    defaultMaterialId: 'mat-wood',
    floorThickness: 1,
    requirementIds: [],
  };
}

const MATERIALS = [
  { id: 'mat-stone', name: '浅灰石', block: 'stone_bricks', role: 'structure', color: '#9a9a92', notes: null },
  { id: 'mat-wood', name: '深色木', block: 'dark_oak_planks', role: 'structure', color: '#4d3424', notes: null },
  { id: 'mat-plaster', name: '米色墙面', block: 'smooth_sandstone', role: 'wall', color: '#d8cbb0', notes: null },
  { id: 'mat-roof', name: '深瓦屋面', block: 'deepslate_tiles', role: 'roof', color: '#3f4145', notes: null },
  { id: 'mat-glass', name: '清玻璃', block: 'glass', role: 'glass', color: '#b8d4d6', notes: null },
  { id: 'mat-fabric', name: '米色织物', block: 'white_wool', role: 'furniture', color: '#e8e1d4', notes: null },
  { id: 'mat-grass', name: '草地', block: 'grass_block', role: 'landscape', color: '#6f8f4a', notes: null },
] as const;

const FACADES = [
  {
    side: 'north',
    baseMaterialId: 'mat-stone',
    bodyMaterialId: 'mat-wood',
    topMaterialId: null,
    bays: 3,
    windowWallRatio: null,
    notes: null,
  },
  {
    side: 'south',
    baseMaterialId: 'mat-stone',
    bodyMaterialId: 'mat-wood',
    topMaterialId: null,
    bays: 3,
    windowWallRatio: null,
    notes: null,
  },
  {
    side: 'east',
    baseMaterialId: 'mat-stone',
    bodyMaterialId: 'mat-wood',
    topMaterialId: null,
    bays: 2,
    windowWallRatio: null,
    notes: null,
  },
  {
    side: 'west',
    baseMaterialId: 'mat-stone',
    bodyMaterialId: 'mat-wood',
    topMaterialId: null,
    bays: 2,
    windowWallRatio: null,
    notes: null,
  },
] as const;

function teaIntent(): Record<string, unknown> {
  return {
    meta: { title: '稻田茶亭', concept: '面向南侧稻田的单间木构茶亭。', scope: 'exterior+interior' },
    site: {
      bounds: { x: [0, 16], z: [0, 12] },
      orientation: 'south',
      entrance: { side: 'south', notes: null },
      outdoorZones: [
        {
          id: 'zone-terrace',
          name: '南侧平台',
          kind: 'terrace',
          rect: { x: [3, 11], z: [9, 12] },
          materialId: 'mat-stone',
          notes: null,
        },
      ],
      notes: null,
    },
    program: {
      levels: [{ id: 'f1', name: '地面层', height: 3, floorMaterialId: 'mat-stone' }],
      rooms: [
        {
          id: 'tea',
          name: '主茶室',
          level: 'f1',
          kind: 'room',
          rect: { x: [3, 11], z: [3, 9] },
          areaM2: 48,
          occupancy: 8,
          adjacency: [],
          daylight: 'required',
          notes: null,
        },
      ],
    },
    envelope: { wallDefaults: { exteriorThickness: 1, interiorThickness: 1 }, walls: [], stairs: [] },
    openings: [
      {
        id: 'op-entry',
        name: '南侧入口',
        roomId: 'tea',
        side: 'south',
        kind: 'door',
        role: 'entrance',
        offset: 3,
        width: 2,
        height: 2,
        sill: 0,
        fill: '木框玻璃门',
        frameMaterial: 'mat-wood',
      },
      {
        id: 'win-north',
        name: '北向长窗',
        roomId: 'tea',
        side: 'north',
        kind: 'window',
        offset: 2,
        width: 4,
        height: 1,
        sill: 1,
        fill: '透明玻璃',
        frameMaterial: 'mat-wood',
      },
    ],
    structure: { system: 'post-and-beam', materialId: 'mat-wood', floorThickness: 1, cantilever: 0, notes: null },
    roof: {
      form: 'gable',
      materialId: 'mat-roof',
      pitchDegrees: 25,
      overhang: 1,
      ridgeAxis: 'x',
      drainage: null,
      skylights: [],
      notes: null,
    },
    facades: FACADES,
    materials: MATERIALS,
    furniture: [
      {
        id: 'f-table',
        name: '长茶桌',
        kind: 'table',
        roomId: 'tea',
        anchor: { kind: 'center' },
        footprint: { x: 2, z: 1 },
        orientation: 'south',
        height: 1,
        materialId: 'mat-wood',
        notes: null,
      },
      {
        id: 'f-bench',
        name: '北墙长凳',
        kind: 'bench',
        roomId: 'tea',
        anchor: { kind: 'wall', side: 'north', offset: 4 },
        footprint: { x: 3, z: 1 },
        orientation: 'south',
        height: 1,
        materialId: 'mat-wood',
        notes: null,
      },
    ],
    decisions: [],
    open: [],
  };
}

/** L 形顶层：主茶室 + 东侧扩展间，用于多段屋面。 */
function lShapeIntent(): Record<string, unknown> {
  const base = structuredClone(teaIntent());
  const meta = base['meta'] as Record<string, unknown>;
  meta['title'] = 'L 形茶室';
  meta['concept'] = '主茶室向东延伸一间，形成 L 形顶层平面。';
  const program = base['program'] as { rooms: Record<string, unknown>[] };
  const tea = program.rooms[0];
  if (tea === undefined) throw new Error('缺少主茶室');
  tea['adjacency'] = ['extension'];
  program.rooms.push({
    id: 'extension',
    name: '东侧扩展间',
    level: 'f1',
    kind: 'room',
    rect: { x: [11, 15], z: [3, 7] },
    occupancy: 2,
    adjacency: ['tea'],
    daylight: 'preferred',
    notes: null,
  });
  const furniture = base['furniture'] as Record<string, unknown>[];
  furniture.push({
    id: 'f-extension-table',
    name: '扩展间小桌',
    kind: 'table',
    roomId: 'extension',
    anchor: { kind: 'center' },
    footprint: { x: 2, z: 1 },
    orientation: null,
    height: 1,
    materialId: 'mat-wood',
    notes: null,
  });
  return base;
}

function houseIntent(): Record<string, unknown> {
  const base = teaIntent();
  return {
    ...base,
    meta: { title: '两层住宅', concept: '两层矩形住宅，首层起居与厨房，二层两间卧室。', scope: 'exterior+interior' },
    site: {
      bounds: { x: [0, 20], z: [0, 14] },
      orientation: 'south',
      entrance: { side: 'south', notes: null },
      outdoorZones: [],
      notes: null,
    },
    program: {
      levels: [
        { id: 'f1', name: '首层', height: 3, floorMaterialId: 'mat-stone' },
        { id: 'f2', name: '二层', height: 3, floorMaterialId: 'mat-wood' },
      ],
      rooms: [
        {
          id: 'living',
          name: '起居室',
          level: 'f1',
          kind: 'room',
          rect: { x: [2, 10], z: [2, 10] },
          areaM2: 64,
          occupancy: 4,
          adjacency: ['kitchen'],
          daylight: 'required',
          notes: null,
        },
        {
          id: 'kitchen',
          name: '厨房',
          level: 'f1',
          kind: 'service',
          rect: { x: [10, 16], z: [2, 10] },
          areaM2: 48,
          occupancy: 2,
          adjacency: ['living'],
          daylight: 'preferred',
          notes: null,
        },
        {
          id: 'bed1',
          name: '主卧',
          level: 'f2',
          kind: 'room',
          rect: { x: [2, 9], z: [2, 10] },
          areaM2: 56,
          occupancy: 2,
          adjacency: ['bed2'],
          daylight: 'required',
          notes: null,
        },
        {
          id: 'bed2',
          name: '次卧',
          level: 'f2',
          kind: 'room',
          rect: { x: [9, 16], z: [2, 10] },
          areaM2: 56,
          occupancy: 2,
          adjacency: ['bed1'],
          daylight: 'preferred',
          notes: null,
        },
      ],
    },
    envelope: {
      wallDefaults: { exteriorThickness: 1, interiorThickness: 1 },
      walls: [],
      stairs: [
        {
          id: 'stair-main',
          name: '主楼梯',
          roomId: 'living',
          fromLevel: 'f1',
          toLevel: 'f2',
          start: { x: 3, z: 9 },
          direction: 'north',
          width: 2,
          treads: 5,
          materialId: 'mat-wood',
        },
      ],
    },
    openings: [
      {
        id: 'op-entry',
        name: '南侧入口',
        roomId: 'living',
        side: 'south',
        kind: 'door',
        role: 'entrance',
        offset: 2,
        width: 2,
        height: 2,
        sill: 0,
        fill: '木门',
        frameMaterial: 'mat-wood',
      },
      {
        id: 'win-bed1',
        name: '主卧北窗',
        roomId: 'bed1',
        side: 'north',
        kind: 'window',
        offset: 2,
        width: 2,
        height: 1,
        sill: 1,
        fill: '玻璃',
        frameMaterial: 'mat-wood',
      },
    ],
    roof: { form: 'flat', materialId: 'mat-roof', overhang: 1, drainage: null, skylights: [], notes: null },
    structure: { system: 'frame', materialId: 'mat-wood', floorThickness: 1, cantilever: 0, notes: null },
    furniture: [
      {
        id: 'f-living-table',
        name: '起居桌',
        kind: 'table',
        roomId: 'living',
        anchor: { kind: 'center' },
        footprint: { x: 2, z: 1 },
        orientation: null,
        materialId: 'mat-wood',
        notes: null,
      },
      {
        id: 'f-kitchen-counter',
        name: '厨房台面',
        kind: 'counter',
        roomId: 'kitchen',
        anchor: { kind: 'center' },
        footprint: { x: 2, z: 1 },
        orientation: null,
        materialId: 'mat-wood',
        notes: null,
      },
      {
        id: 'f-bed1',
        name: '主卧床',
        kind: 'bed',
        roomId: 'bed1',
        anchor: { kind: 'center' },
        footprint: { x: 2, z: 2 },
        orientation: null,
        materialId: 'mat-fabric',
        notes: null,
      },
      {
        id: 'f-bed2',
        name: '次卧床',
        kind: 'bed',
        roomId: 'bed2',
        anchor: { kind: 'center' },
        footprint: { x: 2, z: 2 },
        orientation: null,
        materialId: 'mat-fabric',
        notes: null,
      },
    ],
    decisions: [],
    open: [],
  };
}

function courtyardIntent(): Record<string, unknown> {
  const base = teaIntent();
  return {
    ...base,
    meta: { title: '稻田小院', concept: '8×6 茶室与南侧平台、东侧草地。', scope: 'exterior+entry' },
    site: {
      bounds: { x: [0, 20], z: [0, 16] },
      orientation: 'south',
      entrance: { side: 'south', notes: null },
      outdoorZones: [
        {
          id: 'zone-terrace',
          name: '南侧平台',
          kind: 'terrace',
          rect: { x: [3, 11], z: [9, 12] },
          materialId: 'mat-stone',
          notes: null,
        },
        {
          id: 'zone-garden',
          name: '东侧草地',
          kind: 'garden',
          rect: { x: [12, 18], z: [3, 9] },
          materialId: 'mat-grass',
          notes: null,
        },
      ],
      notes: null,
    },
    furniture: [
      {
        id: 'f-outdoor-table',
        name: '平台茶桌',
        kind: 'table',
        roomId: 'zone-terrace',
        anchor: { kind: 'center' },
        footprint: { x: 2, z: 1 },
        orientation: null,
        materialId: 'mat-wood',
        notes: null,
      },
    ],
    decisions: [],
    open: [],
  };
}

test('8×6 茶亭：房间、外墙、门窗、家具、报告 / lint / preview 全链路可跑', () => {
  const resolved = expandDesignIntent(teaIntent(), host('scheme-tea'));
  const { scheme, facts } = resolved;
  assert.equal(DesignScheme.safeParse(scheme).success, true);
  assert.equal(facts.counts.rooms, 1);
  assert.equal(facts.counts.exteriorWalls, 4);
  assert.equal(facts.counts.sharedWalls, 0);
  assert.equal(facts.counts.openings, 2);
  assert.equal(facts.counts.furniture, 2);
  assert.equal(facts.rooms[0]?.nominalAreaM2, 48);
  const entry = scheme.openings.find((opening) => opening.id === 'op-entry');
  assert.ok(entry !== undefined);
  assert.deepEqual(entry.bounds, { min: [6, 1, 8], max: [8, 3, 9] });
  assert.ok(scheme.elements.some((element) => element.id === entry.host && element.kind === 'wall'));
  const interior = scheme.interiors.find((item) => item.spaceId === 'tea');
  assert.equal(interior?.furnitureSpecs.length, 2);
  assert.ok(resolved.warnings.some((warning) => warning.code === 'entry-route-not-modeled'));
  const brief = compileBuildBrief(scheme);
  assert.deepEqual(lintBrief(brief), []);
  assert.match(compileDesignReport(scheme), /稻田茶亭/);
  assert.ok(renderPreviewBundle(scheme).files.length >= 5);
});

test('决策 requirementIds 引用不存在时自动丢弃并警告，不阻断展开', () => {
  const intent = teaIntent();
  intent['decisions'] = [
    {
      id: 'dec-known',
      topic: '朝向',
      choice: '主要开口朝南。',
      rationale: '南侧看稻田。',
      source: 'user',
      requirementIds: ['req-known'],
    },
    {
      id: 'dec-bad',
      topic: '材料',
      choice: '木构。',
      rationale: '与需求一致。',
      source: 'agent',
      requirementIds: ['req-known', 'req-missing'],
    },
  ];

  const { scheme, warnings } = expandDesignIntent(intent, {
    ...host('scheme-decision-ref'),
    requirementIds: ['req-known'],
  });
  const decision = scheme.decisions.find((item) => item.id === 'dec-bad');
  assert.ok(decision !== undefined);
  assert.equal(decision.topic, '材料');
  assert.equal(decision.choice, '木构。');
  assert.deepEqual(decision.requirementIds, ['req-known']);
  const dropped = warnings.filter((warning) => warning.code === 'requirement-reference-dropped');
  assert.equal(dropped.length, 1);
  const droppedWarning = dropped[0];
  assert.ok(droppedWarning !== undefined);
  assert.equal(droppedWarning.path, 'decisions.dec-bad.requirementIds');
  assert.match(droppedWarning.message, /dec-bad/);
  assert.match(droppedWarning.message, /req-missing/);
  assert.match(droppedWarning.message, /不影响几何展开/);
  const brief = compileBuildBrief(scheme);
  assert.deepEqual(lintBrief(brief), []);
  assert.match(compileDesignReport(scheme), /稻田茶亭/);
});

test('决策 requirementIds 全部不存在时清空引用并保留决策，仍成功展开', () => {
  const intent = teaIntent();
  intent['decisions'] = [
    {
      id: 'dec-all-missing',
      topic: '材料',
      choice: '木构。',
      rationale: '与已删除的需求一致。',
      source: 'agent',
      requirementIds: ['req-gone-a', 'req-gone-b'],
    },
  ];

  const { scheme, warnings } = expandDesignIntent(intent, {
    ...host('scheme-decision-all-missing'),
    requirementIds: ['req-known'],
  });
  const decision = scheme.decisions.find((item) => item.id === 'dec-all-missing');
  assert.ok(decision !== undefined);
  assert.deepEqual(decision.requirementIds, []);
  assert.equal(decision.topic, '材料');
  const dropped = warnings.find((warning) => warning.code === 'requirement-reference-dropped');
  assert.ok(dropped !== undefined);
  assert.equal(dropped.path, 'decisions.dec-all-missing.requirementIds');
  assert.match(dropped.message, /req-gone-a/);
  assert.match(dropped.message, /req-gone-b/);
  assert.deepEqual(lintBrief(compileBuildBrief(scheme)), []);
  assert.match(compileDesignReport(scheme), /稻田茶亭/);
});

test('真实失败形态：dec-material 引用 pref-color-muted 时丢弃标签但保留决策', () => {
  const intent = teaIntent();
  intent['decisions'] = [
    {
      id: 'dec-material',
      topic: '材料',
      choice: '深色木搭配浅灰石。',
      rationale: '参考已改名的配色需求。',
      source: 'agent',
      requirementIds: ['req-known', 'pref-color-muted'],
    },
  ];

  const { scheme, warnings } = expandDesignIntent(intent, {
    ...host('scheme-decision-material-ref'),
    requirementIds: ['req-known'],
  });
  const decision = scheme.decisions.find((item) => item.id === 'dec-material');
  assert.ok(decision !== undefined);
  assert.deepEqual(decision.requirementIds, ['req-known']);
  const dropped = warnings.find((warning) => warning.code === 'requirement-reference-dropped');
  assert.ok(dropped !== undefined);
  assert.equal(dropped.path, 'decisions.dec-material.requirementIds');
  assert.match(dropped.message, /pref-color-muted/);
  assert.match(dropped.message, /不影响几何展开/);
  assert.deepEqual(lintBrief(compileBuildBrief(scheme)), []);
  assert.match(compileDesignReport(scheme), /稻田茶亭/);
});

test('两层住宅：楼板、楼梯占位、共享墙去重', () => {
  const { scheme, facts } = expandDesignIntent(houseIntent(), host('scheme-house'));
  assert.equal(facts.counts.levels, 2);
  assert.equal(facts.counts.sharedWalls, 2);
  assert.equal(
    facts.counts.sharedWalls,
    new Set(
      scheme.elements
        .filter((element) => element.kind === 'wall' && element.spaceId === null)
        .map((element) => JSON.stringify(element.bounds)),
    ).size,
  );
  assert.equal(facts.counts.slabs, 4);
  assert.equal(facts.counts.stairs, 1);
  assert.equal(scheme.elements.filter((element) => element.kind === 'stair').length, 1);
  const route = scheme.circulation.find((item) => item.kind === 'stair');
  assert.ok(route !== undefined);
  assert.equal(route.fromSpaceId, 'living');
  assert.equal(route.toSpaceId, 'bed1');
  assert.equal(scheme.interiors.length, 4);
  assert.ok(scheme.interiors.every((interior) => interior.furnitureSpecs.length === 1));
  const brief = compileBuildBrief(scheme);
  assert.deepEqual(lintBrief(brief), []);
});

test('小院与室外家具：分区正面积、家具在分区内、外墙不覆盖分区', () => {
  const { scheme, facts, warnings } = expandDesignIntent(courtyardIntent(), host('scheme-court'));
  assert.equal(facts.counts.rooms, 1);
  assert.equal(scheme.spaces.filter((space) => space.kind === 'outdoor').length, 2);
  assert.equal(scheme.site.outdoorZones.length, 2);
  const terrace = scheme.site.outdoorZones.find((zone) => zone.id === 'zone-terrace');
  assert.ok(terrace !== undefined);
  assert.equal(boundsWithin(terrace.bounds, scheme.site.bounds), true);
  const interior = scheme.interiors.find((item) => item.spaceId === 'zone-terrace');
  const furniture = interior?.furnitureSpecs[0];
  assert.ok(furniture !== undefined);
  assert.equal(boundsWithin(furniture.bounds, terrace.bounds), true);
  assert.ok(
    scheme.elements
      .filter((element) => element.kind === 'wall')
      .every((element) => !boundsOverlap(element.bounds, terrace.bounds)),
  );
  assert.ok(warnings.some((warning) => warning.code === 'interior-furniture-missing'));
  const brief = compileBuildBrief(scheme);
  assert.deepEqual(lintBrief(brief), []);
  assert.ok(renderPreviewBundle(scheme).files.length >= 5);
});

test('真实失败形态：共享边被写 exterior 仍派生 shared，保留材质覆盖并记录 warning', () => {
  // 房间布局取自 .work/r2-live-tea-2026-10-19T16-01-47-338Z/intent.draft.raw.json；
  // 显式把 room-hall:east / room-storage:west 写成 exterior，复现真实 wall-kind-conflict。
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-wall-kind-conflict.json', import.meta.url), 'utf8'),
  ) as unknown;
  const intent = DesignIntent.parse(raw);
  const { scheme, facts, warnings } = expandDesignIntent(intent, host('scheme-wall-kind'));

  assert.equal(facts.counts.sharedWalls, 3);
  assert.equal(warnings.filter((warning) => warning.code === 'wall-kind-ignored').length, 2);
  assert.equal(
    warnings.some((warning) => warning.code === 'wall-kind-conflict'),
    false,
  );

  const shared = scheme.elements.find(
    (element) => element.kind === 'wall' && element.name.includes('茶亭主厅 / 储物间'),
  );
  assert.ok(shared !== undefined);
  assert.equal(shared.spaceId, null);
  assert.equal(shared.material, 'mat-wood-column');

  const exterior = scheme.elements.find((element) => element.kind === 'wall' && element.name === '茶亭主厅 南外墙');
  assert.ok(exterior !== undefined);
  assert.equal(exterior.material, 'mat-wood-column');
});

test('L 形顶层自动分解为 2 段屋面，elements / lint / preview 通过', () => {
  const { scheme, warnings } = expandDesignIntent(lShapeIntent(), host('scheme-l-roof'));
  const roofs = scheme.elements.filter((element) => element.kind === 'roof');
  assert.equal(roofs.length, 2);
  assert.equal(scheme.roof.segments?.length, 2);
  assert.equal(
    warnings.some((warning) => warning.code === 'multi-roof-mvp'),
    true,
  );
  assert.equal(new Set(roofs.map((roof) => roof.bounds.min[1])).size, 1);
  const brief = compileBuildBrief(scheme);
  assert.deepEqual(lintBrief(brief), []);
  assert.ok(renderPreviewBundle(scheme).files.length >= 5);
  assert.match(compileDesignReport(scheme), /多段屋面：共 2 段/);
});

test('L 形平屋面自动分解为 2 段，不伪造屋脊', () => {
  const base = lShapeIntent();
  const roof = base['roof'] as Record<string, unknown>;
  roof['form'] = 'flat';
  Reflect.deleteProperty(roof, 'pitchDegrees');
  const { scheme } = expandDesignIntent(base, host('scheme-l-flat'));
  assert.equal(scheme.roof.form, 'flat');
  const segments = scheme.roof.segments;
  assert.ok(segments !== undefined);
  assert.equal(segments.length, 2);
  assert.equal(
    segments.every(
      (segment) => segment.form === 'flat' && segment.pitchDegrees === 0 && segment.ridgeHeight === segment.eaveHeight,
    ),
    true,
  );
});

test('显式 roof.segments 按给定分段展开，主屋面取面积最大段', () => {
  const base = lShapeIntent();
  const roof = base['roof'] as Record<string, unknown>;
  roof['segments'] = [
    {
      id: 'r-west',
      rect: { x: [3, 11], z: [3, 9] },
      form: 'gable',
      materialId: 'mat-roof',
      pitchDegrees: 30,
      overhang: 1,
    },
    {
      id: 'r-east',
      rect: { x: [11, 15], z: [3, 7] },
      form: 'shed',
      materialId: 'mat-roof',
      pitchDegrees: 20,
      overhang: 1,
    },
  ];
  const { scheme, warnings } = expandDesignIntent(base, host('scheme-l-explicit'));
  assert.equal(scheme.elements.filter((element) => element.kind === 'roof').length, 2);
  assert.deepEqual(
    scheme.roof.segments?.map((segment) => segment.id),
    ['r-west', 'r-east'],
  );
  assert.equal(scheme.roof.form, 'gable');
  assert.equal(
    warnings.some((warning) => warning.code === 'multi-roof-mvp'),
    true,
  );
});

test('屋面段重叠 / 越界 / 面积不完整都明确失败', () => {
  const overlap = lShapeIntent();
  (overlap['roof'] as Record<string, unknown>)['segments'] = [
    { id: 'a', rect: { x: [3, 11], z: [3, 9] }, form: 'gable', materialId: 'mat-roof', pitchDegrees: 30, overhang: 1 },
    { id: 'b', rect: { x: [5, 13], z: [4, 8] }, form: 'gable', materialId: 'mat-roof', pitchDegrees: 30, overhang: 1 },
  ];
  assert.throws(() => DesignIntent.parse(overlap), /重叠/);

  const outside = lShapeIntent();
  (outside['roof'] as Record<string, unknown>)['segments'] = [
    { id: 'a', rect: { x: [3, 17], z: [3, 9] }, form: 'gable', materialId: 'mat-roof', pitchDegrees: 30, overhang: 1 },
  ];
  assert.throws(() => DesignIntent.parse(outside), /超出场地范围/);

  const incomplete = lShapeIntent();
  (incomplete['roof'] as Record<string, unknown>)['segments'] = [
    { id: 'a', rect: { x: [3, 11], z: [3, 9] }, form: 'gable', materialId: 'mat-roof', pitchDegrees: 30, overhang: 1 },
  ];
  assert.throws(() => expandDesignIntent(incomplete, host('scheme-l-incomplete')), /面积与顶层房间并集不一致/);
});

test('真实失败形态：同墙段重叠窗合并为 union，lint / preview 通过', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-opening-conflict.json', import.meta.url), 'utf8'),
  ) as unknown;
  const { scheme, warnings } = expandDesignIntent(raw, host('scheme-opening-merge'));
  const south = scheme.openings.filter((opening) => opening.side === 'south');
  assert.equal(south.length, 1);
  const merged = south[0];
  assert.ok(merged !== undefined);
  assert.equal(merged.id, 'op-south-win');
  assert.equal(merged.bounds.max[0] - merged.bounds.min[0], 4);
  assert.equal(
    warnings.some((warning) => warning.code === 'opening-merged'),
    true,
  );
  const brief = compileBuildBrief(scheme);
  assert.deepEqual(lintBrief(brief), []);
  assert.ok(renderPreviewBundle(scheme).files.length >= 5);
});

test('入口 offset 越界时 clamp 到墙段合法区间，并记录 opening-clamped', () => {
  const base = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-opening-conflict.json', import.meta.url), 'utf8'),
  ) as { openings: Record<string, unknown>[] };
  const entry = base.openings[0];
  if (entry === undefined) throw new Error('fixture 缺少入口');
  entry['offset'] = 0;
  entry['width'] = 2;
  const { scheme, warnings } = expandDesignIntent(base, host('scheme-opening-clamp'));
  const resolved = scheme.openings.find((opening) => opening.id === 'op-entry');
  assert.ok(resolved !== undefined);
  assert.equal(resolved.bounds.min[0], 3);
  assert.equal(
    warnings.some((warning) => warning.code === 'opening-clamped'),
    true,
  );
  const brief = compileBuildBrief(scheme);
  assert.deepEqual(lintBrief(brief), []);
  assert.ok(renderPreviewBundle(scheme).files.length >= 5);
});

test('门 + 窗重叠：保留门，窗缩窄到剩余墙段', () => {
  const base = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-opening-conflict.json', import.meta.url), 'utf8'),
  ) as { openings: Record<string, unknown>[] };
  const first = base.openings[1];
  if (first === undefined) throw new Error('fixture 缺少南侧洞口');
  first['id'] = 'op-south-door';
  first['name'] = '南侧内门';
  first['kind'] = 'door';
  first['role'] = 'interior';
  first['sill'] = 0;
  const { scheme, warnings } = expandDesignIntent(base, host('scheme-opening-door'));
  assert.ok(scheme.openings.some((opening) => opening.id === 'op-south-door'));
  const window = scheme.openings.find((opening) => opening.id === 'op-south-glass');
  assert.ok(window !== undefined);
  assert.equal(window.bounds.max[0] - window.bounds.min[0], 2);
  assert.equal(
    warnings.some((warning) => warning.code === 'opening-shrunk'),
    true,
  );
});

test('同一 intent 两次展开逐字节相同', () => {
  const first = expandDesignIntent(teaIntent(), host('scheme-tea'));
  const second = expandDesignIntent(teaIntent(), host('scheme-tea'));
  assert.equal(JSON.stringify(first.scheme), JSON.stringify(second.scheme));
  assert.equal(JSON.stringify(first.facts), JSON.stringify(second.facts));
  assert.equal(JSON.stringify(first.warnings), JSON.stringify(second.warnings));
});
