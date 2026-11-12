/**
 * 跨构件写入冲突判定（GEOMETRY-SPEC §1 跨构件冲突）。
 *
 * 负责：按写入角色与来源构件判断一对重叠写入是否合法、聚集冲突格并生成报错文案。
 * 不负责：维护格索引、镜像坐标、生成几何或登记调用；这些由 writer 与各构件计划完成。
 *
 * 判定是无序的：新写入与既有格谁先谁后都返回同一结果，因此合法性与调用顺序无关（R1 对称）。
 * 报错主语始终是新调用（`context.api`）；受保护角色在对方时文案改为「新调用盖到了此前 …」。
 *
 * 2026-10-04 起：任一侧是手写原语 `set` / `box` 的写入对一律不算冲突，与 v0.2 一样按三层合成
 * 规则后写覆盖（opening > structure > decoration，同层后写覆盖）；构件与构件之间的冲突照旧报错。
 */
import type { Footprint } from './schema.ts';
import { contains } from './footprint.ts';

/** 写入角色。tread 同时用于 stair 与 steps，靠 api 区分；其余构件缺省 body。 */
export type WriteRole = 'body' | 'tread' | 'back' | 'head' | 'support' | 'hole' | 'outside' | 'frame' | 'canopy';

/** 平屋面的可承托顶面；坡屋面没有 top，不参与 stair 的放行。 */
export interface RoofTop {
  readonly y: number;
  readonly footprint: Footprint;
}

/** 一条待判定写入（新调用，尚未登记）；role 缺省按 body。 */
export interface NewWrite {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly role?: WriteRole;
}

/** 索引里已有的一条写入（含来源调用与调用级元数据）。 */
export interface PriorEntry {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly role: WriteRole;
  readonly call: number;
  readonly api: string;
  /** 平屋面顶面，含本次调用在各镜像轴下的全部反射副本（世界坐标）。 */
  readonly roofTops?: readonly RoofTop[];
  readonly stairToY?: number;
  readonly stepsLength?: number;
  /** walls 的内部占地；stair 报合法 at 范围时用来扣掉墙圈。 */
  readonly inner?: Footprint;
}

/** 共同占地 / 内部占地的矩形形式。 */
export interface FitRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** 整条楼梯路线相对 at 的偏移包围盒。 */
export interface OffsetBounds {
  readonly dx0: number;
  readonly dx1: number;
  readonly dz0: number;
  readonly dz1: number;
}

/** 本次 commit 的构件级信息；判定需要的语义（to、host、range）都在这里。 */
export interface ConflictContext {
  readonly api: string;
  /** 本次调用自己的平屋面顶面，含镜像反射副本（世界坐标）。 */
  readonly roofTops?: readonly RoofTop[];
  readonly stairToY?: number;
  readonly stepsLength?: number;
  /** opening 只能擦碰自己所属的宿主调用（墙 / 台基 / 院墙）。 */
  readonly host?: number;
  /** stair 的 from/to 共同占地，配合 stairOffsets 算合法 at 范围（R11 / N6）。 */
  readonly stairCommon?: FitRect;
  /** stair 整条路线的偏移包围盒。 */
  readonly stairOffsets?: OffsetBounds;
  /** opening 的雨棚深度，用于报错里建议的 depth 上限。 */
  readonly canopyDepth?: number;
  /** opening 所属墙底 y；高窗撞屋面时把 sill 换算成相对值。 */
  readonly openingBaseY?: number;
  /** walls 新调用的内部占地（对称判定时作障碍侧使用）。 */
  readonly inner?: Footprint;
}

export interface Conflict {
  readonly message: string;
}

type Kind =
  | 'stair-roof'
  | 'stair-structure'
  | 'stair-circulation'
  | 'steps-structure'
  | 'opening-hole-overlap'
  | 'opening-hole-body'
  | 'opening-outside';

interface Reason {
  readonly kind: Kind;
  readonly role: WriteRole;
  readonly protectedApi: string;
  readonly protectedCall: number;
  readonly obstacleApi: string;
  readonly obstacleCall: number;
  readonly obstacleInner?: Footprint;
  /** true：受保护的一侧是新调用；false：新调用是障碍，文案以新调用为主语「盖到了此前 …」。 */
  readonly protectedIsNew: boolean;
}
type ReasonParts = Omit<Reason, 'protectedIsNew'>;

