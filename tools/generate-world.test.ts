/** 声明生成器的类型与状态过滤，不执行模型预检。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { format } from 'prettier';
import { z } from 'zod';
import { loadRegistry } from '@pg/blocks/load';
import { API_VERSION } from '@pg/geometry';
import { generateWorld, schemaType } from './generate-world.ts';
import type { ComponentRegistry } from './generate-world.ts';
test('只从 schema 导出输入类型，离线通过构件默认可见', () => {
  const visible = generateWorld(['stone', 'oak_stairs']);
  assert(visible.declaration.includes('roof(options'));
  assert(visible.declaration.includes('set(x: number'));
  const all = generateWorld(['stone', 'oak_stairs'], true);
  assert(all.declaration.includes('roof(options'));
  assert(all.declaration.includes('readonly "material": Material'));
  assert(all.documentation.includes('offline-pass'));
  const source = ts.createSourceFile('world.d.ts', all.declaration, ts.ScriptTarget.Latest, true);
  assert(source.statements.length > 10);
});

test('生成声明头部与 @pg/geometry 的 API_VERSION 同源（SANDBOX-SPEC §10 第 14 条）', () => {
  const blocks = [...loadRegistry().table.blocks.keys()].sort();
  for (const candidate of [false, true]) {
    const { declaration } = generateWorld(blocks, candidate);
    assert(declaration.startsWith(`// 自动生成，勿手改。API ${String(API_VERSION)}。`));
  }
  const visible = readFileSync(new URL('../packages/geometry/world.d.ts', import.meta.url), 'utf8');
  assert(visible.includes(`API ${String(API_VERSION)}。`), '模型可见声明头部应为当前 API 版本');
});

test('材质声明收窄到裸名与 name[props]：minecraft: 前缀预检报错，拼错名仍有建议', () => {
  const blocks = ['stone', 'stone_bricks'];
  const minecraft = diagnostics(false, "declare const w: World; w.set(0,1,0,'minecraft:stone');", undefined, blocks);
  const minecraftText = minecraft.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n');
  assert(
    minecraft.some((d) => d.code === 2345 || d.code === 2820) && minecraftText.includes('Material'),
    'minecraft:stone 应因不属于 Material 而报错',
  );
  const typo = diagnostics(
    false,
    "declare const w: World; w.plinth({ footprint: rect(0,0,2,2), height: 1, material: 'stone_brikcs' });",
    undefined,
    blocks,
  );
  const typoText = typo.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n');
  assert(
    typo.some((d) => d.code === 2820),
    '拼错方块名应报 TS2820',
  );
  assert(typoText.includes('Did you mean') && typoText.includes('stone_bricks'), '拼错方块名应给 stone_bricks 建议');
  assert.deepEqual(
    diagnostics(false, "declare const w: World; w.set(0,1,0,'stone_bricks[waterlogged=true]');", undefined, blocks).map(
      (d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    ),
    [],
  );
});
test('默认按状态过滤：候选构件不进模型可见声明，开发声明仍含', () => {
  const schemas: ComponentRegistry = {
    gadget: { schema: z.object({ size: z.number() }), status: 'candidate' },
    visible: { schema: z.object({ size: z.number() }), status: 'offline-pass' },
  };
  const visible = generateWorld(['stone'], false, schemas);
  assert(visible.declaration.includes('visible(options'));
  assert(!visible.declaration.includes('gadget(options'));
  const all = generateWorld(['stone'], true, schemas);
  assert(all.declaration.includes('gadget(options'));
  assert(all.declaration.includes('visible(options'));
});
test('基本 JSON Schema 类型及未知类型拒绝', () => {
  assert.equal(schemaType({ type: 'boolean' }), 'boolean');
  assert.equal(schemaType({ type: 'null' }), 'null');
  assert.equal(schemaType({ type: 'array', items: { type: 'number' } }), 'readonly (number)[]');
  assert.throws(() => schemaType({ type: 'mystery' }), /未支持/);
});

test('pgOpaque 标记折叠成不透明锚点类型，Surface 键还接受带 top 的句柄', () => {
  assert.equal(schemaType({ pgOpaque: 'Facade' }), 'Facade');
  assert.equal(schemaType({ pgOpaque: 'Footprint' }), 'Footprint');
  assert.equal(schemaType({ pgOpaque: 'Surface', type: 'object' }, 'on'), 'Surface | { readonly top: Surface }');
  assert.equal(schemaType({ pgOpaque: 'Surface' }, 'in'), 'Surface');
});

test('pgType 元数据按原文输出函数类型，说明折成 x-function 短节点（M3）', () => {
  assert.equal(
    schemaType({ pgType: '(u: number, v: number) => readonly [number, number]', type: 'object' }),
    '(u: number, v: number) => readonly [number, number]',
  );
  const blocks = [...loadRegistry().table.blocks.keys()].sort();
  const { declaration, documentation } = generateWorld(blocks, true);
  // generateWorld 返回未排版文本：属性名带引号，入库文件由 Prettier 去引号。
  assert.match(declaration, /readonly "position": \(u: number, v: number\) => readonly \[number, number, number\]/);
  assert.match(declaration, /readonly "profile": \(t: number\) => readonly \[number, number\]/);
  assert(!declaration.includes('pgType'), '声明里不应出现生成器元数据键');
  assert(documentation.includes('"x-function"'));
  assert(!documentation.includes('pgType'));
});

test('surfaceShell 预检：好样本两类 kind 通过，坏样本报错（M3）', () => {
  const good = `declare const w: World;
    w.surfaceShell({ kind: 'surface', position: (u, v) => [u, v, 0], closedU: true, material: 'stone' });
    w.surfaceShell({ kind: 'revolve', profile: (t) => [1 - t, t], solid: true, material: 'stone' });`;
  assert.deepEqual(
    diagnostics(false, good).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    [],
  );
  const bad = `declare const w: World;
    w.surfaceShell({ kind: 'surface', position: (u: number, v: number) => [u, v], material: 'stone' });
    w.surfaceShell({ kind: 'revolve', material: 'stone' });`;
  const messages = diagnostics(false, bad).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  assert(messages.length >= 2, `两条都应报错：${messages.join(' | ')}`);
});

test('API 说明把不透明锚点折叠成短节点，不残留内部字段', () => {
  const blocks = [...loadRegistry().table.blocks.keys()].sort();
  const { documentation } = generateWorld(blocks, true);
  for (const field of ['pgOpaque', 'polygon', 'storeyHeight', 'corner'])
    assert(!documentation.includes(`"${field}"`), `说明不应包含 ${field}`);
  assert(!/"apse"\s*:/.test(documentation), '说明不应把 apse 当字段列出（outline 的合法取值除外）');
  for (const name of ['Footprint', 'Surface', 'Facade', 'Opening'])
    assert(documentation.includes(`"x-opaque": "${name}"`), `说明应折叠 ${name}`);
  assert(documentation.includes('rect(minX, minZ, maxX, maxZ)'));
});

test('R12 说明去掉 JSON Schema 样板，声明参数带 JSDoc', () => {
  const blocks = [...loadRegistry().table.blocks.keys()].sort();
  const { declaration, documentation } = generateWorld(blocks, true);
  for (const noise of ['9007199254740991', 'readOnly', '$schema'])
    assert(!documentation.includes(noise), `说明不应包含 ${noise}`);
  assert(!documentation.includes('"additionalProperties"'), '说明不应包含 additionalProperties');
  assert(/\*\*[^*]*洞底距站立面[^*]*\*\/\s*readonly "?sill"?/.test(declaration), 'opening 的 sill 应有 JSDoc');
  assert(declaration.includes('洞中心相对立面中点的偏移'), 'opening.at 说明应进声明');
});

/** 把生成声明与给定代码拼成一个虚拟文件编译，返回诊断；好坏样本共用。 */
function diagnostics(
  candidate: boolean,
  body: string,
  schemas?: ComponentRegistry,
  blocks: readonly string[] = ['stone', 'stone_brick_stairs'],
): readonly ts.Diagnostic[] {
  const source = generateWorld([...blocks], candidate, schemas).declaration + '\n' + body;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    skipLibCheck: false,
  };
  const host = ts.createCompilerHost(options);
  const previous = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language, error, fresh): ts.SourceFile | undefined =>
    file === '/virtual/world.ts'
      ? ts.createSourceFile(file, source, language, true)
      : previous(file, language, error, fresh);
  const program = ts.createProgram(['/virtual/world.ts'], options, host);
  return ts.getPreEmitDiagnostics(program);
}

