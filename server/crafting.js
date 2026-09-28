// Crafting recipes and the workbench entity.
// Pure data plus pure functions: the server owns validation and mutation,
// the client only ever renders what these functions return.
const ITEMS = require('./items');

// Gathering node drops and mob drops double as crafting materials.
const MATERIALS = {
    'Iron Ore': { from: 'gathering', tier: 1 },
    'Wood': { from: 'gathering', tier: 1 },
    'Leather': { from: 'gathering', tier: 2 },
    'Moonflower': { from: 'gathering', tier: 1 },
    'Poison Mushroom': { from: 'gathering', tier: 1 },
    'Ancient Bone': { from: 'gathering', tier: 1 },
    'Spider Silk': { from: 'loot', tier: 2 },
    'Bone Dust': { from: 'loot', tier: 2 },
    'Dragon Scale': { from: 'loot', tier: 3 },
    'Frost Shard': { from: 'loot', tier: 3 }
};

const RECIPES = {
    craft_steel_longsword: {
        id: 'craft_steel_longsword',
        name: 'Steel Longsword',
        result: 'Steel Longsword',
        count: 1,
        level: 1,
        // Materials are consumed on craft. Quantities are per craft.
        inputs: { 'Iron Ore': 5, 'Wood': 2 },
        description: 'Fold five Iron Ore with two Wood into a dependable blade.'
    },
    craft_iron_sword: {
        id: 'craft_iron_sword',
        name: 'Iron Sword',
        result: 'Iron Sword',
        count: 1,
        level: 1,
        inputs: { 'Iron Ore': 2 },
        description: 'A simple sword. Every adventurer should carry one.'
    },
    craft_wooden_shield: {
        id: 'craft_wooden_shield',
        name: 'Wooden Shield',
        result: 'Wooden Shield',
        count: 1,
        level: 1,
        inputs: { 'Wood': 3 },
        description: 'Better than nothing in a pinch.'
    },
    craft_leather_tunic: {
        id: 'craft_leather_tunic',
        name: 'Leather Tunic',
        result: 'Leather Tunic',
        count: 1,
        level: 2,
        inputs: { 'Leather': 3, 'Wood': 1 },
        description: 'Light armour, stitched from cured hide.'
    },
    craft_health_potion: {
        id: 'craft_health_potion',
        name: 'Health Potion',
        result: 'Health Potion',
        count: 2,
        level: 1,
        inputs: { 'Moonflower': 2 },
        description: 'Brew two restorative draughts from two Moonflowers.'
    },
    craft_mana_potion: {
        id: 'craft_mana_potion',
        name: 'Mana Potion',
        result: 'Mana Potion',
        count: 2,
        level: 1,
        inputs: { 'Poison Mushroom': 2 },
        description: 'Distil two mana draughts from two Poison Mushrooms.'
    },
    craft_greater_health_potion: {
        id: 'craft_greater_health_potion',
        name: 'Greater Health Potion',
        result: 'Greater Health Potion',
        count: 1,
        level: 5,
        requires: 'craft_health_potion',
        inputs: { 'Moonflower': 4, 'Iron Ore': 1 },
        description: 'A stronger brew. Requires knowledge of the basic potion.'
    },

    // === High tier: boss materials ===
    // These consume drops from the boss encounters, so the gear has to be
    // earned in the field before the workbench can turn it into equipment.
    craft_spider_silk_robes: {
        id: 'craft_spider_silk_robes',
        name: 'Spider Silk Robes',
        result: 'Spider Silk Robes',
        count: 1,
        level: 12,
        inputs: { 'Spider Silk': 8, 'Leather': 3 },
        description: 'Woven from the Queen herself. Light, and deceptively tough.'
    },
    craft_frost_blade: {
        id: 'craft_frost_blade',
        name: 'Frost Blade',
        result: 'Frost Blade',
        count: 1,
        level: 15,
        inputs: { 'Frost Shard': 4, 'Iron Ore': 6 },
        description: 'Tempered in dragon frost. The edge never dulls.'
    },
    craft_dragon_scale_armor: {
        id: 'craft_dragon_scale_armor',
        name: 'Dragon Scale Armor',
        result: 'Dragon Scale Armor',
        count: 1,
        level: 20,
        requires: 'craft_frost_blade',
        inputs: { 'Dragon Scale': 6, 'Leather': 4, 'Iron Ore': 4 },
        description: 'Scales layered over hide. Requires mastery of the Frost Blade.'
    },
    craft_venom_fang_sabre: {
        id: 'craft_venom_fang_sabre',
        name: 'Venom Fang Sabre',
        result: 'Venom Fang Sabre',
        count: 1,
        level: 14,
        inputs: { 'Spider Silk': 4, 'Iron Ore': 5, 'Wood': 2 },
        description: 'A curved sabre bound in silk. Light and vicious.'
    },
    craft_greater_mana_potion: {
        id: 'craft_greater_mana_potion',
        name: 'Greater Mana Potion',
        result: 'Greater Mana Potion',
        count: 1,
        level: 6,
        requires: 'craft_mana_potion',
        inputs: { 'Poison Mushroom': 4, 'Frost Shard': 1 },
        description: 'A deep draught for spellcasters. Requires the basic brew.'
    }
};

