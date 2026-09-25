const { getZone, isWalkable } = require('./map');
const CFG = require('./config');

const bosses = new Map();
let aoeSequence = 0;

function nextAoeId(bossId, type) {
    aoeSequence += 1;
    return `${bossId}_${type}_${Date.now().toString(36)}_${aoeSequence}`;
}

function broadcastAoe(broadcast, data) {
    if (!broadcast || !data.spellId) return;
    const packet = {
        action: 'boss_aoe',
        id: data.spellId,
        spellId: data.spellId,
        ...data
    };
    // boss_aoe keeps older clients working; the explicit warning/impact
    // actions make the lifecycle unambiguous for new clients and tests.
    broadcast(packet);
    broadcast({
        ...packet,
        action: data.phase === 'warning' ? 'aoe_warning' : 'aoe_impact'
    });
}

function isInsideBossBounds(boss, x, y) {
    const bounds = BOSS_TYPES[boss.type] && BOSS_TYPES[boss.type].bounds;
    if (!bounds) return true;
    return x >= bounds.minX && x < bounds.maxX && y >= bounds.minY && y < bounds.maxY;
}

const BOSS_TYPES = {
    'spider_queen': {
        name: 'Spider Queen',
        hp: 2000,
        damage: 30,
        xp: 500,
        bounds: { minX: 1600, maxX: 3200, minY: 0, maxY: 1600 },
        drops: [
            { item: 'Spider Queen Fang', type: 'weapon', chance: 1.0 },
            { item: 'Silk Armor', type: 'armor', chance: 0.5 }
        ]
    },
    'ice_dragon': {
        name: 'Ice Dragon',
        hp: 3000,
        damage: 45,
        xp: 800,
        bounds: { minX: 0, maxX: 1600, minY: 1600, maxY: 3200 },
        drops: [
            { item: 'Frost Blade', type: 'weapon', chance: 1.0 },
            { item: 'Dragon Scale Armor', type: 'armor', chance: 1.0 },
            { item: 'Ice Crystal', type: 'material', chance: 1.0 }
        ]
    },
    'skeleton_king': {
        name: 'Skeleton King',
        hp: 2500,
        damage: 35,
        xp: 600,
        bounds: { minX: 1600, maxX: 3200, minY: 1600, maxY: 3200 },
        drops: [
            { item: 'Crown of the Dead', type: 'helmet', chance: 1.0 },
            { item: 'Bone Staff', type: 'weapon', chance: 1.0 },
            { item: 'Royal Bones', type: 'material', chance: 1.0 }
        ]
    }
};

function spawnBoss(type, broadcast) {
    const def = BOSS_TYPES[type];
    if (!def) return null;

    let x, y;
    let attempts = 0;
    do {
        x = def.bounds.minX + Math.floor(Math.random() * ((def.bounds.maxX - def.bounds.minX) / CFG.TILE_SIZE)) * CFG.TILE_SIZE;
        y = def.bounds.minY + Math.floor(Math.random() * ((def.bounds.maxY - def.bounds.minY) / CFG.TILE_SIZE)) * CFG.TILE_SIZE;
        attempts++;
    } while (!isWalkable(x, y) && attempts < 100);

    const id = 'boss_' + type + '_' + Date.now().toString(36);
    const boss = {
        id,
        type,
        name: def.name,
        x,
        y,
        hp: def.hp,
        maxHp: def.hp,
        damage: def.damage,
        xpReward: def.xp,
        isBoss: true,
        lastAbilityTime: new Map(),
        lastMoveTime: 0,
        lastAttackTime: 0,
        drops: def.drops
    };
    
    bosses.set(id, boss);
    
    if (broadcast) {
        broadcast({ 
            action: 'mob_update', 
            id: boss.id, 
            type: boss.type, 
            name: boss.name, 
            x: boss.x, 
            y: boss.y, 
            hp: boss.hp, 
            maxHp: boss.maxHp, 
            alive: true,
            isBoss: true 
        });
    }
    
    return boss;
}

function spawnAdd(boss, type, mobs, broadcast) {
    const x = boss.x + (Math.floor(Math.random() * 3) - 1) * CFG.TILE_SIZE;
    const y = boss.y + (Math.floor(Math.random() * 3) - 1) * CFG.TILE_SIZE;
    if (isWalkable(x, y)) {
        const id = 'm_' + Math.random().toString(36).substr(2, 6);
        const stats = { 
            spider: { hp: 30, xp: 15 }, 
            skeleton: { hp: 40, xp: 20 } 
        }[type] || { hp: 30, xp: 15 };
        
        const name = type.charAt(0).toUpperCase() + type.slice(1);
        const mob = {
            id, type, name, x, y,
            hp: stats.hp, maxHp: stats.hp,
            xpReward: stats.xp, isElite: false, lastMoveTime: 0, lastAttackTime: 0
        };
        mobs.set(id, mob);
        
        if (broadcast) {
            broadcast({ 
                action: 'mob_update', 
                id, type, name, x, y, 
                hp: stats.hp, maxHp: stats.hp, 
                alive: true, isElite: false 
            });
        }
    }
}

