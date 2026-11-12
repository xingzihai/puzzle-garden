/**
 * 交付注记：只从 conformance 报告与 must-clause 证据取数，不采信设计者自述。
 *
 * 纯函数：不读文件、不联网、不取当前时间；同一输入始终得到同一输出。
 * 报告 / 证据缺失时只陈述“不可用”，不得给出通过或接受结论。
 */

export interface ConformanceNoteInput {
  readonly report: {
    readonly summary: {
      readonly pass: number;
      readonly fail: number;
      readonly missing: number;
      readonly extra: number;
      readonly unverified: number;
      readonly blockingCount: number;
      readonly blocking: boolean;
    };
    readonly items: readonly {
      readonly id: string;
      readonly expectedId: string | null;
      readonly status: string;
      readonly severity: string;
      readonly reason: string | null;
    }[];
  } | null;
  readonly evidence: {
    readonly summary: {
      readonly met: number;
      readonly notMet: number;
      readonly waived: number;
      readonly unverified: number;
      readonly acceptEligible: boolean;
    };
    readonly musts: readonly { readonly mustId: string; readonly status: string; readonly reason: string | null }[];
    readonly clauseSummary?: {
      readonly unattributedHardFails: readonly string[];
      readonly globalBlockers?: readonly string[];
      readonly attributedHardFails?: readonly {
        readonly checkId: string;
        readonly mustIds: readonly string[];
        readonly summary: string;
      }[];
    };
    readonly clauseGroups?: readonly {
      readonly mustId: string;
      readonly status: string;
      readonly leaves: readonly {
        readonly clauseId: string;
        readonly status: string;
        readonly reason: string | null;
      }[];
    }[];
  } | null;
  readonly codeVersion: number | null;
  readonly hash: string | null;
  readonly runId: string | null;
  /** 设计者自述；MUST NOT be copied verbatim into the note. */
  readonly selfReportedNote?: string;
}

type Report = NonNullable<ConformanceNoteInput['report']>;
type ReportItem = Report['items'][number];
type Evidence = NonNullable<ConformanceNoteInput['evidence']>;
type ClauseGroup = NonNullable<Evidence['clauseGroups']>[number];
type AttributedHardFail = NonNullable<NonNullable<Evidence['clauseSummary']>['attributedHardFails']>[number];

interface NotMetMust {
  readonly mustId: string;
  readonly reason: string | null;
}

const NO_REASON = '未提供原因';

function normalizeText(value: string | null): string | null {
  if (value === null) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length === 0 ? null : text;
}

function textOr(value: string | null, fallback: string): string {
  return normalizeText(value) ?? fallback;
}

function unknownNumber(value: number | null): string {
  return value === null ? '未知' : String(value);
}

function isBlockingReportItem(item: ReportItem): boolean {
  return (
    item.severity === 'hard' && (item.status === 'fail' || item.status === 'missing' || item.status === 'unverified')
  );
}

function renderReportItem(item: ReportItem): string {
  const expected = item.expectedId ?? '（无）';
  return `\`${item.id}\`（expectedId=${expected}，status=${item.status}，severity=${item.severity}）：${textOr(
    item.reason,
    NO_REASON,
  )}`;
}

function clauseGroupNotMetReason(group: ClauseGroup): string | null {
  const leaves = group.leaves
    .filter((leaf) => leaf.status === 'not-met')
    .map((leaf) => `${leaf.clauseId}：${textOr(leaf.reason, NO_REASON)}`);
  return leaves.length === 0 ? null : leaves.join('；');
}

/**
 * 收集证据里所有 not-met 的 must。musts 是主来源；clauseGroups 用于补上
 * 没有出现在 musts 明细里的 must，并在 must 级原因为空时补出 leaf 级原因。
 */
function collectNotMetMusts(evidence: Evidence): readonly NotMetMust[] {
  const collected = new Map<string, string | null>();
  for (const must of evidence.musts) {
    if (must.status !== 'not-met') continue;
    collected.set(must.mustId, normalizeText(must.reason));
  }
  for (const group of evidence.clauseGroups ?? []) {
    if (group.status !== 'not-met') continue;
    const reason = clauseGroupNotMetReason(group);
    const existing = collected.get(group.mustId);
    if (existing === undefined) {
      collected.set(group.mustId, reason);
    } else if (existing === null && reason !== null) {
      collected.set(group.mustId, reason);
    }
  }
  return [...collected.entries()].map(([mustId, reason]) => ({ mustId, reason }));
}

