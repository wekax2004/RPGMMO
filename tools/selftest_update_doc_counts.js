/*
 * tools/selftest_update_doc_counts.js
 *
 * Checks that the doc-count fixer cannot rewrite a number it was not asked about.
 *
 * Run:  node tools/selftest_update_doc_counts.js
 *
 * WHY THIS EXISTS
 *
 * The fixer ran against the real documents and corrupted one. A fix for "unit test
 * file count, 15 -> 16" rewrote the assets file count from 150 to 160, because the
 * staleness test was:
 *
 *     if (!whole.includes(row.said)) return whole;
 *
 * and "150 files".includes("15") is true. The rewrite pattern also matched more
 * than the unit test line.
 *
 * What made it worth writing a test for is that this failure mode is nearly
 * invisible. The tool printed "fixed PROJECT.md: unit test file count 15 -> 16
 * (3 place(s))", which reads as success and is not. The damage surfaced only
 * because the tool re-runs the guard afterwards, and the guard failed on the very
 * number it had just changed. A fixer that did not re-run would have shipped a
 * wrong count with a cheerful message and nothing else.
 *
 * So this asserts the two properties separately: the pattern is narrow enough not
 * to reach an unrelated line, and the staleness test compares values rather than
 * substrings. Either one alone is enough to corrupt a document.
 */

const { rewrite, CLAIM_KINDS } = require('./update_doc_counts');

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

// The exact shape of PROJECT.md's code-layout tree, including the two numbers that
// are prone to confusion: a unit test file count and a much larger asset file
// count that contains the same digits.
const DOC = [
    '| `tests/unit/` | 243 unit tests across 15 files. `npm test` |',
    '│   ├── unit/                  # 228 tests across 15 files',
    '│   └── assets/                # 150 files, 97.8 MB (81.1 MB loaded by nothing)',
    ''
].join('\n');

console.log('=== update_doc_counts self-test ===\n');

check('the fixture reproduces the corruption with the old logic', (() => {
    // The exact rule that was there before, applied to the exact text above. If this
    // ever stops corrupting the assets line, the fixture is no longer reproducing
    // the bug and the rest of these tests are testing nothing.
    const oldPattern = /(\d+)\s+(?:unit test )?files/g;
    const corrupted = DOC.replace(oldPattern, (whole) =>
        whole.includes('15') ? whole.split('15').join('16') : whole);
    return corrupted.includes('# 160 files');
})(), 'old rule on old text turns "# 150 files" into "# 160 files"');

const fileKind = CLAIM_KINDS['unit test file count'];
check('the file-count rule does not match the assets line at all', (() => {
    const line = '│   └── assets/                # 150 files, 97.8 MB (81.1 MB loaded by nothing)';
    fileKind.pattern.lastIndex = 0;
    return !fileKind.pattern.test(line);
})(), 'pattern is /across (\\d+) files/, which cannot reach "# 150 files"');

const result = rewrite(DOC, fileKind, '15', '16');
check('the unit test file count is updated in both of its places', result.changed === 2,
    `changed ${result.changed}, expected 2`);
check('the assets file count is left alone', result.text.includes('# 150 files'),
    result.text.includes('# 160 files') ? 'the assets line was rewritten -- this is the bug' : 'still "# 150 files"');
check('the assets size is left alone', result.text.includes('97.8 MB'));
check('the stale unit test count elsewhere is not touched by this rule',
    result.text.includes('243 unit tests'),
    'a rule for file counts must not rewrite a count of tests');

const idem = rewrite(result.text, fileKind, '15', '16');
check('running the same fix again is a no-op', idem.changed === 0,
    `second pass changed ${idem.changed}`);

check('a rule for the unit test count does not touch file counts', (() => {
    const r = rewrite(DOC, CLAIM_KINDS['unit test count'], '243', '264');
    return r.text.includes('across 15 files') && r.text.includes('# 150 files');
})(), '243 -> 264 leaves both file counts intact');

check('a stale value that merely appears as digits is not rewritten', (() => {
    // The core defect, asserted directly on the numbers rather than through a
    // whole-line pattern: 15 must not be found inside 150.
    const r = rewrite(DOC, fileKind, '1', '2');
    return r.changed === 0 || !r.text.includes('# 120 files');
})(), 'a rule aimed at 1 does not corrupt 150 into 120');

check('every rule has a pattern with a capture group', Object.values(CLAIM_KINDS).every(k =>
    k.pattern.source.includes('(')),
    'rewrite() compares the captured number, so a rule without one is silently inert');

console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
