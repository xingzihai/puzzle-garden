/**
 * 交互 agent 的两阶段提示词：需求抽取与方案设计。
 *
 * 负责：把用户原话、已有需求图、澄清回答与能力卡摘要编译成固定的 system / user prompt；
 * 提炼需求图规则、设计深度、真实尺度、室内完整性与来源诚实要求。
 * 不负责：调用模型、解析结构、读写文件；本文件是纯函数，提示词长度保持可维护。
 *
 * 两阶段都只允许通过单个 submit 工具提交结构化结果；工具参数 schema 由 generate.ts 注入。
 */
import { DEFAULT_CAPABILITY_CARD } from './capability.ts';
import type { CapabilityCard } from './capability.ts';
import type { RequirementGraph } from './requirements.ts';
import type { DesignScheme, DesignSchemeCore, DesignSchemeEnvelope, SchemeScope } from './scheme.ts';

/** 需求抽取阶段的提交工具名。 */
export const REQUIREMENTS_TOOL_NAME = 'submit_requirements';
/** 方案设计阶段的提交工具名。 */
export const SCHEME_TOOL_NAME = 'submit_scheme';

/** 分阶段方案生成的提交工具名。 */
export const SCHEME_CORE_TOOL_NAME = 'submit_scheme_core';
export const SCHEME_ENVELOPE_TOOL_NAME = 'submit_scheme_envelope';
export const SCHEME_INTERIOR_TOOL_NAME = 'submit_scheme_interior';

export interface PromptPack {
  readonly system: string;
  readonly user: string;
}

/** 一轮澄清问答；questionId 只在会话状态机里使用，提示词只关心可读文本。 */
export interface ClarificationExchange {
  readonly question: string;
  readonly answer: string;
}

export interface RequirementsPromptInput {
  /** 用户原话或本轮的补充说明。 */
  readonly userText: string;
  /** 已有需求图；再次抽取时用于增量修订。 */
  readonly existingRequirements?: RequirementGraph;
  /** 能力卡摘要；缺省从 DEFAULT_CAPABILITY_CARD 生成。 */
  readonly capabilitySummary?: string;
  /** 已经问过并得到回答的问题，避免重复提问。 */
  readonly answers?: readonly ClarificationExchange[];
}

export interface DesignPromptOptions {
  /** 方案 id；缺省用 scheme-draft。 */
  readonly schemeId?: string;
  /** 方案 revision；缺省 1。 */
  readonly revision?: number;
  /** 交付范围；缺省完整室内。 */
  readonly scope?: SchemeScope;
  /** 方块预算上限；缺省从需求图约束读取。 */
  readonly maxBlocks?: number;
  /** 人民币预算上限；缺省从需求图约束读取，未知时写 null。 */
  readonly maxCostCny?: number | null;
  /** 已有澄清回答，作为设计输入。 */
  readonly answers?: readonly ClarificationExchange[];
  /** 能力卡摘要；缺省从 DEFAULT_CAPABILITY_CARD 生成。 */
  readonly capabilitySummary?: string;
  /** 上一版方案；给出时只做定向修订，不重新发散。 */
  readonly previousScheme?: DesignScheme;
  /** 用户对上一版方案的修改意见；给出时只改点名或受影响的部位。 */
  readonly feedback?: string;
}

function bulletOrNone(items: readonly string[], none: string): string {
  return items.length === 0 ? none : items.map((item) => `- ${item}`).join('\n');
}

const PLATFORM_LIKE_SPACE =
  /平台|露台|檐廊|连廊|廊架|外廊|柱廊|骑楼|门廊|庭院|院子|天井|铺装|灰空间|terrace|platform|deck|patio|courtyard|plaza|paving|porch|veranda/i;
const STAIR_LANDING_SPACE = /楼梯(?:间)?平台|梯段平台|landing/i;

/**
 * 需求空间名 / 用途是否描述无墙无顶的平台类空间；楼梯平台不是室外平台。
 * 不看 notes：主厅的 notes 可能描述“南侧带为檐下平台”，不能因此把主厅判成室外。
 */
