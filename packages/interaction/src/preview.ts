/**
 * 方案预览统一入口：把一份 DesignScheme 变成 site / 每层 plan / axon / section / materials
 * 五个 SVG 文件，以及一个可离线直接打开的 index.html。
 *
 * 负责：文件顺序、稳定文件名、索引页 HTML 转义与内联样式。
 * 不负责：写文件（tools/design-preview.ts）、浏览器渲染或任何网络 / 模型调用。
 * 所有渲染都是确定性的：同一输入逐字节相同。
 */
import type { DesignScheme } from './scheme.ts';
import { escapeHtml, fmt } from './preview-core.ts';
import type { PreviewBundle, PreviewFile } from './preview-core.ts';
import { planFileNames, renderPlanSvg, renderSiteSvg } from './preview-plan.ts';
import { renderAxonSvg } from './preview-axon.ts';
import { renderSectionSvg } from './preview-section.ts';
import { materialsFile } from './preview-materials.ts';

export type { PreviewBundle, PreviewFile } from './preview-core.ts';
export { planFileNames } from './preview-plan.ts';

const STATIC_FILES: readonly { readonly name: string; readonly title: string; readonly note: string }[] = [
  { name: 'site.svg', title: '总平面', note: '场地边界、室外分区、建筑轮廓、入口与指北针。' },
  { name: 'axon.svg', title: '轴测体量', note: '空间体块、楼层、家具与半透明屋面；固定南东视角。' },
  { name: 'section.svg', title: '关键剖面', note: '楼层标高、楼板、屋面轮廓、切割空间与家具高度。' },
  { name: 'materials.svg', title: '材质板', note: '按 role 分组的色块、block 与色值，深色底检查明度。' },
];

function fileNote(name: string): string {
  if (name.startsWith('plan-')) return '该层空间、墙带、门窗、家具、动线与面积外包标注。';
  return STATIC_FILES.find((item) => item.name === name)?.note ?? '方案 SVG 预览。';
}

