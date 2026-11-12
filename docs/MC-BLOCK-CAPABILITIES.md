# Minecraft 1.20.1 方块能力目录

> 由 `tools/build-block-catalog.ts` 生成，勿手改。机器可读版本：`assets/mc-1.20.1/block-capabilities.json`；
> 交互 / 构建提示引用：`@pg/blocks/capability-catalog`、`@pg/blocks/block-usages`。
>
> 数据来源：Minecraft 1.20.1 官方 blockstates / models / block tags（本机 `.work/mc-assets/1.20.1/`）
>
> - `tools/mc/curated-usages.json` 的人工组合用法。官方贴图 / 模型二进制不入库。
>   导入源 sha256：`56b71336d2b4fdffd197f56595b0da93e32a946f78f382a299b8f4b92758bb0f`（23028853 字节，client-jar）。

## 使用边界

- 状态字符串按 MC 1.20.1；只写与默认值不同的属性，例如 `oak_stairs[facing=east]` 等价于 half=bottom、shape=straight。
- “有碰撞”只描述方块自身，不替代结构计算；栏杆、悬挑、跨度仍需在方案里说明。
- 官方模型覆盖 882 个方块；箱子 / 床是 block entity，使用官方 entity 贴图 + 重建盒体，UV 为近似。
- 栅栏 / 玻璃板 / 墙的连接由渲染器按邻居计算；告示牌文字、容器内容、实体家具仍不支持。

## 方块表

