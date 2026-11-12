# deepseek-flash 模型能力基线

> 状态：**当前事实源（2026-10-21 复核）**。本文只记录 provider 能力与价格，不改变运行时配置、预算、模型选择或代码逻辑。
> 适用模型：`deepseek-flash`（当前服务版本 **DeepSeek-V4.1-Flash-1017**）。
> 复核方式：DeepSeek 官方 API 文档 / 定价页 / 更新日志 / 模型卡；OpenCode provider catalog 仅用于对照项目目录，不作为能力上限依据。
>
> **关键更正：官方单轮输出上限是 384K（393,216 tokens），不是 300,000。1M 上下文已由官方文档确认。**
> 本文把“1M / 300K”中的 300K 标为 **USER-PROVIDED，与 OFFICIAL 冲突**；没有用用户口径覆盖官方文档。

## 0. 一页结论

| 能力                       | 值                                                                                             | 置信度                   | 来源                              |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------- |
| 模型 ID                    | `deepseek-flash`                                                                               | 高                       | OFFICIAL 定价页 / Chat API        |
| 当前服务版本               | `DeepSeek-V4.1-Flash-1017`（2026-10-17）                                                       | 高                       | OFFICIAL 定价页 / 更新日志        |
| 旧别名                     | `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍被接受，但已下线并路由到 V4.1-Flash-1017 | 高                       | OFFICIAL 定价页                   |
| 已停用别名                 | `deepseek-chat`、`deepseek-reasoner` 于 2026-07-24 停止                                        | 高                       | OFFICIAL 更新日志                 |
| 上下文窗口                 | 1M tokens（官方只写 1M；精确整数未公布）                                                       | 高（1M）/ 中（精确边界） | OFFICIAL 定价页 / 模型卡          |
| 单轮最大输出               | **384K = 393,216 tokens**（每次 API completion）                                               | 高                       | OFFICIAL 定价页 / Chat API        |
| 默认输出上限               | 非思考 8K；思考 64K；`reasoning_effort=max` 时 128K                                            | 高                       | OFFICIAL Chat API                 |
| 思考模式                   | 非思考；思考 low / high / max；默认思考开启、默认 high                                         | 高                       | OFFICIAL 定价页 / Thinking Mode   |
| 思考 token 独立上限        | 无独立字段；reasoning tokens 计入 completion，受 `max_tokens` 约束                             | 高                       | OFFICIAL Chat API / Thinking Mode |
| 工具调用                   | 支持 function tools；思考模式也支持；`strict` 为 Beta                                          | 高                       | OFFICIAL 定价页 / Tool Calls      |
| JSON / 结构化输出          | `response_format: {type:"json_object"}`；不是 JSON Schema 约束                                 | 高                       | OFFICIAL JSON Output              |
| 流式                       | 支持 SSE；`stream_options.include_usage` 可在最后一块带 usage                                  | 高                       | OFFICIAL Chat API                 |
| 上下文缓存                 | 默认开启的磁盘前缀缓存；best-effort，按完整前缀单元命中                                        | 高                       | OFFICIAL Context Caching          |
| 视觉 / 多模态              | 支持文本 + 图片输入，文本输出；每图最多约 1,024 tokens                                         | 高                       | OFFICIAL Vision / 定价页          |
| 并发限制                   | `deepseek-flash` 账户级 2,500 并发；未公布 RPM/TPM                                             | 高                       | OFFICIAL Rate Limit               |
| 价格（USD / 1M）           | 空闲：命中 $0.003、未命中 $0.15、输出 $0.60；高峰为 2 倍                                       | 高                       | OFFICIAL Pricing（英文）          |
| 价格（CNY / 1M）           | 空闲：命中 ¥0.02、未命中 ¥1、输出 ¥4；高峰：¥0.04 / ¥2 / ¥8                                    | 高                       | OFFICIAL Pricing（中文）          |
| 可用性 / 过期              | `deepseek-flash` 当前可用；未公布过期日；别名可被 provider 重指向                              | 高                       | OFFICIAL 定价页 / 更新日志        |
| 1M 下的有效长上下文质量    | 官方未给出“有效上下文”保证；不能把 1M 当作可靠工作集                                           | 低 / **UNVERIFIED**      | 无官方量化来源                    |
| 项目目录价格 $0.15 / $0.60 | 对应官方**空闲时段** USD；高峰是 $0.30 / $1.20                                                 | 高                       | PROVIDER CATALOG + OFFICIAL       |

## 1. 模型 ID 与别名

| 名称                           | 状态         | 说明                                                           |
| ------------------------------ | ------------ | -------------------------------------------------------------- |
| `deepseek-flash`               | **当前推荐** | 指向 DeepSeek-V4.1-Flash-1017；项目应继续使用这个 ID。         |
| `deepseek-v4-flash`            | 兼容别名     | 旧模型已下线；请求由 V4.1-Flash-1017 服务，按 Flash 价格计费。 |
| `deepseek-v4-flash-vision-exp` | 兼容别名     | 旧视觉实验模型已下线；同样路由到 V4.1-Flash-1017。             |
| `deepseek-chat`                | **已停用**   | 2026-07-24 起停止；不要再作为非思考模式别名使用。              |
| `deepseek-reasoner`            | **已停用**   | 2026-07-24 起停止；不要再作为思考模式别名使用。                |
| `deepseek-v4-pro`              | 另一条产品线 | 定价页仍列出；不是本项目当前模型，不与 Flash 能力混用。        |

项目 catalog 里的 `deepseek/deepseek-flash` 是 OpenCode 的 provider-qualified 写法；真正发给 DeepSeek API 的 model 字段应是 `deepseek-flash`。

## 2. 上下文、输出与“每轮”的边界

### 2.1 上下文是输入 + 输出的总和

官方 Chat API 明确：**输入 tokens 与生成 tokens 的总长度受模型上下文长度限制**。因此：

```text
prompt_tokens + completion_tokens <= 1M（名义上下文）
```

这不是“1M 输入 + 384K 输出”的两个独立额度。输入越接近 1M，单次还能生成的输出越少。

- 若输入 900K，名义上只剩约 100K 输出空间（若 1M 实为 1,048,576，则约 148K）。
- 若输入 100K，384K 输出上限才有机会完整使用。
- 项目的 900K 停止线 + 40K 施工输出，合计约 940K，仍在 1M 以内；这是它安全的原因。

### 2.2 “384K 输出”是每次 API completion，不是每个 agent turn

`max_tokens` 限制的是**一次 chat completion** 的生成量。一个 agent turn 可能包含多次 tool-call 子请求，每次子请求都可以有自己的 `max_tokens`；所以：

- **单次 API 响应**上限：384K。
- **单个 agent turn** 的总生成量：可以跨多次子请求超过 384K，但每次请求仍受 384K 与总上下文约束。
- 讨论“每轮 300K/384K”时，必须说明是“每次 completion”还是“整个 agent turn”，否则会混淆。

### 2.3 默认输出预算

| 请求模式                          | 未显式设置 `max_tokens` 时的默认值 |
| --------------------------------- | ---------------------------------- |
| 非思考模式                        | 8K                                 |
| 思考模式（默认 high）             | 64K                                |
| 思考模式 + `reasoning_effort=max` | 128K                               |

要使用更大的输出，必须显式设置 `max_tokens`，最大 393,216。即使设置到 384K，实际可用输出仍受 `1M - prompt_tokens` 限制。官方模型卡对**本地推理**建议 `max_tokens >= 256K`；这是部署建议，不是 API 上限，API 上限仍是 393,216。

### 2.4 截断行为

- `finish_reason="length"` 表示达到 `max_tokens`，或对话超过最大上下文。
- JSON Output 在 `finish_reason="length"` 时可能返回**被截断的 JSON**。
- 工具调用的 `arguments` 也可能被截断，必须在客户端解析/校验，不能假设总是完整 JSON。

## 3. 思考模式（Thinking）

### 3.1 可用档位

官方 `reasoning_effort` 接受：

| 请求值             | 实际映射 | 说明                                     |
| ------------------ | -------- | ---------------------------------------- |
| `none`             | 关闭思考 | 等价于 `thinking: {type:"disabled"}`     |
| `low`              | low      | 低思考预算                               |
| `high`             | high     | **默认档**（思考开启但未指定 effort 时） |
| `max`              | max      | 最高档；默认 `max_tokens` 提高到 128K    |
| `minimal`          | low      | 兼容别名                                 |
| `medium` / `xhigh` | high     | 兼容别名                                 |
| `ultra`            | max      | 兼容别名                                 |

也可以用 `thinking: {type:"enabled"|"disabled"}` 开关；思考模式默认开启，默认 effort 为 `high`。

### 3.2 思考 token 上限

官方没有单独的 “max reasoning tokens” 字段。实际约束是：

```text
reasoning_content + content <= max_tokens <= 384K
prompt_tokens + reasoning_content + content <= 1M
```

- reasoning tokens 在响应的 `completion_tokens_details.reasoning_tokens` 中报告，计入 completion。
- 默认 64K / 128K 是**默认 `max_tokens`**，不是独立的 reasoning 上限。
- 要更长的思考，显式提高 `max_tokens`；但输入很大时，总上下文会先成为瓶颈。

### 3.3 思考模式的参数限制

- `temperature`、`presence_penalty`、`frequency_penalty` 在思考模式下无效（不报错，但被忽略）。
- `deepseek-flash` 的 `top_p` 只在思考模式生效，有效范围 0.95–1.0；低于 0.95 按 0.95 处理。非思考模式固定 1.0，传入值被忽略。
- `tool_choice: "required"` 和指定具体工具的 named tool choice **在思考模式下不支持**，会返回 400；需要先关闭思考。
- 带 `tools` 的请求，历史中的 `reasoning_content` 必须完整回传；否则 400。见 §4.2。

## 4. 工具调用、JSON、流式、缓存、视觉

### 4.1 工具调用

- 支持 OpenAI 风格的 `tools` / `tool_calls`，只支持 `type: "function"`。
- 思考模式和非思考模式都支持工具调用。
- `strict` 模式是 **Beta**：需要 `base_url="https://api.deepseek.com/beta"`，且所有 function 设 `strict: true`；服务端会校验 JSON Schema。
- `strict` 模式不支持部分 JSON Schema 关键字：`minLength`、`maxLength`、`minItems`、`maxItems`；所有 object 属性必须 required，且 `additionalProperties: false`。项目当前工具 schema 使用数组 `min/max` 和字符串 `max`；若将来启用 strict，需要先改写这些约束。
- 官方明确警告：模型**不总是生成合法 JSON**，也可能编造 schema 未定义的参数；客户端必须校验后再执行。
- Chat Completions 不支持在对话中间插入客户端生成的 tool call；需要该能力时用 Anthropic Messages API 或 Responses API。

### 4.2 思考 + 工具的历史回传

这是 agent 最容易踩的坑：

- 请求带 `tools` 时，之前所有 assistant 消息的 `reasoning_content` 必须原样回传，并会拼进上下文。
- 即使某一轮没有工具调用，也要回传。
- 不回传会返回 400。
- 请求不带 `tools` 时，`reasoning_content` 不需要回传；即使传了也会被忽略。

项目当前施工循环固定 `thinking: {type:"disabled"}`，所以不会触发这个约束；一旦改为开启思考，必须同时改历史消息重建逻辑。

### 4.3 JSON / 结构化输出

- 只支持 `response_format: {type:"json_object"}`，不是 JSON Schema 约束；字段结构仍要靠 prompt + 客户端校验。
- 必须在 system 或 user prompt 里出现 “json” 并给出示例，否则模型可能输出大量空白直到耗尽 token。
- 官方已知问题：JSON Output **偶尔返回空 content**；需要用校验 / 重试 / repair 兜底。
- `finish_reason="length"` 时 JSON 可能被截断。

### 4.4 流式

- `stream: true` 返回 SSE；以 `data: [DONE]` 结束。
- `stream_options.include_usage: true` 时，最后一个 chunk 带完整 usage；最后一个内容 chunk 的 `choices` 可能为空内容但带 `finish_reason`。
- 服务端可能发送 keep-alive 注释/空行；解析器要容忍。
- 请求发出后若 10 分钟内尚未开始推理，服务端会关闭连接。

### 4.5 上下文缓存

- 磁盘缓存默认对所有用户开启，不需要改代码。
- 命中要求**完整匹配一个 cache prefix unit**；不是任意前缀都能命中。
- 缓存单元在请求边界、公共前缀检测、固定 token 间隔处持久化。
- 缓存是 best-effort，不保证 100% 命中；构建需要数秒，闲置后通常几小时到几天清除。
- 响应中的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 用于计费；项目客户端目前会在字段缺失时直接报错，这是有意的计费保护。
- 对 agent 的含义：稳定 system prompt / 稳定工具定义 / 稳定早期历史能提高命中；频繁改前缀会降低命中率并增加成本。

### 4.6 视觉 / 多模态

- `deepseek-flash` 接受图片 + 文本，输出文本；旧 `deepseek-v4-flash-vision-exp` 也路由到它。
- 支持 JPEG、PNG、GIF、WebP；按文件内容识别格式，不靠扩展名/MIME。
- 每张图片最多约 **1,024 tokens**；多图分别计算。
- 单请求最多 600 张图；请求体上限 48 MiB；单图 base64/外链上限 32 MiB，Files API `file_id` 上限 64 MiB。
- 单边最大 8,192 px；请求含 15 张及以上图片时降为 4,096 px。
- 图片只能放在 `user` 消息；放进 system/assistant 会 400。
- 项目的 `view_building` 已经在使用图片输入；每张图约 1K tokens，长施工循环里要计入上下文和成本。

## 5. 价格、限流、可用性

### 5.1 价格（每 1M tokens）

| 项目               | 空闲 USD | 高峰 USD | 空闲 CNY | 高峰 CNY |
| ------------------ | -------: | -------: | -------: | -------: |
| 输入（缓存命中）   |   $0.003 |   $0.006 |    ¥0.02 |    ¥0.04 |
| 输入（缓存未命中） |    $0.15 |    $0.30 |       ¥1 |       ¥2 |
| 输出               |    $0.60 |    $1.20 |       ¥4 |       ¥8 |

- 高峰时段：UTC 周一至周五 01:00–04:00、06:00–10:00（北京时间 09:00–12:00、14:00–18:00），不含中国法定节假日；其余时间为空闲，空闲价是高峰价的一半。
- 项目 catalog 的 `$0.15 / $0.60` 是**空闲 USD**，不是全天价；高峰会翻倍到 `$0.30 / $1.20`。
- 项目代码 `packages/llm/src/pricing.ts` 使用 CNY 高峰价（缓存命中 ¥0.04、未命中 ¥2、输出 ¥8）记账，和官方中文页一致；这比 catalog 的 off-peak 口径更保守。
- 官方保留调价权；价格页是唯一当前事实源。

### 5.2 限流

- `deepseek-flash` 账户级并发上限：**2,500**；`deepseek-v4-pro` 为 500。
- 并发按账户计算，不按 API key 拆分；超过返回 HTTP 429。
- 官方没有公布 RPM / TPM 数值；不要假设固定的每分钟请求数或 token 数。
- `user_id` 可用于内容安全、KVCache 隔离和调度隔离；高并发配额账户还会按 `user_id` 限流。
- 请求可能在推理开始前排队；10 分钟未开始推理会断开。

### 5.3 可用性与过期

- `deepseek-flash` 当前可用，官方未公布过期日。
- 当前版本是 DeepSeek-V4.1-Flash-1017（2026-10-17 发布）；同一别名未来可能被 provider 重指向新版本。
- 旧别名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍可用但已下线；`deepseek-chat` / `deepseek-reasoner` 已停用。
- 需要可复现性时，记录响应中的 `system_fingerprint` 和请求 hash；项目已经在 run 记录中保存这些信息。

## 6. 长上下文 / 长任务开发的已知限制

以下按“官方明确”与“未验证”分开。

### 6.1 官方明确的限制

1. **上下文是输入+输出总和**：1M 不是纯输入额度；大 prompt 会挤压输出空间。
2. **默认输出可能被静默限制**：不设 `max_tokens` 时，思考模式默认 64K，max effort 也只有 128K；长文件/长 JSON 容易截断。
3. **思考+工具必须回传 reasoning_content**：否则 400；很多 agent 框架会丢掉这个字段。
4. **思考模式不能用 required/named tool_choice**：需要强制工具时只能关闭思考。
5. **工具参数不保证合法 JSON**：官方明确要求客户端校验，不能直接 `JSON.parse` 后盲执行。
6. **JSON Output 可能空返回**：官方承认仍在优化；必须有空内容/截断的 fallback。
7. **strict 模式是 Beta 且有 schema 限制**：不是所有 JSON Schema 都能用。
8. **Chat Completions 不支持中途插入 tool call**：复杂 agent 历史编辑要用 Anthropic/Responses API。
9. **缓存是前缀单元 + best-effort**：动态前缀会降低命中率；不能把缓存当强一致或永久存储。
10. **模型别名可变**：`deepseek-flash` 的底层版本可能更新；需要记录 fingerprint/版本。

### 6.2 未验证 / 不应写成事实

- **“1M 上下文下仍能可靠召回/推理”没有官方量化保证**。1M 是容量上限，不等于有效工作集；官方文档没有给出长上下文衰减曲线。项目应把 900K 当作“接近上限的停止线”，而不是“可以随便堆到 900K 的目标”。
- **第三方独立横评未取得**：本次检索时 websearch 不可用，OpenRouter / models.dev 请求超时；除 DeepSeek 官方页面、官方 Hugging Face 模型卡、OpenCode provider catalog 外，没有拿到可引用的独立二次来源。
- **RPM/TPM 未公布**：只有并发限制；任何具体 RPM/TPM 数字都应标为未验证。
- **“300K 输出”来源不明**：当前官方所有相关页面都写 384K；没有找到 300K 的官方依据。可能是旧版本、其他模型或口口相传的数字。

## 7. 对本项目意味着什么

### 7.1 当前配置对照

| 配置                           | 代码位置                                               |                当前值 |               相对官方上限 | 判断                                         |
| ------------------------------ | ------------------------------------------------------ | --------------------: | -------------------------: | -------------------------------------------- |
| 上下文停止线                   | `packages/agent/src/guards/context.ts:9-10`            |               900,000 |         名义 1M 的 86%–90% | 保守，且接近上限；不是浪费                   |
| 施工单轮输出                   | `packages/llm/src/cost.ts:89-90`                       |                40,000 |              384K 的 10.2% | 成本/质量取舍，不是模型瓶颈                  |
| 施工 thinking                  | `packages/agent/src/runner.ts:305-312`                 |            `disabled` | 模型支持 none/low/high/max | **刻意关闭**，不是能力限制                   |
| 交互 intent                    | `packages/interaction/src/generate-intent.ts:59-65`    |                32,768 |                       8.3% | 保守；历史上 8K 会截断                       |
| 交互 narrative                 | 同上                                                   |                 4,096 |                       1.0% | 只写 8–15 行，足够                           |
| content-json 最低              | 同上                                                   |                16,384 |                       4.2% | 保守                                         |
| requirements / scheme          | `packages/interaction/src/generate.ts:58-61`           |                32,768 |                       8.3% | 保守                                         |
| repair                         | `packages/interaction/src/repair.ts:17-18`             |                32,768 |                       8.3% | 保守                                         |
| 请求 schema `max_tokens`       | `packages/llm/src/schema.ts:88`                        |               393,216 |                   **100%** | 与官方上限一致，不是“高于基线”               |
| 请求 schema `reasoning_effort` | `packages/llm/src/schema.ts:89`                        |       仅 `none / low` |           官方支持到 `max` | **真实限制**：当前代码表达不了 high/max      |
| 交互 thinking 线上值           | `packages/interaction/src/generate-content.ts:226-229` | 只发 enabled/disabled |    未发 `reasoning_effort` | 内部写 `max` 时，线上仍是 provider 默认 high |
| 项目 catalog 价格              | OpenCode provider catalog                              |         $0.15 / $0.60 |                 官方空闲价 | 只覆盖 off-peak；高峰翻倍                    |

### 7.2 哪些是“保守”，哪些是“真差距”

**保守配置（不需要因为这份文档就改）：**

- 900K 上下文停止线：在名义 1M 的 86%–90%，已经接近上限；再往上加只会增加截断/超限风险。
- 40K 施工输出、32K 交互输出、4K 叙事、16K content-json：都远低于 384K，但这是成本、延迟、输出质量的取舍；现有 run 没有证明 40K 是瓶颈。
- 300K 用户基线：本身比官方 384K 更保守；但它是**错误口径**，不应继续作为“模型上限”写进文档。
- 请求 schema 的 393,216：正好等于官方上限，说明 schema 早就按 384K 设计；真正被限制的是上层的 40K/32K 预算。

**真实差距（与模型能力无关，属于项目表达/使用方式）：**

1. **思考档位没有真正用起来**：施工固定 disabled；交互只发 `thinking: enabled`，没有发 `reasoning_effort`，所以即使内部写 `max`，provider 仍按默认 `high` 处理。若项目需要 max 档，当前 schema 也不允许（只接受 `none/low`）。
2. **catalog 价格只写 off-peak**：$0.15/$0.60 是空闲价；高峰 $0.30/$1.20。若用 catalog 做预算，会低估最多 2 倍。项目代码用 CNY 高峰价记账，实际预算口径是保守的。
3. **长上下文质量没有项目内证据**：900K 是“能放进去”，不是“能可靠推理”。当前没有长上下文 eval；这是证据差距，不是模型参数差距。
4. **工具可靠性需要客户端兜底**：官方明确说 tool arguments 可能非法/幻觉参数；项目的 schema 校验是必要的，不应因为模型“应该会”而放松。
5. **JSON 空返回/截断需要 fallback**：官方承认 JSON Output 偶尔空 content；项目的 repair/重试路径是必要的。

### 7.3 建议的阅读方式

- 把本文当作“能力上限与 provider 约束”的唯一当前源；项目侧的配置对照放在本文件末尾，不重复官方细节。
- 任何“把 40K 拉到 384K”“把 900K 拉到 1M”“把 thinking 开到 max”的提议，都应先在离线 eval 上比较首轮质量、轮次、截断率和成本，再决定；不要直接改运行时。
- 任何“1M 上下文所以可以无限堆历史”的推论都不成立；有效上下文质量未验证，且输入会挤压输出。

## 8. 未验证 / 冲突清单

| 项目                                             | 状态              | 说明                                                                                                |
| ------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------- |
| 单轮输出 300,000                                 | **冲突 / 不采信** | USER-PROVIDED；OFFICIAL 定价页与 Chat API 都写 384K（393,216）。                                    |
| 上下文精确整数 1,000,000                         | **未完全确认**    | OFFICIAL 只写 1M；若按 384K=393,216 的二进制 K 推，可能是 1,048,576。项目 900K 在两种解释下都安全。 |
| 1M 下有效召回/推理质量                           | **UNVERIFIED**    | 无官方量化；不要写成“1M 可用工作集”。                                                               |
| RPM / TPM 具体数值                               | **UNVERIFIED**    | 官方只公布并发 2,500；没有 RPM/TPM 表。                                                             |
| 独立第三方横评                                   | **未取得**        | websearch 不可用；OpenRouter / models.dev 超时。本文没有把社区数字当事实。                          |
| “300K”是否来自旧版本/其他模型                    | **UNVERIFIED**    | 没有找到官方来源；不做推测。                                                                        |
| 项目内部 `thinking: 'max'` 是否真的发到 provider | **已核实：没有**  | `requestBase` 只序列化 `thinking: enabled/disabled`，没有 `reasoning_effort`；provider 默认 high。  |
| 模型别名未来是否重指向                           | **已知风险**      | 官方保留更新权；用 `system_fingerprint` / 请求 hash 做可复现记录。                                  |

## 9. 来源

访问日期均为 **2026-10-21**（除非另有说明）。

| #   | 来源                                                 | 类型                           | URL                                                                                                                                                                                                   | 用途                                                              |
| --- | ---------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | DeepSeek Models & Pricing（英文）                    | OFFICIAL                       | https://api-docs.deepseek.com/quick_start/pricing/                                                                                                                                                    | 1M / 384K / thinking / tools / vision / USD 价格 / 并发           |
| 2   | DeepSeek 模型 & 价格（中文）                         | OFFICIAL                       | https://api-docs.deepseek.com/zh-cn/quick_start/pricing/                                                                                                                                              | CNY 价格 / 高峰时段                                               |
| 3   | DeepSeek Chat Completions API                        | OFFICIAL                       | https://api-docs.deepseek.com/api/create-chat-completion                                                                                                                                              | `max_tokens` 上限与默认值 / thinking / tools / JSON / usage       |
| 4   | DeepSeek Thinking Mode                               | OFFICIAL                       | https://api-docs.deepseek.com/guides/thinking_mode                                                                                                                                                    | effort 档位 / reasoning_content 回传 / 参数限制                   |
| 5   | DeepSeek Tool Calls                                  | OFFICIAL                       | https://api-docs.deepseek.com/guides/tool_calls                                                                                                                                                       | function tools / strict Beta / 中途插入限制                       |
| 6   | DeepSeek JSON Output                                 | OFFICIAL                       | https://api-docs.deepseek.com/guides/json_mode                                                                                                                                                        | json_object / 空返回 / 截断                                       |
| 7   | DeepSeek Context Caching                             | OFFICIAL                       | https://api-docs.deepseek.com/guides/kv_cache                                                                                                                                                         | 前缀缓存 / 命中规则 / best-effort                                 |
| 8   | DeepSeek Vision                                      | OFFICIAL                       | https://api-docs.deepseek.com/guides/vision                                                                                                                                                           | 图片格式 / 1,024 tokens/图 / 请求限制                             |
| 9   | DeepSeek Lists Models                                | OFFICIAL                       | https://api-docs.deepseek.com/api/list-models                                                                                                                                                         | context_window / max_output_tokens / modalities / effort 字段语义 |
| 10  | DeepSeek Rate Limit & Isolation                      | OFFICIAL                       | https://api-docs.deepseek.com/quick_start/rate_limit                                                                                                                                                  | 2,500 并发 / 429 / 10 分钟排队                                    |
| 11  | DeepSeek Change Log                                  | OFFICIAL                       | https://api-docs.deepseek.com/updates                                                                                                                                                                 | V4.1-Flash-1017 / 旧别名停用时间                                  |
| 12  | DeepSeek-V4.1-Flash-1017 Release News                | OFFICIAL                       | https://api-docs.deepseek.com/news/news261017                                                                                                                                                         | 1017 版本 / 发布时间 / 开源模型卡链接                             |
| 13  | DeepSeek-V4.1-Flash-1017 Model Card                  | OFFICIAL（provider-published） | https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017                                                                                                                                           | 1M context / 推荐 sampling / 原生视觉                             |
| 14  | OpenCode provider catalog：`deepseek/deepseek-flash` | PROVIDER CATALOG               | 通过 `tools.opencode.models` 查询，provider `deepseek`，访问 2026-10-21                                                                                                                               | variants `none/low/high/max`；USD $0.15/$0.60；cache read $0.003  |
| 15  | 用户提供的“1M / 300K”基线                            | USER-PROVIDED                  | 无 URL                                                                                                                                                                                                | 仅作为对照；300K 与 OFFICIAL 冲突，不采信                         |
| 16  | 项目代码（当前配置）                                 | REPO                           | `packages/agent/src/guards/context.ts`、`packages/agent/src/runner.ts`、`packages/llm/src/{cost,schema,pricing}.ts`、`packages/interaction/src/{generate,generate-intent,generate-content,repair}.ts` | 900K / 40K / 32K / thinking disabled / 393,216 / CNY 高峰价       |

### 9.1 检索限制

- `websearch` 在本次复核中持续返回错误；无法用搜索引擎做第三方交叉核对。
- `openrouter.ai` 与 `models.dev` 请求超时；没有取得独立 catalog 的 context/output 数字。
- 因此，本文对“1M / 384K”的确认来自 **DeepSeek 官方文档 + 官方模型卡**，不是多源独立验证；这点已如实标注。
