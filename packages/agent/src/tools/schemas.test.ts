import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ToolDef } from '@pg/llm/schema';

import {
  ALL_TOOL_NAMES,
  CheckCodeArgs,
  EditCodeArgs,
  MASSING_DEFAULT_CNY,
  MASSING_DEFAULT_TURNS,
  MASSING_MAX_CNY,
  MASSING_MAX_TURNS,
  MASSING_TOOL_NAMES,
  MAX_DESIGN_CHARS,
  MAX_EDITS,
  MAX_MASSING_BRIEF,
  MAX_PROBE_POINTS,
  MAX_REFERENCE_QUERY_CHARS,
  MAX_SUBMIT_NOTE,
  MassingArgs,
  PlanArgs,
  ProbeArgs,
  REFERENCE_TOOL_NAME,
  ReadCodeArgs,
  ReadDesignArgs,
  ReadMassingArgs,
  ReferenceArgs,
  SubmitArgs,
  TOOL_ARGS,
  TOOL_DEFS,
  TOOL_NAMES,
  VIEW_NAMES,
  ViewBuildingArgs,
  WriteCodeArgs,
  WriteDesignArgs,
  isMassingToolName,
  isReferenceToolName,
  parametersOf,
  toolDefs,
} from './schemas.ts';

describe('TOOL_DEFS', () => {
  it('13 个工具（既有 12 个 + reference）、名字唯一且顺序固定', () => {
    assert.equal(TOOL_NAMES.length, 12);
    assert.equal(ALL_TOOL_NAMES.length, 13);
    assert.equal(REFERENCE_TOOL_NAME, 'reference');
    assert.equal(new Set(ALL_TOOL_NAMES).size, 13);
    assert.deepEqual(
      TOOL_DEFS.map((d) => d.function.name),
      [...ALL_TOOL_NAMES],
    );
  });

  it('toolDefs：massing 关闭保留 reference（11 个）；打开时回到原 12 个、不含 reference', () => {
    assert.deepEqual([...MASSING_TOOL_NAMES], ['massing', 'read_massing']);
    assert.equal(isMassingToolName('massing'), true);
    assert.equal(isMassingToolName('read_massing'), true);
    assert.equal(isMassingToolName('write_code'), false);
    assert.equal(isReferenceToolName('reference'), true);
    assert.equal(isReferenceToolName('probe'), false);

    const off = toolDefs(false);
    assert.equal(off.length, 11);
    assert.deepEqual(
      off.map((d) => d.function.name),
      [...TOOL_NAMES.filter((n) => !isMassingToolName(n)), 'reference'],
    );

    const on = toolDefs(true);
    assert.equal(on.length, 12);
    assert.deepEqual(
      on.map((d) => d.function.name),
      [...TOOL_NAMES],
    );
    assert.ok(!on.some((d) => isReferenceToolName(d.function.name)));
  });

  it('生成的 JSON Schema 不含 $schema 键（C19），且能被 @pg/llm 的 ToolDef 接受', () => {
    for (const name of ALL_TOOL_NAMES) {
      const parameters = parametersOf(name);
      assert.equal(Object.hasOwn(parameters, '$schema'), false, name);
      assert.ok(!JSON.stringify(parameters).includes('$schema'), name);
      assert.equal(parameters['type'], 'object', name);
      const parsed = ToolDef.safeParse({ type: 'function', function: { name, description: 'x', parameters } });
      assert.equal(parsed.success, true, `${name}: ${JSON.stringify(parsed.error?.issues)}`);
    }
  });

  it('描述非空且各不相同', () => {
    const descriptions = TOOL_DEFS.map((d) => d.function.description);
    for (const d of descriptions) assert.ok(d.length > 0);
    assert.equal(new Set(descriptions).size, 13);
  });

  it('massing 描述金标：含"自由造型/任意曲面适用场景"（决策 #112 修订，改描述即改 versions.tools）', () => {
    const massing = TOOL_DEFS.find((d) => d.function.name === 'massing');
    assert.ok(massing !== undefined);
    assert.equal(
      massing.function.description,
      '把自由造型需求写成建模简报，派一次有界的草模子运行；返回一张多角度合成图与引用 massing#N。' +
        '简报写清形体、比例与关键尺寸，不写施工细节；子运行花费从本 run 预算扣，失败不会中断本 run。' +
        '当需求包含现有构件不易表达的自由造型（如连续凹曲屋面、穹顶、任意旋转体等）时使用。',
    );
  });

  it('is deterministic: 同定义逐字节相同', () => {
    assert.equal(JSON.stringify(TOOL_DEFS), JSON.stringify(TOOL_DEFS));
  });
});

