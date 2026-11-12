/**
 * system 提示（AGENT-SPEC §3.1）：约定段 + 模型可见的 world.d.ts 全文。
 *
 * 负责：拼出整个 run 内逐字节不变的 system 文本；约定段只写模型从声明里读不到的约定
 * （坐标、地表、入口形态、全局名字、写入优先级、工具与轮次规则、测量的含义）；
 * `variant: 'craft'` 时在"工作方式"之后、world.d.ts 之前插入做法提示与范例（决策 #84）；
 * `variant: 'craft-small'` 时在同一位置插入 1–3 层小体量与室内做法段；
 * `variant: 'v02hint'` 时在同一位置插入 v0.2 原版"材质与形态"一节的删减稿（对照实验）；
 * `designAuthority: 'fixed'` 时在"工作方式"后插入"已确认方案"与施工手册（六阶段 / API 地图 / 茶亭骨架），
 * 手册只服务设计交接，free / 缺省不输出。
 * 默认范围句不再排除室内；为保留旧实验的可比性，只有 base 与 craft-small 使用新句，
 * 其余旧 variant 仍用原句，输出逐字节不变（2026-10-19）。
 * 不负责：读 world.d.ts 文件（调用方读出后传入，本文件是纯函数）、工具 JSON Schema（tools/schemas.ts）。
 * 不写构件参数规则：参数由类型预检与构件报错纠正（DESIGN §7：靠提示词纠正参数误用已证伪）。
 */

import type { PromptVersion } from '@pg/config';

import { BUILD_PLAYBOOK_SECTION, buildPromptV2 } from './build-playbook.ts';
import { CRAFT_SECTION } from './craft.ts';
import { CRAFT_SMALL_SECTION } from './craft-small.ts';
import { CRAFT2_SECTION } from './craft2.ts';
import { BLUEPRINT_SECTION, DETAIL_SECTION, REFINE_SECTION, SKELETON_SECTION } from './staged.ts';
import { V02HINT_SECTION } from './v02hint.ts';

/**
 * 提示变体：`base` 只放约定段；`craft` 另附形态方块做法提示与两段范例（决策 #84）；
 * `craft2` 在 craft 基础上把"立面层次"段换成 DECOR-PLAN §3 的表面装饰段；`craft-small` 面向
 * 1–3 层小体量与室内（尺度、家具、楼层、状态写法）；`v02hint` 附 v0.2 删减稿；
 * `skeleton` 只搭体量骨架（分段实验第 1 段）；`detail` 在 craft 内容之后叠加"骨架冻结、只加细部"
 * （分段实验第 2 段，配 `--seed-code` 从上一段交付代码开始）；
 * `blueprint` 是两层实验的骨架层（先写设计文档再搭骨架）；`refine` 是细化层
 * （在 craft 内容之后叠加"先写自己的细化设计文档再细化"）。
 */
export type PromptVariant =
  'base' | 'craft' | 'v02hint' | 'craft2' | 'craft-small' | 'skeleton' | 'detail' | 'blueprint' | 'refine';

/**
 * 设计权威：`free`（缺省）沿用原有自由设计；`fixed` 用于设计报告 → 构建层的交接，
 * 在"工作方式"之后追加"已确认方案"约定与施工手册，要求构建 agent 按 design.md / BuildSheet 施工而不是重新设计。
 */
export type DesignAuthority = 'free' | 'fixed';

/** `fixed` 时追加的约定段；`free` / 缺省不输出，保证旧提示逐字节不变。 */
export const FIXED_DESIGN_SECTION = `## 已确认方案

- design.md 是用户确认的唯一方案依据。
- 不得改变主要布局、房间用途 / 数量、外部尺寸、层高、入口、主要屋面 / 主要材质、用户点名细节。
- 可自行处理构造、局部装饰、铺装图案、灯具与家具细节（若在方案范围内）。
- 无法实现或方案冲突时，停止并报告冲突，不自行改方案。
`;

/**
 * "工作方式"之后要插入的附加段（含与 `## World API 声明` 标题之间的一个空行）。
 * base 返回空串；各变体只追加自己的段，不改约定段其余文字。
 */
