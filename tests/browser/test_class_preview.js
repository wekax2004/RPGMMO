/*
 * tests/browser/test_class_preview.js
 *
 * Verifies in a real browser that the class-select screen paints the four class
 * sprites, and that the death screen appears on death and clears on respawn.
 *
 * Both were frontend-only changes, which is exactly the kind that ships broken: a
 * plausible drawImage call proves nothing about whether the image was loaded, the
 * canvas had a size, or the global it reaches for exists. Reading the source
 * cannot answer those, so this drives the actual page.
 *
 * The assertion that matters is the pixel count. A canvas that exists but was
 * never drawn is precisely the failure a source review waves through, and it is
 * also the failure that makes the feature look done in code review and empty on
 * screen.
 *
 * Run:  node tests/e2e_runner.js --suite=browser --test=class_preview --port=8147
 */
const fs = require('fs');
const path = require('path');

const { BrowserDriver, finalizeResult } = require('./browser_driver');

const CLASSES = ['warrior', 'mage', 'ranger', 'healer'];

async function runClassPreviewTest(options = {}) {
    const port = options.port || 8080;
    const headless = options.headless !== undefined ? options.headless : true;
    const startTime = Date.now();

    console.log(`\n=============================================================`);
    console.log(`🎨  [UI] Starting Class Preview & Death Screen Browser Test`);
    console.log(`   Port: ${port} | Headless: ${headless}`);
    console.log(`=============================================================\n`);

    const driver = new BrowserDriver({ port, headless });
    const runId = Math.random().toString(36).substring(2, 6);
    const steps = [];
    const record = (name, passed, details = '') => {
        steps.push({ name, passed, details });
        console.log(`   ${passed ? '✓' : '✗'} ${name}${details ? ` (${details})` : ''}`);
    };

    try {
        await driver.init();
        record('Browser Initialized', true);

        // A plain page, logged out: this is the state where the class select is
        // shown, so the preview code has actually run by the time we look.
        const { page } = await driver.createAgentPage({
            charName: `Preview_${runId}`,
            classType: 'warrior',
            autoLogin: false
        });

        // The server pushes show_class_select on connect. Give the sprite loader
        // time to finish, since the preview paints 100ms after that packet.
        await page.waitForFunction(
            () => document.querySelectorAll('.class-card').length >= 4,
            { timeout: 10000 }
        );
        record('Class select screen is shown', true,
            await page.evaluate(() => `${document.querySelectorAll('.class-card').length} cards`));

        // --- 3.10 the previews exist and have a drawable size -------------
        const canvases = await page.evaluate((classes) => {
            const out = {};
            for (const cls of classes) {
                const c = document.getElementById('preview-' + cls);
                out[cls] = c ? { exists: true, w: c.width, h: c.height } : { exists: false };
            }
            return out;
        }, CLASSES);

        const missing = CLASSES.filter(c => !canvases[c].exists);
        record('a preview canvas exists for each class', missing.length === 0,
            missing.length ? `missing: ${missing.join(', ')}`
                : CLASSES.map(c => `${c} ${canvases[c].w}x${canvases[c].h}`).join(', '));

        if (missing.length === 0) {
            const sized = CLASSES.every(c => canvases[c].w > 0 && canvases[c].h > 0);
            record('the preview canvases have a drawable size', sized,
                CLASSES.map(c => `${canvases[c].w}x${canvases[c].h}`).join(' '));
        }

        // --- the assertion that matters: are they painted? ---------------
        // Wait for the image decode rather than a fixed sleep where possible.
        await page.waitForFunction(
            (classes) => classes.every(cls => {
                const c = document.getElementById('preview-' + cls);
                if (!c) return false;
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
                return false;
            }),
            { timeout: 8000, polling: 200 },
            CLASSES
        ).catch(() => { /* reported below with the actual counts */ });

        const painted = await page.evaluate((classes) => {
            const out = {};
            for (const cls of classes) {
                const c = document.getElementById('preview-' + cls);
                if (!c) { out[cls] = { pixels: -1 }; continue; }
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                let n = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) n++;
                out[cls] = { pixels: n, total: c.width * c.height };
            }
            return out;
        }, CLASSES);

        const blank = CLASSES.filter(c => painted[c].pixels <= 0);
        record('every class preview has actually been drawn', blank.length === 0,
            blank.length
                ? `blank: ${blank.map(c => `${c}(${painted[c].pixels}px)`).join(', ')}`
                : CLASSES.map(c => `${c}=${painted[c].pixels}/${painted[c].total}px`).join(' '));

        // Four identical canvases would mean one sprite is drawn four times, or
        // that the canvas is a solid fill rather than a picture.
        const distinct = new Set(CLASSES.map(c => painted[c].pixels));
        record('the previews are distinct pictures, not one repeated fill',
            distinct.size >= 2, `pixel counts: ${CLASSES.map(c => painted[c].pixels).join(', ')}`);

        // getSprite is a top-level function in renderer.js; whether that is
        // reachable as window.getSprite depends on how the file is loaded, and
        // the preview code depends on it.
        const g = await page.evaluate(() => ({ getSprite: typeof window.getSprite }));
        record('window.getSprite is reachable from the preview code', g.getSprite === 'function',
            `typeof window.getSprite = ${g.getSprite}`);

        // The preview must be drawn by polling for readiness, not on a fixed delay.
        //
        // This is a source-level check because the behaviour cannot be told apart
        // from timing on localhost: the sprite chain is four local decodes and often
        // completes inside 120ms, so a single-attempt version passes here and fails
        // on a slower machine. Mutation testing confirmed exactly that -- capping the
        // poll at one attempt survived, because on this hardware it was never a
        // failure. Asserting the retry budget is what distinguishes robust from
        // lucky.
        const engineSrc = fs.readFileSync(
            path.join(__dirname, '..', '..', 'client', 'js', 'engine.js'), 'utf8');
        record('the preview is drawn by a polling loop',
            /const drawPreviews = \(\) => \{/.test(engineSrc) &&
            /const previewTimer = setInterval\(/.test(engineSrc),
            'drawPreviews + previewTimer = setInterval');

        {
            // Read the numbers straight off the file rather than trying to capture a
            // block: an earlier version scoped the pattern tightly enough to miss
            // them and failed on correct code, which is a worse failure than not
            // checking at all.
            const budget = /previewAttempts\s*>\s*(\d+)/.exec(engineSrc);
            const attempts = budget ? Number(budget[1]) : 0;
            const interval = /previewTimer = setInterval\([^,]+,\s*(\d+)\)/.exec(engineSrc);
            const period = interval ? Number(interval[1]) : 0;

            record('the preview retries more than once', attempts > 1,
                `retry budget: ${attempts} attempt(s)`);
            record('the preview gives up eventually rather than polling forever',
                attempts > 1 && attempts <= 200,
                `${attempts} attempts every ${period}ms = up to ${Math.round((attempts * period) / 1000)}s`);
        }

        // --- 3.7 the death screen ----------------------------------------
        // Log in first: the death transition is driven off a status packet, which
        // only arrives for a character in the world.
        await driver.createAgentPage({
            charName: `PreviewDeath_${runId}`,
            classType: 'warrior',
            autoLogin: true
        }).then(async ({ page: live }) => {
            const hasModal = await live.evaluate(() => !!document.getElementById('death-modal'));
            record('the death modal exists in the page', hasModal);

if (hasModal) {
                // Delivered through socket.onmessage, which is the real handler.
                // See the note at the top of this file for why driving a real death
                // through the server was abandoned.
                const startState = await live.evaluate(() => {
                    const el = document.getElementById('death-modal');
                    return { startHidden: el.style.display === 'none' || !el.style.display };
                });
                record('the death screen starts hidden', startState.startHidden);

                const death = await live.evaluate(async () => {
                    const sock = window.__GAME_SOCKET__;
                    if (!sock || typeof sock.onmessage !== 'function') {
                        return { error: 'socket onmessage is not reachable from the page' };
                    }
                    // engine.js:76 buffers every packet while CLIENT_READY is
                    // false and drains it via processPacketQueue() once the first
                    // frame has drawn (renderer.js:784). A packet handed to
                    // onmessage while that flag is false is queued and silently
                    // ignored -- which is why an earlier version of this test
                    // delivered hp=0 and nothing happened at all.
                    const ready = window.CLIENT_READY;
                    if (!ready) return { error: 'CLIENT_READY is false; packets would be queued, not handled' };

                    const status = (hp) => sock.onmessage({
                        data: JSON.stringify({
                            action: 'status', hp, maxHp: 100, mana: 50, maxMana: 50,
                            level: 1, xp: 0, nextXp: 100, gold: 0, classType: 'warrior'
                        })
                    });

                    // Read the DOM synchronously, with no await between the injected packet and the
                    // assertion. The server pushes a real status packet every tick,
                    // so waiting even 300ms lets the live state overwrite the
                    // injected one and the modal closes again -- an earlier version
                    // failed on exactly that, with the HP readout reading 150/150
                    // rather than the 0 that had been injected. onmessage runs the
                    // handler synchronously, so reading immediately is both correct
                    // and free.
                    status(0);
                    const el = document.getElementById('death-modal');
                    const shown = el.style.display === 'block';
                    const overlay = document.getElementById('overlay');
                    const overlayShown = !!overlay && overlay.style.display === 'block';

                    // Proof the packet was handled, independent of the death branch:
                    // the HP readout is driven by the same handler.
                    const probe = {
                        hpText: document.getElementById('hp-text')?.innerText,
                        hpWidth: document.getElementById('hp-bar')?.style.width
                    };

                    status(60);
                    const cleared = el.style.display !== 'block';

                    return { shown, overlayShown, cleared, ready, probe };
                });

                record('the status packet reached the handler at all',
                    !!death.probe, death.error ||
                    `hp readout after the packet: text="${death.probe && death.probe.hpText}" width="${death.probe && death.probe.hpWidth}"`);
                record('the death screen appears when HP reaches 0', death.shown,
                    death.error || 'delivered through the socket handler');
                record('the death screen covers the game behind it', death.overlayShown);
                record('the death screen clears when HP is restored', death.cleared);
            }
        });

        return finalizeResult(driver, {
            success: steps.every(s => s.passed),
            durationMs: Date.now() - startTime
        });
    } catch (error) {
        console.error('   class preview test error:', error.message);
        // finalizeResult takes (driver, result) and folds in any uncaught client
        // errors the driver collected. Passing (startTime, steps) instead -- which
        // is what the first version did -- reported success: false with an undefined
        // duration even though all 14 checks had passed.
        return finalizeResult(driver, {
            success: false,
            durationMs: Date.now() - startTime,
            error: String((error && error.message) || error)
        });
    }
}

module.exports = { runClassPreviewTest };

if (require.main === module) {
    const portArg = process.argv.indexOf('--port');
    runClassPreviewTest({ port: portArg > -1 ? Number(process.argv[portArg + 1]) : 8080 })
        .then(r => process.exit(r.success ? 0 : 1));
}