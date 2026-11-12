import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addressSpaceBytes, bwrapArgs, nodeArgs, sandboxLaunch } from './args.ts';
import type { SandboxLayout, SandboxLimits } from './args.ts';

const layout: SandboxLayout = {
  repoRoot: '/repo',
  nodePath: '/usr/bin/node',
  childPath: '/repo/packages/sandbox/src/child.ts',
  blockStatesPath: '/repo/assets/mc-1.20.1/block-states.json',
};
const limits: SandboxLimits = { maxOldSpaceMiB: 3072, addressSpaceGiB: 8 };

describe('args：bwrap 与 node 参数生成', () => {
  test('bwrap 参数含 clearenv + TZ UTC，且按原路径只读挂载方块表', () => {
    const args = bwrapArgs(layout);
    const index = args.indexOf('--setenv');
    assert.ok(index >= 0);
    assert.equal(args[index + 1], 'TZ');
    assert.equal(args[index + 2], 'UTC');
    assert.ok(args.includes('--unshare-all'));
    assert.ok(args.includes('--die-with-parent'));
    assert.ok(args.includes('--new-session'));
    assert.ok(args.includes('--cap-drop'));
    assert.ok(args.includes(layout.blockStatesPath));
    assert.ok(args.includes('--proc'));
  });

  test('F8：--size 紧挨在 --tmpfs /tmp 之前', () => {
    const args = bwrapArgs(layout);
    const tmpfs = args.indexOf('/tmp');
    assert.ok(tmpfs > 0);
    assert.equal(args[tmpfs - 1], '--tmpfs');
    assert.equal(args[tmpfs - 2], String(64 * 1024 * 1024));
    assert.equal(args[tmpfs - 3], '--size');
  });

  test('F1：node 参数在冻结前 --require child-preload', () => {
    const args = nodeArgs(layout, limits, layout.childPath);
    const index = args.indexOf('--require');
    assert.ok(index >= 0);
    assert.equal(args[index + 1], '/repo/packages/sandbox/src/child-preload.ts');
    assert.ok(args.includes('--frozen-intrinsics'));
  });

  test('node 参数含 --frozen-intrinsics 与堆上限，不含危险放行', () => {
    const args = nodeArgs(layout, limits, layout.childPath);
    assert.equal(args[0], '--permission');
    assert.ok(args.includes('--frozen-intrinsics'));
    assert.ok(args.includes('--disallow-code-generation-from-strings'));
    assert.ok(args.includes('--disable-proto=throw'));
    assert.ok(args.includes('--max-old-space-size=3072'));
    assert.ok(args.includes('--stack-trace-limit=16'));
    assert.ok(args.includes(`--allow-fs-read=/repo/packages/`));
    assert.ok(args.includes(`--allow-fs-read=/opt/pg/`));
    assert.ok(args.includes(`--allow-fs-read=${layout.blockStatesPath}`));
    // 反例：任何写 / 子进程 / worker / addon / wasi / inspector 放行都不允许出现。
    for (const banned of [
      '--allow-fs-write',
      '--allow-child-process',
      '--allow-worker',
      '--allow-addons',
      '--allow-wasi',
      '--allow-inspector',
    ]) {
      assert.ok(!args.includes(banned), `不应包含 ${banned}`);
    }
    assert.equal(args.at(-1), layout.childPath);
  });

  test('sandboxLaunch 组合 bwrap → prlimit → node，地址空间写字节数', () => {
    assert.equal(addressSpaceBytes(limits), 8 * 1024 ** 3);
    const launch = sandboxLaunch(layout, limits);
    assert.equal(launch.command, 'bwrap');
    assert.ok(launch.args.includes('--frozen-intrinsics'));
    assert.ok(launch.args.includes('--setenv'));
    assert.ok(launch.args.includes(`--as=${String(8 * 1024 ** 3)}`));
    assert.ok(!launch.args.some((a) => a.includes('--allow-fs-write')));
    assert.equal(launch.args.at(-1), layout.childPath);
  });

  test('可替换脚本并追加脚本参数；cgroup 可选时套 systemd-run', () => {
    const probe = '/repo/packages/sandbox/fixtures/escape-probe.ts';
    const plain = sandboxLaunch(layout, limits, probe, ['network']);
    assert.equal(plain.args.at(-2), probe);
    assert.equal(plain.args.at(-1), 'network');

    const cgroup = sandboxLaunch(layout, limits, probe, [], 4096);
    assert.equal(cgroup.command, 'systemd-run');
    assert.ok(cgroup.args.includes('MemoryMax=4096M'));
    assert.ok(cgroup.args.includes('MemorySwapMax=0'));
    assert.ok(cgroup.args.includes(probe));
  });
});
