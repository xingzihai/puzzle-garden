/** API 版本号是生成声明头部与存档头的唯一来源（SANDBOX-SPEC §5.2、§10 第 14 条）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_VERSION } from './version.ts';

test('API_VERSION 为当前声明版本号', () => {
  assert.equal(API_VERSION, 9);
});
