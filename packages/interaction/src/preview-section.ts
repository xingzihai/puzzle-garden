/* eslint-disable max-lines */
/**
 * 关键剖面：选择穿过最大房间的 x / z 切割线，画出楼层标高、楼板、屋面轮廓、空间与家具。
 *
 * 负责：section.svg 的整页构图与标签避让。
 * 不负责：结构计算、节点构造、真实坡度施工；纯函数，不做 I/O。
 * 说明：剖面是示意性的——空间按 bounds 矩形切开，家具按 bounds 高度块表示。
 */
import type { Bounds } from './primitives.ts';
import type { DesignScheme, SchemeSpace, SchemeSpaceKind } from './scheme.ts';
import {
  ACCENT,
  CONTENT_HEIGHT,
  CONTENT_WIDTH,
  CONTENT_X,
  CONTENT_Y,
  FAINT,
  HAIRLINE,
  LabelPlacer,
  MUTED,
  PANEL_WIDTH,
  PANEL_X,
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  darken,
  fixed,
  fmt,
  formatElevation,
  levelColor,
  lighten,
  renderChip,
  renderLegend,
  renderPlacedLabel,
  renderScaleBar,
  renderSheetFooter,
  renderSheetHeader,
  spaceColor,
  svgDocument,
  svgLine,
  svgRect,
  svgText,
  withAlpha,
} from './preview-core.ts';
import type { Point2, Rect } from './preview-core.ts';
import { materialColor } from './preview-plan-draw.ts';

type Axis = 'x' | 'z';

interface CutSelection {
  readonly axis: Axis;
  readonly coordinate: number;
  readonly largest: SchemeSpace;
  readonly cutSpaces: readonly SchemeSpace[];
}

interface SectionProjection {
  readonly scale: number;
  readonly toX: (value: number) => number;
  readonly toY: (value: number) => number;
}

interface RoofInfo {
  readonly svg: string;
  readonly labels: readonly { readonly text: string; readonly point: Point2 }[];
}

const PLOT: Rect = {
  x: CONTENT_X + 82,
  y: CONTENT_Y + 20,
  w: CONTENT_WIDTH - 100,
  h: CONTENT_HEIGHT - 70,
};
const AXIS_LABEL: Readonly<Record<Axis, string>> = { x: 'X', z: 'Z' };
const SPACE_KIND_LABEL: Readonly<Record<SchemeSpaceKind, string>> = {
  room: '房间',
  circulation: '交通',
  void: '挑空',
  service: '服务',
  outdoor: '室外',
};

function horizontalSpan(bounds: Bounds, axis: Axis): readonly [number, number] {
  return axis === 'x' ? [bounds.min[0], bounds.max[0]] : [bounds.min[2], bounds.max[2]];
}

function perpendicularSpan(bounds: Bounds, axis: Axis): readonly [number, number] {
  return axis === 'x' ? [bounds.min[2], bounds.max[2]] : [bounds.min[0], bounds.max[0]];
}

function containsSpan(span: readonly [number, number], value: number): boolean {
  return value >= span[0] && value <= span[1];
}

function areaOf(space: SchemeSpace): number {
  return (space.bounds.max[0] - space.bounds.min[0]) * (space.bounds.max[2] - space.bounds.min[2]);
}

function largestRoom(scheme: DesignScheme): SchemeSpace {
  const rooms = scheme.spaces.filter((space) => space.kind === 'room');
  const pool = rooms.length > 0 ? rooms : scheme.spaces;
  const first = [...pool].sort((a, b) => areaOf(b) - areaOf(a))[0];
  if (first === undefined) throw new Error('DesignScheme 至少需要一个空间');
  return first;
}

