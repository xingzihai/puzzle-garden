/* eslint-disable max-lines -- legacy 证据回归与 clause leaf / waiver 状态机共用同一组 fixture，集中对照避免语义漂移。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReviewEvidenceFile, ReviewWaiver } from './review-evidence.ts';
import {
  parseReviewEvidenceFile,
  resolveReviewMusts,
  reviewClauseWaiverApplies,
  reviewEvidenceMatchesArtifacts,
  reviewEvidenceMatchesDesign,
  reviewMustsAcceptEligible,
  reviewWaiverApplies,
  safeParseReviewEvidenceFile,
  summarizeReviewMusts,
} from './review-evidence.ts';

const musts = [
  { id: 'must-door', text: '北门净高 2m', source: 'detail' },
  { id: 'must-roof', text: '25° 双坡屋面', source: 'requirement' },
] as const;

const waiver: ReviewWaiver = {
  mustId: 'must-door',
  designRevision: 2,
  by: 'user',
  choice: '接受现状',
  conflictId: null,
  note: '甲方确认',
};

function rawEvidence(
  options: {
    readonly mapping?: 'heuristic' | 'verified';
    readonly revision?: number;
    readonly schemeId?: string;
    readonly musts?: readonly unknown[];
    readonly specSha256?: string;
    readonly archiveSha256?: string;
    readonly clauses?: readonly unknown[];
    readonly clauseGroups?: readonly unknown[];
    readonly clauseSummary?: Record<string, unknown>;
    readonly clauseCompilerVersion?: string;
  } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    tool: 'conformance-evidence',
    mode: 'report-only',
    generatedBy: 'test',
    mapping: options.mapping ?? 'verified',
    spec: {
      schemeId: options.schemeId ?? 'scheme-test',
      schemeRevision: options.revision ?? 2,
      sha256: options.specSha256 ?? 'a'.repeat(64),
    },
    archive: { sha256: options.archiveSha256 ?? 'b'.repeat(64), bytes: 10 },
    datum: {
      slabTopY: 0,
      standingY: 1,
      gradeY: 1,
      entryTransition: 'flush',
      floorThickness: 1,
      source: 'build-spec',
    },
    musts: options.musts ?? [],
    ...(options.clauses === undefined ? {} : { clauses: options.clauses }),
    ...(options.clauseGroups === undefined ? {} : { clauseGroups: options.clauseGroups }),
    ...(options.clauseSummary === undefined ? {} : { clauseSummary: options.clauseSummary }),
    ...(options.clauseCompilerVersion === undefined ? {} : { clauseCompilerVersion: options.clauseCompilerVersion }),
    summary: { met: 0, notMet: 0, waived: 0, unverified: 0, acceptEligible: false },
  };
}

function clause(
  mustId: string,
  clauseId: string,
  status: 'met' | 'not-met' | 'unverified' | 'waived',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    clauseId,
    mustId,
    kind: 'dimension',
    target: { metric: 'thickness', value: 1, unit: 'm', relation: '>=' },
    check: { kind: 'envelope', id: `check:${clauseId}`, objectRefs: [`wall:${mustId}`], params: {} },
    status,
    actual: status === 'met' ? 1 : null,
    evidence: [{ kind: 'diff', ref: `conformance-diff.json#${clauseId}`, summary: `${status}/hard` }],
    reason: status === 'not-met' ? 'hard-fail' : status === 'unverified' ? 'missing-measurement' : null,
    conflict: null,
    ...overrides,
  };
}

function clauseSummary(
  overrides: Partial<{
    musts: number;
    met: number;
    notMet: number;
    waived: number;
    unverified: number;
    leaves: number;
    conflicts: number;
    unattributedHardFails: readonly string[];
  }> = {},
): Record<string, unknown> {
  return {
    musts: 1,
    met: 1,
    notMet: 0,
    waived: 0,
    unverified: 0,
    leaves: 1,
    conflicts: 0,
    unattributedHardFails: [],
    ...overrides,
  };
}

function entry(
  mustId: string,
  status: 'met' | 'not-met' | 'unverified' | 'waived',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mustId,
    text: mustId,
    source: 'requirement',
    status,
    confidence: 'high',
    objects: [],
    evidence: [],
    reason: null,
    ...overrides,
  };
}

function evidence(options: Parameters<typeof rawEvidence>[0] = {}): ReviewEvidenceFile {
  return parseReviewEvidenceFile(rawEvidence(options));
}

/** 单元测试默认绑定当前证据哈希与全部候选 must；专门测缺失绑定 / provenance 的用例直接调原函数。 */
function resolveMusts(input: Parameters<typeof resolveReviewMusts>[0]): ReturnType<typeof resolveReviewMusts> {
  return resolveReviewMusts({
    specSha256: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    verifiedMustIds: ['must-door', 'must-roof', 'must-table', 'must-wall', 'must-negative'],
    ...input,
  });
}

