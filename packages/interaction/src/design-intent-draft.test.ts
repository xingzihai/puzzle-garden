import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleIntent } from './example-intent.ts';
import { DesignIntentDraft } from './design-intent-draft.ts';

test('Draft schema 接受常见别名与可选 notes，拒绝其他未知字段', () => {
  const value = structuredClone(exampleIntent()) as unknown as Record<string, unknown>;
  const structure = value['structure'] as Record<string, unknown>;
  structure['system'] = 'timber-frame';
  structure['slabThickness'] = 1;
  const roof = value['roof'] as Record<string, unknown>;
  roof['slope'] = 0.35;
  const facades = value['facades'] as Record<string, unknown>[];
  const first = facades[0];
  assert.ok(first !== undefined);
  first['layers'] = [{ role: 'base', materialId: 'm-stone' }];
  first['notes'] = '允许的备注';
  const openings = value['openings'] as Record<string, unknown>[];
  const entry = openings[0];
  assert.ok(entry !== undefined);
  entry['hostRoomId'] = entry['roomId'];
  Reflect.deleteProperty(entry, 'roomId');

  assert.equal(DesignIntentDraft.safeParse(value).success, true);
  first['surprise'] = 1;
  assert.equal(DesignIntentDraft.safeParse(value).success, false);
});
