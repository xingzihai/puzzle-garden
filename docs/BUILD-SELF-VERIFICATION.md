# 构建自证（Build Self-Verification）方向草案

> 状态：**方向草案；矩阵 / 对象图 / 通用 diff 已落地，Wave 6 must clause 证据已接入**（2026-10-22）。CONF-NEXT-01/02/03 已完成；施工骨架、自动视觉 QA、有界自修与 submit 硬门仍未锁实现。
> 本文只固定问题判断、原则、通用不变量和边界；不决定具体算法、文件、schema、接口或重试预算。
> 当前实现状态：`design-conformance` 仍是**原型 / 安全网**，只覆盖屋面 + 门窗洞口，**未接 submit 硬门**；`conformance-matrix` 用 4 类房子 × 3 类样本证明它不是只认 run-9；`@pg/analysis/as-built` 已能从 `building.pgar` 提取墙 / 板 / 屋面 / 洞口 / 场地 / 少量家具 / unknown 的事实对象图；通用对象 diff 已落地。Wave 6 把 41 条 must 拆成 109 个 leaf，并把 target-bound 证据接入 shadow / review（run-7 21 met / 20 unverified；run-9 v2 全 41 waiver 不 accept）；施工骨架与自动视觉 QA 尚未实现。
> 相关：`docs/DESIGN-INTENT-SPEC.md`、`docs/OPTIMIZATION-ROADMAP.md`。

## 反过拟合原则 / 不是 bug 清单

**run-9 是 fixture，不是产品需求。** 这栋 10×8 茶亭暴露的阶梯屋面、腰线切窗、门槛高差、家具被楼板覆盖、吊灯悬空等，只能用来检验检查能力，不能逐条变成产品规则。按“发现一个 bug → 加一条检查”做下去，验收员只会认识 run-9，模型也只会学会讨好这套固定检查。

因此本文的原则是：

1. **施工骨架优先于事后检查。** 设计阶段生成确定性的墙体、门窗、屋面、家具骨架；施工 agent 只做局部构造、材质、细节，不重新决定几何。检查是安全网，不替代骨架。
2. **验收用一把通用尺子。** 从设计取期望对象，从施工取实际对象，做同对象对比：存在、尺寸、位置、连接、遮挡、容差。认不出的对象或缺失的证据标 `unverified`；不假通过，也不把“认不出”直接当成缺陷乱报。
3. **对象类别是语义分类，不是产品规则。** 墙、门、窗、屋面、家具、灯具、场地等类别可以复用；相邻窗、门楣、玻璃、地毯之类只是分类和测量中的语义，不应写成 run-9 专用特判。
4. **测试用多房子矩阵。** 不能只测 run-9。用多栋不同尺寸 / 布局的房子、留出样本和生成式测试：正常样本不能误报，故意做错要抓住；只对 run-9 有效的检查不算通过。
5. **现有原型不是生产真理。** `design-conformance` 当前只是原型 / 安全网；在通用对象对比与多房子测试通过前，不接 submit 硬门，也不因为一次构建失败就继续堆特殊规则。

## 0. 一句话

**构建层必须先从 BuildSpec / DesignScheme 派生确定性的施工骨架，再用通用对象对比做施工一致性自检、自修；修不好就失败，不交付。**

人不能再充当“生成版本 → 交付版本”之间的逐条调试器。设计阶段可以有用户反馈；施工阶段不能靠用户逐条指出“屋顶错了、窗被腰线切了、桌子没腿、灯没接上”。

## 0.1 全局路线（2026-10-21）

主线：**让构建层自己证明“按设计建成”，修不好就不交付。** 设计层已经可用，当前瓶颈在构建层。

| 里程碑                  | 内容                                                                                                 | 状态                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| **M1 设计层可用**       | 一句需求 → DesignIntent → DesignScheme → 报告 / 简报 / 预览 → 用户确认                               | 已完成（run-7 + revision 2）      |
| **M2 构建事实可测**     | 多房子矩阵证明检查器不是只认 run-9；as-built 对象图知道“实际建成了什么”                              | 已完成                            |
| **M3 设计与施工可对比** | BuildSpec → 期望对象投影；期望 vs 实际 → 通用 diff；H1–H4 不误报，run-9 能抓住主要缺陷，14×12 不误判 | 已完成（H1–H4 5/5；run-9 5 fail） |
| **M4 自证闭环**         | diff 接进构建循环：先影子 / 证据，再有界自修，最后才做 submit 硬门                                   | 暂停（M4.1 原型备份，未提交）     |
| **M5 施工骨架**         | 设计派生确定性的墙 / 洞口 / 屋面 / 家具骨架；施工只做局部构造和细节，不重新决定几何                  | 未开始                            |
| **M6 真实验收**         | 一次 live 设计 + 一次构建；diff + 视觉证据通过才 accept；再扩类型学和基准                            | 未开始                            |

