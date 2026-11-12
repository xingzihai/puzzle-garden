/**
 * craft-small 范例的预检集成测试：把 craft-small.ts 里的三段范例原样包进一个最小 build，
 * 用真 prechecker 对照当前 `world.d.ts` 做类型预检，必须 `kind: 'ok'`。
 *
 * 为什么放 integration：prechecker 是常驻 worker + TypeScript，与 craft.integration.test.ts 同约定；
 * 不依赖 bwrap / Chrome，所以不需要 skip 逻辑。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPrechecker } from '@pg/sandbox/precheck';

import { CRAFT_SMALL_EXAMPLES } from './craft-small.ts';

const declaration = readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');

/** 从 markdown 取出 ```ts 代码块正文（与 system 里模型看到的逐字一致）。 */
function fencedCodeBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
}

test('craft-small 的三段范例包成最小 build 能通过 world.d.ts 预检', async () => {
  const blocks = fencedCodeBlocks(CRAFT_SMALL_EXAMPLES);
  assert.equal(blocks.length, 3, '应有檐口、窗框与室内家具三段范例');
  const code = `${blocks.join('\n')}
export default function build(w: World): void {
  const base = w.plinth({ footprint: rect(-6, -6, 6, 6), height: 1, material: 'stone_bricks' });
  const hall = w.walls({ on: base.top, height: 7, material: 'stone_bricks' });
  eave(w, -4, -4, 4, 4, hall.top.y);
  southWindow(w, -2, 1, 2, 4, 7);
  nook(w, -3, 3, -3, 2);
  doorSet(w, 8, 2, -3);
}
`;
  const prechecker = createPrechecker(declaration);
  try {
    assert.deepEqual(await prechecker.check(code), { kind: 'ok' });
  } finally {
    await prechecker.close();
  }
});