function resolve(
  value: ReviewEvidenceFile | null,
  overrides: Partial<Parameters<typeof resolveReviewMusts>[0]> = {},
): ReturnType<typeof resolveReviewMusts> {
  return resolveReviewMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts,
    evidence: value,
    specSha256: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    verifiedMustIds: ['must-door', 'must-roof'],
    ...overrides,
  });
}

test('解析生产者证据：缺省 waiver 归一为 null，不伪造判定', () => {
  const parsed = evidence({
    musts: [
      entry('must-door', 'met', {
        objects: [{ expectedId: 'opening:door', actualId: 'opening:door', status: 'pass', severity: 'hard' }],
        evidence: [{ kind: 'diff', ref: 'conformance-diff.json#opening:door', summary: 'pass/hard' }],
      }),
    ],
  });
  assert.equal(parsed.musts[0]?.waiver, null);
  assert.equal(parsed.musts[0].status, 'met');
  assert.equal(parsed.musts[0].objects.length, 1);
});

test('未 parse 的生产者形状（must 省略 waiver）直接进 resolver 也不崩', () => {
  const raw = rawEvidence({ musts: [entry('must-door', 'met')] }) as unknown as ReviewEvidenceFile;
  assert.equal(resolve(raw)[0]?.status, 'met');
});

test('结构不合法的证据返回 null，让评审走未验证回退', () => {
  assert.equal(safeParseReviewEvidenceFile({ nope: true }), null);
  assert.equal(safeParseReviewEvidenceFile('not-json'), null);
});

test('verified + met 才能产生 met，并保留对象 / 证据引用', () => {
  const resolved = resolve(
    evidence({
      mapping: 'verified',
      musts: [
        entry('must-door', 'met', {
          objects: [{ expectedId: 'opening:door', actualId: 'opening:door', status: 'pass', severity: 'hard' }],
          evidence: [{ kind: 'diff', ref: 'conformance-diff.json#door', summary: 'pass/hard' }],
        }),
        entry('must-roof', 'met'),
      ],
    }),
  );
  assert.deepEqual(
    resolved.map((must) => must.status),
    ['met', 'met'],
  );
  assert.equal(resolved[0]?.note, null);
  assert.equal(resolved[0].objects[0]?.expectedId, 'opening:door');
  assert.equal(resolved[0].evidence[0]?.ref, 'conformance-diff.json#door');
  assert.equal(reviewMustsAcceptEligible(resolved), true);
  assert.deepEqual(summarizeReviewMusts(resolved), {
    total: 2,
    met: 2,
    notMet: 0,
    waived: 0,
    unverified: 0,
    acceptEligible: true,
  });
});

test('heuristic 映射的 pass 只能 unverified，不能产生 met', () => {
  const resolved = resolve(
    evidence({
      mapping: 'heuristic',
      musts: [entry('must-door', 'met'), entry('must-roof', 'met')],
    }),
  );
  assert.equal(
    resolved.every((must) => must.status === 'unverified'),
    true,
  );
  assert.match(resolved[0]?.note ?? '', /启发式/);
  assert.equal(reviewMustsAcceptEligible(resolved), false);
});

