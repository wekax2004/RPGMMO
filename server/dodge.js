/*
 * server/dodge.js
 *
 * Roadmap 5.3: dodging and blocking.
 *
 * THE GAP THIS FILLS
 *
 * `mobs.js mobAttack` took a `defense` argument and did `Math.max(1, damage - defense)`.
 * So there was armour, and armour was a flat subtraction with a floor of 1 -- a player
 * in a Tower Shield took exactly one point of damage from everything, which means the
 * shield turned the player into a punching bag that could not die but also could not
 * meaningfully fight back. And there was no way to avoid a hit at all. Every attack
 * landed, every time.
 *
 * Two distinct mechanics are added, because they answer different questions and a
 * player chooses between them:
 *
 *   DODGE -- avoid the hit entirely. Costs stamina, scales with the attacker's
 *            accuracy, and is capped so it can never reach certainty.
 *   BLOCK -- convert the hit into a partial one. Free, no stamina, but scales with
 *            the defender's shield and leaves the attacker inside their own reach.
 *
 * WHY DODGE IS CAPPED AT ALL
 *
 * The temptation is a flat percentage. A flat 20% is too strong against a swarm and
 * too weak against a single boss, because it does not care how fast attacks arrive.
 * The cap is the important part: energy drains faster than it regenerates, so a player
 * who dodges everything quickly runs dry and then cannot dodge at all. That is what
 * makes dodge a decision rather than a stat, and it is the property that stops the
 * mechanic from trivialising the game at low mob density.
 *
 * WHY BLOCK IS NOT FREE ARMOUR
 *
 * A flat reduction with no cost is strictly better than armour, because it applies to
 * every source. So block is bounded by the shield's own defence value and is refused
 * outright with no shield -- a player with nothing in the shield slot gets told so
 * rather than silently blocking at zero.
 *
 * Context is passed in rather than imported, for the reason given in social.js.
 */

/**
 * Both mechanics, resolved together.
 *
 * One entry point rather than two, because the caller has to make a single decision
 * ("what happens to this attack") and having it call dodge() and then block() would
 * let both fire on the same hit, which is the bug this shape prevents.
 *
 * @param {object} ctx
 * @param {object} ctx.attacker  the mob, for its accuracy stat
 * @param {object} ctx.defender  the player being hit
 * @param {number} ctx.rawDamage  damage before any mitigation
 * @param {number} ctx.defense    armour total, already summed by the caller
 * @param {() => number} ctx.random  injectable, so every branch is testable
 * @returns {{damage:number, dodged:boolean, blocked:boolean, staminaSpent:number}}
 */
function resolveIncoming({ attacker, defender, rawDamage, defense = 0, random = Math.random }) {
    // --- dodge ---------------------------------------------------------------
    let staminaSpent = 0;
    if (defender.dodgeReadyAt && Date.now() < defender.dodgeReadyAt) {
        // Still recovering from the last dodge. Not an error -- just unavailable,
        // and the attack lands normally.
    } else if ((defender.stamina || 0) >= DODGE_STAMINA_COST) {
        // Higher-tier attackers are harder to dodge. A boss that could be dodged as
        // easily as a spider would make the whole mechanic cosmetic at the point where
        // it matters most.
        const dodgeChance = Math.max(0, DODGE_BASE_CHANCE - (attacker.dodgePenalty || 0));
        if (random() < dodgeChance) {
            defender.stamina -= DODGE_STAMINA_COST;
            staminaSpent = DODGE_STAMINA_COST;
            defender.dodgeReadyAt = Date.now() + DODGE_RECOVERY_MS;
            return { damage: 0, dodged: true, blocked: false, staminaSpent };
        }
        // A failed dodge still costs. Not charging for it would make the optimal
        // strategy "attempt a dodge on every single attack", which removes the
        // decision entirely.
        defender.stamina -= DODGE_STAMINA_COST;
        staminaSpent = DODGE_STAMINA_COST;
        defender.dodgeReadyAt = Date.now() + DODGE_RECOVERY_MS;
    }

    // --- block ---------------------------------------------------------------
    let damage = Math.max(1, rawDamage - defense);
    let blocked = false;
    if (defender.blocking) {
        const shield = defender.equipment && defender.equipment.shield;
        const shieldDef = shield && ITEMS.shields[shield] ? ITEMS.shields[shield].def : 0;
        if (shieldDef > 0) {
            // Half the shield's defence, capped. Not a percentage of the incoming
            // hit, because that would make a weak shield against a boss swing
            // irrelevant while still costing the player their stance.
            const reduction = Math.min(shieldDef * BLOCK_SHIELD_FACTOR, damage - 1);
            if (reduction > 0) {
                damage -= reduction;
                blocked = true;
            }
        }
    }

    return { damage, dodged: false, blocked, staminaSpent };
}

/**
 * Whether a player may start blocking right now.
 *
 * Refused while stunned, for the same reason mounting is: a stance that cannot be
 * interrupted is a stance that trivialises the fight it is supposed to shape.
 */
function canBlock(player, now = Date.now()) {
    if (player.stunUntil > now) return false;
    const shield = player.equipment && player.equipment.shield;
    return !!(shield && ITEMS.shields[shield]);
}

// --- tuning -----------------------------------------------------------------
// All in one place so a balance pass touches one file rather than hunting numbers
// through the damage path.

const DODGE_BASE_CHANCE = 0.25;
const DODGE_STAMINA_COST = 12;
const DODGE_RECOVERY_MS = 700;
const DODGE_STAMINA_REGEN_PER_SEC = 8;
const BLOCK_SHIELD_FACTOR = 0.5;
const STAMINA_MAX = 100;

/**
 * Whether a player has enough stamina to attempt a dodge at all.
 *
 * Separate from the roll on purpose. A player who is out of stamina gets told so,
 * because a silently-ignored dodge input is indistinguishable from a broken key.
 */
function canDodge(player) {
    return (player.stamina || 0) >= DODGE_STAMINA_COST;
}

/**
 * Ticks stamina regeneration. Called from the game loop, not from the damage path --
 * regen must continue while nothing is being hit, or stamina would only ever come
 * back during a fight and the mechanic would be unusable outside one.
 */
function regenStamina(player, elapsedMs) {
    const before = player.stamina || 0;
    player.stamina = Math.min(STAMINA_MAX, before + (DODGE_STAMINA_REGEN_PER_SEC * (elapsedMs / 1000)));
    return player.stamina - before;
}

const ITEMS = require('./items');

module.exports = {
    resolveIncoming,
    canBlock,
    canDodge,
    regenStamina,
    STAMINA_MAX,
    DODGE_BASE_CHANCE,
    DODGE_STAMINA_COST,
    DODGE_RECOVERY_MS,
    DODGE_STAMINA_REGEN_PER_SEC,
    BLOCK_SHIELD_FACTOR,
    STAMINA_MAX
};