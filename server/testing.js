/*
 * server/testing.js
 *
 * Test-only packet handlers, extracted from the server.js monolith.
 *
 * These exist so a harness can reach a state on demand: spawn a specific mob,
 * place a boss at a known tile, grant XP or gold, heal to full. Every one is gated
 * on TEST_MODE, which the server only sets when TIBIA_TEST_MODE=true, so a
 * production process never reaches this file's logic even if a client asks.
 *
 * Extracted as the first step of splitting server.js (roadmap 7.1) because this
 * block is self-contained: it touches a dozen server objects, none of which are
 * defined between here and the handler, so moving it is a mechanical change that
 * can be verified rather than a redesign.
 *
 * The context object is built once per packet by the caller and passed in, rather
 * than imported, because these handlers need the same live references the rest of
 * the packet path uses. Importing them would mean either duplicating state or
 * exporting mutable internals from server.js, which is worse than passing a
 * context.
 */

/**
 * @param {object} ctx
 * @returns {boolean} true if the action was a test action and has been handled
 */
function handleTestAction(ctx) {
    const {
        data, player, players, bosses,
        sendTo, sendProtocolError, broadcast, broadcastToFloor,
        spawnBroadcast, spawnMobAt, spawnBoss, triggerBossAoe, addXp,
        isInBounds, isWalkable, knownMobTypes, bossTypes, tileSize
    } = ctx;

    switch (data.action) {
        case 'attack_boss': {
            const boss = Array.from(bosses.values()).find(candidate =>
                candidate.id === data.bossId || candidate.type === data.bossId ||
                (typeof data.bossId === 'string' && candidate.id.startsWith(data.bossId))
            );
            if (boss) player.targetId = boss.id;
            return true;
        }

        case 'test_spawn_mob': {
            // Deterministic melee/gather testing: normal mob spawning is randomised
            // across the whole map, so a test can never reliably reach a mob on foot.
            const type = typeof data.type === 'string' ? data.type : 'spider';
            // Reject an unknown type instead of letting spawnMobAt quietly substitute
            // a spider. It used to: the log said "Spawned ice_dragon", the floor was
            // told about a spider, and a test waiting for a boss to appear waited
            // forever for something that was never going to be sent.
            if (!knownMobTypes.includes(type)) {
                sendProtocolError(player, `Unknown mob type '${type}'. Known: ${knownMobTypes.join(', ')}.`);
                return true;
            }
            const x = Number.isInteger(data.x) ? data.x : player.x + tileSize;
            const y = Number.isInteger(data.y) ? data.y : player.y;
            // The caller's own floor, for the same reason the boss case below does:
            // the surface's walkable set and a dungeon's barely overlap, and a player
            // in the crypt who asks for a mob would otherwise have it validated
            // against the city and placed in the city.
            const floor = player.z;
            if (!isInBounds(x, y) || !isWalkable(x, y, floor)) {
                sendProtocolError(player, 'Spawn point is not walkable.');
                return true;
            }
            // Announced through the scoped sender, so a spawn respects both the floor
            // and the area of interest. It used to be handed `broadcast`, which sent
            // every spawn to every player on every floor regardless of either.
            const id = spawnMobAt(x, y, type, spawnBroadcast, floor);
            sendTo(player, { action: 'log', message: `Spawned ${type} at ${x},${y} (${id}).` });
            return true;
        }

        case 'test_spawn_boss': {
            // Bosses are not in the mob roster -- they are a separate set with their
            // own lairs -- so they need their own affordance. spawnBoss otherwise
            // picks a random tile inside the boss's quadrant, which is no use to a
            // test that wants to look at it.
            const type = typeof data.type === 'string' ? data.type : 'spider_queen';
            if (!bossTypes[type]) {
                sendProtocolError(player, `Unknown boss type '${type}'. Known: ${Object.keys(bossTypes).join(', ')}.`);
                return true;
            }
            const x = Number.isInteger(data.x) ? data.x : player.x + tileSize * 2;
            const y = Number.isInteger(data.y) ? data.y : player.y;
            // Floor-aware, because a boss placed on the caller's floor must be checked
            // against that floor's geometry. The surface's walkable set and a dungeon's
            // barely overlap.
            if (!isInBounds(x, y) || !isWalkable(x, y, player.z)) {
                sendProtocolError(player, 'Spawn point is not walkable.');
                return true;
            }
            const boss = spawnBoss(type, broadcast, { at: { x, y }, z: player.z, broadcastToFloor });
            if (!boss) {
                sendProtocolError(player, 'Boss failed to spawn.');
                return true;
            }
            sendTo(player, { action: 'log', message: `Spawned boss ${type} at ${boss.x},${boss.y} (${boss.id}).` });
            return true;
        }

        case 'trigger_boss_aoe': {
            const spellId = triggerBossAoe(data.bossType || 'spider_queen', players, broadcast, player, broadcastToFloor);
            if (!spellId) sendProtocolError(player, 'Boss not found.');
            return true;
        }

        case 'test_grant_xp': {
            const amount = Number(data.amount);
            if (Number.isFinite(amount) && amount > 0) addXp(player, Math.floor(amount));
            return true;
        }

        case 'test_grant_item': {
            const item = typeof data.item === 'string' ? data.item.slice(0, 100) : '';
            if (item) player.inventory.push(item);
            sendStatus(ctx);
            return true;
        }

        case 'test_grant_mana': {
            const amount = Number(data.amount);
            if (Number.isFinite(amount) && amount > 0) {
                player.mana = Math.min(player.maxMana, player.mana + Math.floor(amount));
                sendStatus(ctx);
            }
            return true;
        }

        case 'test_heal': {
            // Restores the character to full. A dungeon populated with tier-scaled
            // mobs is lethal to a level 1 character on contact, which is correct for
            // the game but makes any harness that has to stand still underground --
            // to verify traversal, not combat -- fail for the wrong reason.
            player.hp = player.maxHp;
            player.mana = player.maxMana;
            player.poisonStacks = 0;
            player.bleedStacks = 0;
            player.stunUntil = 0;
            sendStatus(ctx);
            return true;
        }

        case 'test_grant_gold': {
            const amount = Number(data.amount);
            if (Number.isSafeInteger(amount) && amount >= 0) player.gold = amount;
            sendStatus(ctx);
            return true;
        }

        default:
            return false;
    }
}

/**
 * The status packet, sent after every mutation so the client reflects the change
 * immediately instead of waiting for the next tick.
 *
 * Extracted because it was written out six times inline and each copy could drift:
 * a field added to one would be missing from the others, and the grant would
 * appear not to work in the panel it was supposed to update.
 */
function sendStatus(ctx) {
    const { player, sendTo } = ctx;
    sendTo(player, {
        action: 'status',
        hp: player.hp, maxHp: player.maxHp,
        mana: player.mana, maxMana: player.maxMana,
        level: player.level, xp: player.xp, nextXp: player.nextXp,
        gold: player.gold,
        inventory: player.inventory,
        equipment: player.equipment,
        classType: player.classType,
        subclass: player.subclass,
        speedBonus: 0
    });
}

/**
 * Every action this module answers to. Kept as a set so the caller can check
 * membership cheaply and so adding an action here without adding a case is
 * visible in review.
 */
const TEST_ACTIONS = new Set([
    'attack_boss',
    'test_spawn_mob',
    'test_spawn_boss',
    'trigger_boss_aoe',
    'test_grant_xp',
    'test_grant_item',
    'test_grant_mana',
    'test_heal',
    'test_grant_gold'
]);

module.exports = { handleTestAction, sendStatus, TEST_ACTIONS };