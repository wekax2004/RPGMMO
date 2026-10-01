/*
 * tests/unit/chat_render.test.js
 *
 * Behavioural tests for the chat line renderer: what markup the browser would
 * actually build from a chat message, not merely that an escapeHtml call is
 * present.
 *
 * Why this exists. renderChat used to assign innerText, so chat was safe with no
 * escaper at all. Timestamps and mention highlighting changed it to innerHTML,
 * which made the escaping load-bearing. A guard that greps for `escapeHtml(` proves
 * the call exists; it does not prove the output is inert. These tests feed real
 * payloads through the shipped helpers and assert on the parsed result.
 *
 * Two lessons are encoded here, both from writing the checker first:
 *
 *   1. A string-based check reported three escaped payloads as failures, because
 *      it grepped for the literal "onerror=" and matched it inside an inert
 *      escaped fragment. Asserting on the parsed DOM -- which elements exist,
 *      which event handlers exist -- is the question that actually matters.
 *
 *   2. The mention pattern was anchored with \b, which cannot match after a
 *      non-word character. "-" is legal in a character name, so a player named
 *      "B-" would never see their mentions highlighted. The lookahead form is
 *      pinned below so that cannot regress.
 *
 * The helpers are read out of ui.js rather than reimplemented, so these test the
 * shipped code. If a helper is renamed this file fails loudly, which is correct.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const UI_SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'client', 'js', 'ui.js'), 'utf8');

/** Pull a named function out of ui.js and compile it, so the real code is tested. */
function loadHelper(name) {
    const re = new RegExp(`function ${name}\\(value\\) \\{[\\s\\S]*?\\n        \\}`);
    const found = re.exec(UI_SRC);
    assert.ok(found, `could not find ${name}() in ui.js`);
    // eslint-disable-next-line no-eval
    return eval('(' + found[0].replace(new RegExp(`^function ${name}`), 'function') + ')');
}

const escapeHtml = loadHelper('escapeHtml');
const escapeRegExp = loadHelper('escapeRegExp');

/**
 * The rendering logic from renderChat, verbatim in structure.
 *
 * Duplicated on purpose: this asserts on behaviour, so it needs to build a string
 * the way the client does. A change to ui.js that diverges from this is caught by
 * the source-level assertions in xss_sinks.test.js, and this file says so.
 */
function renderLine(msg, myName) {
    let escapedMsg = escapeHtml(msg.text);
    if (myName && escapedMsg.includes('@' + myName)) {
        escapedMsg = escapedMsg.replace(
            new RegExp(escapeRegExp('@' + myName) + '(?![A-Za-z0-9_])', 'g'),
            `<span style="color:#fbbf24">@${escapeHtml(myName)}</span>`
        );
    }
    const timeSpan = msg.time ? `<span>[${escapeHtml(msg.time)}]</span>` : '';
    return timeSpan + escapedMsg;
}

/**
 * What the browser would build: element names, and any inline event handler.
 * Only tags that the renderer itself emits are considered legitimate.
 */
