import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { expandDesignIntent } from './design-expand.ts';
import type { DesignHostContext } from './design-intent.ts';
import { renderPreviewBundle } from './preview.ts';
import { compileDesignReport } from './report.ts';

function host(schemeId: string): DesignHostContext {
  return {
    schemeId,
    revision: 1,
    status: 'draft',
    sourceRequirements: { graphId: 'req-graph', revision: 1 },
    maxBlocks: 20_000,
    targetBlocks: 12_000,
    maxCostCny: 100_000,
    forbidden: ['不得改变已确认方案的主要布局'],
    defaultMaterialId: 'mat-wood',
    floorThickness: 1,
    requirementIds: [],
  };
}

test('入口宽度超过所有外墙可用长度时明确失败并列出墙段', () => {
  const base = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-opening-conflict.json', import.meta.url), 'utf8'),
  ) as { openings: Record<string, unknown>[] };
  const entry = base.openings[0];
  if (entry === undefined) throw new Error('fixture 缺少入口');
  entry['offset'] = 0;
  entry['width'] = 10;
  assert.throws(
    () => expandDesignIntent(base, host('scheme-opening-entry-fail')),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('所有外墙都放不下') &&
      error.message.includes('可用墙段') &&
      error.message.includes('north 长6/可用4'),
  );
});

test('窗口宽度超过墙段可用长度时缩宽并 clamp', () => {
  const base = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-opening-conflict.json', import.meta.url), 'utf8'),
  ) as { openings: Record<string, unknown>[] };
  base.openings = base.openings.filter((opening) => opening['id'] === 'op-entry' || opening['id'] === 'op-south-win');
  const window = base.openings[1];
  if (window === undefined) throw new Error('fixture 缺少南窗');
  window['offset'] = 0;
  window['width'] = 10;
  const { scheme, warnings } = expandDesignIntent(base, host('scheme-opening-window-shrink'));
  const resolved = scheme.openings.find((opening) => opening.id === 'op-south-win');
  assert.ok(resolved !== undefined);
  assert.equal(resolved.bounds.max[0] - resolved.bounds.min[0], 4);
  assert.equal(
    warnings.some((warning) => warning.code === 'opening-shrunk'),
    true,
  );
  assert.equal(
    warnings.some((warning) => warning.code === 'opening-clamped'),
    true,
  );
});

test('真实失败形态：2 格短墙上的门迁移到长墙，expand 通过', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-short-wall-opening.json', import.meta.url), 'utf8'),
  ) as unknown;
  const { scheme, warnings } = expandDesignIntent(raw, host('scheme-short-wall-real'));
  const door = scheme.openings.find((opening) => opening.id === 'op-brew-hall-door');
  assert.ok(door !== undefined);
  assert.equal(door.side, 'east');
  const relocation = warnings.find((warning) => warning.code === 'opening-relocated-short-wall');
  assert.ok(relocation !== undefined);
  assert.match(relocation.message, /原 south/);
  assert.match(relocation.message, /迁移到 east/);
  assert.equal(scheme.site.entranceSide, 'north');
  assert.equal(scheme.spaces.length, 3);
  assert.equal(scheme.roof.form, 'gable');
});

test('合成：2 格短墙 entrance 迁移到长墙，expand 通过', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-opening-conflict.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const site = raw['site'] as { entrance: { side: string } };
  site.entrance.side = 'south';
  const program = raw['program'] as { rooms: Record<string, unknown>[] };
  const room = program.rooms[0];
  if (room === undefined) throw new Error('fixture 缺少房间');
  room['rect'] = { x: [2, 4], z: [2, 8] };
  const openings = raw['openings'] as Record<string, unknown>[];
  const entry = openings[0];
  if (entry === undefined) throw new Error('fixture 缺少入口');
  raw['openings'] = [{ ...entry, id: 'op-entry', side: 'south', role: 'entrance', offset: 0, width: 2 }];
  raw['furniture'] = [];
  const { scheme, warnings, facts } = expandDesignIntent(raw, host('scheme-short-wall-entrance'));
  const entrance = scheme.openings.find((opening) => opening.id === 'op-entry');
  assert.ok(entrance !== undefined);
  assert.equal(entrance.side, 'east');
  assert.equal(scheme.site.entranceSide, 'east');
  assert.equal(facts.entranceSide, 'east');
  assert.equal(
    warnings.some(
      (warning) =>
        warning.code === 'opening-relocated-short-wall' &&
        warning.message.includes('原 south') &&
        warning.message.includes('迁移到 east'),
    ),
    true,
  );
  const sideWarning = warnings.find((warning) => warning.code === 'entrance-side-updated');
  assert.ok(sideWarning !== undefined);
  assert.match(sideWarning.message, /south → east/);
  const preview = renderPreviewBundle(scheme).files;
  const siteSvg = preview.find((file) => file.name === 'site.svg');
  const planSvg = preview.find((file) => file.name === 'plan-f1.svg');
  assert.ok(siteSvg !== undefined);
  assert.ok(planSvg !== undefined);
  assert.match(siteSvg.svg, /入口 · 东/);
  assert.match(planSvg.svg, /入口 · 东/);
  assert.match(compileDesignReport(scheme), /入口：东/);
});

