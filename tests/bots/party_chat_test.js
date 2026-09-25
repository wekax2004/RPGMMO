/**
 * tests/bots/party_chat_test.js
 * AC6 Verification Harness: 2 Headless Bots Party Formation & Global Chat Broadcast
 *
 * Verifies:
 * 1. Global / World chat broadcast between two bots (Alice -> Bob & Eve).
 * 2. Party invitation and acceptance flow (Alice invites Bob -> Bob accepts).
 * 3. Party state synchronization (party_sync packet containing members & leader).
 * 4. Party-isolated chat messaging.
 * 5. Party leave / disbandment.
 */

const BotClient = require('./bot_client');

/**
 * Runs the party and chat test suite.
 * @param {object} options
 * @param {string} options.serverUrl - WebSocket server URL
 * @param {boolean} options.verbose - Verbose logging
 * @returns {Promise<{success: boolean, durationMs: number, results: object, error: Error|null}>}
 */
async function runPartyChatTest(options = {}) {
  const serverUrl = options.serverUrl || 'ws://localhost:8080';
  const verbose = options.verbose || false;
  const startTime = Date.now();

  console.log(`\n=============================================================`);
  console.log(`💬 [AC6] Starting Party Formation & Global Chat Test`);
  console.log(`   Target: ${serverUrl}`);
  console.log(`=============================================================\n`);

  const runId = Math.random().toString(36).substring(2, 6);
  const aliceName = `Alice_${runId}`;
  const bobName = `Bob_${runId}`;
  const eveName = `Eve_${runId}`;

  const alice = new BotClient({ serverUrl, name: aliceName, classType: 'warrior', logMessages: true });
  const bob = new BotClient({ serverUrl, name: bobName, classType: 'ranger', logMessages: true });
  const eve = new BotClient({ serverUrl, name: eveName, classType: 'mage', logMessages: true });

  const testSteps = [];
  function recordStep(name, passed, details = '') {
    testSteps.push({ name, passed, details });
    console.log(`   ${passed ? '✓' : '✗'} ${name} ${details ? '(' + details + ')' : ''}`);
  }

  try {
    // 1. Connect & Login all three bots
    console.log(`[*] Connecting Alice, Bob, and Eve...`);
    await Promise.all([
      alice.connect(serverUrl, 6000).then(() => alice.login(aliceName, 'warrior', false, 6000)),
      bob.connect(serverUrl, 6000).then(() => bob.login(bobName, 'ranger', false, 6000)),
      eve.connect(serverUrl, 6000).then(() => eve.login(eveName, 'mage', false, 6000))
    ]);
    recordStep('Connect & Login 3 Bots', true, `${aliceName}, ${bobName}, ${eveName}`);

    // Small stabilization pause
    await new Promise(r => setTimeout(r, 400));

    // Create the party before inviting the second player.
    alice.send({ action: 'party_create' });
    await alice.waitForAction('party_sync', 3000);
    recordStep('Party Created', true, 'Alice created a party');

    // 2. Global / World Chat Broadcast Verification
    console.log(`[*] Testing World Chat Broadcast...`);
    const worldChatMsg = `Hello Tibia Realm from ${aliceName}! [${Date.now()}]`;

    // Set up listeners for Bob and Eve
    const bobReceivePromise = bob.waitForMessage(p => {
      if (p.action !== 'chat') return false;
      const sender = p.sender || p.name;
      return sender === aliceName && (p.text === worldChatMsg || p.text.includes(aliceName));
    }, 5000);

    const eveReceivePromise = eve.waitForMessage(p => {
      if (p.action !== 'chat') return false;
      const sender = p.sender || p.name;
      return sender === aliceName && (p.text === worldChatMsg || p.text.includes(aliceName));
    }, 5000);

    alice.sendChat(worldChatMsg, 'world');

    const [bobReceived, eveReceived] = await Promise.all([bobReceivePromise, eveReceivePromise]);
    const chatBroadcastPassed = !!(bobReceived && eveReceived);
    recordStep('Global Chat Broadcast', chatBroadcastPassed, `Delivered to Bob & Eve: "${bobReceived.text}"`);

    // Bob replies back to world chat
    const bobReplyMsg = `Greetings Alice! From ${bobName}`;
    const aliceReceiveBobPromise = alice.waitForMessage(p => {
      if (p.action !== 'chat') return false;
      const sender = p.sender || p.name;
      return sender === bobName && p.text === bobReplyMsg;
    }, 5000);
    bob.sendChat(bobReplyMsg, 'world');
    await aliceReceiveBobPromise;
    recordStep('World Chat Two-Way Exchange', true, 'Bob replied and Alice received');

    // 3. Party Invitation Flow
    console.log(`[*] Testing Party Invitation and Formation...`);
    let partySupported = true;

    // Listen for party invitation on Bob
    const bobInvitePromise = bob.waitForMessage(p => {
      return p.action === 'party_invited' || (p.action === 'party_invite' && (p.fromPlayer === aliceName || p.from === aliceName));
    }, 3000).catch(err => {
      if (verbose) console.log(`   [Info] Party invite packet not received within timeout: ${err.message}`);
      return null;
    });

    alice.inviteParty(bobName);
    const invitePacket = await bobInvitePromise;

    if (invitePacket) {
      recordStep('Party Invite Sent & Received', true, `Bob received invitation from ${aliceName}`);

      // Bob accepts party invitation
      const aliceSyncPromise = alice.waitForMessage(p => p.action === 'party_sync', 3000).catch(() => null);
      const bobSyncPromise = bob.waitForMessage(p => p.action === 'party_sync', 3000).catch(() => null);

      bob.acceptParty(aliceName);

      const [aliceSync, bobSync] = await Promise.all([aliceSyncPromise, bobSyncPromise]);
      if (aliceSync && bobSync) {
        const leaderMatches = aliceSync.leader === aliceName || aliceSync.leader === alice.id;
        recordStep('Party State Synchronized', leaderMatches, `Leader: ${aliceSync.leader}, Members: ${aliceSync.members ? aliceSync.members.length : 2}`);

        // 4. Party-Isolated Chat Verification
        console.log(`[*] Testing Party-Isolated Chat...`);
        const secretPartyMsg = `Secret party tactic #${runId}`;
        const bobPartyChatPromise = bob.waitForMessage(p => {
          return p.action === 'chat' && (p.channel === 'party' || p.text === secretPartyMsg);
        }, 3000).catch(() => null);

        alice.sendChat(secretPartyMsg, 'party');
        const bobPartyChat = await bobPartyChatPromise;
        const partyChatDelivered = !!bobPartyChat;
        recordStep('Party Channel Chat Delivery', partyChatDelivered, `Delivered to Bob: ${secretPartyMsg}`);

        // Verify Eve did NOT receive party chat
        const eveLeakedPartyChat = eve.chatHistory.some(c => c.text === secretPartyMsg && c.channel === 'party');
        recordStep('Party Chat Channel Isolation', !eveLeakedPartyChat, 'Eve did not receive private party chat');

        // 5. Party Leave Verification
        const leaveSyncPromise = bob.waitForMessage(p =>
          p.action === 'party_sync' && Array.isArray(p.members) && p.members.length === 0,
          3000
        ).catch(() => null);
        bob.leaveParty();
        const leaveSync = await leaveSyncPromise;
        recordStep('Party Leave Synchronized', !!leaveSync, leaveSync ? 'Bob received empty party state' : 'No party leave state received');
      } else {
        recordStep('Party State Synchronized', false, 'Timed out waiting for party_sync broadcast from server');
      }
    } else {
      recordStep('Party Invite Sent & Received', false, 'Timed out waiting for party_invited packet from server');
    }

    // 6. Cleanup
    await Promise.all([
      alice.disconnect(),
      bob.disconnect(),
      eve.disconnect()
    ]);

    const allPassed = testSteps.every(s => s.passed);

    console.log(`\n================== AC6 PARTY & CHAT RESULTS ==================`);
    console.log(` Status: ${allPassed ? 'PASSED [✓]' : 'FAILED [✗]'}`);
    console.log(` Duration: ${Date.now() - startTime}ms`);
    console.log(`==============================================================\n`);

    return {
      success: allPassed,
      durationMs: Date.now() - startTime,
      results: testSteps,
      error: allPassed ? null : new Error('One or more AC6 steps failed')
    };
  } catch (err) {
    console.error(`\n[!] Error during AC6 Party/Chat Test:`, err);
    await Promise.all([
      alice.disconnect().catch(() => {}),
      bob.disconnect().catch(() => {}),
      eve.disconnect().catch(() => {})
    ]);
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
      const port = arg.split('=')[1];
      options.serverUrl = `ws://localhost:${port}`;
    } else if (arg === '--verbose') {
      options.verbose = true;
    }
  });

  runPartyChatTest(options).then(res => {
    process.exit(res.success ? 0 : 1);
  }).catch(err => {
    console.error('Fatal error in party_chat_test:', err);
    process.exit(2);
  });
}

module.exports = { runPartyChatTest };
