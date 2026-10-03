const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const CFG = require('./config');
const { isWalkable, obstacleData, isWater, hasWaterNear } = require('./map');
const MAP = require('./map');
const { mobs, spawnMobPack, spawnFloorPack, spawnMobAt, moveMobToward, mobAttack, inSafeZone, countMobsOn, KNOWN_MOB_TYPES } = require('./mobs');
const { chests, spawnChest } = require('./chests');
const { npcs } = require('./npcs');
const corpses = new Map();
let corpseIdCounter = 1;
const Q = require('./quests');
const CRAFTING = require('./crafting');
const ITEMS = require('./items');
const DB = require('./db_firebase');
const AUTH = require('./auth');

process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

// Per-IP login throttle. This exists to blunt the scrypt CPU cost of a
// brute-force run, not to ration logins: several legitimate players can share
// one address (a school, a NAT'd household, a load test), so the window has
// to be generous enough for a real burst. The previous 5-per-10s locked out
// the 50-bot load test, where every bot shares 127.0.0.1.
const LOGIN_LIMIT_MAX = Number(process.env.TIBIA_LOGIN_MAX) > 0
    ? Number(process.env.TIBIA_LOGIN_MAX)
    : 30;
const LOGIN_LIMIT_WINDOW_MS = Number(process.env.TIBIA_LOGIN_WINDOW_MS) > 0
    ? Number(process.env.TIBIA_LOGIN_WINDOW_MS)
    : 60_000;
const authAttempts = new Map();
function authLimiter(ip) {
    if (!ip) return false;
    // A test harness legitimately bursts; the throttle is an abuse control,
    // not a correctness gate, so do not let it fail a load test.
    if (TEST_MODE) return false;
    const now = Date.now();
    const entry = authAttempts.get(ip) || { count: 0, windowStart: now };
    if (now - entry.windowStart >= LOGIN_LIMIT_WINDOW_MS) { entry.count = 0; entry.windowStart = now; }
    entry.count++;
    authAttempts.set(ip, entry);
    return entry.count > LOGIN_LIMIT_MAX;
}
// Bounded so a long-lived server cannot accumulate an entry per source IP.
function sweepAuthAttempts() {
    const cutoff = Date.now() - LOGIN_LIMIT_WINDOW_MS;
    for (const [ip, entry] of authAttempts.entries()) {
        if (entry.windowStart < cutoff) authAttempts.delete(ip);
    }
}
const RATELIMIT = require('./ratelimit');
const TESTING = require('./testing');
const AOI = require('./aoi');
const WHISPER = require('./whisper');
const FRIENDS = require('./friends');
const SOCIAL = require('./social');
const GROUPING = require('./grouping');
const COMBAT_ACTIONS = require('./combat_actions');
const INVENTORY = require('./inventory');

// Per-class packet budgets. One limiter per class, each keying on player id, so
// one client spending its whole budget cannot cost anyone else theirs.
//
// Env overrides exist so a load test or a busy shard can be tuned without a code
// change: TIBIA_RATECHAT_BURST, TIBIA_RATECHAT_REFILL_MS, and so on. The comment
// in config.js claims they exist, so they do.
function budgetFromEnv(name, fallback) {
    const burst = Number(process.env[`TIBIA_RATE${name.toUpperCase()}_BURST`]);
    const refill = Number(process.env[`TIBIA_RATE${name.toUpperCase()}_REFILL_MS`]);
    return {
        burst: Number.isFinite(burst) && burst > 0 ? burst : fallback.burst,
        refillMs: Number.isFinite(refill) && refill > 0 ? refill : fallback.refillMs
    };
}
const rateLimiters = {};
for (const [cls, budget] of Object.entries(CFG.RATE_LIMITS)) {
    rateLimiters[cls] = RATELIMIT.createLimiter(budgetFromEnv(cls, budget));
}

// Bounded so a long-lived server cannot accumulate a bucket per player per class
// forever. Called on the same cadence as the auth sweep.
function sweepRateLimits() {
    const at = Date.now();
    for (const limiter of Object.values(rateLimiters)) {
        limiter.sweep(at);
        limiter.enforceCeiling(at);
    }
}

const { bosses, spawnBoss, bossAI, triggerBossAoe, BOSS_TYPES } = require('./bosses');
const PARTY = require('./party');
const GUILDS = require('./guilds');
const AUCTION = require('./auction');

// The auction pays sellers who may be logged out, so it needs to be able to
// read and write a character's row directly. This is what stops a sale from
// destroying gold when the seller is offline.
AUCTION.init({
    loadPlayer: (charName) => DB.loadPlayer(charName),
    savePlayer: (charName, record) => DB.savePlayer(charName, record)
});
const TRADE = require('./trade');
const SC = require('./subclasses');
const OLLAMA = require('./ollama');
const { createCombat } = require('./combat');
const SKILLS = require('./skills');
const TEST_MODE = process.env.TIBIA_TEST_MODE === 'true';

const SHOP_INVENTORY = {
    'Health Potion': { price: 20 },
    'Mana Potion': { price: 30 },
    'Iron Sword': { price: 150 },
    'Leather Tunic': { price: 100 },
    'Leather Helmet': { price: 60 },
    'Leather Boots': { price: 80 },
    'Leather Legs': { price: 90 }
};

// Serves a file from one whitelisted client subdirectory. The decoded path is
// resolved and then confirmed to stay inside root, so a crafted ../ (in any
// encoding) cannot escape. Directories and non-files are rejected.
const STATIC_MIME_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'
};

function serveClientFile(res, securityHeaders, url, urlPrefix, root) {
    let requested;
    try {
        const urlWithoutQuery = url.split('?')[0];
        requested = path.resolve(root, '.' + decodeURIComponent(urlWithoutQuery.slice(urlPrefix.length)));
    } catch (error) {
        // Malformed percent-encoding. Must not throw: this runs inside the
        // unguarded http request listener.
        res.writeHead(400, securityHeaders);
        res.end('Bad Request');
        return;
    }
    const relative = path.relative(root, requested);
    const escapes = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
    if (escapes) {
        res.writeHead(404, securityHeaders);
        res.end();
        return;
    }
    let stats;
    try {
        stats = fs.statSync(requested);
    } catch (error) {
        res.writeHead(404, securityHeaders);
        res.end();
        return;
    }
    if (!stats.isFile()) {
        res.writeHead(404, securityHeaders);
        res.end();
        return;
    }
    const contentType = STATIC_MIME_TYPES[path.extname(requested).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { ...securityHeaders, 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(requested));
}

const server = http.createServer((req, res) => {
    const securityHeaders = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    };
    if (req.url === '/metrics') {
        const memory = process.memoryUsage();
        res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            players: players.size,
            uptimeSec: Math.round(process.uptime())
        }));
    } else if (req.url === '/health') {
        res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, service: 'tibia-mmo' }));
    } else if (req.url === '/') {
        const clientPath = path.join(__dirname, '../client/test_client.html');
        if (fs.existsSync(clientPath)) {
            res.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(fs.readFileSync(clientPath));
        } else {
            res.writeHead(404, securityHeaders);
            res.end('Client file not found.');
        }
    } else if (req.url === '/favicon.ico') {
        res.writeHead(204, securityHeaders); res.end();
    } else if (req.url.startsWith('/assets/')) {
        serveClientFile(res, securityHeaders, req.url, '/assets', path.resolve(__dirname, '../client/assets'));
    } else if (req.url.startsWith('/css/')) {
        serveClientFile(res, securityHeaders, req.url, '/css', path.resolve(__dirname, '../client/css'));
    } else if (req.url.startsWith('/js/')) {
        serveClientFile(res, securityHeaders, req.url, '/js', path.resolve(__dirname, '../client/js'));
    } else {
        res.writeHead(404, securityHeaders); res.end();
    }
});
const wss = new WebSocket.Server({ server, maxPayload: 16 * 1024 });
const players = new Map();
const loggingInCharacters = new Set();
const loginReservationTimers = new Map();
const serverIntervals = new Set();
const AGGRO_RANGE = 400;

function scheduleServerInterval(callback, delay) {
    const handle = setInterval(callback, delay);
    serverIntervals.add(handle);
    return handle;
} 

// Reap the per-IP login counters so the map cannot grow without bound.
scheduleServerInterval(() => sweepAuthAttempts(), 60_000);
    scheduleServerInterval(() => sweepRateLimits(), 60_000);

let isDay = true;
scheduleServerInterval(() => {
    isDay = !isDay;    broadcast({ action: 'log', message: isDay ? '☀️ The sun rises...' : '🌙 Night falls. Monsters are stronger and drop more loot!' });
    broadcast({ action: 'time_sync', isDay });
}, 60000); 

const MAX_SOCKET_BUFFER_BYTES = 1024 * 1024;

// Sends to every connected player. Pass no second argument.
function broadcast(dataObj) {
    const msg = JSON.stringify(dataObj);
    players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN && p.ws.bufferedAmount <= MAX_SOCKET_BUFFER_BYTES) {
            p.ws.send(msg);
        }
    });
}

// Floor-scoped counterpart to broadcast(). A separate function rather than an
// optional second parameter on broadcast(): there are 107 broadcast() call
// sites, and threading a filter argument through all of them invites a call
// that passes a player object or a packet where a floor index was expected --
// which fails as a filter nobody notices, not as a type error. A distinct name
// puts the scope at the call site and leaves all 107 callers byte-identical.
//
// Both sides are normalised. A player whose stored z is missing or corrupt --
// any save written before Stage 0 -- counts as being on the surface, so an
// unnormalised compare would drop that player from every floor-scoped packet
// and they would silently stop seeing the world.
function broadcastToFloor(z, dataObj) {
    const floor = MAP.normalizeZ(z);
    const msg = JSON.stringify(dataObj);
    players.forEach(p => {
        if (MAP.normalizeZ(p.z) !== floor) return;
        if (p.ws.readyState === WebSocket.OPEN && p.ws.bufferedAmount <= MAX_SOCKET_BUFFER_BYTES) {
            p.ws.send(msg);
        }
    });
}
// Everything a client needs to draw one floor: the terrain, and every entity
// standing on it. Used by login and again by every traversal, so a client that
// descends and one that connects both end up in the same state.
//
// map_data comes FIRST and carries the floor index. The client compares it to
// its current z and, on a change, drops its otherPlayers / mobs / corpses /
// ground items before applying the new terrain. Sending the roster before
// map_data would let it populate those caches with the old floor's contents
// and then never clear them.
function syncFloorRoster(player) {
    const pz = MAP.normalizeZ(player.z);
    const floorTerrain = MAP.getFloorTerrain(pz) || { z: CFG.Z_SURFACE, obstacleData: [] };
    sendTo(player, {
        action: 'map_data', z: floorTerrain.z,
        obstacles: floorTerrain.obstacleData, transitions: floorTerrain.transitions || [],
        bounds: floorTerrain.bounds || null,
        width: CFG.MAP_WIDTH, height: CFG.MAP_HEIGHT, safeZone: CFG.SAFE_ZONE
    });

    // Mobs, filtered to the radius this player can actually see.
    //
    // The viewer's own x/y is used rather than the tile being described, because
    // what matters is whether the player can see it. With MOB_AOI_RADIUS at 0 both
    // loops send the whole floor exactly as they always have, so this is inert
    // until the feature is switched on.
    const mobR = CFG.MOB_AOI_RADIUS;
    const canSeeMob = (m) => mobR <= 0 || (Math.abs(m.x - player.x) <= mobR && Math.abs(m.y - player.y) <= mobR);

    // Written as a positive `=== pz` condition rather than `!== pz` with an early
    // return, because that is the shape tests/unit/zlevels.test.js:363 pins when it
    // reads back the guard in front of each mob_update. The filter is on the same
    // line as the floor test, which keeps the two conditions together and readable
    // -- a reader can see at a glance that "on my floor" and "in my view" are one
    // question, not two.
    const visibleMobs = [];
    mobs.forEach((mob, id) => {
        if (MAP.normalizeZ(mob.z) === pz && canSeeMob(mob)) {
            visibleMobs.push(id);
            sendTo(player, { action: 'mob_update', id, type: mob.type, name: mob.name, x: mob.x, y: mob.y, z: pz, hp: mob.hp, maxHp: mob.maxHp, alive: true, isElite: mob.isElite });
        }
    });
    // Bosses are deliberately not filtered. There are three types with one lair each,
    // so filtering them saves nothing measurable, and bosses.js broadcasts through
    // an injected callback that would have to be threaded through a filter for no
    // gain. A boss you cannot see is also the thing a player most wants warning
    // about.
    bosses.forEach((boss, id) => { if (MAP.normalizeZ(boss.z) === pz) sendTo(player, { action: 'mob_update', id, type: boss.type, name: boss.name, x: boss.x, y: boss.y, z: pz, hp: boss.hp, maxHp: boss.maxHp, alive: true, isElite: false, isBoss: true, phase: boss.phase }); });
    chests.forEach((c, id) => { if (MAP.normalizeZ(c.z) === pz) sendTo(player, { action: 'chest_update', id, x: c.x, y: c.y, z: pz, active: true }); });
    corpses.forEach((c, id) => { if (MAP.normalizeZ(c.z) === pz) sendTo(player, { action: 'corpse_spawn', corpse: c }); });
    Q.gatheringNodes.forEach((node, id) => {
        if (node.active && MAP.normalizeZ(node.z) === pz) {
            sendTo(player, { action: 'node_sync', id, name: node.name, x: node.x, y: node.y, z: pz, color: node.color, symbol: node.symbol });
        }
    });
    // A client must learn about anything already on the ground, not only about
    // future drops. Filtered to this floor, so a drop on another level is not
    // drawn on this one.
    sendTo(player, { action: 'ground_sync', items: groundItemPayload(pz) });
    // Seed the reconciliation set with whatever was just sent, so the periodic mob
    // membership check does not immediately re-send it as "entered".
    mobAoiSets.set(player.id, new Set(visibleMobs));
    syncNpcs(player);
    // The skill panel is not floor-scoped -- a character's skills travel with
    // them -- but it is sent here so a player who descends does not come back
    // up to a blank panel. Dropping this call during the extraction of the
    // roster into this function is what tests/skills_live_verify.js caught.
    sendSkillPanel(player);
}

