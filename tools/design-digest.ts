/**
 * design.md → 构建提示词用的确定性设计摘要（design digest）。
 *
 * 负责：从已确认 design.md 抽取概念 / 风格 / 场地 / 未决问题，从 BuildSpec 派生包络、层数、
 *   房间、洞口、屋面、材料、家具；按固定顺序渲染紧凑 markdown。
 *   v2 生产用 `musts:'reference'` 只引用 BuildSheet 的 must 全文，避免同一份 must 在首请求里出现两次。
 * 不负责：改 BuildSpec / BuildSheet、调用模型、读写会话、决定 prompt 版本；摘要不是第二套事实源。
 *
 * 确定性：不写时间戳，不随机排序；同一 design + BuildSpec 输出逐字节相同。
 * must 段默认全文只从 BuildSpec.musts 读取，不依赖 design.md 是否写了“必须项”。
 */

import {
  boundsSize,
  MATERIAL_ROLE_LABEL,
  ROOF_FORM_LABEL,
  selectEntranceOpening,
  type Bounds,
  type BuildOpening,
  type BuildSpec,
  type MaterialRole,
  type Side,
  type SchemeFurniture,
} from '@pg/interaction/schema';

/** 摘要默认上限；超限只压缩叙述，不压缩 must 与关键数字。 */
export const DESIGN_DIGEST_MAX_TOKENS = 4_000;

/** 家具座位换算与 BuildSheet / coverage 同口径：0.8m 一座，取长边。 */
const SEAT_PITCH_M = 0.8;

const SIDE_LABEL: Readonly<Record<Side, string>> = {
  north: '北',
  east: '东',
  south: '南',
  west: '西',
};

const MATERIAL_ROLE_ORDER: readonly MaterialRole[] = ['structure', 'wall', 'roof', 'floor', 'trim'];

interface Caps {
  readonly concept: number;
  readonly style: number;
  readonly styleChars: number;
  readonly site: number;
  readonly furnitureNote: number;
  readonly unresolved: number;
  readonly unresolvedChars: number;
  readonly structureNote: number;
  readonly roofNote: number;
}

/** 逐级压缩的叙述预算；第 0 级是正常摘要，后几级只在 token 超限时使用。 */
const CAPS: readonly [Caps, ...Caps[]] = [
  {
    concept: 90,
    style: 2,
    styleChars: 60,
    site: 60,
    furnitureNote: 0,
    unresolved: 1,
    unresolvedChars: 50,
    structureNote: 0,
    roofNote: 0,
  },
  {
    concept: 320,
    style: 2,
    styleChars: 70,
    site: 80,
    furnitureNote: 0,
    unresolved: 2,
    unresolvedChars: 80,
    structureNote: 0,
    roofNote: 50,
  },
  {
    concept: 240,
    style: 2,
    styleChars: 90,
    site: 0,
    furnitureNote: 0,
    unresolved: 2,
    unresolvedChars: 80,
    structureNote: 0,
    roofNote: 55,
  },
  {
    concept: 160,
    style: 1,
    styleChars: 80,
    site: 0,
    furnitureNote: 0,
    unresolved: 1,
    unresolvedChars: 70,
    structureNote: 0,
    roofNote: 40,
  },
  {
    concept: 120,
    style: 1,
    styleChars: 70,
    site: 0,
    furnitureNote: 0,
    unresolved: 0,
    unresolvedChars: 0,
    structureNote: 0,
    roofNote: 0,
  },
];

interface Section {
  readonly level: number;
  readonly title: string;
  readonly lines: readonly string[];
}

function splitSections(markdown: string): readonly Section[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const sections: Section[] = [];
  let current: { level: number; title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line.trim());
    if (heading !== null) {
      if (current !== null) sections.push({ ...current, lines: current.lines });
      current = {
        level: heading[1]?.length ?? 1,
        title: (heading[2] ?? '').trim(),
        lines: [],
      };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  if (current !== null) sections.push({ ...current, lines: current.lines });
  return sections;
}

function findSection(sections: readonly Section[], patterns: readonly RegExp[]): Section | undefined {
  for (const pattern of patterns) {
    const found = sections.find((section) => pattern.test(section.title));
    if (found !== undefined) return found;
  }
  return undefined;
}

function plainText(text: string): string {
  return text
    .replace(/^[-*]\s+/u, '')
    .replace(/\*\*/gu, '')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function stripCategoryTag(text: string): string {
  return text.replace(/^\s*\[[^\]]+\]\s*/u, '').trim();
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/gu, ' ').trim();
  if (max <= 0 || clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function bulletLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const match = /^\s*[-*]\s+(.*)$/u.exec(line);
    if (match !== null) {
      const text = plainText(match[1] ?? '');
      if (text !== '') out.push(text);
    }
  }
  return out;
}

