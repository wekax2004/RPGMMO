const CFG = require('./config');

// --- Z-level storage -------------------------------------------------------
// A world floor owns its own obstacle set, obstacle list and water index.
// Only the surface (z = 0) is generated in Stage 0; the per-floor shape is
// what lets a later stage add a cave without touching any call site.
//
// The surface keeps its storage in the module-level `obstacles` /
// `obstacleData` / `waterTiles` bindings rather than moving into the
// registry, so the map_data payload the client already parses is unchanged.
const floors = new Map();

function getFloor(z) {
    return floors.get(normalizeZ(z)) || null;
}

function hasFloor(z) {
    return floors.has(normalizeZ(z));
}

// Removes a floor from the registry. Exists for test hygiene: the map module is
// a process-wide singleton, so a test that registers a synthetic floor has to
// be able to take it out again. Leaving a floor behind makes every later
// "this floor does not exist" assertion depend on test execution order.
function unregisterFloor(z) {
    return floors.delete(normalizeZ(z));
}

// A floor index inside the configured range that nothing has registered. Used
// to exercise the "not generated" path without hardcoding a specific depth,
// which goes stale the moment a real floor is added at that depth.
function anUnregisteredFloor() {
    for (let z = CFG.Z_MIN; z <= CFG.Z_MAX; z++) {
        if (!floors.has(z)) return z;
    }
    return null;
}

function registerFloor(z, data) {
    const src = data && typeof data === 'object' ? data : {};
    const floor = {
        z: normalizeZ(z),
        obstacles: src.obstacles instanceof Set ? src.obstacles : new Set(),
        obstacleData: Array.isArray(src.obstacleData) ? src.obstacleData : [],
        waterTiles: src.waterTiles instanceof Set ? src.waterTiles : new Set(),
        // Tile -> destination floor. Keyed "x,y" like every other tile index.
        transitions: new Map()
    };
    floors.set(floor.z, floor);
    return floor;
}

// --- Traversal --------------------------------------------------------------
// A traversal tile is WALKED ONTO, which is what makes it different from every
// other obstacle. It is deliberately absent from floor.obstacles: if it were
// added there, isWalkable() would reject the step onto it and the descent
// could never be triggered. It is still listed in obstacleData, because the
// terrain renderer draws from that array -- a drawn-but-walkable tile.
//
// The client's WALKABLE_OBSTACLE_TYPES in engine.js mirrors the TILE_TYPES below.
// If a type is walkable server-side and treated as solid client-side, the ladder
// is drawn but unreachable, and the floor below is unreachable with it.
const TILE_TYPES = {
    LADDER: 'ladder',                 // both directions
    STAIRS_UP: 'stairs_up',           // upward only
    STAIRS_DOWN: 'stairs_down'        // downward only
};

const TRANSITION_DIRECTIONS = {
    [TILE_TYPES.LADDER]: { up: true, down: true },
    [TILE_TYPES.STAIRS_UP]: { up: true, down: false },
    [TILE_TYPES.STAIRS_DOWN]: { up: false, down: true }
};

// Places a traversal tile. The destination must be a floor that actually
// exists, so a ladder can never be placed pointing at empty space -- that would
// be a tile the player can stand on with nothing to do and no feedback
// explaining why.
//
// `arrive` is where the player ends up on the destination floor. It defaults to
// the tile's own coordinates, which is only correct when the two floors line up
// at the same world position. A surface ladder at (288,288) leading to a cave
// at (1024,1024) would otherwise drop the player in open ground beside the
// cave wall, so the arrival has to be stated explicitly.
function placeTransition(z, x, y, type, targetZ, arrive) {
    const floor = getFloor(z);
    if (!floor) return null;
    const dirs = TRANSITION_DIRECTIONS[type];
    if (!dirs) return null;
    const dest = normalizeZ(targetZ);
    if (!hasFloor(dest)) return null;
    if (dest === floor.z) return null;

    const entry = (arrive && Number.isSafeInteger(arrive.x) && Number.isSafeInteger(arrive.y))
        ? { x: arrive.x, y: arrive.y }
        : { x, y };

    floor.transitions.set(`${x},${y}`, { x, y, type, to: dest, arrive: entry });
    // Drawn, but never added to floor.obstacles -- see the note above.
    // A transition can overwrite a previously drawn tile at the same spot, and
    // the terrain renderer keys on position, so drop the stale record rather
    // than leaving two entries for one tile.
    for (let i = floor.obstacleData.length - 1; i >= 0; i--) {
        if (floor.obstacleData[i].x === x && floor.obstacleData[i].y === y) {
            floor.obstacleData.splice(i, 1);
        }
    }
    floor.obstacleData.push({ x, y, type });
    return floor.transitions.get(`${x},${y}`);
}

