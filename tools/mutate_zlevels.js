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
const TRAVERSAL_TEST = path.join(ROOT, 'tests', 'unit', 'traversal.test.js');
const LIVE_TEST = path.join(ROOT, 'tests', 'traversal_live_verify.js');
// A mutation names the file it applies to; server.js is the default.
const DEFAULTS = { file: path.join('server', 'server.js') };

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
    },
    // --- Stage 2: traversal ---------------------------------------------------
    {
        name: 'a traversal tile is also added to floor.obstacles (drawn but solid)',
        from: '    floor.obstacleData.push({ x, y, type });\n    return floor.transitions.get(`${x},${y}`);',
        to: '    floor.obstacleData.push({ x, y, type });\n    floor.obstacles.add(`${x},${y}`);\n    return floor.transitions.get(`${x},${y}`);',
        file: 'server/map.js'
    },
    {
        name: 'the descent never fires (traversal hook removed from the move handler)',
        from: 'if (traversal && performTraversal(player, traversal)) {',
        to: 'if (false && traversal && performTraversal(player, traversal)) {',
        // The unit suite reads the move handler as source, so it cannot see
        // whether the call is ever reached -- a hook wired to `false` still
        // contains the right call. Only real movement proves the descent
        // happens, so this mutation is checked against the live harness.
        live: true
    },
    {
        name: 'the trade separation check reverts to 2D distance',
        from: '        dist3D(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z) > TRADE.TRADE_MAX_DISTANCE;',
        to: '        dist(p1.x, p1.y, p2.x, p2.y) > TRADE.TRADE_MAX_DISTANCE;'
    },
    {
        name: 'the NPC reach check reverts to 2D distance (dungeon player banks in the city)',
        from: 'dist3D(player.x, player.y, player.z, npc.x, npc.y, npc.z) > 96',
        to: 'dist(player.x, player.y, npc.x, npc.y) > 96'
    },
    {
        name: 'arrival defaults to the ladder tile instead of the stated entry point',
        from: "    const entry = (arrive && Number.isSafeInteger(arrive.x) && Number.isSafeInteger(arrive.y))\n        ? { x: arrive.x, y: arrive.y }\n        : { x, y };",
        to: '    const entry = { x, y };',
        file: 'server/map.js'
    },
    {
        name: 'the client blocks traversal tiles again (floor becomes unreachable)',
        from: 'const WALKABLE_OBSTACLE_TYPES = new Set(["ladder", "stairs_up", "stairs_down"]);',
        to: 'const WALKABLE_OBSTACLE_TYPES = new Set([]);',
        file: 'client/js/engine.js'
    }
];

function resolve(rel) { return path.join(ROOT, rel); }
function readTarget(file) { return fs.readFileSync(file, 'utf8'); }
function writeTarget(file, text) { fs.writeFileSync(file, text, 'utf8'); }

function runTests() {
    try {
        const out = execFileSync(process.execPath, ['--test', TEST, TRAVERSAL_TEST], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    }
}

// End-to-end check against a real server over WebSockets. Needed for the
// behaviour no unit test can reach: whether a player who walks onto a ladder
// actually ends up on another floor.
function runLive() {
    try {
        const out = execFileSync(process.execPath, [LIVE_TEST], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 240000
        });
        return { ok: /ALL CHECKS PASSED/.test(out), out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    }
}

function passCount(out) {
    const m = out.match(/^\u2139 pass (\d+)$/m) || out.match(/pass (\d+)/);
    return m ? Number(m[1]) : -1;
}

const original = new Map();
for (const m of MUTATIONS) {
    const rel = m.file || DEFAULTS.file;
    const abs = resolve(rel);
    if (!original.has(abs)) original.set(abs, readTarget(abs));
}

console.log('=== z-level mutation testing ===\n');
console.log('  baseline (unmutated):');

const base = runTests();
console.log(`    ${base.ok ? 'suite ran' : 'SUITE ERROR'}  pass=${passCount(base.out)}\n`);

// A baseline that is not clean invalidates every result below: `caught` treats
// a non-zero exit as a catch, so a suite that was already failing would report
// every mutation as caught and the run would be worthless. It reported exactly
// that once -- two stale Stage 0 assertions that Stage 2 had invalidated.
if (!base.ok) {
    console.log('  ABORT: the suite is not green before mutating. Every "caught"');
    console.log('  below would be meaningless, because a failing suite looks like');
    console.log('  a catch. Fix the baseline first.');
    process.exitCode = 1;
    return;
}

let survived = 0;

for (const m of MUTATIONS) {
    const abs = resolve(m.file || DEFAULTS.file);
    const src = original.get(abs);
    if (!src.includes(m.from)) {
        console.log(`  SKIP  ${m.name}`);
        console.log('        (anchor text not found - source drifted, update this harness)\n');
        continue;
    }
    writeTarget(abs, src.replace(m.from, m.to));
    const result = m.live ? runLive() : runTests();
    const pass = passCount(result.out);
    const caught = m.live
        ? !result.ok
        : (!result.ok || pass < passCount(base.out));
    // Restore immediately so one mutation cannot compound with the next.
    writeTarget(abs, src);

    const how = m.live ? 'live harness' : 'unit suite';
    if (caught) {
        console.log(`  CAUGHT  ${m.name}`);
        console.log(`          ${how}${m.live ? '' : `  pass=${pass} (baseline ${passCount(base.out)})`}\n`);
    } else {
        survived++;
        console.log(`  SURVIVED  ${m.name}`);
        console.log(`          ${how} did NOT catch this\n`);
    }
}

// A mutation that makes a file unparseable also counts as caught, but the
// restore is verified explicitly rather than assumed.
for (const [abs, src] of original) writeTarget(abs, src);
const after = runTests();
const restored = after.ok && passCount(after.out) === passCount(base.out);
console.log(`  restored: ${restored ? 'OK' : 'MISMATCH'}  pass=${passCount(after.out)}\n`);

if (survived > 0) {
    console.log(`  ${survived} mutation(s) survived -- those assertions are decorative.`);
    process.exitCode = 1;
} else if (!restored) {
    console.log('  restore verification FAILED; a source file may be corrupted.');
    process.exitCode = 1;
} else {
    console.log(`  all ${MUTATIONS.length} mutations caught.`);
}
