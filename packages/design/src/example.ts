/**
 * 地下综合体人工样例：createExample(variant) 用一份参数化生成函数产出三版合法 Blueprint。
 *
 * 负责：总平面布局、楼层 / 空间 / 净空定义、把 example-interiors 的部件摆到绝对坐标上，
 * 并按 variant 改变衣服店西墙（wider-shop，西移 4）或西影厅西墙（wider-cinema，西移 8）。
 * 不负责：schema 校验（schema.ts）、求交（checks.ts）、版本差异（diff.ts）；
 * 也不伪装成自然语言 agent 的修改——这里是预制修改演练，加宽只改关联尺寸。
 *
 * 坐标：x 东、y 上、z 南，单位与蓝图一致；y=0 是真实街面原点。level 用 surface / b1 / b2 / b3。
 * 相邻功能做适当简化（见 notes）：本样例表达体量、交通、净空是否放得下，不声称结构或体素可达。
 */
import type { Element } from './schema.ts';
import { Blueprint } from './schema.ts';
import { element, slabWithHoles, vec } from './example-geometry.ts';
import type { RectHole } from './example-geometry.ts';
import { cinemaHall, clothingShop, foodShop, jewelryShop, PALETTE, stairModule } from './example-interiors.ts';
import { glassEntrance, parkSurface } from './example-shell.ts';
import { spaces, withSpaces } from './example-spaces.ts';

export type Variant = 'base' | 'wider-shop' | 'wider-cinema';

const SURFACE = 0;
const B1 = -8;
const B2 = -16;
const B3 = -24;

/** 四组站厅交通模块原点（x,z）；模块外包 22×14，z 方向 [oz, oz+14)。 */
const STATION_MODULES: readonly { readonly x: number; readonly z: number }[] = [
  { x: 28, z: 29 },
  { x: 56, z: 29 },
  { x: 84, z: 29 },
  { x: 112, z: 29 },
];

/** 两端影院交通模块原点；每处叠放 b3（−24→−16）与 b2（−16→−8）两段。 */
const CINEMA_MODULES: readonly {
  readonly x: number;
  readonly z: number;
  readonly prefix: string;
  readonly name: string;
}[] = [
  { x: 12, z: 84, prefix: 'el-cw', name: '西影院交通' },
  { x: 142, z: 84, prefix: 'el-ce', name: '东影院交通' },
];

function box(
  id: string,
  name: string,
  level: string,
  kind: Element['kind'],
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  color: string,
): Element {
  return element(id, name, level, kind, vec(min[0], min[1], min[2]), vec(max[0], max[1], max[2]), color);
}

/** 地表与两座玻璃入口、公园。 */
function surfaceElements(): Element[] {
  return [
    ...parkSurface(),
    ...glassEntrance({
      idPrefix: 'el-entry-n',
      name: '北入口',
      xMin: 4,
      xMax: 20,
      zMin: 4,
      zMax: 13,
      highDirection: -1,
      stairStart: 7,
      stairEnd: 16,
      bandZStart: 5,
      bandZEnd: 8,
    }),
    ...glassEntrance({
      idPrefix: 'el-entry-s',
      name: '南入口',
      xMin: 81,
      xMax: 97,
      zMin: 144,
      zMax: 153,
      highDirection: 1,
      stairStart: 85,
      stairEnd: 94,
      bandZStart: 145,
      bandZEnd: 148,
    }),
  ];
}

