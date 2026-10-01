'use strict';

/**
 * Extracts the packet action surface from the server source.
 *
 * The hand-maintained shared/packet_types.js drifted badly enough to be
 * actively misleading: it listed actions the server never handled and omitted
 * every feature added since. Deriving the list from the source means the
 * contract cannot quietly go stale again.
 *
 * Two shapes are recognised:
 *   outbound  { action: 'foo' }                  -> server sends 'foo'
 *   inbound   data.action === 'foo'              -> server handles 'foo'
 *
 * A string that appears in both is bidirectional (a request/ack pair).
 */

// Recursively collect .js files under a directory.
function collectJsFiles(root, out = []) {
    const fs = require('fs');
    const path = require('path');
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) collectJsFiles(full, out);
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function extractFromSource(files) {
    const fs = require('fs');
    const toClient = new Set();   // action: 'x'  -> server -> client
    const fromClient = new Set(); // data.action === 'x' -> client -> server

    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');

        // Outbound, literal: { action: 'x' }
        let m;
        const outLiteral = /\baction:\s*'([a-z0-9_]+)'/g;
        while ((m = outLiteral.exec(src)) !== null) toClient.add(m[1]);

        // Outbound, ternary arms: action: cond ? 'a_warning' : 'b_impact'.
        // bosses.js sends aoe_warning and aoe_impact from a single call site.
        const outTernary = /\baction:\s*[^;{]*?\?\s*'([a-z0-9_]+)'\s*:\s*'([a-z0-9_]+)'/g;
        while ((m = outTernary.exec(src)) !== null) { toClient.add(m[1]); toClient.add(m[2]); }

        // Outbound, action passed as the FINAL argument of a send/sync helper:
        //   syncTrade(result.tradeId, 'trade_update')
        //   sendTradeSyncAll(TRADE.activeTrades.get(tradeId), 'trade_locked')
        // Requiring the literal to sit immediately before the closing paren is
        // what keeps this from matching every other string in the call, such as
        // a boss ability type in broadcastAoe(b, { type: 'poison' }) or a chat
        // channel in broadcast({ channel: 'guild' }).
        const outArg = /\b(?:send|sync)\w*\s*\([^;]*?,\s*'([a-z0-9_]+)'\s*\)/g;
        while ((m = outArg.exec(src)) !== null) toClient.add(m[1]);

        // Inbound: data.action === 'name'
        const inRe = /data\.action\s*===\s*'([a-z0-9_]+)'/g;
        while ((m = inRe.exec(src)) !== null) fromClient.add(m[1]);

        // Inbound, declared action set: TEST_ACTIONS = new Set([...]).
        //   server/testing.js dispatches with a switch, and the switch body's braces
        //   defeat any regex that tries to find where it ends -- a first attempt
        //   recovered one of the nine and looked like it had worked.
        //
        //   Read from the exported list instead, which is the authoritative
        //   declaration of what the module answers to. Matching only a
        //   name ending in ACTIONS keeps this from sweeping up unrelated Sets.
        const actionSet = /\b[A-Z_]*ACTIONS[A-Z_]*\s*=\s*new Set\(\[([\s\S]*?)\]\)/g;
        while ((m = actionSet.exec(src)) !== null) {
            const nameRe = /'([a-z0-9_]+)'/g;
            let n;
            while ((n = nameRe.exec(m[1])) !== null) fromClient.add(n[1]);
        }

        // Inbound, switch form: case 'name': inside `switch (data.action)`.
        //   Retained as a second source, since a module that dispatches by switch but
        //   does not declare its actions should still be visible to the contract.
        //   Scoped to a switch on data.action so an unrelated switch over a string
        //   enum elsewhere in the server is not mistaken for protocol.
        const switchRe = /switch\s*\(\s*data\.action\s*\)/g;
        while ((m = switchRe.exec(src)) !== null) {
            // From the switch to the end of the file is safe here: case labels after
            // it are still case labels of that switch until another switch appears,
            // and `data.action ===` elsewhere is caught by the pattern above.
            const rest = src.slice(m.index);
            const nextSwitch = rest.slice(1).search(/switch\s*\(/);
            const body = nextSwitch > -1 ? rest.slice(0, nextSwitch + 1) : rest;
            const caseRe = /\bcase\s+'([a-z0-9_]+)'\s*:/g;
            let c;
            while ((c = caseRe.exec(body)) !== null) fromClient.add(c[1]);
        }
    }
    toClient.delete('undefined');
    return { toClient, fromClient };
}

// Renders shared/packet_types.js from the extracted surface. The C2S keys are
// UPPER_SNAKE derived from the action name so the file reads like the old one
// did, but every value comes from the server source.
function upperSnake(action) {
    return action.toUpperCase();
}

function buildContractFile() {
    const path = require('path');
    const serverDir = path.join(__dirname, '..', 'server');
    const { toClient, fromClient } = extractFromSource(collectJsFiles(serverDir));

    const c2s = [...fromClient].sort();
    const s2c = [...toClient].sort();

    const c2sBody = c2s.map(a => `        ${upperSnake(a)}: '${a}'`).join(',\n');
    const s2cBody = s2c.map(a => `        ${upperSnake(a)}: '${a}'`).join(',\n');

    return `'use strict';

/**
 * GENERATED FILE -- DO NOT EDIT BY HAND.
 *
 * Regenerate with:  node tools/packet_contract.js --write
 *
 * The action names below are derived from the server source by scanning for
 * \`{ action: '...' }\` (outbound) and \`data.action === '...'\` (inbound).
 * tests/unit/packet_contract.test.js fails if this file drifts from the code,
 * which is exactly what happened when the list was maintained by hand: it
 * listed actions the server never handled and missed every feature added since.
 *
 * Generated: ${c2s.length} inbound, ${s2c.length} outbound.
 */

const PACKET = {
    // Client -> Server. The server dispatches on data.action.
    C2S: {
${c2sBody}
    },

    // Server -> Client. The client dispatches on data.action.
    S2C: {
${s2cBody}
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = PACKET;
} else {
    window.PACKET = PACKET;
}
`;
}

module.exports = { collectJsFiles, extractFromSource, buildContractFile };

if (require.main === module) {
    const fs = require('fs');
    const nodePath = require('path');
    const serverDir = nodePath.join(__dirname, '..', 'server');
    if (process.argv.includes('--write')) {
        const target = nodePath.join(__dirname, '..', 'shared', 'packet_types.js');
        fs.writeFileSync(target, buildContractFile(), 'utf8');
        const { toClient, fromClient } = extractFromSource(collectJsFiles(serverDir));
        console.log(`wrote ${target}: ${fromClient.size} inbound, ${toClient.size} outbound`);
    } else {
        const { toClient, fromClient } = extractFromSource(collectJsFiles(serverDir));
        const both = [...fromClient].filter(a => toClient.has(a)).sort();
        console.log('client -> server (' + fromClient.size + '):');
        console.log('  ' + [...fromClient].sort().join('\n  '));
        console.log('\nserver -> client (' + toClient.size + '):');
        console.log('  ' + [...toClient].sort().join('\n  '));
        console.log('\nbidirectional (' + both.length + '): ' + both.join(', '));
    }
}
