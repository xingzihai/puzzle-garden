// 自动生成，勿手改。API 9。开发用全量声明，不用于模型提示。
export { World, Material, rect, Surface, Facade };
type BlockName =
  | 'acacia_button'
  | 'acacia_door'
  | 'acacia_fence'
  | 'acacia_fence_gate'
  | 'acacia_hanging_sign'
  | 'acacia_leaves'
  | 'acacia_log'
  | 'acacia_planks'
  | 'acacia_pressure_plate'
  | 'acacia_sapling'
  | 'acacia_sign'
  | 'acacia_slab'
  | 'acacia_stairs'
  | 'acacia_trapdoor'
  | 'acacia_wall_hanging_sign'
  | 'acacia_wall_sign'
  | 'acacia_wood'
  | 'activator_rail'
  | 'air'
  | 'allium'
  | 'amethyst_block'
  | 'amethyst_cluster'
  | 'ancient_debris'
  | 'andesite'
  | 'andesite_slab'
  | 'andesite_stairs'
  | 'andesite_wall'
  | 'anvil'
  | 'attached_melon_stem'
  | 'attached_pumpkin_stem'
  | 'azalea'
  | 'azalea_leaves'
  | 'azure_bluet'
  | 'bamboo'
  | 'bamboo_block'
  | 'bamboo_button'
  | 'bamboo_door'
  | 'bamboo_fence'
  | 'bamboo_fence_gate'
  | 'bamboo_hanging_sign'
  | 'bamboo_mosaic'
  | 'bamboo_mosaic_slab'
  | 'bamboo_mosaic_stairs'
  | 'bamboo_planks'
  | 'bamboo_pressure_plate'
  | 'bamboo_sapling'
  | 'bamboo_sign'
  | 'bamboo_slab'
  | 'bamboo_stairs'
  | 'bamboo_trapdoor'
  | 'bamboo_wall_hanging_sign'
  | 'bamboo_wall_sign'
  | 'barrel'
  | 'barrier'
  | 'basalt'
  | 'beacon'
  | 'bedrock'
  | 'bee_nest'
  | 'beehive'
  | 'beetroots'
  | 'bell'
  | 'big_dripleaf'
  | 'big_dripleaf_stem'
  | 'birch_button'
  | 'birch_door'
  | 'birch_fence'
  | 'birch_fence_gate'
  | 'birch_hanging_sign'
  | 'birch_leaves'
  | 'birch_log'
  | 'birch_planks'
  | 'birch_pressure_plate'
  | 'birch_sapling'
  | 'birch_sign'
  | 'birch_slab'
  | 'birch_stairs'
  | 'birch_trapdoor'
  | 'birch_wall_hanging_sign'
  | 'birch_wall_sign'
  | 'birch_wood'
  | 'black_banner'
  | 'black_bed'
  | 'black_candle'
  | 'black_candle_cake'
  | 'black_carpet'
  | 'black_concrete'
  | 'black_concrete_powder'
  | 'black_glazed_terracotta'
  | 'black_shulker_box'
  | 'black_stained_glass'
  | 'black_stained_glass_pane'
  | 'black_terracotta'
  | 'black_wall_banner'
  | 'black_wool'
  | 'blackstone'
  | 'blackstone_slab'
  | 'blackstone_stairs'
  | 'blackstone_wall'
  | 'blast_furnace'
  | 'blue_banner'
  | 'blue_bed'
  | 'blue_candle'
  | 'blue_candle_cake'
  | 'blue_carpet'
  | 'blue_concrete'
  | 'blue_concrete_powder'
  | 'blue_glazed_terracotta'
  | 'blue_ice'
  | 'blue_orchid'
  | 'blue_shulker_box'
  | 'blue_stained_glass'
  | 'blue_stained_glass_pane'
  | 'blue_terracotta'
  | 'blue_wall_banner'
  | 'blue_wool'
  | 'bone_block'
  | 'bookshelf'
  | 'brain_coral'
  | 'brain_coral_block'
  | 'brain_coral_fan'
  | 'brain_coral_wall_fan'
  | 'brewing_stand'
  | 'brick_slab'
  | 'brick_stairs'
  | 'brick_wall'
  | 'bricks'
  | 'brown_banner'
  | 'brown_bed'
  | 'brown_candle'
  | 'brown_candle_cake'
  | 'brown_carpet'
  | 'brown_concrete'
  | 'brown_concrete_powder'
  | 'brown_glazed_terracotta'
  | 'brown_mushroom'
  | 'brown_mushroom_block'
  | 'brown_shulker_box'
  | 'brown_stained_glass'
  | 'brown_stained_glass_pane'
  | 'brown_terracotta'
  | 'brown_wall_banner'
  | 'brown_wool'
  | 'bubble_column'
  | 'bubble_coral'
  | 'bubble_coral_block'
  | 'bubble_coral_fan'
  | 'bubble_coral_wall_fan'
  | 'budding_amethyst'
  | 'cactus'
  | 'cake'
  | 'calcite'
  | 'calibrated_sculk_sensor'
  | 'campfire'
  | 'candle'
  | 'candle_cake'
  | 'carrots'
  | 'cartography_table'
  | 'carved_pumpkin'
  | 'cauldron'
  | 'cave_air'
  | 'cave_vines'
  | 'cave_vines_plant'
  | 'chain'
  | 'chain_command_block'
  | 'cherry_button'
  | 'cherry_door'
  | 'cherry_fence'
  | 'cherry_fence_gate'
  | 'cherry_hanging_sign'
  | 'cherry_leaves'
  | 'cherry_log'
  | 'cherry_planks'
  | 'cherry_pressure_plate'
  | 'cherry_sapling'
  | 'cherry_sign'
  | 'cherry_slab'
  | 'cherry_stairs'
  | 'cherry_trapdoor'
  | 'cherry_wall_hanging_sign'
  | 'cherry_wall_sign'
  | 'cherry_wood'
  | 'chest'
  | 'chipped_anvil'
  | 'chiseled_bookshelf'
  | 'chiseled_deepslate'
  | 'chiseled_nether_bricks'
  | 'chiseled_polished_blackstone'
  | 'chiseled_quartz_block'
  | 'chiseled_red_sandstone'
  | 'chiseled_sandstone'
  | 'chiseled_stone_bricks'
  | 'chorus_flower'
  | 'chorus_plant'
  | 'clay'
  | 'coal_block'
  | 'coal_ore'
  | 'coarse_dirt'
  | 'cobbled_deepslate'
  | 'cobbled_deepslate_slab'
  | 'cobbled_deepslate_stairs'
  | 'cobbled_deepslate_wall'
  | 'cobblestone'
  | 'cobblestone_slab'
  | 'cobblestone_stairs'
  | 'cobblestone_wall'
  | 'cobweb'
  | 'cocoa'
  | 'command_block'
  | 'comparator'
  | 'composter'
  | 'conduit'
  | 'copper_block'
  | 'copper_ore'
  | 'cornflower'
  | 'cracked_deepslate_bricks'
  | 'cracked_deepslate_tiles'
  | 'cracked_nether_bricks'
  | 'cracked_polished_blackstone_bricks'
  | 'cracked_stone_bricks'
  | 'crafting_table'
  | 'creeper_head'
  | 'creeper_wall_head'
  | 'crimson_button'
  | 'crimson_door'
  | 'crimson_fence'
  | 'crimson_fence_gate'
  | 'crimson_fungus'
  | 'crimson_hanging_sign'
  | 'crimson_hyphae'
  | 'crimson_nylium'
  | 'crimson_planks'
  | 'crimson_pressure_plate'
  | 'crimson_roots'
  | 'crimson_sign'
  | 'crimson_slab'
  | 'crimson_stairs'
  | 'crimson_stem'
  | 'crimson_trapdoor'
  | 'crimson_wall_hanging_sign'
  | 'crimson_wall_sign'
  | 'crying_obsidian'
  | 'cut_copper'
  | 'cut_copper_slab'
  | 'cut_copper_stairs'
  | 'cut_red_sandstone'
  | 'cut_red_sandstone_slab'
  | 'cut_sandstone'
  | 'cut_sandstone_slab'
  | 'cyan_banner'
  | 'cyan_bed'
  | 'cyan_candle'
  | 'cyan_candle_cake'
  | 'cyan_carpet'
  | 'cyan_concrete'
  | 'cyan_concrete_powder'
  | 'cyan_glazed_terracotta'
  | 'cyan_shulker_box'
  | 'cyan_stained_glass'
  | 'cyan_stained_glass_pane'
  | 'cyan_terracotta'
  | 'cyan_wall_banner'
  | 'cyan_wool'
  | 'damaged_anvil'
  | 'dandelion'
  | 'dark_oak_button'
  | 'dark_oak_door'
  | 'dark_oak_fence'
  | 'dark_oak_fence_gate'
  | 'dark_oak_hanging_sign'
  | 'dark_oak_leaves'
  | 'dark_oak_log'
  | 'dark_oak_planks'
  | 'dark_oak_pressure_plate'
  | 'dark_oak_sapling'
  | 'dark_oak_sign'
  | 'dark_oak_slab'
  | 'dark_oak_stairs'
  | 'dark_oak_trapdoor'
  | 'dark_oak_wall_hanging_sign'
  | 'dark_oak_wall_sign'
  | 'dark_oak_wood'
  | 'dark_prismarine'
  | 'dark_prismarine_slab'
  | 'dark_prismarine_stairs'
  | 'daylight_detector'
  | 'dead_brain_coral'
  | 'dead_brain_coral_block'
  | 'dead_brain_coral_fan'
  | 'dead_brain_coral_wall_fan'
  | 'dead_bubble_coral'
  | 'dead_bubble_coral_block'
  | 'dead_bubble_coral_fan'
  | 'dead_bubble_coral_wall_fan'
  | 'dead_bush'
  | 'dead_fire_coral'
  | 'dead_fire_coral_block'
  | 'dead_fire_coral_fan'
  | 'dead_fire_coral_wall_fan'
  | 'dead_horn_coral'
  | 'dead_horn_coral_block'
  | 'dead_horn_coral_fan'
  | 'dead_horn_coral_wall_fan'
  | 'dead_tube_coral'
  | 'dead_tube_coral_block'
  | 'dead_tube_coral_fan'
  | 'dead_tube_coral_wall_fan'
  | 'decorated_pot'
  | 'deepslate'
  | 'deepslate_brick_slab'
  | 'deepslate_brick_stairs'
  | 'deepslate_brick_wall'
  | 'deepslate_bricks'
  | 'deepslate_coal_ore'
  | 'deepslate_copper_ore'
  | 'deepslate_diamond_ore'
  | 'deepslate_emerald_ore'
  | 'deepslate_gold_ore'
  | 'deepslate_iron_ore'
  | 'deepslate_lapis_ore'
  | 'deepslate_redstone_ore'
  | 'deepslate_tile_slab'
  | 'deepslate_tile_stairs'
  | 'deepslate_tile_wall'
  | 'deepslate_tiles'
  | 'detector_rail'
  | 'diamond_block'
  | 'diamond_ore'
  | 'diorite'
  | 'diorite_slab'
  | 'diorite_stairs'
  | 'diorite_wall'
  | 'dirt'
  | 'dirt_path'
  | 'dispenser'
  | 'dragon_egg'
  | 'dragon_head'
  | 'dragon_wall_head'
  | 'dried_kelp_block'
  | 'dripstone_block'
  | 'dropper'
  | 'emerald_block'
  | 'emerald_ore'
  | 'enchanting_table'
  | 'end_gateway'
  | 'end_portal'
  | 'end_portal_frame'
  | 'end_rod'
  | 'end_stone'
  | 'end_stone_brick_slab'
  | 'end_stone_brick_stairs'
  | 'end_stone_brick_wall'
  | 'end_stone_bricks'
  | 'ender_chest'
  | 'exposed_copper'
  | 'exposed_cut_copper'
  | 'exposed_cut_copper_slab'
  | 'exposed_cut_copper_stairs'
  | 'farmland'
  | 'fern'
  | 'fire'
  | 'fire_coral'
  | 'fire_coral_block'
  | 'fire_coral_fan'
  | 'fire_coral_wall_fan'
  | 'fletching_table'
  | 'flower_pot'
  | 'flowering_azalea'
  | 'flowering_azalea_leaves'
  | 'frogspawn'
  | 'frosted_ice'
  | 'furnace'
  | 'gilded_blackstone'
  | 'glass'
  | 'glass_pane'
  | 'glow_lichen'
  | 'glowstone'
  | 'gold_block'
  | 'gold_ore'
  | 'granite'
  | 'granite_slab'
  | 'granite_stairs'
  | 'granite_wall'
  | 'grass'
  | 'grass_block'
  | 'gravel'
  | 'gray_banner'
  | 'gray_bed'
  | 'gray_candle'
  | 'gray_candle_cake'
  | 'gray_carpet'
  | 'gray_concrete'
  | 'gray_concrete_powder'
  | 'gray_glazed_terracotta'
  | 'gray_shulker_box'
  | 'gray_stained_glass'
  | 'gray_stained_glass_pane'
  | 'gray_terracotta'
  | 'gray_wall_banner'
  | 'gray_wool'
  | 'green_banner'
  | 'green_bed'
  | 'green_candle'
  | 'green_candle_cake'
  | 'green_carpet'
  | 'green_concrete'
  | 'green_concrete_powder'
  | 'green_glazed_terracotta'
  | 'green_shulker_box'
  | 'green_stained_glass'
  | 'green_stained_glass_pane'
  | 'green_terracotta'
  | 'green_wall_banner'
  | 'green_wool'
  | 'grindstone'
  | 'hanging_roots'
  | 'hay_block'
  | 'heavy_weighted_pressure_plate'
  | 'honey_block'
  | 'honeycomb_block'
  | 'hopper'
  | 'horn_coral'
  | 'horn_coral_block'
  | 'horn_coral_fan'
  | 'horn_coral_wall_fan'
  | 'ice'
  | 'infested_chiseled_stone_bricks'
  | 'infested_cobblestone'
  | 'infested_cracked_stone_bricks'
  | 'infested_deepslate'
  | 'infested_mossy_stone_bricks'
  | 'infested_stone'
  | 'infested_stone_bricks'
  | 'iron_bars'
  | 'iron_block'
  | 'iron_door'
  | 'iron_ore'
  | 'iron_trapdoor'
  | 'jack_o_lantern'
  | 'jigsaw'
  | 'jukebox'
  | 'jungle_button'
  | 'jungle_door'
  | 'jungle_fence'
  | 'jungle_fence_gate'
  | 'jungle_hanging_sign'
  | 'jungle_leaves'
  | 'jungle_log'
  | 'jungle_planks'
  | 'jungle_pressure_plate'
  | 'jungle_sapling'
  | 'jungle_sign'
  | 'jungle_slab'
  | 'jungle_stairs'
  | 'jungle_trapdoor'
  | 'jungle_wall_hanging_sign'
  | 'jungle_wall_sign'
  | 'jungle_wood'
  | 'kelp'
  | 'kelp_plant'
  | 'ladder'
  | 'lantern'
  | 'lapis_block'
  | 'lapis_ore'
  | 'large_amethyst_bud'
  | 'large_fern'
  | 'lava'
  | 'lava_cauldron'
  | 'lectern'
  | 'lever'
  | 'light'
  | 'light_blue_banner'
  | 'light_blue_bed'
  | 'light_blue_candle'
  | 'light_blue_candle_cake'
  | 'light_blue_carpet'
  | 'light_blue_concrete'
  | 'light_blue_concrete_powder'
  | 'light_blue_glazed_terracotta'
  | 'light_blue_shulker_box'
  | 'light_blue_stained_glass'
  | 'light_blue_stained_glass_pane'
  | 'light_blue_terracotta'
  | 'light_blue_wall_banner'
  | 'light_blue_wool'
  | 'light_gray_banner'
  | 'light_gray_bed'
  | 'light_gray_candle'
  | 'light_gray_candle_cake'
  | 'light_gray_carpet'
  | 'light_gray_concrete'
  | 'light_gray_concrete_powder'
  | 'light_gray_glazed_terracotta'
  | 'light_gray_shulker_box'
  | 'light_gray_stained_glass'
  | 'light_gray_stained_glass_pane'
  | 'light_gray_terracotta'
  | 'light_gray_wall_banner'
  | 'light_gray_wool'
  | 'light_weighted_pressure_plate'
  | 'lightning_rod'
  | 'lilac'
  | 'lily_of_the_valley'
  | 'lily_pad'
  | 'lime_banner'
  | 'lime_bed'
  | 'lime_candle'
  | 'lime_candle_cake'
  | 'lime_carpet'
  | 'lime_concrete'
  | 'lime_concrete_powder'
  | 'lime_glazed_terracotta'
  | 'lime_shulker_box'
  | 'lime_stained_glass'
  | 'lime_stained_glass_pane'
  | 'lime_terracotta'
  | 'lime_wall_banner'
  | 'lime_wool'
  | 'lodestone'
  | 'loom'
  | 'magenta_banner'
  | 'magenta_bed'
  | 'magenta_candle'
  | 'magenta_candle_cake'
  | 'magenta_carpet'
  | 'magenta_concrete'
  | 'magenta_concrete_powder'
  | 'magenta_glazed_terracotta'
  | 'magenta_shulker_box'
  | 'magenta_stained_glass'
  | 'magenta_stained_glass_pane'
  | 'magenta_terracotta'
  | 'magenta_wall_banner'
  | 'magenta_wool'
  | 'magma_block'
  | 'mangrove_button'
  | 'mangrove_door'
  | 'mangrove_fence'
  | 'mangrove_fence_gate'
  | 'mangrove_hanging_sign'
  | 'mangrove_leaves'
  | 'mangrove_log'
  | 'mangrove_planks'
  | 'mangrove_pressure_plate'
  | 'mangrove_propagule'
  | 'mangrove_roots'
  | 'mangrove_sign'
  | 'mangrove_slab'
  | 'mangrove_stairs'
  | 'mangrove_trapdoor'
  | 'mangrove_wall_hanging_sign'
  | 'mangrove_wall_sign'
  | 'mangrove_wood'
  | 'medium_amethyst_bud'
  | 'melon'
  | 'melon_stem'
  | 'moss_block'
  | 'moss_carpet'
  | 'mossy_cobblestone'
  | 'mossy_cobblestone_slab'
  | 'mossy_cobblestone_stairs'
  | 'mossy_cobblestone_wall'
  | 'mossy_stone_brick_slab'
  | 'mossy_stone_brick_stairs'
  | 'mossy_stone_brick_wall'
  | 'mossy_stone_bricks'
  | 'moving_piston'
  | 'mud'
  | 'mud_brick_slab'
  | 'mud_brick_stairs'
  | 'mud_brick_wall'
  | 'mud_bricks'
  | 'muddy_mangrove_roots'
  | 'mushroom_stem'
  | 'mycelium'
  | 'nether_brick_fence'
  | 'nether_brick_slab'
  | 'nether_brick_stairs'
  | 'nether_brick_wall'
  | 'nether_bricks'
  | 'nether_gold_ore'
  | 'nether_portal'
  | 'nether_quartz_ore'
  | 'nether_sprouts'
  | 'nether_wart'
  | 'nether_wart_block'
  | 'netherite_block'
  | 'netherrack'
  | 'note_block'
  | 'oak_button'
  | 'oak_door'
  | 'oak_fence'
  | 'oak_fence_gate'
  | 'oak_hanging_sign'
  | 'oak_leaves'
  | 'oak_log'
  | 'oak_planks'
  | 'oak_pressure_plate'
  | 'oak_sapling'
  | 'oak_sign'
  | 'oak_slab'
  | 'oak_stairs'
  | 'oak_trapdoor'
  | 'oak_wall_hanging_sign'
  | 'oak_wall_sign'
  | 'oak_wood'
  | 'observer'
  | 'obsidian'
  | 'ochre_froglight'
  | 'orange_banner'
  | 'orange_bed'
  | 'orange_candle'
  | 'orange_candle_cake'
  | 'orange_carpet'
  | 'orange_concrete'
  | 'orange_concrete_powder'
  | 'orange_glazed_terracotta'
  | 'orange_shulker_box'
  | 'orange_stained_glass'
  | 'orange_stained_glass_pane'
  | 'orange_terracotta'
  | 'orange_tulip'
  | 'orange_wall_banner'
  | 'orange_wool'
  | 'oxeye_daisy'
  | 'oxidized_copper'
  | 'oxidized_cut_copper'
  | 'oxidized_cut_copper_slab'
  | 'oxidized_cut_copper_stairs'
  | 'packed_ice'
  | 'packed_mud'
  | 'pearlescent_froglight'
  | 'peony'
  | 'petrified_oak_slab'
  | 'piglin_head'
  | 'piglin_wall_head'
  | 'pink_banner'
  | 'pink_bed'
  | 'pink_candle'
  | 'pink_candle_cake'
  | 'pink_carpet'
  | 'pink_concrete'
  | 'pink_concrete_powder'
  | 'pink_glazed_terracotta'
  | 'pink_petals'
  | 'pink_shulker_box'
  | 'pink_stained_glass'
  | 'pink_stained_glass_pane'
  | 'pink_terracotta'
  | 'pink_tulip'
  | 'pink_wall_banner'
  | 'pink_wool'
  | 'piston'
  | 'piston_head'
  | 'pitcher_crop'
  | 'pitcher_plant'
  | 'player_head'
  | 'player_wall_head'
  | 'podzol'
  | 'pointed_dripstone'
  | 'polished_andesite'
  | 'polished_andesite_slab'
  | 'polished_andesite_stairs'
  | 'polished_basalt'
  | 'polished_blackstone'
  | 'polished_blackstone_brick_slab'
  | 'polished_blackstone_brick_stairs'
  | 'polished_blackstone_brick_wall'
  | 'polished_blackstone_bricks'
  | 'polished_blackstone_button'
  | 'polished_blackstone_pressure_plate'
  | 'polished_blackstone_slab'
  | 'polished_blackstone_stairs'
  | 'polished_blackstone_wall'
  | 'polished_deepslate'
  | 'polished_deepslate_slab'
  | 'polished_deepslate_stairs'
  | 'polished_deepslate_wall'
  | 'polished_diorite'
  | 'polished_diorite_slab'
  | 'polished_diorite_stairs'
  | 'polished_granite'
  | 'polished_granite_slab'
  | 'polished_granite_stairs'
  | 'poppy'
  | 'potatoes'
  | 'potted_acacia_sapling'
  | 'potted_allium'
  | 'potted_azalea_bush'
  | 'potted_azure_bluet'
  | 'potted_bamboo'
  | 'potted_birch_sapling'
  | 'potted_blue_orchid'
  | 'potted_brown_mushroom'
  | 'potted_cactus'
  | 'potted_cherry_sapling'
  | 'potted_cornflower'
  | 'potted_crimson_fungus'
  | 'potted_crimson_roots'
  | 'potted_dandelion'
  | 'potted_dark_oak_sapling'
  | 'potted_dead_bush'
  | 'potted_fern'
  | 'potted_flowering_azalea_bush'
  | 'potted_jungle_sapling'
  | 'potted_lily_of_the_valley'
  | 'potted_mangrove_propagule'
  | 'potted_oak_sapling'
  | 'potted_orange_tulip'
  | 'potted_oxeye_daisy'
  | 'potted_pink_tulip'
  | 'potted_poppy'
  | 'potted_red_mushroom'
  | 'potted_red_tulip'
  | 'potted_spruce_sapling'
  | 'potted_torchflower'
  | 'potted_warped_fungus'
  | 'potted_warped_roots'
  | 'potted_white_tulip'
  | 'potted_wither_rose'
  | 'powder_snow'
  | 'powder_snow_cauldron'
  | 'powered_rail'
  | 'prismarine'
  | 'prismarine_brick_slab'
  | 'prismarine_brick_stairs'
  | 'prismarine_bricks'
  | 'prismarine_slab'
  | 'prismarine_stairs'
  | 'prismarine_wall'
  | 'pumpkin'
  | 'pumpkin_stem'
  | 'purple_banner'
  | 'purple_bed'
  | 'purple_candle'
  | 'purple_candle_cake'
  | 'purple_carpet'
  | 'purple_concrete'
  | 'purple_concrete_powder'
  | 'purple_glazed_terracotta'
  | 'purple_shulker_box'
  | 'purple_stained_glass'
  | 'purple_stained_glass_pane'
  | 'purple_terracotta'
  | 'purple_wall_banner'
  | 'purple_wool'
  | 'purpur_block'
  | 'purpur_pillar'
  | 'purpur_slab'
  | 'purpur_stairs'
  | 'quartz_block'
  | 'quartz_bricks'
  | 'quartz_pillar'
  | 'quartz_slab'
  | 'quartz_stairs'
  | 'rail'
  | 'raw_copper_block'
  | 'raw_gold_block'
  | 'raw_iron_block'
  | 'red_banner'
  | 'red_bed'
  | 'red_candle'
  | 'red_candle_cake'
  | 'red_carpet'
  | 'red_concrete'
  | 'red_concrete_powder'
  | 'red_glazed_terracotta'
  | 'red_mushroom'
  | 'red_mushroom_block'
  | 'red_nether_brick_slab'
  | 'red_nether_brick_stairs'
  | 'red_nether_brick_wall'
  | 'red_nether_bricks'
  | 'red_sand'
  | 'red_sandstone'
  | 'red_sandstone_slab'
  | 'red_sandstone_stairs'
  | 'red_sandstone_wall'
  | 'red_shulker_box'
  | 'red_stained_glass'
  | 'red_stained_glass_pane'
  | 'red_terracotta'
  | 'red_tulip'
  | 'red_wall_banner'
  | 'red_wool'
  | 'redstone_block'
  | 'redstone_lamp'
  | 'redstone_ore'
  | 'redstone_torch'
  | 'redstone_wall_torch'
  | 'redstone_wire'
  | 'reinforced_deepslate'
  | 'repeater'
  | 'repeating_command_block'
  | 'respawn_anchor'
  | 'rooted_dirt'
  | 'rose_bush'
  | 'sand'
  | 'sandstone'
  | 'sandstone_slab'
  | 'sandstone_stairs'
  | 'sandstone_wall'
  | 'scaffolding'
  | 'sculk'
  | 'sculk_catalyst'
  | 'sculk_sensor'
  | 'sculk_shrieker'
  | 'sculk_vein'
  | 'sea_lantern'
  | 'sea_pickle'
  | 'seagrass'
  | 'shroomlight'
  | 'shulker_box'
  | 'skeleton_skull'
  | 'skeleton_wall_skull'
  | 'slime_block'
  | 'small_amethyst_bud'
  | 'small_dripleaf'
  | 'smithing_table'
  | 'smoker'
  | 'smooth_basalt'
  | 'smooth_quartz'
  | 'smooth_quartz_slab'
  | 'smooth_quartz_stairs'
  | 'smooth_red_sandstone'
  | 'smooth_red_sandstone_slab'
  | 'smooth_red_sandstone_stairs'
  | 'smooth_sandstone'
  | 'smooth_sandstone_slab'
  | 'smooth_sandstone_stairs'
  | 'smooth_stone'
  | 'smooth_stone_slab'
  | 'sniffer_egg'
  | 'snow'
  | 'snow_block'
  | 'soul_campfire'
  | 'soul_fire'
  | 'soul_lantern'
  | 'soul_sand'
  | 'soul_soil'
  | 'soul_torch'
  | 'soul_wall_torch'
  | 'spawner'
  | 'sponge'
  | 'spore_blossom'
  | 'spruce_button'
  | 'spruce_door'
  | 'spruce_fence'
  | 'spruce_fence_gate'
  | 'spruce_hanging_sign'
  | 'spruce_leaves'
  | 'spruce_log'
  | 'spruce_planks'
  | 'spruce_pressure_plate'
  | 'spruce_sapling'
  | 'spruce_sign'
  | 'spruce_slab'
  | 'spruce_stairs'
  | 'spruce_trapdoor'
  | 'spruce_wall_hanging_sign'
  | 'spruce_wall_sign'
  | 'spruce_wood'
  | 'sticky_piston'
  | 'stone'
  | 'stone_brick_slab'
  | 'stone_brick_stairs'
  | 'stone_brick_wall'
  | 'stone_bricks'
  | 'stone_button'
  | 'stone_pressure_plate'
  | 'stone_slab'
  | 'stone_stairs'
  | 'stonecutter'
  | 'stripped_acacia_log'
  | 'stripped_acacia_wood'
  | 'stripped_bamboo_block'
  | 'stripped_birch_log'
  | 'stripped_birch_wood'
  | 'stripped_cherry_log'
  | 'stripped_cherry_wood'
  | 'stripped_crimson_hyphae'
  | 'stripped_crimson_stem'
  | 'stripped_dark_oak_log'
  | 'stripped_dark_oak_wood'
  | 'stripped_jungle_log'
  | 'stripped_jungle_wood'
  | 'stripped_mangrove_log'
  | 'stripped_mangrove_wood'
  | 'stripped_oak_log'
  | 'stripped_oak_wood'
  | 'stripped_spruce_log'
  | 'stripped_spruce_wood'
  | 'stripped_warped_hyphae'
  | 'stripped_warped_stem'
  | 'structure_block'
  | 'structure_void'
  | 'sugar_cane'
  | 'sunflower'
  | 'suspicious_gravel'
  | 'suspicious_sand'
  | 'sweet_berry_bush'
  | 'tall_grass'
  | 'tall_seagrass'
  | 'target'
  | 'terracotta'
  | 'tinted_glass'
  | 'tnt'
  | 'torch'
  | 'torchflower'
  | 'torchflower_crop'
  | 'trapped_chest'
  | 'tripwire'
  | 'tripwire_hook'
  | 'tube_coral'
  | 'tube_coral_block'
  | 'tube_coral_fan'
  | 'tube_coral_wall_fan'
  | 'tuff'
  | 'turtle_egg'
  | 'twisting_vines'
  | 'twisting_vines_plant'
  | 'verdant_froglight'
  | 'vine'
  | 'void_air'
  | 'wall_torch'
  | 'warped_button'
  | 'warped_door'
  | 'warped_fence'
  | 'warped_fence_gate'
  | 'warped_fungus'
  | 'warped_hanging_sign'
  | 'warped_hyphae'
  | 'warped_nylium'
  | 'warped_planks'
  | 'warped_pressure_plate'
  | 'warped_roots'
  | 'warped_sign'
  | 'warped_slab'
  | 'warped_stairs'
  | 'warped_stem'
  | 'warped_trapdoor'
  | 'warped_wall_hanging_sign'
  | 'warped_wall_sign'
  | 'warped_wart_block'
  | 'water'
  | 'water_cauldron'
  | 'waxed_copper_block'
  | 'waxed_cut_copper'
  | 'waxed_cut_copper_slab'
  | 'waxed_cut_copper_stairs'
  | 'waxed_exposed_copper'
  | 'waxed_exposed_cut_copper'
  | 'waxed_exposed_cut_copper_slab'
  | 'waxed_exposed_cut_copper_stairs'
  | 'waxed_oxidized_copper'
  | 'waxed_oxidized_cut_copper'
  | 'waxed_oxidized_cut_copper_slab'
  | 'waxed_oxidized_cut_copper_stairs'
  | 'waxed_weathered_copper'
  | 'waxed_weathered_cut_copper'
  | 'waxed_weathered_cut_copper_slab'
  | 'waxed_weathered_cut_copper_stairs'
  | 'weathered_copper'
  | 'weathered_cut_copper'
  | 'weathered_cut_copper_slab'
  | 'weathered_cut_copper_stairs'
  | 'weeping_vines'
  | 'weeping_vines_plant'
  | 'wet_sponge'
  | 'wheat'
  | 'white_banner'
  | 'white_bed'
  | 'white_candle'
  | 'white_candle_cake'
  | 'white_carpet'
  | 'white_concrete'
  | 'white_concrete_powder'
  | 'white_glazed_terracotta'
  | 'white_shulker_box'
  | 'white_stained_glass'
  | 'white_stained_glass_pane'
  | 'white_terracotta'
  | 'white_tulip'
  | 'white_wall_banner'
  | 'white_wool'
  | 'wither_rose'
  | 'wither_skeleton_skull'
  | 'wither_skeleton_wall_skull'
  | 'yellow_banner'
  | 'yellow_bed'
  | 'yellow_candle'
  | 'yellow_candle_cake'
  | 'yellow_carpet'
  | 'yellow_concrete'
  | 'yellow_concrete_powder'
  | 'yellow_glazed_terracotta'
  | 'yellow_shulker_box'
  | 'yellow_stained_glass'
  | 'yellow_stained_glass_pane'
  | 'yellow_terracotta'
  | 'yellow_wall_banner'
  | 'yellow_wool'
  | 'zombie_head'
  | 'zombie_wall_head';
