/**
 * 材质板：按 role 分组的色块卡片，展示材料名、block、role 与色值。
 *
 * 负责：materials.svg 的深色版式、动态高度与对比度可读性。
 * 不负责：真实纹理、材质渲染或色差校准；纯函数，不做 I/O。
 */
import type { DesignScheme, MaterialRole, SchemeMaterial } from './scheme.ts';
import type { PreviewFile } from './preview-core.ts';
import {
  PREVIEW_WIDTH,
  SHEET_MARGIN,
  contrastText,
  darken,
  escapeXml,
  fmt,
  measureText,
  svgDocument,
  svgText,
  truncateText,
} from './preview-core.ts';

const PAGE_BG = '#191d22';
const CARD_BG = '#242a31';
const CARD_LINE = '#39414a';
const TEXT = '#f2eee5';
const SOFT = '#b7c0c9';
const DIM = '#7f8993';
const COLS = 3;
const CARD_GAP = 18;
const CARD_HEIGHT = 126;
const ROW_GAP = 14;
const GROUP_GAP = 30;
const TOP = 158;
const CONTENT_WIDTH = PREVIEW_WIDTH - SHEET_MARGIN * 2;
const CARD_WIDTH = (CONTENT_WIDTH - CARD_GAP * (COLS - 1)) / COLS;

const ROLE_ORDER: readonly MaterialRole[] = [
  'structure',
  'wall',
  'roof',
  'floor',
  'trim',
  'furniture',
  'landscape',
  'glass',
];
const ROLE_LABEL: Readonly<Record<MaterialRole, string>> = {
  structure: '结构',
  wall: '墙体',
  roof: '屋面',
  floor: '地面',
  trim: '收边',
  furniture: '家具',
  landscape: '景观',
  glass: '玻璃',
};
const ROLE_EN: Readonly<Record<MaterialRole, string>> = {
  structure: 'STRUCTURE',
  wall: 'WALL',
  roof: 'ROOF',
  floor: 'FLOOR',
  trim: 'TRIM',
  furniture: 'FURNITURE',
  landscape: 'LANDSCAPE',
  glass: 'GLASS',
};

interface Group {
  readonly role: MaterialRole;
  readonly materials: readonly SchemeMaterial[];
}

function groupMaterials(materials: readonly SchemeMaterial[]): Group[] {
  return ROLE_ORDER.map((role) => ({
    role,
    materials: materials.filter((material) => material.role === role),
  })).filter((group) => group.materials.length > 0);
}

function groupHeight(group: Group): number {
  const rows = Math.ceil(group.materials.length / COLS);
  return 40 + rows * CARD_HEIGHT + Math.max(0, rows - 1) * ROW_GAP;
}

function pageHeight(groups: readonly Group[]): number {
  const body = groups.reduce((sum, group) => sum + groupHeight(group) + GROUP_GAP, 0);
  return Math.max(900, TOP + body + 70);
}

function swatch(material: SchemeMaterial, x: number, y: number): string {
  const color = material.color;
  if (color === null) {
    return `<rect x="${fmt(x)}" y="${fmt(y)}" width="64" height="64" rx="8" fill="#2c3239" stroke="${CARD_LINE}" stroke-width="1"/><rect x="${fmt(x)}" y="${fmt(y)}" width="64" height="64" rx="8" fill="url(#missing-color)"/>${svgText(x + 32, y + 37, '未指定', { size: 9, fill: DIM, anchor: 'middle' })}`;
  }
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="64" height="64" rx="8" fill="${escapeXml(color)}" stroke="${escapeXml(darken(color, 0.25))}" stroke-width="1"/>${svgText(x + 32, y + 37, color.toUpperCase(), { size: 8.5, fill: contrastText(color), anchor: 'middle', weight: 600, className: 'mono' })}`;
}

function card(material: SchemeMaterial, x: number, y: number): string {
  const name = truncateText(material.name, CARD_WIDTH - 116, 14);
  const block = truncateText(material.block, CARD_WIDTH - 116, 10);
  return [
    `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(CARD_WIDTH)}" height="${fmt(CARD_HEIGHT)}" rx="10" fill="${CARD_BG}" stroke="${CARD_LINE}" stroke-width="1"/>`,
    swatch(material, x + 18, y + 18),
    svgText(x + 98, y + 38, name, { size: 14, fill: TEXT, weight: 650 }),
    svgText(x + 98, y + 59, block, { size: 10, fill: SOFT, className: 'mono' }),
    `<rect x="${fmt(x + 98)}" y="${fmt(y + 72)}" width="${fmt(Math.min(132, Math.max(60, measureText(material.role, 9) + 24)))}" height="19" rx="9.5" fill="#303741" stroke="#414a55" stroke-width="0.8"/>`,
    svgText(x + 108, y + 85.5, `${ROLE_LABEL[material.role]} · ${material.role}`, { size: 9, fill: SOFT }),
    svgText(x + 98, y + 110, material.color === null ? 'color: null' : `color: ${material.color}`, {
      size: 9,
      fill: DIM,
      className: 'mono',
    }),
  ].join('');
}

