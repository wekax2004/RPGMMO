/*
 * tests/unit/combo.test.js
 *
 * Roadmap 5.1: the combo system.
 *
 * `registerHit` takes an injectable `now`, so the whole window/expiry surface is one
 * assertion away and none of it needs a socket. What the unit tests cannot check is
 * whether the count is announced on the wire -- that is `tests/bots/combo_probe.js`.
 *
 * The tests are weighted towards the ways a combo can be wrong while still looking
 * fine. A combo that counts target-switching, or that survives an expiry, is not a
 * weaker feature -- it is a different and much cheaper one.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const COMBO = require('../../server/combo');

const fresh = () => ({ combo: COMBO.initialCombo() });

test('a single hit is not a combo', () => {
    const p = fresh();
    const r = COMBO.registerHit(p, 'mobA', 1000);
    assert.strictEqual(r.hits, 1);
    assert.strictEqual(r.advanced, false, 'one hit must not be announced');
    assert.strictEqual(COMBO.describe(p), null);
});

test('consecutive hits on one target build a combo', () => {
    const p = fresh();
    COMBO.registerHit(p, 'mobA', 1000);
    const second = COMBO.registerHit(p, 'mobA', 2000);
    assert.strictEqual(second.hits, 2);
    assert.strictEqual(second.advanced, true);
    const third = COMBO.registerHit(p, 'mobA', 2500);
    assert.strictEqual(third.hits, 3);
    assert.strictEqual(COMBO.describe(p).hits, 3);
});

test('switching target breaks the chain', () => {
    // The one that matters most. Counting target-switching would reward exactly the
    // behaviour a combo exists to discourage.
    const p = fresh();
    COMBO.registerHit(p, 'mobA', 1000);
    COMBO.registerHit(p, 'mobA', 1500);
    const switched = COMBO.registerHit(p, 'mobB', 2000);
    assert.strictEqual(switched.hits, 1, 'a new target restarts at one');
    assert.strictEqual(switched.broke, true, 'and it must be reported as a break, not a continuation');
});

test('a break is distinguishable from a fresh start', () => {
    // Both are `hits: 1`. Collapsing them means a client cannot tell "you started a
    // chain" from "you lost one", and the meter would flicker.
    const p = fresh();
    COMBO.registerHit(p, 'mobA', 1000);
    COMBO.registerHit(p, 'mobA', 1500);
    const broke = COMBO.registerHit(p, 'mobB', 2000);
    assert.strictEqual(broke.broke, true);

    const q = fresh();
    const first = COMBO.registerHit(q, 'mobA', 1000);
    assert.strictEqual(first.broke, false, 'the very first hit is not a break');
    assert.strictEqual(first.hits, broke.hits, 'both are one hit -- which is why `broke` exists');
});

test('the window expires and restarts rather than resuming', () => {
    const p = fresh();
    const t0 = 1000;
    COMBO.registerHit(p, 'mobA', t0);
    COMBO.registerHit(p, 'mobA', t0 + 500);
    COMBO.registerHit(p, 'mobA', t0 + 1000);
    // Measured from the LAST hit, not from the first. The first draft anchored this
    // on the start of the chain and so computed a gap of only 2500ms -- comfortably
    // inside a 4000ms window -- and concluded the expiry was broken. The window is
    // measured from the previous hit, so the test has to be too.
    const after = COMBO.registerHit(p, 'mobA', t0 + 1000 + COMBO.COMBO_WINDOW_MS + 500);
    assert.strictEqual(after.hits, 1, 'an expired chain restarts at one');
    assert.strictEqual(after.broke, true);
});

test('a hit exactly on the window boundary still counts', () => {
    // Off-by-one in the other direction is just as wrong: a chain that dies at
    // exactly COMBO_WINDOW_MS is a chain that feels shorter than it is.
    const p = fresh();
    COMBO.registerHit(p, 'mobA', 1000);
    const onBoundary = COMBO.registerHit(p, 'mobA', 1000 + COMBO.COMBO_WINDOW_MS);
    assert.strictEqual(onBoundary.hits, 2, 'the boundary is still inside the window');
});

test('an untargeted hit resets the combo', () => {
    // An AoE tick damages whatever is in range. Counting it would let a player build
    // a chain by standing in a crowd and casting, which is not a combo.
    const p = fresh();
    COMBO.registerHit(p, 'mobA', 1000);
    COMBO.registerHit(p, 'mobA', 1500);
    const aoe = COMBO.registerHit(p, '', 2000);
    assert.strictEqual(aoe.hits, 0);
    assert.strictEqual(COMBO.describe(p), null);
});

test('reset clears everything, so describe returns null', () => {
    const p = fresh();
    COMBO.registerHit(p, 'mobA', 1000);
    COMBO.registerHit(p, 'mobA', 1500);
    COMBO.resetCombo(p);
    assert.strictEqual(COMBO.describe(p), null);
});

test('describe returns null below the announce threshold', () => {
    const p = fresh();
    COMBO.registerHit(p, 'mobA', 1000);
    assert.strictEqual(COMBO.describe(p), null, 'one hit has nothing to show');
    COMBO.registerHit(p, 'mobA', 1500);
    assert.ok(COMBO.describe(p), 'two hits is the first thing worth showing');
});

test('a player with no combo state does not throw', () => {
    // The login constructor builds the field, but a player object that somehow lacks
    // it must not take the server down on the first hit.
    const bare = {};
    assert.doesNotThrow(() => COMBO.registerHit(bare, 'mobA', 1000));
    assert.strictEqual(COMBO.describe(bare), null);
    assert.doesNotThrow(() => COMBO.resetCombo(bare));
});

test('the login constructor builds the combo field', () => {
    // Same reason as stamina: a field missing here is `undefined` at runtime, and
    // `undefined.hits` throws on the first hit rather than failing at login.
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', '..', 'server', 'server.js'), 'utf8');
    assert.ok(/combo:\s*COMBO\.initialCombo\(\)/.test(src),
        'the login constructor must build combo state');
});

test('every damaging path registers a hit', () => {
    // A combo that counts only some of a player's actions is worse than none: they
    // would be building a chain out of whichever actions happened to be wired up.
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', '..', 'server', 'combat.js'), 'utf8');
    const calls = (src.match(/announceCombo\(/g) || []).length;
    // One definition, plus one per path: spells (via hitMobFor), auto-attack on a
    // mob, and PvP on a player.
    assert.ok(calls >= 4, `expected the definition plus at least three call sites, found ${calls}`);
    assert.ok(/announceCombo\(player, m\.id\)/.test(src), 'the spell path must register against the mob id');
    assert.ok(/announceCombo\(player, player\.targetId\)/.test(src), 'the auto-attack path must register');
    assert.ok(/announceCombo\(player, target\.id\)/.test(src), 'the PvP path must register');
});

test('the combo is registered before the kill resolves', () => {
    // Otherwise the final blow of every chain is missing from the meter, and a combo
    // always stops one short of what the player actually did.
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', '..', 'server', 'combat.js'), 'utf8');
    const at = src.indexOf('announceCombo(player, m.id);');
    const killAt = src.indexOf('if (m.hp <= 0) killMob(player, m);');
    assert.ok(at !== -1 && killAt !== -1, 'both lines must exist');
    assert.ok(at < killAt, 'the combo must be registered before the kill resolves');
});

test('the client drives its own combo display', () => {
    // The server sends a count and nothing else; the fade-out timer lives in the
    // client. That split is the reason this feature needed no client work, so it is
    // worth pinning -- a server-side timer would need a cancel packet per chain.
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', '..', 'client', 'js', 'engine.js'), 'utf8');
    assert.ok(/data\.action === "combo"/.test(src), 'the client must handle the combo packet');
    assert.ok(/window\.triggerCombo\(data\.hits\)/.test(src),
        'and must pass the count to the existing display function');
});