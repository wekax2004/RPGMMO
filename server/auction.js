'use strict';

/**
 * Global auction house.
 *
 * ESCROW INVARIANT
 * ----------------
 * An item that has left a seller's inventory is never held only in memory. It
 * lives in that seller's persisted `auctionEscrow` array, and the in-memory
 * `listings` map is a *cache* of the live board that is rebuilt from escrow
 * whenever its owner logs in.
 *
 * The previous version kept listings and mailboxes in plain Maps, so a server
 * restart destroyed every listed item outright: gone from the inventory and
 * gone from the board. tests/auction_restart_probe.js proves that regression.
 *
 * Because a seller can be offline when their item sells, the module is given a
 * persistence adapter so it can load and save that character's row rather than
 * only mutating live objects.
 */

const CFG = require('./config');

let listingCounter = 0;

// Live board. A cache: authoritative state is each seller's persisted escrow.
const listings = new Map();

// Persistence adapter, supplied by init(). Needs loadPlayer/savePlayer.
let store = null;

// Fallback mailbox, used only before init() so the module can be unit tested
// standalone. Once a store is present, pendingMailbox is written to the
// seller's own persisted row instead.
const fallbackMailboxes = new Map();

function listingKey(charName) {
    return String(charName || '').trim().toLowerCase();
}

function makeListingId() {
    listingCounter += 1;
    return 'auc_' + Date.now().toString(36) + '_' + listingCounter.toString(36);
}

function isValidPrice(price) {
    return Number.isSafeInteger(price) && price >= CFG.AUCTION_MIN_PRICE && price <= CFG.AUCTION_MAX_PRICE;
}

function publicListing(listing) {
    return {
        id: listing.id,
        item: listing.item,
        price: listing.price,
        sellerName: listing.sellerName,
        listedAt: listing.listedAt,
        expiresAt: listing.expiresAt
    };
}

function listForClient() {
    return Array.from(listings.values()).map(publicListing);
}

// --- Escrow helpers -----------------------------------------------------

function escrowOf(player) {
    if (!Array.isArray(player.auctionEscrow)) player.auctionEscrow = [];
    return player.auctionEscrow;
}

function mailboxOf(player) {
    if (!player.pendingMailbox || typeof player.pendingMailbox !== 'object') {
        player.pendingMailbox = { gold: 0, items: [] };
    }
    if (!Array.isArray(player.pendingMailbox.items)) player.pendingMailbox.items = [];
    if (!Number.isSafeInteger(player.pendingMailbox.gold)) player.pendingMailbox.gold = 0;
    return player.pendingMailbox;
}

function findOnlinePlayer(players, charName) {
    if (!players || typeof players.values !== 'function') return null;
    const key = listingKey(charName);
    for (const player of players.values()) {
        if (player && typeof player.charName === 'string' && listingKey(player.charName) === key) {
            return player;
        }
    }
    return null;
}

/**
 * Puts everything a character is still owed into their live player object.
 * Called on login, which is where escrow becomes a visible board entry and
 * pendingMailbox becomes spendable gold.
 */
function rehydrate(player) {
    const escrow = escrowOf(player);
    const mailbox = mailboxOf(player);
    let restored = 0;

    for (const record of escrow) {
        if (!record || typeof record.item !== 'string') continue;
        // A record whose week already ran out is returned rather than listed.
        if (record.expiresAt <= Date.now()) {
            mailbox.items.push(record.item);
            continue;
        }
        const id = typeof record.id === 'string' && record.id ? record.id : makeListingId();
        record.id = id;
        if (!listings.has(id)) {
            listings.set(id, {
                id,
                item: record.item,
                price: record.price,
                sellerId: player.id,
                sellerName: player.charName,
                listedAt: record.listedAt || Date.now(),
                expiresAt: record.expiresAt
            });
            restored++;
        }
    }
    // Drop malformed records rather than carrying them forever.
    player.auctionEscrow = escrow.filter(r => r && typeof r.item === 'string' && typeof r.price === 'number');
    return restored;
}

// --- Listing ------------------------------------------------------------

