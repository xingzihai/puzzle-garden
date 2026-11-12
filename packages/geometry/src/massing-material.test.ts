import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Role } from '@pg/modeling/schema';

import type { MassingColorCandidate } from '@pg/blocks/color';

import { MassingError } from './massing-error.ts';
import { resolveMassingMaterial } from './massing-material.ts';

const c = (id: string, rgb: number, family: MassingColorCandidate['family']): MassingColorCandidate => ({
  id,
  rgb,
  family,
});

function expectMaterialError(run: () => unknown, code: MassingError['code'], re: RegExp): void {
  let error: unknown;
  try {
    run();
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof MassingError, `期望 MassingError，实际 ${String(error)}`);
  assert.equal(error.code, code);
  assert.match(error.message, re);
}

describe('resolveMassingMaterial', () => {
  it('池内取最近色：更近的池外候选被忽略', () => {
    const out = c('wool_black', 0x000000, 'wool');
    const inn = c('stone_white', 0xffffff, 'stone');
    assert.equal(resolveMassingMaterial('volume', '#000000', [out, inn]).id, 'stone_white');
  });

  it('每个 role 的池按规格生效（池外更近也不选）', () => {
    const out = c('out_black', 0x000000, 'wool');
    const inn: Readonly<Record<Role, MassingColorCandidate>> = {
      volume: c('in_white', 0xffffff, 'stone'),
      roof: c('in_white', 0xffffff, 'wood'),
      floor: c('in_white', 0xffffff, 'quartz'),
      connection: c('in_white', 0xffffff, 'concrete'),
    };
    for (const role of ['volume', 'roof', 'floor', 'connection'] as const) {
      assert.equal(resolveMassingMaterial(role, '#000000', [out, inn[role]]).id, 'in_white');
    }
  });

  it('池内平手按 id 码点升序', () => {
    const a = c('b_terracotta', 0xff0000, 'terracotta');
    const b = c('a_wood', 0xff0000, 'wood');
    assert.equal(resolveMassingMaterial('roof', '#ff0000', [a, b]).id, 'a_wood');
  });

  it('池内无候选回退全体候选', () => {
    const red = c('wool_red', 0xff0000, 'wool');
    const blue = c('wool_blue', 0x0000ff, 'wool');
    assert.equal(resolveMassingMaterial('connection', '#ff0000', [red, blue]).id, 'wool_red');
  });

  it('整数平方 RGB 距离（#fe0000 比 #000000 更近 #ff0000）', () => {
    const red = c('red', 0xff0000, 'stone');
    const black = c('black', 0x000000, 'stone');
    assert.equal(resolveMassingMaterial('floor', '#fe0000', [black, red]).id, 'red');
    assert.equal(resolveMassingMaterial('floor', '#00ff00', [c('green', 0x00ff00, 'sand')]).id, 'green');
  });

  it('全体候选为空：material-missing', () => {
    expectMaterialError(() => resolveMassingMaterial('volume', '#000000', []), 'material-missing', /候选|颜色表/);
  });

  it('色值只接受严格小写 #rrggbb：其余 material-invalid', () => {
    for (const bad of ['000000', '#00000', '#0000000', '#GGGGGG', '#AABBCC', '', '#12345g']) {
      expectMaterialError(
        () => resolveMassingMaterial('volume', bad, [c('x', 0x000000, 'stone')]),
        'material-invalid',
        /#rrggbb/,
      );
    }
  });
});
