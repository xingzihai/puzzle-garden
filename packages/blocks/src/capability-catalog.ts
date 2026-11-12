/**
 * 方块能力目录（由 tools/build-block-catalog.ts 生成，勿手改）。
 *
 * 数据来源：Minecraft 1.20.1 官方 blockstates / models / tags + tools/mc/curated-usages.json。
 * 官方资源只在 .work/ 本地使用；本文件只含 id、状态与人工整理事实，不含贴图 / 模型二进制。
 */

export const BLOCK_CAPABILITY_VERSION = 'mc-1.20.1-1';
export const BLOCK_CAPABILITY_MC_VERSION = '1.20.1';

export interface BlockCapability {
  readonly id: string;
  readonly zh: string;
  readonly shape: string;
  readonly transparent: boolean;
  readonly luminance: number;
  readonly solid: boolean;
  /** 属性摘要，如 facing=north|east|south|west（默认 north）。 */
  readonly states: readonly string[];
  readonly defaultState: string;
  readonly placeOn: string;
  readonly support: string;
  readonly collision: string;
  readonly tags: readonly string[];
  /** 本机官方资源包里有这个方块的可渲染模型。 */
  readonly officialModel: boolean;
}

export const BLOCK_CAPABILITIES: readonly BlockCapability[] = [
  // prettier-ignore
  {"id":"andesite_wall","zh":"安山岩墙","shape":"wall","transparent":false,"luminance":0,"solid":false,"states":["east=none|low|tall（默认 none）","north=none|low|tall（默认 none）","south=none|low|tall（默认 none）","up=true|false（默认 true）","waterlogged=true|false（默认 false）","west=none|low|tall（默认 none）"],"defaultState":"andesite_wall","placeOn":"地面 / 相邻方块连接","support":"需要下方支撑，并依赖相邻方块连接","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["walls"],"officialModel":true},
  // prettier-ignore
  {"id":"barrel","zh":"木桶","shape":"cube","transparent":false,"luminance":0,"solid":true,"states":["facing=north|east|south|west|up|down（默认 north）","open=true|false（默认 false）"],"defaultState":"barrel","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"有完整碰撞","tags":["guarded_by_piglins"],"officialModel":true},
  // prettier-ignore
  {"id":"bookshelf","zh":"书架","shape":"cube","transparent":false,"luminance":0,"solid":true,"states":[],"defaultState":"bookshelf","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"有完整碰撞","tags":["enchantment_power_provider"],"officialModel":true},
  // prettier-ignore
  {"id":"campfire","zh":"营火","shape":"light","transparent":true,"luminance":15,"solid":false,"states":["facing=north|south|west|east（默认 north）","lit=true|false（默认 true）","signal_fire=true|false（默认 false）","waterlogged=true|false（默认 false）"],"defaultState":"campfire","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["campfires"],"officialModel":true},
  // prettier-ignore
  {"id":"chain","zh":"锁链","shape":"other","transparent":true,"luminance":0,"solid":false,"states":["axis=x|y|z（默认 y）","waterlogged=true|false（默认 false）"],"defaultState":"chain","placeOn":"顶面（axis=y 垂直悬挂）","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":[],"officialModel":true},
  // prettier-ignore
  {"id":"chest","zh":"箱子","shape":"other","transparent":false,"luminance":0,"solid":false,"states":["facing=north|south|west|east（默认 north）","type=single|left|right（默认 single）","waterlogged=true|false（默认 false）"],"defaultState":"chest","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["features_cannot_replace","guarded_by_piglins","lava_pool_stone_cannot_replace"],"officialModel":true},
  // prettier-ignore
  {"id":"crafting_table","zh":"工作台","shape":"cube","transparent":false,"luminance":0,"solid":true,"states":[],"defaultState":"crafting_table","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"有完整碰撞","tags":[],"officialModel":true},
  // prettier-ignore
  {"id":"deepslate_tiles","zh":"深板岩瓦","shape":"cube","transparent":false,"luminance":0,"solid":true,"states":[],"defaultState":"deepslate_tiles","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"有完整碰撞","tags":["ancient_city_replaceable","sculk_replaceable_world_gen"],"officialModel":true},
  // prettier-ignore
  {"id":"flower_pot","zh":"花盆","shape":"other","transparent":true,"luminance":0,"solid":false,"states":[],"defaultState":"flower_pot","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["flower_pots"],"officialModel":true},
  // prettier-ignore
  {"id":"furnace","zh":"熔炉","shape":"cube","transparent":false,"luminance":0,"solid":true,"states":["facing=north|south|west|east（默认 north）","lit=true|false（默认 false）"],"defaultState":"furnace","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"有完整碰撞","tags":[],"officialModel":true},
  // prettier-ignore
  {"id":"glass","zh":"玻璃","shape":"glass","transparent":true,"luminance":0,"solid":false,"states":[],"defaultState":"glass","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["impermeable"],"officialModel":true},
  // prettier-ignore
  {"id":"glass_pane","zh":"玻璃板","shape":"pane","transparent":true,"luminance":0,"solid":false,"states":["east=true|false（默认 false）","north=true|false（默认 false）","south=true|false（默认 false）","waterlogged=true|false（默认 false）","west=true|false（默认 false）"],"defaultState":"glass_pane","placeOn":"地面 / 相邻方块连接","support":"需要下方支撑，并依赖相邻方块连接","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":[],"officialModel":true},
  // prettier-ignore
  {"id":"hay_block","zh":"干草捆","shape":"cube","transparent":false,"luminance":0,"solid":true,"states":["axis=x|y|z（默认 y）"],"defaultState":"hay_block","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"有完整碰撞","tags":[],"officialModel":true},
  // prettier-ignore
  {"id":"ladder","zh":"梯子","shape":"other","transparent":true,"luminance":0,"solid":false,"states":["facing=north|south|west|east（默认 north）","waterlogged=true|false（默认 false）"],"defaultState":"ladder","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["climbable","fall_damage_resetting"],"officialModel":true},
  // prettier-ignore
  {"id":"lantern","zh":"灯笼","shape":"light","transparent":true,"luminance":15,"solid":false,"states":["hanging=true|false（默认 false）","waterlogged=true|false（默认 false）"],"defaultState":"lantern","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":[],"officialModel":true},
  // prettier-ignore
  {"id":"lectern","zh":"讲台","shape":"other","transparent":false,"luminance":0,"solid":false,"states":["facing=north|south|west|east（默认 north）","has_book=true|false（默认 false）","powered=true|false（默认 false）"],"defaultState":"lectern","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":[],"officialModel":true},
  // prettier-ignore
  {"id":"oak_button","zh":"橡木按钮","shape":"button","transparent":true,"luminance":0,"solid":false,"states":["face=floor|wall|ceiling（默认 wall）","facing=north|south|west|east（默认 north）","powered=true|false（默认 false）"],"defaultState":"oak_button","placeOn":"墙 / 地面 / 顶面（face=wall|floor|ceiling）","support":"需要附着面；不能悬空","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["buttons","wooden_buttons"],"officialModel":true},
  // prettier-ignore
  {"id":"oak_door","zh":"橡木门","shape":"door","transparent":true,"luminance":0,"solid":false,"states":["facing=north|south|west|east（默认 north）","half=upper|lower（默认 lower）","hinge=left|right（默认 left）","open=true|false（默认 false）","powered=true|false（默认 false）"],"defaultState":"oak_door","placeOn":"地面 / 墙面 / 楼板边","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["doors","wooden_doors"],"officialModel":true},
  // prettier-ignore
  {"id":"oak_fence","zh":"橡木栅栏","shape":"fence","transparent":false,"luminance":0,"solid":false,"states":["east=true|false（默认 false）","north=true|false（默认 false）","south=true|false（默认 false）","waterlogged=true|false（默认 false）","west=true|false（默认 false）"],"defaultState":"oak_fence","placeOn":"地面 / 相邻方块连接","support":"需要下方支撑，并依赖相邻方块连接","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["fences","wooden_fences"],"officialModel":true},
  // prettier-ignore
  {"id":"oak_fence_gate","zh":"橡木栅栏门","shape":"fence_gate","transparent":false,"luminance":0,"solid":false,"states":["facing=north|south|west|east（默认 north）","in_wall=true|false（默认 false）","open=true|false（默认 false）","powered=true|false（默认 false）"],"defaultState":"oak_fence_gate","placeOn":"地面 / 墙面 / 楼板边","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["fence_gates","unstable_bottom_center"],"officialModel":true},
  // prettier-ignore
  {"id":"oak_planks","zh":"橡木木板","shape":"cube","transparent":false,"luminance":0,"solid":true,"states":[],"defaultState":"oak_planks","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"有完整碰撞","tags":["planks"],"officialModel":true},
  // prettier-ignore
  {"id":"oak_pressure_plate","zh":"橡木压力板","shape":"pressure_plate","transparent":true,"luminance":0,"solid":false,"states":["powered=true|false（默认 false）"],"defaultState":"oak_pressure_plate","placeOn":"地面 / 实体方块顶面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["pressure_plates","wall_post_override","wooden_pressure_plates"],"officialModel":true},
  // prettier-ignore
  {"id":"oak_sign","zh":"橡木告示牌","shape":"other","transparent":true,"luminance":0,"solid":false,"states":["rotation=0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15（默认 0）","waterlogged=true|false（默认 false）"],"defaultState":"oak_sign","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["all_signs","signs","standing_signs","wall_post_override"],"officialModel":false},
  // prettier-ignore
  {"id":"oak_slab","zh":"橡木台阶","shape":"slab","transparent":false,"luminance":0,"solid":false,"states":["type=top|bottom|double（默认 bottom）","waterlogged=true|false（默认 false）"],"defaultState":"oak_slab","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["slabs","wooden_slabs"],"officialModel":true},
  // prettier-ignore
  {"id":"oak_stairs","zh":"橡木楼梯","shape":"stairs","transparent":false,"luminance":0,"solid":false,"states":["facing=north|south|west|east（默认 north）","half=top|bottom（默认 bottom）","shape=straight|inner_left|inner_right|outer_left|outer_right（默认 straight）","waterlogged=true|false（默认 false）"],"defaultState":"oak_stairs","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["stairs","wooden_stairs"],"officialModel":true},
  // prettier-ignore
  {"id":"oak_trapdoor","zh":"橡木活板门","shape":"trapdoor","transparent":true,"luminance":0,"solid":false,"states":["facing=north|south|west|east（默认 north）","half=top|bottom（默认 bottom）","open=true|false（默认 false）","powered=true|false（默认 false）","waterlogged=true|false（默认 false）"],"defaultState":"oak_trapdoor","placeOn":"地面 / 墙面 / 楼板边","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["trapdoors","wooden_trapdoors"],"officialModel":true},
  // prettier-ignore
  {"id":"oak_wall_sign","zh":"墙上的橡木告示牌","shape":"other","transparent":true,"luminance":0,"solid":false,"states":["facing=north|south|west|east（默认 north）","waterlogged=true|false（默认 false）"],"defaultState":"oak_wall_sign","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["all_signs","signs","wall_post_override","wall_signs"],"officialModel":false},
  // prettier-ignore
  {"id":"rail","zh":"铁轨","shape":"other","transparent":true,"luminance":0,"solid":false,"states":["shape=north_south|east_west|ascending_east|ascending_west|ascending_north|ascending_south|south_east|south_west|north_west|north_east（默认 north_south）","waterlogged=true|false（默认 false）"],"defaultState":"rail","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["prevent_mob_spawning_inside","rails"],"officialModel":true},
  // prettier-ignore
  {"id":"red_bed","zh":"红色床","shape":"other","transparent":true,"luminance":0,"solid":false,"states":["facing=north|south|west|east（默认 north）","occupied=true|false（默认 false）","part=head|foot（默认 foot）"],"defaultState":"red_bed","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["beds"],"officialModel":true},
  // prettier-ignore
  {"id":"scaffolding","zh":"脚手架","shape":"other","transparent":true,"luminance":0,"solid":false,"states":["bottom=true|false（默认 false）","distance=0|1|2|3|4|5|6|7（默认 7）","waterlogged=true|false（默认 false）"],"defaultState":"scaffolding","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["climbable","fall_damage_resetting"],"officialModel":true},
  // prettier-ignore
  {"id":"smooth_stone_slab","zh":"平滑石头台阶","shape":"slab","transparent":false,"luminance":0,"solid":false,"states":["type=top|bottom|double（默认 bottom）","waterlogged=true|false（默认 false）"],"defaultState":"smooth_stone_slab","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["slabs"],"officialModel":true},
  // prettier-ignore
  {"id":"stone_brick_slab","zh":"石砖台阶","shape":"slab","transparent":false,"luminance":0,"solid":false,"states":["type=top|bottom|double（默认 bottom）","waterlogged=true|false（默认 false）"],"defaultState":"stone_brick_slab","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["slabs"],"officialModel":true},
  // prettier-ignore
  {"id":"stone_brick_stairs","zh":"石砖楼梯","shape":"stairs","transparent":false,"luminance":0,"solid":false,"states":["facing=north|south|west|east（默认 north）","half=top|bottom（默认 bottom）","shape=straight|inner_left|inner_right|outer_left|outer_right（默认 straight）","waterlogged=true|false（默认 false）"],"defaultState":"stone_brick_stairs","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["stairs"],"officialModel":true},
  // prettier-ignore
  {"id":"stone_brick_wall","zh":"石砖墙","shape":"wall","transparent":false,"luminance":0,"solid":false,"states":["east=none|low|tall（默认 none）","north=none|low|tall（默认 none）","south=none|low|tall（默认 none）","up=true|false（默认 true）","waterlogged=true|false（默认 false）","west=none|low|tall（默认 none）"],"defaultState":"stone_brick_wall","placeOn":"地面 / 相邻方块连接","support":"需要下方支撑，并依赖相邻方块连接","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["walls"],"officialModel":true},
  // prettier-ignore
  {"id":"stone_bricks","zh":"石砖","shape":"cube","transparent":false,"luminance":0,"solid":true,"states":[],"defaultState":"stone_bricks","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"有完整碰撞","tags":["stone_bricks"],"officialModel":true},
  // prettier-ignore
  {"id":"stone_pressure_plate","zh":"石头压力板","shape":"pressure_plate","transparent":true,"luminance":0,"solid":false,"states":["powered=true|false（默认 false）"],"defaultState":"stone_pressure_plate","placeOn":"地面 / 实体方块顶面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["pressure_plates","stone_pressure_plates","wall_post_override"],"officialModel":true},
  // prettier-ignore
  {"id":"torch","zh":"火把","shape":"light","transparent":true,"luminance":14,"solid":false,"states":[],"defaultState":"torch","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["wall_post_override"],"officialModel":true},
  // prettier-ignore
  {"id":"trapped_chest","zh":"陷阱箱","shape":"other","transparent":false,"luminance":0,"solid":false,"states":["facing=north|south|west|east（默认 north）","type=single|left|right（默认 single）","waterlogged=true|false（默认 false）"],"defaultState":"trapped_chest","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["guarded_by_piglins"],"officialModel":true},
  // prettier-ignore
  {"id":"white_carpet","zh":"白色地毯","shape":"carpet","transparent":false,"luminance":0,"solid":false,"states":[],"defaultState":"white_carpet","placeOn":"地面 / 实体方块顶面","support":"需要下方实体支撑","collision":"无完整碰撞（可穿过 / 仅装饰）","tags":["combination_step_sound_blocks","dampens_vibrations","wool_carpets"],"officialModel":true},
  // prettier-ignore
  {"id":"white_wool","zh":"白色羊毛","shape":"cube","transparent":false,"luminance":0,"solid":true,"states":[],"defaultState":"white_wool","placeOn":"地面 / 顶面 / 墙面","support":"需要下方实体支撑","collision":"有完整碰撞","tags":["dampens_vibrations","occludes_vibration_signals","wool"],"officialModel":true},
];

const BY_ID = new Map(BLOCK_CAPABILITIES.map((block) => [block.id, block]));

/** 按方块 id 查找；未知 id 返回 undefined。 */
export function blockCapability(id: string): BlockCapability | undefined {
  return BY_ID.get(id);
}

/** 目录内全部方块 id，按码点升序。 */
export function blockCapabilityIds(): readonly string[] {
  return BLOCK_CAPABILITIES.map((block) => block.id);
}
