/*
 * Lists what SPRITE_FILES in renderer.js asks for, with the magenta fraction of
 * each file, so the sprite inventory can be read without a regex in PowerShell.
 *
 * Run:  node tools/sprite_inventory.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'client/js/renderer.js'), 'utf8');
const i = src.indexOf('const SPRITE_FILES');
const seg = src.slice(i, src.indexOf('};', i));

console.log('key -> file');
let m;
const re = /([a-zA-Z0-9_]+)\s*:\s*"([^"]+)"/g;
while ((m = re.exec(seg))) {
    const p = path.join(ROOT, 'client/assets', m[2]);
    const exists = fs.existsSync(p);
    const kb = exists ? (fs.statSync(p).size / 1024).toFixed(0) + ' KB' : 'MISSING';
    console.log(`  ${m[1].padEnd(12)} ${m[2].padEnd(38)} ${kb}`);
}
