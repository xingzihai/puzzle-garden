/**
 * 校准：用 v0.2 冻结夹具的存档跑四项测量，数字与历史 ANALYSIS-SPEC §7.2 一致。
 * 存档由 v0.2 冻结引擎执行夹具后生成；human 夹具已移除，只保留 v0.2 benchmark-frozen。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readArchive } from '@pg/core/archive';
import type { Grid } from '@pg/core/grid';

import { registry } from './fixtures.test.ts';
import { measureFloating } from './floating.ts';
import { measureReach } from './reach.ts';

const DIR = join(import.meta.dirname, '../../../assets/v02/fixture-cells');

function load(name: string): Grid {
  return readArchive(registry.table, readFileSync(join(DIR, `${name}.pgar`))).grid;
}

// [夹具, 悬空格, 只靠棱角的悬空格, 可达最高站立高度, 最高站立高度]
const EXPECTED: readonly (readonly [string, number, number, number, number])[] = [
  ['tower-ok', 59, 59, 2, 55],
  ['tower-broken', 0, 0, 2, 55],
  ['pv-nocol', 2976, 12, 5, 34],
];

describe('v0.2 夹具校准（ANALYSIS-SPEC §7.2）', () => {
  for (const [name, floating, edgeOnly, reachedY, standY] of EXPECTED) {
    it(name, () => {
      const g = load(name);
      const f = measureFloating(g);
      const r = measureReach(g, registry);
      assert.deepEqual([f.cells, f.edgeOnly, r.maxReachedY, r.maxStandableY], [floating, edgeOnly, reachedY, standY]);
    });
  }

  it('塔题锚点走不上去：第一道阻挡是楼梯第一级太高', () => {
    const r = measureReach(load('tower-ok'), registry);
    assert.equal(r.blockers[0]?.reason, 'too-high');
  });

  it('变异体只坏一处：删掉攒尖顶后悬空变多（顶饰失去支承），删掉楼梯后悬空归零', () => {
    assert.ok(measureFloating(load('tower-mut-notop')).cells > measureFloating(load('tower-ok')).cells);
    assert.equal(measureFloating(load('tower-broken')).cells, 0);
  });
});
