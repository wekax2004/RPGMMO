// Unit tests for the white skull (PvP) rules.
//
// These drive the pure helpers through the same predicates the server uses.
// normalizePlayerData/serializePlayer live inside server.js and are not
// exported, so the persistence round trip is covered by the live suite
// instead (tests/skull_live_verify.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVER_DIR = path.join(__dirname, '..', '..', 'server');
const SERVER_JS = path.join(SERVER_DIR, 'server.js');

/**
 * server.js has no export surface for the skull helpers and requires a live
 * world to load, so pull just those declarations out of the source and
 * evaluate them in isolation. This keeps the test honest about the real
 * implementation instead of re-implementing it.
 */
function loadSkullHelpers() {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const start = src.indexOf('// --- Skull system (PvP)');
    const end = src.indexOf('function normalizePlayerData');
    assert.ok(start !== -1, 'skull helper block must exist in server.js');
    assert.ok(end > start, 'skull block must precede normalizePlayerData');

    const block = src.slice(start, end);
    const factory = new Function(`
        ${block}
        return { SKULL_WHITE, SKULL_DURATION_MS, SKULL_DROP_RATIO, NORMAL_DROP_RATIO,
                 normalizeSkull, hasActiveSkull, grantWhiteSkull, clearSkull };
    `);
    return factory();
}

const S = loadSkullHelpers();

function freshPlayer(overrides = {}) {
    return {
        charName: 'Tester', skull: null, skullExpiresAt: 0, persistenceDirty: false,
        gold: 100, ...overrides
    };
}

test('a new player carries no skull', () => {
    const p = freshPlayer();
    assert.strictEqual(S.hasActiveSkull(p), false);
    assert.strictEqual(S.normalizeSkull(null), null);
});

test('only the white skull is a recognised value', () => {
    assert.strictEqual(S.normalizeSkull('white'), 'white');
    // Anything else in a hand-edited save must not become a skull.
    for (const bogus of ['red', 'yellow', 'WHITE', 1, true, {}, [], '']) {
        assert.strictEqual(S.normalizeSkull(bogus), null, `${JSON.stringify(bogus)} must not be a skull`);
    }
});

test('granting a skull sets the flag and a future timer', () => {
    const p = freshPlayer();
    const now = 1_000_000;
    assert.strictEqual(S.grantWhiteSkull(p, now), true);
    assert.strictEqual(p.skull, S.SKULL_WHITE);
    assert.strictEqual(p.skullExpiresAt, now + S.SKULL_DURATION_MS);
    assert.strictEqual(S.hasActiveSkull(p, now), true);
    assert.strictEqual(p.persistenceDirty, true, 'a new skull must schedule a save');
});

test('granting twice does not extend the timer', () => {
    const p = freshPlayer();
    const now = 1_000_000;
    S.grantWhiteSkull(p, now);
    const firstExpiry = p.skullExpiresAt;
    assert.strictEqual(S.grantWhiteSkull(p, now + 1000), false);
    assert.strictEqual(p.skullExpiresAt, firstExpiry, 'timer must not be refreshed');
});

test('a skull expires on its own once the timer passes', () => {
    const p = freshPlayer();
    const now = 1_000_000;
    S.grantWhiteSkull(p, now);
    const justBefore = now + S.SKULL_DURATION_MS - 1;
    const justAfter = now + S.SKULL_DURATION_MS;
    assert.strictEqual(S.hasActiveSkull(p, justBefore), true, 'still active one ms before expiry');
    assert.strictEqual(S.hasActiveSkull(p, justAfter), false, 'inactive the moment it lapses');
});

test('a skull with no timer is not active', () => {
    // This is the shape a hand-edited or partially-written save produces.
    const p = freshPlayer({ skull: 'white', skullExpiresAt: 0 });
    assert.strictEqual(S.hasActiveSkull(p), false, 'a flag with no expiry must not count');
});

test('clearSkull removes the flag and reports whether there was one', () => {
    const p = freshPlayer();
    assert.strictEqual(S.clearSkull(p), false, 'nothing to clear');
    S.grantWhiteSkull(p);
    assert.strictEqual(S.clearSkull(p), true);
    assert.strictEqual(p.skull, null);
    assert.strictEqual(p.skullExpiresAt, 0);
    assert.strictEqual(S.hasActiveSkull(p), false);
});

test('clearSkull only marks dirty when it actually removed something', () => {
    const p = freshPlayer();
    S.clearSkull(p);
    assert.strictEqual(p.persistenceDirty, false, 'no-op clear should not force a save');
});

test('the skull drop penalty is harsher than the normal rate', () => {
    // Regression guard: checkPlayerDeath already dropped a flat 0.5, so a
    // skull must never make the penalty *smaller*.
    assert.ok(S.SKULL_DROP_RATIO > S.NORMAL_DROP_RATIO,
        `skulled (${S.SKULL_DROP_RATIO}) must drop more than normal (${S.NORMAL_DROP_RATIO})`);
    assert.strictEqual(S.NORMAL_DROP_RATIO, 0.5, 'the pre-existing normal rate must not change');
});

test('the skull duration is sane', () => {
    assert.ok(S.SKULL_DURATION_MS > 0);
    assert.ok(S.SKULL_DURATION_MS <= 60 * 60 * 1000, 'must not last longer than an hour');
});

test('serializePlayer and normalizePlayerData both mention skull and guild', () => {
    // The bug this guards: serializePlayer wrote `guild` for its whole life
    // while normalizePlayerData never read it, so membership was lost on
    // every login. Both names must appear on both sides of the round trip.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const serStart = src.indexOf('function serializePlayer');
    const normStart = src.indexOf('function normalizePlayerData');
    assert.ok(serStart !== -1 && normStart > serStart, 'both functions must exist in order');

    const serialize = src.slice(serStart, src.indexOf('function persistPlayer'));
    const normEnd = src.indexOf('function isInBounds');
    const normalize = src.slice(normStart, normEnd);

    for (const field of ['skull', 'skullExpiresAt', 'guild']) {
        assert.ok(serialize.includes(field), `serializePlayer must persist ${field}`);
        assert.ok(normalize.includes(field), `normalizePlayerData must restore ${field}`);
    }
});

test('a skulled player is marked for broadcast, a clean one is not', () => {
    const p = freshPlayer();
    S.grantWhiteSkull(p, Date.now());
    assert.strictEqual(S.hasActiveSkull(p) ? true : false, true);
    const clean = freshPlayer();
    assert.strictEqual(S.hasActiveSkull(clean) ? true : false, false);
});
