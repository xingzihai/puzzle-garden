/**
 * 跨构件写入冲突（R2–R5、R7）：每条规则的好 / 坏样本与两种调用顺序。
 * 坏样本除断言报错外，还要断言调用表与网格 hash 不变（整次调用原子）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '@pg/blocks/load';
import { hashGrid } from '@pg/core/hash';
import { createWorld, rect } from './index.ts';
import type { WorldHost } from './index.ts';

const table = loadRegistry().table;
const material = 'stone_brick_stairs';

/** 网格 hash + 调用数 + 覆盖数，一次调用失败后必须完全不变。 */
function snapshot(host: WorldHost): string {
  const { grid, overlaps } = host.compose();
  return `${hashGrid(grid)}:${String(grid.calls().length)}:${String(overlaps.length)}`;
}

/** 捕获同步调用的报错文案；不抛错时视为测试失败。 */
function errorMessage(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('预期这次调用报错，但没有');
}

test('R2 stair 与墙体：好样本不报，坏样本报错且调用表与网格不变', () => {
  // 9×3 的墙圈：x=±4 是东西墙，z=±1 是南北墙；stair 沿 x 上行。
  const build = (width: number): WorldHost => {
    const host = createWorld(table);
    const w = host.world;
    const base = w.plinth({ footprint: rect(-4, -1, 4, 1), height: 1, material: 'stone' });
    w.walls({ on: base, height: 5, material: 'stone' });
    const to = w.floorPlate({ footprint: rect(-4, -1, 4, 1), y: 4, material: 'oak_planks' });
    w.stair({ from: base.top, to: to.top, kind: 'straight', at: [0, 0], facing: 'east', width, material });
    return host;
  };
  assert.doesNotThrow(() => build(1), '宽 1 走中间，不碰东西墙');
  const bad = createWorld(table);
  const w = bad.world;
  const base = w.plinth({ footprint: rect(-4, -1, 4, 1), height: 1, material: 'stone' });
  w.walls({ on: base, height: 5, material: 'stone' });
  const to = w.floorPlate({ footprint: rect(-4, -1, 4, 1), y: 4, material: 'oak_planks' });
  const before = snapshot(bad);
  assert.throws(
    () => w.stair({ from: base.top, to: to.top, kind: 'straight', at: [0, 0], facing: 'east', width: 3, material }),
    /stair 占用了 walls#\d+ 的墙体/,
  );
  assert.equal(snapshot(bad), before, '失败调用不留下半成品');

  // 反向顺序：先写楼梯，再写把梯面覆盖进去的墙，同样报错且原子。
  const reverse = createWorld(table);
  const rw = reverse.world;
  const rbase = rw.plinth({ footprint: rect(-4, -1, 4, 1), height: 1, material: 'stone' });
  const rto = rw.floorPlate({ footprint: rect(-4, -1, 4, 1), y: 4, material: 'oak_planks' });
  rw.stair({ from: rbase.top, to: rto.top, kind: 'straight', at: [0, 0], facing: 'east', width: 3, material });
  const reverseBefore = snapshot(reverse);
  assert.throws(() => rw.walls({ on: rbase, height: 5, material: 'stone' }), /walls 盖到了此前 stair#\d+ 的/);
  assert.equal(snapshot(reverse), reverseBefore);
});

test('R2 stair 与屋面：平屋面出口放行，坡屋面报错', () => {
  const build = (kind: 'flat' | 'gable'): WorldHost => {
    const host = createWorld(table);
    const w = host.world;
    const hall = w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    const lower = w.floorPlate({ in: hall.inner, material: 'stone' });
    if (kind === 'flat') {
      const roof = w.roof({ on: hall, kind: 'flat', overhang: 0, material: 'stone' });
      assert(roof.top !== undefined);
      // 出口穿过后铺的平屋面：to 就是该平屋面的 top。
      w.stair({ from: lower, to: roof.top, kind: 'spiral', at: [0, 0], radius: 2, material });
    } else {
      w.roof({ on: hall, kind: 'gable', ridge: 'x', material: 'stone' });
      w.stair({ from: lower, to: hall.top, kind: 'spiral', at: [0, 0], radius: 2, material });
    }
    return host;
  };
  assert.doesNotThrow(() => build('flat'));
  const host = createWorld(table);
  const w = host.world;
  const hall = w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
  const lower = w.floorPlate({ in: hall.inner, material: 'stone' });
  w.roof({ on: hall, kind: 'gable', ridge: 'x', material: 'stone' });
  const before = snapshot(host);
  assert.throws(
    () => w.stair({ from: lower, to: hall.top, kind: 'spiral', at: [0, 0], radius: 2, material }),
    /stair 会凿穿 roof#\d+/,
  );
  assert.equal(snapshot(host), before);
});

test('R2 镜像里的平屋面：stair→roof.top 原侧与镜像侧都放行，y 不符仍报错', () => {
  const build = (to: 'roof' | 'walls'): WorldHost => {
    const host = createWorld(table);
    const w = host.world;
    w.mirror({ axis: 'x', at: 0 }, () => {
      const hall = w.walls({ footprint: rect(6, -4, 14, 4), y: 1, height: 5, material: 'stone' });
      const lower = w.floorPlate({ in: hall.inner, material: 'stone' });
      const roof = w.roof({ on: hall, kind: 'flat', overhang: 0, material: 'stone' });
      assert(roof.top !== undefined);
      // to 指向 wall.top（比屋面低一层）时，即使镜像侧坐标匹配也不能放行。
      w.stair({
        from: lower,
        to: to === 'roof' ? roof.top : hall.top,
        kind: 'spiral',
        at: [10, 0],
        radius: 2,
        material,
      });
    });
    return host;
  };
  assert.doesNotThrow(() => build('roof'), '镜像两侧的 roof.top 都应放行');
  assert.throws(() => build('walls'), /stair 会凿穿 roof#\d+/);
});

test('R3 steps 与墙体：两种调用顺序都报错且原子', () => {
  const scene = (): { readonly host: WorldHost; readonly after: () => void } => {
    const host = createWorld(table);
    const w = host.world;
    const hall = w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    const door = w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 2, sill: 1 });
    return {
      host,
      after: () => {
        w.steps({ to: door, width: 3, material });
      },
    };
  };
  // 好样本：门口外没有别的体积。
  assert.doesNotThrow(() => {
    scene().after();
  });
  // 后写墙盖住踏步。
  const later = scene();
  later.host.world.walls({ footprint: rect(-1, 5, 1, 7), y: 1, height: 2, material: 'stone' });
  const laterBefore = snapshot(later.host);
  assert.throws(later.after, /steps 从入口外伸 \d+ 格，在 \([^)]+\) 撞上 walls#\d+/);
  assert.equal(snapshot(later.host), laterBefore);
  // 先写墙，后写踏步。
  const host = createWorld(table);
  const w = host.world;
  const hall = w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
  const door = w.opening({ in: hall.facade('south'), kind: 'door', width: 3, height: 2, sill: 1 });
  w.walls({ footprint: rect(-1, 5, 1, 7), y: 1, height: 2, material: 'stone' });
  const before = snapshot(host);
  assert.throws(
    () => w.steps({ to: door, width: 3, material }),
    /steps 从入口外伸 \d+ 格，在 \([^)]+\) 撞上 walls#\d+/,
  );
  assert.equal(snapshot(host), before);
});

