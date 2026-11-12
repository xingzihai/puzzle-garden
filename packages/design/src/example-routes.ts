/**
 * 人工样例的代表路线（配合 routes.ts 的 validateRoute）。
 *
 * 负责：把 BLUEPRINT-EXAMPLE / example.ts 里的关键交通写成明确路线，坐标按格柱 {x, z, y=顶面}。
 * 覆盖：两入口 9 级梯到下平台并转入 B1、四组站厅交通两跑折返经中平台、两处影院叠梯经 −16 转接、
 * 两影厅双门各到后排与中央通道、两影厅每排从侧 / 中央通道到座位前、美食店员工门到内部站立区。
 * 不负责：自动寻路、路线可行性放宽、修改蓝本几何。任一坐标改动都必须与 example.ts 的实际几何同步。
 *
 * 美食店员工门曾被柜台堵住，已缩短柜台留出门后通路；该路线保留为回归检查，不绕过原门位。
 */
import type { Variant } from './example.ts';
import type { Route, RouteStep } from './routes.ts';
import { Route as RouteSchema } from './routes.ts';

const SURFACE = 0;
const B1 = -8;
const B2 = -16;
const B3 = -24;

/** 四组站厅交通模块原点 (x, z)，模块外包 22×14；与 example.ts 保持一致。 */
const STATION_MODULES: readonly { readonly x: number; readonly z: number }[] = [
  { x: 28, z: 29 },
  { x: 56, z: 29 },
  { x: 84, z: 29 },
  { x: 112, z: 29 },
];

/** 两端影院交通模块原点；每处叠放 B3（−24→−16）与 B2（−16→−8）两段。 */
const CINEMA_MODULES: readonly { readonly x: number; readonly z: number; readonly name: string }[] = [
  { x: 12, z: 84, name: '西影院交通' },
  { x: 142, z: 84, name: '东影院交通' },
];

function stand(x: number, z: number, y: number): RouteStep {
  return { kind: 'stand', x, z, y };
}

function run(axis: 'x' | 'z', from: number, to: number, cross: number, startY: number, step: number): RouteStep {
  return { kind: 'run', axis, from, to, cross, startY, step };
}

function route(id: string, name: string, steps: readonly RouteStep[]): Route {
  return RouteSchema.parse({ id, name, steps });
}

/** 两座地面入口：上平台 → 9 级梯 → 下平台 → 转到 B1 连接地面（含下平台转弯短段）。 */
function entryRoutes(): Route[] {
  return [
    route('rt-entry-n', '北入口 9 级梯与下平台转入 B1', [
      stand(3, 6, SURFACE),
      run('x', 4, 6, 6, 1, 0),
      run('x', 7, 15, 6, 0, -1),
      stand(16, 6, B1),
      run('z', 7, 8, 16, B1, 0),
    ]),
    route('rt-entry-s', '南入口 9 级梯与下平台转入 B1', [
      stand(97, 146, SURFACE),
      run('x', 96, 94, 146, 1, 0),
      run('x', 93, 85, 146, 0, -1),
      stand(84, 146, B1),
      run('z', 147, 148, 84, B1, 0),
    ]),
  ];
}

/** 四组站厅交通：从 B2 平台经下平台、第一跑、中平台、第二跑到上层平台与 B1 候车厅。 */
function stationRoutes(): Route[] {
  return STATION_MODULES.map((module, index) => {
    const ox = module.x;
    const oz = module.z;
    return route(`rt-station-${String(index + 1)}`, `站厅交通${String(index + 1)}：两跑折返经中平台到 B1`, [
      stand(ox - 1, oz + 2, B2),
      stand(ox, oz + 2, B2),
      stand(ox + 1, oz + 2, B2),
      stand(ox + 2, oz + 2, B2),
      stand(ox + 2, oz + 3, B2),
      run('z', oz + 4, oz + 7, ox + 2, B2 + 1, 1),
      stand(ox + 2, oz + 8, B2 + 4),
      stand(ox + 2, oz + 9, B2 + 4),
      run('x', ox + 3, ox + 6, oz + 9, B2 + 4, 0),
      stand(ox + 6, oz + 8, B2 + 4),
      run('z', oz + 7, oz + 4, ox + 6, B2 + 5, 1),
      run('z', oz + 3, oz - 1, ox + 6, B2 + 8, 0),
    ]);
  });
}