function chooseCut(scheme: DesignScheme): CutSelection {
  const largest = largestRoom(scheme);
  const building = scheme.site.buildingBounds;
  const ridgeAlongX = building.max[0] - building.min[0] >= building.max[2] - building.min[2];
  const roofForm = scheme.roof.form;
  const axis: Axis =
    roofForm === 'flat' || roofForm === 'curved' || roofForm === 'other'
      ? largest.bounds.max[0] - largest.bounds.min[0] >= largest.bounds.max[2] - largest.bounds.min[2]
        ? 'x'
        : 'z'
      : ridgeAlongX
        ? 'z'
        : 'x';
  const span = perpendicularSpan(largest.bounds, axis);
  const fractions = [-0.32, -0.16, 0, 0.16, 0.32];
  let best = (span[0] + span[1]) / 2;
  let bestScore = -1;
  for (const fraction of fractions) {
    const candidate = (span[0] + span[1]) / 2 + ((span[1] - span[0]) / 2) * fraction;
    const cutSpaces = scheme.spaces.filter((space) => containsSpan(perpendicularSpan(space.bounds, axis), candidate));
    const score = cutSpaces.reduce((sum, space) => sum + areaOf(space), 0) + cutSpaces.length * 0.01;
    if (score > bestScore + 0.001) {
      bestScore = score;
      best = candidate;
    }
  }
  const cutSpaces = scheme.spaces.filter((space) => containsSpan(perpendicularSpan(space.bounds, axis), best));
  return { axis, coordinate: best, largest, cutSpaces };
}

function makeProjection(horizontal: readonly [number, number], vertical: readonly [number, number]): SectionProjection {
  const spanH = Math.max(0.001, horizontal[1] - horizontal[0]);
  const spanV = Math.max(0.001, vertical[1] - vertical[0]);
  const scale = Math.max(0.0001, Math.min(PLOT.w / spanH, PLOT.h / spanV) * 0.96);
  const left = PLOT.x + (PLOT.w - spanH * scale) / 2 - horizontal[0] * scale;
  const top = PLOT.y + (PLOT.h - spanV * scale) / 2;
  return {
    scale,
    toX: (value: number) => left + value * scale,
    toY: (value: number) => top + (vertical[1] - value) * scale,
  };
}

function roofBoundsOf(scheme: DesignScheme): Bounds {
  const roofs = scheme.elements.filter((element) => element.kind === 'roof');
  if (roofs.length > 0) {
    return {
      min: [
        Math.min(...roofs.map((roof) => roof.bounds.min[0])),
        Math.min(...roofs.map((roof) => roof.bounds.min[1])),
        Math.min(...roofs.map((roof) => roof.bounds.min[2])),
      ],
      max: [
        Math.max(...roofs.map((roof) => roof.bounds.max[0])),
        Math.max(...roofs.map((roof) => roof.bounds.max[1])),
        Math.max(...roofs.map((roof) => roof.bounds.max[2])),
      ],
    };
  }
  const overhang = scheme.roof.overhang;
  return {
    min: [
      scheme.site.buildingBounds.min[0] - overhang,
      scheme.site.buildingBounds.min[1],
      scheme.site.buildingBounds.min[2] - overhang,
    ],
    max: [
      scheme.site.buildingBounds.max[0] + overhang,
      scheme.site.buildingBounds.max[1],
      scheme.site.buildingBounds.max[2] + overhang,
    ],
  };
}

function horizontalRange(scheme: DesignScheme, cut: CutSelection): readonly [number, number] {
  let min = cut.axis === 'x' ? scheme.site.buildingBounds.min[0] : scheme.site.buildingBounds.min[2];
  let max = cut.axis === 'x' ? scheme.site.buildingBounds.max[0] : scheme.site.buildingBounds.max[2];
  const include = (bounds: Bounds): void => {
    const span = horizontalSpan(bounds, cut.axis);
    min = Math.min(min, span[0]);
    max = Math.max(max, span[1]);
  };
  include(roofBoundsOf(scheme));
  for (const space of cut.cutSpaces) include(space.bounds);
  for (const element of scheme.elements) {
    if (containsSpan(perpendicularSpan(element.bounds, cut.axis), cut.coordinate)) include(element.bounds);
  }
  for (const interior of scheme.interiors) {
    if (cut.cutSpaces.some((space) => space.id === interior.spaceId)) {
      for (const item of interior.furnitureSpecs) {
        if (containsSpan(perpendicularSpan(item.bounds, cut.axis), cut.coordinate)) include(item.bounds);
      }
    }
  }
  return [min - 1.2, max + 1.2];
}

