/** 从构件 schema 的输入 JSON Schema 生成声明与 API 说明；`candidate` 状态默认不向模型暴露。 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { componentSchemas, API_VERSION } from '@pg/geometry';
import type { ApiStatus } from '@pg/geometry';
import { loadRegistry } from '@pg/blocks/load';
import { format } from 'prettier';

/** 把 schema 节点的 description 折成一行 JSDoc；没有 description 就不输出。 */
function jsdoc(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const record = z.record(z.string(), z.unknown()).parse(value);
  const description = record['description'];
  if (typeof description !== 'string' || description === '') return '';
  // 描述来自仓库内 schema，仍防住 */ 提前结束注释。
  return `/** ${description.replace(/\*\//g, '* /')} */ `;
}

/** 互斥元数据里每组字段：同一组内至多出现一个，不同组不能同时出现。 */
function readGroups(value: unknown): readonly (readonly string[])[] {
  const parsed = z.array(z.array(z.string())).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * 把 schema 的互斥元数据展开成声明能表达的联合：
 * - `.meta({ pgExclusive })`：联合的各支把其它组的字段写成 `?: never`；
 * - `.meta({ pgAtMostOne })`：单对象把每组字段展开成"至多一个"的联合（其余写成 `?: never`）。
 * 生成器注入的哨兵 `{ pgNever: true }` 由 {@link schemaType} 映射成 TS 的 `never`。
 */
function applyExclusive(value: unknown): Record<string, unknown> {
  const schema = z.record(z.string(), z.unknown()).parse(value);
  const groups = [...readGroups(schema['pgExclusive']), ...readGroups(schema['pgAtMostOne'])];
  const out: Record<string, unknown> = { ...schema };
  delete out['pgExclusive'];
  delete out['pgAtMostOne'];
  if (groups.length === 0) return out;
  const unionKey = Array.isArray(out['anyOf']) ? 'anyOf' : Array.isArray(out['oneOf']) ? 'oneOf' : undefined;
  const branchArray = z.array(z.record(z.string(), z.unknown()));
  if (unionKey !== undefined) {
    out[unionKey] = branchArray.parse(out[unionKey]).map((branch) => {
      const props = { ...z.record(z.string(), z.unknown()).parse(branch['properties'] ?? {}) };
      for (const group of groups) {
        if (group.some((key) => key in props)) continue;
        for (const key of group) props[key] = { pgNever: true };
      }
      return { ...branch, properties: props };
    });
    return out;
  }
  if (out['type'] === 'object') {
    const props = z.record(z.string(), z.unknown()).parse(out['properties'] ?? {});
    let combos: (string | undefined)[][] = [[]];
    for (const group of groups) combos = combos.flatMap((combo) => [undefined, ...group].map((x) => [...combo, x]));
    return {
      ...out,
      anyOf: combos.map((combo) => {
        const variant = { ...props };
        for (const group of groups) for (const key of group) if (!combo.includes(key)) variant[key] = { pgNever: true };
        return { ...out, properties: variant };
      }),
    };
  }
  return out;
}

export function schemaType(value: unknown, property = '', materialType = 'Material'): string {
  const schema = z.record(z.string(), z.unknown()).parse(value);
  if (schema['pgNever'] === true) return 'never';
  if (property === 'material' || property === 'fill' || property === 'block') {
    return property === 'material' ? materialType : 'Material';
  }
  // 函数型字段（surfaceShell 的 position / profile）：schema 里无法用 JSON Schema 表达，
  // 由 `.meta({ pgType })` 给出 TS 函数类型原文，声明直接输出。
  if (typeof schema['pgType'] === 'string') return schema['pgType'];
  // schema.ts 用 `.meta({ pgOpaque })` 标出只能由当前世界返回值产生的锚点类型：声明里折叠成不透明类型，
  // 不展开内部字段。`on` / `along` / `from` / `to` / `under` 还接受带 `top` 的句柄。
  const opaque = schema['pgOpaque'];
  if (typeof opaque === 'string')
    return opaque === 'Surface' && ['on', 'along', 'from', 'to', 'under'].includes(property)
      ? 'Surface | { readonly top: Surface }'
      : opaque;
  if (schema['const'] !== undefined) return JSON.stringify(schema['const']);
  if (Array.isArray(schema['enum'])) return schema['enum'].map((x: unknown) => JSON.stringify(x)).join(' | ');
  const union = schema['anyOf'] ?? schema['oneOf'];
  if (Array.isArray(union)) return union.map((x: unknown) => `(${schemaType(x, '', materialType)})`).join(' | ');
  switch (schema['type']) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      if (Array.isArray(schema['prefixItems']))
        return `readonly [${schema['prefixItems'].map((x: unknown) => schemaType(x)).join(', ')}]`;
      return `readonly (${schemaType(schema['items'])})[]`;
    }
    case 'object': {
      const props = z.record(z.string(), z.unknown()).parse(schema['properties'] ?? {});
      const additional = schema['additionalProperties'];
      // 无固定字段、只有 additionalProperties 的对象（z.record）生成 Record，不写成空对象 `{}`。
      if (Object.keys(props).length === 0 && additional !== undefined && additional !== false)
        return `Record<string, ${schemaType(additional)}>`;
      const required = z.array(z.string()).parse(schema['required'] ?? []);
      return `{ ${Object.entries(props)
        .map(
          ([k, v]) =>
            `${jsdoc(v)}readonly ${JSON.stringify(k)}${required.includes(k) ? '' : '?'}: ${schemaType(v, k, materialType)};`,
        )
        .join(' ')} }`;
    }
    default:
      throw new Error(`无法生成声明：未支持的 schema ${JSON.stringify(schema)}`);
  }
}

