/**
 * 查看器页面外壳（MASSING-SPEC §3）。
 *
 * 负责：产出一整页 HTML（内联 CSS、three 的 importmap、指向 `/page/main.ts` 的模块脚本），
 * 并提供左控制栏、主体 3D、右检查/详情面板所需的稳定 id 与明确文案。
 * 不负责：任何几何、模型或 three 代码（都在 `page/*.ts`，由服务端擦除类型后单独提供）；
 * 本文件不含内联模型代码，只交给浏览器一个空的 DOM 骨架与一个脚本入口。
 */

/** 页面外壳的类型别名：服务端把返回值直接写进 HTML 响应。 */
export interface ViewerShellOptions {
  /** 页面标题；缺省为“三维草模查看器”。 */
  readonly title?: string;
}

const DEFAULT_TITLE = '三维草模查看器';

/**
 * 生成查看器 HTML。`title` 会做最小转义（只允许作为文本节点，拒绝标签与引号）。
 * 输出是纯函数：同参数同结果，不含时间或随机值。
 */
export function viewerHtml(options: ViewerShellOptions = {}): string {
  const title = options.title === undefined ? DEFAULT_TITLE : escapeText(options.title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: light; --line: #d5dbe3; --ink: #1f2933; --muted: #5c6b7a; --panel: #f7f9fc; --accent: #2f6fed; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { font: 13px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #eef1f5; }
#app { display: grid; grid-template-columns: 264px minmax(0, 1fr) 336px; grid-template-rows: 48px 1fr; height: 100vh; }
#app > header { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; padding: 0 16px; background: #fff; border-bottom: 1px solid var(--line); }
#app > header h1 { font-size: 15px; margin: 0; font-weight: 600; }
.badge { font-size: 12px; color: #8a5a00; background: #fff3d6; border: 1px solid #f0d48a; border-radius: 10px; padding: 1px 8px; }
.badge.drill { color: #6b3fa0; background: #f3ebff; border-color: #d9c4ff; }
#controls { overflow: auto; padding: 12px; background: var(--panel); border-right: 1px solid var(--line); }
#viewport { position: relative; min-width: 0; min-height: 0; background: #dfe5ec; }
#viewport canvas { display: block; width: 100%; height: 100%; }
#inspector { overflow: auto; padding: 12px; background: #fff; border-left: 1px solid var(--line); }
fieldset { border: 1px solid var(--line); border-radius: 6px; margin: 0 0 12px; padding: 8px 10px 10px; background: #fff; }
legend { font-weight: 600; color: var(--muted); padding: 0 4px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 7px 0; }
.row > label { color: var(--muted); }
select, input[type="range"] { max-width: 130px; }
select { padding: 2px 4px; border: 1px solid var(--line); border-radius: 4px; background: #fff; color: inherit; }
button { border: 1px solid var(--line); background: #fff; border-radius: 4px; padding: 4px 10px; cursor: pointer; color: inherit; }
button:hover { border-color: var(--accent); color: var(--accent); }
.buttons { display: flex; gap: 8px; margin-top: 4px; }
.hint { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
.notes { margin: 6px 0 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
.notes li { margin: 3px 0; }
section h2 { font-size: 13px; margin: 14px 0 6px; }
#selection-details, #changes-summary, #report { font-size: 12px; }
dl.kv { display: grid; grid-template-columns: 72px 1fr; gap: 2px 8px; margin: 0; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; word-break: break-word; }
.status-pass { color: #1d7a44; font-weight: 600; }
.status-issues { color: #b3261e; font-weight: 600; }
#status:empty { display: none; }
#status { padding: 6px 12px; font-size: 12px; border-radius: 4px; margin: 8px 0 0; }
#status.error { background: #fdecea; color: #b3261e; border: 1px solid #f5c2be; }
ul.issues { margin: 4px 0 0; padding-left: 16px; }
ul.issues li { margin: 3px 0; }
</style>
<script type="importmap">
{"imports":{"three":"/vendor/three.module.js","three/addons/":"/vendor/addons/"}}
</script>
</head>
<body>
<div id="app">
  <header>
    <h1>${title}</h1>
    <span class="badge">概念草模</span>
    <span class="badge drill">预制修改演练 · 非自然语言 agent</span>
  </header>

  <aside id="controls">
    <fieldset>
      <legend>查看</legend>
      <div class="row">
        <label for="example">样例</label>
        <select id="example">
          <option value="plaza">地下广场（粗体量）</option>
          <option value="roof">圆厅旋转壳屋面</option>
        </select>
      </div>
      <div class="row">
        <label for="variant">版本</label>
        <select id="variant">
          <option value="base">base（原始）</option>
          <option value="wider-shop">wider-shop（加宽衣服店）</option>
          <option value="wider-cinema">wider-cinema（加宽西影厅）</option>
        </select>
      </div>
      <div class="row">
        <label for="level">楼层</label>
        <select id="level">
          <option value="all">全部（地下）</option>
          <option value="surface">surface（地表与街面）</option>
          <option value="b1">b1（商业与站厅）</option>
          <option value="b2">b2（站台）</option>
          <option value="b3">b3（影院）</option>
        </select>
      </div>
      <div class="row">
        <label for="surface">显示地表实体</label>
        <input type="checkbox" id="surface">
      </div>
      <div class="row">
        <label for="spaces">显示空间范围</label>
        <input type="checkbox" id="spaces" checked>
      </div>
      <div class="buttons">
        <button type="button" id="view-overall">整体视角</button>
        <button type="button" id="view-top">俯视</button>
      </div>
      <p class="hint">左键旋转、滚轮缩放、右键或中键平移。</p>
    </fieldset>

    <fieldset id="curve-panel" hidden>
      <legend>屋面曲率（本地预览）</legend>
      <div class="row">
        <label for="curvature">曲率 k</label>
        <input type="range" id="curvature" min="0" max="20" step="1" value="0">
      </div>
      <p class="hint" id="curve-info"></p>
      <p class="hint">本地参数预览未保存：只改浏览器里的显示，不写回服务器；切换版本会重置。</p>
    </fieldset>

    <fieldset>
      <legend>剖切</legend>
      <div class="row">
        <label for="clip-axis">剖切轴</label>
        <select id="clip-axis">
          <option value="none">不剖切</option>
          <option value="x">x（东西）</option>
          <option value="y">y（标高）</option>
          <option value="z">z（南北）</option>
        </select>
      </div>
      <div class="row">
        <label for="clip-value">剖切位置</label>
        <input type="range" id="clip-value" min="0" max="1" step="1" value="0" disabled>
      </div>
      <p class="hint">剖切只改变查看方式，不改动方案内容。</p>
    </fieldset>

    <fieldset>
      <legend>版本对照</legend>
      <div class="row">
        <label for="changes">高亮修改元素</label>
        <input type="checkbox" id="changes">
      </div>
      <p class="hint">相对 base 版本；只显示改动，不应用改动。</p>
    </fieldset>

    <fieldset>
      <legend>样例说明</legend>
      <p class="hint">版本切换是预设参数重建的修改演练，不是自然语言 agent 生成的方案。</p>
      <ul class="notes" id="notes"></ul>
    </fieldset>
  </aside>

  <main id="viewport"></main>

  <aside id="inspector">
    <section>
      <h2>选中空间 / 体量</h2>
      <div id="selection-details"><p class="hint">在三维视图中点击空间或体量，查看名称、用途、尺寸与层高。</p></div>
    </section>
    <section>
      <h2>概念说明</h2>
      <div id="report"></div>
      <div id="status"></div>
    </section>
    <section>
      <h2>版本差异</h2>
      <div id="changes-summary"></div>
    </section>
  </aside>
</div>
<script type="module" src="/page/main.ts"></script>
</body>
</html>
`;
}

/**
 * 函数草模外壳（MODELING-SPEC §4）：与蓝图查看器同一服务入口，但页面只跟模型 JSON 打交道。
 *
 * 与 `viewerHtml` 并列而不是加 selector：模型是有限浮点顶点数据，没有楼层 / 净空 / 版本对照；
 * 强行塞进整数 Blueprint 会污染旧查看器。这里只给浏览器一个空 DOM 骨架与 `/page/mesh-viewer.ts` 入口，
 * 数据由 `/api/model` 提供，页面不含任何模型代码或内联 JSON。
 */
export interface ModelViewerShellOptions {
  /** 页面标题；缺省为“函数草模查看器”。 */
  readonly title?: string;
}

const DEFAULT_MODEL_TITLE = '函数草模查看器';

/**
 * 生成模型查看器 HTML。`title` 与 `viewerHtml` 同一转义口径。
 * 输出是纯函数：同参数同结果，不含时间或随机值。
 */
export function modelViewerHtml(options: ModelViewerShellOptions = {}): string {
  const title = options.title === undefined ? DEFAULT_MODEL_TITLE : escapeText(options.title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: light; --line: #d5dbe3; --ink: #1f2933; --muted: #5c6b7a; --panel: #f7f9fc; --accent: #2f6fed; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { font: 13px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #eef1f5; }
#app { display: grid; grid-template-columns: 264px minmax(0, 1fr) 336px; grid-template-rows: 48px 1fr; height: 100vh; }
#app > header { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; padding: 0 16px; background: #fff; border-bottom: 1px solid var(--line); }
#app > header h1 { font-size: 15px; margin: 0; font-weight: 600; }
.badge { font-size: 12px; color: #8a5a00; background: #fff3d6; border: 1px solid #f0d48a; border-radius: 10px; padding: 1px 8px; }
.badge.drill { color: #1d5c8a; background: #e8f2fb; border-color: #b8d8ef; }
#controls { overflow: auto; padding: 12px; background: var(--panel); border-right: 1px solid var(--line); }
#mesh-viewport { position: relative; min-width: 0; min-height: 0; background: #dfe5ec; }
#mesh-viewport canvas { display: block; width: 100%; height: 100%; }
#inspector { overflow: auto; padding: 12px; background: #fff; border-left: 1px solid var(--line); }
fieldset { border: 1px solid var(--line); border-radius: 6px; margin: 0 0 12px; padding: 8px 10px 10px; background: #fff; }
legend { font-weight: 600; color: var(--muted); padding: 0 4px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 7px 0; }
.row > label { color: var(--muted); }
select, input[type="range"] { max-width: 130px; }
select { padding: 2px 4px; border: 1px solid var(--line); border-radius: 4px; background: #fff; color: inherit; }
button { border: 1px solid var(--line); background: #fff; border-radius: 4px; padding: 4px 10px; cursor: pointer; color: inherit; }
button:hover { border-color: var(--accent); color: var(--accent); }
.buttons { display: flex; gap: 8px; margin-top: 4px; }
.hint { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
section h2 { font-size: 13px; margin: 14px 0 6px; }
#mesh-selection-details { font-size: 12px; }
dl.kv { display: grid; grid-template-columns: 64px 1fr; gap: 2px 8px; margin: 0; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; word-break: break-word; }
details.source { margin-top: 8px; }
details.source summary { cursor: pointer; color: var(--accent); }
details.source pre { max-height: 260px; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 6px; font-size: 11px; white-space: pre-wrap; }
#mesh-status:empty { display: none; }
#mesh-status { padding: 6px 12px; font-size: 12px; border-radius: 4px; margin: 8px 0 0; }
#mesh-status.error { background: #fdecea; color: #b3261e; border: 1px solid #f5c2be; }
</style>
<script type="importmap">
{"imports":{"three":"/vendor/three.module.js","three/addons/":"/vendor/addons/"}}
</script>
</head>
<body>
<div id="app">
  <header>
    <h1>${title}</h1>
    <span class="badge">函数草模</span>
    <span class="badge drill">任意函数建模 · 非预制</span>
  </header>

  <aside id="controls">
    <fieldset>
      <legend>查看</legend>
      <div class="buttons">
        <button type="button" id="mesh-view-overall">整体视角</button>
        <button type="button" id="mesh-view-top">俯视</button>
        <button type="button" id="mesh-view-side">侧视</button>
      </div>
      <p class="hint">左键旋转、滚轮缩放、右键或中键平移。默认显示全部部件。</p>
    </fieldset>

    <fieldset>
      <legend>剖切</legend>
      <div class="row">
        <label for="mesh-clip-axis">剖切轴</label>
        <select id="mesh-clip-axis">
          <option value="none">不剖切</option>
          <option value="x">x（东西）</option>
          <option value="y">y（标高）</option>
          <option value="z">z（南北）</option>
        </select>
      </div>
      <div class="row">
        <label for="mesh-clip-value">剖切位置</label>
        <input type="range" id="mesh-clip-value" min="0" max="1" step="1" value="0" disabled>
      </div>
      <p class="hint">剖切只改变查看方式，不改动模型内容；范围按实际顶点浮点取值。</p>
    </fieldset>

    <fieldset>
      <legend>说明</legend>
      <p class="hint">模型由隔离进程按函数生成，浏览器只接收校验后的顶点与索引，不接收可执行脚本。</p>
      <p class="hint">选中部件可查看用途、操作、尺寸与 source 参数；source 只作 JSON 文本展示。</p>
    </fieldset>
  </aside>

  <main id="mesh-viewport"></main>

  <aside id="inspector">
    <section>
      <h2>选中部件</h2>
      <div id="mesh-selection-details"><p class="hint">在三维视图中点击部件，查看名称、用途、尺寸与 source 参数。</p></div>
    </section>
    <section>
      <h2>状态</h2>
      <div id="mesh-status"></div>
    </section>
  </aside>
</div>
<script type="module" src="/page/mesh-viewer.ts"></script>
</body>
</html>
`;
}

/** 文本节点最小转义：标题里出现 `<` `>` `&` `"` `'` 时替换为实体，避免结构注入。 */
function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
