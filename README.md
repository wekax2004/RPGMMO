# Tibia MMO Prototype

A browser MMORPG in the style of Tibia: a persistent world, a tile map, mobs,
quests, bosses, and players who meet in it. Vanilla JavaScript and a 2D canvas on
the client; Node and SQLite on the server. No build step, no framework, no
bundler.

**Still a prototype.** Do not expose the current server to the public internet.
Sessions are in-memory, tokens travel inside WebSocket messages, and there is no
TLS termination. See [Current status](#current-status).

## Requirements

- Node.js 22.12 or newer
- Chrome or Edge, for the browser acceptance tests
- Python with Pillow, only if you are working on sprites

## Install

Run from the repository root:

```powershell
npm ci
npm --prefix server ci
```

`server/` has its own `package.json` because `sqlite3` is a native module and
installing it separately keeps the failure contained if a prebuilt binary is not
available for your platform.

## Run

```powershell
npm start
```

Then open <http://localhost:8080/>.

### Configuration

Everything is environment variables. Nothing needs to be set to run locally.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` only behind a firewall and TLS proxy |
| `TIBIA_DB_DRIVER` | `sqlite` | `firebase` is available but not the default |
| `TIBIA_DB_FILE` | `server/data/tibia.sqlite` | |
| `TIBIA_TEST_MODE` | unset | Enables `test_*` actions. Leave unset in production |
| `TIBIA_DB_ALLOW_LOCAL_FALLBACK` | unset | Firestore is fail-fast unless this is set |

## Tests

```powershell
npm test                # 200 unit tests
npm run test:baseline   # harness self-checks, 50-bot load
npm run test:acceptance # 7 acceptance criteria
npm run test:browser    # AC1-AC5 in a real browser
npm run test:bots       # party chat, persistence across restart
```

**Run them one at a time.** The suites bind fixed ports and will collide with each
other if run in parallel. `npm test` is the only one safe to run alongside
another.

The acceptance runner starts its own ephemeral servers and databases, so it does
not touch `server/data/`.

### Verification tools

These are checks rather than tests, and they are cheap to run:

```powershell
node tools/check_config_keys.js          # every CFG.* reference resolves
node tools/check_encoding.js             # no BOM, no mojibake
node tools/check_hash_comments.js        # Node 25 rejects # comments in .js
node tools/check_doc_paths.js            # PROJECT.md describes files that exist
node tools/check_doc_claims.js           # PROJECT.md's numbers match the repo
node tools/check_asset_integrity.js      # committed sprites match HEAD
node tools/check_asset_licensing.js      # unlicensed assets are not tracked
node tools/selftest_check_doc_paths.js   # proves the check above actually fires
node tools/mutate_zlevels.js             # 21 mutations, must all be caught
node tools/mutate_ac5.js                 # 11 mutations, must all be caught
python tools/audit_unreferenced_assets.py  # what in client/assets loads nothing
node tools/pack_source.js out.zip        # source-only archive, no secrets or art
```

The two mutation harnesses are the ones worth running after any change to
traversal, floors, or boss targeting. They re-inject each bug that was found and
fixed and fail if the suite does not catch it — a green suite on its own proves
nothing, because a decorative assertion is also green.

## Project layout

```text
client/                 Browser client: HTML, CSS, three JS modules
client/assets/          Sprites and tiles, 149 files, 97.7 MB (83% unused)
server/                 Entry point plus 22 flat domain modules
server/data/            Live database (gitignored)
tests/unit/             200 unit tests
tests/browser/          Puppeteer acceptance tests, AC1-AC5
tests/bots/             Headless WebSocket clients
tools/                  Mutation harnesses, sprite pipeline, integrity guards
docs/PROTOCOL.md        The implemented wire contract
PROJECT.md              Architecture, design decisions, and known debt
CREDITS.md              Asset licences and provenance
```

`PROJECT.md` is the place to start. It records the decisions in this codebase
that look like mistakes — why `dist()` and `dist3D()` are two functions, why `z`
is always a trailing argument, why `Set-Content` corrupts files here — so they
are not "fixed" by someone who does not know why.

## Sprites

Art is drawn on a magenta backdrop and keyed to transparency at load time by the
renderer. Two consequences worth knowing before you touch anything:

- A magenta-heavy JPEG in `client/assets/` is the **intended** state, not
  corruption. An absolute "too much magenta" check will flag every sprite.
- `tools/check_asset_integrity.js` compares committed sprites against git rather
  than inspecting their pixels, because git knows the last committed byte of
  every file and no threshold can tell "supposed to be magenta" from "someone
  copied a raw source over a finished asset".

To cut new sprites from a sheet:

```powershell
python tools/sprite_sheet_index.py sheet.png indexed.png   # find a tile by eye
python tools/slice_sprite.py --sheet sheet.png --at COL,ROW --out name.png --region 1 --autocrop
```

`--region` is per-creature and is the fiddly part. Too small decapitates a
creature drawn taller than its row; too large swallows its neighbour.

## Current status

Delivered and covered by automated tests: the world and its floors, mobs, bosses
with telegraphed AoE, quests and dialogue, items and crafting, trade, party,
guild, auction, subclasses, and accounts with scrypt-hashed passwords.

Not done, and worth knowing before you rely on any of it:

- **`server/server.js` is a ~2,600-line monolith** with ~59 packet branches in
  one handler. The domain modules are split out and testable, but the dispatch
  layer is not.
- **No area-of-interest sync.** Every client on a floor receives that floor's
  full roster every 200 ms. Fine at the tested scale of 50 bots; it is the first
  thing that will need to change for more.
- **Sessions are in-memory.** One process only, and tokens need TLS.
- **`client/assets/` is 83% unused** — 81.1 MB of 97.7 MB that nothing loads.
  Most of it is harmless (sprite-pipeline sources and duplicates), but
  **`rpg-import/` (56.3 MB) is a licensing problem, not clutter.** This project's
  own `docs/ASSET_IMPORT.md` says those files must not be published, and they
  have been on `origin/main` since the initial commit. The source repository has
  no licence file. See `PROJECT.md` → *Known Licence Issues*.
- **`ui.js` is not audited for escaping.** `engine.js` is consistent; the panels
  have not been reviewed.

`PROJECT.md` carries the full list with detail.
