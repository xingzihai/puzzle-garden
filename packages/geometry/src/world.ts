/** 世界的基础构件与锚点关系；宿主合成在闭包外单独暴露，不提供模型执行或 I/O。 */
import { isAir, type BlockTable } from '@pg/core/block-state';
import {
  parse,
  plinthSchema,
  wallsSchema,
  openingSchema,
  pointSchema,
  sideSchema,
  surfaceSchema,
  writeLayerSchema,
  floorPlateSchema,
  stairSchema,
  stepsSchema,
  roofSchema,
  colonnadeSchema,
  railSchema,
  enclosureSchema,
  pavingSchema,
} from './schema.ts';
import type { Surface, Facade, Side } from './schema.ts';
import { bounds, expand, boxWrites, openingWrites, type OpeningSpan } from './shapes.ts';
import { Writer } from './writer.ts';
import { createMassingImport, type WorldOptions } from './massing-import.ts';
import { createSurfaceShell } from './shell.ts';
import { stairPlan, stepsPlan, thresholdScan, doorBlockedError, commonFootprint } from './circulation.ts';
import type { DoorRecord, StairSolid } from './circulation.ts';
import { roofPlan } from './roof.ts';
import { colonnadePlan, railPlan, enclosurePlan, pavingPlan } from './site.ts';
import type { RailKeepOut } from './site.ts';
import { wallsPlan } from './walls.ts';
import { contains, projected, polygonFootprint } from './footprint.ts';
import { HandleScopes } from './scope.ts';
import type {
  OpeningHandle,
  FacadeHandle,
  EnclosureHandle,
  World,
  WorldHost,
  SurfaceReference,
} from './world-types.ts';
export type {
  OpeningHandle,
  FacadeHandle,
  PlinthHandle,
  WallsHandle,
  FloorPlateHandle,
  StairHandle,
  RoofHandle,
  ColonnadeHandle,
  EnclosureHandle,
  SurfaceShellHandle,
  World,
  WorldHost,
  SurfaceReference,
} from './world-types.ts';

