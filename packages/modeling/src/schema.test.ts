/** schema 的单元测试：数值范围、变换、母线、凸轮廓、Part 网格一致性、ModelDocument 上限，好 / 坏样本双向。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABS_MAX,
  Bounds,
  BoxOptionsSchema,
  ExtrudeOptionsSchema,
  MAX_PARTS,
  MAX_TRIANGLES,
  ModelDocument,
  Part,
  Point2,
  RevolveOptionsSchema,
  SampledProfile,
  SimpleOutline,
  SurfaceOptionsSchema,
  Transform,
  Vec3,
  sampledProfileProblem,
} from './schema.ts';
import { MAX_OUTLINE_POINTS, checkOutline } from './polygon.ts';

type Raw = Record<string, unknown>;

const transformDocument: Raw = {
  translate: [0, 0, 0],
  rotate: [0, 0, 0],
  scale: [1, 1, 1],
};

function goodPart(): Raw {
  return {
    id: 'p',
    name: '部件',
    role: 'volume',
    color: '#123456',
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    source: { operation: 'box', parameters: { size: [1, 1, 1], transform: transformDocument } },
  };
}

function partWith(patch: Raw): Raw {
  return { ...goodPart(), ...patch };
}

describe('数值原语', () => {
  it('Vec3 接受范围内的有限数并把 -0 规范成 0', () => {
    const parsed = Vec3.parse([-0, ABS_MAX, -ABS_MAX]);
    assert.equal(Object.is(parsed[0], 0), true);
    assert.equal(parsed[1], ABS_MAX);
    assert.equal(parsed[2], -ABS_MAX);
  });

  it('Vec3 拒绝 NaN / Infinity / 越界 / 长度错', () => {
    assert.equal(Vec3.safeParse([NaN, 0, 0]).success, false);
    assert.equal(Vec3.safeParse([Infinity, 0, 0]).success, false);
    assert.equal(Vec3.safeParse([ABS_MAX + 1, 0, 0]).success, false);
    assert.equal(Vec3.safeParse([0, 0]).success, false);
  });

  it('Point2 拒绝非数并规范化 -0', () => {
    assert.equal(Point2.safeParse([1, 'x']).success, false);
    assert.equal(Object.is(Point2.parse([-0, 2])[0], 0), true);
  });
});

describe('Transform', () => {
  it('接受部分字段，缩放必须为正', () => {
    assert.equal(Transform.safeParse({ translate: [1, 2, 3] }).success, true);
    assert.equal(Transform.safeParse({ scale: [0, 1, 1] }).success, false);
    assert.equal(Transform.safeParse({ scale: [-1, 1, 1] }).success, false);
    assert.equal(Transform.safeParse({ translate: [1, 2, 3], extra: 1 }).success, false);
  });
});

describe('Bounds', () => {
  it('允许网格平面（某轴 max 与 min 相等）', () => {
    assert.equal(Bounds.safeParse({ min: [0, 0, 0], max: [1, 0, 1] }).success, true);
    assert.equal(Bounds.safeParse({ min: [-2, 3, 4], max: [-2, 3, 4] }).success, true);
  });

  it('拒绝任一轴倒置，即使容差只有 1e-7', () => {
    const result = Bounds.safeParse({ min: [0, 1e-7, 0], max: [1, 0, 1] });
    if (result.success) assert.fail('应拒绝倒置包围盒');
    assert.match(result.error.issues.map((i) => i.message).join('；'), /max ≥ min/);
    assert.equal(Bounds.safeParse({ min: [0, 0, 0], max: [0, -1e-7, 0] }).success, false);
  });
});

describe('Part 顶点与三角计数下限', () => {
  it('拒绝空三角（indices=[]）', () => {
    const result = Part.safeParse(partWith({ indices: [] }));
    assert.equal(result.success, false);
  });

  it('拒绝少于 3 个顶点（positions 少于 9 个数）', () => {
    assert.equal(Part.safeParse(partWith({ positions: [0, 0, 0, 1, 0, 0], indices: [0, 0, 0] })).success, false);
    assert.equal(Part.safeParse(partWith({ positions: [], indices: [] })).success, false);
  });

  it('接受平面片（bounds 某轴 max=min）', () => {
    const planar = partWith({
      positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 0, 1] },
    });
    const result = Part.safeParse(planar);
    if (!result.success) assert.fail(`平面片应合法：${result.error.issues.map((i) => i.message).join('；')}`);
  });

  it('拒绝倒置包围盒的薄片', () => {
    const inverted = partWith({
      positions: [0, -1e-7, 0, 1, -1e-7, 0, 0, -1e-7, 1],
      indices: [0, 1, 2],
      bounds: { min: [0, 1e-7, 0], max: [1, 0, 1] },
    });
    assert.equal(Part.safeParse(inverted).success, false);
  });
});

describe('sampledProfileProblem', () => {
  it('接受圆柱 / 圆锥母线', () => {
    assert.equal(
      sampledProfileProblem([
        [1, 0],
        [1, 1],
        [1, 2],
      ]),
      null,
    );
    assert.equal(
      sampledProfileProblem([
        [0, 0],
        [1, 1],
        [0, 2],
      ]),
      null,
    );
  });

  it('拒绝负半径、高度不递增、中间半径为 0', () => {
    assert.match(
      sampledProfileProblem([
        [-1, 0],
        [1, 1],
      ]) ?? '',
      /半径/,
    );
    assert.match(
      sampledProfileProblem([
        [1, 0],
        [1, 0],
      ]) ?? '',
      /严格递增/,
    );
    assert.match(
      sampledProfileProblem([
        [1, 0],
        [0, 1],
        [1, 2],
      ]) ?? '',
      /中间采样/,
    );
  });
});

describe('SampledProfile', () => {
  const valid = [
    [1, 0],
    [1, 1],
    [2, 2],
    [2, 3],
    [1, 4],
  ];
  it('接受合法采样', () => {
    assert.equal(SampledProfile.safeParse(valid).success, true);
  });
  it('拒绝过短与非法半径', () => {
    assert.equal(
      SampledProfile.safeParse([
        [1, 0],
        [1, 1],
        [1, 2],
        [1, 3],
      ]).success,
      false,
    );
    assert.equal(
      SampledProfile.safeParse([
        [1, 0],
        [-1, 1],
        [1, 2],
        [1, 3],
        [1, 4],
      ]).success,
      false,
    );
  });
});

describe('checkOutline', () => {
  const square: Point2[] = [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ];

  it('接受凸四边形并能去掉一次重复闭合点', () => {
    const result = checkOutline([...square, [0, 0]]);
    if (!result.ok) assert.fail('应接受凸四边形');
    assert.deepEqual(result.outline, square);
  });

  it('拒绝元素不足', () => {
    const result = checkOutline([
      [0, 0],
      [1, 1],
    ]);
    assert.equal(result.ok, false);
  });

  it('拒绝点数超过上限', () => {
    const many: Point2[] = Array.from({ length: MAX_OUTLINE_POINTS + 1 }, (_, i) =>
      i === MAX_OUTLINE_POINTS ? [1, 1] : [0, 0],
    );
    assert.equal(checkOutline(many).ok, false);
  });

  it('拒绝重复点', () => {
    const result = checkOutline([
      [0, 0],
      [1, 0],
      [0, 0],
    ]);
    assert.equal(result.ok, false);
  });

  it('拒绝面积为零（共线）', () => {
    const result = checkOutline([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    assert.equal(result.ok, false);
  });

  it('拒绝相邻共线退化', () => {
    const result = checkOutline([
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ]);
    assert.equal(result.ok, false);
  });

  it('接受凹形（简单多边形）并标记 convex=false', () => {
    const result = checkOutline([
      [0, 0],
      [4, 0],
      [4, 2],
      [2, 2],
      [2, 4],
      [0, 4],
    ]);
    if (!result.ok) assert.fail('应接受凹的简单多边形');
    assert.equal(result.convex, false);
  });

  it('拒绝自交（五角星顺序）', () => {
    const ring: Point2[] = Array.from({ length: 5 }, (_, i) => {
      const angle = (2 * Math.PI * i) / 5;
      return [4 * Math.cos(angle), 4 * Math.sin(angle)];
    });
    const star: Point2[] = [0, 2, 4, 1, 3].map((i) => ring[i]).filter((point): point is Point2 => point !== undefined);
    const result = checkOutline(star);
    if (result.ok) assert.fail('应拒绝自交轮廓');
    assert.match(result.error, /自交/);
  });
});

describe('SimpleOutline', () => {
  const square = [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ];

  it('接受规范凸轮廓，拒绝带闭合重复点', () => {
    assert.equal(SimpleOutline.safeParse(square).success, true);
    assert.equal(SimpleOutline.safeParse([...square, [0, 0]]).success, false);
  });

  it('接受凹轮廓，拒绝自交', () => {
    const concave = [
      [0, 0],
      [4, 0],
      [4, 2],
      [2, 2],
      [2, 4],
      [0, 4],
    ];
    assert.equal(SimpleOutline.safeParse(concave).success, true);
    assert.equal(
      SimpleOutline.safeParse([
        [0, 0],
        [4, 0],
        [0, 3],
        [4, 3],
      ]).success,
      false,
    );
  });
});

describe('Part', () => {
  it('接受合法网格', () => {
    assert.equal(Part.safeParse(goodPart()).success, true);
  });

  it('接受可选 material（方块名或带状态写法），拒绝空串 / 超长 / 非字符串', () => {
    assert.equal(Part.safeParse(partWith({ material: 'deepslate_tiles' })).success, true);
    assert.equal(Part.safeParse(partWith({ material: 'oak_stairs[facing=north]' })).success, true);
    assert.equal(Part.safeParse(partWith({ material: '' })).success, false);
    assert.equal(Part.safeParse(partWith({ material: 'a'.repeat(200) })).success, true);
    assert.equal(Part.safeParse(partWith({ material: 'a'.repeat(201) })).success, false);
    assert.equal(Part.safeParse(partWith({ material: 5 })).success, false);
  });

  it('拒绝大写色值、非法 role 与未知字段', () => {
    assert.equal(Part.safeParse(partWith({ color: '#AABBCC' })).success, false);
    assert.equal(Part.safeParse(partWith({ role: 'wall' })).success, false);
    assert.equal(Part.safeParse(partWith({ extra: 1 })).success, false);
  });

  it('拒绝顶点 / 索引计数非法与空顶点', () => {
    assert.equal(Part.safeParse(partWith({ positions: [0, 0, 0, 1] })).success, false);
    assert.equal(Part.safeParse(partWith({ indices: [0, 1] })).success, false);
    assert.equal(Part.safeParse(partWith({ positions: [], indices: [] })).success, false);
  });

  it('拒绝索引越界', () => {
    const result = Part.safeParse(partWith({ indices: [0, 1, 9] }));
    if (result.success) assert.fail('应拒绝越界索引');
    assert.match(result.error.issues.map((i) => i.message).join('；'), /索引越界/);
  });

  it('拒绝退化三角', () => {
    const result = Part.safeParse(
      partWith({
        positions: [0, 0, 0, 1, 0, 0, 2, 0, 0],
        indices: [0, 1, 2],
        bounds: { min: [0, 0, 0], max: [2, 0, 0] },
      }),
    );
    if (result.success) assert.fail('应拒绝退化三角');
    assert.match(result.error.issues.map((i) => i.message).join('；'), /退化/);
  });

  it('拒绝包围盒与实际顶点不一致', () => {
    const result = Part.safeParse(partWith({ bounds: { min: [0, 0, 0], max: [5, 1, 0] } }));
    if (result.success) assert.fail('应拒绝不一致包围盒');
    assert.match(result.error.issues.map((i) => i.message).join('；'), /bounds/);
  });

  it('拒绝 float32 下退化的三角（大跨度内的细特征），消息含部件 id 与三角序号', () => {
    // 跨度 2e5；第 2 个三角在 x≈1e5 处只有 1e-3 的细特征：f64 合法，
    // 但减 bounds.min 后 x≈2e5 的 float32 ULP≈0.0156，两个顶点量化成同一点。
    const result = Part.safeParse(
      partWith({
        id: 'thin',
        positions: [-100000, 0, 0, 100000, 0, 0, 0, 1, 0, 100000, 1, 0, 99999.999, 1, 0, 100000, 1.0005, 0],
        indices: [0, 1, 2, 3, 4, 5],
        bounds: { min: [-100000, 0, 0], max: [100000, 1.0005, 0] },
      }),
    );
    if (result.success) assert.fail('应拒绝 float32 退化三角');
    const message = result.error.issues.map((i) => i.message).join('；');
    assert.match(message, /thin/);
    assert.match(message, /渲染精度（float32）下退化/);
    assert.match(message, /第 1 个三角/);
    assert.match(message, /端部半径/);
  });

  it('接受同一细特征但位于原点附近的部件（f32 精度足够）', () => {
    const result = Part.safeParse(
      partWith({
        positions: [0, 0, 0, 2, 0, 0, 1, 0.001, 0],
        indices: [0, 1, 2],
        bounds: { min: [0, 0, 0], max: [2, 0.001, 0] },
      }),
    );
    assert.equal(result.success, true, `原点附近细特征应合法：${JSON.stringify(result.error?.issues)}`);
  });

  it('拒绝未知 source operation', () => {
    assert.equal(Part.safeParse(partWith({ source: { operation: 'sphere', parameters: {} } })).success, false);
  });

  it('拒绝 revolve 采样点数与段数不匹配', () => {
    const source = {
      operation: 'revolve',
      parameters: {
        profileSegments: 5,
        radialSegments: 5,
        sampledProfile: [
          [1, 0],
          [1, 1],
          [1, 2],
          [1, 3],
          [1, 4],
        ],
        transform: transformDocument,
      },
    };
    const result = Part.safeParse(partWith({ source }));
    if (result.success) assert.fail('应拒绝采样点数不匹配');
    assert.match(result.error.issues.map((i) => i.message).join('；'), /采样点数/);
  });
});

describe('ModelDocument', () => {
  function goodDocument(): Raw {
    return { version: 1, parts: [goodPart()] };
  }

  it('接受合法文档', () => {
    assert.equal(ModelDocument.safeParse(goodDocument()).success, true);
  });

  it('运行期允许空 parts（是否可交付由上层闸门判定）', () => {
    assert.equal(ModelDocument.safeParse({ version: 1, parts: [] }).success, true);
  });

  it('拒绝版本号错误与重复 id', () => {
    assert.equal(ModelDocument.safeParse({ ...goodDocument(), version: 3 }).success, false);
    const duplicated = { version: 1, parts: [goodPart(), goodPart()] };
    const result = ModelDocument.safeParse(duplicated);
    if (result.success) assert.fail('应拒绝重复 id');
    assert.match(result.error.issues.map((i) => i.message).join('；'), /id 重复/);
  });

  it('版本矩阵：v1 通过、v2 通过、v2 无 material 通过、v1 带 material 拒绝', () => {
    // v1 旧文档（无 material）继续可读。
    assert.equal(ModelDocument.safeParse({ version: 1, parts: [goodPart()] }).success, true);
    // v2 文档（带 material）合法。
    const withMaterial = partWith({ material: 'deepslate_tiles' });
    assert.equal(ModelDocument.safeParse({ version: 2, parts: [withMaterial] }).success, true);
    // v2 文档不带 material 也合法。
    assert.equal(ModelDocument.safeParse({ version: 2, parts: [goodPart()] }).success, true);
    // v1 带 material 一律拒绝，中文提示升级。
    const rejected = ModelDocument.safeParse({ version: 1, parts: [withMaterial] });
    if (rejected.success) assert.fail('v1 带 material 应被拒绝');
    const message = rejected.error.issues.map((i) => i.message).join('；');
    assert.match(message, /version 1 不支持 material/);
    assert.match(message, /升级为 2/);
  });

  it('拒绝部件数超过上限', () => {
    const parts = Array.from({ length: MAX_PARTS + 1 }, (_, i) => partWith({ id: `p${String(i)}` }));
    assert.equal(ModelDocument.safeParse({ version: 1, parts }).success, false);
  });

  it('拒绝总三角数超过上限', () => {
    const indices = new Array<number>(MAX_TRIANGLES * 3);
    for (let i = 0; i < indices.length; i += 3) {
      indices[i] = 0;
      indices[i + 1] = 1;
      indices[i + 2] = 2;
    }
    const heavy = partWith({ id: 'heavy', indices });
    const extra = partWith({ id: 'extra' });
    const result = ModelDocument.safeParse({ version: 1, parts: [heavy, extra] });
    if (result.success) assert.fail('应拒绝超量三角');
    assert.match(result.error.issues.map((i) => i.message).join('；'), /总三角数/);
  });

  it('拒绝总顶点数超过上限', () => {
    function fatPart(id: string): Raw {
      const positions = new Array<number>(300003).fill(0);
      positions[0] = 0;
      positions[1] = 0;
      positions[2] = 0;
      positions[3] = 1;
      positions[4] = 0;
      positions[5] = 0;
      positions[6] = 0;
      positions[7] = 1;
      positions[8] = 0;
      return partWith({ id, positions, indices: [0, 1, 2], bounds: { min: [0, 0, 0], max: [1, 1, 0] } });
    }
    const result = ModelDocument.safeParse({ version: 1, parts: [fatPart('a'), fatPart('b')] });
    if (result.success) assert.fail('应拒绝超量顶点');
    assert.match(result.error.issues.map((i) => i.message).join('；'), /总顶点数/);
  });
});

describe('调用参数 schema', () => {
  it('BoxOptionsSchema 要求正尺寸与必填字段', () => {
    assert.equal(
      BoxOptionsSchema.safeParse({ id: 'b', name: '盒', role: 'volume', color: '#000000', size: [1, 2, 3] }).success,
      true,
    );
    assert.equal(
      BoxOptionsSchema.safeParse({ id: 'b', name: '盒', role: 'volume', color: '#000000', size: [0, 2, 3] }).success,
      false,
    );
    assert.equal(
      BoxOptionsSchema.safeParse({ name: '盒', role: 'volume', color: '#000000', size: [1, 2, 3] }).success,
      false,
    );
  });

  it('RevolveOptionsSchema 允许 profile 是任意值（运行期再判函数）', () => {
    const base = { id: 'r', name: '顶', role: 'roof', color: '#000000', profile: 'not-a-function' };
    assert.equal(RevolveOptionsSchema.safeParse(base).success, true);
    assert.equal(RevolveOptionsSchema.safeParse({ ...base, profileSegments: 3 }).success, false);
    assert.equal(RevolveOptionsSchema.safeParse({ ...base, extra: 1 }).success, false);
  });

  it('ExtrudeOptionsSchema 要求至少 3 点与正高度', () => {
    const base = {
      id: 'e',
      name: '柱',
      role: 'volume',
      color: '#000000',
      outline: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      height: 2,
    };
    assert.equal(ExtrudeOptionsSchema.safeParse(base).success, true);
    assert.equal(ExtrudeOptionsSchema.safeParse({ ...base, height: 0 }).success, false);
    assert.equal(
      ExtrudeOptionsSchema.safeParse({
        ...base,
        outline: [
          [0, 0],
          [1, 0],
        ],
      }).success,
      false,
    );
  });

  it('SurfaceOptionsSchema 要求段数在 4..128、position 任意值（运行期再判函数）', () => {
    const base = {
      id: 's',
      name: '面',
      role: 'roof',
      color: '#000000',
      uSegments: 8,
      vSegments: 8,
      position: 'not-a-function',
    };
    assert.equal(SurfaceOptionsSchema.safeParse(base).success, true);
    assert.equal(SurfaceOptionsSchema.safeParse({ ...base, closedU: true }).success, true);
    assert.equal(SurfaceOptionsSchema.safeParse({ ...base, uSegments: 3 }).success, false);
    assert.equal(SurfaceOptionsSchema.safeParse({ ...base, vSegments: 129 }).success, false);
    assert.equal(SurfaceOptionsSchema.safeParse({ ...base, uSegments: 8.5 }).success, false);
    assert.equal(SurfaceOptionsSchema.safeParse({ ...base, extra: 1 }).success, false);
  });
});
