/**
 * 平面图绘制件：把 DesignScheme 的墙体、洞口、家具、元素与动线投影成 SVG 片段。
 *
 * 负责：总平面 / 楼层平面共用的低层构图、标签文本候选与安全文件名。
 * 不负责：整张图的标题、图例、页面布局与标签避让（在 preview-plan.ts 中组合）。
 * 本文件是纯函数，不做 I/O。
 */
import type { Bounds } from './primitives.ts';
import type {
  DesignScheme,
  FurnitureKind,
  SchemeElement,
  SchemeInterior,
  SchemeLevel,
  SchemeMaterial,
  SchemeOpening,
  SchemeSpace,
  SchemeSpaceKind,
} from './scheme.ts';
import {
  ACCENT,
  CONTENT_HEIGHT,
  CONTENT_WIDTH,
  CONTENT_X,
  CONTENT_Y,
  darken,
  fileStem,
  fmt,
  formatArea,
  lighten,
  withAlpha,
} from './preview-core.ts';
import type { PlanProjection, Point2, Rect } from './preview-core.ts';

export const AREA: Rect = { x: CONTENT_X, y: CONTENT_Y, w: CONTENT_WIDTH, h: CONTENT_HEIGHT };

export const ZONE_LABEL: Readonly<Record<SchemeSpaceKind, string>> = {
  room: '房间',
  circulation: '交通',
  void: '挑空',
  service: '服务',
  outdoor: '室外',
};

export const SITE_ZONE_LABEL: Readonly<Record<DesignScheme['site']['outdoorZones'][number]['kind'], string>> = {
  garden: '花园',
  terrace: '平台',
  path: '路径',
  parking: '停车',
  service: '后勤',
  water: '水景',
  other: '其他',
};

export const ENTRANCE_LABEL: Readonly<Record<DesignScheme['site']['entranceSide'], string>> = {
  north: '北',
  east: '东',
  south: '南',
  west: '西',
};

export function spacesOf(scheme: DesignScheme, levelId: string): SchemeSpace[] {
  return scheme.spaces.filter((space) => space.level === levelId);
}

export function elementsOf(scheme: DesignScheme, levelId: string): SchemeElement[] {
  return scheme.elements.filter((element) => element.level === levelId);
}

export function openingsOf(scheme: DesignScheme, levelId: string): SchemeOpening[] {
  return scheme.openings.filter((opening) => opening.level === levelId);
}

export function interiorsOf(scheme: DesignScheme, levelId: string): SchemeInterior[] {
  const ids = new Set(spacesOf(scheme, levelId).map((space) => space.id));
  return scheme.interiors.filter((interior) => ids.has(interior.spaceId) && interior.included);
}

export function materialColor(materials: readonly SchemeMaterial[], id: string, fallback: string): string {
  const material = materials.find((item) => item.id === id);
  return material?.color ?? fallback;
}

export function extend(bounds: Bounds, pad: number): Bounds {
  return {
    min: [bounds.min[0] - pad, bounds.min[1], bounds.min[2] - pad],
    max: [bounds.max[0] + pad, bounds.max[1], bounds.max[2] + pad],
  };
}

function includeBounds(current: { minX: number; maxX: number; minZ: number; maxZ: number }, bounds: Bounds): void {
  current.minX = Math.min(current.minX, bounds.min[0]);
  current.maxX = Math.max(current.maxX, bounds.max[0]);
  current.minZ = Math.min(current.minZ, bounds.min[2]);
  current.maxZ = Math.max(current.maxZ, bounds.max[2]);
}

