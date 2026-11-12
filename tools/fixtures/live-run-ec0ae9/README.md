# live-run-ec0ae9 fixture

来源：`20261022-061757-build-task-ec0ae9`（第三次真实诊断构建，v13 交付，402 格）。
本目录只保留离线重放所需工件，不依赖 `.work`、不联网、不构建。

| 文件                        | 说明                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| `build-spec.json`           | 原会话 BuildSpec（sha256 `ea37e5b2…01ca6`）                              |
| `verified-must-map.json`    | 原会话确定性 planner 映射（mapping=verified）                            |
| `building.pgar`             | v13 交付存档（23,111 bytes，sha256 `bbd69540…80f6e`）                    |
| `conformance-diff.json`     | 用当前代码从上述输入重放生成；路径固定为本 fixture                       |
| `conformance-evidence.json` | 同上；met 12 / not-met 12 / unverified 17，acceptEligible=false          |
| `events.jsonl`              | 重放所需的 check/delivery/run.end 事件（seq 已重新编号）                 |
| `review.json`               | 从该 run 的 evidence / 事件生成的评审；not-satisfied / targeted-revision |
| `note.md`                   | `formatConformanceDeliveryNote` 生成的交付注记                           |
| `delivery.json`             | 交付标识 + 上述注记；noteSource=conformance-evidence                     |

## 第三次构建的已知事实

- 报告：pass 3 / fail 1 / unverified 3；blockingCount=2（slab bounds、北门 threshold）。
- 必须项：met 12 / not-met 12 / unverified 17 / waived 0；没有 accept。
- 12 个 not-met：`req-single-storey`、`req-no-partitions`、`req-no-glass-door`、
  `req-no-outdoor-zone`、`req-long-table`、`req-bench-north`、`req-bench-south`、
  `req-seats-10`、`req-stone-base`、`req-wood-wall-column`、
  `constraint-con-single-storey`、`constraint-con-material-selection`。
- 2 盏 ridge light（`f-light-ridge-e` / `f-light-ridge-w`）在 BuildSpec 里声明、但没有任何
  must 覆盖；它们不是“未归因 hard fail”，而是带理由的显式全局阻断
  （`globalBlockers`），并进入 `review.nextAction`。
- 北门 threshold 仍为 unverified：门外没有可测的相邻室外地面，不能用室内楼板代替。

## 12 个 not-met 的根因与配方

| must                                                 | 第三次构建的根因                                                                | 确定性配方                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `req-single-storey` / `constraint-con-single-storey` | 长凳用 `oak_stairs` 做座面；檐口以下任何 stairs 都被当成楼梯                    | 家具用整块 / slab，不用 stairs；屋面 stairs 不得低于檐口                              |
| `req-no-partitions`                                  | 桌椅由 fence+slab+stairs+carpet 拼成，未被识别为家具；柜台台面 slab 超出 bounds | 每件家具严格填满 `furnitureSpecs.bounds`，只用 `materialId` 的方块，bounds 外零附加物 |
| `req-no-glass-door`                                  | 窗台 slab 写进洞口 x5..8/y1/z9，实测洞口被撑到 y1，成落地玻璃                   | 洞口 bounds 内不写任何方块；窗台是洞口下沿的墙格；玻璃只占 y2..3                      |
| `req-no-outdoor-zone`                                | 四角 y0 砾石被 `absence:base-platform` 当成外挑平台                             | 建筑外皮外不放任何铺装；入口只留门宽×1 格齐平过渡带                                   |
| `req-long-table`                                     | 长桌用 fence 腿 + slab 面，未形成实际 furniture 对象                            | 4×2×1 实心体，x7..11/y1..2/z5..7，`m-wood`（oak_planks）                              |
| `req-bench-north`                                    | 长凳用 stairs+carpet，未形成 furniture 对象                                     | 4×1×1 实心体，x7..11/y1..2/z3..4，oak_planks；5 座                                    |
| `req-bench-south`                                    | 同上                                                                            | 4×1×1 实心体，x7..11/y1..2/z8..9，oak_planks；5 座                                    |
| `req-seats-10`                                       | 两条长凳均缺失，seatCapacity=0                                                  | 两条 4m 长凳各 5 座（0.8m/座）                                                        |
| `req-stone-base`                                     | y1 窗台 slab 与 y0 楼板连成一体，slab 实测厚 2；四角砾石成平台                  | `floorPlate` y0/thickness 1；石基座替换同一层周边格；y1 不放水平 slab；外皮外不放铺装 |
| `req-wood-wall-column`                               | 墙身用 oak + stripped_spruce 柱 + dark_oak 腰线，目标 `m-dark-wood` 只占 40%    | 墙格至少 90% 用 element 的 `m-dark-wood`；对比柱移出墙平面或用同材质                  |
| `constraint-con-material-selection`                  | 同上，`check:material:wall/structure` hard fail 归因到本 must                   | 同 `req-wood-wall-column`；语义材料 leaf 仍 unverified，不假 met                      |

修复后的 golden tea house 见 `tools/tea-house-golden.test.ts`：8 个 must 变为 met，4 个语义项保持 unverified 且理由明确。
