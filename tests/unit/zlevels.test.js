// Unit tests for the Z-level coordinate (Stage 0).
//
// Stage 0 introduces the third coordinate and the guards around it, without
// generating any floor below the surface. The risk in that kind of change is
// not the new code, it is the quiet regressions: a default that cancels out, a
// clamp that discards valid values, a parameter accepted and ignored. Every
// test below is one of those shapes, written so it fails loudly if reintroduced.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', '..', 'server');
const CFG = require(path.join(SERVER_DIR, 'config'));
const MAP = require(path.join(SERVER_DIR, 'map'));
const MOBS = require(path.join(SERVER_DIR, 'mobs'));
const BOSSES = require(path.join(SERVER_DIR, 'bosses'));
const CHESTS = require(path.join(SERVER_DIR, 'chests'));

// server.js starts a listening server on require, so its helpers are pulled out
// of the source and evaluated in isolation. Same approach as skull.test.js: it
// keeps the test honest about the real implementation rather than a copy of it.
const SERVER_JS = path.join(SERVER_DIR, 'server.js');

// Extracts `function <name>(` up to the start of the next top-level `function`
// or const declaration, so a helper can be evaluated without the rest of the
// server (which opens a socket on require). server.js declares WebSocket
// itself, so the caller must NOT also pass a WebSocket parameter -- doing so
// is a redeclaration and throws.
function extractDeclaration(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`${name} must exist in server.js`);
    // A `function` at column 0 is the next top-level declaration.
    const rest = src.slice(start + 1);
    const next = rest.search(/\n(function |const |let |class )/);
    return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

function loadServerHelpers(names, extraParams = []) {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const body = names.map(n => extractDeclaration(src, n)).join('\n\n');
    const params = ['CFG', 'MAP', ...extraParams];
    const factory = new Function(...params, `${body}\nreturn { ${names.join(', ')} };`);
    return factory(CFG, MAP, ...extraParams.map(([, v]) => v));
}

test('normalizeZ accepts every legal floor and clamps everything else', () => {
    // Legal floors round-trip untouched. This is the assertion that would have
    // caught the original safeInteger(data.z, 0) form, whose `minimum` defaulted
    // to 0 and so collapsed every underground floor onto the surface.
    for (let z = CFG.Z_MIN; z <= CFG.Z_MAX; z++) {
        assert.strictEqual(MAP.normalizeZ(z), z, `legal floor z=${z} must survive`);
    }

    // Out of range and malformed values resolve to the surface rather than
    // throwing, so a corrupt save can never reject a login.
    for (const bad of [CFG.Z_MAX + 1, CFG.Z_MIN - 1, 99, -99, NaN, Infinity, '0', null, undefined, 1.5, {}]) {
        assert.strictEqual(MAP.normalizeZ(bad), CFG.Z_SURFACE,
            `malformed z=${JSON.stringify(bad)} must clamp to the surface`);
    }
});

test('the configured range is a real range, not an open-ended minimum', () => {
    // Guards the intermediate fix that used safeInteger(data.z, 0, -10). It
    // stopped discarding -1 but admitted -10 and left 99 untouched, so it was
    // wrong at both ends.
    assert.ok(CFG.Z_MIN < 0, 'Z_MIN must allow underground floors');
    assert.strictEqual(CFG.Z_SURFACE, 0, 'the surface is z=0');
    assert.strictEqual(MAP.normalizeZ(CFG.Z_MIN - 1), CFG.Z_SURFACE,
        'below the deepest floor must clamp up to the surface');
    assert.strictEqual(MAP.normalizeZ(CFG.Z_MAX + 1), CFG.Z_SURFACE,
        'above the surface must clamp down');
});

