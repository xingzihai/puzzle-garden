import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { outputNames, parseArgs } from './render-archive.ts';

describe('render-archive 参数解析', () => {
  it('解析多个存档与 --out', () => {
    assert.deepEqual(parseArgs(['a.pgar', 'b.pgar', '--out', '/tmp/out']), {
      archives: ['a.pgar', 'b.pgar'],
      outDir: '/tmp/out',
    });
  });

  it('缺存档、缺 --out、缺 --out 值、未知参数都报错', () => {
    assert.throws(() => parseArgs(['--out', '/tmp/out']), /至少需要一个/);
    assert.throws(() => parseArgs(['a.pgar']), /缺少 --out/);
    assert.throws(() => parseArgs(['a.pgar', '--out']), /--out 缺少目录参数/);
    assert.throws(() => parseArgs(['a.pgar', '--out', '', '--wat']), /--out 缺少目录参数|未知参数/);
    assert.throws(() => parseArgs(['a.pgar', '--out', '/tmp/out', '--wat']), /未知参数 --wat/);
  });
});

describe('render-archive 输出目录名', () => {
  it('去掉扩展名、保留多级路径的文件名', () => {
    assert.deepEqual(outputNames(['/x/foo.pgar', 'bar.baz.pgar']), ['foo', 'bar.baz']);
  });

  it('同名存档按父目录逐级加后缀区分', () => {
    assert.deepEqual(
      outputNames(['/runs/20261003-a/delivery/building.pgar', '/runs/20261003-b/delivery/building.pgar']),
      ['building-delivery-20261003-a', 'building-delivery-20261003-b'],
    );
    assert.deepEqual(outputNames(['/runs/a/building.pgar', '/runs/b/building.pgar']), ['building-a', 'building-b']);
  });

  it('无法用路径区分时（同一路径）报错，不静默覆盖', () => {
    assert.throws(() => outputNames(['/a/x.pgar', '/a/x.pgar']), /无法用路径区分/);
  });
});
