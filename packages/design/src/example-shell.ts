/**
 * 地表构件：公园顶盖 / 园路 / 树阵 / 路灯，以及两座玻璃入口的阶梯式薄壳与步行梯。
 *
 * 负责：地表覆盖层（[−2,0)）、只在两座入口梯井开洞的完整顶盖、入口三角罩的离散薄壳近似、入口梯与平台。
 * 不负责：地下结构、楼层 / 空间 / 净空定义（见 example.ts、example-interiors.ts）。
 *
 * 薄壳说明：Element 目前只有 box / wedge 两种 shape，solid wedge 会把罩顶内部填实；
 * 这里用"一格宽、厚 1 的阶梯式盒"沿 x 拟合斜顶与三角侧墙（离散草模近似），不新增协议或 shape。
 * 所有高度为整数；阶梯式薄顶的踏面比理论斜面差半格以内，仅作体量表达。
 */
import type { BoxTuple } from './example-geometry.ts';
import type { Element } from './schema.ts';
import { batchSteps, boxes, slabWithHoles } from './example-geometry.ts';
import { PALETTE } from './example-interiors.ts';

/** 地表覆盖层厚度：顶面 y=0，底面 y=−2（与蓝图"覆盖层 [−2,0)"一致）。 */
const COVER_TOP = 0;
const COVER_BOTTOM = -2;

/** 地表公园与外围道路：完整草地顶盖 + 十字园路 + 树阵与路灯；只在两座入口梯井扣洞。 */
export function parkSurface(): Element[] {
  const out = boxes('surface', [
    ['el-path-ew', '公园东西主路', 'landscape', [0, COVER_BOTTOM, 76], [176, COVER_TOP, 84], PALETTE.pavement],
  ]);
  // 南北主路在南入口梯井处开洞（梯井另一半落在东南草地）。
  out.push(
    ...slabWithHoles({
      idPrefix: 'el-path-ns',
      name: '公园南北主路',
      level: 'surface',
      color: PALETTE.pavement,
      xMin: 84,
      xMax: 92,
      zMin: 0,
      zMax: 160,
      yMin: COVER_BOTTOM,
      yMax: COVER_TOP,
      kind: 'landscape',
      holes: [{ xMin: 85, xMax: 92, zMin: 145, zMax: 148 }],
    }),
  );
  // 完整草地顶盖（viewer 默认隐藏，完整外观无大洞）；只扣入口梯井：北 x[4,16) z[5,8)、南 x[92,97) z[145,148)。
  const hole = (
    xMin: number,
    xMax: number,
    zMin: number,
    zMax: number,
  ): readonly { xMin: number; xMax: number; zMin: number; zMax: number }[] => [{ xMin, xMax, zMin, zMax }];
  out.push(
    ...slabWithHoles({
      idPrefix: 'el-park-nw',
      name: '公园草地西北',
      level: 'surface',
      color: PALETTE.grass,
      xMin: 0,
      xMax: 84,
      zMin: 0,
      zMax: 76,
      yMin: COVER_BOTTOM,
      yMax: COVER_TOP,
      kind: 'landscape',
      holes: hole(4, 16, 5, 8),
    }),
    ...slabWithHoles({
      idPrefix: 'el-park-sw',
      name: '公园草地西南',
      level: 'surface',
      color: PALETTE.grass,
      xMin: 0,
      xMax: 84,
      zMin: 84,
      zMax: 160,
      yMin: COVER_BOTTOM,
      yMax: COVER_TOP,
      kind: 'landscape',
    }),
    ...slabWithHoles({
      idPrefix: 'el-park-ne',
      name: '公园草地东北',
      level: 'surface',
      color: PALETTE.grass,
      xMin: 92,
      xMax: 176,
      zMin: 0,
      zMax: 76,
      yMin: COVER_BOTTOM,
      yMax: COVER_TOP,
      kind: 'landscape',
    }),
    ...slabWithHoles({
      idPrefix: 'el-park-se',
      name: '公园草地东南',
      level: 'surface',
      color: PALETTE.grass,
      xMin: 92,
      xMax: 176,
      zMin: 84,
      zMax: 160,
      yMin: COVER_BOTTOM,
      yMax: COVER_TOP,
      kind: 'landscape',
      holes: hole(92, 97, 145, 148),
    }),
  );
  const defs: BoxTuple[] = [];
  for (const [tx, tz] of [
    [24, 24],
    [56, 24],
    [120, 24],
    [152, 24],
    [24, 132],
    [152, 132],
  ] as const) {
    defs.push([
      `el-tree-${String(tx)}-${String(tz)}`,
      '公园树',
      'landscape',
      [tx, COVER_TOP, tz],
      [tx + 3, COVER_TOP + 4, tz + 3],
      PALETTE.grass,
    ]);
  }
  for (const lx of [20, 44, 132, 156]) {
    defs.push(
      [
        `el-lamp-${String(lx)}`,
        '公园路灯',
        'furnishing',
        [lx, COVER_TOP, 77],
        [lx + 1, COVER_TOP + 5, 78],
        PALETTE.metal,
      ],
      [
        `el-lamp-${String(lx)}-s`,
        '公园路灯',
        'furnishing',
        [lx, COVER_TOP, 81],
        [lx + 1, COVER_TOP + 5, 82],
        PALETTE.metal,
      ],
    );
  }
  out.push(...boxes('surface', defs));
  return out;
}

