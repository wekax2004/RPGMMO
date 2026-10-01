/*
 * Verifies the rate limiting is actually wired into the packet handler, by
 * mutating server.js and requiring the live probe to fail.
 *
 * Run:  node tools/mutate_ratelimit_wiring.js --port=8139
 *
 * Requires a server already running on the port with TIBIA_TEST_MODE=true, since
 * the probe is a black-box client. Start one:
 *
 *   $env:PORT=8139; $env:TIBIA_TEST_MODE='true'; node server/server.js
 *
 * This is the layer the unit tests cannot reach. Every mutation below makes the
 * limiter do less, and the probe is the only thing that can tell -- a module can
 * be perfect and the call site can still never invoke it.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'server.js');
const PROBE = path.join(ROOT, 'tests', 'bots', 'ratelimit_probe.js');
const PORT = (() => {
    const i = process.argv.indexOf('--port');
    return i > -1 ? Number(process.argv[i + 1]) : 8139;
})();

const MUTATIONS = [
    {
        name: 'the limiter is never consulted',
        from: 'const verdict = rateLimiters[budgetClass].consume(player.id);',
        to: 'const verdict = { allowed: true, retryAfterMs: 0 };'
    },
    {
        name: 'the check is in place but a refusal does not stop the handler',
        from: `if (!verdict.allowed) {`,
        to: `if (false) {`
    },
    {
        name: 'every action is classified as other, the generous bucket',
        from: 'let budgetClass = RATELIMIT.classFor(data.action);',
        to: "let budgetClass = 'other';"
    },
    {
        name: '/ask is charged to chat instead of the llm budget',
        from: `if (budgetClass === 'chat'
                && typeof data.text === 'string'
                && data.text.startsWith('/ask ')) {
                budgetClass = 'llm';
            }`,
        to: `if (false) {
                budgetClass = 'llm';
            }`
    },
    {
        name: 'the client is never told it was throttled',
        from: "sendTo(player, {\n                        action: 'rate_limited',",
        to: "sendTo(player, {\n                        action: 'log',"
    },
    {
        name: 'the notice cooldown is not honoured, so notices flood',
        from: 'if (now - (player.lastRateLimitNotice || 0) >= CFG.RATE_LIMIT_NOTICE_COOLDOWN_MS) {',
        to: 'if (true) {'
    }
];

/**
 * Start a server for one probe run and stop it again.
 *
 * The server is restarted per mutation rather than reused, because the point of
 * each mutation is to change server.js: a still-running process keeps the old
 * code in memory, and the probe would then pass against code that is no longer on
 * disk. That failure mode is silent -- the harness would report every mutation as
 * survived.
 */
const { spawn } = require('child_process');

function startServer() {
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), TIBIA_TEST_MODE: 'true' },
        stdio: 'ignore'
    });
    return child;
}

function stopServer(child) {
    if (!child || child.killed) return;
    try { child.kill(); } catch (e) { /* already gone */ }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runProbeAgainstFreshServer() {
    const child = startServer();
    try {
        await sleep(3500);          // module load plus SQLite init
        const out = execFileSync(process.execPath, [PROBE, `--port=${PORT}`],
            { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    } finally {
        stopServer(child);
        await sleep(700);           // let the port free up before the next start
    }
}

function failedChecks(out) {
    return [...out.matchAll(/^\s*FAIL\s+(.+)$/gm)].map(m => m[1].trim());
}

const original = fs.readFileSync(SERVER, 'utf8');

console.log(`=== rate limit wiring mutation testing (port ${PORT}) ===\n`);

// A server is started per run, because each mutation changes server.js on disk.
// A process that was already running keeps the old code in memory, so reusing one
// would report every mutation as survived -- and it would look like the harness
// working.
async function main() {
const base = await runProbeAgainstFreshServer();
if (!base.ok) {
    console.log('  baseline probe FAILS; fix that before mutating.');
    console.log(failedChecks(base.out).map(l => '    ' + l).join('\n'));
    process.exit(1);
}
console.log('  baseline: probe passes (limiter is wired and working)');

let survived = 0;
try {
    for (const m of MUTATIONS) {
        if (!original.includes(m.from)) {
            console.log(`  SKIP      ${m.name}`);
            console.log('            anchor not found -- server.js drifted, update this harness\n');
            survived++;
            continue;
        }
        fs.writeFileSync(SERVER, original.replace(m.from, m.to), 'utf8');
        const result = await runProbeAgainstFreshServer();
        fs.writeFileSync(SERVER, original, 'utf8');

        if (result.ok) {
            survived++;
            console.log(`  SURVIVED  ${m.name}`);
            console.log('            the probe passed with the limiter weakened\n');
        } else {
            const failed = failedChecks(result.out);
            console.log(`  CAUGHT    ${m.name}`);
            console.log(`            ${failed.length ? failed.join('; ').slice(0, 64) : 'probe errored'}`);
        }
    }
} finally {
    fs.writeFileSync(SERVER, original, 'utf8');
}

console.log(`\n  ${MUTATIONS.length - survived} caught, ${survived} survived`);
if (survived) {
    console.log('\n  A surviving mutation means the limiter can be broken without anything noticing.');
    process.exitCode = 1;
} else {
    console.log('  Every mutation was caught.');
}
}

main().catch(err => {
    console.error('  harness error:', err && err.message);
    process.exit(1);
});