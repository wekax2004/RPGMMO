/*
 * Re-injects the ways the friend list could be wrong, one at a time, and confirms
 * tests/unit/friends.test.js goes red for each.
 *
 * Run:  node tools/mutate_friends.js
 * Exits non-zero if any mutation survives.
 *
 * The first four are the ones that would cost somebody something real. Widening the
 * name charset lets a player create a character that cannot be friended and puts an
 * unescaped name into a payload the client renders. Dropping the persistence means a
 * friend list silently resets on restart. And the returned-but-not-computed variant:
 * normalizePlayerData computed a sanitised list and omitted it from its return object,
 * which discarded the value and reset the list on every login while every part of the
 * code looked correct.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FRIENDS = 'server/friends.js';
const SERVER = 'server/server.js';
const RATELIMIT = 'server/ratelimit.js';
const TEST = 'tests/unit/friends.test.js';

const MUTATIONS = [
    // --- the charset is the security-relevant part -------------------------
    {
        name: 'the name charset is widened to allow angle brackets',
        file: FRIENDS,
        from: 'const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]*$/;',
        to: 'const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _-<]*$/;'
    },
    {
        // Doubles as the non-string case. Letting a name start with a digit means
        // String(42) passes the charset, so a number stored in a save file becomes a
        // friend entry -- which is what the typeof guard was there to prevent, and
        // what makes a weakened typeof check detectable at all.
        name: 'a name may start with a digit, so a number is accepted as a friend',
        file: FRIENDS,
        from: 'const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]*$/;',
        to: 'const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;'
    },
    {
        name: 'the name length cap is removed, so any length is stored',
        file: FRIENDS,
        from: '&& name.length <= NAME_MAX_LENGTH',
        to: ''
    },
    {
        // The real bypass: sanitising on the way in but not on the way out. A save
        // file is the one place a value can be hand-edited, and this is the field
        // that travels to another player's client.
        name: 'sanitise stops dropping illegal entries from a saved list',
        file: FRIENDS,
        from: 'if (!isLegalName(name)) continue;',
        to: 'if (!name) continue;'
    },
    {
        name: 'the cap stops applying, so a saved list can grow without bound',
        file: FRIENDS,
        from: 'if (out.length >= CFG.FRIENDS_MAX) break;',
        to: '// cap removed'
    },
    {
        name: 'the list cap stops being enforced on add',
        file: FRIENDS,
        from: "if (list.length >= CFG.FRIENDS_MAX) {",
        to: "if (false) {"
    },

    // --- the rules ----------------------------------------------------------
    {
        name: 'a duplicate is accepted, so the list grows with casing variants',
        file: FRIENDS,
        from: "if (list.some(f => f.toLowerCase() === key)) {",
        to: 'if (false) {'
    },
    {
        name: 'a player can add themselves',
        file: FRIENDS,
        from: "if (String(opts.selfName || '').toLowerCase() === key) {",
        to: 'if (false) {'
    },
    {
        name: 'a nonexistent character can be added',
        file: FRIENDS,
        from: "    if (typeof opts.exists === 'boolean') {\n" +
            "        if (!opts.exists) return { ok: false, reason: 'no-such-character', list };\n" +
            '    } else if (Array.isArray(opts.existingNames) &&\n' +
            '        !opts.existingNames.some(n => String(n).toLowerCase() === key)) {\n' +
            "        return { ok: false, reason: 'no-such-character', list };\n" +
            '    }',
        // Both paths, not one. Weakening only the `exists` branch leaves the
        // existingNames fallback doing the same job, so the list still refuses a
        // nonexistent name and the mutation passes.
        to: "    // existence check removed"
    },
    {
        // Existence resolved from the database is what lets an offline character be
        // added at all. Replacing it with the online map -- the version that shipped --
        // refuses every friend you add after they log off.
        name: 'existence is resolved from the online map, so offline friends cannot be added',
        file: FRIENDS,
        from: "    if (typeof opts.exists === 'boolean') {",
        to: "    if (Array.isArray(opts.existingNames)) {"
    },
    {
        // Reports a removal that did not happen, so the client's list and the
        // server's disagree with nothing to explain it.
        name: 'removing a non-friend reports success',
        file: FRIENDS,
        from: "if (next.length === list.length) {",
        to: 'if (false) {'
    },
    {
        name: 'removing a friend does not change the list',
        file: FRIENDS,
        from: 'const next = list.filter(f => f.toLowerCase() !== key);',
        to: 'const next = list;'
    },
    {
        name: 'whitespace is stored rather than trimmed, so " Bob" and "Bob" differ',
        file: FRIENDS,
        from: "const name = typeof raw === 'string' ? raw.trim() : '';",
        to: "const name = typeof raw === 'string' ? raw : '';"
    },

    // --- the payload --------------------------------------------------------
    {
        // Online status is what tells the client to show a dot. Renaming the field
        // renders every friend as offline with no error anywhere.
        name: 'the payload key is renamed, so every friend renders offline',
        file: FRIENDS,
        from: 'return sanitize(list).map(name => ({ name, online: online.has(name.toLowerCase()) }));',
        to: 'return sanitize(list).map(name => ({ name, isOnline: online.has(name.toLowerCase()) }));'
    },
    {
        name: 'online status is hardcoded to false',
        file: FRIENDS,
        from: 'online: online.has(name.toLowerCase())',
        to: 'online: false'
    },
    {
        name: 'online status stops matching case-insensitively',
        file: FRIENDS,
        from: "const online = new Set((Array.isArray(onlineNames) ? onlineNames : []).map(n => String(n).toLowerCase()));",
        to: 'const online = new Set(Array.isArray(onlineNames) ? onlineNames : []);'
    },

    // --- the wiring ---------------------------------------------------------
    {
        // The omission that actually happened: the sanitised value was computed and
        // then left out of the returned object.
        name: 'normalizePlayerData computes friends but does not return it',
        file: SERVER,
        from: '        quests,\n        friends,\n        equipment,',
        to: '        quests,\n        equipment,'
    },
    {
        name: 'friends are not persisted on the character row',
        file: SERVER,
        from: 'friends: FRIENDS.sanitize(p.friends),',
        to: 'friends: [],'
    },
    {
        // The bug this feature actually shipped with. The list was saved correctly,
        // loaded correctly by normalizePlayerData, and dropped by the hand-written
        // live-object constructor -- so every login started with an empty list and
        // every assertion about saving and loading stayed green.
        name: 'friends are saved and loaded but never copied onto the live player',
        file: SERVER,
        from: 'friends: FRIENDS.sanitize(pData.friends),',
        to: 'friends: [],'
    },
    {
        name: 'a friend mutation is not persisted, so it is lost on restart',
        file: SERVER,
        from: "                        persistPlayer(player);\n                        sendTo(player, { action: 'log', message: isAdd",
        to: "                        sendTo(player, { action: 'log', message: isAdd"
    },
    {
        name: 'friend_add stops being handled',
        file: SERVER,
        from: "data.action === 'friend_list_request' || data.action === 'friend_add' || data.action === 'friend_remove'",
        to: "data.action === 'friend_list_request'"
    },
    {
        // A protocol break, not a stylistic one: the client keys its rendering off
        // this exact action name and renders nothing for a packet it does not know.
        // Wrapping the send in `if (false)` was the first attempt and survived,
        // because the existing assertion only checked the literal appears somewhere.
        name: 'the response action is renamed, so the client renders nothing',
        file: SERVER,
        from: "                    action: 'friends_list',",
        to: "                    action: 'friends_list_v2',"
    },
    {
        name: 'the payload is built from an empty list, so the client sees no friends',
        file: SERVER,
        from: 'friends: FRIENDS.describe(player.friends, onlineCharacterNames())',
        to: 'friends: []'
    },
    {
        name: 'online status is computed from an empty list, so everyone is offline',
        file: SERVER,
        from: 'friends: FRIENDS.describe(player.friends, onlineCharacterNames())',
        to: 'friends: FRIENDS.describe(player.friends, [])'
    },
    {
        // A mutation writes the character row. Unbudgeted, that is a loop aimed at
        // the database from one client.
        name: 'friend actions stop being rate limited',
        file: RATELIMIT,
        from: "    friend_add: 'social',",
        to: "    friend_add: 'other',"
    }
];

function runSuite() {
    try {
        const out = execFileSync(process.execPath, ['--test', TEST], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    }
}

function failingTest(out) {
    const m = out.match(/✖ ([^\n]+)/);
    return m ? m[1].trim().slice(0, 72) : '(no failure line found)';
}

const originals = new Map();
for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs, 'utf8'));
}

console.log('=== friends mutation testing ===\n');
const base = runSuite();
console.log(`  baseline: ${base.ok ? 'passes' : 'ALREADY FAILING'}`);
if (!base.ok) {
    console.log('    ' + failingTest(base.out));
    console.log('\n  ABORT: green before mutating or nothing below means anything.');
    process.exit(1);
}

let survived = 0;
for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    const src = originals.get(abs);
    if (!src.includes(m.from)) {
        console.log(`  SKIP      ${m.name}`);
        console.log('            anchor not found -- the source drifted, update this harness\n');
        survived++;
        continue;
    }
    fs.writeFileSync(abs, src.replace(m.from, m.to), 'utf8');
    const result = runSuite();
    fs.writeFileSync(abs, src, 'utf8');

    if (result.ok) {
        survived++;
        console.log(`  SURVIVED  ${m.name}`);
        console.log('            the suite passed against injectable code\n');
    } else {
        console.log(`  CAUGHT    ${m.name}`);
        console.log(`            ${failingTest(result.out)}\n`);
    }
}

console.log(`  ${MUTATIONS.length - survived}/${MUTATIONS.length} caught, ${survived} survived`);
if (survived) {
    console.log('\n  A surviving mutation is an assertion that does not assert.');
    process.exitCode = 1;
} else {
    console.log('  Every mutation was caught.');
}
