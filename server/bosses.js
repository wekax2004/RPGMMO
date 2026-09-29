const { getZone, isWalkable } = require('./map');
const MAP = require('./map');
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

// Are these two things standing on the same floor?
//
// Every targeting test in this file is a 2D circle or cone: "is the player
// within N pixels of the boss". That is only a question about the boss's world
// if the player is in the boss's world. Without this, a player in the city
// standing at the same (x,y) as the Molten Depths is inside a Skeleton King's
// cone, and the floor layouts overlap -- z=-2 sits 544x544 inside the Skeleton
// King's own quadrant -- so this was not theoretical. A king standing at
// (2200,2200), both legal positions, hit a player through the world.
//
// The check is a floor comparison rather than a distance one because that is
// what it is: two entities can be 32 pixels apart and be in different worlds.
function sameFloor(a, b) {
    return MAP.normalizeZ(a && a.z) === MAP.normalizeZ(b && b.z);
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

function spawnBoss(type, broadcast, options = {}) {
    // Injected by the caller so a boss can be announced to its own floor only.
    // Optional, so an older call site keeps working.
    //
    // The fallback takes BOTH arguments. A one-parameter fallback looks
    // equivalent and is not: callers pass (floor, packet), so it bound dataObj
    // to the floor index and broadcast the number 0 in place of the packet.
    // That is precisely the class of mistake this whole refactor is about -- a
    // floor index where a packet was expected -- and it fails silently, because
    // `broadcast` accepts a number without complaint.
    const broadcastToFloor = typeof options.broadcastToFloor === 'function'
        ? options.broadcastToFloor
        : (floor, dataObj) => broadcast(dataObj);
    const def = BOSS_TYPES[type];
    if (!def) return null;

    // A boss belongs to one floor. BOSS_TYPES.bounds are 2D surface bounds, so
    // a lair that is not the surface is opted into via options.z, and the
    // walkability search is scoped to that floor rather than the surface's.
    const floorZ = MAP.normalizeZ(options.z);
    let x, y;
    // An explicit position, for a caller that needs the boss on a known tile --
    // a test photographing it, or a lair that is not the default one. Only
    // honoured when the tile is genuinely standable on the requested floor, so a
    // caller cannot drop a boss inside a wall and then wonder why it never paths
    // anywhere. A bad `at` falls through to the random search rather than
    // failing: a boss that spawns somewhere odd is recoverable, one that does
    // not spawn at all is not.
    const at = options.at;
    if (at && Number.isSafeInteger(at.x) && Number.isSafeInteger(at.y) && isWalkable(at.x, at.y, floorZ)) {
        x = at.x;
        y = at.y;
    } else {
        let attempts = 0;
        do {
            x = def.bounds.minX + Math.floor(Math.random() * ((def.bounds.maxX - def.bounds.minX) / CFG.TILE_SIZE)) * CFG.TILE_SIZE;
            y = def.bounds.minY + Math.floor(Math.random() * ((def.bounds.maxY - def.bounds.minY) / CFG.TILE_SIZE)) * CFG.TILE_SIZE;
            attempts++;
        } while (!isWalkable(x, y, floorZ) && attempts < 100);
    }

    const id = 'boss_' + type + '_' + Date.now().toString(36);
    const boss = {
        id,
        type,
        name: def.name,
        x,
        y,
        z: floorZ,
        hp: def.hp,
        maxHp: def.hp,
        damage: def.damage,
        xpReward: def.xp,
        isBoss: true,
        phase: 1,
        lastAbilityTime: new Map(),
        lastMoveTime: 0,
        lastAttackTime: 0,
        drops: def.drops
    };
    
    bosses.set(id, boss);
    
    if (broadcast) {
        let zone = "world";
        if (type === "yeti") zone = "frozen mountains";
        else if (type === "spider_queen") zone = "dark swamp";
        else if (type === "skeleton_king") zone = "cursed graveyard";
        broadcast({ action: 'log', message: `⚠️ 💀 A terrible roar echoes... The ${def.name} has spawned in the ${zone}! 💀 ⚠️` });

        // Floor-scoped, and it carries the floor. Announced globally, a boss
        // appearing underground was told to every client with no way to say
        // which world the coordinates belonged to -- which is also what made
        // "did a dungeon mob leak?" unanswerable in a live run, since a
        // legitimate entry with no floor looked exactly like a leak.
        broadcastToFloor(floorZ, {
            action: 'mob_update',
            id: boss.id,
            type: boss.type,
            name: boss.name,
            x: boss.x,
            y: boss.y,
            z: floorZ,
            hp: boss.hp,
            maxHp: boss.maxHp,
            alive: true,
            isBoss: true,
            phase: boss.phase
        });

        // Server-wide spawn announcement. The startup path passes
        // { announce: false } so a restart does not fire one alert per boss.
        if (options.announce !== false) {
            broadcast({
                action: 'log',
                message: `⚔️ [GLOBAL ALERT] The terrifying ${boss.name} has spawned!`
            });
            // A dedicated action as well, so a client can raise a banner
            // without parsing the log text.
            broadcast({
                action: 'boss_spawned',
                bossId: boss.id,
                bossType: boss.type,
                name: boss.name,
                x: boss.x,
                y: boss.y,
                maxHp: boss.maxHp
            });
        }
    }
    
    return boss;
}

// `broadcastToFloor` is injected by the caller so the minion is announced to the
// floor it was actually summoned onto. Taking it as a parameter rather than
// reaching for a module-level one is the same discipline the rest of this file
// uses; the previous version referenced an identifier that was not in scope, so
// every add threw a ReferenceError and the boss summoned nothing.
function spawnAdd(boss, type, mobs, broadcast, broadcastToFloor) {
    const x = boss.x + (Math.floor(Math.random() * 3) - 1) * CFG.TILE_SIZE;
    const y = boss.y + (Math.floor(Math.random() * 3) - 1) * CFG.TILE_SIZE;
    // Checked on the summoner boss's floor, not the surface's default. The
    // minion is placed on the boss's floor (see z, below), so validating the
    // tile against a different floor's geometry could drop it inside rock.
    if (isWalkable(x, y, boss.z)) {
        const id = 'm_' + Math.random().toString(36).substr(2, 6);
        const stats = { 
            spider: { hp: 30, xp: 15 }, 
            skeleton: { hp: 40, xp: 20 } 
        }[type] || { hp: 30, xp: 15 };
        
        const name = type.charAt(0).toUpperCase() + type.slice(1);
        const mob = {
            id, type, name, x, y,
            // A minion shares its summoner boss's floor, so it is announced to
            // the same one rather than to everyone.
            z: MAP.normalizeZ(boss.z),
            hp: stats.hp, maxHp: stats.hp,
            xpReward: stats.xp, isElite: false, lastMoveTime: 0, lastAttackTime: 0
        };
        mobs.set(id, mob);

        if (broadcast) {
            broadcastToFloor(mob.z, {
                action: 'mob_update',
                id, type, name, x, y, z: mob.z,
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
    // Injected by the caller so the damage lands only on the floor it happened
    // on. The fallback takes BOTH arguments for the reason spelled out in
    // spawnBoss: a one-parameter fallback silently binds the floor index to the
    // packet and broadcasts a number.
    const toFloor = typeof options.broadcastToFloor === 'function'
        ? options.broadcastToFloor
        : (floor, dataObj) => broadcast(dataObj);

    broadcastAoe(broadcast, { bossId: boss.id, spellId, x: originX, y: originY, radius, type: effectType, phase: 'warning', durationMs: delay });
    setTimeout(() => {
        if (!bosses.has(boss.id)) return;
        broadcastAoe(broadcast, { bossId: boss.id, spellId, x: originX, y: originY, radius, type: effectType, phase: 'detonate', durationMs: delay });
        for (const player of players.values()) {
            // The floor test comes first and is not an optimisation: it is the
            // difference between the AoE being a circle in the boss's world and
            // being a circle in a world where the boss does not exist.
            if (player.hp > 0 && sameFloor(player, boss) &&
                Math.hypot(player.x - originX, player.y - originY) <= radius) {
                player.hp -= damage;
                toFloor(MAP.normalizeZ(player.z), { action: 'damage', targetId: player.id, amount: damage });
            }
        }
    }, delay);
    return spellId;
}

function bossAI(boss, players, broadcast, mobs, broadcastToFloor) {
    const now = Date.now();
    const aggroRange = 600;
    const meleeRange = CFG.TILE_SIZE * 1.5;

    // Find nearest player, on this boss's floor. A player a floor away is not a
    // target no matter how close their (x,y) looks: the boss would walk toward
    // a coordinate that means nothing to it and stop at the lair wall.
    let nearest = null;
    let minDist = Infinity;
    for (const player of players.values()) {
        if (player.hp <= 0) continue;
        if (!sameFloor(player, boss)) continue;
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
        
        if (isWalkable(nx, ny, boss.z) && isInsideBossBounds(boss, nx, ny)) {
            boss.x = nx;
            boss.y = ny;
            boss.lastMoveTime = now;
            broadcastToFloor(boss.z, { action: 'mob_move', id: boss.id, x: boss.x, y: boss.y, z: boss.z });
        } else {
            // Try other axis
            nx = boss.x;
            ny = boss.y;
            if (Math.abs(nearest.x - boss.x) <= Math.abs(nearest.y - boss.y)) {
                nx += nearest.x > boss.x ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
            } else {
                ny += nearest.y > boss.y ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
            }
            if (isWalkable(nx, ny, boss.z) && isInsideBossBounds(boss, nx, ny)) {
                boss.x = nx;
                boss.y = ny;
                boss.lastMoveTime = now;
                broadcastToFloor(boss.z, { action: 'mob_move', id: boss.id, x: boss.x, y: boss.y, z: boss.z });
            }
        }
    }

    // Basic melee attacks are handled by the authoritative server combat
    // tick, which applies equipment defense. Keeping one attack path avoids
    // double damage while bosses are in range.

    // Phase transitions and Abilities
    if (boss.type === 'spider_queen') {
        if (boss.phase === 1 && boss.hp <= boss.maxHp * 0.5) {
            boss.phase = 2;
            broadcast({ action: 'phase_change', id: boss.id, phase: 2 });
        }

        const cdMulti = boss.phase === 2 ? 0.66 : 1.0;

        if (now - (boss.lastAbilityTime.get('poison_aoe') || 0) > 8000 * cdMulti) {
            boss.lastAbilityTime.set('poison_aoe', now);
            castSpiderPoisonAoe(boss, players, broadcast, { broadcastToFloor });
        }

        if (now - (boss.lastAbilityTime.get('spawn_adds') || 0) > 15000 * cdMulti) {
            boss.lastAbilityTime.set('spawn_adds', now);
            const addsCount = boss.phase === 2 ? 4 : 2;
            for (let i = 0; i < addsCount; i++) spawnAdd(boss, 'spider', mobs, broadcast, broadcastToFloor);
        }
        
        if (boss.phase === 2 && now - (boss.lastAbilityTime.get('web_trap') || 0) > 12000) {
            boss.lastAbilityTime.set('web_trap', now);
            const pList = Array.from(players.values()).filter(p => p.hp > 0 && sameFloor(p, boss) && Math.hypot(p.x - boss.x, p.y - boss.y) <= aggroRange);
            if (pList.length > 0) {
                const p = pList[Math.floor(Math.random() * pList.length)];
                p.stunUntil = now + 3000;
                broadcast({ action: 'log', message: `Spider Queen traps ${p.charName} in a web!` });
                broadcastAoe(broadcast, { bossId: boss.id, spellId: nextAoeId(boss.id, 'web_trap'), x: p.x, y: p.y, radius: 16, type: 'poison', phase: 'detonate', durationMs: 0 });
            }
        }
        
    } else if (boss.type === 'ice_dragon') {
        if (boss.phase === 1 && boss.hp <= boss.maxHp * 0.4) {
            boss.phase = 2;
            broadcast({ action: 'phase_change', id: boss.id, phase: 2 });
        }

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
                    if (!sameFloor(p, boss)) continue;
                    const distance = Math.hypot(p.x - originX, p.y - originY);
                    if (distance <= 150) {
                        const dx = targetX - originX;
                        const dy = targetY - originY;
                        const px = p.x - originX;
                        const py = p.y - originY;
                        const lenD = Math.hypot(dx, dy) || 1;
                        const lenP = distance || 1;
                        const dot = (dx * px + dy * py) / (lenD * lenP);
                        
                        const dotThreshold = boss.phase === 2 ? 0.2 : 0.5;
                        if (dot > dotThreshold) { // Wider cone in phase 2
                            p.hp -= 60;
                            p.stunUntil = Date.now() + 1500;
                            broadcastToFloor(MAP.normalizeZ(p.z), { action: 'damage', targetId: p.id, amount: 60 });
                        }
                    }
                }
            }, 1500);
        }

        if (now - (boss.lastAbilityTime.get('ice_crash') || 0) > 20000) {
            boss.lastAbilityTime.set('ice_crash', now);
            const pList = Array.from(players.values()).filter(p => p.hp > 0 && sameFloor(p, boss) && Math.hypot(p.x - boss.x, p.y - boss.y) <= aggroRange);
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
                            if (p.hp > 0 && sameFloor(p, boss) && Math.hypot(p.x - tx, p.y - ty) <= 64) {
                                p.hp -= 80;
                                broadcastToFloor(MAP.normalizeZ(p.z), { action: 'damage', targetId: p.id, amount: 80 });
                            }
                        }
                    }, 3000);
                }
            }
        }

        if (boss.phase === 2 && now - (boss.lastAbilityTime.get('blizzard') || 0) > 25000) {
            boss.lastAbilityTime.set('blizzard', now);
            const spellId = nextAoeId(boss.id, 'blizzard');
            broadcastAoe(broadcast, { bossId: boss.id, spellId, x: boss.x, y: boss.y, radius: 200, type: 'ice_crash', phase: 'warning', durationMs: 2000 });
            setTimeout(() => {
                if (!bosses.has(boss.id)) return;
                broadcastAoe(broadcast, { bossId: boss.id, spellId, x: boss.x, y: boss.y, radius: 200, type: 'ice_crash', phase: 'detonate', durationMs: 5000 });
                // Simple implementation: instant large damage. Full DoT requires tracking in server tick.
                for (const p of players.values()) {
                    if (p.hp > 0 && sameFloor(p, boss) && Math.hypot(p.x - boss.x, p.y - boss.y) <= 200) {
                        p.hp -= 100;
                        broadcastToFloor(MAP.normalizeZ(p.z), { action: 'damage', targetId: p.id, amount: 100 });
                    }
                }
            }, 2000);
        }
        
    } else if (boss.type === 'skeleton_king') {
        if (boss.phase === 1 && boss.hp <= boss.maxHp * 0.3) {
            boss.phase = 2;
            broadcast({ action: 'phase_change', id: boss.id, phase: 2 });
        }

        if (now - (boss.lastAbilityTime.get('summon_skeletons') || 0) > 10000) {
            boss.lastAbilityTime.set('summon_skeletons', now);
            const addsCount = boss.phase === 2 ? 5 : 3;
            for (let i = 0; i < addsCount; i++) spawnAdd(boss, 'skeleton', mobs, broadcast, broadcastToFloor);
        }
        
        if (now - (boss.lastAbilityTime.get('death_wave') || 0) > 12000) {
            boss.lastAbilityTime.set('death_wave', now);
            const spellId = nextAoeId(boss.id, 'death_wave');
            const originX = boss.x;
            const originY = boss.y;
            const waveRadius = boss.phase === 2 ? 200 : 160;
            broadcastAoe(broadcast, { bossId: boss.id, spellId, x: originX, y: originY, radius: waveRadius, type: 'death_wave', phase: 'warning' });
            
            setTimeout(() => {
                if (!bosses.has(boss.id)) return;
                broadcastAoe(broadcast, { bossId: boss.id, spellId, x: originX, y: originY, radius: waveRadius, type: 'death_wave', phase: 'detonate' });
                for (const p of players.values()) {
                    if (p.hp > 0 && sameFloor(p, boss) && Math.hypot(p.x - originX, p.y - originY) <= waveRadius) {
                        p.hp -= 50;
                        broadcastToFloor(MAP.normalizeZ(p.z), { action: 'damage', targetId: p.id, amount: 50 });
                    }
                }
            }, 2000);
        }

        if (boss.phase === 2 && now - (boss.lastAbilityTime.get('bone_prison') || 0) > 15000) {
            boss.lastAbilityTime.set('bone_prison', now);
            if (nearest) {
                nearest.stunUntil = now + 4000;
                broadcast({ action: 'log', message: `Skeleton King traps ${nearest.name} in a Bone Prison!` });
                broadcastAoe(broadcast, { bossId: boss.id, spellId: nextAoeId(boss.id, 'bone_prison'), x: nearest.x, y: nearest.y, radius: 24, type: 'death_wave', phase: 'detonate', durationMs: 0 });
            }
        }
    }
}

