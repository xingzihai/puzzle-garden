# 用户交互 Agent 使用说明

> 状态：离线 / mock 已跑通；方案预览、网页 demo、构建后评审已实现。41 条 must 会拆成 109 个叶子子句，评审按 clause 给证据并支持逐条 waiver；完整构建自证（施工骨架 / 自动视觉 QA / 有界自修 / submit 硬门）仍未实现。
> 相关：`docs/archive/INTERACTION-AGENT-PLAN.md`（历史规划）、`docs/DESIGN-REPORT-SPEC.md`、`docs/BUILD-SELF-VERIFICATION.md`、`benchmark/interaction/`。

## 1. 它做什么

```text
用户原话
  → 需求抽取（RequirementGraph）
  → 关键问题澄清（最多 3 个 / 2 轮）
  → 建筑方案（DesignScheme：场地、楼层、空间、门窗、结构、屋面、立面、材质、细部、室内、家具）
  → 设计报告 + 构建题面 + BuildSpec + gates + SVG 预览
  → 用户确认 / 反馈 / revision
  → 构建 agent（designAuthority=fixed）
  → ReviewReport（交付 / 检查 / 方块数 / 占地 / 渲染图）
  → 接受结果 / 按评审定向修改
```

交互 agent 不会把用户原话直接丢给构建层，也不会要求用户写结构化题面。

当前构建后评审已有 Wave 6 的 must clause 证据（target-bound，41 musts / 109 leaves）；**完整构建自证（施工骨架 + 自动视觉 QA + 有界自修 + submit 硬门）仍未实现**。因此“构建技术成功”不等于“构建已接受”，详见 `docs/BUILD-SELF-VERIFICATION.md`。

## 2. 离线示例（不调用模型）

```bash
npm run design:example
```

默认写到 `.work/sessions/ses-example-tea/`：

- `design.md`：完整设计报告
- `build-task.md`：四节构建题面
- `build-spec.json`：机器约束
- `gates.json`：现有门槛
- `prompt-meta.json`：版本信息

指定 session / 输出目录：

```bash
node tools/design-agent.ts --example --session ses-demo --out .work/sessions
```

## 3. 离线 mock 对话（不调用模型）

```bash
npm run design:mock
```

或指定剧本：

```bash
node tools/design-agent.ts --mock docs/examples/design-agent-mock.json \
  --session ses-mock --out .work/sessions
```

mock 剧本格式：

```json
{
  "task": "用户原话",
  "requirements": { "RequirementGraph": "..." },
  "scheme": { "DesignScheme": "..." }
}
```

mock 仍走真实的 schema / lint / 报告 / 简报 / session 落盘路径，不绕过校验。

## 4. 多轮澄清 / 修改 / 恢复

### 非交互：按顺序预置回答

```bash
node tools/design-agent.ts --live --task benchmark/interaction/s1-tea-pavilion.md \
  --session ses-s1 --answers '["北侧村道","需要柜台","yes"]'
```

- 字符串数组按提问顺序消费；
- 最后一项通常是确认；
- 数量不足或多出都会报错并返回 2。

### 非交互：按 questionId 回答

```bash
node tools/design-agent.ts --live --task benchmark/interaction/s1-tea-pavilion.md \
  --session ses-s1 \
  --answers '[{"questionId":"amb-entry","answer":"北侧"},{"questionId":"confirm","answer":"yes"}]'
```

保留 id：

- `confirm`：确认方案；
- `feedback`：lint 失败时的修改意见。

### 预置一次修改反馈

```bash
node tools/design-agent.ts --live --task benchmark/interaction/s1-tea-pavilion.md \
  --session ses-s1 --feedback '南侧屋檐再深一点，其他不要动' \
  --answers '["yes"]'
```

流程：v1 → 反馈 → v2（revision+1）→ 确认；旧版本保留为 `superseded`。

### 恢复会话

```bash
node tools/design-agent.ts --live --resume --session ses-s1 --answers '["yes"]'
```

当前支持从 review / confirm / compile 继续确认或修改；更早阶段部分支持。

### 终端交互

不提供 `--answers` / `--feedback` 时，`--live` 会使用 readline 逐条提问：

```bash
node tools/design-agent.ts --live --task benchmark/interaction/s1-tea-pavilion.md --session ses-s1
```

## 5. 真实模型运行的前提

- `.env` 中配置 `PG_LLM_BASE_URL` / `PG_LLM_API_KEY` / `PG_LLM_MODEL=deepseek-flash`；
- `PG_LIVE_CONFIRM=1`；
- `PG_MAX_RUN_COST_CNY` 现在是硬预算：预留不足时请求不会发送，usage 会写入 `.work/live-audit/<label>.jsonl`；
- 真实模型调用仍需你明确设定题目 / 次数 / 单次上限。

## 6. 设计报告 → 构建层

### 只装配，不调用模型

```bash
node tools/design-build.ts --dry-run --session ses-example-tea
```

输出会显示：

- design.md / build-task.md 字符数
- gates
- variant `craft-small`
- `designAuthority: fixed`
- runId / limits / seed

### 真实构建（已跑过一次，未接受）

