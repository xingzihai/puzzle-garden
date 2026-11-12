/**
 * DesignIntent：模型只写设计意图，几何展开、ID 注入、面积与计数由宿主负责。
 *
 * 负责：严格 schema、矩形 / 房间 / 洞口 / 家具的可定位校验、宿主上下文与展开错误类型。
 * 不负责：DesignScheme 生成（design-expand.ts）、读文件、调用模型或任何 I/O。
 *
 * 坐标：x 向东、z 向南，单位格；y 不进入 intent，由楼层标高派生。
 * Rect2 为半开区间 `{ x:[x0,x1], z:[z0,z1] }`，两轴都必须正面积。
 */
import { Y_MAX, Y_MIN } from '@pg/core/coord';
import { z } from 'zod';

import { ColorHex, Identifier, Label, Note, Text } from './primitives.ts';
import { FurnitureKind, MaterialRole, OpeningKind, SchemeScope, Side, StructureSystem } from './scheme.ts';
import { Coord, rectSharedEdgeLength, rectsOverlap, rectWithin, Rect2, stairRect } from './design-intent-support.ts';

export {
  decomposeRectUnion,
  IntentValidationError,
  rectArea,
  rectDepth,
  rectSharedEdgeLength,
  rectsOverlap,
  rectWidth,
  rectWithin,
  Rect2,
  stairRect,
} from './design-intent-support.ts';
export type { DesignHostContext, IntentValidationCode } from './design-intent-support.ts';

const IntentMeta = z
  .strictObject({
    title: z.string().min(1).max(200),
    concept: Text,
    scope: SchemeScope,
  })
  .readonly();

const OutdoorKind = z.enum(['garden', 'terrace', 'path', 'parking', 'service', 'water', 'other']);

export const IntentOutdoorZone = z
  .strictObject({
    id: Identifier,
    name: Label,
    kind: OutdoorKind,
    rect: Rect2,
    materialId: Identifier,
    notes: Note,
  })
  .readonly();
export type IntentOutdoorZone = z.infer<typeof IntentOutdoorZone>;

const IntentEntrance = z
  .strictObject({
    side: Side,
    notes: Note.optional(),
  })
  .readonly();

const IntentSite = z
  .strictObject({
    bounds: Rect2,
    orientation: z.enum(['north', 'east', 'south', 'west', 'unknown']),
    entrance: IntentEntrance,
    outdoorZones: z.array(IntentOutdoorZone).max(50).readonly(),
    notes: Note,
  })
  .readonly();

export const IntentLevel = z
  .strictObject({
    id: Identifier,
    name: Label,
    height: z.int().min(1).max(100),
    floorMaterialId: Identifier,
    elevation: z.int().min(Y_MIN).max(Y_MAX).optional(),
  })
  .readonly();
export type IntentLevel = z.infer<typeof IntentLevel>;

export const IntentRoom = z
  .strictObject({
    id: Identifier,
    name: Label,
    level: Identifier,
    kind: z.enum(['room', 'service', 'circulation']),
    rect: Rect2,
    areaM2: z.number().positive().max(1_000_000).optional(),
    occupancy: z.int().min(0).max(500),
    adjacency: z.array(Identifier).max(50).readonly(),
    daylight: z.enum(['required', 'preferred', 'none']),
    notes: Note,
  })
  .readonly();
export type IntentRoom = z.infer<typeof IntentRoom>;

const IntentProgram = z
  .strictObject({
    levels: z.array(IntentLevel).min(1).max(64).readonly(),
    rooms: z.array(IntentRoom).min(1).max(500).readonly(),
  })
  .readonly();

export const IntentWall = z
  .strictObject({
    roomId: Identifier,
    side: Side,
    kind: z.enum(['auto', 'exterior', 'interior', 'none']),
    thickness: z.int().min(1).max(8).optional(),
    materialId: Identifier.optional(),
  })
  .readonly();
export type IntentWall = z.infer<typeof IntentWall>;

export const IntentStair = z
  .strictObject({
    id: Identifier,
    name: Label,
    roomId: Identifier,
    fromLevel: Identifier,
    toLevel: Identifier,
    start: z.strictObject({ x: Coord, z: Coord }).readonly(),
    direction: Side,
    width: z.int().min(1).max(32),
    treads: z.int().min(2).max(100),
    materialId: Identifier.optional(),
  })
  .readonly();
export type IntentStair = z.infer<typeof IntentStair>;