test('R4 两洞 hole 重叠报错；错开 at 放行', () => {
  const withDoor = (at: number): WorldHost => {
    const host = createWorld(table);
    const w = host.world;
    const hall = w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
    w.opening({ in: hall.facade('north'), kind: 'door', width: 3, height: 2 });
    w.opening({ in: hall.facade('north'), kind: 'window', at, width: 1, height: 2 });
    return host;
  };
  assert.doesNotThrow(() => withDoor(3), '错开洞口不报');
  const host = createWorld(table);
  const w = host.world;
  const hall = w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
  w.opening({ in: hall.facade('north'), kind: 'door', width: 3, height: 2 });
  const before = snapshot(host);
  assert.throws(
    () => w.opening({ in: hall.facade('north'), kind: 'window', width: 1, height: 2 }),
    /opening 的洞在 \([^)]+\) 与另一洞重叠/,
  );
  assert.equal(snapshot(host), before);
});

test('R4 outside / frame 伸进其他调用报错；去掉 frame 放行', () => {
  const scene = () => {
    const host = createWorld(table);
    const w = host.world;
    const hall = w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 6, material: 'stone' });
    w.opening({
      in: hall.facade('north'),
      kind: 'door',
      width: 3,
      height: 2,
      frame: { material: 'iron_block' },
      canopy: { depth: 2, material: 'gray_concrete' },
    });
    return { host, w, hall };
  };
  const good = scene();
  assert.doesNotThrow(() =>
    good.w.opening({ in: good.hall.facade('north'), kind: 'window', at: 2, width: 1, height: 2, sill: 1 }),
  );
  const bad = scene();
  const before = snapshot(bad.host);
  assert.throws(
    () =>
      bad.w.opening({
        in: bad.hall.facade('north'),
        kind: 'window',
        at: 2,
        width: 1,
        height: 2,
        sill: 1,
        frame: { material: 'iron_block' },
      }),
    /opening 的(门框外净空|门框|雨棚)在 \([^)]+\) 伸进 opening#\d+/,
  );
  assert.equal(snapshot(bad.host), before);
});

