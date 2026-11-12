/**
 * 方案预览的 SVG 基础设施：转义、格式化、固定调色板、标签避让、图例、指北针与比例尺。
 *
 * 负责：把 DesignScheme 的坐标 / 文本安全地画成可离线打开、确定性的 SVG 片段。
 * 不负责：具体总平面 / 平面 / 轴测 / 剖面的构图（分别在 preview-plan / axon / section / materials），
 * 也不做 I/O。本文件是纯函数，Node 与浏览器同构。
 */
import { areaOfBounds } from './primitives.ts';
import type { Bounds } from './primitives.ts';
import type { SchemeSiteZone, SchemeSpaceKind } from './scheme.ts';

export interface PreviewFile {
  readonly name: string;
  readonly title: string;
  readonly svg: string;
}

export interface PreviewBundle {
  readonly files: readonly PreviewFile[];
  readonly indexHtml: string;
}

export const PREVIEW_WIDTH = 1240;
export const PREVIEW_HEIGHT = 900;
export const SHEET_MARGIN = 56;
export const PANEL_X = 916;
export const PANEL_WIDTH = PREVIEW_WIDTH - PANEL_X - SHEET_MARGIN;
export const CONTENT_X = SHEET_MARGIN;
export const CONTENT_Y = 136;
export const CONTENT_WIDTH = PANEL_X - SHEET_MARGIN - 36;
export const CONTENT_HEIGHT = 680;

export const INK = '#28313a';
export const MUTED = '#69737e';
export const FAINT = '#9aa2a9';
export const PAPER = '#fbfaf6';
export const PANEL = '#ffffff';
export const HAIRLINE = '#ddd8cd';
export const ACCENT = '#c56b3f';

export type Point2 = readonly [number, number];

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** SVG 属性 / 文本转义。所有用户给出的名称、id、备注都必须经过这里。 */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

export function escapeHtml(value: string): string {
  return escapeXml(value);
}