/** 两处影院叠梯：B3 低段上到 −16 上平台，平移到同标高的高段下平台，再上到 B1 街面。 */
function cinemaRoutes(): Route[] {
  return CINEMA_MODULES.map((module, index) => {
    const ox = module.x;
    const oz = module.z;
    return route(`rt-cinema-${String(index + 1)}`, `${module.name}：B3 与 B2 两段经 −16 平台转接`, [
      stand(ox + 2, oz - 1, B3),
      stand(ox + 2, oz, B3),
      run('z', oz + 1, oz + 3, ox + 2, B3, 0),
      run('z', oz + 4, oz + 7, ox + 2, B3 + 1, 1),
      stand(ox + 2, oz + 8, B3 + 4),
      stand(ox + 2, oz + 9, B3 + 4),
      run('x', ox + 3, ox + 5, oz + 9, B3 + 4, 0),
      stand(ox + 5, oz + 8, B3 + 4),
      run('z', oz + 7, oz + 4, ox + 5, B3 + 5, 1),
      stand(ox + 5, oz + 3, B3 + 8),
      stand(ox + 5, oz + 2, B3 + 8),
      stand(ox + 4, oz + 2, B3 + 8),
      stand(ox + 3, oz + 2, B3 + 8),
      stand(ox + 3, oz + 3, B2),
      run('z', oz + 4, oz + 7, ox + 3, B2 + 1, 1),
      stand(ox + 3, oz + 8, B2 + 4),
      stand(ox + 3, oz + 9, B2 + 4),
      run('x', ox + 4, ox + 5, oz + 9, B2 + 4, 0),
      stand(ox + 5, oz + 8, B2 + 4),
      run('z', oz + 7, oz + 4, ox + 5, B2 + 5, 1),
      stand(ox + 5, oz + 3, B2 + 8),
      run('z', oz + 2, oz - 1, ox + 5, B2 + 8, 0),
    ]);
  });
}

/** 影厅后排路线：北门 → 门槛地面 → 前横通道 → 该侧通道逐排台地 → 后横通道。 */
function rearSteps(column: number): RouteStep[] {
  const steps: RouteStep[] = [stand(column, 104, B3), stand(column, 105, B3), run('z', 106, 113, column, B3, 0)];
  for (let row = 0; row < 8; row += 1) {
    steps.push(run('z', 114 + 3 * row, 115 + 3 * row, column, B3 + row, 0));
    if (row < 7) steps.push(stand(column, 116 + 3 * row, B3 + row + 1));
  }
  steps.push(run('z', 137, 141, column, B3 + 7, 0));
  return steps;
}

/** 影厅中央通道路线：北门 → 前横通道横穿 → 中央通道逐排台地 → 后横通道。 */
function centerSteps(doorColumn: number, centerColumn: number): RouteStep[] {
  const startX = doorColumn < centerColumn ? doorColumn + 1 : doorColumn - 1;
  const steps: RouteStep[] = [
    stand(doorColumn, 104, B3),
    stand(doorColumn, 105, B3),
    run('z', 106, 110, doorColumn, B3, 0),
    run('x', startX, centerColumn, 110, B3, 0),
    run('z', 111, 113, centerColumn, B3, 0),
  ];
  for (let row = 0; row < 8; row += 1) {
    steps.push(run('z', 114 + 3 * row, 115 + 3 * row, centerColumn, B3 + row, 0));
    if (row < 7) steps.push(stand(centerColumn, 116 + 3 * row, B3 + row + 1));
  }
  steps.push(run('z', 137, 141, centerColumn, B3 + 7, 0));
  return steps;
}

/** 一座影厅的四条代表路线：两个北门各到后排、各到中央通道。 */
function hallRoutes(hall: 'w' | 'e', westOuter: number, eastOuter: number): Route[] {
  const doorWest = westOuter + 5;
  const doorEast = eastOuter - 5;
  const center = eastOuter - 24;
  const label = hall === 'w' ? '西影厅' : '东影厅';
  return [
    route(`rt-hall-${hall}-door-w-rear`, `${label}西门到后排`, rearSteps(doorWest)),
    route(`rt-hall-${hall}-door-w-center`, `${label}西门到中央通道`, centerSteps(doorWest, center)),
    route(`rt-hall-${hall}-door-e-rear`, `${label}东门到后排`, rearSteps(doorEast)),
    route(`rt-hall-${hall}-door-e-center`, `${label}东门到中央通道`, centerSteps(doorEast, center)),
  ];
}

