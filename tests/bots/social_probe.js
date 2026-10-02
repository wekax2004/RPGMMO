/*
 * tests/bots/social_probe.js
 *
 * Behaviour snapshot for the social handlers, taken before and after extracting them
 * out of server.js into server/social.js (roadmap 7.1 item 1).
 *
 * WHY A SNAPSHOT AND NOT JUST "THE TESTS STILL PASS"
 *
 * The unit tests for this area are source-level -- they assert that a branch exists
 * and that it calls the right thing -- which is the wrong shape for a refactor. A
 * refactor can leave every source-level assertion satisfied while changing what the
 * game does, because the assertions describe the shape of the code rather than its
 * effect. So this drives every social action over a real socket and records what
 * actually comes back.
 *
 * Run before the extraction and again after: the two runs must agree.
 *
 * It also happens to be the thing that proves the guild bank is broken, which no
 * amount of reading the code settles on its own.
 */

const path = require('path');
const { spawn } = require('child_process');

const BotClient = (() => {
    try { return require('./bot_client'); } catch (e) { return require('./bot_client.js'); }
})();

function readPort(argv) {
    const eq = argv.find(a => a.startsWith('--port='));
    if (eq) return Number(eq.split('=')[1]);
    const i = argv.indexOf('--port');
    if (i > -1 && argv[i + 1]) return Number(argv[i + 1]);
    return 8024;
}

