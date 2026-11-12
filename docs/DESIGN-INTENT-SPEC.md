# DesignIntent 与宿主展开规格（R2）

> 状态：可实施规格，2026-10-19。目标读者：交互层、报告 / 预览、构建交接的实现者。
> 结论：模型只写 `DesignIntent`；宿主确定性展开为 `ResolvedDesign`，其中 `DesignScheme` 仍是内部解析视图。
> 不在本规格内实施产品代码，也不发起真实模型 / 网络调用。

## 1. 目标与非目标

### 1.1 为什么缩小模型输出面

当前 `DesignScheme` 让模型一次写 17 个 required 顶层字段、完整 3D bounds 和所有交叉引用。已观察到 44k 字符输出、零面积面、引用错误与截断；重试和加 `max_tokens` 只扩大失败面，不解决“模型同时做建筑设计与几何展开”的职责错配。

R2 把职责拆开：

| 角色               | 只负责                                              | 不负责                                    |
| ------------------ | --------------------------------------------------- | ----------------------------------------- |
| 模型               | 概念、房间矩形、墙 / 洞口意图、材料、家具锚点、决策 | 3D bounds、墙段去重、面积 / 数量、ID 注入 |
| 宿主               | 校验、派生、展开、计数、失败分类                    | 猜方案、补房间、改布局、伪造用户决定      |
| 报告 / 预览 / 构建 | 读取 resolved 视图                                  | 自己维护第二套数字                        |

目标输出面：完整 `DesignIntent` 通常 4–18k 字符；单阶段 1–5k 字符；不再要求模型一次写完整快照。

### 1.2 非目标

- 不静默猜几何：洞口放不下、家具放不下、屋面覆盖不了平面时，返回可定位错误，不自动移动 / 缩放 / 删除。
- 不把报告当源：设计报告、BuildSpec、预览都是 `ResolvedDesign` 的派生视图；报告不能反写设计。
- 不引入第二套事实源：模型只写 `DesignIntent`；宿主注入的 `meta.id/revision/status/sourceRequirements/budget/forbidden` 是上下文事实，不是模型可编辑字段。
- 不把宿主展开写成万能平面生成器：不支持自由曲面、自动走廊、自动家具排布、结构计算、碰撞求解。
- 不保留“模型直接写 DesignScheme”作为默认路径；兼容期只用于回放和旧测试。

## 2. DesignIntent schema

### 2.1 顶层

`DesignIntent` 为 `strictObject`，顶层 12 个字段；没有 `budget` / `forbidden` / `meta.id` 等宿主字段。

| 字段        | 类型   | 说明                                           |
| ----------- | ------ | ---------------------------------------------- |
| `meta`      | object | 模型可写的标题、概念、交付范围                 |
| `site`      | object | 场地矩形、朝向、入口方向、真实室外分区         |
| `program`   | object | 楼层与房间矩形、occupancy、adjacency、daylight |
| `envelope`  | object | 墙厚默认、墙意图、直跑楼梯                     |
| `openings`  | array  | 门 / 窗 / 洞口意图，不写 3D bounds             |
| `structure` | object | 结构体系与材料；跨度由宿主派生                 |
| `roof`      | object | 屋面形式、坡度、挑檐、天沟、天窗               |
| `facades`   | array  | 每侧立面材质分层；开间 / 窗墙比可派生          |
| `materials` | array  | 构建可执行的方块材质表                         |
| `furniture` | array  | 房间 + 锚点 + footprint + 朝向                 |
| `decisions` | array  | 设计决策；状态由宿主置为 proposed              |
| `open`      | array  | 未决问题；状态由宿主置为 open                  |

坐标：`x` 向东、`z` 向南，单位格（设计尺度约 1m）；`y` 不进入 `DesignIntent`，由楼层标高派生。所有矩形为半开区间。

`Rect2`：`{ "x": [x0, x1], "z": [z0, z1] }`，四个整数，且 `x1 > x0`、`z1 > z0`。零面积矩形在 schema 层直接失败。

### 2.2 meta 与 site

| 字段                  | 类型                                                | 必填          | 说明                                           |
| --------------------- | --------------------------------------------------- | ------------- | ---------------------------------------------- |
| `meta.title`          | string 1..200                                       | 是            | 方案标题                                       |
| `meta.concept`        | string 1..4000                                      | 是            | 概念说明；不是几何                             |
| `meta.scope`          | `exterior` / `exterior+entry` / `exterior+interior` | 是            | 交付范围                                       |
| `site.bounds`         | `Rect2`                                             | 是            | 整个场地；必须正面积                           |
| `site.orientation`    | `north/east/south/west/unknown`                     | 是            | 指北                                           |
| `site.entrance.side`  | `Side`                                              | 是            | 入口所在建筑立面；不写房间和 offset            |
| `site.entrance.notes` | string/null                                         | 否            | 说明                                           |
| `site.outdoorZones[]` | object                                              | 是（可为 []） | 真实分区：`id/name/kind/rect/materialId/notes` |
| `site.notes`          | string/null                                         | 是（可 null） | 场地说明                                       |

`outdoorZones[].rect` 必须正面积、落在 `site.bounds` 内、且不与任何建筑房间矩形重叠（可贴边）。禁止用零面积 bounds 占位；没有真实分区就写 `[]`。`site.entrance` 只是语义方向，真正的门在 `openings` 中以 `role=entrance` 表达，宿主校验“恰有一扇、且 side 一致”。

### 2.3 program

`program.levels[]`：

