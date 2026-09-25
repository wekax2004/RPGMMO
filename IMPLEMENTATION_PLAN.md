# Tibia MMO Implementation Plan

## Purpose

This document is the execution plan for turning the current browser prototype
into a reliable, playable multiplayer game. It is intentionally ordered so a
small coding model can work on one bounded task at a time without guessing at
the architecture.

The project is **not finished yet**. A feature is not complete merely because a
file exists; it is complete only when the server, browser client, bot client,
and tests agree on the same contract.

## Current baseline

Implemented in the first reliability pass:

- Local-first persistence in `server/persistence.js`.
- Atomic JSON writes and a global serialized write queue.
- Graceful server shutdown with persistence flushing.
- `PORT`, `TIBIA_DB_DRIVER`, and `TIBIA_DB_FILE` environment configuration.
- Server-authoritative subclass progression and canonical stat modifiers.
- Server-authoritative quest giver/prerequisite validation.
- Party invite storage and party synchronization.
- Server-authoritative trade request, staging, lock, confirm, and atomic swap.
- Validated finite integer trade gold.
- Boss AoE packet IDs and explicit warning/impact lifecycle.
- Regression tests in `tests/unit/core.test.js`.
- Browser and bot acceptance tests aligned with the new protocol.

The current automated acceptance run is expected to cover AC1-AC7. It is a
milestone gate, not a claim that the game is production-ready.

Latest hardening pass also added:

- participant-authorized trade cancellation;
- atomic batch trade-offer validation;
- automatic trade cancellation when players move apart;
- browser trade request acceptance, item staging, lock, confirm, and final
  inventory/gold assertions;
- explicit trade request/party compatibility packets;
- draining shutdown with quiesced intervals and flush status;
- dedicated-server enforcement for persistence acceptance tests;
- fatal test-runner errors and empty-result protection;
- stricter test-server readiness and browser process cleanup;
- character-name validation, CSP/security headers, and canonical persistence
  keys;
- matching AoE warning/impact IDs, geometry telemetry, and post-impact damage
  assertions;
- server-side RSS metrics and load-test sampling;
- party leave synchronization and strict quest/trade/boss oracles.

## Visual migration track

The third-party RPG repository was inspected and its assets are staged locally
under `client/assets/rpg-import/` for evaluation only. The repository had no
root license file, so the assets are ignored by Git and are not loaded by the
production client yet. See `docs/ASSET_IMPORT.md`.

The preferred integration is to port the sprite manifest, dithering/asset
processing ideas, and oblique/2.5D depth sorting into the current
server-authoritative client, while retaining the current server, persistence,
authentication, and tests.

## Agent operating rules

1. Work on one task ID per change.
2. Read the task's listed files and nearby tests before editing.
3. Do not add dependencies unless the task explicitly requires one.
4. Do not expose credentials, API keys, or private player data.
5. Preserve the existing CommonJS server style until the module migration is
   deliberately planned.
6. Never make a test pass by weakening an assertion or returning a fake
   success. Tests must exercise the real server or a documented pure module.
7. Add or update a regression test with every gameplay/protocol change.
8. Run the smallest relevant test first, then the broader suite.
9. Record changed files, test commands, and unresolved risks in the handoff.

## Phase 0 — Baseline and delivery hygiene

### P0.1 — Establish source control

- Initialize Git if the owner wants version control.
- Add a root `.gitignore` for:
  - `node_modules/`
  - `.agents/`
  - generated snapshots
  - local database files
  - browser profiles and logs
- Create a tagged baseline after the owner confirms which historical artifacts
  are canonical.

**Done when:** a clean checkout can install dependencies and run the test
commands without historical agent files.

### P0.2 — Make test commands authoritative

Root scripts must remain:

```powershell
npm test
npm run test:baseline
npm run test:acceptance
npm run test:browser
npm run test:bots
```

Each test server must use an isolated port and isolated persistence file.

**Done when:** two test runs cannot overwrite each other's player data.

### P0.3 — Add a protocol document

