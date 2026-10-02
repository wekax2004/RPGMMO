# Roadmap status

Tracks the "Prototype → Polished Game" roadmap against the repository as it
actually is. Every claim here is checked against the tree, not against the original
plan, because a substantial part of the plan was written before the work started
and no longer describes reality.

**Legend.** ✅ done and verified · 🔶 partially done · ⬜ not started · ❌ declined
or deliberately not done

Owner tags from the original plan: 🎨 frontend · ⚙️ backend · 🤝 both

Last reviewed: 2026-10-02, at commit 074adf7 plus the server.js extraction.

---

## Stage 1 — Bug fixes and cleanup

| # | Task | Status | Notes |
|---|---|---|---|
| 1.1 | Duplicate keybindings | ✅ | `tests/unit/keybindings.test.js` (7), 12 mutations. The plan's advice was wrong: deleting lines 837-839 removed the class primary spell and the epic's only binding. Fixed the opposite way and pinned it. |
| 1.2 | Remove 6 dead Python scripts | ✅ | Plus `client/warrior.jpg`. PROJECT.md claimed all six hardcoded a dead IDE path; only two did. Doc corrected. |
| 1.3 | Remove 49 unreferenced assets | ❌ | Deliberately not done. It is 116 files / 81.1 MB. Six of the seven "timestamped duplicates" are *not* byte-identical to their twins, and for some art the working tree is the only copy. `audit_unreferenced_assets.py` reports rather than deletes, for good reason. |
| 1.4 | Resolve rpg-import licensing | ❌ | **Owner's decision, raised five times.** 67 files / 56.3 MB, no upstream LICENSE, published on `origin/main` since `f624f26`. Untracking is reversible; a history rewrite is not. |
| 1.5 | Remove `client/warrior.jpg` | ✅ | 556 KB, referenced by nothing. |
| 1.6 | Double `</head>` | ✅ | Already fixed before this review; `head`/`body` pair correctly at lines 3, 7, 9, 328. |

## Stage 2 — Graphics and sprites

| # | Task | Status | Notes |
|---|---|---|---|
| 2.1 | Unique NPC sprites | 🔶 | King Arthur done (owner-generated AI art, tracked, provenance in CREDITS.md). Trainer Aria, Scout Elara, Hermit Frost, Sage Mordecai, Mayor Joe still reuse class sprites. |
| 2.2 | Wire NPC sprites into `renderer.js` | ✅ | Name-based lookup at `renderer.js:253-260`. |
| 2.3 | Terrain variation tiles | ⬜ | |
| 2.4 | Dungeon ambiance / torch glow | ✅ | Floor-tinted background at `renderer.js:108`. |
| 2.5 | Smooth movement interpolation | ✅ | `renderX`/`renderY` lerp. |
| 2.6 | Idle animation frames | ⬜ | Single-frame sprites throughout. |
| 2.7 | Death animation + particles | 🔶 | Particles exist (`renderer.js`); no fade-out or blood. |
| 2.8 | Chest/loot spawn particles | ✅ | |
| 2.9 | Water animation | ⬜ | |
| 2.10 | Item icons for the inventory grid | ⬜ | Grid exists, text only. |

## Stage 3 — UI overhaul

| # | Task | Status | Notes |
|---|---|---|---|
| 3.1 | Paperdoll equipment panel | ✅ | `.paperdoll` / `.eq-slot` in use. |
| 3.2 | Grid inventory | ✅ | `.inv-grid` / `.inv-cell`. |
| 3.3 | Item tooltips | ✅ | `showTooltip`, `moveTooltip`, rarity-safe via `escapeHtml`. |
| 3.4 | Target info panel | ✅ | Name + HP bar. |
| 3.5 | Cooldown indicators | ⬜ | Server sends no `spell_cooldown`. |
| 3.6 | Level-up celebration | ✅ | |
| 3.7 | Death screen | ✅ | Covered by `tests/browser/test_class_preview.js`. |
| 3.8 | Loading screen | ✅ | |
| 3.9 | Responsive layout | 🔶 | Panels collapse; no media queries. |
| 3.10 | Character preview on class select | ✅ | **Was silently blank** until `test_class_preview.js` asserted on painted pixels. |
| 3.11 | Settings panel | 🔶 | Modals exist; no volume sliders. |
| 3.12 | World map (M) | ✅ | |

