import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileBuildSpec } from './brief.ts';
import { expandDesignIntent } from './design-expand.ts';
import type { DesignHostContext } from './design-intent.ts';
import { exampleIntent } from './example-intent.ts';
import { exampleScheme } from './example.ts';
import { createIntentHost } from './generate-intent.ts';
import { buildMustLedger, MustLedgerEntry } from './must-ledger.ts';
import type { MustObjectLink } from './must-links.ts';
import { isPlannerVerifiedObjectMap, planMustObjectLinks, planVerifiedObjectMap } from './must-links.ts';
import type { RequirementGraph } from './requirements.ts';
import { DesignScheme } from './scheme.ts';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

const requirements = fixture('run7-requirements.json') as RequirementGraph;
const rawScheme = fixture('run7-rev2-scheme.json');
const scheme = DesignScheme.parse(rawScheme);
const ledger = buildMustLedger(requirements);
const plan = planMustObjectLinks(ledger.entries, scheme);

function exampleHost(): DesignHostContext {
  return {
    schemeId: 'scheme-example',
    revision: 1,
    status: 'draft',
    sourceRequirements: { graphId: 'req-graph', revision: 1 },
    maxBlocks: 20_000,
    requirementIds: [],
  };
}

function linkOf(mustId: string): MustObjectLink {
  const found = plan.coverage.entries.find((link) => link.mustId === mustId);
  assert.ok(found, `缺少 must ${mustId}`);
  return found;
}

function detailOf(mustId: string): (typeof plan.details)[number] | undefined {
  return plan.details.find((detail) => detail.requirementIds.includes(mustId));
}

test('run-7 rev2：41 条 must 全部入计划，覆盖率与原因分布精确', () => {
  assert.equal(ledger.entries.length, 41);
  assert.deepEqual(
    {
      total: plan.coverage.total,
      explicit: plan.coverage.explicit,
      verified: plan.coverage.verified,
      declaredOnly: plan.coverage.declaredOnly,
      unlinked: plan.coverage.unlinked,
    },
    { total: 41, explicit: 19, verified: 19, declaredOnly: 0, unlinked: 22 },
  );
  assert.equal(plan.details.length, 19);
  assert.equal(plan.coverage.entries.length, 41);
  assert.equal(new Set(plan.details.map((detail) => detail.id)).size, 19);
  assert.deepEqual(
    plan.coverage.entries.map((link) => link.mustId),
    ledger.entries.map((entry) => entry.id),
  );

  const reasons: Record<string, number> = {};
  for (const link of plan.coverage.entries) {
    const key = `${link.scope}:${link.reason ?? 'verified'}`;
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  assert.deepEqual(reasons, {
    'verified:verified': 19,
    'none:not-in-allowlist': 14,
    'none:negative-or-prohibitive': 6,
    'none:qualitative-not-object-verifiable': 2,
  });
});

test('run-7 rev2：verified 只包含墙 / 洞口 / 家具 / 材料 / 层数等可测覆盖', () => {
  const verified = plan.coverage.entries.filter((link) => link.scope === 'verified').map((link) => link.mustId);
  assert.equal(verified.length, 19);
  for (const mustId of [
    'req-outer-10x8',
    'req-single-storey',
    'req-interior-8x6',
    'req-wall-thick-1m',
    'req-door-north-west',
    'req-window-dim',
    'req-long-table',
    'req-bench-north',
    'req-bench-south',
    'req-seats-10',
    'req-counter',
    'req-block-budget',
    'constraint-con-outer-10x8',
    'constraint-con-single-storey',
    'constraint-con-interior-clear',
    'constraint-con-wall-1m',
    'constraint-con-door-2m',
    'constraint-con-window-south',
    'constraint-con-block-budget',
  ]) {
    assert.ok(verified.includes(mustId), `${mustId} 应为 verified`);
  }
  for (const link of plan.coverage.entries.filter((item) => item.scope === 'verified')) {
    assert.ok(link.verifiedRefs.length > 0);
    assert.equal(link.reason, null);
    const detail = detailOf(link.mustId);
    assert.ok(detail !== undefined);
    assert.equal(detail.linkScope, 'verified');
    assert.deepEqual(detail.elementIds, link.objectRefs);
  }

  const windowDim = linkOf('req-window-dim');
  assert.equal(windowDim.subject, 'opening');
  assert.equal(windowDim.scope, 'verified');
  assert.deepEqual(windowDim.objectRefs, ['op-south-window']);
  assert.deepEqual(windowDim.verifiedRefs, ['opening:op-south-window', 'check:schedule:south']);

  const eave = linkOf('req-eave-only');
  assert.equal(eave.scope, 'none');
  assert.equal(eave.reason, 'not-in-allowlist');
});

test('复合洞口 must 由洞口几何 + schedule / 位置检查共同验证', () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['req-door-north-west', ['opening:op-entry-north', 'check:schedule:north', 'check:door-position:op-entry-north']],
    ['constraint-con-window-south', ['opening:op-south-window', 'check:schedule:south']],
  ];
  for (const [mustId, verifiedRefs] of cases) {
    const link = linkOf(mustId);
    assert.equal(link.scope, 'verified', mustId);
    assert.equal(link.subject, 'opening', mustId);
    for (const ref of verifiedRefs) assert.ok(link.verifiedRefs.includes(ref), `${mustId} missing ${ref}`);
    assert.equal(link.reason, null, mustId);
    assert.equal(detailOf(mustId)?.linkScope, 'verified', mustId);
  }
});

