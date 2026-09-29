/*
 * AC5: a real browser client walking between Z-levels.
 *
 * Every other check of the traversal feature drives a synthetic WebSocket
 * client. Nothing has ever put the actual game client on a different floor, so
 * the one thing nobody has verified is the part a player actually sees: that
 * the shipped client reacts correctly when the server changes its world.
 *
 * The walk is driven the way a player drives it -- a real mouse press on the
 * canvas, which the client's own findPath turns into a route and its own socket
 * turns into `move` packets. Nothing here reaches into the page. A second,
 * spectator socket logs in on the same floor and reads players_sync, which is
 * how the test sees where the browser's character is without instrumenting the
 * client to report on itself.
 *
 * What is under test, and what is not:
 *   - under test: the client's reaction to a floor change -- currentZ, the
 *     cache flush, the new terrain, the redraw, the minimap label, the climb
 *     back out, and the absence of any pageerror along the way.
 *   - not under test: the client's pathfinder. It is exercised incidentally
 *     (the walk only completes if findPath routes onto a ladder) and covered
 *     directly by the unit test asserting it clips to data.bounds.
 *
 * Note on pixel assertions. The map is generated at random per process, so no
 * absolute colour threshold is stable between runs, and the renderer applies a
 * day/night darkness overlay that would confound any claim that one floor is
 * *brighter* than another. Every pixel check here is therefore a differential
 * between this client's own before/after frames, and none of them assert a
 * direction of change.
 */
const { BrowserDriver, finalizeResult } = require('./browser_driver');
const CanvasInspector = require('./canvas_inspector');

const SCREEN_W = 640, SCREEN_H = 480;

let failures = 0;
function check(label, condition, detail) {
    const ok = !!condition;
    if (!ok) failures++;
    console.log(`   ${ok ? '\u2713' : '\u2717'} ${label}${detail ? ` (${detail})` : ''}`);
    return ok;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Grids of sample regions, one per canvas size. They cannot be shared: a grid
// laid out for 640x480 puts every region outside a 150x150 minimap, and
// getImageData past the edge returns transparent black, so the minimap
// comparison would silently read "unchanged" no matter what the client drew.
const SCENE_GRID = [];
for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 6; gx++) {
        SCENE_GRID.push({ x: 20 + gx * 104, y: 20 + gy * 116, w: 40, h: 40 });
    }
}
const MINI_GRID = [];
for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
        MINI_GRID.push({ x: 5 + gx * 36, y: 5 + gy * 36, w: 24, h: 24 });
    }
}
const GRIDS = { '#gameCanvas': SCENE_GRID, '#minimap-canvas': MINI_GRID };

// A screen point that is provably bare ground: outside the floor's own bounds.
//
// The renderer paints the ground #1e1e2f on the surface and #0c0c14 below it.
// Whole-screen brightness cannot tell those apart, because a cave is dark ANYWAY
// -- walls, bedrock and unlit stone dominate the average, so deleting the
// underground fill entirely still leaves the screen looking dark. Measured that
// way, the check passed against a client that had stopped darkening anything.
//
// Inside the cave everything is cave, and on the surface everything is
// buildings, trees and biome rectangles; a sample of either describes that
// scene, not the fill beneath it.
//
// Outside data.bounds there is nothing to draw but the ground fill itself. The
// biome rectangles are gated on currentZ >= 0, the dungeon has no obstacles out
// there (getFloorBounds is computed from the absence of them, and the bedrock
// enclosure sits at or beyond the bounds), and every mob, chest and node is
// floor-scoped to the interior. So whatever colour this pixel is, it is the
// fill. The red channel separates the two cleanly (30 vs 12) and stays
// separable under the day/night overlay, which pulls 12 down to about 11 and 30
// up to about 22.
function bareGroundScreenPoint(snap, inset = 96) {
    const wx = snap.bounds.minX - inset;
    const wy = snap.bounds.minY - inset;
    const cameraX = Math.max(0, Math.min(snap.player.x - SCREEN_W / 2 + 16, snap.mapW - SCREEN_W));
    const cameraY = Math.max(0, Math.min(snap.player.y - SCREEN_H / 2 + 16, snap.mapH - SCREEN_H));
    return { x: wx - cameraX, y: wy - cameraY, worldX: wx, worldY: wy, cameraX, cameraY };
}