describe('工具参数 schema', () => {
  it('write_code：要求 code 字符串，拒绝多余字段', () => {
    assert.equal(WriteCodeArgs.safeParse({ code: '' }).success, true);
    assert.equal(WriteCodeArgs.safeParse({ code: 'x', extra: 1 }).success, false);
    assert.equal(WriteCodeArgs.safeParse({}).success, false);
  });

  it('edit_code：1–20 条且每条含 find/replace', () => {
    assert.equal(EditCodeArgs.safeParse({ edits: [{ find: 'a', replace: 'b' }] }).success, true);
    assert.equal(EditCodeArgs.safeParse({ edits: [] }).success, false);
    assert.equal(
      EditCodeArgs.safeParse({ edits: Array.from({ length: MAX_EDITS + 1 }, () => ({ find: 'a', replace: 'b' })) })
        .success,
      false,
    );
    assert.equal(EditCodeArgs.safeParse({ edits: [{ find: 'a' }] }).success, false);
  });

  it('read_code：from/to 必须是非负整数（≥1）', () => {
    assert.equal(ReadCodeArgs.safeParse({}).success, true);
    assert.equal(ReadCodeArgs.safeParse({ from: 1, to: 400 }).success, true);
    assert.equal(ReadCodeArgs.safeParse({ from: 0 }).success, false);
    assert.equal(ReadCodeArgs.safeParse({ to: 1.5 }).success, false);
  });

  it('check_code：无参数', () => {
    assert.equal(CheckCodeArgs.safeParse({}).success, true);
    assert.equal(CheckCodeArgs.safeParse({ x: 1 }).success, false);
    assert.deepEqual(parametersOf('check_code')['properties'], {});
  });

  it('view_building：1–4 个合法视图名，可省略；9 个名字含 interior / cutaway', () => {
    assert.equal(ViewBuildingArgs.safeParse({}).success, true);
    assert.equal(ViewBuildingArgs.safeParse({ views: ['iso-se'] }).success, true);
    assert.equal(ViewBuildingArgs.safeParse({ views: ['interior', 'cutaway'] }).success, true);
    assert.equal(ViewBuildingArgs.safeParse({ views: [...VIEW_NAMES] }).success, false);
    assert.equal(ViewBuildingArgs.safeParse({ views: ['bad'] }).success, false);
    assert.deepEqual(
      [...VIEW_NAMES],
      ['south', 'east', 'north', 'west', 'top', 'iso-se', 'iso-nw', 'interior', 'cutaway'],
    );
  });

  it('probe：points / box / section 恰好一个，points 1–32，box 半开两端，section 轴与 y', () => {
    assert.equal(ProbeArgs.safeParse({ points: [[0, 1, 2]] }).success, true);
    assert.equal(
      ProbeArgs.safeParse({
        points: [
          [0, 1, 2],
          [3, 4, 5],
        ],
      }).success,
      true,
    );
    assert.equal(
      ProbeArgs.safeParse({
        points: Array.from({ length: MAX_PROBE_POINTS + 1 }, () => [0, 1, 2]),
      }).success,
      false,
    );
    assert.equal(ProbeArgs.safeParse({ points: [] }).success, false);
    assert.equal(ProbeArgs.safeParse({ points: [[0, 1]] }).success, false);
    assert.equal(ProbeArgs.safeParse({ points: [[0, 1.5, 2]] }).success, false);
    assert.equal(ProbeArgs.safeParse({ points: [[0, 1, 2]], box: { min: [0, 0, 0], max: [1, 1, 1] } }).success, false);
    assert.equal(ProbeArgs.safeParse({}).success, false);
    assert.equal(ProbeArgs.safeParse({ box: { min: [0, 0, 0], max: [2, 3, 4] } }).success, true);
    assert.equal(ProbeArgs.safeParse({ box: { min: [0, 0, 0], max: [2, 3, 4], counts: true } }).success, true);
    assert.equal(ProbeArgs.safeParse({ box: { min: [0, 0, 0], max: [2, 3, 4], counts: false } }).success, true);
    assert.equal(ProbeArgs.safeParse({ box: { min: [0, 0, 0], max: [2, 3, 4], counts: 1 } }).success, false);
    assert.equal(ProbeArgs.safeParse({ box: { min: [1, 0, 0], max: [0, 3, 4] } }).success, false);
    assert.equal(ProbeArgs.safeParse({ box: { min: [0, 0, 0] } }).success, false);
    assert.equal(ProbeArgs.safeParse({ box: { min: [0, 0, 0], max: [2, 3, 4], extra: 1 } }).success, false);
    assert.equal(ProbeArgs.safeParse({ section: { axis: 'x', at: 3 } }).success, true);
    assert.equal(ProbeArgs.safeParse({ section: { axis: 'z', at: 3, y: [0, 4] } }).success, true);
    assert.equal(ProbeArgs.safeParse({ section: { axis: 'z', at: 3, y: [4, 0] } }).success, false);
    assert.equal(ProbeArgs.safeParse({ section: { axis: 'y', at: 3 } }).success, false);
    assert.equal(ProbeArgs.safeParse({ section: { axis: 'x', at: 3, y: [0] } }).success, false);
    assert.equal(ProbeArgs.safeParse({ points: [[0, 1, 2]], section: { axis: 'x', at: 0 } }).success, false);
    // JSON Schema 与 ToolDef 兼容，且包含三个可选项。
    const json = parametersOf('probe');
    assert.deepEqual(Object.keys(json['properties'] as object), ['points', 'box', 'section']);
  });

  it('submit：note 必填且 ≤ 2000 字符', () => {
    assert.equal(SubmitArgs.safeParse({ note: 'ok' }).success, true);
    assert.equal(SubmitArgs.safeParse({ note: 'a'.repeat(MAX_SUBMIT_NOTE + 1) }).success, false);
    assert.equal(SubmitArgs.safeParse({}).success, false);
  });

  it('write_design：content 非空且 ≤ 24000 字符', () => {
    assert.equal(WriteDesignArgs.safeParse({ content: 'x' }).success, true);
    assert.equal(WriteDesignArgs.safeParse({ content: '' }).success, false);
    assert.equal(WriteDesignArgs.safeParse({ content: 'x'.repeat(MAX_DESIGN_CHARS + 1) }).success, false);
    assert.equal(WriteDesignArgs.safeParse({ content: 'x', extra: 1 }).success, false);
  });

  it('read_design：无参数', () => {
    assert.equal(ReadDesignArgs.safeParse({}).success, true);
    assert.equal(ReadDesignArgs.safeParse({ x: 1 }).success, false);
    assert.deepEqual(parametersOf('read_design')['properties'], {});
  });

  it('massing：brief 1–4000 必填，maxTurns / maxCny 默认与范围，seed 可选', () => {
    assert.equal(MassingArgs.safeParse({ brief: 'x' }).success, true);
    const parsed = MassingArgs.parse({ brief: 'x' });
    assert.equal(parsed.maxTurns, MASSING_DEFAULT_TURNS);
    assert.equal(parsed.maxCny, MASSING_DEFAULT_CNY);
    assert.equal(MassingArgs.safeParse({ brief: '' }).success, false);
    assert.equal(MassingArgs.safeParse({ brief: 'x'.repeat(MAX_MASSING_BRIEF + 1) }).success, false);
    assert.equal(MassingArgs.safeParse({ brief: 'x', maxTurns: 3 }).success, false);
    assert.equal(MassingArgs.safeParse({ brief: 'x', maxTurns: MASSING_MAX_TURNS }).success, true);
    assert.equal(MassingArgs.safeParse({ brief: 'x', maxCny: 0.04 }).success, false);
    assert.equal(MassingArgs.safeParse({ brief: 'x', maxCny: MASSING_MAX_CNY }).success, true);
    assert.equal(MassingArgs.safeParse({ brief: 'x', seed: 0 }).success, true);
    assert.equal(MassingArgs.safeParse({ brief: 'x', seed: 2 ** 32 }).success, false);
    assert.equal(MassingArgs.safeParse({ brief: 'x', extra: 1 }).success, false);
    // 生成的 JSON Schema 与规格 §1.2 一致：brief/maxTurns/maxCny 必填、seed 可选、无 $schema。
    const json = parametersOf('massing');
    assert.deepEqual(json['required'], ['brief', 'maxTurns', 'maxCny']);
    assert.deepEqual(Object.keys(json['properties'] as object), ['brief', 'maxTurns', 'maxCny', 'seed']);
  });

  it('read_massing：id 形如 massing#N，from / to 可选正整数', () => {
    assert.equal(ReadMassingArgs.safeParse({ id: 'massing#1' }).success, true);
    assert.equal(ReadMassingArgs.safeParse({ id: 'massing#1', from: 1, to: 400 }).success, true);
    assert.equal(ReadMassingArgs.safeParse({}).success, false);
    for (const id of ['massing#0', 'massing#01', 'massing', 'massing#', 'massing#x', 'x#1']) {
      assert.equal(ReadMassingArgs.safeParse({ id }).success, false, id);
    }
  });

  it('plan：read / update / conflict 三选一，阶段、状态、项上限与多余字段都严格', () => {
    assert.equal(PlanArgs.safeParse({ action: 'read' }).success, true);
    assert.equal(
      PlanArgs.safeParse({
        action: 'update',
        phase: 'roof',
        items: [{ id: 'must-roof', status: 'verified', evidence: '测量：eave 5 / ridge 7' }],
      }).success,
      true,
    );
    assert.equal(
      PlanArgs.safeParse({ action: 'conflict', kind: 'flush', expected: '齐平', actual: '一格', options: ['抬场地'] })
        .success,
      true,
    );
    assert.equal(PlanArgs.safeParse({}).success, false);
    assert.equal(PlanArgs.safeParse({ action: 'read', phase: 'roof' }).success, false);
    assert.equal(PlanArgs.safeParse({ action: 'read', extra: 1 }).success, false);
    assert.equal(PlanArgs.safeParse({ action: 'update', phase: 'roof' }).success, false);
    assert.equal(PlanArgs.safeParse({ action: 'update', phase: 'bad', items: [] }).success, false);
    assert.equal(
      PlanArgs.safeParse({ action: 'update', phase: 'roof', items: [{ id: '', status: 'todo' }] }).success,
      false,
    );
    assert.equal(
      PlanArgs.safeParse({ action: 'update', phase: 'roof', items: [{ id: 'x', status: 'done' }] }).success,
      false,
    );
    assert.equal(
      PlanArgs.safeParse({
        action: 'update',
        phase: 'roof',
        items: Array.from({ length: 65 }, (_, i) => ({ id: `m${String(i)}`, status: 'todo' })),
      }).success,
      false,
    );
    assert.equal(PlanArgs.safeParse({ action: 'conflict', kind: 'x', expected: 'a', actual: 'b' }).success, false);
    assert.equal(
      PlanArgs.safeParse({ action: 'conflict', kind: 'x', expected: 'a', actual: 'b', options: [] }).success,
      true,
    );
    const json = parametersOf('plan');
    const oneOf = json['oneOf'];
    assert.equal(json['type'], 'object');
    assert.ok(Array.isArray(oneOf));
    assert.equal(oneOf.length, 3);
  });

  it('reference：scope 必须 api / block，query 去空白后非空且 ≤120 字符', () => {
    assert.equal(ReferenceArgs.safeParse({ scope: 'api', query: 'walls' }).success, true);
    assert.equal(ReferenceArgs.safeParse({ scope: 'block', query: '楼梯' }).success, true);
    assert.deepEqual(ReferenceArgs.parse({ scope: 'api', query: '  opening  ' }), { scope: 'api', query: 'opening' });
    assert.equal(ReferenceArgs.safeParse({ scope: 'example', query: 'walls' }).success, false);
    assert.equal(ReferenceArgs.safeParse({ scope: 'api' }).success, false);
    assert.equal(ReferenceArgs.safeParse({ scope: 'api', query: '' }).success, false);
    assert.equal(ReferenceArgs.safeParse({ scope: 'api', query: '   ' }).success, false);
    assert.equal(
      ReferenceArgs.safeParse({ scope: 'api', query: 'x'.repeat(MAX_REFERENCE_QUERY_CHARS + 1) }).success,
      false,
    );
    assert.equal(ReferenceArgs.safeParse({ scope: 'api', query: 'walls', extra: 1 }).success, false);
    const json = parametersOf('reference');
    assert.deepEqual(json['required'], ['scope', 'query']);
    assert.deepEqual(Object.keys(json['properties'] as object), ['scope', 'query']);
  });

  it('TOOL_ARGS 覆盖全部工具名', () => {
    assert.deepEqual(Object.keys(TOOL_ARGS).sort(), [...ALL_TOOL_NAMES].sort());
  });
});
