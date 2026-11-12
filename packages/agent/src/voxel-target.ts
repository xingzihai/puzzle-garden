/** 体素工具到共享 runner 的适配；保留既有工具行为、提示和事实格式，不实现第二个请求循环。 */
import { colorCandidates } from '@pg/blocks/color';
import type { MassingColorCandidate } from '@pg/blocks/color';
import type { PromptVersion } from '@pg/config';

import type { DiffReport } from '@pg/analysis/object-diff';

import {
  DEGENERATE_NOTICE,
  FACTS_FORMAT_VERSION,
  formatFacts,
  NO_TOOL_NOTICE,
  WINDOW_TOOLS,
  windowNotice,
} from './facts.ts';
import { systemPrompt } from './prompt/system.ts';
import type { RunnerDeps, RunnerInput, TargetRunnerDeps } from './runner.ts';
import {
  countsFromReport,
  failureFingerprint,
  formatStateCard,
  mustEvidenceFrom,
  nextActions,
  parseBuildSheetFacts,
  parseFurnitureCounts,
} from './state-card.ts';
import type { FailureFingerprint, StateCounts } from './state-card.ts';
import type { RunnerTarget, TargetContext, TargetSession } from './target.ts';
import { toolDefs } from './tools/schemas.ts';
import type { ViewImage } from './tools/view.ts';
import { deliver, draftVersion, initialToolState, runToolCalls, sha256Hex } from './turn-tools.ts';
import type { ToolContext, TurnTools } from './turn-tools.ts';

/** 图片计数与窗口状态的纯数据部分；同步时只搬这三个字段，预算方法留在 runner 的对象上。 */
interface BudgetCounters {
  imageBytes: number;
  images: number;
  inWindow: boolean;
}

/**
 * fixed 生产入口附加在 RunnerInput 上的提示版本（W11-06a）。
 * `runner.ts` 不在本任务所有权内，且 `run.start.config` 是 strict schema；因此版本只作为
 * 适配层可选字段承载，不进 `input.config`，也不改变旧调用方的请求形状。
 */
export interface PromptVersionedRunnerInput extends RunnerInput {
  readonly promptVersion?: PromptVersion;
}

/** 与 check.ts 的空报告判定一致：有期望对象时，空报告不能当 canonical 证据。 */
function isEmptyConformanceReport(report: DiffReport): boolean {
  const { pass, fail, missing, extra, unverified } = report.summary;
  return report.items.length === 0 && pass + fail + missing + extra + unverified === 0;
}

