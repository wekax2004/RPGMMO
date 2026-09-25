/**
 * tests/test_chrome_lifecycle.js
 * Empirical Challenger Verification Harness: Chrome Process Lifecycle & Cleanup on Windows
 */

const { spawnSync, execSync, spawn } = require('child_process');
const path = require('path');
const { BrowserDriver } = require('./browser/browser_driver');
const ServerController = require('./lib/server_controller');

function getRunningChromePids() {
  try {
    const stdout = execSync('powershell -NoProfile -Command "Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"', { encoding: 'utf8' });
    const pids = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number);
    return new Set(pids);
  } catch (e) {
    return new Set();
  }
}

function getNewPids(beforeSet, afterSet) {
  const leaks = [];
  for (const pid of afterSet) {
    if (!beforeSet.has(pid)) {
      leaks.push(pid);
    }
  }
  return leaks;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runEmpiricalLifecycleTests() {
  console.log('======================================================================');
  console.log('🔍 EMPIRICAL VERIFICATION: PUPPETEER PROCESS LIFECYCLE ON WINDOWS');
  console.log('======================================================================\n');

  let allPassed = true;
  const initialChromePids = getRunningChromePids();
  console.log(`[*] Baseline Chrome PIDs already on host: ${initialChromePids.size}`);

  // Test 1: Single BrowserDriver init and close
  console.log('\n--- TEST 1: Direct BrowserDriver init() -> close() Lifecycle ---');
  {
    const beforePids = getRunningChromePids();
    const driver = new BrowserDriver({ headless: true });
    await driver.init();
    
    const rootProc = driver.browser.process();
    const rootPid = rootProc ? rootProc.pid : null;
    console.log(`    Browser spawned. Root PID: ${rootPid}`);
    
    const duringPids = getRunningChromePids();
    const spawnedPids = getNewPids(beforePids, duringPids);
    console.log(`    Total Chrome processes spawned in tree: ${spawnedPids.length} (PIDs: ${spawnedPids.join(', ')})`);
    
    await driver.close();
    await sleep(500); // allow OS process table to settle
    
    const afterPids = getRunningChromePids();
    const leaked = getNewPids(beforePids, afterPids);
    
    if (leaked.length === 0) {
      console.log('    ✓ PASS: 100% of spawned Chrome processes cleanly terminated.');
    } else {
      console.error(`    ✗ FAIL: Leaked Chrome processes: ${leaked.join(', ')}`);
      allPassed = false;
      // Clean up leaks
      leaked.forEach(pid => {
        try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
      });
    }
  }

  // Test 2: BrowserDriver with page navigation and WebSockets
  console.log('\n--- TEST 2: BrowserDriver with Ephemeral Server & Page Navigation ---');
  {
    const testPort = 8098;
    const server = new ServerController({ port: testPort });
    await server.start();
    console.log(`    Ephemeral server started on port ${testPort}`);

    const beforePids = getRunningChromePids();
    const driver = new BrowserDriver({ port: testPort, headless: true });
    await driver.init();
    
    const agent = await driver.createAgentPage({
      charName: 'LifecycleBot',
      classType: 'warrior',
      autoLogin: true
    });
    console.log('    Agent logged in and connected via WebSocket.');
    
    await sleep(500);
    
    await driver.close();
    await server.stop();
    await sleep(500);

    const afterPids = getRunningChromePids();
    const leaked = getNewPids(beforePids, afterPids);

    if (leaked.length === 0) {
      console.log('    ✓ PASS: Zero orphaned Chrome processes after page navigation and WebSocket session.');
    } else {
      console.error(`    ✗ FAIL: Leaked Chrome processes: ${leaked.join(', ')}`);
      allPassed = false;
      leaked.forEach(pid => {
        try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
      });
    }
  }

  // Test 3: Dual Browser Agents (Trade scenario context creation and teardown)
  console.log('\n--- TEST 3: Multi-Context Dual Browser Agents Teardown ---');
  {
    const testPort = 8099;
    const server = new ServerController({ port: testPort });
    await server.start();

    const beforePids = getRunningChromePids();
    const driver = new BrowserDriver({ port: testPort, headless: true });
    await driver.init();

    const agent1 = await driver.createAgentPage({ charName: 'DualAgent1', classType: 'mage', autoLogin: true });
    const agent2 = await driver.createAgentPage({ charName: 'DualAgent2', classType: 'ranger', autoLogin: true });
    console.log('    Two independent browser contexts spawned and active.');

    await sleep(500);

    await driver.close();
    await server.stop();
    await sleep(500);

    const afterPids = getRunningChromePids();
    const leaked = getNewPids(beforePids, afterPids);

    if (leaked.length === 0) {
      console.log('    ✓ PASS: Zero orphaned Chrome processes after dual-agent multi-context execution.');
    } else {
      console.error(`    ✗ FAIL: Leaked Chrome processes: ${leaked.join(', ')}`);
      allPassed = false;
      leaked.forEach(pid => {
        try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
      });
    }
  }

  // Test 4: Full Browser Runner execution via CLI
  console.log('\n--- TEST 4: Full Browser Suite CLI Execution (tests/browser/browser_runner.js) ---');
  {
    const testPort = 8101;
    const server = new ServerController({ port: testPort });
    await server.start();

    const beforePids = getRunningChromePids();
    console.log(`    Running browser runner CLI on port ${testPort}...`);

    const result = spawnSync('node', ['tests/browser/browser_runner.js', `--port=${testPort}`, '--test=all'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8'
    });

    console.log(`    browser_runner finished with exit code ${result.status}`);

    await server.stop();
    await sleep(800);

    const afterPids = getRunningChromePids();
    const leaked = getNewPids(beforePids, afterPids);

    if (leaked.length === 0) {
      console.log('    ✓ PASS: Zero orphaned Chrome processes after full browser runner execution.');
    } else {
      console.error(`    ✗ FAIL: Leaked Chrome processes: ${leaked.join(', ')}`);
      allPassed = false;
      leaked.forEach(pid => {
        try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
      });
    }
  }

  // Test 5: Process tree force kill recovery (Abnormal runner crash test)
  console.log('\n--- TEST 5: Abnormal Runner Crash / Signal Handling Simulation ---');
  {
    const beforePids = getRunningChromePids();

    const childScript = `
      const { BrowserDriver } = require('./tests/browser/browser_driver');
      (async () => {
        const driver = new BrowserDriver({ headless: true });
        await driver.init();
        process.stdout.write('PID:' + driver.browser.process().pid + '\\n');
        setInterval(() => {}, 1000);
      })();
    `;

    const subproc = spawn('node', ['-e', childScript], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let spawnedRootPid = null;
    await new Promise((resolve) => {
      subproc.stdout.on('data', (d) => {
        const m = d.toString().match(/PID:(\d+)/);
        if (m) {
          spawnedRootPid = parseInt(m[1], 10);
          resolve();
        }
      });
    });

    console.log(`    Subprocess spawned Chrome root PID: ${spawnedRootPid}`);
    await sleep(500);

    try {
      execSync(`taskkill /pid ${subproc.pid} /T /F`, { stdio: 'ignore' });
    } catch (e) {}

    try {
      if (spawnedRootPid) {
        execSync(`taskkill /pid ${spawnedRootPid} /T /F`, { stdio: 'ignore' });
      }
    } catch (e) {}

    await sleep(500);

    const afterPids = getRunningChromePids();
    const leaked = getNewPids(beforePids, afterPids);

    if (leaked.length === 0) {
      console.log('    ✓ PASS: Abnormal crash cleanly cleaned up via Windows taskkill process tree kill.');
    } else {
      console.error(`    ✗ FAIL: Leaked Chrome processes: ${leaked.join(', ')}`);
      allPassed = false;
      leaked.forEach(pid => {
        try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
      });
    }
  }

  console.log('\n======================================================================');
  console.log(`🏁 LIFECYCLE VERIFICATION RESULT: ${allPassed ? 'ALL PASSED [✓]' : 'FAILED [✗]'}`);
  console.log('======================================================================\n');

  process.exit(allPassed ? 0 : 1);
}

runEmpiricalLifecycleTests().catch(err => {
  console.error('Fatal error in lifecycle test harness:', err);
  process.exit(2);
});
