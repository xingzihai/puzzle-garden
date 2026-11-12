/**
 * 规范 JSON（MODEL-SPEC §2、§7.4）：对象键按 UTF-16 码元升序（即 `Array.prototype.sort()` 不带比较函数）、无空白。
 *
 * 规则对齐 CORE-SPEC §4.1 的 `args` 规范 JSON（MODEL-SPEC §2 只要求「键按 UTF-16 码元排序、无空白」，
 * 统一到 core 的规则便于两处互为金标）：`undefined` 值的键省略、数组元素与顶层的 `undefined` 写成 `null`、
 * 非有限数写成 `null`、函数 / symbol / bigint / 循环引用抛错。本模块是通用实现，不做 200 码元截断。
 *
 * 负责：把 JSON 值稳定序列化，让语义相同的消息与请求清单得到相同字节（内容寻址去重、请求逐字节还原）。
 * 不负责：sha256（blobs.ts）、事件信封（events.ts）。
 * 本文件是纯函数：不做 I/O，不读全局可变状态。
 */

/** 把值递归规范化为 JSON 文本；对象属性里的 `undefined` 返回 `undefined` 表示省略。 */
function canonicalize(value: unknown, stack: readonly object[]): string | undefined {
  switch (typeof value) {
    case 'undefined':
      return undefined;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      // NaN / Infinity 不是合法 JSON；core 的 args 规则把它们写成 null（CORE-SPEC §4.1）。
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson 不支持 ${typeof value} 值：它无法表示为 JSON`);
    case 'object': {
      if (value === null) return 'null';
      if (stack.includes(value)) throw new TypeError('canonicalJson 遇到循环引用');
      const nextStack = [...stack, value];
      if (Array.isArray(value)) {
        const items = value.map((item: unknown) => canonicalize(item, nextStack) ?? 'null');
        return `[${items.join(',')}]`;
      }
      const record = value as Readonly<Record<string, unknown>>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const item = canonicalize(record[key], nextStack);
        if (item !== undefined) parts.push(`${JSON.stringify(key)}:${item}`);
      }
      return `{${parts.join(',')}}`;
    }
  }
}

/**
 * 规范 JSON 文本。顶层 `undefined` 写成 `null`（与 core 的 `defineCall` 顶层规则一致，CORE-SPEC §4.1）。
 * 非法值（函数、symbol、bigint、循环引用）抛 `TypeError`，不静默丢弃。
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, []) ?? 'null';
}
