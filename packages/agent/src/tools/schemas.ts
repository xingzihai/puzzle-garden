/**
 * 施工工具的 zod 定义与生成的 JSON Schema（AGENT-SPEC §4；决策 #115 新增 massing / read_massing；
 * Phase 3C 新增 probe；Phase 3E 新增 plan；W11-03 新增按需参考 reference）。
 *
 * 负责：参数 schema、给模型看的 JSON Schema（去掉 `$schema` 键，C19）与整体工具定义数组。
 * 不负责：执行工具（code-edit / submit / check / view / probe / plan / design / massing / reference）、拼 ChatRequest（runner）。
 * 本文件是纯函数：只依赖 zod，不做 I/O。工具描述会影响 token 预算（§3.1），改动要重测。
 */

import { z } from 'zod';

/**
 * 既有 12 个施工工具。v1 提示与既有测试以此为基线，保持不变；
 * `reference` 单独放在 {@link ALL_TOOL_NAMES} 末尾，由 {@link toolDefs} 按 profile 决定是否暴露。
 */
export const TOOL_NAMES = [
  'write_code',
  'edit_code',
  'read_code',
  'check_code',
  'view_building',
  'probe',
  'plan',
  'submit',
  'write_design',
  'read_design',
  'massing',
  'read_massing',
] as const;

/** 按需参考工具名（W11-03）；工具名本身必须精确为 `reference`。 */
export const REFERENCE_TOOL_NAME = 'reference' as const;

/** 全部施工工具：既有 12 个 + reference。runner 的请求工具表从这里生成。 */
export const ALL_TOOL_NAMES = [...TOOL_NAMES, REFERENCE_TOOL_NAME] as const;
export type ToolName = (typeof ALL_TOOL_NAMES)[number];

/**
 * 草模子运行工具（决策 #112）：只有宿主接线（`RunnerDeps.massing` 存在）时才暴露给模型。
 * host 未接线时从请求的工具表里过滤掉（实验公平性：B 组不应看到子代理工具），
 * 但分发仍认这两个名字（{@link TOOL_NAMES} 不变），越权调用回既有 no-host 文本。
 */
export const MASSING_TOOL_NAMES = ['massing', 'read_massing'] as const;
export type MassingToolName = (typeof MASSING_TOOL_NAMES)[number];

/** 名字是否是草模工具。 */
export function isMassingToolName(name: string): name is MassingToolName {
  return (MASSING_TOOL_NAMES as readonly string[]).includes(name);
}

/** 名字是否是按需参考工具。 */
export function isReferenceToolName(name: string): name is typeof REFERENCE_TOOL_NAME {
  return name === REFERENCE_TOOL_NAME;
}

/** 视图名（RENDER-SPEC §11）：与 @pg/render 的 ViewName 同集合；此处不 import render，避免运行时依赖。 */
export const VIEW_NAMES = ['south', 'east', 'north', 'west', 'top', 'iso-se', 'iso-nw', 'interior', 'cutaway'] as const;

/** 编辑条数上限（AGENT-SPEC §4.1）：模型一次最多改 20 处。 */
export const MAX_EDITS = 20;
/** 提交说明字符上限（AGENT-SPEC §4.4）。 */
export const MAX_SUBMIT_NOTE = 2000;
/** 设计文档字符上限（AGENT-SPEC §4.5）：骨架层与细化层各写一份，太长会挤占上下文。 */
export const MAX_DESIGN_CHARS = 24000;
/** reference 查询串上限：只查一个符号 / 方块 / 类别，避免把提示词或整段文档塞进来。 */
export const MAX_REFERENCE_QUERY_CHARS = 120;

/** 建模简报字符上限（SUBAGENT-LOOP-SPEC §1.1）：4000 字符约 1300 token。 */
export const MAX_MASSING_BRIEF = 4000;
/** 子运行轮数范围：默认 20（决策 #107），上限 40 留给重试余量而非一次吃光预算。 */
export const MASSING_MIN_TURNS = 4;
export const MASSING_MAX_TURNS = 40;
export const MASSING_DEFAULT_TURNS = 20;
/** 子运行单次花费范围：默认 ¥0.5（≈实测成功 run 的 3–6 倍），上限 ¥1（不超过默认父预算 ¥3.5 的三分之一）。 */
export const MASSING_MIN_CNY = 0.05;
export const MASSING_MAX_CNY = 1;
export const MASSING_DEFAULT_CNY = 0.5;

export const WriteCodeArgs = z.strictObject({
  code: z.string(),
});

export const EditArgs = z.array(
  z.strictObject({
    find: z.string(),
    replace: z.string(),
  }),
);

export const EditCodeArgs = z.strictObject({
  edits: EditArgs.min(1).max(MAX_EDITS),
});

export const ReadCodeArgs = z.strictObject({
  from: z.int().min(1).optional(),
  to: z.int().min(1).optional(),
});

export const CheckCodeArgs = z.strictObject({});

export const ViewBuildingArgs = z.strictObject({
  views: z.array(z.enum(VIEW_NAMES)).min(1).max(4).optional(),
});