/** 玻璃入口三角罩的离散薄壳参数。 */
export interface GlassEntranceParams {
  readonly idPrefix: string;
  readonly name: string;
  readonly xMin: number;
  readonly xMax: number;
  readonly zMin: number;
  readonly zMax: number;
  /** 高端的 x 方向：-1 表示西端高（北入口），1 表示东端高（南入口）。 */
  readonly highDirection: 1 | -1;
  /** 步行梯 x 范围 [start, end)，9 级共 9 单位。 */
  readonly stairStart: number;
  readonly stairEnd: number;
  /** 上 / 下平台与梯带的 z 范围。 */
  readonly bandZStart: number;
  readonly bandZEnd: number;
}

/**
 * 生成一座地面入口：沿 x 的阶梯式薄顶 + 两片阶梯式三角侧墙 + 9 级步行梯 + 上下平台 + 两尊石狮。
 * 薄顶每格一块、厚 1，顶面按门端 8 到后端 0 的斜率取整；侧墙只在 z 向厚 1，不填内部。
 */
export function glassEntrance(params: GlassEntranceParams): Element[] {
  const { xMin, xMax, zMin, zMax } = params;
  const { idPrefix: p, name } = params;
  const width = xMax - xMin;
  const height = 8;
  const descending = params.highDirection === -1;

  const shell: BoxTuple[] = [];
  for (let x = xMin; x < xMax; x += 1) {
    const top = descending ? Math.floor(((xMax - x) * height) / width) : Math.floor(((x - xMin + 1) * height) / width);
    shell.push([
      `${p}-roof-${String(x)}`,
      `${name}阶梯薄顶${String(x)}`,
      'glazing',
      [x, Math.max(top - 1, COVER_TOP), zMin],
      [x + 1, Math.max(top, COVER_TOP + 1), zMax],
      PALETTE.glazing,
    ]);
    if (top >= 1) {
      shell.push(
        [
          `${p}-side-n-${String(x)}`,
          `${name}北三角侧墙${String(x)}`,
          'glazing',
          [x, 0, zMin],
          [x + 1, top, zMin + 1],
          PALETTE.glazing,
        ],
        [
          `${p}-side-s-${String(x)}`,
          `${name}南三角侧墙${String(x)}`,
          'glazing',
          [x, 0, zMax - 1],
          [x + 1, top, zMax],
          PALETTE.glazing,
        ],
      );
    }
  }
  const out = boxes('surface', shell);
  out.push(
    ...batchSteps([
      [
        `${p}-stair`,
        `${name}步行梯`,
        'surface',
        PALETTE.stair,
        'x',
        params.stairStart,
        params.stairEnd,
        params.bandZStart,
        3,
        -9,
        descending ? 0 : -8,
        descending ? -1 : 1,
        9,
      ],
    ]),
  );
  // 上平台在门端（北入口西端 x[4,7)，南入口东端 x[94,97)）；下平台在远端。
  const upperStart = descending ? xMin : xMax - 3;
  const upperEnd = descending ? xMin + 3 : xMax;
  const lowerStart = descending ? xMax - 4 : xMin;
  const lowerEnd = descending ? xMax : xMin + 4;
  out.push(
    ...boxes('surface', [
      [
        `${p}-landing-up`,
        `${name}上平台`,
        'slab',
        [upperStart, -9, params.bandZStart],
        [upperEnd, 1, params.bandZEnd],
        PALETTE.pavement,
      ],
      [
        `${p}-landing-low`,
        `${name}下平台`,
        'slab',
        [lowerStart, -9, params.bandZStart],
        [lowerEnd, -8, params.bandZEnd],
        PALETTE.pavement,
      ],
      [`${p}-lion-n`, `${name}石狮北`, 'furnishing', [xMin - 2, 0, zMin - 1], [xMin, 2, zMin + 1], PALETTE.pavement],
      [`${p}-lion-s`, `${name}石狮南`, 'furnishing', [xMin - 2, 0, zMax - 1], [xMin, 2, zMax + 1], PALETTE.pavement],
    ]),
  );
  return out;
}