排序理由：M3 先给一把通用尺子；没有它，M4 的“修”和 M5 的“骨架”都无法验收。M4 先影子后硬门，避免把误报变成交付阻断。M5 不替代 M4，它是从源头减少问题。M3 的内部实现细节（schema / 匹配算法 / 文件拆分）由实现子代理决定，主代理只看里程碑验收。

> **2026-10-21 收尾**：用户明确表示对生成结果不满意，暂停 live / build / M4。交互层 live 仍未跑通一次完整流程；先修交互层可靠性与成本，再恢复 M4/M5。M4.1 影子原型已备份到 `.work/backup/m4.1-shadow/`，未提交。

## 1. 问题：技术成功不等于施工成立

run-7 加上同 session 一次定向设计修订后，设计层已经成立：revision 2 确认，6 个 artifacts 齐全，家具硬偏差已修正。随后真实构建也技术成功：

- 81 turns，25 code versions，19 checks；
- 835 blocks，6 renders；
- `codeVersion 25`，hash `2dc98c594057881307ed6c82ecf423b4`。

但 BUILD-AUDIT 发现了真实施工缺陷（以下是审计事实，不是检查规则清单；通用规则见 §3）：

| 审计发现           | 事实                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| 14×12 不是挑檐     | 14×12 是 y=0 的场地平面；实际墙 10×8、屋面 12×10，overhang=1                           |
| 屋面形式错误       | 实际是 45° 四级阶梯金字塔，spec 是 25° 双坡；没有 gable 三角                           |
| 石腰线切断窗       | y=4 石腰线横穿南窗，4×2 窗被切成两段                                                   |
| 北门不可读、有高差 | 2×3 门洞几何存在，但渲染近实墙；门槛 y=1 vs 室外 y=0，形成 1 格台阶；门高 3m 超 spec   |
| 室内家具不完整     | 仅 8 个坐垫标记，不是 5+5=10；桌腿 0、凳面板缺失、柜台只有台板；y=1 家具被同层楼板覆盖 |
| 吊灯未连接         | 吊灯链在 y=4，y=5 上方为空，未连接到屋面                                               |

构建后评审的结果是 `partial`、0 defects、41 musts `unverified`（Wave 5 时点）。这不是“通过”，而是“客观测量没有覆盖施工一致性，视觉评审也没有接入”；**构建未接受**。如果人要逐条读出这些问题、再写一份精确返工单，这个环节仍然是在调试脚手架，不是在交付产品。

## 2. 原则

1. **事实源是已确认的 BuildSpec / DesignScheme**。施工检查从设计派生，不另写一套手工作方案，也不把 `BuildSpec` 变成第二套事实。
2. **施工骨架优先于事后检查**。设计阶段生成确定性的墙体、门窗、屋面、家具骨架；施工 agent 只做局部构造、材质、细节，不重新决定几何。检查是安全网，不替代骨架。
3. **通用尺子，不做 bug 清单**。同一类不变量（存在、尺寸、位置、连接、遮挡、容差、unknown）对任何房子都适用，不按 run-9 的缺陷逐条加特判。
4. **检查必须自动派生**。同一类设计约束应在每次构建中生成对应检查，而不是每次由人临时列清单。
5. **交付前自检**。构建结束、交付写入之前，先检查设计 vs 构建的一致性，再决定是否允许交付。
6. **有限自修**。发现问题时，构建层可以在有界预算内定位、修复、重新检查、重新渲染；不能无限重试，也不能靠用户给 surgical feedback。
7. **修不好就失败**。超过自修预算仍有硬偏差，构建必须失败并给出可行动的 diff；不能带病交付，不能把 `partial` 当成 `succeeded`。
8. **没有证据不能宣称通过**。客观检查与视觉证据都要有；缺失时保持 `unverified`，不得写成 `met`。
9. **用户只做最终 accept / reject**。用户不负责在中间版本之间逐条告诉 agent 怎么改。

## 3. 通用不变量（不是 bug 清单）

以下定义“任何一次设计 → 施工对比都要问什么”，不按 run-9 的缺陷逐条列规则。具体对象集合由当次设计决定；下面只是不变量类型，不是产品里的特判清单。

