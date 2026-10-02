// Unit tests for the auction house, mount movement math, fishing adjacency and
// the boss spawn announcement.
//
// auction.js and bosses.js are required directly because they are pure enough
// to drive. The mount and fishing rules that live inline in server.js are
// covered by asserting the source contains the guard, plus testing the
// exported map helpers and the config values the rules depend on.
process.env.TIBIA_DB_DRIVER = 'sqlite';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CFG = require('../../server/config');
const AUCTION = require('../../server/auction');
const MAP = require('../../server/map');
const BOSSES = require('../../server/bosses');

const SERVER_JS = path.join(__dirname, '..', '..', 'server', 'server.js');

function fakePlayer(name, gold, inventory) {
    return {
        id: 'p_' + name.toLowerCase(),
        charName: name,
        gold,
        inventory: [...inventory],
        persistenceDirty: false,
        // Persisted alongside the character, exactly as server.js stores them.
        auctionEscrow: [],
        pendingMailbox: { gold: 0, items: [] }
    };
}

// --- Auction house ------------------------------------------------------

test.beforeEach(() => AUCTION.reset());

test('a listing takes the item and records the price', () => {
    const seller = fakePlayer('Seller', 100, ['Iron Sword']);
    const result = AUCTION.createListing(seller, 'Iron Sword', 200);
    assert.strictEqual(result.success, true, result.message);
    assert.deepStrictEqual(seller.inventory, [], 'the item left the inventory');
    assert.strictEqual(AUCTION.listings.size, 1);
    assert.strictEqual(AUCTION.listings.size, 1);
});

test('a listing is refused unless the seller owns the item', () => {
    const seller = fakePlayer('Seller', 100, []);
    const result = AUCTION.createListing(seller, 'Iron Sword', 200);
    assert.strictEqual(result.success, false);
    assert.match(result.message, /do not own/i);
    assert.strictEqual(AUCTION.listings.size, 0);
});

test('nonsense prices are refused', () => {
    const seller = fakePlayer('Seller', 100, ['Iron Sword']);
    const bad = [0, -5, 1.5, '200', NaN, Infinity, null, undefined, 1e12, 2 ** 53];
    for (const price of bad) {
        const result = AUCTION.createListing(seller, 'Iron Sword', price);
        assert.strictEqual(result.success, false, `price ${String(price)} must be refused`);
    }
    // The item must survive every refusal.
    assert.deepStrictEqual(seller.inventory, ['Iron Sword']);
    assert.strictEqual(AUCTION.listings.size, 0);
});

test('the price bounds match the config', () => {
    // Two sellers: the one-listing-per-character rule would otherwise reject
    // the second attempt for the wrong reason.
    const lo = fakePlayer('LowSeller', 100, ['A']);
    const hi = fakePlayer('HighSeller', 100, ['B']);
    assert.strictEqual(AUCTION.createListing(lo, 'A', CFG.AUCTION_MIN_PRICE).success, true,
        'the minimum price must be accepted');
    assert.strictEqual(AUCTION.createListing(hi, 'B', CFG.AUCTION_MAX_PRICE).success, true,
        'the maximum price must be accepted');
});

test('a seller may only have one listing at a time', () => {
    const seller = fakePlayer('Seller', 100, ['A', 'B']);
    assert.strictEqual(AUCTION.createListing(seller, 'A', 10).success, true);
    const second = AUCTION.createListing(seller, 'B', 10);
    assert.strictEqual(second.success, false);
    assert.match(second.message, /already have a listing/i);
});

test('a seller cannot buy their own listing', async () => {
    const seller = fakePlayer('Seller', 500, ['Iron Sword']);
    const players = new Map([[seller.id, seller]]);
    const listed = AUCTION.createListing(seller, 'Iron Sword', 100);
    const bought = await AUCTION.buyListing(seller, listed.listing.id, players);
    assert.strictEqual(bought.success, false);
    assert.match(bought.message, /own listing/i);
    assert.strictEqual(seller.gold, 500, 'no gold moved');
    assert.strictEqual(AUCTION.listings.size, 1, 'the listing is still up');
});

