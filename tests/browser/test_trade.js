/**
 * tests/browser/test_trade.js
 * AC4 Acceptance Test: 2-Player Secure Trade Interface Flow Verification
 *
 * Verifies via two simultaneous Puppeteer browser agent contexts:
 * 1. Dual-agent session setup (TraderAlice & TraderBob).
 * 2. Trade request and invitation acceptance.
 * 3. 2-column staging window display (#trade-modal).
 * 4. Mutual lock state machine.
 * 5. Mutual confirmation and atomic item/gold transfer.
 */

const { BrowserDriver, finalizeResult } = require('./browser_driver');

/**
 * Runs the secure trade acceptance test.
 * @param {object} options
 * @param {number} options.port - Server port (default 8080)
 * @param {boolean} options.headless - Headless mode (default true)
 * @returns {Promise<{success: boolean, durationMs: number, results: object, error: Error|null}>}
 */
async function runTradeTest(options = {}) {
  const port = options.port || 8080;
  const headless = options.headless !== undefined ? options.headless : true;
  const startTime = Date.now();

  console.log(`\n=============================================================`);
  console.log(`🤝 [AC4] Starting 2-Player Secure Trade Flow Browser Test`);
  console.log(`   Port: ${port} | Headless: ${headless}`);
  console.log(`=============================================================\n`);

  const driver = new BrowserDriver({ port, headless });
  const runId = Math.random().toString(36).substring(2, 6);
  const aliceName = `TraderAlice_${runId}`;
  const bobName = `TraderBob_${runId}`;
  const testSteps = [];

  function recordStep(name, passed, details = '') {
    testSteps.push({ name, passed, details });
    console.log(`   ${passed ? '✓' : '✗'} ${name} ${details ? '(' + details + ')' : ''}`);
  }

  try {
    await driver.init();
    recordStep('Browser Initialized', true);

    // 1. Create two distinct browser contexts and pages
    console.log(`[*] Opening two independent browser agent contexts...`);
    const agentA = await driver.createAgentPage({ charName: aliceName, classType: 'warrior', autoLogin: true });
    const agentB = await driver.createAgentPage({ charName: bobName, classType: 'ranger', autoLogin: true });
    recordStep('Two Browser Agents Spawned', true, `${aliceName} & ${bobName}`);

    await new Promise(r => setTimeout(r, 500));

    // Give each test character deterministic, server-validated trade goods.
    await Promise.all([
      agentA.page.evaluate(() => {
        if (window.__GAME_SOCKET__ && window.__GAME_SOCKET__.readyState === 1) {
          window.__GAME_SOCKET__.send(JSON.stringify({ action: 'test_grant_item', item: 'Health Potion' }));
          window.__GAME_SOCKET__.send(JSON.stringify({ action: 'test_grant_gold', amount: 50 }));
        }
      }),
      agentB.page.evaluate(() => {
        if (window.__GAME_SOCKET__ && window.__GAME_SOCKET__.readyState === 1) {
          window.__GAME_SOCKET__.send(JSON.stringify({ action: 'test_grant_item', item: 'Iron Sword' }));
        }
      })
    ]);
    await Promise.all([
      agentA.page.waitForFunction(() => window.__MMO_TEST_TELEMETRY__.socketPacketsIn.some(p => p.data && p.data.action === 'status' && p.data.gold === 50 && p.data.inventory && p.data.inventory.includes('Health Potion')), { timeout: 3000 }),
      agentB.page.waitForFunction(() => window.__MMO_TEST_TELEMETRY__.socketPacketsIn.some(p => p.data && p.data.action === 'status' && p.data.inventory && p.data.inventory.includes('Iron Sword')), { timeout: 3000 })
    ]);

    // 2. Alice requests trade with Bob
    console.log(`[*] Alice sending trade request to Bob...`);
    await agentA.page.evaluate((target) => {
      if (window.__GAME_SOCKET__ && window.__GAME_SOCKET__.readyState === 1) {
        window.__GAME_SOCKET__.send(JSON.stringify({ action: 'trade_request', targetPlayer: target }));
      }
    }, bobName);

    // Verify Bob receives trade_requested packet from server
    const inviteReceived = await agentB.page.waitForFunction(() => {
      if (!window.__MMO_TEST_TELEMETRY__) return false;
      return window.__MMO_TEST_TELEMETRY__.socketPacketsIn.some(p => p.data && (p.data.action === 'trade_requested' || p.data.action === 'trade_request'));
    }, { timeout: 2000 }).then(() => true).catch(() => false);

    recordStep('Trade Invitation Received', inviteReceived,
      inviteReceived ? 'Bob received trade request' : 'Timeout waiting for trade_requested packet (M5 Trade System pending)');

    // Bob accepts the request through the actual browser control.
    const acceptControl = await agentB.page.waitForSelector('#trade-request-actions button', { visible: true, timeout: 2000 }).catch(() => null);
    if (acceptControl) await acceptControl.click();
    recordStep('Trade Request Accepted via UI', !!acceptControl,
      acceptControl ? 'Bob clicked Accept' : 'Accept control was not available');

    // Verify the accepted trade, rather than merely the invitation dialog, is
    // open on both agents before staging items.
    const tradeModalOpen = await Promise.all([
      agentA.page.waitForFunction(() => window.__MMO_TEST_TELEMETRY__ && window.__MMO_TEST_TELEMETRY__.socketPacketsIn.some(p => p.data && p.data.action === 'trade_open'), { timeout: 2000 }).then(() => true).catch(() => false),
      agentB.page.waitForFunction(() => window.__MMO_TEST_TELEMETRY__ && window.__MMO_TEST_TELEMETRY__.socketPacketsIn.some(p => p.data && p.data.action === 'trade_open'), { timeout: 2000 }).then(() => true).catch(() => false)
    ]).then(([a, b]) => a && b).catch(() => false);

    recordStep('Trade Window Open on Both Agents', tradeModalOpen,
      tradeModalOpen ? 'Trade modals visible on both agents' : 'Trade modals not opened (M5 UI pending)');

    // 3. Staging phase through the inventory and gold controls.
    console.log(`[*] Staging trade offers through the UI...`);
    await agentA.page.evaluate((item) => {
      const node = Array.from(document.querySelectorAll('#inventory-list .inv-item'))
        .find(element => element.textContent.includes(item));
      if (!node) throw new Error(`Inventory item not found: ${item}`);
      node.click();
      const gold = document.getElementById('trade-my-gold');
      gold.value = '50';
      gold.dispatchEvent(new Event('change', { bubbles: true }));
    }, 'Health Potion');

    await agentB.page.evaluate((item) => {
      const node = Array.from(document.querySelectorAll('#inventory-list .inv-item'))
        .find(element => element.textContent.includes(item));
      if (!node) throw new Error(`Inventory item not found: ${item}`);
      node.click();
    }, 'Iron Sword');

    const offersStaged = await agentA.page.waitForFunction(() => {
      if (!window.__MMO_TEST_TELEMETRY__) return false;
      return window.__MMO_TEST_TELEMETRY__.socketPacketsIn.some(p => p.data && p.data.action === 'trade_update');
    }, { timeout: 2000 }).then(() => true).catch(() => false);

    recordStep('Trade Offers Synchronized', offersStaged,
      offersStaged ? 'trade_update received from server' : 'trade_update not received (M5 Trade System pending)');

    // 4. Mutual Lock phase through the visible lock buttons.
    console.log(`[*] Executing mutual lock through the UI...`);
    await agentA.page.click('#trade-lock-btn');
    await agentB.page.click('#trade-lock-btn');

    const lockConfirmed = await Promise.all([
      agentA.page.waitForFunction(() => {
        if (!window.__MMO_TEST_TELEMETRY__) return false;
        return window.__MMO_TEST_TELEMETRY__.socketPacketsIn.some(p => p.data && p.data.action === 'trade_locked');
      }, { timeout: 2000 }).then(() => true).catch(() => false),
      agentB.page.waitForFunction(() => {
        if (!window.__MMO_TEST_TELEMETRY__) return false;
        return window.__MMO_TEST_TELEMETRY__.socketPacketsIn.some(p => p.data && p.data.action === 'trade_locked');
      }, { timeout: 2000 }).then(() => true).catch(() => false)
    ]).then(([a, b]) => a && b).catch(() => false);

    recordStep('Mutual Lock Synchronized', lockConfirmed,
      lockConfirmed ? 'trade_locked received from server' : 'trade_locked not received (M5 Trade System pending)');

    // 5. Mutual Confirm & Atomic Swap through the visible confirm buttons.
    console.log(`[*] Executing mutual confirm through the UI...`);
    if (lockConfirmed) {
      await agentA.page.click('#trade-confirm-btn');
      await agentB.page.click('#trade-confirm-btn');
    }

    const tradeComplete = await agentA.page.waitForFunction(() => {
      if (!window.__MMO_TEST_TELEMETRY__) return false;
      return window.__MMO_TEST_TELEMETRY__.socketPacketsIn.some(p => p.data && p.data.action === 'trade_complete');
    }, { timeout: 2000 }).then(() => true).catch(() => false);

    recordStep('Trade Atomic Swap Completed', tradeComplete,
      tradeComplete ? 'trade_complete received from server' : 'trade_complete not received (M5 Trade System pending)');

    const finalState = await Promise.all([
      agentA.page.waitForFunction(() => window.__MMO_TEST_TELEMETRY__.socketPacketsIn.some(p => p.data && p.data.action === 'status' && p.data.gold === 0 && p.data.inventory && p.data.inventory.includes('Iron Sword')), { timeout: 3000 }).then(() => true).catch(() => false),
      agentB.page.waitForFunction(() => window.__MMO_TEST_TELEMETRY__.socketPacketsIn.some(p => p.data && p.data.action === 'status' && p.data.gold === 50 && p.data.inventory && p.data.inventory.includes('Health Potion')), { timeout: 3000 }).then(() => true).catch(() => false)
    ]).then(([a, b]) => a && b).catch(() => false);
    recordStep('Final Inventories And Gold Verified', finalState,
      finalState ? 'Alice: 0G + Iron Sword; Bob: 50G + Health Potion' : 'Final state did not match the atomic swap');

    // Verify both agent sessions are still healthy and active
    const aliceHpText = await agentA.page.$eval('#hp-text', el => el.innerText).catch(() => '');
    const bobHpText = await agentB.page.$eval('#hp-text', el => el.innerText).catch(() => '');
    recordStep('Session State Verified Post-Trade', aliceHpText.length > 0 && bobHpText.length > 0, `Alice: ${aliceHpText} | Bob: ${bobHpText}`);

    await driver.close();

    const allPassed = testSteps.every(s => s.passed);

    console.log(`\n================== AC4 TRADE FLOW RESULTS ===================`);
    console.log(` Status: ${allPassed ? 'PASSED [✓]' : 'FAILED [✗]'}`);
    console.log(` Duration: ${Date.now() - startTime}ms`);
    console.log(`=============================================================\n`);

    return finalizeResult(driver, {
      success: allPassed,
      durationMs: Date.now() - startTime,
      results: testSteps,
      error: allPassed ? null : new Error('AC4 Trade flow assertions failed')
    });
  } catch (err) {
    console.error(`\n[!] Error during AC4 Trade Flow Test:`, err);
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

  runTradeTest(options).then(res => {
    process.exit(res.success ? 0 : 1);
  }).catch(err => {
    console.error('Fatal error in test_trade:', err);
    process.exit(2);
  });
}

module.exports = { runTradeTest };
