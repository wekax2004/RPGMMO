const CFG = require('./config');
const DODGE = require('./dodge');
const { getZone, isWalkable } = require('./map');
const MAP = require('./map');

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

// `tier` scales a mob for the floor it lives on. Underground creatures are
// tougher than their surface namesakes without needing new sprites or new types:
// a dungeon skeleton is the same skeleton, scaled. Keeping it a multiplier
// rather than a new type list means the surface economy and the loot table
// stay untouched, and a mob's identity -- which quests count, what it drops --
// does not change with the floor.
function getMobStats(type, isElite, tier = 1) {
    let hp = 30, xp = 15;
    if (type === 'spider') { hp = 30; xp = 15; }
    if (type === 'skeleton') { hp = 40; xp = 20; }
    if (type === 'bandit') { hp = 50; xp = 25; }
    if (type === 'bear') { hp = 65; xp = 35; }
    if (type === 'minotaur') { hp = 80; xp = 45; }
    if (type === 'yeti') { hp = 100; xp = 60; }

    if (tier !== 1) {
        hp = Math.round(hp * tier);
        xp = Math.round(xp * tier);
    }
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
    } while (!isWalkable(packX, packY) || inSafeZone(packX, packY, CFG.Z_SURFACE) || zone === 'City');

    const type = getMobTypeForZone(zone);
    const isElite = Math.random() < 0.1;
    let name = isElite ? 'Elite ' : '';
    name += type.charAt(0).toUpperCase() + type.slice(1);
    
    const stats = getMobStats(type, isElite);

    for (let i = 0; i < size; i++) {
        let x = packX + (Math.floor(Math.random() * 3) - 1) * CFG.TILE_SIZE;
        let y = packY + (Math.floor(Math.random() * 3) - 1) * CFG.TILE_SIZE;
        
        // Ensure spawn point is walkable
        if (isWalkable(x, y) && !inSafeZone(x, y, CFG.Z_SURFACE)) {
            const id = 'm_' + Math.random().toString(36).substr(2, 6);
            mobs.set(id, {
                id, type, name, x, y, z: CFG.Z_SURFACE,
                hp: stats.hp, maxHp: stats.hp,
                // Stated rather than left implicit. getMobStats was called without a
                // tier, so the default of 1 applied and the surface is tier 1. See
                // the note in spawnFloorPack for why this is recorded at all.
                tier: 1,
                xpReward: stats.xp, isElite, lastMoveTime: 0, lastAttackTime: 0,
                // Home anchor for patrolling (roadmap 5.2), plus the flee and
                // call-for-help timers. Set at spawn rather than inferred later: a mob
                // that has already wandered has no way to know where it started, and
                // "drift home" is the whole reason patrols stay near their pack
                // instead of emptying a floor over a long session.
                homeX: x, homeY: y, fleeUntil: 0, lastCallAt: 0
            });
            broadcast({ action: 'mob_update', id, type, name, x, y, z: CFG.Z_SURFACE, hp: stats.hp, maxHp: stats.hp, alive: true, isElite });
        }
    }
}
const KNOWN_MOB_TYPES = ['spider', 'skeleton', 'bandit', 'bear', 'minotaur', 'yeti'];

// Spawns a pack of one type on one floor, at real standable tiles.
//
// The surface path (spawnMobPack) picks a random coordinate and checks
// isWalkable. Doing that underground is wrong in a way that is invisible from
// the surface: a random coordinate in a 14x14 cave is almost always solid, so
// the pack silently spawns nothing, or -- if a coordinate is kept from the last
// attempt -- spawns inside a wall. Enumerating the floor's standable tiles makes
// a miss impossible and lets the caller be told when a floor cannot hold a mob.
//
// `tier` scales stats for the floor. `types` restricts the roster, so the
// dungeon gets undead rather than a surface bear wandering underground.
function spawnFloorPack(broadcast, options = {}) {
    const z = MAP.normalizeZ(options.z);
    const types = Array.isArray(options.types) && options.types.length
        ? options.types.filter(t => KNOWN_MOB_TYPES.indexOf(t) !== -1)
        : KNOWN_MOB_TYPES;
    const roster = types.length ? types : KNOWN_MOB_TYPES;
    const size = Math.max(0, Math.floor(options.size || 0));
    const tier = Number.isFinite(options.tier) && options.tier > 0 ? options.tier : 1;
    const eliteChance = Number.isFinite(options.eliteChance) ? options.eliteChance : 0.1;

    const spawned = [];
    for (let i = 0; i < size; i++) {
        const spot = MAP.randomWalkableTile(z);
        if (!spot) break;   // the floor is full of geometry; stop, do not guess
        const type = roster[Math.floor(Math.random() * roster.length)];
        const isElite = Math.random() < eliteChance;
        const stats = getMobStats(type, isElite, tier);
        const name = (isElite ? 'Elite ' : '') + type.charAt(0).toUpperCase() + type.slice(1);
        const id = 'm_' + Math.random().toString(36).substr(2, 6);
        mobs.set(id, {
            id, type, name, x: spot.x, y: spot.y, z,
            hp: stats.hp, maxHp: stats.hp,
            // `tier` is recorded, not just fed to getMobStats. Stats are the only
            // thing that used it, so it was a local and then it was a number nobody
            // could ask about afterwards. Anything keyed on how deep a mob is -- the
            // rare-drop roll in rarity.js -- needs to read it off the mob later, long
            // after the spawn call that knew it.
            tier,
            xpReward: stats.xp, isElite, lastMoveTime: 0, lastAttackTime: 0,
            // See the note in spawnMobPack. `spot` exists here; the surface path uses
            // x/y locals, so the two spawn sites name their own tile.
            homeX: spot.x, homeY: spot.y, fleeUntil: 0, lastCallAt: 0
        });
        broadcast({
            action: 'mob_update', id, type, name, x: spot.x, y: spot.y, z,
            hp: stats.hp, maxHp: stats.hp, alive: true, isElite
        });
        spawned.push(id);
    }
    return spawned;
}

