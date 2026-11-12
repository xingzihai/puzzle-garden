/**
 * DesignScheme 的跨集合校验：id 唯一、引用完整、场地 / 楼层 / 洞口 / 家具 / 屋面一致性。
 *
 * 负责：只读取已经通过结构 schema 的方案数据，向 zod 的 RefinementCtx 追加问题。
 * 不负责：结构 schema（scheme.ts）、报告 / 简报编译、I/O。本文件是纯函数。
 */
import type { z } from 'zod';

import { boundsOverlap, boundsWithin } from './primitives.ts';
import type {
  DesignSite,
  SchemeCirculation,
  SchemeDecision,
  SchemeDetail,
  SchemeElement,
  SchemeFacade,
  SchemeInterior,
  SchemeLevel,
  SchemeMaterial,
  SchemeOpening,
  SchemeOpenItem,
  SchemeRoof,
  SchemeSpace,
} from './scheme.ts';

/**
 * 校验只需要读取的字段。用独立的显式结构而不是 `DesignScheme` 的推导类型，
 * 避免 scheme.ts → scheme-validation.ts → scheme.ts 的类型推断成环。
 */
export interface DesignSchemeData {
  readonly site: DesignSite;
  readonly levels: readonly SchemeLevel[];
  readonly spaces: readonly SchemeSpace[];
  readonly elements: readonly SchemeElement[];
  readonly openings: readonly SchemeOpening[];
  readonly circulation: readonly SchemeCirculation[];
  readonly materials: readonly SchemeMaterial[];
  readonly facades: readonly SchemeFacade[];
  readonly details: readonly SchemeDetail[];
  readonly interiors: readonly SchemeInterior[];
  readonly decisions: readonly SchemeDecision[];
  readonly open: readonly SchemeOpenItem[];
  readonly roof: SchemeRoof;
}

