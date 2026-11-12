/**
 * 概念级三维草模：createMassingExample(variant) 返回只含粗体量的 Blueprint。
 *
 * 负责：主要楼层的整片地面、房间空间范围（复用 example-spaces 的 21 个空间）、
 * 简化入口占位，以及用单段连续楔体表达的层间坡道（站厅 / 影院）与必要平台。
 * 不负责：施工级几何（墙、门窗、座席、逐级楼梯、栏杆、树灯轨道细件一律不做）、
 * 净空逐格检查（clearances 为空）、路线校验与差分实现（见 checks.ts / diff.ts）。
 *
 * 为什么单独一层：owner 2026-10-10 指出旧 example 太细，看图阶段只需体量与挑空。
 * 旧 example*.ts 保留为内部细稿、仍由旧查看器消费；本模块是给新查看器的公开入口。
 * 约定：x 东、y 上、z 南，坐标整数；level 用 surface / b1 / b2 / b3，标高同 example。
 * 命名：元素 id 以 ms- 开头；楼梯类形体一律叫“坡道”，不出现 seat / step / wall 语义。
 */
import type { Direction, Element, ElementShape } from './schema.ts';
import { Blueprint } from './schema.ts';
import { PALETTE } from './example-interiors.ts';
import { spaces } from './example-spaces.ts';
import { element, slabWithHoles, vec } from './example-geometry.ts';

export type Variant = 'base' | 'wider-shop' | 'wider-cinema';

const SURFACE = 0;
const B1 = -8;
const B2 = -16;
const B3 = -24;

/** 四组站厅交通模块原点（x,z）；与 example.ts 保持一致，模块外包 22×14。 */
const STATION_MODULES: readonly { readonly x: number; readonly z: number }[] = [
  { x: 28, z: 29 },
  { x: 56, z: 29 },
  { x: 84, z: 29 },
  { x: 112, z: 29 },
];

/** 候车厅范围；站厅坡道在楼板上留下的洞也在此范围内。 */
const HALL_MIN_X = 24;
const HALL_MAX_X = 152;
const HALL_MIN_Z = 24;
const HALL_MAX_Z = 48;

type XYZ = readonly [number, number, number];

/** 轴对齐盒元素（地面 / 平台 / 基底），缺省 shape=box、direction=1。 */
function box(
  id: string,
  name: string,
  level: string,
  kind: Element['kind'],
  min: XYZ,
  max: XYZ,
  color: string,
): Element {
  return element(id, name, level, kind, vec(min[0], min[1], min[2]), vec(max[0], max[1], max[2]), color);
}

/** 连续坡道元素：kind 固定 stair，shape 固定楔体，direction 指出高端方向。 */
function ramp(
  id: string,
  name: string,
  level: string,
  min: XYZ,
  max: XYZ,
  color: string,
  shape: ElementShape,
  direction: Direction,
): Element {
  return element(id, name, level, 'stair', vec(min[0], min[1], min[2]), vec(max[0], max[1], max[2]), color, {
    shape,
    direction,
  });
}

/**
 * 地表：南北两片公园草地，各自在入口坡道贯穿处按坡道体量范围保守扣一个整洞，
 * 保证坡道与地表板无正体积交叠；概念模型不做净空级精算。viewer 默认隐藏地表。
 * 北入口洞沿 x 覆盖坡道与上平台（[4,16)×[5,8)）；南入口洞同理覆盖（[85,97)×[145,148)）。
 */
