/*
 * tests/bots/aoi_probe.js
 *
 * Measures the AoI change (roadmap 7.2) over a real socket, and checks the
 * correctness property that matters more than the saving.
 *
 * WHAT THIS ESTABLISHES
 *
 * Bandwidth. Each bot counts the bytes it receives in players_sync packets over a
 * fixed window. Run it twice -- once with TIBIA_AOI_RADIUS=0 and once with the
 * default -- and the ratio is the real saving, measured rather than calculated. A
 * number derived from the selection function alone would only prove the function
 * does what it says; it would not prove the server calls it, or that the client
 * does the right thing with the result.
 *
 * The ghost test, which is the reason any of this is safe. AoI's entire cleanup
 * story rests on one line in engine.js:
 *
 *     for (let id in otherPlayers) { if (!newIds.includes(id)) delete otherPlayers[id]; }
 *
 * If that line ever stops running, a peer who walks out of range is never removed
 * from anyone else's client. Nothing throws, nothing is logged, and every client
 * slowly accumulates a ghost of every player who has ever been nearby -- the kind
 * of bug that is invisible in a screenshot and obvious to a player after ten
 * minutes of play. So this walks a bot away and asserts it disappears from a peer
 * that is standing still, which is precisely the case nothing else would catch.
 *
 * WHY THE BOTS WALK RATHER THAN TELEPORT
 *
 * There is no test action that moves a player, so separation has to be earned one
 * tile at a time. They walk east out of the safe zone, which also means nothing
 * kills them mid-measurement -- a bot that dies and respawns at the spawn point
 * would quietly rejoin the cluster and make the bandwidth figure look worse than
 * it is.
 *
 * Run: node tests/bots/aoi_probe.js --port=8143
 */

const path = require('path');

function readPort(argv) {
    const eq = argv.find(a => a.startsWith('--port='));
    if (eq) return Number(eq.split('=')[1]);
    const i = argv.indexOf('--port');
    if (i > -1 && argv[i + 1]) return Number(argv[i + 1]);
    return 8143;
}

const PORT = readPort(process.argv.slice(2));

let WS;
try {
    WS = require('ws');
} catch (e) {
    WS = require('../../server/node_modules/ws');
}
// bot_client.js does `module.exports = BotClient`, not an object of exports.
// Destructuring `{ BotClient }` yields undefined and fails much later, at the first
// `new BotClient`, with a message pointing at the constructor rather than at the
// require.
const BotClient = (() => {
    try {
        return require('./bot_client');
    } catch (e) {
        return require('./bot_client.js');
    }
})();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

// The surface is 3200x3200 and bots spawn at 320,320. Both positions below are
// walkable open ground well outside the safe zone, and 1280px apart is further than
// the 1000px radius, so the two groups must not see each other.
const HOME = { x: 320, y: 320 };
const FAR = { x: 1600, y: 320 };
const EXPECTED_SEPARATION = 1280;

/**
 * Counts players_sync bytes and remembers the latest roster, per bot.
 * Counting raw bytes rather than entry counts is the point: the payload includes
 * class, equipment and guild fields, so "half the entries" is not "half the bytes".
 */
function instrument(bot, name) {
    const rec = { name, bytes: 0, packets: 0, entries: 0, roster: [] };
    const sock = bot.ws;
    if (sock) {
        const handle = (raw) => {
            let p;
            try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
            if (p.action !== 'players_sync' || !Array.isArray(p.players)) return;
            rec.packets++;
            rec.entries += p.players.length;
            rec.bytes += typeof raw === 'string' ? raw.length : String(raw).length;
            rec.roster = p.players.map(e => e.id);
        };

        // Both subscription styles, because bot_client.js does not use one fixed
        // library. It resolves WS as:
        //
        //     if (typeof globalThis.WebSocket !== 'undefined') WS = globalThis.WebSocket;
        //     else WS = require('ws');
        //
        // and on any modern Node the global exists, so the socket is a WHATWG
        // WebSocket -- which has addEventListener and no .on(). Calling .on()
        // against it fails with "sock.on is not a function", which reads like a
        // broken socket rather than a different API. The ws package branch is kept
        // for older runtimes and because it costs one line.
        if (typeof sock.addEventListener === 'function') {
            sock.addEventListener('message', (event) => handle(event.data));
        } else if (typeof sock.on === 'function') {
            sock.on('message', (data) => handle(data));
        }
    }
    return rec;
}

/** Walks a bot toward a point, one tile at a time, until close or out of attempts. */
async function walkTo(bot, tx, ty, maxSteps = 90) {
    for (let i = 0; i < maxSteps; i++) {
        if (Math.abs(bot.x - tx) <= 32 && Math.abs(bot.y - ty) <= 32) return true;
        if (!bot.stepToward(tx, ty)) await sleep(120);
        await sleep(340);          // server move cooldown is ~300ms at level 1
    }
    return Math.abs(bot.x - tx) <= 32 && Math.abs(bot.y - ty) <= 32;
}