type Material = BlockName | `${string}[${string}]`;
type StairBlockName =
  | 'acacia_stairs'
  | 'andesite_stairs'
  | 'bamboo_mosaic_stairs'
  | 'bamboo_stairs'
  | 'birch_stairs'
  | 'blackstone_stairs'
  | 'brick_stairs'
  | 'cherry_stairs'
  | 'cobbled_deepslate_stairs'
  | 'cobblestone_stairs'
  | 'crimson_stairs'
  | 'cut_copper_stairs'
  | 'dark_oak_stairs'
  | 'dark_prismarine_stairs'
  | 'deepslate_brick_stairs'
  | 'deepslate_tile_stairs'
  | 'diorite_stairs'
  | 'end_stone_brick_stairs'
  | 'exposed_cut_copper_stairs'
  | 'granite_stairs'
  | 'jungle_stairs'
  | 'mangrove_stairs'
  | 'mossy_cobblestone_stairs'
  | 'mossy_stone_brick_stairs'
  | 'mud_brick_stairs'
  | 'nether_brick_stairs'
  | 'oak_stairs'
  | 'oxidized_cut_copper_stairs'
  | 'polished_andesite_stairs'
  | 'polished_blackstone_brick_stairs'
  | 'polished_blackstone_stairs'
  | 'polished_deepslate_stairs'
  | 'polished_diorite_stairs'
  | 'polished_granite_stairs'
  | 'prismarine_brick_stairs'
  | 'prismarine_stairs'
  | 'purpur_stairs'
  | 'quartz_stairs'
  | 'red_nether_brick_stairs'
  | 'red_sandstone_stairs'
  | 'sandstone_stairs'
  | 'smooth_quartz_stairs'
  | 'smooth_red_sandstone_stairs'
  | 'smooth_sandstone_stairs'
  | 'spruce_stairs'
  | 'stone_brick_stairs'
  | 'stone_stairs'
  | 'warped_stairs'
  | 'waxed_cut_copper_stairs'
  | 'waxed_exposed_cut_copper_stairs'
  | 'waxed_oxidized_cut_copper_stairs'
  | 'waxed_weathered_cut_copper_stairs'
  | 'weathered_cut_copper_stairs';
