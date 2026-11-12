/**
 * 地下综合体的部件生成：影院厅、层间楼梯模块、电梯井、三家商铺、地表公园与两座玻璃入口。
 *
 * 负责：把 BLUEPRINT-EXAMPLE 的尺寸表变成轴对齐盒 / 楔体的 Element 列表，参数化到可整体平移或加宽。
 * 不负责：把部件摆到总平面上、楼层 / 空间 / 净空定义与版本选择（见 example.ts）；
 * 也不做求交（checks.ts）与 schema 校验（schema.ts）。
 *
 * 约定：坐标绝对、y=0 为真实街面；level 用 example.ts 定义的 surface / b1 / b2 / b3。
 * 挑高墙、贯穿多层的楼梯按所在起始楼层归级，不跨级重复登记；差异与解释写进 example.ts 的 notes。
 */
import type { Element } from './schema.ts';
import type { BoxTuple } from './example-geometry.ts';
import { batchSteps, batchWalls, boxes } from './example-geometry.ts';

/** 草模色板；只表达材料意图，不承诺成品材质。 */
export const PALETTE = {
  exteriorWall: '#8d949b',
  interiorWall: '#b9bec3',
  slab: '#c3c8cc',
  stair: '#9aa2ab',
  wood: '#a9744f',
  glazing: '#8fd0e0',
  screenConcrete: '#2c2f33',
  screenGlass: '#cfe9f2',
  seat: '#b5533c',
  metal: '#6d757d',
  grass: '#6fae5a',
  pavement: '#cfc9b4',
  road: '#8b8f94',
  counter: '#d8d2c4',
  fixture: '#c9b48f',
  quartz: '#e3e6e8',
  redConcrete: '#a8422f',
  marker: '#ffcc00',
} as const;

/** 门洞上方的墙过梁（beam）；与整段墙用同一份 box 定义，不另写一套几何。 */
function beam(
  id: string,
  name: string,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  color: string = PALETTE.interiorWall,
): BoxTuple {
  return [id, name, 'wall', min, max, color];
}

/** 层间 8 单位高差楼梯模块的参数：模块外包 22×14，局部 u=x−originX、v=z−originZ。 */
export interface StairModuleParams {
  readonly idPrefix: string;
  readonly name: string;
  /** 模块起始楼层 id（元素归此级；上层平台接上一层）。 */
  readonly level: string;
  readonly originX: number;
  readonly originZ: number;
  /** 下层楼面顶面标高 F；模块从 F 上到 F+8。 */
  readonly baseFloor: number;
  /** 是否加一圈外墙（影院组在 B2 经过但不向站台开门时用）；默认 false。 */
  readonly enclosure?: boolean;
  /** 电梯门开在哪端：base 下层、top 上层、both 两端、none 全封；默认 base。 */
  readonly liftDoor?: 'base' | 'top' | 'both' | 'none';
}

/**
 * 生成一组「两跑折返 + 近端上下平台 + 远端折返平台 + 静态电梯井 + 扶梯预留标记」。
 * 电梯井内净 3×3、北面 2 宽门洞；扶梯只留标记，不当作已交付扶梯（notes 说明）。
 */
