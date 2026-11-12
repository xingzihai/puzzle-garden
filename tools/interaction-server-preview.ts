/**
 * 网页会话的 SVG 预览落盘：渲染 bundle、写 preview/、按文件回报进度。
 *
 * 负责：preview 目录、文件事件、previews 元数据；不负责会话状态机 / HTTP。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renderPreviewBundle } from '@pg/interaction/preview';
import type { DesignScheme } from '@pg/interaction/schema';
import { sessionDir } from '@pg/interaction/store';

import type { WebPreview } from './interaction-server-contract.ts';

export interface PreviewWriteInput {
  readonly id: string;
  readonly root: string;
  readonly scheme: DesignScheme;
  readonly onStage: (status: 'start' | 'done' | 'error', detail?: string) => void;
  readonly onFile: (path: string, bytes: number) => void;
}

/** 写出一个 revision 的全部预览；失败时先回报 error，再把原始错误抛给会话层。 */
export async function writePreviewBundle(input: PreviewWriteInput): Promise<readonly WebPreview[]> {
  input.onStage('start', '渲染方案草图');
  try {
    const bundle = renderPreviewBundle(input.scheme);
    const dir = join(sessionDir(input.id, { root: input.root }), 'preview');
    await mkdir(dir, { recursive: true });
    for (const file of bundle.files) {
      await writeFile(join(dir, file.name), file.svg, 'utf8');
      input.onFile(`preview/${file.name}`, Buffer.byteLength(file.svg));
    }
    await writeFile(join(dir, 'index.html'), bundle.indexHtml, 'utf8');
    input.onStage('done', `${String(bundle.files.length)} 张`);
    return bundle.files.map((file) => ({
      name: file.name,
      title: file.title,
      url: `/api/sessions/${input.id}/preview/${file.name}`,
    }));
  } catch (error) {
    input.onStage('error', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
