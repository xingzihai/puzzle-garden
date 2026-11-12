/**
 * mesh-scene.ts 的单元测试：`/api/model` 响应窄化（好 / 坏样本）、几何与包围盒、
 * 剖切面应用、详情文案与 source JSON 文本。
 *
 * 用 `@pg/modeling` 的 createModel 生成真实文档，再 JSON 往返模拟服务端响应；
 * three 在 Node 里建 BufferGeometry（不需要 WebGL）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { createModel } from '@pg/modeling/model';

import {
  buildMeshScene,
  clipPlaneFor,
  clipValueRange,
  createPartMesh,
  disposeMeshScene,
  modelBounds,
  parseModelDocument,
  partDetailEntries,
  partGeometry,
  partOrigin,
  partSize,
  setClipPlanes,
  sourceJson,
} from './mesh-scene.ts';
import type { ViewerPart } from './mesh-scene.ts';
import { overallPose } from './controls.ts';

/** 世界坐标转 float64 的薄板：size 0.001、平移到 99999；用于验证 origin 本地化不压扁它。 */
function thinDistantModel(): { readonly part: ViewerPart } {
  const model = createModel();
  model.box({
    id: 'part-thin',
    name: '薄板',
    role: 'volume',
    color: '#8899aa',
    size: [0.001, 1, 1],
    transform: { translate: [99999, 0, 0] },
  });
  const parsed = parseModelDocument(JSON.parse(JSON.stringify(model.finish())));
  const part = parsed.parts[0];
  if (part === undefined) throw new Error('缺少薄板部件');
  return { part };
}

function rawDocument(): unknown {
  const model = createModel();
  model.box({ id: 'part-box', name: '体量盒', role: 'volume', color: '#8899aa', size: [4, 6, 8] });
  model.revolve({
    id: 'part-roof',
    name: '旋转屋顶',
    role: 'roof',
    color: '#aa8899',
    profile: (t: number) => [10 * (1 - t), 20 * t],
    profileSegments: 8,
    radialSegments: 12,
  });
  model.extrude({
    id: 'part-pad',
    name: '拉伸底板',
    role: 'floor',
    color: '#99aa88',
    outline: [
      [0, 0],
      [5, 0],
      [5, 5],
    ],
    height: 1,
  });
  return JSON.parse(JSON.stringify(model.finish())) as unknown;
}

function parsedParts(): readonly ViewerPart[] {
  return parseModelDocument(rawDocument()).parts;
}

/** 含 surface 的文档：闭合圆筒（closedU=true）与非闭合平面（closedU=false）各一。 */
function surfaceDocument(): unknown {
  const model = createModel();
  model.surface({
    id: 'part-shell',
    name: '曲面壳',
    role: 'roof',
    color: '#8899aa',
    uSegments: 8,
    vSegments: 4,
    closedU: true,
    position: (u: number, v: number) => [4 * Math.cos(2 * Math.PI * u), 6 * v, 4 * Math.sin(2 * Math.PI * u)],
  });
  model.surface({
    id: 'part-plane',
    name: '曲面平板',
    role: 'floor',
    color: '#99aa88',
    uSegments: 4,
    vSegments: 6,
    position: (u: number, v: number) => [u * 5, 0, v * 3],
  });
  return JSON.parse(JSON.stringify(model.finish())) as unknown;
}

function parsedSurfaces(): readonly ViewerPart[] {
  return parseModelDocument(surfaceDocument()).parts;
}

/** 带非单位 transform 的 surface：scale [2,1,2] 后 translate [100,0,0]。 */
function transformedSurfaceDocument(): unknown {
  const model = createModel();
  model.surface({
    id: 'part-shift',
    name: '平移缩放曲面',
    role: 'roof',
    color: '#8899aa',
    uSegments: 4,
    vSegments: 4,
    position: (u: number, v: number) => [u * 5, 0, v * 3],
    transform: { translate: [100, 0, 0], scale: [2, 1, 2] },
  });
  return JSON.parse(JSON.stringify(model.finish())) as unknown;
}

/** 远离原点的薄曲面：验证 surface 也走同一套 origin 本地化。 */
function thinDistantSurface(): { readonly part: ViewerPart } {
  const model = createModel();
  model.surface({
    id: 'part-thin-shell',
    name: '薄曲面',
    role: 'roof',
    color: '#8899aa',
    uSegments: 4,
    vSegments: 4,
    position: (u: number, v: number) => [u * 0.001, 0, v * 1],
    transform: { translate: [99999, 0, 0] },
  });
  const part = parseModelDocument(JSON.parse(JSON.stringify(model.finish()))).parts[0];
  if (part === undefined) throw new Error('缺少薄曲面部件');
  return { part };
}