// Moves a player between floors. Called only from the movement handler, after
// a step onto a traversal tile has been accepted.
//
// The order matters. Leaving before arriving means the old floor drops the
// player from its ownPlayers cache immediately, rather than holding a ghost at
// the ladder's coordinates until the next players_sync tick -- which on a
// surface player looking at the ladder would be a body standing on a hole.
function performTraversal(player, transition) {
    const fromZ = MAP.normalizeZ(player.z);
    const toZ = MAP.normalizeZ(transition.to);
    if (fromZ === toZ) return false;

    // Trade requires both players on one floor. Descending mid-trade would
    // otherwise let the offer sit open across a floor boundary, where the two
    // sides are in separate rosters and cannot see or reach each other.
    abortSeparatedTrade(player.id);

    // Drop out of the old floor's view.
    broadcastToFloor(fromZ, { action: 'player_left', id: player.id });

    player.z = toZ;

    // The stated arrival point is preferred; the ring search is a safety net
    // for a floor whose generator happened to wall in the landing tile. Without
    // it a player could be sealed inside geometry with no way back up, which is
    // unrecoverable without an admin.
    const wanted = transition.arrive || { x: player.x, y: player.y };
    const landing = MAP.findArrivalPoint(toZ, wanted.x, wanted.y);
    if (landing) { player.x = landing.x; player.y = landing.y; }

    // Position first, then the floor's contents. The client trusts these.
    sendTo(player, { action: 'force_position', x: player.x, y: player.y, z: toZ });
    syncFloorRoster(player);

    // Announce to the new floor, and to the new floor only.
    broadcastToFloor(toZ, {
        action: 'player_update', id: player.id, name: player.charName,
        x: player.x, y: player.y, z: toZ, classType: player.classType,
        equipment: player.equipment, guild: player.guild || null,
        skulled: hasActiveSkull(player), isMounted: player.isMounted === true
    });

    sendTo(player, {
        action: 'log',
        message: toZ < fromZ
            ? `⛏️ You descend to level ${toZ}.`
            : `🪜 You climb back to the surface.`
    });
    return true;
}

// Scoped alias for spawnMobPack, which only ever places surface mobs. Passed as
// a plain function so the mob respawn in combat.js cannot announce a surface
// creature to everyone standing in a dungeon.
function broadcastSurface(dataObj) {
    broadcastToFloor(CFG.Z_SURFACE, dataObj);
}

function sendTo(player, dataObj) {
    if (player && player.ws && player.ws.readyState === WebSocket.OPEN && player.ws.bufferedAmount <= MAX_SOCKET_BUFFER_BYTES) {
        player.ws.send(JSON.stringify(dataObj));
    }
}
function findPlayerByName(name) {
    if (typeof name !== 'string') return null;
    const normalized = name.trim().toLowerCase();
    if (!normalized) return null;
    for (const player of players.values()) {
        if (player.charName.toLowerCase() === normalized) return player;
    }
    return null;
}
GUILDS.init({ broadcast, sendTo, getPlayerByName: findPlayerByName });
function sendPartySync(party) {
    const snapshot = PARTY.getPartySnapshot(party, players);
    const packet = { action: 'party_sync', ...snapshot, party: snapshot };
    if (party) {
        party.members.forEach(memberId => {
            const member = players.get(memberId);
            if (member) {
                sendTo(member, packet);
                // Keep the original browser packet action alive during the
                // protocol migration.
                sendTo(member, { action: 'party_update', ...snapshot, party: snapshot });
            }
        });
    }
}
function sendTradeSync(trade, playerId, action) {
    const snapshot = TRADE.getTradeSnapshot(trade, playerId);
    if (!snapshot) return;
    sendTo(players.get(playerId), { action, tradeId: snapshot.tradeId, ...snapshot, trade: snapshot });
}
function sendTradeSyncAll(trade, action) {
    if (!trade) return;
    [trade.player1Id, trade.player2Id].forEach(playerId => sendTradeSync(trade, playerId, action));
}
function sendProtocolError(player, message) {
    sendTo(player, { action: 'log', message: `❌ ${message}` });
}
function abortSeparatedTrade(playerId) {
    const trade = TRADE.getTradeForPlayer(playerId);
    if (!trade) return false;
    const p1 = players.get(trade.player1Id);
    const p2 = players.get(trade.player2Id);
    // Trade requires one shared floor, not just proximity. dist3D is Infinity
    // across a boundary, so descending mid-trade tears it down exactly like
    // walking out of range does -- which is the intent, since the two sides are
    // no longer in the same room and cannot see each other.
    const separated = !p1 || !p2 ||
        dist3D(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z) > TRADE.TRADE_MAX_DISTANCE;
    if (!separated) return false;
    [trade.player1Id, trade.player2Id].forEach(id => {
        const participant = players.get(id);
        if (participant) sendTo(participant, { action: 'trade_close', tradeId: trade.id });
    });
    TRADE.cancelTrade(trade.id);
    return true;
}
// Sends the full skill panel. Called on login so the HUD is populated
// before the player does anything.
function sendSkillPanel(player) {
    sendTo(player, { action: 'skill_update', skills: SKILLS.skillSummary(player.skills) });
}

function syncNpcs(player) {
    npcs.forEach((npc, id) => {
        let hasQuest = false;
        if (npc.quests_offered && Array.isArray(npc.quests_offered)) {
            hasQuest = npc.quests_offered.some(qId => Q.canAcceptQuest(player.quests, qId, id));
        }
        sendTo(player, { action: 'npc_sync', id, name: npc.name, x: npc.x, y: npc.y, hasQuest });
    });
    // The workbench is a static interactable, synced like an NPC
    sendTo(player, { action: 'npc_sync', id: CRAFTING.WORKBENCH.id, name: CRAFTING.WORKBENCH.name, x: CRAFTING.WORKBENCH.x, y: CRAFTING.WORKBENCH.y, hasQuest: false });
}

// Awards skill XP and, when that levels a skill, tells the client. Returns
// the descriptor so callers can add their own flavour of notification.
function awardSkill(player, skillId, amount) {
    const result = SKILLS.grantSkillXp(player.skills, skillId, amount);
    if (!result) return null;
    sendTo(player, { action: 'skill_update', skill: result });
    if (result.leveled) {
        sendTo(player, {
            action: 'log',
            message: `⭐ ${result.name} is now level ${result.level}!`
        });
        broadcastToFloor(player.z, { action: 'fct', x: player.x + 16,
            y: player.y - 24,
            text: `${result.name} ${result.level}`,
            color: '#fbbf24'
        });
    }
    return result;
}

function serializePlayer(p) {
    return {
        level: p.level,
        xp: p.xp,
        nextXp: p.nextXp,
        gold: p.gold,
        inventory: [...p.inventory],
        classType: p.classType,
        subclass: p.subclass,
        x: p.x,
        y: p.y,
        z: MAP.normalizeZ(p.z),
        guild: p.guild || null,
        // Friend list (roadmap 6.2). Sanitised on the way out as well as on the way
        // in, because serializePlayer is the only thing standing between a malformed
        // live field and a save file.
        friends: FRIENDS.sanitize(p.friends),
        // Auction escrow and unpaid proceeds travel with the character, so a
        // restart can never destroy a listed item or an offline payout.
        auctionEscrow: Array.isArray(p.auctionEscrow)
            ? p.auctionEscrow
                .filter(r => r && typeof r.item === 'string' && Number.isSafeInteger(r.price))
                .map(r => ({
                    id: typeof r.id === 'string' ? r.id : null,
                    item: r.item,
                    price: r.price,
                    listedAt: safePersistInt(r.listedAt, Date.now()),
                    expiresAt: safePersistInt(r.expiresAt, Date.now() + CFG.AUCTION_LISTING_TTL_MS)
                }))
            : [],
        pendingMailbox: (p.pendingMailbox && typeof p.pendingMailbox === 'object')
            ? {
                gold: safePersistInt(p.pendingMailbox.gold, 0, 0),
                items: Array.isArray(p.pendingMailbox.items)
                    ? p.pendingMailbox.items.filter(i => typeof i === 'string').slice(0, 200)
                    : []
            }
            : { gold: 0, items: [] },
        // Persisted so a skull survives a reconnect. hasActiveSkull still
        // applies the timer, so an expired flag comes back as inactive.
        skull: normalizeSkull(p.skull),
        isMounted: p.isMounted === true,
        skullExpiresAt: Number.isSafeInteger(p.skullExpiresAt) && p.skullExpiresAt > 0 ? p.skullExpiresAt : 0,
        quests: p.quests,
        craftedRecipes: Array.isArray(p.craftedRecipes) ? [...p.craftedRecipes] : [],
        skills: SKILLS.normalizeSkills(p.skills),
        bankGold: Number.isSafeInteger(p.bankGold) ? p.bankGold : 0,
        bankItems: Array.isArray(p.bankItems) ? [...p.bankItems] : [],
        equipment: { ...p.equipment },
        maxHp: p.maxHp,
        maxMana: p.maxMana
    };
}
function persistPlayer(p) {
    p.persistenceDirty = true;
    // serializePlayer returns a fresh object, and the persistence layer
    // snapshots it again before writing, so a save can never observe the live
    // player mutating mid-write.
    return DB.savePlayer(p.charName, serializePlayer(p))
        .then(() => { p.persistenceDirty = false; })
        .catch(error => {
            console.error(`[persistence] Failed to save ${p.charName}:`, error.message);
        });
}
// Combat lives in ./combat and gets its world state and side-effect
// callbacks from here, so the dependency stays one-way. isDay is passed as
// a getter because it flips on a timer.
const COMBAT = createCombat({
    players,
    mobs,
    isDay: () => isDay,
    dist,
    dist3D,
    inSafeZone,
    broadcast,
    // Floor-scoped broadcast, used for every floating combat text. combat.js
    // has no scope of its own for this, so omitting it here made every damage
    // and XP number throw on the first hit.
    broadcastToFloor,
    sendTo,
    addXp,
    checkPlayerDeath,
    sendQuestJournal,
    spawnMobPack: (size) => spawnMobPack(broadcastSurface, size),
    persistPlayer,
    awardSkill,
    grantWhiteSkull,
    hasActiveSkull,
    sendPlayerStatus,
    sendProtocolError
});

function sendPlayerStatus(player) {
    let speedBonus = 0;
    if (player.equipment.boots && ITEMS.boots[player.equipment.boots]) {
        speedBonus = ITEMS.boots[player.equipment.boots].speedBonus || 0;
    }
    const party = PARTY.getParty(player.id);
    sendTo(player, {
        action: 'status',
        hp: player.hp,
        maxHp: player.maxHp,
        mana: player.mana,
        maxMana: player.maxMana,
        level: player.level,
        xp: player.xp,
        nextXp: player.nextXp,
        poison: player.poisonStacks,
        bleed: player.bleedStacks,
        stun: player.stunUntil > Date.now(),
        gold: player.gold,
        inventory: player.inventory,
        equipment: player.equipment,
        classType: player.classType,
        subclass: player.subclass,
        speedBonus,
        partyId: party ? party.id : null
    });
}
// --- Mounts --------------------------------------------------------------
// A mount is a movement stance. The server is the only authority on it: the
// client asks to toggle, the server decides, and everyone is told.
function mountPlayer(player) {
    if (player.isMounted) return false;
    player.isMounted = true;
    player.persistenceDirty = true;
    return true;
}

function dismountPlayer(player, reason) {
    if (!player.isMounted) return false;
    player.isMounted = false;
    player.persistenceDirty = true;
    if (reason) sendTo(player, { action: 'log', message: `🐴 ${reason}` });
    // Tell everyone the stance changed, and push the new speed to the
    // mounted player so the client can animate it immediately.
    broadcast({
        action: 'mount_changed',
        id: player.id,
        isMounted: false
    });
    sendTo(player, { action: 'status', isMounted: false });
    return true;
}

// --- Ground loot ---------------------------------------------------------
// Items a player sets down on the map. The drop position is always the
// server's own player.x/player.y, never a client-supplied coordinate, so a
// modified client cannot place loot anywhere on the map.
const groundItems = new Map();
let groundItemCounter = 1;

// Trimmed payload for the client. ownerId is deliberately omitted so the
// wire format cannot be used to enumerate who dropped what.
// Full snapshot of the ground loot on one floor, or on every floor when no
// floor is given. ground_sync replaces the client's whole set, so the client
// never has to reconcile a delta against a list it may have missed.
function groundItemPayload(z) {
    const scoped = z === undefined;
    const floor = MAP.normalizeZ(z);
    const out = [];
    for (const g of groundItems.values()) {
        const gz = MAP.normalizeZ(g.z);
        if (!scoped && gz !== floor) continue;
        out.push({ id: g.id, name: g.name, x: g.x, y: g.y, z: gz });
    }
    return out;
}

// Republishes the ground loot, one packet per occupied floor.
//
// Sent globally it handed every client the whole world's loot, so a drop in the
// dungeon was drawn on the surface at coordinates that mean nothing there. The
// floors are derived from the items themselves, so a floor that currently holds
// nothing simply gets no packet -- its clients already hold the correct empty
// list from their last sync, and ground_sync is a full snapshot, not a delta.
// Floors that have ever held ground loot, so a floor that has just been
// emptied still gets a sync.
//
// Deriving the set from the items alone is wrong in the one case that matters
// most: pick up the last item on a floor and nothing is left, so that floor
// drops out of the set and no packet is sent at all -- and because ground_sync
// is a full snapshot rather than a delta, a client that is not told keeps
// drawing the item that no longer exists. The set only grows, and there are at
// most a handful of floors, so the cost is a few empty payloads.
const groundSyncFloors = new Set([CFG.Z_SURFACE]);

