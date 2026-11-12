/** 部件生成的好坏样本：影院加宽只动西侧、楼梯模块级数与平台标高、商铺随西墙同步、公园扣挑空。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Element } from './schema.ts';
import { cinemaHall, clothingShop, foodShop, jewelryShop, stairModule } from './example-interiors.ts';

function byId(elements: readonly Element[], id: string): Element {
  const found = elements.find((item) => item.id === id);
  if (found === undefined) throw new Error(`找不到元素 ${id}`);
  return found;
}

function hall(elements: readonly Element[], id: string): Element {
  return byId(elements, id);
}

test('楼梯模块：两跑各 4 级、上平台 u[4,8)、电梯门只在停靠层（下三单位）', () => {
  const elements = stairModule({
    idPrefix: 'el-m',
    name: '交通组',
    level: 'b2',
    originX: 28,
    originZ: 29,
    baseFloor: -16,
  });
  const run1 = elements.filter((item) => item.id.startsWith('el-m-run1-'));
  const run2 = elements.filter((item) => item.id.startsWith('el-m-run2-'));
  assert.equal(run1.length, 4);
  assert.equal(run2.length, 4);
  assert.equal(byId(elements, 'el-m-landing-high').bounds.min[1], -16 + 7);
  assert.equal(byId(elements, 'el-m-landing-mid').bounds.min[1], -16 + 3);
  // 上平台从 u=4 起，与下平台 u[1,4) 拼成完整 u[1,8) 转接平台
  assert.equal(byId(elements, 'el-m-landing-high').bounds.min[0], 28 + 4);
  assert.equal(byId(elements, 'el-m-landing-low').bounds.max[0], 28 + 4);
  const northWall = elements.filter((item) => item.id.startsWith('el-m-lift-n-'));
  assert.equal(northWall.length, 3, '电梯北墙：两侧 + 门上过梁');
  // 门洞 x[39,41) 在下三单位内无井壁实体（过梁只在其上）
  assert.equal(
    northWall.some((item) => item.bounds.min[0] < 41 && 39 < item.bounds.max[0] && item.bounds.min[1] < -16 + 3),
    false,
  );
  assert.equal(byId(elements, 'el-m-lift-w').bounds.max[1], -16 + 8, 'base-only 井壁只到 f+8');
  assert.equal(byId(elements, 'el-m-lift-n-beam-1').bounds.min[1], -16 + 3);
  assert.equal(byId(elements, 'el-m-escalator-reserved').kind, 'marker');
});

test('站厅 both：base 门 [f,f+3) 与 top 门 [f+8,f+11) 都开，井壁盖到 f+12', () => {
  const elements = stairModule({
    idPrefix: 'el-both',
    name: '站厅',
    level: 'b2',
    originX: 28,
    originZ: 29,
    baseFloor: -16,
    liftDoor: 'both',
  });
  assert.equal(byId(elements, 'el-both-lift-w').bounds.max[1], -4);
  // 门洞 [-16,-13) 与 [-8,-5) 之间 [-13,-8) 为墙；top 门上方过梁 [-5,-4)
  assert.equal(byId(elements, 'el-both-lift-n-beam-1').bounds.min[1], -13);
  assert.equal(byId(elements, 'el-both-lift-n-beam-1').bounds.max[1], -8);
  assert.equal(byId(elements, 'el-both-lift-n-beam-2').bounds.min[1], -5);
  assert.equal(byId(elements, 'el-both-lift-n-beam-2').bounds.max[1], -4);
  assert.equal(byId(elements, 'el-both-lift-stop-base').bounds.max[1], -16);
  assert.equal(byId(elements, 'el-both-lift-threshold-top').bounds.max[1], -8);
});

test('影院高段 top 门在站立面 f+8 之上，B2 封闭，井壁盖到 f+12', () => {
  const elements = stairModule({
    idPrefix: 'el-enc',
    name: '影院组',
    level: 'b2',
    originX: 12,
    originZ: 84,
    baseFloor: -16,
    enclosure: true,
    liftDoor: 'top',
  });
  assert.equal(
    elements.some((item) => item.id === 'el-enc-enc-w'),
    true,
  );
  // 北外墙下段（y −16..−12）整段封闭，出口在上段 u[4,15)（楼梯口 + 电梯口）
  assert.equal(byId(elements, 'el-enc-enc-n-low').bounds.max[1], -12);
  assert.equal(byId(elements, 'el-enc-enc-n-uw').bounds.max[0], 12 + 4);
  assert.equal(byId(elements, 'el-enc-enc-n-ue').bounds.min[0], 12 + 15);
  // 井壁盖到 f+12 = −4
  assert.equal(byId(elements, 'el-enc-lift-w').bounds.max[1], -4);
  // 北壁中段：B2（−16..−13）与中间段都实（beam-1 = −16..−8），top 门 [−8,−5) 开，过梁 [−5,−4)
  assert.equal(byId(elements, 'el-enc-lift-n-beam-1').bounds.min[1], -16);
  assert.equal(byId(elements, 'el-enc-lift-n-beam-1').bounds.max[1], -8);
  assert.equal(byId(elements, 'el-enc-lift-n-beam-2').bounds.min[1], -5);
  assert.equal(byId(elements, 'el-enc-lift-n-beam-2').bounds.max[1], -4);
  // 站立面 f+8 到 f+11（−8..−5）门洞内无墙实体
  const doorX0 = 23;
  const doorX1 = 25;
  assert.equal(
    elements.some(
      (item) =>
        item.bounds.min[0] < doorX1 &&
        doorX0 < item.bounds.max[0] &&
        item.bounds.min[2] < 86 &&
        85 < item.bounds.max[2] &&
        item.bounds.min[1] < -5 &&
        item.bounds.max[1] > -8,
    ),
    false,
    '站立面到过梁之间不应有墙',
  );
  // top 门槛与停靠平台顶面都在 −8
  assert.equal(byId(elements, 'el-enc-lift-threshold-top').bounds.max[1], -8);
  assert.equal(byId(elements, 'el-enc-lift-stop-top').bounds.max[1], -8);
  assert.equal(
    elements.some((item) => item.id === 'el-enc-lift-stop-base'),
    false,
    'top 停靠不应有 base 平台',
  );
});

test('影院加宽：西墙西移、西座席变宽，东墙/东座席/中央通道/荧幕东端位置不变', () => {
  const base = cinemaHall({
    idPrefix: 'w',
    name: '西厅',
    westOuter: 32,
    eastOuter: 80,
    zMin: 104,
    zMax: 144,
    floorTop: -24,
    ceiling: -2,
  });
  const wider = cinemaHall({
    idPrefix: 'w',
    name: '西厅',
    westOuter: 24,
    eastOuter: 80,
    zMin: 104,
    zMax: 144,
    floorTop: -24,
    ceiling: -2,
  });

  assert.equal(hall(base, 'w-west').bounds.min[0], 32);
  assert.equal(hall(wider, 'w-west').bounds.min[0], 24);
  assert.deepEqual(hall(base, 'w-east').bounds, hall(wider, 'w-east').bounds);
  // 荧幕西端随加宽西移，东端固定在 e−8，玻璃层朝向与厚度不变
  assert.equal(hall(base, 'w-screen-glass').bounds.max[0], 72);
  assert.equal(hall(wider, 'w-screen-glass').bounds.max[0], 72);
  assert.equal(hall(wider, 'w-screen-glass').bounds.min[0] - hall(base, 'w-screen-glass').bounds.min[0], -8);
  assert.deepEqual(hall(base, 'w-seat-e-1').bounds, hall(wider, 'w-seat-e-1').bounds);
  // 西座席随加宽变宽（房间净宽 +8，西侧座席随之 +8）
  const baseWidth = hall(base, 'w-seat-w-1').bounds.max[0] - hall(base, 'w-seat-w-1').bounds.min[0];
  const widerWidth = hall(wider, 'w-seat-w-1').bounds.max[0] - hall(wider, 'w-seat-w-1').bounds.min[0];
  assert.equal(widerWidth - baseWidth, 8);
  // 西门随西墙，东门不变
  const baseWestDoor = base
    .filter((item) => item.id.startsWith('w-north-'))
    .flatMap((item) => [item.bounds.min[0], item.bounds.max[0]]);
  assert.equal(baseWestDoor.includes(36), true);
  const widerNorth = wider.filter((item) => item.id.startsWith('w-north-'));
  const solidAt = (x: number): boolean => widerNorth.some((item) => item.bounds.min[0] < x && x < item.bounds.max[0]);
  assert.equal(solidAt(29), false, '加宽后西门 [28,31) 应为开口');
  assert.equal(solidAt(74), false, '东门 [73,76) 应为开口');
  assert.equal(solidAt(40), true);
});

test('影院座席共 8 排，台地顶面从 -24 逐级升到 -17，座席不侵入两侧通道 x 范围', () => {
  const elements = cinemaHall({
    idPrefix: 'w',
    name: '西厅',
    westOuter: 32,
    eastOuter: 80,
    zMin: 104,
    zMax: 144,
    floorTop: -24,
    ceiling: -2,
  });
  const terraces = elements.filter((item) => item.id.startsWith('w-terrace-w-'));
  assert.equal(terraces.length, 8);
  assert.deepEqual(
    terraces.map((item) => item.bounds.max[1]),
    [-24, -23, -22, -21, -20, -19, -18, -17],
  );
  // 西通道 x[36,39) 内没有座席 / 台地实体
  assert.equal(
    elements.some(
      (item) =>
        (item.id.startsWith('w-terrace') || item.id.startsWith('w-seat')) &&
        item.bounds.min[0] < 39 &&
        36 < item.bounds.max[0],
    ),
    false,
  );
});

test('衣服店加宽 4：西墙与西侧陈设西移 4，东墙 / 南门 / 东衣杆不动', () => {
  const base = clothingShop({ westEdge: 32 });
  const wider = clothingShop({ westEdge: 28 });
  assert.equal(byId(base, 'el-shop-west').bounds.min[0], 32);
  assert.equal(byId(wider, 'el-shop-west').bounds.min[0], 28);
  assert.deepEqual(byId(base, 'el-shop-east').bounds, byId(wider, 'el-shop-east').bounds);
  assert.deepEqual(byId(base, 'el-shop-rack-e').bounds, byId(wider, 'el-shop-rack-e').bounds);
  assert.equal(byId(wider, 'el-shop-counter').bounds.min[0] - byId(base, 'el-shop-counter').bounds.min[0], -4);
  assert.equal(byId(wider, 'el-shop-fitting-w').bounds.min[0] - byId(base, 'el-shop-fitting-w').bounds.min[0], -4);
  assert.equal(byId(wider, 'el-shop-seat-base').bounds.min[0] - byId(base, 'el-shop-seat-base').bounds.min[0], -4);
  // 南门 [45,51) 两侧留墙；加宽后门洞位置不变：门洞内无南墙实体
  for (const shop of [base, wider]) {
    assert.equal(
      shop.some((item) => item.id.startsWith('el-shop-south') && item.bounds.min[0] < 51 && 45 < item.bounds.max[0]),
      false,
    );
  }
});

test('美食店与珠宝店：固定尺寸下南立面 / 北墙门洞与主要陈设存在', () => {
  const food = foodShop();
  assert.equal(
    food.some((item) => item.id.startsWith('el-food-south') && item.bounds.min[0] < 143 && 128 < item.bounds.max[0]),
    false,
    '美食店南墙 [128,143) 应为开口',
  );
  const jewel = jewelryShop();
  assert.equal(byId(jewel, 'el-jewel-floor').kind, 'slab');
  assert.equal(
    jewel.some((item) => item.id.startsWith('el-jewel-north') && item.bounds.min[0] < 57 && 53 < item.bounds.max[0]),
    false,
    '珠宝店北墙 [53,57) 应为门洞',
  );
  assert.equal(jewel.filter((item) => item.id.startsWith('el-jewel-display')).length, 2);
});

test('电梯门可指定 none：整段井壁实心且无停靠平台', () => {
  const elements = stairModule({
    idPrefix: 'el-none',
    name: '测试组',
    level: 'b2',
    originX: 0,
    originZ: 0,
    baseFloor: -16,
    liftDoor: 'none',
  });
  assert.equal(byId(elements, 'el-none-lift-n-beam-1').bounds.max[1], -8);
  assert.equal(
    elements.some((item) => item.id === 'el-none-lift-stop-base' || item.id === 'el-none-lift-stop-top'),
    false,
  );
});