/** B1 楼板、分段外墙与分隔墙。 */
function b1Structure(shopWest: number): Element[] {
  const out: Element[] = [];
  const floor = (id: string, name: string, x0: number, x1: number, z0: number, z1: number): Element =>
    box(id, name, 'b1', 'slab', [x0, B1 - 1, z0], [x1, B1, z1], PALETTE.slab);

  out.push(floor('el-floor-street', '商业街地面', 12, 164, 72, 84));
  out.push(floor('el-floor-band', '站厅入口带地面', 72, 100, 48, 72));
  out.push(floor('el-floor-clothing', '衣服店地面', shopWest, 64, 60, 72));
  out.push(floor('el-floor-food', '美食店地面', 112, 144, 60, 72));
  out.push(floor('el-floor-concourse', '南集散平台地面', 76, 104, 84, 96));
  out.push(floor('el-floor-south-passage', '南入口通道地面', 81, 98, 96, 153));
  out.push(floor('el-floor-west-a', '西通道横段地面', 4, 21, 15, 21));
  out.push(floor('el-floor-west-b', '西通道纵段地面', 4, 10, 21, 80));
  out.push(floor('el-floor-west-c', '西通道接街口地面', 10, 12, 74, 79));
  out.push(floor('el-floor-west-d', '北入口接西通道地面', 15, 21, 8, 15));
  // 候车厅板扣掉四组楼梯洞与四个电梯井洞（井洞含 top 停靠门槛所在的一格），让模块穿上来。
  const waitingHoles: RectHole[] = STATION_MODULES.flatMap((module) => [
    { xMin: module.x + 1, xMax: module.x + 8, zMin: module.z, zMax: module.z + 8 },
    { xMin: module.x + 10, xMax: module.x + 15, zMin: module.z, zMax: module.z + 6 },
  ]);
  out.push(
    ...slabWithHoles({
      idPrefix: 'el-floor-waiting',
      name: '候车厅地面',
      level: 'b1',
      color: PALETTE.slab,
      xMin: 24,
      xMax: 152,
      zMin: 24,
      zMax: 48,
      yMin: B1 - 1,
      yMax: B1,
      holes: waitingHoles,
    }),
  );

  // 商业街外墙分段：店铺各自承担其南墙（含门洞），这里补非店铺段；西端留通往西通道的洞。
  for (const [index, [x0, x1]] of (
    [
      [12, shopWest],
      [64, 72],
      [100, 112],
      [144, 164],
    ] as const
  ).entries()) {
    out.push(
      box(
        `el-street-north-${String(index + 1)}`,
        '商业街北墙',
        'b1',
        'wall',
        [x0, B1, 71],
        [x1, -2, 72],
        PALETTE.interiorWall,
      ),
    );
  }
  out.push(box('el-street-south-1', '商业街南墙', 'b1', 'wall', [34, B1, 84], [36, -2, 85], PALETTE.interiorWall));
  out.push(box('el-street-south-2', '商业街南墙', 'b1', 'wall', [104, B1, 84], [142, -2, 85], PALETTE.interiorWall));
  out.push(box('el-street-west', '商业街西端墙', 'b1', 'wall', [12, B1, 72], [13, -2, 74], PALETTE.interiorWall));
  out.push(box('el-street-west-2', '商业街西端墙', 'b1', 'wall', [12, B1, 78], [13, -2, 84], PALETTE.interiorWall));
  out.push(box('el-street-east', '商业街东端墙', 'b1', 'wall', [163, B1, 72], [164, -2, 84], PALETTE.interiorWall));

  // 站厅入口带侧墙。
  out.push(box('el-band-west', '站厅入口带西墙', 'b1', 'wall', [72, B1, 48], [73, -2, 72], PALETTE.interiorWall));
  out.push(box('el-band-east', '站厅入口带东墙', 'b1', 'wall', [99, B1, 48], [100, -2, 72], PALETTE.interiorWall));
  // 候车厅外墙；南侧在入口带处开口。
  out.push(box('el-hall-west', '候车厅西墙', 'b1', 'wall', [24, B1, 24], [25, -2, 48], PALETTE.exteriorWall));
  out.push(box('el-hall-east', '候车厅东墙', 'b1', 'wall', [151, B1, 24], [152, -2, 48], PALETTE.exteriorWall));
  out.push(box('el-hall-north', '候车厅北墙', 'b1', 'wall', [24, B1, 23], [152, -2, 24], PALETTE.exteriorWall));
  out.push(box('el-hall-south-1', '候车厅南墙', 'b1', 'wall', [24, B1, 47], [72, -2, 48], PALETTE.interiorWall));
  out.push(box('el-hall-south-2', '候车厅南墙', 'b1', 'wall', [100, B1, 47], [152, -2, 48], PALETTE.interiorWall));

  // 南集散平台墙体，南墙在通道处开口。
  out.push(box('el-concourse-west', '集散平台西墙', 'b1', 'wall', [76, B1, 84], [77, -2, 96], PALETTE.interiorWall));
  out.push(box('el-concourse-east', '集散平台东墙', 'b1', 'wall', [103, B1, 84], [104, -2, 96], PALETTE.interiorWall));
  out.push(box('el-concourse-south-1', '集散平台南墙', 'b1', 'wall', [76, B1, 95], [81, -2, 96], PALETTE.interiorWall));
  out.push(
    box('el-concourse-south-2', '集散平台南墙', 'b1', 'wall', [98, B1, 95], [104, -2, 96], PALETTE.interiorWall),
  );
  // 南入口通道侧墙。
  out.push(
    box('el-southpassage-west', '南入口通道西墙', 'b1', 'wall', [81, B1, 96], [82, -2, 144], PALETTE.exteriorWall),
  );
  out.push(
    box('el-southpassage-east', '南入口通道东墙', 'b1', 'wall', [97, B1, 96], [98, -2, 144], PALETTE.exteriorWall),
  );
  return out;
}

