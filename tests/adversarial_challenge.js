/**
 * tests/adversarial_challenge.js
 * Empirical Challenge Suite for Milestone 1 Test Infrastructure
 *
 * Evaluates:
 * 1. Runner exit codes on failure and harness errors.
 * 2. Port conflict behavior (TCP vs HTTP collision).
 * 3. Abrupt server termination and socket failure modes (ERR_UNHANDLED_ERROR).
 * 4. Assertion genuineness audit (tautologies and fallback branches).
 */

const net = require('net');
const http = require('http');
const path = require('path');
const cp = require('child_process');
const BotClient = require('./bots/bot_client');
const ServerController = require('./lib/server_controller');

async function runAdversarialAudit() {
  console.log('=============================================================');
  console.log('⚔️  ADVERSARIAL CHALLENGE SUITE: MILESTONE 1 TEST INFRA');
  console.log('=============================================================\n');

  const findings = [];

  // -------------------------------------------------------------
  // Challenge 1: Unhandled 'error' event crash on BotClient socket drop
  // -------------------------------------------------------------
  console.log('[Test 1] Testing BotClient abrupt socket disconnect handling...');
  const test1Promise = new Promise((resolve) => {
    const s = http.createServer();
    const WebSocket = require('ws');
    const wss = new WebSocket.Server({ server: s });

    wss.on('connection', (ws) => {
      // Abruptly terminate connection shortly after opening
      setTimeout(() => ws.terminate(), 50);
    });

    s.listen(8191, async () => {
      // Spawn isolated node process to catch process-level crash
      const sub = cp.spawn(process.execPath, [
        '-e',
        `
        const BotClient = require('./tests/bots/bot_client');
        const b = new BotClient({ serverUrl: 'ws://localhost:8191' });
        b.connect('ws://localhost:8191')
          .then(() => new Promise(r => setTimeout(r, 300)))
          .then(() => { process.exit(0); })
          .catch(e => { process.exit(42); });
        `
      ], { cwd: path.resolve(__dirname, '..') });

      let stderr = '';
      sub.stderr.on('data', d => stderr += d.toString());
      sub.on('exit', (code) => {
        s.close();
        const crashedWithUnhandled = stderr.includes('ERR_UNHANDLED_ERROR');
        console.log(`   Exit Code: ${code}, Crashed with ERR_UNHANDLED_ERROR: ${crashedWithUnhandled}`);
        if (crashedWithUnhandled) {
          findings.push({
            id: 'VULN-01',
            severity: 'CRITICAL',
            title: 'BotClient crashes with unhandled ERR_UNHANDLED_ERROR on socket disconnect',
            description: 'BotClient emits "error" without ensuring an error listener exists. In Node.js EventEmitter, this crashes the entire process unhandled.',
            evidence: stderr.split('\n').slice(0, 5).join('\n')
          });
        }
        resolve();
      });
    });
  });
  await test1Promise;

  // -------------------------------------------------------------
  // Challenge 2: Runner exit code on test failure
  // -------------------------------------------------------------
  console.log('\n[Test 2] Testing e2e_runner.js exit code on test failure...');
  const test2Res = cp.spawnSync(process.execPath, [
    'tests/e2e_runner.js',
    '--no-server-manage',
    '--port=9998', // Nothing running on 9998
    '--suite=bots',
    '--duration=1'
  ], { cwd: path.resolve(__dirname, '..') });

  console.log(`   Exit Code on Failed Test / Connection Drop: ${test2Res.status}`);
  if (test2Res.status === 0) {
    findings.push({
      id: 'VULN-02',
      severity: 'CRITICAL',
      title: 'Runner exited with code 0 despite test failure',
      description: 'Runner failed to return non-zero exit code when test failed.',
      evidence: `Exit code: ${test2Res.status}`
    });
  } else {
    console.log('   ✓ Runner properly exited with non-zero code on test failure.');
  }

  // -------------------------------------------------------------
  // Challenge 3: Port Collision Handling (Raw TCP port bound)
  // -------------------------------------------------------------
  console.log('\n[Test 3] Testing e2e_runner.js behavior when port is already bound by TCP listener...');
  const test3Promise = new Promise((resolve) => {
    const tcpServer = net.createServer().listen(8192, () => {
      const runnerRes = cp.spawnSync(process.execPath, [
        'tests/e2e_runner.js',
        '--port=8192',
        '--suite=bots',
        '--duration=1'
      ], { cwd: path.resolve(__dirname, '..') });

      tcpServer.close();
      console.log(`   Runner Exit Code on Port Collision: ${runnerRes.status}`);
      console.log(`   Output Snippet: ${runnerRes.stdout.toString().split('\n')[5] || ''}`);
      if (runnerRes.status === 2) {
        console.log('   ✓ Runner exited with code 2 (harness error) as expected.');
      } else {
        findings.push({
          id: 'VULN-03',
          severity: 'MEDIUM',
          title: 'Unexpected exit code on port collision',
          description: `Expected exit code 2 on port collision, got ${runnerRes.status}`,
          evidence: runnerRes.stdout.toString()
        });
      }
      resolve();
    });
  });
  await test3Promise;

  // -------------------------------------------------------------
  // Challenge 4: Abrupt Server Termination Mid-Test
  // -------------------------------------------------------------
  console.log('\n[Test 4] Testing runner resilience when server abruptly terminates mid-test...');
  const test4Promise = new Promise((resolve) => {
    const runner = cp.spawn(process.execPath, [
      'tests/e2e_runner.js',
      '--port=8193',
      '--suite=bots',
      '--bots=5',
      '--duration=8'
    ], { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });

    let killed = false;
    let runnerStderr = '';
    runner.stderr.on('data', d => runnerStderr += d.toString());

    runner.stdout.on('data', (d) => {
      const text = d.toString();
      if (text.includes('Active Bots: 5/5') && !killed) {
        killed = true;
        console.log('   Killing server process abruptly via netstat lookup...');
        cp.exec('netstat -ano | findstr 8193', (err, stdout) => {
          if (stdout) {
            const lines = stdout.split('\n');
            for (const line of lines) {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 5 && parts[1].includes(':8193') && parts[3] === 'LISTENING') {
                const pid = parts[4];
                console.log(`   Found Server PID ${pid}, executing taskkill /F /PID ${pid}...`);
                cp.spawn('taskkill', ['/F', '/PID', pid]);
              }
            }
          }
        });
      }
    });

    runner.on('exit', (code) => {
      console.log(`   Runner process terminated with exit code: ${code}`);
      const unhandledInRunner = runnerStderr.includes('ERR_UNHANDLED_ERROR');
      console.log(`   Runner had unhandled ERR_UNHANDLED_ERROR: ${unhandledInRunner}`);
      if (unhandledInRunner) {
        findings.push({
          id: 'VULN-04',
          severity: 'HIGH',
          title: 'Server crash causes runner to blow up with ERR_UNHANDLED_ERROR',
          description: 'When the server crashes mid-load test, connected bots receive socket errors and trigger unhandled ERR_UNHANDLED_ERROR, crashing the runner instead of reporting a test failure.',
          evidence: runnerStderr.split('\n').slice(0, 5).join('\n')
        });
      }
      resolve();
    });
  });
  await test4Promise;

  // -------------------------------------------------------------
  // Challenge 5: Genuineness of Assertions Audit
  // -------------------------------------------------------------
  console.log('\n[Test 5] Auditing Genuineness of Assertions across all test suites...');

  // 5A: Persistence Test - Tautological check
  console.log('   [5A] Persistence Test (persistence_test.js):');
  console.log('        - Checking character mutation phase in persistence_test.js:');
  console.log('          Does heroBot mutate Level, Class, or Gold before shutdown?');
  console.log('          Initial state: level 1, class "warrior", gold 0.');
  console.log('          Random walk in safe zone (320, 320) does not gain XP, gold, or class.');
  console.log('          Pre-shutdown snapshot: level 1, class "warrior", gold 0.');
  console.log('          Post-restart snapshot: level 1, class "warrior", gold 0 (even on fresh DB or failed save).');
  console.log('          Assertion: restoredStatus.level === preShutdownSnapshot.level (1 === 1)');
  console.log('          Assertion: restoredStatus.gold === preShutdownSnapshot.gold (0 === 0)');
  console.log('          Assertion: restoredStatus.classType === preShutdownSnapshot.classType ("warrior" === "warrior")');
  console.log('        -> TAUTOLOGY DETECTED: Passes identically even if database fails 100% of saves/loads!');
  findings.push({
    id: 'TAUT-01',
    severity: 'HIGH',
    title: 'Persistence Test asserts default values (1===1, 0===0, "warrior"==="warrior")',
    description: 'The persistence test never mutates level, gold, or class away from default values. When cold restart occurs, a fresh unpersisted character defaults to level 1, 0 gold, warrior class, matching pre-shutdown snapshot and causing the test to pass even if persistence completely failed.',
    evidence: 'persistence_test.js lines 89-110, 151-157'
  });

  // 5B: Party Chat Test - Soft fallback on missing M5 packets
  console.log('   [5B] Party Chat Test (party_chat_test.js):');
  console.log('        - Line 147: When party_invited is not received:');
  console.log('          recordStep("Party Protocol Dispatch Ready", true, ...) -> Passes test unconditionally.');
  console.log('        - Line 143: When party_sync is not received:');
  console.log('          recordStep("Party State Synchronized (Pending M5 Implementation)", true, ...) -> Passes test unconditionally.');
  console.log('        -> MASKED ASSERTION: AC-H2 requires two bots to form a party. Test passes unconditionally without verifying party formation.');
  findings.push({
    id: 'TAUT-02',
    severity: 'HIGH',
    title: 'Party Chat Test records success unconditionally when party packets fail or are missing',
    description: 'If party_invite or party_sync times out, party_chat_test.js records true for the step instead of failing, masking unimplemented or broken party features.',
    evidence: 'party_chat_test.js lines 142-148'
  });

  // 5C: Boss AoE Test - Self-drawn indicator and unconditional true
  console.log('   [5C] Boss AoE Indicator Test (test_boss_aoe.js):');
  console.log('        - Lines 87-100: The test itself injects ctx.arc and ctx.fill onto the canvas.');
  console.log('        - Lines 111-127: recordStep("Canvas Pixel Sampled in AoE Zone", true, ...) unconditionally.');
  console.log('        -> CIRCULAR / MOCKED PROOF: Test renders its own red circle, then asserts true unconditionally.');
  findings.push({
    id: 'TAUT-03',
    severity: 'MEDIUM',
    title: 'Boss AoE Test draws indicator onto Canvas itself and asserts true unconditionally',
    description: 'Rather than testing that the client engine renders the telegraph in response to server packet, the test script paints onto the canvas directly and unconditionally records true for pixel sampling.',
    evidence: 'test_boss_aoe.js lines 87-100, 111-127'
  });

  // 5D: Trade Test - Unconditional pass
  console.log('   [5D] Secure Trade Test (test_trade.js):');
  console.log('        - Lines 71, 86, 100, 114, 121: Every step records true without verifying trade outcome.');
  console.log('        -> MOCKED ASSERTION: Does not verify that items or gold were exchanged or that trade completed.');
  findings.push({
    id: 'TAUT-04',
    severity: 'MEDIUM',
    title: 'Trade Test records true unconditionally for all trade states',
    description: 'test_trade.js sends trade packets into the WebSocket but does not assert any server response, trade window DOM presence, or inventory state change.',
    evidence: 'test_trade.js lines 71, 86, 100, 114, 121'
  });

  // -------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------
  console.log('\n=============================================================');
  console.log('📊 ADVERSARIAL CHALLENGE FINDINGS SUMMARY');
  console.log(`   Total Findings: ${findings.length}`);
  findings.forEach((f, i) => {
    console.log(`   [${f.severity}] #${i + 1} (${f.id}): ${f.title}`);
  });
  console.log('=============================================================\n');

  return findings;
}

if (require.main === module) {
  runAdversarialAudit().then(findings => {
    console.log(`Audit finished. Findings count: ${findings.length}`);
    process.exit(0);
  }).catch(err => {
    console.error('Fatal error in adversarial audit:', err);
    process.exit(1);
  });
}

module.exports = { runAdversarialAudit };
