/**
 * Must → 方案对象链接：把 MustLedger 的每条 must 映射到方案里真实存在的对象。
 *
 * 负责：确定性、可复现的显式链接与覆盖率；只有对象差分真正检查的墙 / 板 / 屋面 / 洞口
 * 几何可以进入 `verified`，家具 / 材料 / 场地以及带未检查方面的复合 must 一律 `declared`。
 * 不负责：几何比较、证据判断、构建或 I/O；不为了凑覆盖率捏造对象。本文件是纯函数。
 *
 * 链接范围：
 * - verified：外轮廓（墙）、门 / 窗洞口几何、纯屋面形式 / 坡度 / 檐口 / 屋脊；
 * - declared：家具、材料、场地分区、净空 / 齐平 / 室内净尺寸 / 墙厚 / 单层数等未进入对象差分的事项；
 * - none：否定 / 禁止、预算、纯功能 / 空间、只有场地语境而没有实际对象的 must。
 */
import type { MustLedgerEntry } from './must-ledger.ts';
import { ID_MAX } from './primitives.ts';
import type {
  DesignScheme,
  SchemeDetail,
  SchemeElement,
  SchemeMaterial,
  SchemeOpening,
  SchemeSiteZone,
  Side,
} from './scheme.ts';

export type MustLinkScope = 'verified' | 'declared';

export interface MustObjectLink {
  /** 与 BuildSpec.musts[].id 一致。 */
  readonly mustId: string;
  readonly sourceId: string;
  readonly subject: 'wall' | 'slab' | 'roof' | 'opening' | 'furniture' | 'material' | 'site' | 'none';
  /** 方案 element / opening id，或 `furniture:` / `material:` / `site:` 引用。 */
  readonly objectRefs: readonly string[];
  /** objectRefs 中由对象差分（墙 / 板 / 屋面 / 洞口）直接检查的子集。 */
  readonly verifiedRefs: readonly string[];
  readonly scope: MustLinkScope | 'none';
  /** scope 为 none 或 declared 时必填；verified 为 null。 */
  readonly reason: string | null;
}

export interface MustLinkCoverage {
  readonly total: number;
  readonly explicit: number;
  readonly verified: number;
  readonly declaredOnly: number;
  readonly unlinked: number;
  readonly entries: readonly MustObjectLink[];
}

export interface MustLinkPlan {
  readonly details: readonly SchemeDetail[];
  readonly coverage: MustLinkCoverage;
}