/** B2 站台、轨道、围合与站台陈设。 */
function b2Structure(): Element[] {
  const out: Element[] = [];
  const shaftHoles: RectHole[] = STATION_MODULES.map((module) => ({
    xMin: module.x + 10,
    xMax: module.x + 15,
    zMin: module.z + 1,
    zMax: module.z + 6,
  }));
  out.push(
    ...slabWithHoles({
      idPrefix: 'el-platform-slab',
      name: '站台楼板',
      level: 'b2',
      color: PALETTE.slab,
      xMin: 24,
      xMax: 152,
      zMin: 24,
      zMax: 48,
      yMin: B2 - 1,
      yMax: B2,
      holes: shaftHoles,
    }),
  );
  out.push(box('el-track-bed-n', '北轨道床', 'b2', 'slab', [24, B2 - 1, 18], [152, B2, 23], PALETTE.road));
  out.push(box('el-track-bed-s', '南轨道床', 'b2', 'slab', [24, B2 - 1, 49], [152, B2, 54], PALETTE.road));
  for (const [index, z0] of ([19, 21, 50, 52] as const).entries()) {
    out.push(
      box(
        `el-rail-${String(index + 1)}`,
        '轨道',
        'b2',
        'furnishing',
        [24, B2, z0],
        [152, B2 + 1, z0 + 1],
        PALETTE.metal,
      ),
    );
  }
  out.push(box('el-b2-west', '站台西围合', 'b2', 'wall', [24, B2, 18], [25, B2 + 7, 54], PALETTE.exteriorWall));
  out.push(box('el-b2-east', '站台东围合', 'b2', 'wall', [151, B2, 18], [152, B2 + 7, 54], PALETTE.exteriorWall));
  out.push(box('el-b2-north', '站台北围合', 'b2', 'wall', [24, B2, 18], [152, B2 + 7, 19], PALETTE.exteriorWall));
  out.push(box('el-b2-south', '站台南围合', 'b2', 'wall', [24, B2, 53], [152, B2 + 7, 54], PALETTE.exteriorWall));
  out.push(box('el-b2-edge-n', '站台北边墙', 'b2', 'wall', [24, B2, 23], [152, B2 + 1, 24], PALETTE.interiorWall));
  out.push(box('el-b2-edge-s', '站台南边墙', 'b2', 'wall', [24, B2, 48], [152, B2 + 1, 49], PALETTE.interiorWall));
  for (const cx of [52, 80, 108]) {
    out.push(
      box(`el-column-${String(cx)}`, '站台柱', 'b2', 'furnishing', [cx, B2, 37], [cx + 2, B2 + 3, 39], PALETTE.metal),
    );
  }
  // 站台座椅：入口楼梯落点外侧的台阶座椅，避免挡南北通路。
  out.push(box('el-platform-bench-1', '站台座椅', 'b2', 'stair', [134, B2, 34], [138, B2 + 1, 36], PALETTE.wood));
  out.push(box('el-platform-bench-2', '站台座椅', 'b2', 'stair', [134, B2, 36], [138, B2 + 2, 38], PALETTE.wood));
  return out;
}

