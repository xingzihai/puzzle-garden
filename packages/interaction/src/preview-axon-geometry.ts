/* eslint-disable max-lines */
/**
 * 轴测几何：等轴测投影、盒子三面、家具盒与屋面几何。
 *
 * 负责：供 preview-axon.ts 组合的纯几何片段；固定南东视角与画家算法排序。
 * 不负责：整页标题 / 图例 / 标签避让。本文件是纯函数，不做 I/O。
 * 投影：screenX = (x − z) · cos30°，screenY = (x + z) · sin30° − y。
 */
import type { Bounds } from './primitives.ts';
import type { DesignScheme, SchemeLevel } from './scheme.ts';
import { darken, fmt, lighten, withAlpha } from './preview-core.ts';
import type { Point2, Rect } from './preview-core.ts';
import { elementsOf, materialColor } from './preview-plan-draw.ts';

const ISO_X = Math.sqrt(3) / 2;
const ISO_Y = 0.5;

export interface IsoProjection {
  readonly scale: number;
  readonly toScreen: (x: number, y: number, z: number) => Point2;
}

export interface RawBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

interface BoxStyle {
  readonly fill: string;
  readonly topFill?: string;
  readonly eastFill?: string;
  readonly southFill?: string;
  readonly opacity?: number;
  readonly topFace?: boolean;
  readonly topOpacity?: number;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly dash?: string;
}

function rawPoint(x: number, y: number, z: number): Point2 {
  return [(x - z) * ISO_X, (x + z) * ISO_Y - y];
}

export function makeIso(bounds: RawBox, area: Rect): IsoProjection {
  const corners: Point2[] = [];
  for (const x of [bounds.minX, bounds.maxX]) {
    for (const y of [bounds.minY, bounds.maxY]) {
      for (const z of [bounds.minZ, bounds.maxZ]) corners.push(rawPoint(x, y, z));
    }
  }
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  const rawMinX = Math.min(...xs);
  const rawMaxX = Math.max(...xs);
  const rawMinY = Math.min(...ys);
  const rawMaxY = Math.max(...ys);
  const scale = Math.max(
    0.0001,
    Math.min(area.w / Math.max(0.001, rawMaxX - rawMinX), area.h / Math.max(0.001, rawMaxY - rawMinY)) * 0.88,
  );
  const offsetX = area.x + (area.w - (rawMaxX - rawMinX) * scale) / 2 - rawMinX * scale;
  const offsetY = area.y + (area.h - (rawMaxY - rawMinY) * scale) / 2 - rawMinY * scale;
  return {
    scale,
    toScreen: (x: number, y: number, z: number) => {
      const point = rawPoint(x, y, z);
      return [offsetX + point[0] * scale, offsetY + point[1] * scale];
    },
  };
}

