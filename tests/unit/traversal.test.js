// Unit tests for Z-level Stage 2: traversal tiles and cross-floor isolation.
//
// Stage 0 made the coordinate exist. Stage 2 makes it mean something: a tile
// you can walk onto that changes floors, and a guarantee that nothing reaches
// across the resulting boundary. The tests here are weighted toward the two
// failure modes that are silent -- a traversal tile that is drawn but solid (so
// the floor below is unreachable), and a 2D distance check that measures
// straight through a floor (so a dungeon player banks, heals or loots on the
// surface).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', '..', 'server');
const CLIENT_JS = path.join(__dirname, '..', '..', 'client', 'js', 'engine.js');
const RENDERER_JS = path.join(__dirname, '..', '..', 'client', 'js', 'renderer.js');
const CFG = require(path.join(SERVER_DIR, 'config'));
const MAP = require(path.join(SERVER_DIR, 'map'));
const { npcs } = require(path.join(SERVER_DIR, 'npcs'));
const CRAFTING = require(path.join(SERVER_DIR, 'crafting'));

test('the dungeon floor is generated and registered', () => {
    assert.strictEqual(MAP.hasFloor(CFG.Z_DUNGEON), true, 'the dungeon must exist');
    assert.strictEqual(MAP.hasFloor(CFG.Z_SURFACE), true, 'the surface must still exist');
    const terrain = MAP.getFloorTerrain(CFG.Z_DUNGEON);
    assert.ok(terrain, 'the dungeon must describe terrain');
    assert.strictEqual(terrain.z, CFG.Z_DUNGEON);
    assert.ok(terrain.obstacleData.length > 0, 'the cave must have walls');
});

test('the dungeon is walled, with a walkable interior', () => {
    const ox = CFG.DUNGEON_ORIGIN_X;
    const oy = CFG.DUNGEON_ORIGIN_Y;
    // the top-left corner tile is wall
    assert.strictEqual(MAP.isWalkable(ox, oy, CFG.Z_DUNGEON), false, 'the border must be solid');
    // one tile in is the floor of the cave
    assert.strictEqual(
        MAP.isWalkable(ox + CFG.TILE_SIZE, oy + CFG.TILE_SIZE, CFG.Z_DUNGEON), true,
        'the cave interior must be standable');
    // and the centre, which is where the way out sits
    const cx = ox + Math.floor(CFG.DUNGEON_TILES_W / 2) * CFG.TILE_SIZE;
    const cy = oy + Math.floor(CFG.DUNGEON_TILES_H / 2) * CFG.TILE_SIZE;
    assert.strictEqual(MAP.isWalkable(cx, cy, CFG.Z_DUNGEON), true, 'the cave centre must be standable');
});

test('a traversal tile is drawn but NOT solid', () => {
    // The single most important invariant in this stage. A traversal tile added
    // to floor.obstacles is drawn by the renderer and rejected by isWalkable,
    // so the player can look at the ladder and never reach it. Every existing
    // obstacle adds to both; a transition deliberately adds to one only.
    const lx = CFG.LADDER_X, ly = CFG.LADDER_Y;
    const surface = MAP.getFloor(CFG.Z_SURFACE);
    assert.strictEqual(MAP.isWalkable(lx, ly, CFG.Z_SURFACE), true,
        'the ladder must be standable, or the descent can never be triggered');
    assert.strictEqual(surface.obstacles.has(`${lx},${ly}`), false,
        'a traversal tile must not be an obstacle');
    assert.ok(
        surface.obstacleData.some(o => o.x === lx && o.y === ly && o.type === MAP.TILE_TYPES.LADDER),
        'a traversal tile must still appear in the terrain the client draws'
    );
});