function extraSection(variant: PromptVariant): string {
  if (variant === 'craft') return `${CRAFT_SECTION}\n`;
  if (variant === 'craft2') return `${CRAFT2_SECTION}\n`;
  if (variant === 'craft-small') return `${CRAFT_SMALL_SECTION}\n`;
  if (variant === 'v02hint') return `${V02HINT_SECTION}\n`;
  if (variant === 'skeleton') return `${SKELETON_SECTION}\n`;
  if (variant === 'detail') return `${CRAFT_SECTION}\n${DETAIL_SECTION}\n`;
  if (variant === 'blueprint') return `${BLUEPRINT_SECTION}\n`;
  if (variant === 'refine') return `${CRAFT_SECTION}\n${REFINE_SECTION}\n`;
  return '';
}

/** 默认范围句（base 与 craft-small）：不再无条件排除室内。 */
const SCOPE_DEFAULT =
  '默认完成外观、入口与可进入；题面或设计报告明确要求室内、家具、楼层时，室内也必须完成并达到与外观同等质量。';
/** 旧实验变体的范围句：逐字节保留，craft 仍用于哥特 / 巨构回归。 */
const SCOPE_EXTERIOR_ONLY = '本阶段只做外观与可进入，不做内饰。';

export interface SystemPromptInput {
  /** `@pg/geometry/world.d.ts` 全文（生成文件，原样放入）。 */
  readonly worldDts: string;
  /** 轮数上限；null 表示不限轮数（决策 #87）。 */
  readonly maxTurns: number | null;
  /** 最后几轮是提交窗口（RunLimits.submitWindow）。 */
  readonly submitWindow: number;
  /** 提交窗口内可用的工具名：传 facts.ts 的 WINDOW_TOOLS（与窗口通知同源）。 */
  readonly windowTools: readonly string[];
  /** 缺省 `base`：使用不排除室内的默认范围句。 */
  readonly variant?: PromptVariant;
  /**
   * 设计权威：缺省 `free`（旧行为）；`fixed` 时在"工作方式"之后追加"已确认方案"约定，
   * 要求按 design.md 施工、不得自行改方案。
   */
  readonly designAuthority?: DesignAuthority;
  /**
   * 是否暴露草模子运行工具（`massing` / `read_massing`，决策 #112）：false 时不写这两个工具的约定段，
   * 与传入的工具表同步（host 未接线 → 8 个）。缺省 true，保持加入该开关前的调用方行为逐字节不变。
   */
  readonly massingEnabled?: boolean;
  /**
   * 提示词版本（W11-02）：缺省 `v1`，旧输出逐字节不变。`v2` 只对 fixed / build 路径生效
   * （`designAuthority: 'fixed'` 且 variant 为 `base` / `craft-small`）；free 与旧实验变体
   * 继续走 v1。真正的环境开关是 `PG_PROMPT_VERSION`，由调用方把配置传入本字段。
   */
  readonly promptVersion?: PromptVersion;
}

/**
 * 选择实际生效的提示版本（纯函数，便于契约测试与回滚）。
 * v2 只替换 fixed / build 的 system；free 路径即使请求 v2 也保持 v1，保证 benchmark 可比。
 */
export function resolvePromptVersion(
  input: Pick<SystemPromptInput, 'promptVersion' | 'designAuthority' | 'variant'>,
): PromptVersion {
  if (input.promptVersion !== 'v2') return 'v1';
  if (input.designAuthority !== 'fixed') return 'v1';
  const variant = input.variant ?? 'base';
  return variant === 'base' || variant === 'craft-small' ? 'v2' : 'v1';
}

