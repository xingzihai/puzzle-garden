/**
 * 官方 blockstates 求值：variants / multipart、条件语法、模型引用、x/y 旋转。
 *
 * 只用于离线生成模型包。栅栏 / 玻璃板的 `north/east/south/west` 是游戏运行时合成的状态，
 * 不在 block-states.json 里；生成器会为它们额外准备 16 组连接掩码。
 */

import type { ModelBox, ModelReader } from './model-json.ts';
import { resolveModel, rotateModelBoxes } from './model-json.ts';

type Props = Readonly<Record<string, string>>;

interface Apply {
  model?: unknown;
  x?: unknown;
  y?: unknown;
}

interface BlockstateJson {
  variants?: Record<string, Apply | Apply[]>;
  multipart?: { when?: unknown; apply?: Apply | Apply[] }[];
}

export interface EvaluatedBlockstate {
  readonly boxes: readonly ModelBox[];
  /** 至少命中一个 variant / multipart 部件；false 时调用方应回退简化几何。 */
  readonly matched: boolean;
}

function matchesWhen(when: unknown, props: Props): boolean {
  if (when === undefined) return true;
  if (typeof when === 'string') {
    const match = /^([a-z0-9_]+)=([a-z0-9_]+)$/.exec(when);
    return match === null ? false : props[match[1] ?? ''] === match[2];
  }
  if (Array.isArray(when)) return when.some((entry) => matchesWhen(entry, props));
  if (typeof when !== 'object' || when === null) return false;
  const record = when as Record<string, unknown>;
  if (Array.isArray(record['OR'])) return record['OR'].some((entry) => matchesWhen(entry, props));
  if (Array.isArray(record['AND'])) return record['AND'].every((entry) => matchesWhen(entry, props));
  return Object.entries(record).every(([key, value]) => {
    if (Array.isArray(value)) return value.some((entry) => String(entry) === props[key]);
    return String(value) === props[key];
  });
}

function matchesVariantKey(key: string, props: Props): boolean {
  if (key === '') return true;
  for (const pair of key.split(',')) {
    const match = /^([a-z0-9_]+)=([a-z0-9_]+)$/.exec(pair.trim());
    if (match === null) return false;
    if (props[match[1] ?? ''] !== match[2]) return false;
  }
  return true;
}

function applyOf(apply: Apply, read: ModelReader): ModelBox[] {
  if (typeof apply.model !== 'string') return [];
  const model = resolveModel(apply.model, read);
  if (model === null) return [];
  let boxes = [...model.boxes];
  const x = typeof apply.x === 'number' ? apply.x : 0;
  const y = typeof apply.y === 'number' ? apply.y : 0;
  if (x !== 0) boxes = rotateModelBoxes(boxes, 'x', x);
  if (y !== 0) boxes = rotateModelBoxes(boxes, 'y', y);
  return boxes;
}

function appliesOf(apply: Apply | Apply[] | undefined, read: ModelReader): ModelBox[] {
  if (apply === undefined) return [];
  const list = Array.isArray(apply) ? apply : [apply];
  return list.flatMap((entry) => applyOf(entry, read));
}

/** variants 数组是随机权重候选；渲染要确定性，固定取第一项。 */
function firstApplyOf(apply: Apply | Apply[] | undefined, read: ModelReader): ModelBox[] {
  if (apply === undefined) return [];
  return applyOf(Array.isArray(apply) ? (apply[0] ?? {}) : apply, read);
}

/** 求值一个方块状态；props 必须是完整属性表（含默认值）。 */
export function evaluateBlockstate(raw: BlockstateJson, props: Props, read: ModelReader): EvaluatedBlockstate {
  if (raw.variants !== undefined) {
    for (const [key, apply] of Object.entries(raw.variants)) {
      if (!matchesVariantKey(key, props)) continue;
      const boxes = firstApplyOf(apply, read);
      if (boxes.length > 0) return { boxes, matched: true };
    }
    return { boxes: [], matched: false };
  }
  if (raw.multipart !== undefined) {
    const boxes: ModelBox[] = [];
    for (const part of raw.multipart) {
      if (!matchesWhen(part.when, props)) continue;
      boxes.push(...appliesOf(part.apply, read));
    }
    return { boxes, matched: boxes.length > 0 };
  }
  return { boxes: [], matched: false };
}

/** 解析 blockstate JSON 文本；语法错误由调用方记录并跳过该方块。 */
export function parseBlockstate(text: string): BlockstateJson {
  return JSON.parse(text) as BlockstateJson;
}
