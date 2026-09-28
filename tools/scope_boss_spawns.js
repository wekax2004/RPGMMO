'use strict';
// Floor-scopes the boss spawn announcements and gives them a floor.
//
// Two sites, both global and both missing z. A boss spawning is announced to
// every client with no way to say which world the coordinates belong to --
// which is also what made "did a dungeon mob leak?" unanswerable in the live
// run: legitimate entries with no floor were indistinguishable from real leaks.
//
// bosses.js takes its broadcast from the caller, so the floor comes from the
// boss being announced rather than from a parameter.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const FILE = path.join(ROOT, 'server', 'bosses.js');

const EDITS = [
    [
        "    broadcast({\n        action: 'mob_update',\n        id: boss.id,",
        "    broadcastToFloor(boss.z, {\n        action: 'mob_update',\n        id: boss.id,\n        z: boss.z,"
    ],
    // The respawned minion: `boss` is the boss it belongs to, and a minion
    // shares its floor.
    [
        "        broadcast({\n            action: 'mob_update',\n            id, type, name, x, y,\n            hp: stats.hp, maxHp: stats.hp,\n            alive: true, isElite: false\n        });",
        "        broadcastToFloor(MAP.normalizeZ(boss.z), {\n            action: 'mob_update',\n            id, type, name, x, y, z: MAP.normalizeZ(boss.z),\n            hp: stats.hp, maxHp: stats.hp,\n            alive: true, isElite: false\n        });"
    ]
];

let src = fs.readFileSync(FILE, 'utf8');
let applied = 0, missing = 0;
for (const [from, to] of EDITS) {
    if (!src.includes(from)) { missing++; console.log(`  MISS  ${from.slice(0, 60).replace(/\n/g, ' ')}`); continue; }
    src = src.replace(from, to);
    applied++;
}

if (APPLY) {
    fs.writeFileSync(FILE, src, 'utf8');
    console.log(`  wrote server/bosses.js (${applied} sites, ${missing} missed)`);
} else {
    console.log(`  would write ${applied} sites, ${missing} missed`);
}
