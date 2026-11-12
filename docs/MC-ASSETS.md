# Minecraft 1.20.1 官方资源管线

本目录说明渲染器如何优先使用本机 Minecraft 1.20.1 官方资源，以及没有资源时如何回退。
官方贴图 / 模型 / client jar **当前源码树不入库**；仓库只保留导入脚本、模型包生成脚本、manifest / sha256 与说明。

## 1. 快速开始

```bash
# 1) 自动检测 ~/.minecraft/versions/1.20.1/1.20.1.jar，导入到 .work/mc-assets/1.20.1/
node tools/import-mc-assets.ts

# 2) 生成官方模型包与状态索引（.work/mc-assets/1.20.1/catalog.json + model-pack.bin）
node tools/build-mc-catalog.ts

# 3) 生成方块能力目录（会同时更新 assets/ 与 packages/blocks、docs/）
node tools/build-block-catalog.ts
npx prettier --write packages/blocks/src/capability-catalog.ts packages/blocks/src/block-usages.ts

# 4) 视觉对照（需要本机 Chrome；输出 .work/.../visual/ 并复制 6 张到 docs/mc-visual/）
node tools/render-mc-gallery.ts
```

没有官方资源时，1–3 步会明确报错，但**不影响**现有渲染：`createRenderer` 自动回退到颜色 + 简化几何，并在
`RenderResult.scene.assets` / `RenderVersion.assets` 里写 `{ source: 'fallback', reason }`。

### 下载（可选）

只有显式同意时才走 Mojang 官方版本清单：

```bash
node tools/import-mc-assets.ts --download --accept-minecraft-assets
```

- 下载 `version_manifest_v2.json` → `1.20.1.json` → client jar，逐层校验 sha1。
- 文件只写 `.work/mc-assets/downloads/` 与 `.work/mc-assets/1.20.1/`，不写源码树。
- 不绕过 EULA，不提交 jar / 贴图 / 官方模型 JSON。

### 自定义路径

```bash
node tools/import-mc-assets.ts --source /path/to/1.20.1.jar
node tools/import-mc-assets.ts --source ~/.minecraft/assets --index <assetIndex.id>
node tools/import-mc-assets.ts --source /path/to/extracted/assets/minecraft
```

## 2. 目录与合规

```
.work/mc-assets/1.20.1/           # 已 gitignore，仅本机使用
  manifest.json                   # 源 sha256、文件数、逐文件 sha256/bytes、skipped
  assets/minecraft/blockstates/   # 官方 blockstates
  assets/minecraft/models/block/  # 官方 block models
  assets/minecraft/textures/      # 官方 block / entity 贴图
  data/minecraft/tags/blocks/     # 官方 block tags
  catalog.json                    # 状态 → 模型 id + 覆盖率 + 边界
  model-pack.bin                  # PGMP：预计算几何 + 纹理图集
  visual/                         # 视觉验证渲染
```

- `.gitignore` 已忽略 `.work/`；不要 `git add -f` 这些文件。
- `assets/mc-1.20.1/block-capabilities.json` 是**事实目录**（id、状态、标签、人工用法），不含贴图 / 模型二进制。
- `assets/mc-1.20.1/mc-assets.json` 只记录导入源 sha256、文件计数与官方模型覆盖率，由 `tools/build-mc-catalog.ts` 生成。
- 换机器 / CI 没有官方资源时，只跑仓库内测试与 fallback；不要提交资源来“修复”CI。

## 3. 渲染集成

### 协议 v2

`@pg/render` 的紧凑格表从 v1 升到 **v2**：

| 部分     | v1      | v2                                      |
| -------- | ------- | --------------------------------------- |
| 调色板项 | 8 字节  | 12 字节（+ model u16 + flags/reserved） |
| 格       | 8 字节  | 8 字节                                  |
| 头部     | 34 字节 | 34 字节                                 |

- `PROTOCOL_VERSION = 2`，`parseScene` 同时接受 v1；旧场景的 model 视为 0，继续走简化几何。
- 模型几何不塞进 `scene.bin`，而是由同一页面请求 `/model-pack.bin`；协议 v2 只写模型 id。
- `BrowserHost` 把模型包当作白名单静态资源服务，不访问 CDN / 网络。

### 模型包 PGMP

