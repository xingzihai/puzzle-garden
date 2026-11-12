import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleRequirements, exampleScheme } from './example.ts';
import { compileDesignReport } from './report.ts';
import { DesignScheme } from './scheme.ts';

test('正常方案输出完整中文报告，面积 / 洞口 / 细部都来自方案', () => {
  const report = compileDesignReport(exampleScheme(), exampleRequirements());
  for (const heading of [
    '## 项目概念',
    '## 用户需求与来源',
    '## 场地',
    '## 面积与空间表',
    '## 楼层与标高',
    '## 平面与剖面说明',
    '## 结构',
    '## 屋面',
    '## 立面与材质',
    '## 细部',
    '## 室内',
    '## 必须项与自由范围',
    '## 未决问题',
  ]) {
    assert.ok(report.includes(heading), `缺少 ${heading}`);
  }
  assert.match(report, /48 m²/);
  assert.match(report, /南向看景窗（窗/);
  assert.match(report, /d-eave/);
  assert.match(report, /req-use/);
  assert.match(report, /木、石、纸感/);
  assert.match(report, /中央长桌/);
  assert.match(report, /南窗长凳/);
  assert.match(report, /木柜台/);
  assert.ok(!report.includes('undefined'));
});

test('未附带需求图时不假装知道用户原话', () => {
  const report = compileDesignReport(exampleScheme());
  assert.match(report, /未附带需求图/);
  assert.ok(!report.includes('原话：“'));
});

test('声明完整室内但缺室内时，明确报告未完成', () => {
  const scheme = DesignScheme.parse({ ...exampleScheme(), interiors: [] });
  const report = compileDesignReport(scheme);
  assert.match(report, /方案声明完整室内，但没有记录任何室内设计/);
  assert.match(report, /不能交给构建层/);
  assert.ok(!report.includes('喝茶区室内'));
});

test('缺细部时输出“无细部条目”', () => {
  const scheme = DesignScheme.parse({ ...exampleScheme(), details: [] });
  const report = compileDesignReport(scheme);
  assert.match(report, /无细部条目/);
});

test('含未决问题时逐条列出并保留默认假设', () => {
  const scheme = DesignScheme.parse({
    ...exampleScheme(),
    open: [
      {
        id: 'open-1',
        question: '南侧是否再加一扇可开启窗？',
        impact: 'facade',
        owner: 'user',
        status: 'open',
        defaultAssumption: '先按固定窗施工',
        freeForBuilder: false,
      },
      {
        id: 'open-2',
        question: '铺装图案可由构建层决定。',
        impact: 'other',
        owner: 'agent',
        status: 'deferred',
        defaultAssumption: null,
        freeForBuilder: true,
      },
    ],
  });
  const report = compileDesignReport(scheme);
  assert.match(report, /南侧是否再加一扇可开启窗/);
  assert.match(report, /先按固定窗施工/);
  assert.match(report, /铺装图案可由构建层决定/);
});

test('报告确定：同输入逐字节相同', () => {
  const scheme = exampleScheme();
  const requirements = exampleRequirements();
  assert.equal(compileDesignReport(scheme, requirements), compileDesignReport(scheme, requirements));
});

test('稀疏方案覆盖无分区 / 无交通 / 无洞口 / 无立面 / 空决策与空备注分支', () => {
  const base = exampleScheme();
  const sparse = DesignScheme.parse({
    ...base,
    meta: { ...base.meta, scope: 'exterior+entry' },
    site: { ...base.site, orientation: 'unknown', outdoorZones: [], notes: null },
    circulation: [],
    openings: [],
    facades: [],
    details: [],
    interiors: [],
    decisions: [],
    structure: { ...base.structure, notes: null },
    roof: { ...base.roof, drainage: null, skylights: ['南侧天窗'], notes: null },
  });
  const report = compileDesignReport(sparse);
  assert.match(report, /朝向：未定/);
  assert.match(report, /室外分区：无/);
  assert.match(report, /未记录显式路线/);
  assert.match(report, /未记录门窗洞口/);
  assert.match(report, /未记录立面分层/);
  assert.match(report, /无单独记录的设计决策/);
  assert.match(report, /无细部条目/);
  assert.match(report, /本方案未包含室内设计/);
  assert.match(report, /天窗：南侧天窗/);
  assert.match(report, /无额外必须项/);
  assert.ok(!report.includes('排水：'));
});

test('需求图偏好 / 约束为空时不输出空小节', () => {
  const requirements = exampleRequirements();
  const empty = {
    ...requirements,
    preferences: [],
    constraints: [],
  };
  const report = compileDesignReport(exampleScheme(), empty);
  assert.ok(!report.includes('### 偏好'));
  assert.ok(!report.includes('### 约束'));
});