type StairMaterial = StairBlockName | `${string}_stairs[${string}]`;
type Point = readonly [number, number, number];
type Side = 'north' | 'south' | 'east' | 'west';
declare const brand: unique symbol;
interface Footprint {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly [brand]: 'footprint';
}
interface Surface {
  readonly footprint: Footprint;
  readonly y: number;
  readonly [brand]: 'surface';
}
interface Bounds {
  readonly min: Point;
  readonly max: Point;
}
interface Opening {
  readonly bounds: Bounds;
  readonly side: Side;
  readonly [brand]: 'opening';
}
interface Facade {
  readonly footprint: Footprint;
  readonly y: number;
  readonly side: Side;
  readonly height: number;
  readonly thickness: number;
  opening(i: number): Opening;
  readonly [brand]: 'facade';
}
interface plinthOptions {
  /** 承托轮廓（外墙或柱落在其上），不含外挑；手写用 rect 或 { points } */ readonly footprint?:
    Footprint | { readonly points: readonly (readonly [number, number])[] };
  /** 反推：台基顶面贴在该表面下方；与 footprint / y 互斥 */ readonly under?: Surface | { readonly top: Surface };
  readonly y?: number;
  readonly height: number;
  /** 向四边外挑的格数 */ readonly project?: number;
  readonly material: Material;
}
type wallsOptions =
  | {
      /** 墙底落在该表面上 */ readonly on: Surface | { readonly top: Surface };
      /** 墙厚，向内长；footprint 是外轮廓 */ readonly thickness?: number;
      readonly material: Material;
      readonly outline?: 'rect' | 'apse';
      /** 从墙底 0 起算的闭区间换材质，区间互不重叠 */ readonly bands?: readonly {
        readonly from: number;
        readonly to: number;
        readonly material: Material;
      }[];
      readonly height: number;
      readonly footprint?: never;
      readonly y?: never;
    }
  | {
      /** 墙底落在该表面上 */ readonly on: Surface | { readonly top: Surface };
      /** 墙厚，向内长；footprint 是外轮廓 */ readonly thickness?: number;
      readonly material: Material;
      readonly outline?: 'rect' | 'apse';
      /** 从墙底 0 起算的闭区间换材质，区间互不重叠 */ readonly bands?: readonly {
        readonly from: number;
        readonly to: number;
        readonly material: Material;
      }[];
      /** 楼层：层数 × 层高（层高 ≥ 4，为一格楼板与通行净空留空间） */ readonly storeys: {
        readonly count: number;
        readonly height: number;
      };
      readonly footprint?: never;
      readonly y?: never;
    }
  | {
      readonly footprint: Footprint;
      readonly y: number;
      /** 墙厚，向内长；footprint 是外轮廓 */ readonly thickness?: number;
      readonly material: Material;
      readonly outline?: 'rect' | 'apse';
      /** 从墙底 0 起算的闭区间换材质，区间互不重叠 */ readonly bands?: readonly {
        readonly from: number;
        readonly to: number;
        readonly material: Material;
      }[];
      readonly height: number;
      readonly on?: never;
    }
  | {
      readonly footprint: Footprint;
      readonly y: number;
      /** 墙厚，向内长；footprint 是外轮廓 */ readonly thickness?: number;
      readonly material: Material;
      readonly outline?: 'rect' | 'apse';
      /** 从墙底 0 起算的闭区间换材质，区间互不重叠 */ readonly bands?: readonly {
        readonly from: number;
        readonly to: number;
        readonly material: Material;
      }[];
      /** 楼层：层数 × 层高（层高 ≥ 4，为一格楼板与通行净空留空间） */ readonly storeys: {
        readonly count: number;
        readonly height: number;
      };
      readonly on?: never;
    };
