/**
 * INT-LIVE-03：DesignIntent live 契约审计。
 *
 * 只做离线证明：提示词示例 → Draft → normalizer → 严格 DesignIntent → 宿主展开；
 * 提示词字段表 / JSON Schema / 历史 live 失败样本之间没有静默放宽 schema。
 * 不调用模型、不读 .env、不联网、不触发构建。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { expandDesignIntent } from './design-expand.ts';
import { DesignIntent, IntentValidationError } from './design-intent.ts';
import { DesignIntentDraft } from './design-intent-draft.ts';
import { normalizeDesignIntent } from './design-intent-normalize.ts';
import { exampleRequirements } from './example-requirements.ts';
import { createIntentHost, INTENT_FORBIDDEN_REPAIR_PATHS } from './generate-intent.ts';
import { INTENT_DRAFT_JSON_SCHEMA, INTENT_EXAMPLE, INTENT_FIELDS, INTENT_SYSTEM } from './prompts-intent.ts';
import { applyRepairPatches, INTENT_TOP_LEVEL_FIELDS, RepairSubmissionSchema } from './repair.ts';

type JsonObject = Record<string, unknown>;

const LIVE_DRAFT_PATH = new URL('../fixtures/design-intent-live-failure-2026-10-20.json', import.meta.url);
const LIVE_REPAIR_PATH = new URL('../fixtures/design-intent-live-repair-2026-10-20.json', import.meta.url);

function asObject(value: unknown, label: string): JsonObject {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `${label} 应为对象`);
  return value as JsonObject;
}

function asArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} 应为数组`);
  return value as unknown[];
}

function propertyOf(object: JsonObject, key: string): unknown {
  return object[key];
}

function fieldLine(section: string, field: string): string {
  const line = section.split('\n').find((candidate) => candidate.startsWith(`- ${field}：`));
  assert.ok(line !== undefined, `INTENT_SYSTEM 的字段表缺少 ${field}`);
  return line;
}

function sectionBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `缺少段落：${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `缺少段落结束：${endMarker}`);
  return text.slice(start + startMarker.length, end);
}

function embeddedIntentExample(system: string): JsonObject {
  const section = sectionBetween(system, '## 完整最小 DesignIntent JSON 示例', '\n示例已覆盖');
  const start = section.indexOf('```json');
  assert.notEqual(start, -1, '示例缺少 ```json fence');
  const bodyStart = start + '```json'.length;
  const end = section.indexOf('```', bodyStart);
  assert.notEqual(end, -1, '示例缺少结束 fence');
  return asObject(JSON.parse(section.slice(bodyStart, end).trim()) as unknown, 'INTENT_SYSTEM 示例');
}

function collectRefs(node: unknown, path: string, refs: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      collectRefs(item, `${path}[${String(index)}]`, refs);
    });
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref') {
      const ref: unknown = value;
      assert.ok(typeof ref === 'string', `${path}.$ref 应为字符串`);
      refs.push(ref);
      continue;
    }
    collectRefs(value, `${path}.${key}`, refs);
  }
}

function resolveLocalRef(root: unknown, ref: string): unknown {
  assert.ok(ref.startsWith('#/'), `$ref 必须指向本地定义：${ref}`);
  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      assert.ok(Number.isInteger(index), `$ref 数组下标无效：${ref}`);
      current = current[index];
    } else {
      const container = asObject(current, ref);
      assert.ok(Object.hasOwn(container, segment), `$ref 未解析：${ref}`);
      current = container[segment];
    }
    assert.notEqual(current, undefined, `$ref 未解析：${ref}`);
  }
  return current;
}

function readJson(path: string | URL): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function captureError(run: () => void): Error {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Error, '抛出的不是 Error');
    return error;
  }
  assert.fail('预期抛错，但没有抛错');
}

function captureNormalizeError(value: unknown): IntentValidationError {
  const error = captureError(() => {
    normalizeDesignIntent(value);
  });
  assert.ok(error instanceof IntentValidationError, `预期 IntentValidationError，实际：${error.message}`);
  return error;
}

test('INTENT_EXAMPLE 通过 Draft → normalizer → 严格 DesignIntent，并可被宿主展开', () => {
  const draft = DesignIntentDraft.parse(INTENT_EXAMPLE);
  assert.deepEqual(Object.keys(draft), [...INTENT_FIELDS]);
  assert.deepEqual(
    Object.keys(draft).sort(),
    [
      'decisions',
      'envelope',
      'facades',
      'furniture',
      'materials',
      'meta',
      'open',
      'openings',
      'program',
      'roof',
      'site',
      'structure',
    ].sort(),
  );

  const normalized = normalizeDesignIntent(draft);
  const intent = normalized.intent;
  assert.equal(normalized.warnings.length, 0, JSON.stringify(normalized.warnings));
  assert.equal(DesignIntent.safeParse(intent).success, true);
  assert.equal(intent.meta.title, INTENT_EXAMPLE.meta.title);

  const requirements = exampleRequirements();
  const resolved = expandDesignIntent(
    intent,
    createIntentHost(requirements, { schemeId: 'scheme-intent-contract', revision: 1, maxBlocks: 20_000 }),
  );

  assert.deepEqual(resolved.intent, intent);
  assert.equal(resolved.scheme.meta.id, 'scheme-intent-contract');
  assert.deepEqual(resolved.scheme.meta.sourceRequirements, {
    graphId: requirements.id,
    revision: requirements.revision,
  });
  assert.deepEqual(resolved.facts.buildingBounds, { min: [3, 1, 3], max: [11, 4, 9] });
  assert.equal(resolved.facts.entranceSide, 'south');
  assert.equal(resolved.facts.counts.levels, 1);
  assert.equal(resolved.facts.counts.rooms, 1);
  assert.equal(resolved.facts.counts.walls, 4);
  assert.equal(resolved.facts.counts.exteriorWalls, 4);
  assert.equal(resolved.facts.counts.sharedWalls, 0);
  assert.equal(resolved.facts.counts.openings, 2);
  assert.equal(resolved.facts.counts.furniture, 4);
  assert.equal(resolved.scheme.roof.form, 'gable');
  assert.equal(resolved.scheme.roof.eaveHeight, 4);
  assert.equal(resolved.scheme.interiors[0]?.furnitureSpecs.length, 3);
  const terraceInterior = resolved.scheme.interiors.find((interior) => interior.spaceId === 'zone-terrace');
  assert.ok(terraceInterior !== undefined);
  assert.deepEqual(
    terraceInterior.furnitureSpecs.map((spec) => spec.id),
    ['f-terrace-bench'],
  );
});

test('INTENT_DRAFT_JSON_SCHEMA 顶层恰好 12 字段，关键路径存在且所有 $ref 可本地解析', () => {
  const schema = asObject(INTENT_DRAFT_JSON_SCHEMA, 'INTENT_DRAFT_JSON_SCHEMA');
  assert.equal(schema['type'], 'object');
  assert.equal(schema['additionalProperties'], false);

  const properties = asObject(schema['properties'], 'schema.properties');
  assert.equal(Object.keys(properties).length, 12);
  assert.deepEqual(Object.keys(properties), [...INTENT_FIELDS]);

  const metaProperties = asObject(asObject(properties['meta'], 'schema.meta')['properties'], 'schema.meta.properties');
  assert.ok(Object.hasOwn(metaProperties, 'title'));
  assert.equal(Object.hasOwn(metaProperties, 'name'), false);
  assert.equal(Object.hasOwn(metaProperties, 'description'), false);

  const siteProperties = asObject(asObject(properties['site'], 'schema.site')['properties'], 'schema.site.properties');
  const entranceProperties = asObject(
    asObject(siteProperties['entrance'], 'schema.site.entrance')['properties'],
    'schema.site.entrance.properties',
  );
  assert.ok(Object.hasOwn(entranceProperties, 'side'));

  const zoneProperties = asObject(
    asObject(asObject(siteProperties['outdoorZones'], 'schema.site.outdoorZones')['items'], 'zone item')['properties'],
    'schema.site.outdoorZones.items.properties',
  );
  assert.ok(Object.hasOwn(zoneProperties, 'rect'));
  assert.equal(Object.hasOwn(zoneProperties, 'bounds'), false);

  const furnitureProperties = asObject(
    asObject(asObject(properties['furniture'], 'schema.furniture')['items'], 'furniture item')['properties'],
    'schema.furniture.items.properties',
  );
  const anchorVariants = asArray(
    asObject(furnitureProperties['anchor'], 'schema.furniture.items.anchor')['oneOf'],
    'schema.furniture.items.anchor.oneOf',
  );
  const anchorKinds = anchorVariants.map((variant, index) => {
    const variantProperties = asObject(
      asObject(variant, `anchor variant ${String(index)}`)['properties'],
      `anchor variant ${String(index)}.properties`,
    );
    return asObject(variantProperties['kind'], `anchor variant ${String(index)}.kind`)['const'];
  });
  assert.deepEqual(anchorKinds, ['center', 'wall', 'corner']);

  const footprintProperties = asObject(
    asObject(furnitureProperties['footprint'], 'schema.furniture.items.footprint')['properties'],
    'schema.furniture.items.footprint.properties',
  );
  assert.deepEqual(Object.keys(footprintProperties), ['x', 'z']);
  assert.equal(Array.isArray(footprintProperties['x']), false);

  const refs: string[] = [];
  collectRefs(schema, '$', refs);
  for (const ref of refs) {
    assert.notEqual(resolveLocalRef(schema, ref), undefined, `$ref 未解析：${ref}`);
  }

  // Draft 为了兼容真实模型，把 decisions / open 设为可省略并由 normalizer 补 []；
  // 严格 DesignIntent 仍要求这两个字段，所以这里只断言 required 是 12 字段的子集。
  const required = asArray(schema['required'], 'schema.required').map(String);
  assert.ok(required.length <= 12);
  for (const field of required) assert.ok(INTENT_FIELDS.includes(field as (typeof INTENT_FIELDS)[number]), field);
});

test('INTENT_SYSTEM 的 12 字段表与关键路径和 schema 对齐，不教旧 meta.name / meta.description', () => {
  const fieldSection = sectionBetween(INTENT_SYSTEM, '## 顶层 12 字段（required）', '## 坐标、矩形与设计规则');
  const fieldLines = [...fieldSection.matchAll(/^- ([a-z][a-zA-Z0-9]*)：/gm)].map((match) => match[1]);
  assert.deepEqual(fieldLines, [...INTENT_FIELDS]);

  const metaLine = fieldLine(fieldSection, 'meta');
  assert.match(metaLine, /\btitle\b/);
  assert.doesNotMatch(metaLine, /\bname\b/);
  assert.doesNotMatch(metaLine, /\bdescription\b/);
  assert.doesNotMatch(metaLine, /\bstyle\b/);

  const siteLine = fieldLine(fieldSection, 'site');
  assert.match(siteLine, /\bentrance\b/);
  assert.match(siteLine, /\bside\b/);
  assert.match(siteLine, /\boutdoorZones\b/);
  assert.match(siteLine, /\brect\b/);
  assert.ok(INTENT_SYSTEM.includes('site.entrance.side'));
  assert.match(INTENT_SYSTEM, /有墙、有顶、可封闭的室内空间才写 program\.rooms/);
  assert.match(INTENT_SYSTEM, /无墙或无顶的檐下平台、檐廊、露台、庭院、入口铺装一律写 site\.outdoorZones/);
  assert.match(INTENT_SYSTEM, /平台即使位于建筑轮廓内、上方有檐、与室内共边或被同一屋面覆盖/);

  const furnitureLine = fieldLine(fieldSection, 'furniture');
  assert.match(furnitureLine, /\banchor\b/);
  assert.ok(furnitureLine.includes('footprint:{x,z}'));
  assert.ok(INTENT_SYSTEM.includes('anchor = {"kind":"center"}'));
  assert.ok(INTENT_SYSTEM.includes('"kind":"wall"'));
  assert.ok(INTENT_SYSTEM.includes('"kind":"corner"'));

  // 精确检查旧字段路径；不能简单搜索 name，因为 name 是房间 / 材质 / 家具的合法字段。
  assert.doesNotMatch(INTENT_SYSTEM, /\bmeta\.(?:name|description|style)\b/);
  assert.doesNotMatch(INTENT_SYSTEM, /\boutdoorZones(?:\[\])?\.bounds\b/);
  assert.doesNotMatch(INTENT_SYSTEM, /\banchor\.type\b/);
  assert.doesNotMatch(INTENT_SYSTEM, /\bfootprint\s*:\s*\[/);

  const example = embeddedIntentExample(INTENT_SYSTEM);
  assert.deepEqual(example, INTENT_EXAMPLE);

  const exampleMeta = asObject(propertyOf(example, 'meta'), 'example.meta');
  assert.deepEqual(Object.keys(exampleMeta), ['title', 'concept', 'scope']);
  assert.equal(exampleMeta['title'], INTENT_EXAMPLE.meta.title);

  const exampleSite = asObject(propertyOf(example, 'site'), 'example.site');
  assert.equal(asObject(exampleSite['entrance'], 'example.site.entrance')['side'], 'south');
  const exampleZones = asArray(exampleSite['outdoorZones'], 'example.site.outdoorZones');
  const exampleZone = asObject(exampleZones[0], 'example.site.outdoorZones[0]');
  assert.deepEqual(Object.keys(asObject(exampleZone['rect'], 'example zone.rect')), ['x', 'z']);
  assert.equal(Object.hasOwn(exampleZone, 'bounds'), false);

  const exampleFurniture = asArray(propertyOf(example, 'furniture'), 'example.furniture');
  const exampleAnchorKinds = exampleFurniture.map((item, index) => {
    return asObject(asObject(item, `example.furniture[${String(index)}]`)['anchor'], 'example anchor')['kind'];
  });
  assert.deepEqual(exampleAnchorKinds, ['center', 'wall', 'corner', 'center']);
  const exampleFootprint = asObject(
    asObject(exampleFurniture[0], 'example.furniture[0]')['footprint'],
    'example.furniture[0].footprint',
  );
  assert.deepEqual(Object.keys(exampleFootprint), ['x', 'z']);
  assert.equal(Array.isArray(exampleFootprint['x']), false);
});

test('历史 live 失败样本：当前 normalizer 不能修复，第一处缺口可定位，schema 不放宽', () => {
  const rawDraft = readJson(LIVE_DRAFT_PATH);
  const draftError = captureNormalizeError(rawDraft);
  assert.equal(draftError.code, 'schema-invalid');
  assert.equal(draftError.path, 'meta.title');
  assert.match(draftError.message, /meta\.title: Invalid input: expected string/);
  assert.match(draftError.message, /meta: Unrecognized keys: "name", "description", "style"/);

  const repair = RepairSubmissionSchema.parse(readJson(LIVE_REPAIR_PATH));
  assert.equal(repair.patches.length, 4);

  // 当前 repair 管线把 /site、/program 视为整段替换并直接拒绝；历史补丁第一条就撞上 /site。
  const forbiddenError = captureError(() => {
    applyRepairPatches(rawDraft, repair.patches, INTENT_TOP_LEVEL_FIELDS, INTENT_FORBIDDEN_REPAIR_PATHS);
  });
  assert.match(forbiddenError.message, /\/site.*禁止整段替换/);

  // 即使绕过 forbiddenPaths 应用全部历史补丁，normalizer 仍在 site.entrance 的第一处契约缺口失败。
  const applied = applyRepairPatches(rawDraft, repair.patches, INTENT_TOP_LEVEL_FIELDS);
  assert.equal(applied.applied.length, 4);
  const patchedError = captureNormalizeError(applied.value);
  assert.equal(patchedError.code, 'schema-invalid');
  assert.equal(patchedError.path, 'site.entrance');
  assert.match(patchedError.message, /site\.entrance: Unrecognized key: "width"/);

  const reparsed = DesignIntentDraft.safeParse(applied.value);
  if (reparsed.success) assert.fail('历史 repair 补丁不应通过当前 DesignIntentDraft');
  const issuePaths = reparsed.error.issues.map((issue) => issue.path.map(String).join('.'));
  for (const path of [
    'site.entrance',
    'site.outdoorZones.0.rect',
    'site.outdoorZones.0',
    'program.levels.0.floorMaterialId',
    'furniture.0.name',
    'furniture.0.anchor.kind',
    'furniture.0.footprint.x',
  ]) {
    assert.ok(issuePaths.includes(path), `第一处缺口链缺少 ${path}`);
  }
  assert.equal(DesignIntent.safeParse(applied.value).success, false);
});
