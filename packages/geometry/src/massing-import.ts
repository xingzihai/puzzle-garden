/**
 * 草模导入构件（MASSING-CONVERSION-SPEC §5–§7，M1b2）：把宿主注入的草模文档体素化并并入当前建筑。
 *
 * 负责：资产取用与 ModelDocument 二次校验、选项校验、调用体素化内核并把 VoxelizeError 映射成 MassingError、
 * 按 §7 解析每部件材质、交给 voxel-place 做 §6 放置 / 旋转与 y<1 / 越界检查及整次一次 commit，返回句柄。
 * 不负责：体素化算法（@pg/modeling/voxelize）、放置与登记（voxel-place.ts）、默认材质池（massing-material.ts）、
 * 资产通道与 I/O（沙箱）。
 */
import type { MassingColorCandidate } from '@pg/blocks/color';
import type { BlockState } from '@pg/core/block-state';
import { formatIssues } from '@pg/modeling/errors';
import { ModelDocument } from '@pg/modeling/schema';
import { VoxelizeError, voxelize } from '@pg/modeling/voxelize';
import type { VoxelPart, VoxelResult } from '@pg/modeling/voxelize';
import type { z } from 'zod';

import { MassingError, massingCodeFromVoxelize } from './massing-error.ts';
import { resolveMassingMaterial } from './massing-material.ts';
import { massingImportSchema, parse } from './schema.ts';
import { placeVoxelParts, showCell } from './voxel-place.ts';
import type { Writer } from './writer.ts';
import type { MassingHandle, World } from './world-types.ts';

/** 宿主注入的一份草模文档；document 会先按 ModelDocument 二次校验，非法输入响亮报错。 */
export interface MassingDocument {
  readonly id: string;
  readonly document: z.output<typeof ModelDocument>;
}
/** createWorld 的可选 massing 宿主注入（MASSING-CONVERSION-SPEC §5.2 的资产通道字段）。 */
export interface MassingAssets {
  readonly documents: readonly MassingDocument[];
  readonly colorCandidates: readonly MassingColorCandidate[];
}
export interface WorldOptions {
  readonly callSite?: () => number;
  readonly massing?: MassingAssets;
}

/**
 * 构造 `world.massingImport`：注入文档在创建世界时按 ModelDocument 二次校验，非法输入直接抛 document-invalid
 * （不静默跳过）；未注入时不持有任何文档，按 id 取用一律 `asset-missing`。
 */
export function createMassingImport(
  writer: Writer,
  assets: MassingAssets | undefined,
): { readonly massingImport: World['massingImport'] } {
  const documents = new Map<string, z.output<typeof ModelDocument>>();
  for (const entry of assets?.documents ?? []) {
    const parsed = ModelDocument.safeParse(entry.document);
    if (!parsed.success) {
      throw new MassingError(
        'document-invalid',
        `注入的草模资产 ${entry.id} 不合 ModelDocument 校验：${formatIssues(parsed.error.issues)}。` +
          '请回到草模子运行修正后再注入',
      );
    }
    if (documents.has(entry.id)) {
      throw new MassingError('document-invalid', `注入的草模资产 id 重复：${entry.id}；每个文档 id 必须唯一`);
    }
    documents.set(entry.id, parsed.data);
  }
  const candidates = assets?.colorCandidates ?? [];

  /** 显式材质（materials / material / 部件 material）与默认映射都经 writer.material 校验，未知方块保留拼写建议。 */
  const materialState = (part: VoxelPart, options: z.output<typeof massingImportSchema>): BlockState => {
    const explicit = options.materials?.[part.id] ?? options.material ?? part.material;
    const text = explicit ?? resolveMassingMaterial(part.role, part.color, candidates).id;
    try {
      return writer.material(text, true);
    } catch (error) {
      throw new MassingError(
        'material-invalid',
        `部件 ${part.id} 的材质 ${JSON.stringify(text)} 不合法：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const massingImport: World['massingImport'] = (id, input) => {
    const document = documents.get(id);
    if (document === undefined) {
      throw new MassingError(
        'asset-missing',
        `找不到草模资产 ${id}：请让 massing 工具先登记该文档 id，再在模型代码里导入`,
      );
    }
    const ids = document.parts.map((part) => part.id);
    const idList = `[${ids.join(', ')}]`;
    let options: z.output<typeof massingImportSchema>;
    try {
      options = parse(massingImportSchema, input ?? {});
    } catch (error) {
      throw new MassingError(
        'options-invalid',
        `massingImport 选项不合法：${error instanceof Error ? error.message : String(error)}；文档部件 id 有 ${idList}`,
      );
    }
    for (const partId of Object.keys(options.materials ?? {})) {
      if (!ids.includes(partId)) {
        throw new MassingError(
          'options-invalid',
          `massingImport 选项不合法：materials 含不存在的部件 id ${partId}；文档部件 id 有 ${idList}`,
        );
      }
    }
    let result: VoxelResult;
    try {
      result = voxelize(document, {
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.thickness === undefined ? {} : { thickness: options.thickness }),
        ...(options.cleanup === undefined ? {} : { cleanup: options.cleanup }),
      });
    } catch (error) {
      if (error instanceof VoxelizeError) throw new MassingError(massingCodeFromVoxelize(error.code), error.message);
      throw error;
    }
    const placement = placeVoxelParts(writer, {
      api: 'massingImport',
      args: {
        id,
        at: options.at,
        rotate: options.rotate,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.thickness === undefined ? {} : { thickness: options.thickness }),
        ...(options.material === undefined ? {} : { material: options.material }),
        ...(options.materials === undefined ? {} : { materials: options.materials }),
        ...(options.cleanup === undefined ? {} : { cleanup: options.cleanup }),
      },
      result,
      at: options.at,
      rotate: options.rotate,
      stateForPart: (part) => materialState(part, options),
      messages: {
        belowGround: (partId, cell) =>
          `草模资产 ${id} 的部件 ${partId} 有格落在 y<1（最低格 ${showCell(cell)}）：请把 at.y 抬高或去掉地下部分`,
        outOfRange: (cell) =>
          `草模资产 ${id} 导入后有格超出世界坐标范围（最小越界格 ${showCell(cell)}）：请调整 at / rotate 或草模尺寸`,
      },
      emptyError: new MassingError('empty-import', `草模资产 ${id} 没有可写入的格：请先让草模产出非空几何再导入`),
    });
    const handle: MassingHandle = Object.freeze({
      bounds: placement.bounds,
      parts: placement.parts,
      counts: placement.counts,
    });
    return handle;
  };

  return { massingImport };
}