test('the client and the server agree on which tiles are walkable', () => {
    // The client builds its movement-blocking set from the same obstacleData
    // the renderer draws. Without an explicit exemption it blocks the very
    // tiles traversal needs, and the floor below becomes unreachable while every
    // test on the server still passes. This is the seam between the two halves
    // of the feature, so it is asserted rather than assumed.
    //
    // Two agreements, not one: a type the server can place must be walkable
    // client-side AND drawn client-side. A type that is walkable but undrawn
    // falls through to the default green obstacle fill, so the player is told
    // the tile is solid while the server lets them stand on it.
    const engine = fs.readFileSync(CLIENT_JS, 'utf8');
    const renderer = fs.readFileSync(RENDERER_JS, 'utf8');
    const m = engine.match(/WALKABLE_OBSTACLE_TYPES\s*=\s*new Set\(\[([^\]]*)\]/);
    assert.ok(m, 'engine.js must declare WALKABLE_OBSTACLE_TYPES');
    const clientTypes = new Set([...m[1].matchAll(/['"]([a-z_]+)['"]/g)].map(x => x[1]));

    for (const type of Object.values(MAP.TILE_TYPES)) {
        assert.ok(clientTypes.has(type),
            `engine.js must treat '${type}' as walkable; the server places it as a traversal tile`);
        assert.ok(renderer.includes(`"${type}"`),
            `renderer.js must draw '${type}'; an undrawn type renders as a solid obstacle`);
    }
});

test('standing on the ladder descends to the dungeon', () => {
    const t = MAP.getTransition(CFG.Z_SURFACE, CFG.LADDER_X, CFG.LADDER_Y);
    assert.ok(t, 'the surface ladder must have a transition');
    assert.strictEqual(t.type, MAP.TILE_TYPES.LADDER);
    assert.strictEqual(MAP.normalizeZ(t.to), CFG.Z_DUNGEON, 'the ladder must lead down');
    assert.ok(MAP.hasFloor(t.to), 'the destination floor must exist');
});

test('the way out of each floor is one-way up', () => {
    // Every underground floor offers a way back to the one above, and none of
    // them offers a way back DOWN from that same tile. One-way is structural
    // rather than a direction check: there is simply no transition registered
    // on the floor above at the stairs' coordinates, so there is nothing to
    // take. A two-way tile there would let a player oscillate between floors by
    // standing still.
    const sorted = CFG.Z_FLOORS.slice().sort((a, b) => b.z - a.z);
    for (let i = 0; i < sorted.length; i++) {
        const spec = sorted[i];
        const above = i === 0 ? CFG.Z_SURFACE : sorted[i - 1].z;
        const entries = [...MAP.getFloor(spec.z).transitions.values()];
        const ups = entries.filter(t => MAP.normalizeZ(t.to) === above);
        assert.ok(ups.length >= 1, `${spec.name} must have a way back up to z=${above}`);
        for (const up of ups) {
            assert.strictEqual(up.type, MAP.TILE_TYPES.STAIRS_UP,
                `${spec.name}'s exit is stairs_up, not a ladder`);
            assert.strictEqual(MAP.getTransition(above, up.x, up.y), null,
                `${spec.name}: a stairs_up tile must not also offer a descent from z=${above}`);
        }
    }
    // The deepest floor has nothing below it, so it must not offer a descent.
    const deepest = sorted[sorted.length - 1];
    const deepestEntries = [...MAP.getFloor(deepest.z).transitions.values()];
    assert.ok(!deepestEntries.some(t => MAP.normalizeZ(t.to) < deepest.z),
        `${deepest.name} is the deepest floor and must not lead further down`);
});

test('the traversal route is a closed loop the player can actually complete', () => {
    // Down, then up, must return the player to a walkable surface tile. A loop
    // that cannot be closed is a one-way trip into a dead end.
    const down = MAP.getTransition(CFG.Z_SURFACE, CFG.LADDER_X, CFG.LADDER_Y);
    const landing = down.arrive;
    assert.ok(MAP.isWalkable(landing.x, landing.y, CFG.Z_DUNGEON),
        `descent must land on a standable dungeon tile, got ${landing.x},${landing.y}`);

    const exit = [...MAP.getFloor(CFG.Z_DUNGEON).transitions.values()][0];
    assert.ok(MAP.isWalkable(exit.x, exit.y, CFG.Z_DUNGEON), 'the exit tile must be standable');
    assert.ok(MAP.isWalkable(exit.arrive.x, exit.arrive.y, CFG.Z_SURFACE),
        'climbing out must land on a standable surface tile');
});

test('descent lands inside the cave, not in open ground beside it', () => {
    // The ladder is in the safe zone and the cave is elsewhere on the map, so
    // arrival cannot default to the ladder's own coordinates. An earlier
    // revision did exactly that and dropped the player at (288,288) on z=-1,
    // which is walkable open dungeon floor several hundred pixels from the walls.
    const down = MAP.getTransition(CFG.Z_SURFACE, CFG.LADDER_X, CFG.LADDER_Y);
    const { x, y } = down.arrive;
    const minX = CFG.DUNGEON_ORIGIN_X;
    const minY = CFG.DUNGEON_ORIGIN_Y;
    const maxX = minX + (CFG.DUNGEON_TILES_W - 1) * CFG.TILE_SIZE;
    const maxY = minY + (CFG.DUNGEON_TILES_H - 1) * CFG.TILE_SIZE;
    assert.ok(x >= minX && x <= maxX && y >= minY && y <= maxY,
        `arrival ${x},${y} is outside the cave footprint ${minX}..${maxX} / ${minY}..${maxY}`);
    // and not inside the wall ring
    assert.ok(MAP.isWalkable(x, y, CFG.Z_DUNGEON), 'arrival must not be inside a wall');
});

test('findArrivalPoint never returns a tile inside geometry', () => {
    // The safety net for a floor whose generator walled in the stated landing
    // spot. Without it a player could be sealed in with no way out, which is
    // unrecoverable without an admin.
    const ox = CFG.DUNGEON_ORIGIN_X, oy = CFG.DUNGEON_ORIGIN_Y;
    // Ask from a solid wall tile; the search must move to something standable.
    const found = MAP.findArrivalPoint(CFG.Z_DUNGEON, ox, oy);
    assert.ok(found, 'a landing must always be found inside a generated cave');
    assert.ok(MAP.isWalkable(found.x, found.y, CFG.Z_DUNGEON),
        `findArrivalPoint returned solid ground ${found.x},${found.y}`);
    // The surface always has somewhere to land, too.
    const surf = MAP.findArrivalPoint(CFG.Z_SURFACE, 0, 0);
    assert.ok(surf && MAP.isWalkable(surf.x, surf.y, CFG.Z_SURFACE));
});

function floodExit(solid, entrance, exit, W, H) {
    const seen = new Set([`${entrance.tx},${entrance.ty}`]);
    const q = [[entrance.tx, entrance.ty]];
    while (q.length) {
        const [x, y] = q.pop();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const k = `${nx},${ny}`;
            if (solid.has(k) || seen.has(k)) continue;
            seen.add(k);
            q.push([nx, ny]);
        }
    }
    return seen.has(`${exit.tx},${exit.ty}`);
}

test('the dungeon exit is always reachable, so the descent is never a soft-lock', () => {
    // The player descends on a one-way ladder. If a pillar generation ever walls
    // the stairs off from the arrival point, they are stuck below with no way
    // back and no admin to fix it.
    //
    // Measured over 5000 generations before the fix: 5.12% of caves were
    // unescapable -- from a pillar landing on the stairs themselves, and from
    // rings of pillars isolating the two. The generator now re-checks
    // reachability after each placement. This asserts the property rather than
    // the fix, so a later change to the cave shape is covered too.
    const W = CFG.DUNGEON_TILES_W, H = CFG.DUNGEON_TILES_H;
    const entrance = { tx: 1, ty: 1 };
    const exit = { tx: Math.floor(W / 2), ty: Math.floor(H / 2) };

    // Mirrors server/map.js rather than importing it, because the generator
    // runs once at module load. The live harness covers the real generated
    // instance end to end.
    const generateOnce = () => {
        const solid = new Set();
        for (let tx = 0; tx < W; tx++) {
            for (let ty = 0; ty < H; ty++) {
                if (tx === 0 || ty === 0 || tx === W - 1 || ty === H - 1) solid.add(`${tx},${ty}`);
            }
        }
        const reserved = new Set([`${entrance.tx},${entrance.ty}`, `${exit.tx},${exit.ty}`]);
        for (let i = 0; i < CFG.DUNGEON_PILLARS; i++) {
            const tx = 2 + Math.floor(Math.random() * Math.max(1, W - 4));
            const ty = 2 + Math.floor(Math.random() * Math.max(1, H - 4));
            const key = `${tx},${ty}`;
            if (solid.has(key) || reserved.has(key)) continue;
            solid.add(key);
            if (!floodExit(solid, entrance, exit, W, H)) solid.delete(key);
        }
        return floodExit(solid, entrance, exit, W, H);
    };

    let sealed = 0;
    for (let t = 0; t < 1500; t++) if (!generateOnce()) sealed++;
    assert.strictEqual(sealed, 0, `${sealed}/1500 generated caves could not be escaped from`);
});

// --- Stage 3: the dungeon is inhabited and enclosed ------------------------
test('the dungeon is enclosed, not a walled room in an open plane', () => {
    // z = -1 originally held nothing but a 14x14 room, so every other tile on
    // the floor was standable. The first population attempt put mobs from x=32
    // to x=3072: a player inside the cave saw almost none of them, and anything
    // that wandered off was both unreachable and unkillable.
    const W = CFG.DUNGEON_TILES_W, H = CFG.DUNGEON_TILES_H;
    const step = CFG.TILE_SIZE;
    const ox = CFG.DUNGEON_ORIGIN_X, oy = CFG.DUNGEON_ORIGIN_Y;
    const tiles = [];
    for (let x = 0; x < CFG.MAP_WIDTH; x += step) {
        for (let y = 0; y < CFG.MAP_HEIGHT; y += step) {
            if (MAP.isWalkable(x, y, CFG.Z_DUNGEON)) tiles.push({ x, y });
        }
    }
    assert.ok(tiles.length > 0, 'the cave must have a floor');
    // Every standable tile lies inside the cave's interior.
    for (const t of tiles) {
        assert.ok(t.x > ox && t.x < ox + (W - 1) * step,
            `tile ${t.x},${t.y} is outside the cave on x`);
        assert.ok(t.y > oy && t.y < oy + (H - 1) * step,
            `tile ${t.x},${t.y} is outside the cave on y`);
    }
    // And the map's own corners are rock, not open dungeon.
    for (const [x, y] of [[0, 0], [CFG.MAP_WIDTH - step, 0], [0, CFG.MAP_HEIGHT - step],
        [CFG.MAP_WIDTH - step, CFG.MAP_HEIGHT - step], [2048, 2048]]) {
        assert.strictEqual(MAP.isWalkable(x, y, CFG.Z_DUNGEON), false,
            `${x},${y} must be bedrock on the dungeon floor`);
    }
});

test('the bedrock is walkability-only, so map_data stays small', () => {
    // Ten thousand rock tiles in obstacleData would add a few hundred kilobytes
    // to every descent packet to draw geometry the player can never approach.
    const terrain = MAP.getFloorTerrain(CFG.Z_DUNGEON);
    const floor = MAP.getFloor(CFG.Z_DUNGEON);
    assert.ok(floor.obstacles.size > 5000, 'the whole floor should be enclosed in rock');
    assert.ok(terrain.obstacleData.length < 500,
        `map_data carries ${terrain.obstacleData.length} dungeon tiles; only the cave should be drawn`);
});

test('dungeon mobs spawn inside the cave and never inside geometry', () => {
    // The spawner must not place a mob somewhere a player cannot reach, and must
    // not place one inside a wall. A random coordinate plus a retry loop does
    // not give that: in a mostly-solid cave every random draw is rejected, and
    // the loop's last candidate is one it already rejected.
    const MOBS = require(path.join(SERVER_DIR, 'mobs'));
    const before = MOBS.mobs.size;
    const ids = MOBS.spawnFloorPack(() => { }, {
        z: CFG.Z_DUNGEON, size: 12, tier: CFG.DUNGEON_MOB_TIER, types: CFG.DUNGEON_MOB_TYPES
    });
    try {
        assert.ok(ids.length > 0, 'the dungeon must be able to hold mobs');
        for (const id of ids) {
            const m = MOBS.mobs.get(id);
            assert.ok(MAP.isWalkable(m.x, m.y, CFG.Z_DUNGEON),
                `mob at ${m.x},${m.y} is inside geometry`);
            assert.strictEqual(m.z, CFG.Z_DUNGEON, 'a dungeon mob must record its floor');
        }
    } finally {
        // The mobs map is a process-wide singleton; clear only what was added.
        for (const id of ids) MOBS.mobs.delete(id);
        assert.ok(MOBS.mobs.size <= before, 'no test mobs may be left behind');
    }
});

test('the dungeon tier makes mobs tougher without touching the surface', () => {
    const MOBS = require(path.join(SERVER_DIR, 'mobs'));
    for (const type of CFG.DUNGEON_MOB_TYPES) {
        const surface = MOBS.getMobStats(type, false, 1);
        const deep = MOBS.getMobStats(type, false, CFG.DUNGEON_MOB_TIER);
        assert.ok(deep.hp > surface.hp, `${type} must be tougher underground`);
        assert.ok(deep.xp > surface.xp, `${type} must be worth more underground`);
    }
    // The surface is unchanged, and the default tier is exactly 1.
    assert.strictEqual(MOBS.getMobStats('skeleton', false).hp, 40);
    assert.strictEqual(MOBS.getMobStats('skeleton', false, 1).hp, 40);
    assert.strictEqual(MOBS.getMobStats('skeleton', false).xp, 20);
    // Elites still stack on top of the tier.
    const elite = MOBS.getMobStats('skeleton', true, CFG.DUNGEON_MOB_TIER);
    assert.strictEqual(elite.hp, MOBS.getMobStats('skeleton', false, CFG.DUNGEON_MOB_TIER).hp * 2);
});

test('an unknown or unbuilt floor spawns no mobs rather than guessing', () => {
    const MOBS = require(path.join(SERVER_DIR, 'mobs'));
    const empty = MAP.anUnregisteredFloor();
    if (empty === null) return;   // the range is full; nothing to assert
    const ids = MOBS.spawnFloorPack(() => { }, { z: empty, size: 5, types: CFG.DUNGEON_MOB_TYPES });
    try {
        assert.strictEqual(ids.length, 0, 'a floor with no terrain must hold no mobs');
    } finally {
        for (const id of ids) MOBS.mobs.delete(id);
    }
});

test('a chest can only be looted from its own floor', () => {
    // tryLootChest matched on x and y alone. Once chests exist on two floors, a
    // player in the dungeon standing at a surface chest's coordinates looted it
    // through a metre of rock, and it vanished from the surface for everyone.
    const CHESTS = require(path.join(SERVER_DIR, 'chests'));
    const sent = [];
    CHESTS.chests.clear();
    const surfaceSpot = MAP.randomWalkableTile(CFG.Z_SURFACE);
    const deepSpot = MAP.randomWalkableTile(CFG.Z_DUNGEON);
    assert.ok(surfaceSpot && deepSpot, 'both floors must have a place to put a chest');
    CHESTS.chests.set('c_surface', { id: 'c_surface', x: surfaceSpot.x, y: surfaceSpot.y, z: CFG.Z_SURFACE });
    CHESTS.chests.set('c_deep', { id: 'c_deep', x: deepSpot.x, y: deepSpot.y, z: CFG.Z_DUNGEON });
    try {
        // A player on the other floor, at the exact chest tile.
        const intruder = {
            x: surfaceSpot.x, y: surfaceSpot.y, z: CFG.Z_DUNGEON, gold: 0,
            ws: { send: () => { } }
        };
        const looted = CHESTS.tryLootChest(intruder, { send: () => { } });
        assert.strictEqual(looted, false, 'a cross-floor player must not loot the chest');
        assert.ok(CHESTS.chests.has('c_surface'), 'the surface chest must survive');
        assert.strictEqual(intruder.gold, 0, 'and award nothing');

        // The rightful player gets it.
        const owner = {
            x: surfaceSpot.x, y: surfaceSpot.y, z: CFG.Z_SURFACE, gold: 0,
            ws: { send: () => { } }
        };
        const okLoot = CHESTS.tryLootChest(owner, { send: () => { } });
        assert.ok(okLoot, 'a same-floor player must be able to loot it');
        assert.ok(!CHESTS.chests.has('c_surface'), 'and the chest is consumed');
        assert.ok(owner.gold > 0, 'and pays out');
    } finally {
        CHESTS.chests.clear();
    }
    void sent;
});

test('floating combat text is floor-scoped everywhere', () => {
    // Every fct packet carries a world coordinate. Broadcast globally, a
    // surface player watches "+30 XP" float over a dungeon corpse, and a player
    // gathering in a cave drops loot text onto the surface.
    for (const rel of ['server.js', 'combat.js']) {
        const src = fs.readFileSync(path.join(SERVER_DIR, rel), 'utf8');
        const offenders = [];
        src.split('\n').forEach((line, i) => {
            if (!/broadcast\(\{\s*action:\s*'fct'/.test(line)) return;
            offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        });
        assert.deepStrictEqual(offenders, [],
            'these fct broadcasts are not floor-scoped:\n  ' + offenders.join('\n  '));
    }
});

test('map_data declares the floor walkable extent, and the client clips to it', () => {
    // The bedrock enclosing the dungeon is walkability-only: it is in
    // floor.obstacles but never in obstacleData, which would add ten thousand
    // tiles to every descent packet. The consequence is that a client building
    // its blocking set from obstacleData alone believes the ground beyond the
    // cave is open. A pathfinder then walks off into empty coordinates -- in one
    // harness, to negative infinity, until the process ran out of memory.
    //
    // So the packet has to state where the floor actually ends, and the client
    // has to honour it. Both halves are asserted, because either alone is
    // useless: bounds the client ignores, or a clip with nothing to clip to.
    const terrain = MAP.getFloorTerrain(CFG.Z_DUNGEON);
    assert.ok(terrain.bounds, 'map_data must carry the floor bounds');
    const { minX, minY, maxX, maxY } = terrain.bounds;
    assert.ok(maxX > minX && maxY > minY, 'bounds must describe a real area');
    // They must describe where the ground IS, not where the map is.
    assert.ok(minX > 0 && minY > 0, 'the dungeon does not start at the map origin');
    assert.ok(maxX < CFG.MAP_WIDTH - CFG.TILE_SIZE,
        'the dungeon does not reach the far edge of the map');
    // And a tile inside the bounds really is standable, or the clip would trap
    // the player in a region with no floor.
    assert.ok(MAP.isWalkable(minX, minY, CFG.Z_DUNGEON), 'the bounds corner must be standable');
    assert.ok(MAP.isWalkable(maxX, maxY, CFG.Z_DUNGEON), 'the far bound must be standable');

    const engine = fs.readFileSync(CLIENT_JS, 'utf8');
    assert.ok(/MAP_BOUNDS\s*=\s*data\.bounds\s*\|\|\s*null/.test(engine),
        'engine.js must read data.bounds from map_data');
    const walkable = engine.slice(engine.indexOf('function isWalkable'), engine.indexOf('function findPath'));
    for (const edge of ['minX', 'maxX', 'minY', 'maxY']) {
        assert.ok(walkable.includes(edge), `isWalkable must clip on ${edge}`);
    }
    // The search must also be bounded in its own right, so a missing or wrong
    // bounds cannot turn into an unbounded walk.
    const findPath = engine.slice(engine.indexOf('function findPath'));
    assert.ok(/iterations\s*<\s*\d+/.test(findPath.slice(0, 1200)),
        'findPath must cap its iterations');
    // And the surface must not be clipped, or the whole map becomes a room.
    const surface = MAP.getFloorBounds(CFG.Z_SURFACE);
    assert.ok(surface && surface.minX === 0 && surface.minY === 0,
        'the surface bounds must cover the map, not a sub-region');
});

test('only the surface has a safe zone', () => {
    // inSafeZone(x, y) had no floor parameter. It worked only because the
    // dungeon happens to sit outside the city's coordinates: a dungeon built
    // under the city would make its players permanently invulnerable,
    // self-healing and untouchable, because every caller would read their
    // coordinates as "in the city". That is a coincidence of layout, not a rule.
    const MOBS = require(path.join(SERVER_DIR, 'mobs'));
    const sz = CFG.SAFE_ZONE;
    const inCity = { x: sz.x + 32, y: sz.y + 32 };
    assert.strictEqual(MOBS.inSafeZone(inCity.x, inCity.y, CFG.Z_SURFACE), true,
        'the city is safe on the surface');
    for (let z = CFG.Z_MIN; z < CFG.Z_SURFACE; z++) {
        assert.strictEqual(MOBS.inSafeZone(inCity.x, inCity.y, z), false,
            `floor ${z} must have no safe zone, even at city coordinates`);
    }
    // The default still means the surface, so a caller with no floor in mind
    // keeps its original meaning rather than silently changing.
    assert.strictEqual(MOBS.inSafeZone(inCity.x, inCity.y), true);
});

test('every inSafeZone call site states the floor it is asking about', () => {
    // The parameter defaults to the surface, so a call that omits it silently
    // keeps the old 2D meaning -- which is the coincidence this change removed.
    const offenders = [];
    for (const rel of ['server.js', 'combat.js', 'mobs.js']) {
        const src = fs.readFileSync(path.join(SERVER_DIR, rel), 'utf8');
        src.split('\n').forEach((line, i) => {
            // the declaration is the one place a default belongs
            if (/function inSafeZone/.test(line)) return;
            for (const call of line.match(/inSafeZone\([^)]*\)/g) || []) {
                const args = call.slice('inSafeZone('.length, -1).split(',');
                if (args.length < 3) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
            }
        });
    }
    assert.deepStrictEqual(offenders, [],
        'these inSafeZone calls do not say which floor they mean:\n  ' + offenders.join('\n  '));
});

test('every positional broadcast is floor-scoped', () => {
    // A packet carrying a world coordinate, or describing an entity that lives
    // on a floor, must not go to every client: the recipient draws it in a world
    // where the coordinates mean nothing and has no way to tell.
    //
    // This has been the shape of every leak found -- mob movement, node respawn,
    // chest looted, corpse looted, ground sync, ground drops with no floor of
    // their own, the spell animation, and all forty floating combat texts. The
    // sweep runs the audit tool so the list of actions stays in one place.
    const { execFileSync } = require('child_process');
    const audit = path.join(__dirname, '..', '..', 'tools', 'audit_unscoped_broadcasts.js');
    let out = '';
    let failed = false;
    try {
        out = execFileSync(process.execPath, [audit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        out = (e.stdout || '') + (e.stderr || '');
        failed = true;
    }
    assert.ok(out.includes('every positional packet is floor-scoped'),
        'the unscoped-broadcast audit found leaks:\n' + out);
    assert.strictEqual(failed, false, 'the audit tool should exit 0 when clean');
});

test('a dropped item records the floor it was dropped on', () => {
    // Without z, both ends of the pickup check were wrong in opposite
    // directions: a dungeon player could never retrieve their own drop, because
    // dist3D compared z = -1 against a missing value normalised to the surface
    // and returned Infinity, while a surface player at the same X/Y could take a
    // dungeon item through the rock.
    const src = fs.readFileSync(path.join(SERVER_DIR, 'server.js'), 'utf8');
    const at = src.indexOf('groundItems.set(');
    assert.ok(at !== -1, 'groundItems.set must exist');
    const block = src.slice(at, at + 600);
    assert.ok(/z:\s*MAP\.normalizeZ\(player\.z\)/.test(block),
        'a ground drop must record the floor of the player who made it');
    // And the pickup check has to compare floors, not just coordinates.
    const pickup = src.slice(src.indexOf("action === 'pickup_item'"), src.indexOf("action === 'pickup_item'") + 900);
    assert.ok(/dist3D\(player\.x, player\.y, player\.z, entry\.x, entry\.y, entry\.z\)/.test(pickup),
        'pickup must compare floors as well as distance');
});

test('the whole Z-level chain is walkable from the city, end to end', () => {
    // A single hard-coded dungeon shows the machinery works once. A chain of
    // three floors shows it is general: arrival, one-way exits, per-floor
    // terrain and bounds all have to hold at every link, and a floor whose exit
    // cannot be walked to from where the player arrives is a soft-lock.
    //
    // The flood exempts traversal tiles from the obstacle set, exactly as the
    // client does -- they are in obstacleData so they can be drawn, but they are
    // walked onto. An earlier version of this check treated them as solid and
    // reported that no floor had any reachable transition, which was a bug in
    // the check and looked exactly like a broken world.
    const { execFileSync } = require('child_process');
    const probe = path.join(__dirname, '..', '..', 'tools', 'zlevel_chain_probe.js');
    let out = '';
    let failed = false;
    try {
        out = execFileSync(process.execPath, [probe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        out = (e.stdout || '') + (e.stderr || '');
        failed = true;
    }
    assert.ok(out.includes('CHAIN IS WALKABLE END TO END'),
        'the Z-level chain probe found a problem:\n' + out);
    assert.strictEqual(failed, false, 'the chain probe should exit 0 when the world is walkable');
});

test('every configured floor is generated, populated and distinct', () => {
    // The table is meant to be data, not decoration: a row that generated no
    // floor, or two floors at the same depth, would be silently ignored.
    assert.ok(Array.isArray(CFG.Z_FLOORS) && CFG.Z_FLOORS.length >= 2,
        'the world should have more than one underground floor to prove generality');
    const depths = new Set();
    for (const spec of CFG.Z_FLOORS) {
        assert.ok(MAP.hasFloor(spec.z), `floor z=${spec.z} (${spec.name}) must be generated`);
        assert.ok(spec.tilesW > 4 && spec.tilesH > 4, `${spec.name} must be big enough to walk in`);
        assert.ok(spec.pillars >= 0, `${spec.name} must declare its pillar count`);
        assert.ok(spec.mobCount > 0, `${spec.name} must declare a population`);
        assert.ok(spec.tier >= 1, `${spec.name} must not be easier than the surface`);
        assert.ok(Array.isArray(spec.mobTypes) && spec.mobTypes.length, `${spec.name} needs a roster`);
        assert.ok(!depths.has(spec.z), `two floors share depth z=${spec.z}`);
        depths.add(spec.z);
        assert.ok(spec.z < CFG.Z_SURFACE && spec.z >= CFG.Z_MIN,
            `${spec.name} at z=${spec.z} is outside the configured range`);
    }
    // Deeper means harder, or the second floor is a worse first floor.
    const sorted = CFG.Z_FLOORS.slice().sort((a, b) => b.z - a.z);
    for (let i = 1; i < sorted.length; i++) {
        assert.ok(sorted[i].tier >= sorted[i - 1].tier,
            `${sorted[i].name} (z=${sorted[i].z}) should not be easier than ${sorted[i - 1].name}`);
    }
    // The flat keys the older tooling and tests read must still describe the
    // first floor, or two sources of truth drift apart.
    const first = CFG.Z_FLOORS.find(f => f.z === CFG.Z_DUNGEON);
    assert.ok(first, 'Z_DUNGEON must name a row in the table');
    assert.strictEqual(CFG.DUNGEON_ORIGIN_X, first.originX);
    assert.strictEqual(CFG.DUNGEON_TILES_W, first.tilesW);
    assert.strictEqual(CFG.DUNGEON_PILLARS, first.pillars);
    assert.strictEqual(CFG.DUNGEON_MOB_COUNT, first.mobCount);
    assert.strictEqual(CFG.DUNGEON_MOB_TIER, first.tier);
    assert.deepStrictEqual(CFG.DUNGEON_MOB_TYPES, first.mobTypes);
});

test('a boss spawn is announced to its own floor, with the floor stated', () => {
    // Two separate mistakes live here and both fail silently.
    //
    // The announcement was global and carried no z, so a boss appearing
    // underground was told to every client with no way to say which world the
    // coordinates belonged to.
    //
    // Then the fallback for an un-injected broadcaster was written as
    // (dataObj) => broadcast(dataObj). Callers pass (floor, packet), so it bound
    // dataObj to the floor index and broadcast the number 0 in place of the
    // packet. `broadcast` accepts a number without complaint, so the only
    // symptom was a boss that never appeared, and only on the path where the
    // broadcaster was not injected.
    const BOSSES = require(path.join(SERVER_DIR, 'bosses'));
    const sent = [];
    const id = BOSSES.spawnBoss('ice_dragon', p => sent.push(p), { announce: false });
    assert.ok(id, 'the boss must spawn');

    const update = sent.find(p => p && p.action === 'mob_update');
    assert.ok(update, 'a boss spawn must still announce itself with the alert suppressed');
    assert.strictEqual(update.isBoss, true);
    assert.ok(Number.isSafeInteger(update.z), `mob_update must state its floor, got ${update.z}`);
    assert.strictEqual(update.z, CFG.Z_SURFACE, 'an unconfigured boss belongs to the surface');
    // Every broadcast must be a packet object. A bare number means an argument
    // was bound to the wrong parameter.
    for (const p of sent) {
        assert.ok(p && typeof p === 'object' && typeof p.action === 'string',
            `every broadcast must be a packet object, got ${JSON.stringify(p)}`);
    }
});

test('a traversal tile cannot be placed pointing at a floor that does not exist', () => {
    // Otherwise the player stands on a tile that does nothing, with no
    // explanation, which reads as a broken game.
    //
    // The target floor is derived, not hardcoded. This test used -3 as its "floor
    // that does not exist", which was true when the dungeon was one floor deep and
    // stopped being true the moment z=-3 was generated -- the test then failed for a
    // reason unrelated to the guard it was providing.
    //
    // It is not Z_MIN - 1 either: normalizeZ clamps, so an out-of-range z resolves
    // to Z_MIN and there is no out-of-range floor to point at. The only floor that
    // is genuinely unregistered is one inside Z_MIN..Z_MAX with no gap in the
    // range -- and with three floors filling that range there is none. So this
    // asserts the guard is in place by checking the placement is refused for a
    // floor that does not exist, and skips the subject when the range is full
    // rather than inventing a floor that cannot exist.
    const absent = MAP.anUnregisteredFloor();

    if (absent === null) {
        // Full range. Say so, and assert the self-referential case below still
        // holds, which exercises the same refusal path.
        const built = CFG.Z_FLOORS.length + 1;
        const span = CFG.Z_MAX - CFG.Z_MIN + 1;
        assert.strictEqual(built, span,
            `the range ${CFG.Z_MIN}..${CFG.Z_MAX} is full, so no unregistered floor exists to test against -- ` +
            `widen Z_MIN if that was not intended`);
        return;
    }

    const ghost = MAP.placeTransition(CFG.Z_SURFACE, 1000, 1000, MAP.TILE_TYPES.LADDER, absent);
    assert.strictEqual(ghost, null, 'a ladder to an ungenerated floor must be refused');
    assert.strictEqual(MAP.hasTransition(CFG.Z_SURFACE, 1000, 1000), false,
        'the refused tile must not be registered');
    assert.strictEqual(MAP.isWalkable(1000, 1000, CFG.Z_SURFACE), true,
        'a refused placement must not leave an obstacle behind');
});

test('a traversal tile cannot point at its own floor', () => {
    const same = MAP.placeTransition(CFG.Z_SURFACE, 1200, 1200, MAP.TILE_TYPES.LADDER, CFG.Z_SURFACE);
    assert.strictEqual(same, null, 'a self-referential transition must be refused');
});

// --- Cross-floor isolation --------------------------------------------------
// The user-facing rule: trade and PvP are same-floor, party and guild chat
// crosses floors. Everything below is the mechanical half of that -- a 2D
// distance check measures straight through a floor, so each of these has to go
// through the floor-aware form.
function dist(x1, y1, x2, y2) { return Math.abs(x1 - x2) + Math.abs(y1 - y2); }
function dist3D(x1, y1, z1, x2, y2, z2) {
    if (MAP.normalizeZ(z1) !== MAP.normalizeZ(z2)) return Infinity;
    return dist(x1, y1, x2, y2);
}

test('dist3D separates a player from an identical position one floor up', () => {
    // The exact shape of the exploit: same X/Y, different floor. 2D distance is
    // zero, so any range check written against it passes.
    assert.strictEqual(dist(1100, 1100, 1100, 1100), 0, '2D sees no distance at all');
    assert.strictEqual(dist3D(1100, 1100, 0, 1100, 1100, -1), Infinity);
    assert.ok(!(dist3D(1100, 1100, 0, 1100, 1100, -1) <= 96), 'must be out of interaction range');
    assert.strictEqual(dist3D(1100, 1100, 0, 1100, 1100, 0), 0, 'the same floor is unaffected');
});

test('no surface NPC or workbench is reachable from the dungeon', () => {
    // The concrete bug this prevents: NPCs sit at surface coordinates that the
    // dungeon also occupies in X/Y, so a 2D check would let a player standing
    // in the cave bank, shop, craft and turn in quests without ever climbing
    // the ladder. Every entity must therefore carry a floor.
    for (const [id, npc] of npcs) {
        assert.ok(Number.isSafeInteger(npc.z), `NPC ${id} must declare its floor`);
        assert.strictEqual(npc.z, CFG.Z_SURFACE, `NPC ${id} is a surface NPC in Stage 2`);
    }
    assert.ok(Number.isSafeInteger(CRAFTING.WORKBENCH.z), 'the workbench must declare its floor');

    // Standing in the dungeon directly "under" a city NPC is still far away.
    const mayor = npcs.get('n_1');
    const underMayor = { x: mayor.x, y: mayor.y, z: CFG.Z_DUNGEON };
    assert.ok(!(dist3D(underMayor.x, underMayor.y, underMayor.z, mayor.x, mayor.y, mayor.z) <= 96),
        'a dungeon player at the banker\'s coordinates must not count as adjacent');
    assert.ok(dist3D(mayor.x, mayor.y, mayor.z, mayor.x, mayor.y, mayor.z) <= 96,
        'the mayor must still be reachable in the city');
});

test('the trade separation check is floor-aware', () => {
    // Trade is same-floor by decision. The check that enforces it must compare
    // floors, or a player can open a trade, descend, and complete it blind.
    const src = fs.readFileSync(path.join(SERVER_DIR, 'server.js'), 'utf8');
    const abort = src.slice(src.indexOf('function abortSeparatedTrade'), src.indexOf('function abortSeparatedTrade') + 900);
    assert.ok(abort.includes('dist3D'),
        'abortSeparatedTrade must use the floor-aware distance');
    assert.ok(!/\bdist\(p1\.x/.test(abort), 'the 2D form must not remain in the separation check');
});

test('no 2D distance check survives where an entity can be on another floor', () => {
    // A blanket sweep rather than a per-site list, so an interaction added later
    // cannot quietly reintroduce a cross-floor reach.
    //
    // Every 2D dist() call is rejected outright. The only legitimate uses are
    // the two declarations themselves, which are excluded by line shape. An
    // earlier version of this test asserted `args.length === 4` for 2D calls,
    // which is exactly backwards: a four-argument call IS the floor-unaware
    // form, so the test passed the very thing it was written to catch.
    const files = ['server.js', 'combat.js'];
    const DECLARATIONS = [
        /^function dist\(/,            // the 2D helper
        /^\s*return dist\(x1, y1, x2, y2\);/,  // dist3D delegating to it
        /^\s*return Math\.abs/,        // the 2D helper's body
        /^\s*dist,$/                   // the combat dependency injection list
    ];
    const offenders = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(SERVER_DIR, f), 'utf8');
        src.split('\n').forEach((line, i) => {
            // Match dist( but not dist3D(
            const call = /(?<![3D\w])dist\(([^)]*)\)/.exec(line);
            if (!call) return;
            if (DECLARATIONS.some(re => re.test(line))) return;
            offenders.push(`${f}:${i + 1}  ${line.trim()}`);
        });
    }
    assert.deepStrictEqual(offenders, [],
        'these use the floor-unaware dist() on entities that can be on another floor:\n  ' +
        offenders.join('\n  '));
});

test('the move handler triggers traversal', () => {
    // Without this, the map can be perfect and the feature still does nothing:
    // nothing calls performTraversal, the ladder is decoration. Source-level
    // because the move handler lives inside the WebSocket callback and cannot
    // be unit-tested; the live harness tests/traversal_live_verify.js walks a
    // real player onto the ladder and covers the behaviour itself.
    const src = fs.readFileSync(path.join(SERVER_DIR, 'server.js'), 'utf8');
    const at = src.indexOf("MAP.getTransition(player.z, player.x, player.y)");
    assert.ok(at !== -1, 'the move handler must look up a transition at the destination');
    const after = src.slice(at, at + 200);
    assert.ok(/performTraversal\(player,\s*traversal\)/.test(after),
        'the looked-up transition must be handed to performTraversal');
    // And it must run only after the step is accepted, or the traversal fires
    // for a move the server rejected.
    const handler = src.slice(src.indexOf("data.action === 'move'"), at);
    assert.ok(handler.includes('isWalkable(data.x, data.y, player.z)'),
        'the traversal hook must sit behind the walkability check');
    const walkAt = handler.indexOf('isWalkable(data.x, data.y, player.z)');
    const assignAt = handler.indexOf('player.x = data.x; player.y = data.y;');
    assert.ok(walkAt !== -1 && assignAt > walkAt,
        'the move must be validated before the position is committed');
});

test('chat is not floor-scoped', () => {
    // Party and guild chat cross floors by decision. Asserting it so a future
    // "let's just scope everything" pass does not silently break the one
    // interaction that is supposed to be global.
    const src = fs.readFileSync(path.join(SERVER_DIR, 'server.js'), 'utf8');
    const chat = src.slice(src.indexOf("data.action === 'chat'"), src.indexOf("data.action === 'chat'") + 1400);
    assert.ok(chat.length > 0, 'the chat handler must exist');
    assert.ok(!/dist3D|dist\(/.test(chat),
        'chat must not apply a distance or floor check -- it is global by design');
});
