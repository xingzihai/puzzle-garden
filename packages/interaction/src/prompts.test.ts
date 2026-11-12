import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CAPABILITY_CARD } from './capability.ts';
import { exampleRequirements } from './example-requirements.ts';
import { exampleScheme } from './example.ts';
import { designPrompt, requirementsPrompt, schemeStagePrompt, summarizeCapabilityCard } from './prompts.ts';
import { DesignSchemeCore } from './scheme.ts';

test('需求提示词保留用户原话、已有需求图与澄清回答，并要求最多 3 个高影响问题', () => {
  const prompt = requirementsPrompt({
    userText: '想在村口做一间小茶室，稻田在南边。',
    existingRequirements: exampleRequirements(),
    answers: [{ question: '稻田在哪一侧？', answer: '南侧。' }],
  });
  assert.match(prompt.system, /RequirementGraph/);
  assert.match(prompt.system, /最多提出 3 个高影响问题/);
  assert.match(prompt.system, /代理建议不得标成 confirmed/);
  assert.match(prompt.system, /无墙或无顶的檐下平台、檐廊、露台、庭院、入口铺装必须写进 site\.outdoorZones/);
  assert.match(prompt.system, /有墙、有顶、可封闭的才写进 spaces/);
  assert.match(prompt.system, /平台即使位于建筑轮廓内/);
  assert.match(prompt.user, /想在村口做一间小茶室，稻田在南边。/);
  assert.match(prompt.user, /req-tea/);
  assert.match(prompt.user, /问：稻田在哪一侧？ 答：南侧。/);
  assert.match(prompt.user, /submit_requirements/);
  assert.ok(prompt.system.length + prompt.user.length < 30_000);
});

test('方案提示词要求完整室内、真实尺度、需求 id 与能力边界', () => {
  const prompt = designPrompt(exampleRequirements(), {
    schemeId: 'scheme-tea',
    revision: 1,
    scope: 'exterior+interior',
    maxBlocks: 20_000,
    answers: [{ question: '需要柜台吗？', answer: '需要。' }],
  });
  assert.match(prompt.system, /furnitureSpecs/);
  assert.match(prompt.system, /不能只/);
  assert.match(prompt.system, /真实尺度/);
  assert.match(prompt.system, /oak_stairs\[facing=east,half=bottom\]/);
  assert.match(prompt.system, /meta\.sourceRequirements/);
  assert.match(prompt.system, /能力卡 unsupported/);
  assert.match(prompt.user, /"id": "req-tea"/);
  assert.match(prompt.user, /方块预算上限 20000/);
  assert.match(prompt.user, /scheme-tea/);
  assert.match(prompt.user, /问：需要柜台吗？ 答：需要。/);
  assert.match(prompt.user, /submit_scheme/);
  assert.ok(prompt.system.length + prompt.user.length < 60_000);
});

test('分阶段提示只要求本阶段字段，不再重复完整 17 字段要求', () => {
  const full = exampleScheme();
  const core = DesignSchemeCore.parse({
    meta: full.meta,
    site: full.site,
    levels: full.levels,
    spaces: full.spaces,
    budget: full.budget,
    forbidden: full.forbidden,
  });
  const envelope = schemeStagePrompt('envelope', { requirements: exampleRequirements(), core });
  assert.match(envelope.system, /分阶段生成 \/ envelope/);
  assert.match(envelope.system, /elements \/ openings \/ circulation \/ structure \/ roof \/ facades \/ materials/);
  assert.match(envelope.system, /正体积|零厚度平面/);
  assert.equal(envelope.system.includes('17 个顶层字段'), false);
  assert.equal(envelope.system.includes('submit_scheme 工具提交一次'), false);
  assert.match(envelope.user, /只提交本阶段字段/);
  assert.match(envelope.user, /不能写成零厚度平面/);

  const interior = schemeStagePrompt('interior', { requirements: exampleRequirements(), core, envelope: full });
  assert.match(interior.system, /details \/ interiors \/ decisions \/ open/);
  assert.match(interior.system, /furnitureSpecs/);
  assert.equal(interior.system.includes('17 个顶层字段'), false);
});

test('方案提示词在 previousScheme / feedback 时要求定向修订且保留未点名区域', () => {
  const previous = exampleScheme();
  const prompt = designPrompt(exampleRequirements(), {
    previousScheme: previous,
    feedback: '南侧屋檐再深一点，其他不要动。',
  });
  assert.match(prompt.user, /修订任务/);
  assert.match(prompt.user, /只修改用户点名或直接受影响的布局 \/ 空间 \/ 立面 \/ 室内 \/ 材质/);
  assert.match(prompt.user, /未点名区域保持上一版原样/);
  assert.match(prompt.user, /保留上一版已确认的 decisions 与 requirement 引用/);
  assert.match(prompt.user, /revision 必须从 1 递增到 2/);
  assert.match(prompt.user, /方案 id 保持 scheme-tea/);
  assert.match(prompt.user, /不重新发散成另一栋建筑/);
  assert.match(prompt.user, /南侧屋檐再深一点/);
  assert.match(prompt.user, /"id": "scheme-tea"/);
  assert.equal(prompt.user.includes('scheme-other'), false);

  const baseline = designPrompt(exampleRequirements());
  assert.equal(baseline.user.includes('修订任务'), false);
  assert.equal(baseline.user.includes('上一版方案'), false);
});

test('能力卡摘要包含不支持项、渲染限制与官方方块组合用法', () => {
  const summary = summarizeCapabilityCard();
  assert.match(summary, /实体物件/);
  assert.match(summary, /动态电梯/);
  assert.match(summary, /没有人眼高度或室内视角/);
  assert.equal(summary.includes(DEFAULT_CAPABILITY_CARD.version), false);
  assert.match(summary, /x-east-y-up-z-south/);
  assert.match(summary, /方块组合用法（官方 1.20\.1 资源目录）/);
  assert.match(summary, /活板门做柜门/);
  assert.match(summary, /栅栏 \+ 压力板做桌子/);
});
