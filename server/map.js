const CFG = require('./config');

const obstacles = new Set();
const obstacleData = [];

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
            }
        }
    }
}

function isWalkable(x, y) {
    if (x < 0 || y < 0 || x >= CFG.MAP_WIDTH || y >= CFG.MAP_HEIGHT) return false;
    return !obstacles.has(`${x},${y}`);
}

generateMap();
module.exports = { isWalkable, getZone, obstacleData };
