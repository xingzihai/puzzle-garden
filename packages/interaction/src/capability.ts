/**
 * 能力卡：交互层在方案阶段能承诺什么、不能承诺什么的版本化清单。
 *
 * 负责：静态常量 + zod schema，覆盖 World 构件、方块状态、坐标范围、七视角渲染、分析口径与限制。
 * 不负责：解析 world.d.ts / schema.ts / camera.ts（后续可做生成脚本）、方案检查或任何 I/O。
 *
 * 维护规则：能力变化时同时改这里的版本号与条目；交互层不得在对话 / 报告里承诺 status=unsupported 的项。
 */
import { XZ_MAX, XZ_MIN, Y_MAX, Y_MIN } from '@pg/core/coord';
import { BLOCK_USAGES } from '@pg/blocks/block-usages';
import { z } from 'zod';

import { Identifier, Label, Text } from './primitives.ts';
import { SchemeScope } from './scheme.ts';

export const CAPABILITY_CARD_VERSION = '2026-10-19.3';

export const CapabilityStatus = z.enum(['supported', 'partial', 'unsupported']);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

export const CapabilityItem = z
  .strictObject({
    id: Identifier,
    name: Label,
    status: CapabilityStatus,
    detail: Text,
    limits: z.array(Text).max(20).readonly(),
    alternatives: z.array(Text).max(20).readonly(),
  })
  .readonly();
export type CapabilityItem = z.infer<typeof CapabilityItem>;

/** 与 @pg/render 的 ViewName、@pg/agent/tools/schemas 的 VIEW_NAMES 同集合。 */
export const CapabilityView = z.enum(['south', 'east', 'north', 'west', 'top', 'iso-se', 'iso-nw']);
export type CapabilityView = z.infer<typeof CapabilityView>;

export const CapabilityCoordinates = z
  .strictObject({
    system: z.literal('x-east-y-up-z-south'),
    groundY: z.literal(0),
    firstFloorY: z.literal(1),
    xz: z.tuple([z.int(), z.int()]).readonly(),
    y: z.tuple([z.int(), z.int()]).readonly(),
    renderSkip: Text,
  })
  .readonly();
export type CapabilityCoordinates = z.infer<typeof CapabilityCoordinates>;

export const CapabilityBlockStates = z
  .strictObject({
    syntax: Text,
    properties: Text,
    shapes: Text,
    unsupported: z.array(Text).max(20).readonly(),
  })
  .readonly();
export type CapabilityBlockStates = z.infer<typeof CapabilityBlockStates>;

/** 官方资源目录里的一条组合用法；交互层设计提示直接引用。 */
export const CapabilityBlockUsage = z
  .strictObject({
    id: Identifier,
    name: Label,
    blocks: z.array(Text).min(1).max(20).readonly(),
    how: Text,
    states: Text,
    mistakes: Text,
  })
  .readonly();
export type CapabilityBlockUsage = z.infer<typeof CapabilityBlockUsage>;

export const CapabilityWorld = z
  .strictObject({
    components: z.array(CapabilityItem).min(1).max(100).readonly(),
    blockStates: CapabilityBlockStates,
    /** 官方 1.20.1 blockstates / models / tags + 人工整理的组合用法。 */
    blockUsage: z.array(CapabilityBlockUsage).min(1).max(50).readonly(),
    writeLayers: z
      .array(z.enum(['opening', 'structure', 'decoration']))
      .min(1)
      .max(3)
      .readonly(),
  })
  .readonly();
export type CapabilityWorld = z.infer<typeof CapabilityWorld>;

export const CapabilityRender = z
  .strictObject({
    views: z.array(CapabilityView).min(1).max(7).readonly(),
    limitations: z.array(Text).max(20).readonly(),
  })
  .readonly();
export type CapabilityRender = z.infer<typeof CapabilityRender>;

export const CapabilityScope = z
  .strictObject({
    defaultBuildScope: SchemeScope,
    defaultInterior: Text,
    note: Text,
  })
  .readonly();
export type CapabilityScope = z.infer<typeof CapabilityScope>;

export const CapabilityCard = z
  .strictObject({
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/, '能力卡版本形如 2026-10-19.1'),
    generatedFrom: z.array(Label).min(1).max(20).readonly(),
    coordinates: CapabilityCoordinates,
    world: CapabilityWorld,
    render: CapabilityRender,
    analysis: z.array(CapabilityItem).max(50).readonly(),
    limitations: z.array(CapabilityItem).max(50).readonly(),
    scope: CapabilityScope,
  })
  .readonly();
export type CapabilityCard = z.infer<typeof CapabilityCard>;