| id                     | 中文             | 形状           | 状态 / 朝向                                                                                                                                                                                                                | 透明 | 发光 | 可放置面                                      | 碰撞                          | 标签                                                                            | 渲染     |
| ---------------------- | ---------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | --------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- | -------- |
| `andesite_wall`        | 安山岩墙         | wall           | east=none\|low\|tall（默认 none）<br>north=none\|low\|tall（默认 none）<br>south=none\|low\|tall（默认 none）<br>up=true\|false（默认 true）<br>waterlogged=true\|false（默认 false）<br>west=none\|low\|tall（默认 none） | 否   | 0    | 地面 / 相邻方块连接                           | 无完整碰撞（可穿过 / 仅装饰） | walls                                                                           | 官方模型 |
| `barrel`               | 木桶             | cube           | facing=north\|east\|south\|west\|up\|down（默认 north）<br>open=true\|false（默认 false）                                                                                                                                  | 否   | 0    | 地面 / 顶面 / 墙面                            | 有完整碰撞                    | guarded_by_piglins                                                              | 官方模型 |
| `bookshelf`            | 书架             | cube           | —                                                                                                                                                                                                                          | 否   | 0    | 地面 / 顶面 / 墙面                            | 有完整碰撞                    | enchantment_power_provider                                                      | 官方模型 |
| `campfire`             | 营火             | light          | facing=north\|south\|west\|east（默认 north）<br>lit=true\|false（默认 true）<br>signal_fire=true\|false（默认 false）<br>waterlogged=true\|false（默认 false）                                                            | 是   | 15   | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | campfires                                                                       | 官方模型 |
| `chain`                | 锁链             | other          | axis=x\|y\|z（默认 y）<br>waterlogged=true\|false（默认 false）                                                                                                                                                            | 是   | 0    | 顶面（axis=y 垂直悬挂）                       | 无完整碰撞（可穿过 / 仅装饰） | —                                                                               | 官方模型 |
| `chest`                | 箱子             | other          | facing=north\|south\|west\|east（默认 north）<br>type=single\|left\|right（默认 single）<br>waterlogged=true\|false（默认 false）                                                                                          | 否   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | features_cannot_replace<br>guarded_by_piglins<br>lava_pool_stone_cannot_replace | 官方模型 |
| `crafting_table`       | 工作台           | cube           | —                                                                                                                                                                                                                          | 否   | 0    | 地面 / 顶面 / 墙面                            | 有完整碰撞                    | —                                                                               | 官方模型 |
| `deepslate_tiles`      | 深板岩瓦         | cube           | —                                                                                                                                                                                                                          | 否   | 0    | 地面 / 顶面 / 墙面                            | 有完整碰撞                    | ancient_city_replaceable<br>sculk_replaceable_world_gen                         | 官方模型 |
| `flower_pot`           | 花盆             | other          | —                                                                                                                                                                                                                          | 是   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | flower_pots                                                                     | 官方模型 |
| `furnace`              | 熔炉             | cube           | facing=north\|south\|west\|east（默认 north）<br>lit=true\|false（默认 false）                                                                                                                                             | 否   | 0    | 地面 / 顶面 / 墙面                            | 有完整碰撞                    | —                                                                               | 官方模型 |
| `glass`                | 玻璃             | glass          | —                                                                                                                                                                                                                          | 是   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | impermeable                                                                     | 官方模型 |
| `glass_pane`           | 玻璃板           | pane           | east=true\|false（默认 false）<br>north=true\|false（默认 false）<br>south=true\|false（默认 false）<br>waterlogged=true\|false（默认 false）<br>west=true\|false（默认 false）                                            | 是   | 0    | 地面 / 相邻方块连接                           | 无完整碰撞（可穿过 / 仅装饰） | —                                                                               | 官方模型 |
| `hay_block`            | 干草捆           | cube           | axis=x\|y\|z（默认 y）                                                                                                                                                                                                     | 否   | 0    | 地面 / 顶面 / 墙面                            | 有完整碰撞                    | —                                                                               | 官方模型 |
| `ladder`               | 梯子             | other          | facing=north\|south\|west\|east（默认 north）<br>waterlogged=true\|false（默认 false）                                                                                                                                     | 是   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | climbable<br>fall_damage_resetting                                              | 官方模型 |
| `lantern`              | 灯笼             | light          | hanging=true\|false（默认 false）<br>waterlogged=true\|false（默认 false）                                                                                                                                                 | 是   | 15   | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | —                                                                               | 官方模型 |
| `lectern`              | 讲台             | other          | facing=north\|south\|west\|east（默认 north）<br>has_book=true\|false（默认 false）<br>powered=true\|false（默认 false）                                                                                                   | 否   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | —                                                                               | 官方模型 |
| `oak_button`           | 橡木按钮         | button         | face=floor\|wall\|ceiling（默认 wall）<br>facing=north\|south\|west\|east（默认 north）<br>powered=true\|false（默认 false）                                                                                               | 是   | 0    | 墙 / 地面 / 顶面（face=wall\|floor\|ceiling） | 无完整碰撞（可穿过 / 仅装饰） | buttons<br>wooden_buttons                                                       | 官方模型 |
| `oak_door`             | 橡木门           | door           | facing=north\|south\|west\|east（默认 north）<br>half=upper\|lower（默认 lower）<br>hinge=left\|right（默认 left）<br>open=true\|false（默认 false）<br>powered=true\|false（默认 false）                                  | 是   | 0    | 地面 / 墙面 / 楼板边                          | 无完整碰撞（可穿过 / 仅装饰） | doors<br>wooden_doors                                                           | 官方模型 |
| `oak_fence`            | 橡木栅栏         | fence          | east=true\|false（默认 false）<br>north=true\|false（默认 false）<br>south=true\|false（默认 false）<br>waterlogged=true\|false（默认 false）<br>west=true\|false（默认 false）                                            | 否   | 0    | 地面 / 相邻方块连接                           | 无完整碰撞（可穿过 / 仅装饰） | fences<br>wooden_fences                                                         | 官方模型 |
| `oak_fence_gate`       | 橡木栅栏门       | fence_gate     | facing=north\|south\|west\|east（默认 north）<br>in_wall=true\|false（默认 false）<br>open=true\|false（默认 false）<br>powered=true\|false（默认 false）                                                                  | 否   | 0    | 地面 / 墙面 / 楼板边                          | 无完整碰撞（可穿过 / 仅装饰） | fence_gates<br>unstable_bottom_center                                           | 官方模型 |
| `oak_planks`           | 橡木木板         | cube           | —                                                                                                                                                                                                                          | 否   | 0    | 地面 / 顶面 / 墙面                            | 有完整碰撞                    | planks                                                                          | 官方模型 |
| `oak_pressure_plate`   | 橡木压力板       | pressure_plate | powered=true\|false（默认 false）                                                                                                                                                                                          | 是   | 0    | 地面 / 实体方块顶面                           | 无完整碰撞（可穿过 / 仅装饰） | pressure_plates<br>wall_post_override<br>wooden_pressure_plates                 | 官方模型 |
| `oak_sign`             | 橡木告示牌       | other          | rotation=0\|1\|2\|3\|4\|5\|6\|7\|8\|9\|10\|11\|12\|13\|14\|15（默认 0）<br>waterlogged=true\|false（默认 false）                                                                                                           | 是   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | all_signs<br>signs<br>standing_signs<br>wall_post_override                      | fallback |
| `oak_slab`             | 橡木台阶         | slab           | type=top\|bottom\|double（默认 bottom）<br>waterlogged=true\|false（默认 false）                                                                                                                                           | 否   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | slabs<br>wooden_slabs                                                           | 官方模型 |
| `oak_stairs`           | 橡木楼梯         | stairs         | facing=north\|south\|west\|east（默认 north）<br>half=top\|bottom（默认 bottom）<br>shape=straight\|inner_left\|inner_right\|outer_left\|outer_right（默认 straight）<br>waterlogged=true\|false（默认 false）             | 否   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | stairs<br>wooden_stairs                                                         | 官方模型 |
| `oak_trapdoor`         | 橡木活板门       | trapdoor       | facing=north\|south\|west\|east（默认 north）<br>half=top\|bottom（默认 bottom）<br>open=true\|false（默认 false）<br>powered=true\|false（默认 false）<br>waterlogged=true\|false（默认 false）                           | 是   | 0    | 地面 / 墙面 / 楼板边                          | 无完整碰撞（可穿过 / 仅装饰） | trapdoors<br>wooden_trapdoors                                                   | 官方模型 |
| `oak_wall_sign`        | 墙上的橡木告示牌 | other          | facing=north\|south\|west\|east（默认 north）<br>waterlogged=true\|false（默认 false）                                                                                                                                     | 是   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | all_signs<br>signs<br>wall_post_override<br>wall_signs                          | fallback |
| `rail`                 | 铁轨             | other          | shape=north_south\|east_west\|ascending_east\|ascending_west\|ascending_north\|ascending_south\|south_east\|south_west\|north_west\|north_east（默认 north_south）<br>waterlogged=true\|false（默认 false）                | 是   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | prevent_mob_spawning_inside<br>rails                                            | 官方模型 |
| `red_bed`              | 红色床           | other          | facing=north\|south\|west\|east（默认 north）<br>occupied=true\|false（默认 false）<br>part=head\|foot（默认 foot）                                                                                                        | 是   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | beds                                                                            | 官方模型 |
| `scaffolding`          | 脚手架           | other          | bottom=true\|false（默认 false）<br>distance=0\|1\|2\|3\|4\|5\|6\|7（默认 7）<br>waterlogged=true\|false（默认 false）                                                                                                     | 是   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | climbable<br>fall_damage_resetting                                              | 官方模型 |
| `smooth_stone_slab`    | 平滑石头台阶     | slab           | type=top\|bottom\|double（默认 bottom）<br>waterlogged=true\|false（默认 false）                                                                                                                                           | 否   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | slabs                                                                           | 官方模型 |
| `stone_brick_slab`     | 石砖台阶         | slab           | type=top\|bottom\|double（默认 bottom）<br>waterlogged=true\|false（默认 false）                                                                                                                                           | 否   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | slabs                                                                           | 官方模型 |
| `stone_brick_stairs`   | 石砖楼梯         | stairs         | facing=north\|south\|west\|east（默认 north）<br>half=top\|bottom（默认 bottom）<br>shape=straight\|inner_left\|inner_right\|outer_left\|outer_right（默认 straight）<br>waterlogged=true\|false（默认 false）             | 否   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | stairs                                                                          | 官方模型 |
| `stone_brick_wall`     | 石砖墙           | wall           | east=none\|low\|tall（默认 none）<br>north=none\|low\|tall（默认 none）<br>south=none\|low\|tall（默认 none）<br>up=true\|false（默认 true）<br>waterlogged=true\|false（默认 false）<br>west=none\|low\|tall（默认 none） | 否   | 0    | 地面 / 相邻方块连接                           | 无完整碰撞（可穿过 / 仅装饰） | walls                                                                           | 官方模型 |
| `stone_bricks`         | 石砖             | cube           | —                                                                                                                                                                                                                          | 否   | 0    | 地面 / 顶面 / 墙面                            | 有完整碰撞                    | stone_bricks                                                                    | 官方模型 |
| `stone_pressure_plate` | 石头压力板       | pressure_plate | powered=true\|false（默认 false）                                                                                                                                                                                          | 是   | 0    | 地面 / 实体方块顶面                           | 无完整碰撞（可穿过 / 仅装饰） | pressure_plates<br>stone_pressure_plates<br>wall_post_override                  | 官方模型 |
| `torch`                | 火把             | light          | —                                                                                                                                                                                                                          | 是   | 14   | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | wall_post_override                                                              | 官方模型 |
| `trapped_chest`        | 陷阱箱           | other          | facing=north\|south\|west\|east（默认 north）<br>type=single\|left\|right（默认 single）<br>waterlogged=true\|false（默认 false）                                                                                          | 否   | 0    | 地面 / 顶面 / 墙面                            | 无完整碰撞（可穿过 / 仅装饰） | guarded_by_piglins                                                              | 官方模型 |
| `white_carpet`         | 白色地毯         | carpet         | —                                                                                                                                                                                                                          | 否   | 0    | 地面 / 实体方块顶面                           | 无完整碰撞（可穿过 / 仅装饰） | combination_step_sound_blocks<br>dampens_vibrations<br>wool_carpets             | 官方模型 |
| `white_wool`           | 白色羊毛         | cube           | —                                                                                                                                                                                                                          | 否   | 0    | 地面 / 顶面 / 墙面                            | 有完整碰撞                    | dampens_vibrations<br>occludes_vibration_signals<br>wool                        | 官方模型 |

