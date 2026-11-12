import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatApiCalls, parseArgs } from './run-build.ts';

describe('run-build 参数解析', () => {
  it('解析代码路径、--out 与默认种子 0', () => {
    assert.deepEqual(parseArgs(['a.ts', '--out', '/tmp/o']), { code: 'a.ts', outDir: '/tmp/o', seed: 0 });
  });

  it('解析 --seed', () => {
    assert.deepEqual(parseArgs(['--seed', '7', 'a.ts', '--out', 'o']), { code: 'a.ts', outDir: 'o', seed: 7 });
  });

  it('缺代码、缺 --out、多份代码、未知参数、非法种子都报错', () => {
    assert.throws(() => parseArgs(['--out', 'o']), /缺少代码文件/);
    assert.throws(() => parseArgs(['a.ts']), /缺少 --out/);
    assert.throws(() => parseArgs(['a.ts', '--out']), /--out 缺少参数值/);
    assert.throws(() => parseArgs(['a.ts', 'b.ts', '--out', 'o']), /只接受一份代码/);
    assert.throws(() => parseArgs(['a.ts', '--out', 'o', '--wat']), /未知参数 --wat/);
    assert.throws(() => parseArgs(['a.ts', '--out', 'o', '--seed', '-1']), /--seed 缺少参数值|--seed 应为/);
    assert.throws(() => parseArgs(['a.ts', '--out', 'o', '--seed', '1.5']), /--seed 应为/);
    assert.throws(() => parseArgs(['a.ts', '--out', 'o', '--seed', '4294967296']), /--seed 应为/);
  });
});

describe('run-build API 调用计数', () => {
  it('按次数降序、同次数按名字排', () => {
    assert.equal(formatApiCalls({ set: 3, box: 3, walls: 9 }), 'API 调用：\n  walls ×9\n  box ×3\n  set ×3');
  });

  it('没有调用时写"无"', () => {
    assert.equal(formatApiCalls({}), 'API 调用：无');
  });
});
