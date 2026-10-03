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
| 2.3 | Terrain variation tiles | ✅ | Flowers and pebbles drawn procedurally on grass tiles. |
| 2.4 | Dungeon ambiance / torch glow | ✅ | Floor-tinted background at `renderer.js:108`. |
| 2.5 | Smooth movement interpolation | ✅ | `renderX`/`renderY` lerp. |
| 2.6 | Idle animation frames | ⬜ | Single-frame sprites throughout. |
| 2.7 | Death animation + particles | ✅ | Blood particle explosion on death, plus death modal. |
| 2.8 | Chest/loot spawn particles | ✅ | |
| 2.9 | Water animation | ✅ | Oscillating wave effect added to renderer. |
| 2.10 | Item icons for the inventory grid | ✅ | Emojis used for inventory cells and paperdoll. |

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
| 3.9 | Responsive layout | ✅ | CSS media queries + canvas click scaling. |
| 3.10 | Character preview on class select | ✅ | **Was silently blank** until `test_class_preview.js` asserted on painted pixels. |
| 3.11 | Settings panel | ✅ | Volume slider wired up. |
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
| 5.4 | Status effect visuals | 🔶 | Local player sprite now displays emoji icons (🤢, 🩸, 💫) for poison, bleed, and stun. Other players/mobs don't yet sync status. |
| 5.5 | Damage number styling | ✅ | Floating combat text (fct) scales dynamically for heals/crits and has shadow outlines. |
| 5.6 | PvP arena | ⬜ | |
| 5.7 | 4 abilities per class | 🔶 | 2 active + 1 epic (key R). |
| 5.8 | Balance pass | ⬜ | `spell_xp_rate_probe.js` exists to inform it. |

## Stage 6 — Social

| # | Task | Status | Notes |
|---|---|---|---|
| 6.1 | Whisper / PM | ✅ | `/w Name message`, plus `channel:'whisper'`. Server and client frontend styling complete! |
| 6.2 | Friends list | ✅ | Fully functional! Supports online and offline friends. |
| 6.3 | Guild bank | ✅ | Fully functional! Bank UI, deposits, and rank-based withdrawals. |
| 6.4 | Guild ranks | ✅ | Server supports `ranks`. Promotes/Demotes wired to new Guild Management UI buttons! |
| 6.5 | Emotes | ✅ | `emote` action broadcasts `fct` packets! |
| 6.6 | Player inspection | ✅ | Fully functional! Request returns equipment/stats to UI. |
| 6.7 | Leaderboard | ✅ | Fully functional! Queries SQLite for top 50 players by level! |
| 6.8 | Chat timestamps, mentions, history | ✅ | Plus a `\b` anchor bug fixed: a name ending in `-` could never be highlighted. |

## Stage 7 — Infrastructure

| # | Task | Status | Notes |
|---|---|---|---|
| 7.1 | Split `server.js` | 🔶 | **In progress.** 2695 → 2605 (testing.js) → 2853 → 2679 → 2646 → **2520**. Done: `testing.js`, `social.js` (8 actions, probe 10), `grouping.js` (15 party+trade, probe 30), `combat_actions.js` (5 combat verbs, probe 12), `inventory.js` (6 inventory/equipment/ground actions, probe 23). Every extraction was snapshotted over real sockets before *and* after and the two runs' verdicts diffed — a source-level test can stay green while the packets change. Remaining: shop/crafting/bank (~240), NPC dialogue (~110), `move` (~95, most invariant-dense — may be deferred). `server.js` stays the entry point owning sockets, tick and player state; dependencies reach it via a `ctx` object rather than imports, so nothing mutable is exported. |
| 7.2 | Spatial AoI | ✅ | **Players and mobs.** Players: `server/aoi.js`, radius 1000 = the minimap's own `MINIMAP_RADIUS`, so nothing visible changes. Measured over real sockets: **47,850 vs 93,480 bytes**, 49% less. Mobs: **SHIPPED OFF** — see below. |
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
| 8.1 | Title screen | ✅ | Exists in engine.js. |
| 8.2 | Per-region music | ✅ | Procedural WebAudio arpeggios added for City, Snow, Desert, and Swamp biomes via `changeMusic`. |
| 8.3 | Sound effects pass | ✅ | Over 10 procedural SFX implemented in `ui.js`. |
| 8.4 | Screen shake | ✅ | Boss impacts. |
| 8.5 | Weather effects | ✅ | Rain/snow, `particleSetting`. |
| 8.6 | Tutorial / onboarding | ✅ | Guided modal added for new players. |
| 8.7 | Favicon + Open Graph | ✅ | Emoji favicon + OG meta tags added. |
| 8.8 | Performance profiling | ✅ | On-screen FPS counter added to `renderer.js`. |
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
| `tools/mutate_aoi.js` | 15 + 1 no-op | the area-of-interest filter, its wiring, and the client prune it depends on |
| `tools/mutate_mob_aoi.js` | 21 | mob filtering, the aggro safety invariant, the removal packet, and the spawn path |
| `tools/mutate_whisper.js` | 21 | whisper parsing, privacy, delivery order, and the rate-limit class |
| `tools/selftest_update_doc_counts.js` | 10 | that the doc-count fixer cannot rewrite a number it was not asked about |
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
- **A check that passes because nothing happened is worse than no check.** The
  whisper probe's first run asserted "a bystander never sees the whisper" and got a
  green tick — while the delivery check beside it was red, because the probe
  whispered to `"Bob"` when the character was named `WhBob_xxxxx`. Nothing was sent
  anywhere, so the privacy assertion was vacuous. It now requires proof that the
  message was in flight first.
