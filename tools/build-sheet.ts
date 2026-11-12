/* eslint-disable max-lines -- BuildSheet 的机器合同、显式映射与 markdown 渲染共用同一份派生逻辑。 */
/**
 * BuildSpec → BuildSheet：施工层的机器合同与人类可读摘要（PHASE1-TRUTH-CHAIN §1B）。
 *
 * 负责：复用 `projectExpectedObjects` 生成与 checker 完全一致的期望对象，补齐材质 / 基准面 /
 *   层次做法 / must → object 链接 / 未解决冲突，并输出确定性 JSON 与紧凑 markdown。
 * 不负责：读会话目录、调用模型、diff、修改 BuildSpec；所有派生值只来自 BuildSpec。
 *
 * 确定性：不写时间戳、不排序随机化；对象与 must 都保持 BuildSpec / 投影的原始顺序。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ExpectedFurniture,
  ExpectedObject,
  ExpectedOpening,
  ExpectedOpeningSubtype,
} from '@pg/analysis/object-diff';
import {
  FLOOR_DATUM_OPTIONS,
  ID_MAX,
  type BuildSpec,
  type FloorDatum,
  type FloorDatumBand,
  type FloorDatumConflict,
  type MaterialRole,
} from '@pg/interaction/schema';
import { isFlushMustText } from '@pg/interaction/flush-text';
import { isPlannerVerifiedObjectMap } from '@pg/interaction/must-links';

import type { ConstructionCallCard } from './build-sheet-call-card.ts';
import { buildConstructionCallCards, renderConstructionCallCards } from './build-sheet-call-card.ts';
import { projectExpectedObjects } from './conformance-expect.ts';
import { projectCoverageObjects, projectExpectedFurniture } from './coverage-evidence.ts';
// 只取类型：conformance-shadow 运行时依赖本文件，值导入会形成循环。
import type { VerifiedMustMapping } from './conformance-shadow.ts';

export interface BuildSheetMaterial {
  readonly id: string;
  readonly name: string;
  readonly block: string;
  readonly role: MaterialRole;
}

export type BuildSheetDatumOpening = FloorDatumBand;

/** 与 Design 共享的 FloorDatum 同口径；BuildSheet 不暴露旧别名 floorY。 */
export type BuildSheetDatum = Omit<FloorDatum, 'floorY'> & {
  /** 供 dry-run / markdown 直接使用的一行摘要。 */
  readonly summary: string;
};

export interface BuildSheetLayers {
  /** 从高到低：洞口优先，其次结构，最后装饰。 */
  readonly priority: readonly ['opening', 'structure', 'decoration'];
  readonly recipe: readonly string[];
  readonly materials: readonly BuildSheetMaterial[];
}

/** 显式链接强度：verified 可进入 mapping；declared 只声明、不投影；none 没有显式链接。 */
export type BuildSheetLinkScope = 'verified' | 'declared' | 'none';

export interface BuildSheetMust {
  readonly id: string;
  readonly text: string;
  readonly source: BuildSpec['musts'][number]['source'];
  /** 关键词 + verified 显式投影 + 已声明投影的并集；仅供人读 / 平行对比，不单独产生 verified。 */
  readonly objectIds: readonly string[];
  /** 仅来自 planner 的可信 verified 对象；details 不能产生该字段。 */
  readonly explicitObjectIds: readonly string[];
  /** details 的文档链接（投影 + furniture:/material:/site:），永远不进入 verified mapping。 */
  readonly declaredObjectIds: readonly string[];
  /** 可信 planner mapping 是否命中该 must。 */
  readonly linkScope: BuildSheetLinkScope;
  /** linkScope 不是 verified 时说明原因；verified 为 null。 */
  readonly linkReason: string | null;
}

export type BuildSheetConflict = FloorDatumConflict;

interface BuildSheetObjectBase {
  readonly id: string;
  readonly bounds: ExpectedObject['bounds'];
  readonly materialId: string | null;
  readonly materialBlock: string;
  readonly materialName: string | null;
  readonly materialRole: MaterialRole | null;
  readonly mustIds: readonly string[];
  readonly unverifiedReason: string | null;
}

export interface BuildSheetWall extends BuildSheetObjectBase {
  readonly kind: 'wall';
}
export interface BuildSheetSlab extends BuildSheetObjectBase {
  readonly kind: 'slab';
}
export interface BuildSheetRoof extends BuildSheetObjectBase {
  readonly kind: 'roof';
  readonly form: string;
  readonly pitchDegrees: number;
  readonly eaveY: number;
  readonly ridgeY: number;
  readonly overhang: number;
}
export interface BuildSheetOpening extends BuildSheetObjectBase {
  readonly kind: 'opening';
  readonly subtype: ExpectedOpeningSubtype;
  readonly side: string;
  readonly width: number;
  readonly height: number;
  readonly sillY: number;
  readonly headY: number;
  readonly hostId: string | null;
  readonly frameMaterialId: string | null;
  readonly frameMaterialBlock: string | null;
}
export interface BuildSheetFurniture extends BuildSheetObjectBase {
  readonly kind: 'furniture';
  readonly furnitureKind: string;
  readonly seatCapacity: number | null;
}
/** 可测量覆盖检查：没有几何 bounds，但它是 BuildSheet 的机器合同行。 */
export interface BuildSheetCheck {
  readonly id: string;
  readonly kind: 'check';
  readonly label: string;
  readonly bounds: null;
  readonly materialId: null;
  readonly materialBlock: '—';
  readonly materialName: null;
  readonly materialRole: null;
  readonly mustIds: readonly string[];
  readonly unverifiedReason: null;
}
export type BuildSheetObject = BuildSheetWall | BuildSheetSlab | BuildSheetRoof | BuildSheetOpening;
export type BuildSheetRow = BuildSheetObject | BuildSheetFurniture | BuildSheetCheck;

