# TEST_INFRA.md — Tibia MMORPG Test Infrastructure Architecture

## 1. Overview & Architectural Principles

The Tibia MMORPG Test Infrastructure provides automated, hermetic, and ground-truth acceptance testing across all gameplay, content, networking, and multiplayer subsystems. Designed to validate the requirements specified in `ORIGINAL_REQUEST.md` and `PROJECT.md`, the harness operates across two distinct execution paradigms:

1. **Programmatic Headless WebSocket Bots (AC5 – AC7)**:
   High-concurrency stress testing (50 concurrent bots), tick rate and jitter benchmarking, party formation and multi-channel chat routing, and server persistence across clean cold restarts.
2. **Independent Browser Agents (AC1 – AC4)**:
   Real-world user-experience validation in headless Google Chrome or Microsoft Edge driven by `puppeteer-core`, exercising HTML5 Canvas isometric rendering, AoE ground indicator telegraphs, NPC dialogue trees, and 2-player secure trade interfaces.

### Core Testing Principles
- **Hermetic Process Isolation**: Test suites execute against ephemeral Node.js server processes spawned on designated ports (default: `8085`), preventing database pollution or port collisions with development environments.
- **Opaque-Box Network Protocol Decoupling**: Tests do not import internal server memory models or game loop intervals. All interaction is conducted via standard WebSocket JSON packets (`ws.send()`, `ws.onmessage`), client DOM controls, and standard operating system process signals (`SIGINT`, `SIGTERM`, IPC).
- **Dual-Layer Canvas Verification**: Visual proof of rasterized ground indicators using direct pixel buffer sampling (`ctx.getImageData()`) cross-validated with transparent context telemetry spies.
- **Deterministic Exit Codes**: All runners and test scripts return strict POSIX exit codes (0 = Pass / Gate Passed, 1 = Assertion Failure, 2 = Harness/Environment Error, 3 = Config Error).

---

## 2. Mandatory Integrity & Anti-Cheat Policy

To ensure complete architectural truthfulness and prevent facade implementations:

1. **Zero Mock Server Responses**:
   Tests must NEVER inject simulated packets into client WebSocket instances (`window.__GAME_SOCKET__.onmessage`). All network packets received by client agents must originate from the running Node.js server.
2. **Zero Test-Side Canvas Painting**:
   Tests must NEVER invoke Canvas 2D drawing primitives (`ctx.arc`, `ctx.fill`, `ctx.stroke`) to draw indicators onto the canvas for the test to self-certify. All visual indicators must be rendered by client game engine code.
3. **Zero Synthetic DOM Injections**:
   Tests must NEVER invoke internal client rendering methods (such as `renderQuestJournal()` or `showNPCDialog()`) directly from test scripts. UI updates must occur naturally via DOM events or server broadcasts.
4. **Zero Avatar Center Sampling**:
   Pixel sampling for ground telegraphs must NEVER sample the screen center `(320, 240)` where the player's avatar is rendered, preventing false-positive color detections.
5. **Zero Tautological State Comparisons**:
   Persistence tests must actively mutate character attributes (acquiring gold from chests or gathering crafting items) away from initial defaults prior to shutdown, ensuring that post-restart restoration is validated against genuinely non-default states.
6. **Zero Timeout Fallback Passes**:
   When server features are not yet implemented (e.g. party invite, trade flow, subclass modal), tests must legitimately fail or report pending status rather than executing fallback branches that record false passes.

---

## 3. Two-Tier Test Execution Model

The test architecture explicitly separates test harness infrastructure verification from target feature acceptance:

```
+-------------------------------------------------------------------------+
|                  MASTER TEST SUITE ARCHITECTURE                         |
+-------------------------------------------------------------------------+
|                                                                         |
|  [TIER A: BASELINE TEST HARNESS VERIFICATION]                           |
|  * Target: Milestone 1 Completion Gate (--suite=baseline / --gate=m1)   |
|  * Purpose: Verifies that test tooling, runners, bots, browser drivers, |
|    and telemetry operate hermetically, reliably, and without mocks.     |
|  * Scope:                                                               |
|    1. HARNESS-SRV: Ephemeral Server Lifecycle & Multi-Factor Probe       |
|    2. HARNESS-BOT: BotClient Handshake & Disconnect Error Resilience    |
|    3. HARNESS-BRW: Puppeteer Browser Launch & DOM Auto-Login            |
|    4. HARNESS-CAN: CanvasInspector Buffer Sampling Integrity            |
|    5. AC5-LOAD:    50-Bot Concurrent Load Stress (Tick Jitter / RSS)    |
|  * Gate SLA: 100% PASS mandatory for Milestone 1 approval (Exit code 0).|
|                                                                         |
|  [TIER B: ACCEPTANCE CRITERIA GATES (AC1 - AC7)]                        |
|  * Target: Incremental Milestone Validation (M2 -> M6)                  |
|  * Purpose: Ground-truth opaque-box verification of gameplay features.   |
|  * Integrity Contract: STRICT REAL ASSERTIONS ONLY. ZERO MOCKS.         |
|  * Scope:                                                               |
|    - AC1: Sub-Class Progression          (Gate: M3) -> Pending in M1    |
|    - AC2: Boss AoE Ground Indicator      (Gate: M3) -> Pending in M1    |
|    - AC3: NPC Dialogue & Quest UI        (Gate: M4) -> Pending in M1    |
|    - AC4: 2-Player Secure Trade Flow     (Gate: M5) -> Pending in M1    |
|    - AC5: 50-Bot Concurrent Load & Tick  (Gate: M2) -> Validated in M1  |
|    - AC6: Party Formation & Chat Routing (Gate: M5) -> Pending in M1    |
|    - AC7: Persistence Across Restart     (Gate: M2) -> Pending in M1    |
|                                                                         |
+-------------------------------------------------------------------------+
```

---

## 4. Directory & Component Layout

```
tibia_mmo/
├── TEST_INFRA.md                    # This document: architecture, integrity rules, APIs, CLI specs
├── TEST_READY.md                    # Milestone readiness gates, 4-tier taxonomy, acceptance matrix
├── server/                          # Production game server core (read-only for M1)
├── client/                          # HTML5 client & isometric canvas renderer (read-only for M1)
└── tests/                           # Complete Test Infrastructure Suite
    ├── e2e_runner.js                # Master E2E runner orchestrating ephemeral server & all suites
    ├── lib/                         # Shared harness utilities
    │   ├── server_controller.js     # Ephemeral server lifecycle, health check polling & shutdown
    │   ├── server_preload.js        # Test environment port override hook
    │   └── test_framework.js        # Zero-dependency BDD assertion framework (describe, it, expect)
    ├── bots/                        # Programmatic Headless WebSocket Bot Suite
    │   ├── bot_client.js            # Shared WebSocket bot client SDK (movement, combat, assertions)
    │   ├── load_test_50_bots.js     # AC5: 50 concurrent bots load, tick jitter, & RTT benchmark
    │   ├── party_chat_test.js       # AC6: Party invite/accept & multi-channel chat isolation test
    │   └── persistence_test.js      # AC7: Server clean shutdown & cold restart state persistence test
    └── browser/                     # Browser Acceptance Suite (Puppeteer-Core)
        ├── browser_driver.js        # Chrome/Edge binary launcher & multi-context page manager
        ├── canvas_inspector.js      # Dual-layer Canvas pixel sampling & telemetry spy
        ├── browser_runner.js        # CLI runner for browser acceptance criteria
        ├── test_subclass.js         # AC1: Character progression & sub-class promotion test
        ├── test_boss_aoe.js         # AC2: Boss AoE ground indicator canvas rendering test
        ├── test_npc_quest.js        # AC3: NPC branching dialogue DAG & quest journal UI test
        └── test_trade.js            # AC4: 2-player secure trade interface flow test
```

---

## 5. Execution Commands & CLI Flags

### 5.1 Master E2E Runner (`tests/e2e_runner.js`)

```bash
# Tier A: Run Milestone 1 Baseline Test Harness Verification (Exits 0 on pass)
node tests/e2e_runner.js --suite=baseline --port=8095 --bots=50 --duration=5

# Evaluate Milestone 1 Quality Gate (Runs baseline harness and evaluates readiness)
node tests/e2e_runner.js --gate=m1 --port=8095

# Tier B: Run Full Acceptance Criteria Suite (Honest reporting of M2-M5 pending features)
node tests/e2e_runner.js --suite=acceptance --port=8096

# Run both Baseline Harness and Acceptance Gates
node tests/e2e_runner.js --suite=all --port=8097

# Run only headless bot acceptance tests (AC5 - AC7)
node tests/e2e_runner.js --suite=bots --port=8095

# Run only browser acceptance tests (AC1 - AC4)
node tests/e2e_runner.js --suite=browser --port=8095

# Target specific test by name/acronym
node tests/e2e_runner.js --test=ac1
node tests/e2e_runner.js --test=subclass
node tests/e2e_runner.js --test=ac5
node tests/e2e_runner.js --test=load

# Custom port and load test parameters
node tests/e2e_runner.js --port=8090 --bots=50 --duration=15

# Run in visual mode (non-headless browser for debugging)
node tests/e2e_runner.js --suite=browser --no-headless

# Abort immediately upon first failure
node tests/e2e_runner.js --bail
```

