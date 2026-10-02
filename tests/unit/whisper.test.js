/*
 * tests/unit/whisper.test.js
 *
 * Private messages (roadmap 6.1).
 *
 * The load-bearing claim in server/whisper.js is that this needs no client change at
 * all, because the client relays typed chat text verbatim and only special-cases
 * /p, /z and /g. If someone later adds client-side input filtering that rejects or
 * rewrites /w -- entirely reasonably, since it is a new command -- every whisper
 * silently stops working and nothing server-side notices. There is a test for that.
 *
 * The other thing worth pinning is the order of delivery. The recipient is sent
 * first and the sender's echo second, so that if sending to the recipient throws,
 * the sender never sees a confirmation for a message that did not arrive. Reversing
 * those two lines looks harmless and reports a message as sent when it was not.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WHISPER = require('../../server/whisper');
const RATELIMIT = require('../../server/ratelimit');

const SERVER_JS = path.join(__dirname, '..', '..', 'server', 'server.js');
const ENGINE_JS = path.join(__dirname, '..', '..', 'client', 'js', 'engine.js');

/** A recipient that records what it was sent. */
function recipient(name) {
    return { charName: name, sent: [] };
}

/** Builds a context and returns it with the log of everything that happened. */
function harness({ online = {}, senderName = 'Sender' } = {}) {
    const sender = { charName: senderName, sent: [], notes: [] };
    const log = { sends: [], notifications: [] };
    const ctx = {
        sender,
        senderName,
        lookup: (name) => online[name.toLowerCase()] || null,
        sendTo: (who, packet) => { log.sends.push({ to: who.charName, packet }); who.sent.push(packet); },
        notify: (who, message) => { log.notifications.push({ to: who.charName, message }); }
    };
    return { ctx, log, sender };
}

// --- parsing -----------------------------------------------------------------

test('a whisper is parsed into a target and a message', () => {
    assert.deepStrictEqual(WHISPER.parse('/w Alice hello'), { target: 'Alice', message: 'hello' });
});

test('extra whitespace around the name and message is collapsed at the edges', () => {
    assert.deepStrictEqual(WHISPER.parse('/w   Bob    hi there  '),
        { target: 'Bob', message: 'hi there' });
});

test('a message may contain spaces and punctuation', () => {
    assert.deepStrictEqual(WHISPER.parse('/w Bob meet me at 8, near the bridge!'),
        { target: 'Bob', message: 'meet me at 8, near the bridge!' });
});

test('a name with no message is not a whisper', () => {
    // Ambiguous by construction: "/w Alice" could be read as target "" with the
    // message "Alice". Treated as no message, which is the only reading where
    // nothing is silently swallowed.
    assert.strictEqual(WHISPER.parse('/w Alice'), null);
});

test('the prefix requires a space, so /wave is not swallowed', () => {
    // A player typing a sentence that happens to start with "/w" would otherwise
    // get a confusing error instead of their message.
    assert.strictEqual(WHISPER.parse('/wave hi'), null);
    assert.strictEqual(WHISPER.parse('/wands 3'), null);
    assert.strictEqual(WHISPER.parse('/w'), null);
    assert.strictEqual(WHISPER.parse('/w   '), null);
});

test('other channels and commands are left alone', () => {
    for (const line of ['hello everyone', '/g guild chat', '/p party up', '/z local news', '/ask what is a cist']) {
        assert.strictEqual(WHISPER.parse(line), null, `${line} must not be read as a whisper`);
    }
});

test('non-string input is not a whisper', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
        assert.strictEqual(WHISPER.parse(bad), null);
    }
});

// --- delivery ----------------------------------------------------------------

