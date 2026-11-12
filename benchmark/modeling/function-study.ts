// 手写示例稿：不是 LLM 生成，也不作为模型能力证据；只用于 model:build 与 model:agent 的离线演练。
// 目的：证明草模代码是通用 TypeScript（自定义幂函数、贝塞尔、凸多边形、循环），不是预置形状白名单。
// 入口与约束见 packages/modeling/model.d.ts：export default function build(model: Model): void，无 import、同步。
export default function build(model: Model): void {
  // 1) 粗基座：只表达体量，不做家具、墙、台阶等施工细节。
  model.box({
    id: 'base',
    name: '粗基座',
    role: 'floor',
    color: '#8f8f8f',
    size: [40, 2, 40],
  });

  // 2) 幂函数收分屋面：半径 r = 12 * (1 - t) ** 1.8，随高度 22 * t 严格递增、收成尖顶。
  const powerRadius = (t: number): number => 12 * (1 - t) ** 1.8;
  model.revolve({
    id: 'power-roof',
    name: '幂函数收分屋面',
    role: 'roof',
    color: '#8899aa',
    profile: (t: number): Point2 => [powerRadius(t), 22 * t],
    profileSegments: 32,
    radialSegments: 48,
    transform: { translate: [-12, 2, 0] },
  });

  // 3) 贝塞尔自由曲面壳：用 model.bezier 采样拼母线，再绕 +y 轴旋转。
  const shell = (t: number): Point2 =>
    model.bezier(
      [
        [0, 0],
        [5, 0],
        [9, 5],
        [11, 12],
      ],
      t,
    );
  model.revolve({
    id: 'bezier-shell',
    name: '贝塞尔自由曲面壳',
    role: 'roof',
    color: '#778899',
    profile: shell,
    profileSegments: 24,
    radialSegments: 32,
    transform: { translate: [14, 2, 0] },
  });

  // 4) 凸五边形沿 +y 拉伸的体块；首尾不重复闭点（由实现规范化）。
  const pentagon: Point2[] = [
    [0, 0],
    [10, 0],
    [13, 7],
    [5, 12],
    [-3, 7],
  ];
  model.extrude({
    id: 'pentagon',
    name: '凸五边形体块',
    role: 'volume',
    color: '#b0a080',
    outline: pentagon,
    height: 9,
    transform: { translate: [0, 2, 20] },
  });
}
