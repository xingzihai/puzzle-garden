/* eslint-disable max-lines */
/**
 * DesignScheme：交互层唯一的设计方案源（用户确认的是它，构建简报也从它派生）。
 *
 * 负责：meta / 场地 / 楼层 / 空间 / 粗粒度元素 / 洞口 / 交通 / 结构 / 屋面 / 立面 / 材质 /
 * 细部 / 室内 / 决策 / 未决问题 / 预算 / 禁项，并校验 id 唯一和跨集合引用；
 * 生成前只对 element / furniture 的零厚度平面做确定性扩厚，缺失字段与反序 bounds 仍严格拒绝。
 * 不负责：精确实体几何、净空 / 路线求解（复用 @pg/design）、构建代码生成或任何 I/O。
 *
 * 坐标：x 向东、y 向上、z 向南，单位格；bounds 为半开区间 [min, max)。
 * 设计尺度默认一格约一米；洞口宽高、窗台、过梁都由 bounds 与楼层标高派生，不另存重复数字。
 */
import { XZ_MAX, XZ_MIN, Y_MAX, Y_MIN } from '@pg/core/coord';
import { z } from 'zod';

import { checkDesignScheme } from './scheme-validation.ts';
import { Bounds, ColorHex, Identifier, Label, Note, Text, TITLE_MAX, Vec3 } from './primitives.ts';

const LEVELS_MAX = 64;
const SPACES_MAX = 500;
const ELEMENTS_MAX = 5000;
const OPENINGS_MAX = 500;
const CIRCULATION_MAX = 100;
const MATERIALS_MAX = 200;
const FACADES_MAX = 4;
const DETAILS_MAX = 200;
const INTERIORS_MAX = 100;
const DECISIONS_MAX = 200;
const OPEN_MAX = 100;
const REFERENCES_MAX = 50;
const ROUTE_POINTS_MAX = 2000;

/** 方案状态；superseded 用于保留旧版本。 */
export const SchemeStatus = z.enum(['draft', 'review', 'confirmed', 'superseded']);
export type SchemeStatus = z.infer<typeof SchemeStatus>;

/** 交付范围：只外观 / 外观 + 入口 / 外观 + 完整室内（主要空间、家具、楼层与固定家具）。 */
export const SchemeScope = z.enum(['exterior', 'exterior+entry', 'exterior+interior']);
export type SchemeScope = z.infer<typeof SchemeScope>;

export const Side = z.enum(['north', 'east', 'south', 'west']);
export type Side = z.infer<typeof Side>;

/** 来源需求图的版本引用；报告与 prompt-meta 都从这里取。 */
export const SchemeSourceRequirements = z
  .strictObject({
    graphId: Identifier,
    revision: z.int().positive(),
  })
  .readonly();
export type SchemeSourceRequirements = z.infer<typeof SchemeSourceRequirements>;

export const SchemeMeta = z
  .strictObject({
    id: Identifier,
    revision: z.int().positive(),
    title: z.string().min(1).max(TITLE_MAX),
    concept: Text,
    status: SchemeStatus,
    scope: SchemeScope,
    sourceRequirements: SchemeSourceRequirements,
  })
  .readonly();
export type SchemeMeta = z.infer<typeof SchemeMeta>;

/** 场地区域（铺装、檐下平台、庭院等）；不是建筑内部空间。 */
export const SchemeSiteZone = z
  .strictObject({
    id: Identifier,
    name: Label,
    kind: z.enum(['garden', 'terrace', 'path', 'parking', 'service', 'water', 'other']),
    bounds: Bounds,
    material: Label,
    notes: Note,
  })
  .readonly();
export type SchemeSiteZone = z.infer<typeof SchemeSiteZone>;

export const DesignSite = z
  .strictObject({
    /** 整个场地范围，包含建筑、铺装与景观。 */
    bounds: Bounds,
    /** 建筑主体（含屋面挑檐之前的墙体 / 楼板）范围；构建围绕它展开。 */
    buildingBounds: Bounds,
    orientation: z.enum(['north', 'east', 'south', 'west', 'unknown']),
    entranceSide: Side,
    outdoorZones: z.array(SchemeSiteZone).max(50).readonly(),
    notes: Note,
  })
  .readonly();