### 3.1 对象存在与身份

- 设计中的每个对象，在施工中是否有可对应的实际对象？实际对象能否归因到设计对象或明确的施工辅助物？
- 对应关系按对象类型、设计 ID、空间位置和语义共同建立；不能只靠一个固定坐标或一栋房子的布局。
- 识别不出、证据不足或对象类别不明时标 `unverified`；不静默通过，也不直接判 fail。

### 3.2 尺寸与位置

- 对象的包围盒、footprint、高度、标高、朝向是否与设计值一致，并在声明的容差内？
- 位置以设计坐标系和对象锚点为准，不从渲染像素反推。
- 超容差是硬偏差；无法测量是 `unverified`，不是“差不多通过”。

### 3.3 连接与支撑

- 设计声明的关系是否存在：墙与地、屋面与墙 / 柱、门窗与墙、家具与地、悬挂物与屋面 / 梁？
- 是否存在悬空、未连接、支撑缺失或明显穿插？
- 连接关系应从对象几何和设计声明推导，不针对某一种吊灯或某一件家具写死。

### 3.4 遮挡与可达

- 设计声明的开口、通道、净空和视线，是否被其他对象遮挡？
- 遮挡者可能是腰线、圈梁、楼板、家具、屋面构件等；它们是通用语义类别，不是“腰线规则”“家具规则”。
- 区分完全遮挡、部分遮挡和未遮挡；部分遮挡是否构成偏差，由设计意图和容差决定，不能一概 fail 或一概放过。

### 3.5 容差与分级

- 每个不变量都要有显式容差和硬 / 软分级；容差来自设计、规格或全局默认，不按单次 run 临时调参。
- 不能为了放过 run-9 而放宽容差，也不能为了抓住 run-9 而加零容差特判。
- 偏差报告要给出期望值、实际值、容差、证据来源。

### 3.6 unknown / unverified

- 认不出的对象、缺失的视角、无法建立的对应关系，统一标 `unverified`，并记录原因。
- `unverified` 不算 `met`，也不自动算 fail；它表示“这把尺子现在量不了”。
- 只有所有适用不变量都有证据且通过，才能把该项标为 `met`。

### 3.7 设计 vs 施工 diff

- 同对象对比：从设计取期望对象集合，从施工取实际对象集合，先匹配，再逐字段 diff。
- 输出至少区分：matched + pass、matched + fail、unknown；不要只报一个总数。
- 运行包围盒与设计包络的差异，必须能归因到场地、挑檐、屋面或构件，而不是只写 `not-checked`。
- `note.md` / `delivery.json` 的交付声明也要作为对象核对；声明与实际测量矛盾属于 fail。
- 汇总按硬 / 软分级；硬偏差不因“整体看起来还行”而放过。

## 4. 自动视觉 QA

渲染图是证据，不是装饰。视觉 QA 与几何检查回答同一组通用不变量，不另起一套 bug 清单：

- 渲染视角是否覆盖验收所需的方向（至少能看清入口、主要开口、屋面轮廓、室内家具）？
- 设计声明的对象在图中是否可读：开口是否被遮挡、连接是否成立、主要体量和屋面形式是否与设计一致？
- 可以使用模型视觉，也可以使用确定性的场景 / 几何检查；两者可以互补，结论都要能回指到具体对象和不变量。
- **没有视觉证据不能宣称通过**。如果视觉评审未接入或结论不确定，状态必须是 `unverified` / `not-reviewed`，不能 accept。
- 视觉 QA 的结论要能回指到具体设计项或施工项，不能只给一句“看起来不错”。

当前 run-9 的状态是 6 张渲染图 + `visual=not-reviewed` + 41 musts `unverified`（Wave 5 时点），因此构建不能被视为已验收；这是 fixture 的证据状态，不是检查规则。

## 5. 失败与重试

构建内允许 **bounded self-repair**，概念流程是：

```text
构建
  → 自检（通用对象 diff + 自动视觉 QA）
  → 定位偏差
  → 有界修复
  → 重新检查 / 重新渲染
  → 仍有硬偏差？失败，给出 diff，不交付
  → 通过？交付，等待用户 accept / reject
```

边界：

