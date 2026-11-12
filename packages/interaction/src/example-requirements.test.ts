import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleRequirements } from './example-requirements.ts';
import { RequirementGraph } from './requirements.ts';

test('样例需求图通过 schema，revision 可调', () => {
  const graph = exampleRequirements(4);
  assert.equal(graph.revision, 4);
  assert.equal(RequirementGraph.safeParse(graph).success, true);
  assert.equal(Object.isFrozen(graph.requirements), true);
});