test('the recipient receives the message, tagged as a whisper from the sender', () => {
    const bob = recipient('Bob');
    const { ctx, log } = harness({ online: { bob } });
    const result = WHISPER.whisper(Object.assign({ text: '/w Bob hello' }, ctx));

    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.outcome, 'sent');
    const toBob = log.sends.find(s => s.to === 'Bob');
    assert.ok(toBob, 'Bob must receive the message');
    assert.strictEqual(toBob.packet.action, 'chat');
    assert.strictEqual(toBob.packet.channel, 'whisper');
    assert.strictEqual(toBob.packet.sender, 'Sender');
    assert.strictEqual(toBob.packet.name, 'Sender');
    assert.strictEqual(toBob.packet.text, 'hello');
    assert.strictEqual(toBob.packet.target, 'Bob');
});

test('the sender gets their own message back, so they can see what went out', () => {
    const bob = recipient('Bob');
    const { ctx, log } = harness({ online: { bob } });
    WHISPER.whisper(Object.assign({ text: '/w Bob hello' }, ctx));

    const echo = log.sends.find(s => s.to === 'Sender');
    assert.ok(echo, 'the sender must see their own whisper');
    assert.strictEqual(echo.packet.text, 'hello');
    assert.strictEqual(echo.packet.target, 'Bob');
    assert.strictEqual(echo.packet.outbound, true,
        'the echo must be marked outbound so a client can tell it from an incoming one');
    assert.strictEqual(log.sends.length, 2, 'exactly two sends: the recipient and the echo');
});

test('the recipient is sent before the sender is told it worked', () => {
    // If the send to the recipient throws, the sender must not already have been
    // told their message went out. Reversing these two lines is invisible in review
    // and reports undelivered messages as sent.
    const bob = recipient('Bob');
    const order = [];
    const sender = { charName: 'Sender' };
    const ctx = {
        sender, senderName: 'Sender',
        lookup: () => bob,
        sendTo: (who) => {
            order.push(who.charName);
            if (who.charName === 'Bob') throw new Error('socket closed');
        },
        notify: () => {}
    };
    assert.throws(() => WHISPER.whisper(Object.assign({ text: '/w Bob hello' }, ctx)));
    assert.deepStrictEqual(order, ['Bob'],
        `expected the send order to stop at Bob, got ${JSON.stringify(order)}`);
});

test('a long message is truncated to the same limit as ordinary chat', () => {
    const bob = recipient('Bob');
    const { ctx, log } = harness({ online: { bob } });
    WHISPER.whisper(Object.assign({ text: '/w Bob ' + 'x'.repeat(500) }, ctx));
    assert.strictEqual(log.sends[0].packet.text.length, WHISPER.MAX_LENGTH);
    assert.strictEqual(WHISPER.MAX_LENGTH, 240,
        'must match the ordinary chat limit, or whisper becomes a way around it');
});

test('the lookup is case-insensitive on the target name', () => {
    const bob = recipient('Bob');
    const { ctx, log } = harness({ online: { bob } });
    WHISPER.whisper(Object.assign({ text: '/w BOB hello' }, ctx));
    assert.strictEqual(log.sends.length, 2);
    assert.strictEqual(log.sends[0].to, 'Bob');
});

// --- refusal -----------------------------------------------------------------

test('an offline target tells the sender and nobody else', () => {
    const eve = recipient('Eve');
    const { ctx, log } = harness({ online: { eve } });
    const result = WHISPER.whisper(Object.assign({ text: '/w Ghost hello' }, ctx));

    assert.strictEqual(result.outcome, 'no-such-player');
    assert.strictEqual(log.sends.length, 0, 'nothing may be sent to anyone');
    assert.strictEqual(log.notifications.length, 1);
    assert.strictEqual(log.notifications[0].to, 'Sender');
    assert.match(log.notifications[0].message, /Ghost/);
    assert.strictEqual(eve.sent.length, 0, 'a bystander must learn nothing');
});

