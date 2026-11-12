/**
 * build-playbook：fixed 交接手册的可见正文锁定。
 *
 * 负责：六阶段、基准面、API 地图、茶亭骨架与 "no steps by default" 的关键句；
 * 不负责：system.ts 的插入位置与 free 分支逐字节不变（见 system.test.ts）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUILD_PLAYBOOK_SECTION } from './build-playbook.ts';

const PHASES = [
  'Plan（计划，不写代码）',
  'Ground / envelope（地面与围护）',
  'Roof（屋面）',
  'Interior（室内）',
  'Detail（细部）',
  'Self-check / submit（自检与提交）',
] as const;

describe('BUILD_PLAYBOOK_SECTION', () => {
  it('六阶段齐全，每阶段都有验证点与 assert returned bounds', () => {
    for (const phase of PHASES) assert.ok(BUILD_PLAYBOOK_SECTION.includes(phase), `缺少：${phase}`);
    assert.equal((BUILD_PLAYBOOK_SECTION.match(/验证点：/g) ?? []).length, 6);
    assert.ok((BUILD_PLAYBOOK_SECTION.match(/assert returned bounds/g) ?? []).length >= 6);
  });

  it('构件配方覆盖楼板、洞口、家具、材质与屋面，且位于六阶段与 API 地图之间', () => {
    for (const text of [
      '### 构件配方（照做，不临场发挥）',
      '石基座与室内地面必须是同一个 y0 层',
      '把 y 厚度量成 2',
      '不要写进洞口',
      '半开',
      '窗玻璃正好占满窗 bounds',
      '用且只用该条 `materialId` 填满该体积',
      'bench 4×1×1 → 5 个座位',
      '至少 90%',
      '主坡只调 `roof({ peakY })`',
      '`家具核对` 行',
      '`probe({ box: bounds })`',
      '不做任何隔断',
      '不设踏步',
      '除 `opening` 自己写入的玻璃填充外',
      '窗台 slab',
      '不要用 stairs',
      '落地玻璃',
      '墙格至少 90%',
      '四角铺装会被判成外挑基座',
    ]) {
      assert.ok(BUILD_PLAYBOOK_SECTION.includes(text), `缺少：${text}`);
    }
    const recipes = BUILD_PLAYBOOK_SECTION.indexOf('### 构件配方');
    assert.ok(recipes > BUILD_PLAYBOOK_SECTION.indexOf('6. **Self-check / submit'));
    assert.ok(recipes < BUILD_PLAYBOOK_SECTION.indexOf('### 常用 API 地图'));
  });

  it('基准面、半开 bounds 与洞口口径明确', () => {
    for (const text of [
      '楼板占 y0，站立面 y1，门洞 y1..2，窗洞 y2..3',
      '洞口 bounds 是半开格区间',
      '家具放在站立面或以上',
      '门内 1m 与楼梯口 1.2m 净空',
    ]) {
      assert.ok(BUILD_PLAYBOOK_SECTION.includes(text), `缺少：${text}`);
    }
  });

  it('API 地图包含语义构件、pitch 口径与合法挑檐', () => {
    for (const text of [
      'floorPlate({ footprint, y, thickness = 1, material })',
      'walls({ footprint, y, height, thickness = 1, material, bands? })',
      "opening({ in: facade, kind: 'door' | 'window'",
      "roof({ on: walls | colonnade, kind: 'gable'",
      'pitch 是每内缩一格升高几格：0.5 ≈ 25°，1 = 45°，它不是角度',
      '按 0 格容差对照 BuildSheet / 设计值',
      '本任务合法挑檐 1 格',
      'box / set 只做装饰、家具',
      'probe({ points | box | section })',
      'y 是板底，top = y + thickness',
      'y 是墙底，height 是格数，top = y + height',
      'width / height 是净宽 / 净高（不含框）',
      'frame 可选，不传就不外凸',
      '调用卡：数字由 BuildSheet 派生',
    ]) {
      assert.ok(BUILD_PLAYBOOK_SECTION.includes(text), `缺少：${text}`);
    }
  });

  it('茶亭骨架不再硬编码 oak 墙材，墙材从 BuildSheet wall 行读取', () => {
    assert.ok(BUILD_PLAYBOOK_SECTION.includes('WALL_BLOCK'));
    assert.ok(BUILD_PLAYBOOK_SECTION.includes('BuildSheet wall 行'));
    assert.equal(BUILD_PLAYBOOK_SECTION.includes("material: 'oak_planks'"), false);
  });

  it('茶亭骨架用语义四件套并断言 bounds；不推荐入口踏步', () => {
    for (const text of [
      'floorPlate + walls + opening + roof',
      'assertCellBounds(floor.bounds, slab',
      'assertCellBounds(hall.bounds, wall',
      'assertCellBounds(door.bounds, doorB',
      'assertCellBounds(win.bounds, windowB',
      'assertCellBounds(roof.bounds, roofB',
      'peakY: 7',
      'rect 的 max 是最后一格',
    ]) {
      assert.ok(BUILD_PLAYBOOK_SECTION.includes(text), `缺少：${text}`);
    }
    assert.doesNotMatch(BUILD_PLAYBOOK_SECTION, /入口踏步用 steps|门槛外放/);
  });
});
