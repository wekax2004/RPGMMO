/*
 * Packs the source for handing to another tool or reviewer.
 *
 * Why this exists rather than a bare `git archive`:
 *
 *   git archive HEAD produces ~100 MB, because client/assets is 100 MB of
 *   generated art -- 149 files of grass tiles, tree sprites and magenta-keyed
 *   intermediates. None of it is source, and none of it is what a question
 *   about the code needs. It also pulls in client/warrior.jpg, a 556 KB
 *   duplicate that sits loose in client/ rather than in client/assets.
 *
 *   server/data/ (11 account records with passwordHash and salt) and the two
 *   proprietary sprite checkouts are NOT in this archive. That is not a filter
 *   this script applies -- they are .gitignore'd, so `git ls-files` never sees
 *   them and there is nothing to exclude. That is the reason to build the file
 *   list from git rather than from a filesystem glob.
 *
 * Usage:  node tools/pack_source.js [outfile]
 * Default outfile: rpgmmo-source.zip in the repo root.
 *
 * NOTE ON THE COMMENT STYLE. This header is a block comment, not a run of hash
 * lines, and that is not a preference. Under Node 25 a bare hash character
 * starting a comment is a SyntaxError anywhere in a .js file; only the two
 * slashes, a slash-star pair, and a real hashbang parse. The Python tools in
 * this repo can use hash comments freely, a .js file cannot.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'rpgmmo-source.zip');

const EXCLUDE_PREFIXES = [
    'client/assets/',   // 100 MB of art, none of it source
    'server/data/',     // live DB: accounts, password hashes, player rows
    'node_modules/',
];

// Lockfiles pin ~2000 transitive packages at 65 KB and say nothing about the
// code. Dropped by default; pass --with-lockfile to keep them.
const DROP_FILES = new Set(['package-lock.json', 'server/package-lock.json']);

const wantLock = process.argv.includes('--with-lockfile');

function trackedFiles() {
    const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
}

function keep(rel) {
    if (EXCLUDE_PREFIXES.some(p => rel.startsWith(p))) return false;
    if (!wantLock && DROP_FILES.has(rel.replace(/\\/g, '/'))) return false;
    return true;
}

function main() {
    const all = trackedFiles();
    const files = all.filter(keep);
    const dropped = all.length - files.length;

    if (files.length === 0) {
        console.error('nothing selected -- is this a git repository?');
        process.exit(1);
    }

    // -o writes the archive, so a failure leaves no half-file behind that looks
    // like a successful export.
    try { fs.unlinkSync(OUT); } catch { /* absent is the normal case */ }
    execFileSync('git', ['archive', '--format=zip', '-o', OUT, 'HEAD', '--', ...files], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
    });

    const size = fs.statSync(OUT).size;
    if (size === 0) {
        console.error(`git archive reported success but wrote 0 bytes to ${OUT}`);
        process.exit(1);
    }

    console.log(`wrote ${OUT}`);
    console.log(`  ${files.length} of ${all.length} tracked files, ${(size / 1024).toFixed(0)} KB`);
    if (dropped > 0) {
        console.log(`  excluded ${dropped}:`);
        for (const p of EXCLUDE_PREFIXES) {
            const n = all.filter(f => f.startsWith(p)).length;
            if (n) console.log(`    ${p} ${n} files`);
        }
        if (!wantLock) console.log('    lockfiles (pass --with-lockfile to keep)');
    }

    // Prove the two things that must never be in here are not in here. A zip is
    // a list of names, so this can be checked without unpacking it.
    const names = execFileSync('git', ['archive', '--format=zip', 'HEAD', '--', ...files], {
        cwd: ROOT, encoding: 'buffer', maxBuffer: 1 << 28
    });
    const listing = names.toString('latin1');
    for (const forbidden of ['server/data/', 'client/assets/']) {
        if (listing.includes(forbidden)) {
            console.error(`  FAILED: ${forbidden} is present in the archive`);
            process.exit(1);
        }
    }
    console.log('  verified: no server/data/ and no client/assets/ inside');
    return 0;
}

process.exit(main());