export function levelPlanBounds(scheme: DesignScheme, level: SchemeLevel): Bounds {
  const box = {
    minX: scheme.site.buildingBounds.min[0],
    maxX: scheme.site.buildingBounds.max[0],
    minZ: scheme.site.buildingBounds.min[2],
    maxZ: scheme.site.buildingBounds.max[2],
  };
  for (const space of spacesOf(scheme, level.id)) includeBounds(box, space.bounds);
  for (const element of elementsOf(scheme, level.id)) includeBounds(box, element.bounds);
  for (const opening of openingsOf(scheme, level.id)) includeBounds(box, opening.bounds);
  for (const interior of interiorsOf(scheme, level.id)) {
    for (const furniture of interior.furnitureSpecs) includeBounds(box, furniture.bounds);
  }
  for (const route of scheme.circulation.filter((item) => item.level === level.id)) {
    for (const point of route.points) {
      box.minX = Math.min(box.minX, point[0]);
      box.maxX = Math.max(box.maxX, point[0]);
      box.minZ = Math.min(box.minZ, point[2]);
      box.maxZ = Math.max(box.maxZ, point[2]);
    }
  }
  return {
    min: [box.minX, 0, box.minZ],
    max: [box.maxX, 1, box.maxZ],
  };
}

export function gridLines(projection: PlanProjection, bounds: Bounds): string {
  const step = projection.scale >= 26 ? 1 : projection.scale >= 11 ? 5 : 10;
  const lines: string[] = [];
  const left = projection.toX(bounds.min[0]);
  const right = projection.toX(bounds.max[0]);
  const top = projection.toY(bounds.min[2]);
  const bottom = projection.toY(bounds.max[2]);
  const minX = Math.ceil(bounds.min[0] / step) * step;
  const minZ = Math.ceil(bounds.min[2] / step) * step;
  for (let x = minX; x <= bounds.max[0]; x += step) {
    const screenX = projection.toX(x);
    lines.push(
      `<line x1="${fmt(screenX)}" y1="${fmt(top)}" x2="${fmt(screenX)}" y2="${fmt(bottom)}" stroke="#ddd8cd" stroke-width="0.5" opacity="0.55"/>`,
    );
  }
  for (let z = minZ; z <= bounds.max[2]; z += step) {
    const screenY = projection.toY(z);
    lines.push(
      `<line x1="${fmt(left)}" y1="${fmt(screenY)}" x2="${fmt(right)}" y2="${fmt(screenY)}" stroke="#ddd8cd" stroke-width="0.5" opacity="0.55"/>`,
    );
  }
  return lines.join('');
}

export function zoneLabel(zone: DesignScheme['site']['outdoorZones'][number], rect: Rect): readonly string[] {
  const area = formatArea(zone.bounds);
  if (rect.w >= 110 && rect.h >= 48) return [zone.name, `${area} 外包`];
  if (rect.w >= 56 && rect.h >= 28) return [zone.name, area];
  if (rect.w >= 22 && rect.h >= 12) return [zone.name];
  return [zone.id];
}

export function buildingLabel(scheme: DesignScheme, rect: Rect): readonly string[] {
  const width = scheme.site.buildingBounds.max[0] - scheme.site.buildingBounds.min[0];
  const depth = scheme.site.buildingBounds.max[2] - scheme.site.buildingBounds.min[2];
  if (rect.w >= 130 && rect.h >= 48) return ['建筑主体', `${fmt(width, 1)} × ${fmt(depth, 1)} m`];
  if (rect.w >= 70 && rect.h >= 26) return ['建筑主体'];
  return [scheme.meta.title];
}

