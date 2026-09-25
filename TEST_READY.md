# TEST_READY.md — Milestone Acceptance Quality Gates & 4-Tier Test Matrix

> **Current status note (2026-09-25):** The AC1–AC7 runner and the first
> reliability pass now execute successfully in the current workspace. The
> matrix below is retained as the original target specification; use
> `IMPLEMENTATION_PLAN.md` and the latest test output for current status.

## 1. Executive Summary & Purpose

This document establishes the authoritative acceptance criteria traceability matrix, multi-tier testing taxonomy, and milestone quality gates for the Tibia MMORPG expansion and overhaul project. It serves as the formal specification and audit baseline for Workers, Reviewers, and Forensic Auditors.

---

## 2. Requirements & Acceptance Criteria Traceability Matrix

| AC ID | Category | Requirement Description | Verification Method | Primary Test File | Milestone Target | M1 Status |
|---|---|---|---|---|---|:---:|
| **AC1** | Combat & Progression | Independent browser agent levels character to threshold and transitions to Sub-class (Warrior -> Juggernaut). | Headless Browser Agent (`puppeteer-core`) | `tests/browser/test_subclass.js` | M3 | Oracle Ready (Awaiting M3 Feature) |
| **AC2** | Combat & Mechanics | Browser agent engages Boss mob, triggers AoE ability, and verifies Canvas AoE ground indicator renders $\ge 1400$ms before damage. | Headless Browser + Dual-Layer Canvas Sampler | `tests/browser/test_boss_aoe.js` | M3 | Oracle Ready (Awaiting M3 Feature) |
| **AC3** | Content & UI | Browser agent initiates conversation with advanced NPC, accepts multi-step quest, and verifies Quest Journal UI updates in real-time. | Headless Browser Agent (`puppeteer-core`) | `tests/browser/test_npc_quest.js` | M4 | Oracle Ready (Awaiting M4 Feature) |
| **AC4** | Multiplayer & UI | Two simultaneous browser agents execute 5-stage secure player-to-player trade interface flow (offer, lock, confirm, swap). | Dual Browser Contexts (`puppeteer-core`) | `tests/browser/test_trade.js` | M5 | Oracle Ready (Awaiting M5 Feature) |
| **AC5** | Networking & Stability| 50 concurrent headless WebSocket bots actively move and attack without server crashes or unacceptable tick delays. | Programmatic WebSocket Bot Fleet (`BotClient`) | `tests/bots/load_test_50_bots.js` | M2 | **PASSED** (Baseline 100% Verified) |
| **AC6** | Multiplayer Systems | Two headless bots form a Party and broadcast messages to global and party chat channels, verified via message logs. | Programmatic WebSocket Bot Fleet (`BotClient`) | `tests/bots/party_chat_test.js` | M5 | Chat Verified / Party Oracle Ready |
| **AC7** | Persistence & Reliability | Server state consistently persists during load test, verified by cleanly shutting down (SIGINT/SIGTERM) and reading intact states on cold restart. | Ephemeral Server Lifecycle + WebSocket Client | `tests/bots/persistence_test.js` | M2 | Non-Default Oracle Ready |

---

## 3. Four-Tier Test Taxonomy

The test infrastructure enforces a strict 4-tier verification hierarchy in accordance with the Project Pattern:

```
        =====================================================
       /            Tier 4: Real-World Scenarios             \
      /-------------------------------------------------------\
     /          Tier 3: Cross-Feature Combinations             \
    /-----------------------------------------------------------\
   /       Tier 2: Boundary & Corner Cases (>= 5 per feature)    \
  /---------------------------------------------------------------\
 /         Tier 1: Feature Coverage (>= 5 cases per feature)       \
===================================================================
```