## 常见组合用法

### 活板门做柜门 / 盖住立方体

- **用途**：把整块容器或柱子伪装成有门板的柜子、检修口，避免家具正面是一整块死板。
- **方块**：`oak_trapdoor`、`barrel`、`chest`
- **怎么放**：
  - 先放容器或承重方块，再把活板门贴在正面或顶面；活板门占用独立一格，不能和容器同格。
  - 柜门朝外：facing 写柜子正面朝向；半格在顶部用 half=top，底部用 half=bottom。
  - 要像打开的门板时写 open=true，但开口方向会翻转，先在一格上试放再整排复制。
- **状态示例**：`oak_trapdoor[facing=north,half=top,open=false]`、`oak_trapdoor[facing=north,half=bottom,open=true]`
- **常见错误**：
  - 把活板门写进结构层后被柜体覆盖：应在 'decoration' 层后写，或确保它不在同一格。
  - 整排柜门 facing 不一致，远看像锯齿；同一立面统一 facing，hinge 不需要。
  - 用 open=true 当关闭门板，结果门板立起来挡住通道。
- **适合**：柜台门、储物柜、阁楼检修口、柱子包板

### 活板门做地面检修口

- **用途**：在楼板上做可识别的地面开口、地窖门或设备检修口。
- **方块**：`oak_trapdoor`、`spruce_trapdoor`
- **怎么放**：
  - 楼板先留 1×2 格洞，再在洞边放活板门；关闭时 half=top 与楼板面齐平。
  - 洞口四周用 slab 或 stairs 收边，避免看到楼板断面。
  - 需要常开时 open=true 并让门板靠墙，不要悬在通道中间。