- 重试次数、费用、时间、可修范围都要有上界；具体数值待实现时决定。
- 修复优先回到设计派生的施工骨架；骨架本身错了，不能让施工 agent 重新即兴决定几何。
- 修复只做局部构造、材质、细节和构建一致性问题，不重新解释用户需求，不擅自改设计。
- 不能靠用户逐条反馈来驱动修复；用户只看到最终交付与 accept / reject。
- 失败要可行动：指出哪一项、期望值、实际值、证据（渲染 / 几何 / 方块），而不是只报“检查失败”。

## 6. 与交互层的边界

- **设计阶段保留用户反馈**：用户可以在方案确认前提出修改，run-7 → revision 2 就是有效的一次定向设计修订。
- **施工阶段不做人工 surgical feedback**：设计确认后，构建层自己检查、自己修；用户不在“生成版本 → 交付版本”之间逐条指挥。
- 用户对最终结果的 accept / reject 仍然是产品动作；reject 之后是重新设计、重新构建还是回到设计层，由后续流程决定，不是让用户写施工返工单。
- 交互层的报告、简报、预览、确认、评审、网页资产继续保留；构建自证的目标是构建层门禁，不是第二套交互流程。当前 `design-conformance` 原型只作为安全网，**未接 submit 硬门**。

## 7. 非目标

- 不在本文写具体算法、检查函数、文件拆分、schema、接口或重试预算。
- 不在本文实现任何东西；本文不是已批准实现，也不是对 run-9 构建的接受。
- 不按 run-9 的缺陷逐条加检查或特判。
- 在通用对象对比 + 多房子测试通过前，不接 submit 硬门。
- 不把人工逐条定向构建修订当成产品能力。
- 不通过放宽 spec、删检查、把硬偏差标成软偏差来让构建“通过”。
- 不替代设计阶段的用户确认，也不替代最终的人工 accept / reject。

## 8. 方向成立的判据

方向是否成立，看通用能力和测试矩阵，不看某一次构建“看起来还行”，也不看检查是否刚好认识 run-9：

1. **骨架确定性**：同一份设计能生成稳定的墙体、门窗、屋面、家具骨架；施工 agent 只做局部构造、材质、细节，不重新决定几何。
2. **通用对象 diff**：从设计取期望对象、从施工取实际对象，能按存在、尺寸、位置、连接、遮挡、容差逐项对比；认不出的标 `unverified`。
3. **多房子矩阵**：至少覆盖多栋不同尺寸 / 布局的房子和留出样本；正常样本不能误报。
4. **生成式负例**：向正常样本注入已知类型的错误（不绑定 run-9 的具体位置），检查要能抓住；只对 run-9 有效的检查不算通过。
5. **unknown 语义稳定**：缺证据、认不出、无法匹配时保持 `unverified`，既不假通过也不乱报。
6. **有界自修**：构建能在有界预算内修掉可修项；修不掉时失败且不交付。
7. **视觉证据**：交付时附带自动视觉 QA 证据；没有证据时保持 `unverified`。
8. **用户只做最终 accept / reject**，不需要逐条写施工修改意见。

run-9 的 BUILD-AUDIT 只是这套矩阵中的一个 fixture / 负例，不是验收范围本身。

## 9. 当前原型状态（2026-10-21 更新）