test('heuristic not-met 只有 hard fail 对象撑住才成立，soft fail 降为 unverified', () => {
  const hard = resolve(
    evidence({
      mapping: 'heuristic',
      musts: [
        entry('must-door', 'not-met', {
          objects: [{ expectedId: 'opening:door', actualId: 'opening:door', status: 'fail', severity: 'hard' }],
          reason: 'linked-object-hard-fail',
        }),
      ],
    }),
  );
  assert.equal(hard[0]?.status, 'not-met');
  assert.match(hard[0].note ?? '', /hard fail/);

  const soft = resolve(
    evidence({
      mapping: 'heuristic',
      musts: [
        entry('must-door', 'not-met', {
          objects: [{ expectedId: 'opening:door', actualId: 'opening:door', status: 'fail', severity: 'soft' }],
          reason: 'linked-object-soft-fail',
        }),
      ],
    }),
  );
  assert.equal(soft[0]?.status, 'unverified');
  assert.match(soft[0].note ?? '', /soft fail/);
});

test('unverified 证据的 reason 都会转成可读备注', () => {
  const cases: readonly (readonly [string, RegExp])[] = [
    ['no-object-mapping', /没有 must→object 映射/],
    ['linked-object-unverified', /关联对象仍未验证/],
    ['linked-object-unmatched', /未匹配到关联对象/],
    ['anything-else', /anything-else/],
  ];
  for (const [reason, pattern] of cases) {
    const resolved = resolve(evidence({ musts: [entry('must-door', 'unverified', { reason })] }));
    assert.match(resolved[0]?.note ?? '', pattern);
  }
  const nullReason = resolve(evidence({ musts: [entry('must-door', 'unverified', { reason: null })] }));
  assert.match(nullReason[0]?.note ?? '', /未提供足够的 conformance 证据/);
});

test('启发式 hard fail 只有直接归属才 not-met：混合链接与家具必须项都保持 unverified', () => {
  const mixed = resolve(
    evidence({
      mapping: 'heuristic',
      musts: [
        entry('must-door', 'not-met', {
          objects: [
            { expectedId: 'opening:door', actualId: 'opening:door', status: 'fail', severity: 'hard' },
            { expectedId: 'wall:f1', actualId: 'wall:f1', status: 'pass', severity: 'hard' },
          ],
          reason: 'linked-object-hard-fail',
        }),
      ],
    }),
  );
  assert.equal(mixed[0]?.status, 'unverified');
  assert.match(mixed[0].note ?? '', /未形成对该必须项的直接证据/);

  const furniture = resolveMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts: [{ id: 'must-table', text: '主厅东侧靠东墙设一张 4m 长桌', source: 'detail' }],
    evidence: evidence({
      mapping: 'heuristic',
      musts: [
        entry('must-table', 'not-met', {
          objects: [{ expectedId: 'wall:f1', actualId: 'wall:f1', status: 'fail', severity: 'hard' }],
          reason: 'linked-object-hard-fail',
        }),
      ],
    }),
  });
  assert.equal(furniture[0]?.status, 'unverified');

  const wall = resolveMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts: [{ id: 'must-wall', text: '外墙厚度 1m', source: 'detail' }],
    evidence: evidence({
      mapping: 'heuristic',
      musts: [
        entry('must-wall', 'not-met', {
          objects: [{ expectedId: 'wall:f1', actualId: 'wall:f1', status: 'fail', severity: 'hard' }],
          reason: 'linked-object-hard-fail',
        }),
      ],
    }),
  });
  assert.equal(wall[0]?.status, 'not-met');
});

test('否定 / 禁止型 must 不被无关 hard fail 反证，保持 unverified', () => {
  const texts = [
    '不设招牌、售票窗口或装饰性构架。',
    '不做檐下平台、露台、台阶或任何室外分区。',
    '入口不设台阶、不设坡道。',
    '屋面只做出檐，不做檐下平台或檐廊。',
    '南墙无其他洞口。',
    '室内不保留隔间。',
    '禁止设置夹层。',
    '取消檐下平台。',
  ] as const;
  for (const text of texts) {
    const resolved = resolveMusts({
      schemeId: 'scheme-test',
      designRevision: 2,
      musts: [{ id: 'must-negative', text, source: 'requirement' }],
      evidence: evidence({
        mapping: 'heuristic',
        musts: [
          entry('must-negative', 'not-met', {
            objects: [
              {
                expectedId: 'opening:op-south-window',
                actualId: 'opening:op-south-window',
                status: 'fail',
                severity: 'hard',
              },
            ],
            reason: 'linked-object-hard-fail',
          }),
        ],
      }),
    });
    assert.equal(resolved[0]?.status, 'unverified', text);
  }
});