| 字段              | 类型               | 必填 | 说明                                 |
| ----------------- | ------------------ | ---- | ------------------------------------ |
| `id` / `name`     | Identifier / Label | 是   | 楼层 id 与名称                       |
| `height`          | int 1..100         | 是   | 层高                                 |
| `floorMaterialId` | Identifier         | 是   | 楼板材质，必须存在于 `materials`     |
| `elevation`       | int                | 否   | 通常省略；宿主按顺序累加，首层默认 1 |

宿主派生：`elevation[0] = 1`（地面 y=0、首层楼面 y=1；也可由模型显式给出），`elevation[i] = elevation[i-1] + height[i-1]`。显式标高必须严格递增且不重叠，否则失败。

`program.rooms[]`：

| 字段          | 类型                               | 必填          | 说明                                           |
| ------------- | ---------------------------------- | ------------- | ---------------------------------------------- |
| `id` / `name` | Identifier / Label                 | 是            | 房间 id 与名称                                 |
| `level`       | Identifier                         | 是            | 引用 `levels[].id`                             |
| `kind`        | `room` / `service` / `circulation` | 是            | 室内空间类型                                   |
| `rect`        | `Rect2`                            | 是            | 平面外包矩形；不得零面积                       |
| `areaM2`      | number > 0                         | 否            | 目标面积；宿主派生名义面积并比较，不一致只告警 |
| `occupancy`   | int 0..500                         | 是            | 使用人数 / 容量                                |
| `adjacency`   | Identifier[]                       | 是（可为 []） | 期望相邻房间；必须对称                         |
| `daylight`    | `required` / `preferred` / `none`  | 是            | 采光要求                                       |
| `notes`       | string/null                        | 是（可 null） | 备注                                           |

同层房间不得面积重叠，可共边。`adjacency` 中的每个目标必须与该房间有正长度共边；未声明但实际共边的房间由宿主补入 `spaces.connections` 并记 warning。不同层可上下叠放。房间矩形是**外包 / 含墙**，宿主报告名义面积，不扣墙厚。

### 2.4 envelope：墙与楼梯

`envelope` 不复制房间清单；房间以 `program.rooms` 为准，墙意图通过 `roomId` 引用。模型不写“共享墙对象”，也不写墙段 bounds；房间矩形的每条边先生成候选边，宿主按拓扑去重。

| 字段                                      | 类型     | 必填          | 说明                |
| ----------------------------------------- | -------- | ------------- | ------------------- |
| `envelope.wallDefaults.exteriorThickness` | int 1..8 | 否            | 默认 1              |
| `envelope.wallDefaults.interiorThickness` | int 1..8 | 否            | 默认 1              |
| `envelope.walls[]`                        | object   | 是（可为 []） | 仅覆盖 / 关闭某些边 |
| `envelope.stairs[]`                       | object   | 是（可为 []） | MVP 只支持直跑楼梯  |

`walls[]`：`{ roomId, side, kind: 'auto'|'exterior'|'interior'|'none', thickness?, materialId? }`。

- `auto`：按拓扑决定外墙 / 共享墙。
- `exterior` / `interior`：必须与拓扑一致，否则报 `wall-kind-conflict`。
- `none`：仅用于开放边。共享边只有两侧都写 `none` 才允许打开；一侧 `none`、另一侧不是，报 `wall-intent-conflict`。
- 同一共享边两侧厚度 / 材质不一致且都显式给出时，报 `wall-override-conflict`；只有一侧给出则采用该值。

墙带规则（MVP，写入测试）：

- 外墙：厚度带位于房间矩形内侧，按 side 内缩。房间 `[x0,x1]×[z0,z1]` 的北墙为 `z=[z0,z0+t)`，南墙 `z=[z1-t,z1)`，西墙 `x=[x0,x0+t)`，东墙 `x=[x1-t,x1)`。
- 共享墙：在共享线上居中，`lo = c - floor(t/2)`，`hi = lo + t`；奇数厚度多出的一格落在 +x / +z 一侧。相邻房间只生成一条墙元素。
- 墙与墙在角部允许重叠（示意）；洞口两端必须留出相邻墙厚，避免切角。
- `site.buildingBounds` 取所有房间外包矩形的并集包围盒，y 从最低楼层标高到檐口；墙面内缩不改变外包面积。

`stairs[]`：`{ id, name, roomId, fromLevel, toLevel, start: {x,z}, direction: Side, width, treads, materialId? }`。

- 仅支持直跑、相邻楼层、`treads >= 2`；`toLevel` 必须紧邻 `fromLevel`。
- 宿主按 `start` + `direction` + `treads` 派生梯段外包和一条两点的示意路线；不做踏步实体、休息平台、U/L 形、弧形楼梯。
- 多层且 `scope=exterior+interior` 时，每一对相邻楼层必须有楼梯，否则报 `missing-vertical-circulation`。

### 2.5 openings

| 字段            | 类型                                   | 必填 | 说明                                                     |
| --------------- | -------------------------------------- | ---- | -------------------------------------------------------- |
| `id` / `name`   | Identifier / Label                     | 是   | 洞口 id / 名称                                           |
| `roomId`        | Identifier                             | 是   | 宿主房间；楼层由房间派生                                 |
| `side`          | `Side`                                 | 是   | 洞口所在房间侧                                           |
| `kind`          | `door` / `window` / `opening` / `gate` | 是   | 洞口类型                                                 |
| `role`          | `entrance` / `interior` / `service`    | 否   | 默认 `interior`；恰有一个 `entrance`                     |
| `offset`        | int >= 0                               | 是   | 从该侧起点（N/S 取 min x，E/W 取 min z）到洞口近边的距离 |
| `width`         | int >= 1                               | 是   | 沿墙宽度                                                 |
| `height`        | int >= 1                               | 是   | 洞口高度                                                 |
| `sill`          | int >= 0                               | 是   | 相对楼面窗台；门写 0                                     |
| `fill`          | Label                                  | 是   | 填充 / 门扇说明                                          |
| `frameMaterial` | Identifier/null                        | 否   | 框材质，必须存在                                         |

