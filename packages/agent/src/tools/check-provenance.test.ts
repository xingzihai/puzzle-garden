/**
 * 包络来源 lint（warning，不拦截）：对手写 set / box 围护给出 warning，但不改变 gates / submit / 状态。
 *
 * 只测纯 helper 与 check_code → submit 的接线；真门禁判定仍在 gates.test.ts。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { writeArchive } from '@pg/core/archive';
import { hashGrid } from '@pg/core/hash';
import type { CallDef } from '@pg/core/grid';
import { API_VERSION, createWorld, rect } from '@pg/geometry';
import type { RunResult } from '@pg/sandbox/run';

import { envelopeProvenanceWarnings } from '../gates.ts';
import { checkCode } from './check.ts';
import type { CheckDeps } from './check.ts';
import { submit } from './submit.ts';

const registry = loadRegistry();
const PREFIX = '包络来源（warning，不拦截）：';

function okRunOf(grid: ReturnType<ReturnType<typeof createWorld>['compose']>['grid']): RunResult {
  return {
    kind: 'ok',
    grid,
    archive: writeArchive(grid, API_VERSION),
    hash: hashGrid(grid),
    report: {
      status: 'ok',
      hash: hashGrid(grid),
      calls: grid.calls().length,
      overlaps: [],
      console: [],
      consoleTruncated: 0,
    },
    wallMs: 1,
  };
}

/** 手写 box / set 包络：没有 walls / floorPlate / roof，正好触发三条 warning。 */
function manualEnvelope(): readonly CallDef[] {
  const host = createWorld(registry.table);
  const w = host.world;
  w.box([0, 0, 0], [5, 0, 5], 'stone_bricks');
  for (let x = 0; x <= 5; x += 1) {
    w.set(x, 1, 0, 'oak_planks');
    w.set(x, 2, 0, 'oak_planks');
  }
  w.box([0, 3, 0], [5, 3, 5], 'deepslate_tiles');
  return host.compose().grid.calls();
}

/** 语义包络：floorPlate + walls + opening + roof，来源完整，不应有 warning。 */
function semanticEnvelope(): readonly CallDef[] {
  const host = createWorld(registry.table);
  const w = host.world;
  w.floorPlate({ footprint: rect(2, 2, 11, 9), y: 0, thickness: 1, material: 'polished_andesite' });
  const hall = w.walls({
    footprint: rect(2, 2, 11, 9),
    y: 1,
    height: 4,
    thickness: 1,
    material: 'oak_planks',
  });
  w.opening({ in: hall.facade('north'), kind: 'door', width: 2, height: 2, sill: 0, at: -3 });
  w.roof({ on: hall, kind: 'gable', ridge: 'x', pitch: 0.5, overhang: 1, material: 'deepslate_tiles' });
  return host.compose().grid.calls();
}

describe('envelopeProvenanceWarnings', () => {
  it('手写包络给三条固定顺序 warning，每条带前缀；重复调用逐字相同', () => {
    const calls = manualEnvelope();
    const warnings = envelopeProvenanceWarnings(calls);
    assert.equal(warnings.length, 3);
    for (const line of warnings) assert.ok(line.startsWith(PREFIX), line);
    assert.match(warnings[0] ?? '', /walls/);
    assert.match(warnings[1] ?? '', /floorPlate/);
    assert.match(warnings[2] ?? '', /roof/);
    assert.deepEqual(envelopeProvenanceWarnings(calls), warnings);
  });

  it('语义包络没有 warning；最多只返回三条', () => {
    assert.deepEqual(envelopeProvenanceWarnings(semanticEnvelope()), []);
    const many: CallDef[] = [
      { id: 1, api: 'set', line: 1, args: '{}' },
      { id: 2, api: 'box', line: 2, args: '{}' },
      { id: 3, api: 'stair', line: 3, args: '{}' },
    ];
    assert.equal(envelopeProvenanceWarnings(many).length, 3);
  });
});

describe('check_code 包络来源 warning 不拦截 submit', () => {
  it('手写 box / set 包络：warning 出现在门槛之后、测量之前，状态仍 ok，submit 接受', async () => {
    const grid = createWorld(registry.table);
    const w = grid.world;
    w.box([0, 0, 0], [5, 0, 5], 'stone_bricks');
    w.set(0, 1, 0, 'oak_planks');
    w.box([0, 3, 0], [5, 3, 5], 'deepslate_tiles');
    const built = grid.compose().grid;
    const run = okRunOf(built);
    const deps: CheckDeps = {
      prechecker: { check: () => Promise.resolve({ kind: 'ok' }) },
      runCode: () => Promise.resolve(run),
      registry,
      gates: { forbidApis: [] },
      clock: () => 1,
    };
    const result = await checkCode({ code: 'x', version: 4, seed: 0 }, deps);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.gates, { passed: true, failed: [] });
    assert.match(result.text, new RegExp(PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const gateAt = result.text.indexOf('门槛（骨架阶段）');
    const warningAt = result.text.indexOf(PREFIX);
    const measuresAt = result.text.indexOf('测量（事实，不判合格）');
    assert.ok(gateAt >= 0 && gateAt < warningAt && warningAt < measuresAt);

    const accepted = submit({
      draftVersion: 4,
      lastCheck: { version: 4, outcome: 'ok', gates: result.gates },
    });
    assert.deepEqual(accepted, { accepted: true, text: '已提交第 v4 版。' });
  });
});