test('omitting z preserves the previous 2D behaviour exactly', () => {
    // The whole safety argument for adding z as a trailing defaulted parameter
    // is that no existing call site changes meaning. If this drifts, the
    // migration is no longer additive.
    for (const [x, y] of [[320, 320], [0, 0], [3199, 3199], [1000, 2000]]) {
        assert.strictEqual(MAP.isWalkable(x, y), MAP.isWalkable(x, y, 0),
            `isWalkable(${x},${y}) must equal the explicit z=0 form`);
    }
    assert.strictEqual(MAP.isWater(320, 320), MAP.isWater(320, 320, 0));
});

test('a floor with no generated terrain is nowhere to stand', () => {
    // The important negative case. If an unbuilt floor fell through to the
    // surface's obstacle set, a player on an unbuilt floor would be allowed to
    // stand on a tile that only exists above them.
    //
    // The depth is discovered, and the test is honest when there is nothing to
    // discover. This used to assert anUnregisteredFloor() !== null, which held
    // while the dungeon was shallower than the Z_MIN..Z_MAX range and stopped
    // holding when z=-3 filled the last gap -- the test then failed for a reason
    // unrelated to the code it was guarding.
    //
    // It is not possible to reach an unbuilt floor through the public API while the
    // range is full: normalizeZ clamps every z into [Z_MIN, Z_MAX], and every index
    // in that range is registered. So the full-range case asserts the structural
    // fact instead -- that the range really is complete -- rather than pretending
    // to test a subject that does not exist.
    assert.strictEqual(MAP.hasFloor(CFG.Z_SURFACE), true, 'the surface is built');

    const z = MAP.anUnregisteredFloor();
    if (z === null) {
        // Range full. Every in-range floor is generated; say so, and check that the
        // guard that would have caught a gap is still wired up.
        const span = CFG.Z_MAX - CFG.Z_MIN + 1;
        const built = CFG.Z_FLOORS.length + 1;   // floors, plus the surface
        assert.strictEqual(built, span,
            `the range ${CFG.Z_MIN}..${CFG.Z_MAX} holds ${span} floors and ${built} are built, ` +
            `so the unbuilt-floor case cannot be constructed -- widen Z_MIN if this was not intended`);
        assert.strictEqual(MAP.getFloorTerrain(CFG.Z_MIN).z, CFG.Z_MIN,
            'with a full range, the lowest floor must describe its own terrain');
        return;
    }

    assert.strictEqual(MAP.isWalkable(320, 320, z), false,
        `unbuilt floor ${z} must not be walkable`);
    assert.strictEqual(MAP.getFloorTerrain(z), null,
        `unbuilt floor ${z} must not describe terrain`);
    assert.strictEqual(MAP.hasWaterNear(320, 320, 128, z), 0,
        `unbuilt floor ${z} must offer no water`);
});

test('water is scoped to one floor', () => {
    // Water on the surface must not make another floor fishable. The surface's
    // own answer has to be unchanged by the z parameter.
    const surface = MAP.hasWaterNear(320, 320, 128, CFG.Z_SURFACE);
    assert.strictEqual(surface, MAP.hasWaterNear(320, 320, 128), 'default floor is the surface');
    const z = MAP.anUnregisteredFloor();
    if (z !== null) {
        assert.strictEqual(MAP.hasWaterNear(320, 320, 128, z), 0,
            'an unbuilt floor has no water to fish');
    }
});

test('a registered floor becomes walkable and is isolated from the surface', () => {
    // Stands up a synthetic dungeon so the per-floor storage is exercised for
    // real rather than only through the "not built yet" path.
    const Z = -2;
    const obstacles = new Set(['100,100']);
    const floor = MAP.registerFloor(Z, {
        obstacles,
        obstacleData: [{ x: 100, y: 100, type: 'rock' }],
        waterTiles: new Set(['64,64'])
    });
    try {
        assert.strictEqual(floor.z, Z);
        assert.strictEqual(MAP.hasFloor(Z), true, 'the floor is now built');
        assert.strictEqual(MAP.isWalkable(100, 100, Z), false, 'its own rock blocks the tile');
        assert.strictEqual(MAP.isWalkable(200, 200, Z), true, 'its other tiles are open');
        assert.strictEqual(MAP.isWater(64, 64, Z), true, 'its own water is water');
        assert.strictEqual(MAP.isWater(64, 64, CFG.Z_SURFACE), false,
            'the surface does not inherit the dungeon tile');
        assert.strictEqual(MAP.getFloorTerrain(Z).obstacleData.length, 1);
    } finally {
        // Leave the module as found; the map is a process-wide singleton and a
        // leftover synthetic floor would leak into every later test in the run.
        // Registering an empty floor instead of removing it leaves hasFloor()
        // true, which is what made an unrelated assertion depend on run order.
        MAP.unregisterFloor(Z);
    }
    assert.strictEqual(MAP.hasFloor(Z), false, 'the synthetic floor must be gone again');
});