test('生成声明能检查句柄关系与材质拼写，被过滤的候选构件不可调用', () => {
  const good = `declare const w: World;
    const base = w.plinth({ footprint: rect(-5,-5,5,5), height: 2, material: 'stone' });
    w.plinth({ footprint: { points: [[0,0],[4,0],[0,3]] }, height: 1, material: 'stone' });
    const hall = w.walls({ on: base, storeys: { count: 2, height: 6 }, material: 'stone' });
    const low = w.floorPlate({ in: hall.storey(0), material: 'stone' });
    const high = w.floorPlate({ in: hall.storey(1), material: 'stone' });
    w.stair({ from: low, to: high, at: [0,0], kind: 'spiral', radius: 2, material: 'stone_brick_stairs' });
    const door = hall.facade('south').opening(0);
    w.steps({ to: door, width: 3, material: 'stone_brick_stairs' });
    w.paving({ from: door, to: 4, width: 2, material: 'stone' });
    const span = base.top.footprint.maxX - base.top.footprint.minX;
    const floorY = hall.storey(1).y;
    const edgeFacade = base.edge('south');
    const side = edgeFacade.side;
    const bounds = door.bounds;
    void [span, floorY, side, bounds];`;
  assert.deepEqual(
    diagnostics(true, good).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    [],
  );
  // 12 个构件全部离线通过后，模型可见声明与开发声明都接受这段代码。
  assert.deepEqual(
    diagnostics(false, good).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    [],
  );
  // 用构造的假候选确认：模型可见声明过滤掉候选构件，开发声明仍保留。
  const fake: ComponentRegistry = { gadget: { schema: z.object({ size: z.number() }), status: 'candidate' } };
  const call = 'declare const w: World; w.gadget({ size: 1 });';
  assert(diagnostics(false, call, fake).some((d) => d.code === 2339));
  assert.deepEqual(
    diagnostics(true, call, fake).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    [],
  );
  assert(diagnostics(true, "declare const w: World; w.set(0,1,0,'stnoe');").some((d) => d.code === 2345));
});

