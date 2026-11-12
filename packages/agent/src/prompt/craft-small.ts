/**
 * craft-small 变体的 system 附加段：1–3 层小体量与室内质量。
 *
 * 负责：把"占地 8–30m、1–3 层、5k–30k 方块"的小建筑做法压成一段提示 + 三段短范例，
 *   由 system.ts 在 `variant: 'craft-small'` 时插到"工作方式"之后、world.d.ts 之前。
 * 不负责：拼接与 variant 选择（system.ts）；范例能否通过 world.d.ts 预检由
 *   craft-small.integration.test.ts 验证。
 * 内容来源：owner 2026-10-19 的"精致中小型建筑 + 室内 / 家具 / 楼层"转向要求；
 *   方块组合目录来自 @pg/blocks/block-usages（官方 1.20.1 资源 + 人工整理）。
 *   尺度、方块状态与写法按 Minecraft 1.20.1 / world.d.ts API 9。
 * 适用边界：1–3 层、占地 8–30m、5k–30k 方块的小建筑；巨构 / 教堂仍用 craft / craft2。
 *   修订时先跑小建筑样例、看 check 测量与渲染图，按证据改，不要凭印象加长。
 */

import { BLOCK_USAGE_PROMPT } from '@pg/blocks/block-usages';

/** 小体量与室内做法提示（模型可见正文）。 */
export const CRAFT_SMALL_HINTS = `## 小体量：尺度、比例与克制

目标：地上 1–3 层、占地 8–30m、总方块 5k–30k。先把下面这些数做对，再谈装饰。

- 真实人体尺度：层高 3.2–4.0m（楼板面到楼板面，扣楼板后室内净高约 2.7–3.6m）；门洞 2.1–2.4m（MC 门扇占 2 格，用门头/台阶/半砖补足，别留 3 格空门洞）；窗台离室内地面 0.8–1.0m；檐口外挑 0.6–2.0m，小建筑取 0.6–1.2m；栏杆/女儿墙 0.9–1.1m。
- 开间定节奏：主立面 3–5 个开间（最少 2 个），开间 2.5–4.5m；门窗按开间居中，先定开间再排墙、窗、家具。
- 从下到上至少四层：基座（深一档，可外凸 1 格）→ 墙身（中明度主材）→ 腰线/檐口（浅一档，外凸 1 格）→ 屋脊（最深或对比色）。平屋顶也要有女儿墙和压顶收边。
- 明度至少 3–4 档，相邻档远看要分得开（如 deepslate_tiles / spruce_planks / calcite）；不要整栋一个颜色，也不要用同色系錾制方块冒充对比。
- 克制：不要靠放大体量、堆尖塔、堆装饰取胜。小建筑天际线通常只留 0–3 个重点（主屋脊、入口山墙、烟囱/亭顶）；每个装饰都要有结构理由或重复规律。
- 外挑不超过墙高的 1/4；大屋檐会压垮小墙身。转角、端头要用半砖/楼梯/墙收口，不要露出断面。

## 室内：先排空间序列，再做家具

题面或设计报告明确要求室内、家具、楼层时，室内必须完成，不能只做空壳；室内质量与外观同等重要。

- 空间序列：入口/门厅 → 主空间（起居、厅堂、工作间）→ 次空间（卧室、厨房、储藏）→ 楼梯/后门。先用地毯或不同铺装标分区，再砌隔墙；每层至少一个可停留的主要空间。
- 楼板与楼层：floorPlate 铺到墙内；楼梯优先用 stair 构件，留 2 格以上头顶净空；楼板开洞与楼梯对齐，洞口边缘用 slab/stairs 收边；二层临空边栏杆 1 格高，不留缺口。
- 固定家具优先：长凳、书架、柜台、桌、床、储物（桶/箱子）、挂物。家具靠墙或围合出中心，不悬空摆在动线中央；窗下家具不高于窗台。
- 动线：门内 1.5m、楼梯口 1.2m 范围保持空净；主要通道净宽 ≥1m（2 格更舒服）。家具不挡门洞、楼梯口、窗台和室内视线。
- 室内视线：进门能看到一个焦点（窗、壁炉、主桌或楼梯），不要让主窗正对实墙；用窗、室内窗/栏杆、门洞把光引到深处。
- 采光：每个主要房间至少一扇外窗；进深超过 6m 的房间加室内窗、天窗或 lantern/chain 补光。没有光源的角落会变成黑洞。
- 家具尺度：桌面约 1m（fence + pressure_plate 或 slab），座面 0.5–1m，柜台 1–1.1m，床占 2 格长、1 格宽；同一房间的家具高度成组，不要高低乱跳。

## 有方向的方块：状态写全

门、活板门、栅栏门、楼梯、半砖都有方向或半格状态；只写方块名会得到默认朝向，门开向、坡向、正面都会错。

- stairs：facing 指向上坡/高侧，half=bottom|top，shape=straight|inner_left|inner_right|outer_left|outer_right。檐口、转角、家具收头都要写全。
- slab：type=bottom|top|double。窗台、压顶、台阶、桌面用不同 type 找高度。
- door：上下两格成对，half=lower|upper，facing 取进门方向（南立面的门写 north），hinge=left|right 定开向；双开门用 mirror，只写一半。
- trapdoor：facing 按安装面写，half=top|bottom，open=true|false。阁楼口、检修口、窗板、桌面都要写全。
- fence_gate：facing、open=true|false；院门和室内隔断门按开向写，同一排保持一致。
- pane / fence / wall 会自动连接；端头、转角补柱或收口，不要留半截。carpet、pressure_plate、button、sign、ladder、lantern、chain 也要按用途选状态：sign 分 standing（rotation）与 wall（facing），ladder 写 facing，chain 写 axis。
- 原木/木柱/竖纹方块：用 axis=x|y|z 明确方向，柱 axis=y、梁 axis=x/z；顶面年轮与侧面树皮观感不同，梁柱方向写反一眼能看出来。
- 同一构件不要六个面都靠一种方块：墙顶加压顶/檐口，墙脚换深色，窗洞内侧做窗套；顶面、侧面、室内背面都要有收口。

## 立面细部：小建筑靠收口

- 窗：窗框（浅一档、外凸 1 格）+ 窗台（slab/stairs，离地约 0.9m）+ 过梁/窗楣；同一立面的窗顶、窗台对齐，窗宽按开间。
- 门：门框 + 门头/雨棚；门槛与入口踏步按 BuildSheet / 题面。要求室内外齐平时不做门槛抬升、也不放踏步；只有图明确需要台阶时才用 steps 或 stair，不要用整块手堆。
- 腰线/檐口：沿外墙一圈外凸 1 格，用倒置 stairs 或 slab 收边；转角用墙/柱/半砖收口，不能断。
- 屋面：主屋面用 roof 构件（gable / hip / shed / flat）定形式与坡度；手工 stairs 只做局部细部或非主屋面，不要手搭主坡。平屋面用 roof kind:'flat' 做女儿墙 + 压顶 + 雨水口，落水管可用墙/栅栏/楼梯示意，颜色比墙深一档。
- 灯与栏杆：入口两侧、门廊、楼梯口各一盏 lantern（chain 吊灯写 axis=y）；临空边栏杆/女儿墙 0.9–1.1m，端头落到墙或柱上。
- 铺装：入口到主路用 paving 或石砖/半砖铺一条；门槛外踏步按 BuildSheet：要求齐平时不放踏步，只有图明确需要时才做；铺装与墙脚之间留一圈深色收边。

## 常见失败（交付前逐条自查）

- 缩小版哥特：小房子堆尖塔、飞扶壁和几十个尖顶，比例失真。小体量靠开间、收口、材质分档。
- 单色盒子：整栋一两种方块、六个面一个颜色；至少 3–4 档明度，墙脚/檐口/屋脊换色。
- 无收口平顶：平屋面直接截断，没有女儿墙、压顶、檐口，任何角度都像未完成。
- 超大屋檐压墙：外挑超过墙高 1/4，或雨棚低到挡窗；小建筑外挑 0.6–1.2m。
- 门洞被填死：门、活板门、窗内图案写在 structure/decoration 层，被 opening 的空气盖掉；这些要写 'opening' 层。
- 楼梯净空不足：楼板洞口比楼梯窄、转角没平台、头顶只剩 1 格；按 stair 的 path 和 check 的夹层/可达数字检查。
- 家具挡住动线：门内、楼梯口、窗前摆满家具；先留 1–1.2m 通道再放。
- 室内无光：只有外墙窗、进深大却不补光；主要房间至少一扇窗，暗角加灯。
- 室内空壳：有墙有顶却没有楼板、隔墙、家具；题面要求室内时，每层都要说得出主要空间和家具区。

${BLOCK_USAGE_PROMPT}`;

