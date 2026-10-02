/*
 * Re-injects the ways the whisper feature could be wrong, one at a time, and confirms
 * tests/unit/whisper.test.js goes red for each.
 *
 * Run:  node tools/mutate_whisper.js
 * Exits non-zero if any mutation survives.
 *
 * The first four are the ones that would actually embarrass someone. A whisper sent
 * on channel 'global' is a private message broadcast to every connected player; a
 * dropped self-check is a player talking to themselves in everyone's view; a
 * reversed delivery order confirms a message that was never delivered. None of those
 * produce an error, a log line, or a failed test anywhere else in the suite -- the
 * feature would be reported as working.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WHISPER = 'server/whisper.js';
const SERVER = 'server/server.js';
const RATELIMIT = 'server/ratelimit.js';
const ENGINE = 'client/js/engine.js';
const TEST = 'tests/unit/whisper.test.js';

const MUTATIONS = [
    // --- parsing ------------------------------------------------------------
    {
        name: 'the prefix loses its space, so /wave is swallowed as a whisper',
        file: WHISPER,
        from: "if (!text.startsWith('/w ')) return null;",
        to: "if (!text.startsWith('/w')) return null;"
    },
    {
        name: 'the missing-message guard is dropped, so "/w Alice" sends an empty line',
        file: WHISPER,
        from: 'if (split === -1) return null;                    // "/w Alice" -- a name and no message',
        to: 'if (split === -1) return { target: rest, message: "" };'
    },
    {
        name: 'the split takes the last space, mangling multi-word messages',
        file: WHISPER,
        from: 'const split = rest.search(/\\s/);',
        to: 'const split = rest.lastIndexOf(" ");'
    },
    {
        name: 'parse stops trimming, so a leading space reaches the name',
        file: WHISPER,
        from: 'const rest = text.substring(3).trim();',
        to: 'const rest = text.substring(3);'
    },
    {
        name: 'parse throws on null instead of declining it',
        file: WHISPER,
        from: "if (typeof text !== 'string') return null;",
        to: "if (typeof text !== 'string') return { target: 'x', message: text };"
    },

    // --- the privacy failures ----------------------------------------------
    {
        name: 'THE SERIOUS ONE: whispers go out on the global channel',
        file: WHISPER,
        from: "channel: 'whisper',",
        to: "channel: 'global',"
    },
    {
        name: 'the message carries no target, so a client cannot tell who it was for',
        file: WHISPER,
        from: 'target: recipient.charName,',
        to: 'target: undefined,'
    },
    {
        name: 'the self-whisper check is removed',
        file: WHISPER,
        from: "if (recipient.charName && recipient.charName.toLowerCase() === String(ctx.senderName).toLowerCase()) {",
        to: 'if (false) {'
    },
    {
        name: 'the sender is mislabelled, so a whisper appears to come from the server',
        file: WHISPER,
        from: 'sender: ctx.senderName,',
        to: "sender: 'System',"
    },
    {
        name: 'an offline target is told the character does not exist',
        file: WHISPER,
        from: "ctx.notify(ctx.sender, 'Nobody online is called ' + target + '.');",
        to: "ctx.notify(ctx.sender, 'No character named ' + target + ' exists.');"
    },

    // --- delivery -----------------------------------------------------------
    {
        name: 'the send order is reversed, confirming messages that were never delivered',
        file: WHISPER,
        from: `    ctx.sendTo(recipient, packet);

    // Echoed to the sender so they can see what went out. Tibia does this, and a
    // one-sided send would leave the sender unable to tell a delivered whisper from
    // one the server swallowed.
    ctx.sendTo(ctx.sender, Object.assign({}, packet, { outbound: true }));`,
        to: `    ctx.sendTo(ctx.sender, Object.assign({}, packet, { outbound: true }));
    ctx.sendTo(recipient, packet);`
    },
    {
        name: 'the sender never sees their own whisper, so delivery is unverifiable',
        file: WHISPER,
        from: 'ctx.sendTo(ctx.sender, Object.assign({}, packet, { outbound: true }));',
        to: '/* echo removed */'
    },
    {
        name: 'the echo is not marked outbound',
        file: WHISPER,
        from: "Object.assign({}, packet, { outbound: true })",
        to: 'Object.assign({}, packet, {})'
    },
    {
        name: 'the length cap is removed, so whisper bypasses the chat length limit',
        file: WHISPER,
        from: 'const body = message.length > MAX_LENGTH ? message.slice(0, MAX_LENGTH) : message;',
        to: 'const body = message;'
    },
    {
        name: 'the length cap is raised above the ordinary chat limit',
        file: WHISPER,
        from: 'const MAX_LENGTH = 240;',
        to: 'const MAX_LENGTH = 4000;'
    },
    {
        // An offline target must not be answered with a chat packet: the whitelist
        // below would reject it, but the failure would be silent rather than a clear
        // log line, and the send count would be wrong.
        name: 'an offline target gets a chat packet instead of a private log line',
        file: WHISPER,
        from: 'ctx.notify(ctx.sender, \'Nobody online is called \' + target + \'.\');',
        to: 'ctx.sendTo(ctx.sender, { action: \'chat\', channel: \'whisper\', text: message });'
    },

    // --- the wiring ---------------------------------------------------------
    {
        name: 'the chat branch never dispatches whispers',
        file: SERVER,
        from: 'if (whispered.handled) return;',
        to: 'if (whispered && false) return;'
    },
    {
        name: 'the whisper dispatch moves after the channel whitelist, where /w is dead',
        file: SERVER,
        from: 'if (whispered.handled) return;',
        to: 'if (false) return;'
    },
    {
        name: 'the self-whisper guard is bypassed by skipping the lookup result check',
        file: SERVER,
        from: "lookup: findPlayerByName,",
        to: "lookup: () => null,"
    },
    {
        // If classFor ever keyed on the channel rather than the action, whispers
        // would become unbudgeted: one slow packet per message, to one named
        // recipient. That is a targeted spam tool with no rate limit.
        name: 'whispers stop being charged to the chat budget',
        file: RATELIMIT,
        from: "whisper: 'chat',",
        to: "whisper: 'other',"
    },
    {
        // Someone adding client-side filtering for the new /w command, unaware that
        // the server parses it. This is the failure mode the source-level test exists
        // for, and mutating it is how that test proves it can see it.
        name: 'the client starts stripping /w before sending, breaking whispers silently',
        file: ENGINE,
        from: 'if (text.startsWith("/p ")) { channel = "party"; text = text.substring(3); }',
        to: 'if (text.startsWith("/w ")) { text = text.substring(3); }\n            if (text.startsWith("/p ")) { channel = "party"; text = text.substring(3); }'
    }
];

function runSuite() {
    try {
        const out = execFileSync(process.execPath, ['--test', TEST], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    }
}

function failingTest(out) {
    const m = out.match(/✖ ([^\n]+)/);
    return m ? m[1].trim().slice(0, 72) : '(no failure line found)';
}

const originals = new Map();
for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs, 'utf8'));
}

console.log('=== whisper mutation testing ===\n');
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

console.log(`  ${MUTATIONS.length - survived}/${MUTATIONS.length} caught, ${survived} survived`);
if (survived) {
    console.log('\n  A surviving mutation is an assertion that does not assert.');
    process.exitCode = 1;
} else {
    console.log('  Every mutation was caught.');
}
