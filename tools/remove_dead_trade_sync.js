/*
 * Removes the client's dead trade_sync handler.
 *
 * The client handles `trade_sync` OR `trade_update` on one branch, and the
 * server never sends `trade_sync` -- sendTradeSync is defined with
 * `action = 'trade_sync'` as a default argument, but every one of its four call
 * sites passes an explicit action, and the two that do not reach a client. So
 * the client has been carrying a packet name it will never receive.
 *
 * This removes the dead half of the branch and leaves `trade_update`, which is
 * what actually arrives. Verified before removing: the server sends
 * trade_update, and trade_sync appears nowhere as an emitted action.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client', 'js', 'engine.js');
const SERVER_DIR = path.join(ROOT, 'server');

function emittedActions() {
    // Every action the server actually puts on the wire, from both the direct
    // sendTo/broadcast shapes and any action: '...' literal.
    const found = new Set();
    for (const f of fs.readdirSync(SERVER_DIR)) {
        if (!f.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(SERVER_DIR, f), 'utf8');
        for (const m of src.matchAll(/action:\s*'([a-z_]+)'/g)) found.add(m[1]);
    }
    return found;
}

function main() {
    const emitted = emittedActions();
    console.log(`the server emits ${emitted.size} distinct actions`);

    const target = 'trade_sync';
    if (!emitted.has(target)) {
        console.log(`'${target}' is never emitted -- the client handler is dead`);
    } else {
        console.log(`'${target}' IS emitted somewhere; refusing to touch the handler`);
        process.exit(1);
    }

    // The action these helpers send is a parameter with a default, so it never
    // appears as an `action: '...'` literal -- scanning for those finds none of
    // the trade family and would wrongly conclude the whole feature is dead.
    // Read the call sites instead.
    const serverSrc = fs.readFileSync(path.join(SERVER_DIR, 'server.js'), 'utf8');
    const tradeActions = new Set();
    for (const m of serverSrc.matchAll(/syncTrade\w*\([^)]*?,\s*'([a-z_]+)'/g)) tradeActions.add(m[1]);
    for (const m of serverSrc.matchAll(/sendTradeSyncAll\([^)]*?,\s*'([a-z_]+)'/g)) tradeActions.add(m[1]);
    console.log(`trade actions passed at the call sites: ${[...tradeActions].sort().join(', ') || '(none)'}`);

    const defaultAction = /function sendTradeSyncAll\(trade, action = '([a-z_]+)'\)/.exec(serverSrc);
    if (defaultAction) {
        const used = [...tradeActions].join(',');
        const isUsed = used.includes(defaultAction[1]);
        console.log(`the default action '${defaultAction[1]}' is ${isUsed ? 'used' : 'NEVER passed by any call site'}` +
            (isUsed ? '' : ' -- so it is the only way that name could reach a client'));
    }

    if (!tradeActions.has('trade_update')) {
        console.log("but 'trade_update' is never passed either, so the branch is entirely dead");
        process.exit(1);
    }
    console.log("'trade_update' is passed by the call sites, so the surviving half of the branch is live");

    const src = fs.readFileSync(CLIENT, 'utf8');
    const from = 'else if (data.action === "trade_sync" || data.action === "trade_update") {';
    const to = 'else if (data.action === "trade_update") {';
    const n = src.split(from).length - 1;
    if (n !== 1) {
        console.log(`anchor found ${n}x, expected 1 -- engine.js has drifted, update this tool`);
        process.exit(1);
    }

    fs.writeFileSync(CLIENT, src.split(from).join(to), 'utf8');
    console.log('removed the dead trade_sync half of the branch');

    // And leave nothing behind that claims to receive it.
    const after = fs.readFileSync(CLIENT, 'utf8');
    if (/trade_sync/.test(after)) {
        console.log('WARNING: trade_sync still appears in engine.js:');
        after.split('\n').forEach((l, i) => {
            if (/trade_sync/.test(l)) console.log(`  L${i + 1}: ${l.trim().slice(0, 70)}`);
        });
        process.exit(1);
    }
    console.log('verified: no trade_sync remains in the client');
    return 0;
}

process.exit(main());