- **状态示例**：`oak_trapdoor[facing=east,half=top,open=false]`、`oak_trapdoor[facing=east,half=top,open=true]`
- **常见错误**：
  - half=bottom 会让门板沉到楼板下，表面出现凹坑。
  - 洞口大于 1×2 时中间没有支撑，看起来像破洞。
- **适合**：地窖口、设备层、阁楼爬梯口

### 楼梯做檐口 / 坡面

- **用途**：用倒置楼梯做外挑檐口、坡屋面收边或坡道，让轮廓有厚度而不是一块平板。
- **方块**：`oak_stairs`、`stone_brick_stairs`、`deepslate_tile_stairs`
- **怎么放**：
  - 檐口用 half=top 的倒置楼梯，高侧贴墙、低侧朝外，facing 指向墙外。
  - 坡屋面沿屋脊逐层退台，每层 facing 指向下坡方向，转角用 shape=inner_left / outer_left 收口。
  - 坡道或台阶用 half=bottom 的正放楼梯，facing 指向上坡。
- **状态示例**：`oak_stairs[facing=north,half=top,shape=straight]`、`oak_stairs[facing=east,half=bottom,shape=straight]`、`oak_stairs[facing=north,half=bottom,shape=inner_left]`
- **常见错误**：
  - facing 理解反：facing 是高侧 / 上坡方向，不是低侧。
  - 檐口只用 straight，转角露出断面；转角必须用 inner/outer。
  - 整圈檐口同一 facing，东、南、西、北四面要分别写。
- **适合**：檐口、坡屋面、室外台阶、坡道

