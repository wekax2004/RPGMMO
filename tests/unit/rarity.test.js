/*
 * tests/unit/rarity.test.js
 *
 * Roadmap 4.6: rare item drops.
 *
 * These are unit tests, not a socket probe, and the distinction is worth stating
 * because it is the opposite of the usual reason to prefer a probe. `rollRareDrop`
 * takes an injectable `random`, so every branch here is reachable in one assertion
 * -- and the whole feature is otherwise untestable in practice. The default
 * probabilities are around 0.4%, so a probe would need hundreds of kills to see the
 * happy path and still could not prove the depth floor holds.
 *
 * What the socket probe (`tests/bots/rare_drop_probe.js`) covers instead is the
 * half these tests cannot reach: that a kill on a real floor actually produces the
 * `loot_rare` packet with the right shape and the right floor.
 *
 * The failure mode this whole feature has is a silent one. A rare drop that drops
 * nothing looks identical to working as intended from the outside. So the tests are
 * weighted towards the ways it could quietly do nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const RARITY = require('../../server/rarity');
const ITEMS = require('../../server/items');
const CFG = require('../../server/config');
const MOBS_SRC = path.join(__dirname, '..', '..', 'server', 'mobs.js');
const BOSSES_SRC = path.join(__dirname, '..', '..', 'server', 'bosses.js');
const COMBAT_SRC = path.join(__dirname, '..', '..', 'server', 'combat.js');

const deepestFloor = () => Math.max(...CFG.Z_FLOORS.map(f => f.tier));

// Every catalogue in items.js, so "does this name exist" can be asked honestly.
const CATALOGUES = [
    ITEMS.consumables, ITEMS.weapons, ITEMS.armor, ITEMS.helmets,
    ITEMS.legs, ITEMS.boots, ITEMS.shields, ITEMS.amulets, ITEMS.materials
];
const existsAsAnItem = (name) =>
    CATALOGUES.some(c => Object.prototype.hasOwnProperty.call(c, name));

test('every rare drop is a real item', () => {
    // The single most important check in this file. rarity.js decides WHEN something
    // drops; items.js decides what it IS. A name present in one and not the other
    // reaches a player's bag as an item that is not equippable, not usable and not
    // worth anything -- and it still announces itself as Legendary, so the player is
    // told they got a reward while holding junk.
    for (const entry of RARITY.pool()) {
        assert.ok(existsAsAnItem(entry.name),
            `'${entry.name}' can drop but is in no items.js catalogue`);
    }
});

test('a rare item is strictly better than the common item it sits beside', () => {
    // Guards against a typo'd stat. `Frostbound Blade` at bonus 30 is obviously meant
    // to beat `Frost Blade` at 22; if a copy-paste ever gave it 5, the item would drop
    // rarely and be worthless, which is worse than not having it.
    const cases = [
        ['Frostbound Blade', 'bonus', ITEMS.weapons['Frost Blade'].bonus],
        ['War Cleaver of the Warren', 'bonus', ITEMS.weapons['Frost Blade'].bonus],
        ['Spider Queen Carapace', 'def', ITEMS.armor['Dragon Scale Armor'].def],
        ['Crown of the Fallen King', 'def', ITEMS.helmets['Dragon Helm'].def],
        ['Owl Tower Buckler', 'def', ITEMS.shields['Tower Shield'].def],
        ['Amulet of the Frost Ward', 'maxHpBonus', ITEMS.amulets['Dragon Heart Pendant'].maxHpBonus]
    ];
    for (const [name, stat, commonValue] of cases) {
        const def = CATALOGUES.flatMap(c => Object.entries(c)).find(([k]) => k === name);
        assert.ok(def, `${name} has no definition`);
        assert.ok(def[1][stat] > commonValue,
            `${name} (${stat} ${def[1][stat]}) must beat the common item it replaces (${commonValue})`);
    }
});

test('nothing drops above the floor depth it is gated to', () => {
    // The depth floor is the feature. Without it a surface spider hands out the
    // deepest legendary, and every reason to descend evaporates.
    for (const entry of RARITY.RARE_POOL) {
        assert.strictEqual(RARITY.chanceFor(entry, entry.minTier - 0.5), 0,
            `${entry.name} must be impossible below tier ${entry.minTier}`);
    }
});

test('depth scales the chance, and the scaling is capped', () => {
    const entry = RARITY.RARE_POOL[0];
    const atMin = RARITY.chanceFor(entry, entry.minTier);
    const deeper = RARITY.chanceFor(entry, entry.minTier + RARITY.TIER_SPAN);
    const farDeeper = RARITY.chanceFor(entry, entry.minTier + 50);

    assert.ok(deeper > atMin, 'going deeper must be better than the minimum');
    // Without the cap a tier-50 floor is a guaranteed drop and the reward for depth
    // flattens out exactly where the game wants players to spend the most time.
    assert.strictEqual(farDeeper, deeper, 'the depth bonus must stop growing');
    assert.ok(deeper / atMin <= RARITY.TIER_SPAN + 1,
        'and it must not grow without bound before the cap either');
});

test('an elite mob is more likely to drop than the same mob is not', () => {
    const entry = RARITY.RARE_POOL[0];
    const normal = RARITY.chanceFor(entry, entry.minTier, false);
    const elite = RARITY.chanceFor(entry, entry.minTier, true);
    assert.strictEqual(elite, normal * RARITY.ELITE_MULTIPLIER);
});

test('the probabilities are rare, not merely uncommon', () => {
    // A guard against someone tuning these into routine. 0.4% is roughly one in 250
    // kills; anything above 1% stops being a reward and becomes a tax on the first
    // ten minutes of the dungeon.
    for (const [key, def] of Object.entries(RARITY.RARITY)) {
        assert.ok(def.chance < 0.01, `${key} chance ${def.chance} is not rare`);
    }
});

test('an injected roll of 0 wins and a roll of 1 loses', () => {
    // The injectable rng is the reason this feature is testable at all, so it needs
    // its own check: if `random` were ignored, every test above would still pass
    // because they only read chanceFor.
    const always = (v) => () => v;

    const won = RARITY.rollRareDrop({ tier: deepestFloor(), random: always(0) });
    assert.ok(won, 'roll 0 against any positive chance must win');
    assert.ok(existsAsAnItem(won.name));

    const lost = RARITY.rollRareDrop({ tier: deepestFloor(), random: always(0.999999) });
    assert.strictEqual(lost, null, 'a roll near 1 against a sub-1% chance must lose');
});

test('a roll at depth only considers entries that depth allows', () => {
    // The end-to-end version of the filter. The depth tests above check chanceFor
    // directly, and the cross-floor test above only ever saw `random: () => 0`, which
    // takes the FIRST eligible entry and so cannot tell an unfiltered pool from a
    // filtered one when the first entry happens to be eligible anyway.
    //
    // Counted how many entries the roll was willing to consider, by counting the
    // random() calls. It must be fewer than the pool, because some entries are gated
    // above this floor -- and if the filter is removed, their chance is silently
    // divided by the pool size, so a tier-1 player would get a legendary at
    // 0.0012 / 8 while the configuration reads as though they should.
    //
    // Uses the SHALLOWEST dungeon, not the deepest. At the deepest floor every entry
    // is eligible and the filter is a no-op, so a test written there proves nothing.
    const shallowFloor = CFG.Z_FLOORS.reduce((a, b) => (a.tier < b.tier ? a : b));
    const eligible = RARITY.RARE_POOL.filter(e => e.minTier <= shallowFloor.tier);
    assert.ok(eligible.length < RARITY.RARE_POOL.length,
        'this test needs a floor some entries are gated above');

    let considered = 0;
    const drop = RARITY.rollRareDrop({
        tier: shallowFloor.tier,
        random: () => { considered++; return 0.999999; }   // decline everything
    });
    assert.strictEqual(drop, null, 'declining every entry must yield no drop');
    assert.strictEqual(considered, eligible.length,
        `at tier ${shallowFloor.tier} the roll considered ${considered} entries but ` +
        `${eligible.length} are eligible. Considering all ${RARITY.RARE_POOL.length} ` +
        'means the depth filter is gone and every chance is divided by the pool size');
});

test('the roll never returns an entry gated above the floor it rolled on', () => {
    // The property stated directly, so a failure names the leaked entry rather than
    // reporting a count. Sweeps every floor the game has, at a random() that always
    // accepts, so each roll lands on the first eligible entry -- which is exactly the
    // one an unfiltered pool would hand out first.
    for (const floor of CFG.Z_FLOORS) {
        for (const elite of [false, true]) {
            const drop = RARITY.rollRareDrop({ tier: floor.tier, isElite: elite, random: () => 0 });
            if (!drop) continue;
            assert.ok(floor.tier >= drop.minTier,
                `on '${floor.name}' (tier ${floor.tier}, elite=${elite}) the roll returned ` +
                `'${drop.name}', which is gated at tier ${drop.minTier}`);
        }
    }
});

test('a shallow roll returns null rather than falling back to something', () => {
    // tier 1 is below every minTier, so the pool is empty. The answer must be null.
    // Returning a default tier here would mean the surface quietly hands out deep
    // loot, which is the exact bug the depth floor exists to prevent.
    const shallow = RARITY.rollRareDrop({ tier: 1, random: () => 0 });
    assert.strictEqual(shallow, null, 'the surface must not roll a rare drop');
});

test('a deep roll only ever returns something the floor allows', () => {
    // Cross-check the roll against the gate, over every floor the game actually has.
    // This is the end-to-end version of the depth test above: chanceFor is checked
    // directly there, and here the actual roll output is checked, because a bug
    // could make rollRareDrop ignore the filter it just applied.
    for (const floor of CFG.Z_FLOORS) {
        for (let i = 0; i < 200; i++) {
            const drop = RARITY.rollRareDrop({ tier: floor.tier, random: () => 0 });
            if (!drop) continue;
            assert.ok(floor.tier >= drop.minTier,
                `on '${floor.name}' (tier ${floor.tier}) a roll returned ${drop.name}, gated at ${drop.minTier}`);
        }
    }
});

test('an unknown name describes as null rather than as a default tier', () => {
    // describe() decides whether a drop gets announced. An unknown name must fail
    // closed: an unannounced drop is quiet, whereas a wrong tier gives it a false
    // "Legendary" and the wrong colour.
    assert.strictEqual(RARITY.describe('Not A Real Item'), null);
});

test('every mob record carries the tier it spawned at', () => {
    // The bug this caught: `tier` was passed to getMobStats and then dropped on the
    // floor, so `target.tier` in combat.js was always undefined and the rare-drop
    // roll saw tier 1 -- where the pool is empty. The feature shipped looking wired
    // up and could never fire. Asserted at every mobs.set site.
    //
    // The first version of this test found the sites with a regex and counted 2, so
    // it passed while two of the four spawn paths had no tier at all. Counting was not
    // the problem; the pattern was. A nested brace in a spawn argument truncated the
    // match, and a shorter object slipped straight past. Now every `mobs.set(` is
    // counted first and the assertion is on that count, so a pattern that quietly
    // stops matching fails the test instead of checking less.
    const src = require('fs').readFileSync(MOBS_SRC, 'utf8');
    const occurrences = (src.match(/mobs\.set\(/g) || []).length;
    // 3, not 4: the fourth site is in bosses.js, which the next test covers. The
    // number is pinned anyway, because the failure this guards against is a pattern
    // that quietly stops matching and a test that then checks less -- and a pinned
    // count fails loudly in that case instead of passing on three of four.
    assert.strictEqual(occurrences, 3,
        'expected three mobs.set call sites in mobs.js (the fourth is in bosses.js); ' +
        'if a spawn path was added or removed, this count and the assertions below ' +
        'both need updating');

    // Each site, located by the literal `mobs.set(` and walked forward to the matching
    // close, rather than by trying to match the object shape in one regex.
    const bodies = [];
    let from = 0;
    for (let i = 0; i < occurrences; i++) {
        const at = src.indexOf('mobs.set(', from);
        const close = src.indexOf('});', at);
        bodies.push(src.slice(at, close));
        from = close;
    }
    // Comments are stripped before the check. Both sites that carry a tier also
    // carry a comment explaining WHY, and those comments contain the word "tier" --
    // so a mutation that deleted `tier: 1,` and left the prose behind still matched,
    // and the two mutants below this line survived. Checking for a word that also
    // appears in the explanation of that word is the allowlist mistake the roadmap
    // warns about, in a new costume: trusting the name rather than the value.
    const code = (body) => body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    bodies.forEach((body, n) => {
        assert.ok(/\btier\s*[:,]/.test(code(body)),
            `mobs.set site ${n + 1} does not record a tier:\n${body.trim().slice(0, 200)}`);
    });
});

test('a boss minion inherits its summoner floor tier', () => {
    // Lives in bosses.js, not mobs.js, so it is checked separately. A minion of a
    // Frostmaw boss that recorded no tier would be treated as a surface mob by the
    // rare-drop roll -- the deepest floor's own adds handing out nothing.
    const src = require('fs').readFileSync(BOSSES_SRC, 'utf8');
    assert.ok(/tier:\s*floorSpec\s*&&\s*Number\.isFinite\(floorSpec\.tier\)/.test(src),
        'a boss minion must record the tier of the floor its summoner stands on');
});

test('the kill path announces the drop instead of dropping it silently', () => {
    // The feature's whole point is that a rare drop is *noticeable*. A drop that
    // reaches the bag with no `loot_rare` packet is indistinguishable from every
    // other kill, which is the failure this file was written to prevent -- a 1-in-250
    // reward the player never learns to look for.
    const src = require('fs').readFileSync(COMBAT_SRC, 'utf8');
    assert.ok(/action:\s*'loot_rare'/.test(src),
        'a rare drop must be announced on its own packet so the client can play the effect');
    assert.ok(/RARITY\.rollRareDrop\(\{\s*tier:/.test(src),
        'the kill path must pass the tier into the roll');
});

test('the deepest floor can actually roll its own legendary', () => {
    // Belt and braces. If the deepest floor's legendaries were gated above the
    // deepest floor, the feature would be inert at the bottom of the game -- which is
    // where a player would look for it first.
    const deepest = deepestFloor();
    const legendaries = RARITY.RARE_POOL.filter(e => e.rarity === 'legendary');
    const reachable = legendaries.filter(e => e.minTier <= deepest);
    assert.ok(reachable.length > 0,
        `no legendary is reachable at the deepest floor (tier ${deepest})`);
    for (const e of reachable) {
        assert.ok(RARITY.chanceFor(e, deepest) > 0, `${e.name} has no chance at tier ${deepest}`);
    }
});