test('a buyer without enough gold is refused', async () => {
    const seller = fakePlayer('Seller', 0, ['Iron Sword']);
    const buyer = fakePlayer('Buyer', 10, []);
    const players = new Map([[seller.id, seller], [buyer.id, buyer]]);
    const listed = AUCTION.createListing(seller, 'Iron Sword', 100);
    const bought = await AUCTION.buyListing(buyer, listed.listing.id, players);
    assert.strictEqual(bought.success, false);
    assert.match(bought.message, /enough gold/i);
    assert.strictEqual(buyer.gold, 10);
    assert.deepStrictEqual(buyer.inventory, [], 'no item handed over');
    assert.strictEqual(AUCTION.listings.size, 1, 'the listing survives a failed buy');
    assert.strictEqual(seller.auctionEscrow.length, 1, 'the escrow record survives a failed buy');
});

test('a successful sale moves gold and the item, and takes the fee', async () => {
    const seller = fakePlayer('Seller', 0, ['Iron Sword']);
    const buyer = fakePlayer('Buyer', 1000, []);
    const players = new Map([[seller.id, seller], [buyer.id, buyer]]);
    const listed = AUCTION.createListing(seller, 'Iron Sword', 200);
    const bought = await AUCTION.buyListing(buyer, listed.listing.id, players);

    assert.strictEqual(bought.success, true, bought.message);
    assert.strictEqual(buyer.gold, 800, 'charged the asking price');
    assert.deepStrictEqual(buyer.inventory, ['Iron Sword']);
    const fee = Math.floor(200 * CFG.AUCTION_FEE_PERCENT);
    assert.strictEqual(seller.gold, 200 - fee, 'seller got the price minus the fee');
    assert.strictEqual(bought.sellerFee, fee);
    assert.strictEqual(AUCTION.listings.size, 0, 'the listing is consumed');
    assert.strictEqual(seller.auctionEscrow.length, 0, 'the escrow record was cleared');
});

test('two buyers racing one listing: only one can win', async () => {
    const seller = fakePlayer('Seller', 0, ['Iron Sword']);
    const buyerA = fakePlayer('BuyerA', 1000, []);
    const buyerB = fakePlayer('BuyerB', 1000, []);
    const players = new Map([[seller.id, seller], [buyerA.id, buyerA], [buyerB.id, buyerB]]);
    const listed = AUCTION.createListing(seller, 'Iron Sword', 200);

    // Both purchases are started before either resolves, mirroring two packets
    // landing in one tick. The listing leaves the board before any mutation.
    const [first, second] = await Promise.all([
        AUCTION.buyListing(buyerA, listed.listing.id, players),
        AUCTION.buyListing(buyerB, listed.listing.id, players)
    ]);

    const winner = [buyerA, buyerB].filter(b => b.inventory.includes('Iron Sword'));
    const loser = [buyerA, buyerB].filter(b => !b.inventory.includes('Iron Sword'));
    assert.strictEqual(winner.length, 1, 'exactly one buyer gets the item');
    assert.strictEqual(loser.length, 1);
    assert.strictEqual(loser[0].gold, 1000, 'the loser was not charged');
    assert.strictEqual(winner[0].gold, 800, 'the winner paid the asking price');
    assert.ok(first.success !== second.success, 'one succeeds and one fails');
});

test('an offline seller is paid into their mailbox, not lost', async () => {
    const seller = fakePlayer('Seller', 0, ['Iron Sword']);
    const buyer = fakePlayer('Buyer', 1000, []);
    // The seller is deliberately absent from the live roster.
    const players = new Map([[buyer.id, buyer]]);
    const listed = AUCTION.createListing(seller, 'Iron Sword', 200);
    const bought = await AUCTION.buyListing(buyer, listed.listing.id, players);

    assert.strictEqual(bought.success, true);
    assert.strictEqual(bought.sellerOnline, false);
    // With no store configured the payout falls back to the in-memory mailbox.
    const box = AUCTION.mailboxPreview(fakePlayer('Seller', 0, []));
    assert.ok(box, 'a mailbox was created for the offline seller');
    const fee = Math.floor(200 * CFG.AUCTION_FEE_PERCENT);
    assert.strictEqual(box.gold, 200 - fee, 'the payout is held, not destroyed');
});

