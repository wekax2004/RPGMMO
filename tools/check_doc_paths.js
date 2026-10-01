/*
 * Checks that PROJECT.md describes the repository that exists.
 *
 * A project document that describes files which were never built is worse than
 * no document: a reader — human or agent — takes it as a map and looks for the
 * architecture it promises. The previous PROJECT.md named eight directories
 * that do not exist (server/engine, server/network, server/systems,
 * server/world, server/content, server/multiplayer, server/entities,
 * server/persistence), a spatial AoI grid that was never implemented, hybrid
 * Firebase persistence that is really SQLite, and five test files at paths with
 * nothing at them.
 *
 * This resolves the paths the document names and checks each against the
 * filesystem. It cannot prove the prose is accurate — that is a reading, not a
 * test — but it can prove every path resolves, which is the failure that actually
 * misled a reader.
 *
 * The "Not Built" section is exempt by design. Its whole purpose is to name
 * paths that do not exist, so requiring them to exist would invert the meaning
 * of the section.
 *
 * Run:  node tools/check_doc_paths.js
 * Exits non-zero if the document names a path outside "Not Built" that does not
 * resolve.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'PROJECT.md');

// A tree line: `|   ├── foo.js` or `│   └── bar/`, with an optional `# comment`.
const TREE_LINE = /[|│├└─\s]*([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-\/]*)*)\s*(?:#.*)?$/;
// A path in prose: `server/map.js`, `tests/unit/`, `client/js/engine.js`.
// The final segment must carry an extension or be a known bare directory, so a
// command flag or a hyphenated phrase is not read as a path.
const KNOWN_DIRS = new Set([
    'assets', 'bots', 'browser', 'data', 'e2e', 'lib', 'unit',
    'css', 'js', 'fixtures', 'fixtures-local'
]);
const PROSE_PATH = /\b((?:server|client|tests|tools|docs|shared)(?:\/[A-Za-z0-9_.\-]+)+)\b/g;

function looksLikePath(p) {
    const last = p.split('/').pop();
    if (/\.[a-z0-9]{1,5}$/i.test(last)) return true;          // has an extension
    if (KNOWN_DIRS.has(last)) return true;                       // a real directory
    if (/^\d+$/.test(last)) return true;                         // probes/bots/AC5
    return false;
}

// Resolve a path the way a reader would: relative to the repo root, or relative
// to the directory that is currently "open" in a tree walk. The tree uses nested
// indentation, so `server.js` under `│   ├── server/` means server/server.js.
// A tree line must actually be drawn as one. Matching the name alone is what let
// `python tools/slice_sprite.py --help` in a fenced shell block be read as a tree
// entry named `--help`: the regex began with a character class that also matches
// spaces, so it matched any line that happened to end in a word.
const IS_TREE_LINE = /^\s*[|│├└]/.test.bind(/^\s*[|│├└]/);
// Commands inside a fenced block are commands, not tree entries.
const COMMAND = /^\s*(?:[$>]|\$ )?\s*(?:npm|node|python|py|git|npx|yarn|bash|sh)\s/;

/*
 * Collapse a path to one comparable form.
 *
 * Tree entries carry their own trailing slash -- the block writes `server/` and
 * `data/` -- so joining them yields `server//data/`, and the report showed that
 * verbatim as "/server//data/". Two consequences: the message named something
 * that does not exist in any form a reader would type, and the .gitignore match
 * for `server/data/` silently failed to apply, because the comparison was
 * literal. A gitignored path was therefore reported missing in a fresh clone.
 */
function normalisePath(p) {
    return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function treeEntries(md) {
    const blocks = [...md.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)];
    const out = [];
    for (const b of blocks) {
        // Depth is the indentation, which is 4 spaces per level in a tree block.
        // Deriving it from the count of pipe characters does not work: the
        // box-drawing prefixes differ between renderers and a reader's eye reads
        // the alignment, not a glyph count.
        const stack = [];
        for (const line of b[1].split('\n')) {
            if (COMMAND.test(line)) continue;
            if (!IS_TREE_LINE(line)) continue;
            const m = TREE_LINE.exec(line);
            if (!m) continue;
            const name = m[1];
            const before = line.slice(0, line.indexOf(name));
            const depth = Math.floor(before.match(/^[\s|│├└─]*/)[0].length / 4);
            stack.length = depth;
            stack.push(name);
            out.push(normalisePath(stack.join('/')));
        }
    }
    return out;
}