export type DesignSite = z.infer<typeof DesignSite>;

export const SchemeLevel = z
  .strictObject({
    id: Identifier,
    name: Label,
    elevation: z.int(),
    /** 层高（格）。屋面高度另由 roof.eaveHeight / ridgeHeight 给出。 */
    height: z.int().min(1).max(100),
  })
  .readonly();
export type SchemeLevel = z.infer<typeof SchemeLevel>;

export const SchemeSpaceKind = z.enum(['room', 'circulation', 'void', 'service', 'outdoor']);
export type SchemeSpaceKind = z.infer<typeof SchemeSpaceKind>;

/** 方案空间：用于平面 / 面积 / 连接说明；不是实体。 */
export const SchemeSpace = z
  .strictObject({
    id: Identifier,
    name: Label,
    level: Identifier,
    kind: SchemeSpaceKind,
    bounds: Bounds,
    connections: z.array(Identifier).max(REFERENCES_MAX).readonly(),
    notes: Note,
  })
  .readonly();
export type SchemeSpace = z.infer<typeof SchemeSpace>;

/** 粗粒度建筑元素；构建层再决定具体 World API 与构造。 */
export const SchemeElementKind = z.enum([
  'wall',
  'slab',
  'roof',
  'stair',
  'column',
  'railing',
  'furniture',
  'landscape',
  'glazing',
  'marker',
  'canopy',
]);
export type SchemeElementKind = z.infer<typeof SchemeElementKind>;

export const SchemeElement = z
  .strictObject({
    id: Identifier,
    name: Label,
    level: Identifier,
    kind: SchemeElementKind,
    bounds: Bounds,
    material: Label,
    spaceId: Identifier.nullable(),
    /** 墙厚 / 板厚；不是所有元素都需要，缺失写 null。 */
    thickness: z.int().min(1).max(100).nullable(),
    notes: Note,
  })
  .readonly();
export type SchemeElement = z.infer<typeof SchemeElement>;

export const OpeningKind = z.enum(['door', 'window', 'opening', 'gate']);
export type OpeningKind = z.infer<typeof OpeningKind>;

/** 洞口挂在墙 / 楼板上；宽高与窗台 / 过梁由 bounds 和楼层标高派生。 */
export const SchemeOpening = z
  .strictObject({
    id: Identifier,
    name: Label,
    level: Identifier,
    host: Identifier,
    kind: OpeningKind,
    side: Side,
    bounds: Bounds,
    fill: Label,
    frameMaterial: Label.nullable(),
    notes: Note,
  })
  .readonly();
export type SchemeOpening = z.infer<typeof SchemeOpening>;

export const CirculationKind = z.enum(['entry', 'corridor', 'stair', 'ramp', 'path']);
export type CirculationKind = z.infer<typeof CirculationKind>;

/** 交通路线：显式站立点序列；详细净空与逐格验证留给后续路线检查。 */
export const SchemeCirculation = z
  .strictObject({
    id: Identifier,
    name: Label,
    kind: CirculationKind,
    level: Identifier,
    width: z.int().min(1).max(32),
    accessible: z.boolean(),
    fromSpaceId: Identifier.nullable(),
    toSpaceId: Identifier.nullable(),
    points: z.array(Vec3).min(2).max(ROUTE_POINTS_MAX).readonly(),
    notes: Note,
  })
  .readonly();
export type SchemeCirculation = z.infer<typeof SchemeCirculation>;

export const StructureSystem = z.enum(['load-bearing-walls', 'post-and-beam', 'frame', 'mixed']);
export type StructureSystem = z.infer<typeof StructureSystem>;

export const SchemeStructure = z
  .strictObject({
    system: StructureSystem,
    material: Label,
    spanX: z.int().min(1).max(10_000),
    spanZ: z.int().min(1).max(10_000),
    floorThickness: z.int().min(1).max(100),
    /** 允许的最大悬挑（格）；0 表示不悬挑。 */
    cantilever: z.int().min(0).max(100),
    notes: Note,
  })
  .readonly();
