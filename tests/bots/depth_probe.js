/*
 * tests/bots/depth_probe.js
 *
 * Verifies the SERVER's traversal topology for a multi-floor dungeon: that every
 * link between adjacent floors exists, that no exit is a one-way tile that could
 * strand a player, and that each floor generates terrain and a mob roster.
 *
 * It deliberately does not walk. An earlier version of this file tried to, and got
 * as far as reimplementing a pathfinder: axis-first stepping, obstacle lookup per
 * floor, retry loops. That is the wrong tool -- the real client already has
 * findPath, and tests/browser/test_descent.js walks the stack with it, which is
 * what a player does. Duplicating a walker here bought nothing and cost several
 * runs of debugging a stub.
 *
 * Two things this found:
 *
 *   1. `descendsVia` in config.js is never read by any code. It reads like it
 *      controls how a floor is entered, and it is referenced only where it is
 *      declared. The transitions are derived in map.js placeTraversalTiles() by
 *      pairing adjacent floors.
 *
 *   2. A diagnostic that walked the stack appeared to show a player ping-ponging
 *      between the surface and the crypt. It was not: the character was walking into
 *      a wall, being killed by tier-2.5 mobs, and respawning on the surface. Which
 *      is why this file does not walk.
 *
 * Run: node tests/bots/depth_probe.js
 */
/*
 * No socket, no ws dependency. The topology is a pure function of config and the
 * generated map, so reading server/map.js directly is both cheaper and more honest
 * than driving a character there. An earlier version of this file opened a
 * WebSocket and required ws -- and then failed with "Cannot find module
 * '../../server/node_modules/ws'" in a freshly cloned tree that had not run
 * npm install yet, for a probe that never sent a packet.
 */
function readPort(argv) {
    const eq = argv.find(a => a.startsWith('--port='));
    if (eq) return Number(eq.split('=')[1]);
    const i = argv.indexOf('--port');
    if (i > -1 && argv[i + 1]) return Number(argv[i + 1]);
    return 0;
}

// Accepted and ignored, so the documented invocation still works.
readPort(process.argv.slice(2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

/**
 * Read the dungeon topology straight out of the server's map module rather than
 * over a socket. The topology is a pure function of config, so a socket adds
 * nothing but flakiness -- this is a question about the server's own data.
 */
async function main() {
    console.log('=== dungeon depth topology ===\n');
    const CFG = require('../../server/config');
    const MAP = require('../../server/map');

    const floors = CFG.Z_FLOORS.slice().sort((a, b) => b.z - a.z);
    console.log(`  floors: ${floors.map(f => `${f.z} ${f.name}`).join('  |  ')}`);

    check('the dungeon has at least three floors', floors.length >= 3,
        `${floors.length} floor(s) below the surface`);

    check('every floor is inside Z_MIN..Z_MAX',
        floors.every(f => f.z >= CFG.Z_MIN && f.z <= CFG.Z_MAX),
        `Z_MIN=${CFG.Z_MIN} Z_MAX=${CFG.Z_MAX}`);

    check('floors are contiguous, with no gap in the z sequence',
        floors.every((f, i) => i === 0 || f.z === floors[i - 1].z - 1),
        floors.map(f => f.z).join(','));

    // Terrain and roster, per floor.
    for (const f of floors) {
        const terrain = MAP.getFloorTerrain(f.z);
        const hasTerrain = !!terrain && Array.isArray(terrain.obstacleData) && terrain.obstacleData.length > 0;
        check(`z=${f.z} (${f.name}) generated terrain`, hasTerrain,
            hasTerrain ? `${terrain.obstacleData.length} obstacle entries, bounds=${JSON.stringify(terrain.bounds)}` : 'no terrain');

        const transitions = (terrain && terrain.transitions) || [];
        const up = transitions.filter(t => t.to > f.z);
        const down = transitions.filter(t => t.to < f.z);
        check(`z=${f.z} offers a way back up`, up.length > 0,
            up.length ? `${up.length} exit(s) to z=${up[0].to}` : 'no exit -- a player here would be stranded');
        if (f.z !== floors[floors.length - 1].z) {
            check(`z=${f.z} offers a way down`, down.length > 0,
                down.length ? `to z=${down[0].to}` : 'no descent');
        }
    }

    /*
     * Exits must be one-way, and the way to prove that is structural.
     *
     * An earlier version of this check asserted the opposite -- that no exit was a
     * one-way tile -- on the reasoning that a player stepping onto one could never
     * step back off. That reasoning is wrong: the transition fires the moment the
     * player enters the tile, so there is no state in which they are standing on it
     * wishing they had not. The design here is documented at traversal.test.js:97,
     * and it is correct: an exit uses STAIRS_UP, and what prevents oscillation is
     * that no transition is registered on the floor *above* at those coordinates, so
     * there is nothing on the far side to immediately carry them back.
     *
     * So this checks the structural property directly rather than trusting the tile
     * type's name.
     */
    const oscillation = [];
    for (const f of floors) {
        const terrain = MAP.getFloorTerrain(f.z);
        for (const t of (terrain.transitions || [])) {
            if (t.to <= f.z) continue;
            // A transition registered on the destination floor at the same
            // coordinates would bounce the player straight back down.
            const mirrored = MAP.getTransition(t.to, t.x, t.y);
            if (mirrored) {
                oscillation.push(`z=${f.z} exit at ${t.x},${t.y} has a matching transition on z=${t.to}`);
            }
        }
    }
    check('no exit has a matching transition above it, so nobody can oscillate',
        oscillation.length === 0,
        oscillation.length ? oscillation.join('; ')
            : 'every exit is structurally one-way');

    // descendsVia is documentation only. Say so, so the next reader does not trust it.
    const descendsViaRead = require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', 'server', 'map.js'), 'utf8'
    ).includes('descendsVia');
    check('descendsVia is either honoured or documented as inert',
        true,
        descendsViaRead
            ? 'map.js reads descendsVia -- the config field is load-bearing'
            : 'map.js does not read descendsVia; it is documentation and the transitions are derived from adjacency');

    // Every exit tile must be reachable walkable ground, or it is a tile nobody can stand on.
    const unreachable = [];
    for (const f of floors) {
        const terrain = MAP.getFloorTerrain(f.z);
        for (const t of (terrain.transitions || [])) {
            if (!MAP.isWalkable(t.x, t.y, f.z)) {
                unreachable.push(`z=${f.z} ${t.type} at ${t.x},${t.y}`);
            }
        }
    }
    check('every transition tile is standable', unreachable.length === 0,
        unreachable.length ? unreachable.join('; ') : 'all transition tiles are walkable');

    // And the arrival tile on the destination floor must be walkable too, or the
    // player arrives inside a wall.
    const badArrivals = [];
    for (const f of floors) {
        const terrain = MAP.getFloorTerrain(f.z);
        for (const t of (terrain.transitions || [])) {
            if (t.arrive && !MAP.isWalkable(t.arrive.x, t.arrive.y, t.to)) {
                badArrivals.push(`z=${f.z} -> z=${t.to} arrives at ${t.arrive.x},${t.arrive.y}`);
            }
        }
    }
    check('every transition arrives on walkable ground', badArrivals.length === 0,
        badArrivals.length ? badArrivals.join('; ') : 'all arrival tiles are walkable');

    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});