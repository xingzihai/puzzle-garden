# 用户交互 Agent 开发存档

> **已归档（2026-10-21）**：历史开发存档，不再维护。当前事实源见 `docs/INTERACTION-HANDOFF.md`、`docs/DESIGN-INTENT-SPEC.md`、`docs/BUILD-SELF-VERIFICATION.md`。
> 日期：2026-10-19
> 状态：离线 / mock 闭环已完成；真实模型与真实构建未运行，需 owner 逐批授权。
> 本文是本次开发的**单一总存档**：方向、架构、实现、命令、测试、边界、后续计划都在这里。
> 相关文档：`docs/archive/INTERACTION-AGENT-PLAN.md`、`docs/DESIGN-REPORT-SPEC.md`、`docs/INTERACTION-USAGE.md`、`docs/examples/tea-house-design-report.md`。

## 0. 一句话结论

本次把项目从“单次构建 agent”推进到：

```text
用户原话
  → 需求理解 / 关键提问
  → 建筑方案设计（含完整室内与家具）
  → 设计报告 / 构建题面 / 机器约束
  → 用户确认 / 反馈 / 版本修订
  → 现有构建 agent 按固定方案施工
```

交互层是新增的 `@pg/interaction`（第 4 层），构建仍复用 `@pg/agent` 的 `runRun`，没有重写构建循环。

## 1. 产品方向与边界

### 1.1 已确认方向

- 用户交互 agent 在构建 agent 之前；用户不再直接提供专业题面 / 提示词。
- 交互 agent 以专业建筑设计师身份主动设计，只问会改变布局、功能、体量、风格或可行性的关键问题。
- 设计报告是构建层唯一方案依据；构建层负责施工、构造、局部装饰与实现细节。
- 室内与外观同等重要：空间、楼层、家具、固定家具、灯具、地面材质都要有，不能只做空壳。
- 开发重点转向 1–3 层、占地约 8–30 m、5k–30k 实心方块的中小型精致建筑；巨构降为回归。
- 方块注册表 / 渲染器要支持非立方体、有方向、六面不同的方块。
- 子代理并行开发；主代理负责规格、评审、集成和验收。

### 1.2 首版范围

| 维度     | 范围                                                                                         |
| -------- | -------------------------------------------------------------------------------------------- |
| 建筑类型 | 茶亭 / 咖啡亭、村居 / 山居、街角工作室 / 小书店、小院 / 民宿、社区图书室 / 小展厅            |
| 规模     | 1–3 层；占地约 8–30 m；最高点 ≤ 15 m；5k–30k 实心方块                                        |
| 交付     | 外观 + 入口 + 场地 + 完整室内（主要空间、家具、楼层、固定家具）                              |
| 设计深度 | 带尺寸平面、标高、主要剖面、门窗、楼梯、屋面、材质、立面节奏、家具、灯具、关键细部           |
| 成功标准 | 用户 10 分钟内看懂并确认；构建不偏离主要布局；室内与外观同等质量；一次定向修改保留未点名区域 |

### 1.3 非目标

- 不做大教堂、纪念性巨构、城市级街坊、大型基础设施。
- 不替代施工图、结构计算、消防 / 无障碍 / 规范审查。
- 不做参考图复刻、跨会话长期记忆、多模型对照、任意联网。
- 不为交互层重写构建 runner、沙箱、渲染或分析。

## 2. 最终架构

```text
用户
  → CLI / Web（后续）
  → @pg/interaction（第 4 层）
      需求抽取 / 澄清 / 方案生成 / 设计报告 / 构建简报 / 会话状态
  → @pg/agent 现有 runRun（第 3 层）
      → sandbox / geometry / analysis / render / store
  → 构建交付
```

### 2.1 `@pg/interaction` 模块

