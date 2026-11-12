/** 样例蓝图的好坏样本：三版都合法且净空通过、variant 关联加宽、入口梯与影院标高、notes 可读、diff 可见。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkBlueprint } from './checks.ts';
import { diffBlueprint } from './diff.ts';
import { createExample } from './example.ts';
import type { Bounds, Element } from './schema.ts';
import { Blueprint } from './schema.ts';

function byId(elements: readonly Element[], id: string): Element {
  const found = elements.find((item) => item.id === id);
  if (found === undefined) throw new Error(`找不到元素 ${id}`);
  return found;
}

function span(bounds: Bounds, axis: 0 | 1 | 2): number {
  return bounds.max[axis] - bounds.min[axis];
}

/** 半开区间包围盒是否相交（供几何非重叠检查，不参与实现逻辑）。 */
function intersects(a: Bounds, b: Bounds): boolean {
  return (
    a.min[0] < b.max[0] &&
    b.min[0] < a.max[0] &&
    a.min[1] < b.max[1] &&
    b.min[1] < a.max[1] &&
    a.min[2] < b.max[2] &&
    b.min[2] < a.max[2]
  );
}

test('三版都能解析为合法 Blueprint（revision 是数字），对象冻结且字段只读', () => {
  for (const variant of ['base', 'wider-shop', 'wider-cinema'] as const) {
    const blueprint = createExample(variant);
    assert.equal(typeof blueprint.revision, 'number');
    assert.equal(blueprint.levels.map((level) => level.id).join(','), 'surface,b1,b2,b3');
    assert.equal(Object.isFrozen(blueprint), true);
    assert.equal(Object.isFrozen(blueprint.elements), true);
    assert.equal(Blueprint.safeParse(blueprint).success, true);
  }
});

test('base 与两个 variant 的净空全部通过，至少 10 个净空且不为放行冲突而忽略实体', () => {
  for (const variant of ['base', 'wider-shop', 'wider-cinema'] as const) {
    const blueprint = createExample(variant);
    const report = checkBlueprint(blueprint);
    assert.equal(
      report.status,
      'pass',
      `${variant} 净空应通过：${report.issues.map((issue) => issue.message).join(' / ')}`,
    );
    assert.equal(report.checkedClearances >= 10, true, `${variant} 至少 10 个净空`);
    assert.equal(
      blueprint.clearances.every((clearance) => clearance.ignoreElementIds.length === 0),
      true,
      '不应靠忽略实体通过',
    );
  }
});

test('wider-shop：衣服店净宽 +4 且店内结构同步，西影厅与珠宝店不动', () => {
  const base = createExample('base');
  const wider = createExample('wider-shop');
  assert.equal(byId(base.elements, 'el-shop-west').bounds.min[0], 32);
  assert.equal(byId(wider.elements, 'el-shop-west').bounds.min[0], 28);
  assert.equal(
    span(byId(wider.elements, 'el-shop-north').bounds, 0) - span(byId(base.elements, 'el-shop-north').bounds, 0),
    4,
  );
  for (const id of ['el-shop-counter', 'el-shop-fitting-w', 'el-shop-seat-base', 'el-shop-rack-w']) {
    assert.equal(
      byId(wider.elements, id).bounds.min[0] - byId(base.elements, id).bounds.min[0],
      -4,
      `${id} 应同步西移 4`,
    );
  }
  assert.deepEqual(byId(wider.elements, 'el-shop-east').bounds, byId(base.elements, 'el-shop-east').bounds);
  assert.deepEqual(byId(wider.elements, 'el-cine-w-west').bounds, byId(base.elements, 'el-cine-w-west').bounds);
  const diff = diffBlueprint(base, wider);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.changed.includes('el-shop-west'), true);
  assert.equal(diff.changed.includes('el-shop-counter'), true);
  assert.equal(diff.changed.includes('el-cine-w-west'), false, '加宽衣服店不应改到影院');
  assert.equal(diff.spacesChanged.includes('sp-clothing'), true, '衣服店空间范围应随 variant 变宽');
});