test('verified 映射的显式 not-met 不受否定措辞影响', () => {
  const resolved = resolveMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts: [{ id: 'must-negative', text: '不设招牌、售票窗口或装饰性构架。', source: 'requirement' }],
    evidence: evidence({
      mapping: 'verified',
      musts: [
        entry('must-negative', 'not-met', {
          objects: [
            {
              expectedId: 'opening:op-south-window',
              actualId: 'opening:op-south-window',
              status: 'fail',
              severity: 'hard',
            },
          ],
          reason: 'linked-object-hard-fail',
        }),
      ],
    }),
  });
  assert.equal(resolved[0]?.status, 'not-met');
});

test('没有证据文件或缺少对应 must 时保持 unverified', () => {
  const missingFile = resolve(null);
  assert.equal(
    missingFile.every((must) => must.status === 'unverified'),
    true,
  );
  assert.match(missingFile[0]?.note ?? '', /没有 conformance 证据/);

  const missingEntry = resolve(evidence({ musts: [entry('must-door', 'met')] }));
  assert.equal(missingEntry[0]?.status, 'met');
  assert.equal(missingEntry[1]?.status, 'unverified');
  assert.match(missingEntry[1].note ?? '', /没有 must-roof 的证据/);
});

test('证据版本与当前方案不一致时全部按未验证处理', () => {
  const stale = evidence({ revision: 1, musts: [entry('must-door', 'met')] });
  assert.equal(reviewEvidenceMatchesDesign(stale, 'scheme-test', 2), false);
  const resolved = resolve(stale);
  assert.equal(
    resolved.every((must) => must.status === 'unverified'),
    true,
  );
  assert.match(resolved[0]?.note ?? '', /版本不一致/);
});

test('工件哈希绑定：spec / archive 任一不匹配都全部 unverified，正确哈希才放行', () => {
  const value = evidence({ musts: [entry('must-door', 'met'), entry('must-roof', 'met')] });
  assert.equal(
    reviewEvidenceMatchesArtifacts(value, { specSha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64) }),
    true,
  );
  assert.equal(
    reviewEvidenceMatchesArtifacts(value, { specSha256: 'c'.repeat(64), archiveSha256: 'b'.repeat(64) }),
    false,
  );
  assert.equal(
    reviewEvidenceMatchesArtifacts(value, { specSha256: 'a'.repeat(64), archiveSha256: 'd'.repeat(64) }),
    false,
  );
  assert.equal(reviewEvidenceMatchesArtifacts(value, {}), false);

  const accepted = resolve(value, {
    specSha256: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
  });
  assert.deepEqual(
    accepted.map((must) => must.status),
    ['met', 'met'],
  );

  const staleSpec = resolve(value, {
    specSha256: 'c'.repeat(64),
    archiveSha256: 'b'.repeat(64),
  });
  assert.equal(
    staleSpec.every((must) => must.status === 'unverified'),
    true,
  );
  assert.match(staleSpec[0]?.note ?? '', /哈希不一致/);

  const staleArchive = resolve(value, {
    specSha256: 'a'.repeat(64),
    archiveSha256: 'd'.repeat(64),
  });
  assert.equal(
    staleArchive.every((must) => must.status === 'unverified'),
    true,
  );
  assert.match(staleArchive[0]?.note ?? '', /哈希不一致/);
});

test('证据里缺 waiver 的 waived 不成立；完整用户豁免才成立', () => {
  const noWaiver = resolve(evidence({ musts: [entry('must-door', 'waived')] }));
  assert.equal(noWaiver[0]?.status, 'unverified');
  assert.match(noWaiver[0].note ?? '', /缺少用户豁免记录/);
});

test('旧生产者把 waiver 写进证据文件时只归一化形态，不把证据 waiver 当成有效豁免', () => {
  const parsed = parseReviewEvidenceFile(
    rawEvidence({
      musts: [
        entry('must-door', 'waived', {
          waiver: { conflictId: 'conflict-1', by: 'user', choice: '保留现状' },
        }),
      ],
    }),
  );
  assert.deepEqual(parsed.musts[0]?.waiver, {
    mustId: 'must-door',
    designRevision: 2,
    by: 'user',
    choice: '保留现状',
    conflictId: 'conflict-1',
    note: null,
  });
  assert.equal(resolve(parsed)[0]?.status, 'unverified');
  assert.match(resolve(parsed)[0]?.note ?? '', /provenance|mapping \/ met 状态/);
});

