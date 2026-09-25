const SUBCLASS_LEVEL_REQUIREMENT = 10;

const SUBCLASS_DATA = {
    juggernaut: {
        baseClass: 'warrior',
        name: 'Juggernaut',
        description: '+50% Max HP, +30% armor effectiveness, 10% chance to reflect melee damage.',
        statModifiers: { maxHpMulti: 1.5, armorMulti: 1.3, reflectMeleeChance: 0.1 },
        skill: { name: 'Shield Bash', type: 'single', damage: 40, manaCost: 25, cooldown: 5000, duration: 2000, effect: 'stun' }
    },
    berserker: {
        baseClass: 'warrior',
        name: 'Berserker',
        description: '+30% damage, +20% attack speed, below 30% HP gain +50% damage.',
        statModifiers: { damageMulti: 1.3, attackSpeedMulti: 1.2, lowHpDamageMulti: 1.5 },
        skill: { name: 'Rampage', type: 'aoe', damage: 60, manaCost: 35, cooldown: 8000, radius: 96 }
    },
    pyromancer: {
        baseClass: 'mage',
        name: 'Pyromancer',
        description: '+40% fire spell damage, fire immunity.',
        statModifiers: { fireDamageMulti: 1.4, fireImmunity: true },
        skill: { name: 'Meteor', type: 'aoe', damage: 80, manaCost: 50, cooldown: 10000, radius: 160 }
    },
    necromancer: {
        baseClass: 'mage',
        name: 'Necromancer',
        description: '+20% Max HP, lifesteal on attacks (10% of damage).',
        statModifiers: { maxHpMulti: 1.2, lifesteal: 0.1 },
        skill: { name: 'Raise Dead', type: 'summon', manaCost: 60, cooldown: 30000, duration: 30000, count: 2, summonType: 'skeleton' }
    },
    sniper: {
        baseClass: 'ranger',
        name: 'Sniper',
        description: '+60% ranged damage, +50% range.',
        statModifiers: { damageMulti: 1.6, rangeMulti: 1.5 },
        skill: { name: 'Headshot', type: 'single', damage: 120, manaCost: 45, cooldown: 12000, ignoreArmor: true }
    },
    beastmaster: {
        baseClass: 'ranger',
        name: 'Beastmaster',
        description: '+25% Max HP, wild animals do not aggro.',
        statModifiers: { maxHpMulti: 1.25, pacifyAnimals: true },
        skill: { name: 'Call Wolf', type: 'summon', manaCost: 40, cooldown: 25000, duration: 60000, count: 1, summonType: 'wolf' }
    },
    priest: {
        baseClass: 'healer',
        name: 'Priest',
        description: '+30% heal effectiveness, resurrection ability.',
        statModifiers: { healMulti: 1.3, canResurrect: true },
        skill: { name: 'Divine Light', type: 'aoe', heal: 60, manaCost: 50, cooldown: 15000, radius: 160, partyOnly: true }
    },
    druid: {
        baseClass: 'healer',
        name: 'Druid',
        description: '+20% Max HP, HoT (heal over time).',
        statModifiers: { maxHpMulti: 1.2, passiveHoT: true },
        skill: { name: 'Nature Shield', type: 'buff', manaCost: 45, cooldown: 20000, duration: 10000, radius: 128, damageReduction: 0.3 }
    }
};

function getAvailableSubclasses(classType) {
    const normalizedClass = String(classType || '').toLowerCase();
    return Object.entries(SUBCLASS_DATA)
        .filter(([, data]) => data.baseClass === normalizedClass)
        .map(([id, data]) => ({
            id,
            name: data.name,
            description: data.description
        }));
}

function canEvolve(player) {
    return Boolean(player) &&
        Number.isInteger(player.level) &&
        player.level >= SUBCLASS_LEVEL_REQUIREMENT &&
        !player.subclass;
}

function evolvePlayer(player, subclassId) {
    if (!canEvolve(player)) return false;

    const subclass = Object.prototype.hasOwnProperty.call(SUBCLASS_DATA, subclassId)
        ? SUBCLASS_DATA[subclassId]
        : null;
    if (!subclass) return false;
    if (subclass.baseClass !== String(player.classType || '').toLowerCase()) return false;

    // Stats are recalculated from the base class and modifier definition by
    // the server. Keeping this function side-effect free avoids applying the
    // subclass multiplier repeatedly.
    player.subclass = subclassId;
    return true;
}

function getSubclassSkill(player) {
    if (!player || !player.subclass) return null;
    const subclass = SUBCLASS_DATA[player.subclass];
    return subclass ? subclass.skill : null;
}

function getSubclassData(subclassId) {
    return SUBCLASS_DATA[subclassId] || null;
}

module.exports = {
    SUBCLASS_LEVEL_REQUIREMENT,
    SUBCLASS_DATA,
    getAvailableSubclasses,
    canEvolve,
    evolvePlayer,
    getSubclassSkill,
    getSubclassData
};
