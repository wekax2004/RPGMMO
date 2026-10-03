/*
 * tests/bots/equip_status_count.js
 *
 * Counts the `status` packets a single equip_item produces, so an extraction that
 * quietly adds or removes a send cannot pass by asserting on the *latest* status.
 *
 * Why this exists: tests/bots/inventory_probe.js reads the last status packet it
 * received. That is blind to a change in how many were sent -- a handler that
 * starts sending status where it used to send none still produces a correct-looking
 * final state. So the two would compare equal while the packet traffic differed.
 *
 * Run against the pre- and post-extraction server and diff the counts.
 *
 *   node tests/bots/equip_status_count.js --port=NNNN
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
    return 8028;
}

const PORT = readPort(process.argv.slice(2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    const server = await startServer(PORT);
    const tag = Math.random().toString(36).slice(2, 7);
    const b = new BotClient({ name: `ES_${tag}` });
    await b.connect(`ws://localhost:${PORT}`, 10000);
    await b.login(b.charName, 'warrior', false, 20000);
    await sleep(1200);

    const counts = {};
    const handle = (raw) => {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
        if (p && p.action) counts[p.action] = (counts[p.action] || 0) + 1;
    };
    const sock = b.ws;
    if (typeof sock.addEventListener === 'function') sock.addEventListener('message', e => handle(e.data));
    else if (typeof sock.on === 'function') sock.on('message', d => handle(d));

    // Settle the login burst so the baseline is not counting packets from before.
    await sleep(1500);
    for (const k of Object.keys(counts)) delete counts[k];

    const measure = async (label, packet, pre) => {
        for (const k of Object.keys(counts)) delete counts[k];
        if (pre) for (const k of Object.keys(pre)) delete counts[k];
        b.send(packet);
        await sleep(1200);
        const status = counts.status || 0;
        const logs = counts.log || 0;
        console.log(`  ${label.padEnd(26)} status=${status} log=${logs}`);
        return { status, logs };
    };

    console.log(`=== equip packet counts (port ${PORT}) ===\n`);

    b.send({ action: 'test_grant_item', item: 'Iron Sword' });
    await sleep(1000);
    await measure('equip_item (sword)', { action: 'equip_item', item: 'Iron Sword' });
    await measure('unequip_item (weapon)', { action: 'unequip_item', slot: 'weapon' });
    b.send({ action: 'test_grant_item', item: 'Health Potion' });
    await sleep(1000);
    await measure('use_item (potion)', { action: 'use_item', item: 'Health Potion' });
    await measure('drop_item (potion)', { action: 'drop_item', item: 'Health Potion' });

    try { server.kill(); } catch (e) { /* gone */ }
    try { b.disconnect(); } catch (e) { }
    process.exit(0);
}

main().catch(e => {
    console.error('  could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});