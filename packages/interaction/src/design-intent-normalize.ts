/* eslint-disable max-lines */
/** Draft → 严格 DesignIntent 的宿主归一化；别名、默认值与警告都在这里。 */
import type { z } from 'zod';

import { DesignIntent, IntentValidationError, rectsOverlap } from './design-intent.ts';
import type { Rect2 } from './design-intent.ts';
import { DesignIntentDraft } from './design-intent-draft.ts';
import type { DraftRect2 } from './design-intent-draft.ts';
import type { OpeningKind, StructureSystem } from './scheme.ts';

export interface IntentNormalizationWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}
export interface NormalizedDesignIntent {
  readonly intent: DesignIntent;
  readonly warnings: readonly IntentNormalizationWarning[];
}
function normalizeError(error: z.ZodError, label: string): IntentValidationError {
  const shown = error.issues.slice(0, 30);
  const first = shown[0];
  const path = first?.path.map(String).join('.') ?? '';
  const lines = shown.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
  const more = error.issues.length > shown.length ? `；另有 ${String(error.issues.length - shown.length)} 条问题` : '';
  return new IntentValidationError('schema-invalid', path, `${label}：${lines.join('；')}${more}`);
}
function roundValue(value: number, path: string, label: string, warnings: IntentNormalizationWarning[]): number {
  const rounded = Math.round(value);
  if (rounded !== value) {
    warnings.push({
      code: 'non-integer-rounded',
      path,
      message: `${label} ${String(value)} → ${String(rounded)}`,
    });
  }
  return rounded;
}
function dropNotes(notes: string | null | undefined, path: string, warnings: IntentNormalizationWarning[]): void {
  if (notes !== undefined && notes !== null) {
    warnings.push({ code: 'notes-dropped', path, message: `${path} 不在严格 DesignIntent 中，已丢弃` });
  }
}
function normalizeRect(rect: z.infer<typeof DraftRect2>, path: string, warnings: IntentNormalizationWarning[]): Rect2 {
  const x0 = roundValue(rect.x[0], `${path}.x.0`, 'x0', warnings);
  const x1 = roundValue(rect.x[1], `${path}.x.1`, 'x1', warnings);
  const z0 = roundValue(rect.z[0], `${path}.z.0`, 'z0', warnings);
  const z1 = roundValue(rect.z[1], `${path}.z.1`, 'z1', warnings);
  if (x1 <= x0) throw new IntentValidationError('schema-invalid', `${path}.x`, `矩形 x 必须 x1 > x0`);
  if (z1 <= z0) throw new IntentValidationError('schema-invalid', `${path}.z`, `矩形 z 必须 z1 > z0`);
  return { x: [x0, x1], z: [z0, z1] };
}
function defaultFill(kind: z.infer<typeof OpeningKind>): string {
  switch (kind) {
    case 'door':
      return '木门';
    case 'window':
      return '玻璃';
    case 'gate':
      return '院门';
    case 'opening':
      return '洞口';
  }
}
const SYSTEMS: readonly StructureSystem[] = ['load-bearing-walls', 'post-and-beam', 'frame', 'mixed'];
const SYSTEM_ALIASES: Readonly<Record<string, StructureSystem>> = {
  'load-bearing-walls': 'load-bearing-walls',
  'loadbearing-walls': 'load-bearing-walls',
  loadbearing: 'load-bearing-walls',
  masonry: 'load-bearing-walls',
  砖混: 'load-bearing-walls',
  'post-and-beam': 'post-and-beam',
  postandbeam: 'post-and-beam',
  'post-beam': 'post-and-beam',
  'timber-frame': 'post-and-beam',
  'wood-frame': 'post-and-beam',
  timber: 'post-and-beam',
  wood: 'post-and-beam',
  梁柱: 'post-and-beam',
  木构: 'post-and-beam',
  frame: 'frame',
  'concrete-frame': 'frame',
  'steel-frame': 'frame',
  框架: 'frame',
  mixed: 'mixed',
  混合: 'mixed',
};
function inferStructureSystem(value: string): StructureSystem | undefined {
  const text = value.toLowerCase();
  if (/砖混|承重墙|load.?bearing|masonry/.test(text)) return 'load-bearing-walls';
  if (/木构|梁柱|木框架|timber|wood|post.?and.?beam/.test(text)) return 'post-and-beam';
  if (/框架|frame|steel|concrete/.test(text)) return 'frame';
  if (/混合|mixed/.test(text)) return 'mixed';
  return undefined;
}
function normalizeStructureSystem(value: string, warnings: IntentNormalizationWarning[]): StructureSystem {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  const mapped = SYSTEM_ALIASES[key] ?? inferStructureSystem(value);
  if (mapped !== undefined) {
    if (mapped !== value) {
      warnings.push({
        code: 'structure-system-alias',
        path: 'structure.system',
        message: `${value} → ${mapped}`,
      });
    }
    return mapped;
  }
  throw new IntentValidationError(
    'schema-invalid',
    'structure.system',
    `不支持的 structure.system ${value}；只接受 ${SYSTEMS.join(' / ')} 或明确别名`,
  );
}
function pitchFromAlias(value: number, path: string, warnings: IntentNormalizationWarning[]): number {
  if (!Number.isFinite(value) || value < 0 || value > 90) {
    throw new IntentValidationError('schema-invalid', path, `屋面坡度 ${String(value)} 必须在 0..90`);
  }
  const degrees = value <= 1 ? (Math.atan(value) * 180) / Math.PI : value;
  warnings.push({
    code: value <= 1 ? 'roof-slope-ratio' : 'roof-pitch-degrees',
    path,
    message: `${path}=${String(value)} → pitchDegrees=${String(Math.round(degrees * 10) / 10)}`,
  });
  return Math.round(degrees * 10) / 10;
}
function normalizeRoofPitch(
  roof: z.infer<typeof DesignIntentDraft>['roof'],
  warnings: IntentNormalizationWarning[],
): number | undefined {
  if (roof.pitchDegrees !== undefined) {
    if (roof.pitch !== undefined || roof.slope !== undefined) {
      warnings.push({
        code: 'roof-pitch-conflict',
        path: 'roof',
        message: 'pitchDegrees 与 pitch / slope 同时出现，采用 pitchDegrees',
      });
    }
    return roof.pitchDegrees;
  }
  if (roof.pitch !== undefined) return pitchFromAlias(roof.pitch, 'roof.pitch', warnings);
  if (roof.slope !== undefined) return pitchFromAlias(roof.slope, 'roof.slope', warnings);
  return undefined;
}
type DraftFacade = DesignIntentDraft['facades'][number];
type DraftFacadeLayer = NonNullable<DraftFacade['layers']>[number];
type DraftMaterial = DesignIntentDraft['materials'][number];
function resolveFacadeMaterial(
  reference: string,
  path: string,
  materials: readonly DraftMaterial[],
  warnings: IntentNormalizationWarning[],
): string {
  const byId = materials.find((material) => material.id === reference);
  if (byId !== undefined) return byId.id;
  const byBlock = materials.find((material) => material.block === reference);
  if (byBlock !== undefined) {
    warnings.push({ code: 'facade-material-block-alias', path, message: `${reference} → ${byBlock.id}` });
    return byBlock.id;
  }
  const byName = materials.find((material) => material.name === reference);
  if (byName !== undefined) {
    warnings.push({ code: 'facade-material-name-alias', path, message: `${reference} → ${byName.id}` });
    return byName.id;
  }
  throw new IntentValidationError('schema-invalid', path, `立面材质 ${reference} 无法解析到 materials`);
}
function layerMaterialId(
  layer: DraftFacadeLayer,
  path: string,
  materials: readonly DraftMaterial[],
  warnings: IntentNormalizationWarning[],
): string | undefined {
  dropNotes(layer.notes, `${path}.notes`, warnings);
  if (
    layer.from !== undefined ||
    layer.to !== undefined ||
    layer.height !== undefined ||
    layer.thickness !== undefined
  ) {
    warnings.push({
      code: 'facade-layer-geometry-ignored',
      path,
      message: 'layers 的 from/to/height/thickness 不改变严格 DesignIntent 几何，已忽略',
    });
  }
  const reference = layer.materialId ?? layer.material ?? layer.block ?? layer.name;
  return reference === undefined
    ? undefined
    : resolveFacadeMaterial(reference, `${path}.material`, materials, warnings);
}
function facadeMaterials(
  facade: DraftFacade,
  index: number,
  materials: readonly DraftMaterial[],
  warnings: IntentNormalizationWarning[],
): { readonly base: string; readonly body: string; readonly top: string | null } {
  const path = `facades.${String(index)}`;
  let base = facade.baseMaterialId;
  let body = facade.bodyMaterialId;
  let top = facade.topMaterialId ?? null;
  const layers = facade.layers ?? [];
  layers.forEach((layer, layerIndex) => {
    const materialId = layerMaterialId(layer, `${path}.layers.${String(layerIndex)}`, materials, warnings);
    if (materialId === undefined) return;
    const role =
      layer.role ?? (layerIndex === 0 ? 'base' : layerIndex === 1 ? 'body' : layerIndex === 2 ? 'top' : undefined);
    if (role === 'base' && base === undefined) base = materialId;
    else if (
      (role === 'body' || role === 'wall' || role === 'structure' || role === 'accent' || role === 'other') &&
      body === undefined
    )
      body = materialId;
    else if ((role === 'top' || role === 'roof') && top === null) top = materialId;
  });
  if (base === undefined) {
    base = materials.find((material) => material.role === 'structure' || material.role === 'wall')?.id;
    if (base !== undefined) {
      warnings.push({
        code: 'facade-material-default',
        path: `${path}.baseMaterialId`,
        message: `补默认 base ${base}`,
      });
    }
  }
  if (body === undefined) {
    body = materials.find((material) => material.role === 'wall' || material.role === 'structure')?.id;
    if (body !== undefined) {
      warnings.push({
        code: 'facade-material-default',
        path: `${path}.bodyMaterialId`,
        message: `补默认 body ${body}`,
      });
    }
  }
  if (base === undefined || body === undefined) {
    throw new IntentValidationError(
      'schema-invalid',
      path,
      '立面缺 baseMaterialId / bodyMaterialId，且 materials 无法补默认',
    );
  }
  if (top === null) {
    const roof = materials.find((material) => material.role === 'roof');
    if (roof !== undefined) {
      top = roof.id;
      warnings.push({
        code: 'facade-material-default',
        path: `${path}.topMaterialId`,
        message: `补默认 top ${roof.id}`,
      });
    }
  }
  return { base, body, top };
}
/** 把 draft 归一化成严格 DesignIntent；不可修复的几何 / 类型错误直接抛出可定位错误。 */
export function normalizeDesignIntent(draft: unknown): NormalizedDesignIntent {
  const parsed = DesignIntentDraft.safeParse(draft);
  if (!parsed.success) throw normalizeError(parsed.error, 'DesignIntentDraft');
  const value = parsed.data;
  const warnings: IntentNormalizationWarning[] = [];
  dropNotes(value.meta.notes, 'meta.notes', warnings);
  dropNotes(value.program.notes, 'program.notes', warnings);
  dropNotes(value.envelope.notes, 'envelope.notes', warnings);
  const meta = { title: value.meta.title, concept: value.meta.concept, scope: value.meta.scope };

  const site = {
    bounds: normalizeRect(value.site.bounds, 'site.bounds', warnings),
    orientation: value.site.orientation,
    entrance: { side: value.site.entrance.side, notes: value.site.entrance.notes ?? null },
    outdoorZones: value.site.outdoorZones.map((zone, index) => {
      const path = `site.outdoorZones.${String(index)}`;
      return {
        id: zone.id,
        name: zone.name,
        kind: zone.kind,
        rect: normalizeRect(zone.rect, `${path}.rect`, warnings),
        materialId: zone.materialId,
        notes: zone.notes ?? null,
      };
    }),
    notes: value.site.notes ?? null,
  };

  const levels = value.program.levels.map((level, index) => {
    const path = `program.levels.${String(index)}`;
    dropNotes(level.notes, `${path}.notes`, warnings);
    return {
      id: level.id,
      name: level.name,
      height: roundValue(level.height, `${path}.height`, 'height', warnings),
      floorMaterialId: level.floorMaterialId,
      ...(level.elevation === undefined
        ? {}
        : { elevation: roundValue(level.elevation, `${path}.elevation`, 'elevation', warnings) }),
    };
  });
  const rooms = value.program.rooms.map((room, index) => {
    const path = `program.rooms.${String(index)}`;
    return {
      id: room.id,
      name: room.name,
      level: room.level,
      kind: room.kind,
      rect: normalizeRect(room.rect, `${path}.rect`, warnings),
      ...(room.areaM2 === undefined ? {} : { areaM2: room.areaM2 }),
      occupancy: roundValue(room.occupancy, `${path}.occupancy`, 'occupancy', warnings),
      adjacency: room.adjacency,
      daylight: room.daylight,
      notes: room.notes ?? null,
    };
  });

  const droppedZoneIds = new Set<string>();
  const outdoorZones = site.outdoorZones.filter((zone) => {
    const room = rooms.find((candidate) => rectsOverlap(zone.rect, candidate.rect));
    if (room === undefined) return true;
    droppedZoneIds.add(zone.id);
    warnings.push({
      code: 'outdoor-zone-overlap-dropped',
      path: `site.outdoorZones.${zone.id}`,
      message: `室外分区 ${zone.id} 与房间 ${room.id} 重叠，已丢弃该室外分区，不影响室内几何；如需保留请调整分区或房间`,
    });
    return false;
  });
  const siteWithZones = { ...site, outdoorZones };

  const wallDefaults =
    value.envelope.wallDefaults === undefined
      ? undefined
      : (() => {
          dropNotes(value.envelope.wallDefaults.notes, 'envelope.wallDefaults.notes', warnings);
          return {
            ...(value.envelope.wallDefaults.exteriorThickness === undefined
              ? {}
              : {
                  exteriorThickness: roundValue(
                    value.envelope.wallDefaults.exteriorThickness,
                    'envelope.wallDefaults.exteriorThickness',
                    'exteriorThickness',
                    warnings,
                  ),
                }),
            ...(value.envelope.wallDefaults.interiorThickness === undefined
              ? {}
              : {
                  interiorThickness: roundValue(
                    value.envelope.wallDefaults.interiorThickness,
                    'envelope.wallDefaults.interiorThickness',
                    'interiorThickness',
                    warnings,
                  ),
                }),
          };
        })();
  if (value.envelope.walls === undefined) {
    warnings.push({ code: 'envelope-walls-default', path: 'envelope.walls', message: '未写 walls，按 [] 处理' });
  }
  const walls = (value.envelope.walls ?? []).map((wall, index) => {
    const path = `envelope.walls.${String(index)}`;
    dropNotes(wall.notes, `${path}.notes`, warnings);
    return {
      roomId: wall.roomId,
      side: wall.side,
      kind: wall.kind,
      ...(wall.thickness === undefined
        ? {}
        : { thickness: roundValue(wall.thickness, `${path}.thickness`, 'thickness', warnings) }),
      ...(wall.materialId === undefined ? {} : { materialId: wall.materialId }),
    };
  });
  if (value.envelope.stairs === undefined) {
    warnings.push({
      code: 'envelope-stairs-default',
      path: 'envelope.stairs',
      message: '未写 stairs；单层按 [] 处理，多层仍会校验垂直交通',
    });
  }
  const stairs = (value.envelope.stairs ?? []).map((stair, index) => {
    const path = `envelope.stairs.${String(index)}`;
    dropNotes(stair.notes, `${path}.notes`, warnings);
    return {
      id: stair.id,
      name: stair.name,
      roomId: stair.roomId,
      fromLevel: stair.fromLevel,
      toLevel: stair.toLevel,
      start: {
        x: roundValue(stair.start.x, `${path}.start.x`, 'start.x', warnings),
        z: roundValue(stair.start.z, `${path}.start.z`, 'start.z', warnings),
      },
      direction: stair.direction,
      width: roundValue(stair.width, `${path}.width`, 'width', warnings),
      treads: roundValue(stair.treads, `${path}.treads`, 'treads', warnings),
      ...(stair.materialId === undefined ? {} : { materialId: stair.materialId }),
    };
  });

  const openings = value.openings.map((opening, index) => {
    const path = `openings.${String(index)}`;
    dropNotes(opening.notes, `${path}.notes`, warnings);
    const offset = roundValue(opening.offset, `${path}.offset`, 'offset', warnings);
    const width = roundValue(opening.width, `${path}.width`, 'width', warnings);
    const height = roundValue(opening.height, `${path}.height`, 'height', warnings);
    const sill = roundValue(opening.sill, `${path}.sill`, 'sill', warnings);
    if (offset < 0) throw new IntentValidationError('schema-invalid', `${path}.offset`, 'offset 不能为负数');
    if (width < 1) throw new IntentValidationError('schema-invalid', `${path}.width`, 'width 必须 ≥ 1');
    if (height < 1) throw new IntentValidationError('schema-invalid', `${path}.height`, 'height 必须 ≥ 1');
    if (sill < 0) throw new IntentValidationError('schema-invalid', `${path}.sill`, 'sill 不能为负数');
    const name = opening.name;
    if (name === undefined || name === null) {
      warnings.push({
        code: 'opening-name-default',
        path: `${path}.name`,
        message: `补默认 name op-${String(index + 1)}`,
      });
    }
    const fill = opening.fill;
    if (fill === undefined || fill === null) {
      warnings.push({
        code: 'opening-fill-default',
        path: `${path}.fill`,
        message: `按 kind=${opening.kind} 补默认 fill ${defaultFill(opening.kind)}`,
      });
    }
    if (opening.roomId !== undefined && opening.hostRoomId !== undefined && opening.roomId !== opening.hostRoomId) {
      warnings.push({
        code: 'opening-host-room-conflict',
        path: `${path}.roomId`,
        message: `roomId=${opening.roomId} 与 hostRoomId=${opening.hostRoomId} 不一致，采用 roomId`,
      });
    }
    const roomId = opening.roomId ?? opening.hostRoomId;
    if (roomId === undefined) throw new IntentValidationError('schema-invalid', `${path}.roomId`, '洞口缺 roomId');
    if (opening.roomId === undefined) {
      warnings.push({
        code: 'opening-hostRoomId-alias',
        path: `${path}.roomId`,
        message: `hostRoomId → roomId (${roomId})`,
      });
    }
    return {
      id: opening.id,
      name: name ?? `op-${String(index + 1)}`,
      roomId,
      side: opening.side,
      kind: opening.kind,
      role: opening.role ?? 'interior',
      offset,
      width,
      height,
      sill,
      fill: fill ?? defaultFill(opening.kind),
      frameMaterial: opening.frameMaterial ?? null,
    };
  });

  if (
    value.structure.floorThickness !== undefined &&
    value.structure.slabThickness !== undefined &&
    value.structure.floorThickness !== value.structure.slabThickness
  ) {
    warnings.push({
      code: 'structure-slab-thickness-conflict',
      path: 'structure.slabThickness',
      message: `floorThickness=${String(value.structure.floorThickness)} 与 slabThickness=${String(value.structure.slabThickness)} 不一致，采用 floorThickness`,
    });
  }
  const slabThickness = value.structure.floorThickness ?? value.structure.slabThickness;
  if (value.structure.floorThickness === undefined && value.structure.slabThickness !== undefined) {
    warnings.push({
      code: 'structure-slabThickness-alias',
      path: 'structure.floorThickness',
      message: `slabThickness → floorThickness (${String(value.structure.slabThickness)})`,
    });
  }
  const structure = {
    system: normalizeStructureSystem(value.structure.system, warnings),
    materialId: value.structure.materialId,
    ...(slabThickness === undefined
      ? {}
      : { floorThickness: roundValue(slabThickness, 'structure.floorThickness', 'floorThickness', warnings) }),
    ...(value.structure.cantilever === undefined
      ? {}
      : { cantilever: roundValue(value.structure.cantilever, 'structure.cantilever', 'cantilever', warnings) }),
    notes: value.structure.notes ?? null,
  };

  const pitchDegrees = normalizeRoofPitch(value.roof, warnings);
  const roofSegments = value.roof.segments?.map((segment, index) => {
    const path = `roof.segments.${String(index)}`;
    dropNotes(segment.notes, `${path}.notes`, warnings);
    return {
      id: segment.id,
      rect: normalizeRect(segment.rect, `${path}.rect`, warnings),
      form: segment.form,
      materialId: segment.materialId,
      ...(segment.pitchDegrees === undefined
        ? {}
        : { pitchDegrees: roundValue(segment.pitchDegrees, `${path}.pitchDegrees`, 'pitchDegrees', warnings) }),
      overhang: roundValue(segment.overhang, `${path}.overhang`, 'overhang', warnings),
    };
  });
  const roof = {
    form: value.roof.form,
    materialId: value.roof.materialId,
    ...(pitchDegrees === undefined ? {} : { pitchDegrees }),
    overhang: roundValue(value.roof.overhang, 'roof.overhang', 'overhang', warnings),
    ...(value.roof.ridgeAxis === undefined ? {} : { ridgeAxis: value.roof.ridgeAxis }),
    drainage: value.roof.drainage ?? null,
    skylights: value.roof.skylights ?? [],
    notes: value.roof.notes ?? null,
    ...(roofSegments === undefined ? {} : { segments: roofSegments }),
  };

  const facades = value.facades.map((facade, index) => {
    const path = `facades.${String(index)}`;
    const materials = facadeMaterials(facade, index, value.materials, warnings);
    return {
      side: facade.side,
      baseMaterialId: materials.base,
      bodyMaterialId: materials.body,
      topMaterialId: materials.top,
      ...(facade.bays === undefined ? {} : { bays: roundValue(facade.bays, `${path}.bays`, 'bays', warnings) }),
      windowWallRatio: facade.windowWallRatio ?? null,
      notes: facade.notes ?? null,
    };
  });

  const materials = value.materials.map((material) => ({
    id: material.id,
    name: material.name,
    block: material.block,
    role: material.role,
    color: material.color ?? null,
    notes: material.notes ?? null,
  }));

  const furniture = value.furniture
    .map((item, index) => {
      const path = `furniture.${String(index)}`;
      dropNotes(item.anchor.notes, `${path}.anchor.notes`, warnings);
      const anchor =
        item.anchor.kind === 'wall'
          ? {
              kind: 'wall' as const,
              side: item.anchor.side,
              offset: roundValue(item.anchor.offset, `${path}.anchor.offset`, 'anchor.offset', warnings),
            }
          : item.anchor.kind === 'corner'
            ? { kind: 'corner' as const, corner: item.anchor.corner }
            : { kind: 'center' as const };
      return {
        id: item.id,
        name: item.name,
        kind: item.kind,
        roomId: item.roomId,
        anchor,
        footprint: {
          x: roundValue(item.footprint.x, `${path}.footprint.x`, 'footprint.x', warnings),
          z: roundValue(item.footprint.z, `${path}.footprint.z`, 'footprint.z', warnings),
        },
        orientation: item.orientation,
        ...(item.height === undefined ? {} : { height: roundValue(item.height, `${path}.height`, 'height', warnings) }),
        materialId: item.materialId ?? null,
        notes: item.notes ?? null,
      };
    })
    .filter((item) => {
      if (!droppedZoneIds.has(item.roomId)) return true;
      warnings.push({
        code: 'furniture-zone-dropped',
        path: `furniture.${item.id}`,
        message: `家具 ${item.id} 位于已丢弃的室外分区 ${item.roomId}，已一并丢弃`,
      });
      return false;
    });

  if (value.decisions === undefined) {
    warnings.push({ code: 'decisions-default', path: 'decisions', message: '未写 decisions，按 [] 处理' });
  }
  const decisions = (value.decisions ?? []).map((decision, index) => {
    dropNotes(decision.notes, `decisions.${String(index)}.notes`, warnings);
    return {
      id: decision.id,
      topic: decision.topic,
      choice: decision.choice,
      rationale: decision.rationale,
      source: decision.source,
      requirementIds: decision.requirementIds,
    };
  });

  if (value.open === undefined) {
    warnings.push({ code: 'open-default', path: 'open', message: '未写 open，按 [] 处理' });
  }
  const open = (value.open ?? []).map((item, index) => {
    dropNotes(item.notes, `open.${String(index)}.notes`, warnings);
    return {
      id: item.id,
      question: item.question,
      impact: item.impact,
      owner: item.owner,
      defaultAssumption: item.defaultAssumption ?? null,
      freeForBuilder: item.freeForBuilder,
    };
  });

  const normalized = {
    meta,
    site: siteWithZones,
    program: { levels, rooms },
    envelope: {
      ...(wallDefaults === undefined ? {} : { wallDefaults }),
      walls,
      stairs,
    },
    openings,
    structure,
    roof,
    facades,
    materials,
    furniture,
    decisions,
    open,
  };
  const strict = DesignIntent.safeParse(normalized);
  if (!strict.success) throw normalizeError(strict.error, 'DesignIntent');
  return { intent: strict.data, warnings };
}
