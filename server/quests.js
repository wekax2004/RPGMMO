const CFG = require('./config');
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
    },

    // === Multi-step quest chain (King Arthur) ===
    // Steps are progressed in order. A 'talk' step is satisfied by the
    // conversation that starts the quest, an 'objective' step tracks
    // counters, and a 'turn_in' step is the final hand-in with the giver.
    quest_spider_menace: {
        id: 'quest_spider_menace',
        name: 'The Spider Menace',
        description: 'Spiders have overrun the roads outside the city. King Arthur asks you to thin their numbers.',
        giver: 'n_king_arthur',
        type: 'kill',
        steps: [
            {
                id: 'briefing', type: 'talk', npc: 'n_king_arthur',
                text: 'Speak with King Arthur to receive your orders.',
                objectives: []
            },
            {
                id: 'slay_spiders', type: 'objective',
                text: 'Slay 5 Spiders',
                objectives: [{ type: 'kill', target: 'Spider', required: 5 }]
            },
            {
                id: 'return', type: 'turn_in', npc: 'n_king_arthur',
                text: 'Return to King Arthur to report your success.',
                objectives: []
            }
        ],
        rewards: { xp: 300, gold: 500, items: ['Holy Staff'] },
        completion_text: 'The roads are clear again. You have my gratitude, and this Holy Staff is yours.'
    },
    // A longer chain: two separate objective steps before the hand-in.
    quest_arthur_vigil: {
        id: 'quest_arthur_vigil',
        name: 'The Long Vigil',
        description: 'The roads need holding. King Arthur wants the undead cleared first, then the beasts that nest beyond them.',
        giver: 'n_king_arthur',
        type: 'kill',
        requires_quest: 'quest_spider_menace',
        steps: [
            {
                id: 'briefing', type: 'talk', npc: 'n_king_arthur',
                text: 'Speak with King Arthur to receive your orders.',
                objectives: []
            },
            {
                id: 'clear_undead', type: 'objective',
                text: 'Destroy 3 Skeletons',
                objectives: [{ type: 'kill', target: 'Skeleton', required: 3 }]
            },
            {
                id: 'slay_beasts', type: 'objective',
                text: 'Slay 2 Minotaurs',
                objectives: [{ type: 'kill', target: 'Minotaur', required: 2 }]
            },
            {
                id: 'return', type: 'turn_in', npc: 'n_king_arthur',
                text: 'Return to King Arthur to report your success.',
                objectives: []
            }
        ],
        rewards: { xp: 600, gold: 800, items: ['Greater Health Potion', 'Greater Mana Potion'] },
        completion_text: 'The vigil is held. Rest well, champion.'
    }
};

const gatheringNodes = new Map();
let nodeCounter = 0;

function spawnGatheringNodes(broadcast, isWalkable) {
    const nodeTypes = [
        { name: 'Moonflower', color: '#ee88ff', symbol: '🌸', count: 30 },
        { name: 'Poison Mushroom', color: '#44cc44', symbol: '🍄', count: 20 },
        { name: 'Ancient Bone', color: '#ccccaa', symbol: '🦴', count: 15 },
        { name: 'Iron Ore', color: '#888888', symbol: '🪨', count: 30 },
        { name: 'Wood', color: '#8B4513', symbol: '🪵', count: 30 },
        { name: 'Leather', color: '#D2691E', symbol: '🐪', count: 20 }
    ];

    nodeTypes.forEach(type => {
        for(let i=0; i<type.count; i++) {
            let rx, ry;
            let attempts = 0;
            do {
                rx = Math.floor(Math.random() * 80) * 32;
                ry = Math.floor(Math.random() * 80) * 32;
                attempts++;
            } while (isWalkable && !isWalkable(rx, ry) && attempts < 100);

            const id = 'node_' + nodeCounter++;
            gatheringNodes.set(id, { 
                // Resources belong to a floor. Node positions are generated
                // per process, so the floor is recorded rather than inferred;
                // the client filters node_sync on it once floors exist.
                id, name: type.name, x: rx, y: ry, z: CFG.Z_SURFACE,
                color: type.color, symbol: type.symbol,
                respawnTime: 30000, active: true 
            });
        }
    });
}

function initPlayerQuests() { return { active: {}, completed: [] }; }

// === Multi-step quest helpers ===
// A quest either uses the legacy single-step shape (`objectives` on the
// template) or an explicit `steps` array. Everything below treats a
// step-less quest as a single implicit objective step so the original
// ten quests keep working untouched.