test('wider-cinema：西影厅净宽 +8、西门 / 侧通道 / 荧幕 / 座席同步，东厅与中央不变', () => {
  const base = createExample('base');
  const wider = createExample('wider-cinema');
  assert.equal(byId(base.elements, 'el-cine-w-west').bounds.min[0], 32);
  assert.equal(byId(wider.elements, 'el-cine-w-west').bounds.min[0], 24);
  assert.equal(span(byId(wider.elements, 'el-cine-w-north-1').bounds, 0), 4, '西门段应仍在西端');
  assert.equal(byId(wider.elements, 'el-cine-w-screen-glass').bounds.min[0], 32);
  assert.equal(byId(wider.elements, 'el-cine-w-screen-glass').bounds.max[0], 72, '荧幕东端固定');
  assert.deepEqual(byId(wider.elements, 'el-cine-e-west').bounds, byId(base.elements, 'el-cine-e-west').bounds);
  assert.deepEqual(byId(wider.elements, 'el-cine-w-seat-e-1').bounds, byId(base.elements, 'el-cine-w-seat-e-1').bounds);
  assert.equal(byId(wider.elements, 'el-shop-west').bounds.min[0], 32, '加宽影院不应改到衣服店');
  const diff = diffBlueprint(base, wider);
  assert.equal(diff.changed.includes('el-cine-w-west'), true);
  assert.equal(diff.changed.includes('el-cine-w-screen-glass'), true);
  assert.equal(diff.changed.includes('el-cine-w-seat-w-1'), true);
  assert.equal(diff.changed.includes('el-cine-e-west'), false);
  assert.equal(diff.changed.includes('el-shop-west'), false);
  assert.deepEqual(diff.spacesChanged, ['sp-cine-w', 'sp-corridor'], '西影厅与检票后廊道空间范围应同时变宽');
});

test('入口步行梯 9 级、标高从 +1 附近降到 −8；影院西厅 8 排台地从 −24 升到 −17', () => {
  const blueprint = createExample('base');
  const northSteps = blueprint.elements.filter((item) => item.id.startsWith('el-entry-n-stair-'));
  assert.equal(northSteps.length, 9);
  assert.equal(byId(blueprint.elements, 'el-entry-n-stair-1').bounds.max[1], 0);
  assert.equal(byId(blueprint.elements, 'el-entry-n-stair-9').bounds.max[1], -8);
  const southSteps = blueprint.elements.filter((item) => item.id.startsWith('el-entry-s-stair-'));
  assert.equal(southSteps.length, 9);
  assert.equal(byId(blueprint.elements, 'el-entry-s-stair-1').bounds.max[1], -8);
  assert.equal(byId(blueprint.elements, 'el-entry-s-stair-9').bounds.max[1], 0);

  const terraces = blueprint.elements.filter((item) => item.id.startsWith('el-cine-w-terrace-w-'));
  assert.equal(terraces.length, 8);
  assert.deepEqual(
    terraces.map((item) => item.bounds.max[1]),
    [-24, -23, -22, -21, -20, -19, -18, -17],
  );
});

test('关键体量互不重叠：两影厅、四组站厅交通、站台与轨道、衣服店与珠宝店', () => {
  const blueprint = createExample('base');
  const west = byId(blueprint.elements, 'el-cine-w-west').bounds;
  const east = byId(blueprint.elements, 'el-cine-e-east').bounds;
  assert.equal(west.max[0] <= east.min[0], true, '两影厅之间应有余量');

  const stationIds = [1, 2, 3, 4].map((n) => `el-station-${String(n)}-run1-1`);
  for (let i = 0; i < stationIds.length; i += 1) {
    for (let j = i + 1; j < stationIds.length; j += 1) {
      assert.equal(
        intersects(
          byId(blueprint.elements, stationIds[i] ?? '').bounds,
          byId(blueprint.elements, stationIds[j] ?? '').bounds,
        ),
        false,
        `交通 ${String(i + 1)} 与 ${String(j + 1)} 不应重叠`,
      );
    }
  }
  assert.equal(
    intersects(
      byId(blueprint.elements, 'el-track-bed-n').bounds,
      byId(blueprint.elements, 'el-platform-slab-1').bounds,
    ),
    false,
  );
  assert.equal(
    intersects(byId(blueprint.elements, 'el-shop-north').bounds, byId(blueprint.elements, 'el-jewel-north-1').bounds),
    false,
  );
});

