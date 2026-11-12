import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileBuildBrief } from './brief.ts';
import { exampleRequirements, exampleScheme } from './example.ts';
import { lintBrief } from './lint.ts';

test('完整简报 lint 无问题', () => {
  const brief = compileBuildBrief(exampleScheme(), exampleRequirements());
  assert.deepEqual(lintBrief(brief, exampleRequirements()), []);
});

test('声明完整室内但没有室内条目或结构化家具时，lint 报 interior-missing', () => {
  const base = exampleScheme();
  const noInterior = compileBuildBrief({ ...base, interiors: [] });
  assert.ok(lintBrief(noInterior).some((issue) => issue.code === 'interior-missing'));

  const noFurniture = compileBuildBrief({
    ...base,
    interiors: base.interiors.map((interior) => ({ ...interior, furnitureSpecs: [] })),
  });
  assert.ok(lintBrief(noFurniture).some((issue) => issue.code === 'interior-missing'));
});

test('lint 直接暴露结构问题代码', () => {
  const brief = compileBuildBrief(exampleScheme(), exampleRequirements());
  const missingMust = {
    ...brief,
    spec: { ...brief.spec, musts: [] },
  };
  assert.ok(lintBrief(missingMust, exampleRequirements()).some((issue) => issue.code === 'must-not-in-spec'));
});

test('lint 逐项报告格式、重复、引用、尺寸、预算与长度问题', () => {
  const brief = compileBuildBrief(exampleScheme(), exampleRequirements());
  const firstLevel = brief.spec.levels[0]!;
  const firstMust = brief.spec.musts[0]!;
  const firstForbidden = brief.spec.forbidden[0]!;

  const cases: readonly (readonly [string, unknown, string])[] = [
    ['四节格式', { ...brief, taskMarkdown: '# 只有标题' }, 'section-format'],
    ['must 重复', { ...brief, spec: { ...brief.spec, musts: [firstMust, firstMust] } }, 'must-duplicate'],
    [
      '禁项重复',
      { ...brief, spec: { ...brief.spec, forbidden: [firstForbidden, firstForbidden] } },
      'forbidden-duplicate',
    ],
    ['楼层 id 重复', { ...brief, spec: { ...brief.spec, levels: [...brief.spec.levels, firstLevel] } }, 'duplicate-id'],
    [
      '空间楼层引用',
      {
        ...brief,
        spec: {
          ...brief.spec,
          spaces: brief.spec.spaces.map((space, index) => (index === 0 ? { ...space, level: 'lv-missing' } : space)),
        },
      },
      'level-reference',
    ],
    [
      '空间连接引用',
      {
        ...brief,
        spec: {
          ...brief.spec,
          spaces: brief.spec.spaces.map((space, index) =>
            index === 0 ? { ...space, connections: [...space.connections, 'sp-missing'] } : space,
          ),
        },
      },
      'space-reference',
    ],
    [
      '洞口尺寸不一致',
      {
        ...brief,
        spec: {
          ...brief.spec,
          openings: brief.spec.openings.map((opening, index) =>
            index === 0 ? { ...opening, width: opening.width + 1 } : opening,
          ),
        },
      },
      'opening-size',
    ],
    [
      '路线引用',
      {
        ...brief,
        spec: {
          ...brief.spec,
          routes: brief.spec.routes.map((route, index) =>
            index === 0 ? { ...route, fromSpaceId: 'sp-missing' } : route,
          ),
        },
      },
      'route-reference',
    ],
    [
      '建筑超出场地',
      {
        ...brief,
        spec: {
          ...brief.spec,
          bounds: { min: brief.spec.bounds.min, max: [25, 8, 14] },
        },
      },
      'bounds-outside-site',
    ],
    [
      '计数不一致',
      { ...brief, spec: { ...brief.spec, counts: { ...brief.spec.counts, spaces: 99 } } },
      'count-mismatch',
    ],
    ['预算金额非正', { ...brief, spec: { ...brief.spec, budget: { ...brief.spec.budget, maxCostCny: 0 } } }, 'budget'],
    ['设计报告超长', { ...brief, designMarkdown: 'x'.repeat(64_001) }, 'design-too-long'],
  ];

  for (const [name, value, code] of cases) {
    const issues = lintBrief(value as Parameters<typeof lintBrief>[0]);
    assert.ok(
      issues.some((issue) => issue.code === code),
      `${name} 应报 ${code}，实际 ${issues.map((issue) => issue.code).join('、')}`,
    );
  }
});