/** 三段短范例：檐口、窗框/窗台、室内家具与门/活板门状态（模型可见正文）。 */
export const CRAFT_SMALL_EXAMPLES = `## 范例代码

### 范例 1：小建筑檐口（外挑 1 格，转角收口）

\`\`\`ts
/** 小建筑檐口：沿墙顶外挑 1 格倒置楼梯（高侧贴墙），下沿一圈浅色半砖收边。 */
function eave(
  w: World,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
): void {
  const stair = (f: 'north' | 'south' | 'east' | 'west'): Material =>
    \`spruce_stairs[facing=\${f},half=top]\` as Material;
  const cap = 'smooth_stone_slab[type=bottom]' as Material;
  w.box([x0 - 1, y, z0 - 1], [x1 + 1, y, z0 - 1], stair('south')); // 北檐
  w.box([x0 - 1, y, z1 + 1], [x1 + 1, y, z1 + 1], stair('north')); // 南檐
  w.box([x0 - 1, y, z0], [x0 - 1, y, z1], stair('east')); // 西檐
  w.box([x1 + 1, y, z0], [x1 + 1, y, z1], stair('west')); // 东檐
  w.box([x0 - 1, y - 1, z0 - 1], [x0 - 1, y - 1, z1 + 1], cap);
  w.box([x1 + 1, y - 1, z0 - 1], [x1 + 1, y - 1, z1 + 1], cap);
  w.box([x0, y - 1, z0 - 1], [x1, y - 1, z0 - 1], cap);
  w.box([x0, y - 1, z1 + 1], [x1, y - 1, z1 + 1], cap);
}
// 用法：墙外皮 x0..x1 / z0..z1，墙顶 y；外挑 1 格，小建筑别再加大。
\`\`\`

### 范例 2：窗框与窗台（开洞后写在装饰层）

\`\`\`ts
/** 南立面窗：窗洞先由 opening 挖好；z 取墙外一格，窗框外凸 1 格。 */
function southWindow(
  w: World,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z: number,
): void {
  const jamb = 'stripped_spruce_log[axis=y]' as Material;
  w.box([x0 - 1, y0 - 1, z], [x1 + 1, y0 - 1, z], 'smooth_stone_slab[type=bottom]'); // 窗台
  w.box([x0 - 1, y0, z], [x0 - 1, y1, z], jamb); // 左框
  w.box([x1 + 1, y0, z], [x1 + 1, y1, z], jamb); // 右框
  w.box([x0 - 1, y1 + 1, z], [x1 + 1, y1 + 1, z], 'spruce_slab[type=bottom]'); // 过梁
}
// 用法：窗台离室内地面约 0.9m；同一排窗的 y0 / y1 对齐，窗宽按开间。
\`\`\`

### 范例 3：室内长凳、书架与门/活板门状态

\`\`\`ts
/** 靠墙长凳 + 书架：z 为贴墙的那一格，家具向房间内排，前面留 1.2m 通道。 */
function nook(w: World, x0: number, x1: number, z: number, y: number): void {
  w.box([x0, y + 1, z], [x1, y + 2, z], 'bookshelf'); // 书架两格高，避开窗洞
  w.box([x0, y, z + 1], [x1, y, z + 1], 'spruce_slab[type=bottom]'); // 长凳座面约 0.5m
}

/** 门与检修口：有方向的方块状态写全；门洞先由 opening 挖好。 */
function doorSet(w: World, x: number, y: number, z: number): void {
  // 门：上下成对；facing 取进门方向（南立面的门写 north），hinge 定开向
  w.set(x, y, z, 'spruce_door[facing=north,half=lower,hinge=left]', 'opening');
  w.set(x, y + 1, z, 'spruce_door[facing=north,half=upper,hinge=left]', 'opening');
  // 阁楼检修口：活板门写 facing / half / open
  w.set(x + 2, y + 4, z, 'spruce_trapdoor[facing=north,half=top,open=false]', 'opening');
}
// 门扇、活板门写在 'opening' 层，否则会被洞层的空气盖掉。
\`\`\``;

/** 插入 system 约定段与 world.d.ts 之间的整段（标题之间用一个空行分隔）。 */
export const CRAFT_SMALL_SECTION = `${CRAFT_SMALL_HINTS}\n\n${CRAFT_SMALL_EXAMPLES}`;