/** probe 单次最多查询的点数（与 tools/probe.ts 的 PROBE_MAX_POINTS 一致）。 */
export const MAX_PROBE_POINTS = 32;

const ProbePointArgs = z.array(z.int()).length(3);

/** probe 参数：points / box / section 恰好给一个（Phase 3C）。 */
export const ProbeArgs = z
  .strictObject({
    points: z.array(ProbePointArgs).min(1).max(MAX_PROBE_POINTS).optional(),
    box: z
      .strictObject({
        min: ProbePointArgs,
        max: ProbePointArgs,
        /** 缺省 true：按方块 / 来源聚合前 12 项；false 时只列逐格明细。 */
        counts: z.boolean().optional(),
      })
      .optional(),
    section: z
      .strictObject({
        axis: z.enum(['x', 'z']),
        at: z.int(),
        y: z.array(z.int()).length(2).optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const count = [value.points, value.box, value.section].filter((item) => item !== undefined).length;
    if (count !== 1) {
      ctx.addIssue({ code: 'custom', message: 'points / box / section 必须且只能提供一个' });
    }
    if (value.box !== undefined) {
      const { min, max } = value.box;
      if ((max[0] ?? 0) < (min[0] ?? 0) || (max[1] ?? 0) < (min[1] ?? 0) || (max[2] ?? 0) < (min[2] ?? 0)) {
        ctx.addIssue({ code: 'custom', path: ['box'], message: 'box.max 必须逐轴不小于 box.min' });
      }
    }
    if (value.section?.y !== undefined && (value.section.y[0] ?? 0) > (value.section.y[1] ?? 0)) {
      ctx.addIssue({ code: 'custom', path: ['section', 'y'], message: 'section.y 要求下限不大于上限' });
    }
  });

export const SubmitArgs = z.strictObject({
  note: z.string().max(MAX_SUBMIT_NOTE),
});

export const WriteDesignArgs = z.strictObject({
  content: z.string().min(1).max(MAX_DESIGN_CHARS),
});

export const ReadDesignArgs = z.strictObject({});

/** massing 参数（SUBAGENT-LOOP-SPEC §1.1）；缺省 seed 由父 seed + 序号派生（§2.3）。 */
export const MassingArgs = z.strictObject({
  brief: z.string().min(1).max(MAX_MASSING_BRIEF),
  maxTurns: z.int().min(MASSING_MIN_TURNS).max(MASSING_MAX_TURNS).default(MASSING_DEFAULT_TURNS),
  maxCny: z.number().min(MASSING_MIN_CNY).max(MASSING_MAX_CNY).default(MASSING_DEFAULT_CNY),
  seed: z
    .int()
    .min(0)
    .max(2 ** 32 - 1)
    .optional(),
});

/** read_massing 参数：id 是 massing 工具返回的稳定句柄；from / to 语义同 read_code（§5.3）。 */
export const ReadMassingArgs = z.strictObject({
  id: z.string().regex(/^massing#[1-9]\d*$/, 'id 形如 massing#1'),
  from: z.int().min(1).optional(),
  to: z.int().min(1).optional(),
});

/**
 * reference 参数（W11-03）：scope 只允许 api / block，query 去首尾空白后 1–120 字符。
 * 工具只读常量数据源，不接受路径；路径式 query 由实现返回可行动错误。
 */
export const ReferenceArgs = z.strictObject({
  scope: z.enum(['api', 'block']),
  query: z.string().trim().min(1).max(MAX_REFERENCE_QUERY_CHARS),
});

/** 计划项上限；与 tools/plan.ts 的 MAX_PLAN_ITEMS 一致（纯入口之间不互相 import）。 */
const PLAN_ITEM_LIMIT = 64;

const PlanItemArgs = z.strictObject({
  id: z.string().min(1),
  status: z.enum(['todo', 'doing', 'verified', 'failed']),
  evidence: z.string().optional(),
});

/**
 * plan 参数（Phase 3E）：严格三选一。
 * - read：读回当前计划；
 * - update：整体替换阶段与清单，note 可省略；
 * - conflict：追加一条待解决冲突，不中断 run。
 */
export const PlanArgs = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read') }),
  z.strictObject({
    action: z.literal('update'),
    phase: z.enum(['plan', 'ground', 'roof', 'interior', 'detail', 'self-check']),
    items: z.array(PlanItemArgs).max(PLAN_ITEM_LIMIT),
    note: z.string().optional(),
  }),
  z.strictObject({
    action: z.literal('conflict'),
    kind: z.string(),
    expected: z.string(),
    actual: z.string(),
    options: z.array(z.string()),
  }),
]);

/** 工具名 → 参数 schema。runner 解析 tool_call 参数时用。 */
export const TOOL_ARGS = {
  write_code: WriteCodeArgs,
  edit_code: EditCodeArgs,
  read_code: ReadCodeArgs,
  check_code: CheckCodeArgs,
  view_building: ViewBuildingArgs,
  probe: ProbeArgs,
  plan: PlanArgs,
  submit: SubmitArgs,
  write_design: WriteDesignArgs,
  read_design: ReadDesignArgs,
  massing: MassingArgs,
  read_massing: ReadMassingArgs,
  reference: ReferenceArgs,
} as const satisfies Record<ToolName, z.ZodType>;

/** 与 §4 表一一对应的描述；改动即改变 `versions.tools`。 */
const DESCRIPTIONS: Record<ToolName, string> = {
  write_code: '整份写入当前稿（第一版，或推倒重来）。',
  edit_code: '局部修改当前稿：每条 find 必须在当前稿里恰好出现 1 次（逐字匹配），任一条失败则全部不生效。',
  read_code: '带行号读当前稿；缺省全文，一次最多 400 行。',
  check_code: '对当前稿做类型预检 → 执行 → 测量，作用于当前稿。',
  view_building: '渲染最近一次执行成功的存档（缺省 iso-se 与 iso-nw），图附在本轮末尾。',
  probe:
    '读取最近一次执行成功的存档，回答“这一格最终是什么、是谁写的”。' +
    'points 逐点返回最终方块与来源调用（最多 32 个）；box 汇总半开盒（最多 4096 格），按方块 / 来源聚合前 12 项并列出实体格（最多 40 个）；' +
    'section 输出固定宽度 ASCII 剖面（axis=x 扫 z，axis=z 扫 x，行按 y 降序；最多 1200 格）。三种模式任选一种，不渲染图片。',
  plan:
    '维护施工计划：read 读回当前计划；update 整体替换阶段与 must 清单（id / status / evidence）；' +
    'conflict 记录一条待解决冲突（不中断 run）。计划摘要会出现在每轮事实行里。',
  submit: '宣布完成；只有当前稿已 check_code 且执行成功时才会被接受。',
  write_design:
    '写入/整体替换本阶段的设计文档（骨架层与细化层都用；建议包含任务目标、验收标准、必须实现的重点、美术设计，以及用注释/公式表达重复规律）。',
  read_design: '读当前设计文档，没有时给出提示。',
  massing:
    '把自由造型需求写成建模简报，派一次有界的草模子运行；返回一张多角度合成图与引用 massing#N。' +
    '简报写清形体、比例与关键尺寸，不写施工细节；子运行花费从本 run 预算扣，失败不会中断本 run。' +
    '当需求包含现有构件不易表达的自由造型（如连续凹曲屋面、穹顶、任意旋转体等）时使用。',
  read_massing: '按引用 id 带行号读草模代码；缺省全文，一次最多 400 行。',
  reference:
    '按需查 API 局部声明或方块用法：scope api 按构件 / 符号名返回声明与一行用法，scope block 按方块 id / ' +
    '中文名 / 类别返回状态与组合用法；只读，单次约 2500 / 1500 字符，超出会截断。',
};

/** 去掉 `$schema` 键后的 JSON Schema（C19）。 */
export function parametersOf(name: ToolName): Record<string, unknown> {
  const json = z.toJSONSchema(TOOL_ARGS[name]) as Record<string, unknown>;
  delete json['$schema'];
  // 判别联合只生成 oneOf；顶层补 type: object，保持与其他工具同形，也兼容只检查 type 的客户端。
  if (json['type'] === undefined && Array.isArray(json['oneOf'])) json['type'] = 'object';
  return json;
}

/** 发给模型的工具定义（与 `@pg/llm/schema` 的 ToolDef 同形，但不 import llm）。 */
export interface ToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: ToolName;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

function definitionOf(name: ToolName): ToolDefinition {
  return { type: 'function', function: { name, description: DESCRIPTIONS[name], parameters: parametersOf(name) } };
}

/** ChatRequest 的工具上限（`@pg/llm/schema` 的 `tools.max(12)`）。 */
export const MAX_TOOL_DEFS = 12;

/** 全部工具定义（含 reference），顺序固定；具体 profile 由 {@link toolDefs} 过滤。 */
export const TOOL_DEFS: readonly ToolDefinition[] = ALL_TOOL_NAMES.map(definitionOf);

/**
 * 按 profile 选暴露给模型的工具，保证不超过 {@link MAX_TOOL_DEFS}：
 * - `massingEnabled` 为 false：过滤 `massing` / `read_massing`，保留 reference（11 个，v2 施工 profile）；
 * - `massingEnabled` 为 true：过滤 reference，保留原 12 个工具（A 组行为逐字节不变）；
 *   此时按需参考降级为提示词内的速查卡，避免 13 个工具超过请求上限。
 */
export function toolDefs(massingEnabled: boolean): readonly ToolDefinition[] {
  const defs = massingEnabled
    ? TOOL_DEFS.filter((d) => !isReferenceToolName(d.function.name))
    : TOOL_DEFS.filter((d) => !isMassingToolName(d.function.name));
  if (defs.length > MAX_TOOL_DEFS) {
    throw new Error(`工具数 ${String(defs.length)} 超过上限 ${String(MAX_TOOL_DEFS)}`);
  }
  return defs;
}