export type SchemeStructure = z.infer<typeof SchemeStructure>;

export const RoofForm = z.enum(['flat', 'gable', 'hip', 'shed', 'butterfly', 'curved', 'other']);
export type RoofForm = z.infer<typeof RoofForm>;

export const SchemeRoofSegment = z
  .strictObject({
    id: Identifier,
    form: RoofForm,
    material: Label,
    pitchDegrees: z.number().min(0).max(90),
    eaveHeight: z.int(),
    ridgeHeight: z.int(),
    overhang: z.int().min(0).max(50),
    bounds: Bounds,
  })
  .readonly();
export type SchemeRoofSegment = z.infer<typeof SchemeRoofSegment>;

export const SchemeRoof = z
  .strictObject({
    form: RoofForm,
    material: Label,
    pitchDegrees: z.number().min(0).max(90),
    eaveHeight: z.int(),
    ridgeHeight: z.int(),
    overhang: z.int().min(0).max(50),
    drainage: Label.nullable(),
    skylights: z.array(Label).max(20).readonly(),
    notes: Note,
    /** 多段屋面时列出每一段；单段省略，保持旧输出兼容。 */
    segments: z.array(SchemeRoofSegment).min(1).max(20).readonly().optional(),
  })
  .readonly();
export type SchemeRoof = z.infer<typeof SchemeRoof>;

export const SchemeFacade = z
  .strictObject({
    side: Side,
    baseMaterialId: Identifier,
    bodyMaterialId: Identifier,
    topMaterialId: Identifier.nullable(),
    bays: z.int().min(1).max(100),
    windowWallRatio: z.number().min(0).max(1).nullable(),
    notes: Note,
  })
  .readonly();
export type SchemeFacade = z.infer<typeof SchemeFacade>;

export const MaterialRole = z.enum(['structure', 'wall', 'roof', 'floor', 'trim', 'furniture', 'landscape', 'glass']);
export type MaterialRole = z.infer<typeof MaterialRole>;

export const SchemeMaterial = z
  .strictObject({
    id: Identifier,
    name: Label,
    /** 方块 id，可带状态，如 oak_stairs[facing=east,half=bottom]。 */
    block: Label,
    role: MaterialRole,
    color: ColorHex,
    notes: Note,
  })
  .readonly();
export type SchemeMaterial = z.infer<typeof SchemeMaterial>;

export const DetailPriority = z.enum(['must', 'should', 'could']);
export type DetailPriority = z.infer<typeof DetailPriority>;

/** 细部链接强度；旧数据没有该字段时按 verified 读。 */
export const DetailLinkScope = z.enum(['verified', 'declared']);
export type DetailLinkScope = z.infer<typeof DetailLinkScope>;

export const SchemeDetail = z
  .strictObject({
    id: Identifier,
    name: Label,
    where: Label,
    /** 实体 / 洞口 id，或 `furniture:` / `material:` / `site:` 命名空间引用。 */
    elementIds: z.array(Identifier).max(REFERENCES_MAX).readonly(),
    count: z.int().positive().nullable(),
    description: Text,
    priority: DetailPriority,
    requirementIds: z.array(Identifier).max(REFERENCES_MAX).readonly(),
    /**
     * 仅保留旧数据解析；BuildSheet 完全忽略该字段。
     * verified 只能由确定性 planner（planVerifiedObjectMap）产生，用户/模型写入无效。
     */
    linkScope: DetailLinkScope.optional(),
  })
  .readonly();
export type SchemeDetail = z.infer<typeof SchemeDetail>;

export const FurnitureKind = z.enum([
  'table',
  'chair',
  'bench',
  'counter',
  'shelf',
  'storage',
  'bed',
  'light',
  'rug',
  'appliance',
  'other',
]);
export type FurnitureKind = z.infer<typeof FurnitureKind>;

/** 结构化家具：位置、尺寸、材质、朝向都要能被构建层直接执行。 */
export const SchemeFurniture = z
  .strictObject({
    id: Identifier,
    name: Label,
    kind: FurnitureKind,
    bounds: Bounds,
    materialId: Identifier,
    /** 家具面向的方位；桌子 / 地毯等无朝向写 null。 */
    orientation: Side.nullable(),
    notes: Note,
  })
  .readonly();
