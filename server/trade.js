const activeTrades = new Map();
const tradeRequests = new Map();
const TRADE_REQUEST_TTL_MS = 30_000;
const TRADE_MAX_DISTANCE = 96;

function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isValidGold(amount) {
    return Number.isSafeInteger(amount) && amount >= 0;
}

function isParticipant(trade, playerId) {
    return trade && (trade.player1Id === playerId || trade.player2Id === playerId);
}

function getTradeForPlayer(playerId) {
    for (const trade of activeTrades.values()) {
        if (isParticipant(trade, playerId)) return trade;
    }
    return null;
}

function getTradeIdForPlayer(playerId) {
    const trade = getTradeForPlayer(playerId);
    return trade ? trade.id : null;
}

function resetAcknowledgements(trade) {
    trade.confirmed1 = false;
    trade.confirmed2 = false;
}

function resetLocks(trade) {
    trade.locked1 = false;
    trade.locked2 = false;
}

function cleanupRequests(now = Date.now()) {
    for (const [id, request] of tradeRequests.entries()) {
        if (request.expiresAt <= now) tradeRequests.delete(id);
    }
}

function createTradeRequest(fromPlayerId, toPlayerId) {
    cleanupRequests();
    if (!fromPlayerId || !toPlayerId || fromPlayerId === toPlayerId) {
        return { success: false, message: 'A trade requires two different players.' };
    }
    if (getTradeForPlayer(fromPlayerId) || getTradeForPlayer(toPlayerId)) {
        return { success: false, message: 'One of the players is already trading.' };
    }

    for (const request of tradeRequests.values()) {
        if (request.fromPlayerId === fromPlayerId && request.toPlayerId === toPlayerId) {
            return { success: true, request, reused: true };
        }
    }

    const request = {
        id: makeId('trade_request'),
        fromPlayerId,
        toPlayerId,
        createdAt: Date.now(),
        expiresAt: Date.now() + TRADE_REQUEST_TTL_MS
    };
    tradeRequests.set(request.id, request);
    return { success: true, request };
}

function findTradeRequest(targetPlayerId, requestId = null, fromPlayerId = null) {
    cleanupRequests();
    for (const request of tradeRequests.values()) {
        if (request.toPlayerId !== targetPlayerId) continue;
        if (requestId && request.id !== requestId) continue;
        // Match on the stored sender id only. This used to also compare
        // request.fromName, but that field is only ever put on the outgoing
        // client packet, never on the stored request, so the clause could
        // never be true. The id is canonical anyway: character names can be
        // reused, ids cannot.
        if (fromPlayerId && request.fromPlayerId !== fromPlayerId) continue;
        return request;
    }
    return null;
}

function acceptTradeRequest(targetPlayerId, requestId = null, fromPlayerId = null) {
    const request = findTradeRequest(targetPlayerId, requestId, fromPlayerId);
    if (!request) return { success: false, message: 'No valid trade request.' };

    const tradeId = initiateTrade(request.fromPlayerId, targetPlayerId);
    if (!tradeId) return { success: false, message: 'Unable to start trade.' };
    tradeRequests.delete(request.id);
    return { success: true, tradeId, trade: activeTrades.get(tradeId), request };
}

function declineTradeRequest(targetPlayerId, requestId = null, fromPlayerId = null) {
    const request = findTradeRequest(targetPlayerId, requestId, fromPlayerId);
    if (!request) return false;
    tradeRequests.delete(request.id);
    return true;
}

/**
 * Creates an already-accepted trade. New code should normally use a request
 * and acceptTradeRequest first; this function remains available for internal
 * callers and tests.
 */
function initiateTrade(player1Id, player2Id) {
    if (!player1Id || !player2Id || player1Id === player2Id) return null;
    if (getTradeForPlayer(player1Id) || getTradeForPlayer(player2Id)) return null;

    const tradeId = makeId('trade');
    activeTrades.set(tradeId, {
        id: tradeId,
        player1Id,
        player2Id,
        offer1: [],
        offer2: [],
        gold1: 0,
        gold2: 0,
        confirmed1: false,
        confirmed2: false,
        locked1: false,
        locked2: false,
        createdAt: Date.now()
    });
    return tradeId;
}

function addItemToTrade(tradeId, playerId, itemName, players = null) {
    const trade = activeTrades.get(tradeId);
    if (!trade) return { success: false, message: 'Trade not found.' };
    if (typeof itemName !== 'string' || itemName.length === 0 || itemName.length > 100) {
        return { success: false, message: 'Invalid item.' };
    }
    if (!isParticipant(trade, playerId)) return { success: false, message: 'Player not in trade.' };

    const locked = playerId === trade.player1Id ? trade.locked1 : trade.locked2;
    if (locked) return { success: false, message: 'Unlock the trade before changing items.' };

    if (players) {
        const player = players.get(playerId);
        if (!player) return { success: false, message: 'Player not found.' };
        const offer = playerId === trade.player1Id ? trade.offer1 : trade.offer2;
        const available = player.inventory.filter(item => item === itemName).length;
        if (available < offer.filter(item => item === itemName).length + 1) {
            return { success: false, message: 'You do not own that item.' };
        }
    }

    const offer = playerId === trade.player1Id ? trade.offer1 : trade.offer2;
    offer.push(itemName);
    resetAcknowledgements(trade);
    resetLocks(trade);
    return { success: true };
}