/** 不含 markdown 字段的机器视图；`BuildSheet` 在它之上附带渲染好的 markdown。 */
export interface BuildSheetMustLinkage {
  /** 至少链接到一个期望对象或 declared 引用的 must 数（objectIds 或 declaredObjectIds）。 */
  readonly linked: number;
  /** 既没有 objectIds 也没有 declaredObjectIds 的 must 数。 */
  readonly unlinked: number;
  /** 至少有一条显式 details 链接（verified 或 declared-only）的 must 数。 */
  readonly explicit: number;
  /** `explicit` 的兼容别名；schemaVersion 2 起两者同义。 */
  readonly explicitLinks: number;
  /** 至少有一条 verified 投影显式链接的 must 数；只有这些 must 能进入 verified mapping。 */
  readonly verified: number;
  /** 至少有 declared-only 链接的 must 数。 */
  readonly declared: number;
  /** 没有任何显式 details 链接、但有关键词 objectIds 的 must 数（纯关键词启发式）。 */
  readonly heuristicOnly: number;
  /** 没有任何显式 details 链接（verified 或 declared-only）的 must 数。 */
  readonly noDeclaredLinks: number;
  /** 并集里仍包含关键词链接，不是逐条语义核对。 */
  readonly heuristic: true;
  readonly note: string;
}

export interface BuildSheetContent {
  /** v2：`explicit` 表示任何显式链接；`explicitLinks` 为兼容别名；`verified` 仅指可进 mapping 的链接。 */
  readonly schemaVersion: 2;
  readonly tool: 'build-sheet';
  readonly schemeId: string;
  readonly schemeRevision: number;
  readonly title: string;
  readonly bounds: BuildSpec['bounds'];
  readonly siteBounds: BuildSpec['siteBounds'];
  readonly objects: readonly BuildSheetObject[];
  /** 包络对象的精确施工调用卡；markdown 直接渲染同一份数据。 */
  readonly callCards: readonly ConstructionCallCard[];
  /** 结构化家具（来自 interiors.furnitureSpecs），与 must 覆盖检查共用同一份 id。 */
  readonly furnitureObjects: readonly BuildSheetFurniture[];
  /** 可测量覆盖检查（层数 / 净尺寸 / 墙厚 / 材料 / 家具 / 齐平 / 有无）。 */
  readonly coverageObjects: readonly BuildSheetCheck[];
  /** 与 `check_code` 共用同一份投影，原样保留给 runner deps。 */
  readonly expectedObjects: readonly ExpectedObject[];
  readonly datum: BuildSheetDatum;
  readonly layers: BuildSheetLayers;
  readonly musts: readonly BuildSheetMust[];
  readonly unlinkedMustIds: readonly string[];
  readonly mustLinkage: BuildSheetMustLinkage;
  readonly conflicts: readonly BuildSheetConflict[];
}

export interface BuildSheet extends BuildSheetContent {
  readonly markdown: string;
}

interface ResolvedMaterial {
  readonly id: string | null;
  readonly name: string | null;
  readonly block: string;
  readonly role: MaterialRole | null;
}

type MatchKind = ExpectedObject['kind'] | 'door' | 'window';

const KIND_KEYWORDS: readonly { readonly kind: MatchKind; readonly pattern: RegExp }[] = [
  { kind: 'wall', pattern: /墙|围护|立面|wall|facade|façade/i },
  { kind: 'slab', pattern: /楼板|地板|地面|地坪|楼面|基座|垫层|slab|floor|plinth/i },
  { kind: 'roof', pattern: /屋面|屋顶|屋脊|檐|瓦|roof|eave|ridge|gable/i },
  { kind: 'door', pattern: /门|入口|进出|door|entry|entrance/i },
  { kind: 'window', pattern: /窗|玻璃|window|glazing|glass/i },
];

function declared(spec: BuildSpec, id: string): BuildSheetMaterial | null {
  return spec.materials.find((material) => material.id === id) ?? null;
}

function resolved(spec: BuildSpec, id: string): ResolvedMaterial {
  const material = declared(spec, id);
  return material === null
    ? { id, name: null, block: id, role: null }
    : { id: material.id, name: material.name, block: material.block, role: material.role };
}

function firstWithRole(spec: BuildSpec, role: MaterialRole): ResolvedMaterial | null {
  const material = spec.materials.find((item) => item.role === role);
  return material === undefined
    ? null
    : { id: material.id, name: material.name, block: material.block, role: material.role };
}

function frameMaterial(spec: BuildSpec, opening: ExpectedOpening): ResolvedMaterial | null {
  const frame = spec.openings.find((item) => `opening:${item.id}` === opening.id)?.frameMaterial;
  if (frame === undefined || frame === null) return null;
  return resolved(spec, frame);
}

/**
 * 墙对象是多个墙段的 union；BuildSheet 只能写一种主材。取墙段里面积最大的材质，
 * 与 `check:material:wall/structure` 的期望口径一致；不要退回 `structure.material`
 * （它可能是楼板/结构默认材，和墙段声明不一致）。
 */