`model-pack.bin` 头部 24 字节：`PGMP`、版本、模型数、图集宽高、图集字节数。
每个模型 = 盒子列表；每个盒子 = 6 个面（east/west/up/down/south/north），面带 UV、tint 标记与
0–3 次 90° 旋转。像素图集是 RGBA8，UV 使用图集像素坐标，页面用 `DataTexture` + `NearestFilter`
采样，保持 Minecraft 的像素观感。

### 官方资源覆盖

本机导入结果（2026-10-19，1.20.1 client jar）：

- 882 个方块、11,783 个可查状态、4,799 个预计算模型、906 张贴图。
- 覆盖任务要求的高频室内 / 方向方块：door、trapdoor、fence_gate、stairs、slab、fence、wall、pane、
  button、pressure_plate、carpet、sign、ladder、chest、bed、flower_pot、lantern、chain、torch、rail。
- 方块纹理优先：官方模型面直接采样官方贴图；无模型时仍用平均色 + 简化几何。

### fallback

- 资源目录 / catalog / model-pack 任一缺失或损坏：`assets.source = 'fallback'`，`reason` 写明原因。
- 单个方块没有官方模型（例如部分技术方块）：该格 `model=0`，继续走旧的 `PAINT` 简化几何。
- `officialCells` 统计实际使用官方几何的格数；`simplified` 只统计仍被画成 `small` 的格。
- 视觉对照：`docs/mc-visual/fallback-*.png`。

## 4. 边界（可维护性约定）

1. **连接类方块**：fence / pane / wall 的相邻连接由渲染器按邻居规则计算 0–15 掩码，再查官方 multipart 预计算模型；
   不读取游戏运行时 block state，也不模拟完整方块更新。
2. **block entity**：chest / bed 没有官方 block model。用官方 `entity/chest/*`、`entity/bed/*` 贴图 + 重建盒体，
   UV 为近似值；告示牌文字、容器内容、床的占用状态不渲染。
3. **旋转**：blockstate 的 x/y 旋转按 90° 精确处理；模型元素 45° 等非 90° 旋转（链条、灯笼提梁）取旋转后 AABB。
4. **动画贴图**：竖条动画贴图取第一帧；隔行 PNG、16 位 PNG 明确报错并跳过。
5. **随机 variants**：官方 variants 权重数组固定取第一项，保证同一场景逐字节确定性。
6. **模型 / 贴图版权**：官方资源只在本机 `.work/` 使用；当前源码树不复制 binary，不提交 jar，
   也**不提交官方纹理的渲染截图**（衍生图，`docs/mc-visual/` 只收 fallback 渲染图）。测试使用合成几何 / PNG。

## 5. 测试与门禁

- `packages/render/src/model-pack.test.ts`：PGMP 编解码、长度 / 版本 / 图集校验。
- `packages/render/src/mc-catalog.test.ts`：状态 / 默认 / 连接掩码查询。
- `packages/render/src/asset-pack.test.ts`：缺失 / 合法 / 损坏资源与 fallback 状态。
- `packages/render/src/scene-buffer.test.ts`：协议 v2、v1 回读、官方 model id、连接掩码。
- `packages/render/src/page/scene.test.ts`：DataTexture / UV / 白像素 fallback。
- `tools/mc/*.test.ts`：ZIP、PNG、模型 parent 继承、blockstate multipart、图集、模型包生成。
- `npm run check` 不依赖 `.work/` 或网络。

## 6. 视觉验证

- `docs/mc-visual/` 只入库 **fallback** 渲染图（项目自产配色 + 简化几何）：
  - `fallback-room-iso.png` / `fallback-gallery-top.png` / `fallback-detail-iso.png`。
- 官方纹理 + 模型的渲染图是 Mojang 资产的衍生图，**只留在本机 `.work/.../visual/`，不提交仓库**：
  - 小房间剖切轴测 / 南立面 / 俯视室内、20+ 关键方块模型画廊、家具近景。
  - 需要对照时在本地跑 `node tools/render-mc-gallery.ts` 重新生成。

结论：官方资源显著改善了木纹、石砖、门 / 窗 / 家具的方向与厚度；fallback 仍能表达体量与颜色，
但缺少贴图细节和真实模型轮廓。两者共用同一协议与相机，切换只影响资源状态，不影响场景解析。