export function entranceArrow(
  scheme: DesignScheme,
  projection: PlanProjection,
  markerId: string,
  fromSite: boolean,
): { svg: string; label: Point2; side: string } {
  const site = scheme.site.bounds;
  const building = scheme.site.buildingBounds;
  const side = scheme.site.entranceSide;
  const cx = (building.min[0] + building.max[0]) / 2;
  const cz = (building.min[2] + building.max[2]) / 2;
  const outer = fromSite ? site : extend(building, 2.6);
  let start: Point2;
  let end: Point2;
  let label: Point2;
  if (side === 'north') {
    start = [cx, fromSite ? site.min[2] + 0.7 : outer.min[2] + 0.4];
    end = [cx, building.min[2] - 0.45];
    label = [start[0] + 0.6, start[1]];
  } else if (side === 'south') {
    start = [cx, fromSite ? site.max[2] - 0.7 : outer.max[2] - 0.4];
    end = [cx, building.max[2] + 0.45];
    label = [start[0] + 0.6, start[1]];
  } else if (side === 'west') {
    start = [fromSite ? site.min[0] + 0.7 : outer.min[0] + 0.4, cz];
    end = [building.min[0] - 0.45, cz];
    label = [start[0], start[1] - 0.7];
  } else {
    start = [fromSite ? site.max[0] - 0.7 : outer.max[0] - 0.4, cz];
    end = [building.max[0] + 0.45, cz];
    label = [start[0], start[1] - 0.7];
  }
  const x1 = projection.toX(start[0]);
  const y1 = projection.toY(start[1]);
  const x2 = projection.toX(end[0]);
  const y2 = projection.toY(end[1]);
  return {
    label: [projection.toX(label[0]), projection.toY(label[1])],
    side: ENTRANCE_LABEL[side],
    svg: `<g>${fmtLine(x1, y1, x2, y2)}<circle cx="${fmt(x1)}" cy="${fmt(y1)}" r="3.4" fill="${ACCENT}"/><line x1="${fmt(x2 - 1)}" y1="${fmt(y2)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="${ACCENT}" stroke-width="9" marker-end="url(#${markerId})"/></g>`,
  };
}

function fmtLine(x1: number, y1: number, x2: number, y2: number): string {
  return `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="${ACCENT}" stroke-width="3.4" stroke-linecap="round"/>`;
}

export interface FurniturePlan {
  readonly id: string;
  readonly name: string;
  readonly kind: FurnitureKind;
  readonly rect: Rect;
  readonly color: string;
}

export function furnitureShape(item: FurniturePlan): string {
  const { rect, color, kind } = item;
  if (kind === 'light') {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const radius = Math.max(5, Math.min(rect.w, rect.h) / 2);
    return `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(radius)}" fill="${withAlpha(color, 0.35)}" stroke="${darken(color, 0.3)}" stroke-width="1"/><circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(Math.max(1.5, radius * 0.32))}" fill="${color}"/>`;
  }
  const base = `<rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(Math.max(0, rect.w))}" height="${fmt(Math.max(0, rect.h))}" rx="${kind === 'rug' ? '2' : '1.5'}" fill="${kind === 'rug' ? withAlpha(color, 0.35) : lighten(color, 0.18)}" stroke="${darken(color, 0.32)}" stroke-width="${kind === 'rug' ? '1' : '1.1'}"${kind === 'rug' ? ' stroke-dasharray="4 3"' : ''}/>`;
  if (kind === 'table' || kind === 'counter') {
    return `${base}<rect x="${fmt(rect.x + 3)}" y="${fmt(rect.y + 3)}" width="${fmt(Math.max(1, rect.w - 6))}" height="${fmt(Math.max(1, rect.h - 6))}" rx="1" fill="none" stroke="${darken(color, 0.18)}" stroke-width="0.7"/>`;
  }
  if (kind === 'shelf' || kind === 'storage') {
    const count = rect.w >= rect.h ? 3 : 2;
    const lines: string[] = [];
    for (let index = 1; index <= count; index += 1) {
      const t = index / (count + 1);
      lines.push(
        rect.w >= rect.h
          ? `<line x1="${fmt(rect.x + rect.w * t)}" y1="${fmt(rect.y + 2)}" x2="${fmt(rect.x + rect.w * t)}" y2="${fmt(rect.y + rect.h - 2)}" stroke="${darken(color, 0.28)}" stroke-width="0.7"/>`
          : `<line x1="${fmt(rect.x + 2)}" y1="${fmt(rect.y + rect.h * t)}" x2="${fmt(rect.x + rect.w - 2)}" y2="${fmt(rect.y + rect.h * t)}" stroke="${darken(color, 0.28)}" stroke-width="0.7"/>`,
      );
    }
    return `${base}${lines.join('')}`;
  }
  if (kind === 'bench' || kind === 'chair') {
    return rect.w >= rect.h
      ? `${base}<line x1="${fmt(rect.x + 3)}" y1="${fmt(rect.y + rect.h * 0.3)}" x2="${fmt(rect.x + rect.w - 3)}" y2="${fmt(rect.y + rect.h * 0.3)}" stroke="${darken(color, 0.25)}" stroke-width="0.8"/>`
      : `${base}<line x1="${fmt(rect.x + rect.w * 0.3)}" y1="${fmt(rect.y + 3)}" x2="${fmt(rect.x + rect.w * 0.3)}" y2="${fmt(rect.y + rect.h - 3)}" stroke="${darken(color, 0.25)}" stroke-width="0.8"/>`;
  }
  if (kind === 'bed') {
    return `${base}<rect x="${fmt(rect.x + 4)}" y="${fmt(rect.y + 4)}" width="${fmt(Math.max(2, rect.w * 0.3))}" height="${fmt(Math.max(2, rect.h - 8))}" rx="2" fill="${lighten(color, 0.45)}" stroke="${darken(color, 0.2)}" stroke-width="0.6"/>`;
  }
  if (kind === 'appliance') {
    return `${base}<line x1="${fmt(rect.x + 3)}" y1="${fmt(rect.y + 3)}" x2="${fmt(rect.x + rect.w - 3)}" y2="${fmt(rect.y + rect.h - 3)}" stroke="${darken(color, 0.35)}" stroke-width="0.8"/>`;
  }
  return base;
}

