/* eslint-disable max-lines -- 首版把载入 / provenance / 屋面判定 / CLI 放在同一离线工具里，避免为一张卡拆出多份半成品。 */
/**
 * 离线 design-conformance：BuildSpec（期望）+ building.pgar（实际）→ ConformanceReport。
 * 屋面 form / pitch / eave / ridge + 窗遮挡 / 窗几何 + 门宽 / 门高 / 门槛高差 / 门内 1m 净空；
 * 不联网、不启动 Chrome、不调用模型、不构建。
 *
 * 报告语义：`blocking` 才是唯一的阻断门（hard fail + supported hard unverified）。
 * `ok` 仅表示 CLI 退出码语义（ok === !blocking）；soft unverified（hip / 多段 / butterfly / curved / 无 openings）
 * 时 ok 仍为 true，但不代表全部检查已验证，消费者（03B）不得用 ok 当门，必须用 blocking。
 * 退出码：0 无 blocking（ok=true）；1 有 blocking；2 参数 / 读取 / 完整性错误。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '@pg/blocks/load';
import { readArchive } from '@pg/core/archive';
import { formatState, isAir } from '@pg/core/block-state';
import { Y_MAX, Y_MIN } from '@pg/core/coord';
import type { Cell, Grid } from '@pg/core/grid';
import { isFlushMustText } from '@pg/interaction/flush-text';
import { BuildSpec } from '@pg/interaction/schema';
import { z } from 'zod';

type Spec = z.infer<typeof BuildSpec>;
type Opening = Spec['openings'][number];
type CheckStatus = 'pass' | 'fail' | 'unverified';
type Severity = 'hard' | 'soft';
type Axis = 'x' | 'z';
type ActualForm = 'flat' | 'gable' | 'hip' | 'shed' | 'stepped' | 'other';
interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}
interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Evidence {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly block: string;
  readonly call: number;
  readonly line: number;
}

export interface ConformanceCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly severity: Severity;
  readonly detail: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly evidence: readonly Evidence[];
}

export interface RoofActual {
  readonly form: ActualForm | null;
  readonly pitchDegrees: number | null;
  readonly eaveHeight: number | null;
  readonly ridgeHeight: number | null;
  readonly lowestRoofY: number | null;
  readonly ridgeWidth: number | null;
  readonly columns: number;
  readonly materialBlocks: readonly string[];
  readonly slopeAxis: Axis | null;
  readonly ridgeAxis: Axis | null;
  readonly topBounds: Bounds | null;
  readonly ridgeBounds: Bounds | null;
  readonly profile: readonly { readonly coord: number; readonly height: number }[];
}

export interface RoofEvaluation {
  readonly checks: readonly ConformanceCheck[];
  readonly actual: RoofActual;
}

export interface OpeningActual {
  readonly id: string;
  readonly kind: string;
  readonly side: string;
  readonly expected: Record<string, unknown> | null;
  readonly actual: Record<string, unknown> | null;
}

export interface OpeningsEvaluation {
  readonly checks: readonly ConformanceCheck[];
  readonly actual: readonly OpeningActual[];
}

interface OpeningModel {
  readonly opening: Opening;
  readonly sillY: number;
  readonly headY: number;
  readonly width: number;
  readonly height: number;
  readonly normal: Axis;
  readonly outward: -1 | 1;
  readonly plane: number;
  readonly innerStart: number;
  readonly horizontal: readonly number[];
  readonly normalCells: readonly number[];
  readonly frameBlocks: ReadonlySet<string>;
}

interface OpeningModelResult {
  readonly model: OpeningModel | null;
  readonly reason: string | null;
}

interface GlassSummary {
  readonly width: number;
  readonly height: number;
  readonly sillY: number;
  readonly headY: number;
  readonly offsetY: number;
  readonly horizontalMin: number | null;
  readonly horizontalMax: number | null;
  readonly horizontalOffset: number | null;
  readonly expectedCells: number;
  readonly missingCells: number;
  readonly segments: number;
  readonly cells: number;
  readonly filledCells: number;
}

interface DoorColumn {
  readonly h: number;
  readonly bottom: number;
  readonly top: number;
}

interface DoorMeasurement {
  readonly columns: readonly DoorColumn[];
  readonly width: number;
  readonly bottom: number | null;
  readonly top: number | null;
  readonly height: number | null;
  /** 所选各列洞顶是否一致；不一致通常意味着单侧门楣缺失 / 高度不齐。 */
  readonly headAligned: boolean;
  readonly openPoints: readonly Point3[];
  readonly blocked: readonly Cell[];
}

interface SurfacePoint {
  readonly y: number;
  readonly point: Point3;
  readonly block: string;
}

interface DoorThresholdActual {
  readonly check: ConformanceCheck;
  readonly actual: Record<string, unknown> | null;
  readonly indoorY: number | null;
}

interface EventRef {
  readonly line: number;
  readonly type: string;
  readonly body: unknown;
}

interface RunBundle {
  runDir: string;
  archivePath: string;
  archiveSha256: string;
  archiveBytes: number;
  grid: Grid;
  codeVersion: number | null;
  deliveryFilePresent: boolean;
  deliveryHash: string | null;
  deliveryArchiveSha256: string | null;
  deliveryFileArchiveSha256: string | null;
  deliveryCodeSha256: string | null;
  eventsPath: string;
  eventsLineCount: number;
  runStartLine: number | null;
  deliveryLine: number | null;
  lastCheckResultLine: number | null;
  archiveCheckResultLine: number | null;
  runStartTaskSha256: string | null;
  deliveryEventArchiveSha256: string | null;
  lastCheckArchiveSha256: string | null;
  deliveryFileCodeVersion: number | null;
  deliveryEventCodeVersion: number | null;
  lastCheckCodeVersion: number | null;
}

interface Summary {
  pass: number;
  fail: number;
  unverified: number;
  /** 旧字段，与 blockingFailures 同义，保留兼容。 */
  hardFailures: number;
  /** 旧字段，与 blockingUnverified 同义，保留兼容。 */
  hardUnverified: number;
  /** hard fail 数：真正的阻断失败。 */
  blockingFailures: number;
  /** supported 但无法判定的 hard unverified：同样阻断。 */
  blockingUnverified: number;
}

interface TaskInfo {
  path: string | null;
  sha256: string | null;
  matches: boolean | null;
}

export interface ConformanceReport {
  schemaVersion: 1;
  /**
   * CLI 退出语义：ok === !blocking。
   * ok=true 只表示没有 blocking；存在 soft unverified（hip / 多段 / butterfly / curved / 无 openings）时
   * 仍可能 ok=true，因此 ok 不等于“全部已验证”。03B 等消费者必须用 blocking 当门。
   */
  ok: boolean;
  /** 唯一阻断门：hard fail + supported hard unverified。soft fail / soft unverified 不阻断。 */
  blocking: boolean;
  /** 所有检查都 pass（无 fail、无任何 unverified，含 soft）；用于区分“通过”与“仅无阻断”。 */
  fullyVerified: boolean;
  spec: Record<string, unknown>;
  actual: Record<string, unknown>;
  checks: readonly ConformanceCheck[];
  provenance: Record<string, unknown>;
  summary: Summary;
}

export interface ConformanceIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface ConformanceDeps {
  io?: ConformanceIo;
}

export class ConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceError';
  }
}

export const DESIGN_CONFORMANCE_USAGE = `用法：node tools/design-conformance.ts --session-dir <dir> --run <dir> [选项]
  读取 <session>/build-spec.json 与 <run>/delivery/building.pgar，离线输出 ConformanceReport。
  --session-dir <dir> 设计会话目录（含 build-spec.json / build-task.md）
  --session <dir>     同 --session-dir
  --run <dir>         构建 run 目录（含 delivery/ 与 events.jsonl）
  --spec <path>       显式 build-spec.json（合成 fixture；与 --session 二选一）
  --out <path>        把同一份 JSON 写入文件
  --json              输出 JSON（默认行为）
  --help, -h          打印本说明

  检查：provenance.integrity（仅真实 --session-dir run）+ roof.form / roof.pitch / roof.eave / roof.ridge
  + opening.window.occlusion / opening.window.geometry + door.width / door.height / door.threshold / door.clearance。
  --spec 合成 fixture 跳过 run provenance；hip / 多段 / butterfly / curved 等 unsupported 记为 soft unverified，不阻断。
  报告顶层 blocking 才是阻断门（hard fail + hard unverified）；ok 仅表示 CLI 退出码，soft unverified 时仍为 true，
  但 fullyVerified=false。消费者（03B）不得用 ok 当门，必须用 blocking。
  退出码：0 无 blocking（ok=true）；1 有 blocking；2 参数 / 读取 / 完整性错误。`;

interface Options {
  sessionDir: string | null;
  runDir: string;
  specPath: string | null;
  outPath: string | null;
  help: boolean;
}

function value(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next === '' || next.startsWith('--')) {
    throw new ConformanceError(`${flag} 缺少取值。\n${DESIGN_CONFORMANCE_USAGE}`);
  }
  return next;
}

export function parseDesignConformanceArgs(argv: readonly string[]): Options {
  let sessionDir: string | null = null;
  let runDir: string | null = null;
  let specPath: string | null = null;
  let outPath: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--session-dir':
      case '--session':
        if (sessionDir !== null) throw new ConformanceError(`${arg} 只能出现一次。`);
        sessionDir = value(argv, i, arg);
        i += 1;
        break;
      case '--run':
        if (runDir !== null) throw new ConformanceError('--run 只能出现一次。');
        runDir = value(argv, i, '--run');
        i += 1;
        break;
      case '--spec':
        if (specPath !== null) throw new ConformanceError('--spec 只能出现一次。');
        specPath = value(argv, i, '--spec');
        i += 1;
        break;
      case '--out':
        if (outPath !== null) throw new ConformanceError('--out 只能出现一次。');
        outPath = value(argv, i, '--out');
        i += 1;
        break;
      case '--json':
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new ConformanceError(`未知参数 ${arg}。\n${DESIGN_CONFORMANCE_USAGE}`);
    }
  }
  if (help) return { sessionDir, runDir: runDir ?? '', specPath, outPath, help: true };
  if (runDir === null) throw new ConformanceError(`缺少 --run。\n${DESIGN_CONFORMANCE_USAGE}`);
  if (sessionDir === null && specPath === null) {
    throw new ConformanceError(`缺少 --session-dir（或 --spec）。\n${DESIGN_CONFORMANCE_USAGE}`);
  }
  if (sessionDir !== null && specPath !== null) throw new ConformanceError('--session-dir 与 --spec 不能同时使用。');
  return { sessionDir, runDir, specPath, outPath, help: false };
}

const RefSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.int().nonnegative() });
const DeliverySchema = z.object({
  archive: RefSchema.optional(),
  code: RefSchema.optional(),
  hash: z.string().optional(),
  codeVersion: z.int().positive().optional(),
});
const CheckBodySchema = z.object({
  codeVersion: z.int().positive(),
  archive: RefSchema.optional(),
  run: z.object({ cells: z.int().nonnegative() }).nullable().optional(),
});
const RunStartSchema = z.object({ task: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional() });
const EventEnvelopeSchema = z.object({ type: z.string().min(1), body: z.unknown() });

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readBytes(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new ConformanceError(`读不到${what} ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJson(path: string, what: string): unknown {
  const text = readBytes(path, what).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConformanceError(
      `${what} ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function loadSpec(path: string): { spec: Spec; sha256: string } {
  if (!existsSync(path)) throw new ConformanceError(`读不到 build-spec.json：${path}`);
  const bytes = readBytes(path, 'build-spec.json');
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new ConformanceError(
      `build-spec.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = BuildSpec.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`)
      .join('；');
    throw new ConformanceError(`build-spec.json 不符合 BuildSpec：${issues}`);
  }
  return { spec: parsed.data, sha256: sha256(bytes) };
}

function loadEvents(path: string): EventRef[] {
  if (!existsSync(path)) return [];
  const text = readBytes(path, 'events.jsonl').toString('utf8');
  const events: EventRef[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch (error) {
      throw new ConformanceError(
        `events.jsonl 第 ${String(i + 1)} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const envelope = EventEnvelopeSchema.safeParse(raw);
    if (!envelope.success) throw new ConformanceError(`events.jsonl 第 ${String(i + 1)} 行不是合法事件信封。`);
    events.push({ line: i + 1, type: envelope.data.type, body: envelope.data.body });
  }
  return events;
}

function parseBody<T>(event: EventRef, schema: z.ZodType<T>, what: string): T {
  const parsed = schema.safeParse(event.body);
  if (!parsed.success) throw new ConformanceError(`events.jsonl 第 ${String(event.line)} 行的 ${what} 事件不合法。`);
  return parsed.data;
}

function lastEvent(events: readonly EventRef[], type: string): EventRef | null {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i]?.type === type) return events[i] ?? null;
  return null;
}

function loadRun(runDirInput: string): RunBundle {
  const runDir = resolve(runDirInput);
  const eventsPath = join(runDir, 'events.jsonl');
  const events = loadEvents(eventsPath);
  const deliveryJsonPath = join(runDir, 'delivery', 'delivery.json');
  const deliveryFile = existsSync(deliveryJsonPath)
    ? DeliverySchema.parse(readJson(deliveryJsonPath, 'delivery.json'))
    : null;
  const deliveryEvent = lastEvent(events, 'delivery');
  const deliveryBody = deliveryEvent === null ? null : parseBody(deliveryEvent, DeliverySchema, 'delivery');
  const checkEvents = events.filter((event) => event.type === 'check.result');
  const lastCheckEvent = checkEvents.at(-1) ?? null;
  const lastCheck = lastCheckEvent === null ? null : parseBody(lastCheckEvent, CheckBodySchema, 'check.result');

  const deliveryArchiveSha = deliveryFile?.archive?.sha256 ?? deliveryBody?.archive?.sha256 ?? null;
  const expectedArchiveSha = deliveryArchiveSha ?? lastCheck?.archive?.sha256 ?? null;
  let archivePath = join(runDir, 'delivery', 'building.pgar');
  if (!existsSync(archivePath)) {
    if (expectedArchiveSha === null) throw new ConformanceError(`读不到交付存档：${archivePath}`);
    archivePath = join(runDir, 'blobs', expectedArchiveSha);
    if (!existsSync(archivePath)) throw new ConformanceError(`读不到交付存档，也找不到 blobs/${expectedArchiveSha}。`);
  }
  const archiveBytes = readBytes(archivePath, '交付存档');
  const archiveSha = sha256(archiveBytes);

  let grid: Grid;
  try {
    grid = readArchive(loadRegistry().table, archiveBytes).grid;
  } catch (error) {
    throw new ConformanceError(`无法解码 ${archivePath}：${error instanceof Error ? error.message : String(error)}`);
  }

  const deliveryFileCodeVersion = deliveryFile?.codeVersion ?? null;
  const deliveryEventCodeVersion = deliveryBody?.codeVersion ?? null;
  const deliveryCodeVersion = deliveryFileCodeVersion ?? deliveryEventCodeVersion;
  const lastCheckCodeVersion = lastCheck?.codeVersion ?? null;
  const archiveCheckEvent = [...checkEvents].reverse().find((event) => {
    const body = CheckBodySchema.safeParse(event.body);
    return body.success && body.data.archive?.sha256 === archiveSha;
  });
  const taskEvent = lastEvent(events, 'run.start');
  const taskBody = taskEvent === null ? null : parseBody(taskEvent, RunStartSchema, 'run.start');

  return {
    runDir,
    archivePath,
    archiveSha256: archiveSha,
    archiveBytes: archiveBytes.length,
    grid,
    codeVersion: deliveryCodeVersion ?? lastCheckCodeVersion,
    deliveryFilePresent: deliveryFile !== null,
    deliveryHash: deliveryFile?.hash ?? deliveryBody?.hash ?? null,
    deliveryArchiveSha256: deliveryArchiveSha,
    deliveryFileArchiveSha256: deliveryFile?.archive?.sha256 ?? null,
    deliveryCodeSha256: deliveryFile?.code?.sha256 ?? deliveryBody?.code?.sha256 ?? null,
    eventsPath,
    eventsLineCount: events.length,
    runStartLine: taskEvent?.line ?? null,
    deliveryLine: deliveryEvent?.line ?? null,
    lastCheckResultLine: lastCheckEvent?.line ?? null,
    archiveCheckResultLine: archiveCheckEvent?.line ?? null,
    runStartTaskSha256: taskBody?.task?.sha256 ?? null,
    deliveryEventArchiveSha256: deliveryBody?.archive?.sha256 ?? null,
    lastCheckArchiveSha256: lastCheck?.archive?.sha256 ?? null,
    deliveryFileCodeVersion,
    deliveryEventCodeVersion,
    lastCheckCodeVersion,
  };
}

function materialBlocks(spec: Spec): string[] {
  const byId = new Map(spec.materials.map((material) => [material.id, material.block.split('[')[0] ?? '']));
  const ids = new Set<string>([spec.roof.material]);
  for (const segment of spec.roof.segments ?? []) ids.add(segment.material);
  const blocks = new Set<string>();
  for (const id of ids) {
    const block = byId.get(id);
    if (block !== undefined && block !== '') blocks.add(block);
  }
  for (const material of spec.materials) {
    const block = material.block.split('[')[0] ?? '';
    if (material.role === 'roof' && block !== '') blocks.add(block);
  }
  return [...blocks].sort();
}

function candidateNames(blocks: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const block of blocks) {
    names.add(block);
    const stem = block.endsWith('s') ? block.slice(0, -1) : block;
    names.add(`${stem}_stairs`);
    names.add(`${stem}_slab`);
    names.add(`${block}_stairs`);
    names.add(`${block}_slab`);
  }
  return names;
}

function comparePoints(a: Point3, b: Point3): number {
  return a.y - b.y || a.z - b.z || a.x - b.x;
}

function evidenceOf(grid: Grid, points: Iterable<Point3>): Evidence[] {
  const lines = new Map(grid.calls().map((call) => [call.id, call.line]));
  const seen = new Set<string>();
  const evidence: Evidence[] = [];
  for (const point of [...points].sort(comparePoints)) {
    const key = `${String(point.x)},${String(point.y)},${String(point.z)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cell = grid.get(point.x, point.y, point.z);
    evidence.push({
      x: point.x,
      y: point.y,
      z: point.z,
      block: cell === undefined ? 'air' : formatState(cell.state),
      call: cell?.call ?? 0,
      line: cell === undefined ? 0 : (lines.get(cell.call) ?? 0),
    });
    if (evidence.length >= 5) break;
  }
  return evidence;
}

function boundsOf(points: Iterable<Cell>): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let any = false;
  for (const point of points) {
    any = true;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    maxZ = Math.max(maxZ, point.z);
  }
  return any ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : null;
}

function spanText(bounds: Bounds | null): string {
  return bounds === null
    ? '无'
    : `x${String(bounds.min[0])}..${String(bounds.max[0])} × z${String(bounds.min[2])}..${String(bounds.max[2])}`;
}

function representatives(tops: readonly Cell[], slopeAxis: Axis, ridgeAxis: Axis): Cell[] {
  const byCoord = new Map<number, Cell[]>();
  for (const cell of tops) {
    const coord = slopeAxis === 'z' ? cell.z : cell.x;
    const list = byCoord.get(coord);
    if (list === undefined) byCoord.set(coord, [cell]);
    else list.push(cell);
  }
  const coords = [...byCoord.keys()].sort((a, b) => a - b);
  const picks = [
    coords[0],
    coords[Math.floor(coords.length / 3)],
    coords[Math.floor((coords.length * 2) / 3)],
    coords.at(-1),
  ];
  const out: Cell[] = [];
  for (const coord of picks) {
    if (coord === undefined) continue;
    const list = byCoord.get(coord);
    const cell =
      list === undefined ? undefined : [...list].sort((a, b) => (ridgeAxis === 'x' ? a.x - b.x : a.z - b.z))[0];
    if (cell !== undefined) out.push(cell);
  }
  return out;
}

function corners(cells: readonly Cell[]): Cell[] {
  const bounds = boundsOf(cells);
  if (bounds === null) return [];
  const out: Cell[] = [];
  for (const [x, z] of [
    [bounds.min[0], bounds.min[2]],
    [bounds.min[0], bounds.max[2]],
    [bounds.max[0], bounds.min[2]],
    [bounds.max[0], bounds.max[2]],
  ] as const) {
    const found = cells.find((cell) => cell.x === x && cell.z === z);
    if (found !== undefined) out.push(found);
  }
  for (const cell of cells) {
    if (out.length >= 5) break;
    if (!out.includes(cell)) out.push(cell);
  }
  return out;
}

const ROOF_CHECKS = [
  ['roof.form', '屋面形式'],
  ['roof.pitch', '屋面坡度'],
  ['roof.eave', '檐口高度'],
  ['roof.ridge', '屋脊高度'],
] as const;

function unverifiedRoof(reason: string, blocks: readonly string[], severity: Severity = 'hard'): RoofEvaluation {
  const actual: RoofActual = {
    form: null,
    pitchDegrees: null,
    eaveHeight: null,
    ridgeHeight: null,
    lowestRoofY: null,
    ridgeWidth: null,
    columns: 0,
    materialBlocks: blocks,
    slopeAxis: null,
    ridgeAxis: null,
    topBounds: null,
    ridgeBounds: null,
    profile: [],
  };
  const checks: ConformanceCheck[] = ROOF_CHECKS.map(([id, label]) => ({
    id,
    status: 'unverified',
    severity,
    detail: `${label}无法判定：${reason}`,
    expected: null,
    actual: null,
    evidence: [],
  }));
  return { checks, actual };
}

export function evaluateRoof(spec: Spec, grid: Grid): RoofEvaluation {
  const blocks = materialBlocks(spec);
  if (spec.roof.segments !== undefined && spec.roof.segments.length > 1) {
    return unverifiedRoof('多段屋面首版不支持', blocks, 'soft');
  }
  if (spec.roof.form === 'hip') {
    return unverifiedRoof('hip 屋面首版不支持：四坡脊线 / 坡度尚未实现，不能用 form 单独通过', blocks, 'soft');
  }
  if (!['flat', 'gable', 'shed'].includes(spec.roof.form)) {
    return unverifiedRoof(`期望屋面形式 ${spec.roof.form} 首版不支持`, blocks, 'soft');
  }
  if (blocks.length === 0) return unverifiedRoof('BuildSpec 没有 role=roof 的材质 block', blocks);

  const names = candidateNames(blocks);
  const roofCells = [...grid.cells()].filter((cell) => names.has(cell.state.name));
  if (roofCells.length === 0) {
    return unverifiedRoof(`存档里找不到屋面材质格（${blocks.join(', ')}）`, blocks);
  }
  const lowestRoofY = Math.min(...roofCells.map((cell) => cell.y));
  const topByColumn = new Map<string, Cell>();
  for (const cell of roofCells) {
    const key = `${String(cell.x)},${String(cell.z)}`;
    const current = topByColumn.get(key);
    if (current === undefined || cell.y > current.y) topByColumn.set(key, cell);
  }
  const tops = [...topByColumn.values()];
  const byX = new Map<number, Set<number>>();
  const byZ = new Map<number, Set<number>>();
  for (const cell of tops) {
    const xs = byX.get(cell.x);
    if (xs === undefined) byX.set(cell.x, new Set([cell.y]));
    else xs.add(cell.y);
    const zs = byZ.get(cell.z);
    if (zs === undefined) byZ.set(cell.z, new Set([cell.y]));
    else zs.add(cell.y);
  }
  const constantAlongX = [...byZ.values()].every((heights) => heights.size === 1);
  const constantAlongZ = [...byX.values()].every((heights) => heights.size === 1);
  const slopeAxis: Axis | null =
    constantAlongX && !constantAlongZ ? 'z' : !constantAlongX && constantAlongZ ? 'x' : null;
  const ridgeAxis: Axis | null = slopeAxis === 'z' ? 'x' : slopeAxis === 'x' ? 'z' : null;

  let profile: { coord: number; height: number }[] = [];
  if (slopeAxis !== null) {
    const heights = new Map<number, number>();
    for (const cell of tops) {
      const coord = slopeAxis === 'z' ? cell.z : cell.x;
      heights.set(coord, Math.max(heights.get(coord) ?? -Infinity, cell.y));
    }
    profile = [...heights.entries()].sort((a, b) => a[0] - b[0]).map(([coord, height]) => ({ coord, height }));
  }
  const heights = tops.map((cell) => cell.y);
  const maxHeight = Math.max(...heights);
  const minHeight = Math.min(...heights);
  const ridgeCells = tops.filter((cell) => cell.y === maxHeight);
  const ridgeCoords = profile.filter((point) => point.height === maxHeight).map((point) => point.coord);
  const ridgeWidth = profile.length === 0 ? null : ridgeCoords.length;

  let leftAngle: number | null = null;
  let rightAngle: number | null = null;
  if (slopeAxis !== null && ridgeCoords.length > 0) {
    const first = profile[0];
    const last = profile.at(-1);
    const ridgeFirst = Math.min(...ridgeCoords);
    const ridgeLast = Math.max(...ridgeCoords);
    if (first !== undefined && ridgeFirst > first.coord) {
      const distance = ridgeFirst - first.coord;
      leftAngle = (Math.atan(Math.max(0, maxHeight - first.height) / distance) * 180) / Math.PI;
    }
    if (last !== undefined && ridgeLast < last.coord) {
      const distance = last.coord - ridgeLast;
      rightAngle = (Math.atan(Math.max(0, maxHeight - last.height) / distance) * 180) / Math.PI;
    }
  }
  const angles = [leftAngle, rightAngle].filter((angle): angle is number => angle !== null);
  // 所有顶面同高就是合法 flat：坡度定义为 0，不能落成 null 让 roof.pitch 永远 unverified。
  const pitchDegrees =
    maxHeight === minHeight
      ? 0
      : angles.length === 0
        ? null
        : Math.round((angles.reduce((a, b) => a + b, 0) / angles.length) * 10) / 10;

  let form: ActualForm;
  if (maxHeight === minHeight) form = 'flat';
  else if (slopeAxis === null) form = 'hip';
  else if (ridgeWidth !== null && ridgeWidth > 1) form = 'stepped';
  else if (ridgeCoords.length > 0) {
    const ridgeFirst = Math.min(...ridgeCoords);
    const ridgeLast = Math.max(...ridgeCoords);
    let leftOk = true;
    for (let i = 0; i < profile.findIndex((point) => point.coord === ridgeFirst); i += 1) {
      if ((profile[i]?.height ?? 0) > (profile[i + 1]?.height ?? 0)) leftOk = false;
    }
    let rightOk = true;
    for (let i = profile.findIndex((point) => point.coord === ridgeLast); i < profile.length - 1; i += 1) {
      if ((profile[i]?.height ?? 0) < (profile[i + 1]?.height ?? 0)) rightOk = false;
    }
    const leftRise = leftAngle !== null && leftAngle > 0;
    const rightRise = rightAngle !== null && rightAngle > 0;
    // 双坡必须两侧都有非零坡且脊线不在檐口端；只有一侧有坡、剖面单调的是单坡。
    const ridgeInterior =
      ridgeFirst > (profile[0]?.coord ?? ridgeFirst) && ridgeLast < (profile.at(-1)?.coord ?? ridgeLast);
    const gable = ridgeInterior && leftRise && rightRise && leftOk && rightOk;
    const shed = leftOk && rightOk && leftRise !== rightRise;
    form = gable ? 'gable' : shed ? 'shed' : 'stepped';
  } else form = 'other';

  const actual: RoofActual = {
    form,
    pitchDegrees,
    eaveHeight: minHeight,
    ridgeHeight: maxHeight,
    lowestRoofY: Number.isFinite(lowestRoofY) ? lowestRoofY : null,
    ridgeWidth,
    columns: tops.length,
    materialBlocks: blocks,
    slopeAxis,
    ridgeAxis,
    topBounds: boundsOf(tops),
    ridgeBounds: boundsOf(ridgeCells),
    profile,
  };
  const expectedForm = spec.roof.form;
  const expectedPitch = spec.roof.pitchDegrees;
  const pitchStatus: CheckStatus =
    pitchDegrees === null ? 'unverified' : Math.abs(pitchDegrees - expectedPitch) <= 2 ? 'pass' : 'fail';
  const formDetail = `期望 ${expectedForm}；实际 ${form}：脊线沿 ${ridgeAxis ?? '未知'}，顶面沿 ${slopeAxis ?? '未知'} 为 ${profile.map((point) => String(point.height)).join(',')}；脊线宽 ${String(ridgeWidth ?? 0)} 格。`;
  const pitchDetail =
    pitchDegrees === null
      ? '屋面坡度无法判定'
      : `期望 ${String(expectedPitch)}°；实际约 ${String(pitchDegrees)}°（左侧 ${leftAngle === null ? '无' : `${leftAngle.toFixed(1)}°`} / 右侧 ${rightAngle === null ? '无' : `${rightAngle.toFixed(1)}°`}）。`;
  const eaveCells = tops.filter((cell) => cell.y === minHeight);
  const lowestCells = roofCells.filter((cell) => cell.y === lowestRoofY);
  const pitchCells =
    slopeAxis === null
      ? ridgeCells
      : tops.filter((cell) => {
          const coord = slopeAxis === 'z' ? cell.z : cell.x;
          return coord === profile[0]?.coord || coord === profile.at(-1)?.coord || ridgeCoords.includes(coord);
        });
  const checks: ConformanceCheck[] = [
    {
      id: 'roof.form',
      status: form === expectedForm ? 'pass' : 'fail',
      severity: 'hard',
      detail: formDetail,
      expected: expectedForm,
      actual: form,
      evidence: evidenceOf(
        grid,
        slopeAxis === null || ridgeAxis === null ? tops : representatives(tops, slopeAxis, ridgeAxis),
      ),
    },
    {
      id: 'roof.pitch',
      status: pitchStatus,
      severity: 'hard',
      detail: pitchDetail,
      expected: expectedPitch,
      actual: pitchDegrees,
      evidence: evidenceOf(grid, pitchCells),
    },
    {
      id: 'roof.eave',
      status: minHeight === spec.roof.eaveHeight ? 'pass' : 'fail',
      severity: 'hard',
      detail: `期望檐口顶面 y=${String(spec.roof.eaveHeight)}；实际最低屋面顶面 y=${String(minHeight)}（最低屋面格 y=${String(lowestRoofY)}）。`,
      expected: spec.roof.eaveHeight,
      actual: minHeight,
      evidence: evidenceOf(grid, [...eaveCells, ...lowestCells]),
    },
    {
      id: 'roof.ridge',
      status: maxHeight === spec.roof.ridgeHeight ? 'pass' : 'fail',
      severity: 'hard',
      detail: `期望屋脊 y=${String(spec.roof.ridgeHeight)}；实际最高屋面 y=${String(maxHeight)}；脊线宽 ${String(ridgeWidth ?? 0)} 格，顶台 ${spanText(boundsOf(ridgeCells))}。`,
      expected: spec.roof.ridgeHeight,
      actual: maxHeight,
      evidence: evidenceOf(grid, corners(ridgeCells)),
    },
  ];
  return { checks, actual };
}

function integerRange(from: number, to: number): number[] {
  const values: number[] = [];
  for (let value = from; value <= to; value += 1) values.push(value);
  return values;
}

function blockForMaterial(spec: Spec, id: string | null): string | null {
  if (id === null) return null;
  const material = spec.materials.find((candidate) => candidate.id === id);
  const block = material?.block.split('[')[0] ?? '';
  return block === '' ? null : block;
}

function isGlassBlock(name: string): boolean {
  return (
    name === 'glass' ||
    name === 'glass_pane' ||
    name === 'tinted_glass' ||
    name.endsWith('_glass') ||
    name.endsWith('_glass_pane')
  );
}

/**
 * 地毯 / 苔藓毯是 1/16 格厚的软质装饰，不改变通行高度。
 * 只排除明确的地毯族，避免把所有非实心方块（花、压力板、按钮等）都当成可穿透。
 */
function isCarpetBlock(name: string): boolean {
  return name === 'carpet' || name.endsWith('_carpet');
}

function isDoorBlock(name: string): boolean {
  return name.endsWith('_door') || name.endsWith('_fence_gate');
}

function isFrameBlock(name: string, blocks: ReadonlySet<string>): boolean {
  for (const block of blocks) {
    if (name === block || name.startsWith(`${block}_`)) return true;
  }
  return false;
}

function isSolid(cell: Cell | undefined): cell is Cell {
  return cell !== undefined && !isAir(cell.state) && !isCarpetBlock(cell.state.name);
}

function pointOf(model: OpeningModel, h: number, y: number, normal: number): Point3 {
  return model.normal === 'z' ? { x: h, y, z: normal } : { x: normal, y, z: h };
}

function cellAt(grid: Grid, model: OpeningModel, h: number, y: number, normal: number): Cell | undefined {
  const point = pointOf(model, h, y, normal);
  return grid.get(point.x, point.y, point.z);
}

function rangeText(values: readonly number[]): string {
  const first = values[0];
  const last = values.at(-1);
  if (first === undefined || last === undefined) return '无';
  return first === last ? String(first) : `${String(first)}..${String(last)}`;
}

function describeCells(cells: readonly Cell[]): string {
  const sorted = [...cells].sort(comparePoints);
  const shown = sorted
    .slice(0, 12)
    .map((cell) => `(${String(cell.x)},${String(cell.y)},${String(cell.z)})=${formatState(cell.state)}`);
  return `${shown.join('；')}${sorted.length > shown.length ? `；等 ${String(sorted.length)} 格` : ''}`;
}

function openingModel(spec: Spec, opening: Opening): OpeningModelResult {
  const level = spec.levels.find((candidate) => candidate.id === opening.level);
  if (level === undefined) return { model: null, reason: `楼层 ${opening.level} 不存在` };
  const sillY = level.elevation + opening.sillHeight;
  const headY = level.elevation + opening.headHeight;
  const [minX, minY, minZ] = opening.bounds.min;
  const [maxX, maxY, maxZ] = opening.bounds.max;
  const height = maxY - minY;
  const normal: Axis = opening.side === 'north' || opening.side === 'south' ? 'z' : 'x';
  const outward: -1 | 1 = opening.side === 'north' || opening.side === 'west' ? -1 : 1;
  const minNormal = normal === 'z' ? minZ : minX;
  const maxNormal = normal === 'z' ? maxZ : maxX;
  const width = normal === 'z' ? maxX - minX : maxZ - minZ;
  if (sillY !== minY || headY !== maxY) {
    return {
      model: null,
      reason: `楼层 ${opening.level} 标高 ${String(level.elevation)} + sill/head ${String(opening.sillHeight)}/${String(opening.headHeight)} 得 y${String(sillY)}..${String(headY - 1)}，与 bounds y${String(minY)}..${String(maxY - 1)} 不一致`,
    };
  }
  if (height !== opening.height) {
    return {
      model: null,
      reason: `BuildSpec.height=${String(opening.height)} 与 bounds 高度 ${String(height)} 不一致`,
    };
  }
  if (width !== opening.width) {
    return {
      model: null,
      reason: `BuildSpec.width=${String(opening.width)} 与洞口横向尺寸 ${String(width)} 不一致（side=${opening.side}）`,
    };
  }
  if (width <= 0 || height <= 0 || maxNormal <= minNormal) {
    return { model: null, reason: '洞口 bounds 为空' };
  }
  const depth = maxNormal - minNormal;
  if (width * height * depth > 200_000) {
    return { model: null, reason: '洞口体过大，拒绝扫描' };
  }
  const normalCells = integerRange(minNormal, maxNormal - 1);
  const plane = outward < 0 ? minNormal : maxNormal - 1;
  const innerStart = outward < 0 ? maxNormal : minNormal - 1;
  const frameBlock = blockForMaterial(spec, opening.frameMaterial);
  return {
    model: {
      opening,
      sillY,
      headY,
      width,
      height,
      normal,
      outward,
      plane,
      innerStart,
      horizontal: normal === 'z' ? integerRange(minX, maxX - 1) : integerRange(minZ, maxZ - 1),
      normalCells,
      frameBlocks: new Set(frameBlock === null ? [] : [frameBlock]),
    },
    reason: null,
  };
}

/** BuildSpec 把无门扇的门洞也记成 kind=opening；门 / 门洞 / 大门都走门类检查。 */
function isDoorLike(opening: Opening): boolean {
  return opening.kind === 'door' || opening.kind === 'opening' || opening.kind === 'gate';
}

function openingCheckId(opening: Opening, aspect: string): string {
  return isDoorLike(opening) ? `door.${aspect}.${opening.id}` : `opening.${opening.kind}.${aspect}.${opening.id}`;
}

const DOOR_CLEAR_PATTERNS = [
  /door[-_ ]?clear/i,
  /clearance/i,
  /门内.{0,16}(?:1\s*(?:m|米)|一米)/i,
  /(?:1\s*(?:m|米)|一米).{0,16}净空/i,
  /净空/,
] as const;

function mustText(spec: Spec): string {
  return spec.musts.map((must) => `${must.id} ${must.text}`).join('\n');
}

function mentions(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** 只有 BuildSpec.musts 明确要求时，门槛 / 门内净空失败才进入 blocking。 */
function openingRequirements(spec: Spec): { readonly flushEntry: boolean; readonly doorClearance: boolean } {
  return {
    flushEntry: spec.musts.some((must) => isFlushMustText(must.text)),
    doorClearance: mentions(mustText(spec), DOOR_CLEAR_PATTERNS),
  };
}

function unverifiedOpeningChecks(opening: Opening, reason: string, severity: Severity = 'hard'): ConformanceCheck[] {
  const aspects = isDoorLike(opening)
    ? (['width', 'height', 'threshold', 'clearance'] as const)
    : opening.kind === 'window'
      ? (['occlusion', 'geometry'] as const)
      : (['geometry'] as const);
  const labels: Record<string, string> = {
    width: '门洞净宽',
    height: '门洞净高',
    threshold: '门槛高差',
    clearance: '门内 1m 净空',
    occlusion: '窗洞遮挡',
    geometry: '洞口几何',
  };
  return aspects.map((aspect) => ({
    id: openingCheckId(opening, aspect),
    status: 'unverified',
    severity,
    detail: `${labels[aspect] ?? aspect}无法判定：${reason}。`,
    expected: null,
    actual: null,
    evidence: [],
  }));
}

function expectedOpeningSummary(model: OpeningModel): Record<string, unknown> {
  return {
    id: model.opening.id,
    kind: model.opening.kind,
    side: model.opening.side,
    host: model.opening.host,
    level: model.opening.level,
    bounds: model.opening.bounds,
    width: model.width,
    height: model.height,
    sillY: model.sillY,
    headY: model.headY,
    fill: model.opening.fill,
    frameMaterial: model.opening.frameMaterial,
  };
}

function contiguousRuns(values: readonly number[]): { readonly bottom: number; readonly top: number }[] {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const runs: { bottom: number; top: number }[] = [];
  for (const value of sorted) {
    const current = runs.at(-1);
    if (current !== undefined && value === current.top + 1) {
      runs[runs.length - 1] = { bottom: current.bottom, top: value };
    } else {
      runs.push({ bottom: value, top: value });
    }
  }
  return runs;
}

interface ScanSpan {
  readonly horizontals: readonly number[];
  readonly minY: number;
  readonly maxY: number;
}

/**
 * 期望洞口完整时只扫期望范围：直接相邻的另一扇窗不能被算进本窗 summary。
 * 只有期望范围缺格时才左右 / 上下各扩 1 格，用来识别整体偏移 1 格。
 */
function openingScanSpan(grid: Grid, model: OpeningModel): ScanSpan {
  const first = model.horizontal[0];
  const last = model.horizontal.at(-1);
  if (first === undefined || last === undefined) {
    return { horizontals: [], minY: model.sillY, maxY: model.sillY - 1 };
  }
  const complete = windowCoverage(grid, model).missing.length === 0;
  return complete
    ? { horizontals: model.horizontal, minY: model.sillY, maxY: model.headY - 1 }
    : {
        horizontals: integerRange(first - 1, last + 1),
        minY: Math.max(Y_MIN, model.sillY - 1),
        maxY: Math.min(Y_MAX, model.headY),
      };
}

function collectGlass(grid: Grid, model: OpeningModel, span: ScanSpan = openingScanSpan(grid, model)): Cell[] {
  const cells: Cell[] = [];
  for (const h of span.horizontals) {
    for (let y = span.minY; y <= span.maxY; y += 1) {
      for (const normal of model.normalCells) {
        const cell = cellAt(grid, model, h, y, normal);
        if (cell !== undefined && isGlassBlock(cell.state.name)) cells.push(cell);
      }
    }
  }
  return cells.sort(comparePoints);
}

/** 玻璃 / 窗框都算洞口填充；用于几何尺寸与横向区间，不用于“有没有玻璃”的覆盖判定。 */
function collectFills(grid: Grid, model: OpeningModel, span: ScanSpan = openingScanSpan(grid, model)): Cell[] {
  const cells: Cell[] = [];
  for (const h of span.horizontals) {
    for (let y = span.minY; y <= span.maxY; y += 1) {
      for (const normal of model.normalCells) {
        const cell = cellAt(grid, model, h, y, normal);
        if (cell === undefined) continue;
        if (isGlassBlock(cell.state.name)) {
          cells.push(cell);
          continue;
        }
        // 窗框只认期望洞口内的格；洞口外侧的收边 / 压顶不算窗扇，避免把合法窗套误判成整体偏移。
        const inExpectedY = y >= model.sillY && y < model.headY;
        const inExpectedH = model.horizontal.includes(h);
        if (inExpectedY && inExpectedH && isFrameBlock(cell.state.name, model.frameBlocks)) cells.push(cell);
      }
    }
  }
  return cells.sort(comparePoints);
}

/** 期望洞口逐格覆盖：玻璃或窗框都算填实；空气 / 家具 / 地毯不算，少一格玻璃要报出来。 */
function windowCoverage(
  grid: Grid,
  model: OpeningModel,
): { readonly expected: number; readonly covered: number; readonly missing: Point3[] } {
  let covered = 0;
  const missing: Point3[] = [];
  for (const h of model.horizontal) {
    for (let y = model.sillY; y < model.headY; y += 1) {
      let filled = false;
      for (const normal of model.normalCells) {
        const cell = cellAt(grid, model, h, y, normal);
        if (cell === undefined) continue;
        if (isGlassBlock(cell.state.name) || isFrameBlock(cell.state.name, model.frameBlocks)) {
          filled = true;
          break;
        }
      }
      if (filled) covered += 1;
      else missing.push(pointOf(model, h, y, model.plane));
    }
  }
  return { expected: model.width * model.height, covered, missing };
}

function summarizeGlass(
  grid: Grid,
  fills: readonly Cell[],
  glassCells: number,
  model: OpeningModel,
): GlassSummary | null {
  if (fills.length === 0) return null;
  const expectedFirst = model.horizontal[0];
  const horizontals = [...new Set(fills.map((cell) => (model.normal === 'z' ? cell.x : cell.z)))].sort((a, b) => a - b);
  const ys = [...new Set(fills.map((cell) => cell.y))].sort((a, b) => a - b);
  const minY = ys[0] ?? model.sillY;
  const maxY = ys.at(-1) ?? model.sillY;
  const horizontalMin = horizontals[0] ?? null;
  const horizontalMax = horizontals.at(-1) ?? null;
  const coverage = windowCoverage(grid, model);
  return {
    width: horizontals.length,
    height: maxY - minY + 1,
    sillY: minY,
    headY: maxY + 1,
    offsetY: minY - model.sillY,
    horizontalMin,
    horizontalMax,
    horizontalOffset: horizontalMin === null || expectedFirst === undefined ? null : horizontalMin - expectedFirst,
    expectedCells: coverage.expected,
    missingCells: coverage.missing.length,
    segments: contiguousRuns(ys).length,
    cells: glassCells,
    filledCells: fills.length,
  };
}

function windowOccluders(grid: Grid, model: OpeningModel): { inside: Cell[]; shell: Cell[]; host: Point3[] } {
  const inside: Cell[] = [];
  for (const h of model.horizontal) {
    for (let y = model.sillY; y < model.headY; y += 1) {
      for (const normal of model.normalCells) {
        const cell = cellAt(grid, model, h, y, normal);
        if (cell === undefined) continue;
        if (isGlassBlock(cell.state.name) || isFrameBlock(cell.state.name, model.frameBlocks)) continue;
        if (isSolid(cell)) inside.push(cell);
      }
    }
  }
  const glass = collectGlass(grid, model);
  const glassYs = glass.map((cell) => cell.y);
  const minY = glassYs.length === 0 ? model.sillY : Math.min(...glassYs);
  const maxY = glassYs.length === 0 ? model.headY - 1 : Math.max(...glassYs);
  const shell: Cell[] = [];
  const shellNormal = model.plane + model.outward;
  for (const h of model.horizontal) {
    for (let y = minY; y <= maxY; y += 1) {
      const cell = cellAt(grid, model, h, y, shellNormal);
      if (cell === undefined) continue;
      if (isGlassBlock(cell.state.name) || isFrameBlock(cell.state.name, model.frameBlocks)) continue;
      if (isSolid(cell)) shell.push(cell);
    }
  }
  const host: Point3[] = [];
  const first = model.horizontal[0];
  const last = model.horizontal.at(-1);
  if (first !== undefined && last !== undefined) {
    for (const h of [first - 1, last + 1]) {
      const cell = cellAt(grid, model, h, model.sillY, model.plane);
      if (isSolid(cell)) host.push(pointOf(model, h, model.sillY, model.plane));
    }
  }
  return { inside, shell, host };
}

function windowOcclusionCheck(grid: Grid, model: OpeningModel, glass: readonly Cell[]): ConformanceCheck {
  const { inside, shell, host } = windowOccluders(grid, model);
  const occluders = [...inside, ...shell];
  const status: CheckStatus =
    occluders.length > 0 ? 'fail' : glass.length === 0 && host.length === 0 ? 'unverified' : 'pass';
  const detail =
    status === 'fail'
      ? `窗洞内 ${String(inside.length)} 个非玻璃实心格，外侧 1 格壳 ${String(shell.length)} 个遮挡格。遮挡：${describeCells(occluders)}。`
      : status === 'unverified'
        ? '窗洞内既没有玻璃，外侧也没有可识别的宿主墙 / 框，无法确认洞口是否存在。'
        : `窗洞内与外侧 1 格壳无遮挡；玻璃 ${String(glass.length)} 格。`;
  return {
    id: openingCheckId(model.opening, 'occlusion'),
    status,
    severity: 'hard',
    detail,
    expected: '窗洞内及外侧 1 格壳无玻璃以外的实心遮挡',
    actual: {
      insideOccluders: inside.length,
      shellOccluders: shell.length,
      glassCells: glass.length,
      occluders: occluders.slice(0, 12).map((cell) => ({
        x: cell.x,
        y: cell.y,
        z: cell.z,
        block: formatState(cell.state),
      })),
    },
    evidence: evidenceOf(grid, status === 'fail' ? occluders : [...glass, ...host]),
  };
}

function windowGeometryCheck(
  grid: Grid,
  model: OpeningModel,
  glass: readonly Cell[],
  summary: GlassSummary | null,
): ConformanceCheck {
  const expectedFirst = model.horizontal[0];
  const expectedLast = model.horizontal.at(-1);
  const horizontalLabel = model.normal === 'z' ? 'x' : 'z';
  const expected = {
    width: model.width,
    height: model.height,
    sillY: model.sillY,
    headY: model.headY,
    horizontal: { axis: horizontalLabel, first: expectedFirst ?? null, last: expectedLast ?? null },
  };
  if (summary === null) {
    return {
      id: openingCheckId(model.opening, 'geometry'),
      status: 'unverified',
      severity: 'hard',
      detail: '窗几何无法判定：窗洞附近没有玻璃格，无法区分“没有玻璃”与“没有洞口”。',
      expected,
      actual: null,
      evidence: evidenceOf(grid, windowOccluders(grid, model).host),
    };
  }
  const problems: string[] = [];
  if (summary.width !== model.width) problems.push(`宽度 ${String(summary.width)} ≠ ${String(model.width)}`);
  if (summary.height !== model.height) problems.push(`高度 ${String(summary.height)} ≠ ${String(model.height)}`);
  if (summary.sillY !== model.sillY || summary.headY !== model.headY) {
    problems.push(
      `竖向区间 y${String(summary.sillY)}..${String(summary.headY - 1)} ≠ 期望 y${String(model.sillY)}..${String(model.headY - 1)}`,
    );
  }
  if (summary.horizontalMin !== expectedFirst || summary.horizontalMax !== expectedLast) {
    problems.push(
      `水平区间 ${horizontalLabel}${rangeText([
        summary.horizontalMin ?? Number.NaN,
        summary.horizontalMax ?? Number.NaN,
      ])} ≠ 期望 ${horizontalLabel}${rangeText([expectedFirst ?? Number.NaN, expectedLast ?? Number.NaN])}`,
    );
  }
  if (summary.missingCells > 0) {
    problems.push(`洞内缺 ${String(summary.missingCells)} 格玻璃 / 窗框`);
  }
  if (summary.cells === 0) problems.push('洞内没有玻璃格');
  if (summary.segments > 1) problems.push(`玻璃被切成 ${String(summary.segments)} 段`);
  const status: CheckStatus = problems.length === 0 ? 'pass' : 'fail';
  const offsetText = summary.offsetY === 0 ? '0' : `${summary.offsetY > 0 ? '+' : ''}${String(summary.offsetY)}y`;
  const horizontalOffsetText =
    summary.horizontalOffset === null || summary.horizontalOffset === 0
      ? '0'
      : `${summary.horizontalOffset > 0 ? '+' : ''}${String(summary.horizontalOffset)}${horizontalLabel}`;
  return {
    id: openingCheckId(model.opening, 'geometry'),
    status,
    severity: 'hard',
    detail:
      `期望 ${String(model.width)}×${String(model.height)}，${horizontalLabel}${rangeText([expectedFirst ?? Number.NaN, expectedLast ?? Number.NaN])}、` +
      `窗台 y=${String(model.sillY)}、洞顶 y=${String(model.headY)}；` +
      `实际填充 ${String(summary.width)}×${String(summary.height)}，${horizontalLabel}${rangeText([
        summary.horizontalMin ?? Number.NaN,
        summary.horizontalMax ?? Number.NaN,
      ])}，窗台 y=${String(summary.sillY)}、顶 y=${String(summary.headY)}（水平位移 ${horizontalOffsetText}，竖向位移 ${offsetText}），` +
      `覆盖 ${String(summary.expectedCells - summary.missingCells)}/${String(summary.expectedCells)} 格、玻璃 ${String(summary.cells)} 格、连续段 ${String(summary.segments)}。` +
      (problems.length === 0 ? '' : `问题：${problems.join('；')}。`),
    expected,
    actual: summary,
    evidence: evidenceOf(grid, glass),
  };
}

function hasSolidAbove(grid: Grid, model: OpeningModel, h: number, top: number, depth: number): boolean {
  const maxY = Math.min(Y_MAX, top + depth);
  for (let y = top + 1; y <= maxY; y += 1) {
    const cell = cellAt(grid, model, h, y, model.plane);
    if (isSolid(cell) && !isDoorBlock(cell.state.name) && !isGlassBlock(cell.state.name)) return true;
  }
  return false;
}

function measureDoor(grid: Grid, model: OpeningModel): DoorMeasurement {
  const first = model.horizontal[0];
  const last = model.horizontal.at(-1);
  const empty: DoorMeasurement = {
    columns: [],
    width: 0,
    bottom: null,
    top: null,
    height: null,
    headAligned: false,
    openPoints: [],
    blocked: [],
  };
  if (first === undefined || last === undefined) return empty;
  const minY = Math.max(Y_MIN, model.sillY - 2);
  const maxY = Math.min(Y_MAX, model.headY + 2);
  const columns: DoorColumn[] = [];
  const openPoints: Point3[] = [];
  for (let h = first - 2; h <= last + 2; h += 1) {
    const permeable: number[] = [];
    for (let y = minY; y <= maxY; y += 1) {
      const cell = cellAt(grid, model, h, y, model.plane);
      if (cell === undefined || isAir(cell.state) || isDoorBlock(cell.state.name) || isCarpetBlock(cell.state.name))
        permeable.push(y);
    }
    const runs = contiguousRuns(permeable);
    if (runs.length === 0) continue;
    let chosen: { readonly bottom: number; readonly top: number } | null = null;
    let chosenOverlap = -1;
    let chosenDistance = Infinity;
    for (const run of runs) {
      const overlap = Math.max(0, Math.min(run.top + 1, model.headY) - Math.max(run.bottom, model.sillY));
      const distance = Math.abs(run.bottom - model.sillY);
      if (overlap > chosenOverlap || (overlap === chosenOverlap && distance < chosenDistance)) {
        chosen = run;
        chosenOverlap = overlap;
        chosenDistance = distance;
      }
    }
    if (chosen === null) continue;
    // 净洞口必须与期望竖向区间相交，并且上方有墙 / 过梁；否则空网格或场地空气会被误当成门洞。
    if (chosenOverlap <= 0 || !hasSolidAbove(grid, model, h, chosen.top, 3)) continue;
    columns.push({ h, bottom: chosen.bottom, top: chosen.top });
    for (let y = chosen.bottom; y <= chosen.top; y += 1) openPoints.push(pointOf(model, h, y, model.plane));
  }
  if (columns.length === 0) return empty;

  const horizontalRuns = contiguousRuns(columns.map((column) => column.h));
  let selected = horizontalRuns[0];
  let selectedOverlap = -1;
  for (const run of horizontalRuns) {
    const overlap = Math.max(0, Math.min(run.top + 1, last + 1) - Math.max(run.bottom, first));
    if (overlap > selectedOverlap) {
      selected = run;
      selectedOverlap = overlap;
    }
  }
  if (selected === undefined) return empty;
  const selectedColumns = columns.filter((column) => column.h >= selected.bottom && column.h <= selected.top);
  if (selectedColumns.length === 0) return empty;
  const bottom = Math.max(...selectedColumns.map((column) => column.bottom));
  // 取最大洞顶而不是最小：单侧门楣缺一格时，那一列会向上多出空气，净高必须因此变大并失败。
  const top = Math.max(...selectedColumns.map((column) => column.top));
  const headAligned = selectedColumns.every((column) => column.top === top);
  const blocked: Cell[] = [];
  for (const h of model.horizontal) {
    for (let y = model.sillY; y < model.headY; y += 1) {
      const cell = cellAt(grid, model, h, y, model.plane);
      if (cell === undefined) continue;
      if (isDoorBlock(cell.state.name) || isFrameBlock(cell.state.name, model.frameBlocks)) continue;
      if (isSolid(cell)) blocked.push(cell);
    }
  }
  return {
    columns: selectedColumns,
    width: selected.top - selected.bottom + 1,
    bottom,
    top: top >= bottom ? top : null,
    height: top >= bottom ? top - bottom + 1 : null,
    headAligned,
    openPoints: openPoints.filter((point) => point.y >= bottom && point.y <= top),
    blocked,
  };
}

function doorWidthCheck(grid: Grid, model: OpeningModel, measurement: DoorMeasurement): ConformanceCheck {
  const expected = { width: model.width, height: model.height };
  if (measurement.columns.length === 0) {
    return {
      id: openingCheckId(model.opening, 'width'),
      status: 'unverified',
      severity: 'hard',
      detail: '门洞净宽无法判定：墙面上找不到由空气 / 门扇组成的净洞口（可能被填实、墙面为空或存档无几何）。',
      expected,
      actual: null,
      evidence: evidenceOf(grid, measurement.blocked),
    };
  }
  const status: CheckStatus =
    measurement.width === model.width &&
    measurement.columns[0]?.h === model.horizontal[0] &&
    measurement.columns.at(-1)?.h === model.horizontal.at(-1)
      ? 'pass'
      : 'fail';
  const first = measurement.columns[0]?.h;
  const last = measurement.columns.at(-1)?.h;
  const expectedFirst = model.horizontal[0];
  const expectedLast = model.horizontal.at(-1);
  const horizontalLabel = model.normal === 'z' ? 'x' : 'z';
  const offset = first === undefined || expectedFirst === undefined ? null : first - expectedFirst;
  return {
    id: openingCheckId(model.opening, 'width'),
    status,
    severity: 'hard',
    detail:
      `期望门洞净宽 ${String(model.width)}m，横向 ${horizontalLabel}${rangeText([expectedFirst ?? Number.NaN, expectedLast ?? Number.NaN])}；` +
      `实际 ${String(measurement.width)}m（${horizontalLabel}${rangeText(measurement.columns.map((column) => column.h))}，洞底 y=${String(measurement.bottom ?? 0)}，` +
      `水平位移 ${offset === null ? '未知' : `${offset > 0 ? '+' : ''}${String(offset)}${horizontalLabel}`}）。`,
    expected: { ...expected, horizontal: { first: expectedFirst ?? null, last: expectedLast ?? null } },
    actual: {
      width: measurement.width,
      bottom: measurement.bottom,
      top: measurement.top,
      columns: measurement.columns.map((column) => column.h),
      horizontal: { first: first ?? null, last: last ?? null },
    },
    evidence: evidenceOf(
      grid,
      measurement.columns.flatMap((column) =>
        column.h === first || column.h === last ? [pointOf(model, column.h, column.bottom, model.plane)] : [],
      ),
    ),
  };
}

function doorHeightCheck(grid: Grid, model: OpeningModel, measurement: DoorMeasurement): ConformanceCheck {
  const expected = { width: model.width, height: model.height };
  if (
    measurement.columns.length === 0 ||
    measurement.height === null ||
    measurement.bottom === null ||
    measurement.top === null
  ) {
    return {
      id: openingCheckId(model.opening, 'height'),
      status: 'unverified',
      severity: 'hard',
      detail: '门洞净高无法判定：墙面上找不到净洞口。',
      expected,
      actual: null,
      evidence: evidenceOf(grid, measurement.blocked),
    };
  }
  const headAligned = measurement.headAligned;
  const status: CheckStatus = measurement.height === model.height && headAligned ? 'pass' : 'fail';
  const horizontalLabel = model.normal === 'z' ? 'x' : 'z';
  const representative = measurement.columns[0]?.h;
  const evidencePoints: Point3[] = [];
  if (representative !== undefined) {
    evidencePoints.push(pointOf(model, representative, measurement.bottom, model.plane));
    evidencePoints.push(pointOf(model, representative, measurement.top, model.plane));
    const lintelY = measurement.top + 1;
    if (lintelY <= Y_MAX) evidencePoints.push(pointOf(model, representative, lintelY, model.plane));
  }
  for (const column of measurement.columns) {
    if (column.top === measurement.top) continue;
    const y = Math.min(Y_MAX, column.top + 1);
    evidencePoints.push(pointOf(model, column.h, y, model.plane));
  }
  const headProblem = headAligned
    ? ''
    : `问题：各列洞顶不一致（${measurement.columns
        .map((column) => `${horizontalLabel}${String(column.h)}:y${String(column.top)}`)
        .join('、')}），门楣可能单侧缺失。`;
  return {
    id: openingCheckId(model.opening, 'height'),
    status,
    severity: 'hard',
    detail:
      `期望门洞净高 ${String(model.height)}m；实际 ${String(measurement.height)}m（洞底 y=${String(measurement.bottom)}、洞顶 y=${String(measurement.top)}）。` +
      headProblem,
    expected,
    actual: {
      height: measurement.height,
      bottom: measurement.bottom,
      top: measurement.top,
      headAligned,
      columns: measurement.columns.map((column) => column.h),
      columnTops: measurement.columns.map((column) => ({ h: column.h, top: column.top })),
    },
    evidence: evidenceOf(grid, evidencePoints),
  };
}

function topSurface(
  grid: Grid,
  model: OpeningModel,
  horizontals: readonly number[],
  normal: number,
  minY: number,
  maxY: number,
): SurfacePoint | null {
  let best: SurfacePoint | null = null;
  for (const h of horizontals) {
    for (let y = maxY; y >= minY; y -= 1) {
      const cell = cellAt(grid, model, h, y, normal);
      if (cell === undefined) continue;
      if (isAir(cell.state) || isDoorBlock(cell.state.name) || isGlassBlock(cell.state.name)) continue;
      if (isCarpetBlock(cell.state.name)) continue;
      if (isFrameBlock(cell.state.name, model.frameBlocks)) continue;
      if (best === null || y > best.y) {
        best = { y, point: pointOf(model, h, y, normal), block: formatState(cell.state) };
      }
      break;
    }
  }
  return best;
}

function doorThresholdCheck(
  grid: Grid,
  model: OpeningModel,
  measurement: DoorMeasurement,
  severity: Severity,
): DoorThresholdActual {
  const advisory = severity === 'soft' ? ' BuildSpec.musts 未明确要求无台阶 / 齐平，本项仅作 advisory，不阻断。' : '';
  if (measurement.columns.length === 0) {
    return {
      check: {
        id: openingCheckId(model.opening, 'threshold'),
        status: 'unverified',
        severity,
        detail: `门槛高差无法判定：找不到净门洞，无法确定门槛 / 室内外两侧表面。${advisory}`,
        expected: { indoorStep: 0, outdoorStep: 0 },
        actual: null,
        evidence: evidenceOf(grid, measurement.blocked),
      },
      actual: null,
      indoorY: null,
    };
  }
  const horizontal = measurement.columns.map((column) => column.h);
  const minY = Math.max(Y_MIN, model.sillY - 4);
  const maxY = Math.min(Y_MAX, measurement.bottom ?? model.sillY + 1);
  const threshold = topSurface(grid, model, horizontal, model.plane, minY, maxY);
  const indoor = topSurface(grid, model, horizontal, model.innerStart, minY, maxY);
  const outdoor = topSurface(grid, model, horizontal, model.plane + model.outward, minY, maxY);
  const expected = { indoorStep: 0, outdoorStep: 0, threshold: '与室内楼面、室外相邻地面齐平' };
  if (threshold === null || indoor === null || outdoor === null) {
    const missing = [
      threshold === null ? '门槛' : null,
      indoor === null ? '室内楼面' : null,
      outdoor === null ? '室外相邻地面' : null,
    ].filter((item): item is string => item !== null);
    const outdoorNote = outdoor === null ? ' 存档中门外没有测到相邻室外地面，不能把室内楼板当作室外地面。' : '';
    return {
      check: {
        id: openingCheckId(model.opening, 'threshold'),
        status: 'unverified',
        severity,
        detail: `门槛高差无法判定：找不到${missing.join(' / ')}的实体表面。${outdoorNote}${advisory}`,
        expected,
        actual: null,
        evidence: evidenceOf(
          grid,
          [threshold, indoor, outdoor].flatMap((surface) => (surface === null ? [] : [surface.point])),
        ),
      },
      actual: null,
      indoorY: indoor?.y ?? null,
    };
  }
  const indoorStep = threshold.y - indoor.y;
  const outdoorStep = threshold.y - outdoor.y;
  const status: CheckStatus = Math.abs(indoorStep) >= 1 || Math.abs(outdoorStep) >= 1 ? 'fail' : 'pass';
  return {
    check: {
      id: openingCheckId(model.opening, 'threshold'),
      status,
      severity,
      detail:
        `门槛顶面 y=${String(threshold.y)}（${threshold.block}）；室内楼面 y=${String(indoor.y)}（${indoor.block}）；` +
        `室外相邻地面 y=${String(outdoor.y)}（${outdoor.block}）；室内高差 ${String(indoorStep)}，室外高差 ${String(outdoorStep)}。` +
        (status === 'fail' ? ' 门洞两侧存在至少 1 格台阶。' : '') +
        advisory,
      expected,
      actual: {
        thresholdY: threshold.y,
        indoorY: indoor.y,
        outdoorY: outdoor.y,
        indoorStep,
        outdoorStep,
        thresholdBlock: threshold.block,
        indoorBlock: indoor.block,
        outdoorBlock: outdoor.block,
      },
      evidence: evidenceOf(grid, [threshold.point, indoor.point, outdoor.point]),
    },
    actual: { thresholdY: threshold.y, indoorY: indoor.y, outdoorY: outdoor.y, indoorStep, outdoorStep },
    indoorY: indoor.y,
  };
}

function doorClearanceCheck(
  grid: Grid,
  model: OpeningModel,
  measurement: DoorMeasurement,
  indoorY: number | null,
  severity: Severity,
): ConformanceCheck {
  const advisory =
    severity === 'soft' ? ' BuildSpec.musts 未明确要求门内 1m 净空 / door-clear，本项仅作 advisory，不阻断。' : '';
  const expected = { depth: 1, width: model.width, clearHeight: Math.max(1, model.height) };
  if (indoorY === null || measurement.columns.length === 0 || measurement.top === null) {
    return {
      id: openingCheckId(model.opening, 'clearance'),
      status: 'unverified',
      severity,
      detail: `门内 1m 净空无法判定：缺少室内楼面或净门洞证据。${advisory}`,
      expected,
      actual: null,
      evidence: [],
    };
  }
  const horizontals = measurement.columns.map((column) => column.h);
  const fromY = Math.max(Y_MIN, indoorY + 1);
  const toY = Math.min(Y_MAX, Math.max(fromY, measurement.top));
  const blockers: Cell[] = [];
  for (const h of horizontals) {
    for (let y = fromY; y <= toY; y += 1) {
      const cell = cellAt(grid, model, h, y, model.innerStart);
      if (cell === undefined) continue;
      if (isDoorBlock(cell.state.name) || isGlassBlock(cell.state.name)) continue;
      if (isFrameBlock(cell.state.name, model.frameBlocks)) continue;
      if (isSolid(cell)) blockers.push(cell);
    }
  }
  const status: CheckStatus = blockers.length === 0 ? 'pass' : 'fail';
  const first = horizontals[0];
  const innerLabel = model.normal === 'z' ? `z=${String(model.innerStart)}` : `x=${String(model.innerStart)}`;
  return {
    id: openingCheckId(model.opening, 'clearance'),
    status,
    severity,
    detail:
      (status === 'fail'
        ? `门内 1m 净空带（${innerLabel}，y${String(fromY)}..${String(toY)}）有硬遮挡：${describeCells(blockers)}。`
        : `门内 1m 净空带（${innerLabel}，${model.normal === 'z' ? 'x' : 'z'}${rangeText(horizontals)} × y${String(fromY)}..${String(toY)}）无硬遮挡；地面 y=${String(indoorY)} 不计入净空。`) +
      advisory,
    expected,
    actual: {
      innerCoord: model.innerStart,
      fromY,
      toY,
      columns: horizontals,
      blockers: blockers.length,
    },
    evidence: evidenceOf(
      grid,
      status === 'fail' || first === undefined ? blockers : [pointOf(model, first, fromY, model.innerStart)],
    ),
  };
}

function evaluateWindow(
  grid: Grid,
  model: OpeningModel,
): { readonly checks: readonly ConformanceCheck[]; readonly actual: Record<string, unknown> } {
  const span = openingScanSpan(grid, model);
  const glass = collectGlass(grid, model, span);
  const fills = collectFills(grid, model, span);
  const summary = summarizeGlass(grid, fills, glass.length, model);
  const occlusion = windowOcclusionCheck(grid, model, glass);
  const geometry = windowGeometryCheck(grid, model, glass, summary);
  return {
    checks: [occlusion, geometry],
    actual: {
      planeAxis: model.normal,
      plane: model.plane,
      outward: model.outward,
      glass: summary,
      occlusion: occlusion.actual,
    },
  };
}

function evaluateDoor(
  grid: Grid,
  model: OpeningModel,
  requirements: ReturnType<typeof openingRequirements>,
): { readonly checks: readonly ConformanceCheck[]; readonly actual: Record<string, unknown> } {
  const measurement = measureDoor(grid, model);
  const width = doorWidthCheck(grid, model, measurement);
  const height = doorHeightCheck(grid, model, measurement);
  const threshold = doorThresholdCheck(grid, model, measurement, requirements.flushEntry ? 'hard' : 'soft');
  const clearance = doorClearanceCheck(
    grid,
    model,
    measurement,
    threshold.indoorY,
    requirements.doorClearance ? 'hard' : 'soft',
  );
  return {
    checks: [width, height, threshold.check, clearance],
    actual: {
      planeAxis: model.normal,
      plane: model.plane,
      outward: model.outward,
      aperture: {
        width: measurement.width,
        height: measurement.height,
        bottom: measurement.bottom,
        top: measurement.top,
        columns: measurement.columns.map((column) => column.h),
      },
      threshold: threshold.actual,
      clearance: clearance.actual,
    },
  };
}

export function evaluateOpenings(spec: Spec, grid: Grid): OpeningsEvaluation {
  const checks: ConformanceCheck[] = [];
  const actual: OpeningActual[] = [];
  const requirements = openingRequirements(spec);
  if (spec.openings.length === 0) {
    checks.push({
      id: 'openings.present',
      status: 'unverified',
      severity: 'soft',
      detail: 'BuildSpec 没有 openings；未生成洞口 / 门检查。',
      expected: [],
      actual: [],
      evidence: [],
    });
    return { checks, actual };
  }
  for (const opening of spec.openings) {
    const result = openingModel(spec, opening);
    if (result.model === null) {
      checks.push(...unverifiedOpeningChecks(opening, result.reason ?? '未知原因'));
      actual.push({ id: opening.id, kind: opening.kind, side: opening.side, expected: null, actual: null });
      continue;
    }
    const model = result.model;
    if (opening.kind === 'window') {
      const evaluation = evaluateWindow(grid, model);
      checks.push(...evaluation.checks);
      actual.push({
        id: opening.id,
        kind: opening.kind,
        side: opening.side,
        expected: expectedOpeningSummary(model),
        actual: evaluation.actual,
      });
    } else if (isDoorLike(opening)) {
      const evaluation = evaluateDoor(grid, model, requirements);
      checks.push(...evaluation.checks);
      actual.push({
        id: opening.id,
        kind: opening.kind,
        side: opening.side,
        expected: expectedOpeningSummary(model),
        actual: evaluation.actual,
      });
    } else {
      checks.push(...unverifiedOpeningChecks(opening, `kind=${opening.kind} 首版只实现 window / 门洞`, 'soft'));
      actual.push({
        id: opening.id,
        kind: opening.kind,
        side: opening.side,
        expected: expectedOpeningSummary(model),
        actual: null,
      });
    }
  }
  return { checks, actual };
}

function summarize(checks: readonly ConformanceCheck[]): Summary {
  const blockingFailures = checks.filter((check) => check.status === 'fail' && check.severity === 'hard').length;
  const blockingUnverified = checks.filter(
    (check) => check.status === 'unverified' && check.severity === 'hard',
  ).length;
  return {
    pass: checks.filter((check) => check.status === 'pass').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    unverified: checks.filter((check) => check.status === 'unverified').length,
    hardFailures: blockingFailures,
    hardUnverified: blockingUnverified,
    blockingFailures,
    blockingUnverified,
  };
}

function taskInfo(sessionDir: string | null, specOverride: boolean, runStartSha: string | null): TaskInfo {
  if (sessionDir === null || specOverride) return { path: null, sha256: null, matches: null };
  const path = join(sessionDir, 'build-task.md');
  if (!existsSync(path)) return { path, sha256: null, matches: null };
  const sha = sha256(readBytes(path, 'build-task.md'));
  return { path, sha256: sha, matches: runStartSha === null ? null : sha === runStartSha };
}

interface IntegrityView {
  readonly mode: 'run' | 'synthetic';
  readonly required: boolean;
  readonly taskMatches: boolean | null;
  readonly deliveryManifestPresent: boolean;
  readonly deliveryArchiveMatches: boolean | null;
  readonly deliveryEventArchiveMatches: boolean | null;
  readonly lastCheckArchiveMatches: boolean | null;
  readonly codeVersion: number | null;
  readonly deliveryCodeVersion: number | null;
  readonly deliveryEventCodeVersion: number | null;
  readonly checkCodeVersion: number | null;
  readonly codeVersionMatchesCheck: boolean | null;
  readonly issues: readonly string[];
}

/** 真实 run 模式必须 fail closed：delivery 清单、delivery 事件、最后一条 check.result 都要绑定同一个存档。 */
function provenanceIssues(run: RunBundle, task: TaskInfo): string[] {
  const issues: string[] = [];
  if (!run.deliveryFilePresent) issues.push('缺 delivery/delivery.json');
  else if (run.deliveryFileArchiveSha256 === null) issues.push('delivery.json 缺 archive.sha256');

  if (run.deliveryLine === null) issues.push('events.jsonl 缺 delivery 事件');
  else if (run.deliveryEventArchiveSha256 === null) issues.push('delivery 事件缺 archive.sha256');

  if (run.lastCheckResultLine === null) issues.push('events.jsonl 缺 check.result 事件');
  else if (run.lastCheckArchiveSha256 === null) issues.push('最后一条 check.result 缺 archive.sha256');

  if (run.deliveryFileArchiveSha256 !== null && run.deliveryFileArchiveSha256 !== run.archiveSha256) {
    issues.push('delivery.json archive sha 与存档不一致');
  }
  if (run.deliveryEventArchiveSha256 !== null && run.deliveryEventArchiveSha256 !== run.archiveSha256) {
    issues.push('delivery 事件 archive sha 与存档不一致');
  }
  if (run.lastCheckArchiveSha256 !== null && run.lastCheckArchiveSha256 !== run.archiveSha256) {
    issues.push('最后一条 check.result archive sha 与存档不一致');
  }

  const versions = [run.deliveryFileCodeVersion, run.deliveryEventCodeVersion, run.lastCheckCodeVersion];
  if (versions.some((version) => version === null)) {
    issues.push('delivery.json / delivery 事件 / check.result 缺 codeVersion');
  } else if (new Set(versions).size !== 1) {
    issues.push('delivery.json / delivery 事件 / check.result 的 codeVersion 不一致');
  }

  if (run.runStartLine === null) issues.push('events.jsonl 缺 run.start 事件，无法绑定 task');
  else if (run.runStartTaskSha256 === null) issues.push('run.start 缺 task.sha256');
  else if (task.sha256 === null) issues.push('读不到 session 的 build-task.md，无法绑定 task');
  else if (task.sha256 !== run.runStartTaskSha256) {
    issues.push('build-task.md sha 与 run.start.task.sha256 不一致');
  }
  return issues;
}

function integrityView(run: RunBundle, task: TaskInfo, required: boolean): IntegrityView {
  const versions = [run.deliveryFileCodeVersion, run.deliveryEventCodeVersion, run.lastCheckCodeVersion];
  return {
    mode: required ? 'run' : 'synthetic',
    required,
    taskMatches: task.matches,
    deliveryManifestPresent: run.deliveryFilePresent,
    deliveryArchiveMatches:
      run.deliveryFileArchiveSha256 === null ? null : run.deliveryFileArchiveSha256 === run.archiveSha256,
    deliveryEventArchiveMatches:
      run.deliveryEventArchiveSha256 === null ? null : run.deliveryEventArchiveSha256 === run.archiveSha256,
    lastCheckArchiveMatches:
      run.lastCheckArchiveSha256 === null ? null : run.lastCheckArchiveSha256 === run.archiveSha256,
    codeVersion: run.codeVersion,
    deliveryCodeVersion: run.deliveryFileCodeVersion,
    deliveryEventCodeVersion: run.deliveryEventCodeVersion,
    checkCodeVersion: run.lastCheckCodeVersion,
    codeVersionMatchesCheck: versions.some((version) => version === null) ? null : new Set(versions).size === 1,
    issues: required ? provenanceIssues(run, task) : [],
  };
}

function integrityCheck(integrity: IntegrityView): ConformanceCheck {
  const detail =
    integrity.issues.length === 0
      ? 'run provenance 完整：delivery.json / delivery 事件 / 最后一条 check.result 与存档 sha、codeVersion 一致，build-task.md 与 run.start.task.sha256 一致。'
      : `run provenance 不完整：${integrity.issues.join('；')}。`;
  return {
    id: 'provenance.integrity',
    status: integrity.issues.length === 0 ? 'pass' : 'fail',
    severity: 'hard',
    detail,
    expected:
      'delivery.json / delivery 事件 / 最后一条 check.result 的 archive sha 与 codeVersion 均绑定存档；build-task.md 与 run.start.task.sha256 一致',
    actual: integrity,
    evidence: [],
  };
}

function buildReport(
  specPath: string,
  spec: Spec,
  specSha: string,
  run: RunBundle,
  evaluation: RoofEvaluation,
  openings: OpeningsEvaluation,
  task: TaskInfo,
  requireProvenance: boolean,
): ConformanceReport {
  const integrity = integrityView(run, task, requireProvenance);
  const checks: readonly ConformanceCheck[] = requireProvenance
    ? [...evaluation.checks, ...openings.checks, integrityCheck(integrity)]
    : [...evaluation.checks, ...openings.checks];
  const summary = summarize(checks);
  const blocking = summary.blockingFailures > 0 || summary.blockingUnverified > 0;
  return {
    schemaVersion: 1,
    // ok 仅服务 CLI 退出码；soft unverified 不会让它变 false，消费者须用 blocking 当门。
    ok: !blocking,
    blocking,
    fullyVerified: checks.every((check) => check.status === 'pass'),
    spec: {
      path: specPath,
      sha256: specSha,
      schemeId: spec.schemeId,
      schemeRevision: spec.schemeRevision,
      roof: {
        form: spec.roof.form,
        material: spec.roof.material,
        pitchDegrees: spec.roof.pitchDegrees,
        eaveHeight: spec.roof.eaveHeight,
        ridgeHeight: spec.roof.ridgeHeight,
        overhang: spec.roof.overhang,
        materialBlocks: materialBlocks(spec),
      },
      openings: spec.openings.map((opening) => ({
        id: opening.id,
        kind: opening.kind,
        side: opening.side,
        host: opening.host,
        level: opening.level,
        bounds: opening.bounds,
        width: opening.width,
        height: opening.height,
        sillHeight: opening.sillHeight,
        headHeight: opening.headHeight,
        fill: opening.fill,
        frameMaterial: opening.frameMaterial,
      })),
    },
    actual: {
      archivePath: run.archivePath,
      archiveSha256: run.archiveSha256,
      archiveBytes: run.archiveBytes,
      codeVersion: run.codeVersion,
      cells: run.grid.size,
      bounds: run.grid.bounds() ?? null,
      roof: evaluation.actual,
      openings: openings.actual,
    },
    checks,
    provenance: {
      specPath,
      specSha256: specSha,
      taskPath: task.path,
      taskSha256: task.sha256,
      runDir: run.runDir,
      codeVersion: run.codeVersion,
      deliveryHash: run.deliveryHash,
      deliveryArchiveSha256: run.deliveryArchiveSha256,
      deliveryCodeSha256: run.deliveryCodeSha256,
      archive: { path: run.archivePath, sha256: run.archiveSha256, bytes: run.archiveBytes },
      events: {
        path: run.eventsPath,
        lineCount: run.eventsLineCount,
        runStartLine: run.runStartLine,
        deliveryLine: run.deliveryLine,
        lastCheckResultLine: run.lastCheckResultLine,
        archiveCheckResultLine: run.archiveCheckResultLine,
        runStartTaskSha256: run.runStartTaskSha256,
        deliveryArchiveSha256: run.deliveryEventArchiveSha256,
        lastCheckArchiveSha256: run.lastCheckArchiveSha256,
        lastCheckCodeVersion: run.lastCheckCodeVersion,
      },
      integrity,
    },
    summary,
  };
}

export function runDesignConformance(argv: readonly string[], deps: ConformanceDeps = {}): number {
  const io: ConformanceIo = deps.io ?? {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
  try {
    const options = parseDesignConformanceArgs(argv);
    if (options.help) {
      io.stdout(DESIGN_CONFORMANCE_USAGE);
      return 0;
    }
    const sessionDir = options.sessionDir === null ? null : resolve(options.sessionDir);
    const specPath = options.specPath === null ? join(sessionDir ?? '', 'build-spec.json') : resolve(options.specPath);
    const spec = loadSpec(specPath);
    const run = loadRun(options.runDir);
    const task = taskInfo(sessionDir, options.specPath !== null, run.runStartTaskSha256);
    const report = buildReport(
      specPath,
      spec.spec,
      spec.sha256,
      run,
      evaluateRoof(spec.spec, run.grid),
      evaluateOpenings(spec.spec, run.grid),
      task,
      options.specPath === null,
    );
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outPath !== null) {
      try {
        writeFileSync(resolve(options.outPath), json, 'utf8');
      } catch (error) {
        throw new ConformanceError(
          `写不到 ${options.outPath}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    io.stdout(json.trimEnd());
    return report.ok ? 0 : 1;
  } catch (error) {
    io.stderr(`design-conformance: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

export function main(argv: readonly string[], deps: ConformanceDeps = {}): number {
  return runDesignConformance(argv, deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