interface openingOptions {
  readonly in: Facade;
  readonly kind: 'door' | 'window' | 'gate';
  readonly shape?: 'rect' | 'arch' | 'pointed' | 'round';
  /** 洞的净宽，不含框 */ readonly width: number;
  /** 洞的净高，不含框 */ readonly height: number;
  /** 洞底距站立面的格数：普通外墙从墙底算；repeat.storeys 时从该层楼板顶面（楼板厚 1）算 */ readonly sill?: number;
  /** 需 storeys；与 repeat.storeys 互斥 */ readonly storey?: number;
  /** 洞中心相对立面中点的偏移：南北立面 +x、东西立面 +z 为正 */ readonly at?: number;
  /** 洞内填充（玻璃、门等）；填了就不能接踏步 */ readonly fill?: Material;
  readonly repeat?: { readonly every: number } | { readonly storeys: readonly number[] };
  /** 洞顶外挑的雨棚：depth 为向外伸出的格数，只覆盖本洞宽度 */ readonly canopy?: {
    readonly depth: number;
    readonly material: Material;
  };
  /** 外侧一圈框：默认宽 1，会凸出墙外 1 格 */ readonly frame?: {
    readonly width?: number;
    readonly material: Material;
  };
  /** 只用于矩形窗；width = k·every + 1 */ readonly mullion?: { readonly every?: number; readonly material: Material };
}
type floorPlateOptions =
  | {
      readonly in: Surface;
      readonly thickness?: number;
      readonly material: Material;
      readonly footprint?: never;
      readonly y?: never;
    }
  | {
      readonly footprint: Footprint;
      readonly y: number;
      readonly thickness?: number;
      readonly material: Material;
      readonly in?: never;
    };
