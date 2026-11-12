/**
 * BuildSheet 单元测试：run-9 冻结 spec 的 5 个期望对象 / 41 条 must / 基准面 / 无齐平冲突，
 * H1–H4 good 的通用性，以及确定性 JSON / markdown 与 artifact 写入。
 * 全部离线；不读 .work、不跑 checker、不调用模型。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { compileBuildSpec } from '@pg/interaction/brief';
import { isFlushMustText } from '@pg/interaction/flush-text';
import { planVerifiedObjectMap } from '@pg/interaction/must-links';
import { BuildSpec, buildMustLedger, DesignScheme, RequirementGraph } from '@pg/interaction/schema';

import type { BuildSheet, BuildSheetObject } from './build-sheet.ts';
import {
  adoptVerifiedMustMapping,
  buildBuildSheet,
  buildVerifiedMustMapping,
  renderBuildSheetJson,
  renderBuildSheetMarkdown,
  renderVerifiedMustMapJson,
  writeBuildSheetArtifacts,
  writeVerifiedMustMapArtifact,
} from './build-sheet.ts';
import { projectExpectedObjects } from './conformance-expect.ts';
import { buildFixture } from './conformance-matrix-fixtures.ts';

const RUN9_SPEC = BuildSpec.parse(
  JSON.parse(readFileSync(new URL('./fixtures/conformance-run9/build-spec.json', import.meta.url), 'utf8')) as unknown,
);
const RUN9_IDS = ['wall:f1', 'slab:f1', 'roof', 'opening:op-entry-north', 'opening:op-south-window'] as const;

const RUN7_REQUIREMENTS = RequirementGraph.parse(
  JSON.parse(
    readFileSync(new URL('../packages/interaction/fixtures/run7-requirements.json', import.meta.url), 'utf8'),
  ) as unknown,
);
const RUN7_SCHEME = DesignScheme.parse(
  JSON.parse(
    readFileSync(new URL('../packages/interaction/fixtures/run7-rev2-scheme.json', import.meta.url), 'utf8'),
  ) as unknown,
);
const RUN7_SPEC = compileBuildSpec(RUN7_SCHEME, RUN7_REQUIREMENTS);
const RUN7_TRUSTED = planVerifiedObjectMap(buildMustLedger(RUN7_REQUIREMENTS).entries, RUN7_SCHEME);

function objectById(sheet: BuildSheet, id: string): BuildSheetObject {
  const object = sheet.objects.find((item) => item.id === id);
  if (object === undefined) throw new Error(`missing BuildSheet object ${id}`);
  return object;
}

function flushMustIds(spec: BuildSpec): string[] {
  return spec.musts.filter((must) => isFlushMustText(must.text)).map((must) => must.id);
}

/** 构造带 linkScope 的 BuildSpec；schema 现在直接接受该字段。 */
function withDetails(
  base: BuildSpec,
  details: readonly Record<string, unknown>[],
  musts?: BuildSpec['musts'],
): BuildSpec {
  return BuildSpec.parse({ ...base, details, ...(musts === undefined ? {} : { musts }) });
}

function detail(
  id: string,
  elementIds: readonly string[],
  requirementIds: readonly string[],
  linkScope?: 'verified' | 'declared',
): Record<string, unknown> {
  return {
    id,
    name: id,
    where: '北侧',
    elementIds,
    count: null,
    description: `${id} 细部。`,
    priority: 'should',
    requirementIds,
    ...(linkScope === undefined ? {} : { linkScope }),
  };
}

