/**
 * tests/browser/test_npc_quest.js
 * AC3 Acceptance Test: NPC Dialogue DAG & Multi-Step Quest UI Verification
 *
 * Verifies via independent Puppeteer browser agent:
 * 1. Approaching NPC and opening dialogue modal (#npc-dialog).
 * 2. Inspecting NPC name and dialogue choices.
 * 3. Accepting a multi-step quest.
 * 4. Verifying real-time updates in the Quest Journal HUD panel (#quest-list).
 */

const { BrowserDriver, finalizeResult } = require('./browser_driver');

/**
 * Runs the NPC dialogue & quest acceptance test.
 * @param {object} options
 * @param {number} options.port - Server port (default 8080)
 * @param {boolean} options.headless - Headless mode (default true)
 * @returns {Promise<{success: boolean, durationMs: number, results: object, error: Error|null}>}
 */
async function runNpcQuestTest(options = {}) {
  const port = options.port || 8080;
  const headless = options.headless !== undefined ? options.headless : true;
  const startTime = Date.now();

  console.log(`\n=============================================================`);
  console.log(`📜 [AC3] Starting NPC Dialogue & Quest Acceptance Browser Test`);
  console.log(`   Port: ${port} | Headless: ${headless}`);
  console.log(`=============================================================\n`);

  const driver = new BrowserDriver({ port, headless });
  const runId = Math.random().toString(36).substring(2, 6);
  const charName = `QuestHero_${runId}`;
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
      classType: 'warrior',
      autoLogin: true
    });
    recordStep('Character Logged In', true, charName);

    // 1. Approach NPC Mayor Joe (spawn point 320, 320) and trigger dialogue
    console.log(`[*] Initiating dialogue with NPC Mayor Joe...`);
    await page.evaluate(() => {
      if (window.__GAME_SOCKET__ && window.__GAME_SOCKET__.readyState === 1) {
        window.__GAME_SOCKET__.send(JSON.stringify({ action: 'talk_npc', npc_id: 'n_1' }));
      }
    });

    // Wait for dialogue modal to appear from server response
    const dialogVisible = await page.waitForSelector('#npc-dialog', { visible: true, timeout: 2000 })
      .then(() => true)
      .catch(() => false);

    recordStep('NPC Dialogue Modal Displayed', dialogVisible,
      dialogVisible ? '#npc-dialog visible' : 'Timed out waiting for #npc-dialog (M4 NPC Dialogue DAG pending)');

    if (dialogVisible) {
      // 2. Verify NPC Name in dialog
      const dialogNpcName = await page.$eval('#dialog-npc-name', el => el.innerText).catch(() => '');
      recordStep('NPC Name Verified', dialogNpcName.includes('Mayor Joe') || dialogNpcName.length > 0, dialogNpcName);

      // 3. Accept the Quest via real UI click
      console.log(`[*] Accepting multi-step quest from dialogue...`);
      const acceptBtn = await page.$('#dialog-content button, #npc-dialog button:not([onclick*="close"])');
      if (acceptBtn) {
        await acceptBtn.click();
        recordStep('Quest Accepted via UI', true, 'Clicked accept button');
      } else {
        recordStep('Quest Accepted via UI', false, 'Accept button not found in dialogue');
      }

      // 4. Verify Quest Journal HUD panel updates (#quest-list) from server quest_journal broadcast
      await new Promise(r => setTimeout(r, 600));
      const questListText = await page.$eval('#quest-list', el => el.innerText).catch(() => '');
      const hasQuestEntry = !questListText.includes('No active quests') &&
        (questListText.includes('Spider Slayer') || questListText.includes('quest_spider_slayer'));
      recordStep('Quest Journal HUD Updated', hasQuestEntry, questListText.replace(/\n/g, ' '));
    } else {
      recordStep('NPC Name Verified', false, 'Dialogue modal not open');
      recordStep('Quest Accepted via UI', false, 'Cannot accept quest without dialogue modal');
      recordStep('Quest Journal HUD Updated', false, 'Quest journal did not receive accepted quest');
    }

    await driver.close();

    const allPassed = testSteps.every(s => s.passed);

    console.log(`\n================== AC3 NPC QUEST RESULTS ====================`);
    console.log(` Status: ${allPassed ? 'PASSED [✓]' : 'FAILED [✗]'}`);
    console.log(` Duration: ${Date.now() - startTime}ms`);
    console.log(`=============================================================\n`);

    return finalizeResult(driver, {
      success: allPassed,
      durationMs: Date.now() - startTime,
      results: testSteps,
      error: allPassed ? null : new Error('AC3 NPC Quest test assertions failed')
    });
  } catch (err) {
    console.error(`\n[!] Error during AC3 NPC Quest Test:`, err);
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

  runNpcQuestTest(options).then(res => {
    process.exit(res.success ? 0 : 1);
  }).catch(err => {
    console.error('Fatal error in test_npc_quest:', err);
    process.exit(2);
  });
}

module.exports = { runNpcQuestTest };
