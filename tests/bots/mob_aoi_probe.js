/*
 * tests/bots/mob_aoi_probe.js
 *
 * Measures mob area of interest over a real socket (roadmap 7.2, mobs).
 *
 * WHAT IS AND IS NOT MEASURABLE HERE, stated up front so the numbers are not
 * over-read.
 *
 * The deterministic win is the floor roster: on login the server used to send every
 * mob on the floor, which on the surface is around forty entries. With a radius of
 * 1000 on a 3200x3200 map that is roughly a third of them. That is measured.
 *
 * The movement traffic is NOT measured meaningfully from the safe zone, because mobs
 * will not walk toward a player standing in it -- server.js skips players for whom
 * inSafeZone is true -- so there is no movement to send either way and the filtered
 * and unfiltered figures come out the same. Measuring it needs a bot outside the
 * safe zone, where it will be eaten by the thing it is measuring. Both runs of this
 * probe therefore report the roster figure and say plainly that the movement figure
 * is not covered.
 *
 * The correctness checks are the point, not the saving. Three properties, each of
 * which a plausible-looking implementation gets wrong:
 *
 *   - a mob in range is announced with the ordinary mob_update packet, so the client
 *     needs no new handler to SEE a mob
 *   - a mob that leaves is announced with mob_forget, because the existing way to
 *     drop a mob is alive:false, which the client also reads as death and now plays a
 *     blood-burst effect for
 *   - a mob that was out of range when the player arrived still appears when the
 *     player walks over to it, which is the thing there is no periodic sync for
 *
 * Run: node tests/bots/mob_aoi_probe.js --port=8141
 */

const BotClient = (() => {
    try { return require('./bot_client'); } catch (e) { return require('./bot_client.js'); }
})();

function readPort(argv) {
    const eq = argv.find(a => a.startsWith('--port='));
    if (eq) return Number(eq.split('=')[1]);
    const i = argv.indexOf('--port');
    if (i > -1 && argv[i + 1]) return Number(argv[i + 1]);
    return 8141;
}

const PORT = readPort(process.argv.slice(2));
const CFG = require('../../server/config');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TILE = 32;

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

/** Counts mob packets and remembers which mob ids the bot knows about. */
function watch(bot) {
    const rec = {
        bytes: 0, upserts: 0, forgets: 0, deaths: 0,
        known: new Set(),
        // Where the viewer was when each mob was announced, for the leak check.
        announced: [],
        // A short rolling history of sightings with coordinates.
        recent: [],
        // Off until the login roster has settled and the position is known.
        recording: false
    };
    const sock = bot.ws;
    const handle = (raw) => {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
        const n = typeof raw === 'string' ? raw.length : String(raw).length;
        if (p.action === 'mob_update') {
            rec.bytes += n; rec.upserts++;
            if (p.alive) {
                rec.known.add(p.id);
                // Always keep a short history of the most recent sightings with their
                // coordinates, so the controlled spawn experiment can find a mob by
                // where it appeared rather than by guessing an id.
                rec.recent.push({ id: p.id, x: p.x, y: p.y });
                if (rec.recent.length > 40) rec.recent.shift();
                // Only sample announcements once the viewer position is actually
                // known. The login roster arrives before the first position packet
                // has been processed, so recording then compares every mob against
                // bot.x === 0 and reports a 1728px "leak" for a mob that was 600px
                // from a player standing at 320,320. A check that cries wolf on the
                // login path is a check that gets ignored on the path that matters.
                if (rec.recording) {
                    rec.announced.push({ id: p.id, x: p.x, y: p.y, viewerX: bot.x, viewerY: bot.y });
                }
            } else {
                // alive:false is a death, and must not be counted as a sighting.
                rec.deaths++;
            }
        } else if (p.action === 'mob_forget') {
            rec.bytes += n; rec.forgets++;
            rec.known.delete(p.id);
        }
    };
    if (typeof sock.addEventListener === 'function') sock.addEventListener('message', e => handle(e.data));
    else if (typeof sock.on === 'function') sock.on('message', d => handle(d));
    return rec;
}

/** Walks a bot toward a point, one legal tile at a time. */
async function walkTo(bot, tx, ty, maxSteps = 80) {
    for (let i = 0; i < maxSteps; i++) {
        if (Math.abs(bot.x - tx) <= TILE && Math.abs(bot.y - ty) <= TILE) return true;
        const before = `${bot.x},${bot.y}`;
        bot.stepToward(tx, ty);
        await sleep(340);
        if (`${bot.x},${bot.y}` === before) await sleep(150);   // blocked; let the walker retry
    }
    return false;
}

