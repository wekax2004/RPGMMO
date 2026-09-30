/*
 * Reports committed sprites in client/assets that differ from git HEAD.
 *
 * Why this replaces a threshold check. The first version of this flagged any
 * sprite above 4% magenta, and flagged 25 of 34 -- including warrior, mage and
 * every mob. That was wrong, and wrong in the direction of looking useful. The
 * art in this project is deliberately drawn on a magenta backdrop and keyed to
 * transparency by renderer.js at load time, so a magenta-heavy JPEG is the
 * intended state, not corruption. An absolute threshold cannot tell "supposed to
 * be magenta" from "someone copied a raw source over a finished asset".
 *
 * HEAD can. The invariant that actually matters is not what a file contains but
 * whether it changed underneath us: banker_sprite.jpg and merchant_sprite.jpg
 * were both overwritten by raw magenta sources during development, and because
 * the renderer keys magenta anyway the game kept running and every test kept
 * passing. Nothing failed. It surfaced only by reading a file listing and
 * noticing two assets had moved.
 *
 * So this asks git, which knows the last committed state of every byte.
 *
 * Run:  node tools/check_asset_integrity.js [--staged]
 * Exits non-zero if a tracked asset differs from HEAD (or, with --staged, from
 * the index).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = 'client/assets';
const useStaged = process.argv.includes('--staged');

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function human(bytes) {
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
}

function main() {
    if (!fs.existsSync(path.join(ROOT, ASSETS))) {
        console.error(`no ${ASSETS} directory`);
        return 2;
    }

    // --numstat gives added/deleted per file, which for binaries is 0/0 and
    // therefore useless. So ask for the raw status and read sizes from disk and
    // from git directly.
    const statusArgs = useStaged
        ? ['diff', '--name-status', '--cached', '--', ASSETS]
        : ['diff', '--name-status', 'HEAD', '--', ASSETS];
    const lines = git(statusArgs).split('\n').map(s => s.trim()).filter(Boolean);

    // Referenced sprites, so a changed file can be reported as "this one matters".
    const src = fs.readFileSync(path.join(ROOT, 'client/js/renderer.js'), 'utf8');
    const i = src.indexOf('const SPRITE_FILES');
    const seg = src.slice(i, src.indexOf('};', i));
    const referenced = new Set();
    for (const m of seg.matchAll(/([a-zA-Z0-9_]+)\s*:\s*"([^"]+)"/g)) referenced.add(m[2]);

    if (lines.length === 0) {
        console.log(`${ASSETS}: every tracked sprite matches ${useStaged ? 'the index' : 'HEAD'}`);
        return 0;
    }

    console.log(`${ASSETS}: ${lines.length} tracked sprite(s) differ from ${useStaged ? 'the index' : 'HEAD'}\n`);
    for (const line of lines) {
        const [status, file] = line.split('\t');
        const onDisk = fs.existsSync(path.join(ROOT, file));
        let size = '?';
        if (onDisk) size = human(fs.statSync(path.join(ROOT, file)).size);
        let was = '?';
        try {
            const blob = execFileSync('git', ['cat-file', '-s', `${useStaged ? ':' : 'HEAD:'}${file}`], {
                cwd: ROOT, encoding: 'utf8'
            });
            was = human(Number(blob.trim()));
        } catch { /* new file, or absent from that ref */ }

        const used = referenced.has(path.basename(file));
        console.log(`  ${status.padEnd(2)} ${file}`);
        console.log(`      ${was} -> ${size}${used ? '   [referenced by the client]' : '   [not referenced]'}`);
    }

    console.log('\n  A referenced sprite that changed is worth a look: the art is keyed to');
    console.log('  transparency at load, so an unprocessed source renders as a silhouette');
    console.log('  and a broken one renders as a hole -- neither raises an error.');
    console.log('  To accept a change on purpose, commit it. To undo it: git checkout -- ' + ASSETS);
    return 1;
}

process.exit(main());