## Stage 4 — Content

| # | Task | Status | Notes |
|---|---|---|---|
| 4.1 | Z=-3 floor | ✅ | "The Frostmaw Warren", tier 5.5, 0.55 elite. `Z_MIN` already allowed it. Verified by `tests/bots/depth_probe.js` (16 topology checks: contiguous z, terrain, exits, standable tiles, arrival tiles, no oscillation). **The full-stack walk in a real browser is not yet covered** — see below. |
| 4.2 | 5+ quest chains per region | 🔶 | King Arthur only. |
| 4.3 | Dialogue trees for all 8 NPCs | 🔶 | King Arthur only; others fall back to a flat list. |
| 4.4 | More mob types | ✅ | 6 types + 3 bosses + pack spawning. |
| 4.5 | More boss encounters | 🔶 | 3 bosses, not 7. |
| 4.6 | Rare item drops | ⬜ | |
| 4.7 | Achievements | ⬜ | |
| 4.8 | Daily quests | ⬜ | |
| 4.9 | Pet system | ⬜ | |
| 4.10 | Fishing expansion | 🔶 | Fishing and the skill exist; one catch type of interest. |

## Stage 5 — Combat and balance

| # | Task | Status | Notes |
|---|---|---|---|
| 5.1 | Combo system | ⬜ | |
| 5.2 | Mob AI: flee, call for help, patrol | 🔶 | Aggro and approach exist; nothing else. |
| 5.3 | Dodge / block | ⬜ | |
| 5.4 | Status effect visuals | 🔶 | Server sends stacks; client shows no icon or tint. |
| 5.5 | Damage number styling | 🔶 | `fct` renders; no crit/heal distinction. |
| 5.6 | PvP arena | ⬜ | |
| 5.7 | 4 abilities per class | 🔶 | 2 active + 1 epic (key R). |
| 5.8 | Balance pass | ⬜ | `spell_xp_rate_probe.js` exists to inform it. |

## Stage 6 — Social

| # | Task | Status | Notes |
|---|---|---|---|
| 6.1 | Whisper / PM | ⬜ | Absent. `ratelimit.js` reserves a budget class for it. |
| 6.2 | Friends list | ⬜ | |
| 6.3 | Guild bank | ⬜ | |
| 6.4 | Guild ranks | ⬜ | `guilds.js` is flat membership. |
| 6.5 | Emotes | ⬜ | |
| 6.6 | Player inspection | ⬜ | |
| 6.7 | Leaderboard | ⬜ | |
| 6.8 | Chat timestamps, mentions, history | ✅ | Plus a `\b` anchor bug fixed: a name ending in `-` could never be highlighted. |

## Stage 7 — Infrastructure

| # | Task | Status | Notes |
|---|---|---|---|
| 7.1 | Split `server.js` | 🔶 | **In progress.** 2695 lines → 2605: test actions extracted to `server/testing.js`, verified by `tests/bots/testing_actions_probe.js` (13 checks). Movement, combat, trade, guild, auction and bank branches remain inline. |
| 7.2 | Spatial AoI | ⬜ | Full-floor roster every 200 ms. |
| 7.3 | Rate limiting beyond auth | ✅ | `server/ratelimit.js`, 7 budget classes, Ollama bounded. 14 mutations + 6 wiring mutations. |
| 7.4 | `ui.js` XSS audit | ✅ | Found a stored XSS in the auction renderer. `xss_sinks` (5) + `chat_render` (14), 16 mutations. |
| 7.5 | TLS / WSS | ⬜ | Deployment concern; no config. |
| 7.6 | Session persistence | ⬜ | In-memory; blocks horizontal scale. |
| 7.7 | Client auto-reconnect | ⬜ | |
| 7.8 | Server metrics | ⬜ | |
| 7.9 | Docker / compose | ⬜ | |