// Averaging each region keeps a single unlucky pixel -- a floating combat text,
// a mob sprite, a hover highlight -- from deciding the comparison.
async function sampleScene(page, selector) {
    const grid = GRIDS[selector];
    const out = [];
    for (const s of grid) {
        out.push(await CanvasInspector.sampleAreaAverage(page, s.x, s.y, s.w, s.h, selector));
    }
    return out;
}

function meanLuma(samples) {
    let sum = 0;
    for (const s of samples) sum += (s.r + s.g + s.b) / 3;
    return samples.length ? sum / samples.length : -1;
}

// Fraction of sample regions whose colour moved by more than the tolerance.
// This is the cache-flush proxy at the pixel level: a client that kept drawing
// the surface would leave most regions identical.
function changedFraction(before, after, tolerance = 12) {
    if (!before.length || before.length !== after.length) return -1;
    let changed = 0;
    for (let i = 0; i < before.length; i++) {
        const d = Math.max(
            Math.abs(before[i].r - after[i].r),
            Math.abs(before[i].g - after[i].g),
            Math.abs(before[i].b - after[i].b)
        );
        if (d > tolerance) changed++;
    }
    return changed / before.length;
}

// A spectator socket. It logs in as its own character, which puts it on the
// same floor as the browser, and players_sync therefore carries the browser's
// player as well. That is the only observation channel this test needs, and it
// is a real client talking to a real server -- no internal hooks.
function openSpectator(url, name) {
    const WS = require('ws');
    return new Promise((resolve, reject) => {
        const ws = new WS(url);
        const seen = [];
        const api = {
            ws, seen, name,
            send: (o) => ws.send(JSON.stringify(o)),
            // The MOST RECENT roster the server sent us, and nothing else.
            //
            // Reading backwards through the packet log until a character turns up
            // looks equivalent and is not: it cannot tell "this player is gone
            // from our floor" from "the last roster predates their departure",
            // because both end in an older match. That distinction is the whole
            // point of the checks below -- a floor that keeps listing a player
            // who has left draws a ghost standing in the cave they walked out of.
            latestRoster: () => {
                for (let i = seen.length - 1; i >= 0; i--) {
                    if (seen[i].action === 'players_sync' && Array.isArray(seen[i].players)) {
                        return seen[i].players;
                    }
                }
                return null;
            },
            // Where the named character is, per the newest roster. null means
            // either "no roster yet" or "not on this floor" -- check roster()
            // to tell those apart.
            where: (who) => {
                const roster = api.latestRoster();
                if (!roster) return null;
                const e = roster.find(x => x.name === who);
                return e ? { id: e.id, x: e.x, y: e.y, z: e.z } : null;
            },
            // Ids the server announced as having left this floor, in order.
            playerLeftIds: () => seen
                .filter(p => p.action === 'player_left' && p.id !== undefined)
                .map(p => p.id),
            // This character's own entry, per the newest roster. Used to walk a
            // watcher down to another floor so it can observe that floor's roster
            // independently of the client under test.
            self: () => api.where(api.name),
            onRoster: (who) => {
                const roster = api.latestRoster();
                return !!roster && roster.some(x => x.name === who);
            },
            // Mob ids the server told US about. On the surface that is the
            // surface roster, which is what the browser client must not still be
            // holding after it descends.
            mobIds: () => {
                const ids = new Set();
                for (const p of seen) {
                    if (p.action === 'mob_update' && p.alive) ids.add(p.id);
                }
                return ids;
            }
        };
        ws.on('open', () => resolve(api));
        ws.on('error', reject);
        ws.on('message', raw => {
            let p; try { p = JSON.parse(raw.toString()); } catch { return; }
            seen.push(p);
        });
    });
}

async function login(sock, name, classType) {
    sock.send({ action: 'login', name, class: classType, warmode: false });
    for (let i = 0; i < 50; i++) {
        if (sock.seen.some(p => p.action === 'your_id')) return true;
        await sleep(100);
    }
    return false;
}

const snapshot = page => page.evaluate(() => {
    if (typeof window.__worldSnapshot !== 'function') return null;
    return window.__worldSnapshot();
});

// Waits for the client's world to actually exist.
//
// window.CLIENT_READY is NOT this. It is set inside the first draw(), so it
// means "the render loop started", and at login that can be before the server's
// first map_data has even been received -- the pre-first-frame buffer only
// holds packets that arrived early enough to be caught, and at login most do
// not. Waiting on the flag and then reading the world gets an empty client:
// zero terrain, zero mobs, no bounds. Wait on the world itself.
async function waitForWorld(page, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await snapshot(page);
        if (last && last.bounds && last.obstacles > 0) return last;
        await sleep(100);
    }
    return last;
}

