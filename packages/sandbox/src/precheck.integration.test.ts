/**
 * 预检的集成测试（`npm run test:integration`）：14 份夹具全量回归与 OOM 病态样本。
 * 不依赖 bwrap，所以不需要 skip 逻辑；放在这里只为不让 OOM 样本拖慢推送钩子的单元测试。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPrechecker } from './precheck.ts';

const declaration = readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');
const fixturesDir = fileURLToPath(new URL('../../geometry/fixtures/', import.meta.url));

function stripImports(code: string): string {
  return code
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('import '))
    .join('\n');
}

/** 验收 §10 第 5 条的固定病态样本：16 份自递归元组，会耗尽 1024 MB worker 堆。 */
function pathological(): string {
  const types: string[] = [];
  const values: string[] = [];
  for (let i = 0; i < 16; i++) {
    types.push(
      `type B${String(i)}<N, A = []> = A['length'] extends N ? A : B${String(i)}<N, [...A, B${String(i)}<N, A>]>;`,
    );
    values.push(`type C${String(i)} = B${String(i)}<999>;`);
  }
  return `${types.join('\n')}\n${values.join('\n')}\nconst s: string = null as unknown as C0;\nexport default function build(w: World): void {\n  void s;\n}\n`;
}

describe('precheck 集成', () => {
  test('14 份夹具删去 import 后全部 ok', async () => {
    const files = readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.ts'))
      .sort();
    assert.equal(files.length, 14);
    const prechecker = createPrechecker(declaration);
    try {
      for (const file of files) {
        const code = stripImports(readFileSync(`${fixturesDir}/${file}`, 'utf8'));
        assert.deepEqual(await prechecker.check(code), { kind: 'ok' }, file);
      }
    } finally {
      await prechecker.close();
    }
  });

  test('60s 上限下返回 out-of-memory，随后 check 正常', async () => {
    const prechecker = createPrechecker(declaration, { timeoutMs: 60000 });
    try {
      assert.deepEqual(await prechecker.check(pathological()), { kind: 'out-of-memory', limitMiB: 1024 });
      assert.deepEqual(await prechecker.check('export default function build(w: World): void { void w; }\n'), {
        kind: 'ok',
      });
    } finally {
      await prechecker.close();
    }
  });
});
