# Project: Tibia MMORPG Expansion and Overhaul

> **Status note (2026-09-25):** This document describes the target architecture and roadmap. The current implementation is still flatter: the live entry point is `server/server.js`, persistence is `server/persistence.js`, and the domain modules are directly under `server/`. Use `IMPLEMENTATION_PLAN.md` for the ordered execution plan and `docs/PROTOCOL.md` for the currently implemented wire contract.

## Architecture
The Tibia MMORPG architecture consists of:
1. **Server Core (`server/`)**:
   - `server/server.js`: Modular server bootstrapper, HTTP static server, WebSocket connection manager.
   - `server/engine/game_loop.js`: Unified high-precision tick loop (100ms combat/physics tick, 200ms spatial AoI broadcast tick, 10s persistence flush).
   - `server/network/aoi_grid.js`: Spatial 2D Grid Area of Interest (AoI) partitioning (cells of 400x400 px). Messages (movement, combat, FCT) broadcast only to observers in adjacent cells, preventing quadratic $O(N^2)$ network scaling under 50+ bots.
   - `server/network/packet_dispatcher.js`: Structured incoming packet router with validation, rate limiting, and session state.
   - `server/persistence/db_adapter.js`: Hybrid persistence layer with Firebase Firestore primary driver, atomic local JSON fallback store (`server/data/players.json`), dirty-state queue, and graceful shutdown handlers (`SIGINT`/`SIGTERM`) ensuring 100% persistence reliability on server restart.
2. **Gameplay Systems (`server/systems/`)**:
   - `combat_system.js`: Damage formulas, armor mitigation, combat cooldowns, and auto-attack loop.
   - `subclass_system.js`: Level 10 threshold validation, promotion handlers, class-specific stat multipliers, and sub-class abilities (Warrior -> Juggernaut/Berserker, Mage -> Archmage/Necromancer, Ranger -> Marksman/Shadowstalker).
   - `boss_system.js`: Boss encounter manager for Spider Queen (Broodmother Voraxia), 2-phase state machine, telegraphed AoE ground attacks (`aoe_warning` broadcast 1500ms before detonation), minion spawning, and boss loot tables.
3. **World & Content (`server/world/`, `server/content/`)**:
   - `map_manager.js`: Multi-biome map system (Forest, Town, Swamp, Crypt, Mountain) with collision masks and spawn zones.
   - `npc_manager.js`: Advanced NPC state machine with branching dialogue trees (DAG structure), quest assignment, and trading.
   - `quest_system.js`: Multi-step quest chains, progress tracking, objective verification (kill, collect, talk), and rewards.
   - `item_system.js`: Rich loot tables, equipment slotting (helm, armor, legs, boots, weapon, shield, ring), rarities, and inventory operations.
4. **Multiplayer Systems (`server/multiplayer/`)**:
   - `trade_system.js`: 5-stage secure player-to-player trade state machine (Invite -> Stage Items/Gold -> Mutual Lock -> Mutual Confirm -> Atomic Swap) with safety aborts on distance/movement/disconnect.
   - `party_system.js`: 4-player party manager, invites, party chat, shared member status broadcasts, and proximity XP distribution (+15% party bonus).
   - `chat_system.js`: Multi-channel chat router (World, Trade, Help, Party, Whisper) with channel filtering.
5. **Client (`client/`)**:
   - `client/test_client.html`: HTML5 Canvas 2D isometric rendering, AoE ground indicator telegraph rendering, HUD overlays (Party status, Trade window, Dialogue modals, Sub-class selection modal, Multi-channel chat tabs).
6. **E2E & Acceptance Testing (`tests/`)**:
   - `tests/e2e/test_runner.js`: Automated runner for both programmatic headless bots and headless browser verification.
   - `tests/bots/headless_bot_load.js`: 50 concurrent WebSocket bot load test measuring tick rate and memory.
   - `tests/bots/party_chat_bot.js`: 2-bot party formation and multi-channel chat verification.
   - `tests/bots/persistence_restart_bot.js`: Server restart state integrity verification.
   - `tests/browser/browser_acceptance.js`: Puppeteer/Playwright headless browser verification of Sub-class transition, Boss AoE ground indicator, NPC dialogue & quest, and Player trade flow.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | E2E Test Runner & Harness | Automated CLI test runner executing all Acceptance Criteria | M1 | ORIGINAL_REQUEST §Acceptance Criteria |
