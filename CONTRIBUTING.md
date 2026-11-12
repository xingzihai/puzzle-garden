# 贡献指南

感谢你愿意参与拼图花园。这个项目同时包含 **agent 运行时**、**体素 / 几何库**、**渲染**、**基准与证据链**，改动面较大；请先读这份指南，能省掉大部分来回。

## 1. 环境

- Node.js `>=24.19.0 <25`（见 `.nvmrc`；项目直接运行 `.ts`）
- Linux（沙箱依赖 `bwrap`；没有 bwrap 时集成测试会自动 skip，但 live 构建不可用）
- Chrome / Chromium `>=154`（渲染用；默认 `/usr/bin/google-chrome`）
- 可选：Minecraft 1.20.1 client jar（官方资源只导入本机 `.work/`，不入库）

```bash
git clone https://github.com/xingzihai/puzzle-garden.git
cd puzzle-garden
npm ci
```

`npm ci` 会通过 `prepare` 脚本把 `core.hooksPath` 指向 `.githooks/`：

- `pre-commit`：只检查暂存文件（Prettier + ESLint），几秒完成。
- `pre-push`：跑完整离线门禁 + conformance matrix，通常 2–4 分钟。

不想在每次推送前等门禁，可以手动 `git push --no-verify`（CI 仍会检查），但不要在 PR 里长期绕过。

## 2. 提交前必须通过

```bash
npm run check          # 8 项离线门禁：格式 / 类型 / ESLint / 依赖 / 资产 / 测试配对 / 单测覆盖率 / 工具测试
npm run check:conformance
```

要求：

- **CI 必须绿**。PR 只改文档时也至少跑 `npm run format:check`。
- 新增源文件必须有同名 `.test.ts`（`tools/check-tests.ts` 会检查；纯 re-export、纯类型、页面入口等少数例外见脚本）。
- 测试默认禁止真实网络（`tools/test-no-network.ts`）；需要联网的测试放 `*.integration.test.ts`，并确保没有网络时能 skip。
- 不要为了过测试而放宽断言或删除覆盖；证据链 / conformance 的断言是项目的核心资产。

## 3. 代码风格

- Prettier（`printWidth: 120`、单引号、尾逗号、LF）与 ESLint 是硬门禁；提交前跑 `npm run format`。
- 依赖版本必须精确（`save-exact=true`），跨包引用走包名 `@pg/xxx`，不要用相对路径跨出包目录。
- 新增运行时依赖前先想清楚：这个项目刻意保持很小的依赖面；能写清楚的纯函数优先。
- 注释解释“为什么”，不要复述代码；涉及规格时引用 `docs/` 里的章节。

## 4. 资产与证据

- **禁止提交**：Minecraft jar、官方贴图、官方模型 JSON、用官方纹理渲染的截图、任何 `.work/` 运行产物。
- 官方资源只导入到 `.work/mc-assets/`（已 gitignore）；需要下载时必须显式传 `--accept-minecraft-assets`。
- 需要作为判据的证据，整理后放进 `docs/`、`benchmark/` 或 `tools/fixtures/`，并写清来源、sha256 与重放方式。
- `assets/` 下的文件由 `assets/MANIFEST.json` 的 sha256 保护，不要手改；更新时跑对应导入脚本，再执行 `node tools/assets-manifest.ts --write`。
- 新增资产前先读 [`assets/README.md`](assets/README.md) 与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)，确认许可证允许再分发。

## 5. 提交与 PR

- 提交信息用 Conventional Commits 风格，例如：
  - `feat(interaction): 支持评审后定向修订`
  - `fix(agent): 空草稿提示先 write_code`
  - `docs: 补充沙箱威胁模型`
- 一个 PR 尽量只做一件事；大改动请先开 issue 或 Discussion 对齐方向。
- PR 描述里写：改了什么、为什么、怎么验证（命令 / 结果）、有没有费用或兼容性影响。
- 涉及 live 行为的改动，附上 mock / 离线重放结果；不要把“技术成功”写成“构建已接受”。
- 不要提交 `.env`、API key、私有网关地址或运行账本。

## 6. Graphify（可选）

仓库使用 [Graphify](https://github.com/Graphify-Labs/graphify) 维护本地知识图谱：

- `graphify-out/` 是**本地生成物，不入库**；新克隆后需要自己安装 Graphify 并运行 `graphify build .`（或 `graphify update .`）。
- 提交钩子会尝试自动增量更新图谱；没装 Graphify 时会跳过。想彻底跳过可设 `GRAPHIFY_SKIP_HOOK=1`。
- 查询优先用 `graphify query "<问题>"`，详见 [`AGENTS.md`](AGENTS.md)。

## 7. 许可证与贡献授权

- 项目以 **Apache-2.0** 发布。提交 PR 即表示你同意你的贡献以同一许可证授权。
- 不需要签署 CLA；但请确保你有权提交相关代码 / 数据，且没有复制来源不明的第三方代码。
- 新增第三方代码或数据时，同步更新 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 8. 行为与安全

- 参与讨论即表示同意遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
- 安全问题不要开公开 issue，请按 [`SECURITY.md`](SECURITY.md) 的私密渠道报告。

## 9. 有问题？

- 用法问题：开 GitHub Discussion（如果已启用）或 issue，附上 `npm run check` 的结果与最小复现。
- 方向性建议：先开 issue 描述场景与约束，再动手。
