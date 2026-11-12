import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileBuildBrief, lintBrief } from './brief.ts';
import { expandDesignIntent } from './design-expand.ts';
import { IntentValidationError } from './design-intent.ts';
import { normalizeDesignIntent } from './design-intent-normalize.ts';
import { createIntentHost } from './generate-intent.ts';
import { exampleIntent } from './example-intent.ts';
import { exampleRequirements } from './example-requirements.ts';
import { renderPreviewBundle } from './preview.ts';
import { compileDesignReport } from './report.ts';

type Mutable = Record<string, unknown>;

function draftFromExample(): Mutable {
  return structuredClone(exampleIntent());
}

function siteOf(value: Mutable): Mutable & { outdoorZones: Mutable[] } {
  return value['site'] as Mutable & { outdoorZones: Mutable[] };
}

function roomsOf(value: Mutable): Mutable[] {
  return (value['program'] as Mutable & { rooms: Mutable[] }).rooms;
}

function furnitureOf(value: Mutable): Mutable[] {
  return value['furniture'] as Mutable[];
}

/** 贴近 live：两翼亭子各自与一条连廊分区重叠，另有合法院落分区和连廊家具。 */
function sidePavilionDraft(): Mutable {
  const draft = draftFromExample();
  const rooms = roomsOf(draft);
  const tea = rooms.find((room) => room['id'] === 'sp-tea');
  const counter = rooms.find((room) => room['id'] === 'sp-counter');
  assert.ok(tea !== undefined && counter !== undefined);
  tea['adjacency'] = ['sp-counter', 'sp-side-pavilion-west'];
  counter['adjacency'] = ['sp-tea', 'sp-side-pavilion-east'];
  rooms.push(
    {
      id: 'sp-side-pavilion-west',
      name: '西侧亭子',
      level: 'lv-ground',
      kind: 'room',
      rect: { x: [0, 5], z: [5, 14] },
      areaM2: 45,
      occupancy: 4,
      adjacency: ['sp-tea'],
      daylight: 'preferred',
      notes: null,
    },
    {
      id: 'sp-side-pavilion-east',
      name: '东侧亭子',
      level: 'lv-ground',
      kind: 'room',
      rect: { x: [16, 21], z: [5, 14] },
      areaM2: 45,
      occupancy: 4,
      adjacency: ['sp-counter'],
      daylight: 'preferred',
      notes: null,
    },
  );
  siteOf(draft).outdoorZones.push(
    {
      id: 'oz-corridor-west',
      name: '西侧连廊',
      kind: 'path',
      rect: { x: [0, 5], z: [10, 17] },
      materialId: 'm-stone',
      notes: null,
    },
    {
      id: 'oz-corridor-east',
      name: '东侧连廊',
      kind: 'path',
      rect: { x: [16, 21], z: [10, 17] },
      materialId: 'm-stone',
      notes: null,
    },
  );
  furnitureOf(draft).push(
    {
      id: 'fu-west-bench',
      name: '西亭坐凳',
      kind: 'bench',
      roomId: 'sp-side-pavilion-west',
      anchor: { kind: 'center' },
      footprint: { x: 2, z: 1 },
      orientation: null,
      height: 1,
      materialId: 'm-wood',
      notes: null,
    },
    {
      id: 'fu-east-bench',
      name: '东亭坐凳',
      kind: 'bench',
      roomId: 'sp-side-pavilion-east',
      anchor: { kind: 'center' },
      footprint: { x: 2, z: 1 },
      orientation: null,
      height: 1,
      materialId: 'm-wood',
      notes: null,
    },
    {
      id: 'fu-corridor-bench',
      name: '连廊坐凳',
      kind: 'bench',
      roomId: 'oz-corridor-west',
      anchor: { kind: 'center' },
      footprint: { x: 2, z: 1 },
      orientation: null,
      height: 1,
      materialId: 'm-wood',
      notes: null,
    },
  );
  return draft;
}

function envelopeOf(value: Mutable): Mutable {
  return value['envelope'] as Mutable;
}