test('R4 洞落进柱廊报错；两种调用顺序都原子', () => {
  // 先柱廊后开洞：开洞时回查。
  const first = createWorld(table);
  const fw = first.world;
  const fhall = fw.walls({ footprint: rect(-5, -4, 5, 4), y: 1, height: 4, material: 'stone' });
  fw.colonnade({
    footprint: rect(-3, -7, 3, -4),
    y: 1,
    count: 4,
    height: 5,
    column: { material: 'oak_log' },
    beam: { height: 1, material: 'oak_log' },
  });
  const firstBefore = snapshot(first);
  assert.throws(
    () => fw.opening({ in: fhall.facade('north'), kind: 'window', at: 3, width: 1, height: 2 }),
    /opening 的洞在 \([^)]+\) 落进 colonnade#\d+/,
  );
  assert.equal(snapshot(first), firstBefore);
  // 先开洞后柱廊：柱廊覆盖洞时反查。
  const second = createWorld(table);
  const sw = second.world;
  const shall = sw.walls({ footprint: rect(-5, -4, 5, 4), y: 1, height: 4, material: 'stone' });
  sw.opening({ in: shall.facade('north'), kind: 'window', at: 3, width: 1, height: 2 });
  const secondBefore = snapshot(second);
  assert.throws(
    () =>
      sw.colonnade({
        footprint: rect(-3, -7, 3, -4),
        y: 1,
        count: 4,
        height: 5,
        column: { material: 'oak_log' },
        beam: { height: 1, material: 'oak_log' },
      }),
    /colonnade 盖到了此前 opening#\d+ 的洞/,
  );
  assert.equal(snapshot(second), secondBefore);
});

