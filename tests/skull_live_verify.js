/*
 * Live end-to-end verification of the white skull system and the guild
 * persistence fix.
 *
 * Proves, against a real server over WebSockets:
 *   1. attacking an unskulled player marks the aggressor
 *   2. players_sync carries the skull state for the client to render
 *   3. a skull survives logout/login (the field-drift trap)
 *   4. guild membership survives logout/login (the bug that was found)
 *   5. a skulled player drops more gold on death than a clean one
 *
 * Run:  node tests/skull_live_verify.js
 */
const path = require('path');
const os = require('os');
const ServerController = require('./lib/server_controller');

const PORT = 8155;
const DB_FILE = path.join(os.tmpdir(), `tibia-skull-live-${process.pid}.json`);

const TILE = 32;
const STEP_DELAY = 330;          // move cooldown at level 1 is ~297ms
// Park both players outside the safe zone (x > 640) and within MELEE_RANGE.
const P1_SPOT = { x: 736, y: 320 };
const P2_SPOT = { x: 704, y: 320 };

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
            ws, id: null, packets: [], players: new Map(), logs: [],
            pos: { x: 320, y: 320 }, skulledSelf: false, guildSelf: null,
            fct: [], on: {}
        };
        st.on.packet = () => {};
        ws.on('open', () => resolve(st));
        ws.on('error', reject);
        ws.on('message', raw => {
            let p; try { p = JSON.parse(raw.toString()); } catch { return; }
            st.packets.push(p);
            if (p.action === 'your_id') st.id = p.id;
            if (p.action === 'players_sync') {
                p.players.forEach(e => st.players.set(e.id, e));
                const me = p.players.find(e => e.id === st.id);
                if (me) { st.skulledSelf = !!me.skulled; st.guildSelf = me.guild || null; st.pos = { x: me.x, y: me.y }; }
            }
            if (p.action === 'player_update' && p.id === st.id) st.pos = { x: p.x, y: p.y };
            if (p.action === 'force_position') st.pos = { x: p.x, y: p.y };
            if (p.action === 'log') st.logs.push(p.message);
            if (p.action === 'fct') st.fct.push(p.text);
            st.on.packet(p);
        });
    });
}

function send(st, packet) { st.ws.send(JSON.stringify(packet)); }

async function login(st, name, classType, warmode) {
    for (let attempt = 0; attempt < 6; attempt++) {
        let settled = false, err = null;
        st.on.packet = p => {
            if (p.action === 'your_id') { st.id = p.id; settled = true; }
            if (p.action === 'login_error' || p.action === 'auth_error') { err = p.message; settled = true; }
        };
        send(st, { action: 'login', name, class: classType, warmode });
        for (let w = 0; w < 25 && !settled; w++) await sleep(100);
        st.on.packet = () => {};
        if (st.id) return true;
        console.log(`  (login ${name} attempt ${attempt + 1} failed${err ? `: ${err}` : ''}; retrying)`);
        await sleep(400);
    }
    return false;
}

// One TILE_SIZE per step, obeying the server's one-step rule and cooldown.
async function walkTo(st, tx, ty) {
    const budget = Date.now() + 90000;
    let stuck = 0;
    while (Date.now() < budget) {
        const dx = tx - st.pos.x, dy = ty - st.pos.y;
        if (dx === 0 && dy === 0) return true;
        const useX = Math.abs(dx) >= Math.abs(dy);
        const before = `${st.pos.x},${st.pos.y}`;
        send(st, {
            action: 'move',
            x: st.pos.x + (useX ? TILE * Math.sign(dx) : 0),
            y: st.pos.y + (useX ? 0 : TILE * Math.sign(dy))
        });
        await sleep(STEP_DELAY);
        if (`${st.pos.x},${st.pos.y}` === before) {
            stuck++;
            const perp = TILE * (stuck % 2 === 0 ? 1 : -1);
            send(st, { action: 'move', x: st.pos.x + (useX ? 0 : perp), y: st.pos.y + (useX ? perp : 0) });
            await sleep(STEP_DELAY);
            if (stuck > 14) return false;
        } else stuck = 0;
    }
    return false;
}

const goldOf = st => {
    const s = st.packets.filter(p => p.action === 'status').pop();
    return s ? s.gold : undefined;
};

