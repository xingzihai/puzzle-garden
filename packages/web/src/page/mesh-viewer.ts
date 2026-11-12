/**
 * 浏览器端入口（函数草模）：取 `/api/model`、建场景、绑定视角 / 剖切 / 拾取（MODELING-SPEC §4）。
 *
 * 负责：DOM 绑定、渲染循环、整体 / 俯视 / 侧视取景、剖切轴与位置、点击部件显示详情（含 source JSON 文本）。
 * 不负责：模型 JSON 窄化与几何（page/mesh-scene.ts）、相机位姿（page/controls.ts）、页面外壳（shell.ts）。
 *
 * 本文件离不开画布与 WebGL，由 `model-viewer.integration.test.ts` 覆盖，
 * 无同名单元测试（STANDARDS §8 例外，登记在 tools/check-tests.ts）。
 * 安全边界：只读 `/api/model`，不执行模型代码；source 一律经 `textContent` 展示，不拼 HTML。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { applyPose, overallPose, resizeView, sidePose, topPose, VIEW_FOV_DEG } from './controls.ts';
import {
  buildMeshScene,
  clipPlaneFor,
  clipValueRange,
  disposeMeshScene,
  modelBounds,
  parseModelDocument,
  partDetailEntries,
  setClipPlanes,
  sourceJson,
} from './mesh-scene.ts';
import type { ClipAxis, MeshScene, ViewerModel, ViewerPart } from './mesh-scene.ts';

const CAMERA_NEAR = 0.1;
/** 模型坐标绝对值上限 100000，远平面留足余量。 */
const CAMERA_FAR = 1_000_000;
const CLICK_SLOP_PX = 4;

interface PointerStart {
  readonly x: number;
  readonly y: number;
}

async function start(): Promise<void> {
  const viewport = byId('mesh-viewport');
  const clipAxisSelect = selectOf('mesh-clip-axis');
  const clipValueInput = inputOf('mesh-clip-value');
  const detailsBox = byId('mesh-selection-details');

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.localClippingEnabled = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  viewport.append(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(VIEW_FOV_DEG, 1, CAMERA_NEAR, CAMERA_FAR);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.screenSpacePanning = true;

  const model: ViewerModel = parseModelDocument(await fetchJson('/api/model'));
  const meshScene: MeshScene = buildMeshScene(model);
  const bounds = modelBounds(model);
  const raycaster = new THREE.Raycaster();
  let pointerStart: PointerStart | null = null;

  function clipAxis(): ClipAxis {
    const value = clipAxisSelect.value;
    if (value === 'none' || value === 'x' || value === 'y' || value === 'z') return value;
    throw new Error(`未知剖切轴：${value}`);
  }

  /** 按坐标跨度给剖切滑杆一个有限浮点 step：默认约 200 等分，取整到十的幂。 */
  function stepFor(span: number): number {
    if (!Number.isFinite(span) || span <= 0) return 1;
    const raw = span / 200;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = Math.round(raw / magnitude) * magnitude;
    return Number.isFinite(step) && step > 0 ? step : raw;
  }

  /** 同步剖切滑杆范围：min / max / step 全部为有限浮点；不剖切时禁用。 */
  function syncClipRange(): void {
    const axis = clipAxis();
    const range = clipValueRange(bounds, axis);
    clipValueInput.min = String(range[0]);
    clipValueInput.max = String(range[1]);
    clipValueInput.step = String(stepFor(range[1] - range[0]));
    clipValueInput.disabled = axis === 'none';
    if (axis !== 'none') {
      const clamped = Math.min(Math.max(Number(clipValueInput.value), range[0]), range[1]);
      clipValueInput.value = String(clamped);
    }
  }

  function applyClip(): void {
    const plane = clipPlaneFor(clipAxis(), Number(clipValueInput.value));
    setClipPlanes(meshScene, plane === null ? [] : [plane]);
  }

  function fitPose(kind: 'overall' | 'top' | 'side'): void {
    const aspect = camera.aspect;
    if (kind === 'overall') applyPose(camera, orbit, overallPose(bounds, aspect));
    else if (kind === 'top') applyPose(camera, orbit, topPose(bounds, aspect));
    else applyPose(camera, orbit, sidePose(bounds, aspect));
  }

  function pick(event: PointerEvent): void {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...meshScene.partById.values()], false);
    const first = hits.find((hit) => hit.object.visible);
    if (first === undefined) {
      detailsBox.replaceChildren(placeholder());
      return;
    }
    const part = model.parts.find((entry) => entry.id === first.object.name);
    if (part === undefined) return;
    detailsBox.replaceChildren(detailsFor(part));
  }

  clipAxisSelect.addEventListener('change', () => {
    syncClipRange();
    applyClip();
  });
  clipValueInput.addEventListener('input', applyClip);
  buttonOf('mesh-view-overall').addEventListener('click', () => {
    fitPose('overall');
  });
  buttonOf('mesh-view-top').addEventListener('click', () => {
    fitPose('top');
  });
  buttonOf('mesh-view-side').addEventListener('click', () => {
    fitPose('side');
  });

  renderer.domElement.addEventListener('pointerdown', (event) => {
    pointerStart = { x: event.clientX, y: event.clientY };
  });
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (pointerStart === null) return;
    const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
    pointerStart = null;
    if (moved <= CLICK_SLOP_PX) pick(event);
  });

  const observer = new ResizeObserver(() => {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (width > 0 && height > 0) resizeView(renderer, camera, width, height);
  });
  observer.observe(viewport);
  resizeView(renderer, camera, Math.max(viewport.clientWidth, 1), Math.max(viewport.clientHeight, 1));
  syncClipRange();
  fitPose('overall');

  let frames = 0;
  function animate(): void {
    requestAnimationFrame(animate);
    orbit.update();
    renderer.render(meshScene.scene, camera);
    // 首帧渲染后置就绪标记，供截图通道判定页面已可用（只读标记，不暴露任何模型接口）。
    if (frames === 0) {
      frames = 1;
      (globalThis as unknown as { pgModelReady?: boolean }).pgModelReady = true;
    }
  }
  requestAnimationFrame(animate);

  window.addEventListener('beforeunload', () => {
    disposeMeshScene(meshScene);
  });
}

