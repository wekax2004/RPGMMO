/*
 * Probes a suspected data-loss bug in the auction house.
 *
 * A listing removes the item from the seller's inventory and records it only
 * in an in-memory Map. If the server restarts while a listing is live, the item
 * may be destroyed: gone from the inventory and gone from the board.
 *
 * Run:  node tests/auction_restart_probe.js
 */
const path = require('path');
const os = require('os');
const ServerController = require('./lib/server_controller');

const PORT = 8160;
const DB_FILE = path.join(os.tmpdir(), `tibia-auction-restart-${process.pid}.json`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(label, condition, detail) {
    const ok = !!condition;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ` -- ${detail}` : ''}`);
    return ok;
}

function connect(url) {
    const WS = require('ws');
    return new Promise((resolve, reject) => {
        const ws = new WS(url);
        const st = { ws, id: null, packets: [], listings: [], status: null, logs: [], on: {} };
        st.on.packet = () => {};
        ws.on('open', () => resolve(st));
        ws.on('error', reject);
        ws.on('message', raw => {
            let p; try { p = JSON.parse(raw.toString()); } catch { return; }
            st.packets.push(p);
            if (p.action === 'your_id') st.id = p.id;
            if (p.action === 'status') st.status = p;
            if (p.action === 'log') st.logs.push(p.message);
            if (p.action === 'auction_sync') st.listings = p.listings || [];
            if (typeof st.on.packet === 'function') st.on.packet(p);
        });
    });
}
const send = (st, p) => st.ws.send(JSON.stringify(p));

async function login(st, name, classType) {
    for (let a = 0; a < 6; a++) {
        let settled = false;
        st.on.packet = p => {
            if (p.action === 'your_id') { st.id = p.id; settled = true; }
            if (p.action === 'login_error') settled = true;
        };
        send(st, { action: 'login', name, class: classType });
        for (let w = 0; w < 25 && !settled; w++) await sleep(100);
        st.on.packet = () => {};
        if (st.id) return true;
        await sleep(400);
    }
    return false;
}

const inv = st => (st.status ? st.status.inventory : null) || [];

async function main() {
    console.log('\n=== auction restart data-loss probe ===\n');
    let server = new ServerController({ port: PORT, dbFile: DB_FILE, env: { TIBIA_DB_DRIVER: 'sqlite' } });
    await server.start();

    let a = null;
    try {
        a = await connect(`ws://127.0.0.1:${PORT}`);
        check('seller logged in', await login(a, 'EscrowTest', 'warrior'));
        await sleep(900);
        send(a, { action: 'test_grant_item', item: 'Iron Sword' });
        await sleep(800);
        check('seller has the item', inv(a).includes('Iron Sword'), JSON.stringify(inv(a)));

        send(a, { action: 'auction_list', item: 'Iron Sword', price: 500 });
        await sleep(900);
        check('the item left the inventory', !inv(a).includes('Iron Sword'), JSON.stringify(inv(a)));
        check('the listing is on the board', a.listings.length === 1, `listings=${a.listings.length}`);

        // Log out cleanly, then restart the server. This is the exact sequence
        // a crash or a deploy produces.
        a.ws.close();
        await sleep(1500);
        await server.stop();
        await sleep(800);
        console.log('  --- server restarted ---');

        server = new ServerController({ port: PORT, dbFile: DB_FILE, env: { TIBIA_DB_DRIVER: 'sqlite' } });
        await server.start();
        await sleep(500);

        const b = await connect(`ws://127.0.0.1:${PORT}`);
        check('seller logged back in after the restart', await login(b, 'EscrowTest', 'warrior'));
        await sleep(1200);

        const hasItem = inv(b).includes('Iron Sword');
        const onBoard = b.listings.some(l => l.item === 'Iron Sword');
        console.log(`  after restart: item in inventory = ${hasItem}, listing on board = ${onBoard}`);

        check('the listed item survived the restart somewhere reachable',
            hasItem || onBoard,
            'DATA LOSS: the item is in neither the inventory nor the board -- it no longer exists');

        if (!hasItem && !onBoard) {
            console.log('\n  => DATA LOSS: a listed item is destroyed by a server restart.');
        } else if (!hasItem && onBoard) {
            console.log('\n  => escrow survived: the listing is back on the board and still buyable.');
        } else {
            console.log('\n  => the item was returned to the inventory.');
        }
        b.ws.close();
        await sleep(300);
    } finally {
        try { if (a && a.ws.readyState === 1) a.ws.close(); } catch { /* ignore */ }
        try { await server.stop(true); } catch { /* ignore */ }
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
            require('fs').rmSync(DB_FILE.replace(/\.json$/, '.sqlite') + suffix, { force: true });
            require('fs').rmSync(DB_FILE + suffix, { force: true });
        }
    }
    console.log(`\n=== probe finished: ${failures} failing check(s) ===\n`);
    process.exit(0);
}

main().catch(err => { console.error('\nprobe crashed:', err); process.exit(1); });