export type SchemeFurniture = z.infer<typeof SchemeFurniture>;

export const SchemeInterior = z
  .strictObject({
    id: Identifier,
    spaceId: Identifier,
    name: Label,
    /** 快速可读的家具名列表；构建以 furnitureSpecs 为准。 */
    furniture: z.array(Label).max(100).readonly(),
    /** 结构化家具；必须显式给出，空数组表示尚未设计到可施工深度，但不允许省略字段。 */
    furnitureSpecs: z.array(SchemeFurniture).max(100).readonly(),
    included: z.boolean(),
    notes: Note,
  })
  .readonly();
export type SchemeInterior = z.infer<typeof SchemeInterior>;

export const SchemeDecisionSource = z.enum(['user', 'agent', 'default']);
export type SchemeDecisionSource = z.infer<typeof SchemeDecisionSource>;

export const SchemeDecision = z
  .strictObject({
    id: Identifier,
    topic: Label,
    choice: Text,
    rationale: Text,
    source: SchemeDecisionSource,
    status: z.enum(['proposed', 'confirmed', 'rejected']),
    requirementIds: z.array(Identifier).max(REFERENCES_MAX).readonly(),
  })
  .readonly();
export type SchemeDecision = z.infer<typeof SchemeDecision>;

/** 未决问题 / 可自由发挥项。freeForBuilder=true 时允许构建层自行处理。 */
export const SchemeOpenItem = z
  .strictObject({
    id: Identifier,
    question: Text,
    impact: z.enum(['layout', 'facade', 'interior', 'budget', 'other']),
    owner: z.enum(['user', 'agent']),
    status: z.enum(['open', 'deferred']),
    defaultAssumption: Text.nullable(),
    freeForBuilder: z.boolean(),
  })
  .readonly();
export type SchemeOpenItem = z.infer<typeof SchemeOpenItem>;

export const SchemeBudget = z
  .strictObject({
    maxBlocks: z.int().min(100).max(200_000),
    targetBlocks: z.int().min(100).max(200_000).nullable(),
    /** 设计阶段的体积估算；没有可靠估算时写 null，不编造。 */
    estimatedBlocks: z.int().min(0).max(200_000).nullable(),
    maxCostCny: z.number().positive().max(1_000_000).nullable(),
  })
  .superRefine((budget, ctx) => {
    if (budget.targetBlocks !== null && budget.targetBlocks > budget.maxBlocks) {
      ctx.addIssue({ code: 'custom', path: ['targetBlocks'], message: '目标方块数不能超过预算上限' });
    }
    if (budget.estimatedBlocks !== null && budget.estimatedBlocks > budget.maxBlocks) {
      ctx.addIssue({ code: 'custom', path: ['estimatedBlocks'], message: '估算方块数不能超过预算上限' });
    }
  })
  .readonly();
export type SchemeBudget = z.infer<typeof SchemeBudget>;
/** 完整方案。各集合 id 独立唯一；跨集合引用必须能解析。 */
const DesignSchemeFields = z.strictObject({
  meta: SchemeMeta,
  site: DesignSite,
  levels: z.array(SchemeLevel).min(1).max(LEVELS_MAX).readonly(),
  spaces: z.array(SchemeSpace).min(1).max(SPACES_MAX).readonly(),
  elements: z.array(SchemeElement).min(1).max(ELEMENTS_MAX).readonly(),
  openings: z.array(SchemeOpening).max(OPENINGS_MAX).readonly(),
  circulation: z.array(SchemeCirculation).max(CIRCULATION_MAX).readonly(),
  structure: SchemeStructure,
  roof: SchemeRoof,
  facades: z.array(SchemeFacade).max(FACADES_MAX).readonly(),
  materials: z.array(SchemeMaterial).min(1).max(MATERIALS_MAX).readonly(),
  details: z.array(SchemeDetail).max(DETAILS_MAX).readonly(),
  interiors: z.array(SchemeInterior).max(INTERIORS_MAX).readonly(),
  decisions: z.array(SchemeDecision).max(DECISIONS_MAX).readonly(),
  open: z.array(SchemeOpenItem).max(OPEN_MAX).readonly(),
  budget: SchemeBudget,
  forbidden: z.array(Text).max(50).readonly(),
});

