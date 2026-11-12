/** import-mc-assets.ts：参数、清单统计与合规开关。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildManifest, defaultOut, parseArgs } from './import-mc-assets.ts';

test('缺省输出在 .work/，下载必须显式接受资产许可', () => {
  assert.match(defaultOut(), /\.work\/mc-assets\/1\.20\.1$/);
  assert.equal(parseArgs([]).download, false);
  assert.throws(() => parseArgs(['--download']), /accept-minecraft-assets/);
  const args = parseArgs(['--download', '--accept-minecraft-assets', '--force']);
  assert.equal(args.download, true);
  assert.equal(args.accept, true);
  assert.equal(args.force, true);
  assert.throws(() => parseArgs(['--source']), /需要一个路径/);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
});

test('manifest 统计 blockstates / models / textures / tags', () => {
  const manifest = buildManifest(
    { kind: 'client-jar', path: '/tmp/1.20.1.jar', sha256: 'a'.repeat(64), bytes: 10 },
    {
      'assets/minecraft/blockstates/stone.json': { sha256: 'b'.repeat(64), bytes: 1 },
      'assets/minecraft/models/block/stone.json': { sha256: 'c'.repeat(64), bytes: 1 },
      'assets/minecraft/textures/block/stone.png': { sha256: 'd'.repeat(64), bytes: 1 },
      'data/minecraft/tags/blocks/stone.json': { sha256: 'e'.repeat(64), bytes: 1 },
    },
    ['skip.md'],
  );
  assert.equal(manifest.mcVersion, '1.20.1');
  assert.deepEqual(manifest.counts, { files: 4, blockstates: 1, models: 1, textures: 1, tags: 1 });
  assert.deepEqual(manifest.skipped, ['skip.md']);
  assert.match(manifest.$comment, /不入库/);
});
