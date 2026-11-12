# 用户交互网页 Demo 规格（最小功能测试）

> 状态：离线 / mock 与自动化测试已实现；构建后评审已接线。评审支持 clause 级证据与逐条 waiver（41 条 must 拆成 109 个叶子子句）；完整构建自证（施工骨架 / 自动视觉 QA / 有界自修 / submit 硬门）仍未实现。真实模型调用需 `PG_LIVE_CONFIRM=1`。
> 依赖：`@pg/interaction` 的 conversation / preview / store / schema / review-generate。

## 1. 目标

让使用者在本地浏览器里完整体验：

```text
输入一句需求
  → agent 提问（最多 3 个）
  → 用户回答
  → agent 生成方案
  → 页面显示设计摘要 + 平面 / 总平面 / 轴测 / 剖面 / 材质草图
  → 用户确认或提出修改
  → 确认后写出 session / artifacts
```

不在本 demo 内自动执行真实构建；构建交给 `tools/design-build.ts`，避免网页一键误触发费用。

## 2. 入口

```bash
# 离线 mock（不调用模型；用于 UI / 流程演练）
npm run design:web -- --mock

# 真实模型（需 .env + PG_LIVE_CONFIRM=1 + 显式确认）
npm run design:web -- --live
```

- 只监听 `127.0.0.1`，默认端口 `4174`。
- `--port <n>` 可改端口。
- `--session-root <dir>` 默认 `.work/sessions/web`。
- `--open` 可选：启动后打印 URL，不自动打开浏览器（避免测试环境弹窗）。

## 3. 页面结构

### 3.1 顶栏

- 标题：拼图花园 · 交互设计台
- 模式标签：`mock` / `live`
- 会话 id / 当前阶段
- 清空 / 新会话按钮

### 3.2 左侧：对话

- 消息列表（user / assistant / system）
- 输入框 + 发送
- 当 agent 提问时：
  - 逐条显示问题；
  - 文本回答输入；
  - 提交回答按钮；
  - 支持“交给 agent 默认处理”（如果需求图有 suggestedDefault）。
- 当方案待确认时：
  - 显示“确认方案”“提出修改”“退出”；
  - 修改意见 textarea。

### 3.3 右侧：方案卡 + 预览

- 方案摘要：标题、概念、范围、主要空间、必须项、未决。
- 预览画廊：
  - 总平面 `site.svg`
  - 每层平面 `plan-<level>.svg`
  - 轴测 `axon.svg`
  - 剖面 `section.svg`
  - 材质板 `materials.svg`
- 点击缩略图放大 / 新标签打开。
- 预览下方显示 design.md / build-task.md 字符数、gates 摘要。
- 确认后显示 artifacts 路径与“下一步构建命令”。

### 3.5 右侧：构建后评审

- 构建结束后显示评审面板：
  - 总状态：satisfied / partial / not-satisfied；
  - 客观测量：交付 / 停止原因 / 检查 / 方块数 / 占地 / 渲染图；
  - musts 逐条：met / not-met / unverified；
  - 缺陷：severity / category / description / suggestedAction；
  - 视觉评审：当前 `not-reviewed`；
  - nextAction 说明。
- run-9 真实构建（Wave 5 时点）：`partial`、0 defects、41 musts `unverified`、`visual=not-reviewed`；Wave 6 证据下 run-9 v2 全 41 waiver 仍不能 accept。页面必须如实显示，不能把 `partial` 渲染成通过。
- 操作：
  - “接受结果” → `review-decision {action:'accept'}`；
  - “按评审定向修改” → 预填 nextAction.instructions，提交 `targeted-revision`；
  - “重新设计” → `redesign`；
  - 修改后生成新 revision，回到方案确认流程。
- 当前构建自证与自动视觉 QA 尚未接入；评审面板只做客观测量，不能据此宣称施工一致。
- `reviewError` 非空时显示“评审失败”，不伪造评审内容。

### 3.4 状态

- `idle` / `thinking` / `waiting_answers` / `waiting_decision` / `done` / `error`
- 轮询 `GET /api/sessions/:id` 更新消息、问题、预览 URL、状态。
- 同时用 `GET /api/sessions/:id/stream`（SSE）接收 stage / thinking / content / tool / patch / file / question / error；
  先发快照和最近事件，断线自动重连。连续 9 秒没有事件时页面显示“仍在工作… / 已 N 秒没有新事件”。
- thinking / content 只在页面临时区域展示，不进入消息历史、设计报告或 artifacts。
- 请求中禁用重复提交。

## 4. HTTP API

只接受本地回环；只读静态资源 + JSON API；拒绝路径穿越；请求体上限 1 MiB。