| 2 | 50-Bot Load Test Harness | Programmatic script spawning 50 WebSocket bots actively moving/attacking | M1 | ORIGINAL_REQUEST §AC-H1 |
| 3 | Party & Chat Bot Harness | 2-bot script testing party formation and global chat messages | M1 | ORIGINAL_REQUEST §AC-H2 |
| 4 | Persistence Restart Harness | Bot script verifying state saved before shutdown and restored on restart | M1 | ORIGINAL_REQUEST §AC-H3 |
| 5 | Browser Bot Acceptance Suite | Headless browser scripts verifying UI/Canvas interactions for AC1-AC4 | M1 | ORIGINAL_REQUEST §AC-B1..B4 |
| 6 | Unified High-Precision Game Loop | Decoupled tick scheduler replacing arbitrary intervals | M2 | R4, Survey Codebase |
| 7 | Spatial Grid AoI Partitioning | 2D Spatial partitioning to eliminate $O(N^2)$ global broadcast lag | M2 | R4, Survey Systems |
| 8 | Hybrid Firebase / Local Persistence | Resilient persistence with Firestore adapter, atomic JSON store, and shutdown flush | M2 | R4, ORIGINAL_REQUEST §AC-H3 |
| 9 | NPC & Packet Routing Refactor | Fix NPC interaction crash (`quests_offered`), modular packet dispatch | M2 | R4, Survey Codebase |
| 10 | Sub-Class Progression & Stats | Level 10 threshold, 6 sub-classes (Juggernaut, etc.), stat scaling | M3 | R1, ORIGINAL_REQUEST §AC-B1 |
| 11 | Sub-Class Selection & UI | Client UI modal for class promotion and enhanced skill activation | M3 | R1, ORIGINAL_REQUEST §AC-B1 |
| 12 | Boss Encounter (Spider Queen) | Multi-phase boss AI with minion spawns and enraged states | M3 | R1, ORIGINAL_REQUEST §AC-B2 |
| 13 | Telegraphed AoE Ground Indicators | Server `aoe_warning` packet and client rendering of ground telegraph before damage | M3 | R1, ORIGINAL_REQUEST §AC-B2 |
| 14 | Multi-Biome World Expansion | Expanded map with Forest, Town, Swamp, Crypt, and Mountain regions | M4 | R2, ORIGINAL_REQUEST §R2 |
| 15 | Advanced NPC Dialogue Tree Engine | Branching DAG dialogue trees with conditional choices and responses | M4 | R2, ORIGINAL_REQUEST §AC-B3 |
| 16 | Multi-Step Quest System | Multi-step quest chains, journal tracking, UI acceptance & turn-in | M4 | R2, ORIGINAL_REQUEST §AC-B3 |
| 17 | Rich Item & Loot Ecosystem | Extended item catalog, rarities, equipment slots, boss drop tables | M4 | R2, ORIGINAL_REQUEST §R2 |
| 18 | Secure Player-to-Player Trading | 5-stage secure trade machine with atomic swap and cancel safety | M5 | R3, ORIGINAL_REQUEST §AC-B4 |
| 19 | Player Trade Window UI | Dual-side staging UI with mutual lock, confirm buttons, and item preview | M5 | R3, ORIGINAL_REQUEST §AC-B4 |
| 20 | Party System Engine | Party creation, invitations, member list, and shared proximity XP | M5 | R3, ORIGINAL_REQUEST §AC-H2 |
| 21 | Party HUD & Overlays | Client party HUD displaying party members and health/mana bars | M5 | R3, ORIGINAL_REQUEST §AC-H2 |
| 22 | Multi-Channel Global Chat | Channel router for World, Trade, Help, Party tabs and slash commands | M5 | R3, ORIGINAL_REQUEST §AC-H2 |
| 23 | E2E Acceptance Pass (Tiers 1-4) | 100% pass on all 7 Acceptance Criteria tests | M6 | ORIGINAL_REQUEST §Acceptance Criteria |
| 24 | Adversarial Coverage Hardening (Tier 5) | White-box stress-testing, concurrency race condition audits, performance profiling | M6 | Project Pattern Phase 2 |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Test Infrastructure & Acceptance Harness | E2E test runner, 50-bot load tester, party/chat bot, persistence restart tester, and browser acceptance test suites (Features 1-5, TEST_INFRA.md, TEST_READY.md) | none | IMPLEMENTED / VERIFIED |
| M2 | Technical Refactoring & Architecture Modernization | Modular engine, unified game loop, Spatial AoI grid, Hybrid Firebase / local persistence with graceful shutdown flush, packet dispatcher, NPC crash fix (Features 6-9) | M1 | PARTIAL |
| M3 | Gameplay & Combat Systems | Sub-class progression (Level 10 threshold, Warrior -> Juggernaut/Berserker, Mage, Ranger), Spider Queen Boss with telegraphed AoE ground indicators (Features 10-13) | M2 | PARTIAL |
| M4 | World & Content Expansion | Multi-biome world expansion (Swamp, Crypt, Mountain), branching NPC dialogue trees, multi-step quest lines, rich item/loot ecosystem (Features 14-17) | M2 | PARTIAL |
| M5 | Multiplayer Features | Secure 2-phase player-to-player trading with UI, 4-player party system with shared proximity XP & HUD, multi-channel global chat (Features 18-22) | M2 | PARTIAL |
| M6 | Final Acceptance Validation & Adversarial Hardening | 100% pass on all 7 Acceptance Criteria tests (AC1-AC7), followed by Tier 5 adversarial stress testing and concurrency hardening (Features 23-24) | M1, M3, M4, M5 | ACCEPTANCE PASSED / HARDENING PENDING |

