/**
 * scheme-validation：跨集合校验的回归测试。
 *
 * 负责：家具材质引用、家具越界、室内空间引用与屋面高差等关键交叉约束。
 * 不负责：结构 schema 的字段类型（scheme.test.ts）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleScheme } from './example.ts';
import { DesignScheme } from './scheme.ts';

function withFirstFurniture(
  change: (furniture: ReturnType<typeof exampleScheme>['interiors'][number]['furnitureSpecs'][number]) => unknown,
): unknown {
  const base = exampleScheme();
  return {
    ...base,
    interiors: base.interiors.map((interior, interiorIndex) =>
      interiorIndex === 0
        ? {
            ...interior,
            furnitureSpecs: interior.furnitureSpecs.map((furniture, furnitureIndex) =>
              furnitureIndex === 0 ? change(furniture) : furniture,
            ),
          }
        : interior,
    ),
  };
}

test('家具材质必须引用方案内材质', () => {
  const parsed = DesignScheme.safeParse(withFirstFurniture((furniture) => ({ ...furniture, materialId: 'm-missing' })));
  assert.equal(parsed.success, false);
  assert.ok(parsed.error.issues.some((issue) => issue.message.includes('不存在的材质')));
});

test('家具完全在所属空间之外时拒绝', () => {
  const parsed = DesignScheme.safeParse(
    withFirstFurniture((furniture) => ({
      ...furniture,
      bounds: { min: [0, 1, 0], max: [2, 2, 2] },
    })),
  );
  assert.equal(parsed.success, false);
  assert.ok(parsed.error.issues.some((issue) => issue.message.includes('与所属空间 sp-tea 没有重叠')));
});

test('家具局部外挑但和所属空间有重叠时通过', () => {
  const parsed = DesignScheme.safeParse(
    withFirstFurniture((furniture) => ({
      ...furniture,
      // sp-tea 是 [5,1,5)-[13,5,11)；这里向东外挑到 14，仍有体积重叠。
      bounds: { min: [12, 1, 9], max: [14, 3, 10] },
    })),
  );
  assert.equal(parsed.success, true);
});

test('室外空间的家具可以落在建筑范围之外', () => {
  const base = exampleScheme();
  const material = base.materials[0];
  assert.ok(material !== undefined);
  const parsed = DesignScheme.safeParse({
    ...base,
    interiors: [
      ...base.interiors,
      {
        id: 'in-terrace',
        spaceId: 'sp-terrace',
        name: '檐下平台',
        furniture: ['坐凳'],
        furnitureSpecs: [
          {
            id: 'fx-terrace',
            name: '坐凳',
            kind: 'bench',
            bounds: { min: [5, 0, 15], max: [8, 1, 17] },
            materialId: material.id,
            orientation: null,
            notes: null,
          },
        ],
        included: true,
        notes: null,
      },
    ],
  });
  assert.equal(parsed.success, true);
});

test('家具 id 在同一室内内唯一', () => {
  const base = exampleScheme();
  const first = base.interiors[0];
  assert.ok(first !== undefined);
  const duplicated = {
    ...base,
    interiors: base.interiors.map((interior, index) =>
      index === 0 && interior.furnitureSpecs[0] !== undefined
        ? { ...interior, furnitureSpecs: [interior.furnitureSpecs[0], interior.furnitureSpecs[0]] }
        : interior,
    ),
  };
  const parsed = DesignScheme.safeParse(duplicated);
  assert.equal(parsed.success, false);
  assert.ok(parsed.error.issues.some((issue) => issue.message.includes('家具 id 重复')));
});
