/**
 * 测试进程的网络闸门（MODEL-SPEC §6.5、A2）：用 `node --import ./tools/test-no-network.ts` 加载本模块后，
 * `globalThis.fetch` 被换成直接抛错的函数，测试里任何漏网的真实 HTTP 请求都会立刻失败。
 *
 * mock 都是通过依赖注入替换 fetch（MODEL-SPEC §6），不读全局 fetch，因此不受影响；puppeteer 走 pipe，也不受影响。
 * 规格只要求换 `fetch`；`node:http` / `node:https` 的 request 不在拦截范围（Node 的 fetch/undici 也不经过它们）。
 */

/** 失败信息里必须写明"测试禁止真实网络"，坏样本据此判断确实被拦下。 */
export const NO_NETWORK_MESSAGE =
  '测试禁止真实网络请求（MODEL-SPEC §6.5）：请在测试里注入 mock fetch，不要调用 globalThis.fetch。';

/** 把目标对象上的 `fetch` 换成抛错函数；导出便于单测在独立对象上验证。 */
export function replaceFetch(target: { fetch: unknown } = globalThis): void {
  Object.defineProperty(target, 'fetch', {
    value: () => {
      throw new Error(NO_NETWORK_MESSAGE);
    },
    writable: true,
    configurable: true,
  });
}

replaceFetch();
