/**
 * 轴测体量整页：固定南东视角，按楼层叠放空间、家具与半透明屋面，并避让主要空间标签。
 *
 * 负责：axon.svg 的标题、图例、标签、方向与构图。
 * 不负责：等轴测数学与屋面几何（preview-axon-geometry.ts）、真实透视 / 纹理。
 * 本文件是纯函数，不做 I/O。
 */
import {
  ACCENT,
  CONTENT_Y,
  FAINT,
  LabelPlacer,
  MUTED,
  PANEL_WIDTH,
  PANEL_X,
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  darken,
  fmt,
  formatElevation,
  levelColor,
  lighten,
  measureText,
  renderChip,
  renderLegend,
  renderPlacedLabel,
  renderSheetFooter,
  renderSheetHeader,
  spaceColor,
  svgDocument,
  svgLine,
  svgText,
  withAlpha,
} from './preview-core.ts';
import type { DesignScheme, SchemeLevel, SchemeSpaceKind } from './scheme.ts';
import { AREA, materialColor } from './preview-plan-draw.ts';
import {
  furnitureBoxes,
  isoBox,
  isoPolygon,
  makeIso,
  roofAnchor,
  roofBounds,
  roofParts,
} from './preview-axon-geometry.ts';
import type { RawBox } from './preview-axon-geometry.ts';

const INK_EDGE = '#6b7378';
const ROOF_LABEL: Readonly<Record<DesignScheme['roof']['form'], string>> = {
  flat: '平屋面',
  gable: '双坡屋面',
  hip: '四坡屋面',
  shed: '单坡屋面',
  butterfly: '蝶形屋面',
  curved: '曲面屋面',
  other: '屋面',
};
const SPACE_LABEL: Readonly<Record<SchemeSpaceKind, string>> = {
  room: '房间',
  circulation: '交通',
  void: '挑空',
  service: '服务',
  outdoor: '室外',
};

interface SpaceLabelCandidate {
  readonly id: string;
  readonly name: string;
  readonly level: SchemeLevel;
  readonly centerX: number;
  readonly centerZ: number;
  readonly area: number;
}

function spaceLabelCandidates(scheme: DesignScheme, levels: readonly SchemeLevel[]): SpaceLabelCandidate[] {
  return levels
    .flatMap((level) =>
      scheme.spaces
        .filter((space) => space.level === level.id && space.kind !== 'void')
        .map((space) => ({
          id: space.id,
          name: space.name,
          level,
          centerX: (space.bounds.min[0] + space.bounds.max[0]) / 2,
          centerZ: (space.bounds.min[2] + space.bounds.max[2]) / 2,
          area: (space.bounds.max[0] - space.bounds.min[0]) * (space.bounds.max[2] - space.bounds.min[2]),
        })),
    )
    .filter((item) => item.area >= 4)
    .sort((a, b) => b.area - a.area)
    .slice(0, 9);
}

function categoryItems(scheme: DesignScheme): { label: string; color: string }[] {
  const kinds = new Set<SchemeSpaceKind>();
  for (const space of scheme.spaces) kinds.add(space.kind);
  return [...kinds].map((kind) => ({ label: `${SPACE_LABEL[kind]}空间`, color: spaceColor(kind, 0) }));
}

function orientationWidget(x: number, y: number): string {
  return [
    svgLine(x, y, x + 13.9, y + 8, { stroke: ACCENT, strokeWidth: 1.6, dash: '3 2' }),
    svgLine(x, y, x - 13.9, y + 8, { stroke: '#557785', strokeWidth: 1.6, dash: '3 2' }),
    svgLine(x, y, x, y - 16, { stroke: MUTED, strokeWidth: 1.6 }),
    svgText(x + 17, y + 12, '东', { size: 9, fill: ACCENT }),
    svgText(x - 26, y + 12, '南', { size: 9, fill: '#557785' }),
    svgText(x + 3, y - 20, '上', { size: 9, fill: MUTED }),
  ].join('');
}