/**
 * 分阶段方案生成用的字段子集：工具 schema 只暴露本阶段字段，运行时也丢弃其他阶段字段，
 * 避免模型把整份方案塞进一个阶段后覆盖前一阶段的结果。本阶段必需字段仍然严格必填。
 * 子集本身不做跨集合校验，避免半成品被误判。
 */
export const DesignSchemeCore = DesignSchemeFields.pick({
  meta: true,
  site: true,
  levels: true,
  spaces: true,
  budget: true,
  forbidden: true,
})
  .strip()
  .readonly();
export type DesignSchemeCore = z.infer<typeof DesignSchemeCore>;

export const DesignSchemeEnvelope = DesignSchemeFields.pick({
  elements: true,
  openings: true,
  circulation: true,
  structure: true,
  roof: true,
  facades: true,
  materials: true,
})
  .strip()
  .readonly();
export type DesignSchemeEnvelope = z.infer<typeof DesignSchemeEnvelope>;

export const DesignSchemeInterior = DesignSchemeFields.pick({
  details: true,
  interiors: true,
  decisions: true,
  open: true,
})
  .strip()
  .readonly();
export type DesignSchemeInterior = z.infer<typeof DesignSchemeInterior>;

export const DesignScheme = DesignSchemeFields.superRefine(checkDesignScheme).readonly();
export type DesignScheme = z.infer<typeof DesignScheme>;

/**
 * 生成前的确定性几何修复：模型常把墙、楼板或家具写成零厚度平面。
 * 只扩 element / furniture 的零面积 bounds；缺失字段、反序 bounds 与 site / spaces / openings
 * 保持原样，继续由严格 schema 明确拒绝，避免把“空壳”静默当成已完成的设计。
 */
export type BoundsAxis = 'x' | 'y' | 'z';

export interface BoundsRepair {
  /** 例如 elements.1.bounds 或 interiors.0.furnitureSpecs.2.bounds。 */
  readonly path: string;
  readonly axes: readonly BoundsAxis[];
  readonly before: Bounds;
  readonly after: Bounds;
}