### 楼梯做座椅 / 靠背

- **用途**：用一格楼梯同时表达座面和靠背，适合长凳、窗边座、讲台。
- **方块**：`oak_stairs`、`spruce_stairs`
- **怎么放**：
  - 座面用 half=bottom，靠背在后方再放一格 half=top 倒置楼梯，两格 facing 相反。
  - 靠墙长凳贴墙放，座面前方留 1 格以上通道。
  - 需要扶手时端头放 fence 或 wall，不要用整块。
- **状态示例**：`oak_stairs[facing=south,half=bottom,shape=straight]`、`oak_stairs[facing=north,half=top,shape=straight]`
- **常见错误**：
  - 靠背 facing 与座面相同，两个斜面同向，看起来像台阶而不是椅子。
  - 座面高度超过 1 格，人体尺度失真。
- **适合**：长凳、窗边座、讲台、阶梯座位

### 半砖做台面 / 柜台

- **用途**：用半砖压出约 0.5m 的台面、桌面或柜台面，和下方柜体形成明确收边。
- **方块**：`oak_slab`、`smooth_stone_slab`、`stone_brick_slab`
- **怎么放**：
  - 柜体用完整方块或 fence 做腿，台面在柜体顶面放 slab[type=bottom]。
  - 台面比柜体向外挑 1 格，形成 0.1–0.2m 的台沿。
  - 水槽、炉灶等嵌入设备用不同材质 slab 或 stairs 断开台面。
- **状态示例**：`oak_slab[type=bottom]`、`smooth_stone_slab[type=bottom]`、`stone_brick_slab[type=top]`
- **常见错误**：
  - 台面与柜体同材质同高度，远看是一整块，没有台沿。
  - 用 type=double 当台面，厚度变成 1m。
- **适合**：厨房台面、柜台、桌面、洗手台

### 半砖做窗台 / 压顶

- **用途**：在窗洞下沿和女儿墙顶做 0.5 格厚的窗台、压顶，交代室内外高差。
- **方块**：`smooth_stone_slab`、`oak_slab`、`stone_brick_slab`
- **怎么放**：
  - 窗台在窗洞下沿放 slab[type=bottom]，向室内外各挑 1 格。
  - 女儿墙、矮墙压顶用 slab[type=bottom] 或 stairs[half=top] 收头。
  - 同一立面窗台标高一致，窗台离室内地面约 0.9m。
- **状态示例**：`smooth_stone_slab[type=bottom]`、`stone_brick_slab[type=bottom]`
- **常见错误**：
  - 窗台只放室内一侧，外立面看到墙洞断面。
  - 窗台与窗框同材质，细部糊成一片。
- **适合**：窗台、女儿墙压顶、矮墙收头、壁龛层板

### 半砖做层板 / 架子

- **用途**：用半砖做薄层板，配合墙、栅栏或立柱形成书架、陈列架、厨房搁架。
- **方块**：`oak_slab`、`spruce_slab`
- **怎么放**：
  - 层板靠墙放 slab[type=bottom]，进深 1 格；需要更薄用 trapdoor 关闭状态。
  - 每层高度 2–3 格，层板下方可放 lantern 或 chain 补光。
  - 长层板每 4–6 格加一个 fence / wall 支点，避免视觉上悬空过长。
- **状态示例**：`oak_slab[type=bottom]`、`spruce_slab[type=bottom]`
- **常见错误**：
  - 层板全部同一高度，像一面墙；应按书籍 / 器物高度分组。
  - 层板悬挑超过 6 格且无支点。
- **适合**：书架、陈列架、厨房搁架、壁龛

### 栅栏 + 压力板做桌子

- **用途**：用栅栏做四条腿或中柱，压力板做薄桌面，得到 1 格宽、约 1m 高的轻桌。
- **方块**：`oak_fence`、`oak_pressure_plate`、`stone_pressure_plate`
- **怎么放**：
  - 桌腿用 fence 立柱，桌面在柱顶放 pressure_plate；1×1 小桌用单柱，长桌每 2–3 格一柱。
  - 桌面与座面高差保持 0.4–0.5 格；椅子可用 stairs 或 slab。
  - 桌面材质与腿区分，压力板颜色选浅一档。
- **状态示例**：`oak_fence`、`oak_pressure_plate`、`stone_pressure_plate`
- **常见错误**：
  - 压力板直接放地上当桌面，高度只有 0.1 格。
  - 桌腿用完整方块，桌子变成实心墩子，失去轻巧感。
  - 长桌只用两端腿，中间下垂没有支撑。