function groundElements(): Element[] {
  return [
    ...slabWithHoles({
      idPrefix: 'ms-ground-n',
      name: '地表公园北片',
      level: 'surface',
      color: PALETTE.grass,
      kind: 'landscape',
      xMin: 0,
      xMax: 176,
      zMin: 0,
      zMax: 76,
      yMin: -2,
      yMax: 0,
      holes: [{ xMin: 4, xMax: 16, zMin: 5, zMax: 8 }],
    }),
    ...slabWithHoles({
      idPrefix: 'ms-ground-s',
      name: '地表公园南片',
      level: 'surface',
      color: PALETTE.grass,
      kind: 'landscape',
      xMin: 0,
      xMax: 176,
      zMin: 84,
      zMax: 160,
      yMin: -2,
      yMax: 0,
      holes: [{ xMin: 85, xMax: 97, zMin: 145, zMax: 148 }],
    }),
  ];
}

/**
 * 两座地面入口的简化占位：一段坡道 + 上平台；北入口另补下平台。
 * 南入口下梯直接落在南入口通道地面上，不再放一片重复平台。
 */
function entranceElements(): Element[] {
  return [
    ramp('ms-entry-n-ramp', '北入口坡道', 'surface', [7, B1, 5], [16, SURFACE, 8], PALETTE.stair, 'wedge-x', -1),
    box('ms-entry-n-top', '北入口上平台', 'surface', 'slab', [4, -1, 5], [7, SURFACE, 8], PALETTE.pavement),
    box('ms-entry-n-bottom', '北入口下平台', 'b1', 'slab', [16, B1 - 1, 5], [20, B1, 8], PALETTE.pavement),
    ramp('ms-entry-s-ramp', '南入口坡道', 'surface', [85, B1, 145], [94, SURFACE, 148], PALETTE.stair, 'wedge-x', 1),
    box('ms-entry-s-top', '南入口上平台', 'surface', 'slab', [94, -1, 145], [97, SURFACE, 148], PALETTE.pavement),
  ];
}

/** B1 房间 / 通道地面：每处一片颜色地面，西侧通道按 L 形拆成必要几片。 */
function b1Floors(shopWest: number): Element[] {
  return [
    box('ms-floor-street', '商业街地面', 'b1', 'slab', [12, B1 - 1, 72], [164, B1, 84], PALETTE.pavement),
    box('ms-floor-clothing', '衣服店地面', 'b1', 'slab', [shopWest, B1 - 1, 60], [64, B1, 72], PALETTE.wood),
    box('ms-floor-food', '美食店地面', 'b1', 'slab', [112, B1 - 1, 60], [144, B1, 72], PALETTE.wood),
    box('ms-floor-jewel', '珠宝店地面', 'b1', 'slab', [36, B1 - 1, 84], [76, B1, 96], PALETTE.quartz),
    box('ms-floor-band', '站厅入口带地面', 'b1', 'slab', [72, B1 - 1, 48], [100, B1, 72], PALETTE.pavement),
    box('ms-floor-concourse', '南集散平台地面', 'b1', 'slab', [76, B1 - 1, 84], [104, B1, 96], PALETTE.pavement),
    box('ms-floor-south-passage', '南入口通道地面', 'b1', 'slab', [81, B1 - 1, 96], [98, B1, 153], PALETTE.pavement),
    box('ms-floor-west-a', '西通道横段地面', 'b1', 'slab', [4, B1 - 1, 15], [21, B1, 21], PALETTE.pavement),
    box('ms-floor-west-b', '西通道纵段地面', 'b1', 'slab', [4, B1 - 1, 21], [10, B1, 80], PALETTE.pavement),
    box('ms-floor-west-c', '西通道接街口地面', 'b1', 'slab', [10, B1 - 1, 74], [12, B1, 79], PALETTE.pavement),
    box('ms-floor-west-d', '北入口接西通道地面', 'b1', 'slab', [15, B1 - 1, 8], [21, B1, 15], PALETTE.pavement),
  ];
}

/**
 * 候车厅地面：按四组站厅坡道的占位留出贯通南北的洞，坡道与上平台填进洞里，
 * 楼板不再把 b2 → b1 的接口堵死。洞贯通 z 向，因此楼板只剩五条 x 向地板带。
 * 这里显式列地板带而不用 slabWithHoles：四组洞会把楼板切成大量小片，骨架不需要。
 */