- **A failing guard may be reporting on itself.** The whisper mutations showed a
  removed dispatch would leave the feature looking healthy while broadcasting every
  private message on the default channel. The server now refuses a whisper twice, by
  two independent paths, and a mutation deletes the first to keep the second honest.

## Two things to decide

1. **`rpg-import/` (1.4).** Five times raised. It is published and unlicensed. The
   only remaining question is whether the art is yours to license.
2. **Cross-floor rules.** Unanswered for weeks: should trade and PvP require the
   same floor? Is chat global? The code currently permits both, and the cross-floor
   guards added for combat were not applied to trade.

## Known gaps in this tracker

Recorded rather than buried, because a status file that claims completeness is
worse than none.

**Mob AoI is implemented and verified, and ships ON** (`MOB_AOI_RADIUS: 1000`).
It was three commits ago shipped disabled, pending one line in `client/js/engine.js`
to handle the new `mob_forget` packet. It cannot reuse `mob_update` with
`alive:false`, because that means "died" to the client and plays a blood-burst
particle effect - walking out of range would spray blood every time a player turned
around. The frontend session added the handler, `tests/unit/mob_aoi.test.js` asserts
the two halves agree, and the default was then flipped deliberately rather than by
accident. Set `TIBIA_MOB_AOI_RADIUS=0` to get the unfiltered behaviour back.
Measured, same probe both modes: **883 bytes / 5 mobs** filtered vs **6,750 bytes /
46 mobs** unfiltered on the surface. The two runs are separately seeded worlds, so
the ratio is indicative - the controlled version spawns a mob at a known 200px and
2500px and asserts on arrival.

Known limitation, not yet fixed: the `mob_forget` handler in `client/js/engine.js`
does not clear `currentTargetId`. A mob that walks out of range while selected stays
selected in the HUD.

**AoI for bosses, corpses and gathering nodes is not done.** Bosses are three types
with one lair each, so filtering saves nothing measurable and `bosses.js` broadcasts
through an injected callback; corpses and nodes are static and few. All deliberate,
not overlooked.

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

**A "before and after" snapshot that only reads the latest state cannot see a change
in packet count, and one slipped through.** `inventory_probe.js` asserts on the last
`status` packet received. A status is already pushed roughly every 300 ms, so a
handler that *starts* sending one still produces a correct-looking final inventory
and the probe compares equal.

The extraction had added `sendPlayerStatus` after `equip_item` and `unequip_item`,
on the reasonable theory that an inventory change should push the inventory. Nothing
in the probe could see it. `tests/bots/equip_status_count.js` counts packets instead
of reading the latest one, and showed equip going from 4 status packets to 5. The
extra send bought nothing and was removed.

Two rules came out of it:

- **A snapshot needs a second probe that counts, not just one that reads state.**
  Anything asserting on "the latest X" is blind to "how many X".
- **The before/after diff is only as good as what it compares.** Two probes comparing
  the same blind spot will agree on a behaviour change and call it a pass.

**`dismountPlayer` broadcasts `mount_changed`, and `toggle_mount` broadcasts it
again**, so every dismount sends the packet twice. Wasteful rather than wrong, and
left alone on purpose: a refactor that quietly changes the packet count is not a
refactor. `inventory_probe.js` asserts the duplication explicitly, so it cannot be
removed or doubled silently in either direction.

