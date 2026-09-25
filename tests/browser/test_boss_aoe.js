/**
 * tests/browser/test_boss_aoe.js
 * AC2 Acceptance Test: Boss Combat & AoE Ground Indicator Verification
 *
 * Verifies via independent Puppeteer browser agent and Canvas pixel inspection:
 * 1. Boss engagement and AoE ability telegraphing (aoe_warning packet).
 * 2. Visual rendering of the AoE ground telegraph on the HTML5 Canvas BEFORE damage detonation.
 * 3. Dual-layer verification: Pixel sampling (RGBA) + Context render telemetry.
 * 4. Timing verification: Player is unhurt during the 1500ms warning telegraph phase.
 */

const { BrowserDriver } = require('./browser_driver');
const CanvasInspector = require('./canvas_inspector');

/**
 * Runs the Boss AoE ground indicator acceptance test.
 * @param {object} options
 * @param {number} options.port - Server port (default 8080)
 * @param {boolean} options.headless - Headless mode (default true)
 * @returns {Promise<{success: boolean, durationMs: number, results: object, error: Error|null}>}
 */
async function runBossAoETest(options = {}) {
  const port = options.port || 8080;
  const headless = options.headless !== undefined ? options.headless : true;
  const startTime = Date.now();

  console.log(`\n=============================================================`);
  console.log(`🕷️  [AC2] Starting Boss Combat & AoE Indicator Browser Test`);
  console.log(`   Port: ${port} | Headless: ${headless}`);
  console.log(`=============================================================\n`);

  const driver = new BrowserDriver({ port, headless });
  const runId = Math.random().toString(36).substring(2, 6);
  const charName = `BossSlayer_${runId}`;
  const testSteps = [];

  function recordStep(name, passed, details = '') {
    testSteps.push({ name, passed, details });
    console.log(`   ${passed ? '✓' : '✗'} ${name} ${details ? '(' + details + ')' : ''}`);
  }

  try {
    await driver.init();
    recordStep('Browser Initialized', true);

    const { page } = await driver.createAgentPage({
      charName,
      classType: 'mage',
      autoLogin: true
    });
    recordStep('Character Logged In', true, `${charName} (Mage)`);

    // Install render spy on 2D canvas context
    await CanvasInspector.installRenderSpy(page);
    recordStep('Canvas Telemetry Spy Installed', true);

    // Wait for first server status broadcast (300ms cycle) to establish real baseline HP
    await new Promise(r => setTimeout(r, 450));

    // 1. Initial health inspection
    const initialHpText = await page.$eval('#hp-text', el => el.innerText);
    recordStep('Initial Health Verified', true, initialHpText);

    // 2. Trigger Boss AoE Ability via genuine in-game actions
    console.log(`[*] Engaging Boss encounter via WebSocket actions...`);
    await page.evaluate(() => {
      if (window.__GAME_SOCKET__ && window.__GAME_SOCKET__.readyState === 1) {
        window.__GAME_SOCKET__.send(JSON.stringify({ action: 'attack_boss', bossId: 'boss_spider_queen' }));
        window.__GAME_SOCKET__.send(JSON.stringify({ action: 'trigger_boss_aoe', spellId: 'spider_acid_bomb' }));
      }
    });

    // Listen for genuine aoe_warning packet from server
    const aoeWarningPacket = await page.waitForFunction(() => {
      if (!window.__MMO_TEST_TELEMETRY__) return null;
      return window.__MMO_TEST_TELEMETRY__.socketPacketsIn.find(p => p.data && p.data.action === 'aoe_warning');
    }, { timeout: 2000 }).catch(() => null);

    recordStep('Server AoE Warning Packet Received', !!aoeWarningPacket,
      aoeWarningPacket ? 'Received genuine aoe_warning from server' : 'Timeout waiting for server aoe_warning (M3 Boss feature pending)');

    const warningEntry = aoeWarningPacket ? await aoeWarningPacket.jsonValue().catch(() => null) : null;
    const warningData = warningEntry && warningEntry.data;
    const spellId = warningData && (warningData.id || warningData.spellId);

    // 3. Inspect Canvas during warning phase (T+500ms)
    console.log(`[*] Sampling canvas at (320, 180) in AoE telegraph zone...`);
    await new Promise(r => setTimeout(r, 500));

    // Sample pixel offset from avatar center (avatar is at 320, 240, Mage #00aaff)
    const aoePixel = await CanvasInspector.getPixel(page, 320, 180);
    const isTelegraphActive = CanvasInspector.isRedTelegraphActive(aoePixel);

    recordStep('Canvas Pixel Sampled in AoE Zone', isTelegraphActive,
      `RGBA: [${aoePixel.r}, ${aoePixel.g}, ${aoePixel.b}, ${aoePixel.a}], RedElevated: ${isTelegraphActive}`);

    // Sample circle perimeter around telegraph zone (strictly outside avatar radius)
    const circleSamples = await CanvasInspector.sampleCircle(page, 320, 240, 50, 4);
    const hasPerimeterSignals = circleSamples.some(p => CanvasInspector.isRedTelegraphActive(p));
    recordStep('Circular Perimeter Telegraph Sampled', hasPerimeterSignals, `${circleSamples.length} points sampled`);

    // Verify player is UNHURT during telegraph phase
    const warningHpText = await page.$eval('#hp-text', el => el.innerText);
    const unhurtDuringWarning = warningHpText === initialHpText;
    recordStep('Zero Premature Damage Verified', unhurtDuringWarning,
      `Pre-detonation HP: ${warningHpText} (Expected: ${initialHpText})`);

    // 4. Verify Context Telemetry records
    const telemetry = await CanvasInspector.getTelegraphTelemetry(page);
    const correlatedTelemetry = Boolean(warningData) && telemetry.some(render =>
        Math.abs(render.x - warningData.x) <= 2 &&
        Math.abs(render.y - warningData.y) <= 2 &&
        Math.abs(render.radius - (warningData.radius || 50)) <= 2
    );
    recordStep('Context Render Telemetry Verified', telemetry.length > 0, `${telemetry.length} render frame(s) recorded`);
    recordStep('Telegraph Telemetry Matches Server Spell', correlatedTelemetry,
      correlatedTelemetry ? 'Canvas draw correlated to warning geometry' : 'No matching server spell geometry');

    const impactPacket = spellId ? await page.waitForFunction((id) => {
      if (!window.__MMO_TEST_TELEMETRY__) return null;
      return window.__MMO_TEST_TELEMETRY__.socketPacketsIn.find(p =>
        p.data && p.data.action === 'aoe_impact' && (p.data.id === id || p.data.spellId === id)
      );
    }, { timeout: 3500 }, spellId).catch(() => null) : null;
    recordStep('Matching AoE Impact Packet Received', !!impactPacket,
      impactPacket ? `Impact matched spell ${spellId}` : 'No matching aoe_impact packet');

    // 5. Post-Detonation phase (wait past 1500ms duration)
    await new Promise(r => setTimeout(r, 1400)); // Allow the detonation animation to finish
    const postDetonationPixel = await CanvasInspector.getPixel(page, 320, 180);
    const telegraphCleared = !CanvasInspector.isRedTelegraphActive(postDetonationPixel);
    recordStep('Telegraph Cleared Post-Detonation', telegraphCleared, `Telegraph cleared from canvas`);
    const postImpactHpText = await page.$eval('#hp-text', el => el.innerText);
    recordStep('Post-Impact Damage Verified', postImpactHpText !== initialHpText,
      `Post-impact HP: ${postImpactHpText} (Initial: ${initialHpText})`);

    await driver.close();

    const allPassed = testSteps.every(s => s.passed);

    console.log(`\n================== AC2 BOSS AOE RESULTS =====================`);
    console.log(` Status: ${allPassed ? 'PASSED [✓]' : 'FAILED [✗]'}`);
    console.log(` Duration: ${Date.now() - startTime}ms`);
    console.log(`=============================================================\n`);

    return {
      success: allPassed,
      durationMs: Date.now() - startTime,
      results: testSteps,
      error: allPassed ? null : new Error('AC2 Boss AoE test assertions failed')
    };
  } catch (err) {
    console.error(`\n[!] Error during AC2 Boss AoE Test:`, err);
    await driver.close();
    return {
      success: false,
      durationMs: Date.now() - startTime,
      results: testSteps,
      error: err
    };
  }
}

// Standalone CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  args.forEach(arg => {
    if (arg.startsWith('--port=')) options.port = parseInt(arg.split('=')[1], 10);
    else if (arg === '--headless=false') options.headless = false;
  });

  runBossAoETest(options).then(res => {
    process.exit(res.success ? 0 : 1);
  }).catch(err => {
    console.error('Fatal error in test_boss_aoe:', err);
    process.exit(2);
  });
}

module.exports = { runBossAoETest };
