import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INTENT_DRAFT_JSON_SCHEMA,
  INTENT_DRAFT_SCHEMA_CHARS,
  INTENT_DRAFT_SCHEMA_TEXT,
  INTENT_SCHEMA_SECTION,
} from './prompts-intent.ts';

test('DesignIntentDraft schema 文本完整、可解析、无 $schema', () => {
  assert.equal(INTENT_DRAFT_SCHEMA_CHARS, INTENT_DRAFT_SCHEMA_TEXT.length);
  assert.equal(Object.hasOwn(INTENT_DRAFT_JSON_SCHEMA, '$schema'), false);
  assert.equal(INTENT_DRAFT_JSON_SCHEMA['type'], 'object');
  assert.equal(INTENT_DRAFT_JSON_SCHEMA['additionalProperties'], false);
  assert.ok(Array.isArray(INTENT_DRAFT_JSON_SCHEMA['required']));
  const properties = INTENT_DRAFT_JSON_SCHEMA['properties'];
  assert.ok(typeof properties === 'object' && properties !== null);
  assert.ok(Object.hasOwn(properties, 'program'));
  assert.ok(Object.hasOwn(properties, 'materials'));
  assert.ok(INTENT_DRAFT_SCHEMA_TEXT.includes('"additionalProperties":false'));
  assert.ok(INTENT_SCHEMA_SECTION.includes(INTENT_DRAFT_SCHEMA_TEXT));
  assert.match(INTENT_SCHEMA_SECTION, /完整 JSON Schema/);
});
