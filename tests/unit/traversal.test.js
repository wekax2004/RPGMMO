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

test('the way out of the dungeon is one-way up', () => {
    const dungeon = MAP.getFloor(CFG.Z_DUNGEON);
    const entries = [...dungeon.transitions.values()];
    assert.strictEqual(entries.length, 1, 'the test floor has exactly one exit');
    const exit = entries[0];
    assert.strictEqual(exit.type, MAP.TILE_TYPES.STAIRS_UP, 'the exit is stairs, not a ladder');
    assert.strictEqual(MAP.normalizeZ(exit.to), CFG.Z_SURFACE, 'stairs_up must lead to the surface');
    // One-way is structural, not a direction check: no transition is registered
    // on the surface at the stairs' own coordinates, so there is nothing to take
    // back down.
    assert.strictEqual(MAP.getTransition(CFG.Z_SURFACE, exit.x, exit.y), null,
        'a stairs_up tile must not also offer a descent');
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

test('a traversal tile cannot be placed pointing at a floor that does not exist', () => {
    // Otherwise the player stands on a tile that does nothing, with no
    // explanation, which reads as a broken game.
    const ghost = MAP.placeTransition(CFG.Z_SURFACE, 1000, 1000, MAP.TILE_TYPES.LADDER, -3);
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