const IntentEnvelope = z
  .strictObject({
    wallDefaults: z
      .strictObject({
        exteriorThickness: z.int().min(1).max(8).optional(),
        interiorThickness: z.int().min(1).max(8).optional(),
      })
      .readonly()
      .optional(),
    walls: z.array(IntentWall).max(2000).readonly(),
    /** 单层建筑可以省略；默认没有楼梯。 */
    stairs: z.array(IntentStair).max(20).readonly().default([]),
  })
  .readonly();

export const IntentOpening = z
  .strictObject({
    id: Identifier,
    name: Label,
    roomId: Identifier,
    side: Side,
    kind: OpeningKind,
    role: z.enum(['entrance', 'interior', 'service']).default('interior'),
    offset: z.int().min(0),
    width: z.int().min(1),
    height: z.int().min(1),
    sill: z.int().min(0),
    fill: Label,
    frameMaterial: Identifier.nullable().default(null),
  })
  .readonly();
export type IntentOpening = z.infer<typeof IntentOpening>;

const IntentStructure = z
  .strictObject({
    system: StructureSystem,
    materialId: Identifier,
    floorThickness: z.int().min(1).max(8).optional(),
    cantilever: z.int().min(0).max(50).optional(),
    notes: Note,
  })
  .readonly();

export const IntentRoofSegment = z
  .strictObject({
    id: Identifier,
    rect: Rect2,
    form: z.enum(['flat', 'gable', 'hip', 'shed']),
    materialId: Identifier,
    pitchDegrees: z.number().min(0).max(90).optional(),
    overhang: z.int().min(0).max(50),
  })
  .readonly();
export type IntentRoofSegment = z.infer<typeof IntentRoofSegment>;

const IntentRoof = z
  .strictObject({
    form: z.enum(['flat', 'gable', 'hip', 'shed']),
    materialId: Identifier,
    pitchDegrees: z.number().min(0).max(90).optional(),
    overhang: z.int().min(0).max(50),
    ridgeAxis: z.enum(['x', 'z']).optional(),
    drainage: z.string().min(1).max(128).nullable(),
    skylights: z.array(Label).max(20).readonly(),
    notes: Note,
    /** 可选显式分段；省略时宿主按顶层房间并集自动分解。 */
    segments: z.array(IntentRoofSegment).min(1).max(20).readonly().optional(),
  })
  .readonly();

const IntentFacade = z
  .strictObject({
    side: Side,
    baseMaterialId: Identifier,
    bodyMaterialId: Identifier,
    topMaterialId: Identifier.nullable().default(null),
    bays: z.int().min(1).max(100).optional(),
    windowWallRatio: z.number().min(0).max(1).nullable().default(null),
    notes: Note,
  })
  .readonly();

const IntentMaterial = z
  .strictObject({
    id: Identifier,
    name: Label,
    block: Label,
    role: MaterialRole,
    color: ColorHex.optional(),
    notes: Note,
  })
  .readonly();

const FurnitureAnchor = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('center') }),
    z.strictObject({ kind: z.literal('wall'), side: Side, offset: z.int().min(0) }),
    z.strictObject({ kind: z.literal('corner'), corner: z.enum(['nw', 'ne', 'sw', 'se']) }),
  ])
  .readonly();

export const IntentFurniture = z
  .strictObject({
    id: Identifier,
    name: Label,
    kind: FurnitureKind,
    roomId: Identifier,
    anchor: FurnitureAnchor,
    footprint: z.strictObject({ x: z.int().min(1).max(100), z: z.int().min(1).max(100) }).readonly(),
    orientation: Side.nullable(),
    height: z.int().min(1).max(16).optional(),
    materialId: Identifier.nullable().default(null),
    notes: Note,
  })
  .readonly();
export type IntentFurniture = z.infer<typeof IntentFurniture>;

const IntentDecision = z
  .strictObject({
    id: Identifier,
    topic: Label,
    choice: Text,
    rationale: Text,
    source: z.enum(['user', 'agent', 'default']),
    requirementIds: z.array(Identifier).max(50).readonly(),
  })
  .readonly();

const IntentOpen = z
  .strictObject({
    id: Identifier,
    question: Text,
    impact: z.enum(['layout', 'facade', 'interior', 'budget', 'other']),
    owner: z.enum(['user', 'agent']),
    defaultAssumption: Text.nullable(),
    freeForBuilder: z.boolean(),
  })
  .readonly();

