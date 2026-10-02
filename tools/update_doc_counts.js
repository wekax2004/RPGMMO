/*
 * Applies the countable claims that tools/check_doc_claims.js flagged, and fails
 * rather than guessing if an expected anchor is missing or found twice.
 *
 * The numbers come from the guard, not from this file: it runs the check, parses
 * the MISMATCH lines, and rewrites only the value on the named line. Hand-typing
 * 228 into five places is how they drift out of step with each other next time.
 *
 * Run:  node tools/update_doc_counts.js
 *
 * A note on the shape of this file, which exists because of a bug it used to have.
 * The rewrite rules must be as specific as the guard's own patterns, and the
 * staleness test must compare values rather than looking for digits. Getting
 * either wrong does not fail loudly -- it corrupts a number the guard is about to
 * check, so the tool reports success and the very next run fails on the value the
 * tool itself changed. That happened: a fix for "unit test file count, 15 -> 16"
 * rewrote the assets file count from 150 to 160, because the old staleness test
 * was `whole.includes("15")` and the string "150 files" contains "15".
 *
 * tools/selftest_update_doc_counts.js drives rewrite() directly so that cannot
 * happen again unobserved.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Claim name -> the pattern its number appears as in the documents.
const CLAIM_KINDS = {
    'unit test count': { pattern: /(\d[\d,]*)\s+unit tests/g },
    // Deliberately narrow. This used to be /(\d+)\s+(?:unit test )?files/g, which
    // also matches `assets/  # 150 files`. The guard recognises this claim only in
    // the shape "across N files" (check_doc_claims.js:141), so that is the only
    // shape rewritten here.
    'unit test file count': { pattern: /across (\d+) files/g },
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

/**
 * Applies one rewrite rule to a document.
 *
 * Exported so tools/selftest_update_doc_counts.js can drive it directly.
 *
 * @param {string} src        document text
 * @param {{pattern: RegExp}} kind
 * @param {string|number} said    the value the guard reported as stale
 * @param {string|number} actual  the value the guard measured
 * @returns {{text: string, changed: number}}
 */
function rewrite(src, kind, said, actual) {
    let changed = 0;
    const text = src.replace(kind.pattern, (whole, captured) => {
        // Compare the captured NUMBER. Not the whole match, and not a substring of
        // it. A staleness test has to compare values, not look for digits -- see the
        // note at the top of this file.
        if (parseInt(captured, 10) !== parseInt(said, 10)) return whole;
        changed++;
        return whole.replace(captured, actual);
    });
    return { text, changed };
}

function runFixes(rows) {
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

        const { text, changed } = rewrite(src, kind, row.said, row.actual);
        if (changed === 0) {
            console.log(`  SKIP  ${row.file}: ${row.claim} -- value ${row.said} not found in the text`);
            continue;
        }
        fs.writeFileSync(file, text, 'utf8');
        console.log(`  fixed ${row.file}: ${row.claim}  ${row.said} -> ${row.actual}  (${changed} place(s))`);
    }
}

function main() {
    const rows = mismatches();
    if (rows.length === 0) {
        console.log('  no mismatches; nothing to update');
        return;
    }
    runFixes(rows);

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
}

module.exports = { rewrite, CLAIM_KINDS, mismatches };

if (require.main === module) main();