### 3.1 Tier 1: Feature Coverage ($\ge 5$ cases per feature)
Covers baseline functional specifications across all 8 game subsystems:
- **Sub-Class Progression**: Juggernaut promotion (`TC-SUB-01`), Berserker promotion (`TC-SUB-02`), Archmage promotion (`TC-SUB-03`), Marksman promotion (`TC-SUB-04`), Stat recalculation without relog (`TC-SUB-05`).
- **Boss Encounter & AoE Telegraph**: Boss spawn attributes (`TC-BOSS-01`), Aggro range (`TC-BOSS-02`), AoE warning packet (`TC-BOSS-03`), Canvas ground indicator rendering (`TC-BOSS-04`), Timed 1500ms detonation (`TC-BOSS-05`).
- **NPC Dialogue & Quests**: Dialogue DAG initialization (`TC-QST-01`), Branching navigation (`TC-QST-02`), Multi-step quest acceptance (`TC-QST-03`), Objective tracking on kill (`TC-QST-04`), Turn-in & rewards (`TC-QST-05`).
- **Secure Trading**: Trade invitation (`TC-TRD-01`), Staging items & gold (`TC-TRD-02`), Mutual lock (`TC-TRD-03`), Mutual confirm atomic swap (`TC-TRD-04`), Safe cancellation (`TC-TRD-05`).
- **50-Bot Concurrent Load**: Concurrency handshake (`TC-LOD-01`), Autonomous movement (`TC-LOD-02`), Combat interaction (`TC-LOD-03`), Tick stability $\le 100$ms (`TC-LOD-04`), Bounded memory (`TC-LOD-05`).
- **Party System**: Party invitation (`TC-PTY-01`), Member status HUD sync (`TC-PTY-02`), Proximity XP sharing +15% (`TC-PTY-03`), Party chat routing (`TC-PTY-04`), Party disbandment (`TC-PTY-05`).
- **Global Chat**: World broadcast (`TC-CHT-01`), Trade channel (`TC-CHT-02`), Help channel (`TC-CHT-03`), Private whisper (`TC-CHT-04`), Sender metadata fidelity (`TC-CHT-05`).
- **Hybrid Persistence**: New player base record (`TC-PST-01`), Dirty buffer flush (`TC-PST-02`), Graceful shutdown flush (`TC-PST-03`), Cold restart restoration (`TC-PST-04`), Local JSON fallback store (`TC-PST-05`).

### 3.2 Tier 2: Boundary & Corner Cases ($\ge 5$ cases per feature)
Validates system behavior under abnormal, boundary, and edge conditions:
- **Sub-Class**: Under-level rejection (`TC-SUB-06`), Duplicate promotion prevention (`TC-SUB-07`), Invalid sub-class token (`TC-SUB-08`), Cross-class tree protection (`TC-SUB-09`), Promotion race conditions (`TC-SUB-10`).
- **Boss Combat**: Radial boundary damage cutoff (`TC-BOSS-06`), Last-millisecond evasion (`TC-BOSS-07`), Phase 2 enrage trigger at 50% HP (`TC-BOSS-08`), Aggro leash & room reset (`TC-BOSS-09`), Burst attack stability (`TC-BOSS-10`).
- **NPC Quests**: Interaction distance limit 64px (`TC-QST-06`), Incomplete quest turn-in rejection (`TC-QST-07`), Full inventory handling on reward (`TC-QST-08`), Rapid dialogue spam resilience (`TC-QST-09`), Step prerequisites (`TC-QST-10`).
- **Trading**: Distance abort ($>80$px) (`TC-TRD-06`), Abrupt disconnect abort (`TC-TRD-07`), Post-lock mutation rejection (`TC-TRD-08`), Ghost item staging detection (`TC-TRD-09`), Capacity overfill protection (`TC-TRD-10`).
- **Load & AoI Grid**: Spatial partitioning isolation (`TC-LOD-06`), Cell boundary transition (`TC-LOD-07`), Mass disconnect shock (`TC-LOD-08`), High-frequency packet throttling (`TC-LOD-09`), Congregation hotspot stress (`TC-LOD-10`).
- **Party**: Max 4-member limit (`TC-PTY-06`), Proximity cutoff at 600px (`TC-PTY-07`), Leader disconnect migration (`TC-PTY-08`), Already grouped invite rejection (`TC-PTY-09`), Self-invite prevention (`TC-PTY-10`).
- **Chat**: Non-member party chat block (`TC-CHT-06`), Nonexistent whisper recipient (`TC-CHT-07`), Message truncation at 255 chars (`TC-CHT-08`), Whitespace filter (`TC-CHT-09`), Anti-flood rate limiting (`TC-CHT-10`).
- **Persistence**: Shutdown during trade (`TC-PST-06`), Disconnect 100ms prior to shutdown (`TC-PST-07`), Corrupt file fallback (`TC-PST-08`), Atomic file rename (`TC-PST-09`), 50-record concurrent flush SLA (`TC-PST-10`).