Document every request and response packet in `docs/PROTOCOL.md`. Include
field types, required fields, and compatibility aliases.

## Phase 1 — Persistence and session safety

### P1.1 — Persistence adapter boundary

Keep the `loadPlayer`, `savePlayer`, and `flush` interface. Implement adapters:

```text
server/persistence/
  index.js
  local_json.js
  firebase_admin.js
```

The Firebase adapter must use Admin SDK credentials or workload identity. Never
use a browser API key as server authentication.

**Acceptance:**

- A cold restart preserves level, XP, gold, inventory, equipment, quests, and
  subclass.
- Two players saving concurrently both survive.
- A storage failure is visible in logs and does not silently become a new
  character.
- A shutdown flush completes before the process exits.

### P1.2 — Authentication and ownership

Add an account/session token before exposing the server outside localhost.

- Authenticate before character login.
- Bind character IDs to account IDs.
- Reject duplicate active sessions.
- Add session expiration and reconnect tokens.
- Rate-limit login and failed authentication.

### P1.3 — Input boundary validation

Create `server/validation.js` and validate at the WebSocket boundary:

- message size;
- action allow-list;
- string length and trimming;
- finite numeric coordinates;
- integer gold and quantities;
- IDs and enum values;
- rate limits per connection and per account.

Invalid packets must receive a structured error and must not reach gameplay
handlers.

## Phase 2 — Shared protocol and domain modules

### P2.1 — Shared packet constants

Create a shared module usable by server and tests. The browser may load a
served copy until a bundler is introduced.

Standardize these names:

```text
trade_requested
trade_open
trade_update
trade_locked
trade_complete
trade_close

party_invited
party_sync
party_decline

aoe_warning
aoe_impact

subclassId
classType
quest_id
npc_id
```

Remove compatibility aliases only after all clients and tests use the canonical
name.

### P2.2 — Extract server domains

Split `server/server.js` into modules without changing behavior first:

```text
server/systems/movement.js
server/systems/combat.js
server/systems/inventory.js
server/systems/quests.js
server/systems/trade.js
server/systems/party.js
server/systems/bosses.js
server/network/packets.js
server/persistence/
```

Each module should expose pure state transitions where possible.

### P2.3 — Contract tests

For each packet, test:

- a valid request;
- invalid field types;
- unauthorized target;
- duplicate/out-of-order messages;
- the corresponding client state update.

## Phase 3 — Playable vertical slice

Implement and test this exact loop before adding broad content:

```text
login
  -> move
  -> select a monster
  -> attack
  -> receive damage/XP
  -> collect loot
  -> gain a level
  -> disconnect
  -> reconnect with state intact
```

### P3.1 — Movement and collision

- Keep server validation authoritative.
- Reject diagonal, out-of-bounds, non-tile, and too-fast movement.
- Add a movement sequence number to reject stale packets.
- Add server-side collision reservation if needed for high-speed clients.

### P3.2 — Combat and death

- Centralize damage calculation.
- Apply subclass and equipment modifiers in one place.
- Resolve death exactly once.
- Reset status effects and position atomically.
- Record killer and reward recipients.

### P3.3 — Inventory and equipment

- Define capacity and stack rules.
- Validate item definitions server-side.
- Make equip/unequip/use transitions atomic.
- Add inventory contract tests.

## Phase 4 — Quests, NPCs, and subclasses

### P4.1 — Quest graph

- Every NPC explicitly lists offered quests.
- Every quest has one giver, prerequisites, objectives, and rewards.
- Acceptance requires the correct NPC and distance.
- Completion requires an authoritative objective check.
- Support multi-step quests and lock contradictory branches.

### P4.2 — Subclasses

- Use one canonical modifier schema.
- Recalculate stats from base values; never multiply an already modified value.
- Gate evolution by the documented level requirement.
- Implement one subclass ability at a time with cooldown, mana, range, and
  server-side target validation.

### P4.3 — NPCs and dialogue

