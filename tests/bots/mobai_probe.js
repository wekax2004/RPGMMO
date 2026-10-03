/*
 * tests/bots/mobai_probe.js
 *
 * Roadmap 5.2 over real sockets: patrol, flee, call for help.
 *
 * WHY A SOCKET PROBE, WHEN THE UNIT TESTS CALL `decide` DIRECTLY
 *
 * `decide` returning 'patrol' proves the brain works. It does not prove a mob moves,
 * because the tick has to call `patrolStep`, and `patrolStep` has to find a walkable
 * tile, and the move has to be broadcast. Every one of those is a separate link and
 * all three were new.
 *
 * The patrol check is the sharpest one available: before this feature a mob with no
 * player nearby never moved at all. So "did this mob move while nobody was near it" is
 * a question with a definite previous answer of NO, which makes it a real before/after
 * rather than a check that would pass either way.
 *
 * Mobs are watched from OUTSIDE the safe zone, for the same reason as every other
 * probe in this repo: the tick skips safe-zone players, so a probe standing at the
 * spawn point is never attacked by anything and no combat behaviour can be observed.
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
    return 8033;
}

const PORT = readPort(process.argv.slice(2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}
function note(text) { console.log(`          ${text}`); }

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
    console.log(`=== mob AI snapshot (port ${PORT}) ===\n`);
    const server = await startServer(PORT);

    const tag = Math.random().toString(36).slice(2, 7);
    const b = new BotClient({ name: `MA_${tag}` });
    await b.connect(`ws://localhost:${PORT}`, 10000);
    await b.login(b.charName, 'warrior', false, 20000);

    // Track mob positions from the packet stream, plus our own.
    const mobs = {};
    const fct = [];
    let x = null, y = null;
    const sock = b.ws;
    if (typeof sock.addEventListener === 'function') {
        sock.addEventListener('message', (e) => {
            let p;
            try { p = JSON.parse(String(e.data)); } catch (err) { return; }
            if (!p || !p.action) return;
            if (p.action === 'mob_update' && p.id) {
                if (!mobs[p.id]) mobs[p.id] = [];
                mobs[p.id].push({ x: p.x, y: p.y, hp: p.hp, alive: p.alive, type: p.type, z: p.z });
            }
            if (p.action === 'fct') fct.push(p.text || '');
            if (p.action === 'force_position') {
                if (Number.isFinite(p.x)) x = p.x;
                if (Number.isFinite(p.y)) y = p.y;
            }
        });
    }
    await sleep(1200);
    if (x === null) { x = b.x; y = b.y; }

    const CFG = require(path.join(__dirname, '..', '..', 'server', 'config.js'));
    const SZ = CFG.SAFE_ZONE;

    const inSafe = (px, py) => px >= SZ.x && px < SZ.x + SZ.w && py >= SZ.y && py < SZ.y + SZ.h;

    // Leave the safe zone FIRST, before spawning anything.
    //
    // Two reasons, and the first run of this probe hit both. `tryStep` refuses to
    // move a mob into the safe zone -- correctly, that is how the city stays safe --
    // so a mob spawned at the spawn point is permanently immobile and reads as "the
    // patrol branch never runs". And the tick skips safe-zone players, so nothing
    // would ever target it either. The two rules together mean: nothing interesting
    // can be observed from inside the city.
    for (let s = 0; s < 60 && inSafe(x, y); s++) {
        const dx = Math.sign(SZ.x + SZ.w + CFG.TILE_SIZE * 3 - x);
        const dy = Math.sign(SZ.y + SZ.h + CFG.TILE_SIZE * 3 - y);
        if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) b.send({ action: 'move', x: x + dx * CFG.TILE_SIZE, y });
        else if (dy !== 0) b.send({ action: 'move', x, y: y + dy * CFG.TILE_SIZE });
        await sleep(190);
    }
    check('reached somewhere mobs can behave', !inSafe(x, y),
        inSafe(x, y) ? `still at ${x},${y}` : `at ${x},${y}, outside the safe zone`);

    // --- patrol: nobody nearby, does the mob move? -------------------------
    // The sharpest check available. Before this feature a mob with no target stood
    // still forever, so "did it move" has a known previous answer of NO.
    b.send({ action: 'test_spawn_mob', type: 'skeleton', x, y });
    await sleep(1200);
    const ids = Object.keys(mobs);
    if (!ids.length) {
        check('a spawned mob is visible at all', false, 'no mob_update arrived');
    } else {
        const id = ids[ids.length - 1];
        const start = mobs[id][mobs[id].length - 1];
        note(`mob ${id} spawned at ${start.x},${start.y}; walking away so it has no target`);

        // Far enough that the mob genuinely has no target for the window.
        //
        // Stepped off `x`, which is tracked from force_position -- NOT off b.x, which
        // updates on the roster tick and lags. The first version sent
        // `move x + 3 tiles` forty times from a stale x, so the player never actually
        // moved and the mob kept a target; the probe then reported "walked 0 tiles"
        // and read a mob correctly standing next to its target as a patrol failure.
        const walkTo = async (tx, ty) => {
            for (let guard = 0; guard < 60; guard++) {
                if (Math.abs(x - tx) <= CFG.TILE_SIZE && Math.abs(y - ty) <= CFG.TILE_SIZE) return true;
                const dx = Math.sign(tx - x), dy = Math.sign(ty - y);
                if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) b.send({ action: 'move', x: x + dx * CFG.TILE_SIZE, y });
                else if (dy !== 0) b.send({ action: 'move', x, y: y + dy * CFG.TILE_SIZE });
                await sleep(190);
            }
            return false;
        };
        await walkTo(start.x + CFG.TILE_SIZE * 8, start.y);
        const seen = mobs[id].length;
        const gap = Math.abs(x - start.x) + Math.abs(y - start.y);
        await sleep(6000);
        const trail = mobs[id].slice(seen);
        const moved = trail.some(s => s.x !== start.x || s.y !== start.y);
        check('a mob with no player nearby wanders instead of standing still', moved,
            moved ? `mob moved to ${trail[trail.length - 1].x},${trail[trail.length - 1].y} (spawned ${start.x},${start.y}) over ${trail.length} updates`
                  : `mob stayed at ${start.x},${start.y} for 6s while the player walked ${gap} tiles away` +
            '   <-- no movement means the tick never reaches the patrol branch');
    }

    // --- call for help: spawn two of a kind, hurt one, does the other move? --
    b.send({ action: 'test_grant_xp', amount: 300000 });
    await sleep(600);
    b.send({ action: 'test_grant_item', item: 'Iron Sword' });
    await sleep(400);
    b.send({ action: 'equip_item', item: 'Iron Sword' });
    await sleep(700);

    // Spawned together and both watched, so the helper's position is known before any
    // damage lands.
    b.send({ action: 'test_spawn_mob', type: 'spider', x, y });
    await sleep(900);
    b.send({ action: 'test_spawn_mob', type: 'spider', x: x + CFG.TILE_SIZE, y });
    await sleep(1400);
    note('two spiders spawned side by side');

    const spiders = Object.keys(mobs).filter(id => {
        const last = mobs[id][mobs[id].length - 1];
        return last && last.type === 'spider';
    });
    if (spiders.length < 2) {
        check('two same-type mobs were available to test the call', false,
            `only saw ${spiders.length} spider(s)`);
    } else {
        const victim = spiders[spiders.length - 1];
        const helper = spiders[spiders.length - 2];
        const helperStart = { ...mobs[helper][mobs[helper].length - 1] };
        const helperSeen = mobs[helper].length;

        // The call is a 70% roll behind a 3s cooldown, so ONE hit is not evidence of
        // anything -- the first run of this probe failed on exactly that and read a
        // single miss as "the call never reaches the damage path". Hit across several
        // cooldown windows so at least one gets through, and keep the player alive
        // while doing it.
        for (let round = 0; round < 8 && !fct.includes('CALLING HELP'); round++) {
            b.send({ action: 'attack', target_id: victim });
            await sleep(700);
            b.send({ action: 'test_heal' });
            await sleep(600);
            if (b.constructor && false) { /* no-op: keeps the loop shape obvious */ }
        }
        const trail = mobs[helper].slice(helperSeen);
        const closed = trail.some(s =>
            Math.abs(s.x - helperStart.x) + Math.abs(s.y - helperStart.y) > 0);
        check('hitting one mob of a pair rouses the other',
            fct.includes('CALLING HELP') || closed,
            fct.includes('CALLING HELP')
                ? `saw CALLING HELP; helper moved from ${helperStart.x},${helperStart.y}`
                : `no CALLING HELP over 8 rounds; helper stayed at ${helperStart.x},${helperStart.y}` +
            '   <-- no announcement and no movement means the call never reaches the damage path');
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