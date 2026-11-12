/* eslint-disable max-lines */
/**
 * DesignIntent 生成提示词：模型只写 12 个顶层字段，3D bounds / 面积 / counts / 宿主 id 由宿主派生。
 *
 * 负责：紧凑需求 brief + 完整字段契约 + 一个可验证的最小 DesignIntent 示例 → system / user prompt。
 * 不负责：调用模型、解析结构或展开；本文件是纯函数。
 */
import { z } from 'zod';

import { DesignIntentDraft } from './design-intent-draft.ts';
import type { DesignIntent } from './design-intent.ts';
import { buildMustLedger, MUST_LEDGER_CHECK_LABELS, type MustLedgerCheck } from './must-ledger.ts';
import { isPlatformLikeSpace } from './prompts.ts';
import type { ClarificationExchange } from './prompts.ts';
import type { RequirementGraph, RequirementSpace } from './requirements.ts';
import type { SchemeScope } from './scheme.ts';

export const INTENT_TOOL_NAME = 'submit_intent';
export const INTENT_NARRATIVE_TOOL_NAME = 'submit_narrative';

/** 与宿主解析同一份 DesignIntentDraft schema；content-json 模式注入 prompt。 */
export const INTENT_DRAFT_JSON_SCHEMA = (() => {
  const schema = z.toJSONSchema(DesignIntentDraft) as Record<string, unknown>;
  delete schema['$schema'];
  return schema;
})();
export const INTENT_DRAFT_SCHEMA_TEXT = JSON.stringify(INTENT_DRAFT_JSON_SCHEMA);
export const INTENT_DRAFT_SCHEMA_CHARS = INTENT_DRAFT_SCHEMA_TEXT.length;

export const INTENT_SCHEMA_SECTION = `## 完整 JSON Schema（DesignIntentDraft，宿主解析使用同一份）
字段名、必填、枚举与 additionalProperties 以这份 schema 为准；字段表或示例与 schema 冲突时，以 schema 为准。
\`\`\`json
${INTENT_DRAFT_SCHEMA_TEXT}
\`\`\``;

/** 模型可提交的 12 个顶层字段；与 DesignIntent strict schema 一致。 */
export const INTENT_FIELDS = [
  'meta',
  'site',
  'program',
  'envelope',
  'openings',
  'structure',
  'roof',
  'facades',
  'materials',
  'furniture',
  'decisions',
  'open',
] as const;

/** 提示词中的稳定分组顺序；只影响阅读顺序，不改变 must 的优先级。 */
const MUST_LEDGER_CHECK_ORDER: readonly MustLedgerCheck[] = [
  'geometry',
  'dimension',
  'opening',
  'furniture',
  'material',
  'budget',
  'accessibility',
  'unverified',
];

export interface IntentPromptOptions {
  readonly schemeId: string;
  readonly revision: number;
  readonly scope?: SchemeScope;
  readonly maxBlocks: number;
  readonly maxCostCny?: number | null;
  readonly answers?: readonly ClarificationExchange[];
  /** 旧接口保留；intent 提示已改为固定材质 palette，不再注入完整能力卡。 */
  readonly capabilitySummary?: string;
  readonly previousIntent?: DesignIntent;
  readonly feedback?: string;
  /** content-json：不调用工具，只在正文输出单个 JSON 对象。 */
  readonly outputFormat?: 'tool' | 'content-json';
  /** 上一阶段的设计叙事；只是 JSON 的上下文，不进入最终 intent。 */
  readonly narrative?: string;
}

/** 8–12 个可用材质；只是 palette，模型可按 brief 增删，但所有引用必须闭合。 */
export const INTENT_MATERIAL_PALETTE = [
  { id: 'm-stone', name: '石基座', block: 'stone_bricks', role: 'structure' },
  { id: 'm-wood', name: '暖木', block: 'oak_planks', role: 'structure' },
  { id: 'm-dark-wood', name: '深色木', block: 'dark_oak_planks', role: 'wall' },
  { id: 'm-plaster', name: '浅色墙面', block: 'smooth_sandstone', role: 'wall' },
  { id: 'm-roof', name: '深瓦', block: 'deepslate_tiles', role: 'roof' },
  { id: 'm-floor', name: '室内地面', block: 'polished_andesite', role: 'floor' },
  { id: 'm-trim', name: '木饰面', block: 'stripped_spruce_log', role: 'trim' },
  { id: 'm-glass', name: '玻璃', block: 'glass', role: 'glass' },
  { id: 'm-fabric', name: '织物', block: 'white_wool', role: 'furniture' },
  { id: 'm-light', name: '暖光', block: 'lantern', role: 'furniture' },
  { id: 'm-grass', name: '草地', block: 'grass_block', role: 'landscape' },
  { id: 'm-gravel', name: '砾石', block: 'gravel', role: 'landscape' },
] as const;

