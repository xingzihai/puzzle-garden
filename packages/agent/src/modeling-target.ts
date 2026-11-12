/**
 * 草模 target 到共享 runner 的适配（AGENT-TARGET.md；MODELING-SPEC §5）。
 *
 * 负责：草模 system 提示（Model 声明、粗骨架规则、函数示例、提交窗口）、会话状态接线、事实行与交付；
 *   工具逻辑在 modeling-tools/session.ts，参数 schema 在 modeling-tools/schemas.ts。
 * 不负责：主循环 / 请求 / 护栏（runner.ts）、隔离执行（注入的 execute，真实实现是 @pg/sandbox/modeling）、
 *   渲染（注入的 render 可选；未配置时 view_model 明说没有看图，不伪造）。
 * 真实模型调用由 CLI 授权后发起；本文件不生成数组塞进 tools 文字，图片只经 TargetTurn.images 在轮末追加。
 */

import { MODEL_DECLARATION } from '@pg/modeling/declaration';
import { MODEL_VERSION } from '@pg/modeling/schema';
import type { RunLimits } from '@pg/store/events';

import { DEGENERATE_NOTICE, NO_TOOL_NOTICE, FACTS_MAX_CHARS } from './facts.ts';
import type { FactsInput } from './facts.ts';
import { deliverModel } from './modeling-tools/deliver.ts';
import { MODEL_WINDOW_TOOLS, draftVersion, initialModelState, runModelToolCalls } from './modeling-tools/session.ts';
import type {
  ModelExecute,
  ModelRender,
  ModelToolContext,
  ModelTurn,
  RenderedModelView,
} from './modeling-tools/session.ts';
import { MODEL_TOOL_DEFS } from './modeling-tools/schemas.ts';
import type { RunnerInput } from './runner.ts';
import type { RunnerTarget, TargetContext } from './target.ts';

/** 事实文本格式版本（进 `versions.factsFormat`）；措辞或截断规则改动时加 1。 */
export const MODEL_FACTS_FORMAT = 2;

export interface ModelingTargetDeps {
  /** 隔离执行当前代码；真实实现：`createModelRunner().runCode(code, { seed, signal })`。异常一律按 internal-error 停止。 */
  readonly execute: ModelExecute;
  /** 可选渲染器：把校验后的文档渲染成图片。不给时 view_model 返回“未配置渲染/没有看图”。 */
  readonly render?: ModelRender;
  /** 交付 manifest 里记录的建模版本；缺省 modelingApi=2、modelFormat=MODEL_VERSION（决策 #113 起升为 2）。 */
  readonly versions?: { readonly modelingApi: number; readonly modelFormat: number };
}

function minutes(ms: number): string {
  return String(Math.floor(ms / 60_000));
}

function yuan(cny: number): string {
  return `¥${cny.toFixed(2)}`;
}

function checkText(c: NonNullable<FactsInput['lastCheck']>): string {
  switch (c.outcome) {
    case 'ok':
      return `执行成功${c.hash === undefined ? '' : `（文档 hash ${c.hash.slice(0, 8)}…）`}`;
    case 'precheck-failed':
      return '类型预检未通过';
    case 'build-error':
      return '执行出错';
    case 'not-finished':
      return '执行未完成';
  }
}

/** 窗口通知的草模版本：工具列表用 MODEL_WINDOW_TOOLS，与 system 提示同源。 */
function windowNotice(window: NonNullable<FactsInput['window']>, hasDraft = true): string {
  const rule = `不能再 write_code 整份写入；仍可用 ${MODEL_WINDOW_TOOLS.join('、')}（可读、可改、可执行、可看图、可提交）`;
  const lead =
    window.remaining === null
      ? window.entering
        ? '进入提交窗口：'
        : '提交窗口：费用或墙钟即将用完。'
      : window.entering
        ? `进入提交窗口：剩余 ${String(window.remaining)} 轮。`
        : `提交窗口：剩余 ${String(window.remaining)} 轮。`;
  if (!hasDraft) return `${lead}当前还没有代码，先 write_code 建立初稿；之后${rule}。`;
  if (window.remaining === null) {
    return window.entering ? `进入提交窗口：${rule}。` : '提交窗口：费用或墙钟即将用完。';
  }
  return window.entering
    ? `进入提交窗口：剩余 ${String(window.remaining)} 轮，${rule}。`
    : `提交窗口：剩余 ${String(window.remaining)} 轮。`;
}