test('details 的 linkScope 不可写：未品牌 map 被忽略，details 只声明', () => {
  const fixture = buildFixture('H1', 'good');
  const spec = withDetails(
    fixture.spec,
    [
      detail('door-verified', ['op-h1-door'], ['must-no-step'], 'verified'),
      detail('door-declared', ['op-h1-door'], ['must-declared-projected'], 'declared'),
      detail('door-declared-heuristic', ['op-h1-door'], ['must-door-clear'], 'declared'),
      detail(
        'furniture-declared',
        ['furniture:table-main', 'material:oak', 'site:garden'],
        ['must-furniture'],
        'declared',
      ),
      detail('namespaced-verified', ['material:trim', 'site:yard'], ['must-namespaced']),
    ],
    [
      ...fixture.spec.musts,
      { id: 'must-declared-projected', text: '做法见详图。', source: 'detail' },
      { id: 'must-furniture', text: '东侧设一张长桌。', source: 'detail' },
      { id: 'must-namespaced', text: '以橡木收边。', source: 'detail' },
      { id: 'must-heuristic', text: '墙体坚固。', source: 'requirement' },
      { id: 'must-unlinked', text: '做法见详图。', source: 'requirement' },
    ],
  );

  // 伪造的 map 形状完全正确，但不是 planner 返回的那个对象，必须被忽略。
  const forged = { 'must-no-step': ['opening:op-h1-door'] };
  const sheet = buildBuildSheet(spec, forged);
  const byId = new Map(sheet.musts.map((must) => [must.id, must]));

  const verifiedNameOnly = byId.get('must-no-step');
  assert.ok(verifiedNameOnly !== undefined);
  assert.deepEqual(verifiedNameOnly.explicitObjectIds, []);
  assert.deepEqual(verifiedNameOnly.declaredObjectIds, ['opening:op-h1-door']);
  assert.equal(verifiedNameOnly.linkScope, 'declared');
  assert.equal(verifiedNameOnly.linkReason, 'declared-only');

  // declared 的投影链接只声明：objectIds 可包含该对象，但 explicitObjectIds 为空。
  const declaredProjected = byId.get('must-declared-projected');
  assert.ok(declaredProjected !== undefined);
  assert.deepEqual(declaredProjected.objectIds, ['opening:op-h1-door']);
  assert.deepEqual(declaredProjected.explicitObjectIds, []);
  assert.deepEqual(declaredProjected.declaredObjectIds, ['opening:op-h1-door']);
  assert.equal(declaredProjected.linkScope, 'declared');
  assert.equal(declaredProjected.linkReason, 'declared-only');
  assert.equal(sheet.unlinkedMustIds.includes('must-declared-projected'), false);

  const declaredHeuristic = byId.get('must-door-clear');
  assert.ok(declaredHeuristic !== undefined);
  assert.deepEqual(declaredHeuristic.explicitObjectIds, []);
  assert.deepEqual(declaredHeuristic.declaredObjectIds, ['opening:op-h1-door']);
  assert.equal(declaredHeuristic.linkScope, 'declared');

  // furniture/material/site 引用永远只算 declared，即使 detail 本身是 verified。
  const furniture = byId.get('must-furniture');
  assert.ok(furniture !== undefined);
  assert.deepEqual(furniture.objectIds, []);
  assert.deepEqual(furniture.explicitObjectIds, []);
  assert.deepEqual(furniture.declaredObjectIds, ['furniture:table-main', 'material:oak', 'site:garden']);
  assert.equal(furniture.linkScope, 'declared');

  const namespaced = byId.get('must-namespaced');
  assert.ok(namespaced !== undefined);
  assert.deepEqual(namespaced.explicitObjectIds, []);
  assert.deepEqual(namespaced.declaredObjectIds, ['material:trim', 'site:yard']);
  assert.equal(namespaced.linkScope, 'declared');

  const heuristic = byId.get('must-heuristic');
  assert.ok(heuristic !== undefined);
  assert.deepEqual(heuristic.explicitObjectIds, []);
  assert.deepEqual(heuristic.declaredObjectIds, []);
  assert.ok(heuristic.objectIds.length > 0, '关键词命中仍保留在 objectIds');
  assert.equal(heuristic.linkScope, 'none');
  assert.equal(heuristic.linkReason, 'heuristic-only');

  const unlinked = byId.get('must-unlinked');
  assert.ok(unlinked !== undefined);
  assert.deepEqual(unlinked.objectIds, []);
  assert.deepEqual(unlinked.declaredObjectIds, []);
  assert.equal(unlinked.linkScope, 'none');
  assert.equal(unlinked.linkReason, 'no-object-link');
  assert.deepEqual(sheet.unlinkedMustIds, ['must-unlinked']);

  assert.equal(sheet.mustLinkage.linked, 6);
  assert.equal(sheet.mustLinkage.unlinked, 1);
  assert.equal(sheet.mustLinkage.explicit, 5);
  assert.equal(sheet.mustLinkage.explicitLinks, 5);
  assert.equal(sheet.mustLinkage.verified, 0);
  assert.equal(sheet.mustLinkage.declared, 5);
  assert.equal(sheet.mustLinkage.heuristicOnly, 1);
  assert.equal(sheet.mustLinkage.noDeclaredLinks, 2);

  assert.deepEqual(buildVerifiedMustMapping(spec, forged).schemes, {});
  assert.match(sheet.markdown, /\(declared: declared-only\)/);
  assert.equal(sheet.markdown.includes('(verified)'), false);
});

