'use strict';
// One-off integrity check: no BOM, no mojibake, in every file this change
// touched. Set-Content in this project previously added a BOM to config.js and
// double-encoded its Hebrew comments, so this is checked rather than assumed.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FILES = [
    'server/config.js', 'server/map.js', 'server/mobs.js', 'server/bosses.js',
    'server/chests.js', 'server/quests.js', 'server/server.js',
    'tests/unit/zlevels.test.js', 'tools/mutate_zlevels.js'
];
let bad = 0;
for (const rel of FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) { console.log(`  ${rel.padEnd(30)} MISSING`); bad++; continue; }
    const buf = fs.readFileSync(full);
    const text = buf.toString('utf8');
    const bom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    const mojibake = (text.match(/\uFFFD/g) || []).length;
    const ok = !bom && mojibake === 0;
    if (!ok) bad++;
    console.log(`  ${rel.padEnd(30)} ${ok ? 'ok  ' : 'BAD '} BOM=${bom ? 'YES' : 'no'}  U+FFFD=${mojibake}`);
}
console.log(bad === 0 ? '\n  all files clean' : `\n  ${bad} file(s) need attention`);
process.exitCode = bad === 0 ? 0 : 1;