/** 供 DesignScheme.superRefine 使用；所有跨集合引用在这里一次校验。 */
export function checkDesignScheme(scheme: DesignSchemeData, ctx: z.RefinementCtx): void {
  if (!boundsWithin(scheme.site.buildingBounds, scheme.site.bounds)) {
    ctx.addIssue({
      code: 'custom',
      path: ['site', 'buildingBounds'],
      message: '建筑范围必须完整落在场地范围内',
    });
  }

  const zoneIds = new Set<string>();
  scheme.site.outdoorZones.forEach((zone, index) => {
    if (zoneIds.has(zone.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['site', 'outdoorZones', index, 'id'],
        message: `场地区域 id 重复：${zone.id}`,
      });
    }
    zoneIds.add(zone.id);
    if (!boundsWithin(zone.bounds, scheme.site.bounds)) {
      ctx.addIssue({
        code: 'custom',
        path: ['site', 'outdoorZones', index, 'bounds'],
        message: `场地区域 ${zone.id} 超出场地范围`,
      });
    }
  });

  const levelIds = new Set<string>();
  scheme.levels.forEach((level, index) => {
    if (levelIds.has(level.id)) {
      ctx.addIssue({ code: 'custom', path: ['levels', index, 'id'], message: `楼层 id 重复：${level.id}` });
    }
    levelIds.add(level.id);
  });

  const spaceIds = new Set<string>();
  const spaceById = new Map(scheme.spaces.map((space) => [space.id, space]));
  scheme.spaces.forEach((space, index) => {
    if (spaceIds.has(space.id)) {
      ctx.addIssue({ code: 'custom', path: ['spaces', index, 'id'], message: `空间 id 重复：${space.id}` });
    }
    spaceIds.add(space.id);
    if (!levelIds.has(space.level)) {
      ctx.addIssue({
        code: 'custom',
        path: ['spaces', index, 'level'],
        message: `空间 ${space.id} 引用了不存在的楼层 ${space.level}`,
      });
    }
  });
  scheme.spaces.forEach((space, index) => {
    space.connections.forEach((reference, refIndex) => {
      if (!spaceIds.has(reference)) {
        ctx.addIssue({
          code: 'custom',
          path: ['spaces', index, 'connections', refIndex],
          message: `空间 ${space.id} 引用了不存在的连接空间 ${reference}`,
        });
      }
    });
  });

  const elementIds = new Map<string, SchemeElement>();
  scheme.elements.forEach((element, index) => {
    if (elementIds.has(element.id)) {
      ctx.addIssue({ code: 'custom', path: ['elements', index, 'id'], message: `元素 id 重复：${element.id}` });
    }
    elementIds.set(element.id, element);
    if (!levelIds.has(element.level)) {
      ctx.addIssue({
        code: 'custom',
        path: ['elements', index, 'level'],
        message: `元素 ${element.id} 引用了不存在的楼层 ${element.level}`,
      });
    }
    if (element.spaceId !== null && !spaceIds.has(element.spaceId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['elements', index, 'spaceId'],
        message: `元素 ${element.id} 引用了不存在的空间 ${element.spaceId}`,
      });
    }
  });

  const openingIds = new Set<string>();
  scheme.openings.forEach((opening, index) => {
    if (openingIds.has(opening.id)) {
      ctx.addIssue({ code: 'custom', path: ['openings', index, 'id'], message: `洞口 id 重复：${opening.id}` });
    }
    openingIds.add(opening.id);
    if (!levelIds.has(opening.level)) {
      ctx.addIssue({
        code: 'custom',
        path: ['openings', index, 'level'],
        message: `洞口 ${opening.id} 引用了不存在的楼层 ${opening.level}`,
      });
    }
    const host = elementIds.get(opening.host);
    if (host === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['openings', index, 'host'],
        message: `洞口 ${opening.id} 引用了不存在的宿主元素 ${opening.host}`,
      });
    } else {
      if (host.kind !== 'wall' && host.kind !== 'slab') {
        ctx.addIssue({
          code: 'custom',
          path: ['openings', index, 'host'],
          message: `洞口 ${opening.id} 的宿主必须是墙或楼板，实际是 ${host.kind}`,
        });
      }
      if (host.level !== opening.level) {
        ctx.addIssue({
          code: 'custom',
          path: ['openings', index, 'level'],
          message: `洞口 ${opening.id} 与宿主 ${host.id} 不在同一楼层`,
        });
      }
    }
  });

  const circulationIds = new Set<string>();
  scheme.circulation.forEach((route, index) => {
    if (circulationIds.has(route.id)) {
      ctx.addIssue({ code: 'custom', path: ['circulation', index, 'id'], message: `路线 id 重复：${route.id}` });
    }
    circulationIds.add(route.id);
    if (!levelIds.has(route.level)) {
      ctx.addIssue({
        code: 'custom',
        path: ['circulation', index, 'level'],
        message: `路线 ${route.id} 引用了不存在的楼层 ${route.level}`,
      });
    }
    for (const [field, reference] of [
      ['fromSpaceId', route.fromSpaceId],
      ['toSpaceId', route.toSpaceId],
    ] as const) {
      if (reference !== null && !spaceIds.has(reference)) {
        ctx.addIssue({
          code: 'custom',
          path: ['circulation', index, field],
          message: `路线 ${route.id} 引用了不存在的空间 ${reference}`,
        });
      }
    }
  });

  const materialIds = new Set<string>();
  scheme.materials.forEach((material, index) => {
    if (materialIds.has(material.id)) {
      ctx.addIssue({ code: 'custom', path: ['materials', index, 'id'], message: `材质 id 重复：${material.id}` });
    }
    materialIds.add(material.id);
  });

  const facadeSides = new Set<string>();
  scheme.facades.forEach((facade, index) => {
    if (facadeSides.has(facade.side)) {
      ctx.addIssue({ code: 'custom', path: ['facades', index, 'side'], message: `立面重复：${facade.side}` });
    }
    facadeSides.add(facade.side);
    const references = [facade.baseMaterialId, facade.bodyMaterialId, facade.topMaterialId] as const;
    references.forEach((reference, refIndex) => {
      if (reference !== null && !materialIds.has(reference)) {
        ctx.addIssue({
          code: 'custom',
          path: ['facades', index, refIndex],
          message: `立面 ${facade.side} 引用了不存在的材质 ${reference}`,
        });
      }
    });
  });

  const furnitureRefIds = new Set<string>();
  for (const interior of scheme.interiors) {
    for (const furniture of interior.furnitureSpecs) furnitureRefIds.add(furniture.id);
  }
  for (const element of scheme.elements) {
    if (element.kind === 'furniture') furnitureRefIds.add(element.id);
  }
  const siteZoneIds = new Set(scheme.site.outdoorZones.map((zone) => zone.id));

  const detailIds = new Set<string>();
  scheme.details.forEach((detail, index) => {
    if (detailIds.has(detail.id)) {
      ctx.addIssue({ code: 'custom', path: ['details', index, 'id'], message: `细部 id 重复：${detail.id}` });
    }
    detailIds.add(detail.id);
    detail.elementIds.forEach((reference, refIndex) => {
      const colon = reference.indexOf(':');
      const prefix = colon > 0 ? reference.slice(0, colon) : null;
      const target = colon > 0 ? reference.slice(colon + 1) : '';
      const namespaced = prefix === 'furniture' || prefix === 'material' || prefix === 'site' ? prefix : null;
      const namespaceTargetExists =
        namespaced === 'furniture'
          ? furnitureRefIds.has(target)
          : namespaced === 'material'
            ? materialIds.has(target)
            : namespaced === 'site'
              ? siteZoneIds.has(target)
              : false;
      // 细部可以落在实体元素或洞口上（窗台、门框、门槛都常引用 opening）。
      // 先按精确 id 解析：旧方案可能存在字面以 furniture: 开头的 element / opening id。
      if (elementIds.has(reference) || openingIds.has(reference)) {
        // 精确 id 与命名空间目标同时存在时，引用有歧义，不能静默选一边。
        if (namespaceTargetExists) {
          ctx.addIssue({
            code: 'custom',
            path: ['details', index, 'elementIds', refIndex],
            message: `细部 ${detail.id} 的引用 ${reference} 同时匹配 element/opening 与 ${namespaced ?? ''} 命名空间，存在歧义`,
          });
        }
        return;
      }
      // 精确 id 不存在时，再尝试家具 / 材料 / 场地分区命名空间引用。
      if (namespaced === 'furniture') {
        if (!furnitureRefIds.has(target)) {
          ctx.addIssue({
            code: 'custom',
            path: ['details', index, 'elementIds', refIndex],
            message: `细部 ${detail.id} 引用了不存在的 furniture ${reference}`,
          });
        }
        return;
      }
      if (namespaced === 'material') {
        if (!materialIds.has(target)) {
          ctx.addIssue({
            code: 'custom',
            path: ['details', index, 'elementIds', refIndex],
            message: `细部 ${detail.id} 引用了不存在的 material ${reference}`,
          });
        }
        return;
      }
      if (namespaced === 'site') {
        if (!siteZoneIds.has(target)) {
          ctx.addIssue({
            code: 'custom',
            path: ['details', index, 'elementIds', refIndex],
            message: `细部 ${detail.id} 引用了不存在的 site ${reference}`,
          });
        }
        return;
      }
      ctx.addIssue({
        code: 'custom',
        path: ['details', index, 'elementIds', refIndex],
        message: `细部 ${detail.id} 引用了不存在的 element / opening ${reference}`,
      });
    });
  });

  const interiorIds = new Set<string>();
  scheme.interiors.forEach((interior, index) => {
    if (interiorIds.has(interior.id)) {
      ctx.addIssue({ code: 'custom', path: ['interiors', index, 'id'], message: `室内 id 重复：${interior.id}` });
    }
    interiorIds.add(interior.id);
    if (!spaceIds.has(interior.spaceId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['interiors', index, 'spaceId'],
        message: `室内 ${interior.id} 引用了不存在的空间 ${interior.spaceId}`,
      });
    }
    const furnitureIds = new Set<string>();
    interior.furnitureSpecs.forEach((furniture, furnitureIndex) => {
      if (furnitureIds.has(furniture.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['interiors', index, 'furnitureSpecs', furnitureIndex, 'id'],
          message: `室内 ${interior.id} 的家具 id 重复：${furniture.id}`,
        });
      }
      furnitureIds.add(furniture.id);
      if (!materialIds.has(furniture.materialId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['interiors', index, 'furnitureSpecs', furnitureIndex, 'materialId'],
          message: `家具 ${furniture.id} 引用了不存在的材质 ${furniture.materialId}`,
        });
      }
      // 家具只要求与所属空间有重叠：灯具、招牌、坐凳可以局部外挑，
      // 但不能完全落在空间之外。空间引用本身已在上面校验。
      const space = spaceById.get(interior.spaceId);
      if (space !== undefined && !boundsOverlap(furniture.bounds, space.bounds)) {
        ctx.addIssue({
          code: 'custom',
          path: ['interiors', index, 'furnitureSpecs', furnitureIndex, 'bounds'],
          message: `家具 ${furniture.id} 与所属空间 ${space.id} 没有重叠`,
        });
      }
    });
  });

  const decisionSource = new Set<string>();
  scheme.decisions.forEach((decision, index) => {
    if (decisionSource.has(decision.id)) {
      ctx.addIssue({ code: 'custom', path: ['decisions', index, 'id'], message: `设计决策 id 重复：${decision.id}` });
    }
    decisionSource.add(decision.id);
  });

  const openIds = new Set<string>();
  scheme.open.forEach((item, index) => {
    if (openIds.has(item.id)) {
      ctx.addIssue({ code: 'custom', path: ['open', index, 'id'], message: `未决问题 id 重复：${item.id}` });
    }
    openIds.add(item.id);
  });

  if (scheme.roof.form !== 'flat' && scheme.roof.ridgeHeight <= scheme.roof.eaveHeight) {
    ctx.addIssue({
      code: 'custom',
      path: ['roof', 'ridgeHeight'],
      message: `屋面形式 ${scheme.roof.form} 的屋脊必须高于檐口`,
    });
  }
  scheme.roof.segments?.forEach((segment, index) => {
    if (segment.form !== 'flat' && segment.ridgeHeight <= segment.eaveHeight) {
      ctx.addIssue({
        code: 'custom',
        path: ['roof', 'segments', index, 'ridgeHeight'],
        message: `屋面段 ${segment.id} 的屋脊必须高于檐口`,
      });
    }
  });
}