function hasSteps(quest) { return Array.isArray(quest.steps) && quest.steps.length > 0; }

function getSteps(quest) { return hasSteps(quest) ? quest.steps : null; }

function currentStep(questDef, state) {
    const steps = getSteps(questDef);
    if (!steps) return null;
    const index = Number.isInteger(state && state.stepIndex) ? state.stepIndex : 0;
    return steps[index] || null;
}

function objectiveTemplates(questDef, state) {
    const step = currentStep(questDef, state);
    if (!step) return Array.isArray(questDef.objectives) ? questDef.objectives : [];
    return Array.isArray(step.objectives) ? step.objectives : [];
}

// Builds fresh, well-formed objective state from the template. Persisted
// state is only ever trusted for the counter value, never for the shape.
function buildObjectives(questDef, state, savedObjectives) {
    const saved = Array.isArray(savedObjectives) ? savedObjectives : [];
    return objectiveTemplates(questDef, state).map((template, index) => {
        const prior = saved[index] && typeof saved[index] === 'object' && !Array.isArray(saved[index])
            ? saved[index] : {};
        const objective = { ...template };
        if (template.type === 'reach_tile') {
            objective.done = prior.done === true;
            return objective;
        }
        const required = Number.isSafeInteger(template.required) && template.required >= 0 ? template.required : 0;
        const current = Number.isSafeInteger(prior.current) && prior.current >= 0
            ? Math.min(prior.current, required)
            : 0;
        objective.current = current;
        objective.required = required;
        return objective;
    });
}

function isObjectiveComplete(objective) {
    if (!objective || typeof objective !== 'object') return true;
    if (objective.type === 'reach_tile') return objective.done === true;
    const current = Number.isSafeInteger(objective.current) ? objective.current : 0;
    const required = Number.isSafeInteger(objective.required) ? objective.required : 0;
    return current >= required;
}

function stepObjectivesComplete(questDef, state) {
    const objectives = Array.isArray(state && state.objectives) ? state.objectives : [];
    return objectives.every(isObjectiveComplete);
}

// Advances through any leading steps that the act of talking already
// satisfies. Returns true when the step index moved.
function skipSatisfiedTalkSteps(questDef, state) {
    const steps = getSteps(questDef);
    if (!steps) return false;
    let moved = false;
    let guard = 0;
    while (guard++ < steps.length) {
        const step = steps[state.stepIndex];
        if (!step || step.type !== 'talk') break;
        state.stepIndex += 1;
        state.objectives = buildObjectives(questDef, state, null);
        moved = true;
    }
    return moved;
}

// Moves to the next step when the current one is finished. Returns true when
// the step index moved, so callers can notify the player.
function advanceStepIfComplete(questDef, state) {
    const steps = getSteps(questDef);
    if (!steps) return false;
    const step = steps[state.stepIndex];
    if (!step || step.type === 'talk') return false;
    if (!stepObjectivesComplete(questDef, state)) return false;
    if (state.stepIndex >= steps.length - 1) return false;
    state.stepIndex += 1;
    state.objectives = buildObjectives(questDef, state, null);
    return true;
}

// True when every objective step is done and the quest is waiting on the
// final hand-in, or when the last step is itself an objective step.
function isQuestReadyToComplete(questDef, state) {
    const steps = getSteps(questDef);
    if (!steps) {
        const objectives = Array.isArray(state.objectives) ? state.objectives : [];
        return objectives.length > 0 && objectives.every(isObjectiveComplete);
    }
    const step = steps[state.stepIndex];
    if (!step) return false;
    if (step.type === 'turn_in') return true;
    if (state.stepIndex < steps.length - 1) return false;
    return stepObjectivesComplete(questDef, state);
}

// Human-readable progress for the quest journal.
function describeProgress(questDef, state) {
    const steps = getSteps(questDef);
    if (!steps) return null;
    const step = steps[state.stepIndex];
    return {
        stepIndex: state.stepIndex,
        stepCount: steps.length,
        stepText: step ? step.text : '',
        awaitingTurnIn: step ? step.type === 'turn_in' : false
    };
}