// Republishes the ground loot, one packet per floor that has ever held any.
//
// Sent globally it handed every client the whole world's loot, so a drop in the
// dungeon was drawn on the surface at coordinates that mean nothing there.
function broadcastGroundSync() {
    for (const g of groundItems.values()) groundSyncFloors.add(MAP.normalizeZ(g.z));
    for (const floor of groundSyncFloors) {
        broadcastToFloor(floor, { action: 'ground_sync', items: groundItemPayload(floor) });
    }
}

// Despawns expired drops and enforces the hard cap, so neither a slow client
// nor a drop_item spam can grow the Map without bound.
function sweepGroundItems() {
    const now = Date.now();
    let changed = false;
    for (const [id, g] of groundItems.entries()) {
        if (g.expiresAt <= now) {
            groundItems.delete(id);
            changed = true;
        }
    }
    // Oldest-first eviction via Map insertion order.
    while (groundItems.size > CFG.GROUND_MAX_ITEMS) {
        const oldest = groundItems.keys().next().value;
        if (oldest === undefined) break;
        groundItems.delete(oldest);
        changed = true;
    }
    if (changed) broadcastGroundSync();
}

// Resolves the target of a pickup: an explicit id, or the nearest drop within
// reach when the client only sent coordinates. Returns null when nothing
// qualifies; the caller reports the refusal.
function resolveGroundTarget(player, data) {
    if (typeof data.itemId === 'string' && data.itemId) {
        return groundItems.get(data.itemId) || null;
    }
    if (!Number.isInteger(data.x) || !Number.isInteger(data.y)) return null;
    let best = null;
    let bestDist = Infinity;
    for (const g of groundItems.values()) {
        const d = dist3D(player.x, player.y, player.z, g.x, g.y, g.z);
        // The coordinate the client named must actually be the drop's tile,
        // otherwise a client could sweep every nearby item by guessing.
        if (g.x !== data.x || g.y !== data.y) continue;
        if (d <= CFG.GROUND_PICKUP_RANGE && d < bestDist) {
            best = g;
            bestDist = d;
        }
    }
    return best;
}

// --- Skull system (PvP) -------------------------------------------------
// A white skull marks a player who has attacked someone who was not already
// flagged. While skulled they drop a larger share of their gold on death,
// which is the incentive to stay out of PvP. The flag decays on a timer so
// a single mistake is not permanent.
const SKULL_WHITE = 'white';
const SKULL_DURATION_MS = Number(process.env.TIBIA_SKULL_MS) > 0
    ? Number(process.env.TIBIA_SKULL_MS)
    : 5 * 60 * 1000;
// Fraction of a player's gold left on the corpse. checkPlayerDeath already
// dropped a flat 0.5 for everyone; a skull makes it worse, it never makes it
// better, so this must stay >= NORMAL_DROP_RATIO.
const SKULL_DROP_RATIO = 1;
const NORMAL_DROP_RATIO = 0.5;

function normalizeSkull(value) {
    return value === SKULL_WHITE ? SKULL_WHITE : null;
}

// A skull only counts while its timer is in the future. Reading it through
// one function keeps the "is this player flagged" rule in a single place.
function hasActiveSkull(player, now = Date.now()) {
    return normalizeSkull(player.skull) === SKULL_WHITE && player.skullExpiresAt > now;
}

function grantWhiteSkull(player, now = Date.now()) {
    if (hasActiveSkull(player, now)) return false;   // already flagged
    player.skull = SKULL_WHITE;
    player.skullExpiresAt = now + SKULL_DURATION_MS;
    player.persistenceDirty = true;
    return true;
}

function clearSkull(player) {
    const had = normalizeSkull(player.skull) !== null;
    player.skull = null;
    player.skullExpiresAt = 0;
    if (had) player.persistenceDirty = true;
    return had;
}

// Integer coercion for persisted auction fields: a hand-edited save must not be
// able to inject a float, a negative, or a non-numeric value.
function safePersistInt(value, fallback, minimum = 0) {
    return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function normalizePlayerData(raw) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const safeInteger = (value, fallback, minimum = 0) =>
        Number.isSafeInteger(value) && value >= minimum ? value : fallback;
    const validClass = ['warrior', 'mage', 'ranger', 'healer'].includes(data.classType)
        ? data.classType
        : 'warrior';
    // Quest state is rebuilt from the templates rather than trusted. A
    // hand-edited or partially written save can no longer inject a
    // malformed objective that would throw inside the game tick.
    const quests = Q.sanitizePlayerQuests(data.quests);
    // Same reasoning: a friend list is rebuilt from the saved value rather than
    // trusted, so a hand-edited or partially written save cannot put a name in the
    // payload that could not have come from a real character.
    const friends = FRIENDS.sanitize(data.friends);
    const equipment = {
        weapon: null, shield: null, helmet: null, armor: null,
        legs: null, boots: null, amulet: null,
        ...(data.equipment && typeof data.equipment === 'object' ? data.equipment : {})
    };
    return {
        level: safeInteger(data.level, 1, 1),
        xp: safeInteger(data.xp, 0),
        nextXp: safeInteger(data.nextXp, CFG.XP_BASE, 1),
        gold: safeInteger(data.gold, 0),
        inventory: Array.isArray(data.inventory) ? data.inventory.filter(item => typeof item === 'string') : [],
        classType: validClass,
        subclass: typeof data.subclass === 'string' ? data.subclass : null,
        quests,
        friends,
        equipment,
        craftedRecipes: CRAFTING.sanitizeCraftedRecipes(data.craftedRecipes),
        skills: SKILLS.normalizeSkills(data.skills),
        bankGold: safeInteger(data.bankGold, 0),
        bankItems: Array.isArray(data.bankItems) ? data.bankItems.filter(item => typeof item === 'string') : [],
        // serializePlayer has always written these; without reading them back
        // guild membership and any active skull were silently dropped on
        // every login.
        x: data.x ?? 320,
        y: data.y ?? 320,
        z: MAP.normalizeZ(data.z),
        guild: typeof data.guild === 'string' && data.guild ? data.guild : null,
        auctionEscrow: Array.isArray(data.auctionEscrow)
            ? data.auctionEscrow
                .filter(r => r && typeof r.item === 'string' && r.item.length <= 100 && AUCTION.isValidPrice(r.price))
                .slice(0, CFG.AUCTION_MAX_LISTINGS)
                .map(r => ({
                    id: typeof r.id === 'string' ? r.id : null,
                    item: r.item,
                    price: r.price,
                    listedAt: safeInteger(r.listedAt, Date.now()),
                    expiresAt: safeInteger(r.expiresAt, Date.now() + CFG.AUCTION_LISTING_TTL_MS)
                }))
            : [],
        pendingMailbox: (data.pendingMailbox && typeof data.pendingMailbox === 'object')
            ? {
                gold: safeInteger(data.pendingMailbox.gold, 0),
                items: Array.isArray(data.pendingMailbox.items)
                    ? data.pendingMailbox.items.filter(i => typeof i === 'string' && i.length <= 100).slice(0, 200)
                    : []
            }
            : { gold: 0, items: [] },
        skull: normalizeSkull(data.skull),
        // A mount is a stance, not a stat, but persisting it stops a logout
        // silently dismounting the player.
        isMounted: data.isMounted === true,
        skullExpiresAt: safeInteger(data.skullExpiresAt, 0),
        maxHp: safeInteger(data.maxHp, 100, 1),
        maxMana: safeInteger(data.maxMana, 50, 1)
    };
}
function isInBounds(x, y) { return x >= 0 && y >= 0 && x < CFG.MAP_WIDTH && y < CFG.MAP_HEIGHT; }

// Manhattan distance on one floor. Deliberately floor-unaware: it takes no z at
// all, so a caller cannot pass a stale or defaulted floor index and get a
// plausible-looking number. Every existing 2D comparison uses this unchanged.
//
// An earlier revision added `z1 = 0, z2 = 0` parameters with the same shape. It
// was correct only while every entity sat on z = 0, because the defaults then
// cancelled: a mob on z = -1 measured against a player on z = 0 with a 4-arg
// call compared the default 0 to the default 0 and returned a real distance
// straight through the floor. Ranges, aggro and AoE all read this value, so the
// failure was silent and game-wide. Floor-aware measurement is opt-in below.
function dist(x1, y1, x2, y2) {
    return Math.abs(x1 - x2) + Math.abs(y1 - y2);
}

// Floor-aware distance: Infinity across different floors, so every existing
// `<= RANGE` and `minD <=` comparison rejects a cross-floor target for free
// without needing a second condition. Use this for any measurement that
// decides whether one entity can reach another.
function dist3D(x1, y1, z1, x2, y2, z2) {
    if (MAP.normalizeZ(z1) !== MAP.normalizeZ(z2)) return Infinity;
    return dist(x1, y1, x2, y2);
}

/*
 * Mob area of interest (roadmap 7.2, mobs).
 *
 * The set of mob ids each player has been told about, keyed by player id. Held here
 * rather than on the player object because the player object is serialised on every
 * save and reload, and a Set is not part of the saved shape -- putting it there
 * would either be silently dropped or quietly break persistence depending on how
 * serializePlayer happened to be written that day.
 *
 * mobAoiSets is also the only thing that makes mob AoI correct rather than merely
 * cheaper. Players are re-told their whole roster every 200ms and the client drops
 * whoever is absent, so membership needs no bookkeeping. Mobs are sent once at spawn
 * and afterwards only when they move or take damage, so without a record of what a
 * client was last told, a mob that was out of range when a player arrived would
 * never appear no matter how long the player stood beside it.
 */
const mobAoiSets = new Map();

/**
 * Send a mob-related packet only to the players who can see where it happened.
 *
 * With MOB_AOI_RADIUS at 0 this is exactly broadcastToFloor, so the pre-AoI
 * behaviour is reachable by configuration and no caller has to branch.
 *
 * @param {number} z    floor the event happened on
 * @param {object} packet
 * @param {number} x    world x the event happened at
 * @param {number} y    world y the event happened at
 */
function broadcastToFloorNear(z, packet, x, y) {
    const radius = CFG.MOB_AOI_RADIUS;
    if (radius <= 0) { broadcastToFloor(z, packet); return; }
    const floor = MAP.normalizeZ(z);
    players.forEach((p) => {
        if (MAP.normalizeZ(p.z) !== floor) return;
        if (AOI.canSee(p, x, y, radius)) sendTo(p, packet);
    });
}

/**
 * Reconcile each player's known mob set against what is now in range.
 *
 * Mobs that came into range are announced with the ordinary mob_update packet, so
 * the client needs no new handler to *see* a mob. Only leaving uses a new packet,
 * `mob_forget`, because the existing way to drop a mob is `alive: false` -- which
 * also means "died" and now sprays a blood-burst particle effect. Reusing it here
 * would burst blood every time a player walked away from a mob.
 *
 * Runs on the existing roster tick rather than a new interval: the work is a set
 * comparison per player, and it only sends when something actually crossed.
 */
function reconcileMobVisibility() {
    const radius = CFG.MOB_AOI_RADIUS;
    if (radius <= 0) return;
    players.forEach((player, pid) => {
        const floor = MAP.normalizeZ(player.z);
        const inRange = [];
        mobs.forEach((mob, id) => {
            if (MAP.normalizeZ(mob.z) !== floor) return;
            if (!AOI.canSee(player, mob.x, mob.y, radius)) return;
            inRange.push({ id, mob });
        });

        const { entered, left } = AOI.membershipChange(mobAoiSets.get(pid), inRange);

        for (const e of entered) {
            sendTo(player, {
                action: 'mob_update', id: e.id, type: e.mob.type, name: e.mob.name,
                x: e.mob.x, y: e.mob.y, z: floor, hp: e.mob.hp, maxHp: e.mob.maxHp,
                alive: true, isElite: e.mob.isElite
            });
        }
        for (const id of left) {
            sendTo(player, { action: 'mob_forget', id });
        }

        if (entered.length || left.length) mobAoiSets.set(pid, new Set(inRange.map(e => e.id)));
    });
}

/** Forget a player's mob set when they disconnect, so the map cannot grow without bound. */
function dropMobAoiSet(playerId) {
    mobAoiSets.delete(playerId);
}

/**
 * The names of every character currently connected.
 *
 * Used for the friend list's online flags. Online status is deliberately never
 * stored: a stored copy goes stale the moment anyone logs off, and the only way to
 * keep it honest would be a broadcast on every connect and disconnect.
 */
function onlineCharacterNames() {
    const names = [];
    players.forEach(p => { if (p.charName) names.push(p.charName); });
    return names;
}

/**
 * Announce a mob event -- a spawn, most often -- to whoever can see it.
 *
 * Takes x/y from the packet rather than as arguments, so a caller cannot announce a
 * mob at one position while scoping the send to another.
 *
 * This exists because the test-only spawn action was handing spawnMobAt the global
 * `broadcast`, which sent every spawn to every player on every floor. Two bugs in
 * one: mob AoI did not apply to spawns at all, and a surface mob was being announced
 * to players standing in the crypt. tests/bots/mob_aoi_probe.js found the first by
 * spawning a mob 2500px away and watching it arrive anyway.
 */
function sendMobEvent(z, packet) {
    broadcastToFloorNear(z, packet, packet.x, packet.y);
}