/**
 * 每轮末尾的事实行（AGENT-TARGET.md §ds 实现 RunnerTarget）：轮次、费用、墙钟、当前稿与最近执行 / 看图版本、
 * 窗口通知、no-tool / degenerate 提醒与护栏警告；≤ FACTS_MAX_CHARS，超限先丢警告。
 */
export function formatModelFacts(f: FactsInput): string {
  const lines: string[] = [];
  if (f.event === 'no-tool') lines.push(NO_TOOL_NOTICE);
  if (f.event === 'degenerate') lines.push(DEGENERATE_NOTICE);
  const turnHead =
    f.maxTurns === null
      ? `[第 ${String(f.nextTurn)} 轮｜`
      : `[第 ${String(f.nextTurn)} 轮 / 共 ${String(f.maxTurns)} 轮｜`;
  lines.push(
    `${turnHead}已花 ${yuan(f.spentCny)} / 上限 ${yuan(f.maxCostCny)}｜` +
      `墙钟 ${minutes(f.elapsedMs)} 分 / ${minutes(f.wallMs)} 分]`,
  );
  const draft = f.draftVersion === null ? '当前稿：还没有代码' : `当前稿第 v${String(f.draftVersion)} 版`;
  const check =
    f.lastCheck === null ? '还没有执行' : `最近执行第 v${String(f.lastCheck.version)} 版：${checkText(f.lastCheck)}`;
  const view = f.lastViewVersion === null ? '还没有看图' : `最近看图：第 v${String(f.lastViewVersion)} 版`;
  lines.push(`${draft}；${check}。${view}。`);
  if (f.window !== null) lines.push(windowNotice(f.window, f.hasDraftCode ?? f.draftVersion !== null));
  const base = lines.join('\n');
  const warnings = f.warnings ?? [];
  const withWarnings = (k: number): string => {
    const dropped = warnings.length - k;
    const tail = dropped === 0 ? [] : [`（另有 ${String(dropped)} 条提醒未显示）`];
    return [base, ...warnings.slice(0, k), ...tail].join('\n');
  };
  for (let k = warnings.length; k > 0; k -= 1) {
    const text = withWarnings(k);
    if (text.length <= FACTS_MAX_CHARS) return text;
  }
  return withWarnings(0);
}