**Four probes have now each failed first for a reason that was the probe's fault,
and the pattern is worth recording.** A test written to compare a "before" and an
"after" run is read hardest when it disagrees, and the tempting move is to loosen the
check until it agrees. All four of these were the check being wrong:

- **Party chat arrives as `action:'chat'`, not `'log'`.** `grouping_probe.js` watched
  only `'log'` and reported that a party message had not been delivered. It had.
- **The trade snapshot is per-viewer.** `myOffer` means *my* offer from the
  *recipient's* side, so Bob's copy of Alice's action shows Bob's empty offer and
  Alice's item in `theirOffer`. The probe read Bob's packet and concluded the handler
  staged nothing. It had staged it correctly, in the other field.
- **An allowlist-style premise about a refusal.** The non-participant cancel reused the
  id of a trade that had already been cancelled, so there was nothing to refuse and the
  silence read as a missing participant guard.
- **`sendProtocolError` sends `action:'log'` with a prefix, not `protocol_error`.**
  `combat_actions_probe.js` asserted on `protocol_error` and read two live refusals as
  silence. Nothing named `protocol_error` is ever sent; the `errors` array in every probe
  is permanently empty, which is exactly the kind of field that makes a check pass for
  the wrong reason.
- **`test_grant_mana` ADDS to current mana.** It does not set it. Granting 24 to a full
  healer leaves them full, so the mana gate read as broken when the healer simply had
  plenty. `test_grant_gold`, by contrast, *does* set (`player.gold = amount`), which is
  why the same probe's gold checks worked while its mana checks did not.

And one more, from item 4, which is the worst shape of all:

- **A comment and a test agreed with each other and both were wrong.** My first draft of
  `inventory.js` claimed `mountPlayer` enforces an inventory precondition, and the first
  probe asserted that claim. `mountPlayer` only checks whether the player is *already*
  mounted — there is no mount item in the catalogue to check against. Because the code
  matched the comment and the test matched the comment, nothing disagreed until the probe
  ran against the real server. **Two agreeing wrong assertions are harder to catch than
  one wrong assertion**, because agreement is the signal people trust.

Three distinct traps:

1. **Reading a field without reading whose field it is** — the per-viewer trade snapshot,
   and the friends `persistPlayer` anchor that survived twice.
2. **Reading a field without reading what fills it, or whether it adds or sets** — the
   `protocol_error` array that is always empty, and `test_grant_mana` versus
   `test_grant_gold`.
3. **Writing the test from the comment rather than the code** — the mount precondition.

All were fixed by going back to the code. A snapshot that has to be loosened to agree
with the thing it is snapshotting is no longer a snapshot.

**A fountain buried the descent ladder, and it is fixed. Kept because the diagnosis
was wrong twice before it was right.**

This entry originally blamed the frontend session's responsive-layout CSS for the
AC5 browser-descent failure. **That was wrong.** The CSS theory was stated with
confidence, twice, and was never tested.

The real cause was an uncommitted `server/map.js` change building a starting town,
which put water tiles at (288,288), (320,288), (288,320) and (320,320). `CFG.LADDER_X`
and `CFG.LADDER_Y` are both **288**, so the fountain landed exactly on the surface
ladder, and (320,320) is the spawn point. Measured consequences at the time:

```
isWalkable(288,288,0)   false     <- the ladder was an obstacle, descent impossible
isWalkable(320,320,0)   false     <- players spawned inside the fountain
hasWaterNear(320,320,32) 4        <- and the spawn point was fishable
```

That is what broke `traversal.test.js:47` and `:125`, `auction_mount_fish.test.js:397`,
and it aborted the `zlevels` mutation harness outright, which refuses to report
"caught" against a red baseline. Proof it was the only cause: with `map.js` reverted
and nothing else touched, the unit suite was 340/340 stable over three consecutive
runs and `zlevels` reported 21/21.

The frontend session moved the fountain to (384,384)-(416,416), off both the ladder
and the spawn. Current state, all measured:

```
isWalkable(288,288,0)   true
isWalkable(320,320,0)   true
unit suite              340/340
AC5 browser descent     34/34 PASS
```

The generic trap is still worth naming, because the next decorative build can hit it
again: anything that adds to `floor.obstacles` after `placeTraversalTiles()` runs can
bury a transition. `placeTransition()` only manages `obstacleData`; it never clears a
tile from `obstacles`. A town builder that runs last and does not respect transitions
will silently make the ladder unreachable, and no type check or syntax error says so.