/** Bytes per bot over a fixed window. */
async function sample(recs, ms) {
    for (const r of recs) { r.bytes = 0; r.packets = 0; r.entries = 0; }
    await sleep(ms);
    return recs.map(r => ({ name: r.name, bytes: r.bytes, packets: r.packets, entries: r.entries }));
}

async function main() {
    const CFG = require('../../server/config');
    const AOI_RADIUS = CFG.AOI_RADIUS;
    console.log(`=== AoI probe (port ${PORT}, AOI_RADIUS=${AOI_RADIUS}) ===\n`);
    console.log(`  mode: ${AOI_RADIUS > 0 ? 'FILTERED' : 'full floor (pre-AoI control)'}\n`);

    // Six bots: three stay home, three walk away. Six is enough for a full mesh of
    // 36 entries to be visibly wasteful and small enough to stay quick.
    //
    // The order of these three calls matters, and got it wrong first:
    // instrument() needs bot.ws, which does not exist until connect() has run, and
    // login() refuses to send on a socket that was never opened ("WebSocket is not
    // OPEN, readyState=null"). connect() does not log in on its own -- only when
    // options.autoLogin is set -- so the three steps are genuinely separate.
    const bots = [];
    const recs = [];
    for (let i = 0; i < 6; i++) {
        const bot = new BotClient({ serverUrl: `ws://localhost:${PORT}`, name: `Aoi${i}_${Math.random().toString(36).slice(2, 7)}` });
        await bot.connect(`ws://localhost:${PORT}`, 10000);
        bots.push(bot);
        recs.push(instrument(bot, i));
        // A fresh server/data can take a while to answer the first login.
        await bot.login(bot.charName, 'warrior', false, 20000);
        await sleep(150);
    }
    check('all six bots logged in', bots.length === 6, `${bots.length} connected`);
    await sleep(1200);

    // --- Phase 1: everyone together ---------------------------------------
    const together = await sample(recs, 2000);
    const togetherBytes = together.reduce((n, r) => n + r.bytes, 0);
    const togetherEntries = together.reduce((n, r) => n + r.entries, 0);
    check('every bot receives a players_sync tick', together.every(r => r.packets > 0),
        together.map(r => `${r.name}:${r.packets}`).join(' '));
    check('while clustered, each bot sees all six', togetherEntries === together.reduce((n, r) => n + r.packets * 6, 0),
        `${togetherEntries} entries across ${together.reduce((n, r) => n + r.packets, 0)} packets`);

    // --- Phase 2: separate them -------------------------------------------
    console.log(`\n  walking bots 0-2 east to ${FAR.x},${FAR.y} (${EXPECTED_SEPARATION}px apart)...`);
    const walkers = bots.slice(0, 3);
    const stayers = bots.slice(3);
    const walkedOk = await Promise.all(walkers.map(b => walkTo(b, FAR.x, FAR.y)));
    check('the three walkers reached the far side', walkedOk.every(Boolean),
        walkers.map((b, i) => `bot${i}:${b.x},${b.y}`).join(' '));
    const gap = walkers.map(b => Math.max(Math.abs(b.x - stayers[0].x), Math.abs(b.y - stayers[0].y)));
    check('the two groups are further apart than the radius', gap.every(g => g > AOI_RADIUS),
        `separation ${gap.join(',')}px vs radius ${AOI_RADIUS}px`);

    // --- Phase 3: correctness ---------------------------------------------
    console.log('');
    await sleep(1200);
    const separated = await sample(recs, 2000);
    const sepBytes = separated.reduce((n, r) => n + r.bytes, 0);
    const sepEntries = separated.reduce((n, r) => n + r.entries, 0);

    const AOI_ON = AOI_RADIUS > 0;

    // In control mode the AoI-specific expectations are wrong by construction:
    // with filtering off every client holds the whole floor forever, so "a bot
    // holds only its own group" cannot pass and a ghost is impossible. Branching
    // on the mode makes the control run a passing demonstration that the switch
    // works in both directions, instead of a pile of failures that looks alarming
    // and has to be explained away every time it is run.
    if (!AOI_ON) {
        console.log(`  --- control run: AOI_RADIUS is 0, so expectations are the pre-AoI ones ---`);
        const full = recs.map(r => r.entries / Math.max(1, r.packets));
        check('with AoI off, every bot holds the entire floor at all times',
            full.every(n => n === 6),
            `per-tick roster sizes: ${full.map(n => n.toFixed(1)).join(', ')} (want 6 everywhere)`);
        const after = await sample(recs, 2000);
        const stillFull = after.map(r => r.entries / Math.max(1, r.packets));
        check('and stays that way after the groups separate, which is why it is expensive',
            stillFull.every(n => n === 6),
            `per-tick roster sizes: ${stillFull.map(n => n.toFixed(1)).join(', ')} (want 6 everywhere)`);
        const controlBytes = after.reduce((n, r) => n + r.bytes, 0);
        console.log(`\n  --- bytes in players_sync over 2s, separated, no AoI ---`);
        console.log(`    ${controlBytes} bytes`);
        console.log(`    compare against a filtered run of the same probe on the same bot count`);
        for (const b of bots) b.disconnect();
        console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
        process.exit(failures === 0 ? 0 : 1);
    }

    const stayerEntries = separated.slice(3).map(r => r.entries / Math.max(1, r.packets));
    const walkerEntries = separated.slice(0, 3).map(r => r.entries / Math.max(1, r.packets));
    check('a staying bot hears only the three bots near it',
        stayerEntries.every(n => n === 3),
        `per-tick roster sizes: staying ${stayerEntries.map(n => n.toFixed(1)).join(', ')} (want 3)`);
    // The three walkers all walked to the same tile, so they are a cluster of three
    // and each hears the other two. This check expected 1 -- on the reasoning that
    // "the walkers" meant "each alone". They are not alone; they are together. The
    // same mistake was made twice in one session: once in the measure() unit test,
    // where a five-player cluster was treated as five lone players, and once here.
    // Worth stating as a rule: a group of bots given one destination is a cluster,
    // and clusters see each other.
    check('the far group is its own cluster of three and hears nothing else',
        walkerEntries.every(n => n === 3),
        `per-tick roster sizes: walkers ${walkerEntries.map(n => n.toFixed(1)).join(', ')} (want 3, not 1: they walked to the same tile)`);
    check('no bot is told about a player on the other side',
        sepEntries < togetherEntries,
        `separated ${sepEntries} entries vs clustered ${togetherEntries}`);

    // Bot 3's roster while the two groups are apart. This is the baseline the ghost
    // test diffs against, so it has to be captured before anyone rejoins.
    const farSideIds = new Set(recs[3].roster);
    check('while separated, a bot holds only its own group',
        farSideIds.size === 3,
        `bot 3 holds ${JSON.stringify([...farSideIds])}`);

    // --- The ghost test -----------------------------------------------------
    // Brought a bot back in, then sent it away again -- and asserted on the
    // specific id rather than on a count, because "the roster has three entries"
    // can be true for the wrong reason.
    //
    // The previous version walked the *stayers* to a far corner instead. It
    // reported "still holds 6 players" with no positional context, and the
    // positional context said the stayers had walked 52 steps and stopped at
    // (1184,1120) against a target of (2600,2600): the naive axis-first walker
    // gets stuck on obstacles. The returner was therefore still 736px from them,
    // inside the 1000px radius, and seeing all six was CORRECT. The failure was in
    // the walk, not in AoI -- and without the positions it read exactly like a
    // broken AoI.
    //
    // So this walks the returner along the same route the first walkers used,
    // which is known to be reachable, and checks membership by id.
    console.log('\n  the ghost test: bringing one bot back in, then sending it away...');
    const returner = walkers[0];
    await walkTo(returner, stayers[0].x + 96, stayers[0].y);
    await sleep(1400);

    // Identify the returner by id: it is whoever appeared in bot 3's roster that
    // was not there before. Counting entries cannot tell "the right four players"
    // from "some four players".
    const rosterWith = new Set(recs[3].roster);
    const arrived = [...rosterWith].filter(id => !farSideIds.has(id));
    check('a returning bot reappears in the stayers roster',
        arrived.length === 1,
        `stayer 3 went from ${farSideIds.size} to ${rosterWith.size} players; ` +
        `new: ${JSON.stringify(arrived)}`);
    const ghostId = arrived[0];

    // Send it back out along a route already known to be walkable.
    await walkTo(returner, FAR.x, FAR.y);
    await sleep(2400);

    const ghosts = recs[3].roster;
    const distanceAway = Math.max(
        Math.abs(returner.x - stayers[0].x), Math.abs(returner.y - stayers[0].y));
    check('a player left behind is dropped from the roster, not left as a ghost',
        !ghosts.includes(ghostId),
        `${ghostId} walked ${distanceAway}px away (radius ${AOI_RADIUS}); ` +
        `bot 3 still holds ${JSON.stringify(ghosts)}`);
    check('the roster shrinks back to the local group',
        ghosts.length === farSideIds.size,
        `bot 3 holds ${ghosts.length}, the three bots that stayed put hold ${farSideIds.size}`);

    // --- Summary ------------------------------------------------------------
    console.log('\n  --- bytes in players_sync over 2s ---');
    console.log(`    clustered:  ${togetherBytes} bytes, ${togetherEntries} entries`);
    console.log(`    separated:  ${sepBytes} bytes, ${sepEntries} entries`);
    if (AOI_RADIUS > 0) {
        check('separating the players reduces bytes on the wire',
            sepBytes < togetherBytes,
            `${sepBytes} vs ${togetherBytes} bytes, ${(100 - Math.round(sepBytes / togetherBytes * 100))}% less`);
    }

    for (const b of bots) b.disconnect();
    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});