// Where does standing on this tile lead?
//
// The transition's `to` is authoritative and there is no direction argument.
// An earlier revision took a `delta` and checked it against the tile type,
// which inverted: a ladder is legal in both directions, so asking to climb
// from the surface ladder returned the transition to the dungeon below. The
// player would have gone down while climbing.
//
// One-way tiles need no direction check either. stairs_up exists only on the
// floor it departs, so standing on it always ascends; there is simply no
// descending transition at that spot to take.
function getTransition(z, x, y) {
    const floor = getFloor(z);
    if (!floor) return null;
    return floor.transitions.get(`${x},${y}`) || null;
}

function hasTransition(z, x, y) {
    const floor = getFloor(z);
    return floor ? floor.transitions.has(`${x},${y}`) : false;
}

// The nearest walkable arrival point on `toZ` for a player arriving from
// (fromX, fromY). A ladder can land on a tile that is solid on the far side --
// a cave mouth walled off by its own generator -- and dropping the player into
// rock would trap them with no way out, which is unrecoverable without an
// admin. Search outward in rings so arrival is always possible.
function findArrivalPoint(toZ, fromX, fromY) {
    const step = CFG.TILE_SIZE;
    const originX = Math.floor(fromX / step) * step;
    const originY = Math.floor(fromY / step) * step;
    for (let ring = 0; ring <= 6; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
            for (let dy = -ring; dy <= ring; dy++) {
                // Only the shell of each ring, then the centre on the last pass.
                if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
                const x = originX + dx * step;
                const y = originY + dy * step;
                if (isWalkable(x, y, toZ)) return { x, y };
            }
        }
    }
    return null;
}

// Clamps an incoming z to a legal floor index. Guards three things: a save
// written by a future build, a hand-edited database row, and a malformed
// client packet. Anything out of range resolves to the surface rather than
// throwing, because a bad z must never be able to reject a login.
function normalizeZ(z) {
    if (!Number.isSafeInteger(z) || z < CFG.Z_MIN || z > CFG.Z_MAX) return CFG.Z_SURFACE;
    return z;
}

const obstacles = new Set();
const obstacleData = [];
// Water is generated as an impassable obstacle of type 'water'. Fishing needs
// to know which tiles are water without re-scanning obstacleData on every cast,
// so the keys are indexed once at generation time.
const waterTiles = new Set();

function getZone(x, y) {
    if (x < 800 && y < 800) return 'City';
    if (x >= 800 && x < 2000 && y < 1200) return 'Forest';
    if (x >= 2000 && y < 1600) return 'Eastern Ruins';
    if (x < 1600 && y >= 800 && y < 1800) return 'Swamp';
    if (x >= 1600 && y >= 1600 && y < 2600) return 'Snow Mountain';
    if (x < 1600 && y >= 1800) return 'Desert'; 
    if (x >= 1600 && y >= 2600) return 'Crypt'; 
    return 'Wilderness';
}

function addStructure(startX, startY, width, height, type) {
    for (let x = startX; x < startX + width; x += CFG.TILE_SIZE) {
        for (let y = startY; y < startY + height; y += CFG.TILE_SIZE) {
            // Hollow out the middle for buildings
            if (x > startX && x < startX + width - CFG.TILE_SIZE && y > startY && y < startY + height - CFG.TILE_SIZE) {
                // leave empty or add floor
                continue;
            }
            // add doorway
            if (x === startX + CFG.TILE_SIZE * 2 && y === startY + height - CFG.TILE_SIZE) continue; 
            
            obstacles.add(`${x},${y}`);
            obstacleData.push({x, y, type});
        }
    }
}

