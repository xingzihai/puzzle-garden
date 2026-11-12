/**
 * 浏览器端入口：取数据、建场景、绑定控件、射线选择与面板更新（MASSING-SPEC §3）。
 *
 * 负责：DOM 绑定、渲染循环、版本/楼层/地表/空间/剖切/高亮控件的编排，以及检查报告与差异的展示。
 * 不负责：几何与响应校验（page/scene.ts）、相机位姿（page/controls.ts）、页面外壳（shell.ts）。
 *
 * 本文件离不开画布与 WebGL，由浏览器集成测试覆盖，无同名单元测试（STANDARDS §8 例外，登记在 tools/check-tests.ts）。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { BlueprintDiff } from '@pg/design/diff';
import type { Bounds, Element, Level, Space } from '@pg/design/schema';

import { applyPose, overallPose, resizeView, topPose, VIEW_FOV_DEG } from './controls.ts';
import {
  applyCurvature,
  blueprintsUrl,
  curvatureEditable,
  curveInfoText,
  defaultVariant,
  exampleIdOf,
  levelOptions,
  localDiffOf,
  reportUrl,
  variantsOf,
  viewDefaults,
} from './example-controls.ts';
import type { ExampleId } from './example-controls.ts';
import { parseReportPayload } from './report-parser.ts';
import type { ViewerReport } from './report-parser.ts';
import {
  applyLevelDisplay,
  blueprintBounds,
  buildMassingScene,
  clipPlaneFor,
  clipValueRange,
  elementGeometry,
  elementSize,
  firstSelectable,
  highlightedIds,
  levelDisplay,
  parseBlueprints,
  setHighlighted,
  visibleBounds,
} from './scene.ts';
import type { ClipAxis, LevelDisplay, MassingScene, ViewerBlueprint, VisibilityOptions } from './scene.ts';

const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 5000;
const CLICK_SLOP_PX = 4;

interface PointerStart {
  readonly x: number;
  readonly y: number;
}

async function start(): Promise<void> {
  const viewport = byId('viewport');
  const exampleSelect = selectOf('example');
  const variantSelect = selectOf('variant');
  const levelSelect = selectOf('level');
  const surfaceToggle = inputOf('surface');
  const spacesToggle = inputOf('spaces');
  const clipAxisSelect = selectOf('clip-axis');
  const clipValueInput = inputOf('clip-value');
  const curvatureInput = inputOf('curvature');
  const curvePanel = byId('curve-panel');
  const curveInfo = byId('curve-info');
  const changesToggle = inputOf('changes');
  const notesList = byId('notes');
  const detailsBox = byId('selection-details');
  const reportBox = byId('report');
  const changesBox = byId('changes-summary');
  const statusBox = byId('status');

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.localClippingEnabled = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  viewport.append(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(VIEW_FOV_DEG, 1, CAMERA_NEAR, CAMERA_FAR);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.screenSpacePanning = true;

  const blueprintsForExample = (exampleId: ExampleId): Promise<unknown> => fetchJson(blueprintsUrl(exampleId));
  let example: ExampleId = exampleIdOf(exampleSelect.value);
  let blueprints = parseBlueprints(await blueprintsForExample(example));
  if (blueprints.length === 0) throw new Error(`接口 ${blueprintsUrl(example)} 未返回任何方案`);

  // 函数内可变状态：闭包共享，避免模块级可变全局。
  let massing: MassingScene | null = null;
  let active: ViewerBlueprint | null = null;
  let report: ViewerReport | null = null;
  let bounds: Bounds = { min: [0, 0, 0], max: [1, 1, 1] };
  let display: LevelDisplay = {
    range: { floor: Number.NEGATIVE_INFINITY, top: Number.POSITIVE_INFINITY },
    planFloor: null,
    excludeTopSlab: false,
    includeSurface: true,
  };
  let axisPlane: THREE.Plane | null = null;
  let pointerStart: PointerStart | null = null;
  /** 本地曲率预览的差异；null 表示显示服务端预置差异。 */
  let localDiff: BlueprintDiff | null = null;

  const raycaster = new THREE.Raycaster();

  function clipAxis(): ClipAxis {
    const value = clipAxisSelect.value;
    if (value === 'none' || value === 'x' || value === 'y' || value === 'z') return value;
    throw new Error(`未知剖切轴：${value}`);
  }

  function visibilityOptions(): VisibilityOptions {
    return { level: levelSelect.value, showSurface: surfaceToggle.checked };
  }

  /** 按当前楼层 / 地表开关重建显示范围与剖切：楼层上下裁剪与用户轴向剖切同时生效。 */
  function applyDisplay(): void {
    if (massing === null || active === null) return;
    display = levelDisplay(active.levels, visibilityOptions(), bounds.max[1]);
    applyLevelDisplay(massing, active, display, axisPlane);
  }

  function applyClip(): void {
    axisPlane = clipPlaneFor(clipAxis(), Number(clipValueInput.value));
    applyDisplay();
  }

  /** 只对当前可见集合取景；用于整体 / 俯视按钮和首次加载，不在开关变化时自动调用。 */
  function fitPose(top: boolean): void {
    if (active === null) return;
    const view = visibleBounds(active, display, spacesToggle.checked);
    applyPose(camera, orbit, top ? topPose(view, camera.aspect) : overallPose(view, camera.aspect));
  }

  function applySpaces(): void {
    if (massing !== null) massing.spaceGroup.visible = spacesToggle.checked;
  }

  /** 当前显示的差异：本地预览时用浏览器内实时计算的差异，避免与服务端预置结果不对应。 */
  function activeDiff(): BlueprintDiff {
    if (localDiff !== null) return localDiff;
    if (report !== null) return report.diff;
    return { added: [], removed: [], changed: [], spacesChanged: [] };
  }

  function applyHighlight(): void {
    if (massing === null) return;
    setHighlighted(massing, highlightedIds(activeDiff(), changesToggle.checked));
  }

  /** 按样例重建版本下拉：plaza 三版 / roof 三版 profile。 */
  function rebuildVariantOptions(exampleId: ExampleId): void {
    const options = variantsOf(exampleId).map((entry) => {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      return option;
    });
    variantSelect.replaceChildren(...options);
    variantSelect.value = defaultVariant(exampleId);
  }

  /** 按当前蓝图的实际楼层重建楼层下拉，尽量保留原选择；没有对应楼层时回到 all。 */
  function rebuildLevelOptions(exampleId: ExampleId, levels: readonly Level[]): void {
    const previous = levelSelect.value;
    const options = levelOptions(exampleId, levels).map((entry) => {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      return option;
    });
    levelSelect.replaceChildren(...options);
    const known = new Set(options.map((option) => option.value));
    levelSelect.value = known.has(previous) ? previous : 'all';
  }

  /** 切换样例时的默认视图；roof 必须勾选地表，否则地上模型会被楼层规则隐藏。 */
  function applyExampleDefaults(exampleId: ExampleId): void {
    const defaults = viewDefaults(exampleId);
    levelSelect.value = defaults.level;
    surfaceToggle.checked = defaults.showSurface;
    spacesToggle.checked = defaults.spaces;
  }

  function latheElementOf(blueprint: ViewerBlueprint): Element | undefined {
    return blueprint.elements.find((element) => element.shape === 'lathe');
  }

  /** 同步曲率面板：非 roof 隐藏；roof 用当前元素的实际 profile 重置滑杆与文案（切版本即重置本地预览）。 */
  function syncCurvePanel(exampleId: ExampleId, blueprint: ViewerBlueprint): void {
    const roof = curvatureEditable(exampleId) ? latheElementOf(blueprint) : undefined;
    if (roof?.profile === undefined) {
      curvePanel.hidden = true;
      curveInfo.textContent = '';
      return;
    }
    curvePanel.hidden = false;
    curvatureInput.value = String(roof.profile.curvature);
    curveInfo.textContent = curveInfoText(roof);
  }

  /** 曲率滑杆输入：只改浏览器内当前屋面的 profile 并重建网格，不发起任何 HTTP 写。 */
  function applyCurvaturePreview(curvature: number): void {
    if (!curvatureEditable(example) || active === null) return;
    const roof = latheElementOf(active);
    if (roof?.profile === undefined) return;
    const nextRoof: Element = { ...roof, profile: applyCurvature(roof.profile, curvature) };
    const nextActive: ViewerBlueprint = {
      ...active,
      elements: active.elements.map((element) => (element.id === roof.id ? nextRoof : element)),
    };
    if (massing !== null) {
      const mesh = massing.elementById.get(roof.id);
      if (mesh !== undefined) {
        mesh.geometry.dispose();
        mesh.geometry = elementGeometry(nextRoof);
      }
    }
    active = nextActive;
    localDiff = localDiffOf(blueprints[0] ?? nextActive, nextActive);
    curveInfo.textContent = `${curveInfoText(nextRoof)} ｜ 本地参数预览未保存`;
    detailsBox.replaceChildren(keyValueList(elementDetailEntries(nextRoof, nextActive)));
    applyDisplay();
    applyHighlight();
    renderChanges(changesBox, activeDiff(), true);
  }

  function syncClipRange(): void {
    const axis = clipAxis();
    const range = clipValueRange(bounds, axis);
    clipValueInput.min = String(range[0]);
    clipValueInput.max = String(range[1]);
    clipValueInput.step = '1';
    clipValueInput.disabled = axis === 'none';
    if (axis !== 'none') {
      const clamped = Math.min(Math.max(Number(clipValueInput.value), range[0]), range[1]);
      clipValueInput.value = String(clamped);
    }
  }

  /** 点击命中的对象名既可能是空间体量（sp-*）也可能是体量元素（ms-*），分别给详情。 */
  function selectByName(name: string): void {
    if (active === null) return;
    const space = active.spaces.find((entry) => entry.id === name);
    if (space !== undefined) {
      detailsBox.replaceChildren(keyValueList(spaceDetailEntries(space, active)));
      return;
    }
    const element = active.elements.find((entry) => entry.id === name);
    if (element !== undefined) detailsBox.replaceChildren(keyValueList(elementDetailEntries(element, active)));
  }

  function pick(event: PointerEvent): void {
    if (massing === null) return;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const selectableSpaces = massing.spaceGroup.visible ? [...massing.spaceById.values()] : [];
    const hits = raycaster.intersectObjects([...massing.elementById.values(), ...selectableSpaces], false);
    // 射线几何不感知可见性与材质剖切：跳过隐藏网格与落在该网格实际剖切面外侧的点。
    const first = firstSelectable(hits, (object) => object.visible, materialPlanes(massing));
    if (first === null) {
      detailsBox.replaceChildren(placeholder());
      return;
    }
    selectByName(first.object.name);
  }

  async function loadVariant(variant: string, fitCamera: boolean): Promise<void> {
    const blueprint = variantBlueprint(blueprints, example, variant);
    const payload = parseReportPayload(await fetchJson(reportUrl(example, variant)));
    if (massing !== null) disposeMassing(massing);
    active = blueprint;
    report = payload;
    localDiff = null;
    bounds = blueprintBounds(blueprint);
    massing = buildMassingScene(blueprint);
    detailsBox.replaceChildren(placeholder());
    syncClipRange();
    rebuildLevelOptions(example, blueprint.levels);
    syncCurvePanel(example, blueprint);
    applySpaces();
    applyClip();
    applyHighlight();
    renderReport(reportBox, statusBox, payload);
    renderChanges(changesBox, payload.diff, false);
    renderNotes(notesList, blueprint);
    // 只有首次加载按可见集合取景；切换版本等控件不重置用户视角。
    if (fitCamera) fitPose(false);
  }

  /** 切换样例：先设默认视图（roof 勾地表、看全部），再取该样例的方案并取景，避免地上模型被隐藏。 */
  async function switchExample(raw: string): Promise<void> {
    example = exampleIdOf(raw);
    applyExampleDefaults(example);
    blueprints = parseBlueprints(await blueprintsForExample(example));
    if (blueprints.length === 0) throw new Error(`接口 ${blueprintsUrl(example)} 未返回任何方案`);
    rebuildVariantOptions(example);
    await loadVariant(defaultVariant(example), true);
  }

  function handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(statusBox, message, true);
  }

  exampleSelect.addEventListener('change', () => {
    void switchExample(exampleSelect.value).catch(handleError);
  });
  variantSelect.addEventListener('change', () => {
    void loadVariant(variantSelect.value, false).catch(handleError);
  });
  curvatureInput.addEventListener('input', () => {
    applyCurvaturePreview(Number(curvatureInput.value));
  });
  levelSelect.addEventListener('change', applyDisplay);
  surfaceToggle.addEventListener('change', applyDisplay);
  spacesToggle.addEventListener('change', applySpaces);
  changesToggle.addEventListener('change', applyHighlight);
  clipAxisSelect.addEventListener('change', () => {
    syncClipRange();
    applyClip();
  });
  clipValueInput.addEventListener('input', applyClip);
  buttonOf('view-overall').addEventListener('click', () => {
    fitPose(false);
  });
  buttonOf('view-top').addEventListener('click', () => {
    fitPose(true);
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

  applyExampleDefaults(example);
  rebuildVariantOptions(example);
  await loadVariant(defaultVariant(example), true);

  function animate(): void {
    requestAnimationFrame(animate);
    orbit.update();
    if (massing !== null) renderer.render(massing.scene, camera);
  }
  requestAnimationFrame(animate);
}

/** 版本名 → 接口返回的方案；数组顺序与 `variantsOf(example)` 一致。 */
function variantBlueprint(
  blueprints: readonly ViewerBlueprint[],
  example: ExampleId,
  variant: string,
): ViewerBlueprint {
  const index = variantsOf(example).findIndex((entry) => entry.id === variant);
  if (index < 0) throw new Error(`未知版本：${variant}`);
  const blueprint = blueprints[index];
  if (blueprint === undefined) throw new Error(`接口只返回 ${String(blueprints.length)} 份方案，缺少 ${variant}`);
  return blueprint;
}

const ROLE_LABELS: Readonly<Record<Space['role'], string>> = {
  room: '房间',
  circulation: '交通',
  void: '挑空',
};

function levelLabel(blueprint: ViewerBlueprint, levelId: string): string {
  const level = blueprint.levels.find((entry) => entry.id === levelId);
  return level === undefined ? levelId : `${level.name}（标高 ${String(level.elevation)}）`;
}

function sizeLabel(size: readonly [number, number, number]): string {
  return `${String(size[0])} × ${String(size[1])} × ${String(size[2])}`;
}

/** 选中体量元素的说明字段：名称、编号、类别、形体、楼层与标高、尺寸、所属空间；lathe 另列 profile 参数。 */
function elementDetailEntries(element: Element, blueprint: ViewerBlueprint): readonly (readonly [string, string])[] {
  const space =
    element.spaceId === undefined ? undefined : blueprint.spaces.find((entry) => entry.id === element.spaceId);
  const entries: (readonly [string, string])[] = [
    ['名称', element.name],
    ['编号', element.id],
    ['类别', element.kind],
    ['形体', element.shape],
    ['楼层', levelLabel(blueprint, element.level)],
    ['底部标高', `y=${String(element.bounds.min[1])}`],
    ['尺寸', sizeLabel(elementSize(element))],
    ['空间', space === undefined ? '未归属' : `${space.name}（${space.id}）`],
  ];
  if (element.shape === 'lathe' && element.profile !== undefined) {
    entries.push(['母线', element.profile.kind]);
    entries.push(['曲率 k', String(element.profile.curvature)]);
    entries.push(['采样', `${String(element.profile.heightSegments)}×${String(element.profile.radialSegments)}`]);
  }
  return entries;
}

/** 选中空间的说明字段：名称、编号、用途（房间 / 交通 / 挑空）、楼层、尺寸与层高。 */
function spaceDetailEntries(space: Space, blueprint: ViewerBlueprint): readonly (readonly [string, string])[] {
  const size: readonly [number, number, number] = [
    space.bounds.max[0] - space.bounds.min[0],
    space.bounds.max[1] - space.bounds.min[1],
    space.bounds.max[2] - space.bounds.min[2],
  ];
  return [
    ['名称', space.name],
    ['编号', space.id],
    ['用途', ROLE_LABELS[space.role]],
    ['楼层', levelLabel(blueprint, space.level)],
    ['尺寸', sizeLabel(size)],
    ['层高', `${String(size[1])}（${String(space.bounds.min[1])} → ${String(space.bounds.max[1])}）`],
  ];
}

function renderReport(reportBox: HTMLElement, statusBox: HTMLElement, payload: ViewerReport): void {
  const { report, review, checkedRoutes } = payload;
  if (review !== null) {
    // 概念评审：空净空报告不是“绿色通过”，不显示 0/0 统计。
    reportBox.replaceChildren(paragraph(review.message), paragraph('仅用于讨论布局和层间连接，未进行施工检查。'));
    setStatus(statusBox, '', false);
    return;
  }
  const state = report.status === 'pass' ? '检查未发现问题' : `发现 ${String(report.issues.length)} 项问题`;
  const nodes: Node[] = [
    paragraph(`状态：${state}`, report.status === 'pass' ? 'status-pass' : 'status-issues'),
    paragraph(
      `本报告覆盖 ${String(report.checkedClearances)} 处显式净空，${String(checkedRoutes)} 条代表路线；` +
        '通过仅代表这些检查未发现问题，不代表所有通路、结构或实体能力通过。',
    ),
  ];
  if (report.issues.length > 0) {
    const list = document.createElement('ul');
    list.className = 'issues';
    for (const issue of report.issues) list.append(listItem(issue.message));
    nodes.push(list);
  }
  reportBox.replaceChildren(...nodes);
  setStatus(statusBox, '', false);
}

function renderChanges(changesBox: HTMLElement, diff: BlueprintDiff, local: boolean): void {
  const detail = local
    ? '本地参数预览未保存：以上差异按浏览器内当前参数实时计算，与服务器预置差异无关；切换版本会重置。'
    : '相对 base 版本；高亮只标记新增与修改的元素，删除的元素不在当前版本中显示。';
  changesBox.replaceChildren(
    paragraph(
      `新增 ${String(diff.added.length)}、修改 ${String(diff.changed.length)}、删除 ${String(diff.removed.length)}、空间变化 ${String(diff.spacesChanged.length)}。`,
    ),
    paragraph(detail),
  );
}

function renderNotes(notesList: HTMLElement, blueprint: ViewerBlueprint): void {
  notesList.replaceChildren(...blueprint.notes.map((note) => listItem(note)));
}

function planesOfMesh(mesh: THREE.Mesh): readonly THREE.Plane[] {
  const material = mesh.material;
  const materials = Array.isArray(material) ? material : [material];
  const planes: THREE.Plane[] = [];
  for (const entry of materials) {
    const clipped = entry.clippingPlanes;
    if (Array.isArray(clipped)) planes.push(...clipped);
  }
  return planes;
}

/**
 * 按对象名回查体量或空间网格，读它材质上的实际剖切面（与渲染完全一致，含本层楼板下边界豁免）。
 * 经 `elementById` / `spaceById` 拿到的是具体 `THREE.Mesh` 类型；直接对 Object3D 做 instanceof 收窄会丢成 any。
 */
function materialPlanes(massing: MassingScene): (object: THREE.Object3D) => readonly THREE.Plane[] {
  return (object) => {
    const mesh = massing.elementById.get(object.name) ?? massing.spaceById.get(object.name);
    return mesh === undefined ? [] : planesOfMesh(mesh);
  };
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) for (const entry of material) entry.dispose();
  else material.dispose();
}