/**
 * 从影厅前横通道沿一条纵向通道爬到第 row 排（0-based）座位前的逐格序列。
 * 第 row 排台地占 z[114+3row, 116+3row)，座席家具只铺在 z0+1，座位前空出的 z0 作站点，不站家具。
 */
function aisleClimb(column: number, row: number): RouteStep[] {
  const steps: RouteStep[] = [];
  for (let index = 0; index < row; index += 1) {
    steps.push(run('z', 114 + 3 * index, 115 + 3 * index, column, B3 + index, 0));
    steps.push(stand(column, 116 + 3 * index, B3 + index + 1));
  }
  steps.push(stand(column, 114 + 3 * row, B3 + row));
  return steps;
}

/**
 * 一座影厅每排两条到座位前的路线（共 2×8 条）：
 * - `-rowN-side`：西门 → 西侧通道逐排上台地 → 西座席前横穿 → 中央通道（走过 wa 与 wc）；
 * - `-rowN-central`：东门 → 前横通道横穿 → 中央通道逐排上台地 → 东座席前横穿 → 东侧通道（走过 ce 与 ea）。
 * 台地、rowlink 与两侧座席前都在其中被逐格走到，验证新补的通行面确实连通。
 */
function seatRowRoutes(hall: 'w' | 'e', westOuter: number, eastOuter: number): Route[] {
  const doorWest = westOuter + 5;
  const doorEast = eastOuter - 5;
  const center = eastOuter - 24;
  const label = hall === 'w' ? '西影厅' : '东影厅';
  const routes: Route[] = [];
  for (let row = 0; row < 8; row += 1) {
    const z0 = 114 + 3 * row;
    const top = B3 + row;
    const rowLabel = String(row + 1);
    routes.push(
      route(`rt-hall-${hall}-row${rowLabel}-side`, `${label}第${rowLabel}排：西侧通道经西座席前到中央通道`, [
        stand(doorWest, 104, B3),
        stand(doorWest, 105, B3),
        run('z', 106, 113, doorWest, B3, 0),
        ...aisleClimb(doorWest, row),
        run('x', doorWest + 1, center, z0, top, 0),
      ]),
    );
    routes.push(
      route(`rt-hall-${hall}-row${rowLabel}-central`, `${label}第${rowLabel}排：中央通道经东座席前到东侧通道`, [
        stand(doorEast, 104, B3),
        stand(doorEast, 105, B3),
        run('z', 106, 110, doorEast, B3, 0),
        run('x', doorEast - 1, center, 110, B3, 0),
        run('z', 111, 113, center, B3, 0),
        ...aisleClimb(center, row),
        run('x', center + 1, doorEast, z0, top, 0),
      ]),
    );
  }
  return routes;
}

/** 美食店员工门：从临街东半入口绕到北侧员工门外，再向南穿过员工门进入制作区。 */
function foodRoute(): Route {
  return route('rt-food-staff', '美食店员工门到内部站立区', [
    stand(130, 70, B1),
    run('z', 69, 63, 130, B1, 0),
    run('x', 129, 124, 63, B1, 0),
    stand(124, 64, B1),
    stand(124, 65, B1),
    stand(124, 66, B1),
    stand(124, 67, B1),
    stand(124, 68, B1),
    stand(124, 69, B1),
  ]);
}

/** 生成一版样例的全部代表路线。variant 只影响影厅西墙，因而只影响西影厅与西影院交通之外的门位。 */
export function createExampleRoutes(variant: Variant = 'base'): readonly Route[] {
  const cinemaWest = variant === 'wider-cinema' ? 24 : 32;
  return [
    ...entryRoutes(),
    ...stationRoutes(),
    ...cinemaRoutes(),
    ...hallRoutes('w', cinemaWest, 80),
    ...seatRowRoutes('w', cinemaWest, 80),
    ...hallRoutes('e', 100, 148),
    ...seatRowRoutes('e', 100, 148),
    foodRoute(),
  ];
}