---

## Interface Contracts

### 1. Persistence Adapter Contract (`server/persistence/db_adapter.js`)
```javascript
interface DatabaseAdapter {
  init(): Promise<void>;
  loadPlayer(charName: string): Promise<PlayerData | null>;
  savePlayer(charName: string, data: PlayerData): Promise<boolean>;
  saveAllDirty(): Promise<number>;
  shutdown(): Promise<void>;
}
```

### 2. Spatial Grid AoI Contract (`server/network/aoi_grid.js`)
```javascript
interface AoIGrid {
  addEntity(entity: Entity): void;
  updateEntityPosition(entity: Entity, oldX: number, oldY: number, newX: number, newY: number): { enteredCells: Cell[], leftCells: Cell[] };
  removeEntity(entity: Entity): void;
  getNearbyPlayers(x: number, y: number, radiusPx: number): Player[];
  broadcastToNearby(x: number, y: number, packet: object, radiusPx?: number): void;
}
```

### 3. Sub-Class Contract (`server/systems/subclass_system.js`)
```javascript
// Packet from client: { action: 'select_subclass', subclass: 'juggernaut' }
// Packet from server: { action: 'subclass_promoted', charName: string, subclass: string, stats: Stats, abilities: string[] }
```

### 4. Boss AoE Telegraph Contract (`server/systems/boss_system.js`)
```javascript
// Packet broadcast to AoI:
// { action: 'aoe_warning', spellId: string, x: number, y: number, radius: number, durationMs: number, shape: 'circle' }
// Followed durationMs later by:
// { action: 'aoe_impact', spellId: string, x: number, y: number, radius: number, damage: number, affectedPlayers: string[] }
```

