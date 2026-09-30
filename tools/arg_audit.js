/*
 * Counts the arguments at every call site of a function, so a default parameter
 * that no caller relies on can be identified.
 *
 * Used to justify removing the trade_sync default: if every caller of
 * sendTradeSyncAll passes an explicit action, then 'trade_sync' can only ever
 * reach a client through a caller that no longer exists.
 *
 * Run:  node tools/arg_audit.js <file> <fnName> [<fnName> ...]
 */
const fs = require('fs');

const [, , file, ...names] = process.argv;
if (!file || !names.length) {
    console.error('usage: node tools/arg_audit.js <file> <fnName> [<fnName> ...]');
    process.exit(2);
}

const src = fs.readFileSync(file, 'utf8');

function callSites(name) {
    const out = [];
    // Not preceded by a word character, so sendTradeSync does not also match
    // inside sendTradeSyncAll.
    const re = new RegExp(`(?<![A-Za-z0-9_])${name}\\(`, 'g');
    let m;
    while ((m = re.exec(src))) {
        // Walk the argument list, counting top-level commas, so a nested call or
        // an object literal does not inflate the count.
        let i = m.index + name.length + 1;
        let depth = 1;
        let commas = 0;
        while (i < src.length && depth > 0) {
            const c = src[i];
            if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') depth--;
            else if (c === ',' && depth === 1) commas++;
            i++;
        }
        const line = src.slice(0, m.index).split('\n').length;
        out.push({ line, args: commas + 1, text: src.slice(m.index, i).replace(/\s+/g, ' ').slice(0, 76) });
    }
    return out;
}

for (const name of names) {
    const def = new RegExp(`function ${name}\\(([^)]*)\\)`).exec(src);
    const sig = def ? def[1] : null;
    const hasDefault = sig !== null && /action\s*=/.test(sig);
    const defaultAction = hasDefault ? /action\s*=\s*'([a-z_]+)'/.exec(sig)[1] : null;
    const declared = sig ? sig.split(',').length : 0;

    const sites = callSites(name);
    // The declaration itself matches the call pattern; drop it.
    const calls = sites.filter(s => s.line !== (def ? src.slice(0, src.indexOf(def[0])).split('\n').length : -1));

    console.log(`\n${name}`);
    console.log(`  signature: (${sig})`);
    console.log(`  declared params: ${declared}${hasDefault ? `, default action '${defaultAction}'` : ''}`);
    console.log(`  call sites: ${calls.length}`);
    for (const c of calls) {
        const usesDefault = c.args < declared;
        console.log(`    L${c.line}  args=${c.args}${usesDefault ? '   <-- RELIES ON THE DEFAULT' : ''}`);
        console.log(`      ${c.text}`);
    }
    if (!calls.length) console.log('    (none)');
}