export function isPlatformLikeSpace(
  space: Pick<RequirementGraph['spaces'][number], 'name' | 'purpose' | 'notes'>,
): boolean {
  const text = `${space.name} ${space.purpose}`;
  return PLATFORM_LIKE_SPACE.test(text) && !STAIR_LANDING_SPACE.test(text);
}

/**
 * 已有需求图把平台写进 spaces 时，在修订提示里给出定点分类校正。
 * 模型在 live 中曾用“按建筑构件处理”为理由把轮廓内檐下平台留在 spaces，这里明确反驳。
 */
function requirementsClassificationCorrection(graph: RequirementGraph | undefined): string {
  if (graph === undefined) return '';
  const suspects = graph.spaces.filter(isPlatformLikeSpace);
  const siteNotes = graph.site?.notes ?? '';
  const notesConflict =
    siteNotes !== '' &&
    /平台|露台|檐廊|terrace|platform|deck|porch|veranda/i.test(siteNotes) &&
    /不列为独立室外分区|按建筑构件|建筑构件处理|不是室外|非室外分区|不计入室外|不算室外/.test(siteNotes);
  if (suspects.length === 0 && !notesConflict) return '';

  const suspectLines =
    suspects.length === 0
      ? '- 需求图没有把平台列入 spaces，但 site.notes 仍按“建筑构件 / 非独立室外分区”描述平台；修订时要同步改正。'
      : `- 以下空间是无墙无顶的半室外 / 室外平台，不是室内房间：\n${suspects
          .map((space) => `  - ${space.id}（${space.name}）`)
          .join('\n')}`;
  return `
## 分类校正（必须处理）
${suspectLines}
- 把上述空间从 spaces 移除，写入 site.outdoorZones（kind=terrace / path / other）；平台即使位于建筑轮廓内、在檐下、与室内共边或被同一屋面覆盖，也按 outdoorZones 处理。
- 只有有墙、有顶、可封闭的空间才留在 spaces；不要用“按建筑构件处理”“不列为独立室外分区”作为保留在 spaces 的理由。
- 平台尺寸已知时按已知相对尺寸给 bounds；场地总尺寸未知不影响记录平台，不要因此省略或写零面积。
- site.notes 中与上述分类冲突的说明必须一并改正。
`;
}

/**
 * 把能力卡压缩成提示词可用的摘要：坐标、可用构件、分析口径与明确限制。
 * 只读卡里的字段，不在这里新增能力；unsupported 项始终保留，避免模型误承诺。
 */
export function summarizeCapabilityCard(card: CapabilityCard = DEFAULT_CAPABILITY_CARD): string {
  const components = card.world.components
    .map(
      (item) =>
        `- ${item.name}（${item.status}）：${item.detail}${item.limits.length === 0 ? '' : ` 限制：${item.limits.join('；')}`}`,
    )
    .join('\n');
  const limitations = card.limitations
    .map((item) => {
      const alternatives = item.alternatives.length === 0 ? '' : `；替代：${item.alternatives.join('；')}`;
      return `- ${item.name}（${item.status}）：${item.detail}${alternatives}`;
    })
    .join('\n');
  const renderLimits = card.render.limitations.map((item) => `- ${item}`).join('\n');
  const blockUsage = card.world.blockUsage
    .map(
      (usage) =>
        `- ${usage.name}（${usage.blocks.join('、')}）：${usage.how}；状态：${usage.states}；避免：${usage.mistakes}`,
    )
    .join('\n');
  return [
    `坐标：${card.coordinates.system}；地面 y=${String(card.coordinates.groundY)}，首层 y=${String(card.coordinates.firstFloorY)}。`,
    `渲染只有 ${card.render.views.join('、')}；没有人眼高度或室内视角。`,
    'World 构件：',
    components,
    '能力限制：',
    limitations,
    '渲染限制：',
    renderLimits,
    '方块组合用法（官方 1.20.1 资源目录）：',
    blockUsage,
    `默认室内范围：${card.scope.defaultInterior}`,
  ].join('\n');
}

