/**
 * 总平面与楼层平面的整页构图：标题、图例、指北针、比例尺与标签避让。
 *
 * 负责：site.svg 与每层 plan-<level>.svg 的完整 SVG。
 * 不负责：轴测 / 剖面 / 材质板；不追求施工图深度。纯函数，不做 I/O。
 * 投影：x 向右（东），z 向下（南）；总平面与平面使用同一套屏幕方向。
 */
import {
  ACCENT,
  CONTENT_Y,
  FAINT,
  HAIRLINE,
  LabelPlacer,
  MUTED,
  PANEL_WIDTH,
  PANEL_X,
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  SITE_ZONE_COLORS,
  arrowMarker,
  darken,
  fixed,
  formatArea,
  measureText,
  planProjection,
  renderChip,
  renderLegend,
  renderNorthArrow,
  renderPlacedLabel,
  renderScaleBar,
  renderSheetFooter,
  renderSheetHeader,
  spaceColor,
  svgDocument,
  svgRect,
  svgText,
} from './preview-core.ts';
import type { DesignScheme, SchemeLevel, SchemeSpaceKind } from './scheme.ts';
import {
  AREA,
  ZONE_LABEL,
  SITE_ZONE_LABEL,
  buildingLabel,
  elementParts,
  elementsOf,
  entranceArrow,
  furniturePlans,
  furnitureShape,
  gridLines,
  levelPlanBounds,
  openingParts,
  planFileNames,
  routeParts,
  spacesOf,
  wallParts,
  zoneLabel,
} from './preview-plan-draw.ts';

function formatElevationForPlan(value: number): string {
  return `${value >= 0 ? '+' : '−'}${fixed(Math.abs(value), 2)} m`;
}

function planFrame(body: string, scheme: DesignScheme, note: string): string {
  return svgDocument(
    note,
    PREVIEW_WIDTH,
    PREVIEW_HEIGHT,
    `${body}${renderSheetFooter(note, `${scheme.meta.id} · v${String(scheme.meta.revision)} · 纯 SVG 预览`)}`,
  );
}

/** 总平面：场地、室外分区、建筑轮廓、入口、指北针、比例尺。 */
export function renderSiteSvg(scheme: DesignScheme): string {
  const projection = planProjection(scheme.site.bounds, AREA, 1);
  const siteRect = projection.rect(scheme.site.bounds);
  const buildingRect = projection.rect(scheme.site.buildingBounds);
  const labels = new LabelPlacer(AREA);
  const buildingPlaced = labels.place({
    lines: buildingLabel(scheme, buildingRect),
    preferred: [buildingRect.x + buildingRect.w / 2, buildingRect.y + buildingRect.h / 2],
    fontSize: buildingRect.w >= 130 ? 12 : 10,
    maxWidth: Math.max(36, buildingRect.w - 10),
    ...(buildingRect.w >= 62 && buildingRect.h >= 30 ? { within: buildingRect } : {}),
  });
  const zoneParts = scheme.site.outdoorZones.map((zone) => {
    const rect = projection.rect(zone.bounds);
    const color = SITE_ZONE_COLORS[zone.kind];
    const placed = labels.place({
      lines: zoneLabel(zone, rect),
      preferred: [rect.x + rect.w / 2, rect.y + rect.h / 2],
      fontSize: rect.w >= 110 && rect.h >= 48 ? 11 : 9,
      maxWidth: Math.max(24, rect.w - 8),
      ...(rect.w >= 34 && rect.h >= 20 ? { within: rect } : {}),
    });
    return `${svgRect(rect, { fill: color, stroke: darken(color, 0.28), strokeWidth: 1, rx: 2 })}${placed === null ? '' : renderPlacedLabel(placed, { fill: darken(color, 0.62), weight: 600, halo: true })}`;
  });
  const roofOutline = scheme.elements
    .filter((element) => element.kind === 'roof')
    .map((roof) =>
      svgRect(projection.rect(roof.bounds), {
        fill: 'none',
        stroke: '#9b8d77',
        strokeWidth: 1.2,
        dash: '5 4',
        rx: 2,
      }),
    )
    .join('');
  const arrow = entranceArrow(scheme, projection, 'site-entry', true);
  const arrowLabel = svgText(arrow.label[0], arrow.label[1], `入口 · ${arrow.side}`, {
    size: 10,
    fill: ACCENT,
    weight: 700,
    halo: true,
  });
  const zoneKinds = [...new Set(scheme.site.outdoorZones.map((zone) => zone.kind))];
  const legend = renderLegend(
    '图例',
    [
      { label: '建筑主体（buildingBounds）', color: '#efe0c8', mark: 'swatch' },
      ...zoneKinds.map((kind) => ({
        label: `${SITE_ZONE_LABEL[kind]} 室外区`,
        color: SITE_ZONE_COLORS[kind],
        mark: 'swatch' as const,
      })),
      { label: '入口方向', color: ACCENT, mark: 'arrow' },
    ],
    PANEL_X,
    CONTENT_Y,
    PANEL_WIDTH,
  );
  const noteY = CONTENT_Y + legend.height + 16;
  const body = [
    `<defs>${arrowMarker('site-entry', ACCENT)}</defs>`,
    renderSheetHeader({
      kicker: '方案预览 / SITE PLAN',
      title: `${scheme.meta.title} · 总平面`,
      subtitle: scheme.meta.concept,
      meta: `${scheme.meta.id} · v${String(scheme.meta.revision)}`,
    }),
    svgRect(siteRect, { fill: '#f5f2ea', stroke: '#b9b2a5', strokeWidth: 1.4, rx: 2 }),
    gridLines(projection, scheme.site.bounds),
    zoneParts.join(''),
    roofOutline,
    svgRect(buildingRect, { fill: '#f4e6d2', stroke: '#4d483f', strokeWidth: 2.2, rx: 2 }),
    buildingPlaced === null ? '' : renderPlacedLabel(buildingPlaced, { weight: 700, fill: '#332f29' }),
    arrow.svg,
    arrowLabel,
    renderNorthArrow(AREA.x + AREA.w - 42, AREA.y + 44),
    renderScaleBar(AREA.x + 12, AREA.y + AREA.h - 30, projection.scale),
    legend.svg,
    svgText(PANEL_X + 16, noteY + 12, '室外区名称与面积按 bounds 地面投影，', { size: 10, fill: MUTED }),
    svgText(PANEL_X + 16, noteY + 28, '未扣铺装厚度；建筑轮廓为 buildingBounds。', { size: 10, fill: MUTED }),
    renderChip(PANEL_X + 16, noteY + 44, `室外分区 ${String(scheme.site.outdoorZones.length)} 个`, '#7a8f64'),
    renderChip(PANEL_X + 126, noteY + 44, '指北 N ↑', '#6f8794'),
    svgText(PANEL_X + 16, noteY + 84, '屋面挑檐以虚线示意，不表示真实铺装。', { size: 10, fill: FAINT }),
  ].join('');
  return planFrame(body, scheme, '总平面示意：只表达场地分区、建筑范围与入口方向，不作为报建或施工图。');
}

