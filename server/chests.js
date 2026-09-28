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
// Places a chest on a real, standable tile of the given floor.
//
// The old version picked random coordinates and retried on !isWalkable. That is
// not sufficient once chests exist on more than one floor: a rejected attempt
// leaves the loop holding the last coordinate it *tried*, which is by
// construction one it already rejected, so a chest could be created inside a
// wall. MAP.randomWalkableTile enumerates the floor instead, and returns null
// when the floor cannot hold one.
function spawnChest(broadcast, z = CFG.Z_SURFACE, options = {}) {
    if (chests.size >= CFG.MAX_CHESTS) return;

    const floor = MAP.normalizeZ(z);
    const spot = options.at || MAP.randomWalkableTile(floor);
    if (!spot) return;

    const chestId = 'chest_' + chestCounter++;
    chests.set(chestId, { id: chestId, x: spot.x, y: spot.y, z: floor });
    broadcast({
        action: 'chest_update', id: chestId, x: spot.x, y: spot.y, z: floor, active: true
    });
    broadcast({
        action: 'log',
        message: options.quiet
            ? ''
            : (floor === CFG.Z_SURFACE
                ? '🎁 A Random Gold Chest appeared somewhere!'
                : '🎁 A chest glitters in the dark...')
    });
}

function tryLootChest(player, ws) {
    let looted = false;
    const pz = MAP.normalizeZ(player.z);
    chests.forEach((chest, chestId) => {
        // The floor is part of the match. Without it a player standing in the
        // dungeon at a surface chest's coordinates loots it through a metre of
        // rock, and the chest vanishes from the surface for everyone.
        if (player.x === chest.x && player.y === chest.y && MAP.normalizeZ(chest.z) === pz) {
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
