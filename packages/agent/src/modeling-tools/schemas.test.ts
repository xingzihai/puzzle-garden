/** 草模工具 schema：数量上限、$schema 去除、参数校验双向。 */
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { MODEL_TOOL_ARGS, MODEL_TOOL_DEFS, MODEL_TOOL_NAMES, isModelToolName, parametersOf } from './schemas.ts';

it('6 个草模工具，名字与定义同源且不超过 12', () => {
  assert.equal(MODEL_TOOL_NAMES.length, 6);
  assert.deepEqual(
    MODEL_TOOL_DEFS.map((d) => d.function.name),
    [...MODEL_TOOL_NAMES],
  );
  assert.equal(MODEL_TOOL_DEFS.length <= 12, true);
  for (const name of MODEL_TOOL_NAMES) {
    const params = parametersOf(name);
    assert.equal('$schema' in params, false, `${name} 不应带 $schema`);
    assert.equal(params['type'], 'object');
  }
});

it('isModelToolName 只认草模工具名', () => {
  assert.equal(isModelToolName('run_model'), true);
  assert.equal(isModelToolName('check_code'), false);
  assert.equal(isModelToolName('run'), false);
});

it('write_code 参数：合法通过，缺字段 / 多字段拒绝', () => {
  assert.equal(MODEL_TOOL_ARGS.write_code.safeParse({ code: 'x' }).success, true);
  assert.equal(MODEL_TOOL_ARGS.write_code.safeParse({}).success, false);
  assert.equal(MODEL_TOOL_ARGS.write_code.safeParse({ code: 'x', extra: 1 }).success, false);
});

it('edit_code 参数：至少一条、最多 20 条', () => {
  assert.equal(MODEL_TOOL_ARGS.edit_code.safeParse({ edits: [] }).success, false);
  assert.equal(MODEL_TOOL_ARGS.edit_code.safeParse({ edits: [{ find: 'a', replace: 'b' }] }).success, true);
  const many = Array.from({ length: 21 }, () => ({ find: 'a', replace: 'b' }));
  assert.equal(MODEL_TOOL_ARGS.edit_code.safeParse({ edits: many }).success, false);
});

it('read_code 参数：from / to 为可选正整数', () => {
  assert.equal(MODEL_TOOL_ARGS.read_code.safeParse({}).success, true);
  assert.equal(MODEL_TOOL_ARGS.read_code.safeParse({ from: 1, to: 3 }).success, true);
  assert.equal(MODEL_TOOL_ARGS.read_code.safeParse({ from: 0 }).success, false);
});

it('run_model / view_model 无参数，submit_model 需要 note', () => {
  assert.equal(MODEL_TOOL_ARGS.run_model.safeParse({}).success, true);
  assert.equal(MODEL_TOOL_ARGS.run_model.safeParse({ x: 1 }).success, false);
  assert.equal(MODEL_TOOL_ARGS.view_model.safeParse({}).success, true);
  assert.equal(MODEL_TOOL_ARGS.submit_model.safeParse({ note: '' }).success, true);
  assert.equal(MODEL_TOOL_ARGS.submit_model.safeParse({}).success, false);
  assert.equal(MODEL_TOOL_ARGS.submit_model.safeParse({ note: 1 }).success, false);
});
