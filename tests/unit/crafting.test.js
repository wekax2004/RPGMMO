// Unit tests for the crafting system. Pure functions, no server boot.
process.env.TIBIA_DB_DRIVER = 'local';
process.env.TIBIA_DB_FILE = require('path').join(
    require('os').tmpdir(),
    `tibia_crafting_test_${process.pid}.json`
);

const test = require('node:test');
const assert = require('node:assert');
const CRAFTING = require('../../server/crafting');
const ITEMS = require('../../server/items');

function crafter(overrides = {}) {
    return {
        charName: 'Smith',
        level: 1,
        gold: 0,
        inventory: [],
        craftedRecipes: [],
        ...overrides
    };
}

function withItems(items, overrides = {}) {
    return crafter({ inventory: [...items], ...overrides });
}

test('workbench is placed in the starting city', () => {
    const bench = CRAFTING.WORKBENCH;
    assert.strictEqual(bench.name, 'Workbench');
    // Must sit inside the 640x640 safe zone so it is reachable at spawn.
    assert.ok(bench.x > 0 && bench.x < 640, 'workbench x inside safe zone');
    assert.ok(bench.y > 0 && bench.y < 640, 'workbench y inside safe zone');
});

test('every recipe produces a real item from the catalog', () => {
    Object.values(CRAFTING.RECIPES).forEach(recipe => {
        const known =
            ITEMS.weapons[recipe.result] ||
            ITEMS.armor[recipe.result] ||
            ITEMS.helmets[recipe.result] ||
            ITEMS.legs[recipe.result] ||
            ITEMS.boots[recipe.result] ||
            ITEMS.shields[recipe.result] ||
            ITEMS.amulets[recipe.result] ||
            ITEMS.consumables[recipe.result];
        assert.ok(known, `recipe ${recipe.id} produces an unknown item: ${recipe.result}`);
    });
});

test('craft consumes exactly the required materials', () => {
    const player = withItems(['Iron Ore', 'Iron Ore', 'Iron Ore', 'Iron Ore', 'Iron Ore', 'Wood', 'Wood']);
    const result = CRAFTING.craftItem(player, 'craft_steel_longsword');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.result, 'Steel Longsword');
    assert.strictEqual(result.count, 1);
    // All five ore and both wood are gone, the sword is present.
    assert.strictEqual(player.inventory.filter(i => i === 'Iron Ore').length, 0);
    assert.strictEqual(player.inventory.filter(i => i === 'Wood').length, 0);
    assert.deepStrictEqual(player.inventory, ['Steel Longsword']);
});

test('craft fails without consuming anything when materials are short', () => {
    // Four ore, not five.
    const player = withItems(['Iron Ore', 'Iron Ore', 'Iron Ore', 'Iron Ore', 'Wood', 'Wood']);
    const result = CRAFTING.craftItem(player, 'craft_steel_longsword');

    assert.strictEqual(result.success, false);
    // The inventory must be completely untouched by a failed craft.
    assert.deepStrictEqual(player.inventory, ['Iron Ore', 'Iron Ore', 'Iron Ore', 'Iron Ore', 'Wood', 'Wood']);
    assert.deepStrictEqual(player.craftedRecipes, []);
});

test('craft fails on an unknown recipe id', () => {
    for (const bad of [null, undefined, 42, {}, 'not_a_recipe', '']) {
        const player = crafter();
        assert.strictEqual(CRAFTING.craftItem(player, bad).success, false);
    }
});

test('recipe ids with prototype keys are rejected', () => {
    const player = withItems(['Iron Ore', 'Iron Ore', 'Wood', 'Wood', 'Wood']);
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        const result = CRAFTING.craftItem(player, key);
        assert.strictEqual(result.success, false, `${key} must not craft`);
    }
});

test('a level requirement blocks crafting but does not consume materials', () => {
    // Greater Health Potion needs level 5 and a crafted Health Potion first.
    const player = withItems(['Moonflower', 'Moonflower', 'Moonflower', 'Moonflower', 'Iron Ore'], { level: 1 });
    const result = CRAFTING.craftItem(player, 'craft_greater_health_potion');
    assert.strictEqual(result.success, false);
    assert.strictEqual(player.inventory.length, 5, 'materials must survive a failed craft');
});