export function stairModule(params: StairModuleParams): Element[] {
  const { originX: ox, originZ: oz, level, baseFloor: f, idPrefix: p, name } = params;
  const shell: BoxTuple[] = [
    [`${p}-landing-low`, `${name}下平台`, 'slab', [ox + 1, f - 1, oz], [ox + 4, f, oz + 4], PALETTE.slab],
    // 近端上平台占 u[4,8)：与上一段的下平台 u[1,4) 拼成完整 u[1,8) 转接平台（影院叠梯中转不断路）。
    [`${p}-landing-high`, `${name}上平台`, 'slab', [ox + 4, f + 7, oz], [ox + 8, f + 8, oz + 4], PALETTE.slab],
    [`${p}-landing-mid`, `${name}折返平台`, 'slab', [ox + 1, f + 3, oz + 8], [ox + 8, f + 4, oz + 11], PALETTE.slab],
    [`${p}-divider`, `${name}中隔`, 'wall', [ox + 4, f, oz + 4], [ox + 5, f + 4, oz + 8], PALETTE.interiorWall],
    [`${p}-lift-floor`, `${name}电梯井底`, 'slab', [ox + 10, f - 1, oz + 1], [ox + 15, f, oz + 6], PALETTE.metal],
    [
      `${p}-escalator-reserved`,
      `${name}扶梯预留`,
      'marker',
      [ox + 16, f, oz],
      [ox + 21, f + 1, oz + 14],
      PALETTE.marker,
    ],
  ];
  // 电梯门按停靠标高开：base 门 [f,f+3)；top 门 [f+8,f+11)（站立面在 f+8）。
  const doorBase = params.liftDoor !== 'top' && params.liftDoor !== 'none';
  const doorTop = params.liftDoor === 'top' || params.liftDoor === 'both';
  // 有 top 门时井壁盖到上平台上方 f+12；只有 base 的叠放低段停在 f+8，不封上段。
  const shellTop = doorTop ? f + 12 : f + 8;
  shell.push(
    [`${p}-lift-w`, `${name}电梯西井壁`, 'wall', [ox + 10, f, oz + 1], [ox + 11, shellTop, oz + 6], PALETTE.metal],
    [`${p}-lift-e`, `${name}电梯东井壁`, 'wall', [ox + 14, f, oz + 1], [ox + 15, shellTop, oz + 6], PALETTE.metal],
    [`${p}-lift-s`, `${name}电梯南井壁`, 'wall', [ox + 10, f, oz + 5], [ox + 15, shellTop, oz + 6], PALETTE.metal],
    [`${p}-lift-n-w`, `${name}电梯北井壁`, 'wall', [ox + 10, f, oz + 1], [ox + 11, shellTop, oz + 2], PALETTE.metal],
    [`${p}-lift-n-e`, `${name}电梯北井壁`, 'wall', [ox + 13, f, oz + 1], [ox + 15, shellTop, oz + 2], PALETTE.metal],
  );
  // 北井壁中段：门洞之外补墙（含 top 门上方的过梁），洞口按停靠标高精确开。
  const openings: (readonly [number, number])[] = [];
  if (doorBase) openings.push([f, f + 3]);
  if (doorTop) openings.push([f + 8, f + 11]);
  openings.sort((a, b) => a[0] - b[0]);
  let cursor = f;
  let beamIndex = 0;
  for (const [openingFrom, openingTo] of openings) {
    if (openingFrom > cursor) {
      beamIndex += 1;
      shell.push(
        beam(
          `${p}-lift-n-beam-${String(beamIndex)}`,
          `${name}电梯北井壁`,
          [ox + 11, cursor, oz + 1],
          [ox + 13, openingFrom, oz + 2],
          PALETTE.metal,
        ),
      );
    }
    cursor = Math.max(cursor, openingTo);
  }
  if (cursor < shellTop) {
    beamIndex += 1;
    shell.push(
      beam(
        `${p}-lift-n-beam-${String(beamIndex)}`,
        `${name}电梯北井壁`,
        [ox + 11, cursor, oz + 1],
        [ox + 13, shellTop, oz + 2],
        PALETTE.metal,
      ),
    );
  }
  // 静态停靠平台（井外北侧，不遮井内净空、不占楼梯）；top 另加跨井壁门槛。
  if (doorBase) {
    shell.push([
      `${p}-lift-stop-base`,
      `${name}电梯下停靠平台`,
      'slab',
      [ox + 10, f - 1, oz],
      [ox + 15, f, oz + 1],
      PALETTE.pavement,
    ]);
  }
  if (doorTop) {
    shell.push(
      [
        `${p}-lift-stop-top`,
        `${name}电梯上停靠平台`,
        'slab',
        [ox + 10, f + 7, oz],
        [ox + 15, f + 8, oz + 1],
        PALETTE.pavement,
      ],
      [
        `${p}-lift-threshold-top`,
        `${name}电梯上门口槛`,
        'slab',
        [ox + 11, f + 7, oz + 1],
        [ox + 13, f + 8, oz + 2],
        PALETTE.pavement,
      ],
    );
  }
  if (params.enclosure === true) {
    // 影院组经过 B2 但不向站台开门：整圈外墙，北面上段在楼梯口与电梯口开洞。
    shell.push(
      [`${p}-enc-w`, `${name}西外墙`, 'wall', [ox, f, oz], [ox + 1, f + 8, oz + 14], PALETTE.exteriorWall],
      [`${p}-enc-e`, `${name}东外墙`, 'wall', [ox + 21, f, oz], [ox + 22, f + 8, oz + 14], PALETTE.exteriorWall],
      [`${p}-enc-s`, `${name}南外墙`, 'wall', [ox, f, oz + 13], [ox + 22, f + 8, oz + 14], PALETTE.exteriorWall],
      [`${p}-enc-n-low`, `${name}北外墙下段`, 'wall', [ox, f, oz], [ox + 22, f + 4, oz + 1], PALETTE.exteriorWall],
      [`${p}-enc-n-uw`, `${name}北外墙西上段`, 'wall', [ox, f + 4, oz], [ox + 4, f + 8, oz + 1], PALETTE.exteriorWall],
      [
        `${p}-enc-n-ue`,
        `${name}北外墙东上段`,
        'wall',
        [ox + 15, f + 4, oz],
        [ox + 22, f + 8, oz + 1],
        PALETTE.exteriorWall,
      ],
    );
  }
  const out = boxes(level, shell);
  // 第一跑向南上升 4 级；第二跑折返向北上升 4 级，两级梯板沿轴区间相邻、竖向不重叠。
  out.push(
    ...batchSteps([
      [`${p}-run1`, `${name}第一跑`, level, PALETTE.stair, 'z', oz + 4, oz + 8, ox + 1, 3, f, f + 1, 1, 4],
      [`${p}-run2`, `${name}第二跑`, level, PALETTE.stair, 'z', oz + 4, oz + 8, ox + 5, 3, f + 4, f + 8, -1, 4],
    ]),
  );
  return out;
}

