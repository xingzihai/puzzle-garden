/**
 * 参数化壳构件（SURFACE-SHELL-SPEC，M3 B 组）：建造代码写公式，构件内部采样 → 变换 → 体素化 → 一次 commit。
 *
 * 负责：选项解析与函数字段检查、材质解析、采样（@pg/modeling/parametric）、Part 网格校验（含 float32 口径）、
 * 调用体素化内核、交给 voxel-place 做放置 / 越界检查与整次一次 commit（结构层 body、单部件、
 * 来源 api=surfaceShell），返回最小句柄（bounds / cellCount / leaky）。
 * 不负责：采样数学（@pg/modeling/parametric）、体素化算法（@pg/modeling/voxelize）、
 * 放置与登记（voxel-place.ts）、资产通道（massing-import.ts）。
 */
import type { BlockState } from '@pg/core/block-state';
import { ModelError, formatIssues } from '@pg/modeling/errors';
import { sampleRevolve, sampleSurface } from '@pg/modeling/parametric';
import { Part } from '@pg/modeling/schema';
import { MAX_IMPORT_CELLS, VoxelizeError, voxelize } from '@pg/modeling/voxelize';
import type { VoxelResult } from '@pg/modeling/voxelize';
import type { z } from 'zod';

import { MassingError, massingCodeFromVoxelize } from './massing-error.ts';
import { parseSurfaceShellOptions } from './schema.ts';
import type { surfaceShellSchema } from './schema.ts';
import { placeVoxelParts, showCell } from './voxel-place.ts';
import type { Writer } from './writer.ts';
import type { World } from './world-types.ts';

/** 合成部件的占位色：壳的材质必填、不走颜色映射，色值只为满足 Part schema。 */
const PART_COLOR = '#8899aa';
/** 内部部件 id：一次调用只登记一个部件，存档里的显示名来自 options.name。 */
const PART_ID = 'shell';
const DEFAULT_NAME = 'surfaceShell';

/** 采样 / 网格校验失败的可行动文案（SURFACE-SHELL-SPEC §6）。 */
function geometryInvalid(message: string): MassingError {
  return new MassingError(
    'geometry-invalid',
    `surfaceShell 的曲面网格不合法：${message}。请修正 position / profile 的采样值或段数`,
  );
}

/** 构造 `world.surfaceShell`：一个构件覆盖参数曲面与旋转壳，内部复用体素化内核与放置语义。 */
export function createSurfaceShell(writer: Writer): { readonly surfaceShell: World['surfaceShell'] } {
  const surfaceShell: World['surfaceShell'] = (input) => {
    let options: z.output<typeof surfaceShellSchema>;
    try {
      options = parseSurfaceShellOptions(input);
    } catch (error) {
      throw new MassingError(
        'options-invalid',
        `surfaceShell 选项不合法：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // schema 里 position / profile 记为 unknown（函数不进 schema），运行期在这里做 typeof 检查。
    const fn = options.kind === 'surface' ? options.position : options.profile;
    if (typeof fn !== 'function') {
      throw new MassingError(
        'options-invalid',
        options.kind === 'surface'
          ? `surfaceShell 选项不合法：kind:'surface' 需要 position(u, v) 函数，实际是 ${typeof options.position}`
          : `surfaceShell 选项不合法：kind:'revolve' 需要 profile(t) 函数，实际是 ${typeof options.profile}`,
      );
    }
    if (options.solid && options.thickness !== undefined) {
      throw new MassingError(
        'options-invalid',
        `surfaceShell 选项不合法：solid:true 与 thickness=${String(options.thickness)} 不能同传；thickness 只用于壳`,
      );
    }
    let material: BlockState;
    try {
      material = writer.material(options.material, true);
    } catch (error) {
      throw new MassingError(
        'material-invalid',
        `surfaceShell 的材质 ${JSON.stringify(options.material)} 不合法：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let part: z.output<typeof Part>;
    try {
      const sampled =
        options.kind === 'surface'
          ? sampleSurface({
              position: options.position,
              uSegments: options.uSegments,
              vSegments: options.vSegments,
              closedU: options.closedU,
              ...(options.transform === undefined ? {} : { transform: options.transform }),
            })
          : sampleRevolve({
              profile: options.profile,
              profileSegments: options.profileSegments,
              radialSegments: options.radialSegments,
              ...(options.transform === undefined ? {} : { transform: options.transform }),
            });
      const parsed = Part.safeParse({
        id: PART_ID,
        name: options.name ?? DEFAULT_NAME,
        role: options.solid ? 'volume' : 'roof',
        color: PART_COLOR,
        material: options.material,
        positions: sampled.positions,
        indices: sampled.indices,
        bounds: sampled.bounds,
        source:
          options.kind === 'surface'
            ? { operation: 'surface', parameters: sampled.parameters }
            : { operation: 'revolve', parameters: sampled.parameters },
      });
      if (!parsed.success) throw geometryInvalid(formatIssues(parsed.error.issues));
      part = parsed.data;
    } catch (error) {
      if (error instanceof MassingError) throw error;
      if (error instanceof ModelError) throw geometryInvalid(error.message);
      throw error;
    }
    let result: VoxelResult;
    try {
      result = voxelize(
        { version: 2, parts: [part] },
        {
          mode: options.solid ? 'solid' : 'shell',
          ...(options.thickness === undefined ? {} : { thickness: options.thickness }),
          ...(options.cleanup === undefined ? {} : { cleanup: options.cleanup }),
        },
      );
    } catch (error) {
      if (error instanceof VoxelizeError) {
        if (error.code === 'limit-exceeded')
          throw new MassingError(
            'limit-exceeded',
            `surfaceShell 写入的格数超过单次上限 ${String(MAX_IMPORT_CELLS)}；请减少采样段数或改小尺寸`,
          );
        if (error.code === 'document-invalid') throw geometryInvalid(error.message);
        throw new MassingError(massingCodeFromVoxelize(error.code), error.message);
      }
      throw error;
    }
    const placement = placeVoxelParts(writer, {
      api: 'surfaceShell',
      args: {
        kind: options.kind,
        ...(options.kind === 'surface'
          ? { uSegments: options.uSegments, vSegments: options.vSegments, closedU: options.closedU }
          : { profileSegments: options.profileSegments, radialSegments: options.radialSegments }),
        at: options.at,
        rotate: options.rotate,
        solid: options.solid,
        ...(options.thickness === undefined ? {} : { thickness: options.thickness }),
        ...(options.transform === undefined ? {} : { transform: options.transform }),
        material: options.material,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.cleanup === undefined ? {} : { cleanup: options.cleanup }),
      },
      result,
      at: options.at,
      rotate: options.rotate,
      stateForPart: () => material,
      messages: {
        belowGround: (_partId, cell) =>
          `surfaceShell 的部件 ${options.name ?? DEFAULT_NAME} 有格落在 y<1（最低格 ${showCell(cell)}）：请把 at.y 抬高或去掉地下部分`,
        outOfRange: (cell) =>
          `surfaceShell 有格超出世界坐标范围（最小越界格 ${showCell(cell)}）：请调整 at / rotate 或尺寸`,
      },
      emptyError: new MassingError(
        'empty-shell',
        'surfaceShell 没有生成任何格：请检查 position / profile 是否退化、采样段数是否过小',
      ),
    });
    return Object.freeze({
      bounds: placement.bounds,
      cellCount: placement.counts.cells,
      leaky: placement.counts.leakyParts > 0,
    });
  };
  return { surfaceShell };
}
