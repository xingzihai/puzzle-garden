/**
 * 旧版简化几何（fallback）：画法编号、盒子表与朝向变换。
 *
 * 从 mesh.ts 拆出，保持零 import，Node 与浏览器共用。没有官方模型包时 mesh.ts 调用这里的
 * `legacyBoxes`；有官方模型时按 model id 走预计算几何。
 */

/** 画法编号（写入紧凑格表调色板的 u8）。0–9 为旧编号，保持不变。 */
export const PAINT = {
  skip: 0,
  cube: 1,
  glass: 2,
  slab: 3,
  stairs: 4,
  fence: 5,
  wall: 6,
  pane: 7,
  fluid: 8,
  small: 9,
  door: 10,
  trapdoor: 11,
  fence_gate: 12,
  carpet: 13,
  pressure_plate: 14,
  button: 15,
  plant: 16,
  sign: 17,
  chest: 18,
  /** 原木 / 木柱等轴向方块：盒子和 cube 相同，仅顶/底端面按轴提亮或压暗（无纹理近似）。 */
  axis_cube: 19,
} as const;

export type LegacyBox = readonly [number, number, number, number, number, number];
export type LegacyParams = readonly [number, number, number, number];

/** 柱子 + 臂的连接判断集合（RENDER-SPEC §6.2）。 */
export const CONNECT_PAINTS: ReadonlySet<number> = new Set([
  PAINT.cube,
  PAINT.axis_cube,
  PAINT.glass,
  PAINT.fence,
  PAINT.wall,
  PAINT.pane,
]);

/** 把北向臂盒子变换到其他方向（RENDER-SPEC §6.2）。 */
function transformArm(box: LegacyBox, dir: 'south' | 'west' | 'east'): LegacyBox {
  const [x0, y0, z0, x1, y1, z1] = box;
  if (dir === 'south') return [x0, y0, 16 - z1, x1, y1, 16 - z0];
  if (dir === 'west') return [z0, y0, x0, z1, y1, x1];
  return [16 - z1, y0, x0, 16 - z0, y1, x1];
}

/** 贴格边薄板：facing 取薄板所在边（北 z0..3、南 z13..16、西 x0..3、东 x13..16），视觉近似。 */
function facingEdgeBox(facing: number, y0: number, y1: number, thickness: number): LegacyBox {
  if (facing === 0) return [0, y0, 0, 16, y1, thickness];
  if (facing === 2) return [0, y0, 16 - thickness, 16, y1, 16];
  if (facing === 3) return [0, y0, 0, thickness, y1, 16];
  return [16 - thickness, y0, 0, 16, y1, 16];
}

/** 楼梯上层踏步。shape：0 straight、1 outer_left、2 outer_right、3 inner_left、4 inner_right。 */
function stairsStepBoxes(params: LegacyParams): readonly LegacyBox[] {
  const [facing, half, shape] = params;
  const [y0, y1] = half === 1 ? [0, 8] : [8, 16];
  const dir = facing === 1 ? 'east' : facing === 2 ? 'south' : facing === 3 ? 'west' : null;
  const rotate = (box: LegacyBox): LegacyBox => (dir === null ? box : transformArm(box, dir));
  if (shape === 1) return [rotate([0, y0, 0, 8, y1, 8])];
  if (shape === 2) return [rotate([8, y0, 0, 16, y1, 8])];
  if (shape === 3) return [rotate([0, y0, 8, 16, y1, 16]), rotate([0, y0, 0, 8, y1, 8])];
  if (shape === 4) return [rotate([0, y0, 8, 16, y1, 16]), rotate([8, y0, 0, 16, y1, 8])];
  return [rotate([0, y0, 0, 16, y1, 8])];
}

