/*
 * tests/bots/friends_probe.js
 *
 * Drives the friend list over real sockets (roadmap 6.2).
 *
 * The unit tests cover the rules with a stub. This covers the two things a stub
 * cannot: that the three client actions reach the server and are answered with a
 * friends_list the client can render, and that the list survives a restart -- which
 * is the property that actually matters to a player and the one most likely to be
 * quietly broken by a field that is computed but never persisted.
 *
 * The restart half is the reason this is a probe and not another unit test. It needs
 * a real save file and a real process cycle.
 *
 * Run: node tests/bots/friends_probe.js --port=8140
 */

const { spawn } = require('child_process');
const path = require('path');

const BotClient = (() => {
    try { return require('./bot_client'); } catch (e) { return require('./bot_client.js'); }
})();

function readPort(argv) {
    const eq = argv.find(a => a.startsWith('--port='));
    if (eq) return Number(eq.split('=')[1]);
    const i = argv.indexOf('--port');
    if (i > -1 && argv[i + 1]) return Number(argv[i + 1]);
    return 8140;
}

const PORT = readPort(process.argv.slice(2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

/** Records friends_list packets, log lines and rate-limit notices. */
function watch(bot) {
    const rec = { lists: [], logs: [], limited: 0 };
    const handle = (raw) => {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
        if (p.action === 'friends_list') rec.lists.push(p.friends);
        if (p.action === 'log') rec.logs.push(p.message || '');
        if (p.action === 'rate_limited') rec.limited++;
    };
    const sock = bot.ws;
    if (typeof sock.addEventListener === 'function') sock.addEventListener('message', e => handle(e.data));
    else if (typeof sock.on === 'function') sock.on('message', d => handle(d));
    return rec;
}

/**
 * Send a friend action and wait for it to be answered, retrying through the limiter.
 *
 * Friend actions share the `social` budget: burst 6, one token every two seconds.
 * A probe that fires a dozen of them in a few seconds gets throttled, and the first
 * version of this file then asserted on silence -- reporting "removing a
 * non-friend is not refused" and "the list did not survive a restart" for a server
 * behaving exactly as designed.
 *
 * Retrying is not a workaround for a bug. It is also the reason this can assert that
 * friend actions are budgeted at all: a client that ignores rate_limited never makes
 * progress, and the probe would hang rather than quietly pass.
 */
async function sendFriend(bot, rec, packet, ms = 600, tries = 6) {
    for (let i = 0; i < tries; i++) {
        const before = { lists: rec.lists.length, limited: rec.limited };
        bot.send(packet);
        await sleep(ms);
        if (rec.limited > before.limited) {
            console.log(`    (throttled; waiting out the social budget and retrying ${packet.action})`);
            await sleep(2200);
            continue;
        }
        if (rec.lists.length > before.lists) return true;
        await sleep(300);
    }
    return false;
}

const last = (rec) => rec.lists[rec.lists.length - 1];
const names = (list) => (list || []).map(f => f.name);

async function connect(charName) {
    const bot = new BotClient({ name: charName });
    await bot.connect(`ws://localhost:${PORT}`, 10000);
    await bot.login(bot.charName, 'warrior', false, 20000);
    await sleep(400);
    return bot;
}

/**
 * Start a server on `port` and resolve once it accepts a connection.
 *
 * The probe owns the process because the restart has to be real. An earlier version
 * spawned a second server while the first still held the port: the spawn failed with
 * EADDRINUSE and died silently, and the "restarted" client connected to the ORIGINAL
 * process. The persistence check then reported an empty list and blamed persistence,
 * when what it had actually measured was a reconnect.
 */
function startServer(port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server/server.js'], {
            cwd: path.join(__dirname, '..', '..'),
            env: { ...process.env, PORT: String(port), TIBIA_TEST_MODE: 'true' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let settled = false;
        const fail = (msg) => { if (!settled) { settled = true; reject(new Error(msg)); } };
        child.on('exit', (code) => fail(`server exited with code ${code} before accepting connections`));
        child.stderr.on('data', (d) => {
            const s = String(d);
            if (/EADDRINUSE/.test(s)) fail(`port ${port} is already in use -- another server is holding it`);
        });
        const poll = setInterval(async () => {
            if (settled) { clearInterval(poll); return; }
            try {
                const probe = new BotClient({ name: `probe_${Date.now()}` });
                await probe.connect(`ws://localhost:${port}`, 1500);
                probe.disconnect();
                clearInterval(poll);
                settled = true;
                resolve(child);
            } catch (e) { /* not up yet */ }
        }, 500);
        setTimeout(() => fail('server did not start within 20s'), 20000);
    });
}

/** Stop a server and wait for the port to be released. */
function stopServer(child) {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null) return resolve();
        child.on('exit', () => setTimeout(resolve, 400));
        try { child.kill(); } catch (e) { resolve(); }
    });
}

