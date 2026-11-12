/**
 * 体素构件层（world.massingImport 的资产通道与 world.surfaceShell 的参数化壳）的可预期失败分类
 * （MASSING-CONVERSION-SPEC §2、§5–§7；SURFACE-SHELL-SPEC §6）。
 *
 * 负责：MassingError 类（封闭 `code` + 面向模型作者的中文可行动 `message`），以及把体素化内核的
 * VoxelizeError code 映射为等价 MassingError code 的辅助函数（`material-none` → `material-missing`）。
 * 不负责：文档 / 选项的 schema 定义、I/O 与日志；不杀主循环（由调用方把错误转成工具文本）。
 */

import type { VoxelizeErrorCode } from '@pg/modeling/voxelize';

/**
 * 体素构件错误码：
 * - `asset-missing`：按 id 找不到宿主注入的草模文档（仅 massingImport）。
 * - `assets-too-large`：注入的资产超过大小 / 份数上限（仅 massingImport）。
 * - `out-of-range`：世界格超出 core 范围。
 * - `below-ground`：任一世界格 y < 1（在构件层整次拒绝，不裁剪、不下沉）。
 * - `empty-import`：导入文档没有任何可写入的格。
 * - `empty-shell`：参数化壳采样后没有任何可写入的格（SURFACE-SHELL-SPEC §3）。
 * - `material-missing`：需要默认材质但候选表为空（内核保留码 `material-none` 的构件层等价码）。
 * - `material-invalid`：显式材质未知、空气或色值不是 `#rrggbb`。
 * - `document-invalid`：文档二次校验失败。
 * - `geometry-invalid`：position / profile 抛错或返回非法值、采样网格退化（含 float32 口径，SURFACE-SHELL-SPEC §6）。
 * - `options-invalid`：构件选项非法。
 * - `limit-exceeded`：单次调用格数超过 MAX_IMPORT_CELLS。
 */
export type MassingErrorCode =
  | 'asset-missing'
  | 'assets-too-large'
  | 'out-of-range'
  | 'below-ground'
  | 'empty-import'
  | 'empty-shell'
  | 'material-missing'
  | 'material-invalid'
  | 'document-invalid'
  | 'geometry-invalid'
  | 'options-invalid'
  | 'limit-exceeded';

/** 每个错误码的缺省中文可行动文案；调用方可在抛出时覆盖成更具体的说明。 */
const DEFAULT_MESSAGES: Readonly<Record<MassingErrorCode, string>> = {
  'asset-missing': '找不到草模资产：请让 massing 工具先登记该文档 id，再在模型代码里导入',
  'assets-too-large': '注入的草模资产过大：请减少文档份数或总大小后重试',
  'out-of-range': '导入后存在超出世界坐标范围的格：请调整 at / rotate 或草模尺寸',
  'below-ground': '导入后存在 y<1 的格（地表以下）：请把 at.y 抬高或去掉地下部分',
  'empty-import': '草模文档没有可写入的格：请先让草模产出非空几何再导入',
  'empty-shell': '参数化壳没有生成任何格：请检查 position / profile 是否退化、采样段数是否过小',
  'material-missing': '没有可用于默认材质的方块候选：宿主注入的方块颜色表为空，请检查资产通道',
  'material-invalid': '材质不合法：请给出方块名（可带状态）或小写 #rrggbb 色值',
  'document-invalid': '草模文档不合 ModelDocument 校验：请回到草模子运行修正后重新导入',
  'geometry-invalid': '参数化壳的曲面网格不合法：请修正 position / profile 的采样值或段数',
  'options-invalid': 'massingImport 选项不合法：请检查 mode / thickness / overrides 等参数',
  'limit-exceeded': '导入格数超过单次上限：请减少采样段数、拆分部件或分次导入',
};

/** 导入层的可预期失败；`code` 供调用方分支处理，`message` 给模型作者看。 */
export class MassingError extends Error {
  readonly code: MassingErrorCode;

  constructor(code: MassingErrorCode, message: string = DEFAULT_MESSAGES[code]) {
    super(message);
    this.name = 'MassingError';
    this.code = code;
  }
}

/**
 * 把体素化内核的 VoxelizeError code 映射为等价 MassingError code：
 * `material-none` → `material-missing`（内核保留码，导入层统一用后者），其余同名。
 */
export function massingCodeFromVoxelize(code: VoxelizeErrorCode): MassingErrorCode {
  switch (code) {
    case 'document-invalid':
      return 'document-invalid';
    case 'options-invalid':
      return 'options-invalid';
    case 'material-none':
      return 'material-missing';
    case 'limit-exceeded':
      return 'limit-exceeded';
  }
}