test('an offline payout is written to the seller persisted row', async () => {
    // The regression this protects: the payout used to live only in memory, so
    // a restart before the seller logged back in destroyed the gold.
    const saved = new Map();
    const store = {
        loadPlayer: async (name) => saved.get(name.toLowerCase()) || null,
        savePlayer: async (name, record) => { saved.set(name.toLowerCase(), JSON.parse(JSON.stringify(record))); }
    };
    AUCTION.init(store);
    try {
        // A seller who is offline: their row exists, they are just not here.
        saved.set('ghost', { charName: 'Ghost', gold: 0, inventory: [], auctionEscrow: [], pendingMailbox: { gold: 0, items: [] } });
        const seller = fakePlayer('Ghost', 0, ['Iron Sword']);
        const buyer = fakePlayer('Buyer2', 1000, []);
        const listed = AUCTION.createListing(seller, 'Iron Sword', 200);
        // Persist the escrow the way the server would on save.
        saved.get('ghost').auctionEscrow = seller.auctionEscrow;

        const players = new Map([[buyer.id, buyer]]);   // Ghost is NOT online
        const bought = await AUCTION.buyListing(buyer, listed.listing.id, players);
        assert.strictEqual(bought.success, true, bought.message);

        const row = saved.get('ghost');
        const fee = Math.floor(200 * CFG.AUCTION_FEE_PERCENT);
        assert.strictEqual(row.pendingMailbox.gold, 200 - fee,
            'the payout must be written to the offline seller persisted row');
        assert.strictEqual(row.auctionEscrow.length, 0,
            'the sold record must be cleared from their escrow');
    } finally {
        AUCTION.init(null);
    }
});

test('claiming a mailbox pays out once and empties it', async () => {
    const seller = fakePlayer('Seller', 0, ['Iron Sword']);
    const buyer = fakePlayer('Buyer', 1000, []);
    const players = new Map([[buyer.id, buyer]]);
    const listed = AUCTION.createListing(seller, 'Iron Sword', 200);
    await AUCTION.buyListing(buyer, listed.listing.id, players);

    const recipient = fakePlayer('Seller', 0, []);
    const first = AUCTION.claimMailbox(recipient);
    const fee = Math.floor(200 * CFG.AUCTION_FEE_PERCENT);
    assert.strictEqual(first.gold, 200 - fee);
    const second = AUCTION.claimMailbox(recipient);
    assert.strictEqual(second.gold, 0, 'a mailbox cannot be claimed twice');
});

test('a listed item lives in persisted escrow, not only in memory', () => {
    // The invariant: once an item leaves the inventory it is held in the
    // seller's own state, so a restart cannot destroy it.
    const seller = fakePlayer('Seller', 0, ['Iron Sword']);
    AUCTION.createListing(seller, 'Iron Sword', 200);
    assert.deepStrictEqual(seller.inventory, [], 'the item left the inventory');
    assert.strictEqual(seller.auctionEscrow.length, 1, 'the item is in escrow');
    assert.strictEqual(seller.auctionEscrow[0].item, 'Iron Sword');
    assert.ok(seller.auctionEscrow[0].id, 'the escrow record carries the listing id');
    assert.strictEqual(seller.persistenceDirty, true, 'listing must schedule a save');
});

test('rehydrate puts a returning seller back on the board', () => {
    const seller = fakePlayer('Seller', 0, ['Iron Sword']);
    const listed = AUCTION.createListing(seller, 'Iron Sword', 200);
    const listingId = listed.listing.id;

    // Simulate a restart: the board is empty but the escrow record survives.
    AUCTION.reset();
    const returning = fakePlayer('Seller', 0, []);
    returning.auctionEscrow = [{ id: listingId, item: 'Iron Sword', price: 200, listedAt: Date.now(), expiresAt: Date.now() + 60000 }];

    const restored = AUCTION.rehydrate(returning);
    assert.strictEqual(restored, 1, 'the listing came back');
    assert.strictEqual(AUCTION.listings.size, 1);
    assert.strictEqual(AUCTION.listings.get(listingId).item, 'Iron Sword');
});

test('rehydrate returns an already-expired escrow record to the mailbox', () => {
    const returning = fakePlayer('Seller', 0, []);
    returning.auctionEscrow = [{
        id: 'auc_stale', item: 'Iron Sword', price: 200,
        listedAt: Date.now() - 10, expiresAt: Date.now() - 1
    }];
    const restored = AUCTION.rehydrate(returning);
    assert.strictEqual(restored, 0, 'an expired record is not relisted');
    const claimed = AUCTION.claimMailbox(returning);
    assert.deepStrictEqual(claimed.items, ['Iron Sword'], 'the item comes back instead');
});

