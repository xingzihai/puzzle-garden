/**
 * BuildBrief / BuildSpec：同一份 DesignScheme 的构建侧机器视图与提示词元信息。
 *
 * 负责：BuildSpec 的结构约束（bounds / levels / spaces / openings / routes / counts / budget /
 * forbidden / musts，以及结构、屋面、立面、材质、细部、室内）与 BuildBrief 的字段上限；
 * gates 直接复用 @pg/agent/gates 的 schema，避免交互层另造一套门槛格式。
 * 不负责：编译与 lint（brief.ts）、运行构建、模型调用。
 */
import { gatesSchema } from '@pg/agent/gates';
import { z } from 'zod';

import { Bounds, Identifier, Label, Text, Vec3 } from './primitives.ts';
import {
  CirculationKind,
  OpeningKind,
  SchemeBudget,
  SchemeDetail,
  SchemeFacade,
  SchemeInterior,
  SchemeLevel,
  SchemeMaterial,
  SchemeRoof,
  SchemeScope,
  SchemeSpaceKind,
  SchemeStructure,
  Side,
} from './scheme.ts';
import type { DetailPriority, MaterialRole, RoofForm } from './scheme.ts';

/** 设计报告建议上限；超过时先删重复解释，不删必须项（lint 负责报出）。 */
export const MAX_DESIGN_CHARS = 64_000;
/** 喂给构建 agent 的四节题面建议上限。 */
export const MAX_TASK_CHARS = 48_000;
/** schema 的硬上限：比 lint 阈值宽，保证超长输入能被 lint 报出来而不是在 parse 时直接抛错。 */
export const HARD_DESIGN_CHARS = 400_000;
export const HARD_TASK_CHARS = 200_000;

const MUSTS_MAX = 300;
const REFERENCES_MAX = 50;

/** machine view 中的楼层：只保留构建需要的 id / 标高 / 层高。 */
export const BuildLevel = SchemeLevel;
export type BuildLevel = z.infer<typeof BuildLevel>;

export const BuildSpace = z
  .strictObject({
    id: Identifier,
    name: Label,
    level: Identifier,
    kind: SchemeSpaceKind,
    bounds: Bounds,
    /** 外包面积（m²），由 bounds 派生；未扣墙厚。 */
    areaM2: z.number().nonnegative(),
    connections: z.array(Identifier).max(REFERENCES_MAX).readonly(),
  })
  .readonly();
export type BuildSpace = z.infer<typeof BuildSpace>;

export const BuildElement = z
  .strictObject({
    id: Identifier,
    name: Label,
    level: Identifier,
    kind: z.enum([
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
    ]),
    bounds: Bounds,
    material: Label,
    spaceId: Identifier.nullable(),
  })
  .readonly();
export type BuildElement = z.infer<typeof BuildElement>;

export const BuildOpening = z
  .strictObject({
    id: Identifier,
    name: Label,
    level: Identifier,
    host: Identifier,
    kind: OpeningKind,
    side: Side,
    bounds: Bounds,
    width: z.int().positive(),
    height: z.int().positive(),
    /** 相对楼层标高的窗台高度；门通常为 0。 */
    sillHeight: z.int(),
    /** 相对楼层标高的洞口上沿。 */
    headHeight: z.int(),
    fill: Label,
    frameMaterial: Label.nullable(),
  })
  .readonly();
export type BuildOpening = z.infer<typeof BuildOpening>;

export const BuildRoute = z
  .strictObject({
    id: Identifier,
    name: Label,
    kind: CirculationKind,
    level: Identifier,
    width: z.int().positive(),
    accessible: z.boolean(),
    fromSpaceId: Identifier.nullable(),
    toSpaceId: Identifier.nullable(),
    points: z.array(Vec3).min(2).max(2000).readonly(),
  })
  .readonly();
export type BuildRoute = z.infer<typeof BuildRoute>;

export const BuildCounts = z
  .strictObject({
    levels: z.int().nonnegative(),
    spaces: z.int().nonnegative(),
    elements: z.int().nonnegative(),
    openings: z.int().nonnegative(),
    routes: z.int().nonnegative(),
    musts: z.int().nonnegative(),
    footprintX: z.int().positive(),
    footprintZ: z.int().positive(),
    footprintAreaM2: z.number().positive(),
  })
  .readonly();
export type BuildCounts = z.infer<typeof BuildCounts>;

export const BuildMustSource = z.enum(['requirement', 'detail', 'constraint']);
export type BuildMustSource = z.infer<typeof BuildMustSource>;

/** 必须项：构建前 lint 逐条核对，构建 agent 在第四节按 id 自查。 */
export const BuildMust = z
  .strictObject({
    id: Identifier,
    text: Text,
    source: BuildMustSource,
  })
  .readonly();