// Clicks a world coordinate on the game canvas, exactly as a player would.
//
// The client turns a click into world coordinates as
//     clickX = e.clientX - rect.left + cameraX
// and derives the camera from its own player position:
//     cameraX = clamp(player.x - SCREEN_W/2 + 16, 0, MAP_W - SCREEN_W)
// Both are read from the page rather than assumed, so a spawn or camera change
// does not silently turn this into a click on empty ground. The position is
// re-read immediately before each click, because the camera only follows the
// player on the next frame after a traversal moves them.
async function clickWorld(page, wx, wy) {
    const snap = await snapshot(page);
    const player = snap && snap.player;
    if (!player) return { ok: false, reason: 'client reported no player position' };

    const cameraX = Math.max(0, Math.min(player.x - SCREEN_W / 2 + 16, snap.mapW - SCREEN_W));
    const cameraY = Math.max(0, Math.min(player.y - SCREEN_H / 2 + 16, snap.mapH - SCREEN_H));
    const rect = await page.evaluate(() => {
        const r = document.getElementById('gameCanvas').getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    const cx = wx - cameraX + rect.left;
    const cy = wy - cameraY + rect.top;

    // The canvas rect is the authority on where the canvas is, not the nominal
    // SCREEN_W/SCREEN_H: the page may scale or centre it, and a click one pixel
    // past the edge silently becomes a click on the page, which then does
    // nothing at all and looks exactly like a broken stairs tile.
    if (cx < rect.left || cx >= rect.left + rect.width ||
        cy < rect.top || cy >= rect.top + rect.height) {
        return {
            ok: false,
            reason: `world ${wx},${wy} maps to ${Math.round(cx)},${Math.round(cy)}, outside the canvas ` +
                `${Math.round(rect.left)}..${Math.round(rect.left + rect.width)} x ${Math.round(rect.top)}..${Math.round(rect.top + rect.height)} ` +
                `(player ${player.x},${player.y}, camera ${cameraX},${cameraY})`,
            cx, cy, cameraX, cameraY
        };
    }

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up();
    return { ok: true, cx, cy, cameraX, cameraY, from: player };
}

// Creates a character that is already strong, then logs it out, so that the
// browser page can log in as it and inherit the level.
//
// Why this exists: the dungeon is deliberately lethal to a level 1 character --
// tier-scaled mobs kill one faster than a heal can land between steps, which is
// correct for the game. A level 1 browser client therefore walks into the cave
// and sometimes does not walk out, which makes the test a coin flip rather than a
// check. Every test_ action applies only to the socket that sent it, and the
// page's socket is sealed inside the client, so the level has to be baked into
// the saved character BEFORE the page exists. Login loads by name, which is what
// makes this possible at all.
//
// Nothing here touches the game's difficulty, and none of it is reachable
// outside TIBIA_TEST_MODE.
async function forgeCharacter(url, name, classType, xp = 400000) {
    const WS = require('ws');
    const connect = () => new Promise((resolve, reject) => {
        const ws = new WS(url);
        const seen = [];
        ws.on('open', () => resolve({ ws, seen }));
        ws.on('error', reject);
        ws.on('message', raw => {
            let p; try { p = JSON.parse(raw.toString()); } catch { return; }
            seen.push(p);
        });
    });

    const first = await connect();
    first.ws.send(JSON.stringify({ action: 'login', name, class: classType, warmode: false }));
    const gotId = await waitFor(() => first.seen.some(p => p.action === 'your_id'), 6000);
    if (!gotId) { try { first.ws.close(); } catch { /* ignore */ } return { ok: false, reason: 'could not log the forging character in' }; }

    first.ws.send(JSON.stringify({ action: 'test_grant_xp', amount: xp }));
    first.ws.send(JSON.stringify({ action: 'test_heal' }));
    const gotStatus = await waitFor(() => {
        const st = [...first.seen].reverse().find(p => p.action === 'status');
        return st && st.level > 1 ? st : null;
    }, 6000);
    if (!gotStatus) { try { first.ws.close(); } catch { /* ignore */ } return { ok: false, reason: 'test_grant_xp had no effect' }; }
    const level = gotStatus.level;

    // Log out so the save runs, then confirm it actually landed. persistPlayer
    // is async, so assuming the write finished when the socket closed is a race:
    // the page would log in a moment later and find a level 1 character.
    first.ws.close();
    for (let attempt = 0; attempt < 25; attempt++) {
        await sleep(200);
        const probe = await connect();
        probe.ws.send(JSON.stringify({ action: 'login', name, class: classType, warmode: false }));
        const inOk = await waitFor(() => probe.seen.some(p => p.action === 'your_id'), 4000);
        const st = inOk && [...probe.seen].reverse().find(p => p.action === 'status');
        probe.ws.close();
        if (st && st.level >= level) return { ok: true, level: st.level };
    }
    return { ok: false, reason: 'the forged level never persisted' };
}

async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const v = predicate();
        if (v) return v;
        await sleep(80);
    }
    return null;
}