export interface NormalizationWarning {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface NormalizedSubmission {
  readonly value: unknown;
  readonly repairs: readonly BoundsRepair[];
  readonly warnings?: readonly NormalizationWarning[];
}

const AXIS_LIMITS = [
  { axis: 'x', min: XZ_MIN, max: XZ_MAX },
  { axis: 'y', min: Y_MIN, max: Y_MAX },
  { axis: 'z', min: XZ_MIN, max: XZ_MAX },
] as const satisfies readonly { readonly axis: BoundsAxis; readonly min: number; readonly max: number }[];

const MAX_NORMALIZE_STEP = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBounds(value: unknown): Bounds | null {
  if (!isRecord(value)) return null;
  const minValue: unknown = value['min'];
  const maxValue: unknown = value['max'];
  if (!Array.isArray(minValue) || !Array.isArray(maxValue)) return null;
  const min = minValue as readonly unknown[];
  const max = maxValue as readonly unknown[];
  if (min.length !== 3 || max.length !== 3) return null;
  const values: readonly unknown[] = [min[0], min[1], min[2], max[0], max[1], max[2]];
  if (!values.every((item): item is number => typeof item === 'number' && Number.isSafeInteger(item))) return null;
  return {
    min: [min[0] as number, min[1] as number, min[2] as number],
    max: [max[0] as number, max[1] as number, max[2] as number],
  } as unknown as Bounds;
}

function repairBounds(
  before: Bounds,
  stepOf: (axis: BoundsAxis) => number,
): { readonly bounds: Bounds; readonly axes: readonly BoundsAxis[] } | null {
  const min = [before.min[0], before.min[1], before.min[2]];
  const max = [before.max[0], before.max[1], before.max[2]];
  const axes: BoundsAxis[] = [];

  for (const limit of AXIS_LIMITS) {
    const axisIndex = limit.axis === 'x' ? 0 : limit.axis === 'y' ? 1 : 2;
    const low = min[axisIndex];
    const high = max[axisIndex];
    if (low === undefined || high === undefined) return null;
    if (low > high) return null;
    if (low !== high) continue;

    const step = Math.min(MAX_NORMALIZE_STEP, Math.max(1, Math.trunc(stepOf(limit.axis))));
    if (low + step <= limit.max) {
      max[axisIndex] = low + step;
    } else if (high - step >= limit.min) {
      min[axisIndex] = high - step;
    } else {
      return null;
    }
    axes.push(limit.axis);
  }

  if (axes.length === 0) return null;
  return {
    bounds: { min, max } as unknown as Bounds,
    axes,
  };
}

function repairedElement(
  element: unknown,
  path: string,
): { readonly value: unknown; readonly repair: BoundsRepair | null } {
  if (!isRecord(element)) return { value: element, repair: null };
  const before = readBounds(element['bounds']);
  if (before === null) return { value: element, repair: null };
  const thickness = element['thickness'];
  const horizontalStep =
    typeof thickness === 'number' &&
    Number.isSafeInteger(thickness) &&
    thickness >= 1 &&
    thickness <= MAX_NORMALIZE_STEP
      ? thickness
      : 1;
  const repaired = repairBounds(before, (axis) => (axis === 'y' ? 1 : horizontalStep));
  if (repaired === null) return { value: element, repair: null };
  return {
    value: { ...element, bounds: repaired.bounds },
    repair: { path, axes: repaired.axes, before, after: repaired.bounds },
  };
}

function repairedFurniture(
  furniture: unknown,
  path: string,
): { readonly value: unknown; readonly repair: BoundsRepair | null } {
  if (!isRecord(furniture)) return { value: furniture, repair: null };
  const before = readBounds(furniture['bounds']);
  if (before === null) return { value: furniture, repair: null };
  const repaired = repairBounds(before, () => 1);
  if (repaired === null) return { value: furniture, repair: null };
  return {
    value: { ...furniture, bounds: repaired.bounds },
    repair: { path, axes: repaired.axes, before, after: repaired.bounds },
  };
}

/** 只修复元素与家具的零面积 bounds，并返回每一步的前后值。 */
export function normalizeSchemeBounds(payload: unknown): NormalizedSubmission {
  if (!isRecord(payload)) return { value: payload, repairs: [] };
  const repairs: BoundsRepair[] = [];
  let value = payload;

  const elementsValue: unknown = payload['elements'];
  if (Array.isArray(elementsValue)) {
    const elements = elementsValue as readonly unknown[];
    const repairCountBefore = repairs.length;
    const nextElements = elements.map((element, index) => {
      const result = repairedElement(element, `elements.${String(index)}.bounds`);
      if (result.repair !== null) repairs.push(result.repair);
      return result.value;
    });
    if (repairs.length > repairCountBefore) value = { ...value, elements: nextElements };
  }

  const interiorsValue: unknown = payload['interiors'];
  if (Array.isArray(interiorsValue)) {
    const interiors = interiorsValue as readonly unknown[];
    const repairCountBefore = repairs.length;
    const nextInteriors = interiors.map((interior, interiorIndex) => {
      if (!isRecord(interior)) return interior;
      const furnitureValue: unknown = interior['furnitureSpecs'];
      if (!Array.isArray(furnitureValue)) return interior;
      const furnitureSpecs = furnitureValue as readonly unknown[];
      const specsRepairCountBefore = repairs.length;
      const nextSpecs = furnitureSpecs.map((furniture, furnitureIndex) => {
        const result = repairedFurniture(
          furniture,
          `interiors.${String(interiorIndex)}.furnitureSpecs.${String(furnitureIndex)}.bounds`,
        );
        if (result.repair !== null) repairs.push(result.repair);
        return result.value;
      });
      if (repairs.length === specsRepairCountBefore) return interior;
      return { ...interior, furnitureSpecs: nextSpecs };
    });
    if (repairs.length > repairCountBefore) value = { ...value, interiors: nextInteriors };
  }

  return { value, repairs };
}