function triggerBossAoe(type, players, broadcast, centerPlayer = null, broadcastToFloor = null) {
    const boss = Array.from(bosses.values()).find(candidate => candidate.type === type || candidate.id === type);
    if (!boss || !broadcast) return null;

    // The centre defaults to a living player, and "a living player" has to mean
    // one on the boss's floor. Taking the first in map order meant a player
    // standing in the city could become the centre of a spell cast in a cave,
    // with the circle drawn around coordinates the boss cannot see.
    const target = centerPlayer || Array.from(players.values())
        .find(player => player.hp > 0 && sameFloor(player, boss));
    const x = target ? target.x : boss.x;
    const y = target ? target.y - 64 : boss.y;
    return castSpiderPoisonAoe(boss, players, broadcast, {
        originX: x,
        originY: y,
        radius: 96,
        damage: 10,
        delay: 1500,
        type: 'fire',
        // Only forwarded when supplied. castSpiderPoisonAoe falls back to a
        // global broadcast, which is correct for a caller that has no floor
        // scope to give, and wrong for one that does -- so a real injection is
        // passed all the way down rather than reconstructed here.
        ...(typeof broadcastToFloor === 'function' ? { broadcastToFloor } : {})
    });
}

module.exports = {
    bosses,
    spawnBoss,
    bossAI,
    triggerBossAoe,
    BOSS_TYPES
};
