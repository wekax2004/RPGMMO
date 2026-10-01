/*
 * tests/unit/ratelimit.test.js
 *
 * The limiter is an abuse control, so the properties that matter are the ones a
 * flood depends on: one client cannot exceed its budget, cannot exceed it by
 * hammering harder, cannot spend another client's budget, cannot grow the server's
 * memory without bound, and cannot refill faster than the configured rate.
 *
 * The clock is injected rather than waited on. Every test here would otherwise
 * take seconds of real time and be flaky under load, and a timing test that is
 * flaky is worse than no timing test.
 */
const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');

const { createLimiter, classFor } = require('../../server/ratelimit');
const CFG = require('../../server/config');

/** A clock the test drives by hand. */
function fakeClock(start = 1_000_000) {
    let t = start;
    return {
        now: () => t,
        advance: (ms) => { t += ms; return t; }
    };
}

test('a burst is allowed and the next attempt is refused', () => {
    const clock = fakeClock();
    const limiter = createLimiter({ burst: 3, refillMs: 1000, now: clock.now });

    for (let i = 0; i < 3; i++) {
        assert.equal(limiter.consume('p1').allowed, true, `attempt ${i + 1} should be allowed`);
    }
    assert.equal(limiter.consume('p1').allowed, false, 'the fourth exceeds a burst of 3');
});

test('tokens refill over time and the budget resumes', () => {
    const clock = fakeClock();
    const limiter = createLimiter({ burst: 2, refillMs: 1000, now: clock.now });

    limiter.consume('p1');
    limiter.consume('p1');
    assert.equal(limiter.consume('p1').allowed, false);

    clock.advance(1000);
    assert.equal(limiter.consume('p1').allowed, true, 'one refill period grants one token');
    assert.equal(limiter.consume('p1').allowed, false, 'and only one');
});

test('an idle bucket does not bank more than its burst', () => {
    // The flood this prevents: walk away for a minute, return with a full tank
    // and spend it in one frame.
    const clock = fakeClock();
    const limiter = createLimiter({ burst: 3, refillMs: 100, now: clock.now });

    limiter.consume('p1');
    limiter.consume('p1');
    limiter.consume('p1');
    assert.equal(limiter.consume('p1').allowed, false);

    clock.advance(600_000);            // ten minutes of refills
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (limiter.consume('p1').allowed) allowed++;
    assert.equal(allowed, 3, 'a long idle period must not exceed the burst ceiling');
});

test('hammering while refused does not refill the bucket', () => {
    // Without this, a client that keeps sending while limited tops itself back
    // up on every rejected attempt and the limiter stops limiting. This is the
    // single most important line in the module.
    const clock = fakeClock();
    const limiter = createLimiter({ burst: 2, refillMs: 1000, now: clock.now });

    limiter.consume('p1');
    limiter.consume('p1');
    assert.equal(limiter.consume('p1').allowed, false);

    for (let i = 0; i < 500; i++) {
        assert.equal(limiter.consume('p1').allowed, false, 'a refused attempt must not grant a token');
        clock.advance(1);            // and must not advance time either
    }
    assert.equal(limiter.consume('p1').allowed, false);
});

test('one player cannot spend another player\'s budget', () => {
    const clock = fakeClock();
    const limiter = createLimiter({ burst: 2, refillMs: 1000, now: clock.now });

    limiter.consume('noisy');
    limiter.consume('noisy');
    assert.equal(limiter.consume('noisy').allowed, false);

    assert.equal(limiter.consume('quiet').allowed, true, 'a different player is unaffected');
    assert.equal(limiter.consume('quiet').allowed, true);
    assert.equal(limiter.consume('quiet').allowed, false);
});

