/*
 * server/mobai.js
 *
 * Roadmap 5.2: mob behaviour beyond aggro and approach.
 *
 * The existing AI is two branches: adjacent, attack; within AGGRO_RANGE, walk toward
 * the player; otherwise nothing at all. A mob with no player nearby stands still
 * forever, so a dungeon floor is a set of statues the player walks between.
 *
 * Three behaviours are added, chosen because they compose with the two that exist
 * rather than replacing them:
 *
 *   PATROL      -- with no target, wander. Stops the statues.
 *   CALL FOR HELP -- on taking damage, alert nearby same-type mobs, which then aggro.
 *                  This is what makes a pack a pack. Today `spawnMobPack` places
 *                  three mobs together and nothing ever makes them engage together.
 *   FLEE        -- below a health fraction, run away from the player instead of
 *                  toward them.
 *
 * WHY FLEE IS BOUNDED
 *
 * A mob that flees forever is unkillable, and a player who cannot finish a fight
 * learns that fights are not worth starting. So fleeing has a hard duration and then
 * the mob turns back regardless of its health. It is a reprieve, not an escape --
 * and it is announced, because a mob that runs and then comes back is much less
 * frustrating when the player can see it happening.
 *
 * WHY CALL FOR HELP IS NOT A GLOBAL ALARM
 *
 * Calling every mob on the floor would turn a solo player into a raid. The call is
 * radius-limited AND type-limited: a bear calling pulls other bears, not the skeletons
 * standing next to them. That is both the interesting design choice and the cheap
 * one -- it needs no squad concept, and it stops the whole floor aggroing at once.
 *
 * This module is pure with respect to the world: it decides, and the caller performs.
 * Nothing here moves a mob or sends a packet, which is what makes every branch below
 * testable without a server.
 */

/**
 * Decides what one mob should do this tick.
 *
 * @param {object} ctx
 * @param {object} ctx.mob       the mob record
 * @param {object|null} ctx.target  the player it is aware of, if any
 * @param {number} ctx.distance  distance to that target
 * @param {boolean} ctx.isNight
 * @param {() => number} ctx.random  injectable, so every roll is reachable in one call
 * @returns {{state:string, reason:string}}
 */
function decide(ctx) {
    const { mob, target, distance, isNight = false, random = Math.random } = ctx;
    const now = ctx.now === undefined ? Date.now() : ctx.now;

    // --- fleeing wins over everything --------------------------------------
    // Checked before aggro because a fleeing mob that also wants to attack is a mob
    // that oscillates on the flee/health boundary and looks broken.
    if (mob.fleeUntil && now < mob.fleeUntil) {
        return { state: 'flee', reason: 'fleeing' };
    }
    // The flee expired. Clear it rather than leaving a stale timestamp, so a mob does
    // not keep re-evaluating against a time in the past every tick forever.
    //
    // The cooldown that follows is what makes the bound actually bind. Without it a
    // mob at 5% health runs for FLEE_DURATION_MS, turns back, fails the panic roll
    // again, and runs again -- for as long as the player keeps swinging. The first
    // version had only the timer, and the unit test caught it: it drove the mob past
    // the expiry with the panic roll forced and expected an attack.
    //
    // "Past the expiry" is the wrong test for "will not panic again", which is why
    // this is a cooldown rather than a flag: the mob may turn back, but not
    // immediately.
    if (mob.fleeUntil) {
        mob.fleeUntil = 0;
        mob.fleeReadyAt = (mob.fleeUntil || 0) + now + FLEE_COOLDOWN_MS;
    }

    // --- no target: patrol --------------------------------------------------
    if (!target) {
        return { state: 'patrol', reason: 'no target' };
    }

    // --- low health: flee ---------------------------------------------------
    const fraction = mob.maxHp > 0 ? mob.hp / mob.maxHp : 1;
    // Not every mob runs. A spider that flees is a different creature from a bear
    // that does, and the type is the cheapest way to say which is which without a
    // per-mob personality table.
    const canFlee = COWARD_TYPES.has(mob.type);
    const shouldFlee = canFlee && fraction <= FLEE_HP_FRACTION
        && distance <= FLEE_TRIGGER_RANGE
        && (!mob.fleeReadyAt || now >= mob.fleeReadyAt)
        // A mob only panics if it is not already safe. Without this, a mob at 1%
        // health on the far side of the map flees from something it cannot even see
        // being fought.
        && random() < FLEE_PANIC_CHANCE;

    if (shouldFlee) {
        // A bounded reprieve. See the header: a mob that flees forever is unkillable.
        mob.fleeUntil = now + FLEE_DURATION_MS;
        return { state: 'flee', reason: `hp ${Math.round(fraction * 100)}%` };
    }

    // --- in range: fight ----------------------------------------------------
    if (distance <= (ctx.meleeRange || 96)) {
        return { state: 'attack', reason: 'in melee range' };
    }
    if (distance <= (ctx.aggroRange || 400)) {
        return { state: 'chase', reason: 'within aggro' };
    }
    return { state: 'patrol', reason: 'target out of range' };
}