test('run-7 rev2：无 allowlist 命中的 must 一律 none，不产生 details', () => {
  assert.equal(plan.coverage.declaredOnly, 0);
  for (const mustId of ['req-stone-base', 'req-gable-tile-roof', 'req-no-partitions', 'req-wood-wall-column']) {
    const link = linkOf(mustId);
    assert.equal(link.scope, 'none', mustId);
    assert.ok(link.reason !== null && link.reason.trim() !== '', mustId);
    assert.equal(detailOf(mustId), undefined, mustId);
  }
});

test('run-7 rev2：详情通过方案校验，旧方案 0 details 仍可解析', () => {
  const parsed = DesignScheme.safeParse({ ...scheme, details: plan.details });
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  for (const detail of plan.details) {
    assert.ok(detail.id.length <= 64);
    assert.equal(detail.priority, 'should');
    assert.equal(detail.count, null);
    assert.equal(detail.requirementIds.length, 1);
    assert.ok(detail.elementIds.length > 0);
    assert.ok(detail.linkScope === 'verified' || detail.linkScope === 'declared');
    assert.equal(detail.where, 'must→object');
  }
  assert.equal(scheme.details.length, 0);
  assert.equal(DesignScheme.safeParse(rawScheme).success, true);
});

test('命名空间引用只接受真实家具 / 材料 / 场地区域', () => {
  const base = exampleScheme();
  const detail = {
    ...base.details[0]!,
    id: 'd-namespaced',
    elementIds: ['furniture:fu-table', 'material:m-wood', 'site:z-terrace'],
  };
  assert.equal(DesignScheme.safeParse({ ...base, details: [detail] }).success, true);

  // 旧方案可能真的有以 furniture: 开头的 element / opening id；精确 id 必须优先于命名空间。
  const legacyElement = { ...base.elements[0]!, id: 'furniture:legacy', name: '旧方案冒号 id 元素' };
  const legacyDetail = { ...detail, id: 'd-legacy-colon', elementIds: ['furniture:legacy'] };
  assert.equal(
    DesignScheme.safeParse({
      ...base,
      elements: [...base.elements, legacyElement],
      details: [legacyDetail],
    }).success,
    true,
  );

  for (const [reference, pattern] of [
    ['furniture:missing', /不存在的 furniture/],
    ['material:missing', /不存在的 material/],
    ['site:missing', /不存在的 site/],
  ] as const) {
    const result = DesignScheme.safeParse({ ...base, details: [{ ...detail, elementIds: [reference] }] });
    assert.equal(result.success, false);
    assert.match(result.error.issues.map((issue) => issue.message).join('；'), pattern);
  }
});

test('链接计划逐字节确定，长 must id 的 detail id 稳定截断到 64', () => {
  assert.equal(JSON.stringify(planMustObjectLinks(ledger.entries, scheme)), JSON.stringify(plan));

  const longId = `req-${'x'.repeat(60)}`;
  const entry = MustLedgerEntry.parse({
    id: longId,
    sourceId: longId,
    text: '南墙窗洞宽 4m，窗高 2m。',
    source: 'requirement',
    kind: 'dimension',
    check: 'opening',
    targets: [],
    value: null,
    status: 'unverified',
    evidence: [],
  });
  const single = planMustObjectLinks([entry], scheme);
  assert.equal(single.details.length, 1);
  const detail = single.details[0];
  assert.ok(detail !== undefined);
  assert.equal(detail.id.length, 64);
  assert.match(detail.id, /-[0-9a-f]{8}$/);
  assert.equal(planMustObjectLinks([entry], scheme).details[0]?.id, detail.id);
});