function recalcPlayerStats(player) {
    let baseMaxHp = 0; let baseMaxMana = 0;
    if (player.classType === 'warrior') { baseMaxHp = 150; baseMaxMana = 30; }
    if (player.classType === 'mage') { baseMaxHp = 80; baseMaxMana = 100; }
    if (player.classType === 'ranger') { baseMaxHp = 100; baseMaxMana = 50; }
    if (player.classType === 'healer') { baseMaxHp = 90; baseMaxMana = 120; }
    
    baseMaxHp += (player.level - 1) * 20;
    baseMaxMana += (player.level - 1) * 10;
    
    let bonusHp = 0;
    if (player.equipment.amulet && ITEMS.amulets[player.equipment.amulet]) {
        bonusHp += ITEMS.amulets[player.equipment.amulet].maxHpBonus || 0;
    }
    
    // Subclass stat bonuses are applied from the canonical modifier shape.
    if (player.subclass) {
        const scData = SC.SUBCLASS_DATA[player.subclass];
        const modifiers = scData && scData.statModifiers;
        if (modifiers) {
            if (modifiers.maxHpMulti) baseMaxHp = Math.floor(baseMaxHp * modifiers.maxHpMulti);
            if (modifiers.maxManaMulti) baseMaxMana = Math.floor(baseMaxMana * modifiers.maxManaMulti);
            if (modifiers.bonusHp) baseMaxHp += modifiers.bonusHp;
            if (modifiers.bonusMana) baseMaxMana += modifiers.bonusMana;
        }
    }
    
    player.maxHp = baseMaxHp + bonusHp;
    player.maxMana = baseMaxMana;
    
    if (player.hp > player.maxHp) player.hp = player.maxHp;
    if (player.mana > player.maxMana) player.mana = player.maxMana;
}

function addXp(player, amount) {
    if (player.warmode) amount = Math.floor(amount * 1.2); 
    player.xp += amount;
    let leveledUp = false;
    while (player.xp >= player.nextXp) {
        player.level++;
        player.xp -= player.nextXp;
        player.nextXp = Math.floor(player.nextXp * CFG.XP_MULTIPLIER);
        leveledUp = true;
    }
    if (leveledUp) {
        recalcPlayerStats(player);
        player.hp = player.maxHp; player.mana = player.maxMana;
        sendTo(player, { action: 'log', message: `🎉 LEVEL UP! You are now Level ${player.level}!` });
        broadcast({ action: 'log', message: `🌟 ${player.charName} reached level ${player.level}!` });
        broadcastToFloor(player.z, { action: 'fct', x: player.x, y: player.y, text: 'LEVEL UP!', color: '#ffcc00' });
    }
}

for(let i=0; i<15; i++) spawnMobPack(broadcastSurface, 3);
for(let i=0; i<CFG.MAX_CHESTS; i++) spawnChest(broadcast);
Q.spawnGatheringNodes(broadcast, isWalkable);
scheduleServerInterval(() => { if (chests.size < CFG.MAX_CHESTS) spawnChest(broadcast); }, CFG.CHEST_SPAWN_INTERVAL);

// --- Populate the dungeon (Stage 3) -----------------------------------------
// Fills z = -1 so the floor is a place rather than a corridor. The point is to
// put real entities on the far side of a floor boundary, because that is what
// makes the dist3D work meaningful: an empty dungeon cannot demonstrate that a
// surface player is safe from a mob one floor below.
// Fills every floor in the config table. Driven by the table rather than by a
// single hard-coded dungeon so a new floor is one config row, not a new code
// path -- and so the respawn below tops up all of them.
function populateFloor(spec, size) {
    if (!MAP.hasFloor(spec.z)) return 0;
    // The spawner is handed a floor-scoped broadcast, not the global one. At
    // boot nobody is connected so it makes no difference, but the respawn tick
    // runs with players online, and a global announce told every surface client
    // about a mob materialising in a dungeon they cannot see -- three of them,
    // in one live run.
    const spawned = spawnFloorPack((dataObj) => broadcastToFloor(spec.z, dataObj), {
        z: spec.z,
        size: size === undefined ? spec.mobCount : size,
        tier: spec.tier,
        eliteChance: spec.eliteChance,
        types: spec.mobTypes
    });
    return spawned.length;
}
function populateDungeon() {
    return CFG.Z_FLOORS.reduce((n, spec) => n + populateFloor(spec), 0);
}
populateDungeon();
for (const spec of CFG.Z_FLOORS) {
    const wanted = spec.chestCount || 0;
    // Scoped like the mobs: at boot nobody is listening, but the same call
    // happens from the respawn tick with players online, and a global chest
    // announce draws a treasure chest on the surface for a dungeon one.
    for (let i = 0; i < wanted; i++) spawnChest((o) => broadcastToFloor(spec.z, o), spec.z, { quiet: true });
}

// Top each floor back up rather than leaving it to empty permanently. Without
// this, a player who clears a floor once finds it bare on every return, and the
// only reason to go back is gone. The count is checked rather than blindly
// appending, so a respawn tick cannot inflate the population.
scheduleServerInterval(() => {
    for (const spec of CFG.Z_FLOORS) {
        if (!MAP.hasFloor(spec.z)) continue;
        const missing = spec.mobCount - countMobsOn(spec.z);
        if (missing > 0) populateFloor(spec, missing);

        let held = 0;
        for (const c of chests.values()) {
            if (MAP.normalizeZ(c.z) === MAP.normalizeZ(spec.z)) held++;
        }
        const wantedChests = spec.chestCount || 0;
        if (held < wantedChests) spawnChest((o) => broadcastToFloor(spec.z, o), spec.z, { quiet: true });
    }
}, CFG.DUNGEON_RESPAWN_INTERVAL);

// Spawn all bosses
// Silent on purpose: a restart would otherwise announce every boss at once.
Object.keys(BOSS_TYPES).forEach(type => spawnBoss(type, broadcast, { announce: false, broadcastToFloor }));

function syncTrade(tradeId, action) {
    const trade = TRADE.activeTrades.get(tradeId);
    if (!trade) return;
    sendTradeSyncAll(trade, action);
}

function sendQuestJournal(player) {
    const data = { quests: [], completed_count: player.quests.completed.length };
    Object.values(player.quests.active).forEach(q => {
        const questDef = Q.QUEST_DB[q.id];
        const progress = questDef ? Q.describeProgress(questDef, q) : null;
        const objectives = (Array.isArray(q.objectives) ? q.objectives : []).map(o => ({
            text: o.type === 'reach_tile' ? o.label : (o.target || o.item),
            progress: o.type === 'reach_tile' ? '' : `${o.current}/${o.required}`,
            done: o.type === 'reach_tile' ? o.done === true : o.current >= o.required
        }));
        data.quests.push({
            id: q.id, name: q.name,
            objectives,
            // Steps are only present on multi-step quests; the client shows
            // the step header when they are.
            step: progress ? {
                index: progress.stepIndex,
                count: progress.stepCount,
                text: progress.stepText,
                awaiting_turn_in: progress.awaitingTurnIn
            } : null
        });
    });
    sendTo(player, { action: 'quest_journal', ...data });
    syncNpcs(player);
}

// Grants every finished quest whose giver is this NPC. Returns the results
// so the caller can build a follow-up dialogue node.
function grantQuestTurnIns(player, npcId) {
    const results = [];
    Object.keys(player.quests.active).forEach(questId => {
        const questDef = Q.QUEST_DB[questId];
        if (!questDef || questDef.giver !== npcId) return;
        if (!Q.checkQuestComplete(player.quests, questId)) return;
        const result = Q.completeQuest(player.quests, questId, player);
        if (result) {
            announceQuestCompletion(player, result);
            results.push(result);
        }
    });
    return results;
}

function announceQuestCompletion(player, result) {
    const rewards = result.rewards || {};
    sendTo(player, { action: 'log', message: `📜 [QUEST] Completed: ${result.name}` });
    if (rewards.gold) {
        broadcastToFloor(player.z, { action: 'fct', x: player.x + 16, y: player.y, text: `+${rewards.gold}G`, color: '#ffd700' });
    }
    if (rewards.xp) {
        broadcastToFloor(player.z, { action: 'fct', x: player.x + 16, y: player.y - 20, text: `+${rewards.xp} XP`, color: '#ffcc00' });
        addXp(player, rewards.xp);
    }
    (rewards.items || []).forEach(item => {
        sendTo(player, { action: 'log', message: `🎁 Received: ${item}` });
    });
    if (result.completion_text) {
        sendTo(player, { action: 'log', message: result.completion_text });
    }
    persistPlayer(player);
}

function closeNpcDialogue(player, npcId, npcName) {
    sendTo(player, { action: 'npc_dialogue_close', npc_id: npcId, npc_name: npcName });
}