function generateMap() {
    // Generate some random structures first
    for (let i=0; i<15; i++) {
        let sx = Math.floor(Math.random() * (CFG.MAP_WIDTH - 200) / CFG.TILE_SIZE) * CFG.TILE_SIZE;
        let sy = Math.floor(Math.random() * (CFG.MAP_HEIGHT - 200) / CFG.TILE_SIZE) * CFG.TILE_SIZE;
        if (sx < CFG.SAFE_ZONE.w && sy < CFG.SAFE_ZONE.h) continue; // Don't build in City
        addStructure(sx, sy, CFG.TILE_SIZE * 5, CFG.TILE_SIZE * 5, 'wall');
    }

    for (let x = 0; x < CFG.MAP_WIDTH; x += CFG.TILE_SIZE) {
        for (let y = 0; y < CFG.MAP_HEIGHT; y += CFG.TILE_SIZE) {
            if (x < CFG.SAFE_ZONE.w && y < CFG.SAFE_ZONE.h) continue;
            if (obstacles.has(`${x},${y}`)) continue; // already a structure here
            
            const zone = getZone(x, y);
            let chance = 0;
            let type = '';
            
            if (zone === 'Forest') { chance = 0.12; type = 'tree'; }
            else if (zone === 'Snow Mountain') { chance = 0.08; type = 'rock'; }
            else if (zone === 'Eastern Ruins') { chance = 0.06; type = 'ruin_wall'; }
            else if (zone === 'Swamp') { chance = 0.15; type = 'water'; } // impassable swamp water
            else if (zone === 'Desert') { chance = 0.05; type = 'cactus'; }
            else if (zone === 'Crypt') { chance = 0.10; type = 'gravestone'; }
            
            // Generate clusters for water/lava
            if (type === 'water' && Math.random() < 0.3) {
                 chance = 0.6; // clump together
            }

            if (Math.random() < chance) {
                obstacles.add(`${x},${y}`);
                obstacleData.push({x, y, type});
                if (type === 'water') waterTiles.add(`${x},${y}`);
            }
        }
    }
}

// Can a player stand on this tile, on floor `z`?
// The z parameter is additive and defaults to the surface, so all 13 existing
// call sites keep their exact behaviour. A floor with no generated terrain is
// not walkable anywhere: that answers "nowhere to go" honestly instead of
// falling through to the surface's layout, which would let a player stand on
// an underground tile that only exists above them.
function isWalkable(x, y, z = CFG.Z_SURFACE) {
    const floor = getFloor(z);
    if (!floor) return false;
    if (x < 0 || y < 0 || x >= CFG.MAP_WIDTH || y >= CFG.MAP_HEIGHT) return false;
    return !floor.obstacles.has(`${x},${y}`);
}

// Is this exact tile water, on floor `z`? Water is an obstacle, so a player can
// never stand on it -- they fish from an adjacent walkable tile.
function isWater(x, y, z = CFG.Z_SURFACE) {
    const floor = getFloor(z);
    if (!floor) return false;
    if (x < 0 || y < 0 || x >= CFG.MAP_WIDTH || y >= CFG.MAP_HEIGHT) return false;
    return floor.waterTiles.has(`${x},${y}`);
}

// Is there water within `range` of the given point (Manhattan distance)?
// Counts the distinct water tiles found so a client cannot fish from a spot
// that only grazes one tile diagonally-cornered. Scoped to one floor: water on
// the surface above must not make a dungeon floor fishable.
function hasWaterNear(x, y, range, z = CFG.Z_SURFACE) {
    const floor = getFloor(z);
    if (!floor) return 0;
    let found = 0;
    for (let dx = -range; dx <= range; dx += CFG.TILE_SIZE) {
        for (let dy = -range; dy <= range; dy += CFG.TILE_SIZE) {
            if (dx === 0 && dy === 0) continue;   // standing on water is impossible anyway
            if (isWater(x + dx, y + dy, floor.z)) found++;
        }
    }
    return found;
}