interface Side {
  readonly api: string;
  readonly role: WriteRole;
  readonly call: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly roofTops?: readonly RoofTop[];
  readonly stairToY?: number;
  readonly stepsLength?: number;
  readonly inner?: Footprint;
}

function isStair(side: Side): boolean {
  return side.api === 'stair' && (side.role === 'tread' || side.role === 'back' || side.role === 'head');
}
function isSteps(side: Side): boolean {
  return side.api === 'steps' && (side.role === 'tread' || side.role === 'support');
}

/**
 * N3：stair / steps 必须避开的实体障碍。
 * - rail 写的格算数（y ≤ 0 是地坪以下，放行）。
 * - 手写原语 set / box 不再算障碍（2026-10-04 起，后写覆盖）。
 */
function structuralObstacle(side: Side): boolean {
  if (side.y <= 0) return false;
  return side.api === 'rail';
}

const ROLE_LABEL: Record<WriteRole, string> = {
  body: '实体',
  tread: '踏面',
  back: '背板',
  head: '头顶净空',
  support: '支撑',
  hole: '洞',
  outside: '门框外净空',
  frame: '门框',
  canopy: '雨棚',
};
function label(role: WriteRole): string {
  return ROLE_LABEL[role];
}

function parts(kind: Kind, protectedSide: Side, obstacle: Side): ReasonParts {
  return {
    kind,
    role: protectedSide.role,
    protectedApi: protectedSide.api,
    protectedCall: protectedSide.call,
    obstacleApi: obstacle.api,
    obstacleCall: obstacle.call,
    ...(obstacle.inner === undefined ? {} : { obstacleInner: obstacle.inner }),
  };
}

/** stair 的 tread/back/head 撞上另一调用：floorPlate / plinth 放行，平屋面在条件内放行，其余报错。 */
function stairConflict(stair: Side, other: Side): ReasonParts | undefined {
  if (other.api === 'floorPlate' || other.api === 'plinth') return undefined;
  if (structuralObstacle(other)) return parts('stair-structure', stair, other);
  if (other.api === 'roof') {
    if (other.roofTops?.some((top) => stair.stairToY === top.y && contains(top.footprint, other.x, other.z)))
      return undefined;
    return parts('stair-roof', stair, other);
  }
  if (
    other.api === 'walls' ||
    other.api === 'colonnade' ||
    other.api === 'enclosure' ||
    other.api === 'massingImport' ||
    other.api === 'surfaceShell'
  )
    return parts('stair-structure', stair, other);
  if (other.api === 'stair' || other.api === 'steps') return parts('stair-circulation', stair, other);
  return undefined;
}

/** steps 的 tread/support：plinth、paving、opening 放行；墙体类、楼板、栏杆、其他通行构件报错。 */
function stepsConflict(steps: Side, other: Side): ReasonParts | undefined {
  if (other.api === 'plinth' || other.api === 'paving' || other.api === 'opening') return undefined;
  if (structuralObstacle(other)) return parts('steps-structure', steps, other);
  if (
    other.api === 'walls' ||
    other.api === 'colonnade' ||
    other.api === 'enclosure' ||
    other.api === 'massingImport' ||
    other.api === 'surfaceShell' ||
    other.api === 'roof' ||
    other.api === 'floorPlate' ||
    other.api === 'stair' ||
    other.api === 'steps'
  )
    return parts('steps-structure', steps, other);
  return undefined;
}

/** opening 的 outside / frame / canopy：越过宿主调用去碰任何 body 就报错；outside 与 canopy 互碰报错。 */
function openingSpecial(context: ConflictContext, side: Side, other: Side): ReasonParts | undefined {
  if (other.call !== 0 && other.call === context.host) return undefined;
  // P2：铺装在装饰层，可能落在门外一格；门框 / 门外净空与铺装重叠不算冲突，
  // 由 paving 写入时跳过已登记的 frame / outside 保证合成结果与顺序无关。
  if (other.api === 'paving') return undefined;
  if (other.api === 'opening') {
    const clash =
      (side.role === 'outside' && other.role === 'canopy') || (side.role === 'canopy' && other.role === 'outside');
    if (clash) return parts('opening-outside', side, other);
    // frame 与 frame、outside 与 outside 等重叠不额外报错，由门窗自身范围校验负责。
    return undefined;
  }
  if (other.role === 'body') return parts('opening-outside', side, other);
  return undefined;
}

