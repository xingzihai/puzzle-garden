/**
 * BuildSheet 施工调用卡：把合同里的绝对半开 bounds 换成本任务可直接抄的 world API 调用。
 *
 * 负责：只从 BuildSheet 投影对象派生 slab / wall / opening / roof 的精确 `rect`、`at` / `sill`、
 *   `peakY` / `eaveY` / `overhang`、期望 bounds 与可预检的断言代码。
 * 不负责：家具 / 细部 / 室内，也不判断合同是否合理；调用卡与投影冲突时只报告 note，不改数字。
 *
 * 坐标口径：BuildSheet bounds 是半开 `[min, max)`；`rect` 的 x1 / z1 是最后一格（闭区间）。
 * `floorPlate.y` / `walls.y` 都是构件底部 y；`opening.width / height` 是净尺寸（不含 frame）。
 * 洞口 `at` 是相对立面中点的整数格偏移，`sill` 相对墙底 / 站立面；屋面的 `rect` 是墙顶承托轮廓，不是含挑檐的包络。
 */

import type { BuildSpec } from '@pg/interaction/schema';

import type { BuildSheetContent, BuildSheetObject } from './build-sheet.ts';

export type ConstructionCallKind = 'slab' | 'wall' | 'opening' | 'roof';

export interface ConstructionCallBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** `rect(x0, z0, x1, z1)` 的闭区间 footprint；x1 / z1 是最后一格。 */
export interface ConstructionCallRect {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

export interface ConstructionCallCard {
  readonly id: string;
  readonly kind: ConstructionCallKind;
  /** 代码块里的变量名；同一次派生内保证唯一。 */
  readonly variable: string;
  /** 调用使用的闭区间 footprint；opening 卡片这里是结果洞口，roof 卡片这里是墙顶承托轮廓。 */
  readonly rect: ConstructionCallRect;
  /** 精确 world 调用；null 表示当前 BuildSpec 形式没有安全的对应调用（见 note）。 */
  readonly call: string | null;
  /** 表格用的紧凑参数摘要（不含 `w.` 调用壳）。 */
  readonly params: string;
  /** BuildSheet 的半开期望 bounds；断言时句柄 max + 1 应等于这里的 max。 */
  readonly expectedBounds: ConstructionCallBounds;
  /** opening 卡：合同净宽 / 净高（即 width / height，不含 frame）；其他卡为 undefined。 */
  readonly netSize?: { readonly width: number; readonly height: number };
  readonly note: string | null;
}

const ROOF_KINDS: Readonly<Record<string, 'gable' | 'hip' | 'pyramid' | 'shed' | 'flat'>> = {
  gable: 'gable',
  hip: 'hip',
  pyramid: 'pyramid',
  shed: 'shed',
  flat: 'flat',
};

function tsString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function rectOf(bounds: ConstructionCallBounds): ConstructionCallRect {
  return {
    x0: bounds.min[0],
    z0: bounds.min[2],
    x1: bounds.max[0] - 1,
    z1: bounds.max[2] - 1,
  };
}

function rectText(rect: ConstructionCallRect): string {
  return `rect(${String(rect.x0)}, ${String(rect.z0)}, ${String(rect.x1)}, ${String(rect.z1)})`;
}

function boundsText(bounds: ConstructionCallBounds): string {
  return `[${bounds.min.join(',')}]..[${bounds.max.join(',')})`;
}

function codeBounds(bounds: ConstructionCallBounds): string {
  return `{ min: [${bounds.min.join(', ')}], max: [${bounds.max.join(', ')}] }`;
}

function compareById(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function identifierOf(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `obj_${cleaned}`;
}

function uniqueName(used: Set<string>, id: string): string {
  const base = identifierOf(id);
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    name = `${base}_${String(suffix)}`;
    suffix += 1;
  }
  used.add(name);
  return name;
}

function joinNotes(notes: readonly string[]): string | null {
  return notes.length === 0 ? null : notes.join(' ');
}

function slabCard(object: Extract<BuildSheetObject, { kind: 'slab' }>, used: Set<string>): ConstructionCallCard {
  const rect = rectOf(object.bounds);
  const y = object.bounds.min[1];
  const thickness = object.bounds.max[1] - y;
  const material = object.materialBlock;
  const notes: string[] = [];
  if (thickness <= 0) notes.push(`slab 厚度 ${String(thickness)} 不是正数。`);
  if (material === '—') notes.push('BuildSheet 没有解析出楼板材质。');
  return {
    id: object.id,
    kind: 'slab',
    variable: uniqueName(used, object.id),
    rect,
    call:
      material === '—'
        ? null
        : `w.floorPlate({ footprint: ${rectText(rect)}, y: ${String(y)}, thickness: ${String(thickness)}, material: ${tsString(material)} })`,
    params: `y=${String(y)} · thickness=${String(thickness)} · material=${material}`,
    expectedBounds: object.bounds,
    note: joinNotes(notes),
  };
}

function wallCard(object: Extract<BuildSheetObject, { kind: 'wall' }>, used: Set<string>): ConstructionCallCard {
  const rect = rectOf(object.bounds);
  const y = object.bounds.min[1];
  const height = object.bounds.max[1] - y;
  const material = object.materialBlock;
  const notes: string[] = [];
  if (height <= 0) notes.push(`wall 高度 ${String(height)} 不是正数。`);
  if (material === '—') notes.push('BuildSheet 没有解析出墙体材质。');
  return {
    id: object.id,
    kind: 'wall',
    variable: uniqueName(used, object.id),
    rect,
    call:
      material === '—'
        ? null
        : `w.walls({ footprint: ${rectText(rect)}, y: ${String(y)}, height: ${String(height)}, thickness: 1, material: ${tsString(material)} })`,
    params: `y=${String(y)} · height=${String(height)} · thickness=1 · material=${material}`,
    expectedBounds: object.bounds,
    note: joinNotes(notes),
  };
}

function openingKind(spec: BuildSpec, id: string): 'door' | 'window' | 'gate' {
  const opening = spec.openings.find((candidate) => `opening:${candidate.id}` === id);
  if (opening?.kind === 'window') return 'window';
  if (opening?.kind === 'gate') return 'gate';
  return 'door';
}

function openingCard(
  spec: BuildSpec,
  hostBounds: ConstructionCallBounds,
  object: Extract<BuildSheetObject, { kind: 'opening' }>,
  wall: ConstructionCallCard | undefined,
  wallIssue: string | null,
  used: Set<string>,
): ConstructionCallCard {
  const rect = rectOf(object.bounds);
  const horizontal = object.side === 'north' || object.side === 'south';
  const width = horizontal ? object.bounds.max[0] - object.bounds.min[0] : object.bounds.max[2] - object.bounds.min[2];
  const height = object.bounds.max[1] - object.bounds.min[1];
  const outerMin = horizontal ? hostBounds.min[0] : hostBounds.min[2];
  const outerMax = horizontal ? hostBounds.max[0] : hostBounds.max[2];
  const centredStart = outerMin + Math.floor((outerMax - outerMin - width) / 2);
  const at = (horizontal ? object.bounds.min[0] : object.bounds.min[2]) - centredStart;
  const kind = openingKind(spec, object.id);
  const sill = wall === undefined ? object.bounds.min[1] : object.bounds.min[1] - wall.expectedBounds.min[1];
  const fill =
    kind === 'window' && object.materialBlock !== '—' && object.materialBlock !== 'air'
      ? `, fill: ${tsString(object.materialBlock)}`
      : '';
  const notes: string[] = [];
  if (width !== object.width || height !== object.height) {
    notes.push(
      `BuildSheet bounds 推出 ${String(width)}×${String(height)}，与 width/height 字段 ${String(object.width)}×${String(object.height)} 不一致；按 bounds 施工并报告冲突。`,
    );
  }
  if (sill < 0) notes.push(`sill 相对墙底为 ${String(sill)}；洞口在墙底以下，需报告冲突。`);
  const unsafeWall = wall === undefined ? true : wall.call === null;
  if (unsafeWall) notes.push(wallIssue ?? '没有可承载该洞口的墙卡片，无法生成安全调用。');
  let call: string | null = null;
  if (wall !== undefined && wall.call !== null) {
    call = `w.opening({ in: ${wall.variable}.facade(${tsString(object.side)}), kind: ${tsString(kind)}, width: ${String(width)}, height: ${String(height)}, sill: ${String(sill)}, at: ${String(at)}${fill} })`;
  }
  return {
    id: object.id,
    kind: 'opening',
    variable: uniqueName(used, object.id),
    rect,
    call,
    params: `at=${String(at)} · sill=${String(sill)} · width=${String(width)} · height=${String(height)} · ${kind} @ ${wall?.variable ?? '?'}.${object.side}`,
    expectedBounds: object.bounds,
    netSize: { width, height },
    note: joinNotes(notes),
  };
}

function roofCard(
  object: Extract<BuildSheetObject, { kind: 'roof' }>,
  hostBounds: ConstructionCallBounds,
  wallTopY: number | undefined,
  used: Set<string>,
): ConstructionCallCard {
  const rect = rectOf(hostBounds);
  const kind = ROOF_KINDS[object.form];
  const width = hostBounds.max[0] - hostBounds.min[0];
  const depth = hostBounds.max[2] - hostBounds.min[2];
  const ridge = width >= depth ? 'x' : 'z';
  const material = object.materialBlock;
  const notes: string[] = [];
  if (kind === undefined) {
    notes.push(`BuildSpec roof.form=${object.form} 没有对应的 world.roof kind；不要手搭主坡，按合同冲突报告。`);
  }
  if (kind === 'flat' && object.ridgeY !== object.eaveY) {
    notes.push(
      `flat 屋面的 BuildSheet ridgeY=${String(object.ridgeY)} 与 eaveY=${String(object.eaveY)} 不一致，kind:'flat' 无法复现；按冲突处理。`,
    );
  }
  if (kind === 'shed') {
    notes.push(
      `单坡高侧未写入 BuildSpec；调用卡按长轴默认（ridge x → 南侧高，ridge z → 东侧高），设计相反时报告冲突。`,
    );
  }
  if (object.ridgeY < object.eaveY) {
    notes.push(`BuildSheet ridgeY=${String(object.ridgeY)} 低于 eaveY=${String(object.eaveY)}；报告冲突。`);
  }
  if (wallTopY !== undefined && object.eaveY !== wallTopY) {
    notes.push(
      `BuildSheet eaveY=${String(object.eaveY)} 与墙顶 y=${String(wallTopY)} 不一致；调用卡按 eaveY 复现屋面包络，但屋面会嵌在墙顶下，按合同冲突报告。`,
    );
  }
  if (material === '—') notes.push('BuildSheet 没有解析出屋面材质。');

  const params = [`footprint: ${rectText(rect)}`, `y: ${String(object.eaveY)}`];
  if (kind !== undefined) params.push(`kind: ${tsString(kind)}`);
  if (kind === 'gable' || kind === 'shed') params.push(`ridge: ${tsString(ridge)}`);
  if (kind !== undefined && kind !== 'flat') params.push(`peakY: ${String(object.ridgeY)}`);
  params.push(`overhang: ${String(object.overhang)}`, 'thickness: 1');
  if (kind === 'gable') params.push(`material: ${tsString(material)}`, `gableMaterial: ${tsString(material)}`);
  else params.push(`material: ${tsString(material)}`);
  return {
    id: object.id,
    kind: 'roof',
    variable: uniqueName(used, object.id),
    rect,
    call: kind === undefined || material === '—' ? null : `w.roof({ ${params.join(', ')} })`,
    params: `eaveY=${String(object.eaveY)} · peakY=${String(object.ridgeY)} · overhang=${String(object.overhang)} · kind=${kind ?? object.form}${kind === 'gable' || kind === 'shed' ? ` · ridge=${ridge}` : ''}`,
    expectedBounds: object.bounds,
    note: joinNotes(notes),
  };
}

interface EnvelopeIssues {
  readonly wall: string | null;
  readonly slab: string | null;
  readonly roof: string | null;
}

function cellKey(x: number, z: number): string {
  return `${String(x)},${String(z)}`;
}

function addRectCells(cells: Set<string>, bounds: ConstructionCallBounds): void {
  for (let x = bounds.min[0]; x < bounds.max[0]; x += 1) {
    for (let z = bounds.min[2]; z < bounds.max[2]; z += 1) cells.add(cellKey(x, z));
  }
}

function addPerimeterCells(cells: Set<string>, bounds: ConstructionCallBounds): void {
  for (let x = bounds.min[0]; x < bounds.max[0]; x += 1) {
    for (let z = bounds.min[2]; z < bounds.max[2]; z += 1) {
      if (x === bounds.min[0] || x === bounds.max[0] - 1 || z === bounds.min[2] || z === bounds.max[2] - 1) {
        cells.add(cellKey(x, z));
      }
    }
  }
}

function expectedPerimeterCells(bounds: ConstructionCallBounds): Set<string> {
  const cells = new Set<string>();
  addPerimeterCells(cells, bounds);
  return cells;
}

function wallUnionCells(spec: BuildSpec, levelId: string): Set<string> {
  const cells = new Set<string>();
  for (const element of spec.elements) {
    if (element.kind !== 'wall' || element.level !== levelId) continue;
    const width = element.bounds.max[0] - element.bounds.min[0];
    const depth = element.bounds.max[2] - element.bounds.min[2];
    if (width <= 0 || depth <= 0) continue;
    if (width === 1 || depth === 1) addRectCells(cells, element.bounds);
    else addPerimeterCells(cells, element.bounds);
  }
  return cells;
}

function slabUnionCells(spec: BuildSpec, levelId: string): Set<string> {
  const cells = new Set<string>();
  for (const element of spec.elements) {
    if (element.kind !== 'slab' || element.level !== levelId) continue;
    addRectCells(cells, element.bounds);
  }
  return cells;
}

function sameCells(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const cell of a) if (!b.has(cell)) return false;
  return true;
}

