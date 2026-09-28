/*
 * Live verification of the corpse expiry fix and the trade request cleanup.
 *
 *   1. A corpse despawns once its timer runs out, and the client is told
 *   2. The corpse Map does not grow without bound
 *   3. A corpse is still lootable while it lives
 *   4. Trade requests still resolve by sender id after the dead branch removal
 *
 * Run:  node tests/corpse_trade_live_verify.js
 */
const path = require('path');
const os = require('os');
const ServerController = require('./lib/server_controller');

const PORT = 8159;
const DB_FILE = path.join(os.tmpdir(), `tibia-corpse-${process.pid}.json`);

const TILE = 32;
const STEP_DELAY = 330;

let failures = 0;
function check(label, condition, detail) {
    const ok = !!condition;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ` -- ${detail}` : ''}`);
    return ok;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect(url) {
    const WS = require('ws');
    return new Promise((resolve, reject) => {
        const ws = new WS(url);
        const st = {
            ws, id: null, packets: [], logs: [], errors: [],
            corpses: new Map(), removed: [], mobs: new Map(),
            pos: { x: 320, y: 320 }, on: {}
        };
        st.on.packet = () => {};
        ws.on('open', () => resolve(st));
        ws.on('error', reject);
        ws.on('message', raw => {
            let p; try { p = JSON.parse(raw.toString()); } catch { return; }
            st.packets.push(p);
            if (p.action === 'your_id') st.id = p.id;
            if (p.action === 'log') st.logs.push(p.message);
            if (p.action === 'log' && /^\u274c/.test(p.message || '')) st.errors.push(p.message);
            if (p.action === 'corpse_spawn' && p.corpse) st.corpses.set(p.corpse.id, p.corpse);
            if (p.action === 'corpse_remove') { st.corpses.delete(p.id); st.removed.push(p.id); }
            if (p.action === 'mob_update' && typeof p.x === 'number') {
                if (p.alive === false) st.mobs.delete(p.id); else st.mobs.set(p.id, p);
            }
            if (p.action === 'player_update' && p.id === st.id) st.pos = { x: p.x, y: p.y };
            if (p.action === 'force_position') st.pos = { x: p.x, y: p.y };
            if (typeof st.on.packet === 'function') st.on.packet(p);
        });
    });
}

const send = (st, packet) => st.ws.send(JSON.stringify(packet));

async function login(st, name, classType, warmode = false) {
    for (let a = 0; a < 6; a++) {
        let settled = false;
        st.on.packet = p => {
            if (p.action === 'your_id') { st.id = p.id; settled = true; }
            if (p.action === 'login_error') settled = true;
        };
        send(st, { action: 'login', name, class: classType, warmode });
        for (let w = 0; w < 25 && !settled; w++) await sleep(100);
        st.on.packet = () => {};
        if (st.id) return true;
        await sleep(400);
    }
    return false;
}

async function main() {
    console.log(`\n=== CORPSE EXPIRY + TRADE CLEANUP: live verification ===\n`);
    // A short TTL keeps the test quick; the production default is 2 minutes.
    const server = new ServerController({
        port: PORT, dbFile: DB_FILE,
        env: { TIBIA_DB_DRIVER: 'sqlite', TIBIA_CORPSE_TTL_MS: '4000', TIBIA_CORPSE_SWEEP_MS: '1000' }
    });
    await server.start();

    const a = await connect(`ws://127.0.0.1:${PORT}`);
    const b = await connect(`ws://127.0.0.1:${PORT}`);
    const CFG = require(path.join(__dirname, '..', 'server', 'config.js'));

    try {
        // PvP needs BOTH players in warmode and BOTH outside the safe zone,
        // so the victim also logs in with warmode and both walk out of the city.
        check('victim logged in', await login(a, 'Dier', 'warrior', true));
        check('killer logged in', await login(b, 'Slayer', 'warrior', true));
        await sleep(1000);
        // Park them adjacent to each other, clear of the safe zone.
        const A_SPOT = { x: 736, y: 320 };
        const B_SPOT = { x: 704, y: 320 };
        await walkTo(a, A_SPOT.x, A_SPOT.y);
        await walkTo(b, B_SPOT.x, B_SPOT.y);
        const gap = Math.abs(a.pos.x - b.pos.x) + Math.abs(a.pos.y - b.pos.y);
        check('both are outside the safe zone and within melee range',
            gap <= 48 && (a.pos.x >= CFG.SAFE_ZONE.w || a.pos.y >= CFG.SAFE_ZONE.h),
            `A at ${a.pos.x},${a.pos.y}, B at ${b.pos.x},${b.pos.y}, gap=${gap}`);

        // ---------- 1. kill a player to create a corpse ----------
        console.log('\n[1] a player death creates a corpse that later despawns');
        send(b, { action: 'test_grant_xp', amount: 500000 });   // make the kill cheap
        await sleep(600);
        let guard = 0;
        while (!a.logs.some(m => /was slain/i.test(m)) && guard++ < 30) {
            // Re-close the distance each swing; the victim respawns at spawn on
            // death, so walk back if it moved.
            if (Math.abs(a.pos.x - b.pos.x) + Math.abs(a.pos.y - b.pos.y) > 48) {
                send(b, { action: 'move', x: a.pos.x, y: a.pos.y });
                await sleep(360);
            }
            send(b, { action: 'attack', target_id: a.id });
            await sleep(2100);
        }
        const slain = a.logs.some(m => /was slain/i.test(m));
        check('the victim was killed', slain, JSON.stringify(a.logs.slice(-2)));
        await sleep(600);
        check('a corpse was broadcast', a.corpses.size === 1, `corpses=${a.corpses.size}`);
        const corpse = [...a.corpses.values()][0];
        check('the corpse carries a gold drop and an expiry',
            corpse && typeof corpse.gold === 'number' && typeof corpse.expiresAt === 'number',
            corpse ? `gold=${corpse.gold}, expiresAt=${corpse.expiresAt}` : 'none');

        // ---------- 2. it despawns ----------
        console.log('\n[2] the corpse despawns once its timer runs out');
        const removedBefore = b.removed.length;
        // The TTL is 4s and the sweep every 1s, so this should be quick.
        for (let i = 0; i < 40 && b.removed.length === removedBefore; i++) await sleep(400);
        check('a corpse_remove was broadcast', b.removed.length > removedBefore,
            `removed=${JSON.stringify(b.removed)}`);
        check('the corpse is gone from both clients',
            a.corpses.size === 0 && b.corpses.size === 0,
            `A=${a.corpses.size}, B=${b.corpses.size}`);
        check('the removed id matches the corpse that was spawned',
            corpse && b.removed.includes(corpse.id), `removed=${JSON.stringify(b.removed)} spawned=${corpse && corpse.id}`);

        // ---------- 3. looting a live corpse still works ----------
        console.log('\n[3] a corpse is still lootable while it lives');
        // interact_corpse only pays out when the corpse actually holds gold, so
        // the victim needs a balance for the corpse to be worth looting.
        const c2 = await connect(`ws://127.0.0.1:${PORT}`);
        check('second victim logged in', await login(c2, 'Dier2', 'warrior', true));
        send(c2, { action: 'test_grant_gold', amount: 800 });
        await sleep(700);
        // Walk the killer back out to the new victim.
        await walkTo(b, 704, 320);
        await walkTo(c2, 736, 320);
        send(b, { action: 'test_grant_xp', amount: 500000 });
        await sleep(400);
        guard = 0;
        while (!c2.logs.some(m => /was slain/i.test(m)) && guard++ < 30) {
            if (Math.abs(c2.pos.x - b.pos.x) + Math.abs(c2.pos.y - b.pos.y) > 48) {
                send(b, { action: 'move', x: c2.pos.x, y: c2.pos.y });
                await sleep(360);
            }
            send(b, { action: 'attack', target_id: c2.id });
            await sleep(2100);
        }
        check('the second victim was killed', c2.logs.some(m => /was slain/i.test(m)),
            JSON.stringify(c2.logs.slice(-2)));
        await sleep(600);
        check('a second corpse exists', c2.corpses.size === 1, `corpses=${c2.corpses.size}`);
        const live = [...c2.corpses.values()][0];
        check('the corpse is worth looting', live && live.gold > 0,
            live ? `gold=${live.gold}` : 'none');
        if (live && live.gold > 0) {
            send(b, { action: 'interact_corpse', id: live.id });
            await sleep(700);
            check('a live corpse can still be looted',
                b.logs.some(m => /Looted \d+ gold/i.test(m)),
                JSON.stringify(b.logs.slice(-1)));
            check('the looted corpse is removed',
                c2.corpses.size === 0, `corpses=${c2.corpses.size}`);
        }
        c2.ws.close();
        await sleep(300);

        // ---------- 4. trade requests still resolve ----------
        console.log('\n[4] trade requests still resolve after the dead-branch removal');
        const t1 = await connect(`ws://127.0.0.1:${PORT}`);
        const t2 = await connect(`ws://127.0.0.1:${PORT}`);
        check('trader A logged in', await login(t1, 'TraderA', 'warrior'));
        check('trader B logged in', await login(t2, 'TraderB', 'warrior'));
        await sleep(900);
        // Put them next to each other.
        for (let i = 0; i < 3; i++) {
            send(t1, { action: 'move', x: t2.pos.x, y: t2.pos.y });
            await sleep(360);
        }
        t2.packets.length = 0;
        send(t1, { action: 'trade_request', targetName: 'TraderB' });
        await sleep(800);
        const req = t2.packets.find(p => p.action === 'trade_requested');
        check('the target received a trade request', !!req, JSON.stringify(t2.packets.map(p => p.action)));
        if (req) {
            check('the request carries an id and the sender id',
                typeof req.requestId === 'string' && typeof req.fromPlayer === 'string',
                `requestId=${req.requestId} fromPlayer=${req.fromPlayer}`);
            // Accept using the sender id, which is the path the server prefers.
            send(t2, { action: 'trade_accept', requestId: req.requestId, fromPlayer: req.fromPlayer });
            await sleep(800);
            check('the request was accepted by sender id',
                t2.packets.some(p => p.action === 'trade_started' || p.action === 'trade_update'),
                JSON.stringify(t2.packets.map(p => p.action)));
        }
        t1.ws.close(); t2.ws.close();
        await sleep(300);

    } finally {
        for (const s of [a, b]) {
            try { if (s && s.ws.readyState === 1) s.ws.close(); } catch { /* ignore */ }
        }
        try { await server.stop(true); } catch { /* ignore */ }
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
            require('fs').rmSync(DB_FILE.replace(/\.json$/, '.sqlite') + suffix, { force: true });
            require('fs').rmSync(DB_FILE + suffix, { force: true });
        }
    }
    console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===\n`);
    process.exit(failures === 0 ? 0 : 1);
}

// One TILE_SIZE per step, obeying the server's one-step rule and cooldown,
// detouring around obstacles with a committed direction.
async function walkTo(st, tx, ty) {
    const budget = Date.now() + 60000;
    let detour = 0, detourFor = 0;
    for (let i = 0; i < 220; i++) {
        const dx = tx - st.pos.x, dy = ty - st.pos.y;
        if (dx === 0 && dy === 0) return true;
        const before = `${st.pos.x},${st.pos.y}`;
        let sx = 0, sy = 0;
        if (detourFor > 0) {
            detourFor--;
            const useX = Math.abs(dx) >= Math.abs(dy);
            sx = useX ? 0 : TILE * detour;
            sy = useX ? TILE * detour : 0;
        } else {
            const useX = Math.abs(dx) >= Math.abs(dy);
            sx = useX ? TILE * Math.sign(dx) : 0;
            sy = useX ? 0 : TILE * Math.sign(dy);
        }
        send(st, { action: 'move', x: st.pos.x + sx, y: st.pos.y + sy });
        await sleep(STEP_DELAY);
        if (`${st.pos.x},${st.pos.y}` === before) {
            detour = detour === 0 ? 1 : (detour === 1 ? -1 : 0);
            detourFor = detour === 0 ? 0 : 4;
        } else if (detourFor === 0) detour = 0;
        if (Date.now() > budget) return false;
    }
    return false;
}

main().catch(err => { console.error('\nverification crashed:', err); process.exit(1); });