/**
 * opening 的 hole：允许落在 walls / plinth / enclosure 上（重写外墙、共墙合法）；
 * 两洞重叠、以及落在 colonnade / roof / stair 上报错（D4）。
 * 其余构件（铺装、楼板、栏杆、原语等）不在这里拦截，避免把门口地砖、门前踏步判成缺陷。
 */
function holeConflict(hole: Side, other: Side): ReasonParts | undefined {
  if (other.api === 'walls' || other.api === 'plinth' || other.api === 'enclosure') return undefined;
  if (other.api === 'opening') {
    if (other.role === 'hole') return parts('opening-hole-overlap', hole, other);
    return undefined;
  }
  if (
    other.api === 'colonnade' ||
    other.api === 'roof' ||
    other.api === 'stair' ||
    other.api === 'massingImport' ||
    other.api === 'surfaceShell'
  )
    return parts('opening-hole-body', hole, other);
  return undefined;
}

function newSide(context: ConflictContext, write: NewWrite): Side {
  return {
    api: context.api,
    role: write.role ?? 'body',
    call: 0,
    x: write.x,
    y: write.y,
    z: write.z,
    ...(context.roofTops === undefined ? {} : { roofTops: context.roofTops }),
    ...(context.stairToY === undefined ? {} : { stairToY: context.stairToY }),
    ...(context.stepsLength === undefined ? {} : { stepsLength: context.stepsLength }),
    ...(context.inner === undefined ? {} : { inner: context.inner }),
  };
}

function priorSide(entry: PriorEntry): Side {
  return {
    api: entry.api,
    role: entry.role,
    call: entry.call,
    x: entry.x,
    y: entry.y,
    z: entry.z,
    ...(entry.roofTops === undefined ? {} : { roofTops: entry.roofTops }),
    ...(entry.stairToY === undefined ? {} : { stairToY: entry.stairToY }),
    ...(entry.stepsLength === undefined ? {} : { stepsLength: entry.stepsLength }),
    ...(entry.inner === undefined ? {} : { inner: entry.inner }),
  };
}

/** 无序判定一对重叠写入；合法返回 undefined，非法返回冲突原因。 */
function checkPair(context: ConflictContext, write: NewWrite, entry: PriorEntry): Reason | undefined {
  // 2026-10-04 起：任一侧是手写原语 set / box 就不算跨构件冲突，按三层合成规则后写覆盖。
  if (entry.api === 'set' || entry.api === 'box' || context.api === 'set' || context.api === 'box') return undefined;
  const n = newSide(context, write);
  const e = priorSide(entry);
  const finish = (reason: ReasonParts | undefined, protectedIsNew: boolean): Reason | undefined =>
    reason === undefined ? undefined : { ...reason, protectedIsNew };
  if (isStair(n) || isStair(e)) {
    const nIs = isStair(n);
    return finish(nIs ? stairConflict(n, e) : stairConflict(e, n), nIs);
  }
  if (isSteps(n) || isSteps(e)) {
    const nIs = isSteps(n);
    return finish(nIs ? stepsConflict(n, e) : stepsConflict(e, n), nIs);
  }
  if (n.api === 'opening' && n.role !== 'hole') return finish(openingSpecial(context, n, e), true);
  if (e.api === 'opening' && e.role !== 'hole') return finish(openingSpecial(context, e, n), false);
  if (n.api === 'opening' && n.role === 'hole') return finish(holeConflict(n, e), true);
  if (e.api === 'opening' && e.role === 'hole') return finish(holeConflict(e, n), false);
  return undefined;
}

/** 冲突格排序：y、z、x 升序，保证报错稳定且指向最靠下的一格。 */
function before(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  return a[1] < b[1] || (a[1] === b[1] && (a[2] < b[2] || (a[2] === b[2] && a[0] < b[0])));
}