/** 约定段 + Model 可见声明全文。数字只来自 limits；改动这段文字即改变 `versions.prompt`。 */
function conventions(limits: RunLimits): string {
  const windowRule = `不能再 write_code 整份写入；仍可用 ${MODEL_WINDOW_TOOLS.join('、')}（可读、可改、可执行、可看图、可提交）`;
  const turnRule =
    limits.maxTurns === null
      ? `- 轮数不限。费用或墙钟快用完时进入提交窗口：${windowRule}。费用或墙钟用完时还没提交，就没有交付。`
      : `- 最后 ${String(limits.submitWindow)} 轮是提交窗口：${windowRule}。轮数、费用或墙钟用完时还没提交，就没有交付。`;
  return `你用 TypeScript 写一段函数建模代码，在隔离进程里执行成模型文档，并通过工具执行、看图、修改、提交。只做粗空间与主要造型：体量、屋面、楼板、连接；墙、座席、逐级台阶等施工细节不做。

## 模型代码
- 入口固定为：export default function build(model: Model): void { … }。同步执行，顶层可以写常量、函数、循环与参数。
- 不能 import、require、declare；没有 Node 与浏览器 API（fetch、process、setTimeout 等都不存在）。console.log 的输出会出现在执行结果里。
- 宿主在 build 返回后自己调用 model.finish() 收文档：**不要在代码里调用 model.finish()**，你只需调用 box / revolve / extrude / surface / bezier 与自己的函数。
- 代码是通用 TypeScript，不是白名单：上面的函数示例只是写法参考，你可以自由声明任意同步函数（幂函数、反比例、贝塞尔组合、分段、循环生成等）。
- 类型预检按严格 TypeScript 检查（strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes）：数组 / 元组下标可能是 undefined，读之前先判空（如 const p = points[i]; if (p === undefined) continue;）；可选属性“没有”与“值为 undefined”要区分，缺省时不要显式写 undefined。

## 坐标与数值
- 建模坐标是有限浮点数（绝对值 ≤ 100000），单位与方块一致：x 向东、y 向上、z 向南。
- 色值为小写 #rrggbb；role ∈ volume|roof|floor|connection；可选 transform：Euler XYZ 弧度，缩放各轴 > 0，缺省单位变换。
- 部件 ≤128，总顶点 ≤200000，总三角 ≤400000；轮廓 / 旋转采样 4–128 段，曲面 u/v 各 4–128 段。

## 可用操作
- model.box({ ...common, size:[x,y,z] })：以局部原点为最小角，尺寸为正。
- model.revolve({ ...common, profile(t)=>[radius,height], profileSegments?, radialSegments? })：绕局部 +y 轴旋转；半径 ≥0，高度沿采样严格递增；首尾可半径 0 收尖，端部不自动封底。
- model.extrude({ ...common, outline:[[x,z],...], height })：简单轮廓（可凹，禁自交）沿 +y 拉伸，闭合顶底。
- model.surface({ ...common, uSegments, vSegments, closedU?, position(u,v)=>[x,y,z] })：参数曲面。position 是任意数学公式，u,v ∈[0,1]；closedU=true 时 u 方向首尾无缝。绕序为增 u × 增 v。想做双重曲面（环向 + 纵向同时变化）、六角或多边形平面、起翘檐口这类非回转体时用它。
- model.bezier([p0,p1,p2,p3], t)：三次贝塞尔采样，用来拼 profile 或轮廓点。

## 函数示例（自定义函数，不限于这些形状）
\`\`\`ts
// 反比例收分屋面：半径随高度递减，可收到尖端。
export default function build(model: Model): void {
  const radius = (t: number): number => (16 * (1 - t)) / (1 + 4 * t);
  const profile = (t: number): [number, number] => [radius(t), 24 * t];
  model.revolve({ id: 'roof', name: '收分曲面屋面', role: 'roof', color: '#8899aa', profile, profileSegments: 32, radialSegments: 48, transform: { translate: [0, 12, 0] } });
}

// 基座 + 用贝塞尔拼出的自由曲面壳。
export default function build(model: Model): void {
  model.box({ id: 'base', name: '基座', role: 'floor', color: '#9a9a9a', size: [30, 1, 20] });
  const shell = (t: number): [number, number] => model.bezier([[0, 0], [6, 0], [12, 4], [18, 7]], t);
  model.revolve({ id: 'shell', name: '自由曲面壳', role: 'roof', color: '#778899', profile: shell, profileSegments: 24, radialSegments: 32 });
}

// 参数曲面：position 里任何公式都行；环向起伏 + 纵向收分同时做。
export default function build(model: Model): void {
  model.surface({
    id: 'canopy', name: '起伏雨棚', role: 'roof', color: '#8899aa',
    uSegments: 96, vSegments: 12, closedU: true,
    position: (u, v) => {
      const a = u * Math.PI * 2;
      const r = 14 + 2 * Math.sin(u * Math.PI * 8);
      return [r * Math.cos(a), 8 * v * v, r * Math.sin(a)];
    },
  });
}
\`\`\`

## 工具
- write_code：整份写入当前稿。
- edit_code：局部修改当前稿。每条 find 必须在当前稿里恰好出现 1 次，按原文逐字匹配；任一条失败则全部不生效。没把握时先 read_code。
- read_code：带行号读当前稿。
- run_model：类型预检 → 隔离执行 → 校验并记录模型文档。执行成功后才能看图或提交。
- view_model：渲染最近一次执行成功的文档，图附在本轮末尾。提交前必须对当前版本成功看过图。本运行没配渲染器时会明确说明没有看图。
- submit_model：提交。只有当前稿已经 run_model 成功、当前版本已成功 view_model、且代码 hash 与文档 hash 一致时才会被接受；接受后固定快照并写完整交付，本轮排在它后面的工具不再执行。

## 轮次
- 每轮你回复一次，可以在一次回复里调用多个工具，按顺序执行。
- 在提交窗口内，可以同一轮先 view_model 再 submit_model：工具按顺序执行，submit 被接受后同轮其余工具不再执行，不必把看图留到下一轮。
- 每轮末尾有一条事实行：轮次、已花费用、墙钟，当前稿与最近执行、看图的版本号。
${turnRule}

## 工作方式
先 write_code 搭出整体形体并 run_model；需要看外观时 view_model，再按图与事实修改（优先 edit_code）；执行成功、看过当前版本并满足题面后 submit_model。

## Model 声明（model.d.ts）
`;
}