/**
 * 单个 floorPlate / walls / roof 调用只能表达一个矩形包络。BuildSpec 的 L 形多墙 / 多板 /
 * 多段屋面会被 BuildSheet 折叠成包围盒；这里显式判 unsafe，调用卡置空并说明，避免静默绑错。
 */
function envelopeIssues(spec: BuildSpec): EnvelopeIssues {
  if (spec.levels.length > 1) {
    const reason =
      'BuildSpec 有多个楼层，BuildSheet 的墙 / 板投影尚未支持（标 unverified）；调用卡不能安全复现，已置空调用。按 BuildSpec 的层 / 墙段施工并报告冲突。';
    return { wall: reason, slab: reason, roof: reason };
  }
  const level = spec.levels[0];
  if (level === undefined) return { wall: null, slab: null, roof: null };

  const expected = expectedPerimeterCells(spec.bounds);
  const walls = wallUnionCells(spec, level.id);
  const wall =
    walls.size > 0 && !sameCells(walls, expected)
      ? 'BuildSpec 的墙段 union 不是单个矩形环（多段墙 / L 形）；w.walls 只能生成一个矩形包络，已置空调用。按 BuildSpec 的墙段逐一施工并报告段间冲突。'
      : null;

  const slabElements = spec.elements.filter((element) => element.kind === 'slab' && element.level === level.id);
  const expectedSlab = new Set<string>();
  addRectCells(expectedSlab, spec.bounds);
  const slab =
    slabElements.length > 0 && !sameCells(slabUnionCells(spec, level.id), expectedSlab)
      ? 'BuildSpec 的多块楼板不是单个矩形（L 形 / 多段）；w.floorPlate 会填满包围盒，已置空调用。按 BuildSpec 的板段逐一施工并报告冲突。'
      : null;

  const roof =
    spec.roof.segments !== undefined && spec.roof.segments.length > 1
      ? 'BuildSpec 有多段屋面，BuildSheet 折叠成一个包络；调用卡不能安全复现，已置空调用。按屋面段逐一施工并报告冲突。'
      : null;
  return { wall, slab, roof };
}

