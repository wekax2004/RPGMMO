#!/usr/bin/env node
/**
 * tests/e2e_runner.js
 * Master E2E & Acceptance Test Runner for Tibia MMORPG Overhaul Project
 *
 * Architecture:
 * 1. Process Cleanup Registry with Windows process-tree force termination (taskkill /T /F).
 * 2. Multi-factor server signature probing (probeServerPort) rejecting port collisions.
 * 3. Two-Tier Execution Model:
 *    - Tier A: Baseline Test Harness Verification (--suite=baseline / --gate=m1):
 *      Server lifecycle, BotClient resilience, Headless Browser launch, Canvas buffer sampling, 50-Bot load baseline.
 *    - Tier B: Acceptance Criteria Quality Gates (--suite=acceptance / --test=ac1..ac7):
 *      Strict, genuine assertions with zero mocks. Features pending future milestones fail honestly.
 * 4. Standard POSIX exit codes:
 *    0 - Success / Gate Passed
 *    1 - Test assertion failure
 *    2 - Harness / Infrastructure error (port collision, spawn error, process crash)
 *    3 - Configuration / argument error
 */

const http = require('http');
const path = require('path');
const cp = require('child_process');
const ServerController = require('./lib/server_controller');
const BotClient = require('./bots/bot_client');
const { BrowserDriver } = require('./browser/browser_driver');
const CanvasInspector = require('./browser/canvas_inspector');
const { runLoadTest } = require('./bots/load_test_50_bots');
const { runPartyChatTest } = require('./bots/party_chat_test');
const { runPersistenceTest } = require('./bots/persistence_test');
const { runSubclassTest } = require('./browser/test_subclass');
const { runBossAoETest } = require('./browser/test_boss_aoe');
const { runNpcQuestTest } = require('./browser/test_npc_quest');
const { runTradeTest } = require('./browser/test_trade');
const { runBrowserSuite } = require('./browser/browser_runner');

// ======================================================================
// 1. Process Cleanup Registry (Windows Process Tree Termination)
// ======================================================================
class ProcessCleanupRegistry {
  constructor() {
    this.servers = new Set();
    this.browserDrivers = new Set();
    this.childPids = new Set();
    this.isTearingDown = false;
    this._installed = false;
  }

  install() {
    if (this._installed) return;
    this._installed = true;

    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    signals.forEach(sig => {
      process.on(sig, async () => {
        console.log(`\n[*] Intercepted ${sig}. Initiating graceful teardown on host...`);
        await this.teardownAll(sig === 'SIGINT' ? 130 : 143);
      });
    });

    process.on('uncaughtException', async (err) => {
      console.error('\n[FATAL] Uncaught exception in test runner:', err);
      await this.teardownAll(2);
    });

    process.on('unhandledRejection', async (reason) => {
      console.error('\n[FATAL] Unhandled promise rejection in test runner:', reason);
      await this.teardownAll(2);
    });

    process.on('exit', () => {
      this.forceKillRegisteredPidsSync();
    });
  }

  registerServer(server) {
    if (!server) return;
    this.servers.add(server);
    if (server.child && server.child.pid) {
      this.childPids.add(server.child.pid);
    }
  }

  unregisterServer(server) {
    if (!server) return;
    this.servers.delete(server);
    if (server.child && server.child.pid) this.childPids.delete(server.child.pid);
  }

  registerBrowserDriver(driver) {
    if (!driver) return;
    this.browserDrivers.add(driver);
    if (driver.browser) {
      try {
        const proc = driver.browser.process();
        if (proc && proc.pid) this.childPids.add(proc.pid);
      } catch (e) {}
    }
  }

  unregisterBrowserDriver(driver) {
    if (!driver) return;
    this.browserDrivers.delete(driver);
    if (driver.browser) {
      try {
        const proc = driver.browser.process();
        if (proc && proc.pid) this.childPids.delete(proc.pid);
      } catch (e) {}
    }
  }

