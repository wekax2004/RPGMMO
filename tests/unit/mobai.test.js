/*
 * tests/unit/mobai.test.js
 *
 * Roadmap 5.2: mob behaviour beyond aggro and approach.
 *
 * `decide` and `callersForHelp` are pure with respect to the world -- they read a mob
 * and a list and return an intent -- so every branch is reachable in one call with an
 * injected rng. That is the right shape here, because the failure mode of a mob AI is
 * a decision that is *almost* right: a flee that never ends, a call that alerts the
 * whole floor, a patrol that walks into rock.
 *
 * What this cannot check is whether the tick actually calls any of it.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const MOBAI = require('../../server/mobai');

const T0 = 1_000_000;
const mob = (over = {}) => ({
    id: 'm1', type: 'bear', x: 0, y: 0, z: 0,
    hp: 100, maxHp: 100, fleeUntil: 0, lastCallAt: 0,
    homeX: 0, homeY: 0,
    ...over
});
/**
 * Builds a full ctx. `mobOver` shapes the MOB and `over` shapes the ctx itself --
 * separate parameters, because the first draft merged them and `full({distance: 200})`
 * silently set a `distance` property on the MOB while the ctx kept distance 50. The
 * test then read "expected chase, got attack" and blamed the brain.
 */
const full = (mobOver = {}, over = {}) => ({
    mob: mob(mobOver),
    target: { id: 'p1' },
    distance: 50,
    now: T0,
    random: () => 1,
    meleeRange: 96,
    aggroRange: 400,
    ...over
});

test('a healthy mob in melee range attacks', () => {
    assert.strictEqual(MOBAI.decide(full()).state, 'attack');
});

test('a healthy mob out of melee but inside aggro chases', () => {
    const r = MOBAI.decide(full({}, { distance: 200 }));
    assert.strictEqual(r.state, 'chase');
    assert.match(r.reason, /aggro/);
});

test('a mob with no target patrols rather than standing still', () => {
    // The whole point of the feature: a floor was a set of statues.
    const r = MOBAI.decide({ mob: mob(), target: null, distance: Infinity, now: T0, random: () => 1 });
    assert.strictEqual(r.state, 'patrol');
});

test('a mob whose target is out of range patrols', () => {
    assert.strictEqual(MOBAI.decide(full({}, { distance: 900 })).state, 'patrol');
});

test('a coward at low health flees, and the roll is reachable', () => {
    const r = MOBAI.decide(full({ hp: 10, maxHp: 100 }, { random: () => 0 }));
    assert.strictEqual(r.state, 'flee');
    assert.match(r.reason, /hp/);
});

test('a non-coward does not flee at any health', () => {
    // Bears flee; skeletons do not. Without this a skeleton at 1% health runs away
    // from something it can barely see, which reads as broken rather than scared.
    for (const type of ['skeleton', 'minotaur', 'bandit', 'yeti']) {
        const r = MOBAI.decide(full({ type, hp: 1, maxHp: 100 }));
        assert.notStrictEqual(r.state, 'flee', `${type} must not flee`);
    }
});

test('fleeing wins over attacking', () => {
    // Otherwise a mob oscillates on the flee/health boundary and appears to flicker
    // between running away and hitting the player.
    const r = MOBAI.decide(full({ hp: 5, maxHp: 100 }, { distance: 10, random: () => 0 }));
    assert.strictEqual(r.state, 'flee');
});