test('声明隐藏锚点内部字段，并拒绝对象字面量伪造锚点', () => {
  const hidden = `declare const w: World;
    const base = w.plinth({ footprint: rect(0,0,2,2), height: 1, material: 'stone' });
    base.top.footprint.polygon;
    base.top.footprint.apse;
    const hall = w.walls({ footprint: rect(0,0,6,6), y: 1, height: 6, material: 'stone' });
    hall.facade('north').storeyHeight;
    hall.facade('north').corner;`;
  const hiddenCodes = diagnostics(true, hidden).map((d) => ({
    code: d.code,
    text: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  }));
  for (const field of ['polygon', 'apse', 'storeyHeight', 'corner'])
    assert(
      hiddenCodes.some((d) => d.code === 2339 && d.text.includes(field)),
      `应拒绝访问 .${field}`,
    );

  const forged = `declare const w: World;
    w.plinth({ footprint: { minX: 0, minZ: 0, maxX: 2, maxZ: 2 }, height: 1, material: 'stone' });
    w.floorPlate({ in: { footprint: rect(0,0,4,4), y: 1 }, material: 'stone' });
    w.opening({ in: { footprint: rect(0,0,4,4), y: 1, height: 4, thickness: 1, side: 'north' }, kind: 'door', width: 1, height: 2, material: 'stone' });`;
  const forgedMessages = diagnostics(true, forged).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  for (const [i, type] of ['Footprint', 'Surface', 'Facade'].entries())
    assert(
      forgedMessages.some((text) => text.includes('[brand]') && text.includes(type)),
      `第 ${String(i + 1)} 个对象字面量应因缺少品牌位被拒`,
    );
});

test('入库声明与说明必须等于当前 schema 生成结果', async () => {
  const blocks = [...loadRegistry().table.blocks.keys()].sort();
  for (const candidate of [false, true]) {
    const generated = generateWorld(blocks, candidate);
    const file = candidate ? 'world.candidate.d.ts' : 'world.d.ts';
    assert.equal(
      readFileSync(new URL(`../packages/geometry/${file}`, import.meta.url), 'utf8'),
      await format(generated.declaration, { parser: 'typescript', singleQuote: true, printWidth: 120 }),
    );
    if (candidate)
      assert.equal(
        readFileSync(new URL('../generated/WORLD-API-GENERATED.md', import.meta.url), 'utf8'),
        await format(generated.documentation, { parser: 'markdown', printWidth: 120 }),
      );
  }
});