function verticalRange(scheme: DesignScheme, cut: CutSelection): readonly [number, number] {
  const min = Math.min(0, scheme.site.bounds.min[1]);
  let max = Math.max(scheme.roof.ridgeHeight, scheme.roof.eaveHeight);
  for (const level of scheme.levels) max = Math.max(max, level.elevation + level.height);
  for (const space of cut.cutSpaces) max = Math.max(max, space.bounds.max[1]);
  for (const element of scheme.elements) {
    if (containsSpan(perpendicularSpan(element.bounds, cut.axis), cut.coordinate)) {
      max = Math.max(max, element.bounds.max[1]);
    }
  }
  return [min, max + 1.8];
}

function openingCuts(scheme: DesignScheme, cut: CutSelection, projection: SectionProjection): string {
  const parts: string[] = [];
  for (const opening of scheme.openings) {
    if (!containsSpan(perpendicularSpan(opening.bounds, cut.axis), cut.coordinate)) continue;
    const span = horizontalSpan(opening.bounds, cut.axis);
    const top = projection.toY(opening.bounds.max[1]);
    const bottom = projection.toY(opening.bounds.min[1]);
    parts.push(
      `<line x1="${fmt(projection.toX(span[0]))}" y1="${fmt(top)}" x2="${fmt(projection.toX(span[1]))}" y2="${fmt(top)}" stroke="${opening.kind === 'window' ? '#6f9ca3' : '#8a6b4c'}" stroke-width="${opening.kind === 'window' ? '2.4' : '2'}" stroke-dasharray="${opening.kind === 'window' ? '0' : '4 3'}"/>`,
      svgLine(projection.toX(span[0]), top, projection.toX(span[0]), bottom, {
        stroke: '#8a6b4c',
        strokeWidth: 0.8,
        opacity: 0.65,
      }),
    );
  }
  return parts.join('');
}

function spaceParts(
  cut: CutSelection,
  projection: SectionProjection,
  labels: LabelPlacer,
): { svg: string; kinds: Map<SchemeSpaceKind, string> } {
  const variants = new Map<string, number>();
  const kinds = new Map<SchemeSpaceKind, string>();
  const parts: string[] = [];
  const sorted = [...cut.cutSpaces].sort((a, b) => areaOf(b) - areaOf(a));
  for (const space of sorted) {
    const variant = variants.get(space.kind) ?? 0;
    variants.set(space.kind, variant + 1);
    const color = spaceColor(space.kind, variant);
    if (!kinds.has(space.kind)) kinds.set(space.kind, color);
    const span = horizontalSpan(space.bounds, cut.axis);
    const rect: Rect = {
      x: projection.toX(span[0]),
      y: projection.toY(space.bounds.max[1]),
      w: Math.max(1, projection.toX(span[1]) - projection.toX(span[0])),
      h: Math.max(1, projection.toY(space.bounds.min[1]) - projection.toY(space.bounds.max[1])),
    };
    parts.push(svgRect(rect, { fill: color, stroke: darken(color, 0.34), strokeWidth: 0.8, opacity: 0.84 }));
    const height = space.bounds.max[1] - space.bounds.min[1];
    const placed = labels.place({
      lines:
        rect.w >= 86 && rect.h >= 42
          ? [space.name, `${fixed(height, 1)} m 高`]
          : [rect.w >= 34 ? space.name : space.id],
      preferred: [rect.x + rect.w / 2, rect.y + rect.h * (rect.h > 88 ? 0.3 : 0.5)],
      fontSize: Math.max(8.5, Math.min(11.5, Math.sqrt(Math.max(1, rect.w * rect.h)) / 11)),
      maxWidth: Math.max(24, rect.w - 6),
      ...(rect.w >= 42 && rect.h >= 26 ? { within: rect } : {}),
    });
    if (placed !== null) parts.push(renderPlacedLabel(placed, { fill: '#38342e', weight: 600 }));
  }
  return { svg: parts.join(''), kinds };
}