test('a prerequisite recipe must be crafted first', () => {
    const materials = ['Moonflower', 'Moonflower', 'Moonflower', 'Moonflower', 'Iron Ore'];
    // Level 5 but the basic potion was never crafted.
    const fresh = withItems(materials, { level: 5 });
    assert.strictEqual(CRAFTING.craftItem(fresh, 'craft_greater_health_potion').success, false);

    // Same player, but has already crafted the basic potion.
    const taught = withItems(materials, { level: 5, craftedRecipes: ['craft_health_potion'] });
    assert.strictEqual(CRAFTING.craftItem(taught, 'craft_greater_health_potion').success, true);
});

test('crafting a recipe records it exactly once', () => {
    const player = withItems(['Moonflower', 'Moonflower']);
    assert.strictEqual(CRAFTING.craftItem(player, 'craft_health_potion').success, true);
    assert.deepStrictEqual(player.craftedRecipes, ['craft_health_potion']);
    // Crafting again must not duplicate the learned marker.
    player.inventory.push('Moonflower', 'Moonflower');
    assert.strictEqual(CRAFTING.craftItem(player, 'craft_health_potion').success, true);
    assert.deepStrictEqual(player.craftedRecipes, ['craft_health_potion']);
});

test('a multi-output recipe yields the right count', () => {
    const player = withItems(['Moonflower', 'Moonflower']);
    const result = CRAFTING.craftItem(player, 'craft_health_potion');
    assert.strictEqual(result.count, 2);
    assert.deepStrictEqual(player.inventory, ['Health Potion', 'Health Potion']);
});

test('listRecipes reports missing materials and blocks the button', () => {
    const player = withItems(['Iron Ore', 'Iron Ore']);
    const recipes = CRAFTING.listRecipes(player);
    const sword = recipes.find(r => r.id === 'craft_steel_longsword');

    assert.strictEqual(sword.canCraft, false);
    assert.ok(sword.missing.some(m => m.item === 'Iron Ore' && m.have === 2 && m.required === 5));
    assert.ok(sword.missing.some(m => m.item === 'Wood' && m.have === 0 && m.required === 2));

    // With enough materials it becomes craftable.
    const stocked = withItems(['Iron Ore', 'Iron Ore', 'Iron Ore', 'Iron Ore', 'Iron Ore', 'Wood', 'Wood']);
    const ok = CRAFTING.listRecipes(stocked).find(r => r.id === 'craft_steel_longsword');
    assert.strictEqual(ok.canCraft, true);
    assert.deepStrictEqual(ok.missing, []);
});

test('listRecipes marks level-locked recipes as locked', () => {
    const recipes = CRAFTING.listRecipes(crafter({ level: 1 }));
    const greater = recipes.find(r => r.id === 'craft_greater_health_potion');
    assert.strictEqual(greater.canCraft, false);
    assert.strictEqual(greater.locked, true);
});

test('countMaterials tallies duplicate stacks', () => {
    const counts = CRAFTING.countMaterials(withItems(['Iron Ore', 'Iron Ore', 'Wood']));
    assert.strictEqual(counts['Iron Ore'], 2);
    assert.strictEqual(counts['Wood'], 1);
});

test('a player with a non-array inventory is handled safely', () => {
    const broken = crafter({ inventory: 'not-an-array' });
    assert.deepStrictEqual(CRAFTING.countMaterials(broken), {});
    assert.strictEqual(CRAFTING.craftItem(broken, 'craft_iron_sword').success, false);
    assert.deepStrictEqual(CRAFTING.listRecipes(broken).every(r => r.canCraft === false), true);
});

test('sanitizeCraftedRecipes keeps only known ids, deduped', () => {
    const clean = CRAFTING.sanitizeCraftedRecipes([
        'craft_health_potion',
        'craft_health_potion',
        'not_real',
        42,
        null,
        'craft_iron_sword'
    ]);
    assert.deepStrictEqual(clean, ['craft_health_potion', 'craft_iron_sword']);
});

test('sanitizeCraftedRecipes tolerates junk input', () => {
    for (const junk of [null, undefined, 'nope', 42, {}]) {
        assert.deepStrictEqual(CRAFTING.sanitizeCraftedRecipes(junk), []);
    }
});
