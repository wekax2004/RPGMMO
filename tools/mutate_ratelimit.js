/*
 * Re-injects rate-limiting defects one at a time and confirms
 * tests/unit/ratelimit.test.js goes red for each.
 *
 * Run:  node tools/mutate_ratelimit.js
 * Exits non-zero if any mutation survives.
 *
 * A limiter's worth is entirely in its refusals, and refusals are invisible in a
 * passing test suite. Every mutation here removes a refusal that should happen
 * and leaves a suite that still reports green -- which is the exact shape of the
 * bug this harness exists to make impossible to ship.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIMITER = 'server/ratelimit.js';
const CONFIG = 'server/config.js';
const TEST = 'tests/unit/ratelimit.test.js';

const MUTATIONS = [
    {
        name: 'the burst is ignored -- every attempt is allowed',
        file: LIMITER,
        from: 'if (b.tokens >= 1) {',
        to: 'if (true) {'
    },
    {
        name: 'a refused attempt still consumes the token it did not get',
        // Removing this is what lets a client refill itself by hammering while
        // limited, which is the single most important behaviour in the module.
        file: LIMITER,
        from: 'const deficit = 1 - b.tokens;',
        to: 'const deficit = 1 - b.tokens;\n        b.tokens = Math.min(burst, b.tokens + 1);'
    },
    {
        name: 'tokens bank without limit, so idling grants an unbounded burst',
        file: LIMITER,
        from: 'b.tokens = Math.min(burst, b.tokens + (elapsed / refillMs));',
        to: 'b.tokens += (elapsed / refillMs);'
    },
    {
        name: 'all players share one bucket',
        file: LIMITER,
        from: 'let b = buckets.get(key);',
        to: 'let b = buckets.get("__shared__");'
    },
    {
        name: 'the key map is never bounded',
        file: LIMITER,
        from: 'if (buckets.size <= maxKeys) return 0;',
        to: 'if (true) return 0;'
    },
    {
        name: 'the sweep never removes anything',
        file: LIMITER,
        from: 'if (at - b.touchedAt >= idleMs) buckets.delete(key);',
        to: 'if (false) buckets.delete(key);'
    },
    {
        name: 'retryAfterMs always reports zero, so the hint is useless',
        file: LIMITER,
        from: 'return { allowed: false, retryAfterMs: Math.ceil(deficit * refillMs) };',
        to: 'return { allowed: false, retryAfterMs: 0 };'
    },
    {
        name: 'chat is classified as llm, so /ask shares the wrong budget',
        file: LIMITER,
        from: "    chat: 'chat',",
        to: "    chat: 'llm',"
    },
    {
        name: 'move is budgeted, so gameplay movement gets throttled',
        file: LIMITER,
        from: "function classFor(action) {\n    return ACTION_CLASSES[action] || 'other';\n}",
        to: "function classFor(action) {\n    if (action === 'move') return 'item';\n    return ACTION_CLASSES[action] || 'other';\n}"
    },
    {
        name: 'the llm budget is loosened to match chat',
        file: CONFIG,
        from: "llm:       { burst: 1,  refillMs: 15_000 },",
        to: "llm:       { burst: 6,  refillMs: 1200 },"
    },
    {
        name: 'the throttle notice is sent on every refused packet',
        file: CONFIG,
        from: 'RATE_LIMIT_NOTICE_COOLDOWN_MS: 1500,',
        to: 'RATE_LIMIT_NOTICE_COOLDOWN_MS: 0,'
    },
    {
        name: 'an impossible budget is accepted instead of throwing at startup',
        file: LIMITER,
        from: "if (!Number.isFinite(burst) || burst < 1) throw new Error('burst must be >= 1');",
        to: "if (!Number.isFinite(burst) || burst < 1) burst = 1;"
    },
    {
        // Reached by mutating server.js rather than the limiter, and included here
        // because it was verified to be uncovered: with the override ignored, the
        // whole unit suite stayed green. budgetFromEnv lives in server.js and no
        // unit test imports it, so nothing asserted the env override does
        // anything. The env vars are a documented tuning knob and a claimed
        // safety valve; a knob that silently does nothing is worse than none.
        name: 'the budget burst env override is ignored',
        file: 'server/server.js',
        from: 'burst: Number.isFinite(burst) && burst > 0 ? burst : fallback.burst,',
        to: 'burst: fallback.burst,'
    },
    {
        name: 'the budget refill env override is ignored',
        file: 'server/server.js',
        from: 'refillMs: Number.isFinite(refill) && refill > 0 ? refill : fallback.refillMs',
        to: 'refillMs: fallback.refillMs'
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
    return m ? m[1].trim().slice(0, 68) : '(no failure line found)';
}

const originals = new Map();
for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs, 'utf8'));
}

console.log('=== rate limit mutation testing ===\n');
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
        console.log('            the suite passed against an unbounded limiter\n');
    } else {
        console.log(`  CAUGHT    ${m.name}`);
        console.log(`            ${failingTest(result.out)}\n`);
    }
}

console.log(`  ${MUTATIONS.length - survived} caught, ${survived} survived`);
if (survived) {
    console.log('\n  A surviving mutation is a refusal that no longer happens and nobody notices.');
    process.exitCode = 1;
} else {
    console.log('  Every mutation was caught.');
}