async function waitForFloor(page, z, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const cur = await page.evaluate(() => window.currentZ);
        if (cur === z) return true;
        await sleep(120);
    }
    return false;
}

// Walks a synthetic client down to a floor, so the test has an observer that is
// standing on that floor.
//
// This exists because the obvious shortcut does not work: a second watcher that
// simply logs in is on the SURFACE, and can only ever confirm that the browser
// player left. To confirm the player arrived -- which is where the failures
// live -- the observer has to be one floor down, and the only way there is the
// same way a player does it.
//
// It reads its own position from its own players_sync entry rather than from
// local knowledge of the map, because the map is generated at random per
// process: anything this process computed about the world would be a different
// world from the one the server is running.
async function walkWatcherDown(sock, z, tx, ty, budgetMs = 30000) {
    const deadline = Date.now() + budgetMs;
    let stuck = 0;
    while (Date.now() < deadline) {
        const me = sock.self();
        if (me && me.z === z) return 'arrived';
        if (!me) { await sleep(120); continue; }
        const dx = tx - me.x, dy = ty - me.y;
        if (dx === 0 && dy === 0) { await sleep(150); continue; }
        const useX = Math.abs(dx) >= Math.abs(dy);
        const before = `${me.x},${me.y}`;
        sock.send({
            action: 'move',
            x: useX ? me.x + 32 * Math.sign(dx) : me.x,
            y: useX ? me.y : me.y + 32 * Math.sign(dy)
        });
        await sleep(340);
        const after = sock.self();
        if (after && `${after.x},${after.y}` === before) {
            if (++stuck > 6) return 'blocked';
        } else stuck = 0;
    }
    return 'blocked';
}

