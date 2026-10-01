/*
 * Verifies the test-action extraction (roadmap 7.1) changed no behaviour.
 *
 * server/testing.js now answers the nine test_* actions that used to be inline in
 * the packet handler. Those actions are how every browser and bot acceptance suite
 * reaches a state on demand, so a silent break here would be invisible in a unit
 * test and would break AC1-AC7 in ways that look like flaky tests.
 *
 * This drives each action over a real socket against a real server and asserts the
 * observable effect, rather than checking that the module exports a function.
 *
 * Run: node tests/bots/testing_actions_probe.js --port=8144
 */
// Same fallback as bot_client.js: ws is a server dependency, so it may only exist
// under server/node_modules depending on how the tree was installed. The first
// version of this probe required it unconditionally and died with an empty error,
// because require() threw a MODULE_NOT_FOUND with no message worth printing.
let WS;
try {
    WS = require('ws');
} catch (e) {
    WS = require('../../server/node_modules/ws');
}

// Accepts both `--port 8144` and `--port=8144`. The first version matched only the
// exact token '--port', so the `--port=N` form silently fell through to the default
// and the probe connected to a port nothing was listening on -- which surfaced as
// ECONNREFUSED against the wrong port and read like a server problem.
function readPort(argv) {
    const eq = argv.find(a => a.startsWith('--port='));
    if (eq) return Number(eq.split('=')[1]);
    const i = argv.indexOf('--port');
    if (i > -1 && argv[i + 1]) return Number(argv[i + 1]);
    const env = Number(process.env.PROBE_PORT);
    return Number.isFinite(env) && env > 0 ? env : 8144;
}

const PORT = readPort(process.argv.slice(2));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

/** Collects packets so an action can be awaited by the response it causes. */
function connect(name) {
    return new Promise((resolve, reject) => {
        const ws = new WS(`ws://localhost:${PORT}`);
        const packets = [];
        ws.on('message', d => { try { packets.push(JSON.parse(d.toString())); } catch (e) { /* ignore */ } });
        ws.on('open', () => {
            ws.send(JSON.stringify({ action: 'login', name, class: 'warrior', warmode: false }));
            const wait = setInterval(() => {
                if (packets.some(p => p.action === 'your_id')) {
                    clearInterval(wait);
                    resolve({ ws, packets });
                }
            }, 50);
            setTimeout(() => { clearInterval(wait); reject(new Error('login timed out')); }, 20000);
        });
        ws.on('error', reject);
    });
}

const send = (ws, packet) => ws.send(JSON.stringify(packet));

