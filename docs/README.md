# 文档索引

> 规则：同一事实只保留一个「当前源」；历史文档归档到 `docs/archive/`，不再从当前主线引用。

## 先读

| 顺序 | 文档                              | 用途                                                        |
| ---- | --------------------------------- | ----------------------------------------------------------- |
| 1    | `docs/ARCHITECTURE.md`            | 分层、包职责、关键流程、质量门禁                            |
| 2    | `docs/INTERACTION-USAGE.md`       | CLI / 网页 / 构建交接怎么用                                 |
| 3    | `docs/DESIGN-INTENT-SPEC.md`      | 设计数据契约：DesignIntent + 宿主展开                       |
| 4    | `docs/DESIGN-REPORT-SPEC.md`      | 设计报告规范                                                |
| 5    | `docs/DESIGN-RULES.md`            | 硬限制与创作自由的边界：只限制安全 / 不可逆 / 技术完整性    |
| 6    | `docs/BUILD-SELF-VERIFICATION.md` | 构建自证：施工骨架 + 通用对象对比（原型，未接 submit 硬门） |
| 7    | `docs/OPTIMIZATION-ROADMAP.md`    | 下一阶段路线与阶段验收（提案，未批准实现）                  |
| 8    | `AGENTS.md`                       | 给 AI 编码代理的项目规则                                    |

## 模型能力

| 文档                    | 状态           | 说明                                                                                        |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `MODEL-CAPABILITIES.md` | **当前事实源** | `deepseek-flash` 官方能力复核：1M 上下文 / 384K 输出 / thinking / 工具 / 缓存 / 价格 / 限制 |

## 交互层

| 文档                                  | 状态         | 说明                                              |
| ------------------------------------- | ------------ | ------------------------------------------------- |
| `BUILD-SELF-VERIFICATION.md`          | 原型未接硬门 | 矩阵 + 对象图 + 通用 diff；run-9 只是冻结 fixture |
| `DESIGN-INTENT-SPEC.md`               | 当前设计契约 | 模型只写 intent，宿主展开为 DesignScheme          |
| `DESIGN-REPORT-SPEC.md`               | 当前规范     | 设计报告章节、深度、验收                          |
| `INTERACTION-USAGE.md`                | 当前使用说明 | CLI / 网页 / 构建交接命令                         |
| `INTERACTION-WEB-DEMO-SPEC.md`        | 当前网页规格 | SSE、工作台、构建进度、下载                       |
| `examples/tea-house-design-report.md` | 示例         | 设计报告目标深度；不是已确认方案                  |
| `examples/design-agent-mock.json`     | 测试 fixture | 离线 mock 剧本                                    |

## Minecraft 官方资源 / 渲染

| 文档                       | 说明                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `MC-ASSETS.md`             | 官方资源导入、来源、哈希、本地目录、合规边界                             |
| `MC-BLOCK-CAPABILITIES.md` | 方块状态、连接 / 支撑 / 用法目录；由 `tools/build-block-catalog.ts` 生成 |
| `mc-visual/`               | fallback 渲染对照截图（官方纹理渲染图只留本机，不入库）                  |

## 归档（历史，不作为当前事实源）

| 文档                                   | 说明                              |
| -------------------------------------- | --------------------------------- |
| `archive/INTERACTION-AGENT-PLAN.md`    | 2026-10-19 交互层方向规划（历史） |
| `archive/INTERACTION-AGENT-ARCHIVE.md` | 2026-10-19 阶段开发存档（历史）   |
| `archive/README.md`                    | 归档原因、替代文档与使用说明      |

## 主链路一句话

```text
用户需求
  → RequirementGraph
  → DesignIntent（模型，小契约）
  → 宿主 normalize / repair / expand
  → DesignScheme + DesignReport + BuildBrief + SVG preview
  → 用户确认
  → 构建（designAuthority=fixed）
  → 构建自证（12 个离线 conformance case；对象图 + 通用 diff）
  → ReviewReport（构建后评审）
  → accept / targeted-revision / redesign
```

`npm run check` 是离线门禁（格式 / 类型 / ESLint / 依赖 / 资产 / 测试配对 / 单测覆盖率 / 工具测试），
`npm run check:conformance` 跑 4 类房子 × 3 种样本的 12 个 case。两条都不联网、不调用模型。
