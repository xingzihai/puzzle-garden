/**
 * v02hint 变体的 system 附加段（对照实验）：v0.2 原版提示的"材质与形态"一节删减稿。
 *
 * 负责：把 v0.2 仓库 `v0.2beta/agent/prompts/builder-v6.md` 的"材质与形态"一节里、与本题无关的
 *   v0.2 专属部分删去后原样保存成常量，由 system.ts 在 `variant: 'v02hint'` 时插到"工作方式"之后、
 *   world.d.ts 之前（与 craft 相同位置）。
 * 不负责：拼接与 variant 选择（system.ts）。仅做删减：未改写、未扩充任何措辞。
 */

/** v0.2 原版"材质与形态"一节的删减稿（模型可见正文）。 */
export const V02HINT_SECTION = `## 形态方块：什么部位用什么方块（v0.2 原版提示，删减）

- 可用形态：slab（半砖）、stairs（楼梯）、fence（栅栏）、fence_gate（栅栏门）、wall（墙）、pane（玻璃板）、door（门）、trapdoor（活板门）、button（按钮）、pressure_plate（压力板）、carpet（地毯）等，都能直接用方块名摆放。
- 场景→形态（先想场景，再选形态）：台阶 / 踏步 / 旋梯用 stairs；半砖 / 檐口收边用 slab；门洞用 door（上下各放一块）；检修口 / 盖板 / 舱口用 trapdoor；薄隔断 / 窗格用 pane；围栏 / 栏杆用 fence、栅栏门用 fence_gate；矮隔墙 / 女儿墙用 wall（形态）；地面纹理用 carpet；墙面开关用 button、踏板用 pressure_plate。发现自己用整块方块手拼台阶 / 门框 / 栏杆时，换成对应形态方块。
- 外形与特性必须与原版一致：占格、连接、透明、发光等行为对齐原版；纹理 / 颜色渲染允许与原版有差异。
`;