test('verified 显式链接必须与 must 主题兼容：家具/材料/洞口不能借墙几何 met', () => {
  const fixture = buildFixture('H1', 'good');
  const door = fixture.spec.openings.find((opening) => opening.kind !== 'window');
  assert.ok(door !== undefined);
  const spec = withDetails(
    fixture.spec,
    [
      detail('furniture-to-door', [door.id], ['must-furniture'], 'verified'),
      detail('wall-to-door', [door.id], ['must-wall'], 'verified'),
      detail('material-to-door', [door.id], ['must-material'], 'verified'),
      detail('unclassified-to-door', [door.id], ['must-unclassified'], 'verified'),
    ],
    [
      ...fixture.spec.musts,
      { id: 'must-furniture', text: '主厅设一张长桌。', source: 'requirement' },
      { id: 'must-wall', text: '外墙完整。', source: 'requirement' },
      { id: 'must-material', text: '外墙为木材。', source: 'requirement' },
      { id: 'must-unclassified', text: '不加二层，也不做夹层。', source: 'requirement' },
    ],
  );
  const sheet = buildBuildSheet(spec);
  const byId = new Map(sheet.musts.map((must) => [must.id, must]));
  for (const id of ['must-furniture', 'must-wall', 'must-material', 'must-unclassified']) {
    const must = byId.get(id);
    assert.ok(must !== undefined);
    assert.deepEqual(must.explicitObjectIds, [], `${id} 不能进入 verified mapping`);
    assert.equal(must.linkScope, 'declared');
  }
});

test('8 个历史 promotion：linkScope verified 的 details 不能产生任何 verified/met', () => {
  const door = RUN9_SPEC.openings.find((opening) => opening.kind !== 'window');
  assert.ok(door !== undefined);
  const ids = [
    'req-no-steps',
    'constraint-con-entry-flush',
    'req-door-clear-1m',
    'req-no-outdoor-zone',
    'req-no-sign-ticket-frame',
    'req-entrance-from-north',
    'constraint-con-wall-1m',
    'constraint-con-door-clear-1m',
  ];
  const spec = withDetails(
    RUN9_SPEC,
    ids.map((mustId, index) => detail(`legacy-promotion-${String(index)}`, [door.id], [mustId], 'verified')),
  );
  const sheet = buildBuildSheet(spec);
  assert.equal(sheet.mustLinkage.verified, 0);
  assert.equal(sheet.mustLinkage.explicit, 8);
  assert.equal(sheet.mustLinkage.declared, 8);
  assert.deepEqual(buildVerifiedMustMapping(spec).schemes, {});
  for (const mustId of ids) {
    const must = sheet.musts.find((entry) => entry.id === mustId);
    assert.ok(must !== undefined);
    assert.deepEqual(must.explicitObjectIds, [], `${mustId} 不能 verified`);
    assert.equal(must.linkScope, 'declared');
  }
});

test('namespace fallback：能解析为投影对象的带前缀 id 按投影处理，只有未解析引用算 declared', () => {
  const fixture = buildFixture('H1', 'good');
  const wall = fixture.spec.elements.find((element) => element.kind === 'wall');
  assert.ok(wall !== undefined);
  const namespacedWallId = `furniture:${wall.id}`;
  const base: BuildSpec = {
    ...fixture.spec,
    elements: fixture.spec.elements.map((element) =>
      element.id === wall.id ? { ...element, id: namespacedWallId } : element,
    ),
  };
  const spec = withDetails(
    base,
    [detail('namespace-fallback', [namespacedWallId, 'material:missing'], ['must-namespace-fallback'])],
    [...fixture.spec.musts, { id: 'must-namespace-fallback', text: '做法见详图。', source: 'detail' }],
  );

  const must = buildBuildSheet(spec).musts.find((entry) => entry.id === 'must-namespace-fallback');
  assert.ok(must !== undefined);
  // wall 的 element id 字面上以 furniture: 开头，但 byElement 能解析成真实投影 wall:f1；
  // 同一 detail 还有无法投影的 material:missing，因此整条 detail 只能算 declared，不能只凭 wall 升 verified。
  assert.deepEqual(must.explicitObjectIds, []);
  assert.deepEqual(must.declaredObjectIds, ['wall:f1', 'material:missing']);
  assert.equal(must.linkScope, 'declared');
});

