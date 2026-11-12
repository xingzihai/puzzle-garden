# 第三方声明 / Third-Party Notices

本仓库包含以下第三方软件或数据。各组件仍归其原作者所有，并按其原始许可证提供。
本文件不修改 `LICENSE`（Apache-2.0）的条款。

## 运行时依赖（通过 npm 安装，不随源码树直接分发）

| 组件                                                       | 版本    | 许可证     | 版权/来源                              |
| ---------------------------------------------------------- | ------- | ---------- | -------------------------------------- |
| [`three`](https://github.com/mrdoob/three.js)              | 0.186.0 | MIT        | Copyright © 2010-2026 three.js authors |
| [`puppeteer-core`](https://github.com/puppeteer/puppeteer) | 25.17.0 | Apache-2.0 | Copyright 2017 Google Inc.             |
| [`zod`](https://github.com/colinhacks/zod)                 | 4.6.7   | MIT        | Copyright © 2020 Colin Hacks           |
| [`typescript`](https://github.com/microsoft/TypeScript)    | 5.9.3   | Apache-2.0 | Copyright Microsoft Corporation        |

`typescript` 不只是开发工具：`@pg/sandbox` 的类型预检在运行时加载它，因此按运行时依赖列出。

`@huggingface/tokenizers`（Apache-2.0，Copyright Hugging Face）只被仓库内脚本 `tools/tokens.ts` 使用，
列在根 `devDependencies`。其余开发依赖（ESLint、Prettier、fast-check 等）同样通过 npm 安装，许可证随包分发。

## 随仓库分发的数据 / 资产

### DeepSeek-V4.1-Flash tokenizer

- 文件：`assets/deepseek-v4/tokenizer.json`、`assets/deepseek-v4/tokenizer_config.json`
- 来源：<https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip>（2026-10-02 下载，sha256 见 `assets/deepseek-v4/source.json`）
- 许可证：MIT
- 版权：Copyright (c) 2023 DeepSeek
- 上游模型页：<https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash>

### minecraft-data

- 文件：`assets/mc-1.20.1/block-states.json`（由 minecraft-data 3.116.0 提取）
- 来源：<https://github.com/PrismarineJS/minecraft-data>
- 许可证：MIT
- 说明：该数据由 minecraft-data 项目从 Minecraft 公开数据中整理；Minecraft 相关名称与数据归 Mojang 所有。

### Minecraft 1.20.1 方块注册表（衍生事实数据）

- 文件：`assets/v02/registry/blocks.json`
- 内容：方块 id、中文名、形态、平均色、材质族与用途标签；不含贴图、模型或游戏二进制。
- 来源：项目 v0.2 从 Minecraft 1.20.1 数据整理，后迁移到本仓库。
- 说明：仅包含功能性事实数据；Minecraft 名称与商标归 Mojang Synergies AB 所有。

### Graphify（开发工具，随 `.opencode/` 分发）

- 文件：`.opencode/skills/graphify/`、`.opencode/plugins/graphify.js`
- 来源：<https://github.com/Graphify-Labs/graphify>
- 许可证：Apache-2.0
- NOTICE：

```text
Graphify
Copyright 2026 Safi Shamsi and the Graphify contributors.

This product is licensed under the Apache License, Version 2.0 (see LICENSE).

Portions of this software were contributed under the MIT License prior to the
relicensing and remain available under those terms. The original MIT license
text is retained in LICENSE-MIT.
```

> 注意：上游把该 MIT 文本放在上游仓库的 `LICENSE-MIT` 里；本仓库只分发
> `.opencode/skills/graphify/` 与 `.opencode/plugins/graphify.js` 两个文件，没有另行复制那份文本。
> 若你要再分发这些文件，请同时附带上游 `LICENSE` 与 `LICENSE-MIT`。
> 本仓库的构建与测试不依赖这两个文件，删除 `.opencode/` 不影响任何门禁。

## 当前源码树未分发的内容

以下内容**不在本仓库中**，需要用户自行从合法来源获取，并遵守相应许可：

- Minecraft 1.20.1 client jar、官方贴图、官方模型 JSON、官方资源渲染截图。
  导入脚本只把文件写到本机 `.work/`（已 gitignore）；下载需显式传入 `--accept-minecraft-assets`。
- 任何 LLM API key、私有网关地址或运行账本。

## MIT License 文本（适用于上表中的 MIT 组件）

```text
MIT License

Copyright (c) 2023 DeepSeek
Copyright (c) PrismarineJS contributors
Copyright (c) 2010-2026 three.js authors
Copyright (c) 2020 Colin Hacks

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

各 MIT 组件的具体版权行见上表；DeepSeek tokenizer 的版权行为
`Copyright (c) 2023 DeepSeek`，minecraft-data 的版权归其贡献者所有。