const REQUIREMENTS_SYSTEM = `你是小型建筑设计团队的需求分析师，与主持建筑师协作。你的唯一任务是把用户输入整理成可追溯的 RequirementGraph，并只通过 submit_requirements 工具提交一次。

必须做到：
1. 逐条记录 must / should / could。每条写清 text、quote、source、kind、priority、status、confidence、affects、evidence。kind 只能取：function / space / site / dimension / aesthetic / constraint / capability / operation；affects 只能取：site / plan / section / facade / roof / structure / circulation / interior / material / budget / experience / scope。
2. quote 只在用户确实说过时逐字保留；代理推断写 null。evidence 写依据（如“用户原话第 1 段”“用户回答第 2 条”），不能编造原话或证据。
3. 来源分层：user=用户明确说出或确认；agent=你的推断或建议；default=通用默认。代理建议不得标成 confirmed，除非用户已经明确同意。用户拒绝的写 rejected。
4. 找歧义、矛盾、缺失和能力限制。只把会改变布局、功能、体量、风格或可行性的事项放进 ambiguities / conflicts / missing / capabilities；能安全默认的给 suggestedDefault 并标 assumed，不要求用户逐格设计。
5. 一次最多提出 3 个高影响问题（open 状态的 ambiguities 与 missing 合计最多 3 个）；简单需求允许 0 个。不要重复已有澄清回答里已经解决的问题。
6. 能力卡标 unsupported 的不得承诺；写进 capabilities 并给替代或未决说明。partial 的能力要写明限制。不要承诺实体物件、动态电梯、完整地下展示，或没有人眼视角的室内验收。
7. 已有需求图：沿用原 id，保留未被推翻的条目，revision = 旧 revision + 1；首次抽取 revision=1，id 用稳定 slug（如 req-tea）。需求 id、空间 id 和各类条目 id 在各自集合内必须唯一。
8. 输出完整集合：requirements、spaces、constraints、preferences、ambiguities、conflicts、missing、capabilities、decisions 都要给数组；site 未知时也要给对象并把未知数字写 null。notes / evidence / quote 没有内容时写 null，不要省略字段。
9. decisions 只能写 source=user / agent / default，status=proposed / confirmed / rejected；不要把代理决定冒充用户确认。
10. decisions[].requirementIds 可以引用同一图中已有的 requirements（req-*）、constraints（con-*）或 capabilities（cap-*）id，但不得引用不存在的 id，也不要把 spaces 的 sp-* 写进 decisions；ambiguities / conflicts / capabilities 的 requirementIds 仍只引用 requirements。
11. site.outdoorZones 记录所有无墙无顶、可停留或通行的室外 / 半室外地面（檐下平台、檐廊、露台、庭院、入口铺装等）；确实没有这类区域时才写空数组 []，禁止用零面积 bounds 占位。所有 bounds 都是半开区间 [min, max)，每轴 max 必须严格大于 min；场地总尺寸未知时仍按已知相对轮廓记录平台尺寸，尺寸也未知时给正的临时 bounds 并在 notes 标明假设，不要省略。
12. 空间分类只看围护，不按“是否独立用地 / 独立结构 / 建筑构件”判断：有墙、有顶、可封闭的才写进 spaces；无墙或无顶的檐下平台、檐廊、露台、庭院、入口铺装必须写进 site.outdoorZones，不要写进 spaces。平台即使位于建筑轮廓内、上方有檐、与室内共边或被同一屋面覆盖，也归 outdoorZones，并在 notes 说明；禁止用“按建筑构件处理，不列为独立室外分区”作为留在 spaces 的理由。`;

