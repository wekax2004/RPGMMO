/*
 * Proves the shared browser driver actually captures uncaught client-side
 * errors. A listener that is installed but never verified is the same as no
 * listener at all: the acceptance tests would still pass while a panel silently
 * failed to render.
 *
 * Run:  node tests/browser/pageerror_probe.js
 */
const path = require('path');
const os = require('os');
const { BrowserDriver, getClientErrors } = require('./browser_driver');
const ServerController = require('../lib/server_controller');

const PORT = 8158;
const DB_FILE = path.join(os.tmpdir(), `tibia-pageerr-${process.pid}.json`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(label, condition, detail) {
    const ok = !!condition;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ` -- ${detail}` : ''}`);
    return ok;
}

async function main() {
    console.log('\n=== pageerror capture probe ===\n');
    const server = new ServerController({ port: PORT, dbFile: DB_FILE, env: { TIBIA_DB_DRIVER: 'sqlite' } });
    await server.start();
    const driver = new BrowserDriver({ port: PORT, headless: true });
    let page = null, context = null;

    try {
        const agent = await driver.createAgentPage({ autoLogin: true, charName: 'ErrProbe', classType: 'warrior' });
        context = agent.context;
        page = agent.page;
        await sleep(2000);

        check('getClientErrors is exported from the driver',
            typeof getClientErrors === 'function');
        check('a clean page reports no errors to start',
            getClientErrors(page).length === 0,
            JSON.stringify(getClientErrors(page).slice(0, 3)));

        // Throw a real uncaught error inside the page and confirm it lands.
        await page.evaluate(() => { setTimeout(() => { throw new Error('DELIBERATE_PROBE_ERROR'); }, 0); });
        await sleep(700);
        const afterThrow = getClientErrors(page);
        check('an uncaught page error is captured',
            afterThrow.some(e => /DELIBERATE_PROBE_ERROR/.test(e)),
            JSON.stringify(afterThrow.slice(0, 3)));

        // A console.error should also be captured.
        await page.evaluate(() => { console.error('DELIBERATE_CONSOLE_ERROR'); });
        await sleep(500);
        check('a console.error is captured',
            getClientErrors(page).some(e => /DELIBERATE_CONSOLE_ERROR/.test(e)),
            JSON.stringify(getClientErrors(page).slice(-2)));

        // A console.log must NOT be treated as an error, or the signal drowns.
        const before = getClientErrors(page).length;
        await page.evaluate(() => { console.log('BENIGN_CONSOLE_LOG'); });
        await sleep(400);
        check('a benign console.log is not flagged as an error',
            getClientErrors(page).length === before,
            `count ${before} -> ${getClientErrors(page).length}`);

        // The array handed out must be a copy, so a caller cannot clear the
        // driver's record by mutating it.
        const snapshot = getClientErrors(page);
        snapshot.length = 0;
        check('getClientErrors returns a copy, not the live array',
            getClientErrors(page).length > 0,
            `after clearing the copy, live count = ${getClientErrors(page).length}`);

    } finally {
        try { if (page) await page.close(); } catch { /* ignore */ }
        try { if (context) await context.close(); } catch { /* ignore */ }
        try { await driver.close(); } catch { /* ignore */ }
        try { await server.stop(true); } catch { /* ignore */ }
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
            require('fs').rmSync(DB_FILE.replace(/\.json$/, '.sqlite') + suffix, { force: true });
            require('fs').rmSync(DB_FILE + suffix, { force: true });
        }
    }
    console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('\nprobe crashed:', err); process.exit(1); });