async function main() {
    console.log(`\n=== SKULL + GUILD: live end-to-end verification (port ${PORT}) ===\n`);
    const server = new ServerController({ port: PORT, dbFile: DB_FILE, env: { TIBIA_DB_DRIVER: 'sqlite' } });
    await server.start();

    let p1 = null, p2 = null;
    try {
        // ---------- 1. PvP grants a skull ----------
        console.log('[1] attacking an unskulled player marks the aggressor');
        p1 = await connect(`ws://127.0.0.1:${PORT}`);
        p2 = await connect(`ws://127.0.0.1:${PORT}`);
        check('aggressor logged in', await login(p1, 'SkullerA', 'warrior', true));
        check('victim logged in', await login(p2, 'VictimB', 'warrior', true));
        await sleep(900);

        check('neither player starts skulled', !p1.skulledSelf && !p2.skulledSelf,
            `A=${p1.skulledSelf}, B=${p2.skulledSelf}`);

        // Both must leave the safe zone (0,0 - 640,640) for PvP to be legal.
        const aMoved = await walkTo(p1, P1_SPOT.x, P1_SPOT.y);
        check('aggressor left the safe zone', aMoved, `at ${p1.pos.x},${p1.pos.y}`);
        const bMoved = await walkTo(p2, P2_SPOT.x, P2_SPOT.y);
        check('victim left the safe zone', bMoved, `at ${p2.pos.x},${p2.pos.y}`);

        const gap = Math.abs(p1.pos.x - p2.pos.x) + Math.abs(p1.pos.y - p2.pos.y);
        check('the two are within melee range', gap <= 48, `gap=${gap}`);

        send(p1, { action: 'attack', target_id: p2.id });
        // Attack cooldown is 2000ms.
        await sleep(2600);

        check('the aggressor is now skulled', p1.skulledSelf === true, `skulled=${p1.skulledSelf}`);
        check('the victim was NOT skulled', p2.skulledSelf === false, `skulled=${p2.skulledSelf}`);
        check('the aggressor was told about it',
            p1.logs.some(m => /skull/i.test(m)), JSON.stringify(p1.logs.slice(-2)));
        check('a SKULL floater was broadcast', p1.fct.includes('SKULL'), `fct=${JSON.stringify(p1.fct)}`);

        // ---------- 2. players_sync carries the state ----------
        console.log('\n[2] players_sync carries skull and guild for the client');
        const sync = p1.packets.filter(x => x.action === 'players_sync').pop();
        check('players_sync was received', !!sync);
        if (sync) {
            const entryA = sync.players.find(e => e.id === p1.id);
            const entryB = sync.players.find(e => e.id === p2.id);
            check('the skulled player is broadcast with skulled:true', entryA && entryA.skulled === true,
                `skulled=${entryA && entryA.skulled}`);
            check('the clean player is broadcast with skulled:false', entryB && entryB.skulled === false,
                `skulled=${entryB && entryB.skulled}`);
            check('a guild field is present for the client', entryA && 'guild' in entryA,
                `guild=${entryA && entryA.guild}`);
        }

        // ---------- 3. guild creation ----------
        console.log('\n[3] guild membership');
        send(p1, { action: 'test_grant_gold', amount: 5000 });
        await sleep(500);
        send(p1, { action: 'chat', text: '/guild create TestOrder' });
        await sleep(800);
        const created = p1.logs.some(m => /created/i.test(m));
        check('the guild was created', created, JSON.stringify(p1.logs.slice(-2)));
        await sleep(1200);
        check('players_sync now reports a guild', !!p1.guildSelf, `guild=${p1.guildSelf}`);

        // ---------- 4. both survive a reconnect ----------
        console.log('\n[4] skull and guild survive logout/login');
        const p1Id = p1.id;
        p1.ws.close();
        await sleep(1500);

        const p1b = await connect(`ws://127.0.0.1:${PORT}`);
        check('aggressor logged back in', await login(p1b, 'SkullerA', 'warrior', true));
        await sleep(1500);
        p1 = p1b;
        check('the skull survived the reconnect', p1.skulledSelf === true, `skulled=${p1.skulledSelf}`);
        check('the guild survived the reconnect', !!p1.guildSelf, `guild=${p1.guildSelf}`);

        // A skull with no timer must not come back as active: verify the flag
        // is genuinely carrying its expiry rather than a bare boolean.
        const savedRow = await readSavedPlayer('SkullerA');
        check('the saved row carries skull and skullExpiresAt',
            savedRow && savedRow.skull === 'white' && savedRow.skullExpiresAt > 0,
            `skull=${savedRow && savedRow.skull}, expires=${savedRow && savedRow.skullExpiresAt}`);
        check('the saved row carries the guild', !!(savedRow && savedRow.guild), `guild=${savedRow && savedRow.guild}`);

        // ---------- 5. drop penalty ----------
        console.log('\n[5] a skulled player drops more gold on death');
        // p1 respawned at (320,320) on reconnect, which is inside the safe
        // zone, so PvP is illegal until it walks back out.
        p1 = p1;
        const aOut = await walkTo(p1, P1_SPOT.x, P1_SPOT.y);
        check('the skulled aggressor is back outside the safe zone', aOut, `at ${p1.pos.x},${p1.pos.y}`);
        check('the aggressor is still skulled before dying', p1.skulledSelf === true, `skulled=${p1.skulledSelf}`);

        send(p1, { action: 'test_grant_gold', amount: 4000 });
        await sleep(600);
        const skulledGold = goldOf(p1);
        check('the skulled player has gold to lose', skulledGold > 0, `gold=${skulledGold}`);

        // Park the victim next to it, then let the victim kill the aggressor.
        const bOut = await walkTo(p2, P1_SPOT.x - TILE, P1_SPOT.y);
        check('the killer moved into range', bOut, `at ${p2.pos.x},${p2.pos.y}`);
        const gap2 = Math.abs(p1.pos.x - p2.pos.x) + Math.abs(p1.pos.y - p2.pos.y);
        check('killer and target are adjacent', gap2 <= 48, `gap=${gap2}`);

        let guard = 0;
        while (guard++ < 45) {
            if (p1.logs.some(m => /was slain/i.test(m))) break;
            const st = p1.packets.filter(x => x.action === 'status').pop();
            if (st && st.hp <= 0) break;
            send(p2, { action: 'attack', target_id: p1.id });
            await sleep(2100);
        }
        const slain = p1.logs.some(m => /was slain/i.test(m));
        check('the skulled player died', slain, JSON.stringify(p1.logs.slice(-2)));

        if (slain) {
            const corpse = p1.packets.filter(x => x.action === 'corpse_spawn').pop();
            const dropped = corpse && corpse.corpse ? Number(corpse.corpse.gold) : 0;
            const expected = Number(skulledGold);   // SKULL_DROP_RATIO is 1.0
            check('the skulled corpse dropped ALL of the gold', dropped === expected,
                `dropped ${dropped}, expected ${expected} of ${skulledGold}`);
            check('that is strictly more than the 0.5 normal rate', dropped > Math.floor(skulledGold * 0.5),
                `${dropped} > ${Math.floor(skulledGold * 0.5)}`);
            check('the skull was consumed by the death', p1.skulledSelf === false, `skulled=${p1.skulledSelf}`);
            check('the player was told the skull was consumed',
                p1.logs.some(m => /consumed/i.test(m)), JSON.stringify(p1.logs.slice(-2)));
        }

    } finally {
        for (const s of [p1, p2]) {
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

function readSavedPlayer(charName) {
    return new Promise((resolve, reject) => {
        const sqlite3 = require(path.join(__dirname, '..', 'server', 'node_modules', 'sqlite3'));
        const file = DB_FILE.replace(/\.json$/, '.sqlite');
        const raw = new sqlite3.Database(file, err => {
            if (err) return reject(err);
            raw.get('SELECT state_json FROM players WHERE LOWER(char_name) = LOWER(?)', [charName], (e2, row) => {
                raw.close(() => {
                    if (e2) return reject(e2);
                    if (!row) return resolve(null);
                    try { resolve(JSON.parse(row.state_json)); } catch (err) { reject(err); }
                });
            });
        });
    });
}

main().catch(err => { console.error('\nverification crashed:', err); process.exit(1); });