/** 取第一段散文；若先遇到 bullet，则把它当短概念（去掉标签与粗体）。 */
function firstParagraph(lines: readonly string[]): string {
  const parts: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      if (parts.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/u.test(line)) {
      if (parts.length > 0) break;
      continue;
    }
    if (line.startsWith('|')) {
      if (parts.length > 0) break;
      continue;
    }
    if (/^[-*]\s+/u.test(line)) {
      if (parts.length === 0) {
        const text = plainText(line);
        if (text !== '') parts.push(text);
      }
      break;
    }
    const text = plainText(line.replace(/^>\s?/u, ''));
    if (text !== '') parts.push(text);
  }
  return parts.join(' ');
}

function metaValue(lines: readonly string[], key: string): string | null {
  const pattern = new RegExp(`^[-*]\\s*(?:\\*\\*)?${key}(?:\\*\\*)?[：:]\\s*(.+)$`, 'u');
  for (const line of lines) {
    const match = pattern.exec(line.trim());
    if (match !== null) {
      const text = plainText(match[1] ?? '');
      if (text !== '') return text;
    }
  }
  return null;
}

function conceptOf(sections: readonly Section[]): string {
  const h1 = sections.find((section) => section.level === 1);
  const meta = h1 === undefined ? null : metaValue(h1.lines, '概念');
  if (meta !== null) return meta;

  const conceptSection = findSection(sections, [/项目概念/u, /设计概念/u, /^概念$/u]);
  if (conceptSection !== undefined) {
    const paragraph = firstParagraph(conceptSection.lines);
    if (paragraph !== '') return paragraph;
  }

  if (h1 !== undefined) {
    const paragraph = firstParagraph(h1.lines);
    if (paragraph !== '') return paragraph;
  }
  return 'design.md 未给出概念段；按 BuildSheet 与 must 执行。';
}