test('spawnMobAt takes z as a trailing argument, not an inserted third', () => {
    // The documented alternative was spawnMobAt(x, y, z, type). That silently
    // reinterpreted the existing test_spawn_mob call's type as a floor index
    // and there is no type error to catch it, so the signature is asserted.
    const id = MOBS.spawnMobAt(900, 900, 'spider', null);
    assert.strictEqual(MOBS.mobs.get(id).z, CFG.Z_SURFACE, 'defaults to the surface');
    assert.strictEqual(MOBS.mobs.get(id).type, 'spider', 'type still lands in the 3rd slot');

    const id2 = MOBS.spawnMobAt(900, 900, 'skeleton', null, -2);
    assert.strictEqual(MOBS.mobs.get(id2).z, -2, 'an explicit floor is honoured');
    assert.strictEqual(MOBS.mobs.get(id2).type, 'skeleton');

    const id3 = MOBS.spawnMobAt(900, 900, 'bear', null, 99);
    assert.strictEqual(MOBS.mobs.get(id3).z, CFG.Z_SURFACE, 'a bad floor is clamped');
});

test('a boss records the floor it was placed on', () => {
    const onSurface = BOSSES.spawnBoss('spider_queen', null, { announce: false });
    assert.strictEqual(onSurface.z, CFG.Z_SURFACE);
    const below = BOSSES.spawnBoss('ice_dragon', null, { announce: false, z: -2 });
    assert.strictEqual(below.z, -2);
    const bad = BOSSES.spawnBoss('skeleton_king', null, { announce: false, z: 99 });
    assert.strictEqual(bad.z, CFG.Z_SURFACE, 'clamped');
});

test('chests record the floor they were placed on', () => {
    const messages = [];
    const onSurface = CHESTS.spawnChest((m) => messages.push(m));
    assert.strictEqual(onSurface, undefined, 'returns nothing when it spawns');
    const all = [...CHESTS.chests.values()];
    assert.ok(all.length > 0, 'a chest exists');
    for (const c of all) {
        assert.strictEqual(c.z, CFG.Z_SURFACE, 'default chests land on the surface');
    }
});

test('dist is floor-unaware and dist3D is the opt-in floor-aware form', () => {
    // server.js is needed for these, and it opens a socket on require, so the
    // two declarations are lifted out of the source and evaluated as written.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const { dist, dist3D } = loadServerHelpers(['dist', 'dist3D']);

    assert.strictEqual(dist(100, 100, 100, 100), 0);
    assert.strictEqual(dist(0, 0, 30, 40), 70, 'Manhattan distance is unchanged');

    // Asserted against the source, not dist.length: Function.length counts only
    // the parameters before the first default, so `function dist(x1,y1,x2,y2,
    // z1 = 0, z2 = 0)` still reports 4 and a length check cannot see the very
    // parameters it is meant to forbid. That is why a defaulted z slipped
    // through the first time.
    const distDecl = extractDeclaration(src, 'dist');
    assert.ok(!/function\s+dist\s*\([^)]*\bz/.test(distDecl),
        `dist must take no z parameter, found: ${distDecl.split('\n')[0]}`);

    assert.strictEqual(dist3D(0, 0, 0, 30, 40, 0), 70, 'same floor measures normally');
    assert.strictEqual(dist3D(0, 0, -1, 0, 0, 0), Infinity, 'across floors is unreachable');
    assert.strictEqual(dist3D(0, 0, 0, 0, 0, -2), Infinity);
    // Two floors that are both unbuilt are still different floors. Normalising
    // must not collapse distinct legal indices together.
    assert.strictEqual(dist3D(0, 0, -1, 0, 0, -2), Infinity);
});