async function main() {
    console.log(`=== friends probe (port ${PORT}) ===\n`);

    let server = await startServer(PORT);
    console.log('  (this probe started its own server, so the restart below is real)\n');

    const tag = Math.random().toString(36).slice(2, 7);
    const aliceName = `FA_${tag}`;
    const bobName = `FB_${tag}`;

    const alice = await connect(aliceName);
    const bob = await connect(bobName);
    const aliceRec = watch(alice);
    const bobRec = watch(bob);
    await sleep(600);

    // --- the request the client emits when the modal opens -----------------
    aliceRec.lists.length = 0;
    await sendFriend(alice, aliceRec, { action: 'friend_list_request' });
    check('friend_list_request is answered with a friends_list', aliceRec.lists.length > 0,
        aliceRec.lists.length ? `${aliceRec.lists.length} list packet(s)` : 'nothing came back');
    check('an empty list is a list, not an absent packet',
        aliceRec.lists.length > 0 && Array.isArray(last(aliceRec)) && last(aliceRec).length === 0,
        `payload: ${JSON.stringify(last(aliceRec))}`);

    // --- adding ------------------------------------------------------------
    aliceRec.lists.length = 0;
    await sendFriend(alice, aliceRec, { action: 'friend_add', name: bobName }, 700);
    check('adding an online friend puts them on the list',
        names(last(aliceRec)).includes(bobName),
        `payload: ${JSON.stringify(last(aliceRec))}`);
    const entry = (last(aliceRec) || []).find(f => f.name === bobName);
    check('and they are reported online', entry && entry.online === true,
        entry ? `online=${entry.online}` : 'no entry');
    check('each entry is exactly { name, online }',
        entry && Object.keys(entry).sort().join(',') === 'name,online',
        entry ? `keys: ${Object.keys(entry).join(',')}` : 'no entry');

    // --- refusals ----------------------------------------------------------
    aliceRec.lists.length = 0; aliceRec.logs.length = 0;
    await sendFriend(alice, aliceRec, { action: 'friend_add', name: bobName });
    check('a duplicate add is refused with a sentence',
        aliceRec.logs.some(m => /already/i.test(m)) && names(last(aliceRec)).length === 1,
        `logs: ${JSON.stringify(aliceRec.logs)}`);

    aliceRec.lists.length = 0; aliceRec.logs.length = 0;
    await sendFriend(alice, aliceRec, { action: 'friend_add', name: 'NoSuchPersonHere' });
    check('a nonexistent character is refused',
        aliceRec.logs.some(m => /No character/i.test(m)),
        `logs: ${JSON.stringify(aliceRec.logs)}`);

    aliceRec.lists.length = 0; aliceRec.logs.length = 0;
    await sendFriend(alice, aliceRec, { action: 'friend_add', name: '<img src=x onerror=alert(1)>' });
    check('an injection-shaped name is refused',
        aliceRec.logs.some(m => /not a character name/i.test(m)),
        `logs: ${JSON.stringify(aliceRec.logs)}`);
    check('and never reaches the payload',
        !names(last(aliceRec)).some(n => /[<>]/.test(n)),
        `payload: ${JSON.stringify(last(aliceRec))}`);

    aliceRec.lists.length = 0; aliceRec.logs.length = 0;
    await sendFriend(alice, aliceRec, { action: 'friend_add', name: aliceName });
    check('adding yourself is refused',
        aliceRec.logs.some(m => /cannot add yourself/i.test(m)),
        `logs: ${JSON.stringify(aliceRec.logs)}`);

    // --- offline friends ---------------------------------------------------
    bob.disconnect();
    await sleep(700);
    aliceRec.lists.length = 0;
    await sendFriend(alice, aliceRec, { action: 'friend_list_request' });
    const offlineEntry = (last(aliceRec) || []).find(f => f.name === bobName);
    check('a friend who logged off is still listed, as offline',
        offlineEntry && offlineEntry.online === false,
        `entry: ${JSON.stringify(offlineEntry)}`);

    // --- removing ----------------------------------------------------------
    aliceRec.lists.length = 0; aliceRec.logs.length = 0;
    await sendFriend(alice, aliceRec, { action: 'friend_remove', name: bobName });
    check('removing takes them off the list',
        last(aliceRec) && !names(last(aliceRec)).includes(bobName),
        `payload: ${JSON.stringify(last(aliceRec))}`);

    aliceRec.lists.length = 0; aliceRec.logs.length = 0;
    await sendFriend(alice, aliceRec, { action: 'friend_remove', name: bobName });
    check('removing someone who is not a friend is refused, not reported as done',
        aliceRec.logs.some(m => /not on your friend list/i.test(m)),
        `logs: ${JSON.stringify(aliceRec.logs)}`);

    // Put it back so the restart check has something to find, and confirm it landed
    // before going further. A throttled re-add leaves the list empty, and an empty
    // list is then reported downstream as a persistence failure -- the restart check
    // blames persistence for a limiter.
    const readded = await sendFriend(alice, aliceRec, { action: 'friend_add', name: bobName }, 700);
    check('the friend was added back for the restart check',
        readded && names(last(aliceRec)).includes(bobName),
        `payload: ${JSON.stringify(last(aliceRec))}`);

    // --- persistence -------------------------------------------------------
    // A real process restart: stop the server this probe started, start a new one, and
    // log in again. The list can only come back from the saved character row.
    console.log('\n  --- restart ---');
    const before = names(last(aliceRec));
    alice.disconnect();
    bob.disconnect();

    // Writes go through a serialised queue (persistence.js enqueueWrite), so a save
    // triggered microseconds before shutdown is still in flight. Poll rather than guess
    // a sleep: a fixed wait is either too short and reports a false persistence bug, or
    // long enough to slow every run.
    await sleep(2500);
    console.log('  stopping the server...');
    await stopServer(server);
    console.log('  starting a new one...');
    server = await startServer(PORT);

    let restarted = null;
    try {
        restarted = await connect(aliceName);
    } catch (e) {
        check('the server came back up', false, e.message);
    }

    if (restarted) {
        const rec = watch(restarted);
        await sleep(400);
        rec.lists.length = 0;
        await sendFriend(restarted, rec, { action: 'friend_list_request' }, 900);
        const after = names(last(rec));
        check('the friend list survived a real server restart', after.includes(bobName),
            `before: ${JSON.stringify(before)}  after: ${JSON.stringify(after)}`);
        restarted.disconnect();
    }
    await stopServer(server);

    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});
