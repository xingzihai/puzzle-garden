/** 分层登记、来源、跨构件冲突索引与覆盖报告；不决定构件形状，不做 I/O。每次 commit 是一个完整调用。 */
import { isAir, parseState } from '@pg/core/block-state';
import type { BlockState, BlockTable } from '@pg/core/block-state';
import { checkCoord } from '@pg/core/coord';
import { createGrid } from '@pg/core/grid';
import type { Cell, Grid } from '@pg/core/grid';
import { parse, writeLayerSchema, mirrorSchema } from './schema.ts';
import type { WriteLayer, Footprint } from './schema.ts';
import type { z } from 'zod';
import { mirrorWrites } from './mirror.ts';
import { findConflict } from './collision.ts';
import type { ConflictContext, PriorEntry, RoofTop, WriteRole } from './collision.ts';

export interface Write {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly state: BlockState;
  readonly writeLayer: WriteLayer;
  /** 跨构件冲突判定用的角色；缺省 body。 */
  readonly role?: WriteRole;
  /** 本次调用 parts 列表的下标（草模导入按文档部件分组用）；缺省归当前 world.part 作用域。 */
  readonly part?: number;
}
export interface Overlap {
  readonly kind: 'same-layer' | 'cross-layer';
  readonly winner: number;
  readonly loser: number;
  readonly cells: number;
  /**
   * 仅 cross-layer 项：败方是手写 `set` / `box` 写在装饰层的实体格、合成后被盖掉的格数（决策 #92）。
   * `lostDecor = 0` 时省略，保持旧报告逐字不变。胜方是空气（开洞）也算被盖：玻璃被洞挖掉同样是丢失。
   */
  readonly lostDecor?: number;
  /** 仅 cross-layer 且 `lostDecor > 0`：这些格里按 y、z、x 最小的一格坐标 (x, y, z)。 */
  readonly sample?: readonly [number, number, number];
  /** 与 sample 同一格的真实状态与来源；仅 cross-layer 且 lostDecor > 0。 */
  readonly sampleDetail?: OverlapSampleDetail;
}
export interface OverlapSource {
  readonly api: string;
  /** 0 表示未知；分组时不能合并不同的未知调用。 */
  readonly line: number;
  readonly writeLayer: WriteLayer;
}
export interface OverlapSampleDetail {
  readonly expectedState: string;
  readonly actualState: string;
  readonly winnerSource: OverlapSource;
  readonly loserSource: OverlapSource;
}
export interface OverlapGroup {
  readonly winner: number;
  readonly loser: number;
  readonly cells: number;
  readonly sample: readonly [number, number, number];
  readonly sampleDetail: OverlapSampleDetail;
}
export interface OverlapSummary {
  readonly sameLayer: number;
  readonly crossLayer: number;
  /** 与旧 lostDecor 相同，包含同状态覆盖，不表示材质变化格数。 */
  readonly lostDecor: number;
  readonly groups: readonly OverlapGroup[];
  readonly groupsOmitted: number;
}
export interface Composition {
  readonly grid: Grid;
  readonly overlaps: readonly Overlap[];
  readonly overlapSummary: OverlapSummary;
}
/** commit 的构件级上下文（writer 补上 api，并把平屋面顶面展开成镜像反射副本）。 */
export type CommitContext = Omit<ConflictContext, 'api' | 'roofTops'> & {
  /** 本次调用自己的平屋面顶面（镜像前的坐标）；writer 会补上反射副本。 */
  readonly roofTop?: RoofTop;
  /** 本次调用的部件名（按文档序）；Write.part 是这里的下标，父部件取提交时的 world.part 作用域。 */
  readonly parts?: readonly string[];
};

interface IndexedCell extends Cell {
  readonly api: string;
  readonly role: WriteRole;
  readonly writeLayer: WriteLayer;
}
interface CallMeta {
  readonly roofTops?: readonly RoofTop[];
  readonly stairToY?: number;
  readonly stepsLength?: number;
  /** walls 的内部占地；stair 报合法 at 范围时扣掉墙圈（N6）。 */
  readonly inner?: Footprint;
}
/** 空格共用的空冲突索引，避免逐格分配。 */
const EMPTY_ENTRIES: readonly PriorEntry[] = Object.freeze([]);

function key(x: number, y: number, z: number): string {
  return `${String(x)},${String(y)},${String(z)}`;
}