test('N1 反向冲突以新调用为主语，引用真实编号且建议参数真实', () => {
  // 先写踏步，再写盖住踏步的邻楼：新调用 walls 是主语。
  const steps = createWorld(table);
  const sw = steps.world;
  const sHall = sw.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
  const sDoor = sw.opening({ in: sHall.facade('south'), kind: 'door', width: 3, height: 2, sill: 1 });
  sw.steps({ to: sDoor, width: 3, material });
  const stepsBefore = snapshot(steps);
  const stepsMsg = errorMessage(() => sw.walls({ footprint: rect(-1, 5, 1, 7), y: 1, height: 2, material: 'stone' }));
  assert.match(stepsMsg, /^walls 盖到了此前 steps#\d+ 的/);
  assert.doesNotMatch(stepsMsg, /#0/);
  assert.equal(snapshot(steps), stepsBefore);

  // 先写楼梯，再盖坡屋面：新调用 roof 是主语。
  const stair = createWorld(table);
  const tw = stair.world;
  const tHall = tw.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
  const tLower = tw.floorPlate({ in: tHall.inner, material: 'stone' });
  tw.stair({ from: tLower, to: tHall.top, kind: 'spiral', at: [0, 0], radius: 2, material });
  const stairBefore = snapshot(stair);
  const roofMsg = errorMessage(() => tw.roof({ on: tHall, kind: 'gable', ridge: 'x', material: 'stone' }));
  assert.match(roofMsg, /^roof 盖到了此前 stair#\d+ 的/);
  assert.doesNotMatch(roofMsg, /#0/);
  assert.equal(snapshot(stair), stairBefore);

  // 门框撞邻墙：建议只提真实拥有的 frame / at，不提不存在的 canopy.depth。
  const frame = createWorld(table);
  const fw = frame.world;
  const fHall = fw.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 6, material: 'stone' });
  fw.walls({ footprint: rect(2, 5, 4, 7), y: 1, height: 5, material: 'stone' });
  const frameMsg = errorMessage(() =>
    fw.opening({ in: fHall.facade('south'), kind: 'door', width: 3, height: 3, frame: { material: 'iron_block' } }),
  );
  assert.match(frameMsg, /opening 的门框在 \([^)]+\) 伸进 walls#\d+/);
  assert.match(frameMsg, /去掉 frame/);
  assert.doesNotMatch(frameMsg, /canopy\.depth|#0/);
});

test('N3 stair / steps 撞 rail 仍然报错，y ≤ 0 地坪放行', () => {
  // 楼梯穿楼板上的栏杆。
  const rail = createWorld(table);
  const rw = rail.world;
  const rLower = rw.floorPlate({ footprint: rect(-7, -7, 7, 7), y: 1, material: 'stone' });
  const rUpper = rw.floorPlate({ footprint: rect(-7, -7, 7, 7), y: 7, material: 'stone' });
  const mid = rw.floorPlate({ footprint: rect(1, -1, 3, 1), y: 4, material: 'stone' });
  rw.rail({ along: mid.top, material: 'oak_fence' });
  const railBefore = snapshot(rail);
  const railMsg = errorMessage(() =>
    rw.stair({ from: rLower, to: rUpper, kind: 'straight', at: [0, 0], facing: 'east', width: 1, material }),
  );
  assert.match(railMsg, /stair 的.*撞上 rail#\d+/);
  assert.doesNotMatch(railMsg, /#0/);
  assert.equal(snapshot(rail), railBefore, '失败调用不留下半成品');

  // 反向：先写楼梯，再写盖住梯面的栏杆，同样报错且原子。
  const reverse = createWorld(table);
  const vw = reverse.world;
  const vLower = vw.floorPlate({ footprint: rect(-7, -7, 7, 7), y: 1, material: 'stone' });
  const vUpper = vw.floorPlate({ footprint: rect(-7, -7, 7, 7), y: 7, material: 'stone' });
  vw.stair({ from: vLower, to: vUpper, kind: 'straight', at: [0, 0], facing: 'east', width: 1, material });
  const vMid = vw.floorPlate({ footprint: rect(1, -1, 3, 1), y: 4, material: 'stone' });
  const reverseBefore = snapshot(reverse);
  assert.throws(() => vw.rail({ along: vMid.top, material: 'oak_fence' }), /rail 盖到了此前 stair#\d+ 的/);
  assert.equal(snapshot(reverse), reverseBefore);
});

test('2026-10-04 set / box 不再参与跨构件冲突：先 set 后 stair 不报错，按层合成', () => {
  // box 先写结构层隔墙，楼梯随后穿过去：不报错，踏面在开洞层，跨层合成压过结构层。
  const host = createWorld(table);
  const w = host.world;
  const lower = w.floorPlate({ footprint: rect(-6, -6, 6, 6), y: 1, material: 'stone' });
  const upper = w.floorPlate({ footprint: rect(-6, -6, 6, 6), y: 7, material: 'stone' });
  w.box([-6, 1, 0], [6, 6, 0], 'stone');
  assert.doesNotThrow(() =>
    w.stair({ from: lower, to: upper, kind: 'straight', at: [0, 0], facing: 'east', width: 1, material }),
  );
  // 首级踏面 (0,2,0) 在开洞层，跨层规则压过结构层 box。
  assert.match(host.compose().grid.get(0, 2, 0)?.state.canonical ?? '', /stone_brick_stairs/);
  // 背板 (1,2,0) 在结构层，被后写的 set 覆盖（同层后写覆盖）。
  w.set(1, 2, 0, 'stone');
  assert.equal(host.compose().grid.get(1, 2, 0)?.state.canonical, 'stone');
});

test('2026-10-04 先 stair 后 set 盖住踏面不报错，同层后写覆盖 set 胜出', () => {
  const host = createWorld(table);
  const w = host.world;
  const lower = w.floorPlate({ footprint: rect(-6, -6, 6, 6), y: 1, material: 'stone' });
  const upper = w.floorPlate({ footprint: rect(-6, -6, 6, 6), y: 7, material: 'stone' });
  w.stair({ from: lower, to: upper, kind: 'straight', at: [0, 0], facing: 'east', width: 1, material });
  // 踏面在开洞层：显式写开洞层的 set 与踏面同层，后写覆盖。
  assert.doesNotThrow(() => {
    w.set(0, 2, 0, 'stone', 'opening');
  });
  assert.equal(host.compose().grid.get(0, 2, 0)?.state.canonical, 'stone');
  // 默认 set 写结构层，覆盖同层的背板 (1,2,0)。
  assert.doesNotThrow(() => {
    w.set(1, 2, 0, 'stone');
  });
  assert.equal(host.compose().grid.get(1, 2, 0)?.state.canonical, 'stone');
});

test('2026-10-04 steps 与 set / box 重叠不报错，两个方向都放行', () => {
  // 先 box 后 steps：不报错。
  const first = createWorld(table);
  const fw = first.world;
  const fHall = fw.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
  const fDoor = fw.opening({ in: fHall.facade('south'), kind: 'door', width: 3, height: 2, sill: 1 });
  fw.box([-1, 1, 5], [1, 1, 5], 'stone');
  assert.doesNotThrow(() => fw.steps({ to: fDoor, width: 3, material }));
  // 先 steps 后 box 盖住踏步：不报错，后写的 box 胜出。
  const second = createWorld(table);
  const sw = second.world;
  const sHall = sw.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 5, material: 'stone' });
  const sDoor = sw.opening({ in: sHall.facade('south'), kind: 'door', width: 3, height: 2, sill: 1 });
  sw.steps({ to: sDoor, width: 3, material });
  assert.doesNotThrow(() => {
    sw.box([-6, 1, 5], [6, 6, 5], 'stone');
  });
});

test('2026-10-04 opening 的 frame / outside / canopy 与 set / box 重叠不报错', () => {
  // opening 先写（门框在北立面外 z=-5），set / box 后写盖住门框：不报错。
  const first = createWorld(table);
  const fw = first.world;
  const fHall = fw.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 6, material: 'stone' });
  fw.opening({
    in: fHall.facade('north'),
    kind: 'door',
    width: 3,
    height: 2,
    frame: { material: 'iron_block' },
    canopy: { depth: 2, material: 'gray_concrete' },
  });
  assert.doesNotThrow(() => {
    fw.box([-2, 1, -5], [2, 1, -5], 'stone');
  });
  assert.doesNotThrow(() => {
    fw.set(0, 2, -5, 'stone');
  });
  // 雨棚在北立面外 y=3、z=-6/-5 一带，同样放行。
  assert.doesNotThrow(() => {
    fw.set(0, 3, -6, 'stone');
  });
  // set / box 先写，opening 后写伸进它们：不报错。
  const second = createWorld(table);
  const sw = second.world;
  const sHall = sw.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 6, material: 'stone' });
  sw.box([-2, 1, -5], [2, 1, -5], 'stone');
  assert.doesNotThrow(() =>
    sw.opening({
      in: sHall.facade('north'),
      kind: 'door',
      width: 3,
      height: 2,
      frame: { material: 'iron_block' },
      canopy: { depth: 2, material: 'gray_concrete' },
    }),
  );
});

