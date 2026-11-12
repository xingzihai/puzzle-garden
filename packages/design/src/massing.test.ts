/**
 * 概念草模的好坏样本：三版都合法、无细节构件、坡道端点与真实支承板相邻、
 * 任意两元素无正体积交叠（含入口坡道 / 地表、影院坡道 / 各层平板）、
 * variant 只改预期布局、旧 example 细稿保留未被改动、候车厅楼板按坡道留洞。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffBlueprint } from './diff.ts';
import { createExample } from './example.ts';
import { createMassingExample } from './massing.ts';
import type { Bounds, Element } from './schema.ts';
import { Blueprint } from './schema.ts';

const VARIANTS = ['base', 'wider-shop', 'wider-cinema'] as const;
/** 草模允许出现的 kind；wall / furnishing / glazing / marker 一律不得出现。 */
const ALLOWED_KINDS = new Set(['slab', 'stair', 'landscape']);
/** id / 名称里不得出现的细节词（大小写不敏感）。 */
const DETAIL_TOKENS = ['wall', 'seat', 'step', 'glazing', 'furnish', '座', '阶', '墙', '栏杆', '荧幕'];
/** 已知楼面标高。 */
const ELEVATIONS = new Set([0, -8, -16, -24]);

function byId(elements: readonly Element[], id: string): Element {
  const found = elements.find((item) => item.id === id);
  if (found === undefined) throw new Error(`找不到元素 ${id}`);
  return found;
}

/** 半开区间下是否真有正体积交叠（接触面不算）。 */
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

/** 水平投影相接或重叠（允许面贴面），用于判断坡道端点与支承板是否真相邻。 */
function footprintTouches(a: Bounds, b: Bounds): boolean {
  return a.min[0] <= b.max[0] && b.min[0] <= a.max[0] && a.min[2] <= b.max[2] && b.min[2] <= a.max[2];
}

test('三版都合法、保留 21 个空间、元素数稳定且不硬编码具体值', () => {
  const counts = new Set<number>();
  for (const variant of VARIANTS) {
    const blueprint = createMassingExample(variant);
    assert.equal(Blueprint.safeParse(blueprint).success, true, `${variant} 应能解析`);
    assert.equal(blueprint.spaces.length, 21, `${variant} 应保留 21 个空间`);
    assert.equal(
      blueprint.spaces.some((space) => space.id === 'sp-west-passage'),
      true,
    );
    assert.equal(Object.isFrozen(blueprint), true);
    assert.equal(blueprint.elements.length > 0, true);
    assert.equal(
      blueprint.elements.length <= 100,
      true,
      `${variant} 元素数 ${String(blueprint.elements.length)} 应不超过 100`,
    );
    counts.add(blueprint.elements.length);
  }
  assert.equal(counts.size, 1, '三版元素数应一致');
  assert.equal(createMassingExample().id, 'bp-underground-plaza-massing', '缺省 variant 应为 base 方案');
});

test('不含墙 / 陈设 / 玻璃 / 座席 / 逐级梯等细节构件', () => {
  for (const variant of VARIANTS) {
    const blueprint = createMassingExample(variant);
    for (const item of blueprint.elements) {
      assert.equal(ALLOWED_KINDS.has(item.kind), true, `${item.id} 出现细节 kind ${item.kind}`);
      assert.equal(item.kind !== 'marker', true, `${item.id} 不应使用 marker 冒充体量`);
      const hay = `${item.id} ${item.name}`.toLowerCase();
      for (const token of DETAIL_TOKENS) {
        assert.equal(hay.includes(token), false, `${item.id} / ${item.name} 含细节词 ${token}`);
      }
    }
    assert.equal(
      blueprint.elements.some((item) => item.kind === 'stair'),
      true,
      '至少用坡道表达层间连接',
    );
  }
});

test('坡道两端标高与方向对应，高低端都有真实相邻的同标高支承板（不只比 y）', () => {
  for (const variant of VARIANTS) {
    const blueprint = createMassingExample(variant);
    const ramps = blueprint.elements.filter((item) => item.kind === 'stair');
    assert.equal(ramps.length, 8, `${variant} 应有 8 段坡道`);
    const supports = blueprint.elements.filter((item) => item.kind !== 'stair');
    for (const rampItem of ramps) {
      assert.equal(rampItem.shape === 'wedge-x' || rampItem.shape === 'wedge-z', true, `${rampItem.id} 应为楔体坡道`);
      const lowY = rampItem.bounds.min[1];
      const highY = rampItem.bounds.max[1];
      assert.equal(ELEVATIONS.has(lowY), true, `${rampItem.id} 低端 ${String(lowY)} 应是楼面标高`);
      assert.equal(ELEVATIONS.has(highY), true, `${rampItem.id} 高端 ${String(highY)} 应是楼面标高`);
      assert.equal(highY > lowY, true, `${rampItem.id} 高端应高于低端`);
      // 方向必须指向高端所在的轴端：−1 高端在负方向端，1 高端在正方向端。
      const axis = rampItem.shape === 'wedge-x' ? 0 : 2;
      const highEnd = rampItem.direction === -1 ? rampItem.bounds.min[axis] : rampItem.bounds.max[axis];
      const lowEnd = rampItem.direction === -1 ? rampItem.bounds.max[axis] : rampItem.bounds.min[axis];
      assert.equal(highEnd !== lowEnd, true, `${rampItem.id} 高端与低端应分处两端`);
      // 端点支承：顶面标高一致，且水平投影与坡道相接 / 重叠，拒绝只靠 y 命中的远端板。
      assert.equal(
        supports.some(
          (support) => support.bounds.max[1] === highY && footprintTouches(support.bounds, rampItem.bounds),
        ),
        true,
        `${rampItem.id} 高端 ${String(highY)} 缺水平相邻的同标高支承板`,
      );
      assert.equal(
        supports.some((support) => support.bounds.max[1] === lowY && footprintTouches(support.bounds, rampItem.bounds)),
        true,
        `${rampItem.id} 低端 ${String(lowY)} 缺水平相邻的同标高支承板`,
      );
    }
  }
});