- **适合**：餐桌、茶几、工作台、室外咖啡桌

### 墙做栏杆 / 扶手

- **用途**：用墙方块做 1 格高实体栏杆、阳台扶手或楼梯扶手，端头自动收口。
- **方块**：`stone_brick_wall`、`andesite_wall`、`oak_fence`
- **怎么放**：
  - 沿临空边每格放 wall，转角自然连接；需要矮栏杆时用 slab 压顶或 fence。
  - 楼梯扶手随踏步升高，每级放一段 wall，底部与踏步对齐。
  - 长栏杆每 4–6 格加柱或端头墩，避免像连续矮墙。
- **状态示例**：`stone_brick_wall[up=true]`、`andesite_wall[up=true]`、`oak_fence`
- **常见错误**：
  - wall 与 fence 混用但高度不同，扶手忽高忽低。
  - 栏杆高度只有半格，起不到防护示意。
- **适合**：阳台栏杆、楼梯扶手、桥栏、院墙端头

### 玻璃板做隔断 / 室内窗

- **用途**：用玻璃板做不占满格的隔断、室内窗、屏风，保持视线和光线穿透。
- **方块**：`glass_pane`、`white_stained_glass_pane`
- **怎么放**：
  - 沿隔断线连续放 glass_pane，会自动连接成整片；端头接墙或立柱收口。
  - 室内窗嵌在墙洞中，窗框用 stairs / slab 或墙方块压边。
  - 需要磨砂感时用染色玻璃板，但同一隔断保持一种颜色。
- **状态示例**：`glass_pane`、`white_stained_glass_pane`
- **常见错误**：
  - 玻璃板悬空没有框，边缘看起来像碎片。
  - 隔断做到顶但没有门洞，空间不可达。
- **适合**：室内隔断、屏风、室内窗、淋浴间

### 按钮做把手 / 门铃

- **用途**：在柜门、门板、墙面做小尺度把手、门铃、开关，打破大平面。
- **方块**：`oak_button`、`stone_button`、`polished_blackstone_button`
- **怎么放**：
  - 按钮 face 取 wall 时贴墙，facing 指按钮正面朝向；floor / ceiling 用于台面和顶面。
  - 柜门把手放在门板靠开启侧，高度约 1m；成排柜门保持同一高度。
  - 按钮只做视觉把手，不承诺红石功能。
- **状态示例**：`oak_button[face=wall,facing=north]`、`stone_button[face=floor,facing=north]`
- **常见错误**：
  - face 与 facing 混用：face 是附着面，facing 是正面朝向。
  - 把按钮当结构连接件，实际没有支撑力。
- **适合**：柜门把手、门铃、开关面板、墙面小五金

### 地毯做薄面 / 分区

- **用途**：用 1/16 格厚的地毯标记地面分区、床前毯、楼梯踏面，不改变通行高度。
- **方块**：`white_carpet`、`red_carpet`、`moss_carpet`
- **怎么放**：
  - 地毯直接铺在实体楼板上，同色成片；不同色块表达座椅区、通行区。
  - 楼梯踏面可逐级铺地毯，但每级都要放，不能跨格。
  - 地毯不改变碰撞高度，可用于门槛过渡。
- **状态示例**：`white_carpet`、`red_carpet`
- **常见错误**：
  - 地毯悬空或铺在非实体方块上。
  - 用大片高饱和地毯抢过家具主色。
- **适合**：地面分区、床前毯、楼梯踏面、门槛过渡

### 压力板做薄面 / 桌面

- **用途**：用压力板做 1/16 格厚的桌面、台面或地面标记，比半砖更薄。
- **方块**：`oak_pressure_plate`、`stone_pressure_plate`
- **怎么放**：
  - 桌面放在 fence 柱顶，形成轻桌；地面标记直接放实体方块上。
  - 压力板只占一格，长桌需要逐格铺；边缘会露出细缝。
  - 不做红石触发承诺，只表达形态。
- **状态示例**：`oak_pressure_plate`、`stone_pressure_plate`
- **常见错误**：
  - 把压力板当半砖用，桌面过薄且没有厚度感。
  - 长桌中间漏铺，出现断缝。
- **适合**：轻桌面、地面标记、台面收边、门槛

### 灯笼 + 链做吊灯

