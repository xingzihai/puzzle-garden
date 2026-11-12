/**
 * 体素化内核的可预期失败分类（MASSING-CONVERSION-SPEC §2）。
 *
 * 负责：VoxelizeError 类（`code` + 面向模型作者的中文 `message`），供 voxelize 与后续
 * world.massingImport（§5–§7）共用同一套失败语义；错误码是封闭联合，新增码要同步规格表。
 * 不负责：文档 / 选项的 schema 定义（schema.ts、voxelize.ts）、I/O 与日志。
 */

/**
 * 错误码：
 * - `document-invalid`：二次校验失败（NaN/Infinity、重复 id、超上限、退化三角、material 空串等）。
 * - `options-invalid`：mode/thickness 非法、overrides 指向不存在的部件、thickness 与 solid 同传等。
 * - `material-none`：默认材质映射没有任何候选方块（内核不触发，留给 @pg/geometry 的映射层）。
 * - `limit-exceeded`：单次导入格数超过 MAX_IMPORT_CELLS。
 */
export type VoxelizeErrorCode = 'document-invalid' | 'options-invalid' | 'material-none' | 'limit-exceeded';

/** 体素化的可预期失败；`code` 供调用方分支处理，`message` 给模型作者看。 */
export class VoxelizeError extends Error {
  readonly code: VoxelizeErrorCode;

  constructor(code: VoxelizeErrorCode, message: string) {
    super(message);
    this.name = 'VoxelizeError';
    this.code = code;
  }
}
