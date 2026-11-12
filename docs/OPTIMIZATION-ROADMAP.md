# 下一阶段优化路线（四线合并）

> 状态：**提案，2026-10-21**。未批准实现；具体任务卡在开工前再拆。
> 目标：先让一栋 10×8 单房间茶亭做到“设计、施工、评审说的是同一件事”，再推广到多房子。
> 原则：前置引导优先、硬限制尽量少、离线优先、每条 must 有证据、不静默替用户做选择。
> 依据：`docs/MODEL-CAPABILITIES.md`、`docs/BUILD-SELF-VERIFICATION.md`、R1/R2/R3/R4 调查。

## 0. 四线的关系

| 线               | 修什么                              | 单独做的后果                                   |
| ---------------- | ----------------------------------- | ---------------------------------------------- |
| **1 真相链**     | must / 图纸 / 验收标准一路不丢      | 没有 2/3，真相没有执行者；没有 4，真相无法证明 |
| **2 施工工作台** | 施工队的能力、工具、思考、探视      | 图纸不全，施工队再强也会建错                   |
| **3 设计工作台** | 设计部的 must、语义检查、冲突、标高 | 施工队可能不看图，最后仍不一致                 |
| **4 验收闭环**   | 监理能看见实际建成什么              | 只能事后发现问题，不能提升首轮质量             |

**主线是 1；2/3 是执行者；4 是证据。** 四条都做，但按依赖排，不并行乱改。

## 1. 中央产物：Truth Contract

四线共用同一份“真相”，不再各自维护一套数字：

1. **MustLedger**：全部 must 的 ID、原文、目标值、状态（met / not-met / waived / unverified）、证据。
2. **BuildSheet**：从 BuildSpec 派生的期望对象表，每个对象包含 id、kind、半开 bounds、材质、形式 / 坡度、对应 must IDs；外加基准面（楼板 y0、站立面 y1、门 y1..2、窗 y2..3）和材料 / 层次做法。
3. **ConformanceEvidence**：逐对象 expected / actual / delta，以及每条 must 的证据链接（几何、渲染、检查记录）。

数据流：

```text
用户 brief
  → MustLedger（不截断）
  → DesignIntent / DesignScheme
  → BuildSheet（宿主派生，不手写）
  → 施工 agent（只消费，不重新解释）
  → check_code（逐对象 diff，report-only 起步）
  → 评审（每条 must 有证据）
  → 用户 accept / reject
```

## 2. 阶段与验收

### Phase 0 — 证据与基线（先做，低风险）

目标：让“现在的失败”可以被全新 clone 复现，并且文档与 HEAD 一致。

任务：

- 把 run-9 的最小证据固化进仓库：`build-spec.json`、期望对象表、conformance 报告、archive hash；如果 `.pgar` 体积可接受，也一起提交。
- 给 `object-diff` 补 run-9 回归测试；现有 `design-conformance` 的 run-9 测试保留。
- 把多房子矩阵 / conformance-diff 接进 CI 或独立 `npm run check:conformance`，不让“本地绿、仓库没跑”继续发生。
- 修正文档里的过期数字（Wave 5 时点：2166 单测 / 276 suites + 266 工具测试 / 22 suites，合计 2432，覆盖率 96.83 / 90.27 / 95.63，约 110s；Wave 6 已更新为 2386 + 424 / 2810，96.79 / 90.14 / 95.98）。
- 第三次 live 尝试在 93 轮后被终止，无交付，`build.status` 仍为 running（属已知的限制，不是成功）。
- 执行 `.work/` 清理 A 类 + 旧渲染图；`mc-assets/` 按用户决定保留原位。

验收：

- 全新 clone 跑 `npm run check` + `npm run check:conformance`，能复现 run-9 的 5 个硬失败；
- 文档数字与 HEAD 一致；
- 不改任何生成行为。

### Phase 1 — 真相链（脊柱）

目标：让 must、图纸、验收标准从设计一路传到施工和评审，中途不丢。

任务：

