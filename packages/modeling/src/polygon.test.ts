/** polygon 的单元测试：简单轮廓校验（凸 / 凹 / 自交）、ear clipping 三角化的面积与绕序。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkOutline, cross2, signedArea2, triangulateOutline } from './polygon.ts';
import type { Point2 } from './schema.ts';

/** L 形：6 个顶点、面积 12（凹）。 */
const L_SHAPE: readonly Point2[] = [
  [0, 0],
  [4, 0],
  [4, 2],
  [2, 2],
  [2, 4],
  [0, 4],
];

/** 十字形：12 个顶点，横臂长 8、竖臂高 8、臂宽 2（凹）。 */
const CROSS: readonly Point2[] = [
  [1, 0],
  [5, 0],
  [5, 2],
  [7, 2],
  [7, 6],
  [5, 6],
  [5, 8],
  [1, 8],
  [1, 6],
  [-1, 6],
  [-1, 2],
  [1, 2],
];

/** 三角化后所有三角的 2 倍有向面积之和与绝对值之和。 */
function areaSums(outline: readonly Point2[], convex: boolean): { signed: number; absolute: number } {
  const indices = triangulateOutline(outline, convex);
  let signed = 0;
  let absolute = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = outline[indices[t] ?? 0];
    const b = outline[indices[t + 1] ?? 0];
    const c = outline[indices[t + 2] ?? 0];
    if (a === undefined || b === undefined || c === undefined) throw new Error('三角下标越界');
    const area2 = cross2(a, b, c);
    signed += area2;
    absolute += Math.abs(area2);
  }
  return { signed, absolute };
}

describe('checkOutline 简单多边形', () => {
  it('接受 L 形与十字形并标记 convex=false', () => {
    for (const outline of [L_SHAPE, CROSS]) {
      const result = checkOutline(outline);
      if (!result.ok) assert.fail(`应接受简单凹多边形：${result.error}`);
      assert.equal(result.convex, false);
    }
  });

  it('接受凸多边形并标记 convex=true', () => {
    const result = checkOutline([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
    if (!result.ok) assert.fail('应接受凸四边形');
    assert.equal(result.convex, true);
  });

  it('拒绝自交轮廓并给出「轮廓自交」', () => {
    const ring: Point2[] = Array.from({ length: 5 }, (_, i) => {
      const angle = (2 * Math.PI * i) / 5;
      return [4 * Math.cos(angle), 4 * Math.sin(angle)];
    });
    const star: Point2[] = [0, 2, 4, 1, 3].map((i) => ring[i]).filter((point): point is Point2 => point !== undefined);
    const result = checkOutline(star);
    if (result.ok) assert.fail('应拒绝自交轮廓');
    assert.match(result.error, /轮廓自交/);
  });
});

describe('triangulateOutline', () => {
  it('凸多边形走扇形快路径：n−2 个三角、面积和等于 |有向面积|', () => {
    const square: readonly Point2[] = [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ];
    const indices = triangulateOutline(square, true);
    assert.equal(indices.length / 3, 2);
    const { signed, absolute } = areaSums(square, true);
    assert.equal(signed, signedArea2(square));
    assert.equal(absolute, Math.abs(signedArea2(square)));
    assert.equal(absolute, 24);
  });

  it('L 形 ear clipping：n−2 个三角、无漏面无翻面（面积和 = 有向面积）', () => {
    const checked = checkOutline(L_SHAPE);
    if (!checked.ok) assert.fail('L 形应合法');
    const indices = triangulateOutline(L_SHAPE, checked.convex);
    assert.equal(indices.length / 3, L_SHAPE.length - 2);
    const { signed, absolute } = areaSums(L_SHAPE, checked.convex);
    assert.equal(signed, signedArea2(L_SHAPE));
    assert.equal(absolute, Math.abs(signedArea2(L_SHAPE)));
    assert.equal(absolute, 24, '手工面积：4×2 + 2×2 = 12，2 倍为 24');
  });

  it('十字形 ear clipping：n−2 个三角、面积和 = 有向面积', () => {
    const checked = checkOutline(CROSS);
    if (!checked.ok) assert.fail('十字形应合法');
    const indices = triangulateOutline(CROSS, checked.convex);
    assert.equal(indices.length / 3, CROSS.length - 2);
    const { signed, absolute } = areaSums(CROSS, checked.convex);
    assert.equal(signed, signedArea2(CROSS));
    assert.equal(absolute, Math.abs(signedArea2(CROSS)));
    assert.equal(absolute, 96, '手工面积：十字形面积 48，2 倍为 96');
  });

  it('顺时针轮廓的三角绕序与负有向面积同号', () => {
    const clockwise: readonly Point2[] = [...L_SHAPE].reverse();
    const checked = checkOutline(clockwise);
    if (!checked.ok) assert.fail('反向 L 形应合法');
    const indices = triangulateOutline(clockwise, checked.convex);
    let allNegative = true;
    for (let t = 0; t < indices.length; t += 3) {
      const a = clockwise[indices[t] ?? 0];
      const b = clockwise[indices[t + 1] ?? 0];
      const c = clockwise[indices[t + 2] ?? 0];
      if (a === undefined || b === undefined || c === undefined) throw new Error('三角下标越界');
      if (cross2(a, b, c) >= 0) allNegative = false;
    }
    assert.equal(allNegative, true);
  });
});
