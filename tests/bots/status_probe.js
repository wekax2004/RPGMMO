/*
 * tests/bots/status_probe.js
 *
 * Roadmap 3.5 (spell cooldown packet) and 5.4 (other players' status effects),
 * over real sockets.
 *
 * Both of these are roster/packet shapes, and both have the same property that makes
 * them worth a socket test rather than a source test: the client code that consumes
 * them ALREADY EXISTS and reads fields the server was not sending.
 *
 *   - renderer.js draws poison, bleed and stun markers off OTHER players, from
 *     `op.poison`, `op.bleed`, `op.stun`. Until the roster carried them, a poisoned
 *     opponent looked completely healthy to everyone watching the fight.
 *   - the hotbar has no cooldown overlay, because there was nothing to drive one
 *     from. A basic spell on cooldown returned from the server with no packet at
 *     all -- no message, nothing -- so pressing the key did nothing visible.
 *
 * Both are checked by asking a second client what it can see about the first. That
 * is the only way to know the fields are on the wire, since a source-level assertion
 * would pass on a field that is written and never sent.
 *
 * The bystander matters: an observer watching a fight is the case both features are
 * for, and a test that only looks at the affected player's own socket proves neither.
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
    return 8031;
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
    const rec = { rosters: [], cooldowns: [], fct: [], limited: 0 };
    const handle = (raw) => {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
        if (!p || !p.action) return;
        if (p.action === 'players_sync') rec.rosters.push(p.players || []);
        if (p.action === 'spell_cooldown') rec.cooldowns.push(p);
        if (p.action === 'fct') rec.fct.push(p.text || '');
        if (p.action === 'rate_limited') rec.limited++;
    };
    const sock = bot.ws;
    if (typeof sock.addEventListener === 'function') sock.addEventListener('message', e => handle(e.data));
    else if (typeof sock.on === 'function') sock.on('message', d => handle(d));
    return rec;
}

/** The bystander's most recent view of `charName`, or null. */
function seenAsObserver(observer, charName) {
    for (let i = observer.rosters.length - 1; i >= 0; i--) {
        const hit = (observer.rosters[i] || []).find(p => p && p.name === charName);
        if (hit) return hit;
    }
    return null;
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
    console.log(`=== status + cooldown snapshot (port ${PORT}) ===\n`);
    const server = await startServer(PORT);

    const tag = Math.random().toString(36).slice(2, 7);
    const mk = async (prefix, cls) => {
        const b = new BotClient({ name: `${prefix}_${tag}` });
        await b.connect(`ws://localhost:${PORT}`, 10000);
        await b.login(b.charName, cls, false, 20000);
        await sleep(400);
        return b;
    };

    const caster = await mk('SC', 'mage');     // casts spells
    const victim = await mk('SV', 'warrior');   // gets poisoned
    const watcher = await mk('SW', 'ranger');   // the bystander

    // Watch BEFORE waiting for the roster. The first version attached the watcher
    // after a 2.5s sleep and then asserted the roster was populated, which it was --
    // but the watcher had missed every roster tick that had already fired, so it only
    // ever saw rosters that arrived afterwards. At 200ms intervals that is a real race
    // and it failed the first run with an empty list.
    const rc = watch(caster), rv = watch(victim), rw = watch(watcher);

    // Wait for a roster that actually contains the caster rather than sleeping and
    // hoping. Three clients all spawn on the same tile, so this is normally immediate.
    let seesCaster = false;
    for (let i = 0; i < 40 && !seesCaster; i++) {
        await sleep(200);
        seesCaster = !!seenAsObserver(rw, caster.charName);
    }
    check('the bystander can see the caster at all', seesCaster,
        seesCaster ? 'roster carries both'
                    : `after 8s the roster still had ${JSON.stringify((rw.rosters[rw.rosters.length - 1] || []).map(p => p && p.name))}` +
        '   <-- three clients on the same tile should always see each other');
    if (!seesCaster) {
        try { server.kill(); } catch (e) {}
        process.exit(1);
    }

    // --- 5.4: status effects are on the wire ------------------------------
    const before = seenAsObserver(rw, victim.charName);
    const fieldsPresent = before
        && 'poison' in before && 'bleed' in before && 'stun' in before;
    check('the roster carries poison, bleed and stun for other players', fieldsPresent,
        before ? `keys seen: ${JSON.stringify(Object.keys(before))}`
               : 'victim not in the bystander roster');

    if (fieldsPresent) {
        check('an unpoisoned player reads as zero, not as a missing field',
            before.poison === 0 && before.bleed === 0 && before.stun === false,
            `poison=${before.poison} bleed=${before.bleed} stun=${before.stun}` +
            '   <-- undefined here makes `op.poison > 0` false by luck, and any other consumer wrong');

        // Now actually poison them, from a mob, and watch the bystander see it.
        const CFG = require(path.join(__dirname, '..', '..', 'server', 'config.js'));
        const SZ = CFG.SAFE_ZONE;
        let vx = victim.x, vy = victim.y;
        const track = (raw) => {
            let p;
            try { p = JSON.parse(String(raw)); } catch (e) { return; }
            if (p && p.action === 'force_position') {
                if (Number.isFinite(p.x)) vx = p.x;
                if (Number.isFinite(p.y)) vy = p.y;
            }
        };
        if (typeof victim.ws.addEventListener === 'function') victim.ws.addEventListener('message', e => track(e.data));

        const inSafe = (x, y) => x >= SZ.x && x < SZ.x + SZ.w && y >= SZ.y && y < SZ.y + SZ.h;
        for (let s = 0; s < 60 && inSafe(vx, vy); s++) {
            const dx = Math.sign(SZ.x + SZ.w + CFG.TILE_SIZE * 2 - vx);
            const dy = Math.sign(SZ.y + SZ.h + CFG.TILE_SIZE * 2 - vy);
            if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) victim.send({ action: 'move', x: vx + dx * CFG.TILE_SIZE, y: vy });
            else if (dy !== 0) victim.send({ action: 'move', x: vx, y: vy + dy * CFG.TILE_SIZE });
            await sleep(190);
        }
        note(`victim walked to ${vx},${vy} so a mob will actually target it`);

        // Spiders are the poison mob. Keep them coming until the bystander sees it.
        let observedPoison = false;
        for (let i = 0; i < 14 && !observedPoison; i++) {
            watcher.send({ action: 'move', x: vx, y: vy });
            victim.send({ action: 'test_spawn_mob', type: 'spider', x: vx, y: vy });
            await sleep(2200);
            victim.send({ action: 'test_heal' });
            if (rw.limited) { await sleep(2500); rw.limited = 0; }
            const seen = seenAsObserver(rw, victim.charName);
            if (seen && seen.poison > 0) observedPoison = true;
        }
        const poisoned = seenAsObserver(rw, victim.charName);
        check('a bystander sees another player\'s poison stacks', observedPoison,
            poisoned ? `observer sees poison=${poisoned.poison}`
                      : `after 14 spider hits the observer still sees poison=${poisoned && poisoned.poison}` +
            '   <-- the field is missing from the roster, or the mob never landed');
        note(`observer's view: ${JSON.stringify(poisoned && {
            poison: poisoned.poison, bleed: poisoned.bleed, stun: poisoned.stun
        })}`);
    }

    // --- 3.5: spell cooldown is on the wire ------------------------------
    // Both the success and the refusal, because the refusal is the case that was
    // silent and is the one a player actually notices.
    caster.send({ action: 'test_grant_mana', amount: 500 });
    await sleep(800);
    rc.cooldowns.length = 0;
    caster.send({ action: 'cast_spell', spellIndex: 1 });
    await sleep(900);
    const afterCast = rc.cooldowns[rc.cooldowns.length - 1] || null;
    check('casting a spell reports when that slot is next usable', !!afterCast,
        `cooldown packets: ${JSON.stringify(rc.cooldowns)}` +
        '   <-- no packet means the hotbar has nothing to drive a countdown from');
    if (afterCast) {
        check('the cooldown packet names the slot it applies to',
            afterCast.spellIndex === 1,
            `spellIndex=${afterCast.spellIndex} (expected 1)`);
        check('the cooldown is a forward-dated absolute time, not a duration',
            typeof afterCast.readyAt === 'number' && afterCast.readyAt > Date.now(),
            `readyAt=${afterCast.readyAt} remainingMs=${afterCast.remainingMs}` +
            '   <-- a countdown that restarts on every packet is wrong across a dropped one');
        check('the reported remaining time is positive but bounded',
            afterCast.remainingMs > 0 && afterCast.remainingMs <= 1000,
            `remainingMs=${afterCast.remainingMs}`);
    }

    // Immediately again: this used to be a bare `return;` with nothing sent.
    rc.cooldowns.length = 0;
    caster.send({ action: 'cast_spell', spellIndex: 1 });
    await sleep(500);
    const onCooldown = rc.cooldowns[rc.cooldowns.length - 1] || null;
    check('casting a spell that is still on cooldown answers with the remaining time', !!onCooldown,
        `cooldown packets: ${JSON.stringify(rc.cooldowns)}` +
        '   <-- a silent refusal means pressing the key does nothing the player can see');
    if (onCooldown && afterCast) {
        check('the refusal reports a later ready time than the cast did, or the same one still in the future',
            typeof onCooldown.readyAt === 'number' && onCooldown.readyAt >= afterCast.readyAt - 50,
            `cast readyAt=${afterCast.readyAt} refusal readyAt=${onCooldown.readyAt}`);
    }

    // --- the epic slot ----------------------------------------------------
    rc.cooldowns.length = 0;
    caster.send({ action: 'cast_spell', spellIndex: 3 });
    await sleep(900);
    const epic = rc.cooldowns[rc.cooldowns.length - 1] || null;
    check('the epic slot reports its own, much longer, cooldown',
        epic && epic.spellIndex === 3 && epic.remainingMs > 1000,
        epic ? `spellIndex=${epic.spellIndex} remainingMs=${epic.remainingMs}`
             : `cooldown packets: ${JSON.stringify(rc.cooldowns)}` +
        '   <-- the epic cooldown is 6s; a value near 1000 means slot 3 is sharing the cheap spell cooldown');

    try { server.kill(); } catch (e) { /* gone */ }
    for (const b of [caster, victim, watcher]) { try { b.disconnect(); } catch (e) { } }

    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});