宿主派生：`level = room.level`；`host = 该侧实际墙段 id`；`bounds` 在墙厚方向覆盖整条墙带，高度为 `[elevation+sill, elevation+sill+height)`。约束：

- `offset >= 侧端墙厚` 且 `offset + width <= 侧长 - 侧端墙厚`；洞口必须完整落在**一个**墙段内，跨两个墙段报 `opening-crosses-wall-segment`。
- `sill + height <= level.height`；门 / 院门通常 `sill=0`。
- 洞口所在边不得是 `none`；同一墙段上两个洞口水平区间不得重叠。
- `role=entrance` 恰有一个，且 `side === site.entrance.side`；否则报 `entrance-invalid`。

### 2.6 structure 与 roof

`structure`：`{ system: 'load-bearing-walls'|'post-and-beam'|'frame'|'mixed', materialId, floorThickness?: int 1..8 (默认 1), cantilever?: int 0..50 (默认 0), notes? }`。`spanX/spanZ` 由 `buildingBounds` 派生，不由模型写。

`roof`：`{ form: 'flat'|'gable'|'hip'|'shed', materialId, pitchDegrees?: number, overhang: int 0..50, ridgeAxis?: 'x'|'z', drainage?: string|null, skylights?: string[], notes? }`。

- `flat`：`pitchDegrees` 取 0；`eaveHeight = 顶层标高 + 顶层 height`；`ridgeHeight = eaveHeight`。
- 非 flat：`pitchDegrees` 必须 5..60；`ridgeAxis` 省略时取建筑长轴；`ridgeHeight = eaveHeight + round(tan(pitch) × 含挑檐垂直跨度 / 2)`。
- MVP 只支持屋面投影为矩形。若顶层房间并集与包围盒不重合（L 形、凹凸、多体量），报 `roof-plan-not-rectangular`，不自动拼屋面。
- `overhang` 从 `buildingBounds` 向四周外扩；屋面元素是**体量盒**，坡面由构建层按 `roof.form / pitchDegrees / ridgeAxis` 构造，预览也是示意。

### 2.7 facades 与 materials

`facades[]`：`{ side, baseMaterialId, bodyMaterialId, topMaterialId?: id|null, bays?: int 1..100, windowWallRatio?: number 0..1|null, notes? }`。

- 每个有外墙的 side 必须恰有一条 facade；没有外墙的 open side 不要求。
- `bays` 省略时宿主取 `max(1, round(sideLength / 3))`；`windowWallRatio` 省略时按该侧窗洞面积 / 立面面积派生，保留两位小数。
- 外墙材质优先级：`walls[].materialId` > 该侧 `facades[].bodyMaterialId`。共享墙：`walls[].materialId` > 唯一 `role=wall` 的材质；不唯一则报 `material-ambiguous`。

`materials[]`：`{ id, name, block, role: 'structure'|'wall'|'roof'|'floor'|'trim'|'furniture'|'landscape'|'glass', color?: '#rrggbb'|null, notes? }`。`block` 必须带完整方块状态（如 `oak_stairs[facing=east,half=bottom]`）。所有 `materialId` 引用必须能解析；不用隐式新建材质。

### 2.8 furniture

| 字段          | 类型                                                                                              | 必填          | 说明                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `id` / `name` | Identifier / Label                                                                                | 是            | 家具 id / 名称                                                                            |
| `kind`        | 与现有 `FurnitureKind` 相同                                                                       | 是            | table / chair / bench / counter / shelf / storage / bed / light / rug / appliance / other |
| `roomId`      | Identifier                                                                                        | 是            | 所属房间                                                                                  |
| `anchor`      | `{kind:'center'}` / `{kind:'wall',side,offset}` / `{kind:'corner',corner:'nw'\|'ne'\|'sw'\|'se'}` | 是            | 锚点；wall 的 offset 是家具中心距侧起点                                                   |
| `footprint`   | `{ x: int>=1, z: int>=1 }`                                                                        | 是            | 全局 x/z 方向占地，不旋转                                                                 |
| `orientation` | `Side/null`                                                                                       | 是            | 面向；只作语义，不改变 footprint                                                          |
| `height`      | int 1..16                                                                                         | 否            | 省略时按 kind 默认：shelf/storage 为 2，其余为 1                                          |
| `materialId`  | Identifier/null                                                                                   | 否            | 省略时要求恰有一个 `role=furniture` 材质                                                  |
| `notes`       | string/null                                                                                       | 是（可 null） | 备注                                                                                      |

宿主按房间实际墙带计算可用内矩形，把 footprint 放进内矩形：`center` 居中；`wall` 贴该侧内墙面、沿墙居中于 offset；`corner` 贴相邻两面内墙。放不下、贴到 `none` 边、或与其它硬质家具重叠时报 `furniture-out-of-room` / `furniture-overlap`。不自动缩小或旋转。

### 2.9 decisions 与 open

`decisions[]`：`{ id, topic, choice, rationale, source: 'user'|'agent'|'default', requirementIds: Identifier[] }`。宿主置 `status='proposed'`；`requirementIds` 必须落在注入的需求图 req / con / cap 上。

`open[]`：`{ id, question, impact: 'layout'|'facade'|'interior'|'budget'|'other', owner: 'user'|'agent', defaultAssumption: string|null, freeForBuilder: boolean }`。宿主置 `status='open'`。

