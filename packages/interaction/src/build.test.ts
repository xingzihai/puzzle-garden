import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileBuildSpec } from './brief.ts';
import { BuildSpec, selectEntranceOpening } from './build.ts';
import { exampleRequirements, exampleScheme } from './example.ts';
import { DesignScheme } from './scheme.ts';

test('compileBuildSpec 生成与方案一致的机器约束', () => {
  const scheme = exampleScheme();
  const spec = compileBuildSpec(scheme, exampleRequirements());
  assert.equal(spec.schemeId, 'scheme-tea');
  assert.equal(spec.schemeRevision, 1);
  assert.equal(spec.title, '稻田茶亭');
  assert.equal(spec.entranceSide, 'north');
  assert.equal(spec.levels.length, 1);
  assert.equal(spec.spaces[0]?.areaM2, 48);
  const firstOpening = spec.openings[0];
  assert.ok(firstOpening);
  assert.equal(firstOpening.width, 2);
  assert.equal(firstOpening.height, 2);
  assert.equal(firstOpening.fill, 'm-door');
  assert.equal(spec.counts.spaces, scheme.spaces.length);
  assert.equal(spec.counts.footprintX, 12);
  assert.equal(spec.counts.footprintZ, 10);
  assert.equal(
    spec.musts.some((must) => must.id === 'req-use'),
    true,
  );
  assert.equal(
    spec.forbidden.some((item) => item.includes('旅游景点')),
    true,
  );
  assert.equal(Object.isFrozen(spec), true);
});

test('BuildSpec 严格拒绝未知字段与缺失标题', () => {
  const spec = compileBuildSpec(exampleScheme());
  assert.equal(BuildSpec.safeParse({ ...spec, surprise: 1 }).success, false);
  const withoutTitle = { ...spec } as Record<string, unknown>;
  delete withoutTitle['title'];
  assert.equal(BuildSpec.safeParse(withoutTitle).success, false);
});

test('selectEntranceOpening：同侧多门按 scheme 顺序，不按 id 排序，窗口永不作为入口', () => {
  const base = exampleScheme();
  const template = base.openings[0];
  assert.ok(template);
  const eastWindow = {
    ...template,
    id: 'op-window-east',
    name: '东侧窗',
    host: 'el-wall-east',
    kind: 'window' as const,
    side: 'east' as const,
    bounds: { min: [15, 2, 5], max: [16, 4, 7] } as const,
  };
  // id 字典序 a < b，但 scheme 里 b 先出现；BuildSheet 口径必须选 b。
  const eastDoorB = {
    ...template,
    id: 'op-door-east-b',
    name: '东门 B',
    host: 'el-wall-east',
    side: 'east' as const,
    bounds: { min: [15, 1, 7], max: [16, 3, 9] } as const,
  };
  const eastDoorA = {
    ...template,
    id: 'op-door-east-a',
    name: '东门 A',
    host: 'el-wall-east',
    side: 'east' as const,
    bounds: { min: [15, 1, 9], max: [16, 3, 11] } as const,
  };
  const scheme = DesignScheme.parse({
    ...base,
    site: { ...base.site, entranceSide: 'east' },
    openings: [...base.openings, eastWindow, eastDoorB, eastDoorA],
  });
  const spec = compileBuildSpec(scheme, exampleRequirements());
  assert.deepEqual(
    spec.openings.map((opening) => opening.id),
    scheme.openings.map((opening) => opening.id),
  );
  assert.equal(selectEntranceOpening(spec)?.id, 'op-door-east-b');

  const specWindow = spec.openings.find((opening) => opening.id === 'op-window-east');
  const specDoorA = spec.openings.find((opening) => opening.id === 'op-door-east-a');
  const specDoorB = spec.openings.find((opening) => opening.id === 'op-door-east-b');
  assert.ok(specWindow);
  assert.ok(specDoorA);
  assert.ok(specDoorB);
  const onlyWindowFirst = {
    ...spec,
    openings: [specWindow, specDoorA, specDoorB],
  };
  assert.equal(selectEntranceOpening(onlyWindowFirst)?.id, 'op-door-east-a');

  // 声明侧没有非窗洞口时回退北侧；连北侧都没有才取第一个非窗洞口。
  assert.equal(selectEntranceOpening({ ...spec, entranceSide: 'south' })?.id, 'op-door');
  const noNorth = spec.openings.filter((opening) => opening.side !== 'north');
  assert.equal(selectEntranceOpening({ openings: noNorth, entranceSide: 'south' })?.id, 'op-door-east-b');
  assert.equal(selectEntranceOpening({ openings: [], entranceSide: 'north' }), undefined);
});

test('entranceSide 回归：非北入口 + 多门时保留 scheme.site.entranceSide', () => {
  const base = exampleScheme();
  const northDoor = base.openings.find((opening) => opening.kind === 'door');
  assert.ok(northDoor);
  const eastDoor = {
    ...northDoor,
    id: 'op-door-east',
    name: '东侧次入口',
    host: 'el-wall-east',
    side: 'east' as const,
    bounds: { min: [15, 1, 7], max: [16, 3, 9] } as const,
  };
  const scheme = DesignScheme.parse({
    ...base,
    site: { ...base.site, entranceSide: 'east' },
    openings: [...base.openings, eastDoor],
  });
  const spec = compileBuildSpec(scheme, exampleRequirements());
  assert.equal(spec.entranceSide, 'east');
  assert.deepEqual(
    spec.openings
      .filter((opening) => opening.kind === 'door')
      .map((opening) => opening.side)
      .sort(),
    ['east', 'north'],
  );
  assert.equal(BuildSpec.parse(JSON.parse(JSON.stringify(spec)) as unknown).entranceSide, 'east');
  // 旧 build-spec.json 没有 entranceSide 时仍可读，不能因新增字段破坏回放。
  const legacy = { ...spec } as Record<string, unknown>;
  delete legacy['entranceSide'];
  assert.equal(BuildSpec.safeParse(legacy).success, true);
});
