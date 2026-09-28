'use strict';

/**
 * Player skills: mining, woodcutting, sword, magic.
 *
 * Distinct from the per-subclass `skill` entries in subclasses.js, which
 * describe an active combat ability. These are persistent experience tracks
 * that level from use.
 *
 * XP is awarded server-side only. The client is told the new numbers via a
 * skill_update packet so the HUD can animate the change; a client cannot
 * grant itself XP.
 */

const MAX_SKILL_LEVEL = 100;

// XP required to advance FROM the given level to the next. Grows
// quadratically so early levels arrive quickly and later ones grind.
function xpForLevel(level) {
    const n = Math.max(1, Math.floor(level));
    return Math.floor(50 * Math.pow(n, 1.6));
}

const SKILL_DEFS = {
    mining: { id: 'mining', name: 'Mining', maxLevel: MAX_SKILL_LEVEL },
    woodcutting: { id: 'woodcutting', name: 'Woodcutting', maxLevel: MAX_SKILL_LEVEL },
    sword: { id: 'sword', name: 'Sword', maxLevel: MAX_SKILL_LEVEL },
    magic: { id: 'magic', name: 'Magic', maxLevel: MAX_SKILL_LEVEL }
};

// What a gathered item trains. Anything unlisted trains nothing.
const GATHERING_SKILLS = {
    'Iron Ore': 'mining',
    'Wood': 'woodcutting'
};

// Melee and spell use. Tuned so a normal attack trains a little and a
// spell costs mana so it trains roughly in proportion to that cost.
const COMBAT_XP = {
    meleeHit: 6,
    spellCast: 8,
    bossHit: 14
};

function emptySkill() {
    return { level: 1, xp: 0 };
}

function isKnownSkill(id) {
    return Object.prototype.hasOwnProperty.call(SKILL_DEFS, id);
}

// Rebuilds from the template so a hand-edited save can never inject an
// unknown skill, a negative level, or a non-numeric xp value.
function normalizeSkills(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    Object.keys(SKILL_DEFS).forEach(id => {
        const saved = source[id] && typeof source[id] === 'object' && !Array.isArray(source[id]) ? source[id] : {};
        const level = Number.isSafeInteger(saved.level) && saved.level >= 1
            ? Math.min(saved.level, SKILL_DEFS[id].maxLevel)
            : 1;
        const xp = Number.isSafeInteger(saved.xp) && saved.xp >= 0 ? saved.xp : 0;
        out[id] = { level, xp: Math.min(xp, xpForLevel(level)) };
    });
    return out;
}

// Advances one skill. Returns null when the id is unknown or the award is
// empty, otherwise a descriptor of what changed so the caller can notify.
function grantSkillXp(skills, id, amount) {
    if (!isKnownSkill(id)) return null;
    const state = skills && typeof skills === 'object' ? skills[id] : null;
    if (!state || typeof state !== 'object') return null;

    const gain = Math.floor(Number(amount));
    if (!Number.isFinite(gain) || gain <= 0) return null;

    const def = SKILL_DEFS[id];
    let levelsGained = 0;
    state.xp += gain;
    // A single large award can cross several level boundaries at once.
    while (state.level < def.maxLevel && state.xp >= xpForLevel(state.level)) {
        state.xp -= xpForLevel(state.level);
        state.level += 1;
        levelsGained += 1;
    }
    if (state.level >= def.maxLevel) {
        state.level = def.maxLevel;
        state.xp = 0;
    }

    return {
        skill: id,
        name: def.name,
        level: state.level,
        xp: state.xp,
        xpForNext: state.level >= def.maxLevel ? 0 : xpForLevel(state.level),
        maxLevel: def.maxLevel,
        gained: gain,
        leveled: levelsGained > 0,
        levelsGained
    };
}

function grantGatheringSkill(skills, itemName, xpPerItem) {
    const skillId = GATHERING_SKILLS[itemName];
    if (!skillId) return null;
    return grantSkillXp(skills, skillId, xpPerItem);
}

// Full snapshot for the client HUD, in a stable order.
function skillSummary(skills) {
    return Object.keys(SKILL_DEFS).map(id => {
        const def = SKILL_DEFS[id];
        const state = skills && skills[id] ? skills[id] : emptySkill();
        return {
            skill: id,
            name: def.name,
            level: state.level,
            xp: state.xp,
            xpForNext: state.level >= def.maxLevel ? 0 : xpForLevel(state.level),
            maxLevel: def.maxLevel
        };
    });
}

module.exports = {
    SKILL_DEFS,
    GATHERING_SKILLS,
    COMBAT_XP,
    MAX_SKILL_LEVEL,
    xpForLevel,
    normalizeSkills,
    grantSkillXp,
    grantGatheringSkill,
    skillSummary
};
