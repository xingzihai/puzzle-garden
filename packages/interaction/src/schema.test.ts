import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BuildBrief, BuildSpec, Bounds, DesignScheme, RequirementGraph, ReviewReport } from './schema.ts';

test('schema 入口稳定导出交互层核心 schema', () => {
  for (const schema of [RequirementGraph, DesignScheme, BuildSpec, BuildBrief, ReviewReport, Bounds]) {
    assert.equal(typeof schema.parse, 'function');
  }
});