// A random standable tile on a floor, or null if the floor has none.
//
// Never returns a solid tile and never invents a coordinate. A caller that gets
// null must handle "this floor cannot hold that" rather than proceed with a
// guess. Random placement plus an isWalkable retry loop is not equivalent: a
// random coordinate is usually solid, so a spawner either burns its attempts
// and gives up, or keeps the last rejected one because that is the only
// candidate the loop actually tried.
function randomWalkableTile(z) {
    const floor = getFloor(z);
    if (!floor) return null;
    const step = CFG.TILE_SIZE;
    // A dungeon is small enough to enumerate exhaustively, so a mob there is
    // always placed on a real tile. The surface is not, so rejection-sample it
    // and accept that it may occasionally decline.
    if (floor.obstacleData.length < 2000) {
        const tiles = [];
        for (let x = 0; x < CFG.MAP_WIDTH; x += step) {
            for (let y = 0; y < CFG.MAP_HEIGHT; y += step) {
                if (!floor.obstacles.has(`${x},${y}`)) tiles.push({ x, y });
            }
        }
        if (tiles.length === 0) return null;
        return tiles[Math.floor(Math.random() * tiles.length)];
    }
    for (let i = 0; i < 60; i++) {
        const x = Math.floor(Math.random() * (CFG.MAP_WIDTH / step)) * step;
        const y = Math.floor(Math.random() * (CFG.MAP_HEIGHT / step)) * step;
        if (!floor.obstacles.has(`${x},${y}`)) return { x, y };
    }
    return null;
}

// The walkable extent of a floor, in world pixels.
//
// Exists because the bedrock that encloses the dungeon is walkability-only: it
// is in floor.obstacles but deliberately not in obstacleData, which would add
// ten thousand tiles to every descent packet to draw rock the player can never
// approach. The consequence is that a client building its movement-blocking set
// from obstacleData alone believes the ground beyond the cave is open, and a
// pathfinder walks off into empty coordinates -- in one harness, to negative
// infinity, until the process ran out of memory. This tells the client where
// the floor actually ends so it can clip.
function getFloorBounds(z) {
    const floor = getFloor(z);
    if (!floor) return null;
    const step = CFG.TILE_SIZE;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let x = 0; x < CFG.MAP_WIDTH; x += step) {
        for (let y = 0; y < CFG.MAP_HEIGHT; y += step) {
            if (floor.obstacles.has(`${x},${y}`)) continue;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    if (minX === Infinity) return null;   // a floor with no floor at all
    return { minX, minY, maxX, maxY };
}

// The full terrain description of one floor, for the map_data packet. Returns
// null for a floor that was never generated, so a client asking for a dungeon
// gets nothing rather than the surface's tiles relabelled.
function getFloorTerrain(z) {
    const floor = getFloor(z);
    if (!floor) return null;
    return {
        z: floor.z,
        obstacleData: floor.obstacleData,
        waterTiles: floor.waterTiles,
        // Where the floor's standable ground actually is, so a client can clip
        // its pathfinding to the cave instead of walking into the bedrock it
        // was never told about.
        bounds: getFloorBounds(floor.z),
        // Declared so the client can render a hint, and so a client that
        // mistypes a tile learns the floor is traversable rather than solid.
        transitions: [...floor.transitions.values()].map(t => ({ x: t.x, y: t.y, to: t.to, type: t.type, arrive: t.arrive }))
    };
}

// --- Stage 2: the first underground floor ----------------------------------
// A small, deliberately boring cave. Its job is to prove the whole traversal
// loop -- walk onto a ladder, cross a floor boundary, resync, climb back --
// not to be content. The surface layout is untouched, so a surface player
// cannot tell this exists until they step on a ladder.
//
// Walls are a solid block with a hollow interior, generated in a bounded region
// well clear of the safe zone. The ladder is placed on a walkable surface tile
// inside the safe zone so it is discoverable, and its partner is placed on the
// dungeon floor at the matching world coordinate, which keeps the arrival
// search trivial and the mapping legible.
// Flood fill of the standable tiles reachable from (fromX, fromY) on one floor,
// in world pixels. Used to guarantee the dungeon is escapable: the player
// descends on a one-way ladder, so a cave whose exit cannot be reached is a
// soft-lock, not a difficulty spike.
function reachableTiles(floor, fromX, fromY) {
    const seen = new Set([`${fromX},${fromY}`]);
    const queue = [[fromX, fromY]];
    const step = CFG.TILE_SIZE;
    while (queue.length) {
        const [x, y] = queue.pop();
        for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= CFG.MAP_WIDTH || ny >= CFG.MAP_HEIGHT) continue;
            const key = `${nx},${ny}`;
            if (floor.obstacles.has(key) || seen.has(key)) continue;
            seen.add(key);
            queue.push([nx, ny]);
        }
    }
    return seen;
}