/**
 * Whether a hurt mob should rouse its neighbours, and if so which.
 *
 * Returns the ids to alert. Deliberately a list rather than a boolean: the caller
 * needs to know WHICH mobs to aggro, and returning a list makes the radius and the
 * type filter testable without a world.
 *
 * @returns {string[]} ids of mobs that should now treat `targetId` as their target
 */
function callersForHelp(mob, candidates, { targetId, now = Date.now(), random = Math.random }) {
    // The CALLER's health is checked here, not only at the call site. A mob that dies
    // on the swing that triggered the call should still call -- "it screamed for help
    // as it died" is both correct and good theatre -- but a mob that was ALREADY dead
    // when the tick reached it should not. server.js guards for that; putting the
    // check here as well means the rule is testable without a server, and it caught
    // the gap the first time it was written: server.js had the guard, the module did
    // not, so calling `callersForHelp` directly with a corpse rallied its pack.
    if (!mob || mob.hp <= 0) return [];
    if (!candidates || candidates.length === 0) return [];

    // Not from a mob that has already called, or the first hit in a pile alerts the
    // entire neighbourhood repeatedly.
    if (now - (mob.lastCallAt || 0) < CALL_COOLDOWN_MS) return [];

    const helpers = candidates.filter(other => {
        if (!other || other.id === mob.id) return false;
        if (other.hp <= 0) return false;
        if (MAP_Z(other.z) !== MAP_Z(mob.z)) return false;
        if (other.type !== mob.type) return false;
        if (other.fleeUntil && now < other.fleeUntil) return false;
        if (other.alertedBy === mob.id && now - (other.alertedAt || 0) < ALERT_DURATION_MS) return false;
        return dist(mob, other) <= CALL_RADIUS;
    });

    if (helpers.length === 0) return [];
    if (random() >= CALL_CHANCE) return [];

    mob.lastCallAt = now;
    for (const h of helpers) { h.alertedBy = mob.id; h.alertedAt = now; }
    return helpers.map(h => h.id);
}

// A tiny floor normaliser, so this module does not have to require map.js and pull
// the whole generated map into a unit test. Matches server.js's behaviour for the
// only case that matters here: a missing or corrupt z is the surface.
const MAP_Z = (z) => (typeof z === 'number' && Number.isFinite(z) ? z : 0);

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const COWARD_TYPES = new Set(['bear', 'spider']);
const FLEE_HP_FRACTION = 0.25;
const FLEE_TRIGGER_RANGE = 320;
const FLEE_PANIC_CHANCE = 0.6;
const FLEE_DURATION_MS = 2500;
/**
 * Minimum gap between one flee ending and the next one being allowed.
 *
 * Must exceed FLEE_DURATION_MS or the cooldown and the timer interact badly: a mob
 * whose flee expires inside its own cooldown turns back and is immediately eligible
 * again, which is the same loop the cooldown exists to break.
 */
const FLEE_COOLDOWN_MS = 5000;
const CALL_RADIUS = 260;
const CALL_CHANCE = 0.7;
const CALL_COOLDOWN_MS = 3000;
const ALERT_DURATION_MS = 8000;

module.exports = {
    decide,
    callersForHelp,
    COWARD_TYPES,
    FLEE_HP_FRACTION,
    FLEE_TRIGGER_RANGE,
    FLEE_PANIC_CHANCE,
    FLEE_DURATION_MS,
    FLEE_COOLDOWN_MS,
    CALL_RADIUS,
    CALL_CHANCE,
    CALL_COOLDOWN_MS,
    ALERT_DURATION_MS
};