test('run-9：5 个投影对象与 checker 同一份 expectedObjects', () => {
  const sheet = buildBuildSheet(RUN9_SPEC);
  const projection = projectExpectedObjects(RUN9_SPEC);

  assert.equal(sheet.schemaVersion, 2);
  assert.equal(sheet.tool, 'build-sheet');
  assert.equal(sheet.schemeId, 'scheme-draft');
  assert.equal(sheet.schemeRevision, 2);
  assert.deepEqual(
    sheet.objects.map((object) => object.id),
    [...RUN9_IDS],
  );
  assert.equal(sheet.objects.length, 5);
  assert.deepEqual(sheet.expectedObjects, projection.objects);
  assert.deepEqual(
    sheet.objects.map((object) => object.bounds),
    projection.objects.map((object) => object.bounds),
  );

  assert.deepEqual(objectById(sheet, 'wall:f1').bounds, { min: [2, 1, 2], max: [12, 5, 10] });
  assert.deepEqual(objectById(sheet, 'slab:f1').bounds, { min: [2, 0, 2], max: [12, 1, 10] });

  const roof = objectById(sheet, 'roof');
  if (roof.kind !== 'roof') throw new Error('roof object expected');
  assert.deepEqual(roof.bounds, { min: [1, 5, 1], max: [13, 8, 11] });
  assert.equal(roof.form, 'gable');
  assert.equal(roof.pitchDegrees, 25);
  assert.equal(roof.eaveY, 5);
  assert.equal(roof.ridgeY, 7);
  assert.equal(roof.overhang, 1);

  const door = objectById(sheet, 'opening:op-entry-north');
  if (door.kind !== 'opening') throw new Error('door object expected');
  assert.deepEqual(door.bounds, { min: [3, 1, 2], max: [5, 3, 3] });
  assert.equal(door.subtype, 'door');
  assert.equal(door.width, 2);
  assert.equal(door.height, 2);
  assert.equal(door.sillY, 1);
  assert.equal(door.headY, 3);

  const window = objectById(sheet, 'opening:op-south-window');
  if (window.kind !== 'opening') throw new Error('window object expected');
  assert.deepEqual(window.bounds, { min: [5, 2, 9], max: [9, 4, 10] });
  assert.equal(window.subtype, 'window');
  assert.equal(window.width, 4);
  assert.equal(window.height, 2);
  assert.equal(window.sillY, 2);
  assert.equal(window.headY, 4);
});

test('run-9：材质按结构 / 楼地面 / 屋面 / 玻璃 / 空气解析，并带框材质', () => {
  const sheet = buildBuildSheet(RUN9_SPEC);

  const wall = objectById(sheet, 'wall:f1');
  // BuildSheet 必须投影墙段实际主材，而不是 structure.material；否则模型按 BuildSheet
  // 施工会与 check:material:wall 的期望口径冲突（Wave 9 发现的契约不一致）。
  assert.equal(wall.materialId, 'm-dark-wood');
  assert.equal(wall.materialBlock, 'dark_oak_planks');
  assert.equal(wall.materialRole, 'wall');

  const slab = objectById(sheet, 'slab:f1');
  assert.equal(slab.materialId, 'm-floor');
  assert.equal(slab.materialBlock, 'polished_andesite');
  assert.equal(slab.materialRole, 'floor');

  const roof = objectById(sheet, 'roof');
  assert.equal(roof.materialId, 'm-roof');
  assert.equal(roof.materialBlock, 'deepslate_tiles');

  const door = objectById(sheet, 'opening:op-entry-north');
  if (door.kind !== 'opening') throw new Error('door object expected');
  assert.equal(door.materialId, null);
  assert.equal(door.materialBlock, 'air');
  assert.equal(door.frameMaterialBlock, null);

  const window = objectById(sheet, 'opening:op-south-window');
  if (window.kind !== 'opening') throw new Error('window object expected');
  assert.equal(window.materialId, 'm-glass');
  assert.equal(window.materialBlock, 'glass');
  assert.equal(window.materialRole, 'glass');
  assert.equal(window.frameMaterialId, 'm-trim');
  assert.equal(window.frameMaterialBlock, 'stripped_spruce_log');

  assert.deepEqual(
    sheet.layers.materials.find((material) => material.id === 'm-floor'),
    { id: 'm-floor', name: '深色室内地面', block: 'polished_andesite', role: 'floor' },
  );
  assert.deepEqual(sheet.layers.priority, ['opening', 'structure', 'decoration']);
});

