/**
 * INT-PLATFORM-01：半室外平台分类回归。
 *
 * 只做离线证明：第 3 次 live 的“轮廓内檐下平台”需求图会触发提示词纠偏；
 * 宿主确实支持把家具挂到 outdoorZone；furniture-out-of-room 的 repair 提示可读且路径可执行。
 * 不调用模型、不联网、不触发构建。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { ChatClient } from '@pg/llm/client';
import type { ChatRequest, ChatResponse, ToolCall, Usage } from '@pg/llm/schema';

import { expandDesignIntent } from './design-expand.ts';
import { DesignIntent } from './design-intent.ts';
import { exampleIntent } from './example-intent.ts';
import { exampleRequirements } from './example-requirements.ts';
import { createIntentHost, proposeIntent, REPAIR_INTENT_TOOL_NAME } from './generate-intent.ts';
import { isPlatformLikeSpace, requirementsPrompt } from './prompts.ts';
import {
  compactRequirementsForIntent,
  INTENT_EXAMPLE,
  INTENT_SYSTEM,
  INTENT_TOOL_NAME,
  intentPrompt,
} from './prompts-intent.ts';
import { RequirementGraph } from './requirements.ts';

const USAGE: Usage = {
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  prompt_cache_hit_tokens: 10,
  prompt_cache_miss_tokens: 90,
};

function livePlatformRequirements(): RequirementGraph {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/platform-in-outline-requirements.json', import.meta.url), 'utf8'),
  ) as unknown;
  return RequirementGraph.parse(raw);
}

function toolCall(name: string, value: unknown): ToolCall {
  return { id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(value) } };
}

function toolResponse(name: string, value: unknown): ChatResponse {
  return {
    id: `resp-${name}`,
    model: 'deepseek-flash',
    systemFingerprint: null,
    message: { role: 'assistant', content: null, tool_calls: [toolCall(name, value)] },
    rawArguments: [],
    finishReason: 'tool_calls',
    usage: USAGE,
    usageMismatch: false,
    timing: { firstByteMs: 0, firstTokenMs: 0, totalMs: 0 },
  };
}

function scriptedClient(script: (name: string) => unknown, requests: ChatRequest[]): ChatClient {
  return {
    complete(request) {
      requests.push(request);
      const system = request.messages[0];
      const repair = system?.role === 'system' && system.content.includes('【定点修复');
      const name = request.tools[0]?.function.name ?? (repair ? REPAIR_INTENT_TOOL_NAME : INTENT_TOOL_NAME);
      return Promise.resolve({ kind: 'ok', response: toolResponse(name, script(name)) });
    },
  };
}

function messageText(message: ChatRequest['messages'][number]): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  }
  return '';
}

/** 复现第 3 次 live：平台 11×2 写成 room；南北墙各扣 1 格后净进深为 0。 */
function platformAsRoomIntent(): Record<string, unknown> {
  const value = structuredClone(exampleIntent()) as unknown as {
    site: { outdoorZones: Record<string, unknown>[] };
    program: { rooms: Record<string, unknown>[] };
    furniture: Record<string, unknown>[];
  };
  // 平台先被误写成 room，因此 site 里不能再有同位置的 outdoorZone。
  value.site.outdoorZones = [];
  const room = (id: string): Record<string, unknown> => {
    const found = value.program.rooms.find((entry) => entry['id'] === id);
    if (found === undefined) throw new Error(`fixture 缺少房间 ${id}`);
    return found;
  };
  for (const id of ['sp-tea', 'sp-counter']) {
    const target = room(id);
    target['adjacency'] = [...(target['adjacency'] as string[]), 'sp-south-platform'];
  }
  value.program.rooms.push({
    id: 'sp-south-platform',
    name: '南侧檐下平台',
    level: 'lv-ground',
    kind: 'room',
    rect: { x: [5, 16], z: [14, 16] },
    occupancy: 2,
    adjacency: ['sp-tea', 'sp-counter'],
    daylight: 'preferred',
    notes: '10m×2m，位于建筑轮廓内南侧带，完全在檐下；非室内空间，不采暖/不封闭。',
  });
  value.furniture.push({
    id: 'f-platform-bench',
    name: '平台长凳',
    kind: 'bench',
    roomId: 'sp-south-platform',
    anchor: { kind: 'center' },
    footprint: { x: 3, z: 1 },
    orientation: 'south',
    height: 1,
    materialId: 'm-wood',
    notes: null,
  });
  return value;
}