function renderAttributedHardFail(failure: AttributedHardFail): string {
  const mustIds =
    failure.mustIds.length === 0 ? '（无 must 归属）' : failure.mustIds.map((id) => `\`${id}\``).join('、');
  return `\`${failure.checkId}\` -> ${mustIds}：${textOr(failure.summary, '未提供 summary')}`;
}

export function formatConformanceDeliveryNote(input: ConformanceNoteInput): string {
  const { report, evidence } = input;
  const lines: string[] = [];

  lines.push('# 交付注记（conformance 证据自动生成）');
  lines.push('');
  lines.push('> 本注记只从 conformance 报告与 must-clause 证据取数；设计者自述不参与判定，其原文不转载到本注记。');
  lines.push('');

  lines.push('## 构建标识');
  lines.push(`- codeVersion：${unknownNumber(input.codeVersion)}`);
  lines.push(`- hash：${textOr(input.hash, '未提供')}`);
  lines.push(`- runId：${textOr(input.runId, '未提供')}`);
  lines.push('');

  const notMetMusts = evidence === null ? [] : collectNotMetMusts(evidence);
  const blockingItems = report === null ? [] : report.items.filter(isBlockingReportItem);
  const unattributed = evidence?.clauseSummary?.unattributedHardFails;
  const globalBlockersRaw = evidence?.clauseSummary?.globalBlockers;
  const attributed = evidence?.clauseSummary?.attributedHardFails;
  const unattributedList: readonly string[] | null = Array.isArray(unattributed)
    ? (unattributed as readonly string[])
    : null;
  const attributedList: readonly AttributedHardFail[] | null = Array.isArray(attributed)
    ? (attributed as readonly AttributedHardFail[])
    : null;
  const globalBlockers: readonly string[] = Array.isArray(globalBlockersRaw)
    ? (globalBlockersRaw as readonly string[])
    : [];

  lines.push('## Conformance 报告');
  if (report === null) {
    lines.push('- 状态：不可用（未提供报告）');
    lines.push('- blockingCount：未知');
    lines.push('- blocking：未知');
  } else {
    lines.push('- 状态：可用');
    lines.push(
      `- report.summary：pass=${String(report.summary.pass)} fail=${String(report.summary.fail)} missing=${String(
        report.summary.missing,
      )} extra=${String(report.summary.extra)} unverified=${String(report.summary.unverified)}`,
    );
    lines.push(`- blockingCount=${String(report.summary.blockingCount)}`);
    lines.push(`- blocking=${String(report.summary.blocking)}`);
    lines.push(
      `- 报告条目：共 ${String(report.items.length)} 条；hard fail/missing/unverified ${String(blockingItems.length)} 条`,
    );

    const summaryTotal =
      report.summary.pass +
      report.summary.fail +
      report.summary.missing +
      report.summary.extra +
      report.summary.unverified;
    if (summaryTotal !== report.items.length) {
      lines.push(
        `- 一致性提示：report.summary 五项合计 ${String(summaryTotal)}，items 共 ${String(
          report.items.length,
        )} 条；报告明细可能被截断，阻断项列表只覆盖 items 中可见的条目，计数以 summary 为准。`,
      );
    }
    const hasBlockingCount = report.summary.blockingCount > 0;
    const blockingFlagConsistent = report.summary.blocking === hasBlockingCount;
    if (!blockingFlagConsistent) {
      lines.push(
        `- 一致性提示：blocking=${String(report.summary.blocking)} 与 blockingCount=${String(
          report.summary.blockingCount,
        )} 不一致；本注记按两者任一为真处理。`,
      );
    }
    if (blockingItems.length !== report.summary.blockingCount) {
      lines.push(
        `- 一致性提示：blockingCount=${String(report.summary.blockingCount)}，items 中 hard fail/missing/unverified 为 ${String(
          blockingItems.length,
        )} 条；两者不一致，需回查报告明细。`,
      );
    }

    if (report.summary.blockingCount > 0 || report.summary.blocking || blockingItems.length > 0) {
      lines.push('');
      lines.push('### 报告阻断项');
      if (blockingItems.length === 0) {
        lines.push(
          '- 报告摘要声明存在阻断，但 items 中没有 severity=hard 且 status 为 fail/missing/unverified 的条目；报告内部不一致，需回查。',
        );
      } else {
        for (const item of blockingItems) lines.push(`- ${renderReportItem(item)}`);
      }
    }
  }
  lines.push('');

  lines.push('## 必须项证据');
  if (evidence === null) {
    lines.push('- 状态：不可用（未提供证据）');
    lines.push('- acceptEligible：未知');
  } else {
    lines.push('- 状态：可用');
    lines.push(
      `- evidence.summary：met=${String(evidence.summary.met)} notMet=${String(evidence.summary.notMet)} waived=${String(
        evidence.summary.waived,
      )} unverified=${String(evidence.summary.unverified)}`,
    );
    lines.push(`- acceptEligible=${String(evidence.summary.acceptEligible)}`);

    lines.push('');
    lines.push('### 未满足必须项（not-met）');
    if (notMetMusts.length === 0) {
      if (evidence.summary.notMet > 0) {
        lines.push(
          `- 无明细（evidence.summary.notMet=${String(
            evidence.summary.notMet,
          )}，但 musts / clauseGroups 没有提供 not-met id）；不能视为已满足。`,
        );
      } else {
        lines.push('- 无（musts / clauseGroups 明细中没有 not-met 条目）');
      }
    } else {
      for (const must of notMetMusts) {
        lines.push(`- \`${must.mustId}\`：${textOr(must.reason, NO_REASON)}`);
      }
    }
    if (evidence.summary.notMet !== notMetMusts.length) {
      lines.push(
        `- 一致性提示：evidence.summary.notMet=${String(evidence.summary.notMet)}，明细中 not-met must 为 ${String(
          notMetMusts.length,
        )} 条；两者不一致，未列出的必须项不能视为已满足。`,
      );
    }
    const detail = {
      met: evidence.musts.filter((must) => must.status === 'met').length,
      notMet: evidence.musts.filter((must) => must.status === 'not-met').length,
      waived: evidence.musts.filter((must) => must.status === 'waived').length,
      unverified: evidence.musts.filter((must) => must.status === 'unverified').length,
    };
    if (
      detail.met !== evidence.summary.met ||
      detail.notMet !== evidence.summary.notMet ||
      detail.waived !== evidence.summary.waived ||
      detail.unverified !== evidence.summary.unverified
    ) {
      lines.push(
        `- 一致性提示：evidence.summary 与 musts 明细不一致（明细 met=${String(detail.met)} / not-met=${String(
          detail.notMet,
        )} / waived=${String(detail.waived)} / unverified=${String(
          detail.unverified,
        )}）；明细不完整，不能据此声明接受。`,
      );
    }
  }
  lines.push('');

  lines.push('## hard fail 归因');
  if (evidence === null) {
    lines.push('- 证据不可用，无法确认未归因 / 已归因 hard fail。');
  } else if (evidence.clauseSummary === undefined) {
    lines.push('- 未提供 clauseSummary，无法确认未归因 / 已归因 hard fail。');
  } else {
    lines.push('### 未归因 hard fail');
    if (unattributedList === null) {
      lines.push('- 未知（clauseSummary 没有 unattributedHardFails 数组）；不能视为无。');
    } else if (unattributedList.length === 0) {
      lines.push('- 无');
    } else {
      for (const id of unattributedList) lines.push(`- \`${id}\``);
    }

    lines.push('### 已归因 hard fail');
    if (attributedList === null) {
      lines.push('- 未知（clauseSummary 没有 attributedHardFails 数组）；不能视为无。');
    } else if (attributedList.length === 0) {
      lines.push('- 无');
    } else {
      for (const failure of attributedList) lines.push(`- ${renderAttributedHardFail(failure)}`);
    }

    lines.push('### 无必须项覆盖的全局阻断');
    if (globalBlockers.length === 0) {
      lines.push('- 无');
    } else {
      for (const blocker of globalBlockers) lines.push(`- \`${blocker}\``);
    }
  }
  lines.push('');

  const reportBlocking = report !== null && (report.summary.blocking || report.summary.blockingCount > 0);
  const reportUnclean =
    report !== null &&
    (report.summary.fail > 0 ||
      report.summary.missing > 0 ||
      report.summary.extra > 0 ||
      report.summary.unverified > 0);
  const detailCounts =
    evidence === null
      ? null
      : {
          met: evidence.musts.filter((must) => must.status === 'met').length,
          notMet: evidence.musts.filter((must) => must.status === 'not-met').length,
          waived: evidence.musts.filter((must) => must.status === 'waived').length,
          unverified: evidence.musts.filter((must) => must.status === 'unverified').length,
        };
  const evidenceCountsMismatch =
    evidence !== null &&
    detailCounts !== null &&
    (detailCounts.met !== evidence.summary.met ||
      detailCounts.notMet !== evidence.summary.notMet ||
      detailCounts.waived !== evidence.summary.waived ||
      detailCounts.unverified !== evidence.summary.unverified);
  const attributionKnown =
    evidence?.clauseSummary !== undefined && Array.isArray(unattributed) && Array.isArray(attributed);
  const evidenceIncomplete =
    evidence !== null &&
    (!evidence.summary.acceptEligible ||
      evidence.summary.notMet > 0 ||
      evidence.summary.unverified > 0 ||
      notMetMusts.length > 0 ||
      evidenceCountsMismatch ||
      !attributionKnown);
  const hardFailsPresent =
    (unattributedList?.length ?? 0) > 0 || (attributedList?.length ?? 0) > 0 || globalBlockers.length > 0;
  const canAccept =
    report !== null &&
    evidence !== null &&
    report.items.length > 0 &&
    report.summary.pass > 0 &&
    !reportBlocking &&
    blockingItems.length === 0 &&
    !reportUnclean &&
    !evidenceIncomplete &&
    !hardFailsPresent &&
    attributionKnown;

  lines.push('## 验收结论');
  lines.push(
    `- 判定值：blockingCount=${
      report === null ? '未知' : String(report.summary.blockingCount)
    }；blocking=${report === null ? '未知' : String(report.summary.blocking)}；acceptEligible=${
      evidence === null ? '未知' : String(evidence.summary.acceptEligible)
    }。`,
  );
  lines.push('- 判定来源：conformance 报告与 must-clause 证据；设计者自述不参与判定。');

  if (report === null && evidence === null) {
    lines.push('- 证据不可用：conformance 报告与 must-clause 证据均缺失；不能声明验收通过或接受。');
  } else if (report === null) {
    lines.push('- 证据不完整：conformance 报告缺失；不能声明验收通过或接受（blocking 状态未知）。');
  } else if (evidence === null) {
    lines.push('- 证据不完整：must-clause 证据缺失；不能声明验收通过或接受（acceptEligible 未知）。');
  } else if (reportBlocking || blockingItems.length > 0) {
    const blockingDetail = reportBlocking
      ? `conformance 报告存在阻断（blockingCount=${String(report.summary.blockingCount)}；blocking=${String(
          report.summary.blocking,
        )}）`
      : `报告摘要未标阻断（blockingCount=${String(report.summary.blockingCount)}；blocking=${String(
          report.summary.blocking,
        )}），但 items 中仍有 ${String(blockingItems.length)} 个 hard fail/missing/unverified 条目`;
    lines.push(
      `- 不可接受：${blockingDetail}，必须项 acceptEligible=${String(
        evidence.summary.acceptEligible,
      )}；不能接受当前结果。`,
    );
  } else if (evidenceIncomplete || hardFailsPresent) {
    lines.push(
      `- 不可接受：报告 blockingCount=${String(
        report.summary.blockingCount,
      )}、blocking=${String(report.summary.blocking)}，但必须项证据未满足（acceptEligible=${String(
        evidence.summary.acceptEligible,
      )}；notMet=${String(evidence.summary.notMet)}；unverified=${String(
        evidence.summary.unverified,
      )}；未归因 hard fail ${String((unattributed ?? []).length)} 个；已归因 hard fail ${String(
        (attributed ?? []).length,
      )} 个）；不能接受当前结果。`,
    );
  } else if (reportUnclean) {
    lines.push(
      `- 不能表述为全部通过：报告 blockingCount=${String(
        report.summary.blockingCount,
      )}、blocking=${String(report.summary.blocking)}，但 report.summary 仍有 fail=${String(
        report.summary.fail,
      )} / missing=${String(report.summary.missing)} / extra=${String(report.summary.extra)} / unverified=${String(
        report.summary.unverified,
      )}；是否接受需按评审门决定。`,
    );
  } else if (evidence.clauseSummary === undefined) {
    lines.push('- 不能声明接受：未提供 clauseSummary，无法确认未归因 / 已归因 hard fail。');
  } else if (canAccept) {
    lines.push(
      `- 可接受：报告 blockingCount=${String(
        report.summary.blockingCount,
      )}、blocking=${String(report.summary.blocking)}，必须项 acceptEligible=${String(
        evidence.summary.acceptEligible,
      )}；未发现 not-met / unverified 必须项或 hard fail。`,
    );
  } else {
    lines.push('- 不能声明接受：当前字段组合未满足本注记的保守验收条件。');
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}