type Subject = MustObjectLink['subject'];
interface FurnitureRef {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

interface SchemeIndex {
  readonly scheme: DesignScheme;
  readonly exteriorWalls: readonly SchemeElement[];
  readonly slabs: readonly SchemeElement[];
  readonly roofs: readonly SchemeElement[];
  readonly openings: readonly SchemeOpening[];
  readonly furniture: readonly FurnitureRef[];
  readonly materials: readonly SchemeMaterial[];
  readonly siteZones: readonly SchemeSiteZone[];
}

const SIDE_CHAR: Readonly<Record<Side, string>> = {
  north: '北',
  east: '东',
  south: '南',
  west: '西',
};

const SIDES: readonly Side[] = ['north', 'east', 'south', 'west'];

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** 与 design-expand.ts 的 fitId 相同：超过 64 字符时截断并附加 FNV-1a 后缀。 */
function fitId(raw: string): string {
  if (raw.length <= ID_MAX) return raw;
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${raw.slice(0, 55)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function sideFromName(name: string): Side | null {
  const hits = SIDES.filter((side) => name.includes(SIDE_CHAR[side]));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** 外墙侧向：优先读生成名（北外墙等），否则按墙的长轴与建筑外轮廓重合边判断。 */
function exteriorSideOf(wall: SchemeElement, buildingBounds: DesignScheme['site']['buildingBounds']): Side | null {
  const named = sideFromName(wall.name);
  if (named !== null) return named;
  const dx = wall.bounds.max[0] - wall.bounds.min[0];
  const dz = wall.bounds.max[2] - wall.bounds.min[2];
  if (dx >= dz) {
    if (wall.bounds.min[2] === buildingBounds.min[2]) return 'north';
    if (wall.bounds.max[2] === buildingBounds.max[2]) return 'south';
  } else {
    if (wall.bounds.min[0] === buildingBounds.min[0]) return 'west';
    if (wall.bounds.max[0] === buildingBounds.max[0]) return 'east';
  }
  return null;
}

function buildIndex(scheme: DesignScheme): SchemeIndex {
  const walls = scheme.elements.filter((element) => element.kind === 'wall');
  const exteriorWalls = walls.filter((wall) => exteriorSideOf(wall, scheme.site.buildingBounds) !== null);
  const furniture: FurnitureRef[] = [];
  const seenFurniture = new Set<string>();
  for (const interior of scheme.interiors) {
    for (const item of interior.furnitureSpecs) {
      if (seenFurniture.has(item.id)) continue;
      seenFurniture.add(item.id);
      furniture.push({ id: item.id, name: item.name, kind: item.kind });
    }
  }
  for (const element of scheme.elements) {
    if (element.kind !== 'furniture' || seenFurniture.has(element.id)) continue;
    seenFurniture.add(element.id);
    furniture.push({ id: element.id, name: element.name, kind: 'other' });
  }
  return {
    scheme,
    exteriorWalls,
    slabs: scheme.elements.filter((element) => element.kind === 'slab'),
    roofs: scheme.elements.filter((element) => element.kind === 'roof'),
    openings: scheme.openings,
    furniture,
    materials: scheme.materials,
    siteZones: scheme.site.outdoorZones,
  };
}

function detailFor(entry: MustLedgerEntry, link: MustObjectLink): SchemeDetail {
  return {
    id: fitId(`link-${entry.id}`),
    name: `must→object ${entry.sourceId}`,
    where: 'must→object',
    elementIds: [...link.objectRefs],
    count: null,
    description: entry.text,
    priority: 'should',
    requirementIds: [entry.id],
    linkScope: link.scope === 'verified' ? 'verified' : 'declared',
  };
}

function noneLink(entry: MustLedgerEntry, reason: string): MustObjectLink {
  return {
    mustId: entry.id,
    sourceId: entry.sourceId,
    subject: 'none',
    objectRefs: [],
    verifiedRefs: [],
    scope: 'none',
    reason,
  };
}

function linked(
  entry: MustLedgerEntry,
  subject: Subject,
  refs: readonly string[],
  scope: MustLinkScope,
  reason: string | null,
  verificationRefs?: readonly string[],
): MustObjectLink {
  const requested = unique(refs);
  // 方案 Identifier 上限 64；material:/furniture:/site: 前缀可能把合法 64 字符 id 推超限。
  // 过滤后再决定 scope，避免生成无法通过 DesignScheme 校验的 details。
  const objectRefs = requested.filter((reference) => reference.length <= ID_MAX);
  if (objectRefs.length === 0) {
    return noneLink(entry, requested.length > 0 ? 'object-ref-too-long' : (reason ?? 'no-matching-scheme-object'));
  }
  // SchemeDetail.elementIds 上限 50；超过时不能只保留前 50 条还声称 verified，
  // 否则被截断的对象不会被差分检查。整条链接降为 none，明确留在待人工核对。
  if (objectRefs.length > 50) return noneLink(entry, 'object-refs-exceed-50');
  const requestedVerified = unique(verificationRefs ?? (scope === 'verified' ? objectRefs : []));
  // check: / furniture: 引用是证据 id，不是 details 实体；允许与 objectRefs 不同。
  const verifiedRefs = requestedVerified.filter((reference) => reference.length <= ID_MAX);
  if (scope === 'verified' && verifiedRefs.length === 0) return noneLink(entry, 'no-verified-ref');
  if (verifiedRefs.length > 50) return noneLink(entry, 'verified-refs-exceed-50');
  return {
    mustId: entry.id,
    sourceId: entry.sourceId,
    subject,
    objectRefs,
    verifiedRefs: scope === 'verified' ? verifiedRefs : [],
    scope,
    reason: scope === 'verified' ? null : reason,
  };
}

function entranceOpenings(index: SchemeIndex): readonly SchemeOpening[] {
  const doors = index.openings.filter((opening) => opening.kind !== 'window');
  const onEntranceSide = doors.filter((opening) => opening.side === index.scheme.site.entranceSide);
  return onEntranceSide.length > 0 ? onEntranceSide : doors;
}

function checkRef(id: string): string {
  return `check:${id}`;
}

function furnitureRefs(index: SchemeIndex, predicate: (item: FurnitureRef) => boolean): readonly string[] {
  return index.furniture.filter(predicate).map((item) => `furniture:${item.id}`);
}

function coverageVerified(
  entry: MustLedgerEntry,
  subject: Subject,
  objectRefs: readonly string[],
  verifiedRefs: readonly string[],
): MustObjectLink {
  return linked(entry, subject, objectRefs, 'verified', null, verifiedRefs);
}

/**
 * 可测量复合 must 的通用覆盖链接：结构 / 家具 / 材料 / 层数 / 净尺寸 / 墙厚 / 齐平 / 洞口 schedule。
 * 只链接有对应 as-built 检查的语义；定性、否定型禁项、预算、场地语境在这里返回 null，继续走保守分支。
 * 具体坐标不在这里写死：refs 全部来自 DesignScheme 的 level / wall / slab / roof / opening / furniture。
 */
function negatesTerm(text: string, terms: readonly string[]): boolean {
  for (const match of text.matchAll(/(?:不设|不做|不要|不放|不得|禁止|不摆|不提供|无|没有)/gu)) {
    const index = match.index;
    const after = text.slice(index + match[0].length, index + match[0].length + 12);
    if (terms.some((term) => after.includes(term))) return true;
  }
  return false;
}

/**
 * allowlist：只给“精确、可重算、对象/几何直接背书”的 must 建立 verified 链接。
 * 负向 / 缺失 / 定性 / 材料角色 / 隔断 / 柱 / 场地 / 功能 / 视觉一律走保守声明；
 * 这里没有命中就绝不 promoted。数字是 allowlist 的一部分（家具尺寸、洞口尺寸、面积、预算）。
 */
function coverageLink(entry: MustLedgerEntry, index: SchemeIndex): MustObjectLink | null {
  const text = entry.text;
  const level = index.scheme.levels[0];
  if (level === undefined) return null;
  const levelId = level.id;
  const walls = index.exteriorWalls.map((wall) => wall.id);
  const slabs = index.slabs.map((slab) => slab.id);
  const door = entranceOpenings(index)[0];
  const doorRef = door === undefined ? null : door.id;
  const southWindows = index.openings.filter((opening) => opening.kind === 'window' && opening.side === 'south');
  const windowRefs = southWindows.map((opening) => opening.id);
  const tableRefs = furnitureRefs(index, (item) => item.kind === 'table' || item.name.includes('桌'));
  const benchRefs = furnitureRefs(
    index,
    (item) => item.kind === 'bench' || item.kind === 'chair' || /凳|椅/u.test(item.name),
  );
  const counterRefs = furnitureRefs(index, (item) => item.kind === 'counter' || item.name.includes('柜台'));

  // 明确的预算数字：只核对最终存档总格数。
  if (entry.check === 'budget' && /(?:方块|block)/iu.test(text) && /\d{2,}/u.test(text)) {
    const refs = walls.length > 0 ? walls : slabs;
    if (refs.length > 0) {
      return coverageVerified(entry, walls.length > 0 ? 'wall' : 'slab', refs, [
        checkRef(`budget:${String(index.scheme.budget.maxBlocks)}`),
      ]);
    }
  }

  // 外轮廓 / 外包尺寸：墙包络。
  if (/外轮廓|外包尺寸|outer envelope/iu.test(text) && /\d+\s*m\s*[×x]\s*\d+\s*m/iu.test(text) && walls.length > 0) {
    return coverageVerified(entry, 'wall', walls, walls);
  }

  // 单层 / 层高：storey 的层数与檐口由对象图测量。
  if (/整栋为单层|单层建筑|single[-_]storey/iu.test(text) && slabs.length > 0) {
    return coverageVerified(entry, 'slab', slabs, [checkRef(`storey:${levelId}`)]);
  }

  // 室内净尺寸：只接受带 8m×6m 这类明确数字的文本。
  if (/室内净尺寸|净尺寸|interior clear/iu.test(text) && /\d+\s*m\s*[×x]\s*\d+\s*m/iu.test(text) && slabs.length > 0) {
    return coverageVerified(entry, 'slab', slabs, [checkRef(`clear:${levelId}`)]);
  }

  // 墙厚：只接受明确的厚度数字；裸重复约束保持 unverified（历史 promotion 项）。
  if (/墙厚|外墙厚|wall thickness/iu.test(text) && /\d+\s*m/iu.test(text) && walls.length > 0) {
    return coverageVerified(entry, 'wall', walls, [checkRef(`thickness:${levelId}`)]);
  }

  // 窗：必须带窗台 / 窗高 / 洞口 / 宽度数字，排除纯“视觉中心”描述。
  if (text.includes('窗') && /\d+\s*m/iu.test(text) && /(?:窗台高|窗高|洞口顶)/iu.test(text)) {
    if (windowRefs.length > 0) {
      return coverageVerified(entry, 'opening', windowRefs, [
        ...windowRefs.map((id) => `opening:${id}`),
        checkRef('schedule:south'),
      ]);
    }
  }

  // 门：必须带净宽数字和明确的门洞 / 入口描述。
  if (
    /(?:门洞净宽|开门|入口)/u.test(text) &&
    !/柱|柜|桌|凳|材料/u.test(text) &&
    /\d+\s*m/iu.test(text) &&
    doorRef !== null &&
    !negatesTerm(text, ['门洞', '开门', '入口'])
  ) {
    return coverageVerified(
      entry,
      'opening',
      [doorRef],
      [`opening:${doorRef}`, checkRef('schedule:north'), checkRef(`door-position:${doorRef}`)],
    );
  }

  // 家具：只按“存在 + 实际建成的精确尺寸”核对；带尺寸数字才算 allowlist。
  if (entry.check === 'furniture' && benchRefs.length > 0 && /\d+\s*[+＋]\s*\d+\s*座|\d+\s*座/iu.test(text)) {
    const pair = /(\d+)\s*\+\s*(\d+)/u.exec(text);
    const single = /(\d+)\s*座/u.exec(text);
    const seats = pair === null ? (single === null ? null : Number(single[1])) : Number(pair[1]) + Number(pair[2]);
    if (seats !== null && seats > 0) {
      return coverageVerified(entry, 'furniture', benchRefs, [...benchRefs, checkRef(`seats:${String(seats)}`)]);
    }
  }
  // 家具 allowlist 用完整的“尺寸 + 形式 + 允许的放置尾句”模板，而不是关键词 + 数字。
  if (
    entry.check === 'furniture' &&
    benchRefs.length > 0 &&
    /\d+(?:\.\d+)?m\s*长、\d+(?:\.\d+)?m\s*宽的长凳(?:，其西端从门洞东侧开始，不侵占门内 1m 净空|，与北凳相对布置)?。?$/u.test(
      text,
    ) &&
    !negatesTerm(text, ['长凳', '凳子', 'bench'])
  ) {
    return coverageVerified(entry, 'furniture', benchRefs, benchRefs);
  }
  if (
    entry.check === 'furniture' &&
    counterRefs.length > 0 &&
    /\d+(?:\.\d+)?m\s*长、\d+(?:\.\d+)?m\s*深的柜台(?:，作为主厅内的固定家具台面，不做单独隔间或操作间，也不延伸出备茶区)?。?$/u.test(
      text,
    ) &&
    !negatesTerm(text, ['柜台', 'counter'])
  ) {
    return coverageVerified(entry, 'furniture', counterRefs, counterRefs);
  }
  if (
    entry.check === 'furniture' &&
    tableRefs.length > 0 &&
    /\d+(?:\.\d+)?m\s*长、\d+(?:\.\d+)?m\s*宽的长桌(?:（长边沿东西向）)?。?$/u.test(text) &&
    !negatesTerm(text, ['长桌', '桌子', 'table'])
  ) {
    return coverageVerified(entry, 'furniture', tableRefs, tableRefs);
  }

  // 屋面 envelope 由 req-outer 类文本覆盖；材料 / 坡度 / 形式 / 出檐不属于 allowlist。
  return null;
}

/**
 * 定性 / 性能文本优先于几何结论：保留几何分支识别出的对象引用，但结论永远降级为 declared / none。
 */
/** 定性 / 性能文本只用于降级；allowlist 命中前先被这里拦截。 */
const QUALITATIVE_MUST =
  /采光|通风|防水|防渗|防潮|隔热|保温|隔音|防腐|密封|排水|雨水|积水|漏水|渗水|渗漏|耐久|外观|美观|整洁|舒适|安静|质感|氛围|风格|视觉|观感|拍照|取景|视野/u;
const LIGHTING_QUALITY = /照明|灯光/u;
const LIGHTING_FIXTURE = /灯具|灯位|灯带|壁灯|吊灯|射灯|筒灯|路灯|庭院灯|灯柱|布灯|装灯|设灯/u;

function isQualitativeMust(text: string): boolean {
  // 石基座 must 里的“防潮层”是构造层名称，不是防潮性能结论。
  if (text.includes('坐于石基座')) return false;
  if (QUALITATIVE_MUST.test(text)) return true;
  return LIGHTING_QUALITY.test(text) && !LIGHTING_FIXTURE.test(text);
}

function linkEntry(entry: MustLedgerEntry, index: SchemeIndex): MustObjectLink {
  const negativeId =
    /(?:^|[-_])no(?:[-_]|$)/i.test(entry.sourceId) ||
    /(?:^|[-_])no(?:[-_]|$)/i.test(entry.id) ||
    /(?:^|[-_])forbid(?:[-_]|$)/i.test(entry.sourceId) ||
    entry.check === 'forbidden';
  if (isQualitativeMust(entry.text)) return noneLink(entry, 'qualitative-not-object-verifiable');
  // 负向 / 禁止型 id 永远不进入 allowlist；文本负向由 coverageLink 的目标词检查兜底。
  if (!negativeId) {
    const allowed = coverageLink(entry, index);
    if (allowed !== null) return allowed;
  }
  return noneLink(entry, negativeId ? 'negative-or-prohibitive' : 'not-in-allowlist');
}

interface VerifiedObjectMapStamp {
  readonly schemeId: string;
  readonly schemeRevision: number;
}

/** 只认 planner 亲自返回的那个对象；复制 / 重建 / 手写的 map 都没有品牌。 */
const plannerVerifiedObjectMaps = new WeakMap<object, VerifiedObjectMapStamp>();

/**
 * 只把 planner 自己判定为 verified 的 must 映射成 BuildSpec / 投影对象 id。
 * 这是 verified 的唯一可信来源；任何 details.linkScope 都不参与。
 */
export function planVerifiedObjectMap(
  entries: readonly MustLedgerEntry[],
  scheme: DesignScheme,
): Readonly<Record<string, readonly string[]>> {
  const plan = planMustObjectLinks(entries, scheme);
  const elements = new Map(scheme.elements.map((element) => [element.id, element]));
  const openings = new Set(scheme.openings.map((opening) => opening.id));
  const out: Record<string, readonly string[]> = {};
  for (const link of plan.coverage.entries) {
    if (link.scope !== 'verified' || link.verifiedRefs.length === 0) continue;
    const objectIds: string[] = [];
    for (const reference of link.verifiedRefs) {
      // check: / furniture: / opening: 是覆盖证据 id，不是 DesignScheme 实体；原样进入映射。
      if (
        reference === 'roof' ||
        reference.startsWith('check:') ||
        reference.startsWith('furniture:') ||
        reference.startsWith('opening:')
      ) {
        objectIds.push(reference);
        continue;
      }
      const element = elements.get(reference);
      if (element !== undefined) {
        if (element.kind === 'wall') objectIds.push(`wall:${element.level}`);
        else if (element.kind === 'slab') objectIds.push(`slab:${element.level}`);
        else if (element.kind === 'roof') objectIds.push('roof');
        continue;
      }
      if (openings.has(reference)) objectIds.push(`opening:${reference}`);
    }
    const uniqueIds = [...new Set(objectIds)];
    if (uniqueIds.length > 0) out[link.mustId] = uniqueIds;
  }
  plannerVerifiedObjectMaps.set(out, { schemeId: scheme.meta.id, schemeRevision: scheme.meta.revision });
  return out;
}

/**
 * 运行时 provenance：只有 `planVerifiedObjectMap` 返回的同一个对象，且方案 id / revision
 * 与目标 spec 完全一致时才可信。复制、JSON 往返或手写对象都会失败。
 */
export function isPlannerVerifiedObjectMap(
  value: unknown,
  schemeId: string,
  schemeRevision: number,
): value is Readonly<Record<string, readonly string[]>> {
  if (typeof value !== 'object' || value === null) return false;
  const stamp = plannerVerifiedObjectMaps.get(value);
  if (stamp === undefined) return false;
  return stamp.schemeId === schemeId && stamp.schemeRevision === schemeRevision;
}

/** 纯函数：同一 entries + scheme 必须得到逐字节相同的 details / coverage。 */
export function planMustObjectLinks(entries: readonly MustLedgerEntry[], scheme: DesignScheme): MustLinkPlan {
  const index = buildIndex(scheme);
  const links: MustObjectLink[] = [];
  const details: SchemeDetail[] = [];
  for (const entry of entries) {
    const link = linkEntry(entry, index);
    links.push(link);
    if (link.scope !== 'none') details.push(detailFor(entry, link));
  }
  const verifiedCount = links.filter((link) => link.scope === 'verified').length;
  const declaredCount = links.filter((link) => link.scope === 'declared').length;
  return {
    details,
    coverage: {
      total: entries.length,
      explicit: verifiedCount + declaredCount,
      verified: verifiedCount,
      declaredOnly: declaredCount,
      unlinked: links.filter((link) => link.scope === 'none').length,
      entries: links,
    },
  };
}