| 方法   | 路径                                | 作用                                                                                                |
| ------ | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET`  | `/`                                 | 页面 HTML                                                                                           |
| `GET`  | `/app.js` / `/style.css`            | 页面静态资源                                                                                        |
| `POST` | `/api/sessions`                     | 创建会话，body `{ brief: string }`；返回 `{ id }`                                                   |
| `GET`  | `/api/sessions/:id`                 | 返回状态 / 消息 / 问题 / 方案摘要 / 预览文件列表 / artifacts                                        |
| `GET`  | `/api/sessions/:id/stream`          | SSE：快照 + 最近进度事件；需 `Accept: text/event-stream`                                            |
| `POST` | `/api/sessions/:id/answers`         | body `{ answers: [{ questionId, answer }] }`                                                        |
| `POST` | `/api/sessions/:id/decision`        | body `{ action: 'confirm' \| 'revise' \| 'exit', feedback?: string }`                               |
| `POST` | `/api/sessions/:id/review-decision` | 构建后评审：body `{ action: 'accept' \| 'targeted-revision' \| 'redesign', instructions?: string }` |
| `GET`  | `/api/sessions/:id/preview/:name`   | 返回 SVG（`image/svg+xml`）                                                                         |

响应：

```json
{
  "id": "ses-web-...",
  "status": "waiting_answers",
  "mode": "mock",
  "messages": [{ "role": "user", "text": "..." }],
  "questions": [{ "id": "amb-entry", "text": "入口在哪一侧？" }],
  "summary": {
    "title": "稻田茶亭",
    "concept": "...",
    "scope": "exterior+interior",
    "rooms": ["喝茶区", "柜台"],
    "musts": ["..."],
    "open": []
  },
  "previews": [{ "name": "site.svg", "title": "总平面", "url": "/api/sessions/.../preview/site.svg" }],
  "artifacts": null,
  "error": null
}
```

## 5. 服务端会话

- `tools/interaction-server.ts`：HTTP + 静态资源 + 会话管理。
- 每个会话在内存里保存：
  - `ConversationIO` 的 pending promise；
  - 消息、问题、方案、预览；
  - 最近 200 条进度事件与 SSE 订阅者；
  - `runDesignConversation` 的 Promise。
- 进度事件只存在内存；thinking / content 是临时展示，不写 `session.json` / artifacts。
- live 默认 `outputMode: 'content-json'` + 最高可用思考档；mock 默认 `tool`，保持离线 fake client 兼容。
- `ConversationIO`：
  - `say(text)` 追加 assistant / system 消息；
  - `ask(question)` / `askQuestion(question)` 保存 pending，返回 Promise；API answer 时 resolve；
  - `confirm` 不实现，统一走 `ask` + 文本解析，便于网页按钮映射。
- 预览：
  - `DesignConversationOptions` 增加 `onScheme` 钩子（或在生成后通过注入 storage 捕获）；
  - scheme 生成后调用 `renderPreviewBundle(scheme)`，把 SVG 存内存 / session/preview；
  - 确认后写 artifacts。
- mock 模式：
  - 用一个本地 mock client 返回 example requirements / scheme（可带 1–2 个问题用于展示）；
  - 不读 env、不联网。
- live 模式：
  - `@pg/config` + `@pg/llm/client`；`PG_LIVE_CONFIRM=1` 才启动；
  - 单次设计调用上限由 config 收紧；错误显示在页面，不吞。
- 不做跨会话记忆；会话目录在 `.work/sessions/web/<id>/`。

## 6. 预览生成

- 调用 G 线 `renderPreviewBundle(scheme)`：
  - `site.svg`
  - `plan-<levelId>.svg` × N
  - `axon.svg`
  - `section.svg`
  - `materials.svg`
  - `index.html`（可选，网页自己渲染画廊）
- SVG 存 session `/preview/`，API 直接读文件或内存。
- 不允许任意文件路径；`name` 只允许 `[a-z0-9_-]+\.svg`。

## 7. 验收

> 当前：mock 流程已有离线测试覆盖；设计层已成功（run-7 + 一次定向修订，revision 2）；Wave 6 must clause 证据已接入评审；真实构建已跑一次，技术成功但施工审计失败、未接受；完整构建自证仍缺失，评审验收仍不通过。

- `npm run design:web -- --mock` 启动，浏览器完成：
  1. 输入 brief；
  2. 看到 agent 问题；
  3. 回答；
  4. 看到方案摘要与至少平面 / 轴测 / 材质预览；
  5. 确认，页面显示 artifacts 路径。
- 真实构建已跑过一次（run-9）：页面能显示评审面板；Wave 6 口径下 run-7 完美基线为 21 met / 20 unverified / 20 waivers，run-9 v2 即使 41 条全部 waiver 仍不能 accept。构建未接受；只有完整构建自证与视觉证据通过后，才谈“评审验收通过”。
- `--live` 未确认时退出 2，不启动服务 / 不创建 client。
- 页面在 1280px 与 800px 宽度可用。
- 不自动执行构建；`design:build` 仍由用户显式运行。
- 不启动真实模型 / 网络用于测试；mock 模式离线。
- 不把 `partial` + 0 defects + musts `unverified` 显示成通过，也不在没有视觉证据时接受构建。

## 8. 未实现（本 demo 不做）

- 登录 / 多用户 / 云端部署；
- 拖拽编辑方案；
- 网页直接构建 / 费用授权（仍需用户点击“开始构建”）；
- **构建自证 / 自动视觉 QA**（当前只有方向草案，未实现；施工阶段不做人工逐条反馈）；
- 看图评审（visual 固定 `not-reviewed`）；
- 室内人眼视角；
- 跨会话记忆；
- 完整移动端适配。