/** `options.callSite`：成功登记一次调用时取一次源码行号；`options.massing`：宿主注入的草模资产（§5.2）。 */
export function createWorld(table: BlockTable, options: WorldOptions = {}): WorldHost {
  const writer = new Writer(table, options.callSite);
  const surfaces = new WeakSet<object>();
  const facades = new WeakMap<FacadeHandle, OpeningHandle[]>();
  /** 每个立面已成功登记的洞范围：越界报错时回报给模型（按 at 排序）。 */
  const openingSpans = new WeakMap<FacadeHandle, OpeningSpan[]>();
  const entrances = new WeakSet<object>();
  const edges = new WeakSet<object>();
  const scopes = new HandleScopes();
  /** 台基的 top 是承托轮廓（外墙挂在这里）；栏杆要沿外挑后的实际外缘走（审查 A2）。 */
  const outerEdges = new WeakMap<Surface, Surface>();
  /** 外墙的 top → 墙顶材质与墙厚，屋面封山墙时用作缺省（决策 #63）。 */
  const wallTops = new WeakMap<Surface, { readonly material: string; readonly thickness: number }>();
  /** 栏杆要让开的格：已登记的踏步落点与门洞（决策 #60：栏杆按调用顺序留口）。 */
  const railKeepOut: RailKeepOut[] = [];
  /** 已写的栏杆格（x,y,z），踏步建在栏杆之后时用来报错。 */
  const railCells = new Set<string>();
  /** 已存在、未填充的门 / 院门，楼梯与开洞互相做 R6 堵门检查。 */
  const doors: DoorRecord[] = [];
  /** 作为锚点使用前检查镜像作用域；句柄创建时的快照必须是当前镜像栈的前缀（R9）。 */
  const assertHandleScope = (handle: object): void => {
    scopes.assert(handle, writer.mirrorScope());
  };
  /** P2：铺装写入跳过已登记为 opening 门框 / 门外净空的格（按真实坐标，含镜像副本）。 */
  const isOpeningClearance = (w: { readonly x: number; readonly y: number; readonly z: number }): boolean =>
    writer.reflect([w]).some((c) => writer.openingClearanceAt(c.x, c.y, c.z));
  function resolve(value: SurfaceReference): Surface {
    const s = 'top' in value ? value.top : value;
    if (!surfaces.has(s)) throw new Error('关系必须引用当前世界的表面锚点或句柄');
    assertHandleScope(s);
    return s;
  }
  function surface(value: Surface, name: string): Surface {
    const s = parse(surfaceSchema, value);
    surfaces.add(s);
    scopes.tag(s, name, writer.mirrorScope());
    return s;
  }
  function facadeGroup(
    f: Omit<Facade, 'side'>,
    host: number,
    name: string,
    isEdge = false,
  ): (side: Side) => FacadeHandle {
    // 派生锚点继承宿主句柄创建时的快照，而不是调用 facade(side) 时的快照。
    const scope = writer.mirrorScope();
    const bySide = new Map<Side, FacadeHandle>();
    return (side) => {
      parse(sideSchema, side);
      const previous = bySide.get(side);
      if (previous !== undefined) return previous;
      const openings: OpeningHandle[] = [];
      const spans: OpeningSpan[] = [];
      const handle = Object.freeze({
        ...f,
        side,
        host,
        opening(index: number): OpeningHandle {
          const found = openings[index];
          if (!Number.isSafeInteger(index) || found === undefined) {
            throw new Error(`opening 索引 ${String(index)} 不存在，合法范围 [0, ${String(openings.length - 1)}]`);
          }
          return found;
        },
      });
      facades.set(handle, openings);
      openingSpans.set(handle, spans);
      scopes.tag(handle, name, scope);
      if (isEdge) edges.add(handle);
      bySide.set(side, handle);
      return handle;
    };
  }
  const world: World = Object.freeze<World>({
    ...createMassingImport(writer, options.massing),
    ...createSurfaceShell(writer),
    set(x, y, z, block, writeLayer) {
      const point = parse(pointSchema, [x, y, z]);
      const state = writer.material(block);
      if (writeLayer !== undefined) parse(writeLayerSchema, writeLayer);
      if (isAir(state) && writeLayer !== undefined && writeLayer !== 'opening') {
        throw new Error(`writeLayer=${writeLayer} 不合法：空气必须写入 opening 层`);
      }
      const layer = isAir(state) ? 'opening' : (writeLayer ?? 'structure');
      writer.commit('set', { point, block, writeLayer: layer }, boxWrites(point, point, state, layer));
    },
    box(from, to, block, writeLayer) {
      const a = parse(pointSchema, from);
      const b = parse(pointSchema, to);
      const state = writer.material(block);
      if (writeLayer !== undefined) parse(writeLayerSchema, writeLayer);
      if (isAir(state) && writeLayer !== undefined && writeLayer !== 'opening') {
        throw new Error(`writeLayer=${writeLayer} 不合法：空气必须写入 opening 层`);
      }
      const layer = isAir(state) ? 'opening' : (writeLayer ?? 'structure');
      writer.commit('box', { from: a, to: b, block, writeLayer: layer }, boxWrites(a, b, state, layer));
    },
    get: (x, y, z) => writer.get(x, y, z),
    part: (name, fn) => {
      writer.part(name, fn);
    },
    mirror: (options, fn) => {
      writer.mirror(options, fn);
    },
    plinth(options) {
      const p = parse(plinthSchema, {
        ...options,
        ...(options.under === undefined ? {} : { under: resolve(options.under) }),
      });
      const footprint =
        p.under?.footprint ??
        (p.footprint === undefined
          ? undefined
          : 'points' in p.footprint
            ? polygonFootprint(p.footprint.points)
            : p.footprint);
      if (footprint === undefined) throw new Error('plinth 缺少占地');
      const y = p.under === undefined ? p.y : p.under.y - p.height;
      if (p.under !== undefined && options.y !== undefined)
        throw new Error('plinth.under 与 y 不能混用：给 under 时底部高度由 under.y − height 推出，去掉 y');
      const state = writer.material(p.material, true);
      const r = expand(footprint, p.project);
      const b = bounds(r, y, p.height);
      const top = surface({ footprint, y: y + p.height }, 'plinth');
      // 外挑后的外缘也保留多边形标记，否则 rail 会把多边形台基当成包围矩形围一圈（R8 / N2）。
      const outer = footprint.polygon === undefined ? r : Object.freeze({ ...r, polygon: footprint.polygon });
      if (p.project > 0) outerEdges.set(top, surface({ footprint: outer, y: y + p.height }, 'plinth'));
      const writes = boxWrites(b.min, b.max, state, 'structure').filter(
        (c) => footprint.polygon === undefined || projected(footprint, c.x, c.z, p.project),
      );
      const call = writer.commit('plinth', p, writes);
      return Object.freeze({
        bounds: b,
        top,
        edge:
          footprint.polygon === undefined
            ? facadeGroup({ footprint: r, y, height: p.height, thickness: 1, corner: false }, call, 'plinth', true)
            : () => {
                throw new Error('多边形台基没有矩形 side 边，请对实际入口使用 opening 锚点');
              },
      });
    },
    walls(options) {
      let input: unknown = options;
      if ('on' in options) {
        const on = 'top' in options.on ? options.on.top : options.on;
        if (!surfaces.has(on)) throw new Error('on 必须是当前世界的表面锚点或句柄');
        assertHandleScope(on);
        input = { ...options, on };
      }
      const p = parse(wallsSchema, input);
      const location = 'on' in p ? p.on : p;
      const r =
        p.outline === 'apse' ? Object.freeze({ ...location.footprint, apse: true as const }) : location.footprint;
      if (r.polygon !== undefined)
        throw new Error('walls 当前仅支持 rect / apse；多边形台基上的外墙请给出内部矩形 footprint + y');
      const y = location.y;
      const height = 'height' in p ? p.height : p.storeys.count * p.storeys.height;
      const writes = wallsPlan(table, p);
      const top = surface({ footprint: r, y: y + height }, 'walls');
      // 山墙缺省用墙顶那一段的材质（分段材质时取最高一段）与墙厚。
      const topBand = [...p.bands].sort((a, b) => b.to - a.to)[0];
      wallTops.set(top, {
        material: topBand?.to === height - 1 ? topBand.material : p.material,
        thickness: p.thickness,
      });
      const inner = surface(
        {
          footprint: { ...expand(r, -p.thickness), ...(r.apse === true ? { apse: true as const } : {}) },
          y,
        },
        'walls',
      );
      const storeys: Surface[] = [];
      if ('storeys' in p) {
        for (let i = 0; i < p.storeys.count; i += 1) {
          storeys.push(surface({ footprint: inner.footprint, y: y + i * p.storeys.height }, 'walls'));
        }
      }
      const call = writer.commit('walls', p, writes, { inner: inner.footprint });
      return Object.freeze({
        bounds: bounds(r, y, height),
        top,
        inner,
        facade: facadeGroup(
          {
            footprint: r,
            y,
            height,
            thickness: p.thickness,
            ...('storeys' in p ? { storeyHeight: p.storeys.height } : {}),
          },
          call,
          'walls',
        ),
        storey(index: number): Surface {
          const s = storeys[index];
          if (!Number.isSafeInteger(index) || s === undefined) {
            throw new Error(
              `storey(${String(index)}) 不存在：请指定 storeys，并使用 [0, ${String(storeys.length - 1)}] 的整数索引`,
            );
          }
          return s;
        },
      });
    },
    opening(options) {
      const openings = facades.get(options.in);
      if (openings === undefined) throw new Error('in 必须是当前世界的立面锚点');
      assertHandleScope(options.in);
      const spans = openingSpans.get(options.in);
      const facadeInfo = spans === undefined ? undefined : { openings: spans };
      const parentInfo = scopes.info(options.in);
      const { footprint, y, height, thickness, side, storeyHeight, corner } = options.in;
      const data = {
        footprint,
        y,
        height,
        thickness,
        side,
        ...(storeyHeight === undefined ? {} : { storeyHeight }),
        ...(corner === undefined ? {} : { corner }),
      };
      const p = parse(openingSchema, { ...options, in: data });
      const air = writer.material('air');
      const fill = writer.material(p.fill);
      const frame = p.frame === undefined ? undefined : writer.material(p.frame.material, true);
      const canopy = p.canopy === undefined ? undefined : writer.material(p.canopy.material, true);
      if (p.mullion !== undefined) {
        if (p.kind !== 'window' || p.shape !== 'rect')
          throw new Error("opening.mullion 只用于矩形窗（kind:'window'、shape:'rect'）");
        if (p.width < p.mullion.every + 1)
          throw new Error(
            `opening.width=${String(p.width)} 放不下分格：mullion.every=${String(p.mullion.every)} 时 width 至少为 ${String(p.mullion.every + 1)}`,
          );
        // P4：两端都要有竖框，width 必须是 k·every + 1。
        const r = (p.width - 1) % p.mullion.every;
        if (r !== 0) {
          const lower = p.width - r;
          const upper = lower + p.mullion.every;
          const nearest = r * 2 <= p.mullion.every ? lower : upper;
          throw new Error(
            `opening.width=${String(p.width)} 不满足 width = k·every + 1（两端都要有竖框）：` +
              `mullion.every=${String(p.mullion.every)} 时最近的合法 width 是 ${String(nearest)}`,
          );
        }
      }
      const mullion = p.mullion === undefined ? undefined : writer.material(p.mullion.material, true);
      // 单层定位（§8.2）：sill 从该层楼面算，洞连框与雨棚不能穿进上一层楼板。
      let baseSill = p.sill;
      if (p.storey !== undefined) {
        if (storeyHeight === undefined) throw new Error('opening.storey 需要外墙用 storeys 建造；这面墙只给了 height');
        if (p.repeat !== undefined && 'storeys' in p.repeat) throw new Error('opening.storey 与 repeat.storeys 二选一');
        const count = height / storeyHeight;
        if (p.storey >= count)
          throw new Error(`opening.storey=${String(p.storey)} 不存在，可用 [0, ${String(count - 1)}]`);
        baseSill = p.sill + p.storey * storeyHeight + 1;
        const rim = p.frame?.width ?? 0;
        const ceiling = y + baseSill + p.height - 1 + Math.max(rim, p.canopy === undefined ? 0 : 1);
        const floorAbove = y + (p.storey + 1) * storeyHeight;
        if (ceiling >= floorAbove)
          throw new Error(
            `opening 洞顶 y=${String(ceiling)} 穿进第 ${String(p.storey + 1)} 层楼板 y=${String(floorAbove)}：请减小 height / sill`,
          );
      }
      // 重复参数不能把原本越界的 at 悄悄移回立面。
      openingWrites({ ...p, sill: baseSill }, air, fill, frame, canopy, mullion, facadeInfo);
      const copies = [{ at: p.at, sill: baseSill }];
      if (p.repeat !== undefined && 'every' in p.repeat) {
        const rim = p.frame?.width ?? 0;
        if (p.repeat.every < p.width + 2 * rim)
          throw new Error(
            `opening.repeat.every=${String(p.repeat.every)} 太小：洞宽 ${String(p.width)}` +
              `${rim > 0 ? ` 加两侧框 ${String(2 * rim)}` : ''}，相邻两洞会重叠；every 至少为 ${String(p.width + 2 * rim)}`,
          );
        // 可放洞的墙身：外轮廓两端各去掉 thickness 格转角（与 openingWrites 的合法范围一致）。
        const span =
          (side === 'north' || side === 'south'
            ? footprint.maxX - footprint.minX + 1
            : footprint.maxZ - footprint.minZ + 1) - (corner === false ? 0 : 2 * thickness);
        const outer =
          side === 'north' || side === 'south'
            ? footprint.maxX - footprint.minX + 1
            : footprint.maxZ - footprint.minZ + 1;
        // at 相对整条外轮廓居中；墙身两端到中心的 at 范围是 [lo, hi]。
        const centre = Math.floor((outer - p.width) / 2);
        const inset = corner === false ? 0 : thickness;
        const lo = inset + rim - centre;
        const hi = inset + span - p.width - rim - centre;
        copies.length = 0;
        for (let at = p.at - Math.floor((p.at - lo) / p.repeat.every) * p.repeat.every; at <= hi; at += p.repeat.every)
          copies.push({ at, sill: baseSill });
      } else if (p.repeat !== undefined) {
        if (storeyHeight === undefined)
          throw new Error('opening.repeat.storeys 需要外墙用 storeys 建造；这面墙只给了 height，没有楼层');
        if (new Set(p.repeat.storeys).size !== p.repeat.storeys.length)
          throw new Error(`opening.repeat.storeys=[${p.repeat.storeys.join(', ')}] 有重复的楼层`);
        copies.length = 0;
        // S1：sill 改从该层站立面（楼板顶面 = 层底 y + 楼板厚 1）起算，sill 0 的门与楼面齐平。
        for (const i of p.repeat.storeys) copies.push({ at: p.at, sill: p.sill + i * storeyHeight + 1 });
      }
      const plans = copies.map((copy) =>
        openingWrites({ ...p, ...copy }, air, fill, frame, canopy, mullion, facadeInfo),
      );
      const first = plans[0];
      if (first === undefined) throw new Error('opening.repeat 没有可放置的洞');
      // R6 对称：新开的门 / 院门若已被此前楼梯堵死，整次调用失败。
      const records: DoorRecord[] = [];
      if (p.kind !== 'window' && fill.name === 'air') {
        for (let i = 0; i < plans.length; i += 1) {
          const plan = plans[i];
          if (plan === undefined) continue;
          const record: DoorRecord = { bounds: plan.bounds, side: p.in.side, thickness, index: openings.length + i };
          const scan = thresholdScan(record, (x, y, z) => writer.stairSolidAt(x, y, z));
          if (scan.total > 0 && scan.blocked === scan.total && scan.sample !== undefined)
            throw new Error(doorBlockedError(record, scan.sample));
          records.push(record);
        }
      }
      writer.commit(
        'opening',
        p,
        plans.flatMap((plan) => plan.writes),
        {
          host: options.in.host,
          openingBaseY: p.in.y,
          ...(p.canopy === undefined ? {} : { canopyDepth: Math.max(0, p.canopy.depth - 1) }),
        },
      );
      const handles = plans.map((plan, i) => {
        // 记录本立面新洞的范围（连框宽度），供后续越界报错按 at 排序回报。
        spans?.push({ at: copies[i]?.at ?? p.at, start: plan.start, end: plan.end, rim: p.frame?.width ?? 0 });
        return Object.freeze({ bounds: plan.bounds, side: p.in.side, thickness });
      });
      for (const handle of handles) {
        // opening(i) 派生锚点继承宿主立面的快照（R9）。
        scopes.tag(handle, parentInfo?.name ?? 'opening', parentInfo?.scope ?? writer.mirrorScope());
        if (p.kind !== 'window' && fill.name === 'air') entrances.add(handle);
        openings.push(handle);
      }
      doors.push(...records);
      const handle = handles[0];
      if (handle === undefined) throw new Error('opening 未生成句柄');
      return handle;
    },
    floorPlate(options) {
      if ('in' in options) resolve(options.in);
      const p = parse(floorPlateSchema, options);
      const location = 'in' in p ? p.in : p;
      const b = bounds(location.footprint, location.y, p.thickness);
      const state = writer.material(p.material, true);
      const top = surface({ footprint: location.footprint, y: location.y + p.thickness }, 'floorPlate');
      const region = surface({ footprint: location.footprint, y: location.y }, 'floorPlate');
      writer.commit(
        'floorPlate',
        p,
        boxWrites(b.min, b.max, state, 'structure').filter((c) => contains(location.footprint, c.x, c.z)),
      );
      return Object.freeze({ bounds: b, top, region });
    },
    stair(options) {
      const from = resolve(options.from);
      const to = resolve(options.to);
      const p = parse(stairSchema, { ...options, from, to });
      const plan = stairPlan(table, p);
      // R6 对称：新楼梯不能把已存在的门 / 院门整扇堵死。
      const solids = new Map<string, StairSolid>();
      for (const w of writer.reflect(plan.writes))
        if ((w.role === 'tread' || w.role === 'back') && !isAir(w.state))
          solids.set(`${String(w.x)},${String(w.y)},${String(w.z)}`, w.role);
      for (const door of doors) {
        const scan = thresholdScan(door, (x, y, z) => solids.get(`${String(x)},${String(y)},${String(z)}`));
        if (scan.total > 0 && scan.blocked === scan.total && scan.sample !== undefined)
          throw new Error(doorBlockedError(door, scan.sample));
      }
      writer.commit('stair', p, plan.writes, {
        stairToY: to.y,
        stairCommon: commonFootprint(from, to),
        stairOffsets: {
          dx0: plan.bounds.min[0] - p.at[0],
          dx1: plan.bounds.max[0] - p.at[0],
          dz0: plan.bounds.min[2] - p.at[1],
          dz1: plan.bounds.max[2] - p.at[1],
        },
      });
      return Object.freeze({ bounds: plan.bounds, path: plan.path });
    },
    steps(options) {
      let target: OpeningHandle;
      if ('footprint' in options.to) {
        const edge = options.to;
        if (!edges.has(edge)) throw new Error('steps.to 必须是当前世界的台基边或未填充的门洞');
        assertHandleScope(edge);
        const r = edge.footprint;
        const side = edge.side;
        const b = bounds(r, edge.y + edge.height, 1);
        target = { side, bounds: b, thickness: 1 };
      } else {
        if (!entrances.has(options.to)) throw new Error('steps.to 必须是当前世界的台基边或未填充的门洞');
        assertHandleScope(options.to);
        target = options.to;
      }
      const p = parse(stepsSchema, { ...options, to: { side: target.side, bounds: target.bounds } });
      const plan = stepsPlan(table, p);
      // 落点：踏步最高一级再往入口走一格，就是入口外缘那一排（门洞底 / 台基顶面边缘）；
      // 站立高度 = 入口底面 y、头顶再一格，之后的栏杆在这两格留口；列坐标取自入口并与 path 第一列对齐。
      const landing: RailKeepOut[] = [];
      const last = plan.path.at(-1);
      if (last !== undefined) {
        const b = target.bounds;
        const ns = target.side === 'north' || target.side === 'south';
        const outer =
          target.side === 'north'
            ? b.min[2]
            : target.side === 'south'
              ? b.max[2]
              : target.side === 'east'
                ? b.max[0]
                : b.min[0];
        // path 末格是中线上的一格（R10）；宽度展开的较小坐标是 center − ⌊width/2⌋。
        const center = ns ? last[0] : last[2];
        const lo = center - Math.floor(p.width / 2);
        const stand = b.min[1];
        for (let w = 0; w < p.width; w += 1) {
          const x = ns ? lo + w : outer;
          const z = ns ? outer : lo + w;
          for (let y = stand; y <= stand + 1; y += 1) landing.push({ x, y, z });
        }
      }
      // 栏杆已经写在落点上：按决策 #60，栏杆只给它之前登记的踏步留口；不静默挖掉栏杆，报错提示调换顺序。
      const blocked = writer
        .reflect(landing)
        .find((c) => railCells.has(`${String(c.x)},${String(c.y)},${String(c.z)}`));
      if (blocked !== undefined) {
        throw new Error(
          `steps 的落点 (${String(blocked.x)}, ${String(blocked.y)}, ${String(blocked.z)}) 已经有栏杆。` +
            '请先写 steps 再写 rail：栏杆会在已有踏步的落点自动留口',
        );
      }
      writer.commit('steps', p, plan.writes, { stepsLength: plan.path.length });
      railKeepOut.push(...writer.reflect(landing));
      return Object.freeze({ bounds: plan.bounds, path: plan.path });
    },
    roof(options) {
      const on = options.on === undefined ? undefined : resolve(options.on);
      const p = parse(roofSchema, { ...options, ...(on === undefined ? {} : { on }) });
      // 山墙：显式 gableMaterial 优先，挂外墙时缺省用墙顶材质，其余不封；用解析前的锚点查（parse 会复制对象）。
      const wall = on === undefined ? undefined : wallTops.get(on);
      const gableText = p.gableMaterial === false ? undefined : (p.gableMaterial ?? wall?.material);
      const gable =
        gableText === undefined
          ? undefined
          : { state: writer.material(gableText, true), thickness: wall?.thickness ?? 1 };
      const plan = roofPlan(table, p, gable);
      const eaveLine = surface(plan.eaveLine, 'roof');
      const top = plan.top === undefined ? undefined : surface(plan.top, 'roof');
      // 平屋面的 top 供后续 stair 判定"出口穿过后铺的平屋面"（R2）。
      writer.commit('roof', p, plan.writes, plan.top === undefined ? {} : { roofTop: plan.top });
      return Object.freeze({ bounds: plan.bounds, peak: plan.peak, eaveLine, ...(top === undefined ? {} : { top }) });
    },
    colonnade(options) {
      const p = parse(colonnadeSchema, {
        ...options,
        ...(options.on === undefined ? {} : { on: resolve(options.on) }),
      });
      const plan = colonnadePlan(table, p);
      const top = surface(plan.top, 'colonnade');
      const bays = Object.freeze(plan.bays.map((b) => surface(b, 'colonnade')));
      writer.commit('colonnade', p, plan.writes);
      return Object.freeze({ bounds: plan.bounds, top, bays });
    },
    rail(options) {
      const along = resolve(options.along);
      const p = parse(railSchema, { ...options, along: outerEdges.get(along) ?? along });
      // 镜像作用域里，留口要按反射前的坐标判断：把已登记的落点反射回本侧再传入。
      const plan = railPlan(table, p, writer.reflect(railKeepOut));
      writer.commit('rail', p, plan.writes);
      for (const c of writer.reflect(plan.writes)) railCells.add(`${String(c.x)},${String(c.y)},${String(c.z)}`);
      return Object.freeze({ bounds: plan.bounds });
    },
    enclosure(options) {
      const p = parse(enclosureSchema, options);
      const plan = enclosurePlan(table, p);
      const inner = surface(plan.inner, 'enclosure');
      // 门楼时门槛厚度是进深 depth（§8.4）；thresholdScan 按 gate.bounds 往里退一格，门洞 bounds 必须覆盖整段 depth。
      const gateThickness = p.gate.gatehouse?.depth ?? p.thickness;
      // R6 对称：新院门若已被此前楼梯堵死，整次调用失败。
      const record: DoorRecord = { bounds: plan.gate.bounds, side: plan.gate.side, thickness: gateThickness, index: 0 };
      const scan = thresholdScan(record, (x, y, z) => writer.stairSolidAt(x, y, z));
      if (scan.total > 0 && scan.blocked === scan.total && scan.sample !== undefined)
        throw new Error(doorBlockedError(record, scan.sample));
      writer.commit('enclosure', p, plan.writes);
      const gate = Object.freeze({ bounds: plan.gate.bounds, side: plan.gate.side, thickness: gateThickness });
      scopes.tag(gate, 'enclosure', writer.mirrorScope());
      doors.push(record);
      entrances.add(gate);
      let gatehouse: EnclosureHandle['gatehouse'];
      if (plan.gatehouse !== undefined && p.gate.gatehouse !== undefined) {
        const top = surface(plan.gatehouse.top, 'enclosure');
        wallTops.set(top, { material: p.gate.gatehouse.material, thickness: 1 });
        gatehouse = Object.freeze({ bounds: plan.gatehouse.bounds, top });
      }
      return Object.freeze({ bounds: plan.bounds, inner, gate, ...(gatehouse === undefined ? {} : { gatehouse }) });
    },
    paving(options) {
      if ('region' in options) {
        if ('from' in options || 'to' in options || 'width' in options)
          throw new Error('paving.region 与 from / to / width 互斥');
        const region = parse(pavingSchema, options);
        if (!('region' in region)) throw new Error('paving.region 解析失败');
        if (region.region.polygon !== undefined || region.region.apse === true)
          throw new Error('paving.region 只接受矩形');
        const plan = pavingPlan(table, region);
        writer.commit(
          'paving',
          region,
          plan.writes.filter((w) => !isOpeningClearance(w)),
        );
        return Object.freeze({ bounds: plan.bounds });
      }
      if (!entrances.has(options.from) || (typeof options.to !== 'number' && !entrances.has(options.to)))
        throw new Error('paving.from / to 必须引用当前世界未填充门洞或院门');
      assertHandleScope(options.from);
      if (typeof options.to !== 'number') assertHandleScope(options.to);
      // entranceSchema 是 strictObject：去掉句柄上给 R6 用的 thickness，只把 side + bounds 交给 schema。
      const to = typeof options.to === 'number' ? options.to : { side: options.to.side, bounds: options.to.bounds };
      const p = parse(pavingSchema, {
        ...options,
        from: { side: options.from.side, bounds: options.from.bounds },
        to,
      });
      const plan = pavingPlan(table, p, (x, y, z) => writer.solidAt(x, y, z));
      writer.commit(
        'paving',
        p,
        plan.writes.filter((w) => !isOpeningClearance(w)),
      );
      return Object.freeze({ bounds: plan.bounds });
    },
  });
  return Object.freeze({ world, compose: () => writer.compose() });
}
