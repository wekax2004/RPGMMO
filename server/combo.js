/*
 * server/combo.js
 *
 * Roadmap 5.1: the combo system.
 *
 * THE GAP
 *
 * `client/test_client.html` has carried a combo meter for a while -- a `triggerCombo`
 * function, a `#combo-container` element and a fade-out timer. Nothing has ever called
 * it. The UI is finished and the thing that drives it does not exist, so a player who
 * lands three spells in a row sees three floating numbers and nothing else.
 *
 * WHAT A COMBO IS HERE, PRECISELY
 *
 * Consecutive damaging actions on the SAME target inside a time window. That last
 * clause is where almost every wrong version of this feature lives:
 *
 *   - Not consecutive casts. Two spells at two different mobs are two fights, and
 *     counting them as a combo rewards target-switching, which is the opposite of what
 *     a combo is for.
 *   - Not consecutive hits taken. A player being hit five times in a row is not
 *     landing a combo.
 *   - Not a chain that survives anything. The counter resets on target change, on
 *     expiry, and on death of the target -- because a combo against something dead is
 *     not a combo.
 *
 * WHY THE CLIENT OWNS THE TIMER
 *
 * The counter itself lives here and is authoritative, but the display window is the
 * client's: it already has a fade-out timer, and a server-side one would need
 * per-tick bookkeeping and a cancel packet for every combo that ended. So the server
 * sends the current count on each increment and lets the client decide how long to
 * show it. That is also what makes the meter feel right -- the client can extend the
 * display without the server knowing or caring.
 *
 * The consequence, which is a real limitation rather than a convenience: the server
 * cannot retract a combo it has already announced. If the player switches target
 * between two hits, the meter will have shown `3x` before the reset lands. This is
 * noted in ROADMAP.md because it is the kind of thing that reads as a bug when it is
 * a deliberate trade.
 */

const COMBO_WINDOW_MS = 4000;
const COMBO_MIN_TO_ANNOUNCE = 2;

/**
 * Registers a damaging action against a target and returns the new count, or 0 if
 * there is no combo.
 *
 * Mutates only `player.combo`. Returns a small result object rather than the count
 * alone, so the caller can tell "combo ended" from "combo is at 1" -- both of which
 * are 0 hits but need different handling.
 *
 * @param {object} player
 * @param {string} targetId  '' or null for a non-targeted action (an AoE tick)
 * @param {number} now       injectable for tests
 * @returns {{hits:number, advanced:boolean, reset:boolean, broke:boolean}}
 */
function registerHit(player, targetId, now = Date.now()) {
    const c = player.combo;
    if (!c) return { hits: 0, advanced: false, reset: false, broke: false };

    // Not a combo-relevant action: an untargeted AoE tick damages whatever is in
    // range, so attributing it to a combo would let the player build a chain by
    // standing in a crowd and casting.
    if (!targetId) {
        resetCombo(player);
        return { hits: 0, advanced: false, reset: false, broke: false };
    }

    // Switching target breaks the chain. Reported as `broke` so the caller can tell
    // it apart from an expiry.
    if (c.targetId !== targetId) {
        const wasGoing = c.hits > 0;
        c.targetId = targetId;
        c.hits = 1;
        c.lastHitAt = now;
        return { hits: 1, advanced: false, reset: true, broke: wasGoing };
    }

    // Expired. Treated as a break rather than a continuation, so the count restarts
    // at one instead of resuming a chain the player had clearly lost track of.
    if (now - c.lastHitAt > COMBO_WINDOW_MS) {
        c.hits = 1;
        c.lastHitAt = now;
        return { hits: 1, advanced: false, reset: true, broke: true };
    }

    c.hits++;
    c.lastHitAt = now;
    return { hits: c.hits, advanced: c.hits >= COMBO_MIN_TO_ANNOUNCE, reset: false, broke: false };
}

function resetCombo(player) {
    if (!player.combo) return;
    player.combo.hits = 0;
    player.combo.targetId = null;
    player.combo.lastHitAt = 0;
}

/** The combo as it should be displayed, or null when there is nothing to show. */
function describe(player) {
    const c = player.combo;
    if (!c || c.hits < COMBO_MIN_TO_ANNOUNCE || !c.targetId) return null;
    return { hits: c.hits, targetId: c.targetId, lastHitAt: c.lastHitAt };
}

/**
 * Builds the player's combo state. Called from the login constructor, because a field
 * missing there is `undefined` at runtime no matter what a normaliser returns -- and
 * `undefined.hits` throws on the first hit rather than failing visibly at login.
 */
function initialCombo() {
    return { hits: 0, targetId: null, lastHitAt: 0 };
}

module.exports = {
    registerHit,
    resetCombo,
    describe,
    initialCombo,
    COMBO_WINDOW_MS,
    COMBO_MIN_TO_ANNOUNCE
};