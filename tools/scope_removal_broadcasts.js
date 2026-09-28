'use strict';
// Floor-scopes the remaining positional broadcasts.
//
// Same defect as the fct sweep: a packet that describes one floor's world went
// to every client, so a chest vanishing in the dungeon removed a chest sprite on
// the surface, and a gathering node being harvested in one place was announced
// as harvested on every floor.
//
// Each removal is scoped to the floor the entity actually lived on, which is
// read from the entity before it is deleted -- after the delete there is nothing
// left to ask.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const FILE = path.join(ROOT, 'server', 'server.js');

// [from, to]
const EDITS = [
    // Chest looted: the chest variable still holds its floor at this point.
    [
        'chests.delete(chestId); broadcast({ action: \'chest_update\', id: chestId, active: false });',
        'chests.delete(chestId); broadcastToFloor(MAP.normalizeZ(chest.z), { action: \'chest_update\', id: chestId, active: false });'
    ],
    // Node harvested: same, node.z is the floor it stood on.
    [
        'broadcast({ action: \'node_remove\', id: nodeId });',
        'broadcastToFloor(MAP.normalizeZ(node.z), { action: \'node_remove\', id: nodeId });'
    ],
    // Corpse looted. The handler holds the corpse in `c`, and the broadcast must
    // happen BEFORE the delete or there is nothing left to ask about its floor.
    // The variable name matters: an earlier draft of this entry read `corpse.z`
    // here. The anchor still matched, and the replacement would have thrown a
    // ReferenceError the first time a corpse was looted -- a matching anchor is
    // not the same as a correct replacement.
    [
        'corpses.delete(data.id);\n                        broadcast({ action: \'corpse_remove\', id: data.id });',
        'broadcastToFloor(MAP.normalizeZ(c.z), { action: \'corpse_remove\', id: data.id });\n                        corpses.delete(data.id);'
    ],
    // Corpse sweep: same, the entry is still in hand inside the loop.
    [
        'broadcast({ action: \'corpse_remove\', id });\n            removed++;',
        'broadcastToFloor(MAP.normalizeZ(corpse.z), { action: \'corpse_remove\', id });\n            removed++;'
    ]
];

let src = fs.readFileSync(FILE, 'utf8');
const before = src;
let applied = 0, missing = 0;

for (const [from, to] of EDITS) {
    if (!src.includes(from)) {
        missing++;
        console.log(`  MISS  ${from.slice(0, 74).replace(/\n/g, ' ')}`);
        continue;
    }
    src = src.replace(from, to);
    applied++;
}

if (src === before) {
    console.log('  nothing to rewrite (already applied, or the source drifted)');
} else {
    console.log(`  call sites rewritten: ${applied}`);
    console.log(`  anchors not found  : ${missing}`);
    if (missing > 0) console.log('  Reported, not guessed -- fix those by hand.');
    if (APPLY) {
        fs.writeFileSync(FILE, src, 'utf8');
        console.log('  wrote server/server.js');
    } else {
        console.log('  dry run -- pass --apply to write');
    }
}