export function requirementsPrompt(input: RequirementsPromptInput): PromptPack {
  const existing =
    input.existingRequirements === undefined
      ? '无（首次抽取，revision=1）。'
      : ['```json', JSON.stringify(input.existingRequirements, null, 2), '```'].join('\n');
  const answers = bulletOrNone(
    (input.answers ?? []).map((exchange) => `问：${exchange.question} 答：${exchange.answer}`),
    '无。',
  );
  const capabilitySummary = input.capabilitySummary ?? summarizeCapabilityCard();
  const classification = requirementsClassificationCorrection(input.existingRequirements);
  const user = `## 用户原话 / 本轮补充
${input.userText.trim()}

## 已有澄清回答
${answers}

## 已有需求图
${existing}
${classification}
## 能力卡摘要
${capabilitySummary}

## 提交要求
- 只调用一次 ${REQUIREMENTS_TOOL_NAME}，参数必须是通过 schema 的完整 RequirementGraph。
- 不确定的数字写 null；不要把推测写成用户原话，也不要把代理建议写成 confirmed。
- 最多保留 3 个真正会改变方案的 open 问题；其余用 suggestedDefault / assumed 处理。
- site.outdoorZones 记录无墙无顶的平台 / 露台 / 檐廊 / 庭院 / 入口铺装；确实没有这类区域才写 []，不要用零面积 bounds 占位。
- 每条 requirement 的 kind / affects 必须使用提示中列出的枚举值，不要自创。
- decisions 的 requirementIds 只能引用本图已存在的 req-* / con-* / cap-* id。`;
  return { system: REQUIREMENTS_SYSTEM, user };
}

const DESIGN_ROLE = '你是主持小型建筑方案的专业建筑师。方案会编译成用户版设计报告与构建简报，是构建层唯一的设计依据。';

const DESIGN_RANGE =
  '设计范围：1–3 层、占地约 8–30 m、最高点不超过 15 m、5k–30k 实心方块；超出范围要说明理由，不得把小屋默认放大成巨构。';

const DESIGN_OUTPUT_RULE =
  '完整方案必须包含以下 17 个顶层字段：meta / site / levels / spaces / elements / openings / circulation / structure / roof / facades / materials / details / interiors / decisions / open / budget / forbidden。单次完整提交时缺任何一个都会被 schema 拒绝；分阶段提交时只提交本阶段指定的字段，但字段内容必须完整，不要给概念或空壳；没有内容的集合写 []。';

const DESIGN_INTERIOR_RULE =
  '室内必须完整：每个 room 空间以及入口、柜台等可停留空间都要有 included=true 的 interior 条目；levels / elements 表达楼层与地面，furnitureSpecs 至少覆盖主要家具、固定家具与灯具；地面材质用 elements 与 materials 表达。不能只有家具名称列表，也不能把室内留给构建层自由发挥。';

const DESIGN_SCALE_RULE =
  '使用真实尺度：一格约一米；层高 3.2–4.0 m，主入口门宽至少 1.2 m，室内门 0.8–0.9 m，窗台 0.8–1.0 m，檐口挑出 0.6–2.0 m，栏杆 0.9–1.1 m。所有 bounds 使用半开区间 [min, max)，坐标为 x 向东、y 向上、z 向南；每轴 max 必须严格大于 min，墙、楼板、屋面与家具必须是正体积，不能写成零厚度平面。';

const DESIGN_RESTRAINT_RULE =
  '小体量要克制：重点做比例、开间、檐口、材质层次、门槛、家具与光线；不要用尖塔、堆装饰或放大体量制造精致。';

const DESIGN_BLOCK_STATE_RULE =
  '方向方块必须写完整状态，例如 oak_stairs[facing=east,half=bottom]、oak_slab[type=bottom]；材质 block 字段要能被构建层直接执行。';

const DESIGN_FURNITURE_RULE =
  '家具与细部优先引用能力卡里的“方块组合用法”：活板门做柜门、楼梯做坡面 / 座椅、半砖做台面 / 窗台、栅栏 + 压力板做桌子、墙做栏杆、玻璃板做隔断、灯笼 + 链做吊灯；每条都要写清怎么放、状态与常见错误。';

const DESIGN_COVERAGE_RULE =
  '每个 must 需求都要有落点：在 decisions、details 或空间 / 构件中引用 requirementIds，并确保方案能核对。无法满足的 must 必须转成 open 或决策中的限制，不得静默删除。details.elementIds 可以引用 element 或 opening id；窗台、门框、门槛优先引用对应 opening。';

const DESIGN_META_RULE = 'meta.sourceRequirements 必须精确引用输入需求图的 graphId 与 revision。';

const DESIGN_BUDGET_RULE =
  'budget 要遵守需求图中的预算约束；forbidden 要写入用户禁项与能力边界；能力卡 unsupported 的事项不得进入方案承诺，partial 的事项写清限制。';

