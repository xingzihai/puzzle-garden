import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleScheme } from './example.ts';
import { DesignScheme } from './scheme.ts';

function messages(value: unknown): string {
  const result = DesignScheme.safeParse(value);
  if (result.success) throw new Error('期望解析失败，但通过了');
  return result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('；');
}

test('合法方案解析通过，坐标只读且运行时冻结', () => {
  const scheme = exampleScheme();
  assert.equal(scheme.meta.id, 'scheme-tea');
  assert.equal(scheme.spaces.length, 4);
  assert.equal(scheme.openings[0]?.host, 'el-wall-north');
  assert.equal(Object.isFrozen(scheme), true);
  assert.equal(Object.isFrozen(scheme.elements), true);
  assert.equal(Object.isFrozen(scheme.spaces[0]?.bounds.min), true);
});

test('空间 id 重复、楼层 / 连接引用不存在都被拒绝', () => {
  const base = exampleScheme();
  assert.match(messages({ ...base, spaces: [...base.spaces, base.spaces[0]!] }), /空间 id 重复：sp-tea/);
  assert.match(
    messages({ ...base, spaces: base.spaces.map((space) => ({ ...space, level: 'lv-missing' })) }),
    /引用了不存在的楼层 lv-missing/,
  );
  assert.match(
    messages({
      ...base,
      spaces: base.spaces.map((space, index) =>
        index === 0 ? { ...space, connections: [...space.connections, 'sp-missing'] } : space,
      ),
    }),
    /引用了不存在的连接空间 sp-missing/,
  );
});

test('洞口宿主必须存在且是墙 / 楼板，并与洞口同层', () => {
  const base = exampleScheme();
  assert.match(
    messages({
      ...base,
      openings: base.openings.map((opening, index) => (index === 0 ? { ...opening, host: 'el-missing' } : opening)),
    }),
    /引用了不存在的宿主元素 el-missing/,
  );
  assert.match(
    messages({
      ...base,
      openings: base.openings.map((opening, index) => (index === 0 ? { ...opening, host: 'el-counter' } : opening)),
    }),
    /宿主必须是墙或楼板/,
  );
  assert.match(
    messages({
      ...base,
      levels: [...base.levels, { id: 'lv-upper', name: '二层', elevation: 5, height: 3 }],
      openings: base.openings.map((opening, index) => (index === 0 ? { ...opening, level: 'lv-upper' } : opening)),
    }),
    /与宿主 el-wall-north 不在同一楼层/,
  );
});

test('立面材质、场地区域、预算与屋脊一致性都有校验', () => {
  const base = exampleScheme();
  assert.match(
    messages({
      ...base,
      facades: base.facades.map((facade, index) => (index === 0 ? { ...facade, bodyMaterialId: 'm-missing' } : facade)),
    }),
    /引用了不存在的材质 m-missing/,
  );
  assert.match(
    messages({
      ...base,
      site: {
        ...base.site,
        outdoorZones: base.site.outdoorZones.map((zone, index) =>
          index === 0 ? { ...zone, bounds: { min: [-1, 0, 14], max: [16, 1, 18] } } : zone,
        ),
      },
    }),
    /超出场地范围/,
  );
  assert.match(
    messages({
      ...base,
      budget: { ...base.budget, targetBlocks: base.budget.maxBlocks + 1 },
    }),
    /目标方块数不能超过预算上限/,
  );
  assert.match(messages({ ...base, roof: { ...base.roof, ridgeHeight: base.roof.eaveHeight } }), /屋脊必须高于檐口/);
});

test('严格对象拒绝未知字段', () => {
  const base = exampleScheme();
  assert.match(messages({ ...base, surprise: 1 }), /unrecognized key|Unrecognized key/i);
  assert.match(
    messages({ ...base, elements: base.elements.map((element) => ({ ...element, thickness: 1.5 })) }),
    /thickness/,
  );
});

