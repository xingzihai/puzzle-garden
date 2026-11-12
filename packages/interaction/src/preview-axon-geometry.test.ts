import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleScheme } from './example.ts';
import {
  furnitureBoxes,
  isoBox,
  isoPolygon,
  makeIso,
  roofAnchor,
  roofBounds,
  roofParts,
} from './preview-axon-geometry.ts';
import type { RawBox } from './preview-axon-geometry.ts';

const AREA = { x: 0, y: 0, w: 600, h: 500 };
const BOX: RawBox = { minX: 0, maxX: 10, minY: 0, maxY: 4, minZ: 0, maxZ: 6 };

test('等轴测投影确定性、可居中且不产生 NaN', () => {
  const projection = makeIso(BOX, AREA);
  const center = projection.toScreen(5, 4, 3);
  assert.ok(Number.isFinite(center[0]));
  assert.ok(Number.isFinite(center[1]));
  assert.ok(center[0] > 0 && center[0] < 600);
  assert.ok(center[1] > 0 && center[1] < 500);
  assert.notDeepEqual(projection.toScreen(0, 0, 0), projection.toScreen(10, 0, 6));
  const again = makeIso(BOX, AREA);
  assert.deepEqual(again.toScreen(5, 4, 3), center);
});

test('盒子三面与自定义多边形是合法 SVG 路径', () => {
  const projection = makeIso(BOX, AREA);
  const box = isoBox(BOX, projection, { fill: '#d9c7ad', topFill: '#efe2d0' });
  assert.equal((box.match(/<path /g) ?? []).length, 3);
  assert.doesNotMatch(box, /undefined|NaN/);
  const polygon = isoPolygon(
    [
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 6],
      [0, 0, 6],
    ],
    projection,
    '#eee',
    '#999',
    0.5,
    '4 3',
  );
  assert.match(polygon, /stroke-dasharray="4 3"/);
});

test('双坡屋面、家具盒与屋脊锚点使用同一投影', () => {
  const scheme = exampleScheme();
  const level = scheme.levels[0];
  assert.ok(level !== undefined);
  const rb = roofBounds(scheme);
  assert.deepEqual(rb, scheme.elements.find((element) => element.kind === 'roof')?.bounds);
  const overall: RawBox = {
    minX: -2,
    maxX: 20,
    minY: 0,
    maxY: 10,
    minZ: -2,
    maxZ: 20,
  };
  const projection = makeIso(overall, AREA);
  const roof = roofParts(scheme, projection);
  assert.match(roof, /stroke-dasharray="5 4"/);
  assert.ok((roof.match(/<path /g) ?? []).length >= 3);
  assert.doesNotMatch(roof, /undefined|NaN/);
  const anchor = roofAnchor(scheme, projection);
  assert.ok(Number.isFinite(anchor[0]) && Number.isFinite(anchor[1]));
  const furniture = furnitureBoxes(scheme, level, projection);
  assert.ok((furniture.match(/<path /g) ?? []).length >= 5);
  assert.doesNotMatch(furniture, /undefined|NaN/);
});