function furnitureParts(
  scheme: DesignScheme,
  cut: CutSelection,
  projection: SectionProjection,
  labels: LabelPlacer,
): string {
  const cutIds = new Set(cut.cutSpaces.map((space) => space.id));
  const parts: string[] = [];
  for (const interior of scheme.interiors) {
    if (!interior.included || !cutIds.has(interior.spaceId)) continue;
    for (const furniture of interior.furnitureSpecs) {
      if (!containsSpan(perpendicularSpan(furniture.bounds, cut.axis), cut.coordinate)) continue;
      const span = horizontalSpan(furniture.bounds, cut.axis);
      const rect: Rect = {
        x: projection.toX(span[0]),
        y: projection.toY(furniture.bounds.max[1]),
        w: Math.max(1.2, projection.toX(span[1]) - projection.toX(span[0])),
        h: Math.max(1.2, projection.toY(furniture.bounds.min[1]) - projection.toY(furniture.bounds.max[1])),
      };
      const color = materialColor(scheme.materials, furniture.materialId, '#9a7651');
      parts.push(
        svgRect(rect, {
          fill: lighten(color, 0.18),
          stroke: darken(color, 0.35),
          strokeWidth: 0.9,
          rx: 1,
          opacity: 0.95,
        }),
      );
      if (rect.w >= 30 && rect.h >= 16) {
        const height = furniture.bounds.max[1] - furniture.bounds.min[1];
        const placed = labels.place({
          lines: [`${furniture.name} ${fixed(height, 1)}m`],
          preferred: [rect.x + rect.w / 2, rect.y - 6],
          fontSize: 8,
          maxWidth: Math.max(74, rect.w + 40),
        });
        if (placed !== null) parts.push(renderPlacedLabel(placed, { fill: '#5c4b38' }));
      }
    }
  }
  return parts.join('');
}

function elementParts(
  scheme: DesignScheme,
  cut: CutSelection,
  projection: SectionProjection,
  labels: LabelPlacer,
): string {
  const parts: string[] = [];
  for (const element of scheme.elements) {
    if (element.kind === 'roof' || element.kind === 'furniture') continue;
    if (!containsSpan(perpendicularSpan(element.bounds, cut.axis), cut.coordinate)) continue;
    const span = horizontalSpan(element.bounds, cut.axis);
    const color = materialColor(scheme.materials, element.material, '#8e877c');
    const rect: Rect = {
      x: projection.toX(span[0]),
      y: projection.toY(element.bounds.max[1]),
      w: Math.max(1, projection.toX(span[1]) - projection.toX(span[0])),
      h: Math.max(1, projection.toY(element.bounds.min[1]) - projection.toY(element.bounds.max[1])),
    };
    if (element.kind === 'slab') {
      parts.push(
        svgRect(rect, {
          fill: darken(color, 0.22),
          stroke: darken(color, 0.4),
          strokeWidth: 1,
          opacity: 0.96,
        }),
      );
    } else if (element.kind === 'wall') {
      parts.push(
        svgRect(rect, {
          fill: darken(color, 0.28),
          stroke: darken(color, 0.48),
          strokeWidth: 0.8,
          opacity: 0.96,
        }),
      );
    } else if (element.kind === 'column') {
      parts.push(svgRect(rect, { fill: darken(color, 0.25), stroke: darken(color, 0.45), strokeWidth: 0.7 }));
    } else if (element.kind === 'stair') {
      const lines: string[] = [];
      const count = Math.max(3, Math.min(7, Math.round(rect.h / 8)));
      for (let index = 1; index < count; index += 1) {
        lines.push(
          svgLine(rect.x, rect.y + (rect.h * index) / count, rect.x + rect.w, rect.y + (rect.h * index) / count, {
            stroke: darken(color, 0.42),
            strokeWidth: 0.6,
          }),
        );
      }
      parts.push(
        `${svgRect(rect, { fill: lighten(color, 0.28), stroke: darken(color, 0.35), strokeWidth: 0.8 })}${lines.join('')}`,
      );
    } else if (element.kind === 'glazing') {
      parts.push(
        svgRect(rect, {
          fill: withAlpha(materialColor(scheme.materials, element.material, '#a8ced3'), 0.55),
          stroke: '#638e95',
          strokeWidth: 0.9,
        }),
      );
    } else {
      parts.push(
        svgRect(rect, {
          fill: withAlpha(color, 0.25),
          stroke: withAlpha(darken(color, 0.4), 0.7),
          strokeWidth: 0.8,
          dash: '4 3',
        }),
      );
    }
    if (element.kind === 'slab' && rect.w >= 90) {
      const level = scheme.levels.find((item) => item.id === element.level);
      const placed = labels.place({
        lines: [`楼板 ${level === undefined ? '' : formatElevation(level.elevation)}`],
        preferred: [rect.x + rect.w / 2, rect.y - 8],
        fontSize: 8,
        maxWidth: 150,
      });
      if (placed !== null) parts.push(renderPlacedLabel(placed, { fill: '#5d574e' }));
    }
  }
  return parts.join('');
}

