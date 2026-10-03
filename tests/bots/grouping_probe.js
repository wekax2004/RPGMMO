/*
 * tests/bots/grouping_probe.js
 *
 * Behaviour snapshot for the party and trade handlers, taken before and after
 * extracting them out of server.js into server/grouping.js (roadmap 7.1 item 2).
 *
 * WHY THIS EXISTS, IN THE SAME TERMS AS social_probe.js
 *
 * The unit tests for this area are source-level: they assert that a branch exists
 * and calls the right module. That is the wrong shape for a refactor, because a
 * refactor can leave every source-level assertion satisfied while changing what a
 * player receives. So this drives every party and trade action over real sockets
 * and asserts on the packets that come back.
 *
 * There was no trade coverage at all before this. party_chat_test.js exercises the
 * party half over sockets but not trade, and nothing covered `trade_offer`,
 * `trade_remove_item`, `trade_cancel`, `party_decline`, or any of the refusal
 * paths. Those are the branches most likely to be silently broken by a move,
 * because a broken refusal still refuses -- it just refuses for the wrong reason,
 * or with no message at all.
 *
 * Every check below asserts on a packet the server actually sent. A check that
 * passes because nothing arrived is worse than no check, so each one waits for
 * something and fails if the server stayed silent.
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
    return 8025;
}

const PORT = readPort(process.argv.slice(2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

/** Every packet a grouping action can produce, recorded by action name. */
function watch(bot) {
    const rec = { seen: {}, logs: [], chats: [], errors: [], limited: 0 };
    const handle = (raw) => {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
        if (!p || !p.action) return;
        if (!rec.seen[p.action]) rec.seen[p.action] = [];
        rec.seen[p.action].push(p);
        if (p.action === 'log') rec.logs.push(p.message || '');
        // Chat arrives as action:'chat', not 'log'. Watching only 'log' is what
        // made the first run of the party-chat check report a false failure --
        // the message was delivered the whole time, under a different action name.
        if (p.action === 'chat') rec.chats.push(p);
        if (p.action === 'protocol_error') rec.errors.push(p.message || '');
        if (p.action === 'rate_limited') rec.limited++;
    };
    const sock = bot.ws;
    if (typeof sock.addEventListener === 'function') sock.addEventListener('message', e => handle(e.data));
    else if (typeof sock.on === 'function') sock.on('message', d => handle(d));
    return rec;
}

/** Waits until `rec` has seen `action`, giving up after `ms`. Returns the packet or null. */
async function until(rec, action, ms = 3000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (rec.seen[action] && rec.seen[action].length) return rec.seen[action][rec.seen[action].length - 1];
        await sleep(120);
    }
    return null;
}

function clear(rec) { rec.seen = {}; rec.logs.length = 0; rec.chats.length = 0; rec.errors.length = 0; }

/** True if any chat packet this bot received carries `text`. */
function sawChat(rec, text) {
    return rec.chats.some(p => (p.text || '') === text);
}

