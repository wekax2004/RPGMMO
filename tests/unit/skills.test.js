// Unit tests for the skills system and the high-tier crafting content.
process.env.TIBIA_DB_DRIVER = 'sqlite';
process.env.TIBIA_DB_FILE = require('path').join(
    require('os').tmpdir(),
    `tibia_skills_test_${process.pid}.json`
);

const test = require('node:test');
const assert = require('node:assert');
const SKILLS = require('../../server/skills');
const CRAFTING = require('../../server/crafting');
const ITEMS = require('../../server/items');

function leveled() {
    return SKILLS.normalizeSkills({});
}

test('every skill starts at level 1 with zero xp', () => {
    const skills = leveled();
    ['mining', 'woodcutting', 'sword', 'magic'].forEach(id => {
        assert.strictEqual(skills[id].level, 1, id + ' should start at 1');
        assert.strictEqual(skills[id].xp, 0, id + ' should start at 0');
    });
});

test('an award accumulates xp without levelling', () => {
    const skills = leveled();
    const result = SKILLS.grantSkillXp(skills, 'sword', 10);
    assert.strictEqual(result.leveled, false);
    assert.strictEqual(result.level, 1);
    assert.strictEqual(result.xp, 10);
    assert.strictEqual(skills.sword.xp, 10);
});

test('crossing the threshold levels the skill and carries the remainder', () => {
    const skills = leveled();
    const needed = SKILLS.xpForLevel(1);
    const result = SKILLS.grantSkillXp(skills, 'sword', needed + 7);
    assert.strictEqual(result.leveled, true);
    assert.strictEqual(result.level, 2);
    assert.strictEqual(skills.sword.xp, 7, 'surplus xp carries into the new level');
});

test('a large single award can cross several levels at once', () => {
    const skills = leveled();
    const huge = SKILLS.xpForLevel(1) + SKILLS.xpForLevel(2) + SKILLS.xpForLevel(3) + 5;
    const result = SKILLS.grantSkillXp(skills, 'magic', huge);
    assert.strictEqual(result.levelsGained, 3);
    assert.strictEqual(result.level, 4);
});

test('the xp curve increases with level', () => {
    let previous = 0;
    for (let level = 1; level <= 20; level++) {
        const needed = SKILLS.xpForLevel(level);
        assert.ok(needed > previous, `level ${level} should cost more than ${level - 1}`);
        previous = needed;
    }
});

test('an unknown skill id is rejected rather than created', () => {
    const skills = leveled();
    for (const bad of ['woodcut', 'CONSTRUCTOR', '__proto__', 'toString', '']) {
        assert.strictEqual(SKILLS.grantSkillXp(skills, bad, 50), null);
    }
    assert.deepStrictEqual(Object.keys(skills).sort(), ['magic', 'mining', 'sword', 'woodcutting']);
});

test('non-positive or non-numeric awards are ignored', () => {
    const skills = leveled();
    for (const bad of [0, -5, NaN, Infinity, 'lots', null, undefined]) {
        assert.strictEqual(SKILLS.grantSkillXp(skills, 'sword', bad), null);
    }
    assert.strictEqual(skills.sword.xp, 0);
});

test('a skill caps at its max level and stops accruing', () => {
    const skills = leveled();
    skills.sword.level = SKILLS.MAX_SKILL_LEVEL;
    const result = SKILLS.grantSkillXp(skills, 'sword', 999999);
    assert.strictEqual(result.level, SKILLS.MAX_SKILL_LEVEL);
    assert.strictEqual(result.xpForNext, 0, 'a capped skill reports no next target');
    assert.strictEqual(skills.sword.level, SKILLS.MAX_SKILL_LEVEL);
    assert.strictEqual(skills.sword.xp, 0, 'a capped skill does not bank xp');
});

