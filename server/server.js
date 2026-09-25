const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const CFG = require('./config');
const { isWalkable, obstacleData } = require('./map');
const { mobs, spawnMobPack, moveMobToward, mobAttack, inSafeZone } = require('./mobs');
const { chests, spawnChest } = require('./chests');
const { npcs } = require('./npcs');
const Q = require('./quests');
const ITEMS = require('./items');
const DB = require('./db_firebase');
const AUTH = require('./auth');
const { bosses, spawnBoss, bossAI, triggerBossAoe, BOSS_TYPES } = require('./bosses');
const PARTY = require('./party');
const TRADE = require('./trade');
const SC = require('./subclasses');
const TEST_MODE = process.env.TIBIA_TEST_MODE === 'true';

const SHOP_INVENTORY = {
    'Health Potion': { price: 20 },
    'Mana Potion': { price: 30 },
    'Greater Health Potion': { price: 80 },
    'Greater Mana Potion': { price: 100 },
    'Iron Sword': { price: 150 },
    'Steel Longsword': { price: 400 },
    'Elven Bow': { price: 350 },
    'Holy Staff': { price: 300 },
    'Leather Tunic': { price: 100 },
    'Chain Mail': { price: 250 },
    'Leather Helmet': { price: 60 },
    'Iron Helmet': { price: 150 },
    'Leather Boots': { price: 80 },
    'Iron Shield': { price: 200 },
    'Leather Legs': { price: 90 }
};

const server = http.createServer((req, res) => {
    const securityHeaders = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
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

let isDay = true;
scheduleServerInterval(() => {
    isDay = !isDay;
    broadcast({ action: 'log', message: isDay ? '☀️ The sun rises...' : '🌙 Night falls. Monsters are stronger and drop more loot!' });
    broadcast({ action: 'time_sync', isDay });
}, 60000); 

const MAX_SOCKET_BUFFER_BYTES = 1024 * 1024;

function broadcast(dataObj) {
    const msg = JSON.stringify(dataObj);
    players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN && p.ws.bufferedAmount <= MAX_SOCKET_BUFFER_BYTES) {
            p.ws.send(msg);
        }
    });
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
function sendTradeSync(trade, playerId, action = 'trade_sync') {
    const snapshot = TRADE.getTradeSnapshot(trade, playerId);
    if (!snapshot) return;
    sendTo(players.get(playerId), { action, tradeId: snapshot.tradeId, ...snapshot, trade: snapshot });
}
function sendTradeSyncAll(trade, action = 'trade_sync') {
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
    const separated = !p1 || !p2 || dist(p1.x, p1.y, p2.x, p2.y) > TRADE.TRADE_MAX_DISTANCE;
    if (!separated) return false;
    [trade.player1Id, trade.player2Id].forEach(id => {
        const participant = players.get(id);
        if (participant) sendTo(participant, { action: 'trade_close', tradeId: trade.id });
    });
    TRADE.cancelTrade(trade.id);
    return true;
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
        quests: p.quests,
        equipment: { ...p.equipment },
        maxHp: p.maxHp,
        maxMana: p.maxMana
    };
}
function persistPlayer(p) {
    p.persistenceDirty = true;
    return DB.savePlayer(p.charName, serializePlayer(p))
        .then(() => { p.persistenceDirty = false; })
        .catch(error => {
            console.error(`[persistence] Failed to save ${p.charName}; will retry:`, error.message);
        });
}
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
function normalizePlayerData(raw) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const safeInteger = (value, fallback, minimum = 0) =>
        Number.isSafeInteger(value) && value >= minimum ? value : fallback;
    const validClass = ['warrior', 'mage', 'ranger', 'healer'].includes(data.classType)
        ? data.classType
        : 'warrior';
    const rawQuests = data.quests && typeof data.quests === 'object' ? data.quests : {};
    const quests = {
        active: rawQuests.active && typeof rawQuests.active === 'object' && !Array.isArray(rawQuests.active)
            ? rawQuests.active
            : {},
        completed: Array.isArray(rawQuests.completed)
            ? rawQuests.completed.filter(id => typeof id === 'string')
            : []
    };
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
        equipment,
        maxHp: safeInteger(data.maxHp, 100, 1),
        maxMana: safeInteger(data.maxMana, 50, 1)
    };
}
function isInBounds(x, y) { return x >= 0 && y >= 0 && x < CFG.MAP_WIDTH && y < CFG.MAP_HEIGHT; }
function dist(x1, y1, x2, y2) { return Math.abs(x1 - x2) + Math.abs(y1 - y2); }

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

function getSubclassModifiers(player) {
    if (!player || !player.subclass) return {};
    const data = SC.getSubclassData(player.subclass);
    return data && data.statModifiers ? data.statModifiers : {};
}

function applyCombatModifiers(player, baseAmount, type = 'generic') {
    const modifiers = getSubclassModifiers(player);
    let multiplier = Number(modifiers.damageMulti) || 1;
    if (type === 'fire') multiplier *= Number(modifiers.fireDamageMulti) || 1;
    if (type === 'heal') multiplier *= Number(modifiers.healMulti) || 1;
    if (player && player.maxHp > 0 && player.hp / player.maxHp < 0.3) {
        multiplier *= Number(modifiers.lowHpDamageMulti) || 1;
    }
    return Math.max(1, Math.floor(baseAmount * multiplier));
}