- **1A Must 全量**：设计提示词不再只给前 12 条 must 全文；补 31 条 must 的回归测试，确认家具尺寸 / 位置要求能到达模型。
- **1B BuildSheet**：从 BuildSpec 生成一页期望对象表 + 基准面 + 材料 / 层次做法；随施工任务一起发给构建 agent；把 `design.md` 的“参考材料”改成“已确认合同”。
- **1C 逐对象检查**：`check_code` 复用 `projectExpectedObjects` / `diffObjects`，返回 expected / actual / delta；第一版只报告、不拦截。
- **1D 评审证据**：构建后评审显示每条 must 的证据；没有证据的 must 保持 `unverified`，不再一律硬编码。

验收：

- 离线 replay run-7（设计）和 run-9（施工）；
- run-9 的 5 个硬失败在 `check_code` 阶段就能看到，而不是最后人工审计才发现；
- 不改 live / build。

### Phase 2 — 设计工作台

目标：设计阶段就把“放不下、冲突、标高”解决掉，而不是生成后整单拒绝。

任务：

- **2A 语义方案检查**：run-7 rev1 必须失败（4×1 桌、2 椅、柜台位置、北凳压门洞），rev2 必须通过；检查家具尺寸、门类型、净空、柜台位置。
- **2B 冲突策略**：把“硬失败 / 静默丢缩挪”改成第三条路——明确 warning + 可行动选项；warning 持久化并在页面可见；repair 只做叶子修复，不重新规划。
- **2C 标高口径**：设计契约明确“楼面 y1 / 室外 y0 / 入口齐平”三者关系；默认由宿主给出可行解（抬场地或降楼面），解决不了就报冲突；报告不得再写未解决的“齐平”。
- **2D 需求阶段成本**：需求图改 patch / diff，减少全量重写；raw DesignIntent / repair patch 落盘；失败后不做注定失败的循环 repair。

验收：

- run-7 rev1 离线失败且错误可行动，rev2 通过；
- 没有静默几何修改；
- 设计成本较当前基线下降（目标：requirements + repair 占比从 89.7% 明显下降）。

### Phase 3 — 施工工作台

目标：让施工 agent 有“施工组织设计”、有眼睛、有记忆、有思考，正确的路成为最好走的路。

任务：

- **3A 六阶段手册**：计划 → 地面/围护 → 屋面 → 室内 → 细部 → 自检提交；加一页常用 API 地图和茶亭语义示例；删掉与题面冲突的“入口踏步 / 门槛外放踏步”建议。
- **3B 门禁与语义 API**：修掉“合法 1 格挑檐反而报错”；高层构件路径必须通过；对 `set` / `box` 做围护给出 warning / lint，而不是静默绕过。
- **3C 探针与视角**：新增 `probe(points|box)`（返回最终方块 + 来源调用）、`section` / `interior` 视图；图片只保留每个立面最近 1–2 张，避免 63 张图淹没上下文。
- **3D 选择性 thinking**：至少在计划、检查失败后、提交前开启；补 `reasoning_effort` 协议（当前 schema 只接受 none/low，线上“max”实际是 high）；工具调用轮必须回放 `reasoning_content`，否则 400。
- **3E 计划 / 清单 / 冲突**：新增 `update_plan` / `read_plan`（must IDs、状态、证据）；新增 `report_conflict`；facts 里带计划摘要；`submit` 拒绝未解决冲突和未验证 must。
- **3F 轮次效率**：允许一次调用多个工具；`edit_code` 后自动 `check_code`，目标把 81 轮压到 40 轮以内。

验收：

- 离线 golden 茶亭用 5 个高层调用复现 BuildSpec；
- run-9 回归显示屋面 / 门 / 窗 / 家具问题能在施工中被发现；
- 不改 live / build。

### Phase 4 — 验收闭环

目标：让评审说真话，并且有资格 accept。

任务：

