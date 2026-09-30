/*
 * Checks that assets with unresolved licensing are not tracked by git.
 *
 * docs/ASSET_IMPORT.md states that client/assets/rpg-import/ "must not be
 * published or distributed yet" because the source repository, wekax2004/RPG,
 * has no root LICENSE file. That file was ignored: the directory was not in
 * .gitignore, so `git add` picked it up, and all 67 files -- 56.3 MB -- have been
 * on origin/main since the initial commit f624f26 on 2026-09-25.
 *
 * A .gitignore entry has now been added, but .gitignore does not apply to files
 * already in the index. So the entry alone changes nothing about what is
 * published, and a guard that only read .gitignore would report this as fixed.
 * This asks git instead: what does the index actually contain?
 *
 * Deliberately reports rather than fixes. Untracking is `git rm --cached` plus a
 * commit; unpublishing needs a filter-repo rewrite and a force-push that
 * invalidates every existing clone. Both are the owner's decision, so neither is
 * done here.
 *
 * Run:  node tools/check_asset_licensing.js
 * Exits non-zero while unlicensed assets remain tracked.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Directories whose licensing is unresolved, with the reason and where the
// reasoning lives. Adding to this list is how a new import gets a guard.
const UNRESOLVED = [
    {
        path: 'client/assets/rpg-import',
        reason: 'source repository wekax2004/RPG has no LICENSE file (GitHub reports "license": null)',
        documentedIn: 'docs/ASSET_IMPORT.md'
    }
];

function git(...args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function isIgnored(rel) {
    try {
        git('check-ignore', '-q', rel);
        return true;
    } catch {
        return false;
    }
}

function main() {
    console.log('asset licensing\n');

    let violations = 0;

    for (const entry of UNRESOLVED) {
        const tracked = git('ls-files', entry.path).split('\n').filter(Boolean);
        const ignored = isIgnored(entry.path + '/probe.txt');

        console.log(`  ${entry.path}`);
        console.log(`    reason: ${entry.reason}`);
        console.log(`    documented in: ${entry.documentedIn}`);

        if (!fs.existsSync(path.join(ROOT, 'docs', path.basename(entry.documentedIn))) &&
            !fs.existsSync(path.join(ROOT, entry.documentedIn))) {
            console.log('    WARNING: the document recording this does not exist');
        }

        if (tracked.length === 0) {
            console.log(`    not tracked: nothing published from here`);
            console.log('');
            continue;
        }

        // How long it has been published, and to whom, is the part that makes
        // this urgent rather than untidy.
        let first = 'unknown';
        try {
            first = git('log', '--format=%h %ad', '--date=short', '--diff-filter=A',
                '--', entry.path).trim().split('\n').pop();
        } catch { /* shallow clone or no history */ }

        console.log(`    IGNORED BY .gitignore : ${ignored ? 'yes' : 'NO -- a new file here would be staged'}`);
        console.log(`    TRACKED BY GIT        : ${tracked.length} file(s) -- PUBLISHED`);
        console.log(`    first committed       : ${first}`);

        if (!ignored) {
            console.log('    .gitignore has no entry for this path, so `git add` will stage it again.');
            violations++;
        }
        violations++;
        console.log('');
    }

    if (violations > 0) {
        console.log('  Unresolved-licence assets are still tracked.');
        console.log('');
        console.log('  Removing them from the repository tip:');
        console.log('    git rm --cached -r client/assets/rpg-import');
        console.log('    git commit -m "Untrack unlicensed asset import"');
        console.log('');
        console.log('  Removing them from PUBLISHED history (rewrites every commit from');
        console.log('  f624f26, invalidates existing clones, and needs a force-push):');
        console.log('    git filter-repo --path client/assets/rpg-import --invert-paths');
        console.log('');
        console.log('  Neither is done automatically. Both are the owner\'s decision: the first');
        console.log('  stops the files being served, the second actually unpublishes them.');
        return 1;
    }

    console.log('  no unlicensed assets are tracked');
    return 0;
}

process.exit(main());