// How many mobs a floor currently holds. Used by the respawn driver to top the
// dungeon back up to its intended population rather than appending forever.
function countMobsOn(z) {
    const floor = MAP.normalizeZ(z);
    let n = 0;
    for (const mob of mobs.values()) {
        if (MAP.normalizeZ(mob.z) === floor) n++;
    }
    return n;
}

// Spawns a single mob of an exact type at an exact spot. Normal spawning is
// randomised across the whole map, which makes it impossible for a test to
// reliably get into melee range; this is the deterministic entry point the
// TEST_MODE test_spawn_mob action uses.
//
// z is a trailing parameter with a default, not an inserted third argument.
// The documented alternative -- spawnMobAt(x, y, z, type) -- would silently
// reinterpret every existing call's type as a floor index, and this function
// already has a test-mode caller that would have broken with no type error.
function spawnMobAt(x, y, type, broadcast, z = CFG.Z_SURFACE) {
    const resolved = KNOWN_MOB_TYPES.indexOf(type) !== -1 ? type : 'spider';
    const isElite = false;
    // Read the tier off the floor this mob is being placed on, rather than assuming
    // the surface. This is the test-only spawn path, so a harness asking for a mob on
    // z=-3 was previously getting tier-1 stats -- which also meant the rare-drop roll
    // in rarity.js saw tier 1 and could never fire for a probe on a deep floor.
    const floor = MAP.normalizeZ(z);
    const floorSpec = (CFG.Z_FLOORS || []).find(f => f.z === floor);
    const tier = floorSpec && Number.isFinite(floorSpec.tier) ? floorSpec.tier : 1;
    const stats = getMobStats(resolved, isElite, tier);
    const id = 'm_' + Math.random().toString(36).substr(2, 6);
    const name = resolved.charAt(0).toUpperCase() + resolved.slice(1);
    mobs.set(id, {
        id, type: resolved, name, x, y, z: floor,
        hp: stats.hp, maxHp: stats.hp,
        tier,
        xpReward: stats.xp, isElite, lastMoveTime: 0, lastAttackTime: 0,
        // See the note in spawnMobPack.
        homeX: x, homeY: y, fleeUntil: 0, lastCallAt: 0
    });
    if (typeof broadcast === 'function') {
        broadcast({
            action: 'mob_update', id, type: resolved, name, x, y, z: floor,
            hp: stats.hp, maxHp: stats.hp, alive: true, isElite
        });
    }
    return id;
}

// Only the surface has a safe zone. Underground is meant to be dangerous, and
// the dungeon happens to sit outside the city's coordinates -- which is why
// this worked without a floor parameter. That is a coincidence of layout, not a
// rule: a dungeon built under the city would make its players permanently
// invulnerable, self-healing, and unable to be fought, because every caller
// would read their coordinates as "in the city". Stating the floor here makes
// the rule explicit instead of positional.
function inSafeZone(x, y, z = CFG.Z_SURFACE) {
    if (MAP.normalizeZ(z) !== CFG.Z_SURFACE) return false;
    return x >= CFG.SAFE_ZONE.x && x < CFG.SAFE_ZONE.x + CFG.SAFE_ZONE.w &&
           y >= CFG.SAFE_ZONE.y && y < CFG.SAFE_ZONE.y + CFG.SAFE_ZONE.h;
}

/**
 * Moves a mob one step. `nx`/`ny` are the proposed tile; the walkability and
 * safe-zone checks are identical for every caller, so they live here once.
 *
 * Roadmap 5.2 added a third caller -- fleeing mobs walk AWAY from a target, and
 * patrolling mobs walk somewhere arbitrary -- and all three need the same refusal to
 * walk into rock or into the city. Duplicating that check per caller is how a
 * fleeing mob ends up standing inside a wall.
 */