type stairOptions =
  | {
      /** 下站立面（起点） */ readonly from: Surface | { readonly top: Surface };
      /** 上站立面（终点）；去屋顶用平屋面的 roof.top */ readonly to: Surface | { readonly top: Surface };
      /** 首级格，也是该跑中线 */ readonly at: readonly [number, number];
      /** 上楼方向，入口在首级反方向一格；switchback 第二跑在南北朝向的 +x 侧、东西朝向的 +z 侧 */ readonly facing?:
        'north' | 'south' | 'east' | 'west';
      readonly material: StairMaterial;
      readonly kind: 'straight';
      readonly width?: number;
    }
  | {
      /** 下站立面（起点） */ readonly from: Surface | { readonly top: Surface };
      /** 上站立面（终点）；去屋顶用平屋面的 roof.top */ readonly to: Surface | { readonly top: Surface };
      /** 首级格，也是该跑中线 */ readonly at: readonly [number, number];
      /** 上楼方向，入口在首级反方向一格；switchback 第二跑在南北朝向的 +x 侧、东西朝向的 +z 侧 */ readonly facing?:
        'north' | 'south' | 'east' | 'west';
      readonly material: StairMaterial;
      readonly kind: 'switchback';
      readonly width?: number;
    }
  | {
      /** 下站立面（起点） */ readonly from: Surface | { readonly top: Surface };
      /** 上站立面（终点）；去屋顶用平屋面的 roof.top */ readonly to: Surface | { readonly top: Surface };
      /** 首级格，也是该跑中线 */ readonly at: readonly [number, number];
      /** 上楼方向，入口在首级反方向一格；switchback 第二跑在南北朝向的 +x 侧、东西朝向的 +z 侧 */ readonly facing?:
        'north' | 'south' | 'east' | 'west';
      readonly material: StairMaterial;
      readonly kind: 'spiral';
      /** 方形螺旋半径，at 为中心 */ readonly radius: number;
    };
