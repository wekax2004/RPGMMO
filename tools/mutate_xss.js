/*
 * Re-injects the stored XSS, and near misses of it, one at a time, and confirms
 * tests/unit/xss_sinks.test.js goes red for each.
 *
 * Run:  node tools/mutate_xss.js
 * Exits non-zero if any mutation survives.
 *
 * The point is the first two. The general rule ("every interpolation that
 * reaches innerHTML must be escaped") was written after the general rule had
 * already been shown to produce nine false positives on correct code, which is
 * the state in which a security check quietly stops being read. A rule that only
 * ever says yes is not a control.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UI = 'client/js/ui.js';
const ENGINE = 'client/js/engine.js';
const TEST = 'tests/unit/xss_sinks.test.js';
// chat_render.test.js is run alongside it: the source-level assertions say an
// escapeHtml call is present, and this one says the output is inert. Both are
// needed -- the first missed the behaviour, the second cannot see the source.
const TEST2 = 'tests/unit/chat_render.test.js';

const MUTATIONS = [
    {
        name: 'the original stored XSS: sellerName interpolated raw',
        file: UI,
        from: '(Seller: ${escapeHtml(item.sellerName)})',
        to: '(Seller: ${item.sellerName})'
    },
    {
        name: 'the item name interpolated raw',
        file: UI,
        from: '${escapeHtml(item.item)}',
        to: '${item.item}'
    },
    {
        name: 'the listing id raw inside the onclick attribute',
        file: UI,
        from: "window.buyAuction('${escapeHtml(item.id)}')",
        to: "window.buyAuction('${item.id}')"
    },
    {
        name: 'the price interpolated instead of coerced',
        file: UI,
        from: '${Number(item.price) || 0}G',
        to: '${item.price}G'
    },
    {
        // Rewritten when chat moved from innerText to innerHTML. The old form
        // mutated the whole assignment; the new one removes a single escapeHtml
        // call, which is the mutation that matches how the code is written now.
        name: 'chat is built without escaping the body at all',
        file: UI,
        from: 'let escapedMsg = escapeHtml(msg.text);',
        to: 'let escapedMsg = msg.text;'
    },
    {
        name: 'a new unescaped seller field appears alongside the fixed one',
        file: UI,
        from: '<span style="color:#fbbf24">${escapeHtml(item.item)}</span>',
        to: '<span style="color:#fbbf24">${escapeHtml(item.item)}</span><span>${item.sellerId}</span>'
    },
    {
        // The four below were added after the innerText -> innerHTML change for
        // timestamps and mention highlighting made chat's escaping load-bearing.
        name: 'the chat body stops being escaped before reaching innerHTML',
        file: UI,
        from: 'let escapedMsg = escapeHtml(msg.text);',
        to: 'let escapedMsg = msg.text;'
    },
    {
        name: 'chat is written with innerText again, dropping both features',
        file: UI,
        from: 'd.innerHTML = timeSpan + escapedMsg;',
        to: 'd.innerText = msg.text;'
    },
    {
        name: 'the mention name is interpolated raw into the highlight markup',
        file: UI,
        from: '@${escapeHtml(myName)}</span>',
        to: '@${myName}</span>'
    },
    {
        name: 'the timestamp is interpolated raw',
        file: UI,
        from: '[${escapeHtml(msg.time)}]</span>',
        to: '[${msg.time}]</span>'
    },
    {
        name: 'renderChat goes back to a hand-rolled partial escaper',
        file: UI,
        from: 'let escapedMsg = escapeHtml(msg.text);',
        to: 'let escapedMsg = msg.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");'
    },
    {
        name: 'the mention pattern is built without escaping the name',
        file: UI,
        from: 'new RegExp(escapeRegExp("@" + myName) + "(?![A-Za-z0-9_])", "g")',
        to: 'new RegExp("@" + myName + "(?![A-Za-z0-9_])", "g")'
    },
    {
        name: 'the character-name charset is widened to allow markup',
        file: path.join('server', 'server.js'),
        from: '!/^[A-Za-z][A-Za-z0-9 _-]*$/.test(requestedName)',
        to: '!/^[A-Za-z][A-Za-z0-9 _-<>]*$/.test(requestedName)'
    },
    {
        name: 'the character-name length cap is removed',
        file: path.join('server', 'server.js'),
        from: 'requestedName.length > 32 ||',
        to: 'false ||'
    },
    {
        name: 'the guild member list stops escaping names',
        file: ENGINE,
        from: 'myGuild.members.forEach(m => h += "- " + escapeHtml(m) + "<br/>");',
        to: 'myGuild.members.forEach(m => h += "- " + m + "<br/>");'
    },
    {
        name: 'the bank item list stops escaping names',
        file: UI,
        from: "<span>${escapeHtml(item)} x${counts[item]}</span>",
        to: "<span>${item} x${counts[item]}</span>"
    }
];

function runSuite() {
    // Both suites must fail. A mutation that only trips the source-level check is
    // caught, but one that only trips the behavioural check is equally caught, and
    // running just one of them would hide whichever it cannot see.
    try {
        const out = execFileSync(process.execPath, ['--test', TEST, TEST2], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    }
}

function failingTest(out) {
    const m = out.match(/✖ ([^\n]+)/);
    return m ? m[1].trim().slice(0, 70) : '(no failure line found)';
}

const originals = new Map();
for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs, 'utf8'));
}

console.log('=== XSS sink mutation testing ===\n');
const base = runSuite();
console.log(`  baseline: ${base.ok ? 'passes' : 'ALREADY FAILING'}`);
if (!base.ok) {
    console.log('    ' + failingTest(base.out));
    console.log('\n  ABORT: green before mutating or nothing below means anything.');
    process.exit(1);
}

let survived = 0;
for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    const src = originals.get(abs);
    if (!src.includes(m.from)) {
        console.log(`  SKIP      ${m.name}`);
        console.log('            anchor not found -- the source drifted, update this harness\n');
        survived++;
        continue;
    }
    fs.writeFileSync(abs, src.replace(m.from, m.to), 'utf8');
    const result = runSuite();
    fs.writeFileSync(abs, src, 'utf8');

    if (result.ok) {
        survived++;
        console.log(`  SURVIVED  ${m.name}`);
        console.log('            the suite passed against injectable code\n');
    } else {
        console.log(`  CAUGHT    ${m.name}`);
        console.log(`            ${failingTest(result.out)}\n`);
    }
}

console.log(`  ${MUTATIONS.length - survived} caught, ${survived} survived`);
if (survived) {
    console.log('\n  A surviving mutation is an assertion that does not assert.');
    process.exitCode = 1;
} else {
    console.log('  Every mutation was caught.');
}