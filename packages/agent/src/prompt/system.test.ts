import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { WINDOW_TOOLS } from '../facts.ts';
import { TOOL_NAMES } from '../tools/schemas.ts';
import { BUILD_PLAYBOOK_SECTION } from './build-playbook.ts';
import { CRAFT_EXAMPLES, CRAFT_HINTS, CRAFT_SECTION } from './craft.ts';
import { CRAFT_SMALL_SECTION } from './craft-small.ts';
import { CRAFT2_SECTION } from './craft2.ts';
import { BLUEPRINT_SECTION, DETAIL_SECTION, REFINE_SECTION, SKELETON_SECTION } from './staged.ts';
import { FIXED_DESIGN_SECTION, systemPrompt } from './system.ts';
import { V02HINT_SECTION } from './v02hint.ts';

const WORLD_DTS = readFileSync(new URL(import.meta.resolve('@pg/geometry/world.d.ts')), 'utf8');
/**
 * 用这段 stub 拼出的 base system 的 sha256；锁定 base 不受 variant 分支影响。
 * 2026-10-19 小体量转向：base 与 craft-small 改用不排除室内的范围句，base 快照已同步更新；
 * 旧实验 variant 保留原句，由 OLD_VARIANTS_SHA256 锁定逐字节不变。
 */
const STUB_WORLD_DTS = 'declare const x: 1;';
const BASE_SYSTEM_SHA256 = 'be61a942474dc13c1cb75ee6c13db94689d2b189846bc69d38572b26d0ab4027';
/** 新旧范围句：base / craft-small 用新句，旧实验 variant 保留旧句以维持逐字节不变。 */
const NEW_SCOPE =
  '默认完成外观、入口与可进入；题面或设计报告明确要求室内、家具、楼层时，室内也必须完成并达到与外观同等质量。';
const OLD_SCOPE = '本阶段只做外观与可进入，不做内饰。';
/** 旧 variant 的输出 = 当前 base 只把范围句换回旧句，再加各自附加段；用于长度与拼接断言。 */
function legacyBase(base: string): string {
  assert.ok(base.includes(NEW_SCOPE), '当前 base 应含新范围句');
  return base.replace(NEW_SCOPE, OLD_SCOPE);
}
/** 2026-10-19 加入 craft-small 前旧 variant 输出的合并 sha256；锁定旧实验提示逐字节不变。 */
const OLD_VARIANTS_SHA256 = 'ccf3cb6b6a473e317c795b555120518772991bcea2aa9b041d2d7054c37f0e56';

/**
 * 自由造型路由句（决策 #112 修订，两组对称、任务无关）：
 * `A_GUIDANCE` 只在 massing host 接线时出现，`B_GUIDANCE` 只在 host 未接线时出现。
 * 两句共享同一开头（"长度相近、任务无关"），逐字锁定，防止任一方偷看对方机制。
 */
const GUIDANCE_LEAD = '当需求包含现有构件不易表达的自由造型（如连续凹曲屋面、穹顶、任意旋转体等）时，';
const A_GUIDANCE = `${GUIDANCE_LEAD}先用 massing 生成草模，再用 world.massingImport('massing#N', …) 把它并进建筑；草模定形体，施工细节仍用构件补。`;
const B_GUIDANCE = `${GUIDANCE_LEAD}用 world.surfaceShell 直接成形：kind:'surface' 写 (u,v) 公式，kind:'revolve' 写母线；参数与限制见下方声明。`;

const prompt = systemPrompt({ worldDts: WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS });
const [conventions = ''] = prompt.split('```ts\n');

