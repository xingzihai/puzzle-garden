/** 构件包公开入口；内部写入器与几何计划不属于调用方接口。 */
export { createWorld } from './world.ts';
export type {
  World,
  WorldHost,
  PlinthHandle,
  WallsHandle,
  FacadeHandle,
  OpeningHandle,
  FloorPlateHandle,
  StairHandle,
  RoofHandle,
  ColonnadeHandle,
  EnclosureHandle,
} from './world.ts';
export { rect, componentSchemas } from './schema.ts';
export { API_VERSION } from './version.ts';
export type { ApiStatus, Footprint, Surface, Side, Point, WriteLayer } from './schema.ts';
export type {
  Composition,
  Overlap,
  OverlapSource,
  OverlapSampleDetail,
  OverlapGroup,
  OverlapSummary,
} from './writer.ts';
export { MassingError } from './massing-error.ts';
export type { MassingErrorCode } from './massing-error.ts';
export type { MassingHandle, MassingPartHandle, MassingCounts, SurfaceShellHandle } from './world-types.ts';
export type { MassingAssets, MassingDocument, WorldOptions } from './massing-import.ts';