/**
 * 平屋面顶面轮廓的镜像副本：`roofPlan` 的 `top.footprint` 始终是矩形（`expand` / `rect` 的产物），
 * 直接翻 min/max；反射公式与 `mirrorWrites` 一致（`2·at − 坐标`，at 可为半格）。
 */
function reflectRoofRect(f: Footprint, axis: 'x' | 'z', at: number): Footprint {
  return Object.freeze(
    axis === 'x'
      ? { minX: 2 * at - f.maxX, minZ: f.minZ, maxX: 2 * at - f.minX, maxZ: f.maxZ }
      : { minX: f.minX, minZ: 2 * at - f.maxZ, maxX: f.maxX, maxZ: 2 * at - f.minZ },
  );
}

function count(map: Map<string, Overlap>, kind: Overlap['kind'], winner: number, loser: number): string | undefined {
  if (winner === loser) return undefined;
  const id = `${kind}:${String(winner)}:${String(loser)}`;
  map.set(id, { kind, winner, loser, cells: (map.get(id)?.cells ?? 0) + 1 });
  return id;
}

/** 手写装饰被盖的样例格：按 y、z、x 升序取最小的一格。 */
function minPoint(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): readonly [number, number, number] {
  if (a[1] !== b[1]) return a[1] < b[1] ? a : b;
  if (a[2] !== b[2]) return a[2] < b[2] ? a : b;
  return a[0] <= b[0] ? a : b;
}

/** 按真实格的双方来源聚合，不能从胜败调用对样例反推整对的写入层。 */
function addOverlapGroup(groups: Map<string, OverlapGroup>, candidate: OverlapGroup): void {
  const sourceKey = (s: OverlapSource, id: number): readonly (string | number)[] => [
    s.api,
    s.line,
    s.writeLayer,
    ...(s.line === 0 ? [id] : []),
  ];
  const key = JSON.stringify([
    sourceKey(candidate.sampleDetail.winnerSource, candidate.winner),
    sourceKey(candidate.sampleDetail.loserSource, candidate.loser),
  ]);
  const previous = groups.get(key);
  if (previous === undefined) groups.set(key, candidate);
  else {
    const equal = previous.sample.every((v, i) => v === candidate.sample[i]);
    const takeCandidate = equal
      ? candidate.winner < previous.winner || (candidate.winner === previous.winner && candidate.loser < previous.loser)
      : minPoint(previous.sample, candidate.sample) === candidate.sample;
    groups.set(key, { ...(takeCandidate ? candidate : previous), cells: previous.cells + candidate.cells });
  }
}

/** 分类计数取完整条目，来源组取逐格登记结果；输出只保留三组代表项。 */
function summarizeOverlaps(overlaps: readonly Overlap[], groups: ReadonlyMap<string, OverlapGroup>): OverlapSummary {
  const sameLayer = overlaps.filter((o) => o.kind === 'same-layer').length;
  const sorted = [...groups.values()].sort(
    (a, b) =>
      b.cells - a.cells ||
      a.winner - b.winner ||
      a.loser - b.loser ||
      a.sample[1] - b.sample[1] ||
      a.sample[2] - b.sample[2] ||
      a.sample[0] - b.sample[0],
  );
  return {
    sameLayer,
    crossLayer: overlaps.length - sameLayer,
    lostDecor: overlaps.reduce((sum, o) => sum + (o.lostDecor ?? 0), 0),
    groups: sorted.slice(0, 3),
    groupsOmitted: Math.max(0, sorted.length - 3),
  };
}

