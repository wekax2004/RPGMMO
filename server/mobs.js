const CFG = require('./config');
const { getZone, isWalkable } = require('./map');

const mobs = new Map();

function getMobTypeForZone(zone) {
    if (zone === 'Forest') return Math.random() < 0.4 ? 'bear' : 'spider';
    if (zone === 'Snow Mountain') return 'yeti';
    if (zone === 'Eastern Ruins') {
        const r = Math.random();
        if (r < 0.33) return 'minotaur';
        if (r < 0.66) return 'bandit';
        return 'skeleton';
    }
    return 'spider'; // default fallback
}

function getMobStats(type, isElite) {
    let hp = 30, xp = 15;
    if (type === 'spider') { hp = 30; xp = 15; }
    if (type === 'skeleton') { hp = 40; xp = 20; }
    if (type === 'bandit') { hp = 50; xp = 25; }
    if (type === 'bear') { hp = 65; xp = 35; }
    if (type === 'minotaur') { hp = 80; xp = 45; }
    if (type === 'yeti') { hp = 100; xp = 60; }
    
    if (isElite) { hp *= 2; xp *= 2.5; }
    return { hp, xp };
}

function spawnMobPack(broadcast, size = 3) {
    let packX, packY, zone;
    
    // Find a valid spot for the pack center
    do {
        packX = Math.floor(Math.random() * (CFG.MAP_WIDTH / CFG.TILE_SIZE)) * CFG.TILE_SIZE;
        packY = Math.floor(Math.random() * (CFG.MAP_HEIGHT / CFG.TILE_SIZE)) * CFG.TILE_SIZE;
        zone = getZone(packX, packY);
    } while (!isWalkable(packX, packY) || inSafeZone(packX, packY) || zone === 'City');

    const type = getMobTypeForZone(zone);
    const isElite = Math.random() < 0.1;
    let name = isElite ? 'Elite ' : '';
    name += type.charAt(0).toUpperCase() + type.slice(1);
    
    const stats = getMobStats(type, isElite);

    for (let i = 0; i < size; i++) {
        let x = packX + (Math.floor(Math.random() * 3) - 1) * CFG.TILE_SIZE;
        let y = packY + (Math.floor(Math.random() * 3) - 1) * CFG.TILE_SIZE;
        
        // Ensure spawn point is walkable
        if (isWalkable(x, y) && !inSafeZone(x, y)) {
            const id = 'm_' + Math.random().toString(36).substr(2, 6);
            mobs.set(id, {
                id, type, name, x, y,
                hp: stats.hp, maxHp: stats.hp,
                xpReward: stats.xp, isElite, lastMoveTime: 0, lastAttackTime: 0
            });
            broadcast({ action: 'mob_update', id, type, name, x, y, hp: stats.hp, maxHp: stats.hp, alive: true, isElite });
        }
    }
}

function inSafeZone(x, y) {
    return x >= CFG.SAFE_ZONE.x && x < CFG.SAFE_ZONE.x + CFG.SAFE_ZONE.w &&
           y >= CFG.SAFE_ZONE.y && y < CFG.SAFE_ZONE.y + CFG.SAFE_ZONE.h;
}

function moveMobToward(mob, targetX, targetY) {
    const now = Date.now();
    if (now - (mob.lastMoveTime || 0) < CFG.MOB_MOVE_COOLDOWN) return false;
    
    let nx = mob.x, ny = mob.y;
    if (Math.abs(targetX - mob.x) > Math.abs(targetY - mob.y)) {
        nx += targetX > mob.x ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
    } else {
        ny += targetY > mob.y ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
    }
    
    if (isWalkable(nx, ny) && !inSafeZone(nx, ny)) {
        mob.x = nx; mob.y = ny;
        mob.lastMoveTime = now;
        return true;
    }
    
    // Try other axis if blocked
    nx = mob.x; ny = mob.y;
    if (Math.abs(targetX - mob.x) <= Math.abs(targetY - mob.y)) {
        nx += targetX > mob.x ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
    } else {
        ny += targetY > mob.y ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
    }

    if (isWalkable(nx, ny) && !inSafeZone(nx, ny)) {
        mob.x = nx; mob.y = ny;
        mob.lastMoveTime = now;
        return true;
    }

    return false;
}

function mobAttack(mob, player, damageMultiplier = 1.0, defense = 0) {
    const now = Date.now();
    const attackCooldown = mob.isElite ? CFG.MOB_ATTACK_COOLDOWN * 0.7 : CFG.MOB_ATTACK_COOLDOWN;
    if (now - (mob.lastAttackTime || 0) < attackCooldown) return null;
    
    mob.lastAttackTime = now;
    
    let damage = 5;
    if (mob.type === 'spider') damage = Math.floor(Math.random() * 5) + 5;
    if (mob.type === 'skeleton') damage = Math.floor(Math.random() * 6) + 6;
    if (mob.type === 'bandit') damage = Math.floor(Math.random() * 8) + 8;
    if (mob.type === 'minotaur') damage = Math.floor(Math.random() * 15) + 10;
    if (mob.type === 'bear') damage = Math.floor(Math.random() * 10) + 10;
    if (mob.type === 'yeti') damage = Math.floor(Math.random() * 18) + 12;
    
    if (mob.isElite) damage = Math.floor(damage * 1.5);
    
    damage = Math.floor(damage * damageMultiplier); 
    damage = Math.max(1, damage - defense); 
    
    player.hp -= damage;
    
    let poisoned = false, bled = false, stunned = false;
    
    if (mob.type === 'spider' && Math.random() < CFG.POISON_CHANCE) { player.poisonStacks++; poisoned = true; }
    if ((mob.type === 'bandit' || mob.type === 'minotaur') && Math.random() < CFG.BLEED_CHANCE) { player.bleedStacks++; bled = true; }
    if ((mob.type === 'bear' || mob.type === 'yeti') && Math.random() < CFG.STUN_CHANCE) { 
        player.stunUntil = now + CFG.STUN_DURATION; stunned = true; 
    }
    
    return { damage, poisoned, bled, stunned };
}

module.exports = { mobs, spawnMobPack, inSafeZone, moveMobToward, mobAttack };