/** 每层平面：只渲染该层空间 / 元素 / 洞口 / 家具 / 动线。 */
export function renderPlanSvg(scheme: DesignScheme, level: SchemeLevel): string {
  const visibleSpaces = spacesOf(scheme, level.id);
  const bounds = levelPlanBounds(scheme, level);
  const projection = planProjection(bounds, AREA, 2.8);
  const labels = new LabelPlacer(AREA);
  const variants = new Map<string, number>();
  const legendSpaces = new Map<SchemeSpaceKind, string>();
  const spaceParts = visibleSpaces.map((space) => {
    const variant = variants.get(space.kind) ?? 0;
    variants.set(space.kind, variant + 1);
    const rect = projection.rect(space.bounds);
    const color = spaceColor(space.kind, variant);
    if (!legendSpaces.has(space.kind)) legendSpaces.set(space.kind, color);
    const placed = labels.place({
      lines:
        rect.w >= 78 && rect.h >= 40
          ? [space.name, `${formatArea(space.bounds)} 外包`]
          : rect.w >= 30 && rect.h >= 18
            ? [space.name]
            : [space.id],
      preferred: [rect.x + rect.w / 2, rect.y + rect.h / 2],
      fontSize: Math.max(9, Math.min(13, Math.sqrt(Math.max(1, rect.w * rect.h)) / 10)),
      maxWidth: Math.max(20, rect.w - 8),
      ...(rect.w >= 34 && rect.h >= 24 ? { within: rect } : {}),
    });
    return `${svgRect(rect, { fill: color, stroke: darken(color, 0.35), strokeWidth: 1, rx: 2, opacity: 0.98 })}${placed === null ? '' : renderPlacedLabel(placed, { fill: '#3a3630', weight: 650 })}`;
  });
  const roofOutline = elementsOf(scheme, level.id)
    .filter((element) => element.kind === 'roof')
    .map((element) =>
      svgRect(projection.rect(element.bounds), {
        fill: 'none',
        stroke: '#948674',
        strokeWidth: 1.2,
        dash: '6 4',
        rx: 2,
      }),
    )
    .join('');
  const openings = openingParts(scheme, level, projection);
  const furnitureSvg = furniturePlans(scheme, level, projection)
    .map((item) => {
      const shape = furnitureShape(item);
      if (item.rect.w * item.rect.h < 250 || item.rect.w < 24 || item.rect.h < 10) return shape;
      const placed = labels.place({
        lines: [item.name],
        preferred: [item.rect.x + item.rect.w / 2, item.rect.y + item.rect.h / 2],
        fontSize: 8.5,
        maxWidth: Math.max(72, item.rect.w - 4),
      });
      return `${shape}${placed === null ? '' : renderPlacedLabel(placed, { fill: '#514a40' })}`;
    })
    .join('');
  const openingLabels = openings.labels
    .map(({ opening, rect }) => {
      const text = measureText(opening.name, 8.5) <= rect.w + 44 ? opening.name : opening.id;
      const placed = labels.place({
        lines: [text],
        preferred: [rect.x + rect.w / 2, rect.y + rect.h / 2 - 15],
        fontSize: 8.5,
        maxWidth: 142,
      });
      return placed === null ? '' : renderPlacedLabel(placed, { fill: '#6c4e34', halo: true });
    })
    .join('');
  const entryRoute = scheme.circulation.find((route) => route.level === level.id && route.kind === 'entry');
  const routeLabel = (() => {
    if (entryRoute === undefined) return '';
    const point = entryRoute.points[Math.floor(entryRoute.points.length / 2)] ?? entryRoute.points[0];
    if (point === undefined) return '';
    const placed = labels.place({
      lines: ['入口动线'],
      preferred: [projection.toX(point[0]) + 28, projection.toY(point[2]) - 22],
      fontSize: 9,
      maxWidth: 90,
    });
    return placed === null ? '' : renderPlacedLabel(placed, { fill: ACCENT, weight: 700, halo: true });
  })();
  const legendRows = [
    ...[...legendSpaces.entries()].map(([kind]) => ({
      label: `${ZONE_LABEL[kind]}空间`,
      color: spaceColor(kind, 0),
      mark: 'swatch' as const,
    })),
    { label: '墙（wall 条带）', color: '#5d574e', mark: 'swatch' as const },
    { label: '门 / 开启弧线', color: '#76553a', mark: 'door' as const },
    { label: '窗（双线）', color: '#527f86', mark: 'window' as const },
    { label: '家具', color: '#a58a68', mark: 'swatch' as const },
    { label: '入口动线（高亮）', color: ACCENT, mark: 'arrow' as const },
    { label: '其他动线', color: '#557785', mark: 'arrow' as const },
    ...(roofOutline === '' ? [] : [{ label: '屋面挑檐（虚线）', color: '#948674', mark: 'dash' as const }]),
  ];
  const legend = renderLegend('图例', legendRows, PANEL_X, CONTENT_Y, PANEL_WIDTH);
  const noteY = CONTENT_Y + legend.height + 16;
  const doorCount = openings.labels.filter(
    (item) => item.opening.kind === 'door' || item.opening.kind === 'gate',
  ).length;
  const windowCount = openings.labels.length - doorCount;
  const entranceLevel = [...scheme.levels].sort((a, b) => a.elevation - b.elevation)[0];
  const entrance =
    entranceLevel?.id === level.id ? entranceArrow(scheme, projection, 'plan-entrance-outside', false) : null;
  const body = [
    `<defs>${arrowMarker('plan-entry-arrow', ACCENT)}${arrowMarker('plan-route-arrow', '#557785')}${arrowMarker('plan-entrance-outside', ACCENT)}</defs>`,
    renderSheetHeader({
      kicker: '方案预览 / FLOOR PLAN',
      title: `${scheme.meta.title} · ${level.name}平面`,
      subtitle: `标高 ${formatElevationForPlan(level.elevation)} · 层高 ${fixed(level.height, 1)} m · ${String(visibleSpaces.length)} 个空间 · 面积按 bounds 外包`,
      meta: `${scheme.meta.id} · v${String(scheme.meta.revision)}`,
    }),
    svgRect(AREA, { fill: '#fcfbf7', stroke: HAIRLINE, strokeWidth: 0.8, rx: 2 }),
    gridLines(projection, bounds),
    roofOutline,
    spaceParts.join(''),
    elementParts(scheme, level, projection),
    wallParts(scheme, level, projection),
    openings.svg,
    furnitureSvg,
    routeParts(scheme, level, projection),
    entrance === null ? '' : entrance.svg,
    entrance === null
      ? ''
      : svgText(entrance.label[0], entrance.label[1], `入口 · ${entrance.side}`, {
          size: 10,
          fill: ACCENT,
          weight: 700,
          halo: true,
        }),
    openingLabels,
    routeLabel,
    visibleSpaces.length === 0
      ? svgText(AREA.x + AREA.w / 2, AREA.y + AREA.h / 2, '本层暂无空间数据', {
          size: 14,
          fill: MUTED,
          anchor: 'middle',
        })
      : '',
    renderNorthArrow(AREA.x + AREA.w - 42, AREA.y + 44),
    renderScaleBar(AREA.x + 12, AREA.y + AREA.h - 30, projection.scale),
    legend.svg,
    svgText(PANEL_X + 16, noteY + 12, '面积 = 地面投影外包，未扣墙厚；', { size: 10, fill: MUTED }),
    svgText(PANEL_X + 16, noteY + 28, '标签放不下时只显示空间 / 洞口 id。', { size: 10, fill: MUTED }),
    renderChip(PANEL_X + 16, noteY + 44, `门 ${String(doorCount)} · 窗 ${String(windowCount)}`, '#7d6b59'),
    renderChip(PANEL_X + 150, noteY + 44, level.name, '#758a97'),
    svgText(PANEL_X + 16, noteY + 90, '同层以外的空间、元素与家具不画入。', { size: 10, fill: FAINT }),
  ].join('');
  return planFrame(body, scheme, `平面示意：${level.name}；入口、主要空间、墙 / 门窗、家具与动线。不作为施工图。`);
}

export { planFileNames };
