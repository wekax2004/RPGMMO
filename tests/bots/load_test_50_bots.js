/**
 * tests/bots/load_test_50_bots.js
 * AC5 Load Test Harness: 50 Concurrent Headless WebSocket Bots
 *
 * Spawns 50 concurrent headless bots with staggered batch connection,
 * executes autonomous movement (pathfinding/random walk) and combat loops,
 * profiles server tick interval, jitter, and action roundtrip time (RTT),
 * monitors active bot retention and memory consumption,
 * and asserts stability thresholds.
 */

const http = require('http');
const { URL } = require('url');
const BotClient = require('./bot_client');

function sampleServerRss(serverUrl) {
    return new Promise(resolve => {
        let endpoint;
        try {
            const parsed = new URL(serverUrl);
            endpoint = { host: parsed.hostname, port: parsed.port || 80 };
        } catch (error) {
            resolve(null);
            return;
        }
        const request = http.get(`http://${endpoint.host}:${endpoint.port}/metrics`, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try {
                    const metrics = JSON.parse(body);
                    resolve(Number.isFinite(metrics.rssBytes) ? Math.round(metrics.rssBytes / 1024 / 1024) : null);
                } catch (error) {
                    resolve(null);
                }
            });
        });
        request.on('error', () => resolve(null));
        request.setTimeout(1000, () => { request.destroy(); resolve(null); });
    });
}

/**
 * Runs the 50-bot concurrent load test.
 * @param {object} options
 * @param {number} options.botCount - Number of bots (default 50)
 * @param {number} options.durationSec - Test duration in seconds (default 15)
 * @param {string} options.serverUrl - WebSocket server URL (default ws://localhost:8080)
 * @param {boolean} options.verbose - Verbose console logs
 * @returns {Promise<{success: boolean, metrics: object, error: Error|null}>}
 */
