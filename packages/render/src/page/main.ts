/**
 * 浏览器端入口（RENDER-SPEC §4.4）：画布、WebGLRenderer、逐视角渲染。
 *
 * 负责：暴露 window.pgReady / pgInit / pgLoad / pgView；按宿主给的相机参数照抄渲染。
 * 不负责：取景计算（camera.ts）、场景构建（scene.ts）。本文件由集成测试覆盖，无同名单元测试。
 */

import * as THREE from 'three';

import { decodeModelPack } from '../model-pack.ts';
import type { RenderModelPack } from '../model-pack.ts';
import { buildSceneFromBuffer } from './scene.ts';

THREE.ColorManagement.enabled = false;

interface PgClipPlane {
  readonly normal: [number, number, number];
  readonly constant: number;
}

interface PgCameraSpec {
  readonly position: [number, number, number];
  readonly target: [number, number, number];
  readonly up: [number, number, number];
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly near: number;
  readonly far: number;
  /** cutaway 等诊断视角的全局裁剪面；缺省或空数组表示不裁剪。 */
  readonly clippingPlanes?: readonly PgClipPlane[];
}

interface PgWindow {
  pgReady?: boolean;
  pgInit?: (width: number, height: number) => { webglRenderer: string; three: string };
  pgLoad?: () => Promise<number>;
  pgView?: (spec: PgCameraSpec) => string;
}

interface PgState {
  renderer?: THREE.WebGLRenderer;
  scene?: THREE.Scene;
  canvas?: HTMLCanvasElement;
}

const state: PgState = {};

function canvasOf(): HTMLCanvasElement {
  if (state.canvas !== undefined) return state.canvas;
  const created = document.createElement('canvas');
  document.body.append(created);
  state.canvas = created;
  return created;
}

function pgInit(width: number, height: number): { webglRenderer: string; three: string } {
  const renderer = new THREE.WebGLRenderer({
    canvas: canvasOf(),
    alpha: false,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  state.renderer = renderer;
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info === null ? '' : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  return { webglRenderer: name, three: THREE.REVISION };
}

async function pgLoad(): Promise<number> {
  const [sceneResponse, packResponse] = await Promise.all([fetch('/scene.bin'), fetch('/model-pack.bin')]);
  const buffer = new Uint8Array(await sceneResponse.arrayBuffer());
  const packBytes = new Uint8Array(await packResponse.arrayBuffer());
  let pack: RenderModelPack | undefined;
  if (packBytes.byteLength > 0) pack = decodeModelPack(packBytes);
  const built = buildSceneFromBuffer(buffer, pack);
  state.scene = built.scene;
  return built.faceCount;
}

function pgView(spec: PgCameraSpec): string {
  const { renderer, scene, canvas } = state;
  if (renderer === undefined || scene === undefined || canvas === undefined) {
    throw new Error('pgView 必须在 pgInit / pgLoad 之后调用');
  }
  const camera = new THREE.OrthographicCamera(spec.left, spec.right, spec.top, spec.bottom, spec.near, spec.far);
  camera.position.set(spec.position[0], spec.position[1], spec.position[2]);
  camera.up.set(spec.up[0], spec.up[1], spec.up[2]);
  camera.lookAt(new THREE.Vector3(spec.target[0], spec.target[1], spec.target[2]));
  camera.updateProjectionMatrix();
  // 宿主给的裁剪面是世界坐标；每个视角重置，避免上一张图的裁剪面泄漏到下一张。
  renderer.clippingPlanes =
    spec.clippingPlanes?.map(
      (plane) => new THREE.Plane(new THREE.Vector3(plane.normal[0], plane.normal[1], plane.normal[2]), plane.constant),
    ) ?? [];
  renderer.render(scene, camera);
  return canvas.toDataURL('image/png');
}

// window 上的 pg* 是宿主与页面之间的协议；这里的断言安全：只有本文件写这些属性。
const pgWindow = window as unknown as PgWindow;
pgWindow.pgInit = pgInit;
pgWindow.pgLoad = pgLoad;
pgWindow.pgView = pgView;
pgWindow.pgReady = true;
