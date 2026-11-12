/**
 * 变换求值与记录：把 translate / rotate / scale 应用到网格顶点，并解析缺省的单位变换。
 *
 * 负责：Euler XYZ 旋转（与 three.js `Euler.order='XYZ'` 一致，矩阵为 Rx·Ry·Rz），顶点变换
 * p' = translate + R · (scale ⊙ p)，缩放各轴 > 0（负数在 schema 已被拒）；返回新网格不改原件。
 * 不负责：schema 校验（schema.ts）、法线（浏览器端计算）。
 */
import type { MeshData } from './mesh.ts';
import { clean } from './mesh.ts';
import type { TransformDocument, TransformInput, Vec3 } from './schema.ts';

/** 把可选变换解析成齐全的记录形；缺省 translate=0、rotate=0、scale=1。 */
export function resolveTransform(input: TransformInput | undefined): TransformDocument {
  const translate = input?.translate;
  const rotate = input?.rotate;
  const scale = input?.scale;
  const t: Vec3 = [translate?.[0] ?? 0, translate?.[1] ?? 0, translate?.[2] ?? 0];
  const r: Vec3 = [rotate?.[0] ?? 0, rotate?.[1] ?? 0, rotate?.[2] ?? 0];
  const s: Vec3 = [scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1];
  return { translate: t, rotate: r, scale: s };
}

/** 应用变换，返回新网格；positions 里的 -0 统一规范成 0。 */
export function applyTransform(mesh: MeshData, transform: TransformDocument): MeshData {
  const [tx, ty, tz] = transform.translate;
  const [rx, ry, rz] = transform.rotate;
  const [sx, sy, sz] = transform.scale;
  const cx = Math.cos(rx);
  const sxr = Math.sin(rx);
  const cy = Math.cos(ry);
  const syr = Math.sin(ry);
  const cz = Math.cos(rz);
  const szr = Math.sin(rz);
  // R = Rx·Ry·Rz 展开（与 three.js Matrix4.makeRotationFromEuler('XYZ') 相同）。
  const r00 = cy * cz;
  const r01 = -cy * szr;
  const r02 = syr;
  const r10 = cx * szr + sxr * syr * cz;
  const r11 = cx * cz - sxr * syr * szr;
  const r12 = -sxr * cy;
  const r20 = sxr * szr - cx * syr * cz;
  const r21 = sxr * cz + cx * syr * szr;
  const r22 = cx * cy;
  const positions: number[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = (mesh.positions[i] ?? 0) * sx;
    const y = (mesh.positions[i + 1] ?? 0) * sy;
    const z = (mesh.positions[i + 2] ?? 0) * sz;
    positions.push(
      clean(r00 * x + r01 * y + r02 * z + tx),
      clean(r10 * x + r11 * y + r12 * z + ty),
      clean(r20 * x + r21 * y + r22 * z + tz),
    );
  }
  return { positions, indices: [...mesh.indices] };
}
