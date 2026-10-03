/*
 * tests/bots/combo_probe.js
 *
 * Roadmap 5.1 over real sockets.
 *
 * The unit tests drive `registerHit` directly, which proves the counting rules. What
 * they cannot prove is that the count is ANNOUNCED, or that the paths which should
 * count are the paths that do. Both are wiring facts, and both have been wrong before:
 * a combo registered after the kill resolves would leave every chain one hit short,
 * and no unit test can see ordering that happens across a function boundary.
 *
 * So this drives a real fight: spawn a mob, hit it repeatedly on one target, and read
 * the `combo` packets off the wire. Then switch target and check the chain breaks --
 * because a combo that counts target-switching is not a weaker feature, it is a
 * different and much cheaper one.
 *
 * A note on hitting reliably. The `attack` action only records the target; the server
 * tick lands the damage. A mob spawned on the player's own tile dies to the player's
 * own tick before auto-combat selects anything, so auto-combat is no use here. Each
 * hit is an explicit `attack` followed by a wait long enough for several ticks.
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
    return 8032;
}

const PORT = readPort(process.argv.slice(2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}
function note(text) { console.log(`          ${text}`); }

function watch(bot) {
    const rec = { combos: [], fct: [], mobs: {}, status: [], limited: 0, kills: 0 };
    const handle = (raw) => {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
        if (!p || !p.action) return;
        if (p.action === 'combo') rec.combos.push(p);
        if (p.action === 'fct') {
            rec.fct.push(p.text || '');
            if (/\+\d+ XP/.test(p.text || '')) rec.kills++;
        }
        if (p.action === 'mob_update' && p.id) {
            if (!rec.mobs[p.id]) rec.mobs[p.id] = [];
            rec.mobs[p.id].push(p);
        }
        if (p.action === 'status') rec.status.push(p);
        if (p.action === 'rate_limited') rec.limited++;
    };
    const sock = bot.ws;
    if (typeof sock.addEventListener === 'function') sock.addEventListener('message', e => handle(e.data));
    else if (typeof sock.on === 'function') sock.on('message', d => handle(d));
    return rec;
}

const liveMobsOn = (rec, floor) => Object.keys(rec.mobs).filter(id => {
    const last = rec.mobs[id][rec.mobs[id].length - 1];
    return last && last.z === floor && last.alive !== false;
});

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
    console.log(`=== combo snapshot (port ${PORT}) ===\n`);
    const server = await startServer(PORT);

    const tag = Math.random().toString(36).slice(2, 7);
    const b = new BotClient({ name: `CB_${tag}` });
    await b.connect(`ws://localhost:${PORT}`, 10000);
    await b.login(b.charName, 'warrior', false, 20000);
    const r = watch(b);

    const CFG = require(path.join(__dirname, '..', '..', 'server', 'config.js'));
    const SZ = CFG.SAFE_ZONE;

    // Own position, from force_position. BotClient tracks x/y from the per-floor
    // players_sync, which lags a move by up to a tick, and a step loop that reads it
    // immediately can oscillate.
    let x = null, y = null, floor = 0;
    if (typeof b.ws.addEventListener === 'function') {
        b.ws.addEventListener('message', (e) => {
            let p;
            try { p = JSON.parse(String(e.data)); } catch (err) { return; }
            if (p && p.action === 'force_position') {
                if (Number.isFinite(p.x)) x = p.x;
                if (Number.isFinite(p.y)) y = p.y;
                if (Number.isFinite(p.z)) floor = p.z;
            }
        });
    }
    await sleep(900);
    if (x === null) { x = b.x; y = b.y; }

    // Leave the safe zone, or no mob will ever target us and nothing can be measured.
    const inSafe = (px, py) => px >= SZ.x && px < SZ.x + SZ.w && py >= SZ.y && py < SZ.y + SZ.h;
    const outside = { x: SZ.x + SZ.w + CFG.TILE_SIZE * 2, y: SZ.y + SZ.h + CFG.TILE_SIZE * 2 };
    for (let s = 0; s < 60 && inSafe(x, y); s++) {
        const dx = Math.sign(outside.x - x), dy = Math.sign(outside.y - y);
        if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) b.send({ action: 'move', x: x + dx * CFG.TILE_SIZE, y });
        else if (dy !== 0) b.send({ action: 'move', x, y: y + dy * CFG.TILE_SIZE });
        await sleep(190);
    }
    check('reached somewhere a mob will engage', !inSafe(x, y),
        inSafe(x, y) ? `still at ${x},${y} inside the safe zone` : `at ${x},${y}`);
    if (inSafe(x, y)) {
        try { server.kill(); } catch (e) {}
        process.exit(1);
    }

    b.send({ action: 'test_grant_xp', amount: 300000 });
    await sleep(600);
    // Deliberately the starter sword, not the War Cleaver.
    //
    // Two earlier versions equipped the legendary this repo just added, because a
    // probe that dies in one round cannot see anything. With +44 it one-shots a bear
    // AND a yeti, so every mob died to the first hit and there was never a second
    // hit to announce. The probe read that as "the combo is broken".
    //
    // The right trade is a strong enough player to survive, not a strong enough
    // weapon to one-shot the test subject. XP handles the first; a weak weapon
    // deliberately handles the second.
    b.send({ action: 'test_grant_item', item: 'Iron Sword' });
    await sleep(400);
    b.send({ action: 'equip_item', item: 'Iron Sword' });
    await sleep(800);

    /** Spawns one mob, attacks it repeatedly, and returns how many hits landed. */
    const fightOne = async (label) => {
        const before = r.kills;
        // Yeti, not bear. The probe equips the War Cleaver (bonus 44) so it survives
        // a fight at all, and that one-shots a bear outright -- so a bear gives a
        // single hit, and a single hit is not a combo. The first run of this probe
        // read that as "the combo is never announced", when in fact there was never
        // a second hit to announce. Yeti is the tankiest non-boss in the roster.
        b.send({ action: 'test_spawn_mob', type: 'yeti', x, y });
        await sleep(800);
        const ids = liveMobsOn(r, floor);
        if (!ids.length) return { landed: 0, id: null };
        const id = ids[ids.length - 1];
        b.send({ action: 'attack', target_id: id });
        // Keep re-sending: the tick needs the player to still be targeting the mob,
        // and a yeti out-damages the player if it is left alone for too long.
        for (let i = 0; i < 14 && r.kills === before; i++) {
            await sleep(300);
            b.send({ action: 'test_heal' });
            const stillThere = liveMobsOn(r, floor).some(m => m === id);
            if (!stillThere) break;
            b.send({ action: 'attack', target_id: id });
        }
        if (r.limited) { await sleep(2500); r.limited = 0; }
        return { landed: r.kills - before, id };
    };

    // --- one target: the combo should climb -------------------------------
    r.combos.length = 0;
    const first = await fightOne('mob one');
    note(`first mob: ${first.landed} kill(s), combo packets: ${JSON.stringify(r.combos)}`);
    check('landing several hits on one target announces a combo', r.combos.length > 0,
        `combo packets: ${JSON.stringify(r.combos)}` +
        '   <-- no packet means the count is computed and never sent, or the paths that should count do not');

    if (r.combos.length) {
        const hits = r.combos.map(c => c.hits);
        check('the announced counts increase monotonically',
            hits.every((h, i) => i === 0 || h >= hits[i - 1]),
            `counts: ${JSON.stringify(hits)}`);
        check('no combo is announced below the threshold',
            hits.every(h => h >= 2),
            `counts: ${JSON.stringify(hits)}   <-- a 1x announcement flashes the meter for nothing`);
        check('the last hit of a chain still counts',
            Math.max(...hits) >= 2,
            `counts: ${JSON.stringify(hits)}` +
            '   <-- one short of the real number means the combo is registered after the kill resolves');
        check('every combo packet names the target it applies to',
            r.combos.every(c => typeof c.targetId === 'string' && c.targetId.length > 0),
            JSON.stringify(r.combos.slice(0, 3)));
    }

    // --- a different target: the chain must break -------------------------
    // The most important property. A combo that counts target-switching rewards
    // exactly the behaviour a combo exists to discourage.
    const countBeforeSwitch = Math.max(0, ...r.combos.map(c => c.hits));
    r.combos.length = 0;
    const second = await fightOne('mob two');
    note(`second mob: ${second.landed} kill(s), combo packets: ${JSON.stringify(r.combos)}`);
    const afterSwitch = r.combos.map(c => c.hits);
    check('switching target restarts the combo rather than continuing it',
        afterSwitch.length === 0 || Math.min(...afterSwitch) <= countBeforeSwitch + 1,
        `before=${countBeforeSwitch} after switching target=${JSON.stringify(afterSwitch)}` +
        '   <-- counts climbing straight through a target change means the switch is not breaking the chain');

    // --- the meter is not permanent ----------------------------------------
    // The client owns the fade-out, so the server must not keep sending the count
    // once a chain is over. A repeated identical announcement means something is
    // re-firing on a tick rather than on a hit.
    const counts = r.combos.map(c => c.hits).join(',');
    check('the server is not re-announcing an unchanged count on a tick',
        r.combos.length === 0 || counts.split(',').length <= r.kills + 2,
        `announcements=${counts || '(none)'} real kills=${r.kills}` +
        '   <-- many more announcements than hits means a tick is driving it');

    // If the run produced no combo at all, say so plainly rather than letting the
    // switch-target check above pass on empty input. A check that reads "[] <= 2"
    // and reports success is exactly the kind that makes a broken feature look green.
    if (r.combos.length === 0) {
        check('the probe actually landed multi-hit fights', false,
            `only ${r.kills} kill(s) and no combo packets, so the switch-target check ` +
            'above passed on empty input rather than on behaviour');
    } else {
        check('the probe landed multi-hit fights', true, `${r.kills} kills, ${r.combos.length} combo announcements`);
    }

    try { server.kill(); } catch (e) { /* gone */ }
    try { b.disconnect(); } catch (e) { }

    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});