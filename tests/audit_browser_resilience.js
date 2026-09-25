/**
 * tests/audit_browser_resilience.js
 * Empirical Challenge Audit Suite for Browser Acceptance & Automation Resilience
 *
 * Tests:
 * 1. Puppeteer-Core Process Lifecycle & Leak Detection (PIDs, child trees, multi-page teardown)
 * 2. Canvas Inspection Fidelity & Pixel Discrimination Accuracy (Matrix of game colors vs telegraph heuristic)
 * 3. AoE Ground Indicator Telegraph Timing & Frame Persistence
 */

const { spawnSync } = require('child_process');
const path = require('path');
const { BrowserDriver } = require('./browser/browser_driver');
const CanvasInspector = require('./browser/canvas_inspector');
const ServerController = require('./lib/server_controller');

// Helper to get all chrome.exe PIDs on Windows
function getChromePids() {
  const psCmd = 'Get-CimInstance Win32_Process -Filter "Name = \'chrome.exe\'" | Select-Object -ExpandProperty ProcessId';
  const res = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { encoding: 'utf8' });
  if (res.error || !res.stdout) return [];
  return res.stdout.trim().split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

// Helper to get child processes of a specific PID
function getChildPids(parentPid) {
  const psCmd = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" | Select-Object -ExpandProperty ProcessId`;
  const res = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { encoding: 'utf8' });
  if (res.error || !res.stdout) return [];
  return res.stdout.trim().split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

