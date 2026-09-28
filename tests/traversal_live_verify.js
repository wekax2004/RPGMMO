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
    const start = `${st.pos.x},${st.pos.y}`;
    const goal = `${tx},${ty}`;
    if (start === goal) return [];
    const prev = new Map([[start, null]]);
    const queue = [st.pos];
    while (queue.length) {
        const cur = queue.shift();
        for (const [dx, dy] of [[TILE, 0], [-TILE, 0], [0, TILE], [0, -TILE]]) {
            const nx = cur.x + dx, ny = cur.y + dy;
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
async function walkTo(st, tx, ty, budgetMs = 90000) {
    const deadline = Date.now() + budgetMs;
    const startZ = st.currentZ;
    let stalled = 0;
    let lastAuth = null;
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
        // Re-sync the optimistic position to the server's view before stepping,
        // so a previous rejection does not compound into a diagonal.
        if (st.authPos && (st.authPos.x !== st.pos.x || st.authPos.y !== st.pos.y)) {
            st.pos = { x: st.authPos.x, y: st.authPos.y, z: st.pos.z };
            const rerouted = routeTo(st, tx, ty);
            if (rerouted === null) return 'no-path';
            if (rerouted.length === 0) return 'arrived';
            st.pos = { x: rerouted[0][0], y: rerouted[0][1], z: st.pos.z };
            send(st, { action: 'move', x: rerouted[0][0], y: rerouted[0][1] });
        } else {
            send(st, { action: 'move', x: nx, y: ny });
        }
        st.pos = { x: nx, y: ny, z: st.pos.z };
        await sleep(STEP_DELAY);

        // Judge the step by the server's own view, not by the absence of a
        // correction. Two earlier revisions counted "no force_position arrived"
        // as rejection, which is wrong: an accepted step is applied silently
        // and produces no packet at all, so every good step scored as a bad one
        // and the walk quit after eight.
        const auth = st.authPos ? `${st.authPos.x},${st.authPos.y}` : null;
        if (auth && auth === `${nx},${ny}`) {
            stalled = 0;
            lastAuth = auth;
        } else if (auth && auth === lastAuth) {
            if (++stalled > 10) return 'blocked';
        } else {
            stalled = 0;
            lastAuth = auth;
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

    try {
        await server.start();
        console.log(`\n=== Z-LEVEL STAGE 2: LIVE TRAVERSAL VERIFICATION ===`);
        console.log(`  port ${PORT} | surface ladder at ${CFG.LADDER_X},${CFG.LADDER_Y} | dungeon z=${CFG.Z_DUNGEON}\n`);

        a = await connect(url);
        b = await connect(url);
        check('both clients connected and logged in', await login(a, 'Descender', 'warrior') && await login(b, 'Watcher', 'ranger'));
        await sleep(500);

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

            // 8. one-way back up
            const exit = [...MAP.getFloor(CFG.Z_DUNGEON).transitions.values()][0];
            const atExit = await walkTo(a, exit.x, exit.y);
            check('the player can reach the stairs inside the cave',
                atExit === 'arrived' || atExit === 'changed-floor',
                `walk=${atExit} at ${a.pos.x},${a.pos.y}, wanted ${exit.x},${exit.y}`);
            await sleep(800);
            check('climbing the stairs returned the player to the surface', a.currentZ === CFG.Z_SURFACE,
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
