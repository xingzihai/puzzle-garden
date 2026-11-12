/**
 * DesignIntentDraft：模型输出的宽松草稿 → 宿主归一化 → 严格 DesignIntent。
 *
 * 只放宽真实模型常见的可修复差异：单层缺 stairs、洞口缺 name/fill、有限小数、可选 notes。
 * 不允许多余未知字段、NaN / Infinity、负数尺寸或越界洞口；这些仍明确失败。
 */
import { z } from 'zod';

import { ColorHex, Identifier, Label, Text } from './primitives.ts';
import { FurnitureKind, MaterialRole, OpeningKind, SchemeScope, Side } from './scheme.ts';
const NumberValue = z.number();
const DraftNote = z.string().min(1).max(1000).nullable().optional();
export const DraftRect2 = z
  .strictObject({
    x: z.tuple([NumberValue, NumberValue]),
    z: z.tuple([NumberValue, NumberValue]),
  })
  .readonly();
export type DraftRect2 = z.infer<typeof DraftRect2>;
const DraftMeta = z
  .strictObject({
    title: z.string().min(1).max(200),
    concept: Text,
    scope: SchemeScope,
    notes: DraftNote,
  })
  .readonly();
const DraftOutdoorKind = z.enum(['garden', 'terrace', 'path', 'parking', 'service', 'water', 'other']);
const DraftOutdoorZone = z
  .strictObject({
    id: Identifier,
    name: Label,
    kind: DraftOutdoorKind,
    rect: DraftRect2,
    materialId: Identifier,
    notes: DraftNote,
  })
  .readonly();
const DraftEntrance = z
  .strictObject({
    side: Side,
    notes: DraftNote,
  })
  .readonly();
const DraftSite = z
  .strictObject({
    bounds: DraftRect2,
    orientation: z.enum(['north', 'east', 'south', 'west', 'unknown']),
    entrance: DraftEntrance,
    outdoorZones: z.array(DraftOutdoorZone).max(50).readonly(),
    notes: DraftNote,
  })
  .readonly();
const DraftLevel = z
  .strictObject({
    id: Identifier,
    name: Label,
    height: NumberValue,
    floorMaterialId: Identifier,
    elevation: NumberValue.optional(),
    notes: DraftNote,
  })
  .readonly();
const DraftRoom = z
  .strictObject({
    id: Identifier,
    name: Label,
    level: Identifier,
    kind: z.enum(['room', 'service', 'circulation']),
    rect: DraftRect2,
    areaM2: z.number().positive().max(1_000_000).optional(),
    occupancy: NumberValue,
    adjacency: z.array(Identifier).max(50).readonly(),
    daylight: z.enum(['required', 'preferred', 'none']),
    notes: DraftNote,
  })
  .readonly();
const DraftProgram = z
  .strictObject({
    levels: z.array(DraftLevel).min(1).max(64).readonly(),
    rooms: z.array(DraftRoom).min(1).max(500).readonly(),
    notes: DraftNote,
  })
  .readonly();
const DraftWall = z
  .strictObject({
    roomId: Identifier,
    side: Side,
    kind: z.enum(['auto', 'exterior', 'interior', 'none']),
    thickness: NumberValue.optional(),
    materialId: Identifier.optional(),
    notes: DraftNote,
  })
  .readonly();
const DraftStair = z
  .strictObject({
    id: Identifier,
    name: Label,
    roomId: Identifier,
    fromLevel: Identifier,
    toLevel: Identifier,
    start: z.strictObject({ x: NumberValue, z: NumberValue }).readonly(),
    direction: Side,
    width: NumberValue,
    treads: NumberValue,
    materialId: Identifier.optional(),
    notes: DraftNote,
  })
  .readonly();
const DraftEnvelope = z
  .strictObject({
    wallDefaults: z
      .strictObject({
        exteriorThickness: NumberValue.optional(),
        interiorThickness: NumberValue.optional(),
        notes: DraftNote,
      })
      .readonly()
      .optional(),
    walls: z.array(DraftWall).max(2000).readonly().nullable().optional(),
    stairs: z.array(DraftStair).max(20).readonly().nullable().optional(),
    notes: DraftNote,
  })
  .readonly();
const DraftOpening = z
  .strictObject({
    id: Identifier,
    name: Label.nullable().optional(),
    roomId: Identifier.optional(),
    hostRoomId: Identifier.optional(),
    side: Side,
    kind: OpeningKind,
    role: z.enum(['entrance', 'interior', 'service']).optional(),
    offset: NumberValue,
    width: NumberValue,
    height: NumberValue,
    sill: NumberValue,
    fill: Label.nullable().optional(),
    frameMaterial: Identifier.nullable().optional(),
    notes: DraftNote,
  })
  .readonly();
