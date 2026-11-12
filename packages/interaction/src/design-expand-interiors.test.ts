import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { DesignIntent } from './design-intent.ts';
import { buildEnvelope } from './design-expand-walls.ts';
import { buildInteriors } from './design-expand-interiors.ts';
import type { Level, Room, Wall } from './design-expand-types.ts';

function intentWithFurniture(): Record<string, unknown> {
  return {
    meta: { title: '家具测试', concept: '单房间家具测试。', scope: 'exterior+interior' },
    site: {
      bounds: { x: [0, 12], z: [0, 12] },
      orientation: 'south',
      entrance: { side: 'south', notes: null },
      outdoorZones: [],
      notes: null,
    },
    program: {
      levels: [{ id: 'f1', name: '首层', height: 3, floorMaterialId: 'mat-floor' }],
      rooms: [
        {
          id: 'room',
          name: '房间',
          level: 'f1',
          kind: 'room',
          rect: { x: [2, 8], z: [2, 8] },
          occupancy: 1,
          adjacency: [],
          daylight: 'preferred',
          notes: null,
        },
      ],
    },
    envelope: { wallDefaults: { exteriorThickness: 1, interiorThickness: 1 }, walls: [], stairs: [] },
    openings: [
      {
        id: 'door',
        name: '门',
        roomId: 'room',
        side: 'south',
        kind: 'door',
        role: 'entrance',
        offset: 2,
        width: 2,
        height: 2,
        sill: 0,
        fill: '木门',
        frameMaterial: 'mat-wall',
      },
    ],
    structure: { system: 'frame', materialId: 'mat-structure', floorThickness: 1, notes: null },
    roof: { form: 'flat', materialId: 'mat-roof', overhang: 0, drainage: null, skylights: [], notes: null },
    facades: [
      { side: 'north', baseMaterialId: 'mat-wall', bodyMaterialId: 'mat-wall', topMaterialId: null, notes: null },
      { side: 'south', baseMaterialId: 'mat-wall', bodyMaterialId: 'mat-wall', topMaterialId: null, notes: null },
      { side: 'east', baseMaterialId: 'mat-wall', bodyMaterialId: 'mat-wall', topMaterialId: null, notes: null },
      { side: 'west', baseMaterialId: 'mat-wall', bodyMaterialId: 'mat-wall', topMaterialId: null, notes: null },
    ],
    materials: [
      { id: 'mat-floor', name: '地面', block: 'stone_bricks', role: 'floor', notes: null },
      { id: 'mat-structure', name: '结构', block: 'oak_planks', role: 'structure', notes: null },
      { id: 'mat-wall', name: '墙', block: 'smooth_sandstone', role: 'wall', notes: null },
      { id: 'mat-roof', name: '屋面', block: 'deepslate_tiles', role: 'roof', notes: null },
    ],
    furniture: [
      {
        id: 'table',
        name: '桌',
        kind: 'table',
        roomId: 'room',
        anchor: { kind: 'center' },
        footprint: { x: 2, z: 1 },
        orientation: null,
        materialId: 'mat-structure',
        notes: null,
      },
    ],
    decisions: [],
    open: [],
  };
}

function buildFurniture(base: Record<string, unknown>): {
  readonly specs: readonly {
    readonly bounds: { min: readonly [number, number, number]; max: readonly [number, number, number] };
  }[];
  readonly warnings: readonly string[];
} {
  const intent = DesignIntent.parse(base);
  const levels: Level[] = intent.program.levels.map((level) => ({
    id: level.id,
    name: level.name,
    elevation: level.elevation ?? 1,
    height: level.height,
    floorMaterialId: level.floorMaterialId,
  }));
  const level = levels[0];
  if (level === undefined) throw new Error('缺少楼层');
  const rooms: Room[] = intent.program.rooms.map((room) => ({
    intent: room,
    level,
    rect: room.rect,
    bounds: {
      min: [room.rect.x[0], level.elevation, room.rect.z[0]],
      max: [room.rect.x[1], level.elevation + level.height, room.rect.z[1]],
    },
  }));
  const envelope = buildEnvelope(intent, levels, rooms, 'mat-structure', () => undefined);
  const warnings: string[] = [];
  const result = buildInteriors(intent, rooms, envelope.walls, 0, 'mat-structure', (code) => warnings.push(code));
  return { specs: result.interiors[0]?.furnitureSpecs ?? [], warnings };
}