function item(
  id: string,
  name: string,
  status: CapabilityStatus,
  detail: string,
  limits: readonly string[],
  alternatives: readonly string[] = [],
): CapabilityItem {
  return CapabilityItem.parse({ id, name, status, detail, limits, alternatives });
}

const COMPONENTS: readonly CapabilityItem[] = [
  item('direct-write', '直接写格', 'supported', 'World.set / World.box 可按坐标直接写方块，适合局部修补与铺装图案。', [
    '同格后写覆盖，结果与调用顺序相关；结构性构件优先用专用构件。',
  ]),
  item('plinth', '台基', 'supported', '沿轮廓外挑，顶部可承托外墙。', ['外挑与高度为整数格。']),
  item('walls', '外墙', 'supported', '按外轮廓写墙厚，内部留空，支持材质分段与 rect / apse 轮廓。', ['墙厚为整数格。']),
  item('opening', '门窗洞口', 'supported', '在墙立面上开洞，可配台阶 / 雨棚。', [
    '洞口必须落在同一次 walls 调用的立面上。',
  ]),
  item('floor-plate', '楼板', 'supported', '可扣矩形洞，适合挑空与楼梯井。', ['洞与板均为轴对齐矩形。']),
  item('stair', '楼梯', 'supported', '连接两个承托面，生成连续踏步。', ['踏步高宽由构件参数决定，复杂转折需拆段。']),
  item('steps', '台阶', 'supported', '连接洞口或立面与场地。', []),
  item('roof', '屋面', 'supported', '平屋面与坡屋面，含檐口、屋脊与平顶承托面。', ['坡屋面不能直接承托第二栋。']),
  item('colonnade', '柱廊', 'supported', '按开间生成柱列，可承托屋面。', ['柱距为整数格。']),
  item('rail', '栏杆', 'supported', '沿承托面边缘或指定路径布置。', ['只作安全 / 形式构件，不等同结构计算。']),
  item('enclosure', '院墙 / 院门', 'supported', '围合院子并留门洞，可带门房。', ['院墙不是第二栋主体建筑。']),
  item('paving', '铺装', 'supported', '区域铺装或从入口到目标的路径。', ['路径只保证铺装，不保证逐格可达。']),
  item('massing-import', '草模导入', 'supported', '把已确认的参数化草模并进体素世界。', [
    '需要在构建前准备 massing#N 引用；交互层首版不自动生成。',
  ]),
  item('surface-shell', '参数化壳', 'partial', '可用公式或旋转母线生成自由曲面壳。', [
    '壳体厚度、内部空腔与精确外形需要额外检查；不承诺精细室内。',
  ]),
];

const ANALYSIS: readonly CapabilityItem[] = [
  item('reach', '可达分析', 'supported', '从场地外地面测站立点、楼板与平屋面目标，报告到不了的目标。', [
    '按方块通行规则近似，不是建筑规范审查。',
  ]),
  item('floating', '悬空分析', 'supported', '从 y ≤ 1 的方块出发测共面连通，区分只靠棱 / 角相连。', [
    '只报连通事实，不判断结构合理性。',
  ]),
  item('symmetry', '对称分析', 'supported', '按指定轴测量实体格匹配比例。', ['只作事实，不要求建筑必须对称。']),
  item('structure-spans', '结构跨度', 'partial', '统计结构类构件的 x / z 跨度并可按门槛判定。', [
    '跨度是格数，不是材料力学计算；不能替代结构工程师。',
  ]),
  item('roof-profile', '屋面轮廓', 'supported', '按 roof 调用统计格数与列厚。', ['不判断防水、排水坡度是否合理。']),
];

const LIMITATIONS: readonly CapabilityItem[] = [
  item('entity-objects', '实体物件', 'unsupported', '不支持盔甲架、展示框、画、船等实体物件。', []),
  item(
    'dynamic-elevator',
    '动态电梯',
    'unsupported',
    '没有可运行的电梯实体；只能做静态井道、门洞与楼梯。',
    [],
    ['用楼梯 / 坡道替代，或把电梯井标为不可用空间。'],
  ),
  item(
    'underground-visualization',
    '地下空间展示',
    'partial',
    '体素可以写 y ≤ 0，但渲染跳过这些格，看不清真实地下空间。',
    ['地下部分只保证数据与分析，不能靠七视角截图验收。', '不要承诺“完整地下空间展示”。'],
  ),
  item(
    'default-interiors',
    '室内与家具',
    'partial',
    '室内可用方块搭建：主要空间、楼板、隔墙、固定家具、灯具与地面材质都在 World API 能力内；当前缺口是渲染缺少人眼 / 室内视角。',
    [
      '室内验收目前只能靠俯视 / 剖切或外部轴测，无法完整判断光线、视线与家具比例。',
      '真实软装、可交互容器内容、实体家具仍不支持。',
    ],
    ['在方案中明确主要空间与固定家具；把室内视角列为待补渲染能力，不把外部图当作室内验收。'],
  ),
  item(
    'structural-calculation',
    '结构计算',
    'unsupported',
    '不提供材料力学、荷载、抗震或施工图级结构计算。',
    [],
    ['只做跨度与悬空的启发式检查，并在报告中写明限制。'],
  ),
  item(
    'code-compliance',
    '规范审查',
    'unsupported',
    '不替代建筑规范、消防、无障碍或施工图审查。',
    [],
    ['把相关要求写成设计偏好 / 待专业复核项。'],
  ),
  item('redstone', '红石 / 动态系统', 'unsupported', '不生成红石电路、可交互机械或动态场景。', []),
];