test('parseModelDocument 接受 schema 校验过的 JSON 往返', () => {
  const model = parseModelDocument(rawDocument());
  assert.equal(model.version, 2);
  assert.equal(model.parts.length, 3);
  const box = model.parts[0];
  assert.ok(box !== undefined);
  assert.equal(box.id, 'part-box');
  assert.equal(box.role, 'volume');
  assert.equal(box.source.operation, 'box');
  assert.equal(box.positions.length, 8 * 3);
  assert.equal(box.indices.length, 12 * 3);
  assert.deepEqual(box.bounds, { min: [0, 0, 0], max: [4, 6, 8] });
});

test('parseModelDocument 拒绝版本、角色、坐标、索引与 source 的坏样本', () => {
  const base = rawDocument() as { version: unknown; parts: readonly Record<string, unknown>[] };
  const first = base.parts[0];
  assert.ok(first !== undefined);
  const part = (overrides: Record<string, unknown>): unknown => ({ ...first, ...overrides });
  const cases: readonly unknown[] = [
    null,
    'not a document',
    { version: 3, parts: [] },
    { version: 1, parts: part({ role: 'wall' }) },
    { version: 1, parts: part({ positions: [0, 1, Number.POSITIVE_INFINITY] }) },
    { version: 1, parts: part({ indices: [-1, 0, 1] }) },
    { version: 1, parts: part({ indices: [0.5, 1, 2] }) },
    { version: 1, parts: part({ color: 'red' }) },
    { version: 1, parts: part({ material: '' }) },
    { version: 1, parts: part({ material: 5 }) },
    { version: 1, parts: part({ material: 'stone' }) },
    { version: 2, parts: part({ material: 'a'.repeat(201) }) },
    { version: 1, parts: part({ bounds: { min: [0, 0, 0], max: [0, 0, 0] } }) },
    { version: 1, parts: part({ source: { operation: 'nope', parameters: {} } }) },
    { version: 1, parts: part({ source: undefined }) },
  ];
  for (const value of cases) {
    assert.throws(() => parseModelDocument(value), Error, JSON.stringify(value));
  }
});

test('parseModelDocument 读取兼容 v1（无 material）与 v2（带 material）', () => {
  const base = rawDocument() as { version: number; parts: readonly Record<string, unknown>[] };
  const first = base.parts[0];
  assert.ok(first !== undefined);

  const v1 = parseModelDocument({ version: 1, parts: [first] });
  assert.equal(v1.version, 1);
  assert.equal(v1.parts[0]?.material, undefined);

  const v2 = parseModelDocument({ version: 2, parts: [{ ...first, material: 'deepslate_tiles' }] });
  assert.equal(v2.version, 2);
  assert.equal(v2.parts[0]?.material, 'deepslate_tiles');
});

test('parseModelDocument 接受 surface：段数 / closedU / transform 与网格计数', () => {
  const model = parseModelDocument(surfaceDocument());
  assert.equal(model.parts.length, 2);
  const shell = model.parts[0];
  const plane = model.parts[1];
  assert.ok(shell !== undefined && plane !== undefined);

  assert.equal(shell.source.operation, 'surface');
  assert.equal(shell.source.parameters['uSegments'], 8);
  assert.equal(shell.source.parameters['vSegments'], 4);
  assert.equal(shell.source.parameters['closedU'], true);
  const transform = shell.source.parameters['transform'] as Record<string, unknown>;
  assert.deepEqual(transform['translate'], [0, 0, 0]);
  assert.deepEqual(transform['rotate'], [0, 0, 0]);
  assert.deepEqual(transform['scale'], [1, 1, 1]);
  // closedU=true：顶点数 uSegments×(vSegments+1)，三角数 2·uSegments·vSegments（不复制缝合列）。
  assert.equal(shell.positions.length, 8 * (4 + 1) * 3);
  assert.equal(shell.indices.length, 2 * 8 * 4 * 3);

  assert.equal(plane.source.operation, 'surface');
  assert.equal(plane.source.parameters['closedU'], false);
  // closedU=false：顶点数 (uSegments+1)×(vSegments+1)。
  assert.equal(plane.positions.length, (4 + 1) * (6 + 1) * 3);
  assert.equal(plane.indices.length, 2 * 4 * 6 * 3);
});