type stepsOptions = Omit<
  {
    /** 未填充的门洞或院门，或 plinth.edge(side) */ readonly to: Opening;
    readonly width: number;
    readonly material: StairMaterial;
  },
  'to'
> & { readonly to: Opening | Facade };
type roofOptions =
  | {
      /** 外墙或柱廊，从其顶面起坡 */ readonly on?: Surface | { readonly top: Surface };
      readonly footprint?: Footprint;
      readonly y?: number;
      readonly kind: 'gable' | 'hip' | 'pyramid' | 'shed' | 'flat';
      /** 屋脊方向；shed 高侧在 ridge x 的 +z 侧、ridge z 的 +x 侧 */ readonly ridge?: 'x' | 'z';
      /** 单坡高侧所在边；与 ridge 二选一 */ readonly high?: 'north' | 'south' | 'east' | 'west';
      readonly pitch?: never;
      readonly peakY?: never;
      /** 出檐圈数，檐口保持承托面高度 */ readonly overhang?: number;
      readonly thickness?: number;
      /** 仅平屋面；会返回可站立的 top */ readonly parapet?: { readonly height: number; readonly material: Material };
      readonly finial?: { readonly height: number; readonly material: Material };
      readonly gableMaterial?: string | false;
      readonly material: Material;
    }
  | {
      /** 外墙或柱廊，从其顶面起坡 */ readonly on?: Surface | { readonly top: Surface };
      readonly footprint?: Footprint;
      readonly y?: number;
      readonly kind: 'gable' | 'hip' | 'pyramid' | 'shed' | 'flat';
      /** 屋脊方向；shed 高侧在 ridge x 的 +z 侧、ridge z 的 +x 侧 */ readonly ridge?: 'x' | 'z';
      /** 单坡高侧所在边；与 ridge 二选一 */ readonly high?: 'north' | 'south' | 'east' | 'west';
      /** 每内缩一格升高 pitch 格；与 peakY 二选一 */ readonly pitch?: number;
      readonly peakY?: never;
      /** 出檐圈数，檐口保持承托面高度 */ readonly overhang?: number;
      readonly thickness?: number;
      /** 仅平屋面；会返回可站立的 top */ readonly parapet?: { readonly height: number; readonly material: Material };
      readonly finial?: { readonly height: number; readonly material: Material };
      readonly gableMaterial?: string | false;
      readonly material: Material;
    }
  | {
      /** 外墙或柱廊，从其顶面起坡 */ readonly on?: Surface | { readonly top: Surface };
      readonly footprint?: Footprint;
      readonly y?: number;
      readonly kind: 'gable' | 'hip' | 'pyramid' | 'shed' | 'flat';
      /** 屋脊方向；shed 高侧在 ridge x 的 +z 侧、ridge z 的 +x 侧 */ readonly ridge?: 'x' | 'z';
      /** 单坡高侧所在边；与 ridge 二选一 */ readonly high?: 'north' | 'south' | 'east' | 'west';
      readonly pitch?: never;
      /** 直接给尖顶 y；与 pitch 二选一 */ readonly peakY?: number;
      /** 出檐圈数，檐口保持承托面高度 */ readonly overhang?: number;
      readonly thickness?: number;
      /** 仅平屋面；会返回可站立的 top */ readonly parapet?: { readonly height: number; readonly material: Material };
      readonly finial?: { readonly height: number; readonly material: Material };
      readonly gableMaterial?: string | false;
      readonly material: Material;
    };
