import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleRequirements } from './example-requirements.ts';
import {
  INTENT_DRAFT_SCHEMA_TEXT,
  INTENT_NARRATIVE_SYSTEM,
  INTENT_NARRATIVE_TOOL_NAME,
  intentNarrativePrompt,
} from './prompts-intent.ts';

test('设计叙事提示词是 8–15 行纯文本，不注入 Draft schema', () => {
  const narrative = intentNarrativePrompt(exampleRequirements(), {
    schemeId: 'scheme-tea',
    revision: 1,
    maxBlocks: 20_000,
  });
  assert.match(INTENT_NARRATIVE_SYSTEM, /8–15 行/);
  assert.match(INTENT_NARRATIVE_SYSTEM, new RegExp(INTENT_NARRATIVE_TOOL_NAME));
  assert.match(narrative.user, /## 用户声音/);
  assert.match(narrative.user, /8–15 行/);
  assert.equal(narrative.user.includes(INTENT_DRAFT_SCHEMA_TEXT), false);
  assert.equal(INTENT_NARRATIVE_SYSTEM.includes(INTENT_DRAFT_SCHEMA_TEXT), false);
  assert.equal(INTENT_NARRATIVE_SYSTEM.includes('"properties"'), false);
});
