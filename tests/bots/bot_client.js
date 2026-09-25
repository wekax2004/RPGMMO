/**
 * tests/bots/bot_client.js
 * Native WebSocket Headless Bot Client for Tibia MMORPG
 *
 * Implements real network interaction, spatial movement with collision checking,
 * auto-targeting combat, party management, multi-channel chat, secure trade flows,
 * latency RTT profiling, and assertion waiters.
 */

const EventEmitter = require('events');

let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  WS = globalThis.WebSocket;
} else {
  try {
    WS = require('ws');
  } catch (e) {
    WS = require('../../server/node_modules/ws');
  }
}

class BotClient extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = Object.assign({
      serverUrl: 'ws://localhost:8080',
      name: 'Bot_' + Math.random().toString(36).substring(2, 8),
      classType: 'warrior', // 'warrior' | 'mage' | 'ranger'
      warmode: false,
      autoLogin: false,
      logMessages: false
    }, options);

    // Register a self-guarding internal error listener to prevent ERR_UNHANDLED_ERROR
    this.lastError = null;
    this.errorCount = 0;
    this.on('error', (err) => {
      this.lastError = err;
      this.errorCount++;
      if (this.options.logMessages) {
        console.error(`[BotClient ${this.charName}] Handled socket error:`, err?.message || err);
      }
    });

    // Identity & Session State
    this.id = null;
    this.charName = this.options.name;
    this.classType = this.options.classType;
    this.warmode = this.options.warmode;
    this.connected = false;
    this.loggedIn = false;

    // Spatial State
    this.x = 320;
    this.y = 320;
    this.tileSize = 32;
    this.mapWidth = 3200;
    this.mapHeight = 3200;
    this.obstacles = new Set(); // Set of "x,y" strings
    this.lastMoveTime = 0;
    this.moveIntervalId = null;

    // Stats & Vitals
    this.hp = 100;
    this.maxHp = 100;
    this.mana = 50;
    this.maxMana = 50;
    this.level = 1;
    this.xp = 0;
    this.nextXp = 100;
    this.gold = 0;
    this.inventory = [];
    this.equipment = { weapon: null, shield: null, helmet: null, armor: null, legs: null, boots: null, amulet: null };
    this.statusEffects = { poison: 0, bleed: 0, stun: false };

    // World & Entities Cache
    this.mobs = new Map(); // id -> mob object
    this.players = new Map(); // id -> player object
    this.chests = new Map(); // id -> { id, x, y, active }
    this.gatheringNodes = new Map(); // id -> { id, name, x, y, active }
    this.party = { leader: null, members: [] };
    this.activeQuests = {};
    this.lastNpcId = null;
    this.chatHistory = [];

    // Combat Loop
    this.combatIntervalId = null;
    this.targetId = null;

    // Performance & Metrics Profiling
    this.auditLog = [];
    this.rttSamples = [];
    this.tickIntervals = [];
    this.lastSyncTimestamp = 0;
    this.pendingMoveTimestamp = 0;

    this.ws = null;
  }

  /**
   * Safely normalizes and emits an error event without throwing ERR_UNHANDLED_ERROR.
   * @param {Error|ErrorEvent|string|object} err
   * @returns {Error} Normalized Error object
   */
  _emitError(err) {
    let normalizedError;
    if (err instanceof Error) {
      normalizedError = err;
    } else if (err && typeof err === 'object') {
      const msg = err.message || (err.error && err.error.message) || (err.type ? `WebSocket ${err.type} event` : JSON.stringify(err));
      normalizedError = new Error(`[BotClient ${this.charName}] ${msg}`);
      if (err.code) normalizedError.code = err.code;
    } else {
      normalizedError = new Error(`[BotClient ${this.charName}] ${String(err)}`);
    }

    this.lastError = normalizedError;

    if (this.listenerCount('error') > 0) {
      try {
        this.emit('error', normalizedError);
      } catch (listenerError) {
        if (this.options.logMessages) {
          console.error(`[BotClient ${this.charName}] Exception inside error listener:`, listenerError);
        }
      }
    }
    return normalizedError;
  }

  /**
   * Connects to the WebSocket server.
   * @param {string} url - Target WebSocket URL
   * @param {number} timeoutMs - Connection timeout in milliseconds
   * @returns {Promise<BotClient>}
   */
  connect(url = this.options.serverUrl, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (this.ws) {
            try { this.ws.close(); } catch (e) {}
          }
          const err = new Error(`[BotClient ${this.charName}] Connection timeout after ${timeoutMs}ms to ${url}`);
          this._emitError(err);
          reject(err);
        }
      }, timeoutMs);

      try {
        this.ws = new WS(url);
      } catch (err) {
        clearTimeout(timeout);
        const normErr = this._emitError(err);
        return reject(normErr);
      }

      this.ws.onopen = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.connected = true;
          this.emit('open');
          if (this.options.autoLogin) {
            this.login().then(() => resolve(this)).catch(reject);
          } else {
            resolve(this);
          }
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data.toString();
          const packet = JSON.parse(raw);
          this._handlePacket(packet);
        } catch (e) {
          this._emitError(new Error(`Failed to parse incoming WebSocket message: ${e.message}`));
        }
      };

      this.ws.onerror = (event) => {
        const normErr = this._emitError(event);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(normErr);
        }
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        this.loggedIn = false;
        this.stopRandomWalk();
        this.stopAutoCombat();
        this.emit('close', event);
      };
    });
  }

  /**
   * Handles incoming packet dispatching and internal state caching.
   * @private
   */
  _handlePacket(packet) {
    if (this.options.logMessages) {
      this.auditLog.push({ timestamp: Date.now(), direction: 'in', packet });
    }

    this.emit('packet', packet);
    if (packet && packet.action) {
      this.emit(`action:${packet.action}`, packet);
    }

    switch (packet.action) {
      case 'your_id':
        this.id = packet.id;
        this.charName = packet.name || this.charName;
        this.loggedIn = true;
        this.emit('login', { id: this.id, name: this.charName });
        break;

      case 'map_data':
        if (Array.isArray(packet.obstacles)) {
          this.obstacles = new Set(packet.obstacles.map(o => `${o.x},${o.y}`));
        }
        break;

      case 'players_sync': {
        const now = Date.now();
        if (this.lastSyncTimestamp > 0) {
          const interval = now - this.lastSyncTimestamp;
          this.tickIntervals.push(interval);
        }
        this.lastSyncTimestamp = now;

        if (Array.isArray(packet.players)) {
          packet.players.forEach(p => {
            if (p.id === this.id || p.name === this.charName) {
              this.x = p.x;
              this.y = p.y;
              if (this.pendingMoveTimestamp > 0) {
                const rtt = now - this.pendingMoveTimestamp;
                this.rttSamples.push(rtt);
                this.pendingMoveTimestamp = 0;
              }
            } else {
              this.players.set(p.id, p);
            }
          });
        }
        break;
      }

      case 'status':
        this.hp = packet.hp !== undefined ? packet.hp : this.hp;
        this.maxHp = packet.maxHp !== undefined ? packet.maxHp : this.maxHp;
        this.mana = packet.mana !== undefined ? packet.mana : this.mana;
        this.maxMana = packet.maxMana !== undefined ? packet.maxMana : this.maxMana;
        this.level = packet.level !== undefined ? packet.level : this.level;
        this.xp = packet.xp !== undefined ? packet.xp : this.xp;
        this.nextXp = packet.nextXp !== undefined ? packet.nextXp : this.nextXp;
        this.gold = packet.gold !== undefined ? packet.gold : this.gold;
        if (Array.isArray(packet.inventory)) this.inventory = packet.inventory;
        if (packet.equipment) this.equipment = packet.equipment;
        if (packet.classType) this.classType = packet.classType;
        this.statusEffects = {
          poison: packet.poison || 0,
          bleed: packet.bleed || 0,
          stun: !!packet.stun
        };
        this.emit('status', packet);
        break;

      case 'mob_update':
        if (packet.alive) {
          this.mobs.set(packet.id, packet);
        } else {
          this.mobs.delete(packet.id);
          if (this.targetId === packet.id) this.targetId = null;
        }
        break;

      case 'chat':
        this.chatHistory.push(packet);
        this.emit('chat', packet);
        break;

      case 'party_invited':
      case 'party_invite':
        this.emit('party_invited', packet);
        break;

      case 'party_sync':
        this.party = {
          leader: packet.leader,
          members: Array.isArray(packet.members) ? packet.members : []
        };
        this.emit('party_sync', packet);
        break;

      case 'chest_update':
        if (packet.active !== false) {
          this.chests.set(packet.id, { id: packet.id, x: packet.x, y: packet.y, active: true });
        } else {
          this.chests.delete(packet.id);
        }
        this.emit('chest_update', packet);
        break;

      case 'node_sync':
        this.gatheringNodes.set(packet.id, { id: packet.id, name: packet.name, x: packet.x, y: packet.y, active: true });
        this.emit('node_sync', packet);
        break;

      case 'node_remove':
        this.gatheringNodes.delete(packet.id);
        this.emit('node_remove', packet);
        break;

      case 'quest_journal':
        if (Array.isArray(packet.quests)) {
          this.activeQuests = {};
          packet.quests.forEach(q => { this.activeQuests[q.id] = q; });
        }
        this.emit('quest_journal', packet);
        break;

      case 'trade_requested':
      case 'trade_open':
      case 'trade_start':
      case 'trade_sync':
      case 'trade_update':
      case 'trade_locked':
      case 'trade_complete':
      case 'trade_close':
      case 'trade_cancelled':
      case 'aoe_warning':
      case 'aoe_impact':
      case 'subclass_promoted':
      case 'show_subclass_select':
      case 'evolution_complete':
      case 'npc_dialogue':
        this.emit(packet.action, packet);
        break;
    }
  }

  /**
   * Sends a JSON packet to the server.
   * @param {object} packet - JSON serializable packet
   */
  send(packet) {
    if (!this.ws || this.ws.readyState !== 1) { // 1 = OPEN
      const msg = `[BotClient ${this.charName}] Cannot send packet, WebSocket is not OPEN (readyState=${this.ws ? this.ws.readyState : 'null'})`;
      if (this.options.logMessages) console.warn(msg);
      throw new Error(msg);
    }
    if (this.options.logMessages) {
      this.auditLog.push({ timestamp: Date.now(), direction: 'out', packet });
    }
    try {
      this.ws.send(JSON.stringify(packet));
    } catch (sendErr) {
      this._emitError(sendErr);
      throw sendErr;
    }
  }

  /**
   * Logs into the game with name and class.
   * @param {string} name
   * @param {string} classType
   * @param {boolean} warmode
   * @param {number} timeoutMs
   * @returns {Promise<object>}
   */
  login(name = this.charName, classType = this.classType, warmode = this.warmode, timeoutMs = 5000) {
    this.charName = name;
    this.classType = classType;
    this.warmode = warmode;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('login', onLogin);
        reject(new Error(`[BotClient ${this.charName}] Login timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const onLogin = (info) => {
        clearTimeout(timer);
        resolve(info);
      };

      this.once('login', onLogin);

      try {
        this.send({
          action: 'login',
          name: this.charName,
          class: this.classType,
          warmode: this.warmode
        });
      } catch (err) {
        clearTimeout(timer);
        this.off('login', onLogin);
        reject(err);
      }
    });
  }

  /**
   * Disconnects cleanly from the server.
   * @returns {Promise<void>}
   */
  disconnect() {
    this.stopRandomWalk();
    this.stopAutoCombat();

    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === 3) { // CLOSED
        this.connected = false;
        this.loggedIn = false;
        return resolve();
      }

      this.ws.onclose = () => {
        this.connected = false;
        this.loggedIn = false;
        resolve();
      };

      try {
        this.ws.close();
      } catch (e) {
        resolve();
      }
    });
  }

  // --- Spatial Movement & Navigation ---

  /**
   * Checks whether target coordinates are within map bounds and free of obstacles.
   * @param {number} x
   * @param {number} y
   * @returns {boolean}
   */
  isWalkable(x, y) {
    if (x < 0 || y < 0 || x >= this.mapWidth || y >= this.mapHeight) return false;
    if (this.obstacles.has(`${x},${y}`)) return false;
    return true;
  }

  /**
   * Returns list of walkable adjacent tiles (up, down, left, right).
   * @returns {Array<{x: number, y: number, dir: string}>}
   */
  getValidAdjacentTiles() {
    const moves = [
      { x: this.x, y: this.y - this.tileSize, dir: 'up' },
      { x: this.x, y: this.y + this.tileSize, dir: 'down' },
      { x: this.x - this.tileSize, y: this.y, dir: 'left' },
      { x: this.x + this.tileSize, y: this.y, dir: 'right' }
    ];
    return moves.filter(m => this.isWalkable(m.x, m.y));
  }

  /**
   * Steps one tile in specified direction.
   * @param {string} direction - 'up' | 'down' | 'left' | 'right'
   * @returns {boolean} Whether step was initiated
   */
  step(direction) {
    let targetX = this.x;
    let targetY = this.y;

    if (direction === 'up') targetY -= this.tileSize;
    else if (direction === 'down') targetY += this.tileSize;
    else if (direction === 'left') targetX -= this.tileSize;
    else if (direction === 'right') targetX += this.tileSize;

    if (!this.isWalkable(targetX, targetY)) return false;

    this.pendingMoveTimestamp = Date.now();
    this.lastMoveTime = this.pendingMoveTimestamp;
    this.send({ action: 'move', x: targetX, y: targetY });
    return true;
  }

  /**
   * Steps to a randomly chosen walkable adjacent tile.
   * @returns {boolean}
   */
  stepRandomWalkable() {
    const valid = this.getValidAdjacentTiles();
    if (valid.length === 0) return false;
    const chosen = valid[Math.floor(Math.random() * valid.length)];
    this.pendingMoveTimestamp = Date.now();
    this.lastMoveTime = this.pendingMoveTimestamp;
    this.send({ action: 'move', x: chosen.x, y: chosen.y });
    return true;
  }

  /**
   * Manhattan distance to target coordinates.
   * @param {number} targetX
   * @param {number} targetY
   * @returns {number}
   */
  distanceTo(targetX, targetY) {
    return Math.abs(this.x - targetX) + Math.abs(this.y - targetY);
  }

  /**
   * Steps one tile toward target coordinates, avoiding obstacles.
   * @param {number} targetX
   * @param {number} targetY
   * @returns {boolean} Whether movement was initiated
   */
  stepToward(targetX, targetY) {
    const dx = targetX - this.x;
    const dy = targetY - this.y;
    if (dx === 0 && dy === 0) return true;

    const tryHorizontal = Math.abs(dx) >= Math.abs(dy);
    const candidateDirs = [];

    if (tryHorizontal) {
      if (dx > 0) candidateDirs.push('right'); else if (dx < 0) candidateDirs.push('left');
      if (dy > 0) candidateDirs.push('down'); else if (dy < 0) candidateDirs.push('up');
    } else {
      if (dy > 0) candidateDirs.push('down'); else if (dy < 0) candidateDirs.push('up');
      if (dx > 0) candidateDirs.push('right'); else if (dx < 0) candidateDirs.push('left');
    }

    for (const dir of candidateDirs) {
      if (this.step(dir)) return true;
    }
    return this.stepRandomWalkable();
  }

  /**
   * Starts continuous autonomous random walk loop.
   * @param {number} stepIntervalMs - Time between steps (default 350ms)
   */
  startRandomWalk(stepIntervalMs = 350) {
    this.stopRandomWalk();
    this.moveIntervalId = setInterval(() => {
      if (this.connected && this.loggedIn) {
        this.stepRandomWalkable();
      }
    }, stepIntervalMs);
  }

  /**
   * Stops continuous random walk loop.
   */
  stopRandomWalk() {
    if (this.moveIntervalId) {
      clearInterval(this.moveIntervalId);
      this.moveIntervalId = null;
    }
  }

  // --- Combat & Skills ---

  /**
   * Targets and attacks an entity by id.
   * @param {string} targetId
   */
  attack(targetId) {
    this.targetId = targetId;
    this.send({ action: 'attack', target_id: targetId });
  }

  /**
   * Attacks the nearest alive monster within maxRange.
   * @param {number} maxRange - Manhattan distance limit (default 160)
   * @returns {string|null} Target mob id or null
   */
  attackNearestMob(maxRange = 160) {
    let closestId = null;
    let minDistance = Infinity;

    for (const [id, mob] of this.mobs.entries()) {
      if (!mob.alive || mob.hp <= 0) continue;
      const d = Math.abs(this.x - mob.x) + Math.abs(this.y - mob.y);
      if (d <= maxRange && d < minDistance) {
        minDistance = d;
        closestId = id;
      }
    }

    if (closestId) {
      this.attack(closestId);
      return closestId;
    }
    return null;
  }

  /**
   * Starts auto-combat loop searching for nearby mobs.
   * @param {number} checkIntervalMs
   */
  startAutoCombat(checkIntervalMs = 1000) {
    this.stopAutoCombat();
    this.combatIntervalId = setInterval(() => {
      if (this.connected && this.loggedIn) {
        this.attackNearestMob();
      }
    }, checkIntervalMs);
  }

  /**
   * Stops auto-combat loop.
   */
  stopAutoCombat() {
    if (this.combatIntervalId) {
      clearInterval(this.combatIntervalId);
      this.combatIntervalId = null;
    }
  }

  castSkill() {
    this.send({ action: 'cast_skill' });
  }

  castPurify() {
    this.send({ action: 'cast_purify' });
  }

  useItem(itemName) {
    this.send({ action: 'use_item', item: itemName });
  }

  // --- Multiplayer (Chat & Party & Trade) ---

  /**
   * Sends chat message supporting multi-channel protocol.
   * @param {string} text
   * @param {string} channel - 'world' | 'party' | 'trade' | 'help'
   */
  sendChat(text, channel = 'world') {
    this.send({ action: 'chat', channel, text });
  }

  inviteParty(targetPlayerName) {
    this.send({ action: 'party_invite', targetName: targetPlayerName });
  }

  acceptParty(leaderName, partyId = null) {
    this.send({ action: 'party_accept', leaderName, partyId });
  }

  leaveParty() {
    this.send({ action: 'party_leave' });
  }

  requestTrade(targetPlayerName) {
    this.send({ action: 'trade_request', targetName: targetPlayerName });
  }

  acceptTrade(fromPlayerName) {
    this.send({ action: 'trade_accept', fromPlayer: fromPlayerName });
  }

  offerTrade(items = [], gold = 0) {
    this.send({ action: 'trade_offer', items, gold });
  }

  lockTrade() {
    this.send({ action: 'trade_lock' });
  }

  confirmTrade() {
    this.send({ action: 'trade_confirm' });
  }

  cancelTrade() {
    this.send({ action: 'trade_cancel' });
  }

  // --- NPC & Quests ---

  talkNpc(npcId) {
    this.lastNpcId = npcId;
    this.send({ action: 'talk_npc', npc_id: npcId });
  }

  acceptQuest(questId, npcId = this.lastNpcId) {
    this.send({ action: 'accept_quest', quest_id: questId, npc_id: npcId });
  }

  // --- Assertion & Verification Helpers ---

  /**
   * Waits for a message that satisfies the predicate function.
   * @param {Function} predicate - (packet) => boolean
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {Promise<object>} The matching packet
   */
  waitForMessage(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('packet', handler);
        reject(new Error(`[BotClient ${this.charName}] Timeout after ${timeoutMs}ms waiting for packet matching predicate`));
      }, timeoutMs);

      const handler = (packet) => {
        try {
          if (predicate(packet)) {
            clearTimeout(timer);
            this.off('packet', handler);
            resolve(packet);
          }
        } catch (err) {
          // ignore predicate evaluation errors and continue listening
        }
      };

      this.on('packet', handler);
    });
  }

  /**
   * Waits for a specific action packet.
   * @param {string} actionName
   * @param {number} timeoutMs
   * @returns {Promise<object>}
   */
  waitForAction(actionName, timeoutMs = 5000) {
    return this.waitForMessage(p => p && p.action === actionName, timeoutMs);
  }

  /**
   * Waits for a status packet satisfying predicate.
   * @param {Function} predicate
   * @param {number} timeoutMs
   * @returns {Promise<object>}
   */
  waitForStatus(predicate, timeoutMs = 5000) {
    return this.waitForMessage(p => p && p.action === 'status' && predicate(p), timeoutMs);
  }

  // --- Performance Metrics Synthesis ---

  /**
   * Synthesizes move-to-sync RTT latency statistics.
   * @returns {{count: number, min: number, mean: number, p50: number, p95: number, max: number}}
   */
  getRoundtripMetrics() {
    if (this.rttSamples.length === 0) {
      return { count: 0, min: 0, mean: 0, p50: 0, p95: 0, max: 0 };
    }

    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const mean = sum / sorted.length;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const p50 = sorted[Math.floor(sorted.length * 0.50)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];

    return {
      count: sorted.length,
      min: Math.round(min),
      mean: Math.round(mean),
      p50: Math.round(p50),
      p95: Math.round(p95),
      max: Math.round(max)
    };
  }

  /**
   * Synthesizes tick interval and jitter statistics.
   * @returns {{count: number, meanInterval: number, jitter: number, maxDelay: number}}
   */
  getTickMetrics() {
    if (this.tickIntervals.length === 0) {
      return { count: 0, meanInterval: 0, jitter: 0, maxDelay: 0 };
    }

    const sum = this.tickIntervals.reduce((acc, val) => acc + val, 0);
    const mean = sum / this.tickIntervals.length;
    const maxDelay = Math.max(...this.tickIntervals);

    const variance = this.tickIntervals.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / this.tickIntervals.length;
    const jitter = Math.sqrt(variance);

    return {
      count: this.tickIntervals.length,
      meanInterval: Math.round(mean),
      jitter: Math.round(jitter),
      maxDelay: Math.round(maxDelay)
    };
  }
}

module.exports = BotClient;
