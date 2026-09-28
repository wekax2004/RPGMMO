'use strict';
// Floor-scopes the remaining combat broadcasts: five mob_update sites and
// three spell animations.
//
// The spell packet is the one worth noting. It carries sx/sy/tx/ty -- the
// caster and the target -- so a fireball cast in the dungeon drew its projectile
// trail across the surface, from coordinates that mean nothing there.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const FILE = path.join(ROOT, 'server', 'combat.js');

const EDITS = [
    // killMob: the mob is deleted just above, but `target` is still the object
    // reference, so its floor is readable.
    [
        "broadcast({ action: 'mob_update', id: target.id, alive: false });",
        "broadcastToFloor(MAP_NORMALIZE(target.z), { action: 'mob_update', id: target.id, z: MAP_NORMALIZE(target.z), alive: false });"
    ],
    // hitMob
    [
        "broadcast({ action: 'mob_update', id: m.id, type: m.type, name: m.name, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp, alive: true, isElite: m.isElite });",
        "broadcastToFloor(MAP_NORMALIZE(m.z), { action: 'mob_update', id: m.id, type: m.type, name: m.name, x: m.x, y: m.y, z: MAP_NORMALIZE(m.z), hp: m.hp, maxHp: m.maxHp, alive: true, isElite: m.isElite });"
    ],
    // auto-attack against a player target. The two spell broadcasts are
    // byte-identical to each other, so split() replaces both.
    [
        "broadcast({ action: 'spell', type: player.classType, sx: player.x, sy: player.y, tx: target.x, ty: target.y });",
        "broadcastToFloor(MAP_NORMALIZE(player.z), { action: 'spell', type: player.classType, sx: player.x, sy: player.y, tx: target.x, ty: target.y });"
    ],
    [
        "broadcast({ action: 'mob_update', id: player.targetId, x: target.x, y: target.y, hp: target.hp, maxHp: target.maxHp, alive: true, isElite: target.isElite, name: target.name, type: target.type });",
        "broadcastToFloor(MAP_NORMALIZE(target.z), { action: 'mob_update', id: player.targetId, x: target.x, y: target.y, z: MAP_NORMALIZE(target.z), hp: target.hp, maxHp: target.maxHp, alive: true, isElite: target.isElite, name: target.name, type: target.type });"
    ],
    // boss attacks
    [
        "broadcast({ action: 'spell', type: player.classType, sx: player.x, sy: player.y, tx: boss.x, ty: boss.y });",
        "broadcastToFloor(MAP_NORMALIZE(player.z), { action: 'spell', type: player.classType, sx: player.x, sy: player.y, tx: boss.x, ty: boss.y });"
    ],
    [
        "broadcast({ action: 'mob_update', id: bossId, x: boss.x, y: boss.y, hp: boss.hp, maxHp: boss.maxHp, alive: true, isBoss: true, name: boss.name, type: boss.type });",
        "broadcastToFloor(MAP_NORMALIZE(boss.z), { action: 'mob_update', id: bossId, x: boss.x, y: boss.y, z: MAP_NORMALIZE(boss.z), hp: boss.hp, maxHp: boss.maxHp, alive: true, isBoss: true, name: boss.name, type: boss.type });"
    ],
    [
        "broadcast({ action: 'mob_update', id: bossId, alive: false });",
        "broadcastToFloor(MAP_NORMALIZE(boss.z), { action: 'mob_update', id: bossId, z: MAP_NORMALIZE(boss.z), alive: false });"
    ]
];

let src = fs.readFileSync(FILE, 'utf8');
let applied = 0, missing = 0;
for (const [from, to] of EDITS) {
    if (!src.includes(from)) {
        missing++;
        console.log(`  MISS  ${from.slice(0, 72)}`);
        continue;
    }
    src = src.split(from).join(to);
    applied++;
}

// combat.js is a DI factory and has no MAP import; the floor is normalised by a
// tiny local helper rather than pulling map.js into the combat module.
if (src.includes('MAP_NORMALIZE(') && !src.includes('const MAP_NORMALIZE')) {
    src = src.replace(
        'function createCombat(deps) {',
        'function createCombat(deps) {\n' +
        '    // combat.js takes its dependencies by injection and has no map import, so\n' +
        '    // the floor is normalised by an equivalent of map.normalizeZ. Kept in step\n' +
        '    // with the config range: anything unrecognised becomes the surface rather\n' +
        '    // than throwing, because a bad z must never break a damage broadcast.\n' +
        '    const MAP_NORMALIZE = (z) =>\n' +
        '        (Number.isSafeInteger(z) && z >= CFG.Z_MIN && z <= CFG.Z_MAX) ? z : CFG.Z_SURFACE;'
    );
    console.log('  injected the MAP_NORMALIZE helper');
}

if (APPLY) {
    fs.writeFileSync(FILE, src, 'utf8');
    console.log(`  wrote server/combat.js (${applied} sites, ${missing} missed)`);
} else {
    console.log(`  would write ${applied} sites, ${missing} missed`);
}