const DraftStructure = z
  .strictObject({
    system: z.string().min(1).max(100),
    materialId: Identifier,
    floorThickness: NumberValue.optional(),
    slabThickness: NumberValue.optional(),
    cantilever: NumberValue.optional(),
    notes: DraftNote,
  })
  .readonly();
const DraftRoofSegment = z
  .strictObject({
    id: Identifier,
    rect: DraftRect2,
    form: z.enum(['flat', 'gable', 'hip', 'shed']),
    materialId: Identifier,
    pitchDegrees: NumberValue.optional(),
    overhang: NumberValue,
    notes: DraftNote,
  })
  .readonly();
const DraftRoof = z
  .strictObject({
    form: z.enum(['flat', 'gable', 'hip', 'shed']),
    materialId: Identifier,
    pitchDegrees: NumberValue.optional(),
    pitch: NumberValue.optional(),
    slope: NumberValue.optional(),
    overhang: NumberValue,
    ridgeAxis: z.enum(['x', 'z']).optional(),
    drainage: z.string().min(1).max(128).nullable().optional(),
    skylights: z.array(Label).max(20).readonly().nullable().optional(),
    notes: DraftNote,
    segments: z.array(DraftRoofSegment).max(20).readonly().nullable().optional(),
  })
  .readonly();
const DraftFacadeLayer = z
  .strictObject({
    role: z.enum(['base', 'body', 'top', 'wall', 'structure', 'roof', 'accent', 'other']).optional(),
    materialId: Identifier.optional(),
    material: Identifier.optional(),
    block: Label.optional(),
    name: Label.optional(),
    from: NumberValue.optional(),
    to: NumberValue.optional(),
    height: NumberValue.optional(),
    thickness: NumberValue.optional(),
    notes: DraftNote,
  })
  .readonly();
const DraftFacade = z
  .strictObject({
    side: Side,
    baseMaterialId: Identifier.optional(),
    bodyMaterialId: Identifier.optional(),
    topMaterialId: Identifier.nullable().optional(),
    layers: z.array(DraftFacadeLayer).max(8).readonly().optional(),
    bays: NumberValue.optional(),
    windowWallRatio: z.number().min(0).max(1).nullable().optional(),
    notes: DraftNote,
  })
  .readonly();
const DraftMaterial = z
  .strictObject({
    id: Identifier,
    name: Label,
    block: Label,
    role: MaterialRole,
    color: ColorHex.optional(),
    notes: DraftNote,
  })
  .readonly();
const DraftAnchor = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('center'), notes: DraftNote }),
  z.strictObject({ kind: z.literal('wall'), side: Side, offset: NumberValue, notes: DraftNote }),
  z.strictObject({ kind: z.literal('corner'), corner: z.enum(['nw', 'ne', 'sw', 'se']), notes: DraftNote }),
]);
const DraftFurniture = z
  .strictObject({
    id: Identifier,
    name: Label,
    kind: FurnitureKind,
    roomId: Identifier,
    anchor: DraftAnchor,
    footprint: z.strictObject({ x: NumberValue, z: NumberValue }).readonly(),
    orientation: Side.nullable(),
    height: NumberValue.optional(),
    materialId: Identifier.nullable().optional(),
    notes: DraftNote,
  })
  .readonly();
const DraftDecision = z
  .strictObject({
    id: Identifier,
    topic: Label,
    choice: Text,
    rationale: Text,
    source: z.enum(['user', 'agent', 'default']),
    requirementIds: z.array(Identifier).max(50).readonly(),
    notes: DraftNote,
  })
  .readonly();
const DraftOpen = z
  .strictObject({
    id: Identifier,
    question: Text,
    impact: z.enum(['layout', 'facade', 'interior', 'budget', 'other']),
    owner: z.enum(['user', 'agent']),
    defaultAssumption: Text.nullable().optional(),
    freeForBuilder: z.boolean(),
    notes: DraftNote,
  })
  .readonly();
export const DesignIntentDraft = z
  .strictObject({
    meta: DraftMeta,
    site: DraftSite,
    program: DraftProgram,
    envelope: DraftEnvelope,
    openings: z.array(DraftOpening).max(500).readonly(),
    structure: DraftStructure,
    roof: DraftRoof,
    facades: z.array(DraftFacade).max(4).readonly(),
    materials: z.array(DraftMaterial).min(1).max(200).readonly(),
    furniture: z.array(DraftFurniture).max(500).readonly(),
    decisions: z.array(DraftDecision).max(200).readonly().optional(),
    open: z.array(DraftOpen).max(100).readonly().optional(),
  })
  .readonly();
export type DesignIntentDraft = z.infer<typeof DesignIntentDraft>;