test('证据文件里的豁免也按 revision 绑定；旧 revision 的 waived 不成立', () => {
  const parsed = parseReviewEvidenceFile(
    rawEvidence({
      musts: [
        entry('must-door', 'waived', {
          waiver: {
            mustId: 'must-door',
            designRevision: 1,
            by: 'user',
            choice: '旧豁免',
            conflictId: null,
            note: null,
          },
        }),
      ],
    }),
  );
  assert.equal(resolve(parsed)[0]?.status, 'unverified');
});

test('外部显式豁免按 must + revision 绑定；revision 不符自动失效', () => {
  const applied = resolve(evidence({ musts: [] }), { waivers: [waiver] });
  assert.equal(applied[0]?.status, 'waived');
  assert.equal(applied[1]?.status, 'unverified');
  assert.equal(reviewMustsAcceptEligible(applied), false);

  const stale = resolve(evidence({ musts: [] }), {
    waivers: [{ ...waiver, designRevision: 1 }],
  });
  assert.equal(stale[0]?.status, 'unverified');

  const bad = resolve(evidence({ musts: [] }), {
    waivers: [{ ...waiver, by: 'model' } as unknown as ReviewWaiver],
  });
  assert.equal(bad[0]?.status, 'unverified');
});

test('缺少 spec / archive 哈希绑定时 fail closed；verified met 必须属于当前 BuildSheet 派生集合', () => {
  const value = evidence({ musts: [entry('must-door', 'met'), entry('must-roof', 'met')] });
  const noHashes = resolveReviewMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts,
    evidence: value,
    verifiedMustIds: ['must-door', 'must-roof'],
  });
  assert.equal(
    noHashes.every((must) => must.status === 'unverified'),
    true,
  );

  const handAuthored = resolveReviewMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts,
    evidence: value,
    specSha256: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    verifiedMustIds: ['must-door'],
  });
  assert.equal(
    handAuthored.every((must) => must.status === 'unverified'),
    true,
  );
  assert.match(handAuthored[0]?.note ?? '', /provenance|mapping \/ met 状态/);
});

test('用户豁免只覆盖 unverified，不能改写已 met / not-met 的证据结论', () => {
  const met = resolve(evidence({ musts: [entry('must-door', 'met')] }), { waivers: [waiver] });
  assert.equal(met[0]?.status, 'met');

  const notMet = resolve(
    evidence({
      musts: [
        entry('must-door', 'not-met', {
          objects: [{ expectedId: 'opening:door', actualId: 'opening:door', status: 'fail', severity: 'hard' }],
          reason: 'linked-object-hard-fail',
        }),
      ],
    }),
    { waivers: [waiver] },
  );
  assert.equal(notMet[0]?.status, 'not-met');

  const heuristicPass = resolve(evidence({ mapping: 'heuristic', musts: [entry('must-door', 'met')] }), {
    waivers: [waiver],
  });
  assert.equal(heuristicPass[0]?.status, 'waived');
});

test('验证豁免绑定规则与空 must 列表的可接受性', () => {
  assert.equal(reviewWaiverApplies(waiver, 'must-door', 2), true);
  assert.equal(reviewWaiverApplies(waiver, 'must-door', 3), false);
  assert.equal(reviewWaiverApplies(waiver, 'must-roof', 2), false);
  assert.equal(reviewMustsAcceptEligible([]), true);
  assert.deepEqual(summarizeReviewMusts([]), {
    total: 0,
    met: 0,
    notMet: 0,
    waived: 0,
    unverified: 0,
    acceptEligible: true,
  });
});

test('重复 mustId 只取第一条证据，未匹配的额外条目被忽略', () => {
  const resolved = resolve(
    evidence({
      musts: [entry('must-door', 'met'), entry('must-door', 'not-met'), entry('must-unknown', 'met')],
    }),
  );
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0]?.status, 'met');
  assert.equal(
    resolved.some((must) => must.requirementId === 'must-unknown'),
    false,
  );
});

