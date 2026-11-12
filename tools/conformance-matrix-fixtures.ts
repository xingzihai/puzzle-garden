/**
 * 多房子 conformance 矩阵 fixture：从零构造 BuildSpec + Grid，不读取 run-9。
 *
 * 每栋房子有独立的尺寸、材质、房间和洞口坐标；good / wrong / unsupported 三种样本只通过
 * 明确的构造选项区分，不复制某一栋真实 run 的 spec。运行时由矩阵写到临时目录。
 */

import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import type { BlockState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';
import type { Grid } from '@pg/core/grid';
import { BuildSpec } from '@pg/interaction/schema';
import type { Bounds, RoofForm } from '@pg/interaction/schema';

import { assertFixtureGeometry, padBounds } from './conformance-matrix-selfcheck.ts';
import type { SelfCheckInput } from './conformance-matrix-selfcheck.ts';

export type HouseKey = 'H1' | 'H2' | 'H3' | 'H4';
export type MatrixVariant = 'good' | 'wrong' | 'unsupported';

const LEVEL = 'f1';
const ELEVATION = 1;
/** 文档口径：楼板占 [elevation-1, elevation)，首层地面顶面就是 elevation。 */
const FLOOR_Y = ELEVATION - 1;
const WALL_TOP = 5;
const ROOF_BASE = 5;

interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}
interface Blocks {
  readonly wall: string;
  readonly floor: string;
  readonly roof: string;
  readonly glass: string;
  readonly trim: string;
  readonly ground: string;
}
interface OpeningPlan {
  readonly id: string;
  readonly name: string;
  readonly kind: 'door' | 'window';
  readonly side: 'north' | 'east' | 'south' | 'west';
  readonly host: string;
  readonly bounds: Bounds;
  readonly width: number;
  readonly height: number;
  readonly sillHeight: number;
  readonly headHeight: number;
  readonly fill: string;
  readonly frameMaterial: string | null;
  /** 实际要挖空的体素；门洞就是 BuildSpec.bounds，洞底与楼面 elevation 对齐。 */
  readonly hole: Bounds;
  readonly glass: Bounds | null;
}
interface RoomPlan {
  readonly id: string;
  readonly name: string;
  readonly kind: 'room' | 'circulation';
  readonly bounds: Bounds;
}
interface RoofPlan {
  readonly form: RoofForm;
  readonly pitchDegrees: number;
  readonly eaveHeight: number;
  readonly ridgeHeight: number;
}
interface HousePlan {
  readonly label: string;
  readonly schemeId: string;
  readonly title: string;
  readonly rects: readonly Rect[];
  readonly rooms: readonly RoomPlan[];
  readonly blocks: Blocks;
  readonly openings: readonly OpeningPlan[];
  readonly roof: RoofPlan;
  readonly footprintArea: number;
  readonly bounds: Bounds;
  readonly siteBounds: Bounds;
}
function box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Bounds {
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
function rect(minX: number, maxX: number, minZ: number, maxZ: number): Rect {
  return { minX, maxX, minZ, maxZ };
}
function boundsOf(rects: readonly Rect[]): Bounds {
  const minX = Math.min(...rects.map((item) => item.minX));
  const maxX = Math.max(...rects.map((item) => item.maxX));
  const minZ = Math.min(...rects.map((item) => item.minZ));
  const maxZ = Math.max(...rects.map((item) => item.maxZ));
  return box(minX, ELEVATION, minZ, maxX + 1, WALL_TOP, maxZ + 1);
}
function siteBoundsOf(building: Bounds): Bounds {
  return box(building.min[0] - 1, 0, building.min[2] - 1, building.max[0] + 1, 8, building.max[2] + 1);
}
function makePlan(input: Omit<HousePlan, 'bounds' | 'siteBounds'>): HousePlan {
  const bounds = boundsOf(input.rects);
  return { ...input, bounds, siteBounds: siteBoundsOf(bounds) };
}
function windowOpening(
  id: string,
  name: string,
  side: OpeningPlan['side'],
  host: string,
  bounds: Bounds,
  width: number,
  height: number,
  sillHeight: number,
): OpeningPlan {
  return {
    id,
    name,
    kind: 'window',
    side,
    host,
    bounds,
    width,
    height,
    sillHeight,
    headHeight: sillHeight + height,
    fill: '玻璃',
    frameMaterial: 'm-trim',
    hole: bounds,
    glass: bounds,
  };
}
function doorOpening(
  id: string,
  name: string,
  side: OpeningPlan['side'],
  host: string,
  bounds: Bounds,
  width: number,
  height: number,
): OpeningPlan {
  return {
    id,
    name,
    kind: 'door',
    side,
    host,
    bounds,
    width,
    height,
    sillHeight: 0,
    headHeight: height,
    fill: '洞口',
    frameMaterial: null,
    hole: bounds,
    glass: null,
  };
}
const H1_RECT = rect(1, 6, 1, 5);
const H2_RECT = rect(1, 10, 1, 8);
const H3_RECT = rect(1, 8, 1, 6);
const H4_MAIN = rect(1, 8, 1, 6);
const H4_WING = rect(1, 4, 6, 10);
const HOUSE_PLANS: Readonly<Record<HouseKey, HousePlan>> = {
  H1: makePlan({
    label: 'H1',
    schemeId: 'matrix-h1-flat',
    title: '6x5 平屋面单间',
    rects: [H1_RECT],
    rooms: [{ id: 'room-workshop', name: '工作室', kind: 'room', bounds: boundsOf([H1_RECT]) }],
    blocks: {
      wall: 'stone_bricks',
      floor: 'polished_andesite',
      roof: 'deepslate_tiles',
      glass: 'glass',
      trim: 'spruce_planks',
      ground: 'gravel',
    },
    openings: [
      doorOpening('op-h1-door', '北侧入口', 'north', 'wall-envelope', box(3, 1, 1, 5, 3, 2), 2, 2),
      windowOpening('op-h1-window', '东侧工作窗', 'east', 'wall-envelope', box(6, 2, 2, 7, 4, 4), 2, 2, 1),
    ],
    roof: { form: 'flat', pitchDegrees: 0, eaveHeight: 5, ridgeHeight: 5 },
    footprintArea: 30,
  }),
  H2: makePlan({
    label: 'H2',
    schemeId: 'matrix-h2-gable',
    title: '10x8 25° 双坡茶室',
    rects: [H2_RECT],
    rooms: [{ id: 'room-tea', name: '茶室', kind: 'room', bounds: boundsOf([H2_RECT]) }],
    blocks: {
      wall: 'oak_planks',
      floor: 'smooth_stone',
      roof: 'bricks',
      glass: 'glass_pane',
      trim: 'stripped_oak_log',
      ground: 'sand',
    },
    openings: [
      doorOpening('op-h2-door', '北侧入口', 'north', 'wall-envelope', box(3, 1, 1, 5, 3, 2), 2, 2),
      windowOpening('op-h2-window', '南侧观景窗', 'south', 'wall-envelope', box(5, 2, 8, 9, 4, 9), 4, 2, 1),
    ],
    roof: { form: 'gable', pitchDegrees: 25, eaveHeight: 5, ridgeHeight: 7 },
    footprintArea: 80,
  }),
  H3: makePlan({
    label: 'H3',
    schemeId: 'matrix-h3-shed',
    title: '8x6 单坡展廊',
    rects: [H3_RECT],
    rooms: [{ id: 'room-gallery', name: '展廊', kind: 'room', bounds: boundsOf([H3_RECT]) }],
    blocks: {
      wall: 'sandstone',
      floor: 'polished_granite',
      roof: 'deepslate_bricks',
      glass: 'light_blue_stained_glass_pane',
      trim: 'birch_planks',
      ground: 'coarse_dirt',
    },
    openings: [
      doorOpening('op-h3-door', '东侧入口', 'east', 'wall-envelope', box(8, 1, 3, 9, 3, 5), 2, 2),
      windowOpening('op-h3-window', '南侧展窗', 'south', 'wall-envelope', box(3, 2, 6, 5, 4, 7), 2, 2, 1),
    ],
    roof: { form: 'shed', pitchDegrees: 22, eaveHeight: 5, ridgeHeight: 7 },
    footprintArea: 48,
  }),
  H4: makePlan({
    label: 'H4',
    schemeId: 'matrix-h4-l-shape',
    title: 'L 形多体量住宅',
    rects: [H4_MAIN, H4_WING],
    rooms: [
      { id: 'room-living', name: '起居厅', kind: 'room', bounds: boundsOf([H4_MAIN]) },
      { id: 'room-reading', name: '书廊', kind: 'room', bounds: box(1, 1, 7, 5, 5, 11) },
    ],
    blocks: {
      wall: 'mud_bricks',
      floor: 'birch_planks',
      roof: 'weathered_cut_copper',
      glass: 'glass',
      trim: 'stripped_birch_log',
      ground: 'moss_block',
    },
    openings: [
      doorOpening('op-h4-door', '翼廊东入口', 'east', 'wall-wing', box(4, 1, 8, 5, 3, 10), 2, 2),
      windowOpening('op-h4-window', '起居厅南窗', 'south', 'wall-main', box(5, 2, 6, 8, 4, 7), 3, 2, 1),
    ],
    roof: {
      form: 'flat',
      pitchDegrees: 0,
      eaveHeight: 5,
      ridgeHeight: 5,
    },
    footprintArea: 64,
  }),
};

function flatSegment(
  id: string,
  eaveHeight: number,
  ridgeHeight: number,
  bounds: Bounds,
): NonNullable<BuildSpec['roof']['segments']>[number] {
  return { id, form: 'flat', material: 'm-roof', pitchDegrees: 0, eaveHeight, ridgeHeight, overhang: 0, bounds };
}

function roofSpec(plan: HousePlan, house: HouseKey, variant: MatrixVariant): BuildSpec['roof'] {
  const common = {
    material: 'm-roof',
    overhang: 0,
    drainage: null,
    skylights: [],
    notes: null,
  };
  if (house === 'H1' && variant === 'unsupported') {
    return {
      ...common,
      form: 'flat',
      pitchDegrees: 0,
      eaveHeight: 5,
      ridgeHeight: 6,
      segments: [
        flatSegment('seg-main', 5, 5, box(1, 5, 1, 7, 6, 6)),
        flatSegment('seg-monitor', 6, 6, box(2, 6, 2, 5, 7, 4)),
      ],
    };
  }
  if (house === 'H2' && variant === 'unsupported') {
    return { ...common, form: 'hip', pitchDegrees: 25, eaveHeight: 5, ridgeHeight: 7 };
  }
  if (house === 'H3' && variant === 'unsupported') {
    return { ...common, form: 'curved', pitchDegrees: 22, eaveHeight: 5, ridgeHeight: 7 };
  }
  if (house === 'H4' && variant === 'unsupported') {
    return { ...common, form: 'butterfly', pitchDegrees: 25, eaveHeight: 5, ridgeHeight: 7 };
  }
  if (house === 'H4') {
    return {
      ...common,
      form: plan.roof.form,
      pitchDegrees: plan.roof.pitchDegrees,
      eaveHeight: plan.roof.eaveHeight,
      ridgeHeight: plan.roof.ridgeHeight,
      segments: [
        flatSegment('seg-main', 5, 5, box(1, 5, 1, 9, 6, 7)),
        flatSegment('seg-wing', 5, 5, box(1, 5, 6, 5, 6, 11)),
      ],
    };
  }
  return {
    ...common,
    form: plan.roof.form,
    pitchDegrees: plan.roof.pitchDegrees,
    eaveHeight: plan.roof.eaveHeight,
    ridgeHeight: plan.roof.ridgeHeight,
  };
}

function materials(plan: HousePlan): readonly unknown[] {
  return [
    { id: 'm-wall', name: '墙体', block: plan.blocks.wall, role: 'wall', color: null, notes: null },
    { id: 'm-floor', name: '室内地面', block: plan.blocks.floor, role: 'floor', color: null, notes: null },
    { id: 'm-roof', name: '屋面', block: plan.blocks.roof, role: 'roof', color: null, notes: null },
    { id: 'm-glass', name: '玻璃', block: plan.blocks.glass, role: 'glass', color: null, notes: null },
    { id: 'm-trim', name: '门窗框', block: plan.blocks.trim, role: 'trim', color: null, notes: null },
    { id: 'm-ground', name: '室外地面', block: plan.blocks.ground, role: 'landscape', color: null, notes: null },
  ];
}

export function buildSpec(house: HouseKey, variant: MatrixVariant): BuildSpec {
  const plan = HOUSE_PLANS[house];
  const spaces = plan.rooms.map((room) => ({
    id: room.id,
    name: room.name,
    level: LEVEL,
    kind: room.kind,
    bounds: room.bounds,
    areaM2: (room.bounds.max[0] - room.bounds.min[0]) * (room.bounds.max[2] - room.bounds.min[2]),
    connections: [],
  }));
  const wallElements = plan.rects.map((item, index) => {
    const room = spaces[index];
    return {
      id: house === 'H4' ? (index === 0 ? 'wall-main' : 'wall-wing') : 'wall-envelope',
      name: house === 'H4' ? (index === 0 ? '主体外墙' : '翼廊外墙') : '外围护墙',
      level: LEVEL,
      kind: 'wall',
      bounds: box(item.minX, ELEVATION, item.minZ, item.maxX + 1, WALL_TOP, item.maxZ + 1),
      material: 'm-wall',
      spaceId: room?.id ?? null,
    };
  });
  const floorElements = plan.rects.map((item, index) => ({
    id: house === 'H4' ? (index === 0 ? 'slab-main' : 'slab-wing') : 'slab-floor',
    name: '地面层楼板',
    level: LEVEL,
    kind: 'slab',
    bounds: box(item.minX, ELEVATION - 1, item.minZ, item.maxX + 1, ELEVATION, item.maxZ + 1),
    material: 'm-floor',
    spaceId: spaces[index]?.id ?? null,
  }));
  const roofElement = {
    id: 'roof-envelope',
    name: '屋面体量',
    level: LEVEL,
    kind: 'roof',
    bounds: plan.bounds,
    material: 'm-roof',
    spaceId: null,
  };
  const elements = [...wallElements, ...floorElements, roofElement];
  const openings = plan.openings.map((opening) => ({
    id: opening.id,
    name: opening.name,
    level: LEVEL,
    host: opening.host,
    kind: opening.kind,
    side: opening.side,
    bounds: opening.bounds,
    width: opening.width,
    height: opening.height,
    sillHeight: opening.sillHeight,
    headHeight: opening.headHeight,
    fill: opening.fill,
    frameMaterial: opening.frameMaterial,
  }));
  const counts = {
    levels: 1,
    spaces: spaces.length,
    elements: elements.length,
    openings: openings.length,
    routes: 0,
    musts: 2,
    footprintX: plan.bounds.max[0] - plan.bounds.min[0],
    footprintZ: plan.bounds.max[2] - plan.bounds.min[2],
    footprintAreaM2: plan.footprintArea,
  };
  return BuildSpec.parse({
    schemeId: plan.schemeId,
    schemeRevision: 1,
    title: plan.title,
    scope: 'exterior+entry',
    bounds: plan.bounds,
    siteBounds: plan.siteBounds,
    levels: [{ id: LEVEL, name: '地面层', elevation: ELEVATION, height: 4 }],
    spaces,
    elements,
    openings,
    routes: [],
    structure: {
      system: 'load-bearing-walls',
      material: 'm-wall',
      spanX: counts.footprintX,
      spanZ: counts.footprintZ,
      floorThickness: 1,
      cantilever: 0,
      notes: null,
    },
    roof: roofSpec(plan, house, variant),
    facades: [],
    materials: materials(plan),
    details: [],
    interiors: [],
    counts,
    budget: { maxBlocks: 20_000, targetBlocks: null, estimatedBlocks: null, maxCostCny: null },
    forbidden: [],
    musts: [
      { id: 'must-no-step', text: '入口与室外地面齐平，不设台阶，无高差。', source: 'detail' },
      { id: 'must-door-clear', text: '门内 1m 净空不得有家具或墙体遮挡。', source: 'detail' },
    ],
  });
}

function inside(bounds: Bounds, x: number, y: number, z: number): boolean {
  return (
    x >= bounds.min[0] &&
    x < bounds.max[0] &&
    y >= bounds.min[1] &&
    y < bounds.max[1] &&
    z >= bounds.min[2] &&
    z < bounds.max[2]
  );
}

function forEachCell(bounds: Bounds, visit: (x: number, y: number, z: number) => void): void {
  for (let x = bounds.min[0]; x < bounds.max[0]; x += 1) {
    for (let y = bounds.min[1]; y < bounds.max[1]; y += 1) {
      for (let z = bounds.min[2]; z < bounds.max[2]; z += 1) visit(x, y, z);
    }
  }
}

function wallRuns(house: HouseKey, plan: HousePlan): readonly Bounds[] {
  if (house !== 'H4') {
    const item = plan.rects[0];
    if (item === undefined) throw new Error(`${house} 缺 footprint`);
    return [
      box(item.minX, ELEVATION, item.minZ, item.maxX + 1, WALL_TOP, item.minZ + 1),
      box(item.minX, ELEVATION, item.maxZ, item.maxX + 1, WALL_TOP, item.maxZ + 1),
      box(item.minX, ELEVATION, item.minZ, item.minX + 1, WALL_TOP, item.maxZ + 1),
      box(item.maxX, ELEVATION, item.minZ, item.maxX + 1, WALL_TOP, item.maxZ + 1),
    ];
  }
  return [
    box(1, ELEVATION, 1, 9, WALL_TOP, 2),
    box(8, ELEVATION, 1, 9, WALL_TOP, 7),
    box(5, ELEVATION, 6, 9, WALL_TOP, 7),
    box(1, ELEVATION, 1, 2, WALL_TOP, 11),
    box(4, ELEVATION, 7, 5, WALL_TOP, 11),
    box(1, ELEVATION, 10, 5, WALL_TOP, 11),
  ];
}

function effectiveHole(house: HouseKey, variant: MatrixVariant, opening: OpeningPlan): Bounds {
  if (house === 'H3' && variant === 'wrong' && opening.kind === 'door') {
    return box(
      opening.hole.min[0],
      opening.hole.min[1],
      opening.hole.min[2],
      opening.hole.max[0],
      opening.hole.max[1] + 1,
      opening.hole.max[2],
    );
  }
  return opening.hole;
}

const H2_GOOD = [5, 5, 6, 6, 7, 6, 6, 5, 5, 5] as const;
const H2_WRONG = [5, 7, 6, 6, 6, 6, 6, 6, 6, 5] as const;
const H3_SHED = [5, 5, 6, 6, 6, 7] as const;
const H3_CURVED = [5, 6, 7, 7, 6, 5] as const;

function roofTop(house: HouseKey, variant: MatrixVariant, x: number, z: number): number {
  if (house === 'H1') {
    if (variant === 'wrong') return 6;
    if (variant === 'unsupported' && x >= 2 && x <= 4 && z >= 2 && z <= 3) return 6;
    return ROOF_BASE;
  }
  if (house === 'H2') {
    if (variant === 'wrong') return H2_WRONG[x - 1] ?? ROOF_BASE;
    if (variant === 'unsupported') return ROOF_BASE + Math.min(2, x - 1, 10 - x, z - 1, 8 - z);
    return H2_GOOD[x - 1] ?? ROOF_BASE;
  }
  if (house === 'H3') {
    if (variant === 'unsupported') return H3_CURVED[z - 1] ?? ROOF_BASE;
    return H3_SHED[z - 1] ?? ROOF_BASE;
  }
  if (variant === 'unsupported') {
    const valley = z <= 6 ? 3 : 8;
    return ROOF_BASE + Math.min(2, Math.abs(z - valley));
  }
  return ROOF_BASE;
}

export function buildGrid(house: HouseKey, variant: MatrixVariant): Grid {
  const plan = HOUSE_PLANS[house];
  const registry = loadRegistry();
  const grid = createGrid(registry.table);
  const call = grid.defineCall('set', 1, { fixture: `${house}-${variant}` });
  const states = new Map<string, BlockState>();
  const put = (x: number, y: number, z: number, block: string): void => {
    let state = states.get(block);
    if (state === undefined) {
      state = parseState(registry.table, block);
      states.set(block, state);
    }
    grid.set(x, y, z, state, 0, call);
  };
  const fill = (bounds: Bounds, block: string): void => {
    forEachCell(bounds, (x, y, z) => {
      put(x, y, z, block);
    });
  };

  for (const item of plan.rects) {
    fill(box(item.minX, FLOOR_Y, item.minZ, item.maxX + 1, ELEVATION, item.maxZ + 1), plan.blocks.floor);
  }
  const wallMaxY = house === 'H1' && variant === 'wrong' ? WALL_TOP + 1 : WALL_TOP;
  for (const run of wallRuns(house, plan)) {
    const bounds = box(run.min[0], run.min[1], run.min[2], run.max[0], wallMaxY, run.max[2]);
    forEachCell(bounds, (x, y, z) => {
      const carved = plan.openings.some((opening) => inside(effectiveHole(house, variant, opening), x, y, z));
      if (!carved) put(x, y, z, plan.blocks.wall);
    });
  }
  for (const opening of plan.openings) {
    if (opening.glass !== null) fill(opening.glass, plan.blocks.glass);
    if (opening.kind === 'door') fill(padBounds(opening, ELEVATION), plan.blocks.ground);
  }
  if (house === 'H4' && variant === 'wrong') {
    // 窗外 1 格壳上的连续砖梁：故意遮挡南窗，但不改变窗扇几何。
    fill(box(5, 3, 7, 8, 4, 8), plan.blocks.wall);
  }
  for (const item of plan.rects) {
    for (let x = item.minX; x <= item.maxX; x += 1) {
      for (let z = item.minZ; z <= item.maxZ; z += 1) {
        const top = roofTop(house, variant, x, z);
        for (let y = ROOF_BASE; y <= top; y += 1) put(x, y, z, plan.blocks.roof);
      }
    }
  }
  return grid;
}

export interface Fixture {
  readonly house: HouseKey;
  readonly variant: MatrixVariant;
  readonly spec: BuildSpec;
  readonly grid: Grid;
}

export function selfCheckInputFor(house: HouseKey, variant: MatrixVariant): SelfCheckInput {
  const plan = HOUSE_PLANS[house];
  return {
    house,
    variant,
    elevation: ELEVATION,
    rects: plan.rects,
    blocks: plan.blocks,
    openings: plan.openings.map((opening) => ({ ...opening, hole: effectiveHole(house, variant, opening) })),
    roofMatchesSpec: !((house === 'H1' || house === 'H2') && variant === 'wrong'),
    windowShellIntact: !(house === 'H4' && variant === 'wrong'),
    doorHoleIntact: !(house === 'H3' && variant === 'wrong'),
    roofTop: (x, z) => roofTop(house, variant, x, z),
  };
}

export function buildFixture(house: HouseKey, variant: MatrixVariant): Fixture {
  const spec = buildSpec(house, variant);
  const grid = buildGrid(house, variant);
  assertFixtureGeometry(spec, grid, selfCheckInputFor(house, variant));
  return { house, variant, spec, grid };
}