/** 影院放映厅参数；西墙位置决定整厅宽度，其余尺寸相对东西墙定位。 */
export interface CinemaHallParams {
  readonly idPrefix: string;
  readonly name: string;
  /** 西 / 东外墙的外表面 x。 */
  readonly westOuter: number;
  readonly eastOuter: number;
  readonly zMin: number;
  readonly zMax: number;
  readonly floorTop: number;
  readonly ceiling: number;
}

/**
 * 一座挑高放映厅：四面挑高墙（北墙双门与两侧通道对齐）、双层荧幕、8 排逐级座席台地、前后横通道。
 * 东侧与中央通道、东座席、东门都锚定在东墙；向西加宽只改变西墙、西通道、西座席与西门的 x 范围。
 * 挑高墙与座席从 floorTop 起算，贯穿 b1/b2（挑空），统一归 b3 并在 notes 说明。
 */
export function cinemaHall(params: CinemaHallParams): Element[] {
  const { westOuter: w, eastOuter: e, zMin, zMax, floorTop, ceiling } = params;
  const { idPrefix: p, name } = params;
  const westDoor = { from: w + 4, to: w + 7 };
  const eastDoor = { from: e - 7, to: e - 4 };
  const screenFrom = w + 8;
  const screenTo = e - 8;
  const westBank = { from: w + 8, to: e - 27 };
  const eastBank = { from: e - 21, to: e - 8 };
  // 三条纵向通道与北墙双门对齐；通道也随排逐级抬升（逐排台地 + 行间单阶）。
  const aisles: readonly (readonly [string, string, { readonly from: number; readonly to: number }])[] = [
    ['w', '西侧', { from: w + 4, to: w + 7 }],
    ['c', '中央', { from: e - 26, to: e - 22 }],
    ['e', '东侧', { from: e - 7, to: e - 4 }],
  ];
  // 通道与座席之间只差 1 格：每排补同高通行面，否则 r>0 从通道进不了排。
  const rowLinks: readonly (readonly [string, string, number, number])[] = [
    ['wa', '西通道至西座席', w + 7, w + 8],
    ['wc', '西座席至中央通道', e - 27, e - 26],
    ['ce', '中央通道至东座席', e - 22, e - 21],
    ['ea', '东座席至东通道', e - 8, e - 7],
  ];

  const out = boxes('b3', [
    [`${p}-west`, `${name}西墙`, 'wall', [w, floorTop, zMin + 1], [w + 1, ceiling, zMax], PALETTE.exteriorWall],
    [`${p}-east`, `${name}东墙`, 'wall', [e - 1, floorTop, zMin + 1], [e, ceiling, zMax], PALETTE.exteriorWall],
    [`${p}-south`, `${name}南墙`, 'wall', [w, floorTop, zMax - 1], [e, ceiling, zMax], PALETTE.exteriorWall],
    [`${p}-floor`, `${name}地面`, 'slab', [w + 1, floorTop - 1, zMin + 1], [e - 1, floorTop, zMax - 1], PALETTE.slab],
    // 北门门槛板：补上 z[zMin,zMin+1) 的楼板，使门外廊道与厅内地面连续。
    [
      `${p}-door-floor-w`,
      `${name}西门门槛板`,
      'slab',
      [w + 4, floorTop - 1, zMin],
      [w + 7, floorTop, zMin + 1],
      PALETTE.slab,
    ],
    [
      `${p}-door-floor-e`,
      `${name}东门门槛板`,
      'slab',
      [e - 7, floorTop - 1, zMin],
      [e - 4, floorTop, zMin + 1],
      PALETTE.slab,
    ],
    // 门洞净高 3；上方的墙由过梁恢复，不再整扇通高。
    [
      `${p}-door-lintel-w`,
      `${name}西门过梁`,
      'wall',
      [w + 4, floorTop + 3, zMin],
      [w + 7, ceiling, zMin + 1],
      PALETTE.exteriorWall,
    ],
    [
      `${p}-door-lintel-e`,
      `${name}东门过梁`,
      'wall',
      [e - 7, floorTop + 3, zMin],
      [e - 4, ceiling, zMin + 1],
      PALETTE.exteriorWall,
    ],
    [
      `${p}-screen-concrete`,
      `${name}荧幕混凝土层`,
      'wall',
      [screenFrom, floorTop + 1, zMin + 2],
      [screenTo, ceiling - 7, zMin + 3],
      PALETTE.screenConcrete,
    ],
    [
      `${p}-screen-glass`,
      `${name}荧幕玻璃层`,
      'wall',
      [screenFrom, floorTop + 1, zMin + 3],
      [screenTo, ceiling - 7, zMin + 4],
      PALETTE.screenGlass,
    ],
  ]);
  // 北墙两个门洞分别对齐两侧通道。
  out.push(
    ...batchWalls([
      [
        `${p}-north`,
        `${name}北墙`,
        'b3',
        PALETTE.exteriorWall,
        'x',
        w,
        e,
        zMin,
        1,
        floorTop,
        ceiling,
        [westDoor.from, westDoor.to, eastDoor.from, eastDoor.to],
      ],
    ]),
  );
  // 8 排台地：第 r 排 z[zMin+10+3r, +2)，顶面 floorTop+r；两侧座席台地，通道留空。
  const rows = 8;
  const rowDefs: BoxTuple[] = [];
  for (let r = 0; r < rows; r += 1) {
    const z0 = zMin + 10 + 3 * r;
    const top = floorTop + r;
    rowDefs.push(
      [
        `${p}-terrace-w-${String(r + 1)}`,
        `${name}西座席台地${String(r + 1)}排`,
        'slab',
        [westBank.from, floorTop - 1, z0],
        [westBank.to, top, z0 + 2],
        PALETTE.slab,
      ],
      [
        `${p}-terrace-e-${String(r + 1)}`,
        `${name}东座席台地${String(r + 1)}排`,
        'slab',
        [eastBank.from, floorTop - 1, z0],
        [eastBank.to, top, z0 + 2],
        PALETTE.slab,
      ],
      [
        `${p}-seat-w-${String(r + 1)}`,
        `${name}西座席${String(r + 1)}排`,
        'furnishing',
        [westBank.from, top, z0 + 1],
        [westBank.to, top + 1, z0 + 2],
        PALETTE.seat,
      ],
      [
        `${p}-seat-e-${String(r + 1)}`,
        `${name}东座席${String(r + 1)}排`,
        'furnishing',
        [eastBank.from, top, z0 + 1],
        [eastBank.to, top + 1, z0 + 2],
        PALETTE.seat,
      ],
    );
    // 通道逐排台地（与座席同高）与行间单阶（升 1）。
    for (const [tag, label, aisle] of aisles) {
      rowDefs.push([
        `${p}-aisle-${tag}-${String(r + 1)}`,
        `${name}${label}通道台地${String(r + 1)}排`,
        'stair',
        [aisle.from, floorTop - 1, z0],
        [aisle.to, top, z0 + 2],
        PALETTE.stair,
      ]);
      if (r < rows - 1) {
        rowDefs.push([
          `${p}-aisle-${tag}-step-${String(r + 1)}`,
          `${name}${label}通道单阶${String(r + 1)}`,
          'stair',
          [aisle.from, floorTop - 1, z0 + 2],
          [aisle.to, top + 1, z0 + 3],
          PALETTE.stair,
        ]);
      }
    }
    // 每排座位前的同高通行面：补齐通道与座席之间的 1 格缝，使该排从侧/中通道连续可达。
    for (const [tag, label, from, to] of rowLinks) {
      rowDefs.push([
        `${p}-rowlink-${tag}-${String(r + 1)}`,
        `${name}${label}通行面${String(r + 1)}排`,
        'slab',
        [from, floorTop - 1, z0],
        [to, top, z0 + 2],
        PALETTE.pavement,
      ]);
    }
  }
  // 后横通道：末排（顶面 floorTop+7）之后为 1 厚平台，标高与末排连平，不整块填高。
  rowDefs.push([
    `${p}-rear-aisle`,
    `${name}后横通道`,
    'slab',
    [w + 1, floorTop + 6, zMax - 7],
    [e - 1, floorTop + 7, zMax - 2],
    PALETTE.slab,
  ]);
  out.push(...boxes('b3', rowDefs));
  return out;
}