test('parseModelDocument 拒绝 surface 坏样本：未知 operation、段数越界/非整数、closedU 非布尔、缺 transform', () => {
  const base = surfaceDocument() as { version: unknown; parts: readonly Record<string, unknown>[] };
  const shell = base.parts[0];
  assert.ok(shell !== undefined);
  const source = shell['source'] as { operation: unknown; parameters: Record<string, unknown> };
  const withParameters = (overrides: Record<string, unknown>): unknown => ({
    ...shell,
    source: { operation: 'surface', parameters: { ...source.parameters, ...overrides } },
  });
  const cases: readonly unknown[] = [
    { version: 1, parts: [{ ...shell, source: { operation: 'nope', parameters: source.parameters } }] },
    { version: 1, parts: [withParameters({ uSegments: 3 })] },
    { version: 1, parts: [withParameters({ uSegments: 129 })] },
    { version: 1, parts: [withParameters({ uSegments: 8.5 })] },
    { version: 1, parts: [withParameters({ vSegments: 0 })] },
    { version: 1, parts: [withParameters({ vSegments: 4.5 })] },
    { version: 1, parts: [withParameters({ closedU: 'yes' })] },
    { version: 1, parts: [withParameters({ closedU: 1 })] },
    { version: 1, parts: [withParameters({ transform: undefined })] },
    { version: 1, parts: [withParameters({ transform: { translate: [0, 0, 0] } })] },
  ];
  for (const value of cases) {
    assert.throws(() => parseModelDocument(value), Error, JSON.stringify(value));
  }
});

test('surface 走通用 partGeometry：Float32 本地化与量化退化校验照常生效', () => {
  const shell = parsedSurfaces()[0];
  assert.ok(shell !== undefined);
  const geometry = partGeometry(shell);
  const position = geometry.getAttribute('position');
  assert.ok(position.array instanceof Float32Array);
  assert.equal(position.count, shell.positions.length / 3);
  const index = geometry.getIndex();
  assert.ok(index !== null);
  assert.equal(index.count, shell.indices.length);
  geometry.dispose();

  // 远离原点的薄曲面：origin 本地化后 x 跨度仍约 0.001，mesh.position 还原世界坐标。
  const { part } = thinDistantSurface();
  assert.deepEqual(partOrigin(part), [99999, 0, 0]);
  const mesh = createPartMesh(part);
  assert.deepEqual([mesh.position.x, mesh.position.y, mesh.position.z], [99999, 0, 0]);
  const local = mesh.geometry.getAttribute('position');
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < local.count; i += 1) {
    const x = local.getX(i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  assert.ok(Math.abs(maxX - minX - 0.001) < 1e-6, `本地 x 跨度 ${String(maxX - minX)}`);

  // 量化退化：手写 surface 版细缝，partGeometry 仍抛出明确错误而非静默画破面。
  const sliver: ViewerPart = {
    id: 'part-sliver-surface',
    name: '曲面细缝',
    role: 'roof',
    color: '#8899aa',
    positions: [0, 0, 0, 99999, 99999, 0, 99999.001, 99999, 0],
    indices: [0, 1, 2],
    bounds: { min: [0, 0, 0], max: [99999.001, 99999, 0] },
    source: {
      operation: 'surface',
      parameters: {
        uSegments: 4,
        vSegments: 4,
        closedU: false,
        transform: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
      },
    },
  };
  assert.throws(() => partGeometry(sliver), /量化后退化/);
});

test('buildMeshScene 把 surface 与其它部件一视同仁建 Mesh', () => {
  const meshScene = buildMeshScene(parseModelDocument(surfaceDocument()));
  assert.equal(meshScene.partById.size, 2);
  assert.equal(meshScene.group.children.length, 2);
  const shell = meshScene.partById.get('part-shell');
  assert.ok(shell !== undefined);
  assert.equal(shell.name, 'part-shell');
  assert.ok(shell.geometry.getAttribute('position').array instanceof Float32Array);
  disposeMeshScene(meshScene);
});

test('modelBounds 是全部部件的并集；空模型回退到 1×1×1', () => {
  const bounds = modelBounds(parseModelDocument(rawDocument()));
  // revolve 绕 y 轴，半径 10，水平范围 ±10；box 与 extrude 在正卦限内。
  assert.deepEqual(bounds.min, [-10, 0, -10]);
  assert.deepEqual(bounds.max, [10, 20, 10]);
  const empty = modelBounds({ version: 1, parts: [] });
  assert.deepEqual(empty, { min: [0, 0, 0], max: [1, 1, 1] });
});

test('partSize 返回三轴长度', () => {
  const box = parsedParts()[0];
  assert.ok(box !== undefined);
  assert.deepEqual(partSize(box), [4, 6, 8]);
});

test('partGeometry 建顶点 / 索引并算法线', () => {
  const box = parsedParts()[0];
  assert.ok(box !== undefined);
  const geometry = partGeometry(box);
  const position = geometry.getAttribute('position');
  assert.equal(position.count, box.positions.length / 3);
  const normal = geometry.getAttribute('normal');
  assert.equal(normal.count, position.count);
  const index = geometry.getIndex();
  assert.ok(index !== null);
  assert.equal(index.count, box.indices.length);
  geometry.dispose();
});

test('buildMeshScene 默认包含全部部件与灯光，setClipPlanes 可加可清', () => {
  const model = parseModelDocument(rawDocument());
  const meshScene = buildMeshScene(model);
  assert.equal(meshScene.partById.size, 3);
  assert.equal(meshScene.group.children.length, 3);
  const box = meshScene.partById.get('part-box');
  assert.ok(box !== undefined);
  assert.equal(box.name, 'part-box');

  const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1);
  setClipPlanes(meshScene, [plane]);
  for (const mesh of meshScene.partById.values()) {
    const material = mesh.material;
    const entries = Array.isArray(material) ? material : [material];
    assert.equal(entries[0]?.clippingPlanes?.length, 1);
  }
  setClipPlanes(meshScene, []);
  assert.equal((meshScene.partById.get('part-box')?.material as THREE.Material).clippingPlanes?.length, 0);

  disposeMeshScene(meshScene);
  disposeMeshScene(meshScene);
});

