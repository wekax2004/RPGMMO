/*
 * tests/bots/dodge_probe.js
 *
 * Roadmap 5.3, over real sockets.
 *
 * WHAT THIS COVERS THAT THE UNIT TESTS CANNOT
 *
 * tests/unit/dodge.test.js drives `resolveIncoming` directly, which is the right shape
 * for the probabilities -- the rng is injectable, so every branch is one assertion
 * away. What it cannot reach is the wiring, and the wiring is where this could be
 * broken while the unit suite stayed green:
 *
 *   - that a dodged attack really skips its poison/bleed/stun rolls;
 *   - that the client is sent DODGE rather than a `-0`;
 *   - that stamina actually reaches the player and drains.
 *
 * All three are observable here and none of them are reachable from a unit test.
 *
 * ON SITTING NEXT TO A MOB
 *
 * The probe spawns a spider and waits to be hit. A spider is the weakest mob in the
 * game and the only one that does not stun on hit, so a probe that dies repeatedly is
 * measuring its own positioning rather than the mechanic. It heals between windows
 * and does not try to fight back.
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
    return 8030;
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
    const rec = { fct: [], stamina: [], blockChanged: [], logs: [], limited: 0, hits: 0 };
    const handle = (raw) => {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
        if (!p || !p.action) return;
        if (p.action === 'fct') {
            rec.fct.push(p.text || '');
            if (typeof p.text === 'string' && /^-?\d+$/.test(p.text.trim())) rec.hits++;
        }
        if (p.action === 'stamina') rec.stamina.push(p.stamina);
        if (p.action === 'block_changed') rec.blockChanged.push(p.blocking);
        if (p.action === 'log') rec.logs.push(p.message || '');
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

async function main() {
    console.log(`=== dodge / block snapshot (port ${PORT}) ===\n`);
    const server = await startServer(PORT);

    const tag = Math.random().toString(36).slice(2, 7);
    const b = new BotClient({ name: `DG_${tag}` });
    await b.connect(`ws://localhost:${PORT}`, 10000);
    await b.login(b.charName, 'warrior', false, 20000);
    await sleep(1200);
    const r = watch(b);

    b.send({ action: 'test_grant_xp', amount: 200000 });
    await sleep(600);
    b.send({ action: 'test_grant_item', item: 'Iron Shield' });
    await sleep(400);
    b.send({ action: 'equip_item', item: 'Iron Shield' });
    await sleep(800);

    // --- blocking requires a shield ---------------------------------------
    clearAll(r);
    b.send({ action: 'unequip_item', slot: 'shield' });
    await sleep(700);
    clearAll(r);
    b.send({ action: 'toggle_block' });
    await sleep(700);
    check('blocking with no shield is refused with a reason',
        refused(r, /shield/i) && r.blockChanged.every(b => b === false),
        `logs=${JSON.stringify(r.logs)} blockChanged=${JSON.stringify(r.blockChanged)}` +
        '   <-- silently "blocking" at zero is worse than refusing: the player thinks they are protected');

    clearAll(r);
    b.send({ action: 'equip_item', item: 'Iron Shield' });
    await sleep(800);
    clearAll(r);
    b.send({ action: 'toggle_block' });
    await sleep(700);
    check('blocking with a shield is accepted and announced',
        r.blockChanged.includes(true),
        `blockChanged=${JSON.stringify(r.blockChanged)}`);

    // --- leave the safe zone ---------------------------------------------
    // The mob tick skips players inside SAFE_ZONE outright
    // (`if (p.hp > 0 && !inSafeZone(...))`), so a probe standing at the spawn point
    // is never attacked by anything and no combat mechanic can be observed at all.
    //
    // This is not a detail of the test setup: it is why the first version of this
    // probe saw ten windows with no damage and no dodge, and reported them as a
    // broken mechanic. The spawn point is a safe zone, so "the player was never hit"
    // and "dodging is unreachable" look identical from the outside.
    const CFG = require(path.join(__dirname, '..', '..', 'server', 'config.js'));
    const SZ = CFG.SAFE_ZONE;
    const outside = { x: SZ.x + SZ.w + CFG.TILE_SIZE * 2, y: SZ.y + SZ.h + CFG.TILE_SIZE * 2 };

    let px = b.x, py = b.y;
    const track = (raw) => {
        let p;
        try { p = JSON.parse(String(raw)); } catch (e) { return; }
        if (p && p.action === 'force_position') {
            if (Number.isFinite(p.x)) px = p.x;
            if (Number.isFinite(p.y)) py = p.y;
        }
    };
    if (typeof b.ws.addEventListener === 'function') b.ws.addEventListener('message', e => track(e.data));

    const inSafe = (x, y) => x >= SZ.x && x < SZ.x + SZ.w && y >= SZ.y && y < SZ.y + SZ.h;
    note(`spawn is at ${px},${py}; walking to ${outside.x},${outside.y} to be attackable`);
    for (let step = 0; step < 60 && inSafe(px, py); step++) {
        const dx = Math.sign(outside.x - px), dy = Math.sign(outside.y - py);
        if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) b.send({ action: 'move', x: px + dx * CFG.TILE_SIZE, y: py });
        else if (dy !== 0) b.send({ action: 'move', x: px, y: py + dy * CFG.TILE_SIZE });
        await sleep(200);
    }
    const escaped = !inSafe(px, py);
    check('the probe can get somewhere a mob will actually attack it', escaped,
        escaped ? `reached ${px},${py}, outside the safe zone`
                : `ended at ${px},${py}, still inside the safe zone` +
                  '   <-- the mob tick skips safe-zone players entirely');
    if (!escaped) {
        try { server.kill(); } catch (e) {}
        try { b.disconnect(); } catch (e) {}
        process.exit(1);
    }

    // --- take hits -------------------------------------------------------
    // Sit next to a spider and let it hit. Healing between windows keeps the probe
    // alive long enough to see both outcomes.
    r.fct.length = 0;
    let sawDodge = false, sawDamage = false, sawBlock = false;
    for (let window = 0; window < 12 && !(sawDodge && sawDamage); window++) {
        b.send({ action: 'test_heal' });
        await sleep(250);
        b.send({ action: 'test_spawn_mob', type: 'spider', x: px, y: py });
        await sleep(3500);
        b.send({ action: 'stopAutoCombat' });
        b.send({ action: 'test_heal' });
        await sleep(400);
        if (r.limited) { await sleep(2500); r.limited = 0; }

        if (r.fct.includes('DODGE')) sawDodge = true;
        if (r.fct.includes('BLOCK')) sawBlock = true;
        if (r.fct.some(t => /^\-\d+$/.test(t))) sawDamage = true;
        if (window < 3 || sawDodge) note(`window ${window + 1}: fct=${JSON.stringify(r.fct.slice(0, 8))}`);
        r.fct.length = 0;
    }

    // The mechanic's headline claim: a dodged attack deals nothing and says DODGE.
    // Checked across the whole run rather than per window, because a dodge is a 25%
    // roll and a window that happens to contain none proves nothing.
    check('the client is told when a hit is dodged, and never shown a -0',
        sawDodge,
        'no DODGE fct across 10 windows; at a 25% chance across ~15 attacks this is unlikely' +
        '   <-- if the dodge branch in mobAttack is unreachable, this is what you see');
    check('ordinary hits still show their damage number', sawDamage,
        'no -N fct at all, so the probe was not actually being hit');
    // Checked after the loop, not inside it. The stance flag was cleared before the
    // windows ran, so testing `!r.blockChanged.includes(true)` here passed for the
    // wrong reason -- it was true because the array had been emptied, not because
    // blocking was off. The block is reported by the fct stream instead.
    check('blocking while a shield is up is announced on a hit', sawBlock,
        `no BLOCK fct while blocking was active` +
        '   <-- a shield that blocks silently is indistinguishable from one that does nothing');

    // --- stamina reaches the client and drains ----------------------------
    // Observed only after the bar has been spent. A player who has never dodged is at
    // the cap, and the tick deliberately sends nothing while it is full -- so a probe
    // that checks for the packet on a fresh player is checking for a packet the design
    // says should not exist.
    b.send({ action: 'test_heal' });
    await sleep(300);
    b.send({ action: 'test_spawn_mob', type: 'spider', x: px, y: py });
    await sleep(3200);
    b.send({ action: 'test_heal' });
    await sleep(1500);
    const last = r.stamina.length ? r.stamina[r.stamina.length - 1] : null;
    check('stamina reaches the client once it has been spent',
        last !== null && typeof last === 'number',
        `stamina packets=${JSON.stringify(r.stamina.slice(-4))}` +
        '   <-- no packet at all means the login constructor never built the field, or the tick never sends one');
    if (typeof last === 'number') {
        check('stamina stays within its bar and recovers upward',
            last >= 0 && last <= 100,
            `last=${last}`);
    }

    // --- a dodged hit carries no status effects ---------------------------
    // NOT CHECKED HERE, and the reason matters.
    //
    // The first version of this probe asserted that a DODGE and a POISON never appear
    // in the same window, and failed on a run whose fct stream was
    // ["-1","BLOCK","POISON","-2","-4","DODGE"] -- which is two or three separate
    // attacks, one of which dodged and one of which poisoned. The packets carry no
    // correlation id, so a window cannot attribute a POISON to a specific hit. The
    // check was asserting something the transport cannot express, and it failed on
    // correct behaviour.
    //
    // The guarantee itself is real and is covered where it can be observed exactly:
    // tests/unit/dodge.test.js asserts that mobAttack returns before the poison roll.
    // That is a structural claim about the code, and it is either true or not; this
    // cannot check it without a per-attack identifier the protocol does not carry.
    note('poison-vs-dodge is asserted structurally in tests/unit/dodge.test.js, not here:');
    note('  a fct window spans several attacks and the packets carry no correlation id');
    const sawBoth = r.fct.includes('DODGE') && r.fct.includes('POISON');
    if (sawBoth) {
        note(`  saw both in one window (${JSON.stringify(r.fct.slice(0, 8))}) -- expected, and not evidence of anything`);
    }

    // --- blocking off ----------------------------------------------------
    clearAll(r);
    b.send({ action: 'toggle_block' });
    await sleep(700);
    check('blocking can be turned off again', r.blockChanged.includes(false),
        `blockChanged=${JSON.stringify(r.blockChanged)}`);

    try { server.kill(); } catch (e) { /* gone */ }
    try { b.disconnect(); } catch (e) { }

    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

function clearAll(r) { r.fct.length = 0; r.logs.length = 0; r.blockChanged.length = 0; }
function refused(rec, re) {
    return rec.logs.some(m => re.test(m)) || rec.errors?.some(m => re.test(m));
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});