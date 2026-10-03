/*
 * server/grouping.js
 *
 * Party and trade packet handlers, extracted from the server.js monolith
 * (roadmap 7.1 item 2).
 *
 * Both features are "two players agree to do something, then a stream of packets
 * moves that agreement forward". They share a shape -- find the other player,
 * delegate the state change to a module that owns it, then broadcast the result --
 * which is why they live together. Neither owns its state: `party.js` and
 * `trade.js` hold that, and this file is only the wire format between a client's
 * action name and those modules' calls.
 *
 * Why this pair and not trade alone: the packet shapes cross-reference each other.
 * `trade_accept` has to find the requester by the same name-resolution dance as
 * `party_invite`, and the compatibility packets (`party_invited` and
 * `party_invite` both, `trade_requested` with three spellings of the id field)
 * exist for the same reason in both. Splitting them across two modules would put
 * that reasoning in one and its twin in the other.
 *
 * Context is passed in, not imported, for the reason given in social.js: these
 * handlers need the same live references the rest of the packet path uses, and
 * importing them would mean exporting mutable internals from server.js.
 */

/**
 * @param {object} ctx
 * @returns {boolean} true if the action belonged to party or trade and has been
 *   handled. Every case returns rather than falling through, because the caller
 *   needs to know the action was claimed -- an unhandled action must not be able
 *   to reach a later branch that happens to match the same string.
 */