function buildWaitingSlabs(): Element[] {
  const holeX: readonly (readonly [number, number])[] = STATION_MODULES.map((module) => [module.x + 1, module.x + 8]);
  const bands: Element[] = [];
  let cursor = HALL_MIN_X;
  for (const [from, to] of holeX) {
    if (from > cursor) {
      bands.push(
        box(
          `ms-floor-waiting-${String(bands.length + 1)}`,
          '候车厅地面',
          'b1',
          'slab',
          [cursor, B1 - 1, HALL_MIN_Z],
          [from, B1, HALL_MAX_Z],
          PALETTE.pavement,
        ),
      );
    }
    cursor = to;
  }
  bands.push(
    box(
      `ms-floor-waiting-${String(bands.length + 1)}`,
      '候车厅地面',
      'b1',
      'slab',
      [cursor, B1 - 1, HALL_MIN_Z],
      [HALL_MAX_X, B1, HALL_MAX_Z],
      PALETTE.pavement,
    ),
  );
  return bands;
}

/** B2：站台整片地面与南北两段轨道长带。 */
function b2Floors(): Element[] {
  return [
    box('ms-platform', '站台地面', 'b2', 'slab', [24, B2 - 1, 24], [152, B2, 48], PALETTE.pavement),
    box('ms-track-n', '北轨道带', 'b2', 'slab', [24, B2 - 1, 18], [152, B2, 23], PALETTE.road),
    box('ms-track-s', '南轨道带', 'b2', 'slab', [24, B2 - 1, 49], [152, B2, 54], PALETTE.road),
  ];
}

/** B3：影院连接廊、等待厅、检票后廊道，以及两座影厅的基底平面（挑空由空间线框表达）。 */
function b3Floors(cinemaWest: number): Element[] {
  return [
    box('ms-floor-link', '影院连接廊地面', 'b3', 'slab', [12, B3 - 1, 72], [164, B3, 84], PALETTE.pavement),
    box('ms-floor-cine-waiting', '影院等待厅地面', 'b3', 'slab', [34, B3 - 1, 84], [142, B3, 98], PALETTE.pavement),
    box(
      'ms-floor-corridor',
      '检票后廊道地面',
      'b3',
      'slab',
      [cinemaWest, B3 - 1, 98],
      [148, B3, 104],
      PALETTE.pavement,
    ),
    box(
      'ms-floor-cine-w',
      '西影厅基底',
      'b3',
      'slab',
      [cinemaWest, B3 - 1, 104],
      [80, B3, 144],
      PALETTE.screenConcrete,
    ),
    box('ms-floor-cine-e', '东影厅基底', 'b3', 'slab', [100, B3 - 1, 104], [148, B3, 144], PALETTE.screenConcrete),
  ];
}

/**
 * 层间交通：四组站厅坡道（b2 → b1，各带一片 b1 上平台）、两段影院坡道（b3 → b1）。
 * 每组站厅坡道在候车厅楼板的洞里占 z[30,48)，上平台占 z[24,30)，两者拼满整洞；
 * 影院坡道占满交通组宽度，北端接 b1 商业街地面、南端接 b3 影院等待厅地面。
 */
function circulationElements(): Element[] {
  const out: Element[] = [];
  STATION_MODULES.forEach((module, index) => {
    const n = index + 1;
    out.push(
      ramp(
        `ms-ramp-station-${String(n)}`,
        `站厅坡道${String(n)}`,
        'b2',
        [module.x + 1, B2, 30],
        [module.x + 8, B1, HALL_MAX_Z],
        PALETTE.stair,
        'wedge-z',
        -1,
      ),
    );
    out.push(
      box(
        `ms-landing-station-${String(n)}`,
        `站厅坡道${String(n)}上平台`,
        'b1',
        'slab',
        [module.x + 1, B1 - 1, HALL_MIN_Z],
        [module.x + 8, B1, 30],
        PALETTE.pavement,
      ),
    );
  });
  out.push(
    ramp('ms-ramp-cine-w', '西影院坡道', 'b3', [12, B3, 84], [34, B1, 96], PALETTE.stair, 'wedge-z', -1),
    ramp('ms-ramp-cine-e', '东影院坡道', 'b3', [142, B3, 84], [164, B1, 96], PALETTE.stair, 'wedge-z', -1),
  );
  return out;
}

