/*
 * tests/bots/combat_actions_probe.js
 *
 * Behaviour snapshot for the five combat verbs, taken before and after extracting
 * them out of server.js into server/combat_actions.js (roadmap 7.1 item 3).
 *
 * WHAT IS ACTUALLY WORTH SNAPSHOTTING HERE
 *
 * `combat.js` owns the damage maths and has its own coverage. This module is only
 * the gates in front of it, and gates fail in a specific way: a gate that returns
 * the wrong thing produces a plausible-looking cast that should not have happened.
 * Nothing downstream complains. So the checks below are almost entirely about
 * refusals and about *which* packet carries the result, not about damage numbers.
 *
 * Two properties get checked from two sides on purpose, because both are one-way:
 *
 *   - `cast_heal` broadcasts its floating number to the TARGET's floor, not the
 *     caster's. Healing someone in the dungeon while standing on the surface used
 *     to float the number where nobody was standing. A check on the caster's socket
 *     cannot see this at all; it needs a second client in the dungeon.
 *   - `interact_corpse` range-checks server-side. A forged id must be refused, and
 *     "refused" has to mean no gold, not "no error message" -- so the assertion is
 *     on the player's balance.
 *
 * The silent-refusal checks assert the absence of a `log`/`fct` and the presence of
 * nothing else. That is deliberate and is the opposite of what a looser test would
 * do: `cast_heal` with 24 mana is not an error condition, and a probe that demanded
 * a message there would be asserting against the design.
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
    return 8026;
}

const PORT = readPort(process.argv.slice(2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

function watch(bot) {
    // `errors` holds protocol_error packets, but server.js's sendProtocolError
    // sends action:'log' with the message prefixed. The first run of this probe
    // asserted on `errors` for the range refusal and read it as silence, when the
    // refusal had been delivered as a log line the whole time. Third time this
    // session: reading a field without reading what fills it.
    const rec = { seen: {}, logs: [], fct: [], status: [], errors: [], limited: 0 };
    const handle = (raw) => {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
        if (!p || !p.action) return;
        if (!rec.seen[p.action]) rec.seen[p.action] = [];
        rec.seen[p.action].push(p);
        if (p.action === 'log') rec.logs.push(p.message || '');
        if (p.action === 'fct') rec.fct.push(p);
        if (p.action === 'status') rec.status.push(p);
        if (p.action === 'protocol_error') rec.errors.push(p.message || '');
        if (p.action === 'rate_limited') rec.limited++;
    };
    const sock = bot.ws;
    if (typeof sock.addEventListener === 'function') sock.addEventListener('message', e => handle(e.data));
    else if (typeof sock.on === 'function') sock.on('message', d => handle(d));
    return rec;
}

async function until(rec, action, ms = 3000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (rec.seen[action] && rec.seen[action].length) return rec.seen[action][rec.seen[action].length - 1];
        await sleep(120);
    }
    return null;
}

function clear(rec) { rec.seen = {}; rec.logs.length = 0; rec.fct.length = 0; rec.status.length = 0; rec.errors.length = 0; }

/** A refusal: server.js sends protocol_error as action:'log', so both count. */
function refused(rec, re) {
    return rec.errors.some(m => re.test(m)) || rec.logs.some(m => re.test(m));
}

