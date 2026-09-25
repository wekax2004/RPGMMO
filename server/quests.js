// === מערכת קווסטים ===
const QUEST_DB = {
    quest_spider_slayer: {
        id: 'quest_spider_slayer', name: 'Spider Slayer',
        description: 'Spiders are terrorizing the roads. Slay 5 of them.',
        giver: 'n_1', type: 'kill',
        objectives: [{ type: 'kill', target: 'Spider', current: 0, required: 5 }],
        rewards: { xp: 150, gold: 100 },
        completion_text: 'Well done! The roads are safer thanks to you.'
    },
    quest_explore_cave: {
        id: 'quest_explore_cave', name: 'Secrets of the East',
        description: 'Find the ancient ruins far to the East (Near 2048, 2048).',
        giver: 'n_1', type: 'explore',
        objectives: [{ type: 'reach_tile', x: 2048, y: 2048, radius: 128, label: 'Find the Eastern Ruins', done: false }],
        rewards: { xp: 200, gold: 150 },
        completion_text: 'You found the ruins! The Sage might have work for you.'
    },
    quest_herb_gathering: {
        id: 'quest_herb_gathering', name: 'Healing Herbs',
        description: 'Gather Moonflowers and Poison Mushrooms for medicine.',
        giver: 'n_1', type: 'gather',
        objectives: [
            { type: 'gather', item: 'Moonflower', current: 0, required: 5 },
            { type: 'gather', item: 'Poison Mushroom', current: 0, required: 3 }
        ],
        rewards: { xp: 120, gold: 80 },
        completion_text: 'Wonderful! Here, take these potions as thanks.'
    },
    // Forest Scout Quests
    quest_forest_bears: {
        id: 'quest_forest_bears', name: 'Bear Menace',
        description: 'Bears are threatening travelers. Slay 3 Bears in the forest.',
        giver: 'n_forest_scout', type: 'kill',
        objectives: [{ type: 'kill', target: 'Bear', current: 0, required: 3 }],
        rewards: { xp: 200, gold: 150 },
        completion_text: 'The forest paths are safer now. Thank you, brave adventurer!'
    },
    quest_spider_queen: {
        id: 'quest_spider_queen', name: 'The Spider Queen',
        description: 'A massive Spider Queen lurks deep in the forest. Slay her!',
        giver: 'n_forest_scout', type: 'kill',
        requires_quest: 'quest_forest_bears',
        objectives: [{ type: 'kill', target: 'Spider Queen', current: 0, required: 1 }],
        rewards: { xp: 500, gold: 400 },
        completion_text: 'You slew the Spider Queen?! You are a true hero!'
    },
    // Snow Hermit Quests
    quest_yeti_hunt: {
        id: 'quest_yeti_hunt', name: 'Yeti Hunters',
        description: 'The Yetis are blocking the mountain pass. Slay 4 of them.',
        giver: 'n_snow_hermit', type: 'kill',
        objectives: [{ type: 'kill', target: 'Yeti', current: 0, required: 4 }],
        rewards: { xp: 250, gold: 200 },
        completion_text: 'The mountain pass is clear. You have my gratitude.'
    },
    quest_ice_dragon: {
        id: 'quest_ice_dragon', name: 'Dragon of the Peaks',
        description: 'An ancient Ice Dragon dwells in the frozen peaks. Defeat it!',
        giver: 'n_snow_hermit', type: 'kill',
        requires_quest: 'quest_yeti_hunt',
        objectives: [{ type: 'kill', target: 'Ice Dragon', current: 0, required: 1 }],
        rewards: { xp: 800, gold: 600 },
        completion_text: 'The dragon falls! You are a legend among the mountain folk!'
    },
    // Ruins Sage Quests
    quest_skeleton_clearing: {
        id: 'quest_skeleton_clearing', name: 'Undead Purge',
        description: 'Clear 5 Skeletons from the ancient ruins.',
        giver: 'n_ruins_sage', type: 'kill',
        objectives: [{ type: 'kill', target: 'Skeleton', current: 0, required: 5 }],
        rewards: { xp: 200, gold: 150 },
        completion_text: 'The undead thin... but their king still reigns.'
    },
    quest_skeleton_king: {
        id: 'quest_skeleton_king', name: 'The Skeleton King',
        description: 'Defeat the Skeleton King who rules over the ruins!',
        giver: 'n_ruins_sage', type: 'kill',
        requires_quest: 'quest_skeleton_clearing',
        objectives: [{ type: 'kill', target: 'Skeleton King', current: 0, required: 1 }],
        rewards: { xp: 600, gold: 500 },
        completion_text: 'The king of bones has fallen. The ruins can finally rest.'
    },
    quest_bone_collection: {
        id: 'quest_bone_collection', name: 'Bones of the Fallen',
        description: 'Collect 5 Ancient Bones from the ruins.',
        giver: 'n_ruins_sage', type: 'gather',
        objectives: [{ type: 'gather', item: 'Ancient Bone', current: 0, required: 5 }],
        rewards: { xp: 250, gold: 200 },
        completion_text: 'These bones radiate dark energy... The path of the Necromancer opens before you.'
    }
};