function openingsOf(value: Mutable): Mutable[] {
  return value['openings'] as Mutable[];
}

test('真实失败形态：缺 stairs / 多 notes / 缺 name fill / 小数洞口归一化后通过严格 intent', () => {
  const draft = draftFromExample();
  delete envelopeOf(draft)['stairs'];
  envelopeOf(draft)['notes'] = '信封备注应被丢弃';
  (draft['meta'] as Mutable)['notes'] = 'meta 备注应被丢弃';
  (draft['program'] as Mutable)['notes'] = 'program 备注应被丢弃';
  const openings = openingsOf(draft);
  const entry = openings[0];
  const window = openings[1];
  assert.ok(entry !== undefined && window !== undefined);
  Reflect.deleteProperty(entry, 'name');
  Reflect.deleteProperty(entry, 'fill');
  entry['notes'] = '洞口备注应被丢弃';
  window['offset'] = 1.4;
  window['width'] = 3.6;
  window['height'] = 1.6;
  window['sill'] = 0.6;

  const normalized = normalizeDesignIntent(draft);
  const intent = normalized.intent;
  assert.equal(intent.envelope.stairs.length, 0);
  assert.equal(intent.openings[0]!.name, 'op-1');
  assert.equal(intent.openings[0]!.fill, '木门');
  assert.equal(intent.openings[1]!.offset, 1);
  assert.equal(intent.openings[1]!.width, 4);
  assert.equal(intent.openings[1]!.height, 2);
  assert.equal(intent.openings[1]!.sill, 1);
  const codes = new Set(normalized.warnings.map((warning) => warning.code));
  for (const code of [
    'envelope-stairs-default',
    'notes-dropped',
    'opening-name-default',
    'opening-fill-default',
    'non-integer-rounded',
  ]) {
    assert.ok(codes.has(code), code);
  }

  const requirements = exampleRequirements();
  const resolved = expandDesignIntent(intent, createIntentHost(requirements, { schemeId: 'scheme-normalized' }));
  const brief = compileBuildBrief(resolved.scheme, requirements);
  assert.deepEqual(lintBrief(brief, requirements), []);
  assert.ok(renderPreviewBundle(resolved.scheme).files.length >= 5);
});

test('真实失败形态别名：structure / roof / facades.layers / hostRoomId 归一化后可展开', () => {
  const draft = draftFromExample();
  delete envelopeOf(draft)['stairs'];
  (draft['meta'] as Mutable)['notes'] = 'meta notes';
  envelopeOf(draft)['notes'] = 'envelope notes';
  const program = draft['program'] as Mutable & { levels: Mutable[] };
  program['notes'] = 'program notes';
  program.levels[0]!['notes'] = 'level notes';

  const structure = draft['structure'] as Mutable;
  structure['system'] = 'timber-frame';
  structure['slabThickness'] = 1;
  Reflect.deleteProperty(structure, 'floorThickness');

  const roof = draft['roof'] as Mutable;
  roof['slope'] = 0.35;
  Reflect.deleteProperty(roof, 'pitchDegrees');

  const facades = draft['facades'] as Mutable[];
  for (const facade of facades) {
    Reflect.deleteProperty(facade, 'baseMaterialId');
    Reflect.deleteProperty(facade, 'bodyMaterialId');
    Reflect.deleteProperty(facade, 'topMaterialId');
    facade['layers'] = [
      { role: 'base', block: 'stone_bricks' },
      { role: 'body', material: 'm-wood', from: 0 },
      { role: 'top', name: '深瓦屋面' },
    ];
  }
  for (const opening of openingsOf(draft)) {
    opening['hostRoomId'] = opening['roomId'];
    Reflect.deleteProperty(opening, 'roomId');
  }
  const table = (draft['furniture'] as Mutable[])[0];
  assert.ok(table !== undefined);
  (table['footprint'] as Mutable)['x'] = 2.4;

  const normalized = normalizeDesignIntent(draft);
  const codes = new Set(normalized.warnings.map((warning) => warning.code));
  for (const code of [
    'structure-system-alias',
    'structure-slabThickness-alias',
    'roof-slope-ratio',
    'facade-material-block-alias',
    'facade-material-name-alias',
    'facade-layer-geometry-ignored',
    'opening-hostRoomId-alias',
    'notes-dropped',
    'non-integer-rounded',
    'envelope-stairs-default',
  ]) {
    assert.ok(codes.has(code), code);
  }
  assert.equal(normalized.warnings.length, 24);
  assert.equal(normalized.intent.structure.system, 'post-and-beam');
  assert.equal(normalized.intent.structure.floorThickness, 1);
  assert.equal(normalized.intent.roof.pitchDegrees, 19.3);
  assert.equal(normalized.intent.facades[0]!.baseMaterialId, 'm-stone');
  assert.equal(normalized.intent.facades[0]!.bodyMaterialId, 'm-wood');
  assert.equal(normalized.intent.facades[0]!.topMaterialId, 'm-roof');
  assert.equal(normalized.intent.openings[0]!.roomId, 'sp-tea');
  assert.equal(normalized.intent.furniture[0]!.footprint.x, 2);

  const requirements = exampleRequirements();
  const resolved = expandDesignIntent(
    normalized.intent,
    createIntentHost(requirements, { schemeId: 'scheme-normalized-alias' }),
  );
  const brief = compileBuildBrief(resolved.scheme, requirements);
  assert.deepEqual(lintBrief(brief, requirements), []);
  assert.ok(renderPreviewBundle(resolved.scheme).files.length >= 5);
});

