import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileBuildSpec } from './brief.ts';
import { exampleScheme } from './example.ts';
import {
  buildMustIdForConstraint,
  buildMustLedger,
  buildRequirementMustEntries,
  extractMustTargets,
} from './must-ledger.ts';
import { RequirementGraph } from './requirements.ts';
import { DesignScheme } from './scheme.ts';

const RUN7 = RequirementGraph.parse(
  JSON.parse(readFileSync(new URL('../fixtures/run7-requirements.json', import.meta.url), 'utf8')),
);

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

test('MustLedger：run-7 为 31 条 req must + 10 条硬约束，共 41 条', () => {
  const ledger = buildMustLedger(RUN7);
  assert.equal(ledger.requirementsGraphId, RUN7.id);
  assert.equal(ledger.requirementsRevision, RUN7.revision);
  assert.equal(ledger.counts.requirements, 31);
  assert.equal(ledger.counts.constraints, 10);
  assert.equal(ledger.counts.total, 41);
  assert.equal(ledger.counts.unverified, 41);
  assert.equal(new Set(ledger.entries.map((entry) => entry.id)).size, 41);
});

test('MustLedger 的 id / text 与 BuildSpec.musts 完全一致，不新增或改写 id', () => {
  const ledger = buildMustLedger(RUN7);
  const scheme = DesignScheme.parse({ ...exampleScheme(), details: [] });
  const spec = compileBuildSpec(scheme, RUN7);

  assert.deepEqual(
    spec.musts.map((must) => [must.id, must.text]),
    ledger.entries.map((entry) => [entry.id, entry.text]),
  );
  assert.equal(spec.musts.length, 41);
  assert.deepEqual(
    spec.musts.map((must) => must.id),
    buildRequirementMustEntries(RUN7).map((entry) => entry.id),
  );

  const wallConstraint = ledger.entries.find((entry) => entry.sourceId === 'con-wall-1m');
  assert.ok(wallConstraint);
  assert.equal(wallConstraint.id, buildMustIdForConstraint('con-wall-1m'));
  assert.equal(wallConstraint.id, 'constraint-con-wall-1m');
  assert.equal(wallConstraint.source, 'constraint');
});

test('MustLedger 保留全部 must 全文，家具要求 16–21 不被截断', () => {
  const ledger = buildMustLedger(RUN7);
  for (const entry of ledger.entries) {
    assert.ok(entry.text.length > 0, `empty text: ${entry.id}`);
  }

  const allText = ledger.entries.map((entry) => normalized(entry.text)).join('\n');
  assert.ok(allText.includes('4m 长、2m 宽'), '缺长桌 4m×2m 全文');
  assert.ok(allText.includes('4m 长、1m 宽'), '缺长凳 4m×1m 全文');
  assert.ok(allText.includes('各 5 座'), '缺 5+5 座位全文');
  assert.ok(allText.includes('西墙中段'), '缺柜台西墙中段全文');

  const furnitureIds = ledger.entries.filter((entry) => entry.check === 'furniture').map((entry) => entry.sourceId);
  for (const id of [
    'req-long-table',
    'req-bench-north',
    'req-bench-south',
    'req-seats-10',
    'req-counter',
    'req-counter-no-service',
  ]) {
    assert.ok(furnitureIds.includes(id), `家具 must 未归入 furniture 组：${id}`);
  }

  const table = ledger.entries.find((entry) => entry.sourceId === 'req-long-table');
  assert.ok(table);
  assert.ok(table.targets.includes('4m'));
  assert.ok(table.targets.includes('2m'));
  assert.equal(table.status, 'unverified');
  assert.deepEqual(table.evidence, []);

  const budget = ledger.entries.find((entry) => entry.sourceId === 'req-block-budget');
  assert.ok(budget);
  assert.deepEqual(budget.targets, ['20000 方块']);
});

test('extractMustTargets 只抽取原文数字短语，不补造目标', () => {
  assert.deepEqual(extractMustTargets('主厅东侧设一张 4m 长、2m 宽的长桌。'), ['4m', '2m']);
  assert.deepEqual(extractMustTargets('就座共 10 座，南北各 5 座（5+5）。'), ['10 座', '5 座', '5+5']);
  assert.deepEqual(extractMustTargets('方块总量不超过 20000 方块。'), ['20000 方块']);
  assert.deepEqual(extractMustTargets('没有数字的审美要求。'), []);
});
