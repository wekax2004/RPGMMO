'use strict';

/**
 * Mutation harness for AC5, the real-browser Z-level descent test.
 *
 * A green acceptance test proves nothing unless its assertions can fail. This
 * injects the bugs AC5 exists to catch -- one at a time, into the client and the
 * server -- and reports whether the test goes red. A mutation that survives
 * means the corresponding check is decorative.
 *
 * Byte-level safe: files are read and written as UTF-8 with no BOM, because
 * server.js and config.js contain Hebrew comments and emoji. Set-Content would
 * add a BOM and double-encode them.
 *
 * The harness refuses to run against a non-green baseline, for the reason
 * mutate_zlevels.js documents: `caught` treats a non-zero exit as a catch, so an
 * already-failing suite would report every mutation as caught and the run would
 * be worthless.
 *
 * Note on client-side mutations: the browser must actually be served the
 * mutated file, or every client mutation "survives" for the wrong reason. Two
 * of these (the walkable-ladder set and currentZ) cannot pass even if the client
 * is unmutated, so they double as canaries for that. If a run reports those
 * surviving, the caching is suspect, not the test.
 *
 * Run:  node tools/mutate_ac5.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8141;
const RUN_TIMEOUT_MS = 300000;

const CLIENT = { file: path.join('client', 'js', 'engine.js') };
const RENDERER = { file: path.join('client', 'js', 'renderer.js') };
const SERVER = { file: path.join('server', 'server.js') };

// Each entry names the exact text to replace. A name is not a comment: if the
// anchor is missing the source has drifted and the harness SKIPs rather than
// silently passing the mutation through unapplied.
const MUTATIONS = [
    // --- the client fails to drop the old floor --------------------------
    {
        ...CLIENT,
        name: 'client keeps every cache on a floor change (no flush at all)',
        from: 'if (window.currentZ !== undefined && window.currentZ !== newZ) {\n' +
              '                    otherPlayers = {};\n' +
              '                    mobs = {};\n' +
              '                    clientCorpses = {};\n' +
              '                    groundItemsLocal = [];\n' +
              '                }',
        to: 'if (false) {\n                    otherPlayers = {};\n                    mobs = {};\n                    clientCorpses = {};\n                    groundItemsLocal = [];\n                }'
    },
    {
        ...CLIENT,
        name: 'client flushes otherPlayers but forgets mobs',
        from: 'otherPlayers = {};\n                    mobs = {};\n                    clientCorpses = {};',
        to: 'otherPlayers = {};\n                    clientCorpses = {};'
    },
    {
        ...CLIENT,
        name: 'client does not track the new floor index',
        from: 'window.currentZ = newZ;',
        to: 'window.currentZ = 0;'
    },
    {
        ...CLIENT,
        name: 'client never adopts the dungeon bounds (pathfinder and checks unblind)',
        from: 'MAP_BOUNDS = data.bounds || null;',
        to: 'MAP_BOUNDS = null;'
    },
    {
        ...CLIENT,
        name: 'ladder is no longer a walkable tile, so it can be drawn but never reached',
        from: 'const WALKABLE_OBSTACLE_TYPES = new Set(["ladder", "stairs_up", "stairs_down"]);',
        to: 'const WALKABLE_OBSTACLE_TYPES = new Set([]);'
    },
    {
        ...CLIENT,
        name: 'client discards the traversal list it was sent',
        from: 'floorTransitions = data.transitions || [];',
        to: 'floorTransitions = [];'
    },

    // --- the client renders the wrong floor ------------------------------
    {
        ...RENDERER,
        name: 'minimap always labels the floor "Surface"',
        from: 'c.fillText(window.currentZ < 0 ? `Z: ${window.currentZ}` : `Surface`, R, MINIMAP_SIZE - 4);',
        to: "c.fillText('Surface', R, MINIMAP_SIZE - 4);"
    },
    {
        ...RENDERER,
        name: 'underground is no longer darkened',
        from: 'ctx.fillStyle = (window.currentZ < 0) ? "#0c0c14" : "#1e1e2f";',
        to: 'ctx.fillStyle = "#1e1e2f";'
    },

    // --- the server leaks across floors ----------------------------------
    {
        ...SERVER,
        name: 'players_sync is no longer grouped by floor (everyone re-admitted to everyone)',
        from: 'const floor = MAP.normalizeZ(p.z);\n        if (!byFloor.has(floor)) byFloor.set(floor, []);',
        to: 'const floor = 0;\n        if (!byFloor.has(floor)) byFloor.set(floor, []);'
    },
    {
        ...SERVER,
        name: 'traversal does not tell the floor being left that the player left',
        from: "broadcastToFloor(fromZ, { action: 'player_left', id: player.id });",
        to: ''
    },
    {
        ...SERVER,
        name: 'traversal does not actually change the floor',
        from: 'player.z = toZ;',
        to: 'player.z = fromZ;'
    }
];

function resolve(rel) { return path.join(ROOT, rel); }

function runAc5() {
    try {
        const out = execFileSync(
            process.execPath,
            ['tests/e2e_runner.js', '--suite=browser', '--test=descent', `--port=${PORT}`],
            { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: RUN_TIMEOUT_MS }
        );
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    }
}

// The first few failed checks, so a "caught" can be read rather than trusted.
// A mutation that only crashes the server, or that never runs the client at all,
// is caught for the wrong reason and should be visible as such here.
function failureReasons(out) {
    const lines = out.split('\n').filter(l => /\u2717/.test(l));
    const crashed = /AC5 crashed:/.test(out);
    const reasons = lines.map(l => l.replace(/\s+/g, ' ').trim().replace(/^\u2717\s*/, '').slice(0, 88));
    if (crashed) reasons.unshift('CRASHED');
    return reasons.slice(0, 3);
}