function resolveSingle(
  mustId: string,
  value: ReviewEvidenceFile,
  overrides: Partial<Parameters<typeof resolveReviewMusts>[0]> = {},
): ReturnType<typeof resolveReviewMusts> {
  return resolveMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts: [{ id: mustId, text: `${mustId} 文本`, source: 'requirement' }],
    evidence: value,
    ...overrides,
  });
}

test('clause 证据：全部 leaf met 时 parent 才 met，并保留 leaf 明细', () => {
  const parsed = evidence({
    clauses: [clause('must-door', 'c-width', 'met'), clause('must-door', 'c-height', 'met')],
  });
  const resolved = resolveSingle('must-door', parsed);
  const must = resolved[0];
  assert.ok(must);
  assert.equal(must.status, 'met');
  assert.equal(must.confidence, 'high');
  assert.equal(must.reason, null);
  assert.deepEqual(
    must.clauses.map((leaf) => leaf.clauseId),
    ['c-width', 'c-height'],
  );
  assert.match(must.note ?? '', /2 个 leaf/);
  assert.equal(reviewMustsAcceptEligible(resolved), true);
});

test('clause 证据：一个 leaf unverified 时 parent 保持 unverified 并阻断接受', () => {
  const parsed = evidence({
    clauses: [
      clause('must-door', 'c-width', 'met'),
      clause('must-door', 'c-height', 'unverified', { reason: 'no-height-measurement' }),
    ],
  });
  const resolved = resolveSingle('must-door', parsed);
  const must = resolved[0];
  assert.ok(must);
  assert.equal(must.status, 'unverified');
  assert.equal(must.reason, 'no-height-measurement');
  assert.equal(must.clauses[1]?.status, 'unverified');
  assert.match(must.note ?? '', /unverified leaf/);
  assert.equal(reviewMustsAcceptEligible(resolved), false);
});

test('clause 证据：一个 leaf not-met 时 parent not-met，绑定该 leaf 的豁免也不能改写', () => {
  const parsed = evidence({
    clauses: [clause('must-door', 'c-width', 'met'), clause('must-door', 'c-hard', 'not-met')],
  });
  const resolved = resolveSingle('must-door', parsed, {
    waivers: [{ ...waiver, clauseId: 'c-hard' }],
  });
  const must = resolved[0];
  assert.ok(must);
  assert.equal(must.status, 'not-met');
  assert.match(must.reason ?? '', /^clause-hard-fail: hard-fail/);
  assert.equal(must.clauses.find((leaf) => leaf.clauseId === 'c-hard')?.status, 'not-met');
  assert.equal(must.waiver, null);
  assert.equal(reviewMustsAcceptEligible(resolved), false);
});

test('clause 证据：qualitative leaf 可被 leaf 豁免，parent 按 aggregate 变成 waived', () => {
  const parsed = evidence({
    clauses: [
      clause('must-door', 'c-thickness', 'met'),
      clause('must-door', 'c-qual', 'unverified', {
        kind: 'qualitative',
        check: { kind: 'qualitative', id: 'check:qual', objectRefs: [], params: {} },
      }),
    ],
  });
  const resolved = resolveSingle('must-door', parsed, {
    waivers: [{ ...waiver, clauseId: 'c-qual' }],
  });
  const must = resolved[0];
  assert.ok(must);
  assert.equal(must.status, 'waived');
  assert.equal(must.clauses[0]?.status, 'met');
  assert.equal(must.clauses[1]?.status, 'waived');
  assert.equal(must.waiver?.clauseId, 'c-qual');
  assert.match(must.reason ?? '', /^clause-waived/);
  assert.equal(reviewMustsAcceptEligible(resolved), true);
});

test('clause 证据：leaf 豁免不会泄漏到 sibling leaf，parent 仍按未豁免 leaf 聚合', () => {
  const parsed = evidence({
    clauses: [clause('must-door', 'c-a', 'unverified'), clause('must-door', 'c-b', 'unverified')],
  });
  const resolved = resolveSingle('must-door', parsed, {
    waivers: [{ ...waiver, clauseId: 'c-a' }],
  });
  const must = resolved[0];
  assert.ok(must);
  assert.equal(must.status, 'unverified');
  assert.equal(must.clauses[0]?.status, 'waived');
  assert.equal(must.clauses[1]?.status, 'unverified');
  assert.equal(reviewMustsAcceptEligible(resolved), false);
});