function tryStep(mob, nx, ny) {
    if (!isWalkable(nx, ny) || inSafeZone(nx, ny, MAP.normalizeZ(mob.z))) return false;
    mob.x = nx;
    mob.y = ny;
    return true;
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

    if (tryStep(mob, nx, ny)) { mob.lastMoveTime = now; return true; }

    // Try other axis if blocked
    nx = mob.x; ny = mob.y;
    if (Math.abs(targetX - mob.x) <= Math.abs(targetY - mob.y)) {
        nx += targetX > mob.x ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
    } else {
        ny += targetY > mob.y ? CFG.TILE_SIZE : -CFG.TILE_SIZE;
    }

    if (tryStep(mob, nx, ny)) { mob.lastMoveTime = now; return true; }

    return false;
}

/**
 * Moves a mob one step directly away from a point (roadmap 5.2).
 *
 * Separate from `moveMobToward` rather than a negative distance, because "toward" and
 * "away from" need different steering: fleeing has to prefer the axis that increases
 * distance most, which is the opposite preference, and a mob cornered against a wall
 * should try the other axis rather than give up.
 */
function moveMobAway(mob, fromX, fromY) {
    const now = Date.now();
    if (now - (mob.lastMoveTime || 0) < CFG.MOB_MOVE_COOLDOWN) return false;

    const awayX = fromX > mob.x ? -1 : 1;
    const awayY = fromY > mob.y ? -1 : 1;
    // X first, then Y, then the two diagonals. The diagonal step is what stops a
    // fleeing mob pinned against a wall on one axis from simply giving up in the
    // corner, which is where a naive implementation always ends up.
    const options = [
        [awayX, 0], [0, awayY],
        [awayX, awayY], [-awayX, awayY],
        [awayX, -awayY], [0, -awayY], [-awayX, 0]
    ];
    for (const [dx, dy] of options) {
        if (tryStep(mob, mob.x + dx * CFG.TILE_SIZE, mob.y + dy * CFG.TILE_SIZE)) {
            mob.lastMoveTime = now;
            return true;
        }
    }
    return false;
}

/**
 * Wanders a mob one step (roadmap 5.2).
 *
 * Biased toward its own spawn point, so a patrolling mob drifts home rather than
 * wandering the entire map over a long session and leaving a floor empty. The bias is
 * applied most of the time, not always: a mob that only ever moved toward home would
 * stand still at its spawn, which is what it was doing before this feature existed.
 */
function patrolStep(mob, random = Math.random) {
    const now = Date.now();
    if (now - (mob.lastMoveTime || 0) < CFG.MOB_MOVE_COOLDOWN) return false;

    // Stray for a while, then head home.
    const hasHome = mob.homeX !== undefined && mob.homeX !== null;
    const straying = !hasHome || (random() < PATROL_HOME_BIAS);
    let tx, ty;
    if (!hasHome) {
        tx = mob.x + (Math.floor(random() * 5) - 2) * CFG.TILE_SIZE;
        ty = mob.y + (Math.floor(random() * 5) - 2) * CFG.TILE_SIZE;
    } else if (straying) {
        tx = mob.x + (Math.floor(random() * 5) - 2) * CFG.TILE_SIZE;
        ty = mob.y + (Math.floor(random() * 5) - 2) * CFG.TILE_SIZE;
    } else {
        tx = mob.homeX;
        ty = mob.homeY;
    }
    return moveMobToward(mob, tx, ty);
}

const PATROL_HOME_BIAS = 0.7;

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

    // Dodge and block (roadmap 5.3). One call, because the caller makes a single
    // decision about this attack and two calls would let both fire on the same hit.
    //
    // Elites are harder to dodge, and the floor is a floor: the chance can reach 0 but
    // never below it, so no attacker is guaranteed to hit.
    const resolved = DODGE.resolveIncoming({
        attacker: { dodgePenalty: mob.isElite ? 0.1 : 0 },
        defender: player,
        rawDamage: damage,
        defense,
        random: Math.random
    });

    // A dodge resolves the whole attack. Nothing below runs: no damage, and none of
    // the on-hit effects, because the attack never connected. Applying poison to a
    // player who was never touched would be a status effect with no cause.
    if (resolved.dodged) {
        return { damage: 0, dodged: true, blocked: false, poisoned: false, bled: false, stunned: false, staminaSpent: resolved.staminaSpent };
    }

    damage = resolved.damage;
    player.hp -= damage;

    let poisoned = false, bled = false, stunned = false;

    if (mob.type === 'spider' && Math.random() < CFG.POISON_CHANCE) { player.poisonStacks++; poisoned = true; }
    if ((mob.type === 'bandit' || mob.type === 'minotaur') && Math.random() < CFG.BLEED_CHANCE) { player.bleedStacks++; bled = true; }
    if ((mob.type === 'bear' || mob.type === 'yeti') && Math.random() < CFG.STUN_CHANCE) {
        player.stunUntil = now + CFG.STUN_DURATION; stunned = true;
    }

    return { damage, dodged: false, blocked: resolved.blocked, poisoned, bled, stunned, staminaSpent: resolved.staminaSpent };
}

module.exports = {
    mobs, spawnMobPack, spawnFloorPack, spawnMobAt, inSafeZone,
    moveMobToward, moveMobAway, patrolStep, mobAttack, countMobsOn, getMobStats,
    KNOWN_MOB_TYPES
};
