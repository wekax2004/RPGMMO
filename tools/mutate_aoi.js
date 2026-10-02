/*
 * Re-injects the ways the AoI change could be wrong, one at a time, and confirms
 * tests/unit/aoi.test.js goes red for each.
 *
 * Run:  node tools/mutate_aoi.js
 * Exits non-zero if any mutation survives.
 *
 * The mutations that matter most are the ones no unit test on the selection
 * function alone would catch. "The function filters correctly" and "the server
 * calls the function" are separate claims, and a change can satisfy the first
 * while abandoning the second without a single behavioural test noticing -- the
 * suite goes on passing against a server that sends the whole floor as it always
 * did. So three of these target the wiring rather than the filter:
 *
 *   - the enabled branch of the broadcast tick
 *   - the client's authoritative prune, which is the only thing that removes a
 *     peer who walks out of range
 *   - the config value the whole thing depends on
 *
 * A green suite is not evidence that an optimisation is wired up. These mutations
 * are the evidence.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AOI = 'server/aoi.js';
const SERVER = 'server/server.js';
const ENGINE = 'client/js/engine.js';
const CONFIG = 'server/config.js';
const TEST = 'tests/unit/aoi.test.js';

const MUTATIONS = [
    // --- the filter itself --------------------------------------------------
    {
        name: 'the radius is ignored, so every floor is sent whole again',
        file: AOI,
        from: 'if (!(radius > 0)) return roster;',
        to: 'if (true) return roster;'
    },
    {
        name: 'the boundary becomes exclusive: a peer exactly at the radius is dropped',
        file: AOI,
        from: 'Math.abs(other.x - viewer.x) <= radius && Math.abs(other.y - viewer.y) <= radius',
        to: 'Math.abs(other.x - viewer.x) < radius && Math.abs(other.y - viewer.y) < radius'
    },
    {
        name: 'the square becomes a circle, desynchronising from the minimap',
        file: AOI,
        from: 'Math.abs(other.x - viewer.x) <= radius && Math.abs(other.y - viewer.y) <= radius',
        to: 'Math.hypot(other.x - viewer.x, other.y - viewer.y) <= radius'
    },
    {
        name: 'the y axis stops being checked, so vertical neighbours vanish',
        file: AOI,
        from: 'Math.abs(other.x - viewer.x) <= radius && Math.abs(other.y - viewer.y) <= radius',
        to: 'Math.abs(other.x - viewer.x) <= radius'
    },
    {
        name: 'the x axis stops being checked, so horizontal neighbours vanish',
        file: AOI,
        from: 'Math.abs(other.x - viewer.x) <= radius && Math.abs(other.y - viewer.y) <= radius',
        to: 'Math.abs(other.y - viewer.y) <= radius'
    },
    {
        name: 'the radius is halved, dropping peers the minimap still draws',
        file: AOI,
        from: 'Math.abs(other.x - viewer.x) <= radius && Math.abs(other.y - viewer.y) <= radius',
        to: 'Math.abs(other.x - viewer.x) <= radius / 2 && Math.abs(other.y - viewer.y) <= radius / 2'
    },
    {
        name: 'off-by-one in the comparison operator, the classic AoI boundary bug',
        file: AOI,
        from: 'other.id === viewer.id ||',
        to: 'other.id === viewer.id + 1 ||'
    },

    // --- the wiring ---------------------------------------------------------
    {
        // The one that matters most. The selection function is perfect and
        // completely unused; the server sends the whole floor exactly as before
        // and every behavioural test of aoi.js still passes.
        name: 'the enabled branch is never taken, so the server never filters',
        file: SERVER,
        from: 'if (CFG.AOI_RADIUS <= 0) {',
        to: 'if (true) {'
    },
    {
        name: 'the per-viewer send is replaced by the whole floor',
        file: SERVER,
        from: 'players: AOI.visibleTo(viewer, list, CFG.AOI_RADIUS)',
        to: 'players: list'
    },
    {
        name: 'the wrong viewer is asked for its roster',
        file: SERVER,
        from: 'players: AOI.visibleTo(viewer, list, CFG.AOI_RADIUS)',
        to: 'players: AOI.visibleTo(list[list.length - 1], list, CFG.AOI_RADIUS)'
    },
    {
        // AoI's entire cleanup story. If this line stops running, peers who walk
        // out of range are never removed from anyone's client: no error, no log,
        // and a ghost of every player who has ever been nearby. Nothing in the
        // server can detect it.
        name: 'the client stops pruning players absent from the roster',
        file: ENGINE,
        from: 'for (let id in otherPlayers) { if (!newIds.includes(id)) delete otherPlayers[id]; }',
        to: 'for (let id in otherPlayers) { if (false) delete otherPlayers[id]; }'
    },
    {
        name: 'the client prunes instead of updating, wiping every peer each tick',
        file: ENGINE,
        from: 'if (!newIds.includes(id)) delete otherPlayers[id];',
        to: 'if (newIds.includes(id)) delete otherPlayers[id];'
    },

    // --- the configuration --------------------------------------------------
    {
        name: 'the radius no longer tracks the minimap radius',
        file: CONFIG,
        from: 'return Number.isFinite(fromEnv) ? fromEnv : 1000;',
        to: 'return Number.isFinite(fromEnv) ? fromEnv : 600;'
    },
    {
        name: 'the env override is ignored, so the control run cannot be reproduced',
        file: CONFIG,
        from: 'return Number.isFinite(fromEnv) ? fromEnv : 1000;',
        to: 'return 1000;'
    },
    {
        name: 'the radius is made large enough to disable filtering in practice',
        file: CONFIG,
        from: 'return Number.isFinite(fromEnv) ? fromEnv : 1000;',
        to: 'return Number.isFinite(fromEnv) ? fromEnv : 999999;'
    },

    // --- known no-op --------------------------------------------------------
    {
        // Removing the explicit self-inclusion changes nothing: a viewer's
        // distance from itself is 0, and 0 is within any positive radius. The
        // clause is redundant defence, kept because it makes the invariant legible
        // rather than because any behaviour depends on it.
        //
        // Reported as a no-op rather than SURVIVED. A surviving mutation means an
        // assertion that does not assert; this one asserts correctly and mutates
        // code that was never load-bearing.
        name: 'the explicit self-inclusion clause is removed (redundant, see note)',
        file: AOI,
        from: 'other.id === viewer.id ||',
        to: '',
        noop: true
    }
];

function runSuite() {
    try {
        const out = execFileSync(process.execPath, ['--test', TEST], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    }
}

function failingTest(out) {
    const m = out.match(/✖ ([^\n]+)/);
    return m ? m[1].trim().slice(0, 72) : '(no failure line found)';
}

const originals = new Map();
for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs, 'utf8'));
}

console.log('=== AoI mutation testing ===\n');
const base = runSuite();
console.log(`  baseline: ${base.ok ? 'passes' : 'ALREADY FAILING'}`);
if (!base.ok) {
    console.log('    ' + failingTest(base.out));
    console.log('\n  ABORT: green before mutating or nothing below means anything.');
    process.exit(1);
}

let survived = 0;
let noops = 0;
for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    const src = originals.get(abs);
    if (!src.includes(m.from)) {
        console.log(`  SKIP      ${m.name}`);
        console.log('            anchor not found -- the source drifted, update this harness\n');
        survived++;
        continue;
    }
    fs.writeFileSync(abs, src.replace(m.from, m.to), 'utf8');
    const result = runSuite();
    fs.writeFileSync(abs, src, 'utf8');

    if (result.ok) {
        if (m.noop) {
            noops++;
            console.log(`  NO-OP     ${m.name}`);
            console.log('            behaviour is identical, as documented\n');
        } else {
            survived++;
            console.log(`  SURVIVED  ${m.name}`);
            console.log('            the suite passed against injectable code\n');
        }
    } else {
        console.log(`  CAUGHT    ${m.name}`);
        console.log(`            ${failingTest(result.out)}\n`);
    }
}

const real = MUTATIONS.length - noops;
console.log(`  ${real - survived}/${real} caught, ${survived} survived, ${noops} documented no-op`);
if (survived) {
    console.log('\n  A surviving mutation is an assertion that does not assert.');
    process.exitCode = 1;
} else {
    console.log('  Every mutation that changes behaviour was caught.');
}