test('窗口在短墙：迁移到长墙并保留', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-opening-conflict.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const site = raw['site'] as { entrance: { side: string } };
  site.entrance.side = 'east';
  const program = raw['program'] as { rooms: Record<string, unknown>[] };
  const room = program.rooms[0];
  if (room === undefined) throw new Error('fixture 缺少房间');
  room['rect'] = { x: [2, 4], z: [2, 8] };
  const openings = raw['openings'] as Record<string, unknown>[];
  const base = openings[0];
  if (base === undefined) throw new Error('fixture 缺少洞口模板');
  raw['openings'] = [
    { ...base, id: 'op-entry', side: 'east', role: 'entrance', offset: 2, width: 2 },
    {
      ...base,
      id: 'op-win',
      side: 'south',
      kind: 'window',
      role: 'interior',
      offset: 0,
      width: 1,
      height: 1,
      sill: 1,
      fill: '透明玻璃',
    },
  ];
  raw['furniture'] = [];
  const { scheme, warnings } = expandDesignIntent(raw, host('scheme-short-wall-window-move'));
  const window = scheme.openings.find((opening) => opening.id === 'op-win');
  assert.ok(window !== undefined);
  assert.equal(window.side, 'east');
  assert.equal(
    warnings.some((warning) => warning.code === 'opening-relocated-short-wall'),
    true,
  );
});

test('窗口在短墙且没有整宽宿主时迁移并缩宽', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-opening-conflict.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const site = raw['site'] as { entrance: { side: string } };
  site.entrance.side = 'east';
  const program = raw['program'] as { rooms: Record<string, unknown>[] };
  const room = program.rooms[0];
  if (room === undefined) throw new Error('fixture 缺少房间');
  room['rect'] = { x: [2, 4], z: [2, 7] };
  const openings = raw['openings'] as Record<string, unknown>[];
  const base = openings[0];
  if (base === undefined) throw new Error('fixture 缺少洞口模板');
  raw['openings'] = [
    { ...base, id: 'op-entry', side: 'east', role: 'entrance', offset: 2, width: 2 },
    {
      ...base,
      id: 'op-win',
      side: 'south',
      kind: 'window',
      role: 'interior',
      offset: 0,
      width: 4,
      height: 1,
      sill: 1,
      fill: '透明玻璃',
    },
  ];
  raw['furniture'] = [];
  const { scheme, warnings } = expandDesignIntent(raw, host('scheme-short-wall-window-shrink'));
  const window = scheme.openings.find((opening) => opening.id === 'op-win');
  assert.ok(window !== undefined);
  assert.equal(window.side, 'east');
  assert.equal(
    warnings.some((warning) => warning.code === 'opening-relocated-short-wall' && warning.message.includes('op-win')),
    true,
  );
  assert.equal(
    warnings.some((warning) => warning.code === 'opening-shrunk' && warning.message.includes('op-win')),
    true,
  );
});

test('窗口在短墙且所有外墙都放不下时 drop + warning', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-opening-conflict.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const site = raw['site'] as { entrance: { side: string } };
  site.entrance.side = 'east';
  const program = raw['program'] as { rooms: Record<string, unknown>[] };
  const room = program.rooms[0];
  if (room === undefined) throw new Error('fixture 缺少房间');
  room['rect'] = { x: [2, 4], z: [2, 4] };
  program.rooms.push({ ...room, id: 'room-main', name: '主厅', rect: { x: [2, 8], z: [4, 10] } });
  const openings = raw['openings'] as Record<string, unknown>[];
  const base = openings[0];
  if (base === undefined) throw new Error('fixture 缺少洞口模板');
  raw['openings'] = [
    { ...base, id: 'op-main-entry', roomId: 'room-main', side: 'east', role: 'entrance', offset: 2, width: 2 },
    {
      ...base,
      id: 'op-brew-window',
      roomId: 'room',
      side: 'north',
      kind: 'window',
      role: 'interior',
      offset: 0,
      width: 2,
      height: 1,
      sill: 1,
      fill: '透明玻璃',
    },
  ];
  raw['furniture'] = [];
  const { scheme, warnings } = expandDesignIntent(raw, host('scheme-short-wall-window-drop'));
  assert.equal(
    scheme.openings.some((opening) => opening.id === 'op-brew-window'),
    false,
  );
  assert.equal(
    warnings.some((warning) => warning.code === 'opening-dropped' && warning.message.includes('op-brew-window')),
    true,
  );
  assert.equal(
    scheme.openings.some((opening) => opening.id === 'op-main-entry'),
    true,
  );
});