export class Writer {
  readonly #table: BlockTable;
  readonly #records: Grid;
  /** 成功登记调用时取源码行号；宿主注入，geometry 自己不读堆栈（GEOMETRY-SPEC §1）。缺省恒为 0。 */
  readonly #callSite: () => number;
  readonly #layers: Record<WriteLayer, Map<string, IndexedCell>> = {
    decoration: new Map(),
    structure: new Map(),
    opening: new Map(),
  };
  readonly #overlaps = new Map<string, Overlap>();
  /** 调用级元数据：R2 平屋面放行需要 roofTop，stair / steps 报错需要 to 与长度。 */
  readonly #callMeta = new Map<number, CallMeta>();
  #part = 0;
  /** 是否登记过任何非 body 角色（stair / steps / opening）。全 body 之间没有冲突规则，可直接跳过检查。 */
  #hasProtected = false;
  readonly #mirrors: z.output<typeof mirrorSchema>[] = [];

  constructor(table: BlockTable, callSite?: () => number) {
    this.#table = table;
    this.#callSite = callSite ?? ((): number => 0);
    this.#records = createGrid(table);
  }

  material(text: string, solid = false): BlockState {
    const state = parseState(this.#table, text);
    if (solid && isAir(state)) throw new Error(`material=${text} 不合法：结构材质不能是空气`);
    return state;
  }

  /** 当前镜像作用域下，一组格实际会落在哪些坐标（含反射副本）。不登记任何东西。 */
  reflect<T extends { readonly x: number; readonly y: number; readonly z: number }>(cells: readonly T[]): T[] {
    let result = [...cells];
    // at 可为整数或半格：2*m.at - c 仍是整数，与 mirrorWrites 用同一反射公式。
    for (const m of this.#mirrors)
      result = [...result, ...result.map((c) => ({ ...c, [m.axis]: 2 * m.at - c[m.axis] }))];
    return result;
  }

  /** 把本次调用的平屋面顶面展开成当前镜像栈下的全部世界坐标副本（与 mirrorWrites 同步）。 */
  #reflectRoofTops(top: RoofTop): readonly RoofTop[] {
    let result: readonly RoofTop[] = [top];
    for (const m of this.#mirrors)
      result = [...result, ...result.map((t) => ({ y: t.y, footprint: reflectRoofRect(t.footprint, m.axis, m.at) }))];
    return result;
  }

  #entriesAt(x: number, y: number, z: number): readonly PriorEntry[] {
    const id = key(x, y, z);
    // 快路径：绝大多数新格此前为空，避免每次 commit 逐格分配空数组（性能基准敏感）。
    if (!this.#layers.opening.has(id) && !this.#layers.structure.has(id) && !this.#layers.decoration.has(id))
      return EMPTY_ENTRIES;
    const out: PriorEntry[] = [];
    for (const layer of ['opening', 'structure', 'decoration'] as const) {
      const cell = this.#layers[layer].get(id);
      if (cell === undefined) continue;
      const meta = this.#callMeta.get(cell.call);
      out.push({
        call: cell.call,
        api: cell.api,
        role: cell.role,
        x,
        y,
        z,
        ...(meta?.roofTops === undefined ? {} : { roofTops: meta.roofTops }),
        ...(meta?.stairToY === undefined ? {} : { stairToY: meta.stairToY }),
        ...(meta?.stepsLength === undefined ? {} : { stepsLength: meta.stepsLength }),
        ...(meta?.inner === undefined ? {} : { inner: meta.inner }),
      });
    }
    return out;
  }

  /** 镜像副本与原侧重叠：只对 stair / steps 的全部写入与 opening 的 hole 检查（R7）。 */
  #checkMirrorOverlap(api: string, original: readonly Write[]): void {
    if (this.#mirrors.length === 0) return;
    // R7 只针对 stair / steps 的全部写入与 opening 的 hole；set / box / 其他构件跨轴取并集不变。
    if (api !== 'stair' && api !== 'steps' && api !== 'opening') return;
    const relevant = (w: Write): boolean => (api === 'opening' ? w.role === 'hole' : true);
    const cells = new Set(original.filter(relevant).map((w) => key(w.x, w.y, w.z)));
    for (const m of this.#mirrors) {
      for (const w of original) {
        if (!relevant(w)) continue;
        const rx = m.axis === 'x' ? 2 * m.at - w.x : w.x;
        const rz = m.axis === 'z' ? 2 * m.at - w.z : w.z;
        if (cells.has(key(rx, w.y, rz)))
          throw new Error(
            `镜像轴 ${m.axis}=${String(m.at)} 穿过本构件，副本与原侧在 (${String(rx)}, ${String(w.y)}, ${String(rz)}) 重叠。`,
          );
      }
    }
  }

  commit(api: string, args: unknown, writes: readonly Write[], context: CommitContext = {}): number {
    const original = writes;
    writes = mirrorWrites(this.#table, writes, this.#mirrors);
    // 先校验整次调用，越界时不会留下前半栋建筑。
    for (const w of writes) {
      checkCoord(w.x, w.y, w.z);
      parse(writeLayerSchema, w.writeLayer);
    }
    this.#checkMirrorOverlap(api, original);
    // roofTop 是镜像前的坐标，而冲突检查读的是各写入的世界坐标，必须展开成全部反射副本再比对。
    const { roofTop, ...rest } = context;
    const roofTops = roofTop === undefined ? undefined : this.#reflectRoofTops(roofTop);
    // 只有 stair / steps / opening 会产生非 body 角色；其余构件之间没有冲突规则。
    const newProtected = api === 'stair' || api === 'steps' || api === 'opening';
    // 手写原语 set / box 不参与跨构件冲突（2026-10-04 起），直接跳过检查。
    const skipConflict = api === 'set' || api === 'box';
    if (!skipConflict && (this.#hasProtected || newProtected)) {
      const pending = writes.map((w) => ({
        x: w.x,
        y: w.y,
        z: w.z,
        ...(w.role === undefined ? {} : { role: w.role }),
      }));
      const conflict = findConflict(
        { api, ...rest, ...(roofTops === undefined ? {} : { roofTops }) },
        pending,
        (x, y, z) => this.#entriesAt(x, y, z),
      );
      if (conflict !== undefined) throw new Error(conflict.message);
    }
    // 校验与冲突检查都通过后才登记：失败调用不留下写入。
    if (context.parts === undefined && writes.some((w) => w.part !== undefined))
      throw new Error('写入带部件序号时必须在提交上下文里给出 parts 列表');
    if (context.parts !== undefined)
      for (const w of writes)
        if (w.part !== undefined && (!Number.isSafeInteger(w.part) || w.part < 0 || w.part >= context.parts.length))
          throw new Error(`写入的部件序号 ${String(w.part)} 不在本次调用的 parts 列表内`);
    const line = this.#callSite();
    if (!Number.isSafeInteger(line) || line < 0) {
      throw new Error(`callSite 必须返回非负整数作为源码行号，实际是 ${String(line)}`);
    }
    // 部件定义放在校验与冲突检查之后：提交失败不留孤儿部件，成功的导入部件按文档序一次定义。
    const partIds = context.parts?.map((name) => this.#records.definePart(name, this.#part));
    const call = this.#records.defineCall(api, line, args);
    this.#callMeta.set(call, {
      ...(roofTops === undefined ? {} : { roofTops }),
      ...(context.stairToY === undefined ? {} : { stairToY: context.stairToY }),
      ...(context.stepsLength === undefined ? {} : { stepsLength: context.stepsLength }),
      ...(context.inner === undefined ? {} : { inner: context.inner }),
    });
    for (const w of writes) {
      const layer = this.#layers[w.writeLayer];
      const id = key(w.x, w.y, w.z);
      const previous = layer.get(id);
      if (previous !== undefined) count(this.#overlaps, 'same-layer', call, previous.call);
      const role = w.role ?? 'body';
      if (role !== 'body') this.#hasProtected = true;
      let part = this.#part;
      if (w.part !== undefined) {
        const resolved = partIds?.[w.part];
        if (resolved === undefined) throw new Error(`写入的部件序号 ${String(w.part)} 不在本次调用的 parts 列表内`);
        part = resolved;
      }
      layer.set(id, {
        x: w.x,
        y: w.y,
        z: w.z,
        state: w.state,
        call,
        part: isAir(w.state) ? 0 : part,
        api,
        role,
        writeLayer: w.writeLayer,
      });
    }
    return call;
  }

  /** 当前镜像栈快照；世界在句柄创建时记录，作为锚点使用时校验（R9）。 */
  mirrorScope(): readonly z.output<typeof mirrorSchema>[] {
    return [...this.#mirrors];
  }

  mirror(options: z.input<typeof mirrorSchema>, fn: () => void): void {
    this.#mirrors.push(parse(mirrorSchema, options));
    try {
      fn();
    } finally {
      this.#mirrors.pop();
    }
  }

  part(name: string, fn: () => void): void {
    const parent = this.#part;
    this.#part = this.#records.definePart(name, parent);
    try {
      fn();
    } finally {
      this.#part = parent;
    }
  }

  /** 合成后这一格挡人：结构层有实体，且开洞层没有把它挖成空气。供铺装寻路用，不登记任何东西。 */
  solidAt(x: number, y: number, z: number): boolean {
    const id = key(x, y, z);
    const opening = this.#layers.opening.get(id);
    if (opening !== undefined) return !isAir(opening.state);
    const structure = this.#layers.structure.get(id);
    return structure !== undefined && !isAir(structure.state);
  }

  /** P2：这一格是否已由 opening 登记为门框 / 门外净空；铺装写入时跳过，避免盖掉门框与通道。 */
  openingClearanceAt(x: number, y: number, z: number): boolean {
    const id = key(x, y, z);
    for (const layer of ['decoration', 'opening'] as const) {
      const cell = this.#layers[layer].get(id);
      if (cell?.api === 'opening' && (cell.role === 'frame' || cell.role === 'outside')) return true;
    }
    return false;
  }

  /** R6：这一格是否由 stair 写了实体梯级或背板；返回角色供报错区分。不登记任何东西。 */
  stairSolidAt(x: number, y: number, z: number): 'tread' | 'back' | undefined {
    const id = key(x, y, z);
    for (const layer of ['opening', 'structure'] as const) {
      const cell = this.#layers[layer].get(id);
      if (cell?.api === 'stair' && (cell.role === 'tread' || cell.role === 'back') && !isAir(cell.state))
        return cell.role;
    }
    return undefined;
  }

  get(x: number, y: number, z: number): string {
    checkCoord(x, y, z);
    const id = key(x, y, z);
    const cell = this.#layers.opening.get(id) ?? this.#layers.structure.get(id) ?? this.#layers.decoration.get(id);
    return cell?.state.canonical ?? 'air';
  }

  compose(): Composition {
    const grid = createGrid(this.#table);
    grid.restoreTables(this.#records.parts(), this.#records.calls());
    const overlaps = new Map(this.#overlaps);
    const winners = new Map<string, IndexedCell>();
    const groups = new Map<string, OverlapGroup>();
    const calls = new Map(this.#records.calls().map((c) => [c.id, c]));
    const source = (cell: IndexedCell): OverlapSource => {
      const call = calls.get(cell.call);
      if (call === undefined) throw new Error(`覆盖来源调用 ${String(cell.call)} 未登记`);
      return { api: call.api, line: call.line, writeLayer: cell.writeLayer };
    };
    // 手写装饰被盖（决策 #92）：只对 cross-layer 项累计，key 与 count 的 id 相同。
    const lostDecor = new Map<
      string,
      {
        readonly lost: number;
        readonly sample: readonly [number, number, number];
        readonly detail: OverlapSampleDetail;
      }
    >();
    for (const layer of [this.#layers.opening, this.#layers.structure, this.#layers.decoration]) {
      const isDecoration = layer === this.#layers.decoration;
      for (const [id, cell] of layer) {
        const winner = winners.get(id);
        if (winner === undefined) {
          winners.set(id, cell);
          continue;
        }
        const overlapId = count(overlaps, 'cross-layer', winner.call, cell.call);
        // 性能：只在跨层败方分支里判断，不额外遍历。败方是装饰层的 set / box 实体格才算手写装饰。
        if (overlapId === undefined || !isDecoration) continue;
        if ((cell.api !== 'set' && cell.api !== 'box') || isAir(cell.state)) continue;
        const point: readonly [number, number, number] = [cell.x, cell.y, cell.z];
        const previous = lostDecor.get(overlapId);
        const takeCurrent = previous === undefined || minPoint(previous.sample, point) === point;
        const detail: OverlapSampleDetail = {
          expectedState: cell.state.canonical,
          actualState: winner.state.canonical,
          winnerSource: source(winner),
          loserSource: source(cell),
        };
        addOverlapGroup(groups, {
          winner: winner.call,
          loser: cell.call,
          cells: 1,
          sample: point,
          sampleDetail: detail,
        });
        lostDecor.set(overlapId, {
          lost: (previous?.lost ?? 0) + 1,
          sample: takeCurrent ? point : previous.sample,
          detail: takeCurrent ? detail : previous.detail,
        });
      }
    }
    for (const c of winners.values()) grid.set(c.x, c.y, c.z, c.state, c.part, c.call);
    const items = [...overlaps.values()].map((o): Overlap => {
      if (o.kind !== 'cross-layer') return o;
      const lost = lostDecor.get(`${o.kind}:${String(o.winner)}:${String(o.loser)}`);
      return lost === undefined ? o : { ...o, lostDecor: lost.lost, sample: lost.sample, sampleDetail: lost.detail };
    });
    return {
      grid,
      overlapSummary: summarizeOverlaps(items, groups),
      overlaps: items.sort(
        (a, b) => a.winner - b.winner || a.loser - b.loser || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
      ),
    };
  }
}