function applyIssue(card: ConstructionCallCard, issue: string | null): ConstructionCallCard {
  if (issue === null) return card;
  const note = card.note === null ? issue : `${card.note} ${issue}`;
  return card.call === null ? { ...card, note } : { ...card, call: null, note };
}

/** 只派生包络对象；顺序固定为 slab → wall → opening → roof，便于代码块按施工顺序复制。 */
export function buildConstructionCallCards(
  spec: BuildSpec,
  sheet: Pick<BuildSheetContent, 'bounds' | 'objects'>,
): readonly ConstructionCallCard[] {
  const slabs: Extract<BuildSheetObject, { kind: 'slab' }>[] = [];
  const walls: Extract<BuildSheetObject, { kind: 'wall' }>[] = [];
  const openings: Extract<BuildSheetObject, { kind: 'opening' }>[] = [];
  const roofs: Extract<BuildSheetObject, { kind: 'roof' }>[] = [];
  for (const object of sheet.objects) {
    if (object.kind === 'slab') slabs.push(object);
    else if (object.kind === 'wall') walls.push(object);
    else if (object.kind === 'opening') openings.push(object);
    else roofs.push(object);
  }
  slabs.sort(compareById);
  walls.sort(compareById);
  roofs.sort(compareById);

  const issues = envelopeIssues(spec);
  const used = new Set<string>();
  const slabCards = slabs.map((object) => applyIssue(slabCard(object, used), issues.slab));
  const wallCards = walls.map((object) => applyIssue(wallCard(object, used), issues.wall));
  const wallByLevel = new Map<string, ConstructionCallCard>();
  for (const [index, wall] of walls.entries()) {
    const card = wallCards[index];
    if (card === undefined) continue;
    wallByLevel.set(wall.id.startsWith('wall:') ? wall.id.slice('wall:'.length) : wall.id, card);
  }
  const wallOf = (object: Extract<BuildSheetObject, { kind: 'opening' }>): ConstructionCallCard | undefined => {
    const specOpening = spec.openings.find((candidate) => `opening:${candidate.id}` === object.id);
    return specOpening === undefined ? undefined : wallByLevel.get(specOpening.level);
  };
  const openingCards = openings.map((object) =>
    openingCard(spec, sheet.bounds, object, wallOf(object), issues.wall, used),
  );
  const wallTopY =
    wallCards.length === 0 ? undefined : Math.max(...wallCards.map((card) => card.expectedBounds.max[1]));
  const roofCards = roofs.map((object) => applyIssue(roofCard(object, sheet.bounds, wallTopY, used), issues.roof));

  return [...slabCards, ...wallCards, ...openingCards, ...roofCards];
}

