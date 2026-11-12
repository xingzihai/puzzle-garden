/**
 * 体素坐标：校验范围、换算区块坐标、打包区块键（docs/CORE-SPEC.md §2），以及全包共用的 CoreError。
 *
 * 负责：判断一个坐标能不能进网格，并把区块坐标压成一个安全整数作为 Map 键。
 * 不负责：区块内部的存储布局（见 grid.ts）。
 */

/** core 里所有可预期错误的类别。调用方按 code 分支，message 给人（和模型）看。 */
export type CoreErrorCode =
  | 'invalid-coord'
  | 'invalid-block-table'
  | 'invalid-state-syntax'
  | 'unknown-block'
  | 'unknown-property'
  | 'invalid-property-value'
  | 'invalid-argument'
  | 'unknown-part'
  | 'unknown-call'
  | 'invalid-archive';

export class CoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

/** x、z 的范围 [−2²⁵, 2²⁵)：覆盖 MC 世界边界 ±3×10⁷。 */
export const XZ_MIN = -(2 ** 25);
export const XZ_MAX = 2 ** 25 - 1;
/** y 的范围 [−2048, 2048)：远超 MC 1.20.1 的 [−64, 320)，导出时再裁。 */
export const Y_MIN = -2048;
export const Y_MAX = 2047;

const CX_OFFSET = 2 ** 21;
const CY_OFFSET = 128;

function checkAxis(axis: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new CoreError('invalid-coord', `坐标 ${axis} 必须是整数，实际是 ${String(value)}（不会自动取整）`);
  }
  if (value < min || value > max) {
    throw new CoreError(
      'invalid-coord',
      `坐标 ${axis}=${String(value)} 越界，合法范围 [${String(min)}, ${String(max)}]`,
    );
  }
}

/** 坐标不合法（非整数或越界）时抛 `invalid-coord`。 */
export function checkCoord(x: number, y: number, z: number): void {
  checkAxis('x', x, XZ_MIN, XZ_MAX);
  checkAxis('y', y, Y_MIN, Y_MAX);
  checkAxis('z', z, XZ_MIN, XZ_MAX);
}

/** 坐标所在区块的坐标：`Math.floor(v / 16)`。调用方需先 {@link checkCoord}。 */
export function chunkCoord(v: number): number {
  return Math.floor(v / 16);
}

/**
 * 区块键：`((cx + 2²¹) · 2⁸ + (cy + 128)) · 2²² + (cz + 2²¹)`，52 位安全整数。
 * 用乘法而不是位运算：JS 位运算只有 32 位。参数必须是合法坐标换算出的区块坐标。
 */
export function chunkKey(cx: number, cy: number, cz: number): number {
  return ((cx + CX_OFFSET) * 256 + (cy + CY_OFFSET)) * 2 ** 22 + (cz + CX_OFFSET);
}