- `tools/design-conformance.ts` 仍是**原型 / 安全网**：只检查屋面 form / pitch / eave / ridge 和门窗洞口；墙体、楼板、房间、家具、连接、材质角色、footprint / overhang 都不检查。它不是生产真理，**未接 submit 硬门**。
- 新增 `tools/conformance-matrix.ts` + `conformance-matrix-fixtures.ts` + `conformance-matrix-selfcheck.ts`：从零构造 4 类房子（6×5 flat、10×8 gable、8×6 shed、L 形）× good / wrong / unsupported，共 12 个 case。`npm run conformance:matrix` 默认 12 met；`npm run conformance:matrix -- --strict` 也 exit 0。
- 矩阵证明的是：当前检查器对“单段、轴对齐、矩形屋面 + 轴对齐门窗”这个子集是通用的，不是只认 run-9 的 10×8 茶亭。H3 单坡被误判成 gable 是一个与 run-9 无关的通用分类 bug，已按通用逻辑修复（gable 必须两侧都有非零坡且脊线在内部；只有一侧有坡且剖面单调才是 shed）。
- 新增 `@pg/analysis/as-built` 的纯函数 `extractAsBuiltObjects(grid, registry)`：从最终体素网格提取 `wall / slab / roof / opening / site / furniture / unknown` 的事实对象图；半开 bounds、确定性 ID、`assigned + unknown === total` 硬不变量。H1–H4 四栋 fixture 都能提取出 4/4/4/6 段墙、30/80/48/64 个屋面顶格、每栋 2 个洞口、1 块楼板、≥1 块门前 pad，unknown=0。家具第一版只做 bed / storage / shelf。
- 对象图的边界：不做 diff、不做 lighting / table / counter / seat / decor、不做完整 contacts / supports 反向图、不做 occlusion、不做视觉；厚墙 >1、T 形墙交点、合法 4×4 单层小平台（会进 unknown）仍是已知限制；`as-built.ts` 约 1700 行，后续建议按 roof / wall / opening / horizontal / furniture 拆分。它不是验收门，**未接 submit 硬门**。
- 新增 `@pg/analysis/object-diff` + `tools/conformance-expect.ts` + `tools/conformance-diff.ts`：BuildSpec → 期望对象投影（wall / slab / roof / opening），与 as-built 对象图做通用 diff。H1–H4 good 每栋 5 个 expected 全 pass、`blocking=false`、`fullyVerified=true`；run-9 抓住 wall / slab / roof / 北门 / 南窗 5 个 hard fail，14×12 场地只进 `notCompared`。opening 复用 `evaluateOpenings` 的通用期望测量，对象图 opening 只作 context。
- M3 的边界：wall / slab 只比聚合包络 + 单矩形四侧覆盖，H4 内部墙删除 / 楼板内部洞 / 内部 extra partition 不抓；host / connection / 遮挡（除洞口外）未进 diff；extra opening 匹配不是严格一对一；run-9 还没有自动化回归；它仍只是离线报告，**未接 submit 硬门**。
- 矩阵的边界：H4 的 L 形多段屋面仍只报 soft unverified，**不能算“屋面通用”**；fixture 自检覆盖楼板 / 门洞 / 屋面覆盖 / 室外 pad，但 H4 凹角 footprint 和每个 case 的预期 check inventory 仍是后续加固项；矩阵只覆盖几何，不覆盖 provenance（合成 `--spec` 模式）。
- 回归：现有 25 个 `design-conformance` 测试保持原样；新增矩阵测试 21 个、shed 回归 5 个、as-built 25 个、四栋对象图 5 个、object-diff 24 个、diff 集成 17 个；全量 `npm run check` 8/8（截至 2026-10-21 HEAD：2166 单测 / 276 suites + 266 工具测试 / 22 suites，合计 2432，覆盖率 96.83% / 90.27% / 95.63%，约 110s）。
- M3 已完成；M4 自证闭环已暂停：用户对生成结果不满意，交互层 live 仍未跑通。恢复时先把同一份 diff 接进 `check_code` 做影子 / 证据，再有界自修，最后才评估 submit 硬门。`design-conformance` 仍只能做 warning / evidence / 影子模式。
- run-9 只作为 fixture 保留；不要为它的每条缺陷增加专用规则。

一句话：**构建必须自己证明“按设计建成了”，而不是等人来发现它没建成；证明用的是一把通用尺子，不是一张 run-9 的 bug 清单。**

## 10. 任务卡（CONF-NEXT-01/02/03 已完成，04 未实现）

> 顺序执行；全部离线。多房子矩阵和留出样本通过前，不接 submit 硬门，不跑 live / build。

| 卡                         | 目标                                                                                                      | 最小验收                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **CONF-NEXT-01（已完成）** | 多房子矩阵：6×5 flat、10×8 gable、8×6 shed、L 形；每类 good / 故意做错 / 不支持三类样本                   | 正常不误报；故意做错能抓住；不支持标 unverified；测试矩阵可一键跑 |
| **CONF-NEXT-02（已完成）** | 从 `building.pgar` 提取通用 as-built 对象图（墙 / 板 / 屋面 / 洞口 / 家具），材质类别走注册表，不写死房子 | 同一提取器覆盖 4 类样本；未知对象保留为 unknown；有单测           |
| **CONF-NEXT-03（已完成）** | 通用对象 diff：身份、尺寸、位置、连接、遮挡、容差、unknown；期望来自 BuildSpec / DesignScheme             | run-9 仍能抓住已知缺陷；好样本不误报；不新增 run-9 专用规则       |
| **CONF-NEXT-04**           | 施工骨架：墙 / 洞口 / 屋面 / 家具的确定性做法，施工 agent 消费骨架，只做局部细节                          | 同一设计重复构建几何一致；不靠事后检查兜底；离线 golden tests     |