function removeItemFromTrade(tradeId, playerId, itemName) {
    const trade = activeTrades.get(tradeId);
    if (!trade) return { success: false, message: 'Trade not found.' };
    if (!isParticipant(trade, playerId)) return { success: false, message: 'Player not in trade.' };

    const locked = playerId === trade.player1Id ? trade.locked1 : trade.locked2;
    if (locked) return { success: false, message: 'Unlock the trade before changing items.' };

    const offer = playerId === trade.player1Id ? trade.offer1 : trade.offer2;
    const index = offer.indexOf(itemName);
    if (index === -1) return { success: false, message: 'Item not in offer.' };

    offer.splice(index, 1);
    resetAcknowledgements(trade);
    resetLocks(trade);
    return { success: true };
}

function setTradeGold(tradeId, playerId, amount) {
    const trade = activeTrades.get(tradeId);
    if (!trade) return { success: false, message: 'Trade not found.' };
    if (!isParticipant(trade, playerId)) return { success: false, message: 'Player not in trade.' };
    if (!isValidGold(amount)) return { success: false, message: 'Gold must be a non-negative whole number.' };

    const locked = playerId === trade.player1Id ? trade.locked1 : trade.locked2;
    if (locked) return { success: false, message: 'Unlock the trade before changing gold.' };

    if (playerId === trade.player1Id) trade.gold1 = amount;
    else trade.gold2 = amount;

    resetAcknowledgements(trade);
    resetLocks(trade);
    return { success: true };
}

function stageTradeOffer(tradeId, playerId, items = [], gold, players = null) {
    const trade = activeTrades.get(tradeId);
    if (!trade) return { success: false, message: 'Trade not found.' };
    if (!isParticipant(trade, playerId)) return { success: false, message: 'Player not in trade.' };

    const locked = playerId === trade.player1Id ? trade.locked1 : trade.locked2;
    if (locked) return { success: false, message: 'Unlock the trade before changing the offer.' };
    if (!Array.isArray(items) || items.length > 100) {
        return { success: false, message: 'Invalid item offer.' };
    }
    if (gold !== undefined && !isValidGold(gold)) {
        return { success: false, message: 'Gold must be a non-negative whole number.' };
    }

    const currentOffer = playerId === trade.player1Id ? trade.offer1 : trade.offer2;
    const requestedCounts = new Map();
    for (const item of items) {
        if (typeof item !== 'string' || item.length === 0 || item.length > 100) {
            return { success: false, message: 'Invalid item.' };
        }
        requestedCounts.set(item, (requestedCounts.get(item) || 0) + 1);
    }

    if (players) {
        const player = players.get(playerId);
        if (!player) return { success: false, message: 'Player not found.' };
        const availableCounts = new Map();
        for (const item of player.inventory) {
            availableCounts.set(item, (availableCounts.get(item) || 0) + 1);
        }
        const currentCounts = new Map();
        for (const item of currentOffer) {
            currentCounts.set(item, (currentCounts.get(item) || 0) + 1);
        }
        for (const [item, requested] of requestedCounts.entries()) {
            if ((availableCounts.get(item) || 0) < (currentCounts.get(item) || 0) + requested) {
                return { success: false, message: 'You do not own all offered items.' };
            }
        }
    }

    // Commit only after every item and gold value has passed validation.
    currentOffer.push(...items);
    if (gold !== undefined) {
        if (playerId === trade.player1Id) trade.gold1 = gold;
        else trade.gold2 = gold;
    }
    resetAcknowledgements(trade);
    resetLocks(trade);
    return { success: true };
}

function lockTrade(tradeId, playerId) {
    const trade = activeTrades.get(tradeId);
    if (!trade) return { success: false, message: 'Trade not found.' };
    if (!isParticipant(trade, playerId)) return { success: false, message: 'Player not in trade.' };

    if (playerId === trade.player1Id) trade.locked1 = true;
    else trade.locked2 = true;
    resetAcknowledgements(trade);

    return {
        success: true,
        bothLocked: trade.locked1 && trade.locked2
    };
}

function confirmTrade(tradeId, playerId) {
    const trade = activeTrades.get(tradeId);
    if (!trade) return { success: false, message: 'Trade not found.' };
    if (!isParticipant(trade, playerId)) return { success: false, message: 'Player not in trade.' };
    if (!trade.locked1 || !trade.locked2) {
        return { success: false, message: 'Both players must lock the trade first.' };
    }

    if (playerId === trade.player1Id) trade.confirmed1 = true;
    else trade.confirmed2 = true;

    return {
        success: true,
        bothConfirmed: trade.confirmed1 && trade.confirmed2
    };
}