wss.on('connection', (ws) => {
    const playerId = 'p_' + Math.random().toString(36).substr(2, 6);
    // Captured here because this is the only place the peer address exists.
    // Inside the 'message' handler below there is no HTTP request object, so
    // reaching for `req` there is a ReferenceError that breaks every login.
    const remoteAddress = (ws._socket && ws._socket.remoteAddress) || null;
    
    sendTo({ ws }, { action: AUTH.required ? 'auth_required' : 'show_class_select' });

    let messageWindowStarted = Date.now();
    let messagesInWindow = 0;
    ws.on('message', async (message, isBinary) => {
        if (isBinary || (typeof message === 'string' && Buffer.byteLength(message, 'utf8') > 16 * 1024)) {
            ws.close(1009, 'Message too large');
            return;
        }
        const nowForLimit = Date.now();
        if (nowForLimit - messageWindowStarted >= 1000) {
            messageWindowStarted = nowForLimit;
            messagesInWindow = 0;
        }
        messagesInWindow += 1;
        if (messagesInWindow > 60) {
            ws.close(1008, 'Rate limit exceeded');
            return;
        }

        try {
            const data = JSON.parse(message);
            if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.action !== 'string') return;
            if (shuttingDown) {
                ws.close(1012, 'Server is shutting down');
                return;
            }

            if (data.action === 'auth_register') {
                if (authLimiter(remoteAddress)) {
                    sendTo({ ws }, { action: 'auth_error', message: 'Too many attempts. Try again later.' });
                    return;
                }
                try {
                    const result = await AUTH.register(data.username, data.password);
                    if (!result.success) {
                        sendTo({ ws }, { action: 'auth_error', message: result.message });
                        return;
                    }
                    const session = AUTH.createSession(result.account.accountId);
                    sendTo({ ws }, {
                        action: 'auth_success',
                        token: session.token,
                        expiresAt: session.expiresAt,
                        account: result.account
                    });
                } catch (error) {
                    console.error('[auth] Registration failed:', error.message);
                    sendTo({ ws }, { action: 'auth_error', message: error.code === 'ACCOUNT_EXISTS' ? 'Username is already registered.' : 'Registration failed.' });
                }
                return;
            }
            if (data.action === 'auth_login') {
                // This is the scrypt path, so it is the one worth throttling.
                if (authLimiter(remoteAddress)) {
                    sendTo({ ws }, { action: 'auth_error', message: 'Too many attempts. Try again later.' });
                    return;
                }
                try {
                    const account = await AUTH.authenticate(data.username, data.password);
                    if (!account) {
                        sendTo({ ws }, { action: 'auth_error', message: 'Invalid username or password.' });
                        return;
                    }
                    const session = AUTH.createSession(account.accountId);
                    sendTo({ ws }, {
                        action: 'auth_success',
                        token: session.token,
                        expiresAt: session.expiresAt,
                        account
                    });
                } catch (error) {
                    console.error('[auth] Login failed:', error.message);
                    sendTo({ ws }, { action: 'auth_error', message: 'Login failed.' });
                }
                return;
            }
            if (data.action === 'auth_logout') {
                if (typeof data.authToken === 'string') AUTH.revokeSession(data.authToken);
                sendTo({ ws }, { action: 'auth_logout_success' });
                return;
            }

            if (data.action === 'login') {
                if (authLimiter(remoteAddress)) {
                    ws.send(JSON.stringify({ action: 'login_fail', message: 'Rate limit exceeded. Try again later.' }));
                    return;
                }
                let accountId = null;
                if (AUTH.required || typeof data.authToken === 'string') {
                    const session = AUTH.validateSession(data.authToken);
                    if (!session) {
                        sendTo({ ws }, { action: 'login_error', message: 'A valid account session is required.' });
                        return;
                    }
                    accountId = session.accountId;
                }
                const requestedName = typeof data.name === 'string' ? data.name.trim() : '';
                if (requestedName && (
                    requestedName.length > 32 ||
                    !/^[A-Za-z][A-Za-z0-9 _-]*$/.test(requestedName)
                )) {
                    sendTo({ ws }, { action: 'login_error', message: 'Character names may use letters, numbers, spaces, underscores, and hyphens.' });
                    return;
                }
                const charName = requestedName || playerId;
                const classType = typeof data.class === 'string' ? data.class.toLowerCase() : 'warrior';
                if (!['warrior', 'mage', 'ranger', 'healer'].includes(classType)) {
                    sendTo({ ws }, { action: 'login_error', message: 'Invalid character class.' });
                    return;
                }
                const activeCharacter = Array.from(players.values()).find(existing =>
                    existing.charName.toLowerCase() === charName.toLowerCase()
                );
                if (activeCharacter) {
                    sendTo({ ws }, { action: 'login_error', message: 'Character is already online.' });
                    return;
                }
                const loginKey = charName.toLowerCase();
                if (loggingInCharacters.has(loginKey)) {
                    sendTo({ ws }, { action: 'login_error', message: 'Character login is already in progress.' });
                    return;
                }
                loggingInCharacters.add(loginKey);
                const previousReservationTimer = loginReservationTimers.get(loginKey);
                if (previousReservationTimer) clearTimeout(previousReservationTimer);
                const reservationTimer = setTimeout(() => {
                    if (loginReservationTimers.get(loginKey) === reservationTimer) {
                        loggingInCharacters.delete(loginKey);
                        loginReservationTimers.delete(loginKey);
                    }
                }, 5000);
                loginReservationTimers.set(loginKey, reservationTimer);
                let pData;
                try {
                    pData = await DB.loadPlayer(charName);
                    if (accountId !== null) {
                        if (pData) {
                            const owns = await AUTH.accountOwnsCharacter(accountId, charName);
                            if (!owns) {
                                clearTimeout(loginReservationTimers.get(loginKey));
                                loginReservationTimers.delete(loginKey);
                                loggingInCharacters.delete(loginKey);
                                sendTo({ ws }, { action: 'login_error', message: 'Character belongs to another account.' });
                                return;
                            }
                        } else {
                            await AUTH.bindCharacter(accountId, charName);
                        }
                    }
                } catch (error) {
                    console.error(`[persistence] Failed to load ${charName}:`, error.message);
                    clearTimeout(loginReservationTimers.get(loginKey));
                    loginReservationTimers.delete(loginKey);
                    loggingInCharacters.delete(loginKey);
                    sendTo({ ws }, { action: 'login_error', message: 'Unable to load character data.' });
                    return;
                }
                if (pData) pData = normalizePlayerData(pData);
                
                if (!pData) {
                    pData = {
                        level: 1, xp: 0, nextXp: CFG.XP_BASE, gold: 0, inventory: [],
                        classType, subclass: null,
                        quests: Q.initPlayerQuests(),
                        equipment: { weapon: null, shield: null, helmet: null, armor: null, legs: null, boots: null, amulet: null }
                    };
                }

                players.set(playerId, {
                    id: playerId, ws, charName,
                    x: pData.x ?? 320, y: pData.y ?? 320, z: MAP.normalizeZ(pData.z),
                    hp: pData.maxHp || 100, maxHp: pData.maxHp || 100, 
                    mana: pData.maxMana || 50, maxMana: pData.maxMana || 50, 
                    gold: pData.gold || 0,
                    level: pData.level || 1, xp: pData.xp || 0, nextXp: pData.nextXp || CFG.XP_BASE,
                    classType: pData.classType || 'warrior',
                    subclass: pData.subclass || null,
                    inventory: pData.inventory || [],
                    quests: pData.quests || Q.initPlayerQuests(),
                    equipment: pData.equipment || { weapon: null, shield: null, helmet: null, armor: null, legs: null, boots: null, amulet: null },
                    craftedRecipes: pData.craftedRecipes || [],
                    skills: SKILLS.normalizeSkills(pData.skills),
                    guild: pData.guild || null,
                    // Sanitised again on the way in, not merely copied. The live object
                    // is built field by field, so anything not listed here does not
                    // exist at runtime no matter what normalizePlayerData returned --
                    // which is exactly how the friend list survived every save and came
                    // back empty on every login.
                    friends: FRIENDS.sanitize(pData.friends),
                    auctionEscrow: Array.isArray(pData.auctionEscrow) ? pData.auctionEscrow : [],
                    pendingMailbox: pData.pendingMailbox || { gold: 0, items: [] },
                    skull: normalizeSkull(pData.skull),
                    isMounted: pData.isMounted === true,
                    skullExpiresAt: pData.skullExpiresAt || 0,
                    warmode: data.warmode === true,
                    targetId: null, lastAttackTime: 0, lastMoveTime: 0,
                    poisonStacks: 0, lastPoisonTick: 0, bleedStacks: 0, lastBleedTick: 0, stunUntil: 0, persistenceDirty: false
                });
                clearTimeout(loginReservationTimers.get(loginKey));
                loginReservationTimers.delete(loginKey);
                loggingInCharacters.delete(loginKey);

                const player = players.get(playerId);
                recalcPlayerStats(player); 
                if (!pData.maxHp) { player.hp = player.maxHp; player.mana = player.maxMana; }

                sendTo(player, { action: 'your_id', id: playerId, name: charName });
                sendTo(player, { action: 'item_dict', items: ITEMS, materials: CRAFTING.MATERIALS, recipes: CRAFTING.RECIPES });
                sendTo(player, { action: 'time_sync', isDay });
                sendTo(player, { action: 'log', message: `Welcome ${charName} (${player.classType}). Warmode: ${player.warmode?'ON ⚔️':'OFF'}` });
                sendQuestJournal(player);
                
                // The roster below is this player's floor only. Sending every
                // entity in the world would put dungeon mobs on the surface
                // client's canvas at coordinates that mean nothing there, and
                // the client has no way to tell the difference. Every entity
                // normalises the same way, so a pre-Stage-0 save with no z at
                // all still matches the surface.
                syncFloorRoster(player);
                // Anything an offline auction sale or expiry owed this character.
                const owed = AUCTION.claimMailbox(player);
                if (owed.gold > 0 || owed.items.length > 0) {
                    player.gold += owed.gold;
                    owed.items.forEach(item => player.inventory.push(item));
                    player.persistenceDirty = true;
                    const parts = [];
                    if (owed.gold > 0) parts.push(`${owed.gold} gold`);
                    if (owed.items.length > 0) parts.push(owed.items.join(', '));
                    sendTo(player, {
                        action: 'log',
                        message: `📬 While you were away you received: ${parts.join(' and ')}.`
                    });
                    sendPlayerStatus(player);
                }
                // Put anything this character still has listed back on the board.
                const restored = AUCTION.rehydrate(player);
                if (restored > 0) {
                    sendTo(player, {
                        action: 'log',
                        message: `📦 ${restored} of your auction listing(s) are active again.`
                    });
                }
                // Current auction board, so the modal can open with data.
                sendTo(player, { action: 'auction_sync', listings: AUCTION.listForClient() });
                
                // Announce the arrival to this floor only, and state the floor.
                // A global broadcast tells clients on other floors about a player
                // they cannot see, and an entry with no z leaves a client unable
                // to tell which world the coordinates belong to.
                broadcastToFloor(player.z, { action: 'player_update', id: playerId, name: charName, x: player.x, y: player.y, z: MAP.normalizeZ(player.z), classType: player.classType, warmode: player.warmode });
                return;
            }

            const player = players.get(playerId);
            if (!player) return;
            if (!data || typeof data !== 'object' || typeof data.action !== 'string') {
                sendProtocolError(player, 'Invalid message.');
                return;
            }
            const now = Date.now();

            // Per-class packet budgets. This sits after the flood guard and
            // after the action is known to be a usable string, so it can key on
            // the action, and before any handler does work -- a throttled packet
            // must cost a Map lookup, not an inference or a database write.
            //
            // `/ask` arrives as a chat packet but starts a local LLM request, so
            // it is charged to the llm budget instead of the chat one. Otherwise
            // a client could spend the generous chat budget on the most
            // expensive thing a client can ask for.
            let budgetClass = RATELIMIT.classFor(data.action);
            if (budgetClass === 'chat'
                && typeof data.text === 'string'
                && data.text.startsWith('/ask ')) {
                budgetClass = 'llm';
            }
            const verdict = rateLimiters[budgetClass].consume(player.id);
            if (!verdict.allowed) {
                // Told at most every RATE_LIMIT_NOTICE_COOLDOWN_MS, so a client
                // stuck in a loop is not notified 60 times a second. Silence
                // would be worse: a dropped packet looks like a bug.
                if (now - (player.lastRateLimitNotice || 0) >= CFG.RATE_LIMIT_NOTICE_COOLDOWN_MS) {
                    player.lastRateLimitNotice = now;
                    sendTo(player, {
                        action: 'rate_limited',
                        packetAction: data.action,
                        budgetClass,
                        retryAfterMs: verdict.retryAfterMs,
                        message: CFG.RATE_LIMIT_MESSAGE
                    });
                }
                return;
            }

            // Explicit test-only fixtures keep acceptance tests deterministic
            // without exposing progression or inventory mutations in normal
            // production servers.
            // Test-only fixtures. Extracted to server/testing.js; see that file for why
            // each of these exists and what it is for. The TEST_MODE gate stays here, at
            // the one place that decides whether this server offers them at all.
            if (TEST_MODE && TESTING.TEST_ACTIONS.has(data.action)) {
                TESTING.handleTestAction({
                    data, player, players, bosses,
                    sendTo, sendProtocolError, broadcast, broadcastToFloor,
                    // Scoped, unlike broadcast: a spawn is a mob event and must respect
                    // both the floor and the area of interest. See sendMobEvent.
                    spawnBroadcast: (packet) => sendMobEvent(player.z, packet),
                    spawnMobAt, spawnBoss, triggerBossAoe, addXp,
                    isInBounds, isWalkable,
                    knownMobTypes: KNOWN_MOB_TYPES, bossTypes: BOSS_TYPES, tileSize: CFG.TILE_SIZE
                });
                return;
            }

            if (data.action === 'chat') {
                if (data.text.startsWith('/ask ')) {
                    const prompt = data.text.substring(5).trim();
                    sendTo(player, { action: 'chat', name: 'Gemma', sender: 'Gemma', channel: 'zone', text: 'Thinking...' });
                    OLLAMA.generateOllamaResponse(prompt).then(result => {
                        sendTo(player, {
                            action: 'chat',
                            name: result.ok ? 'Gemma' : 'System',
                            sender: result.ok ? 'Gemma' : 'System',
                            channel: 'zone',
                            text: result.ok ? result.value : result.reason
                        });
                    });
                    return;
                }
                
                if (data.text.startsWith('/guild create ')) { GUILDS.createGuild(player, data.text.substring(14).trim()); return; }
                if (data.text.startsWith('/guild invite ')) { GUILDS.inviteGuild(player, data.text.substring(14).trim()); return; }
                if (data.text === '/guild accept') { GUILDS.acceptGuild(player); return; }
                if (data.text.startsWith('/guild kick ')) { GUILDS.kickGuild(player, data.text.substring(12).trim()); return; }
                if (data.text === '/guild leave') { GUILDS.leaveGuild(player); return; }
                if (data.channel === 'guild' || data.text.startsWith('/g ')) {
                    if (!player.guild) return sendTo(player, { action: 'log', message: 'You are not in a guild.' });
                    const txt = data.text.startsWith('/g ') ? data.text.substring(3) : data.text;
                    GUILDS.broadcastGuild(GUILDS.guilds.get(player.guild), txt, player.charName);
                    return;
                }

                // Private message (roadmap 6.1). Checked after the guild branch and
                // before the channel whitelist, because /w is a command rather than a
                // channel and would otherwise be rejected by the channel check.
                //
                // Two ways in: the "/w Name text" command, which needs no client
                // support at all because the client relays typed text verbatim, and an
                // explicit channel:'whisper' packet with a targetName for clients that
                // prefer to be explicit.
                const whisperLine = data.channel === 'whisper'
                    ? (typeof data.targetName === 'string' ? `/w ${data.targetName} ${typeof data.text === 'string' ? data.text : ''}` : '')
                    : data.text;
                const whispered = WHISPER.whisper({
                    text: whisperLine,
                    sender: player,
                    senderName: player.charName,
                    lookup: findPlayerByName,
                    sendTo,
                    notify: (who, message) => sendTo(who, { action: 'log', message })
                });
                if (whispered.handled) return;

                // Second barrier, and deliberately not equivalent to the first.
                //
                // If the dispatch above is ever removed or reordered, a line the
                // player typed as private falls through to the ordinary chat path.
                // The channel whitelist does not stop it: the default channel is
                // 'global', so "/w Alice my password is hunter2" would be accepted
                // and broadcast to every connected player. This is not a hypothetical
                // -- a mutation that disables the dispatch above does exactly this,
                // and the feature keeps "working", so nothing would report it.
                //
                // It reads as unreachable while the dispatch is intact. It is not
                // dead code; it is the second of two independent guards on a privacy
                // property, and it exists precisely for the case where the first one
                // is gone. tools/mutate_whisper.js removes the dispatch to keep this
                // honest.
                if (WHISPER.parse(data.text)) return;
                const text = typeof data.text === 'string' ? data.text.trim().slice(0, 240) : '';
                const requestedChannel = typeof data.channel === 'string' ? data.channel.toLowerCase() : 'global';
                const channel = requestedChannel === 'world' ? 'global' : requestedChannel;
                if (!text || !['global', 'party', 'zone'].includes(channel)) return;

                const chatPacket = {
                    action: 'chat',
                    name: player.charName,
                    sender: player.charName,
                    text,
                    channel,
                    timestamp: Date.now()
                };
                if (channel === 'global') {
                    broadcast(chatPacket);
                } else if (channel === 'party') {
                    PARTY.getPartyMembers(playerId, players).forEach(member => sendTo(member, chatPacket));
                } else {
                    const { getZone } = require('./map');
                    const myZone = getZone(player.x, player.y);
                    players.forEach(other => {
                        if (getZone(other.x, other.y) === myZone) sendTo(other, chatPacket);
                    });
                }
            }

            // Social handlers: friend list, leaderboard, emotes, inspection, guild bank.
            // Extracted to server/social.js; that file is where the reasoning lives.
            //
            // Before the channel whitelist and the party handlers, because /w and the
            // friend actions are commands rather than channels and would otherwise be
            // rejected by the channel check.
            if (SOCIAL.SOCIAL_ACTIONS.has(data.action)) {
                // Awaited, so the dispatch runs to completion before the handler
                // returns. handleSocial is async because resolving whether a friend
                // exists is a database read; not awaiting it would let the packet
                // handler continue and potentially fall through to a later branch
                // that claims the same action.
                await SOCIAL.handleSocial({
                    data, player, players, DB, GUILDS,
                    sendTo, sendProtocolError, broadcastToFloor,
                    persistPlayer, onlineCharacterNames
                });
                return;
            }
            // --- PARTY and TRADE ---
            // Extracted to server/grouping.js; see that file for why these two
            // live together and why the duplicate action names are deliberate.
            if (GROUPING.GROUPING_ACTIONS.has(data.action)) {
                GROUPING.handleGrouping({
                    data, player, playerId, players,
                    PARTY, TRADE, TRADE_MAX_DISTANCE: TRADE.TRADE_MAX_DISTANCE,
                    sendTo, sendProtocolError,
                    findPlayerByName, dist3D,
                    sendPartySync, syncTrade, sendTradeSyncAll,
                    recalcPlayerStats, sendPlayerStatus
                });
                return;
            }

            // --- SUBCLASS EVOLUTION ---
            if (data.action === 'evolve') {
                if (SC.canEvolve(player)) {
                    const available = SC.getAvailableSubclasses(player.classType);
                    sendTo(player, {
                        action: 'show_subclass_select',
                        subclasses: available,
                        options: available.map(option => option.id)
                    });
                } else {
                    sendTo(player, {
                        action: 'log',
                        message: player.subclass
                            ? '❌ Already evolved!'
                            : `❌ Reach level ${SC.SUBCLASS_LEVEL_REQUIREMENT} to evolve (current: ${player.level}).`
                    });
                }
            }
            if (data.action === 'select_subclass') {
                const subclassId = data.subclassId || data.subclass;
                if (typeof subclassId === 'string' && SC.evolvePlayer(player, subclassId)) {
                    recalcPlayerStats(player);
                    player.hp = player.maxHp; player.mana = player.maxMana;
                    broadcast({ action: 'log', message: `🌟 ${player.charName} evolved into ${subclassId.toUpperCase()}!` });
                    broadcastToFloor(player.z, { action: 'fct', x: player.x, y: player.y, text: `EVOLVED: ${subclassId}!`, color: '#ff00ff' });
                    sendTo(player, { action: 'evolution_complete', subclass: subclassId });
                } else {
                    sendTo(player, { action: 'log', message: '❌ Invalid subclass selection.' });
                }
            }

            // --- COMBAT VERBS ---
            // Extracted to server/combat_actions.js. That file holds the gates
            // -- class check, mana cost, range, target -- not the damage maths,
            // which combat.js has always owned. See it for why two of the gates
            // refuse silently.
            if (COMBAT_ACTIONS.COMBAT_ACTION_NAMES.has(data.action)) {
                COMBAT_ACTIONS.handleCombatActions({
                    data, player, players, corpses,
                    COMBAT, CFG, MAP,
                    sendTo, sendProtocolError, broadcastToFloor, dist3D
                });
                return;
            }

            if (data.action === 'accept_quest') {
                if (typeof data.quest_id !== 'string' || typeof data.npc_id !== 'string') {
                    sendProtocolError(player, 'Invalid quest request.');
                    return;
                }
                const questNpcId = data.npc_id;
                const questNpc = typeof questNpcId === 'string' ? npcs.get(questNpcId) : null;
                if (!questNpc || dist3D(player.x, player.y, player.z, questNpc.x, questNpc.y, questNpc.z) > 96) {
                    sendProtocolError(player, 'You must be near the quest giver.');
                } else if (Q.acceptQuest(player.quests, data.quest_id, questNpcId)) {
                    sendQuestJournal(player);
                } else {
                    sendProtocolError(player, 'Quest cannot be accepted yet.');
                }
            }

            if (data.action === 'move') {
                if (now < player.stunUntil) {
                    sendTo(player, { action: 'force_position', x: player.x, y: player.y });
                    return;
                }
                if (!Number.isInteger(data.x) || !Number.isInteger(data.y)) {
                    sendTo(player, { action: 'force_position', x: player.x, y: player.y });
                    return;
                }
                const diffX = Math.abs(data.x - player.x); const diffY = Math.abs(data.y - player.y);
                const isOneStep = (diffX === CFG.TILE_SIZE && diffY === 0) || (diffX === 0 && diffY === CFG.TILE_SIZE);
                
                let speedBonus = 0;
                if (player.equipment.boots && ITEMS.boots[player.equipment.boots]) speedBonus = ITEMS.boots[player.equipment.boots].speedBonus || 0;
                
                // A mounted player moves faster, so the server's own cooldown
                // check has to allow the same rate or every mounted step is
                // rejected and the client is snapped back.
                const mountBonus = player.isMounted ? CFG.MOUNT_MOVE_COOLDOWN_REDUCTION : 0;
                const moveSpeed = Math.max(80, CFG.PLAYER_MOVE_COOLDOWN_BASE - (player.level * 3) - speedBonus - mountBonus);

                if (now - (player.lastMoveTime || 0) >= moveSpeed && isOneStep && isWalkable(data.x, data.y, player.z)) {
                    player.lastMoveTime = now;
                    player.x = data.x; player.y = data.y;
                    abortSeparatedTrade(playerId);

                    // Traversal is Tibia-native: walking onto the tile is the
                    // whole interaction, so there is no new packet and no new
                    // client action. A traversal tile is walkable, which is why
                    // this runs after the isWalkable check above rather than
                    // being rejected by it.
                    //
                    // The move cooldown is deliberately not charged for the
                    // step itself beyond lastMoveTime, and the descent does not
                    // re-enter movement: the player arrives standing still and
                    // must walk again, so holding a movement key cannot chain
                    // the player back up the far side.
                    const traversal = MAP.getTransition(player.z, player.x, player.y);
                    if (traversal && performTraversal(player, traversal)) {
                        return;
                    }
                    
                    if (player.bleedStacks > 0) {
                        const bleedDmg = player.bleedStacks * CFG.BLEED_DMG_BASE * CFG.BLEED_MOVE_MULT;
                        player.hp -= bleedDmg;
                        broadcastToFloor(player.z, { action: 'fct', x: player.x+16, y: player.y, text: `-${bleedDmg}`, color: '#ff0000' });
                        checkPlayerDeath(player);
                    }

                    chests.forEach((chest, chestId) => {
                        if (player.x === chest.x && player.y === chest.y) {
                            player.gold += CFG.CHEST_GOLD_REWARD;
                            broadcastToFloor(player.z, { action: 'fct', x: player.x+16, y: player.y, text: `+${CFG.CHEST_GOLD_REWARD}G`, color: '#ffd700' });
                            chests.delete(chestId); broadcastToFloor(MAP.normalizeZ(chest.z), { action: 'chest_update', id: chestId, active: false });
                        }
                    });

                    Q.gatheringNodes.forEach((node, nodeId) => {
                        if (node.active && player.x === node.x && player.y === node.y) {
                            node.active = false;
                            player.inventory.push(node.name);
                            broadcastToFloor(player.z, { action: 'fct', x: player.x+16, y: player.y, text: `+${node.name}`, color: '#88ff88' });
                            broadcastToFloor(MAP.normalizeZ(node.z), { action: 'node_remove', id: nodeId });
                            const updates = Q.onItemGathered(player.quests, node.name);
                            updates.forEach(u => sendTo(player, { action: 'log', message: `📜 [QUEST] ${u.questName}: ${u.objective}` }));
                            sendQuestJournal(player);
                            // Ore trains mining, logs train woodcutting.
                            // Anything else gathered trains nothing.
                            const gatherSkill = SKILLS.grantGatheringSkill(player.skills, node.name, 12);
                            if (gatherSkill) {
                                sendTo(player, { action: 'skill_update', skill: gatherSkill });
                                if (gatherSkill.leveled) {
                                    sendTo(player, { action: 'log', message: `⭐ ${gatherSkill.name} is now level ${gatherSkill.level}!` });
                                    broadcastToFloor(player.z, { action: 'fct', x: player.x+16, y: player.y-24, text: `${gatherSkill.name} ${gatherSkill.level}`, color: '#fbbf24' });
                                }
                            }
                            setTimeout(() => {
                                node.active = true;
                                // Floor-scoped, and it carries z. A global node_sync
                                // with no z told a dungeon client about a surface ore
                                // node and left it unable to say which world the
                                // coordinates belonged to -- the same defect the mob
                                // movement broadcast had.
                                broadcastToFloor(node.z, { action: 'node_sync', id: nodeId, name: node.name, x: node.x, y: node.y, z: MAP.normalizeZ(node.z), color: node.color, symbol: node.symbol });
                            }, node.respawnTime);
                        }
                    });
                    const exploreUpdates = Q.onPlayerMoved(player.quests, player.x, player.y);
                    exploreUpdates.forEach(u => sendTo(player, { action: 'log', message: `📜 [QUEST] ${u.questName}: ${u.objective}` }));
                    if (exploreUpdates.length > 0) sendQuestJournal(player);
                } else {
                    sendTo(player, { action: 'force_position', x: player.x, y: player.y });
                }
            }
            
            // --- INVENTORY, EQUIPMENT and GROUND ITEMS ---
            // Extracted to server/inventory.js. That file holds the reasoning
            // about one-copy removal, the ground-item floor record, and why
            // toggle_mount is here rather than with the movement code.
            if (INVENTORY.INVENTORY_ACTIONS.has(data.action)) {
                INVENTORY.handleInventory({
                    data, player, now,
                    CFG, MAP, ITEMS, groundItems,
                    nextGroundItemId: () => 'gi_' + groundItemCounter++,
                    sendTo, sendProtocolError, broadcast, broadcastToFloor,
                    dist3D, resolveGroundTarget, broadcastGroundSync,
                    sendPlayerStatus, recalcPlayerStats,
                    mountPlayer, dismountPlayer
                });
                return;
            }

            if (data.action === 'fish') {
                if (now - (player.lastFishTime || 0) < CFG.FISHING_COOLDOWN_MS) {
                    const wait = ((CFG.FISHING_COOLDOWN_MS - (now - (player.lastFishTime || 0))) / 1000).toFixed(1);
                    sendTo(player, { action: 'log', message: `⏳ Your line is still recovering (${wait}s).` });
                    return;
                }
                // The cast is only legal next to water. Checked server-side
                // from the player's real position, never from a client hint.
                if (hasWaterNear(player.x, player.y, CFG.FISHING_RANGE) < 1) {
                    sendProtocolError(player, 'You need to be standing next to water to fish.');
                    return;
                }
                player.lastFishTime = now;
                const caughtFish = Math.random() < CFG.FISHING_CATCH_CHANCE;
                const item = caughtFish ? 'Raw Fish' : 'Old Boot';
                player.inventory.push(item);
                player.persistenceDirty = true;
                broadcastToFloor(player.z, { action: 'fct', x: player.x + 16,
                    y: player.y,
                    text: `+${item}`,
                    color: caughtFish ? '#5bc0de' : '#8b7355'
                });
                sendTo(player, {
                    action: 'log',
                    message: caughtFish
                        ? `🎣 You reeled in a ${item}!`
                        : `🎣 You pull up an ${item}. Better luck next time.`
                });
                sendTo(player, {
                    action: 'fishing_result',
                    item,
                    success: caughtFish
                });
                sendPlayerStatus(player);
            }

            if (data.action === 'auction_list') {
                const result = AUCTION.createListing(player, data.item, data.price);
                if (!result.success) {
                    sendProtocolError(player, result.message);
                    return;
                }
                sendTo(player, { action: 'log', message: `📦 Listed ${result.listing.item} for ${result.listing.price} gold.` });
                broadcast({ action: 'auction_sync', listings: AUCTION.listForClient() });
                sendPlayerStatus(player);
            }

            if (data.action === 'auction_buy') {
                // Async: paying an offline seller may need to read and write
                // that character's row.
                const result = await AUCTION.buyListing(player, data.listingId || data.id, players);
                if (!result.success) {
                    sendProtocolError(player, result.message);
                    return;
                }
                sendTo(player, {
                    action: 'log',
                    message: `🔨 Bought ${result.item} for ${result.pricePaid} gold.`
                });
                broadcastToFloor(player.z, { action: 'fct', x: player.x + 16, y: player.y, text: `+${result.item}`, color: '#ffcc44' });

                // Tell the seller directly when they are online; otherwise the
                // gold waits in their mailbox until they next log in.
                const seller = AUCTION.findOnlinePlayer(players, result.sellerName);
                if (seller) {
                    sendTo(seller, {
                        action: 'log',
                        message: `💰 Your ${result.item} sold for ${result.pricePaid} gold (fee ${result.sellerFee}). You received ${result.sellerPayout}.`
                    });
                    broadcastToFloor(seller.z, { action: 'fct', x: seller.x + 16, y: seller.y, text: `+${result.sellerPayout}g`, color: '#ffd700' });
                    sendPlayerStatus(seller);
                } else {
                    sendTo(player, {
                        action: 'log',
                        message: `📬 ${result.sellerName} is offline; their ${result.sellerPayout} gold is held until they return.`
                    });
                }
                broadcast({ action: 'auction_sync', listings: AUCTION.listForClient() });
                sendPlayerStatus(player);
            }

            if (data.action === 'auction_request') {
                // Always answer with a full snapshot so a client that missed an
                // earlier sync can catch up.
                sendTo(player, { action: 'auction_sync', listings: AUCTION.listForClient() });
                const owed = AUCTION.mailboxPreview(player);
                if (owed && (owed.gold > 0 || owed.items.length > 0)) {
                    sendTo(player, {
                        action: 'auction_mailbox',
                        gold: owed.gold,
                        items: owed.items,
                        listingCount: owed.listingCount
                    });
                }
            }

            // --- SHOP ACTIONS ---
            if (data.action === 'open_crafting') {
                if (dist3D(player.x, player.y, player.z, CRAFTING.WORKBENCH.x, CRAFTING.WORKBENCH.y, CRAFTING.WORKBENCH.z) > 96) {
                    sendProtocolError(player, 'You must be near the workbench.');
                    return;
                }
                sendTo(player, {
                    action: 'crafting_open',
                    recipes: CRAFTING.listRecipes(player),
                    inventory: player.inventory,
                    level: player.level
                });
            }

            if (data.action === 'craft_item') {
                if (typeof data.recipe_id !== 'string') {
                    sendProtocolError(player, 'Invalid recipe request.');
                    return;
                }
                if (dist3D(player.x, player.y, player.z, CRAFTING.WORKBENCH.x, CRAFTING.WORKBENCH.y, CRAFTING.WORKBENCH.z) > 96) {
                    sendProtocolError(player, 'You must be near the workbench.');
                    return;
                }
                const craftResult = CRAFTING.craftItem(player, data.recipe_id);
                if (!craftResult.success) {
                    sendTo(player, { action: 'log', message: '⚒️ ' + craftResult.message });
                } else {
                    sendTo(player, { action: 'log', message: '⚒️ ' + craftResult.message });
                    broadcastToFloor(player.z, { action: 'fct', x: player.x + 16, y: player.y, text: `+${craftResult.result}`, color: '#fbbf24' });
                    sendTo(player, { action: 'crafting_sync', recipes: CRAFTING.listRecipes(player), inventory: player.inventory });
                    persistPlayer(player);
                }
            }

            if (data.action === 'buy_item') {
                const itemInfo = SHOP_INVENTORY[data.item];
                if (itemInfo && player.gold >= itemInfo.price) {
                    player.gold -= itemInfo.price;
                    player.inventory.push(data.item);
                    sendTo(player, { action: 'log', message: `🪙 Bought ${data.item} for ${itemInfo.price}G.` });
                    sendTo(player, { action: 'shop_sync', gold: player.gold });
                } else {
                    sendTo(player, { action: 'log', message: `❌ Not enough gold or item not found.` });
                }
            }
            if (data.action === 'sell_item') {
                const itemIndex = player.inventory.indexOf(data.item);
                if (itemIndex > -1) {
                    player.inventory.splice(itemIndex, 1);
                    let sellPrice = 5; 
                    if (SHOP_INVENTORY[data.item]) sellPrice = Math.floor(SHOP_INVENTORY[data.item].price / 2);
                    player.gold += sellPrice;
                    sendTo(player, { action: 'log', message: `🪙 Sold ${data.item} for ${sellPrice}G.` });
                    sendTo(player, { action: 'shop_sync', gold: player.gold });
                }
            }

            if (data.action === 'bank_deposit_gold') {
                const npc = npcs.get('n_banker');
                if (!npc || dist3D(player.x, player.y, player.z, npc.x, npc.y, npc.z) > 96) return;
                let amt = parseInt(data.amount);
                if (amt > 0 && player.gold >= amt) {
                    player.gold -= amt;
                    player.bankGold = (player.bankGold || 0) + amt;
                    sendTo(player, { action: 'bank_update', gold: player.bankGold, items: player.bankItems || [] });
                }
            }
            if (data.action === 'bank_withdraw_gold') {
                const npc = npcs.get('n_banker');
                if (!npc || dist3D(player.x, player.y, player.z, npc.x, npc.y, npc.z) > 96) return;
                let amt = parseInt(data.amount);
                if (amt > 0 && (player.bankGold || 0) >= amt) {
                    player.bankGold -= amt;
                    player.gold += amt;
                    sendTo(player, { action: 'bank_update', gold: player.bankGold, items: player.bankItems || [] });
                }
            }
            if (data.action === 'bank_deposit_item') {
                const npc = npcs.get('n_banker');
                if (!npc || dist3D(player.x, player.y, player.z, npc.x, npc.y, npc.z) > 96) return;
                const idx = player.inventory.indexOf(data.item);
                if (idx !== -1) {
                    if (!player.bankItems) player.bankItems = [];
                    if (player.bankItems.length < 50) {
                        player.inventory.splice(idx, 1);
                        player.bankItems.push(data.item);
                        sendTo(player, { action: 'bank_update', gold: player.bankGold || 0, items: player.bankItems });
                    }
                }
            }
            if (data.action === 'bank_withdraw_item') {
                const npc = npcs.get('n_banker');
                if (!npc || dist3D(player.x, player.y, player.z, npc.x, npc.y, npc.z) > 96) return;
                if (!player.bankItems) return;
                const idx = player.bankItems.indexOf(data.item);
                if (idx !== -1) {
                    if (player.inventory.length < 30) {
                        player.bankItems.splice(idx, 1);
                        player.inventory.push(data.item);
                        sendTo(player, { action: 'bank_update', gold: player.bankGold || 0, items: player.bankItems });
                    }
                }
            }

            if (data.action === 'talk_npc') {
                // The workbench is a separate interactable, not a quest giver.
                if (data.npc_id === CRAFTING.WORKBENCH.id) {
                    if (dist3D(player.x, player.y, player.z, CRAFTING.WORKBENCH.x, CRAFTING.WORKBENCH.y, CRAFTING.WORKBENCH.z) > 96) return;
                    sendTo(player, {
                        action: 'crafting_open',
                        recipes: CRAFTING.listRecipes(player),
                        inventory: player.inventory,
                        level: player.level
                    });
                    return;
                }
                const npc = npcs.get(data.npc_id);
                if (!npc || dist3D(player.x, player.y, player.z, npc.x, npc.y, npc.z) > 96) return;
                
                if (data.npc_id === 'n_merchant') {
                    sendTo(player, { action: 'open_shop', inventory: SHOP_INVENTORY, gold: player.gold });
                    return;
                }
                if (data.npc_id === 'n_banker') {
                    sendTo(player, { action: 'bank_open', gold: player.bankGold || 0, items: player.bankItems || [] });
                    return;
                }

                // Hand in anything the player has finished with this giver.
                let turnedInNow = [];
                if (!Q.hasDialogueTree(data.npc_id)) {
                    turnedInNow = grantQuestTurnIns(player, data.npc_id);
                }

                if (Q.hasDialogueTree(data.npc_id)) {
                    const ctx = Q.buildDialogueContext(player, data.npc_id);
                    const node = Q.resolveDialogue(data.npc_id, null, ctx);
                    if (node) {
                        sendTo(player, { action: 'npc_dialogue', npc_id: data.npc_id, npc_name: npc.name, ...node });
                        sendQuestJournal(player);
                        return;
                    }
                }

                // Legacy NPCs (no dialogue tree) keep the flat quest list, so
                // the existing browser acceptance flow is unchanged.
                const available = Q.getAvailableQuests(player.quests, data.npc_id);
                if (available.length > 0) {
                    sendTo(player, { action: 'npc_dialogue', npc_id: data.npc_id, npc_name: npc.name, quests: available });
                } else if (turnedInNow.length === 0) {
                    sendTo(player, { action: 'log', message: `🗣️ ${npc.name}: "Greetings, traveler. I have no more tasks for you right now."` });
                }
                sendQuestJournal(player);
            }

            if (data.action === 'dialogue_choice') {
                if (typeof data.npc_id !== 'string' || typeof data.node_id !== 'string' || typeof data.choice_id !== 'string') {
                    sendProtocolError(player, 'Invalid dialogue choice.');
                    return;
                }
                const npc = npcs.get(data.npc_id);
                if (!npc || dist3D(player.x, player.y, player.z, npc.x, npc.y, npc.z) > 96) {
                    sendProtocolError(player, 'You must be near the speaker.');
                    return;
                }
                const ctx = Q.buildDialogueContext(player, data.npc_id);
                // The predicate is re-evaluated here, so a forged or replayed
                // choice is rejected rather than trusted.
                const choice = Q.resolveChoice(data.npc_id, data.node_id, data.choice_id, ctx);
                if (!choice) {
                    sendTo(player, { action: 'npc_dialogue', npc_id: data.npc_id, npc_name: npc.name, ...(Q.resolveDialogue(data.npc_id, null, Q.buildDialogueContext(player, data.npc_id)) || { text: '"..."', choices: [] }) });
                    return;
                }

                if (choice.action && choice.action.type === 'accept_quest') {
                    if (Q.acceptQuest(player.quests, choice.action.questId, data.npc_id)) {
                        const questDef = Q.QUEST_DB[choice.action.questId];
                        sendTo(player, { action: 'log', message: `📜 [QUEST] Accepted: ${questDef.name}` });
                        sendQuestJournal(player);
                    } else {
                        sendProtocolError(player, 'Quest cannot be accepted yet.');
                        return;
                    }
                } else if (choice.action && choice.action.type === 'turn_in') {
                    const result = Q.completeQuest(player.quests, choice.action.questId, player);
                    if (!result) {
                        sendProtocolError(player, 'That task is not complete.');
                        return;
                    }
                    announceQuestCompletion(player, result);
                    sendQuestJournal(player);
                    ctx.lastCompletion = { text: result.completion_text };
                }

                const next = choice.next ? Q.resolveDialogue(data.npc_id, choice.next, ctx) : null;
                if (next) {
                    sendTo(player, { action: 'npc_dialogue', npc_id: data.npc_id, npc_name: npc.name, ...next });
                } else {
                    closeNpcDialogue(player, data.npc_id, npc.name);
                }
            }

        } catch (e) { console.error(e); }
    });

    ws.on('close', () => {
        const p = players.get(playerId);
        if (p) {
            const party = PARTY.getParty(playerId);
            if (party) {
                const leaveResult = PARTY.leaveParty(playerId);
                if (leaveResult.success) sendPartySync(leaveResult.party);
            }
            TRADE.cancelTradeRequestsForPlayer(playerId);
            const cancelledTrades = TRADE.cancelTradesForPlayer(playerId);
            cancelledTrades.forEach(trade => {
                [trade.player1Id, trade.player2Id].forEach(id => {
                    if (id !== playerId) sendTo(players.get(id), { action: 'trade_close', tradeId: trade.id });
                });
            });
            if (!shuttingDown) persistPlayer(p);
            players.delete(playerId);
            // Otherwise the mob reconciliation set for this id is never read again
            // and never freed, so it grows by one entry per connection for the life
            // of the process.
            dropMobAoiSet(playerId);
            broadcast({ action: 'player_left', id: playerId });
        }
    });
});