**前三刀结果（2026-10-21）**：CONF-NEXT-01 矩阵 12/12 met，`--strict` exit 0；它没有为 run-9 加规则，反而暴露并修掉了一个与 run-9 无关的单坡分类 bug。CONF-NEXT-02 对象图已完成：H1–H4 四栋都能提取墙 / 板 / 屋面 / 洞口 / 场地，unknown=0；家具第一版只做 bed / storage / shelf。CONF-NEXT-03 通用 diff 已完成：H1–H4 每栋 5 个 expected 全 pass；run-9 抓住 wall / slab / roof / 北门 / 南窗 5 个 hard fail；14×12 只进 notCompared。下一步是 **M4 自证闭环**，不是直接接硬门。详细证据见 `调查记录（不随仓库分发）`、`调查记录（不随仓库分发）`、`调查记录（不随仓库分发）`。

### CONF-NEXT-01 执行记录（2026-10-21）

- 01A 假设地图：确认原型只覆盖 roof + openings，且现有测试大量从 `run9Spec()` 派生；报告 `调查记录（不随仓库分发）`。
- 01B 多房子矩阵：从零构造 4 类房子 × good / wrong / unsupported，新增 `tools/conformance-matrix*` 与 `npm run conformance:matrix`；首轮 11 met / 1 prototype-gap。
- 01B2：修 H3 单坡分类；把 fixture 的楼板 / 门洞 / 室外 pad 改成文档真实口径，新增几何自检；矩阵 12/12。
- 01B3：补 `false-positive` / `false-negative` 语义与退出码，补门洞 / footprint / 屋面覆盖 / pad 自检负例；`--strict` exit 0。
- 01C 两轮独立复审：PASS WITH GAPS，确认矩阵独立于 run-9、没有 codify 当前 bug；残留 H4 凹角自检与 per-case check inventory。
- 门禁（当时快照）：`npm run check` 8/8；2110 单测 + 236 工具测试；覆盖率 96.99% / 90.53% / 95.95%。
- 01 时未做、后来由 02 补上：通用对象图。仍未做：对象 diff / 施工骨架 / submit 硬门 / live / build。

### CONF-NEXT-02 执行记录（2026-10-21）

- 02A 设计：从 `building.pgar` 提取对象图，结构先于语义、洞口从墙面板缺口提取、unknown 保留；报告 `调查记录（不随仓库分发）`。
- 02B 第一刀规格：按独立复审删掉 lighting / table / counter / seat / decor / 完整 contacts / occlusion，只做 wall / slab / roof / opening / site / furniture（bed / storage / shelf）/ unknown；修正 wall 面板规则；报告 `调查记录（不随仓库分发）`。
- 02C 实现：新增 `@pg/analysis/as-built` 纯函数与 `as-built-types.ts`；H1–H4 四栋首轮全部达到结构回归表。
- 02D 修补：抬高小台面不再并进楼板、opening host 按边界接触最多选择、support schema 固定为 `{state, supportedBy?} | null`，补高书架 / 孤立玻璃 / 结构残片测试。
- 02E 修补：小薄台面阈值从 8 提到 16，2×2 / 3×3 / 4×4 单层薄面进 unknown，4×4 两层平台仍 slab；H1–H4 host exact 断言。
- 独立复审：三轮 `PASS WITH GAPS`，无 blocker；确认产品代码没有 H1–H4 / 尺寸 / 材质特判。
- 门禁（当时快照）：`npm run check` 8/8；2135 单测 + 241 工具测试；覆盖率 96.80% / 90.35% / 95.60%。
- 02 时未做、03 已补上：对象 diff。仍未做：施工骨架 / submit 硬门 / live / build；`as-built.ts` 约 1700 行待拆；厚墙 / T 形墙 / 合法单层小平台仍有已知限制。

### CONF-NEXT-03 执行记录（2026-10-21）

- 03A 里程碑实现：新增 `@pg/analysis/object-diff`（中性 expected / diff，纯函数）、`tools/conformance-expect.ts`（BuildSpec → 期望投影）、`tools/conformance-diff.ts`（CLI / loader）；H1–H4 good 首轮 5/5 pass。
- 03B 收口：opening 改用通用 `evaluateOpenings(spec, grid)`，对象图 opening 只作 context；run-9 北门 height 3 vs 2 + threshold 1 格、南窗 geometry +1 / 缺 4 格 / 石腰线遮挡均 fail；14×12 只进 notCompared。
- 03C 复审修补：soft 检查不再升级 hard；CLI 补 extra high-confidence opening；H1–H4 仍 5/5 pass。
- 独立复审：两轮 `PASS WITH GAPS`，无 blocker；确认没有 run-9 特判，expected 投影不依赖 `BuildSpec.elements` 的错误 bounds。
- 门禁（当时快照）：`npm run check` 8/8；2159 单测 + 258 工具测试；覆盖率 96.84% / 90.28% / 95.62%。
- 未做：把 diff 接进构建循环（M4）、施工骨架（M5）、submit 硬门、live / build；wall / slab 仍只比 envelope，H4 内部墙 / 楼板洞、host / connection、run-9 自动化回归留给 M4 前置。

