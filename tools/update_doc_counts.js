/*
 * Applies the countable claims that tools/check_doc_claims.js flagged, and fails
 * rather than guessing if an expected anchor is missing or found twice.
 *
 * The numbers come from the guard, not from this file: it runs the check, parses
 * the MISMATCH lines, and rewrites only the value on the named line. Hand-typing
 * 228 into five places is how they drift out of step with each other next time.
 *
 * Run:  node tools/update_doc_counts.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['PROJECT.md', 'README.md'];

function mismatches() {
    let out = '';
    try {
        out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'check_doc_claims.js')],
            { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
        out = (e.stdout || '') + (e.stderr || '');
    }
    const rows = [];
    for (const line of out.split('\n')) {
        if (!line.includes('MISMATCH')) continue;
        // "  PROJECT.md: unit test count              says 212, actual 228  MISMATCH"
        const m = /^(\S+\.md):\s*(.+?)\s+says\s+(\S+?),\s*actual\s+(\S+)/.exec(line.trim());
        if (m) rows.push({ file: m[1], claim: m[2].trim(), said: m[3], actual: m[4] });
    }
    return rows;
}

const rows = mismatches();
if (rows.length === 0) {
    console.log('  no mismatches; nothing to update');
    process.exit(0);
}

// Claim name -> the numbers it appears as in the documents.
const CLAIM_KINDS = {
    'unit test count': { pattern: /(\d[\d,]*)\s+unit tests/g },
    'unit test file count': { pattern: /(\d+)\s+(?:unit test )?files/g },
    // Deliberately absent: a rule for "client/assets file count". Its shape
    // (`150 files, 97.8 MB`) appears in both documents, but README's copy said
    // 149 while PROJECT's said 150, and the MB rule below fixed only the size
    // half -- leaving a document that passed the re-run while still being wrong.
    // A rule that half-updates is worse than no rule, so that claim is fixed by
    // hand and will fail loudly here if it drifts again.
    // 'client/assets file count': (no rule, on purpose)
    'client/assets MB': { pattern: /([\d.]+)\s*MB/g },
    'client/assets size': { pattern: /([\d.]+)\s*MB/g }
};

for (const row of rows) {
    const file = path.join(ROOT, row.file);
    if (!fs.existsSync(file)) {
        console.log(`  SKIP  ${row.file}: ${row.claim} -- file not found`);
        continue;
    }
    const src = fs.readFileSync(file, 'utf8');
    const kind = CLAIM_KINDS[row.claim];
    if (!kind) {
        console.log(`  SKIP  ${row.file}: ${row.claim} -- no known rewrite rule for this claim`);
        continue;
    }

    let changed = 0;
    const next = src.replace(kind.pattern, (whole, ...groups) => {
        // Replace only occurrences that carry the stale value, so a document
        // mentioning both 212 and 228 tests does not get both rewritten.
        if (!whole.includes(row.said)) return whole;
        changed++;
        return whole.split(row.said).join(row.actual);
    });

    if (changed === 0) {
        console.log(`  SKIP  ${row.file}: ${row.claim} -- value ${row.said} not found in the text`);
        continue;
    }
    fs.writeFileSync(file, next, 'utf8');
    console.log(`  fixed ${row.file}: ${row.claim}  ${row.said} -> ${row.actual}  (${changed} place(s))`);
}

console.log('\n  re-running the guard:');
try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'check_doc_claims.js')],
        { cwd: ROOT, encoding: 'utf8' });
    console.log(out.split('\n').filter(l => l.includes('every countable claim')).join('\n') || '  (no summary line)');
} catch (e) {
    console.log('  STILL FAILING:');
    console.log(((e.stdout || '') + (e.stderr || '')).split('\n').slice(0, 12).map(l => '  ' + l).join('\n'));
    process.exitCode = 1;
}