/** 约定段。数字由 {@link systemPrompt} 填入；改动这段文字即改变 `versions.prompt`。 */
function conventions(
  maxTurns: number | null,
  submitWindow: number,
  tools: readonly string[],
  variant: PromptVariant,
  massingEnabled: boolean,
  designAuthority: DesignAuthority,
): string {
  const windowTools = tools.join('、');
  // base 与 craft-small 使用不排除室内的新范围句；旧实验 variant 保留原句，保证逐字节不变。
  const scope = variant === 'base' || variant === 'craft-small' ? SCOPE_DEFAULT : SCOPE_EXTERIOR_ONLY;
  // massingEnabled 为 false 时删掉最后两条草模工具说明；为 true 时与开关引入前逐字节相同，
  // 只在 true 分支补 A 组路由句（决策 #112 修订：告诉模型何时用自由造型能力）。
  const massingLines = massingEnabled
    ? '- massing：把自由造型需求写成建模简报，派一次有界的草模子运行；返回一张多角度合成图与引用 massing#N。简报写清形体、比例与关键尺寸，不写施工细节；子运行花费从本 run 预算扣，失败不会中断本 run。\n' +
      '- read_massing：按引用 id 带行号读草模代码；缺省全文，一次最多 400 行。\n' +
      "当需求包含现有构件不易表达的自由造型（如连续凹曲屋面、穹顶、任意旋转体等）时，先用 massing 生成草模，再用 world.massingImport('massing#N', …) 把它并进建筑；草模定形体，施工细节仍用构件补。\n"
    : '';
  // B 组（host 未接线，只暴露 8 工具）的对称路由句：只在 false 时出现，且不点任何题目细节。
  const shapeHint = massingEnabled
    ? ''
    : "当需求包含现有构件不易表达的自由造型（如连续凹曲屋面、穹顶、任意旋转体等）时，用 world.surfaceShell 直接成形：kind:'surface' 写 (u,v) 公式，kind:'revolve' 写母线；参数与限制见下方声明。\n";
  // 数字保持逐字节原文（system.test.ts 的 sha256 锁定用例依赖它）；null 是不限轮数（决策 #87）。
  const turnRule =
    maxTurns === null
      ? `- 轮数不限。费用或墙钟快用完时进入提交窗口：只能用 ${windowTools}。费用或墙钟用完时还没提交，就没有交付。`
      : `- 最后 ${String(submitWindow)} 轮是提交窗口：只能用 ${windowTools}。轮数、费用或墙钟用完时还没提交，就没有交付。`;
  // free / 缺省为空串，旧提示逐字节不变；fixed 插在"工作方式"之后、variant 附加段之前：
  // 先给"已确认方案"约定，再给施工手册（六阶段 + API 地图 + 茶亭骨架），最后才是 world.d.ts。
  const authority = designAuthority === 'fixed' ? `${FIXED_DESIGN_SECTION}\n${BUILD_PLAYBOOK_SECTION}\n` : '';
  return `你用 TypeScript 写代码建造一栋 Minecraft 1.20.1 方块建筑，并通过工具检查、看图、修改，满足题面后提交。${scope}

## 世界
- 一格一方块，坐标为整数：x 向东、y 向上、z 向南。
- y = 0 是地表（地面那一层）；地面上的第一层是 y = 1，站在地上的人脚在 y = 1。建筑从 y = 1 起建，y < 0 是地下。
- 方块名用 MC 1.20.1 的 id（如 stone_bricks），可带状态（如 oak_stairs[facing=east]）。
- 尺度：按真人可用的真实尺度建造，在场地允许范围内把体量、层高与比例做足；不要做成微缩摆设或只求过关的空壳。
- 形状方块：做细部时优先用带形状的方块——*_stairs（坡面、檐口、台阶；注意 facing/half 朝向）、*_slab[type=top|bottom|double]（薄边、过渡、檐口）、fence/墙类（栏杆）、pane/玻璃（窗）；画面会按形状绘制，细节会明显更好。例如 oak_stairs[facing=east,half=bottom]。

## 代码
- 整份代码是一个模块，必须且只能有一个入口：
  export default function build(w: World): void { … }
  同步执行。顶层可以写常量与辅助函数。
- 不能 import、require、declare。World、rect 以及下面声明里的类型都是现成的全局名字。
- 没有 Node 与浏览器 API（fetch、process、setTimeout 等都不存在）。console.log 的输出会出现在检查结果里。
- 写入分三层：opening（开洞）> structure（结构）> decoration（装饰）。同一格不同层取优先的那层，同层后写覆盖；结果与调用顺序无关。w.get 返回按同样规则合成后的方块。
- 构件参数不合法时会执行出错并说明原因与合法范围。

## 工具
- write_code：整份写入当前稿（第一版，或推倒重来）。
- edit_code：局部修改当前稿。每条 find 必须在当前稿里恰好出现 1 次，按原文逐字匹配（空格、换行都算）；任一条失败则全部不生效。没把握时先 read_code。edit_code 与 check_code 可以在同一轮一起调用：先改再检，省一轮。
- read_code：带行号读当前稿。
- check_code：对当前稿做类型预检 → 执行 → 测量。
- view_building：渲染最近一次执行成功的版本，图附在本轮末尾。一次可要多张视图（最多 4 张），如 views: ['iso-se', 'top']。
- submit：提交。只有当前稿已经 check_code 且执行成功时才会被接受；要求先写设计文档的阶段，还没 write_design 时也会被拒绝。接受后本轮排在它后面的工具不再执行，交付的就是这一版。
- write_design：写入/整体替换本阶段的设计文档，建议包含任务目标、验收标准、必须实现的重点、美术设计（重复规律尽量写成公式放进注释）。
- read_design：读当前设计文档；还没有时提示先 write_design。
${massingLines}${shapeHint}
## 轮次
- 每轮你回复一次，可以在一次回复里调用多个工具，按顺序执行。
- 每轮末尾有一条事实行：轮次、已花费用、墙钟，当前稿与最近检查、看图的版本号。
${turnRule}

## 测量
check_code 执行成功后附带测量。测量只给数字与位置，不判合格、不评好看；要不要改由你对照题面决定。
- 悬空：从 y ≤ 1 的方块出发沿共面相连够不到的方块。只靠棱或角相连的另外计数。
- 夹层：同一列里上下两层板之间只隔 1–2 格空气的地方。
- 可达：从场地外的地面出发能走到的站立点。站立点 = 脚下是实心方块、本格和头顶一格都不挡人。每步可平走，上 1 格（脚下是楼梯或台阶直接上，否则要跳，起点头顶再上一格也要空），或下落不超过 3 格。栅栏与围墙挡人、不能站；门、草、地毯可穿过。每块楼板与每个平屋面各给一个目标点，报告能不能到；"差一步"列出走不过去的位置与挡路方块。
- 屋面：每个 roof 调用的格数与列厚。
- 来源写作 api#编号，例如 floorPlate#12 指代码里写出那块楼板的那次调用。

## 工作方式
先搭出整体形体并 check_code，再逐步细化；修改优先用 edit_code。需要看外观时调用 view_building。执行成功并满足题面后调用 submit。

${authority}${extraSection(variant)}## World API 声明（world.d.ts）
`;
}