### 2.10 宿主注入

宿主在调用模型前构造并保存，不进入工具 schema，也不允许模型覆盖：

| 注入项                    | 来源                             | 去向                                                          |
| ------------------------- | -------------------------------- | ------------------------------------------------------------- |
| `meta.id` / `revision`    | 会话 / CLI                       | `SchemeMeta`                                                  |
| `meta.status`             | 初始 `draft`，确认时 `confirmed` | `SchemeMeta`                                                  |
| `meta.sourceRequirements` | RequirementGraph id + revision   | 精确写入并校验                                                |
| `budget`                  | CLI / 需求约束                   | `SchemeBudget`；`estimatedBlocks=null`，不编造                |
| `forbidden`               | 用户禁项 + 能力边界              | `DesignScheme.forbidden`                                      |
| `requirementIds`          | 需求图 req / con / cap           | 决策 / 细部引用校验                                           |
| 展开默认值                | 宿主常量                         | 墙厚、板厚、家具高度、立面开间；在 `facts.derivations` 中列出 |

## 3. 宿主展开算法（MVP）

`expandDesignIntent(intent, host): ResolvedDesign` 是纯函数，不读文件、不调模型。`ResolvedDesign = { intent, scheme: DesignScheme, facts, warnings }`；`scheme` 始终由 intent + host 重新生成，禁止手改。

### 3.1 前置校验顺序

1. `DesignIntent.parse`：strict、所有 required 字段齐全、无未知键。
2. ID 唯一性（各集合内 + 必要的全局冲突）、所有引用能解析。
3. 场地 / 房间矩形正面积、房间不重叠、室外分区不压建筑。
4. 楼层标高单调、房间在对应楼层、跨层叠放合法。
5. adjacency 对称且实际共边；入口 / 楼梯 / 屋面 / 材质约束。
6. 任一失败返回 `IntentValidationError { code, path, message }`，不进入部分展开。

### 3.2 楼层、房间、场地

- `levels`：按 2.3 派生 elevation；`SchemeLevel` 直接映射。
- `spaces`：`rect` + elevation / height 组成 3D bounds `[x0, elev, z0) -> [x1, elev+height, z1)`；`connections` 由实际共边派生；`occupancy` / `daylight` 写入 resolved facts（或扩展 `SchemeSpace` 可选字段，见第 5 节）。
- `site.bounds` 原样；`site.buildingBounds = union(rooms).bbox` 的 3D 版本，y 从最低 elevation 到 `eaveHeight`；`outdoorZones` 映射并保留正面积，`materialId` 解析为材质名。
- `areaM2` 目标与 `rect` 派生名义面积比较，偏差 >10% 记 warning，不改矩形。

### 3.3 墙段

1. 每层每个房间生成 4 条候选边，按 `(orientation, line)` 分组。
2. 在所有端点处切分；得到长度 >=1 的原子区间。
3. 每个原子区间查找位于线两侧的房间：两侧都有 => 共享墙；只有一侧 => 外墙；都没有 => 跳过。
4. 应用 `envelope.walls` 覆盖；`none` 规则见 2.4；冲突即失败。
5. 外墙带按房间侧内缩；共享墙带居中；生成一个 `SchemeElement{kind:'wall'}`，共享墙 `spaceId=null`，外墙 `spaceId=房间 id`。
6. 墙 id 采用稳定 slug：`wall-{level}-{axis}-{line}-{start}-{end}`，负坐标用固定宽度编码；超 64 字符时截断并追加稳定短哈希。同一 intent 重复展开必须逐字节一致。
7. 角部重叠允许；墙高度为整层 `elevation..elevation+height`。悬挑 / 半墙 / 女儿墙不在 MVP。

### 3.4 洞口

- 找到 `roomId + side` 对应的墙段；按 `offset` 计算沿墙区间，必须完整落在同一个墙段内。
- 沿墙方向取 `[start, start+width)`；墙厚方向取该墙段完整厚度；高度取楼层标高 + `sill..sill+height`。
- 输出 `SchemeOpening`，`host` 为墙段 id，`level` 由房间派生；`side` 保留宿主侧。
- 入口 `role=entrance` 同步写入 site facts，并校验与 `site.entrance.side` 一致。
- 门窗不生成 3D 旋转、门扇开启方向、玻璃分格；这些属于构建层。

### 3.5 楼板、屋面、楼梯

- 楼板：每个房间每层生成一块 `kind:'slab'`，bounds 为房间矩形，y 为 `[elevation-floorThickness, elevation)`；材质取该层 `floorMaterialId`。相邻楼板贴边，不合并；不切楼梯洞（示意，构建层处理）。
- 屋面：顶层房间并集必须为矩形；投影为 `buildingBounds` 外扩 `overhang`。屋面厚度默认取 `structure.floorThickness`；平屋面为 `[eave, eave+floorThickness)`，坡屋面元素是 `[eave, ridge+floorThickness)` 的体量盒。`SchemeRoof` 写 form / pitch / eave / ridge / overhang / drainage / skylights。
- 楼梯：校验在房间内、方向 / 宽度 / treads 合法；生成 `kind:'stair'` 元素（梯段外包）和 `SchemeCirculation{kind:'stair'}` 的示意点列；`fromSpaceId=roomId`，`toSpaceId` 取上层与梯段顶部重叠的房间，找不到则 null 并记 warning。多层的“相邻层必须有梯”见 2.4。
- 不生成入口路线、走廊路线、无障碍净空；`circulation` 除楼梯外为空，`facts.warnings` 记 `entry-route-not-modeled`。