/** 门：关闭时贴 facing 边；打开时绕铰链转 90° 贴到相邻边。half 只保留参数，两半共享同一块连续门板。 */
function doorBoxes(params: LegacyParams): readonly LegacyBox[] {
  const [facing, , hinge, open] = params;
  if (open === 1) {
    if (facing === 0) return [hinge === 0 ? [13, 0, 0, 16, 16, 16] : [0, 0, 0, 3, 16, 16]];
    if (facing === 2) return [hinge === 0 ? [0, 0, 0, 3, 16, 16] : [13, 0, 0, 16, 16, 16]];
    if (facing === 1) return [hinge === 0 ? [0, 0, 13, 16, 16, 16] : [0, 0, 0, 16, 16, 3]];
    return [hinge === 0 ? [0, 0, 0, 16, 16, 3] : [0, 0, 13, 16, 16, 16]];
  }
  return [facingEdgeBox(facing, 0, 16, 3)];
}

/** 活板门：关闭时是 3/16 高的水平板；打开时贴在 facing 边，变成竖直板。 */
function trapdoorBoxes(params: LegacyParams): readonly LegacyBox[] {
  const [facing, half, , open] = params;
  if (open === 1) return [facingEdgeBox(facing, 0, 16, 3)];
  const [y0, y1] = half === 1 ? [13, 16] : [0, 3];
  return [[0, y0, 0, 16, y1, 16]];
}

const GATE_ALONG_X: readonly LegacyBox[] = [
  [0, 0, 6, 3, 16, 10],
  [13, 0, 6, 16, 16, 10],
  [3, 3, 6, 13, 6, 10],
  [3, 10, 6, 13, 13, 10],
];
const GATE_ALONG_Z: readonly LegacyBox[] = [
  [6, 0, 0, 10, 16, 3],
  [6, 0, 13, 10, 16, 16],
  [6, 3, 3, 10, 6, 13],
  [6, 10, 3, 10, 13, 13],
];

function fenceGateBoxes(params: LegacyParams): readonly LegacyBox[] {
  const [facing, , , open] = params;
  const northSouth = facing === 0 || facing === 2;
  return northSouth !== (open === 1) ? GATE_ALONG_X : GATE_ALONG_Z;
}

function buttonBoxes(params: LegacyParams): readonly LegacyBox[] {
  const [face, facing] = params;
  const [x0, z0, x1, z1] = facing === 0 || facing === 2 ? [6, 5, 10, 11] : [5, 6, 11, 10];
  if (face === 0) return [[x0, 0, z0, x1, 2, z1]];
  if (face === 2) return [[x0, 14, z0, x1, 16, z1]];
  if (facing === 0) return [[5, 5, 0, 11, 11, 3]];
  if (facing === 2) return [[5, 5, 13, 11, 11, 16]];
  if (facing === 3) return [[0, 5, 5, 3, 11, 11]];
  return [[13, 5, 5, 16, 11, 11]];
}

function plantBoxes(params: LegacyParams): readonly LegacyBox[] {
  const height = params[0] <= 0 ? 12 : params[0];
  return [
    [7, 0, 0, 9, height, 16],
    [0, 0, 7, 16, height, 9],
  ];
}

function signBoxes(params: LegacyParams): readonly LegacyBox[] {
  const [kind, orientation] = params;
  if (kind === 1) {
    if (orientation === 0) return [[1, 6, 0, 15, 14, 2]];
    if (orientation === 2) return [[1, 6, 14, 15, 14, 16]];
    if (orientation === 3) return [[0, 6, 1, 2, 14, 15]];
    return [[14, 6, 1, 16, 14, 15]];
  }
  if (orientation % 2 === 0)
    return [
      [1, 6, 7, 15, 14, 9],
      [3, 0, 7, 4, 6, 9],
      [12, 0, 7, 13, 6, 9],
    ];
  return [
    [7, 6, 1, 9, 14, 15],
    [7, 0, 3, 9, 6, 4],
    [7, 0, 12, 9, 6, 13],
  ];
}