test('normalizeSkills rebuilds a tampered save from the template', () => {
    const clean = SKILLS.normalizeSkills({
        mining: { level: 99999, xp: -4 },
        sword: { level: 3, xp: 10 ** 9 },
        magic: 'not an object',
        woodcutting: { level: 2.5, xp: 'lots' },
        hacking: { level: 99, xp: 99 }
    });
    assert.strictEqual(clean.mining.level, SKILLS.MAX_SKILL_LEVEL, 'level clamped to max');
    assert.strictEqual(clean.mining.xp, 0, 'negative xp discarded');
    assert.strictEqual(clean.sword.level, 3, 'valid level kept');
    assert.ok(clean.sword.xp <= SKILLS.xpForLevel(3), 'xp clamped to what the level can hold');
    assert.strictEqual(clean.magic.level, 1, 'non-object reset');
    assert.strictEqual(clean.woodcutting.level, 1, 'fractional level reset');
    assert.strictEqual(clean.hacking, undefined, 'unknown skill dropped');
});

test('normalizeSkills tolerates junk input', () => {
    for (const junk of [null, undefined, 'nope', 42, []]) {
        const clean = SKILLS.normalizeSkills(junk);
        assert.strictEqual(clean.mining.level, 1);
        assert.strictEqual(clean.magic.level, 1);
    }
});

test('gathering maps ore to mining and wood to woodcutting', () => {
    assert.strictEqual(SKILLS.GATHERING_SKILLS['Iron Ore'], 'mining');
    assert.strictEqual(SKILLS.GATHERING_SKILLS['Wood'], 'woodcutting');
});

test('gathering an unlisted item trains nothing', () => {
    const skills = leveled();
    assert.strictEqual(SKILLS.grantGatheringSkill(skills, 'Moonflower', 12), null);
    assert.strictEqual(SKILLS.grantGatheringSkill(skills, 'Leather', 12), null);
    assert.strictEqual(skills.mining.xp, 0);
    assert.strictEqual(skills.woodcutting.xp, 0);
});

test('gathering ore trains mining', () => {
    const skills = leveled();
    const result = SKILLS.grantGatheringSkill(skills, 'Iron Ore', 12);
    assert.strictEqual(result.skill, 'mining');
    assert.strictEqual(skills.mining.xp, 12);
    assert.strictEqual(skills.woodcutting.xp, 0);
});

test('skillSummary reports every skill in a stable order', () => {
    const summary = SKILLS.skillSummary(leveled());
    assert.strictEqual(summary.length, 4);
    assert.deepStrictEqual(summary.map(s => s.skill), ['mining', 'woodcutting', 'sword', 'magic']);
    summary.forEach(s => {
        assert.strictEqual(s.level, 1);
        assert.ok(s.xpForNext > 0);
        assert.strictEqual(s.maxLevel, SKILLS.MAX_SKILL_LEVEL);
    });
});

test('skills are independent of one another', () => {
    const skills = leveled();
    SKILLS.grantSkillXp(skills, 'magic', 25);
    assert.strictEqual(skills.magic.xp, 25);
    assert.strictEqual(skills.sword.xp, 0);
    assert.strictEqual(skills.mining.level, 1);
});

// --- Crafting content ---------------------------------------------------

test('the new high-tier gear exists in the item catalog', () => {
    assert.ok(ITEMS.armor['Spider Silk Robes'], 'Spider Silk Robes must be equippable armor');
    assert.ok(ITEMS.weapons['Venom Fang Sabre'], 'Venom Fang Sabre must be an equippable weapon');
    assert.ok(ITEMS.armor['Dragon Scale Armor']);
    assert.ok(ITEMS.weapons['Frost Blade']);
});

test('the new boss materials exist as materials', () => {
    for (const m of ['Dragon Scale', 'Frost Shard', 'Bone Dust', 'Spider Silk']) {
        assert.ok(ITEMS.materials[m], `${m} must be a known material`);
        assert.strictEqual(ITEMS.materials[m].type, 'material');
    }
});

test('the bosses actually drop the materials their recipes need', () => {
    const drops = {};
    Object.values(ITEMS.lootTable).forEach(list => list.forEach(i => {
        drops[i.name] = (drops[i.name] || 0) + i.chance;
    }));
    assert.ok(drops['Dragon Scale'] > 0, 'Dragon Scale must drop');
    assert.ok(drops['Frost Shard'] > 0, 'Frost Shard must drop');
    assert.ok(drops['Spider Silk'] > 0, 'Spider Silk must drop');
    assert.ok(drops['Bone Dust'] > 0, 'Bone Dust must drop');
});