async function runAudit() {
  console.log('======================================================================');
  console.log('🔬 EMPIRICAL CHALLENGE AUDIT: BROWSER ACCEPTANCE & RESILIENCE');
  console.log('======================================================================\n');

  const auditReport = {
    processLifecycle: {},
    canvasInspection: {},
    timingAccuracy: {}
  };

  // Start test server on port 8097
  const TEST_PORT = 8097;
  const server = new ServerController({ port: TEST_PORT });
  await server.start();
  console.log(`[✓] Test server online on port ${TEST_PORT}\n`);

  try {
    // ===================================================================
    // SECTION 1: Puppeteer Process Lifecycle & Clean Shutdown Audit
    // ===================================================================
    console.log('----------------------------------------------------------------------');
    console.log('📌 1. PUPPETEER PROCESS LIFECYCLE & PROCESS LEAK VERIFICATION');
    console.log('----------------------------------------------------------------------');

    const initialChromePids = getChromePids();
    console.log(`Initial Chrome PIDs on system: [${initialChromePids.join(', ')}] (Count: ${initialChromePids.length})`);

    // 1.1 Sequential launch and close stress test (5 iterations)
    console.log('\n[*] Executing 5 sequential BrowserDriver launch & close cycles...');
    let sequentialSuccess = true;
    const cycleDetails = [];

    for (let i = 1; i <= 5; i++) {
      const driver = new BrowserDriver({ port: TEST_PORT, headless: true });
      await driver.init();
      const mainPid = driver.browser.process() ? driver.browser.process().pid : null;
      const childPids = mainPid ? getChildPids(mainPid) : [];

      // Open a page
      const { page } = await driver.createAgentPage({ charName: `AuditBot_${i}`, classType: 'warrior', autoLogin: true });
      await new Promise(r => setTimeout(r, 200));

      // Close driver
      await driver.close();
      await new Promise(r => setTimeout(r, 400));

      const pidsAfter = getChromePids();
      const mainKilled = mainPid ? !pidsAfter.includes(mainPid) : true;
      const childrenKilled = childPids.every(cp => !pidsAfter.includes(cp));

      cycleDetails.push({ cycle: i, mainPid, mainKilled, childPids, childrenKilled });
      if (!mainKilled || !childrenKilled) sequentialSuccess = false;
      console.log(`   Cycle ${i}: PID ${mainPid} (Children: ${childPids.length}) -> Main Killed: ${mainKilled}, Children Killed: ${childrenKilled}`);
    }

    // 1.2 Multi-context / multi-page isolation test (simulating 2-agent trade flow)
    console.log('\n[*] Testing multi-agent context cleanup (simulating test_trade.js)...');
    const driverMulti = new BrowserDriver({ port: TEST_PORT, headless: true });
    await driverMulti.init();
    const multiMainPid = driverMulti.browser.process().pid;

    const agentA = await driverMulti.createAgentPage({ charName: 'AuditAlice', classType: 'warrior', autoLogin: true });
    const agentB = await driverMulti.createAgentPage({ charName: 'AuditBob', classType: 'ranger', autoLogin: true });
    await new Promise(r => setTimeout(r, 400));

    const multiChildren = getChildPids(multiMainPid);
    console.log(`   Multi-agent browser running with Main PID ${multiMainPid}, child processes: [${multiChildren.join(', ')}]`);

    await driverMulti.close();
    await new Promise(r => setTimeout(r, 500));

    const pidsAfterMulti = getChromePids();
    const multiMainKilled = !pidsAfterMulti.includes(multiMainPid);
    const multiChildrenKilled = multiChildren.every(cp => !pidsAfterMulti.includes(cp));
    console.log(`   Multi-agent Main Killed: ${multiMainKilled} | Children Killed: ${multiChildrenKilled}`);

    // 1.3 Error recovery test
    console.log('\n[*] Testing abnormal error recovery (unreachable port)...');
    const driverErr = new BrowserDriver({ port: 59998, headless: true });
    await driverErr.init();
    const errPid = driverErr.browser.process().pid;
    let errorCaught = false;
    try {
      await driverErr.createAgentPage({ charName: 'FailBot', autoLogin: false });
    } catch (e) {
      errorCaught = true;
    } finally {
      await driverErr.close();
    }
    await new Promise(r => setTimeout(r, 400));
    const pidsAfterErr = getChromePids();
    const errKilled = !pidsAfterErr.includes(errPid);
    console.log(`   Error caught properly: ${errorCaught} | Process ${errPid} killed: ${errKilled}`);

    const finalChromePids = getChromePids();
    const netLeakDelta = finalChromePids.length - initialChromePids.length;
    console.log(`\nProcess Lifecycle Verdict: Net process leak delta = ${netLeakDelta} processes.`);
    auditReport.processLifecycle = {
      initialCount: initialChromePids.length,
      finalCount: finalChromePids.length,
      netDelta: netLeakDelta,
      cleanShutdownWorks: netLeakDelta <= 0 && sequentialSuccess && multiMainKilled && multiChildrenKilled
    };

    // ===================================================================
    // SECTION 2: Canvas Inspection Fidelity & Pixel Discrimination Accuracy
    // ===================================================================
    console.log('\n----------------------------------------------------------------------');
    console.log('📌 2. CANVAS INSPECTION FIDELITY & PIXEL DISCRIMINATION AUDIT');
    console.log('----------------------------------------------------------------------');

    const driverCanvas = new BrowserDriver({ port: TEST_PORT, headless: true });
    await driverCanvas.init();
    const { page: cPage } = await driverCanvas.createAgentPage({ charName: 'WarriorAudit', classType: 'warrior', autoLogin: true });
    await CanvasInspector.installRenderSpy(cPage);
    await new Promise(r => setTimeout(r, 600));

    // 2.1 False Positive Test: Player Avatar Center (320, 240)
    console.log('\n[*] Test 2.1: False-Positive test on Warrior Player Avatar with NO AoE telegraph:');
    const playerPixel = await CanvasInspector.getPixel(cPage, 320, 240);
    const isPlayerFlaggedAsTelegraph = CanvasInspector.isRedTelegraphActive(playerPixel);
    console.log(`   Pixel at (320, 240) [Warrior Avatar]: RGBA(${playerPixel.r}, ${playerPixel.g}, ${playerPixel.b}, ${playerPixel.a})`);
    console.log(`   CanvasInspector.isRedTelegraphActive(playerPixel) => ${isPlayerFlaggedAsTelegraph}`);
    console.log(`   VULNERABILITY: ${isPlayerFlaggedAsTelegraph ? 'CONFIRMED FALSE POSITIVE! Player sprite passes as AoE telegraph.' : 'None'}`);

    // 2.2 Discrimination Matrix across game colors
    console.log('\n[*] Test 2.2: Discrimination Matrix across game entity colors:');
    const colorTestMatrix = [
      { name: 'Warrior Sprite (#ffaa00)', pixel: { r: 255, g: 170, b: 0, a: 255 }, expectTelegraph: false },
      { name: 'Mage Sprite (#00aaff)', pixel: { r: 0, g: 170, b: 255, a: 255 }, expectTelegraph: false },
      { name: 'Ranger Sprite (#55ff55)', pixel: { r: 85, g: 255, b: 85, a: 255 }, expectTelegraph: false },
      { name: 'Spider Mob Body (#cc2222)', pixel: { r: 204, g: 34, b: 34, a: 255 }, expectTelegraph: false },
      { name: 'Elite Mob Aura (rgba(255,0,0,0.3) over forest)', pixel: { r: 177, g: 106, b: 85, a: 255 }, expectTelegraph: false },
      { name: 'Player Health Bar Fill (#e53935)', pixel: { r: 229, g: 57, b: 53, a: 255 }, expectTelegraph: false },
      { name: 'Target Selection Box (pure red #ff0000)', pixel: { r: 255, g: 0, b: 0, a: 255 }, expectTelegraph: false },
      { name: 'Warmode Player (#ff8888)', pixel: { r: 255, g: 136, b: 136, a: 255 }, expectTelegraph: false },
      { name: 'Mud/Dirt Biome (#5d4037)', pixel: { r: 93, g: 64, b: 55, a: 255 }, expectTelegraph: false },
      { name: 'Actual AoE Telegraph (rgba(255,0,0,0.4) over forest #8f9779)', pixel: { r: 188, g: 91, b: 73, a: 255 }, expectTelegraph: true },
      { name: 'Actual AoE Telegraph (rgba(255,0,0,0.4) over snow #e0f7fa)', pixel: { r: 236, g: 148, b: 150, a: 255 }, expectTelegraph: true }
    ];

    const matrixResults = [];
    colorTestMatrix.forEach(entry => {
      const active = CanvasInspector.isRedTelegraphActive(entry.pixel);
      const isCorrect = active === entry.expectTelegraph;
      matrixResults.push({ ...entry, actualActive: active, correct: isCorrect });
      console.log(`   ${isCorrect ? '✓' : '✗ FLAGGED'} ${entry.name.padEnd(52)} -> isRedTelegraphActive: ${active} (Expected: ${entry.expectTelegraph})`);
    });

    // 2.3 Ephemeral Canvas Drawing & Frame Erasure Bug
    console.log('\n[*] Test 2.3: Injected Canvas Circle Persistence vs requestAnimationFrame loop:');
    const drawPersistence = await cPage.evaluate(async () => {
      const canvas = document.getElementById('gameCanvas');
      const ctx = canvas.getContext('2d');

      // Draw red circle at (100, 100)
      ctx.save();
      ctx.fillStyle = 'rgba(255, 0, 0, 0.4)';
      ctx.beginPath();
      ctx.arc(100, 100, 30, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      const p0 = ctx.getImageData(100, 100, 1, 1).data;
      const initialPixel = { r: p0[0], g: p0[1], b: p0[2], a: p0[3] };

      // Wait for 1 animation frame (~20ms)
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 20)));
      const p1 = ctx.getImageData(100, 100, 1, 1).data;
      const afterFramePixel = { r: p1[0], g: p1[1], b: p1[2], a: p1[3] };

      // Wait 100ms
      await new Promise(r => setTimeout(r, 100));
      const p2 = ctx.getImageData(100, 100, 1, 1).data;
      const after100msPixel = { r: p2[0], g: p2[1], b: p2[2], a: p2[3] };

      return { initialPixel, afterFramePixel, after100msPixel };
    });

    console.log(`   Immediately after direct draw: RGBA(${drawPersistence.initialPixel.r}, ${drawPersistence.initialPixel.g}, ${drawPersistence.initialPixel.b}, ${drawPersistence.initialPixel.a})`);
    console.log(`   After 1 requestAnimationFrame:  RGBA(${drawPersistence.afterFramePixel.r}, ${drawPersistence.afterFramePixel.g}, ${drawPersistence.afterFramePixel.b}, ${drawPersistence.afterFramePixel.a})`);
    console.log(`   After 100ms:                    RGBA(${drawPersistence.after100msPixel.r}, ${drawPersistence.after100msPixel.g}, ${drawPersistence.after100msPixel.b}, ${drawPersistence.after100msPixel.a})`);
    const wasErased = drawPersistence.afterFramePixel.r !== drawPersistence.initialPixel.r;
    console.log(`   VULNERABILITY: ${wasErased ? 'CONFIRMED! Direct canvas draws are instantly erased on next animation frame.' : 'Persistent'}`);

    // 2.4 Render Spy Pollution Test
    console.log('\n[*] Test 2.4: Render Spy Telemetry Pollution (Elite mobs triggering spy without AoE):');
    const initialTelemetry = await CanvasInspector.getTelegraphTelemetry(cPage);
    console.log(`   Render spy records with NO AoE packet: ${initialTelemetry.length} frame(s) recorded.`);
    if (initialTelemetry.length > 0) {
      console.log(`   First intercepted render call: style="${initialTelemetry[0].style}", radius=${initialTelemetry[0].radius}, x=${initialTelemetry[0].x}, y=${initialTelemetry[0].y}`);
    }
    const telemetryPolluted = initialTelemetry.length > 0;
    console.log(`   VULNERABILITY: ${telemetryPolluted ? 'CONFIRMED! Render spy records elite mob aura rendering across world without any Boss AoE.' : 'Clean'}`);

    await driverCanvas.close();

    auditReport.canvasInspection = {
      warriorFalsePositive: isPlayerFlaggedAsTelegraph,
      discriminationMatrix: matrixResults,
      canvasDirectDrawErased: wasErased,
      renderSpyPolluted: telemetryPolluted
    };

    // ===================================================================
    // SECTION 3: AoE Ground Indicator Telegraph Timing Accuracy
    // ===================================================================
    console.log('\n----------------------------------------------------------------------');
    console.log('📌 3. AOE GROUND INDICATOR TELEGRAPH TIMING AUDIT');
    console.log('----------------------------------------------------------------------');

    const driverTiming = new BrowserDriver({ port: TEST_PORT, headless: true });
    await driverTiming.init();
    const { page: tPage } = await driverTiming.createAgentPage({ charName: 'TimingHero', classType: 'mage', autoLogin: true });
    // Use Mage classType so player circle is #00aaff instead of warrior #ffaa00!
    await new Promise(r => setTimeout(r, 600));

    console.log('\n[*] Test 3.1: Running with Mage player (circle #00aaff) to eliminate Warrior false positive:');
    const magePixel = await CanvasInspector.getPixel(tPage, 320, 240);
    console.log(`   Mage Avatar Pixel: RGBA(${magePixel.r}, ${magePixel.g}, ${magePixel.b}, ${magePixel.a})`);
    console.log(`   CanvasInspector.isRedTelegraphActive(magePixel) => ${CanvasInspector.isRedTelegraphActive(magePixel)}`);

    // Simulate proper persistent telegraph rendering hook:
    // When aoe_warning is received, ground indicator renders continuously for 1500ms
    console.log('\n[*] Test 3.2: Simulating persistent telegraph rendering over 1500ms window...');
    const timingLog = await tPage.evaluate(async () => {
      const log = [];
      const canvas = document.getElementById('gameCanvas');
      const ctx = canvas.getContext('2d');

      // Hook into draw loop to render persistent AoE circle from t0 to t0+1500
      const aoe = {
        x: 320,
        y: 240,
        radius: 80,
        startTime: Date.now(),
        durationMs: 1500
      };

      window.__ACTIVE_AOE_AUDIT__ = aoe;

      // Wrap requestAnimationFrame or draw intercept
      const origArc = ctx.arc;

      // Sample at intervals: 0ms, 300ms, 600ms, 900ms, 1200ms, 1450ms, 1600ms
      const checkTimes = [100, 400, 800, 1200, 1450, 1650];
      for (const delay of checkTimes) {
        await new Promise(r => setTimeout(r, delay - (log.length > 0 ? checkTimes[log.length - 1] : 0)));
        const elapsed = Date.now() - aoe.startTime;
        const isActivePhase = elapsed < aoe.durationMs;

        // Draw indicator if in active phase (simulating what client draw loop SHOULD do)
        if (isActivePhase) {
          ctx.save();
          ctx.fillStyle = 'rgba(255, 0, 0, 0.4)';
          ctx.beginPath();
          ctx.arc(320, 240, 80, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        const px = ctx.getImageData(320, 180, 1, 1).data; // Sample inside circle (radius 80) away from player center
        log.push({
          targetDelay: delay,
          actualElapsed: elapsed,
          isActivePhase,
          pixel: { r: px[0], g: px[1], b: px[2], a: px[3] }
        });
      }

      return log;
    });

    timingLog.forEach(entry => {
      const active = CanvasInspector.isRedTelegraphActive(entry.pixel);
      const expected = entry.isActivePhase;
      const pass = active === expected;
      console.log(`   T+${String(entry.actualElapsed).padStart(4)}ms (${entry.isActivePhase ? 'TELEGRAPH ACTIVE' : 'DETONATED'}): Pixel RGBA(${entry.pixel.r}, ${entry.pixel.g}, ${entry.pixel.b}) -> isRed: ${active} [${pass ? 'PASS' : 'FAIL'}]`);
    });

    // 3.3 Audit of test_boss_aoe.js assertions:
    console.log('\n[*] Test 3.3: Analysis of test_boss_aoe.js assertion logic:');
    const assertionsAudit = [
      {
        assertion: 'test_boss_aoe.js:108 CanvasInspector.getPixel(page, 320, 240)',
        issue: 'Samples player warrior sprite center (#ffaa00), producing false positive regardless of AoE presence.',
        severity: 'CRITICAL'
      },
      {
        assertion: 'test_boss_aoe.js:117 recordStep("Circular Perimeter Telegraph Sampled", true, ...)',
        issue: 'Hardcodes "true" as the passed condition without evaluating hasPerimeterSignals.',
        severity: 'HIGH'
      },
      {
        assertion: 'test_boss_aoe.js:127 recordStep("Context Render Telemetry Verified", true, ...)',
        issue: 'Passes because elite mob auras in the world trigger the spy constantly, unrelated to Boss AoE.',
        severity: 'HIGH'
      },
      {
        assertion: 'test_boss_aoe.js:131 recordStep("Telegraph Detonation Phase Complete", true, "T+1600ms elapsed")',
        issue: 'Merely sleeps 1100ms without verifying AoE detonation damage, impact packet, or telegraph cleanup.',
        severity: 'HIGH'
      },
      {
        assertion: 'test_boss_aoe.js:87 Direct canvas draw inside page.evaluate',
        issue: 'Drawn once and immediately wiped within 16ms by requestAnimationFrame(draw) loop in test_client.html.',
        severity: 'CRITICAL'
      }
    ];

    assertionsAudit.forEach(a => {
      console.log(`   [${a.severity}] ${a.assertion}\n         -> ${a.issue}`);
    });

    await driverTiming.close();

    auditReport.timingAccuracy = {
      timingLog,
      assertionsAudit
    };

  } finally {
    await server.stop();
    console.log('\n[✓] Test server terminated.');
  }

  console.log('\n======================================================================');
  console.log('🏁 EMPIRICAL AUDIT COMPLETE');
  console.log('======================================================================\n');

  return auditReport;
}

runAudit().then(report => {
  console.log('AUDIT_COMPLETE_JSON:' + JSON.stringify(report));
}).catch(err => {
  console.error('Audit fatal error:', err);
  process.exit(1);
});
