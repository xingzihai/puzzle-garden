/** createModel 的单元测试：四类入口、source 记录、默认段数、上限、finish 快照与非法输入。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelError } from './errors.ts';
import { createModel } from './model.ts';
import type { ExtrudeOptions, RevolveOptions } from './model.ts';
import { MAX_PARTS, ModelDocument } from './schema.ts';
import type { Point2 } from './schema.ts';

function base(id: string) {
  return { id, name: '部件', role: 'volume' as const, color: '#123456' };
}

describe('createModel box', () => {
  it('记录解析后的单位变换与包围盒', () => {
    const model = createModel();
    model.box({ ...base('b'), size: [2, 3, 4] });
    const document = model.finish();
    assert.equal(document.parts.length, 1);
    const part = document.parts[0];
    assert.ok(part);
    assert.deepEqual(part.bounds, { min: [0, 0, 0], max: [2, 3, 4] });
    assert.equal(part.positions.length / 3, 8);
    assert.deepEqual(part.source, {
      operation: 'box',
      parameters: { size: [2, 3, 4], transform: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] } },
    });
  });

  it('应用旋转与平移', () => {
    const model = createModel();
    model.box({ ...base('b'), size: [2, 1, 1], transform: { rotate: [0, 0, Math.PI / 2], translate: [10, 0, 0] } });
    const part = model.finish().parts[0];
    assert.ok(part);
    assert.deepEqual(part.bounds, { min: [9, 0, 0], max: [10, 2, 1] });
    assert.deepEqual(part.source.parameters.transform.rotate, [0, 0, Math.PI / 2]);
  });

  it('拒绝零 / 负尺寸与重复 id', () => {
    const model = createModel();
    assert.throws(() => {
      model.box({ ...base('b'), size: [0, 1, 1] });
    }, ModelError);
    assert.throws(() => {
      model.box({ ...base('b'), size: [-1, 1, 1] });
    }, /size/);
    model.box({ ...base('b'), size: [1, 1, 1] });
    assert.throws(() => {
      model.box({ ...base('b'), size: [1, 1, 1] });
    }, /id 重复/);
  });
});

describe('createModel revolve', () => {
  it('默认 32 / 48 段并记录采样轮廓', () => {
    const model = createModel();
    model.revolve({ ...base('r'), role: 'roof', profile: (t) => [2, t * 10] });
    const document = model.finish();
    const part = document.parts[0];
    assert.ok(part);
    assert.ok(part.source.operation === 'revolve');
    assert.equal(part.source.parameters.profileSegments, 32);
    assert.equal(part.source.parameters.radialSegments, 48);
    assert.equal(part.source.parameters.sampledProfile.length, 33);
    assert.equal(part.positions.length / 3, 33 * 48);
  });

  it('自定义段数并支持任意幂函数 / 反比例母线', () => {
    const model = createModel();
    model.revolve({
      ...base('r'),
      role: 'roof',
      profile: (t) => [(16 * (1 - t)) / (1 + 4 * t), 24 * t],
      profileSegments: 16,
      radialSegments: 24,
    });
    const part = model.finish().parts[0];
    assert.ok(part);
    assert.ok(part.source.operation === 'revolve');
    assert.equal(part.source.parameters.profileSegments, 16);
    assert.equal(part.source.parameters.sampledProfile.length, 17);
    // 顶端 t=1 半径为 0，收成尖点，无退化三角：顶点数 = 16 环 × 24 + 1。
    assert.equal(part.positions.length / 3, 16 * 24 + 1);
  });

  it('profile 非函数 / 返回值非法 / 抛错 / 负半径 / 高度不递增都响亮拒绝', () => {
    const model = createModel();
    const notFunction = { ...base('r1'), role: 'roof', profile: 5 } as unknown as RevolveOptions;
    assert.throws(() => {
      model.revolve(notFunction);
    }, /profile 必须是/);

    assert.throws(() => {
      model.revolve({ ...base('r2'), role: 'roof', profile: (() => 'x') as unknown as (t: number) => Point2 });
    }, /必须返回/);
    assert.throws(() => {
      model.revolve({
        ...base('r3'),
        role: 'roof',
        profile: () => {
          throw new Error('母线坏了');
        },
      });
    }, /母线坏了/);
    assert.throws(() => {
      model.revolve({ ...base('r4'), role: 'roof', profile: (t) => [-1 - t, t] });
    }, /半径/);
    assert.throws(() => {
      model.revolve({ ...base('r5'), role: 'roof', profile: () => [1, 0] });
    }, /严格递增/);
  });
});

describe('createModel revolve 端部吸附与渲染精度', () => {
  it('分段贝塞尔末段控制点半径为 0：t=1 的 ~1e-16 端被吸附成单尖点，f32 校验通过', () => {
    const model = createModel();
    const last = [
      [2, 5],
      [1.2, 8],
      [0.4, 11],
      [0, 13],
    ] as const;
    model.revolve({
      ...base('dome'),
      role: 'roof',
      profileSegments: 40,
      radialSegments: 64,
      profile: (t) => {
        if (t < 0.55) return [2, (t / 0.55) * 5];
        // 复现真实缺陷：u=(1-0.55)/0.45 因浮点算出 0.9999999999999999，末段半径 ~1e-16。
        const u = (t - 0.55) / 0.45;
        return model.bezier(last, u);
      },
    });
    const document = model.finish();
    const part = document.parts[0];
    assert.ok(part);
    assert.ok(part.source.operation === 'revolve');
    const samples = part.source.parameters.sampledProfile;
    assert.equal(samples.length, 41);
    assert.equal(samples[samples.length - 1]?.[0], 0, '末采样半径应被精确吸附为 0');
    // 40 环 × 64 + 1 个尖点；未吸附会是 41 × 64。
    assert.equal(part.positions.length / 3, 40 * 64 + 1);
    const reparsed = ModelDocument.safeParse(JSON.parse(JSON.stringify(document)));
    assert.equal(reparsed.success, true, `吸附后应通过 float32 镜像校验：${JSON.stringify(reparsed.error?.issues)}`);
  });

  it('大跨度内的真实细特征：中间半径 1e-3、跨度 2e5，报 float32 退化并含部件 id', () => {
    const model = createModel();
    assert.throws(
      () => {
        model.revolve({
          ...base('thin-ring'),
          role: 'roof',
          profileSegments: 4,
          radialSegments: 32,
          profile: (t) => [t === 0.5 ? 1e-3 : 1e5, t * 10],
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.match(error.message, /渲染精度（float32）下退化/);
        assert.match(error.message, /thin-ring/);
        assert.match(error.message, /第 \d+ 个三角/);
        return true;
      },
    );
  });
});

describe('createModel extrude', () => {
  it('接受凸轮廓并规范掉一次闭合重复点', () => {
    const model = createModel();
    model.extrude({
      ...base('e'),
      outline: [
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
        [0, 0],
      ],
      height: 5,
    });
    const part = model.finish().parts[0];
    assert.ok(part);
    assert.ok(part.source.operation === 'extrude');
    assert.deepEqual(part.source.parameters.outline, [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
    assert.equal(part.source.parameters.height, 5);
  });

  it('接受凹轮廓（L 形）并记录规范化后的轮廓', () => {
    const model = createModel();
    const outline: Point2[] = [
      [0, 0],
      [4, 0],
      [4, 2],
      [2, 2],
      [2, 4],
      [0, 4],
    ];
    model.extrude({ ...base('e1'), outline: [...outline, [0, 0]], height: 1 });
    const part = model.finish().parts[0];
    assert.ok(part);
    assert.ok(part.source.operation === 'extrude');
    assert.deepEqual(part.source.parameters.outline, outline);
    // n=6：2n 顶点；耳切得到每盖 n−2 个三角，加侧壁 2n，共 4n−4 = 20。
    assert.equal(part.positions.length / 3, 12);
    assert.equal(part.indices.length / 3, 20);
  });

  it('自交 / 重复点 / 共线退化都拒绝，不静默', () => {
    const model = createModel();
    const ring: Point2[] = Array.from({ length: 5 }, (_, i) => {
      const angle = (2 * Math.PI * i) / 5;
      return [4 * Math.cos(angle), 4 * Math.sin(angle)];
    });
    const selfIntersect: ExtrudeOptions = {
      ...base('e2'),
      outline: [0, 2, 4, 1, 3].map((i) => ring[i]).filter((point): point is Point2 => point !== undefined),
      height: 1,
    };
    assert.throws(() => {
      model.extrude(selfIntersect);
    }, /自交/);
    const duplicate: ExtrudeOptions = {
      ...base('e3'),
      outline: [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 0],
        [0, 2],
      ],
      height: 1,
    };
    assert.throws(() => {
      model.extrude(duplicate);
    }, /重复点/);
    const collinear: ExtrudeOptions = {
      ...base('e4'),
      outline: [
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 2],
      ],
      height: 1,
    };
    assert.throws(() => {
      model.extrude(collinear);
    }, ModelError);
  });
});

describe('createModel bezier', () => {
  it('返回采样点并校验入参', () => {
    const model = createModel();
    assert.deepEqual(
      model.bezier(
        [
          [0, 0],
          [1, 0],
          [2, 0],
          [3, 0],
        ],
        0.5,
      ),
      [1.5, 0],
    );
    assert.throws(
      () =>
        model.bezier(
          [
            [0, 0],
            [1, 1],
          ] as unknown as readonly [Point2, Point2, Point2, Point2],
          0.5,
        ),
      /4 个/,
    );
    assert.throws(
      () =>
        model.bezier(
          [
            [0, 0],
            [1, 1],
            [2, 2],
            [3, 3],
          ],
          Number.NaN,
        ),
      /有限数/,
    );
  });
});

describe('createModel finish 与上限', () => {
  it('finish 返回冻结的独立快照，再次 finish 内容稳定', () => {
    const model = createModel();
    model.box({ ...base('b'), size: [1, 1, 1] });
    const first = model.finish();
    assert.equal(Object.isFrozen(first.parts[0]?.positions), true);
    const second = model.finish();
    assert.notEqual(first, second);
    assert.deepEqual(second, first);
  });

  it('finish 后四个入口都拒绝继续添加', () => {
    const model = createModel();
    model.finish();
    assert.throws(() => {
      model.box({ ...base('b'), size: [1, 1, 1] });
    }, /finish\(\) 之后/);
    assert.throws(() => {
      model.revolve({ ...base('r'), role: 'roof', profile: (t) => [1, t] });
    }, /finish\(\) 之后/);
    assert.throws(() => {
      model.extrude({
        ...base('e'),
        outline: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        height: 1,
      });
    }, /finish\(\) 之后/);
    assert.throws(() => {
      model.surface({
        ...base('s'),
        role: 'roof',
        uSegments: 4,
        vSegments: 4,
        position: (u, v) => [u, 0, v],
      });
    }, /finish\(\) 之后/);
  });

  it('空模型 finish 得到空文档（version 2）', () => {
    const document = createModel().finish();
    assert.deepEqual(document, { version: 2, parts: [] });
  });

  it('部件数上限在添加时拒绝', () => {
    const model = createModel();
    for (let i = 0; i < MAX_PARTS; i += 1) model.box({ ...base(`b${String(i)}`), size: [1, 1, 1] });
    assert.throws(() => {
      model.box({ ...base('overflow'), size: [1, 1, 1] });
    }, /上限/);
  });

  it('总顶点数上限在添加时拒绝', () => {
    const model = createModel();
    for (let i = 0; i < 12; i += 1) {
      model.revolve({
        ...base(`r${String(i)}`),
        role: 'roof',
        profile: (t) => [1 + t, t * 10],
        profileSegments: 128,
        radialSegments: 128,
      });
    }
    assert.throws(() => {
      model.revolve({
        ...base('overflow'),
        role: 'roof',
        profile: (t) => [1 + t, t * 10],
        profileSegments: 128,
        radialSegments: 128,
      });
    }, /总顶点数/);
  });

  it('source 可 JSON 往返并通过 ModelDocument 二次校验', () => {
    const model = createModel();
    model.box({ ...base('b'), size: [1, 2, 3] });
    model.revolve({ ...base('r'), role: 'roof', profile: (t) => [1, t] });
    model.extrude({
      ...base('e'),
      outline: [
        [0, 0],
        [2, 0],
        [2, 2],
      ],
      height: 1,
    });
    model.surface({
      ...base('s'),
      role: 'roof',
      uSegments: 4,
      vSegments: 4,
      closedU: true,
      position: (u, v) => [Math.cos(2 * Math.PI * u), v, Math.sin(2 * Math.PI * u)],
    });
    const document = model.finish();
    const reparsed = ModelDocument.safeParse(JSON.parse(JSON.stringify(document)));
    assert.equal(reparsed.success, true, `surface source 应可序列化：${JSON.stringify(reparsed.error?.issues)}`);
  });
});

describe('createModel material 往返与 finish 版本', () => {
  it('四类操作的可选 material 写入 Part 顶层并通过 JSON 往返（version 2）', () => {
    const model = createModel();
    model.box({ ...base('b'), size: [1, 1, 1], material: 'deepslate_tiles' });
    model.revolve({ ...base('r'), role: 'roof', profile: (t) => [1, t], material: 'oak_stairs[facing=north]' });
    model.extrude({
      ...base('e'),
      outline: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      height: 1,
      material: 'stone_bricks',
    });
    model.surface({
      ...base('s'),
      role: 'roof',
      uSegments: 4,
      vSegments: 4,
      position: (u, v) => [u, 0, v],
      material: 'glass',
    });
    model.box({ ...base('plain'), size: [1, 1, 1] });

    const document = model.finish();
    assert.equal(document.version, 2);
    const boxPart = document.parts[0];
    const revolvePart = document.parts[1];
    const extrudePart = document.parts[2];
    const surfacePart = document.parts[3];
    const plainPart = document.parts[4];
    assert.ok(boxPart && revolvePart && extrudePart && surfacePart && plainPart);
    assert.equal(boxPart.material, 'deepslate_tiles');
    assert.equal(revolvePart.material, 'oak_stairs[facing=north]');
    assert.equal(extrudePart.material, 'stone_bricks');
    assert.equal(surfacePart.material, 'glass');
    assert.equal(plainPart.material, undefined);
    // material 在顶层，不落进 source.parameters。
    assert.equal('material' in boxPart.source.parameters, false);

    const reparsed = ModelDocument.safeParse(JSON.parse(JSON.stringify(document)));
    assert.equal(reparsed.success, true, `带 material 的文档应可往返：${JSON.stringify(reparsed.error?.issues)}`);
  });

  it('非法 material（空串 / 超长 / 非字符串）在添加时响亮拒绝', () => {
    const model = createModel();
    assert.throws(() => {
      model.box({ ...base('b1'), size: [1, 1, 1], material: '' });
    }, ModelError);
    assert.throws(() => {
      model.box({ ...base('b2'), size: [1, 1, 1], material: 'a'.repeat(201) });
    }, ModelError);
    assert.throws(() => {
      model.box({ ...base('b3'), size: [1, 1, 1], material: 5 as unknown as string });
    }, ModelError);
  });

  it('把 v1 文档（无 material）与 v2 文档都读作合法', () => {
    const model = createModel();
    model.box({ ...base('b'), size: [1, 1, 1] });
    const part = model.finish().parts[0];
    assert.ok(part);
    const v1 = { version: 1, parts: [part] };
    const v2 = { version: 2, parts: [{ ...part, material: 'stone' }] };
    assert.equal(ModelDocument.safeParse(v1).success, true);
    assert.equal(ModelDocument.safeParse(v2).success, true);
    assert.equal(ModelDocument.safeParse({ version: 1, parts: [{ ...part, material: 'stone' }] }).success, false);
  });
});