function cardCode(card: ConstructionCallCard): readonly string[] {
  if (card.call === null) return [];
  const netNote =
    card.kind === 'opening' && card.netSize !== undefined
      ? ` // 自检：净宽 ${String(card.netSize.width)} / 净高 ${String(card.netSize.height)}（不含框），不要改`
      : '';
  return [
    `  const ${card.variable} = ${card.call};${netNote}`,
    `  assertCellBounds(${card.variable}.bounds, ${codeBounds(card.expectedBounds)}, ${tsString(card.id)});`,
  ];
}

function envelopeCode(cards: readonly ConstructionCallCard[]): readonly string[] {
  const body = cards.flatMap((card, index) => [...cardCode(card), ...(index === cards.length - 1 ? [] : [''])]);
  return [
    'type CellBounds = {',
    '  readonly min: readonly [number, number, number];',
    '  readonly max: readonly [number, number, number];',
    '};',
    '',
    'function assertCellBounds(actual: CellBounds, expected: CellBounds, what: string): void {',
    '  for (const axis of [0, 1, 2] as const) {',
    '    if (actual.min[axis] !== expected.min[axis] || actual.max[axis] + 1 !== expected.max[axis]) {',
    "      throw new Error(what + ' bounds mismatch: ' + JSON.stringify(actual) + ' vs ' + JSON.stringify(expected));",
    '    }',
    '  }',
    '}',
    '',
    'export default function build(w: World): void {',
    ...body,
    '}',
  ];
}