test('verified map provenance：只有 planner 本体且 scheme / revision 匹配才可信', () => {
  const plannerMap = planVerifiedObjectMap(ledger.entries, scheme);
  assert.equal(isPlannerVerifiedObjectMap(plannerMap, scheme.meta.id, scheme.meta.revision), true);

  const copied = Object.fromEntries(Object.entries(plannerMap).map(([mustId, objectIds]) => [mustId, [...objectIds]]));
  assert.equal(isPlannerVerifiedObjectMap(copied, scheme.meta.id, scheme.meta.revision), false);
  assert.equal(isPlannerVerifiedObjectMap({ ...plannerMap }, scheme.meta.id, scheme.meta.revision), false);
  assert.equal(isPlannerVerifiedObjectMap(plannerMap, scheme.meta.id, scheme.meta.revision + 1), false);
  assert.equal(isPlannerVerifiedObjectMap(plannerMap, 'scheme-other', scheme.meta.revision), false);
  assert.equal(isPlannerVerifiedObjectMap(null, scheme.meta.id, scheme.meta.revision), false);
  assert.equal(isPlannerVerifiedObjectMap([], scheme.meta.id, scheme.meta.revision), false);
});

test('命名空间引用超过 64 字符时过滤；仅剩超长引用则 none 且不生成 details', () => {
  const longMaterialId = `m-${'s'.repeat(62)}`;
  assert.equal(longMaterialId.length, 64);
  const clone = structuredClone(rawScheme) as {
    materials: { id: string }[];
    facades: { baseMaterialId: string }[];
  };
  const stone = clone.materials.find((material) => material.id === 'm-stone');
  assert.ok(stone !== undefined);
  stone.id = longMaterialId;
  for (const facade of clone.facades) {
    if (facade.baseMaterialId === 'm-stone') facade.baseMaterialId = longMaterialId;
  }
  const longRefScheme = DesignScheme.parse(clone);

  const entry = MustLedgerEntry.parse({
    id: 'req-long-material',
    sourceId: 'req-long-material',
    text: '石基座按设计。',
    source: 'requirement',
    kind: 'aesthetic',
    check: 'material',
    targets: [],
    value: null,
    status: 'unverified',
    evidence: [],
  });
  const result = planMustObjectLinks([entry], longRefScheme);
  assert.equal(result.details.length, 0);
  assert.equal(result.coverage.entries.length, 1);
  const link = result.coverage.entries[0];
  assert.ok(link !== undefined);
  assert.equal(link.scope, 'none');
  assert.equal(link.reason, 'not-in-allowlist');
  assert.deepEqual(link.objectRefs, []);
});

test('对象引用超过 50 条时不截断冒充 verified，整条链接降为 none', () => {
  const clone = structuredClone(rawScheme) as {
    materials: { id: string; name: string; block: string; role: string; color: null; notes: null }[];
  };
  for (let index = 0; index < 51; index += 1) {
    clone.materials.push({
      id: `m-extra-${String(index)}`,
      name: `木${String(index)}`,
      block: 'oak_planks',
      role: 'wall',
      color: null,
      notes: null,
    });
  }
  const manyMaterials = DesignScheme.parse(clone);
  const entry = MustLedgerEntry.parse({
    id: 'req-many-wood',
    sourceId: 'req-many-wood',
    text: '石材与木材按设计。',
    source: 'requirement',
    kind: 'aesthetic',
    check: 'material',
    targets: [],
    value: null,
    status: 'unverified',
    evidence: [],
  });
  const result = planMustObjectLinks([entry], manyMaterials);
  assert.equal(result.details.length, 0);
  const link = result.coverage.entries[0];
  assert.ok(link !== undefined);
  assert.equal(link.scope, 'none');
  assert.equal(link.reason, 'not-in-allowlist');
  assert.deepEqual(link.objectRefs, []);
});

test('否定 / 预算 / 纯功能 / 场地语境不产生 details，原因稳定', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['req-no-outdoor-zone', 'negative-or-prohibitive'],
    ['req-no-sign-ticket-frame', 'negative-or-prohibitive'],
    ['req-teahouse-program', 'not-in-allowlist'],
    ['req-single-hall', 'not-in-allowlist'],
    ['req-site-stream-south', 'not-in-allowlist'],
    ['req-site-road-north', 'not-in-allowlist'],
  ];
  for (const [mustId, reason] of cases) {
    const link = linkOf(mustId);
    assert.equal(link.scope, 'none', mustId);
    assert.equal(link.subject, 'none', mustId);
    assert.equal(link.reason, reason, mustId);
    assert.deepEqual(link.objectRefs, []);
    assert.deepEqual(link.verifiedRefs, []);
    assert.equal(detailOf(mustId), undefined, mustId);
  }
});