/** 读取 `/api/model` 并返回未知 JSON；HTTP 失败抛可读错误。 */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`请求 ${url} 失败：HTTP ${String(response.status)}`);
  const data: unknown = await response.json();
  return data;
}

/** 选中面板：字段表 + 可展开的 source JSON（textContent，不注入 HTML）。 */
function detailsFor(part: ViewerPart): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(keyValueList(partDetailEntries(part)));
  const details = document.createElement('details');
  details.className = 'source';
  const summary = document.createElement('summary');
  summary.textContent = 'source 参数（JSON）';
  const pre = document.createElement('pre');
  pre.textContent = sourceJson(part);
  details.append(summary, pre);
  fragment.append(details);
  return fragment;
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`页面缺少 #${id}`);
  return element;
}

function inputOf(id: string): HTMLInputElement {
  const element = byId(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} 必须是 input`);
  return element;
}

function selectOf(id: string): HTMLSelectElement {
  const element = byId(id);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`#${id} 必须是 select`);
  return element;
}

function buttonOf(id: string): HTMLButtonElement {
  const element = byId(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} 必须是 button`);
  return element;
}

function keyValueList(entries: readonly (readonly [string, string])[]): HTMLDListElement {
  const list = document.createElement('dl');
  list.className = 'kv';
  for (const [term, value] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  return list;
}

function placeholder(): HTMLParagraphElement {
  const element = document.createElement('p');
  element.className = 'hint';
  element.textContent = '在三维视图中点击部件，查看名称、用途、尺寸与 source 参数。';
  return element;
}

function setStatus(statusBox: HTMLElement, text: string, isError: boolean): void {
  statusBox.textContent = text;
  statusBox.className = text === '' ? '' : isError ? 'error' : '';
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const statusBox = document.getElementById('mesh-status');
  if (statusBox !== null) setStatus(statusBox, message, true);
});
