/*
 * Checks that the claims PROJECT.md and README.md make about the repository are
 * countable, by counting them.
 *
 * PROJECT.md already has check_doc_paths.js, which proves every path it names
 * resolves. That catches the failure that misled a reader — a document pointing
 * at files that were never built — but it cannot catch the softer version: a
 * document saying "200 unit tests" when there are not 200, or listing a directory
 * that holds something else.
 *
 * So this pins the countable claims to the tree. Deliberately narrow: it checks
 * numbers and directory contents, not prose. If a sentence cannot be counted, it
 * is not this tool's job, and pretending otherwise would make the tool look
 * stronger than it is.
 *
 * Run:  node tools/check_doc_claims.js
 * Exits non-zero if a countable claim does not match the repository.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const docs = ['PROJECT.md', 'README.md'].map(f => ({ name: f, src: fs.readFileSync(path.join(ROOT, f), 'utf8') }));

const facts = {};

function countUnitTests() {
    const dir = path.join(ROOT, 'tests/unit');
    let n = 0;
    let files = 0;
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.test.js')) continue;
        files++;
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        // Count `test(` at the start of a declaration, which is how this repo
        // writes them. Counting the string "test(" would also match
        // `.test.js` mentions and `test(` inside comments.
        n += [...src.matchAll(/^test\(/gm)].length;
    }
    return { total: n, files };
}

function dirStats(rel) {
    const dir = path.join(ROOT, rel);
    if (!fs.existsSync(dir)) return null;
    let files = 0;
    let bytes = 0;
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else { files++; bytes += fs.statSync(p).size; }
        }
    };
    walk(dir);
    return { files, mb: bytes / 1024 / 1024 };
}

function serverModuleCount() {
    return fs.readdirSync(path.join(ROOT, 'server'))
        .filter(f => f.endsWith('.js')).length;
}

/*
 * Asset counts come from git, not the filesystem.
 *
 * The working tree and the repository disagree, and the difference is large: 149
 * tracked files totalling 97.7 MB, against 82 files on disk totalling 41.4 MB.
 * A document that says "41.4 MB" is describing a checkout, not the repository,
 * and the number a reader would verify against a fresh clone is the other one.
 *
 * The document should state the committed figure and can note the working-tree
 * one separately, because that difference is itself worth knowing: the tree
 * carries roughly 56 MB of assets that are committed but not present locally.
 */
