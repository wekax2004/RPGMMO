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

function registerFloor(z, data) {
    const src = data && typeof data === 'object' ? data : {};
    const floor = {
        z: normalizeZ(z),
        obstacles: src.obstacles instanceof Set ? src.obstacles : new Set(),
        obstacleData: Array.isArray(src.obstacleData) ? src.obstacleData : [],
        waterTiles: src.waterTiles instanceof Set ? src.waterTiles : new Set()
    };
    floors.set(floor.z, floor);
    return floor;
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

// The full terrain description of one floor, for the map_data packet. Stage 0
// returns null for any floor but the surface, so a client asking for a
// dungeon gets nothing rather than the surface's tiles relabelled.
function getFloorTerrain(z) {
    const floor = getFloor(z);
    if (!floor) return null;
    return { z: floor.z, obstacleData: floor.obstacleData, waterTiles: floor.waterTiles };
}

generateMap();
registerFloor(CFG.Z_SURFACE, { obstacles, obstacleData, waterTiles });

module.exports = {
    isWalkable, isWater, hasWaterNear, getZone, getFloor, hasFloor, getFloorTerrain,
    normalizeZ, registerFloor,
    // Kept as the surface's terrain: the map_data payload the client already
    // parses is unchanged, and no existing consumer has to learn about floors.
    obstacleData, waterTiles
};