test('b1 / b2 不覆盖影厅挑空：挑空范围内没有该两层楼板实体', () => {
  const blueprint = createExample('wider-cinema');
  const inWestVoid = (element: Element): boolean =>
    (element.level === 'b1' || element.level === 'b2') &&
    element.bounds.min[0] < 79 &&
    25 < element.bounds.max[0] &&
    element.bounds.min[2] < 143 &&
    105 < element.bounds.max[2];
  assert.equal(blueprint.elements.some(inWestVoid), false, 'b1/b2 楼板不应覆盖西影厅挑空');
});

test('notes 非空、长度合规，且点明版本差异与简化说明', () => {
  for (const variant of ['base', 'wider-shop', 'wider-cinema'] as const) {
    const blueprint = createExample(variant);
    assert.equal(blueprint.notes.length > 0, true);
    assert.equal(
      blueprint.notes.every((note) => note.length > 0 && note.length <= 1000),
      true,
    );
    assert.equal(
      blueprint.notes.some((note) => note.includes('简化')),
      true,
    );
  }
  assert.equal(
    createExample('wider-shop').notes.some((note) => note.includes('wider-shop')),
    true,
  );
  assert.equal(
    createExample('wider-cinema').notes.some((note) => note.includes('wider-cinema')),
    true,
  );
});

test('每个元素都挂 spaceId 且能解析；关键构件按前缀优先级归属正确', () => {
  for (const variant of ['base', 'wider-shop', 'wider-cinema'] as const) {
    const blueprint = createExample(variant);
    const spaceIds = new Set(blueprint.spaces.map((entry) => entry.id));
    assert.equal(
      blueprint.elements.every((item) => item.spaceId !== undefined),
      true,
      `${variant} 有元素缺少 spaceId`,
    );
    assert.equal(
      blueprint.elements.every((item) => item.spaceId !== undefined && spaceIds.has(item.spaceId)),
      true,
      `${variant} 有元素的 spaceId 解析不到`,
    );
  }
  const blueprint = createExample('base');
  assert.equal(byId(blueprint.elements, 'el-shop-counter').spaceId, 'sp-clothing');
  assert.equal(byId(blueprint.elements, 'el-cine-w-seat-w-1').spaceId, 'sp-cine-w');
  assert.equal(byId(blueprint.elements, 'el-cine-e-screen-glass').spaceId, 'sp-cine-e');
  assert.equal(byId(blueprint.elements, 'el-station-1-run1-1').spaceId, 'sp-waiting');
  assert.equal(byId(blueprint.elements, 'el-entry-n-stair-1').spaceId, 'sp-north-entry');
  assert.equal(byId(blueprint.elements, 'el-platform-slab-1').spaceId, 'sp-platform');
  assert.equal(byId(blueprint.elements, 'el-food-table-n-120').spaceId, 'sp-food');
});

test('地表顶盖完整覆盖两影厅，只在两座入口梯井开洞', () => {
  const blueprint = createExample('base');
  const covered = (x: number, z: number): boolean =>
    blueprint.elements.some(
      (item) =>
        (item.id.startsWith('el-park-') || item.id.startsWith('el-path-')) &&
        item.bounds.min[0] < x &&
        x < item.bounds.max[0] &&
        item.bounds.min[2] < z &&
        z < item.bounds.max[2],
    );
  assert.equal(covered(50, 120), true, '西影厅上方应有地表覆盖');
  assert.equal(covered(120, 120), true, '东影厅上方应有地表覆盖');
  assert.equal(covered(10, 6), false, '北入口梯井应开洞');
  assert.equal(covered(90, 146), false, '南入口梯井应开洞');
});

