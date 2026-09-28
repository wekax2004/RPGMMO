const CFG = require('./config');
const { isWalkable } = require('./map');
const MAP = require('./map');

// --- ניהול תיבות אוצר ---
const chests = new Map();
let chestCounter = 0;

// z is an optional trailing floor selector so a chest can be spawned inside a
// dungeon without changing this signature for its existing callers. Stage 0
// only has the surface, so the walkability search is scoped to the same floor
// the chest lands on.
function spawnChest(broadcast, z = CFG.Z_SURFACE) {
    if (chests.size >= CFG.MAX_CHESTS) return;
    
    const floor = MAP.normalizeZ(z);
    const chestId = 'chest_' + chestCounter++;
    const maxTilesX = Math.floor(CFG.MAP_WIDTH / CFG.TILE_SIZE);
    const maxTilesY = Math.floor(CFG.MAP_HEIGHT / CFG.TILE_SIZE);
    
    let rx, ry;
    let attempts = 0;
    do {
        rx = Math.floor(Math.random() * maxTilesX) * CFG.TILE_SIZE;
        ry = Math.floor(Math.random() * maxTilesY) * CFG.TILE_SIZE;
        attempts++;
    } while (!isWalkable(rx, ry, floor) && attempts < 100);
    
    chests.set(chestId, { id: chestId, x: rx, y: ry, z: floor });
    broadcast({ action: 'chest_update', id: chestId, x: rx, y: ry, z: floor, active: true });
    broadcast({ action: 'log', message: '🎁 A Random Gold Chest appeared somewhere!' });
}

function tryLootChest(player, ws) {
    let looted = false;
    chests.forEach((chest, chestId) => {
        if (player.x === chest.x && player.y === chest.y) {
            player.gold += CFG.CHEST_GOLD_REWARD;
            ws.send(JSON.stringify({ action: 'log', message: `💎 You looted ${CFG.CHEST_GOLD_REWARD} Gold from the chest!` }));
            chests.delete(chestId);
            looted = true;
            // הודעה על חיסול התיבה תשלח מהשרת הראשי דרך broadcast
            return { chestId, x: chest.x, y: chest.y };
        }
    });
    return looted;
}

module.exports = { chests, spawnChest, tryLootChest };
