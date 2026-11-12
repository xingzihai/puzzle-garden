import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canPromise,
  CAPABILITY_CARD_VERSION,
  capabilityItem,
  capabilityStatus,
  CapabilityCard,
  DEFAULT_CAPABILITY_CARD,
} from './capability.ts';

test('默认能力卡版本化、包含七视角与坐标上限', () => {
  assert.equal(DEFAULT_CAPABILITY_CARD.version, CAPABILITY_CARD_VERSION);
  assert.deepEqual(DEFAULT_CAPABILITY_CARD.render.views, ['south', 'east', 'north', 'west', 'top', 'iso-se', 'iso-nw']);
  assert.equal(DEFAULT_CAPABILITY_CARD.coordinates.groundY, 0);
  assert.equal(DEFAULT_CAPABILITY_CARD.coordinates.firstFloorY, 1);
  assert.match(DEFAULT_CAPABILITY_CARD.coordinates.renderSkip, /y > 0/);
  assert.ok(DEFAULT_CAPABILITY_CARD.world.blockUsage.length >= 20);
  assert.ok(DEFAULT_CAPABILITY_CARD.world.blockUsage.some((usage) => usage.name.includes('活板门')));
  assert.equal(Object.isFrozen(DEFAULT_CAPABILITY_CARD), true);
});

test('能力卡明确列出不支持的承诺', () => {
  assert.equal(capabilityStatus(DEFAULT_CAPABILITY_CARD, 'entity-objects'), 'unsupported');
  assert.equal(capabilityStatus(DEFAULT_CAPABILITY_CARD, 'dynamic-elevator'), 'unsupported');
  assert.equal(capabilityStatus(DEFAULT_CAPABILITY_CARD, 'underground-visualization'), 'partial');
  assert.equal(capabilityStatus(DEFAULT_CAPABILITY_CARD, 'walls'), 'supported');
  assert.equal(canPromise(DEFAULT_CAPABILITY_CARD, 'entity-objects'), false);
  assert.equal(canPromise(DEFAULT_CAPABILITY_CARD, 'dynamic-elevator'), false);
  assert.equal(canPromise(DEFAULT_CAPABILITY_CARD, 'walls'), true);
  assert.equal(capabilityItem(DEFAULT_CAPABILITY_CARD, 'missing-capability'), undefined);
});

test('能力卡条目 id 不重复，未知版本格式被拒绝', () => {
  const ids = [
    ...DEFAULT_CAPABILITY_CARD.world.components,
    ...DEFAULT_CAPABILITY_CARD.analysis,
    ...DEFAULT_CAPABILITY_CARD.limitations,
  ].map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(CapabilityCard.safeParse({ ...DEFAULT_CAPABILITY_CARD, version: 'v1' }).success, false);
});
