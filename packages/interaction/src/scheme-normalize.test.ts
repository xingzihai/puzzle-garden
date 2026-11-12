import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exampleScheme } from './example.ts';
import { DesignScheme, normalizeSchemeBounds } from './scheme.ts';

test('零厚度 element bounds 按格厚确定性扩成 1 格，并记录修复路径', () => {
  const scheme = exampleScheme();
  const element = scheme.elements[1];
  assert.ok(element !== undefined);
  const payload = {
    ...scheme,
    elements: scheme.elements.map((item, index) =>
      index === 1
        ? {
            ...item,
            bounds: {
              min: item.bounds.min,
              max: [item.bounds.max[0], item.bounds.max[1], item.bounds.min[2]],
            },
          }
        : item,
    ),
  };

  const normalized = normalizeSchemeBounds(payload);
  assert.equal(normalized.repairs.length, 1);
  const repair = normalized.repairs[0];
  assert.ok(repair !== undefined);
  assert.equal(repair.path, 'elements.1.bounds');
  assert.deepEqual(repair.axes, ['z']);
  assert.equal(repair.before.max[2], 4);
  assert.equal(repair.after.max[2], 5);
  assert.equal(DesignScheme.safeParse(normalized.value).success, true);
});

test('零面积家具按 1 格扩成正体积，部分外挑仍由跨集合校验决定', () => {
  const scheme = exampleScheme();
  const payload = {
    ...scheme,
    interiors: scheme.interiors.map((interior, interiorIndex) =>
      interiorIndex === 0
        ? {
            ...interior,
            furnitureSpecs: interior.furnitureSpecs.map((furniture, furnitureIndex) =>
              furnitureIndex === 0
                ? {
                    ...furniture,
                    bounds: {
                      min: furniture.bounds.min,
                      max: [furniture.bounds.min[0], furniture.bounds.max[1], furniture.bounds.max[2]],
                    },
                  }
                : furniture,
            ),
          }
        : interior,
    ),
  };

  const normalized = normalizeSchemeBounds(payload);
  assert.equal(normalized.repairs.length, 1);
  const repair = normalized.repairs[0];
  assert.ok(repair !== undefined);
  assert.equal(repair.path, 'interiors.0.furnitureSpecs.0.bounds');
  assert.deepEqual(repair.axes, ['x']);
  assert.equal(DesignScheme.safeParse(normalized.value).success, true);
});

test('缺失字段、反序 bounds 与 site / spaces / openings 不做静默补全', () => {
  const scheme = exampleScheme();
  const reversed = exampleScheme();
  const firstSpace = reversed.spaces[0];
  assert.ok(firstSpace !== undefined);
  const payload = {
    ...scheme,
    elements: scheme.elements.map((element, index) =>
      index === 0 ? { ...element, bounds: { min: [3, 1, 4], max: [2, 5, 14] } } : element,
    ),
    spaces: reversed.spaces.map((space, index) =>
      index === 0
        ? {
            ...space,
            bounds: {
              min: space.bounds.min,
              max: [space.bounds.min[0], space.bounds.max[1], space.bounds.max[2]],
            },
          }
        : space,
    ),
  };

  const normalized = normalizeSchemeBounds(payload);
  assert.equal(normalized.repairs.length, 0);
  assert.equal(DesignScheme.safeParse(normalized.value).success, false);

  const missing = normalizeSchemeBounds({ meta: scheme.meta });
  assert.deepEqual(missing.repairs, []);
  assert.equal(DesignScheme.safeParse(missing.value).success, false);
});