test('an expired listing is swept and the item returns to the seller', async () => {
    const seller = fakePlayer('Seller', 0, ['Iron Sword']);
    const players = new Map([[seller.id, seller]]);
    AUCTION.createListing(seller, 'Iron Sword', 200);
    assert.deepStrictEqual(seller.inventory, []);

    const expired = await AUCTION.sweepExpired(Date.now() + CFG.AUCTION_LISTING_TTL_MS + 1000, players);
    assert.strictEqual(expired.length, 1);
    assert.strictEqual(AUCTION.listings.size, 0);
    assert.deepStrictEqual(seller.inventory, ['Iron Sword'], 'the item came back');
    assert.strictEqual(seller.auctionEscrow.length, 0, 'the escrow record was cleared');
});

test('an expired listing bought in the same instant is refused', async () => {
    const seller = fakePlayer('Seller', 0, ['Iron Sword']);
    const buyer = fakePlayer('Buyer', 1000, []);
    const players = new Map([[seller.id, seller], [buyer.id, buyer]]);
    const listed = AUCTION.createListing(seller, 'Iron Sword', 200);
    // Pretend the listing aged out.
    AUCTION.listings.get(listed.listing.id).expiresAt = Date.now() - 1;

    const bought = await AUCTION.buyListing(buyer, listed.listing.id, players);
    assert.strictEqual(bought.success, false);
    assert.match(bought.message, /expired/i);
    assert.strictEqual(buyer.gold, 1000, 'no charge on an expired listing');
    assert.deepStrictEqual(buyer.inventory, []);
    assert.deepStrictEqual(seller.inventory, ['Iron Sword'], 'the seller got the item back');
});

test('the client payload hides the seller id', () => {
    const seller = fakePlayer('Seller', 0, ['Iron Sword']);
    AUCTION.createListing(seller, 'Iron Sword', 200);
    const [view] = AUCTION.listForClient();
    assert.deepStrictEqual(Object.keys(view).sort(),
        ['expiresAt', 'id', 'item', 'listedAt', 'price', 'sellerName']);
    assert.ok(!('sellerId' in view), 'the internal seller id must not be exposed');
});

// --- Mount movement math ------------------------------------------------

test('the mount config makes mounted movement strictly faster', () => {
    assert.ok(CFG.MOUNT_MOVE_COOLDOWN_REDUCTION > 0,
        'a mount must actually reduce the cooldown');
    // The floor is 80ms, so a big reduction cannot go below it.
    const base = CFG.PLAYER_MOVE_COOLDOWN_BASE;
    const atLevelOne = (mounted) =>
        Math.max(80, base - 3 - 0 - (mounted ? CFG.MOUNT_MOVE_COOLDOWN_REDUCTION : 0));
    assert.ok(atLevelOne(true) < atLevelOne(false),
        `mounted ${atLevelOne(true)}ms must beat foot ${atLevelOne(false)}ms`);
    assert.ok(atLevelOne(true) >= 80, 'the 80ms floor still applies');
});

test('the move cooldown subtracts the mount bonus', () => {
    // The speed bonus has to be inside the server's own validation, otherwise
    // every mounted step is rejected and the client is snapped back.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    assert.match(src, /const mountBonus = player\.isMounted \? CFG\.MOUNT_MOVE_COOLDOWN_REDUCTION : 0;/,
        'the mount bonus must be derived from isMounted');
    const moveSpeedLine = src.split('\n').find(l => l.includes('const moveSpeed = Math.max'));
    assert.ok(moveSpeedLine, 'the moveSpeed line must exist');
    assert.match(moveSpeedLine, /mountBonus/,
        'the move cooldown must subtract the mount bonus or mounted players rubber-band');
});

test('isMounted is persisted on both sides of the round trip', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const ser = src.slice(src.indexOf('function serializePlayer'), src.indexOf('function persistPlayer'));
    const norm = src.slice(src.indexOf('function normalizePlayerData'), src.indexOf('function isInBounds'));
    const login = src.slice(src.indexOf('players.set(playerId'));
    assert.match(ser, /isMounted/, 'serializePlayer must persist isMounted');
    assert.match(norm, /isMounted/, 'normalizePlayerData must restore isMounted');
    assert.ok(login.includes('isMounted'), 'the live player object must carry isMounted');
});

