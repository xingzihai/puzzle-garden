import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleRequirements, exampleScheme } from './example.ts';
import { RequirementGraph } from './requirements.ts';
import { DesignScheme } from './scheme.ts';

test('样例需求图与方案通过 schema，revision 可调', () => {
  const requirements = exampleRequirements(2);
  const scheme = exampleScheme(3);
  assert.equal(requirements.revision, 2);
  assert.equal(scheme.meta.revision, 3);
  assert.equal(scheme.meta.sourceRequirements.graphId, requirements.id);
  assert.equal(RequirementGraph.safeParse(requirements).success, true);
  assert.equal(DesignScheme.safeParse(scheme).success, true);
  assert.equal(Object.isFrozen(scheme.elements), true);
});

test('样例覆盖 must 需求、柜台与南向看景', () => {
  const requirements = exampleRequirements();
  const scheme = exampleScheme();
  assert.equal(requirements.requirements.filter((requirement) => requirement.priority === 'must').length, 2);
  assert.ok(scheme.spaces.some((space) => space.id === 'sp-counter'));
  assert.ok(scheme.openings.some((opening) => opening.side === 'south'));
  assert.ok(scheme.circulation.some((route) => route.kind === 'entry'));
});