/** 完整最小示例；与提示词共用，测试直接解析它，避免示例和 schema 漂移。 */
export const INTENT_EXAMPLE = {
  meta: {
    title: '稻田小茶亭',
    concept: '南向稻田边的小茶亭，深檐下形成可停留的半室外平台。',
    scope: 'exterior+interior',
  },
  site: {
    bounds: { x: [0, 16], z: [0, 12] },
    orientation: 'south',
    entrance: { side: 'south', notes: null },
    outdoorZones: [
      {
        id: 'zone-terrace',
        name: '南侧檐下平台',
        kind: 'terrace',
        rect: { x: [3, 11], z: [9, 12] },
        materialId: 'm-stone',
        notes: null,
      },
    ],
    notes: null,
  },
  program: {
    levels: [{ id: 'f1', name: '地面层', height: 3, floorMaterialId: 'm-stone' }],
    rooms: [
      {
        id: 'tea',
        name: '主茶室',
        level: 'f1',
        kind: 'room',
        rect: { x: [3, 11], z: [3, 9] },
        occupancy: 6,
        adjacency: [],
        daylight: 'required',
        notes: null,
      },
    ],
  },
  envelope: {
    wallDefaults: { exteriorThickness: 1, interiorThickness: 1 },
    walls: [],
    stairs: [],
  },
  openings: [
    {
      id: 'op-entry',
      name: '南侧入口门',
      roomId: 'tea',
      side: 'south',
      kind: 'door',
      role: 'entrance',
      offset: 3,
      width: 2,
      height: 2,
      sill: 0,
      fill: '木框玻璃门',
      frameMaterial: 'm-wood',
    },
    {
      id: 'op-north-window',
      name: '北向长窗',
      roomId: 'tea',
      side: 'north',
      kind: 'window',
      role: 'interior',
      offset: 2,
      width: 4,
      height: 1,
      sill: 1,
      fill: '透明玻璃',
      frameMaterial: 'm-wood',
    },
  ],
  structure: {
    system: 'post-and-beam',
    materialId: 'm-wood',
    floorThickness: 1,
    cantilever: 0,
    notes: null,
  },
  roof: {
    form: 'gable',
    materialId: 'm-roof',
    pitchDegrees: 25,
    overhang: 1,
    ridgeAxis: 'x',
    drainage: '南北檐沟',
    skylights: [],
    notes: null,
  },
  facades: [
    {
      side: 'north',
      baseMaterialId: 'm-stone',
      bodyMaterialId: 'm-wood',
      topMaterialId: 'm-roof',
      bays: 3,
      windowWallRatio: null,
      notes: null,
    },
    {
      side: 'south',
      baseMaterialId: 'm-stone',
      bodyMaterialId: 'm-wood',
      topMaterialId: 'm-roof',
      bays: 3,
      windowWallRatio: null,
      notes: null,
    },
    {
      side: 'east',
      baseMaterialId: 'm-stone',
      bodyMaterialId: 'm-wood',
      topMaterialId: 'm-roof',
      bays: 2,
      windowWallRatio: null,
      notes: null,
    },
    {
      side: 'west',
      baseMaterialId: 'm-stone',
      bodyMaterialId: 'm-wood',
      topMaterialId: 'm-roof',
      bays: 2,
      windowWallRatio: null,
      notes: null,
    },
  ],
  materials: [
    { id: 'm-stone', name: '浅灰石', block: 'stone_bricks', role: 'structure', color: '#9a9a92', notes: null },
    { id: 'm-wood', name: '暖木', block: 'oak_planks', role: 'structure', color: '#b08a5a', notes: null },
    { id: 'm-roof', name: '深瓦', block: 'deepslate_tiles', role: 'roof', color: '#3f4145', notes: null },
    { id: 'm-light', name: '暖光', block: 'lantern', role: 'furniture', color: '#f4c77a', notes: null },
  ],
  furniture: [
    {
      id: 'f-table',
      name: '中央茶桌',
      kind: 'table',
      roomId: 'tea',
      anchor: { kind: 'center' },
      footprint: { x: 2, z: 1 },
      orientation: null,
      height: 1,
      materialId: 'm-wood',
      notes: null,
    },
    {
      id: 'f-bench',
      name: '北墙长凳',
      kind: 'bench',
      roomId: 'tea',
      anchor: { kind: 'wall', side: 'north', offset: 3 },
      footprint: { x: 3, z: 1 },
      orientation: 'south',
      height: 1,
      materialId: 'm-wood',
      notes: null,
    },
    {
      id: 'f-light',
      name: '东北角灯',
      kind: 'light',
      roomId: 'tea',
      anchor: { kind: 'corner', corner: 'ne' },
      footprint: { x: 1, z: 1 },
      orientation: null,
      height: 1,
      materialId: 'm-light',
      notes: null,
    },
    {
      id: 'f-terrace-bench',
      name: '平台长凳',
      kind: 'bench',
      roomId: 'zone-terrace',
      anchor: { kind: 'center' },
      footprint: { x: 2, z: 1 },
      orientation: 'south',
      height: 1,
      materialId: 'm-wood',
      notes: '平台家具挂 outdoorZone，不占用室内房间。',
    },
  ],
  decisions: [
    {
      id: 'dec-roof',
      topic: '屋面',
      choice: '双坡木屋面，脊线沿东西向。',
      rationale: '南向深檐框景稻田，同时形成可用的檐下平台。',
      source: 'agent',
      requirementIds: ['req-view'],
    },
  ],
  open: [],
} as const;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max = 180): string {
  const line = oneLine(text);
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function tableCell(text: string): string {
  return clip(text, 60).replaceAll('|', '/');
}

function sideFromText(text: string | null): string | null {
  if (text === null) return null;
  for (const [pattern, side] of [
    [/北|north/i, 'north'],
    [/南|south/i, 'south'],
    [/东|east/i, 'east'],
    [/西|west/i, 'west'],
  ] as const) {
    if (pattern.test(text)) return side;
  }
  return null;
}

function suggestedKind(space: RequirementSpace): 'room' | 'service' | 'circulation' {
  const text = `${space.name} ${space.purpose}`.toLowerCase();
  if (/楼梯|走廊|过道|门厅|前厅|circulation|corridor|stair|hallway/.test(text)) return 'circulation';
  if (
    /服务|储物|储藏|厨房|卫生|厕所|设备|备餐|柜台|机房|storage|service|kitchen|bath|toilet|utility|counter/.test(text)
  ) {
    return 'service';
  }
  return 'room';
}

function suggestedLevel(space: RequirementSpace): string {
  switch (space.levelHint) {
    case 'ground':
      return 'f1';
    case 'upper':
      return 'f2';
    case 'basement':
      return 'b1';
    case 'any':
      return 'any';
  }
}

function siteSection(requirements: RequirementGraph): string {
  const site = requirements.site;
  if (site === null) {
    return '## 场地\n- 未提供场地尺寸；按房间外包外扩 2–4 格给一个正矩形 site.bounds。';
  }
  const size =
    site.widthM === null || site.depthM === null
      ? '未提供'
      : `${String(site.widthM)} × ${String(site.depthM)} 格（x × z）`;
  const bounds =
    site.widthM === null || site.depthM === null
      ? '按房间外包外扩 2–4 格'
      : `建议 x[0,${String(site.widthM)}] z[0,${String(site.depthM)}]`;
  const entrance =
    site.entrance === null
      ? '未指定'
      : `${clip(site.entrance, 100)}${
          sideFromText(site.entrance) === null
            ? '（据入口方向判断 side）'
            : `（建议 entrance.side=${String(sideFromText(site.entrance))}）`
        }`;
  const setbacks =
    site.setbacksM === null
      ? '未提供'
      : `北 ${String(site.setbacksM.north)} / 东 ${String(site.setbacksM.east)} / 南 ${String(site.setbacksM.south)} / 西 ${String(site.setbacksM.west)} 格`;
  const zones =
    site.outdoorZones.length === 0
      ? '无'
      : site.outdoorZones
          .map(
            (zone) =>
              `${zone.id} ${clip(zone.name, 60)}/${zone.kind} rect x[${String(zone.bounds.min[0])},${String(
                zone.bounds.max[0],
              )}] z[${String(zone.bounds.min[2])},${String(zone.bounds.max[2])}]`,
          )
          .join('；');
  return `## 场地
- 尺寸：${size}；朝向：${site.orientation}；入口：${entrance}
- site.bounds：${bounds}
- 退界：${setbacks}；地形：${site.slope}
- 室外分区：${zones}
- 周边：${site.surroundings.length === 0 ? '未提供' : site.surroundings.map((item) => clip(item, 40)).join('、')}`;
}

function roomSection(requirements: RequirementGraph): string {
  if (requirements.spaces.length === 0) {
    return '## 需求空间\n- 未提供房间表；按用户声音、must 与场地自行定 1–3 个必要空间。';
  }
  const rows = requirements.spaces.map((space) => {
    const quantity = space.quantity > 1 ? ` ×${String(space.quantity)}` : '';
    return `| ${space.id} | ${tableCell(space.name)}${quantity} | ${suggestedKind(space)} | ${
      space.areaM2 === null ? '—' : String(space.areaM2)
    } | ${suggestedLevel(space)} | ${space.adjacency.length === 0 ? '—' : space.adjacency.join(', ')} | ${
      space.daylight
    } |`;
  });
  return `## 需求空间
| id | 名称 | 建议 kind | 目标面积 | 建议层 | 相邻 | 采光 |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
- 建议 kind / 层只是需求图的映射；最终 id、level 与 rect 由你按设计确定。
- adjacency 必须双向，并对应实际共边；目标面积是名义面积，不写 areaM2。`;
}

/**
 * 需求图把平台写进 spaces 时，brief 必须显式纠偏；只靠 system 规则不足以覆盖 live 中
 * “按建筑构件处理、不列为独立室外分区”的既有分类。
 */
function classificationCorrection(requirements: RequirementGraph): string {
  const suspects = requirements.spaces.filter(isPlatformLikeSpace);
  if (suspects.length === 0) return '';
  return `## 分类校正（需求图有误，必须覆盖）
- 以下需求空间是无墙无顶的半室外 / 室外区域，不是 program.rooms：${suspects
    .map((space) => `${space.id}（${space.name}）`)
    .join('、')}。
- 不要照抄成 room；把对应面积改写入 site.outdoorZones，并从 program.rooms 中排除。平台即使位于建筑轮廓内、在檐下、与室内共边或被同一屋面覆盖，也按 outdoorZone 处理。
- 平台家具 roomId 指向该 outdoorZone，anchor 只用 center / corner；不要给平台写 envelope.walls、openings 或 roof，室内通向平台的门窗仍写在相邻室内房间上。`;
}

function requirementSection(requirements: RequirementGraph): string {
  const ledger = buildMustLedger(requirements);
  const musts = ledger.entries.filter((entry) => entry.source === 'requirement');
  const constraints = ledger.entries.filter((entry) => entry.source === 'constraint');
  const budgets = constraints.filter((entry) => entry.kind === 'budget');
  const hard = constraints.filter((entry) => entry.kind !== 'budget');
  const forbidden = requirements.constraints.filter(
    (constraint) => constraint.kind === 'forbidden' && (constraint.hard || constraint.source === 'user'),
  );
  const preferences = requirements.preferences.filter((preference) => preference.status !== 'rejected');
  const capabilities = requirements.capabilities.filter((capability) => capability.status !== 'supported');
  const confirmed = requirements.decisions.filter((decision) => decision.status === 'confirmed');

  const lines = [
    `## 必须（${String(musts.length)} 条，全部全文；不得只按 id 推断）`,
    '以下每条都必须完整阅读并落实到 DesignIntent；分组只用于定位，不改变优先级。id 为需求图原始 id。',
  ];
  if (musts.length === 0) {
    lines.push('- must：无硬性 must，按用户声音与空间表设计。');
  } else {
    for (const check of MUST_LEDGER_CHECK_ORDER) {
      const group = musts.filter((entry) => entry.check === check);
      if (group.length === 0) continue;
      lines.push(`### ${MUST_LEDGER_CHECK_LABELS[check]}（${String(group.length)}）`);
      lines.push(...group.map((entry) => `- must [${entry.sourceId}]：${oneLine(entry.text)}`));
    }
  }
  lines.push(
    ...(forbidden.length === 0
      ? ['- forbidden：无。']
      : forbidden.map((item) => `- forbidden [${item.id}]：${oneLine(item.text)}`)),
  );
  lines.push(
    ...(budgets.length === 0
      ? ['- budget：未提供。']
      : budgets.map(
          (entry) =>
            `- budget [${entry.sourceId}]：${oneLine(entry.text)}${
              entry.value === null ? '' : `（${oneLine(entry.value)}）`
            }`,
        )),
  );
  if (hard.length > 0) {
    lines.push(...hard.map((entry) => `- 硬约束 [${entry.sourceId}]：${oneLine(entry.text)}`));
  }
  if (preferences.length > 0) {
    lines.push(...preferences.map((item) => `- 偏好 [${item.id}]：${oneLine(item.text)}（${item.strength}）`));
  }
  if (capabilities.length > 0) {
    lines.push(
      ...capabilities.map(
        (item) => `- 能力边界 [${item.id}]：${item.topic}（${item.status}）${clip(item.detail, 160)}`,
      ),
    );
  }
  if (confirmed.length > 0) {
    lines.push(...confirmed.map((item) => `- 已确认 [${item.id}]：${item.topic} → ${oneLine(item.choice)}`));
  }
  return lines.join('\n');
}

function referenceSection(requirements: RequirementGraph): string {
  const groups = [
    ['req', requirements.requirements.map((item) => item.id)],
    ['con', requirements.constraints.map((item) => item.id)],
    ['cap', requirements.capabilities.map((item) => item.id)],
  ] as const;
  const shown = groups.filter(([, ids]) => ids.length > 0).map(([label, ids]) => `${label}: ${ids.join(', ')}`);
  return `## 可引用 id（decisions.requirementIds）
${shown.length === 0 ? '无；decisions 的 requirementIds 写 []。' : `- ${shown.join('\n- ')}`}`;
}

function materialSection(): string {
  return `## 可用材质（8–12 个，可选用，也可补；引用必须闭合）
${INTENT_MATERIAL_PALETTE.map(
  (material) => `- ${material.id}：${material.name}，block=${material.block}，role=${material.role}`,
).join('\n')}`;
}

/**
 * 把完整 RequirementGraph 压成模型可用的紧凑 brief。
 * 完整数据仍留在宿主；这里只保留用户声音、硬约束、场地、空间表、材质与可引用 id。
 */
export function compactRequirementsForIntent(
  requirements: RequirementGraph,
  answers: readonly ClarificationExchange[] = [],
): string {
  const voices: string[] = [];
  for (const requirement of requirements.requirements) {
    if (requirement.quote === null || requirement.quote.trim() === '') continue;
    const line = `用户原话 [${requirement.id}]：「${clip(requirement.quote, 200)}」`;
    if (!voices.includes(line)) voices.push(line);
    if (voices.length >= 3) break;
  }
  if (voices.length < 3) {
    for (const exchange of answers) {
      const line = `确认回答：问「${clip(exchange.question, 100)}」答「${clip(exchange.answer, 200)}」`;
      if (!voices.includes(line)) voices.push(line);
      if (voices.length >= 3) break;
    }
  }
  if (voices.length === 0) voices.push(`需求摘要：${clip(requirements.summary, 300)}`);
  const classification = classificationCorrection(requirements);

  return `## 用户声音（1–3 句）
${voices.map((voice) => `- ${voice}`).join('\n')}

${requirementSection(requirements)}

${siteSection(requirements)}

${roomSection(requirements)}

${classification}${classification === '' ? '' : '\n'}
${materialSection()}

${referenceSection(requirements)}`;
}

export const INTENT_SYSTEM = `你是主持小型建筑方案的专业建筑师，只负责设计意图。宿主会注入方案 id、revision、状态、需求图版本、预算与禁项，并确定性展开为可构建方案与预览；你不写展开后的几何。

## 输出目标
- 唯一目标是 DesignIntent JSON 本体。tool 模式只调用一次 ${INTENT_TOOL_NAME}；content 模式不调用工具，正文只输出一个 JSON。不要输出解释、计划或其它对象。
- 顶层恰好 12 个字段，全部必填；空集合写 []，无内容的 notes 写 null。字段表之外的键会导致失败。

## 顶层 12 字段（required）
- meta：title、concept、scope（exterior | exterior+entry | exterior+interior）。
- site：bounds（Rect2）、orientation（north | east | south | west | unknown）、entrance（{ side, notes? }，side=north|east|south|west）、outdoorZones（[{ id, name, kind, rect, materialId, notes }]，kind=garden|terrace|path|parking|service|water|other）、notes。
- program：levels（[{ id, name, height(1..100), floorMaterialId, elevation? }]）、rooms（[{ id, name, level, kind(room|service|circulation), rect, occupancy(0..500), adjacency[], daylight(required|preferred|none), notes }]）。
- envelope：wallDefaults?（{ exteriorThickness?, interiorThickness? }）、walls（[{ roomId, side, kind(auto|exterior|interior|none), thickness?, materialId? }]）、stairs（[{ id, name, roomId, fromLevel, toLevel, start:{x,z}, direction, width, treads, materialId? }]）。
- openings：[]，元素 { id, name, roomId, side, kind(door|window|opening|gate), role(entrance|interior|service), offset, width, height, sill, fill, frameMaterial? }；roomId 只能指 program.rooms，不能指 outdoorZone。
- structure：{ system(load-bearing-walls|post-and-beam|frame|mixed), materialId, floorThickness?, cantilever?, notes }。
- roof：{ form(flat|gable|hip|shed), materialId, pitchDegrees?, overhang, ridgeAxis?(x|z), drainage, skylights[], notes }。
- facades：[]，元素 { side, baseMaterialId, bodyMaterialId, topMaterialId?, bays?, windowWallRatio?, notes }。
- materials：[]（至少 1 个），元素 { id, name, block, role(structure|wall|roof|floor|trim|furniture|landscape|glass), color?, notes }。
- furniture：[]，元素 { id, name, kind(table|chair|bench|counter|shelf|storage|bed|light|rug|appliance|other), roomId, anchor, footprint:{x,z}, orientation(Side|null), height?, materialId?, notes }。
- decisions：[]，元素 { id, topic, choice, rationale, source(user|agent|default), requirementIds[] }。
- open：[]，元素 { id, question, impact(layout|facade|interior|budget|other), owner(user|agent), defaultAssumption, freeForBuilder }。

## 坐标、矩形与设计规则
- Rect2 = {"x":[x0,x1],"z":[z0,z1]}，四个整数，x1>x0、z1>z0；x 向东、z 向南；y 不写，由楼层派生。
- 场地：site.bounds 包含所有房间与室外分区；房间 rect 是含墙外包；同层房间不重叠（贴边可以），室外分区不压任何房间；顶层房间并集必须是矩形。
- 空间分类只看围护：有墙、有顶、可封闭的室内空间才写 program.rooms；无墙或无顶的檐下平台、檐廊、露台、庭院、入口铺装一律写 site.outdoorZones。平台即使位于建筑轮廓内、上方有檐、与室内共边或被同一屋面覆盖，也仍然是 outdoorZone；不要以“建筑构件 / 灰空间 / 过渡区 / 在轮廓内”为理由写进 rooms。
- 需求 spaces 里的平台 / 露台 / 檐廊条目必须迁移到 site.outdoorZones，不能照抄成 room；platform 面积从 rooms 中排除，site.bounds 同时包含两者，分区 rect 不扣墙厚且不得与任何房间 rect 重叠。不要给平台写 envelope.walls、openings 或 roof；室内通向平台的门窗仍写在相邻室内房间上。
- 家具可以放在室外平台：roomId 指向对应 outdoorZone id；outdoorZone 没有墙，anchor 只能用 center 或 corner，不要用 wall；需求明确要平台停留 / 看景座位时，平台家具就放在 zone，不要因为平台没有墙而塞回室内房间。室内房间仍按原规则放必要固定家具和灯具。
- 房间尺度：外包短边至少 3 格；有门的墙净长至少门宽 + 2 格（两侧各留墙厚）。主入口门宽 2，因此入口房间至少 4×3 格外包；10 座主厅至少 6×5 格。小于 3×3 的服务 / 储物 / 入口空间不要单列房间，合并到主空间的柜体或固定家具。
- 面积口径：面积是净使用面积，外包尺寸扣墙厚后仍要满足目标面积；不要把 12×10 场地尺寸直接当成建筑尺寸。
- 楼层：height 3–4；elevation 通常省略，首层从 1 开始、逐层累加。当交付范围是 exterior+interior 且为多层时，每对相邻楼层写一部直跑楼梯；楼梯 start 在所属房间内，梯段放得下；单层 stairs=[]。
- adjacency：只引用同层真实房间，必须双向，且两房间有正长度共边。
- 墙：优先写 walls: []，由宿主按房间拓扑判断外墙 / 共享墙；只有需要覆盖时才写 roomId + side + kind。共享边不要写 exterior（写 auto 或 interior），exterior 只用于真正无相邻房间的外墙，不确定时写 auto；不写墙段、墙对象或 3D bounds。
- 洞口：恰有一个 role=entrance，且 side 与 site.entrance.side 一致。offset 从该侧起点量到近边（N/S 取 min x，E/W 取 min z）；0 ≤ offset 且 offset+width ≤ 该边长；门/院门 sill=0；sill+height ≤ 层高；同一墙段的洞口不重叠。
- furniture：roomId 可指房间或室外分区；anchor = {"kind":"center"} / {"kind":"wall","side":...,"offset":...} / {"kind":"corner","corner":"nw"|"ne"|"sw"|"se"}；wall 只对房间有效，室外分区只能用 center / corner。footprint 是全局 x/z 占地、正整数、不旋转；房间内家具必须放得进扣墙后的内矩形，室外分区不扣墙。交付范围为 exterior+interior 时，每个房间/服务空间放必要的固定家具和灯具；保持小体量，不堆装饰。
- materials：所有 materialId、frameMaterial、floorMaterialId 都必须能在 materials 中找到；block 用 MC 1.20.1 方块 id，楼梯/台阶/栏杆等形状方块写完整状态，如 oak_stairs[facing=east,half=bottom]；color 用 #rrggbb 或 null。
- roof：flat 的 pitchDegrees 省略或 0；gable/hip/shed 的 pitchDegrees 5..60；overhang 0..50；ridgeAxis 省略时用长轴。
- 尺度：一格约 1 m；1–3 层，占地约 8–30 m，最高点 ≤15 m；层高 3–4；主入口门宽 2 格，室内门 1 格，窗台 1 格，檐口挑出 1–2 格。优先比例、开间、檐口与材质层次，不用尖塔或堆装饰放大体量。
- decisions.requirementIds 只能引用 brief 给出的 req-* / con-* / cap-*；open 只写真正未决且会影响方案的问题。

## 不要写宿主字段
- 不写 meta.id、meta.revision、meta.status、meta.sourceRequirements；不写 budget、forbidden、3D bounds、面积数字、counts、elements、spaces。
- 不写 areaM2；宿主按 rect 派生名义面积。
- 房间、洞口、材质、家具、楼梯、决策、open 的局部 id 必须写，并在各自集合内唯一；它们不是宿主 id。
- notes 只写在上面列出的位置；不需要就写 null，不要新增字段表之外的 notes 或未知字段。

## 完整最小 DesignIntent JSON 示例（只示范字段形状与引用；按 brief 替换内容，示例 id 与 req-view 仅示意）
\`\`\`json
${JSON.stringify(INTENT_EXAMPLE, null, 2)}
\`\`\`
示例已覆盖 12 个顶层字段、levels/rooms、materials.role、openings.role、furniture.anchor 的三种 kind，以及 Rect2 与整数 footprint。`;

/** 设计叙事阶段：只做设计决策，不写 JSON、不写字段名；输出只作为下一阶段上下文。 */
export const INTENT_NARRATIVE_SYSTEM = `【设计叙事】你是主持小型建筑方案的专业建筑师。先用中文写一份简短设计叙事，作为下一步严格 JSON 序列化的上下文。

只写 8–15 行自然语言，每行一个设计决策，覆盖：场地与入口、体量与层数、房间与动线、结构与屋面、材料与立面、室内与家具、主要风险与取舍。
- 只调用一次 ${INTENT_NARRATIVE_TOOL_NAME}，把全文放进 narrative 参数；正文不要重复全文。
- 不要输出 DesignIntent JSON、Markdown 表格、坐标表、字段名或 id。
- 不要重复需求原文，不要写“我将提交 / 以下是方案”之类的过程说明。
- 信息不足时用合理默认，并在“风险与取舍”里说明。
- 这是叙事，不是最终提交；宿主不会把它当方案。`;

export function intentNarrativePrompt(
  requirements: RequirementGraph,
  options: IntentPromptOptions,
): { readonly system: string; readonly user: string } {
  const scope = options.scope ?? 'exterior+interior';
  const cost =
    options.maxCostCny === undefined || options.maxCostCny === null
      ? '未提供人民币上限。'
      : `人民币预算上限 ${String(options.maxCostCny)} 元。`;
  const brief = compactRequirementsForIntent(requirements, options.answers ?? []);
  const feedback = options.feedback?.trim() ?? '';
  const revision =
    options.previousIntent === undefined && feedback === ''
      ? ''
      : `\n\n## 修订语境\n${feedback === '' ? '沿用上一版，只按新 brief 补齐缺项。' : `用户反馈：${feedback}`}\n只说明本次要改的部位与连带影响，不要重新发散。`;
  return {
    system: INTENT_NARRATIVE_SYSTEM,
    user: `## 本次设计参数
- 方案 id：${options.schemeId}
- revision：${String(options.revision)}
- 交付范围：${scope}
- 方块预算上限：${String(options.maxBlocks)}
- ${cost}

${brief}${revision}

## 写作要求
写 8–15 行中文设计叙事。每行一个决策，不要 DesignIntent JSON、不要字段名、不要坐标表；最后一行写主要风险或取舍。只调用一次 ${INTENT_NARRATIVE_TOOL_NAME}，把全文放进 narrative 参数。`,
  };
}

export function intentPrompt(
  requirements: RequirementGraph,
  options: IntentPromptOptions,
): { readonly system: string; readonly user: string } {
  const scope = options.scope ?? 'exterior+interior';
  const outputFormat = options.outputFormat ?? 'tool';
  const brief = compactRequirementsForIntent(requirements, options.answers ?? []);
  const cost =
    options.maxCostCny === undefined || options.maxCostCny === null
      ? '未提供人民币上限。'
      : `人民币预算上限 ${String(options.maxCostCny)} 元。`;
  const outputRule =
    outputFormat === 'content-json'
      ? `## 输出方式（JSON-only content 模式）
- 不要调用任何工具；不要包含 type / response_format / tool_call / arguments 或解释文字。
- 只输出 DesignIntent JSON 本体；顶层恰好是 12 个字段。
- 字段名、必填与枚举以 system 末尾的完整 schema 为准。
- 可输出纯 JSON，或单个 \`\`\`json fence；不要输出多个 JSON，也不能截断。`
      : `## 输出方式（tool）
- 只调用一次 ${INTENT_TOOL_NAME}，参数必须是完整的 DesignIntent JSON；不要输出解释、计划或额外工具调用。
- 顶层恰好是 12 个字段；空集合写 []，无内容的 notes 写 null。`;
  const narrative = options.narrative?.trim() ?? '';
  const narrativeBlock = narrative === '' ? '' : `\n\n## 设计叙事（只作上下文，不进入 JSON）\n${narrative}`;
  const user = `## 本次生成参数（宿主上下文，不要写进 DesignIntent）
- 方案 id：${options.schemeId}
- revision：${String(options.revision)}
- 交付范围：${scope}；meta.scope 必须写这个值。
- 方块预算上限：${String(options.maxBlocks)}
- ${cost}
- 以上 schemeId / revision / 预算 / 禁项由宿主处理，不要写进 JSON。

${brief}${narrativeBlock}

${outputRule}`;
  const system = outputFormat === 'content-json' ? `${INTENT_SYSTEM}\n\n${INTENT_SCHEMA_SECTION}` : INTENT_SYSTEM;

  const previous = options.previousIntent;
  const feedback = options.feedback?.trim() ?? '';
  if (previous === undefined && feedback === '') return { system, user };

  const previousBlock =
    previous === undefined ? '无。' : ['```json', JSON.stringify(previous, null, 2), '```'].join('\n');
  const revisionSection = `## 修订任务（定向修改，不是重新设计）
上一版 DesignIntent：
${previousBlock}

用户反馈：${feedback === '' ? '无明确文字反馈；沿用上一版，只按 brief 补齐缺项。' : feedback}

必须做到：
- 保留上一版未点名区域的房间矩形、墙 / 洞口意图、家具 anchor 与 footprint、材质、结构与决策；不要重新发散。
- 只修改用户点名或直接受影响的部位；局部 id 保持稳定，不删除未点名的房间、洞口、家具或需求引用。
- 反馈若与 brief 或已确认决定冲突，写入 open 或决策说明，不要静默忽略。
- 除定向修改及其直接连带影响外，沿用上一版。`;

  return { system, user: `${user}\n\n${revisionSection}` };
}
