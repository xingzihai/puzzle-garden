<!-- @precheck -->

# 提示词预检正向夹具

只用于 `tools/prompt-examples.test.ts` 的自测，不是模型可见提示词。

```ts
/** 空骨架：floorPlate → walls → opening → roof，只验证顺序与 API 形态。 */
function shell(w: World): void {
  const floorRect = rect(0, 0, 7, 5);
  const floor = w.floorPlate({ footprint: floorRect, y: 0, thickness: 1, material: 'stone_bricks' });
  const walls = w.walls({ footprint: floorRect, y: 1, height: 4, thickness: 1, material: 'stone_bricks' });
  w.opening({ in: walls.facade('north'), kind: 'door', width: 2, height: 2, sill: 0, at: 0 });
  const roof = w.roof({
    on: walls,
    kind: 'gable',
    ridge: 'x',
    peakY: 6,
    overhang: 1,
    thickness: 1,
    material: 'deepslate_tiles',
  });
  void floor;
  void roof;
}
```

```text
这段是纯文本骨架，不参与预检：const invalid: Bounds = null as never;
```