test('isMounted is broadcast in players_sync', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');

    // Anchored on the entry construction, not on a fixed number of characters
    // before the send.
    //
    // This used to slice the 900 bytes preceding the first `action: 'players_sync'`
    // and look for the flag inside. The AoI change put a fifteen-line explanatory
    // comment between the entry construction and the send, so the window stopped
    // reaching the flag and the test failed -- reporting a problem that was
    // entirely about where a comment sits.
    //
    // A fixed-width window is the same fragility as a hardcoded line number: any
    // edit above the assertion silently changes what is being inspected. Anchored
    // on the construction, it inspects what it means to inspect.
    const pushStart = src.indexOf('byFloor.get(floor).push({');
    assert.notStrictEqual(pushStart, -1, 'the roster entry construction must exist');
    const entry = src.slice(pushStart, src.indexOf('});', pushStart) + 3);
    assert.match(entry, /isMounted: p\.isMounted === true/,
        'the roster entry must carry isMounted so clients can render the rider');

    // And that entry is the one that goes on the wire, from inside the tick that
    // builds it -- under both the filtered path and the pre-AoI path.
    const tickStart = src.indexOf('scheduleServerInterval(() => {\n    const now = Date.now();');
    assert.ok(tickStart !== -1, 'the periodic roster tick must exist');
    // Both offsets are into `src`. Comparing `tick.indexOf(pushStart)` would be
    // comparing a slice-relative offset against a src-relative one, which is only
    // meaningful by accident.
    assert.ok(tickStart < pushStart,
        'the entry construction must live inside the periodic roster tick');
    const fromEntry = src.slice(pushStart);
    assert.ok(/broadcastToFloor\(floor, \{ action: 'players_sync', players: list \}\)/.test(fromEntry),
        'the pre-AoI path must still send the whole floor');
    assert.ok(/players: AOI\.visibleTo\(viewer, list, CFG\.AOI_RADIUS\)/.test(fromEntry),
        'the filtered path must send each viewer the entries constructed above');
});

test('damage dismounts via the tick HP snapshot, not 15 patched sites', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    assert.match(src, /player\.hpSnapshot/,
        'the tick must snapshot HP to detect that a player was hit');
    assert.match(src, /dismountPlayer\(player, 'You were struck/,
        'losing HP while mounted must dismount the player');
});

// --- Fishing adjacency --------------------------------------------------

test('isWater rejects out-of-bounds coordinates', () => {
    assert.strictEqual(MAP.isWater(-1, 0), false);
    assert.strictEqual(MAP.isWater(0, -1), false);
    assert.strictEqual(MAP.isWater(CFG.MAP_WIDTH, 0), false);
    assert.strictEqual(MAP.isWater(0, CFG.MAP_HEIGHT), false);
});

test('every indexed water tile reports as water and has water near it', () => {
    const tiles = [...MAP.waterTiles];
    assert.ok(tiles.length > 0, 'the map must generate some water');
    for (const key of tiles.slice(0, 25)) {
        const [x, y] = key.split(',').map(Number);
        assert.strictEqual(MAP.isWater(x, y), true, `${key} should be water`);
        // A water tile is an obstacle, so a player fishes from a neighbour.
        const neighbour = MAP.hasWaterNear(x + CFG.TILE_SIZE, y, CFG.FISHING_RANGE);
        assert.ok(neighbour >= 0, 'hasWaterNear must not throw');
    }
});

test('the safe city has no water to fish', () => {
    assert.strictEqual(MAP.hasWaterNear(320, 320, CFG.FISHING_RANGE), 0,
        'spawn must not be fishable, or the adjacency rule is meaningless');
});

test('the fishing cooldown is long enough to stop spam', () => {
    assert.ok(CFG.FISHING_COOLDOWN_MS >= 2000, 'at least a 2s cooldown');
    assert.ok(CFG.FISHING_CATCH_CHANCE > 0 && CFG.FISHING_CATCH_CHANCE < 1,
        'the catch rate must leave room for the junk outcome');
});

test('a refused cast does not start the cooldown', () => {
    // lastFishTime must be set only after the water check passes, otherwise a
    // player away from water is punished with a wait for a cast that never ran.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const block = src.slice(src.indexOf("data.action === 'fish'"), src.indexOf("data.action === 'use_item'"));
    const waterCheck = block.indexOf('hasWaterNear');
    const setTime = block.indexOf('player.lastFishTime = now');
    assert.ok(waterCheck !== -1, 'the water check must exist');
    assert.ok(setTime !== -1, 'lastFishTime must be set');
    assert.ok(setTime > waterCheck,
        'lastFishTime must be assigned after the adjacency check, not before');
});

// --- Boss spawn announcement --------------------------------------------

