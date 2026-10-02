/*
 * tests/unit/friends.test.js
 *
 * The friend list (roadmap 6.2).
 *
 * The load-bearing claim in server/friends.js is that it is the *second* line of
 * defence for the name charset. A friend entry is a character name chosen by another
 * player, and it travels server -> friends_list -> renderFriends -> innerHTML. The
 * client escapes it and escapeHtml covers quotes, so the client is not the weak link
 * -- but the name is in the packet payload either way, and a list is exactly the sort
 * of field someone adds later and forgets. So the charset is pinned here, and pinned
 * against the login handler's own pattern so the two cannot drift apart.
 *
 * The second load-bearing thing is persistence. `normalizePlayerData` computed a
 * sanitised `friends` and then did not return it -- so every login silently reset the
 * list, and nothing anywhere said so. The wiring test at the end of this file is what
 * would have caught it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FRIENDS = require('../../server/friends');
const CFG = require('../../server/config');
const RATELIMIT = require('../../server/ratelimit');

const SERVER_JS = path.join(__dirname, '..', '..', 'server', 'server.js');
const SOCIAL_JS = path.join(__dirname, '..', '..', 'server', 'social.js');
const AUTH_JS = path.join(__dirname, '..', '..', 'server', 'auth.js');

const WORLD = ['Bob', 'Alice', 'Carol'];
const add = (list, name, self = 'Me') => FRIENDS.add(list, name, { selfName: self, existingNames: WORLD });

// --- the name charset --------------------------------------------------------

test('a legal character name is accepted', () => {
    for (const name of ['Bob', 'Alice', 'A', 'Sir Reginald', 'x-y_z', 'A1']) {
        assert.strictEqual(FRIENDS.isLegalName(name), true, `${name} should be legal`);
    }
});

test('a name that could not have been created at login is refused', () => {
    // Every one of these is an injection attempt or a shape the login handler would
    // never produce. The client escapes them; this is why it does not have to.
    for (const name of [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        "Bob');alert(1);//",
        'Bob"onmouseover="alert(1)',
        'has\ttab',
        'has\nnewline',
        '',
        '   ',
        '1Bob',              // must start with a letter
        'B'.repeat(33),       // one over the login cap
        null, undefined, 42, {}, []
    ]) {
        assert.strictEqual(FRIENDS.isLegalName(name), false, `${JSON.stringify(name)} must be refused`);
    }
});

test('the friend charset is the same pattern the login handler enforces', () => {
    // Widening the login charset without widening this one means a character can
    // exist and be unfriendable. Narrowing this one silently refuses legitimate names.
    // Nothing connects the two, so a test does.
    const loginPattern = /!\/\^\[A-Za-z\]\[A-Za-z0-9 _-\]\*\$\/\.test\(requestedName\)/;
    assert.ok(loginPattern.test(fs.readFileSync(SERVER_JS, 'utf8')),
        'server.js must still validate the character name with /^[A-Za-z][A-Za-z0-9 _-]*$/; ' +
        'update FRIENDS.NAME_PATTERN to match whatever replaced it');
    assert.strictEqual(FRIENDS.NAME_MAX_LENGTH, 32,
        'the friend name cap must match the login cap of 32');
});

// --- adding ------------------------------------------------------------------

test('adding a friend returns the new list', () => {
    const r = add([], 'Bob');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reason, 'added');
    assert.deepStrictEqual(r.list, ['Bob']);
});

test('a duplicate is refused however it is capitalised', () => {
    assert.strictEqual(add(['Bob'], 'bob').reason, 'already-friends');
    assert.strictEqual(add(['Bob'], 'BOB').reason, 'already-friends');
});

test('adding yourself is refused', () => {
    assert.strictEqual(add([], 'me').reason, 'self');
    assert.strictEqual(add([], 'ME', 'me').reason, 'self');
});

test('a name with no such character is refused', () => {
    assert.strictEqual(add([], 'Ghost').reason, 'no-such-character');
});

test('the list is capped', () => {
    const full = Array.from({ length: CFG.FRIENDS_MAX }, (_, i) => `Friend${i}`);
    const r = FRIENDS.add(full, 'Bob', { selfName: 'Me', existingNames: WORLD });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'list-full');
    assert.strictEqual(r.list.length, CFG.FRIENDS_MAX, 'a refused add must not grow the list');
});

test('surrounding whitespace is trimmed rather than stored', () => {
    const r = add([], '  Bob  ');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.list, ['Bob'], 'the stored name must be trimmed');
});

test('adding without an existence list is allowed through', () => {
    // The existence check is the caller's, because it needs the world or the
    // database. Omitting it must not make every add fail.
    const r = FRIENDS.add([], 'Bob', { selfName: 'Me' });
    assert.strictEqual(r.ok, true);
});

test('a non-array existing list is treated as empty', () => {
    for (const junk of [null, undefined, 'Bob', 42, {}]) {
        const r = add(junk, 'Bob');
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.list, ['Bob']);
    }
});

// --- removing ----------------------------------------------------------------

test('removing a friend returns the reduced list', () => {
    const r = FRIENDS.remove(['Bob', 'Alice'], 'bob');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.list, ['Alice']);
});

test('removing someone who is not a friend is refused, not silently reported as done', () => {
    // Reporting success for a removal that did not happen would leave the client
    // showing a list the server disagrees with, with no error to explain it.
    const r = FRIENDS.remove(['Bob'], 'Alice');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not-a-friend');
    assert.deepStrictEqual(r.list, ['Bob'], 'a refused removal must not change the list');
});

test('removing with a malformed name is refused', () => {
    assert.strictEqual(FRIENDS.remove(['Bob'], '<script>').reason, 'not-a-name');
    assert.strictEqual(FRIENDS.remove(['Bob'], '').reason, 'not-a-name');
});

// --- sanitising a saved list -------------------------------------------------

test('a saved list is rebuilt rather than trusted', () => {
    const junk = ['Bob', ' bob ', '<img src=x>', 'Carol', 42, null, undefined, {}, 'Bob', 'A'.repeat(40)];
    assert.deepStrictEqual(FRIENDS.sanitize(junk), ['Bob', 'Carol'],
        'illegal entries dropped, duplicates collapsed, order preserved');
});

test('trailing whitespace is trimmed, so "Bob " cannot sit beside "Bob"', () => {
    // The case that makes the trim observable. A *leading* space is rejected by the
    // charset anyway, so trimming it is invisible; a trailing one is perfectly legal
    // and without the trim it is a different key, which means two entries that render
    // as the same person and only one of which can ever be removed.
    assert.deepStrictEqual(FRIENDS.sanitize(['Bob', 'Bob ']), ['Bob']);
    assert.strictEqual(FRIENDS.add(['Bob'], 'Bob ', { selfName: 'Me', existingNames: WORLD }).reason,
        'already-friends',
        '"Bob " must be recognised as the friend already on the list');
    assert.deepStrictEqual(FRIENDS.add([], 'Bob  ', { selfName: 'Me', existingNames: WORLD }).list,
        ['Bob'], 'the stored form is trimmed, not the form that was sent');
});

test('a non-array saved value becomes an empty list', () => {
    for (const junk of [null, undefined, 'Bob', 42, {}]) {
        assert.deepStrictEqual(FRIENDS.sanitize(junk), []);
    }
});

test('sanitising applies the cap', () => {
    const many = Array.from({ length: CFG.FRIENDS_MAX + 50 }, (_, i) => `Friend${i}`);
    assert.strictEqual(FRIENDS.sanitize(many).length, CFG.FRIENDS_MAX);
});

// --- the payload -------------------------------------------------------------

test('online status is resolved against the live list, case-insensitively', () => {
    const payload = FRIENDS.describe(['Bob', 'Ghost'], ['BOB', 'Alice']);
    assert.deepStrictEqual(payload, [
        { name: 'Bob', online: true },
        { name: 'Ghost', online: false }
    ]);
});

test('the payload shape is what the client renders', () => {
    // The client reads data.friends and reads .name and .online off each entry. A
    // renamed or reshaped field renders an empty list with no error.
    for (const entry of FRIENDS.describe(['Bob'], [])) {
        assert.deepStrictEqual(Object.keys(entry).sort(), ['name', 'online'],
            'each entry must be exactly { name, online }');
        assert.strictEqual(typeof entry.name, 'string');
        assert.strictEqual(typeof entry.online, 'boolean');
    }
});

test('an online list containing nothing yields every friend offline', () => {
    assert.deepStrictEqual(FRIENDS.describe(['Bob'], []), [{ name: 'Bob', online: false }]);
    assert.deepStrictEqual(FRIENDS.describe(['Bob'], null), [{ name: 'Bob', online: false }]);
});

// --- messages ----------------------------------------------------------------

test('every refusal reason has a sentence for the player', () => {
    for (const reason of ['not-a-name', 'self', 'already-friends', 'list-full',
        'no-such-character', 'not-a-friend']) {
        assert.ok(typeof FRIENDS.MESSAGES[reason] === 'string' && FRIENDS.MESSAGES[reason].length > 0,
            `${reason} must explain itself; a silent refusal reads as a broken button`);
    }
});

// --- the wiring --------------------------------------------------------------

test('the three client actions are handled, and all three answer with the list', () => {
    // server.js declares the dispatch; social.js implements it. Both are asserted,
    // because a module that handles everything and is called by nothing behaves
    // exactly like one that does not exist.
    const dispatch = fs.readFileSync(SERVER_JS, 'utf8');
    assert.ok(/SOCIAL\.SOCIAL_ACTIONS\.has\(data\.action\)/.test(dispatch),
        'server.js must dispatch through SOCIAL.SOCIAL_ACTIONS');
    assert.ok(/await SOCIAL\.handleSocial\(/.test(dispatch),
        'the dispatch must be awaited: handleSocial is async, and not awaiting it ' +
        'lets the packet handler continue to a later branch claiming the same action');

    const src = fs.readFileSync(SOCIAL_JS, 'utf8');
    for (const action of ['friend_list_request', 'friend_add', 'friend_remove']) {
        assert.ok(new RegExp(`case '${action}'`).test(src) || src.includes(`'${action}'`),
            `${action} must be handled`);
    }
    assert.ok(/action: 'friends_list'/.test(src),
        'the client renders nothing for a packet whose action it does not recognise');
});

test('the payload is built from the player list and the live online names', () => {
    // Both halves, because either alone produces a plausible-looking empty list: a
    // payload built from an empty online set renders every friend as offline, and one
    // built from an empty friend list renders nobody. Neither errors.
    const src = fs.readFileSync(SOCIAL_JS, 'utf8');
    assert.ok(/FRIENDS\.describe\(player\.friends, ctx\.onlineCharacterNames\(\)\)/.test(src),
        'friends_list must be built from this player\'s own list and the live online names');
    assert.ok(/function onlineCharacterNames\(\)/.test(
        fs.readFileSync(SERVER_JS, 'utf8')),
        'online status must come from a helper that reads the live player map');
});

test('a mutation persists the character immediately', () => {
    // Read from server/social.js, not server.js. The friend handlers moved there in
    // roadmap 7.1 item 1, and a test that keeps reading the old file asserts against
    // code that no longer exists -- which fails, loudly, but for the wrong reason.
    //
    // The wider slice this replaced reached into the leaderboard / emote / inspect /
    // guild-bank handlers that followed, and those call persistPlayer too -- so
    // removing the save from the friend handler left the assertion satisfied by
    // someone else's code.
    const src = fs.readFileSync(SOCIAL_JS, 'utf8');
    // Scoped to the friend case, bounded by this module's own next case rather than
    // the end of the file. An unscoped /persistPlayer/ also matches the guild-bank
    // deposit further down, so deleting the friend save leaves another one behind
    // and the mutation passes. That is the failure mode this whole test exists to
    // prevent, and it reappears the moment a new persistPlayer call is added below.
    const from = src.indexOf("case 'friend_list_request':");
    const to = src.indexOf("case 'leaderboard_request':", from);
    assert.ok(from !== -1 && to !== -1, 'the friend case block must exist in social.js');
    assert.ok(/ctx\.persistPlayer\(player\)/.test(src.slice(from, to)),
        'a friend list that survives in memory but not across a restart is only ' +
        'noticed weeks later, by a player who has lost it');
});

test('friends are saved and read back on the character row', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    assert.ok(/friends: FRIENDS\.sanitize\(p\.friends\)/.test(src),
        'serializePlayer must persist the list');
    assert.ok(/const friends = FRIENDS\.sanitize\(data\.friends\)/.test(src),
        'normalizePlayerData must read the list back and sanitise it');

    // The omission this catches: `friends` was computed in normalizePlayerData and
    // never returned, so the sanitised value was discarded and every login reset the
    // list. Nothing anywhere reported it -- the field existed, the function computed
    // it, and the returned object did not mention it.
    const norm = src.slice(
        src.indexOf('function normalizePlayerData'),
        src.indexOf('function normalizePlayerData') + 2500);
    const returned = norm.slice(norm.indexOf('return {'));
    assert.ok(/^\s*friends,\s*$/m.test(returned),
        'normalizePlayerData must RETURN friends, not merely compute it. A computed ' +
        'but unreturned field silently resets on every login.');
});

test('online status is never persisted', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const ser = src.slice(src.indexOf('function serializePlayer'), src.indexOf('function serializePlayer') + 1400);
    assert.ok(!/online/.test(ser),
        'a stored online flag goes stale the moment anyone logs off; the honest ' +
        'version is computed from the live player list on every send');
});

test('friends are copied onto the live player object at login', () => {
    // THE BUG THIS EXISTS FOR.
    //
    // The list was saved correctly, loaded correctly by normalizePlayerData, and
    // then thrown away, because the live player object is built field by field and
    // `friends` was not among the fields. Everything upstream was right: the database
    // held ["FB_5mcfa"] and the test above proved it. The value simply never reached
    // the object the game reads, so every login started with an empty list.
    //
    // No earlier assertion could see this. serializePlayer and normalizePlayerData
    // are both correct in isolation; only the hand-written constructor between them and
    // the packet handler drops the field. Asserting the constructor is the only place
    // the whole path is covered.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const ctor = src.slice(
        src.indexOf('players.set(playerId, {'),
        src.indexOf('players.set(playerId, {') + 2200);
    assert.ok(/friends: FRIENDS\.sanitize\(pData\.friends\)/.test(ctor),
        'the live player object must carry friends. It is constructed field by field, ' +
        'so a field that is saved and loaded but not copied here is silently ' +
        'undefined at runtime and every login starts with an empty list.');

    // And the surrounding fields that travel the same way, as a reminder that the
    // constructor is a whitelist rather than a mirror of the saved record.
    for (const field of ['guild', 'auctionEscrow', 'pendingMailbox', 'quests']) {
        assert.ok(new RegExp(`\\b${field}:`).test(ctor),
            `${field} is copied onto the live player and friends must be treated the same way`);
    }
});

test('friend actions are rate limited as social traffic', () => {
    // A mutation rewrites and persists the character row. Left on the generic
    // catch-all, that is an unbounded write loop aimed at the database.
    for (const action of ['friend_add', 'friend_remove', 'friend_list_request']) {
        assert.strictEqual(RATELIMIT.ACTION_CLASSES[action], 'social',
            `${action} must be budgeted as social traffic`);
    }
    assert.strictEqual(RATELIMIT.classFor('friend_add'), 'social');
});