test('the offline message does not say whether the character exists', () => {
    // Otherwise typing a name reveals whether that character is merely offline,
    // which turns the whisper command into a roster oracle.
    const { ctx, log } = harness({ online: {} });
    WHISPER.whisper(Object.assign({ text: '/w Ghost hello' }, ctx));
    const message = log.notifications[0].message.toLowerCase();
    assert.ok(!/does not exist|no such character|never (existed|played)|unknown character/i.test(message),
        `the message leaks whether the name is real: "${log.notifications[0].message}"`);
    assert.ok(!/\bexists\b/i.test(message),
        `saying a name "exists" is the same leak stated differently: "${log.notifications[0].message}"`);
    assert.ok(!/offline|logged out|not online/i.test(message),
        `the message should say who is online, not who is not: "${log.notifications[0].message}"`);
});

test('whispering yourself is refused', () => {
    const sender = { charName: 'Sender' };
    const { ctx, log } = harness({ online: { sender } });
    const result = WHISPER.whisper(Object.assign({ text: '/w sender hello' }, ctx));

    assert.strictEqual(result.outcome, 'self');
    assert.strictEqual(log.sends.length, 0);
    assert.match(log.notifications[0].message, /cannot whisper yourself/i);
});

test('a self-whisper is caught whatever the case', () => {
    const sender = { charName: 'Sender' };
    const { ctx } = harness({ online: { sender } });
    assert.strictEqual(WHISPER.whisper(Object.assign({ text: '/w SENDER hi' }, ctx)).outcome, 'self');
});

test('a whisper with no message is not handled at all, so it falls through to chat', () => {
    const bob = recipient('Bob');
    const { ctx, log } = harness({ online: { bob } });
    const result = WHISPER.whisper(Object.assign({ text: '/w Bob' }, ctx));
    assert.strictEqual(result.handled, false,
        '"/w Bob" is not a complete whisper; returning handled:false lets the normal ' +
        'chat path deal with it rather than silently swallowing the line');
    assert.strictEqual(log.sends.length, 0);
});

test('a line that is not a whisper is reported as unhandled', () => {
    const { ctx } = harness();
    assert.strictEqual(WHISPER.whisper(Object.assign({ text: 'hello' }, ctx)).handled, false);
});

// --- rate limiting -----------------------------------------------------------

test('a whisper is charged to the chat budget, not to its own', () => {
    // The whisper arrives as action 'chat' with channel 'whisper'. classFor() keys
    // on the ACTION, so the chat budget governs it. If that ever changes to key on
    // the channel, every whisper becomes unbudgeted and the flood guard is the only
    // thing left -- which is one slow packet per message, to one recipient, which is
    // exactly the shape of a targeted spam tool.
    assert.strictEqual(RATELIMIT.classFor('chat'), 'chat');
    assert.strictEqual(RATELIMIT.ACTION_CLASSES.whisper, 'chat',
        'a whisper action, if one is ever added, must budget as chat');
    assert.strictEqual(RATELIMIT.ACTION_CLASSES.say, 'chat');
});

// --- the wiring, and the claim that no client change is needed ---------------

test('server.js routes whispers before the channel whitelist', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const chatAt = src.indexOf("if (data.action === 'chat')");
    assert.ok(chatAt !== -1, 'the chat branch must exist');
    const branch = src.slice(chatAt, src.indexOf('// --- PARTY ACTIONS ---'));
    assert.ok(branch.includes('WHISPER.whisper('), 'the chat branch must dispatch whispers');
    assert.ok(/WHISPER\s*=\s*require\('\.\/whisper'\)/.test(src), 'server.js must require ./whisper');

    // The whitelist below rejects anything that is not global/party/zone, so the
    // whisper dispatch has to come first or /w is dead on arrival.
    const at = branch.indexOf('WHISPER.whisper(');
    const whitelistAt = branch.indexOf("['global', 'party', 'zone']");
    assert.ok(whitelistAt !== -1, 'the channel whitelist must exist');
    assert.ok(at < whitelistAt, 'whispers must be dispatched before the channel whitelist');
});