/** 轴测整页。 */
export function renderAxonSvg(scheme: DesignScheme): string {
  const levels = [...scheme.levels].sort((a, b) => a.elevation - b.elevation);
  const rb = roofBounds(scheme);
  const building = scheme.site.buildingBounds;
  const overall: RawBox = {
    minX: Math.min(building.min[0] - 2, rb.min[0]),
    maxX: Math.max(building.max[0] + 2, rb.max[0]),
    minY: 0,
    maxY: Math.max(
      scheme.roof.ridgeHeight,
      scheme.roof.eaveHeight,
      rb.max[1],
      ...levels.map((level) => level.elevation + level.height),
    ),
    minZ: Math.min(building.min[2] - 2, rb.min[2]),
    maxZ: Math.max(building.max[2] + 2, rb.max[2]),
  };
  const projection = makeIso(overall, AREA);
  const ground = isoPolygon(
    [
      [building.min[0] - 2, 0, building.min[2] - 2],
      [building.max[0] + 2, 0, building.min[2] - 2],
      [building.max[0] + 2, 0, building.max[2] + 2],
      [building.min[0] - 2, 0, building.max[2] + 2],
    ],
    projection,
    '#e9e5dc',
    '#c9c2b5',
    0.7,
    '4 4',
  );
  const structureParts: string[] = [];
  levels.forEach((level, levelIndex) => {
    const base = levelColor(levelIndex);
    structureParts.push(
      isoBox(
        {
          minX: building.min[0],
          maxX: building.max[0],
          minY: Math.max(0, level.elevation - 0.14),
          maxY: level.elevation + 0.18,
          minZ: building.min[2],
          maxZ: building.max[2],
        },
        projection,
        {
          fill: base,
          topFill: lighten(base, 0.2),
          eastFill: darken(base, 0.18),
          southFill: darken(base, 0.08),
          opacity: 0.72,
          topOpacity: 0.78,
          stroke: darken(base, 0.35),
          strokeWidth: 1,
        },
      ),
    );
    const spaces = scheme.spaces
      .filter((space) => space.level === level.id)
      .sort(
        (a, b) =>
          a.bounds.min[0] +
          a.bounds.max[0] +
          a.bounds.min[2] +
          a.bounds.max[2] -
          (b.bounds.min[0] + b.bounds.max[0] + b.bounds.min[2] + b.bounds.max[2]),
      );
    spaces.forEach((space, index) => {
      const color = spaceColor(space.kind, index);
      structureParts.push(
        isoBox(
          {
            minX: space.bounds.min[0],
            maxX: space.bounds.max[0],
            minY: level.elevation,
            maxY: level.elevation + level.height,
            minZ: space.bounds.min[2],
            maxZ: space.bounds.max[2],
          },
          projection,
          {
            fill: color,
            topFill: lighten(color, 0.2),
            eastFill: darken(color, 0.18),
            southFill: darken(color, 0.08),
            opacity: 0.62,
            topOpacity: 0.3,
            topFace: true,
            stroke: withAlpha(darken(color, 0.4), 0.9),
            strokeWidth: 0.8,
          },
        ),
      );
    });
    structureParts.push(furnitureBoxes(scheme, level, projection));
  });
  const labels = new LabelPlacer(AREA, 3);
  const roomLabels: string[] = [];
  for (const candidate of spaceLabelCandidates(scheme, levels)) {
    const point = projection.toScreen(
      candidate.centerX,
      candidate.level.elevation + candidate.level.height,
      candidate.centerZ,
    );
    const placed = labels.place({
      lines: [measureText(candidate.name, 10.5) > 110 ? candidate.id : candidate.name],
      preferred: [point[0], point[1] - 14],
      fontSize: 10.5,
      maxWidth: 130,
    });
    if (placed === null) continue;
    roomLabels.push(
      `${svgLine(point[0], point[1], placed.rect.x + placed.rect.w / 2, placed.rect.y + placed.rect.h, { stroke: withAlpha(INK_EDGE, 0.62), strokeWidth: 0.8, dash: '2 2' })}${renderPlacedLabel(placed, { fill: '#30363c', weight: 650, halo: true })}`,
    );
  }
  const roofPoint = roofAnchor(scheme, projection);
  const roofColor = materialColor(scheme.materials, scheme.roof.material, '#6d685d');
  const roofLabel = labels.place({
    lines: [`${ROOF_LABEL[scheme.roof.form]} · ${fmt(scheme.roof.pitchDegrees, 0)}°`],
    preferred: [roofPoint[0], roofPoint[1] - 18],
    fontSize: 10,
    maxWidth: 170,
  });
  const furnitureColor = scheme.materials.find((material) => material.role === 'furniture')?.color ?? '#9a7651';
  const levelItems = levels.slice(0, 6).map((level, index) => ({
    label: `${level.name} · ${formatElevation(level.elevation)}`,
    color: levelColor(index),
    mark: 'swatch' as const,
  }));
  if (levels.length > 6) {
    levelItems.push({ label: `其余 ${String(levels.length - 6)} 层`, color: '#bfc4c8', mark: 'swatch' as const });
  }
  const legend = renderLegend(
    '图例',
    [
      ...levelItems,
      ...categoryItems(scheme).map((item) => ({ ...item, mark: 'swatch' as const })),
      { label: '家具体块', color: furnitureColor, mark: 'swatch' },
      { label: '屋面（半透明）', color: roofColor, mark: 'swatch' },
    ],
    PANEL_X,
    CONTENT_Y,
    PANEL_WIDTH,
  );
  const noteY = CONTENT_Y + legend.height + 16;
  const body = [
    renderSheetHeader({
      kicker: '方案预览 / AXONOMETRIC',
      title: `${scheme.meta.title} · 轴测体量`,
      subtitle: scheme.meta.concept,
      meta: `${scheme.meta.id} · v${String(scheme.meta.revision)}`,
    }),
    ground,
    structureParts.join(''),
    roofParts(scheme, projection),
    roomLabels.join(''),
    roofLabel === null ? '' : renderPlacedLabel(roofLabel, { fill: darken(roofColor, 0.55), weight: 700, halo: true }),
    renderChip(AREA.x + 12, AREA.y + 12, '等轴测 · 无真实透视', '#7d8a94'),
    renderChip(AREA.x + 12, AREA.y + 40, '固定视角：东南向', '#8a7b68'),
    legend.svg,
    svgText(PANEL_X + 16, noteY + 12, '等轴测示意：体量、楼层与屋顶关系；', { size: 10, fill: MUTED }),
    svgText(PANEL_X + 16, noteY + 28, '不做真实透视、纹理与室内人眼视角。', { size: 10, fill: MUTED }),
    orientationWidget(PANEL_X + 46, noteY + 84),
    svgText(PANEL_X + 84, noteY + 70, '东 / 南 / 上', { size: 10, fill: FAINT }),
    svgText(PANEL_X + 84, noteY + 88, '屋面半透明以露出空间', { size: 10, fill: FAINT }),
  ].join('');
  return svgDocument(
    `轴测体量示意：${scheme.meta.title}`,
    PREVIEW_WIDTH,
    PREVIEW_HEIGHT,
    `${body}${renderSheetFooter('轴测示意：用简单盒子表达体量、楼层、家具与屋顶关系，不作为施工图或真实渲染。', `${scheme.meta.id} · v${String(scheme.meta.revision)} · 纯 SVG 预览`)}`,
  );
}
