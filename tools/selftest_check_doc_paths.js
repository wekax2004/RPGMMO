/*
 * Injects a path that does not exist into PROJECT.md, to prove check_doc_paths
 * fires, then restores the original. Used to verify the guard rather than assume it.
 *
 * Run:  node tools/selftest_check_doc_paths.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'PROJECT.md');
const CHECK = path.join(__dirname, 'check_doc_paths.js');

const original = fs.readFileSync(DOC, 'utf8');

// A path that is unmistakably fake but shaped exactly like a real one.
const FAKE = 'server/world/map_grid.js';

function runCheck() {
    try {
        execFileSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true };
    } catch (e) {
        return { ok: false, out: ((e.stdout || '') + (e.stderr || '')) };
    }
}

function main() {
    const clean = runCheck();
    console.log('  unmutated: ' + (clean.ok ? 'passes' : 'FAILS'));
    if (!clean.ok) {
        console.log('    the document does not satisfy its own check; fix that first');
        return 1;
    }

    // `map.js` appears twice: once as a table row under the server/ heading, once
    // as a tree entry. Rewriting both turns one real path into two fake ones,
    // which is the point -- the check should fail and name them.
    if (!original.includes('map.js')) {
        console.log('    anchor "map.js" not found; PROJECT.md has drifted, update this selftest');
        return 1;
    }

    fs.writeFileSync(DOC, original.split('map.js').join('world/map_grid.js'), 'utf8');
    let mutated;
    try {
        mutated = runCheck();
    } finally {
        fs.writeFileSync(DOC, original, 'utf8');
    }

    if (mutated.ok) {
        console.log(`  with ${FAKE} in place of server/map.js: STILL PASSES -- the guard does not fire`);
        return 1;
    }

    // The check reports the composed path from the tree walk, so a faked
    // map_grid.js under server/world/ surfaces as "server/world/world/map_grid.js"
    // or similar depending on nesting. What matters is that it names a path that
    // contains the fake name, and that it fails.
    const named = mutated.out.includes('map_grid.js');
    console.log(`  with ${FAKE} in place of map.js: fails${named ? ', and names it' : ', but does NOT name it'}`);
    if (!named) {
        console.log('    output was:');
        for (const l of mutated.out.split('\n').filter(x => /do not resolve|^ {4}\S/.test(x))) {
            console.log(`      ${l}`);
        }
    }
    const restored = runCheck();
    console.log('  after restore: ' + (restored.ok ? 'passes' : 'still fails'));
    return named && restored.ok ? 0 : 1;
}

process.exit(main());