/** 衣服店：西墙可整体西移以加宽，店内柜台 / 试衣间 / 中央座椅 / 衣杆随西墙锚定，东墙与南门不变。 */
export interface ClothingShopParams {
  readonly westEdge: number;
  readonly idPrefix?: string;
}

/** 生成衣服店（含分段墙、柜台、试衣间、木楼梯座椅、衣杆）。 */
export function clothingShop(params: ClothingShopParams): Element[] {
  const w = params.westEdge;
  const p = params.idPrefix ?? 'el-shop';
  const f = -8;
  const c = -2;
  const east = 64;
  const fw = w + 22;
  const fe = w + 30;
  const out = boxes('b1', [
    [`${p}-north`, '衣服店北墙', 'wall', [w, f, 60], [east, c, 61], PALETTE.interiorWall],
    [`${p}-west`, '衣服店西墙', 'wall', [w, f, 61], [w + 1, c, 71], PALETTE.interiorWall],
    [`${p}-east`, '衣服店东墙', 'wall', [east - 1, f, 61], [east, c, 71], PALETTE.interiorWall],
    [`${p}-counter`, '衣服店收银柜台', 'furnishing', [w + 2, f, 62], [w + 10, f + 3, 65], PALETTE.counter],
    [`${p}-fitting-w`, '试衣间西隔断', 'wall', [fw, f, 61], [fw + 1, f + 4, 66], PALETTE.interiorWall],
    [`${p}-fitting-e`, '试衣间东隔断', 'wall', [fe - 1, f, 61], [fe, f + 4, 66], PALETTE.interiorWall],
    [`${p}-fitting-n`, '试衣间北隔断', 'wall', [fw, f, 61], [fe, f + 4, 62], PALETTE.interiorWall],
    [`${p}-seat-base`, '店铺中央座椅', 'stair', [w + 12, f, 64], [w + 20, f + 2, 68], PALETTE.wood],
    [`${p}-seat-step-w`, '中央座椅西踏级', 'stair', [w + 11, f, 65], [w + 12, f + 1, 67], PALETTE.wood],
    [`${p}-seat-step-e`, '中央座椅东踏级', 'stair', [w + 20, f, 65], [w + 21, f + 1, 67], PALETTE.wood],
    [`${p}-rack-e`, '衣服店东衣杆', 'furnishing', [east - 3, f, 62], [east - 2, f + 3, 70], PALETTE.fixture],
    [`${p}-rack-w`, '衣服店西衣杆', 'furnishing', [w + 1, f, 67], [w + 2, f + 3, 70], PALETTE.fixture],
  ]);
  out.push(
    ...batchWalls([
      [`${p}-south`, '衣服店南墙', 'b1', PALETTE.interiorWall, 'x', w, east, 71, 1, f, c, [45, 51]],
      [`${p}-fitting-s`, '试衣间南隔断', 'b1', PALETTE.interiorWall, 'x', fw, fe, 65, 1, f, f + 4, [fw + 3, fw + 5]],
    ]),
    // 店门与试衣间门净高 3，门上方补过梁。
    ...boxes('b1', [
      beam(`${p}-door-lintel`, '衣服店门过梁', [45, f + 3, 71], [51, c, 72]),
      beam(`${p}-fitting-lintel`, '试衣间门过梁', [fw + 3, f + 3, 65], [fw + 5, f + 4, 66]),
    ]),
  );
  return out;
}