/** 释放旧草模的几何与材质，避免反复切换版本泄漏 GPU 资源。 */
function disposeMassing(massing: MassingScene): void {
  for (const mesh of massing.elementById.values()) {
    mesh.geometry.dispose();
    disposeMaterial(mesh.material);
  }
  for (const solid of massing.spaceById.values()) {
    solid.geometry.dispose();
    disposeMaterial(solid.material);
  }
  for (const lines of massing.spaceLines) {
    lines.geometry.dispose();
    disposeMaterial(lines.material);
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`请求 ${url} 失败：HTTP ${String(response.status)}`);
  const data: unknown = await response.json();
  return data;
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

function paragraph(text: string, className?: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.textContent = text;
  if (className !== undefined) element.className = className;
  return element;
}

function listItem(text: string): HTMLLIElement {
  const item = document.createElement('li');
  item.textContent = text;
  return item;
}

function placeholder(): HTMLParagraphElement {
  const element = paragraph('在三维视图中点击空间或体量，查看名称、用途、尺寸与层高。');
  element.className = 'hint';
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

function setStatus(statusBox: HTMLElement, text: string, isError: boolean): void {
  statusBox.textContent = text;
  statusBox.className = text === '' ? '' : isError ? 'error' : '';
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const statusBox = document.getElementById('status');
  if (statusBox !== null) setStatus(statusBox, message, true);
});
