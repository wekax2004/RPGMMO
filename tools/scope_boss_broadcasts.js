'use strict';
// Floor-scope the boss movement broadcast.
//
// bosses.js receives a bare `broadcast` from server.js, so it cannot scope by
// floor on its own. This rewrites the two mob_move sites to use a
// broadcastToFloor that server.js passes in alongside broadcast, and injects the
// parameter.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'server', 'bosses.js');
const APPLY = process.argv.includes('--apply');

let src = fs.readFileSync(FILE, 'utf8');
const before = src;

const OLD = "broadcast({ action: 'mob_move', id: boss.id, x: boss.x, y: boss.y });";
const NEW = "broadcastToFloor(boss.z, { action: 'mob_move', id: boss.id, x: boss.x, y: boss.y, z: boss.z });";
const count = src.split(OLD).length - 1;
src = src.split(OLD).join(NEW);

// bossAI is the only caller that moves a boss, so that is the signature to widen.
src = src.replace(
    /function bossAI\(([^)]*)\)/,
    (m, args) => {
        const list = args.split(',').map(s => s.trim()).filter(Boolean);
        if (list.includes('broadcastToFloor')) return m;
        list.push('broadcastToFloor');
        return `function bossAI(${list.join(', ')})`;
    }
);

if (src === before) {
    console.log('  nothing to rewrite (already applied, or the anchor drifted)');
} else {
    console.log(`  mob_move sites rewritten: ${count}`);
    console.log('  bossAI signature widened to accept broadcastToFloor');
    if (APPLY) {
        fs.writeFileSync(FILE, src, 'utf8');
        console.log('  wrote server/bosses.js');
    } else {
        console.log('  dry run -- pass --apply to write');
    }
}