// The workbench sits in the starting city next to King Arthur. Its floor is
// stated so the "am I near the bench" check can be floor-aware, same as NPCs.
const WORKBENCH = {
    id: 'n_workbench',
    name: 'Workbench',
    x: 352, y: 448,
    z: require('./config').Z_SURFACE
};

function ownRecipe(recipeId, player) {
    return Object.prototype.hasOwnProperty.call(RECIPES, recipeId);
}

// An item is craftable in principle when the recipe exists and its
// prerequisite has already been crafted at least once.
function prerequisiteMet(recipe, player) {
    if (!recipe.requires) return true;
    if (Array.isArray(player.craftedRecipes) && player.craftedRecipes.includes(recipe.requires)) return true;
    return false;
}

function hasMaterials(player, recipe) {
    const counts = countMaterials(player);
    return Object.entries(recipe.inputs).every(([item, qty]) => (counts[item] || 0) >= qty);
}

function countMaterials(player) {
    const counts = {};
    (Array.isArray(player.inventory) ? player.inventory : []).forEach(name => {
        if (typeof name === 'string') counts[name] = (counts[name] || 0) + 1;
    });
    return counts;
}

// Returns the recipe list annotated with per-player state so the client can
// render "Craft" versus "Missing materials" without duplicating any rules.
function listRecipes(player) {
    const counts = countMaterials(player);
    return Object.values(RECIPES).map(recipe => {
        const missing = [];
        Object.entries(recipe.inputs).forEach(([item, qty]) => {
            const have = counts[item] || 0;
            if (have < qty) missing.push({ item, have, required: qty });
        });
        const prereqOk = prerequisiteMet(recipe, player);
        const levelOk = Number.isSafeInteger(player.level) && player.level >= recipe.level;
        return {
            id: recipe.id,
            name: recipe.name,
            result: recipe.result,
            count: recipe.count,
            description: recipe.description,
            level: recipe.level,
            inputs: recipe.inputs,
            canCraft: missing.length === 0 && prereqOk && levelOk,
            missing,
            locked: !prereqOk || !levelOk
        };
    });
}

// Validates and applies a craft. Materials are only removed after every
// check passes, so a failure can never partially consume the inventory.
function craftItem(player, recipeId) {
    if (typeof recipeId !== 'string' || !ownRecipe(recipeId, recipeId)) {
        return { success: false, message: 'Unknown recipe.' };
    }
    const recipe = RECIPES[recipeId];
    if (!Number.isSafeInteger(player.level) || player.level < recipe.level) {
        return { success: false, message: `Requires level ${recipe.level}.` };
    }
    if (!prerequisiteMet(recipe, player)) {
        return { success: false, message: 'You have not learned this recipe yet.' };
    }
    if (!hasMaterials(player, recipe)) {
        return { success: false, message: 'You are missing materials.' };
    }
    // Only consume once every gate has passed.
    Object.entries(recipe.inputs).forEach(([item, qty]) => removeItems(player.inventory, item, qty));
    for (let i = 0; i < recipe.count; i++) player.inventory.push(recipe.result);
    if (!Array.isArray(player.craftedRecipes)) player.craftedRecipes = [];
    if (!player.craftedRecipes.includes(recipeId)) player.craftedRecipes.push(recipeId);
    return { success: true, message: `Crafted ${recipe.count}x ${recipe.result}.`, result: recipe.result, count: recipe.count };
}

function removeItems(inventory, item, qty) {
    let removed = 0;
    for (let i = inventory.length - 1; i >= 0 && removed < qty; i--) {
        if (inventory[i] === item) {
            inventory.splice(i, 1);
            removed++;
        }
    }
    return removed;
}

// Sanitizes the persisted crafted-recipe list. Mirrors the quest pattern:
// rebuild from known ids rather than trusting the save.
function sanitizeCraftedRecipes(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    raw.forEach(id => {
        if (typeof id === 'string' && ownRecipe(id, id) && !out.includes(id)) out.push(id);
    });
    return out;
}

module.exports = {
    MATERIALS, RECIPES, WORKBENCH,
    listRecipes, craftItem, countMaterials, sanitizeCraftedRecipes
};
