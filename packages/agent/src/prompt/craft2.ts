/**
 * craft2 变体的 system 附加段（DECOR-PLAN §3；owner 2026-10-04 已过目草稿）。
 *
 * 负责：保留 craft 的"形态方块提示 + 做法要点"，去掉旧 craft 里被取代的"立面层次：配色、开间、细部密度"段，
 *   换成 DECOR-PLAN §3 的"表面装饰"整段，再复用 craft 的三段范例；由 system.ts 在 `variant: 'craft2'` 时
 *   插到"工作方式"之后、world.d.ts 之前（与 craft 相同位置）。
 * 不负责：拼接与 variant 选择（system.ts）、范例能否通过预检（craft.integration.test.ts）。
 * 内容来源：docs/DECOR-PLAN.md §3，逐字照抄；不保留旧立面层次段，避免重复堆叠。
 */

import { CRAFT_EXAMPLES, CRAFT_HINTS } from './craft.ts';

/** 旧 craft 里被 §3 草稿取代的段落标题；craft2 不保留该段。 */
const OLD_LAYERS_HEADING = '## 立面层次：配色、开间、细部密度';

/**
 * DECOR-PLAN §3 的"表面装饰"整段（模型可见正文）。
 * 草稿原文含反引号，须转义；不含 `${`，模板插值安全。
 */
export const CRAFT2_DECOR = `## 表面装饰：明度分档、墙面条纹、屋面分色

构件只给体量。远看有没有层次，取决于下面四条；体量检查通过后逐条补。

### 1 明度分档（至少四档）

- 墙身中明度；墙脚、扶壁墩、塔角柱深一档；腰线、檐口、窗框、小尖塔浅一档；屋面最深。
- 浅档用 \`quartz_block\`、\`calcite\`、\`smooth_stone\`；深档用 \`polished_deepslate\`、\`deepslate_bricks\`；中档可用 \`polished_andesite\`。
- 相隔两档远看要分得开：\`chiseled_stone_bricks\` 配 \`stone_bricks\` 算同一档，不算对比。
- 扶壁墩不要和墙同材；墩、塔角柱、门窗框都要换档。

### 2 墙面条纹（按高度与开间）

- 每隔 6–8 格高，沿外墙一圈外凸 1 格的浅色腰线（用 \`ledge\` 写法；也可 \`walls.bands\` 换色后再补外凸层）。
- 每个开间从下到上：深色墙脚 → 外凸的深色扶壁墩 → 带浅框的窗 → 浅色腰线 → 墩顶小尖塔 → 檐口。
- 不留连续 5×5 以上的同材平墙；耳堂、唱诗班席、后殿、塔身也要按开间加墩、窗、腰线。

### 3 屋面分色（当前最缺）

- 坡面主材用 \`deepslate_tiles\`；每隔 2–3 层换 \`polished_blackstone_bricks\`，同一坡面交替。
- 屋脊整条用第三种材料压边（如 \`deepslate_bricks\`），檐口一圈浅色收边。
- 尖顶每 3 层换色；四角小尖塔用浅色帽 + 金色顶饰。
- 双坡、四坡的每个坡面都要照顾到，四面颜色节奏一致。

### 4 彩窗与塔尖

- 侧廊窗、高侧窗逐开间轮换 3–5 色玻璃；窗框比墙浅一档、外凸 1 格；玫瑰窗要有外圈对比框与辐条。
- 塔身每 2–3 层一道外凸腰线；四角角扶壁深一档，高出女儿墙后收成小尖塔。
- 小尖塔 ≥ 22 座：扶壁墩顶、塔角、山墙两肩、耳堂四角、中殿檐口每开间；写法 = 深色底座 + 浅色柱身 + 亮色顶饰，高 ≥ 4。

自查：数四向立面的明度档数、屋面的颜色种类、最大一块同材平墙；不够就补，不要靠加大体量。`;

/** 取 craft 提示里旧立面层次段之前的部分（那段与 §3 草稿二选一，不并存）。 */
function hintsBeforeOldLayers(hints: string): string {
  const at = hints.indexOf(OLD_LAYERS_HEADING);
  if (at < 0) throw new Error(`craft 提示缺少「${OLD_LAYERS_HEADING}」标题：craft2 无法切出保留段`);
  return hints.slice(0, at).replace(/\n+$/, '');
}

/** craft2 的做法提示：craft 的形态方块段与做法要点 + §3 表面装饰段。 */
export const CRAFT2_HINTS = `${hintsBeforeOldLayers(CRAFT_HINTS)}\n\n${CRAFT2_DECOR}`;

/** 插入 system 约定段与 world.d.ts 之间的整段：做法提示 + craft 的三段范例（标题之间一个空行）。 */
export const CRAFT2_SECTION = `${CRAFT2_HINTS}\n\n${CRAFT_EXAMPLES}`;