/** 渲染“施工调用卡”一节；返回值按行拼接，调用方负责与 BuildSheet 其余章节合并。 */
export function renderConstructionCallCards(cards: readonly ConstructionCallCard[]): readonly string[] {
  const lines: string[] = [];
  lines.push('## 施工调用卡', '');
  lines.push(
    '> 抄了就跑：下表按本任务半开 bounds 换算。数字来自合同，不要改成示例值；**不要改这些数字**；必须改时先在 plan / note 说明原因，改完重新 check/probe。',
  );
  lines.push(
    '> `floorPlate.y` 和 `walls.y` 都是构件**底部** y（不是顶面）：站立面 = `y + thickness`，墙顶 = `y + height`。石基座 / `plinth` 在 y0（墙下），不要抬到 y1。',
  );
  lines.push(
    '> `opening.width` / `height` 是**净宽 / 净高，不含框**：2 格门就是 `width: 2`，不要写成 3 格再手工补洞。`frame` 可选：不传就不外凸；传了默认宽 1、向墙外凸 1 格（无 flush），可能并入墙包络。',
  );
  lines.push(
    '> `rect` 的 x1 / z1 是最后一格；期望 bounds 是半开 `[min]..[max)`。句柄 `bounds` 为闭区间：`bounds.min === expected.min` 且 `bounds.max + 1 === expected.max`。只覆盖包络对象；家具、门窗框、线脚、室内仍由你补。',
  );
  lines.push('');
  lines.push('| 对象 | rect（x/z，闭区间） | 关键参数 | 期望 bounds（半开） |');
  lines.push('| --- | --- | --- | --- |');
  for (const card of cards) {
    const params = card.call === null ? `${card.params}（见注意）` : card.params;
    lines.push(`| \`${card.id}\` | \`${rectText(card.rect)}\` | ${params} | \`${boundsText(card.expectedBounds)}\` |`);
  }
  lines.push('');
  const lock = '不要改这些数字；如果必须改，先说明原因并重新 check/probe。';
  for (const card of cards) {
    if (card.kind === 'opening' && card.netSize !== undefined) {
      lines.push(
        `- \`${card.id}\`：合同净宽 ${String(card.netSize.width)} / 净高 ${String(card.netSize.height)}（不含框）；${lock}`,
      );
    } else if (card.kind === 'wall') {
      lines.push(`- \`${card.id}\`：门窗 \`frame\` 外凸 1 格可能并入墙包络；${lock}`);
    } else {
      lines.push(`- \`${card.id}\`：${lock}`);
    }
  }
  const notes = cards.filter((card) => card.note !== null);
  for (const card of notes) lines.push(`- 注意 \`${card.id}\`：${card.note ?? ''}`);
  if (cards.some((card) => card.kind === 'opening')) {
    lines.push(
      '- opening 的 `rect` 是结果洞口；`at` 是整数格偏移（南北 +x、东西 +z），偶宽对称、奇宽偏半格：10 格跨宽 2 → x6..7，宽 3 → x5..7；`sill` 相对墙底 / 站立面。',
    );
  }
  if (cards.some((card) => card.kind === 'roof')) {
    lines.push(
      '- roof 的 `rect` 是墙顶承托轮廓；`y` 就是 BuildSheet 的 eaveY，`peakY` 是 ridgeY；期望 bounds 已含 overhang，不要把期望 bounds 再当 footprint（会二次外扩）。',
    );
  }
  if (cards.some((card) => card.kind === 'wall' || card.kind === 'roof')) {
    lines.push(
      '- wall / roof 的 `thickness: 1` 是 BuildSheet 期望 bounds 对应的厚度；BuildSpec 未单列该字段，不要自行加厚。',
    );
  }
  lines.push('');
  lines.push('```ts');
  lines.push(...envelopeCode(cards));
  lines.push('```');
  return lines;
}
