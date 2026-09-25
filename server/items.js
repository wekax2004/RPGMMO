module.exports = {
    consumables: {
        'Health Potion': { type: 'heal', val: 50 },
        'Mana Potion': { type: 'mana', val: 30 },
        'Greater Health Potion': { type: 'heal', val: 120 },
        'Greater Mana Potion': { type: 'mana', val: 80 }
    },
    weapons: {
        'Iron Sword': { type: 'weapon', bonus: 5 },
        'Bandit Dagger': { type: 'weapon', bonus: 3 },
        'Spider Queen Fang': { type: 'weapon', bonus: 18 },
        'Frost Blade': { type: 'weapon', bonus: 22 },
        'Bone Staff': { type: 'weapon', bonus: 15 },
        'Steel Longsword': { type: 'weapon', bonus: 10 },
        'Elven Bow': { type: 'weapon', bonus: 12 },
        'Holy Staff': { type: 'weapon', bonus: 8 }
    },
    armor: {
        'Leather Tunic': { type: 'armor', def: 4 },
        'Silk Armor': { type: 'armor', def: 12 },
        'Dragon Scale Armor': { type: 'armor', def: 20 },
        'Plate Armor': { type: 'armor', def: 8 },
        'Chain Mail': { type: 'armor', def: 6 }
    },
    helmets: {
        'Leather Helmet': { type: 'helmet', def: 2 },
        'Crown of the Dead': { type: 'helmet', def: 10 },
        'Iron Helmet': { type: 'helmet', def: 4 },
        'Dragon Helm': { type: 'helmet', def: 8 }
    },
    legs: {
        'Leather Legs': { type: 'legs', def: 2 },
        'Plate Legs': { type: 'legs', def: 6 },
        'Dragon Scale Legs': { type: 'legs', def: 10 }
    },
    boots: {
        'Leather Boots': { type: 'boots', def: 1, speedBonus: 20 },
        'Steel Boots': { type: 'boots', def: 3, speedBonus: 10 },
        'Boots of Haste': { type: 'boots', def: 2, speedBonus: 50 }
    },
    shields: {
        'Wooden Shield': { type: 'shield', def: 3 },
        'Iron Shield': { type: 'shield', def: 6 },
        'Tower Shield': { type: 'shield', def: 10 }
    },
    amulets: {
        'Wolf Tooth Chain': { type: 'amulet', maxHpBonus: 20 },
        'Dragon Heart Pendant': { type: 'amulet', maxHpBonus: 50 },
        'Amulet of Healing': { type: 'amulet', maxHpBonus: 30 }
    },
    lootTable: {
        'spider': [
            { name: 'Spider Silk', chance: 0.3 }, 
            { name: 'Health Potion', chance: 0.15 },
            { name: 'Wolf Tooth Chain', chance: 0.05 }
        ],
        'bear': [
            { name: 'Health Potion', chance: 0.25 },
            { name: 'Leather Helmet', chance: 0.15 },
            { name: 'Leather Boots', chance: 0.1 }
        ],
        'yeti': [
            { name: 'Mana Potion', chance: 0.3 },
            { name: 'Health Potion', chance: 0.3 },
            { name: 'Leather Legs', chance: 0.2 },
            { name: 'Iron Helmet', chance: 0.08 }
        ],
        'skeleton': [
            { name: 'Bone', chance: 0.5 },
            { name: 'Bandit Dagger', chance: 0.1 },
            { name: 'Wooden Shield', chance: 0.1 }
        ],
        'bandit': [
            { name: 'Bandit Dagger', chance: 0.2 }, 
            { name: 'Health Potion', chance: 0.2 }, 
            { name: 'Iron Sword', chance: 0.1 }, 
            { name: 'Leather Tunic', chance: 0.15 },
            { name: 'Leather Helmet', chance: 0.1 },
            { name: 'Leather Legs', chance: 0.1 },
            { name: 'Leather Boots', chance: 0.1 }
        ],
        'minotaur': [
            { name: 'Minotaur Horn', chance: 0.4 }, 
            { name: 'Mana Potion', chance: 0.3 }, 
            { name: 'Health Potion', chance: 0.2 },
            { name: 'Wooden Shield', chance: 0.25 },
            { name: 'Chain Mail', chance: 0.08 },
            { name: 'Iron Shield', chance: 0.05 }
        ],
        // Boss loot tables
        'spider_queen': [
            { name: 'Spider Queen Fang', chance: 1.0 },
            { name: 'Silk Armor', chance: 0.5 },
            { name: 'Greater Health Potion', chance: 1.0 },
            { name: 'Greater Mana Potion', chance: 0.8 },
            { name: 'Dragon Heart Pendant', chance: 0.15 }
        ],
        'ice_dragon': [
            { name: 'Frost Blade', chance: 0.7 },
            { name: 'Dragon Scale Armor', chance: 0.4 },
            { name: 'Dragon Helm', chance: 0.3 },
            { name: 'Dragon Scale Legs', chance: 0.25 },
            { name: 'Ice Crystal', chance: 1.0 },
            { name: 'Greater Health Potion', chance: 1.0 },
            { name: 'Boots of Haste', chance: 0.1 }
        ],
        'skeleton_king': [
            { name: 'Crown of the Dead', chance: 0.6 },
            { name: 'Bone Staff', chance: 0.7 },
            { name: 'Royal Bones', chance: 1.0 },
            { name: 'Tower Shield', chance: 0.2 },
            { name: 'Greater Health Potion', chance: 1.0 },
            { name: 'Amulet of Healing', chance: 0.15 }
        ]
    }
};