test('交叉引用与唯一性错误逐项报出', () => {
  const base = exampleScheme();
  const firstLevel = base.levels[0]!;
  const firstElement = base.elements[0]!;
  const firstOpening = base.openings[0]!;
  const firstRoute = base.circulation[0]!;
  const firstMaterial = base.materials[0]!;
  const firstFacade = base.facades[0]!;
  const firstDetail = base.details[0]!;
  const firstInterior = base.interiors[0]!;
  const firstDecision = base.decisions[0]!;
  const openItem = {
    id: 'open-x',
    question: '是否增加可开启窗？',
    impact: 'facade',
    owner: 'user',
    status: 'open',
    defaultAssumption: null,
    freeForBuilder: false,
  } as const;

  const cases: readonly (readonly [string, unknown, RegExp])[] = [
    [
      '建筑超出场地',
      { ...base, site: { ...base.site, buildingBounds: { min: [4, 1, 4], max: [25, 8, 14] } } },
      /建筑范围必须完整落在场地范围内/,
    ],
    [
      '场地区域 id 重复',
      { ...base, site: { ...base.site, outdoorZones: [...base.site.outdoorZones, base.site.outdoorZones[0]!] } },
      /场地区域 id 重复/,
    ],
    ['楼层 id 重复', { ...base, levels: [...base.levels, firstLevel] }, /楼层 id 重复/],
    ['元素 id 重复', { ...base, elements: [...base.elements, firstElement] }, /元素 id 重复/],
    [
      '元素楼层不存在',
      {
        ...base,
        elements: base.elements.map((element, index) => (index === 0 ? { ...element, level: 'lv-missing' } : element)),
      },
      /引用了不存在的楼层 lv-missing/,
    ],
    [
      '元素空间不存在',
      {
        ...base,
        elements: base.elements.map((element, index) =>
          index === 0 ? { ...element, spaceId: 'sp-missing' } : element,
        ),
      },
      /引用了不存在的空间 sp-missing/,
    ],
    ['洞口 id 重复', { ...base, openings: [...base.openings, firstOpening] }, /洞口 id 重复/],
    [
      '洞口楼层不存在',
      {
        ...base,
        openings: base.openings.map((opening, index) => (index === 0 ? { ...opening, level: 'lv-missing' } : opening)),
      },
      /引用了不存在的楼层 lv-missing/,
    ],
    ['路线 id 重复', { ...base, circulation: [...base.circulation, firstRoute] }, /路线 id 重复/],
    [
      '路线楼层不存在',
      {
        ...base,
        circulation: base.circulation.map((route, index) => (index === 0 ? { ...route, level: 'lv-missing' } : route)),
      },
      /引用了不存在的楼层 lv-missing/,
    ],
    [
      '路线起点不存在',
      {
        ...base,
        circulation: base.circulation.map((route, index) =>
          index === 0 ? { ...route, fromSpaceId: 'sp-missing' } : route,
        ),
      },
      /引用了不存在的空间 sp-missing/,
    ],
    [
      '路线终点不存在',
      {
        ...base,
        circulation: base.circulation.map((route, index) =>
          index === 0 ? { ...route, toSpaceId: 'sp-missing' } : route,
        ),
      },
      /引用了不存在的空间 sp-missing/,
    ],
    ['材质 id 重复', { ...base, materials: [...base.materials, firstMaterial] }, /材质 id 重复/],
    [
      '立面重复',
      {
        ...base,
        facades: base.facades.map((facade, index) => (index === 1 ? { ...facade, side: firstFacade.side } : facade)),
      },
      /立面重复/,
    ],
    ['细部 id 重复', { ...base, details: [...base.details, firstDetail] }, /细部 id 重复/],
    [
      '细部元素不存在',
      {
        ...base,
        details: base.details.map((detail, index) =>
          index === 0 ? { ...detail, elementIds: ['el-missing'] } : detail,
        ),
      },
      /引用了不存在的 element \/ opening el-missing/,
    ],
    ['室内 id 重复', { ...base, interiors: [...base.interiors, firstInterior] }, /室内 id 重复/],
    [
      '室内空间不存在',
      {
        ...base,
        interiors: base.interiors.map((interior, index) =>
          index === 0 ? { ...interior, spaceId: 'sp-missing' } : interior,
        ),
      },
      /引用了不存在的空间 sp-missing/,
    ],
    ['设计决策 id 重复', { ...base, decisions: [...base.decisions, firstDecision] }, /设计决策 id 重复/],
    ['未决问题 id 重复', { ...base, open: [openItem, openItem] }, /未决问题 id 重复/],
    [
      '估算超过预算',
      { ...base, budget: { ...base.budget, estimatedBlocks: base.budget.maxBlocks + 1 } },
      /估算方块数不能超过预算上限/,
    ],
  ];

  for (const [name, value, pattern] of cases) {
    assert.match(messages(value), pattern, name);
  }
});

test('室内缺少 furnitureSpecs 时拒绝，不用空数组默认补齐', () => {
  const base = exampleScheme();
  const first = base.interiors[0];
  assert.ok(first !== undefined);
  const missing: Record<string, unknown> = { ...first };
  delete missing['furnitureSpecs'];
  assert.match(messages({ ...base, interiors: [missing] }), /furnitureSpecs/);
});

test('细部可以引用洞口 id', () => {
  const base = exampleScheme();
  const detail = base.details[0];
  assert.ok(detail !== undefined);
  const parsed = DesignScheme.parse({
    ...base,
    details: [{ ...detail, elementIds: ['op-south-window'] }],
  });
  assert.deepEqual(parsed.details[0]?.elementIds, ['op-south-window']);
});

test('细部引用同时匹配 element id 与命名空间目标时拒绝，不静默选边', () => {
  const base = exampleScheme();
  const detail = base.details[0];
  assert.ok(detail !== undefined);
  const collided = {
    ...base,
    elements: base.elements.map((element) =>
      element.id === 'el-platform' ? { ...element, id: 'furniture:fu-table' } : element,
    ),
    details: [{ ...detail, elementIds: ['furniture:fu-table'] }],
  };
  assert.match(messages(collided), /存在歧义/);
});