const RETURNS: Record<string, string> = {
  plinth: '{ readonly bounds: Bounds; readonly top: Surface; edge(side: Side): Facade }',
  walls:
    '{ readonly bounds: Bounds; readonly top: Surface; readonly inner: Surface; facade(side: Side): Facade; storey(i: number): Surface }',
  opening: 'Opening',
  floorPlate: '{ readonly bounds: Bounds; readonly top: Surface; readonly region: Surface }',
  stair: '{ readonly bounds: Bounds; readonly path: readonly Point[] }',
  steps: '{ readonly bounds: Bounds; readonly path: readonly Point[] }',
  roof: '{ readonly bounds: Bounds; readonly top?: Surface; readonly peak: Point; readonly eaveLine: Surface }',
  colonnade: '{ readonly bounds: Bounds; readonly top: Surface; readonly bays: readonly Surface[] }',
  rail: '{ readonly bounds: Bounds }',
  enclosure:
    '{ readonly bounds: Bounds; readonly inner: Surface; readonly gate: Opening; /** 传了 gate.gatehouse 时必有 */ readonly gatehouse?: { readonly bounds: Bounds; /** 门楼顶面，屋面挂这里 */ readonly top: Surface } }',
  paving: '{ readonly bounds: Bounds }',
  // 草模导入的句柄含每部件信息与体素化 counts；用内联类型描述，声明不引入新的共享类型。
  massingImport:
    '{ readonly bounds: Bounds | null; readonly parts: readonly { readonly id: string; readonly name: string; readonly role: "volume" | "roof" | "floor" | "connection"; readonly bounds: Bounds | null; readonly cellCount: number }[]; readonly counts: { readonly parts: number; readonly cells: number; readonly triangles: number; readonly shellParts: number; readonly solidParts: number; readonly emptyParts: number; readonly leakyParts: number; readonly isolatedCells: number; readonly isolatedRemoved: number } }',
  // 参数化壳的句柄：世界包围盒 + 计数 + solid 开放壳回退标记（SURFACE-SHELL-SPEC §4）。
  surfaceShell: '{ readonly bounds: Bounds; readonly cellCount: number; readonly leaky: boolean }',
};

/** 生成器读的构件登记表形状；生产用 `componentSchemas`，测试可传构造的假表。 */
export interface ComponentEntry {
  readonly schema: z.ZodType;
  readonly status: ApiStatus;
}
export type ComponentRegistry = Readonly<Record<string, ComponentEntry>>;

