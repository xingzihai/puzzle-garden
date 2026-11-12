import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCallSite, lineFromStack } from './child-callsite.ts';

describe('child-callsite：按锚定正则读行号', () => {
  test('取第一个 pg:building 帧，忽略宿主帧', () => {
    const stack = [
      'Error',
      '    at createCallSite (file:///repo/packages/sandbox/src/child-callsite.ts:30:20)',
      '    at Writer.commit (file:///repo/packages/geometry/src/writer.ts:170:18)',
      '    at World.set (pg:building:7:5)',
      '    at build (pg:building:9:3)',
    ].join('\n');
    assert.deepEqual(lineFromStack(stack), { line: 7, column: 5 });
  });

  test('无函数名的裸帧与带括号的方法名都能匹配', () => {
    assert.deepEqual(lineFromStack('\n    at pg:building:4:11'), { line: 4, column: 11 });
    assert.deepEqual(lineFromStack('    at Object.foo (pg:building:12:2)'), { line: 12, column: 2 });
  });

  test('方法名伪装成 pg:building:999:1 时锚定整行仍取真实行号', () => {
    const stack = '    at Object.pg:building:999:1 (pg:building:3:9)';
    assert.deepEqual(lineFromStack(stack), { line: 3, column: 9 });
  });

  test('找不到模型帧或没有 stack 返回 0', () => {
    assert.deepEqual(lineFromStack('Error\n    at foo (file:///repo/x.ts:1:1)'), { line: 0, column: 0 });
    assert.deepEqual(lineFromStack(undefined), { line: 0, column: 0 });
    assert.deepEqual(lineFromStack(''), { line: 0, column: 0 });
  });

  test('createCallSite 在宿主帧里返回 0（测试进程没有 pg:building）', () => {
    assert.equal(createCallSite()(), 0);
  });
});