test('dist3D comparisons reject a cross-floor target for free', () => {
    // The reason dist3D returns Infinity rather than a large number: every
    // existing `<= RANGE` and `minD <=` guard then rejects the target without
    // needing a second, separately-audited condition. Assert the guard fires.
    const { dist3D } = loadServerHelpers(['dist', 'dist3D']);
    const MELEE_RANGE = CFG.MELEE_RANGE;
    const stacked = dist3D(320, 320, -1, 320, 320, 0);
    assert.ok(!(stacked <= MELEE_RANGE), 'a mob directly above must be out of melee range');
});

test('a save round trip preserves the floor, including x=0 and y=0', () => {
    // normalizePlayerData and serializePlayer are module-private in server.js
    // and are not adjacent -- serializePlayer is declared long before the
    // normalize block -- so each is sliced separately. They call into Q,
    // SKILLS, CRAFTING, AUCTION and the skull helper, so the real modules are
    // passed in rather than stubbed: a stub would make this assert about the
    // stub instead of the server.
    const Q = require(path.join(SERVER_DIR, 'quests'));
    const SKILLS = require(path.join(SERVER_DIR, 'skills'));
    const CRAFTING = require(path.join(SERVER_DIR, 'crafting'));
    const AUCTION = require(path.join(SERVER_DIR, 'auction'));
    const ITEMS = require(path.join(SERVER_DIR, 'items'));
    const SC = require(path.join(SERVER_DIR, 'subclasses'));
    const FRIENDS = require(path.join(SERVER_DIR, 'friends'));
    const SKULL_DROP_RATIO = 1, NORMAL_DROP_RATIO = 0.5, corpseIdCounter = { v: 0 };
    let corpses = new Map();

    const src = fs.readFileSync(SERVER_JS, 'utf8');
    // serializePlayer and the normalize block are in two different places, and
    // each carries sibling helpers it needs: normalizeSkull + the SKULL_*
    // consts, and safePersistInt. Slice the contiguous normalize block whole
    // rather than extracting declarations one at a time, which silently misses
    // a helper the moment a new one is added next to it.
    const skullConsts = src.slice(src.indexOf('const SKULL_WHITE'), src.indexOf('function normalizeSkull'));
    const normalizeBlock = src.slice(
        src.indexOf('function normalizeSkull'),
        src.indexOf('function isInBounds', src.indexOf('function normalizePlayerData'))
    );
    const body = [extractDeclaration(src, 'serializePlayer'), skullConsts, normalizeBlock].join('\n\n');

    // FRIENDS joins the injected dependencies because normalizePlayerData now
    // sanitises the friend list. It arrived as a ReferenceError -- the sandbox
    // evaluates the function body in isolation, so a module it references must be
    // supplied here or the whole round-trip test dies before asserting anything.
    const { normalizePlayerData, serializePlayer } = new Function(
        'CFG', 'Q', 'SKILLS', 'CRAFTING', 'AUCTION', 'ITEMS', 'MAP', 'SC', 'FRIENDS',
        `${body}
     return { normalizePlayerData, serializePlayer };`
    )(CFG, Q, SKILLS, CRAFTING, AUCTION, ITEMS, MAP, SC, FRIENDS);

    // Every legal floor must survive normalizePlayerData. This is the assertion
    // the original `safeInteger(data.z, 0)` form failed: its `minimum` defaulted
    // to 0, so z=-1, -2 and -3 all collapsed to 0 and every dungeon character
    // was teleported to the surface on every login.
    for (let floor = CFG.Z_MIN; floor <= CFG.Z_MAX; floor++) {
        assert.strictEqual(normalizePlayerData({ z: floor }).z, floor,
            `floor ${floor} must survive normalizePlayerData`);
    }

    // A character standing at the map origin. The login path used
    // `pData.x || 320`, which treated 0 as missing and relocated them.
    assert.strictEqual(normalizePlayerData({ z: 0, x: 0, y: 0 }).z, 0);

    // Out-of-range and malformed floors clamp instead of throwing, so a corrupt
    // or hand-edited save cannot reject a login.
    for (const bad of [99, -99, CFG.Z_MIN - 1, CFG.Z_MAX + 1, '1', null, undefined, 1.5]) {
        assert.strictEqual(normalizePlayerData({ z: bad }).z, CFG.Z_SURFACE,
            `z=${JSON.stringify(bad)} must clamp to the surface`);
    }
    assert.strictEqual(normalizePlayerData({}).z, CFG.Z_SURFACE,
        'a pre-Stage-0 save with no z is valid and lands on the surface');

    // Full round trip: what serializePlayer writes is what comes back.
    // serializePlayer spreads the whole player, so this needs a realistic one
    // rather than a bare { z }.
    const barePlayer = (z) => ({
        z, level: 1, xp: 0, nextXp: 100, gold: 0, inventory: [],
        classType: 'warrior', subclass: null, guild: null,
        auctionEscrow: [], pendingMailbox: { gold: 0, items: [] },
        skull: null, isMounted: false, skullExpiresAt: 0,
        quests: [], craftedRecipes: [], skills: null,
        bankGold: 0, bankItems: [], equipment: {},
        maxHp: 150, maxMana: 30
    });
    for (let floor = CFG.Z_MIN; floor <= CFG.Z_MAX; floor++) {
        const written = serializePlayer(barePlayer(floor));
        assert.strictEqual(written.z, floor, `serializePlayer must write z=${floor}`);
        assert.strictEqual(normalizePlayerData(written).z, floor,
            `z=${floor} must survive the persistence round trip`);
    }
});