/** B3 连接廊、等待厅、检票隔墙、检票后廊道。 */
function b3Structure(cinemaWest: number): Element[] {
  const out: Element[] = [];
  out.push(box('el-b3-link', '影院连接廊地面', 'b3', 'slab', [12, B3 - 1, 72], [164, B3, 84], PALETTE.slab));
  out.push(box('el-b3-waiting', '影院等待厅地面', 'b3', 'slab', [34, B3 - 1, 84], [142, B3, 98], PALETTE.slab));
  out.push(
    box('el-b3-corridor', '检票后廊道地面', 'b3', 'slab', [cinemaWest, B3 - 1, 98], [148, B3, 104], PALETTE.slab),
  );
  out.push(box('el-b3-checkin-1', '检票隔墙', 'b3', 'wall', [34, B3, 97], [84, B3 + 7, 98], PALETTE.interiorWall));
  out.push(box('el-b3-checkin-2', '检票隔墙', 'b3', 'wall', [92, B3, 97], [142, B3 + 7, 98], PALETTE.interiorWall));
  // 候场售票与零食柜台（服务面朝南，中央保持通路）。
  out.push(box('el-b3-ticket', '售票柜台', 'b3', 'furnishing', [44, B3, 86], [64, B3 + 3, 89], PALETTE.counter));
  out.push(box('el-b3-snacks', '零食柜台', 'b3', 'furnishing', [112, B3, 86], [132, B3 + 3, 89], PALETTE.counter));
  return out;
}

/** 四组站厅交通与两处叠放的影院交通（含电梯井、平台、预留扶梯标记）。 */
function circulationElements(): Element[] {
  const out: Element[] = [];
  STATION_MODULES.forEach((module, index) => {
    out.push(
      ...stairModule({
        idPrefix: `el-station-${String(index + 1)}`,
        name: `站厅交通${String(index + 1)}`,
        level: 'b2',
        originX: module.x,
        originZ: module.z,
        baseFloor: B2,
        liftDoor: 'both',
      }),
    );
  });
  for (const module of CINEMA_MODULES) {
    out.push(
      ...stairModule({
        idPrefix: `${module.prefix}-low`,
        name: `${module.name}低段`,
        level: 'b3',
        originX: module.x,
        originZ: module.z,
        baseFloor: B3,
        liftDoor: 'base',
      }),
    );
    out.push(
      ...stairModule({
        idPrefix: `${module.prefix}-high`,
        name: `${module.name}高段`,
        level: 'b2',
        originX: module.x,
        originZ: module.z,
        baseFloor: B2,
        enclosure: true,
        liftDoor: 'top',
      }),
    );
  }
  return out;
}

/** 两座影厅（西厅可加宽，东厅固定）与三家商铺。 */
function interiorElements(shopWest: number, cinemaWest: number): Element[] {
  return [
    ...cinemaHall({
      idPrefix: 'el-cine-w',
      name: '西影厅',
      westOuter: cinemaWest,
      eastOuter: 80,
      zMin: 104,
      zMax: 144,
      floorTop: B3,
      ceiling: -2,
    }),
    ...cinemaHall({
      idPrefix: 'el-cine-e',
      name: '东影厅',
      westOuter: 100,
      eastOuter: 148,
      zMin: 104,
      zMax: 144,
      floorTop: B3,
      ceiling: -2,
    }),
    ...clothingShop({ westEdge: shopWest, idPrefix: 'el-shop' }),
    ...foodShop(),
    ...jewelryShop(),
  ];
}

/** 楼层标高表。 */
function levels(): Blueprint['levels'] {
  return [
    { id: 'surface', name: '地表与街面', elevation: SURFACE },
    { id: 'b1', name: '地下一层：商业与站厅', elevation: B1 },
    { id: 'b2', name: '地下二层：站台', elevation: B2 },
    { id: 'b3', name: '地下三层：影院', elevation: B3 },
  ];
}