test('墙主材从墙段投影，不退回 structure.material（Wave 9 契约对齐）', () => {
  const wallElements = RUN9_SPEC.elements.filter((element) => element.kind === 'wall');
  const blocks = new Set(
    wallElements.map((element) => RUN9_SPEC.materials.find((material) => material.id === element.material)?.block),
  );
  assert.equal(blocks.size, 1);
  const [wallBlock] = [...blocks];
  const structureBlock = RUN9_SPEC.materials.find((material) => material.id === RUN9_SPEC.structure.material)?.block;
  assert.notEqual(wallBlock, structureBlock);
  const sheet = buildBuildSheet(RUN9_SPEC);
  const wall = sheet.objects.find((object) => object.kind === 'wall');
  assert.ok(wall !== undefined);
  assert.equal(wall.materialBlock, wallBlock);
  assert.equal(wall.materialId, wallElements[0]?.material);
  assert.notEqual(wall.materialId, RUN9_SPEC.structure.material);
});

test('墙主材按墙段面积取主材；少量异材质墙段不改写 union 主材', () => {
  const wallElements = RUN9_SPEC.elements.filter((element) => element.kind === 'wall');
  const smallest = [...wallElements].sort((a, b) => {
    const area = (element: (typeof wallElements)[number]): number =>
      (element.bounds.max[0] - element.bounds.min[0]) *
      (element.bounds.max[1] - element.bounds.min[1]) *
      (element.bounds.max[2] - element.bounds.min[2]);
    return area(a) - area(b);
  })[0];
  assert.ok(smallest !== undefined);
  const mixed = BuildSpec.parse({
    ...RUN9_SPEC,
    elements: RUN9_SPEC.elements.map((element) =>
      element.id === smallest.id ? { ...element, material: 'm-stone' } : element,
    ),
  });
  const wall = buildBuildSheet(mixed).objects.find((object) => object.kind === 'wall');
  assert.ok(wall !== undefined);
  assert.equal(wall.materialBlock, 'dark_oak_planks');
});

test('run-9：41 条 must 各出现一次，链接与未链接清单互补', () => {
  const sheet = buildBuildSheet(RUN9_SPEC);
  const ids = sheet.musts.map((must) => must.id);

  assert.deepEqual(
    ids,
    RUN9_SPEC.musts.map((must) => must.id),
  );
  assert.equal(ids.length, 41);
  assert.equal(new Set(ids).size, 41);
  for (const id of ids) assert.equal(ids.filter((candidate) => candidate === id).length, 1);

  const linked = new Set(sheet.musts.flatMap((must) => must.objectIds));
  const unlinked = new Set(sheet.unlinkedMustIds);
  assert.equal(unlinked.size, sheet.unlinkedMustIds.length);
  for (const must of sheet.musts) {
    assert.equal(unlinked.has(must.id), must.objectIds.length === 0);
    for (const objectId of must.objectIds) assert.ok(RUN9_IDS.includes(objectId as (typeof RUN9_IDS)[number]));
  }
  assert.ok(linked.has('roof'));
  assert.ok(linked.has('opening:op-entry-north'));
  assert.ok(linked.has('opening:op-south-window'));
  assert.ok(unlinked.has('req-seats-10'));
  assert.ok(unlinked.has('req-block-budget'));

  const roofMust = sheet.musts.find((must) => must.id === 'req-gable-tile-roof');
  assert.ok(roofMust?.objectIds.includes('roof'));
  const doorMust = sheet.musts.find((must) => must.id === 'req-door-north-west');
  assert.ok(doorMust?.objectIds.includes('opening:op-entry-north'));
  const windowMust = sheet.musts.find((must) => must.id === 'req-window-south-4m');
  assert.ok(windowMust?.objectIds.includes('opening:op-south-window'));
});