/** 构造待排版的参数类型与方法签名；评分卡从排版后的实际声明提取，而不是对这些中间字符串计数。 */
function componentSection(
  name: string,
  entry: ComponentEntry,
): {
  readonly declaration: string;
  readonly method: string;
} {
  const json = z.toJSONSchema(entry.schema, { io: 'input' });
  const root = z.record(z.string(), z.unknown()).parse(json);
  // stair / steps 的 material 在声明里收窄成楼梯类方块名（schema 用 pgMaterial 标记）。
  const materialType = root['pgMaterial'] === 'stair' ? 'StairMaterial' : 'Material';
  const options = schemaType(applyExclusive(json), '', materialType);
  const declaration =
    name === 'steps'
      ? `type stepsOptions = Omit<${options}, 'to'> & { readonly to: Opening | Facade };`
      : options.startsWith('{')
        ? `interface ${name}Options ${options}`
        : `type ${name}Options = ${options};`;
  // massingImport 的签名是 (id, options?)，其余构件统一 (options)（MASSING-CONVERSION-SPEC §5.3）。
  const signature =
    name === 'massingImport'
      ? `massingImport(id: string, options?: ${name}Options)`
      : `${name}(options: ${name}Options)`;
  const method = `/** ${entry.schema.description ?? ''} */\n${signature}: ${RETURNS[name] ?? 'never'};`;
  return { declaration, method };
}

/** 说明里每个不透明锚点只保留一句用途，不展开内部字段。 */
const OPAQUE_DOC: Record<string, string> = {
  Footprint:
    '占地轮廓：手写时用 rect(minX, minZ, maxX, maxZ) 或 { points: [[x, z], …] }，也可直接用当前世界句柄或锚点上的 footprint。',
  Surface: '表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。',
  Facade: "立面锚点：只能使用当前世界构件返回的立面，如 hall.facade('north')、base.edge('south')。",
  Opening:
    "洞口或入口锚点：只能使用当前世界构件返回的门洞、院门或台基边，如 hall.facade('north').opening(0)、court.gate。",
};

/** 把说明用的 JSON Schema 里带 `pgOpaque` 的节点折叠成短节点，去掉品牌位与内部字段。 */
function opaqueDoc(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map((item) => opaqueDoc(item));
  }
  if (typeof value !== 'object' || value === null) return value;
  const record = z.record(z.string(), z.unknown()).parse(value);
  const opaque = record['pgOpaque'];
  if (typeof opaque === 'string')
    return { description: OPAQUE_DOC[opaque] ?? `${opaque}：只能使用当前世界构件的返回值。`, 'x-opaque': opaque };
  // 函数型字段在说明里用短节点表示，不把 TS 类型塞进 JSON。
  if (typeof record['pgType'] === 'string') {
    const node: Record<string, unknown> = { 'x-function': record['pgType'] };
    if (typeof record['description'] === 'string') node['description'] = record['description'];
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    // 去噪：JSON Schema 的样板与 z.int() 的安全整数哨兵上下限对模型没有信息量。
    if (key === '$schema' || key === 'readOnly' || key === 'additionalProperties') continue;
    // 生成声明用的互斥 / 材质 / 函数类型元数据不进说明文本。
    if (['pgExclusive', 'pgAtMostOne', 'pgNever', 'pgChoices', 'pgMaterial', 'pgType'].includes(key)) continue;
    if ((key === 'minimum' || key === 'maximum') && (item === 9007199254740991 || item === -9007199254740991)) continue;
    out[key] = opaqueDoc(item);
  }
  return out;
}