### 3.6 家具、室内、面积与计数

- 先算每个房间的可用内矩形（扣除实际墙带）；按 anchor 放 footprint；`bounds.y = [elevation, elevation+height)`。
- 每个 `kind=room|service` 的房间生成一条 `SchemeInterior{included:true}`；`furniture` 为名称列表，`furnitureSpecs` 为展开后的绝对 bounds；`circulation` 房间不生成 interior。
- `facts.rooms[]`：`nominalAreaM2`（rect 面积）、`targetAreaM2`、`deltaPct`、`occupancy`、`daylight`、`adjacency`。
- `facts.counts`：楼层、房间、按 exterior/shared 分类的墙段、洞口按 kind、家具、楼梯。
- 报告 / BuildSpec 的所有面积、洞口宽高、窗台、counts 从 `scheme` 或 `facts` 现算；`estimatedBlocks` 保持 null，除非以后加入确定性估算器。
- `details` 为空数组；必须项来自 RequirementGraph 与 decisions，不在展开阶段补造细部。

### 3.7 映射表：DesignIntent -> DesignScheme

| DesignIntent                           | DesignScheme / facts                   | 规则                                |
| -------------------------------------- | -------------------------------------- | ----------------------------------- |
| `meta.title/concept/scope` + host.meta | `meta`                                 | 合并；host 字段最后写入             |
| `site.bounds` / `outdoorZones`         | `site.bounds` / `site.outdoorZones`    | 原样 + 正面积校验                   |
| 房间并集                               | `site.buildingBounds`                  | bbox；y 到檐口                      |
| `program.levels`                       | `levels`                               | elevation 宿主派生                  |
| `program.rooms`                        | `spaces`                               | rect -> 3D bounds；connections 派生 |
| 墙意图 + 房间矩形                      | `elements[kind=wall]`                  | 外墙内缩 / 共享墙居中 / 去重        |
| 房间 + 楼层                            | `elements[kind=slab]`                  | 每房每层一块                        |
| `roof` + 顶层矩形                      | `elements[kind=roof]` + `roof`         | 坡屋面为体量盒                      |
| `envelope.stairs`                      | `elements[kind=stair]` + `circulation` | 直跑示意                            |
| `openings`                             | `openings`                             | offset -> 3D bounds；host 墙段      |
| `structure`                            | `structure`                            | spanX/Z 由 bbox 派生                |
| `facades`                              | `facades`                              | bays / 窗墙比可派生                 |
| `materials`                            | `materials`                            | 原样；引用闭合                      |
| `furniture`                            | `interiors[].furnitureSpecs`           | anchor -> bounds                    |
| `decisions` / `open`                   | `decisions` / `open`                   | status 宿主置位                     |
| host.budget / forbidden                | `budget` / `forbidden`                 | 模型不可写                          |
| 无                                     | `details`                              | `[]`                                |

### 3.8 示意几何与必须失败

| 仍是示意                            | 必须失败（不猜）                                   |
| ----------------------------------- | -------------------------------------------------- |
| 墙段角部重叠；共享墙占位到一侧      | 房间零面积 / 同层重叠；未知 ID；洞口超出墙段或层高 |
| 坡屋面体量盒、檐口 / 屋脊由公式派生 | 屋面投影非矩形；curved / butterfly / other         |
| 楼板不切楼梯洞；梯段为外包盒        | 多层 interior 缺楼梯；楼梯跨多层 / U 形 / 弧形     |
| 家具高度默认、立面开间 / 窗墙比派生 | 家具放不进内矩形；贴 none 边；家具重叠             |
| 入口只校验方向与 role；路线不生成   | 入口 0 或 >1；入口 side 不符；场地分区压建筑       |
| 预览的轴测 / 剖面                   | 结构可行性、净空、碰撞、施工构造                   |

## 4. 生成阶段

### 4.1 五阶段

| 阶段                                  | 工具                     | 只提交字段                                  | 增量校验                                                             |
| ------------------------------------- | ------------------------ | ------------------------------------------- | -------------------------------------------------------------------- |
| S1 site/meta                          | `submit_intent_site`     | `meta`, `site`                              | 标题 / 概念非空；场地正面积；分区真实且在场地内（S2 再校验不压房间） |
| S2 program/rooms                      | `submit_intent_program`  | `program`                                   | 楼层 / 房间 ID；矩形正面积；同层不重叠；adjacency 对称且实际共边     |
| S3 envelope/openings/structure/roof   | `submit_intent_envelope` | `envelope`, `openings`, `structure`, `roof` | 墙拓扑；洞口落在墙段 / 层高内；入口唯一；楼梯；屋面投影矩形          |
| S4 facades/materials                  | `submit_intent_facades`  | `facades`, `materials`                      | 材质 ID；每个有外墙 side 有 facade；S3 的材质引用在此闭合            |
| S5 interiors/furniture/decisions/open | `submit_intent_interior` | `furniture`, `decisions`, `open`            | 家具可放；决策 requirementIds；空集合合法但字段必须出现              |

宿主按阶段保留 patch；重试只允许替换当前阶段 patch，不得重写上游。合并后必须再次 `DesignIntent.parse`，再 `expandDesignIntent`。S3 允许引用 S4 才定义的材质 ID，但 S4 结束时必须全部闭合；未闭合即失败，不进入 S5。

### 4.2 契约规则