function handleGrouping(ctx) {
    const {
        data, player, playerId, players,
        PARTY, TRADE, TRADE_MAX_DISTANCE,
        sendTo, sendProtocolError,
        findPlayerByName, dist3D,
        sendPartySync, syncTrade, sendTradeSyncAll,
        recalcPlayerStats, sendPlayerStatus
    } = ctx;

    switch (data.action) {
        // --- party ---------------------------------------------------------------
        case 'party_create': {
            // Creating twice returns the existing party rather than an error. A
            // double-click on the button is the normal way this arrives, and
            // refusing it would leave the player in a party they cannot see.
            const existingParty = PARTY.getParty(playerId);
            const pid = existingParty ? existingParty.id : PARTY.createParty(playerId);
            sendTo(player, { action: 'log', message: `🎉 Party created! ID: ${pid}` });
            sendPartySync(PARTY.getParty(playerId));
            return true;
        }

        case 'party_invite': {
            const targetPlayer = findPlayerByName(data.targetName || data.targetPlayer);
            if (!targetPlayer) {
                sendProtocolError(player, 'Player not found.');
                return true;
            }
            const party = PARTY.getParty(playerId);
            if (!party) {
                sendProtocolError(player, 'Create a party first.');
                return true;
            }
            const result = PARTY.inviteToParty(party.id, playerId, targetPlayer.id, players);
            if (!result.success) {
                sendProtocolError(player, result.message);
                return true;
            }
            // Sent twice under two action names. The client was written against
            // `party_invite`; the bots and the newer UI listen for `party_invited`.
            // Both carry the same fields, so a client reading either sees the same
            // invite. Removing one breaks whichever client that one belongs to, and
            // nothing fails loudly when it does -- the invite just never appears.
            const invitePacket = {
                action: 'party_invited',
                inviter: player.charName,
                from: player.charName,
                fromPlayer: player.id,
                partyId: party.id
            };
            sendTo(targetPlayer, invitePacket);
            sendTo(targetPlayer, { ...invitePacket, action: 'party_invite' });
            sendTo(player, { action: 'log', message: `📨 Invited ${targetPlayer.charName} to party.` });
            return true;
        }

        case 'party_accept': {
            const result = PARTY.acceptInvite(playerId, data.partyId, players);
            if (!result.success) {
                sendProtocolError(player, result.message);
                return true;
            }
            result.party.members.forEach(memberId => {
                const member = players.get(memberId);
                if (member) sendTo(member, { action: 'log', message: `🎉 ${player.charName} joined the party!` });
            });
            sendPartySync(result.party);
            return true;
        }

        case 'party_decline': {
            PARTY.declineInvite(playerId, data.partyId);
            return true;
        }

        case 'party_leave': {
            const result = PARTY.leaveParty(playerId);
            if (result.success) {
                sendPartySync(result.party);
                // Sent after the sync on purpose. The sync carries the party the
                // player is now in -- null, having just left -- and sending the
                // empty roster first would be undone by the sync that followed.
                sendTo(player, { action: 'party_sync', id: null, leader: null, members: [], party: null });
                sendTo(player, { action: 'log', message: '👋 You left the party.' });
            }
            return true;
        }

        // --- trade ---------------------------------------------------------------
        case 'trade_request': {
            const targetPlayer = findPlayerByName(data.targetName || data.targetPlayer);
            if (!targetPlayer) {
                sendProtocolError(player, 'Player not found.');
                return true;
            }
            if (dist3D(player.x, player.y, player.z, targetPlayer.x, targetPlayer.y, targetPlayer.z) > TRADE_MAX_DISTANCE) {
                sendProtocolError(player, 'Too far to trade.');
                return true;
            }
            const result = TRADE.createTradeRequest(playerId, targetPlayer.id);
            if (!result.success) {
                sendProtocolError(player, result.message);
                return true;
            }
            // Three field names for one id. `trade_requested` is the current name;
            // `tradeRequestId` and `fromName` are what the older client and the bots
            // read. Same reason as the party duplicate above.
            const requestPacket = {
                action: 'trade_requested',
                requestId: result.request.id,
                tradeRequestId: result.request.id,
                from: player.charName,
                fromPlayer: player.id,
                fromName: player.charName
            };
            sendTo(targetPlayer, requestPacket);
            sendTo(player, { action: 'log', message: `📨 Trade request sent to ${targetPlayer.charName}.` });
            return true;
        }

        case 'trade_accept': {
            // Accepting by name is the fallback, not the primary path. A client
            // that has lost the id (reconnected, stale UI) can still accept by
            // naming the other party, and a trade the player cannot complete is
            // worse than one they accepted slightly late.
            const fromReference = data.fromPlayer || data.from || data.fromName;
            const fromPlayer = findPlayerByName(fromReference) || (players.has(fromReference) ? players.get(fromReference) : null);
            const result = TRADE.acceptTradeRequest(
                playerId,
                data.requestId || data.tradeRequestId,
                fromPlayer ? fromPlayer.id : fromReference
            );
            if (!result.success) {
                sendProtocolError(player, result.message);
                return true;
            }
            const requester = players.get(result.trade.player1Id);
            const target = players.get(result.trade.player2Id);
            // Re-checked here, not just at request time. Between the request and
            // the accept either player may have walked away, and opening a trade
            // window across the map would let a client stage items it cannot reach.
            if (!requester || !target || dist3D(requester.x, requester.y, requester.z, target.x, target.y, target.z) > TRADE_MAX_DISTANCE) {
                TRADE.cancelTrade(result.tradeId);
                sendProtocolError(player, 'Players are too far apart to trade.');
                return true;
            }
            sendTo(requester, { action: 'trade_open', tradeId: result.tradeId, partnerName: target.charName });
            sendTo(target, { action: 'trade_open', tradeId: result.tradeId, partnerName: requester.charName });
            syncTrade(result.tradeId, 'trade_update');
            return true;
        }

        case 'trade_decline': {
            const fromReference = data.fromPlayer || data.from;
            const fromPlayer = findPlayerByName(fromReference) || (players.has(fromReference) ? players.get(fromReference) : null);
            TRADE.declineTradeRequest(playerId, data.requestId, fromPlayer ? fromPlayer.id : fromReference);
            return true;
        }

        // One case for two action names. `trade_offer` replaces the window in a
        // single packet -- the whole staged state at once -- which is what a
        // reconnecting client or a bulk "offer everything" button needs.
        case 'trade_add_item':
        case 'trade_offer': {
            const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
            const trade = TRADE.activeTrades.get(tradeId);
            if (!trade) {
                sendProtocolError(player, 'Trade not found.');
                return true;
            }
            const isBulk = data.action === 'trade_offer';
            const items = isBulk
                ? (Array.isArray(data.items) ? data.items : [])
                : (data.item ? [data.item] : []);
            const gold = isBulk ? data.gold : undefined;
            const result = TRADE.stageTradeOffer(tradeId, playerId, items, gold, players);
            if (!result.success) {
                sendProtocolError(player, result.message);
                return true;
            }
            syncTrade(tradeId, 'trade_update');
            return true;
        }

        case 'trade_remove_item': {
            const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
            const result = TRADE.removeItemFromTrade(tradeId, playerId, data.item);
            if (!result.success) sendProtocolError(player, result.message);
            else syncTrade(tradeId, 'trade_update');
            return true;
        }

        case 'trade_set_gold': {
            const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
            const result = TRADE.setTradeGold(tradeId, playerId, data.amount);
            if (!result.success) sendProtocolError(player, result.message);
            else syncTrade(tradeId, 'trade_update');
            return true;
        }

        case 'trade_lock': {
            const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
            const result = TRADE.lockTrade(tradeId, playerId);
            if (!result.success) {
                sendProtocolError(player, result.message);
                return true;
            }
            syncTrade(tradeId, 'trade_update');
            // `trade_locked` only once both sides have locked. Sending it on the
            // first lock would tell the other player the deal is sealed when their
            // own offer is still editable.
            if (result.bothLocked) sendTradeSyncAll(TRADE.activeTrades.get(tradeId), 'trade_locked');
            return true;
        }

        case 'trade_confirm': {
            const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
            // Read before confirming. `confirmTrade` mutates the trade, and after it
            // returns there is no longer a reliable way to ask "was this the second
            // confirmation?" -- so the answer has to be captured while it is still
            // true.
            const tradeBeforeExecution = TRADE.activeTrades.get(tradeId);
            const result = TRADE.confirmTrade(tradeId, playerId);
            if (!result.success) {
                sendProtocolError(player, result.message);
                return true;
            }
            if (!result.bothConfirmed || !tradeBeforeExecution) {
                syncTrade(tradeId, 'trade_update');
                return true;
            }
            const execResult = TRADE.executeTrade(tradeId, players);
            if (!execResult.success) {
                // Both parties are told, not just the one who pressed confirm. One of
                // them is about to have their inventory moved and needs to know it
                // did not happen.
                [tradeBeforeExecution.player1Id, tradeBeforeExecution.player2Id].forEach(id => {
                    const participant = players.get(id);
                    if (participant) sendProtocolError(participant, execResult.message);
                });
                return true;
            }
            [execResult.player1Id, execResult.player2Id].forEach(id => {
                const participant = players.get(id);
                if (participant) {
                    sendTo(participant, { action: 'trade_complete', tradeId });
                    sendTo(participant, { action: 'log', message: '✅ Trade completed!' });
                    sendTo(participant, { action: 'trade_close' });
                    // Both, in this order: stats first, because the status packet
                    // carries the numbers recalcPlayerStats just produced. Sending
                    // the status first would show the pre-trade equipment.
                    recalcPlayerStats(participant);
                    sendPlayerStatus(participant);
                }
            });
            return true;
        }

        case 'trade_cancel': {
            const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
            const trade = TRADE.activeTrades.get(tradeId);
            if (trade && (trade.player1Id === playerId || trade.player2Id === playerId)) {
                [trade.player1Id, trade.player2Id].forEach(id => {
                    const participant = players.get(id);
                    if (participant) sendTo(participant, { action: 'trade_close', tradeId });
                });
                TRADE.cancelTrade(tradeId);
                return true;
            }
            // A trade that exists but is not this player's. Refusing is the point:
            // `getTradeIdForPlayer` is a fallback, so a client sending a bare
            // `trade_cancel` with no id could otherwise close somebody else's deal.
            if (trade) sendProtocolError(player, 'You are not a participant in this trade.');
            return true;
        }

        default:
            return false;
    }
}

/**
 * Every action this module claims. A set rather than a switch-with-a-default so
 * the caller can decide cheaply whether to build a context at all, and so an
 * action added to one place but not the other is visible in review.
 */
const GROUPING_ACTIONS = new Set([
    'party_create', 'party_invite', 'party_accept', 'party_decline', 'party_leave',
    'trade_request', 'trade_accept', 'trade_decline',
    'trade_add_item', 'trade_offer', 'trade_remove_item', 'trade_set_gold',
    'trade_lock', 'trade_confirm', 'trade_cancel'
]);

module.exports = { handleGrouping, GROUPING_ACTIONS };