function prosePaths(md) {
    // Skip fenced blocks; the tree is handled with nesting knowledge above.
    const withoutFences = md.replace(/```[\s\S]*?```/g, '');
    // Drop shell command lines too: `npm run test:browser` and
    // `python tools/x.py --help` contain path-shaped text that is a command, not
    // a claim about the repository. Matched on the command words, so a prose
    // line that merely mentions one of them is still checked.
    const COMMAND = /^\s*(?:[$>]|\$ )?\s*(?:npm|node|python|py|git|npx|yarn|bash|sh)\s/;
    const noCommands = withoutFences
        .split('\n')
        .filter(l => !COMMAND.test(l))
        .join('\n');
    const out = new Set();
    for (const m of noCommands.matchAll(PROSE_PATH)) {
        if (looksLikePath(m[1])) out.add(m[1]);
    }
    return [...out];
}

// Everything from the Not Built heading to the next heading at the same level.
function notBuiltSection(md) {
    const start = /^##\s+Not Built\s*$/m.exec(md);
    if (!start) return '';
    const rest = md.slice(start.index + start[0].length);
    const next = /^##\s+/m.exec(rest);
    return next ? rest.slice(0, next.index) : rest;
}

/*
 * Paths the repository deliberately does not track.
 *
 * A document is allowed to name a gitignored path -- CREDITS.md and PROJECT.md
 * both discuss client/assets/rpg-import/ and the held-back King Arthur sprite,
 * and they must keep discussing them. Requiring those to resolve would invert
 * their meaning, the same way the "Not Built" exemption does.
 *
 * This was not hypothetical. PROJECT.md gained a mention of the untracked
 * king_arthur_sprite.jpg, the check passed in the working tree because the file
 * happened to be on disk, and the same commit failed in a fresh clone. A guard
 * that is only true because of untracked local state is not a guard.
 */
function gitignoreMatchers() {
    const file = path.join(__dirname, '..', '.gitignore');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(pattern => {
            if (pattern.includes('*')) {
                const re = new RegExp('^' + pattern
                    .split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
                return p => re.test(p);
            }
            const base = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
            return p => p === base || p.startsWith(base + '/');
        });
}

function main() {
    const md = fs.readFileSync(DOC, 'utf8');

    const tree = [...new Set(treeEntries(md))];
    const notBuilt = notBuiltSection(md);
    const proseAll = prosePaths(md);
    const ignored = gitignoreMatchers();
    const isIgnored = p => ignored.some(m => m(p));
    // A path mentioned only inside "Not Built" is expected not to exist.
    const prose = proseAll.filter(p => !notBuilt.includes(p));
    const proseIgnored = prose.filter(isIgnored);
    const proseTracked = prose.filter(p => !isIgnored(p));
    // Exempt gitignored paths from BOTH sources. The tree is where this bites
    // first: server/data/ is drawn in the tree, and an exemption that covered
    // only prose left it failing in every clone.
    const ignoredAll = [...new Set([...tree, ...prose])].filter(isIgnored);
        // The tree's own root line (`tibia_mmo/`) and bare names that only make sense
    // as part of a tree (`assets`, `unit`, `browser`, `bots`, `lib`) are resolved
    // against the tree, not the filesystem root.
    const all = [...new Set([...tree, ...prose])]
        .filter(p => !isIgnored(p))
        .filter(p => !/^[a-z_]+$/i.test(p))     // bare directory names from the tree
        .filter(p => !p.startsWith('tibia_mmo/'))  // the tree root is not on disk
        .sort();

    console.log('PROJECT.md');
    console.log(`  ${tree.length} tree entries, ${proseAll.length} path mentions, ${all.length} checked`);
    console.log(`  ${proseAll.length - prose.length} mention(s) exempted as "Not Built"`);
    console.log(`  ${ignoredAll.length} path(s) exempted as gitignored (deliberately untracked)`);
    if (ignoredAll.length) console.log(`      ${ignoredAll.join(', ')}`);
    console.log('');

    if (!tree.length) {
        console.error('  no fenced tree block found, so the tree check would be vacuous');
        process.exit(2);
    }

    const missing = all.filter(p => !fs.existsSync(path.join(ROOT, p)));

    if (process.argv.includes('--debug')) {
        console.log('  --debug: fence count = ' + (md.match(/```/g) || []).length);
        for (const p of missing) {
            const inTree = tree.includes(p);
            const inProse = prose.includes(p);
            const line = md.split('\n').find(l => l.includes(p));
            console.log(`    ${p}`);
            console.log(`      from tree=${inTree} from prose=${inProse}`);
            console.log(`      line: ${JSON.stringify(line)}`);
        }
        console.log('');
    }

    if (missing.length === 0) {
        console.log('  every path the document names resolves');
        console.log('\n  Existence only. Whether the prose about those files is accurate stays');
        console.log('  a reading job; this cannot check that.');
        return 0;
    }

    console.log(`  ${missing.length} path(s) do not resolve:`);
    for (const m of missing) console.log(`    ${m}`);
    console.log('\n  Either build them or remove them from the document. A project file naming');
    console.log('  files which were never built sends readers looking for structure that is');
    console.log('  not there.');
    return 1;
}

process.exit(main());