/** 净空区：房间步道 + 电梯井 + 入口 / 层间梯 / 影院行间的逐踏面头顶 3；ignoreElementIds 全空。 */
function clearances(cinemaWest: number): Blueprint['clearances'] {
  const clear = (
    id: string,
    name: string,
    min: readonly [number, number, number],
    max: readonly [number, number, number],
  ): Blueprint['clearances'][number] => ({
    id,
    name,
    bounds: { min: vec(min[0], min[1], min[2]), max: vec(max[0], max[1], max[2]) },
    ignoreElementIds: [],
  });
  const list: Blueprint['clearances'][number][] = [
    clear('cl-street', '商业街步道', [13, B1, 73], [163, -4, 83]),
    clear('cl-band', '站厅入口带步道', [73, B1, 49], [99, -4, 71]),
    clear('cl-waiting-n', '候车大厅北步道', [25, B1, 25], [151, -4, 29]),
    clear('cl-waiting-s', '候车大厅南步道', [25, B1, 43], [151, -4, 47]),
    clear('cl-waiting-m1', '候车大厅步道', [50, B1, 29], [56, -4, 43]),
    clear('cl-waiting-m2', '候车大厅步道', [78, B1, 29], [84, -4, 43]),
    clear('cl-waiting-m3', '候车大厅步道', [106, B1, 29], [112, -4, 43]),
    clear('cl-concourse', '集散平台步道', [77, B1, 85], [103, -4, 95]),
    clear('cl-south-passage', '南入口通道步道', [82, B1, 97], [97, -4, 143]),
    clear('cl-shop-entry', '衣服店入口分流带', [45, B1, 68], [51, -5, 72]),
    clear('cl-food-entry', '美食店入口步道', [129, B1, 65], [140, -5, 72]),
    clear('cl-jewel-aisle', '珠宝店中央通道', [54, B1, 86], [72, -4, 92]),
    clear('cl-platform', '站台北侧通路', [25, B2, 25], [151, -12, 29]),
    clear('cl-corridor', '检票后廊道', [cinemaWest, B3, 99], [148, -21, 103]),
    clear('cl-west-void', '西影厅挑空', [cinemaWest + 1, -14, 109], [79, -3, 143]),
    clear('cl-east-void', '东影厅挑空', [101, -14, 109], [147, -3, 143]),
    clear('cl-rear-aisle', '西影厅后横通道', [cinemaWest + 1, -17, 138], [79, -9, 142]),
  ];
  /** 每级踏面头顶 3 的空腔（沿轴每级进深 1）。 */
  const tread = (
    idPrefix: string,
    name: string,
    axis: 'x' | 'z',
    start: number,
    crossStart: number,
    crossSize: number,
    topAtStart: number,
    rise: number,
    count: number,
  ): void => {
    for (let j = 0; j < count; j += 1) {
      const along = start + j;
      const top = topAtStart + j * rise;
      const min: readonly [number, number, number] = axis === 'x' ? [along, top, crossStart] : [crossStart, top, along];
      const max: readonly [number, number, number] =
        axis === 'x' ? [along + 1, top + 3, crossStart + crossSize] : [crossStart + crossSize, top + 3, along + 1];
      list.push(clear(`${idPrefix}-${String(j + 1)}`, `${name}第${String(j + 1)}级`, min, max));
    }
  };
  // 两座入口梯：北 x[7,16) 顶面 0→−8；南 x[85,94) 顶面 −8→0。
  tread('cl-entry-n', '北入口梯', 'x', 7, 5, 3, 0, -1, 9);
  tread('cl-entry-s', '南入口梯', 'x', 85, 145, 3, -8, 1, 9);
  // 四组站厅层间梯（F=−16 上到 −8），两跑各 4 级。
  STATION_MODULES.forEach((module, index) => {
    tread(
      `cl-sta-${String(index + 1)}-r1`,
      `站厅${String(index + 1)}第一跑`,
      'z',
      module.z + 4,
      module.x + 1,
      3,
      B2 + 1,
      1,
      4,
    );
    tread(
      `cl-sta-${String(index + 1)}-r2`,
      `站厅${String(index + 1)}第二跑`,
      'z',
      module.z + 4,
      module.x + 5,
      3,
      B2 + 8,
      -1,
      4,
    );
  });
  // 两处影院叠梯（低段 −24→−16、高段 −16→−8）。
  for (const module of CINEMA_MODULES) {
    for (const [tag, base] of [
      ['lo', B3],
      ['hi', B2],
    ] as const) {
      tread(
        `cl-cin-${module.prefix}-${tag}-r1`,
        `${module.name}${tag}第一跑`,
        'z',
        module.z + 4,
        module.x + 1,
        3,
        base + 1,
        1,
        4,
      );
      tread(
        `cl-cin-${module.prefix}-${tag}-r2`,
        `${module.name}${tag}第二跑`,
        'z',
        module.z + 4,
        module.x + 5,
        3,
        base + 8,
        -1,
        4,
      );
    }
  }
  // 影院每排通道（侧 / 中 / 侧）的踏面头顶 3；后通道平台不在此列。
  for (const [hall, west, east] of [
    ['w', cinemaWest, 80],
    ['e', 100, 148],
  ] as const) {
    for (let r = 0; r < 8; r += 1) {
      const z0 = 104 + 10 + 3 * r;
      const top = B3 + r;
      const aisles: readonly (readonly [string, number, number])[] = [
        ['w', west + 4, west + 7],
        ['c', east - 26, east - 22],
        ['e', east - 7, east - 4],
      ];
      for (const [tag, from, to] of aisles) {
        list.push(
          clear(
            `cl-cine-${hall}-${tag}-${String(r + 1)}`,
            `影院${hall}通道${String(r + 1)}`,
            [from, top, z0],
            [to, top + 3, z0 + 2],
          ),
        );
      }
    }
  }
  STATION_MODULES.forEach((module, index) => {
    list.push(
      clear(
        `cl-lift-${String(index + 1)}`,
        `站厅电梯井${String(index + 1)}`,
        [module.x + 11, B2, module.z + 2],
        [module.x + 14, -9, module.z + 5],
      ),
    );
  });
  return list;
}