test('flee is bounded, so a mob is never unkillable', () => {
    const m = mob({ hp: 5, maxHp: 100 });
    const roll = { random: () => 0 };
    const first = MOBAI.decide({ ...full({ hp: 5, maxHp: 100 }), mob: m, ...roll });
    assert.strictEqual(first.state, 'flee');
    assert.ok(m.fleeUntil > T0, 'the flee must set a timer');
    // Still inside the window.
    assert.strictEqual(MOBAI.decide({ ...full({ hp: 5, maxHp: 100 }), mob: m, now: m.fleeUntil - 1, ...roll }).state, 'flee');
    const expiry = m.fleeUntil;
    // Expired. It turns back, but NOT immediately -- a mob that could re-panic on the
    // very next tick would flee in a 2.5s loop for as long as the player kept
    // swinging, which is the unkillable-mob case the bound exists to prevent. The
    // panic roll is still forced to 0 here, so only the cooldown can be stopping it.
    const after = MOBAI.decide({ ...full({ hp: 5, maxHp: 100 }), mob: m, now: expiry + 1, ...roll });
    assert.strictEqual(after.state, 'attack',
        'an expired flee must not immediately re-trigger at the same health');
    assert.strictEqual(m.fleeUntil, 0, 'an expired flee must be cleared, not left as a stale timestamp');
    assert.ok(m.fleeReadyAt > expiry, 'and a cooldown must be set, or the mob re-panics next tick');

    // And once the cooldown lapses it may panic again, so this is a reprieve and not
    // a permanent immunity. Anchored on `expiry`, not on m.fleeUntil -- which the line
    // above just zeroed, so reading it here gave a time in 1970 and the check passed
    // for the wrong reason on the run before.
    const later = MOBAI.decide({
        ...full({ hp: 5, maxHp: 100 }), mob: m, now: m.fleeReadyAt + 10, ...roll
    });
    assert.strictEqual(later.state, 'flee', 'a mob must be able to panic again after the cooldown');
});

test('a mob with no flee time does not read as fleeing', () => {
    // `fleeUntil` is 0 on a fresh mob. `0 && ...` is falsy so this works, but a
    // future edit to `||` would make every mob flee forever.
    const r = MOBAI.decide(full());
    assert.notStrictEqual(r.state, 'flee');
});

test('call for help alerts nearby same-type mobs only', () => {
    // Type-limited on purpose: alerting every mob on the floor turns a solo player
    // into a raid.
    const caller = mob({ id: 'a', x: 0, y: 0 });
    const nearbyBear = mob({ id: 'b', x: 100, y: 0 });
    const nearbySkeleton = mob({ id: 'c', type: 'skeleton', x: 100, y: 0 });
    const farBear = mob({ id: 'd', x: 5000, y: 0 });
    const called = MOBAI.callersForHelp(caller, [caller, nearbyBear, nearbySkeleton, farBear], {
        targetId: 'p1', now: T0, random: () => 0
    });
    assert.deepStrictEqual(called, ['b'], 'only the nearby bear of the same type');
});

test('call for help never crosses a floor', () => {
    const caller = mob({ id: 'a', z: -1 });
    const underground = mob({ id: 'b', z: -1, x: 50 });
    const surface = mob({ id: 'c', z: 0, x: 50 });
    const called = MOBAI.callersForHelp(caller, [caller, underground, surface], {
        targetId: 'p1', now: T0, random: () => 0
    });
    assert.deepStrictEqual(called, ['b']);
});

test('a mob with a missing or corrupt z is on the surface', () => {
    // Matches server.js's own normalisation. A surface caller must be able to alert a
    // surface helper whose z was never set, or the first call for help after a
    // version skew silently does nothing.
    const caller = mob({ id: 'a', z: undefined });
    const helper = mob({ id: 'b', z: undefined, x: 50 });
    const called = MOBAI.callersForHelp(caller, [caller, helper], { targetId: 'p1', now: T0, random: () => 0 });
    assert.deepStrictEqual(called, ['b']);
});

test('a dead mob does not call for help', () => {
    const caller = mob({ id: 'a', hp: 0 });
    const helper = mob({ id: 'b', x: 50 });
    const called = MOBAI.callersForHelp(caller, [caller, helper], { targetId: 'p1', now: T0, random: () => 0 });
    assert.deepStrictEqual(called, [], 'a corpse rallying its pack is not a behaviour');
});

test('a helper on cooldown is not re-alerted', () => {
    const caller = mob({ id: 'a' });
    const helper = mob({ id: 'b', x: 50, alertedBy: 'a', alertedAt: T0 - 1000 });
    const called = MOBAI.callersForHelp(caller, [caller, helper], { targetId: 'p1', now: T0, random: () => 0 });
    assert.deepStrictEqual(called, [], 'the same helper must not be added twice');
    const later = MOBAI.callersForHelp(caller, [caller, helper], {
        targetId: 'p1', now: T0 + MOBAI.ALERT_DURATION_MS + 1, random: () => 0
    });
    assert.deepStrictEqual(later, ['b'], 'but it can be alerted again once the alert lapses');
});

