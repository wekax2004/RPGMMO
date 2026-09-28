'use strict';

/**
 * Reports which server->client packets the browser client actually handles.
 *
 * The shared contract lists every action the server can send. A packet the
 * client never dispatches on is a feature that looks implemented and does
 * nothing at all -- no error, no warning, just silence. That is invisible to
 * the acceptance suite, which asserts on the handful of packets it exercises.
 *
 * This is a diagnostic, not a hard failure: some packets (test-only actions,
 * transport-level packets) are legitimately unhandled. Run it after adding a
 * feature on the server to confirm the frontend is listening for it.
 *
 * Run:  node tools/client_packet_coverage.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENT_FILES = [
    'client/js/engine.js',
    'client/js/ui.js',
    'client/js/renderer.js',
    'client/test_client.html'
];

// Matches the dispatch shapes the client uses: data.action === 'x' and
// case 'x' in a switch.
const DISPATCH_PATTERNS = [
    /action\s*===\s*['"]([a-z0-9_]+)['"]/g,
    /case\s+['"]([a-z0-9_]+)['"]\s*:/g,
    /\.action\s*==\s*['"]([a-z0-9_]+)['"]/g
];

function clientHandledActions() {
    const found = new Map();   // action -> file that handles it
    for (const rel of CLIENT_FILES) {
        const full = path.join(ROOT, rel);
        if (!fs.existsSync(full)) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const pattern of DISPATCH_PATTERNS) {
            let m;
            while ((m = pattern.exec(src)) !== null) {
                if (!found.has(m[1])) found.set(m[1], rel);
            }
        }
    }
    return found;
}

// Actions that are expected to have no client handler.
const EXPECTED_UNHANDLED = new Set([
    // Test-only affordances, gated behind TIBIA_TEST_MODE.
    'login_error_probe',
    // The client sends it rather than receiving it; listed for completeness.
    'ping',
    'pong'
]);

function main() {
    const PACKET = require(path.join(ROOT, 'shared', 'packet_types.js'));
    const handled = clientHandledActions();
    const s2c = Object.values(PACKET.S2C);
    const c2s = Object.values(PACKET.C2S);

    const unhandledS2C = s2c.filter(a => !handled.has(a));
    const unexpected = unhandledS2C.filter(a => !EXPECTED_UNHANDLED.has(a));

    console.log('=== client packet coverage ===\n');
    console.log(`  contract          : ${c2s.length} inbound, ${s2c.length} outbound`);
    console.log(`  client dispatches : ${handled.size} distinct actions\n`);

    console.log(`  outbound with NO client handler (${unhandledS2C.length}):`);
    unhandledS2C.forEach(a => {
        const expected = EXPECTED_UNHANDLED.has(a);
        console.log(`    ${expected ? '(expected)' : 'SILENT  '}  ${a}`);
    });

    // Conversely: the client handling something the server never sends usually
    // means a renamed packet, which is exactly the drift the contract catches.
    const c2sSet = new Set(c2s);
    const s2cSet = new Set(s2c);
    const orphanHandlers = [...handled.keys()]
        .filter(a => !s2cSet.has(a) && !c2sSet.has(a))
        .sort();

    console.log(`\n  client handlers the server never emits (${orphanHandlers.length}):`);
    if (orphanHandlers.length === 0) console.log('    none');
    else orphanHandlers.forEach(a => console.log(`    ${a}`));

    if (unexpected.length > 0) {
        console.log(`\n  ${unexpected.length} outbound packet(s) would be silently dropped:`);
        unexpected.forEach(a => console.log(`    - ${a}`));
    }
    return unexpected.length;
}

if (require.main === module) {
    process.exitCode = main() > 0 ? 1 : 0;
}

module.exports = { clientHandledActions, EXPECTED_UNHANDLED };