// --- Source-level guards ---------------------------------------------------
// These three sites sit inside the WebSocket message handler: the login
// players.set() literal, and checkPlayerDeath. Neither is reachable without a
// live socket, so they cannot be given behavioural unit tests. Asserting on the
// source text is weaker than executing the code, and it would silently pass if
// the logic were duplicated elsewhere -- but mutation testing showed the
// behavioural tests let four regressions through precisely here, and a source
// guard at least fails when the guard expression is removed. Each is paired
// with a comment naming the live suite that would cover it once one exists.
test('login normalises z and uses ?? for x and y', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const login = src.slice(src.indexOf('players.set(playerId, {'), src.indexOf('players.set(playerId, {') + 700);
    assert.ok(login.length > 0, 'the login players.set block must exist');
    assert.ok(/z:\s*MAP\.normalizeZ\(pData\.z\)/.test(login),
        'login must normalise pData.z, not pass it through');
    assert.ok(/x:\s*pData\.x\s*\?\?\s*320/.test(login),
        'login must use ?? for x: `pData.x || 320` discards a saved x of 0');
    assert.ok(/y:\s*pData\.y\s*\?\?\s*320/.test(login),
        'login must use ?? for y: `pData.y || 320` discards a saved y of 0');
});

test('death respawn returns the player to the surface, not just to x=320', () => {
    // Without this the player keeps z = -1 while being placed at the surface
    // spawn point, which is a position that does not exist on that floor. The
    // client trusts force_position, so it draws them inside the dungeon.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const death = src.slice(src.indexOf('function checkPlayerDeath'));
    assert.ok(death.length > 0, 'checkPlayerDeath must exist');
    assert.ok(/player\.z\s*=\s*CFG\.Z_SURFACE/.test(death),
        'respawn must reset the floor as well as the coordinates');
    assert.ok(/force_position[^}]*z:\s*CFG\.Z_SURFACE/.test(death),
        'force_position must tell the client the new floor');
});