test('复合 must：allowlist 命中才 verified，其余一律 none', () => {
  for (const mustId of ['req-door-clear-1m', 'req-no-steps', 'req-entrance-from-north', 'req-view-frame']) {
    const link = linkOf(mustId);
    assert.equal(link.scope, 'none', mustId);
    assert.deepEqual(link.verifiedRefs, [], mustId);
    assert.ok(link.reason !== null, mustId);
  }

  for (const mustId of [
    'req-wall-thick-1m',
    'req-interior-8x6',
    'req-single-storey',
    'req-block-budget',
    'constraint-con-block-budget',
  ]) {
    const link = linkOf(mustId);
    assert.equal(link.scope, 'verified', mustId);
    assert.equal(link.reason, null, mustId);
    assert.ok(
      link.verifiedRefs.some((ref) => ref.startsWith('check:')),
      mustId,
    );
  }

  for (const mustId of [
    'req-gable-tile-roof',
    'req-no-mezzanine',
    'req-no-partitions',
    'req-no-glass-door',
    'req-counter-no-service',
  ]) {
    assert.equal(linkOf(mustId).scope, 'none', mustId);
  }
});

test('结构守卫：预算 / 座 / 负向 / 复合柱门 / 未列形容词都不能 verified', () => {
  const cases: readonly (readonly [string, string, string, string])[] = [
    ['req-stone-budget', '石基座用 2000 方块。', 'aesthetic', 'material'],
    ['req-teahouse-seat', '茶亭提供 10 座饮茶空间。', 'function', 'geometry'],
    ['req-neg-table', '不要长桌 4m。', 'function', 'furniture'],
    ['req-neg-bench', '室内不放长凳 4m。', 'function', 'furniture'],
    ['req-column-door', '木柱高 2m，入口开门 2m。', 'function', 'opening'],
    ['req-table-adjective', '长桌 4m 长、2m 宽，造型优雅。', 'function', 'furniture'],
    ['req-window-adjective', '南窗 4m 宽，造型优雅。', 'space', 'opening'],
  ];
  const entries = cases.map(([id, text, kind, check]) =>
    MustLedgerEntry.parse({
      id,
      sourceId: id,
      text,
      source: 'requirement',
      kind,
      check,
      targets: [],
      value: null,
      status: 'unverified',
      evidence: [],
    }),
  );
  const links = planMustObjectLinks(entries, scheme).coverage.entries;
  for (const link of links) {
    assert.notEqual(link.scope, 'verified', link.mustId);
  }
});

test('定性 / 性能 / 观感 must 即使提到屋面或外墙也不能 verified', () => {
  const phrases = [
    '屋面排水良好，雨后不积水',
    '外墙外观整洁',
    '采光良好',
    '耐久',
    '屋面不漏水',
    '室内照明良好',
    '屋面防水',
    '屋面排水',
    '屋面防渗',
    '屋面隔热',
  ] as const;
  const entries = phrases.map((text, index) =>
    MustLedgerEntry.parse({
      id: `req-qualitative-${String(index)}`,
      sourceId: `req-qualitative-${String(index)}`,
      text,
      source: 'requirement',
      kind: 'aesthetic',
      check: 'geometry',
      targets: [],
      value: null,
      status: 'unverified',
      evidence: [],
    }),
  );
  const result = planMustObjectLinks(entries, scheme);
  for (const link of result.coverage.entries) {
    assert.notEqual(link.scope, 'verified', link.mustId);
    assert.ok(link.reason !== null && link.reason.trim() !== '', `${link.mustId} 必须给出非空 reason`);
    assert.equal(link.reason, 'qualitative-not-object-verifiable', link.mustId);
    assert.deepEqual(link.verifiedRefs, [], link.mustId);
  }
  assert.equal(result.coverage.verified, 0);

  // 灯具是具体对象，不能仅凭“灯”字被定性预检吞掉；但仍不是 verified。
  const fixtureEntry = MustLedgerEntry.parse({
    id: 'req-light-fixture',
    sourceId: 'req-light-fixture',
    text: '北墙设壁灯。',
    source: 'requirement',
    kind: 'function',
    check: 'geometry',
    targets: [],
    value: null,
    status: 'unverified',
    evidence: [],
  });
  const fixtureLink = planMustObjectLinks([fixtureEntry], scheme).coverage.entries[0];
  assert.ok(fixtureLink !== undefined);
  assert.notEqual(fixtureLink.scope, 'verified');
  assert.notEqual(fixtureLink.reason, 'qualitative-not-object-verifiable');

  // 纯几何仍然可以 verified，定性预检不能误伤普通几何条款。
  const pureGeometry = MustLedgerEntry.parse({
    id: 'req-pure-window-geometry',
    sourceId: 'req-pure-window-geometry',
    text: '南墙窗洞宽 4m，窗台高 1m。',
    source: 'requirement',
    kind: 'dimension',
    check: 'opening',
    targets: [],
    value: null,
    status: 'unverified',
    evidence: [],
  });
  const pure = planMustObjectLinks([pureGeometry], scheme).coverage.entries[0];
  assert.ok(pure !== undefined);
  assert.equal(pure.scope, 'verified');
  assert.ok(
    pure.verifiedRefs.includes('op-south-window') || pure.verifiedRefs.includes('opening:op-south-window'),
    JSON.stringify(pure.verifiedRefs),
  );
});