test('clip 重导出与 scene.ts 同口径：范围取包围盒，none 给占位', () => {
  const bounds = { min: [0, 0, 0] as const, max: [4, 6, 8] as const };
  assert.deepEqual(clipValueRange(bounds, 'x'), [0, 4]);
  assert.deepEqual(clipValueRange(bounds, 'none'), [0, 1]);
  const plane = clipPlaneFor('y', 3);
  assert.ok(plane !== null);
  assert.ok(plane.distanceToPoint(new THREE.Vector3(0, 2, 0)) > 0);
  assert.ok(plane.distanceToPoint(new THREE.Vector3(0, 4, 0)) < 0);
  assert.equal(clipPlaneFor('none', 0), null);
});

test('partDetailEntries 覆盖名称 / 操作 / box 尺寸 / 旋转半径 / 拉伸高度', () => {
  const [box, roof, pad] = parsedParts();
  assert.ok(box !== undefined && roof !== undefined && pad !== undefined);
  const boxEntries = new Map(partDetailEntries(box));
  assert.equal(boxEntries.get('名称'), '体量盒');
  assert.equal(boxEntries.get('用途'), '体量');
  assert.equal(boxEntries.get('操作'), 'box（盒）');
  assert.equal(boxEntries.get('box 尺寸'), '4 × 6 × 8');

  const roofEntries = new Map(partDetailEntries(roof));
  assert.equal(roofEntries.get('用途'), '屋顶');
  assert.equal(roofEntries.get('操作'), 'revolve（旋转）');
  assert.equal(roofEntries.get('采样'), '8 × 12');
  assert.equal(roofEntries.get('半径'), '0 → 10');
  assert.ok((roofEntries.get('母线高') ?? '').includes('0 → 20'));

  const padEntries = new Map(partDetailEntries(pad));
  assert.equal(padEntries.get('操作'), 'extrude（拉伸）');
  assert.equal(padEntries.get('拉伸高度'), '1');
  assert.equal(padEntries.get('轮廓点数'), '3');
});

test('partDetailEntries：surface 显示 操作 / 采样 / closedU，非单位 transform 与其它操作同口径', () => {
  const [shell, plane] = parsedSurfaces();
  assert.ok(shell !== undefined && plane !== undefined);

  const shellEntries = new Map(partDetailEntries(shell));
  assert.equal(shellEntries.get('用途'), '屋顶');
  assert.equal(shellEntries.get('操作'), 'surface（曲面）');
  assert.equal(shellEntries.get('采样'), '8 × 4');
  assert.equal(shellEntries.get('closedU'), '是');

  const planeEntries = new Map(partDetailEntries(plane));
  assert.equal(planeEntries.get('操作'), 'surface（曲面）');
  assert.equal(planeEntries.get('采样'), '4 × 6');
  assert.equal(planeEntries.get('closedU'), '否');

  // 非单位 transform 已应用到世界坐标：尺寸 / 包围盒与其它操作一样，显示变换后的结果。
  const shifted = parseModelDocument(transformedSurfaceDocument()).parts[0];
  assert.ok(shifted !== undefined);
  const shiftedEntries = new Map(partDetailEntries(shifted));
  assert.equal(shiftedEntries.get('操作'), 'surface（曲面）');
  assert.equal(shiftedEntries.get('采样'), '4 × 4');
  assert.equal(shiftedEntries.get('closedU'), '否');
  assert.equal(shiftedEntries.get('尺寸'), '10 × 0 × 6');
  assert.equal(shiftedEntries.get('包围盒'), '[100, 0, 0] → [110, 0, 6]');
});