function generateDungeonFloor(spec) {
    const z = normalizeZ(spec.z);
    const obs = new Set();
    const data = [];

    const ox = spec.originX;
    const oy = spec.originY;
    const w = spec.tilesW;
    const h = spec.tilesH;
    const step = CFG.TILE_SIZE;

    // Bedrock: everything outside the cave footprint is solid.
    //
    // Without this the dungeon is not a cave, it is a 14x14 walled room sitting
    // in the middle of an open plane that extends to the map edges. Measured
    // after the first population attempt: mobs placed on z=-1 spanned x 32 to
    // 3072, so a player inside the cave would have seen almost none of them and
    // anything that did wander off was unreachable and unkillable.
    //
    // Only `obstacles` is filled, not `obstacleData`. The client cannot reach
    // the outside, so drawing ten thousand rock tiles would only bloat map_data
    // by a few hundred kilobytes on every descent.
    const tilesAcross = Math.ceil(CFG.MAP_WIDTH / step);
    const tilesDown = Math.ceil(CFG.MAP_HEIGHT / step);
    for (let tx = 0; tx < tilesAcross; tx++) {
        for (let ty = 0; ty < tilesDown; ty++) {
            const insideCave = tx * step >= ox && tx * step < ox + w * step &&
                               ty * step >= oy && ty * step < oy + h * step;
            if (insideCave) continue;
            obs.add(`${tx * step},${ty * step}`);
        }
    }

    for (let tx = 0; tx < w; tx++) {
        for (let ty = 0; ty < h; ty++) {
            // Hollow interior: the border only, so the cave is a walled room
            // with a walkable floor.
            const onBorder = tx === 0 || ty === 0 || tx === w - 1 || ty === h - 1;
            if (!onBorder) continue;
            const x = ox + tx * step;
            const y = oy + ty * step;
            obs.add(`${x},${y}`);
            data.push({ x, y, type: 'cave_wall' });
        }
    }

    // The two tiles that must stay clear: where the player arrives, and where
    // they leave from.
    const entranceX = ox + step, entranceY = oy + step;
    const exitX = ox + Math.floor(w / 2) * step;
    const exitY = oy + Math.floor(h / 2) * step;
    const reserved = new Set([`${entranceX},${entranceY}`, `${exitX},${exitY}`]);

    // Interior pillars, each one accepted only if the exit is still reachable
    // afterwards.
    //
    // Placing them unconditionally seeded two separate soft-locks. A pillar
    // could land on the stairs themselves, making the exit tile solid; and a
    // ring of pillars could isolate the stairs from the arrival point without
    // touching either. Measured over 5000 generations, 5.12% of caves were
    // unescapable -- a player who descended could never climb back, with no way
    // back short of an admin. Checking after each placement makes connectivity
    // a property of the generator rather than a hope about the random draw.
    for (let i = 0; i < spec.pillars; i++) {
        const tx = 2 + Math.floor(Math.random() * Math.max(1, w - 4));
        const ty = 2 + Math.floor(Math.random() * Math.max(1, h - 4));
        const x = ox + tx * step;
        const y = oy + ty * step;
        const key = `${x},${y}`;
        if (obs.has(key) || reserved.has(key)) continue;

        obs.add(key);
        const probe = { obstacles: obs };
        if (!reachableTiles(probe, entranceX, entranceY).has(`${exitX},${exitY}`)) {
            obs.delete(key);   // this pillar would seal the cave; skip it
            continue;
        }
        data.push({ x, y, type: 'cave_pillar' });
    }

    registerFloor(z, { obstacles: obs, obstacleData: data, waterTiles: new Set() });
    const floor = getFloor(z);
    // A ring of visible rock just outside the walls, so the client draws an
    // enclosure rather than dark void at the edge of the room. The bedrock
    // beyond it is walkability-only and is not sent.
    for (let tx = -1; tx <= w; tx++) {
        for (let ty = -1; ty <= h; ty++) {
            if (tx >= 0 && ty >= 0 && tx < w && ty < h) continue;
            data.push({ x: ox + tx * step, y: oy + ty * step, type: 'cave_wall' });
        }
    }
    return floor;
}

