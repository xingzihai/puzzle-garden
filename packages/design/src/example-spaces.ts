/**
 * 空间范围与元素 → 空间的归属映射。
 *
 * 负责：spaces(shopWest, cinemaWest) 生成可选显示的空间范围（随 variant 宽度参数变化）；
 * withSpaces(elements) 按 id 前缀优先级给每个元素挂 spaceId。
 * 不负责：几何生成、净空判定、schema 校验。
 *
 * 为什么用前缀映射而不是几何包含：墙贴着多个空间、楼梯跨层，若按"哪个空间完全包含元素"判断，
 * 边界构件会被分到大空间（例如通向影厅的走廊）。这里显式登记每个部件的服务空间，先匹配者胜。
 */
import type { Element, Space } from './schema.ts';
import { PALETTE } from './example-interiors.ts';

const B1 = -8;
const B2 = -16;
const B3 = -24;

function space(
  id: string,
  name: string,
  level: string,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  role: Space['role'],
  color: string,
): Space {
  return { id, name, level, bounds: { min, max }, role, color };
}

/** 空间范围（可选显示，不参与净空判定）；店铺 / 西影厅范围随 variant 宽度参数。 */
export function spaces(shopWest: number, cinemaWest: number): Space[] {
  return [
    space('sp-park', '地表公园', 'surface', [0, -2, 0], [176, 0, 160], 'room', PALETTE.grass),
    space('sp-street', '商业街', 'b1', [12, B1, 72], [164, -2, 84], 'circulation', PALETTE.pavement),
    space('sp-clothing', '衣服店', 'b1', [shopWest, B1, 60], [64, -2, 72], 'room', PALETTE.wood),
    space('sp-food', '美食店', 'b1', [112, B1, 60], [144, -2, 72], 'room', PALETTE.wood),
    space('sp-jewel', '珠宝店', 'b1', [36, B1, 84], [76, -2, 96], 'room', PALETTE.quartz),
    space('sp-band', '站厅入口带', 'b1', [72, B1, 48], [100, -2, 72], 'circulation', PALETTE.pavement),
    space('sp-waiting', '候车大厅', 'b1', [24, B1, 24], [152, -2, 48], 'circulation', PALETTE.pavement),
    space('sp-concourse', '南集散平台', 'b1', [76, B1, 84], [104, -2, 96], 'circulation', PALETTE.pavement),
    space('sp-south-passage', '南入口通道', 'b1', [81, B1, 96], [98, -2, 153], 'circulation', PALETTE.pavement),
    space('sp-platform', '站台', 'b2', [24, B2, 24], [152, B2 + 7, 48], 'room', PALETTE.pavement),
    space('sp-cine-waiting', '影院等待厅', 'b3', [34, B3, 84], [142, B3 + 7, 98], 'room', PALETTE.pavement),
    space('sp-corridor', '检票后廊道', 'b3', [cinemaWest, B3, 98], [148, B3 + 3, 104], 'circulation', PALETTE.pavement),
    space('sp-cine-w', '西影厅挑空', 'b3', [cinemaWest, B3, 104], [80, -2, 144], 'void', PALETTE.screenConcrete),
    space('sp-cine-e', '东影厅挑空', 'b3', [100, B3, 104], [148, -2, 144], 'void', PALETTE.screenConcrete),
    space('sp-north-entry', '北入口', 'surface', [4, 0, 4], [20, 8, 13], 'circulation', PALETTE.glazing),
    space('sp-south-entry', '南入口', 'surface', [81, 0, 144], [97, 8, 153], 'circulation', PALETTE.glazing),
    space('sp-west-passage', '西侧通道', 'b1', [4, B1, 8], [21, -2, 80], 'circulation', PALETTE.pavement),
    space('sp-track-n', '北轨道', 'b2', [24, B2, 18], [152, B2 + 7, 23], 'room', PALETTE.road),
    space('sp-track-s', '南轨道', 'b2', [24, B2, 49], [152, B2 + 7, 54], 'room', PALETTE.road),
    space('sp-cine-traffic-w', '西影院交通组', 'b3', [12, B3, 84], [34, -2, 98], 'circulation', PALETTE.stair),
    space('sp-cine-traffic-e', '东影院交通组', 'b3', [142, B3, 84], [164, -2, 98], 'circulation', PALETTE.stair),
  ];
}

/** 元素 → 空间的显式优先级映射（id 前缀，先匹配者胜）。 */
const SPACE_RULES: readonly (readonly [string, string])[] = [
  ['el-track-bed-n', 'sp-track-n'],
  ['el-track-bed-s', 'sp-track-s'],
  ['el-rail-1', 'sp-track-n'],
  ['el-rail-2', 'sp-track-n'],
  ['el-rail-3', 'sp-track-s'],
  ['el-rail-4', 'sp-track-s'],
  ['el-entry-n-', 'sp-north-entry'],
  ['el-entry-s-', 'sp-south-entry'],
  ['el-path-', 'sp-park'],
  ['el-park-', 'sp-park'],
  ['el-tree-', 'sp-park'],
  ['el-lamp-', 'sp-park'],
  ['el-floor-street', 'sp-street'],
  ['el-street-', 'sp-street'],
  ['el-floor-clothing', 'sp-clothing'],
  ['el-shop-', 'sp-clothing'],
  ['el-floor-food', 'sp-food'],
  ['el-food-', 'sp-food'],
  ['el-jewel-', 'sp-jewel'],
  ['el-floor-band', 'sp-band'],
  ['el-band-', 'sp-band'],
  ['el-floor-waiting', 'sp-waiting'],
  ['el-hall-', 'sp-waiting'],
  ['el-station-', 'sp-waiting'],
  ['el-floor-concourse', 'sp-concourse'],
  ['el-concourse-', 'sp-concourse'],
  ['el-floor-south-passage', 'sp-south-passage'],
  ['el-southpassage-', 'sp-south-passage'],
  ['el-floor-west-', 'sp-west-passage'],
  ['el-platform-', 'sp-platform'],
  ['el-column-', 'sp-platform'],
  ['el-b2-', 'sp-platform'],
  ['el-cw-', 'sp-cine-traffic-w'],
  ['el-ce-', 'sp-cine-traffic-e'],
  ['el-b3-link', 'sp-cine-waiting'],
  ['el-b3-waiting', 'sp-cine-waiting'],
  ['el-b3-ticket', 'sp-cine-waiting'],
  ['el-b3-snacks', 'sp-cine-waiting'],
  ['el-b3-checkin', 'sp-corridor'],
  ['el-b3-corridor', 'sp-corridor'],
  ['el-cine-w-', 'sp-cine-w'],
  ['el-cine-e-', 'sp-cine-e'],
];

/** 给每个元素按其 id 前缀挂上所属空间；未匹配的保持无 spaceId（由测试兜底不允许出现）。 */
export function withSpaces(elements: readonly Element[]): Element[] {
  return elements.map((item) => {
    const rule = SPACE_RULES.find(([prefix]) => item.id.startsWith(prefix));
    return rule === undefined ? item : { ...item, spaceId: rule[1] };
  });
}
