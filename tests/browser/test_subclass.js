/**
 * tests/browser/test_subclass.js
 * AC1 Acceptance Test: Character Level-Up & Sub-Class Transition
 *
 * Verifies via independent Puppeteer browser agent:
 * 1. Character creation and login as Warrior.
 * 2. Progression to Level 10 threshold.
 * 3. Sub-class selection interface interaction (selecting Juggernaut).
 * 4. UI title, skill button, and max HP updates reflecting promotion.
 */

const { BrowserDriver } = require('./browser_driver');

/**
 * Runs the Sub-class transition acceptance test.
 * @param {object} options
 * @param {number} options.port - Server port (default 8080)
 * @param {boolean} options.headless - Headless mode (default true)
 * @returns {Promise<{success: boolean, durationMs: number, results: object, error: Error|null}>}
 */
async function runSubclassTest(options = {}) {
  const port = options.port || 8080;
  const headless = options.headless !== undefined ? options.headless : true;
  const startTime = Date.now();

  console.log(`\n=============================================================`);
  console.log(`🛡️  [AC1] Starting Sub-Class Transition Browser Test`);
  console.log(`   Port: ${port} | Headless: ${headless}`);
  console.log(`=============================================================\n`);

  const driver = new BrowserDriver({ port, headless });
  const runId = Math.random().toString(36).substring(2, 6);
  const charName = `SubHero_${runId}`;
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
    recordStep('Character Logged In', true, `${charName} (Warrior)`);

    // 1. Verify initial title and Level 1 status
    const initialTitle = await page.$eval('#player-level-title', el => el.innerText);
    const hasInitialTitle = initialTitle.includes('Warrior') || initialTitle.includes('Level 1') || initialTitle.includes('Lvl 1');
    recordStep('Initial Level 1 Status Verified', hasInitialTitle, initialTitle);

    // 2. Trigger Level Progression (simulating XP gain to reach Level 10 threshold)
    console.log(`[*] Advancing character progression to Level 10...`);
    await page.evaluate(() => {
      if (window.__GAME_SOCKET__ && window.__GAME_SOCKET__.readyState === 1) {
        window.__GAME_SOCKET__.send(JSON.stringify({ action: 'test_grant_xp', amount: 10000 }));
      }
    });

    // Verify character reached Level 10 threshold
    const reachedLevel10 = await page.waitForFunction(() => {
      const title = document.querySelector('#player-level-title');
      if (!title) return false;
      const match = title.innerText.match(/Lvl\s+(\d+)/);
      return match && parseInt(match[1], 10) >= 10;
    }, { timeout: 3000 }).then(() => true).catch(() => false);

    recordStep('Level 10 Threshold Reached', reachedLevel10,
      reachedLevel10 ? 'Character reached Level 10' : 'Character remained below Level 10');

    // Request the server-authoritative subclass selection flow.
    if (reachedLevel10) {
      await page.evaluate(() => {
        if (window.__GAME_SOCKET__ && window.__GAME_SOCKET__.readyState === 1) {
          window.__GAME_SOCKET__.send(JSON.stringify({ action: 'evolve' }));
        }
      });
    }

    // Check if subclass modal appeared in UI (M3 feature)
    const subclassModalOpen = await page.waitForSelector('#subclass-modal', { visible: true, timeout: 2000 })
      .then(() => true)
      .catch(() => false);

    recordStep('Sub-Class Selection Modal Displayed', subclassModalOpen,
      subclassModalOpen ? '#subclass-modal visible' : '#subclass-modal not displayed (M3 Subclass UI pending)');

    let promotedToJuggernaut = false;

    if (subclassModalOpen) {
      // Click Juggernaut card if modal is open
      const juggClicked = await page.evaluate(() => {
        const juggCard = document.querySelector('#subclass-card-juggernaut, .subclass-card');
        if (juggCard) {
          juggCard.click();
          return true;
        }
        return false;
      });
      recordStep('Sub-Class Choice Selected', juggClicked, 'Clicked Juggernaut');

      await new Promise(r => setTimeout(r, 400));
      const titleAfter = await page.$eval('#player-level-title', el => el.innerText).catch(() => '');
      promotedToJuggernaut = titleAfter.toLowerCase().includes('juggernaut');
      recordStep('Sub-Class Promotion Verified', promotedToJuggernaut,
        promotedToJuggernaut ? `Promoted to Juggernaut: "${titleAfter}"` : `Promotion failed, title: "${titleAfter}"`);
    } else {
      recordStep('Sub-Class Choice Selected', false, 'Sub-class modal not available');
      recordStep('Sub-Class Promotion Verified', false, `Player title remained "${initialTitle}" (M3 Subclass feature pending)`);
    }

    // 3. Inspect UI vitals
    const hpText = await page.$eval('#hp-text', el => el.innerText).catch(() => '');
    const maxHp = parseInt((hpText.split('/')[1] || '0').replace(/\D/g, ''), 10);
    const scaledVitals = maxHp >= 250;
    recordStep('Juggernaut Scaled Vitals Verified', scaledVitals && promotedToJuggernaut,
      scaledVitals && promotedToJuggernaut ? `Max HP scaled to ${maxHp}` : `Max HP: ${maxHp} (Expected >= 250 for Juggernaut)`);

    await driver.close();

    const allPassed = testSteps.every(s => s.passed);

    console.log(`\n================== AC1 SUB-CLASS RESULTS ====================`);
    console.log(` Status: ${allPassed ? 'PASSED [✓]' : 'FAILED [✗]'}`);
    console.log(` Duration: ${Date.now() - startTime}ms`);
    console.log(`=============================================================\n`);

    return {
      success: allPassed,
      durationMs: Date.now() - startTime,
      results: testSteps,
      error: allPassed ? null : new Error('AC1 Sub-class test assertions failed')
    };
  } catch (err) {
    console.error(`\n[!] Error during AC1 Sub-Class Test:`, err);
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

  runSubclassTest(options).then(res => {
    process.exit(res.success ? 0 : 1);
  }).catch(err => {
    console.error('Fatal error in test_subclass:', err);
    process.exit(2);
  });
}

module.exports = { runSubclassTest };