test('N6 stair 撞墙的合法 at 范围扣掉墙圈：端点可放、端点外 1 格报错', () => {
  const build = (at: readonly [number, number]): WorldHost => {
    const host = createWorld(table);
    const w = host.world;
    w.walls({ footprint: rect(-6, -6, 6, 6), y: 1, height: 5, material: 'stone' });
    const lower = w.floorPlate({ footprint: rect(-6, -6, 6, 6), y: 1, material: 'stone' });
    const upper = w.floorPlate({ footprint: rect(-6, -6, 6, 6), y: 5, material: 'stone' });
    w.stair({ from: lower, to: upper, kind: 'straight', at, facing: 'east', width: 3, material });
    return host;
  };
  const msg = errorMessage(() => build([2, 0]));
  assert.match(msg, /stair 占用了 walls#\d+ 的墙体/);
  assert.match(msg, /at 向内移到 x∈\[-4, 1\]、z∈\[-4, 4\]/, msg);
  // 端点可放（x=1 与 z 端），端点外 1 格报错。
  assert.doesNotThrow(() => build([-4, 0]));
  assert.doesNotThrow(() => build([1, 4]));
  assert.throws(() => build([2, 0]));
  assert.throws(() => build([-5, 0]));
  assert.throws(() => build([1, 5]));
});

test('N7 共墙高窗撞侧廊屋面：按冲突最高 roof 格给 sill 下限', () => {
  const h = createWorld(table);
  const w = h.world;
  const hall = w.walls({ footprint: rect(-3, -4, 3, 4), y: 1, height: 8, material: 'stone' });
  w.roof({
    footprint: rect(3, -4, 6, 4),
    y: 5,
    kind: 'gable',
    ridge: 'z',
    pitch: 1,
    overhang: 0,
    material: 'deepslate_tiles',
  });
  const before = snapshot(h);
  const msg = errorMessage(() => w.opening({ in: hall.facade('east'), kind: 'window', width: 3, height: 2, sill: 4 }));
  // 冲突最高 roof 格 y=5，墙底 y=1 → 建议 sill ≥ 5（= 5 − 1 + 1）。
  assert.match(msg, /opening 的洞在 \(3, 5, -1\) 撞上 roof#\d+；把 sill 提到 ≥ 5 或减小 height/);
  assert.doesNotMatch(msg, /#0/);
  assert.equal(snapshot(h), before);
  // 好样本：sill 提到 roof 之上不再冲突。
  assert.doesNotThrow(() => w.opening({ in: hall.facade('east'), kind: 'window', width: 3, height: 2, sill: 6 }));
});

test('R7 镜像副本与原侧重叠报错；错开轴放行', () => {
  const build = (at: number): WorldHost => {
    const host = createWorld(table);
    const w = host.world;
    const lower = w.floorPlate({ footprint: rect(-3, -3, 3, 3), y: 1, material: 'stone' });
    const upper = w.floorPlate({ footprint: rect(-3, -3, 3, 3), y: 4, material: 'stone' });
    w.mirror({ axis: 'x', at }, () => {
      w.stair({ from: lower, to: upper, kind: 'straight', at: [0, 0], facing: 'east', width: 1, material });
    });
    return host;
  };
  assert.doesNotThrow(() => build(5), '轴不穿过楼梯');
  const host = createWorld(table);
  const w = host.world;
  const lower = w.floorPlate({ footprint: rect(-3, -3, 3, 3), y: 1, material: 'stone' });
  const upper = w.floorPlate({ footprint: rect(-3, -3, 3, 3), y: 4, material: 'stone' });
  const before = snapshot(host);
  assert.throws(() => {
    w.mirror({ axis: 'x', at: 0 }, () => {
      w.stair({ from: lower, to: upper, kind: 'straight', at: [0, 0], facing: 'east', width: 1, material });
    });
  }, /镜像轴 x=0 穿过本构件，副本与原侧在 \([^)]+\) 重叠/);
  assert.equal(snapshot(host), before);
});

test('反向报错给受保护区域包围盒；门框补凸出说明（首批运行 #3）', () => {
  const host = createWorld(table);
  const w = host.world;
  const hall = w.walls({ footprint: rect(-4, -4, 4, 4), y: 1, height: 6, material: 'stone' });
  // 门框 width 1 在北立面外侧一格 z=-5，覆盖 x∈[-2,2]、y∈[1,3] 中非洞口的格。
  w.opening({ in: hall.facade('north'), kind: 'door', width: 3, height: 2, frame: { material: 'iron_block' } });
  const before = snapshot(host);
  const text = errorMessage(() => {
    w.walls({ footprint: rect(-2, -8, 2, -5), y: 1, height: 3, material: 'stone' });
  });
  assert.match(text, /^walls 盖到了此前 opening#\d+ 的(门框|门框外净空)/);
  assert.match(text, /门框凸出墙外 1 格/);
  assert.match(text, /受保护区域 x∈\[-2, 2\]、y∈\[1, 3\]、z∈\[-5, -5\]，共 15 格/);
  assert.equal(snapshot(host), before, '失败调用不留下半成品');
});