function castSpiderPoisonAoe(boss, players, broadcast, options = {}) {
    const spellId = nextAoeId(boss.id, 'poison');
    const originX = Number.isFinite(options.originX) ? options.originX : boss.x;
    const originY = Number.isFinite(options.originY) ? options.originY : boss.y;
    const radius = Number.isFinite(options.radius) ? options.radius : 128;
    const damage = Number.isFinite(options.damage) ? options.damage : 40;
    const delay = Number.isFinite(options.delay) ? options.delay : 2000;
    const effectType = typeof options.type === 'string' ? options.type : 'poison';

    broadcastAoe(broadcast, { bossId: boss.id, spellId, x: originX, y: originY, radius, type: effectType, phase: 'warning', durationMs: delay });
    setTimeout(() => {
        if (!bosses.has(boss.id)) return;
        broadcastAoe(broadcast, { bossId: boss.id, spellId, x: originX, y: originY, radius, type: effectType, phase: 'detonate', durationMs: delay });
        for (const player of players.values()) {
            if (player.hp > 0 && Math.hypot(player.x - originX, player.y - originY) <= radius) {
                player.hp -= damage;
                broadcast({ action: 'damage', targetId: player.id, amount: damage });
            }
        }
    }, delay);
    return spellId;
}

function bossAI(boss, players, broadcast, mobs) {
    const now = Date.now();
    const aggroRange = 600;
    const meleeRange = CFG.TILE_SIZE * 1.5;

    // Find nearest player
    let nearest = null;
    let minDist = Infinity;
    for (const player of players.values()) {
        if (player.hp <= 0) continue;
        const dist = Math.hypot(player.x - boss.x, player.y - boss.y);
        if (dist < minDist) {
            minDist = dist;
            nearest = player;
        }
    }

    if (!nearest || minDist > aggroRange) return;

    // Movement
    if (minDist > meleeRange && now - (boss.lastMoveTime || 0) > (CFG.MOB_MOVE_COOLDOWN || 500)) {
        let nx = boss.x;
        let ny = boss.y;
        
        if (Math.abs(nearest.x - boss.x) > Math.abs(nearest.y - boss.y)) {
            nx += nearest.x > boss.x ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
        } else {
            ny += nearest.y > boss.y ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
        }
        
        if (isWalkable(nx, ny) && isInsideBossBounds(boss, nx, ny)) {
            boss.x = nx;
            boss.y = ny;
            boss.lastMoveTime = now;
            broadcast({ action: 'mob_move', id: boss.id, x: boss.x, y: boss.y });
        } else {
            // Try other axis
            nx = boss.x;
            ny = boss.y;
            if (Math.abs(nearest.x - boss.x) <= Math.abs(nearest.y - boss.y)) {
                nx += nearest.x > boss.x ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
            } else {
                ny += nearest.y > boss.y ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
            }
            if (isWalkable(nx, ny) && isInsideBossBounds(boss, nx, ny)) {
                boss.x = nx;
                boss.y = ny;
                boss.lastMoveTime = now;
                broadcast({ action: 'mob_move', id: boss.id, x: boss.x, y: boss.y });
            }
        }
    }

    // Basic melee attacks are handled by the authoritative server combat
    // tick, which applies equipment defense. Keeping one attack path avoids
    // double damage while bosses are in range.

    // Abilities
    if (boss.type === 'spider_queen') {
        if (now - (boss.lastAbilityTime.get('poison_aoe') || 0) > 8000) {
            boss.lastAbilityTime.set('poison_aoe', now);
            castSpiderPoisonAoe(boss, players, broadcast);
        }

        if (now - (boss.lastAbilityTime.get('spawn_adds') || 0) > 15000) {
            boss.lastAbilityTime.set('spawn_adds', now);
            for (let i = 0; i < 2; i++) spawnAdd(boss, 'spider', mobs, broadcast);
        }
        
    } else if (boss.type === 'ice_dragon') {
        if (now - (boss.lastAbilityTime.get('ice_breath') || 0) > 6000) {
            boss.lastAbilityTime.set('ice_breath', now);
            const targetX = nearest.x;
            const targetY = nearest.y;
            const originX = boss.x;
            const originY = boss.y;
            const spellId = nextAoeId(boss.id, 'ice_breath');
            broadcastAoe(broadcast, { bossId: boss.id, spellId, x: originX, y: originY, targetX, targetY, type: 'ice_breath', phase: 'warning' });
            
            setTimeout(() => {
                if (!bosses.has(boss.id)) return;
                broadcastAoe(broadcast, { bossId: boss.id, spellId, x: originX, y: originY, targetX, targetY, type: 'ice_breath', phase: 'detonate' });
                for (const p of players.values()) {
                    if (p.hp <= 0) continue;
                    const distance = Math.hypot(p.x - originX, p.y - originY);
                    if (distance <= 150) {
                        const dx = targetX - originX;
                        const dy = targetY - originY;
                        const px = p.x - originX;
                        const py = p.y - originY;
                        const lenD = Math.hypot(dx, dy) || 1;
                        const lenP = distance || 1;
                        const dot = (dx * px + dy * py) / (lenD * lenP);
                        
                        if (dot > 0.5) { // Roughly 60-degree cone
                            p.hp -= 60;
                            p.stunUntil = Date.now() + 1500;
                            broadcast({ action: 'damage', targetId: p.id, amount: 60 });
                        }
                    }
                }
            }, 1500);
        }

        if (now - (boss.lastAbilityTime.get('ice_crash') || 0) > 20000) {
            boss.lastAbilityTime.set('ice_crash', now);
            const pList = Array.from(players.values()).filter(p => p.hp > 0 && Math.hypot(p.x - boss.x, p.y - boss.y) <= aggroRange);
            if (pList.length > 0) {
                for (let i = 0; i < 3; i++) {
                    const p = pList[Math.floor(Math.random() * pList.length)];
                    const tx = p.x + (Math.random() * 100 - 50);
                    const ty = p.y + (Math.random() * 100 - 50);
                    
                    const spellId = nextAoeId(boss.id, 'ice_crash');
                    broadcastAoe(broadcast, { bossId: boss.id, spellId, x: tx, y: ty, radius: 64, type: 'ice_crash', phase: 'warning' });
                    setTimeout(() => {
                        if (!bosses.has(boss.id)) return;
                        broadcastAoe(broadcast, { bossId: boss.id, spellId, x: tx, y: ty, radius: 64, type: 'ice_crash', phase: 'detonate' });
                        for (const p of players.values()) {
                            if (p.hp > 0 && Math.hypot(p.x - tx, p.y - ty) <= 64) {
                                p.hp -= 80;
                                broadcast({ action: 'damage', targetId: p.id, amount: 80 });
                            }
                        }
                    }, 3000);
                }
            }
        }
        
    } else if (boss.type === 'skeleton_king') {
        if (now - (boss.lastAbilityTime.get('summon_skeletons') || 0) > 10000) {
            boss.lastAbilityTime.set('summon_skeletons', now);
            for (let i = 0; i < 3; i++) spawnAdd(boss, 'skeleton', mobs, broadcast);
        }
        
        if (now - (boss.lastAbilityTime.get('death_wave') || 0) > 12000) {
            boss.lastAbilityTime.set('death_wave', now);
            const spellId = nextAoeId(boss.id, 'death_wave');
            const originX = boss.x;
            const originY = boss.y;
            broadcastAoe(broadcast, { bossId: boss.id, spellId, x: originX, y: originY, radius: 160, type: 'death_wave', phase: 'warning' });
            
            setTimeout(() => {
                if (!bosses.has(boss.id)) return;
                broadcastAoe(broadcast, { bossId: boss.id, spellId, x: originX, y: originY, radius: 160, type: 'death_wave', phase: 'detonate' });
                for (const p of players.values()) {
                    if (p.hp > 0 && Math.hypot(p.x - originX, p.y - originY) <= 160) {
                        p.hp -= 50;
                        broadcast({ action: 'damage', targetId: p.id, amount: 50 });
                    }
                }
            }, 2000);
        }
    }
}

function triggerBossAoe(type, players, broadcast, centerPlayer = null) {
    const boss = Array.from(bosses.values()).find(candidate => candidate.type === type || candidate.id === type);
    if (!boss || !broadcast) return null;

    const target = centerPlayer || Array.from(players.values()).find(player => player.hp > 0);
    const x = target ? target.x : boss.x;
    const y = target ? target.y - 64 : boss.y;
    return castSpiderPoisonAoe(boss, players, broadcast, {
        originX: x,
        originY: y,
        radius: 96,
        damage: 10,
        delay: 1500,
        type: 'fire'
    });
}

module.exports = {
    bosses,
    spawnBoss,
    bossAI,
    triggerBossAoe,
    BOSS_TYPES
};