// Chains the whole world together: a ladder in the city down to the first
// floor, a ladder in each floor down to the next, and stairs at the far end of
// each floor back up to the one above.
//
// Walking the table rather than hard-coding a single dungeon is the point. One
// special case shows the machinery works once; a chain of three shows it is
// general -- arrival, one-way exits, per-floor terrain, bounds and the roster
// all have to work at every link.
//
// Each floor contributes two tiles: one that descends to the floor below (or to
// the surface for the first), and one that climbs back to the floor above. The
// climb is deliberately one-way, so the player has to walk the floor rather
// than stand on a tile and oscillate.
function placeTraversalTiles() {
    const placed = [];
    const step = CFG.TILE_SIZE;
    const floors = CFG.Z_FLOORS.slice().sort((a, b) => b.z - a.z);   // shallowest first

    // The tile a floor is entered on, and the tile its exit sits on. Both are
    // inside the room: one tile in from the wall, and the centre respectively.
    const insideOf = (spec) => ({ x: spec.originX + step, y: spec.originY + step });
    const centreOf = (spec) => ({
        x: spec.originX + Math.floor(spec.tilesW / 2) * step,
        y: spec.originY + Math.floor(spec.tilesH / 2) * step
    });

    // The surface: a ladder in the city, where a new player is guaranteed to
    // walk. A traversal mechanic nobody finds is the same as no mechanic.
    const first = floors[0];
    if (first) {
        const into = insideOf(first);
        const down = placeTransition(
            CFG.Z_SURFACE, CFG.LADDER_X, CFG.LADDER_Y,
            TILE_TYPES.LADDER, first.z, into
        );
        if (down) placed.push({ from: CFG.Z_SURFACE, ...down });

        // Climbing out of the first floor returns to the city ladder, so the
        // ends form a loop rather than dumping the player at the map origin.
        const up = placeTransition(
            first.z, centreOf(first).x, centreOf(first).y,
            TILE_TYPES.STAIRS_UP, CFG.Z_SURFACE,
            { x: CFG.LADDER_X, y: CFG.LADDER_Y }
        );
        if (up) placed.push({ from: first.z, ...up });
    }

    // Each remaining floor hangs off the one above it.
    for (let i = 0; i < floors.length - 1; i++) {
        const here = floors[i];
        const below = floors[i + 1];
        // Down: a ladder near this floor's entrance, landing inside the next.
        const shaft = {
            x: here.originX + 2 * step,
            y: here.originY + 2 * step
        };
        const deeper = placeTransition(
            here.z, shaft.x, shaft.y,
            TILE_TYPES.LADDER, below.z, insideOf(below)
        );
        if (deeper) placed.push({ from: here.z, ...deeper });

        // Up: one-way stairs at this floor's centre, arriving on the floor
        // above at its own shaft -- so climbing the shaft from below puts you
        // back on the ladder you came down, rather than teleporting.
        const climb = placeTransition(
            below.z, centreOf(below).x, centreOf(below).y,
            TILE_TYPES.STAIRS_UP, here.z, shaft
        );
        if (climb) placed.push({ from: below.z, ...climb });
    }

    return placed;
}

generateMap();
registerFloor(CFG.Z_SURFACE, { obstacles, obstacleData, waterTiles });
for (const spec of CFG.Z_FLOORS) {
    if (normalizeZ(spec.z) !== CFG.Z_SURFACE) generateDungeonFloor(spec);
}
placeTraversalTiles();

module.exports = {
    isWalkable, isWater, hasWaterNear, getZone, getFloor, hasFloor, getFloorTerrain,
    normalizeZ, registerFloor, unregisterFloor, anUnregisteredFloor, findArrivalPoint,
    randomWalkableTile, getFloorBounds,
    placeTransition, getTransition, hasTransition, TILE_TYPES,
    // Kept as the surface's terrain: the map_data payload the client already
    // parses is unchanged, and no existing consumer has to learn about floors.
    obstacleData, waterTiles
};