const BLOCK_USAGE: readonly CapabilityBlockUsage[] = BLOCK_USAGES.map((usage) => ({
  id: usage.id,
  name: usage.name,
  blocks: usage.blocks,
  how: usage.how.join('；'),
  states: usage.states.join('；'),
  mistakes: usage.mistakes.join('；'),
}));

/** 默认能力卡；版本变化必须同时更新 CAPABILITY_CARD_VERSION。 */
export const DEFAULT_CAPABILITY_CARD: CapabilityCard = CapabilityCard.parse({
  version: CAPABILITY_CARD_VERSION,
  generatedFrom: [
    'packages/geometry/world.d.ts',
    'packages/geometry/src/schema.ts',
    'packages/render/src/camera.ts',
    'packages/agent/src/prompt/system.ts',
    'packages/analysis/src',
    'assets/mc-1.20.1/block-capabilities.json',
  ],
  coordinates: {
    system: 'x-east-y-up-z-south',
    groundY: 0,
    firstFloorY: 1,
    xz: [XZ_MIN, XZ_MAX],
    y: [Y_MIN, Y_MAX],
    renderSkip: '渲染只画 y > 0 的格；y ≤ 0 计入 belowGround，不进入七视角画面。',
  },
  world: {
    components: COMPONENTS,
    blockStates: {
      syntax: 'MC 1.20.1 方块 id，可带状态，如 oak_stairs[facing=east,half=bottom]。',
      properties: '方块状态字符串由 sandbox 预检与 blocks 注册表校验；非法状态会报错。',
      shapes: '楼梯、台阶、栏杆、玻璃板等形状方块会按形状绘制，细部优先使用。',
      unsupported: ['实体方块上的任意 NBT', '动态方块实体', '可交互容器内容'],
    },
    blockUsage: BLOCK_USAGE,
    writeLayers: ['opening', 'structure', 'decoration'],
  },
  render: {
    views: ['south', 'east', 'north', 'west', 'top', 'iso-se', 'iso-nw'],
    limitations: [
      '只有正交立面、俯视与两个斜视图；没有人眼高度、室内或细部微距视角。',
      'y ≤ 0 的格不进入画面，地下与部分下沉空间无法用截图验收。',
      '渲染只表达方块与颜色，不表达材质真实感、光照氛围或可玩性。',
    ],
  },
  analysis: ANALYSIS,
  limitations: LIMITATIONS,
  scope: {
    defaultBuildScope: 'exterior+interior',
    defaultInterior:
      '小型建筑默认完成外观、入口、场地与完整室内：主要空间、楼板 / 楼层、固定家具、灯具与地面材质；不能只做空壳。',
    note: '交互层提出超出能力卡的要求时，必须转成 capabilities / 未决问题，不得静默承诺。',
  },
});

/** 展平能力卡的查找集合（World 构件 + 分析 + 限制）；重名时先出现的为准。 */
export function capabilityItem(card: CapabilityCard, id: string): CapabilityItem | undefined {
  return (
    card.world.components.find((entry) => entry.id === id) ??
    card.analysis.find((entry) => entry.id === id) ??
    card.limitations.find((entry) => entry.id === id)
  );
}

/** 查能力状态；未知 id 返回 undefined，调用方应把它当作“未登记能力”而不是自动允许。 */
export function capabilityStatus(card: CapabilityCard, id: string): CapabilityStatus | undefined {
  return capabilityItem(card, id)?.status;
}

/** 只有 supported / partial 才能进入承诺；unsupported 与未登记一律 false。 */
export function canPromise(card: CapabilityCard, id: string): boolean {
  const status = capabilityStatus(card, id);
  return status === 'supported' || status === 'partial';
}
