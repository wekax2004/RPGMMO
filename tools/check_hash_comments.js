/*
 * Probes whether this Node accepts hash comments in a .js file.
 *
 * Node 25 rejects them. That is worth knowing before writing a tool in this
 * repo, because a header comment is the first thing anyone writes and the
 * failure is a bare "SyntaxError: Invalid or unexpected token" pointing at the
 * first hash, which reads like a corrupted file rather than a grammar rule.
 *
 * The rule as measured here: a line whose first non-space character is a hash
 * fails, unless it begins with a real hashbang (hash, bang, path). A file whose
 * only content is a hash comment fails too, so it is not merely unused code
 * after it.
 *
 * The Python tools in this repo use hash comments throughout and are fine; this
 * only constrains .js.
 *
 * Run:  node tools/check_hash_comments.js
 * Exits non-zero if any .js file in the repo would fail to parse.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tmp = path.join(os.tmpdir(), `hashprobe-${process.pid}.js`);

function accepts(body) {
    fs.writeFileSync(tmp, body);
    try {
        execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
        return true;
    } catch {
        return false;
    }
}

// Establish the rule before trusting it to judge anything.
const probes = [
    ['hash comment, alone', '# hello', false],
    ['hash comment then code', '# hello\nvar x = 1;', false],
    ['hash comment on line 2', 'var x = 1;\n# hello', false],
    ['slash-star comment', '/* hello */\nvar x = 1;', true],
    ['double-slash comment', '// hello\nvar x = 1;', true],
    ['empty file', '', true],
    ['real hashbang', '#!/usr/bin/env node\nvar x = 1;', true],
];

console.log(`node ${process.version}\n`);
console.log('probing the rule:');
let ruleHolds = true;
for (const [label, body, expected] of probes) {
    const got = accepts(body);
    const ok = got === expected;
    if (!ok) ruleHolds = false;
    console.log(`  ${ok ? 'as expected' : 'UNEXPECTED'}  ${label.padEnd(28)} ${got ? 'accepted' : 'rejected'}`);
}

if (!ruleHolds) {
    console.log('\n  the rule did not hold, so no verdict is offered about the repo.');
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    process.exit(2);
}

// Now check the repo. Only .js files, and only the ones that are actually
// tracked, so a scratch file in tools/ does not fail the build.
const tracked = execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);

const offenders = [];
for (const rel of tracked) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    src.split('\n').forEach((line, i) => {
        if (/^\s*#(?!!)/.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 60)}`);
    });
}

try { fs.unlinkSync(tmp); } catch { /* ignore */ }

console.log(`\nscanned ${tracked.length} tracked .js files`);
if (offenders.length === 0) {
    console.log('  clean: no hash comments in any .js file');
    process.exit(0);
}
console.log(`  ${offenders.length} hash comment(s) in .js files -- these will not parse:`);
for (const o of offenders) console.log(`    ${o}`);
process.exit(1);