| 文件                                         | 职责                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/primitives.ts`                          | id / 文本 / Vec3 / Bounds / 面积 / 颜色等共享 schema                                                                                                    |
| `src/requirements.ts`                        | `RequirementGraph`：需求、空间、场地、约束、偏好、歧义、冲突、缺失、能力、决策                                                                          |
| `src/scheme.ts`                              | `DesignScheme`：meta / 场地 / 楼层 / 空间 / 元素 / 门窗 / 交通 / 结构 / 屋面 / 立面 / 材质 / 细部 / 室内 / 决策 / 未决 / 预算 / 禁项                    |
| `src/scheme-validation.ts`                   | 跨集合校验：id 唯一、引用完整、家具材质 / 范围、屋面高差                                                                                                |
| `src/build.ts`                               | `BuildSpec` / `BuildBrief` / `PromptMeta`，复用现有 gates schema                                                                                        |
| `src/report.ts`                              | `DesignScheme → 中文设计报告`（Markdown）                                                                                                               |
| `src/brief.ts`                               | `DesignScheme → build-task.md / build-spec.json / gates.json / prompt-meta.json`                                                                        |
| `src/lint.ts`                                | 构建前结构 lint：must 覆盖、数字一致、引用、预算、禁项、长度、室内完整性                                                                                |
| `src/session.ts`                             | 纯会话状态机：intake → understand → clarify → design → check → review → revise → confirm → compile → build → post-review → accept / revision / redesign |
| `src/store.ts`                               | `.work/sessions/<id>/session.json` 与 artifacts 的原子写 / 读回                                                                                         |
| `src/capability.ts`                          | 版本化能力卡：World 构件、坐标、七视角、分析口径、限制、默认室内范围                                                                                    |
| `src/prompts.ts`                             | 需求抽取 / 方案设计提示词；定向修订提示词                                                                                                               |
| `src/generate.ts`                            | 用 `@pg/llm` 单工具结构化输出生成 `RequirementGraph` / `DesignScheme`；失败分类                                                                         |
| `src/conversation.ts`                        | 多轮闭环：澄清 / 提问 / 回答 / 方案 / 检查 / 确认 / 修改 / 落盘 / 恢复                                                                                  |
| `src/conversation-support.ts`                | 问题挑选、建议默认值、方案摘要、确认 / lint 反馈解析                                                                                                    |
| `src/example.ts` / `example-requirements.ts` | 稻田茶亭离线样例（含 3 个室内空间 / 10 个家具）                                                                                                         |

### 2.2 构建层改动

| 文件                                                 | 改动                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/agent/src/runner.ts`                       | `RunnerInput.designAuthority?: 'free' \| 'fixed'`                 |
| `packages/agent/src/prompt/system.ts`                | `fixed` 时追加 `## 已确认方案`；`free` / 缺省逐字节不变           |
| `packages/agent/src/voxel-target.ts`                 | 把设计权威传入 system prompt                                      |
| `packages/agent/src/prompt/craft-small.ts`           | 小体量 / 室内 / 家具 / 方向方块提示与三段范例                     |
| `packages/agent/src/cli-args.ts` / `store/events.ts` | 新增 `craft-small` prompt variant，旧 variant 保持兼容            |
| `tools/design-build.ts`                              | 读取 session artifacts，装配现有 `runRun`；`--dry-run` / `--live` |

### 2.3 渲染 / 方块保真

