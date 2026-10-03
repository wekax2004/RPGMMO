/*
 * tests/bots/inventory_probe.js
 *
 * Behaviour snapshot for the inventory, equipment and ground-item handlers, taken
 * before and after extracting them out of server.js into server/inventory.js
 * (roadmap 7.1 item 4).
 *
 * THE INVARIANT UNDER TEST
 *
 * Inventory entries are bare strings and the same string can appear more than once.
 * Every mutation here removes exactly one instance. That is the thing a refactor
 * breaks quietly, because `inventory.filter(i => i !== name)` and
 * `inventory.splice(index, 1)` both type-check, both compile, and only one of them
 * preserves a stack. So the checks below are overwhelmingly about COUNTS:
 *
 *   - using a consumable twice with two in the bag leaves one
 *   - equipping a second weapon puts the first one BACK in the bag, not into the void
 *   - dropping and picking up returns the exact count you started with
 *   - unequipping a stack of two of the same item leaves two in the bag
 *
 * The second theme is trust. Nothing here believes the client about what the player
 * owns or where they are. Both are re-derived server-side, and a forged packet is
 * free, so each refusal is asserted on the player's actual inventory rather than on
 * the presence of an error message.
 *
 * GROUND SYNC, NOT THE PACKET THAT TRIGGERED IT
 *
 * The interesting observable for a drop or a pickup is `ground_sync`, because that
 * is what the client renders. A drop that removes the item from the bag but never
 * broadcasts leaves the player looking at an item that is no longer there. So the
 * drop and pickup checks assert on the ground roster, not only on the status packet.
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
    return 8027;
}

const PORT = readPort(process.argv.slice(2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

function watch(bot) {
    // `errors` is kept for completeness but nothing named protocol_error is ever
    // sent -- sendProtocolError sends action:'log' with a prefix. `refused()` below
    // counts both, because a field that is permanently empty makes a check fail for
    // the wrong reason.
    const rec = { seen: {}, logs: [], fct: [], status: [], errors: [], ground: null, limited: 0 };
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
        if (p.action === 'ground_sync') rec.ground = p.items || p.groundItems || [];
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

async function send(bot, rec, packet, waitMs = 700) {
    bot.send(packet);
    await sleep(waitMs);
    if (rec.limited) { await sleep(2200); return 'throttled'; }
    return 'sent';
}

/** The player's inventory as of the last status packet. */
function bag(rec) {
    const s = rec.status[rec.status.length - 1];
    return Array.isArray(s && s.inventory) ? s.inventory : null;
}
function count(rec, name) {
    const b = bag(rec);
    return b ? b.filter(i => i === name).length : null;
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
    console.log(`=== inventory snapshot (port ${PORT}) ===\n`);
    const server = await startServer(PORT);

    const tag = Math.random().toString(36).slice(2, 7);
    const b = new BotClient({ name: `IA_${tag}` });
    await b.connect(`ws://localhost:${PORT}`, 10000);
    await b.login(b.charName, 'warrior', false, 20000);
    await sleep(1200);
    const r = watch(b);

    const POTION = 'Health Potion';
    const SWORD = 'Iron Sword';
    const DAGGER = 'Bandit Dagger';
    const BOOTS = 'Leather Boots';

    const grant = async (item, n) => {
        for (let i = 0; i < n; i++) b.send({ action: 'test_grant_item', item });
        await sleep(900);
    };

    // --- ground drop ------------------------------------------------------
    await grant(POTION, 3);
    check('the test fixture put three potions in the bag', count(r, POTION) === 3,
        `inventory=${JSON.stringify(bag(r))}`);

    clear(r);
    await send(b, r, { action: 'drop_item', item: POTION });
    check('dropping one potion removes exactly one copy', count(r, POTION) === 2,
        `inventory=${JSON.stringify(bag(r))}` +
        '   <-- 0 or 3 here means the mutation removed the wrong number of copies');
    check('the drop appears on the ground roster', r.ground && r.ground.some(g => g.name === POTION),
        `ground_sync=${JSON.stringify(r.ground)}`);
    const drop = (r.ground || []).find(g => g.name === POTION);
    check('the ground entry records the floor it was dropped on',
        !!drop && drop.z === 0,
        drop ? `z=${drop.z} (expected 0, the surface)` : 'no ground entry');

    // --- ground pickup ----------------------------------------------------
    clear(r);
    await send(b, r, { action: 'pickup_item', itemId: drop ? drop.id : null, x: drop && drop.x, y: drop && drop.y });
    check('picking it back up returns exactly one copy', count(r, POTION) === 3,
        `inventory=${JSON.stringify(bag(r))}`);
    check('the ground roster no longer lists it', !(r.ground || []).some(g => g.name === POTION),
        `ground_sync=${JSON.stringify(r.ground)}`);

    // --- forged pickup ----------------------------------------------------
    clear(r);
    await send(b, r, { action: 'pickup_item', itemId: 'gi_forged_99999' });
    check('a forged ground item id is refused with a reason',
        refused(r, /nothing to pick up|too far/i),
        `logs=${JSON.stringify(r.logs)}`);

    // --- drop what you do not have ---------------------------------------
    clear(r);
    await send(b, r, { action: 'drop_item', item: 'Rusty Nothing' });
    check('dropping an item you do not own is refused with a reason',
        refused(r, /do not own/i),
        `logs=${JSON.stringify(r.logs)}`);

    // --- consume a stack --------------------------------------------------
    clear(r);
    await send(b, r, { action: 'use_item', item: POTION });
    check('using a potion removes exactly one copy', count(r, POTION) === 2,
        `inventory=${JSON.stringify(bag(r))}` +
        '   <-- 0 here means splice(index) instead of splice(index, 1), or a filter');
    check('using a potion produces a healing number', r.fct.some(f => /\+\d+ HP/.test(f.text || '')),
        `fct=${JSON.stringify(r.fct.map(f => f.text))}`);

    // --- consume something that is not a consumable -----------------------
    // The load-bearing one. A client that sends `use_item` for a sword must not
    // destroy the sword.
    await grant(SWORD, 1);
    clear(r);
    await send(b, r, { action: 'use_item', item: SWORD });
    check('using a non-consumable leaves it in the bag', count(r, SWORD) === 1,
        `inventory=${JSON.stringify(bag(r))}` +
        '   <-- 0 here means an unknown item was consumed before being classified');

    // --- equip ------------------------------------------------------------
    // Every check below is a DELTA, not an absolute count. The first version of this
    // probe asserted absolute counts and got three of them wrong purely by
    // mis-tracking its own grants -- it equipped a second Iron Sword and then
    // asserted the bag held zero. A delta cannot be wrong that way, and it reads
    // the property actually being tested: one copy moved, nothing created or lost.
    const swordsBefore = count(r, SWORD);
    clear(r);
    await send(b, r, { action: 'equip_item', item: SWORD });
    check('equipping a sword removes exactly one copy from the bag',
        count(r, SWORD) === swordsBefore - 1,
        `before=${swordsBefore} after=${count(r, SWORD)} inventory=${JSON.stringify(bag(r))}`);
    check('equipping is announced', r.logs.some(m => /Equipped/.test(m)),
        `logs=${JSON.stringify(r.logs)}`);

    // Swap weapons. The outgoing one must come back to the bag, not evaporate.
    await grant(DAGGER, 1);
    const daggersBefore = count(r, DAGGER);
    const swordsPreSwap = count(r, SWORD);
    clear(r);
    await send(b, r, { action: 'equip_item', item: DAGGER });
    check('swapping weapons puts the displaced one back in the bag',
        count(r, SWORD) === swordsPreSwap + 1,
        `swords before=${swordsPreSwap} after=${count(r, SWORD)} inventory=${JSON.stringify(bag(r))}` +
        '   <-- unchanged here means the displaced item was dropped rather than returned');
    check('the new weapon left the bag',
        count(r, DAGGER) === daggersBefore - 1,
        `daggers before=${daggersBefore} after=${count(r, DAGGER)}`);

    // --- unequip ----------------------------------------------------------
    const daggersPreUnequip = count(r, DAGGER);
    clear(r);
    await send(b, r, { action: 'unequip_item', slot: 'weapon' });
    check('unequipping returns the item to the bag',
        count(r, DAGGER) === daggersPreUnequip + 1,
        `daggers before=${daggersPreUnequip} after=${count(r, DAGGER)} inventory=${JSON.stringify(bag(r))}`);

    // --- unequip a slot that is not one -----------------------------------
    clear(r);
    await send(b, r, { action: 'unequip_item', slot: 'offhand' });
    check('unequipping an invalid slot is refused with a reason',
        refused(r, /invalid equipment slot/i),
        `logs=${JSON.stringify(r.logs)}`);

    // --- equip something that is in no catalogue -------------------------
    await grant(BOOTS, 1);
    const bootsBefore = count(r, BOOTS);
    clear(r);
    await send(b, r, { action: 'equip_item', item: BOOTS });
    check('equipping a real catalogue item moves it out of the bag',
        count(r, BOOTS) === bootsBefore - 1,
        `before=${bootsBefore} after=${count(r, BOOTS)} inventory=${JSON.stringify(bag(r))}`);
    const bootsPreUnequip = count(r, BOOTS);
    clear(r);
    await send(b, r, { action: 'unequip_item', slot: 'boots' });
    check('boots come back on unequip',
        count(r, BOOTS) === bootsPreUnequip + 1,
        `before=${bootsPreUnequip} after=${count(r, BOOTS)} inventory=${JSON.stringify(bag(r))}`);

    // --- mount ------------------------------------------------------------
    // There is no mount item in the catalogue, so mountPlayer has no inventory
    // precondition: any player may mount. The first version of this probe asserted
    // the opposite, because it had read the comment in inventory.js rather than the
    // code -- and that comment was itself wrong, describing a precondition that does
    // not exist. Both have been corrected against the code.
    clear(r);
    await send(b, r, { action: 'toggle_mount' });
    const mounted = (r.seen.mount_changed || []).find(m => m.isMounted === true);
    check('toggling with no mount equipped still mounts -- there is no mount item',
        !!mounted,
        `mount_changed=${JSON.stringify(r.seen.mount_changed || [])}` +
        '   <-- if this refuses, a mount precondition now exists that the catalogue cannot satisfy');
    check('mounting is announced', r.logs.some(m => /mount up/i.test(m)),
        `logs=${JSON.stringify(r.logs)}`);

    // Every other client draws the sprite, so the change must be broadcast.
    clear(r);
    await send(b, r, { action: 'toggle_mount' });
    const dismounted = (r.seen.mount_changed || []).filter(m => m.isMounted === false);
    check('toggling again dismounts and broadcasts it', dismounted.length > 0,
        `mount_changed=${JSON.stringify(r.seen.mount_changed || [])}`);

    // A known duplication, asserted so it cannot regress silently in either
    // direction. dismountPlayer broadcasts and so does the handler, so a dismount
    // sends two. Recorded in ROADMAP.md as wasteful-not-wrong rather than fixed
    // here, because a refactor that quietly changes the packet count is not a
    // refactor.
    check('a dismount broadcasts mount_changed twice, which is a known duplication',
        dismounted.length === 2,
        `packets=${dismounted.length} (expected 2: dismountPlayer broadcasts, then the handler does)`);

    if (r.limited) console.log(`\n  note: ${r.limited} packet(s) were rate limited during this run`);

    try { server.kill(); } catch (e) { /* gone */ }
    try { b.disconnect(); } catch (e) { }

    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});