test('the login roster is filtered to the player own floor', () => {
    // Sends mobs, bosses, chests, corpses and nodes. Unsfiltered, a client would
    // be handed entities whose coordinates mean nothing on its own floor, with
    // no way to tell the difference.
    //
    // This reads syncFloorRoster, not the login handler. Both login and every
    // traversal call it, and an earlier revision searched the login block --
    // which stopped matching the moment the body was extracted, turning a real
    // assertion into a false failure.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const start = src.indexOf('function syncFloorRoster');
    assert.ok(start !== -1, 'syncFloorRoster must exist');
    const roster = src.slice(start, src.indexOf('function performTraversal', start));
    for (const kind of ['mob_update', 'chest_update', 'corpse_spawn', 'node_sync']) {
        const at = roster.indexOf(`action: '${kind}'`);
        assert.ok(at !== -1, `the roster must send ${kind}`);
        const line = roster.slice(roster.lastIndexOf('if (', at), at);
        assert.ok(/MAP\.normalizeZ\(\w+\.z\)\s*===\s*pz/.test(line),
            `${kind} must be filtered to the player's floor`);
    }
    // map_data must lead, or the client applies the new terrain after filling
    // its caches with the previous floor's contents and never clears them.
    assert.ok(roster.indexOf("action: 'map_data'") < roster.indexOf("action: 'mob_update'"),
        'map_data must be sent before the entity roster so the client can flush first');
});

test('every traversal re-syncs the floor roster', () => {
    // A client that descends without a new map_data keeps the old floor's
    // terrain and its old entity caches, so the player walks on the surface
    // while the server thinks they are underground.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const start = src.indexOf('function performTraversal');
    assert.ok(start !== -1, 'performTraversal must exist');
    const body = src.slice(start, src.indexOf('function sendTo', start));
    assert.ok(/syncFloorRoster\(player\)/.test(body),
        'a traversal must re-sync the roster for the destination floor');
    assert.ok(/force_position/.test(body), 'a traversal must tell the client the new position');
    // Leaving the old floor before arriving stops a ghost standing on the
    // ladder in the surface view until the next players_sync tick.
    const leaveAt = body.indexOf("action: 'player_left'");
    const arriveAt = body.indexOf('syncFloorRoster(player)');
    assert.ok(leaveAt !== -1 && arriveAt !== -1, 'both sides of the move must be handled');
    assert.ok(leaveAt < arriveAt, 'the old floor must be told before the new one is populated');
});

test('the floor roster sends everything the login sequence used to send', () => {
    // syncFloorRoster replaced an inline block at login, and one call was left
    // behind in the extraction: sendSkillPanel. The player logged in with a
    // blank skill panel, which tests/skills_live_verify.js caught and no unit
    // test would have. This asserts the login sequence is complete, so the next
    // extraction cannot quietly drop something.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const login = src.slice(src.indexOf('players.set(playerId, {'), src.indexOf("action: 'auction_sync'"));
    const start = src.indexOf('function syncFloorRoster');
    const roster = src.slice(start, src.indexOf('function performTraversal', start));
    // Every roster-producing call the login path depends on must now be inside
    // the shared function, which is what both login and traversal invoke.
    for (const call of ['sendSkillPanel(player)', 'syncNpcs(player)', "action: 'map_data'",
        "action: 'ground_sync'", "action: 'mob_update'", "action: 'chest_update'",
        "action: 'corpse_spawn'", "action: 'node_sync'"]) {
        assert.ok(roster.includes(call), `syncFloorRoster must still send ${call}`);
    }
    assert.ok(login.includes('syncFloorRoster(player)'),
        'login must go through syncFloorRoster rather than its own copy');
    // Nothing may send the skill panel from the login path any more, or a
    // descent would be the only time the player sees one.
    assert.ok(!/sendSkillPanel/.test(login.slice(login.indexOf('syncFloorRoster(player)'))),
        'the skill panel must not be sent twice on login');
});

