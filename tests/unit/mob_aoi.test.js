/*
 * tests/unit/mob_aoi.test.js
 *
 * Area of interest for the mob roster (roadmap 7.2, mobs).
 *
 * The single most important test here is the aggro one. Players have it too: a mob
 * that starts attacking a player the player cannot see is being attacked by an
 * invisible monster, which is worse than the bandwidth the whole feature saves. It
 * is prevented by keeping MOB_AOI_RADIUS above the distance at which mobs decide to
 * engage. That is a relationship between two numbers in two files, and nothing about
 * it is enforced by the code -- lowering either one silently produces the bug. So it
 * is asserted here, by reading both numbers out of their sources.
 *
 * The second thing worth pinning is that the feature ships OFF. Mob removal needs a
 * `mob_forget` handler in the client, and until that line exists the removal path
 * would leave every client holding a frozen ghost of every mob it had passed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AOI = require('../../server/aoi');
const CFG = require('../../server/config');
const MAP = require('../../server/map');

const ROOT = path.join(__dirname, '..', '..');
const SERVER_JS = path.join(ROOT, 'server', 'server.js');
const BOSSES_JS = path.join(ROOT, 'server', 'bosses.js');
const ENGINE_JS = path.join(ROOT, 'client', 'js', 'engine.js');
const RENDERER_JS = path.join(ROOT, 'client', 'js', 'renderer.js');

const read = (p) => fs.readFileSync(p, 'utf8');

/** Mobs are drawn by the same camera as players, so they take the same radius rule. */
test('the mob radius uses the same square test the minimap does', () => {
    // canSee is Chebyshev because the minimap filter is Chebyshev. A circle here
    // would hide a mob the minimap still draws a dot for.
    const viewer = { x: 0, y: 0 };
    assert.strictEqual(AOI.canSee(viewer, 900, 900, 1000), true,
        'a mob at (900,900) is inside the minimap radius and must stay visible');
    assert.strictEqual(AOI.canSee(viewer, 1000, 0, 1000), true,
        'the boundary is inclusive, matching the minimap filter');
    assert.strictEqual(AOI.canSee(viewer, 1001, 0, 1000), false);
    assert.strictEqual(AOI.canSee(viewer, 0, -1001, 1000), false);
});

test('a radius of zero or less disables mob filtering entirely', () => {
    const viewer = { x: 0, y: 0 };
    for (const r of [0, -1, undefined]) {
        assert.strictEqual(AOI.canSee(viewer, 999999, 999999, r), true,
            `radius ${r} must mean no filtering`);
    }
});

// --- the safety invariant ----------------------------------------------------

test('the mob radius stays above the distance at which mobs engage', () => {
    const server = read(SERVER_JS);
    const bosses = read(BOSSES_JS);

    const aggro = server.match(/const\s+AGGRO_RANGE\s*=\s*(\d+)/);
    assert.ok(aggro, 'server.js must declare AGGRO_RANGE; this test is what keeps it meaningful');
    const bossAggro = bosses.match(/const\s+aggroRange\s*=\s*(\d+)/);
    assert.ok(bossAggro, 'bosses.js must declare aggroRange');

    const radius = CFG.MOB_AOI_RADIUS;
    /*
     * The invariant is checked against the radius that WOULD be used if the feature
     * were switched on, not only against the current value.
     *
     * The shipped default is 0, so an earlier version of this test returned early
     * whenever the feature was off -- and therefore checked nothing at all in the
     * state the game actually ships in. A mutation that widened AGGRO_RANGE to 4000
     * survived, because the branch that would have noticed never ran. The number that
     * matters is the one in the config comment, so that is the one tested.
     */
    const effective = radius > 0 ? radius : CFG.AOI_RADIUS;

    assert.ok(effective > Number(aggro[1]),
        `an enabled MOB_AOI_RADIUS of ${effective} must exceed AGGRO_RANGE ${aggro[1]}. ` +
        'Below it a mob can start hitting a player who cannot see it.');
    assert.ok(effective > Number(bossAggro[1]),
        `an enabled MOB_AOI_RADIUS of ${effective} must exceed the boss aggro range ` +
        `${bossAggro[1]}. A boss that engages from outside the visible radius is the ` +
        'same bug, larger.');
    assert.ok(effective >= CFG.MELEE_RANGE,
        `MOB_AOI_RADIUS ${effective} must at least cover melee range ${CFG.MELEE_RANGE}, ` +
        'or a player cannot see the mob they are being hit by.');

    if (radius <= 0) {
        assert.strictEqual(radius, 0, 'the shipped default must be off');
    }
});

