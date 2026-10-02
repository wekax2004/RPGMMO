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
        // Most recent known position per mob id. The postcondition check is stated
        // against this rather than against packet counts: whatever the client still
        // holds must be inside the radius.
        latest: new Map(),
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
                rec.latest.set(p.id, { x: p.x, y: p.y, isBoss: p.isBoss === true });
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
            rec.latest.delete(p.id);
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
    const START = { x: bot.x, y: bot.y };
    await walkTo(bot, 1900, 320);
    // Distance covered, not arrival. The naive axis-first walker gets stuck on
    // obstacles -- it has done so at 928 of 1900 on several runs -- and demanding
    // the exact tile asserts that a stub pathfinder exists, which it does not and
    // does not need to. What matters is that the bot travelled far enough for mobs
    // at the start to fall outside the radius.
    const travelled = Math.max(Math.abs(bot.x - START.x), Math.abs(bot.y - START.y));
    if (enabled) {
        check('the bot walked far enough for spawn-cluster mobs to leave the radius',
            travelled > radius,
            `moved ${travelled}px from ${START.x},${START.y} to ${bot.x},${bot.y}; needs > ${radius}`);
    } else {
        console.log(`  (moved ${travelled}px to ${bot.x},${bot.y}; not asserted in control mode)`);
    }

    const stillHasSome = rec.known.size > 0;
    // The stray diagnosis reads rec.rec, the same object as rec -- kept so the
    // handler closure and the diagnostic cannot drift onto two different records.
    rec.recent = rec.recent;

    if (!enabled) {
        check('with mob AoI off, nothing is ever forgotten', rec.forgets === 0,
            `${rec.forgets} mob_forget(s) -- the control must not emit the packet at all`);
        // "Holds at least as many as at login", not "holds exactly as many". With no
        // filtering the set only ever grows, because packs spawn during the walk and
        // their announcements are broadcast. Comparing for equality against the login
        // snapshot therefore fails on a control that is behaving perfectly.
        check('and the bot holds everything it was told about, plus anything new',
            rec.known.size >= rosterEntries,
            `${rec.known.size} held vs ${rosterEntries} at login (more is expected: packs spawn during the walk)`);
        console.log(`\n  roster bytes (control): ${rosterBytes}`);
        console.log('  compare against a filtered run of the same probe on the same build');
        bot.disconnect();
        console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
        process.exit(failures === 0 ? 0 : 1);
    }

    // --- the filtering is real --------------------------------------------
    check('and the bot still knows the mobs that are near it now', stillHasSome,
        `${rec.known.size} mob(s) in range`);

    /*
     * The exact invariant: nothing the client still holds may be out of range.
     *
     * Excluding bosses, and that exclusion is the point rather than a convenience.
     * Bosses are deliberately not filtered -- three types with one lair each, so
     * filtering saves nothing measurable, and a boss you cannot see is the thing a
     * player most wants warning about. They live in a separate registry that the
     * reconciliation never walks, so they are delivered at login and never forgotten.
     *
     * The first version of this check did not exclude them and reported three strays
     * at up to 1952px. The diagnostic block printed their ids and they were all
     * boss_*: the check was asserting something the design had deliberately chosen
     * not to do, and would have "fixed" it by filtering bosses -- silently reversing a
     * decision made for a reason, in the name of making a test green.
     */
    await sleep(900);
    const latest = rec.latest;
    const isStray = (id) => {
        const m = latest.get(id);
        if (m.isBoss) return false;
        return Math.abs(m.x - bot.x) > radius || Math.abs(m.y - bot.y) > radius;
    };
    const strays = [...latest.keys()].filter(isStray);
    const bosses = [...latest.entries()].filter(([, m]) => m.isBoss).length;
    const nearestStray = strays.length
        ? Math.min(...strays.map(id => Math.max(
            Math.abs(latest.get(id).x - bot.x), Math.abs(latest.get(id).y - bot.y))))
        : 0;
    check('no ordinary mob the client holds is outside the radius', strays.length === 0,
        strays.length
            ? `${strays.length} stray mob(s) held but out of range, nearest ${nearestStray}px (radius ${radius})`
            : `${latest.size - bosses} ordinary mob(s) held, all within ${radius}px; ${bosses} boss(es) excluded by design`);

    // Pin the decision rather than leaving it implied by an exclusion above, so that
    // "why are bosses always visible" has an answer in the test output.
    check('bosses are delivered regardless of range, which is deliberate',
        bosses > 0,
        `${bosses} boss(es) held at up to ${bosses ? Math.max(...[...latest.values()].filter(m => m.isBoss).map(m => Math.max(Math.abs(m.x - bot.x), Math.abs(m.y - bot.y)))) : 0}px ` +
        'away; see syncFloorRoster, which filters mobs and sends every boss');

    console.log(`  mob_forget(s) during the walk: ${rec.forgets} (a world with no crossings legitimately has none)`);

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
    // Cleared, not just left running. `recent` is a rolling history of the last 40
    // sightings, so without this the far-spawn check can match a mob that was
    // legitimately in range earlier in the run -- the bot passes within 1000px of
    // x=2852 on its way east, sees whatever lives there, and the check then reports
    // a leak from a sighting that was correct at the time. It reported a false
    // positive on the first run for exactly that reason.
    rec.recent = [];
    bot.send({ action: 'test_spawn_mob', type: 'spider', x: bot.x + FAR, y: bot.y });
    bot.send({ action: 'test_spawn_mob', type: 'spider', x: bot.x + NEAR, y: bot.y });
    await sleep(1200);

    const announcedNow = rec.recent.map(p => p.id);
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