// Rebuilds persisted quest state from the templates. Anything that does not
// match a known quest, or whose objectives are malformed, is discarded
// rather than trusted -- a corrupt save must not be able to crash the tick.
function sanitizePlayerQuests(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const active = {};
    const completed = [];
    if (source.active && typeof source.active === 'object' && !Array.isArray(source.active)) {
        Object.keys(source.active).forEach(questId => {
            if (!Object.prototype.hasOwnProperty.call(QUEST_DB, questId)) return;
            const questDef = QUEST_DB[questId];
            const saved = source.active[questId];
            if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
            const steps = getSteps(questDef);
            const maxIndex = steps ? steps.length - 1 : 0;
            const stepIndex = Number.isInteger(saved.stepIndex)
                ? Math.max(0, Math.min(saved.stepIndex, maxIndex))
                : 0;
            const state = { id: questId, name: questDef.name, stepIndex };
            if (hasSteps(questDef)) skipSatisfiedTalkSteps(questDef, state);
            state.objectives = buildObjectives(questDef, state, saved.objectives);
            active[questId] = state;
        });
    }
    if (Array.isArray(source.completed)) {
        source.completed.forEach(questId => {
            if (typeof questId === 'string' && !completed.includes(questId)) completed.push(questId);
        });
    }
    return { active, completed };
}

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

// Emitted when a step boundary is crossed so the player is told what to do next.
function stepAdvanceUpdate(quest, state) {
    const progress = describeProgress(quest, state);
    if (!progress) return null;
    return {
        questId: state.id,
        questName: state.name,
        objective: progress.awaitingTurnIn
            ? `New objective: ${progress.stepText}`
            : `Step ${progress.stepIndex + 1}/${progress.stepCount} complete - ${progress.stepText}`
    };
}

function acceptQuest(playerQuests, questId, npcId = null) {
    if (!canAcceptQuest(playerQuests, questId, npcId)) return false;
    const quest = QUEST_DB[questId];
    // Legacy single-step quests keep their original persisted shape: no
    // stepIndex, and objectives built straight from the template.
    const state = hasSteps(quest)
        ? { id: quest.id, name: quest.name, stepIndex: 0 }
        : { id: quest.id, name: quest.name };
    state.objectives = buildObjectives(quest, state, null);
    // Accepting the quest *is* the briefing conversation, so any leading
    // 'talk' step counts as satisfied straight away.
    if (hasSteps(quest)) skipSatisfiedTalkSteps(quest, state);
    playerQuests.active[questId] = state;
    return true;
}

function onMobKilled(playerQuests, mobName) {
    const updates = [];
    Object.values(playerQuests.active).forEach(state => {
        const quest = Object.prototype.hasOwnProperty.call(QUEST_DB, state.id) ? QUEST_DB[state.id] : null;
        if (!quest) return;
        (Array.isArray(state.objectives) ? state.objectives : []).forEach(obj => {
            if (obj && obj.type === 'kill' && obj.target === mobName && obj.current < obj.required) {
                obj.current++;
                updates.push({ questId: state.id, questName: state.name, objective: `${mobName}: ${obj.current}/${obj.required}` });
            }
        });
        if (advanceStepIfComplete(quest, state)) {
            const update = stepAdvanceUpdate(quest, state);
            if (update) updates.push(update);
        }
    });
    return updates;
}

function onItemGathered(playerQuests, itemName) {
    const updates = [];
    Object.values(playerQuests.active).forEach(state => {
        const quest = Object.prototype.hasOwnProperty.call(QUEST_DB, state.id) ? QUEST_DB[state.id] : null;
        if (!quest) return;
        (Array.isArray(state.objectives) ? state.objectives : []).forEach(obj => {
            if (obj && obj.type === 'gather' && obj.item === itemName && obj.current < obj.required) {
                obj.current++;
                updates.push({ questId: state.id, questName: state.name, objective: `${itemName}: ${obj.current}/${obj.required}` });
            }
        });
        if (advanceStepIfComplete(quest, state)) {
            const update = stepAdvanceUpdate(quest, state);
            if (update) updates.push(update);
        }
    });
    return updates;
}

function onPlayerMoved(playerQuests, px, py) {
    const updates = [];
    Object.values(playerQuests.active).forEach(state => {
        const quest = Object.prototype.hasOwnProperty.call(QUEST_DB, state.id) ? QUEST_DB[state.id] : null;
        if (!quest) return;
        (Array.isArray(state.objectives) ? state.objectives : []).forEach(obj => {
            if (obj && obj.type === 'reach_tile' && !obj.done) {
                const dist = Math.abs(px - obj.x) + Math.abs(py - obj.y);
                if (dist <= (obj.radius || 0)) {
                    obj.done = true;
                    updates.push({ questId: state.id, questName: state.name, objective: `Reached: ${obj.label}` });
                }
            }
        });
        if (advanceStepIfComplete(quest, state)) {
            const update = stepAdvanceUpdate(quest, state);
            if (update) updates.push(update);
        }
    });
    return updates;
}

