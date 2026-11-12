/**
 * child 的全局准备（SANDBOX-SPEC §2.2、§5.4、F1）：替换 Math / Date / performance、捕获 console、
 * 按白名单删除其余全局、冻结全局对象。
 *
 * 负责：在一份传入的"全局对象"上完成上述替换与删除，并返回 console 缓冲句柄；单元测试传入
 * 一个独立对象，不污染测试进程。真正的 `globalThis` 由 child-run 传入。
 * 不负责：类型擦除、加载钩子、执行 build（child-run.ts）；真实 `Date.prototype.constructor`
 * 后门由 child-preload 在冻结前堵住（fixed-date.ts）。
 *
 * 这就是 SANDBOX-SPEC §9 允许放开 STANDARDS §5、§7 的文件：它必须替换 `Math.random`、改 `Date`、
 * 删全局；这些操作集中在这里，其它文件不放开。
 */
import { mulberry32 } from '@pg/core/rng';

import { createFixedDate } from './fixed-date.ts';
import type { ConsoleEntry } from './protocol.ts';

export { FIXED_TIME } from './fixed-date.ts';

/**
 * 允许留在全局的名字（F1）。白名单之外的字符串键一律删除：Node 会不断新增全局（Event、URL、
 * structuredClone、performance 的同类……），列删除名单必然漏，所以反过来列保留名单。
 * symbol 键（如 Symbol.toStringTag）不属于字符串键，一律保留。
 */
const ALLOWED_GLOBAL_NAMES = [
  // ES 内置
  'Object',
  'Function',
  'Array',
  'Number',
  'Boolean',
  'String',
  'Symbol',
  'BigInt',
  'Date',
  'Promise',
  'RegExp',
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'JSON',
  'Math',
  'Reflect',
  'Proxy',
  'ArrayBuffer',
  'DataView',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'FinalizationRegistry',
  'Iterator',
  // 类型数组
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  // 全局函数
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'encodeURIComponent',
  'decodeURI',
  'decodeURIComponent',
  'escape',
  'unescape',
  'eval',
  // 全局值
  'NaN',
  'Infinity',
  'undefined',
  'globalThis',
  // 运行时存在才保留
  'SuppressedError',
  'DisposableStack',
  'AsyncDisposableStack',
  // 沙箱提供的替身与额外名字
  'console',
  'performance',
  'rect',
] as const;

/** 白名单集合；child-globals.test 用它断言删除后剩下的名字恰好是它。 */
export const ALLOWED_GLOBALS: ReadonlySet<string> = new Set(ALLOWED_GLOBAL_NAMES);

/** console 的其它方法给空函数，模型调不到也不报错（预检本就不声明，§5.4）。 */
const CONSOLE_NOOP = [
  'trace',
  'debug',
  'info',
  'assert',
  'table',
  'dir',
  'group',
  'groupEnd',
  'time',
  'timeEnd',
] as const;

/** 一个可写的"全局对象"；真实 globalThis 或测试用的独立对象。 */
export type MutableGlobals = Record<string, unknown>;

export interface ConsoleCapture {
  readonly entries: readonly ConsoleEntry[];
  readonly truncated: number;
}

export interface PrepareOptions {
  readonly seed: number;
  /** console 总字节上限（§5.4）。 */
  readonly consoleBytes: number;
  /** 额外挂到全局的名字，如 rect；在冻结前写入。 */
  readonly extras?: Readonly<Record<string, unknown>>;
}

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json: unknown = JSON.stringify(value);
    return typeof json === 'string' ? json : String(value);
  } catch {
    return String(value);
  }
}

/** 把参数拼成一行并追加进缓冲区，按字节数裁剪；额度用完的条目丢弃并计数（§5.4）。 */
function installConsole(target: MutableGlobals, limitBytes: number): ConsoleCapture {
  // Buffer 随后会被删除，先在闭包里保存引用。
  const buffer = Buffer;
  const entries: ConsoleEntry[] = [];
  let truncated = 0;
  let used = 0;
  const push = (level: ConsoleEntry['level'], args: readonly unknown[]): void => {
    const text = args.map(formatArg).join(' ');
    const bytes = buffer.byteLength(text, 'utf8');
    const remaining = limitBytes - used;
    if (remaining <= 0) {
      truncated += 1;
      return;
    }
    if (bytes > remaining) {
      // 截到额度：留 3 字节给省略号，按码点切，避免截断代理对。
      const budget = remaining > 3 ? remaining - 3 : remaining;
      let cut = '';
      let acc = 0;
      for (const ch of text) {
        const b = buffer.byteLength(ch, 'utf8');
        if (acc + b > budget) break;
        cut += ch;
        acc += b;
      }
      entries.push({ level, text: remaining > 3 ? `${cut}…` : cut });
      used = limitBytes;
      return;
    }
    entries.push({ level, text });
    used += bytes;
  };
  const consoleObj: MutableGlobals = Object.create(null) as MutableGlobals;
  for (const level of ['log', 'warn', 'error'] as const) {
    consoleObj[level] = (...args: unknown[]): void => {
      push(level, args);
    };
  }
  for (const name of CONSOLE_NOOP) consoleObj[name] = (): undefined => undefined;
  target['console'] = Object.freeze(consoleObj);
  return {
    get entries(): readonly ConsoleEntry[] {
      return entries;
    },
    get truncated(): number {
      return truncated;
    },
  };
}

/** 冻结的 Math 副本，random 换成 mulberry32(seed)（§2.2、DESIGN §3.1b）。 */
function installMath(target: MutableGlobals, seed: number): void {
  const copy: MutableGlobals = Object.create(null) as MutableGlobals;
  for (const key of Object.getOwnPropertyNames(Math)) {
    const value: unknown = Reflect.get(Math, key) as unknown;
    copy[key] = value;
  }
  copy['random'] = mulberry32(seed);
  target['Math'] = Object.freeze(copy);
}

/** 替换 globalThis.Date；后门由 child-preload 在冻结前处理（fixed-date.ts）。 */
function installDate(target: MutableGlobals): void {
  target['Date'] = Object.freeze(createFixedDate(Date));
}

/** performance 替身：真实 performance 能读时间（§2.2 原就要求，F1 补上）。 */
function installPerformance(target: MutableGlobals): void {
  Object.defineProperty(target, 'performance', {
    value: Object.freeze({ now: (): number => 0 }),
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

/**
 * 按白名单删除全局：白名单之外删不掉就抛 `PG_PROTOCOL_ERROR`（child.ts 转成退出码 3 → 宿主
 * protocol-error，这是宿主缺陷，不静默）。symbol 键保留。
 */
function removeOtherGlobals(target: MutableGlobals): void {
  for (const key of Reflect.ownKeys(target)) {
    if (typeof key === 'symbol') continue;
    if (ALLOWED_GLOBALS.has(key)) continue;
    if (!Reflect.deleteProperty(target, key)) {
      throw new Error(`PG_PROTOCOL_ERROR: 删不掉全局 ${key}`);
    }
  }
}

/** 准备全局：替换、按白名单删除、挂 extras，最后冻结整个全局对象（§2.2、F1 顺序）。 */
export function prepareGlobals(target: MutableGlobals, options: PrepareOptions): ConsoleCapture {
  const capture = installConsole(target, options.consoleBytes);
  installMath(target, options.seed);
  installDate(target);
  installPerformance(target);
  removeOtherGlobals(target);
  for (const [name, value] of Object.entries(options.extras ?? {})) target[name] = value;
  Object.freeze(target);
  return capture;
}