function checkCount(out) {
    const m = out.match(/Passed: (\d+) \/ (\d+)/);
    return m ? `${m[1]}/${m[2]}` : '?';
}

const original = new Map();
for (const m of MUTATIONS) {
    const abs = resolve(m.file);
    if (!original.has(abs)) original.set(abs, fs.readFileSync(abs, 'utf8'));
}

console.log('=== AC5 mutation testing (real browser, real server) ===\n');
console.log(`  baseline (unmutated), ${MUTATIONS.length} mutations to try:\n`);

const base = runAc5();
console.log(`    ${base.ok ? 'PASS' : 'FAIL'}  browser suite ${checkCount(base.out)}`);
if (!base.ok) {
    console.log('    failing checks:');
    for (const r of failureReasons(base.out)) console.log(`      - ${r}`);
}

if (!base.ok) {
    console.log('\n  ABORT: AC5 is not green before mutating. A failing suite looks');
    console.log('  exactly like a catch, so every result below would be meaningless.');
    process.exitCode = 1;
    return;
}

let survived = 0;
let skipped = 0;

for (const m of MUTATIONS) {
    const abs = resolve(m.file);
    const src = original.get(abs);
    if (!src.includes(m.from)) {
        console.log(`  SKIP    ${m.name}`);
        console.log('          anchor not found -- source drifted, update this harness\n');
        skipped++;
        continue;
    }
    const occurrences = src.split(m.from).length - 1;
    if (occurrences !== 1) {
        console.log(`  SKIP    ${m.name}`);
        console.log(`          anchor appears ${occurrences} times, not once -- ambiguous, update this harness\n`);
        skipped++;
        continue;
    }

    writeFileSync_utf8(abs, src.replace(m.from, m.to));
    const result = runAc5();
    // Restore immediately so one mutation cannot compound with the next.
    writeFileSync_utf8(abs, src);

    if (result.ok) {
        survived++;
        console.log(`  SURVIVED  ${m.name}`);
        console.log('            AC5 still passed. Whatever should have caught this is not asserting it.\n');
    } else {
        console.log(`  CAUGHT    ${m.name}`);
        console.log(`            browser suite ${checkCount(result.out)}`);
        for (const r of failureReasons(result.out)) console.log(`              - ${r}`);
        console.log('');
    }
}

console.log(`  ${MUTATIONS.length - survived - skipped} caught, ${survived} survived, ${skipped} skipped`);
if (survived > 0) {
    console.log('\n  A surviving mutation means AC5 does not actually check that behaviour.');
    process.exitCode = 1;
} else {
    console.log('  Every mutation was caught.');
}

function writeFileSync_utf8(file, text) {
    fs.writeFileSync(file, text, 'utf8');
}
