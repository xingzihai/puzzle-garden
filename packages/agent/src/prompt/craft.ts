/**
 * craft 变体的 system 附加段（决策 #84、QUALITY-PLAN §3a K 线）。
 *
 * 负责：把 U1 上限测试重写的"形态方块做法提示"与三段范例（`ledge` 外挑线脚、`spire` 收分尖顶、
 *   `pinnacle` 小尖塔）原样保存成常量，由 system.ts 在 `variant: 'craft'` 时插到"工作方式"之后、world.d.ts 之前。
 * 不负责：拼接与 variant 选择（system.ts）、范例代码能否通过预检（craft.integration.test.ts）。
 * 内容来源：docs/runs/2026-10-04-ceiling.md 的 ②③ 两节，以及 docs/runs/2026-10-04-ceiling-gap.md §5
 *   的追加段与范例 3；只去掉报告自身的编号（②/③）与 token 统计行。
 */

/** ② 形态方块做法提示：什么部位用什么方块（模型可见正文）。 */
export const CRAFT_HINTS = `## 形态方块：什么部位用什么方块（做法提示）

构件只给体量；檐口、腰线、栏杆、门、尖顶收口这些细部要靠形态方块。看图时发现某个部位"一格一格是方的"，按下表换形态。状态写进方块名，如 \`stone_brick_stairs[facing=west,half=top]\`；镜像作用域里 facing、hinge 会自动翻转，只写东半边。

| 部位               | 用什么                              | 怎么写                                                                                                                                                |
| ------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 外挑腰线、檐下线脚 | 倒置楼梯 \`*_stairs[half=top]\`       | 沿墙外一圈，facing 指向墙（高侧贴墙），比整块外挑轻、有斜面阴影；颜色与墙面拉开（石英、方解石；錾制石砖与石砖远看同色，不算对比）                                                     |
| 檐口收边、平台压顶 | 半砖 \`*_slab\`                       | 女儿墙顶或屋面最外一圈放下半砖，顶面低半格，轮廓不再是整块台阶                                                                                        |
| 女儿墙、塔顶围栏   | 墙 \`*_wall\`                         | 一格高的 wall 会自动连成矮墙；用 \`rail({ along, material: 'stone_brick_wall' })\` 一次围合，角上再竖 2 格 wall + 灯笼当小尖塔                          |
| 尖顶、锥顶的坡面   | 楼梯                                | 逐层收分的尖顶，把下一层会收进去的那圈换成朝塔心的楼梯（facing 指向中心），台阶状轮廓变成连续坡                                                       |
| 飞扶壁、斜撑的上沿 | 楼梯                                | 阶梯石梁每级顶上放一格朝高端的楼梯；梁本体用整块保证面相连                                                                                            |
| 窗格、钟楼开口     | \`iron_bars\` 或 \`*_glass_pane\`       | 填进 opening 的 fill；pane 会自动连成细格。只有不填的洞才能接 steps                                                                                   |
| 门                 | \`*_door\` 上下两格                   | 下 \`half=lower\`、上 \`half=upper\`，facing 取进门方向（南立面的门写 north）；双开门用 mirror，hinge 自动翻转。门洞高于 2 格的部分填同木料 planks 当门楣 |
| 门框、窗框         | opening 的 \`frame\`                  | 不要手拼；frame 会凸出墙外 1 格，用石英、方解石；錾制石砖与石砖远看同色，不算对比                                                                                             |
| 台阶外挑、入口踏步 | \`steps\` / \`stair\`                   | 不要用整块手堆台阶；手堆的台阶测量会报"差一步"                                                                                                        |
| 墩顶、柱顶         | \`*_wall\` + \`end_rod\` / \`lantern\`    | 扶壁墩顶、塔角、山墙肩按范例 3 的 \`pinnacle\` 收成小尖塔；只叠 2 格 wall 加 end_rod 远看只是一根细杆                                                                                                  |
| 顶饰、避雷针       | \`lightning_rod\`、\`end_rod\`、\`chain\` | 尖顶最高一格之上放一格，不要再叠整块                                                                                                                  |

做法要点：

- 先用构件把体量、洞、楼梯做完并检查通过，再加形态方块；细部只写装饰层或开洞层能放下的地方，避免撞上楼梯净空与门框。
- 写进洞里的形态方块（门、玻璃图案）用 \`w.set(x, y, z, 方块, 'opening')\`，否则会被洞层的空气盖掉。
- 同一种细部写成一个辅助函数（如 \`ledge\`、\`spire\`），在 mirror 里调用，东西两半自然一致。
- 一种细部至少重复 3 处才值得加；零散一两处在远景里看不出来。

## 立面层次：配色、开间、细部密度

构件只给体量。远看有没有层次，取决于下面三条；体量检查通过后逐条补齐。

### 1. 配色：至少 4 档明度

- 墙身用中明度主材；墙脚、扶壁墩、塔角柱比墙身深一档；腰线、檐口、窗框、门框、小尖塔比墙身浅一档；屋面与尖顶最深。相邻两档远看要分得开：\`chiseled_stone_bricks\` 框配 \`stone_bricks\` 墙，远看是同一块灰墙。
- 浅档用 \`quartz_block\`、\`calcite\`、\`smooth_stone\`、\`polished_diorite\`；深档用 \`polished_deepslate\`、\`deepslate_bricks\`；中档可用 \`polished_andesite\`。
- 扶壁墩不要和墙身同材：深一档的墩竖排开来，开间节奏才看得出。
- 屋面至少两种材质：坡面主材加屋脊一线，尖顶每 3 层换一档（如 \`deepslate_tiles\` / \`polished_blackstone_bricks\`）。
- 彩窗按开间轮换 3–5 色（\`fill: GLASS[i % GLASS.length]\`），不要整排同色。

### 2. 每个开间叠够 6 层

一个开间从下到上依次是：深色墙脚 → 外凸 2–3 格的深色扶壁墩 → 带浅色框的窗 → 浅色外挑腰线或檐口（\`ledge\`）→ 墩顶小尖塔 → 屋檐。哥特侧立面再加：飞扶壁、高侧窗、高墙檐口外挑线脚、高墙墩顶小尖塔。整套写进一个按开间循环的函数，在 mirror 里调用。

### 3. 不留大面平墙，竖向拔高

- 连续 5×5 格同材同深就算平墙。耳堂端墙、唱诗班席、后殿、塔身也要按开间加墩、窗、腰线，不能只做中殿。
- 塔四角各立一根外凸 1 格、深一档的角柱，高出女儿墙后收成小尖塔，塔身显得细高。
- 高度类尺寸取题面范围上沿，宽度取下沿。
- 天际线尖端要多：塔角、山墙两肩、耳堂四角、每根扶壁墩顶都放小尖塔，整栋 30 个以上。

收尾自查：数天际线尖端、每开间层数、立面上最大一块平墙；不够就补细部，不要靠加大体量。`;

