/*
 * Asserts every CFG.<NAME> referenced by the server actually exists in config.js.
 *
 * Why this exists: config.js is a plain `module.exports = { ... }` literal, so a
 * misspelled or renamed key is not a load error. It is `undefined` at the point
 * of use, and `player.mana + undefined` is NaN -- which does not throw, does not
 * log, and silently ends mana regeneration for every player in the game. The only
 * symptom is that nobody has mana.
 *
 * That is not hypothetical. Renaming MANA_REGEN_PER_SEC to MANA_REGEN_PER_TICK
 * landed as exactly this: the name changed in one file and not the other, and
 * the tests were green because no test asserts that a constant resolves.
 *
 * Scans every CFG.<NAME> reference in the server sources against config.js.
 * Run:  node tools/check_config_keys.js
 * Exits non-zero if any referenced key is missing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'server', 'config.js');

// Every server source that dereferences CFG. The client is excluded on purpose:
// it has no config.js, and a CFG reference there would be a different bug.
const SCAN_DIRS = ['server'];
const SCAN_EXT = /\.js$/;

function configKeys() {
    const src = fs.readFileSync(CONFIG, 'utf8');
    const keys = new Set();
    // Top-level keys of the exported literal: four spaces, NAME:, ... Nested
    // objects would also match, which is harmless -- a nested key cannot
    // collide with a CFG.<NAME> dereference.
    for (const m of src.matchAll(/^\s{4}([A-Z0-9_]+)\s*:/gm)) keys.add(m[1]);
    return keys;
}

function sourceFiles(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'data') continue;
            sourceFiles(full, acc);
        } else if (SCAN_EXT.test(entry.name)) {
            acc.push(full);
        }
    }
    return acc;
}

function main() {
    const keys = configKeys();
    const files = SCAN_DIRS.flatMap(d => sourceFiles(path.join(ROOT, d)));
    const missing = [];
    let totalRefs = 0;

    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        src.split('\n').forEach((line, i) => {
            // CFG.Foo, but not a definition site and not a dynamic lookup.
            for (const m of line.matchAll(/\bCFG\.([A-Z][A-Z0-9_]*)/g)) {
                totalRefs++;
                if (!keys.has(m[1])) {
                    missing.push(`${path.relative(ROOT, file)}:${i + 1}  CFG.${m[1]}`);
                }
            }
        });
    }

    console.log(`config.js exports ${keys.size} constants`);
    console.log(`scanned ${files.length} server files, ${totalRefs} CFG.* references`);

    if (missing.length === 0) {
        console.log('  clean: every CFG.* reference resolves');
        return 0;
    }

    // Deduplicate: one missing key referenced from forty lines is one bug.
    const byKey = new Map();
    for (const m of missing) {
        const key = m.slice(m.indexOf('CFG.'));
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(m);
    }
    console.log(`  ${byKey.size} distinct constant(s) do not exist:`);
    for (const [key, where] of byKey) {
        console.log(`\n    ${key}`);
        console.log(`      referenced at ${where.length} site(s), first:`);
        for (const w of where.slice(0, 4)) console.log(`        ${w}`);
        if (where.length > 4) console.log(`        ... and ${where.length - 4} more`);
    }
    console.log('\n  A missing constant is undefined, not an error. Arithmetic with it');
    console.log('  yields NaN, which no test will catch unless something asserts the');
    console.log('  constant resolves.');
    return 1;
}

process.exit(main());
