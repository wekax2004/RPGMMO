# Project: Tibia MMORPG

> **This document describes the code as it is, not as it was planned to be.**
>
> An earlier version of this file described a target architecture —
> `server/engine/`, `server/network/`, `server/systems/`, `server/world/`,
> `server/multiplayer/`, a spatial AoI grid, hybrid Firebase persistence — and
> listed test files at paths that do not exist. None of that was ever built. The
> file was aspirational and unlabelled enough that a reader would reasonably
> assume it was a map of the repository. It was rewritten on 2026-09-30 against
> the actual tree.
>
> The gap between that document and the code is recorded honestly in
> [Not Built](#not-built) below, rather than left for someone to discover.

## What this is

A browser MMORPG in the style of Tibia: a persistent world, a tile map, mobs,
quests, bosses, and players who meet in it. Vanilla JavaScript and a 2D canvas
on the client; Node and SQLite on the server. No build step, no framework, no
bundler — `npm start` and open a browser.

## Architecture

### Server

One entry point, `server/server.js`, owns the WebSocket server, the static file
server, and the periodic ticks. It is large (~2,600 lines) and that is a real
maintainability cost, recorded under [Known Debt](#known-debt).

The domain logic is split into modules that `server.js` composes. Each is
directly testable because none of them require a socket.

| Module | Responsibility |
|---|---|
| `server.js` | Entry point, HTTP + WebSocket, packet dispatch, tick loops |
| `config.js` | Every tunable constant. Contains Hebrew comments |
| `map.js` | Floor registry, walkability, biomes, traversal tiles, Z-levels |
| `mobs.js` | Mob types, stats, spawn packs, movement, standard AI |
| `bosses.js` | Boss definitions, phase machine, telegraphed AoE, minions |
| `combat.js` | Damage formulas, targeting, death. A dependency-injected factory |
| `chests.js` | Loot containers, floor-scoped |
| `quests.js` | Quest chains, progress, rewards |
| `npcs.js` | NPC definitions and dialogue trees |
| `items.js` | Item catalogue, equipment slots, rarity |
| `skills.js` / `subclasses.js` | Skill costs, subclass promotion and stats |
| `trade.js` | Secure player-to-player trade state machine |
| `party.js` | Party membership, invites, shared XP |
| `guilds.js` | Guild creation, invites, membership |
| `auction.js` | Player listings, escrow, expiry |
| `crafting.js` | Recipes and inventory consumption |
| `persistence.js` | Save scheduling, dirty tracking, shutdown drain |
| `database.js` | SQLite access |
| `db_firebase.js` | Optional Firestore adapter, off by default |
| `auth.js` | Account registration and login, scrypt hashing |
| `ollama.js` | Optional local-LLM integration |

### Client

| File | Responsibility |
|---|---|
| `client/test_client.html` | Markup, HUD panels, modals |
| `client/js/engine.js` | Socket, packet handling, input, movement, player state |
| `client/js/renderer.js` | Canvas drawing, sprite loading, minimap, Z-level lighting |
| `client/js/ui.js` | Panels, chat, trade window, inventory |

### Testing

| Path | What it does |
|---|---|
| `tests/unit/` | 207 unit tests across 12 files. `npm test` |
| `tests/e2e_runner.js` | Master runner: `--suite=baseline\|acceptance\|browser\|bots` |
| `tests/browser/` | Puppeteer acceptance tests, AC1–AC5 |
| `tests/bots/` | Headless WebSocket clients: 50-bot load, party chat, persistence |
| `tests/lib/` | Server lifecycle controller, preload, test framework |
| `tests/traversal_live_verify.js` | Live end-to-end check of the Z-level walk |
| `tests/ground_aoe_live_verify.js` | Live check of ground AoE resolution |
| `tests/skills_live_verify.js` | Live check of skill cost and effect |
| `tests/skull_live_verify.js` | Live check of the skull timer |
| `tests/corpse_trade_live_verify.js` | Live check of looting and trading |
| `tests/features4_live_verify.js` | Live check of mount, auction and fishing |
| `tests/adversarial_challenge.js` | Adversarial white-box probes |
| `tools/mutate_zlevels.js` | 21 mutations against the Z-level suite |
| `tools/mutate_ac5.js` | 11 mutations against the browser descent test |
| `tools/mutate_keybindings.js` | 12 mutations against the keybinding suite |

Harnesses whose name starts `*_probe.js` — `traversal_probe.js`,
`spell_xp_rate_probe.js`, `wal_checkpoint_probe.js`, `auction_restart_probe.js` —
are small diagnostics run individually rather than as suite members.

## Running it

```
npm install
npm start          # server on :8080
npm test           # 207 unit tests
```

`server/` has its own `package.json` and needs `npm install` in that directory
for `sqlite3`.

The five browser acceptance suites:

```
npm run test:browser      # all of AC1-AC5
npm run test:baseline
npm run test:acceptance
npm run test:bots
```

Run them **one at a time.** They bind fixed ports and will collide with each
other; `npm test` is the only one safe to run concurrently.

### Verification tools

```
node tools/pack_source.js <out.zip>    # source-only archive, excludes secrets and art
python tools/slice_sprite.py --help     # cut a sprite from a sheet, key magenta
node tools/check_asset_integrity.js    # committed sprites match HEAD
python tools/audit_unreferenced_assets.py  # what in client/assets is loaded by nothing
node tools/check_config_keys.js        # every CFG.* reference resolves
node tools/check_encoding.js           # no BOM, no mojibake
node tools/check_hash_comments.js      # Node 25 rejects # comments in .js
```

## Code Layout

The tree as it is, not as it was planned. `tools/check_doc_paths.js` verifies
every path below exists, so this cannot drift into describing structure that was
never built.

```
tibia_mmo/
├── server/
│   ├── server.js              # entry point, HTTP + WebSocket, dispatch, ticks
│   ├── config.js              # every tunable constant (Hebrew comments)
│   ├── map.js                 # floor registry, walkability, traversal, Z-levels
│   ├── mobs.js                # mob types, stats, spawn packs, movement, AI
│   ├── bosses.js              # boss defs, phases, telegraphed AoE, minions
│   ├── combat.js              # damage, targeting, death (DI factory)
│   ├── chests.js              # loot containers, floor-scoped
│   ├── quests.js              # quest chains, progress, rewards
│   ├── npcs.js                # NPC definitions and dialogue trees
│   ├── items.js               # catalogue, equipment slots, rarity
│   ├── skills.js              # skill costs and effects
│   ├── subclasses.js          # promotion and stat scaling
│   ├── trade.js               # secure trade state machine
│   ├── party.js               # party membership and shared XP
│   ├── guilds.js              # guilds, invites, membership
│   ├── auction.js             # listings, escrow, expiry
│   ├── crafting.js            # recipes, inventory consumption
│   ├── persistence.js         # save scheduling, dirty tracking, shutdown drain
│   ├── database.js            # SQLite access
│   ├── db_firebase.js         # optional Firestore adapter, off by default
│   ├── auth.js                # accounts, scrypt hashing
│   ├── ollama.js              # optional local-LLM integration
│   ├── migrate_to_sqlite.js   # one-off JSON to SQLite migration
│   └── data/                  # live database (gitignored)
├── client/
│   ├── test_client.html       # markup, HUD panels, modals
│   ├── css/style.css
│   ├── js/engine.js           # socket, packets, input, movement, player state
│   ├── js/renderer.js         # canvas drawing, sprites, minimap, Z-level light
│   ├── js/ui.js               # panels, chat, trade window, inventory
│   └── assets/                # 149 files, 97.7 MB (81.1 MB loaded by nothing)
├── tests/
│   ├── e2e_runner.js          # master runner for all four suites
│   ├── unit/                  # 207 tests across 12 files
│   ├── browser/               # AC1-AC5, driver, canvas inspector
│   ├── bots/                  # bot client, 50-bot load, party chat, persistence
│   └── lib/                   # server controller, preload, test framework
├── tools/                     # mutation harnesses, sprite pipeline, guards
├── docs/PROTOCOL.md           # implemented wire contract
├── CREDITS.md                 # asset licences and provenance
├── TEST_INFRA.md              # test architecture
└── PROJECT.md                 # this file
```

## Design decisions that look like mistakes

These are deliberate. Changing them reintroduces bugs that are already fixed and
tested.

- **`dist()` is floor-unaware; `dist3D()` is the floor-aware form.** Two names on
  purpose. `dist3D` returns `Infinity` across a floor boundary, so an existing
  `<= RANGE` guard rejects a cross-floor target with no second condition.
- **`z` is always a trailing parameter**, never inserted positionally. So
  `spawnMobAt(x, y, type, broadcast, z = 0)` kept its meaning.
- **`broadcast()` is untouched; `broadcastToFloor(z, packet)` is separate.**
  Anything carrying a world coordinate or describing an entity must use the
  floor-scoped form. A packet naming a victim belongs to that victim's floor.
- **`Set-Content` corrupts files here.** It adds a BOM and double-encodes the
  Hebrew comments in `config.js`. Use the editor, or Node, or `apply_patch`.
- **A `#` comment is a syntax error in a `.js` file on Node 25.** Use `//` or
  `/* */`. Python tools are unaffected.
- **`client/assets/` art is magenta-backed on purpose.** The renderer keys
  magenta to transparency at load. A magenta-heavy JPEG is the intended state,
  not corruption.

## Not Built

Each of these was described in the earlier version of this file. None exists.

- **Spatial AoI grid.** There is no `aoi_grid.js` and no spatial partitioning.
  `players_sync` is sent per floor every 200ms to every client on that floor.
  Broadcast cost is O(N) per packet, not O(N²) — at the tested scale of 50 bots
  this is not a bottleneck, and it is not implemented as a workaround for one.
- **`server/engine/game_loop.js`.** No unified tick loop. `server.js` calls
  `scheduleServerInterval` for each concern separately.
- **`server/network/packet_dispatcher.js`.** No dispatcher. `server.js` has
  roughly 59 `data.action ===` branches in one handler.
- **`server/persistence/db_adapter.js` with Firebase primary.** The real
  arrangement is SQLite, with `db_firebase.js` available but not enabled.
- **`server/entities/`, `server/systems/`, `server/world/`, `server/content/`,
  `server/multiplayer/`.** None of these directories exist. The equivalent
  modules are flat under `server/`.
- **The test files listed in the old layout.** `tests/e2e/test_runner.js`,
  `tests/bots/headless_bot_load.js`, `tests/bots/party_chat_bot.js`,
  `tests/bots/persistence_restart_bot.js` and
  `tests/browser/browser_acceptance.js` do not exist. The real ones are listed
  under [Testing](#testing).

## Known Licence Issues

### `client/assets/rpg-import/` is published and should not be

67 files, 56.3 MB, imported from `https://github.com/wekax2004/RPG`
(`public/assets/`, commit `acf42ef3`).

`docs/ASSET_IMPORT.md` says the import is "intentionally ignored by Git until
licensing is confirmed" and that, absent a root `LICENSE` in the source
repository, "the files must not be published or distributed yet". Neither
condition held:

- **It is published.** Present on `origin/main` since the initial commit
  `f624f26` (2026-09-25). `.gitignore` never listed it, so `git add` picked it
  up with everything else.
- **The source has no licence.** The GitHub API reports `"license": null` for
  `wekax2004/RPG`.
- **Nothing uses it.** No line of client or server code references
  `rpg-import`. The game renders through the procedural renderer and its own
  sprites.

The violation is the project's own stated rule, not an external standard.

**Resolving it is the owner's decision**, because it depends on facts about
ownership that are not in this repository:

1. If the art is yours, licence it in the source repository, add attribution
   here, and keep the assets.
2. If ownership is unclear, remove them — from the working tree *and* from
   history.

Deleting the files in a normal commit stops them being served and stops the
problem growing, but **does not unpublish them**: the blobs remain in git
history and anyone who has already cloned has them. Unpublishing requires
`git filter-repo` plus a force-push, which rewrites every commit from
`f624f26` onward and invalidates existing clones. That is a deliberate,
irreversible action and is not taken here.

The audit tool reports this directory by name so it cannot be swept up in a
general asset cleanup without the licence question being answered first.

## Known Debt

Ordered roughly by cost to fix.

1. **`server.js` is a ~2,600-line monolith** with ~59 packet branches in one
   async handler, plus the game loops, login and broadcast logic. The split is
   real work and is not started.
2. **`client/warrior.jpg` is a 556 KB duplicate** sitting loose in `client/`
   rather than in `client/assets/`, referenced by nothing.
3. **81.1 MB of the 97.7 MB committed in `client/assets/` is loaded by nothing**
   — 83%. Most of that is benign (the magenta sources the sprite pipeline
   consumes, 9.5 MB; timestamped duplicates, 4.9 MB; superseded leftovers,
   10.4 MB). Run `python tools/audit_unreferenced_assets.py --list`.

   **One item is not benign.** `client/assets/rpg-import/` — 67 files, 56.3 MB —
   is a third-party import that `docs/ASSET_IMPORT.md` states must not be
   published, and it is: it has been on `origin/main` since the initial commit
   `f624f26`, because `.gitignore` never listed it. The source repository has no
   licence file (GitHub reports `"license": null`). Nothing in the client or
   server loads any of it. **This is a licensing question, not a cleanup task**,
   and removing it from the working tree would not unpublish it — that needs a
   history rewrite. See [Known Licence Issues](#known-licence-issues).
4. **Six background-removal scripts at the repo root** (`fix_bg.py`,
   `perfect_bg.py`, `process_all_magenta.py`, `remove_bg.py`,
   `remove_bg_smart.py`, `remove_magenta.py`) hardcode a GUID path inside an
   IDE scratch directory. They record what was done; they cannot be re-run.
   `tools/slice_sprite.py` supersedes them for new work.
5. **`ui.js` innerHTML is not audited.** `engine.js` escapes consistently and
   `check_asset_integrity` covers assets, but player-controlled strings reaching
   `ui.js` panels have not been reviewed.
6. **Sessions are in-memory.** Correct for one process; blocks horizontal
   scaling. Tokens travel inside WebSocket messages, so deployment needs TLS.
7. **Ollama is hardcoded** to `127.0.0.1:11434` with a fallback model.

## Feature Inventory

Delivered. "Verified" means an automated test asserts it, not that it was
observed once.

| Feature | Verified by |
|---|---|
| E2E runner, baseline/acceptance/browser/bots suites | `tests/e2e_runner.js` |
| 50-bot concurrent load | `tests/bots/load_test_50_bots.js` |
| Party formation and party chat | `tests/bots/party_chat_test.js` |
| Persistence across restart | `tests/bots/persistence_test.js` |
| Browser: subclass progression | AC1 |
| Browser: boss AoE telegraph | AC2 |
| Browser: NPC dialogue and quests | AC3 |
| Browser: secure trade | AC4 |
| Browser: Z-level descent and ascent | AC5 |
| Subclass progression and stats | `tests/unit/` |
| Multi-biome world | `tests/unit/core.test.js` |
| Quest chains and journal | `tests/unit/quests_dialogue.test.js` |
| Crafting | `tests/unit/crafting.test.js` |
| Auction and mounts | `tests/unit/auction_mount_fish.test.js` |
| Skull system | `tests/unit/skull.test.js` |
| **Z-levels: 2 underground floors, traversal, cross-floor isolation** | `tests/unit/zlevels.test.js`, `traversal.test.js`, `boss_floors.test.js`, AC5, 21 mutations |
| Account auth, scrypt | `tests/unit/core.test.js` |

## Z-Levels

The most recent substantial work, and the part with the most tests. Two
underground floors (`z=-1` The Bone Crypt, `z=-2` The Molten Depths) reached by
walking onto a ladder.

The rule that governs the whole feature: **a floor index travels with every
entity that can be on a different floor.** A player, a mob, a boss, a corpse, a
chest, a ground drop and a traversal tile each record theirs. Anything that
measures distance between two such entities uses `dist3D`. Anything that tells a
client about one uses `broadcastToFloor`.

This is enforced, not just documented:

- `tests/unit/traversal.test.js` audits the server source for unscoped
  broadcasts, floor-unaware distance calls, and `inSafeZone` calls that do not
  say which floor they mean.
- `tests/unit/boss_floors.test.js` does the same for boss targeting, and pins
  the specific layout overlap that once made it exploitable.
- `tools/mutate_zlevels.js` re-injects each bug that was found and fixed, one at
  a time, and fails if the suite does not catch it. 21 mutations, 21 caught.

Two bugs this found that would not have been found by reading:

- Bosses selected victims by 2D distance across all floors. The Molten Depths
  sits 544×544 inside the Skeleton King's quadrant, so a surface boss could hit a
  player in the cave at identical coordinates.
- `isWalkable`'s third parameter defaults to the *surface*, so a dungeon boss
  was validating every step against city geometry — refusing tiles that are open
  ground above, accepting tiles that are solid rock around it.

## Licence and assets

See `CREDITS.md`. Three boss sprites are derived from the OpenTibia sprite pack
under CC BY 4.0; the rest were generated for this project. Two sprite
collections in the working tree are proprietary CipSoft art and are deliberately
excluded from the repository — altering them does not make them permissive.
