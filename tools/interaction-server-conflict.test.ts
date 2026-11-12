import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ChatClient } from '@pg/llm/client';
import { exampleRequirements, exampleScheme } from '@pg/interaction/example';
import { designConflictFromDatum, designConflictsFromWarnings } from '@pg/interaction/schema';
import type { DesignConflict } from '@pg/interaction/schema';
import { createSession, reduceSession } from '@pg/interaction/session';
import type { SessionState } from '@pg/interaction/session';
import { deriveFloorDatum } from '@pg/interaction/schema';
import { DesignScheme, RequirementGraph } from '@pg/interaction/schema';

import { SessionManager } from './interaction-server-session.ts';

function pendingClient(): ChatClient {
  return { complete: () => new Promise<never>(() => undefined) };
}

function seedReview(
  id: string,
  requirements: ReturnType<typeof exampleRequirements>,
  scheme: ReturnType<typeof exampleScheme>,
  conflicts: readonly DesignConflict[],
): SessionState {
  let state = createSession(id);
  state = reduceSession(state, { kind: 'recordRequirements', graph: requirements });
  state = reduceSession(state, { kind: 'skipClarify' });
  state = reduceSession(state, { kind: 'proposeDesign', scheme, conflicts });
  return reduceSession(state, { kind: 'recordCheck', designRevision: 1, passed: true, issues: [] });
}

function managerWithState(root: string, state: SessionState): { manager: SessionManager; id: string } {
  const manager = new SessionManager({
    mode: 'mock',
    sessionRoot: root,
    clientFactory: pendingClient,
    buildLog: () => undefined,
  });
  const id = manager.create('conflict test');
  const sessions = (manager as unknown as { sessions: Map<string, { state: SessionState; status: string }> }).sessions;
  const record = sessions.get(id);
  assert.ok(record);
  record.state = { ...state, sessionId: id };
  record.status = 'waiting_decision';
  return { manager, id };
}

test('Web API manager：非 datum conflict 选择 accept 后 resolve；repair 保持 open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pg-conflict-'));
  try {
    const conflict = designConflictsFromWarnings([
      { code: 'furniture-dropped', message: '柜台被丢弃', path: 'furniture.f-counter' },
    ])[0];
    assert.ok(conflict);
    const state = seedReview('ses-conflict-api', exampleRequirements(), exampleScheme(), [conflict]);
    const { manager, id } = managerWithState(root, state);
    const resolved = await manager.chooseConflict(id, {
      conflictId: conflict.id,
      optionId: 'accept-drop',
    });
    assert.equal(resolved.conflicts[0]?.status, 'resolved');

    const search = await manager.chooseConflict(id, {
      conflictId: conflict.id,
      optionId: 'restore-furniture',
    });
    assert.equal(search.conflicts[0]?.status, 'open');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Web API manager：datum 四个选项都可选择；accept-step / waive 解除，raise-site / redesign 保持', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pg-datum-choice-'));
  try {
    const requirements = RequirementGraph.parse(
      JSON.parse(
        readFileSync(new URL('../packages/interaction/fixtures/run7-requirements.json', import.meta.url), 'utf8'),
      ) as unknown,
    );
    const base = exampleScheme();
    const scheme = DesignScheme.parse({
      ...base,
      meta: { ...base.meta, id: 'scheme-datum-api', revision: 1 },
      site: { ...base.site, bounds: { min: [0, -1, 0], max: [24, 20, 20] } },
    });
    const datum = deriveFloorDatum(scheme, requirements);
    assert.ok(datum.conflict);
    const conflict = designConflictFromDatum(datum.conflict);
    const state = seedReview('ses-datum-api', requirements, scheme, [conflict]);
    const { manager, id } = managerWithState(root, state);

    for (const [optionId, expected] of [
      ['accept-step', 'resolved'],
      ['waive', 'resolved'],
      ['raise-site', 'open'],
      ['redesign', 'open'],
    ] as const) {
      const record = (manager as unknown as { sessions: Map<string, { state: SessionState }> }).sessions.get(id);
      assert.ok(record);
      record.state = state;
      const snapshot = await manager.chooseConflict(id, {
        conflictId: conflict.id,
        optionId,
      });
      assert.equal(snapshot.conflicts[0]?.status, expected, optionId);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
