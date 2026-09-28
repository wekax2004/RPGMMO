/*
 * Live end-to-end verification of Z-level Stage 2: traversal.
 *
 * The unit tests cover the map layer -- that a traversal tile is walkable but
 * not solid, that the route is a closed loop, that dist3D separates floors.
 * None of that proves a player can actually walk onto a ladder and come out
 * somewhere else. This drives a real server over WebSockets and checks:
 *
 *   1.  a second client on the same floor sees the other player
 *   2.  walking onto the ladder moves the player to the dungeon floor
 *   3.  map_data arrives carrying the new floor index
 *   4.  the terrain that arrives belongs to the dungeon, not the surface
 *   5.  the dungeon roster is floor-scoped (no surface mobs in the cave)
 *   6.  the surface client stops seeing the player who descended
 *   7.  cross-floor isolation: no NPC, no chest, no ground item is reachable
 *   8.  the way back up is one-way, and returns the player to the ladder
 *   9.  a traversal tile is enterable, i.e. the server does not reject the step
 *  10.  the floor survives a disconnect and reconnect
 *
 * Run:  node tests/traversal_live_verify.js
 */
const path = require('path');
const os = require('os');
const ServerController = require('./lib/server_controller');

const PORT = 8158;
const DB_FILE = path.join(os.tmpdir(), `tibia-traversal-live-${process.pid}.json`);
const TILE = 32;
const STEP_DELAY = 330;

