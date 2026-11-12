/**
 * `agent:massing` 的真实依赖组装辅助（M5b，决策 #112）。
 *
 * 负责：读 world.d.ts、算体素分支的 ExternalVersions（git 快照 + world API / world.d.ts / 分析版本）、
 *   按题面路径算 runId、离线 token 近似的纯计算，以及环境变量只收紧 `--max-cny` 的薄封装。
 * 不负责：参数解析（agent-massing-args.ts）、模型来源与主循环接线（agent-massing.ts）、
 *   隔离执行 / 渲染（入口注入 real 实现）。
 *
 * 与 `packages/agent/src/cli-deps.ts` 同口径：该模块未在 `@pg/agent` 的 exports 里，
 * 故此处保留一份（改一处要同步另一处）；只保留本入口用得到的小函数，不复用 runner。
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExternalVersions } from '@pg/agent/runner';
import { API_VERSION } from '@pg/geometry';
import { sandboxVersion } from '@pg/sandbox/run';
import type { RunLimits } from '@pg/store/events';
import type { RunWriter } from '@pg/store/run-dir';

import { sha256Hex } from './model-agent-deps.ts';
import type { GitSnapshot } from './model-agent-deps.ts';
import { tightenCost } from './model-agent-live.ts';

const encoder = new TextEncoder();

/** `@pg/geometry/world.d.ts` 全文（体素 target 的 system 提示与版本 hash 都用它）。 */
export function loadWorldDts(): string {
  return readFileSync(fileURLToPath(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');
}

/** analysis 版本 = 非测试源文件按路径排序后（路径 + 内容）的 sha256（MODEL-SPEC §7.5）。 */
export function analysisVersion(): string {
  const entry = fileURLToPath(import.meta.resolve('@pg/analysis/floating'));
  const dir = dirname(entry);
  const hash = createHash('sha256');
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()) {
    hash
      .update(name)
      .update('\u0000')
      .update(readFileSync(join(dir, name)));
  }
  return hash.digest('hex');
}

/** 题目短名：取文件名、转小写 slug，跑不进 runId 就退回 adhoc（MODEL-SPEC §7.1）。 */
export function taskShortName(taskPath: string): string {
  const slug = basename(taskPath)
    .replace(/\.(md|markdown)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug === '' ? 'adhoc' : slug;
}

/** runId = `<UTC yyyyMMdd-HHmmss>-<题目短名>-<6 位十六进制>`（MODEL-SPEC §7.1）。 */
export function massingRunId(taskPath: string, date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
  return `${stamp}-${taskShortName(taskPath)}-${randomBytes(3).toString('hex')}`;
}

/** 体素分支的 ExternalVersions 具体类型（`Extract` 出带 `worldApi` 的那一支，便于测试逐项断言）。 */
export type VoxelExternalVersions = Extract<ExternalVersions, { readonly worldApi: number }>;

/**
 * 体素分支的 ExternalVersions（`run.start` 用）。git 的 dirty diff 在这里进 blob，得到真实 Ref；
 * worldDts / analysis 与 `cli-deps.ts` 的 `computeVersions` 同口径，保证事件流可比。
 */
export function voxelExternalVersions(
  store: RunWriter,
  precheck: string,
  git: GitSnapshot,
  worldDts: string,
): VoxelExternalVersions {
  return {
    git: { commit: git.commit, dirty: git.dirty, diff: git.diff === null ? null : store.putBlob(git.diff) },
    node: process.version,
    worldApi: API_VERSION,
    worldDts: sha256Hex(worldDts),
    precheck,
    sandbox: sandboxVersion(),
    // @pg/core/archive 的 FORMAT_VERSION（archive.ts:15），未导出，版本变化时同步这里。
    archiveFormat: 1,
    analysis: analysisVersion(),
  };
}

/**
 * 离线 token 计数的近似（AGENT-SPEC §3.1 的 `tokensOffline`）：UTF-8 字节数 ÷ 3 向上取整。
 * 只写进事件供人看，不参与预留与计费；精确计数（评分卡）在 tools/tokens.ts，agent 层不能 import tools。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / 3);
}

/**
 * `PG_MAX_RUN_COST_CNY` 只能收紧 `--max-cny`，不能放宽：live 组装 limits 时用它；
 * mock 不读 env，不调用本函数。语义与 `@pg/agent/cli-args` 的 `tightenLimits` 一致。
 */
export function effectiveRunLimits(limits: RunLimits, envMaxCny: number | undefined): RunLimits {
  return tightenCost(limits, envMaxCny);
}