function footprintOverlaps(a: Bounds, b: Bounds): boolean {
  return (
    Math.min(a.max[0], b.max[0]) > Math.max(a.min[0], b.min[0]) &&
    Math.min(a.max[2], b.max[2]) > Math.max(a.min[2], b.min[2])
  );
}

export function furniturePlans(scheme: DesignScheme, level: SchemeLevel, projection: PlanProjection): FurniturePlan[] {
  const specs = interiorsOf(scheme, level.id).flatMap((interior) => interior.furnitureSpecs);
  const interiors = specs.map((furniture) => ({
    id: furniture.id,
    name: furniture.name,
    kind: furniture.kind,
    rect: projection.rect(furniture.bounds),
    color: materialColor(scheme.materials, furniture.materialId, '#a58a68'),
  }));
  const elements = elementsOf(scheme, level.id)
    .filter((element) => element.kind === 'furniture')
    .filter((element) => !specs.some((spec) => footprintOverlaps(spec.bounds, element.bounds)))
    .map((element) => ({
      id: element.id,
      name: element.name,
      kind: 'other' as const,
      rect: projection.rect(element.bounds),
      color: materialColor(scheme.materials, element.material, '#a58a68'),
    }));
  return [...interiors, ...elements];
}

export function openingParts(
  scheme: DesignScheme,
  level: SchemeLevel,
  projection: PlanProjection,
): { svg: string; labels: { opening: SchemeOpening; rect: Rect }[] } {
  const elements = elementsOf(scheme, level.id);
  const parts: string[] = [];
  const labels: { opening: SchemeOpening; rect: Rect }[] = [];
  for (const opening of openingsOf(scheme, level.id)) {
    const rect = projection.rect(opening.bounds);
    const host = elements.find((element) => element.id === opening.host);
    const hostRect = host === undefined ? null : projection.rect(host.bounds);
    const horizontal =
      hostRect === null ? opening.side === 'north' || opening.side === 'south' : hostRect.w >= hostRect.h;
    const isDoor = opening.kind === 'door' || opening.kind === 'gate';
    if (!isDoor) {
      const inset = Math.min(rect.w, rect.h) * 0.12;
      parts.push(
        `<rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(Math.max(0, rect.w))}" height="${fmt(Math.max(0, rect.h))}" fill="#fbfaf6"/>`,
        `<rect x="${fmt(rect.x + inset)}" y="${fmt(rect.y + inset)}" width="${fmt(Math.max(1, rect.w - inset * 2))}" height="${fmt(Math.max(1, rect.h - inset * 2))}" fill="${withAlpha(materialColor(scheme.materials, opening.fill, '#9fc8ce'), 0.55)}" stroke="#6d979e" stroke-width="0.7"/>`,
      );
      if (horizontal) {
        const y1 = rect.y + rect.h * 0.32;
        const y2 = rect.y + rect.h * 0.68;
        parts.push(
          `<line x1="${fmt(rect.x + 1)}" y1="${fmt(y1)}" x2="${fmt(rect.x + rect.w - 1)}" y2="${fmt(y1)}" stroke="#527f86" stroke-width="1"/><line x1="${fmt(rect.x + 1)}" y1="${fmt(y2)}" x2="${fmt(rect.x + rect.w - 1)}" y2="${fmt(y2)}" stroke="#527f86" stroke-width="1"/>`,
        );
      } else {
        const x1 = rect.x + rect.w * 0.32;
        const x2 = rect.x + rect.w * 0.68;
        parts.push(
          `<line x1="${fmt(x1)}" y1="${fmt(rect.y + 1)}" x2="${fmt(x1)}" y2="${fmt(rect.y + rect.h - 1)}" stroke="#527f86" stroke-width="1"/><line x1="${fmt(x2)}" y1="${fmt(rect.y + 1)}" x2="${fmt(x2)}" y2="${fmt(rect.y + rect.h - 1)}" stroke="#527f86" stroke-width="1"/>`,
        );
      }
    } else {
      parts.push(
        `<rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(Math.max(0, rect.w))}" height="${fmt(Math.max(0, rect.h))}" fill="#fbfaf6"/>`,
      );
      const radius = Math.min(horizontal ? rect.w : rect.h, 46);
      if (horizontal) {
        const inward = opening.side === 'north' ? 1 : -1;
        const innerY = inward > 0 ? rect.y + rect.h : rect.y;
        const hingeX = rect.x + 1;
        const openY = innerY + inward * radius;
        parts.push(
          `<line x1="${fmt(hingeX)}" y1="${fmt(innerY)}" x2="${fmt(hingeX)}" y2="${fmt(openY)}" stroke="#76553a" stroke-width="1.6"/><path d="M ${fmt(hingeX + radius)} ${fmt(innerY)} A ${fmt(radius)} ${fmt(radius)} 0 0 ${inward > 0 ? '1' : '0'} ${fmt(hingeX)} ${fmt(openY)}" fill="none" stroke="#8f755d" stroke-width="0.9" stroke-dasharray="3 2"/>`,
        );
      } else {
        const inward = opening.side === 'west' ? 1 : -1;
        const innerX = inward > 0 ? rect.x + rect.w : rect.x;
        const hingeY = rect.y + 1;
        const openX = innerX + inward * radius;
        parts.push(
          `<line x1="${fmt(innerX)}" y1="${fmt(hingeY)}" x2="${fmt(openX)}" y2="${fmt(hingeY)}" stroke="#76553a" stroke-width="1.6"/><path d="M ${fmt(innerX)} ${fmt(hingeY + radius)} A ${fmt(radius)} ${fmt(radius)} 0 0 ${inward > 0 ? '0' : '1'} ${fmt(openX)} ${fmt(hingeY)}" fill="none" stroke="#8f755d" stroke-width="0.9" stroke-dasharray="3 2"/>`,
        );
      }
    }
    labels.push({ opening, rect });
  }
  return { svg: parts.join(''), labels };
}

