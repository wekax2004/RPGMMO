/*
 * server/aoi.js
 *
 * Area of interest for the player roster (roadmap 7.2).
 *
 * The problem. Every client used to be sent every player on its floor, five times a
 * second. With 50 players on one floor that is 50 entries per client per tick and
 * 12,500 player-updates a second across the shard, none of which most of them can
 * see: the camera is 640x480, so the furthest visible point is about 400px away
 * and the rest is off-screen by construction.
 *
 * The fix. Each client is sent only the players within a radius of itself.
 *
 * Why no removal packet was needed. The client already treats players_sync as
 * authoritative and complete -- engine.js:
 *
 *     for (let id in otherPlayers) { if (!newIds.includes(id)) delete otherPlayers[id]; }
 *
 * so a peer that walks out of range is simply absent from the next list and gets
 * dropped. That is the whole client-side contract, which is why this is a change
 * to what gets sent rather than a new packet type with its own edge cases.
 *
 * Why a square and not a circle. The minimap filters other players like this
 * (renderer.js:751):
 *
 *     if (Math.abs(op.x - player.x) > MINIMAP_RADIUS || ...) continue;
 *
 * That is Chebyshev distance, not Euclidean. A circular radius of 1000 would
 * exclude a player at (900,900), who is 1270px away -- a player the minimap still
 * draws. They would appear on the minimap and nowhere else in the world, which is
 * worse than the problem being solved. Matching the minimap's own test makes the
 * two views agree by construction instead of by luck.
 */

/**
 * The entries `viewer` should be sent, from any roster.
 *
 * Same square test and the same self-inclusion rule as the player roster, because
 * mobs must agree with players for the same reason: both are drawn by the same
 * camera and filtered by the same minimap radius, so anything one of them hides is
 * something the player was never going to see anyway.
 *
 * A mob is not in its own roster, so self-inclusion never fires for one. It is kept
 * because this function is now used for both kinds and the rule should not depend
 * on which kind it was handed.
 *
 * @param {object} viewer       a roster entry or a player (needs id, x, y)
 * @param {Array<object>} roster every entry on the viewer's floor
 * @param {number} radius       in world pixels; <= 0 disables filtering
 */
function visibleTo(viewer, roster, radius) {
    // Disabled. Return the array itself rather than a copy: the caller only ever
    // serialises it, and copying N entries per viewer per tick is the allocation
    // cost this whole module exists to avoid.
    if (!(radius > 0)) return roster;
    return roster.filter(other =>
        other.id === viewer.id ||
        (Math.abs(other.x - viewer.x) <= radius && Math.abs(other.y - viewer.y) <= radius));
}

/**
 * Whether `viewer` can see something at (x, y), on the radius rule above.
 *
 * For sending a single event to whoever should receive it -- a mob taking a step, a
 * floating damage number -- rather than for building a roster. Building a roster
 * with visibleTo and sending the whole thing is cheaper when there are many
 * candidates; this is for the one-off.
 */
function canSee(viewer, x, y, radius) {
    if (!(radius > 0)) return true;
    return Math.abs(viewer.x - x) <= radius && Math.abs(viewer.y - y) <= radius;
}

/**
 * Which ids changed between what a viewer was last sent and what it should be sent.
 *
 * The mob side needs this because -- unlike players -- there is no periodic mob
 * sync the client reconciles against. Players are re-told the full roster every
 * 200ms and the client drops anyone absent. Mobs are sent once at spawn and
 * afterwards only when they move or take damage, so a mob that was out of range
 * when a player arrived would stay invisible for good, however long the player
 * stood next to it. Something has to notice the crossing, and this is it.
 *
 * @param {Set|Array|null} previous  ids last sent
 * @param {Array<object>} current    the roster entries that should be sent now
 * @returns {{entered: Array<object>, left: *[]}}
 */
function membershipChange(previous, current) {
    const before = previous instanceof Set ? previous : new Set(previous || []);
    const now = new Set(current.map(e => e.id));
    const entered = current.filter(e => !before.has(e.id));
    const left = [];
    for (const id of before) {
        if (!now.has(id)) left.push(id);
    }
    return { entered, left };
}

/**
 * Every viewer's subset, keyed by viewer id.
 *
 * Kept as a map rather than sent inline so a caller can assert on the shape --
 * that each viewer gets a list containing itself, that no viewer gets someone
 * outside the radius -- without opening a socket.
 *
 * @param {Array<object>} roster
 * @param {number} radius
 * @returns {Map<*, Array<object>>}
 */
function buildRosters(roster, radius) {
    const out = new Map();
    for (const viewer of roster) out.set(viewer.id, visibleTo(viewer, roster, radius));
    return out;
}

/**
 * How much the AoI actually saved, as a fraction of the payload a full floor-wide
 * sync would have carried.
 *
 * The pre-AoI cost is n^2: every one of n players was sent all n entries. With
 * filtering it is `sent`, the total across every viewer's subset. So the fraction
 * is sent / n^2, which is 1 when everyone can see everyone (nothing saved) and
 * approaches 1/n when nobody can see anybody (the best case).
 *
 * Dividing by n rather than n^2 was the first attempt, and it reported 10 for a
 * tight cluster of 10 -- a number that reads as "ten times worse" in the case
 * where AoI saved nothing. A metric that reports the opposite of what it measures
 * is worse than no metric.
 *
 * Only used by tests and the bandwidth probe. It is here rather than inlined so
 * the "did this actually reduce anything" question has one answer, defined once.
 *
 * @returns {{floor: number, sent: number, ratio: number}}
 */
function measure(roster, radius) {
    const rosters = buildRosters(roster, radius);
    let sent = 0;
    for (const list of rosters.values()) sent += list.length;
    const n = roster.length;
    return {
        floor: n,
        sent,
        ratio: n === 0 ? 1 : sent / (n * n)
    };
}

module.exports = {
    visibleTo, buildRosters, measure, canSee, membershipChange,
    AOI_RADIUS_DISABLED: 0
};