scheduleServerInterval(() => { 
    players.forEach(p => { 
        if (inSafeZone(p.x, p.y, p.z)) {
            if (p.hp < p.maxHp) { p.hp = Math.min(p.hp + CFG.SAFEZONE_HEAL_PER_TICK, p.maxHp); broadcastToFloor(p.z, { action: 'fct', x: p.x+16, y: p.y, text: '+HP', color: '#44ff44' }); }
        }
        p.mana = Math.min(p.mana + CFG.MANA_REGEN_PER_TICK, p.maxMana);
        
        
        persistPlayer(p);
    }); 
}, 10000);

// Despawn dropped items that have been lying around too long, and enforce the
// cap. Runs on its own interval so an idle server still cleans up.
scheduleServerInterval(() => sweepGroundItems(), CFG.GROUND_SWEEP_INTERVAL);

// Clear out corpses once their timer expires.
scheduleServerInterval(() => sweepCorpses(), CFG.CORPSE_SWEEP_INTERVAL);

// Despawns corpses whose timer has run out. Without this the corpse Map grew
// without bound and a kill stayed lootable forever.
function sweepCorpses(now = Date.now()) {
    let removed = 0;
    for (const [id, corpse] of corpses.entries()) {
        if (corpse.expiresAt <= now) {
            corpses.delete(id);
            // The client already handles corpse_remove, so this clears the
            // sprite instead of leaving a phantom behind.
            broadcastToFloor(MAP.normalizeZ(corpse.z), { action: 'corpse_remove', id });
            removed++;
        }
    }
    return removed;
}

