'use strict';
// Passes the floor into every inSafeZone() call.
//
// inSafeZone is now floor-aware: only the surface has a safe zone. Every caller
// has to say which floor it is asking about, or it silently defaults to the
// surface -- which is exactly the coincidence the change was meant to remove.
//
// The mapping is by what the check is about:
//   - a mob's spawn or step        -> the mob's own floor
//   - a mob's target               -> the mob's floor (can it reach safety)
//   - a player's healing tick      -> the player's floor
//   - a PvP attacker/victim pair   -> each of their own floors
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

// [file, from, to]
const EDITS = [
    // mobs.js: the pack spawner and the two step checks all concern the mob.
    ['server/mobs.js',
        '} while (!isWalkable(packX, packY) || inSafeZone(packX, packY) || zone === \'City\');',
        '} while (!isWalkable(packX, packY) || inSafeZone(packX, packY, CFG.Z_SURFACE) || zone === \'City\');'],
    ['server/mobs.js',
        'if (isWalkable(x, y) && !inSafeZone(x, y)) {',
        'if (isWalkable(x, y) && !inSafeZone(x, y, CFG.Z_SURFACE)) {'],
    ['server/mobs.js',
        'if (isWalkable(nx, ny) && !inSafeZone(nx, ny)) {\n        mob.x = nx; mob.y = ny;',
        'if (isWalkable(nx, ny) && !inSafeZone(nx, ny, MAP.normalizeZ(mob.z))) {\n        mob.x = nx; mob.y = ny;'],
    ['server/mobs.js',
        'if (isWalkable(nx, ny) && !inSafeZone(nx, ny)) {\n        mob.x = nx; mob.y = ny;',
        'if (isWalkable(nx, ny) && !inSafeZone(nx, ny, MAP.normalizeZ(mob.z))) {\n        mob.x = nx; mob.y = ny;'],

    // combat.js: a spell cannot be cast from safety, and PvP needs both out.
    ['server/combat.js',
        'return !inSafeZone(caster.x, caster.y) && !inSafeZone(target.x, target.y);',
        'return !inSafeZone(caster.x, caster.y, caster.z) && !inSafeZone(target.x, target.y, target.z);'],
    ['server/combat.js',
        'if (player.warmode && target.warmode && !inSafeZone(player.x, player.y) && !inSafeZone(target.x, target.y)) {',
        'if (player.warmode && target.warmode && !inSafeZone(player.x, player.y, player.z) && !inSafeZone(target.x, target.y, target.z)) {'],

    // server.js: the safe-zone heal tick, and the two aggro scans. The aggro
    // scans ask whether a mob can pick a target, so the relevant floor is the
    // mob's: a dungeon mob has no safe zone to shelter anybody in.
    ['server/server.js',
        'if (inSafeZone(p.x, p.y)) {',
        'if (inSafeZone(p.x, p.y, p.z)) {'],
    ['server/server.js',
        'if (p.hp > 0 && !inSafeZone(p.x, p.y)) {\n                const d2 = dist3D(p.x, p.y, p.z, mob.x, mob.y, mob.z);',
        'if (p.hp > 0 && !inSafeZone(p.x, p.y, mob.z)) {\n                const d2 = dist3D(p.x, p.y, p.z, mob.x, mob.y, mob.z);'],
    ['server/server.js',
        'if (p.hp > 0 && !inSafeZone(p.x, p.y)) {\n                const d2 = dist3D(p.x, p.y, p.z, boss.x, boss.y, boss.z);',
        'if (p.hp > 0 && !inSafeZone(p.x, p.y, boss.z)) {\n                const d2 = dist3D(p.x, p.y, p.z, boss.x, boss.y, boss.z);']
];

let applied = 0;
let missing = 0;
const byFile = new Map();

for (const [rel, from, to] of EDITS) {
    const full = path.join(ROOT, rel);
    if (!byFile.has(full)) byFile.set(full, fs.readFileSync(full, 'utf8'));
    const src = byFile.get(full);
    if (!src.includes(from)) {
        missing++;
        console.log(`  MISS ${rel}: ${from.slice(0, 70).replace(/\n/g, ' ')}`);
        continue;
    }
    byFile.set(full, src.replace(from, to));
    applied++;
}

for (const [full, text] of byFile) {
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (APPLY) {
        fs.writeFileSync(full, text, 'utf8');
        console.log(`  wrote ${rel}`);
    } else {
        console.log(`  would write ${rel}`);
    }
}

console.log(`\n  call sites rewritten: ${applied}`);
console.log(`  anchors not found  : ${missing}`);
if (missing > 0) console.log('  Those are reported, not guessed. Re-read and fix by hand.');
if (!APPLY && applied > 0) console.log('  dry run -- pass --apply to write');
