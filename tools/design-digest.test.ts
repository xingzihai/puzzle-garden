/**
 * design digest 的离线契约测试（W11-09）。
 *
 * 负责：三份真实 design.md + 一份报告体 design.md 的 must 全文覆盖、关键尺寸、确定性、token 上限；
 *   并验证 must 只从 BuildSpec 读取、超预算时先压缩叙述。
 * 不负责：跑 live / 调用模型 / 读 .env 或 sealed 题；只读固定 fixture 与本地 tokenizer。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { boundsSize, BuildSpec } from '@pg/interaction/schema';

import { buildDesignDigest } from './design-digest.ts';
import { loadTokenCounter } from './tokens.ts';

const MAX_DIGEST_TOKENS = 4_000;

interface Fixture {
  readonly name: string;
  readonly design: string;
  readonly spec: BuildSpec;
}

function readFixture(name: string, designPath: string, specPath: string): Fixture {
  const design = readFileSync(new URL(designPath, import.meta.url), 'utf8');
  const spec = BuildSpec.parse(JSON.parse(readFileSync(new URL(specPath, import.meta.url), 'utf8')) as unknown);
  return { name, design, spec };
}

const FIXTURES: readonly Fixture[] = [
  readFixture(
    'run9 茶亭',
    './fixtures/design-conformance-run9/session/design.md',
    './fixtures/design-conformance-run9/session/build-spec.json',
  ),
  readFixture(
    '稻田茶亭（固定授权示例）',
    './fixtures/design-digest/rice-tea/design.md',
    './fixtures/design-digest/rice-tea/build-spec.json',
  ),
  readFixture(
    '稻田茶亭（mock 旧版）',
    './fixtures/design-digest/mock-tea/design.md',
    './fixtures/design-digest/mock-tea/build-spec.json',
  ),
];

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function spanOf(bounds: BuildSpec['bounds']): string {
  const [x, y, z] = boundsSize(bounds);
  return `${String(x)}×${String(y)}×${String(z)}`;
}

function benchSeats(spec: BuildSpec): number {
  let total = 0;
  for (const interior of spec.interiors) {
    for (const item of interior.furnitureSpecs) {
      if (item.kind !== 'bench') continue;
      const [minX, , minZ] = item.bounds.min;
      const [maxX, , maxZ] = item.bounds.max;
      total += Math.max(0, Math.floor((Math.max(maxX - minX, maxZ - minZ) * 10) / 8));
    }
  }
  return total;
}

for (const fixture of FIXTURES) {
  test(`${fixture.name}：must 全文、关键尺寸、确定性与 token ≤4000`, () => {
    const count = loadTokenCounter().count;
    const digest = buildDesignDigest(fixture.design, fixture.spec);

    assert.ok(digest.startsWith('# 设计摘要'), 'digest 应有稳定标题');
    assert.ok(digest.includes(`## 9. Must 全文（${String(fixture.spec.musts.length)}）`));
    for (const must of fixture.spec.musts) {
      assert.ok(digest.includes(must.id), `缺少 must id ${must.id}`);
      assert.ok(digest.includes(normalize(must.text)), `缺少 must 全文 ${must.id}`);
    }

    assert.ok(digest.includes(spanOf(fixture.spec.bounds)), '缺少建筑包络尺寸');
    assert.ok(digest.includes(`${String(fixture.spec.roof.pitchDegrees)}°`), '缺少屋面坡度');
    assert.ok(
      digest.includes(
        `檐口 ${String(fixture.spec.roof.eaveHeight)} / 屋脊 ${String(fixture.spec.roof.ridgeHeight)} / 挑檐 ${String(fixture.spec.roof.overhang)}`,
      ),
      '缺少檐口 / 屋脊 / 挑檐',
    );

    const furniture = fixture.spec.interiors.flatMap((interior) => interior.furnitureSpecs);
    assert.ok(digest.includes(`共 ${String(furniture.length)} 件`), '缺少家具总数');
    for (const item of furniture) assert.ok(digest.includes(item.name), `缺少家具 ${item.name}`);
    const seats = benchSeats(fixture.spec);
    if (seats > 0) assert.ok(digest.includes(`长凳 ${String(seats)} 座`), '缺少长凳座位数');

    assert.equal(buildDesignDigest(fixture.design, fixture.spec), digest, '同输入必须同输出');
    const tokens = count(digest);
    assert.ok(tokens <= MAX_DIGEST_TOKENS, `digest ${String(tokens)} > ${String(MAX_DIGEST_TOKENS)}`);
  });
}

test('reference 模式：must 只留计数 / BuildSheet 引用，不重复全文', () => {
  const run9 = FIXTURES[0];
  assert.ok(run9 !== undefined);
  const digest = buildDesignDigest(run9.design, run9.spec, { musts: 'reference' });
  assert.ok(digest.includes(`## 9. Must 摘要（${String(run9.spec.musts.length)}）`));
  assert.ok(digest.includes('BuildSheet 的「Musts」段'));
  for (const must of run9.spec.musts) {
    assert.ok(!digest.includes(must.text), `reference 模式不应重复 must 全文 ${must.id}`);
    assert.ok(!digest.includes(must.id), `reference 模式不再罗列 must id：${must.id}`);
  }
  assert.ok(digest.length < buildDesignDigest(run9.design, run9.spec).length, 'reference 模式应明显更短');
});

test('must 只从 BuildSpec 读取：design.md 的必须项段可缺失 / 可变化', () => {
  const run9 = FIXTURES[0];
  assert.ok(run9 !== undefined);
  const mutated = run9.design
    .replace(/^# .+$/mu, '# 被改掉的标题')
    .replace(
      /## 必须项与自由范围[\s\S]*?(?=## 未决问题)/u,
      '## 必须项与自由范围\n\n- [fake-must] 这条不应进入 digest。\n\n',
    );
  const digest = buildDesignDigest(mutated, run9.spec);
  assert.ok(digest.includes(run9.spec.title), '标题应来自 BuildSpec');
  assert.ok(!digest.includes('# 被改掉的标题'), '不应把 design.md 标题当合同标题');
  assert.ok(!digest.includes('fake-must'), '不应采信 design.md 的 must 段');
  for (const must of run9.spec.musts) assert.ok(digest.includes(normalize(must.text)), `缺 must ${must.id}`);
});

test('报告体 design.md（docs/examples 风格）：可抽取概念 / 风格 / 场地，无必须项也不编造', () => {
  const design = readFileSync(new URL('../docs/examples/tea-house-design-report.md', import.meta.url), 'utf8');
  const spec = BuildSpec.parse({
    schemeId: 'scheme-report-example',
    schemeRevision: 1,
    title: '溪畔茶亭',
    scope: 'exterior+interior',
    bounds: { min: [2, 1, 2], max: [12, 5, 10] },
    siteBounds: { min: [0, 0, 0], max: [20, 8, 16] },
    levels: [{ id: 'f1', name: '首层', elevation: 1, height: 4 }],
    spaces: [
      {
        id: 'sp-tea',
        name: '主茶室',
        level: 'f1',
        kind: 'room',
        bounds: { min: [2, 1, 2], max: [10, 5, 8] },
        areaM2: 48,
        connections: [],
      },
    ],
    elements: [],
    openings: [
      {
        id: 'op-north',
        name: '北侧入口门',
        level: 'f1',
        host: 'wall-north',
        kind: 'door',
        side: 'north',
        bounds: { min: [5, 1, 2], max: [7, 3, 3] },
        width: 2,
        height: 2,
        sillHeight: 0,
        headHeight: 2,
        fill: '洞口',
        frameMaterial: null,
      },
    ],
    routes: [],
    structure: {
      system: 'post-and-beam',
      material: 'm-wood',
      spanX: 10,
      spanZ: 8,
      floorThickness: 1,
      cantilever: 0,
      notes: null,
    },
    roof: {
      form: 'gable',
      material: 'm-roof',
      pitchDegrees: 25,
      eaveHeight: 5,
      ridgeHeight: 7,
      overhang: 1,
      drainage: null,
      skylights: [],
      notes: '南侧檐口压低，形成檐下灰空间。',
    },
    facades: [],
    materials: [],
    details: [],
    interiors: [],
    counts: {
      levels: 1,
      spaces: 1,
      elements: 0,
      openings: 1,
      routes: 0,
      musts: 1,
      footprintX: 10,
      footprintZ: 8,
      footprintAreaM2: 80,
    },
    budget: { maxBlocks: 12_000, targetBlocks: null, estimatedBlocks: null, maxCostCny: null },
    forbidden: [],
    musts: [{ id: 'req-view', text: '主要视线朝南侧稻田，南向开口与平台不遮挡。', source: 'requirement' }],
  });

  const digest = buildDesignDigest(design, spec);
  assert.ok(digest.includes('概念：檐下茶事。'), '应抽取“设计概念”首段');
  assert.ok(digest.includes('低檐') && digest.includes('木石'), '应回退到概念 bullet 作为风格/氛围');
  assert.ok(digest.includes('约 20×16 m'), '应保留场地分析首条');
  assert.ok(digest.includes('req-view'), 'must 来自 BuildSpec');
  assert.ok(digest.includes('主要视线朝南侧稻田'), 'must 全文来自 BuildSpec');
  assert.ok(digest.includes('design.md 未记录未决问题'), '缺段时保守说明，不编造');
});

test('上限更紧时先压缩叙述，must 全文与关键数字不裁', () => {
  const run9 = FIXTURES[0];
  assert.ok(run9 !== undefined);
  const count = loadTokenCounter().count;
  const normal = buildDesignDigest(run9.design, run9.spec);
  const compressed = buildDesignDigest(run9.design, run9.spec, { countTokens: count, maxTokens: 2_050 });
  for (const must of run9.spec.musts) assert.ok(compressed.includes(normalize(must.text)), `缺 must ${must.id}`);
  assert.ok(compressed.includes(spanOf(run9.spec.bounds)));
  assert.ok(compressed.includes(`${String(run9.spec.roof.pitchDegrees)}°`));
  assert.ok(count(compressed) <= 2_050, `压缩后 ${String(count(compressed))} > 2050`);
  assert.ok(count(compressed) < count(normal), '更紧的上限应触发叙述压缩');
});