interface colonnadeOptions {
  /** 外墙或台基，从其顶面起柱 */ readonly on?: Surface | { readonly top: Surface };
  readonly footprint?: Footprint;
  readonly y?: number;
  readonly spacing?: number;
  readonly count?: number;
  readonly height: number;
  readonly column: {
    readonly width?: number;
    readonly material: Material;
    /** cross：方芯四面各加一格；柱芯间距至少 w+3 */ readonly shape?: 'square' | 'cross';
  };
  readonly beam?: false | { readonly height?: number; readonly material: Material };
}
interface railOptions {
  readonly along: Surface | { readonly top: Surface };
  readonly height?: number;
  readonly material: Material;
  readonly gaps?: readonly {
    readonly side: 'north' | 'south' | 'east' | 'west';
    readonly at?: number;
    readonly width: number;
  }[];
}
interface enclosureOptions {
  readonly outline: Footprint;
  readonly y?: number;
  readonly height: number;
  readonly thickness?: number;
  readonly material: Material;
  readonly gate: {
    readonly side: 'north' | 'south' | 'east' | 'west';
    readonly at?: number;
    readonly width: number;
    readonly height: number;
    readonly gatehouse?: {
      readonly depth: number;
      readonly width: number;
      readonly height: number;
      readonly material: Material;
      /** 伸出院墙外，上限 depth − thickness */ readonly outward?: number;
    };
  };
}
type pavingOptions =
  | {
      readonly from: Opening;
      readonly to: number | Opening;
      readonly width: number;
      readonly material: Material;
      readonly region?: never;
    }
  | {
      /** 整片铺满矩形（y=1） */ readonly region: Footprint;
      readonly material: Material;
      readonly from?: never;
      readonly to?: never;
      readonly width?: never;
    };
