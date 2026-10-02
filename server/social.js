/*
 * server/social.js
 *
 * Social packet handlers, extracted from the server.js monolith (roadmap 7.1, item 1).
 *
 * Handles: friend list (6.2), leaderboard (6.7), emotes (6.5), player inspection
 * (6.6) and the guild bank (6.3). Chat, whisper, party, trade and guild membership
 * stay inline for now -- they are separate extractions with their own invariants.
 *
 * WHY A CONTEXT OBJECT AND NOT IMPORTS
 *
 * These handlers need the same live references the rest of the packet path uses: the
 * player map, the guild table, the socket writers. Importing them would mean either
 * duplicating state or exporting mutable internals from server.js, which is worse
 * than passing a context -- server.js would stop being the thing that owns state and
 * become one of several places that can change it.
 *
 * The context is built once per packet and handed down, exactly as testing.js and
 * friends.js already do it. server.js remains the entry point and the only owner of
 * the sockets, the tick, and the live tables.
 *
 * WHAT MOVED AND WHAT IT COST
 *
 * Nothing, as of the extraction commit. tests/bots/social_probe.js drives all five
 * features over real sockets and records what actually comes back, before and after,
 * because the unit tests covering this area are source-level -- they assert that a
 * branch exists and calls the right thing, which is precisely the wrong shape for a
 * refactor. A refactor can satisfy every source-level assertion while changing what
 * the game does.
 */

const FRIENDS = require('./friends');

/** How many rows a leaderboard request asks for. */
const LEADERBOARD_LIMIT = 50;

/**
 * Every action this module answers to. Kept as a set so the caller can check
 * membership cheaply, and so adding an action here without adding a case is visible
 * in review.
 */
const SOCIAL_ACTIONS = new Set([
    'friend_list_request',
    'friend_add',
    'friend_remove',
    'leaderboard_request',
    'emote',
    'inspect_player',
    'guild_bank_deposit',
    'guild_bank_withdraw'
]);

/**
 * @param {object} ctx
 * @param {object} ctx.data        the inbound packet
 * @param {object} ctx.player      the sender
 * @param {Map} ctx.players        every connected player
 * @param {object} ctx.DB
 * @param {object} ctx.GUILDS
 * @param {(player, packet) => void} ctx.sendTo
 * @param {(player, message) => void} ctx.sendProtocolError
 * @param {(z, packet) => void} ctx.broadcastToFloor
 * @param {(player) => void} ctx.persistPlayer
 * @param {() => string[]} ctx.onlineCharacterNames
 * @returns {Promise<boolean>} resolves true if the action was a social action and has
 *   been handled. Async because resolving whether a character exists is a database
 *   read -- a friend who is logged off exists only in the database, so the add path
 *   cannot be synchronous.
 */