- **用途**：用 chain 从顶面垂下，末端挂 lantern，形成室内吊灯或门廊灯。
- **方块**：`lantern`、`chain`、`soul_lantern`
- **怎么放**：
  - chain 写 axis=y 垂直悬挂，长度按净高取 1–3 格；末端放 lantern[hanging=true]。
  - 吊灯下沿距桌面 / 地面至少 2 格，避免碰头。
  - 成排吊灯间距 3–4 格，灯与桌中心对齐。
- **状态示例**：`chain[axis=y]`、`lantern[hanging=true]`、`lantern[hanging=false]`
- **常见错误**：
  - lantern 的 hanging 与放置面不一致：挂顶写 true，落台面写 false。
  - 链太长，灯低于 2 格净高。
  - 只在屋顶放灯，桌面和暗角仍然没光。
- **适合**：餐厅吊灯、门廊灯、楼梯间、柜台重点照明

### 花盆做桌面绿植

- **用途**：在窗台、柜台、角落放 1 格小花盆，增加尺度参照和生活感。
- **方块**：`flower_pot`、`potted_fern`、`potted_oak_sapling`
- **怎么放**：
  - flower_pot 直接放在实体台面或地面上，每处 1 盆即可。
  - 需要具体植物时用 potted_fern / potted_oak_sapling 等带植物花盆状态。
  - 成组放置时高低错落，但不要挡住通道和窗台采光。
- **状态示例**：`flower_pot`、`potted_fern`、`potted_oak_sapling`
- **常见错误**：
  - 花盆放在非实体方块或悬空。
  - 每个桌面都摆一盆，像样板间。
- **适合**：窗台、柜台、入口、角落点缀

### 箱子 / 桶做储物家具

- **用途**：用箱子或桶做床尾箱、储物柜、厨房储物，形成真实家具体量。
- **方块**：`chest`、`trapped_chest`、`barrel`、`ender_chest`
- **怎么放**：
  - chest 的 facing 指正面 / 锁扣朝向，靠墙或成排时统一 facing。
  - barrel 可立放或横放，facing 可取 up / down 表达桶口方向。
  - 两格并排的箱子会合并成大箱子，需要单箱时中间留空气或换桶。
- **状态示例**：`chest[facing=north]`、`barrel[facing=up]`、`barrel[facing=north]`
- **常见错误**：
  - 箱子正面朝墙，锁扣看不见。
  - 把箱子悬空放在楼板外。
  - 用箱子堆成整面墙，失去家具尺度。
- **适合**：床尾箱、储物柜、厨房储物、入口鞋柜

### 书架做隔断 / 背景墙

- **用途**：用书架做半隔断、书房背景墙或阅读角，兼作书籍收纳的视觉表达。
- **方块**：`bookshelf`、`chiseled_bookshelf`、`lectern`
- **怎么放**：
  - 书架靠墙成排，高度 2–3 格；作为隔断时留 1 格门洞或通道。
  - 书架前放 lectern 或桌椅，形成阅读位；不要挡住书脊。
  - 同一面书架保持同朝向，顶部用 slab 或 stairs 收头。
- **状态示例**：`bookshelf`、`chiseled_bookshelf`、`lectern[facing=north]`
- **常见错误**：
  - 书架做到顶但没有压顶，顶部露出方块断面。
  - 书架隔断不留通道，空间不可达。
- **适合**：书房背景墙、阅读角、半隔断、楼梯下收纳

### 告示牌做标识 / 菜单

- **用途**：在入口、柜台、房间门口做可读标识，补充家具与空间用途。
- **方块**：`oak_sign`、`oak_wall_sign`、`oak_hanging_sign`
- **怎么放**：
  - 站立牌用 oak_sign[rotation=0..15]，rotation 每 22.5° 一档；贴墙牌用 oak_wall_sign[facing=...]。
  - 牌面朝主要观看方向，入口牌放在门侧而不是门洞正中。
  - 同一区域牌的风格统一；文字内容由后续实体 / 数据层填写，本阶段只表达牌体。
- **状态示例**：`oak_sign[rotation=8]`、`oak_wall_sign[facing=north]`、`oak_hanging_sign[rotation=8]`
- **常见错误**：
  - 站立牌旋转值写成 0–15 以外的数。
  - 贴墙牌 facing 与墙相反，牌面朝墙。
- **适合**：入口标识、菜单牌、房间名牌、货架标签