test('clause 证据：豁免永远不能改写 met / not-met leaf', () => {
  const met = resolveSingle('must-door', evidence({ clauses: [clause('must-door', 'c-met', 'met')] }), {
    waivers: [{ ...waiver, clauseId: 'c-met' }],
  });
  const metMust = met[0];
  assert.ok(metMust);
  assert.equal(metMust.status, 'met');
  assert.equal(metMust.clauses[0]?.status, 'met');
  assert.equal(metMust.waiver, null);

  const notMet = resolveSingle('must-door', evidence({ clauses: [clause('must-door', 'c-hard', 'not-met')] }), {
    waivers: [{ ...waiver, clauseId: 'c-hard' }],
  });
  const notMetMust = notMet[0];
  assert.ok(notMetMust);
  assert.equal(notMetMust.status, 'not-met');
  assert.equal(notMetMust.clauses[0]?.status, 'not-met');
});

test('clause 证据：legacy must 级豁免按 leaf 通配，只覆盖 unverified', () => {
  const mixed = resolveSingle(
    'must-door',
    evidence({
      clauses: [clause('must-door', 'c-met', 'met'), clause('must-door', 'c-qual', 'unverified')],
    }),
    { waivers: [waiver] },
  );
  const mixedMust = mixed[0];
  assert.ok(mixedMust);
  assert.equal(mixedMust.status, 'waived');
  assert.equal(mixedMust.clauses[0]?.status, 'met');
  assert.equal(mixedMust.clauses[1]?.status, 'waived');
  assert.equal(mixedMust.waiver?.clauseId, undefined);

  const hard = resolveSingle(
    'must-door',
    evidence({
      clauses: [clause('must-door', 'c-hard', 'not-met'), clause('must-door', 'c-qual', 'unverified')],
    }),
    { waivers: [waiver] },
  );
  const hardMust = hard[0];
  assert.ok(hardMust);
  assert.equal(hardMust.status, 'not-met');
  assert.equal(hardMust.clauses[0]?.status, 'not-met');
  assert.equal(hardMust.clauses[1]?.status, 'waived');
  assert.equal(reviewMustsAcceptEligible(hard), false);
});

test('clause 证据是 target-bound 实测：verified mapping 不要求 met must 出现在 verifiedMustIds', () => {
  const parsed = evidence({
    mapping: 'verified',
    clauses: [clause('must-door', 'c-width', 'met')],
  });
  const resolved = resolveReviewMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts: [{ id: 'must-door', text: '北门净高 2m', source: 'detail' }],
    evidence: parsed,
    specSha256: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    // 故意不提供 verifiedMustIds：clause 实测不需要 BuildSheet 的启发式 met 列表。
  });
  const must = resolved[0];
  assert.ok(must);
  assert.equal(must.status, 'met');
  assert.equal(must.clauses.length, 1);

  const staleArtifact = resolveReviewMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts: [{ id: 'must-door', text: '北门净高 2m', source: 'detail' }],
    evidence: parsed,
    specSha256: 'c'.repeat(64),
    archiveSha256: 'b'.repeat(64),
  });
  const staleMust = staleArtifact[0];
  assert.ok(staleMust);
  assert.equal(staleMust.status, 'unverified');
  assert.deepEqual(staleMust.clauses, []);
});

