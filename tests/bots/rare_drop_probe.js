/*
 * tests/bots/rare_drop_probe.js
 *
 * Roadmap 4.6: rare item drops, over real sockets.
 *
 * WHAT THIS COVERS THAT THE UNIT TESTS CANNOT
 *
 * tests/unit/rarity.test.js drives `rollRareDrop` directly, which is the right shape
 * for the probability rules -- the rng is injectable, so every branch is one assertion
 * away. What it cannot reach is the wiring: whether a kill on a real deep floor
 * actually produces a `loot_rare` packet, with the right floor, the right colour, and
 * the item actually in the bag.
 *
 * That wiring is exactly where this feature was broken while looking complete. `tier`
 * was a local in the spawn function, so `target.tier` was always undefined, the roll
 * saw tier 1, the pool was empty, and no `loot_rare` packet was ever sent. Every unit
 * test passed throughout, because every unit test called the roll with a tier it
 * supplied itself.
 *
 * SO THE PROBE MAKES THE FEATURE RELIABLE INSTEAD
 *
 * The real chance is under half a percent, which is useless for a test. `TIBIA_TEST_MODE`
 * does not help: the roll reads `Math.random` directly.
 *
 * Rather than fake the RNG through a test-only branch in production code -- which adds
 * a path nobody ever runs in production, and is the kind of thing that silently stops
 * working -- this kills enough real mobs that the roll fires for real. It does not
 * assert *which* item drops. It asserts the shape of the packet and that the item
 * named is one the item catalogue knows, which is the property that has to hold
 * regardless of which entry won.
 *
 * A floor full of tier-5.5 mobs makes that a few dozen kills rather than thousands.
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
    return 8029;
}

const PORT = readPort(process.argv.slice(2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}
function note(text) { console.log(`          ${text}`); }

const ITEMS = require(path.join(__dirname, '..', '..', 'server', 'items.js'));
const CATALOGUES = [
    ITEMS.consumables, ITEMS.weapons, ITEMS.armor, ITEMS.helmets,
    ITEMS.legs, ITEMS.boots, ITEMS.shields, ITEMS.amulets, ITEMS.materials
];
const existsAsAnItem = (name) =>
    CATALOGUES.some(c => Object.prototype.hasOwnProperty.call(c, name));

function watch(bot) {
    // `kills` is counted from the XP floating text the server sends on a kill, not
    // from how many times the probe looped. The first version incremented a counter
    // once per combat window and called it "38 kills", which is a guess about what
    // happened inside 1.3 seconds rather than an observation of it. Every iteration
    // of that loop could have killed nothing and the number would have looked the
    // same -- so it "explained" a missing drop with a death that may not have been
    // the cause either.
    // `mobs` tracks every mob_update by id, so the probe can attack a specific one.
    //
    // Explicit `attack` is used rather than `startAutoCombat`, because auto-combat
    // does not work from a harness: a mob spawned at the player's own tile dies to
    // the player's own attack tick before auto-combat has selected anything, so it
    // targets nothing and the probe counts zero kills while looking like it is
    // fighting. That is the fourth version of this probe to blame the feature for
    // something the harness was doing wrong.
    const rec = { rare: [], fct: [], status: [], limited: 0, kills: 0, mobs: {} };
    const handle = (raw) => {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
        if (!p || !p.action) return;
        if (p.action === 'loot_rare') rec.rare.push(p);
        if (p.action === 'mob_update' && p.id) {
            if (!rec.mobs[p.id]) rec.mobs[p.id] = [];
            rec.mobs[p.id].push(p);
        }
        if (p.action === 'fct') {
            rec.fct.push(p);
            if (/\+\d+ XP/.test(p.text || '')) rec.kills++;
        }
        if (p.action === 'status') rec.status.push(p);
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
    console.log(`=== rare drop snapshot (port ${PORT}) ===\n`);
    const server = await startServer(PORT);

    const tag = Math.random().toString(36).slice(2, 7);
    const b = new BotClient({ name: `RD_${tag}` });
    await b.connect(`ws://localhost:${PORT}`, 10000);
    await b.login(b.charName, 'warrior', false, 20000);
    await sleep(1200);
    const r = watch(b);

    // Survive everything. A death mid-run resets position and drops the session's
    // momentum, and a rare drop that arrives after a respawn would still be a valid
    // packet -- so this is about keeping the run long, not about correctness.
    b.send({ action: 'test_grant_xp', amount: 400000 });
    await sleep(600);
    b.send({ action: 'test_grant_gold', amount: 10000 });
    await sleep(600);
    // Armed. A starter sword against a tier-5.5 mob is a losing fight, and a losing
    // fight in this probe looks exactly like a feature that does not fire.
    b.send({ action: 'test_grant_item', item: 'War Cleaver of the Warren' });
    await sleep(400);
    b.send({ action: 'equip_item', item: 'War Cleaver of the Warren' });
    await sleep(700);

    const CFG = require(path.join(__dirname, '..', '..', 'server', 'config.js'));
    const MAPCFG = require(path.join(__dirname, '..', '..', 'server', 'map.js'));

    // Own position and floor, both read from packets rather than assumed.
    //
    // BotClient tracks x/y from `players_sync`, which is per-floor and arrives on the
    // tick -- so it lags a move by up to a tick. Walking with a step loop that reads
    // b.x immediately after sending a move therefore reads a stale position and can
    // oscillate. Local `x`/`y` here are updated from force_position, which the server
    // sends back per move, and are what the step loop walks on.
    let floor = 0, x = null, y = null;
    const track = () => {
        const handle = (raw) => {
            let p;
            try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
            if (!p) return;
            if (p.action === 'force_position') {
                if (Number.isFinite(p.x)) x = p.x;
                if (Number.isFinite(p.y)) y = p.y;
                if (Number.isFinite(p.z)) floor = p.z;
            }
        };
        const sock = b.ws;
        if (typeof sock.addEventListener === 'function') sock.addEventListener('message', e => handle(e.data));
        else if (typeof sock.on === 'function') sock.on('message', d => handle(d));
    };
    track();
    await sleep(800);
    if (x === null) { x = b.x; y = b.y; }
    /** Spawns one mob next to the player, kills it, and waits for the XP text. */
    const killOne = async (type) => {
        const before = r.kills;
        b.send({ action: 'test_heal' });
        await sleep(200);

        // Attack what is ALREADY here. Spawning more was actively harmful: z=-3 is
        // populated with 16 mobs by config, and they cluster on one tile, so the
        // probe added a 17th to a pile that was already killing the player every
        // second. The run then reported "the roll is not firing" while the real
        // story was that the player was dead before it could land a blow.
        //
        // The `type` argument is only used on the surface, where the floor is not
        // reliably populated at a known tile.
        let target = null, bestD = Infinity;
        for (const id of Object.keys(r.mobs)) {
            const last = r.mobs[id][r.mobs[id].length - 1];
            if (!last || last.z !== floor || last.alive === false) continue;
            if (floor === 0 && last.type !== type) continue;
            const d = Math.abs(last.x - x) + Math.abs(last.y - y);
            if (d < bestD) { bestD = d; target = id; }
        }
        if (!target) {
            // Nothing in range. Spawn one, which is the surface path.
            b.send({ action: 'test_spawn_mob', type, x, y });
            await sleep(700);
            for (const id of Object.keys(r.mobs)) {
                const last = r.mobs[id][r.mobs[id].length - 1];
                if (last && last.z === floor && last.alive !== false) { target = id; break; }
            }
            if (!target) return false;
        }

        // Swing until it dies. One `attack` only records the target; the server tick
        // does the damage, and a 5.5-tier mob needs several of those.
        b.send({ action: 'attack', target_id: target });
        for (let i = 0; i < 25 && r.kills === before; i++) {
            await sleep(180);
            if (i % 4 === 3) { b.send({ action: 'test_heal' }); b.send({ action: 'attack', target_id: target }); }
        }
        b.send({ action: 'test_heal' });
        return r.kills > before;
    };

    // --- the surface must never roll one -----------------------------------
    // Checked first, and on its own, because it is the guarantee the whole depth
    // system exists for and it costs a few kills to read.
    r.rare.length = 0;
    let surfaceKills = 0;
    for (let i = 0; i < 8; i++) if (await killOne('bandit')) surfaceKills++;
    check('a surface mob never produces a rare drop', r.rare.length === 0,
        r.rare.length
            ? `got ${JSON.stringify(r.rare[0])} from a surface mob`
            : `${surfaceKills} surface kills, no loot_rare, which is correct: the whole pool is gated at tier 2+`);

    // --- the deep floor must produce one -----------------------------------
    // The real test, and the one that fails when `tier` is not recorded on the mob.
    // At under half a percent this takes a few dozen kills. It is slow on purpose --
    // a faster version would mean faking the RNG, and a test-only branch in the drop
    // path is a path nobody runs in production.
    note('walking down to the deepest floor, then killing until the roll fires (slow)');
    r.rare.length = 0;
    let killed = 0;
    const deadline = Date.now() + 300000;

    // The bot's own floor, read from force_position -- which is the packet the
    // descent actually sends to the player (`sendTo(player, {action:
    // 'force_position', x, y, z: toZ})`). The `player_update` broadcast goes to the
    // floor, and the departing player has already been removed from it, so it is
    // NOT a reliable way to learn your own z. An earlier version of this probe read
    // `b.currentZ` and never moved, and looked like the descent was broken.

    // Walk a step at a time. `move` enforces a single TILE_SIZE step in ONE axis, so
    // a packet aimed at a diagonal neighbour is rejected outright -- the step has to
    // go along exactly one axis at a time.
    //
    // Stops when the walk stops making progress rather than running a fixed count: a
    // bot walking into a wall retries the same step forever and a fixed loop reports
    // that as "could not reach the ladder", which reads like a broken map.
    const TILE = CFG.TILE_SIZE;
    const stepTo = async (tx, ty) => {
        let stuck = 0, lastX = x, lastY = y;
        for (let guard = 0; guard < 200; guard++) {
            if (x === tx && y === ty) return true;
            const dx = tx - x, dy = ty - y;
            if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) {
                b.send({ action: 'move', x: x + Math.sign(dx) * TILE, y });
            } else if (dy !== 0) {
                b.send({ action: 'move', x, y: y + Math.sign(dy) * TILE });
            }
            await sleep(170);
            if (x === lastX && y === lastY) { if (++stuck > 6) return false; }
            else { stuck = 0; lastX = x; lastY = y; }
        }
        return x === tx && y === ty;
    };

    // Descend, following whatever transition the current floor offers.
    //
    // Read from MAP directly rather than from anything the bot was told. BotClient
    // tracks x/y but not the transition list, so `b.transitions` is always undefined
    // and a lookup on it silently finds nothing -- which is how an earlier version
    // of this probe sat on the surface reporting "no further transition from here"
    // when it had simply asked the wrong object.
    const descendAll = async () => {
        for (let hop = 0; hop < 4; hop++) {
            if (floor <= -3) break;
            const list = MAPCFG.getFloor(floor);
            const downs = list && list.transitions ? [...list.transitions.values()] : [];
            const down = downs.find(t => t.to < floor);
            if (!down) { note(`no downward transition on z=${floor}; stopping here`); return; }
            const arrived = await stepTo(down.x, down.y);
            // The transition fires when the player is standing on the tile, so it
            // needs a beat after the final step lands.
            await sleep(800);
            if (!arrived && floor === (hop === 0 ? 0 : floor - 1)) {
                note(`could not reach the transition at ${down.x},${down.y} on z=${down.from !== undefined ? '' : floor}`);
            }
        }
    };

    if (MAPCFG.getTransition(0, CFG.LADDER_X, CFG.LADDER_Y)) {
        note(`walking to the surface ladder at ${CFG.LADDER_X},${CFG.LADDER_Y} from ${x},${y}`);
        await stepTo(CFG.LADDER_X, CFG.LADDER_Y);
        await sleep(800);
        await descendAll();
    }
    note(`reached z=${floor} at ${x},${y}`);

    if (floor === 0) {
        note('could not reach the dungeon; the deep-floor behaviour is unverified here');
        check('reached a dungeon floor', false, 'never descended');
    } else {
        // Populate: a fresh floor is sparse and auto-combat needs something to hit.
        const homeFloor = floor;
        let deaths = 0;
        while (Date.now() < deadline && r.rare.length === 0) {
            b.send({ action: 'test_heal' });
            await sleep(220);
            const landed = await killOne('skeleton');
            if (landed) killed++;

            if (floor !== homeFloor) {
                // Died and respawned at the city. Everything below this point would be
                // measuring the wrong floor, so go back down rather than continuing.
                //
                // This was a false diagnosis once already: the probe reported "no rare
                // drop" from a run that had quietly moved to the surface, and blamed
                // the tier wiring. Detecting the respawn is what turned it back into a
                // real answer.
                deaths++;
                note(`died on z=${homeFloor} and respawned on z=${floor}; walking back down (death ${deaths})`);
                x = null; y = null;
                await sleep(700);
                if (x === null) { x = b.x; y = b.y; }
                await stepTo(CFG.LADDER_X, CFG.LADDER_Y);
                await sleep(700);
                await descendAll();
                if (floor !== homeFloor) {
                    note('could not get back down; stopping rather than measuring the surface');
                    break;
                }
                continue;
            }
            if (r.limited) { await sleep(2500); r.limited = 0; }
            if (killed % 15 === 0) note(`${killed} kills on z=${floor}, no rare drop yet`);
        }
        if (deaths) note(`survived ${deaths} death(s) during the run`);

        check('a deep-floor mob does produce a rare drop', r.rare.length > 0,
            r.rare.length
                ? `after ${r.kills} real kills: ${JSON.stringify(r.rare[0])}`
                : `no loot_rare after ${r.kills} real kills over ${killed} combat windows` +
                  (r.kills === 0
                    ? ' -- nothing died, so this measures nothing; the loop is not killing mobs'
                    : ' -- the roll is not firing'));

        if (r.rare.length) {
            const drop = r.rare[0];

            check('the packet names the item, its rarity and a colour',
                typeof drop.name === 'string' && drop.name.length > 0
                    && (drop.rarity === 'rare' || drop.rarity === 'legendary')
                    && typeof drop.color === 'string' && /^#[0-9a-f]{6}$/i.test(drop.color),
                `name=${JSON.stringify(drop.name)} rarity=${JSON.stringify(drop.rarity)} color=${JSON.stringify(drop.color)}` +
                '   <-- a client cannot render a sparkle from a string it has to re-parse');

            check('the named item exists in the item catalogue', existsAsAnItem(drop.name),
                `'${drop.name}' was announced but is in no catalogue, so it cannot be equipped or used`);

            check('the drop is announced on the floor it happened on',
                drop.z === floor,
                `drop.z=${drop.z} player z=${floor}` +
                '   <-- announcing on the wrong floor floats the text where nobody is standing');

            const inBag = (r.status[r.status.length - 1] || {}).inventory || [];
            check('the announced item is actually in the player inventory',
                inBag.includes(drop.name),
                `inventory=${JSON.stringify(inBag.slice(-8))}` +
                '   <-- announced but not in the bag means the packet lies to the player');

            const fct = r.fct.find(f => f.text && f.text.includes(drop.name));
            check('a floating label names the drop and uses the rarity colour',
                !!fct && fct.color === drop.color,
                fct ? `fct=${JSON.stringify(fct.text)} color=${fct.color} expected=${drop.color}`
                    : `no fct mentioning '${drop.name}'`);
        }
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