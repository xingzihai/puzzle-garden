/* eslint-disable max-lines */
/** 墙段拓扑、共享墙去重与洞口展开；由 design-expand.ts 调用，不读写外部状态。 */
import type { Bounds } from './primitives.ts';
import { IntentValidationError } from './design-intent.ts';
import type { DesignIntent } from './design-intent.ts';
import type { Edge, Level, Room, Wall } from './design-expand-types.ts';
import type { SchemeElement, SchemeOpening, Side } from './scheme.ts';

const SIDES: readonly Side[] = ['north', 'east', 'south', 'west'];
const SIDE_LABEL: Readonly<Record<Side, string>> = { north: '北', east: '东', south: '南', west: '西' };

export interface EnvelopeResult {
  readonly elements: readonly SchemeElement[];
  readonly walls: readonly Wall[];
  readonly openings: readonly SchemeOpening[];
  readonly roomSideWalls: ReadonlyMap<string, readonly Wall[]>;
  readonly exteriorSides: ReadonlySet<Side>;
  readonly entranceSide: Side;
}

function fail(code: ConstructorParameters<typeof IntentValidationError>[0], path: string, message: string): never {
  throw new IntentValidationError(code, path, message);
}

function coordSlug(value: number): string {
  return value < 0 ? `n${String(-value).padStart(6, '0')}` : `p${String(value).padStart(6, '0')}`;
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

function edgeOf(room: Room, side: Side): Edge {
  const [x0, x1] = room.rect.x;
  const [z0, z1] = room.rect.z;
  if (side === 'north') return { room, side, axis: 'x', line: z0, start: x0, end: x1, sign: -1 };
  if (side === 'south') return { room, side, axis: 'x', line: z1, start: x0, end: x1, sign: 1 };
  if (side === 'west') return { room, side, axis: 'z', line: x0, start: z0, end: z1, sign: -1 };
  return { room, side, axis: 'z', line: x1, start: z0, end: z1, sign: 1 };
}

function alongStart(wall: Wall): number {
  return wall.axis === 'x' ? wall.bounds.min[0] : wall.bounds.min[2];
}

function alongEnd(wall: Wall): number {
  return wall.axis === 'x' ? wall.bounds.max[0] : wall.bounds.max[2];
}

function rangeOverlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function openingPriority(opening: DesignIntent['openings'][number]): number {
  if (opening.role === 'entrance') return 4;
  if (opening.kind === 'door' || opening.kind === 'gate') return 3;
  if (opening.kind === 'window') return 2;
  return 1;
}

/** 生成墙段、房间侧墙索引与洞口；洞口会按宿主墙段确定性 clamp / 合并 / 换位。 */
export function buildEnvelope(
  intent: DesignIntent,
  levels: readonly Level[],
  rooms: readonly Room[],
  _defaultMaterialId: string | undefined,
  warn: (code: string, message: string, path?: string) => void,
): EnvelopeResult {
  const materialIds = new Set(intent.materials.map((entry) => entry.id));
  const material = (id: string, path: string): string => {
    if (!materialIds.has(id)) fail('reference-missing', path, `引用了不存在的材质 ${id}`);
    return id;
  };

  const wallDefaults = intent.envelope.wallDefaults;
  const exteriorThickness = wallDefaults?.exteriorThickness ?? 1;
  const interiorThickness = wallDefaults?.interiorThickness ?? 1;
  const wallIntent = new Map(intent.envelope.walls.map((wall) => [`${wall.roomId}:${wall.side}`, wall]));
  const facadeBySide = new Map(intent.facades.map((facade) => [facade.side, facade]));
  const roomById = new Map(rooms.map((room) => [room.intent.id, room]));
  const warnedOverrides = new Set<string>();
  const warnedWallMaterials = new Set<string>();
  const wallMaterial = (
    roomSides: readonly { readonly roomId: string; readonly side: Side }[],
    explicit: string | undefined,
    path: string,
  ): string => {
    if (explicit !== undefined) return material(explicit, `${path}.materialId`);

    let selected: string | undefined;
    let reason = '';
    const wallIds = intent.materials.filter((entry) => entry.role === 'wall').map((entry) => entry.id);
    if (wallIds.length === 1) {
      selected = wallIds[0];
      reason = 'role=wall 唯一';
    }
    if (selected === undefined) {
      const sides = [...new Set([...roomSides.map((item) => item.side), ...SIDES])];
      for (const side of sides) {
        const body = facadeBySide.get(side)?.bodyMaterialId;
        if (body !== undefined && materialIds.has(body)) {
          selected = body;
          reason = roomSides.some((item) => item.side === side)
            ? `facade ${side} bodyMaterialId`
            : `任一立面 ${side} bodyMaterialId`;
          break;
        }
      }
    }
    if (selected === undefined) {
      const structureIds = intent.materials.filter((entry) => entry.role === 'structure').map((entry) => entry.id);
      if (structureIds.length === 1) {
        selected = structureIds[0];
        reason = 'role=structure 唯一';
      }
    }
    if (selected === undefined) {
      selected = [...intent.materials].sort((a, b) => a.id.localeCompare(b.id))[0]?.id;
      if (selected !== undefined) reason = '按 id 排序回退';
    }
    if (selected === undefined) {
      fail('material-ambiguous', path, `没有显式材质，且没有任何可用材质`);
    }

    const roomList = roomSides.map((item) => `${item.roomId}:${item.side}`).join(' / ');
    const message = `${roomList} 默认使用材质 ${selected}（原因：${reason}）`;
    const warningKey = `${path}:${selected}:${reason}`;
    if (!warnedWallMaterials.has(warningKey)) {
      warnedWallMaterials.add(warningKey);
      warn('default-wall-material', message, path);
    }
    return material(selected, path);
  };
  const warnKindIgnored = (roomId: string, side: Side, kind: string, derived: string): void => {
    const path = `envelope.walls.${roomId}:${side}`;
    if (warnedOverrides.has(path)) return;
    warnedOverrides.add(path);
    warn('wall-kind-ignored', `${roomId} ${side} 的 explicit kind=${kind} 已忽略，按派生${derived}`, path);
  };

  const elements: SchemeElement[] = [];
  const walls: Wall[] = [];
  const roomSideWalls = new Map<string, Wall[]>();
  const exteriorSides = new Set<Side>();
  const addWall = (wall: Wall): void => {
    walls.push(wall);
    for (const [roomId, side] of wall.roomSides) {
      const key = `${roomId}:${side}`;
      roomSideWalls.set(key, [...(roomSideWalls.get(key) ?? []), wall]);
      if (wall.exterior) exteriorSides.add(side);
    }
  };

  for (const level of levels) {
    const edges = rooms
      .filter((room) => room.level.id === level.id)
      .flatMap((room) => SIDES.map((side) => edgeOf(room, side)));
    const groups = new Map<string, { axis: 'x' | 'z'; line: number; edges: Edge[] }>();
    for (const edge of edges) {
      const key = `${edge.axis}:${String(edge.line)}`;
      const group = groups.get(key) ?? { axis: edge.axis, line: edge.line, edges: [] };
      group.edges.push(edge);
      groups.set(key, group);
    }
    const sorted = [...groups.values()].sort((a, b) =>
      a.axis === b.axis ? a.line - b.line : a.axis < b.axis ? -1 : 1,
    );
    for (const group of sorted) {
      const points = [...new Set(group.edges.flatMap((edge) => [edge.start, edge.end]))].sort((a, b) => a - b);
      for (let index = 0; index + 1 < points.length; index += 1) {
        const start = points[index];
        const end = points[index + 1];
        if (start === undefined || end === undefined || end - start < 1) continue;
        const covering = group.edges.filter((edge) => edge.start <= start && edge.end >= end);
        if (covering.length === 0) continue;
        const negativeRooms = covering.filter((edge) => edge.sign === 1);
        const positiveRooms = covering.filter((edge) => edge.sign === -1);
        const shared = covering.length === 2 && negativeRooms.length === 1 && positiveRooms.length === 1;
        if (covering.length > 1 && !shared)
          fail('room-overlap', `levels.${level.id}`, '同层房间重叠或 T 形墙段无法唯一归属');
        const roomSides = new Map<string, Side>();
        const intrusions = new Map<string, number>();
        let thickness: number;
        let exterior = true;
        let materialId: string;
        let name: string;
        if (shared) {
          const northWest = negativeRooms[0];
          const southEast = positiveRooms[0];
          if (northWest === undefined || southEast === undefined) continue;
          const a = wallIntent.get(`${northWest.room.intent.id}:${northWest.side}`);
          const b = wallIntent.get(`${southEast.room.intent.id}:${southEast.side}`);
          for (const [edge, override] of [
            [northWest, a],
            [southEast, b],
          ] as const) {
            if (override !== undefined && override.kind !== 'auto' && override.kind !== 'interior') {
              warnKindIgnored(edge.room.intent.id, edge.side, override.kind, '共享墙');
            }
          }
          if (a?.thickness !== undefined && b?.thickness !== undefined && a.thickness !== b.thickness) {
            fail(
              'wall-override-conflict',
              `envelope.walls.${northWest.room.intent.id}:${northWest.side}`,
              '共享墙两侧厚度不一致',
            );
          }
          if (a?.materialId !== undefined && b?.materialId !== undefined && a.materialId !== b.materialId) {
            fail(
              'wall-override-conflict',
              `envelope.walls.${northWest.room.intent.id}:${northWest.side}`,
              '共享墙两侧材质不一致',
            );
          }
          thickness = a?.thickness ?? b?.thickness ?? interiorThickness;
          materialId = wallMaterial(
            [
              { roomId: northWest.room.intent.id, side: northWest.side },
              { roomId: southEast.room.intent.id, side: southEast.side },
            ],
            a?.materialId ?? b?.materialId,
            `envelope.walls.${northWest.room.intent.id}:${northWest.side}.materialId`,
          );
          exterior = false;
          name = `${northWest.room.intent.name} / ${southEast.room.intent.name} 共享墙`;
          roomSides.set(northWest.room.intent.id, northWest.side);
          roomSides.set(southEast.room.intent.id, southEast.side);
          intrusions.set(northWest.room.intent.id, Math.floor(thickness / 2));
          intrusions.set(southEast.room.intent.id, thickness - Math.floor(thickness / 2));
        } else {
          const edge = covering[0];
          if (edge === undefined) continue;
          const override = wallIntent.get(`${edge.room.intent.id}:${edge.side}`);
          if (override !== undefined && override.kind !== 'auto' && override.kind !== 'exterior') {
            warnKindIgnored(edge.room.intent.id, edge.side, override.kind, '外墙');
          }
          thickness = override?.thickness ?? exteriorThickness;
          materialId = wallMaterial(
            [{ roomId: edge.room.intent.id, side: edge.side }],
            override?.materialId,
            `envelope.walls.${edge.room.intent.id}:${edge.side}.materialId`,
          );
          name = `${edge.room.intent.name} ${SIDE_LABEL[edge.side]}外墙`;
          roomSides.set(edge.room.intent.id, edge.side);
          intrusions.set(edge.room.intent.id, thickness);
        }
        const line = group.line;
        const band =
          exterior && covering[0] !== undefined && (covering[0].side === 'south' || covering[0].side === 'east')
            ? ([line - thickness, line] as const)
            : exterior
              ? ([line, line + thickness] as const)
              : ([line - Math.floor(thickness / 2), line - Math.floor(thickness / 2) + thickness] as const);
        const bounds: Bounds =
          group.axis === 'x'
            ? {
                min: [start, level.elevation, band[0]],
                max: [end, level.elevation + level.height, band[1]],
              }
            : {
                min: [band[0], level.elevation, start],
                max: [band[1], level.elevation + level.height, end],
              };
        const id = fitId(`wall-${level.id}-${group.axis}-${coordSlug(line)}-${coordSlug(start)}-${coordSlug(end)}`);
        const wall: Wall = { id, axis: group.axis, exterior, thickness, bounds, roomSides, intrusions };
        addWall(wall);
        elements.push({
          id,
          name,
          level: level.id,
          kind: 'wall',
          bounds,
          material: materialId,
          spaceId: exterior ? (covering[0]?.room.intent.id ?? null) : null,
          thickness,
          notes: null,
        });
      }
    }
  }

  interface OpeningCandidate {
    id: string;
    name: string;
    room: Room;
    host: Wall;
    side: Side;
    kind: DesignIntent['openings'][number]['kind'];
    role: DesignIntent['openings'][number]['role'];
    offset: number;
    width: number;
    height: number;
    sill: number;
    fill: string;
    frameMaterial: string | null;
    start: number;
    end: number;
    sideOrigin: number;
    order: number;
    priority: number;
  }

  interface OpeningPlacement {
    readonly host: Wall;
    readonly side: Side;
    readonly start: number;
    readonly width: number;
    readonly sideOrigin: number;
    readonly clamped: boolean;
  }

  interface RelocationCandidate {
    readonly side: Side;
    readonly host: Wall;
    readonly start: number;
    readonly length: number;
    readonly available: number;
  }

  const RELOCATION_SIDES: readonly Side[] = ['south', 'east', 'north', 'west'];
  const preferredEntranceSide = intent.site.entrance.side;
  const sideOriginFor = (room: Room, side: Side): number =>
    side === 'north' || side === 'south' ? room.rect.x[0] : room.rect.z[0];
  const metricsFor = (host: Wall): { start: number; length: number; inset: number; available: number } => {
    const start = alongStart(host);
    const length = alongEnd(host) - start;
    const inset = Math.max(0, host.thickness);
    return { start, length, inset, available: Math.max(0, length - inset * 2) };
  };
  const placementOn = (
    host: Wall,
    side: Side,
    room: Room,
    width: number,
    requestedStart: number | null,
  ): OpeningPlacement | null => {
    const metrics = metricsFor(host);
    if (width < 1 || metrics.available < width) return null;
    const minOffset = metrics.inset;
    const maxOffset = metrics.length - width - metrics.inset;
    const requestedOffset = requestedStart === null ? null : requestedStart - metrics.start;
    const rawOffset = requestedOffset ?? Math.floor((metrics.length - width) / 2);
    const offset = Math.min(Math.max(rawOffset, minOffset), maxOffset);
    return {
      host,
      side,
      start: metrics.start + offset,
      width,
      sideOrigin: sideOriginFor(room, side),
      clamped: requestedOffset !== null && offset !== requestedOffset,
    };
  };
  const relocationCandidates = (
    room: Room,
    oldSide: Side,
    excludeHostId: string,
    mode: 'entrance-door' | 'window',
  ): RelocationCandidate[] => {
    const candidates: RelocationCandidate[] = [];
    for (const side of SIDES) {
      for (const host of roomSideWalls.get(`${room.intent.id}:${side}`) ?? []) {
        if (!host.exterior || host.id === excludeHostId) continue;
        const metrics = metricsFor(host);
        candidates.push({ side, host, start: metrics.start, length: metrics.length, available: metrics.available });
      }
    }
    const rank = (side: Side): number => {
      if (mode === 'entrance-door' && side === preferredEntranceSide) return 0;
      if (mode === 'window' && side === oldSide) return 0;
      return 1 + RELOCATION_SIDES.indexOf(side);
    };
    return candidates.sort((a, b) => rank(a.side) - rank(b.side) || b.available - a.available || a.start - b.start);
  };
  const bestShrinkPlacement = (
    room: Room,
    host: Wall,
    oldSide: Side,
    width: number,
    requestedStart: number,
  ): OpeningPlacement | null => {
    const hostMetrics = metricsFor(host);
    if (hostMetrics.available >= 1) {
      const shrunkWidth = Math.min(width, Math.floor(hostMetrics.available));
      return placementOn(host, oldSide, room, shrunkWidth, requestedStart);
    }
    const candidates = relocationCandidates(room, oldSide, host.id, 'window');
    const best = [...candidates]
      .filter((candidate) => candidate.available >= 1)
      .sort((a, b) => b.available - a.available || a.start - b.start)[0];
    if (best === undefined) return null;
    const shrunkWidth = Math.min(width, Math.floor(best.available));
    return placementOn(best.host, best.side, room, shrunkWidth, null);
  };
  const entranceFailure = (room: Room, openingId: string, width: number): never => {
    const available = SIDES.flatMap((side) =>
      (roomSideWalls.get(`${room.intent.id}:${side}`) ?? [])
        .filter((host) => host.exterior)
        .map((host) => {
          const metrics = metricsFor(host);
          return `${side} 长${String(metrics.length)}/可用${String(metrics.available)}`;
        }),
    );
    fail(
      'entrance-invalid',
      `openings.${openingId}`,
      `入口 ${openingId} 宽 ${String(width)} 在所有外墙都放不下；可用墙段：${available.length > 0 ? available.join('、') : '无'}`,
    );
  };

  const candidates: OpeningCandidate[] = [];
  for (const [order, opening] of intent.openings.entries()) {
    const room = roomById.get(opening.roomId);
    if (room === undefined)
      fail('reference-missing', `openings.${opening.id}.roomId`, `洞口引用了不存在的房间 ${opening.roomId}`);
    const sideOrigin = sideOriginFor(room, opening.side);
    const requestedStart = sideOrigin + opening.offset;
    const requestedEnd = requestedStart + opening.width;
    const hostWalls = roomSideWalls.get(`${room.intent.id}:${opening.side}`) ?? [];
    if (hostWalls.length === 0) {
      fail('opening-out-of-wall', `openings.${opening.id}`, `洞口 ${opening.id} 所在的 ${opening.side} 侧没有墙`);
    }
    const host = [...hostWalls].sort((a, b) => {
      const overlap = (wall: Wall): number =>
        Math.max(0, Math.min(requestedEnd, alongEnd(wall)) - Math.max(requestedStart, alongStart(wall)));
      const overlapDiff = overlap(b) - overlap(a);
      if (overlapDiff !== 0) return overlapDiff;
      const distance = (wall: Wall): number =>
        requestedStart < alongStart(wall)
          ? alongStart(wall) - requestedStart
          : requestedStart > alongEnd(wall)
            ? requestedStart - alongEnd(wall)
            : 0;
      return distance(a) - distance(b) || alongStart(a) - alongStart(b);
    })[0];
    if (host === undefined) {
      fail('opening-out-of-wall', `openings.${opening.id}`, `洞口 ${opening.id} 找不到宿主墙段`);
    }
    const hostMetrics = metricsFor(host);
    const isEntrance = opening.role === 'entrance';
    const isDoorLike = isEntrance || opening.kind === 'door' || opening.kind === 'gate';
    const entranceNeedsExterior = isEntrance && !host.exterior;
    let placement: OpeningPlacement | null = null;
    let relocated = false;
    if (hostMetrics.available >= opening.width && !entranceNeedsExterior) {
      placement = placementOn(host, opening.side, room, opening.width, requestedStart);
    } else {
      const candidatesForRelocation = relocationCandidates(
        room,
        opening.side,
        host.id,
        isDoorLike ? 'entrance-door' : 'window',
      );
      const fullWidth = candidatesForRelocation.find((candidate) => candidate.available >= opening.width);
      if (fullWidth !== undefined) {
        placement = placementOn(fullWidth.host, fullWidth.side, room, opening.width, null);
        relocated = placement !== null;
      }
      if (placement === null && !isEntrance) {
        placement = bestShrinkPlacement(room, host, opening.side, opening.width, requestedStart);
        if (placement !== null) relocated = placement.host.id !== host.id;
      }
      if (placement === null && isEntrance) {
        entranceFailure(room, opening.id, opening.width);
      }
      if (placement === null) {
        warn(
          'opening-dropped',
          `洞口 ${opening.id} 在 ${opening.side} 墙段宽 ${String(opening.width)} 放不下，且其他外墙没有可用长度，已丢弃`,
          `openings.${opening.id}`,
        );
        continue;
      }
    }
    if (placement === null) continue;
    if (relocated) {
      const newMetrics = metricsFor(placement.host);
      const reason = entranceNeedsExterior
        ? `入口 ${opening.id} 必须位于外墙，原 ${opening.side} 侧宿主不是外墙`
        : `原 ${opening.side} 墙段可用 ${String(hostMetrics.available)} 格放不下宽 ${String(opening.width)}`;
      warn(
        'opening-relocated-short-wall',
        `洞口 ${opening.id}：${reason}，迁移到 ${placement.side} 墙段（长 ${String(newMetrics.length)}，可用 ${String(newMetrics.available)}）`,
        `openings.${opening.id}.side`,
      );
    }
    if (placement.width !== opening.width) {
      const newMetrics = metricsFor(placement.host);
      warn(
        'opening-shrunk',
        `洞口 ${opening.id} 宽度 ${String(opening.width)} → ${String(placement.width)}（原因：${
          relocated ? `${placement.side} 墙段` : '宿主墙段'
        }可用长度 ${String(newMetrics.available)} 格）`,
        `openings.${opening.id}.width`,
      );
    }
    if (placement.clamped) {
      const newOffset = placement.start - placement.sideOrigin;
      const placementMetrics = metricsFor(placement.host);
      warn(
        'opening-clamped',
        `洞口 ${opening.id} offset ${String(opening.offset)} → ${String(newOffset)}（原因：墙段合法区间 ${String(
          placementMetrics.inset,
        )}..${String(placementMetrics.length - placement.width - placementMetrics.inset)}）`,
        `openings.${opening.id}.offset`,
      );
    }
    candidates.push({
      id: opening.id,
      name: opening.name,
      room,
      host: placement.host,
      side: placement.side,
      kind: opening.kind,
      role: opening.role,
      offset: placement.start - placement.sideOrigin,
      width: placement.width,
      height: opening.height,
      sill: opening.sill,
      fill: opening.fill,
      frameMaterial:
        opening.frameMaterial === null ? null : material(opening.frameMaterial, `openings.${opening.id}.frameMaterial`),
      start: placement.start,
      end: placement.start + placement.width,
      sideOrigin: placement.sideOrigin,
      order,
      priority: openingPriority(opening),
    });
  }

  // 同墙段 + 同优先级 + 同 kind：重叠的洞口合并为 union。
  const groups = new Map<string, OpeningCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.host.id}:${String(candidate.priority)}:${candidate.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const mergedCandidates: OpeningCandidate[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start || a.order - b.order);
    const merged: OpeningCandidate[] = [];
    for (const candidate of group) {
      const previous = merged[merged.length - 1];
      if (previous !== undefined && rangeOverlaps(previous.start, previous.end, candidate.start, candidate.end)) {
        const oldStart = previous.start;
        const oldEnd = previous.end;
        previous.start = Math.min(previous.start, candidate.start);
        previous.end = Math.max(previous.end, candidate.end);
        previous.width = previous.end - previous.start;
        previous.height = Math.max(previous.height, candidate.height);
        previous.order = Math.min(previous.order, candidate.order);
        warn(
          'opening-merged',
          `洞口 ${candidate.id} 与 ${previous.id} 同墙段同类型重叠，合并为 ${previous.id}（${String(
            oldStart,
          )}..${String(oldEnd)} → ${String(previous.start)}..${String(previous.end)}）`,
          `openings.${candidate.id}`,
        );
      } else {
        merged.push({ ...candidate });
      }
    }
    mergedCandidates.push(...merged);
  }

  // 高优先级先保留；低优先级在剩余墙段内左对齐移开 / 缩窄，仍放不下则丢弃。
  mergedCandidates.sort(
    (a, b) =>
      b.priority - a.priority || b.width * b.height - a.width * a.height || a.start - b.start || a.order - b.order,
  );
  const acceptedByHost = new Map<string, OpeningCandidate[]>();
  for (const candidate of mergedCandidates) {
    const accepted = acceptedByHost.get(candidate.host.id) ?? [];
    const overlaps = accepted.filter((existing) =>
      rangeOverlaps(candidate.start, candidate.end, existing.start, existing.end),
    );
    if (overlaps.length === 0) {
      accepted.push(candidate);
      acceptedByHost.set(candidate.host.id, accepted);
      continue;
    }
    const hostStart = alongStart(candidate.host);
    const hostEnd = alongEnd(candidate.host);
    const occupied = [...accepted].sort((a, b) => a.start - b.start);
    const gaps: { readonly start: number; readonly end: number }[] = [];
    let cursor = hostStart;
    for (const existing of occupied) {
      if (existing.start > cursor) gaps.push({ start: cursor, end: Math.min(existing.start, hostEnd) });
      cursor = Math.max(cursor, existing.end);
    }
    if (cursor < hostEnd) gaps.push({ start: cursor, end: hostEnd });
    const originalWidth = candidate.width;
    let placed = false;
    let action: 'relocated' | 'shrunk' | null = null;
    for (const gap of gaps) {
      if (gap.end - gap.start >= candidate.width) {
        candidate.start = gap.start;
        candidate.end = gap.start + candidate.width;
        placed = true;
        action = 'relocated';
        break;
      }
    }
    if (!placed) {
      const shrinkGaps = [...gaps].sort((a, b) => b.end - b.start - (a.end - a.start));
      for (const gap of shrinkGaps) {
        if (gap.end - gap.start >= 1) {
          candidate.start = gap.start;
          candidate.end = gap.end;
          candidate.width = gap.end - gap.start;
          placed = true;
          action = 'shrunk';
          break;
        }
      }
    }
    if (!placed) {
      if (candidate.role === 'entrance') {
        fail('entrance-invalid', `openings.${candidate.id}`, '入口被同墙段洞口覆盖且没有可用间距');
      }
      warn(
        'opening-dropped',
        `洞口 ${candidate.id} 被同墙段更高优先级洞口 ${overlaps.map((item) => item.id).join('、')} 覆盖，且没有可用间距，已丢弃`,
        `openings.${candidate.id}`,
      );
      continue;
    }
    candidate.offset = candidate.start - candidate.sideOrigin;
    warn(
      action === 'shrunk' ? 'opening-shrunk' : 'opening-relocated',
      action === 'shrunk'
        ? `洞口 ${candidate.id} 与 ${overlaps.map((item) => item.id).join('、')} 重叠，宽度 ${String(
            originalWidth,
          )} → ${String(candidate.width)}，offset=${String(candidate.offset)}`
        : `洞口 ${candidate.id} 与 ${overlaps.map((item) => item.id).join('、')} 重叠，已移到 offset=${String(
            candidate.offset,
          )}`,
      `openings.${candidate.id}`,
    );
    accepted.push(candidate);
    acceptedByHost.set(candidate.host.id, accepted);
  }

  const resolved = [...acceptedByHost.values()].flat().sort((a, b) => a.order - b.order);
  const entrance = resolved.find((candidate) => candidate.role === 'entrance');
  if (entrance === undefined) fail('entrance-invalid', 'openings', '至少需要一个 entrance 洞口');
  if (entrance.side !== intent.site.entrance.side) {
    warn(
      'entrance-side-updated',
      `主 entrance ${entrance.id} 展开后位于 ${entrance.side} 侧；场地入口侧 ${intent.site.entrance.side} → ${entrance.side}，预览与报告按新侧生成`,
      'site.entrance.side',
    );
  }
  const openings: SchemeOpening[] = resolved.map((candidate) => {
    const y0 = candidate.room.level.elevation + candidate.sill;
    const y1 = y0 + candidate.height;
    const bounds: Bounds =
      candidate.host.axis === 'x'
        ? {
            min: [candidate.start, y0, candidate.host.bounds.min[2]],
            max: [candidate.end, y1, candidate.host.bounds.max[2]],
          }
        : {
            min: [candidate.host.bounds.min[0], y0, candidate.start],
            max: [candidate.host.bounds.max[0], y1, candidate.end],
          };
    return {
      id: candidate.id,
      name: candidate.name,
      level: candidate.room.level.id,
      host: candidate.host.id,
      kind: candidate.kind,
      side: candidate.side,
      bounds,
      fill: candidate.fill,
      frameMaterial: candidate.frameMaterial,
      notes: null,
    };
  });

  return { elements, walls, openings, roomSideWalls, exteriorSides, entranceSide: entrance.side };
}
