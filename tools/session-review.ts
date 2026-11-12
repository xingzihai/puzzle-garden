/**
 * CLI 构建后的会话评审落盘：同一 confirmed revision 上的新 run 直接取代旧 review。
 *
 * 负责：读 session.json（保留旧 review 作 stale 历史）、走 adoptBuildReview 状态迁移、原子保存。
 * 不负责：生成评审 / 证据（run-review.ts）或 HTTP 会话（interaction-server-session.ts）。
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { ReviewReport } from '@pg/interaction/review';
import { reduceSession } from '@pg/interaction/session';
import { loadSessionForReviewRevalidation, saveSession } from '@pg/interaction/store';

/** 成功把新评审写进 session；会话不存在 / 阶段不兼容 / revision 不匹配时返回 false。 */
export async function adoptRunReviewIntoSession(sessionDir: string, report: ReviewReport): Promise<boolean> {
  if (!existsSync(join(sessionDir, 'session.json'))) return false;
  const id = basename(sessionDir);
  const root = dirname(sessionDir);
  try {
    // 旧 review 只作为 stale 历史；这里不做 accept 重验，新报告本身由 run 证据生成。
    const state = await loadSessionForReviewRevalidation(id, () => true, { root });
    if (state === null) return false;
    const next = reduceSession(state, {
      kind: 'adoptBuildReview',
      runId: report.buildRunId,
      report,
      replacesRunId: state.build?.runId ?? null,
    });
    await saveSession(next, { root });
    return true;
  } catch {
    return false;
  }
}