function roofProfileFor(
  scheme: DesignScheme,
  rb: Bounds,
  roofForm: DesignScheme['roof']['form'],
  pitch: number,
  material: string,
  eave: number,
  ridge: number,
  cut: CutSelection,
  projection: SectionProjection,
): RoofInfo {
  const span = horizontalSpan(rb, cut.axis);
  const ridgeAlongX = rb.max[0] - rb.min[0] >= rb.max[2] - rb.min[2];
  const slopesAlongCut = (ridgeAlongX && cut.axis === 'z') || (!ridgeAlongX && cut.axis === 'x');
  const color = materialColor(scheme.materials, material, '#6d685d');
  const line = darken(color, 0.45);
  const mid = (span[0] + span[1]) / 2;
  const labels: { text: string; point: Point2 }[] = [];
  let shape: string;
  if (slopesAlongCut && roofForm === 'butterfly') {
    const points = `${fmt(projection.toX(span[0]))},${fmt(projection.toY(ridge))} ${fmt(projection.toX(mid))},${fmt(projection.toY(eave))} ${fmt(projection.toX(span[1]))},${fmt(projection.toY(ridge))}`;
    shape = `<polyline points="${points}" fill="none" stroke="${line}" stroke-width="2.4" stroke-linejoin="round"/><polygon points="${points}" fill="${withAlpha(color, 0.24)}" stroke="none"/>`;
    labels.push({ text: `谷 ${formatElevation(eave)}`, point: [projection.toX(mid), projection.toY(eave)] });
  } else if (slopesAlongCut && roofForm === 'shed') {
    const points = `${fmt(projection.toX(span[0]))},${fmt(projection.toY(eave))} ${fmt(projection.toX(span[1]))},${fmt(projection.toY(ridge))}`;
    shape = `<polyline points="${points}" fill="none" stroke="${line}" stroke-width="2.4"/>`;
    labels.push({ text: `低檐 ${formatElevation(eave)}`, point: [projection.toX(span[0]), projection.toY(eave)] });
    labels.push({ text: `高檐 ${formatElevation(ridge)}`, point: [projection.toX(span[1]), projection.toY(ridge)] });
  } else if (slopesAlongCut && roofForm === 'curved') {
    const path = `M ${fmt(projection.toX(span[0]))} ${fmt(projection.toY(eave))} Q ${fmt(projection.toX(mid))} ${fmt(projection.toY(ridge + 0.4))} ${fmt(projection.toX(span[1]))} ${fmt(projection.toY(eave))}`;
    shape = `<path d="${path}" fill="${withAlpha(color, 0.2)}" stroke="${line}" stroke-width="2.4"/>`;
    labels.push({
      text: `曲面屋面 ${fmt(pitch, 0)}°`,
      point: [projection.toX(mid), projection.toY(ridge)],
    });
  } else if (slopesAlongCut && roofForm !== 'flat') {
    const points = `${fmt(projection.toX(span[0]))},${fmt(projection.toY(eave))} ${fmt(projection.toX(mid))},${fmt(projection.toY(ridge))} ${fmt(projection.toX(span[1]))},${fmt(projection.toY(eave))}`;
    shape = `<polygon points="${points}" fill="${withAlpha(color, 0.24)}" stroke="${line}" stroke-width="2.4" stroke-linejoin="round"/>`;
    labels.push({ text: `檐口 ${formatElevation(eave)}`, point: [projection.toX(span[0]), projection.toY(eave)] });
    labels.push({ text: `屋脊 ${formatElevation(ridge)}`, point: [projection.toX(mid), projection.toY(ridge)] });
  } else {
    const at = roofForm === 'flat' ? ridge : eave;
    shape = svgLine(projection.toX(span[0]), projection.toY(at), projection.toX(span[1]), projection.toY(at), {
      stroke: line,
      strokeWidth: 2.4,
    });
    labels.push({
      text: `${roofForm === 'flat' ? '平屋面' : '屋面'} ${formatElevation(at)}`,
      point: [projection.toX(span[1]), projection.toY(at)],
    });
  }
  const overhangLine =
    cut.axis === 'x'
      ? svgLine(projection.toX(span[0]), projection.toY(eave), projection.toX(span[1]), projection.toY(eave), {
          stroke: withAlpha(line, 0.55),
          strokeWidth: 1,
          dash: '5 4',
        })
      : svgLine(projection.toX(span[0]), projection.toY(eave), projection.toX(span[1]), projection.toY(eave), {
          stroke: withAlpha(line, 0.55),
          strokeWidth: 1,
          dash: '5 4',
        });
  return { svg: `${shape}${overhangLine}`, labels };
}