function intersectRect(a: FitRect, b: FitRect): FitRect {
  return {
    minX: Math.max(a.minX, b.minX),
    minZ: Math.max(a.minZ, b.minZ),
    maxX: Math.min(a.maxX, b.maxX),
    maxZ: Math.min(a.maxZ, b.maxZ),
  };
}

/** N6：共同占地（扣掉冲突墙的内部占地）与路线偏移求出合法 at 区间。 */
function stairRange(context: ConflictContext, reason: Reason): string {
  const common = context.stairCommon;
  const o = context.stairOffsets;
  if (common === undefined || o === undefined) return '';
  const rect = reason.obstacleInner === undefined ? common : intersectRect(common, reason.obstacleInner);
  return (
    `，或把 at 向内移到 x∈[${String(rect.minX - o.dx0)}, ${String(rect.maxX - o.dx1)}]、` +
    `z∈[${String(rect.minZ - o.dz0)}, ${String(rect.maxZ - o.dz1)}]`
  );
}

const REVERSE_HINT: Record<Kind, string> = {
  'stair-roof': '请降低或移开这次调用；楼梯要上平屋面时把 to 设为该屋面的 roof.top。',
  'stair-structure': '请移开这次调用，或把楼梯的 at / from / to 改到墙内。',
  'stair-circulation': '请移开这次调用，或调整楼梯的 at / from / to 与 kind。',
  'steps-structure': '请移开这次调用，或把踏步改到入口外不被挡住的位置。',
  'opening-hole-overlap': '请合并两个 opening，或移动 at / sill。',
  'opening-hole-body': '洞只允许开在外墙、台基或院墙上。',
  'opening-outside': '请移开这次调用，或调整 opening 的 at / frame / canopy。',
};

/** 反向文案的建议也只能提此前调用真实拥有的参数（没有 frame 就不提 frame）。 */
function reverseHint(reason: Reason): string {
  if (reason.kind !== 'opening-outside') return REVERSE_HINT[reason.kind];
  if (reason.role === 'frame') return '请移开这次调用，或让 opening 去掉 frame / 把 at 移开。';
  if (reason.role === 'canopy') return '请移开这次调用，或减小 opening 的 canopy.depth / 把 at 移开。';
  return '请移开这次调用，或把 opening 的 at 移开。';
}