// Reap auction listings whose week is up, returning the item to the seller
// (directly if they are online, otherwise via their mailbox).
scheduleServerInterval(() => {
    // sweepExpired is async because returning an item to a logged-out seller
    // may need to write that character's row.
    AUCTION.sweepExpired(Date.now(), players).then((expired) => {
        if (expired && expired.length > 0) {
            broadcast({ action: 'auction_sync', listings: AUCTION.listForClient() });
        }
    }).catch((error) => {
        console.error('[auction] expiry sweep failed:', error.message);
    });
}, 60_000);

scheduleServerInterval(() => {
    const now = Date.now();
    // Grouped by floor and sent one packet per occupied floor, not a single
    // global list.
    //
    // A global players_sync re-admits everyone to everyone 200ms after a
    // traversal. performTraversal sends player_left to the floor being left, but
    // the next tick's roster put the departing player straight back, so a
    // surface client carried a permanent ghost of someone standing in the cave
    // at the ladder's coordinates. Scoping the packet is also what lets the
    // existing client work unchanged: it keeps merging whatever it is sent, and
    // now simply never hears about another floor.
    const byFloor = new Map();
    players.forEach((p, pid) => {
        // Expire a lapsed skull here rather than only on read, so the flag
        // cannot linger in a save and the client sees it clear promptly.
        if (p.skull && !hasActiveSkull(p, now)) {
            clearSkull(p);
            sendTo(p, { action: 'log', message: '💀 Your white skull has faded.' });
            broadcastToFloor(p.z, { action: 'fct', x: p.x + 16, y: p.y - 24, text: 'UNSKULL', color: '#aaaaaa' });
        }
        const floor = MAP.normalizeZ(p.z);
        if (!byFloor.has(floor)) byFloor.set(floor, []);
        byFloor.get(floor).push({
            id: pid, name: p.charName, x: p.x, y: p.y, z: floor, classType: p.classType,
            warmode: p.warmode, equipment: p.equipment,
            // Clients read this to render the skull marker. Sent as a plain
            // boolean so the client never has to reason about the timer.
            skulled: hasActiveSkull(p, now),
            isMounted: p.isMounted === true,
            guild: p.guild || null
        });
    });
    for (const [floor, list] of byFloor) {
        // Area of interest (roadmap 7.2). Each client gets its own list rather
        // than a shared floor-wide one, so a player standing in a corner is not
        // made to carry updates for everyone else on the floor five times a
        // second. The selection itself, and why it is a square rather than a
        // circle, is in server/aoi.js.
        //
        // The client needs no new removal packet for this to work. engine.js
        // already treats players_sync as authoritative and complete:
        //
        //     for (let id in otherPlayers) { if (!newIds.includes(id)) delete otherPlayers[id]; }
        //
        // so a peer that walks out of range is simply absent from the next list
        // and the client drops it.
        if (CFG.AOI_RADIUS <= 0) {
            broadcastToFloor(floor, { action: 'players_sync', players: list });
            continue;
        }
        for (const viewer of list) {
            sendTo(players.get(viewer.id), {
                action: 'players_sync',
                players: AOI.visibleTo(viewer, list, CFG.AOI_RADIUS)
            });
        }
    }
    // Ground loot rides along with the same periodic broadcast so a client
    // that missed an earlier ground_sync resynchronises on its own.
    if (groundItems.size > 0) broadcastGroundSync();
    // And the same reasoning for mob visibility: a mob the player has walked up to
    // must appear even though nothing about it changed and no packet was due.
    reconcileMobVisibility();
}, CFG.PLAYER_BROADCAST_INTERVAL);

