/** page/scene.ts：紧凑格表 → three 场景（Node 里可测，不需要 DOM/WebGL）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadRegistry } from '@pg/blocks/load';
import { parseState } from '@pg/core/block-state';
import { createGrid } from '@pg/core/grid';

import * as THREE from 'three';

import { countFaces } from '../mesh.ts';
import { buildScene } from '../scene-buffer.ts';
import { buildSceneFromBuffer } from './scene.ts';

const registry = loadRegistry();
const table = registry.table;

function sampleBuffer(): Uint8Array {
  const grid = createGrid(table);
  for (let x = 0; x < 3; x += 1) grid.set(x, 1, 0, parseState(table, 'stone'), 0, 0);
  grid.set(1, 2, 0, parseState(table, 'glass'), 0, 0);
  grid.set(2, 2, 0, parseState(table, 'oak_stairs'), 0, 0);
  const built = buildScene(grid, registry, 1_000_000);
  if (built.kind !== 'ok') throw new Error(`构建失败：${built.kind}`);
  return built.buffer;
}

test('建立不透明网格 + 描边 + 半透明网格 + 背景与地面', () => {
  const buffer = sampleBuffer();
  const built = buildSceneFromBuffer(buffer);
  assert.equal(built.faceCount, countFaces(buffer));
  assert.ok(built.scene.background instanceof THREE.Color);
  const meshes = built.scene.children.filter((c) => c instanceof THREE.Mesh);
  const lines = built.scene.children.filter((c) => c instanceof THREE.LineSegments);
  assert.ok(meshes.length >= 2, `期望不透明 + 半透明 + 地面，实际 Mesh=${String(meshes.length)}`);
  assert.equal(lines.length, 1);
  const transparent = meshes.filter((m) => {
    const material = (m as THREE.Mesh).material;
    return !Array.isArray(material) && material instanceof THREE.MeshBasicMaterial && material.transparent;
  });
  assert.equal(transparent.length, 1);
  const first = transparent[0];
  assert.ok(first !== undefined);
  // @types/three 的 Mesh.geometry / getAttribute 在严格规则下是 any，这里显式收窄为用到的结构。
  const geometry = (first as unknown as { geometry: THREE.BufferGeometry }).geometry;
  const position = geometry.getAttribute('position') as unknown as { count: number };
  assert.ok(position.count % 4 === 0);
});

test('有官方模型包时启用 DataTexture、UV 与白像素 fallback', () => {
  const grid = createGrid(table);
  grid.set(0, 2, 0, parseState(table, 'stone'), 0, 0);
  grid.set(1, 2, 0, parseState(table, 'barrier'), 0, 0);
  const catalog = {
    mcVersion: '1.20.1',
    states: { stone: 1 },
    connections: {},
    defaults: { stone: 1 },
    coverage: { blocks: 1, states: 1, models: 1, textures: 1 },
  };
  const built = buildScene(grid, registry, 1_000_000, catalog);
  if (built.kind !== 'ok') throw new Error('构建失败');
  const face = { uv: [0, 0, 1, 1] as [number, number, number, number], tint: false, rotation: 0 as const };
  const pack = {
    models: [
      {
        boxes: [
          {
            from: [0, 0, 0] as [number, number, number],
            to: [16, 16, 16] as [number, number, number],
            faces: [face, face, face, face, face, face],
          },
        ],
      },
    ],
    atlas: { width: 2, height: 2, rgba: Uint8Array.from({ length: 16 }, (_v, i) => (i % 4 === 3 ? 255 : 200)) },
  };
  const scene = buildSceneFromBuffer(built.buffer, pack);
  assert.equal(scene.faceCount, 6);
  const mesh = scene.scene.children
    .filter((child): child is THREE.Mesh => child instanceof THREE.Mesh)
    .find((child) => {
      const material = child.material as THREE.MeshBasicMaterial;
      return material.map instanceof THREE.DataTexture;
    });
  assert.ok(mesh !== undefined);
  const material = mesh.material as THREE.MeshBasicMaterial;
  const map = material.map;
  assert.ok(map instanceof THREE.DataTexture);
  assert.equal(map.magFilter, THREE.NearestFilter);
  const geometry = mesh.geometry;
  assert.equal(geometry.hasAttribute('uv'), true);
});
