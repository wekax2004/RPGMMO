/*
 * Removes the dead trade_sync default from the server's trade helpers.
 *
 * Three helpers each declare `action = 'trade_sync'` as a default. Every one of
 * their nine call sites passes an explicit action, so the default is never taken
 * and the string 'trade_sync' can no longer reach a client by any path.
 *
 * That default was the last thing keeping a packet name alive that the client
 * had a handler for and the server never sent. Removing it means a future caller
 * that omits the argument gets `undefined` as the action and an obviously broken
 * packet, rather than silently reviving an action nobody implements.
 *
 * Verified with tools/arg_audit.js, which counts arguments at each call site and
 * flags any that rely on a default. It reports 9 call sites, 0 relying on one.
 *
 * Run:  node tools/remove_dead_trade_defaults.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'server.js');

const HELPERS = ['sendTradeSync', 'sendTradeSyncAll', 'syncTrade'];

// Counts top-level commas so a nested call does not inflate the argument count.
function countArgs(src, openIdx) {
    let i = openIdx;
    let depth = 0;
    let commas = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) return commas + 1;
        } else if (c === ',' && depth === 1) commas++;
        i++;
    }
    return -1;
}

function main() {
    let src = fs.readFileSync(SERVER, 'utf8');

    // Refuse to touch anything unless every helper's default is provably unused.
    for (const name of HELPERS) {
        const decl = new RegExp(`function ${name}\\(([^)]*)\\)`).exec(src);
        if (!decl) {
            console.log(`cannot find the declaration of ${name}; server.js has drifted`);
            process.exit(1);
        }
        const sig = decl[1];
        const m = /action\s*=\s*'([a-z_]+)'/.exec(sig);
        if (!m) {
            console.log(`${name} has no action default; nothing to remove`);
            continue;
        }
        const declared = sig.split(',').length;

        // Every call site, excluding the declaration line itself.
        const declLine = src.slice(0, src.indexOf(decl[0])).split('\n').length;
        const re = new RegExp(`(?<![A-Za-z0-9_])${name}\\(`, 'g');
        let cm;
        let relying = 0;
        let total = 0;
        while ((cm = re.exec(src))) {
            const line = src.slice(0, cm.index).split('\n').length;
            if (line === declLine) continue;
            const openIdx = cm.index + name.length;
            const args = countArgs(src, openIdx);
            if (args < 0) continue;
            total++;
            if (args < declared) relying++;
        }
        console.log(`  ${name}: default '${m[1]}', ${total} call site(s), ${relying} relying on it`);
        if (relying > 0) {
            console.log(`REFUSING: ${name} still has ${relying} caller(s) relying on the default`);
            process.exit(1);
        }
    }

    // All clear. Drop the defaults, leaving the parameter required.
    const before = src;
    for (const name of HELPERS) {
        src = src.replace(
            new RegExp(`(function ${name}\\([^)]*?action) = '[a-z_]+'`),
            '$1'
        );
    }
    if (src === before) {
        console.log('nothing changed; the defaults were already gone');
        return 0;
    }
    fs.writeFileSync(SERVER, src, 'utf8');

    // Prove it: no 'trade_sync' string anywhere in the server.
    const after = fs.readFileSync(SERVER, 'utf8');
    const left = [];
    after.split('\n').forEach((l, i) => {
        if (/trade_sync/.test(l)) left.push(`L${i + 1}: ${l.trim().slice(0, 70)}`);
    });
    if (left.length) {
        console.log('LEFTOVER trade_sync in server.js:');
        for (const l of left) console.log('  ' + l);
        process.exit(1);
    }
    console.log('removed 3 dead defaults; verified: no trade_sync remains in server.js');
    return 0;
}

process.exit(main());
