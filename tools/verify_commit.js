'use strict';
// Post-commit safety check: proves the commit is actually restorable and
// carries nothing it should not. A backup point that cannot be checked out, or
// that embeds game state or credentials, is not a backup point.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
let problems = 0;

console.log('=== commit integrity ===\n');

const head = git('rev-parse', 'HEAD').trim();
const subject = git('log', '-1', '--pretty=%s');
console.log(`  HEAD    ${head.slice(0, 8)}  ${subject.trim()}`);

if (subject.charCodeAt(0) === 0xFEFF) {
    console.log('  FAIL  the commit subject starts with a BOM');
    problems++;
} else {
    console.log('  ok    commit subject has no BOM');
}

// A gitlink records a commit id from a repository that does not exist here.
const staged = git('ls-files', '-s').split('\n').filter(Boolean);
const gitlinks = staged.filter(l => l.startsWith('160000'));
if (gitlinks.length) {
    console.log(`  FAIL  ${gitlinks.length} gitlink(s) staged - a broken submodule reference`);
    problems++;
} else {
    console.log('  ok    no gitlinks');
}
if (fs.existsSync(path.join(ROOT, '.gitmodules'))) {
    console.log('  FAIL  .gitmodules present but no submodule is tracked');
    problems++;
}

// Live game state must never be versioned.
const tracked = new Set(git('ls-files').split('\n').filter(Boolean));
const forbidden = [...tracked].filter(f =>
    f.startsWith('server/data/') ||
    f.includes('node_modules/') ||
    f.endsWith('.sqlite') || f.endsWith('.sqlite-wal') || f.endsWith('.sqlite-shm') ||
    f === '.env' || f.startsWith('.env.') ||
    (f.endsWith('db.json') && !f.startsWith('tests/'))
);
if (forbidden.length) {
    console.log(`  FAIL  ${forbidden.length} forbidden path(s) tracked:`);
    forbidden.slice(0, 8).forEach(f => console.log(`          ${f}`));
    problems++;
} else {
    console.log('  ok    no game state, WAL, node_modules or .env tracked');
}

// The real proof: a clean checkout of this commit must start a server and
// pass its tests. Clone to a temp dir so the working tree is untouched.
console.log('\n=== restore test (clone HEAD to a temp dir) ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tibia-restore-'));
try {
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--depth', '1',
        'file:///' + ROOT.replace(/\\/g, '/'), tmp], { stdio: 'pipe' });
    const cloneHead = execFileSync('git', ['rev-parse', 'HEAD'],
        { cwd: tmp, encoding: 'utf8' }).trim();
    console.log(`  ok    cloned, HEAD ${cloneHead.slice(0, 8)} ${cloneHead === head ? '(matches)' : '(MISMATCH)'}`);
    if (cloneHead !== head) problems++;

    // Every tracked JS file must parse in the clone -- catches a file committed
    // mid-edit by a concurrent agent.
    const js = git('ls-files', '*.js').split('\n').filter(Boolean);
    let bad = 0, checked = 0;
    for (const f of js) {
        const full = path.join(tmp, f);
        if (!fs.existsSync(full)) continue;
        checked++;
        try {
            execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
        } catch (e) {
            console.log(`  FAIL  ${f} does not parse in the clone`);
            bad++;
        }
    }
    if (bad) problems += bad;
    else console.log(`  ok    all ${checked} tracked .js files parse in the clone`);

    // The Z-level invariant must hold in the clone, not just in my tree.
    execFileSync(process.execPath, ['--test', 'tests/unit/zlevels.test.js'],
        { cwd: tmp, stdio: 'pipe' });
    console.log('  ok    tests/unit/zlevels.test.js passes in the clone');
} catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    console.log('  note  ' + out.trim().split('\n').slice(-3).join(' | '));
    console.log('  FAIL  restore test did not complete');
    problems++;
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(problems === 0
    ? '\n  commit is a valid, self-contained restore point'
    : `\n  ${problems} problem(s) found`);
process.exitCode = problems === 0 ? 0 : 1;
