/* eslint-disable max-lines */
/**
 * DesignIntent → DesignScheme 的宿主确定性展开。
 *
 * 负责：楼层标高、墙段 / 洞口、楼板 / 屋面 / 楼梯、家具 / 室内、立面 / 材质，以及面积、counts 与 warnings。
 * 展开是纯函数：同一 intent + host 必须逐字节相同；不猜方案、不自动缩放、不读文件、不调模型。
 */
import { ZodError } from 'zod';

import { boundsWithin } from './primitives.ts';
import type { Bounds } from './primitives.ts';
import {
  decomposeRectUnion,
  DesignIntent,
  IntentValidationError,
  rectArea,
  rectsOverlap,
  rectSharedEdgeLength,
  rectWithin,
  stairRect,
} from './design-intent.ts';
import type { DesignHostContext, Rect2 } from './design-intent.ts';
import { designConflictsFromWarnings } from './design-conflict.ts';
import { buildEnvelope } from './design-expand-walls.ts';
import { buildInteriors } from './design-expand-interiors.ts';
import type { DesignFacts, DesignRoomFact, DesignWarning, Level, ResolvedDesign, Room } from './design-expand-types.ts';
import { deriveFloorDatum } from './floor-datum.ts';
import { planMustObjectLinks } from './must-links.ts';
import type { MustLinkCoverage } from './must-links.ts';
import { DesignScheme } from './scheme.ts';
import type { DesignScheme as DesignSchemeType, OpeningKind, SchemeElement, SchemeSpace, Side } from './scheme.ts';

export type { DesignFacts, DesignRoomFact, DesignWarning, ResolvedDesign } from './design-expand-types.ts';

const SIDES: readonly Side[] = ['north', 'east', 'south', 'west'];

function fail(code: ConstructorParameters<typeof IntentValidationError>[0], path: string, message: string): never {
  throw new IntentValidationError(code, path, message);
}

function parseExpandedScheme(payload: unknown): DesignSchemeType {
  try {
    return DesignScheme.parse(payload);
  } catch (error) {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      fail(
        'schema-invalid',
        `scheme.${first?.path.map(String).join('.') ?? ''}`,
        first?.message ?? '展开结果未通过 DesignScheme',
      );
    }
    throw error;
  }
}