export function generateWorld(
  blocks: readonly string[],
  includeCandidates = false,
  schemas: ComponentRegistry = componentSchemas,
): { readonly declaration: string; readonly documentation: string } {
  // 材质只保留裸名与 `名字[属性]` 两种写法（§12 第 1 条，决策 #74）：去掉 `minecraft:` 前缀的模板能显著降低预检耗时。
  // 运行期 parseState 仍接受 `minecraft:` 前缀（CORE-SPEC §3），只是声明里不再放行，把用法约束在规范形式上。
  const stairBlocks = blocks.filter((s) => s.endsWith('_stairs'));
  const material =
    `type BlockName = ${blocks.map((s) => JSON.stringify(s)).join(' | ')};\n` +
    // 带状态写法的名字部分放宽为 string（决策 #90）：`${BlockName}[…]` 会展开成上千个模板成员，
    // 三元、`??`、数组字面量合并两个 Material 时触发 TS2590。裸名拼错仍由 BlockName 抓；带状态的拼错交给运行期 parseState。
    `type Material = BlockName | \`\${string}[\${string}]\`;\n` +
    `type StairBlockName = ${stairBlocks.length === 0 ? 'never' : stairBlocks.map((s) => JSON.stringify(s)).join(' | ')};\n` +
    `type StairMaterial = StairBlockName | \`\${string}_stairs[\${string}]\`;`;
  const header = `// 自动生成，勿手改。API ${String(API_VERSION)}。${includeCandidates ? '开发用全量声明，不用于模型提示。' : '模型可见：只含离线通过构件及兜底入口。'}\nexport { World, Material, rect, Surface, Facade };\n`;
  // 锚点类只暴露模型能读的公开字段，并用不可导出的品牌位阻止对象字面量伪造；内部字段（polygon / apse /
  // storeyHeight / corner）不在这里出现。模型要建占地时用 rect(...) 或 { points: [...] }。
  const shared = `type Point = readonly [number, number, number];\ntype Side = 'north' | 'south' | 'east' | 'west';\ndeclare const brand: unique symbol;\ninterface Footprint { readonly minX: number; readonly minZ: number; readonly maxX: number; readonly maxZ: number; readonly [brand]: 'footprint' }\ninterface Surface { readonly footprint: Footprint; readonly y: number; readonly [brand]: 'surface' }\ninterface Bounds { readonly min: Point; readonly max: Point }\ninterface Opening { readonly bounds: Bounds; readonly side: Side; readonly [brand]: 'opening' }\ninterface Facade { readonly footprint: Footprint; readonly y: number; readonly side: Side; readonly height: number; readonly thickness: number; opening(i: number): Opening; readonly [brand]: 'facade' }\n`;
  const declarations: string[] = [];
  const methods: string[] = [];
  const docs: string[] = [];
  for (const [name, entry] of Object.entries(schemas)) {
    if (!includeCandidates && entry.status === 'candidate') continue;
    const schema = z.toJSONSchema(entry.schema, { io: 'input' });
    const section = componentSection(name, entry);
    declarations.push(section.declaration);
    methods.push(section.method);
    docs.push(
      `## ${name}\n\n${entry.schema.description ?? ''}\n\n状态：${entry.status}\n\n\`\`\`json\n${JSON.stringify(opaqueDoc(schema), null, 2)}\n\`\`\`\n`,
    );
  }
  const primitives = `set(x: number, y: number, z: number, block: Material, writeLayer?: 'opening' | 'structure' | 'decoration'): void;\nbox(from: Point, to: Point, block: Material, writeLayer?: 'opening' | 'structure' | 'decoration'): void;\nget(x: number, y: number, z: number): string;\npart(name: string, fn: () => void): void;\nmirror(options: { readonly axis: 'x' | 'z'; readonly at: number }, fn: () => void): void;`;
  return {
    declaration: `${header}${material}\n${shared}${declarations.join('\n')}\ninterface World {\n${primitives}\n${methods.join('\n')}\n}\ndeclare function rect(minX: number, minZ: number, maxX: number, maxZ: number): Footprint;\n`,
    documentation: `# 构件 API 说明（自动生成，状态见各节）\n\n${docs.join('\n')}`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const registry = loadRegistry();
  const blocks = [...registry.table.blocks.keys()].sort();
  const candidate = generateWorld(blocks, true);
  const options = { parser: 'typescript', singleQuote: true, printWidth: 120 };
  writeFileSync(
    new URL('../packages/geometry/world.candidate.d.ts', import.meta.url),
    await format(candidate.declaration, options),
  );
  writeFileSync(
    new URL('../packages/geometry/world.d.ts', import.meta.url),
    await format(generateWorld(blocks).declaration, options),
  );
  writeFileSync(
    new URL('../generated/WORLD-API-GENERATED.md', import.meta.url),
    await format(candidate.documentation, { parser: 'markdown', printWidth: 120 }),
  );
}