function roofProfile(scheme: DesignScheme, cut: CutSelection, projection: SectionProjection): RoofInfo {
  const segments = scheme.roof.segments;
  if (segments !== undefined && segments.length > 0) {
    const infos = segments
      .filter((segment) => containsSpan(perpendicularSpan(segment.bounds, cut.axis), cut.coordinate))
      .map((segment) =>
        roofProfileFor(
          scheme,
          segment.bounds,
          segment.form,
          segment.pitchDegrees,
          segment.material,
          segment.eaveHeight,
          segment.ridgeHeight,
          cut,
          projection,
        ),
      );
    return { svg: infos.map((info) => info.svg).join(''), labels: infos.flatMap((info) => info.labels) };
  }
  return roofProfileFor(
    scheme,
    roofBoundsOf(scheme),
    scheme.roof.form,
    scheme.roof.pitchDegrees,
    scheme.roof.material,
    scheme.roof.eaveHeight,
    scheme.roof.ridgeHeight,
    cut,
    projection,
  );
}

function roofLabelParts(labels: LabelPlacer, info: RoofInfo): string {
  return info.labels
    .map((item) => {
      const placed = labels.place({
        lines: [item.text],
        preferred: [item.point[0], item.point[1] - 12],
        fontSize: 8.5,
        maxWidth: 160,
      });
      return placed === null ? '' : renderPlacedLabel(placed, { fill: '#5b5144', weight: 600, halo: true });
    })
    .join('');
}

function levelLines(scheme: DesignScheme, projection: SectionProjection, plotRight: number): string {
  return scheme.levels
    .map((level) => {
      const y = projection.toY(level.elevation);
      return `${svgLine(PLOT.x - 8, y, plotRight, y, { stroke: withAlpha(HAIRLINE, 0.95), strokeWidth: 0.7, dash: '4 4' })}${svgText(CONTENT_X + 8, y + 3.5, `${level.name} ${formatElevation(level.elevation)}`, { size: 9, fill: MUTED })}`;
    })
    .join('');
}

function groundParts(projection: SectionProjection): string {
  const y = projection.toY(0);
  const bottom = PLOT.y + PLOT.h;
  const hatch: string[] = [];
  for (let x = PLOT.x; x < PLOT.x + PLOT.w; x += 14) {
    hatch.push(
      svgLine(x, y, x + 7, Math.min(bottom, y + 10), {
        stroke: '#bdb6a8',
        strokeWidth: 0.6,
        opacity: 0.55,
      }),
    );
  }
  return `${svgRect({ x: PLOT.x, y, w: PLOT.w, h: Math.max(0, bottom - y) }, { fill: '#efece4', opacity: 0.72 })}${svgLine(PLOT.x, y, PLOT.x + PLOT.w, y, { stroke: '#7b7468', strokeWidth: 1.4 })}${hatch.join('')}${svgText(PLOT.x + 4, y + 14, '±0.00 场地', { size: 8.5, fill: '#746d61' })}`;
}

function legendFor(scheme: DesignScheme, kinds: Map<SchemeSpaceKind, string>): ReturnType<typeof renderLegend> {
  const levels = [...scheme.levels].sort((a, b) => a.elevation - b.elevation).slice(0, 5);
  const items = [
    ...levels.map((level, index) => ({
      label: `${level.name} ${formatElevation(level.elevation)}`,
      color: levelColor(index),
      mark: 'swatch' as const,
    })),
    ...[...kinds.entries()].map(([kind, color]) => ({
      label: `${SPACE_KIND_LABEL[kind]}（切割）`,
      color,
      mark: 'swatch' as const,
    })),
    { label: '楼板 / 墙', color: '#8e877c', mark: 'swatch' as const },
    { label: '家具高度块', color: '#9a7651', mark: 'swatch' as const },
    { label: '屋面轮廓', color: '#6d685d', mark: 'line' as const },
    { label: '切割空间 / 家具', color: ACCENT, mark: 'dash' as const },
  ];
  return renderLegend('图例', items, PANEL_X, CONTENT_Y, PANEL_WIDTH);
}

