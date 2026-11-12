import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  designConflictFromDatum,
  designConflictsFromWarnings,
  isOpenBlockingConflict,
  mergeDesignConflicts,
  resolveDesignConflict,
} from './design-conflict.ts';
import { normalizeDesignIntent } from './design-intent-normalize.ts';
import { exampleIntent, exampleRequirements, exampleScheme } from './example.ts';
import { FloorDatumConflict } from './floor-datum.ts';
import { createSession, reduceSession } from './session.ts';

const DATUM: FloorDatumConflict = FloorDatumConflict.parse({
  id: 'conflict-flush-entry',
  kind: 'flush-entry',
  mustIds: ['req-no-steps'],
  expected: '室外地面与室内地面同高 y1',
  actual: '室外地面 y0，入口底 y1，室内地面 y1',
  recommendedSource: 'raise-site',
  targetGradeY: 1,
  resolution: '抬场地到 y1；否则由用户选择接受或豁免',
  options: [
    { id: 'raise-site', label: '抬高场地' },
    { id: 'accept-step', label: '接受高差' },
    { id: 'waive', label: '豁免 must' },
    { id: 'redesign', label: '重新设计' },
  ],
});

test('datum 冲突转成统一 DesignConflict：options / mustIds / target 保留', () => {
  const conflict = designConflictFromDatum(DATUM);
  assert.equal(conflict.kind, 'datum');
  assert.equal(conflict.severity, 'blocking');
  assert.deepEqual(conflict.mustIds, ['req-no-steps']);
  assert.deepEqual(
    conflict.options.map((option) => option.id),
    ['raise-site', 'accept-step', 'waive', 'redesign'],
  );
  assert.equal(conflict.status, 'open');
});

test('室外分区 / 家具 shrink / relocate / drop 都持久化为 blocking conflict', () => {
  const conflicts = designConflictsFromWarnings([
    { code: 'outdoor-zone-overlap-dropped', message: '分区重叠，已丢弃', path: 'site.outdoorZones.oz' },
    { code: 'furniture-shrunk', message: '长桌 4×2 → 4×1', path: 'furniture.f-table' },
    { code: 'furniture-relocated', message: '北凳移动', path: 'furniture.f-bench' },
    { code: 'furniture-dropped', message: '柜台被丢弃', path: 'furniture.f-counter' },
    { code: 'notes-dropped', message: 'notes 丢弃' },
  ]);
  assert.equal(conflicts.length, 4);
  assert.ok(conflicts.every((conflict) => conflict.severity === 'blocking'));
  assert.deepEqual(
    conflicts.map((conflict) => conflict.kind),
    ['outdoor-zone-overlap', 'furniture-shrink', 'furniture-relocate', 'furniture-drop'],
  );
  for (const conflict of conflicts) {
    assert.ok(conflict.options.length > 0);
    assert.ok(conflict.options.some((option) => option.action === 'accept' || option.action === 'repair'));
  }
});

test('冲突选择：accept 解决；raise-site / repair 保持 open；merge 不覆盖已解决项', () => {
  const datum = designConflictFromDatum(DATUM);
  const accepted = resolveDesignConflict([datum], datum.id, 'accept-step', 'ok');
  assert.equal(accepted[0]?.status, 'resolved');
  assert.ok(accepted[0]);
  assert.equal(isOpenBlockingConflict(accepted[0]), false);

  const raised = resolveDesignConflict([datum], datum.id, 'raise-site', 'later');
  assert.ok(raised[0]);
  assert.equal(raised[0].status, 'open');
  assert.equal(raised[0].choice?.optionId, 'raise-site');

  const merged = mergeDesignConflicts(accepted, [datum]);
  assert.equal(merged[0]?.status, 'resolved');
});

test('SessionState：非 datum conflict 未选择时 confirm 被阻止，accept 后解除', () => {
  const conflict = designConflictsFromWarnings([
    { code: 'furniture-dropped', message: '柜台被丢弃', path: 'furniture.f-counter' },
  ])[0];
  assert.ok(conflict);
  let state = createSession('ses-conflict');
  state = reduceSession(state, { kind: 'recordRequirements', graph: exampleRequirements() });
  state = reduceSession(state, { kind: 'skipClarify' });
  state = reduceSession(state, { kind: 'proposeDesign', scheme: exampleScheme(), conflicts: [conflict] });
  state = reduceSession(state, { kind: 'recordCheck', designRevision: 1, passed: true, issues: [] });
  assert.equal(state.stage, 'review');
  assert.throws(() => reduceSession(state, { kind: 'confirmDesign', designRevision: 1 }), /尚未选择/);
  const resolved = reduceSession(state, {
    kind: 'chooseConflictOption',
    conflictId: conflict.id,
    optionId: 'accept-drop',
  });
  assert.equal(resolved.designConflicts?.[0]?.status, 'resolved');
  const confirmed = reduceSession(resolved, { kind: 'confirmDesign', designRevision: 1 });
  assert.equal(confirmed.stage, 'confirm');
});

test('normalize 的室外分区 overlap 不再只留 warning：同一 warning 可转成 DesignConflict', () => {
  const draft = JSON.parse(JSON.stringify(exampleIntent())) as {
    site: { outdoorZones: unknown[] };
    program: { rooms: { rect: { x: number[]; z: number[] } }[] };
  };
  const room = draft.program.rooms[0];
  assert.ok(room);
  draft.site.outdoorZones.push({
    id: 'oz-overlap',
    name: '与房间重叠的平台',
    kind: 'terrace',
    rect: { x: [...room.rect.x], z: [...room.rect.z] },
    materialId: 'm-stone',
    notes: null,
  });
  const normalized = normalizeDesignIntent(draft);
  const conflicts = designConflictsFromWarnings(normalized.warnings);
  assert.ok(conflicts.some((conflict) => conflict.kind === 'outdoor-zone-overlap'));
  assert.ok(conflicts.every((conflict) => conflict.options.length > 0));
});