| 文件                                  | 改动                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/render/src/palette.ts`      | 门 / 活板门 / 栅栏门 / 地毯 / 压力板 / 按钮 / 植物 / 告示牌 / 箱子 / 轴向方块映射 |
| `packages/render/src/mesh.ts`         | 新画法几何、方向参数、楼梯 shape 近似、轴向端面明暗；协议保留字节承载 `params[3]` |
| `packages/render/src/scene-buffer.ts` | 调色板写第 8 字节                                                                 |
| 测试                                  | palette / mesh / scene-buffer / page scene 47+ 项                                 |

当前近似边界：

- 门 / 活板门 / 栅栏门 / 地毯 / 压力板 / 按钮 / 植物 / 告示牌 / 箱子已有专用体量，不再统一 8×8×8 小方块。
- 原木 / 木柱 / 竖纹方块有顶 / 底端面明暗近似，不是真正逐面纹理。
- 床、旗帜、潜影盒、雪层、铁轨仍简化。
- 七视角仍没有人眼 / 室内 / 细部近景。

## 3. 核心数据模型

### 3.1 `RequirementGraph`

- `requirements[]`：id / text / quote / source / kind / priority / status / confidence / affects / evidence。
- `spaces[]`：功能空间、数量、面积、层、相邻、采光、隐私。
- `site`：场地尺寸、朝向、坡度、入口、退界、室外分区、周边。
- `constraints[]` / `preferences[]` / `ambiguities[]` / `conflicts[]` / `missing[]` / `capabilities[]` / `decisions[]`。
- 规则：用户原话 / 代理推断 / 默认值 / 用户确认分层；`must` 不能静默删除；代理建议不能自动升级为用户硬要求。

### 3.2 `DesignScheme`

- `meta`：id / revision / title / concept / status / scope / sourceRequirements。
- `site`：场地范围、建筑范围、朝向、入口、室外分区。
- `levels[]` / `spaces[]` / `elements[]` / `openings[]` / `circulation[]`。
- `structure` / `roof` / `facades[]` / `materials[]` / `details[]` / `interiors[]`。
- `interiors[].furnitureSpecs[]`：结构化家具，含 bounds / materialId / orientation / notes。
- `decisions[]` / `open[]` / `budget` / `forbidden`。
- 坐标：x 东、y 上、z 南；整数格；bounds 半开区间。

### 3.3 `BuildBrief`

- `designMarkdown`：用户确认的设计报告。
- `taskMarkdown`：四节构建题面（可被 `extractTaskBody` 解析）。
- `spec`：机器约束（bounds / levels / spaces / openings / routes / counts / budget / forbidden / musts）。
- `gates`：现有 `gatesSchema`。
- `promptMeta`：编译器 / 方案 / 需求 / 能力卡版本、字符数。

## 4. 交互流程

### 4.1 状态机

```text
intake
  → understand（需求抽取）
  → clarify（最多 3 个问题 / 2 轮）
  → design
  → check（结构 lint）
  → review（方案摘要 / 用户确认）
  → revise（反馈 → revision+1）→ check
  → confirm
  → compile（BuildBrief）
  → build（现有 runRun）
  → post-review
  → accept / targeted-revision / redesign
```

### 4.2 提问策略

- 只问会改变布局、功能、体量、风格、可行性的问题。
- 每轮最多 3 个；简单需求可零提问。
- 已解决的问题不重复问。
- 能默认的给建议默认值，第二轮后仍有 open 项时按建议标 `assumed` / `waived`，冲突保留 open。
- 用户说“你决定”记录授权范围，不解释成无限自由。
- 用户改主意时说明受影响的空间 / 尺寸 / 动线 / 外观，生成新 revision，旧版本保留。

### 4.3 定向修订

- `previousScheme` + `feedback` 进入提示词。
- 只改点名或直接受影响的部位；未点名区域保持原样。
- 保留已确认 decisions 与 requirement 引用。
- id 不变，revision +1，旧版本 `superseded`。

## 5. 设计报告规范

详见 `docs/DESIGN-REPORT-SPEC.md`。必备章节：

1. 一页摘要
2. 项目理解与需求
3. 场地分析
4. 设计概念
5. 功能与面积
6. 平面设计
7. 标高与剖面
8. 结构
9. 外观与立面
10. 室内设计
11. 细部设计
12. 场地与景观
13. 建造顺序
14. 验收清单
15. 自由发挥范围与冲突处理
16. 附录：坐标 / 材料 / 参考图

示例：`docs/examples/tea-house-design-report.md`。

## 6. CLI 与使用

### 6.1 交互 agent

```bash
# 离线示例
npm run design:example

# 离线 mock
npm run design:mock