const DESIGN_HONESTY_RULE =
  '来源诚实：decisions[].source=user 只用于用户明确确认的决定；代理建议写 agent，默认值写 default。不要在方案里伪造用户原话，也不要把代理建议标成 confirmed。';

const DESIGN_OPEN_RULE =
  '未决事项放 open：影响大的写 open，能默认的给 defaultAssumption 并标 assumed / deferred；设计决定不要授权给构建层，freeForBuilder 仅在真正允许施工层自行处理时写 true。';

const DESIGN_RULES = [
  DESIGN_OUTPUT_RULE,
  DESIGN_INTERIOR_RULE,
  DESIGN_SCALE_RULE,
  DESIGN_RESTRAINT_RULE,
  DESIGN_BLOCK_STATE_RULE,
  DESIGN_FURNITURE_RULE,
  DESIGN_COVERAGE_RULE,
  DESIGN_META_RULE,
  DESIGN_BUDGET_RULE,
  DESIGN_HONESTY_RULE,
  DESIGN_OPEN_RULE,
] as const;

function numbered(rules: readonly string[]): string {
  return rules.map((rule, index) => `${String(index + 1)}. ${rule}`).join('\n');
}

const DESIGN_SYSTEM = `${DESIGN_ROLE}任务是把 RequirementGraph 转成完整、可建造的 DesignScheme，并只通过 submit_scheme 工具提交一次。

${DESIGN_RANGE}

必须完整输出：
${numbered(DESIGN_RULES)}`;

export function designPrompt(requirements: RequirementGraph, options: DesignPromptOptions = {}): PromptPack {
  const previousScheme = options.previousScheme;
  const schemeId = options.schemeId ?? previousScheme?.meta.id ?? 'scheme-draft';
  const revision = options.revision ?? (previousScheme === undefined ? 1 : previousScheme.meta.revision + 1);
  const scope = options.scope ?? 'exterior+interior';
  const answers = bulletOrNone(
    (options.answers ?? []).map((exchange) => `问：${exchange.question} 答：${exchange.answer}`),
    '无。',
  );
  const budget =
    options.maxBlocks === undefined
      ? '需求图没有明确方块预算时，按小体量克制原则控制在 20k 以内；有预算约束时必须遵守。'
      : `方块预算上限 ${String(options.maxBlocks)}；目标值与估算值不得超过它。`;
  const cost =
    options.maxCostCny === undefined
      ? '人民币预算未知时写 null，不编造金额。'
      : options.maxCostCny === null
        ? '人民币预算未知，写 null。'
        : `人民币预算上限 ${String(options.maxCostCny)} 元。`;
  const capabilitySummary = options.capabilitySummary ?? summarizeCapabilityCard();
  const user = `## 需求图（唯一需求来源）
\`\`\`json
${JSON.stringify(requirements, null, 2)}
\`\`\`

## 本次生成参数
- 方案 id：${schemeId}
- revision：${String(revision)}
- 交付范围：${scope}
- ${budget}
- ${cost}
- 已有澄清回答：
${answers}

## 能力卡摘要
${capabilitySummary}

## 提交前自查
- 17 个顶层字段是否全部出现：meta / site / levels / spaces / elements / openings / circulation / structure / roof / facades / materials / details / interiors / decisions / open / budget / forbidden。
- 场地、楼层、空间、元素、门窗、交通、结构、屋面、立面、材质、细部、室内、家具 specs、决策、未决、预算、禁项是否齐全。
- 每个 room 是否有 included=true 的室内条目与 furnitureSpecs（家具、固定家具、灯具）。
- 所有空间 / 洞口 / 路线 / 家具 / 材质引用是否能解析；所有 must 是否有落点。
- meta.sourceRequirements 是否等于 ${requirements.id} v${String(requirements.revision)}。
- 只调用一次 ${SCHEME_TOOL_NAME}，参数必须是通过 schema 的完整 DesignScheme。`;

  const feedback = options.feedback?.trim() ?? '';
  if (previousScheme === undefined && feedback === '') return { system: DESIGN_SYSTEM, user };

  const previousBlock =
    previousScheme === undefined
      ? '无（在本次需求与反馈上直接细化，但仍按下面规则控制改动范围）。'
      : ['```json', JSON.stringify(previousScheme, null, 2), '```'].join('\n');
  const previousId = previousScheme?.meta.id ?? schemeId;
  const previousRevision = previousScheme?.meta.revision ?? revision - 1;
  const revisionSection = `## 修订任务（定向修改，不是重新设计）
上一版方案：
${previousBlock}

用户反馈：${feedback === '' ? '无明确文字反馈；沿用上一版方案，只按需求图补齐缺项。' : feedback}

必须做到：
- 方案 id 保持 ${previousId}；revision 必须从 ${String(previousRevision)} 递增到 ${String(revision)}，旧版本由会话层保留。
- 只修改用户点名或直接受影响的布局 / 空间 / 立面 / 室内 / 材质；未点名区域保持上一版原样，id、名称、bounds、材料引用、家具与 requirementIds 不要改。
- 保留上一版已确认的 decisions 与 requirement 引用；不要删除、改名或伪造已确认决定，也不要新增未要求的决定。
- 不重新发散成另一栋建筑，不重做未被点名的空间、体量、风格或结构体系。
- 反馈若与需求图或已确认决定冲突，把冲突写入 open 并说明，不要静默忽略。
- 除定向修改及其直接连带影响外，完整沿用上一版方案。`;
  return { system: DESIGN_SYSTEM, user: `${user}\n\n${revisionSection}` };
}

