/*
 * Re-injects the ways mob area of interest could be wrong, one at a time, and confirms
 * tests/unit/mob_aoi.test.js goes red for each.
 *
 * Run:  node tools/mutate_mob_aoi.js
 * Exits non-zero if any mutation survives.
 *
 * The two that matter most are the invisible-monster ones. If MOB_AOI_RADIUS is
 * allowed below the aggro range, or if the reconciliation forgets to announce a mob
 * that has come into range, the player is attacked by something they cannot see. Both
 * are invisible in normal play: nothing errors, no log line mentions it, and the
 * player simply takes damage from off-screen. So the aggro relationship is asserted
 * from the source of both numbers, and there is a mutation for each side of it.
 *
 * The third is the removal packet. Reusing `alive: false` would delete the mob from
 * the client's cache correctly and play a blood-burst effect every time the player
 * turned away from it, which is why mob_forget exists and why it is pinned here.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = 'server/server.js';
const CONFIG = 'server/config.js';
const AOI = 'server/aoi.js';
const TESTING = 'server/testing.js';
const ENGINE = 'client/js/engine.js';
const TEST = 'tests/unit/mob_aoi.test.js';
// zlevels.test.js owns the floor-filtering assertions for the login roster, so it
// runs alongside. Without it, a mutation that drops the floor check from syncFloorRoster
// is caught by neither suite in isolation and survives.
const TEST2 = 'tests/unit/zlevels.test.js';

// A unique anchor for the mob radius line.
//
// AOI_RADIUS and MOB_AOI_RADIUS are written identically:
//
//     return Number.isFinite(fromEnv) ? fromEnv : 1000;
//
// and String.replace takes the FIRST match, so anchoring on that line alone mutated
// the *players'* radius three times over and every mutation passed -- the mob
// assertions read MOB_AOI_RADIUS, which had not changed. A harness that quietly edits
// the wrong code is worse than one that skips, because the skip is visible.
//
// The env var name is unique to the mob radius and sits two lines above.
const MOB_RADIUS_ANCHOR =
    "const fromEnv = Number.parseInt(process.env.TIBIA_MOB_AOI_RADIUS, 10);\n" +
    '        return Number.isFinite(fromEnv) ? fromEnv : 1000;';

const MUTATIONS = [
    // --- the safety invariant ----------------------------------------------
    {
        // The invisible-monster bug, reached the obvious way: someone shrinks the
        // radius for bandwidth without noticing mobs engage from further out.
        name: 'the radius is set below the aggro range, so mobs hit unseen players',
        file: CONFIG,
        from: MOB_RADIUS_ANCHOR,
        to: MOB_RADIUS_ANCHOR.replace(': 1000;', ': 200;')
    },
    {
        name: 'the aggro range is widened past the radius, with the same effect',
        file: SERVER,
        from: 'const AGGRO_RANGE = 400;',
        to: 'const AGGRO_RANGE = 4000;'
    },
    {
        name: 'the radius is made larger than the map, so it filters nothing',
        file: CONFIG,
        from: MOB_RADIUS_ANCHOR,
        to: MOB_RADIUS_ANCHOR.replace(': 1000;', ': 999999;')
    },

    // --- the switch ---------------------------------------------------------
    {
        // The gate has flipped: the client now handles mob_forget, so the feature is
        // enabled. Turning it back off is the dangerous direction again, because it
        // means paying full-floor cost while believing the optimisation is on.
        name: 'the feature is switched back off while the client keeps forgetting mobs',
        file: CONFIG,
        from: MOB_RADIUS_ANCHOR,
        to: MOB_RADIUS_ANCHOR.replace(': 1000;', ': 0;')
    },
    {
        name: 'the mob scope reads the player radius, coupling two independent switches',
        file: SERVER,
        from: '    const radius = CFG.MOB_AOI_RADIUS;\n    if (radius <= 0) { broadcastToFloor(z, packet); return; }',
        to: '    const radius = CFG.AOI_RADIUS;\n    if (radius <= 0) { broadcastToFloor(z, packet); return; }'
    },
    {
        name: 'reconciliation is gated off, so nothing ever enters or leaves',
        file: SERVER,
        from: '    const radius = CFG.MOB_AOI_RADIUS;\n    if (radius <= 0) return;\n    players.forEach((player, pid) => {',
        to: '    const radius = CFG.MOB_AOI_RADIUS;\n    if (radius < 0) return;\n    players.forEach((player, pid) => {'
    },

    // --- the geometry -------------------------------------------------------
    {
        name: 'the radius boundary becomes exclusive, dropping mobs the minimap draws',
        file: AOI,
        from: 'return Math.abs(viewer.x - x) <= radius && Math.abs(viewer.y - y) <= radius;',
        to: 'return Math.abs(viewer.x - x) < radius && Math.abs(viewer.y - y) < radius;'
    },
    {
        name: 'the square becomes a circle, desynchronising from the minimap',
        file: AOI,
        from: 'return Math.abs(viewer.x - x) <= radius && Math.abs(viewer.y - y) <= radius;',
        to: 'return Math.hypot(viewer.x - x, viewer.y - y) <= radius;'
    },
    {
        name: 'canSee ignores the y axis, so mobs are sent across the whole map width',
        file: AOI,
        from: 'return Math.abs(viewer.x - x) <= radius && Math.abs(viewer.y - y) <= radius;',
        to: 'return Math.abs(viewer.x - x) <= radius;'
    },

    // --- the floor boundary -------------------------------------------------
    {
        // Pre-existing bug class, and one mob AoI made visible: a mob on another floor
        // is announced to this one, at coordinates that mean nothing here.
        name: 'the per-move broadcast drops the floor check',
        file: SERVER,
        from: '        if (MAP.normalizeZ(p.z) !== floor) return;\n        if (AOI.canSee(p, x, y, radius)) sendTo(p, packet);',
        to: '        if (AOI.canSee(p, x, y, radius)) sendTo(p, packet);'
    },
    {
        name: 'the login roster drops the floor check on mobs',
        file: SERVER,
        from: 'if (MAP.normalizeZ(mob.z) === pz && canSeeMob(mob)) {',
        to: 'if (canSeeMob(mob)) {'
    },

    // --- the removal packet -------------------------------------------------
    {
        // The blood-burst bug. Deletes the mob correctly, plays fifteen blood
        // particles every time the player walks away from one.
        name: 'removal reuses alive:false, which the client reads as death',
        file: SERVER,
        from: "sendTo(player, { action: 'mob_forget', id });",
        to: "sendTo(player, { action: 'mob_update', id, alive: false });"
    },
    {
        name: 'the entering announcement uses the new packet, so the client needs it to see mobs',
        file: SERVER,
        from: "                action: 'mob_update', id: e.id, type: e.mob.type, name: e.mob.name,",
        to: "                action: 'mob_forget', id: e.id, type: e.mob.type, name: e.mob.name,"
    },
    {
        name: 'forgetting a mob leaves it on the client forever',
        file: SERVER,
        from: '        for (const id of left) {\n            sendTo(player, { action: \'mob_forget\', id });\n        }',
        to: '        // removal removed'
    },

    // --- the bookkeeping ----------------------------------------------------
    {
        name: 'the known set is never updated, so every mob is re-announced forever',
        file: SERVER,
        from: 'if (entered.length || left.length) mobAoiSets.set(pid, new Set(inRange.map(e => e.id)));',
        to: '// set never updated'
    },
    {
        name: 'a disconnecting player keeps their set forever, leaking one entry per connection',
        file: SERVER,
        from: '            dropMobAoiSet(playerId);',
        to: '            // leak'
    },
    {
        // The persistence hazard: a Set hung off the serialised player object.
        name: 'the reconciliation set is hung off the player object instead of the side map',
        file: SERVER,
        from: 'if (entered.length || left.length) mobAoiSets.set(pid, new Set(inRange.map(e => e.id)));',
        to: 'if (entered.length || left.length) player.aoiMobs = new Set(inRange.map(e => e.id));'
    },

    // --- the spawn path -----------------------------------------------------
    {
        // Found by tests/bots/mob_aoi_probe.js, not by inspection: the test-only spawn
        // action was handed the global broadcast, so a mob spawned 2500px away arrived
        // anyway and a surface mob was announced to players in the dungeon.
        name: 'the spawn broadcast goes back to the global one, leaking across floors',
        file: SERVER,
        from: 'spawnBroadcast: (packet) => sendMobEvent(player.z, packet),',
        to: 'spawnBroadcast: broadcast,'
    },
    {
        name: 'the spawn is announced on the surface regardless of the caller floor',
        file: TESTING,
        from: 'const id = spawnMobAt(x, y, type, spawnBroadcast, floor);',
        to: 'const id = spawnMobAt(x, y, type, spawnBroadcast);'
    },
    {
        name: 'the spawn is validated against the surface even when the caller is underground',
        file: TESTING,
        from: 'if (!isInBounds(x, y) || !isWalkable(x, y, floor)) {',
        to: 'if (!isInBounds(x, y) || !isWalkable(x, y)) {'
    },

    // --- the client contract ------------------------------------------------
    {
        // The gate that used to be a disabled default is now this agreement test. If
        // the handler is ever removed, mob AoI keeps running and every client
        // accumulates a frozen ghost of every mob it has passed -- so removing this
        // branch must break the build.
        //
        // The earlier version of this mutation added the handler, and survived: by
        // then the handler already existed, so adding a second copy changed nothing.
        name: 'the client stops handling mob_forget, leaving every client with ghost mobs',
        file: ENGINE,
        from: '            else if (data.action === "mob_forget") {\n                delete mobs[data.id];\n                if (currentTargetId === data.id) currentTargetId = null;\n            }',
        to: '            // mob_forget handler removed'
    },
    {
        // The other half of the gate: the handler must delete, not mark dead, or it
        // is the blood-burst path this packet was written to avoid.
        name: 'mob_forget is routed through the death branch, restoring the blood burst',
        file: ENGINE,
        from: '            else if (data.action === "mob_forget") {\n                delete mobs[data.id];',
        to: '            else if (data.action === "mob_update" && data.alive === false) {\n                delete mobs[data.id];'
    }
];

function runSuite() {
    try {
        const out = execFileSync(process.execPath, ['--test', TEST, TEST2], {
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

console.log('=== mob AoI mutation testing ===\n');
const base = runSuite();
console.log(`  baseline: ${base.ok ? 'passes' : 'ALREADY FAILING'}`);
if (!base.ok) {
    console.log('    ' + failingTest(base.out));
    console.log('\n  ABORT: green before mutating or nothing below means anything.');
    process.exit(1);
}

let survived = 0;
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
        survived++;
        console.log(`  SURVIVED  ${m.name}`);
        console.log('            the suite passed against injectable code\n');
    } else {
        console.log(`  CAUGHT    ${m.name}`);
        console.log(`            ${failingTest(result.out)}\n`);
    }
}

console.log(`  ${MUTATIONS.length - survived}/${MUTATIONS.length} caught, ${survived} survived`);
if (survived) {
    console.log('\n  A surviving mutation is an assertion that does not assert.');
    process.exitCode = 1;
} else {
    console.log('  Every mutation was caught.');
}