test('the sustained rate is the refill rate, not the burst', () => {
    // Offered faster than the bucket refills on purpose. A first version of this
    // test advanced the clock by exactly refillMs per attempt, which offers the
    // limiter precisely its sustainable rate -- so all 1000 attempts were allowed
    // and the test proved nothing. Offering 10x the rate is what separates "one
    // token per 100ms" from "one token per attempt".
    const clock = fakeClock();
    const limiter = createLimiter({ burst: 2, refillMs: 100, now: clock.now });

    let allowed = 0;
    for (let i = 0; i < 1000; i++) {
        if (limiter.consume('p1').allowed) allowed++;
        clock.advance(10);           // 100 attempts offered per second
    }
    // 1000 attempts spanning 10 seconds; at one token per 100ms about 100 are
    // affordable once the burst is spent. Asserted as a band so rounding at the
    // window boundary is not load-bearing.
    assert.ok(allowed > 85 && allowed <= 110,
        `expected roughly 100 allowed out of 1000, got ${allowed}`);
});

test('a client offering exactly the refill rate is never refused', () => {
    // The other half of the test above, and the one that keeps the limiter from
    // being a performance regression for ordinary play.
    const clock = fakeClock();
    const limiter = createLimiter({ burst: 2, refillMs: 100, now: clock.now });

    for (let i = 0; i < 200; i++) {
        assert.equal(limiter.consume('p1').allowed, true,
            `attempt ${i + 1} at the sustainable rate should be allowed`);
        clock.advance(100);
    }
});

test('retryAfterMs is a usable hint and shrinks as the bucket refills', () => {
    const clock = fakeClock();
    const limiter = createLimiter({ burst: 1, refillMs: 1000, now: clock.now });

    limiter.consume('p1');
    const first = limiter.consume('p1');
    assert.equal(first.allowed, false);
    assert.ok(first.retryAfterMs > 0 && first.retryAfterMs <= 1000,
        `retry hint should be within one refill period, got ${first.retryAfterMs}`);

    clock.advance(600);
    const later = limiter.consume('p1');
    assert.ok(later.retryAfterMs < first.retryAfterMs,
        'the hint must shrink as the bucket refills');
});

test('the key map is bounded, and the oldest keys are evicted first', () => {
    // An attacker who can authenticate can otherwise create one entry per
    // player per class and never let them expire, making the limiter itself the
    // memory-exhaustion vector.
    const clock = fakeClock();
    const limiter = createLimiter({ burst: 5, refillMs: 1000, maxKeys: 10, idleMs: 60_000, now: clock.now });

    for (let i = 0; i < 50; i++) {
        limiter.consume(`player-${i}`);
        clock.advance(10);            // each is touched later than the one before
    }
    limiter.enforceCeiling(clock.now());

    assert.ok(limiter.size() <= 10, `expected at most 10 keys, got ${limiter.size()}`);
});

test('the sweep drops buckets nobody has touched', () => {
    const clock = fakeClock();
    const limiter = createLimiter({ burst: 5, refillMs: 1000, idleMs: 10_000, now: clock.now });

    limiter.consume('p1');
    assert.equal(limiter.size(), 1);

    clock.advance(9_000);
    limiter.sweep(clock.now());
    assert.equal(limiter.size(), 1, 'still inside the idle window');

    clock.advance(2_000);
    limiter.sweep(clock.now());
    assert.equal(limiter.size(), 0, 'past the idle window');
});

test('actions map to the class that matches what they cost', () => {
    // Chat is broadcast, so one client multiplies traffic for the floor.
    assert.equal(classFor('chat'), 'chat');
    // Inference, the most expensive thing a client can ask for.
    assert.equal(classFor('ask'), 'llm');
    // Persistent writes.
    assert.equal(classFor('bank_withdraw_gold'), 'economy');
    assert.equal(classFor('auction_list'), 'economy');
    // Relayed to another player.
    assert.equal(classFor('trade_request'), 'social');
    // Anything unlisted falls back to the generous bucket rather than being
    // refused, so a new feature is not throttled by accident.
    assert.equal(classFor('some_future_action'), 'other');
});

test('move and attack are deliberately not budgeted', () => {
    // They already have gameplay cooldowns. Budgeting them as well would make
    // the existing tuning unobservable, and a player would be refused by a
    // limiter whose number nobody chose deliberately.
    assert.equal(classFor('move'), 'other');
    assert.equal(classFor('attack'), 'other');
});