const DesignIntentShape = z.strictObject({
  meta: IntentMeta,
  site: IntentSite,
  program: IntentProgram,
  envelope: IntentEnvelope,
  openings: z.array(IntentOpening).max(500).readonly(),
  structure: IntentStructure,
  roof: IntentRoof,
  facades: z.array(IntentFacade).max(4).readonly(),
  materials: z.array(IntentMaterial).min(1).max(200).readonly(),
  furniture: z.array(IntentFurniture).max(500).readonly(),
  decisions: z.array(IntentDecision).max(200).readonly(),
  open: z.array(IntentOpen).max(100).readonly(),
});
type IntentShape = z.infer<typeof DesignIntentShape>;

function checkUnique(ids: readonly string[], path: string, label: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [path, index, 'id'], message: `${label} id 重复：${id}` });
    seen.add(id);
  });
}

function checkDesignIntent(intent: IntentShape, ctx: z.RefinementCtx): void {
  const issue = (path: readonly PropertyKey[], message: string): void => {
    ctx.addIssue({ code: 'custom', path: [...path], message });
  };

  checkUnique(
    intent.site.outdoorZones.map((zone) => zone.id),
    'site.outdoorZones',
    '场地区域',
    ctx,
  );
  checkUnique(
    intent.program.levels.map((level) => level.id),
    'program.levels',
    '楼层',
    ctx,
  );
  checkUnique(
    intent.program.rooms.map((room) => room.id),
    'program.rooms',
    '房间',
    ctx,
  );
  checkUnique(
    intent.envelope.walls.map((wall) => `${wall.roomId}:${wall.side}`),
    'envelope.walls',
    '墙意图',
    ctx,
  );
  checkUnique(
    intent.envelope.stairs.map((stair) => stair.id),
    'envelope.stairs',
    '楼梯',
    ctx,
  );
  checkUnique(
    intent.openings.map((opening) => opening.id),
    'openings',
    '洞口',
    ctx,
  );
  checkUnique(
    intent.materials.map((material) => material.id),
    'materials',
    '材质',
    ctx,
  );
  checkUnique(
    intent.furniture.map((furniture) => furniture.id),
    'furniture',
    '家具',
    ctx,
  );
  checkUnique(
    intent.facades.map((facade) => facade.side),
    'facades',
    '立面',
    ctx,
  );
  checkUnique(
    intent.decisions.map((decision) => decision.id),
    'decisions',
    '决策',
    ctx,
  );
  checkUnique(
    intent.open.map((item) => item.id),
    'open',
    '未决问题',
    ctx,
  );
  checkUnique(intent.roof.segments?.map((segment) => segment.id) ?? [], 'roof.segments', '屋面段', ctx);

  const materialIds = new Set(intent.materials.map((material) => material.id));
  const material = (id: string, path: readonly (string | number)[]): void => {
    if (!materialIds.has(id)) issue(path, `引用了不存在的材质 ${id}`);
  };
  const roomIds = new Set(intent.program.rooms.map((room) => room.id));
  const zoneIds = new Set(intent.site.outdoorZones.map((zone) => zone.id));
  const roomById = new Map(intent.program.rooms.map((room) => [room.id, room]));
  const levelById = new Map(intent.program.levels.map((level) => [level.id, level]));
  const levelOrder = new Map(intent.program.levels.map((level, index) => [level.id, index]));

  for (const zoneId of zoneIds) {
    if (roomIds.has(zoneId)) issue(['site', 'outdoorZones'], `场地区域 id 与房间 id 冲突：${zoneId}`);
  }

  let previousElevation: number | undefined;
  let previousEnd: number | undefined;
  intent.program.levels.forEach((level, index) => {
    material(level.floorMaterialId, ['program', 'levels', index, 'floorMaterialId']);
    const elevation = level.elevation ?? previousEnd ?? 1;
    if (previousElevation !== undefined && elevation <= previousElevation) {
      issue(
        ['program', 'levels', index, 'elevation'],
        `楼层标高必须严格递增：${String(elevation)} <= ${String(previousElevation)}`,
      );
    }
    if (previousEnd !== undefined && elevation < previousEnd) {
      issue(
        ['program', 'levels', index, 'elevation'],
        `楼层标高与上一层重叠：${String(elevation)} < ${String(previousEnd)}`,
      );
    }
    previousElevation = elevation;
    previousEnd = elevation + level.height;
  });

  intent.site.outdoorZones.forEach((zone, index) => {
    if (!rectWithin(zone.rect, intent.site.bounds)) {
      issue(['site', 'outdoorZones', index, 'rect'], `场地区域 ${zone.id} 超出场地范围`);
    }
    material(zone.materialId, ['site', 'outdoorZones', index, 'materialId']);
    // 分区与房间重叠属于可修复的场地语义矛盾：由宿主在 normalize / expand 阶段丢弃分区并警告，不阻断整单。
  });

  intent.program.rooms.forEach((room, index) => {
    if (!levelById.has(room.level))
      issue(['program', 'rooms', index, 'level'], `房间 ${room.id} 引用了不存在的楼层 ${room.level}`);
    if (!rectWithin(room.rect, intent.site.bounds)) {
      issue(['program', 'rooms', index, 'rect'], `房间 ${room.id} 超出场地范围`);
    }
    for (const [otherIndex, other] of intent.program.rooms.entries()) {
      if (otherIndex <= index || other.level !== room.level) continue;
      if (rectsOverlap(room.rect, other.rect)) {
        issue(['program', 'rooms', index, 'rect'], `同层房间 ${room.id} 与 ${other.id} 面积重叠`);
      }
    }
    room.adjacency.forEach((reference, refIndex) => {
      const other = roomById.get(reference);
      if (other === undefined) {
        issue(
          ['program', 'rooms', index, 'adjacency', refIndex],
          `房间 ${room.id} 引用了不存在的相邻房间 ${reference}`,
        );
        return;
      }
      if (reference === room.id)
        issue(['program', 'rooms', index, 'adjacency', refIndex], `房间 ${room.id} 不能与自己相邻`);
      if (other.level !== room.level) {
        issue(['program', 'rooms', index, 'adjacency', refIndex], `房间 ${room.id} 与 ${reference} 不在同一层`);
      }
      if (!other.adjacency.includes(room.id)) {
        issue(['program', 'rooms', index, 'adjacency', refIndex], `adjacency 必须对称：${reference} 未声明 ${room.id}`);
      }
      if (rectSharedEdgeLength(room.rect, other.rect) <= 0) {
        issue(['program', 'rooms', index, 'adjacency', refIndex], `房间 ${room.id} 与 ${reference} 没有正长度共边`);
      }
    });
  });

  intent.envelope.walls.forEach((wall, index) => {
    if (!roomIds.has(wall.roomId))
      issue(['envelope', 'walls', index, 'roomId'], `墙意图引用了不存在的房间 ${wall.roomId}`);
    if (wall.materialId !== undefined) material(wall.materialId, ['envelope', 'walls', index, 'materialId']);
  });

  intent.envelope.stairs.forEach((stair, index) => {
    const room = roomById.get(stair.roomId);
    const fromIndex = levelOrder.get(stair.fromLevel);
    const toIndex = levelOrder.get(stair.toLevel);
    if (room === undefined) {
      issue(['envelope', 'stairs', index, 'roomId'], `楼梯 ${stair.id} 引用了不存在的房间 ${stair.roomId}`);
    } else if (room.level !== stair.fromLevel) {
      issue(['envelope', 'stairs', index, 'roomId'], `楼梯 ${stair.id} 的房间 ${room.id} 不在 ${stair.fromLevel}`);
    }
    if (fromIndex === undefined)
      issue(['envelope', 'stairs', index, 'fromLevel'], `楼梯 ${stair.id} 引用了不存在的楼层 ${stair.fromLevel}`);
    if (toIndex === undefined)
      issue(['envelope', 'stairs', index, 'toLevel'], `楼梯 ${stair.id} 引用了不存在的楼层 ${stair.toLevel}`);
    if (fromIndex !== undefined && toIndex !== undefined && toIndex !== fromIndex + 1) {
      issue(['envelope', 'stairs', index, 'toLevel'], `楼梯 ${stair.id} 必须连接相邻楼层`);
    }
    if (stair.materialId !== undefined) material(stair.materialId, ['envelope', 'stairs', index, 'materialId']);
    const footprint = stairRect(stair.start, stair.direction, stair.width, stair.treads);
    const rect = room?.rect;
    if (rect !== undefined && !rectWithin(footprint, rect)) {
      issue(['envelope', 'stairs', index, 'start'], `楼梯 ${stair.id} 的梯段超出房间 ${room?.id ?? ''}`);
    }
  });

  const entranceOpenings = intent.openings.filter((opening) => opening.role === 'entrance');
  if (entranceOpenings.length !== 1) {
    issue(['openings'], `必须恰有一个 role=entrance 的洞口，实际 ${String(entranceOpenings.length)} 个`);
  }
  intent.openings.forEach((opening, index) => {
    const room = roomById.get(opening.roomId);
    if (room === undefined) {
      issue(['openings', index, 'roomId'], `洞口 ${opening.id} 引用了不存在的房间 ${opening.roomId}`);
      return;
    }
    if (opening.role === 'entrance' && opening.side !== intent.site.entrance.side) {
      issue(
        ['openings', index, 'side'],
        `入口洞口 ${opening.id} 的朝向 ${opening.side} 与场地入口 ${intent.site.entrance.side} 不一致`,
      );
    }
    if ((opening.kind === 'door' || opening.kind === 'gate') && opening.sill !== 0) {
      issue(['openings', index, 'sill'], `门 / 院门 ${opening.id} 的窗台必须为 0`);
    }
    const level = levelById.get(room.level);
    if (level !== undefined && opening.sill + opening.height > level.height) {
      issue(['openings', index, 'height'], `洞口 ${opening.id} 的 sill + height 超出层高 ${String(level.height)}`);
    }
    if (opening.frameMaterial !== null) material(opening.frameMaterial, ['openings', index, 'frameMaterial']);
  });

  if (intent.meta.scope === 'exterior+interior') {
    for (let index = 0; index + 1 < intent.program.levels.length; index += 1) {
      const from = intent.program.levels[index];
      const to = intent.program.levels[index + 1];
      if (from === undefined || to === undefined) continue;
      if (!intent.envelope.stairs.some((stair) => stair.fromLevel === from.id && stair.toLevel === to.id)) {
        issue(['envelope', 'stairs'], `完整室内方案缺少 ${from.id} → ${to.id} 的楼梯`);
      }
    }
  }

  material(intent.structure.materialId, ['structure', 'materialId']);
  material(intent.roof.materialId, ['roof', 'materialId']);
  if (intent.roof.form === 'flat') {
    if (intent.roof.pitchDegrees !== undefined && intent.roof.pitchDegrees !== 0) {
      issue(['roof', 'pitchDegrees'], '平屋面的 pitchDegrees 只能为 0 或省略');
    }
  } else if (intent.roof.pitchDegrees === undefined || intent.roof.pitchDegrees < 5 || intent.roof.pitchDegrees > 60) {
    issue(['roof', 'pitchDegrees'], '非平屋面的 pitchDegrees 必须在 5..60');
  }
  intent.roof.segments?.forEach((segment, index) => {
    material(segment.materialId, ['roof', 'segments', index, 'materialId']);
    if (!rectWithin(segment.rect, intent.site.bounds)) {
      issue(['roof', 'segments', index, 'rect'], `屋面段 ${segment.id} 超出场地范围`);
    }
    if (segment.form === 'flat') {
      if (segment.pitchDegrees !== undefined && segment.pitchDegrees !== 0) {
        issue(['roof', 'segments', index, 'pitchDegrees'], '平屋面段的 pitchDegrees 只能为 0 或省略');
      }
    } else if (segment.pitchDegrees === undefined || segment.pitchDegrees < 5 || segment.pitchDegrees > 60) {
      issue(['roof', 'segments', index, 'pitchDegrees'], '非平屋面段的 pitchDegrees 必须在 5..60');
    }
    for (let other = 0; other < index; other += 1) {
      const previous = intent.roof.segments?.[other];
      if (previous !== undefined && rectsOverlap(segment.rect, previous.rect)) {
        issue(['roof', 'segments', index, 'rect'], `屋面段 ${segment.id} 与 ${previous.id} 重叠`);
      }
    }
  });

  intent.facades.forEach((facade, index) => {
    material(facade.baseMaterialId, ['facades', index, 'baseMaterialId']);
    material(facade.bodyMaterialId, ['facades', index, 'bodyMaterialId']);
    if (facade.topMaterialId !== null) material(facade.topMaterialId, ['facades', index, 'topMaterialId']);
  });

  const hasRoom = (id: string): boolean => roomIds.has(id) || zoneIds.has(id);
  intent.furniture.forEach((furniture, index) => {
    if (!hasRoom(furniture.roomId)) {
      issue(['furniture', index, 'roomId'], `家具 ${furniture.id} 引用了不存在的房间或室外分区 ${furniture.roomId}`);
      return;
    }
    if (furniture.materialId !== null) material(furniture.materialId, ['furniture', index, 'materialId']);
  });
}

/** 模型可写的完整设计意图；宿主字段（id / revision / status / budget / forbidden）不在这里。 */
export const DesignIntent = DesignIntentShape.superRefine(checkDesignIntent).readonly();
export type DesignIntent = z.infer<typeof DesignIntent>;