test('the high-tier recipes exist and name real items', () => {
    for (const id of ['craft_spider_silk_robes', 'craft_frost_blade', 'craft_dragon_scale_armor', 'craft_venom_fang_sabre']) {
        const recipe = CRAFTING.RECIPES[id];
        assert.ok(recipe, `${id} must exist`);
        const known =
            ITEMS.weapons[recipe.result] || ITEMS.armor[recipe.result] ||
            ITEMS.helmets[recipe.result] || ITEMS.legs[recipe.result] ||
            ITEMS.shields[recipe.result] || ITEMS.consumables[recipe.result];
        assert.ok(known, `${id} produces unknown item ${recipe.result}`);
    }
});

test('every recipe input is obtainable in the world', () => {
    // Guards the failure mode where a recipe names a material that exists
    // nowhere, making it permanently uncraftable.
    const QUESTS = require('../../server/quests');
    // gatheringNodes is an empty Map until the spawner runs.
    if (QUESTS.gatheringNodes.size === 0) QUESTS.spawnGatheringNodes(() => {});

    const obtainable = new Set();
    Object.values(ITEMS.lootTable).forEach(list => list.forEach(i => obtainable.add(i.name)));
    QUESTS.gatheringNodes.forEach(n => obtainable.add(n.name));
    Object.values(CRAFTING.RECIPES).forEach(r => r.result && obtainable.add(r.result));
    Object.values(QUESTS.QUEST_DB).forEach(q => (q.rewards && q.rewards.items || []).forEach(i => obtainable.add(i)));

    Object.keys(CRAFTING.RECIPES).forEach(id => {
        const r = CRAFTING.RECIPES[id];
        Object.keys(r.inputs).forEach(item => {
            assert.ok(obtainable.has(item), `${id} needs '${item}' which nothing in the world provides`);
        });
    });
});

test('crafting a high-tier recipe consumes boss materials and yields the gear', () => {
    const player = {
        level: 25, gold: 0, inventory: [
            'Dragon Scale', 'Dragon Scale', 'Dragon Scale', 'Dragon Scale', 'Dragon Scale', 'Dragon Scale',
            'Leather', 'Leather', 'Leather', 'Leather',
            'Iron Ore', 'Iron Ore', 'Iron Ore', 'Iron Ore'
        ],
        craftedRecipes: ['craft_frost_blade']
    };
    const result = CRAFTING.craftItem(player, 'craft_dragon_scale_armor');
    assert.strictEqual(result.success, true, result.message);
    assert.strictEqual(result.result, 'Dragon Scale Armor');
    assert.deepStrictEqual(player.inventory, ['Dragon Scale Armor']);
    assert.ok(player.craftedRecipes.includes('craft_dragon_scale_armor'));
});

test('the dragon armor recipe refuses without the prerequisite', () => {
    const player = {
        level: 25, gold: 0, craftedRecipes: [],
        inventory: ['Dragon Scale', 'Dragon Scale', 'Dragon Scale', 'Dragon Scale', 'Dragon Scale', 'Dragon Scale',
            'Leather', 'Leather', 'Leather', 'Leather', 'Iron Ore', 'Iron Ore', 'Iron Ore', 'Iron Ore']
    };
    const result = CRAFTING.craftItem(player, 'craft_dragon_scale_armor');
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(player.inventory.length, 14, 'nothing consumed on refusal');
});

test('a high-tier recipe below its level requirement fails cleanly', () => {
    const player = { level: 1, gold: 0, craftedRecipes: [], inventory: ['Frost Shard', 'Frost Shard', 'Frost Shard', 'Frost Shard', 'Iron Ore', 'Iron Ore', 'Iron Ore', 'Iron Ore', 'Iron Ore', 'Iron Ore'] };
    const result = CRAFTING.craftItem(player, 'craft_frost_blade');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.message, 'Requires level 15.');
});