function chestBoxes(params: LegacyParams): readonly LegacyBox[] {
  const [facing] = params;
  const body: LegacyBox = [1, 0, 1, 15, 14, 15];
  if (facing === 0) return [body, [7, 7, 0, 9, 9, 1]];
  if (facing === 2) return [body, [7, 7, 15, 9, 9, 16]];
  if (facing === 3) return [body, [0, 7, 7, 1, 9, 9]];
  return [body, [15, 7, 7, 16, 9, 9]];
}

function slabBox(params: LegacyParams): LegacyBox {
  return params[0] === 1 ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16];
}

/** 该格所有盒子的列表；臂的取舍由邻居连接决定。 */
export function legacyBoxes(
  paint: number,
  params: LegacyParams,
  connected: readonly [boolean, boolean, boolean, boolean],
): readonly LegacyBox[] {
  switch (paint) {
    case PAINT.cube:
    case PAINT.axis_cube:
    case PAINT.glass:
      return [[0, 0, 0, 16, 16, 16]];
    case PAINT.slab:
      return [slabBox(params)];
    case PAINT.stairs: {
      const base: LegacyBox = params[1] === 1 ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16];
      return [base, ...stairsStepBoxes(params)];
    }
    case PAINT.fence: {
      const out: LegacyBox[] = [[6, 0, 6, 10, 16, 10]];
      const arms: LegacyBox[] = [
        [7, 6, 0, 9, 9, 6],
        [7, 12, 0, 9, 15, 6],
      ];
      if (connected[0]) for (const a of arms) out.push(transformArm(a, 'west'));
      if (connected[1]) for (const a of arms) out.push(transformArm(a, 'east'));
      if (connected[2]) for (const a of arms) out.push(transformArm(a, 'south'));
      if (connected[3]) for (const a of arms) out.push(a);
      return out;
    }
    case PAINT.wall: {
      const out: LegacyBox[] = [[4, 0, 4, 12, 16, 12]];
      const arm: LegacyBox = [5, 0, 0, 11, 14, 4];
      if (connected[0]) out.push(transformArm(arm, 'west'));
      if (connected[1]) out.push(transformArm(arm, 'east'));
      if (connected[2]) out.push(transformArm(arm, 'south'));
      if (connected[3]) out.push(arm);
      return out;
    }
    case PAINT.pane: {
      const out: LegacyBox[] = [[7, 0, 7, 9, 16, 9]];
      const arm: LegacyBox = [7, 0, 0, 9, 16, 7];
      if (connected[0]) out.push(transformArm(arm, 'west'));
      if (connected[1]) out.push(transformArm(arm, 'east'));
      if (connected[2]) out.push(transformArm(arm, 'south'));
      if (connected[3]) out.push(arm);
      return out;
    }
    case PAINT.fluid:
      return [[0, 0, 0, 16, 14, 16]];
    case PAINT.door:
      return doorBoxes(params);
    case PAINT.trapdoor:
      return trapdoorBoxes(params);
    case PAINT.fence_gate:
      return fenceGateBoxes(params);
    case PAINT.carpet:
      return [[0, 0, 0, 16, 1, 16]];
    case PAINT.pressure_plate:
      return [[1, 0, 1, 15, 1, 15]];
    case PAINT.button:
      return buttonBoxes(params);
    case PAINT.plant:
      return plantBoxes(params);
    case PAINT.sign:
      return signBoxes(params);
    case PAINT.chest:
      return chestBoxes(params);
    default:
      return [[4, 0, 4, 12, 8, 12]];
  }
}

/** 轴向方块端面亮度（无纹理近似）：正端提亮、负端压暗，侧面 base；params[0] 0=y、1=x、2=z。 */
export function faceTint(paint: number, params: LegacyParams, face: number): number {
  if (paint !== PAINT.axis_cube) return 1;
  const axis = params[0];
  const positive = axis === 1 ? 0 : axis === 2 ? 4 : 2;
  const negative = axis === 1 ? 1 : axis === 2 ? 5 : 3;
  if (face === positive) return 1.18;
  if (face === negative) return 0.82;
  return 1;
}
