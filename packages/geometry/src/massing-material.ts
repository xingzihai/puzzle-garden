/**
 * 草模导入的默认材质映射（MASSING-CONVERSION-SPEC §7，M1b1）：按部件 role 的材质族池取最近色。
 *
 * 负责：色值校验、按 role 选池、池内无候选回退全体、仍为空报 `material-missing`，并调用
 * `@pg/blocks/color` 的最近色。不负责：显式材质优先级（options.materials / material / 部件 material，
 * 由 world.massingImport 处理）、写方块（writer.ts）。
 * 纯函数、确定性，无 I/O 与 locale；层级同层（geometry → blocks / modeling）。
 */

import { COLOR_PATTERN } from '@pg/modeling/schema';
import type { Role } from '@pg/modeling/schema';

import { nearestColorBlock } from '@pg/blocks/color';
import type { MassingColorCandidate } from '@pg/blocks/color';
import type { Family } from '@pg/blocks/registry';

import { MassingError } from './massing-error.ts';

/**
 * role → 材质族池（MASSING-CONVERSION-SPEC §7，family 名取自 blocks 注册表的 FAMILIES）。
 * 未知 role 不可达：Role 只可能是四个枚举值，其它值在文档校验阶段归 `document-invalid`。
 */
const ROLE_FAMILIES: Readonly<Record<Role, readonly Family[]>> = {
  volume: ['stone', 'deepslate', 'blackstone', 'terracotta', 'concrete', 'quartz', 'sand', 'soil'],
  roof: ['wood', 'terracotta', 'concrete', 'quartz', 'stone', 'sand'],
  floor: ['stone', 'quartz', 'sand', 'wood', 'terracotta', 'concrete'],
  connection: ['wood', 'stone', 'concrete', 'sand', 'quartz'],
};

/**
 * 按 role 的材质族池取与 `color` 最近的候选：池内无候选则回退全体候选；仍为空报 `material-missing`。
 * `color` 只接受严格小写的 `#rrggbb`，否则报 `material-invalid`。
 */
export function resolveMassingMaterial(
  role: Role,
  color: string,
  candidates: readonly MassingColorCandidate[],
): MassingColorCandidate {
  if (!COLOR_PATTERN.test(color)) {
    throw new MassingError(
      'material-invalid',
      `色值 "${color}" 不合法：必须是小写 #rrggbb（6 位十六进制），请修正草模部件的 color`,
    );
  }
  const rgb = Number.parseInt(color.slice(1), 16);
  const families = ROLE_FAMILIES[role];
  const pool = candidates.filter((candidate) => families.includes(candidate.family));
  const effective = pool.length > 0 ? pool : candidates;
  if (effective.length === 0) {
    throw new MassingError(
      'material-missing',
      `没有可用于 ${role} 默认材质的方块候选：宿主注入的方块颜色表为空，请检查资产通道`,
    );
  }
  return nearestColorBlock(rgb, effective);
}