```bash
node --env-file=.env tools/design-build.ts --live --session ses-example-tea --max-cny 3.5
```

前提：

- `PG_LIVE_CONFIRM=1`；
- 模型在价格表；
- 你明确设定了题目、次数与单次上限；
- 构建会启动真实 Chrome / bwrap / 模型请求。

构建 system 会追加“已确认方案”约定：不得改变主要布局、房间用途 / 数量、外部尺寸、层高、入口、主要屋面 / 主要材质、用户点名细节；可做构造、局部装饰、铺装、灯具与家具细节。

仓库内的 `tools/fixtures/` 保存了若干次真实构建的冻结证据，可离线重放；它们的技术结论是「技术成功、施工审计未通过、构建未接受」，不代表生成质量已经达标。

### 构建后评审（网页）

构建结束后，网页会读取 run 的 `events.jsonl` / `delivery` / 渲染图，生成 `ReviewReport`：

- 客观测量：交付、停止原因、构建检查、方块数、占地、渲染图；
- `musts` 逐条：Wave 6 起由 clause leaf 证据决定 met / not-met / unverified / waived；没有可用证据的旧路径仍保持 `unverified`，不伪报 `met`；
- 缺陷与下一步：accept / targeted-revision / redesign / ask-user；
- 操作：`POST /api/sessions/:id/review-decision`，body `{ action, instructions? }`。

当前看图评审（visual）仍为 `not-reviewed`；run-7 完美基线为 21 met / 20 unverified（20 waivers 才能 accept）；run-9 v2 即使 41 条全部 waiver 仍不能 accept。评审面板不能把 `partial` 显示成通过，也不能在没有完整证据时 accept。

## 7. session 产物

```text
.work/sessions/<sessionId>/
  session.json          # 需求 / 方案版本 / 确认 / brief / 事件
  design.md             # 用户确认的设计报告
  build-task.md         # 四节构建题面
  build-spec.json       # 机器约束（不是第二套事实）
  gates.json            # 现有门槛
  prompt-meta.json      # 版本信息
```

`.work/` 不入库；会话是本地文件，不做跨会话记忆。

## 8. 当前边界

> 冻结证据里的真实构建在技术上跑通了（`tools/fixtures/` 可离线重放），但施工审计发现屋面 / 洞口 / 门 / 家具 / 灯具等缺陷，评审为 `partial`、41 条 must `unverified`，**构建未接受**。当前硬缺口是完整构建自证闭环（施工骨架 / 自动视觉 QA / 有界自修 / submit 硬门）。

已实现：

- 需求抽取、歧义 / 矛盾 / 缺失 / 能力边界；
- 最多 3 个关键问题 / 2 轮澄清；
- 完整 `DesignScheme` 与结构化家具；
- 报告 / 题面 / spec / gates；
- 用户确认、反馈、revision、恢复；
- 构建交接 dry-run 与 fixed authority；
- 方案预览 SVG（总平面 / 楼层平面 / 轴测 / 剖面 / 材质板）；
- 网页 demo（对话 / 提问 / 方案卡 / 预览 / 确认 / 构建进度 / PNG 下载）；
- 构建后评审、接受结果、按评审定向修改 / 重新设计；
- Wave 6 Must Clause Compiler：41 musts → 109 leaves，clause 级证据 / waiver / hard-fail 归属；
- 一次真实构建及 6 张渲染图（技术成功，但未接受）；
- live 预算硬护栏与 usage 审计。

未实现 / 未授权：

- **完整构建自证**：施工骨架、自动视觉 QA、有界自修、submit 硬门仍为方向草案；Wave 6 只完成 must → clause 的测量与评审证据层；这是当前硬缺口；
- 更多 real model `--live` 验收（当前停止；run-7 + revision 已成功，不再自动重试）；
- 更多真实构建 / 第二次构建（run-9 已跑，未接受；当前不重跑）；
- 看图评审（当前 visual 固定 `not-reviewed`）；
- 人眼 / 室内渲染视角（当前固定视角；run-9 为 6 张渲染，仍无法验收室内）；
- 跨会话记忆。

## 9. 推荐下一步

1. 先读 `docs/BUILD-SELF-VERIFICATION.md` 与 `调查记录（不随仓库分发）`，理解“技术成功但施工审计失败”。
2. **真实构建只做 accept-disabled 的诊断跑**，并先用 `PG_MAX_RUN_COST_CNY` 设一个你愿意承担的上限。只诊断，不自动接受。
3. 不要人工逐条修 run-9，也不要自动重跑构建；run-9 继续只作 fixture / 负例。
4. 诊断结果决定 M4 是否有界实现；实现时再跑 `npm run check` 与 `npm run check:conformance`。
5. 离线仍可用 `design:example` / `design:mock` 验证交互流程；截至 2026-10-22 HEAD，全量门禁为 8/8（2386 单测 / 294 suites + 424 工具测试 / 40 suites，合计 2810，覆盖率 96.79% / 90.14% / 95.98%，约 150s）。
6. 复杂多体量先转 fixture，不直接烧 live；B 仍只在几何再次失败时触发。