function createListing(player, item, price) {
    if (typeof item !== 'string' || !item || item.length > 100) {
        return { success: false, message: 'Invalid item.' };
    }
    if (!isValidPrice(price)) {
        return {
            success: false,
            message: `Price must be a whole number between ${CFG.AUCTION_MIN_PRICE} and ${CFG.AUCTION_MAX_PRICE}.`
        };
    }
    if (!player || typeof player.charName !== 'string') {
        return { success: false, message: 'You are not signed in.' };
    }
    const selfKey = listingKey(player.charName);
    for (const listing of listings.values()) {
        if (listingKey(listing.sellerName) === selfKey) {
            return { success: false, message: 'You already have a listing on sale.' };
        }
    }
    const index = player.inventory.indexOf(item);
    if (index === -1) {
        return { success: false, message: 'You do not own that item.' };
    }
    if (listings.size >= CFG.AUCTION_MAX_LISTINGS) {
        return { success: false, message: 'The auction house is full. Try again later.' };
    }

    // Only after every check: take the item, then immediately move it into
    // persisted escrow so a restart cannot lose it.
    player.inventory.splice(index, 1);
    const now = Date.now();
    const id = makeListingId();
    const record = {
        id,
        item,
        price,
        listedAt: now,
        expiresAt: now + CFG.AUCTION_LISTING_TTL_MS
    };
    escrowOf(player).push(record);
    player.persistenceDirty = true;

    listings.set(id, {
        id,
        item,
        price,
        sellerId: player.id,
        sellerName: player.charName,
        listedAt: now,
        expiresAt: record.expiresAt
    });
    return { success: true, listing: publicListing(record) };
}

// --- Buying -------------------------------------------------------------

/**
 * Buys a listing. Deducts the buyer's gold, hands over the item, and pays the
 * seller. When the seller is offline their persisted row is loaded, paid, and
 * saved, so the money is never lost and never needs the seller online.
 */
async function buyListing(buyer, listingId, players) {
    if (typeof listingId !== 'string' || !listingId) {
        return { success: false, message: 'Invalid listing.' };
    }
    if (!buyer || typeof buyer.charName !== 'string') {
        return { success: false, message: 'You are not signed in.' };
    }
    const listing = listings.get(listingId);
    if (!listing) {
        return { success: false, message: 'That listing is no longer available.' };
    }
    if (listingKey(listing.sellerName) === listingKey(buyer.charName)) {
        return { success: false, message: 'You cannot buy your own listing.' };
    }
    if (listing.expiresAt <= Date.now()) {
        listings.delete(listingId);
        await returnToSeller(listing, players, 'expired');
        return { success: false, message: 'That listing has expired.' };
    }
    if (buyer.gold < listing.price) {
        return { success: false, message: 'You do not have enough gold.' };
    }

    // Commit: remove from the board first so a concurrent buy cannot also win.
    listings.delete(listingId);
    buyer.gold -= listing.price;
    buyer.inventory.push(listing.item);
    buyer.persistenceDirty = true;

    const fee = Math.floor(listing.price * CFG.AUCTION_FEE_PERCENT);
    const payout = listing.price - fee;
    const sellerPaid = await paySeller(listing, payout, players);

    return {
        success: true,
        item: listing.item,
        pricePaid: listing.price,
        sellerName: listing.sellerName,
        sellerPayout: payout,
        sellerFee: fee,
        sellerPaidOnline: sellerPaid.online,
        sellerOnline: sellerPaid.online
    };
}

// Removes the sold record from the seller's escrow and pays them.
async function paySeller(listing, payout, players) {
    const seller = findOnlinePlayer(players, listing.sellerName);
    if (seller) {
        const escrow = escrowOf(seller);
        const i = escrow.findIndex(r => r && r.id === listing.id);
        if (i !== -1) escrow.splice(i, 1);
        seller.gold += payout;
        seller.persistenceDirty = true;
        return { online: true };
    }
    // Offline: mutate the persisted row so the payout survives a restart.
    if (store && typeof store.loadPlayer === 'function') {
        try {
            const record = await store.loadPlayer(listing.sellerName);
            if (record) {
                const escrow = Array.isArray(record.auctionEscrow) ? record.auctionEscrow : [];
                record.auctionEscrow = escrow.filter(r => !r || r.id !== listing.id);
                const mailbox = (record.pendingMailbox && typeof record.pendingMailbox === 'object')
                    ? record.pendingMailbox
                    : { gold: 0, items: [] };
                if (!Array.isArray(mailbox.items)) mailbox.items = [];
                mailbox.gold = (Number.isSafeInteger(mailbox.gold) ? mailbox.gold : 0) + payout;
                record.pendingMailbox = mailbox;
                await store.savePlayer(listing.sellerName, record);
                return { online: false };
            }
        } catch (error) {
            // Never swallow a payout: fall back to the in-memory mailbox so the
            // money is at least recoverable this run, and say so loudly.
            console.error('[auction] failed to persist an offline payout:', error.message);
        }
    }
    addFallbackMailbox(listing.sellerName, { gold: payout, item: null });
    return { online: false };
}