test('a whisper that is dispatched still returns, rather than falling through to chat', () => {
    // The dangerous shape. The channel whitelist does not reject a /w line: the
    // default channel is 'global', so a whisper that falls through is accepted and
    // broadcast to every connected player. A mutation that replaces the guard with
    // `if (false)` leaves the feature looking entirely healthy -- whispers still
    // arrive, they just also go to everyone.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const chatAt = src.indexOf("if (data.action === 'chat')");
    const branch = src.slice(chatAt, src.indexOf('// --- PARTY ACTIONS ---'));
    assert.ok(/if \(whispered\.handled\) return;/.test(branch),
        'the dispatch result must gate a return. Without it a private line is ' +
        'broadcast on the default channel.');
});

test('a whisper cannot be broadcast even if the dispatch is removed', () => {
    // The second barrier. Asserted as present because it is unreachable while the
    // first guard holds, and unreachable code with no test is exactly the code that
    // gets deleted by someone tidying up.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const chatAt = src.indexOf("if (data.action === 'chat')");
    const branch = src.slice(chatAt, src.indexOf('// --- PARTY ACTIONS ---'));
    assert.ok(/if \(WHISPER\.parse\(data\.text\)\) return;/.test(branch),
        'a line that parses as a whisper must be refused a second time, independently ' +
        'of the dispatch, so that removing the dispatch cannot turn a private ' +
        'message into a global broadcast');
});

test('the chat branch resolves names with the real player lookup', () => {
    // Passing a stub or a function that returns null would make every whisper report
    // "nobody online" while every unit test of whisper.js -- which supplies its own
    // lookup -- stayed green. Wiring has to be asserted separately from behaviour.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    assert.ok(/lookup: findPlayerByName,/.test(src),
        'the chat branch must resolve whisper targets with findPlayerByName, the ' +
        'same case-insensitive online lookup the party and guild commands use');
});

test('the client still relays chat text verbatim, so /w needs no client support', () => {
    // The whole reason this feature shipped without touching engine.js or ui.js. If
    // client-side filtering is ever added that rejects or rewrites /w -- which would
    // be a reasonable thing to do for a new command -- whispers stop working
    // silently and nothing in this file or on the server notices.
    const src = fs.readFileSync(ENGINE_JS, 'utf8');
    const sendAt = src.indexOf('socket.send(JSON.stringify({ action: "chat"');
    assert.ok(sendAt !== -1, 'engine.js must send a chat packet');
    const before = src.slice(Math.max(0, sendAt - 700), sendAt);

    // Only the slash-prefix rewrites matter here. The same block also assigns
    // `channel = "global"` and calls text.substring(), which have no prefix to
    // capture, so matching the whole block and reading one capture group reported
    // "/undefined" as a rewritten prefix.
    const prefixes = [...before.matchAll(/startsWith\("\/(\w+)\s*"\)/g)].map(m => m[1]);
    assert.ok(prefixes.length > 0, 'the client is expected to rewrite some chat input');
    for (const prefix of prefixes) {
        assert.notStrictEqual(prefix.toLowerCase(), 'w',
            `the client now rewrites /${prefix} before sending, which means a /w whisper ` +
            'will no longer reach the server verbatim. Re-check server/whisper.js.');
    }
    // And say what it currently handles, so a change shows up as a diff in the
    // failure message rather than as a bare "w appeared".
    assert.deepStrictEqual(prefixes.sort(), ['g', 'p', 'z'],
        'the set of chat prefixes the client strips has changed; re-check whisper parsing');
});

test('no removal or delivery packet was invented for whispers', () => {
    // Whisper rides on the existing chat packet with a channel value. A dedicated
    // packet would mean two paths for the client to render and filter, and the AoI
    // work showed how easy it is for one of them to quietly go stale.
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    assert.ok(/channel: 'whisper'/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'whisper.js'), 'utf8')),
        'whispers must ride the chat packet with channel: "whisper"');
    assert.ok(!/action: 'whisper'/.test(src), 'no separate whisper packet action');
});
