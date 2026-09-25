/**
 * tests/bots/persistence_test.js
 * AC7 Verification Harness: Server Data Persistence & Clean Restart
 *
 * Verifies:
 * 1. Target character state mutation under concurrent background load.
 * 2. Pre-shutdown state snapshot capture (level, xp, gold, inventory, class).
 * 3. Graceful server shutdown (SIGINT/SIGTERM/IPC).
 * 4. Cold server restart on the same port.
 * 5. Reconnection and opaque-box state restoration validation.
 */

const fs = require('fs');
const path = require('path');
const BotClient = require('./bot_client');
const ServerController = require('../lib/server_controller');

/**
 * Runs the persistence & restart test suite.
 * @param {object} options
 * @param {number} options.port - Server port (default 8085)
 * @param {boolean} options.manageServer - Whether harness manages server process (default true)
 * @returns {Promise<{success: boolean, durationMs: number, results: object, error: Error|null}>}
 */
async function runPersistenceTest(options = {}) {
  const port = options.port || 8085;
  const serverUrl = `ws://localhost:${port}`;
  const manageServer = options.manageServer !== undefined ? options.manageServer : true;
  const startTime = Date.now();

  console.log(`\n=============================================================`);
  console.log(`💾 [AC7] Starting Server Persistence & Cold Restart Test`);
  console.log(`   Port: ${port} | Managed Server: ${manageServer}`);
  console.log(`=============================================================\n`);

  const externalServer = options.serverController || null;
  const ownsServer = !externalServer;
  const leaveServerRunning = options.leaveServerRunning === true;
  const server = externalServer || new ServerController({ port });
  const testSteps = [];
  function recordStep(name, passed, details = '') {
    testSteps.push({ name, passed, details });
    console.log(`   ${passed ? '✓' : '✗'} ${name} ${details ? '(' + details + ')' : ''}`);
  }

  const runId = Math.random().toString(36).substring(2, 7);
  const heroName = `PersistHero_${runId}`;
  const bgBots = [];
  let heroBot = null;

  try {
    // A persistence test without a managed restart would only reconnect to
    // the same process and could pass without proving durability.
    if (!manageServer && options.allowNoRestart !== true) {
      recordStep('Dedicated Restart Server', false, 'manageServer=false is not valid for AC7');
      throw new Error('AC7 requires a runner-owned server so it can perform a real cold restart.');
    }

    // 1. Launch initial server if managed
    if (manageServer) {
      console.log(`[*] Launching initial test server on port ${port}...`);
      if (!server.isRunning) await server.start();
      recordStep('Initial Server Start', true, `Listening on port ${port}`);
    }

    // 2. Connect background load bots (3 bots moving actively)
    console.log(`[*] Spawning background bots for concurrent load...`);
    for (let i = 1; i <= 3; i++) {
      const bgBot = new BotClient({
        serverUrl,
        name: `PersistBg_${runId}_${i}`,
        classType: 'warrior'
      });
      await bgBot.connect(serverUrl, 5000);
      await bgBot.login();
      bgBot.startRandomWalk(350);
      bgBots.push(bgBot);
    }
    recordStep('Background Bots Active', true, `${bgBots.length} bots wandering`);

    // 3. Connect Target Test Hero
    console.log(`[*] Connecting target character: ${heroName}...`);
    heroBot = new BotClient({
      serverUrl,
      name: heroName,
      classType: 'warrior',
      logMessages: true
    });
    await heroBot.connect(serverUrl, 5000);
    await heroBot.login(heroName, 'warrior');

    // Wait for initial status packet
    const initialStatus = await heroBot.waitForStatus(() => true, 4000);
    recordStep('Target Hero Logged In', true, `Initial Level: ${initialStatus.level}, Gold: ${initialStatus.gold}`);

    // 4. State Mutation Phase: Dynamically locate and loot nearest chest or gathering node
    console.log(`[*] Mutating character state away from initial defaults...`);

    // Give server a moment to deliver sync packets (chests, nodes, mobs)
    await new Promise(r => setTimeout(r, 400));

    const targets = [];
    heroBot.chests.forEach(c => targets.push({ type: 'chest', id: c.id, x: c.x, y: c.y }));
    heroBot.gatheringNodes.forEach(n => targets.push({ type: 'node', id: n.id, name: n.name, x: n.x, y: n.y }));
    heroBot.mobs.forEach(m => { if (m.alive && m.hp > 0) targets.push({ type: 'mob', id: m.id, x: m.x, y: m.y }); });

    targets.sort((a, b) => heroBot.distanceTo(a.x, a.y) - heroBot.distanceTo(b.x, b.y));

    console.log(`   Discovered ${targets.length} targets. Closest: ${targets[0] ? `${targets[0].type} at (${targets[0].x}, ${targets[0].y}), dist=${heroBot.distanceTo(targets[0].x, targets[0].y)}px` : 'none'}`);

    const mutationTimeoutMs = 10000;
    const mutationStart = Date.now();
    let currentTargetIdx = 0;

    while (Date.now() - mutationStart < mutationTimeoutMs) {
      if (heroBot.gold > 0 || heroBot.xp > 0 || (heroBot.inventory && heroBot.inventory.length > 0)) {
        break;
      }

      const target = targets[currentTargetIdx];
      if (!target) {
        heroBot.stepRandomWalkable();
        heroBot.attackNearestMob();
        await new Promise(r => setTimeout(r, 320));
        continue;
      }

      const dist = heroBot.distanceTo(target.x, target.y);
      if (dist === 0) {
        // Reached target tile; allow server 350ms to process loot and emit status
        await new Promise(r => setTimeout(r, 350));
        if (heroBot.gold === 0 && (!heroBot.inventory || heroBot.inventory.length === 0)) {
          // Target was inactive or already looted; switch to next target
          currentTargetIdx++;
        }
      } else {
        heroBot.stepToward(target.x, target.y);
        if (target.type === 'mob' && dist <= 48) {
          heroBot.attack(target.id);
          heroBot.castSkill();
        }
        await new Promise(r => setTimeout(r, 320));
      }
    }

    // Capture post-mutation status
    const currentStatus = await heroBot.waitForStatus(
      p => (p.gold > 0 || p.xp > 0 || (p.inventory && p.inventory.length > 0)),
      2000
    ).catch(() => ({
      level: heroBot.level,
      xp: heroBot.xp,
      gold: heroBot.gold,
      inventory: [...heroBot.inventory],
      classType: heroBot.classType
    }));

    const preShutdownSnapshot = {
      charName: heroName,
      level: currentStatus.level || heroBot.level,
      xp: currentStatus.xp || heroBot.xp,
      gold: currentStatus.gold !== undefined ? currentStatus.gold : heroBot.gold,
      inventory: [...(currentStatus.inventory || heroBot.inventory)],
      classType: currentStatus.classType || heroBot.classType
    };

    // Assert that character state is genuinely non-default BEFORE server shutdown
    const stateIsNonDefault = (preShutdownSnapshot.gold > 0) ||
                             (preShutdownSnapshot.xp > 0) ||
                             (preShutdownSnapshot.inventory.length > 0);

    recordStep('Character Mutated Away From Default', stateIsNonDefault,
      `Gold: ${preShutdownSnapshot.gold}G, XP: ${preShutdownSnapshot.xp}, Inventory: [${preShutdownSnapshot.inventory.join(', ')}]`);

    if (!stateIsNonDefault) {
      throw new Error(`Failed to mutate character away from initial defaults (Gold: ${preShutdownSnapshot.gold}, XP: ${preShutdownSnapshot.xp}, Inv: ${preShutdownSnapshot.inventory.length}). Aborting persistence test to prevent tautology.`);
    }

    // 5. Clean disconnect before server shutdown to trigger socket close flush handler
    console.log(`[*] Disconnecting clients...`);
    await heroBot.disconnect();
    await Promise.all(bgBots.map(b => b.disconnect()));
    await new Promise(r => setTimeout(r, 500)); // Allow server I/O flush
    recordStep('Clients Disconnected Cleanly', true);

    // 6. Graceful Server Shutdown
    if (manageServer) {
      console.log(`[*] Sending clean shutdown to server...`);
      const exitResult = await server.stop(false, 3000);
      const shutdownOutput = `${server.getStdout()}\n${server.getStderr()}`;
      const cleanShutdown = exitResult.code === 0 ||
        (exitResult.signal === 'SIGINT' && shutdownOutput.includes('State flush complete')); 
      recordStep('Server Shutdown Cleanly', cleanShutdown, `Exit signal/code: ${exitResult.code || exitResult.signal || 0}`);
      if (!cleanShutdown) throw new Error(`Server exited unsuccessfully during shutdown: ${JSON.stringify(exitResult)}`);

      // 7. Cold Server Restart
      console.log(`[*] Performing cold server restart on port ${port}...`);
      await new Promise(r => setTimeout(r, 600));
      await server.start();
      recordStep('Server Cold Restarted', true, `Server restarted on port ${port}`);
    } else {
      console.log(`[!] Note: Server management disabled; skipping process restart step.`);
    }

    // 8. Reconnection & State Verification
    console.log(`[*] Reconnecting ${heroName} to verify restored state...`);
    const reconnectHero = new BotClient({
      serverUrl,
      name: heroName,
      classType: 'warrior',
      logMessages: true
    });
    await reconnectHero.connect(serverUrl, 6000);
    await reconnectHero.login(heroName, 'warrior');

    const restoredStatus = await reconnectHero.waitForStatus(() => true, 5000);
    console.log(`[*] Restored Status: Level: ${restoredStatus.level}, Gold: ${restoredStatus.gold}, Class: ${restoredStatus.classType}`);

    // Execute state assertions
    const levelMatches = restoredStatus.level === preShutdownSnapshot.level;
    const classMatches = restoredStatus.classType === preShutdownSnapshot.classType;
    const goldMatches = restoredStatus.gold === preShutdownSnapshot.gold && (restoredStatus.gold > 0 || preShutdownSnapshot.gold === 0);
    const xpMatches = restoredStatus.xp === preShutdownSnapshot.xp;
    const inventoryMatches = preShutdownSnapshot.inventory.every(item => restoredStatus.inventory && restoredStatus.inventory.includes(item));

    const stateRestoredNonDefault = (restoredStatus.gold > 0) || (restoredStatus.xp > 0) || (restoredStatus.inventory && restoredStatus.inventory.length > 0);

    recordStep('Level Preserved Across Restart', levelMatches, `Expected: ${preShutdownSnapshot.level}, Got: ${restoredStatus.level}`);
    recordStep('Class Preserved Across Restart', classMatches, `Expected: ${preShutdownSnapshot.classType}, Got: ${restoredStatus.classType}`);
    recordStep('Gold Preserved Across Restart', goldMatches, `Expected: ${preShutdownSnapshot.gold}G, Got: ${restoredStatus.gold}G`);
    recordStep('XP Preserved Across Restart', xpMatches, `Expected: ${preShutdownSnapshot.xp}, Got: ${restoredStatus.xp}`);
    recordStep('Inventory Preserved Across Restart', inventoryMatches, `Expected: [${preShutdownSnapshot.inventory.join(', ')}], Got: [${(restoredStatus.inventory || []).join(', ')}]`);
    recordStep('Restored State is Genuine Non-Default', stateRestoredNonDefault, `Restored values verified against fresh defaults`);

    // Disconnect reconnected hero
    await reconnectHero.disconnect();

    // 9. Teardown
    if (manageServer && ownsServer && !leaveServerRunning) {
      await server.stop(false, 2000);
    }

    const allPassed = testSteps.every(s => s.passed);

    console.log(`\n================== AC7 PERSISTENCE RESULTS ==================`);
    console.log(` Status: ${allPassed ? 'PASSED [✓]' : 'FAILED [✗]'}`);
    console.log(` Duration: ${Date.now() - startTime}ms`);
    console.log(`=============================================================\n`);

    return {
      success: allPassed,
      durationMs: Date.now() - startTime,
      results: testSteps,
      error: allPassed ? null : new Error('One or more AC7 persistence assertions failed')
    };
  } catch (err) {
    console.error(`\n[!] Error during AC7 Persistence Test:`, err);
    if (heroBot) await heroBot.disconnect().catch(() => {});
    await Promise.all(bgBots.map(b => b.disconnect().catch(() => {})));
    if (manageServer && ownsServer) await server.stop(true).catch(() => {});

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
    if (arg.startsWith('--port=')) {
      options.port = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--no-manage') {
      options.manageServer = false;
    }
  });

  runPersistenceTest(options).then(res => {
    process.exit(res.success ? 0 : 1);
  }).catch(err => {
    console.error('Fatal error in persistence_test:', err);
    process.exit(2);
  });
}

module.exports = { runPersistenceTest };