/** 可省略 target 的旧调用方仍走体素；草模调用方无需提供 check/render/worldDts。 */
export function resolveTarget(
  input: PromptVersionedRunnerInput,
  deps: RunnerDeps | TargetRunnerDeps,
): Omit<RunnerTarget, 'kind'> {
  if (deps.target !== undefined) {
    if (deps.versions.target !== deps.target.kind) throw new Error('target 与 versions.target 不一致');
    return deps.target;
  }
  if (deps.versions.target === 'modeling') throw new Error('草模版本需要提供 modeling target');
  // 草模 host 是否接线决定实验公平性（决策 #112）：未接线时不暴露 massing / read_massing。
  const massingEnabled = deps.massing !== undefined;
  return {
    factsFormat: FACTS_FORMAT_VERSION,
    tools: toolDefs(massingEnabled),
    system: (_, limits) =>
      systemPrompt({
        worldDts: deps.worldDts,
        maxTurns: limits.maxTurns,
        submitWindow: limits.submitWindow,
        windowTools: WINDOW_TOOLS,
        variant: input.variant,
        ...(input.designAuthority === undefined ? {} : { designAuthority: input.designAuthority }),
        ...(input.promptVersion === undefined ? {} : { promptVersion: input.promptVersion }),
        massingEnabled,
      }),
    create: (_, budget): TargetSession => {
      const state = initialToolState(
        input.initialDraft?.code,
        input.initialDesign === undefined || input.initialDesign === ''
          ? undefined
          : {
              content: input.initialDesign,
              kind: input.initialDesignKind ?? 'full',
              confirmed: input.designAuthority === 'fixed',
            },
      );
      const viewCache = new Map<string, readonly ViewImage[]>();
      /** 颜色候选每次 run 只从注册表构建一次（MASSING-CONVERSION-SPEC §5.2），check 透传时惰性取用。 */
      let candidates: readonly MassingColorCandidate[] | undefined;
      let submitted: TurnTools['submitted'] = null;
      /** BuildSheet markdown 是生产唯一传入的合同形态；解析失败就保持 unknown，不猜 must。 */
      const sheetFacts = input.initialBuildSheet === undefined ? null : parseBuildSheetFacts(input.initialBuildSheet);
      /**
       * 最近一次 check 实际使用的 canonical 报告（由 check_code 调用 conformanceReportOf 时捕获）。
       * 带 archiveHash：状态卡只在报告对应当前 lastCheck 存档时使用；每次新 check 执行前清空。
       */
      let checkReport: { readonly version: number; readonly archiveHash: string; readonly report: DiffReport } | null =
        null;
      /** 最近一次 check 文本里的家具核对计数；没有该段就是 unknown，不是 0。 */
      let furniture: { readonly version: number; readonly counts: StateCounts } | null = null;
      /** 上一批 check 失败对象 / 错误；只用于“同一错误连续 2 次”的提示。 */
      let lastFailure: FailureFingerprint | null = null;
      let repeatedFailure: { count: number; target?: string } | undefined;
      /** 只有模型真的写过 plan（update / conflict）才显示 phase，避免把初始 plan 当成模型阶段。 */
      let planTouched = false;
      /** 只信与当前 lastCheck 同版本、同存档的 canonical 报告。 */
      const usableReport = (): DiffReport | null => {
        const lastCheck = state.lastCheck;
        if (checkReport === null || lastCheck === null) return null;
        if (lastCheck.outcome !== 'ok') return null;
        if (checkReport.version !== lastCheck.version) return null;
        if (lastCheck.archiveHash === undefined || checkReport.archiveHash !== lastCheck.archiveHash) return null;
        return checkReport.report;
      };
      const originalConformanceOf = deps.check.conformanceReportOf;
      const context = (ctx: TargetContext): ToolContext => ({
        store: ctx.store,
        turn: ctx.turn,
        seed: ctx.seed,
        clock: ctx.clock,
        check: {
          ...deps.check,
          clock: ctx.clock,
          massingColorCandidates: () => (candidates ??= colorCandidates(deps.check.registry)),
          // 每次真正执行代码前清掉旧 canonical 报告：同版本重检也不能复用上一次的证据。
          runCode: (input) => {
            checkReport = null;
            return deps.check.runCode(input);
          },
          ...(originalConformanceOf === undefined
            ? {}
            : {
                conformanceReportOf: (archive: Uint8Array): DiffReport | undefined => {
                  const report = originalConformanceOf(archive);
                  const expectedCount = deps.check.expectedObjects?.length ?? 0;
                  if (report === undefined || (expectedCount > 0 && isEmptyConformanceReport(report))) {
                    checkReport = null;
                    return report;
                  }
                  checkReport = { version: state.draft.version, archiveHash: sha256Hex(archive), report };
                  return report;
                },
              }),
        },
        render: deps.render,
        cache: { get: (k) => viewCache.get(k), set: (k, v) => viewCache.set(k, v) },
        requireDesign: input.requireDesign ?? false,
        budget: ctx.budget,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.sleep === undefined ? {} : { sleep: ctx.sleep }),
        ...(ctx.remainingWallMs === undefined ? {} : { remainingWallMs: ctx.remainingWallMs }),
        ...(ctx.massing === undefined ? {} : { massing: ctx.massing }),
        ...(deps.deliveryNote === undefined ? {} : { deliveryNote: deps.deliveryNote }),
      });
      const sync = (from: BudgetCounters, to: BudgetCounters): void => {
        to.imageBytes = from.imageBytes;
        to.images = from.images;
        to.inWindow = from.inWindow;
      };
      return {
        runTools: async (calls, invalid, ctx) => {
          sync(budget, state);
          const beforePlan = state.plan;
          const out = await runToolCalls(calls, invalid, state, context(ctx));
          sync(state, budget);
          submitted = out.submitted;
          if (state.plan !== beforePlan) planTouched = true;
          // check_code 与 edit_code 自动检查都把确定性文本放进 summaries；只取最近一次有核对段的文本。
          const checked = out.summaries
            .filter((s) => s.name === 'check_code' || (s.name === 'edit_code' && s.result.includes('自动检查')))
            .at(-1);
          if (checked !== undefined) {
            const counts = parseFurnitureCounts(checked.result);
            furniture = counts === null ? null : { version: state.lastCheck?.version ?? state.draft.version, counts };
            const fingerprint = failureFingerprint(usableReport(), checked.result);
            if (fingerprint === null) {
              lastFailure = null;
              repeatedFailure = undefined;
            } else if (lastFailure !== null && lastFailure.key === fingerprint.key) {
              repeatedFailure = {
                count: (repeatedFailure?.count ?? 1) + 1,
                ...(fingerprint.target === null ? {} : { target: fingerprint.target }),
              };
            } else {
              lastFailure = fingerprint;
              repeatedFailure = undefined;
            }
          }
          return { ...out, submitted: submitted !== null };
        },
        formatFacts: (facts) => {
          const base = {
            ...facts,
            draftVersion: draftVersion(state),
            hasDraftCode: state.draft.code.trim() !== '',
            lastCheck: state.lastCheck,
            lastViewVersion: state.lastViewVersion,
            plan: state.plan,
          };
          if (input.promptVersion !== 'v2') return formatFacts(base);

          const lastCheck = state.lastCheck;
          const report = usableReport();
          const objects = report === null ? null : countsFromReport(report);
          const musts = sheetFacts === null ? null : mustEvidenceFrom(sheetFacts, report);
          const planAvailable =
            planTouched || state.plan.items.length > 0 || state.plan.note !== null || state.plan.conflicts.length > 0;
          const doing = state.plan.items.filter((item) => item.status === 'doing');
          const todo = state.plan.items.filter((item) => item.status === 'todo');
          const planNext = [...doing, ...todo].map((item) => item.id);
          const furnitureCounts =
            furniture !== null && lastCheck !== null && furniture.version === lastCheck.version
              ? furniture.counts
              : null;
          const next = nextActions({
            draftVersion: draftVersion(state),
            lastCheck: lastCheck === null ? null : { version: lastCheck.version, outcome: lastCheck.outcome },
            lastView: state.lastViewVersion === null ? null : { version: state.lastViewVersion },
            objects,
            furniture: furnitureCounts,
            musts,
            plan: planNext,
          });
          const plan = planAvailable
            ? {
                verified: state.plan.items.filter((item) => item.status === 'verified').length,
                total: state.plan.items.length,
              }
            : null;
          const planConflicts = state.plan.conflicts.filter((conflict) => conflict.choice === null);
          const conflictIds = [
            ...new Set([...(sheetFacts?.conflictIds ?? []), ...planConflicts.map((conflict) => conflict.id)]),
          ];
          const card = formatStateCard({
            ...(planAvailable ? { phase: state.plan.phase } : {}),
            draftVersion: draftVersion(state),
            lastCheck: lastCheck === null ? null : { version: lastCheck.version, outcome: lastCheck.outcome },
            lastView: state.lastViewVersion === null ? null : { version: state.lastViewVersion },
            objects,
            furniture: furnitureCounts,
            musts,
            conflicts: { count: conflictIds.length, ids: conflictIds },
            plan,
            budget: {
              turn: facts.nextTurn,
              maxTurns: facts.maxTurns,
              spentCny: facts.accounting === 'unmetered' ? null : facts.spentCny,
              maxCny: facts.maxCostCny === 0 ? null : facts.maxCostCny,
              wallMinutes: Math.floor(facts.elapsedMs / 60_000),
              wallMaxMinutes: Math.floor(facts.wallMs / 60_000),
              ...(facts.accounting === 'unmetered' ? { unmetered: true } : {}),
            },
            ...(next.length === 0 ? {} : { next }),
            ...(repeatedFailure === undefined ? {} : { repeatedFailure }),
          });
          const lines: string[] = [];
          if (facts.event === 'no-tool') lines.push(NO_TOOL_NOTICE);
          if (facts.event === 'degenerate') lines.push(DEGENERATE_NOTICE);
          lines.push(card);
          if (facts.window !== null) {
            lines.push(windowNotice(facts.window, facts.hasDraftCode ?? state.draft.code.trim() !== ''));
          }
          const warnings = (facts.warnings ?? []).slice(0, 3).map((warning) => {
            const clean = warning.replace(/\s*\n\s*/g, ' ').trim();
            return clean.length <= 160 ? clean : `${clean.slice(0, 159)}…`;
          });
          for (const warning of warnings) lines.push(warning);
          const dropped = (facts.warnings?.length ?? 0) - warnings.length;
          if (dropped > 0) lines.push(`（另有 ${String(dropped)} 条提醒未显示）`);
          return lines.join('\n');
        },
        deliver: async (ctx) => {
          if (submitted === null) throw new Error('尚未接受提交，不能交付');
          return deliver(submitted, state, context(ctx));
        },
        finish: () => (state.lastOk === null ? {} : { lastArchive: state.lastOk.ref }),
      };
    },
  };
}