- 每个阶段 schema 是显式 `strictObject`，没有 `.loose()` / `.passthrough()`；不用 `.partial()` 掩盖缺字段，不用 `.strip()` 静默丢弃越界字段。
- 阶段工具 schema 顶层只出现本阶段字段；模型提交额外字段直接 schema 失败。
- 每个数组字段 required，可为 `[]`；每个对象 required；只有 2.x 明确标注“否”的字段可省略。
- 每阶段最多 1 次 schema 修复；修复提示携带“本阶段 + 已合并上游 ID 清单 + 失败 path”，不带完整 17 字段要求。
- 提示词只列本阶段字段、ID 词汇和 1 个局部示例；禁止再写“必须一次提交完整方案”。
- 输出长度：单阶段目标 <=5k 字符，硬上限 8k；总 intent 目标 <=18k。`max_tokens` 每阶段 8192；截断直接失败，不把半截 JSON 送去修复。

## 5. 与现有代码的迁移

### 5.1 新增

| 文件                                          | 内容                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/interaction/src/design-intent.ts`   | `DesignIntent`、各阶段 schema、`DesignHostContext`、错误类型                               |
| `packages/interaction/src/design-expand.ts`   | `expandDesignIntent`、墙段 / 洞口 / 家具算法、`ResolvedDesign`、facts                      |
| `packages/interaction/src/generate-intent.ts` | 五阶段 `generateIntentStaged`，复用现有 `ChatClient` / `ChatRequest` / 错误分类            |
| `packages/interaction/src/prompts-intent.ts`  | 分阶段提示词；不引用 17 字段完整输出规则                                                   |
| 测试                                          | `design-intent.test.ts`、`design-expand.test.ts`、`generate-intent.test.ts`、fake fixtures |

### 5.2 保留与替换

- `DesignScheme` 保留为 resolved internal view；不删除现有 schema、报告、BuildSpec、预览。
- `expandDesignIntent` 返回 `ResolvedDesign`，内部 `scheme` 通过现有 `DesignScheme.parse`，因此现有 `compileDesignReport` / `compileBuildBrief` / `renderPreviewBundle` 可继续工作。
- 推荐在 `SchemeSpace` 增加可选 `occupancy` / `daylight`，报告直接显示；若暂不改，`ResolvedDesign.facts.rooms` 作为报告附加入参。两条路线二选一，不并行维护两份数字。
- `site.buildingBounds`、面积、洞口宽高、窗台 / 过梁、counts 全部由宿主派生；`BuildSpec` 仍按现有规则从 `DesignScheme` 取数，不新增平行字段。
- `details` 默认为空；如果以后要模型写细部，新增 S6，不塞回 S5。

### 5.3 报告 / BuildBrief / 预览 / 会话

- 报告：`compileDesignReport(scheme, requirements, facts?)` 可选打印 occupancy、daylight、目标面积 vs 名义面积、展开 warnings；没有 facts 时行为不变。
- BuildBrief：`compileBuildBrief(resolved.scheme, requirements)` 不变；构建交接仍只认 resolved DesignScheme。多层无梯 / 非矩形屋面在展开阶段已失败，不会流入构建。
- 预览：继续读 `resolved.scheme`；坡屋面、家具高度、楼板洞口按 3.8 标注“示意”。
- 会话：`proposeDesign` 仍接收 `DesignScheme`；生成层先 `generateIntentStaged -> expandDesignIntent -> proposeDesign(resolved.scheme)`。为支持定向修订，`intents` 与 resolved scheme 一起持久化（或写入 run 目录）；不能只留 scheme 后反推 intent。
- 旧路径：`proposeScheme` / `proposeSchemeStaged` 保留一个兼容期，仅用于回放、旧测试和显式 `--legacy-scheme`；新默认路径不得自动回退到旧提示词。兼容期结束删除旧分阶段 prompt，但 `DesignScheme` schema 长期保留。

### 5.4 落地顺序

1. 先落 schema + `expandDesignIntent` + 三套 fake fixture，不接模型。
2. 再接五阶段 fake client 和增量校验；报告 / brief / preview 全链路通过。
3. 真实模型只跑茶亭 1 次；记录 usage、字符数、repair 次数；通过后再跑住宅 / 小院。
4. 默认切到 intent；旧路径仅显式旗标。
5. 观察一个版本后移除旧生成路径；保留旧 DesignScheme JSON 的解析兼容。

## 6. 验收标准

### 6.1 fake client 场景

| 场景         | 输入                                                 | 必须断言                                                                             |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 最小茶亭 8×6 | 1 层 1 房；南入口；北 / 东窗；双坡屋面；桌 / 凳 / 灯 | 1 房、48m² 名义、4 段外墙、1 入口门、2 窗、1 屋面、4 家具；intent <=4.5k 字符        |
| 两层住宅     | 2 层；F1 客厅 / 厨房，F2 两卧；1 直跑楼梯            | 2 levels、4 spaces、共享墙只出现一次、每房每层楼板、楼梯元素 + stair route、无零面积 |
| 小院         | 8×6 建筑 + 2 个室外分区                              | 分区正面积、在场地内、不压建筑；外墙不覆盖分区；报告 / brief / preview 可生成        |

所有 fake 测试使用注入的 fake `ChatClient`，不读 `.env`、不发网络请求。

### 6.2 契约层如何避免旧问题

- 零面积：`Rect2` 的 `x1>x0 && z1>z0`；`width/height/footprint/thickness` 均为正整数；墙段长度 <1 不产出，楼板 / 屋面为空即失败。
- 跨引用：阶段合并后做全量 ID 图校验；`roomId`、`level`、`materialId`、`host`、`toSpaceId`、`requirementIds` 全部必须解析；错误带 JSON path。
- 漏字段：每阶段 strict schema + 最后完整 `DesignIntent` strict parse；没有 `.partial()`；阶段 patch 缺少本阶段字段直接失败。
- 交叉错误：洞口只由 offset 派生，不再让模型写 3D bounds；共享墙 / 外墙由同一拓扑算法生成，模型无法造出第二个 host。
- 入口：role 唯一 + side 一致；多层 interior 必须有楼梯；非矩形屋面直接拒绝。

### 6.3 真实模型验证

最少 1 次，建议 3 次（茶亭 / 住宅 / 小院），使用现有 deepseek-flash 配置但只在验收环境发起：

- 五阶段全部 `finish_reason=tool_calls`；单阶段 repair <=1 次；总调用 <=10 次。
- 最终 `DesignIntent.parse` + `expandDesignIntent` 零错误；无截断、无 `schema-invalid` 未修复。
- `compileDesignReport` / `compileBuildBrief` / `renderPreviewBundle` 全部成功；报告无编造用户原话。
- 茶亭 intent <=5k 字符，总 completion tokens <=10k；住宅 <=16k 字符，总 tokens <=14k。
- 人工抽查：入口、房间、墙、洞口、屋面、家具与示例一致；warnings 均可见。

### 6.4 性能 / 成本目标

- 对比基线：完整 DesignScheme 约 44k 字符；R2 目标总 intent <=18k（约 -59%），硬上限 24k。
- 每阶段 `max_tokens=8192`；总 completion tokens 目标 <=10k，硬上限 14k；单阶段输出 >8k 即视为设计过密，先拆/简化而不是加预算。
- schema 修复总次数 <=2；总模型调用 <=10；无 `finish_reason=length`。
- 墙 / 洞口 / 家具展开是纯 CPU、线性或 O(n log n)（墙段端点排序）；1k 墙段 + 500 洞口 + 500 家具在 100ms 量级，可单测设上限。

## 7. 风险与分阶段落地

| 风险                       | MVP 处理                                            | 后续                                       |
| -------------------------- | --------------------------------------------------- | ------------------------------------------ |
| 自由曲面 / 异形平面        | 不支持；房间必须矩形；屋面投影必须矩形              | 曲线墙 / 多边形房间另立 R3，不做隐式三角化 |
| 共享边部分重叠 / T 形交接  | 端点切分后逐原子段生成；角部允许重叠                | 精确墙段裁剪 / 接头构件                    |
| 复杂楼梯                   | 只支持直跑相邻层；U/L/弧形直接失败                  | 楼梯模块与楼板开洞                         |
| 多体量 / 高低错落屋面      | 顶层并集非矩形即失败                                | 多屋面、天沟、女儿墙                       |
| 家具旋转 / 碰撞            | footprint 不旋转；重叠即失败                        | 90° 旋转与碰撞求解                         |
| 场地高差                   | 只支持平场地，地面 y=0、首层楼面 1；不做挡土墙      | 地形与台地                                 |
| 立面开间 / 窗墙比          | 宿主按规则派生，报告标注                            | 可改为模型显式                             |
| 模型不熟悉 offset / anchor | 提示词给局部坐标图 + 1 个茶亭片段；每阶段只教本阶段 | 失败样例回灌                               |
| 迁移期双源                 | intent 持久化，scheme 每次重展开；禁止手改 scheme   | 删除旧生成路径                             |
| 旧路径回退掩盖问题         | 仅显式 `--legacy-scheme`；默认失败即失败            | 兼容期后移除                               |

MVP 明确支持：矩形房间、外墙 / 共享墙、常见门窗、平 / 单坡 / 双坡 / 四坡矩形屋面、直跑楼梯、轴对齐家具、四侧立面材质。其余形式降级为“明确失败 + 可行动错误”，不是“宿主猜一个近似”。

## 8. 示例：8×6m 茶亭

### 8.1 DesignIntent 片段（关键字段；materials 等省略）

```json
{
  "meta": {
    "title": "稻田茶亭",
    "concept": "面向南侧稻田的单间木构茶亭，深檐下形成半室外平台。",
    "scope": "exterior+interior"
  },
  "site": {
    "bounds": { "x": [0, 16], "z": [0, 12] },
    "orientation": "south",
    "entrance": { "side": "south", "notes": null },
    "outdoorZones": [
      {
        "id": "zone-terrace",
        "name": "南侧檐下平台",
        "kind": "terrace",
        "rect": { "x": [3, 11], "z": [9, 12] },
        "materialId": "mat-stone",
        "notes": null
      }
    ],
    "notes": null
  },
  "program": {
    "levels": [{ "id": "f1", "name": "地面层", "height": 3, "floorMaterialId": "mat-stone" }],
    "rooms": [
      {
        "id": "tea",
        "name": "主茶室",
        "level": "f1",
        "kind": "room",
        "rect": { "x": [3, 11], "z": [3, 9] },
        "areaM2": 48,
        "occupancy": 8,
        "adjacency": [],
        "daylight": "required",
        "notes": null
      }
    ]
  },
  "envelope": { "wallDefaults": { "exteriorThickness": 1, "interiorThickness": 1 }, "walls": [], "stairs": [] },
  "openings": [
    {
      "id": "open-entry",
      "name": "南侧主入口",
      "roomId": "tea",
      "side": "south",
      "kind": "door",
      "role": "entrance",
      "offset": 3,
      "width": 2,
      "height": 2,
      "sill": 0,
      "fill": "木框玻璃门",
      "frameMaterial": "mat-wood"
    },
    {
      "id": "win-north",
      "name": "北向长窗",
      "roomId": "tea",
      "side": "north",
      "kind": "window",
      "role": "interior",
      "offset": 2,
      "width": 4,
      "height": 1,
      "sill": 1,
      "fill": "透明玻璃",
      "frameMaterial": "mat-wood"
    }
  ],
  "structure": {
    "system": "post-and-beam",
    "materialId": "mat-wood",
    "floorThickness": 1,
    "cantilever": 0,
    "notes": null
  },
  "roof": {
    "form": "gable",
    "materialId": "mat-roof",
    "pitchDegrees": 25,
    "overhang": 1,
    "ridgeAxis": "x",
    "drainage": "南北檐沟",
    "skylights": [],
    "notes": null
  },
  "facades": [
    {
      "side": "north",
      "baseMaterialId": "mat-stone",
      "bodyMaterialId": "mat-wood",
      "topMaterialId": null,
      "bays": 3,
      "windowWallRatio": null,
      "notes": null
    },
    {
      "side": "south",
      "baseMaterialId": "mat-stone",
      "bodyMaterialId": "mat-wood",
      "topMaterialId": null,
      "bays": 3,
      "windowWallRatio": null,
      "notes": null
    },
    {
      "side": "east",
      "baseMaterialId": "mat-stone",
      "bodyMaterialId": "mat-wood",
      "topMaterialId": null,
      "bays": 2,
      "windowWallRatio": null,
      "notes": null
    },
    {
      "side": "west",
      "baseMaterialId": "mat-stone",
      "bodyMaterialId": "mat-wood",
      "topMaterialId": null,
      "bays": 2,
      "windowWallRatio": null,
      "notes": null
    }
  ],
  "furniture": [
    {
      "id": "f-table",
      "name": "长茶桌",
      "kind": "table",
      "roomId": "tea",
      "anchor": { "kind": "center" },
      "footprint": { "x": 2, "z": 1 },
      "orientation": "south",
      "height": 1,
      "materialId": "mat-wood",
      "notes": null
    },
    {
      "id": "f-bench",
      "name": "北墙长凳",
      "kind": "bench",
      "roomId": "tea",
      "anchor": { "kind": "wall", "side": "north", "offset": 4 },
      "footprint": { "x": 3, "z": 1 },
      "orientation": "south",
      "height": 1,
      "materialId": "mat-wood",
      "notes": null
    }
  ],
  "decisions": [
    {
      "id": "dec-roof",
      "topic": "屋面",
      "choice": "双坡木屋面，脊线沿东西向",
      "rationale": "南向深檐框景稻田，同时形成可用的檐下平台。",
      "source": "agent",
      "requirementIds": ["req-tea"]
    }
  ],
  "open": []
}
```

`materials` 片段省略；实际提交必须包含 `mat-stone` / `mat-wood` / `mat-roof`。窗的 `height` / `sill` 用整数格，本示例取 1。

### 8.2 展开后的关键 DesignScheme 字段

```text
meta:   id=house-tea v1 status=draft scope=exterior+interior
        sourceRequirements={graphId:req-graph-tea, revision:3}
        budget={maxBlocks:20000, ...} forbidden=[host 注入]