### 梯子做阁楼 / 书架取物

- **用途**：在墙面做垂直爬梯、阁楼入口或书架滑梯，表达高差与使用方式。
- **方块**：`ladder`、`scaffolding`
- **怎么放**：
  - ladder 必须贴实体墙，facing 指梯子正面朝向房间；上下连续放置。
  - 梯子顶部与楼板洞口对齐，洞口边缘用 slab / stairs 收边。
  - scaffolding 可做临时工作台或开放搁架，但不要当永久结构。
- **状态示例**：`ladder[facing=north]`、`ladder[facing=east]`、`scaffolding`
- **常见错误**：
  - 梯子离开墙面悬空。
  - 梯子顶部被楼板封死，无法到达上层。
- **适合**：阁楼入口、书架取物、设备夹层、地下室

### 床做卧室壁龛

- **用途**：把床嵌入壁龛或靠墙布置，配合床头板、地毯和阅读灯形成完整卧室。
- **方块**：`red_bed`、`oak_trapdoor`、`oak_slab`
- **怎么放**：
  - 床占 2 格长、1 格宽，facing 指床头方向；part=head / foot 两格都要放。
  - 床头靠墙，床尾留 1 格以上通道；壁龛净宽至少 3 格。
  - 床头墙用 trapdoor / slab 做床头板，床侧放 lantern 或 chain 阅读灯。
- **状态示例**：`red_bed[facing=north,part=head]`、`red_bed[facing=north,part=foot]`
- **常见错误**：
  - 只放 part=head 或只放 foot，床缺一半。
  - 床放在门后或楼梯口，动线被堵。
  - 床两侧都贴墙，无法上下床。
- **适合**：卧室、客房、阁楼睡眠区、榻榻米式地台

### 火把做壁灯 / 桌灯

- **用途**：用火把或墙火把做低尺度点光，补充门廊、楼梯和桌面照明。
- **方块**：`torch`、`wall_torch`、`soul_torch`、`soul_wall_torch`
- **怎么放**：
  - 落地火把直接放实体方块上；壁挂用 wall_torch[facing=...]，facing 指火把伸出的方向。
  - 同一空间火把高度统一，通常高于桌面 1–2 格。
  - 需要更精致的吊灯时改用 lantern + chain。
- **状态示例**：`torch`、`wall_torch[facing=north]`、`soul_wall_torch[facing=east]`
- **常见错误**：
  - wall_torch 的 facing 写反，火把插进墙里。
  - 火把密度过高，空间像矿洞。
- **适合**：门廊、楼梯、桌面、暗角补光

### 栅栏门做室内隔断门

- **用途**：在需要通透的室内隔断、院门或花园入口做可识别的小门。
- **方块**：`oak_fence_gate`、`oak_fence`
- **怎么放**：
  - 栅栏门两侧接 fence 或墙，facing 指门关闭时跨越方向；open=true 时门扇转 90°。
  - 室内隔断门宽 1 格，通道两侧各留 1 格净空。
  - 同一排栅栏 / 门保持同一材质与高度。
- **状态示例**：`oak_fence_gate[facing=north,open=false]`、`oak_fence_gate[facing=north,open=true]`
- **常见错误**：
  - 门两侧没有 fence，门扇悬空。
  - open 状态与门洞方向不一致，门扇挡住通道。
- **适合**：院门、花园入口、室内通透隔断、动物栏

### 双开门 / 门框

- **用途**：在入口、客厅、庭院做双开门，配合门槛、门头和雨棚形成完整入口。
- **方块**：`oak_door`、`oak_slab`、`oak_stairs`
- **怎么放**：
  - 每扇门上下两格成对，half=lower / upper；facing 取进门方向，hinge=left/right 定开向。
  - 双开门左右镜像，两扇门在中间相遇；门洞净宽 2 格以上。
  - 门槛用 slab 或 stairs，门头用 stairs / slab 压顶，入口外侧做 1–2 级台阶。
- **状态示例**：`oak_door[facing=south,half=lower,hinge=left]`、`oak_door[facing=south,half=upper,hinge=left]`、`oak_door[facing=south,half=lower,hinge=right]`
- **常见错误**：
  - 只放半扇门或上下 half 不一致，门缺一半。
  - facing 写反，门扇开向墙内。
  - 两扇门 hinge 相同，门扇朝同一侧打开。
- **适合**：主入口、客厅、庭院门、店铺门面
