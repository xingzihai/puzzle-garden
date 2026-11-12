import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DesignIntent } from './design-intent.ts';
import { expandDesignIntent } from './design-expand.ts';
import { exampleIntent } from './example-intent.ts';
import type { DesignHostContext } from './design-intent.ts';

const HOST: DesignHostContext = {
  schemeId: 'scheme-example-intent',
  revision: 1,
  status: 'draft',
  sourceRequirements: { graphId: 'req-tea', revision: 1 },
  maxBlocks: 20_000,
  targetBlocks: 12_000,
  maxCostCny: 100_000,
  forbidden: ['不要做成旅游景点式的售票亭。'],
  defaultMaterialId: 'm-wood',
  floorThickness: 1,
  requirementIds: ['req-use', 'req-view', 'req-budget', 'reqc-budget', 'reqc-forbid'],
};

test('exampleIntent 通过 strict schema，并可确定性展开为 DesignScheme', () => {
  const intent = exampleIntent();
  assert.equal(DesignIntent.safeParse(intent).success, true);
  assert.equal(intent.program.rooms.length, 2);
  assert.equal(intent.meta.scope, 'exterior+interior');
  const resolved = expandDesignIntent(intent, HOST);
  assert.equal(resolved.scheme.meta.id, 'scheme-example-intent');
  assert.equal(resolved.scheme.meta.revision, 1);
  assert.equal(resolved.scheme.spaces.filter((space) => space.kind === 'room').length, 1);
  assert.equal(resolved.scheme.interiors.length, 2);
  assert.ok(resolved.scheme.interiors.every((interior) => interior.furnitureSpecs.length > 0));
});