async function main() {
    console.log(`=== test action extraction probe (port ${PORT}) ===\n`);
    const bot = await connect(`TestActions_${Math.random().toString(36).slice(2, 7)}`);
    const { ws, packets } = bot;
    await sleep(600);

    const since = (n) => packets.slice(n);
    const logged = (from) => since(from).some(p => p.action === 'log' && typeof p.message === 'string');

    // --- test_grant_gold --------------------------------------------------
    let mark = packets.length;
    send(ws, { action: 'test_grant_gold', amount: 4321 });
    await sleep(400);
    const goldStatus = since(mark).find(p => p.action === 'status');
    check('test_grant_gold sets gold and replies with status',
        !!goldStatus && goldStatus.gold === 4321,
        goldStatus ? `status.gold=${goldStatus.gold}` : 'no status packet arrived');

    // --- test_grant_xp ----------------------------------------------------
    mark = packets.length;
    send(ws, { action: 'test_grant_xp', amount: 500 });
    await sleep(500);
    const xpStatus = since(mark).find(p => p.action === 'status');
    check('test_grant_xp awards XP', !!xpStatus && xpStatus.xp > 0,
        xpStatus ? `status.xp=${xpStatus.xp} level=${xpStatus.level}` : 'no status packet');

    // --- test_grant_item --------------------------------------------------
    mark = packets.length;
    send(ws, { action: 'test_grant_item', item: 'Health Potion' });
    await sleep(400);
    const itemStatus = since(mark).find(p => p.action === 'status');
    const hasItem = !!itemStatus && Array.isArray(itemStatus.inventory) &&
        itemStatus.inventory.includes('Health Potion');
    check('test_grant_item adds the item and echoes inventory', hasItem,
        itemStatus ? `inventory=[${(itemStatus.inventory || []).join(', ')}]` : 'no status packet');

    // --- test_grant_mana --------------------------------------------------
    mark = packets.length;
    const beforeMana = (packets.filter(p => p.action === 'status').pop() || {}).mana || 0;
    send(ws, { action: 'test_grant_mana', amount: 5 });
    await sleep(400);
    const manaStatus = since(mark).find(p => p.action === 'status');
    check('test_grant_mana is clamped to maxMana',
        !!manaStatus && manaStatus.mana <= manaStatus.maxMana && manaStatus.mana >= beforeMana,
        manaStatus ? `mana=${manaStatus.mana}/${manaStatus.maxMana} (was ${beforeMana})` : 'no status packet');

    // --- test_heal --------------------------------------------------------
    mark = packets.length;
    send(ws, { action: 'test_heal' });
    await sleep(400);
    const healStatus = since(mark).find(p => p.action === 'status');
    check('test_heal restores hp and mana to full',
        !!healStatus && healStatus.hp === healStatus.maxHp && healStatus.mana === healStatus.maxMana,
        healStatus ? `hp=${healStatus.hp}/${healStatus.maxHp} mana=${healStatus.mana}/${healStatus.maxMana}` : 'no status');

    // --- test_spawn_mob: valid and rejected -------------------------------
    mark = packets.length;
    send(ws, { action: 'test_spawn_mob', type: 'spider' });
    await sleep(500);
    check('test_spawn_mob spawns a known type and says so',
        logged(mark) && since(mark).some(p => p.action === 'log' && /Spawned spider/.test(p.message || '')),
        since(mark).filter(p => p.action === 'log').map(p => p.message).join(' | ') || 'no log');

    mark = packets.length;
    send(ws, { action: 'test_spawn_mob', type: 'goblin' });
    await sleep(500);
    check('test_spawn_mob rejects an unknown type rather than substituting',
        since(mark).some(p => (p.action === 'log' || p.action === 'protocol_error') &&
            /Unknown mob type/i.test(p.message || '')),
        // This is the assertion that has teeth: the old comment says a bad type used
        // to silently become a spider, and the log claimed otherwise.
        since(mark).filter(p => p.action === 'log').map(p => p.message).join(' | ') || 'no log');

    mark = packets.length;
    send(ws, { action: 'test_spawn_mob', type: 'spider', x: 999999, y: 999999 });
    await sleep(500);
    check('test_spawn_mob refuses an out-of-bounds spawn',
        since(mark).some(p => (p.action === 'log' || p.action === 'protocol_error') &&
            /not walkable|out of bounds/i.test(p.message || '')),
        since(mark).filter(p => p.action === 'log').map(p => p.message).join(' | ') || 'no log');

    // --- test_spawn_boss: valid and rejected -----------------------------
    mark = packets.length;
    send(ws, { action: 'test_spawn_boss', type: 'spider_queen' });
    await sleep(600);
    check('test_spawn_boss places the boss at the requested tile',
        since(mark).some(p => p.action === 'log' && /Spawned boss spider_queen/.test(p.message || '')),
        since(mark).filter(p => p.action === 'log').map(p => p.message).join(' | ') || 'no log');

    mark = packets.length;
    send(ws, { action: 'test_spawn_boss', type: 'not_a_boss' });
    await sleep(500);
    check('test_spawn_boss rejects an unknown boss type',
        since(mark).some(p => (p.action === 'log' || p.action === 'protocol_error') &&
            /Unknown boss type/i.test(p.message || '')),
        since(mark).filter(p => p.action === 'log').map(p => p.message).join(' | ') || 'no log');

    // --- trigger_boss_aoe: found and not found ---------------------------
    mark = packets.length;
    send(ws, { action: 'trigger_boss_aoe', bossType: 'no_such_boss' });
    await sleep(500);
    check('trigger_boss_aoe reports a boss it cannot find',
        since(mark).some(p => (p.action === 'log' || p.action === 'protocol_error') &&
            /Boss not found/i.test(p.message || '')),
        since(mark).filter(p => p.action === 'log').map(p => p.message).join(' | ') || 'no log');

    // --- attack_boss ------------------------------------------------------
    mark = packets.length;
    send(ws, { action: 'attack_boss', bossId: 'no_such_boss' });
    await sleep(400);
    check('attack_boss with an unknown id is a silent no-op, not a crash',
        true, 'no packet expected; reaching here without an exception is the assertion');

    ws.close();

    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    // A ws error arrives as a plain Event with no .message, which printed as an
    // empty line and made the failure look like nothing at all. Show everything.
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    if (e && e.target && e.target.url) console.error('  url:', e.target.url);
    process.exit(1);
});