test('sourceJson 是可解析 JSON 且不含函数', () => {
  const roof = parsedParts()[1];
  assert.ok(roof !== undefined);
  const text = sourceJson(roof);
  const parsed = JSON.parse(text) as { operation: string; parameters: Record<string, unknown> };
  assert.equal(parsed.operation, 'revolve');
  assert.ok(Array.isArray(parsed.parameters['sampledProfile']));
  assert.ok(!text.includes('function'));
});

test('薄且远离原点的 box：origin 本地化后 x 跨度仍约 0.001，mesh.position 还原世界坐标', () => {
  const { part } = thinDistantModel();
  assert.deepEqual(partOrigin(part), [99999, 0, 0]);
  const mesh = createPartMesh(part);
  assert.deepEqual([mesh.position.x, mesh.position.y, mesh.position.z], [99999, 0, 0]);

  const position = mesh.geometry.getAttribute('position');
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  // 若直接上传世界坐标，99999.001 在 float32 里会舍成 99999，跨度变 0。
  assert.ok(Math.abs(maxX - minX - 0.001) < 1e-6, `本地 x 跨度 ${String(maxX - minX)}`);

  mesh.updateMatrixWorld(true);
  const world = new THREE.Box3().setFromObject(mesh);
  assert.ok(Math.abs(world.max.x - world.min.x - 0.001) < 1e-6, `世界 x 跨度 ${String(world.max.x - world.min.x)}`);
});

test('本地化几何的 raycast 与取景仍按世界坐标工作', () => {
  const { part } = thinDistantModel();
  const mesh = createPartMesh(part);
  mesh.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(99998, 0.5, 0.5), new THREE.Vector3(1, 0, 0));
  const hits = raycaster.intersectObject(mesh, false);
  assert.ok(hits.length > 0, '射线应命中世界坐标 x≈99999 的薄板');

  const { part: part2 } = thinDistantModel();
  const pose = overallPose(modelBounds({ version: 1, parts: [part2] }), 1.5);
  for (const value of [...pose.position, ...pose.target]) assert.ok(Number.isFinite(value));
});

test('单部件跨度巨大抹掉内部细特征：量化后退化抛明确错误，不静默画破面', () => {
  // 为什么不再用 createModel.extrude 造件：建模层现在会在创建网格时就以同一 float32 口径
  // 拒绝这种退化件（addPart / finish 即抛“渲染精度（float32）下退化”），
  // 等价几何的创建期拒绝由 packages/modeling 的单元测试覆盖（model.test.ts 的
  // “大跨度内的真实细特征”、schema.test.ts 的“拒绝 float32 下退化的三角”），此处不重复。
  // 本测试改为直接手写 ViewerPart 风格对象（positions / indices / bounds / source 齐全），
  // 绕过 parse 直接喂给 partGeometry，专门守住渲染层自己的防御不能被误删。
  //
  // 几何：x=99999.001 与 x=99999 两点相差 0.001；bounds.min 在原点，float64 下两点非共线。
  // 减 origin 后局部 x 仍约 99999，float32 的 ULP≈0.0078 把两点并成一点，第 0 个三角塌成零面积。
  const part: ViewerPart = {
    id: 'part-sliver',
    name: '细缝',
    role: 'volume',
    color: '#8899aa',
    positions: [0, 0, 0, 99999, 99999, 0, 99999.001, 99999, 0],
    indices: [0, 1, 2],
    bounds: { min: [0, 0, 0], max: [99999.001, 99999, 0] },
    source: {
      operation: 'extrude',
      parameters: {
        outline: [
          [0, 0],
          [99999, 99999],
          [99999.001, 99999],
        ],
        height: 1,
      },
    },
  };
  assert.throws(() => partGeometry(part), /量化后退化/);
});
