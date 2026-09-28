/**
 * tests/browser/browser_runner.js
 * CLI Test Runner for Browser Acceptance Test Suite (AC1 - AC4)
 *
 * Coordinates execution of:
 * - AC1: Sub-class progression & transition (test_subclass.js)
 * - AC2: Boss combat & AoE ground indicator rendering (test_boss_aoe.js)
 * - AC3: NPC dialogue DAG & multi-step quest UI (test_npc_quest.js)
 * - AC4: 2-player secure trade interface flow (test_trade.js)
 */

const { runSubclassTest } = require('./test_subclass');
const { runBossAoETest } = require('./test_boss_aoe');
const { runNpcQuestTest } = require('./test_npc_quest');
const { runTradeTest } = require('./test_trade');

const SUITE_TESTS = {
  subclass: { name: 'AC1: Sub-Class Progression', fn: runSubclassTest },
  boss_aoe: { name: 'AC2: Boss AoE Ground Indicator', fn: runBossAoETest },
  npc_quest: { name: 'AC3: NPC Dialogue & Quest UI', fn: runNpcQuestTest },
  trade: { name: 'AC4: 2-Player Secure Trade Flow', fn: runTradeTest }
};

/**
 * Runs browser acceptance test suite.
 * @param {object} options
 * @param {string} options.test - 'all' or specific test key ('subclass', 'boss_aoe', 'npc_quest', 'trade')
 * @param {number} options.port - Port
 * @param {boolean} options.headless - Headless browser mode
 * @param {boolean} options.bail - Abort on first failure
 * @returns {Promise<{success: boolean, durationMs: number, passedCount: number, failedCount: number, details: Array}>}
 */
async function runBrowserSuite(options = {}) {
  const target = options.test || 'all';
  const port = options.port || 8080;
  const headless = options.headless !== undefined ? options.headless : true;
  const bail = options.bail || false;
  const startTime = Date.now();

  const testsToRun = [];
  if (target === 'all') {
    Object.keys(SUITE_TESTS).forEach(key => testsToRun.push({ key, ...SUITE_TESTS[key] }));
  } else if (SUITE_TESTS[target]) {
    testsToRun.push({ key: target, ...SUITE_TESTS[target] });
  } else {
    throw new Error(`Unknown browser test target '${target}'. Available: ${Object.keys(SUITE_TESTS).join(', ')}, all`);
  }

  console.log(`\n======================================================================`);
  console.log(`🌐 TIBIA MMORPG BROWSER ACCEPTANCE SUITE (Puppeteer-Core)`);
  console.log(`   Target: ${target} | Port: ${port} | Headless: ${headless} | Total: ${testsToRun.length}`);
  console.log(`======================================================================\n`);

  const results = [];
  let passedCount = 0;
  let failedCount = 0;

  for (const test of testsToRun) {
    console.log(`\n>>> Running [${test.key}]: ${test.name}...`);
    const testResult = await test.fn({ port, headless });
    results.push({ key: test.key, name: test.name, ...testResult });

    if (testResult.success) {
      passedCount++;
    } else {
      failedCount++;
      if (bail) {
        console.log(`[!] --bail flag active. Aborting browser suite on first failure.`);
        break;
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const allPassed = failedCount === 0;

  console.log(`\n======================================================================`);
  console.log(`🏁 BROWSER ACCEPTANCE SUITE SUMMARY`);
  console.log(`   Passed: ${passedCount} / ${testsToRun.length} | Failed: ${failedCount} | Duration: ${(durationMs / 1000).toFixed(2)}s`);
  console.log(`----------------------------------------------------------------------`);
  results.forEach(r => {
    console.log(`   ${r.success ? '✓ PASS' : '✗ FAIL'} [${r.key}] ${r.name} (${r.durationMs}ms)`);
    // A client-side throw is reported separately: the assertions can all pass
    // while a handler is broken, so make the cause obvious.
    if (Array.isArray(r.clientErrors) && r.clientErrors.length > 0) {
      console.log(`        ↳ ${r.clientErrors.length} uncaught client error(s):`);
      r.clientErrors.slice(0, 5).forEach(e => console.log(`          ${e}`));
    }
  });
  console.log(`======================================================================\n`);

  return {
    success: allPassed,
    durationMs,
    passedCount,
    failedCount,
    details: results
  };
}

// Standalone CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};

  args.forEach(arg => {
    if (arg.startsWith('--test=')) options.test = arg.split('=')[1];
    else if (arg.startsWith('--port=')) options.port = parseInt(arg.split('=')[1], 10);
    else if (arg === '--headless=false') options.headless = false;
    else if (arg === '--bail') options.bail = true;
  });

  runBrowserSuite(options).then(summary => {
    process.exit(summary.success ? 0 : 1);
  }).catch(err => {
    console.error('Fatal harness error in browser_runner:', err);
    process.exit(2);
  });
}

module.exports = { runBrowserSuite, SUITE_TESTS };
