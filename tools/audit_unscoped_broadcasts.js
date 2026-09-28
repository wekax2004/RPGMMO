'use strict';
/**
 * Reports every broadcast of a positional packet that is not floor-scoped.
 *
 * A packet carrying a world coordinate, or describing an entity that lives on a
 * particular floor, must not go to every client: the recipient draws it in a
 * world where the coordinates mean nothing, and there is no way for it to tell
 * the difference. This has been the shape of every floor leak found so far --
 * mob movement, node respawn, chest looted, corpse looted, ground sync, and all
 * forty floating combat texts.
 *
 * The one legitimate exception is a helper that RECEIVES an already-scoped
 * broadcast function. spawnMobPack is called with broadcastSurface, so the bare
 * `broadcast(` inside it is scoped at the call site rather than here. That is
 * noted rather than assumed.
 *
 * Run:  node tools/audit_unscoped_broadcasts.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');

// Packets whose payload is a world position or a per-floor entity.
const POSITIONAL = [
    'fct', 'mob_update', 'mob_move', 'node_sync', 'node_remove',
    'corpse_spawn', 'corpse_remove', 'chest_update', 'ground_sync',
    'player_update', 'players_sync'
];

// Sites that are correct despite looking unscoped: the function receives an
// already-scoped broadcast from its caller. Kept as an explicit allowlist with
// the reason, so a new one has to be justified rather than added quietly.
const SCOPED_BY_CALLER = {
    'mobs.js': 'spawnMobPack receives broadcastSurface from server.js, which is ' +
        'broadcastToFloor(CFG.Z_SURFACE, ...); spawnFloorPack and spawnMobAt take ' +
        'their own floor argument.'
};

// A file in this map is allowed to contain the bare `broadcast(` calls its
// scoped-by-caller helpers use.
const ALLOWED_FILES = new Set(Object.keys(SCOPED_BY_CALLER));

const results = [];
for (const file of fs.readdirSync(SERVER).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(SERVER, file), 'utf8');
    src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;          // comments
        if (/function\s+broadcast\b/.test(line)) return;
        // A global call: `broadcast(` NOT preceded by broadcastToFloor/sendTo.
        const m = /(?<![A-Za-z0-9_$])broadcast\(\s*\{\s*action:\s*'([a-z_]+)'/.exec(line);
        if (!m) return;
        const action = m[1];
        if (!POSITIONAL.includes(action)) return;
        results.push({ file, line: i + 1, action, text: line.trim() });
    });
}

const unexpected = results.filter(r => !ALLOWED_FILES.has(r.file));

console.log('=== unscoped positional broadcasts ===\n');
if (unexpected.length === 0) {
    console.log('  none. every positional packet is floor-scoped.');
} else {
    for (const r of unexpected) {
        console.log(`  ${r.file}:${r.line}  ${r.action}`);
        console.log(`      ${r.text.slice(0, 100)}`);
    }
    console.log(`\n  ${unexpected.length} site(s) to review.`);
}
const allowed = results.filter(r => ALLOWED_FILES.has(r.file));
for (const r of allowed) {
    console.log(`\n  allowed: ${r.file}:${r.line}  ${r.action}`);
    console.log(`      ${SCOPED_BY_CALLER[r.file]}`);
}
console.log(`\n  audited ${POSITIONAL.length} positional actions across ${fs.readdirSync(SERVER).filter(f => f.endsWith('.js')).length} files`);
process.exitCode = unexpected.length === 0 ? 0 : 1;