let failures = 0;
function check(label, condition, detail) {
    const ok = !!condition;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ` -- ${detail}` : ''}`);
    return ok;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect(url) {
    const WS = require('ws');
    return new Promise((resolve, reject) => {
        const ws = new WS(url);
        const st = {
            ws, id: null, packets: [], logs: [], errors: [],
            terrain: null, terrainZ: null, ground: new Map(), mobs: new Map(),
            players: new Map(), status: null, pos: { x: 320, y: 320, z: 0 },
            // Where the server last said we were, from our own players_sync
            // entry. Distinct from pos, which is the optimistic local position
            // the client advances on its own.
            authPos: null,
            currentZ: 0, on: {}
        };
        st.on.packet = () => {};
        ws.on('open', () => resolve(st));
        ws.on('error', reject);
        ws.on('message', raw => {
            let p; try { p = JSON.parse(raw.toString()); } catch { return; }
            st.packets.push(p);
            if (p.action === 'your_id') st.id = p.id;
            if (p.action === 'status') st.status = p;
            if (p.action === 'log') st.logs.push(p.message);
            // Death is a legitimate outcome here -- the dungeon is populated
            // with tier-scaled mobs and a stationary player will lose that fight.
            // It has to be noticed rather than inferred, because a respawn used
            // to move the sprite without telling the client it had changed
            // world, which then desynced every later assertion for no visible
            // reason.
            if (p.action === 'log' && /was slain by/.test(p.message || '')) st.died = true;
            if (p.action === 'log' && /^\u274c/.test(p.message || '')) st.errors.push(p.message);

            // Mirror the client exactly: map_data carrying a different z means
            // the floor changed, so every world cache is dropped first. This is
            // what Antigravity implemented in engine.js, and the traversal is
            // only correct if a client following that rule ends up consistent.
            if (p.action === 'map_data') {
                const newZ = p.z || 0;
                if (st.currentZ !== newZ) {
                    st.mobs.clear();
                    st.players.clear();
                    st.ground.clear();
                }
                st.currentZ = newZ;
                st.terrainZ = p.z;
                st.terrain = p.obstacles || [];
                st.bounds = p.bounds || null;
                st.mapW = p.width;
                st.mapH = p.height;
            }
            if (p.action === 'ground_sync') {
                st.ground.clear();
                (p.items || []).forEach(i => st.ground.set(i.id, i));
            }
            if (p.action === 'mob_update' && typeof p.x === 'number') {
                if (p.alive === false) st.mobs.delete(p.id);
                else st.mobs.set(p.id, p);
            }
            if (p.action === 'players_sync') {
                (p.players || []).forEach(e => {
                    st.players.set(e.id, e);
                    // The roster includes the receiving player, so this is the
                    // only authoritative read of where the server thinks we are.
                    // Moves are never echoed: the server applies an accepted step
                    // silently and ignores a rejected one, so there is nothing to
                    // distinguish them by except this.
                    if (e.id === st.id) st.authPos = { x: e.x, y: e.y, z: e.z };
                });
            }
            if (p.action === 'player_update') {
                if (p.id === st.id) st.pos = { x: p.x, y: p.y, z: p.z };
            }
            if (p.action === 'force_position') st.pos = { x: p.x, y: p.y, z: p.z };
            if (p.action === 'player_left') st.players.delete(p.id);
            st.on.packet(p);
        });
    });
}

const send = (st, packet) => st.ws.send(JSON.stringify(packet));

async function login(st, name, classType) {
    for (let a = 0; a < 6; a++) {
        let settled = false;
        st.on.packet = p => {
            if (p.action === 'your_id') { st.id = p.id; settled = true; }
            if (p.action === 'login_error') settled = true;
        };
        send(st, { action: 'login', name, class: classType, warmode: false });
        for (let w = 0; w < 25 && !settled; w++) await sleep(100);
        st.on.packet = () => {};
        if (st.id) return true;
        await sleep(400);
    }
    return false;
}

// Puts a character at a level that can walk through the dungeon.
//
// The dungeon is meant to be lethal to a newcomer -- that is the tier doing its
// job -- but this harness verifies traversal, not combat. Several mobs land a
// hit per server tick, so a level 1 character standing in the room dies faster
// than a heal sent between movement steps can land, and the traversal
// assertions after that point fail for a reason that has nothing to do with
// stairs. The game is left lethal; the test character is made capable.
async function prepareForDungeon(st) {
    send(st, { action: 'test_grant_xp', amount: 50000 });
    await sleep(500);
    send(st, { action: 'test_heal' });
    await sleep(300);
}

// Breadth-first route over the terrain the client was actually sent.
//
// A greedy axis-first walk gets stuck on the first pillar it meets, because it
// cannot detour. That read as "the stairs are unreachable" when the cave was
// fine -- the cave is guaranteed connected, the walker was not. This uses the
// obstacle list from map_data, so it walks the same world the client draws
// rather than the server's private state.
function routeTo(st, tx, ty) {
    const solid = new Set((st.terrain || [])
        .filter(o => !['ladder', 'stairs_up', 'stairs_down'].includes(o.type))
        .map(o => `${o.x},${o.y}`));
    // Clip to where the server says the floor's standable ground is. Without
    // this the search is unbounded: the bedrock enclosing the dungeon is
    // walkability-only and never reaches the client, so from inside the cave
    // the world looks wide open and the walk ran off toward negative infinity
    // until the process exhausted memory. The map_data packet now carries
    // `bounds` for exactly this reason; the real client needs the same clip in
    // its own findPath, which is a frontend change to make.
    const b = st.bounds;
    const minX = b ? b.minX : 0, maxX = b ? b.maxX : (st.mapW || 3200) - TILE;
    const minY = b ? b.minY : 0, maxY = b ? b.maxY : (st.mapH || 3200) - TILE;
    const start = `${st.pos.x},${st.pos.y}`;
    const goal = `${tx},${ty}`;
    if (start === goal) return [];
    const prev = new Map([[start, null]]);
    const queue = [st.pos];
    while (queue.length) {
        const cur = queue.shift();
        for (const [dx, dy] of [[TILE, 0], [-TILE, 0], [0, TILE], [0, -TILE]]) {
            const nx = cur.x + dx, ny = cur.y + dy;
            if (nx < minX || ny < minY || nx > maxX || ny > maxY) continue;
            const key = `${nx},${ny}`;
            if (key === goal) {
                // Reconstruct the route: the goal, then its parent, then that
                // node's parent, and so on back to where the player stands.
                //
                // The goal is never added to `prev` -- the loop returns before
                // that -- so the walk must begin at the goal's PARENT. Beginning
                // at the goal collected a single node, the shift below emptied
                // the list, and the walker reported it had "arrived" while still
                // standing at the spawn point.
                //
                // Two earlier versions were wrong in ways that read as product
                // bugs: one skipped the intermediate tile, turning the first
                // move into a diagonal jump the server correctly refuses; the
                // other included the start tile, so every "move" was a
                // zero-length step. Both looked like "the ladder is
                // unreachable", and neither was.
                const back = [[nx, ny]];
                let node = `${cur.x},${cur.y}`;
                for (;;) {
                    const [cx, cy] = node.split(',').map(Number);
                    back.push([cx, cy]);
                    const parent = prev.get(node);
                    if (!parent) break;
                    node = `${parent[0]},${parent[1]}`;
                }
                back.reverse();   // now ordered from the player's tile onward
                back.shift();     // drop it: they are already standing there
                return back;
            }
            if (solid.has(key) || prev.has(key)) continue;
            prev.set(key, [cur.x, cur.y]);
            queue.push({ x: nx, y: ny });
        }
    }
    return null;
}

// Steps one tile at a time toward (tx, ty), pathing around obstacles.
//
// Position is tracked optimistically, the way the real client does. The server
// never echoes an accepted move -- it only speaks up with force_position when
// it wants to correct or relocate the player -- so a harness that waits for a
// coordinate echo waits forever. An earlier revision learned position only from
// force_position and so believed it had failed to reach the ladder at the exact
// moment the descent had already worked.
//
// Returns 'arrived', 'blocked', 'no-path' or 'changed-floor'. The last matters
// most: walking onto a traversal tile moves the player somewhere the target no
// longer makes sense, and a walk that kept going would spend its budget
// dragging them around the destination floor, making every later assertion
// fail for the wrong reason.
// Keeps a character topped up for as long as it is underground.
//
// A single heal per movement step is not enough. The server ticks every 100ms
// and every mob in melee range lands a hit on each one, so nine tier-2.5 mobs
// deal more per tick than a 330ms-interval heal can replace -- the character
// loses the race outright and dies, which then invalidates every traversal
// assertion that follows for a reason that has nothing to do with stairs.
// Healing on its own tighter clock is what makes the room survivable enough to
// walk through, and the dungeon is left exactly as lethal as it was.
function startUndergroundKeepAlive(st) {
    let underground = false;
    const tick = setInterval(() => {
        const isBelow = st.currentZ < 0;
        if (isBelow && !underground) {
            // Arriving below: level up first, or the first tick kills us.
            send(st, { action: 'test_grant_xp', amount: 400000 });
        }
        if (isBelow) send(st, { action: 'test_heal' });
        underground = isBelow;
    }, 120);
    return () => clearInterval(tick);
}

async function walkTo(st, tx, ty, budgetMs = 90000) {
    const deadline = Date.now() + budgetMs;
    const startZ = st.currentZ;
    let stalled = 0;
    while (Date.now() < deadline) {
        if (st.currentZ !== startZ) return 'changed-floor';
        if (st.pos.x === tx && st.pos.y === ty) return 'arrived';
        const path = routeTo(st, tx, ty);
        if (path === null) return 'no-path';
        if (path.length === 0) return 'arrived';
        const [nx, ny] = path[0];
        if (process.env.TRAVERSAL_TRACE) {
            const a = st.authPos;
            console.log(`      trace: local ${st.pos.x},${st.pos.y} auth ${a ? a.x + ',' + a.y : '?'} -> step ${nx},${ny} (${path.length} left)`);
        }
        // The tile we are standing on before the step, so a refusal can be told
        // apart from success below.
        const from = { x: st.pos.x, y: st.pos.y };
        send(st, { action: 'move', x: nx, y: ny });
        st.pos = { x: nx, y: ny, z: st.pos.z };
        await sleep(STEP_DELAY);

        // Judge the step by the server's own view, read from our own
        // players_sync entry. Moves are never echoed: an accepted step is
        // applied silently and a rejected one is ignored, so the absence of a
        // packet tells you nothing. Two earlier revisions got this wrong --
        // one counted "no correction arrived" as a rejection, which scores
        // every good step as bad; the other reverted to authPos whenever it
        // differed, which stomped a correct position with a stale one and threw
        // the player back to the map spawn.
        const auth = st.authPos;
        if (!auth) { stalled++; }
        else if (auth.x === nx && auth.y === ny) {
            stalled = 0;                       // accepted
        } else if (auth.x === from.x && auth.y === from.y) {
            // Refused. Put the local position back where the server still thinks
            // we are, so the next route is computed from reality.
            st.pos = { x: from.x, y: from.y, z: st.pos.z };
            if (++stalled > 8) return 'blocked';
        } else {
            // The server put us somewhere else entirely -- a traversal, or a
            // correction. Trust it and re-route from there.
            st.pos = { x: auth.x, y: auth.y, z: st.pos.z };
            stalled = 0;
        }
    }
    return 'blocked';
}

async function main() {
    const CFG = require('../server/config');
    const MAP = require('../server/map');
    const server = new ServerController({ port: PORT, dbFile: DB_FILE, testMode: true });
    const url = `ws://127.0.0.1:${PORT}`;
    let a = null, b = null;
    const keepAlive = [];

    try {
        await server.start();
        console.log(`\n=== Z-LEVEL STAGE 2: LIVE TRAVERSAL VERIFICATION ===`);
        console.log(`  port ${PORT} | surface ladder at ${CFG.LADDER_X},${CFG.LADDER_Y} | dungeon z=${CFG.Z_DUNGEON}\n`);

        a = await connect(url);
        b = await connect(url);
        check('both clients connected and logged in', await login(a, 'Descender', 'warrior') && await login(b, 'Watcher', 'ranger'));
        await sleep(500);
        // Both characters need to be able to stand in a populated cave: `a` to
        // walk it, `b` to be attacked by nothing while stacked underneath it.
        await prepareForDungeon(a);
        await prepareForDungeon(b);
        // Collected into an array declared outside the try: a `const` bound
        // inside try is not in scope in finally, so naming them here and
        // referencing them there threw a ReferenceError during teardown -- after
        // every check had already passed.
        keepAlive.push(startUndergroundKeepAlive(a));
        keepAlive.push(startUndergroundKeepAlive(b));

        // 1. same-floor presence
        check('a same-floor client sees the other player',
            [...a.players.values()].some(p => p.name === 'Watcher') || [...b.players.values()].some(p => p.name === 'Descender'),
            `a sees ${a.players.size}, b sees ${b.players.size}`);

        const startZ = a.currentZ;
        check('login put the player on the surface', startZ === CFG.Z_SURFACE, `z=${startZ}`);

        // 9. the ladder tile must be enterable at all. Arriving on it *is* the
        // descent, so "reached the tile" and "changed floor" are the same
        // event -- requiring a standing position on z=0 would be asserting that
        // the feature does not work.
        const ladder = await walkTo(a, CFG.LADDER_X, CFG.LADDER_Y);
        await sleep(700);
        const descended = a.currentZ === CFG.Z_DUNGEON;
        check('the ladder tile was enterable (step onto it was not rejected)',
            ladder === 'changed-floor' || descended,
            `walk=${ladder} currentZ=${a.currentZ} pos=${a.pos.x},${a.pos.y}`);

        // 2. the descent itself
        check('walking onto the ladder moved the player to the dungeon', descended,
            `currentZ=${a.currentZ} (surface=${CFG.Z_SURFACE}, dungeon=${CFG.Z_DUNGEON})`);

        if (descended) {
            // 3. the floor index reached the client
            check('map_data carried the new floor index', a.terrainZ === CFG.Z_DUNGEON, `z=${a.terrainZ}`);
            check('force_position told the client the new position and floor',
                a.pos.z === CFG.Z_DUNGEON, `pos=${a.pos.x},${a.pos.y},z=${a.pos.z}`);

            // 4. the terrain is the cave's, not the surface's
            const types = new Set((a.terrain || []).map(o => o.type));
            check('the dungeon terrain arrived and is the cave', (a.terrain || []).length > 0 && types.has('cave_wall'),
                `${(a.terrain || []).length} tiles, types=${[...types].join(',')}`);
            check('the ladder is in the terrain so it can be drawn',
                (a.terrain || []).some(o => o.type === 'stairs_up'), `types=${[...types].join(',')}`);

            // 5. the dungeon is not populated with surface mobs
            const mobZ = new Set([...a.mobs.values()].map(m => m.z));
            check('no mob from another floor was sent to the dungeon',
                [...mobZ].every(z => z === CFG.Z_DUNGEON), `mob floors=${[...mobZ].join(',') || 'none'}`);

            // 10. position is inside the cave, not beside it
            const insideCave = a.pos.x >= CFG.DUNGEON_ORIGIN_X &&
                a.pos.x <= CFG.DUNGEON_ORIGIN_X + (CFG.DUNGEON_TILES_W - 1) * TILE &&
                a.pos.y >= CFG.DUNGEON_ORIGIN_Y &&
                a.pos.y <= CFG.DUNGEON_ORIGIN_Y + (CFG.DUNGEON_TILES_H - 1) * TILE;
            check('the player arrived inside the cave footprint', insideCave, `pos=${a.pos.x},${a.pos.y}`);

            // 6. the surface watcher no longer sees them
            await sleep(900);
            const stillVisible = [...b.players.values()].some(p => p.name === 'Descender');
            check('the surface client no longer lists the player who descended', !stillVisible,
                stillVisible ? 'still present in players_sync' : 'removed');

            // 7. cross-floor isolation, against the live server.
            // Assert the EFFECT, not a rejection message: the NPC branches that
            // return early do so silently, so requiring an error text would pass
            // for the wrong reason and fail for a cosmetic one. What must not
            // happen is the bank panel opening.
            let bankOpened = false;
            a.on.packet = p => { if (p.action === 'bank_open') bankOpened = true; };
            send(a, { action: 'talk_npc', npc_id: 'n_banker' });
            await sleep(700);
            a.on.packet = () => {};
            check('a dungeon player cannot open a surface NPC panel', !bankOpened,
                bankOpened ? 'bank_open arrived from the cave' : 'no panel opened');

            // and no chest from another floor is rostered into the dungeon
            let chestLeak = false;
            a.on.packet = p => { if (p.action === 'chest_update' && (p.z ?? 0) !== CFG.Z_DUNGEON) chestLeak = true; };
            await sleep(500);
            a.on.packet = () => {};
            check('no surface chest was rostered into the dungeon', !chestLeak,
                chestLeak ? 'a chest from another floor arrived' : 'clean');

            // --- Stage 3 -----------------------------------------------------
            // Checked here, while one client is below and one is above. The
            // same checks placed after the climb-out read an empty roster and
            // reported the dungeon as unpopulated, because the client had
            // correctly flushed its caches on the way back up.
            const dungeonMobs = [...a.mobs.values()].filter(m => m.z === CFG.Z_DUNGEON);
            check('the dungeon roster is populated with mobs', dungeonMobs.length > 0,
                `${dungeonMobs.length} mobs on z=${CFG.Z_DUNGEON}`);
            check('every mob sent to the dungeon is on the dungeon floor',
                a.mobs.size > 0 && [...a.mobs.values()].every(m => m.z === CFG.Z_DUNGEON),
                `floors present: ${[...new Set([...a.mobs.values()].map(m => m.z))].join(',')}`);

            // The surface client must never hear about a dungeon mob at all.
            const leaked = [...b.mobs.values()].filter(m => m.z !== CFG.Z_SURFACE);
            check('no dungeon mob leaked to the surface client', leaked.length === 0,
                leaked.length ? `${leaked.length} leaked: ${leaked.slice(0, 3).map(m => m.type).join(' ')}` : 'clean');

            // Dungeon mobs are tougher than their surface namesakes, which is
            // the entire point of the tier.
            const { getMobStats } = require('../server/mobs');
            const sample = dungeonMobs[0];
            if (sample) {
                const surfaceStats = getMobStats(sample.type, false, 1);
                check('a dungeon mob is tougher than the same type on the surface',
                    sample.maxHp > surfaceStats.hp,
                    `${sample.name} hp=${sample.maxHp} vs surface ${surfaceStats.hp} (tier ${CFG.DUNGEON_MOB_TIER})`);
            }

            // dist3D against a real entity: a surface player standing at a
            // dungeon's exact coordinates must be untouchable by the mobs there.
            // The dungeon and the city share X/Y space, so this is not synthetic.
            if (sample) {
                const bHpBefore = (b.status && b.status.hp) || 0;
                b.pos = { x: sample.x, y: sample.y, z: CFG.Z_SURFACE };
                b.packets.length = 0;
                // Kept short on purpose: this client stands still in a populated
                // cave for the duration, and a level 1 character loses that
                // fight. The point of the check is that the surface player takes
                // no damage at all, which a shorter window proves just as well.
                const until = Date.now() + 3500;
                while (Date.now() < until) {
                    send(b, { action: 'move', x: sample.x, y: sample.y });
                    await sleep(180);
                    send(b, { action: 'move', x: sample.x, y: sample.y + CFG.TILE_SIZE });
                    await sleep(180);
                }
                const bHpAfter = (b.status && b.status.hp) || 0;
                check('a surface player stacked under a dungeon mob takes no damage',
                    bHpAfter >= bHpBefore, `hp ${bHpBefore} -> ${bHpAfter}`);
                const floatsOnB = b.packets.filter(p => p.action === 'fct' && /^-/.test(p.text || ''));
                check('the surface client saw no damage text from the dungeon',
                    floatsOnB.length === 0,
                    `${floatsOnB.length} damage floats: ${floatsOnB.slice(0, 3).map(f => f.text).join(' ')}`);
                b.pos = { x: 320, y: 320, z: CFG.Z_SURFACE };
            }

            // 8b. a second descent, to prove the chain is not a one-off
            const deeper = CFG.Z_FLOORS.map(f => f.z).sort((x, y) => x - y)[0];
            if (deeper < a.currentZ) {
                const shaft = [...MAP.getFloor(a.currentZ).transitions.values()]
                    .find(t => MAP.normalizeZ(t.to) === deeper);
                check('the crypt offers a way further down', !!shaft,
                    shaft ? `${shaft.type} at ${shaft.x},${shaft.y}` : 'no descent found');
                if (shaft) {
                    const atShaft = await walkTo(a, shaft.x, shaft.y);
                    check('the player can reach the shaft',
                        atShaft === 'changed-floor' || atShaft === 'arrived',
                        `walk=${atShaft} at ${a.pos.x},${a.pos.y}, wanted ${shaft.x},${shaft.y}`);
                    await sleep(800);
                    check('walking onto the shaft descended a second floor', a.currentZ === deeper,
                        `currentZ=${a.currentZ}, wanted ${deeper}`);
                    if (a.currentZ === deeper) {
                        check('the deepest floor sent its own terrain',
                            (a.terrain || []).length > 0 && !!a.bounds && a.bounds.minX > 0,
                            `${(a.terrain || []).length} tiles, bounds=${JSON.stringify(a.bounds)}`);
                        const deepMobs = [...a.mobs.values()].filter(m => m.z === deeper);
                        check('the deepest floor is populated too', deepMobs.length > 0,
                            `${deepMobs.length} mobs on z=${deeper}`);
                        const deepLeak = [...b.mobs.values()].filter(m => m.z !== CFG.Z_SURFACE);
                        check('nothing from the deepest floor reached the surface client',
                            deepLeak.length === 0,
                            deepLeak.length
                                ? `${deepLeak.length} at floors ${[...new Set(deepLeak.map(m => m.z))].join(',')}: ` +
                                  deepLeak.slice(0, 3).map(m => `${m.type}@${m.x},${m.y}`).join(' ')
                                : 'clean');
                    }
                }
            }

            // 8. climb back out, retracing the whole chain.
            //
            // The player may be on the deepest floor by now, so the way out is
            // found from wherever they actually are rather than from a floor
            // assumed in advance. Retracing link by link is the stronger check
            // anyway: it proves the chain is reversible, not merely that stairs
            // exist.
            if (a.died) {
                check('the player survived long enough to climb back out', false,
                    `slain underground; respawned to z=${a.currentZ} at ${a.pos.x},${a.pos.y}`);
            }
            while (!a.died && a.currentZ < CFG.Z_SURFACE) {
                const here = MAP.getFloor(a.currentZ);
                if (!here) break;
                const up = [...here.transitions.values()]
                    .find(t => MAP.normalizeZ(t.to) > a.currentZ);
                if (!up) {
                    check(`floor z=${a.currentZ} offers a way up`, false, 'no exit found');
                    break;
                }
                const fromZ = a.currentZ;
                const atUp = await walkTo(a, up.x, up.y);
                if (atUp !== 'arrived' && atUp !== 'changed-floor') {
                    check(`reached the stairs on z=${fromZ}`, false,
                        `walk=${atUp} at ${a.pos.x},${a.pos.y}, wanted ${up.x},${up.y}`);
                    break;
                }
                await sleep(700);
                check(`climbed from z=${fromZ} to z=${MAP.normalizeZ(up.to)}`,
                    a.currentZ === MAP.normalizeZ(up.to), `currentZ=${a.currentZ}`);
            }

            check('climbing the chain returned the player to the surface', a.currentZ === CFG.Z_SURFACE,
                `currentZ=${a.currentZ}`);
            check('climbing out landed back on the surface ladder',
                a.pos.x === CFG.LADDER_X && a.pos.y === CFG.LADDER_Y, `pos=${a.pos.x},${a.pos.y}`);

            // 10. persistence across a reconnect
            a.ws.close();
            await sleep(700);
            const c = await connect(url);
            const backIn = await login(c, 'Descender', 'warrior');
            await sleep(800);
            check('the floor survives a reconnect', backIn && c.currentZ === CFG.Z_SURFACE,
                `reconnected z=${c.currentZ}`);
            c.ws.close();
        }

        // the surface player must be unaffected by any of this
        check('the surface player never changed floor', b.currentZ === CFG.Z_SURFACE, `z=${b.currentZ}`);
        check('the surface client kept the surface terrain',
            (b.terrain || []).length > 0 && new Set(b.terrain.map(o => o.type)).has('tree'),
            `${(b.terrain || []).length} tiles`);

    } catch (err) {
        failures++;
        console.error('  verification crashed:', err && err.stack ? err.stack : err);
    } finally {
        for (const stop of keepAlive) {
            try { stop(); } catch { /* ignore */ }
        }
        keepAlive.length = 0;
        for (const s of [a, b]) {
            try { if (s && s.ws.readyState === 1) s.ws.close(); } catch { /* ignore */ }
        }
        try { await server.stop(true); } catch { /* ignore */ }
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
            require('fs').rmSync(DB_FILE.replace(/\.json$/, '.sqlite') + suffix, { force: true });
            require('fs').rmSync(DB_FILE + suffix, { force: true });
        }
    }

    console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('\nverification crashed:', err); process.exit(1); });