/** 稳定数字格式：不使用 locale，避免不同机器输出不同；非有限值退化为 0。 */
export function fmt(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0';
  const fixed = Number(value.toFixed(digits));
  return Object.is(fixed, -0) ? '0' : String(fixed);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 固定小数位格式：用于标高 / 面积等需要稳定位数阅读的数字。 */
export function fixed(value: number, digits = 2): string {
  const safe = Number.isFinite(value) ? value : 0;
  const text = safe.toFixed(digits);
  return /^-0(?:\.0+)?$/.test(text) ? text.slice(1) : text;
}

export function formatArea(bounds: Bounds): string {
  return `${fixed(areaOfBounds(bounds), 1)} m²`;
}

export function formatElevation(value: number): string {
  if (value === 0) return '±0.00';
  return `${value > 0 ? '+' : '−'}${fixed(Math.abs(value), 2)}`;
}

/** 把任意 id 变成安全、短、确定性的文件名片段；不能带 `/` 或 `..`。 */
export function fileStem(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  return cleaned === '' ? 'level' : cleaned;
}

/** 文本近似宽度：CJK 按 1em，拉丁字母按 0.58em；用于裁剪与标签避让。 */
export function measureText(value: string, fontSize: number): number {
  let width = 0;
  for (const character of Array.from(value)) {
    width += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(character) ? fontSize : fontSize * 0.58;
  }
  return width;
}

/** 裁剪到指定像素宽度；至少保留一个字符，末尾用省略号。 */
export function truncateText(value: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0 || value === '') return '';
  if (measureText(value, fontSize) <= maxWidth) return value;
  const characters = Array.from(value);
  let result = '';
  for (const character of characters) {
    if (measureText(`${result}${character}…`, fontSize) > maxWidth) break;
    result += character;
  }
  return result === '' ? '' : `${result}…`;
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function parseHex(value: string): Rgb | null {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return null;
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function channel(value: number): number {
  return clamp(Math.round(value), 0, 255);
}

export function withAlpha(value: string, alpha: number): string {
  const rgb = parseHex(value);
  if (rgb === null) return `rgba(120, 126, 132, ${fmt(clamp(alpha, 0, 1), 3)})`;
  return `rgba(${String(rgb.r)}, ${String(rgb.g)}, ${String(rgb.b)}, ${fmt(clamp(alpha, 0, 1), 3)})`;
}

export function lighten(value: string, amount: number): string {
  const rgb = parseHex(value);
  if (rgb === null) return '#e7e3da';
  const t = clamp(amount, 0, 1);
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((part) =>
      channel(part + (255 - part) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function darken(value: string, amount: number): string {
  const rgb = parseHex(value);
  if (rgb === null) return '#555b61';
  const t = clamp(amount, 0, 1);
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((part) =>
      channel(part * (1 - t))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** 根据底色选择深 / 浅文字，保证材质板色块上的色值可读。 */
export function contrastText(value: string): string {
  const rgb = parseHex(value);
  if (rgb === null) return '#f4f1ea';
  const luminance = (rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722) / 255;
  return luminance > 0.58 ? '#1d2329' : '#f7f4ed';
}

export const LEVEL_COLORS: readonly string[] = ['#d9c7ad', '#c9d8df', '#d5dfc5', '#e2cfd2', '#d8d0c0'];

const PLAN_SPACE_COLORS: Readonly<Record<SchemeSpaceKind, readonly string[]>> = {
  room: ['#f2e2ca', '#efe9d8', '#e7ebd6', '#f0dfe0'],
  circulation: ['#dbe7ec', '#e2e9ee'],
  service: ['#e1ead8', '#dfe8e2'],
  void: ['#eceae5'],
  outdoor: ['#e1ecd3', '#dbe8d9'],
};

export const SITE_ZONE_COLORS: Readonly<Record<SchemeSiteZone['kind'], string>> = {
  garden: '#dfeacf',
  terrace: '#eadfcc',
  path: '#ded8cb',
  parking: '#d5d8db',
  service: '#e2e1da',
  water: '#cfe4e9',
  other: '#e8e3d8',
};

export function spaceColor(kind: SchemeSpaceKind, variant: number): string {
  const colors = PLAN_SPACE_COLORS[kind];
  const index = Math.abs(Math.trunc(variant)) % colors.length;
  return colors[index] ?? colors[0] ?? '#ece7dc';
}

export function levelColor(index: number): string {
  return LEVEL_COLORS[Math.abs(Math.trunc(index)) % LEVEL_COLORS.length] ?? '#d9c7ad';
}

export interface PlanProjection {
  readonly scale: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly toX: (x: number) => number;
  readonly toY: (z: number) => number;
  readonly toW: (length: number) => number;
  readonly rect: (bounds: Bounds) => Rect;
}

/** 将 world 的 x / z 适配进一个屏幕矩形；保持等比，居中。 */
export function planProjection(bounds: Bounds, area: Rect, worldPadding = 0): PlanProjection {
  const minX = bounds.min[0] - worldPadding;
  const maxX = bounds.max[0] + worldPadding;
  const minZ = bounds.min[2] - worldPadding;
  const maxZ = bounds.max[2] + worldPadding;
  const spanX = Math.max(0.001, maxX - minX);
  const spanZ = Math.max(0.001, maxZ - minZ);
  const scale = Math.max(0.0001, Math.min(area.w / spanX, area.h / spanZ));
  const left = area.x + (area.w - spanX * scale) / 2 - minX * scale;
  const top = area.y + (area.h - spanZ * scale) / 2 - minZ * scale;
  return {
    scale,
    left,
    top,
    width: spanX * scale,
    height: spanZ * scale,
    toX: (x: number) => left + x * scale,
    toY: (z: number) => top + z * scale,
    toW: (length: number) => length * scale,
    rect: (value: Bounds) => ({
      x: left + value.min[0] * scale,
      y: top + value.min[2] * scale,
      w: (value.max[0] - value.min[0]) * scale,
      h: (value.max[2] - value.min[2]) * scale,
    }),
  };
}

export interface TextOptions {
  readonly fill?: string;
  readonly size?: number;
  readonly anchor?: 'start' | 'middle' | 'end';
  readonly weight?: number | string;
  readonly className?: string;
  readonly opacity?: number;
  readonly halo?: boolean;
  readonly letterSpacing?: number;
}

export function svgText(x: number, y: number, value: string, options: TextOptions = {}): string {
  const attributes = [
    `x="${fmt(x)}"`,
    `y="${fmt(y)}"`,
    `fill="${escapeXml(options.fill ?? INK)}"`,
    `font-size="${fmt(options.size ?? 12, 2)}"`,
    `text-anchor="${options.anchor ?? 'start'}"`,
  ];
  if (options.weight !== undefined) attributes.push(`font-weight="${escapeXml(String(options.weight))}"`);
  if (options.className !== undefined) attributes.push(`class="${escapeXml(options.className)}"`);
  if (options.opacity !== undefined) attributes.push(`opacity="${fmt(clamp(options.opacity, 0, 1), 3)}"`);
  if (options.letterSpacing !== undefined) attributes.push(`letter-spacing="${fmt(options.letterSpacing, 2)}"`);
  if (options.halo === true) attributes.push(`stroke="${PAPER}"`, 'stroke-width="3.5"', 'paint-order="stroke"');
  return `<text ${attributes.join(' ')}>${escapeXml(value)}</text>`;
}

export interface RectOptions {
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly rx?: number;
  readonly opacity?: number;
  readonly dash?: string;
}

export function svgRect(rect: Rect, options: RectOptions = {}): string {
  const attributes = [
    `x="${fmt(rect.x)}"`,
    `y="${fmt(rect.y)}"`,
    `width="${fmt(Math.max(0, rect.w))}"`,
    `height="${fmt(Math.max(0, rect.h))}"`,
    `fill="${escapeXml(options.fill ?? 'none')}"`,
  ];
  if (options.stroke !== undefined) {
    attributes.push(`stroke="${escapeXml(options.stroke)}"`, `stroke-width="${fmt(options.strokeWidth ?? 1)}"`);
  }
  if (options.rx !== undefined) attributes.push(`rx="${fmt(options.rx)}"`);
  if (options.opacity !== undefined) attributes.push(`opacity="${fmt(clamp(options.opacity, 0, 1), 3)}"`);
  if (options.dash !== undefined) attributes.push(`stroke-dasharray="${escapeXml(options.dash)}"`);
  return `<rect ${attributes.join(' ')}/>`;
}

export interface LineOptions {
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly opacity?: number;
  readonly dash?: string;
  readonly linecap?: 'butt' | 'round' | 'square';
}

export function svgLine(x1: number, y1: number, x2: number, y2: number, options: LineOptions = {}): string {
  const attributes = [
    `x1="${fmt(x1)}"`,
    `y1="${fmt(y1)}"`,
    `x2="${fmt(x2)}"`,
    `y2="${fmt(y2)}"`,
    `stroke="${escapeXml(options.stroke ?? INK)}"`,
    `stroke-width="${fmt(options.strokeWidth ?? 1)}"`,
  ];
  if (options.opacity !== undefined) attributes.push(`opacity="${fmt(clamp(options.opacity, 0, 1), 3)}"`);
  if (options.dash !== undefined) attributes.push(`stroke-dasharray="${escapeXml(options.dash)}"`);
  if (options.linecap !== undefined) attributes.push(`stroke-linecap="${options.linecap}"`);
  return `<line ${attributes.join(' ')}/>`;
}

export function arrowMarker(id: string, color = ACCENT): string {
  return `<marker id="${escapeXml(id)}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 Z" fill="${escapeXml(color)}"/></marker>`;
}

export function hatchPattern(id: string, color: string, opacity = 0.35): string {
  return `<pattern id="${escapeXml(id)}" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="${escapeXml(color)}" stroke-width="1" opacity="${fmt(opacity, 2)}"/></pattern>`;
}

export function svgDocument(title: string, width: number, height: number, body: string, background = PAPER): string {
  const safeTitle = escapeXml(title);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width, 0)}" height="${fmt(height, 0)}" viewBox="0 0 ${fmt(width, 0)} ${fmt(height, 0)}" role="img" aria-labelledby="preview-title"><title id="preview-title">${safeTitle}</title><desc>${safeTitle}：由拼图花园离线方案预览生成，纯 SVG，不含外部资源。</desc><style>text{font-family:'Noto Sans CJK SC','Source Han Sans SC','PingFang SC','Microsoft YaHei',sans-serif}.mono,.num{font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}.kicker{letter-spacing:1.4px}</style><rect width="${fmt(width, 0)}" height="${fmt(height, 0)}" fill="${escapeXml(background)}"/>${body}</svg>`;
}

export interface SheetHeaderOptions {
  readonly kicker: string;
  readonly title: string;
  readonly subtitle: string;
  readonly meta: string;
}

export function renderSheetHeader(options: SheetHeaderOptions): string {
  const title = truncateText(options.title, 760, 27);
  const subtitle = truncateText(options.subtitle, 1000, 12);
  const meta = truncateText(options.meta, 250, 10.5);
  return [
    svgText(SHEET_MARGIN, 38, options.kicker, {
      size: 10.5,
      fill: MUTED,
      weight: 650,
      className: 'kicker',
    }),
    svgText(SHEET_MARGIN, 76, title, { size: 27, weight: 720 }),
    svgText(SHEET_MARGIN, 101, subtitle, { size: 12, fill: MUTED }),
    svgText(PREVIEW_WIDTH - SHEET_MARGIN, 38, meta, { size: 10.5, fill: FAINT, anchor: 'end' }),
    svgLine(SHEET_MARGIN, 116, PREVIEW_WIDTH - SHEET_MARGIN, 116, { stroke: HAIRLINE, strokeWidth: 1 }),
  ].join('');
}

export function renderSheetFooter(note: string, meta: string): string {
  return [
    svgLine(SHEET_MARGIN, 842, PREVIEW_WIDTH - SHEET_MARGIN, 842, { stroke: HAIRLINE, strokeWidth: 1 }),
    svgText(SHEET_MARGIN, 862, note, { size: 10.5, fill: MUTED }),
    svgText(PREVIEW_WIDTH - SHEET_MARGIN, 862, meta, { size: 10.5, fill: FAINT, anchor: 'end' }),
  ].join('');
}

export interface LabelSpec {
  readonly lines: readonly string[];
  readonly preferred: Point2;
  readonly fontSize?: number;
  readonly maxWidth?: number;
  readonly paddingX?: number;
  readonly paddingY?: number;
  readonly within?: Rect;
}

export interface PlacedLabel {
  readonly rect: Rect;
  readonly lines: readonly string[];
  readonly fontSize: number;
  readonly textX: number;
  readonly textY: number;
  readonly paddingY: number;
}

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return !(a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y);
}

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** 确定性标签避让器：先到先得，候选位置从中心向外扩散；放不下就返回 null。 */
export class LabelPlacer {
  private readonly bounds: Rect;
  private readonly gap: number;
  private readonly used: Rect[] = [];

  constructor(bounds: Rect, gap = 2) {
    this.bounds = bounds;
    this.gap = gap;
  }

  place(spec: LabelSpec): PlacedLabel | null {
    const fontSize = spec.fontSize ?? 11;
    const paddingX = spec.paddingX ?? 3;
    const paddingY = spec.paddingY ?? 2;
    const lineHeight = fontSize * 1.25;
    const maxWidth = Math.max(0, spec.maxWidth ?? this.bounds.w);
    const lines = spec.lines
      .map((line) => truncateText(line, maxWidth - paddingX * 2, fontSize))
      .filter((line) => line !== '');
    if (lines.length === 0) return null;
    const width = Math.min(maxWidth, Math.max(...lines.map((line) => measureText(line, fontSize))) + paddingX * 2);
    const height = lines.length * lineHeight + paddingY * 2;
    if (width <= 0 || height <= 0) return null;

    const offsets: readonly Point2[] = [
      [0, 0],
      [0, -(height + 5)],
      [0, height + 5],
      [-(width * 0.58), 0],
      [width * 0.58, 0],
      [0, -(height * 2 + 9)],
      [0, height * 2 + 9],
      [-(width * 0.65), -(height + 5)],
      [width * 0.65, -(height + 5)],
      [-(width * 0.65), height + 5],
      [width * 0.65, height + 5],
    ];

    for (const [dx, dy] of offsets) {
      const rect: Rect = {
        x: spec.preferred[0] - width / 2 + dx,
        y: spec.preferred[1] - height / 2 + dy,
        w: width,
        h: height,
      };
      if (!inside(rect, this.bounds)) continue;
      if (spec.within !== undefined && !inside(rect, spec.within)) continue;
      if (this.used.some((other) => overlaps(rect, other, this.gap))) continue;
      this.used.push(rect);
      return {
        rect,
        lines,
        fontSize,
        textX: rect.x + rect.w / 2,
        textY: rect.y + paddingY + fontSize,
        paddingY,
      };
    }
    return null;
  }
}

export interface PlacedLabelStyle {
  readonly fill?: string;
  readonly weight?: number | string;
  readonly halo?: boolean;
  readonly opacity?: number;
  readonly className?: string;
}

export function renderPlacedLabel(label: PlacedLabel, style: PlacedLabelStyle = {}): string {
  const tspans = label.lines
    .map((line, index) => {
      const dy = index === 0 ? '' : ` dy="${fmt(label.fontSize * 1.25)}"`;
      return `<tspan x="${fmt(label.textX)}"${dy}>${escapeXml(line)}</tspan>`;
    })
    .join('');
  const attributes = [
    `x="${fmt(label.textX)}"`,
    `y="${fmt(label.textY)}"`,
    `fill="${escapeXml(style.fill ?? INK)}"`,
    `font-size="${fmt(label.fontSize, 2)}"`,
    'text-anchor="middle"',
  ];
  if (style.weight !== undefined) attributes.push(`font-weight="${escapeXml(String(style.weight))}"`);
  if (style.opacity !== undefined) attributes.push(`opacity="${fmt(clamp(style.opacity, 0, 1), 3)}"`);
  if (style.className !== undefined) attributes.push(`class="${escapeXml(style.className)}"`);
  if (style.halo === true) attributes.push(`stroke="${PAPER}"`, 'stroke-width="3"', 'paint-order="stroke"');
  return `<text ${attributes.join(' ')}>${tspans}</text>`;
}

export type LegendMark = 'swatch' | 'line' | 'dash' | 'door' | 'window' | 'circle' | 'arrow';

export interface LegendItem {
  readonly label: string;
  readonly color: string;
  readonly mark?: LegendMark;
}

export interface LegendResult {
  readonly svg: string;
  readonly height: number;
}

function renderLegendMark(mark: LegendMark, x: number, y: number, color: string): string {
  switch (mark) {
    case 'swatch':
      return svgRect(
        { x, y: y - 6, w: 13, h: 12 },
        { fill: color, stroke: darken(color, 0.28), strokeWidth: 0.8, rx: 3 },
      );
    case 'line':
      return svgLine(x, y, x + 16, y, { stroke: color, strokeWidth: 3, linecap: 'round' });
    case 'dash':
      return svgLine(x, y, x + 16, y, { stroke: color, strokeWidth: 2.2, dash: '5 3', linecap: 'round' });
    case 'door':
      return `${svgLine(x, y + 5, x + 14, y + 5, { stroke: color, strokeWidth: 1.6 })}<path d="M ${fmt(x)} ${fmt(y + 5)} L ${fmt(x)} ${fmt(y - 7)} A 12 12 0 0 1 ${fmt(x + 12)} ${fmt(y + 5)}" fill="none" stroke="${escapeXml(color)}" stroke-width="1" stroke-dasharray="2 2"/>`;
    case 'window':
      return `${svgLine(x, y - 2, x + 16, y - 2, { stroke: color, strokeWidth: 1.1 })}${svgLine(x, y + 2, x + 16, y + 2, { stroke: color, strokeWidth: 1.1 })}`;
    case 'circle':
      return `<circle cx="${fmt(x + 8)}" cy="${fmt(y)}" r="5" fill="${escapeXml(color)}" stroke="${escapeXml(darken(color, 0.25))}" stroke-width="0.8"/>`;
    case 'arrow':
      return `${svgLine(x, y, x + 15, y, { stroke: color, strokeWidth: 2.2, linecap: 'round' })}<path d="M ${fmt(x + 12)} ${fmt(y - 4)} L ${fmt(x + 18)} ${fmt(y)} L ${fmt(x + 12)} ${fmt(y + 4)} Z" fill="${escapeXml(color)}"/>`;
  }
}

export function renderLegend(
  title: string,
  items: readonly LegendItem[],
  x: number,
  y: number,
  width: number,
): LegendResult {
  const rowHeight = 23;
  const top = 38;
  const bottom = 14;
  const height = top + items.length * rowHeight + bottom;
  const rows = items
    .map((item, index) => {
      const rowY = y + top + index * rowHeight + 8;
      return `${renderLegendMark(item.mark ?? 'swatch', x + 17, rowY, item.color)}${svgText(x + 42, rowY + 4, item.label, { size: 11, fill: INK })}`;
    })
    .join('');
  return {
    height,
    svg: `${svgRect({ x, y, w: width, h: height }, { fill: PANEL, stroke: HAIRLINE, strokeWidth: 1, rx: 12, opacity: 0.96 })}${svgText(x + 16, y + 24, title, { size: 11, fill: MUTED, weight: 700, className: 'kicker' })}${rows}`,
  };
}

export function renderNorthArrow(x: number, y: number, size = 34): string {
  const radius = size * 0.5;
  return `<g transform="translate(${fmt(x)} ${fmt(y)})"><circle cx="0" cy="0" r="${fmt(radius)}" fill="${PANEL}" stroke="${HAIRLINE}" stroke-width="1"/>${svgLine(0, radius * 0.45, 0, -radius * 0.62, { stroke: INK, strokeWidth: 1.4 })}<path d="M 0 ${fmt(-radius * 0.9)} L ${fmt(radius * 0.24)} ${fmt(-radius * 0.2)} L 0 ${fmt(-radius * 0.36)} L ${fmt(-radius * 0.24)} ${fmt(-radius * 0.2)} Z" fill="${INK}"/>${svgText(0, -radius - 6, 'N', { size: 10, fill: INK, anchor: 'middle', weight: 700 })}</g>`;
}

function niceScaleMeters(pixelsPerMeter: number, targetWidth: number): number {
  const candidates = [1, 2, 5, 10, 20, 50, 100, 200];
  let best = candidates[0] ?? 1;
  for (const candidate of candidates) {
    if (candidate * pixelsPerMeter <= targetWidth) best = candidate;
  }
  return best;
}

export function renderScaleBar(x: number, y: number, pixelsPerMeter: number, targetWidth = 150): string {
  const meters = niceScaleMeters(Number.isFinite(pixelsPerMeter) ? pixelsPerMeter : 0, targetWidth);
  const width = Math.max(24, meters * pixelsPerMeter);
  const segment = width / 4;
  const bars = [0, 1, 2, 3]
    .map((index) =>
      svgRect(
        { x: x + index * segment, y, w: segment, h: 6 },
        { fill: index % 2 === 0 ? INK : PAPER, stroke: INK, strokeWidth: 0.8 },
      ),
    )
    .join('');
  return `<g>${bars}${svgText(x, y - 6, '0', { size: 9, fill: MUTED })}${svgText(x + width, y - 6, `${fmt(meters, 0)} m`, { size: 9, fill: MUTED, anchor: 'end' })}${svgText(x, y + 20, '示意比例尺', { size: 9, fill: FAINT })}</g>`;
}

export function renderChip(x: number, y: number, text: string, color: string, width?: number): string {
  const label = truncateText(text, width === undefined ? 160 : width - 18, 10);
  const chipWidth = width ?? Math.max(44, measureText(label, 10) + 18);
  return `${svgRect({ x, y, w: chipWidth, h: 20 }, { fill: withAlpha(color, 0.16), stroke: withAlpha(color, 0.5), strokeWidth: 0.8, rx: 10 })}${svgText(x + chipWidth / 2, y + 14, label, { size: 10, fill: darken(color, 0.35), anchor: 'middle', weight: 600 })}`;
}