test('第 3 次 live 需求：轮廓内檐下平台被写进 spaces 时，requirements 提示必须定向纠偏', () => {
  const requirements = livePlatformRequirements();
  const platform = requirements.spaces.find((space) => space.id === 'sp-south-platform');
  assert.ok(platform !== undefined);
  assert.match(platform.notes ?? '', /位于 10×7 轮廓内南侧带/);
  assert.match(platform.notes ?? '', /非室内空间/);
  const site = requirements.site;
  assert.ok(site !== null);
  assert.deepEqual(site.outdoorZones, []);
  assert.match(site.notes ?? '', /按建筑构件处理，不列为独立室外分区/);

  const prompt = requirementsPrompt({
    userText: '南侧 2m 深檐下平台在 10×7 轮廓内，不封闭。',
    existingRequirements: requirements,
  });
  assert.match(prompt.system, /空间分类只看围护/);
  assert.match(prompt.system, /平台即使位于建筑轮廓内、上方有檐/);
  assert.match(prompt.system, /必须写进 site\.outdoorZones/);
  assert.match(prompt.system, /禁止用“按建筑构件处理，不列为独立室外分区”作为留在 spaces 的理由/);
  assert.match(prompt.user, /## 分类校正（必须处理）/);
  assert.match(prompt.user, /sp-south-platform（南侧檐下平台）/);
  assert.match(prompt.user, /场地总尺寸未知不影响记录平台/);
  const correction = prompt.user.slice(
    prompt.user.indexOf('## 分类校正（必须处理）'),
    prompt.user.indexOf('## 能力卡摘要'),
  );
  assert.doesNotMatch(correction, /sp-main-hall/, '主厅 notes 提到平台，不能被误判为室外空间');
});

test('平台启发式不把楼梯平台误判为室外平台', () => {
  assert.equal(isPlatformLikeSpace({ name: '楼梯平台', purpose: '连接上下层', notes: null }), false);
  assert.equal(
    isPlatformLikeSpace({
      name: '主厅',
      purpose: '完整矩形室内空间',
      notes: '南侧 2m 带为檐下平台；平台在轮廓内。',
    }),
    false,
  );
  assert.equal(isPlatformLikeSpace({ name: '南侧檐下平台', purpose: '看溪停留', notes: null }), true);
  assert.equal(isPlatformLikeSpace({ name: '入口铺装', purpose: '衔接村道', notes: null }), true);
});

test('intent brief 对需求图中的平台 space 给出分类校正，而不是照抄成 room', () => {
  const requirements = livePlatformRequirements();
  const brief = compactRequirementsForIntent(requirements);
  assert.match(brief, /## 分类校正（需求图有误，必须覆盖）/);
  assert.match(brief, /sp-south-platform（南侧檐下平台）/);
  assert.match(brief, /不要照抄成 room/);
  assert.match(brief, /平台即使位于建筑轮廓内/);
  assert.match(brief, /anchor 只用 center \/ corner/);
  const correction = brief.slice(brief.indexOf('## 分类校正'), brief.indexOf('## 可用材质'));
  assert.doesNotMatch(correction, /sp-main-hall/, '主厅 notes 提到平台，不能被误判为室外空间');

  const prompt = intentPrompt(requirements, {
    schemeId: 'scheme-platform',
    revision: 4,
    maxBlocks: 20_000,
  });
  assert.match(prompt.system, /空间分类只看围护/);
  assert.match(prompt.system, /平台即使位于建筑轮廓内、上方有檐、与室内共边或被同一屋面覆盖/);
  assert.match(prompt.system, /roomId 只能指 program\.rooms/);
  assert.match(prompt.system, /室外分区只能用 center \/ corner/);
  assert.match(prompt.user, /## 分类校正（需求图有误，必须覆盖）/);
});

test('宿主支持 outdoorZone 家具：示例平台长凳展开为 zone 室内条目', () => {
  const intent = DesignIntent.parse(INTENT_EXAMPLE);
  const resolved = expandDesignIntent(
    intent,
    createIntentHost(exampleRequirements(), { schemeId: 'scheme-platform', revision: 1 }),
  );
  const zone = resolved.scheme.spaces.find((space) => space.id === 'zone-terrace');
  assert.equal(zone?.kind, 'outdoor');
  const interior = resolved.scheme.interiors.find((entry) => entry.spaceId === 'zone-terrace');
  assert.ok(interior !== undefined);
  assert.deepEqual(
    interior.furnitureSpecs.map((spec) => spec.id),
    ['f-terrace-bench'],
  );
  assert.deepEqual(interior.furnitureSpecs[0]?.bounds, {
    min: [6, 0, 10],
    max: [8, 1, 11],
  });
  assert.equal(resolved.scheme.interiors.find((entry) => entry.spaceId === 'tea')?.furnitureSpecs.length, 3);
  assert.equal(resolved.facts.counts.furniture, 4);
  assert.equal(
    resolved.warnings.some((warning) => warning.code === 'furniture-dropped' || warning.code === 'furniture-relocated'),
    false,
  );
});

test('furniture-out-of-room repair 提示包含平台迁移与室内扩大的可执行路径', async () => {
  const requirements = exampleRequirements();
  const broken = platformAsRoomIntent();
  const requests: ChatRequest[] = [];
  const client = scriptedClient((name) => {
    if (name === INTENT_TOOL_NAME) return broken;
    if (name === REPAIR_INTENT_TOOL_NAME) {
      return { patches: [{ path: '/furniture/3', op: 'remove' }] };
    }
    throw new Error(`未知工具 ${name}`);
  }, requests);

  const result = await proposeIntent(
    client,
    requirements,
    createIntentHost(requirements, { schemeId: 'scheme-platform-repair', revision: 1 }),
  );
  assert.equal(result.repairRoundCount, 1);

  const repairRequest = requests.find((request) => request.tools[0]?.function.name === REPAIR_INTENT_TOOL_NAME);
  assert.ok(repairRequest !== undefined);
  const repairText = repairRequest.messages.map(messageText).join('\n');
  assert.match(repairText, /\/furniture\/3: furniture\.f-platform-bench: 空间 sp-south-platform 扣墙后没有可用面积/);
  assert.match(repairText, /无墙无顶的半室外平台/);
  assert.match(repairText, /site\/outdoorZones\/-/);
  assert.match(repairText, /家具 roomId 改为新 outdoorZone id/);
  assert.match(repairText, /扩大房间或缩小家具/);
  assert.equal(INTENT_SYSTEM.includes('/furniture/f-platform-bench'), false);
});
