const CFG = require('./config');

const obstacles = new Set();
const obstacleData = [];

function getZone(x, y) {
    if (x < 1600 && y < 1600) return 'City';
    if (x >= 1600 && y < 1600) return 'Forest';
    if (x < 1600 && y >= 1600) return 'Snow Mountain';
    return 'Eastern Ruins';
}

function generateMap() {
    for (let x = 0; x < CFG.MAP_WIDTH; x += CFG.TILE_SIZE) {
        for (let y = 0; y < CFG.MAP_HEIGHT; y += CFG.TILE_SIZE) {
            // Don't block safezone completely, just maybe some sparse elements, but let's keep safezone completely clean for now
            if (x < CFG.SAFE_ZONE.w && y < CFG.SAFE_ZONE.h) continue;
            
            const zone = getZone(x, y);
            let chance = 0;
            let type = '';
            
            if (zone === 'Forest') { chance = 0.12; type = 'tree'; }
            else if (zone === 'Snow Mountain') { chance = 0.08; type = 'rock'; }
            else if (zone === 'Eastern Ruins') { chance = 0.10; type = 'wall'; }
            
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