/** 楼层标高表，与 example.ts 一致。 */
function levels(): Blueprint['levels'] {
  return [
    { id: 'surface', name: '地表与街面', elevation: SURFACE },
    { id: 'b1', name: '地下一层：商业与站厅', elevation: B1 },
    { id: 'b2', name: '地下二层：站台', elevation: B2 },
    { id: 'b3', name: '地下三层：影院', elevation: B3 },
  ];
}

/** 概念草模说明：讲清表达边界与坡道性质，避免被当成施工图或逐格检查结果。 */
function notes(variant: Variant): string[] {
  return [
    '概念草模；尺寸为建议；斜坡表示上下层连接，不是实际楼梯施工；不含施工级检查。',
    '只表达体量、主要楼层地面、空间范围与挑空；不含墙、门窗、座席、逐级梯、栏杆、树灯、轨道细件与电梯井。',
    '每处层间连接只画一段连续楔体坡道（站厅、影院、入口），不逐级展开；轨道各以一条长带表示。',
    'clearances 为空：旧的逐踏面净空检查不适用于概念坡道；交通可达性与结构承托未验证。',
    '标高：surface y=0、b1 y=−8、b2 y=−16、b3 y=−24；地板占标高下一单位，坡道楔体高端指向上一层。',
    '影厅只有 b3 基底平面与 sp-cine-w / sp-cine-e 挑空线框，无座席台地与荧幕。',
    '西侧通道 sp-west-passage 的大包围盒只用于线框示意，不代表实体墙或一个完整矩形房间。',
    '地表两片草地按入口坡道体量保守开洞（非净空级精算），入口坡道与地表板无正体积交叠；',
    '候车厅地面按四组站厅坡道位置留洞，b1 接口不被完整楼板堵住；草地默认隐藏。',
    variant === 'wider-shop'
      ? 'wider-shop：衣服店地面西端由 x=32 西移到 28，其余体量与坡道不动。'
      : variant === 'wider-cinema'
        ? 'wider-cinema：西影厅基底与检票后廊道西端由 x=32 西移到 24，其余体量与坡道不动。'
        : 'base：原始尺寸；两个 variant 由同一参数化生成函数重建，未改动本版。',
  ];
}

/**
 * 生成一版概念草模。variant 只改变衣服店或西影厅西墙参数再重建；
 * base 衣服店 / 西影厅西墙 x=32，wider-shop 衣服店 28，wider-cinema 西影厅 24。
 */
export function createMassingExample(variant: Variant = 'base'): Blueprint {
  const shopWest = variant === 'wider-shop' ? 28 : 32;
  const cinemaWest = variant === 'wider-cinema' ? 24 : 32;
  const elements: Element[] = [
    ...groundElements(),
    ...entranceElements(),
    ...b1Floors(shopWest),
    ...buildWaitingSlabs(),
    ...b2Floors(),
    ...b3Floors(cinemaWest),
    ...circulationElements(),
  ];
  return Blueprint.parse({
    id: 'bp-underground-plaza-massing',
    revision: variant === 'base' ? 1 : 2,
    title: '地下铁电影院商业街组合体（概念草模）',
    description: '概念级地下综合体草模：主要楼层地面、房间范围、挑空与连续坡道，用于看图讨论体量。',
    levels: levels(),
    spaces: spaces(shopWest, cinemaWest),
    elements,
    clearances: [],
    notes: notes(variant),
  });
}