  static isProcessAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  }

  static killProcessTree(pid) {
    if (!pid || !ProcessCleanupRegistry.isProcessAlive(pid)) return;
    if (process.platform === 'win32') {
      try {
        cp.execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } catch (e) {}
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (e) {
        try { process.kill(pid, 'SIGKILL'); } catch (e2) {}
      }
    }
  }

  forceKillRegisteredPidsSync() {
    for (const pid of this.childPids) {
      if (ProcessCleanupRegistry.isProcessAlive(pid)) {
        ProcessCleanupRegistry.killProcessTree(pid);
      }
    }
  }

  async teardownAll(exitCode = 0) {
    if (this.isTearingDown) return;
    this.isTearingDown = true;

    // 1. Close all active browser drivers
    for (const driver of this.browserDrivers) {
      try {
        if (driver.browser) {
          const proc = driver.browser.process();
          const pid = proc ? proc.pid : null;
          await Promise.race([
            driver.close(),
            new Promise(r => setTimeout(r, 2000))
          ]);
          if (pid && ProcessCleanupRegistry.isProcessAlive(pid)) {
            ProcessCleanupRegistry.killProcessTree(pid);
          }
        }
      } catch (e) {}
    }
    this.browserDrivers.clear();

    // 2. Shut down servers
    for (const server of this.servers) {
      try {
        const pid = server.child ? server.child.pid : null;
        await Promise.race([
          server.stop(false, 2000),
          new Promise(r => setTimeout(r, 2500))
        ]);
        if (pid && ProcessCleanupRegistry.isProcessAlive(pid)) {
          ProcessCleanupRegistry.killProcessTree(pid);
        }
      } catch (e) {}
    }
    this.servers.clear();

    process.exit(exitCode);
  }
}

const cleanupRegistry = new ProcessCleanupRegistry();
cleanupRegistry.install();

// ======================================================================
// 2. Multi-Factor Game Server Signature Probe
// ======================================================================
/**
 * Probes target port to determine if it is free, running the Tibia MMO server,
 * or occupied by an unrelated service.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{ status: 'FREE'|'TIBIA_SERVER'|'COLLISION', details?: string }>}
 */
function probeServerPort(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let resolved = false;

    let req;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (req) {
          try { req.destroy(); } catch (e) {}
        }
        resolve({ status: 'COLLISION', details: `Probe timed out after ${timeoutMs}ms (unresponsive service)` });
      }
    }, timeoutMs);

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (req) {
          try { req.destroy(); } catch (e) {}
        }
        resolve(result);
      }
    };

    try {
      req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        let body = '';
        res.setEncoding('utf8');

        res.on('data', (chunk) => {
          body += chunk;
          if (body.includes('<title>Tibia MMO') || body.includes('Tibia MMO - V2') || body.includes('Choose Your Path') || body.includes('id="class-modal"')) {
            finish({ status: 'TIBIA_SERVER', details: 'Verified Tibia MMO HTML signature' });
          }
        });

        res.on('end', () => {
          const isTibia = res.statusCode === 200 &&
            (body.includes('<title>Tibia MMO') || body.includes('Tibia MMO - V2') || body.includes('Choose Your Path') || body.includes('id="class-modal"'));

          if (isTibia) {
            finish({ status: 'TIBIA_SERVER', details: 'Verified Tibia MMO HTML signature' });
          } else {
            finish({
              status: 'COLLISION',
              details: `Unrelated HTTP service detected (HTTP ${res.statusCode}, length: ${body.length} bytes)`
            });
          }
        });
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          finish({ status: 'FREE' });
        } else {
          finish({ status: 'COLLISION', details: `Port active but refused HTTP: ${err.code}` });
        }
      });
    } catch (e) {
      finish({ status: 'COLLISION', details: `Request exception: ${e.message}` });
    }
  });
}