test('互斥字段用 ?: never，楼梯材质收窄，canopy / frame 有 JSDoc（API 4）', async () => {
  const blocks = [...loadRegistry().table.blocks.keys()].sort();
  // 生成器返回未排版文本；按入库口径排版后再断言，属性名的引号会被 Prettier 去掉。
  const declaration = await format(generateWorld(blocks, false).declaration, {
    parser: 'typescript',
    singleQuote: true,
    printWidth: 120,
  });
  // walls：on 支排除 footprint / y，footprint + y 支排除 on。
  assert.match(declaration, /readonly on: Surface \| \{ readonly top: Surface \}[\s\S]*?readonly footprint\?: never;/);
  assert.match(declaration, /readonly on\?: never;/);
  // roof：pitch 与 peakY 至多一个。
  assert.match(declaration, /readonly pitch\?: number;\s*readonly peakY\?: never;/);
  assert.match(declaration, /readonly peakY\?: number;/);
  // stair / steps 的 material 收窄成楼梯类方块名。
  assert.match(declaration, /type StairBlockName =[^;]*_stairs/);
  assert.match(declaration, /type StairMaterial = StairBlockName/);
  assert.match(declaration, /readonly material: StairMaterial;/);
  // canopy / frame 的 JSDoc 进声明。
  assert.match(declaration, /洞顶外挑的雨棚/);
  assert.match(declaration, /外侧一圈框/);
});

test('预检拦住 walls 的 on + footprint 与 roof 的 pitch + peakY', () => {
  const bad = `declare const w: World;
    declare const s: Surface;
    w.walls({ on: s, footprint: rect(0, 0, 2, 2), y: 1, height: 3, material: 'stone' });
    w.roof({ footprint: rect(0, 0, 2, 2), y: 1, kind: 'gable', pitch: 1, peakY: 5, material: 'stone' });`;
  const messages = diagnostics(false, bad, undefined, ['stone']).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  );
  assert(messages.length >= 2, `两条都应报错：${messages.join(' | ')}`);
  assert(
    messages.some((m) => m.includes('undefined')),
    `互斥字段应写成 undefined / never：${messages.join(' | ')}`,
  );
});

test('全量方块名下合并两个 Material 不报 TS2590，裸名拼错仍报（决策 #90）', () => {
  const blocks = [...loadRegistry().table.blocks.keys()].sort();
  // 真实运行里触发 TS2590 的写法：三元直接当参数、三元赋给 const、`??`、数组字面量、返回三元的箭头函数。
  const merged = `declare const w: World;
    declare const flag: boolean;
    declare const fill: ((x: number) => Material) | undefined;
    const A = 'stone_bricks' as Material;
    const B = 'quartz_block' as Material;
    w.set(0, 1, 0, flag ? A : B);
    const m: Material = flag ? A : flag ? B : 'stone';
    const n = fill?.(0) ?? A;
    const list: Material[] = [A, B];
    const pick = (i: number): Material => (i % 2 === 0 ? A : B);
    w.set(0, 2, 0, m); w.set(0, 3, 0, n); w.set(0, 4, 0, list[0] ?? A); w.set(0, 5, 0, pick(1));
    w.set(0, 6, 0, \`stone_brick_stairs[facing=\${flag ? 'east' : 'west'}]\`);`;
  const codes = diagnostics(false, merged, undefined, blocks).map((d) => d.code);
  assert(!codes.includes(2590), `不应再报 TS2590：${codes.join(',')}`);
  assert.deepEqual(codes, []);
  const typo = diagnostics(false, "declare const w: World; w.set(0,1,0,'stone_brikcs');", undefined, blocks);
  assert(
    typo.some((d) => d.code === 2345 || d.code === 2820),
    '裸名拼错仍应报错',
  );
});

test('楼梯材质预检拦住非楼梯方块', () => {
  const bad = `declare const w: World;
    declare const a: Surface;
    declare const b: Surface;
    w.stair({ from: a, to: b, at: [0, 0], kind: 'straight', material: 'stone' });`;
  const messages = diagnostics(false, bad, undefined, ['stone', 'oak_stairs']).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  );
  assert(messages.length > 0, 'stone 不属于 StairMaterial，应报错');
  const withState = diagnostics(
    false,
    `declare const w: World;
    declare const a: Surface;
    declare const b: Surface;
    w.stair({ from: a, to: b, at: [0, 0], kind: 'straight', material: 'stone[foo=bar]' });`,
    undefined,
    ['stone', 'oak_stairs'],
  );
  assert(withState.length > 0, '带状态的非楼梯名也不属于 StairMaterial');
});
