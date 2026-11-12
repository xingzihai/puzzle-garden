import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateMustClauseStatus,
  clauseEvidenceRef,
  MustClausePlanFile,
  summarizeClausePlan,
  type MustClausePlanFile as MustClausePlanFileType,
} from './must-clause.ts';

function samplePlan(): MustClausePlanFileType {
  return MustClausePlanFile.parse({
    schemaVersion: 1,
    tool: 'must-clause-compiler',
    compilerVersion: 'test-v1',
    groups: [
      {
        mustId: 'req-test-wall',
        text: '外墙厚 1m。',
        leaves: [
          {
            schemaVersion: 1,
            clauseId: 'req-test-wall#thickness',
            mustId: 'req-test-wall',
            parentMustId: 'req-test-wall',
            text: '外墙厚 1m。',
            kind: 'dimension',
            target: { metric: 'thickness', value: 1, unit: 'm', relation: null },
            check: {
              kind: 'coverage',
              id: 'check:thickness:f1',
              objectRefs: ['wall:f1'],
              params: { checkId: 'check:thickness:f1', field: 'thickness' },
            },
            specTarget: 1,
            conflict: null,
            waiverable: false,
            reason: null,
          },
          {
            schemaVersion: 1,
            clauseId: 'req-test-wall#quality',
            mustId: 'req-test-wall',
            parentMustId: 'req-test-wall',
            text: '外墙厚 1m。',
            kind: 'qualitative',
            target: null,
            check: { kind: 'qualitative', id: 'check:qualitative:test', objectRefs: [], params: {} },
            specTarget: null,
            conflict: null,
            waiverable: true,
            reason: '造型无法几何验证',
          },
        ],
      },
    ],
    summary: { musts: 1, leaves: 2, byKind: emptyKinds(), qualitative: 1, conflicts: 0 },
  });
}

function emptyKinds(): Record<string, number> {
  return {
    dimension: 1,
    count: 0,
    kind: 0,
    relation: 0,
    absence: 0,
    material: 0,
    budget: 0,
    form: 0,
    qualitative: 1,
    program: 0,
    site: 0,
    visual: 0,
  };
}

test('aggregateMustClauseStatus：not-met 优先，其次 unverified，再次 waived，最后 met', () => {
  assert.equal(aggregateMustClauseStatus([]), 'met');
  assert.equal(aggregateMustClauseStatus(['met', 'met']), 'met');
  assert.equal(aggregateMustClauseStatus(['met', 'waived']), 'waived');
  assert.equal(aggregateMustClauseStatus(['met', 'unverified']), 'unverified');
  assert.equal(aggregateMustClauseStatus(['waived', 'unverified']), 'unverified');
  assert.equal(aggregateMustClauseStatus(['unverified', 'not-met']), 'not-met');
  assert.equal(aggregateMustClauseStatus(['met', 'waived', 'unverified', 'not-met']), 'not-met');
});

test('MustClausePlanFile schema round-trip，summary 由 groups 重算', () => {
  const plan = samplePlan();
  const roundTripped = MustClausePlanFile.parse(JSON.parse(JSON.stringify(plan)));
  assert.deepEqual(roundTripped, plan);
  assert.deepEqual(summarizeClausePlan(plan), plan.summary);
  assert.deepEqual(MustClausePlanFile.parse(roundTripped).summary, summarizeClausePlan(roundTripped));
});

test('clauseEvidenceRef 是稳定前缀；计划里不存 status', () => {
  const plan = samplePlan();
  const leaves = plan.groups.flatMap((group) => group.leaves);
  for (const leaf of leaves) {
    assert.equal('status' in leaf, false);
    assert.equal(clauseEvidenceRef(leaf), `clause:${leaf.clauseId}`);
  }
});