function fitId(raw: string): string {
  if (raw.length <= 64) return raw;
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${raw.slice(0, 55)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function bboxOf(rects: readonly Rect2[]): { x0: number; x1: number; z0: number; z1: number } {
  const first = rects[0];
  if (first === undefined) fail('schema-invalid', 'program.rooms', '至少需要一个房间');
  let x0 = first.x[0];
  let x1 = first.x[1];
  let z0 = first.z[0];
  let z1 = first.z[1];
  for (const rect of rects) {
    x0 = Math.min(x0, rect.x[0]);
    x1 = Math.max(x1, rect.x[1]);
    z0 = Math.min(z0, rect.z[0]);
    z1 = Math.max(z1, rect.z[1]);
  }
  return { x0, x1, z0, z1 };
}

/** 一个矩形是否被同层房间并集完整覆盖；用于校验模型显式给出的屋面段。 */
function rectCoveredByRooms(rect: Rect2, rooms: readonly Room[]): boolean {
  const xs = [...new Set([rect.x[0], rect.x[1], ...rooms.flatMap((room) => room.rect.x)])]
    .filter((value) => value >= rect.x[0] && value <= rect.x[1])
    .sort((a, b) => a - b);
  const zs = [...new Set([rect.z[0], rect.z[1], ...rooms.flatMap((room) => room.rect.z)])]
    .filter((value) => value >= rect.z[0] && value <= rect.z[1])
    .sort((a, b) => a - b);
  for (let zi = 0; zi + 1 < zs.length; zi += 1) {
    for (let xi = 0; xi + 1 < xs.length; xi += 1) {
      const x0 = xs[xi];
      const x1 = xs[xi + 1];
      const z0 = zs[zi];
      const z1 = zs[zi + 1];
      if (x0 === undefined || x1 === undefined || z0 === undefined || z1 === undefined) continue;
      if (x1 <= x0 || z1 <= z0) continue;
      if (!rooms.some((room) => rectWithin({ x: [x0, x1], z: [z0, z1] }, room.rect))) return false;
    }
  }
  return true;
}

export function expandDesignIntent(input: unknown, host: DesignHostContext): ResolvedDesign {
  let intent: DesignIntent;
  try {
    intent = DesignIntent.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      fail('schema-invalid', first?.path.map(String).join('.') ?? '', first?.message ?? 'DesignIntent 解析失败');
    }
    throw error;
  }

  if (!Number.isSafeInteger(host.maxBlocks) || host.maxBlocks < 100 || host.maxBlocks > 200_000) {
    fail('host-invalid', 'host.maxBlocks', 'maxBlocks 必须是 100..200000 的整数');
  }
  const forbidden = host.forbidden ?? [];
  if (forbidden.length > 50 || forbidden.some((item) => item.length === 0 || item.length > 4000)) {
    fail('host-invalid', 'host.forbidden', 'forbidden 最多 50 条，每条 1..4000 字符');
  }
  if (host.maxCostCny !== undefined && host.maxCostCny !== null && host.maxCostCny <= 0) {
    fail('host-invalid', 'host.maxCostCny', 'maxCostCny 必须为正数');
  }

  const warnings: DesignWarning[] = [];
  const warn = (code: string, message: string, path?: string): void => {
    warnings.push(path === undefined ? { code, message } : { code, message, path });
  };

  // 兜底：直接调用 expand 或旧数据可能绕过 normalize，这里再次丢弃与房间重叠的室外分区。
  const droppedZoneIds = new Set<string>();
  const outdoorZones = intent.site.outdoorZones.filter((zone) => {
    const room = intent.program.rooms.find((candidate) => rectsOverlap(zone.rect, candidate.rect));
    if (room === undefined) return true;
    droppedZoneIds.add(zone.id);
    warn(
      'outdoor-zone-overlap-dropped',
      `室外分区 ${zone.id} 与房间 ${room.id} 重叠，已丢弃该室外分区，不影响室内几何；如需保留请调整分区或房间`,
      `site.outdoorZones.${zone.id}`,
    );
    return false;
  });
  intent = { ...intent, site: { ...intent.site, outdoorZones } };
  if (droppedZoneIds.size > 0) {
    const furniture = intent.furniture.filter((item) => {
      if (!droppedZoneIds.has(item.roomId)) return true;
      warn(
        'furniture-zone-dropped',
        `家具 ${item.id} 位于已丢弃的室外分区 ${item.roomId}，已一并丢弃`,
        `furniture.${item.id}`,
      );
      return false;
    });
    intent = { ...intent, furniture };
  }

  const materialById = new Map(intent.materials.map((entry) => [entry.id, entry]));
  const material = (id: string, path: string): string => {
    if (!materialById.has(id)) fail('reference-missing', path, `引用了不存在的材质 ${id}`);
    return id;
  };

  const levels: Level[] = [];
  let previousEnd: number | undefined;
  intent.program.levels.forEach((level, index) => {
    const elevation = level.elevation ?? previousEnd ?? 1;
    material(level.floorMaterialId, `program.levels.${String(index)}.floorMaterialId`);
    levels.push({
      id: level.id,
      name: level.name,
      elevation,
      height: level.height,
      floorMaterialId: level.floorMaterialId,
    });
    previousEnd = elevation + level.height;
  });
  const levelById = new Map(levels.map((level) => [level.id, level]));
  const rooms: Room[] = intent.program.rooms.map((room) => {
    const level = levelById.get(room.level);
    if (level === undefined)
      fail('reference-missing', `program.rooms.${room.id}.level`, `房间引用了不存在的楼层 ${room.level}`);
    return {
      intent: room,
      level,
      rect: room.rect,
      bounds: {
        min: [room.rect.x[0], level.elevation, room.rect.z[0]],
        max: [room.rect.x[1], level.elevation + level.height, room.rect.z[1]],
      },
    };
  });
  const minElevation = Math.min(...levels.map((level) => level.elevation));

  const connections = new Map<string, string[]>(rooms.map((room) => [room.intent.id, []]));
  for (const [index, room] of rooms.entries()) {
    for (const other of rooms.slice(index + 1)) {
      if (room.level.id !== other.level.id || rectSharedEdgeLength(room.rect, other.rect) <= 0) continue;
      connections.get(room.intent.id)?.push(other.intent.id);
      connections.get(other.intent.id)?.push(room.intent.id);
      if (!room.intent.adjacency.includes(other.intent.id)) {
        warn('adjacency-not-declared', `${room.intent.id} 与 ${other.intent.id} 实际共边，但未在 adjacency 声明`);
      }
    }
  }

  const outdoorY = levels[0] === undefined ? 0 : levels[0].elevation - 1;
  const outdoorSpaces: SchemeSpace[] = intent.site.outdoorZones.map((zone) => {
    const linked: string[] = [];
    for (const room of rooms) {
      if (rectSharedEdgeLength(zone.rect, room.rect) > 0) {
        linked.push(room.intent.id);
        connections.get(room.intent.id)?.push(zone.id);
      }
    }
    return {
      id: zone.id,
      name: zone.name,
      level: levels[0]?.id ?? fail('schema-invalid', 'program.levels', '至少需要一个楼层'),
      kind: 'outdoor',
      bounds: { min: [zone.rect.x[0], outdoorY, zone.rect.z[0]], max: [zone.rect.x[1], outdoorY + 1, zone.rect.z[1]] },
      connections: linked,
      notes: zone.notes,
    };
  });
  const spaces: SchemeSpace[] = [
    ...rooms.map((room) => ({
      id: room.intent.id,
      name: room.intent.name,
      level: room.level.id,
      kind: room.intent.kind,
      bounds: room.bounds,
      connections: connections.get(room.intent.id) ?? [],
      notes: room.intent.notes,
    })),
    ...outdoorSpaces,
  ];

  const envelope = buildEnvelope(intent, levels, rooms, host.defaultMaterialId, warn);
  const elements: SchemeElement[] = [...envelope.elements];

  const floorThickness = intent.structure.floorThickness ?? host.floorThickness ?? 1;
  if (!Number.isSafeInteger(floorThickness) || floorThickness < 1 || floorThickness > 100) {
    fail('host-invalid', 'host.floorThickness', '楼板厚度必须是 1..100 的整数');
  }
  const slabs: SchemeElement[] = rooms.map((room) => ({
    id: fitId(`slab-${room.level.id}-${room.intent.id}`),
    name: `${room.intent.name} 楼板`,
    level: room.level.id,
    kind: 'slab',
    bounds: {
      min: [room.rect.x[0], room.level.elevation - floorThickness, room.rect.z[0]],
      max: [room.rect.x[1], room.level.elevation, room.rect.z[1]],
    },
    material: room.level.floorMaterialId,
    spaceId: room.intent.id,
    thickness: floorThickness,
    notes: null,
  }));

  const topLevel = levels[levels.length - 1];
  if (topLevel === undefined) fail('schema-invalid', 'program.levels', '至少需要一个楼层');
  const topRooms = rooms.filter((room) => room.level.id === topLevel.id);
  if (topRooms.length === 0) fail('roof-plan-empty', 'program.rooms', '顶层没有房间，无法生成屋面');
  const buildingBBox = bboxOf(rooms.map((room) => room.rect));
  const buildingRect: Rect2 = {
    x: [buildingBBox.x0, buildingBBox.x1],
    z: [buildingBBox.z0, buildingBBox.z1],
  };
  const eaveHeight = topLevel.elevation + topLevel.height;
  const spanX = buildingBBox.x1 - buildingBBox.x0;
  const spanZ = buildingBBox.z1 - buildingBBox.z0;
  if (spanX < 1 || spanZ < 1 || spanX > 10_000 || spanZ > 10_000) {
    fail('schema-invalid', 'program.rooms', '建筑跨度必须在 1..10000');
  }
  const roofThickness = host.roofThickness ?? floorThickness;
  const explicitSegments = intent.roof.segments;
  const unionArea = topRooms.reduce((sum, room) => sum + rectArea(room.rect), 0);
  const sourceSegments: readonly {
    readonly id?: string | undefined;
    readonly rect: Rect2;
    readonly form?: 'flat' | 'gable' | 'hip' | 'shed' | undefined;
    readonly materialId?: string | undefined;
    readonly pitchDegrees?: number | undefined;
    readonly overhang?: number | undefined;
  }[] =
    explicitSegments ??
    decomposeRectUnion(topRooms.map((room) => room.rect)).map((rect, index) => ({
      id: `auto-${String(index + 1)}`,
      rect,
    }));
  if (sourceSegments.length === 0) fail('roof-plan-empty', 'program.rooms', '顶层房间并集无法分解出屋面段');
  if (sourceSegments.length > 20)
    fail('roof-plan-too-complex', 'program.rooms', `屋面段超过 20 段（${String(sourceSegments.length)}）`);
  if (explicitSegments !== undefined) {
    const segmentArea = sourceSegments.reduce((sum, segment) => sum + rectArea(segment.rect), 0);
    if (segmentArea !== unionArea)
      fail('roof-segment-incomplete', 'roof.segments', '显式屋面段面积与顶层房间并集不一致');
    sourceSegments.forEach((segment, index) => {
      if (!rectWithin(segment.rect, buildingRect)) {
        fail('roof-segment-outside', `roof.segments.${String(index)}.rect`, `屋面段 ${segment.id ?? ''} 超出建筑范围`);
      }
      if (!rectCoveredByRooms(segment.rect, topRooms)) {
        fail('roof-segment-incomplete', `roof.segments.${String(index)}.rect`, '屋面段覆盖了非顶层房间区域');
      }
      for (let other = 0; other < index; other += 1) {
        const previous = sourceSegments[other];
        if (previous !== undefined && rectsOverlap(segment.rect, previous.rect)) {
          fail(
            'roof-segment-overlap',
            `roof.segments.${String(index)}.rect`,
            `屋面段 ${segment.id ?? ''} 与 ${previous.id ?? ''} 重叠`,
          );
        }
      }
    });
  } else {
    const segmentArea = sourceSegments.reduce((sum, segment) => sum + rectArea(segment.rect), 0);
    if (segmentArea !== unionArea)
      fail('roof-segment-incomplete', 'program.rooms', '自动分解的屋面段未覆盖顶层房间并集');
  }
  const roofSegments = sourceSegments.map((segment, index) => {
    const form = segment.form ?? intent.roof.form;
    const pitchDegrees = form === 'flat' ? 0 : (segment.pitchDegrees ?? intent.roof.pitchDegrees ?? 0);
    if (form !== 'flat' && (pitchDegrees < 5 || pitchDegrees > 60)) {
      fail(
        'roof-pitch-invalid',
        explicitSegments === undefined ? 'roof.pitchDegrees' : `roof.segments.${String(index)}.pitchDegrees`,
        '非平屋面坡度必须是 5..60',
      );
    }
    const overhang = segment.overhang ?? intent.roof.overhang;
    const materialId = material(segment.materialId ?? intent.roof.materialId, 'roof.materialId');
    const width = segment.rect.x[1] - segment.rect.x[0];
    const depth = segment.rect.z[1] - segment.rect.z[0];
    const ridgeAxis = width >= depth ? 'x' : 'z';
    const across = (ridgeAxis === 'x' ? depth : width) + overhang * 2;
    const ridgeHeight =
      form === 'flat' ? eaveHeight : eaveHeight + Math.round((Math.tan((pitchDegrees * Math.PI) / 180) * across) / 2);
    if (form !== 'flat' && ridgeHeight <= eaveHeight) {
      fail('roof-pitch-invalid', 'roof.pitchDegrees', '坡度在当前跨度下无法形成高于檐口的屋脊');
    }
    const bounds: Bounds = {
      min: [segment.rect.x[0] - overhang, eaveHeight, segment.rect.z[0] - overhang],
      max: [segment.rect.x[1] + overhang, ridgeHeight + roofThickness, segment.rect.z[1] + overhang],
    };
    const legacySingle = sourceSegments.length === 1 && explicitSegments === undefined;
    const id = legacySingle
      ? fitId(`roof-${topLevel.id}`)
      : fitId(`roof-${topLevel.id}-${segment.id ?? String(index + 1)}`);
    return {
      id: segment.id ?? `roof-${topLevel.id}-${String(index + 1)}`,
      elementId: id,
      name: legacySingle ? `${intent.meta.title} 屋面` : `${intent.meta.title} 屋面 ${String(index + 1)}`,
      form,
      material: materialId,
      pitchDegrees,
      eaveHeight,
      ridgeHeight,
      overhang,
      bounds,
      area: rectArea(segment.rect),
    };
  });
  const mainRoof = [...roofSegments].sort((a, b) => b.area - a.area || a.id.localeCompare(b.id))[0];
  if (mainRoof === undefined) fail('roof-plan-empty', 'roof', '没有可用的屋面段');
  const maxRidgeHeight = Math.max(...roofSegments.map((segment) => segment.ridgeHeight));
  if (roofSegments.length > 1) {
    warn('multi-roof-mvp', `顶层平面分解为 ${String(roofSegments.length)} 段屋面；段间谷脊构造未建模`, 'roof');
  }
  for (const segment of roofSegments) {
    elements.push({
      id: segment.elementId,
      name: segment.name,
      level: topLevel.id,
      kind: 'roof',
      bounds: segment.bounds,
      material: segment.material,
      spaceId: null,
      thickness: roofThickness,
      notes: intent.roof.notes,
    });
  }
  elements.push(...slabs);
  const buildingBounds: Bounds = {
    min: [buildingBBox.x0, minElevation, buildingBBox.z0],
    max: [buildingBBox.x1, eaveHeight, buildingBBox.z1],
  };

  const structureMaterial = material(intent.structure.materialId, 'structure.materialId');
  const structure = {
    system: intent.structure.system,
    material: structureMaterial,
    spanX,
    spanZ,
    floorThickness,
    cantilever: intent.structure.cantilever ?? 0,
    notes: intent.structure.notes,
  };

  if (intent.meta.scope === 'exterior+interior') {
    for (let index = 0; index + 1 < levels.length; index += 1) {
      const from = levels[index];
      const to = levels[index + 1];
      if (from === undefined || to === undefined) continue;
      if (!intent.envelope.stairs.some((stair) => stair.fromLevel === from.id && stair.toLevel === to.id)) {
        fail('missing-vertical-circulation', 'envelope.stairs', `缺少 ${from.id} → ${to.id} 的楼梯`);
      }
    }
  }
  const stairElements: SchemeElement[] = [];
  const stairRoutes: DesignSchemeType['circulation'][number][] = [];
  for (const stair of intent.envelope.stairs) {
    const room = rooms.find((entry) => entry.intent.id === stair.roomId);
    const from = levelById.get(stair.fromLevel);
    const to = levelById.get(stair.toLevel);
    if (room === undefined || from === undefined || to === undefined) {
      fail('reference-missing', `envelope.stairs.${stair.id}`, '楼梯引用的房间或楼层不存在');
    }
    const footprint = stairRect(stair.start, stair.direction, stair.width, stair.treads);
    if (!rectWithin(footprint, room.rect))
      fail('stair-out-of-room', `envelope.stairs.${stair.id}.start`, '梯段超出房间');
    const centerX = footprint.x[0] + Math.floor((footprint.x[1] - footprint.x[0]) / 2);
    const centerZ = footprint.z[0] + Math.floor((footprint.z[1] - footprint.z[0]) / 2);
    const farX = stair.direction === 'west' ? footprint.x[0] : stair.direction === 'east' ? footprint.x[1] : centerX;
    const farZ = stair.direction === 'north' ? footprint.z[0] : stair.direction === 'south' ? footprint.z[1] : centerZ;
    const upper = rooms.find((candidate) => candidate.level.id === to.id && rectsOverlap(candidate.rect, footprint));
    if (upper === undefined) warn('stair-top-room-missing', `楼梯 ${stair.id} 顶部没有找到上层房间`);
    const stairMaterial = stair.materialId ?? structureMaterial;
    material(stairMaterial, `envelope.stairs.${stair.id}.materialId`);
    stairElements.push({
      id: fitId(`stair-${stair.id}`),
      name: `${stair.name} 梯段`,
      level: from.id,
      kind: 'stair',
      bounds: {
        min: [footprint.x[0], from.elevation, footprint.z[0]],
        max: [footprint.x[1], to.elevation, footprint.z[1]],
      },
      material: stairMaterial,
      spaceId: room.intent.id,
      thickness: null,
      notes: null,
    });
    stairRoutes.push({
      id: fitId(`stair-route-${stair.id}`),
      name: `${stair.name} 示意路线`,
      kind: 'stair',
      level: from.id,
      width: stair.width,
      accessible: false,
      fromSpaceId: room.intent.id,
      toSpaceId: upper?.intent.id ?? null,
      points: [
        [stair.start.x, from.elevation, stair.start.z],
        [farX, to.elevation, farZ],
      ],
      notes: null,
    });
  }
  elements.push(...stairElements);

  const { interiors } = buildInteriors(intent, rooms, envelope.walls, outdoorY, host.defaultMaterialId, warn);

  const facades = SIDES.filter((side) => envelope.exteriorSides.has(side)).map((side) => {
    const facade = intent.facades.find((entry) => entry.side === side);
    if (facade === undefined) fail('facade-missing', 'facades', `有外墙的 ${side} 侧缺少立面`);
    const sideLength = side === 'north' || side === 'south' ? spanX : spanZ;
    const wallArea = sideLength * (eaveHeight - minElevation);
    const windowArea = envelope.openings
      .filter((opening) => opening.side === side && opening.kind === 'window')
      .reduce((sum, opening) => {
        const width =
          side === 'north' || side === 'south'
            ? opening.bounds.max[0] - opening.bounds.min[0]
            : opening.bounds.max[2] - opening.bounds.min[2];
        return sum + width * (opening.bounds.max[1] - opening.bounds.min[1]);
      }, 0);
    const derived = wallArea > 0 ? Math.round(Math.min(1, windowArea / wallArea) * 100) / 100 : 0;
    return {
      side,
      baseMaterialId: material(facade.baseMaterialId, `facades.${side}.baseMaterialId`),
      bodyMaterialId: material(facade.bodyMaterialId, `facades.${side}.bodyMaterialId`),
      topMaterialId:
        facade.topMaterialId === null ? null : material(facade.topMaterialId, `facades.${side}.topMaterialId`),
      bays: facade.bays ?? Math.max(1, Math.round(sideLength / 3)),
      windowWallRatio: facade.windowWallRatio ?? derived,
      notes: facade.notes,
    };
  });
  for (const facade of intent.facades) {
    if (!envelope.exteriorSides.has(facade.side))
      fail('facade-without-wall', `facades.${facade.side}`, `${facade.side} 侧没有外墙，不应声明立面`);
  }

  const decisions = intent.decisions.map((decision) => {
    const requirementIds = host.requirementIds;
    if (requirementIds === undefined) return { ...decision, status: 'proposed' as const };
    const kept = decision.requirementIds.filter((reference) => requirementIds.includes(reference));
    const dropped = decision.requirementIds.filter((reference) => !requirementIds.includes(reference));
    if (dropped.length > 0) {
      warn(
        'requirement-reference-dropped',
        `决策 ${decision.id} 引用了不存在的需求 ${dropped.join('、')}；已从追溯标签移除，不影响几何展开`,
        `decisions.${decision.id}.requirementIds`,
      );
    }
    return { ...decision, requirementIds: kept, status: 'proposed' as const };
  });
  if (host.requirementIds === undefined && intent.decisions.some((decision) => decision.requirementIds.length > 0)) {
    warn('requirements-unchecked', '宿主未提供 requirementIds，决策需求引用未校验');
  }
  const open = intent.open.map((item) => ({ ...item, status: 'open' as const }));
  warn('entry-route-not-modeled', '入口路线未生成；只校验入口方向与 role');

  const siteBounds: Bounds = {
    min: [intent.site.bounds.x[0], Math.min(minElevation, outdoorY), intent.site.bounds.z[0]],
    max: [intent.site.bounds.x[1], Math.max(maxRidgeHeight + roofThickness, eaveHeight + 1), intent.site.bounds.z[1]],
  };
  if (!boundsWithin(buildingBounds, siteBounds)) fail('site-overlap', 'site.bounds', '建筑范围超出场地范围');

  const openingCounts: Record<OpeningKind, number> = { door: 0, window: 0, opening: 0, gate: 0 };
  for (const opening of envelope.openings) openingCounts[opening.kind] += 1;
  const roomFacts: DesignRoomFact[] = rooms.map((room) => {
    const nominalAreaM2 = rectArea(room.rect);
    const targetAreaM2 = room.intent.areaM2 ?? null;
    const deltaPct =
      targetAreaM2 === null ? null : Math.round(((nominalAreaM2 - targetAreaM2) / targetAreaM2) * 1000) / 10;
    if (deltaPct !== null && Math.abs(deltaPct) > 10) {
      warn(
        'area-target-mismatch',
        `房间 ${room.intent.id} 名义面积 ${String(nominalAreaM2)}，目标 ${String(targetAreaM2)}，偏差 ${String(deltaPct)}%`,
        `program.rooms.${room.intent.id}.areaM2`,
      );
    }
    return {
      id: room.intent.id,
      level: room.level.id,
      nominalAreaM2,
      targetAreaM2,
      deltaPct,
      occupancy: room.intent.occupancy,
      daylight: room.intent.daylight,
      adjacency: room.intent.adjacency,
    };
  });

  const payload = {
    meta: {
      id: host.schemeId,
      revision: host.revision,
      title: intent.meta.title,
      concept: intent.meta.concept,
      status: host.status ?? 'draft',
      scope: intent.meta.scope,
      sourceRequirements: host.sourceRequirements,
    },
    site: {
      bounds: siteBounds,
      buildingBounds,
      orientation: intent.site.orientation,
      entranceSide: envelope.entranceSide,
      outdoorZones: intent.site.outdoorZones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        kind: zone.kind,
        bounds: {
          min: [zone.rect.x[0], outdoorY, zone.rect.z[0]],
          max: [zone.rect.x[1], outdoorY + 1, zone.rect.z[1]],
        },
        material: material(zone.materialId, `site.outdoorZones.${zone.id}.materialId`),
        notes: zone.notes,
      })),
      notes: intent.site.notes,
    },
    levels: levels.map((level) => ({
      id: level.id,
      name: level.name,
      elevation: level.elevation,
      height: level.height,
    })),
    spaces,
    elements,
    openings: envelope.openings,
    circulation: stairRoutes,
    structure,
    roof: {
      form: mainRoof.form,
      material: mainRoof.material,
      pitchDegrees: mainRoof.pitchDegrees,
      eaveHeight: mainRoof.eaveHeight,
      ridgeHeight: mainRoof.ridgeHeight,
      overhang: mainRoof.overhang,
      drainage: intent.roof.drainage,
      skylights: intent.roof.skylights,
      notes: intent.roof.notes,
      ...(roofSegments.length > 1
        ? {
            segments: roofSegments.map((segment) => ({
              id: segment.id,
              form: segment.form,
              material: segment.material,
              pitchDegrees: segment.pitchDegrees,
              eaveHeight: segment.eaveHeight,
              ridgeHeight: segment.ridgeHeight,
              overhang: segment.overhang,
              bounds: segment.bounds,
            })),
          }
        : {}),
    },
    facades,
    materials: intent.materials.map((entry) => ({
      id: entry.id,
      name: entry.name,
      block: entry.block,
      role: entry.role,
      color: entry.color ?? null,
      notes: entry.notes,
    })),
    details: [],
    interiors,
    decisions,
    open,
    budget: {
      maxBlocks: host.maxBlocks,
      targetBlocks: host.targetBlocks ?? null,
      estimatedBlocks: null,
      maxCostCny: host.maxCostCny ?? null,
    },
    forbidden,
  };
  // 先按旧形态（details: []）解析出可查询的对象图，再由 MustLedger 建立显式链接后重解析。
  const firstScheme = parseExpandedScheme(payload);
  let scheme: DesignSchemeType = firstScheme;
  let mustLinks: MustLinkCoverage;
  if (host.mustEntries === undefined) {
    warn('details-not-derived', '宿主未提供 mustEntries；细部不生成，details 为空');
    warn('must-links-unavailable', '宿主未提供 mustEntries，无法建立 must→object 链接；details 保持为空');
    mustLinks = { total: 0, explicit: 0, verified: 0, declaredOnly: 0, unlinked: 0, entries: [] };
  } else {
    const plan = planMustObjectLinks(host.mustEntries, firstScheme);
    mustLinks = plan.coverage;
    if (plan.details.length > 0) scheme = parseExpandedScheme({ ...payload, details: plan.details });
  }

  const datum = deriveFloorDatum(scheme, undefined, {
    flushRequired: host.flushRequired ?? false,
    flushMustIds: host.flushMustIds ?? [],
  });
  const facts: DesignFacts = {
    derivationVersion: 'r2-mvp-1',
    derivations: [
      'levels.elevation：首层默认 1，后续按前一层 elevation + height 累加',
      'walls：外墙按房间侧内缩，共享墙在共享线上居中并按端点切分去重',
      'slabs：每房一块，y = [elevation - floorThickness, elevation)',
      'roof：eaveHeight = 顶层 elevation + height；多段时按顶层房间并集最大矩形分解，主屋面取面积最大段',
      'areas：nominalAreaM2 为房间矩形面积，未扣墙厚',
      'entranceSide：按最终保留的主 entrance 洞口 side 回写；短墙跨侧迁移时记录 entrance-side-updated',
      'furniture：center / wall offset / corner 锚点换算为绝对 bounds；默认高度 shelf/storage=2，其余=1',
      'facades：bays 缺省 round(sideLength / 3)；windowWallRatio 缺省按该侧窗洞面积 / 立面面积派生',
    ],
    buildingBounds,
    eaveHeight,
    ridgeHeight: mainRoof.ridgeHeight,
    entranceSide: envelope.entranceSide,
    rooms: roomFacts,
    counts: {
      levels: levels.length,
      rooms: rooms.length,
      spaces: spaces.length,
      walls: envelope.walls.length,
      exteriorWalls: envelope.walls.filter((wall) => wall.exterior).length,
      sharedWalls: envelope.walls.filter((wall) => !wall.exterior).length,
      slabs: slabs.length,
      openings: envelope.openings.length,
      openingsByKind: openingCounts,
      furniture: intent.furniture.length,
      stairs: stairRoutes.length,
    },
    openingHosts: Object.fromEntries(envelope.openings.map((opening) => [opening.id, opening.host])),
    datum: datum.datum,
    datumConflict: datum.conflict,
    mustLinks,
  };
  return { intent, scheme, facts, warnings, conflicts: designConflictsFromWarnings(warnings) };
}