test('ground_sync and map_data are floor-scoped', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    assert.ok(/action: 'ground_sync', items: groundItemPayload\(pz\)/.test(src),
        'the login ground_sync must be scoped to the player floor');
    assert.ok(/getFloorTerrain\(pz\)/.test(src),
        'map_data must describe the floor the player is on');
    // An unbuilt floor must yield no terrain rather than the surface relabelled.
    // Discovered rather than hardcoded: this used to assert
    // getFloorTerrain(Z_MIN) === null, which was true when Z_MIN sat below the
    // deepest generated floor and stopped being true the moment z=-3 filled the
    // range -- it then failed for a reason unrelated to floor scoping.
    const unbuilt = MAP.anUnregisteredFloor();
    if (unbuilt !== null) {
        assert.strictEqual(MAP.getFloorTerrain(unbuilt), null,
            `unbuilt floor ${unbuilt} must describe no terrain`);
    } else {
        // Range full, so every index is a real floor. The strongest thing left to
        // assert is that each one describes itself rather than falling back.
        for (let z = CFG.Z_MIN; z <= CFG.Z_MAX; z++) {
            const terrain = MAP.getFloorTerrain(z);
            assert.ok(terrain && terrain.z === z,
                `with a full range, floor ${z} must describe itself, got ${terrain && terrain.z}`);
        }
    }
});

test('broadcastToFloor scopes by floor and broadcast reaches everyone', () => {
    // Both are lifted from the source. `players` is a module-private Map, so
    // the factory is given a stub that reports one open socket per player.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const start = src.indexOf('function broadcast(');
    const end = src.indexOf('function sendTo(');
    assert.ok(start !== -1 && end > start, 'broadcast block must exist');

    const block = src.slice(start, end);
    const received = { surface: [], below: [], corrupt: [] };
    const mkPlayer = (z, bucket) => ({ z, ws: { readyState: 1, bufferedAmount: 0, send: (m) => bucket.push(JSON.parse(m)) } });
    const players = new Map([
        ['a', mkPlayer(0, received.surface)],
        ['b', mkPlayer(-1, received.below)],
        ['c', mkPlayer(undefined, received.corrupt)]   // a pre-Stage-0 save
    ]);
    const { broadcast, broadcastToFloor } = new Function('players', 'WebSocket', 'MAX_SOCKET_BUFFER_BYTES', 'MAP',
        `${block}
     return { broadcast, broadcastToFloor };`
    )(players, { OPEN: 1 }, 1024 * 1024, MAP);

    // Unscoped broadcast reaches everyone, including the player with no z.
    broadcast({ action: 'ping' });
    assert.strictEqual(received.surface.length, 1, 'surface player got the packet');
    assert.strictEqual(received.below.length, 1, 'player below got the packet');
    assert.strictEqual(received.corrupt.length, 1,
        'a player with no stored z must not be filtered out of every broadcast');

    // Scoped to the surface: the below player is excluded, the corrupt player
    // counts as being on the surface rather than falling out of the world.
    received.surface.length = 0; received.below.length = 0; received.corrupt.length = 0;
    broadcastToFloor(0, { action: 'fct' });
    assert.strictEqual(received.surface.length, 1, 'surface player received it');
    assert.strictEqual(received.corrupt.length, 1, 'missing z is treated as the surface');
    assert.strictEqual(received.below.length, 0, 'a player one floor down is excluded');

    // Scoped to a floor below: only that floor, and an out-of-range floor index
    // resolves to the surface rather than reaching nobody.
    received.surface.length = 0; received.below.length = 0; received.corrupt.length = 0;
    broadcastToFloor(-1, { action: 'fct' });
    assert.strictEqual(received.below.length, 1);
    assert.strictEqual(received.surface.length, 0);
    assert.strictEqual(received.corrupt.length, 0);

    received.surface.length = 0; received.below.length = 0; received.corrupt.length = 0;
    broadcastToFloor(99, { action: 'fct' });
    assert.strictEqual(received.surface.length, 1, 'a bad floor index clamps to the surface');
    assert.strictEqual(received.below.length, 0);
});