test('任意两元素无正体积交叠，入口坡道 / 地表与影院坡道 / 各层平板显式复核', () => {
  for (const variant of VARIANTS) {
    const blueprint = createMassingExample(variant);
    for (const [index, first] of blueprint.elements.entries()) {
      for (const second of blueprint.elements.slice(index + 1)) {
        assert.equal(
          intersects(first.bounds, second.bounds),
          false,
          `${variant}: ${first.id} 与 ${second.id} 存在正体积交叠`,
        );
      }
    }
    const entryRamps = blueprint.elements.filter((item) => item.id.startsWith('ms-entry-') && item.kind === 'stair');
    const surfacePlates = blueprint.elements.filter((item) => item.level === 'surface' && item.kind === 'landscape');
    for (const rampItem of entryRamps) {
      for (const plate of surfacePlates) {
        assert.equal(intersects(rampItem.bounds, plate.bounds), false, `${rampItem.id} 与 ${plate.id} 交叠`);
      }
    }
    const cinemaRamps = blueprint.elements.filter((item) => item.id.startsWith('ms-ramp-cine-'));
    const lowerPlates = blueprint.elements.filter((item) => item.level === 'b1' || item.level === 'b2');
    assert.equal(cinemaRamps.length, 2);
    for (const rampItem of cinemaRamps) {
      for (const plate of lowerPlates) {
        assert.equal(intersects(rampItem.bounds, plate.bounds), false, `${rampItem.id} 与 ${plate.id} 交叠`);
      }
    }
  }
});

test('候车厅地面按四组站厅坡道留洞，不被完整楼板堵住', () => {
  const blueprint = createMassingExample('base');
  const waiting = blueprint.elements.filter((item) => item.id.startsWith('ms-floor-waiting-'));
  assert.equal(waiting.length, 5, '四组洞把候车厅切成五条地板带');
  const stationRamps = blueprint.elements.filter(
    (item) => item.kind === 'stair' && item.id.startsWith('ms-ramp-station-'),
  );
  assert.equal(stationRamps.length, 4);
  for (const rampItem of stationRamps) {
    for (const band of waiting) {
      const overlapX = band.bounds.min[0] < rampItem.bounds.max[0] && rampItem.bounds.min[0] < band.bounds.max[0];
      assert.equal(overlapX, false, `${rampItem.id} 的占位不应被候车厅楼板盖住`);
    }
    const landing = byId(blueprint.elements, rampItem.id.replace('ms-ramp-', 'ms-landing-'));
    assert.equal(landing.bounds.max[1], rampItem.bounds.max[1], '上平台顶面应与坡道高端同标高');
    assert.equal(footprintTouches(landing.bounds, rampItem.bounds), true, '上平台应与坡道高端水平相邻');
  }
});

test('variant 只修改衣服店或西影厅的预期布局', () => {
  const base = createMassingExample('base');
  assert.deepEqual(diffBlueprint(base, createMassingExample('wider-shop')), {
    added: [],
    removed: [],
    changed: ['ms-floor-clothing'],
    spacesChanged: ['sp-clothing'],
  });
  assert.deepEqual(diffBlueprint(base, createMassingExample('wider-cinema')), {
    added: [],
    removed: [],
    changed: ['ms-floor-cine-w', 'ms-floor-corridor'],
    spacesChanged: ['sp-cine-w', 'sp-corridor'],
  });
});

test('旧 example 细稿保留，草模未改动也未被替代', () => {
  const old = createExample('base');
  assert.equal(
    old.elements.some((item) => item.kind === 'wall'),
    true,
    '旧稿仍含墙',
  );
  assert.equal(
    old.elements.some((item) => item.kind === 'furnishing'),
    true,
    '旧稿仍含陈设',
  );
  assert.equal(byId(old.elements, 'el-shop-west').bounds.min[0], 32);
  assert.equal(byId(old.elements, 'el-cine-w-west').bounds.min[0], 32);
  const mass = createMassingExample('base');
  const oldIds = new Set(old.elements.map((item) => item.id));
  for (const item of mass.elements) {
    assert.equal(item.id.startsWith('ms-'), true, `${item.id} 应以 ms- 开头`);
    assert.equal(oldIds.has(item.id), false, `草模 id ${item.id} 不应与旧稿重复`);
  }
});

test('clearances 为空且 notes 说明概念草模与坡道性质', () => {
  for (const variant of VARIANTS) {
    const blueprint = createMassingExample(variant);
    assert.equal(blueprint.clearances.length, 0, '概念坡道不套用旧逐格净空检查');
    assert.equal(blueprint.notes.length >= 6, true, 'notes 应说明表达边界');
    assert.equal(
      blueprint.notes.some(
        (note) => note.includes('概念草模') && note.includes('不是实际楼梯施工') && note.includes('不含施工级检查'),
      ),
      true,
      '缺少必写说明',
    );
  }
});
