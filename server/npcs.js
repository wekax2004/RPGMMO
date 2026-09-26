const npcs = new Map();

// City (Safe Zone) - 0-640, 0-640
npcs.set('n_1', {
    x: 320, y: 320, name: 'Mayor Joe',
    quests_offered: ['quest_spider_slayer', 'quest_explore_cave', 'quest_herb_gathering']
});
npcs.set('n_merchant', { x: 384, y: 320, name: 'Merchant Bob', quests_offered: [] });
npcs.set('n_trainer', { x: 256, y: 384, name: 'Class Trainer Aria', quests_offered: [] });
// King Arthur sits in the starting city and drives the multi-step quest chain.
npcs.set('n_king_arthur', {
    x: 288, y: 448, name: 'King Arthur',
    quests_offered: ['quest_spider_menace', 'quest_arthur_vigil']
});

// Forest - 1600-3200, 0-1600
npcs.set('n_forest_scout', {
    x: 1856, y: 320, name: 'Forest Scout Elara',
    quests_offered: ['quest_forest_bears', 'quest_spider_queen']
});

// Snow Mountain - 1600-3200, 1600-2600
npcs.set('n_snow_hermit', {
    x: 2000, y: 2000, name: 'Hermit Frost',
    quests_offered: ['quest_yeti_hunt', 'quest_ice_dragon']
});

// Eastern Ruins - 1600-3200, 1600-3200
npcs.set('n_ruins_sage', {
    x: 1856, y: 1856, name: 'Sage Mordecai',
    quests_offered: ['quest_skeleton_clearing', 'quest_skeleton_king', 'quest_bone_collection']
});

module.exports = { npcs };