export type BuildMust = z.infer<typeof BuildMust>;

/** 机器约束；所有数字都来自 DesignScheme 或由 bounds 派生。 */
export const BuildSpec = z
  .strictObject({
    schemeId: Identifier,
    schemeRevision: z.int().positive(),
    title: z.string().min(1).max(200),
    scope: SchemeScope,
    /** 主入口朝向；旧 build-spec.json 可能没有这个字段，消费方需按文档回退。 */
    entranceSide: Side.optional(),
    bounds: Bounds,
    siteBounds: Bounds,
    levels: z.array(BuildLevel).min(1).max(64).readonly(),
    spaces: z.array(BuildSpace).max(500).readonly(),
    elements: z.array(BuildElement).max(5000).readonly(),
    openings: z.array(BuildOpening).max(500).readonly(),
    routes: z.array(BuildRoute).max(100).readonly(),
    structure: SchemeStructure,
    roof: SchemeRoof,
    facades: z.array(SchemeFacade).max(4).readonly(),
    materials: z.array(SchemeMaterial).max(200).readonly(),
    details: z.array(SchemeDetail).max(200).readonly(),
    interiors: z.array(SchemeInterior).max(100).readonly(),
    counts: BuildCounts,
    budget: SchemeBudget,
    forbidden: z.array(Text).max(50).readonly(),
    musts: z.array(BuildMust).max(MUSTS_MAX).readonly(),
  })
  .readonly();
export type BuildSpec = z.infer<typeof BuildSpec>;

/**
 * 与 tools/build-sheet.ts 的 entranceOpening 同口径：按 BuildSpec / scheme 原始顺序取第一个非窗洞口，
 * 优先 entranceSide，其次北侧，最后退到第一个非窗洞口；窗口永远不能当入口，也不按 id 排序。
 * 供 Brief / BuildSheet / FloorDatum 消费方共享同一选择，避免同侧多门时各自选到不同的门。
 */
export function selectEntranceOpening(spec: Pick<BuildSpec, 'openings' | 'entranceSide'>): BuildOpening | undefined {
  const candidates = spec.openings.filter((opening) => opening.kind !== 'window');
  return (
    candidates.find((opening) => opening.side === spec.entranceSide) ??
    candidates.find((opening) => opening.side === 'north') ??
    candidates[0]
  );
}

/** prompt-meta.json：只放确定性版本信息，不放时间戳（便于逐字节比较与回放）。 */
export const PromptMeta = z
  .strictObject({
    compilerVersion: z.string().min(1).max(64),
    schemeId: Identifier,
    schemeRevision: z.int().positive(),
    requirementsGraphId: Identifier.nullable(),
    requirementsRevision: z.int().positive().nullable(),
    capabilityCardVersion: z.string().min(1).max(64),
    designReportChars: z.int().nonnegative(),
    taskChars: z.int().nonnegative(),
  })
  .readonly();
export type PromptMeta = z.infer<typeof PromptMeta>;

/** 编译器输出的完整简报：用户版 design.md + 构建四节题面 + spec + gates + meta。 */
export const BuildBrief = z
  .strictObject({
    designMarkdown: z.string().min(1).max(HARD_DESIGN_CHARS),
    taskMarkdown: z.string().min(1).max(HARD_TASK_CHARS),
    spec: BuildSpec,
    gates: gatesSchema,
    promptMeta: PromptMeta,
  })
  .readonly();
export type BuildBrief = z.infer<typeof BuildBrief>;

/** 与现有 --gates 配置同形；未表达的设计约束继续留在 BuildSpec。 */
export type BuildGates = z.infer<typeof gatesSchema>;

/** 细节优先级在 BuildSpec 中保留，供任务第三节按 must → should 顺序输出。 */
export const DETAIL_PRIORITY_ORDER: Readonly<Record<DetailPriority, number>> = {
  must: 0,
  should: 1,
  could: 2,
};

/** 材质角色在报告中的中文标签；构建 brief 只引用 id / block，不重复解释。 */
export const MATERIAL_ROLE_LABEL: Readonly<Record<MaterialRole, string>> = {
  structure: '结构',
  wall: '墙体',
  roof: '屋面',
  floor: '楼地面',
  trim: '收边 / 线脚',
  furniture: '家具',
  landscape: '景观',
  glass: '玻璃',
};

/** 屋面形式在报告中的中文标签。 */
export const ROOF_FORM_LABEL: Readonly<Record<RoofForm, string>> = {
  flat: '平屋面',
  gable: '双坡',
  hip: '四坡',
  shed: '单坡',
  butterfly: '反坡',
  curved: '曲面',
  other: '其他',
};
