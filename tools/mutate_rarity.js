#!/usr/bin/env node
/*
 * tools/mutate_rarity.js
 *
 * Mutation harness for roadmap 4.6 (rare item drops).
 *
 * A green suite proves the feature is present. It does not prove any particular check
 * would notice if it stopped working, which for this feature is the whole risk: a
 * rare drop that quietly drops nothing is indistinguishable from correct behaviour
 * from the outside. Every mutation below removes or weakens one guarantee, and each
 * must be caught by a test that would have failed loudly.
 *
 * The three the harness refuses to skip are worth naming, because they were the
 * interesting ones to write:
 *
 *   - Removing the depth gate. If the shallow-roll test did not exist, the surface
 *     would quietly start handing out the deepest legendary and the suite would be
 *     green, because every other test only ever rolls at depth.
 *   - Letting `describe` default an unknown name. The feature would still work for
 *     every known item and would give a typo'd item a false "Legendary" label and the
 *     wrong colour, announced to the whole floor.
 *   - Not recording `tier` on the mob. This is the real bug from building it: `tier`
 *     was a local in the spawn function, `target.tier` was always undefined, the roll
 *     saw tier 1, and the pool was empty -- so the feature shipped wired up and inert.
 *     Nothing about the unit suite could have told me. The wiring assertion catches
 *     it, and this mutation proves the assertion bites.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RARITY = 'server/rarity.js';
const ITEMS = 'server/items.js';
const MOBS = 'server/mobs.js';
const BOSSES = 'server/bosses.js';
const COMBAT = 'server/combat.js';
const TEST = 'tests/unit/rarity.test.js';

const MUTATIONS = [
    {
        name: 'the depth gate is removed, so the surface drops the deepest legendary',
        file: RARITY,
        from: '    if (tier < entry.minTier) return 0;',
        to: '    // gate removed'
    },
    {
        name: 'the depth gate is inverted, so deep floors stop dropping anything',
        file: RARITY,
        from: '    if (tier < entry.minTier) return 0;',
        to: '    if (tier >= entry.minTier) return 0;'
    },
    {
        name: 'the pool is not filtered by depth before the roll',
        file: RARITY,
        from: '    const eligible = RARE_POOL.filter(e => chanceFor(e, tier, isElite) > 0);',
        to: '    const eligible = RARE_POOL.slice();'
    },
    {
        name: 'describe defaults an unknown name to legendary instead of failing closed',
        file: RARITY,
        from: '    if (!entry) return null;',
        to: '    if (!entry) return { name, rarity: \'legendary\', label: \'Legendary\', color: \'#ffb340\', minTier: 1 };'
    },
    {
        name: 'the depth bonus stops growing at all, so depth buys nothing',
        file: RARITY,
        from: '    const scaled = base * (1 + depth);',
        to: '    const scaled = base;'
    },
    {
        name: 'the depth bonus stops being capped, so the deepest floor is a guarantee',
        file: RARITY,
        from: '    const depth = Math.min(tier - entry.minTier, TIER_SPAN);',
        to: '    const depth = (tier - entry.minTier) * 10;'
    },
    {
        name: 'elites are no better than normal mobs',
        file: RARITY,
        from: '    return isElite ? scaled * ELITE_MULTIPLIER : scaled;',
        to: '    return scaled;'
    },
    {
        name: 'the injected rng is ignored, so the roll is always the same',
        file: RARITY,
        from: '        if (random() < chanceFor(entry, tier, isElite)) {',
        to: '        if (0.5 < chanceFor(entry, tier, isElite)) {'
    },
    {
        name: 'a rare item is removed from the items.js catalogue but still drops',
        file: ITEMS,
        from: "        'Frostbound Blade': { type: 'weapon', bonus: 30 },\n",
        to: ''
    },
    {
        name: 'a rare item is nerfed below the common item it replaces',
        file: ITEMS,
        from: "        'War Cleaver of the Warren': { type: 'weapon', bonus: 44 }",
        to: "        'War Cleaver of the Warren': { type: 'weapon', bonus: 1 }"
    },
    {
        name: 'mobs stop recording their tier, so the roll always sees tier 1',
        file: MOBS,
        from: '                tier: 1,',
        to: '                // tier removed'
    },
    {
        name: 'a floor spawn no longer records its tier',
        file: MOBS,
        from: '            tier,\n',
        to: '            // tier removed\n'
    },
    {
        name: 'a boss minion no longer inherits its floor tier',
        file: BOSSES,
        from: '            tier: floorSpec && Number.isFinite(floorSpec.tier) ? floorSpec.tier : 1,',
        to: '            // tier removed'
    },
    {
        name: 'the rare drop is never announced, so it happens silently',
        file: COMBAT,
        from: "                action: 'loot_rare',",
        to: "                action: 'log',"
    }
];

function readTarget(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }
function writeTarget(file, text) { fs.writeFileSync(path.join(ROOT, file), text, 'utf8'); }

function runTests() {
    try {
        const out = execFileSync(process.execPath, ['--test', TEST], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    }
}

const base = runTests();
console.log('\n=== rarity mutation testing ===\n');
console.log('  baseline (unmutated):');
if (!base.ok) {
    console.log('    SUITE ERROR\n');
    console.log(base.out.split('\n').slice(-14).map(l => '      ' + l).join('\n'));
    console.log('\n  ABORT: the suite is not green before mutating. Every "caught" below');
    console.log('  would be meaningless, because a failing suite looks like a catch.');
    process.exit(1);
}
const basePass = (base.out.match(/ℹ pass (\d+)/) || [])[1] || '?';
console.log(`    green, pass=${basePass}\n`);

let caught = 0;
const survivors = [];
for (const m of MUTATIONS) {
    const original = readTarget(m.file);
    if (!original.includes(m.from)) {
        console.log(`  SKIP      ${m.name}`);
        console.log(`            anchor not found in ${m.file} -- the code moved and this`);
        console.log('            mutation is now testing nothing, which counts as survived');
        survivors.push(m.name);
        continue;
    }
    writeTarget(m.file, original.replace(m.from, m.to));
    const result = runTests();
    writeTarget(m.file, original);

    const pass = (result.out.match(/ℹ pass (\d+)/) || [])[1] || '0';
    const how = !result.ok || Number(pass) < Number(basePass) ? 'caught' : 'SURVIVED';
    if (how === 'caught') caught++; else survivors.push(m.name);
    console.log(`  ${how.padEnd(8)} ${m.name}`);
}

console.log('');
console.log(`  ${caught}/${MUTATIONS.length} caught, ${survivors.length} survived`);
if (survivors.length) {
    console.log('\n  survivors:');
    survivors.forEach(s => console.log('    - ' + s));
}
process.exit(survivors.length ? 1 : 0);