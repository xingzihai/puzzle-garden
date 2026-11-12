# 安全策略

## 支持的版本

| 版本                 | 支持状态        |
| -------------------- | --------------- |
| `0.3.x`（当前 beta） | ✅ 接受安全报告 |
| `< 0.3`              | ❌ 不再维护     |

项目处于 beta，接口与行为可能变化；安全修复会优先进入 `main` 并随下一个 beta 发布。

## 报告漏洞

**请不要开公开 issue。** 使用 GitHub 的私密漏洞报告：

1. 打开 <https://github.com/xingzihai/puzzle-garden/security/advisories/new>
2. 描述问题、影响、复现步骤与受影响版本 / commit
3. 如果可能，附上最小复现仓库或脚本；日志请先**删掉 API key、私有网关地址和个人路径**

也可以在 GitHub 上私信 [@xingzihai](https://github.com/xingzihai)，但私密 advisory 是首选。

我们会在 7 天内尽量确认收到，并在修复可用后协调披露。请在修复发布前避免公开细节。

## 威胁模型

拼图花园会执行 **LLM 生成的 TypeScript 代码**，并在本机启动只读 / 可写工作目录的 HTTP 服务。以下边界属于安全范围：

### 1. 沙箱逃逸（高优先级）

构建代码在 `bwrap` 中执行：

- `--unshare-all`（网络 / PID / IPC / UTS / cgroup 等命名空间）
- `--clearenv`，只保留 `TZ=UTC`
- `--cap-drop ALL`
- 只读挂载 `/usr`、仓库 `packages/`、`node_modules/`、`package.json` 与方块表
- Node `--permission` 只给读权限，禁 code generation、worker、子进程、addon、inspector
- `prlimit --as` 与墙钟 / 内存上限

**边界只有 bwrap。** Node 的 `--permission` 官方说明是"降低误伤"的纵深防御，不承诺抵抗恶意代码；不要把它当成隔离层来信任。

在进入沙箱之前还有一道类型预检（`packages/sandbox/src/worker-core.ts`）：编译器宿主是**虚拟文件系统**，除 TypeScript 自带的 `lib/*.d.ts` 外任何路径都表现为"文件不存在"。否则生成代码可以用 `/// <reference path>` 或 `import` 读取宿主文件，再借 TS 诊断把内容（字面量类型等）回显进模型上下文——那是一条完整的本地文件外带通道。

如果你能证明生成代码可以读写沙箱外文件、访问网络、逃逸命名空间、残留进程或绕过资源上限，请报告。

### 2. 本地 HTTP 服务

`tools/interaction-server.ts` 与 `packages/web/src/server.ts` 只监听 `127.0.0.1`，并做了静态资源白名单、路径段解码、请求体上限与 CSP。两者都校验 `Host` 必须是回环地址（否则 `421`），防止 DNS rebinding 借浏览器读走本地数据；交互服务另外校验 `Origin`（否则 `403`）并要求写请求使用 `application/json`（否则 `415`），堵掉不经预检的"简单请求"。以下问题属于安全范围：

- 路径穿越 / 任意文件读取
- SSRF 或让服务访问非预期地址
- 跨站请求伪造（CSRF）、DNS rebinding、Host / Origin 校验缺失导致本地服务被网页利用
- 未授权启动构建、读取会话、下载渲染图
- 通过会话 id / 渲染文件名注入路径或命令

### 3. 密钥与隐私

- API key 只从 `PG_LLM_API_KEY` 读取；错误信息会 scrub key。
- 运行账本 / 失败诊断不应包含完整提示词或密钥。
- 如果你发现 key 可能出现在日志、fixture、渲染图、`graphify-out/` 或提交历史中，请立即报告。

### 4. 提示词注入与费用

模型可能被题面 / 工具输出中的内容诱导，执行不必要的工具调用、写入或消耗预算。护栏（轮数、上下文、花费、卡死、退化）会止损，但**不保证**模型不做坏事。能绕过预算 / 确认门槛、或在用户未确认时发起 live 调用的路径属于安全范围。

## 不属于安全范围

- 你自己配置的 LLM 端点、代理或 API key 的安全
- 你本机被入侵、或你主动把服务暴露到公网
- 你自行导入的 Minecraft 资源 / 第三方数据的许可证问题（请读 `THIRD_PARTY_NOTICES.md`）
- 模型生成内容的事实错误、审美质量或“不可施工”本身（这是 bug / 质量问题，请开普通 issue）
- 你自己运行 live agent 产生的费用

## 安全开发约定

- 新增执行路径必须复用 `packages/sandbox`，不要直接 `spawn` 生成代码。
- 新增 HTTP 路由必须走现有的路径解析 / body 上限 / 静态白名单，不要拼接用户输入到文件路径。
- 新增日志 / 诊断 / fixture 时，确认不含密钥、完整提示词或个人路径。
- 依赖升级后跑 `npm run check`；CI 的 CodeQL 与 dependency-review 会额外检查。