## Stage 8 — Polish

| # | Task | Status | Notes |
|---|---|---|---|
| 8.1 | Title screen | ⬜ | |
| 8.2 | Per-region music | 🔶 | One track per biome via `changeMusic`. |
| 8.3 | Sound effects pass | 🔶 | ~8 SFX. |
| 8.4 | Screen shake | ✅ | Boss impacts. |
| 8.5 | Weather effects | ✅ | Rain/snow, `particleSetting`. |
| 8.6 | Tutorial / onboarding | 🔶 | A first-login modal exists; not guided. |
| 8.7 | Favicon + Open Graph | ⬜ | |
| 8.8 | Performance profiling | ⬜ | |
| 8.9 | Full playtest | ⬜ | |
| 8.10 | Changelog page | ✅ | `client/changelog.html`. |

---

## Verification, and why it is the way it is

A green suite proves nothing on its own: a decorative assertion is also green. Every
non-trivial change here is paired with a mutation harness that re-injects the bug and
fails if the suite does not catch it.

| Harness | Mutations | Covers |
|---|---|---|
| `tools/mutate_keybindings.js` | 12 | keyboard bindings and HUD labels |
| `tools/mutate_xss.js` | 16 | escaping, the character-name charset, chat markup |
| `tools/mutate_ratelimit.js` | 14 | budget maths and classification |
| `tools/mutate_ratelimit_wiring.js` | 6 | that the limiter is actually *called* |
| `tools/mutate_class_preview.js` | 9 + 1 no-op | painted pixels and the death screen |
| `tools/mutate_zlevels.js` | 21 | floor scoping |
| `tools/mutate_ac5.js` | 11 | the browser descent test |

Current: unit 243/243 · baseline 5/5 · acceptance 7/7 · browser 6/6 · bots 3/3.

Two lessons from building them, kept because they generalise:

- **A test that reports correct code as broken gets ignored, and then the real bug
  ships.** The XSS rule flagged nine false positives before it was scoped to
  functions that actually write HTML; the class-preview harness listed a mutation
  that turned out not to change behaviour at all.
- **A copy cannot test its original.** `chat_render.test.js` mirrors renderChat's
  logic, so deleting `escapeRegExp` from the real source left every test green. The
  source-level assertions were added afterwards for exactly that reason.

## Two things to decide

1. **`rpg-import/` (1.4).** Five times raised. It is published and unlicensed. The
   only remaining question is whether the art is yours to license.
2. **Cross-floor rules.** Unanswered for weeks: should trade and PvP require the
   same floor? Is chat global? The code currently permits both, and the cross-floor
   guards added for combat were not applied to trade.

## Known gaps in this tracker

Recorded rather than buried, because a status file that claims completeness is
worse than none.

**The three-floor walk is verified structurally, not by walking it.** The topology
probe checks that every link between adjacent floors exists, that no exit has a
matching transition above it, and that every transition tile and arrival tile is
walkable. It does not walk. A browser version was written and reverted: it reached
z=-1 and could not reliably click through to z=-2, and shipping a test I had not got
passing would be worse than shipping none. The likely cause is that the deeper
transitions sit inside populated caves, where the client's click can become an
attack if a mob is on the tile. That is a real usability question for a player as
much as a test one, and is worth investigating on its own.

**Three floors, but the dungeon content does not scale with depth.** Floors -1 and
-2 already existed and are lightly populated relative to the map; -3 adds 16 mobs in
a 16x16 room. Difficulty rises with `tier` but density does not.

**`descendsVia` in config.js is inert.** It is declared per floor and read by nothing.
Transitions are derived in `map.js placeTraversalTiles()` by pairing adjacent floors.
It reads like it controls how a floor is entered, and anyone trusting it will be
wrong. Either implement it or delete it.