test('f-shelf 放不下时换 anchor / 缩小 footprint 并记录 warning', () => {
  const base = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-furniture-fit.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const { specs, warnings } = buildFurniture(base);
  assert.equal(specs.length, 1);
  const bounds = specs[0]?.bounds;
  assert.ok(bounds !== undefined);
  assert.ok(bounds.min[0] >= 3 && bounds.max[0] <= 7);
  assert.ok(bounds.min[2] >= 3 && bounds.max[2] <= 7);
  assert.ok(warnings.includes('furniture-shrunk'));
  assert.ok(warnings.includes('furniture-relocated'));
});

test('家具被既有家具占满时普通家具可丢弃并记录 warning', () => {
  const base = intentWithFurniture();
  const furniture = base['furniture'] as Record<string, unknown>[];
  furniture[0] = {
    id: 'table',
    name: '大桌',
    kind: 'table',
    roomId: 'room',
    anchor: { kind: 'center' },
    footprint: { x: 4, z: 4 },
    orientation: null,
    materialId: 'mat-structure',
    notes: null,
  };
  furniture.push({
    id: 'f-extra',
    name: '备用架',
    kind: 'shelf',
    roomId: 'room',
    anchor: { kind: 'center' },
    footprint: { x: 2, z: 2 },
    orientation: null,
    height: 2,
    materialId: 'mat-structure',
    notes: null,
  });
  const { specs, warnings } = buildFurniture(base);
  assert.equal(specs.length, 1);
  assert.ok(warnings.includes('furniture-dropped'));
});

test('房间净尺寸连 1×1 都放不下时明确失败', () => {
  const intent = DesignIntent.parse(intentWithFurniture());
  const level: Level = {
    id: 'f1',
    name: '首层',
    elevation: 1,
    height: 3,
    floorMaterialId: 'mat-floor',
  };
  const room: Room = {
    intent: intent.program.rooms[0]!,
    level,
    rect: { x: [2, 4], z: [2, 8] },
    bounds: { min: [2, 1, 2], max: [4, 4, 8] },
  };
  const west: Wall = {
    id: 'w-west',
    axis: 'z',
    exterior: true,
    thickness: 1,
    bounds: { min: [2, 1, 2], max: [3, 4, 8] },
    roomSides: new Map([['room', 'west']]),
    intrusions: new Map([['room', 1]]),
  };
  const east: Wall = {
    id: 'w-east',
    axis: 'z',
    exterior: true,
    thickness: 1,
    bounds: { min: [3, 1, 2], max: [4, 4, 8] },
    roomSides: new Map([['room', 'east']]),
    intrusions: new Map([['room', 1]]),
  };
  assert.throws(
    () => buildInteriors(intent, [room], [west, east], 0, 'mat-structure', () => undefined),
    /连 1×1 家具都放不下/,
  );
});

test('中心锚点在家具可用内矩形内展开，缺失家具的室内记 warning', () => {
  const intent = DesignIntent.parse(intentWithFurniture());
  const levels: Level[] = intent.program.levels.map((level) => ({
    id: level.id,
    name: level.name,
    elevation: level.elevation ?? 1,
    height: level.height,
    floorMaterialId: level.floorMaterialId,
  }));
  const level = levels[0];
  if (level === undefined) throw new Error('缺少楼层');
  const rooms: Room[] = intent.program.rooms.map((room) => ({
    intent: room,
    level,
    rect: room.rect,
    bounds: {
      min: [room.rect.x[0], level.elevation, room.rect.z[0]],
      max: [room.rect.x[1], level.elevation + level.height, room.rect.z[1]],
    },
  }));
  const envelope = buildEnvelope(intent, levels, rooms, 'mat-structure', () => undefined);
  const warnings: string[] = [];
  const result = buildInteriors(intent, rooms, envelope.walls, 0, 'mat-structure', (code) => warnings.push(code));
  assert.equal(result.interiors.length, 1);
  const interior = result.interiors[0]!;
  assert.equal(interior.furnitureSpecs.length, 1);
  assert.deepEqual(interior.furnitureSpecs[0]!.bounds, { min: [4, 1, 4], max: [6, 2, 5] });
  assert.deepEqual(warnings, []);
});