test('设计路径：未提供 mustEntries 时 details 为空、mustLinks 为空并双告警', () => {
  const resolved = expandDesignIntent(exampleIntent(), exampleHost());
  assert.deepEqual(resolved.scheme.details, []);
  assert.deepEqual(resolved.facts.mustLinks, {
    total: 0,
    explicit: 0,
    verified: 0,
    declaredOnly: 0,
    unlinked: 0,
    entries: [],
  });
  const codes = resolved.warnings.map((warning) => warning.code);
  assert.ok(codes.includes('details-not-derived'));
  assert.ok(codes.includes('must-links-unavailable'));
});

test('设计路径：宿主注入 mustEntries 后 details 由真实对象链接派生', () => {
  const entry = MustLedgerEntry.parse({
    id: 'req-north-entry',
    sourceId: 'req-north-entry',
    text: '北墙入口门洞净宽 2m。',
    source: 'requirement',
    kind: 'dimension',
    check: 'opening',
    targets: [],
    value: null,
    status: 'unverified',
    evidence: [],
  });
  const resolved = expandDesignIntent(exampleIntent(), { ...exampleHost(), mustEntries: [entry] });
  assert.equal(resolved.scheme.details.length, 1);
  const detail = resolved.scheme.details[0];
  assert.ok(detail !== undefined);
  assert.equal(detail.linkScope, 'verified');
  assert.deepEqual(detail.elementIds, ['op-entry']);
  assert.deepEqual(detail.requirementIds, ['req-north-entry']);
  assert.equal(resolved.facts.mustLinks.total, 1);
  assert.equal(resolved.facts.mustLinks.verified, 1);
  assert.equal(
    resolved.warnings.some((warning) => warning.code === 'must-links-unavailable'),
    false,
  );
});

test('run-7 rev2 intent 经 createIntentHost 复现 41 must / 19 条显式链接', (t) => {
  const intentPath = new URL('../fixtures/run7-rev2-intent.json', import.meta.url);
  if (!existsSync(intentPath)) {
    t.skip('run7-rev2-intent.json 尚未提供');
    return;
  }
  const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as unknown;
  const resolved = expandDesignIntent(intent, createIntentHost(requirements, { revision: 2, status: 'confirmed' }));
  assert.equal(resolved.scheme.meta.revision, 2);
  assert.equal(resolved.scheme.details.length, 19);
  assert.equal(resolved.facts.mustLinks.total, 41);
  assert.equal(resolved.facts.mustLinks.explicit, 19);
  assert.equal(resolved.facts.mustLinks.verified, 19);
  assert.equal(resolved.facts.mustLinks.declaredOnly, 0);
  assert.equal(resolved.facts.mustLinks.unlinked, 22);

  const spec = compileBuildSpec(resolved.scheme, requirements);
  assert.equal(spec.musts.length, 41);
  assert.equal(spec.details.length, 19);
  assert.deepEqual(
    spec.details.map((detail) => detail.linkScope),
    resolved.scheme.details.map((detail) => detail.linkScope),
  );
  assert.ok(spec.details.some((detail) => detail.linkScope === 'verified'));
  assert.equal(
    spec.details.some((detail) => detail.linkScope === 'declared'),
    false,
  );
});