function wallMaterialOf(spec: BuildSpec): string {
  const cellsByMaterial = new Map<string, number>();
  for (const element of spec.elements) {
    if (element.kind !== 'wall') continue;
    const [minX, minY, minZ] = element.bounds.min;
    const [maxX, maxY, maxZ] = element.bounds.max;
    const cells = (maxX - minX) * (maxY - minY) * (maxZ - minZ);
    cellsByMaterial.set(element.material, (cellsByMaterial.get(element.material) ?? 0) + cells);
  }
  const ranked = [...cellsByMaterial.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return ranked[0]?.[0] ?? spec.structure.material;
}

function materialFor(spec: BuildSpec, object: ExpectedObject): ResolvedMaterial {
  switch (object.kind) {
    case 'wall':
      return resolved(spec, wallMaterialOf(spec));
    case 'slab': {
      const floor = firstWithRole(spec, 'floor');
      return floor ?? resolved(spec, spec.structure.material);
    }
    case 'roof':
      return resolved(spec, spec.roof.material);
    case 'opening': {
      if (object.subtype === 'door') return { id: null, name: null, block: 'air', role: null };
      const glass = firstWithRole(spec, 'glass');
      return glass ?? { id: null, name: null, block: 'glass', role: null };
    }
  }
}

function kindsFor(must: BuildSpec['musts'][number]): ReadonlySet<MatchKind> {
  const text = `${must.id}\n${must.text}`;
  const kinds = new Set<MatchKind>();
  for (const entry of KIND_KEYWORDS) if (entry.pattern.test(text)) kinds.add(entry.kind);
  return kinds;
}

interface ProjectedRow {
  readonly id: string;
  readonly kind: string;
  readonly subtype?: string;
}

function matchesKind(object: ProjectedRow, kinds: ReadonlySet<MatchKind>): boolean {
  if (object.kind === 'opening') return kinds.has(object.subtype as MatchKind);
  return kinds.has(object.kind as MatchKind);
}

/**
 * 显式 verified 链接必须与 must 的语义主题兼容；家具 / 材料 / 场地不能在只有墙 / 洞口
 * 几何证据时被标成 verified。没有可识别主题的旧 detail 保持兼容。
 */
/** 与 brief.ts 的 prefixedId 同口径：detail- / constraint- + 截断到 Identifier 上限的 id。 */
function prefixedMustId(prefix: 'detail' | 'constraint', id: string): string {
  const head = `${prefix}-`;
  return `${head}${id.slice(0, ID_MAX - head.length)}`;
}

function detailMustId(id: string): string {
  return prefixedMustId('detail', id);
}

/** furniture:/material:/site: 是声明引用，不对应投影对象，永远不能进入 verified。 */
function isNamespacedDeclaredRef(elementId: string): boolean {
  return /^(?:furniture|material|site):/.test(elementId);
}

/**
 * BuildSpec.details 只作为文档链接，全部进入 declared；linkScope 字段不再参与验证。
 * verified 只能由调用方传入的 planner 产物（`planVerifiedObjectMap`）决定。
 */
function detailLinks(spec: BuildSpec, objectIds: ReadonlySet<string>): ReadonlyMap<string, Set<string>> {
  const byElement = new Map<string, string>();
  for (const element of spec.elements) {
    if (element.kind === 'wall') byElement.set(element.id, `wall:${element.level}`);
    else if (element.kind === 'slab') byElement.set(element.id, `slab:${element.level}`);
    else if (element.kind === 'roof') byElement.set(element.id, 'roof');
  }
  for (const opening of spec.openings) byElement.set(opening.id, `opening:${opening.id}`);

  const mustIds = new Set(spec.musts.map((must) => must.id));
  const links = new Map<string, Set<string>>();
  for (const detail of spec.details) {
    const candidates = new Set<string>();
    for (const reference of [...detail.requirementIds, detailMustId(detail.id)]) {
      // details 可能引用需求图原始 constraint id（con-*），BuildSpec must 已加 constraint- 前缀。
      for (const mustId of [reference, prefixedMustId('constraint', reference)]) {
        if (mustIds.has(mustId)) candidates.add(mustId);
      }
    }
    const declared: string[] = [];
    for (const elementId of detail.elementIds) {
      const objectId = byElement.get(elementId) ?? (objectIds.has(elementId) ? elementId : null);
      // 能解析成真实投影对象时按投影处理，即使 id 字面上带 furniture:/material:/site: 前缀。
      if (objectId !== null) declared.push(objectId);
      else if (isNamespacedDeclaredRef(elementId)) declared.push(elementId);
    }
    for (const mustId of candidates) {
      let bucket = links.get(mustId);
      if (bucket === undefined) {
        bucket = new Set<string>();
        links.set(mustId, bucket);
      }
      for (const objectId of declared) bucket.add(objectId);
    }
  }
  return links;
}

function buildMusts(
  spec: BuildSpec,
  objects: readonly ProjectedRow[],
  verifiedObjects: Readonly<Record<string, readonly string[]>>,
): { readonly musts: readonly BuildSheetMust[]; readonly unlinkedMustIds: readonly string[] } {
  const byElement = detailLinks(spec, new Set(objects.map((object) => object.id)));
  const projectedIds = new Set(objects.map((object) => object.id));
  const musts = spec.musts.map((must) => {
    const kinds = kindsFor(must);
    const declared = byElement.get(must.id) ?? new Set<string>();
    const trusted = new Set((verifiedObjects[must.id] ?? []).filter((objectId) => projectedIds.has(objectId)));
    const explicitObjectIds = objects.filter((object) => trusted.has(object.id)).map((object) => object.id);
    const declaredObjectIds = [...declared].filter((objectId) => !trusted.has(objectId));
    const declaredProjected = new Set(declaredObjectIds.filter((objectId) => projectedIds.has(objectId)));
    // objectIds 是“该 must 能指到的投影对象”并集：关键词、verified 显式投影与已声明投影。
    // 声明投影可让 shadow evidence 在 artifact 映射被忽略时仍知道该 must 指向哪些对象，但永不产生 verified。
    const objectIds = objects
      .filter((object) => matchesKind(object, kinds) || trusted.has(object.id) || declaredProjected.has(object.id))
      .map((object) => object.id);
    const linkScope: BuildSheetLinkScope =
      explicitObjectIds.length > 0 ? 'verified' : declaredObjectIds.length > 0 ? 'declared' : 'none';
    const linkReason =
      linkScope === 'verified'
        ? null
        : linkScope === 'declared'
          ? 'declared-only'
          : objectIds.length > 0
            ? 'heuristic-only'
            : 'no-object-link';
    return {
      id: must.id,
      text: must.text,
      source: must.source,
      objectIds,
      explicitObjectIds,
      declaredObjectIds,
      linkScope,
      linkReason,
    };
  });
  return {
    musts,
    unlinkedMustIds: musts
      .filter((must) => must.objectIds.length === 0 && must.declaredObjectIds.length === 0)
      .map((must) => must.id),
  };
}

function buildObject(spec: BuildSpec, object: ExpectedObject, mustIds: readonly string[]): BuildSheetObject {
  const material = materialFor(spec, object);
  const base = {
    id: object.id,
    bounds: object.bounds,
    materialId: material.id,
    materialBlock: material.block,
    materialName: material.name,
    materialRole: material.role,
    mustIds,
    unverifiedReason: object.unverifiedReason,
  };
  switch (object.kind) {
    case 'wall':
      return { ...base, kind: 'wall' };
    case 'slab':
      return { ...base, kind: 'slab' };
    case 'roof':
      return {
        ...base,
        kind: 'roof',
        form: object.form,
        pitchDegrees: object.pitchDegrees,
        eaveY: object.eaveY,
        ridgeY: object.ridgeY,
        overhang: object.overhang,
      };
    case 'opening': {
      const frame = frameMaterial(spec, object);
      return {
        ...base,
        kind: 'opening',
        subtype: object.subtype,
        side: object.side,
        width: object.width,
        height: object.height,
        sillY: object.sillY,
        headY: object.headY,
        hostId: object.hostId,
        frameMaterialId: frame?.id ?? null,
        frameMaterialBlock: frame?.block ?? null,
      };
    }
  }
}

function mustsByObject(musts: readonly BuildSheetMust[]): ReadonlyMap<string, readonly string[]> {
  const byObject = new Map<string, string[]>();
  for (const must of musts) {
    for (const objectId of must.objectIds) {
      const bucket = byObject.get(objectId);
      if (bucket === undefined) byObject.set(objectId, [must.id]);
      else bucket.push(must.id);
    }
  }
  return byObject;
}

function buildObjects(
  spec: BuildSpec,
  projection: readonly ExpectedObject[],
  byObject: ReadonlyMap<string, readonly string[]>,
): readonly BuildSheetObject[] {
  return projection.map((object) => buildObject(spec, object, byObject.get(object.id) ?? []));
}

function buildFurnitureObject(
  spec: BuildSpec,
  object: ExpectedFurniture,
  mustIds: readonly string[],
): BuildSheetFurniture {
  const material = spec.materials.find((candidate) => candidate.block === object.materialBlock) ?? null;
  return {
    id: object.id,
    kind: 'furniture',
    bounds: object.bounds,
    materialId: material?.id ?? null,
    materialBlock: object.materialBlock ?? '—',
    materialName: material?.name ?? null,
    materialRole: material?.role ?? null,
    mustIds,
    unverifiedReason: object.unverifiedReason,
    furnitureKind: object.furnitureKind,
    seatCapacity: object.seatCapacity,
  };
}

function buildCheckObject(
  object: { readonly id: string; readonly label: string },
  mustIds: readonly string[],
): BuildSheetCheck {
  return {
    id: object.id,
    kind: 'check',
    label: object.label,
    bounds: null,
    materialId: null,
    materialBlock: '—',
    materialName: null,
    materialRole: null,
    mustIds,
    unverifiedReason: null,
  };
}

function firstLevel(spec: BuildSpec): BuildSpec['levels'][number] {
  const level = spec.levels[0];
  if (level === undefined) throw new Error('BuildSpec.levels is empty');
  return level;
}

function bandOf(openings: BuildSpec['openings'], window: boolean): readonly FloorDatumBand[] {
  return openings
    .filter((opening) => (opening.kind === 'window') === window)
    .map((opening) => ({ id: opening.id, minY: opening.bounds.min[1], maxY: opening.bounds.max[1] - 1 }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 入口取 BuildSpec.entranceSide（Design 已批准的新增字段；尚未落地时回退北侧）的第一个非窗洞口；
 * 没有匹配侧时回退北侧第一个，再回退第一个非窗洞口。
 */
function entranceOpening(spec: BuildSpec): BuildSpec['openings'][number] | undefined {
  const declared = (spec as BuildSpec & { readonly entranceSide?: BuildSpec['openings'][number]['side'] }).entranceSide;
  const candidates = spec.openings.filter((opening) => opening.kind !== 'window');
  return (
    (declared === undefined ? undefined : candidates.find((opening) => opening.side === declared)) ??
    candidates.find((opening) => opening.side === 'north') ??
    candidates[0]
  );
}

/**
 * BuildSpec → FloorDatum 同口径派生。Design 的 deriveFloorDatum 以 DesignScheme 为输入；
 * BuildSpec 已经带着 levels / siteBounds / structure.floorThickness / openings，因此这里只复用
 * 同一套字段、冲突文案与选项，不另造 floorY。真正的跨实现一致性由 floor-datum-crosscheck 测试锁定。
 */
function deriveDatum(spec: BuildSpec): {
  readonly datum: BuildSheetDatum;
  readonly conflict: FloorDatumConflict | null;
} {
  const level = firstLevel(spec);
  const standingY = level.elevation;
  const slabTopY = standingY - spec.structure.floorThickness;
  const gradeY = siteTopY(spec);
  const flushMusts = spec.musts.filter((must) => isFlushMustText(must.text));
  const flushRequired = flushMusts.length > 0;
  const entrance = entranceOpening(spec);
  const entryThresholdY = entrance?.bounds.min[1] ?? standingY;
  const entryTransition = entrance === undefined ? 'unknown' : gradeY === standingY ? 'flush' : 'one-step';
  const unresolved = flushRequired && entryTransition !== 'flush';
  const doors = bandOf(spec.openings, false);
  const windows = bandOf(spec.openings, true);
  const datum: BuildSheetDatum = {
    gradeY,
    standingY,
    slabTopY,
    entryThresholdY,
    entryTransition,
    source:
      entryTransition === 'flush' ? (flushRequired ? 'raise-site' : 'actual') : flushRequired ? 'unresolved' : 'actual',
    recommendedSource: unresolved ? 'raise-site' : null,
    targetGradeY: unresolved ? standingY : null,
    doors,
    windows,
    evidence: [
      `level ${level.id} elevation=${String(standingY)}`,
      `site top y${String(gradeY)} (min=${String(spec.siteBounds.min[1])}, max=${String(spec.siteBounds.max[1])})`,
      `slab top y${String(slabTopY)}; standing y${String(standingY)}; floorThickness ${String(spec.structure.floorThickness)}`,
      entrance === undefined ? 'entrance=missing' : `entrance ${entrance.id} bottom=${String(entryThresholdY)}`,
      entryTransition === 'flush'
        ? `grade and standing both y${String(standingY)}`
        : `grade y${String(gradeY)} vs standing y${String(standingY)}`,
    ],
    summary: `楼板顶 y${String(slabTopY)}；站立面 y${String(standingY)}；室外地面 y${String(gradeY)}；入口 ${entryTransition}；门 ${rangesText(doors)}；窗 ${rangesText(windows)}`,
  };

  if (!unresolved) return { datum, conflict: null };
  const conflict: FloorDatumConflict = {
    id: 'conflict-flush-entry',
    kind: 'flush-entry',
    mustIds: flushMusts.map((must) => must.id),
    expected: `室外地面与室内地面同高 y${String(standingY)}，入口无高差`,
    actual:
      entrance === undefined
        ? `未识别入口洞口；室外地面 y${String(gradeY)}，室内地面 y${String(standingY)}`
        : `室外地面 y${String(gradeY)}，入口底 y${String(entryThresholdY)}，室内地面 y${String(standingY)}`,
    recommendedSource: 'raise-site',
    targetGradeY: standingY,
    resolution: `将场地/基座抬至 y${String(standingY)}；否则由用户明确选择接受高差或豁免 must，不得静默接受。`,
    options: FLOOR_DATUM_OPTIONS,
  };
  return { datum, conflict };
}

function rangesText(ranges: readonly BuildSheetDatumOpening[]): string {
  if (ranges.length === 0) return '—';
  return ranges
    .map((range) =>
      range.minY === range.maxY ? `y${String(range.minY)}` : `y${String(range.minY)}..${String(range.maxY)}`,
    )
    .join('、');
}

function buildLayers(spec: BuildSpec): BuildSheetLayers {
  return {
    priority: ['opening', 'structure', 'decoration'],
    recipe: [
      'opening：先按对象表挖洞口；门填 air、窗填玻璃，框用 frameMaterial。',
      'structure：墙、楼板、屋面按半开 bounds 与材质建造，不得移动或缩放。',
      'decoration：家具、线脚、景观只做装饰，不得改变结构 bounds 或洞口。',
    ],
    materials: spec.materials.map((material) => ({
      id: material.id,
      name: material.name,
      block: material.block,
      role: material.role,
    })),
  };
}

/**
 * 场地顶面：BuildSpec.siteBounds.max 在当前编译器里是设计包络（通常到屋脊），不是场地顶面。
 * 生成的场地是 `outdoorY..outdoorY+1` 的一层，顶面 = min+1；只有 max 落在站立面或以下、
 * 确实可能表示多层场地顶面时，才把 max 当作实际顶面。
 */
function siteTopY(spec: BuildSpec): number {
  const min = spec.siteBounds.min[1];
  const max = spec.siteBounds.max[1];
  const standingY = firstLevel(spec).elevation;
  return max <= standingY ? max : min + 1;
}

function buildMustLinkage(musts: readonly BuildSheetMust[]): BuildSheetMustLinkage {
  const linked = musts.filter((must) => must.objectIds.length > 0 || must.declaredObjectIds.length > 0).length;
  const verified = musts.filter((must) => must.explicitObjectIds.length > 0).length;
  const declaredCount = musts.filter((must) => must.declaredObjectIds.length > 0).length;
  const explicit = musts.filter(
    (must) => must.explicitObjectIds.length > 0 || must.declaredObjectIds.length > 0,
  ).length;
  return {
    linked,
    unlinked: musts.length - linked,
    explicit,
    explicitLinks: explicit,
    verified,
    declared: declaredCount,
    heuristicOnly: musts.filter(
      (must) => must.explicitObjectIds.length === 0 && must.declaredObjectIds.length === 0 && must.objectIds.length > 0,
    ).length,
    // 没有任何显式链接（verified 或 declared-only）的 must 数；等于 heuristicOnly + 真正 unlinked。
    noDeclaredLinks: musts.filter((must) => must.explicitObjectIds.length === 0 && must.declaredObjectIds.length === 0)
      .length,
    heuristic: true,
    note: 'must linked ≠ must verified：只有 details 的 verified 显式链接可进入 verified-must-map；linkScope=declared 与未解析的 furniture/material/site 引用只声明不验证；关键词链接仍是启发式；unlinked 表示既无 objectIds 也无 declared 链接，这些 must 保持 unverified，不能作为证据。',
  };
}

/** 纯派生：同一 BuildSpec 永远得到逐字节一致的 JSON（markdown 也确定）。 */
/** expected 投影默认按 1 格楼板；BuildSheet 用实际 floorThickness 校正首层楼板包络。 */
function withSlabTop(
  objects: readonly ExpectedObject[],
  slabTopY: number,
  standingY: number,
  levelId: string,
): readonly ExpectedObject[] {
  return objects.map((object) =>
    object.kind === 'slab' && object.id === `slab:${levelId}`
      ? {
          ...object,
          bounds: {
            min: [object.bounds.min[0], slabTopY, object.bounds.min[2]] as const,
            max: [object.bounds.max[0], standingY, object.bounds.max[2]] as const,
          },
        }
      : object,
  );
}

/**
 * 只接受 planner 本体返回、且与当前 spec 的 scheme id / revision 完全一致的 verified map。
 * 伪造、复制或跨方案复用的 map 一律当作空映射，既不报错也不进入 verified。
 */
function trustedPlannerObjectMap(
  spec: BuildSpec,
  verifiedObjects: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  if (isPlannerVerifiedObjectMap(verifiedObjects, spec.schemeId, spec.schemeRevision)) return verifiedObjects;
  // 离线 loader 显式 adopt 的 mapping scheme 必须绑定同一 scheme + revision。
  const stamp = adoptedSchemeMaps.get(verifiedObjects);
  if (stamp?.schemeId === spec.schemeId && stamp.schemeRevision === spec.schemeRevision) {
    return verifiedObjects;
  }
  return {};
}

export function buildBuildSheet(
  spec: BuildSpec,
  verifiedObjects: Readonly<Record<string, readonly string[]>> = {},
): BuildSheet {
  const { datum, conflict } = deriveDatum(spec);
  const projection = projectExpectedObjects(spec);
  const objects = withSlabTop(projection.objects, datum.slabTopY, datum.standingY, firstLevel(spec).id);
  const furnitureProjection = projectExpectedFurniture(spec);
  const coverageProjection = projectCoverageObjects(spec);
  const trustedObjects = trustedPlannerObjectMap(spec, verifiedObjects);
  const allProjected: readonly ProjectedRow[] = [
    ...objects,
    ...furnitureProjection,
    ...coverageProjection.map((object) => ({ id: object.id, kind: object.kind })),
  ];
  const { musts, unlinkedMustIds } = buildMusts(spec, allProjected, trustedObjects);
  const byObject = mustsByObject(musts);
  const derived = {
    schemaVersion: 2 as const,
    tool: 'build-sheet' as const,
    schemeId: spec.schemeId,
    schemeRevision: spec.schemeRevision,
    title: spec.title,
    bounds: spec.bounds,
    siteBounds: spec.siteBounds,
    objects: buildObjects(spec, objects, byObject),
    furnitureObjects: furnitureProjection.map((object) =>
      buildFurnitureObject(spec, object, byObject.get(object.id) ?? []),
    ),
    coverageObjects: coverageProjection.map((object) => buildCheckObject(object, byObject.get(object.id) ?? [])),
    expectedObjects: objects,
    datum,
    layers: buildLayers(spec),
    musts,
    unlinkedMustIds,
    mustLinkage: buildMustLinkage(musts),
    conflicts: conflict === null ? [] : [conflict],
  };
  const content: BuildSheetContent = {
    ...derived,
    callCards: buildConstructionCallCards(spec, derived),
  };
  return { ...content, markdown: renderBuildSheetMarkdown(content) };
}

/** 只有 builder / loader 产出的 mapping 才能让 conformance-evidence 采用 verified 语义。 */
const verifiedMustMappings = new WeakSet<object>();
interface AdoptedSchemeStamp {
  readonly schemeId: string;
  readonly schemeRevision: number;
}
/** loader 登记过的 mapping 里的 scheme map 也可作为 BuildSheet 的离线投影输入。 */
const adoptedSchemeMaps = new WeakMap<object, AdoptedSchemeStamp>();

export function isVerifiedMustMapping(value: unknown): value is VerifiedMustMapping {
  return typeof value === 'object' && value !== null && verifiedMustMappings.has(value);
}

/** 从磁盘 mapping 读回时显式登记；形状由调用方先校验（loadVerifiedMapping）。 */
export function adoptVerifiedMustMapping(value: unknown): VerifiedMustMapping {
  if (typeof value !== 'object' || value === null) throw new Error('verified-must-map 必须是对象');
  verifiedMustMappings.add(value);
  const revision = (value as { readonly schemeRevision?: unknown }).schemeRevision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision <= 0) {
    throw new Error('verified-must-map 缺少有效 schemeRevision');
  }
  const schemes = (value as { readonly schemes?: unknown }).schemes;
  if (typeof schemes === 'object' && schemes !== null && !Array.isArray(schemes)) {
    for (const [schemeId, scheme] of Object.entries(schemes as Record<string, unknown>)) {
      if (typeof scheme === 'object' && scheme !== null) {
        adoptedSchemeMaps.set(scheme, { schemeId, schemeRevision: revision });
      }
    }
  }
  return value as VerifiedMustMapping;
}

/**
 * 纯派生：只把 BuildSpec.details 的显式 requirement / detail 链接写成 VerifiedMustMapping。
 * 关键词启发式链接永远不进入 verified；没有显式链接的 scheme 与 must 整体省略。
 */
export function buildVerifiedMustMapping(
  spec: BuildSpec,
  verifiedObjects: Readonly<Record<string, readonly string[]>> = {},
): VerifiedMustMapping {
  const projectedIds = new Set([
    ...projectExpectedObjects(spec).objects.map((object) => object.id),
    ...projectExpectedFurniture(spec).map((object) => object.id),
    ...projectCoverageObjects(spec).map((object) => object.id),
  ]);
  const trustedObjects = trustedPlannerObjectMap(spec, verifiedObjects);
  const entries: [string, readonly string[]][] = [];
  for (const must of spec.musts) {
    const objectIds = [...new Set(trustedObjects[must.id] ?? [])].filter((objectId) => projectedIds.has(objectId));
    if (objectIds.length > 0) entries.push([must.id, objectIds]);
  }
  const mapping: VerifiedMustMapping = {
    schemaVersion: 1,
    tool: 'verified-must-map',
    mapping: 'verified',
    schemeRevision: spec.schemeRevision,
    schemes: entries.length === 0 ? {} : { [spec.schemeId]: Object.fromEntries(entries) },
  };
  verifiedMustMappings.add(mapping);
  return mapping;
}

function formatBounds(bounds: ExpectedObject['bounds']): string {
  return `[${bounds.min.join(',')}]..[${bounds.max.join(',')})`;
}

function objectDetail(object: BuildSheetRow): string {
  switch (object.kind) {
    case 'roof':
      return `${object.form} ${String(object.pitchDegrees)}° eave ${String(object.eaveY)} ridge ${String(object.ridgeY)} overhang ${String(object.overhang)}`;
    case 'opening':
      return `${object.subtype} ${object.side} ${String(object.width)}×${String(object.height)} sill y${String(object.sillY)} head y${String(object.headY)}`;
    case 'furniture':
      return `${object.furnitureKind}${object.seatCapacity === null ? '' : ` ${String(object.seatCapacity)} 座`}`;
    case 'check':
      return object.label;
    case 'wall':
    case 'slab':
      return '—';
  }
}

function materialText(object: BuildSheetRow): string {
  if (object.kind === 'check') return '—';
  const id = object.materialId === null ? '' : ` · ${object.materialId}/${object.materialRole ?? '—'}`;
  const frame =
    object.kind === 'opening' && object.frameMaterialBlock !== null ? `；框 ${object.frameMaterialBlock}` : '';
  return `${object.materialBlock}${id}${frame}`;
}

function rowBounds(object: BuildSheetRow): string {
  return object.bounds === null ? '—' : formatBounds(object.bounds);
}

function renderMarkdown(sheet: BuildSheetContent): string {
  const lines: string[] = [];
  lines.push(`# BuildSheet — ${sheet.title}`, '');
  lines.push(`- schemaVersion: ${String(sheet.schemaVersion)}`);
  lines.push(`- tool: ${sheet.tool}`);
  lines.push(`- scheme: ${sheet.schemeId} rev ${String(sheet.schemeRevision)}`);
  lines.push(`- bounds: ${formatBounds(sheet.bounds)}（半开）`);
  lines.push(`- siteBounds: ${formatBounds(sheet.siteBounds)}（半开）`);
  lines.push(
    `- objects: ${String(sheet.objects.length)}；furniture: ${String(sheet.furnitureObjects.length)}；coverage: ${String(sheet.coverageObjects.length)}；musts: ${String(sheet.musts.length)}`,
  );
  lines.push('', '## 基准面', '', `基准面：${sheet.datum.summary}`, '');
  lines.push(...renderConstructionCallCards(sheet.callCards), '');
  lines.push('## 期望对象', '');
  lines.push('bounds 为半开区间 `[min]..[max)`。');
  lines.push('');
  lines.push('| id | kind | bounds | 材质 | 形式 / 洞口 | mustIds |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const object of [...sheet.objects, ...sheet.furnitureObjects, ...sheet.coverageObjects]) {
    lines.push(
      `| \`${object.id}\` | ${object.kind} | ${rowBounds(object)} | ${materialText(object)} | ${objectDetail(object)} | ${object.mustIds.length === 0 ? '—' : object.mustIds.join(', ')} |`,
    );
  }
  lines.push('', '## 材料 / 层次做法', '');
  lines.push(`- 优先级：${sheet.layers.priority.join(' > ')}`);
  for (const step of sheet.layers.recipe) lines.push(`- ${step}`);
  lines.push('', '| material id | name | block | role |', '| --- | --- | --- | --- |');
  for (const material of sheet.layers.materials) {
    lines.push(`| ${material.id} | ${material.name} | ${material.block} | ${material.role} |`);
  }
  lines.push('', '## Must 链接状态', '');
  lines.push(
    `- must linked ≠ must verified：${String(sheet.mustLinkage.linked)}/${String(sheet.musts.length)} 有对象或声明链接，${String(sheet.mustLinkage.unlinked)} 未链接；其中纯关键词启发式 ${String(sheet.mustLinkage.heuristicOnly)}。`,
  );
  lines.push(
    `- 显式链接 explicit ${String(sheet.mustLinkage.explicit)}/${String(sheet.musts.length)} = verified ${String(sheet.mustLinkage.verified)}（只有这些可进入 verified-must-map）+ declared-only ${String(sheet.mustLinkage.declared)}；无显式链接 ${String(sheet.mustLinkage.noDeclaredLinks)}/${String(sheet.musts.length)}。`,
  );
  lines.push('- 未链接 must 保持 unverified，不能作为证据；链接也不等于已核验。');
  lines.push('', `## Musts（${String(sheet.musts.length)}）`, '');
  for (const must of sheet.musts) {
    const reason = must.linkReason === null ? '' : `: ${must.linkReason}`;
    const objects = must.objectIds.length === 0 ? '未链接（unverified）' : must.objectIds.join(', ');
    // objectIds 已展示的投影对象不再在 declared 后缀里重复；这里只剩 declared-only / namespaced 引用。
    const declaredExtras = must.declaredObjectIds.filter((id) => !must.objectIds.includes(id));
    const declaredObjects = declaredExtras.length === 0 ? '' : `；declared: ${declaredExtras.join(', ')}`;
    // W11-07：L1 承诺 must 全文可用于核对语义；这里直接渲染 text，避免模型只能回读 task.fed。
    const text = must.text.replace(/\s+/g, ' ').trim();
    const mustText = text === '' ? '' : `；text: ${text}`;
    lines.push(
      `- \`${must.id}\` [${must.source}] (${must.linkScope}${reason}) → ${objects}${declaredObjects}${mustText}`,
    );
  }
  lines.push('', '## 冲突', '');
  if (sheet.conflicts.length === 0) {
    lines.push('- 无未解决冲突。');
  } else {
    for (const conflict of sheet.conflicts) {
      lines.push(`- **${conflict.id}**（${conflict.kind}）`);
      lines.push(`  - mustIds: ${conflict.mustIds.join(', ')}`);
      lines.push(`  - expected: ${conflict.expected}`);
      lines.push(`  - actual: ${conflict.actual}`);
      lines.push(`  - resolution: ${conflict.resolution}`);
      // W11-07：L1 承诺冲突 options 可见；用户选择持久化需要这些 id / label。
      lines.push(`  - options: ${conflict.options.map((option) => `${option.id}=${option.label}`).join('；')}`);
    }
  }
  lines.push('', '## 规则', '');
  lines.push('BuildSheet 是机器真相（machine truth）；design.md 是散文（prose）。');
  lines.push('两者不一致时必须报告为冲突（conflict），不得静默选择（never silently chosen）。');
  return `${lines.join('\n')}\n`;
}

export function renderBuildSheetMarkdown(sheet: BuildSheetContent): string {
  return renderMarkdown(sheet);
}

/** 机器视图不重复 markdown 正文；字段顺序固定，便于逐字节比较。 */
export function renderBuildSheetJson(sheet: BuildSheetContent & { readonly markdown?: string }): string {
  const content: Record<string, unknown> = { ...sheet };
  delete content['markdown'];
  return `${JSON.stringify(content, null, 2)}\n`;
}

export interface BuildSheetArtifactPaths {
  readonly jsonPath: string;
  readonly markdownPath: string;
}

export function writeBuildSheetArtifacts(dir: string, sheet: BuildSheetContent): BuildSheetArtifactPaths {
  const paths = { jsonPath: join(dir, 'build-sheet.json'), markdownPath: join(dir, 'build-sheet.md') };
  mkdirSync(dir, { recursive: true });
  writeFileSync(paths.jsonPath, renderBuildSheetJson(sheet), 'utf8');
  writeFileSync(paths.markdownPath, renderBuildSheetMarkdown(sheet), 'utf8');
  return paths;
}

/** 固定字段顺序 + 2 空格缩进，便于逐字节比较与重放。 */
export function renderVerifiedMustMapJson(mapping: VerifiedMustMapping): string {
  return `${JSON.stringify(mapping, null, 2)}\n`;
}

/** 写 `<dir>/verified-must-map.json`；返回实际文件路径。 */
export function writeVerifiedMustMapArtifact(dir: string, mapping: VerifiedMustMapping): string {
  const path = join(dir, 'verified-must-map.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderVerifiedMustMapJson(mapping), 'utf8');
  return path;
}