export function routeParts(scheme: DesignScheme, level: SchemeLevel, projection: PlanProjection): string {
  return scheme.circulation
    .filter((route) => route.level === level.id)
    .map((route) => {
      const points = route.points.map((point) => `${fmt(projection.toX(point[0]))},${fmt(projection.toY(point[2]))}`);
      if (points.length < 2) return '';
      const path = `M ${points.join(' L ')}`;
      const color = route.kind === 'entry' ? ACCENT : '#557785';
      const marker = route.kind === 'entry' ? 'plan-entry-arrow' : 'plan-route-arrow';
      return `<path d="${path}" fill="none" stroke="#fbfaf6" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><path d="${path}" fill="none" stroke="${color}" stroke-width="${route.kind === 'entry' ? '3' : '2.2'}" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#${marker})"/>`;
    })
    .join('');
}

export function elementParts(scheme: DesignScheme, level: SchemeLevel, projection: PlanProjection): string {
  const parts: string[] = [];
  for (const element of elementsOf(scheme, level.id)) {
    const rect = projection.rect(element.bounds);
    const color = materialColor(scheme.materials, element.material, '#9a9488');
    const dark = darken(color, 0.28);
    switch (element.kind) {
      case 'wall':
      case 'furniture':
      case 'roof':
      case 'slab':
      case 'landscape':
        break;
      case 'stair': {
        const treads = [0.2, 0.4, 0.6, 0.8].map((t) =>
          rect.w >= rect.h
            ? `<line x1="${fmt(rect.x + rect.w * t)}" y1="${fmt(rect.y + 1)}" x2="${fmt(rect.x + rect.w * t)}" y2="${fmt(rect.y + rect.h - 1)}" stroke="${dark}" stroke-width="0.7"/>`
            : `<line x1="${fmt(rect.x + 1)}" y1="${fmt(rect.y + rect.h * t)}" x2="${fmt(rect.x + rect.w - 1)}" y2="${fmt(rect.y + rect.h * t)}" stroke="${dark}" stroke-width="0.7"/>`,
        );
        parts.push(
          `<rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.w)}" height="${fmt(rect.h)}" rx="1" fill="${lighten(color, 0.35)}" stroke="${dark}" stroke-width="1"/>${treads.join('')}`,
        );
        break;
      }
      case 'column':
        parts.push(
          `<circle cx="${fmt(rect.x + rect.w / 2)}" cy="${fmt(rect.y + rect.h / 2)}" r="3.2" fill="${darken(color, 0.25)}"/>`,
        );
        break;
      case 'railing':
        parts.push(
          `<rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.w)}" height="${fmt(rect.h)}" fill="none" stroke="${withAlpha(darken(color, 0.2), 0.7)}" stroke-width="1.4" stroke-dasharray="3 2"/>`,
        );
        break;
      case 'glazing':
        parts.push(
          `<rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.w)}" height="${fmt(rect.h)}" fill="${withAlpha(materialColor(scheme.materials, element.material, '#a8ced3'), 0.38)}" stroke="#658f96" stroke-width="1"/>`,
        );
        break;
      case 'canopy':
        parts.push(
          `<rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.w)}" height="${fmt(rect.h)}" fill="none" stroke="#948674" stroke-width="1.2" stroke-dasharray="6 4"/>`,
        );
        break;
      case 'marker':
        parts.push(
          `<circle cx="${fmt(rect.x + rect.w / 2)}" cy="${fmt(rect.y + rect.h / 2)}" r="3" fill="${ACCENT}" stroke="#fbfaf6" stroke-width="1"/>`,
        );
        break;
    }
  }
  return parts.join('');
}

export function wallParts(scheme: DesignScheme, level: SchemeLevel, projection: PlanProjection): string {
  return elementsOf(scheme, level.id)
    .filter((element) => element.kind === 'wall')
    .map((wall) => {
      const rect = projection.rect(wall.bounds);
      const color = materialColor(scheme.materials, wall.material, '#5d574e');
      return `<rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(Math.max(0.8, rect.w))}" height="${fmt(Math.max(0.8, rect.h))}" rx="0.8" fill="${darken(color, 0.12)}" stroke="${darken(color, 0.35)}" stroke-width="0.5" opacity="0.94"/>`;
    })
    .join('');
}

/** 每层平面文件名：安全、确定、冲突追加序号。 */
export function planFileNames(levels: readonly SchemeLevel[]): readonly string[] {
  const used = new Set<string>();
  return levels.map((level, index) => {
    let stem = fileStem(level.id);
    if (used.has(stem)) stem = `${stem}-${String(index + 1)}`;
    used.add(stem);
    return `plan-${stem}.svg`;
  });
}
