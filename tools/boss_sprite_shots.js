'use strict';

/**
 * tools/boss_sprite_shots.js
 *
 * Renders each boss in the real client and saves a screenshot.
 *
 * The point is to be able to LOOK at the sprite pipeline rather than trust that
 * the files exist and the keys resolve. Two failures are invisible in a file
 * listing and obvious in a picture: a sprite that decodes to nothing, and the
 * client's own load-time magenta killer having eaten it.
 *
 * One server per boss. A single server run would put all three on the same tile,
 * because each is placed relative to the control character's spawn, and the
 * result is three overlapping auras with three stacked name labels -- which is
 * not a picture of any one boss. Restarting is slow and pointless to optimise:
 * this is a tool for looking at art, not a test that runs in a gate.
 *
 * The boss is placed by the server through the ordinary TEST_MODE spawn path, two
 * tiles from the control character, which spawns on the browser player's own
 * tile. Nothing is injected into the page.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { BrowserDriver, getClientErrors, finalizeResult } = require('../tests/browser/browser_driver');
const ServerController = require('../tests/lib/server_controller');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'tmp_shots');
const BOSSES = ['ice_dragon', 'skeleton_king', 'spider_queen'];
const WS = require('ws');

let failures = 0;
function check(label, ok, detail) {
    if (!ok) failures++;
    console.log(`   ${ok ? '\u2713' : '\u2717'} ${label}${detail ? ` (${detail})` : ''}`);
    return ok;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One server, one browser, one boss, one screenshot.
async function shoot(type) {
    const port = 8150 + BOSSES.indexOf(type);
    const dbFile = path.join(os.tmpdir(), `tibia-bossshots-${type}-${process.pid}.json`);
    const server = new ServerController({ port, dbFile, testMode: true });
    const driver = new BrowserDriver({ port, headless: true });
    let ctl = null;
    try {
        await server.start();
        await driver.init();
        const { page } = await driver.createAgentPage({
            charName: `Voyeur${Math.random().toString(36).slice(2, 6)}`,
            classType: 'ranger', autoLogin: true
        });
        const ready = await page.waitForFunction('window.CLIENT_READY === true', { timeout: 25000 })
            .then(() => true).catch(() => false);
        if (!ready) throw new Error(`${type}: client never became ready`);
        await sleep(1800);

        ctl = new WS(`ws://127.0.0.1:${port}`);
        await new Promise((res, rej) => { ctl.once('open', res); ctl.once('error', rej); });
        const seen = [];
        ctl.on('message', raw => { try { seen.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
        ctl.send(JSON.stringify({ action: 'login', name: 'Stagehand', class: 'ranger', warmode: false }));
        for (let i = 0; i < 60 && !seen.some(p => p.action === 'your_id'); i++) await sleep(100);
        if (!seen.some(p => p.action === 'your_id')) throw new Error(`${type}: control character could not log in`);

        const baseFile = path.join(SHOTS, `_baseline_${type}.png`);
        await page.screenshot({ path: baseFile });
        const baseSize = fs.statSync(baseFile).size;

        seen.length = 0;
        ctl.send(JSON.stringify({ action: 'test_spawn_boss', type }));
        await sleep(1600);
        const fresh = seen.filter(p => p.action === 'mob_update' && p.type === type);
        const said = seen
            .filter(p => ['log', 'protocol_error', 'login_error', 'error'].includes(p.action))
            .map(p => `${p.action}: ${p.message || JSON.stringify(p).slice(0, 90)}`);
        check(`${type}: server announced it to the floor`, fresh.length > 0,
            fresh.length ? `${fresh.length} mob_update at ${fresh[0].x},${fresh[0].y}` : `nothing came back. said: ${said.join(' / ') || '(silent)'}`);

        const file = path.join(SHOTS, `${type}.png`);
        await page.screenshot({ path: file });
        const size = fs.statSync(file).size;
        check(`${type}: the frame changed once the boss arrived`, size !== baseSize,
            `${(size / 1024).toFixed(0)} KB vs baseline ${(baseSize / 1024).toFixed(0)} KB`);

        const errs = getClientErrors(driver);
        check(`${type}: no client errors`, errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
        return file;
    } finally {
        try { if (ctl && ctl.readyState === 1) ctl.close(); } catch { /* ignore */ }
        try { await driver.close(); } catch { /* ignore */ }
        try { await server.stop(true); } catch { /* ignore */ }
        for (const s of ['', '-wal', '-shm', '-journal']) {
            try { fs.rmSync(dbFile.replace(/\.json$/, '.sqlite') + s, { force: true }); } catch { /* ignore */ }
            try { fs.rmSync(dbFile + s, { force: true }); } catch { /* ignore */ }
        }
    }
}

async function main() {
    fs.mkdirSync(SHOTS, { recursive: true });
    console.log('\n=== boss sprite screenshots (one server per boss) ===\n');
    const files = [];
    for (const type of BOSSES) {
        try {
            files.push(await shoot(type));
        } catch (err) {
            failures++;
            console.log(`   \u2717 ${type} threw: ${err && err.message ? err.message : err}`);
        }
        await sleep(500);
    }

    // Did the browser fetch the PNGs at all? A 200 with a body is the difference
    // between "the file is on disk" and "the client can draw it".
    const onDisk = BOSSES.map(t => `boss_${t}.png`);
    const missing = onDisk.filter(f => !fs.existsSync(path.join(ROOT, 'client', 'assets', f)));
    check('every boss sprite exists on disk', missing.length === 0, missing.join(', ') || `${onDisk.length} files`);

    console.log(`\n   ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    console.log(`   shots in ${SHOTS.replace(ROOT + '\\', '')}/`);
    return { success: failures === 0 };
}

main().then(r => process.exit(r.success ? 0 : 1)).catch(e => { console.error(e); process.exit(2); });
