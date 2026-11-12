# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 开源发布所需的 `LICENSE`（Apache-2.0）、`NOTICE`、`THIRD_PARTY_NOTICES.md`。
- `README.md`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`CHANGELOG.md`。
- GitHub issue / PR 模板、CODEOWNERS、Dependabot、CodeQL 与 dependency-review。

### Changed

- `graphify-out/` 改为本地生成物，不再入库。
- 删除 `docs/mc-visual/official-*.png`（官方纹理衍生图），只保留 fallback 渲染图。
- 删除未被代码引用的 `assets/v02/registry/{tags,entities,palette,meta}.json`，并重建资产清单。
- `.githooks/post-*` 移除机器相关的硬编码 Python 路径。
- 冻结证据中的绝对路径改为 `<repo>` 占位。

### Security

- 已加入 Dependabot、CodeQL 与 dependency-review。
- `zod` 4.6.5 → 4.6.7（GHSA-mrhx-c7xc-m3w5），`puppeteer-core` 25.12.0 → 25.17.0；
  后者把 `chromium-bidi` 带到 157，其 zod 依赖改为 `^4.6.5`，两份 zod 合并为一份。
  `npm audit` 的 high / critical 归零（余下 10 个 moderate 全部来自 ESLint 开发链）。
- 本地交互服务：校验 `Host`（否则 421）、`Origin`（否则 403），并要求写请求使用
  `application/json`（否则 415）——堵掉 DNS rebinding、CSRF 与不经预检的简单请求。
- 本地只读查看器服务补 `Host` 校验（否则 421）。
- 类型预检的编译器宿主改为虚拟文件系统：除 TypeScript 自带的 `lib/*.d.ts` 外，
  任何路径都表现为"文件不存在"，切断「生成代码引用宿主文件 → TS 诊断回显内容 →
  经模型上下文外带」的通道。
- `pre-commit`：修 `.env` 与 `.env.example` 同时暂存时绕过 `.env` 拦截的问题；
  未安装依赖时不再把「找不到 prettier」误报成「格式不对」。

### Removed

- 内部过程文档移出公开树：`RUN-BUDGET` / `INTERACTION-HANDOFF` / `WAVE11-PROMPT-RESET` /
  `PROJECT-METHODOLOGY` / `AGENT-CAPABILITY-GAP` / `PHASE1-TRUTH-CHAIN` /
  `INTERACTION-NEXT-DIRECTION`。`docs/README.md` 改为纯索引，并清理各文档中的
  私有金额、真实 session id 与失效链接。

## [0.3.0-beta.0] - 2026-11-11

### Added

- 设计层：RequirementGraph、DesignIntent、DesignScheme、DesignReport、BuildBrief、SVG 预览与用户确认。
- 构建 agent：单一主循环、护栏中间件、工具集、提示词 v1/v2、成本窗口与审计。
- 体素 / 建模：World API、Model API、PGAR 存档、对象级一致性 diff、构建自证。
- 沙箱：bwrap + Node permission 隔离、类型预检、资源上限、逃逸测试。
- 渲染：Chrome + three.js、fallback 资源、场景缓冲 v2、模型包 PGMP。
- 网页工作台：SSE 进度、设计预览、构建渲染、评审与接受门槛。
- 基准与证据：12 户型 conformance matrix、run-7 / run-9 / live-run 冻结证据、41 条 must 的叶子级证据。

### Known limitations

- live 全链路仍在迭代；生成质量、轮数与费用会波动。
- 沙箱仅支持 Linux（bwrap）。
- 不随仓库分发 Minecraft 官方资源。