function roleHeading(group: Group, y: number): string {
  const label = `${ROLE_LABEL[group.role]} ${ROLE_EN[group.role]}`;
  return [
    svgText(SHEET_MARGIN, y + 18, label, { size: 13, fill: TEXT, weight: 700, className: 'kicker' }),
    svgText(SHEET_MARGIN + measureText(label, 13) + 14, y + 18, `${String(group.materials.length)} 项`, {
      size: 10,
      fill: DIM,
    }),
    `<line x1="${fmt(SHEET_MARGIN)}" y1="${fmt(y + 30)}" x2="${fmt(PREVIEW_WIDTH - SHEET_MARGIN)}" y2="${fmt(y + 30)}" stroke="${CARD_LINE}" stroke-width="1"/>`,
  ].join('');
}

/** 材质板整页。 */
export function renderMaterialsSvg(scheme: DesignScheme): string {
  const groups = groupMaterials(scheme.materials);
  const height = pageHeight(groups);
  const body: string[] = [
    `<defs><pattern id="missing-color" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="${DIM}" stroke-width="1" opacity="0.45"/></pattern></defs>`,
    svgText(SHEET_MARGIN, 42, '方案预览 / MATERIALS', {
      size: 10.5,
      fill: '#d9a174',
      weight: 650,
      className: 'kicker',
    }),
    svgText(SHEET_MARGIN, 82, truncateText(`${scheme.meta.title} · 材质板`, PREVIEW_WIDTH - SHEET_MARGIN * 2, 28), {
      size: 28,
      fill: TEXT,
      weight: 720,
    }),
    svgText(SHEET_MARGIN, 108, truncateText(scheme.meta.concept, PREVIEW_WIDTH - SHEET_MARGIN * 2, 12), {
      size: 12,
      fill: SOFT,
    }),
    svgText(PREVIEW_WIDTH - SHEET_MARGIN, 42, `${scheme.meta.id} · v${String(scheme.meta.revision)}`, {
      size: 10.5,
      fill: DIM,
      anchor: 'end',
    }),
    svgText(
      PREVIEW_WIDTH - SHEET_MARGIN,
      82,
      `${String(scheme.materials.length)} 种材料 · ${String(groups.length)} 个 role`,
      {
        size: 11,
        fill: SOFT,
        anchor: 'end',
      },
    ),
    `<line x1="${fmt(SHEET_MARGIN)}" y1="124" x2="${fmt(PREVIEW_WIDTH - SHEET_MARGIN)}" y2="124" stroke="${CARD_LINE}" stroke-width="1"/>`,
  ];
  let y = TOP;
  for (const group of groups) {
    body.push(roleHeading(group, y));
    const cardsY = y + 40;
    group.materials.forEach((material, index) => {
      const col = index % COLS;
      const row = Math.floor(index / COLS);
      body.push(card(material, SHEET_MARGIN + col * (CARD_WIDTH + CARD_GAP), cardsY + row * (CARD_HEIGHT + ROW_GAP)));
    });
    y += groupHeight(group) + GROUP_GAP;
  }
  body.push(
    `<line x1="${fmt(SHEET_MARGIN)}" y1="${fmt(height - 54)}" x2="${fmt(PREVIEW_WIDTH - SHEET_MARGIN)}" y2="${fmt(height - 54)}" stroke="${CARD_LINE}" stroke-width="1"/>`,
    svgText(SHEET_MARGIN, height - 30, '按 role 分组；色块与色值来自 DesignScheme.materials.color。', {
      size: 10,
      fill: DIM,
    }),
    svgText(PREVIEW_WIDTH - SHEET_MARGIN, height - 30, '深色底仅用于检查色彩与明度，不表示真实纹理。', {
      size: 10,
      fill: DIM,
      anchor: 'end',
    }),
  );
  return svgDocument(`材质板：${scheme.meta.title}`, PREVIEW_WIDTH, height, body.join(''), PAGE_BG);
}

/** 供统一入口构造文件对象；标题与文件名保持稳定。 */
export function materialsFile(scheme: DesignScheme): PreviewFile {
  return { name: 'materials.svg', title: '材质板', svg: renderMaterialsSvg(scheme) };
}
