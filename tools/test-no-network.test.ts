import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NO_NETWORK_MESSAGE, replaceFetch } from './test-no-network.ts';

describe('test-no-network（MODEL-SPEC §6.5 A2）', () => {
  test('import 本模块后全局 fetch 直接抛错，信息写明"测试禁止真实网络"', () => {
    assert.equal(typeof globalThis.fetch, 'function');
    assert.throws(() => {
      void globalThis.fetch('http://example.com/');
    }, /测试禁止真实网络/);
    assert.throws(
      () => {
        void globalThis.fetch('http://example.com/');
      },
      (error: unknown) => error instanceof Error && error.message === NO_NETWORK_MESSAGE,
    );
  });

  test('replaceFetch 可安装到任意目标对象且可重复安装', () => {
    const target = { fetch: (): Promise<never> => Promise.reject(new Error('real')) };
    replaceFetch(target);
    assert.throws(() => {
      void (target.fetch as (url: string) => unknown)('http://example.com/');
    }, /测试禁止真实网络/);
    replaceFetch(target);
    assert.throws(() => {
      void (target.fetch as (url: string) => unknown)('http://example.com/');
    }, /测试禁止真实网络/);
  });

  test('真实用 --import 启动子进程：fetch 立即失败、退出码非 0', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        './tools/test-no-network.ts',
        '--input-type=module',
        '--eval',
        "globalThis.fetch('http://example.com/');",
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /测试禁止真实网络/);
  });
});