/** 冲突格的整数包围盒；报错里给出范围，避免模型每次只挪一格（首批运行发现）。 */
interface ConflictBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function format(
  cell: readonly [number, number, number],
  reason: Reason,
  count: number,
  context: ConflictContext,
  roofMaxY: number | undefined,
  box: ConflictBox | undefined,
): string {
  const [x, y, z] = cell;
  const at = `(${String(x)}, ${String(y)}, ${String(z)})`;
  const other = `${reason.obstacleApi}#${String(reason.obstacleCall)}`;
  // 受保护区域（反向时是此前调用的格，正向时是新调用的格）的包围盒与格数。
  const region =
    box === undefined
      ? `受保护区域共 ${String(count)} 格。`
      : `受保护区域 x∈[${String(box.minX)}, ${String(box.maxX)}]、y∈[${String(box.minY)}, ${String(box.maxY)}]、` +
        `z∈[${String(box.minZ)}, ${String(box.maxZ)}]，共 ${String(count)} 格。`;
  if (!reason.protectedIsNew) {
    const frameNote = reason.role === 'frame' || reason.role === 'outside' ? '门框凸出墙外 1 格。' : '';
    return (
      `${context.api} 盖到了此前 ${reason.protectedApi}#${String(reason.protectedCall)} 的${label(reason.role)} ${at}。` +
      `${region}${frameNote}${reverseHint(reason)}`
    );
  }
  switch (reason.kind) {
    case 'stair-roof':
      return (
        `stair 会凿穿 ${other}：${label(reason.role)} 在 ${at}，共 ${String(count)} 格。` +
        `要通到屋顶，请把 to 改成该平屋面的 roof.top；否则把楼梯放到屋面以下。${region}`
      );
    case 'stair-structure': {
      const range = stairRange(context, reason);
      if (reason.obstacleApi === 'walls' || reason.obstacleApi === 'colonnade' || reason.obstacleApi === 'enclosure')
        return `stair 占用了 ${other} 的墙体 ${at}。from/to 请用 floorPlate 的 top 而不是台基顶${range}。${region}`;
      return (
        `stair 的${label(reason.role)}在 ${at} 撞上 ${other}（共 ${String(count)} 格）。` +
        `请把 at / from / to 移开该实体${range}。${region}`
      );
    }
    case 'stair-circulation':
      return `stair 的${label(reason.role)}在 ${at} 撞上 ${other}，共 ${String(count)} 格。请调整 at、from、to 或改用其他 kind。${region}`;
    case 'steps-structure': {
      if (reason.obstacleApi === 'rail')
        return `steps 的${label(reason.role)}在 ${at} 撞上 ${other}（共 ${String(count)} 格）。请把踏步移开，或改到别的入口。${region}`;
      const length = context.stepsLength ?? 0;
      return (
        `steps 从入口外伸 ${String(length)} 格，在 ${at} 撞上 ${other}。` +
        `请把两栋的间距拉到 ≥ ${String(length + 1)} 格，或降低入口高度。${region}`
      );
    }
    case 'opening-hole-overlap':
      return `opening 的洞在 ${at} 与另一洞重叠。请合并两个 opening，或移动 at / sill。${region}`;
    case 'opening-hole-body': {
      if (reason.obstacleApi === 'roof' && roofMaxY !== undefined && context.openingBaseY !== undefined) {
        const n = roofMaxY - context.openingBaseY + 1;
        return `opening 的洞在 ${at} 撞上 ${other}；把 sill 提到 ≥ ${String(n)} 或减小 height。${region}`;
      }
      return `opening 的洞在 ${at} 落进 ${other}。洞只允许开在外墙、台基或院墙上，请检查 in 指向的立面。${region}`;
    }
    case 'opening-outside': {
      const advice: string[] = [];
      if (reason.role === 'frame') advice.push('去掉 frame 或把 at 移开');
      else if (reason.role === 'canopy') advice.push(`把 canopy.depth 减到 ≤ ${String(context.canopyDepth ?? 1)}`);
      else advice.push('把 at 移开');
      if (reason.role !== 'canopy' && context.canopyDepth !== undefined)
        advice.push(`或把 canopy.depth 减到 ≤ ${String(context.canopyDepth)}`);
      return `opening 的${label(reason.role)}在 ${at} 伸进 ${other}。请${advice.join('，')}。${region}`;
    }
  }
}

/**
 * 聚集整次调用的冲突：返回按 y、z、x 排序的一格与冲突格总数；没有冲突返回 undefined。
 * `lookup` 取某一格已有的全部层写入。
 */
export function findConflict(
  context: ConflictContext,
  writes: readonly NewWrite[],
  lookup: (x: number, y: number, z: number) => readonly PriorEntry[],
): Conflict | undefined {
  let min: readonly [number, number, number] | undefined;
  let minReason: Reason | undefined;
  let box: ConflictBox | undefined;
  const cells = new Set<string>();
  const roofMax = new Map<number, number>();
  for (const w of writes) {
    for (const entry of lookup(w.x, w.y, w.z)) {
      const reason = checkPair(context, w, entry);
      if (reason === undefined) continue;
      const cell: readonly [number, number, number] = [w.x, w.y, w.z];
      box =
        box === undefined
          ? { minX: w.x, maxX: w.x, minY: w.y, maxY: w.y, minZ: w.z, maxZ: w.z }
          : {
              minX: Math.min(box.minX, w.x),
              maxX: Math.max(box.maxX, w.x),
              minY: Math.min(box.minY, w.y),
              maxY: Math.max(box.maxY, w.y),
              minZ: Math.min(box.minZ, w.z),
              maxZ: Math.max(box.maxZ, w.z),
            };
      cells.add(`${String(w.x)},${String(w.y)},${String(w.z)}`);
      if (reason.kind === 'opening-hole-body' && reason.obstacleApi === 'roof')
        roofMax.set(
          reason.obstacleCall,
          Math.max(roofMax.get(reason.obstacleCall) ?? Number.NEGATIVE_INFINITY, entry.y),
        );
      if (min === undefined || before(cell, min)) {
        min = cell;
        minReason = reason;
      }
    }
  }
  if (min === undefined || minReason === undefined) return undefined;
  return {
    message: format(min, minReason, cells.size, context, roofMax.get(minReason.obstacleCall), box),
  };
}