function gitFiles(rel) {
    const out = execFileSync('git', ['ls-files', rel], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').filter(Boolean).length;
}

function gitBytes(rel) {
    const files = execFileSync('git', ['ls-files', rel], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter(Boolean);
    let total = 0;
    for (const f of files) {
        try {
            total += Number(execFileSync('git', ['cat-file', '-s', `HEAD:${f}`], { cwd: ROOT, encoding: 'utf8' }).trim());
        } catch { /* not in HEAD, e.g. staged but uncommitted */ }
    }
    return total;
}

facts['unit tests'] = countUnitTests();
facts['unit test files'] = { total: facts['unit tests'].files };
facts['server modules'] = { total: serverModuleCount() };
facts['client/assets files (git)'] = { total: gitFiles('client/assets') };
facts['client/assets MB (git)'] = { total: Math.round(gitBytes('client/assets') / 1024 / 1024 * 10) / 10 };
facts['client/assets files (disk)'] = { total: dirStats('client/assets').files };
facts['client/assets MB (disk)'] = { total: Math.round(dirStats('client/assets').mb * 10) / 10 };
facts['client/assets unused MB'] = { total: Math.round(unusedAssetBytes() / 1024 / 1024 * 10) / 10 };
// A share is the unused figure as a percentage of the committed one. Computed
// once and named, so a claim about it never has to re-derive the denominator and
// risk reading the wrong key back as undefined.
facts['client/assets unused share'] = {
    total: Math.round(facts['client/assets unused MB'].total / facts['client/assets MB (git)'].total * 100)
};

/*
 * Bytes in committed assets that no client source names.
 *
 * Compared against the client sources by BASENAME, because SPRITE_FILES names
 * files rather than paths. Anything under rpg-import/ is counted as unused: it
 * is a third-party import that nothing references, and it is 56.3 MB of it.
 */
function unusedAssetBytes() {
    const files = execFileSync('git', ['ls-files', 'client/assets'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter(Boolean);
    const referenced = new Set();
    for (const rel of ['client/js/renderer.js', 'client/js/engine.js', 'client/js/ui.js', 'client/test_client.html']) {
        const p = path.join(ROOT, rel);
        if (!fs.existsSync(p)) continue;
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/["']([\w\-. ]+\.(?:png|jpg|jpeg|gif|webp))["']/g)) referenced.add(m[1]);
    }
    let total = 0;
    for (const f of files) {
        if (referenced.has(path.basename(f))) continue;
        try {
            total += Number(execFileSync('git', ['cat-file', '-s', `HEAD:${f}`], { cwd: ROOT, encoding: 'utf8' }).trim());
        } catch { /* not in HEAD */ }
    }
    return total;
}

// The claims each document makes, as a number the document has to contain.
// Anchored to the surrounding wording so a doc cannot pass by containing the
// right digits in an unrelated sentence.
const CLAIMS = [
    { doc: 'PROJECT.md', fact: 'unit tests', pattern: /(\d+)\s+unit tests/i, label: 'unit test count' },
    { doc: 'PROJECT.md', fact: 'unit test files', pattern: /across (\d+) files/i, label: 'unit test file count' },
    { doc: 'PROJECT.md', fact: 'server modules', pattern: /server\/server\.js`\s*\|\s*Entry point/i, label: 'server module count (existence only)' },
    // Asset figures are the COMMITTED ones, read from git. An earlier version of
    // both documents quoted 82 files and 41.4 MB, which came from a file listing
    // that did not recurse: client/assets/rpg-import/ holds 67 of them. A
    // non-recursive count is a plausible-looking number that is simply wrong, so
    // the claim is pinned to git rather than trusted to prose.
    // Matched against the Code Layout tree line, which uses box-drawing
    // characters rather than pipes.
    { doc: 'PROJECT.md', fact: 'client/assets files (git)', pattern: /assets\/[^\n]*#\s*(\d+) files/i, label: 'client/assets file count' },
    { doc: 'PROJECT.md', fact: 'client/assets MB (git)', pattern: /assets\/[^\n]*#\s*\d+ files,\s*([\d.]+) MB/i, label: 'client/assets MB' },
    { doc: 'PROJECT.md', fact: 'client/assets unused MB', pattern: /\*\*([\d.]+) MB of the ([\d.]+) MB committed/i, label: 'client/assets unused MB', capture: 1 },
    { doc: 'PROJECT.md', fact: 'client/assets unused share', pattern: /committed in `client\/assets\/` is loaded by nothing\*\*\s*[—-]\s*(\d+)%/i, label: 'client/assets unused share' },
    { doc: 'README.md', fact: 'unit tests', pattern: /#\s*(\d+)\s+unit tests/, label: 'unit test count' },
    // The README layout block uses plain spaces, not the box-drawing characters
    // PROJECT.md's tree uses, so this pattern does not assume a pipe or a corner.
    { doc: 'README.md', fact: 'client/assets MB (git)', pattern: /assets\/\s+Sprites and tiles,\s*(\d+) files,\s*([\d.]+) MB/i, label: 'client/assets size', capture: 2 },
    { doc: 'README.md', fact: 'client/assets unused share', pattern: /`client\/assets\/` is (\d+)% unused/i, label: 'client/assets unused share' },
];

function main() {
    console.log('documented claims vs the repository\n');
    console.log('  measured:');
    for (const [k, v] of Object.entries(facts)) {
        console.log(`    ${k.padEnd(24)} ${v.total}`);
    }
    console.log('');

    const problems = [];
    for (const claim of CLAIMS) {
        const doc = docs.find(d => d.name === claim.doc);
        if (!doc) continue;
        const m = claim.pattern.exec(doc.src);
        if (!m) {
            // An existence-only claim has nothing numeric to compare.
            if (claim.label.includes('existence only')) {
                const asserted = fs.existsSync(path.join(ROOT, 'server/server.js'));
                console.log(`  ${claim.doc}: ${claim.label} -- ${asserted ? 'ok' : 'FAILED (server/server.js missing)'}`);
                if (!asserted) problems.push(`${claim.doc}: ${claim.label}`);
            } else {
                console.log(`  ${claim.doc}: ${claim.label} -- no matching sentence found`);
                problems.push(`${claim.doc}: ${claim.label} (no sentence to check)`);
            }
            continue;
        }
        const claimed = Number(m[claim.capture || 1]);

        // A claim about a share is compared as a percentage rather than an
        // absolute, because that is how the document states it.
        if (claim.expect === 'percentage') {
            const base = facts['client/assets MB (git)'];
            const actualPct = Math.round(facts[claim.fact].total / base.total * 100);
            const ok = claimed === actualPct;
            console.log(`  ${claim.doc}: ${claim.label.padEnd(28)} says ${claimed}%, actual ${actualPct}%  ${ok ? 'ok' : 'MISMATCH'}`);
            if (!ok) problems.push(`${claim.doc}: ${claim.label} says ${claimed}%, actual ${actualPct}%`);
            continue;
        }

        const actual = facts[claim.fact].total;
        const ok = claimed === actual;
        console.log(`  ${claim.doc}: ${claim.label.padEnd(28)} says ${claimed}, actual ${actual}  ${ok ? 'ok' : 'MISMATCH'}`);
        if (!ok) problems.push(`${claim.doc}: ${claim.label} says ${claimed}, actual ${actual}`);
    }

    if (problems.length === 0) {
        console.log('\n  every countable claim matches');
        console.log('\n  This checks numbers and existence only. Whether the prose is accurate is');
        console.log('  still a reading job.');
        return 0;
    }
    console.log('\n  mismatched claims:');
    for (const p of problems) console.log(`    ${p}`);
    return 1;
}

process.exit(main());
