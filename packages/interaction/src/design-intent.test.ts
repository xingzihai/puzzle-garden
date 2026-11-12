import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DesignIntent } from './design-intent.ts';

function validIntent(): Record<string, unknown> {
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
    facades: [
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
    ],
    materials: [
      { id: 'mat-stone', name: '石', block: 'stone_bricks', role: 'structure', color: '#9a9a92', notes: null },
      { id: 'mat-wood', name: '木', block: 'dark_oak_planks', role: 'structure', color: '#4d3424', notes: null },
      { id: 'mat-roof', name: '瓦', block: 'deepslate_tiles', role: 'roof', color: '#3f4145', notes: null },
      { id: 'mat-glass', name: '玻璃', block: 'glass', role: 'glass', color: '#b8d4d6', notes: null },
      { id: 'mat-fabric', name: '织物', block: 'white_wool', role: 'furniture', color: '#e8e1d4', notes: null },
      { id: 'mat-grass', name: '草地', block: 'grass_block', role: 'landscape', color: '#6f8f4a', notes: null },
    ],
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

function errors(value: unknown): string {
  const result = DesignIntent.safeParse(value);
  if (result.success) throw new Error('期望解析失败，但通过了');
  return result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('；');
}

test('合法 intent 通过 strict schema，role 缺省为 interior', () => {
  const parsed = DesignIntent.parse(validIntent());
  assert.equal(parsed.program.rooms[0]?.rect.x[1], 11);
  assert.equal(parsed.openings[1]?.role, 'interior');
  assert.equal(parsed.facades[0]?.topMaterialId, null);
  assert.equal(Object.isFrozen(parsed.site), true);
});

test('严格拒绝顶层与嵌套未知字段', () => {
  assert.match(errors({ ...validIntent(), budget: { maxBlocks: 100 } }), /unrecognized key|Unrecognized key/i);
  const intent = validIntent();
  const meta = { ...(intent['meta'] as object), status: 'draft' };
  assert.match(errors({ ...intent, meta }), /unrecognized key|Unrecognized key/i);
});

test('室外分区与房间重叠不再由 schema 拒绝，交给宿主丢弃并警告', () => {
  const intent = validIntent();
  const site = intent['site'] as { outdoorZones: { rect: { x: number[]; z: number[] } }[] };
  site.outdoorZones[0]!.rect = { x: [5, 11], z: [7, 10] };
  const parsed = DesignIntent.parse(intent);
  assert.deepEqual(parsed.site.outdoorZones[0]?.rect, { x: [5, 11], z: [7, 10] });
});

test('室外分区超出场地范围仍然失败', () => {
  const intent = validIntent();
  const site = intent['site'] as { outdoorZones: { rect: { x: number[]; z: number[] } }[] };
  site.outdoorZones[0]!.rect = { x: [5, 18], z: [9, 12] };
  assert.match(errors(intent), /场地区域 zone-terrace 超出场地范围/);
});

test('零面积室外分区直接失败', () => {
  const intent = validIntent();
  const site = intent['site'] as { outdoorZones: { rect: { x: number[]; z: number[] } }[] };
  site.outdoorZones[0]!.rect.z = [9, 9];
  assert.match(errors(intent), /矩形 z 必须 z1 > z0/);
});

test('洞口越界交给 expand clamp；缺失房间引用仍拒绝', () => {
  const opening = validIntent();
  const openingList = opening['openings'] as { offset: number; width: number }[];
  openingList[0]!.offset = 7;
  openingList[0]!.width = 2;
  assert.equal(DesignIntent.safeParse(opening).success, true);

  const furniture = validIntent();
  const furnitureList = furniture['furniture'] as { footprint: { x: number; z: number } }[];
  furnitureList[0]!.footprint = { x: 20, z: 20 };
  assert.equal(DesignIntent.safeParse(furniture).success, true);

  const missing = validIntent();
  const missingList = missing['furniture'] as { roomId: string }[];
  missingList[0]!.roomId = 'missing';
  assert.match(errors(missing), /不存在的房间或室外分区 missing/);
});