function getAttackRange(player, baseRange) {
    const modifiers = getSubclassModifiers(player);
    return Math.floor(baseRange * (Number(modifiers.rangeMulti) || 1));
}

function getAttackCooldown(player, baseCooldown) {
    const modifiers = getSubclassModifiers(player);
    return Math.max(100, Math.floor(baseCooldown / (Number(modifiers.attackSpeedMulti) || 1)));
}

function applyLifesteal(player, damage) {
    const lifesteal = Number(getSubclassModifiers(player).lifesteal) || 0;
    if (lifesteal > 0) player.hp = Math.min(player.maxHp, player.hp + Math.floor(damage * lifesteal));
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
        broadcast({ action: 'fct', x: player.x, y: player.y, text: 'LEVEL UP!', color: '#ffcc00' });
    }
}

for(let i=0; i<15; i++) spawnMobPack(broadcast, 3);
for(let i=0; i<CFG.MAX_CHESTS; i++) spawnChest(broadcast);
Q.spawnGatheringNodes(broadcast);
scheduleServerInterval(() => { if (chests.size < CFG.MAX_CHESTS) spawnChest(broadcast); }, CFG.CHEST_SPAWN_INTERVAL);

// Spawn all bosses
Object.keys(BOSS_TYPES).forEach(type => spawnBoss(type, broadcast));

function syncTrade(tradeId, action = 'trade_sync') {
    const trade = TRADE.activeTrades.get(tradeId);
    if (!trade) return;
    sendTradeSyncAll(trade, action);
}

function killMob(player, target) {
    // Multiple attackers can observe the same lethal hit in one tick. Only
    // the first observer is allowed to grant rewards or update the world.
    if (!mobs.has(target.id) || target.hp > 0) return;
    player.gold += CFG.MOB_KILL_GOLD;
    const partyShares = PARTY.shareXp(PARTY.getParty(player.id), target.xpReward, player, players);
    const xpRecipients = partyShares.length > 0
        ? partyShares
        : [{ member: player, xp: target.xpReward }];
    const mobName = target.name.replace('Elite ', '');
    xpRecipients.forEach(({ member, xp }) => {
        addXp(member, xp);
        const updates = Q.onMobKilled(member.quests, mobName);
        if (updates.length > 0) {
            updates.forEach(update => sendTo(member, { action: 'log', message: `📜 [QUEST] ${update.questName}: ${update.objective}` }));
            sendQuestJournal(member);
        }
    });
    broadcast({ action: 'fct', x: target.x+16, y: target.y, text: `+${target.xpReward} XP`, color: '#ffcc00' });
    
    const loot = ITEMS.lootTable[target.type];
    if (loot) {
        loot.forEach(item => {
            let chance = item.chance;
            if (!isDay) chance *= 1.5; 
            if (Math.random() < chance) {
                player.inventory.push(item.name);
                broadcast({ action: 'fct', x: target.x+16, y: target.y-20, text: `+${item.name}`, color: '#ffffff' });
            }
        });
    }

    mobs.delete(target.id);
    broadcast({ action: 'mob_update', id: target.id, alive: false });
    if (player.targetId === target.id) player.targetId = null;
    
    setTimeout(() => spawnMobPack(broadcast, Math.floor(Math.random() * 2) + 1), 5000);
}

function sendQuestJournal(player) {
    const data = { quests: [], completed_count: player.quests.completed.length };
    Object.values(player.quests.active).forEach(q => {
        data.quests.push({
            id: q.id, name: q.name,
            objectives: q.objectives.map(o => ({
                text: o.type === 'reach_tile' ? o.label : o.target || o.item,
                progress: o.type === 'reach_tile' ? '' : `${o.current}/${o.required}`,
                done: o.type === 'reach_tile' ? o.done : o.current >= o.required
            }))
        });
    });
    sendTo(player, { action: 'quest_journal', ...data });
}

