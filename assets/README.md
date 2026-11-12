# assets：只读导入数据

这里的文件是导入 / 生成产物，**不手改**。每个文件的 sha256 记在 [`MANIFEST.json`](MANIFEST.json)，`npm run check:assets` 会校验。需要更新时重跑对应导入脚本，再执行：

```bash
node tools/assets-manifest.ts --write
```

## 目录

### `mc-1.20.1/`

| 文件 | 来源 | 用途 | 许可 |
| --- | --- | --- | --- |
| `block-states.json` | [minecraft-data](https://github.com/PrismarineJS/minecraft-data) 3.116.0（MIT）`data/pc/1.20/blocks.json`，由 `tools/import-mc-block-states.ts` 提取 | 1003 个方块、24135 个状态的属性合法值与默认值 | MIT |
| `block-capabilities.json` | 由 `tools/build-block-catalog.ts` 生成的事实目录（id、状态、标签、人工用法） | 方块能力 / 连接 / 支撑 / 用法查询 | 项目数据（不含官方贴图 / 模型） |
| `mc-assets.json` | 由 `tools/build-mc-catalog.ts` 生成的导入元数据 | 记录本机导入源的 sha256、文件计数与覆盖率；**不含二进制** | 元数据 |

### `v02/registry/`

| 文件 | 来源 | 用途 | 说明 |
| --- | --- | --- | --- |
| `blocks.json` | v0.2 从 Minecraft 1.20.1 数据整理的方块注册表产物 | 中文名、形态、平均色、家族、用途标签 | 只含功能性事实数据；不含贴图 / 模型 |

> v0.2 的 `tags.json`、`entities.json`、`palette.json`、`meta.json` 当前代码未引用，已从仓库移除；需要时从 v0.2 重新导入。

### `v02/benchmark/`

| 目录 | 来源 | 用途 | 注意 |
| --- | --- | --- | --- |
| `tasks/dev/` | v0.2 benchmark | 6 家族开发题 | 可公开用于开发 |
| `tasks/val/` | v0.2 benchmark | 6 家族验证题 | **已公开，不再作为密封保留集**；引用时请说明 |
| `critical-clauses.json` / `manifest.json` | v0.2 benchmark | 关键条款与题面清单 | 不含密封题正文 |

### `v02/fixture-cells/`

24 个 v0.2 冻结夹具的 PGAR 存档（由 v0.2 冻结引擎执行后写出），用于 `@pg/analysis` 校准。`index.json` 记录来源、格数与 hash。只保留方块名，不含贴图 / 模型。

### `deepseek-v4/`

| 文件 | 来源 | 用途 | 许可 |
| --- | --- | --- | --- |
| `tokenizer.json` / `tokenizer_config.json` | [DeepSeek 官方 tokenizer 压缩包](https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip)（2026-10-02，sha256 见 `source.json`） | 离线 token 计数与提示词预算 | MIT（Copyright (c) 2023 DeepSeek） |

## 红线

- **不要提交** Minecraft client jar、官方贴图、官方模型 JSON，或用官方纹理渲染的截图。
- 官方资源只导入 `.work/mc-assets/`（已 gitignore）；下载必须显式传 `--accept-minecraft-assets`。
- 新资产必须写清来源、许可证与 sha256；不确定能否再分发的数据不要入库。
- 完整第三方声明见 [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
