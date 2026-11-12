/** 镜像坐标与 MC 状态；从完整默认属性出发翻转，避免省略的默认朝向漏翻。 */
import type { BlockTable, BlockState } from '@pg/core/block-state';
import { parseState } from '@pg/core/block-state';
import type { z } from 'zod';
import type { mirrorSchema } from './schema.ts';
import type { Write } from './writer.ts';

export function mirrorState(table: BlockTable, state: BlockState, axis: 'x' | 'z'): BlockState {
  const definition = table.blocks.get(state.name);
  if (definition === undefined) throw new Error(`镜像方块 ${state.name} 不在当前方块表`);
  const props: Record<string, string> = {};
  for (const [key, def] of definition.props) props[key] = state.props[key] ?? def.default;
  const swap = axis === 'x' ? { east: 'west', west: 'east' } : { north: 'south', south: 'north' };
  const flip = (v: string): string =>
    v
      .split('_')
      .map((part) =>
        part === 'east' && axis === 'x'
          ? 'west'
          : part === 'west' && axis === 'x'
            ? 'east'
            : part === 'north' && axis === 'z'
              ? 'south'
              : part === 'south' && axis === 'z'
                ? 'north'
                : part,
      )
      .join('_');
  for (const [key, value] of Object.entries(props)) {
    if (key === 'facing' || key === 'orientation' || (key === 'shape' && state.name.includes('rail')))
      props[key] = flip(value);
    if (key === 'shape' && state.name.endsWith('_stairs'))
      props[key] = value.replace('left', 'RIGHT').replace('right', 'left').replace('RIGHT', 'right');
    if (key === 'hinge' || (key === 'type' && state.name.endsWith('chest')))
      props[key] = value === 'left' ? 'right' : value === 'right' ? 'left' : value;
    if (key === 'rotation') props[key] = String((axis === 'x' ? 16 - Number(value) : 8 - Number(value) + 16) % 16);
  }
  for (const [a, b] of Object.entries(swap)) {
    const def = definition.props.get(b);
    if (def !== undefined) props[a] = state.props[b] ?? def.default;
  }
  // 铁轨的直线与转角枚举有规范顺序，反射后不能产生 south_north / west_east。
  if (state.name.includes('rail') && props['shape'] !== undefined) {
    const shape = props['shape'];
    if (shape === 'south_north') props['shape'] = 'north_south';
    if (shape === 'west_east') props['shape'] = 'east_west';
  }
  return parseState(
    table,
    `${state.name}[${Object.entries(props)
      .map(([k, v]) => `${k}=${v}`)
      .join(',')}]`,
  );
}

export function mirrorWrites(
  table: BlockTable,
  writes: readonly Write[],
  mirrors: readonly z.output<typeof mirrorSchema>[],
): readonly Write[] {
  let result = [...writes];
  for (const m of mirrors) {
    const states = new Map<BlockState, BlockState>();
    const reflected = result.map((w) => {
      let state = states.get(w.state);
      if (state === undefined) {
        state = mirrorState(table, w.state, m.axis);
        states.set(w.state, state);
      }
      // at 可为整数或半格（.5）：2*at 为整数，反射后坐标仍是整数；越界由 commit 的 checkCoord 报错。
      return { ...w, [m.axis]: 2 * m.at - w[m.axis], state };
    });
    result = [...result, ...reflected];
  }
  return result;
}
