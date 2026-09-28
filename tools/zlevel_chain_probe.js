'use strict';
/**
 * Walks the Z-level chain and proves every link is actually reachable.
 *
 * This is the check that a single hard-coded dungeon cannot give you. Starting
 * from the city spawn, it floods each floor, finds the transitions standing on
 * reachable ground, and follows them. If any floor's exit cannot be walked to
 * from where the player arrives, the world is not traversable end to end and a
 * descent ends in a soft-lock.
 *
 * The flood has to exempt traversal tiles from the obstacle set, exactly as the
 * client does. They are listed in obstacleData so the renderer draws them, but
 * they are walked ONTO -- an earlier version of this probe treated them as
 * solid and therefore concluded that no floor had any reachable transition,
 * which was a bug in the probe and looked exactly like a broken world.
 *
 * Run:  node tools/zlevel_chain_probe.js
 */
const MAP = require('../server/map');
const CFG = require('../server/config');
const T = CFG.TILE_SIZE;
const TRAVERSAL = new Set(['ladder', 'stairs_up', 'stairs_down']);

let failures = 0;
function check(label, ok, detail) {
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
}

function floodWalkable(z) {
    const b = MAP.getFloorBounds(z);
    if (!b) return null;
    const terrain = MAP.getFloorTerrain(z);
    const solid = new Set(
        terrain.obstacleData
            .filter(o => !TRAVERSAL.has(o.type))
            .map(o => `${o.x},${o.y}`)
    );
    return { bounds: b, solid };
}

// Every standable tile on a floor, and the transitions among them.
function flood(z, from) {
    const w = floodWalkable(z);
    if (!w) return { reached: new Set(), transitions: [] };
    const seen = new Set([`${from.x},${from.y}`]);
    const queue = [from];
    const transitions = [];
    while (queue.length) {
        const c = queue.shift();
        const tr = MAP.getTransition(z, c.x, c.y);
        if (tr) transitions.push(tr);
        for (const [dx, dy] of [[T, 0], [-T, 0], [0, T], [0, -T]]) {
            const nx = c.x + dx, ny = c.y + dy;
            if (nx < w.bounds.minX || ny < w.bounds.minY ||
                nx > w.bounds.maxX || ny > w.bounds.maxY) continue;
            const key = `${nx},${ny}`;
            if (w.solid.has(key) || seen.has(key)) continue;
            seen.add(key);
            queue.push({ x: nx, y: ny });
        }
    }
    return { reached: seen, transitions };
}

console.log('=== Z-level chain ===\n');
console.log(`  city spawn  : 320,320`);
console.log(`  city ladder : ${CFG.LADDER_X},${CFG.LADDER_Y}`);
console.log(`  floors      : ${CFG.Z_FLOORS.map(f => `${f.name} (z=${f.z})`).join(', ')}\n`);

// The city ladder must be walkable to from the spawn, or the mechanic is
// undiscoverable no matter how correct the rest of it is.
const city = flood(CFG.Z_SURFACE, { x: 320, y: 320 });
const ladderHere = city.transitions.find(t => t.type === 'ladder');
check('the city ladder is reachable on foot from the spawn', !!ladderHere,
    ladderHere ? `reached z=${ladderHere.to}` : `${city.reached.size} tiles walked, no ladder found`);

if (!ladderHere) {
    console.log('\n  cannot continue without the ladder.');
    process.exit(1);
}

// Follow the chain: each floor's arrival, then flood it for what it offers.
let current = ladderHere;
const visitedFloors = new Set([CFG.Z_SURFACE]);
for (let depth = 0; depth < 8; depth++) {
    const z = current.to;
    if (visitedFloors.has(z)) {
        check(`floor z=${z} is not a loop back onto itself`, false, 'chain revisits a floor');
        break;
    }
    visitedFloors.add(z);
    const spec = CFG.Z_FLOORS.find(f => f.z === z);
    if (!spec) { check(`floor z=${z} exists in the config table`, false); break; }

    const { reached, transitions } = flood(z, current.arrive);
    check(`${spec.name}: arrived on standable ground`, MAP.isWalkable(current.arrive.x, current.arrive.y, z),
        `${current.arrive.x},${current.arrive.y}`);
    check(`${spec.name}: can be walked around`, reached.size > 20, `${reached.size} reachable tiles`);
    check(`${spec.name}: offers a way back up`, transitions.some(t => t.to > z),
        transitions.map(t => `${t.type}->z${t.to}`).join(', ') || 'no transitions on reachable ground');

    const deeper = transitions.find(t => t.to < z);
    if (!deeper) {
        console.log(`\n  ${spec.name} is the deepest floor: the chain ends here.`);
        break;
    }
    console.log(`         descending via ${deeper.type} to z=${deeper.to}`);
    current = deeper;
}

const allFloorsReachable = CFG.Z_FLOORS.every(f => visitedFloors.has(f.z));
check('every configured floor is reachable from the city', allFloorsReachable,
    `visited ${[...visitedFloors].sort((a, b) => b - a).join(', ')}`);

console.log(`\n=== ${failures === 0 ? 'CHAIN IS WALKABLE END TO END' : failures + ' PROBLEM(S)'} ===\n`);
process.exit(failures === 0 ? 0 : 1);