test('真实失败 JSON fixture：别名可归一化，但重叠房间 / 越界家具仍严格拒绝', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/design-intent-live-failure.json', import.meta.url), 'utf8'),
  ) as unknown;
  assert.throws(
    () => normalizeDesignIntent(raw),
    (error: unknown) =>
      error instanceof IntentValidationError &&
      !error.message.includes('structure.system') &&
      /面积重叠|放不进房间内矩形|没有可用面积/.test(error.message),
  );
});

test('负数 / NaN / 零宽 / 未知字段仍失败；超大 offset 交给 expand clamp', () => {
  const negative = draftFromExample();
  openingsOf(negative)[0]!['offset'] = -1;
  assert.throws(
    () => normalizeDesignIntent(negative),
    (error: unknown) => error instanceof IntentValidationError && error.path.includes('openings.0.offset'),
  );

  const nan = draftFromExample();
  openingsOf(nan)[0]!['width'] = Number.NaN;
  assert.throws(() => normalizeDesignIntent(nan), /DesignIntentDraft/);

  const zeroWidth = draftFromExample();
  openingsOf(zeroWidth)[0]!['width'] = 0.4;
  assert.throws(
    () => normalizeDesignIntent(zeroWidth),
    (error: unknown) => error instanceof IntentValidationError && error.message.includes('width 必须 ≥ 1'),
  );

  const outside = draftFromExample();
  openingsOf(outside)[0]!['offset'] = 100;
  assert.equal(normalizeDesignIntent(outside).intent.openings[0]?.offset, 100);

  const unknown = draftFromExample();
  openingsOf(unknown)[0]!['surprise'] = 1;
  assert.throws(() => normalizeDesignIntent(unknown), /DesignIntentDraft/);
});