function cancelTrade(tradeId) {
    return activeTrades.delete(tradeId);
}

function cancelTradeRequestsForPlayer(playerId) {
    for (const [requestId, request] of tradeRequests.entries()) {
        if (request.fromPlayerId === playerId || request.toPlayerId === playerId) {
            tradeRequests.delete(requestId);
        }
    }
}

function cancelTradesForPlayer(playerId) {
    const cancelled = [];
    for (const [tradeId, trade] of activeTrades.entries()) {
        if (isParticipant(trade, playerId)) {
            activeTrades.delete(tradeId);
            cancelled.push(trade);
        }
    }
    return cancelled;
}

function getTradeSnapshot(trade, playerId) {
    if (!trade || !isParticipant(trade, playerId)) return null;
    const isPlayer1 = trade.player1Id === playerId;
    return {
        tradeId: trade.id,
        myOffer: isPlayer1 ? [...trade.offer1] : [...trade.offer2],
        theirOffer: isPlayer1 ? [...trade.offer2] : [...trade.offer1],
        myGold: isPlayer1 ? trade.gold1 : trade.gold2,
        theirGold: isPlayer1 ? trade.gold2 : trade.gold1,
        myLocked: isPlayer1 ? trade.locked1 : trade.locked2,
        theirLocked: isPlayer1 ? trade.locked2 : trade.locked1,
        myConfirmed: isPlayer1 ? trade.confirmed1 : trade.confirmed2,
        theirConfirmed: isPlayer1 ? trade.confirmed2 : trade.confirmed1,
        bothLocked: trade.locked1 && trade.locked2
    };
}

function executeTrade(tradeId, players) {
    const trade = activeTrades.get(tradeId);
    if (!trade) return { success: false, message: 'Trade not found.' };
    if (!trade.locked1 || !trade.locked2 || !trade.confirmed1 || !trade.confirmed2) {
        return { success: false, message: 'Both players must lock and confirm the trade.' };
    }

    const p1 = players.get(trade.player1Id);
    const p2 = players.get(trade.player2Id);
    if (!p1 || !p2) {
        cancelTrade(tradeId);
        return { success: false, message: 'One or both players are offline.' };
    }

    const distance = Math.abs(p1.x - p2.x) + Math.abs(p1.y - p2.y);
    if (distance > TRADE_MAX_DISTANCE) {
        return { success: false, message: 'Players are too far apart to trade.' };
    }

    if (!isValidGold(trade.gold1) || !isValidGold(trade.gold2) ||
        p1.gold < trade.gold1 || p2.gold < trade.gold2) {
        return { success: false, message: 'A player does not have enough gold.' };
    }

    const checkInventory = (player, offer) => {
        const remaining = [...player.inventory];
        for (const item of offer) {
            const index = remaining.indexOf(item);
            if (index === -1) return false;
            remaining.splice(index, 1);
        }
        return true;
    };

    if (!checkInventory(p1, trade.offer1) || !checkInventory(p2, trade.offer2)) {
        return { success: false, message: 'A player is missing an offered item.' };
    }

    // All validation is complete before mutating either player. Remove exact
    // staged counts, including duplicate item stacks, from each inventory.
    const p1Remaining = [...p1.inventory];
    for (const item of trade.offer1) {
        const index = p1Remaining.indexOf(item);
        if (index !== -1) p1Remaining.splice(index, 1);
    }
    p1.inventory.splice(0, p1.inventory.length, ...p1Remaining);

    const p2Remaining = [...p2.inventory];
    for (const item of trade.offer2) {
        const index = p2Remaining.indexOf(item);
        if (index !== -1) p2Remaining.splice(index, 1);
    }
    p2.inventory.splice(0, p2.inventory.length, ...p2Remaining);

    p1.gold -= trade.gold1;
    p2.gold -= trade.gold2;
    p2.inventory.push(...trade.offer1);
    p1.inventory.push(...trade.offer2);
    p2.gold += trade.gold1;
    p1.gold += trade.gold2;

    const player1Id = trade.player1Id;
    const player2Id = trade.player2Id;
    activeTrades.delete(tradeId);
    return { success: true, message: 'Trade successful.', player1Id, player2Id };
}

module.exports = {
    activeTrades,
    tradeRequests,
    TRADE_MAX_DISTANCE,
    getTradeForPlayer,
    getTradeIdForPlayer,
    createTradeRequest,
    findTradeRequest,
    acceptTradeRequest,
    declineTradeRequest,
    initiateTrade,
    addItemToTrade,
    removeItemFromTrade,
    setTradeGold,
    stageTradeOffer,
    lockTrade,
    confirmTrade,
    cancelTrade,
    cancelTradesForPlayer,
    cancelTradeRequestsForPlayer,
    getTradeSnapshot,
    executeTrade
};