async function main() {
    const radius = CFG.MOB_AOI_RADIUS;
    const enabled = radius > 0;
    console.log(`=== mob AoI probe (port ${PORT}, MOB_AOI_RADIUS=${radius}) ===\n`);
    console.log(`  mode: ${enabled ? 'FILTERED' : 'full floor (pre-AoI control)'}\n`);

    const tag = Math.random().toString(36).slice(2, 7);
    const bot = new BotClient({ name: `MobAoi_${tag}` });
    await bot.connect(`ws://localhost:${PORT}`, 10000);
    const rec = watch(bot);
    await bot.login(bot.charName, 'warrior', false, 20000);

    // --- the roster ---------------------------------------------------------
    await sleep(1500);
    const rosterEntries = rec.known.size;
    const rosterBytes = rec.bytes;
    console.log(`  roster: ${rosterEntries} mob(s) known, ${rosterBytes} bytes`);
    // From here on the position is known, so announcements can be range-checked.
    rec.recording = true;

    // Steadily walk east, away from the spawn cluster, and watch what crosses.
    rec.forgets = 0;
    rec.bytes = 0;
    const walked = await walkTo(bot, 1900, 320);
    // Only a failure when filtering is on. With it off, how far the bot walked has no
    // bearing on anything, and the naive axis-first walker reliably gets stuck on an
    // obstacle partway -- so asserting it here would fail the control run for a reason
    // that has nothing to do with mob AoI.
    if (enabled) {
        check('the bot walked away from the spawn cluster', walked, `now at ${bot.x},${bot.y}`);
    } else {
        console.log(`  (walked to ${bot.x},${bot.y}; not asserted in control mode)`);
    }

    const forgotSome = rec.forgets > 0;
    const stillHasSome = rec.known.size > 0;
    console.log(`\n  after walking: ${rec.known.size} mob(s) known, ${rec.forgets} mob_forget(s), ${rec.bytes} bytes`);

    if (!enabled) {
        check('with mob AoI off, nothing is ever forgotten', rec.forgets === 0,
            `${rec.forgets} mob_forget(s) -- the control must not emit the packet at all`);
        check('and the bot still knows every mob on the floor', rec.known.size === rosterEntries,
            `${rec.known.size} vs ${rosterEntries} at login`);
        console.log(`\n  roster bytes (control): ${rosterBytes}`);
        console.log('  compare against a filtered run of the same probe on the same build');
        bot.disconnect();
        console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
        process.exit(failures === 0 ? 0 : 1);
    }

    // --- the filtering is real --------------------------------------------
    check('walking away sends mob_forget for the mobs left behind', forgotSome,
        `${rec.forgets} mob_forget(s) after walking to ${bot.x},${bot.y}; ${rec.known.size} still known`);
    check('and the bot still knows the mobs that are near it now', stillHasSome,
        `${rec.known.size} mob(s) in range`);

    // A mob still in range must be re-announced when the player comes back. The
    // baseline is the roster at login, not the count at the far position: returning
    // to the spawn cluster can legitimately yield *fewer* mobs than standing in the
    // middle of the map, so comparing against the far count asserted that the world
    // gets more crowded the more of it you can see.
    const backOk = await walkTo(bot, 320, 320);
    await sleep(1200);
    check('returning re-announces the mobs around the spawn point',
        backOk && rec.known.size >= rosterEntries,
        `walked back to ${bot.x},${bot.y}; known is ${rec.known.size}, the login roster was ${rosterEntries}`);

    // --- nothing was ever declared dead ------------------------------------
    // The whole reason mob_forget exists: alive:false means death to the client and
    // now plays a blood burst. Walking around must not kill anything.
    check('walking around never reports a mob as dead', rec.deaths === 0,
        `${rec.deaths} death packet(s) -- the removal path is bleeding into the death packet`);

    // --- a controlled experiment, independent of world generation -----------
    // The byte figures above compare two separately seeded worlds: 40 mobs on one
    // floor and 11 within range is indicative, not controlled, because the mob layout
    // is randomised per server start. This is the controlled version. Spawn a mob at a
    // known distance on each side of the boundary and assert it is announced or not.
    // It does not depend on how the world happened to be generated.
    const FAR = 2500, NEAR = 200;
    rec.recording = false;
    bot.send({ action: 'test_spawn_mob', type: 'spider', x: bot.x + FAR, y: bot.y });
    bot.send({ action: 'test_spawn_mob', type: 'spider', x: bot.x + NEAR, y: bot.y });
    await sleep(1200);

    const announcedNow = (rec.recent || []).map(p => p.id);
    const nearOnes = announcedNow.filter(id => {
        const a = rec.recent.find(p => p.id === id);
        return a && Math.abs(a.x - (bot.x + NEAR)) <= TILE;
    });
    const farOnes = announcedNow.filter(id => {
        const a = rec.recent.find(p => p.id === id);
        return a && Math.abs(a.x - (bot.x + FAR)) <= TILE;
    });

    check('a mob spawned within the radius is announced', nearOnes.length > 0,
        `${nearOnes.length} announcement(s) at ${NEAR}px; the stream carried ${announcedNow.length}`);
    check('a mob spawned beyond the radius is not announced', farOnes.length === 0,
        farOnes.length ? `LEAK: ${farOnes.length} announcement(s) at ${FAR}px with radius ${radius}`
            : `nothing sent for a mob ${FAR}px away (radius ${radius})`);

    // --- no leak on the real path ------------------------------------------
    rec.recording = true;
    const SLACK = 96;
    const tooFar = rec.announced.filter(a =>
        Math.abs(a.x - a.viewerX) > radius + SLACK || Math.abs(a.y - a.viewerY) > radius + SLACK);
    check('no mob outside the radius was ever announced', tooFar.length === 0,
        tooFar.length ? `${tooFar.length} leak(s), nearest was ` +
            `${Math.min(...tooFar.map(t => Math.max(Math.abs(t.x - t.viewerX), Math.abs(t.y - t.viewerY))))}px away (radius ${radius})`
            : `${rec.announced.length} announcement(s), all within ${radius}px of the viewer`);

    console.log(`\n  ${rec.known.size} mobs known with a radius of ${radius}; ` +
        `roster at login was ${rosterEntries}`);
    console.log(`\n  roster bytes (filtered): ${rosterBytes}`);
    console.log('  compare against a control run of the same probe (TIBIA_MOB_AOI_RADIUS=0)');

    bot.disconnect();
    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});