function renderIndexHtml(scheme: DesignScheme, files: readonly PreviewFile[]): string {
  const title = `${scheme.meta.title} · 方案预览`;
  const manifest = files
    .map(
      (file) =>
        `<li><a href="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a><span>${escapeHtml(file.title)}</span></li>`,
    )
    .join('');
  const cards = files
    .map(
      (file) => `<article class="card">
        <a class="thumb" href="${escapeHtml(file.name)}" aria-label="打开 ${escapeHtml(file.title)}">
          <img src="${escapeHtml(file.name)}" alt="${escapeHtml(file.title)}" loading="lazy" />
        </a>
        <div class="card-body">
          <h2>${escapeHtml(file.title)}</h2>
          <p>${escapeHtml(fileNote(file.name))}</p>
          <code>${escapeHtml(file.name)}</code>
        </div>
      </article>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; --ink:#28313a; --muted:#69737e; --line:#ddd8cd; --paper:#fbfaf6; --accent:#c56b3f; }
* { box-sizing: border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font-family:"Noto Sans CJK SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif; }
main { max-width:1320px; margin:0 auto; padding:48px 32px 72px; }
header { border-bottom:1px solid var(--line); padding-bottom:28px; margin-bottom:30px; }
.kicker { margin:0 0 12px; color:var(--muted); font-size:12px; letter-spacing:1.6px; text-transform:uppercase; }
h1 { margin:0; font-size:40px; line-height:1.18; letter-spacing:-0.4px; }
.concept { max-width:900px; margin:16px 0 0; color:#4d5862; font-size:16px; line-height:1.7; }
.meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:20px; }
.chip { border:1px solid var(--line); border-radius:999px; padding:5px 11px; color:var(--muted); font-size:12px; background:#fff; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:22px; }
.card { background:#fff; border:1px solid var(--line); border-radius:14px; overflow:hidden; box-shadow:0 8px 24px rgba(41,46,52,.045); }
.thumb { display:block; background:#f1eee7; aspect-ratio:1240 / 900; overflow:hidden; }
.thumb img { display:block; width:100%; height:100%; object-fit:cover; object-position:top center; }
.card-body { padding:16px 18px 18px; }
h2 { margin:0; font-size:17px; line-height:1.4; }
.card-body p { margin:7px 0 10px; color:var(--muted); font-size:12.5px; line-height:1.6; }
code { color:var(--accent); font-family:"SFMono-Regular",Menlo,Consolas,monospace; font-size:11.5px; }
.files { margin-top:34px; border-top:1px solid var(--line); padding-top:22px; }
.files h2 { font-size:16px; }
.files ul { list-style:none; margin:12px 0 0; padding:0; display:grid; gap:8px; }
.files li { display:flex; gap:14px; align-items:baseline; font-size:12.5px; }
.files a { color:var(--accent); font-family:"SFMono-Regular",Menlo,Consolas,monospace; text-decoration:none; min-width:180px; }
.files span { color:var(--muted); }
footer { margin-top:38px; padding-top:18px; border-top:1px solid var(--line); color:var(--muted); font-size:11.5px; line-height:1.7; }
@media (max-width:640px) { main { padding:32px 18px 52px; } h1 { font-size:30px; } .grid { grid-template-columns:1fr; } .files a { min-width:0; } .files li { flex-direction:column; gap:2px; } }
</style>
</head>
<body>
<main>
<header>
  <p class="kicker">Puzzle Garden / Design Preview</p>
  <h1>${escapeHtml(scheme.meta.title)}</h1>
  <p class="concept">${escapeHtml(scheme.meta.concept)}</p>
  <div class="meta">
    <span class="chip">${escapeHtml(scheme.meta.id)} · v${escapeHtml(String(scheme.meta.revision))}</span>
    <span class="chip">${escapeHtml(scheme.meta.status)}</span>
    <span class="chip">${escapeHtml(scheme.meta.scope)}</span>
    <span class="chip">${escapeHtml(String(scheme.levels.length))} 层 · ${escapeHtml(String(scheme.spaces.length))} 个空间</span>
    <span class="chip">${escapeHtml(String(scheme.materials.length))} 种材料</span>
  </div>
</header>
<section class="grid">
${cards}
</section>
<section class="files">
  <h2>文件</h2>
  <ul>${manifest}</ul>
</section>
<footer>
  纯 SVG 预览，离线生成，无外部图片 / 字体 / 网络依赖。平面面积按 bounds 地面投影外包、未扣墙厚；
  轴测与剖面为示意，不表示真实透视、结构计算或施工构造。所有数值单位默认为米。
</footer>
</main>
</body>
</html>
`;
}

/** 统一入口：网页 demo 与 CLI 都调用这个函数。 */
export function renderPreviewBundle(scheme: DesignScheme): PreviewBundle {
  const planNames = planFileNames(scheme.levels);
  const files: PreviewFile[] = [
    { name: 'site.svg', title: '总平面', svg: renderSiteSvg(scheme) },
    ...scheme.levels.map((level, index) => ({
      name: planNames[index] ?? `plan-${String(index + 1)}.svg`,
      title: `平面 · ${level.name}`,
      svg: renderPlanSvg(scheme, level),
    })),
    { name: 'axon.svg', title: '轴测体量', svg: renderAxonSvg(scheme) },
    { name: 'section.svg', title: '关键剖面', svg: renderSectionSvg(scheme) },
    materialsFile(scheme),
  ];
  return { files, indexHtml: renderIndexHtml(scheme, files) };
}

/** 便捷摘要：给 CLI 打印文件数与方案版本，不参与渲染。 */
export function previewSummary(scheme: DesignScheme, bundle: PreviewBundle): string {
  return `${scheme.meta.title} v${fmt(scheme.meta.revision, 0)} · ${String(bundle.files.length)} 个 SVG + index.html`;
}
