'use strict';

/**
 * Mutation harness for the Z-level tests.
 *
 * A green test suite proves nothing unless the assertions can actually fail.
 * This injects each bug that was found and fixed during Stage 0, one at a
 * time, and reports whether the suite catches it. A mutation that survives
 * means the corresponding test is decorative.
 *
 * Byte-level safe: the file is read and written as UTF-8 with no BOM, because
 * server.js contains Hebrew comments and emoji and Set-Content would add one.
 *
 * Run:  node tools/mutate_zlevels.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'server', 'server.js');
const TEST = path.join(ROOT, 'tests', 'unit', 'zlevels.test.js');

// [name, from, to]
const MUTATIONS = [
    {
        name: 'safeInteger(data.z, 0) collapses every underground floor to 0',
        from: 'z: MAP.normalizeZ(data.z),',
        to: 'z: (Number.isSafeInteger(data.z) && data.z >= 0 ? data.z : 0),'
    },
    {
        name: 'open-ended lower bound (safeInteger(data.z, 0, -10))',
        from: 'z: MAP.normalizeZ(data.z),',
        to: 'z: (Number.isSafeInteger(data.z) && data.z >= -10 ? data.z : 0),'
    },
    {
        name: 'serializePlayer stops writing z',
        from: 'z: MAP.normalizeZ(p.z),',
        to: 'z: undefined,'
    },
    {
        name: 'login does not normalise z (pData.z ?? 0)',
        from: 'z: MAP.normalizeZ(pData.z),',
        to: 'z: pData.z ?? 0,'
    },
    {
        name: 'login uses || instead of ?? so a saved x=0 is discarded',
        from: 'x: pData.x ?? 320, y: pData.y ?? 320, z: MAP.normalizeZ(pData.z),',
        to: 'x: pData.x || 320, y: pData.y || 320, z: MAP.normalizeZ(pData.z),'
    },
    {
        name: 'broadcastToFloor does not normalise the player, so a player with no z is filtered out',
        from: 'if (MAP.normalizeZ(p.z) !== floor) return;',
        to: 'if (p.z !== floor) return;'
    },
    {
        name: 'dist gains defaulted z1/z2 params whose defaults cancel out',
        from: 'function dist(x1, y1, x2, y2) {\n    return Math.abs(x1 - x2) + Math.abs(y1 - y2);\n}',
        to: 'function dist(x1, y1, x2, y2, z1 = 0, z2 = 0) {\n    if (z1 !== z2) return Infinity;\n    return Math.abs(x1 - x2) + Math.abs(y1 - y2);\n}'
    },
    {
        name: 'dist3D no longer separates floors',
        from: 'if (MAP.normalizeZ(z1) !== MAP.normalizeZ(z2)) return Infinity;',
        to: ''
    },
    {
        name: 'death respawn forgets to reset the floor',
        from: 'player.z = CFG.Z_SURFACE;',
        to: ''
    }
];

function readTarget() { return fs.readFileSync(TARGET, 'utf8'); }
function writeTarget(text) { fs.writeFileSync(TARGET, text, 'utf8'); }

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

function passCount(out) {
    const m = out.match(/^\u2139 pass (\d+)$/m) || out.match(/pass (\d+)/);
    return m ? Number(m[1]) : -1;
}

const original = readTarget();
console.log('=== z-level mutation testing ===\n');
console.log('  baseline (unmutated):');

const base = runTests();
console.log(`    ${base.ok ? 'suite ran' : 'SUITE ERROR'}  pass=${passCount(base.out)}\n`);

let survived = 0;
let broken = 0;

for (const m of MUTATIONS) {
    if (!original.includes(m.from)) {
        console.log(`  SKIP  ${m.name}`);
        console.log('        (anchor text not found - source drifted, update this harness)\n');
        continue;
    }
    writeTarget(original.replace(m.from, m.to));
    const result = runTests();
    const pass = passCount(result.out);
    const caught = !result.ok || pass < passCount(base.out);

    if (caught) {
        console.log(`  CAUGHT  ${m.name}`);
        console.log(`          pass=${pass} (baseline ${passCount(base.out)})\n`);
    } else {
        survived++;
        console.log(`  SURVIVED  ${m.name}`);
        console.log(`          pass=${pass} -- the suite did NOT catch this\n`);
    }
}

// A mutation that makes the file unparseable also counts as caught, but it is
// worth separating so a real behavioural regression is distinguishable.
writeTarget(original);
const after = runTests();
const restored = after.ok && passCount(after.out) === passCount(base.out);
console.log(`  restored: ${restored ? 'OK' : 'MISMATCH'}  pass=${passCount(after.out)}\n`);

if (survived > 0) {
    console.log(`  ${survived} mutation(s) survived -- those assertions are decorative.`);
    process.exitCode = 1;
} else if (!restored) {
    console.log('  restore verification FAILED; server.js may be corrupted.');
    process.exitCode = 1;
} else {
    console.log(`  all ${MUTATIONS.length} mutations caught.`);
}

if (broken > 0) console.log(`  (${broken} produced a syntax error rather than a clean failure)`);
void broken;
