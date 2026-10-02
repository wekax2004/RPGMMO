/*
 * tests/unit/aoi.test.js
 *
 * Area of interest for the player roster (roadmap 7.2).
 *
 * Two kinds of test here, and the second kind is the more important one.
 *
 * The behavioural tests pin what the selection returns. The corner case gets its
 * own test because it is the decision the module exists to make: a peer at
 * (900,900) with a radius of 1000 is 1270px away by Euclidean distance and would
 * be dropped by a circular radius -- but the minimap draws them, because the
 * minimap's own filter is a square test. Using a circle would produce a player
 * who is visible on the minimap and nowhere else in the world, which is a worse
 * bug than the bandwidth problem being solved.
 *
 * The source-level tests pin the wiring. A selection function that is correct but
 * never called looks identical to one that is called, from inside this file. The
 * same is true in reverse: the client-side contract that makes AoI work at all is
 * a single line in engine.js, and if that line is ever "optimised" away there is
 * no server-side error, no exception, and no failing test anywhere -- players
 * would simply accumulate as ghosts on every client. That line is asserted here so
 * removing it breaks a build.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AOI = require('../../server/aoi');
const CFG = require('../../server/config');

const SERVER_JS = path.join(__dirname, '..', '..', 'server', 'server.js');
const ENGINE_JS = path.join(__dirname, '..', '..', 'client', 'js', 'engine.js');
const RENDERER_JS = path.join(__dirname, '..', '..', 'client', 'js', 'renderer.js');

const R = 1000;

const entry = (id, x, y) => ({ id, x, y });
const ids = (list) => list.map(e => e.id).sort();

// --- What the selection returns ----------------------------------------------

test('a viewer is always sent themselves', () => {
    const roster = [entry('a', 5000, 5000), entry('b', 0, 0)];
    assert.deepStrictEqual(ids(AOI.visibleTo(roster[0], roster, R)), ['a'],
        'a player far from everything must still receive their own entry');
});

test('a peer inside the radius on both axes is sent', () => {
    const roster = [entry('a', 0, 0), entry('b', 500, -400), entry('c', 4000, 0)];
    assert.deepStrictEqual(ids(AOI.visibleTo(roster[0], roster, R)), ['a', 'b']);
});

test('a peer outside the radius on x is not sent', () => {
    const roster = [entry('a', 0, 0), entry('b', R + 32, 0)];
    assert.deepStrictEqual(ids(AOI.visibleTo(roster[0], roster, R)), ['a']);
});

test('a peer outside the radius on y is not sent', () => {
    const roster = [entry('a', 0, 0), entry('b', 0, R + 32)];
    assert.deepStrictEqual(ids(AOI.visibleTo(roster[0], roster, R)), ['a']);
});

test('the corner case is included, because the minimap draws it', () => {
    // 1270px away by Euclidean distance. A circle of radius 1000 excludes it; the
    // minimap's square test includes it. This test exists so nobody "fixes" the
    // filter into a circle and breaks the agreement between the two views without
    // any other test noticing.
    const roster = [entry('a', 0, 0), entry('b', 900, 900)];
    assert.deepStrictEqual(ids(AOI.visibleTo(roster[0], roster, R)), ['a', 'b'],
        'a peer inside the square must be sent, even when outside the circle');
});

test('the radius is inclusive at the boundary and exclusive one tile past it', () => {
    const onEdge = [entry('a', 0, 0), entry('b', R, 0)];
    const onePast = [entry('a', 0, 0), entry('b', R + 1, 0)];
    assert.deepStrictEqual(ids(AOI.visibleTo(onEdge[0], onEdge, R)), ['a', 'b'],
        'a peer exactly at the radius must be sent');
    assert.deepStrictEqual(ids(AOI.visibleTo(onePast[0], onePast, R)), ['a'],
        'a peer one pixel past the radius must not be sent');
});

test('radius zero or negative disables filtering and sends the whole floor', () => {
    const roster = [entry('a', 0, 0), entry('b', 9000, 9000), entry('c', -4000, 2000)];
    for (const r of [0, -1, undefined, null]) {
        assert.deepStrictEqual(ids(AOI.visibleTo(roster[0], roster, r)), ['a', 'b', 'c'],
            `radius ${r} must send the entire floor`);
    }
});

test('the disabled path returns the roster itself, not a copy', () => {
    const roster = [entry('a', 0, 0), entry('b', 9000, 9000)];
    assert.strictEqual(AOI.visibleTo(roster[0], roster, 0), roster,
        'with filtering off there is nothing to copy, and copying per viewer per ' +
        'tick is the allocation cost this module exists to avoid');
});

test('buildRosters keys every viewer and gives each its own subset', () => {
    const roster = [entry('a', 0, 0), entry('b', 200, 0), entry('c', 5000, 0)];
    const rosters = AOI.buildRosters(roster, R);
    assert.strictEqual(rosters.size, 3, 'every viewer needs an entry');
    assert.deepStrictEqual(ids(rosters.get('a')), ['a', 'b']);
    assert.deepStrictEqual(ids(rosters.get('b')), ['a', 'b']);
    assert.deepStrictEqual(ids(rosters.get('c')), ['c']);
});

test('every viewer is present in its own subset', () => {
    // The invariant that makes the client behave: a client that omits itself from
    // its own roster would delete its own entry on the very next reconcile.
    const roster = [entry('a', 0, 0), entry('b', 10, 10), entry('c', 20, 20)];
    for (const [id, list] of AOI.buildRosters(roster, R)) {
        assert.ok(ids(list).includes(id), `viewer ${id} is missing from its own roster`);
    }
});

test('a lone player on an empty floor still receives themselves', () => {
    const solo = [entry('a', 1234, 1234)];
    assert.deepStrictEqual(ids(AOI.buildRosters(solo, R).get('a')), ['a']);
});

test('measure reports the saving as a fraction of the pre-AoI payload', () => {
    // The pre-AoI cost is n^2: everyone was sent everyone. So the fraction is
    // sent / n^2 -- 1 when nothing was saved, approaching 1/n in the best case.
    //
    // A tight cluster: everyone sees everyone, so nothing is saved. This is the
    // case a benchmark would hide, and it is why the measure helper exists to be
    // asserted directly rather than only observed through a load test.
    const cluster = Array.from({ length: 10 }, (_, i) => entry(i, i * 10, i * 10));
    const c = AOI.measure(cluster, R);
    assert.strictEqual(c.sent, 100, 'a full mesh of 10 sends 100 entries');
    assert.strictEqual(c.ratio, 1, 'a cluster inside one radius must save nothing');

    // Spread out: nobody sees anybody but themselves.
    const spread = Array.from({ length: 10 }, (_, i) => entry(i, i * 10000, 0));
    const s = AOI.measure(spread, R);
    assert.strictEqual(s.sent, 10, 'each viewer should receive exactly itself');
    assert.strictEqual(s.ratio, 0.1, 'a spread-out floor must save 90%');

    // The real middle case: two clusters far apart, which is what a shard looks
    // like in practice and is the case AoI is for. Each cluster is still a full
    // mesh -- a party standing together can see each other -- but nothing crosses
    // between the clusters.
    //
    // The first version of this assertion expected sent = 10, on the reasoning
    // that "two clusters" meant "each viewer sees only itself". That confuses a
    // cluster with a lone player: five players within 40px of each other all see
    // all five. The saving here is that the mesh is split in two, not that it
    // disappears -- 50 of 100 entries, a ratio of 0.5.
    const twoClusters = [
        ...Array.from({ length: 5 }, (_, i) => entry(i, i * 10, 0)),
        ...Array.from({ length: 5 }, (_, i) => entry(i + 5, 20000 + i * 10, 0))
    ];
    const m = AOI.measure(twoClusters, R);
    assert.strictEqual(m.floor, 10);
    assert.strictEqual(m.sent, 50, 'each cluster of 5 is a full mesh: 25 + 25');
    assert.strictEqual(m.ratio, 0.5, 'splitting the mesh in two halves the payload');

    // Disabling the filter must reproduce exactly the pre-AoI cost.
    assert.strictEqual(AOI.measure(cluster, 0).ratio, 1,
        'with AoI off, the fraction sent must be the whole floor-wide payload');
});

test('measure on an empty floor does not divide by zero', () => {
    const m = AOI.measure([], R);
    assert.strictEqual(m.floor, 0);
    assert.ok(Number.isFinite(m.ratio), `ratio must be a number, got ${m.ratio}`);
});

// --- The radius agrees with the minimap's -------------------------------------

test('the AoI radius can be overridden from the environment', () => {
    // tests/bots/aoi_probe.js establishes its "before" number by running the server
    // with TIBIA_AOI_RADIUS=0. If that override silently stopped working, the probe
    // would compare the filtered path against itself and report a saving of
    // nothing -- a measurement that looks fine and means nothing. So the override
    // is exercised in a child process, because a mutation to the ternary in
    // config.js is invisible to a require that happens in this process first.
    const { execFileSync } = require('child_process');
    const repoRoot = path.join(__dirname, '..', '..');
    const readRadius = (value) => {
        const out = execFileSync(
            process.execPath,
            ['-e', 'process.stdout.write(String(require("./server/config").AOI_RADIUS))'],
            { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, TIBIA_AOI_RADIUS: value } }
        );
        return Number(out);
    };

    assert.strictEqual(readRadius('0'), 0,
        'TIBIA_AOI_RADIUS=0 must disable filtering, or the control run is not a control');
    assert.strictEqual(readRadius('250'), 250, 'an explicit radius must be honoured');
    assert.strictEqual(readRadius('not-a-number'), 1000,
        'an unparseable override must fall back to the default rather than to NaN');
});

test('the AoI radius is a finite positive number by default', () => {
    assert.ok(Number.isFinite(CFG.AOI_RADIUS), 'AOI_RADIUS must be a number');
    assert.ok(CFG.AOI_RADIUS > 0, 'the shipped default must not disable AoI');
});

test('AOI_RADIUS matches the minimap radius, so the two views cannot disagree', () => {
    const renderer = fs.readFileSync(RENDERER_JS, 'utf8');
    const declared = renderer.match(/const\s+MINIMAP_RADIUS\s*=\s*(\d+)/);
    assert.ok(declared, 'renderer.js must still declare MINIMAP_RADIUS');
    assert.strictEqual(CFG.AOI_RADIUS, Number(declared[1]),
        'AOI_RADIUS and MINIMAP_RADIUS have drifted apart. The minimap filters ' +
        'otherPlayers on MINIMAP_RADIUS, so a different AoI radius means a player ' +
        'can be drawn on the minimap and absent from the world, or the reverse.');
});

// --- The wiring --------------------------------------------------------------

test('the broadcast tick actually calls the AoI selection', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    assert.ok(/AOI\.visibleTo\(/.test(src),
        'server.js must use AOI.visibleTo. A correct module that nothing calls ' +
        'is indistinguishable from a working one from inside the module.');
    assert.ok(/AOI\s*=\s*require\('\.\/aoi'\)/.test(src),
        'server.js must require ./aoi');
});

test('the AoI path sends per viewer rather than broadcasting the floor', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const tick = src.slice(src.indexOf('scheduleServerInterval(() => {\n    const now = Date.now();'));
    assert.ok(tick.length > 0, 'the periodic roster tick must exist');
    // The disabled branch may still broadcastToFloor; the enabled branch must not.
    assert.ok(/if \(CFG\.AOI_RADIUS <= 0\)[\s\S]{0,200}broadcastToFloor\(floor, \{ action: 'players_sync'/.test(tick),
        'the pre-AoI full-floor broadcast must remain reachable when AOI_RADIUS is 0');
    assert.ok(/sendTo\(players\.get\(viewer\.id\), \{[\s\S]{0,120}'players_sync'/.test(tick),
        'the enabled path must send each viewer its own players_sync');
});

test('each viewer is asked about its own position, not some other one', () => {
    // A mutation that asks for list[list.length - 1] instead of the loop variable
    // hands every client the same roster -- the last player's. Every behavioural
    // test of aoi.js still passes, because the function was given a valid viewer
    // and did exactly what it was told. Asserting only that `AOI.visibleTo(` is
    // called cannot see the difference; the argument has to be pinned.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const tick = src.slice(src.indexOf('scheduleServerInterval(() => {\n    const now = Date.now();'));
    assert.ok(/AOI\.visibleTo\(viewer,\s*list,\s*CFG\.AOI_RADIUS\)/.test(tick),
        'the roster sent to a viewer must be the one computed for that viewer. ' +
        'Passing any other viewer silently gives every client the same list.');
    assert.ok(!/AOI\.visibleTo\(list\[/.test(tick),
        'the first argument to visibleTo must be the loop variable, not an ' +
        'index into the roster');
});

test('the client still prunes players absent from the roster', () => {
    // THE load-bearing line for AoI. Without it a peer who walks out of range is
    // never removed from a client, and the failure mode is a permanent ghost: no
    // error, no exception, nothing in the server logs, and players accumulating
    // one per person who has ever been nearby.
    const src = fs.readFileSync(ENGINE_JS, 'utf8');
    assert.ok(
        /for \(let id in otherPlayers\) \{ if \(!newIds\.includes\(id\)\) delete otherPlayers\[id\]; \}/.test(src),
        'engine.js must delete any otherPlayer missing from players_sync. AoI ' +
        'depends on this and nothing else for cleanup -- an earlier draft of this ' +
        'change assumed a new removal packet would be needed and that is not true.');
});

test('players_sync is still the roster packet, and no removal packet was invented', () => {
    // Guard against the natural-looking but wrong design: a `player_out_of_range`
    // packet that duplicates what the authoritative reconcile already does. If
    // someone adds one, the two mechanisms have to agree and nothing keeps them
    // in step.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    assert.ok(/action: 'players_sync'/.test(src));
    assert.ok(!/player_out_of_range|player_left_aoi|aoi_leave/.test(src),
        'AoI needs no new removal packet; if one was added, reconcile it with ' +
        'the authoritative players_sync prune or delete it');
});