test('真实失败形态：室外分区与房间重叠时丢弃分区并警告，房间 / 几何 / 报告仍保留', () => {
  const normalized = normalizeDesignIntent(sidePavilionDraft());
  assert.deepEqual(
    normalized.intent.site.outdoorZones.map((zone) => zone.id),
    ['zone-terrace', 'zone-garden'],
  );

  const zoneWarnings = normalized.warnings.filter((warning) => warning.code === 'outdoor-zone-overlap-dropped');
  assert.equal(zoneWarnings.length, 2);
  const west = zoneWarnings.find((warning) => warning.path === 'site.outdoorZones.oz-corridor-west');
  assert.ok(west !== undefined);
  assert.match(west.message, /oz-corridor-west/);
  assert.match(west.message, /sp-side-pavilion-west/);
  assert.match(west.message, /已丢弃该室外分区/);
  const east = zoneWarnings.find((warning) => warning.path === 'site.outdoorZones.oz-corridor-east');
  assert.ok(east !== undefined);
  assert.match(east.message, /oz-corridor-east/);
  assert.match(east.message, /sp-side-pavilion-east/);

  const droppedFurniture = normalized.warnings.find((warning) => warning.code === 'furniture-zone-dropped');
  assert.equal(droppedFurniture?.path, 'furniture.fu-corridor-bench');
  assert.equal(
    normalized.intent.furniture.some((item) => item.id === 'fu-corridor-bench'),
    false,
  );

  const requirements = exampleRequirements();
  const resolved = expandDesignIntent(
    normalized.intent,
    createIntentHost(requirements, { schemeId: 'scheme-side-pavilion' }),
  );
  assert.deepEqual(
    resolved.scheme.site.outdoorZones.map((zone) => zone.id),
    ['zone-terrace', 'zone-garden'],
  );
  assert.equal(resolved.scheme.spaces.filter((space) => space.kind === 'outdoor').length, 2);
  assert.equal(
    resolved.warnings.some((warning) => warning.code === 'outdoor-zone-overlap-dropped'),
    false,
  );
  const brief = compileBuildBrief(resolved.scheme, requirements);
  assert.deepEqual(lintBrief(brief, requirements), []);
  assert.match(compileDesignReport(resolved.scheme), /稻田茶亭/);
  assert.ok(renderPreviewBundle(resolved.scheme).files.length >= 5);
});

test('全部室外分区都与房间重叠时清空 outdoorZones，展开仍成功', () => {
  const draft = draftFromExample();
  siteOf(draft).outdoorZones = [
    {
      id: 'zone-terrace',
      name: '南侧檐下平台',
      kind: 'terrace',
      rect: { x: [5, 12], z: [8, 12] },
      materialId: 'm-stone',
      notes: null,
    },
    {
      id: 'zone-garden',
      name: '南侧草地',
      kind: 'garden',
      rect: { x: [12, 16], z: [8, 12] },
      materialId: 'm-grass',
      notes: null,
    },
  ];
  const normalized = normalizeDesignIntent(draft);
  assert.deepEqual(normalized.intent.site.outdoorZones, []);
  assert.equal(normalized.warnings.filter((warning) => warning.code === 'outdoor-zone-overlap-dropped').length, 2);

  const requirements = exampleRequirements();
  const resolved = expandDesignIntent(
    normalized.intent,
    createIntentHost(requirements, { schemeId: 'scheme-all-zones-dropped' }),
  );
  assert.deepEqual(resolved.scheme.site.outdoorZones, []);
  assert.equal(resolved.scheme.spaces.filter((space) => space.kind === 'outdoor').length, 0);
  assert.deepEqual(lintBrief(compileBuildBrief(resolved.scheme, requirements), requirements), []);
  assert.match(compileDesignReport(resolved.scheme), /稻田茶亭/);
});

test('expand 兜底：绕过 normalize 的重叠分区也被丢弃并警告', () => {
  const draft = draftFromExample();
  siteOf(draft).outdoorZones.push({
    id: 'oz-corridor-west',
    name: '西侧连廊',
    kind: 'path',
    rect: { x: [5, 12], z: [8, 12] },
    materialId: 'm-stone',
    notes: null,
  });
  const requirements = exampleRequirements();
  const resolved = expandDesignIntent(draft, createIntentHost(requirements, { schemeId: 'scheme-expand-fallback' }));
  assert.equal(
    resolved.scheme.site.outdoorZones.some((zone) => zone.id === 'oz-corridor-west'),
    false,
  );
  const warning = resolved.warnings.find((item) => item.code === 'outdoor-zone-overlap-dropped');
  assert.ok(warning !== undefined);
  assert.equal(warning.path, 'site.outdoorZones.oz-corridor-west');
  assert.match(warning.message, /oz-corridor-west/);
  assert.match(warning.message, /sp-tea/);
  assert.deepEqual(lintBrief(compileBuildBrief(resolved.scheme, requirements), requirements), []);
});