async function handleSocial(ctx) {
    switch (ctx.data.action) {
        // --- friend list (roadmap 6.2) --------------------------------------
        // All three actions handled together so the list is sent from one place: the
        // client's copy is correct after every mutation without it having to patch
        // itself.
        case 'friend_list_request':
        case 'friend_add':
        case 'friend_remove': {
            const { data, player } = ctx;
            if (data.action !== 'friend_list_request') {
                const isAdd = data.action === 'friend_add';
                let result;
                if (isAdd) {
                    /*
                     * Existence is resolved from the live player map first and the
                     * database second.
                     *
                     * Live map first because a connected character certainly exists,
                     * and the write queue means one who has just logged in may have no
                     * persisted row yet -- a database-only check refuses a friend who
                     * is standing right there. Database second because it is the only
                     * place an offline character can be found, and adding someone who
                     * is logged off is the normal case rather than an edge case.
                     */
                    const target = typeof data.name === 'string' ? data.name.trim() : '';
                    const legal = FRIENDS.isLegalName(target);
                    let exists = legal &&
                        ctx.onlineCharacterNames().some(n => n.toLowerCase() === target.toLowerCase());
                    if (legal && !exists) {
                        try {
                            exists = !!(await ctx.DB.loadPlayer(target));
                        } catch (e) {
                            // A database failure must not read as "no such character".
                            // Refusing looks like the name is wrong; accepting puts an
                            // unverified entry in the list. Refusing with the honest
                            // reason is the safer of the two and the player can retry.
                            exists = false;
                        }
                    }
                    result = FRIENDS.add(player.friends, data.name, {
                        selfName: player.charName,
                        exists
                    });
                } else {
                    result = FRIENDS.remove(player.friends, data.name);
                }

                if (result.ok) {
                    player.friends = result.list;
                    // Persisted immediately. A friend list that survives in memory but
                    // not across a restart is the kind of thing only noticed weeks
                    // later, by a player who has lost it.
                    ctx.persistPlayer(player);
                    ctx.sendTo(player, {
                        action: 'log',
                        message: isAdd
                            ? `Added ${data.name} to your friends.`
                            : `Removed ${data.name} from your friends.`
                    });
                } else {
                    // Every refusal has a sentence. "Nothing happened" for a list the
                    // player believes they just edited is worse than an error.
                    ctx.sendTo(player, {
                        action: 'log',
                        message: FRIENDS.MESSAGES[result.reason] || 'That did not work.'
                    });
                }
            }
            ctx.sendTo(player, {
                action: 'friends_list',
                friends: FRIENDS.describe(player.friends, ctx.onlineCharacterNames())
            });
            return true;
        }

        // --- leaderboard (roadmap 6.7) --------------------------------------
        case 'leaderboard_request': {
            const { data, player, DB } = ctx;
            DB.getLeaderboard(LEADERBOARD_LIMIT).then(leaderboard => {
                ctx.sendTo(player, { action: 'leaderboard_result', leaderboard });
            }).catch(err => {
                console.error("Leaderboard error:", err);
                ctx.sendTo(player, { action: 'log', message: 'Failed to fetch leaderboard.' });
            });
            void data;
            return true;
        }

        // --- emotes (roadmap 6.5) -------------------------------------------
        case 'emote': {
            const { data, player } = ctx;
            // Two characters, because the packet is a floating text over the head and
            // a full emoji set overflows the sprite box.
            const emoteText = typeof data.text === 'string' ? data.text.substring(0, 2) : '\u{1F4AC}';
            ctx.broadcastToFloor(player.z, {
                action: 'fct', x: player.x + 16, y: player.y - 32, text: emoteText, color: '#ffffff'
            });
            return true;
        }

        // --- player inspection (roadmap 6.6) ---------------------------------
        case 'inspect_player': {
            const { data, player, players } = ctx;
            const target = Array.from(players.values()).find(p => p.id === data.id);
            if (target) {
                ctx.sendTo(player, {
                    action: 'inspect_player_result',
                    player: {
                        // charName, not name. The live player object has no `name`
                        // field, so this was undefined and the inspection panel showed
                        // a blank -- tests/bots/social_probe.js caught it.
                        name: target.charName,
                        level: target.level || 1,
                        classType: target.classType,
                        equipment: target.equipment
                    }
                });
            }
            return true;
        }

        // --- guild bank (roadmap 6.3) ----------------------------------------
        case 'guild_bank_deposit':
        case 'guild_bank_withdraw': {
            const { data, player, GUILDS } = ctx;
            const amt = Number(data.amount);
            const isDeposit = data.action === 'guild_bank_deposit';

            if (isDeposit) {
                if (!amt || amt <= 0 || player.gold < amt) {
                    ctx.sendProtocolError(player, 'Not enough gold.');
                    return true;
                }
            } else if (!amt || amt <= 0) {
                return true;
            }

            /*
             * Membership lookup, against charName.
             *
             * This compared against player.name, which does not exist on the live
             * player object. `members.some(m => m === undefined)` is never true, so
             * every deposit and every withdrawal answered "You are not in a guild" --
             * from a player who had just created one and been sent its guild_sync.
             * The guild bank was unreachable in practice.
             *
             * Guilds store members as a Set of names, and promote/demote may hold
             * either a bare name or a { name, rank } object, so both shapes are
             * normalised here rather than assuming one.
             */
            const memberName = (m) => (typeof m === 'string' ? m : m && m.name);
            const guild = Array.from(GUILDS.guilds.values())
                .find(g => Array.from(g.members).some(m => memberName(m) === player.charName));
            if (!guild) {
                ctx.sendProtocolError(player, 'You are not in a guild.');
                return true;
            }

            if (isDeposit) {
                player.gold -= amt;
                guild.bank = (guild.bank || 0) + amt;
            } else {
                // Officers and the leader only. A plain member withdrawing from the
                // guild bank would let any member drain it.
                const member = Array.from(guild.members).find(m => memberName(m) === player.charName);
                const rank = typeof member === 'string' ? 'member' : (member.rank || 'member');
                if (guild.leader !== player.charName && rank !== 'officer') {
                    ctx.sendProtocolError(player, 'Only leaders and officers can withdraw gold.');
                    return true;
                }
                if ((guild.bank || 0) < amt) {
                    ctx.sendProtocolError(player, 'Not enough gold in guild bank.');
                    return true;
                }
                guild.bank -= amt;
                player.gold += amt;
            }

            // saveGuilds is optional rather than assumed: the guild table has grown a
            // save method, but a deployment without it should still balance the books
            // in memory instead of throwing on every deposit.
            if (typeof GUILDS.saveGuilds === 'function') GUILDS.saveGuilds();
            ctx.persistPlayer(player);
            ctx.sendTo(player, { action: 'inventory_sync', inventory: player.inventory, gold: player.gold });
            ctx.sendTo(player, { action: 'guild_sync', guild });
            ctx.sendTo(player, {
                action: 'log',
                message: isDeposit
                    ? `Deposited ${amt}G into the guild bank.`
                    : `Withdrew ${amt}G from the guild bank.`
            });
            return true;
        }

        default:
            return false;
    }
}

module.exports = { handleSocial, SOCIAL_ACTIONS, LEADERBOARD_LIMIT };