test('the mob radius never exceeds the distance at which anything can reach you', () => {
    // The other direction. A radius larger than the whole map is not an optimisation,
    // it is a setting that looks like it does something.
    if (CFG.MOB_AOI_RADIUS > 0) {
        assert.ok(CFG.MOB_AOI_RADIUS < Math.max(CFG.MAP_WIDTH, CFG.MAP_HEIGHT),
            'a radius bigger than the map filters nothing');
    }
});

// --- membership tracking -----------------------------------------------------

test('the first reconciliation reports everything in range as entered', () => {
    const roster = [{ id: 'm1' }, { id: 'm2' }];
    const { entered, left } = AOI.membershipChange(null, roster);
    assert.deepStrictEqual(entered.map(e => e.id), ['m1', 'm2']);
    assert.deepStrictEqual(left, [], 'nothing can have left if nothing was sent before');
});

test('an unchanged set reports no movement in either direction', () => {
    const before = new Set(['m1', 'm2']);
    const roster = [{ id: 'm1' }, { id: 'm2' }];
    const { entered, left } = AOI.membershipChange(before, roster);
    assert.deepStrictEqual(entered, []);
    assert.deepStrictEqual(left, [],
        'this is the case that makes the tick cheap: a player standing still among ' +
        'mobs must produce no traffic at all');
});

test('a mob that comes into range is entered and one that leaves is reported', () => {
    const before = new Set(['stays', 'leaves']);
    const roster = [{ id: 'stays' }, { id: 'arrives' }];
    const { entered, left } = AOI.membershipChange(before, roster);
    assert.deepStrictEqual(entered.map(e => e.id), ['arrives']);
    assert.deepStrictEqual(left, ['leaves']);
});

test('membershipChange accepts an array as well as a Set', () => {
    // The stored value is a Set, but the pre-AoI login path seeds nothing at all, and
    // a caller should not have to know which of the two it is holding.
    const { entered, left } = AOI.membershipChange(['m1'], [{ id: 'm1' }, { id: 'm2' }]);
    assert.deepStrictEqual(entered.map(e => e.id), ['m2']);
    assert.deepStrictEqual(left, []);
});

test('an empty range reports everything previously known as left', () => {
    const { entered, left } = AOI.membershipChange(new Set(['m1', 'm2', 'm3']), []);
    assert.deepStrictEqual(entered, []);
    assert.deepStrictEqual(left.sort(), ['m1', 'm2', 'm3']);
});

// --- the wiring --------------------------------------------------------------

test('mob filtering is gated behind MOB_AOI_RADIUS, not AOI_RADIUS', () => {
    // Two features that can be rolled back independently. A player who cannot see a
    // peer is a social problem; a mob that cannot be seen is an invisible-attacker
    // problem. They must not share a switch.
    const src = read(SERVER_JS);
    const mobScopes = src.slice(src.indexOf('const mobAoiSets'), src.indexOf('function recalcPlayerStats'));
    assert.ok(!/CFG\.AOI_RADIUS/.test(mobScopes),
        'the mob scope must not read the player radius');
    assert.ok(/CFG\.MOB_AOI_RADIUS/.test(mobScopes));
});

test('the floor roster filters mobs, and still sends every boss', () => {
    const src = read(SERVER_JS);
    const fn = src.slice(src.indexOf('function syncFloorRoster'), src.indexOf('// Moves a player between floors'));
    assert.ok(/canSeeMob/.test(fn), 'the login roster must filter mobs');
    // Bosses are three types with one lair each, so filtering them saves nothing, and
    // a boss you cannot see is the thing a player most wants warning about.
    const bossLoop = fn.slice(fn.indexOf('bosses.forEach'));
    assert.ok(!/canSeeMob\(boss\)/.test(bossLoop), 'bosses are deliberately not filtered');
    assert.match(bossLoop, /MAP\.normalizeZ\(boss\.z\) === pz/);
});

