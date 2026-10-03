/*
 * server/rarity.js
 *
 * Roadmap 4.6: rare item drops.
 *
 * WHAT THIS IS FOR
 *
 * `items.js lootTable` is a flat per-mob-type list. Every entry rolls
 * independently against its own chance, so the most valuable thing in the game --
 * a Dragon Heart Pendant off a spider queen -- competes on the same 0..1 scale as a
 * Health Potion off a bandit. Nothing tells a player that one of those was a lucky
 * drop, because the server does not know either. It just knows the roll came up.
 *
 * This adds a second, rarer roll on top of the flat one, and -- this is the part
 * that matters -- makes the result *say so*. A rare drop sends its own packet with
 * a rarity label and a colour, so the client can play the sparkle and the chat line
 * can name what happened. A 1-in-400 chance that is indistinguishable from every
 * other drop is not a reward; it is a number in a table.
 *
 * WHY A SEPARATE ROLL AND NOT JUST A LOWER CHANCE
 *
 * Because the two need different tuning. The flat table answers "what does this mob
 * usually give", and is per-mob-type because a bandit and a dragon are different
 * animals. This roll answers "what is worth being loud about", and is keyed on
 * `tier` and `isElite` instead, because those are what actually predict whether a
 * player is far enough into the game to want the thing. Keying it on mob type would
 * mean every one of the nine tables needed a second list.
 *
 * The probabilities are deliberately tiny and the floor is deliberate: see
 * `rollRareDrop`. A 1-in-400 drop that fires on the first dungeon mob is not rare,
 * it is a tax on the first ten minutes.
 */

/**
 * The tiers, cheapest to announce first.
 *
 * `chance` is the per-kill chance for a NON-elite mob at the item's `minTier`, and
 * scales up from there. `color` is what the client paints the sparkle and the
 * floating text with; keeping it here rather than in the client means a tier looks
 * the same everywhere without three files agreeing on it.
 */
const RARITY = {
    rare: { key: 'rare', label: 'Rare', color: '#4da6ff', chance: 0.004 },
    legendary: { key: 'legendary', label: 'Legendary', color: '#ffb340', chance: 0.0012 }
};

/**
 * What can drop, and how deep you must be to see it.
 *
 * Every name here also has to exist in an `items.js` catalogue, or it will drop
 * into a player's bag as an item nothing recognises: not equippable, not usable,
 * not tradeable into anything. `describe()` returns null for an unknown name rather
 * than inventing a tier, so a typo here shows up as "no announcement" instead of
 * silently working.
 *
 * `minTier` is the floor's tier, not the player's. A tier-5.5 dungeon is deeper
 * than a tier-1 surface no matter who is standing in it, which is what stops a
 * surface spider from handing out a War Cleaver.
 */
const RARE_POOL = [
    // --- rare: reachable from the shallower floors -------------------------
    { name: 'Amulet of the Frost Ward', rarity: 'rare', minTier: 2 },
    { name: 'Frostbound Blade', rarity: 'rare', minTier: 2 },
    { name: 'Spider Queen Carapace', rarity: 'rare', minTier: 2 },
    { name: 'Owl Tower Buckler', rarity: 'rare', minTier: 3 },
    { name: 'Bonecrown Greathelm', rarity: 'rare', minTier: 3 },

    // --- legendary: the deep floors only -----------------------------------
    { name: 'War Cleaver of the Warren', rarity: 'legendary', minTier: 4 },
    { name: 'Frostmaw Pelt', rarity: 'legendary', minTier: 4 },
    { name: 'Crown of the Fallen King', rarity: 'legendary', minTier: 5 }
];

/**
 * How much deeper than `minTier` counts as meaningfully deeper.
 *
 * Capped on purpose. Without a cap, a tier-11 floor would be a guaranteed drop and
 * the reward for depth would flatten out exactly where the game wants players to
 * spend the most time. Three is enough to reward the bottom two floors and not
 * enough to trivialise them.
 */
const TIER_SPAN = 3;

/**
 * Elite multiplier on the roll.
 *
 * Elites are already rarer than the mobs around them and are what a player farms
 * deliberately, so they should not ALSO be the only source of a good drop. 4x is
 * the point where an elite kill feels like it might pay without making it routine.
 */
const ELITE_MULTIPLIER = 4;

/**
 * The chance a non-elite mob at exactly `minTier` produces this drop.
 *
 * Scaled up per tier of depth beyond the minimum, and capped by TIER_SPAN. Returns
 * 0 below `minTier` rather than throwing: "too shallow to see this" is a normal
 * answer, not an error, and the caller should not have to pre-check.
 */
function chanceFor(entry, tier, isElite) {
    if (tier < entry.minTier) return 0;
    const depth = Math.min(tier - entry.minTier, TIER_SPAN);
    const base = RARITY[entry.rarity].chance;
    // +1 at the minimum tier so the first eligible floor is not already rare.
    const scaled = base * (1 + depth);
    return isElite ? scaled * ELITE_MULTIPLIER : scaled;
}

/**
 * Look up what tier a named item is, or null if it is not a rare drop at all.
 *
 * Null rather than a default on purpose. `describe()` is what decides whether a drop
 * gets announced, so an unknown name must fail closed -- an unannounced drop is a
 * quiet one, and a quiet one with a wrong colour and a false "Legendary" is worse.
 */
function describe(name) {
    const entry = RARE_POOL.find(e => e.name === name);
    if (!entry) return null;
    const def = RARITY[entry.rarity];
    return { name: entry.name, rarity: def.key, label: def.label, color: def.color, minTier: entry.minTier };
}

/**
 * One rare-drop roll for one dead mob.
 *
 * Returns the winning entry (via `describe`) or null. At most one, because a kill
 * that hands out three legendaries is not a rare drop, it is a bug report.
 *
 * `random` is injectable so tests can drive every branch deterministically. That
 * matters more here than usual: the default probabilities are around 0.4%, so a
 * probe that rolls for real would need hundreds of kills to see the happy path and
 * would still not be able to prove the floor is enforced.
 *
 * The pool is filtered by depth BEFORE the roll, not after. Rolling against the whole
 * pool and then discarding shallow entries would silently divide every chance by the
 * pool size, so a tier-1 player would get a legendary at 0.0012 / 8 -- and the
 * configuration would read as though they should.
 */
function rollRareDrop({ tier = 1, isElite = false, random = Math.random } = {}) {
    const eligible = RARE_POOL.filter(e => chanceFor(e, tier, isElite) > 0);
    if (eligible.length === 0) return null;

    for (const entry of eligible) {
        if (random() < chanceFor(entry, tier, isElite)) {
            return describe(entry.name);
        }
    }
    return null;
}

/**
 * Every name this module can drop, for the tests that assert the pool is well-formed.
 * Returns entries rather than names so a test can check `minTier` without parsing
 * strings.
 */
function pool() {
    return RARE_POOL.map(e => ({ ...e, ...describe(e.name) }));
}

module.exports = { RARITY, RARE_POOL, chanceFor, describe, rollRareDrop, pool, TIER_SPAN, ELITE_MULTIPLIER };