function checkQuestComplete(playerQuests, questId) {
    const state = playerQuests.active[questId];
    if (!state) return false;
    const quest = Object.prototype.hasOwnProperty.call(QUEST_DB, questId) ? QUEST_DB[questId] : null;
    if (!quest) return false;
    return isQuestReadyToComplete(quest, state);
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

// === NPC Dialogue Trees ===
// A tree is a map of nodes. Each node has text and a list of choices. A
// choice may carry a `when` predicate and an `action`; both are evaluated
// on the server, so a client cannot reach a node or trigger an action that
// its own state would not allow.

const DIALOGUE_TREES = {
    n_king_arthur: {
        entry: ctx => {
            // Entry point is state dependent: a ready hand-in short-circuits
            // the greeting, otherwise greet and offer whatever is available.
            if (ctx.turnIns.length > 0) return 'turn_in_intro';
            if (ctx.available.length > 0) return 'greet_offer';
            if (ctx.active.length > 0) return 'greet_in_progress';
            return 'greet_idle';
        },
        nodes: {
            greet_offer: {
                text: ctx => {
                    const first = ctx.available[0];
                    const more = ctx.available.length > 1
                        ? ` I have ${ctx.available.length} matters that need a steady hand.`
                        : '';
                    return `"${first.name} it is, then. ${first.description}"${more} What say you?`;
                },
                choices: [
                    {
                        id: 'hear_spider_menace',
                        text: ctx => `"Tell me more about ${ctx.available[0].name}."`,
                        next: 'offer_spider_menace',
                        when: ctx => ctx.available[0] && ctx.available[0].id === 'quest_spider_menace'
                    },
                    {
                        id: 'hear_vigil',
                        text: '"Tell me about the other matter."',
                        next: 'offer_vigil',
                        when: ctx => ctx.available.some(q => q.id === 'quest_arthur_vigil')
                    },
                    {
                        id: 'not_now',
                        text: '"Not right now."',
                        next: 'farewell'
                    }
                ]
            },
            offer_spider_menace: {
                text: '"Spiders have multiplied unchecked. Five of them, and the roads are ours again. I will pay five hundred gold, and this Holy Staff for your trouble. Will you take it?"',
                choices: [
                    {
                        id: 'accept_spider_menace',
                        text: '"I will help you."',
                        action: { type: 'accept_quest', questId: 'quest_spider_menace' },
                        next: 'accepted_spider_menace',
                        when: ctx => ctx.canAccept('quest_spider_menace')
                    },
                    {
                        id: 'decline_spider_menace',
                        text: '"I have too much on my plate."',
                        next: 'greet_offer'
                    }
                ]
            },
            offer_vigil: {
                text: '"The Long Vigil. First the skeletons, then the beasts that nest past them. It is longer work and pays longer. Are you willing?"',
                choices: [
                    {
                        id: 'accept_vigil',
                        text: '"Count me in."',
                        action: { type: 'accept_quest', questId: 'quest_arthur_vigil' },
                        next: 'accepted_vigil',
                        when: ctx => ctx.canAccept('quest_arthur_vigil')
                    },
                    {
                        id: 'decline_vigil',
                        text: '"Another time."',
                        next: 'greet_offer'
                    }
                ]
            },
            accepted_spider_menace: {
                text: 'He presses a warm staff into your hands. "Five spiders. Come back to me when it is done."',
                choices: [{ id: 'farewell_now', text: '"I will return."', next: 'farewell' }]
            },
            accepted_vigil: {
                text: '"Good. The vigil begins at once. I will be here."',
                choices: [{ id: 'farewell_now', text: '"Until then."', next: 'farewell' }]
            },
            greet_in_progress: {
                text: ctx => {
                    const names = ctx.active.map(q => q.name).join(' and ');
                    return `"You still have business with me: ${names}. Do not let it sit too long."`;
                },
                choices: [{ id: 'farewell_now', text: '"Aye."', next: 'farewell' }]
            },
            greet_idle: {
                text: '"The realm is quiet, for now. Come back when it is not."',
                choices: [{ id: 'farewell_now', text: '"Good day, Your Majesty."', next: 'farewell' }]
            },
            turn_in_intro: {
                text: ctx => `"You have done it? Speak, ${ctx.player.charName}."`,
                choices: ctx => ctx.turnIns.map(quest => ({
                    id: `turn_in_${quest.id}`,
                    text: `"Report on ${quest.name}."`,
                    action: { type: 'turn_in', questId: quest.id },
                    next: 'turn_in_done'
                }))
            },
            turn_in_done: {
                text: ctx => {
                    const last = ctx.lastCompletion;
                    return last ? `"${last.text}"` : '"Well done."';
                },
                choices: [{ id: 'farewell_now', text: '"Thank you, Your Majesty."', next: 'farewell' }]
            },
            farewell: {
                text: 'He bows his head. "Go well."',
                choices: []
            }
        }
    }
};

function hasDialogueTree(npcId) {
    return Object.prototype.hasOwnProperty.call(DIALOGUE_TREES, npcId);
}

// Builds the context every predicate and text resolver reads from. The
// client never supplies any of this; it is all derived server-side.
function buildDialogueContext(player, npcId) {
    const quests = player.quests || initPlayerQuests();
    const available = getAvailableQuests(quests, npcId);
    const active = Object.values(quests.active)
        .filter(state => Object.prototype.hasOwnProperty.call(QUEST_DB, state.id))
        .map(state => ({ id: state.id, name: state.name }));
    const turnIns = active.filter(entry => {
        const quest = QUEST_DB[entry.id];
        return quest && quest.giver === npcId && checkQuestComplete(quests, entry.id);
    });
    return {
        player,
        npcId,
        available,
        active,
        turnIns,
        lastCompletion: null,
        canAccept: questId => canAcceptQuest(quests, questId, npcId)
    };
}

function resolveNodeText(node, ctx) {
    return typeof node.text === 'function' ? String(node.text(ctx)) : String(node.text || '');
}

function resolveNodeChoices(node, ctx) {
    const raw = typeof node.choices === 'function' ? node.choices(ctx) : (node.choices || []);
    return raw
        .filter(choice => !choice.when || choice.when(ctx))
        .map(choice => ({ 
            id: choice.id, 
            text: typeof choice.text === 'function' ? String(choice.text(ctx)) : String(choice.text || ''), 
            next: choice.next || null 
        }));
}

// Resolves a node for display. `nodeId` may be omitted to use the tree's
// state-dependent entry point.
function resolveDialogue(npcId, nodeId, ctx) {
    if (!hasDialogueTree(npcId)) return null;
    const tree = DIALOGUE_TREES[npcId];
    let targetId = nodeId;
    if (!targetId) {
        targetId = typeof tree.entry === 'function' ? tree.entry(ctx) : tree.entry;
    }
    if (typeof targetId !== 'string') return null;
    if (!Object.prototype.hasOwnProperty.call(tree.nodes, targetId)) return null;
    const node = tree.nodes[targetId];
    return {
        npc_id: npcId,
        node_id: targetId,
        text: resolveNodeText(node, ctx),
        choices: resolveNodeChoices(node, ctx)
    };
}

// Looks up a choice and re-checks its predicate. A client that forges a
// choice id, or replays one that is no longer legal, gets null back.
function resolveChoice(npcId, nodeId, choiceId, ctx) {
    if (!hasDialogueTree(npcId)) return null;
    const tree = DIALOGUE_TREES[npcId];
    if (!Object.prototype.hasOwnProperty.call(tree.nodes, nodeId)) return null;
    const node = tree.nodes[nodeId];
    const raw = typeof node.choices === 'function' ? node.choices(ctx) : (node.choices || []);
    const choice = raw.find(c => c.id === choiceId);
    if (!choice) return null;
    if (choice.when && !choice.when(ctx)) return null;
    return choice;
}

module.exports = {
    QUEST_DB, DIALOGUE_TREES, gatheringNodes, spawnGatheringNodes, initPlayerQuests,
    getAvailableQuests, canAcceptQuest, acceptQuest, onMobKilled, onItemGathered,
    onPlayerMoved, checkQuestComplete, completeQuest,
    sanitizePlayerQuests, hasSteps, getSteps, currentStep, isQuestReadyToComplete,
    describeProgress, hasDialogueTree, buildDialogueContext, resolveDialogue, resolveChoice
};
