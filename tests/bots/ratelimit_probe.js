/*
 * tests/bots/ratelimit_probe.js
 *
 * Proves the limiter is wired into the packet path, not merely present in the
 * module. Every unit test in tests/unit/ratelimit.test.js would still pass if the
 * server never called the limiter, and that is the failure that matters: an abuse
 * control that exists and is never invoked looks exactly like one that works.
 *
 * What it checks, against a real server over a real socket:
 *
 *   1. A chat flood is refused and the client is told.
 *   2. The notice is rate-limited too, so a notice flood is not its own problem.
 *   3. The server actually stops doing the work, not just stops announcing it.
 *   4. One spammy client does not throttle a second, ordinary one.
 *   5. `/ask` is charged to the llm budget rather than the chat budget.
 *   6. Movement is not caught by the packet limiter.
 *
 * Run:  node tests/bots/ratelimit_probe.js --port=8139
 * Exits non-zero if any check fails.
 *
 * A note on what these assertions are worth. An earlier draft of this file had
 * two checks that could not fail -- `moved >= 0` and `notices >= 0` -- which is
 * the same mistake as a decorative unit test. Every check below names an
 * observable that has to actually change.
 */
const BotClient = require('./bot_client');
const CFG = require('../../server/config');

const portArg = process.argv.indexOf('--port');
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 8139;
const URL = `ws://localhost:${PORT}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

function tap(bot, event) {
    const seen = [];
    const listener = (packet) => seen.push(packet);
    bot.on(event, listener);
    return { seen, stop: () => bot.off(event, listener) };
}

async function main() {
    console.log(`=== rate limit live probe (port ${PORT}) ===\n`);
    console.log(`  budgets: chat burst ${CFG.RATE_LIMITS.chat.burst} per ${CFG.RATE_LIMITS.chat.refillMs}ms,` +
        ` llm burst ${CFG.RATE_LIMITS.llm.burst} per ${CFG.RATE_LIMITS.llm.refillMs}ms\n`);

    const spammy = new BotClient({ serverUrl: URL, name: 'RateSpam', classType: 'warrior' });
    const bystander = new BotClient({ serverUrl: URL, name: 'RateCalm', classType: 'warrior' });
    // A long timeout on purpose. The first login against a fresh server/data
    // initialises SQLite and pays for it inside the login round trip, and the
    // 5s default timed out on exactly that rather than on anything wrong.
    const LOGIN_TIMEOUT = 20_000;
    await spammy.connect(URL, LOGIN_TIMEOUT);
    await bystander.connect(URL, LOGIN_TIMEOUT);
    await spammy.login(spammy.charName, spammy.classType, false, LOGIN_TIMEOUT);
    await bystander.login(bystander.charName, bystander.classType, false, LOGIN_TIMEOUT);
    await sleep(400);

    // A refusal arrives as a `rate_limited` packet. BotClient has a case for it,
    // so it is observable directly. An earlier draft of this probe watched the
    // log stream instead and reported a working limiter as a silent one, because
    // BotClient had no handler for the packet and dropped it on the floor.
    const chatTap = tap(spammy, 'chat');
    const limitTap = tap(spammy, 'rate_limited');
    const calmChatTap = tap(bystander, 'chat');
    const calmLimitTap = tap(bystander, 'rate_limited');

    // --- 1 and 2: a chat flood is refused, and the notice is itself rationed
    const FLOOD = 40;
    for (let i = 0; i < FLOOD; i++) spammy.sendChat(`flood ${i}`);
    await sleep(1500);

    const notices = limitTap.seen;
    check('a chat flood is refused and the client is told', notices.length > 0,
        `${notices.length} rate_limited packet(s) after ${FLOOD} chat sends`);
    check('the notice is rationed, not one per refused packet',
        notices.length > 0 && notices.length <= 3,
        `${notices.length} notice(s) for ${FLOOD} sends; the notice cooldown ` +
        `allows about ${Math.ceil(1500 / CFG.RATE_LIMIT_NOTICE_COOLDOWN_MS) + 1}`);
    check('the notice names the class and a retry hint',
        notices.length > 0 && notices.every(p => p.budgetClass && p.retryAfterMs > 0),
        notices.length ? `budgetClass=${notices[0].budgetClass} retryAfterMs=${notices[0].retryAfterMs}` : 'none seen');

    // --- 3: the work stops, not just the announcement ---------------------
    const echoes = chatTap.seen.filter(p => String(p.text || '').startsWith('flood '));
    check('refused chat is not broadcast back to the sender',
        echoes.length > 0 && echoes.length < FLOOD,
        `${echoes.length} of ${FLOOD} flooded lines came back (0 would mean the ` +
        `whole class is dead, ${FLOOD} would mean the limiter is inert)`);

    // --- 4: one spammer does not throttle a bystander ---------------------
    const calmCount = CFG.RATE_LIMITS.chat.burst;
    for (let i = 0; i < calmCount; i++) bystander.sendChat(`calm ${i}`);
    await sleep(1200);
    const calmEchoes = calmChatTap.seen.filter(p => String(p.text || '').startsWith('calm '));
    check('a second client keeps its own budget while another floods',
        calmEchoes.length === calmCount,
        `bystander sent ${calmCount} within its burst and got ${calmEchoes.length} back`);
    check('the bystander was not told to slow down',
        calmLimitTap.seen.length === 0,
        'no rate_limited packet reached the second client');

    // --- 5: /ask is charged to the llm budget ----------------------------
    // A burst of 2 against a burst-1 budget. The second must be refused, and the
    // notice must say `llm` -- not `chat`. That is what proves the two budgets
    // are separate: the chat budget was emptied by the flood above, so if /ask
    // were still charged to chat the notice would name the wrong class and the
    // test could not tell the two apart.
    const askTap = tap(spammy, 'rate_limited');
    spammy.sendChat('/ask what is a dungeon');
    await sleep(150);
    spammy.sendChat('/ask what is a dungeon');
    await sleep(900);
    const askNotices = askTap.seen;
    check('the second /ask in a burst is refused', askNotices.length > 0,
        `${askNotices.length} notice(s) from 2 /ask sends`);
    check('/ask is charged to the llm budget, not the chat budget',
        askNotices.length > 0 && askNotices.every(p => p.budgetClass === 'llm'),
        askNotices.length ? `budgetClass=${askNotices[0].budgetClass}` : 'no notice to classify');
    askTap.stop();

    // --- 6: movement is not caught by the limiter -------------------------
    // 'other' is generous precisely so gameplay packets stay governed by their
    // own cooldowns. If this fails, ordinary play is being throttled by the
    // wrong mechanism.
    const startX = spammy.x;
    const moveTap = tap(spammy, 'rate_limited');
    for (let i = 0; i < 20; i++) {
        spammy.send({ action: 'move', x: startX + (i % 2 ? 32 : 0), y: startX });
        await sleep(20);
    }
    await sleep(600);
    check('movement is not throttled by the packet limiter',
        moveTap.seen.filter(p => p.packetAction === 'move').length === 0,
        '20 moves at 20ms apart produced no rate_limited packet for move');
    moveTap.stop();

    [chatTap, limitTap, calmChatTap, calmLimitTap].forEach(t => t.stop());
    await spammy.disconnect();
    await bystander.disconnect();

    console.log(`\n  ${failures === 0 ? 'all 6 checks passed' : failures + ' of 6 checks FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('  probe could not run:', err && err.message);
    process.exit(1);
});