// Returns an unsold/expired item to its owner, persisted if they are offline.
async function returnToSeller(listing, players, reason) {
    const seller = findOnlinePlayer(players, listing.sellerName);
    if (seller) {
        const escrow = escrowOf(seller);
        const i = escrow.findIndex(r => r && r.id === listing.id);
        if (i !== -1) {
            escrow.splice(i, 1);
            seller.inventory.push(listing.item);
        } else {
            seller.inventory.push(listing.item);
        }
        seller.persistenceDirty = true;
        return { delivered: 'inventory', reason };
    }
    if (store && typeof store.loadPlayer === 'function') {
        try {
            const record = await store.loadPlayer(listing.sellerName);
            if (record) {
                const escrow = Array.isArray(record.auctionEscrow) ? record.auctionEscrow : [];
                record.auctionEscrow = escrow.filter(r => !r || r.id !== listing.id);
                const mailbox = (record.pendingMailbox && typeof record.pendingMailbox === 'object')
                    ? record.pendingMailbox
                    : { gold: 0, items: [] };
                if (!Array.isArray(mailbox.items)) mailbox.items = [];
                mailbox.items.push(listing.item);
                record.pendingMailbox = mailbox;
                await store.savePlayer(listing.sellerName, record);
                return { delivered: 'mailbox', reason };
            }
        } catch (error) {
            console.error('[auction] failed to persist an offline return:', error.message);
        }
    }
    addFallbackMailbox(listing.sellerName, { gold: 0, item: listing.item });
    return { delivered: 'mailbox-fallback', reason };
}

// --- Expiry -------------------------------------------------------------

async function sweepExpired(now = Date.now(), players = null) {
    const expired = [];
    for (const [id, listing] of listings.entries()) {
        if (listing.expiresAt <= now) {
            expired.push(listing);
            listings.delete(id);
        }
    }
    for (const listing of expired) {
        await returnToSeller(listing, players, 'expired');
    }
    return expired;
}

// --- Mailbox ------------------------------------------------------------

function addFallbackMailbox(charName, entry) {
    const key = listingKey(charName);
    const box = fallbackMailboxes.get(key) || { gold: 0, items: [], listings: [] };
    if (entry.gold) box.gold += entry.gold;
    if (entry.item) box.items.push(entry.item);
    if (entry.listing) box.listings.push({ item: entry.listing.item, price: entry.listing.price });
    fallbackMailboxes.set(key, box);
}

// Owed amounts, for a client that wants to show a notification.
function mailboxPreview(player) {
    const key = listingKey(player && player.charName);
    const box = fallbackMailboxes.get(key);
    const persisted = (player && player.pendingMailbox) || { gold: 0, items: [] };
    const gold = (Number.isSafeInteger(persisted.gold) ? persisted.gold : 0) + (box ? box.gold : 0);
    const items = [
        ...(Array.isArray(persisted.items) ? persisted.items : []),
        ...(box ? box.items : [])
    ];
    if (gold <= 0 && items.length === 0) return null;
    return { gold, items, listingCount: escrowOf(player || {}).length };
}

// Moves everything owed into the player's live gold/inventory and clears it.
function claimMailbox(player) {
    const mailbox = mailboxOf(player);
    const key = listingKey(player.charName);
    const box = fallbackMailboxes.get(key);
    const gold = mailbox.gold + (box ? box.gold : 0);
    const items = [...mailbox.items, ...(box ? box.items : [])];
    player.pendingMailbox = { gold: 0, items: [] };
    fallbackMailboxes.delete(key);
    return { gold, items };
}

function init(persistence) {
    store = persistence || null;
}

function reset() {
    listings.clear();
    fallbackMailboxes.clear();
    listingCounter = 0;
}

module.exports = {
    listings,
    init,
    rehydrate,
    createListing,
    buyListing,
    listForClient,
    sweepExpired,
    claimMailbox,
    mailboxPreview,
    findOnlinePlayer,
    isValidPrice,
    reset
};