test('run-9：基准面用 Unified FloorDatum（slabTop/standing/grade/entry）', () => {
  const sheet = buildBuildSheet(RUN9_SPEC);
  assert.equal(Object.hasOwn(sheet.datum, 'floorY'), false);
  assert.equal(sheet.datum.slabTopY, 0);
  assert.equal(sheet.datum.standingY, 1);
  assert.equal(sheet.datum.gradeY, 1);
  assert.equal(sheet.datum.entryThresholdY, 1);
  assert.equal(sheet.datum.entryTransition, 'flush');
  assert.deepEqual(
    sheet.datum.doors.map(({ minY, maxY }) => [minY, maxY]),
    [[1, 2]],
  );
  assert.deepEqual(
    sheet.datum.windows.map(({ minY, maxY }) => [minY, maxY]),
    [[2, 3]],
  );
  assert.equal(sheet.datum.summary, '楼板顶 y0；站立面 y1；室外地面 y1；入口 flush；门 y1..2；窗 y2..3');
  assert.ok(sheet.markdown.includes('基准面：楼板顶 y0；站立面 y1；室外地面 y1；入口 flush；门 y1..2；窗 y2..3'));
});

test('run-9：场地顶面已齐平，不产生假 flush 冲突；must 链接明确标为启发式', () => {
  const sheet = buildBuildSheet(RUN9_SPEC);
  assert.equal(sheet.conflicts.length, 0);
  assert.equal(sheet.mustLinkage.linked, 25);
  assert.equal(sheet.mustLinkage.unlinked, 16);
  assert.equal(sheet.mustLinkage.declared, 0);
  assert.equal(sheet.mustLinkage.explicitLinks, 0);
  assert.equal(sheet.mustLinkage.heuristicOnly, 25);
  assert.equal(sheet.mustLinkage.heuristic, true);
  assert.match(sheet.mustLinkage.note, /must linked ≠ must verified/);
  assert.match(sheet.mustLinkage.note, /unverified/);
  assert.equal(sheet.musts.filter((must) => must.objectIds.length === 0).length, 16);
  assert.ok(sheet.unlinkedMustIds.includes('req-seats-10'));
  assert.equal(sheet.mustLinkage.explicit, 0);
});

test('run-9：details 为空时 verified mapping 无 scheme，所有 must 都没有显式链接', () => {
  assert.deepEqual(RUN9_SPEC.details, []);
  const sheet = buildBuildSheet(RUN9_SPEC);
  for (const must of sheet.musts) {
    assert.deepEqual(must.explicitObjectIds, []);
    assert.deepEqual(must.declaredObjectIds, []);
    assert.ok(must.explicitObjectIds.every((objectId) => must.objectIds.includes(objectId)));
  }
  assert.equal(sheet.mustLinkage.explicit, 0);
  assert.equal(sheet.mustLinkage.explicitLinks, 0);
  assert.equal(sheet.mustLinkage.declared, 0);
  assert.deepEqual(buildVerifiedMustMapping(RUN9_SPEC), {
    schemaVersion: 1,
    tool: 'verified-must-map',
    mapping: 'verified',
    schemeRevision: RUN9_SPEC.schemeRevision,
    schemes: {},
  });
});

