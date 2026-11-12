/**
 * 服务重启后的已确认会话恢复：从 `.work/sessions/web/<id>/session.json` 重建网页会话。
 *
 * 负责：只恢复 stage=compile、有 confirmedDesignRevision 与完整 artifacts 的会话；重写预览 SVG。
 * 不负责：恢复进行中的对话 / 待回答 / 待确认状态（这些需要重新走会话，避免重启后假装还能继续）。
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renderPreviewBundle } from '@pg/interaction/preview';
import { loadSession, sessionDir } from '@pg/interaction/store';
import type { ArtifactPaths } from '@pg/interaction/store';
import type { SessionState } from '@pg/interaction/session';

import type { WebBriefStats, WebMessage, WebPreview, WebSummary } from './interaction-server-session.ts';
import { briefStats, sectionSummary } from './interaction-server-summary.ts';

export interface RestoredSession {
  readonly state: SessionState;
  readonly brief: string;
  readonly messages: readonly WebMessage[];
  readonly summary: WebSummary;
  readonly previews: readonly WebPreview[];
  readonly briefStats: WebBriefStats;
  readonly artifacts: ArtifactPaths;
}

function artifactPaths(dir: string): ArtifactPaths {
  const designIntent = join(dir, 'design-intent.json');
  return {
    sessionDir: dir,
    design: join(dir, 'design.md'),
    task: join(dir, 'build-task.md'),
    spec: join(dir, 'build-spec.json'),
    gates: join(dir, 'gates.json'),
    promptMeta: join(dir, 'prompt-meta.json'),
    ...(existsSync(designIntent) ? { designIntent } : {}),
  };
}

/** 恢复一个已确认会话；文件缺失、状态不完整或方案损坏时返回 null。 */
export async function restoreConfirmedSession(id: string, root: string): Promise<RestoredSession | null> {
  try {
    const state = await loadSession(id, { root });
    const brief = state?.brief ?? null;
    if (state === null || brief === null) return null;
    if (state.stage !== 'compile' || state.confirmedDesignRevision === null) return null;
    const scheme =
      state.designs.find((design) => design.meta.revision === state.confirmedDesignRevision) ?? state.designs.at(-1);
    if (scheme === undefined) return null;

    const dir = sessionDir(id, { root });
    const artifacts = artifactPaths(dir);
    if (![artifacts.design, artifacts.task, artifacts.spec, artifacts.gates].every((path) => existsSync(path))) {
      return null;
    }

    const bundle = renderPreviewBundle(scheme);
    const previewDir = join(dir, 'preview');
    await mkdir(previewDir, { recursive: true });
    await Promise.all(bundle.files.map((file) => writeFile(join(previewDir, file.name), file.svg, 'utf8')));
    await writeFile(join(previewDir, 'index.html'), bundle.indexHtml, 'utf8');
    const previews = bundle.files.map((file) => ({
      name: file.name,
      title: file.title,
      url: `/api/sessions/${id}/preview/${file.name}`,
    }));

    const briefEvent = state.events.find((event) => event.type === 'user.message');
    const messages: WebMessage[] = [{ role: 'system', text: '服务重启：已从磁盘恢复已确认会话。' }];
    if (briefEvent?.type === 'user.message') messages.push({ role: 'user', text: briefEvent.text });

    return {
      state,
      brief: briefEvent?.type === 'user.message' ? briefEvent.text : (state.requirements?.summary ?? '（已恢复）'),
      messages,
      summary: sectionSummary(state, scheme),
      previews,
      briefStats: briefStats(brief),
      artifacts,
    };
  } catch {
    return null;
  }
}
