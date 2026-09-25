const CFG = require('./config');

// --- ניהול תיבות אוצר ---
const chests = new Map();
let chestCounter = 0;

function spawnChest(broadcast) {
    if (chests.size >= CFG.MAX_CHESTS) return;
    
    const chestId = 'chest_' + chestCounter++;
    const maxTilesX = Math.floor(CFG.MAP_WIDTH / CFG.TILE_SIZE);
    const maxTilesY = Math.floor(CFG.MAP_HEIGHT / CFG.TILE_SIZE);
    const rx = Math.floor(Math.random() * maxTilesX) * CFG.TILE_SIZE;
    const ry = Math.floor(Math.random() * maxTilesY) * CFG.TILE_SIZE;
    
    chests.set(chestId, { id: chestId, x: rx, y: ry });
    broadcast({ action: 'chest_update', id: chestId, x: rx, y: ry, active: true });
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