test('planner 本体 map 才产生 verified mapping，并可写盘重放', async () => {
  const sheet = buildBuildSheet(RUN7_SPEC, RUN7_TRUSTED);
  assert.ok(sheet.mustLinkage.verified > 0);

  const mapping = buildVerifiedMustMapping(RUN7_SPEC, RUN7_TRUSTED);
  assert.deepEqual(Object.keys(mapping.schemes), [RUN7_SPEC.schemeId]);
  const schemeMapping = mapping.schemes[RUN7_SPEC.schemeId] ?? {};
  assert.ok(Object.keys(schemeMapping).length > 0);
  for (const objectIds of Object.values(schemeMapping)) assert.ok(objectIds.length > 0);

  const json = renderVerifiedMustMapJson(mapping);
  assert.ok(json.endsWith('\n'));
  assert.deepEqual(JSON.parse(json) as unknown, mapping);

  const dir = await mkdtemp(join(tmpdir(), 'pg-verified-must-map-'));
  try {
    const path = writeVerifiedMustMapArtifact(dir, mapping);
    assert.equal(path, join(dir, 'verified-must-map.json'));
    assert.equal(await readFile(path, 'utf8'), json);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')) as unknown, mapping);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('伪造 / 复制 / 跨 scheme 或 revision 的 verified map 一律视为空映射', () => {
  const forged = { [RUN7_SPEC.musts[0]!.id]: ['wall:f1'] };
  assert.equal(buildBuildSheet(RUN7_SPEC, forged).mustLinkage.verified, 0);
  assert.deepEqual(buildVerifiedMustMapping(RUN7_SPEC, forged).schemes, {});

  const copied = Object.fromEntries(
    Object.entries(RUN7_TRUSTED).map(([mustId, objectIds]) => [mustId, [...objectIds]]),
  );
  assert.equal(buildBuildSheet(RUN7_SPEC, copied).mustLinkage.verified, 0);
  assert.deepEqual(buildVerifiedMustMapping(RUN7_SPEC, copied).schemes, {});

  const otherScheme = BuildSpec.parse({ ...RUN7_SPEC, schemeId: 'scheme-other' });
  assert.equal(buildBuildSheet(otherScheme, RUN7_TRUSTED).mustLinkage.verified, 0);
  assert.deepEqual(buildVerifiedMustMapping(otherScheme, RUN7_TRUSTED).schemes, {});

  const otherRevision = BuildSpec.parse({ ...RUN7_SPEC, schemeRevision: RUN7_SPEC.schemeRevision + 1 });
  assert.equal(buildBuildSheet(otherRevision, RUN7_TRUSTED).mustLinkage.verified, 0);
  assert.deepEqual(buildVerifiedMustMapping(otherRevision, RUN7_TRUSTED).schemes, {});

  // 即使经过 loader adopt，mapping 也只能用于它绑定的 scheme + revision。
  const foreign = adoptVerifiedMustMapping({
    schemaVersion: 1,
    tool: 'verified-must-map',
    mapping: 'verified',
    schemeRevision: RUN7_SPEC.schemeRevision,
    schemes: { 'scheme-other': copied },
  });
  const foreignMap = foreign.schemes['scheme-other'];
  assert.ok(foreignMap !== undefined);
  assert.equal(buildBuildSheet(RUN7_SPEC, foreignMap).mustLinkage.verified, 0);

  const stale = adoptVerifiedMustMapping({
    schemaVersion: 1,
    tool: 'verified-must-map',
    mapping: 'verified',
    schemeRevision: RUN7_SPEC.schemeRevision + 1,
    schemes: { [RUN7_SPEC.schemeId]: copied },
  });
  const staleMap = stale.schemes[RUN7_SPEC.schemeId];
  assert.ok(staleMap !== undefined);
  assert.equal(buildBuildSheet(RUN7_SPEC, staleMap).mustLinkage.verified, 0);

  const current = adoptVerifiedMustMapping({
    ...stale,
    schemeRevision: RUN7_SPEC.schemeRevision,
  });
  const currentMap = current.schemes[RUN7_SPEC.schemeId];
  assert.ok(currentMap !== undefined);
  assert.ok(buildBuildSheet(RUN7_SPEC, currentMap).mustLinkage.verified > 0);
});

test('确定性：两次派生 JSON / markdown 逐字节一致，JSON 不含 markdown 正文', () => {
  const first = buildBuildSheet(RUN9_SPEC);
  const second = buildBuildSheet(RUN9_SPEC);
  assert.equal(renderBuildSheetJson(first), renderBuildSheetJson(second));
  assert.equal(renderBuildSheetMarkdown(first), renderBuildSheetMarkdown(second));
  assert.equal(first.markdown, second.markdown);

  const json = JSON.parse(renderBuildSheetJson(first)) as Record<string, unknown>;
  assert.equal(json['schemaVersion'], 2);
  assert.equal(json['tool'], 'build-sheet');
  assert.equal('markdown' in json, false);
});

test('markdown：包含对象 / must / 链接状态 / 材料 / 冲突 / 最终规则，且足够紧凑', () => {
  const sheet = buildBuildSheet(RUN9_SPEC);
  const markdown = renderBuildSheetMarkdown(sheet);

  for (const heading of [
    '# BuildSheet',
    '## 基准面',
    '## 施工调用卡',
    '## 期望对象',
    '## 材料 / 层次做法',
    '## Must 链接状态',
    '## Musts',
    '## 冲突',
    '## 规则',
  ]) {
    assert.ok(markdown.includes(heading), `missing markdown heading ${heading}`);
  }
  for (const id of RUN9_IDS) assert.ok(markdown.includes(id), `missing object ${id}`);
  for (const must of RUN9_SPEC.musts) assert.ok(markdown.includes(must.id), `missing must ${must.id}`);
  // W11-07：must 行必须带 text 全文，模型才能只凭 BuildSheet 核对语义。
  const firstMust = RUN9_SPEC.musts[0];
  assert.ok(firstMust !== undefined);
  assert.ok(markdown.includes(`；text: ${firstMust.text}`), 'missing must text');
  assert.match(markdown, /must linked ≠ must verified：25\/41 有对象或声明链接，16 未链接/);
  assert.match(markdown, /未链接 must 保持 unverified/);
  assert.match(markdown, /machine truth/);
  assert.match(markdown, /design\.md/);
  assert.match(markdown, /never silently chosen/);
  // 13,275：新增 must 全文（41 条、1,189 字符）后的实测值；原 13k 上限无法覆盖合同文本。
  assert.ok(markdown.length < 14_000, `markdown too long: ${String(markdown.length)}`);
});

test('H1–H4 good：同样 5 个对象，且不产生假齐平冲突', () => {
  for (const house of ['H1', 'H2', 'H3', 'H4'] as const) {
    const fixture = buildFixture(house, 'good');
    const sheet = buildBuildSheet(fixture.spec);
    const projection = projectExpectedObjects(fixture.spec);

    assert.equal(sheet.objects.length, 5);
    assert.deepEqual(
      sheet.objects.map((object) => object.id),
      projection.objects.map((object) => object.id),
    );
    assert.equal(sheet.expectedObjects.length, 5);
    assert.equal(sheet.musts.length, fixture.spec.musts.length);
    assert.equal(sheet.conflicts.length, 0, `${house} 不应产生 flush 冲突`);
  }
});

test('齐平冲突只在场地顶面低于站立面且 must 要求齐平时出现；多层取 max', () => {
  const fixture = buildFixture('H1', 'good');
  const elevation = fixture.spec.levels[0]?.elevation;
  assert.equal(elevation, 1);

  // 单层场地顶面 y0，低于站立面 y1：真实 gap，应报冲突。
  const gap = BuildSpec.parse({
    ...fixture.spec,
    siteBounds: {
      min: [fixture.spec.siteBounds.min[0], -1, fixture.spec.siteBounds.min[2]],
      max: [fixture.spec.siteBounds.max[0], 0, fixture.spec.siteBounds.max[2]],
    },
  });
  const gapSheet = buildBuildSheet(gap);
  assert.equal(gapSheet.conflicts.length, 1);
  const conflict = gapSheet.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.id, 'conflict-flush-entry');
  assert.deepEqual(conflict.mustIds, flushMustIds(gap));
  assert.match(conflict.actual, /室外地面 y0/);
  assert.equal(conflict.resolution, '将场地/基座抬至 y1；否则由用户明确选择接受高差或豁免 must，不得静默接受。');
  const conflictMarkdown = renderBuildSheetMarkdown(gapSheet);
  assert.match(conflictMarkdown, /options: raise-site=抬高场地\/基座到楼面标高/);
  assert.match(conflictMarkdown, /accept-step=明确接受现状一格高差/);
  assert.match(conflictMarkdown, /waive=明确豁免无台阶 \/ 齐平 must/);

  // 多层场地顶面取 max=y1：已齐平，不报。
  const multi = BuildSpec.parse({
    ...fixture.spec,
    siteBounds: {
      min: [fixture.spec.siteBounds.min[0], -3, fixture.spec.siteBounds.min[2]],
      max: [fixture.spec.siteBounds.max[0], 1, fixture.spec.siteBounds.max[2]],
    },
  });
  assert.equal(buildBuildSheet(multi).conflicts.length, 0);

  const noFlush = BuildSpec.parse({
    ...fixture.spec,
    musts: fixture.spec.musts.filter((must) => !isFlushMustText(must.text)),
  });
  assert.equal(buildBuildSheet(noFlush).conflicts.length, 0);
});

test('writeBuildSheetArtifacts 写入 build-sheet.json / build-sheet.md，内容可重放', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pg-build-sheet-'));
  try {
    const sheet = buildBuildSheet(RUN9_SPEC);
    const paths = writeBuildSheetArtifacts(dir, sheet);
    assert.equal(paths.jsonPath, join(dir, 'build-sheet.json'));
    assert.equal(paths.markdownPath, join(dir, 'build-sheet.md'));
    assert.equal(await readFile(paths.jsonPath, 'utf8'), renderBuildSheetJson(sheet));
    assert.equal(await readFile(paths.markdownPath, 'utf8'), renderBuildSheetMarkdown(sheet));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