const gatheringNodes = new Map();
let nodeCounter = 0;

function spawnGatheringNodes(broadcast) {
    const nodeTypes = [
        { name: 'Moonflower', color: '#ee88ff', symbol: '🌸', count: 30 },
        { name: 'Poison Mushroom', color: '#44cc44', symbol: '🍄', count: 20 },
        { name: 'Ancient Bone', color: '#ccccaa', symbol: '🦴', count: 15 }
    ];

    nodeTypes.forEach(type => {
        for(let i=0; i<type.count; i++) {
            // פיזור על מפה גדולה (2560x2560)
            const rx = Math.floor(Math.random() * 80) * 32;
            const ry = Math.floor(Math.random() * 80) * 32;
            const id = 'node_' + nodeCounter++;
            gatheringNodes.set(id, { 
                id, name: type.name, x: rx, y: ry, 
                color: type.color, symbol: type.symbol,
                respawnTime: 30000, active: true 
            });
        }
    });
}

function initPlayerQuests() { return { active: {}, completed: [] }; }

function getAvailableQuests(playerQuests, npcId) {
    const npc = require('./npcs').npcs.get(npcId);
    if (!npc) return [];
    const available = [];
    (npc.quests_offered || []).forEach(questId => {
        const quest = QUEST_DB[questId];
        if (!quest || playerQuests.completed.includes(questId) || playerQuests.active[questId]) return;
        if (quest.requires_quest && !playerQuests.completed.includes(quest.requires_quest)) return;
        available.push({ id: quest.id, name: quest.name, description: quest.description, rewards: quest.rewards });
    });
    return available;
}

function canAcceptQuest(playerQuests, questId, npcId = null) {
    const quest = Object.prototype.hasOwnProperty.call(QUEST_DB, questId) ? QUEST_DB[questId] : null;
    if (!quest || playerQuests.active[questId] || playerQuests.completed.includes(questId)) return false;
    if (quest.requires_quest && !playerQuests.completed.includes(quest.requires_quest)) return false;
    if (npcId && quest.giver !== npcId) return false;
    return true;
}

function acceptQuest(playerQuests, questId, npcId = null) {
    if (!canAcceptQuest(playerQuests, questId, npcId)) return false;
    const quest = QUEST_DB[questId];
    playerQuests.active[questId] = {
        id: quest.id,
        name: quest.name,
        objectives: quest.objectives.map(obj => ({ ...obj }))
    };
    return true;
}

function onMobKilled(playerQuests, mobName) {
    const updates = [];
    Object.values(playerQuests.active).forEach(quest => {
        quest.objectives.forEach(obj => {
            if (obj.type === 'kill' && obj.target === mobName && obj.current < obj.required) {
                obj.current++;
                updates.push({ questName: quest.name, objective: `${mobName}: ${obj.current}/${obj.required}` });
            }
        });
    });
    return updates;
}

function onItemGathered(playerQuests, itemName) {
    const updates = [];
    Object.values(playerQuests.active).forEach(quest => {
        quest.objectives.forEach(obj => {
            if (obj.type === 'gather' && obj.item === itemName && obj.current < obj.required) {
                obj.current++;
                updates.push({ questName: quest.name, objective: `${itemName}: ${obj.current}/${obj.required}` });
            }
        });
    });
    return updates;
}

function onPlayerMoved(playerQuests, px, py) {
    const updates = [];
    Object.values(playerQuests.active).forEach(quest => {
        quest.objectives.forEach(obj => {
            if (obj.type === 'reach_tile' && !obj.done) {
                const dist = Math.abs(px - obj.x) + Math.abs(py - obj.y);
                if (dist <= (obj.radius || 0)) {
                    obj.done = true;
                    updates.push({ questName: quest.name, objective: `✅ ${obj.label}` });
                }
            }
        });
    });
    return updates;
}

function checkQuestComplete(playerQuests, questId) {
    const q = playerQuests.active[questId];
    if (!q) return false;
    return q.objectives.every(obj => (obj.type === 'reach_tile' ? obj.done : obj.current >= obj.required));
}

function completeQuest(playerQuests, questId, player) {
    const quest = Object.prototype.hasOwnProperty.call(QUEST_DB, questId) ? QUEST_DB[questId] : null;
    if (!quest || !checkQuestComplete(playerQuests, questId)) return null;
    delete playerQuests.active[questId];
    playerQuests.completed.push(questId);
    if (quest.rewards.gold) player.gold += quest.rewards.gold;
    // Add items logic if inventory is implemented
    if (quest.rewards.items) {
        quest.rewards.items.forEach(item => player.inventory.push(item));
    }
    return { name: quest.name, completion_text: quest.completion_text, rewards: quest.rewards, next_quest: quest.next_quest };
}

module.exports = {
    QUEST_DB, gatheringNodes, spawnGatheringNodes, initPlayerQuests,
    getAvailableQuests, canAcceptQuest, acceptQuest, onMobKilled, onItemGathered,
    onPlayerMoved, checkQuestComplete, completeQuest
};