interface massingImportOptions {
  /** 草模原点（文档 y=0 平面）落在的世界格；默认 [0, 1, 0] */ readonly at?: readonly [number, number, number];
  /** 绕 y 逆时针旋转的角度；只接受 0 / 90 / 180 / 270 */ readonly rotate?: 0 | 90 | 180 | 270;
  /** 整次导入的体素模式；缺省按部件 role（roof 为 shell，其余 solid） */ readonly mode?: 'shell' | 'solid';
  /** 壳模式厚度 1–4（默认 1）；对 solid 部件传会报错 */ readonly thickness?: number;
  /** 整次统一的方块材质；优先于部件自带 material */ readonly material?: Material;
  /** 按部件 id 覆盖材质；优先于 material，键必须是文档里的部件 id */ readonly materials?: Record<string, string>;
  /** 孤立格清理；默认 isolated */ readonly cleanup?: 'isolated' | 'none';
}
type surfaceShellOptions =
  | {
      readonly kind: 'surface';
      /** 参数曲面 (u: number, v: number) => readonly [x, y, z]；u、v ∈ [0, 1] */ readonly position: (
        u: number,
        v: number,
      ) => readonly [number, number, number];
      /** u 方向采样段数（4–128） */ readonly uSegments?: number;
      /** v 方向采样段数（4–128） */ readonly vSegments?: number;
      /** true 时 u 方向首尾无缝（不复制缝合列） */ readonly closedU?: boolean;
      /** 局部原点（公式 y=0 平面）落在的世界格；默认 [0, 1, 0]（贴地表） */ readonly at?: readonly [
        number,
        number,
        number,
      ];
      /** 绕 y 逆时针旋转的角度；只接受 0 / 90 / 180 / 270 */ readonly rotate?: 0 | 90 | 180 | 270;
      /** 建模变换（Euler XYZ 弧度、缩放各轴 >0）：体素化前作用于采样网格；与格旋转 rotate 相互独立 */ readonly transform?: {
        readonly translate?: readonly [number, number, number];
        readonly rotate?: readonly [number, number, number];
        readonly scale?: readonly [number, number, number];
      };
      /** 壳厚 1–4 格；solid:true 时不能传 */ readonly thickness?: number;
      /** false＝壳（默认）；true＝表壳＋内部填充，开放壳回退为壳并在句柄标 leaky */ readonly solid?: boolean;
      /** 结构层方块材质（必填）；未知方块与空气报 material-invalid */ readonly material: Material;
      /** 部件名；缺省 surfaceShell */ readonly name?: string;
      /** 孤立格清理；默认 isolated */ readonly cleanup?: 'isolated' | 'none';
    }
  | {
      readonly kind: 'revolve';
      /** 旋转母线 (t: number) => readonly [radius, height]；绕局部 +y，t ∈ [0, 1] */ readonly profile: (
        t: number,
      ) => readonly [number, number];
      /** 母线采样段数（4–128） */ readonly profileSegments?: number;
      /** 环向采样段数（4–128） */ readonly radialSegments?: number;
      /** 局部原点（公式 y=0 平面）落在的世界格；默认 [0, 1, 0]（贴地表） */ readonly at?: readonly [
        number,
        number,
        number,
      ];
      /** 绕 y 逆时针旋转的角度；只接受 0 / 90 / 180 / 270 */ readonly rotate?: 0 | 90 | 180 | 270;
      /** 建模变换（Euler XYZ 弧度、缩放各轴 >0）：体素化前作用于采样网格；与格旋转 rotate 相互独立 */ readonly transform?: {
        readonly translate?: readonly [number, number, number];
        readonly rotate?: readonly [number, number, number];
        readonly scale?: readonly [number, number, number];
      };
      /** 壳厚 1–4 格；solid:true 时不能传 */ readonly thickness?: number;
      /** false＝壳（默认）；true＝表壳＋内部填充，开放壳回退为壳并在句柄标 leaky */ readonly solid?: boolean;
      /** 结构层方块材质（必填）；未知方块与空气报 material-invalid */ readonly material: Material;
      /** 部件名；缺省 surfaceShell */ readonly name?: string;
      /** 孤立格清理；默认 isolated */ readonly cleanup?: 'isolated' | 'none';
    };
interface World {
  set(x: number, y: number, z: number, block: Material, writeLayer?: 'opening' | 'structure' | 'decoration'): void;
  box(from: Point, to: Point, block: Material, writeLayer?: 'opening' | 'structure' | 'decoration'): void;
  get(x: number, y: number, z: number): string;
  part(name: string, fn: () => void): void;
  mirror(options: { readonly axis: 'x' | 'z'; readonly at: number }, fn: () => void): void;
  /** 台基：承托轮廓向四边外挑，顶部可承托外墙。 */
  plinth(options: plinthOptions): { readonly bounds: Bounds; readonly top: Surface; edge(side: Side): Facade };
  /** 外墙：只写墙厚，内部留空；返回立面与墙顶。 */
  walls(options: wallsOptions): {
    readonly bounds: Bounds;
    readonly top: Surface;
    readonly inner: Surface;
    facade(side: Side): Facade;
    storey(i: number): Surface;
  };
  /** 开洞：贯穿墙厚，优先于结构，门框不会堵住通道。 */
  opening(options: openingOptions): Opening;
  /** 楼板：在内部区域或楼层锚点铺板，梯孔由楼梯自动开通。 */
  floorPlate(options: floorPlateOptions): { readonly bounds: Bounds; readonly top: Surface; readonly region: Surface };
  /** 楼梯：连接两个表面，自动设置楼梯朝向并保留踏面与头顶净空。 */
  stair(options: stairOptions): { readonly bounds: Bounds; readonly path: readonly Point[] };
  /** 踏步：从地表走到门洞或台基边，自动设置朝向并接齐入口。 */
  steps(options: stepsOptions): { readonly bounds: Bounds; readonly path: readonly Point[] };
  /** 屋面：默认竖向一格薄壳与一圈檐口，平屋面可承托上方体块。 */
  roof(options: roofOptions): {
    readonly bounds: Bounds;
    readonly top?: Surface;
    readonly peak: Point;
    readonly eaveLine: Surface;
  };
  /** 柱廊：矩形轮廓四角起柱，按间距或总根数布柱，默认带额枋。 */
  colonnade(options: colonnadeOptions): {
    readonly bounds: Bounds;
    readonly top: Surface;
    readonly bays: readonly Surface[];
  };
  /** 栏杆：沿平台外缘一次围合；门洞与梯道的开洞层自动保留通路。 */
  rail(options: railOptions): { readonly bounds: Bounds };
  /** 院墙：围合院落并贯通门洞，可包含整段挖通的门楼。 */
  enclosure(options: enclosureOptions): {
    readonly bounds: Bounds;
    readonly inner: Surface;
    readonly gate: Opening;
    /** 传了 gate.gatehouse 时必有 */ readonly gatehouse?: {
      readonly bounds: Bounds;
      /** 门楼顶面，屋面挂这里 */ readonly top: Surface;
    };
  };
  /** 铺装：从入口向外铺指定长度、连接另一个入口，或整片铺满矩形，铺在 y=1。 */
  paving(options: pavingOptions): { readonly bounds: Bounds };
  /** 草模导入：把 massing 工具返回的文档 id 体素化并入当前建筑；任一格 y<1 整次拒绝。id 来自 massing 工具（先登记再引用，不认识的 id 报 asset-missing）；at 默认 [0, 1, 0]，rotate 只接受 0/90/180/270；材质优先级 materials[部件id] > material > 部件自带 material > 按 role+颜色取默认映射。 */
  massingImport(
    id: string,
    options?: massingImportOptions,
  ): {
    readonly bounds: Bounds | null;
    readonly parts: readonly {
      readonly id: string;
      readonly name: string;
      readonly role: 'volume' | 'roof' | 'floor' | 'connection';
      readonly bounds: Bounds | null;
      readonly cellCount: number;
    }[];
    readonly counts: {
      readonly parts: number;
      readonly cells: number;
      readonly triangles: number;
      readonly shellParts: number;
      readonly solidParts: number;
      readonly emptyParts: number;
      readonly leakyParts: number;
      readonly isolatedCells: number;
      readonly isolatedRemoved: number;
    };
  };
  /** 参数化壳：kind:"surface" 写 position 公式、kind:"revolve" 写 profile 母线；采样后体素化并入建筑，写结构层。at 默认 [0, 1, 0]，rotate 只接受 0/90/180/270，任一格 y<1 或越界整次拒绝；solid:true 填充内部（开放壳回退为壳并在句柄 leaky 标出）；一次调用一个部件，来源 api=surfaceShell。 */
  surfaceShell(options: surfaceShellOptions): {
    readonly bounds: Bounds;
    readonly cellCount: number;
    readonly leaky: boolean;
  };
}
declare function rect(minX: number, minZ: number, maxX: number, maxZ: number): Footprint;