- **4A 修误报**：修正 as-built 的 wall / slab / site 分类（檐口横梁、草地 / 碎石 / 石腰线不要算进墙高 / 楼板）；H1–H4 不能误报。
- **4B 接进施工循环**：先把 diff 接进 `check_code` 做影子 / 证据；多房子矩阵通过后，才评估 blocking 硬门。
- **4C 评审与 accept**：评审面板显示逐对象 / 逐 must 证据；视觉评审接入室内 / 剖切图；建立“谁有权把 must 标 met”的规则。
- **4D CI**：矩阵 + conformance-diff 进 CI；run-9 回归固定。

验收：

- H1–H4 每栋 5/5；run-9 5 个硬失败；好样本 0 误报；
- `npm run check` 包含矩阵 / diff；
- `partial` + 0 defects + 41 unverified 不能再被当成通过。

### Phase 5 — 一次真实端到端

目标：一栋最简单的 10×8 单房间茶亭，从设计到构建到评审完整走通。

约束：

- 一次设计 + 一次构建；预算上限由用户批准；
- 保存 raw intent / calls / repair patch / build trace；
- 失败即停，离线归因，不连续重跑；
- 用户只做最终 accept / reject。

验收：

- 设计 → 确认 → 构建 → 评审全流程走通；
- 每条 must 有证据；
- 设计、报告、实际建成三者一致；
- 用户愿意 accept。

## 3. 指标

| 指标                 | 当前                             | 目标                    |
| -------------------- | -------------------------------- | ----------------------- |
| Must 到达设计模型    | 前 12 条全文 / run-7 共 31 条    | 31/31 全文              |
| Must 到达施工        | 0（BuildSpec 未传）              | 41/41 + 对应坐标        |
| run-9 硬失败发现时机 | 构建后人工审计                   | `check_code` 阶段可见   |
| 施工轮次             | 81                               | < 40                    |
| 施工成本             | 见冻结证据的审计记录             | 不超过用户设定的上限    |
| 设计成本             | requirements 占比偏高            | 明显下降                |
| 评审 must 证据       | 41 条全 unverified               | 每条有证据或明确 waived |
| H1–H4 误报           | 0（但 wall/slab 有已知误报风险） | 0                       |
| 真实端到端           | 未跑通                           | 1 次简单茶亭            |

## 4. 已拍板与待拍板

### 4.1 已拍板（2026-10-21）

- **冲突处理**：冲突持久化 + 用户选择；不静默丢 / 缩 / 挪；影响 must 的冲突在用户选择前阻止确认。
- **Accept 规则**：全部 must `met` 或用户明确 `waived` 才允许 accept；`unverified` 不算通过。
- **阶段顺序**：Phase 0 → 1 → 2/3 → 4 → 5；四条线都做，按依赖排。
- **语义 API**：先 warning / lint，golden + 矩阵通过后才考虑硬拦。
- **硬门**：先 report-only；矩阵 + v2 run-9 稳定后，只拦真缺陷，且需要用户批准。
- **run-9 真相**：保留 v1 历史，修完误报后建 v2 + 缺陷账本；不为保住“5”而保留误报。
- **家具 / 连接**：本轮先不做，避免 schema 膨胀。
- **`check:conformance`**：独立脚本 + CI，不塞进 `npm run check` 第 9 步。
- **室内视角**：该切片把 `packages/render` 临时划给 Build Lead，Verification 复审。

### 4.2 仍需拍板

1. **阶段顺序**：Phase 0 → 1 → 2/3 → 4 → 5；是否批准。
2. **真实运行预算**：设计 / 构建的单次上限与总上限。
3. **质量门槛**：一栋茶亭用户愿意 accept，还是先要求 3 类房子离线通过。
4. **重构范围**：允许改施工提示词 / 工具 / 上下文 / thinking 协议、交互 must 管线；不做全量重写。
5. **硬不变量**：是否接受 R4 的四条（围护来源、基准面、不吞 must 装饰、完成=已验证）。

## 5. 非目标

- 不重写整个交互层或构建层；
- 不先接 submit 硬门再补证据；
- 不为 run-9 的每条缺陷加专用规则；
- 不在离线门禁通过前跑 live / build；
- 不把 `partial` + 0 defects + musts unverified 当通过；
- 不让用户充当施工调试器。