## 11. 通用 as-built 对象图（CONF-NEXT-02，当前事实源）

> 代码：`packages/analysis/src/as-built.ts`；schema：`as-built-types.ts`；测试：`packages/analysis/src/as-built.test.ts` + `tools/conformance-objects.test.ts`；导出：`@pg/analysis/as-built`。

### 11.1 接口

```ts
extractAsBuiltObjects(grid: Grid, registry: BlockRegistry): AsBuiltObjectGraph
```

- 纯函数：只读 `Grid` + `BlockRegistry`，不读文件、不联网、不调用模型。
- 输入是最终体素网格（`readArchive(...).grid` 或同表构造的网格）；registry 必须与网格同表，否则按输入错误处理。
- 输出只回答“实际有什么对象”，不回答“是否符合设计”。

### 11.2 对象与字段

- `kind`: `wall / slab / roof / opening / site / furniture / unknown`。
- 基类：`id / kind / bounds（半开 [min,max)） / cells / footprintCells / materials / samples / confidence / source.calls / clipped / support`。
- `wall`: `axis / plane / lengthCells / heightCells`。
- `slab`: `topY / bottomY / thicknessCells / areaCells`。
- `roof`: `formHint / eaveY / ridgeY / topCells / pitchDegrees / ridgeAxis / ridgeWidth`。
- `opening`: `host / subtype / fill / width / height / depth / voidCells / fillCells / sillY / headY`。
- `site`: `subtype（ground / pad / other） / topY / areaCells`。
- `furniture`: `subtype（bed / storage / shelf）`。
- `unknown`: `reason（no-rule-match / ambiguous-geometry / isolated-fill）`。
- `support`: `{ state: 'grounded'|'supported'|'unsupported'|'unknown', supportedBy?: string[] } | null`；opening 为 `unknown`，site / unknown 为 `null`。
- `id = kind@minX,minY,minZ`；碰撞按固定全序追加 `~2`；所有数组排序，不依赖 Map 迭代顺序。
- 硬不变量：`assignedCells + unknownCells === totalCells`；不成立抛错，不返回半张图。

### 11.3 当前覆盖

- 轴对齐、厚度 1 的墙面板；完整面板形成后再按整块面板高度 / 长度过滤；窗台 / 窗楣保留；拐角格参与两侧面板，只在计数时归属一次。
- 顶部包络 + 向下层壳的屋面；输出 eave / ridge / pitch / ridgeAxis / ridgeWidth，供 03 使用；平屋面只认暴露顶面，坡面做层壳。
- 从墙面板二维缺口提取洞口：玻璃窗、门板、纯空气门洞统一；host 按边界接触最多的墙选择，平局按 wall id 最小。
- 室内 floor / 室外 pad 按建筑 footprint 拆内外；门前 pad → site。
- 家具只做 bed / storage / shelf；抬高单层小薄面（面积 ≤16、抬高 1 格、无墙柱支撑）进 unknown，不假扮楼板。
- 所有未认领非空气格进 unknown；空网格、悬空、贴边界、不同写入顺序都有测试。

### 11.4 已知边界 / 后续

- 对象图本身不做 diff、不接 submit 硬门、不做视觉；`unknown` / `low confidence` 在 M3 diff 中必须映射为 `unverified`，不能写成 `met`。
- 不做 lighting / table / counter / seat / decor；不做完整 contacts / supports 反向图、occlusion、逐对象 tolerance。
- 厚墙 >1、T 形墙交点、合法 4×4 单层小平台（会进 unknown）、非轴对齐 / 幕墙、复杂屋面仍是限制。
- `as-built.ts` 约 1700 行，后续建议按 roof / wall / opening / horizontal / furniture 拆分；拆分时每个非类型源文件要配同名测试（`tools/check-tests.ts`）。
- H1–H4 只覆盖结构 + 洞口 + 场地；家具 / 灯具 / 遮挡 / 连接仍靠独立小网格或后续卡。