export type SchemeStage = 'core' | 'envelope' | 'interior';

export const SCHEME_STAGE_FIELDS: Readonly<Record<SchemeStage, readonly string[]>> = {
  core: ['meta', 'site', 'levels', 'spaces', 'budget', 'forbidden'],
  envelope: ['elements', 'openings', 'circulation', 'structure', 'roof', 'facades', 'materials'],
  interior: ['details', 'interiors', 'decisions', 'open'],
};

const SCHEME_STAGE_TOOL: Readonly<Record<SchemeStage, string>> = {
  core: SCHEME_CORE_TOOL_NAME,
  envelope: SCHEME_ENVELOPE_TOOL_NAME,
  interior: SCHEME_INTERIOR_TOOL_NAME,
};

const SCHEME_STAGE_RULES: Readonly<Record<SchemeStage, string>> = {
  core: `本阶段只提交 meta / site / levels / spaces / budget / forbidden。先固定方案 id、revision、场地、楼层、空间与预算；后续阶段会引用这里的 level / space id。site 与 spaces 的 bounds 必须是半开区间 [min, max)，每轴 max 严格大于 min，不能写零面积空间。
meta.sourceRequirements 必须等于需求图的 id 与 revision。`,
  envelope: `本阶段只提交 elements / openings / circulation / structure / roof / facades / materials。不得修改 core；所有 level / space / material 引用必须指向 core 中已存在的 id。elements / openings 的 bounds 必须每轴 max 严格大于 min，墙、楼板、屋面等实体必须是正体积，不能写成零厚度平面；洞口宿主必须是墙或楼板，且与宿主同层。`,
  interior: `本阶段只提交 details / interiors / decisions / open。不得修改 core / envelope；details 的 elementIds 可以引用已存在的 element 或 opening id，interiors 的 spaceId / furnitureSpecs 必须引用已存在的 space / material，decisions 的 requirementIds 必须引用已存在的需求 / 约束 / 能力项。每个 room 与可停留空间都要有 included=true 的 interior 条目，furnitureSpecs 至少覆盖主要家具、固定家具与灯具；家具 bounds 必须每轴 max 严格大于 min，并与所属空间有重叠（允许局部外挑，不能完全在外）。`,
};

/** 分阶段系统提示只包含本阶段相关规则，避免再次要求模型一次输出完整 17 字段。 */
function stageDesignSystem(stage: SchemeStage): string {
  const rules =
    stage === 'core'
      ? [DESIGN_SCALE_RULE, DESIGN_META_RULE, DESIGN_BUDGET_RULE, DESIGN_HONESTY_RULE]
      : stage === 'envelope'
        ? [DESIGN_SCALE_RULE, DESIGN_RESTRAINT_RULE, DESIGN_BLOCK_STATE_RULE, DESIGN_BUDGET_RULE]
        : [DESIGN_INTERIOR_RULE, DESIGN_FURNITURE_RULE, DESIGN_COVERAGE_RULE, DESIGN_HONESTY_RULE, DESIGN_OPEN_RULE];
  return `${DESIGN_ROLE}本次是分阶段方案生成：只完成 ${stage} 阶段的字段，不要输出完整 17 字段方案。

${DESIGN_RANGE}

本阶段设计规则：
${numbered(rules)}`;
}