/** 完整 system 文本：约定段后接 Model 声明全文（代码块包裹）。 */
export function modelingSystemPrompt(limits: RunLimits): string {
  if (!Number.isSafeInteger(limits.submitWindow) || limits.submitWindow < 1) {
    throw new RangeError(`submitWindow 必须是正整数，实际是 ${String(limits.submitWindow)}`);
  }
  const dts = MODEL_DECLARATION.endsWith('\n') ? MODEL_DECLARATION : `${MODEL_DECLARATION}\n`;
  return `${conventions(limits)}\`\`\`ts\n${dts}\`\`\`\n`;
}

/**
 * 建一个草模 target。每次 create 返回独立会话；初稿从 `input.initialDraft.code` 初始化（事件由 runner 写）。
 * 用户反馈由上层以新 run / 新种子接入，本目标不改写旧历史。
 */
export function createModelingTarget(deps: ModelingTargetDeps): RunnerTarget {
  const versions = deps.versions ?? { modelingApi: 2, modelFormat: MODEL_VERSION };
  return {
    kind: 'modeling',
    factsFormat: MODEL_FACTS_FORMAT,
    tools: MODEL_TOOL_DEFS,
    system: (_input: RunnerInput, limits: RunLimits) => modelingSystemPrompt(limits),
    create: (input, budget) => {
      const state = initialModelState(input.initialDraft?.code);
      const cache = new Map<string, readonly RenderedModelView[]>();
      const toolContext = (ctx: TargetContext): ModelToolContext => ({
        store: ctx.store,
        turn: ctx.turn,
        seed: ctx.seed,
        clock: ctx.clock,
        budget,
        execute: deps.execute,
        cache,
        ...(deps.render === undefined ? {} : { render: deps.render }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      return {
        runTools: (calls, invalid, ctx): Promise<ModelTurn> =>
          runModelToolCalls(calls, invalid, state, toolContext(ctx)),
        formatFacts: (facts) =>
          formatModelFacts({
            ...facts,
            draftVersion: draftVersion(state),
            hasDraftCode: state.draft.code.trim() !== '',
            lastCheck: state.lastCheck,
            lastViewVersion: state.lastViewVersion,
          }),
        deliver: (ctx) => deliverModel(state, { store: ctx.store, turn: ctx.turn, seed: ctx.seed, versions }),
        finish: () => (state.lastOk === null ? {} : { lastModel: state.lastOk.ref }),
      };
    },
  };
}