test('影院通道逐排台地与行间单阶、后横通道为薄板、北门有门槛楼板', () => {
  const blueprint = createExample('base');
  const terraces = blueprint.elements.filter(
    (item) => item.id.startsWith('el-cine-w-aisle-w-') && !item.id.includes('step'),
  );
  assert.equal(terraces.length, 8, '西侧通道逐排台地 8 段');
  assert.equal(byId(blueprint.elements, 'el-cine-w-aisle-w-1').bounds.max[1], -24);
  assert.equal(byId(blueprint.elements, 'el-cine-w-aisle-w-8').bounds.max[1], -17);
  assert.equal(byId(blueprint.elements, 'el-cine-w-aisle-w-step-1').bounds.max[1], -23, '行间单阶升 1');
  // 中央与东侧通道同样有逐排台地
  assert.equal(byId(blueprint.elements, 'el-cine-w-aisle-c-8').bounds.max[1], -17);
  assert.equal(byId(blueprint.elements, 'el-cine-w-aisle-e-8').bounds.max[1], -17);
  // 后横通道是 1 厚平台，不再整块填高
  const rear = byId(blueprint.elements, 'el-cine-w-rear-aisle');
  assert.equal(rear.bounds.max[1] - rear.bounds.min[1], 1);
  assert.equal(rear.bounds.max[1], -17);
  // 北门门槛楼板补上 z[104,105)
  assert.equal(byId(blueprint.elements, 'el-cine-w-door-floor-w').bounds.min[2], 104);
  assert.equal(byId(blueprint.elements, 'el-cine-w-door-floor-w').bounds.max[2], 105);
});

test('影院叠梯在 −16 拼成完整 u[1,8) 转接平台，两段平台边界相接', () => {
  const blueprint = createExample('base');
  const lowUpper = byId(blueprint.elements, 'el-cw-low-landing-high');
  const highLower = byId(blueprint.elements, 'el-cw-high-landing-low');
  assert.equal(lowUpper.bounds.min[1], -17);
  assert.equal(highLower.bounds.min[1], -17);
  // 低段上平台 u[4,8) x[16,20)，高段下平台 u[1,4) x[13,16)，在 x=16 相接
  assert.equal(lowUpper.bounds.min[0], 16);
  assert.equal(highLower.bounds.min[0], 13);
  assert.equal(highLower.bounds.max[0], 16);
  assert.equal(lowUpper.bounds.max[0], 20);
});

test('美食店：柜台不填满制作区，玻璃隔断在 x[123,126) 留员工门', () => {
  const blueprint = createExample('base');
  const counter = byId(blueprint.elements, 'el-food-counter');
  assert.equal(counter.bounds.max[2] <= 69, true, '柜台不延伸到制作区深处');
  const partition = blueprint.elements.filter((item) => item.id.startsWith('el-food-partition'));
  assert.equal(partition.length, 2, '隔断被员工门分成两段');
  assert.equal(
    partition.some((item) => item.bounds.min[0] < 126 && 123 < item.bounds.max[0]),
    false,
    '员工门 x[123,126) 内无隔断',
  );
});

test('净空按踏面生成：入口 / 层间梯 / 影院通道逐级净空均存在', () => {
  const blueprint = createExample('base');
  const report = checkBlueprint(blueprint);
  assert.equal(report.status, 'pass');
  assert.equal(report.checkedClearances > 100, true, `净空数应覆盖逐踏面，实际 ${String(report.checkedClearances)}`);
  assert.equal(
    blueprint.clearances.some((item) => item.id === 'cl-entry-n-1'),
    true,
  );
  assert.equal(
    blueprint.clearances.some((item) => item.id === 'cl-sta-1-r1-1'),
    true,
  );
  assert.equal(
    blueprint.clearances.some((item) => item.id === 'cl-cine-w-w-1'),
    true,
  );
});