const PORT = readPort(process.argv.slice(2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

/** Records the packets a social action can produce. */
function watch(bot) {
    const rec = { lists: [], leaderboards: [], inspects: [], logs: [], fct: [], guildSync: [], limited: 0 };
    const handle = (raw) => {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
        if (p.action === 'friends_list') rec.lists.push(p.friends);
        if (p.action === 'leaderboard_result') rec.leaderboards.push(p.leaderboard);
        if (p.action === 'inspect_player_result') rec.inspects.push(p.player);
        if (p.action === 'guild_sync') rec.guildSync.push(p.guild);
        if (p.action === 'log') rec.logs.push(p.message || '');
        if (p.action === 'fct') rec.fct.push(p.text);
        if (p.action === 'rate_limited') rec.limited++;
    };
    const sock = bot.ws;
    if (typeof sock.addEventListener === 'function') sock.addEventListener('message', e => handle(e.data));
    else if (typeof sock.on === 'function') sock.on('message', d => handle(d));
    return rec;
}

function startServer(port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server/server.js'], {
            cwd: path.join(__dirname, '..', '..'),
            env: { ...process.env, PORT: String(port), TIBIA_TEST_MODE: 'true' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let settled = false;
        const fail = (m) => { if (!settled) { settled = true; reject(new Error(m)); } };
        child.on('exit', c => fail(`server exited (${c}) before accepting connections`));
        child.stderr.on('data', d => { if (/EADDRINUSE/.test(String(d))) fail(`port ${port} in use`); });
        const poll = setInterval(async () => {
            if (settled) { clearInterval(poll); return; }
            try {
                const probe = new BotClient({ name: `p_${Date.now()}` });
                await probe.connect(`ws://localhost:${port}`, 1500);
                probe.disconnect();
                clearInterval(poll); settled = true; resolve(child);
            } catch (e) { /* not up yet */ }
        }, 500);
        setTimeout(() => fail('server did not start within 20s'), 20000);
    });
}

/** Sends and waits, retrying through the social rate limit and reporting it. */
async function social(bot, rec, packet, ms = 700) {
    for (let i = 0; i < 5; i++) {
        const before = { l: rec.lists.length, lb: rec.leaderboards.length, i: rec.inspects.length, lim: rec.limited };
        bot.send(packet);
        await sleep(ms);
        if (rec.limited > before.lim) { await sleep(2200); continue; }
        if (rec.lists.length > before.l || rec.leaderboards.length > before.lb || rec.inspects.length > before.i) return true;
        await sleep(250);
    }
    return false;
}

async function main() {
    console.log(`=== social snapshot (port ${PORT}) ===\n`);
    const server = await startServer(PORT);

    const tag = Math.random().toString(36).slice(2, 7);
    const mk = async (n) => {
        const b = new BotClient({ name: `S${n}_${tag}` });
        await b.connect(`ws://localhost:${PORT}`, 10000);
        await b.login(b.charName, 'warrior', false, 20000);
        await sleep(400);
        return b;
    };
    const alice = await mk('A');
    const bob = await mk('B');
    await sleep(800);
    const ra = watch(alice), rb = watch(bob);

    // --- friends -----------------------------------------------------------
    await social(alice, ra, { action: 'friend_list_request' });
    check('friend_list_request returns a list', ra.lists.length > 0,
        `payload: ${JSON.stringify(ra.lists[ra.lists.length - 1])}`);

    await social(alice, ra, { action: 'friend_add', name: bob.charName });
    check('friend_add adds an online friend',
        (ra.lists[ra.lists.length - 1] || []).some(f => f.name === bob.charName),
        `payload: ${JSON.stringify(ra.lists[ra.lists.length - 1])}`);

    // --- leaderboard -------------------------------------------------------
    ra.logs.length = 0;
    await social(alice, ra, { action: 'leaderboard_request' }, 1200);
    check('leaderboard_request returns rows', ra.leaderboards.length > 0,
        ra.leaderboards.length
            ? `${ra.leaderboards[0].length} row(s), first: ${JSON.stringify(ra.leaderboards[0][0])}`
            : 'no leaderboard_result packet');

    // The leaderboard rows are rendered by the client as {name, level, classType}.
    // Checked here rather than left to the UI, because a row with no name renders as
    // a medal beside a blank.
    if (ra.leaderboards.length && ra.leaderboards[0].length) {
        const row = ra.leaderboards[0][0];
        check('each leaderboard row carries a name',
            typeof row.name === 'string' && row.name.length > 0,
            `first row: ${JSON.stringify(row)}` +
            '   <-- the client renders this name beside the medal');
    }

    // --- emotes ------------------------------------------------------------
    rb.fct.length = 0;
    alice.send({ action: 'emote', text: '😀' });
    await sleep(800);
    check('emote broadcasts a floating text to the floor', rb.fct.length > 0,
        rb.fct.length ? `saw ${JSON.stringify(rb.fct)}` : 'the bystander saw no fct');

    // --- inspection --------------------------------------------------------
    // The player id the client would click is the id from the roster.
    const bobId = (ra.leaderboards.length ? null : null);
    void bobId;
    ra.inspects.length = 0;
    alice.send({ action: 'inspect_player', id: bob.id || bob.charName });
    await sleep(800);
    check('inspect_player returns a payload', ra.inspects.length > 0,
        ra.inspects.length ? JSON.stringify(ra.inspects[0]) : 'no inspect_player_result');
    if (ra.inspects.length) {
        check('the inspected player has a name', typeof ra.inspects[0].name === 'string' && ra.inspects[0].name.length > 0,
            `name=${JSON.stringify(ra.inspects[0].name)}` +
            '   <-- undefined means the handler reads target.name; the field is charName');
    }

    // --- guild bank --------------------------------------------------------
    // Found out by reading, then proved here: the deposit path looks the guild up
    // with `members.some(m => m === player.name)`, and the player object carries
    // `charName` and no `name`, so the comparison is against undefined and can never
    // match. Every deposit and withdrawal therefore answers "You are not in a guild".
    //
    // The first run of this check was inconclusive rather than conclusive: it created
    // no guild because the bot had no gold, then deposited and read "Not enough
    // gold" -- which is a true answer that says nothing about the guild lookup. So the
    // gold is granted first, and the guild really is created before the deposit.
    alice.send({ action: 'test_grant_gold', amount: 5000 });
    await sleep(700);
    ra.logs.length = 0; ra.guildSync.length = 0;
    alice.send({ action: 'chat', text: '/guild create TestBankers' });
    await sleep(1000);
    const inGuild = ra.guildSync.length > 0;
    check('a guild is actually created once the player can afford one', inGuild,
        `guild_sync received: ${inGuild}, logs: ${JSON.stringify(ra.logs)}`);

    ra.logs.length = 0;
    alice.send({ action: 'guild_bank_deposit', amount: 500 });
    await sleep(900);
    const depositSaid = ra.logs.find(m => /Deposited|not in a guild|Not enough/i.test(m));
    check('guild_bank_deposit reaches the guild rather than always refusing',
        !!depositSaid && /Deposited/i.test(depositSaid),
        `server said: ${JSON.stringify(depositSaid || ra.logs)}` +
        '   <-- "not in a guild" from a confirmed member means the lookup compares against player.name');

    try { server.kill(); } catch (e) { /* gone */ }
    for (const b of [alice, bob]) { try { b.disconnect(); } catch (e) { } }

    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});