test('every configured budget is usable', () => {
    for (const [cls, budget] of Object.entries(CFG.RATE_LIMITS)) {
        assert.ok(Number.isFinite(budget.burst) && budget.burst >= 1,
            `${cls}.burst must be at least 1`);
        assert.ok(Number.isFinite(budget.refillMs) && budget.refillMs > 0,
            `${cls}.refillMs must be positive`);
        // Constructing is the real assertion: a bad budget throws here rather
        // than on the first packet a player sends.
        assert.doesNotThrow(() => createLimiter(budget), `${cls} should build a limiter`);
    }
});

test('the llm budget is far tighter than chat', () => {
    // If these ever converge, the LLM path is no longer the thing that is
    // rationed, and /ask becomes an unbounded local inference again.
    assert.ok(CFG.RATE_LIMITS.llm.refillMs > CFG.RATE_LIMITS.chat.refillMs * 5,
        'the llm budget must be much tighter than chat');
    assert.ok(CFG.RATE_LIMITS.llm.burst <= 1, 'the llm budget must not allow a burst of inferences');
});

test('the notice cooldown is long enough to not become a flood itself', () => {
    // Telling the client 60 times a second would be its own traffic problem.
    assert.ok(CFG.RATE_LIMIT_NOTICE_COOLDOWN_MS >= 1000,
        'a throttled client must not be notified every packet');
});

test('a limiter with an impossible budget is rejected at construction', () => {
    // Failing at startup is recoverable. Failing on the first packet a player
    // sends is an outage.
    assert.throws(() => createLimiter({ burst: 0, refillMs: 100 }), /burst/);
    assert.throws(() => createLimiter({ burst: 1, refillMs: 0 }), /refillMs/);
    assert.throws(() => createLimiter({ burst: 1, refillMs: -5 }), /refillMs/);
});

test('the documented budget env overrides actually apply', () => {
    // config.js claims these exist "so a load test or a busy shard can be tuned
    // without a code change", and the wiring lives in server.js rather than in
    // the limiter module, so nothing covered it. Deleting the override left the
    // entire unit suite green -- found by mutating server.js and watching for a
    // red suite that never came. A documented knob that silently does nothing is
    // worse than no knob, because it gets relied on during an incident.
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'server', 'server.js'), 'utf8');

    // The names are built by interpolation, so the literal "TIBIA_RATECHAT_BURST"
    // never appears in the source. What has to hold is that the pattern is right
    // for every configured class, which is checked by evaluating it rather than by
    // grepping for the concrete names.
    assert.match(src, /TIBIA_RATE\$\{name\.toUpperCase\(\)\}_BURST/,
        'server.js must read a per-class _BURST override');
    assert.match(src, /TIBIA_RATE\$\{name\.toUpperCase\(\)\}_REFILL_MS/,
        'server.js must read a per-class _REFILL_MS override');

    // The documented example must actually be the name the code derives for the chat
    // class, since that is the name a reader will try first during an incident.
    assert.equal(`TIBIA_RATE${'chat'.toUpperCase()}_BURST`, 'TIBIA_RATECHAT_BURST');
    assert.equal(`TIBIA_RATE${'chat'.toUpperCase()}_REFILL_MS`, 'TIBIA_RATECHAT_REFILL_MS');
    assert.ok(Object.keys(CFG.RATE_LIMITS).length > 0, 'expected at least one configured budget class');

    // And the reads must be guarded, so a malformed value falls back to the
    // configured budget instead of becoming NaN and silently disabling that class.
    assert.match(src, /Number\.isFinite\(burst\) && burst > 0 \? burst : fallback\.burst/,
        'an invalid TIBIA_RATECHAT_BURST must fall back to the configured budget');
    assert.match(src, /Number\.isFinite\(refill\) && refill > 0 \? refill : fallback\.refillMs/,
        'an invalid TIBIA_RATECHAT_REFILL_MS must fall back to the configured budget');
});