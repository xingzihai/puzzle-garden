import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileBuildBrief } from './brief.ts';
import { expandDesignIntent } from './design-expand.ts';
import { exampleIntent } from './example-intent.ts';
import { exampleRequirements } from './example-requirements.ts';
import { deriveFloorDatum, findFlushMustEntries } from './floor-datum.ts';
import { isFlushMustText } from './flush-text.ts';
import { createIntentHost } from './generate-intent.ts';
import { compileDesignReport } from './report.ts';
import { RequirementGraph } from './requirements.ts';
import { DesignScheme } from './scheme.ts';
import { createSession, reduceSession } from './session.ts';

function fixture<T>(name: string, parse: (value: unknown) => T): T {
  return parse(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')));
}

const RUN7 = fixture('run7-requirements.json', (value) => RequirementGraph.parse(value));
const REV2 = fixture('run7-rev2-scheme.json', (value) => DesignScheme.parse(value));

/** site top y0：min=-1、max=5（max > standing 时取 min+1）；场地仍包含 y1..5 建筑。 */
const LOW_SITE = DesignScheme.parse({
  ...REV2,
  meta: { ...REV2.meta, id: 'scheme-low-site', revision: 1 },
  site: {
    ...REV2.site,
    bounds: { min: [0, -1, 0], max: [14, 5, 12] },
  },
});

function datumSection(report: string): string {
  const start = report.indexOf('### 标高与入口');
  assert.ok(start >= 0, 'missing datum section');
  const end = report.indexOf('## 平面与剖面说明', start);
  assert.ok(end > start, 'missing datum section end');
  return report.slice(start, end);
}

test('run-7 rev2：site top y1（与 BuildSheet 同口径）→ flush，无冲突', () => {
  const result = deriveFloorDatum(REV2, RUN7);
  assert.equal(result.flushRequired, true);
  assert.equal(result.datum.gradeY, 1);
  assert.equal(result.datum.standingY, 1);
  assert.equal(result.datum.slabTopY, 0);
  assert.equal(result.datum.entryThresholdY, 1);
  assert.equal(result.datum.entryTransition, 'flush');
  assert.equal(result.datum.source, 'raise-site');
  assert.equal('floorY' in result.datum, false);
  assert.equal(result.datum.recommendedSource, null);
  assert.equal(result.datum.targetGradeY, null);
  assert.equal(result.conflict, null);
  assert.ok(result.datum.evidence.some((line) => line.includes('site top y1')));
  assert.ok(result.datum.evidence.some((line) => line.includes('grade and standing both y1')));
});

test('site top y0：返回 one-step + flush-entry 冲突，目标 standingY=1', () => {
  const result = deriveFloorDatum(LOW_SITE, RUN7);
  assert.equal(result.datum.gradeY, 0);
  assert.equal(result.datum.standingY, 1);
  assert.equal(result.datum.slabTopY, 0);
  assert.equal(result.datum.entryThresholdY, 1);
  assert.equal(result.datum.entryTransition, 'one-step');
  assert.equal(result.datum.source, 'unresolved');
  assert.equal(result.datum.recommendedSource, 'raise-site');
  assert.equal(result.datum.targetGradeY, 1);

  assert.ok(result.conflict);
  assert.equal(result.conflict.id, 'conflict-flush-entry');
  assert.equal(result.conflict.targetGradeY, 1);
  assert.deepEqual(
    result.conflict.options.map((option) => option.id),
    ['raise-site', 'accept-step', 'waive', 'redesign'],
  );
  assert.ok(result.conflict.mustIds.includes('req-no-steps'));
  assert.ok(result.conflict.mustIds.includes('constraint-con-entry-flush'));
  assert.ok(!result.conflict.mustIds.includes('req-no-outdoor-zone'));
});

test('flush must 识别齐平 / flush / 无台阶 / 不设台阶；不误伤普通台阶禁令', () => {
  assert.equal(isFlushMustText('入口不设台阶、不设坡道；室内地面与室外地面齐平。'), true);
  assert.equal(isFlushMustText('入口无台阶，门洞直接连通村道。'), true);
  assert.equal(isFlushMustText('不设台阶，保持入口平坦。'), true);
  assert.equal(isFlushMustText('entry flush with village road'), true);
  assert.equal(isFlushMustText('不做檐下平台、露台、台阶或任何室外分区。'), false);
  const ids = findFlushMustEntries(RUN7).map((entry) => entry.sourceId);
  assert.ok(ids.includes('req-no-steps'));
  assert.ok(ids.includes('con-entry-flush'));
  assert.ok(!ids.includes('req-no-outdoor-zone'));
  assert.ok(!ids.includes('con-no-outdoor-zone'));
});

test('报告在 one-step 时明确写一格高差与冲突，不把入口写成 flush', () => {
  const report = compileDesignReport(LOW_SITE, RUN7);
  const section = datumSection(report);
  assert.ok(section.includes('one-step'));
  assert.ok(section.includes('1 格高差'));
  assert.ok(section.includes('conflict-flush-entry'));
  assert.ok(section.includes('建议将场地/基座抬至 y1'));
  assert.ok(!section.includes('室内外同高（flush）'));

  const brief = compileBuildBrief(LOW_SITE, RUN7);
  assert.ok(brief.designMarkdown.includes('### 标高与入口'));
  assert.ok(brief.designMarkdown.includes('one-step'));
  assert.ok(brief.designMarkdown.includes('conflict-flush-entry'));
});

test('报告在 flush 时给出一致标高证据，不再报冲突', () => {
  const report = compileDesignReport(REV2, RUN7);
  const section = datumSection(report);
  assert.ok(section.includes('室内外同高（flush）'));
  assert.ok(section.includes('场地/基座与楼面同高（raise-site）'));
  assert.ok(!section.includes('conflict-flush-entry'));
});

test('createIntentHost / expand 注入 datum；没有无台阶 must 时不产生冲突', () => {
  const host = createIntentHost(RUN7, { schemeId: 'run7', revision: 1 });
  assert.equal(host.flushRequired, true);
  assert.ok(host.flushMustIds?.includes('req-no-steps'));

  const normal = expandDesignIntent(
    exampleIntent(),
    createIntentHost(exampleRequirements(), { schemeId: 'example', revision: 1 }),
  );
  assert.equal(normal.facts.datum.standingY, 1);
  assert.equal(normal.facts.datumConflict, null);
});

test('datum / datumConflict 随 proposeDesign 进入 SessionState，旧会话字段保持可选', () => {
  const result = deriveFloorDatum(LOW_SITE, RUN7);
  let state = createSession('ses-datum');
  state = reduceSession(state, { kind: 'recordRequirements', graph: RUN7 });
  state = reduceSession(state, { kind: 'skipClarify' });
  // 不显式传 datum：模拟 web revision 路径只调用 proposeDesign，也必须自动派生并持久化。
  state = reduceSession(state, { kind: 'proposeDesign', scheme: LOW_SITE });
  const savedDatum = state.datum;
  assert.ok(savedDatum);
  assert.equal(savedDatum.entryTransition, 'one-step');
  assert.equal(state.datumConflict?.id, 'conflict-flush-entry');
  assert.equal(savedDatum.gradeY, 0);
  assert.equal(savedDatum.standingY, 1);
  assert.equal(result.datum.entryTransition, 'one-step');
});

test('datum 冲突选择：accept-step / waive 显式解决并解除确认；raise-site 未落实仍阻止', () => {
  const result = deriveFloorDatum(LOW_SITE, RUN7);
  let state = createSession('ses-datum-choice');
  state = reduceSession(state, { kind: 'recordRequirements', graph: RUN7 });
  state = reduceSession(state, { kind: 'skipClarify' });
  state = reduceSession(state, {
    kind: 'proposeDesign',
    scheme: LOW_SITE,
    datum: result.datum,
    datumConflict: result.conflict,
  });
  // 模拟检查已通过但 datum 冲突仍在的 review 状态；确认必须先显式选择。
  state = reduceSession(state, {
    kind: 'recordCheck',
    designRevision: 1,
    passed: true,
    issues: [],
  });
  assert.equal(state.stage, 'review');
  assert.throws(() => reduceSession(state, { kind: 'confirmDesign', designRevision: 1 }), /尚未选择/);

  const accepted = reduceSession(state, { kind: 'chooseDatumOption', action: 'accept-step' });
  assert.equal(accepted.datumChoice?.action, 'accept-step');
  const confirmed = reduceSession(accepted, { kind: 'confirmDesign', designRevision: 1 });
  assert.equal(confirmed.stage, 'confirm');

  const raised = reduceSession(state, { kind: 'chooseDatumOption', action: 'raise-site' });
  assert.equal(raised.datumChoice?.action, 'raise-site');
  assert.throws(
    () => reduceSession(raised, { kind: 'confirmDesign', designRevision: 1 }),
    /冲突 conflict-flush-entry|尚未落实/,
  );
  const revised = reduceSession(raised, { kind: 'requestRevision', reason: 'raise site' });
  const next = reduceSession(revised, {
    kind: 'proposeDesign',
    scheme: { ...LOW_SITE, meta: { ...LOW_SITE.meta, revision: 2 } },
  });
  assert.equal(next.datumChoice, null);
});

test('低场地 + 仅「入口与村道齐平」must：仍产生 one-step 冲突（回归）', () => {
  const only = RequirementGraph.parse({
    ...RUN7,
    requirements: RUN7.requirements.map((requirement) => {
      if (requirement.id === 'req-no-steps') return { ...requirement, text: '入口与村道齐平。' };
      if (requirement.id === 'req-entrance-from-north') {
        return { ...requirement, text: '人流由北侧村道进入北墙门洞，入口朝北。' };
      }
      return requirement;
    }),
    constraints: RUN7.constraints.map((constraint) => {
      if (constraint.id === 'con-entry-flush') return { ...constraint, text: '入口构造按设计说明。' };
      if (constraint.id === 'con-flat-site') return { ...constraint, text: '场地按平坦处理。' };
      return constraint;
    }),
  });
  assert.deepEqual(
    findFlushMustEntries(only).map((entry) => entry.sourceId),
    ['req-no-steps'],
  );
  const result = deriveFloorDatum(LOW_SITE, only);
  assert.equal(result.flushRequired, true);
  assert.equal(result.datum.entryTransition, 'one-step');
  assert.ok(result.conflict);
  assert.equal(result.conflict.id, 'conflict-flush-entry');
  assert.equal(result.conflict.targetGradeY, 1);
});