- Add dialogue state as explicit packets, not inferred UI state.
- Include quest IDs and descriptions in a stable schema.
- Close dialogue state on disconnect or map change.

## Phase 5 — Multiplayer state machines

### P5.1 — Party

Implement:

```text
create -> invite -> accept -> synchronize -> chat/share XP -> leave/disband
```

Rules:

- Only a stored invite can be accepted.
- One party per player.
- Leader migration is deterministic.
- Disconnect removes the member.
- Party chat is isolated.
- Nearby party members share XP exactly once.

### P5.2 — Trade

Implement:

```text
request -> accept -> stage -> mutual lock -> confirm -> atomic commit
```

Rules:

- Escrow or validate all staged items.
- Gold is a non-negative safe integer.
- A locked offer cannot change.
- Distance and online state are checked at commit.
- Any mutation occurs only after all validation succeeds.
- Disconnect, movement beyond range, or cancellation aborts safely.
- Never dereference a trade after deleting it.

### P5.3 — Chat

- Support `global`, `party`, `zone`, and explicitly implemented trade/help
  channels only.
- Enforce length and rate limits.
- Include sender, channel, timestamp, and message ID.
- Display chat in the browser client.

## Phase 6 — Bosses and content

### P6.1 — Boss ability framework

Every ability defines:

- spell ID;
- warning duration;
- frozen origin/target geometry;
- detonation time;
- damage/effect;
- affected-area query;
- cleanup behavior.

The client may render only a server-issued AoE ID. It must never invent the
identifier.

### P6.2 — Boss rewards

- Use one reward function for normal mobs and bosses.
- Do not award XP as gold accidentally.
- Roll loot once.
- Update quests once.
- Respawn through a scheduler, not an unscoped timer.

## Phase 7 — Scaling and networking

### P7.1 — Area of interest

Replace full-world broadcasts with spatial cells or zones.

- Send only relevant entities.
- Send deltas, not complete world snapshots.
- Cull entities outside the client viewport.
- Track per-client queues and backpressure.

### P7.2 — Server performance

Measure on the server process:

- event-loop delay;
- tick duration;
- active entity count;
- packet throughput;
- memory/RSS;
- slow-client queue depth.

Do not use client RSS as a server performance metric.

## Phase 8 — Operations and release

### P8.1 — Configuration

Use environment variables for:

```text
PORT
HOST
TIBIA_DB_DRIVER
TIBIA_DB_FILE
FIREBASE_PROJECT_ID
TIBIA_TEST_MODE
```

Fail fast on invalid production configuration.

### P8.2 — Deployment

- Add a production process manager or container definition.
- Add health and readiness endpoints.
- Add structured logs and log rotation.
- Add backup/restore instructions for persistence.
- Document a rollback procedure.

### P8.3 — Release gate

A release is blocked until:

- unit tests pass;
- all acceptance tests pass;
- persistence restart tests pass;
- a clean install works;
- no test-only action is enabled in production;
- no hard-coded secret is present;
- protocol documentation matches the code.

## Suggested agent assignments

### Agent A — persistence/session

Tasks: P1.1, P1.2, P1.3. Do not work on gameplay modules in the same change.

### Agent B — protocol/network

Tasks: P0.3, P2.1, P2.3. Keep packet names and schemas consistent.

### Agent C — gameplay

Tasks: P3, P4, P6. Require unit and browser tests for every state transition.

### Agent D — multiplayer

Tasks: P5. Require adversarial tests for unauthorized, stale, duplicate, and
out-of-order messages.

### Agent E — performance/release

Tasks: P7 and P8. Measure first, then optimize; do not change gameplay silently.

## Handoff template

Every agent should leave a report containing:

```text
Task ID:
Files changed:
Behavior before:
Behavior after:
Tests run:
Test results:
Known limitations:
Follow-up tasks:
```

## Definition of done for the project

The MMO is not done until a new player can create an account, log in, explore,
fight, complete quests, choose a subclass, form a party, trade safely, survive
boss attacks, disconnect, reconnect after a server restart, and play with other
users without corrupting state or leaking private data.