### 11.5 验证

```bash
node --test packages/analysis/src/as-built.test.ts
node --test tools/conformance-objects.test.ts
npm run check
```

H1–H4 结果：wall 4/4/4/6、slab 1、roof 1、opening 2、site 1、unknown 0；roof topCells 30/80/48/64；eave/ridge 5/5、5/7、5/7、5/5；pitch 0 / 24.2 / 21.8 / 0；H4 exact 六段墙。对象图是事实，不是验收结论。

## 12. 通用对象 diff（CONF-NEXT-03，当前事实源）

> 代码：`packages/analysis/src/object-diff.ts`；期望投影：`tools/conformance-expect.ts`；CLI：`tools/conformance-diff.ts`；测试：`object-diff.test.ts` + `tools/conformance-diff.test.ts`；导出：`@pg/analysis/object-diff`。

### 12.1 接口

```ts
projectExpectedObjects(spec: BuildSpec): ExpectedObject[]      // tools，BuildSpec → 中性期望
diffObjects(expected, actual, options?): ConformanceDiffReport // analysis，纯函数
```

CLI：

```bash
node tools/conformance-diff.ts \
  --spec <build-spec.json> \
  --archive <building.pgar> \
  --out <report.json>
```

### 12.2 期望投影口径

- 不直接相信 `BuildSpec.elements` 的 bounds；从结构字段派生。
- `wall`：`spec.bounds` 的 x/z；y 从 `level.elevation` 到 `spec.bounds.max[1]`；单层一个 envelope；多层 / 多体量无法可靠投影时标 `unverifiedReason`。
- `slab`：`spec.bounds` 的 x/z；y = `[level.elevation-1, level.elevation)`。
- `roof`：`spec.bounds` x/z 向外扩 `roof.overhang`；y = `[eaveHeight, ridgeHeight+1)`；带 form / pitch / eave / ridge。
- `opening`：直接用 `spec.openings`；window / door 两类；第一版一个 expected opening 聚合成一个 diff item。
- `site / furniture / unknown` 不进入硬比较，只进 `notCompared` 或 context。

### 12.3 匹配与容差

- `wall / slab`：actual 同类聚合成 union 包络；wall 额外检查单矩形四侧覆盖，防止删一整面墙但 bbox 不变。
- `roof`：取实际最大 roof；coarse form（flat↔flat；gable/hip/shed↔pitched；stepped=fail）；pitch ±2°；eave / ridge 0 格。
- `opening`：复用 `tools/design-conformance.ts` 的通用 `evaluateOpenings(spec, grid)`，按期望洞口逐项聚合；对象图 opening 只作 context，避免 low-confidence 合成洞口双重计数。
- 位置 / 尺寸容差 0 格；不按 run-9 临时调参。
- `extra`：未匹配 spec 的高置信 actual opening → `extra/soft`；low / medium 未匹配只进 context。
- soft check（如未声明“无台阶”时的门槛 advisory）保持 soft，不升级 blocking。

### 12.4 当前结果

- H1–H4 good：每栋 5 个 expected（1 wall + 1 slab + 1 roof + 2 openings）全 pass；`blocking=false`；`fullyVerified=true`；site 只进 `notCompared`。
- run-9：`pass 0 / fail 5 / missing 0 / extra 0 / unverified 6 / blocking=true`；wall（y 上界 6 vs 5）、slab（12×12 包络 / y 0..5）、roof（pitch 45 vs 25、eave 6 vs 5、ridge 10 vs 7）、北门（height 3 vs 2、threshold 1 格）、南窗（geometry +1 / 缺 4 格 / 石腰线遮挡）均 fail。
- 14×12 场地：只进 `notCompared.site=1`，不是 building footprint 缺陷。
- 家具 / lighting：不进入硬比较；未识别时只作 soft unverified。

### 12.5 边界 / M4 前置

- wall / slab 只比聚合包络 + 单矩形四侧覆盖；H4 内部墙删除、楼板内部洞、内部 extra partition 不抓。
- host / connection / 遮挡（除洞口外）未进入 diff；extra opening 匹配不是严格一对一。
- run-9 还没有自动化回归；M4 要把它变成固定离线样本，并先以影子 / 证据模式接入构建循环。
- 不是验收门，**未接 submit 硬门**；M4 先影子，再自修，最后才评估硬门。

### 12.6 验证

```bash
node --test packages/analysis/src/object-diff.test.ts
node --test tools/conformance-diff.test.ts
npm run check
```