/** 关键剖面整页。 */
export function renderSectionSvg(scheme: DesignScheme): string {
  const cut = chooseCut(scheme);
  const horizontal = horizontalRange(scheme, cut);
  const vertical = verticalRange(scheme, cut);
  const projection = makeProjection(horizontal, vertical);
  const plotRight = PLOT.x + PLOT.w;
  const labels = new LabelPlacer({ x: PLOT.x, y: PLOT.y, w: PLOT.w, h: PLOT.h }, 2);
  const spaces = spaceParts(cut, projection, labels);
  const furniture = furnitureParts(scheme, cut, projection, labels);
  const elements = elementParts(scheme, cut, projection, labels);
  const roof = roofProfile(scheme, cut, projection);
  const roofLabels = roofLabelParts(labels, roof);
  const legend = legendFor(scheme, spaces.kinds);
  const noteY = CONTENT_Y + legend.height + 16;
  const cutText = `${AXIS_LABEL[cut.axis === 'x' ? 'z' : 'x']} = ${fmt(cut.coordinate, 1)} m`;
  const body = [
    renderSheetHeader({
      kicker: '方案预览 / SECTION',
      title: `${scheme.meta.title} · 关键剖面 A–A`,
      subtitle: `切割线 ${cutText} · 穿过最大空间「${cut.largest.name}」 · 标高单位 m`,
      meta: `${scheme.meta.id} · v${String(scheme.meta.revision)}`,
    }),
    svgRect(PLOT, { fill: '#fcfbf7', stroke: HAIRLINE, strokeWidth: 0.8, rx: 2 }),
    groundParts(projection),
    levelLines(scheme, projection, plotRight),
    spaces.svg,
    furniture,
    elements,
    openingCuts(scheme, cut, projection),
    roof.svg,
    roofLabels,
    renderScaleBar(PLOT.x, PLOT.y + PLOT.h + 26, projection.scale),
    renderChip(PLOT.x + 176, PLOT.y + PLOT.h + 20, `切割 ${cutText}`, '#7d6b59'),
    renderChip(PLOT.x + 176, PLOT.y + PLOT.h + 46, `切割空间 ${String(cut.cutSpaces.length)} 个`, '#758a97'),
    legend.svg,
    svgText(PANEL_X + 16, noteY + 12, '示意剖面：楼层标高、楼板、屋面轮廓、', { size: 10, fill: MUTED }),
    svgText(PANEL_X + 16, noteY + 28, '切割空间与家具高度；不表达结构配筋与节点。', { size: 10, fill: MUTED }),
    svgText(PANEL_X + 16, noteY + 58, `切割线法向：${AXIS_LABEL[cut.axis === 'x' ? 'z' : 'x']} 轴，`, {
      size: 10,
      fill: FAINT,
    }),
    svgText(PANEL_X + 16, noteY + 74, `剖面沿 ${AXIS_LABEL[cut.axis]} 轴展开。`, { size: 10, fill: FAINT }),
    svgText(PANEL_X + 16, noteY + 100, '家具高度按 bounds 上沿示意，', { size: 10, fill: FAINT }),
    svgText(PANEL_X + 16, noteY + 116, '不是实际坐高 / 台面标高的测量值。', { size: 10, fill: FAINT }),
  ].join('');
  return svgDocument(
    `关键剖面示意：${scheme.meta.title}`,
    PREVIEW_WIDTH,
    PREVIEW_HEIGHT,
    `${body}${renderSheetFooter('剖面示意：只表达层高、楼板、屋面轮廓、被切空间与家具高度，不作为结构计算或施工图。', `${scheme.meta.id} · v${String(scheme.meta.revision)} · 纯 SVG 预览`)}`,
  );
}

// 明确保留给测试与未来扩展：这个文件只处理剖面，不引入场地平面。
export const SECTION_PLOT = PLOT;
