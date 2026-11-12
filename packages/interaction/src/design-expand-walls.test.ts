import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { DesignIntent } from './design-intent.ts';
import { buildEnvelope } from './design-expand-walls.ts';
import type { Level, Room } from './design-expand-types.ts';

function minimalIntent(): Record<string, unknown> {
  return {
    meta: { title: '墙段测试', concept: '单房间测试。', scope: 'exterior+entry' },
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
    furniture: [],
    decisions: [],
    open: [],
  };
}

function parts(intent: DesignIntent): { levels: readonly Level[]; rooms: readonly Room[] } {
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
  return { levels, rooms };
}

test('单房间生成四面外墙，洞口挂到完整墙段', () => {
  const intent = DesignIntent.parse(minimalIntent());
  const { levels, rooms } = parts(intent);
  const result = buildEnvelope(intent, levels, rooms, 'mat-structure', () => undefined);
  assert.equal(result.walls.length, 4);
  assert.equal(
    result.walls.every((wall) => wall.exterior),
    true,
  );
  assert.equal(result.exteriorSides.size, 4);
  assert.equal(result.openings[0]?.host, result.walls.find((wall) => wall.bounds.max[2] === 8)?.id);
  assert.deepEqual(result.openings[0]?.bounds, { min: [4, 1, 7], max: [6, 3, 8] });
});

test('2 格短墙上的 entrance 迁移到长墙并记录 warning', () => {
  const base = minimalIntent();
  const program = base['program'] as { rooms: Record<string, unknown>[] };
  const room = program.rooms[0];
  if (room === undefined) throw new Error('缺少房间');
  room['rect'] = { x: [2, 4], z: [2, 8] };
  const intent = DesignIntent.parse(base);
  const { levels, rooms } = parts(intent);
  const warnings: { code: string; message: string }[] = [];
  const result = buildEnvelope(intent, levels, rooms, 'mat-structure', (code, message) =>
    warnings.push({ code, message }),
  );
  const entrance = result.openings.find((opening) => opening.id === 'door');
  assert.ok(entrance !== undefined);
  assert.equal(entrance.side, 'east');
  const relocated = warnings.find((warning) => warning.code === 'opening-relocated-short-wall');
  assert.ok(relocated !== undefined);
  assert.match(relocated.message, /原 south/);
  assert.match(relocated.message, /迁移到 east/);
});

test('所有外墙都太短时 entrance 明确失败并列出可用墙段', () => {
  const base = minimalIntent();
  const program = base['program'] as { rooms: Record<string, unknown>[] };
  const room = program.rooms[0];
  if (room === undefined) throw new Error('缺少房间');
  room['rect'] = { x: [2, 4], z: [2, 4] };
  const intent = DesignIntent.parse(base);
  const { levels, rooms } = parts(intent);
  assert.throws(
    () => buildEnvelope(intent, levels, rooms, 'mat-structure', () => undefined),
    (error: unknown) =>
      error instanceof Error && error.message.includes('所有外墙都放不下') && error.message.includes('north 长2/可用0'),
  );
});

test('共享墙无显式材质 + 多个 wall 材质：按同侧 facade body 回退并 warning', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-wall-kind-conflict.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown> & {
    envelope: { walls: { roomId: string; side: string; materialId?: string }[] };
    materials: { id: string; name: string; block: string; role: string; color?: string; notes: null }[];
  };
  for (const wall of raw.envelope.walls) {
    if (
      (wall.roomId === 'room-hall' && wall.side === 'east') ||
      (wall.roomId === 'room-storage' && wall.side === 'west')
    ) {
      delete wall.materialId;
    }
  }
  raw.materials.push({
    id: 'mat-wall-alt',
    name: '备用墙材',
    block: 'smooth_stone',
    role: 'wall',
    color: '#aaaaaa',
    notes: null,
  });
  const intent = DesignIntent.parse(raw);
  const { levels, rooms } = parts(intent);
  const warnings: { code: string; message: string; path?: string }[] = [];
  const result = buildEnvelope(intent, levels, rooms, 'mat-structure', (code, message, path) => {
    warnings.push(path === undefined ? { code, message } : { code, message, path });
  });
  const shared = result.elements.find(
    (element) => element.kind === 'wall' && element.name.includes('茶亭主厅 / 储物间'),
  );
  assert.ok(shared !== undefined);
  assert.equal(shared.material, 'mat-stone-wall');
  assert.equal(
    warnings.some(
      (warning) =>
        warning.code === 'default-wall-material' &&
        warning.message.includes('room-hall:east') &&
        warning.message.includes('mat-stone-wall') &&
        warning.message.includes('facade east bodyMaterialId'),
    ),
    true,
  );
});

test('无 facade / 无 wall 材质：按唯一 structure 回退', () => {
  const base = minimalIntent();
  base['facades'] = [];
  const materials = base['materials'] as { id: string; role: string }[];
  const wall = materials.find((material) => material.id === 'mat-wall');
  if (wall === undefined) throw new Error('缺少 mat-wall');
  wall.role = 'trim';
  const intent = DesignIntent.parse(base);
  const { levels, rooms } = parts(intent);
  const warnings: { code: string; message: string }[] = [];
  const result = buildEnvelope(intent, levels, rooms, 'mat-structure', (code, message) => {
    warnings.push({ code, message });
  });
  assert.equal(
    result.elements
      .filter((element) => element.kind === 'wall')
      .every((element) => element.material === 'mat-structure'),
    true,
  );
  assert.equal(
    warnings.some(
      (warning) =>
        warning.code === 'default-wall-material' &&
        warning.message.includes('mat-structure') &&
        warning.message.includes('role=structure 唯一'),
    ),
    true,
  );
});

test('无 facade / wall / structure：按 id 排序回退', () => {
  const base = minimalIntent();
  base['facades'] = [];
  const materials = base['materials'] as { id: string; role: string }[];
  for (const material of materials) {
    if (material.role === 'wall' || material.role === 'structure') material.role = 'trim';
  }
  const intent = DesignIntent.parse(base);
  const { levels, rooms } = parts(intent);
  const warnings: { code: string; message: string }[] = [];
  const result = buildEnvelope(intent, levels, rooms, 'mat-structure', (code, message) => {
    warnings.push({ code, message });
  });
  assert.equal(
    result.elements.filter((element) => element.kind === 'wall').every((element) => element.material === 'mat-floor'),
    true,
  );
  assert.equal(
    warnings.some(
      (warning) =>
        warning.code === 'default-wall-material' &&
        warning.message.includes('mat-floor') &&
        warning.message.includes('按 id 排序回退'),
    ),
    true,
  );
});

test('完全没有材质时明确报错', () => {
  const parsed = DesignIntent.parse(minimalIntent());
  const intent = { ...parsed, materials: [] } as DesignIntent;
  const { levels, rooms } = parts(intent);
  assert.throws(() => buildEnvelope(intent, levels, rooms, undefined, () => undefined), /没有任何可用材质/);
});
