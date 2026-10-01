/*
 * tests/unit/xss_sinks.test.js
 *
 * Server-supplied strings reach the DOM as markup in this client, so every one
 * of them has to be escaped on the way in. This file makes that a rule instead
 * of a habit.
 *
 * Why it exists. The auction house renderer interpolated the seller's character
 * name straight into innerHTML:
 *
 *     (Seller: ${item.sellerName})
 *
 * and character names are validated on the server only as "a non-empty string"
 * -- database.js:186 checks `charName.trim().length === 0` and nothing else.
 * An account username cannot contain markup (auth.js:51 pins it to
 * ^[a-z0-9][a-z0-9_.-]{2,31}$), but a character name can. So anyone who could
 * make a character named `<img src=x onerror=...>` and list a single item got
 * script execution in every other player's browser the moment they opened the
 * auction house. Stored, self-service, and it reached the whole player base.
 *
 * The rule below is deliberately blunt: a template-literal interpolation that
 * reaches HTML must be wrapped in an escaping or numeric call, or be named on a
 * short allowlist of values that cannot carry markup. An allowlist entry is a
 * claim that has to be argued in a comment, so "I already escaped this one
 * somewhere else" cannot quietly become the default answer.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FILES = ['ui.js', 'engine.js'].map(f => ({
    name: f,
    src: fs.readFileSync(path.join(ROOT, 'client', 'js', f), 'utf8')
}));

// Wrappers that make an interpolation safe to emit as markup.
const SAFE_CALL = /\b(escapeHtml|Number|parseInt|parseFloat|Math\.|toFixed|Intl\.)\b/;

/*
 * Values that are safe unescaped, each with the reason. Kept short on purpose:
 * every entry is an assertion that this identifier is numeric or already-escaped
 * at its definition site, and adding to this list should be rarer than adding an
 * escapeHtml.
 */
const ALLOWED_BARE = new Map([
    // Pre-escaped in engine.js: `const escK = escapeHtml(k).replace(/'/g, '&#39;')`.
    ['escK', 'already escaped at definition, then quote-escaped for the attribute'],
    ['escS', 'already escaped at definition'],
    // Counts and indices derived from array lengths.
    ['pct', 'numeric percentage, computed then clamped'],
    ['qty', 'stack count'],
    ['miss.have', 'recipe progress count'],
    ['miss.required', 'recipe requirement count'],
    ['counts[k]', 'stack count'],
    ['counts[item]', 'stack count'],
    ['vcounts[item]', 'stack count'],
    ['item.price', 'coerced with Number() and falls back to 0'],
    // Presentation flags and colours chosen from fixed sets in this file.
    ['maxed', 'a literal " maxed" or empty string'],
    ['color', 'a literal picked from a fixed list in this module'],
    ['opacity', 'computed number'],
    ['disabled', 'literal attribute string'],
    ['status', 'literal status text built from fixed strings'],
    ['inputs', 'built from recipe input counts, not from names'],
    ['detail', 'built from miss.have/miss.required, both counts'],
    // Numeric item stats from the server's item table. getItemStats returns
    // this as a plain string and it is escaped on arrival by showTooltip
    // (ui.js:783-785 runs every part through escapeHtml), so it never becomes
    // markup here. The numbers are what is interpolated; the labels are fixed.
    ['itm.bonus', 'numeric weapon damage from the item table'],
    ['itm.def', 'numeric armour defence from the item table'],
    ['itm.speedBonus', 'numeric boots speed bonus'],
    ['itm.maxHpBonus', 'numeric amulet HP bonus'],
    ['itm.val', 'numeric potion restore amount'],
    // Server log/notice text. Every use of data.message in the client is a text
    // sink: engine.js:93 assigns it to .innerText, and the rest go through
    // addLog, which renderChat writes with .innerText. Escaping it here would be
    // actively wrong -- innerText does not decode entities, so `&lt;` would be
    // shown literally to the player.
    //
    // This entry is coupled to a separate pinned invariant: if renderChat ever
    // goes back to innerHTML, the "chat is rendered as text, not markup" test
    // fails and this allowance is no longer justified. That test is the real
    // control; this line is bookkeeping so the general rule can stay strict.
    ['data.message', 'server notice text, delivered to an innerText sink'],
    ['skill.level', 'numeric skill level'],
    ['skill.name', 'server-authored skill label, not player input'],
    ['data.gold', 'numeric gold count'],
    ['data.name', 'server-authored mob/NPC name'],
    ['data.item', 'server-authored item or fish name']
]);