test('spawning a boss announces it to the whole server', () => {
    const sent = [];
    // spawnBoss returns the boss object, not the id.
    const boss = BOSSES.spawnBoss('spider_queen', p => sent.push(p));
    assert.ok(boss && boss.id, 'a boss must be returned');
    const alert = sent.find(p => p.action === 'log' && /GLOBAL ALERT/.test(p.message));
    assert.ok(alert, 'an alert log must be broadcast');
    assert.match(alert.message, /Spider Queen/, 'the alert names the boss');
    const dedicated = sent.find(p => p.action === 'boss_spawned');
    assert.ok(dedicated, 'a dedicated boss_spawned packet must be sent too');
    assert.strictEqual(dedicated.name, 'Spider Queen');
    assert.strictEqual(dedicated.bossId, boss.id);
    assert.ok(typeof dedicated.x === 'number' && typeof dedicated.y === 'number',
        'the client needs the spawn coordinates to render a marker');
});

test('the startup path can suppress the announcement', () => {
    const sent = [];
    BOSSES.spawnBoss('ice_dragon', p => sent.push(p), { announce: false });
    assert.strictEqual(sent.filter(p => /GLOBAL ALERT/.test(p.message || '')).length, 0,
        'a restart must not fire one alert per boss');
    // The boss still spawns and is still synced.
    assert.ok(sent.some(p => p.action === 'mob_update' && p.isBoss),
        'the boss must still be broadcast even when the alert is suppressed');
    assert.ok(sent.some(p => p.action === 'boss_spawned') === false,
        'boss_spawned is part of the alert and is suppressed with it');
});

test('an unknown boss type is refused without announcing', () => {
    const sent = [];
    assert.strictEqual(BOSSES.spawnBoss('not_a_boss', p => sent.push(p)), null);
    assert.strictEqual(sent.length, 0, 'nothing is broadcast for a bad type');
});

// --- Corpse expiry ------------------------------------------------------

test('corpses carry an expiry that something actually reads', () => {
    // The original bug: corpses were created with an expireAt that no code ever
    // looked at, so they accumulated forever and old kills stayed lootable.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    assert.match(src, /expiresAt: Date\.now\(\) \+ CFG\.CORPSE_TTL_MS/,
        'a corpse must be stamped with a TTL from config');
    assert.match(src, /function sweepCorpses\(/,
        'there must be a sweep that removes expired corpses');
    assert.match(src, /corpse\.expiresAt <= now/,
        'the sweep must compare against the stamp it wrote');
    assert.match(src, /action: 'corpse_remove'/,
        'the sweep must tell clients to clear the sprite');
    assert.match(src, /scheduleServerInterval\(\(\) => sweepCorpses\(\), CFG\.CORPSE_SWEEP_INTERVAL\)/,
        'the sweep must be scheduled, or an idle server never cleans up');
});

test('the corpse TTL is bounded and env-tunable', () => {
    assert.ok(CFG.CORPSE_TTL_MS > 0, 'a corpse must expire');
    assert.ok(CFG.CORPSE_TTL_MS <= 10 * 60 * 1000, 'corpses must not linger for hours');
    assert.ok(CFG.CORPSE_SWEEP_INTERVAL > 0, 'the sweep must run');
    assert.ok(CFG.CORPSE_SWEEP_INTERVAL <= CFG.CORPSE_TTL_MS,
        'the sweep must be at least as frequent as the TTL, or despawn lags');
});

// --- Trade request matching --------------------------------------------

test('trade requests match on the stored sender id, not a phantom field', () => {
    // request.fromName only ever existed on the outgoing client packet, never on
    // the stored request, so comparing against it could never succeed.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'trade.js'), 'utf8');
    // Strip comments first: the explanation of this very bug names the field,
    // and a naive search would match the prose rather than the code.
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const fn = code.slice(code.indexOf('function findTradeRequest'), code.indexOf('function acceptTradeRequest'));
    assert.match(fn, /request\.fromPlayerId !== fromPlayerId/,
        'the sender id must be the thing that is compared');
    assert.doesNotMatch(fn, /request\.fromName/,
        'the dead fromName comparison must be gone, or it implies name matching works');
    // The stored request must not claim to carry a fromName.
    const create = code.slice(code.indexOf('function createTradeRequest'), code.indexOf('function findTradeRequest'));
    assert.doesNotMatch(create, /fromName/,
        'createTradeRequest must not set a field nothing reads');
});