/**
 * 生成一版地下综合体蓝图。variant 只改变参数再重建，不修改已产出的对象。
 * fresh：base 西影厅西墙 x=32、衣服店西墙 x=32；wider-shop 衣服店西墙 28；wider-cinema 西影厅西墙 24。
 */
export function createExample(variant: Variant = 'base'): Blueprint {
  const shopWest = variant === 'wider-shop' ? 28 : 32;
  const cinemaWest = variant === 'wider-cinema' ? 24 : 32;
  const elements: Element[] = withSpaces([
    ...surfaceElements(),
    ...b1Structure(shopWest),
    ...b2Structure(),
    ...b3Structure(cinemaWest),
    ...circulationElements(),
    ...interiorElements(shopWest, cinemaWest),
  ]);
  const notes: string[] = [
    '人工样例：用于验证设计表达、查看与几何检查，不代表模型生成能力。',
    '标高：surface y=0、b1 y=−8、b2 y=−16、b3 y=−24；普通楼板占标高下一单位。',
    '西 / 东影厅从 b3 挑高到公园下方，b1 / b2 在此处不设楼板；地表草地为完整顶盖（viewer 默认隐藏），只在两座入口梯井挖穿；挑高墙与楼梯按起始楼层归 b3 / b2。',
    '相邻功能做了简化：西通道只表达地面与接街口，影院等待厅与连接廊合为并集不加重复墙，站台安全边界用边墙表达。',
    '扶梯带只留标记与净空位置，不计为已交付扶梯；电梯井为静态空间，只表示停靠层与门位置，不作为步行路线。',
    '两处玻璃入口的 9 级梯、挑高墙、座席台地均按蓝图尺寸生成；覆盖层厚度与影厅大跨承托未做结构验证。',
    '元素的 spaceId 由 example.ts 的 SPACE_RULES 前缀优先级映射生成，不靠"完全包含"猜测；台阶与陈设归其服务房间或交通组。',
    '入口三角罩用一格宽、厚 1 的阶梯式盒拟合斜顶与三角侧墙（离散草模近似，不新增 shape）；薄顶踏面与理论斜面差半格以内。',
    '净空按逐踏面生成头顶 3（入口梯 / 层间梯 / 影院每排通道），未删道路规避检查；结构承托路径由后续代理核对，本样例不声称承托成立。',
    variant === 'wider-shop'
      ? 'wider-shop：衣服店西墙由 x=32 西移到 28（店内柜台 / 试衣间 / 中央座椅 / 西衣杆同步西移 4），东墙与南门不变。'
      : variant === 'wider-cinema'
        ? 'wider-cinema：西影厅西墙由 x=32 西移到 24（西门 / 西侧通道 / 荧幕西端 / 西座席同步，东侧与中央不变），检票后廊道西端随之延伸到 24。'
        : 'base：原始尺寸；两 variant 由同一参数化生成函数重建，未改动本版。',
  ];
  return Blueprint.parse({
    id: 'bp-underground-plaza',
    revision: variant === 'base' ? 1 : 2,
    title: '地下铁电影院商业街组合体（草模样例）',
    description: '东西向商业街、北部车站、南部两座挑高影厅的地下综合体；三版共享同一稳定编号，用于版本对照。',
    levels: levels(),
    spaces: spaces(shopWest, cinemaWest),
    elements,
    clearances: clearances(cinemaWest),
    notes,
  });
}