### 5. Secure Trade Contract (`server/multiplayer/trade_system.js`)
```javascript
// Packets:
// -> { action: 'trade_request', targetPlayer: string }
// <- { action: 'trade_requested', fromPlayer: string }
// -> { action: 'trade_accept', fromPlayer: string }
// <- { action: 'trade_start', partnerName: string }
// -> { action: 'trade_offer', items: Item[], gold: number }
// <- { action: 'trade_update', partnerItems: Item[], partnerGold: number }
// -> { action: 'trade_lock' }
// <- { action: 'trade_locked', partnerLocked: boolean }
// -> { action: 'trade_confirm' }
// <- { action: 'trade_complete', receivedItems: Item[], receivedGold: number }
// -> { action: 'trade_cancel' }
// <- { action: 'trade_cancelled', reason: string }
```

### 6. Party Contract (`server/multiplayer/party_system.js`)
```javascript
// Packets:
// -> { action: 'party_invite', targetPlayer: string }
// <- { action: 'party_invited', fromPlayer: string }
// -> { action: 'party_accept', leaderName: string }
// -> { action: 'party_leave' }
// <- { action: 'party_sync', leader: string, members: [{ name: string, hp: number, maxHp: number, x: number, y: number }] }
```

### 7. Multi-Channel Chat Contract (`server/multiplayer/chat_system.js`)
```javascript
// Packets:
// -> { action: 'chat', channel: 'world' | 'trade' | 'help' | 'party', text: string }
// <- { action: 'chat', channel: string, sender: string, text: string, timestamp: number }
```

---

## Code Layout
```
tibia_mmo/
├── server/
│   ├── server.js                      # Main entry point & WebSocket server
│   ├── config.js                      # Server configurations & constants
│   ├── engine/
│   │   ├── game_loop.js               # Unified high-precision tick loop
│   │   └── spatial_grid.js            # AoI spatial grid partitioning
│   ├── network/
│   │   └── packet_dispatcher.js       # Packet router & validation
│   ├── persistence/
│   │   ├── db_adapter.js              # Persistence manager interface
│   │   ├── firebase_driver.js         # Firestore persistence driver
│   │   └── local_driver.js            # Atomic local JSON fallback driver
│   ├── entities/
│   │   ├── player.js                  # Player entity state & mechanics
│   │   ├── mob.js                     # Monster entity & standard AI
│   │   └── boss.js                    # Boss entity (Spider Queen) & state machine
│   ├── systems/
│   │   ├── combat_system.js           # Combat formulas & auto-attacks
│   │   ├── subclass_system.js         # Sub-class promotion & abilities
│   │   └── boss_system.js             # Boss encounter & AoE telegraphing
│   ├── world/
│   │   ├── map_data.js                # Biome tiles, collisions, spawn zones
│   │   └── biomes.js                  # Biome definitions & weather/effects
│   ├── content/
│   │   ├── items.js                   # Item definitions, rarities, stats
│   │   ├── npcs.js                    # NPC definitions & dialogue DAGs
│   │   └── quests.js                  # Quest chains & progression tracker
│   ├── multiplayer/
│   │   ├── trade_manager.js           # 2-phase secure trade state machine
│   │   ├── party_manager.js           # Party management & shared XP
│   │   └── chat_manager.js            # Multi-channel chat router
│   ├── data/
│   │   └── players.json               # Local persistence store
│   └── package.json
├── client/
│   ├── test_client.html               # Main HTML5 Canvas client & UI overlays
│   └── js/                            # Optional modular client scripts if needed
└── tests/
    ├── e2e_runner.js                  # Master test suite runner
    ├── bots/
    │   ├── bot_client.js              # Headless WebSocket bot library
    │   ├── load_test_50_bots.js       # 50-bot load & tick benchmark (AC5)
    │   ├── party_chat_test.js         # Party & multi-channel chat test (AC6)
    │   └── persistence_test.js        # Server shutdown & restart test (AC7)
    └── browser/
        ├── browser_runner.js          # Browser test runner
        ├── test_subclass.js           # Level-up & subclass transition test (AC1)
        ├── test_boss_aoe.js           # Boss AoE indicator rendering test (AC2)
        ├── test_npc_quest.js          # NPC dialogue & quest accept test (AC3)
        └── test_trade.js              # Secure trade flow test (AC4)
```