/** 完整 system 文本：约定段后接 world.d.ts 全文（代码块包裹）。 */
export function systemPrompt(input: SystemPromptInput): string {
  if (!Number.isSafeInteger(input.submitWindow) || input.submitWindow < 1) {
    throw new RangeError(`submitWindow 必须是正整数，实际是 ${String(input.submitWindow)}`);
  }
  if (input.windowTools.length === 0) throw new RangeError('windowTools 为空：提交窗口内至少要能 submit');
  if (input.worldDts.trim() === '') throw new RangeError('worldDts 为空：应传入 @pg/geometry/world.d.ts 全文');
  // v2 不常驻 world.d.ts：完整签名走 reference / 预检。worldDts 仍校验，避免调用方误传空串。
  if (resolvePromptVersion(input) === 'v2') {
    return buildPromptV2({
      maxTurns: input.maxTurns,
      submitWindow: input.submitWindow,
      windowTools: input.windowTools,
      massingEnabled: input.massingEnabled ?? true,
    });
  }
  const dts = input.worldDts.endsWith('\n') ? input.worldDts : `${input.worldDts}\n`;
  return `${conventions(
    input.maxTurns,
    input.submitWindow,
    input.windowTools,
    input.variant ?? 'base',
    input.massingEnabled ?? true,
    input.designAuthority ?? 'free',
  )}\`\`\`ts\n${dts}\`\`\`\n`;
}