/** ③ 三段范例：外挑线脚 `ledge`、收分尖顶 `spire`、小尖塔 `pinnacle`（模型可见正文）。 */
export const CRAFT_EXAMPLES = `## 范例代码

### 范例 1：外挑线脚（塔身腰线、檐下线脚、女儿墙下沿都可套用）

\`\`\`ts
/** 外挑腰线：沿矩形外缘外一圈倒置楼梯（高侧贴墙），sides 指定哪几面。 */
function ledge(
  w: World,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
  sides: readonly ('north' | 'south' | 'east' | 'west')[],
): void {
  const m = (f: string): Material => \`quartz_stairs[facing=\${f},half=top]\` as Material;
  for (const side of sides) {
    if (side === 'east') w.box([x1 + 1, y, z0 - 1], [x1 + 1, y, z1 + 1], m('west'));
    if (side === 'west') w.box([x0 - 1, y, z0 - 1], [x0 - 1, y, z1 + 1], m('east'));
    if (side === 'south') w.box([x0, y, z1 + 1], [x1, y, z1 + 1], m('north'));
    if (side === 'north') w.box([x0, y, z0 - 1], [x1, y, z0 - 1], m('south'));
  }
}
// 用法：塔 rect(9,48,19,58)，每层层高 10、墙底 y=3：
// ledge(w, 9, 48, 19, 58, 3 + 10, ['east', 'south', 'north']);
\`\`\`

### 范例 2：收分尖顶（钟楼、攒尖亭、角楼小尖塔都可套用）

\`\`\`ts
/** 尖顶某层的半径：从 half 线性收到 0。 */
function spireR(half: number, height: number, i: number): number {
  return Math.max(0, Math.round(half * (1 - i / height)));
}
/** 半径 ≥ 2 时切掉四角成八角形。 */
function inSpire(r: number, dx: number, dz: number): boolean {
  const ax = Math.abs(dx);
  const az = Math.abs(dz);
  if (ax > r || az > r) return false;
  return r < 2 || ax + az <= 2 * r - 2;
}
/** 逐层收分；下一层会收进的外圈换成朝塔心的楼梯；顶上一格避雷针。各层实心，面相连。 */
function spire(w: World, cx: number, cz: number, y0: number, half: number, height: number): void {
  for (let i = 0; i < height; i += 1) {
    const r = spireR(half, height, i);
    const next = i + 1 < height ? spireR(half, height, i + 1) : -1;
    for (let dx = -r; dx <= r; dx += 1)
      for (let dz = -r; dz <= r; dz += 1) {
        if (!inSpire(r, dx, dz)) continue;
        if (next < 0 || r === 0 || inSpire(next, dx, dz)) {
          w.set(cx + dx, y0 + i, cz + dz, 'deepslate_tiles');
          continue;
        }
        const f = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'west' : 'east') : dz > 0 ? 'north' : 'south';
        w.set(cx + dx, y0 + i, cz + dz, \`deepslate_tile_stairs[facing=\${f}]\`);
      }
  }
  w.set(cx, y0 + height, cz, 'lightning_rod');
}
// 用法：放在平台 / 楼板的 top.y 上；楼梯出口不能落在尖顶占地里（会撞头顶净空）。
\`\`\`

### 范例 3：小尖塔（墩顶、塔角、山墙肩都可套用）

\`\`\`ts
/** 3×3 深色底座 2 格 + 浅色方柱 h 格 + 顶饰；放在实体墩顶或墙顶上。 */
function pinnacle(w: World, x: number, z: number, y0: number, h: number): void {
  w.box([x - 1, y0, z - 1], [x + 1, y0 + 1, z + 1], 'polished_deepslate');
  w.box([x, y0 + 2, z], [x, y0 + 1 + h, z], 'quartz_block');
  w.set(x, y0 + 2 + h, z, 'lightning_rod');
}
// 用法：扶壁墩顶 y=16 → pinnacle(w, 16, z, 16, 3)；塔女儿墙四角各一座。
\`\`\``;

/** 插入 system 约定段与 world.d.ts 之间的整段（标题之间用一个空行分隔）。 */
export const CRAFT_SECTION = `${CRAFT_HINTS}\n\n${CRAFT_EXAMPLES}`;