/** Sends through the grouping rate limit, reporting when it throttles. */
async function send(bot, rec, packet, waitMs = 800) {
    bot.send(packet);
    await sleep(waitMs);
    if (rec.limited) { await sleep(2200); return 'throttled'; }
    return 'sent';
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

async function main() {
    console.log(`=== grouping snapshot (port ${PORT}) ===\n`);
    const server = await startServer(PORT);

    const tag = Math.random().toString(36).slice(2, 7);
    const mk = async (prefix, cls) => {
        const b = new BotClient({ name: `${prefix}_${tag}` });
        await b.connect(`ws://localhost:${PORT}`, 10000);
        await b.login(b.charName, cls || 'warrior', false, 20000);
        await sleep(400);
        return b;
    };

    const alice = await mk('GA', 'warrior');
    const bob = await mk('GB', 'ranger');
    const carol = await mk('GC', 'mage');
    await sleep(900);
    const ra = watch(alice), rb = watch(bob), rc = watch(carol);

    // --- party_create ------------------------------------------------------
    clear(ra);
    alice.send({ action: 'party_create' });
    const created = await until(ra, 'party_sync');
    check('party_create answers with a party_sync', !!created,
        created ? `party id=${created.id} leader=${created.leader} members=${JSON.stringify(created.members)}`
                : 'no party_sync within 3s');
    const partyId = created ? created.id : null;

    // Creating twice must not produce a second party. A double-click on the
    // button is the normal way this arrives, and a client that got two different
    // party ids would invite into one and sync from the other.
    clear(ra);
    alice.send({ action: 'party_create' });
    await sleep(900);
    const again = (ra.seen.party_sync || [])[0];
    check('party_create twice keeps the same party', again && String(again.id) === String(partyId),
        again ? `first=${partyId} second=${again.id}` : 'no party_sync on the second create');

    // --- party_invite ------------------------------------------------------
    clear(rb);
    alice.send({ action: 'party_invite', targetName: bob.charName });
    // Both action names, deliberately: the client reads party_invite, the bots and
    // newer UI read party_invited. A move that kept only one breaks the other
    // silently -- the invite simply never appears.
    const invited = await until(rb, 'party_invited');
    const legacy = rb.seen.party_invite || [];
    check('party_invite reaches the target under both action names', !!invited && legacy.length > 0,
        `party_invited=${!!invited} party_invite=${legacy.length}`);
    check('the invite names the inviter and carries the party id',
        !!invited && invited.from === alice.charName && String(invited.partyId) === String(partyId),
        invited ? JSON.stringify({ from: invited.from, partyId: invited.partyId, fromPlayer: !!invited.fromPlayer })
                : 'no invite packet');
    check('the legacy invite carries the same party id, not just the same action name',
        legacy.length > 0 && String(legacy[0].partyId) === String(partyId),
        legacy.length ? `legacy partyId=${legacy[0].partyId} expected=${partyId}` : 'no legacy invite');

    // --- party_accept ------------------------------------------------------
    clear(rb); clear(ra);
    bob.send({ action: 'party_accept', partyId });
    const bSync = await until(rb, 'party_sync');
    check('the joiner gets a party_sync listing both members',
        !!bSync && Array.isArray(bSync.members) && bSync.members.length >= 2,
        bSync ? `members=${JSON.stringify(bSync.members)}` : 'no party_sync for the joiner');
    check('the existing member is told someone joined',
        ra.logs.some(m => /joined the party/i.test(m)),
        `logs: ${JSON.stringify(ra.logs)}`);

    // --- party chat isolation ---------------------------------------------
    // The point of a party: a message to the party channel must not reach the
    // non-member. This is the check that would catch a group chat leaking.
    clear(rc); clear(rb);
    const partyMsg = `party only ${Date.now()}`;
    alice.send({ action: 'chat', text: partyMsg, channel: 'party' });
    await sleep(900);
    const bobGot = sawChat(rb, partyMsg);
    const carolGot = sawChat(rc, partyMsg);
    check('party chat reaches the member', bobGot, `member saw it: ${bobGot}`);
    check('party chat does NOT reach a non-member', !carolGot,
        `outsider saw it: ${carolGot}` +
        '   <-- a leak here means the group chat is broadcasting as world chat');

    // --- party_leave -------------------------------------------------------
    clear(rb);
    bob.send({ action: 'party_leave' });
    await sleep(900);
    check('leaving clears the roster on the client that left',
        rb.seen.party_sync && rb.seen.party_sync.some(p => p.id === null || p.members?.length < 2),
        rb.seen.party_sync ? JSON.stringify(rb.seen.party_sync[rb.seen.party_sync.length - 1]) : 'no party_sync');

    // --- trade_request -----------------------------------------------------
    clear(rb);
    alice.send({ action: 'trade_request', targetName: bob.charName });
    const requested = await until(rb, 'trade_requested');
    check('trade_request reaches the target', !!requested,
        requested ? JSON.stringify({ requestId: requested.requestId, tradeRequestId: requested.tradeRequestId, from: requested.from })
                  : 'no trade_requested within 3s');
    // Three field names for one id, same reason as the party duplicate.
    check('the trade request carries both id spellings',
        !!requested && requested.requestId === requested.tradeRequestId && !!requested.requestId,
        requested ? `requestId=${requested.requestId} tradeRequestId=${requested.tradeRequestId}` : 'no packet');
    const requestId = requested ? requested.requestId : null;

    // --- trade_accept ------------------------------------------------------
    clear(ra); clear(rb);
    bob.send({ action: 'trade_accept', requestId });
    const openA = await until(ra, 'trade_open');
    const openB = await until(rb, 'trade_open');
    check('accepting opens the trade window for both sides', !!openA && !!openB,
        `alice=${!!openA} bob=${!!openB}` +
        (openA ? ` alice sees partner=${JSON.stringify(openA.partnerName)}` : ''));
    check('each side is told the other party\'s name',
        !!openA && !!openB && openA.partnerName === bob.charName && openB.partnerName === alice.charName,
        openA && openB ? `alice<-${openA.partnerName} bob<-${openB.partnerName}` : 'no trade_open');
    const tradeId = openA ? openA.tradeId : null;

    // --- trade_add_item / trade_offer -------------------------------------
    // Inventory entries are bare strings, not objects -- stageTradeOffer rejects
    // anything that is not a string, and validates against a count of the player's
    // own inventory. Sending `{name, count}` fails with "Invalid item", which is a
    // true answer to a malformed request and tells us nothing about the handler.
    for (let i = 0; i < 3; i++) alice.send({ action: 'test_grant_item', item: 'gold_coin' });
    alice.send({ action: 'test_grant_gold', amount: 200 });
    await sleep(1000);
    // Read the snapshot from the *sender's* socket. `myOffer` and `myGold` are
    // relative to whoever the packet went to, so Bob's copy of Alice's action has
    // Bob's (empty) offer in `myOffer` and Alice's item in `theirOffer`. An
    // earlier version of this check read Bob's packet and concluded the handler
    // staged nothing -- it had staged it correctly, in the other field.
    clear(ra); clear(rb);
    alice.send({ action: 'trade_add_item', tradeId, item: 'gold_coin' });
    const upd = await until(ra, 'trade_update');
    const updBob = (rb.seen.trade_update || [])[0];
    check('trade_add_item broadcasts a trade_update to the partner', !!updBob,
        updBob ? `bob saw a trade_update (myGold=${updBob.myGold})` : 'no trade_update reached the partner');
    check('the added item is in the sender\'s staged offer',
        !!upd && Array.isArray(upd.myOffer) && upd.myOffer.includes('gold_coin'),
        upd ? `alice myOffer=${JSON.stringify(upd.myOffer)}` : 'no trade_update');
    check('the partner sees that item as the other side\'s offer, not their own',
        !!updBob && Array.isArray(updBob.theirOffer) && updBob.theirOffer.includes('gold_coin')
            && (!updBob.myOffer || updBob.myOffer.length === 0),
        updBob ? `bob myOffer=${JSON.stringify(updBob.myOffer)} theirOffer=${JSON.stringify(updBob.theirOffer)}` : 'no packet');

    // The bulk form. One packet replaces the whole window, which is what a
    // reconnecting client needs -- and it is the branch a move is most likely to
    // break, because it shares a case with trade_add_item but takes its payload
    // from two different fields.
    clear(ra); clear(rb);
    alice.send({ action: 'trade_offer', tradeId, items: ['gold_coin', 'gold_coin'], gold: 50 });
    const bulk = await until(ra, 'trade_update');
    check('trade_offer replaces the staged state in one packet', !!bulk,
        bulk ? `myOffer=${JSON.stringify(bulk.myOffer)} myGold=${bulk.myGold}` : 'no trade_update after trade_offer');
    check('trade_offer actually carried the gold it was sent',
        !!bulk && bulk.myGold === 50,
        bulk ? `myGold=${bulk.myGold} (expected 50)` : 'no packet' +
        '   <-- if myGold is 0 here, the isBulk branch is not reading data.gold');
    check('trade_offer added every item it was sent, not just the first',
        !!bulk && Array.isArray(bulk.myOffer) && bulk.myOffer.length === 3,
        bulk ? `myOffer=${JSON.stringify(bulk.myOffer)} (expected 3 after one add plus two offered)` : 'no packet');

    // --- trade_set_gold ----------------------------------------------------
    clear(ra); clear(rb);
    alice.send({ action: 'trade_set_gold', tradeId, amount: 75 });
    const goldUpd = await until(ra, 'trade_update');
    check('trade_set_gold broadcasts the new amount to the sender',
        !!goldUpd && goldUpd.myGold === 75,
        goldUpd ? `alice myGold=${goldUpd.myGold} (expected 75)` : 'no trade_update');
    const goldBob = (rb.seen.trade_update || [])[0];
    check('the partner sees the new amount as the other side\'s gold',
        !!goldBob && goldBob.theirGold === 75,
        goldBob ? `bob theirGold=${goldBob.theirGold} myGold=${goldBob.myGold}` : 'no trade_update reached the partner');

    // --- trade_lock --------------------------------------------------------
    clear(ra); clear(rb);
    alice.send({ action: 'trade_lock', tradeId });
    const lockUpd = await until(rb, 'trade_update');
    await sleep(500);
    // trade_locked must NOT fire on the first lock. A client that treats it as
    // "the deal is sealed" would show both offers as final while the other side
    // can still change them.
    const earlyLocked = (ra.seen.trade_locked || []).length + (rb.seen.trade_locked || []).length;
    check('trade_lock syncs but does not claim the deal is sealed on the first lock',
        !!lockUpd && earlyLocked === 0,
        `trade_update=${!!lockUpd} trade_locked packets=${earlyLocked}`);

    // --- trade_cancel ------------------------------------------------------
    // Cancelling must close both windows. A close that reaches only the canceller
    // leaves the other player staring at a frozen trade they cannot exit.
    clear(ra); clear(rb);
    alice.send({ action: 'trade_cancel', tradeId });
    const closeA = await until(ra, 'trade_close');
    const closeB = await until(rb, 'trade_close');
    check('trade_cancel closes the window on both sides', !!closeA && !!closeB,
        `alice=${!!closeA} bob=${!!closeB}` +
        '   <-- a close that reaches only the canceller leaves the partner stuck');

    // --- refusals ----------------------------------------------------------
    // Each of these must produce a message. A refusal that returns silently is
    // indistinguishable from a dropped packet to the player.
    clear(ra);
    alice.send({ action: 'party_invite', targetName: 'NoSuchPlayerHere' });
    await sleep(800);
    check('inviting a player who does not exist is refused with a reason',
        ra.errors.length > 0 || ra.logs.some(m => /not found/i.test(m)),
        `errors=${JSON.stringify(ra.errors)} logs=${JSON.stringify(ra.logs)}`);

    clear(rb);
    carol.send({ action: 'party_invite', targetName: bob.charName });
    await sleep(800);
    check('inviting without a party is refused with a reason',
        rc.errors.length > 0 || rc.logs.some(m => /create a party/i.test(m)),
        `errors=${JSON.stringify(rc.errors)} logs=${JSON.stringify(rc.logs)}`);

    // A trade that does not exist. The id is the fallback path, so this also
    // proves the fallback refuses rather than silently doing nothing.
    clear(rb);
    bob.send({ action: 'trade_confirm', tradeId: 'no-such-trade' });
    await sleep(800);
    check('acting on a trade that does not exist is refused with a reason',
        rb.errors.length > 0 || rb.logs.some(m => /not found|no such|does not exist/i.test(m)),
        `errors=${JSON.stringify(rb.errors)} logs=${JSON.stringify(rb.logs)}`);

    // --- non-participant cancel -------------------------------------------
    // carol was never in this trade. If the participant check were dropped, this
    // would close somebody else's deal.
    //
    // The trade must be live for this to mean anything. An earlier version reused
    // the id of the trade cancelled just above, so there was no trade left to
    // cancel -- the handler correctly did nothing and said nothing, and the check
    // read as a missing refusal message rather than a missing guard.
    alice.send({ action: 'trade_request', targetName: bob.charName });
    await sleep(1000);
    clear(rb);
    bob.send({ action: 'trade_accept', requestId: (rb.seen.trade_requested || [])[0]?.requestId });
    const liveOpen = await until(ra, 'trade_open');
    const liveTradeId = liveOpen ? liveOpen.tradeId : null;
    check('a second trade was opened, so the cancel below has something to act on',
        !!liveTradeId,
        liveTradeId ? `tradeId=${liveTradeId}` : 'could not open a live trade');

    clear(ra); clear(rb); clear(rc);
    carol.send({ action: 'trade_cancel', tradeId: liveTradeId });
    await sleep(900);
    const aliceClosed = (ra.seen.trade_close || []).length > 0;
    const bobClosed = (rb.seen.trade_close || []).length > 0;
    check('a non-participant cannot cancel somebody else\'s trade',
        !!liveTradeId && !aliceClosed && !bobClosed,
        `alice saw trade_close=${aliceClosed} bob saw trade_close=${bobClosed}` +
        '   <-- a close here means the participant check was lost');
    // Only asserted when there was a live trade to act on. Without one, the
    // handler has nothing to refuse and silence is the correct answer.
    if (liveTradeId) {
        check('a non-participant is told why it did nothing',
            rc.errors.length > 0 || rc.logs.some(m => /not a participant/i.test(m)),
            `errors=${JSON.stringify(rc.errors)} logs=${JSON.stringify(rc.logs)}`);
    }

    const throttled = [ra, rb, rc].reduce((n, r) => n + r.limited, 0);
    if (throttled) console.log(`\n  note: ${throttled} packet(s) were rate limited during this run`);

    try { server.kill(); } catch (e) { /* gone */ }
    for (const b of [alice, bob, carol]) { try { b.disconnect(); } catch (e) { } }

    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});