site:   bounds=x[0,16) z[0,12); buildingBounds=x[3,11) y[1,4) z[3,9)
levels: [{id:f1, elevation:1, height:3}]
spaces: [{id:tea, bounds=x[3,11) y[1,4) z[3,9), area=48, connections:[]}]
walls:  wall-f1-x-z3-003-011  north  x[3,11) z[3,4) y[1,4)
        wall-f1-x-z9-003-011  south  x[3,11) z[8,9) y[1,4)
        wall-f1-z-x3-003-009  west   x[3,4) z[3,9) y[1,4)
        wall-f1-z-x11-003-009 east   x[10,11) z[3,9) y[1,4)
slabs:  slab-f1-tea y[0,1)（宿主约定 y=[elev-floorThickness,elev)）
roof:   form=gable eaveHeight=4 ridgeHeight=6 overhang=1
openings:
        open-entry  host=wall-f1-x-z9-003-011  bounds=x[6,8) y[1,3) z[8,9)
        win-north   host=wall-f1-x-z3-003-011  bounds=x[5,9) y[2,3) z[3,4)
interiors:
        [{spaceId:tea, included:true, furnitureSpecs:[f-table, f-bench]}]
counts: levels=1 rooms=1 walls=4 openings=2 furniture=2
warnings: entry-route-not-modeled
```

洞口的 y 在 `DesignScheme` 中是整数格；报告和 BuildSpec 都从 bounds 现算，不另存一套小数。示例中的窗为 `sill=1`、`height=1`。

## 9. 仍待决策

1. `ResolvedDesign` 是包装 `DesignScheme`，还是最终替换它？本规格推荐“包装 + 保留 `scheme`”，迁移成本最低。
2. `occupancy` / `daylight` 放进 `SchemeSpace` 可选字段，还是只放 `ResolvedDesign.facts`？推荐前者，报告可直接读；但要同步更新旧 fixture。
3. 墙带“外墙内缩、共享墙居中”的体素约定是否签字确认；这会影响门洞、家具内矩形和构建交接。
4. 多层 `exterior+interior` 是否强制每对相邻层有楼梯；本规格选择“强制失败”。
5. 目标面积偏差 >10% 是 warning 还是 error；本规格选择 warning，报告显示名义 / 目标差异。
6. 每个有外墙 side 强制一条 facade，是否会让小体量输出变长；本规格选择强制，以避免材质歧义。
7. 旧 `DesignScheme` 生成路径兼容多久；建议一个发布周期，之后只保留解析兼容。
8. 真实模型验收是否固定跑 3 个场景，还是最低 1 个茶亭；本规格建议最低 1 次、发布前 3 次。
