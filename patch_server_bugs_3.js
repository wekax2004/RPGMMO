const fs = require('fs');

// ==== 1. Fix quests.js ====
let questsSrc = fs.readFileSync('server/quests.js', 'utf8');

// H1: isQuestReadyToComplete treats mid-chain talk as complete
questsSrc = questsSrc.replace(
    `    if (step.type === 'turn_in') return true;
    return stepObjectivesComplete(questDef, state);`,
    `    if (step.type === 'turn_in') return true;
    if (state.stepIndex < steps.length - 1) return false;
    return stepObjectivesComplete(questDef, state);`
);

// H2: sanitizePlayerQuests skips talk steps
questsSrc = questsSrc.replace(
    `            const state = { id: questId, name: questDef.name, stepIndex };
            state.objectives = buildObjectives(questDef, state, saved.objectives);`,
    `            const state = { id: questId, name: questDef.name, stepIndex };
            if (hasSteps(questDef)) skipSatisfiedTalkSteps(questDef, state);
            state.objectives = buildObjectives(questDef, state, saved.objectives);`
);

// Crafting materials: add Iron Ore, Wood, Leather
questsSrc = questsSrc.replace(
    `    const nodeTypes = [
        { name: 'Moonflower', color: '#ee88ff', symbol: '🌸', count: 30 },
        { name: 'Poison Mushroom', color: '#44cc44', symbol: '🍄', count: 20 },
        { name: 'Ancient Bone', color: '#ccccaa', symbol: '🦴', count: 15 }
    ];`,
    `    const nodeTypes = [
        { name: 'Moonflower', color: '#ee88ff', symbol: '🌸', count: 30 },
        { name: 'Poison Mushroom', color: '#44cc44', symbol: '🍄', count: 20 },
        { name: 'Ancient Bone', color: '#ccccaa', symbol: '🦴', count: 15 },
        { name: 'Iron Ore', color: '#888888', symbol: '🪨', count: 30 },
        { name: 'Wood', color: '#8B4513', symbol: '🪵', count: 30 },
        { name: 'Leather', color: '#D2691E', symbol: '🐪', count: 20 }
    ];`
);

fs.writeFileSync('server/quests.js', questsSrc);

// ==== 2. Fix server.js ====
let serverSrc = fs.readFileSync('server/server.js', 'utf8');

// H3: Skip grantQuestTurnIns if hasDialogueTree
serverSrc = serverSrc.replace(
    `                // Hand in anything the player has finished with this giver.
                const turnedInNow = grantQuestTurnIns(player, data.npc_id);

                if (Q.hasDialogueTree(data.npc_id)) {`,
    `                // Hand in anything the player has finished with this giver.
                let turnedInNow = [];
                if (!Q.hasDialogueTree(data.npc_id)) {
                    turnedInNow = grantQuestTurnIns(player, data.npc_id);
                }

                if (Q.hasDialogueTree(data.npc_id)) {`
);

// Guilds: Remove GUILDS usage
// We'll just remove the require if it exists, and make GUILDS a dummy object so we don't crash
if (serverSrc.includes("const GUILDS")) {
    serverSrc = serverSrc.replace(/const GUILDS = require\('\.\/guilds'\);/g, "const GUILDS = { getGuild: () => null, createGuild: () => {}, inviteToGuild: () => {}, joinGuild: () => {}, leaveGuild: () => {} };");
} else {
    // If it's not required but referenced, just define it globally at the top
    serverSrc = serverSrc.replace("const PARTY = require('./party');", "const PARTY = require('./party');\nconst GUILDS = { getGuild: () => null, createGuild: () => {}, inviteToGuild: () => {}, joinGuild: () => {}, leaveGuild: () => {} };");
}

fs.writeFileSync('server/server.js', serverSrc);
