/*
 * Browser verification that the Skills panel actually renders.
 *
 * The unit tests prove the server math and the live script proves the packets
 * arrive. Neither proves the DOM updates -- and tests/browser/browser_driver.js
 * installs no pageerror listener, so a ReferenceError in the new UI code would
 * be invisible to the acceptance suite. This checks the rendered result and
 * fails on any uncaught page error.
 *
 * Run:  node tests/browser/skills_panel_check.js --port=8152
 */
const path = require('path');
const os = require('os');
const { BrowserDriver } = require('./browser_driver');
const ServerController = require('../lib/server_controller');

function arg(name, fallback) {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : fallback;
}

const PORT = Number(arg('port', 8152));
const DB_FILE = path.join(os.tmpdir(), `tibia-skills-ui-${process.pid}.json`);

let failures = 0;
function check(label, condition, detail) {
    const ok = !!condition;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ` -- ${detail}` : ''}`);
    return ok;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log(`\n=== SKILLS: browser panel verification (port ${PORT}) ===\n`);

    const server = new ServerController({
        port: PORT,
        dbFile: DB_FILE,
        env: { TIBIA_DB_DRIVER: 'sqlite' }
    });
    await server.start();

    const driver = new BrowserDriver({ port: PORT, headless: true });
    let context, page;
    const pageErrors = [];

    try {
        const agent = await driver.createAgentPage({
            autoLogin: true, charName: 'UiMage', classType: 'mage'
        });
        context = agent.context;
        page = agent.page;

        // The gap the acceptance suite does not cover.
        page.on('pageerror', err => pageErrors.push(String(err && err.message || err)));
        page.on('console', msg => {
            if (msg.type() === 'error') pageErrors.push('console.error: ' + msg.text());
        });

        // Give the login burst (which carries the skill panel) time to land.
        await sleep(2500);

        console.log('[1] the panel container exists and is populated');
        const exists = await page.$eval('#skill-list', el => !!el).catch(() => false);
        check('#skill-list container exists in the DOM', exists);

        const rows = await page.$$eval('#skill-list .skill-row', els => els.map(el => ({
            skill: el.getAttribute('data-skill'),
            text: el.textContent.replace(/\s+/g, ' ').trim(),
            barWidth: el.querySelector('.skill-bar > div')
                ? el.querySelector('.skill-bar > div').style.width : null
        }))).catch(() => []);

        check('four skill rows rendered', rows.length === 4, `got ${rows.length}`);
        check('rows are mining, woodcutting, sword, magic in order',
            JSON.stringify(rows.map(r => r.skill)) === JSON.stringify(['mining', 'woodcutting', 'sword', 'magic']),
            JSON.stringify(rows.map(r => r.skill)));
        check('each row shows a level',
            rows.every(r => /Lv\s*\d+|MAX/.test(r.text)), JSON.stringify(rows.map(r => r.text)));
        check('each row has a progress bar with a width',
            rows.every(r => r.barWidth && r.barWidth.endsWith('%')),
            JSON.stringify(rows.map(r => r.barWidth)));
        check('all bars start at 0% for a fresh character',
            rows.every(r => r.barWidth === '0%'), JSON.stringify(rows.map(r => r.barWidth)));

        console.log('\n[2] a live award updates the panel without a reload');
        // Casting trains magic; the server pushes skill_update and the panel
        // should re-render the magic row on its own.
        const before = await page.$eval('#skill-list .skill-row[data-skill="magic"] .skill-bar > div',
            el => el.style.width).catch(() => null);
        await page.evaluate(() => {
            for (let i = 0; i < 3; i++) window.__GAME_SOCKET__.send(JSON.stringify({ action: 'cast_spell' }));
        });
        await sleep(1500);
        const after = await page.$eval('#skill-list .skill-row[data-skill="magic"] .skill-bar > div',
            el => el.style.width).catch(() => null);
        check('the magic bar changed after casting', before !== after, `${before} -> ${after}`);
        check('the magic bar actually advanced', after && after !== '0%', `now ${after}`);

        const magicRowText = await page.$eval('#skill-list .skill-row[data-skill="magic"]',
            el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
        check('the magic row still shows its level after the update', /Lv\s*\d+/.test(magicRowText),
            magicRowText);

        console.log('\n[3] no uncaught client-side errors');
        check('no page errors were raised', pageErrors.length === 0,
            pageErrors.length ? JSON.stringify(pageErrors.slice(0, 4)) : 'clean');

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

main().catch(err => {
    console.error('\nverification crashed:', err);
    process.exit(1);
});