test('the per-move broadcast is scoped, and the plain floor broadcast survives', () => {
    const src = read(SERVER_JS);
    assert.ok(/broadcastToFloorNear\(mob\.z, \{ action: 'mob_update'/.test(src),
        'a mob taking a step must only be sent to players who can see where it went');
    const fn = src.slice(src.indexOf('function broadcastToFloorNear'), src.indexOf('function reconcileMobVisibility'));
    assert.ok(/if \(radius <= 0\) \{ broadcastToFloor\(z, packet\); return; \}/.test(fn),
        'with the radius at 0 this must be exactly broadcastToFloor');
    // Both conditions, in one body. Dropping the floor check means a mob moving on
    // z=-2 is announced to a player on z=0, at coordinates that mean nothing there.
    assert.ok(/if \(MAP\.normalizeZ\(p\.z\) !== floor\) return;/.test(fn),
        'the scoped send must still reject players on other floors');
    assert.ok(/AOI\.canSee\(p, x, y, radius\)/.test(fn));
});

test('reconciliation is gated on the radius, not merely called', () => {
    // Being called is not the same as running. `if (radius < 0) return` leaves the
    // call site intact and the feature completely inert.
    const src = read(SERVER_JS);
    const fn = src.slice(src.indexOf('function reconcileMobVisibility'), src.indexOf('function dropMobAoiSet'));
    assert.ok(/const radius = CFG\.MOB_AOI_RADIUS;\s*if \(radius <= 0\) return;/.test(fn),
        'reconciliation must return early when the radius is 0');
});

test('the known set is written back after every change', () => {
    // Without this the set is never advanced, so every mob is reported as newly
    // entered on every tick: the feature costs more than it saves and the client is
    // sent the same roster five times a second.
    const src = read(SERVER_JS);
    const fn = src.slice(src.indexOf('function reconcileMobVisibility'), src.indexOf('function dropMobAoiSet'));
    assert.ok(/mobAoiSets\.set\(pid, new Set\(inRange\.map/.test(fn),
        'the stored set must be replaced after a change, or nothing is ever remembered');
    assert.ok(/if \(entered\.length \|\| left\.length\)/.test(fn),
        'the write must be conditional, so a still player generates no traffic');
});

test('the reconciliation set is keyed by player id and not stored on the player object', () => {
    // The player object is serialised on every save. A Set hung off it is not part of
    // the saved shape, so whether it survived a reload would depend on how
    // serializePlayer happened to be written that day.
    const src = read(SERVER_JS);
    assert.ok(/const mobAoiSets = new Map\(\);/.test(src),
        'the reconciliation set must be a separate map, not a field on the player');
    assert.ok(!/\w+\.aoiMobs\s*=/.test(src),
        'no assignment onto a player named aoiMobs may exist');
});

test('the test-only spawn is announced through the scoped sender, on the caller floor', () => {
    // Found by tests/bots/mob_aoi_probe.js, not by inspection: the spawn action was
    // handed the global `broadcast`, so a mob spawned 2500px away arrived anyway,
    // and a surface mob was announced to players standing in the crypt.
    const server = read(SERVER_JS);
    const testing = read(path.join(ROOT, 'server', 'testing.js'));

    assert.ok(/spawnBroadcast: \(packet\) => sendMobEvent\(player\.z, packet\),/.test(server),
        'the test context must hand the spawn a floor- and radius-scoped sender, ' +
        'not the global broadcast');
    assert.ok(/const id = spawnMobAt\(x, y, type, spawnBroadcast, floor\);/.test(testing),
        'the spawn must be announced via spawnBroadcast on the caller\'s floor');
    assert.ok(/isWalkable\(x, y, floor\)/.test(testing),
        'the spawn must be validated against the caller floor, or a dungeon player ' +
        'has a mob validated against the city and placed in the city');
    assert.ok(!/\n\s*const id = spawnMobAt\([^)]*broadcast\)/.test(testing),
        'no spawn may be handed the unscoped broadcast');
});

test('sendMobEvent takes its position from the packet, not from a caller argument', () => {
    // Two coordinates that can disagree is how a mob gets announced at one position
    // and scoped to another.
    const src = read(SERVER_JS);
    assert.ok(/function sendMobEvent\(z, packet\) \{\s*broadcastToFloorNear\(z, packet, packet\.x, packet\.y\);/.test(src),
        'sendMobEvent must derive x/y from the packet');
});

test('reconciliation runs on the periodic tick, not only at login', () => {
    // Mobs are sent once at spawn and then only on movement or damage. Without a
    // recurring check, a mob that was out of range when a player arrived would never
    // appear however long the player stood beside it.
    const src = read(SERVER_JS);
    const call = src.indexOf('reconcileMobVisibility();');
    assert.ok(call !== -1, 'reconcileMobVisibility must be called');
    const afterTick = src.lastIndexOf('scheduleServerInterval', call);
    assert.ok(afterTick !== -1 && afterTick < call,
        'reconciliation must be inside a scheduled interval, not in the login path');
    assert.ok(src.indexOf('reconcileMobVisibility', afterTick) > afterTick,
        'the scheduled call must come after the interval is opened');
});

test('the mob set is keyed by player id and not stored on the player object', () => {
    // The player object is serialised on every save. A Set hung off it is not part of
    // the saved shape, so whether it survived a reload would depend on how
    // serializePlayer happened to be written that day.
    const src = read(SERVER_JS);
    assert.ok(/const mobAoiSets = new Map\(\);/.test(src),
        'the reconciliation set must be a separate map, not a field on the player');
    assert.ok(!/\n\s*\w+\.aoiMobs\s*=/.test(src),
        'no field named aoiMobs may be assigned onto a player');
});

test('a disconnecting player has their mob set freed', () => {
    const src = read(SERVER_JS);
    // Anchored on both ends rather than a fixed character count. The first version
    // looked at the 200 bytes after players.delete() and missed the call, because
    // the four-line comment explaining why it is there is longer than that.
    const at = src.indexOf('players.delete(playerId)');
    assert.notStrictEqual(at, -1, 'the disconnect path must delete the player');
    const segment = src.slice(at, src.indexOf('player_left', at));
    assert.ok(/dropMobAoiSet\(playerId\)/.test(segment),
        'otherwise the map grows by one entry per connection for the life of the process');
    assert.ok(/function dropMobAoiSet\(playerId\) \{\s*mobAoiSets\.delete\(playerId\);/.test(src));
});

test('leaving the radius uses mob_forget, not a death', () => {
    // The existing way to drop a mob from the client cache is mob_update with
    // alive:false -- which also means "died", and which now spawns a blood-burst
    // particle effect. Reusing it here would burst blood every time a player turned
    // away from a mob.
    const src = read(SERVER_JS);
    const fn = src.slice(src.indexOf('function reconcileMobVisibility'), src.indexOf('function dropMobAoiSet'));
    assert.ok(/action: 'mob_forget'/.test(fn), 'removal must use its own packet');
    const forgetLoop = fn.slice(fn.indexOf('for (const id of left)'));
    assert.ok(!/alive/.test(forgetLoop),
        'the removal loop must not send alive:false; that means death to the client');
    // And the announcement side must stay on the ordinary packet, so the client needs
    // no new handler at all to see a mob.
    assert.ok(/action: 'mob_update'/.test(fn), 'entering range reuses mob_update');
    assert.ok(fn.indexOf('action: \'mob_update\'') < fn.indexOf('action: \'mob_forget\''),
        'seeing a mob must not require the new packet -- only leaving may');
});

test('mob AoI is enabled only while the client can forget a mob', () => {
    // An assertion that the two halves agree, not that either is correct alone.
    //
    // This gate has already fired once in the direction that matters. The handler was
    // added, the default was flipped to 1000, and then a later frontend rewrite of the
    // packet handler removed it -- leaving the feature enabled with no way for a client
    // to drop a mob that walked away, which is a ghost per mob per client, with nothing
    // in any log. Enabling it without checking here would have shipped that.
    //
    // So: the client can forget a mob, or the radius is off. Both false, or both true.
    const engine = read(ENGINE_JS);
    const clientHandlesForget = /action\s*===?\s*["']mob_forget["']/.test(engine);
    assert.strictEqual(clientHandlesForget, CFG.MOB_AOI_RADIUS > 0,
        `client handles mob_forget: ${clientHandlesForget}, MOB_AOI_RADIUS: ${CFG.MOB_AOI_RADIUS}. ` +
        'Enable one without the other and either clients accumulate frozen ghost mobs ' +
        '(handler missing) or the optimisation is silently inert (default left at 0).');

    if (clientHandlesForget) {
        // The stronger half when it is on: the handler must actually delete the mob,
        // and must not reuse the death branch -- which is the blood-burst path this
        // packet exists to avoid.
        const at = engine.indexOf('"mob_forget"');
        const branch = engine.slice(at, at + 240);
        assert.match(branch, /delete mobs\[data\.id\]/,
            'mob_forget must remove the mob from the client cache, or every mob a ' +
            'player walks past stays on their screen forever');
        assert.ok(!/alive\s*:\s*false/.test(branch),
            'mob_forget must not be routed through the death branch');

        // And the HUD must stop showing it. Removing the mob from the cache while
        // leaving it selected means the target panel keeps a name, a health bar and a
        // distance for something the server has stopped sending -- a mob that walks out
        // of range stays on screen as a ghost, precisely because the panel is separate
        // state from the roster.
        //
        // This was reported as a gap and left unfixed for a while. A mutation for it
        // survived the first time it was added, because no assertion covered it -- which
        // is the whole point: "reported" and "pinned" are not the same thing, and only
        // one of them stops it coming back.
        assert.match(branch, /currentTargetId\s*===\s*data\.id/,
            'forgetting a mob must also clear it as the selected target, or the HUD ' +
            'keeps displaying a mob the server has stopped sending');
    }
});
