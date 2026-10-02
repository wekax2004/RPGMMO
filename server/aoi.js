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
 * The players `viewer` should be sent.
 *
 * A viewer is always included, even though its own distance from itself is zero
 * and it would qualify anyway: including it explicitly means the rule reads as
 * "everyone nearby, plus you" rather than relying on the reader to notice that
 * |x - x| is 0. It also keeps the self-inclusion correct if a future caller
 * passes a negative radius alongside a viewer, where the disabled path returns
 * the roster unchanged.
 *
 * @param {object} viewer          a roster entry (needs id, x, y)
 * @param {Array<object>} roster   every entry on the viewer's floor
 * @param {number} radius          in world pixels; <= 0 disables filtering
 * @returns {Array<object>}        the subset to send, in roster order
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

module.exports = { visibleTo, buildRosters, measure, AOI_RADIUS_DISABLED: 0 };