test('the caller has a cooldown of its own', () => {
    const caller = mob({ id: 'a', lastCallAt: T0 - 100 });
    const helper = mob({ id: 'b', x: 50 });
    const called = MOBAI.callersForHelp(caller, [caller, helper], { targetId: 'p1', now: T0, random: () => 0 });
    assert.deepStrictEqual(called, [], 'a mob hit repeatedly must not alert on every hit');
});

test('a fleeing helper does not join the call', () => {
    const caller = mob({ id: 'a' });
    const running = mob({ id: 'b', x: 50, fleeUntil: T0 + 5000 });
    const called = MOBAI.callersForHelp(caller, [caller, running], { targetId: 'p1', now: T0, random: () => 0 });
    assert.deepStrictEqual(called, [], 'a mob that is already running away should keep running');
});

test('the caller never alerts itself', () => {
    const caller = mob({ id: 'a' });
    const called = MOBAI.callersForHelp(caller, [caller], { targetId: 'p1', now: T0, random: () => 0 });
    assert.deepStrictEqual(called, []);
});

test('the numbers are in a defensible range', () => {
    // A flee a player cannot outlast is not a flee; one they can trivially outlast is
    // not worth having. Measured in seconds of running rather than raw ms.
    const fleeSeconds = MOBAI.FLEE_DURATION_MS / 1000;
    assert.ok(fleeSeconds >= 1.5 && fleeSeconds <= 6,
        `${fleeSeconds}s of running is outside the range where it reads as a reprieve`);
    assert.ok(MOBAI.FLEE_COOLDOWN_MS > MOBAI.FLEE_DURATION_MS,
        'the flee cooldown must exceed the flee itself, or a mob re-panics the tick ' +
        'after it stops running and is unkillable in a loop');

    assert.ok(MOBAI.FLEE_HP_FRACTION > 0 && MOBAI.FLEE_HP_FRACTION <= 0.4,
        'a mob that panics at half health is not a coward, it is broken');

    assert.ok(MOBAI.CALL_RADIUS >= MOBAI.FLEE_TRIGGER_RANGE / 2,
        'the call radius must be comparable to the range a flee is triggered at');

    assert.ok(MOBAI.ALERT_DURATION_MS < MOBAI.CALL_COOLDOWN_MS * 4,
        'an alert that outlasts many call cooldowns means mobs are permanently enraged');
});

test('the tick actually consults the brain, and all three behaviours are wired', () => {
    // The unit tests above call `decide` directly, so a tick that never calls it
    // would leave every one of them green while the game is unchanged.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'server.js'), 'utf8');
    assert.ok(/MOBAI\.decide\(/.test(src), 'the mob tick must consult the brain');
    assert.ok(/patrolStep\(mob\)/.test(src), 'patrol must be reachable from the tick');
    assert.ok(/moveMobAway\(mob/.test(src), 'fleeing must actually move the mob away');
    assert.ok(/callForHelp/.test(src), 'call for help must be wired into the damage path');
});

test('a mob record carries the state every behaviour reads', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'mobs.js'), 'utf8');
    const sites = [...src.matchAll(/mobs\.set\(([^\n]*)\{([\s\S]*?)\n\s*\}\)/g)];
    assert.ok(sites.length >= 3, `expected three mobs.set sites, found ${sites.length}`);
    for (const [, , body] of sites) {
        // Strip comments first: the notes explaining these fields contain the field
        // names, and an assertion that matches the prose accepts a spawn site that
        // dropped the value. That is the allowlist mistake in a new costume, and it
        // already cost two mutations once in this repo.
        const code = body.replace(/\/\/[^\n]*/g, '');
        assert.ok(/\bhomeX\s*[:,]/.test(code), 'every mob needs a home anchor to patrol back to');
        assert.ok(/\bfleeUntil\s*[:,]/.test(code), 'every mob needs the flee timer');
        assert.ok(/\blastCallAt\s*[:,]/.test(code), 'every mob needs the call cooldown');
    }
});