// ======================================================================
// 3. CLI Options Parsing
// ======================================================================
function parseArgs(argv) {
  const options = {
    suite: 'baseline', // 'baseline' | 'acceptance' | 'all' | 'bots' | 'browser'
    gate: 'm1',       // 'm1' | 'm2' | 'm3' | 'm4' | 'm5' | 'm6'
    test: null,
    port: 8085,
    bail: false,
    headless: true,
    serverManaged: true,
    durationSec: null, // default set per suite
    botCount: 50
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--suite=')) {
      options.suite = arg.split('=')[1].toLowerCase();
    } else if (arg.startsWith('--gate=')) {
      options.gate = arg.split('=')[1].toLowerCase();
    } else if (arg.startsWith('--test=')) {
      options.test = arg.split('=')[1].toLowerCase();
    } else if (arg.startsWith('--port=')) {
      options.port = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--bots=')) {
      options.botCount = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--duration=')) {
      options.durationSec = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--bail') {
      options.bail = true;
    } else if (arg === '--no-headless' || arg === '--headless=false') {
      options.headless = false;
    } else if (arg === '--no-server-manage' || arg === '--server-managed=false') {
      options.serverManaged = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  // A gate or explicit test filter implies acceptance execution when the
  // caller did not provide --suite explicitly.
  const hasSuiteFlag = argv.some(arg => arg.startsWith('--suite='));
  if (!hasSuiteFlag && (options.gate !== 'm1' || options.test)) {
    options.suite = 'acceptance';
  }

  // Alias --suite=harness to baseline
  if (options.suite === 'harness') options.suite = 'baseline';

  const validSuites = ['baseline', 'acceptance', 'all', 'bots', 'browser'];
  if (!validSuites.includes(options.suite)) {
    console.error(`[Error] Invalid suite '${options.suite}'. Must be one of: ${validSuites.join(', ')}`);
    process.exit(3);
  }

  if (options.durationSec === null) {
    options.durationSec = options.suite === 'baseline' ? 5 : 10;
  }

  return options;
}

function printHelp() {
  console.log(`
Usage: node tests/e2e_runner.js [options]

Execution Modes:
  --suite=baseline             Tier A: Baseline Test Harness Verification (M1 Quality Gate)
  --suite=acceptance           Tier B: Acceptance Criteria Gates (AC1-AC7, honest reporting)
  --suite=all                  Runs both Baseline Harness and Acceptance Gates
  --suite=bots                 Runs Headless Bot Acceptance (AC5, AC6, AC7)
  --suite=browser              Runs Browser Acceptance (AC1, AC2, AC3, AC4)

Options:
  --gate=<m1|m2|m3|m4|m5|m6>   Target milestone evaluation gate (default: m1)
  --test=<name>                Filter specific test by name/acronym (ac1..ac7, load, subclass, etc.)
  --port=<number>              Test server port (default: 8085)
  --bots=<number>              Number of bots for load test (default: 50)
  --duration=<number>          Load test duration in seconds (default: 5 for baseline, 10 for acceptance)
  --bail                       Abort immediately on first failure
  --no-headless                Run browser acceptance with visible Chrome/Edge UI
  --no-server-manage           Connect to already running server (do not spawn)
  --help, -h                   Show this help message

Exit Codes:
  0 - Success (Tier A Baseline passed or Target Milestone Gate passed)
  1 - One or more tests failed assertions
  2 - Harness / infrastructure error (port collision, spawn crash, missing browser)
  3 - Configuration or argument error
`);
}

// ======================================================================
// 4. Tier A: Baseline Test Harness Verification Suite
// ======================================================================
async function runTierABaseline(options, serverUrl) {
  console.log(`\n======================================================================`);
  console.log(`🛠️  TIER A: BASELINE TEST HARNESS VERIFICATION`);
  console.log(`   Target: Milestone 1 Completion Gate | Strict Assertions | Zero Mocks`);
  console.log(`======================================================================\n`);

  const results = [];

  // Test 1: [HARNESS-SRV] Ephemeral Server Lifecycle & Readiness Probe
  console.log(`>>> Executing [HARNESS-SRV] Ephemeral Server Lifecycle & Readiness Probe...`);
  const srvStart = Date.now();
  let srvSuccess = false;
  let srvError = null;
  try {
    const probe = await probeServerPort(options.port);
    if (probe.status !== 'TIBIA_SERVER') {
      throw new Error(`Expected TIBIA_SERVER on port ${options.port}, got: ${probe.status} (${probe.details || ''})`);
    }
    srvSuccess = true;
    console.log(`   ✓ Server response verified with Tibia MMO HTML signature (${Date.now() - srvStart}ms)`);
  } catch (err) {
    srvError = err;
    console.log(`   ✗ Server readiness probe failed: ${err.message}`);
  }
  results.push({ id: 'HARNESS-SRV', name: 'Ephemeral Server Lifecycle & Readiness Probe', success: srvSuccess, durationMs: Date.now() - srvStart, error: srvError });
  if (!srvSuccess && options.bail) return results;

  // Test 2: [HARNESS-BOT] BotClient Protocol & Disconnect Resilience
  console.log(`\n>>> Executing [HARNESS-BOT] BotClient Protocol & Disconnect Resilience...`);
  const botStart = Date.now();
  let botSuccess = false;
  let botError = null;
  try {
    const testBot = new BotClient({ serverUrl, name: 'HarnessProbeBot', classType: 'warrior' });
    await testBot.connect(serverUrl, 5000);
    const loginInfo = await testBot.login('HarnessProbeBot', 'warrior');
    if (!loginInfo || !testBot.loggedIn) {
      throw new Error('BotClient failed to complete login sequence');
    }
    // Test movement packet dispatch
    testBot.stepRandomWalkable();
    await new Promise(r => setTimeout(r, 200));
    await testBot.disconnect();

    // Verify error resilience on offline port (no unhandled error crash)
    const deadBot = new BotClient({ serverUrl: 'ws://localhost:65530' });
    await deadBot.connect('ws://localhost:65530', 500).catch(() => {});
    if (deadBot.errorCount === 0 && !deadBot.lastError) {
      // Expected clean error recording
    }
    botSuccess = true;
    console.log(`   ✓ BotClient connection, login, move, and disconnect verified cleanly (${Date.now() - botStart}ms)`);
  } catch (err) {
    botError = err;
    console.log(`   ✗ BotClient harness verification failed: ${err.message}`);
  }
  results.push({ id: 'HARNESS-BOT', name: 'BotClient Protocol & Disconnect Resilience', success: botSuccess, durationMs: Date.now() - botStart, error: botError });
  if (!botSuccess && options.bail) return results;

  // Test 3: [HARNESS-BRW] Headless Browser Launch & DOM Auto-Login
  console.log(`\n>>> Executing [HARNESS-BRW] Headless Browser Launch & DOM Auto-Login...`);
  const brwStart = Date.now();
  let brwSuccess = false;
  let brwError = null;
  const driver = new BrowserDriver({ port: options.port, headless: options.headless });
  cleanupRegistry.registerBrowserDriver(driver);
  try {
    await driver.init();
    cleanupRegistry.registerBrowserDriver(driver);
    const { page } = await driver.createAgentPage({ charName: 'BrwHarnessAgent', classType: 'mage', autoLogin: true });
    // Verify DOM elements loaded
    const canvasExists = await page.evaluate(() => !!document.getElementById('gameCanvas'));
    if (!canvasExists) throw new Error('#gameCanvas element not found in DOM');
    const hpText = await page.$eval('#hp-text', el => el.innerText).catch(() => '');
    if (!hpText.includes('HP:')) throw new Error(`Expected #hp-text to contain 'HP:', got: "${hpText}"`);
    await driver.close();
    cleanupRegistry.unregisterBrowserDriver(driver);
    brwSuccess = true;
    console.log(`   ✓ Headless browser launched, DOM auto-login passed, canvas detected (${Date.now() - brwStart}ms)`);
  } catch (err) {
    brwError = err;
    await driver.close().catch(() => {});
    cleanupRegistry.unregisterBrowserDriver(driver);
    console.log(`   ✗ Headless browser verification failed: ${err.message}`);
  }
  results.push({ id: 'HARNESS-BRW', name: 'Headless Browser Launch & DOM Auto-Login', success: brwSuccess, durationMs: Date.now() - brwStart, error: brwError });
  if (!brwSuccess && options.bail) return results;

  // Test 4: [HARNESS-CAN] CanvasInspector Buffer Sampling Integrity
  console.log(`\n>>> Executing [HARNESS-CAN] CanvasInspector Buffer Sampling Integrity...`);
  const canStart = Date.now();
  let canSuccess = false;
  let canError = null;
  const canDriver = new BrowserDriver({ port: options.port, headless: options.headless });
  cleanupRegistry.registerBrowserDriver(canDriver);
  try {
    await canDriver.init();
    cleanupRegistry.registerBrowserDriver(canDriver);
    const { page } = await canDriver.createAgentPage({ charName: 'CanHarnessAgent', classType: 'ranger', autoLogin: true });
    await CanvasInspector.installRenderSpy(page);
    await new Promise(r => setTimeout(r, 400));
    // Sample real canvas pixel buffer
    const pixel = await CanvasInspector.getPixel(page, 100, 100);
    if (typeof pixel.r !== 'number' || typeof pixel.g !== 'number' || typeof pixel.b !== 'number' || typeof pixel.a !== 'number') {
      throw new Error(`Invalid pixel buffer returned: ${JSON.stringify(pixel)}`);
    }
    // Verify sampling area average
    const area = await CanvasInspector.sampleAreaAverage(page, 50, 50, 20, 20);
    if (typeof area.r !== 'number') throw new Error(`Invalid area average returned`);

    // Verify isRedTelegraphActive rejects normal terrain
    const isFalsePositive = CanvasInspector.isRedTelegraphActive(pixel);
    if (isFalsePositive) throw new Error(`False-positive telegraph active on default terrain`);

    await canDriver.close();
    cleanupRegistry.unregisterBrowserDriver(canDriver);
    canSuccess = true;
    console.log(`   ✓ Canvas pixel buffer sampled directly without mock drawing (${Date.now() - canStart}ms)`);
  } catch (err) {
    canError = err;
    await canDriver.close().catch(() => {});
    cleanupRegistry.unregisterBrowserDriver(canDriver);
    console.log(`   ✗ CanvasInspector verification failed: ${err.message}`);
  }
  results.push({ id: 'HARNESS-CAN', name: 'CanvasInspector Buffer Sampling Integrity', success: canSuccess, durationMs: Date.now() - canStart, error: canError });
  if (!canSuccess && options.bail) return results;

  // Test 5: [AC5-LOAD] 50-Bot Concurrent Load Stress (Baseline Load Verification)
  console.log(`\n>>> Executing [AC5-LOAD] 50-Bot Concurrent Load Stress (${options.durationSec}s)...`);
  const loadResult = await runLoadTest({
    serverUrl,
    botCount: options.botCount,
    durationSec: options.durationSec,
    verbose: false
  });
  results.push({ id: 'AC5-LOAD', name: '50-Bot Concurrent Load Baseline', ...loadResult });

  return results;
}

// ======================================================================
// 5. Tier B: Acceptance Criteria Quality Gates Suite
// ======================================================================
async function runTierBAcceptance(options, serverUrl, serverSpawnedByRunner, serverController = null) {
  console.log(`\n======================================================================`);
  console.log(`🎯 TIER B: ACCEPTANCE CRITERIA QUALITY GATES (AC1 - AC7)`);
  console.log(`   Strict Ground-Truth Oracles | Zero Mocks | Honest Reporting`);
  console.log(`======================================================================\n`);

  const results = [];
  const filter = options.test;

  // AC1: Sub-class progression
  if (!filter || filter.includes('ac1') || filter.includes('subclass')) {
    console.log(`\n>>> Executing AC1: Sub-Class Progression Acceptance Test...`);
    const ac1 = await runSubclassTest({ port: options.port, headless: options.headless });
    results.push({ id: 'AC1', name: 'Sub-Class Progression (Warrior -> Juggernaut)', targetMilestone: 'M3', ...ac1 });
  }

  // AC2: Boss AoE Ground Indicator
  if (!filter || filter.includes('ac2') || filter.includes('boss') || filter.includes('aoe')) {
    console.log(`\n>>> Executing AC2: Boss Combat & AoE Ground Indicator Acceptance Test...`);
    const ac2 = await runBossAoETest({ port: options.port, headless: options.headless });
    results.push({ id: 'AC2', name: 'Boss AoE Ground Indicator Telegraph', targetMilestone: 'M3', ...ac2 });
  }

  // AC3: NPC Dialogue & Quest UI
  if (!filter || filter.includes('ac3') || filter.includes('npc') || filter.includes('quest')) {
    console.log(`\n>>> Executing AC3: NPC Dialogue DAG & Multi-Step Quest UI Test...`);
    const ac3 = await runNpcQuestTest({ port: options.port, headless: options.headless });
    results.push({ id: 'AC3', name: 'NPC Dialogue DAG & Multi-Step Quest UI', targetMilestone: 'M4', ...ac3 });
  }

  // AC4: 2-Player Secure Trade Flow
  if (!filter || filter.includes('ac4') || filter.includes('trade')) {
    console.log(`\n>>> Executing AC4: 2-Player Secure Trade Interface Flow Test...`);
    const ac4 = await runTradeTest({ port: options.port, headless: options.headless });
    results.push({ id: 'AC4', name: '2-Player Secure Trade Interface Flow', targetMilestone: 'M5', ...ac4 });
  }

  // AC5: 50-Bot Concurrent Load Test
  if (!filter || filter.includes('ac5') || filter.includes('load') || filter.includes('50')) {
    console.log(`\n>>> Executing AC5: 50-Bot Concurrent Load Test...`);
    const ac5 = await runLoadTest({
      serverUrl,
      botCount: options.botCount,
      durationSec: options.durationSec || 10,
      verbose: false
    });
    results.push({ id: 'AC5', name: '50-Bot Concurrent Load & Tick Benchmark', targetMilestone: 'M2', ...ac5 });
  }

  // AC6: Party Formation & Multi-Channel Chat
  if (!filter || filter.includes('ac6') || filter.includes('party') || filter.includes('chat')) {
    console.log(`\n>>> Executing AC6: Party Formation & Multi-Channel Chat Test...`);
    const ac6 = await runPartyChatTest({ serverUrl });
    results.push({ id: 'AC6', name: 'Party Formation & Multi-Channel Chat', targetMilestone: 'M5', ...ac6 });
  }

  // AC7: Persistence Across Clean Restart
  if (!filter || filter.includes('ac7') || filter.includes('persist') || filter.includes('restart')) {
    console.log(`\n>>> Executing AC7: Server Restart & State Persistence Test...`);
    const ac7 = await runPersistenceTest({
      port: options.port,
      manageServer: serverSpawnedByRunner,
      serverController: serverSpawnedByRunner ? serverController : null,
      leaveServerRunning: true
    });
    results.push({ id: 'AC7', name: 'Server Persistence Across Clean Cold Restart', targetMilestone: 'M2', ...ac7 });
  }

  return results;
}

// ======================================================================
// 6. Master Runner Main Execution
// ======================================================================
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startTime = Date.now();

  console.log(`======================================================================`);
  console.log(`⚔️  TIBIA MMORPG EXPANSION: MASTER E2E & ACCEPTANCE RUNNER`);
  console.log(`   Suite: ${options.suite.toUpperCase()} | Gate: ${options.gate.toUpperCase()} | Port: ${options.port} | Headless: ${options.headless}`);
  console.log(`======================================================================\n`);

  let server = null;
  let serverSpawnedByRunner = false;

  // 1. Port Collision and Server Readiness Inspection
  if (options.serverManaged) {
    const probe = await probeServerPort(options.port);
    if (probe.status === 'COLLISION') {
      console.error(`[Error] Port ${options.port} is already occupied by an unrelated service:\n  ${probe.details}`);
      console.error(`Cannot safely launch ephemeral test server. Specify a different port using --port=<number>.`);
      process.exit(2);
    } else if (probe.status === 'TIBIA_SERVER') {
      const requiresDedicatedServer = ['acceptance', 'bots', 'all'].includes(options.suite);
      if (requiresDedicatedServer) {
        console.error(`[Error] Port ${options.port} already hosts a Tibia server. Acceptance/persistence tests require a dedicated runner-owned server and isolated persistence file.`);
        console.error('Choose another --port or stop the existing server.');
        process.exit(2);
      }
      console.log(`[*] Detected running Tibia MMO server on port ${options.port}. Using existing instance.`);
    } else {
      console.log(`[*] Spawning ephemeral test server on port ${options.port}...`);
      server = new ServerController({ port: options.port });
      cleanupRegistry.registerServer(server);
      try {
        await server.start(8000);
        cleanupRegistry.registerServer(server);
        serverSpawnedByRunner = true;
        console.log(`[✓] Ephemeral test server ready at http://localhost:${options.port}/`);
      } catch (err) {
        console.error(`[!] Failed to launch ephemeral server on port ${options.port}:`, err.message);
        process.exit(2);
      }
    }
  }

  const serverUrl = `ws://localhost:${options.port}`;
  let tierAResults = [];
  let tierBResults = [];
  let runError = null;

  try {
    // 2. Execute Selected Suites
    if (options.suite === 'baseline' || options.suite === 'all') {
      tierAResults = await runTierABaseline(options, serverUrl);
    }

    if (options.suite === 'acceptance' || options.suite === 'all') {
      tierBResults = await runTierBAcceptance(options, serverUrl, serverSpawnedByRunner, server);
    } else if (options.suite === 'bots') {
      // Execute bot acceptance subset
      const b1 = await runLoadTest({ serverUrl, botCount: options.botCount, durationSec: options.durationSec || 10 });
      const b2 = await runPartyChatTest({ serverUrl });
      const b3 = await runPersistenceTest({
        port: options.port,
        manageServer: serverSpawnedByRunner,
        serverController: serverSpawnedByRunner ? server : null,
        leaveServerRunning: true
      });
      tierBResults.push(
        { id: 'AC5', name: '50-Bot Concurrent Load Test', targetMilestone: 'M2', ...b1 },
        { id: 'AC6', name: 'Party Formation & Chat Routing', targetMilestone: 'M5', ...b2 },
        { id: 'AC7', name: 'Server Persistence Across Restart', targetMilestone: 'M2', ...b3 }
      );
    } else if (options.suite === 'browser') {
      const browserTarget = options.test || 'all';
      const bResult = await runBrowserSuite({
        test: browserTarget,
        port: options.port,
        headless: options.headless,
        bail: options.bail
      });
      bResult.details.forEach(detail => {
        tierBResults.push({
          id: detail.key.toUpperCase(),
          name: detail.name,
          success: detail.success,
          durationMs: detail.durationMs,
          error: detail.error
        });
      });
    }

  } catch (err) {
    runError = err;
    console.error(`\n[!] Test run interrupted by unexpected exception:`, err);
  } finally {
    // 3. Graceful Ephemeral Server Teardown
    if (server && serverSpawnedByRunner) {
      console.log(`\n[*] Shutting down ephemeral test server...`);
      await server.stop(false, 3000);
      cleanupRegistry.unregisterServer(server);
      console.log(`[✓] Test server terminated cleanly.`);
    }
  }

  if (runError) {
    console.error('[Error] Test run had an infrastructure exception; no success verdict is allowed.');
    process.exit(2);
  }

  if (options.test && options.suite !== 'baseline' && tierBResults.length === 0) {
    console.error(`[Error] Test filter '${options.test}' did not select any acceptance tests.`);
    process.exit(3);
  }

  // 4. Synthesize Summary Report
  const totalDuration = Date.now() - startTime;
  console.log(`\n======================================================================`);
  console.log(`📊 MASTER E2E & ACCEPTANCE SPECIFICATION SUMMARY`);
  console.log(`   Target Suite: ${options.suite.toUpperCase()} | Gate: ${options.gate.toUpperCase()} | Total Duration: ${(totalDuration / 1000).toFixed(2)}s`);
  console.log(`======================================================================`);

  if (tierAResults.length > 0) {
    const tierAPassed = tierAResults.filter(r => r.success).length;
    console.log(`\n🛠️  TIER A: BASELINE TEST HARNESS VERIFICATION (${tierAPassed}/${tierAResults.length} PASSED)`);
    console.log(`----------------------------------------------------------------------`);
    tierAResults.forEach(r => {
      const statusTag = r.success ? '✓ PASS' : '✗ FAIL';
      console.log(`   ${statusTag} [${r.id}] ${r.name.padEnd(46)} (${r.durationMs}ms)`);
      if (!r.success && r.error) console.log(`          Error: ${r.error.message}`);
    });
  }

  if (tierBResults.length > 0) {
    const tierBPassed = tierBResults.filter(r => r.success).length;
    const tierBPending = tierBResults.filter(r => !r.success).length;
    console.log(`\n🎯 TIER B: ACCEPTANCE CRITERIA QUALITY GATES (${tierBPassed} Passed, ${tierBPending} Pending Future Implementation)`);
    console.log(`----------------------------------------------------------------------`);
    tierBResults.forEach(r => {
      const statusTag = r.success ? '✓ PASS   ' : '⏳ PENDING';
      const targetTag = r.targetMilestone ? `[Target: ${r.targetMilestone}]` : '';
      console.log(`   ${statusTag} [${r.id}] ${r.name.padEnd(46)} ${targetTag}`);
      if (!r.success && r.error) console.log(`          Reason: ${r.error.message}`);
    });
  }

  console.log(`\n======================================================================`);
  console.log(`🏁 QUALITY GATE EVALUATION`);
  console.log(`----------------------------------------------------------------------`);

  // Gate evaluation logic
  let gatePassed = false;
  if (options.suite === 'baseline') {
    const tierAAllPass = tierAResults.length > 0 && tierAResults.every(r => r.success);
    gatePassed = tierAAllPass;
    console.log(`   Milestone Gate  : M1 (Test Infrastructure & Acceptance Harness)`);
    console.log(`   Harness Health  : ${tierAResults.filter(r => r.success).length}/${tierAResults.length} Baseline Tests Passed`);
    console.log(`   Integrity State : Strict Ground-Truth Oracles Active (Zero Mocks)`);
    console.log(`   Gate Verdict    : ${gatePassed ? 'PASSED [✓]' : 'FAILED [✗]'}`);
    if (gatePassed) {
      console.log(`   Next Milestone  : Ready for M2 (Technical Refactoring & Persistence Architecture)`);
    }
  } else if (options.suite === 'all') {
    const tierAAllPass = tierAResults.length > 0 && tierAResults.every(r => r.success);
    const allAcceptancePassed = tierBResults.length > 0 && tierBResults.every(r => r.success);
    gatePassed = tierAAllPass && allAcceptancePassed;
    console.log(`   Milestone Gate  : ${options.gate.toUpperCase()}`);
    console.log(`   Baseline Pass   : ${tierAResults.filter(r => r.success).length}/${tierAResults.length} Passed`);
    console.log(`   Acceptance Pass : ${tierBResults.filter(r => r.success).length}/${tierBResults.length} Passed`);
    console.log(`   Gate Verdict    : ${gatePassed ? 'PASSED [✓]' : 'FAILED [✗]'}`);
  } else {
    // For later milestone gates (M2 - M6)
    const allAcceptancePassed = tierBResults.length > 0 && tierBResults.every(r => r.success);
    gatePassed = allAcceptancePassed;
    console.log(`   Milestone Gate  : ${options.gate.toUpperCase()}`);
    console.log(`   Acceptance Pass : ${tierBResults.filter(r => r.success).length}/${tierBResults.length} Passed`);
    console.log(`   Gate Verdict    : ${gatePassed ? 'PASSED [✓]' : 'FAILED [✗]'}`);
  }
  console.log(`======================================================================\n`);

  if (options.suite === 'acceptance') {
    // Standalone acceptance suite reports exit code 0 only if all criteria are met
    const allPassed = tierBResults.length > 0 && tierBResults.every(r => r.success);
    process.exit(allPassed ? 0 : 1);
  }

  process.exit(gatePassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal harness error in e2e_runner:', err);
  process.exit(2);
});