# 多轮：预置回答 / 反馈 / 恢复
node tools/design-agent.ts --live --task benchmark/interaction/s1-tea-pavilion.md \
  --session ses-s1 --answers '["北侧村道","需要柜台","yes"]'

node tools/design-agent.ts --live --task benchmark/interaction/s1-tea-pavilion.md \
  --session ses-s1 --feedback '南侧屋檐再深一点，其他不要动' --answers '["yes"]'

node tools/design-agent.ts --live --resume --session ses-s1 --answers '["yes"]'
```

### 6.2 构建交接

```bash
# 只装配
node tools/design-build.ts --dry-run --session ses-example-tea

# 真实构建（需 owner 授权 + PG_LIVE_CONFIRM=1）
node --env-file=.env tools/design-build.ts --live --session ses-example-tea --max-cny 3.5
```

### 6.3 产物

```text
.work/sessions/<sessionId>/
  session.json
  design.md
  build-task.md
  build-spec.json
  gates.json
  prompt-meta.json
```

## 7. 测试与质量证据

本次最终全量门禁：

- `npm run check`：8/8 通过。
- 单元测试：1921 项 / 269 套件。
- 工具测试：118 项。
- 类型检查、ESLint、Prettier、依赖声明、资产校验、测试配对全部通过。
- `@pg/interaction` 核心 schema / report / brief / conversation 测试；`@pg/render` 新画法测试；`tools/design-agent` / `tools/design-build` 测试。

关键回归：

- 旧 prompt variant（`craft` / `craft2` / `v02hint` / `skeleton` / `detail` / `blueprint` / `refine`）逐字节不变。
- `free` / 缺省设计权威的 system 逐字节不变。
- `craft-small` 三段范例通过真实 `world.d.ts` 预检。
- 构建 dry-run 不读配置、不创建 client、不发请求。
- 未确认 live 返回 2 且不创建 client。
- 声明完整室内但缺室内 / 家具时报 `interior-missing`。

## 8. 本次验收的实际产物

### 8.1 稻田茶亭示例

`.work/sessions/ses-example-check/`：

- design.md 4193 字符；
- 3 个室内空间：喝茶区、柜台、入口玄关；
- 10 个结构化家具；
- 门 2×2、南窗 6×2；
- BuildSpec / gates / prompt-meta 完整。

### 8.2 多轮修订

`.work/sessions/ses-conv-b/`：

- v1 `superseded`；
- v2 `confirmed`；
- 反馈“南侧屋檐再深一点”后 roof.overhang 从 1 → 2；
- brief 绑定 v2。

### 8.3 构建 dry-run

- 读取 4193 字 design.md、4768 字 build-task.md、gates；
- variant `craft-small`；
- `designAuthority: fixed`；
- runId / limits / seed 打印；
- 不读配置 / 不创建 client。

## 9. 已知限制与风险

| 风险 / 缺口  | 现状                                       | 下一步                                     |
| ------------ | ------------------------------------------ | ------------------------------------------ |
| 真实模型能力 | 未跑 live；deepseek-flash 的设计质量未验证 | owner 授权后跑 1 道小样本，记录质量 / 费用 |
| 方案预览     | 目前只有文字报告，没有平面 / 剖面 / 轴测图 | 本次下一步：给交互 agent 加 SVG 草图工具   |
| 室内验收     | 七视角没有人眼 / 室内                      | 补 `eye-*` / `interior` 渲染               |
| 构建结果回写 | 只交接，不评审回写                         | 结果 vs BuildSpec + 看图评审 + 定向修改    |
| Web UI       | 无                                         | 本次下一步：最小网页 demo                  |
| 方块保真     | 门 / 家具已改善，但不是逐面纹理            | 后续纹理 / 逐面颜色 / 更多形状             |
| 结构 / 规范  | 启发式，不是结构计算                       | 报告中明确限制，不冒充执业审查             |
| 跨会话记忆   | 明确不做                                   | 会话独立，显式输入                         |

## 10. 文件清单

### 新增

```text
packages/interaction/package.json
packages/interaction/src/*.ts
tools/design-agent.ts
tools/design-agent-conversation.ts
tools/design-build.ts
benchmark/interaction/README.md
benchmark/interaction/s1-tea-pavilion.md
benchmark/interaction/s2-village-house.md
benchmark/interaction/s3-corner-studio.md
benchmark/interaction/s4-small-courtyard.md
docs/archive/INTERACTION-AGENT-PLAN.md
docs/INTERACTION-USAGE.md
docs/DESIGN-REPORT-SPEC.md
docs/archive/INTERACTION-AGENT-ARCHIVE.md（本文）
docs/examples/tea-house-design-report.md
docs/examples/design-agent-mock.json
packages/agent/src/prompt/craft-small.ts
packages/agent/src/prompt/craft-small.test.ts
packages/agent/src/prompt/craft-small.integration.test.ts
```

### 主要修改

```text
eslint.config.js
package.json / package-lock.json
packages/agent/src/prompt/system.ts
packages/agent/src/prompt/system.test.ts
packages/agent/src/cli-args.ts / cli-args.test.ts
packages/agent/src/runner.ts / voxel-target.ts
packages/store/src/events.ts
packages/render/src/palette.ts / mesh.ts / scene-buffer.ts + tests
tools/agent-massing-args.ts / agent-massing.test.ts
```

## 11. 关键决策记录

1. **交互层独立成包** `@pg/interaction`，不重写构建循环。
2. **设计报告是唯一方案依据**，构建层 `designAuthority=fixed`。
3. **完整室内是默认**，不是可选；`interior-missing` 进 lint。
4. **小体量优先**：craft-small、小建筑试点题库、真实尺度。
5. **旧提示词变体逐字节保留**，避免破坏历史实验基线。
6. **能力卡前置**：不支持 / 部分支持的事项在方案阶段说明，不等到构建失败。
7. **会话独立**：不做跨会话记忆；session 显式保存 / 恢复。
8. **子代理分工**：渲染保真、交互基础、提示词、运行时、闭环、构建交接分别交付，主代理验收。

## 12. 后续计划

### 立即（本次会话）

1. **方案预览工具**：已完成纯 SVG 草图能力：
   - 总平面：`site.svg`；
   - 楼层平面：`plan-<level.id>.svg`；
   - 轴测体量：`axon.svg`；
   - 关键剖面：`section.svg`；
   - 材质板：`materials.svg`；
   - `index.html` 静态画廊。
   - CLI：`npm run design:preview -- --session <id> --out .work/sessions`。
   - 纯函数 / 无外部图片 / 字体 / 网络，可直接浏览器打开。
2. **最小网页 demo**（H 线进行中）：
   - 用户输入 brief；
   - agent 提问 / 用户回答；
   - 显示设计摘要 + 预览图；
   - 确认方案；
   - 可选 live / mock；
   - 规格见 `docs/INTERACTION-WEB-DEMO-SPEC.md`。

### 之后

1. 人眼 / 室内渲染视角。
2. 构建结果评审回写 + 定向修改。
3. 4 道小建筑试点 brief 的离线语义理解评测。
4. owner 授权后跑真实 live 设计 + 真实构建小样本。
5. 再评估 Web UI 的完整体验。

## 13. 复现命令

```bash
# 质量门禁
npm run check

# 离线设计示例
npm run design:example

# 离线 mock 对话
npm run design:mock

# 多轮修订（离线 mock）
node tools/design-agent.ts --mock docs/examples/design-agent-mock.json \
  --session ses-conv-demo --feedback '南侧屋檐再深一点，其他不要动' \
  --answers '["yes"]'

# 方案预览（SVG）
npm run design:preview -- --session ses-example-tea --out .work/sessions

# 构建交接装配
node tools/design-build.ts --dry-run --session ses-example-tea
```

---

**本次没有执行真实模型调用、真实构建、真实 Chrome 截图或网络请求。**
