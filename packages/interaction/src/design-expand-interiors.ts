/** 家具锚点展开与室内条目生成；由 design-expand.ts 调用，纯函数。 */
import { boundsOverlap } from './primitives.ts';
import { IntentValidationError } from './design-intent.ts';
import type { DesignIntent, Rect2 } from './design-intent.ts';
import type { Room, Wall } from './design-expand-types.ts';
import type { SchemeFurniture, SchemeInterior, Side } from './scheme.ts';

export interface InteriorResult {
  readonly furnitureBySpace: ReadonlyMap<string, readonly SchemeFurniture[]>;
  readonly interiors: readonly SchemeInterior[];
}

type FurnitureItem = DesignIntent['furniture'][number];
type FurnitureAnchor = FurnitureItem['anchor'];

const WALL_SIDES: readonly Side[] = ['north', 'east', 'south', 'west'];
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;

function fail(code: ConstructorParameters<typeof IntentValidationError>[0], path: string, message: string): never {
  throw new IntentValidationError(code, path, message);
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

function anchorKey(anchor: FurnitureAnchor): string {
  if (anchor.kind === 'center') return 'center';
  if (anchor.kind === 'wall') return `wall:${anchor.side}:${String(anchor.offset)}`;
  return `corner:${anchor.corner}`;
}

/** 把家具 anchor + footprint 放进房间实际墙带内侧；室外分区不扣墙。 */
export function buildInteriors(
  intent: DesignIntent,
  rooms: readonly Room[],
  walls: readonly Wall[],
  outdoorY: number,
  defaultMaterialId: string | undefined,
  warn: (code: string, message: string, path?: string) => void,
): InteriorResult {
  const materialIds = new Set(intent.materials.map((entry) => entry.id));
  const roleMaterial = (role: string): string | null => {
    const ids = intent.materials.filter((entry) => entry.role === role).map((entry) => entry.id);
    return ids.length === 1 ? (ids[0] ?? null) : null;
  };
  const furnitureMaterial = (explicit: string | null, path: string): string => {
    const selected = explicit ?? roleMaterial('furniture') ?? defaultMaterialId;
    if (selected === undefined) {
      fail('material-ambiguous', path, '没有显式家具材质，且 role=furniture 的材质不唯一');
    }
    if (!materialIds.has(selected)) fail('reference-missing', path, `引用了不存在的材质 ${selected}`);
    return selected;
  };

  const insets = new Map(rooms.map((room) => [room.intent.id, { north: 0, east: 0, south: 0, west: 0 }]));
  for (const wall of walls) {
    for (const [roomId, side] of wall.roomSides) {
      const current = insets.get(roomId);
      if (current === undefined) continue;
      current[side] = Math.max(current[side], wall.intrusions.get(roomId) ?? 0);
    }
  }
  const innerRect = (room: Room): Rect2 => {
    const inset = insets.get(room.intent.id) ?? { north: 0, east: 0, south: 0, west: 0 };
    return {
      x: [room.rect.x[0] + inset.west, room.rect.x[1] - inset.east],
      z: [room.rect.z[0] + inset.north, room.rect.z[1] - inset.south],
    };
  };
  const hasWall = (room: Room, side: Side): boolean =>
    walls.some((wall) => wall.roomSides.get(room.intent.id) === side);

  const furnitureBySpace = new Map<string, SchemeFurniture[]>();
  const hardBySpace = new Map<string, SchemeFurniture[]>();
  for (const furniture of intent.furniture) {
    const room = rooms.find((entry) => entry.intent.id === furniture.roomId);
    const zone = intent.site.outdoorZones.find((entry) => entry.id === furniture.roomId);
    if (room === undefined && zone === undefined)
      fail('reference-missing', `furniture.${furniture.id}.roomId`, '家具目标不存在');
    if (room?.intent.kind === 'circulation')
      fail('furniture-out-of-room', `furniture.${furniture.id}.roomId`, '交通空间不生成室内家具');
    const targetId = furniture.roomId;
    const targetRect = room?.rect ?? zone?.rect;
    if (targetRect === undefined) continue;
    const inner = room === undefined ? targetRect : innerRect(room);
    const elevation = room === undefined ? outdoorY : room.level.elevation;
    const innerWidth = inner.x[1] - inner.x[0];
    const innerDepth = inner.z[1] - inner.z[0];
    if (innerWidth < 1 || innerDepth < 1) {
      fail(
        'furniture-out-of-room',
        `furniture.${furniture.id}`,
        `空间 ${targetId} 扣墙后没有可用面积，连 1×1 家具都放不下`,
      );
    }
    const height = furniture.height ?? (furniture.kind === 'shelf' || furniture.kind === 'storage' ? 2 : 1);
    if (room !== undefined && height > room.level.height) {
      fail('furniture-out-of-room', `furniture.${furniture.id}.height`, '家具高度超出层高');
    }

    const targetCenterOffset = (side: Side): number =>
      side === 'north' || side === 'south'
        ? inner.x[0] - targetRect.x[0] + Math.floor(innerWidth / 2)
        : inner.z[0] - targetRect.z[0] + Math.floor(innerDepth / 2);

    const place = (
      anchor: FurnitureAnchor,
      width: number,
      depth: number,
    ): { readonly x0: number; readonly z0: number } | null => {
      let x0: number;
      let z0: number;
      if (anchor.kind === 'center') {
        x0 = inner.x[0] + Math.floor((innerWidth - width) / 2);
        z0 = inner.z[0] + Math.floor((innerDepth - depth) / 2);
      } else if (anchor.kind === 'wall') {
        if (room === undefined || !hasWall(room, anchor.side)) return null;
        const sideLength = anchor.side === 'north' || anchor.side === 'south' ? innerWidth : innerDepth;
        if (anchor.offset < 0 || anchor.offset > sideLength) return null;
        if (anchor.side === 'north' || anchor.side === 'south') {
          x0 = targetRect.x[0] + anchor.offset - Math.floor(width / 2);
          z0 = anchor.side === 'north' ? inner.z[0] : inner.z[1] - depth;
        } else {
          x0 = anchor.side === 'west' ? inner.x[0] : inner.x[1] - width;
          z0 = targetRect.z[0] + anchor.offset - Math.floor(depth / 2);
        }
      } else {
        x0 = anchor.corner === 'ne' || anchor.corner === 'se' ? inner.x[1] - width : inner.x[0];
        z0 = anchor.corner === 'sw' || anchor.corner === 'se' ? inner.z[1] - depth : inner.z[0];
      }
      if (x0 < inner.x[0] || x0 + width > inner.x[1] || z0 < inner.z[0] || z0 + depth > inner.z[1]) {
        return null;
      }
      return { x0, z0 };
    };

    const anchors: FurnitureAnchor[] = [furniture.anchor, { kind: 'center' }];
    if (room !== undefined) {
      for (const side of WALL_SIDES) {
        if (!hasWall(room, side)) continue;
        anchors.push({ kind: 'wall', side, offset: targetCenterOffset(side) });
      }
    }
    for (const corner of CORNERS) anchors.push({ kind: 'corner', corner });
    const uniqueAnchors = [...new Map(anchors.map((anchor) => [anchorKey(anchor), anchor])).values()];

    const originalSize = { x: furniture.footprint.x, z: furniture.footprint.z };
    const sizes = [originalSize];
    const fitted = {
      x: Math.max(1, Math.min(originalSize.x, Math.floor(innerWidth))),
      z: Math.max(1, Math.min(originalSize.z, Math.floor(innerDepth))),
    };
    if (fitted.x !== originalSize.x || fitted.z !== originalSize.z) sizes.push(fitted);
    if (fitted.x !== 1 || fitted.z !== 1) sizes.push({ x: 1, z: 1 });

    let placed: {
      readonly x0: number;
      readonly z0: number;
      readonly anchor: FurnitureAnchor;
      readonly width: number;
      readonly depth: number;
    } | null = null;
    for (const size of sizes) {
      for (const anchor of uniqueAnchors) {
        const position = place(anchor, size.x, size.z);
        if (position === null) continue;
        const candidate = {
          min: [position.x0, elevation, position.z0] as const,
          max: [position.x0 + size.x, elevation + height, position.z0 + size.z] as const,
        };
        const overlaps =
          furniture.kind !== 'rug' &&
          furniture.kind !== 'light' &&
          (hardBySpace.get(targetId) ?? []).some((existing) => boundsOverlap(existing.bounds, candidate));
        if (overlaps) continue;
        placed = { ...position, anchor, width: size.x, depth: size.z };
        break;
      }
      if (placed !== null) break;
    }

    if (placed === null) {
      warn(
        'furniture-dropped',
        `家具 ${furniture.id} 无法放入空间 ${targetId}（净尺寸 ${String(innerWidth)}×${String(innerDepth)}，含既有家具占位），已丢弃`,
        `furniture.${furniture.id}`,
      );
      continue;
    }
    if (placed.width !== furniture.footprint.x || placed.depth !== furniture.footprint.z) {
      warn(
        'furniture-shrunk',
        `家具 ${furniture.id} footprint ${String(furniture.footprint.x)}×${String(furniture.footprint.z)} → ${String(
          placed.width,
        )}×${String(placed.depth)}（原因：房间净尺寸或既有家具占位）`,
        `furniture.${furniture.id}.footprint`,
      );
    }
    if (anchorKey(placed.anchor) !== anchorKey(furniture.anchor)) {
      warn(
        'furniture-relocated',
        `家具 ${furniture.id} anchor ${anchorKey(furniture.anchor)} → ${anchorKey(placed.anchor)}`,
        `furniture.${furniture.id}.anchor`,
      );
    }
    const bounds = {
      min: [placed.x0, elevation, placed.z0] as const,
      max: [placed.x0 + placed.width, elevation + height, placed.z0 + placed.depth] as const,
    };
    const spec: SchemeFurniture = {
      id: furniture.id,
      name: furniture.name,
      kind: furniture.kind,
      bounds,
      materialId: furnitureMaterial(furniture.materialId, `furniture.${furniture.id}.materialId`),
      orientation: furniture.orientation,
      notes: furniture.notes,
    };
    if (furniture.kind !== 'rug' && furniture.kind !== 'light') {
      hardBySpace.set(targetId, [...(hardBySpace.get(targetId) ?? []), spec]);
    }
    furnitureBySpace.set(targetId, [...(furnitureBySpace.get(targetId) ?? []), spec]);
  }

  const interiors: SchemeInterior[] = [];
  const ids = new Set<string>();
  const pushInterior = (spaceId: string, name: string): void => {
    const id = fitId(`interior-${spaceId}`);
    if (ids.has(id)) return;
    ids.add(id);
    const specs = furnitureBySpace.get(spaceId) ?? [];
    if (specs.length === 0) warn('interior-furniture-missing', `室内 ${spaceId} 没有结构化家具`, `interiors.${id}`);
    interiors.push({
      id,
      spaceId,
      name: `${name} 室内`,
      furniture: specs.map((spec) => spec.name),
      furnitureSpecs: specs,
      included: true,
      notes: null,
    });
  };
  for (const room of rooms) {
    if (room.intent.kind === 'room' || room.intent.kind === 'service') pushInterior(room.intent.id, room.intent.name);
  }
  for (const zone of intent.site.outdoorZones) {
    if ((furnitureBySpace.get(zone.id) ?? []).length > 0) pushInterior(zone.id, zone.name);
  }
  return { furnitureBySpace, interiors };
}
