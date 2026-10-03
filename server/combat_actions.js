/*
 * server/combat_actions.js
 *
 * The combat verbs a client sends as packets, extracted from the server.js
 * monolith (roadmap 7.1 item 3).
 *
 * SCOPE, AND WHY IT IS THIS NARROW
 *
 * `combat.js` already owns the simulation -- `createCombat` returns
 * applyCombatModifiers, castSpell, runAutoAttack, killMob and the rest. What was
 * still inline here was the thin layer around it: the five packets that decide
 * whether a cast is *allowed* and *who it lands on*, and the corpse looting.
 *
 * So this file holds no damage arithmetic. That is the point. Every function below
 * is a gate: mana cost, class check, range check, target lookup. The gate is where
 * the interesting failures live, because a gate that returns the wrong thing
 * produces a plausible-looking cast that should not have happened.
 *
 * Two of these gates were worth reading closely, because both were doing real work
 * through a comparison that looks like a formality:
 *
 *   - `cast_heal` refuses a cross-floor target. `dist3D` returns Infinity across a
 *     floor boundary, so the single range comparison also stops a surface player
 *     healing someone standing in the dungeon at the same X/Y. That is a privacy
 *     and correctness property resting on one line, so it is commented where it
 *     lives rather than left to be rediscovered.
 *   - `cast_heal` and `cast_purify` both return silently when the player cannot pay
 *     the cost. That is deliberate: the client already knows its own mana and the
 *     fct it would get is noise. `tests/bots/combat_actions_probe.js` asserts the
 *     silence rather than a message, because a check that passed on a message would
 *     be asserting the opposite of the intended design.
 *
 * Context is passed in, not imported, for the reason given in social.js: these
 * handlers need the same live references the rest of the packet path uses, and
 * importing them would mean exporting mutable internals from server.js.
 */

/**
 * @param {object} ctx
 * @returns {boolean} true if the action was a combat verb and has been handled.
 *   Every case returns rather than falling through, so an action this module
 *   claims cannot continue on to a later branch matching the same string.
 */
function handleCombatActions(ctx) {
    const {
        data, player, players, corpses,
        COMBAT, CFG, MAP,
        sendTo, sendProtocolError, broadcastToFloor, dist3D
    } = ctx;

    switch (data.action) {
        // Selecting a target is not an attack. The actual swing is driven by the
        // server tick, so this only records the intent -- a client that sends
        // `attack` for a mob that has since left the area of interest, or walked a
        // floor down, selects nothing and swings at whatever the tick finds.
        case 'attack': {
            player.targetId = data.target_id;
            return true;
        }

        // --- healer ---------------------------------------------------------
        case 'cast_heal': {
            // Both refusals are silent. A healer with 24 mana is not an error
            // condition; the client shows the cost before the cast, and a log
            // line would spam the chat of someone holding down the key.
            if (player.classType !== 'healer' || player.mana < 25) return true;
            let target = player;
            if (data.targetPlayerId) {
                target = players.get(data.targetPlayerId);
                // Cross-floor healing is not a thing. dist3D returns Infinity across
                // a floor boundary, so this one comparison also stops a player on
                // the surface healing someone in the dungeon at the same X/Y.
                if (!target || dist3D(player.x, player.y, player.z, target.x, target.y, target.z) > 192) {
                    sendProtocolError(player, 'Heal target is out of range.');
                    return true;
                }
            }
            player.mana -= 25;
            const healAmt = COMBAT.applyCombatModifiers(player, 40 + player.level * 2, 'heal');
            target.hp = Math.min(target.maxHp, target.hp + healAmt);
            // Broadcast to the *target's* floor, not the caster's. Healing someone
            // in the dungeon while standing in the surface dungeon would otherwise
            // float the number where nobody is standing.
            broadcastToFloor(target.z, { action: 'fct', x: target.x + 16, y: target.y, text: `+${healAmt} HP`, color: '#44ff44' });
            return true;
        }

        case 'cast_purify': {
            if (player.mana >= CFG.PURIFY_MANA_COST) {
                player.mana -= CFG.PURIFY_MANA_COST;
                player.poisonStacks = 0;
                player.bleedStacks = 0;
                broadcastToFloor(player.z, { action: 'fct', x: player.x + 16, y: player.y, text: 'PURIFIED', color: '#4488ff' });
            }
            // Silent when the player cannot pay, for the same reason as cast_heal.
            return true;
        }

        // All of the spell logic lives in combat.js already; this only routes to
        // it so the client-facing action name does not have to be its parameter.
        case 'cast_spell': {
            COMBAT.castSpell(player, data.spellIndex);
            return true;
        }

        // --- looting --------------------------------------------------------
        case 'interact_corpse': {
            const c = corpses.get(data.id);
            // Range-checked here rather than trusting the client. A packet is cheap
            // to forge, and without this a player loots any corpse on the map by id.
            if (c && dist3D(player.x, player.y, player.z, c.x, c.y, c.z) <= 64) {
                if (c.gold > 0) {
                    player.gold += c.gold;
                    sendTo(player, { action: 'log', message: `Looted ${c.gold} gold from ${c.ownerName}'s corpse!` });
                    sendTo(player, { action: 'fct', x: player.x, y: player.y, text: `+${c.gold} Gold`, color: '#ffd700' });
                    // Zero the gold before removing the corpse. If the remove is
                    // what fails, a corpse with 0 gold cannot be looted twice.
                    c.gold = 0;
                    broadcastToFloor(MAP.normalizeZ(c.z), { action: 'corpse_remove', id: data.id });
                    corpses.delete(data.id);
                }
            }
            return true;
        }

        default:
            return false;
    }
}

/**
 * Every action this module claims. A set so the caller can skip building a
 * context for the overwhelming majority of packets, and so an action added to one
 * place but not the other is visible in review.
 */
const COMBAT_ACTION_NAMES = new Set([
    'attack',
    'cast_heal',
    'cast_purify',
    'cast_spell',
    'interact_corpse'
]);

module.exports = { handleCombatActions, COMBAT_ACTION_NAMES };