scheduleServerInterval(() => {
    players.forEach(p => {
        let speedBonus = 0;
        if (p.equipment.boots && ITEMS.boots[p.equipment.boots]) speedBonus = ITEMS.boots[p.equipment.boots].speedBonus || 0;
        sendTo(p, { 
            action: 'status', hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana, 
            level: p.level, xp: p.xp, nextXp: p.nextXp,
            poison: p.poisonStacks, bleed: p.bleedStacks, stun: p.stunUntil > Date.now(),
            gold: p.gold, inventory: p.inventory, equipment: p.equipment, classType: p.classType,
            subclass: p.subclass, speedBonus: speedBonus,
            partyId: PARTY.getParty(p.id) ? PARTY.getParty(p.id).id : null
        });
    });
}, CFG.STATUS_BROADCAST_INTERVAL);

scheduleServerInterval(() => {
    try {
    const now = Date.now();
    const damageMultiplier = isDay ? 1.0 : 1.2; 

    COMBAT.runAutoAttack(now);

    mobs.forEach((mob, mobId) => {
        let closest = null, minD = Infinity;
        players.forEach(p => { 
            if (p.hp > 0 && !inSafeZone(p.x, p.y, mob.z)) {
                const d2 = dist3D(p.x, p.y, p.z, mob.x, mob.y, mob.z); 
                if (d2 < minD) { minD = d2; closest = p; } 
            } 
        });
        if (!closest) return;
        
        if (minD <= CFG.MELEE_RANGE) {
            let def = 0;
            const eq = closest.equipment;
            if (eq) {
                if (eq.armor && ITEMS.armor[eq.armor]) def += ITEMS.armor[eq.armor].def;
                if (eq.helmet && ITEMS.helmets[eq.helmet]) def += ITEMS.helmets[eq.helmet].def;
                if (eq.legs && ITEMS.legs[eq.legs]) def += ITEMS.legs[eq.legs].def;
                if (eq.boots && ITEMS.boots[eq.boots]) def += ITEMS.boots[eq.boots].def;
                if (eq.shield && ITEMS.shields[eq.shield]) def += ITEMS.shields[eq.shield].def;
            }

            const result = mobAttack(mob, closest, damageMultiplier, def); 
            if (result) {
                broadcastToFloor(closest.z, { action: 'fct', x: closest.x+16, y: closest.y, text: `-${result.damage}`, color: '#ff4444' });
                if (result.poisoned) broadcastToFloor(closest.z, { action: 'fct', x: closest.x+16, y: closest.y-20, text: `POISON`, color: '#00ff00' });
                if (result.bled) broadcastToFloor(closest.z, { action: 'fct', x: closest.x+16, y: closest.y-20, text: `BLEED`, color: '#ff4444' });
                if (result.stunned) broadcastToFloor(closest.z, { action: 'fct', x: closest.x+16, y: closest.y-20, text: `STUN`, color: '#ff88ff' });
                checkPlayerDeath(closest, mob.name);
            }
        } else if (minD <= AGGRO_RANGE) { 
            if (moveMobToward(mob, closest.x, closest.y)) {
                // Floor-scoped, and it carries z. Broadcast globally it told
                // every surface client about a dungeon mob that had moved, and
                // because the packet had no z the client filed it under "no
                // floor" -- so a mob was simultaneously known to the surface
                // roster and unclassifiable.
                broadcastToFloorNear(mob.z, { action: 'mob_update', id: mobId, x: mob.x, y: mob.y, z: MAP.normalizeZ(mob.z), hp: mob.hp, maxHp: mob.maxHp, alive: true, isElite: mob.isElite, name: mob.name, type: mob.type }, mob.x, mob.y);
            }
        }
    });

    players.forEach(p => {
        if (p.poisonStacks > 0 && now - p.lastPoisonTick >= CFG.POISON_TICK_INTERVAL) {
            p.lastPoisonTick = now; p.hp -= p.poisonStacks * CFG.POISON_DMG_PER_STACK;
            broadcastToFloor(p.z, { action: 'fct', x: p.x+16, y: p.y, text: `-${p.poisonStacks * CFG.POISON_DMG_PER_STACK}`, color: '#00ff00' });
            p.poisonStacks--; 
            checkPlayerDeath(p, 'Poison');
        }
        if (p.bleedStacks > 0 && now - p.lastBleedTick >= CFG.BLEED_TICK_INTERVAL) {
            p.lastBleedTick = now; p.hp -= p.bleedStacks * CFG.BLEED_DMG_BASE;
            broadcastToFloor(p.z, { action: 'fct', x: p.x+16, y: p.y, text: `-${p.bleedStacks * CFG.BLEED_DMG_BASE}`, color: '#ff4444' });
            p.bleedStacks--; 
            checkPlayerDeath(p, 'Bleeding');
        }
    });

    // Boss AI tick
    bosses.forEach((boss, bossId) => {
        bossAI(boss, players, broadcast, mobs, broadcastToFloor);
        // Delayed boss abilities can lower HP outside the main combat branch;
        // normalize death state on the next authoritative tick.
        players.forEach(p => {
            if (p.hp <= 0) checkPlayerDeath(p, 'Boss ability');
        });
        
        // Boss attacks nearest player
        let closest = null, minD = Infinity;
        players.forEach(p => {
            if (p.hp > 0 && !inSafeZone(p.x, p.y, boss.z)) {
                const d2 = dist3D(p.x, p.y, p.z, boss.x, boss.y, boss.z);
                if (d2 < minD) { minD = d2; closest = p; }
            }
        });
        
        if (closest && minD <= CFG.MELEE_RANGE && boss.hp > 0) {
            if (now - (boss.lastAttackTime || 0) >= 1500) {
                boss.lastAttackTime = now;
                let def = 0;
                const eq = closest.equipment;
                if (eq) {
                    if (eq.armor && ITEMS.armor[eq.armor]) def += ITEMS.armor[eq.armor].def;
                    if (eq.helmet && ITEMS.helmets[eq.helmet]) def += ITEMS.helmets[eq.helmet].def;
                    if (eq.shield && ITEMS.shields[eq.shield]) def += ITEMS.shields[eq.shield].def;
                }
                const damage = Math.max(1, boss.damage - def);
                closest.hp -= damage;
                broadcastToFloor(closest.z, { action: 'fct', x: closest.x+16, y: closest.y, text: `-${damage}`, color: '#ff0000' });
                checkPlayerDeath(closest, boss.name);
            }
        }
        
        // Players attacking bosses
        COMBAT.runBossAttacks(bossId, boss, now);
    });

    // Mounts come off when a player takes damage. Damage is applied in a dozen
    // places across combat.js, bosses.js and here, so instead of instrumenting
    // every site this compares each player's HP against the snapshot taken on
    // the previous tick. That catches every source, including boss abilities
    // and damage-over-time, without coupling the modules.
    players.forEach(player => {
        const previous = player.hpSnapshot;
        player.hpSnapshot = player.hp;
        if (player.isMounted && typeof previous === 'number' && player.hp < previous) {
            dismountPlayer(player, 'You were struck and lost your mount!');
        }
    });
    } catch(e) { console.error("Tick error:", e); }
}, 100);

function checkPlayerDeath(player, killerName = 'Unknown') {
    if (player.hp <= 0) {
        broadcast({ action: 'log', message: `☠️ ${player.charName} was slain by ${killerName}!` });
        
        // A skulled player loses everything. The flag is only relevant at the
        // moment of death, so it is cleared here rather than left to run down
        // the timer.
        const wasSkulled = hasActiveSkull(player);
        const dropRatio = wasSkulled ? SKULL_DROP_RATIO : NORMAL_DROP_RATIO;
        const droppedGold = Math.floor(player.gold * dropRatio);
        player.gold -= droppedGold;
        if (wasSkulled) {
            clearSkull(player);
            sendTo(player, { action: 'log', message: '💀 Your white skull has been consumed by your death.' });
        }
        
        const req = player.level * 100;
        const xpPenalty = Math.floor(req * 0.1);
        player.xp -= xpPenalty;
        if (player.xp < 0 && player.level > 1) {
            player.level--;
            player.xp = (player.level * 100) + player.xp;
        } else if (player.xp < 0) {
            player.xp = 0;
        }

        const cid = "corpse_" + corpseIdCounter++;
        // The corpse stays where the player fell, on the floor they fell on.
        const diedOn = MAP.normalizeZ(player.z);
        corpses.set(cid, { id: cid, x: player.x, y: player.y, z: diedOn, gold: droppedGold, ownerName: player.charName, expiresAt: Date.now() + CFG.CORPSE_TTL_MS });
        broadcastToFloor(diedOn, { action: 'corpse_spawn', corpse: corpses.get(cid) });

        player.hp = player.maxHp; player.mana = player.maxMana; 
        player.poisonStacks = 0; player.bleedStacks = 0; player.stunUntil = 0;
        player.x = 320; player.y = 320; player.targetId = null;
        // Respawn is to the surface, so the floor has to change with it. Without
        // this a player who died below ground keeps z = -1 while standing at the
        // surface spawn point, which is a position that does not exist on that
        // floor -- and the client, which trusts this force_position, draws them
        // inside the dungeon terrain.
        player.z = CFG.Z_SURFACE;
        sendTo(player, { action: 'force_position', x: 320, y: 320, z: CFG.Z_SURFACE });

        // And the client has to be told to change world. force_position alone
        // moves the sprite and nothing else, so dying underground left the
        // client holding the dungeon's terrain, its mobs and its ground loot
        // while the server had the character on the surface -- a full desync,
        // reached by doing the most ordinary thing in the game. This is the same
        // path a traversal takes, which is why both go through it.
        if (diedOn !== CFG.Z_SURFACE) {
            syncFloorRoster(player);
        }
    }
}

let shuttingDown = false;
async function shutdown(reason = 'requested') {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] Shutting down (${reason}); draining state...`);

    // Stop producing new world mutations before taking the final snapshot.
    serverIntervals.forEach(handle => clearInterval(handle));
    serverIntervals.clear();
    players.forEach(player => sendTo(player, { action: 'server_shutdown' }));

    const finalPlayers = Array.from(players.values());
    let flushFailed = false;
    try {
        await Promise.all(finalPlayers.map(player => DB.savePlayer(player.charName, serializePlayer(player))));
        await DB.flush();
    } catch (error) {
        flushFailed = true;
        console.error('[server] Persistence flush failed during shutdown:', error);
    }

    // Close the sockets first. A close handler calls persistPlayer, and
    // process.exit below would otherwise abandon those in-flight writes. With
    // SQLite each save is a single atomic statement, so an abandoned write
    // cannot leave a half-written row either way.
    players.forEach(player => {
        try { player.ws.close(1012, 'Server shutting down'); } catch (error) {}
    });
    // Let the close handlers run, then drain whatever they queued.
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
        await DB.flush();
    } catch (error) {
        flushFailed = true;
        console.error('[server] Final persistence flush failed:', error);
    }

    await new Promise(resolve => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        try { wss.close(done); } catch (error) { done(); }
        setTimeout(done, 1000);
    });

    await new Promise(resolve => {
        try { server.close(() => resolve()); } catch (error) { resolve(); }
    });

    // Close the database last, once nothing can write again. flush() only
    // waits for queued writes; it does not checkpoint, so without this the
    // write-ahead log is never folded back into the main file and is left
    // sitting on disk indefinitely.
    let closeFailed = false;
    try {
        if (typeof DB.close === 'function') {
            await DB.close();
        }
    } catch (error) {
        closeFailed = true;
        console.error('[server] Database close/checkpoint failed:', error.message);
    }

    if (!flushFailed && !closeFailed) console.log('[server] State flush complete; shutdown finished cleanly.');
    process.exit(flushFailed || closeFailed ? 1 : 0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('message', message => {
    if (message && message.action === 'shutdown') shutdown('IPC');
});
if (process.stdin && !process.stdin.destroyed) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        if (String(chunk).trim().toUpperCase() === 'SHUTDOWN') shutdown('stdin');
    });
}

server.listen(CFG.PORT, CFG.HOST, () => {
    console.log(`🚀 Ultimate Server on ${CFG.HOST}:${CFG.PORT} | MAP: ${CFG.MAP_WIDTH}x${CFG.MAP_HEIGHT}`);
    console.log(`🌐 Play the game by opening http://localhost:${CFG.PORT}/ in your browser!`);
});