export interface SchemeStagePromptInput {
  readonly requirements: RequirementGraph;
  readonly core?: DesignSchemeCore;
  readonly envelope?: DesignSchemeEnvelope;
}

/** 分阶段方案提示：每阶段只提交一部分顶层字段，合并后再做完整 DesignScheme 校验。 */
export function schemeStagePrompt(
  stage: SchemeStage,
  input: SchemeStagePromptInput,
  options: DesignPromptOptions = {},
): PromptPack {
  const schemeId = options.schemeId ?? options.previousScheme?.meta.id ?? 'scheme-draft';
  const revision =
    options.revision ?? (options.previousScheme === undefined ? 1 : options.previousScheme.meta.revision + 1);
  const answers = bulletOrNone(
    (options.answers ?? []).map((exchange) => `问：${exchange.question} 答：${exchange.answer}`),
    '无。',
  );
  const budget =
    options.maxBlocks === undefined
      ? '需求图没有明确方块预算时，按小体量克制原则控制在 20k 以内；有预算约束时必须遵守。'
      : `方块预算上限 ${String(options.maxBlocks)}；目标值与估算值不得超过它。`;
  const cost =
    options.maxCostCny === undefined
      ? '人民币预算未知时写 null，不编造金额。'
      : options.maxCostCny === null
        ? '人民币预算未知，写 null。'
        : `人民币预算上限 ${String(options.maxCostCny)} 元。`;
  const capabilitySummary = options.capabilitySummary ?? summarizeCapabilityCard();
  const previous = options.previousScheme === undefined ? '无。' : JSON.stringify(options.previousScheme, null, 2);
  const prior = [
    input.core === undefined ? null : `### 已生成的 core\n\`\`\`json\n${JSON.stringify(input.core, null, 2)}\n\`\`\``,
    input.envelope === undefined
      ? null
      : `### 已生成的 envelope\n\`\`\`json\n${JSON.stringify(input.envelope, null, 2)}\n\`\`\``,
  ]
    .filter((part) => part !== null)
    .join('\n\n');
  const system = `【分阶段生成 / ${stage}】只调用一次 ${SCHEME_STAGE_TOOL[stage]}；不要调用 submit_scheme，也不要提交完整 17 字段方案。
本阶段字段：${SCHEME_STAGE_FIELDS[stage].join(' / ')}。这些字段必须完整、可被后续阶段引用；不要用空对象占位。其他阶段字段由后续调用提交，宿主会按 core → envelope → interior 合并。

${stageDesignSystem(stage)}

【本阶段规则】${SCHEME_STAGE_RULES[stage]}`;
  const user = `## 需求图（唯一需求来源）
\`\`\`json
${JSON.stringify(input.requirements, null, 2)}
\`\`\`

## 本次生成参数
- 方案 id：${schemeId}
- revision：${String(revision)}
- ${budget}
- ${cost}
- 已有澄清回答：
${answers}

## 上一版方案（定向修订时保持未点名部分不变）
${previous}

${prior === '' ? '' : `## 已生成阶段（不得修改）\n${prior}\n\n`}## 能力卡摘要
${capabilitySummary}

## 本阶段提交
- 只调用一次 ${SCHEME_STAGE_TOOL[stage]}。
- 本阶段必需字段必须完整；没有真实内容的集合写 []，但不能用空数组掩盖本阶段应有的构件、结构、屋面或室内。
- 只提交本阶段字段，不要重复已生成阶段，也不要提前输出后续阶段；宿主会按 core → envelope → interior 合并。
- 所有 bounds 每轴 max 必须严格大于 min；实体构件与家具必须是正体积，不能写成零厚度平面。`;
  return { system, user };
}
