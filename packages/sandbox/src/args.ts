/**
 * 生成 bwrap 与 node 的参数数组（SANDBOX-SPEC §7.1、§7.2），不拼 shell 字符串（STANDARDS §7）。
 *
 * 负责：把仓库路径、node 可执行文件、child / 探针脚本路径拼成可直接交给 spawn 的参数数组。
 * 不负责：执行、计时、分类；这些在 run.ts。
 *
 * 产品路径与逃逸测试用同一个 `sandboxLaunch`，保证"测试里能拦住的参数"就是线上参数（§9）。
 */
import { dirname, join } from 'node:path';

/** 一次执行需要的宿主侧路径。 */
export interface SandboxLayout {
  /** 仓库根；bwrap 里按同路径挂载。 */
  readonly repoRoot: string;
  /** node 可执行文件绝对路径（`process.execPath`）。 */
  readonly nodePath: string;
  /** 默认 child 接线脚本路径；product 用它，逃逸测试换成探针脚本。 */
  readonly childPath: string;
  /** 方块表文件；bwrap 按原路径只读挂载（§7.1 方块表）。 */
  readonly blockStatesPath: string;
}

/** 与 §5.5 表一致的资源上限中影响启动参数的部分。 */
export interface SandboxLimits {
  readonly maxOldSpaceMiB: number;
  readonly addressSpaceGiB: number;
}

/** 可直接交给 `spawn` 的命令与参数。 */
export interface Launch {
  readonly command: string;
  readonly args: readonly string[];
}

const GIB = 1024 ** 3;
/** `/tmp` 的 tmpfs 上限（F8）；与 bwrap 默认（物理内存一半）相比只是防误写。--size 必须紧挨在 --tmpfs 之前。 */
const TMPFS_BYTES = 64 * 1024 * 1024;

/** child-preload 与 child.ts 同目录；用 childPath 推导，逃逸探针也用同一份预加载（F1）。 */
function preloadPath(layout: SandboxLayout): string {
  return join(dirname(layout.childPath), 'child-preload.ts');
}

/** bwrap 自身参数；最后的命令由 `sandboxLaunch` 追加。 */
export function bwrapArgs(layout: SandboxLayout): string[] {
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--setenv',
    'TZ',
    'UTC',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib64',
    '/lib64',
    '--symlink',
    'usr/bin',
    '/bin',
    '--ro-bind',
    layout.nodePath,
    '/opt/pg/node',
    '--ro-bind',
    join(layout.repoRoot, 'packages'),
    join(layout.repoRoot, 'packages'),
    '--ro-bind',
    join(layout.repoRoot, 'node_modules'),
    join(layout.repoRoot, 'node_modules'),
    '--ro-bind',
    join(layout.repoRoot, 'package.json'),
    join(layout.repoRoot, 'package.json'),
    '--ro-bind',
    layout.blockStatesPath,
    layout.blockStatesPath,
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--size',
    String(TMPFS_BYTES),
    '--tmpfs',
    '/tmp',
    '--chdir',
    '/',
  ];
}

/**
 * node 参数（§7.2）。`--allow-fs-read` 只给仓库 packages / node_modules / package.json、
 * `/opt/pg` 与方块表文件；不给任何写、子进程、worker、addon、inspector 权限。
 * `--require` 预加载 child-preload，在 `--frozen-intrinsics` 冻结内置之前堵住 Date 后门（F1）。
 */
export function nodeArgs(layout: SandboxLayout, limits: SandboxLimits, scriptPath: string): string[] {
  return [
    '--permission',
    `--allow-fs-read=${join(layout.repoRoot, 'packages')}/`,
    `--allow-fs-read=${join(layout.repoRoot, 'node_modules')}/`,
    `--allow-fs-read=${join(layout.repoRoot, 'package.json')}`,
    '--allow-fs-read=/opt/pg/',
    `--allow-fs-read=${layout.blockStatesPath}`,
    '--disallow-code-generation-from-strings',
    '--disable-proto=throw',
    '--frozen-intrinsics',
    '--require',
    preloadPath(layout),
    `--max-old-space-size=${String(limits.maxOldSpaceMiB)}`,
    '--stack-trace-limit=16',
    '--no-warnings',
    scriptPath,
  ];
}

/** `prlimit --as` 只认字节数，不认 `8G` 单位后缀（§5.5 实测）。 */
export function addressSpaceBytes(limits: SandboxLimits): number {
  return limits.addressSpaceGiB * GIB;
}

/**
 * 组装一次 bwrap → prlimit → node 启动。`scriptArgs` 会追加在脚本路径后（逃逸探针用它选
 * 具体探针；child 不传）。`cgroupMemoryMax` 为可选 cgroup 上限（MiB，§5.5），给出时套
 * `systemd-run --user --scope`，M1 默认不启用。
 */
export function sandboxLaunch(
  layout: SandboxLayout,
  limits: SandboxLimits,
  scriptPath: string = layout.childPath,
  scriptArgs: readonly string[] = [],
  cgroupMemoryMaxMiB?: number,
): Launch {
  const inner = [
    'bwrap',
    ...bwrapArgs(layout),
    '/usr/bin/prlimit',
    `--as=${String(addressSpaceBytes(limits))}`,
    '--',
    '/opt/pg/node',
    ...nodeArgs(layout, limits, scriptPath),
    ...scriptArgs,
  ];
  if (cgroupMemoryMaxMiB === undefined) return { command: inner[0] ?? 'bwrap', args: inner.slice(1) };
  return {
    command: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '-p',
      `MemoryMax=${String(cgroupMemoryMaxMiB)}M`,
      '-p',
      'MemorySwapMax=0',
      '--',
      ...inner,
    ],
  };
}