async function runDescentTest(options = {}) {
    const port = options.port || 8080;
    const headless = options.headless !== undefined ? options.headless : true;
    // CFG is safe to read: it is configuration, identical in every process.
    // server/map.js deliberately is NOT. Requiring it here would generate a
    // SECOND, differently-randomised dungeon in this process, and the test would
    // then assert against a cave that does not exist on the server it is talking
    // to. Every floor-specific fact below therefore comes from the client or the
    // spectator, both of which were told the truth by the server.
    const CFG = require('../../server/config');

    const driver = new BrowserDriver({ port, headless });
    const charName = `Delver${Math.random().toString(36).substring(2, 6)}`;
    let spectator = null;
    let deepWatcher = null;
    let keepAlive = null;

    console.log(`\n=============================================================`);
    console.log(`🪜  [AC5] Starting Z-Level Descent Browser Test`);
    console.log(`   Port: ${port} | Headless: ${headless} | Character: ${charName}`);
    console.log(`=============================================================\n`);

    try {
        await driver.init();

        const url = `ws://127.0.0.1:${port}`;

        // Forge the character the browser will use, before the page exists.
        const forged = await forgeCharacter(url, charName, 'warrior');
        check('pre-created a survivable character for the browser to log in as',
            forged.ok, forged.ok ? `saved at level ${forged.level}` : forged.reason);
        if (!forged.ok) throw new Error(`could not prepare the character: ${forged.reason}`);

        const agent = await driver.createAgentPage({ charName, classType: 'warrior', autoLogin: true });
        const page = agent.page;

        const ready = await page.waitForFunction('window.CLIENT_READY === true', { timeout: 25000 })
            .then(() => true).catch(() => false);
        check('the real client reached CLIENT_READY', ready);
        if (!ready) throw new Error('client never became ready');

        const startZ = await page.evaluate(() => window.currentZ);
        check('the real client starts on the surface', startZ === CFG.Z_SURFACE, `window.currentZ=${startZ}`);

        const snapSurface = await waitForWorld(page);
        check('the client exposes a readable world snapshot', !!snapSurface,
            snapSurface ? `mobs=${snapSurface.mobs} obstacles=${snapSurface.obstacles}` : 'window.__worldSnapshot missing');
        if (!snapSurface) throw new Error('client exposes no world snapshot; cannot verify the cache flush');
        check('the client received its terrain before anything was asserted about it',
            !!(snapSurface.bounds && snapSurface.obstacles > 0),
            `bounds=${JSON.stringify(snapSurface.bounds)} obstacles=${snapSurface.obstacles}`);
        if (!snapSurface.bounds) throw new Error('client never received map_data; nothing below can be trusted');

        check('the surface roster is populated, so a failed flush would be visible',
            snapSurface.mobs > 0, `${snapSurface.mobs} mobs on the surface`);
        check('the client has the surface ladder in its terrain',
            snapSurface.obstacleTypes.includes('ladder'), snapSurface.obstacleTypes.join(','));
        check('the client knows the ladder is a way down',
            snapSurface.transitions.some(t => t.x === CFG.LADDER_X && t.y === CFG.LADDER_Y && t.to === CFG.Z_DUNGEON),
            JSON.stringify(snapSurface.transitions));

        const surfacePixels = await sampleScene(page, '#gameCanvas');
        const surfaceMini = await sampleScene(page, '#minimap-canvas');
        const surfaceLuma = meanLuma(surfacePixels);
        const surfaceMiniLuma = meanLuma(surfaceMini);
        // Captured here, before the walk, because the label is the minimap's
        // strongest floor-dependent signal and there is only one chance to
        // photograph the "before".
        const surfaceLabel = await CanvasInspector.sampleAreaAverage(page, 45, 135, 60, 14, '#minimap-canvas');

        spectator = await openSpectator(url, `Watcher${Math.random().toString(36).substring(2, 6)}`);
        check('opened a spectator connection', await login(spectator, spectator.name, 'ranger'));
        await sleep(800);

        const startAt = spectator.where(charName);
        check('the spectator can see the browser player in players_sync', !!startAt,
            startAt ? `id=${startAt.id} at ${startAt.x},${startAt.y},z=${startAt.z}` : 'absent from the newest roster');
        if (!startAt) throw new Error('spectator cannot see the browser player');
        const browserId = startAt.id;

        // A second watcher, which follows the player down. A watcher that merely
        // logs in is on the surface and can only ever confirm the player LEFT.
        // Confirming the player ARRIVED needs an observer standing on the
        // dungeon, so this one walks down the same ladder -- the same traversal
        // every other client performs, not a back door into the floor.
        deepWatcher = await openSpectator(url, 'DeepWatcher');
        check('opened a second watcher to observe the dungeon', await login(deepWatcher, 'DeepWatcher', 'ranger'));
        await sleep(300);
        // Level it BEFORE it goes down. The dungeon kills a level 1 character
        // quickly, and a dead watcher respawns on the surface -- after which it is
        // no longer observing the dungeon, but the checks below would go on
        // reading the surface roster while believing they were reading the
        // dungeon's. That failure mode looks exactly like a server bug.
        deepWatcher.send({ action: 'test_grant_xp', amount: 400000 });
        deepWatcher.send({ action: 'test_heal' });
        await sleep(400);
        const walked = await walkWatcherDown(deepWatcher, CFG.Z_DUNGEON, CFG.LADDER_X, CFG.LADDER_Y);
        const deepAt = deepWatcher.self();
        check('the second watcher walked down to the dungeon too', walked === 'arrived',
            walked === 'arrived' ? `standing at ${deepAt.x},${deepAt.y},z=${deepAt.z}` : `${walked} at ${deepAt && deepAt.x},${deepAt && deepAt.y},z=${deepAt && deepAt.z}`);
        if (walked !== 'arrived') throw new Error('no independent observer on the dungeon floor');

        // Keep it standing. Heals only while it is below the surface, so this
        // cannot paper over a problem on the surface.
        keepAlive = setInterval(() => {
            const me = deepWatcher && deepWatcher.self();
            if (me && me.z < 0) deepWatcher.send({ action: 'test_heal' });
        }, 120);

        const surfaceMobIds = [...spectator.mobIds()];
        check('the spectator learned the surface mob roster',
            surfaceMobIds.length > 0, `${surfaceMobIds.length} surface mob ids`);
        check('the client and the server agree on the surface mob count',
            snapSurface.mobs === surfaceMobIds.length,
            `client=${snapSurface.mobs} server=${surfaceMobIds.length}`);

        // The mousedown handler bails out if a modal is up, which would make the
        // click a no-op and the failure look like a broken ladder.
        const overlay = await page.evaluate(() => {
            const el = document.getElementById('overlay');
            return el ? el.style.display : 'absent';
        });
        check('no modal is blocking the canvas', overlay !== 'block', `overlay display=${overlay}`);

        // --- descend by walking onto the ladder --------------------------
        let click = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            click = await clickWorld(page, CFG.LADDER_X, CFG.LADDER_Y);
            if (!click.ok) break;
            if (await waitForFloor(page, CFG.Z_DUNGEON, 4000)) break;
            // A mob, corpse or ground item standing on the ladder tile makes the
            // click an attack instead of a move. The world is generated at
            // random, so that is a real possibility and not a bug -- retry.
            await sleep(400);
        }
        check('the ladder was on screen and clickable',
            !!click && click.ok, click && click.ok
                ? `screen ${Math.round(click.cx)},${Math.round(click.cy)} for world ${CFG.LADDER_X},${CFG.LADDER_Y} (from ${click.from.x},${click.from.y})`
                : (click && click.reason) || 'no click attempted');

        const descended = await waitForFloor(page, CFG.Z_DUNGEON, 6000);
        check('the real client changed floor after walking onto the ladder', descended,
            `window.currentZ=${await page.evaluate(() => window.currentZ)}, wanted ${CFG.Z_DUNGEON}`);

        if (!descended) {
            // Report where it actually got to, so a failure is diagnosable
            // rather than just red.
            const where = spectator.where(charName);
            const endSnap = await snapshot(page);
            check('diagnostic: the character stayed on the surface', !!where && where.z === CFG.Z_SURFACE,
                `server says z=${where && where.z} at ${where && where.x},${where && where.y}; ` +
                `client player at ${endSnap && endSnap.player && endSnap.player.x},${endSnap && endSnap.player && endSnap.player.y}`);
            return finalizeResult(driver, { success: false, durationMs: 0 });
        }

        // Let a few roster ticks go by. The checks below read the NEWEST roster,
        // so they must not race the next broadcast.
        await sleep(900);

        // A player who walked into the cave must stop being part of the street.
        // This is the check that a backwards scan through the packet log cannot
        // make: the surface roster either drops the character or keeps listing
        // it, and if it keeps listing it every client left behind is drawing a
        // ghost of a player who is a floor down.
        check('the surface roster dropped the player who descended',
            !spectator.onRoster(charName),
            `newest surface roster has ${(spectator.latestRoster() || []).length} players, ` +
            `including ours: ${spectator.onRoster(charName)}`);

        // The roster above is rebuilt every 200ms, so on its own it cannot tell
        // "removed at once" from "removed within a tick". performTraversal
        // broadcasts player_left BEFORE re-syncing precisely so that a surface
        // player is not left staring at a body standing on the open hole for a
        // fifth of a second, so assert the event itself.
        check('the surface was told immediately, not just on the next roster tick',
            spectator.playerLeftIds().includes(browserId),
            `player_left ids seen by the surface watcher: ${spectator.playerLeftIds().join(',') || '(none)'}`);

        const at = deepWatcher.where(charName);
        check('the dungeon roster lists the player at the arrival point', !!at && at.z === CFG.Z_DUNGEON,
            at ? `z=${at.z} at ${at.x},${at.y}` : 'not in the newest dungeon roster');

        const snapDeep = await snapshot(page);
        check('the client tracks the new floor index', snapDeep && snapDeep.z === CFG.Z_DUNGEON,
            `snapshot z=${snapDeep && snapDeep.z}`);

        // The load-bearing assertion. Comparing ids, not counts: a client that
        // kept the surface roster and merged the dungeon's on top would report a
        // perfectly plausible mob count, so only id disjointness can tell the
        // two cases apart.
        const survivors = snapDeep.mobIds.filter(id => surfaceMobIds.includes(id));
        check('the client dropped every surface mob from its roster',
            survivors.length === 0,
            survivors.length ? `still holding ${survivors.length} surface ids` : `0 of ${surfaceMobIds.length} surface ids survive`);
        check('the client was given the dungeon roster', snapDeep.mobs > 0, `${snapDeep.mobs} dungeon mobs`);

        const sameBounds = (a, b) => !!a && !!b && a.minX === b.minX && a.maxX === b.maxX &&
            a.minY === b.minY && a.maxY === b.maxY;
        check('the client swapped to a different, smaller set of terrain bounds',
            !!snapDeep.bounds && !sameBounds(snapDeep.bounds, snapSurface.bounds) &&
            (snapDeep.bounds.maxX - snapDeep.bounds.minX) < (snapSurface.bounds.maxX - snapSurface.bounds.minX),
            `surface ${snapSurface.bounds.minX}..${snapSurface.bounds.maxX} -> dungeon ${snapDeep.bounds && snapDeep.bounds.minX}..${snapDeep.bounds && snapDeep.bounds.maxX}`);
        check('the client arrived inside the dungeon bounds, not merely told about it',
            !!at && !!snapDeep.bounds &&
            snapDeep.bounds.minX <= at.x && at.x <= snapDeep.bounds.maxX &&
            snapDeep.bounds.minY <= at.y && at.y <= snapDeep.bounds.maxY,
            `player at ${at && at.x},${at && at.y}, bounds ${snapDeep.bounds && snapDeep.bounds.minX}..${snapDeep.bounds && snapDeep.bounds.maxX} x ${snapDeep.bounds && snapDeep.bounds.minY}..${snapDeep.bounds && snapDeep.bounds.maxY}`);

        // --- the client actually drew the new world -----------------------
        const deepPixels = await sampleScene(page, '#gameCanvas');
        const changed = changedFraction(surfacePixels, deepPixels);
        check('the client redrew the scene for the new floor', changed >= 0.5,
            `${Math.round(changed * 100)}% of ${surfacePixels.length} sampled regions changed, luma ${Math.round(surfaceLuma)} -> ${Math.round(meanLuma(deepPixels))}`);
        // The ground fill, sampled where nothing is drawn over it. One-sided by
        // design: the surface has no comparable bare-ground point, because the
        // biome rectangles cover it, and inventing one is what made the previous
        // version of this check measure the city instead of the fill.
        const bare = bareGroundScreenPoint(snapDeep);
        const barePixel = await CanvasInspector.getPixel(page, bare.x, bare.y, '#gameCanvas');
        check('the ground is painted with the darker underground fill outside the cave',
            barePixel.r < 20,
            `bare ground at world ${bare.worldX},${bare.worldY} (screen ${Math.round(bare.x)},${Math.round(bare.y)}) ` +
            `is rgb(${barePixel.r},${barePixel.g},${barePixel.b}); the underground fill is 12 and the surface fill is 30`);

        // The minimap gets two separate checks, because its two halves carry
        // very different amounts of signal.
        //
        // The floor LABEL is the strong one: renderer.js draws "Surface" or
        // "Z: -1" as text, after the circular clip is released, at a fixed spot
        // at the bottom. Different words, so the pixels there cannot match.
        const labelStrip = async () => CanvasInspector.sampleAreaAverage(page, 45, 135, 60, 14, '#minimap-canvas');
        const deepLabel = await labelStrip();
        const labelDelta = Math.max(
            Math.abs(surfaceLabel.r - deepLabel.r),
            Math.abs(surfaceLabel.g - deepLabel.g),
            Math.abs(surfaceLabel.b - deepLabel.b));
        check('the minimap floor label changed when the floor changed', labelDelta > 8,
            `label strip rgb(${surfaceLabel.r},${surfaceLabel.g},${surfaceLabel.b}) -> rgb(${deepLabel.r},${deepLabel.g},${deepLabel.b}), max channel delta ${labelDelta}`);

        // The terrain is the weak one, and deliberately so: the backdrop is a
        // flat #1b2a1f and obstacles are 2x2 dots at 0.16 alpha, so a region
        // average barely moves even when every dot has been replaced. A low
        // tolerance is required here; a high one reports "unchanged" for a
        // minimap that is in fact being redrawn correctly.
        const deepMini = await sampleScene(page, '#minimap-canvas');
        const miniChanged = changedFraction(surfaceMini, deepMini, 3);
        check('the minimap redrew its terrain for the new floor', miniChanged >= 0.15,
            `${Math.round(miniChanged * 100)}% of ${surfaceMini.length} minimap regions changed, luma ${Math.round(surfaceMiniLuma)} -> ${Math.round(meanLuma(deepMini))}`);

        // --- climb back out ----------------------------------------------
        const exit = snapDeep.transitions.find(t => t.to === CFG.Z_SURFACE);
        check('the dungeon offers a way back up', !!exit,
            exit ? `${exit.type} at ${exit.x},${exit.y}` : `no transition to the surface among ${snapDeep.transitions.length}`);

        let climbed = false;
        if (exit) {
            let upClick = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                upClick = await clickWorld(page, exit.x, exit.y);
                if (!upClick.ok) break;
                if (await waitForFloor(page, CFG.Z_SURFACE, 4000)) break;
                await sleep(400);
            }
            check('the way up was on screen and clickable',
                !!upClick && upClick.ok, upClick && upClick.ok
                    ? `screen ${Math.round(upClick.cx)},${Math.round(upClick.cy)} for world ${exit.x},${exit.y}`
                    : (upClick && upClick.reason) || 'no click attempted');
            climbed = await waitForFloor(page, CFG.Z_SURFACE, 6000);
            check('the real client climbed back to the surface', climbed,
                `window.currentZ=${await page.evaluate(() => window.currentZ)}`);
        }

        if (climbed) {
            await sleep(900);
            const back = spectator.where(charName);
            check('the server put the character back on the surface roster',
                !!back && back.z === CFG.Z_SURFACE,
                back ? `z=${back.z} at ${back.x},${back.y}` : 'absent from the newest surface roster');
            // Both watchers should agree, and the dungeon should be empty of the
            // player. The observer's own floor is checked first: if it died and
            // respawned on the surface it would be reading the surface roster,
            // and reporting that as a server bug would be wrong.
            const deepSelf = deepWatcher.self();
            const observerAlive = !!deepSelf && deepSelf.z === CFG.Z_DUNGEON;
            const deepRoster = (deepWatcher.latestRoster() || []).map(p => `${p.name}@${p.x},${p.y},z=${p.z}`);
            check('the dungeon observer was still in the dungeon when this was checked',
                observerAlive, observerAlive
                    ? `observer at ${deepSelf.x},${deepSelf.y},z=${deepSelf.z}`
                    : `observer is at z=${deepSelf && deepSelf.z} (${deepSelf && deepSelf.x},${deepSelf && deepSelf.y}) -- it died and respawned, so its roster is the SURFACE's`);
            check('the dungeon roster dropped the player who climbed out',
                observerAlive && !deepWatcher.onRoster(charName),
                `dungeon roster: ${deepRoster.join(', ') || '(empty)'}`);
            check('the dungeon was told immediately that the player left',
                deepWatcher.playerLeftIds().includes(browserId),
                `player_left ids seen by the dungeon watcher: ${deepWatcher.playerLeftIds().join(',') || '(none)'}`);

            const snapBack = await snapshot(page);
            // The flush has to work in both directions. A client that cleared on
            // the way down but not on the way up would pass every check above,
            // so the ascent gets the same id-level treatment.
            const backSurface = snapBack.mobIds.filter(id => surfaceMobIds.includes(id));
            const backDungeon = snapBack.mobIds.filter(id => snapDeep.mobIds.includes(id));
            check('the client restored the surface roster on the way up',
                backSurface.length > 0 && backDungeon.length === 0,
                `holding ${backSurface.length} surface ids and ${backDungeon.length} dungeon ids`);
            check('the client restored the surface terrain bounds',
                sameBounds(snapBack.bounds, snapSurface.bounds),
                `client=${JSON.stringify(snapBack.bounds)} surface=${JSON.stringify(snapSurface.bounds)}`);
        }

        return finalizeResult(driver, { success: failures === 0, durationMs: 0 });
    } catch (err) {
        failures++;
        console.error('   \u2717 AC5 crashed:', err && err.stack ? err.stack : err);
        return finalizeResult(driver, { success: false, error: String((err && err.message) || err), durationMs: 0 });
    } finally {
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
        try { if (spectator && spectator.ws.readyState === 1) spectator.ws.close(); } catch { /* ignore */ }
        try { if (deepWatcher && deepWatcher.ws.readyState === 1) deepWatcher.ws.close(); } catch { /* ignore */ }
        try { await driver.close(); } catch { /* ignore */ }
    }
}

module.exports = { runDescentTest, run: runDescentTest };