function styleOf(sections: readonly Section[], caps: Caps): string[] {
  const preference = findSection(sections, [/偏好/u, /风格/u, /氛围/u]);
  let lines = preference === undefined ? [] : bulletLines(preference.lines).map((line) => stripCategoryTag(line));
  if (lines.length === 0) {
    const all = sections.flatMap((section) => section.lines);
    for (const line of all) {
      if (/^\s*[-*]\s*\[(?:style|atmosphere|material)\s*\//iu.test(line)) {
        const text = stripCategoryTag(plainText(line));
        if (text !== '') lines.push(text);
      }
    }
  }
  if (lines.length === 0) {
    const conceptSection = findSection(sections, [/项目概念/u, /设计概念/u, /^概念$/u]);
    lines = conceptSection === undefined ? [] : bulletLines(conceptSection.lines);
  }
  return [...new Set(lines)]
    .slice(0, caps.style)
    .map((line) => clip(line, caps.styleChars))
    .filter((line) => line !== '');
}

function siteNoteOf(sections: readonly Section[], caps: Caps): string | null {
  if (caps.site <= 0) return null;
  const site = findSection(sections, [/场地/u]);
  if (site === undefined) return null;
  const bullets = bulletLines(site.lines);
  const preferred =
    bullets.find((line) => /^场地说明[：:]/u.test(line)) ?? bullets.find((line) => /^场地[：:]/u.test(line));
  const text = preferred ?? bullets[0];
  if (text === undefined) return null;
  return clip(stripCategoryTag(text).replace(/^场地(?:说明)?[：:]\s*/u, ''), caps.site);
}

function unresolvedOf(sections: readonly Section[], caps: Caps): string[] {
  if (caps.unresolved <= 0) return [];
  const section = findSection(sections, [/未决问题/u, /待决问题/u, /冲突记录/u]);
  if (section === undefined) return [];
  return bulletLines(section.lines)
    .map((line) => clip(stripCategoryTag(line), caps.unresolvedChars))
    .slice(0, caps.unresolved);
}

function rangeOf(bounds: Bounds, planar: boolean): string {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const x = `x[${String(minX)},${String(maxX)})`;
  if (planar) return `${x} z[${String(minZ)},${String(maxZ)})`;
  return `${x} y[${String(minY)},${String(maxY)}) z[${String(minZ)},${String(maxZ)})`;
}

function spanOf(bounds: Bounds): string {
  const [x, y, z] = boundsSize(bounds);
  return `${String(x)}×${String(y)}×${String(z)}`;
}

function furnitureSpan(item: SchemeFurniture): string {
  const [minX, , minZ] = item.bounds.min;
  const [maxX, , maxZ] = item.bounds.max;
  return `${String(maxX - minX)}×${String(maxZ - minZ)}`;
}

function seatCapacity(item: SchemeFurniture): number | null {
  if (item.kind !== 'bench') return null;
  const [minX, , minZ] = item.bounds.min;
  const [maxX, , maxZ] = item.bounds.max;
  const span = Math.max(maxX - minX, maxZ - minZ);
  return Math.max(0, Math.floor(span / SEAT_PITCH_M));
}

function materialName(spec: BuildSpec, id: string): string {
  const material = spec.materials.find((item) => item.id === id);
  return material === undefined ? id : `${material.name} ${material.block}`;
}

function openingLabel(opening: BuildOpening): string {
  return `${opening.name}（${opening.kind}，${SIDE_LABEL[opening.side]}，${String(opening.width)}×${String(opening.height)}，sill ${String(opening.sillHeight)} / head ${String(opening.headHeight)}）`;
}

function roofLine(spec: BuildSpec, caps: Caps): string {
  const roof = spec.roof;
  const head = `${ROOF_FORM_LABEL[roof.form]}（${roof.form}），${String(roof.pitchDegrees)}°，檐口 ${String(roof.eaveHeight)} / 屋脊 ${String(roof.ridgeHeight)} / 挑檐 ${String(roof.overhang)} 格；${materialName(spec, roof.material)}`;
  const note = caps.roofNote <= 0 ? '' : clip(roof.notes ?? '', caps.roofNote);
  return note === '' ? head : `${head}。说明：${note}`;
}

function materialsLine(spec: BuildSpec): string {
  if (spec.materials.length === 0) return 'BuildSpec materials 为空。';
  const groups: string[] = [];
  for (const role of MATERIAL_ROLE_ORDER) {
    const materials = spec.materials.filter((material) => material.role === role);
    if (materials.length === 0) continue;
    const names = materials.map((material) => material.block).join('、');
    groups.push(`${MATERIAL_ROLE_LABEL[role]} ${names}`);
  }
  return groups.join('；');
}

function renderDigest(design: string, spec: BuildSpec, caps: Caps, musts: 'full' | 'reference'): string {
  const sections = splitSections(design);
  const concept = clip(conceptOf(sections), caps.concept);
  const style = styleOf(sections, caps);
  const siteNote = siteNoteOf(sections, caps);
  const unresolved = unresolvedOf(sections, caps);
  const entrance = selectEntranceOpening(spec);
  const entranceSide = spec.entranceSide ?? entrance?.side ?? null;

  const lines: string[] = [];
  lines.push(`# 设计摘要：${spec.title}`);
  lines.push('意图 / 风格来自 design.md；数字与 must 全文来自 BuildSpec；非第二事实源。', '');

  lines.push('## 1. 概念 / 风格');
  lines.push(`- 概念：${concept}`);
  lines.push(
    style.length === 0
      ? '- 风格 / 氛围：design.md 未单列；按 BuildSpec 材料与 must 执行。'
      : `- 风格 / 氛围：${style.join('；')}`,
  );
  lines.push('', '## 2. 场地与朝向');
  lines.push(
    `- 场地 ${rangeOf(spec.siteBounds, false)}；建筑 ${rangeOf(spec.bounds, false)}；入口朝 ${entranceSide === null ? '未指定' : SIDE_LABEL[entranceSide]}。`,
  );
  if (siteNote !== null) lines.push(`- 场地说明：${siteNote}`);

  lines.push('', '## 3. 包络 / 层数 / 尺寸');
  const [minX, , minZ] = spec.bounds.min;
  const [maxX, , maxZ] = spec.bounds.max;
  lines.push(
    `- 包络 ${spanOf(spec.bounds)} 格；占地 ${String(maxX - minX)}×${String(maxZ - minZ)}m；${String(spec.levels.length)} 层。`,
  );
  for (const level of spec.levels) {
    lines.push(`- ${level.id} ${level.name}：elevation ${String(level.elevation)}，height ${String(level.height)}。`);
  }

  lines.push('', '## 4. 房间 / 功能');
  if (spec.spaces.length === 0) {
    lines.push('- BuildSpec spaces 为空。');
  } else {
    for (const space of spec.spaces) {
      const connections = space.connections.length === 0 ? '' : `；连通 ${space.connections.join('、')}`;
      lines.push(
        `- ${space.name}（${space.id}，${space.kind}，${space.level}，${String(space.areaM2)}㎡）：${rangeOf(space.bounds, true)}${connections}。`,
      );
    }
  }

  lines.push('', '## 5. 入口与洞口');
  if (entrance !== undefined) {
    lines.push(`- 主入口：${openingLabel(entrance)}`);
  } else {
    lines.push('- 主入口：BuildSpec 未给出非窗洞口。');
  }
  for (const opening of spec.openings) {
    if (opening.id === entrance?.id) continue;
    lines.push(`- ${opening.id}：${openingLabel(opening)}`);
  }

  lines.push('', '## 6. 屋面');
  lines.push(`- ${roofLine(spec, caps)}`);

  lines.push('', '## 7. 材料 / 构造');
  lines.push(
    `- 结构：${spec.structure.system}，${spec.structure.material}，跨度 ${String(spec.structure.spanX)}×${String(spec.structure.spanZ)}。`,
  );
  const structureNote = caps.structureNote <= 0 ? '' : clip(spec.structure.notes ?? '', caps.structureNote);
  if (structureNote !== '') lines.push(`- 构造：${structureNote}`);
  lines.push(`- 材质：${materialsLine(spec)}`);

  const furniture = spec.interiors.flatMap((interior) => interior.furnitureSpecs);
  const seatTotal = furniture.reduce((total, item) => total + (seatCapacity(item) ?? 0), 0);
  const kindCounts = new Map<string, number>();
  for (const item of furniture) kindCounts.set(item.kind, (kindCounts.get(item.kind) ?? 0) + 1);
  const kindSummary = [...kindCounts.entries()].map(([kind, count]) => `${kind} ${String(count)}`).join('、');
  const benchSummary = seatTotal === 0 ? '' : `；长凳 ${String(seatTotal)} 座`;
  lines.push('', '## 8. 家具');
  lines.push(
    furniture.length === 0
      ? '- BuildSpec interiors 未列 furnitureSpecs。'
      : `- 共 ${String(furniture.length)} 件（${kindSummary}）${benchSummary}。`,
  );
  for (const item of furniture) {
    const orientation = item.orientation === null ? '' : `，朝 ${SIDE_LABEL[item.orientation]}`;
    const note = caps.furnitureNote <= 0 ? '' : clip(item.notes ?? '', caps.furnitureNote);
    const suffix = note === '' ? '' : `：${note}`;
    lines.push(`- ${item.name}：${furnitureSpan(item)}，${rangeOf(item.bounds, true)}${orientation}${suffix}`);
  }

  if (musts === 'full') {
    lines.push('', `## 9. Must 全文（${String(spec.musts.length)}）`);
    for (const must of spec.musts) {
      lines.push(`- ${must.id}：${clip(must.text, 0)}`);
    }
  } else {
    // 首请求里 BuildSheet 已带 must 全文；这里只留引用，避免同一合同重复约 1.2k token。
    lines.push('', `## 9. Must 摘要（${String(spec.musts.length)}）`);
    lines.push('- 全文、对象链接与 verified 状态见 BuildSheet 的「Musts」段（机器合同）；本摘要不重复。');
    lines.push('- 未决 must 冲突见 §10 与 BuildSheet 的冲突段；施工期数字冲突以 BuildSheet 为准。');
  }

  lines.push('', '## 10. 冲突 / 未决');
  if (unresolved.length === 0) {
    lines.push('- design.md 未记录未决问题。');
  } else {
    for (const item of unresolved) lines.push(`- ${item}`);
  }
  lines.push('- 运行期数字 / 对象冲突以 BuildSheet 为准并记录；意图冲突报告，不静默改。');

  return `${lines.join('\n')}\n`;
}

function approximateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 3);
}