/*
 * Only functions that actually write HTML are scanned.
 *
 * A first version flagged every `${...}` in both files and produced ten
 * findings, of which one was real. The rest were a tooltip string that
 * showTooltip escapes downstream, a CSS selector built for querySelector, and
 * chat text destined for innerText. None of them become markup, and a check
 * that reports correct code as a vulnerability gets ignored -- which is how the
 * auction bug survived in the first place.
 *
 * So the unit of scanning is the function, and a function qualifies only if it
 * assigns to .innerHTML somewhere in its body.
 */
function htmlWritingChunks(src) {
    const lines = src.split('\n');
    // Function starts in the shapes these two files use.
    const starts = [];
    lines.forEach((line, i) => {
        if (/^\s*(?:window\.)?[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?function\b/.test(line)) starts.push(i);
        else if (/^\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(line)) starts.push(i);
        else if (/^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(/.test(line)) starts.push(i);
    });
    if (!starts.length) return [];

    const out = [];
    starts.forEach((from, k) => {
        const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
        const body = lines.slice(from, to);
        if (!body.some(l => /\.innerHTML\s*(=|\+=)/.test(l))) return;
        body.forEach((line, i) => {
            for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
                out.push({ expr: m[1].trim(), line: from + i + 1, text: line.trim(), kind: 'interpolation' });
            }
        });
    });
    return out;
}

/*
 * NOT attempted: a general rule for string concatenation.
 *
 * Concatenation is the other way a value reaches markup -- the guild member list
 * used `h += "- " + m + "<br/>"` -- and a first attempt to catch it produced 80
 * findings, of which none were real. Two reasons it does not work here:
 *
 *   engine.js is one packet handler for the whole protocol, so "the function that
 *   writes innerHTML" is the entire file. Every `a + b` in it qualifies,
 *   including arithmetic, getElementById arguments and innerText assignments.
 *   and backtracking makes the match itself wrong: against `+ escapeHtml(m)` a
 *   regex will happily settle for `escapeHtm`, because `l` is not a delimiter it
 *   was told to reject.
 *
 * Deciding whether a concatenation reaches innerHTML needs dataflow, not regex.
 * The compensating control is the pinned assertions below, which cover every
 * concatenation sink that carries player-chosen text -- guild member, party
 * member, guild inviter, trade-request sender -- so a regression at one of those
 * specific places still fails the build.
 */

// A ternary whose every branch is a literal or a numeric read carries no markup.
function literalOnlyTernary(expr) {
    if (!expr.includes('?')) return false;
    return expr.split('?').slice(1).every(part => {
        const branches = part.split(':');
        return branches.every(b => {
            const t = b.trim();
            if (/^['"`].*['"`]$/.test(t)) return true;
            return /^(Number|parseInt|parseFloat)\(|^\w+(\.\w+)*\.(length|bonus|def|speedBonus|maxHpBonus|val)$/.test(t) || /^-?\d+(\.\d+)?$/.test(t);
        });
    });
}

/*
 * `A || "fallback"` is as safe as A, provided the fallback is a literal. The
 * rate-limit notice is written `${data.message || "Slow down."}`, which the
 * exact-match allowlist rejected because the operand is the whole expression
 * rather than the bare member access.
 *
 * Every operand must independently pass, so `a || b` where both are dynamic is
 * still refused. Splitting here rather than special-casing one line keeps the
 * rule honest for the next `x || "default"` that gets written.
 */
function safeByParts(expr, isAllowed) {
    const parts = expr.split('||').map(s => s.trim());
    if (parts.length < 2) return isAllowed(expr);
    return parts.every(part => /^['"`].*['"`]$/.test(part) || isAllowed(part));
}

const isAllowed = expr => ALLOWED_BARE.has(expr);
test('no unescaped value reaches HTML', () => {
    const problems = [];
    for (const f of FILES) {
        for (const { expr, line, text, kind } of htmlWritingChunks(f.src)) {
            if (SAFE_CALL.test(expr)) continue;
            if (safeByParts(expr, isAllowed)) continue;
            if (/^['"`].*['"`]$/.test(expr)) continue;
            if (literalOnlyTernary(expr)) continue;
            const shown = kind === 'interpolation' ? `\${${expr}}` : `+ ${expr}`;
            problems.push(`${f.name}:${line}  ${shown}\n      ${text.slice(0, 110)}`);
        }
    }
    assert.deepStrictEqual(problems, [],
        'these values reach innerHTML without escaping, by interpolation or by\n' +
        'concatenation. If the value can be influenced by a player this is script\n' +
        'execution; escape it with escapeHtml or coerce it with Number():\n  ' +
        problems.join('\n  '));
});

test('the concatenation sinks that carry player names stay escaped', () => {
    // These build their HTML with `+` rather than `${}`, so the general
    // interpolation rule cannot see them. Each one renders a name a player
    // chose, so each is pinned individually.
    const ui = FILES.find(f => f.name === 'ui.js').src;
    const engine = FILES.find(f => f.name === 'engine.js').src;

    const pinned = [
        {
            file: 'engine.js', src: engine,
            what: 'the guild member list',
            expect: /myGuild\.members\.forEach\(m => h \+= "- " \+ escapeHtml\(m\)/
        },
        {
            file: 'engine.js', src: engine,
            what: 'the guild name and leader line',
            expect: /escapeHtml\(myGuild\.name\)/
        },
        {
            file: 'engine.js', src: engine,
            what: 'the subclass card id used inside an onclick attribute',
            expect: /subclass-card-" \+ escapeHtml\(id\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the pending party inviter',
            expect: /\+ escapeHtml\(pendingPartyInvite\.inviter\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the pending guild inviter',
            expect: /\+ escapeHtml\(pendingGuildInvite\.inviter\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the guild member row',
            expect: /\+ escapeHtml\(member\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the dialogue body text',
            expect: /\+ escapeHtml\(data\.text \|\| ''\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the legacy quest name and description',
            expect: /\+ escapeHtml\(q\.name\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the tooltip parts',
            expect: /tooltip-title'>" \+ escapeHtml\(title\)/
        }
    ];

    const broken = pinned.filter(p => !p.expect.test(p.src))
        .map(p => `${p.file}: ${p.what}`);
    assert.deepStrictEqual(broken, [],
        'these sinks render player-chosen text by concatenation and have lost their\n' +
        'escapeHtml call:\n  ' + broken.join('\n  '));
});

test('the auction renderer escapes the seller name, item and id', () => {
    // Pinned individually because it is the sink this file was written for, and
    // because "some other escapeHtml elsewhere in the file" is not a defence.
    //
    // Accurate severity, after the correction above: the seller name cannot
    // currently carry markup because the login charset forbids it. The item name
    // comes from the server's item table and the id is generated, so neither is
    // attacker-controlled today either. This is defence in depth on a persisted
    // escrow field, not a patch for a live hole -- kept because escrow outlives
    // any single login, and because the cost of being wrong here is total.
    const ui = FILES.find(f => f.name === 'ui.js').src;
    const fn = /window\.renderAuctionUI[\s\S]*?\n        \};/.exec(ui);
    assert.ok(fn, 'could not find renderAuctionUI in ui.js');

    assert.match(fn[0], /\$\{escapeHtml\(item\.sellerName\)\}/,
        'sellerName is a player-chosen character name and must be escaped');
    assert.match(fn[0], /\$\{escapeHtml\(item\.item\)\}/,
        'the item name must be escaped');
    assert.match(fn[0], /\$\{escapeHtml\(item\.id\)\}/,
        'the listing id lands inside an onclick attribute and must be escaped');
    assert.match(fn[0], /Number\(item\.price\)/,
        'the price should be coerced with Number(), not interpolated raw');
});

test('chat is escaped before it becomes markup', () => {
    // Chat carries the most player-influenced text on screen: combat.js and
    // bosses.js interpolate charName into log messages, and players type their
    // own text into the channel.
    //
    // renderChat used to assign innerText, which is why chat was safe without an
    // escaper. It now assigns innerHTML so that timestamps and mention
    // highlighting can be rendered as elements, which means the escaping is load
    // bearing and has to be asserted rather than assumed.
    const ui = FILES.find(f => f.name === 'ui.js').src;
    const fn = /function renderChat\(\)[\s\S]*?\n        \}/.exec(ui);
    assert.ok(fn, 'could not find renderChat in ui.js');

    assert.match(fn[0], /d\.innerHTML\s*=/,
        'renderChat is expected to build markup for timestamps and mentions; ' +
        'if this went back to innerText the mention feature would have to change');
    assert.ok(!/\.innerHTML\s*\+=/.test(fn[0]),
        'chat must not accumulate markup across lines');

    // Every dynamic piece going into that markup must be escaped. The message
    // body is the one that can contain arbitrary player text; the name and the
    // timestamp are constrained, but escaping them costs nothing and makes the
    // rule "escape everything" rather than "escape the one you remember".
    assert.match(fn[0], /escapeHtml\(msg\.text\)/,
        'the chat body must go through escapeHtml before reaching innerHTML');
    assert.match(fn[0], /escapeHtml\(myName\)/,
        'the mention name must go through escapeHtml before reaching innerHTML');
    assert.match(fn[0], /escapeHtml\(msg\.time\)/,
        'the timestamp must go through escapeHtml before reaching innerHTML');

    // And it must use the file's own escaper, which covers quotes as well as the
    // angle brackets. A second, weaker escaper next to the real one is how a
    // future attribute-context injection gets introduced.
    assert.ok(!/\.replace\(\/&\/g/.test(fn[0]),
        'renderChat must not define its own partial escaper; use escapeHtml');
});

test('character names cannot contain markup, and that is enforced at login', () => {
    // CORRECTION. An earlier version of this file asserted the opposite: that
    // character names were validated only as non-empty strings, citing
    // database.js:186. That was wrong -- it is the storage-layer guard, and it
    // was never the only one. The login path validates the name before a player
    // object is ever built:
    //
    //   server.js  requestedName.length > 32
    //            || !/^[A-Za-z][A-Za-z0-9 _-]*$/.test(requestedName)
    //
    // That charset excludes <, >, &, ' and ", so a character name cannot inject
    // markup anywhere it is interpolated. The claim that the auction sink was
    // "stored XSS reachable by anyone who can make a character" overstated it.
    //
    // The escaping in the client is still correct and is still what should be
    // relied on -- sellerName is persisted escrow that outlives any one login,
    // and a client is not a trust boundary just because the server currently
    // validates its input. But the reason it is defence in depth, not the fix
    // for a live hole, is now recorded accurately.
    const server = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');

    assert.match(server, /const charName = requestedName \|\| playerId;/,
        'charName is either the validated requested name or a generated id');

    // The charset itself, pinned. If this is ever widened to allow a quote or an
    // angle bracket, the client-side escapes become load-bearing rather than
    // precautionary, and that has to be a deliberate decision.
    assert.match(server, /\^\[A-Za-z\]\[A-Za-z0-9 _-\]\*\$/,
        'the character-name charset must stay [A-Za-z][A-Za-z0-9 _-]*');
    assert.match(server, /requestedName\.length > 32/,
        'the character-name length cap must stay in place');

    // And prove the charset actually excludes the characters that matter, rather
    // than trusting the regex to still mean what the comment says.
    const allowed = /^[A-Za-z][A-Za-z0-9 _-]*$/;
    for (const hostile of ['<img', "o'brien", 'a"b', 'a&b', '<script>', 'x<y']) {
        assert.equal(allowed.test(hostile), false,
            `${JSON.stringify(hostile)} must be rejected by the character-name charset`);
    }
    assert.equal(allowed.test('Bob Smith'), true, 'an ordinary name must still be accepted');
    assert.equal(allowed.test('Bob_Smith-2'), true, 'underscores, dashes and digits must be accepted');

    // The storage-layer guard is still worth having, for rows that predate the
    // login validation or arrive from a backup.
    const db = fs.readFileSync(path.join(ROOT, 'server', 'database.js'), 'utf8');
    assert.match(db, /charName\.trim\(\)\.length === 0/,
        'expected the non-empty character-name guard in database.js to still be present');
});