describe('systemPrompt', () => {
  it('variant base 的 system 快照逐字节锁定（sha256）', () => {
    const out = systemPrompt({ worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS });
    assert.equal(createHash('sha256').update(out).digest('hex'), BASE_SYSTEM_SHA256);
  });

  it('variant 缺省等于显式 base，且不含 craft 内容', () => {
    const dflt = systemPrompt({ worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS });
    const base = systemPrompt({
      worldDts: STUB_WORLD_DTS,
      maxTurns: 60,
      submitWindow: 3,
      windowTools: WINDOW_TOOLS,
      variant: 'base',
    });
    assert.equal(dflt, base);
    assert.ok(!base.includes('形态方块'));
    assert.ok(!base.includes('范例代码'));
    // 默认提示不再无条件排除室内；旧实验 variant 的旧句由下一条用例锁定。
    assert.ok(base.includes(NEW_SCOPE));
    assert.ok(!base.includes(OLD_SCOPE));
  });

  it('designAuthority：fixed 在"工作方式"后追加已确认方案；free / 缺省逐字节不变', () => {
    const params = { worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS } as const;
    const dflt = systemPrompt(params);
    assert.equal(systemPrompt({ ...params, designAuthority: 'free' }), dflt);
    const fixed = systemPrompt({ ...params, designAuthority: 'fixed' });
    const work = fixed.indexOf('## 工作方式');
    const section = fixed.indexOf('## 已确认方案');
    const api = fixed.indexOf('## World API 声明');
    assert.ok(work >= 0 && work < section && section < api);
    assert.ok(fixed.includes(FIXED_DESIGN_SECTION));
    for (const text of [
      'design.md 是用户确认的唯一方案依据',
      '不得改变主要布局、房间用途 / 数量、外部尺寸、层高、入口、主要屋面 / 主要材质、用户点名细节',
      '可自行处理构造、局部装饰、铺装图案、灯具与家具细节',
      '停止并报告冲突，不自行改方案',
    ]) {
      assert.ok(fixed.includes(text), `缺少：${text}`);
    }
    // 去掉 fixed 段与施工手册后与 free / 缺省逐字节相同，证明 free 分支没有其它变化。
    assert.equal(fixed.replace(`${FIXED_DESIGN_SECTION}\n${BUILD_PLAYBOOK_SECTION}\n`, ''), dflt);
    assert.ok(fixed.includes(BUILD_PLAYBOOK_SECTION));
    assert.ok(section < fixed.indexOf('## 施工手册'));

    const small = systemPrompt({ ...params, variant: 'craft-small', designAuthority: 'fixed' });
    const smallSection = small.indexOf('## 小体量');
    assert.ok(work < section && section < smallSection, 'fixed 段应在 variant 附加段之前');
  });

  it('施工手册：fixed 专属、六阶段齐全、API 地图与茶亭骨架在 world.d.ts 之前', () => {
    const params = { worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS } as const;
    const free = systemPrompt({ ...params, designAuthority: 'free' });
    const dflt = systemPrompt(params);
    const fixed = systemPrompt({ ...params, designAuthority: 'fixed' });
    assert.equal(free, dflt, 'free 必须与缺省逐字节相同');
    assert.ok(!free.includes(BUILD_PLAYBOOK_SECTION), 'free 不应出现施工手册');
    assert.ok(!free.includes('## 施工手册'), 'free 不应出现施工手册标题');
    assert.ok(fixed.includes(BUILD_PLAYBOOK_SECTION));
    assert.ok(fixed.indexOf('## 施工手册') < fixed.indexOf('## World API 声明'));

    // 六阶段与每阶段的验证点：缺一个就是手册退化成泛泛建议。
    for (const phase of [
      'Plan（计划，不写代码）',
      'Ground / envelope（地面与围护）',
      'Roof（屋面）',
      'Interior（室内）',
      'Detail（细部）',
      'Self-check / submit（自检与提交）',
    ]) {
      assert.ok(fixed.includes(phase), `缺少阶段：${phase}`);
    }
    assert.equal((fixed.match(/验证点：/g) ?? []).length, 6, '六阶段各应有一个验证点');
    assert.equal((fixed.match(/assert returned bounds/g) ?? []).length >= 6, true);

    // datum、API 地图、pitch 口径与 probe。
    for (const text of [
      '楼板占 y0，站立面 y1，门洞 y1..2，窗洞 y2..3',
      '洞口 bounds 是半开格区间',
      'floorPlate',
      'walls',
      'opening',
      'roof',
      'facade',
      'probe',
      'pitch 是每内缩一格升高几格：0.5 ≈ 25°，1 = 45°，它不是角度',
      '合法挑檐 1 格',
      'box / set 只做装饰、家具',
      'floorPlate + walls + opening + roof',
      "kind: 'gable', ridge: 'x', peakY: 7, overhang: 1",
      '`pitch: 0.5`（≈25°）在 8m 进深上取整只能到脊 6',
    ]) {
      assert.ok(fixed.includes(text), `施工手册缺少：${text}`);
    }
    // 茶亭骨架必须真的断言 .bounds，并说明 rect 的 max 是最后一格。
    assert.ok(fixed.includes('assertCellBounds(floor.bounds, slab'));
    assert.ok(fixed.includes('assertCellBounds(roof.bounds, roofB'));
    assert.ok(fixed.includes('rect 的 max 是最后一格'));

    // 固定字符增量：free → fixed 只多了"已确认方案"与施工手册两段（各带一个换行）。
    assert.equal(
      fixed.length - free.length,
      FIXED_DESIGN_SECTION.length + BUILD_PLAYBOOK_SECTION.length + 2,
      'fixed 的字符增量应只来自两段新增文本',
    );
  });

  it('massingEnabled：false 时不写 massing / read_massing；缺省与显式 true 相同且都保留（决策 #112）', () => {
    const params = { worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS } as const;
    const off = systemPrompt({ ...params, massingEnabled: false });
    assert.ok(!off.includes('massing'), '关闭时不应出现 massing');
    assert.ok(!off.includes('read_massing'), '关闭时不应出现 read_massing');
    // probe 是 Phase 3C 新增工具；为保持 free / 缺省提示逐字节不变，它只在 fixed 施工手册里点名，
    // 因此 base 约定段不要求出现（工具本身仍由 schemas 暴露，另见 probe.test.ts）。
    for (const t of TOOL_NAMES.filter((n) => !n.includes('massing') && n !== 'probe' && n !== 'plan')) {
      assert.ok(off.includes(t), `关闭时仍应保留 ${t}`);
    }
    const dflt = systemPrompt(params);
    assert.equal(dflt, systemPrompt({ ...params, massingEnabled: true }));
    assert.ok(dflt.includes('massing'));
    assert.ok(dflt.includes('read_massing'));
  });

  it('自由造型路由四向：true 只含 A 句、false 只含 B 句，两组互不可见（决策 #112 修订）', () => {
    const params = { worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS } as const;
    const on = systemPrompt({ ...params, massingEnabled: true });
    const off = systemPrompt({ ...params, massingEnabled: false });
    // A 组（host 接线）：含 A 句，不含 B 句，也看不到 B 组机制。
    assert.ok(on.includes(A_GUIDANCE), 'A 组应含 A 句');
    assert.ok(!on.includes(B_GUIDANCE), 'A 组不应含 B 句');
    assert.ok(!on.includes('world.surfaceShell'), 'A 组不应看到 surfaceShell');
    // B 组（host 未接线）：含 B 句，不含 A 句，且无 massing / read_massing 字样。
    assert.ok(off.includes(B_GUIDANCE), 'B 组应含 B 句');
    assert.ok(!off.includes(A_GUIDANCE), 'B 组不应含 A 句');
    assert.ok(!off.includes('massing'), 'B 组不应出现 massing');
    assert.ok(!off.includes('read_massing'), 'B 组不应出现 read_massing');
    // 对称：两句同一开头，长度相近；B 组少了工具说明应更短。
    assert.ok(A_GUIDANCE.startsWith(GUIDANCE_LEAD) && B_GUIDANCE.startsWith(GUIDANCE_LEAD));
    assert.ok(Math.abs(A_GUIDANCE.length - B_GUIDANCE.length) <= 20, '两句长度应相近');
    assert.ok(off.length < on.length);
  });

  it('craft 在"工作方式"之后、world.d.ts 之前插入做法提示与两段范例', () => {
    const base = legacyBase(
      systemPrompt({
        worldDts: STUB_WORLD_DTS,
        maxTurns: 60,
        submitWindow: 3,
        windowTools: WINDOW_TOOLS,
        variant: 'base',
      }),
    );
    const craft = systemPrompt({
      worldDts: STUB_WORLD_DTS,
      maxTurns: 60,
      submitWindow: 3,
      windowTools: WINDOW_TOOLS,
      variant: 'craft',
    });
    const work = craft.indexOf('## 工作方式');
    const hints = craft.indexOf('## 形态方块');
    const examples = craft.indexOf('## 范例代码');
    const api = craft.indexOf('## World API 声明');
    assert.ok(work >= 0 && work < hints && hints < examples && examples < api);
    assert.ok(craft.includes(CRAFT_HINTS));
    assert.ok(craft.includes(CRAFT_EXAMPLES));
    assert.ok(craft.endsWith('```ts\ndeclare const x: 1;\n```\n'));
    assert.equal(craft.length - base.length, CRAFT_SECTION.length + 1);
  });
  it('craft2 在"工作方式"之后插入 §3 表面装饰版，且不改 base', () => {
    const params = { worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS } as const;
    const currentBase = systemPrompt({ ...params, variant: 'base' });
    const base = legacyBase(currentBase);
    const craft2 = systemPrompt({ ...params, variant: 'craft2' });
    const work = craft2.indexOf('## 工作方式');
    const hints = craft2.indexOf('## 形态方块');
    const decor = craft2.indexOf('## 表面装饰');
    const examples = craft2.indexOf('## 范例代码');
    const api = craft2.indexOf('## World API 声明');
    assert.ok(work >= 0 && work < hints && hints < decor && decor < examples && examples < api);
    assert.ok(craft2.includes(CRAFT2_SECTION));
    assert.ok(!craft2.includes(CRAFT_SECTION));
    assert.ok(!craft2.includes('## 立面层次'));
    assert.equal(craft2.length - base.length, CRAFT2_SECTION.length + 1);
    // craft2 分支不影响 base：默认值与显式 base 仍逐字节相同（sha256 用例另锁）。
    assert.equal(systemPrompt(params), currentBase);
  });

  it('craft-small 在"工作方式"之后、world.d.ts 之前插入小体量与室内段', () => {
    const params = { worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS } as const;
    const base = systemPrompt({ ...params, variant: 'base' });
    const small = systemPrompt({ ...params, variant: 'craft-small' });
    const work = small.indexOf('## 工作方式');
    const section = small.indexOf('## 小体量');
    const examples = small.indexOf('## 范例代码');
    const api = small.indexOf('## World API 声明');
    assert.ok(work >= 0 && work < section && section < examples && examples < api);
    assert.ok(small.includes(CRAFT_SMALL_SECTION));
    assert.ok(!small.includes(CRAFT_SECTION));
    assert.ok(!small.includes('## 立面层次'));
    assert.equal(small.length - base.length, CRAFT_SMALL_SECTION.length + 1);
    // 内容覆盖尺度、室内、有方向方块与常见失败，避免退化成"缩小版 craft"。
    for (const s of [
      '1–3 层、占地 8–30m、总方块 5k–30k',
      '层高 3.2–4.0m',
      '门洞 2.1–2.4m',
      '窗台离室内地面 0.8–1.0m',
      '檐口外挑 0.6–2.0m',
      '栏杆/女儿墙 0.9–1.1m',
      '室内必须完成，不能只做空壳',
      'stairs：facing 指向上坡/高侧',
      'half=lower|upper',
      'trapdoor：facing 按安装面写',
      'fence_gate：facing、open=true|false',
      'axis=x|y|z',
      '缩小版哥特',
      '单色盒子',
      '无收口平顶',
      '超大屋檐压墙',
      '门洞被填死',
      '楼梯净空不足',
      '家具挡住动线',
      '室内无光',
      '室内空壳',
    ]) {
      assert.ok(small.includes(s), `craft-small 缺少：${s}`);
    }
    assert.equal((CRAFT_SMALL_SECTION.match(/```ts/g) ?? []).length, 3);
  });

  it('加入 craft-small 后旧 variant 逐字节不变：只换回旧范围句 + 各自附加段', () => {
    const params = { worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS } as const;
    const oldBase = legacyBase(systemPrompt({ ...params, variant: 'base' }));
    const old = [
      ['craft', CRAFT_SECTION],
      ['craft2', CRAFT2_SECTION],
      ['v02hint', V02HINT_SECTION],
      ['skeleton', SKELETON_SECTION],
      ['blueprint', BLUEPRINT_SECTION],
    ] as const;
    for (const [variant, section] of old) {
      const out = systemPrompt({ ...params, variant });
      assert.equal(out, oldBase.replace('## World API 声明', `${section}\n## World API 声明`), variant);
      assert.ok(!out.includes(CRAFT_SMALL_SECTION), `${variant} 不应混入 craft-small`);
      assert.ok(out.includes(OLD_SCOPE), `${variant} 应保留旧范围句`);
      assert.ok(!out.includes(NEW_SCOPE), `${variant} 不应使用新范围句`);
    }
    for (const [variant, sections] of [
      ['detail', `${CRAFT_SECTION}\n${DETAIL_SECTION}`],
      ['refine', `${CRAFT_SECTION}\n${REFINE_SECTION}`],
    ] as const) {
      const out = systemPrompt({ ...params, variant });
      assert.equal(out, oldBase.replace('## World API 声明', `${sections}\n## World API 声明`), variant);
      assert.ok(!out.includes(CRAFT_SMALL_SECTION), `${variant} 不应混入 craft-small`);
      assert.ok(out.includes(OLD_SCOPE), `${variant} 应保留旧范围句`);
    }
    // 合并快照：同时锁定七个旧 variant 的完整输出（含旧范围句与各自附加段）。
    const variants = ['craft', 'craft2', 'v02hint', 'skeleton', 'detail', 'blueprint', 'refine'] as const;
    const combined = variants.map((variant) => systemPrompt({ ...params, variant })).join('\n---\n');
    assert.equal(createHash('sha256').update(combined).digest('hex'), OLD_VARIANTS_SHA256);
  });

  it('v02hint 在"工作方式"之后、world.d.ts 之前插入 v0.2 删减稿，且不改 base', () => {
    const params = { worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS } as const;
    const currentBase = systemPrompt({ ...params, variant: 'base' });
    const base = legacyBase(currentBase);
    const v02hint = systemPrompt({ ...params, variant: 'v02hint' });
    const work = v02hint.indexOf('## 工作方式');
    const hints = v02hint.indexOf('## 形态方块');
    const api = v02hint.indexOf('## World API 声明');
    assert.ok(work >= 0 && work < hints && hints < api);
    assert.ok(v02hint.includes(V02HINT_SECTION));
    assert.ok(!v02hint.includes(CRAFT_SECTION));
    assert.equal(v02hint.length - base.length, V02HINT_SECTION.length + 1);
    // 加入 v02hint 分支后 base 仍与显式 base、默认值逐字节相同（sha256 用例另锁）。
    assert.equal(systemPrompt(params), currentBase);
  });
  it('skeleton 只含骨架段、不含 craft 范例；detail 在 craft 之上叠加"骨架已冻结"', () => {
    const params = { worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS } as const;
    const base = legacyBase(systemPrompt({ ...params, variant: 'base' }));

    const skeleton = systemPrompt({ ...params, variant: 'skeleton' });
    const work = skeleton.indexOf('## 工作方式');
    const api = skeleton.indexOf('## World API 声明');
    assert.ok(work >= 0 && work < api);
    assert.ok(skeleton.includes('只搭骨架'));
    assert.ok(skeleton.includes(SKELETON_SECTION));
    assert.ok(!skeleton.includes('## 范例代码'));
    assert.equal(skeleton.length - base.length, SKELETON_SECTION.length + 1);

    const detail = systemPrompt({ ...params, variant: 'detail' });
    const examples = detail.indexOf('## 范例代码');
    const frozen = detail.indexOf('骨架已冻结');
    const detailApi = detail.indexOf('## World API 声明');
    assert.ok(examples >= 0 && frozen > examples && frozen < detailApi);
    assert.ok(detail.includes(CRAFT_SECTION));
    assert.ok(detail.includes(DETAIL_SECTION));
    assert.equal(detail.length - base.length, CRAFT_SECTION.length + DETAIL_SECTION.length + 2);
  });

  it('blueprint 含"先写设计文档"骨架层段、不含 craft 范例', () => {
    const params = { worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS } as const;
    const base = legacyBase(systemPrompt({ ...params, variant: 'base' }));
    const blueprint = systemPrompt({ ...params, variant: 'blueprint' });
    const work = blueprint.indexOf('## 工作方式');
    const section = blueprint.indexOf('## 本阶段：先写设计文档');
    const api = blueprint.indexOf('## World API 声明');
    assert.ok(work >= 0 && work < section && section < api);
    assert.ok(blueprint.includes('先写设计文档'));
    assert.ok(blueprint.includes(BLUEPRINT_SECTION));
    assert.ok(!blueprint.includes('## 范例代码'));
    assert.equal(blueprint.length - base.length, BLUEPRINT_SECTION.length + 1);
  });

  it('refine 含 craft 范例与"自己的细化设计文档"段', () => {
    const params = { worldDts: STUB_WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS } as const;
    const base = legacyBase(systemPrompt({ ...params, variant: 'base' }));
    const refine = systemPrompt({ ...params, variant: 'refine' });
    const examples = refine.indexOf('## 范例代码');
    const section = refine.indexOf('## 本阶段：先写细化设计文档');
    const api = refine.indexOf('## World API 声明');
    assert.ok(examples >= 0 && section > examples && section < api);
    assert.ok(refine.includes('自己的细化设计文档'));
    assert.ok(refine.includes(CRAFT_SECTION));
    assert.ok(refine.includes(REFINE_SECTION));
    assert.equal(refine.length - base.length, CRAFT_SECTION.length + REFINE_SECTION.length + 2);
  });

  it('world.d.ts 全文原样放在末尾的代码块里', () => {
    assert.ok(prompt.endsWith(`\`\`\`ts\n${WORLD_DTS}\`\`\`\n`));
    assert.equal(prompt.split('```ts\n').length, 2);
  });

  it('确定：同输入逐字节相同', () => {
    assert.equal(
      systemPrompt({ worldDts: WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS }),
      prompt,
    );
  });

  it('约定段提到的 snake_case 名字，除方块 id 外都是工具名；base 工具都被提到（probe 见 fixed 手册）', () => {
    const blockIds = new Set([...WORLD_DTS.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
    const words = new Set([...conventions.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]));
    const nonBlock = [...words].filter((w) => !blockIds.has(w)).sort();
    // probe / plan 在 fixed 施工手册里点名；free 约定段为锁定逐字节不变而不写它们。
    assert.deepEqual(nonBlock, TOOL_NAMES.filter((t) => t.includes('_') && t !== 'probe' && t !== 'plan').sort());
    for (const t of TOOL_NAMES.filter((n) => n !== 'probe' && n !== 'plan'))
      assert.ok(conventions.includes(t), `约定段没有提到 ${t}`);
    const fixed = systemPrompt({
      worldDts: STUB_WORLD_DTS,
      maxTurns: 60,
      submitWindow: 3,
      windowTools: WINDOW_TOOLS,
      designAuthority: 'fixed',
    });
    assert.ok(fixed.includes('probe'), 'fixed 施工手册应提到 probe');
    assert.ok(fixed.includes('plan'), 'fixed 施工手册应提到 plan');
  });

  it('窗口工具是工具名的子集，轮数由参数填入', () => {
    for (const t of WINDOW_TOOLS) assert.ok((TOOL_NAMES as readonly string[]).includes(t));
    assert.ok(conventions.includes(`最后 3 轮是提交窗口：只能用 ${WINDOW_TOOLS.join('、')}`));
    const five = systemPrompt({ worldDts: WORLD_DTS, maxTurns: 60, submitWindow: 5, windowTools: WINDOW_TOOLS });
    assert.ok(five.includes('最后 5 轮是提交窗口'));
  });

  it('写明模型从声明里得不到的约定', () => {
    for (const s of [
      'x 向东、y 向上、z 向南',
      'y = 0 是地表',
      'export default function build(w: World): void',
      '不能 import',
      '默认完成外观、入口与可进入',
      '室内也必须完成并达到与外观同等质量',
      '不判合格',
      '按真人可用的真实尺度建造',
      '优先用带形状的方块',
    ]) {
      assert.ok(conventions.includes(s), `缺少：${s}`);
    }
    assert.ok(!conventions.includes('不做内饰'), '默认范围表述不应再排除室内');
  });

  it('写明 edit_code 与 check_code 可同轮、view_building 可多视图（首批运行 #3）', () => {
    assert.ok(conventions.includes('edit_code 与 check_code 可以在同一轮一起调用'));
    assert.ok(conventions.includes('一次可要多张视图（最多 4 张）'));
  });

  it('不出现 v0.2 的工具与闸门', () => {
    for (const s of ['set_checklist', 'render(', 'query_material', 'render_exterior'])
      assert.ok(!prompt.includes(s), s);
  });

  it('参数不合法时报错', () => {
    assert.throws(
      () => systemPrompt({ worldDts: WORLD_DTS, maxTurns: 60, submitWindow: 0, windowTools: WINDOW_TOOLS }),
      /submitWindow/,
    );
    assert.throws(
      () => systemPrompt({ worldDts: WORLD_DTS, maxTurns: 60, submitWindow: 1.5, windowTools: WINDOW_TOOLS }),
      /submitWindow/,
    );
    assert.throws(
      () => systemPrompt({ worldDts: '  ', maxTurns: 60, submitWindow: 3, windowTools: WINDOW_TOOLS }),
      /worldDts/,
    );
    assert.throws(
      () => systemPrompt({ worldDts: WORLD_DTS, maxTurns: 60, submitWindow: 3, windowTools: [] }),
      /windowTools/,
    );
  });

  it('maxTurns 为 null（不限轮数，决策 #87）：轮次段写"轮数不限"，不含"最后 N 轮"', () => {
    const out = systemPrompt({
      worldDts: STUB_WORLD_DTS,
      maxTurns: null,
      submitWindow: 3,
      windowTools: WINDOW_TOOLS,
    });
    const [conv = ''] = out.split('```ts\n');
    assert.ok(
      conv.includes(
        `- 轮数不限。费用或墙钟快用完时进入提交窗口：只能用 ${WINDOW_TOOLS.join('、')}。费用或墙钟用完时还没提交，就没有交付。`,
      ),
    );
    assert.ok(!conv.includes('最后 3 轮是提交窗口'));
  });

  it('worldDts 没有结尾换行时补一个，代码块仍闭合', () => {
    assert.ok(
      systemPrompt({
        worldDts: 'declare const x: 1;',
        maxTurns: 60,
        submitWindow: 3,
        windowTools: WINDOW_TOOLS,
      }).endsWith('declare const x: 1;\n```\n'),
    );
  });
});