test('解析新证据字段：clauses / clauseGroups / clauseSummary / clauseCompilerVersion 与 waiver clauseId 原样保留', () => {
  const leaf = clause('must-door', 'c-width', 'waived');
  const parsed = parseReviewEvidenceFile(
    rawEvidence({
      musts: [
        entry('must-door', 'waived', {
          waiver: {
            mustId: 'must-door',
            designRevision: 2,
            by: 'user',
            choice: '保留现状',
            conflictId: null,
            note: null,
            clauseId: 'c-width',
          },
        }),
      ],
      clauses: [leaf],
      clauseGroups: [{ mustId: 'must-door', text: '北门', status: 'waived', leaves: [leaf] }],
      clauseSummary: clauseSummary({ met: 0, waived: 1 }),
      clauseCompilerVersion: 'compiler-1',
    }),
  );
  assert.equal(parsed.clauses?.length, 1);
  assert.equal(parsed.clauseGroups?.[0]?.leaves[0]?.clauseId, 'c-width');
  assert.equal(parsed.clauseSummary?.waived, 1);
  assert.equal(parsed.clauseCompilerVersion, 'compiler-1');
  assert.equal(parsed.musts[0]?.waiver?.clauseId, 'c-width');

  const legacy = parseReviewEvidenceFile(
    rawEvidence({
      musts: [
        entry('must-door', 'waived', {
          waiver: { by: 'user', choice: '旧豁免' },
        }),
      ],
    }),
  );
  assert.ok(legacy.musts[0]?.waiver);
  assert.equal('clauseId' in legacy.musts[0].waiver, false);
});

test('reviewClauseWaiverApplies：legacy 通配匹配任意 leaf，显式绑定只匹配自身', () => {
  assert.equal(reviewClauseWaiverApplies(waiver, 'must-door', 2, 'c-a'), true);
  assert.equal(reviewClauseWaiverApplies(waiver, 'must-door', 3, 'c-a'), false);
  assert.equal(reviewClauseWaiverApplies({ ...waiver, clauseId: 'c-a' }, 'must-door', 2, 'c-a'), true);
  assert.equal(reviewClauseWaiverApplies({ ...waiver, clauseId: 'c-a' }, 'must-door', 2, 'c-b'), false);
});

test('clause 证据不能自证 waived / met+conflict；父 must 仍按 leaf 状态阻断', () => {
  const parsed = evidence({
    clauses: [
      clause('must-door', 'c-waived', 'waived'),
      clause('must-door', 'c-conflict', 'met', {
        conflict: { mustTarget: 2, specTarget: 1, message: 'must=2m, spec=1m' },
      }),
    ],
  });
  const resolved = resolveReviewMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts: [{ id: 'must-door', text: '北门净高 2m', source: 'detail' }],
    evidence: parsed,
    specSha256: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    verifiedMustIds: [],
  });
  const must = resolved[0];
  assert.ok(must);
  assert.equal(must.clauses.find((item) => item.clauseId === 'c-waived')?.status, 'unverified');
  assert.equal(must.clauses.find((item) => item.clauseId === 'c-conflict')?.status, 'not-met');
  assert.equal(must.status, 'not-met');
  assert.equal(summarizeReviewMusts(resolved).acceptEligible, false);
});

test('父 must entry 明确 not-met 时，全 met 的 clause 不能把它洗成 met', () => {
  const parsed = evidence({
    musts: [
      entry('must-door', 'not-met', {
        objects: [{ expectedId: 'opening:north-door', actualId: null, status: 'fail', severity: 'hard' }],
        reason: 'linked-object-hard-fail',
      }),
    ],
    clauses: [clause('must-door', 'c-width', 'met')],
  });
  const resolved = resolveReviewMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts: [{ id: 'must-door', text: '北门净高 2m', source: 'detail' }],
    evidence: parsed,
    specSha256: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    verifiedMustIds: [],
  });
  assert.equal(resolved[0]?.status, 'not-met');
  assert.equal(summarizeReviewMusts(resolved).acceptEligible, false);
});

test('clause 证据只对本 must 放宽 verifiedMustIds，不能替 bare met entry 洗白', () => {
  const parsed = evidence({
    mapping: 'verified',
    musts: [entry('must-roof', 'met')],
    clauses: [clause('must-door', 'c-width', 'met')],
  });
  const resolved = resolveReviewMusts({
    schemeId: 'scheme-test',
    designRevision: 2,
    musts: [
      { id: 'must-door', text: '北门', source: 'detail' },
      { id: 'must-roof', text: '屋面', source: 'requirement' },
    ],
    evidence: parsed,
    specSha256: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    verifiedMustIds: [],
  });
  assert.equal(
    resolved.every((must) => must.status === 'unverified'),
    true,
  );
  assert.equal(summarizeReviewMusts(resolved).acceptEligible, false);
});