async function runLoadTest(options = {}) {
  const botCount = options.botCount !== undefined ? options.botCount : 50;
  const durationSec = options.durationSec !== undefined ? options.durationSec : 15;
  const serverUrl = options.serverUrl || 'ws://localhost:8080';
  const verbose = options.verbose || false;

  console.log(`\n=============================================================`);
  console.log(`🚀 [AC5] Starting 50-Bot Concurrent Load Test`);
  console.log(`   Target: ${serverUrl} | Bots: ${botCount} | Duration: ${durationSec}s`);
  console.log(`=============================================================\n`);

  const startTime = Date.now();
  const bots = [];

  try {
    // 1. Initialize BotClient instances with unique names and classes
    let botErrorCount = 0;
    for (let i = 1; i <= botCount; i++) {
      const classType = (i % 3 === 0) ? 'mage' : (i % 3 === 1 ? 'warrior' : 'ranger');
      const bot = new BotClient({
        serverUrl,
        name: `LoadBot_${String(i).padStart(2, '0')}`,
        classType,
        warmode: false,
        logMessages: false
      });
      bot.on('error', (err) => {
        botErrorCount++;
        if (verbose) console.warn(`   [Bot Error] ${err.message}`);
      });
      bots.push(bot);
    }

    // 2. Staggered Batch Connection (batches of 5 bots every 150ms to avoid TCP syn flood)
    console.log(`[*] Connecting ${botCount} bots in staggered batches...`);
    const batchSize = 5;
    for (let i = 0; i < bots.length; i += batchSize) {
      const batch = bots.slice(i, i + batchSize);
      await Promise.all(batch.map(bot =>
        bot.connect(serverUrl, 8000).then(() => bot.login(bot.charName, bot.classType, false, 8000))
      ));
      if (verbose) {
        console.log(`   Connected ${Math.min(i + batchSize, botCount)} / ${botCount} bots`);
      }
      await new Promise(r => setTimeout(r, 150));
    }

    // Verify all bots successfully reached loggedIn state
    const loggedInCount = bots.filter(b => b.connected && b.loggedIn).length;
    console.log(`[✓] All ${loggedInCount} / ${botCount} bots successfully connected and logged in.`);
    if (loggedInCount < botCount) {
      throw new Error(`Failed to log in all bots. Expected ${botCount}, logged in: ${loggedInCount}`);
    }

    // 3. Initiate Active Load: Movement & Combat
    console.log(`[*] Starting autonomous movement (350ms tick) and combat loops...`);
    bots.forEach((bot, idx) => {
      // Add slight jitter to step intervals (300ms - 400ms) to simulate organic player behavior
      const stepInterval = 320 + (idx % 8) * 15;
      bot.startRandomWalk(stepInterval);
      bot.startAutoCombat(1000);
    });

    // 4. Sample metrics throughout the load test duration
    const memorySamples = [];
    const checkIntervalMs = 2000;
    const testEndTime = Date.now() + (durationSec * 1000);

    while (Date.now() < testEndTime) {
      await new Promise(r => setTimeout(r, checkIntervalMs));
      const activeCount = bots.filter(b => b.connected && b.loggedIn).length;
      const serverRssMb = await sampleServerRss(serverUrl);
      const harnessRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
      if (serverRssMb !== null) memorySamples.push(serverRssMb);

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      console.log(`   [T+${elapsedSec}s] Active Bots: ${activeCount}/${botCount} | Server RSS: ${serverRssMb === null ? 'unavailable' : serverRssMb + 'MB'} | Harness RSS: ${harnessRssMb}MB`);

      if (activeCount < botCount) {
        throw new Error(`Bot concurrency dropped during load! Expected ${botCount}, active: ${activeCount}`);
      }
    }

    // 5. Stop activity before teardown
    console.log(`[*] Load phase complete. Halting movement and combat loops...`);
    bots.forEach(b => {
      b.stopRandomWalk();
      b.stopAutoCombat();
    });

    // 6. Aggregate Metrics across all bots
    console.log(`[*] Aggregating performance metrics...`);
    const allRtt = bots.flatMap(b => b.rttSamples).filter(v => typeof v === 'number' && !isNaN(v));
    const allTicks = bots.flatMap(b => b.tickIntervals).filter(v => typeof v === 'number' && !isNaN(v));

    let rttMetrics = { count: 0, min: 0, mean: 0, p50: 0, p95: 0, max: 0 };
    if (allRtt.length > 0) {
      const sortedRtt = [...allRtt].sort((a, b) => a - b);
      const sumRtt = sortedRtt.reduce((a, b) => a + b, 0);
      rttMetrics = {
        count: sortedRtt.length,
        min: sortedRtt[0],
        mean: Math.round(sumRtt / sortedRtt.length),
        p50: sortedRtt[Math.floor(sortedRtt.length * 0.50)],
        p95: sortedRtt[Math.floor(sortedRtt.length * 0.95)],
        max: sortedRtt[sortedRtt.length - 1]
      };
    }

    let tickMetrics = { count: 0, meanInterval: 0, jitter: 0, maxDelay: 0 };
    if (allTicks.length > 0) {
      const sumTick = allTicks.reduce((a, b) => a + b, 0);
      const meanTick = sumTick / allTicks.length;
      const maxTick = Math.max(...allTicks);
      const variance = allTicks.reduce((acc, val) => acc + Math.pow(val - meanTick, 2), 0) / allTicks.length;
      tickMetrics = {
        count: allTicks.length,
        meanInterval: Math.round(meanTick),
        jitter: Math.round(Math.sqrt(variance)),
        maxDelay: Math.round(maxTick)
      };
    }

    const peakRss = Math.max(...memorySamples, 0);

    // 7. Cleanup & Clean Disconnection
    console.log(`[*] Disconnecting all ${botCount} bots cleanly...`);
    await Promise.all(bots.map(b => b.disconnect()));

    // 8. Assertions against Acceptance Thresholds
    // Criteria: 50 concurrent bots active without crash or intolerable delays
    const assertions = [
      { name: '100% Concurrency Retention', passed: loggedInCount === botCount, actual: `${loggedInCount}/${botCount}` },
      { name: 'Tick Samples Collected', passed: tickMetrics.count > 0, actual: `${tickMetrics.count} samples` },
       { name: 'Server RSS Sample Collected', passed: memorySamples.length > 0, actual: `${memorySamples.length} samples` },
      { name: 'Tick Delay Tolerance (max < 2000ms)', passed: tickMetrics.maxDelay < 2000, actual: `${tickMetrics.maxDelay}ms` }
    ];

    const failedAssertions = assertions.filter(a => !a.passed);
    const passed = failedAssertions.length === 0;

    console.log(`\n================== AC5 LOAD TEST RESULTS ==================`);
    console.log(` Concurrent Bots : ${botCount}`);
    console.log(` Duration        : ${durationSec}s (Elapsed: ${Math.round((Date.now() - startTime) / 1000)}s)`);
    console.log(` Tick Mean / Std : ${tickMetrics.meanInterval}ms ± ${tickMetrics.jitter}ms (Max: ${tickMetrics.maxDelay}ms)`);
    console.log(` Move RTT p50/p95: ${rttMetrics.p50}ms / ${rttMetrics.p95}ms (Max: ${rttMetrics.max}ms, Count: ${rttMetrics.count})`);
    console.log(` Peak Server RSS  : ${peakRss === 0 ? 'unavailable' : peakRss + 'MB'}`);
    console.log(` Status          : ${passed ? 'PASSED [✓]' : 'FAILED [✗]'}`);
    assertions.forEach(a => {
      console.log(`   ${a.passed ? '✓' : '✗'} ${a.name}: ${a.actual}`);
    });
    console.log(`===========================================================\n`);

    return {
      success: passed,
      durationMs: Date.now() - startTime,
      metrics: {
        botCount,
        tick: tickMetrics,
        rtt: rttMetrics,
        peakRssMb: peakRss,
        assertions
      },
      error: passed ? null : new Error(`AC5 Assertions failed: ${failedAssertions.map(f => f.name).join(', ')}`)
    };
  } catch (err) {
    console.error(`\n[!] Error during AC5 Load Test:`, err.message);
    // Attempt emergency disconnect
    await Promise.all(bots.map(b => b.disconnect().catch(() => {})));
    return {
      success: false,
      durationMs: Date.now() - startTime,
      metrics: null,
      error: err
    };
  }
}

// Standalone CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  args.forEach(arg => {
    if (arg.startsWith('--port=')) {
      const port = arg.split('=')[1];
      options.serverUrl = `ws://localhost:${port}`;
    } else if (arg.startsWith('--bots=')) {
      options.botCount = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--duration=')) {
      options.durationSec = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--verbose') {
      options.verbose = true;
    }
  });

  runLoadTest(options).then(result => {
    process.exit(result.success ? 0 : 1);
  }).catch(err => {
    console.error('Unhandled fatal error in load_test_50_bots:', err);
    process.exit(2);
  });
}

module.exports = { runLoadTest };