/** 美食店：南立面东半开口，玻璃柜台 / 制作区靠西，桌椅靠北墙与东墙。尺寸固定。 */
export function foodShop(): Element[] {
  const f = -8;
  const c = -2;
  const out = boxes('b1', [
    ['el-food-north', '美食店北墙', 'wall', [112, f, 60], [144, c, 61], PALETTE.interiorWall],
    ['el-food-west', '美食店西墙', 'wall', [112, f, 61], [113, c, 71], PALETTE.interiorWall],
    ['el-food-east', '美食店东墙', 'wall', [143, f, 61], [144, c, 71], PALETTE.interiorWall],
    // 服务台只占制作区前缘，不整块填满；制作区留空。
    ['el-food-counter', '美食店柜台', 'furnishing', [113, f, 66], [122, f + 3, 68], PALETTE.counter],
    // 玻璃隔断在 x[123,126) 留员工门。
    ['el-food-partition-w', '美食店玻璃隔断', 'glazing', [113, f, 65], [123, f + 4, 66], PALETTE.glazing],
    ['el-food-partition-e', '美食店玻璃隔断', 'glazing', [126, f, 65], [128, f + 4, 66], PALETTE.glazing],
  ]);
  out.push(
    ...batchWalls([
      ['el-food-south', '美食店南墙', 'b1', PALETTE.interiorWall, 'x', 112, 144, 71, 1, f, c, [128, 143]],
    ]),
    // 店门与员工门净高 3，门上方补过梁。
    ...boxes('b1', [
      beam('el-food-door-lintel', '美食店门过梁', [128, f + 3, 71], [143, c, 72]),
      beam('el-food-staff-lintel', '美食店员工门过梁', [123, f + 3, 65], [126, f + 4, 66], PALETTE.glazing),
    ]),
  );
  const defs: BoxTuple[] = [];
  for (const tx of [120, 136]) {
    defs.push(
      [
        `el-food-table-n-${String(tx)}`,
        `美食店北墙桌${String(tx)}`,
        'furnishing',
        [tx, f + 2, 62],
        [tx + 2, f + 3, 64],
        PALETTE.wood,
      ],
      [
        `el-food-chair-n-w-${String(tx)}`,
        `北墙桌西椅${String(tx)}`,
        'furnishing',
        [tx - 1, f, 62],
        [tx, f + 2, 64],
        PALETTE.wood,
      ],
      [
        `el-food-chair-n-e-${String(tx)}`,
        `北墙桌东椅${String(tx)}`,
        'furnishing',
        [tx + 2, f, 62],
        [tx + 3, f + 2, 64],
        PALETTE.wood,
      ],
    );
  }
  for (const tz of [63, 68]) {
    defs.push(
      [
        `el-food-table-e-${String(tz)}`,
        `美食店东墙桌${String(tz)}`,
        'furnishing',
        [141, f + 2, tz],
        [143, f + 3, tz + 2],
        PALETTE.wood,
      ],
      [
        `el-food-chair-e-n-${String(tz)}`,
        `东墙桌北椅${String(tz)}`,
        'furnishing',
        [141, f, tz - 1],
        [143, f + 2, tz],
        PALETTE.wood,
      ],
      [
        `el-food-chair-e-s-${String(tz)}`,
        `东墙桌南椅${String(tz)}`,
        'furnishing',
        [141, f, tz + 2],
        [143, f + 2, tz + 3],
        PALETTE.wood,
      ],
    );
  }
  out.push(...boxes('b1', defs));
  return out;
}