### 5.2 Standalone Bot Suite Execution

```bash
# AC5: 50 concurrent bots load test
node tests/bots/load_test_50_bots.js [--port=8080] [--bots=50] [--duration=15]

# AC6: Party formation and multi-channel chat test
node tests/bots/party_chat_test.js [--port=8080]

# AC7: Server shutdown and cold restart persistence test
node tests/bots/persistence_test.js [--port=8085]
```

### 5.3 Standalone Browser Suite Execution

```bash
# Run entire browser acceptance suite
node tests/browser/browser_runner.js [--port=8080]

# Run individual acceptance criteria
node tests/browser/browser_runner.js --test=subclass
node tests/browser/browser_runner.js --test=boss_aoe
node tests/browser/browser_runner.js --test=npc_quest
node tests/browser/browser_runner.js --test=trade

# Run visible browser window
node tests/browser/browser_runner.js --headless=false
```

---

## 6. Harness APIs & Technical Contracts

### 6.1 `probeServerPort(port, timeoutMs)`
Multi-factor server probe verifying that target port is either free, running a genuine Tibia MMO game server, or occupied by an unrelated service:
- Validates HTTP 200 response and HTML body signature: `<title>Tibia MMO`, `Tibia MMO - V2`, or `id="class-modal"`.
- Returns `{ status: 'FREE' }`, `{ status: 'TIBIA_SERVER' }`, or `{ status: 'COLLISION' }`.
- Rejects port collisions with immediate exit code 2.

### 6.2 `ProcessCleanupRegistry`
Bulletproof process management for Windows and POSIX hosts:
- Registers ephemeral servers, browser drivers, and child process trees.
- Intercepts signals (`SIGINT`, `SIGTERM`, `SIGHUP`) and uncaught exceptions.
- Guarantees process-tree force termination via `taskkill /pid <PID> /T /F` on Windows, eliminating orphaned `chrome.exe` or `node.exe` background processes.

### 6.3 `BotClient` (`tests/bots/bot_client.js`)
Headless WebSocket bot client representing a real MMO player, extending `EventEmitter`:
- **Self-Guarding Error Listener**: Built-in internal `'error'` handler prevents `ERR_UNHANDLED_ERROR` crashes during abnormal disconnects.
- **Safe Emission (`_emitError`)**: Normalizes error objects and guards against unhandled exceptions.
- **Entity Caches**: Real-time tracking of `chests`, `gatheringNodes`, `mobs`, `players`, and `party`.
- **Autonomous Navigation**: `distanceTo(targetX, targetY)` and `stepToward(targetX, targetY)` for obstacle-aware pathing to world targets.
- **Latency & Tick Profiling**: `getRoundtripMetrics()` (RTT p50/p95) and `getTickMetrics()` (mean tick interval, variance, jitter).

### 6.4 `BrowserDriver` (`tests/browser/browser_driver.js`)
Headless Chrome/Edge launcher utilizing `puppeteer-core`:
- Auto-discovers local browser executables across standard Windows paths.
- Creates isolated incognito browser contexts per agent.
- Injects `window.__MMO_TEST_TELEMETRY__` to capture in/out WebSocket frames and render events.
- Registers process exit hooks to terminate Chrome process trees on teardown.

### 6.5 `CanvasInspector` (`tests/browser/canvas_inspector.js`)
Dual-layer rasterization inspection engine:
- `getPixel(page, x, y)`: Direct RGBA pixel inspection via `ctx.getImageData()`.
- `sampleCircle(page, cx, cy, radius, sampleCount)`: Radial perimeter sampling.
- `isRedTelegraphActive(pixel)`: Strict red dominance detection rejecting Warrior orange (`#ffaa00`, $G \ge 140$) and solid red health bars.
- `installRenderSpy(page)`: Transparent hook on `CanvasRenderingContext2D.prototype.arc/fill/stroke` filtered by AoE coordinates and radius.

---

## 7. Exit Codes Contract

| Exit Code | Classification | Condition |
|---|---|---|
| `0` | **Success** | Tier A Baseline passed (for M1) or target milestone quality gate passed with all criteria satisfied. |
| `1` | **Assertion Failure** | One or more tests failed functional assertions (e.g. unbuilt feature awaiting future milestone). |
| `2` | **Harness Error** | Environmental or infrastructure failure (port collision, ephemeral server spawn failure, missing browser binary). |
| `3` | **Config Error** | Invalid CLI arguments, unknown suite, or malformed flags. |