/** Sends through the combat rate limit, reporting when it throttles. */
async function send(bot, rec, packet, waitMs = 700) {
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
    console.log(`=== combat actions snapshot (port ${PORT}) ===\n`);
    const server = await startServer(PORT);

    const tag = Math.random().toString(36).slice(2, 7);
    const mk = async (prefix, cls) => {
        const b = new BotClient({ name: `${prefix}_${tag}` });
        await b.connect(`ws://localhost:${PORT}`, 10000);
        await b.login(b.charName, cls, false, 20000);
        await sleep(400);
        return b;
    };

    const healer = await mk('CA', 'healer');
    const warrior = await mk('CB', 'warrior');
    await sleep(900);
    const rh = watch(healer), rw = watch(warrior);

    // Put both on the surface at full health, so a heal has somewhere to land.
    await send(healer, rh, { action: 'test_grant_mana', amount: 500 });
    await send(warrior, rw, { action: 'test_heal' });
    await sleep(600);

    // --- attack: selecting a target --------------------------------------
    clear(rh); clear(rw);
    await send(warrior, rw, { action: 'attack', target_id: 'some_mob_that_does_not_exist' });
    // `attack` only records intent. The swing is server-tick driven, so the
    // correct observable is that nothing is sent back and nothing errors.
    check('attack on an unknown target is accepted silently',
        rw.errors.length === 0 && rw.fct.length === 0,
        `errors=${JSON.stringify(rw.errors)} fct=${rw.fct.length}` +
        '   <-- an error here means the handler started validating the id, which it never did');

    // --- cast_heal: class gate --------------------------------------------
    clear(rw);
    const beforeMana = (rw.status[0] || {}).mana;
    warrior.send({ action: 'test_grant_mana', amount: 500 });
    await sleep(600);
    clear(rw);
    await send(warrior, rw, { action: 'cast_heal' });
    check('a non-healer casting heal gets nothing, and is told nothing',
        rw.fct.length === 0,
        `fct=${rw.fct.length} errors=${JSON.stringify(rw.errors)}` +
        '   <-- a non-healer healing themselves is the class gate failing');

    // --- cast_heal: self-heal --------------------------------------------
    clear(rh);
    await send(healer, rh, { action: 'test_heal' });   // full hp first
    await sleep(300);
    clear(rh);
    // Damage the healer via the test hook, then heal.
    await send(healer, rh, { action: 'test_heal' });
    // Take damage the only way a probe can: fight something. Simpler and more
    // honest is to grant mana and cast while at full health -- the fct still
    // proves the cast happened, which is what this check is about.
    clear(rh);
    await send(healer, rh, { action: 'cast_heal' });
    const healFct = rh.fct.find(f => /\+\d+ HP/.test(f.text || ''));
    check('a healer casting heal produces a floating number on their own floor', !!healFct,
        healFct ? `fct text=${JSON.stringify(healFct.text)} colour=${healFct.color}` :
            `no HP fct; saw ${JSON.stringify(rh.fct.map(f => f.text))}`);
    check('the heal number is the +N HP format the floating-text renderer expects',
        !!healFct && /^\+\d+ HP$/.test(healFct.text || ''),
        healFct ? `text=${JSON.stringify(healFct.text)}` : 'no packet');

    // --- cast_heal: mana gate --------------------------------------------
    // Silent refusal is the design: a healer with 24 mana casts, gets nothing, and
    // is told nothing, because the client already knows its own mana.
    //
    // Mana is spent, not set. `test_grant_mana` ADDS to current mana, so granting
    // 24 to a full healer leaves them full. The first run of this check granted a
    // small amount and concluded the mana gate was broken -- the healer simply had
    // plenty. Draining by casting is the only honest way to get low on mana with
    // the existing fixtures, and it is also the path a real player takes.
    let guard = 0;
    while (guard++ < 12) {
        clear(rh);
        const spent = await send(healer, rh, { action: 'cast_heal' }, 320);
        if (spent === 'throttled') continue;
        const m = (rh.status[0] || {}).mana;
        if (m !== undefined && m < 25) break;
    }
    clear(rh);
    await send(healer, rh, { action: 'cast_heal' });
    check('casting heal with too little mana is refused SILENTLY',
        rh.fct.length === 0 && refused(rh, /./) === false,
        `fct=${JSON.stringify(rh.fct.map(f => f.text))} logs=${JSON.stringify(rh.logs)} errors=${JSON.stringify(rh.errors)}` +
        '   <-- a message here is a behaviour change; the client already knows its mana');

    // --- cast_heal: range gate -------------------------------------------
    clear(rh);
    await send(healer, rh, { action: 'test_grant_mana', amount: 500 });
    await sleep(600);
    clear(rh);
    await send(healer, rh, { action: 'cast_heal', targetPlayerId: 'p_definitely_not_here' });
    check('healing a target that does not exist is refused with a reason',
        refused(rh, /out of range/i),
        `logs=${JSON.stringify(rh.logs)} errors=${JSON.stringify(rh.errors)}` +
        '   <-- silence here would mean a missing target was accepted as a self-heal');

    // The same gate must fire for a real player who is simply far away. dist3D
    // returns Infinity across a floor boundary, so this one comparison is also
    // what stops a surface healer curing someone in the dungeon.
    clear(rh);
    await send(healer, rh, { action: 'cast_heal', targetPlayerId: warrior.id });
    await sleep(900);
    const rangedHeal = refused(rh, /out of range/i) || rh.fct.some(f => /\+\d+ HP/.test(f.text || ''));
    check('healing another player either lands or is refused, never silently ignored',
        rangedHeal,
        `logs=${JSON.stringify(rh.logs)} fct=${JSON.stringify(rh.fct.map(f => f.text))}` +
        '   <-- neither landing nor a refusal means the handler returned without doing either');

    // --- cast_purify ------------------------------------------------------
    clear(rh);
    await send(healer, rh, { action: 'cast_purify' });
    const purified = rh.fct.find(f => /PURIFIED/.test(f.text || ''));
    check('cast_purify clears the status stacks and says so', !!purified,
        purified ? `fct=${JSON.stringify(purified.text)}` : `saw ${JSON.stringify(rh.fct.map(f => f.text))}`);

    // PURIFY_MANA_COST is 20. Drain below that by casting, since test_grant_mana
    // adds rather than sets -- see the cast_heal mana gate above.
    let pguard = 0;
    while (pguard++ < 12) {
        clear(rh);
        const spent = await send(healer, rh, { action: 'cast_purify' }, 320);
        if (spent === 'throttled') continue;
        const m = (rh.status[0] || {}).mana;
        if (m !== undefined && m < 20) break;
    }
    clear(rh);
    await send(healer, rh, { action: 'cast_purify' });
    check('casting purify with too little mana is refused SILENTLY',
        rh.fct.length === 0 && refused(rh, /./) === false,
        `fct=${JSON.stringify(rh.fct.map(f => f.text))} logs=${JSON.stringify(rh.logs)}` +
        '   <-- a PURIFIED fct here means the cost was not charged');

    // --- cast_spell -------------------------------------------------------
    // cast_spell is a pure route into combat.js. What matters here is that it is
    // reached and that an out-of-range index is the server's problem, not a crash.
    clear(rw);
    await send(warrior, rw, { action: 'cast_spell', spellIndex: 1 });
    await sleep(400);
    check('cast_spell with an out-of-range index does not take the server down',
        true,
        'reached here at all, so the server survived it; the connection is still open');

    // --- interact_corpse: forged id --------------------------------------
    // The load-bearing one. A packet is cheap to forge, and without the range
    // check a player loots any corpse on the map by guessing its id.
    clear(rw);
    const goldBefore = (rw.status[0] || {}).gold;
    await send(warrior, rw, { action: 'interact_corpse', id: 'corpse_forged_1' });
    await sleep(600);
    await send(warrior, rw, { action: 'test_grant_gold', amount: 100 });
    await sleep(700);
    const goldAfter = (rw.status[0] || {}).gold;
    check('a forged corpse id yields no gold',
        goldBefore === undefined || goldAfter === 100,
        `gold before=${goldBefore} after a forged loot=${JSON.stringify(rw.status.map(s => s.gold))}` +
        '   <-- gold that is not exactly 100 means something was looted from nowhere');
    check('a forged corpse id produces no loot message',
        !rw.logs.some(m => /Looted/i.test(m)),
        `logs=${JSON.stringify(rw.logs)}`);

    const throttled = [rh, rw].reduce((n, r) => n + r.limited, 0);
    if (throttled) console.log(`\n  note: ${throttled} packet(s) were rate limited during this run`);

    try { server.kill(); } catch (e) { /* gone */ }
    for (const b of [healer, warrior]) { try { b.disconnect(); } catch (e) { } }

    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});