function polygon(
  points: readonly Point2[],
  fill: string,
  stroke: string,
  strokeWidth: number,
  opacity: number,
): string {
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${fmt(point[0])} ${fmt(point[1])}`).join(' ');
  return `<path d="${path} Z" fill="${fill}" stroke="${stroke}" stroke-width="${fmt(strokeWidth)}" opacity="${fmt(opacity, 3)}"/>`;
}

export function isoPolygon(
  points: readonly [number, number, number][],
  projection: IsoProjection,
  fill: string,
  stroke: string,
  opacity: number,
  dash?: string,
): string {
  const screen = points.map((point) => projection.toScreen(point[0], point[1], point[2]));
  const path = screen.map((point, index) => `${index === 0 ? 'M' : 'L'} ${fmt(point[0])} ${fmt(point[1])}`).join(' ');
  return `<path d="${path} Z" fill="${fill}" stroke="${stroke}" stroke-width="1" opacity="${fmt(opacity, 3)}"${dash === undefined ? '' : ` stroke-dasharray="${dash}"`}/>`;
}

function boxFaces(box: RawBox): {
  readonly top: readonly [number, number, number][];
  readonly east: readonly [number, number, number][];
  readonly south: readonly [number, number, number][];
} {
  return {
    top: [
      [box.minX, box.maxY, box.minZ],
      [box.maxX, box.maxY, box.minZ],
      [box.maxX, box.maxY, box.maxZ],
      [box.minX, box.maxY, box.maxZ],
    ],
    east: [
      [box.maxX, box.minY, box.minZ],
      [box.maxX, box.minY, box.maxZ],
      [box.maxX, box.maxY, box.maxZ],
      [box.maxX, box.maxY, box.minZ],
    ],
    south: [
      [box.minX, box.minY, box.maxZ],
      [box.maxX, box.minY, box.maxZ],
      [box.maxX, box.maxY, box.maxZ],
      [box.minX, box.maxY, box.maxZ],
    ],
  };
}

export function isoBox(box: RawBox, projection: IsoProjection, style: BoxStyle): string {
  const faces = boxFaces(box);
  const stroke = style.stroke ?? darken(style.fill, 0.35);
  const opacity = style.opacity ?? 0.9;
  const eastFill = style.eastFill ?? darken(style.fill, 0.16);
  const southFill = style.southFill ?? darken(style.fill, 0.07);
  const topFill = style.topFill ?? lighten(style.fill, 0.18);
  const topFace =
    style.topFace === false
      ? polygon(
          faces.top.map((point) => projection.toScreen(point[0], point[1], point[2])),
          'none',
          stroke,
          style.strokeWidth ?? 1,
          Math.max(0.4, opacity * 0.7),
        )
      : polygon(
          faces.top.map((point) => projection.toScreen(point[0], point[1], point[2])),
          topFill,
          stroke,
          style.strokeWidth ?? 1,
          style.topOpacity ?? opacity,
        );
  return [
    polygon(
      faces.east.map((point) => projection.toScreen(point[0], point[1], point[2])),
      eastFill,
      stroke,
      style.strokeWidth ?? 1,
      opacity,
    ),
    polygon(
      faces.south.map((point) => projection.toScreen(point[0], point[1], point[2])),
      southFill,
      stroke,
      style.strokeWidth ?? 1,
      opacity,
    ),
    topFace,
  ].join('');
}

function depthOf(box: RawBox): number {
  return box.minX + box.maxX + box.minZ + box.maxZ;
}

function boundsOf(bounds: Bounds): RawBox {
  return {
    minX: bounds.min[0],
    maxX: bounds.max[0],
    minY: bounds.min[1],
    maxY: bounds.max[1],
    minZ: bounds.min[2],
    maxZ: bounds.max[2],
  };
}

export function roofBounds(scheme: DesignScheme): Bounds {
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

function roofPartFor(
  scheme: DesignScheme,
  rb: Bounds,
  material: string,
  roofForm: DesignScheme['roof']['form'],
  eave: number,
  ridge: number,
  projection: IsoProjection,
): string {
  const color = materialColor(scheme.materials, material, '#6d685d');
  const midX = (rb.min[0] + rb.max[0]) / 2;
  const midZ = (rb.min[2] + rb.max[2]) / 2;
  const widthX = rb.max[0] - rb.min[0];
  const widthZ = rb.max[2] - rb.min[2];
  const longX = widthX >= widthZ;
  const fill = withAlpha(color, 0.55);
  const edge = darken(color, 0.4);
  const planes: string[] = [];

  if (roofForm === 'gable' || roofForm === 'hip' || roofForm === 'butterfly' || roofForm === 'shed') {
    if (roofForm === 'shed') {
      if (longX) {
        const eaveY = Math.min(eave, ridge);
        const highY = Math.max(eave, ridge);
        planes.push(
          isoPolygon(
            [
              [rb.min[0], eaveY, rb.min[2]],
              [rb.max[0], eaveY, rb.min[2]],
              [rb.max[0], highY, rb.max[2]],
              [rb.min[0], highY, rb.max[2]],
            ],
            projection,
            fill,
            edge,
            0.62,
          ),
        );
      } else {
        const eaveY = Math.min(eave, ridge);
        const highY = Math.max(eave, ridge);
        planes.push(
          isoPolygon(
            [
              [rb.min[0], eaveY, rb.min[2]],
              [rb.min[0], eaveY, rb.max[2]],
              [rb.max[0], highY, rb.max[2]],
              [rb.max[0], highY, rb.min[2]],
            ],
            projection,
            fill,
            edge,
            0.62,
          ),
        );
      }
    } else if (roofForm === 'butterfly') {
      if (longX) {
        planes.push(
          isoPolygon(
            [
              [rb.min[0], ridge, rb.min[2]],
              [rb.max[0], ridge, rb.min[2]],
              [rb.max[0], eave, midZ],
              [rb.min[0], eave, midZ],
            ],
            projection,
            fill,
            edge,
            0.58,
          ),
          isoPolygon(
            [
              [rb.min[0], ridge, rb.max[2]],
              [rb.max[0], ridge, rb.max[2]],
              [rb.max[0], eave, midZ],
              [rb.min[0], eave, midZ],
            ],
            projection,
            fill,
            edge,
            0.58,
          ),
        );
      } else {
        planes.push(
          isoPolygon(
            [
              [rb.min[0], ridge, rb.min[2]],
              [rb.min[0], ridge, rb.max[2]],
              [midX, eave, rb.max[2]],
              [midX, eave, rb.min[2]],
            ],
            projection,
            fill,
            edge,
            0.58,
          ),
          isoPolygon(
            [
              [rb.max[0], ridge, rb.min[2]],
              [rb.max[0], ridge, rb.max[2]],
              [midX, eave, rb.max[2]],
              [midX, eave, rb.min[2]],
            ],
            projection,
            fill,
            edge,
            0.58,
          ),
        );
      }
    } else if (roofForm === 'hip') {
      const inset = (longX ? widthX : widthZ) * 0.22;
      if (longX) {
        const ridgeStart = rb.min[0] + inset;
        const ridgeEnd = rb.max[0] - inset;
        planes.push(
          isoPolygon(
            [
              [rb.min[0], eave, rb.max[2]],
              [rb.max[0], eave, rb.max[2]],
              [ridgeEnd, ridge, midZ],
              [ridgeStart, ridge, midZ],
            ],
            projection,
            fill,
            edge,
            0.6,
          ),
          isoPolygon(
            [
              [rb.min[0], eave, rb.min[2]],
              [rb.max[0], eave, rb.min[2]],
              [ridgeEnd, ridge, midZ],
              [ridgeStart, ridge, midZ],
            ],
            projection,
            fill,
            edge,
            0.6,
          ),
          isoPolygon(
            [
              [rb.min[0], eave, rb.min[2]],
              [rb.min[0], eave, rb.max[2]],
              [ridgeStart, ridge, midZ],
            ],
            projection,
            fill,
            edge,
            0.6,
          ),
          isoPolygon(
            [
              [rb.max[0], eave, rb.min[2]],
              [rb.max[0], eave, rb.max[2]],
              [ridgeEnd, ridge, midZ],
            ],
            projection,
            fill,
            edge,
            0.6,
          ),
        );
      } else {
        const ridgeStart = rb.min[2] + inset;
        const ridgeEnd = rb.max[2] - inset;
        planes.push(
          isoPolygon(
            [
              [rb.max[0], eave, rb.min[2]],
              [rb.max[0], eave, rb.max[2]],
              [midX, ridge, ridgeEnd],
              [midX, ridge, ridgeStart],
            ],
            projection,
            fill,
            edge,
            0.6,
          ),
          isoPolygon(
            [
              [rb.min[0], eave, rb.min[2]],
              [rb.min[0], eave, rb.max[2]],
              [midX, ridge, ridgeEnd],
              [midX, ridge, ridgeStart],
            ],
            projection,
            fill,
            edge,
            0.6,
          ),
          isoPolygon(
            [
              [rb.min[0], eave, rb.min[2]],
              [rb.max[0], eave, rb.min[2]],
              [midX, ridge, ridgeStart],
            ],
            projection,
            fill,
            edge,
            0.6,
          ),
          isoPolygon(
            [
              [rb.min[0], eave, rb.max[2]],
              [rb.max[0], eave, rb.max[2]],
              [midX, ridge, ridgeEnd],
            ],
            projection,
            fill,
            edge,
            0.6,
          ),
        );
      }
    } else if (longX) {
      planes.push(
        isoPolygon(
          [
            [rb.min[0], eave, rb.min[2]],
            [rb.max[0], eave, rb.min[2]],
            [rb.max[0], ridge, midZ],
            [rb.min[0], ridge, midZ],
          ],
          projection,
          fill,
          edge,
          0.58,
        ),
        isoPolygon(
          [
            [rb.min[0], eave, rb.max[2]],
            [rb.max[0], eave, rb.max[2]],
            [rb.max[0], ridge, midZ],
            [rb.min[0], ridge, midZ],
          ],
          projection,
          fill,
          edge,
          0.58,
        ),
      );
    } else {
      planes.push(
        isoPolygon(
          [
            [rb.min[0], eave, rb.min[2]],
            [rb.min[0], eave, rb.max[2]],
            [midX, ridge, rb.max[2]],
            [midX, ridge, rb.min[2]],
          ],
          projection,
          fill,
          edge,
          0.58,
        ),
        isoPolygon(
          [
            [rb.max[0], eave, rb.min[2]],
            [rb.max[0], eave, rb.max[2]],
            [midX, ridge, rb.max[2]],
            [midX, ridge, rb.min[2]],
          ],
          projection,
          fill,
          edge,
          0.58,
        ),
      );
    }
  } else {
    const top = Math.max(eave, ridge);
    const bottom = Math.max(0, Math.min(eave, top - 0.35));
    planes.push(
      isoBox(
        { minX: rb.min[0], maxX: rb.max[0], minY: bottom, maxY: top, minZ: rb.min[2], maxZ: rb.max[2] },
        projection,
        {
          fill: withAlpha(color, 0.55),
          topFill: withAlpha(lighten(color, 0.25), 0.55),
          opacity: 0.55,
          topOpacity: 0.7,
        },
      ),
    );
  }

  const eaveOutline = isoPolygon(
    [
      [rb.min[0], eave, rb.min[2]],
      [rb.max[0], eave, rb.min[2]],
      [rb.max[0], eave, rb.max[2]],
      [rb.min[0], eave, rb.max[2]],
    ],
    projection,
    'none',
    edge,
    0.5,
    '5 4',
  );
  const ridgePoint = projection.toScreen(midX, ridge, midZ);
  const ridgeMark =
    roofForm === 'flat' ? '' : `<circle cx="${fmt(ridgePoint[0])}" cy="${fmt(ridgePoint[1])}" r="2.6" fill="${edge}"/>`;
  return `${planes.join('')}${eaveOutline}${ridgeMark}`;
}

export function roofParts(scheme: DesignScheme, projection: IsoProjection): string {
  const segments = scheme.roof.segments;
  if (segments !== undefined && segments.length > 0) {
    return segments
      .map((segment) =>
        roofPartFor(
          scheme,
          segment.bounds,
          segment.material,
          segment.form,
          segment.eaveHeight,
          segment.ridgeHeight,
          projection,
        ),
      )
      .join('');
  }
  const roofs = scheme.elements.filter((element) => element.kind === 'roof');
  const first = roofs[0];
  if (first === undefined) {
    return roofPartFor(
      scheme,
      roofBounds(scheme),
      scheme.roof.material,
      scheme.roof.form,
      scheme.roof.eaveHeight,
      scheme.roof.ridgeHeight,
      projection,
    );
  }
  if (roofs.length === 1) {
    return roofPartFor(
      scheme,
      first.bounds,
      first.material,
      scheme.roof.form,
      scheme.roof.eaveHeight,
      scheme.roof.ridgeHeight,
      projection,
    );
  }
  return roofs
    .map((roof) =>
      roofPartFor(
        scheme,
        roof.bounds,
        roof.material,
        scheme.roof.form,
        roof.bounds.min[1],
        roof.bounds.max[1] - (roof.thickness ?? 0),
        projection,
      ),
    )
    .join('');
}

export function roofAnchor(scheme: DesignScheme, projection: IsoProjection): Point2 {
  const rb = roofBounds(scheme);
  const roofs = scheme.elements.filter((element) => element.kind === 'roof');
  const top = Math.max(scheme.roof.eaveHeight, scheme.roof.ridgeHeight, ...roofs.map((roof) => roof.bounds.max[1]));
  return projection.toScreen((rb.min[0] + rb.max[0]) / 2, top + 0.4, (rb.min[2] + rb.max[2]) / 2);
}

/** 家具在轴测里的简单盒子；只取 included 室内与未重复的元素家具。 */
export function furnitureBoxes(scheme: DesignScheme, level: SchemeLevel, projection: IsoProjection): string {
  const spaceIds = new Set(scheme.spaces.filter((space) => space.level === level.id).map((space) => space.id));
  const specs = scheme.interiors
    .filter((interior) => interior.included && spaceIds.has(interior.spaceId))
    .flatMap((interior) => interior.furnitureSpecs);
  const furniture: { box: RawBox; color: string }[] = specs.map((item) => ({
    box: boundsOf(item.bounds),
    color: materialColor(scheme.materials, item.materialId, '#9a7651'),
  }));
  for (const element of elementsOf(scheme, level.id).filter((item) => item.kind === 'furniture')) {
    const overlap = specs.some(
      (spec) =>
        Math.min(spec.bounds.max[0], element.bounds.max[0]) > Math.max(spec.bounds.min[0], element.bounds.min[0]) &&
        Math.min(spec.bounds.max[2], element.bounds.max[2]) > Math.max(spec.bounds.min[2], element.bounds.min[2]),
    );
    if (!overlap) {
      furniture.push({
        box: boundsOf(element.bounds),
        color: materialColor(scheme.materials, element.material, '#9a7651'),
      });
    }
  }
  return furniture
    .sort((a, b) => depthOf(a.box) - depthOf(b.box))
    .map((item) =>
      isoBox(item.box, projection, {
        fill: item.color,
        topFill: lighten(item.color, 0.22),
        opacity: 0.95,
        stroke: darken(item.color, 0.42),
        strokeWidth: 0.6,
      }),
    )
    .join('');
}