### 3.3 Tier 3: Cross-Feature Integration Combinations
- `TC-XF-01`: Combat damage breaking active trade concentration with safe rollback.
- `TC-XF-02`: Sub-class promotion inside an active party dynamically synchronizing member HP bars.
- `TC-XF-03`: Spatial AoI partitioning containing local movement while allowing cross-cell global chat.
- `TC-XF-04`: Boss kill event synchronizing quest objective completion and boss loot distribution for party members.
- `TC-XF-05`: Atomic trade completion immediately followed by server shutdown and cold restart state validation.
- `TC-XF-06`: Party movement across biome boundary cells with ambient effect application.
- `TC-XF-07`: Quest reward inventory fill followed by trade capacity safety check.
- `TC-XF-08`: Boss minion spawn broadcast constrained to boss lair AoI cells.

### 3.4 Tier 4: Real-World End-to-End Scenarios
- `TC-RW-01`: Neophyte to Juggernaut — Complete browser agent player journey (login, NPC dialogue, mob combat, level 10 sub-class awakening).
- `TC-RW-02`: Broodmother Raid under 50-Bot Background Swarm — Full boss raid execution during active 50-bot background load.
- `TC-RW-03`: Cooperative Expedition & Commerce — Dual browser player journey (party formation, swamp expedition, shared XP, secure trade).
- `TC-RW-04`: Catastrophic Server Crash & State Recovery — Sudden process termination under load with 100% state recovery across all entities.

---

## 4. Milestone Quality Gates

| Milestone | Gate Criteria | Verification Command | Gate Status |
|---|---|---|:---:|
| **M1: Test Infrastructure & Acceptance Harness** | Baseline Test Harness achieves 100% PASS (5/5). All 7 Acceptance Criteria test files exist, contain STRICT genuine assertions (zero mocks/facades), and truthfully report pending feature status against baseline prototype. | `node tests/e2e_runner.js --suite=baseline --port=8095 --bots=50 --duration=5` (Must exit 0)<br>`node tests/e2e_runner.js --gate=m1` (Must exit 0) | **PASSED [✓]** |
| **M2: Technical Refactoring & Persistence Architecture** | AC5 (50 Bots) passes with tick jitter $< 80$ms. AC7 (Persistence) passes with 100% data retention across restart using non-default state mutation. | `node tests/e2e_runner.js --suite=bots` | Pending M2 Implementation |
| **M3: Gameplay & Combat Systems** | AC1 (Sub-Class promotion) passes. AC2 (Boss AoE Canvas indicator) renders $\ge 1400$ms before damage without test-side painting. | `node tests/browser/browser_runner.js --test=subclass`<br>`node tests/browser/browser_runner.js --test=boss_aoe` | Pending M3 Implementation |
| **M4: World & Content Expansion** | AC3 (NPC dialogue DAG & multi-step quest line) passes in browser agent. | `node tests/browser/browser_runner.js --test=npc_quest` | Pending M4 Implementation |
| **M5: Multiplayer Features** | AC4 (Player trade flow) passes via 2 browser agents. AC6 (Party & multi-channel chat) passes via bot harness. | `node tests/browser/browser_runner.js --test=trade`<br>`node tests/bots/party_chat_test.js` | Pending M5 Implementation |
| **M6: Final Acceptance Validation & Adversarial Hardening** | 100% pass rate across all 7 Acceptance Criteria (AC1 – AC7) and Tier 1–4 suites on ephemeral test server. | `node tests/e2e_runner.js --suite=acceptance` | Pending M6 Implementation |

---

## 5. Verification Commands Reference

```powershell
# 1. Verify Tier A Baseline Harness (Milestone 1 Completion Gate - Exits Code 0)
node tests/e2e_runner.js --suite=baseline --port=8095 --bots=50 --duration=5

# 2. Verify Milestone 1 Quality Gate (Exits Code 0)
node tests/e2e_runner.js --gate=m1 --port=8095

# 3. Verify Tier B Acceptance Criteria (Honest failure of unimplemented M2-M5 features - Exits Code 1)
node tests/e2e_runner.js --suite=acceptance --port=8096

# 4. Verify BotClient connectivity and offline error resilience
node -e "const BotClient = require('./tests/bots/bot_client'); const b = new BotClient({ serverUrl: 'ws://localhost:9999' }); b.connect().catch(e => console.log('Clean rejection:', e.message));"

# 5. Verify Zero Mock Injections across all test suites (Must return 0 results)
git grep "window.__GAME_SOCKET__.onmessage" tests/
git grep "ctx.arc" tests/browser/test_boss_aoe.js
git grep "renderQuestJournal" tests/browser/test_npc_quest.js
```