export interface DesignDigestOptions {
  /** 注入项目 tokenizer 时按真实 token 压缩；缺省按 UTF-8 字节 / 3 粗估。 */
  readonly countTokens?: (text: string) => number;
  readonly maxTokens?: number;
  /**
   * must 段形态：默认 `full` 保留全文（独立使用 / 无 BuildSheet 的调用方）；
   * v2 生产传 `reference`，因为首请求已有 BuildSheet 的 must 全文。
   */
  readonly musts?: 'full' | 'reference';
}

/**
 * 纯函数：design.md + BuildSpec → 固定结构 markdown。
 * 若注入 `countTokens`，超过 `maxTokens` 时按 {@link CAPS} 逐级压缩叙述；
 * must 全文、包络、洞口、屋面、家具尺寸永远不裁。
 */
export function buildDesignDigest(design: string, spec: BuildSpec, options: DesignDigestOptions = {}): string {
  const count = options.countTokens ?? approximateTokens;
  const maxTokens = options.maxTokens ?? DESIGN_DIGEST_MAX_TOKENS;
  const musts = options.musts ?? 'full';
  let text = renderDigest(design, spec, CAPS[0], musts);
  for (const caps of CAPS.slice(1)) {
    if (count(text) <= maxTokens) break;
    text = renderDigest(design, spec, caps, musts);
  }
  return text;
}
