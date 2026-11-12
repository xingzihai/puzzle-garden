/** 镜像句柄作用域：句柄创建时记录镜像栈快照，作为锚点使用时当前栈必须以快照为前缀（R9）。 */
import type { z } from 'zod';
import type { mirrorSchema } from './schema.ts';

export type MirrorOptions = z.output<typeof mirrorSchema>;
interface HandleInfo {
  readonly name: string;
  readonly scope: readonly MirrorOptions[];
}

/** 句柄 → 创建时的构件名与镜像栈快照。 */
export class HandleScopes {
  readonly #info = new WeakMap<object, HandleInfo>();

  tag(handle: object, name: string, scope: readonly MirrorOptions[]): void {
    this.#info.set(handle, { name, scope });
  }

  info(handle: object): HandleInfo | undefined {
    return this.#info.get(handle);
  }

  /** 当前镜像栈不以快照为前缀就抛错；未登记的句柄放行。 */
  assert(handle: object, current: readonly MirrorOptions[]): void {
    const info = this.#info.get(handle);
    if (info === undefined) return;
    for (let i = 0; i < info.scope.length; i += 1) {
      const want = info.scope[i];
      if (want === undefined) return;
      const got = current[i];
      if (want.axis === got?.axis && want.at === got.at) continue;
      throw new Error(
        `${info.name} 建在 mirror({axis:'${want.axis}',at:${String(want.at)}}) 里，在镜像外使用只会作用到原侧。` +
          '请把这次调用移进同一个 mirror 回调；只想要单侧时，改用 footprint + y 显式写。',
      );
    }
  }
}