wss.on('connection', (ws) => {
    const playerId = 'p_' + Math.random().toString(36).substr(2, 6);
    
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
                    x: 320, y: 320,
                    hp: pData.maxHp || 100, maxHp: pData.maxHp || 100, 
                    mana: pData.maxMana || 50, maxMana: pData.maxMana || 50, 
                    gold: pData.gold || 0,
                    level: pData.level || 1, xp: pData.xp || 0, nextXp: pData.nextXp || CFG.XP_BASE,
                    classType: pData.classType || 'warrior',
                    subclass: pData.subclass || null,
                    inventory: pData.inventory || [],
                    quests: pData.quests || Q.initPlayerQuests(),
                    equipment: pData.equipment || { weapon: null, shield: null, helmet: null, armor: null, legs: null, boots: null, amulet: null },
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
                sendTo(player, { action: 'time_sync', isDay });
                sendTo(player, { action: 'log', message: `Welcome ${charName} (${player.classType}). Warmode: ${player.warmode?'ON ⚔️':'OFF'}` });
                sendQuestJournal(player);
                
                mobs.forEach((mob, id) => sendTo(player, { action: 'mob_update', id, type: mob.type, name: mob.name, x: mob.x, y: mob.y, hp: mob.hp, maxHp: mob.maxHp, alive: true, isElite: mob.isElite }));
                bosses.forEach((boss, id) => sendTo(player, { action: 'mob_update', id, type: boss.type, name: boss.name, x: boss.x, y: boss.y, hp: boss.hp, maxHp: boss.maxHp, alive: true, isElite: false, isBoss: true }));
                chests.forEach((c, id) => sendTo(player, { action: 'chest_update', id, x: c.x, y: c.y, active: true }));
                npcs.forEach((npc, id) => sendTo(player, { action: 'npc_sync', id, name: npc.name, x: npc.x, y: npc.y }));
                Q.gatheringNodes.forEach((node, id) => { if (node.active) sendTo(player, { action: 'node_sync', id, name: node.name, x: node.x, y: node.y, color: node.color, symbol: node.symbol }); });
                sendTo(player, { action: 'map_data', obstacles: obstacleData });
                
                broadcast({ action: 'player_update', id: playerId, name: charName, x: player.x, y: player.y, classType: player.classType, warmode: player.warmode });
                return;
            }

            const player = players.get(playerId);
            if (!player) return;
            if (!data || typeof data !== 'object' || typeof data.action !== 'string') {
                sendProtocolError(player, 'Invalid message.');
                return;
            }
            const now = Date.now();

            // Explicit test-only fixtures keep acceptance tests deterministic
            // without exposing progression or inventory mutations in normal
            // production servers.
            if (TEST_MODE && data.action === 'attack_boss') {
                const boss = Array.from(bosses.values()).find(candidate =>
                    candidate.id === data.bossId || candidate.type === data.bossId ||
                    (typeof data.bossId === 'string' && candidate.id.startsWith(data.bossId))
                );
                if (boss) player.targetId = boss.id;
                return;
            }
            if (TEST_MODE && data.action === 'trigger_boss_aoe') {
                const spellId = triggerBossAoe(data.bossType || 'spider_queen', players, broadcast, player);
                if (!spellId) sendProtocolError(player, 'Boss not found.');
                return;
            }
            if (TEST_MODE && data.action === 'test_grant_xp') {
                const amount = Number(data.amount);
                if (Number.isFinite(amount) && amount > 0) addXp(player, Math.floor(amount));
                return;
            }
            if (TEST_MODE && data.action === 'test_grant_item') {
                const item = typeof data.item === 'string' ? data.item.slice(0, 100) : '';
                if (item) player.inventory.push(item);
                sendTo(player, { action: 'status', hp: player.hp, maxHp: player.maxHp, mana: player.mana, maxMana: player.maxMana, level: player.level, xp: player.xp, nextXp: player.nextXp, gold: player.gold, inventory: player.inventory, equipment: player.equipment, classType: player.classType, subclass: player.subclass, speedBonus: 0 });
                return;
            }
            if (TEST_MODE && data.action === 'test_grant_gold') {
                const amount = Number(data.amount);
                if (Number.isSafeInteger(amount) && amount >= 0) player.gold = amount;
                sendTo(player, { action: 'status', hp: player.hp, maxHp: player.maxHp, mana: player.mana, maxMana: player.maxMana, level: player.level, xp: player.xp, nextXp: player.nextXp, gold: player.gold, inventory: player.inventory, equipment: player.equipment, classType: player.classType, subclass: player.subclass, speedBonus: 0 });
                return;
            }

            if (data.action === 'chat') {
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

            // --- PARTY ACTIONS ---
            if (data.action === 'party_create') {
                const existingParty = PARTY.getParty(playerId);
                const pid = existingParty ? existingParty.id : PARTY.createParty(playerId);
                sendTo(player, { action: 'log', message: `🎉 Party created! ID: ${pid}` });
                sendPartySync(PARTY.getParty(playerId));
            }
            if (data.action === 'party_invite') {
                const targetPlayer = findPlayerByName(data.targetName || data.targetPlayer);
                if (!targetPlayer) {
                    sendProtocolError(player, 'Player not found.');
                } else {
                    const party = PARTY.getParty(playerId);
                    if (!party) {
                        sendProtocolError(player, 'Create a party first.');
                    } else {
                        const result = PARTY.inviteToParty(party.id, playerId, targetPlayer.id, players);
                        if (!result.success) {
                            sendProtocolError(player, result.message);
                        } else {
                            const invitePacket = {
                                action: 'party_invited',
                                inviter: player.charName,
                                from: player.charName,
                                fromPlayer: player.id,
                                partyId: party.id
                            };
                            sendTo(targetPlayer, invitePacket);
                            // Compatibility packet for the original browser.
                            sendTo(targetPlayer, { ...invitePacket, action: 'party_invite' });
                            sendTo(player, { action: 'log', message: `📨 Invited ${targetPlayer.charName} to party.` });
                        }
                    }
                }
            }
            if (data.action === 'party_accept') {
                const result = PARTY.acceptInvite(playerId, data.partyId, players);
                if (!result.success) {
                    sendProtocolError(player, result.message);
                } else {
                    result.party.members.forEach(memberId => {
                        const member = players.get(memberId);
                        if (member) sendTo(member, { action: 'log', message: `🎉 ${player.charName} joined the party!` });
                    });
                    sendPartySync(result.party);
                }
            }
            if (data.action === 'party_decline') {
                PARTY.declineInvite(playerId, data.partyId);
            }
            if (data.action === 'party_leave') {
                const result = PARTY.leaveParty(playerId);
                if (result.success) {
                    sendPartySync(result.party);
                    sendTo(player, { action: 'party_sync', id: null, leader: null, members: [], party: null });
                    sendTo(player, { action: 'log', message: '👋 You left the party.' });
                }
            }

            // --- TRADE ACTIONS ---
            if (data.action === 'trade_request') {
                const targetPlayer = findPlayerByName(data.targetName || data.targetPlayer);
                if (!targetPlayer) {
                    sendProtocolError(player, 'Player not found.');
                } else if (dist(player.x, player.y, targetPlayer.x, targetPlayer.y) > TRADE.TRADE_MAX_DISTANCE) {
                    sendProtocolError(player, 'Too far to trade.');
                } else {
                    const result = TRADE.createTradeRequest(playerId, targetPlayer.id);
                    if (!result.success) {
                        sendProtocolError(player, result.message);
                    } else {
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
                    }
                }
            }
            if (data.action === 'trade_accept') {
                const fromReference = data.fromPlayer || data.from || data.fromName;
                const fromPlayer = findPlayerByName(fromReference) || (players.has(fromReference) ? players.get(fromReference) : null);
                const result = TRADE.acceptTradeRequest(
                    playerId,
                    data.requestId || data.tradeRequestId,
                    fromPlayer ? fromPlayer.id : fromReference
                );
                if (!result.success) {
                    sendProtocolError(player, result.message);
                } else {
                    const requester = players.get(result.trade.player1Id);
                    const target = players.get(result.trade.player2Id);
                    if (!requester || !target || dist(requester.x, requester.y, target.x, target.y) > TRADE.TRADE_MAX_DISTANCE) {
                        TRADE.cancelTrade(result.tradeId);
                        sendProtocolError(player, 'Players are too far apart to trade.');
                    } else {
                        sendTo(requester, { action: 'trade_open', tradeId: result.tradeId, partnerName: target.charName });
                        sendTo(target, { action: 'trade_open', tradeId: result.tradeId, partnerName: requester.charName });
                        syncTrade(result.tradeId, 'trade_update');
                    }
                }
            }
            if (data.action === 'trade_decline') {
                const fromReference = data.fromPlayer || data.from;
                const fromPlayer = findPlayerByName(fromReference) || (players.has(fromReference) ? players.get(fromReference) : null);
                TRADE.declineTradeRequest(playerId, data.requestId, fromPlayer ? fromPlayer.id : fromReference);
            }
            if (data.action === 'trade_add_item' || data.action === 'trade_offer') {
                const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
                const trade = TRADE.activeTrades.get(tradeId);
                if (!trade) {
                    sendProtocolError(player, 'Trade not found.');
                } else {
                    const items = data.action === 'trade_offer'
                        ? (Array.isArray(data.items) ? data.items : [])
                        : (data.item ? [data.item] : []);
                    const gold = data.action === 'trade_offer' ? data.gold : undefined;
                    const result = TRADE.stageTradeOffer(tradeId, playerId, items, gold, players);
                    if (!result.success) {
                        sendProtocolError(player, result.message);
                    } else {
                        syncTrade(tradeId, 'trade_update');
                    }
                }
            }
            if (data.action === 'trade_remove_item') {
                const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
                const result = TRADE.removeItemFromTrade(tradeId, playerId, data.item);
                if (!result.success) sendProtocolError(player, result.message);
                else syncTrade(tradeId, 'trade_update');
            }
            if (data.action === 'trade_set_gold') {
                const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
                const result = TRADE.setTradeGold(tradeId, playerId, data.amount);
                if (!result.success) sendProtocolError(player, result.message);
                else syncTrade(tradeId, 'trade_update');
            }
            if (data.action === 'trade_lock') {
                const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
                const result = TRADE.lockTrade(tradeId, playerId);
                if (!result.success) {
                    sendProtocolError(player, result.message);
                } else {
                    syncTrade(tradeId, 'trade_update');
                    if (result.bothLocked) sendTradeSyncAll(TRADE.activeTrades.get(tradeId), 'trade_locked');
                }
            }
            if (data.action === 'trade_confirm') {
                const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
                const tradeBeforeExecution = TRADE.activeTrades.get(tradeId);
                const result = TRADE.confirmTrade(tradeId, playerId);
                if (!result.success) {
                    sendProtocolError(player, result.message);
                } else if (result.bothConfirmed && tradeBeforeExecution) {
                    const execResult = TRADE.executeTrade(tradeId, players);
                    if (!execResult.success) {
                        [tradeBeforeExecution.player1Id, tradeBeforeExecution.player2Id].forEach(id => {
                            const participant = players.get(id);
                            if (participant) sendProtocolError(participant, execResult.message);
                        });
                    } else {
                        [execResult.player1Id, execResult.player2Id].forEach(id => {
                            const participant = players.get(id);
                            if (participant) {
                                sendTo(participant, { action: 'trade_complete', tradeId });
                                sendTo(participant, { action: 'log', message: '✅ Trade completed!' });
                                sendTo(participant, { action: 'trade_close' });
                                recalcPlayerStats(participant);
                                sendPlayerStatus(participant);
                            }
                        });
                    }
                } else {
                    syncTrade(tradeId, 'trade_update');
                }
            }
            if (data.action === 'trade_cancel') {
                const tradeId = data.tradeId || TRADE.getTradeIdForPlayer(playerId);
                const trade = TRADE.activeTrades.get(tradeId);
                if (trade && (trade.player1Id === playerId || trade.player2Id === playerId)) {
                    [trade.player1Id, trade.player2Id].forEach(id => {
                        const participant = players.get(id);
                        if (participant) sendTo(participant, { action: 'trade_close', tradeId });
                    });
                    TRADE.cancelTrade(tradeId);
                } else if (trade) {
                    sendProtocolError(player, 'You are not a participant in this trade.');
                }
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
                    broadcast({ action: 'fct', x: player.x, y: player.y, text: `EVOLVED: ${subclassId}!`, color: '#ff00ff' });
                    sendTo(player, { action: 'evolution_complete', subclass: subclassId });
                } else {
                    sendTo(player, { action: 'log', message: '❌ Invalid subclass selection.' });
                }
            }

            // --- HEALER SPECIAL: Heal Spell ---
            if (data.action === 'cast_heal') {
                if (player.classType !== 'healer' || player.mana < 25) return;
                let target = player;
                if (data.targetPlayerId) {
                    target = players.get(data.targetPlayerId);
                    if (!target || dist(player.x, player.y, target.x, target.y) > 192) {
                        sendProtocolError(player, 'Heal target is out of range.');
                        return;
                    }
                }
                player.mana -= 25;
                const healAmt = applyCombatModifiers(player, 40 + player.level * 2, 'heal');
                target.hp = Math.min(target.maxHp, target.hp + healAmt);
                broadcast({ action: 'fct', x: target.x+16, y: target.y, text: `+${healAmt} HP`, color: '#44ff44' });
            }

            if (data.action === 'accept_quest') {
                if (typeof data.quest_id !== 'string' || typeof data.npc_id !== 'string') {
                    sendProtocolError(player, 'Invalid quest request.');
                    return;
                }
                const questNpcId = data.npc_id;
                const questNpc = typeof questNpcId === 'string' ? npcs.get(questNpcId) : null;
                if (!questNpc || dist(player.x, player.y, questNpc.x, questNpc.y) > 96) {
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
                
                const moveSpeed = Math.max(80, CFG.PLAYER_MOVE_COOLDOWN_BASE - (player.level * 3) - speedBonus);

                if (now - (player.lastMoveTime || 0) >= moveSpeed && isOneStep && isWalkable(data.x, data.y)) {
                    player.lastMoveTime = now;
                    player.x = data.x; player.y = data.y;
                    abortSeparatedTrade(playerId);
                    
                    if (player.bleedStacks > 0) {
                        const bleedDmg = player.bleedStacks * CFG.BLEED_DMG_BASE * CFG.BLEED_MOVE_MULT;
                        player.hp -= bleedDmg;
                        broadcast({ action: 'fct', x: player.x+16, y: player.y, text: `-${bleedDmg}`, color: '#ff0000' });
                        checkPlayerDeath(player);
                    }

                    chests.forEach((chest, chestId) => {
                        if (player.x === chest.x && player.y === chest.y) {
                            player.gold += CFG.CHEST_GOLD_REWARD;
                            broadcast({ action: 'fct', x: player.x+16, y: player.y, text: `+${CFG.CHEST_GOLD_REWARD}G`, color: '#ffd700' });
                            chests.delete(chestId); broadcast({ action: 'chest_update', id: chestId, active: false });
                        }
                    });

                    Q.gatheringNodes.forEach((node, nodeId) => {
                        if (node.active && player.x === node.x && player.y === node.y) {
                            node.active = false;
                            player.inventory.push(node.name);
                            broadcast({ action: 'fct', x: player.x+16, y: player.y, text: `+${node.name}`, color: '#88ff88' });
                            broadcast({ action: 'node_remove', id: nodeId });
                            const updates = Q.onItemGathered(player.quests, node.name);
                            updates.forEach(u => sendTo(player, { action: 'log', message: `📜 [QUEST] ${u.questName}: ${u.objective}` }));
                            sendQuestJournal(player);
                            setTimeout(() => {
                                node.active = true;
                                broadcast({ action: 'node_sync', id: nodeId, name: node.name, x: node.x, y: node.y, color: node.color, symbol: node.symbol });
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
            
            if (data.action === 'attack') { player.targetId = data.target_id; }

            if (data.action === 'use_item') {
                const itemIndex = player.inventory.indexOf(data.item);
                if (itemIndex > -1) {
                    const itemDef = ITEMS.consumables[data.item];
                    if (itemDef) {
                        player.inventory.splice(itemIndex, 1);
                        if (itemDef.type === 'heal') {
                            player.hp = Math.min(player.maxHp, player.hp + itemDef.val);
                            broadcast({ action: 'fct', x: player.x+16, y: player.y, text: `+${itemDef.val} HP`, color: '#44ff44' });
                        }
                        if (itemDef.type === 'mana') {
                            player.mana = Math.min(player.maxMana, player.mana + itemDef.val);
                            broadcast({ action: 'fct', x: player.x+16, y: player.y, text: `+${itemDef.val} MP`, color: '#4488ff' });
                        }
                    }
                }
            }
            
            if (data.action === 'equip_item') {
                const itemIndex = player.inventory.indexOf(data.item);
                if (itemIndex > -1) {
                    let type = null;
                    if (ITEMS.weapons && ITEMS.weapons[data.item]) type = 'weapon';
                    else if (ITEMS.armor && ITEMS.armor[data.item]) type = 'armor';
                    else if (ITEMS.helmets && ITEMS.helmets[data.item]) type = 'helmet';
                    else if (ITEMS.legs && ITEMS.legs[data.item]) type = 'legs';
                    else if (ITEMS.boots && ITEMS.boots[data.item]) type = 'boots';
                    else if (ITEMS.shields && ITEMS.shields[data.item]) type = 'shield';
                    else if (ITEMS.amulets && ITEMS.amulets[data.item]) type = 'amulet';

                    if (type) {
                        player.inventory.splice(itemIndex, 1);
                        if (player.equipment[type]) player.inventory.push(player.equipment[type]);
                        player.equipment[type] = data.item;
                        sendTo(player, { action: 'log', message: `✨ Equipped ${data.item}` });
                        recalcPlayerStats(player);
                    }
                }
            }
            if (data.action === 'unequip_item') {
                const slot = data.slot;
                const validSlots = new Set(['weapon', 'shield', 'helmet', 'armor', 'legs', 'boots', 'amulet']);
                if (!validSlots.has(slot)) {
                    sendProtocolError(player, 'Invalid equipment slot.');
                } else if (player.equipment[slot]) {
                    player.inventory.push(player.equipment[slot]);
                    player.equipment[slot] = null;
                    recalcPlayerStats(player);
                }
            }
            
            // --- SHOP ACTIONS ---
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

            if (data.action === 'cast_purify') {
                if (player.mana >= CFG.PURIFY_MANA_COST) {
                    player.mana -= CFG.PURIFY_MANA_COST;
                    player.poisonStacks = 0; player.bleedStacks = 0;
                    broadcast({ action: 'fct', x: player.x+16, y: player.y, text: 'PURIFIED', color: '#4488ff' });
                }
            }

            if (data.action === 'cast_skill') {
                if (player.mana < CFG.SKILL_MANA_COST) return;
                player.mana -= CFG.SKILL_MANA_COST;
                if (player.classType === 'warrior') {
                    let mobsToKill = [];
                    mobs.forEach((mob, mid) => {
                        if (dist(player.x, player.y, mob.x, mob.y) <= CFG.MELEE_RANGE) {
                            const dmg = applyCombatModifiers(player, 25 + player.level * 3); mob.hp -= dmg; applyLifesteal(player, dmg);
                            broadcast({ action: 'fct', x: mob.x+16, y: mob.y, text: `-${dmg}`, color: '#ff8866' });
                            broadcast({ action: 'mob_update', id: mid, x: mob.x, y: mob.y, hp: mob.hp, maxHp: mob.maxHp, alive: true, isElite: mob.isElite, name: mob.name, type: mob.type });
                            if (mob.hp <= 0) mobsToKill.push(mob); 
                        }
                    });
                    mobsToKill.forEach(m => killMob(player, m));
                } else if (player.classType === 'mage' || player.classType === 'ranger') {
                    if (player.targetId && mobs.has(player.targetId)) {
                        const target = mobs.get(player.targetId);
                        if (dist(player.x, player.y, target.x, target.y) <= CFG.RANGED_RANGE) {
                            const dmg = applyCombatModifiers(player, 40 + player.level * 4, player.classType === 'mage' ? 'fire' : 'generic'); target.hp -= dmg; applyLifesteal(player, dmg);
                            broadcast({ action: 'fct', x: target.x+16, y: target.y, text: `-${dmg}`, color: '#ff8866' });
                            broadcast({ action: 'mob_update', id: target.id, x: target.x, y: target.y, hp: target.hp, maxHp: target.maxHp, alive: true, isElite: target.isElite, name: target.name, type: target.type });
                            if (target.hp <= 0) killMob(player, target);
                        } else player.mana += CFG.SKILL_MANA_COST;
                    } else player.mana += CFG.SKILL_MANA_COST;
                }
            }

            if (data.action === 'talk_npc') {
                const npc = npcs.get(data.npc_id);
                if (!npc || dist(player.x, player.y, npc.x, npc.y) > 96) return;
                
                if (data.npc_id === 'n_merchant') {
                    sendTo(player, { action: 'open_shop', inventory: SHOP_INVENTORY, gold: player.gold });
                    return;
                }
                
                let turnedIn = false;
                Object.keys(player.quests.active).forEach(qid => {
                    const questDef = Q.QUEST_DB[qid];
                    if (questDef && questDef.giver === data.npc_id && Q.checkQuestComplete(player.quests, qid)) {
                        const result = Q.completeQuest(player.quests, qid, player);
                        if (result) {
                            broadcast({ action: 'fct', x: player.x+16, y: player.y, text: `+${result.rewards.xp} XP`, color: '#ffcc00' });
                            addXp(player, result.rewards.xp); turnedIn = true;
                        }
                    }
                });
                if (!turnedIn) {
                    const available = Q.getAvailableQuests(player.quests, data.npc_id);
                    if (available.length > 0) {
                        sendTo(player, { action: 'npc_dialogue', npc_id: data.npc_id, npc_name: npc.name, quests: available });
                    } else {
                        sendTo(player, { action: 'log', message: `🗣️ ${npc.name}: "Greetings, traveler. I have no more tasks for you right now."` });
                    }
                }
                sendQuestJournal(player);
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
            broadcast({ action: 'player_left', id: playerId });
        }
    });
});

scheduleServerInterval(() => { 
    players.forEach(p => { 
        if (inSafeZone(p.x, p.y)) {
            if (p.hp < p.maxHp) { p.hp = Math.min(p.hp + CFG.SAFEZONE_HEAL_PER_SEC, p.maxHp); broadcast({ action: 'fct', x: p.x+16, y: p.y, text: '+HP', color: '#44ff44' }); }
        }
        p.mana = Math.min(p.mana + CFG.MANA_REGEN_PER_SEC, p.maxMana); 
        
        
        persistPlayer(p);
    }); 
}, 10000);

scheduleServerInterval(() => {
    const positions = [];
    players.forEach((p, pid) => positions.push({ id: pid, name: p.charName, x: p.x, y: p.y, classType: p.classType, warmode: p.warmode }));
    if (positions.length > 0) broadcast({ action: 'players_sync', players: positions });
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
    const now = Date.now();
    const damageMultiplier = isDay ? 1.0 : 1.2; 

    players.forEach((player, playerId) => {
        if (player.targetId) {
            if (players.has(player.targetId)) {
                const target = players.get(player.targetId);
                if (player.warmode && target.warmode && !inSafeZone(player.x, player.y) && !inSafeZone(target.x, target.y)) {
                    const d = dist(player.x, player.y, target.x, target.y);
                    const range = getAttackRange(player, (player.classType === 'mage' || player.classType === 'ranger') ? CFG.RANGED_RANGE : CFG.MELEE_RANGE);
                    if (d <= range && now - player.lastAttackTime >= getAttackCooldown(player, CFG.PLAYER_ATTACK_COOLDOWN)) {
                        player.lastAttackTime = now;
                        let damage = applyCombatModifiers(player, Math.floor(Math.random() * 15) + 5 + (player.level * 2)); 
                        if (player.equipment.weapon && ITEMS.weapons[player.equipment.weapon]) {
                            damage += ITEMS.weapons[player.equipment.weapon].bonus;
                        }
                        target.hp -= damage; applyLifesteal(player, damage);
                        broadcast({ action: 'fct', x: target.x+16, y: target.y, text: `-${damage}`, color: '#ff8800' });
                        checkPlayerDeath(target, player.charName);
                    }
                }
            } 
            else if (mobs.has(player.targetId)) {
                const target = mobs.get(player.targetId);
                const d = dist(player.x, player.y, target.x, target.y);
                const range = getAttackRange(player, (player.classType === 'mage' || player.classType === 'ranger') ? CFG.RANGED_RANGE : CFG.MELEE_RANGE);
                if (d <= range && now - player.lastAttackTime >= getAttackCooldown(player, CFG.PLAYER_ATTACK_COOLDOWN)) {
                    player.lastAttackTime = now;
                    let damage = applyCombatModifiers(player, Math.floor(Math.random() * 15) + 10 + (player.level * 2)); 
                    
                    if (player.equipment.weapon && ITEMS.weapons[player.equipment.weapon]) {
                        damage += ITEMS.weapons[player.equipment.weapon].bonus;
                    }
                    
                    target.hp -= damage; applyLifesteal(player, damage);
                    broadcast({ action: 'fct', x: target.x+16, y: target.y, text: `-${damage}`, color: '#ffffff' });
                    broadcast({ action: 'mob_update', id: player.targetId, x: target.x, y: target.y, hp: target.hp, maxHp: target.maxHp, alive: true, isElite: target.isElite, name: target.name, type: target.type });
                    if (target.hp <= 0) killMob(player, target);
                }
            }
        }
    });

    mobs.forEach((mob, mobId) => {
        let closest = null, minD = Infinity;
        players.forEach(p => { 
            if (p.hp > 0 && !inSafeZone(p.x, p.y)) {
                const d2 = dist(p.x, p.y, mob.x, mob.y); 
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
                broadcast({ action: 'fct', x: closest.x+16, y: closest.y, text: `-${result.damage}`, color: '#ff4444' });
                if (result.poisoned) broadcast({ action: 'fct', x: closest.x+16, y: closest.y-20, text: `POISON`, color: '#00ff00' });
                if (result.bled) broadcast({ action: 'fct', x: closest.x+16, y: closest.y-20, text: `BLEED`, color: '#ff4444' });
                if (result.stunned) broadcast({ action: 'fct', x: closest.x+16, y: closest.y-20, text: `STUN`, color: '#ff88ff' });
                checkPlayerDeath(closest, mob.name);
            }
        } else if (minD <= AGGRO_RANGE) { 
            if (moveMobToward(mob, closest.x, closest.y)) {
                broadcast({ action: 'mob_update', id: mobId, x: mob.x, y: mob.y, hp: mob.hp, maxHp: mob.maxHp, alive: true, isElite: mob.isElite, name: mob.name, type: mob.type });
            }
        }
    });

    players.forEach(p => {
        if (p.poisonStacks > 0 && now - p.lastPoisonTick >= CFG.POISON_TICK_INTERVAL) {
            p.lastPoisonTick = now; p.hp -= p.poisonStacks * CFG.POISON_DMG_PER_STACK;
            broadcast({ action: 'fct', x: p.x+16, y: p.y, text: `-${p.poisonStacks * CFG.POISON_DMG_PER_STACK}`, color: '#00ff00' });
            p.poisonStacks--; 
            checkPlayerDeath(p, 'Poison');
        }
        if (p.bleedStacks > 0 && now - p.lastBleedTick >= CFG.BLEED_TICK_INTERVAL) {
            p.lastBleedTick = now; p.hp -= p.bleedStacks * CFG.BLEED_DMG_BASE;
            broadcast({ action: 'fct', x: p.x+16, y: p.y, text: `-${p.bleedStacks * CFG.BLEED_DMG_BASE}`, color: '#ff4444' });
            p.bleedStacks--; 
            checkPlayerDeath(p, 'Bleeding');
        }
    });

    // Boss AI tick
    bosses.forEach((boss, bossId) => {
        bossAI(boss, players, broadcast, mobs);
        // Delayed boss abilities can lower HP outside the main combat branch;
        // normalize death state on the next authoritative tick.
        players.forEach(p => {
            if (p.hp <= 0) checkPlayerDeath(p, 'Boss ability');
        });
        
        // Boss attacks nearest player
        let closest = null, minD = Infinity;
        players.forEach(p => {
            if (p.hp > 0 && !inSafeZone(p.x, p.y)) {
                const d2 = dist(p.x, p.y, boss.x, boss.y);
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
                broadcast({ action: 'fct', x: closest.x+16, y: closest.y, text: `-${damage}`, color: '#ff0000' });
                checkPlayerDeath(closest, boss.name);
            }
        }
        
        // Players attacking bosses
        players.forEach(player => {
            if (player.targetId === bossId && boss.hp > 0 && bosses.has(bossId)) {
                const d = dist(player.x, player.y, boss.x, boss.y);
                const range = getAttackRange(player, (player.classType === 'mage' || player.classType === 'ranger' || player.classType === 'healer') ? CFG.RANGED_RANGE : CFG.MELEE_RANGE);
                if (d <= range && now - player.lastAttackTime >= getAttackCooldown(player, CFG.PLAYER_ATTACK_COOLDOWN)) {
                    player.lastAttackTime = now;
                    let damage = applyCombatModifiers(player, Math.floor(Math.random() * 15) + 10 + (player.level * 2));
                    if (player.equipment.weapon && ITEMS.weapons[player.equipment.weapon]) damage += ITEMS.weapons[player.equipment.weapon].bonus;
                    boss.hp -= damage; applyLifesteal(player, damage);
                    broadcast({ action: 'fct', x: boss.x+16, y: boss.y, text: `-${damage}`, color: '#ffffff' });
                    broadcast({ action: 'mob_update', id: bossId, x: boss.x, y: boss.y, hp: boss.hp, maxHp: boss.maxHp, alive: true, isBoss: true, name: boss.name, type: boss.type });
                    
                    if (boss.hp <= 0) {
                        // Boss killed!
                        broadcast({ action: 'log', message: `🏆 ${player.charName} has slain ${boss.name}!` });
                        broadcast({ action: 'fct', x: boss.x, y: boss.y, text: '💀 BOSS SLAIN!', color: '#ff00ff' });
                        
                        // Distribute loot
                        const loot = ITEMS.lootTable[boss.type];
                        if (loot) {
                            loot.forEach(item => {
                                if (Math.random() < item.chance) {
                                    player.inventory.push(item.name);
                                    broadcast({ action: 'fct', x: boss.x+16, y: boss.y-20, text: `+${item.name}`, color: '#ff00ff' });
                                }
                            });
                        }
                        addXp(player, boss.xpReward);
                        const bossQuestUpdates = Q.onMobKilled(player.quests, boss.name);
                         if (bossQuestUpdates.length > 0) {
                             bossQuestUpdates.forEach(update => sendTo(player, { action: 'log', message: `📜 [QUEST] ${update.questName}: ${update.objective}` }));
                             sendQuestJournal(player);
                         }
                         if (player.targetId === bossId) player.targetId = null;
                        
                        bosses.delete(bossId);
                        broadcast({ action: 'mob_update', id: bossId, alive: false });
                        
                        // Respawn boss after 60s
                        setTimeout(() => {
                            spawnBoss(boss.type, broadcast);
                        }, 60000);
                    }
                }
            }
        });
    });
}, 100);

function checkPlayerDeath(player, killerName = 'Unknown') {
    if (player.hp <= 0) {
        broadcast({ action: 'log', message: `☠️ ${player.charName} was slain by ${killerName}!` });
        player.hp = player.maxHp; player.mana = player.maxMana; 
        player.poisonStacks = 0; player.bleedStacks = 0; player.stunUntil = 0;
        player.gold = Math.floor(player.gold * (1 - CFG.DEATH_GOLD_PENALTY));
        player.x = 320; player.y = 320; player.targetId = null;
        sendTo(player, { action: 'force_position', x: 320, y: 320 });
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

    // Closing clients after the snapshot avoids close handlers overwriting the
    // final state with a partially updated object.
    players.forEach(player => {
        try { player.ws.close(1012, 'Server shutting down'); } catch (error) {}
    });

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
    if (!flushFailed) console.log('[server] State flush complete; shutdown finished cleanly.');
    process.exit(flushFailed ? 1 : 0);
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
