/**
 * 浏览器端：紧凑格表 → three 场景（RENDER-SPEC §6–§8）。
 *
 * 负责：解析格表、调 mesh.ts 生成面缓冲、建不透明 / 半透明网格、描边与地面。
 * 不负责：画布与渲染循环（page/main.ts）、DOM。不碰 DOM，所以在 Node 里可测。
 */

import * as THREE from 'three';

import { meshScene, parseScene } from '../mesh.ts';
import type { FaceGroup, MeshModelPack } from '../mesh.ts';

const BACKGROUND = 0xe8edf2;
const GROUND_COLOR = 0xc9c3b5;
const GROUND_MARGIN = 4;
const EDGE_COLOR = 0x000000;
const EDGE_OPACITY = 0.18;
const TRANSPARENT_OPACITY = 0.45;
const TEXTURED_TRANSPARENT_OPACITY = 0.92;

export interface BuiltScene {
  readonly scene: THREE.Scene;
  readonly faceCount: number;
}

function byteColor(hex: number): THREE.Color {
  return new THREE.Color(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);
}

function packTexture(pack: MeshModelPack): THREE.DataTexture {
  const texture = new THREE.DataTexture(pack.atlas.rgba, pack.atlas.width, pack.atlas.height, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function geometryOf(group: FaceGroup): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(group.positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(group.colors, 3, true));
  geometry.setAttribute('uv', new THREE.BufferAttribute(group.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(group.indices, 1));
  return geometry;
}

function addGround(scene: THREE.Scene, minX: number, minZ: number, sx: number, sz: number): void {
  const width = sx + GROUND_MARGIN * 2;
  const depth = sz + GROUND_MARGIN * 2;
  const geometry = new THREE.PlaneGeometry(width, depth);
  const material = new THREE.MeshBasicMaterial({ color: byteColor(GROUND_COLOR) });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(minX + sx / 2, 1, minZ + sz / 2);
  scene.add(mesh);
}

/** 从紧凑格表建立完整场景：背景、地面、不透明网格（含描边）、半透明网格。 */
export function buildSceneFromBuffer(buffer: Uint8Array, pack?: MeshModelPack): BuiltScene {
  const parsed = parseScene(buffer);
  const mesh = meshScene(parsed, pack);
  const scene = new THREE.Scene();
  scene.background = byteColor(BACKGROUND);
  addGround(scene, parsed.origin[0], parsed.origin[2], parsed.size[0], parsed.size[2]);
  const texture = pack === undefined ? undefined : packTexture(pack);

  if (mesh.opaque.indices.length > 0) {
    const geometry = geometryOf(mesh.opaque);
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      ...(texture === undefined ? {} : { map: texture, alphaTest: 0.01 }),
    });
    scene.add(new THREE.Mesh(geometry, material));
    const edges = new THREE.EdgesGeometry(geometry, 1);
    scene.add(
      new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: byteColor(EDGE_COLOR), transparent: true, opacity: EDGE_OPACITY }),
      ),
    );
  }
  if (mesh.transparent.indices.length > 0) {
    const geometry = geometryOf(mesh.transparent);
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: texture === undefined ? TRANSPARENT_OPACITY : TEXTURED_TRANSPARENT_OPACITY,
      depthWrite: false,
      ...(texture === undefined ? {} : { map: texture, alphaTest: 0.01 }),
    });
    const translucent = new THREE.Mesh(geometry, material);
    translucent.renderOrder = 1;
    scene.add(translucent);
  }
  return { scene, faceCount: mesh.faces };
}