/** 珠宝店：石英地板、红混凝土加玻璃柜台沿墙退让、入口玻璃隔断与两个展示位。尺寸固定。 */
export function jewelryShop(): Element[] {
  const f = -8;
  const c = -2;
  const out = boxes('b1', [
    ['el-jewel-floor', '珠宝店石英地板', 'slab', [36, f - 1, 84], [76, f, 96], PALETTE.quartz],
    ['el-jewel-south', '珠宝店南墙', 'wall', [36, f, 95], [76, c, 96], PALETTE.interiorWall],
    ['el-jewel-west', '珠宝店西墙', 'wall', [36, f, 85], [37, c, 95], PALETTE.interiorWall],
    ['el-jewel-east', '珠宝店东墙', 'wall', [75, f, 85], [76, c, 95], PALETTE.interiorWall],
    ['el-jewel-counter-w', '珠宝店西柜台', 'furnishing', [37, f, 87], [39, f + 2, 93], PALETTE.redConcrete],
    ['el-jewel-counter-wg', '珠宝店西柜玻璃', 'glazing', [37, f + 2, 87], [39, f + 3, 93], PALETTE.glazing],
    ['el-jewel-counter-e', '珠宝店东柜台', 'furnishing', [73, f, 87], [75, f + 2, 93], PALETTE.redConcrete],
    ['el-jewel-counter-eg', '珠宝店东柜玻璃', 'glazing', [73, f + 2, 87], [75, f + 3, 93], PALETTE.glazing],
    ['el-jewel-counter-s', '珠宝店南柜台', 'furnishing', [40, f, 93], [72, f + 2, 95], PALETTE.redConcrete],
    ['el-jewel-entry-glass', '珠宝店入口玻璃隔断', 'glazing', [43, f, 85], [53, f + 3, 86], PALETTE.glazing],
    ['el-jewel-display-diamond', '珠宝店钻石展示位', 'glazing', [43, f + 2, 86], [45, f + 3, 88], PALETTE.glazing],
    ['el-jewel-display-emerald', '珠宝店绿宝石展示位', 'glazing', [51, f + 2, 86], [53, f + 3, 88], PALETTE.glazing],
  ]);
  out.push(
    ...batchWalls([['el-jewel-north', '珠宝店北墙', 'b1', PALETTE.interiorWall, 'x', 36, 76, 84, 1, f, c, [53, 57]]]),
    // 店门净高 3，门上方补过梁。
    ...boxes('b1', [beam('el-jewel-door-lintel', '珠宝店门过梁', [53, f + 3, 84], [57, c, 85])]),
  );
  return out;
}