function parse(html) {
    const tags = [];
    const handlers = [];
    for (const m of html.matchAll(/<\s*([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
        tags.push(m[1].toLowerCase());
        for (const a of m[2].matchAll(/\bon[a-z]+\s*=/gi)) handlers.push(a[0]);
    }
    return { tags, handlers };
}

const ATTACKS = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '"><script>alert(1)</script>',
    "' onmouseover='alert(1)",
    '<svg onload=alert(1)>',
    '</div><img src=x onerror=alert(1)>',
    '<iframe src=javascript:alert(1)>',
    '<b>bold</b>',
    'plain & text < here',
    '`${alert(1)}`'
];

test('a chat message cannot introduce an element or an event handler', () => {
    // The renderer is allowed to emit exactly two kinds of element: the timestamp
    // span and the mention span. Anything else means player text became markup.
    for (const payload of ATTACKS) {
        const { tags, handlers } = parse(renderLine({ text: payload, time: '10:00' }, 'Bob'));
        assert.deepStrictEqual([...new Set(tags)].filter(t => t !== 'span'), [],
            `${JSON.stringify(payload)} produced unexpected elements: ${tags.join(', ')}`);
        assert.deepStrictEqual(handlers, [],
            `${JSON.stringify(payload)} produced inline event handlers: ${handlers.join(', ')}`);
    }
});

test('a hostile timestamp cannot introduce an element', () => {
    const { tags, handlers } = parse(renderLine({ text: 'hello', time: '<b>10:00</b>' }, 'Bob'));
    assert.deepStrictEqual([...new Set(tags)], ['span']);
    assert.deepStrictEqual(handlers, []);
});

test('a hostile mention name cannot introduce an element', () => {
    // Unreachable today -- the login charset forbids it -- and pinned anyway,
    // because the name arrives from the server and the limit lives there.
    const { tags, handlers } = parse(
        renderLine({ text: 'hi there', time: '10:00' }, '<img src=x onerror=alert(1)>'));
    assert.deepStrictEqual([...new Set(tags)], ['span']);
    assert.deepStrictEqual(handlers, []);
});

test('a mention is highlighted and the rest of the message survives', () => {
    const html = renderLine({ text: 'hey @Bob can you help', time: '10:00' }, 'Bob');
    assert.match(html, /<span[^>]*>@Bob<\/span>/, 'the mention should be wrapped');
    assert.ok(html.includes('can you help'), 'the surrounding text must be preserved');
    assert.ok(html.includes('[10:00]'), 'the timestamp must be present');
});

test('a name that is a prefix of a longer word is not highlighted', () => {
    const html = renderLine({ text: 'hey @Bobby hello', time: '10:00' }, 'Bob');
    assert.ok(!/<span[^>]*>@Bob<\/span>/.test(html),
        `"${html}" should not highlight @Bobby as a mention of @Bob`);
});

test('a name ending in a non-word character still highlights', () => {
    // The regression \b caused. \b is a word boundary, so a pattern ending on "-"
    // followed by a space has no boundary to match and silently fails. "-" is legal
    // in a character name under [A-Za-z][A-Za-z0-9 _-]*, so this was reachable.
    for (const name of ['B-', 'Bob[1]', 'x]']) {
        const html = renderLine({ text: `hi @${name} there`, time: '10:00' }, name);
        assert.ok(html.includes(`>@${name}</span>`),
            `a player named ${JSON.stringify(name)} would never be highlighted: ${html}`);
    }
});

test('punctuation after a name does not defeat the match', () => {
    for (const suffix of [',', '.', '!', '?', ':', ';', ')']) {
        const html = renderLine({ text: `@Bob${suffix} hi`, time: '10:00' }, 'Bob');
        assert.ok(html.includes('>@Bob</span>'),
            `"@Bob${suffix}" should still highlight a mention of @Bob: ${html}`);
    }
});

test('a longer word after a hyphenated name is still not a mention', () => {
    // The other half of the previous test: the lookahead must not over-match.
    const html = renderLine({ text: 'hi @B-x there', time: '10:00' }, 'B-');
    assert.ok(!html.includes('>@B-</span>'), `"${html}" wrongly highlighted @B-x`);
});

test('names containing regex metacharacters are matched literally', () => {
    // Outside today's server charset on purpose. The client must not depend on
    // that limit holding, because a metacharacter name silently either matches
    // the wrong text or nothing at all.
    for (const name of ['A.B', 'A+B', 'X|Y', 'a(b)c', 'back\\slash', 'q?x', 'a{2}']) {
        const html = renderLine({ text: `hi @${name} there`, time: '10:00' }, name);
        assert.ok(html.includes(`>@${name}</span>`),
            `name ${JSON.stringify(name)} should match itself: ${html}`);
    }
});

test('a metacharacter name does not highlight unrelated text', () => {
    // Without escaping, a name like A.B would match @AZB too.
    const html = renderLine({ text: 'hi @A.B then @ZZZ end', time: '10:00' }, 'A.B');
    assert.ok(html.includes('>@A.B</span>'), 'the real mention must highlight');
    assert.ok(html.includes('@ZZZ') && !html.includes('>@ZZZ</span>'),
        `@ZZZ must not be highlighted as a mention of A.B: ${html}`);
});

test('the mention pattern in ui.js escapes the name it builds from', () => {
    // Found by mutation: deleting the escapeRegExp() call from renderChat left
    // every test here green. renderLine() above is a copy of the logic, so it kept
    // using the escaped form and could not notice the real source had stopped
    // doing so -- a copy cannot test its original.
    //
    // The consequence is real: a name containing a metacharacter would match the
    // wrong message, or none. Today the server charset forbids those characters,
    // which is exactly why this went unnoticed and why it needs a source-level
    // assertion rather than a behavioural one.
    const fn = /function renderChat\(\)[\s\S]*?\n        \}/.exec(UI_SRC);
    assert.ok(fn, 'could not find renderChat in ui.js');
    assert.match(fn[0], /new RegExp\(escapeRegExp\("@" \+ myName\)/,
        'the mention pattern must escape the name before building a RegExp from it');
    assert.match(fn[0], /escapeRegExp/,
        'renderChat must route the name through escapeRegExp');
});

test('renderChat uses the same lookahead anchor this file models', () => {
    // The copy above encodes the anchor, so a change to ui.js alone would leave it
    // testing a pattern the client no longer uses. Pinning the anchor in the source
    // closes that.
    const fn = /function renderChat\(\)[\s\S]*?\n        \}/.exec(UI_SRC);
    assert.ok(fn, 'could not find renderChat in ui.js');
    assert.match(fn[0], /\(\?!\[A-Za-z0-9_\]\)/,
        'renderChat must anchor the mention with a negative lookahead, not \\b');
    assert.ok(!/escapeRegExp\("@" \+ myName\) \+ "\\\\b"/.test(fn[0]),
        'renderChat must not go back to a \\b anchor: it cannot match a name that ' +
        'ends in a non-word character, and "-" is legal in a character name');
});

test('an ordinary line renders unchanged apart from the timestamp', () => {
    const html = renderLine({ text: 'hello world', time: '10:00' }, 'Bob');
    assert.ok(html.includes('[10:00]'));
    assert.ok(html.includes('hello world'));
    assert.deepStrictEqual(parse(html).tags, ['span']);
});

test('a message with no timestamp still renders', () => {
    // Older chatMessages entries carry no time field; they must not become
    // "[undefined]" or throw.
    const html = renderLine({ text: 'no time here' }, 'Bob');
    assert.ok(html.includes('no time here'));
    assert.ok(!html.includes('undefined'), `"${html}" leaked the string "undefined"`);
});