test('影院每排通道与座席之间的 1 格缝由同高通行面补齐，r>0 可进排', () => {
  const blueprint = createExample('base');
  const w = 32;
  const e = 80;
  const links: readonly (readonly [string, number, number])[] = [
    ['wa', w + 7, w + 8],
    ['wc', e - 27, e - 26],
    ['ce', e - 22, e - 21],
    ['ea', e - 8, e - 7],
  ];
  for (let r = 0; r < 8; r += 1) {
    const z0 = 114 + 3 * r;
    const top = -24 + r;
    for (const [tag, from, to] of links) {
      const link = byId(blueprint.elements, `el-cine-w-rowlink-${tag}-${String(r + 1)}`);
      assert.equal(link.bounds.max[1], top, `${tag} 第 ${String(r + 1)} 排通行面与台地同高`);
      assert.equal(link.bounds.min[0], from);
      assert.equal(link.bounds.max[0], to);
      assert.equal(link.bounds.min[2], z0);
      assert.equal(link.bounds.max[2], z0 + 2);
    }
  }
  // 通道台地 → 通行面 → 座席台地在同一排同高且边界相接（第 3 排 r=2，顶 −22）
  assert.equal(byId(blueprint.elements, 'el-cine-w-aisle-w-3').bounds.max[1], -22);
  assert.equal(
    byId(blueprint.elements, 'el-cine-w-aisle-w-3').bounds.max[0],
    byId(blueprint.elements, 'el-cine-w-rowlink-wa-3').bounds.min[0],
  );
  assert.equal(
    byId(blueprint.elements, 'el-cine-w-rowlink-wa-3').bounds.max[0],
    byId(blueprint.elements, 'el-cine-w-terrace-w-3').bounds.min[0],
  );
  assert.equal(byId(blueprint.elements, 'el-cine-w-terrace-w-3').bounds.max[1], -22);
});

test('影院北门净高 3：门洞下段无实墙、上方有过梁', () => {
  const blueprint = createExample('base');
  const solidInDoor = (x0: number, x1: number, yBottom: number, yTop: number): boolean =>
    blueprint.elements.some(
      (item) =>
        item.bounds.min[0] < x1 &&
        x0 < item.bounds.max[0] &&
        item.bounds.min[2] < 105 &&
        104 < item.bounds.max[2] &&
        item.bounds.min[1] < yTop &&
        item.bounds.max[1] > yBottom,
    );
  // 西门 x[36,39) 下三单位 [−24,−21) 无墙
  assert.equal(solidInDoor(36, 39, -24, -21), false);
  const lintel = byId(blueprint.elements, 'el-cine-w-door-lintel-w');
  assert.equal(lintel.bounds.min[1], -21);
  assert.equal(lintel.bounds.max[1], -2);
});

test('影院电梯只在 B3 与 B1 停靠，B2 井壁封闭', () => {
  const blueprint = createExample('base');
  const solidInDoor = (yBottom: number, yTop: number): boolean =>
    blueprint.elements.some(
      (item) =>
        item.bounds.min[0] < 25 &&
        23 < item.bounds.max[0] &&
        item.bounds.min[2] < 86 &&
        85 < item.bounds.max[2] &&
        item.bounds.min[1] < yTop &&
        item.bounds.max[1] > yBottom,
    );
  // 低段 base：门在 B3（−24..−21）开，门上有过梁（beam-1 = −21..−16）
  assert.equal(solidInDoor(-24, -21), false);
  assert.equal(byId(blueprint.elements, 'el-cw-low-lift-n-beam-1').bounds.min[1], -21);
  assert.equal(byId(blueprint.elements, 'el-cw-low-lift-w').bounds.max[1], -16, '叠放低段井壁只到 f+8');
  // 高段 top：B2（−16..−13）实心（beam-1 = −16..−8），门在站立面 f+8 之上（−8..−5）
  assert.equal(solidInDoor(-16, -13), true);
  assert.equal(solidInDoor(-8, -5), false);
  assert.equal(byId(blueprint.elements, 'el-cw-high-lift-n-beam-1').bounds.max[1], -8);
  assert.equal(byId(blueprint.elements, 'el-cw-high-lift-n-beam-2').bounds.min[1], -5);
  assert.equal(byId(blueprint.elements, 'el-cw-high-lift-w').bounds.max[1], -4, 'top 门井壁盖到 f+12');
  assert.equal(byId(blueprint.elements, 'el-cw-high-lift-stop-top').bounds.max[1], -8);
  assert.equal(byId(blueprint.elements, 'el-cw-high-lift-threshold-top').bounds.max[1], -8);
});
